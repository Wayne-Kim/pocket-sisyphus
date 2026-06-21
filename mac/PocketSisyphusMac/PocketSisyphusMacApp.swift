import SwiftUI
import Sparkle

@main
struct PocketSisyphusMacApp: App {
    @StateObject private var daemon = DaemonManager()
    @StateObject private var qrWindow = QRWindowController()
    @StateObject private var guideWindow = GuideWindowController()
    // 세션·워크플로우 창은 제거됨 — Mac 은 «호스트 점검/페어/전원» 에 집중하고, 세션/워크플로우는
    // 폰에서 더 잘 된다(제품 thesis: 맥 CLI 를 폰에서 제어). iOS 가 100% 동등하게 처리한다.
    // Discord 알림 / 포트 / 전체 디스크 접근 / 언어 설정을 한 창의 탭으로 통합.
    @StateObject private var settingsWindow = SettingsWindowController()
    /// 잠자기 방지(IOPMAssertion) + 클램쉘 모드(pmset disablesleep) — 폰에서 시작한 세션이
    /// Mac 잠자기/덮개 닫힘으로 끊기지 않게. 메뉴바 토글 + 설정 「전원」 탭이 같은 인스턴스를 공유.
    @StateObject private var power = PowerManager()
    /// primary IPv4 변경을 감지해 daemon 에 SIGHUP 트리거. dynamic IP / 휴면 깨어남
    /// 시나리오에서 Tor 회복 시간을 1~5분 → 5~10s 로 압축.
    @StateObject private var networkMonitor: NetworkChangeMonitor = {
        // onChange 는 daemon HTTP endpoint 를 호출. daemon 미부팅 / Tor 부팅 중이면
        // 서버측이 cleanly 무시한다 (not-bootstrapped / no-process / cooldown).
        NetworkChangeMonitor {
            Task { @MainActor in
                let client = LocalDaemonClient()
                do {
                    try await client.kickReconnect()
                } catch {
                    // 실패 무시 — daemon 안 떠 있으면 자연스러운 케이스. 다음 path
                    // 이벤트가 또 시도하므로 누락된 IP 변경이 영구히 묻힐 일은 없다.
                    NSLog("[App] kickReconnect 실패 (daemon 미부팅 가능): %@",
                          error.localizedDescription)
                }
            }
        }
    }()

    /// Sparkle 의 표준 SwiftUI 통합. 1h 마다 (SUScheduledCheckInterval) SUFeedURL 의
    /// appcast.xml 을 폴링해 새 버전이 있으면 사용자에게 알림 → 클릭 시 EdDSA 서명
    /// 검증된 DMG 다운로드 → .app 자동 교체 → 재실행까지 처리. 메뉴의 «업데이트 확인…»
    /// 은 수동 트리거 — 새 배포가 떨어진 직후 즉시 받고 싶을 때.
    ///
    /// startingUpdater=true 로 앱 시작 시 즉시 updater 활성 — 첫 실행 시 시스템
    /// 권한 같은 거 안 필요. 자동 체크 정책은 Info.plist 의 SUEnableAutomaticChecks
    /// (지금 true).
    ///
    /// daemon → Mac 앱 IPC 시그널 (SIGUSR1) 이 같은 인스턴스를 사용해야 하므로
    /// `UpdaterBridge.shared` 가 보유. iOS 가 admin endpoint 를 두드려 업데이트를
    /// 트리거할 때, 같은 updater 가 메뉴 버튼과 일관된 경로로 동작 (메뉴=인터랙티브,
    /// iOS=사일런트는 user driver 의 mode 토글로 구분).
    private let updater = UpdaterBridge.shared.updater

    /// 사일런트(iOS 원격) 업데이트 진행 상태 — 메뉴바 아이콘과 메뉴 배너가 «업데이트 중»
    /// 을 표시할 수 있게 관찰한다. 싱글톤(UpdaterBridge)이 소유하므로 @StateObject 가
    /// 아니라 @ObservedObject (라이프사이클을 여기서 만들지 않는다).
    @ObservedObject private var updateProgress = UpdaterBridge.shared.progress

    init() {
        // unified.log 회전 — daemon spawn 보다 먼저 (두 writer 가 동시 가동되기 전 단일
        // 동기화 지점). 10 MiB 초과 시 .1 로 한 단계 회전, 백업 1개만 유지.
        UnifiedLog.rotateIfNeeded()
        UnifiedLog.info(.macapp, "Mac app launch", [
            "event.action": "macapp.launch",
        ])

        // daemon 이 SIGUSR1 을 우리에게 보내면 «사일런트» 업데이트 확인을 트리거한다.
        // SIGUSR1 가 도착하기 *전* 에 한 번 설치되면 충분 — App init 은 daemon spawn
        // 보다 먼저 끝난다. (자동 다운로드/체크 정책은 UpdaterBridge.init 에서 설정.)
        UpdaterBridge.shared.installSignalHandler()
    }

    var body: some Scene {
        MenuBarExtra {
            MenuContent(updater: updater)
                .environmentObject(daemon)
                .environmentObject(qrWindow)
                .environmentObject(guideWindow)
                .environmentObject(settingsWindow)
                .environmentObject(power)
                .environmentObject(updateProgress)
                .frame(minWidth: 280)
        } label: {
            // 메뉴바 아이콘(항상 살아있는 뷰)에서 «권한 요청» 신호를 받는다. iOS 가 캡처/제어를
            // 요구했는데 해당 TCC 가 없으면 설정창을 권한 탭으로 열고 누락 권한을 강조.
            StatusIcon(state: daemon.state, updating: updateProgress.isActive)
                .onReceive(NotificationCenter.default.publisher(for: .psPermissionRequest)) { note in
                    guard let kind = note.userInfo?["kind"] as? String else { return }
                    settingsWindow.showForPermissionRequest(kind: kind, daemon: daemon, power: power)
                }
        }
        .menuBarExtraStyle(.window)   // popover-style window 가능
    }
}

/// 메뉴바 아이콘 — daemon 상태에 따라 색 변경. 사일런트 업데이트 중에는 daemon 상태보다
/// 우선해 파란 다운로드 아이콘으로 바뀐다 (iOS 에서 트리거한 업데이트가 진행 중임을
/// Mac 앞 사용자도 알 수 있게 — 창을 안 띄우는 사일런트 설계의 유일한 화면 단서).
struct StatusIcon: View {
    let state: DaemonManager.State
    var updating: Bool = false

    /// 메뉴바 아이콘 한 변(pt). 표준 글리프 크기. 솔리드 스퀘어클이라 더 키우면 바를 꽉 채워
    /// 거대해 보인다(SF Symbol 처럼 얇지 않음).
    private static let dimension: CGFloat = 16

    var body: some View {
        // 방패 SF Symbol 대신 앱 로고(=AppIcon 재활용). daemon 상태(색 신호)는 우하단 점으로 유지
        // (중지=회색·시작=노랑·실행=초록·실패=빨강·업데이트=파랑 — 사일런트 업데이트의 유일한 단서).
        //
        // ⚠️ 왜 SwiftUI Image 가 아니라 NSImage 합성인가: MenuBarExtra 는 `Image(...).resizable()
        // .frame()` 의 frame 을 무시하고 이미지를 메뉴바 높이로 키워버려 «거대한» 아이콘이 나온다.
        // NSImage 의 point size 를 16 으로 박으면 그 크기로 렌더된다(SF Symbol 이 작게 나오는 것과
        // 같은 intrinsic-size 원리). 상태 점까지 한 장에 그려 크기를 100% 통제한다.
        Image(nsImage: Self.barImage(dot: statusDotColor))
    }

    /// daemon 상태 → 우하단 점 색. (옛 SF Symbol 의 foregroundStyle 색 계승.)
    private var statusDotColor: NSColor {
        if updating { return .systemBlue }
        switch state {
        case .stopped: return .secondaryLabelColor
        case .starting: return .systemYellow
        case .running:  return .systemGreen
        case .failed:   return .systemRed
        }
    }

    /// 16pt 메뉴바 아이콘을 직접 합성. 상태가 바뀔 때만 재합성된다(저렴).
    private static func barImage(dot: NSColor) -> NSImage {
        let s = dimension
        let img = NSImage(size: NSSize(width: s, height: s))
        img.lockFocus()
        NSGraphicsContext.current?.imageInterpolation = .high
        NSImage(named: "AppLogo")?.draw(in: NSRect(x: 0, y: 0, width: s, height: s))
        // 상태 점 — NSImage 좌표는 좌하단 원점이라 우하단 = (max, 0). 분리용 얇은 배경 링 + 점.
        let d: CGFloat = 5, ring: CGFloat = 0.75
        let bg = NSRect(x: s - d - ring * 2, y: 0, width: d + ring * 2, height: d + ring * 2)
        NSColor.windowBackgroundColor.setFill()
        NSBezierPath(ovalIn: bg).fill()
        dot.setFill()
        NSBezierPath(ovalIn: bg.insetBy(dx: ring, dy: ring)).fill()
        img.unlockFocus()
        img.isTemplate = false   // 풀컬러 로고 — 템플릿(단색)으로 평탄화하면 안 됨
        return img
    }
}
