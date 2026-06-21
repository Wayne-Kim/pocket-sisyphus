import Foundation

/// daemon `/api/agents` 응답의 한 row — 등록된 코드 에이전트 CLI 의 메타.
///
/// 옛 하드코드 `CodingTool` enum 을 대체. 새 adapter 가 daemon 에 등록되면 (예: gemini-cli)
/// iOS 빌드 갱신 없이 picker 에 자동 노출된다.
///
/// daemon `mac/daemon/src/agent/types.ts` 의 AgentAdapter 와 1:1 — id / displayName /
/// capabilities 3 필드. 필드 추가는 호환 (Codable 이 모르는 키 ignore).
struct AgentInfo: Codable, Identifiable, Equatable, Hashable {
    let id: String          // "claude_code" | "agy" | …
    let displayName: String
    let capabilities: [String]
    /// 이 CLI 가 Mac 에 설치돼 있는지 (daemon 의 resolveBinary 성공 여부). 옛 daemon 은
    /// 이 키를 안 보내 nil → `isInstalled` 가 true 로 간주해 기존 동작 유지.
    let installed: Bool?
    /// 미설치일 때 daemon 이 동봉하는 설치 명령/URL (코드성 문자열, 번역 대상 아님).
    let installHint: String?

    /// daemon 이 `installed` 를 안 보낸 옛 빌드면 「설치됨」 으로 본다 (회귀 방지).
    var isInstalled: Bool { installed ?? true }
}

/// daemon `GET /api/agents` 응답.
struct AgentsResponse: Codable {
    let agents: [AgentInfo]
}

extension AgentInfo {
    /// daemon 이 `multi_agent_v1` capability 를 모르는 옛 빌드일 때 사용하는 fallback.
    /// 그런 daemon 은 항상 claude_code 한 종류만 spawn 했으므로 같은 가정 유지.
    static let claudeCodeFallback = AgentInfo(
        id: "claude_code",
        displayName: "Claude Code",
        capabilities: [],
        installed: true,
        installHint: nil,
    )

    /// installHint 가 «실행 가능한 셸 명령» 인지 — daemon `installHintIsCommand` 와 같은 규칙.
    /// URL (agy 의 https://…) 이거나 비어 있으면 false → 자동 설치 불가, 링크 안내로 폴백.
    var installHintIsCommand: Bool {
        guard let h = installHint?.trimmingCharacters(in: .whitespacesAndNewlines), !h.isEmpty else {
            return false
        }
        let lower = h.lowercased()
        return !lower.hasPrefix("http://") && !lower.hasPrefix("https://")
    }
}

/// daemon `GET/POST /api/admin/install-agent[/status]` 응답 — 어댑터 설치 진행 스냅샷.
///
/// daemon `mac/daemon/src/agent/install.ts` 의 AgentInstallProgress 와 1:1. 폰이 1s 간격
/// 으로 status 를 폴링해 로그/상태/종료코드를 본다.
struct AgentInstallProgress: Codable, Equatable {
    /// 설치 중/했던 어댑터 id. idle 이면 nil.
    let adapterId: String?
    /// "idle" | "installing" | "done" | "error".
    let state: String
    /// 실행 중/했던 설치 명령 (코드성 상수). 실패 시 복사용 폴백.
    let command: String?
    /// 누적 stdout+stderr (말미 16KB).
    let log: String
    /// 프로세스 종료 코드. 진행 중/spawn 실패면 nil.
    let exitCode: Int?
    /// 실패 사유 코드: "spawn_failed" | "nonzero_exit" | "not_detected" | "homebrew_missing" |
    /// "node_missing" | nil. "homebrew_missing" 은 brew 명령이 brew 자체를 못 찾아 실패한 경우 —
    /// 일반 「설치 실패」 가 아니라 Homebrew 설치 안내로 분기하라는 신호. "node_missing" 은
    /// npm/node 기반 설치 명령이 npm 자체를 못 찾아 실패한 경우 — Node.js 설치 안내로 분기하라는 신호.
    let error: String?
    /// 설치 직후 재탐지 결과 (resolveBinary 성공 여부).
    let installed: Bool
    /// 시작 시각 (epoch ms).
    let startedAt: Double?

    var isInstalling: Bool { state == "installing" }
    var isDone: Bool { state == "done" }
    var isError: Bool { state == "error" }
    /// brew 자체가 없어 실패 — 일반 폴백 대신 정확한 Homebrew 설치 안내로 분기하라는 신호.
    var isHomebrewMissing: Bool { error == "homebrew_missing" }
    /// npm/node 자체가 없어 실패 — 일반 폴백 대신 정확한 Node.js 설치 안내로 분기하라는 신호.
    var isNodeMissing: Bool { error == "node_missing" }
}
