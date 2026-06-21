import Foundation

/// 입력 바이트 추적 — 송신측(iOS)·수신측(Mac daemon)이 «동일 포맷» 으로 키스트로크 바이트를
/// 찍어 한글/CJK·IME 입력 회귀를 «양끝 대조» 로 잡는 진단.
///
/// ## 배경
/// 입력 경로에 에이전트별 분기가 없어(`writePtyRaw` 가 모든 에이전트 동일 취급) 새 Ink 기반
/// CLI 를 붙일 때마다 각자의 CJK/IME 입력 취약을 그대로 떠안는다. 임시 `[KS-DEBUG]` NSLog
/// 를 «정식 추적» 으로 승격해, 어느 에이전트 세션에서든 송신 바이트와 PTY write 바이트가
/// 일치하는지 표준 절차로 확인한다(재현 레시피: docs/ARCHITECTURE.md §5.3).
///
/// ## 켜는 법 (기본 OFF — 프로덕션 동작·성능 영향 0)
/// 둘 중 하나면 켜진다:
///   - 환경변수 `PS_KS_TRACE=1` — Xcode scheme 또는 `simctl launch` 의 `SIMCTL_CHILD_PS_KS_TRACE`.
///   - `UserDefaults.standard.set(true, forKey: "PS_KS_TRACE")` — 실기기에서 재빌드 없이 토글.
///
/// ## 포맷 (daemon `pty-runner.ts` 의 `ksTrace` 와 1:1 동일)
/// ```
/// [KS-TRACE] send session=<id> agent=<id> bytes=<n> hex=[xx xx …]
/// ```
/// `idevicesyslog | grep KS-TRACE` (송신·`send`) 와 daemon unified.log 의 `KS-TRACE recv`
/// 를 같은 session·bytes·hex 로 짝지어, WS·sanitize 경로에서 손상/유실이 없는지 대조한다.
enum KSTrace {
    /// hex preview 최대 바이트 — daemon `KS_TRACE_HEX_CAP` 과 동일(64). 초과분은 `+Nmore`.
    private static let hexCap = 64

    /// 추적 on/off. env 우선, 없으면 UserDefaults. 매 호출 평가라 런타임 토글이 즉시 반영된다.
    static var enabled: Bool {
        if let v = ProcessInfo.processInfo.environment["PS_KS_TRACE"] {
            return ["1", "true", "yes"].contains(v.lowercased())
        }
        return UserDefaults.standard.bool(forKey: "PS_KS_TRACE")
    }

    /// 키스트로크 한 건을 찍는다. OFF 면 즉시 반환 — 문자열 포매팅조차 안 해 성능 영향 0.
    /// `note` 는 SKIP/DROP 같은 보조 사유를 끝에 덧붙인다(대조 시 차이 설명용).
    static func log(
        _ side: String,
        session: String?,
        agent: String?,
        bytes: Data,
        note: String? = nil,
    ) {
        guard enabled else { return }
        let hex = bytes.prefix(hexCap).map { String(format: "%02x", $0) }.joined(separator: " ")
        let more = bytes.count > hexCap ? " +\(bytes.count - hexCap)more" : ""
        let noteSuffix = note.map { " \($0)" } ?? ""
        NSLog(
            "[KS-TRACE] \(side) session=\(session ?? "nil") agent=\(agent ?? "nil") "
            + "bytes=\(bytes.count) hex=[\(hex)\(more)]\(noteSuffix)"
        )
    }
}
