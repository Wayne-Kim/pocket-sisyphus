import Foundation

/// 앱 레벨 lifecycle 이벤트 broker.
///
/// 메인 앱이 백그라운드 트립(>=60s) 을 감지해 `longTripReawake()` 를 호출하면,
/// 자식 view 들이 `reawakeToken` 의 변화를 `.onChange` 로 구독해 자기 책임 영역만
/// 갱신한다 — 세션 목록 reload, polling 루프 즉시 wake, WS 강제 재연결 등.
///
/// 옛 구조 (`rebootKey = UUID()` → `.id(rebootKey)` 로 AppRoot 통째 재구성) 는
/// 잠깐 백그라운드 다녀와도 NavigationStack 깊이, ChatView 입력 텍스트, 스크롤 위치를
/// 다 날렸다. NE 도입 후엔 Tor 가 살아있어 통째 재시작이 불필요 — view-level refresh
/// 로 충분히 회복되고 사용자 상태도 보존된다.
@MainActor
final class AppLifecycle: ObservableObject {
    /// 백그라운드 60s+ 후 foreground 복귀 시 bump.
    /// view 가 `.onChange(of: lifecycle.reawakeToken)` 로 구독.
    @Published var reawakeToken: UUID = UUID()

    /// 앱이 foreground 에서 화면을 «보는 중» 인지. scenePhase 의 `.active` ↔ `.background`
    /// 를 미러링한다 (.inactive — 알림센터/컨트롤센터 peek — 은 건드리지 않는다).
    ///
    /// ChatView 가 `.onChange(of: lifecycle.isActive)` 로 구독해 WSClient 를 통해 daemon
    /// 에 visibility 를 알린다 → daemon 의 away-gating 이 «앱은 떠 있지만 사용자가 안 보는»
    /// 백그라운드 상태에서 Discord 알림을 다시 내보내게 된다.
    @Published var isActive: Bool = true

    func longTripReawake() {
        reawakeToken = UUID()
    }

    /// scenePhase 핸들러가 호출. 값이 실제로 바뀔 때만 publish (불필요한 onChange 방지).
    func setActive(_ active: Bool) {
        if isActive != active { isActive = active }
    }
}
