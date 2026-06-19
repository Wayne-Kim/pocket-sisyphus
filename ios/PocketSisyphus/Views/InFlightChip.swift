import SwiftUI

/// (제거됨) 옛 in-flight 진행 배너.
///
/// Tor 만 쓰던 시절엔 요청이 느려서, nav bar 바로 아래에 «대화 불러오는 중» 같은 진행 라벨을
/// 띄우는 가는 배너(`InFlightChip`)를 두었다. 듀얼 채널(직접 SSH + Tor fallback) 도입 후엔 응답이
/// 보통 0.5초 안에 와서, 이 배너가 «떴다 곧 사라지며» 깜빡여 오히려 거슬렸다 → 제거.
///
/// `inFlightBanner()` 는 호출부(SessionsView/ChatView 등) 변경 없이 배너만 없애려고 **no-op** 으로
/// 남겨 둔다. `InFlightTracker` 자체는 ApiClient 가 여전히 주입받지만(요청 추적용) 그걸 «표시하는»
/// UI 는 더 이상 없다. 추적까지 들어내려면 ApiClient 의 `tracker:`/`label:` 경로를 함께 정리하면 된다.
extension View {
    /// no-op — 옛 in-flight 배너는 제거됨. 호출부 호환을 위해 시그니처만 남긴다.
    func inFlightBanner() -> some View { self }
}
