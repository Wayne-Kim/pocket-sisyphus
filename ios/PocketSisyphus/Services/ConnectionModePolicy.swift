import Foundation

/// 연결 «방식» 의 최초 선택 여부 — 순수 값 로직.
///
/// ## 무엇을 보장하나
/// 페어 완료 후 «어디서나(Tor)» / «같은 Wi‑Fi 전용(LAN)» 중 하나를 사용자가 «명시적으로 한 번»
/// 고르게 한다. 고르기 «전» 에는 AppRoot 가 Tor 부트스트랩을 시작하지 않는다 — 사용자가
/// 「Tor 를 거치기 전에 물어봐 달라」는 요구를 만족한다. 선택 결과는 `LanOnlyPolicy` 토글에
/// 반영되고, 이후엔 설정에서 자유롭게 바꾼다(이 플래그는 «물어봤다» 표시일 뿐 재질문 안 함).
///
/// ## 왜 별도 순수 파일인가
/// `LanOnlyPolicy` 와 같은 결 — UI/네트워크 의존 0 인 값 로직만 떼어 AppRoot 의 게이트가 이
/// 함수들을 «호출만» 한다. 키는 `@AppStorage` 와 UserDefaults 양쪽이 같은 의미로 공유한다.
enum ConnectionModePolicy {
    /// UserDefaults / @AppStorage 공용 키. 「연결 방식을 한 번 골랐는가」.
    static let chosenKey = "connection.modeChosen"

    static func isChosen(_ defaults: UserDefaults = .standard) -> Bool {
        defaults.bool(forKey: chosenKey)
    }

    static func setChosen(_ chosen: Bool, _ defaults: UserDefaults = .standard) {
        defaults.set(chosen, forKey: chosenKey)
    }
}
