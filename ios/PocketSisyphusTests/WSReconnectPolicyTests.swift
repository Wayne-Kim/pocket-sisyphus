import Testing
import Foundation

// WSReconnectPolicy.swift 를 host-less library test 패턴으로 이 번들에 직접 컴파일한다
// (project.yml 의 PocketSisyphusTests.sources 참고). 네트워크 의존이 없어 backoff 수열·
// jitter 경계·missed-pong 임계·close-code 분류를 결정론적으로 고정한다.
//
// 「재연결 상태머신」 회귀 차단 — 모바일 모범사례를 코드로 박는다:
//  - exp backoff + equal jitter + 30s 상한 캡.
//  - 2회 연속 pong 누락 → 즉시 재연결 신호.
//  - 비복구 close code(1008 페어링 회전) → 루프 중단 분류.

@Suite("WSReconnectPolicy 재연결 정책")
struct WSReconnectPolicyTests {

    // MARK: - backoff

    @Test("equal jitter — 각 단계가 [절반, 전체] 범위 안")
    func backoffWithinEqualJitterBounds() {
        // jitter=0 → 하한(절반), jitter≈1 → 상한(전체).
        let expectedCaps: [Int: Double] = [0: 1, 1: 2, 2: 4, 3: 8, 4: 16, 5: 30, 6: 30]
        for (attempt, cap) in expectedCaps {
            let lo = WSReconnectPolicy.backoffSeconds(attempt: attempt, jitter: { 0 })
            let hi = WSReconnectPolicy.backoffSeconds(attempt: attempt, jitter: { 0.999_999 })
            #expect(lo == cap / 2)
            #expect(hi <= cap + 0.0001)
            #expect(hi > cap / 2)
        }
    }

    @Test("상한 캡 — attempt 가 커도 30s 를 넘지 않는다")
    func backoffCapped() {
        for attempt in [5, 8, 16, 30, 100, 1000] {
            let v = WSReconnectPolicy.backoffSeconds(attempt: attempt, jitter: { 0.999_999 })
            #expect(v <= WSReconnectPolicy.maxBackoffSeconds + 0.0001)
            // 캡 단계에선 하한이 cap/2 = 15s 로 고정.
            let lo = WSReconnectPolicy.backoffSeconds(attempt: attempt, jitter: { 0 })
            #expect(lo == WSReconnectPolicy.maxBackoffSeconds / 2)
        }
    }

    @Test("수열은 단조 증가(상한 도달 전까지) — 1,2,4,8,16 의 캡")
    func backoffMonotonicCaps() {
        // jitter=1 일 때의 상한이 지수적으로 커진다.
        let caps = (0...5).map { WSReconnectPolicy.backoffSeconds(attempt: $0, jitter: { 0.999_999 }) }
        // 0→~1, 1→~2, 2→~4, 3→~8, 4→~16, 5→~30(cap)
        #expect(caps[0] < caps[1])
        #expect(caps[1] < caps[2])
        #expect(caps[2] < caps[3])
        #expect(caps[3] < caps[4])
        #expect(caps[4] <= caps[5])
        #expect(caps[5] <= WSReconnectPolicy.maxBackoffSeconds + 0.0001)
    }

    @Test("음수 attempt 는 0 으로 클램프")
    func backoffNegativeClamped() {
        let neg = WSReconnectPolicy.backoffSeconds(attempt: -5, jitter: { 0 })
        let zero = WSReconnectPolicy.backoffSeconds(attempt: 0, jitter: { 0 })
        #expect(neg == zero)
    }

    // MARK: - missed-pong (HeartbeatMonitor)

    @Test("2회 연속 누락에서 즉시 재연결 신호")
    func heartbeatTriggersAfterTwoMisses() {
        var hb = HeartbeatMonitor(threshold: 2)
        // ping1 — 직전 ping 없음 → 누락 아님.
        #expect(hb.beforePing() == false)
        #expect(hb.consecutiveMissed == 0)
        // ping2 — ping1 미응답 → 누락 1. 아직 임계 미달.
        #expect(hb.beforePing() == false)
        #expect(hb.consecutiveMissed == 1)
        // ping3 — ping2 미응답 → 누락 2 → 재연결.
        #expect(hb.beforePing() == true)
        #expect(hb.consecutiveMissed == 2)
    }

    @Test("pong 이 오면 누락 카운트가 리셋된다")
    func heartbeatResetOnPong() {
        var hb = HeartbeatMonitor(threshold: 2)
        _ = hb.beforePing()      // ping1
        _ = hb.beforePing()      // ping2, missed=1
        #expect(hb.consecutiveMissed == 1)
        hb.onPong()              // 응답 도착 → 리셋
        #expect(hb.consecutiveMissed == 0)
        // 다시 ping — outstanding 도 리셋됐으니 누락 아님.
        #expect(hb.beforePing() == false)
        #expect(hb.consecutiveMissed == 0)
    }

    @Test("정상 ping/pong 왕복은 절대 재연결을 트리거하지 않는다")
    func heartbeatHealthyNeverTriggers() {
        var hb = HeartbeatMonitor(threshold: 2)
        for _ in 0..<10 {
            #expect(hb.beforePing() == false)
            hb.onPong()
        }
        #expect(hb.consecutiveMissed == 0)
    }

    @Test("reset() 은 상태를 초기화한다")
    func heartbeatReset() {
        var hb = HeartbeatMonitor(threshold: 2)
        _ = hb.beforePing()
        _ = hb.beforePing()
        hb.reset()
        #expect(hb.consecutiveMissed == 0)
        #expect(hb.beforePing() == false)
    }

    // MARK: - close-code 분류

    @Test("1008 policy violation = 비복구(페어링 회전)")
    func classifyPolicyViolationNonRecoverable() {
        let r = WSReconnectPolicy.classify(closeCode: .policyViolation)
        #expect(r == .nonRecoverable(.pairingRotated))
    }

    @Test("일반 종료(goingAway/abnormal/normal/noStatus)는 복구 가능")
    func classifyOrdinaryRecoverable() {
        for code: URLSessionWebSocketTask.CloseCode in [.goingAway, .abnormalClosure, .normalClosure, .noStatusReceived, .internalServerError] {
            #expect(WSReconnectPolicy.classify(closeCode: code) == .recoverable)
        }
    }

    @Test("비복구 사유마다 비어있지 않은 안내 메시지를 제공")
    func nonRecoverableMessagesNonEmpty() {
        let reasons: [WSReconnectPolicy.NonRecoverableReason] = [.pairingRotated, .authFailed, .versionTooOld, .hostKeyMismatch]
        for reason in reasons {
            #expect(!reason.message.isEmpty)
        }
    }
}
