import Testing
import Foundation

// LanOnlyPolicy.swift + EndpointCache.swift(EndpointEntry) 를 host-less library test 패턴으로
// 이 번들에 직접 컴파일한다 (project.yml 의 PocketSisyphusTests.sources 참고).
//
// 「브리프3의 fail-closed 계약 테스트」 — LAN 전용 모드의 핵심 보장을 고정한다:
//  - 켜지면 happy eyeballs 후보를 direct_lan «만» 남긴다 (공인/onion 시도 자체 금지).
//  - Tor 부트스트랩을 «건너뛴다» (shouldSkipTorBootstrap).
//  - 채택 실패/오프-LAN 이면 fail-closed (외부로 폴백하지 않음 = 후보 0개 → 연결 실패).

@Suite("LanOnlyPolicy fail-closed 계약")
struct LanOnlyPolicyTests {

    private func ep(_ type: EndpointEntry.EndpointType, _ host: String, _ port: UInt16, _ pri: Int) -> EndpointEntry {
        EndpointEntry(type: type, host: host, port: port, priority: pri)
    }

    @Test("켜지면 direct_lan «만» 남기고 공인/onion 후보를 제거한다")
    func filtersToLanOnly() {
        let all = [
            ep(.directLan, "mac.local", 22022, 0),
            ep(.directIPv6, "2001:db8::1", 22022, 1),
            ep(.directIPv4, "203.0.113.5", 22022, 2),
            ep(.torOnion, "abc.onion", 22, 99),
        ]
        let filtered = LanOnlyPolicy.filterCandidates(all, enabled: true)
        #expect(filtered.count == 1)
        #expect(filtered.allSatisfy { $0.type == .directLan })
        #expect(!filtered.contains { $0.type == .torOnion })
        #expect(!filtered.contains { $0.type == .directIPv4 })
        #expect(!filtered.contains { $0.type == .directIPv6 })
    }

    @Test("꺼지면 후보를 그대로 통과(기존 듀얼 채널)")
    func passthroughWhenDisabled() {
        let all = [
            ep(.directIPv4, "203.0.113.5", 22022, 2),
            ep(.torOnion, "abc.onion", 22, 99),
        ]
        #expect(LanOnlyPolicy.filterCandidates(all, enabled: false).count == 2)
    }

    @Test("오프-LAN(공인/onion 만) — 켜지면 후보 0개 → fail-closed")
    func offLanYieldsNoCandidates() {
        // 같은 LAN 의 direct_lan 이 하나도 없는 상황(오프-LAN). 켜지면 시도할 후보가 없어야 한다.
        let onlyExternal = [
            ep(.directIPv4, "203.0.113.5", 22022, 2),
            ep(.torOnion, "abc.onion", 22, 99),
        ]
        let filtered = LanOnlyPolicy.filterCandidates(onlyExternal, enabled: true)
        #expect(filtered.isEmpty)
        // 정책상 fail-closed — 후보가 없으면 ConnectionManager 는 외부로 폴백하지 않고 실패해야 한다.
        #expect(LanOnlyPolicy.shouldFailClosed(enabled: true))
    }

    @Test("켜지면 Tor 부트스트랩을 건너뛴다")
    func skipsTorBootstrap() {
        #expect(LanOnlyPolicy.shouldSkipTorBootstrap(enabled: true))
        #expect(!LanOnlyPolicy.shouldSkipTorBootstrap(enabled: false))
    }

    @Test("lanCandidates — QR lanHost + 캐시 direct_lan 을 합치고 중복 제거")
    func buildsLanCandidates() {
        let cached = [
            ep(.directLan, "192.168.0.10", 22022, 1),
            ep(.directIPv4, "203.0.113.5", 22022, 2), // direct_lan 아님 → 무시
            ep(.directLan, "mac.local", 22022, 0),    // lanHost 와 중복 → 1개로
        ]
        let cands = LanOnlyPolicy.lanCandidates(lanHost: "mac.local", sshPort: 22022, cached: cached)
        let hosts = cands.map { $0.host }
        #expect(cands.allSatisfy { $0.type == .directLan })
        #expect(hosts.contains("mac.local"))
        #expect(hosts.contains("192.168.0.10"))
        #expect(!hosts.contains("203.0.113.5"))
        // mac.local:22022 중복 제거 → mac.local 은 한 번만.
        #expect(hosts.filter { $0 == "mac.local" }.count == 1)
    }

    @Test("lanCandidates — lanHost 없고 캐시도 비면 빈 배열(콜드 오프-LAN → fail-closed)")
    func emptyWhenNothingKnown() {
        #expect(LanOnlyPolicy.lanCandidates(lanHost: nil, sshPort: nil, cached: []).isEmpty)
        #expect(LanOnlyPolicy.lanCandidates(lanHost: "", sshPort: 22022, cached: []).isEmpty)
    }

    @Test("isEnabled/setEnabled — UserDefaults 왕복")
    func enabledRoundTrip() {
        let suite = UserDefaults(suiteName: "lanOnlyPolicyTest")!
        suite.removePersistentDomain(forName: "lanOnlyPolicyTest")
        #expect(!LanOnlyPolicy.isEnabled(suite))
        LanOnlyPolicy.setEnabled(true, suite)
        #expect(LanOnlyPolicy.isEnabled(suite))
        LanOnlyPolicy.setEnabled(false, suite)
        #expect(!LanOnlyPolicy.isEnabled(suite))
    }
}
