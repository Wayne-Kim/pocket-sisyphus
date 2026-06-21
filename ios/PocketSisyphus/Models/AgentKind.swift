import Foundation

/// 세션이 어떤 CLI 도구로 spawn 됐는지 — daemon `sessions.agent` 컬럼의 raw id 를
/// UI / 테스트에서 다루기 쉬운 열거형으로 변환.
///
/// SwiftUI / Color 같은 UI 의존성을 두지 않는다. 시각 표현 (색상) 은 호출하는 view 가
/// `AgentKind` 를 보고 결정 — 그 경계 덕분에 이 매핑은 host-less 단위 테스트로
/// 검증 가능하고, 시각 추론을 끌어들이지 않는다.
///
/// 새 agent adapter (예: `gemini-cli`) 가 daemon 에 등록되면 그 id 는 `.unknown(id)`
/// 로 떨어진다 — view 는 «새 종류» 임을 raw id 로 노출해 사용자가 인지하게 한다.
enum AgentKind: Equatable {
    case claudeCode
    case shell
    case codex
    case antigravity
    case localLlm
    case openCode
    case copilot
    case unknown(String)

    /// daemon raw id → kind. nil 은 옛 daemon (multi_agent_v1 미지원) 호환 —
    /// 그 시절엔 항상 claude_code 만 spawn 했으므로 같은 가정 유지.
    static func from(id: String?) -> AgentKind {
        switch id {
        case "claude_code", .none: return .claudeCode
        case "shell": return .shell
        case "codex": return .codex
        case "agy": return .antigravity
        case "local_llm": return .localLlm
        case "opencode": return .openCode
        case "copilot": return .copilot
        case .some(let raw): return .unknown(raw)
        }
    }

    /// `from(id:)` 의 역방향 — daemon raw id 로 되돌린다. 에이전트별 설정 영속 키나
    /// 재spawn 에 쓰는 «안정적» 식별자다. nil(=옛 daemon)은 `claude_code` 로 흡수됐으니
    /// 여기선 `claude_code` 를 돌려준다(같은 키로 합쳐 영속이 끊기지 않게).
    var rawId: String {
        switch self {
        case .claudeCode: return "claude_code"
        case .shell: return "shell"
        case .codex: return "codex"
        case .antigravity: return "agy"
        case .localLlm: return "local_llm"
        case .openCode: return "opencode"
        case .copilot: return "copilot"
        case .unknown(let raw): return raw
        }
    }

    /// 브랜드명. 번역 대상 아님 (Pocket Sisyphus / PTY 와 같은 정책).
    var displayName: String {
        switch self {
        case .claudeCode: return "Claude Code"
        case .shell: return "Terminal"
        case .codex: return "Codex"
        case .antigravity: return "Antigravity"
        case .localLlm: return "Qwen Code"
        case .openCode: return "OpenCode"
        case .copilot: return "Copilot"
        case .unknown(let raw): return raw
        }
    }

    /// SF Symbol name. view 가 그대로 `Image(systemName:)` 에 넘겨 쓴다.
    var systemImage: String {
        switch self {
        case .claudeCode: return "sparkles"
        case .shell: return "terminal.fill"
        case .codex: return "chevron.left.forwardslash.chevron.right"
        case .antigravity: return "atom"
        case .localLlm: return "cpu"
        case .openCode: return "shippingbox"
        case .copilot: return "curlybraces"
        case .unknown: return "questionmark.circle"
        }
    }
}
