import Foundation
import Sparkle

/// 사일런트(iOS 원격 트리거) 업데이트의 진행 단계 — 메뉴바 아이콘과 메뉴 배너가 관찰해
/// «지금 업데이트 중» 을 보여준다. 사일런트는 설계상 Mac 화면에 창을 안 띄우는데, 그러면
/// Mac 앞에 있는 사용자는 진행 여부를 알 길이 없었다 → 이 모델이 그 공백을 메운다.
///
/// 인터랙티브(메뉴 «업데이트 확인…» / 스케줄 체크) 경로는 반영하지 않는다 — Sparkle 표준
/// UI 가 이미 진행 창을 띄우고, 백그라운드 자동 다운로드가 아이콘을 물들이는 오탐도 막는다.
/// 모든 갱신은 main queue(@MainActor driver) 에서 일어난다.
final class UpdateProgress: ObservableObject {
    enum Phase: Equatable {
        case idle
        case checking
        /// 0...1 진행률. nil = 전체 크기 미상 (indeterminate).
        case downloading(Double?)
        case extracting(Double)
        case installing
    }

    @Published var phase: Phase = .idle

    var isActive: Bool { phase != .idle }
}

/// iOS 원격 트리거 시 «무클릭 강제 업데이트» 를 가능하게 하는 Sparkle user driver.
///
/// 왜 필요한가:
/// - `SPUStandardUserDriver` (그리고 그걸 들고 있는 `SPUStandardUpdaterController`) 는
///   항상 표준 UI (다이얼로그) 를 Mac 화면에 띄운다. iOS 에서 원격으로 업데이트를
///   트리거해도 사람이 Mac 앞에서 «설치하고 재시작» 을 클릭해야 진행됐다 → 원격에
///   있는 사용자는 끝까지 밀어붙일 수 없어 «강제 즉시 업데이트» 가 사실상 불가능.
///
/// 어떻게:
/// - `SPUStandardUserDriver` 를 «서브클래싱» 해서 두 모드를 가진다:
///     - `.interactive` : 메뉴 «업데이트 확인…» / 백그라운드 스케줄 체크 →
///                        모든 콜백을 `super` 로 위임 (= 기존 표준 UI 그대로).
///     - `.silent`      : iOS SIGUSR1 트리거 → reply 콜백에 자동 `.install`,
///                        화면에 뜨는 콜백은 no-op. 창 하나 안 띄우고 다운로드
///                        (이미 `automaticallyDownloadsUpdates` 로 캐시) → .app 교체
///                        → relaunch 까지 무인 진행.
/// - 단일 `SPUUpdater` 인스턴스 원칙 (아래 `UpdaterBridge` 주석 참고) 을 지키려고 두 번째
///   updater 를 만들지 않고 driver 의 `mode` 만 토글한다. 서브클래싱이라 인터랙티브
///   경로의 동작/상태머신은 `super` 가 그대로 책임지므로 회귀 위험이 작다.
///
/// 안전: «강제» 는 UI 승인만 건너뛰는 것. Sparkle 의 EdDSA 서명 검증은 `SPUUpdater`
/// 코어가 그대로 수행하므로 서명 안 된/위조 DMG 는 여전히 거부된다.
@MainActor
final class SilentUpdateUserDriver: SPUStandardUserDriver {
    enum Mode { case interactive, silent }

    /// 사일런트 경로의 «종료» 결과. 프로세스가 살아남는 케이스만 의미가 있다 —
    /// 설치 성공은 relaunch 로 프로세스가 교체되므로 여기로 오지 않는다 (재부팅된
    /// daemon 의 버전 ↑ 가 «완료» 신호).
    enum SilentOutcome {
        case noUpdate            // 새 버전 없음 → "이미 최신"
        case error(String)       // 업데이트 중 에러
    }

    /// 현재 모드. iOS 트리거 직전 `.silent`, 종료 콜백 또는 메뉴 경로에서 `.interactive`.
    var mode: Mode = .interactive

    /// 사일런트 경로가 종료 콜백에 도달했을 때 호출. `UpdaterBridge` 가 set 해서 daemon
    /// 에 결과를 보고하고 mode 를 `.interactive` 로 되돌린다.
    var onSilentOutcome: ((SilentOutcome) -> Void)?

    /// 진행 상태 — 메뉴바 아이콘/메뉴 배너가 관찰. 사일런트 경로에서만 갱신된다.
    let progress = UpdateProgress()

    /// 다운로드 진행률 계산용 누적치 (사일런트 전용).
    private var downloadExpected: UInt64 = 0
    private var downloadReceived: UInt64 = 0

    private var silent: Bool { mode == .silent }

    // MARK: - 권한 / 체크 시작

    override func show(
        _ request: SPUUpdatePermissionRequest,
        reply: @escaping (SUUpdatePermissionResponse) -> Void,
    ) {
        guard silent else {
            super.show(request, reply: reply)
            return
        }
        // 다이얼로그 없이 자동 체크 허용. Info.plist SUEnableAutomaticChecks=true 라
        // 실제로 이 콜백은 거의 안 온다 — 방어적으로 즉답.
        reply(SUUpdatePermissionResponse(automaticUpdateChecks: true, sendSystemProfile: false))
    }

    override func showUserInitiatedUpdateCheck(cancellation: @escaping () -> Void) {
        guard silent else {
            super.showUserInitiatedUpdateCheck(cancellation: cancellation)
            return
        }
        // 사일런트는 «확인 중…» 스피너를 띄우지 않는다.
    }

    // MARK: - 업데이트 발견 / 설치 결정 (핵심 — reply 자동 .install)

    override func showUpdateFound(
        with appcastItem: SUAppcastItem,
        state: SPUUserUpdateState,
        reply: @escaping (SPUUserUpdateChoice) -> Void,
    ) {
        guard silent else {
            super.showUpdateFound(with: appcastItem, state: state, reply: reply)
            return
        }
        // 정보성 전용 업데이트 (informationOnlyUpdate) 는 설치 대상이 아님 → dismiss + 최신 취급.
        if appcastItem.isInformationOnlyUpdate {
            reply(.dismiss)
            onSilentOutcome?(.noUpdate)
        } else {
            // 이미 자동 다운로드로 캐시돼 있으면 다운로드 콜백 없이 곧장 ready 로
            // 점프할 수 있다 — indeterminate 로 시작해 두면 어느 경로든 자연스럽다.
            progress.phase = .downloading(nil)
            reply(.install)
        }
    }

    override func showReady(toInstallAndRelaunch reply: @escaping (SPUUserUpdateChoice) -> Void) {
        guard silent else {
            super.showReady(toInstallAndRelaunch: reply)
            return
        }
        // 즉시 설치 + relaunch. 프로세스 교체 → 자식 daemon 도 함께 재시작된다.
        progress.phase = .installing
        reply(.install)
    }

    // MARK: - 다운로드 / 설치 진행 (사일런트는 창 대신 progress 모델에만 반영)

    override func showDownloadInitiated(cancellation: @escaping () -> Void) {
        guard silent else {
            super.showDownloadInitiated(cancellation: cancellation)
            return
        }
        // 진행 창을 만들지 않는다 — 대신 아래 progress 콜백들이 모델을 갱신해
        // 메뉴바 아이콘/메뉴 배너로 노출된다.
        downloadExpected = 0
        downloadReceived = 0
        progress.phase = .downloading(nil)
    }

    override func showDownloadDidReceiveExpectedContentLength(_ expectedContentLength: UInt64) {
        guard silent else {
            super.showDownloadDidReceiveExpectedContentLength(expectedContentLength)
            return
        }
        downloadExpected = expectedContentLength
        downloadReceived = 0
        progress.phase = .downloading(expectedContentLength > 0 ? 0 : nil)
    }

    override func showDownloadDidReceiveData(ofLength length: UInt64) {
        guard silent else {
            super.showDownloadDidReceiveData(ofLength: length)
            return
        }
        downloadReceived += length
        guard downloadExpected > 0 else { return }
        progress.phase = .downloading(min(1, Double(downloadReceived) / Double(downloadExpected)))
    }

    override func showDownloadDidStartExtractingUpdate() {
        guard silent else {
            super.showDownloadDidStartExtractingUpdate()
            return
        }
        progress.phase = .extracting(0)
    }

    override func showExtractionReceivedProgress(_ fraction: Double) {
        guard silent else {
            super.showExtractionReceivedProgress(fraction)
            return
        }
        progress.phase = .extracting(fraction)
    }

    override func showInstallingUpdate(
        withApplicationTerminated applicationTerminated: Bool,
        retryTerminatingApplication: @escaping () -> Void,
    ) {
        guard silent else {
            super.showInstallingUpdate(
                withApplicationTerminated: applicationTerminated,
                retryTerminatingApplication: retryTerminatingApplication,
            )
            return
        }
        progress.phase = .installing
    }

    override func showUpdateInstalledAndRelaunched(
        _ relaunched: Bool,
        acknowledgement: @escaping () -> Void,
    ) {
        guard silent else {
            super.showUpdateInstalledAndRelaunched(relaunched, acknowledgement: acknowledgement)
            return
        }
        acknowledgement()
    }

    // MARK: - 종료 콜백 (최신 / 에러)

    override func showUpdateNotFoundWithError(_ error: Error, acknowledgement: @escaping () -> Void) {
        guard silent else {
            super.showUpdateNotFoundWithError(error, acknowledgement: acknowledgement)
            return
        }
        onSilentOutcome?(.noUpdate)
        acknowledgement()
    }

    override func showUpdaterError(_ error: Error, acknowledgement: @escaping () -> Void) {
        guard silent else {
            super.showUpdaterError(error, acknowledgement: acknowledgement)
            return
        }
        onSilentOutcome?(.error(error.localizedDescription))
        acknowledgement()
    }
}

/// Sparkle 의 updater 를 보유한 process-wide 싱글톤.
///
/// 왜 싱글톤인가:
/// - `PocketSisyphusMacApp` 의 SwiftUI App body 가 들고 있는 updater 는 일반적인
///   경로 (메뉴 «업데이트 확인…») 에서는 충분하다.
/// - 하지만 iOS → daemon → Mac 앱 IPC (SIGUSR1) 경로에서는 SwiftUI 인스턴스 라이프
///   사이클 바깥에서 같은 updater 를 호출해야 한다 (시그널 핸들러는 C 레벨에서
///   dispatch 되어 SwiftUI 와 별도).
/// - 둘이 다른 SPUUpdater 인스턴스를 들면 자동 체크 / 캐시 / KVO 가 분기된다.
///   하나만 둔다 — 메뉴(인터랙티브)와 iOS(사일런트)는 같은 updater 의 user driver
///   `mode` 토글로 구분한다.
///
/// 시그널 흐름 (iOS 강제 업데이트):
/// 1. iOS 앱이 `/api/admin/trigger-update` POST
/// 2. daemon (admin route) 이 부모 PID (= Mac 앱) 에 `SIGUSR1` 송신
/// 3. Mac 앱의 `DispatchSourceSignal` 가 main queue 에서 깨어나 driver 를 `.silent` 로
///    바꾼 뒤 `checkForUpdates()` 호출
/// 4. Sparkle 가 EdDSA 검증된 DMG 다운로드 (이미 `automaticallyDownloadsUpdates=true`
///    덕에 미리 받혀있을 수도) → .app 교체 → relaunch. Mac 화면엔 아무 창도 안 뜸.
///
/// 권한 다이얼로그 없음. Gatekeeper / TCC 는 같은 Team ID + 동일 entitlements 로 추가
/// 동의 없이 통과. 단 `/Applications/` 설치 + non-admin 사용자에 한해 macOS 가 설치 중
/// 비밀번호를 1회 요구할 수 있다 (Apple 정책상 불가피 — 그 환경에선 사일런트가 그
/// 지점에서 멈춘다).
@MainActor
final class UpdaterBridge {
    static let shared = UpdaterBridge()

    /// 단일 updater. 메뉴(인터랙티브)와 iOS(사일런트)가 공유. user driver 의 `mode`
    /// 로 두 동작을 가른다.
    let updater: SPUUpdater

    /// mode 토글 + 사일런트 종료 결과 콜백을 가진 user driver.
    private let userDriver: SilentUpdateUserDriver

    /// 사일런트 업데이트 진행 상태 — 메뉴바 아이콘(StatusIcon)과 메뉴 배너(MenuContent)
    /// 가 관찰한다. driver 가 소유한 모델을 그대로 노출.
    var progress: UpdateProgress { userDriver.progress }

    /// `DispatchSourceSignal` 를 보유. resume() 호출 후 release 되면 시그널이
    /// process 의 기본 액션 (SIGUSR1 default = terminate) 으로 떨어지므로 이
    /// 참조는 영구히 살아있어야 한다.
    private var signalSource: DispatchSourceSignal?

    private init() {
        let driver = SilentUpdateUserDriver(hostBundle: .main, delegate: nil)
        self.userDriver = driver
        // `SPUStandardUpdaterController` 대신 수동 `SPUUpdater` — 커스텀 user driver 를
        // 주입하기 위함. 단일 인스턴스라 메뉴 KVO (canCheckForUpdates) / 캐시는 안 깨진다.
        self.updater = SPUUpdater(
            hostBundle: .main,
            applicationBundle: .main,
            userDriver: driver,
            delegate: nil,
        )

        // 사일런트 경로가 «최신/에러» 로 끝나면 (= 프로세스 생존) mode 를 원복하고 daemon
        // 에 결과를 보고. 설치 성공은 relaunch 로 프로세스가 교체되므로 여기 안 옴 —
        // 진행 상태도 프로세스와 함께 사라지므로 생존 케이스만 idle 로 되돌리면 된다.
        driver.onSilentOutcome = { [weak self] outcome in
            self?.userDriver.mode = .interactive
            self?.userDriver.progress.phase = .idle
            self?.reportOutcome(outcome)
        }

        do {
            try updater.start()
        } catch {
            UnifiedLog.error(.sparkle, "updater start failed", [
                "event.action": "sparkle.start.fail",
                "error.message": error.localizedDescription,
            ])
            NSLog("[UpdaterBridge] startUpdater 실패: %@", error.localizedDescription)
        }

        // 백그라운드 자동 다운로드 — 사용자가 메뉴 (또는 iOS) 에서 업데이트를 트리거할
        // 시점에 이미 DMG 가 캐시되어 있어 사일런트 설치가 거의 즉시 진행된다.
        updater.automaticallyDownloadsUpdates = true
    }

    /// daemon 으로부터 SIGUSR1 을 받으면 «사일런트» 업데이트 체크를 트리거.
    /// App init 에서 한 번 호출. 멱등 — 두 번 호출돼도 추가 source 만들지 않는다.
    func installSignalHandler() {
        guard signalSource == nil else { return }

        // 1) C 레벨 SIGUSR1 기본 액션 (= terminate) 무력화. DispatchSourceSignal 는
        //    signal 이 SIG_IGN 또는 SIG_DFL 인 상태에서만 안전하게 가로채진다.
        signal(SIGUSR1, SIG_IGN)

        // 2) DispatchSource — main queue 로 dispatch 되도록 설정해서 핸들러 안에서
        //    바로 SwiftUI / Sparkle UI 를 만질 수 있게 한다.
        let src = DispatchSource.makeSignalSource(signal: SIGUSR1, queue: .main)
        src.setEventHandler { [weak self] in
            UnifiedLog.info(.sparkle, "SIGUSR1 received — trigger silent update", [
                "event.action": "sparkle.trigger.signal",
            ])
            NSLog("[UpdaterBridge] SIGUSR1 수신 → 사일런트 강제 업데이트 트리거")
            // queue: .main 으로 dispatch 되므로 실제로는 MainActor 위에서 실행되지만
            // Swift concurrency 가 static 으로 그걸 모르므로 명시적으로 isolation 단언.
            MainActor.assumeIsolated {
                self?.triggerSilentUpdateCheck()
            }
        }
        src.resume()
        self.signalSource = src
    }

    /// iOS 가 daemon 을 통해 업데이트를 요청했을 때 호출되는 사일런트 진입점.
    /// driver 를 `.silent` 로 바꾸고 체크 시작 — 화면에 창 하나 안 띄우고 설치+재시작.
    ///
    /// 호출 빈도: 사용자가 iOS 메뉴를 누를 때만. 메뉴 «업데이트 확인…» 및 백그라운드
    /// 스케줄 체크는 `.interactive` 기본값이라 표준 UI 그대로.
    private func triggerSilentUpdateCheck() {
        guard updater.canCheckForUpdates else {
            UnifiedLog.warn(.sparkle, "updater busy — skip silent", [
                "event.action": "sparkle.check.busy",
            ])
            NSLog("[UpdaterBridge] updater 가 busy — 사일런트 체크 무시")
            return
        }
        UnifiedLog.info(.sparkle, "silent update check started", [
            "event.action": "sparkle.check.silent",
        ])
        userDriver.mode = .silent
        userDriver.progress.phase = .checking
        updater.checkForUpdates()
    }

    /// 사일런트 종료 결과를 daemon 에 보고 → iOS 가 `/api/version` 의 `lastUpdate` 로
    /// «이미 최신 / 실패» 를 사용자에게 보여줄 수 있다.
    private func reportOutcome(_ outcome: SilentUpdateUserDriver.SilentOutcome) {
        let state: String
        let message: String?
        switch outcome {
        case .noUpdate:
            state = "no_update"
            message = nil
        case .error(let m):
            state = "error"
            message = m
        }
        UnifiedLog.info(.sparkle, "silent update outcome", [
            "event.action": "sparkle.outcome",
            "update.state": state,
        ])
        Task {
            do {
                try await LocalDaemonClient().reportUpdateStatus(state: state, message: message)
            } catch {
                NSLog("[UpdaterBridge] update-status 보고 실패: %@", error.localizedDescription)
            }
        }
    }
}
