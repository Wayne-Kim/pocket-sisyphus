import Foundation
import AppKit
import IOKit            // kIOReturnSuccess
import IOKit.pwr_mgt    // IOPMAssertion* (잠자기 방지)

/// 전원 관리 — 폰에서 시작한 터미널/SSH 세션이 Mac 잠자기로 끊기지 않도록 두 가지를 켠다.
///
/// 1. **잠자기 방지(keepAwake)** — `IOPMAssertion`(PreventUserIdleSystemSleep). 유휴/화면 잠금
///    중에도 **시스템** 잠자기를 막는다(디스플레이는 꺼져도 됨 — 작업은 계속). 권한 불필요,
///    Mac mini 같은 데스크톱 포함 모든 기종에서 동작. 프로세스가 죽으면 OS 가 자동 해제하지만
///    토글 OFF·앱 종료 시 명시적으로 `IOPMAssertionRelease`.
///
/// 2. **클램쉘 모드(clamshell)** — MacBook 덮개를 닫아도 안 잠들게. 외장 디스플레이가 없으면
///    전원 어서션·caffeinate 로는 불가하고 root 권한으로 `pmset -a disablesleep` 를 바꿔야만
///    실제로 동작하므로, 토글 시 osascript 의 `with administrator privileges` 로 관리자 인증
///    1회를 받아 적용한다. **시스템 전체 설정**이라 켜진 동안 Mac 이 전혀 안 잠 → UI 에 «작동
///    중» 경고를 노출한다. 종료 시 자동 복구는 하지 않는다(복구도 root 라 종료 때 암호를 다시
///    묻는 건 더 나쁜 UX). 대신 **앱 시작 시 실제 `pmset -g` 의 `SleepDisabled` 값을 읽어**
///    토글을 현실과 동기화해 UI 가 거짓말하지 않게 한다.
@MainActor
final class PowerManager: ObservableObject {

    // MARK: - 잠자기 방지 (IOPMAssertion)

    /// 잠자기 방지 켜짐 여부. 사용자 토글 → didSet 이 어서션을 만들거나 해제하고 UserDefaults 에
    /// 영속화. 선언 시 기본값 할당은 didSet 을 트리거하지 않으므로 init 에서 한 번 직접 적용한다.
    @Published var keepAwakeEnabled: Bool = UserDefaults.standard.bool(forKey: Keys.keepAwake) {
        didSet {
            guard keepAwakeEnabled != oldValue else { return }
            applyKeepAwake()
            UserDefaults.standard.set(keepAwakeEnabled, forKey: Keys.keepAwake)
        }
    }

    // MARK: - 클램쉘 (pmset disablesleep)

    /// 클램쉘(덮개 닫고 실행) 켜짐 여부 = 시스템 `SleepDisabled` 상태. 관리자 인증이 필요한
    /// 비동기 작업의 결과로만 바뀌므로 `private(set)` — UI 는 setClamshell(_:) 을 호출하는
    /// 바인딩으로 토글하고, 실패/취소 시 이 값이 안 바뀌어 토글이 자동 원복된다.
    @Published private(set) var clamshellEnabled = false
    /// 관리자 인증 + pmset 실행 진행 중 — 토글을 잠시 막는다.
    @Published private(set) var clamshellBusy = false
    /// 마지막 클램쉘 토글 실패 사유(이미 localize 된 문자열). 성공/재시도 시 nil.
    @Published var lastError: String?

    // MARK: - 내부 상태

    private var assertionID: IOPMAssertionID = 0
    private var hasAssertion = false

    private enum Keys {
        static let keepAwake = "power.keepAwake"
    }

    /// `pmset -g assertions` 에만 보이는 내부 식별자 — 사용자 화면 노출 아님(비번역).
    private let assertionName = "Pocket Sisyphus — keep awake" as CFString

    init() {
        // 클램쉘은 시스템 전역 설정이라 우리 앱 재시작과 무관하게 살아있다 → 실제 상태를 읽어 동기화.
        clamshellEnabled = Self.systemSleepDisabled()
        // 재시작 후 잠자기 방지 어서션 복원(영속화된 값이 켜짐이면).
        if keepAwakeEnabled { applyKeepAwake() }

        // 앱 종료 시 어서션 정리. DaemonManager 의 willTerminate 옵저버와 동일 패턴
        // (NotificationCenter closure 는 nonisolated → MainActor.assumeIsolated 로 단언).
        NotificationCenter.default.addObserver(
            forName: NSApplication.willTerminateNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.releaseForTermination() }
        }
    }

    // MARK: - 잠자기 방지 적용

    /// keepAwakeEnabled 값에 맞춰 어서션을 만들거나(있으면 noop) 해제한다(없으면 noop).
    private func applyKeepAwake() {
        if keepAwakeEnabled {
            guard !hasAssertion else { return }
            var id: IOPMAssertionID = 0
            let result = IOPMAssertionCreateWithName(
                kIOPMAssertionTypePreventUserIdleSystemSleep as CFString,
                IOPMAssertionLevel(kIOPMAssertionLevelOn),
                assertionName,
                &id
            )
            if result == kIOReturnSuccess {
                assertionID = id
                hasAssertion = true
                UnifiedLog.info(.macapp, "keep-awake assertion created", [
                    "event.action": "power.keepawake.on",
                ])
            } else {
                UnifiedLog.error(.macapp, "keep-awake assertion failed", [
                    "event.action": "power.keepawake.fail",
                    "power.ioreturn": Int(result),
                ])
            }
        } else {
            releaseForTermination()
            UnifiedLog.info(.macapp, "keep-awake assertion released", [
                "event.action": "power.keepawake.off",
            ])
        }
    }

    /// 보유 중인 잠자기 방지 어서션을 해제. 앱 종료 / 토글 OFF 에서 호출. 멱등.
    func releaseForTermination() {
        guard hasAssertion else { return }
        IOPMAssertionRelease(assertionID)
        hasAssertion = false
        assertionID = 0
    }

    // MARK: - 클램쉘 토글

    /// 클램쉘(=시스템 disablesleep) 을 켜거나 끈다. 관리자 인증 1회를 받아 `pmset -a disablesleep`
    /// 를 바꾼다. 성공 시 clamshellEnabled 갱신, 실패/취소 시 lastError 설정 + 실제 상태로 재동기화.
    func setClamshell(_ on: Bool) async {
        guard !clamshellBusy, on != clamshellEnabled else { return }
        clamshellBusy = true
        lastError = nil
        defer { clamshellBusy = false }
        do {
            try await Self.runPmsetAdmin(disableSleep: on)
            clamshellEnabled = on
            UnifiedLog.info(.macapp, "clamshell toggled", [
                "event.action": on ? "power.clamshell.on" : "power.clamshell.off",
            ])
        } catch {
            lastError = String(localized: "전원 설정을 바꾸지 못했어요 — 관리자 인증이 취소됐을 수 있어요")
            // 부분 적용/취소 가능성 → 실제 시스템 상태로 토글을 되돌린다.
            clamshellEnabled = Self.systemSleepDisabled()
            UnifiedLog.warn(.macapp, "clamshell toggle failed", [
                "event.action": "power.clamshell.fail",
            ])
        }
    }

    // MARK: - pmset 헬퍼

    /// 현재 시스템이 잠자기 비활성(`SleepDisabled` ≠ 0) 인지 — root 불필요한 `pmset -g` 읽기.
    /// 출력의 "SleepDisabled" 토큰 뒤 정수를 파싱. 없으면 false.
    private static func systemSleepDisabled() -> Bool {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/pmset")
        task.arguments = ["-g"]
        let pipe = Pipe()
        task.standardOutput = pipe
        task.standardError = Pipe()
        do {
            try task.run()
        } catch {
            return false
        }
        task.waitUntilExit()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        guard let out = String(data: data, encoding: .utf8) else { return false }
        // 출력 줄: ` SleepDisabled        1`. 일부 줄(예: `sleep … (prevented by …)`)은 뒤에
        // 주석이 붙어 마지막 토큰이 정수가 아니므로, "SleepDisabled" 뒤 첫 정수 토큰을 읽는다.
        for line in out.split(whereSeparator: { $0.isNewline }) where line.contains("SleepDisabled") {
            let tokens = line.split(separator: " ", omittingEmptySubsequences: true)
            guard let idx = tokens.firstIndex(where: { $0 == "SleepDisabled" }) else { continue }
            for token in tokens[tokens.index(after: idx)...] {
                if let value = Int(token) { return value != 0 }
            }
        }
        return false
    }

    /// `pmset -a disablesleep <0|1>` 를 osascript 의 관리자 권한으로 실행. 인증 대화상자가 떠
    /// blocking 이므로 detached 백그라운드에서 돌려 메인 액터(UI)를 막지 않는다. 사용자가 취소하면
    /// osascript 가 비0 종료(-128 «User canceled») → throw.
    private static func runPmsetAdmin(disableSleep on: Bool) async throws {
        let value = on ? "1" : "0"
        // Process 가 osascript 를 직접 exec 하므로(쉘 미경유) 쉘 이스케이프 불필요. AppleScript
        // 소스 안의 쉘 명령을 감싸는 큰따옴표만 escape 한다.
        let script = "do shell script \"/usr/bin/pmset -a disablesleep \(value)\" with administrator privileges"
        try await Task.detached(priority: .userInitiated) {
            let task = Process()
            task.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
            task.arguments = ["-e", script]
            let errPipe = Pipe()
            task.standardError = errPipe
            task.standardOutput = Pipe()
            try task.run()
            task.waitUntilExit()
            if task.terminationStatus != 0 {
                let msg = String(
                    data: errPipe.fileHandleForReading.readDataToEndOfFile(),
                    encoding: .utf8
                ) ?? ""
                throw PowerError.pmsetFailed(status: Int(task.terminationStatus), message: msg)
            }
        }.value
    }

    enum PowerError: Error {
        case pmsetFailed(status: Int, message: String)
    }
}
