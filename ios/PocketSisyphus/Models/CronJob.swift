import Foundation

/// 예약 작업 한 건 — daemon `cron_jobs` row 와 1:1 (snake_case 그대로, camelCase 편의 프로퍼티 동반).
/// SessionSummary 와 같은 컨벤션: 응답은 raw row, UI 분기는 computed 프로퍼티.
struct CronJob: Codable, Identifiable, Equatable, Hashable {
    let id: String
    let title: String?
    /// "agent"(에이전트 프롬프트) | "terminal"(쉘 스크립트 파일). 옛 daemon 응답엔 없어 nil → 'agent'.
    let kind: String?
    let agent: String
    let repo_path: String
    /// kind="agent": 프롬프트. kind="terminal": 쉘 스크립트 파일 절대경로.
    let command: String
    /// kind="terminal" 인터프리터 ("zsh"|"bash"|"sh"). nil = 사용자 기본 셸. agent 면 nil.
    let shell: String?
    /// 5필드 cron 식 ("0 9 * * 1-5").
    let schedule: String
    /// IANA timezone. nil = Mac 로컬.
    let timezone: String?
    /// 0/1 — 무인 실행 도구 자동 승인.
    let skip_permissions: Int
    /// "fresh" | "continue".
    let session_mode: String
    /// "skip" | "allow".
    let overlap_policy: String
    let catch_up: Int
    let notify: Int
    let enabled: Int
    let created_at: Int64
    let updated_at: Int64?
    /// 최신 실행 요약 (목록 화면 표시용 캐시).
    let last_run_at: Int64?
    let last_status: String?
    let last_session_id: String?
    let next_run_at: Int64?
    let run_count: Int

    // 편의 — UI 분기용.
    var skipPermissions: Bool { skip_permissions == 1 }
    var catchUp: Bool { catch_up == 1 }
    var notifyEnabled: Bool { notify == 1 }
    var isEnabled: Bool { enabled == 1 }
    var continuesConversation: Bool { session_mode == "continue" }
    /// 옛 daemon 호환 — kind 없으면 에이전트.
    var kindValue: String { kind ?? "agent" }
    var isTerminal: Bool { kindValue == "terminal" }

    var lastRunDate: Date? { last_run_at.map { Date(timeIntervalSince1970: Double($0) / 1000) } }
    var nextRunDate: Date? { next_run_at.map { Date(timeIntervalSince1970: Double($0) / 1000) } }
}

/// 예약 작업의 한 번 실행 이력 — daemon `cron_runs` row 와 1:1.
struct CronRun: Codable, Identifiable, Equatable, Hashable {
    let id: String
    let cron_job_id: String
    let session_id: String?
    /// "schedule" | "manual".
    let trigger: String
    let started_at: Int64
    let ended_at: Int64?
    /// "running" | "ok" | "error" | "timeout" | "skipped".
    let status: String
    let error: String?

    var startedDate: Date { Date(timeIntervalSince1970: Double(started_at) / 1000) }
    var endedDate: Date? { ended_at.map { Date(timeIntervalSince1970: Double($0) / 1000) } }
}

// MARK: - 요청 / 응답 wrapper

/// 생성(POST) / 수정(PATCH) 공통 바디. 편집 저장은 모든 필드를 실어 보낸다 (full update).
/// nil 필드는 JSONEncoder 의 encodeIfPresent 로 자동 생략 → daemon 이 그 키를 안 건드린다.
struct CronJobUpsertRequest: Encodable {
    var title: String?
    /// "agent" | "terminal". nil 이면 daemon 기본('agent'). 터미널이면 agent 는 생략(데몬이 'shell' 고정).
    var kind: String?
    var agent: String?
    var repoPath: String?
    /// kind="agent": 프롬프트. kind="terminal": 쉘 스크립트 파일 절대경로.
    var command: String?
    /// kind="terminal" 인터프리터 ("zsh"|"bash"|"sh"). nil = 기본 셸.
    var shell: String?
    var schedule: String?
    var timezone: String?
    var skipPermissions: Bool?
    /// "fresh" | "continue".
    var sessionMode: String?
    /// "skip" | "allow".
    var overlapPolicy: String?
    var catchUp: Bool?
    var notify: Bool?
    var enabled: Bool?
}

struct CronJobsResponse: Codable {
    let jobs: [CronJob]
}

struct CronJobResponse: Codable {
    let job: CronJob
}

struct CronJobDetailResponse: Codable {
    let job: CronJob
    let runs: [CronRun]
}

/// POST /api/cron/preview 응답 — 다음 실행 timestamp(ms) 만. 사람 가독 포맷은 iOS 가 로케일로.
struct SchedulePreview: Codable, Equatable {
    let valid: Bool
    let error: String?
    let nextRuns: [Int64]

    var nextRunDates: [Date] { nextRuns.map { Date(timeIntervalSince1970: Double($0) / 1000) } }
}

/// POST /api/cron/:id/run 응답 — 즉시 실행 결과.
/// status: "running"(세션 생성됨) | "skipped" | "error".
struct CronRunStartResult: Codable, Equatable {
    let status: String
    let sessionId: String?
    let runId: String?
    /// status == "skipped" 일 때 사유 머신 코드 ("overlap" = 직전 실행 진행 중 등).
    /// 구버전 daemon 응답엔 없어 nil — 그땐 일반 안내문으로 폴백한다.
    let skipReason: String?
}
