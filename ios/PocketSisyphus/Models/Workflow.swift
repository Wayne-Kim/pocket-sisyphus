import Foundation

/// 멀티 에이전트 워크플로우 — daemon `/api/workflows/*` 응답과 1:1 매핑.
///
/// daemon 은 nodes/edges 의 multi-word 키를 snake_case (repo_path, skip_permissions,
/// def_node_id …) 로 내려보낸다 (SessionSummary 와 같은 규약 — ApiClient 의 JSONDecoder 는
/// 기본 키 디코딩). 그래서 Swift 프로퍼티명도 snake_case 로 맞춘다. JSONDecoder 는 모르는
/// 키(triggers 등)를 무시하므로 Phase 0 미사용 필드는 생략해도 안전하다.
///
/// docs/ARCHITECTURE.md §12.2 참고.

/// 시작 노드 트리거 — daemon `workflow/types.ts` TriggerDef 와 1:1. kind: manual/cron/github.
/// snake_case 키(repo_path, poll_seconds)는 daemon 규약과 일치.
struct WorkflowTriggerDef: Codable, Equatable, Hashable {
    var kind: String
    var schedule: String?
    var timezone: String?
    var repo_path: String?
    var branch: String?
    var poll_seconds: Int?

    init(
        kind: String,
        schedule: String? = nil,
        timezone: String? = nil,
        repo_path: String? = nil,
        branch: String? = nil,
        poll_seconds: Int? = nil
    ) {
        self.kind = kind
        self.schedule = schedule
        self.timezone = timezone
        self.repo_path = repo_path
        self.branch = branch
        self.poll_seconds = poll_seconds
    }
}

/// 그래프의 노드 한 개 (정의). type: start/general/test/end.
struct WorkflowNodeDef: Codable, Identifiable, Equatable, Hashable {
    let id: String
    let type: String
    let title: String?
    let agent: String?
    let repo_path: String?
    let prompt: String?
    /// 결과물 처리(저장) 세부 지시 — 비면 기본(Task 폴더 result.md).
    let result_spec: String?
    /// 통과/실패를 판정할 «검사 명령»(테스트·린트·타입체크·빌드 등). 비어 있지 않으면 daemon 이
    /// 에이전트 자기 판단(verdict.json) 대신 이 명령의 «종료 코드»(0=통과, 비0=실패)로 판정한다.
    /// 비면 «검사 미설정» — 종전대로 자기 판단 폴백(약함).
    let check_command: String?
    let skip_permissions: Bool?
    /// true 면 실행 전 사용자 승인 게이트.
    let requires_approval: Bool?
    /// 시작 노드 트리거 (cron/github/manual). 시작 노드 외엔 nil.
    let triggers: [WorkflowTriggerDef]?
    /// 캔버스 좌표 (좌상단 기준).
    let x: Double?
    let y: Double?

    init(
        id: String,
        type: String,
        title: String? = nil,
        agent: String? = nil,
        repo_path: String? = nil,
        prompt: String? = nil,
        result_spec: String? = nil,
        check_command: String? = nil,
        skip_permissions: Bool? = nil,
        requires_approval: Bool? = nil,
        triggers: [WorkflowTriggerDef]? = nil,
        x: Double? = nil,
        y: Double? = nil
    ) {
        self.id = id
        self.type = type
        self.title = title
        self.agent = agent
        self.repo_path = repo_path
        self.prompt = prompt
        self.result_spec = result_spec
        self.check_command = check_command
        self.skip_permissions = skip_permissions
        self.requires_approval = requires_approval
        self.triggers = triggers
        self.x = x
        self.y = y
    }
}

/// 그래프의 간선 한 개. 방향 = from→to. condition 은 test 노드 전용 (Phase 1+).
struct WorkflowEdgeDef: Codable, Identifiable, Equatable, Hashable {
    let id: String
    let from: String
    let to: String
    let condition: String?

    init(id: String, from: String, to: String, condition: String? = nil) {
        self.id = id
        self.from = from
        self.to = to
        self.condition = condition
    }
}

/// 워크플로우 정의 한 개 (목록/상세).
struct WorkflowSummary: Codable, Identifiable, Equatable, Hashable {
    let id: String
    let title: String?
    let repo_path: String?
    let nodes: [WorkflowNodeDef]
    let edges: [WorkflowEdgeDef]
    let enabled: Bool
    let created_at: Int64
    let updated_at: Int64?

    /// 일하는 노드(task) 개수 — 목록 행의 부제용. (옛 general/test 도 포함.)
    var workNodeCount: Int { nodes.filter { $0.type == "task" || $0.type == "general" || $0.type == "test" }.count }
}

struct WorkflowsResponse: Codable {
    let workflows: [WorkflowSummary]
}

/// 워크플로우가 만든 세션 한 건 — GET /api/workflows/:id/sessions. 어느 노드가 만들었는지
/// (node_title)·그 노드 상태(node_status)를 함께 내려준다.
struct WorkflowSessionRow: Codable, Identifiable, Equatable {
    let id: String
    let title: String?
    let repo_path: String?
    let created_at: Int64
    let status: String
    let agent: String?
    let run_id: String?
    let node_title: String?
    let node_status: String?
}

struct WorkflowCreateResponse: Codable {
    let workflow: WorkflowSummary
}

/// 한 번의 실행 인스턴스.
struct WorkflowRunInfo: Codable, Identifiable, Equatable {
    let id: String
    let workflow_id: String?
    let status: String          // running | done | failed | cancelled
    let trigger_kind: String?
    let started_at: Int64
    let ended_at: Int64?
    /// fail 루프 재시도 상한 (GET /runs/:id 의 run 객체에만 — 목록 응답엔 없어 nil).
    let max_iterations: Int?
    /// «미해결» 신호 (workflow_attention_v1) — run 이 «진짜 결과 없이» 끝났는데 정상 «완료» 로 보이는
    /// 막다른 길. nil = 정상(표시 없음). "failed"(하드 실패)|"empty"(빈 결과)|"synthetic"(합성본 소비).
    /// GET /:id 의 runs 목록에만 실린다(GET /runs/:id 의 run 객체엔 없어 nil — 옛 daemon 도 nil).
    let attention_kind: String?
    /// 1 = 사용자가 확인/처리함 (배너에서 사라짐).
    let attention_ack: Int?

    init(
        id: String,
        workflow_id: String? = nil,
        status: String,
        trigger_kind: String? = nil,
        started_at: Int64,
        ended_at: Int64? = nil,
        max_iterations: Int? = nil,
        attention_kind: String? = nil,
        attention_ack: Int? = nil
    ) {
        self.id = id
        self.workflow_id = workflow_id
        self.status = status
        self.trigger_kind = trigger_kind
        self.started_at = started_at
        self.ended_at = ended_at
        self.max_iterations = max_iterations
        self.attention_kind = attention_kind
        self.attention_ack = attention_ack
    }
}

struct WorkflowDetailResponse: Codable {
    let workflow: WorkflowSummary
    let runs: [WorkflowRunInfo]
}

/// `GET /api/workflows/attention` 한 항목 (workflow_attention_v1) — 미해결 무인(cron/github) 실행 하나.
/// 최근 N건 페이징 너머의 실패도 여기엔 집계되므로 사용자가 «미해결이 있다» 를 놓치지 않는다.
struct WorkflowAttentionItem: Codable, Identifiable, Equatable {
    let run_id: String
    let workflow_id: String
    let workflow_title: String?
    /// "failed"(빨강) | "empty" | "synthetic" (둘 다 no란 «확인 필요»).
    let attention_kind: String
    let trigger_kind: String?
    let started_at: Int64?
    let ended_at: Int64?

    var id: String { run_id }
}

/// `GET /api/workflows/attention` — 모든 워크플로우에 걸친 미해결 무인 실행 집계.
struct WorkflowAttentionResponse: Codable {
    let total: Int
    let items: [WorkflowAttentionItem]
    /// 워크플로우별 미해결 수 (탭 행 배지용).
    let byWorkflow: [String: Int]?
}

struct WorkflowRunStartResponse: Codable {
    let runId: String
}

/// 노드별 실행 — 라이브 상태. 그래프 간선은 def_snapshot 의 edges 로 그리고, 상태는
/// def_node_id 로 매핑한다.
struct WorkflowNodeRun: Codable, Identifiable, Equatable {
    let id: String
    let def_node_id: String?
    let node_type: String
    let parent_node_run_id: String?
    let session_id: String?
    let title: String?
    let agent: String?
    let task_folder: String?
    let status: String          // pending|awaiting_approval|running|done|failed|needs_attention|skipped
    let verdict: String?
    let iteration: Int?
    /// 이번에 fail 루프로 되돌아간 사유 한 줄 (daemon verdict.json summary). 루프 밖이면 nil.
    let loopback_reason: String?
    /// 1 = 재시도 한도(max_iterations) 도달로 루프가 멈췄음.
    let limit_reached: Int?
    /// 결과물 출처 (workflow_attention_v1) — nil/"agent"(에이전트가 result.md 를 직접 남김)|
    /// "synthetic"(엔진이 터미널 출력으로 자동 합성)|"empty"(합성했으나 캡처가 사실상 빈 «빈 결과»).
    /// 합성본/빈 결과는 캔버스에서 정상 결과와 시각 구분(warning 배지)한다.
    let result_kind: String?
    let x: Double?
    let y: Double?
    let created_at: Int64
    let ended_at: Int64?
}

/// GET /api/workflows/runs/:id — 캔버스가 폴링하는 run 상태.
struct WorkflowRunStateResponse: Codable {
    let run: WorkflowRunInfo
    let nodes: [WorkflowNodeDef]
    let edges: [WorkflowEdgeDef]
    let nodeRuns: [WorkflowNodeRun]
}

/// 워크플로우 생성 요청. workflow 단위 repo 는 camelCase(repoPath) — daemon 라우트가 그렇게 읽는다.
struct CreateWorkflowRequest: Encodable {
    let title: String?
    let repoPath: String
    let nodes: [WorkflowNodeDef]
    let edges: [WorkflowEdgeDef]
    let enabled: Bool?
}

/// 「AI 초안」 요청 — «한 문장으로 설명» 을 daemon 설계 에이전트로 보낸다 (workflow_design_v1).
/// description/repoPath/agent 는 camelCase — daemon 라우트가 그렇게 읽는다 (CreateWorkflowRequest 와 동일 규약).
struct DesignWorkflowRequest: Encodable {
    let description: String
    let repoPath: String
    /// 설계 노드 기본 에이전트 (생략 시 daemon 기본 claude_code).
    let agent: String?
    /// 산출 언어 (po_locale_v1) — 설계 프롬프트를 앱 언어로. 기본은 앱 표시 언어.
    let locale: String? = ApiClient.appOutputLocale()
}

/// `POST /api/workflows/design` 응답 — 설계는 백그라운드라 designId(폴링 키) 만 즉시 돌려준다.
/// sessionId 로 설계 진행을 세션 탭에서 관전할 수 있다 (designId 와 동일 값).
struct WorkflowDesignStartResponse: Codable {
    let designId: String
    let sessionId: String
}

/// `GET /api/workflows/design/:id` 응답 — 폴링 상태. status: designing/ready/failed.
/// ready 면 nodes/edges 가 채워진 «초안»(validateDef 통과). failed 면 error 사유.
struct WorkflowDesignStateResponse: Codable {
    let status: String          // designing | ready | failed
    let nodes: [WorkflowNodeDef]?
    let edges: [WorkflowEdgeDef]?
    let error: String?
    let sessionId: String?
}

/// 「출발 템플릿」 — `GET /api/workflows/templates` 가 내려주는 노드/간선 프리셋 한 개
/// (workflow_templates_v1). AI 초안과 달리 «즉시·결정적» 이라 에이전트 spawn 없이 바로 캔버스에
/// 시드된다. 노드 «제목»·템플릿 «이름/설명» 같은 화면 노출 문자열은 클라가 카탈로그로 지역화하므로
/// (WorkflowTemplateCatalog), 여기 nodes[].title 의 한국어 원문은 폴백일 뿐이다. id 가 의미 키.
struct WorkflowTemplate: Codable, Identifiable, Equatable {
    let id: String
    let nodes: [WorkflowNodeDef]
    let edges: [WorkflowEdgeDef]
}

struct WorkflowTemplatesResponse: Codable {
    let templates: [WorkflowTemplate]
}

/// 템플릿/노드 «화면 노출» 문자열의 클라 지역화 — daemon 은 안정적 id(template id·node id)만
/// 내려보내고, 표시 문자열은 여기서 카탈로그(Localizable.xcstrings)를 거쳐 로케일별로 그린다.
/// (daemon JSON 은 카탈로그를 안 거치므로, 노출 문자열을 daemon 한국어 원문에 의존하면 영어
/// 로케일에서도 한글이 새어 나간다 — 그래서 «의미 키» 만 받고 표시는 클라가 책임진다.)
enum WorkflowTemplateCatalog {
    /// 템플릿 표시 이름. 알 수 없는 id 는 원문 id 로 폴백(무회귀).
    static func displayName(_ templateId: String) -> String {
        switch templateId {
        case "role_pipeline": return String(localized: "역할 파이프라인")
        case "self_correcting_loop": return String(localized: "자기교정 루프")
        default: return templateId
        }
    }

    /// 템플릿 한 줄 설명.
    static func summary(_ templateId: String) -> String {
        switch templateId {
        case "role_pipeline":
            return String(localized: "기획 → 디자인 → 개발 → QA → 운영 순서로 역할별 전문 에이전트를 잇는 출발 템플릿이에요. QA 단계에서 사람 승인을 거쳐요.")
        case "self_correcting_loop":
            return String(localized: "생성 → 점검 순서로 만들고, 점검이 실패를 판정하면 생성으로 되돌아가 고치는 루프형 출발 템플릿이에요.")
        default: return ""
        }
    }

    /// 노드 표시 제목 — node id 가 역할 의미 키. 알 수 없는 id 는 daemon 이 준 title(fallback)을 쓴다.
    static func nodeTitle(_ nodeId: String, fallback: String?) -> String? {
        switch nodeId {
        case "start": return String(localized: "시작")
        case "plan": return String(localized: "기획")
        case "design": return String(localized: "디자인")
        case "dev": return String(localized: "개발")
        case "qa": return String(localized: "QA")
        case "ops": return String(localized: "운영")
        case "make": return String(localized: "생성")
        case "check": return String(localized: "점검")
        case "end": return String(localized: "종료")
        default: return fallback
        }
    }

    /// 템플릿 노드를 «표시용 제목» 으로 지역화해 복제한다(생성 직전). prompt/좌표/게이트는 그대로.
    static func localizedNodes(_ template: WorkflowTemplate) -> [WorkflowNodeDef] {
        template.nodes.map { n in
            WorkflowNodeDef(
                id: n.id,
                type: n.type,
                title: nodeTitle(n.id, fallback: n.title),
                agent: n.agent,
                repo_path: n.repo_path,
                prompt: n.prompt,
                result_spec: n.result_spec,
                check_command: n.check_command,
                skip_permissions: n.skip_permissions,
                requires_approval: n.requires_approval,
                triggers: n.triggers,
                x: n.x,
                y: n.y
            )
        }
    }
}
