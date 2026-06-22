import Foundation

/// 「반복 실행」(repeat_run_v1) — 워크플로우 캔버스 없이 «하나의 목표를 통과할 때까지 매번 새
/// 컨텍스트로 다시 실행» 을 거는 가벼운 단위. daemon `workflow/repeat.ts` 의 `RepeatRunApi` 와 1:1.
///
/// daemon 은 (repo·에이전트·목표 스펙·완료 검사·최대 횟수)로 자기교정 루프를 합성해 기존
/// WorkflowEngine 으로 돌린다 — 매 회 새 세션(=새 컨텍스트), 점검 verdict 가 pass(완료)거나
/// 최대 횟수에 닿으면(실패) 멈춘다. iOS 는 이 모델로 진행/완료/실패 카드를 그린다(캔버스 없이).
struct RepeatRun: Codable, Identifiable, Equatable {
    let run_id: String
    let workflow_id: String
    let repo_path: String?
    let agent: String?
    /// 목표 스펙(실행 노드 prompt).
    let goal: String?
    /// 완료 검사(점검 노드 prompt).
    let check: String?
    /// running | done | failed | cancelled.
    let status: String
    /// 현재 반복 회차 (1-based).
    let iteration: Int
    /// 최대 횟수.
    let max_iterations: Int
    /// 점검 판정 — "pass"(완료) | "fail" | nil(아직).
    let verdict: String?
    /// 1 = 최대 횟수 도달로 멈춤(true).
    let limit_reached: Bool
    let started_at: Int64
    let ended_at: Int64?

    var id: String { run_id }

    /// 진행 중인가 (시작/로딩 포함 — daemon 은 시작 직후 running).
    var isRunning: Bool { status == "running" }
    /// 완료(점검 통과)인가 — status done + verdict pass.
    var isCompleted: Bool { status == "done" }
    /// 실패(상한 도달 등)인가.
    var isFailed: Bool { status == "failed" }
}

/// `GET /api/repeat/runs` — 「반복 실행」 run 목록.
struct RepeatRunsResponse: Codable {
    let runs: [RepeatRun]
}

/// `GET /api/repeat/runs/:id` — 한 run 상태.
struct RepeatRunStateResponse: Codable {
    let run: RepeatRun
}

/// `POST /api/repeat` 응답 — 시작 시 runId/workflowId 즉시 반환(진행은 daemon 백그라운드).
struct RepeatRunStartResponse: Codable {
    let runId: String
    let workflowId: String
}

/// `POST /api/repeat` 요청 — 시트가 모으는 5필드 + 격리/승인 옵션. daemon 라우트가 camelCase 로 읽는다.
struct StartRepeatRunRequest: Encodable {
    let repoPath: String
    let agent: String?
    let goal: String
    let check: String
    let maxIterations: Int
    /// worktree 격리에서 돌릴지 (기본 true — 무인 경로).
    let isolated: Bool
    /// 민감한 작업 무인 승인(skip_permissions). 무인 루프라 기본 true.
    let skipPermissions: Bool
}
