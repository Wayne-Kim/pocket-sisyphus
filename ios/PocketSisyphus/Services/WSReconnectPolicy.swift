import Foundation

/// WS 재연결 상태머신의 «순수» 정책 — URLSession/네트워크에 의존하지 않아 host-less 단위
/// 테스트로 회귀를 고정한다. WSClient 가 이 값/함수를 그대로 소비한다(로직은 여기 한 곳).
///
/// ## 왜 분리했나
/// 재연결 경로(backoff 수열·missed-pong 즉시 재연결·비복구 사유 중단)는 이 제품의 구조적
/// 강점(폰이 끊겨도 Mac 의 에이전트 세션 생존)을 지키는 핵심인데, 네트워크에 묶여 있어
/// 테스트가 0건이었다. 정책을 값 로직으로 떼어내면 backoff 상한·jitter 경계·임계 카운트를
/// 결정론적으로 검증할 수 있다.
enum WSReconnectPolicy {
    /// 지수 백오프 상한(초). 회로가 오래 막혀도 이 이상으로 벌어지지 않는다.
    static let maxBackoffSeconds: Double = 30
    /// 첫 재시도의 기준 백오프(초). attempt=0 의 베이스.
    static let baseBackoffSeconds: Double = 1
    /// app-level ping 이 연속으로 응답되지 않은 횟수의 임계 — 도달 시 «즉시» 재연결.
    /// 2 = 두 번 연속 pong 누락(좀비 socket 의 빠른 탐지).
    static let missedPongThreshold = 2

    /// 지수 백오프 + «equal jitter» + 상한 캡.
    ///
    /// `delay = min(base · 2^attempt, cap)` 를 구한 뒤 `[delay/2, delay]` 범위로 jitter 를
    /// 준다(equal jitter). full jitter 와 달리 하한 floor(delay/2)를 유지해 thundering-herd 를
    /// 흩되 «즉시 재시도 폭주» 는 막는다. 상한은 cap 으로 고정.
    ///
    /// - Parameters:
    ///   - attempt: 0-based 재시도 횟수(0 = 첫 재시도).
    ///   - jitter: `[0,1)` 난수 provider. 테스트에서 결정론적 값을 주입한다(기본 = 시스템 난수).
    static func backoffSeconds(
        attempt: Int,
        base: Double = baseBackoffSeconds,
        cap: Double = maxBackoffSeconds,
        jitter: () -> Double = { Double.random(in: 0..<1) }
    ) -> Double {
        let n = max(0, attempt)
        // 2^n 오버플로 방지 — n 이 커도 cap 으로 어차피 눌린다.
        let exp = n >= 31 ? cap : min(base * pow(2, Double(n)), cap)
        let half = exp / 2
        return half + half * min(max(jitter(), 0), 0.999_999)
    }

    /// WS close code 의 «복구 가능성» 분류. recoverable = backoff 후 재시도, nonRecoverable =
    /// 루프 중단 + 사용자 안내(재페어링/업데이트 등 «설정»이 필요).
    enum Recoverability: Equatable {
        case recoverable
        case nonRecoverable(NonRecoverableReason)
    }

    /// 재시도해도 의미 없는 비복구 사유. 각 사유는 사용자가 취해야 할 액션이 다르다.
    enum NonRecoverableReason: Equatable {
        /// 1008 policy violation — daemon 이 페어링 토큰을 회전(인증 폐기)해 강제 종료.
        /// 재페어링 전까지 어떤 재시도도 401 로 거절된다.
        case pairingRotated
        /// 인증 실패(401) — 토큰이 더는 유효하지 않음.
        case authFailed
        /// 버전 너무 낮음(426) — daemon 이 최소 클라이언트 버전을 요구. 앱 업데이트 필요.
        case versionTooOld
        /// 직접 채널 host key 변경(MITM 의심) — 신뢰를 재설정하기 전엔 직접 연결 거부.
        case hostKeyMismatch

        /// 배너/안내에 쓸 localize 된 한 줄. 「설정 필요」 계열이라 UI 는 warning 톤으로 그린다.
        var message: String {
            switch self {
            case .pairingRotated:
                return String(localized: "페어링이 만료됐어요 — Mac 과 다시 페어링해 주세요")
            case .authFailed:
                return String(localized: "인증에 실패했어요 — Mac 과 다시 페어링해 주세요")
            case .versionTooOld:
                return String(localized: "앱이 너무 오래됐어요 — 업데이트가 필요해요")
            case .hostKeyMismatch:
                return String(localized: "서버 host key 가 바뀌었어요 — 보안을 위해 직접 연결을 막았어요")
            }
        }
    }

    /// WS close code → 복구 가능성. URLSession 이 관찰 가능한 건 close code 뿐이라(upgrade
    /// 의 401/426 은 URLError 로 와 코드가 가려진다 — 그쪽은 HTTP/SSH 레이어인 ConnectionManager
    /// 가 이미 비복구로 분류·중단한다) 여기선 policyViolation(1008=페어링 회전)만 비복구로 본다.
    static func classify(closeCode: URLSessionWebSocketTask.CloseCode) -> Recoverability {
        switch closeCode {
        case .policyViolation:
            return .nonRecoverable(.pairingRotated)
        default:
            return .recoverable
        }
    }
}

/// app-level ping/pong 누락 추적 — 연속 누락이 임계에 도달하면 즉시 재연결을 신호한다.
/// 좀비 socket(서버측 idle timeout·NAT rebinding 으로 TCP 는 살아있는 듯 보이나 데이터가
/// 안 흐르는 상태)을 receive() 에러보다 빠르게 탐지한다.
///
/// 값 타입(struct)이라 상태가 명시적이고 테스트가 결정론적. WSClient 가 ping 사이클마다
/// `beforePing()`, pong 수신 시 `onPong()`, (재)연결 시 `reset()` 을 호출한다.
struct HeartbeatMonitor {
    let threshold: Int
    /// 직전에 보낸 ping 이 아직 응답되지 않았는가.
    private var outstanding = false
    /// 연속으로 응답되지 않은 ping 개수.
    private(set) var consecutiveMissed = 0

    init(threshold: Int = WSReconnectPolicy.missedPongThreshold) {
        self.threshold = max(1, threshold)
    }

    /// 새 ping 을 보내기 «직전» 호출. 직전 ping 이 미응답이면 누락으로 집계한다.
    /// - Returns: 누적 연속 누락이 임계에 도달해 «즉시 재연결» 해야 하면 true.
    mutating func beforePing() -> Bool {
        if outstanding { consecutiveMissed += 1 }
        outstanding = true
        return consecutiveMissed >= threshold
    }

    /// pong 수신 — 미응답/누락 카운트를 모두 리셋.
    mutating func onPong() {
        outstanding = false
        consecutiveMissed = 0
    }

    /// (재)연결 시작 시 호출 — 깨끗한 상태로 초기화.
    mutating func reset() {
        outstanding = false
        consecutiveMissed = 0
    }
}
