import UIKit
import UserNotifications

/// 가로 모드는 «항상» 허용한다.
///
/// 2026-06 사용자 결정: 앱 내 «가로 모드» 토글을 제거했다. 회전 잠금은 iOS 제어센터의
/// «화면 방향 잠금» 으로 충분히 제어되므로, 앱이 자체 화이트리스트로 가로를 막을 이유가 없다.
/// `AppDelegate.supportedInterfaceOrientationsFor` 가 이 값을 읽어 회전 마스크를 정한다.
enum OrientationLock {
    /// 항상 true — 가로/세로 자유 회전(거꾸로 portrait 만 제외). iPhone-only.
    static let allowLandscape = true
}

/// «컨트롤 숨김 버튼(FAB)» 노출을 «방향별로» 켜고 끄는 설정의 단일 진실.
///
/// 채팅방(ChatView)·미러링(RemoteScreenView)이 본문(터미널·미러)을 넓게 보려고 헤더+컨트롤을
/// 토글로 숨기는 눈 모양 FAB 를 띄운다. 이전엔 단일 토글이라 가로·세로 구분 없이 한꺼번에
/// 켜고 꺼야 했는데, 「세로에선 버튼이 거슬리고 가로에서만 쓰고 싶다」 같은 요구를 못 받았다.
/// 그래서 방향별 두 키로 쪼갰다 — 가로에서 보일지, 세로에서 보일지 따로 정한다.
///
/// (이전의 «방향별 자동 숨김(ChromeAutoHide)» 은 의도와 달라 제거했다 — 사용자가 원한 건
/// «자동 숨김» 이 아니라 «버튼 자체의 방향별 노출 제어» 였다.)
enum ChromeHideFAB {
    /// 가로 모드에서 FAB 를 띄울지. 채팅·미러링 + 설정 시트가 같은 키를 본다.
    static let landscapeKey = "ui.showChromeHideFAB.landscape"
    /// 세로 모드에서 FAB 를 띄울지.
    static let portraitKey = "ui.showChromeHideFAB.portrait"

    /// 첫 부팅 기본값 — 양쪽 다 켜 둔다(기존 «항상 노출» 동작과 동일, 기능을 발견 가능하게).
    static let defaultShown = true
}

/// SwiftUI App 라이프사이클에 UIKit 의 supportedInterfaceOrientationsFor 콜백을 끼워 넣는
/// 얇은 어댑터. PocketSisyphusApp 이 `@UIApplicationDelegateAdaptor` 로 인스턴스화.
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil,
    ) -> Bool {
        // 알림 액션 콜백(콜드 런치 from 알림 포함)을 받으려면 launch 직후 델리게이트가 걸려 있어야
        // 한다. 의존성(auth/conn/deepLink)은 연결 준비 후 configure(...) 가 채우고, 그 전에 들어온
        // 액션은 AgentWaitNotifier 가 큐에 담았다 드레인한다.
        UNUserNotificationCenter.current().delegate = AgentWaitNotifier.shared
        return true
    }

    func application(
        _ application: UIApplication,
        supportedInterfaceOrientationsFor window: UIWindow?,
    ) -> UIInterfaceOrientationMask {
        // iPhone-only — 가로 허용 시 `.allButUpsideDown` (거꾸로 portrait 는 사용성 낮음).
        // allowLandscape 는 항상 true 라 사실상 상수지만, 정책 진입점을 한 곳에 남겨 둔다.
        return OrientationLock.allowLandscape ? .allButUpsideDown : .portrait
    }
}
