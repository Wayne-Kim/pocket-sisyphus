import Foundation

/// happy eyeballs(RFC 8305) 후보 «정렬·필터» 의 순수 정책.
///
/// ConnectionManager.tryConnectAll 이 병렬 connect 를 출발시키기 «전» 단계 — 어떤 후보를
/// 어떤 순서로 시도할지만 결정한다(연결 자체는 ConnectionManager). 네트워크 의존이 없어
/// host-less 단위 테스트로 «우선순위/첫성공 채택» 회귀(예: stale IPv6 가 채널을 묶던 무한
/// 로딩)를 고정한다.
///
/// ## 규칙
///   - priority 오름차순(작을수록 먼저 출발) — direct_ipv6(1) → direct_ipv4(2) → tor_onion(99).
///     이 순서 그대로 staggered start(200ms 간격)에 들어가 빠른 환경이 자연히 우선된다.
///   - Tor onion 후보는 Tor 가 ready 일 때만 의미 있다 — `torReady=false` 면 제외(직접 채널은 무관).
///   - 동일 priority 는 입력 순서를 보존(안정 정렬) — 결정론적.
enum HappyEyeballsPolicy {
    static func order(
        _ endpoints: [EndpointEntry],
        torReady: Bool
    ) -> [EndpointEntry] {
        endpoints
            // 안정 정렬: enumerated 로 동일 priority 의 원래 순서를 tie-breaker 로 보존.
            .enumerated()
            .sorted { a, b in
                if a.element.priority != b.element.priority {
                    return a.element.priority < b.element.priority
                }
                return a.offset < b.offset
            }
            .map { $0.element }
            .filter { !($0.type == .torOnion && !torReady) }
    }
}
