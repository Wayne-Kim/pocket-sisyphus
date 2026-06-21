import Testing
import Foundation

// HappyEyeballsPolicy.swift + EndpointCache.swift(EndpointEntry) 를 host-less library test
// 패턴으로 이 번들에 직접 컴파일한다(project.yml 의 PocketSisyphusTests.sources 참고).
//
// 「happy eyeballs」 회귀 차단 — RFC 8305 우선순위/첫성공 채택의 «정렬·필터» 계약을 고정한다:
//  - priority 오름차순(direct_ipv6 → direct_ipv4 → tor_onion) 으로 출발 순서가 정해진다.
//  - tor onion 후보는 Tor 가 ready 일 때만 시도(직접 채널은 무관).
//  - 동일 priority 는 입력 순서를 보존(결정론적).

@Suite("HappyEyeballsPolicy 정렬·필터 계약")
struct HappyEyeballsPolicyTests {

    private func ep(_ type: EndpointEntry.EndpointType, _ host: String, _ port: UInt16, _ pri: Int) -> EndpointEntry {
        EndpointEntry(type: type, host: host, port: port, priority: pri)
    }

    @Test("priority 오름차순으로 정렬 — ipv6(1) → ipv4(2) → onion(99)")
    func sortsByPriorityAscending() {
        let input = [
            ep(.torOnion, "abc.onion", 22, 99),
            ep(.directIPv4, "203.0.113.5", 22022, 2),
            ep(.directIPv6, "2001:db8::1", 22022, 1),
        ]
        let out = HappyEyeballsPolicy.order(input, torReady: true)
        #expect(out.map(\.type) == [.directIPv6, .directIPv4, .torOnion])
    }

    @Test("Tor 미준비면 onion 후보를 제외하고 직접 채널만 남긴다")
    func excludesOnionWhenTorNotReady() {
        let input = [
            ep(.directIPv6, "2001:db8::1", 22022, 1),
            ep(.directIPv4, "203.0.113.5", 22022, 2),
            ep(.torOnion, "abc.onion", 22, 99),
        ]
        let out = HappyEyeballsPolicy.order(input, torReady: false)
        #expect(out.map(\.type) == [.directIPv6, .directIPv4])
        #expect(!out.contains { $0.type == .torOnion })
    }

    @Test("Tor 준비되면 onion 후보를 마지막 우선순위로 포함")
    func includesOnionWhenTorReady() {
        let input = [ep(.torOnion, "abc.onion", 22, 99)]
        let out = HappyEyeballsPolicy.order(input, torReady: true)
        #expect(out.count == 1)
        #expect(out.first?.type == .torOnion)
    }

    @Test("동일 priority 는 입력 순서를 보존(안정 정렬)")
    func stableForEqualPriority() {
        let input = [
            ep(.directIPv4, "a", 22022, 5),
            ep(.directIPv4, "b", 22022, 5),
            ep(.directIPv4, "c", 22022, 5),
        ]
        let out = HappyEyeballsPolicy.order(input, torReady: true)
        #expect(out.map(\.host) == ["a", "b", "c"])
    }

    @Test("빈 입력은 빈 출력")
    func emptyInput() {
        #expect(HappyEyeballsPolicy.order([], torReady: true).isEmpty)
        #expect(HappyEyeballsPolicy.order([], torReady: false).isEmpty)
    }

    @Test("onion «만» 있는데 Tor 미준비면 후보 0개(연결 시도 자체 없음)")
    func onlyOnionWithoutTorYieldsEmpty() {
        let input = [ep(.torOnion, "abc.onion", 22, 99)]
        let out = HappyEyeballsPolicy.order(input, torReady: false)
        #expect(out.isEmpty)
    }
}
