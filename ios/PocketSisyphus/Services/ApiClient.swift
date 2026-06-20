import Foundation

/// daemon HTTP API 클라이언트.
/// - 모든 요청은 Tor SOCKS5 프록시 경유 (.onion 도메인은 평범한 DNS 안 거침)
/// - Bearer 토큰 인증

struct SessionSummary: Codable, Identifiable, Equatable, Hashable {
    let id: String
    let title: String?
    let repo_path: String
    let created_at: Int64
    let ended_at: Int64?
    let status: String
    /// 데스크탑 Claude Code 세션을 이어 받아 만들어진 경우 그 원본 jsonl UUID. 아닌 경우 nil.
    /// daemon 측이 resume context 를 식별하는 용도로 응답에 실어 보낸다. 구버전 daemon 호환을 위해 optional.
    let parent_sdk_session_id: String?
    /// 세션 생성 시 켠 "모든 권한 자동 승인" 플래그. SQLite 는 0/1 정수.
    /// 기존 row 는 마이그레이션 후 0. 응답이 누락된 경우(=구 daemon 호환)도 0 으로 본다.
    let skip_permissions: Int?
    /// 편의 — UI 분기용. nil/0 → false.
    var skipPermissions: Bool { (skip_permissions ?? 0) == 1 }
    /// 세션 runner 모드. daemon `sessions.mode` 컬럼 ("sdk" | "pty").
    /// 누락된 응답(=구 daemon) 은 "sdk" 로 본다.
    let mode: String?
    /// 편의 — UI 분기용. nil/"sdk" → false.
    var isPty: Bool { (mode ?? "sdk") == "pty" }
    /// 이 세션이 어떤 코드 에이전트로 spawn 됐는지 — daemon `sessions.agent` 컬럼.
    /// 누락 (구 daemon = multi_agent_v1 미지원) 시 nil — 호출처에서 "claude_code" 로 흡수.
    let agent: String?
    /// 세션 단위 알림 음소거 — 1 이면 이 세션의 Discord 알림이 발송되지 않는다.
    /// 누락 (구 daemon = session_notify_mute_v1 미지원) 시 nil → 켜짐(0) 으로 본다.
    let notify_muted: Int?
    /// 편의 — UI 분기용. nil/0 → false (알림 켜짐).
    var notifyMuted: Bool { (notify_muted ?? 0) == 1 }
    /// «보관됨» 플래그 (session_archive_v1) — 1 이면 기본 목록에서 숨기고 «보관함» 에서만 보인다.
    /// 완료/오래된 세션을 시야에서 치우는 용도. 누락(구 daemon = session_archive_v1 미지원) 시 nil
    /// → 미보관(false)으로 본다. 기본 목록(미보관만) 응답엔 늘 0 으로 실리고, «보관함» 응답엔 1.
    let archived: Int?
    /// 편의 — UI 분기용. nil/0 → false (미보관).
    var isArchived: Bool { (archived ?? 0) == 1 }
    /// 이 세션을 만든 워크플로우 실행 run id. non-nil 이면 «워크플로우가 만든 세션» 이라
    /// 세션 탭에서 숨기고 워크플로우 탭에서 따로 보여 준다. 일반 세션/구 daemon 은 nil.
    let workflow_run_id: String?
    var isWorkflowSession: Bool { workflow_run_id != nil }
    /// 이 세션을 낳은 «출처 브리프» (po_provenance) — PO 루프에서 브리프 승인/기각/수정/수집이
    /// 세션을 spawn 한 경우 그 브리프의 식별·표시 정보. 일반 세션(브리프 출처 없음)·구 daemon
    /// 응답은 nil → ChatView 가 출처 칩을 그리지 않는다. daemon 이 session→brief 역참조로 채운다
    /// (출처 «데이터 노출» 자체는 의존 브리프의 몫 — 여기선 받은 값을 소비/표시만 한다).
    let source_brief: SourceBriefRef?
    /// 에이전트가 «사용자 입력을 기다리기 시작한» 시각 (epoch ms). 대기 아님/구 daemon 은 nil.
    /// 세션 목록의 «입력 대기» 배지 + 대기 우선 정렬, 채팅 대기 배너의 초기값에 쓴다 (triage).
    let waiting_since: Int64?
    /// 편의 — UI 분기용.
    var isAwaitingUser: Bool { waiting_since != nil }
    /// 대기 세션이 «지금 무엇을 묻고 멈췄는지» 한~두 줄 미리보기 (에이전트 raw 출력 tail 에서
    /// ANSI 제거 + chrome 제외해 daemon 이 추출). 대기 아님/추출 불가(스피너뿐)/구 daemon 은 nil.
    /// 내용은 에이전트 출력이라 번역 대상이 아니다 — 카드/다이얼로그에서 Text(verbatim:) 로 그린다.
    let pending_prompt_preview: String?
    /// 편의 — 공백만이거나 빈 미리보기는 «없음» 으로 본다 (카드가 빈 줄을 그리지 않게).
    var pendingPromptPreview: String? {
        guard let p = pending_prompt_preview?.trimmingCharacters(in: .whitespacesAndNewlines),
              !p.isEmpty else { return nil }
        return p
    }

    // MARK: - 대기 추정 근거 (휴리스틱 false-negative 를 사람이 메우는 신호)
    // 12초 idle 휴리스틱이 «대기» 로 못 잡은 조용한 세션을 폰에서 식별/구독하게 한다. 모두
    // 활성 PTY 메모리 신호라 비활성(종료/dead)·구 daemon 응답에선 nil → UI 가 표시/토글을 비활성.

    /// 마지막 PTY 출력 시각 (epoch ms). 「조용함 N분」 을 라이브로 계산하는 기준 — 조용한 동안엔
    /// 값이 고정돼 있다가 새 출력이 흐르면 갱신된다(도구 연쇄로 출력이 흐르면 idle 이 0 으로 리셋).
    /// (daemon 은 보조로 `idle_ms` 스냅샷도 싣지만, 라이브 계산은 이 절대시각으로 하므로 조용한
    /// 세션의 Equatable 이 매 폴링 흔들리지 않는다 — 디코딩 시 모르는 키는 무시된다.)
    let last_activity: Int64?
    /// 발사된 응답 대기 리마인더 단계 (0=아직, N=리마인더 N회 발사됨). 헛알림 판단의 근거.
    let waiting_reminder_idx: Int?
    /// 「다음 정지 시 알림」 수동 구독 무장 여부. 발사(소진)되면 daemon 이 false 로 되돌린다.
    let notify_next_stop: Bool?
    /// 편의 — UI 분기용. nil/false → 꺼짐.
    var notifyNextStop: Bool { notify_next_stop ?? false }

    /// 마지막 활동 시각 Date — 활성 PTY 가 아니면 nil.
    var lastActivityDate: Date? {
        last_activity.map { Date(timeIntervalSince1970: TimeInterval($0) / 1000) }
    }

    /// 지금 기준 «조용함» 경과 초. 활성 PTY 가 아니면 nil. 음수는 0 으로 클램프.
    var quietSeconds: Int? {
        guard let d = lastActivityDate else { return nil }
        return max(0, Int(Date().timeIntervalSince(d)))
    }

    // MARK: - 오케스트레이션 상태 (실행중/대기/완료)
    // «여러 에이전트 팀» 을 한 화면에서 triage 하기 위한 파생 신호다. 별도 상태 컬럼을
    // 새로 두지 않고, 이미 daemon 이 실어 보내는 신호(waiting_since·ended_at·status)에서
    // 파생한다 — 대기 신호는 기존 「입력 대기」 배지와 «같은» waiting_since 를 재사용한다
    // (상태 판정을 두 곳에서 중복 구현하지 않는다).

    /// 세션의 오케스트레이션 상태. 우선순위: 완료(ended_at/완료/오류) > 대기(waiting_since) > 실행중.
    var runState: SessionRunState {
        if ended_at != nil || status == "completed" || status == "error" { return .done }
        if isAwaitingUser { return .waiting }
        return .running
    }

    /// worktree 세션이면 그 브랜치 slug. daemon 은 worktree 를 `<repoName>.worktrees/<slug>`
    /// 규칙으로 만들므로(`git/worktree.ts`), repo_path 끝의 폴더명이 곧 브랜치(slug)다. 이
    /// 명명 규칙을 역이용해 git 추가 조회 없이 «브랜치 배지» 를 즉시 얻는다 (모바일·Tor 비용 0).
    var worktreeBranchSlug: String? {
        let comps = repo_path.split(separator: "/").map(String.init)
        guard let wi = comps.lastIndex(where: { $0.hasSuffix(".worktrees") }),
              wi + 1 < comps.count else { return nil }
        let slug = comps[wi + 1]
        return slug.isEmpty ? nil : slug
    }

    /// worktree 격리 안에서 도는 세션인지 — 브랜치 배지/그룹 표시 분기용.
    var isWorktreeSession: Bool { worktreeBranchSlug != nil }

    /// 「마지막 turn 시각」 추정 (epoch ms). 전용 저장 필드가 없어 «있는 신호 중 가장 최근» 을
    /// 쓴다: 대기 시작(waiting_since) > 종료(ended_at) > 생성(created_at). 대기 세션은
    /// waiting_since 가 곧 «턴이 끝나 나를 기다리기 시작한» 시각이라 의미가 맞아떨어진다.
    var lastActivityAt: Int64 {
        waiting_since ?? ended_at ?? created_at
    }
}

/// 세션을 낳은 출처 브리프의 최소 표시 정보 (po_provenance). ChatView 의 출처 칩이 제목+종류를
/// 보여주고, 탭하면 `pocketsisyphus://backlog/<id>` 딥링크로 브리프 상세로 점프한다. 종류별
/// 라벨은 `SourceBriefKind`. daemon 응답이 이 객체를 실어 보내면 칩이 뜨고, 없으면(일반 세션·
/// 구 daemon) nil → 칩 미표시.
struct SourceBriefRef: Codable, Equatable, Hashable {
    /// 출처 브리프 id — 딥링크 `backlog/<id>` 의 path. 목록에 있으면 상세로 push, 삭제됐으면 no-op.
    let id: String
    /// 표시용 제목. 누락 시 종류 라벨만 노출.
    let title: String?
    /// 출처 종류 raw — "implement"|"cleanup"|"revise"|"collect". 알 수 없는/구 daemon 값은 .unknown.
    let kind: String?
    /// UI 분기용 — raw 를 의미 enum 으로.
    var briefKind: SourceBriefKind { SourceBriefKind(raw: kind) }
}

/// 세션을 낳은 브리프의 «출처 종류» — 어떤 PO 동작이 이 세션을 만들었는지 칩 라벨로 구분.
/// (워크플로우 run 출처는 스코프 제외 — 별도 워크플로우 탭이 담당.)
enum SourceBriefKind {
    case implement  // 승인 → 구현 (exec)
    case cleanup    // 기각 → 코드 흔적 정리
    case revise     // 수정 지시 재종합
    case collect    // 신호 수집
    case unknown    // 미상/구 daemon

    init(raw: String?) {
        switch raw {
        case "implement", "exec": self = .implement
        case "cleanup": self = .cleanup
        case "revise", "revising", "resynthesize": self = .revise
        case "collect": self = .collect
        default: self = .unknown
        }
    }

    /// localize 된 종류 라벨 (10개 언어 카탈로그). 미상은 중립 «출처» 로 폴백.
    var label: String {
        switch self {
        case .implement: return String(localized: "구현")
        case .cleanup: return String(localized: "정리")
        case .revise: return String(localized: "재종합")
        case .collect: return String(localized: "수집")
        case .unknown: return String(localized: "출처")
        }
    }
}
/// triage 하기 위한 파생 enum (SessionSummary.runState 가 기존 신호에서 계산).
enum SessionRunState: String, CaseIterable, Hashable {
    case waiting   // 에이전트가 내 입력을 기다리는 중 — 가장 먼저 봐야 할 것
    case running   // 에이전트가 일하는 중
    case done      // 끝남 (완료/오류)
}

struct SessionsResponse: Codable {
    let sessions: [SessionSummary]
}

/// 토큰 잔량의 한 윈도우 — daemon `agent/types.ts` 의 `AgentUsageWindow` 와 1:1.
/// 라벨 (5시간/주간) 매핑은 windowMinutes 로 클라이언트가 한다 (i18n).
struct AgentUsageWindow: Codable, Equatable {
    let id: String
    /// 윈도우 길이 (분). 300=5시간, 10080=주간. 모르면 nil.
    let windowMinutes: Int?
    /// 사용률 0~100 (%). 잔량 = 100 - usedPercent.
    let usedPercent: Double
    /// 리셋 시각 (epoch ms). 모르면 nil.
    let resetsAt: Int64?
}

/// GET /api/sessions/:id/usage 응답 — daemon `agent/usage.ts` 의 `AgentUsageResponse` 와 1:1.
/// supported:false = 이 agent 는 토큰 개념 없음/조회 경로 없음 (shell/agy) → UI 통째로 숨김.
/// supported:true + error = 지원 agent 의 일시 실패 (키체인/네트워크) → «조회 불가» 표시.
struct AgentUsageResponse: Codable, Equatable {
    let supported: Bool
    let windows: [AgentUsageWindow]
    /// 데이터 기준 시각 (epoch ms). codex 는 마지막 turn 스냅샷이라 과거일 수 있음.
    let fetchedAt: Int64?
    let error: String?
}

struct CreateSessionRequest: Codable {
    let repoPath: String
    let title: String?
    /// 데스크탑 세션을 이어 받을 때 그 UUID (claude jsonl uuid / agy conversationId 등 —
    /// adapter 가 자기 모양의 인자로 변환). nil 이면 새 세션.
    let resumeFrom: String?
    /// true 면 daemon 이 sessions.skip_permissions=1 로 저장 → 매 turn 마다
    /// permissionMode=bypassPermissions 자동 적용. 한 번 결정되면 영구.
    let skipPermissions: Bool?
    /// runner 모드 — "sdk" | "pty". 누락 시 daemon 기본 "sdk".
    /// 2026-06 청구 변경 대응으로 iOS 는 신규 세션을 항상 "pty" 로 만든다 (PTY 모드는 daemon 내
    /// `--dangerously-skip-permissions` 강제 등가 → skipPermissions 도 함께 true 송신).
    let mode: String?
    /// 어떤 코드 에이전트 CLI 로 spawn 할지 — "claude_code" | "agy" | …
    /// nil 이면 daemon default (claude_code). 옛 daemon (multi_agent_v1 미지원) 은
    /// 이 필드를 무시.
    let agent: String?
}

struct CreateSessionResponse: Codable {
    let sessionId: String
}

/// 어떤 코드 에이전트의 데스크탑 세션 한 개의 요약 (이어받기 picker 의 한 row).
///
/// 옛 `ClaudeCodeSession` 을 generic 으로 일반화 — claude 는 jsonl 파싱으로 preview/
/// turnCount 가 항상 채워지지만, agy 는 사용자 입력 history.jsonl 만 보고 만들므로 둘 다
/// nullable. UI 가 nil 일 때 "(미리보기 없음)" / "?턴" 같은 fallback 으로 표시.
///
/// gitBranch 는 claude jsonl 에는 있고 agy 엔 없으므로 nullable. live 필드는 SwiftTerm
/// 통합 후 라이브 관전 기능이 폐기되어 제거됨.
struct DesktopSession: Codable, Identifiable, Equatable {
    let sessionId: String
    let repoPath: String
    let preview: String?
    let turnCount: Int?
    let lastActiveAt: Int64
    let startedAt: Int64?
    let gitBranch: String?

    var id: String { sessionId }
}

struct DesktopSessionsResponse: Codable {
    let sessions: [DesktopSession]
}


/// 서버가 messages 테이블 한 행을 그대로 돌려준 형태.
struct MessageRow: Codable, Identifiable, Equatable {
    let id: String
    let role: String          // "user" | "assistant" | "tool" | "system"
    let type: String          // SDK 이벤트 타입 ("user_message", "assistant", "user", "result", ...)
    let payload: String       // JSON string (SDK 이벤트 원형 또는 우리 합성 이벤트)
    let created_at: Int64
}

struct SessionDetailResponse: Codable {
    let session: SessionSummary
    let messages: [MessageRow]
}

/// `/api/sessions/:id/poll` 응답. PTY 단일 모드라 한 RTT 로 messages 증분만 받아온다.
struct SessionPollResponse: Codable {
    let session: SessionSummary
    let messages: [MessageRow]          // 증분이면 after 이후, 콜드+limit 이면 최신 tail(ASC)
    let nextCreatedAt: Int64            // 다음 poll 에 보낼 afterCreatedAt
    // ── 아래는 session_history_v1 (옛 daemon 은 미전송 → 옵셔널 decode) ──
    /// tail 캡으로 잘려 더 오래된 메시지가 있는가 (콜드만 true 가능).
    let hasMoreBefore: Bool?
    /// 이번 페이지 가장 오래된 행 — 역방향 히스토리 keyset 커서.
    let oldestCreatedAt: Int64?
    let oldestId: String?
}

/// `GET /:id/messages` — 역방향 keyset 히스토리 한 페이지 (session_history_v1).
struct MessageHistoryResponse: Codable {
    let messages: [MessageRow]          // ASC (오래된 → 최신)
    let hasMoreBefore: Bool
    let oldestCreatedAt: Int64?
    let oldestId: String?
}

/// `GET /:id/pty/snapshot` — 헤드리스 VT 가 재구성한 PTY 화면 스냅샷 (pty_snapshot_v1).
struct PtySnapshotResponse: Codable {
    /// fresh 터미널(콜드 SwiftTerm)에 그대로 feed 하면 화면+scrollback 이 복원되는 직렬화 ANSI.
    let snapshot: String
    let cols: Int
    let rows: Int
    /// 이 스냅샷에 반영된 마지막 pty_chunk 의 created_at — 이후를 증분으로 잇는 watermark.
    let throughCreatedAt: Int64
    /// tail 캡으로 더 오래된 청크가 잘렸는가 (정보용).
    let truncated: Bool
}

struct RecentProject: Codable, Identifiable, Equatable {
    let path: String
    let lastUsedAt: Int64
    let sessionCount: Int

    var id: String { path }
}

struct RecentProjectsResponse: Codable {
    let projects: [RecentProject]
}

struct SendMessageRequest: Codable {
    let text: String
}

/// 한 파일의 git 변경 요약 — daemon `git status --porcelain=v1 -z` 의 한 entry.
/// `status` 는 두 글자 (X=index, Y=worktree). 일반 modified 는 " M", staged add 는 "A ", untracked 는 "??" 등.
struct GitStatusFile: Codable, Identifiable, Equatable, Hashable {
    let path: String
    let status: String
    let additions: Int
    let deletions: Int
    let binary: Bool
    /// rename / copy 의 원본 경로. 그 외에는 nil.
    let origPath: String?

    var id: String { path }

    /// 가장 의미 있는 한 글자 상태. 디스플레이 뱃지/색에 쓴다.
    /// 우선순위: untracked('?') > deleted('D') > renamed('R') > added('A') > modified('M').
    var primaryStatus: Character {
        if status == "??" { return "?" }
        for ch in status where ch != " " {
            if ch == "D" { return "D" }
            if ch == "R" { return "R" }
            if ch == "A" { return "A" }
            if ch == "M" { return "M" }
            return ch
        }
        return "?"
    }
}

struct GitStatusResponse: Codable, Equatable {
    let files: [GitStatusFile]
    let total: Int
}

/// 가상 키보드 한 키 — REPL 다항 선택 wizard 제어용. daemon 의 화이트리스트와 짝.
/// space / enter 는 시스템 소프트 키보드의 동일 키가 PTY 로 직접 흐르므로 별도 가상
/// 버튼이 필요 없어 statusBar 에서 제거됨 (2026-05) — enum case 도 같이 정리.
enum PtyKey: String {
    case up
    case down
    case left
    case right
    // copilot 같은 alt-screen TUI 본문 스크롤 — daemon 이 SGR 휠 이벤트로 변환해 PTY 에 주입.
    case scrollUp = "scroll_up"
    case scrollDown = "scroll_down"
}

/// 세션 일괄 제어 액션 — 세션 목록 그룹 헤더의 «모두 승인» / «모두 중지» 가 보내는 의미 키.
/// daemon 이 각각 Enter(권한 prompt 기본 선택 확정) / ESC(진행 turn 중단) byte 로 PTY 에 흘린다
/// (채팅방의 같은 키와 동치 — PTY 는 죽이지 않음). `bulk_session_actions_v1` capability 필요.
enum PtyControlAction: String {
    case approve   // Enter — 권한 prompt 의 기본 강조 선택지(보통 «예») 확정
    case interrupt // ESC — 진행 중인 turn 중단
}

/// 세션 일괄 보관/삭제 액션 (session_archive_v1) — POST /api/sessions/bulk 가 받는 의미 키.
/// archive=기본 목록에서 숨김(비파괴), unarchive=복구, delete=완전 삭제(파괴적, 확인 다이얼로그).
enum BulkSessionAction: String {
    case archive
    case unarchive
    case delete
}

struct GitFileDiffResponse: Codable, Equatable {
    let path: String
    /// unified diff 본문. binary 거나 untracked 이며 본문이 비어 있을 수 있다.
    let diff: String
    let binary: Bool
    /// daemon 측에서 본문이 cap (200KB) 을 넘어 잘렸음 — UI 가 안내 메시지로 알림.
    let truncated: Bool
    let untracked: Bool
}

/// 한 브랜치 — daemon `GET /git/branches` 의 local/remote 한 항목.
/// 원격 브랜치(remote)는 `name` 이 "origin/foo" 형태, `upstream` 은 nil.
struct GitBranch: Codable, Identifiable, Equatable, Hashable {
    let name: String
    let sha: String
    /// 로컬 브랜치의 추적 대상 (예: "origin/main"). 없으면 nil.
    let upstream: String?
    /// 마지막 커밋 제목 (한 줄). 비어 있을 수 있음.
    let subject: String
    /// 현재 체크아웃된 브랜치인지 (remote 는 항상 false).
    let current: Bool

    var id: String { name }
}

struct GitBranchesResponse: Codable, Equatable {
    /// 현재 브랜치명 (detached 면 "@sha", 비-repo 면 nil).
    let current: String?
    let local: [GitBranch]
    let remote: [GitBranch]
}

/// 한 worktree — daemon `GET /git/worktrees` 의 한 항목.
struct GitWorktree: Codable, Identifiable, Equatable, Hashable {
    /// 절대 경로 (git 이 보고하는 realpath). 삭제 시 그대로 다시 daemon 에 넘긴다.
    let path: String
    /// 체크아웃된 브랜치명. detached / bare 면 nil.
    let branch: String?
    /// HEAD sha. nil 일 수 있음.
    let head: String?
    /// 메인 worktree 인지 (삭제 불가).
    let isMain: Bool
    /// 현재 세션의 repo_path 가 위치한 worktree 인지 (삭제 불가).
    let isCurrent: Bool
    let locked: Bool
    let prunable: Bool

    var id: String { path }
}

struct GitWorktreesResponse: Codable, Equatable {
    let worktrees: [GitWorktree]
}

/// 머지 큐 한 건 — daemon `/api/merge-queue` 의 한 항목 (merge_queue_v1). 작업 브랜치를
/// main/release 로 합치는 «재결합» 요청. status 전이: queued → processing → merged/conflict/failed.
/// 충돌하면 그 항목만 보류되고 나머지는 계속 처리된다(직렬 큐).
struct MergeRequest: Codable, Identifiable, Equatable, Hashable {
    let id: String
    let repoPath: String
    let sourceBranch: String
    let targetBranch: String
    let sessionId: String?
    let cleanup: Bool
    let noFF: Bool
    /// "queued" | "processing" | "merged" | "conflict" | "failed" | "cancelled".
    let status: String
    /// 성공 종류 — "up_to_date" | "fast_forward" | "merged".
    let result: String?
    let mergeCommit: String?
    /// 충돌 파일 (status="conflict" 일 때). 내용은 git 파일경로라 번역 대상 아님 → verbatim 표시.
    let conflictFiles: [String]
    /// 실패/충돌 사람 가독 메시지 (daemon 산출 — verbatim 표시).
    let error: String?
    let createdAt: Int64
    let updatedAt: Int64
    let startedAt: Int64?
    let endedAt: Int64?
}

/// 큐 상태 요약 — daemon 이 레포 스코프로 집계.
struct MergeQueueCounts: Codable, Equatable {
    let queued: Int
    let processing: Int
    let conflict: Int
    let failed: Int
    let merged: Int
    let cancelled: Int
    let total: Int
}

struct MergeQueueResponse: Codable, Equatable {
    let requests: [MergeRequest]
    let counts: MergeQueueCounts
}

/// 머지 사전 «읽기 전용» 충돌 탐지 결과 — daemon `POST /api/merge-queue/preview`.
/// repo 를 절대 변경하지 않는다. enqueue 전에 충돌 여부·관계를 미리 보여줄 때 쓴다.
struct MergePreview: Codable, Equatable {
    /// source→target 관계: "up_to_date" | "fast_forward" | "diverged" | "unrelated".
    let relation: String
    /// 충돌 여부 (diverged 일 때만 의미 — 나머지는 항상 false).
    let conflict: Bool
    /// 충돌 파일 (best-effort, git 산출물이라 번역 대상 아님 → verbatim 표시).
    let conflictFiles: [String]
    let sourceSha: String?
    let targetSha: String?
}

/// 세션 없이 repoPath 로 조회한 git 상태 — daemon `GET /api/git/info`.
/// 새 세션 스크린이 «worktree 섹션을 보여줄지» 판단하는 데 쓴다. branch 는 정보용
/// (detached / unborn HEAD 면 nil).
struct RepoGitInfo: Codable, Equatable {
    let isRepo: Bool
    let branch: String?
}

/// 한 커밋 — daemon `GET /git/commits` 의 한 항목. CommitsView 리스트 행.
struct GitCommit: Codable, Identifiable, Equatable, Hashable {
    /// 전체 sha — 상세/diff 조회 시 그대로 넘긴다.
    let sha: String
    /// 짧은 sha — 화면 표시용.
    let shortSha: String
    let author: String
    /// author date — strict ISO-8601 (예 "2026-06-02T10:02:28+09:00"). UI 가 상대시간으로 포맷.
    let date: String
    /// 커밋 제목 (첫 줄).
    let subject: String

    var id: String { sha }

    /// 앱이 만든 체크포인트 커밋인지 — 식별 prefix 로 판별(daemon `CHECKPOINT_PREFIX` 와 동일).
    /// true 인 항목에만 «이 시점으로 되돌리기» 동작을 노출한다.
    var isCheckpoint: Bool { subject.hasPrefix("checkpoint(ps):") }
}

struct GitCommitsResponse: Codable, Equatable {
    let commits: [GitCommit]
    /// 이 페이지 개수(전체 카운트 아님). limit 만큼 오면 더 있다고 보고 «더 보기» 를 띄운다.
    let total: Int
}

/// 한 커밋 상세 — 메타 + 변경 파일 목록(`GitStatusFile` shape 재사용).
struct GitCommitDetail: Codable, Equatable {
    let sha: String
    let shortSha: String
    let author: String
    let date: String
    let subject: String
    /// 커밋 메시지 본문(제목 이후). 없으면 빈 문자열.
    let body: String
    let files: [GitStatusFile]
}

/// 체크포인트 생성 결과 — daemon `POST /git/checkpoint` 응답.
struct GitCheckpointResult: Decodable, Equatable {
    let sha: String
    let shortSha: String
    /// 만들어진 커밋 제목(식별 prefix 포함).
    let subject: String
}

/// 되돌리기 결과 — daemon `POST /git/rollback` 응답.
struct GitRollbackResult: Decodable, Equatable {
    /// "revert"(비파괴) 또는 "reset"(파괴).
    let mode: String
    /// 되돌리기 직전 만든 자동 체크포인트 sha — 복구 지점. autoCheckpoint 생략 시 nil.
    let autoCheckpointSha: String?
    let autoCheckpointShortSha: String?
    /// 되돌린 뒤 HEAD.
    let resultSha: String
    let resultShortSha: String
}

/// git mutating 동작 실패 — daemon 의 4xx 응답(`{ error, message? }`)을 사람이 읽을 수 있게
/// 매핑. message(보통 git stderr)가 있으면 그걸 우선 노출하고(원인이 가장 정확), 없으면
/// error 코드별 localize 된 안내문으로 fallback 한다.
struct GitOperationError: LocalizedError {
    let code: String
    let message: String?

    var errorDescription: String? {
        if let message, !message.isEmpty { return message }
        switch code {
        case "invalid_branch", "invalid_from":
            return String(localized: "브랜치 이름이 올바르지 않아요.")
        case "checkout_failed":
            return String(localized: "브랜치를 전환할 수 없어요. 변경사항을 먼저 커밋하거나 정리해 주세요.")
        case "branch_failed":
            return String(localized: "브랜치를 만들 수 없어요.")
        case "branch_delete_failed":
            return String(localized: "브랜치를 삭제할 수 없어요.")
        case "cannot_delete_current":
            return String(localized: "지금 사용 중인 브랜치는 삭제할 수 없어요.")
        case "worktree_add_failed":
            return String(localized: "worktree를 만들 수 없어요.")
        case "worktree_remove_failed":
            return String(localized: "worktree를 삭제할 수 없어요.")
        case "target_exists":
            return String(localized: "이미 같은 이름의 worktree가 있어요.")
        case "cannot_remove_main":
            return String(localized: "메인 worktree는 삭제할 수 없어요.")
        case "cannot_remove_current":
            return String(localized: "지금 사용 중인 worktree는 삭제할 수 없어요.")
        case "not_a_worktree":
            return String(localized: "worktree를 찾을 수 없어요.")
        case "checkpoint_failed", "auto_checkpoint_failed":
            return String(localized: "체크포인트를 만들 수 없어요.")
        case "revert_failed":
            return String(localized: "되돌리기에 실패했어요. 충돌이 있으면 변경을 정리한 뒤 다시 시도해 주세요.")
        case "reset_failed":
            return String(localized: "이 시점으로 되돌릴 수 없어요.")
        case "invalid_mode":
            return String(localized: "되돌리기 방식이 올바르지 않아요.")
        default:
            return String(localized: "작업을 완료하지 못했어요.")
        }
    }
}

/// 파일 브라우저의 한 entry — 디렉토리 또는 파일.
/// daemon `/api/sessions/:id/fs/list` 응답의 한 row.
struct DirectoryEntry: Codable, Identifiable, Equatable, Hashable {
    let name: String
    let isDirectory: Bool
    /// 파일 size (bytes). 디렉토리는 0.
    let size: Int64
    /// mtime epoch ms.
    let modifiedAt: Int64
    var id: String { name }
}

/// 한 디렉토리의 listing 응답.
struct DirectoryListing: Codable, Equatable {
    /// repo-relative 경로. 루트면 "".
    let path: String
    /// 상위 경로 (repo-relative). 루트면 nil, 한 단계 위가 루트면 "".
    let parent: String?
    let entries: [DirectoryEntry]
}

/// 업로드된 첨부 이미지 한 개의 저장 결과 (`POST /:id/attachments` 응답의 한 row).
struct SavedAttachment: Codable, Equatable {
    /// repo-relative 저장 경로 (예: "attachments/photo.jpg"). 프롬프트에서 이 경로를 참조한다.
    let rel: String
    /// 절대 경로 (진단/로깅용).
    let abs: String
    /// 저장된 바이트 수.
    let bytes: Int
}

/// 파일 한 건의 본문 — fs/file 또는 git/blob 응답.
/// encoding 이 "utf8" 면 content 는 그대로 텍스트, "base64" 면 디코드해야 함.
struct FileContent: Codable, Equatable {
    let path: String
    /// git blob 응답일 때 채워지는 ref ("HEAD" 등). fs/file 이면 nil.
    let ref: String?
    /// 원본 크기 (bytes). truncated=true 면 content 는 이보다 짧다.
    let size: Int64
    /// "utf8" | "base64".
    let encoding: String
    /// MIME — "text/plain" / "image/png" / "application/octet-stream" 등.
    let contentType: String
    let content: String
    let truncated: Bool

    var isText: Bool { encoding == "utf8" }
    var isImage: Bool { contentType.hasPrefix("image/") }
}

/// PO 루프 — 기회 브리프의 근거 한 줄. daemon `po/prompt.ts` 의 evidence 계약과 1:1.
struct PoEvidence: Codable, Equatable, Hashable {
    let kind: String     // "github_issue" | "repo_todo" | "code_comment" | "git_log" | "doc" | …
    let ref: String      // 확인 가능한 참조 (이슈 번호/URL, 파일:라인, sha)
    let summary: String  // 이 근거가 말하는 것 한 줄
}

/// PO 루프 — 기회 브리프 한 건. daemon `routes/po.ts` 의 toApi() 와 1:1.
/// status 전이: proposed → approved(즉시 running) | held | rejected,
/// running → shipped(구현 turn 정착) → verified|missed(출시 후 검증 — 다음 수집이 가설 대조).
struct PoBrief: Codable, Identifiable, Equatable, Hashable {
    let id: String
    let repoPath: String
    let title: String
    let problem: String
    let evidence: [PoEvidence]
    let impact: Int          // 1~5
    let effort: Int          // 1~5
    let score: Double        // impact/effort — 백로그 정렬 키
    let scope: String
    let spec: String
    let status: String
    let createdAt: Int64
    let updatedAt: Int64
    let decidedAt: Int64?
    /// 보류/기각 사유 태그 (po_decide_reason_v1) — 고정 enum 키. 미선택/구 daemon 응답은 nil.
    let decideReason: String?
    /// 결재 사유 자유 메모 (선택) — 태그를 보완하는 한 줄. 없으면 nil.
    let decideNote: String?
    let collectSessionId: String?
    let execSessionId: String?
    /// «수정 지시» 재종합 진행 중 세션 — non-nil 이면 «재종합 중» 배지. 구 daemon 응답엔 없음.
    let revisingSessionId: String?
    /// 이 브리프를 만든 리서치(po_research) — 상세에서 보고서 역추적. 수집産은 nil.
    let researchId: String?
    /// 출시 후 검증의 판정 사유 한 줄 — verified/missed 에서만. 구 daemon 응답엔 없음.
    let verifyNote: String?
    /// 기각 후 «코드 흔적 정리» 세션 (po_cleanup_v1) — non-nil 이면 «정리 세션 보기» 진입점.
    /// 구 daemon 응답엔 없음 → nil.
    let cleanupSessionId: String?
    /// «워크플로우로 실행» 승인이 만든 워크플로우/run (po_workflow_v1) — 상세의 진행 표시 +
    /// 캔버스 진입점. 세션 모드 승인/구 daemon 응답엔 없음 → nil.
    let execWorkflowId: String?
    let execRunId: String?
    /// 워크플로우 경로 메모 — AI 설계 실패 fallback / 게이트 거부 / run 실패의 원인 추적.
    let execNote: String?
    /// 구현 에이전트 ID (po_agent_echo_v1) — approve 응답과 브리프 목록에 포함. 구 daemon 응답엔
    /// 없음 → nil (에이전트 칩 숨김, 불일치 경고도 숨김).
    let execAgentId: String?
    /// 정리 에이전트 ID (po_agent_echo_v1) — cleanup 응답과 브리프 목록에 포함. 구 daemon 응답엔
    /// 없음 → nil.
    let cleanupAgentId: String?
}

/// 일괄 결재 (po_bulk_decide_v1) 에서 «적용 못 한» 한 건. reason="not_found"(사라짐) |
/// "already_decided"(그새 결재됨). 부분 성공 — 트리아지 중 일부가 바뀌어도 나머지는 처리된다.
struct PoBulkSkip: Codable, Equatable {
    let id: String
    let reason: String
}

/// PO 루프 — 한 «차원 값» 의 결재 분해 한 칸 (po_stats_breakdown_v1). daemon byEffort/byEvidence/byLens
/// 의 셀과 1:1. approved 는 «승인된 적 있는» 수, rejected 는 기각 수 — 둘의 합이 그 칸의 결재 수.
struct PoStatsCell: Codable, Equatable {
    let approved: Int
    let rejected: Int
    /// 이 칸에서 결재(승인+기각)가 끝난 수 — 률의 분모.
    var decided: Int { approved + rejected }
    /// 기각률 = rejected / decided. 결재가 없으면 nil (0% 와 «데이터 없음» 구분).
    var rejectionRate: Double? { decided > 0 ? Double(rejected) / Double(decided) : nil }
}

/// PO 루프 — 한 «차원 값» 의 출시 후 검증 결과 분해 (po_outcome_breakdown_v1). verified/missed 만.
struct PoOutcomeCell: Codable, Equatable {
    let verified: Int
    let missed: Int
    /// 이 칸에서 검증이 끝난 수 — 률의 분모 (shipped 직후 제외).
    var completed: Int { verified + missed }
    /// 빗나감률 = missed / (verified + missed). 검증 건수가 0이면 nil (0% 와 «데이터 없음» 구분).
    var missedRate: Double? { completed > 0 ? Double(missed) / Double(completed) : nil }
}

/// PO 루프 — 누적 성적표의 레포 한 칸. daemon `GET /api/po/stats` 의 repos 항목과 1:1 (po_stats_v1).
/// approved 는 «승인된 적 있는» 수 (running/shipped/verified/missed 포함) — 승인율의 분자.
struct PoRepoStats: Codable, Equatable {
    let repoPath: String
    let proposed: Int
    let approved: Int
    let rejected: Int
    let shipped: Int
    let verified: Int
    let missed: Int
    /// approved / (approved + rejected). 결정이 없으면 nil — 0% 와 «데이터 없음» 을 구분.
    let approvalRate: Double?
    /// 제안 → 결재까지 걸린 시간의 중앙값(초). 결정 시각 없는 과거 브리프는 제외 — 없으면 nil.
    let medianDecisionSeconds: Double?
    /// 노력(effort) 구간별 결재 분해 (po_stats_breakdown_v1) — "low"(1~2)·"mid"(3)·"high"(4~5).
    /// 구 daemon 응답엔 키 자체가 없음 → nil (분해 섹션 숨김).
    let byEffort: [String: PoStatsCell]?
    /// 근거(evidence) 종류별 결재 분해 — kind 가 키. 구 daemon 엔 없음 → nil.
    let byEvidence: [String: PoStatsCell]?
    /// 리서치 «전문가 관점»(lens)별 결재 분해 — 리서치産만. 구 daemon 엔 없음 → nil.
    let byLens: [String: PoStatsCell]?
    /// 노력(effort) 구간별 출시 후 검증 결과 분해 (po_outcome_breakdown_v1) — verified/missed.
    /// 구 daemon/검증 건수 0이면 nil → 섹션 숨김.
    let outcomeByEffort: [String: PoOutcomeCell]?
    /// 리서치 «전문가 관점»(lens)별 출시 후 검증 결과 분해 — 리서치産만. 구 daemon 엔 없음 → nil.
    let outcomeByLens: [String: PoOutcomeCell]?
    /// 근거(evidence) 종류별 출시 후 검증 결과 분해 — byEvidence 와 같은 kind 원천. 구 daemon/검증 0이면 nil.
    let outcomeByEvidence: [String: PoOutcomeCell]?
    /// 보류/기각 사유별 건수 (po_decide_reason_v2) — rejected/held 만 집계. 5개 enum 키 + "none"(NULL).
    /// 구 daemon 응답엔 없음 → nil (섹션 숨김).
    let byReason: [String: Int]?
}

/// PO 루프 — 출시 후 검증 사유 한 줄. daemon `GET /api/po/stats` 의 verifyNotes 항목과 1:1
/// (po_verify_notes_v1). verify_note 가 있는 verified/missed 브리프만, 최근순. 성적표 상세의
/// «검증 사유» 섹션이 «왜 빗나갔나» 패턴을 한눈에 보여주는 데이터원.
struct PoVerifyNote: Codable, Equatable, Identifiable {
    let id: String
    /// "verified" | "missed" — success(초록)/danger(빨강) 색을 고르는 신호.
    let status: String
    /// 모델이 산출한 판정 사유 본문 — 번역 대상 아님(그대로 표시).
    let note: String
}

/// PO 루프 — 누적 성적표 전체. 톱레벨이 전체(또는 필터된) 합산, repos 가 레포별 분해.
struct PoStats: Codable, Equatable {
    let proposed: Int
    let approved: Int
    let rejected: Int
    let shipped: Int
    let verified: Int
    let missed: Int
    let approvalRate: Double?
    let medianDecisionSeconds: Double?
    let repos: [PoRepoStats]
    /// 검증 사유 목록 (verified/missed 중 verify_note 있는 행, 최근순). 구 daemon 응답엔 키 자체가
    /// 없음 → nil. 성적표 상세 시트의 «검증 사유» 섹션이 소비하며, nil/빈 배열이면 섹션을 숨긴다.
    let verifyNotes: [PoVerifyNote]?
    let byEffort: [String: PoStatsCell]?
    let byEvidence: [String: PoStatsCell]?
    let byLens: [String: PoStatsCell]?
    /// 노력(effort) 구간별 출시 후 검증 결과 분해 — 톱레벨 합산. 구 daemon/검증 0이면 nil.
    let outcomeByEffort: [String: PoOutcomeCell]?
    /// 리서치 «전문가 관점»(lens)별 출시 후 검증 결과 분해 — 톱레벨 합산. 구 daemon 엔 없음 → nil.
    let outcomeByLens: [String: PoOutcomeCell]?
    /// 근거(evidence) 종류별 출시 후 검증 결과 분해 — 톱레벨 합산. 구 daemon/검증 0이면 nil.
    let outcomeByEvidence: [String: PoOutcomeCell]?
    /// 보류/기각 사유별 건수 (po_decide_reason_v2) — rejected/held 만 집계. 5개 enum 키 + "none"(NULL).
    /// 구 daemon 응답엔 없음 → nil (섹션 숨김).
    let byReason: [String: Int]?

    /// 결재(승인+기각)가 끝난 수 — «데이터 5건 미만» 빈 상태 판정 기준.
    var decidedCount: Int { approved + rejected }
    /// 전체 합산을 레포 칸과 같은 모양으로 — 성적표 시트가 행 렌더를 공유한다.
    var totalBucket: PoRepoStats {
        PoRepoStats(
            repoPath: "", proposed: proposed, approved: approved, rejected: rejected,
            shipped: shipped, verified: verified, missed: missed,
            approvalRate: approvalRate, medianDecisionSeconds: medianDecisionSeconds,
            byEffort: byEffort, byEvidence: byEvidence, byLens: byLens,
            outcomeByEffort: outcomeByEffort, outcomeByLens: outcomeByLens,
            outcomeByEvidence: outcomeByEvidence, byReason: byReason)
    }
}

/// PO 루프 — 프로젝트별 «조사 방식» 프로필 + 주기 수집 schedule. daemon `GET /api/po/profile` 과 1:1.
struct PoProfile: Codable {
    let directive: String
    /// 주기 수집 — 5필드 cron 식 (nil = 꺼짐). 구 daemon 응답엔 키 자체가 없음 → nil.
    let schedule: String?
    /// 스토어 리뷰 신호 — ASC 앱 ID(또는 번들 ID). nil = 꺼짐. 구 daemon 응답엔 없음 → nil.
    let ascAppId: String?
    /// GitHub «피드백 repo» 오버라이드 — owner/name (nil = 로컬 origin). 사용자 피드백이 모이는
    /// 공개 repo 를 지정하면 수집이 개발 origin 대신 그 repo 의 이슈·Discussions 를 읽는다.
    /// 구 daemon 응답엔 키 자체가 없음 → nil (po_feedback_repo_v1 daemon 만 보냄).
    let githubFeedbackRepo: String?
    /// 주기 수집 «전문가 관점» 렌즈 (po_collect_lens_v1) — "default"(전방위)|"design"|"bug". 주기
    /// 수집(scheduler)이 매일 어느 초점으로 신호를 모을지 고정. 구 daemon 응답엔 키 자체가 없음 → nil.
    let lens: String?
    /// Mac 에 ASC API 키가 설정돼 있는가 — 토글 안내문 분기용 (po_asc_v1 daemon 만 보냄).
    let ascKeyConfigured: Bool?
    /// 디자인 «선언» (po_design_bootstrap_v1) — 승인돼 「디자인 제약」 에 강신호로 쓰이는 약속.
    /// nil = 선언 없음(자동 발견). 구 daemon 응답엔 키 자체가 없음 → nil.
    let designDirective: String?
    /// 디자인 «초안» — 디자이너 에이전트가 만든 검토 대기 directive (승인 전엔 적용 안 됨). nil = 없음.
    let designDirectiveDraft: String?
    /// 초안 «생성 중» 표시 — non-nil 이면 부트스트랩 세션이 돌고 있다(이 id 로 관전 가능). nil = 멈춤.
    let designDirectiveDraftSessionId: String?
    /// 초안 산출 시각 (epoch ms) — 검토 UI 표시용. nil = 초안 없음.
    let designDirectiveDraftAt: Int64?
}

struct PoBriefsResponse: Codable {
    let briefs: [PoBrief]
}

/// PO 루프 — 수집 «GitHub 신호» 가용성 점검 결과 (po_gh_check_v1). daemon `po/gh.ts` 와 1:1.
/// daemon 이 수집 직전 `gh --version`(설치)·`gh auth status`(인증)·레포 GitHub 원격 여부를
/// 점검해 `POST /api/po/collect` 응답에 담는다. 옛 daemon 응답엔 키 자체가 없음 → nil (조용히
/// 폴백, 거짓 «설정 필요» 표시 금지). 점검이 불확실(타임아웃)할 때도 daemon 이 필드를 생략 → nil.
struct GhCollectCheck: Codable, Equatable, Hashable {
    /// 이 레포가 GitHub 원격을 가지는가 — false 면 gh 가 있어도 GitHub 신호가 무의미 (안내 안 띄움).
    let githubRemote: Bool
    /// `gh --version` 성공 (설치/실행 가능).
    let installed: Bool
    /// `gh auth status` 성공 (로그인됨). 미설치면 무의미.
    let authed: Bool
    /// 점검 대상이 «피드백 repo» 였으면 그 식별자(owner/name). 로컬 origin 점검이면 nil.
    /// 배너 문구를 «로컬 origin» vs «피드백 repo» 로 분기한다 (po_feedback_repo_v1).
    let feedbackRepo: String?
    /// 피드백 repo 점검 시에만 의미 — `gh repo view <repo>` 성공(그 계정으로 실제 읽힘).
    /// false = repo 없음 또는 private 인데 권한 없음(거짓 «로그인 필요» 가 아니라 «접근 불가»).
    let feedbackRepoAccessible: Bool?

    /// 안내를 띄워야 하는가 — GitHub 레포인데 gh 가 없거나 로그인 안 됐을 때, 또는 피드백
    /// repo 가 설정됐는데 그 repo 를 못 읽을 때. 정상이면 false → 아무 UI 도 안 뜬다.
    var needsNotice: Bool {
        githubRemote && (!installed || !authed || feedbackRepoUnreadable)
    }
    /// 설치는 됐지만 로그인만 안 된 상태 — 설치 명령 빼고 `gh auth login` 만 안내.
    var installedButUnauthed: Bool { githubRemote && installed && !authed }
    /// 설치·인증은 됐는데 «피드백 repo» 를 못 읽는 상태 — private+무권한 또는 오타.
    /// 명령 안내가 아니라 «접근 불가» 안내 톤 (거짓 «설정 필요» 금지).
    var feedbackRepoUnreadable: Bool {
        installed && authed && feedbackRepo != nil && feedbackRepoAccessible == false
    }
}

/// PO 루프 — 수집 «App Store 신호»(리뷰 + 크래시) 가용성 점검 결과 (po_asc_check_v1).
/// daemon `po/asc-check.ts` 와 1:1. daemon 이 수집 직전 ASC 키 인증을 점검(/v1/apps)해
/// `POST /api/po/collect` 응답에 담는다. 리뷰(po_asc_v1)·크래시(po_crash_v1)는 같은 ASC 키를
/// 공유하므로 이 한 점검이 둘 다 커버한다 — 키가 «저장 후» 만료·폐기되면 리뷰·크래시가 함께 0.
/// 옛 daemon 응답엔 키 자체가 없음 → nil (조용히 폴백). 점검 불확실(네트워크/타임아웃/5xx)도
/// daemon 이 필드를 생략 → nil (일시 blip 을 «키 만료» 로 오인하지 않음).
struct AscCollectCheck: Codable, Equatable, Hashable {
    /// ASC 신호가 켜져 있는가 — `po_profiles.asc_app_id` 설정 여부. false 면 안내 무의미.
    let enabled: Bool
    /// Mac config.json 에 ASC API 키가 저장돼 있는가. false 면 키 등록 유도.
    let keyConfigured: Bool
    /// 저장된 키로 ASC 인증 성공(만료·폐기·권한 부족이 아님). 키 미설정이면 무의미.
    let reachable: Bool

    /// 안내를 띄워야 하는가 — 신호가 켜져 있는데 키가 없거나 인증이 깨졌을 때만.
    /// 정상(켬+키+인증)이거나 꺼짐이면 false → 아무 UI 도 안 뜬다 (정상/무관 케이스 잡음 금지).
    var needsNotice: Bool { enabled && (!keyConfigured || !reachable) }
    /// 키 자체가 없는 상태 — «Mac 설정에서 키 등록» 안내. 인증 깨짐(키 있음+미인증)과 문구를 분기.
    var keyMissing: Bool { enabled && !keyConfigured }
}

/// PO 신호 수집 시작 결과 — 관전용 sessionId + (있으면) 신호 가용성 점검 메타(gh / asc).
struct PoCollectStart {
    let sessionId: String
    /// po_gh_check_v1 daemon 만 채운다. nil = 옛 daemon 이거나 점검 불확실 → 안내 안 띄움.
    let gh: GhCollectCheck?
    /// po_asc_check_v1 daemon 만 채운다. nil = 옛 daemon 이거나 점검 불확실 → 안내 안 띄움.
    let asc: AscCollectCheck?
}

/// PO 루프 — 한 «App Store 신호원»(스토어 리뷰 또는 크래시)의 «1회 수집» 실행 결과
/// (po_signal_status_v1). daemon `po/signals.ts` 의 SignalSourceState 와 1:1.
/// asc-check(po_asc_check_v1)가 수집 «직전» 키 인증만 프로브하던 것과 달리, 이건 fetch «후» 의
/// 실제 결과라 used(N)·app id 오류·네트워크 실패까지 구분한다 — 켠 신호가 키 만료·네트워크로
/// 조용히 빠졌는데도 «반영된 줄» 착각하던 무음 강등을 막는다.
struct SignalSourceState: Codable, Equatable, Hashable {
    /// used | off | empty | key_missing | auth | app_id | network. 미래 daemon 의 새 값은
    /// .unknown 으로 폴백(거짓 경고 금지 — 모르면 «정상» 취급해 조용히).
    let state: Kind
    /// used 일 때만 — 반영된 신호 건수.
    let count: Int?

    enum Kind: String, Codable, Equatable, Hashable {
        case used          // 신호 N건 실제 반영됨
        case off           // 안 켬 (asc_app_id 미설정)
        case empty         // 켰고 키 정상인데 데이터 0 (정상 빈-상태)
        case keyMissing    = "key_missing"   // 키 미설정 (꺼짐/설정 필요)
        case auth          // 401/403 키·권한
        case appId         = "app_id"        // app id 오류
        case network       // 네트워크/타임아웃/5xx
        case unknown                          // 옛/미래 daemon 의 모르는 값 → 조용히
    }

    init(state: Kind, count: Int? = nil) {
        self.state = state
        self.count = count
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        // 모르는 state 문자열은 디코딩 실패(throw) 대신 .unknown 으로 — 미래 daemon 호환.
        let raw = try c.decode(String.self, forKey: .state)
        self.state = Kind(rawValue: raw) ?? .unknown
        self.count = try c.decodeIfPresent(Int.self, forKey: .count)
    }

    /// 사용자에게 «실패(설정 필요)» 로 보여야 하는가 — warning 톤. off/empty/used/unknown 은 아님.
    var isFailure: Bool {
        switch state {
        case .keyMissing, .auth, .appId, .network: return true
        case .used, .off, .empty, .unknown: return false
        }
    }
}

/// PO 루프 — 한 번의 수집에서 두 ASC 신호원(스토어 리뷰 + 크래시)의 실행 결과.
/// daemon `po/signals.ts` CollectSignals 와 1:1. iOS 백로그가 수집 후 GET /collect/last 로 읽어
/// «수집 결과 카드» 를 띄운다.
struct CollectSignals: Codable, Equatable, Hashable {
    let store: SignalSourceState
    let crash: SignalSourceState

    /// 신호가 «켜져» 있었는가 — off/unknown 만이면(둘 다 안 켬) 카드 자체를 안 띄운다 (잡음 금지).
    /// 하나라도 used/empty/실패면 켠 것 → 결과 카드 노출.
    var enabled: Bool {
        func on(_ s: SignalSourceState) -> Bool {
            switch s.state {
            case .off, .unknown: return false
            default: return true
            }
        }
        return on(store) || on(crash)
    }

    /// 어느 한쪽이라도 실패(키·권한·app id·네트워크)인가 — 카드 헤더 톤(warning vs 중립) 분기.
    var hasFailure: Bool { store.isFailure || crash.isFailure }
}

/// PO 루프 — 직전 수집의 신호원 실행 상태 (po_signal_status_v1). GET /collect/last 응답.
/// signals=nil = 아직 수집 없음/신호 안 켬/옛 daemon → 카드 숨김. sessionId = 그 상태를 만든
/// 수집 세션 (방금 시작한 수집과 일치하면 «이번 수집 결과» 로 판정).
struct LastCollectSignals: Codable, Equatable {
    let signals: CollectSignals?
    let sessionId: String?
    let at: Double?
}


/// PO 루프 — 리서치 요청 한 건. daemon `routes/po.ts` 의 researchToApi 와 1:1.
/// `report` 는 상세 조회(`getPoResearch`)에서만 채워진다 (목록 응답엔 없음 → nil).
struct PoResearch: Codable, Identifiable, Equatable, Hashable {
    let id: String
    let repoPath: String
    let topic: String
    let status: String          // "running" | "done" | "failed"
    let sessionId: String?
    let briefCount: Int
    let createdAt: Int64
    let updatedAt: Int64
    let report: String?
    /// 어느 «전문가 관점»(po_research_lens_v1)으로 조사했는지 — "default"(전방위)|"design"|"bug".
    /// 옛 daemon 은 안 보냄 → nil → 전방위로 취급(칩 숨김). 보고서 머리/행에 칩으로 노출한다.
    let lens: String?
}

// MARK: - 로컬 LLM (/api/local-llm/*)
//
// daemon local-llm/status.ts·catalog.ts 의 응답을 그대로 받는다(키는 daemon 이 보내는 camelCase
// 와 1:1 — JSONDecoder 기본 디코딩). 새 세션 시트가 이 세부 상태를 읽어 「무엇이 준비됐고
// 무엇이 빠졌는지」 를 표면화하고, 모델 다운로드/선택을 폰에서 직접 트리거한다.

/// 추론 서버(llama-server)·에이전트 CLI(qwen)·다운로더(aria2c) 바이너리 설치 여부.
/// llamaServer/qwen 둘 다 있어야 로컬 LLM 세션을 만들 수 있다(이 둘은 Mac 권한 영역 — 폰에서
/// 설치 불가). aria2c 는 다운로드 가속용(없어도 fetch fallback).
struct LocalLlmBinaries: Codable, Equatable {
    let llamaServer: Bool
    let qwen: Bool
    let aria2c: Bool
}

/// Mac 하드웨어 요약 — 표시용(칩/RAM)과 모델 추천 근거.
struct LocalLlmHardware: Codable, Equatable {
    let totalRamBytes: Int64
    let chipBrand: String?
    let gpuCores: Int?
}

/// 진행 중 다운로드 상태. state: idle/downloading/verifying/ready/error. error 는 사람이 읽는 한 줄.
struct LocalLlmDownloadProgress: Codable, Equatable {
    let modelId: String?
    let state: String
    let bytesDownloaded: Int64
    let bytesTotal: Int64
    let percent: Double
    let bytesPerSec: Double
    let etaSeconds: Double?
    let error: String?

    /// 지금 무언가를 받는 중인지(다운로드/검증) — 진행 UI 노출 + 다른 다운로드 차단 판정.
    var active: Bool { state == "downloading" || state == "verifying" }
}

/// llama-server 런타임 상태. 표시/게이팅엔 state·modelId 만 쓴다(나머지 키는 무시).
struct LocalLlmServerInfo: Codable, Equatable {
    let state: String          // stopped/preflight/starting/ready/error/adopted
    let modelId: String?
}

/// `GET /api/local-llm/status` — 바이너리 + 선택/추천 모델 + 다운로드 진행 + 하드웨어 + 서버.
struct LocalLlmStatus: Codable, Equatable {
    let hardware: LocalLlmHardware
    let recommendedModelId: String?
    let selectedModelId: String?
    let modelPresent: Bool
    let server: LocalLlmServerInfo
    let download: LocalLlmDownloadProgress
    let binaries: LocalLlmBinaries
    let ctxSize: Int?

    /// 추론 서버·에이전트 CLI 둘 다 설치됨 — 「Mac 에서 설치」 안내가 필요 없는 상태.
    var binariesReady: Bool { binaries.llamaServer && binaries.qwen }
}

/// `GET/PUT /api/opencode/external` — OpenCode 「내 로컬 서버 사용」 외부 엔드포인트 설정.
/// 켜면 daemon 이 번들 llama-server 를 건너뛰고 이 baseUrl 을 OpenCode 의 OPENAI_BASE_URL 로
/// 주입한다 — Ollama/LM Studio/vLLM 등 사용자가 이미 돌리는 서버 그대로.
struct OpencodeExternalConfig: Codable, Equatable {
    var enabled: Bool
    var baseUrl: String
    var modelId: String
}

/// `POST /api/opencode/external/verify` — /v1/models 헬스체크 결과. 도달성 + 설정 모델 존재를
/// 검증해 «막다른 길»(연결했더니 서버가 없거나 모델명이 틀림)을 사전 차단한다.
struct OpencodeExternalProbe: Codable, Equatable {
    let reachable: Bool
    let models: [String]
    let modelPresent: Bool
    /// nil 이면 정상. unreachable/http_error/bad_response/no_models/model_not_found.
    let error: String?
    let httpStatus: Int?
}

/// 카탈로그 한 모델(표시 필드만 + downloaded 플래그). hfRepo/sha256 등은 폰에 불필요 → 무시.
struct LocalLlmCatalogModel: Codable, Identifiable, Equatable {
    let id: String
    let displayName: String
    let description: String
    let tier: String
    let quant: String
    let fileSizeBytes: Int64
    let minRamBytes: Int64
    let recommendedRamBytes: Int64
    let estDecodeTokSec: Double
    /// OpenAI 호환 도구호출이 견고한가 — false 면 «분석 전용»(에이전트 비권장). 구버전 daemon 엔 없을 수 있다(nil=가능 취급).
    let toolCallCapable: Bool?
    /// 도구호출이 안정적인 권장 최소 컨텍스트(≥16k). daemon supervisor 가 이 값 이상으로 기동 보장. 구버전 daemon 엔 없을 수 있다.
    let minToolCtx: Int?
    let downloaded: Bool

    /// 구버전 daemon(필드 부재)은 도구호출 가능으로 취급 — 그땐 카탈로그가 전부 Qwen tool 모델이었다.
    var isToolCallCapable: Bool { toolCallCapable ?? true }
}

/// `GET /api/local-llm/models` — 카탈로그 + downloaded 목록 + 추천/선택 모델.
struct LocalLlmCatalogResponse: Codable, Equatable {
    let catalog: [LocalLlmCatalogModel]
    let downloaded: [String]
    let recommendedModelId: String?
    let selectedModelId: String?
    let ctxSize: Int?
}

enum ApiError: LocalizedError {
    case notPaired
    case torNotRunning
    case httpStatus(Int, String)
    case decoding(Error)
    case transport(Error)
    /// Secure Enclave 기기 인증 단계 실패 (SE 키 소실 / 서명 거부 / 검증 거부 등).
    /// 보통 Mac 에서 페어링을 다시 시작해야 복구된다.
    case attestFailed(String)

    var errorDescription: String? {
        switch self {
        case .notPaired: return String(localized: "페어링 되지 않음")
        case .torNotRunning: return String(localized: "Tor가 준비되지 않음")
        case .attestFailed(let m): return m
        case .httpStatus(let code, let body):
            // 로컬 LLM 세션 동시 1개 제약 — daemon 이 409 로 거절(메모리 보호). 새 세션 시트가
            // 보통 client-side 로 먼저 막지만, 레이스로 여기까지 오면 친절한 메시지로 변환.
            if code == 409, body.contains("local_llm_session_limit") {
                return String(localized: "로컬 LLM 세션은 메모리를 많이 차지해 한 번에 하나만 만들 수 있어요. 기존 로컬 LLM 세션을 먼저 종료하세요.")
            }
            // 로컬 LLM 모델 다운로드 실패 — daemon 이 보내는 에러코드를 사람이 읽는 사유로 변환.
            if body.contains("insufficient_disk") {
                return String(localized: "디스크 공간이 부족해 모델을 받을 수 없어요. 저장 공간을 확보한 뒤 다시 시도하세요.")
            }
            if body.contains("\"busy\"") {
                return String(localized: "이미 다른 모델을 받는 중이에요. 끝나거나 취소한 뒤 다시 시도하세요.")
            }
            if body.contains("download_failed") {
                return String(localized: "모델 다운로드에 실패했어요. 잠시 후 다시 시도하세요.")
            }
            // 세션 경로 폴더 생성 실패 — daemon 이 message 에 사람이 읽을 사유(권한/파일 충돌
            // /절대경로 아님 등)를 담아 보낸다. 그걸 그대로 노출(원인이 가장 정확).
            if body.contains("repo_dir_failed") {
                struct E: Decodable { let message: String? }
                if let data = body.data(using: .utf8),
                   let parsed = try? JSONDecoder().decode(E.self, from: data),
                   let msg = parsed.message, !msg.isEmpty {
                    return msg
                }
                return String(localized: "세션 경로 폴더를 만들 수 없어요. 경로를 확인해 주세요.")
            }
            return "HTTP \(code): \(body.prefix(200))"
        case .decoding(let e): return Self.describeDecodingError(e)
        case .transport(let e): return String(localized: "전송 실패: \(e.localizedDescription)")
        }
    }

    /// 사용자가 화면을 떠나거나 task 를 cancel 해서 통신이 끊긴 경우인지.
    /// 이런 에러는 진짜 네트워크 문제가 아니라 "의도된 중단" 이라 UI 에 빨간 배너로 띄울
    /// 이유가 없다. URLSession 은 swift concurrency task 가 cancel 되면 underlying
    /// 요청을 끊고 `URLError(.cancelled)` 를 던지는데, 그게 `.transport` 안에 래핑돼서
    /// 올라오므로 양쪽 다 풀어서 확인한다.
    static func isCancellation(_ error: Error) -> Bool {
        if error is CancellationError { return true }
        if let urlErr = error as? URLError, urlErr.code == .cancelled { return true }
        if let api = error as? ApiError, case .transport(let underlying) = api {
            if underlying is CancellationError { return true }
            if let urlErr = underlying as? URLError, urlErr.code == .cancelled { return true }
        }
        return false
    }

    /// 디코드 에러를 사람이 읽을 수 있는 형태로 분해. 어느 필드가 어떤 타입으로 실패했는지
    /// 한 줄에 담는다 — 다음 mismatch 가 생겼을 때 즉시 원인을 알 수 있게.
    private static func describeDecodingError(_ error: Error) -> String {
        guard let dec = error as? DecodingError else {
            return String(localized: "디코드 실패: \(error.localizedDescription)")
        }
        switch dec {
        case .keyNotFound(let key, let ctx):
            let path = ctx.codingPath.map(\.stringValue).joined(separator: ".")
            return String(localized: "디코드 실패 [키 없음] \(path).\(key.stringValue)")
        case .typeMismatch(let type, let ctx):
            let path = ctx.codingPath.map(\.stringValue).joined(separator: ".")
            let typeStr = "\(type)"
            return String(localized: "디코드 실패 [타입 불일치 \(typeStr)] at \(path) — \(ctx.debugDescription)")
        case .valueNotFound(let type, let ctx):
            let path = ctx.codingPath.map(\.stringValue).joined(separator: ".")
            let typeStr = "\(type)"
            return String(localized: "디코드 실패 [\(typeStr) 값 없음] at \(path)")
        case .dataCorrupted(let ctx):
            let path = ctx.codingPath.map(\.stringValue).joined(separator: ".")
            return String(localized: "디코드 실패 [데이터 손상] at \(path) — \(ctx.debugDescription)")
        @unknown default:
            let decStr = "\(dec)"
            return String(localized: "디코드 실패: \(decStr)")
        }
    }
}

@MainActor
final class ApiClient {
    let auth: AuthStore
    let conn: ConnectionManager
    /// 능동 요청 in-flight 트래커. 폴링 호출은 `label: nil` 로 보내 추적에서 제외된다.
    /// 일부 진입점(BootView 등)은 tracker 가 없이 동작해도 되므로 옵션이다.
    let tracker: InFlightTracker?

    /// 캐시된 URLSession — process-wide static. 모든 ApiClient 인스턴스가 공유한다.
    ///
    /// 듀얼 채널 모델로 전환 후엔 SSH local forward port (127.0.0.1:<dynamic>) 를 base 로 쓰므로
    /// SOCKS proxy 설정 불필요. ConnectionManager 가 채택한 채널의 local port 가 바뀌면
    /// sharedSession 도 폐기.
    private static var sharedSession: URLSession?
    private static var sharedSessionPort: UInt16?

    init(auth: AuthStore, conn: ConnectionManager, tracker: InFlightTracker? = nil) {
        self.auth = auth
        self.conn = conn
        self.tracker = tracker
    }

    private func makeSession() throws -> URLSession {
        guard let localPort = conn.currentLocalPort else { throw ApiError.torNotRunning }
        // 같은 포트면 캐시 재사용.
        if let cached = Self.sharedSession, Self.sharedSessionPort == localPort {
            return cached
        }
        // 포트가 바뀌었거나 첫 호출 — 기존 세션 정리하고 새로.
        Self.sharedSession?.invalidateAndCancel()

        let config = URLSessionConfiguration.default
        // SSH local forward 직행 — SOCKS5 proxy 제거. 모든 트래픽은 ConnectionManager 가
        // 채택한 SSH 채널을 통해 daemon `127.0.0.1:7777` 로 전달됨.
        config.timeoutIntervalForRequest = 60
        config.timeoutIntervalForResource = 120
        config.httpMaximumConnectionsPerHost = 4
        config.httpAdditionalHeaders = ["Accept-Encoding": "gzip, deflate"]

        let session = URLSession(configuration: config)
        Self.sharedSession = session
        Self.sharedSessionPort = localPort
        return session
    }

    private func authedRequest(method: String, path: String, body: Data? = nil) throws -> URLRequest {
        guard let cfg = auth.config else { throw ApiError.notPaired }
        guard let localPort = conn.currentLocalPort else { throw ApiError.torNotRunning }
        // SSH local forward 위 daemon HTTP. SSH 가 어느 채널 (IPv6/IPv4/Tor) 이든 우리는
        // 그저 localhost 로 보낸다.
        guard let base = URL(string: "http://127.0.0.1:\(localPort)/"),
              let url = URL(string: path, relativeTo: base) else {
            throw ApiError.notPaired
        }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("Bearer \(cfg.daemonToken)", forHTTPHeaderField: "Authorization")
        // daemon 측 호환성 강제 안전망 — 모든 /api/* 요청에 자기 버전을 박아둔다.
        // 미래의 daemon 이 MIN_SUPPORTED_CLIENT_VERSION 을 올리면 이 헤더로 식별해
        // 426 으로 응답 → 우리는 sendOnce 에서 catch 해 verdict 를 즉시 차단으로 전환.
        // 헤더 누락은 daemon 이 통과시키는 정책이지만 (옛 빌드 호환), 이 빌드부터의
        // 모든 iOS 는 헤더를 단다.
        req.setValue(VersionCompat.currentAppVersion, forHTTPHeaderField: "X-Client-Version")
        // Secure Enclave 기기 인증 토큰. 캐시된 유효 토큰이 있을 때만 붙인다 — 미등록/옛
        // daemon 이면 nil 이라 헤더 생략(daemon soft 모드가 통과시킴). 토큰이 만료/필요하면
        // daemon 이 401 attest_required 로 답하고, send(...) 가 재인증 후 1회 재시도한다.
        if let attestToken = AttestSession.shared.currentToken() {
            req.setValue(attestToken, forHTTPHeaderField: "X-PS-Attest")
        }
        // 시뮬레이터 개발 페어링 — SE 가 없어 attest 토큰을 못 만드므로 localAdminSecret 로
        // daemon 의 requireAttestation 게이트를 통과한다 (Mac 앱 자기 호출과 같은 경로).
        if let localSecret = DevPairing.localAdminSecret {
            req.setValue(localSecret, forHTTPHeaderField: "X-PS-Local")
        }
        if body != nil {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = body
        }
        return req
    }

    /// HTTP 요청 1회 — 세션 생성 + 요청 + 디코드. 재시도 로직은 caller (send) 가 담당.
    private func sendOnce<T: Decodable>(
        method: String,
        path: String,
        body: Data?,
    ) async throws -> T {
        let session = try makeSession()
        let req = try authedRequest(method: method, path: path, body: body)
        do {
            let (data, resp) = try await session.data(for: req)
            guard let http = resp as? HTTPURLResponse else {
                throw ApiError.httpStatus(0, "no response")
            }
            guard (200..<300).contains(http.statusCode) else {
                // 426 Upgrade Required — daemon 이 이 빌드를 너무 옛버전으로 판정.
                // 본문에는 { error:"client_too_old", minSupportedClientVersion:"x.y.z", clientVersion:"…" }.
                // VersionCompatStore 가 NotificationCenter 로 듣고 verdict 를 hardClientTooOld 로 갈아끼움.
                // 우리는 그 후에도 .httpStatus 그대로 throw 해서 caller 가 일반 실패 경로로 떨어지게 한다 —
                // AppRoot 가 verdict 변경을 감지해 IncompatibleView 로 라우트한다.
                if http.statusCode == 426 {
                    Self.handleClientTooOldResponse(data: data)
                }
                throw ApiError.httpStatus(http.statusCode, String(data: data, encoding: .utf8) ?? "")
            }
            do {
                return try JSONDecoder().decode(T.self, from: data)
            } catch {
                throw ApiError.decoding(error)
            }
        } catch let e as ApiError {
            throw e
        } catch {
            throw ApiError.transport(error)
        }
    }

    /// HTTP 요청을 수행한다. `label` 이 non-nil 이고 tracker 가 있으면 in-flight 로 등록 → 응답/에러
    /// 어느 쪽이든 종료 시 해제. 폴링 호출자는 `label: nil` 로 보내 추적에서 빠진다.
    ///
    /// 2단계 자동 회복:
    ///   - 1차 실패 (.transport, 사용자 cancel 제외) → `tor.resetCircuits()`
    ///     (RELOAD+NEWNYM + 현재 회로 강제 종료) → 재시도
    ///   - 2차 실패 → `markUnrecoverable` → 그대로 surface
    ///
    /// PacketTunnel 익스텐션 도입 후 SocksPort 토글 (deepRestart) 는 불필요해졌다 —
    /// 익스텐션은 시스템이 살려두므로 SOCKS listener FD 가 invalidate 되는 일이 없다.
    /// 1차 회로 reset 으로 회복 안 되면 보통 서버 측 문제이거나 진짜 네트워크 단절이라
    /// 추가 시도해도 의미 없다.
    private func send<T: Decodable>(
        _ method: String,
        _ path: String,
        body: Encodable? = nil,
        label: String? = nil,
    ) async throws -> T {
        let opId: UUID? = {
            guard let label, let tracker else { return nil }
            return tracker.begin(label)
        }()
        defer {
            if let opId, let tracker {
                tracker.end(opId)
            }
        }

        let bodyData = try body.map { try JSONEncoder().encode($0) }

        // 1차 시도.
        do {
            return try await sendOnce(method: method, path: path, body: bodyData)
        } catch ApiError.httpStatus(401, let respBody) where respBody.contains("attest_required") {
            // Secure Enclave 기기 인증 토큰이 만료/누락 → 재인증(Face ID, 세션당 1회) 후 1회
            // 재시도. ensureToken 이 새 토큰을 캐시하면 다음 authedRequest 가 헤더에 싣는다.
            // (재시도가 또 401 이면 그대로 surface — 무한 루프 없음.)
            NSLog("[ApiClient] attest_required → 기기 재인증 후 재시도")
            AttestSession.shared.invalidate()
            _ = try await AttestSession.shared.ensureToken(api: self)
            return try await sendOnce(method: method, path: path, body: bodyData)
        } catch ApiError.transport(let underlying) where !Self.isCancelledTransport(underlying) {
            NSLog("[ApiClient] transport 실패 (1) → 강제 재연결 후 재시도: \(underlying.localizedDescription)")
            // SSH 채널이 죽은 게 확실시 됐을 때만 강제 재연결 — 옛 active client 정리 + 새로.
            // 단순 connect() 는 .running 이면 no-op 이므로 회복 안 됨.
            await conn.reconnect()
        }
        // 2차 시도 (재연결 후). 실패하면 회복 불가.
        do {
            return try await sendOnce(method: method, path: path, body: bodyData)
        } catch ApiError.transport(let underlying) where !Self.isCancelledTransport(underlying) {
            NSLog("[ApiClient] transport 실패 (2) — 회복 불가: \(underlying.localizedDescription)")
            throw ApiError.transport(underlying)
        }
    }

    /// 426 응답 본문에서 minSupportedClientVersion 을 뽑아내 NotificationCenter 로 broadcast.
    /// 디코드 실패해도 빈 문자열로 — 어차피 verdict 분기에 최소 버전 정보가 없어도 "iOS 업데이트 필요"
    /// 메시지는 띄울 수 있다.
    private static func handleClientTooOldResponse(data: Data) {
        struct TooOldBody: Decodable {
            let minSupportedClientVersion: String?
        }
        let min = (try? JSONDecoder().decode(TooOldBody.self, from: data))?.minSupportedClientVersion ?? ""
        NotificationCenter.default.post(
            name: .clientTooOldDetected,
            object: nil,
            userInfo: [
                "minRequired": min,
                "clientVersion": VersionCompat.currentAppVersion,
            ],
        )
    }

    /// transport underlying error 가 사용자/시스템 cancel 인지 판별.
    /// 화면 떠나기/task 취소로 인한 .cancelled 는 회로 reset 의 대상이 아니다 — noise 만 만들고
    /// 다음 화면 진입 시 새 task 가 어차피 다시 요청한다.
    private static func isCancelledTransport(_ error: Error) -> Bool {
        if error is CancellationError { return true }
        if let urlErr = error as? URLError, urlErr.code == .cancelled { return true }
        return false
    }

    // MARK: - Verification

    struct HealthResponse: Codable {
        let ok: Bool
        let time: String
    }

    func health() async throws -> HealthResponse {
        try await send("GET", "/health")
    }

    // MARK: - 라이브 프리뷰 (preview_proxy_v1)
    //
    // 세션별로 dev 포트를 «명시 등록» 하고(기본 차단), daemon 프리뷰 프록시가 등록된 포트만
    // forward 한다. proxyPort 는 iOS 가 기존 SSH 세션 위에 forward 를 하나 더 열 대상 포트.

    /// 등록된 프리뷰 포트 한 개.
    struct PreviewPortEntry: Codable, Identifiable, Equatable {
        let port: Int
        let createdAt: Int64?
        /// `/__psproxy__/<sid>/<port>` — WKWebView 가 처음 여는 진입 경로.
        let entryPath: String
        var id: Int { port }
    }

    /// GET/POST/DELETE /api/preview/ports 응답.
    struct PreviewPortsResponse: Codable {
        /// 프리뷰 프록시 포트. forward 대상 (DELETE 응답엔 없을 수 있어 optional).
        let proxyPort: Int?
        let entryPrefix: String?
        let ports: [PreviewPortEntry]
    }

    /// 세션에 등록된 프리뷰 포트 목록 + 프록시 포트.
    func previewPorts(sessionId: String) async throws -> PreviewPortsResponse {
        try await send("GET", "/api/preview/ports?sessionId=\(sessionId)", label: "previewPorts")
    }

    /// dev 포트 등록 — 보안의 «명시 허용». 성공 시 proxyPort/entryPath 가 채워진 목록 반환.
    func registerPreviewPort(sessionId: String, port: Int) async throws -> PreviewPortsResponse {
        struct Body: Encodable { let sessionId: String; let port: Int }
        return try await send("POST", "/api/preview/ports",
                              body: Body(sessionId: sessionId, port: port), label: "registerPreviewPort")
    }

    /// dev 포트 등록 해제.
    @discardableResult
    func unregisterPreviewPort(sessionId: String, port: Int) async throws -> PreviewPortsResponse {
        struct Body: Encodable { let sessionId: String; let port: Int }
        return try await send("DELETE", "/api/preview/ports",
                              body: Body(sessionId: sessionId, port: port), label: "unregisterPreviewPort")
    }

    struct PreviewProbeResponse: Codable { let listening: Bool }

    /// dev 서버가 그 포트에서 실제로 듣고 있는지 (UI 의 «실행 중» 표시용).
    func probePreviewPort(_ port: Int) async throws -> Bool {
        let r: PreviewProbeResponse = try await send("GET", "/api/preview/probe?port=\(port)", label: "probePreviewPort")
        return r.listening
    }

    /// «감지된 포트» 후보 한 건 — 세션 PTY 자식 트리가 LISTEN 중인 dev 서버.
    struct PreviewDetectedPort: Codable, Identifiable, Equatable {
        let port: Int
        /// 포트를 연 프로세스 이름 (node/vite 등). 있으면 행 라벨에 보조 표시.
        let command: String?
        var id: Int { port }
    }

    struct PreviewDetectResponse: Codable { let ports: [PreviewDetectedPort] }

    /// 세션이 띄운 dev 서버 후보 포트 감지. 등록은 하지 않음(사용자 탭에서만) — 후보만 반환.
    func detectPreviewPorts(sessionId: String) async throws -> [PreviewDetectedPort] {
        let r: PreviewDetectResponse = try await send("GET", "/api/preview/detect?sessionId=\(sessionId)", label: "detectPreviewPorts")
        return r.ports
    }

    // MARK: - Secure Enclave 기기 인증 (attest)
    //
    // 이 메서드들은 `send` 가 아니라 `sendOnce` 를 직접 쓴다 — attest 라우트는 daemon 의
    // requireAttestation 게이트 «예외» 라 attest_required 401 을 절대 안 내므로, send 의
    // attest 재인증-재시도 루프에 들어갈 필요가 없다(들어가면 자기 자신을 부르는 꼴).

    struct AttestStatusResponse: Decodable {
        let enrolled: Bool
        /// 첫 등록 기기 지문 (레거시 단일 응답). 미등록이면 nil.
        let fingerprint: String?
        /// 등록된 모든 기기의 지문 목록. 신규 daemon 만 제공(옛 daemon 은 nil → fingerprint 단일로 폴백).
        let fingerprints: [String]?
        /// 지금 새 기기를 추가 등록할 빈 슬롯이 있는지. 신규 daemon 만 제공(옛 daemon 은 nil → 단일 기기 모델).
        let slotAvailable: Bool?
    }
    struct AttestChallengeResponse: Decodable { let nonce: String; let ttlSec: Int }
    struct AttestVerifyResponse: Decodable { let token: String; let exp: Int64 }
    private struct AttestOkResponse: Decodable { let ok: Bool? }
    private struct AttestRegisterBody: Encodable { let publicKey: String; let signature: String }
    private struct AttestVerifyBody: Encodable { let nonce: String; let signature: String }

    /// 등록 여부 + 등록된 키 지문(들) + 빈 슬롯 여부 조회. 옛 daemon (이 라우트를 모르는
    /// 빌드) 은 404 → `httpStatus(404,_)` throw → caller(AttestSession)가 «attest 미지원 =
    /// soft» 로 분기한다.
    /// - `fingerprints`/`slotAvailable` 은 다중 기기(최대 2대)를 지원하는 신규 daemon 만
    ///   제공한다. 옛 daemon 은 nil → 호출부가 단일 기기(fingerprint) 모델로 폴백한다.
    func attestStatus() async throws
        -> (enrolled: Bool, fingerprint: String?, fingerprints: [String]?, slotAvailable: Bool?)
    {
        let r: AttestStatusResponse =
            try await sendOnce(method: "GET", path: "/api/attest/status", body: nil)
        return (r.enrolled, r.fingerprint, r.fingerprints, r.slotAvailable)
    }

    /// 이 기기의 SE 공개키 + 소유 증명 서명 등록 (페어링당 1회).
    func attestRegister(publicKeyBase64: String, signatureBase64: String) async throws {
        let body = try JSONEncoder().encode(
            AttestRegisterBody(publicKey: publicKeyBase64, signature: signatureBase64))
        let _: AttestOkResponse =
            try await sendOnce(method: "POST", path: "/api/attest/register", body: body)
    }

    /// challenge nonce 발급.
    func attestChallenge() async throws -> (nonce: String, ttlSec: Int) {
        let r: AttestChallengeResponse =
            try await sendOnce(method: "GET", path: "/api/attest/challenge", body: nil)
        return (r.nonce, r.ttlSec)
    }

    /// nonce 서명 검증 → 단기 attest 토큰 발급.
    func attestVerify(nonce: String, signatureBase64: String) async throws -> (token: String, exp: Int64) {
        let body = try JSONEncoder().encode(AttestVerifyBody(nonce: nonce, signature: signatureBase64))
        let r: AttestVerifyResponse =
            try await sendOnce(method: "POST", path: "/api/attest/verify", body: body)
        return (r.token, r.exp)
    }

    // MARK: - 기기 관리 (device admin)
    //
    // Mac 앱 설정 「기기」 탭과 «같은» daemon 라우트(`/api/admin/device-info`·`/device-slot`
    // ·`/revoke-device`)를 폰에서도 호출한다. Mac 은 X-PS-Local(같은 머신 admin secret)로
    // requireAttestation 게이트를 통과하지만, iOS 는 평소처럼 X-PS-Attest 토큰으로 통과한다
    // (`send` 가 401 attest_required 시 1회 재인증·재시도). 그래서 attest 라우트와 달리
    // `sendOnce` 가 아니라 `send` 를 쓴다.

    /// `/api/admin/device-info` 응답 — 등록된 기기 목록 + 두 번째 슬롯 허용 여부.
    /// Mac `DaemonAPI.DeviceInfo` 와 같은 shape.
    struct DeviceInfoResponse: Decodable {
        /// 1대 이상 등록됐는지. false 면 soft 모드(미등록 / 옛 폰).
        let enrolled: Bool
        /// 추가 기기 슬롯이 켜져 있는지. 기본 false(1대만 허용).
        let extraSlotAllowed: Bool
        /// 연결 가능한 기기의 절대 상한 (현재 3). 표시는 항상 이 값을 따른다(하드코딩 금지).
        let maxSlots: Int
        /// 페어링 SSH client 키 지문 — 모든 기기가 공유(QR 의 키).
        let sshClientKeyFingerprint: String?
        /// 등록된 기기들.
        let devices: [Device]

        struct Device: Decodable, Identifiable {
            /// SE 공개키 등록 시각 (epoch ms). 미상이면 nil.
            let registeredAt: Int64?
            /// 마지막 인증 접속 시각 (epoch ms, daemon 부팅 후 in-memory). 기록 없으면 nil.
            let lastSeen: Int64?
            /// SE 공개키 지문 ("SHA256:..."). 해제(revoke) 시 이 값을 키로 쓴다. 「이 기기」
            /// 판정은 `DeviceAttestor.publicKeyFingerprint()` 와 1:1 비교 (같은 포맷).
            let attestKeyFingerprint: String?
            var id: String { attestKeyFingerprint ?? "\(registeredAt ?? 0)" }
        }
    }
    private struct DeviceSlotResponse: Decodable { let ok: Bool?; let extraSlotAllowed: Bool? }
    private struct RevokeDeviceResponse: Decodable { let ok: Bool?; let remaining: Int? }

    /// 등록된 기기 목록 + 슬롯 상태 조회.
    func deviceInfo(label: String? = String(localized: "기기 목록")) async throws -> DeviceInfoResponse {
        try await send("GET", "/api/admin/device-info", label: label)
    }

    /// 추가 기기 슬롯 허용 토글. 끄려는데 이미 1대를 넘게 등록돼 있으면 daemon 이 409 `remove_extra_device_first`.
    func setExtraDeviceSlot(allowed: Bool) async throws {
        struct Body: Encodable { let allowed: Bool }
        let _: DeviceSlotResponse =
            try await send("POST", "/api/admin/device-slot", body: Body(allowed: allowed), label: String(localized: "기기 슬롯 설정"))
    }

    /// 기기 1대를 지문으로 해제(attest 키 제거). 없는 지문이면 daemon 이 404 `device_not_found`.
    func revokeDevice(fingerprint: String) async throws {
        struct Body: Encodable { let fingerprint: String }
        let _: RevokeDeviceResponse =
            try await send("POST", "/api/admin/revoke-device", body: Body(fingerprint: fingerprint), label: String(localized: "기기 해제"))
    }

    // MARK: - Version handshake

    /// daemon ↔ iOS 호환성 핸드셰이크. 부팅 시 (Tor .running + 페어된 상태) 1회 호출.
    ///
    /// 응답 shape 은 `ServerVersionInfo`. daemon 측 `mac/daemon/src/version.ts`
    /// 의 `buildVersionResponse()` 와 짝.
    ///
    /// 옛 daemon (이 라우트를 모르는 빌드) 는 404 를 돌려준다 — caller (VersionCompatStore)
    /// 가 `.httpStatus(404, _)` 를 catch 해서 `hardDaemonUnknown` 으로 분기한다.
    func getServerVersion(label: String? = nil) async throws -> ServerVersionInfo {
        try await send("GET", "/api/version", label: label)
    }

    // MARK: - Workflows (multi-agent)

    /// `GET /api/workflows` — 워크플로우 정의 목록. workflow_v1 미지원 daemon 은 404 —
    /// 호출처(설정 진입)가 capability 게이팅으로 미리 막으므로 도달하지 않는다.
    func listWorkflows(label: String? = String(localized: "워크플로우 목록")) async throws -> [WorkflowSummary] {
        let resp: WorkflowsResponse = try await send("GET", "/api/workflows", label: label)
        return resp.workflows
    }

    /// `POST /api/workflows` — 그래프 정의 생성. daemon 이 그래프(DAG)를 검증 후 저장.
    func createWorkflow(
        _ req: CreateWorkflowRequest,
        label: String? = String(localized: "워크플로우 저장"),
    ) async throws -> WorkflowSummary {
        let resp: WorkflowCreateResponse = try await send("POST", "/api/workflows", body: req, label: label)
        return resp.workflow
    }

    func deleteWorkflow(id: String, label: String? = String(localized: "워크플로우 삭제")) async throws {
        struct Ok: Decodable { let ok: Bool? }
        let _: Ok = try await send("DELETE", "/api/workflows/\(id)", label: label)
    }

    /// `POST /api/workflows/design` — «한 문장으로 설명» 을 설계 에이전트로 보낸다.
    /// 설계는 daemon 백그라운드라 designId(폴링 키)만 즉시 받는다 (workflow_design_v1).
    func designWorkflow(
        _ req: DesignWorkflowRequest,
        label: String? = String(localized: "워크플로우 설계 요청"),
    ) async throws -> WorkflowDesignStartResponse {
        try await send("POST", "/api/workflows/design", body: req, label: label)
    }

    /// `GET /api/workflows/design/:id` — 설계 진행/결과 폴링. ready 면 초안(nodes/edges).
    func workflowDesignState(designId: String, label: String? = nil) async throws -> WorkflowDesignStateResponse {
        try await send("GET", "/api/workflows/design/\(designId)", label: label)
    }

    /// `GET /api/workflows/templates` — 「출발 템플릿」(노드/간선 프리셋) 목록 (workflow_templates_v1).
    /// 옛 daemon 은 이 라우트가 404 — 호출처가 capability(workflow_templates_v1)로 게이팅해 도달 안 함.
    func listWorkflowTemplates(label: String? = String(localized: "워크플로우 템플릿")) async throws -> [WorkflowTemplate] {
        // 프리셋 노드 prompt 를 앱 언어로 (po_locale_v1). GET 이라 쿼리로 싣는다.
        var path = "/api/workflows/templates"
        if let loc = Self.appOutputLocale(), let enc = loc.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) {
            path += "?locale=\(enc)"
        }
        let resp: WorkflowTemplatesResponse = try await send("GET", path, label: label)
        return resp.templates
    }

    /// `GET /api/workflows/:id/sessions` — 이 워크플로우가 (모든 run 에서) 만든 세션 목록.
    /// 워크플로우 탭에서 그 세션들을 보고 삭제하는 데 쓴다.
    func workflowSessions(
        id: String,
        label: String? = String(localized: "워크플로우 세션"),
    ) async throws -> [WorkflowSessionRow] {
        struct Resp: Decodable { let sessions: [WorkflowSessionRow] }
        let resp: Resp = try await send("GET", "/api/workflows/\(id)/sessions", label: label)
        return resp.sessions
    }

    /// `PUT /api/workflows/:id` — 그래프(노드/간선) 갱신. daemon 이 DAG 재검증 후 저장.
    func updateWorkflow(
        id: String,
        nodes: [WorkflowNodeDef],
        edges: [WorkflowEdgeDef],
        label: String? = String(localized: "워크플로우 저장"),
    ) async throws -> WorkflowSummary {
        struct Req: Encodable {
            let nodes: [WorkflowNodeDef]
            let edges: [WorkflowEdgeDef]
        }
        let resp: WorkflowCreateResponse = try await send(
            "PUT",
            "/api/workflows/\(id)",
            body: Req(nodes: nodes, edges: edges),
            label: label,
        )
        return resp.workflow
    }

    /// `POST /api/workflows/:id/run` — 실행 시작. runId 즉시 반환 (진행은 daemon 백그라운드).
    func runWorkflow(id: String, label: String? = String(localized: "워크플로우 실행")) async throws -> String {
        let resp: WorkflowRunStartResponse = try await send("POST", "/api/workflows/\(id)/run", label: label)
        return resp.runId
    }

    func workflowDetail(id: String, label: String? = nil) async throws -> WorkflowDetailResponse {
        try await send("GET", "/api/workflows/\(id)", label: label)
    }

    /// `GET /api/workflows/runs/:id` — run 상태 (def 노드/간선 + 노드별 라이브 상태). 캔버스가 폴링.
    func workflowRunState(runId: String, label: String? = nil) async throws -> WorkflowRunStateResponse {
        try await send("GET", "/api/workflows/runs/\(runId)", label: label)
    }

    func cancelWorkflowRun(runId: String, label: String? = String(localized: "워크플로우 취소")) async throws {
        struct Ok: Decodable { let ok: Bool? }
        let _: Ok = try await send("POST", "/api/workflows/runs/\(runId)/cancel", label: label)
    }

    /// 노드 결정 — action ∈ approve|reject(승인 게이트) / complete|retry(수동 개입).
    /// nid = node_run id. 진행 중 run 의 대기 노드에만 적용된다.
    func workflowNodeDecision(
        runId: String,
        nodeRunId: String,
        action: String,
        label: String? = String(localized: "워크플로우 결정"),
    ) async throws {
        struct Ok: Decodable { let ok: Bool? }
        let _: Ok = try await send("POST", "/api/workflows/runs/\(runId)/nodes/\(nodeRunId)/\(action)", label: label)
    }

    // MARK: - PO 루프 (백로그)

    /// PO 산출(브리프·리서치 보고서)을 «사용자 앱 언어» 로 받기 위해 collect/research/revise 요청
    /// body 에 싣는 로케일 코드 (po_locale_v1). `preferredLocalizations` 는 사용자 선호 언어와
    /// «번들에 실제 있는 로컬라이제이션» 의 교집합 최선값이라, 자연히 이 앱이 지원하는 10개 집합
    /// (ar/en/es/fr/hi/ja/ko/pt-BR/ru/zh-Hans) 중 «지금 표시 중인» 하나로 정규화된다
    /// (WhisperSpeechRecognizer.appLocale 의 preferredLanguages 패턴과 같은 의도 — 표시 언어 기준).
    /// daemon 이 normalizePoLocale 로 한 번 더 거르므로, ko/누락/미지원이면 한국어 산출로 graceful
    /// fallback (회귀 0). ko 도 그대로 보낸다 — daemon 이 ko 와 누락을 동일하게 한국어 산출로 취급.
    // nonisolated — Bundle.main 만 읽어 스레드 안전. DesignWorkflowRequest 의 기본값(비-격리 컨텍스트)
    // 에서도 호출 가능해야 하므로 메인 액터 격리에서 뺀다 (기존 호출부는 격리 컨텍스트라 그대로 OK).
    nonisolated static func appOutputLocale() -> String? {
        Bundle.main.preferredLocalizations.first
    }

    /// `GET /api/po/briefs` — 기회 브리프 목록. po_loop_v1 미지원 daemon 은 404 — 백로그 탭
    /// 자체가 capability 게이트로 숨겨지므로 정상 경로에선 도달하지 않는다.
    func listPoBriefs(label: String? = nil) async throws -> [PoBrief] {
        let resp: PoBriefsResponse = try await send("GET", "/api/po/briefs", label: label)
        return resp.briefs
    }

    /// `GET /api/po/collect/last?repoPath=` — 직전 수집의 «App Store 신호원 실행 상태»
    /// (po_signal_status_v1). 수집을 시작한 뒤 폴링해, 응답 sessionId 가 방금 시작한 수집과
    /// 일치하면 그 수집의 store/crash 신호가 실제 반영됐는지(혹은 키/네트워크로 빠졌는지)를
    /// «수집 결과 카드» 로 띄운다. 미지원(옛) daemon 은 404 → 호출부가 capability 게이트로 막거나
    /// 조용히 폴백(카드 없음). signals=nil = 아직 수집 없음/신호 안 켬 → 카드 침묵.
    func getLastCollectSignals(repoPath: String, label: String? = nil) async throws -> LastCollectSignals {
        let q = repoPath.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? repoPath
        return try await send("GET", "/api/po/collect/last?repoPath=\(q)", label: label)
    }

    /// `GET /api/po/stats` — 누적 성적표 (po_stats_v1). repoPath 로 레포 필터 (nil = 전체 +
    /// 레포별 분해). 미지원 daemon 은 404 — 호출부가 capability 게이트로 막는다 (soft).
    func getPoStats(repoPath: String? = nil, label: String? = nil) async throws -> PoStats {
        var path = "/api/po/stats"
        if let repoPath {
            let q = repoPath.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? repoPath
            path += "?repoPath=\(q)"
        }
        return try await send("GET", path, label: label)
    }

    /// `POST /api/po/collect` — PO 신호 수집 시작. 즉시 수집 세션 id 를 돌려준다 (관전용).
    /// 브리프 ingest 는 daemon 백그라운드 — 끝나면 Discord 알림(po_briefs) + 목록 새로고침으로 확인.
    /// `instruction` — 사용자의 대략적 지시 (선택). 있으면 PO 에이전트가 그것을 중심으로 브리프를 만든다.
    /// `agent` — 수집을 돌릴 코드 에이전트 (po_agent_v1). nil 이면 필드 생략 → daemon 기본(claude_code).
    /// `lens` — 수집 «전문가 관점» (po_collect_lens_v1). "design" 이면 코드 기회 대신 UI 디자인 부채를
    /// 디자인 SSOT 대비로 발굴(옛 persona="designer" 와 동치), "bug" 면 디버깅·신뢰성 신호를 우선 모은다.
    /// nil/"default" 면 필드 생략 → daemon 기본(전방위 수집). 옛 daemon 은 이 필드를 조용히 버려 기본
    /// 수집으로 돈다 (그래서 호출처가 capability 보고 피커 노출을 분기 — soft).
    /// `gh` / `asc` — 응답에 신호 가용성 점검 메타 (po_gh_check_v1 / po_asc_check_v1). 옛 daemon/
    /// 불확실 점검은 필드를 안 보내 nil — 호출처가 nil 이면 아무 안내도 안 띄운다 (soft).
    func startPoCollection(
        repoPath: String,
        instruction: String? = nil,
        agent: String? = nil,
        lens: String? = nil,
        label: String? = String(localized: "신호 수집 시작"),
    ) async throws -> PoCollectStart {
        struct Req: Encodable {
            let repoPath: String
            let instruction: String?
            let agent: String?
            let lens: String?
            let locale: String?
        }
        struct Resp: Decodable {
            let sessionId: String
            let gh: GhCollectCheck?
            let asc: AscCollectCheck?
        }
        let resp: Resp = try await send(
            "POST", "/api/po/collect",
            body: Req(
                repoPath: repoPath, instruction: instruction, agent: agent, lens: lens,
                locale: Self.appOutputLocale()),
            label: label)
        return PoCollectStart(sessionId: resp.sessionId, gh: resp.gh, asc: resp.asc)
    }

    /// `POST /api/po/briefs/:id/decide` — 결재. approve 는 구현 세션을 spawn 하고 그 id 를
    /// 함께 돌려준다 (iOS 가 곧장 세션 탭으로 전환해 딥링크).
    /// `useWorktree` — approve 전용 (po_worktree_v1). true 면 daemon 이 새 worktree 를 만들어
    /// 그 안에서 구현 — 동시 세션 간 작업트리 충돌 방지. nil 이면 필드 자체를 안 보낸다.
    /// `agent` — approve 전용 (po_agent_v1). 구현 세션을 돌릴 코드 에이전트. nil 이면 필드 생략.
    /// `mode` — approve 전용 (po_workflow_v1). "workflow" 면 설계 에이전트가 브리프 맞춤
    /// 워크플로우(스펙→구현→자가검증→사람 게이트)를 만들어 run 으로 실행한다. 이때
    /// execSessionId 는 설계 세션(관전용). nil 이면 필드 생략 → 세션 모드 (구 daemon 호환).
    func decidePoBrief(
        id: String,
        action: String,
        useWorktree: Bool? = nil,
        agent: String? = nil,
        mode: String? = nil,
        reason: String? = nil,
        note: String? = nil,
        label: String? = String(localized: "브리프 결정"),
    ) async throws -> (brief: PoBrief, execSessionId: String?) {
        struct Req: Encodable {
            let action: String
            let useWorktree: Bool?
            let agent: String?
            let mode: String?
            let reason: String?
            let note: String?
            // 산출 언어 (po_locale_v1) — approve 시 구현 세션 프롬프트를 앱 언어로.
            let locale: String?
        }
        struct Resp: Decodable { let brief: PoBrief; let execSessionId: String? }
        let resp: Resp = try await send(
            "POST", "/api/po/briefs/\(id)/decide",
            body: Req(action: action, useWorktree: useWorktree, agent: agent, mode: mode, reason: reason, note: note, locale: Self.appOutputLocale()),
            label: label)
        return (resp.brief, resp.execSessionId)
    }

    /// `POST /api/po/briefs/bulk/decide` — 일괄 결재 (po_bulk_decide_v1). 트리아지에서 다중
    /// 선택한 브리프를 한 콜로 보류/기각한다. hold/reject «만» — approve 는 brief 마다 세션을
    /// spawn 하므로 일괄 대상이 아니다(단건 `decidePoBrief` 만 approve). 없는/이미 처리된 id 는
    /// `skipped` 로 돌아온다(부분 성공). 옛 daemon(미지원)은 이 라우트가 404 → 호출처가
    /// capability 를 보고 단건 decide 루프로 폴백한다.
    func bulkDecidePoBriefs(
        ids: [String],
        action: String,
        reason: String? = nil,
        note: String? = nil,
        label: String? = String(localized: "일괄 결재"),
    ) async throws -> (updated: [PoBrief], skipped: [PoBulkSkip]) {
        struct Req: Encodable {
            let ids: [String]
            let action: String
            let reason: String?
            let note: String?
        }
        struct Resp: Decodable {
            let updated: [PoBrief]
            let skipped: [PoBulkSkip]
        }
        let resp: Resp = try await send(
            "POST", "/api/po/briefs/bulk/decide",
            body: Req(ids: ids, action: action, reason: reason, note: note), label: label)
        return (resp.updated, resp.skipped)
    }

    /// `POST /api/po/briefs/:id/cleanup` — 기각된 브리프의 «코드 흔적 정리» 세션 spawn
    /// (po_cleanup_v1). 기각된 아이디어의 TODO 주석·죽은 코드를 지워 다음 수집의 같은 제안
    /// 반복을 막는다. 즉시 (갱신된 브리프, 정리 세션 id) 반환 — iOS 가 세션 탭으로 딥링크.
    /// `agent` — 정리를 돌릴 코드 에이전트 (po_agent_v1). nil 이면 필드 생략 → daemon 기본.
    func cleanupPoBrief(
        id: String,
        agent: String? = nil,
        label: String? = String(localized: "코드 흔적 정리"),
    ) async throws -> (brief: PoBrief, cleanupSessionId: String) {
        struct Req: Encodable { let agent: String?; let locale: String? }
        struct Resp: Decodable { let brief: PoBrief; let cleanupSessionId: String }
        let resp: Resp = try await send(
            "POST", "/api/po/briefs/\(id)/cleanup",
            body: Req(agent: agent, locale: Self.appOutputLocale()), label: label)
        return (resp.brief, resp.cleanupSessionId)
    }

    /// `DELETE /api/po/briefs/:id` — 처리 끝난 브리프 정리.
    func deletePoBrief(id: String, label: String? = String(localized: "브리프 삭제")) async throws {
        struct Ok: Decodable { let ok: Bool? }
        let _: Ok = try await send("DELETE", "/api/po/briefs/\(id)", label: label)
    }

    /// `POST /api/po/briefs/:id/restart` — 진행 중(running) 브리프의 «구현 다시 시작»
    /// (po_exec_restart_v1). 구현 세션을 임의로 정지하거나 세션이 깔끔한 정착 없이 죽으면 브리프가
    /// running 에 영원히 남는다 — 이 호출이 같은 브리프·결재 컨텍스트(결재 사유·출처·impact/effort)를
    /// 보존한 채 새 구현 세션을 spawn 하고 exec_session_id 만 교체한다(상태 running 유지). 삭제→재승인과
    /// 달리 승인 이력이 남는다. 즉시 (갱신된 브리프, 새 구현 세션 id) 반환 — iOS 가 세션 탭으로 딥링크.
    /// `agent` — 구현을 돌릴 코드 에이전트. nil 이면 필드 생략 → daemon 이 브리프에 기록된 에이전트 재사용.
    func restartPoBriefExec(
        id: String,
        agent: String? = nil,
        label: String? = String(localized: "구현 다시 시작"),
    ) async throws -> (brief: PoBrief, execSessionId: String) {
        struct Req: Encodable { let agent: String?; let locale: String? }
        struct Resp: Decodable { let brief: PoBrief; let execSessionId: String }
        let resp: Resp = try await send(
            "POST", "/api/po/briefs/\(id)/restart",
            body: Req(agent: agent, locale: Self.appOutputLocale()), label: label)
        return (resp.brief, resp.execSessionId)
    }

    /// `POST /api/po/research` — 주제 기반 리서치(웹+레포 또는 레포만 조사 → 보고서+브리프) 시작.
    /// 즉시 (researchId, 관전용 sessionId) 반환 — 완료는 수 분 뒤 (Discord 알림 + 새로고침).
    /// `agent` — 조사를 돌릴 코드 에이전트 (po_agent_v1). nil 이면 필드 생략 → daemon 기본.
    /// `lens` — «전문가 관점» 렌즈 (po_research_lens_v1). nil/"default"(전방위)면 머리말 없이 기존
    /// 리서치. "design"/"bug" 면 daemon 이 렌즈별 머리말을 주입. 옛 daemon 은 lens 를 조용히 버린다.
    /// `scope` — 조사 범위 (po_research_scope_v1). "repo_only" 면 웹 검색 없이 레포만. nil 이면
    /// 필드 생략 → daemon 기본(웹+레포) — 옛 daemon 호환. lens 와 직교(함께 보낼 수 있다).
    /// `screens` — UX 렌즈 «화면 포함» (po_research_ux_screens_v1). true 면 ux 리서치가 «렌더된 화면» 을
    /// 캡처해 그 화면으로 휴리스틱을 판정한다(화면 못 얻으면 코드+웹 graceful fallback). nil 이면 필드
    /// 생략 → daemon 기본(코드+웹) — 옛 daemon 호환. ux 렌즈에서만 의미 (호출부가 lens=="ux" 일 때만 보냄).
    func startPoResearch(
        repoPath: String,
        topic: String,
        agent: String? = nil,
        lens: String? = nil,
        scope: String? = nil,
        screens: Bool? = nil,
        label: String? = String(localized: "리서치 시작"),
    ) async throws -> (researchId: String, sessionId: String) {
        struct Req: Encodable {
            let repoPath: String
            let topic: String
            let agent: String?
            let lens: String?
            let scope: String?
            let screens: Bool?
            let locale: String?
        }
        struct Resp: Decodable { let researchId: String; let sessionId: String }
        let resp: Resp = try await send(
            "POST", "/api/po/research",
            body: Req(
                repoPath: repoPath, topic: topic, agent: agent, lens: lens, scope: scope,
                screens: screens, locale: Self.appOutputLocale()),
            label: label)
        return (resp.researchId, resp.sessionId)
    }

    /// `GET /api/po/research` — 리서치 목록 (보고서 본문 제외).
    func listPoResearch(label: String? = nil) async throws -> [PoResearch] {
        struct Resp: Decodable { let research: [PoResearch] }
        let resp: Resp = try await send("GET", "/api/po/research", label: label)
        return resp.research
    }

    /// `GET /api/po/research/:id` — 리서치 상세 (보고서 본문 포함).
    func getPoResearch(id: String, label: String? = nil) async throws -> PoResearch {
        struct Resp: Decodable { let research: PoResearch }
        let resp: Resp = try await send("GET", "/api/po/research/\(id)", label: label)
        return resp.research
    }

    /// `DELETE /api/po/research/:id` — 끝난 리서치 정리.
    func deletePoResearch(id: String, label: String? = String(localized: "리서치 삭제")) async throws {
        struct Ok: Decodable { let ok: Bool? }
        let _: Ok = try await send("DELETE", "/api/po/research/\(id)", label: label)
    }

    /// `GET /api/po/profile` — 프로젝트별 «조사 방식» 프로필 + 주기 수집 schedule.
    /// 없으면 (directive: "", schedule: nil). 구 daemon 응답엔 schedule 키가 없음 → nil.
    func getPoProfile(repoPath: String, label: String? = nil) async throws -> PoProfile {
        let q = repoPath.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? repoPath
        return try await send("GET", "/api/po/profile?repoPath=\(q)", label: label)
    }

    /// `PUT /api/po/profile` — 조사 방식 + 주기 수집 + 스토어 리뷰 + 피드백 repo + 주기 수집 렌즈 저장
    /// (모두 비우면 삭제). schedule 은 5필드 cron 식 (nil = 주기 수집 꺼짐). ascAppId 는 ASC
    /// 앱 ID/번들 ID (nil = 스토어 리뷰 꺼짐). githubFeedbackRepo 는 owner/name (nil = 로컬
    /// origin). lens 는 주기 수집 «전문가 관점» (po_collect_lens_v1, nil = 미변경/전방위). 형식 오류는
    /// daemon 이 400 (invalid_feedback_repo) — 호출부가 검증 안내를 띄운다. 구 daemon 은 모르는 필드를 무시한다.
    func setPoProfile(
        repoPath: String,
        directive: String,
        schedule: String? = nil,
        ascAppId: String? = nil,
        githubFeedbackRepo: String? = nil,
        lens: String? = nil,
        label: String? = String(localized: "조사 방식 저장"),
    ) async throws {
        struct Req: Encodable {
            let repoPath: String
            let directive: String
            let schedule: String?
            let ascAppId: String?
            let githubFeedbackRepo: String?
            let lens: String?
        }
        struct Resp: Decodable { let directive: String }
        let _: Resp = try await send(
            "PUT", "/api/po/profile",
            body: Req(
                repoPath: repoPath, directive: directive, schedule: schedule,
                ascAppId: ascAppId, githubFeedbackRepo: githubFeedbackRepo, lens: lens),
            label: label)
    }

    /// `POST /api/po/design-directive/bootstrap` — 디자이너 에이전트가 레포 디자인 SSOT 를 스캔해
    /// design_directive 초안을 만들기 시작한다 (po_design_bootstrap_v1). 즉시 세션 id 반환 —
    /// 초안 산출은 백그라운드, 끝나면 GET /profile 의 designDirectiveDraft 가 채워진다. 이미 생성
    /// 중이면 daemon 이 400 (bootstrap_failed).
    func startPoDesignBootstrap(
        repoPath: String,
        label: String? = String(localized: "디자인 초안 생성"),
    ) async throws -> String {
        struct Req: Encodable { let repoPath: String; let locale: String? }
        struct Resp: Decodable { let sessionId: String }
        let resp: Resp = try await send(
            "POST", "/api/po/design-directive/bootstrap",
            body: Req(repoPath: repoPath, locale: Self.appOutputLocale()), label: label)
        return resp.sessionId
    }

    /// `POST /api/po/design-directive/approve` — 검토(가능하면 편집)한 directive 를 승인해
    /// design_directive(선언된 강신호)로 «복사» 하고 초안을 정리한다. directive 를 주면 그 편집본을,
    /// nil 이면 저장된 초안을 그대로 승인한다. 이 호출만이 design_directive 를 켜는 사람-게이트다.
    func approvePoDesignDirective(
        repoPath: String,
        directive: String? = nil,
        label: String? = String(localized: "디자인 승인"),
    ) async throws {
        struct Req: Encodable {
            let repoPath: String
            let directive: String?
        }
        struct Resp: Decodable { let designDirective: String? }
        let _: Resp = try await send(
            "POST", "/api/po/design-directive/approve",
            body: Req(repoPath: repoPath, directive: directive), label: label)
    }

    /// `DELETE /api/po/design-directive/draft` — 초안 버리기(승인 안 함). 이미 선언된
    /// design_directive 는 건드리지 않는다.
    func discardPoDesignDraft(
        repoPath: String,
        label: String? = String(localized: "디자인 초안 버리기"),
    ) async throws {
        struct Ok: Decodable { let ok: Bool? }
        let q = repoPath.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? repoPath
        let _: Ok = try await send("DELETE", "/api/po/design-directive/draft?repoPath=\(q)", label: label)
    }

    /// `POST /api/po/briefs/:id/revise` — 수정 지시(티켓 코멘트)로 브리프 재종합 시작.
    /// 즉시 재종합 세션 id 반환 — 끝나면 브리프 내용이 갱신되고 revisingSessionId 가 비워진다.
    func revisePoBrief(
        id: String,
        comment: String,
        label: String? = String(localized: "수정 지시"),
    ) async throws -> String {
        struct Req: Encodable {
            let comment: String
            let locale: String?
        }
        struct Resp: Decodable { let sessionId: String }
        let resp: Resp = try await send(
            "POST", "/api/po/briefs/\(id)/revise",
            body: Req(comment: comment, locale: Self.appOutputLocale()), label: label)
        return resp.sessionId
    }

    // MARK: - Sessions

    /// `label` 을 nil 로 보내면 트래커에서 제외된다. 폴링/백그라운드 자동 새로고침이 그렇게 호출한다.
    func listSessions(label: String? = String(localized: "세션 목록")) async throws -> [SessionSummary] {
        let resp: SessionsResponse = try await send("GET", "/api/sessions", label: label)
        return resp.sessions
    }

    /// «보관함» 세션 목록 (session_archive_v1) — `?archived=1` 로 보관된 세션만 받는다. 기본
    /// 목록(listSessions)은 미보관만 반환하므로 둘을 분리해, 보관 세션이 100 캡을 잠식해 활성
    /// 목록을 가리지 않게 한다. 사용자가 «보관함» 을 열 때만 호출(lazy). 옛 daemon (session_archive_v1
    /// 미지원) 은 archived 쿼리를 무시해 미보관 목록을 돌려주지만, 그쪽엔 보관 세션 자체가 없어
    /// 호출처가 capability 로 진입을 막는다.
    func listArchivedSessions(label: String? = String(localized: "보관함")) async throws -> [SessionSummary] {
        let resp: SessionsResponse = try await send("GET", "/api/sessions?archived=1", label: label)
        return resp.sessions
    }

    func createSession(
        repoPath: String,
        title: String?,
        resumeFrom: String? = nil,
        skipPermissions: Bool = false,
        mode: String? = nil,
        agent: String? = nil,
        label: String? = String(localized: "세션 생성"),
    ) async throws -> String {
        let resp: CreateSessionResponse = try await send(
            "POST",
            "/api/sessions",
            body: CreateSessionRequest(
                repoPath: repoPath,
                title: title,
                resumeFrom: resumeFrom,
                // 명시적으로 true 일 때만 전송. false 면 body 에서 생략해 구 daemon 호환.
                skipPermissions: skipPermissions ? true : nil,
                mode: mode,
                agent: agent,
            ),
            label: label,
        )
        return resp.sessionId
    }

    /// `GET /api/agents` — 등록된 코드 에이전트 CLI 목록. iOS picker 가 부팅 시 한 번
    /// 호출. multi_agent_v1 capability 가 없는 옛 daemon 은 404 — 호출처가 throw 를
    /// 잡아 fallback (claude_code 만) 으로 대체.
    func listAgents(
        label: String? = String(localized: "코드 에이전트 목록"),
    ) async throws -> [AgentInfo] {
        let resp: AgentsResponse = try await send("GET", "/api/agents", label: label)
        return resp.agents
    }

    /// 로컬 LLM 세부 상태 — 바이너리(llamaServer/qwen/aria2c) + 선택/추천 모델 + 다운로드 진행
    /// + 하드웨어 + 서버. 새 세션 시트가 「무엇이 준비됐고 무엇이 빠졌는지」 를 상태 카드로 표면화
    /// 하고, 다운로드 진행 폴링에도 같은 메서드를 쓴다(daemon 이 진행을 들고 있어 재연결 시 복구).
    func localLlmStatus(label: String? = nil) async throws -> LocalLlmStatus {
        try await send("GET", "/api/local-llm/status", label: label)
    }

    /// 모델 카탈로그 + downloaded 플래그 + 추천/선택 모델. 폰에서 받을 모델을 고르는 데 쓴다.
    func localLlmModels(label: String? = nil) async throws -> LocalLlmCatalogResponse {
        try await send("GET", "/api/local-llm/models", label: label)
    }

    /// 모델 다운로드 시작(동시 1개). 디스크 부족(insufficient_disk)·이미 받는 중(busy)·실패는
    /// HTTP 에러로 올라와 ApiError 가 사람이 읽는 사유로 변환한다.
    func downloadLocalLlmModel(_ modelId: String, label: String? = nil) async throws {
        struct Req: Encodable { let modelId: String }
        struct Resp: Decodable { let ok: Bool? }
        let _: Resp = try await send("POST", "/api/local-llm/download", body: Req(modelId: modelId), label: label)
    }

    /// 진행 중 다운로드 취소. 서버가 진행을 정리하고 다음 status 폴링에서 idle 로 돌아온다.
    func cancelLocalLlmDownload(label: String? = nil) async throws {
        struct Resp: Decodable { let ok: Bool? }
        let _: Resp = try await send("POST", "/api/local-llm/download/cancel", label: label)
    }

    /// 선택 모델 저장(config.localLlm.selectedModelId). 실행 중 서버는 자동 교체하지 않는다.
    func selectLocalLlmModel(_ modelId: String, label: String? = nil) async throws {
        struct Req: Encodable { let modelId: String }
        struct Resp: Decodable { let ok: Bool? }
        let _: Resp = try await send("POST", "/api/local-llm/select", body: Req(modelId: modelId), label: label)
    }

    /// `GET /api/opencode/external` — OpenCode 「내 로컬 서버 사용」 외부 엔드포인트 설정 조회.
    /// 미설정이면 daemon 이 기본값(비활성 + Ollama 기본 baseURL)을 채워 돌려준다. 라우트 자체가
    /// 없는 옛 daemon 은 404 → 호출처가 capability(opencode_external_v1) 로 진입을 막아 도달 안 함.
    func opencodeExternal(label: String? = nil) async throws -> OpencodeExternalConfig {
        try await send("GET", "/api/opencode/external", label: label)
    }

    /// `PUT /api/opencode/external` — 외부 엔드포인트 설정 저장. 끌 때(enabled=false)는 baseURL/
    /// 모델이 비어도 허용, 켤 때만 daemon 이 엄격히 검증(400 invalid_base_url/missing_model_id).
    /// 응답은 정규화된 최종 설정 — 저장 후 그대로 화면 상태로 반영한다.
    @discardableResult
    func setOpencodeExternal(
        _ cfg: OpencodeExternalConfig,
        label: String? = String(localized: "로컬 서버 설정 저장"),
    ) async throws -> OpencodeExternalConfig {
        try await send("PUT", "/api/opencode/external", body: cfg, label: label)
    }

    /// `POST /api/opencode/external/verify` — /v1/models 헬스체크. body 를 주면 그 값으로(저장 전
    /// «확인»), 안 주면 저장된 설정으로 검증. 도달성 + 설정 모델 존재를 봐 «막다른 길»(연결했더니
    /// 서버가 없거나 모델명이 틀림)을 사전 차단한다. probe 는 절대 throw 하지 않아 항상 200.
    func verifyOpencodeExternal(
        baseUrl: String,
        modelId: String,
        label: String? = String(localized: "로컬 서버 연결 확인"),
    ) async throws -> OpencodeExternalProbe {
        struct Req: Encodable { let baseUrl: String; let modelId: String }
        return try await send("POST", "/api/opencode/external/verify", body: Req(baseUrl: baseUrl, modelId: modelId), label: label)
    }

    /// `POST /api/admin/install-agent` — 폰에서 고른 어댑터의 CLI 를 Mac 에 설치 시작.
    ///
    /// 클라이언트는 어댑터 id 만 보내고, daemon 은 자기 installHint **상수** 명령을 실행한다
    /// (임의 명령 실행 아님). installHint 가 URL (agy) 이거나 없으면 daemon 이 400
    /// `not_installable` — 호출처가 미리 `installHintIsCommand` 로 막아 도달하지 않는다.
    /// 다른 어댑터가 이미 설치 중이면 409 `busy` (같은 어댑터면 기존 진행에 합류).
    ///
    /// 반환은 시작 시점 스냅샷 — 이후 진행은 `agentInstallStatus()` 폴링으로 읽는다.
    @discardableResult
    func installAgent(
        adapterId: String,
        label: String? = String(localized: "에이전트 설치 시작"),
    ) async throws -> AgentInstallProgress {
        struct Body: Encodable { let adapterId: String }
        return try await send("POST", "/api/admin/install-agent", body: Body(adapterId: adapterId), label: label)
    }

    /// `POST /api/admin/install-agent { component }` — local_llm 런타임 구성요소(llama-server /
    /// qwen)를 Mac 에 설치 시작. CLI 설치와 같은 라우트·진행 폴링을 재사용한다.
    ///
    /// 클라이언트는 component 키만 보내고, daemon 은 whitelist 상수 명령(brew/npm)을 실행한다
    /// (임의 명령 실행 아님). 진행 스냅샷의 `adapterId` 는 `local_llm/<component>` — 폰이 어느
    /// 구성요소가 설치 중인지 이 값으로 매칭한다. 다른 대상이 설치 중이면 409 `busy`.
    /// install_runtime_v1 capability 가 없는 옛 daemon 은 400 (unknown_component/not_installable).
    @discardableResult
    func installLocalLlmComponent(
        _ component: String,
        label: String? = String(localized: "로컬 LLM 런타임 설치 시작"),
    ) async throws -> AgentInstallProgress {
        struct Body: Encodable { let component: String }
        return try await send("POST", "/api/admin/install-agent", body: Body(component: component), label: label)
    }

    /// `GET /api/admin/install-agent/status` — 설치 진행 폴링 (로그/상태/종료코드).
    /// 폴링이 자주 부르므로 default label nil — in-flight 배너 노이즈 방지.
    func agentInstallStatus(label: String? = nil) async throws -> AgentInstallProgress {
        try await send("GET", "/api/admin/install-agent/status", label: label)
    }

    /// 특정 agent 의 데스크탑 세션 목록 (이어받기 후보) — 해당 repoPath 한정.
    ///
    /// agent="claude_code" 일 땐 옛 `/api/claude-code-sessions` alias 를 사용 — 옛 daemon
    /// (multi_agent_v1 미지원) 도 응답하므로 호환 유지. 그 외 agent 는 generic
    /// `/api/agents/:agentId/desktop-sessions` 라우트.
    ///
    /// 옛 daemon 에 claude_code 외 agent 를 호출하는 케이스는 도달 불가 — 옛 daemon 은
    /// `GET /api/agents` 도 404 라 iOS picker 가 claude_code fallback 만 노출하기 때문.
    func desktopSessions(
        agentId: String,
        repoPath: String,
        label: String? = String(localized: "이어가기 후보 찾기"),
    ) async throws -> [DesktopSession] {
        let q = repoPath.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? repoPath
        let path = agentId == "claude_code"
            ? "/api/claude-code-sessions?repoPath=\(q)"
            : "/api/agents/\(agentId)/desktop-sessions?repoPath=\(q)"
        let resp: DesktopSessionsResponse = try await send("GET", path, label: label)
        return resp.sessions
    }

    /// 폴링이 자주 부르는 메서드 — default label 을 nil 로 둬서, 명시적으로 label 을 넘기지 않는 한
    /// 트래커에 노이즈를 만들지 않는다.
    func getSession(_ id: String, label: String? = nil) async throws -> SessionDetailResponse {
        try await send("GET", "/api/sessions/\(id)", label: label)
    }

    /// 세션의 repo_path 에서 현재 git 브랜치 — ChatView 상태바에 표시.
    /// daemon 이 git 미설치 / 비-git repo 등을 모두 `branch == nil` 로 흡수하므로 별도 분기 불필요.
    /// 폴링이 아니라 진입/턴 종료 후 한 번씩 fetch — `label: nil` 로 in-flight tracker 노이즈 차단.
    func gitBranch(sessionId: String, label: String? = nil) async throws -> String? {
        struct R: Decodable { let branch: String? }
        let r: R = try await send("GET", "/api/sessions/\(sessionId)/git/branch", label: label)
        return r.branch
    }

    /// 세션의 repo_path 에서 커밋되지 않은 변경 파일 목록과 가벼운 +/- 통계.
    /// daemon `session_git_status_v1` 미지원이거나 repo 가 아니면 `total == 0` 이 돌아온다.
    /// 폴링 cycle 에 합류하므로 default label 은 nil.
    func gitStatus(sessionId: String, label: String? = nil) async throws -> GitStatusResponse {
        try await send("GET", "/api/sessions/\(sessionId)/git/status", label: label)
    }

    /// 한 파일의 unified diff 본문. tracked 면 `git diff HEAD -- <path>`, untracked 면
    /// 가짜 unified diff (전 라인 +). binary 또는 truncated 시 그 flag 가 응답에 같이 온다.
    /// 사용자가 시트에서 파일을 선택할 때마다 호출 — 트래커에 보이도록 label 기본값 둠.
    func gitDiff(
        sessionId: String,
        path: String,
        label: String? = String(localized: "변경 내역"),
    ) async throws -> GitFileDiffResponse {
        // path 는 repo-relative — daemon 도 절대경로/상위참조를 거절한다.
        let encoded = path.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? path
        return try await send("GET", "/api/sessions/\(sessionId)/git/diff?path=\(encoded)", label: label)
    }

    // MARK: - Git 브랜치 / worktree (BranchSheet)

    /// 로컬 + 원격 브랜치 목록. 비-repo / git 미설치면 모두 빈 채로 온다 (UI 가 빈 상태 안내).
    func gitBranches(
        sessionId: String,
        label: String? = String(localized: "브랜치 목록"),
    ) async throws -> GitBranchesResponse {
        try await send("GET", "/api/sessions/\(sessionId)/git/branches", label: label)
    }

    /// worktree 목록. 비-repo 면 빈 배열.
    func gitWorktrees(
        sessionId: String,
        label: String? = String(localized: "worktree 목록"),
    ) async throws -> GitWorktreesResponse {
        try await send("GET", "/api/sessions/\(sessionId)/git/worktrees", label: label)
    }

    /// 브랜치 전환(checkout). `track: true` 면 원격추적 브랜치(예 "origin/foo")를 받아 로컬
    /// 추적 브랜치를 만들며 전환. 미커밋 변경 충돌 등 실패는 `GitOperationError` 로 매핑.
    func checkoutBranch(
        sessionId: String,
        name: String,
        track: Bool = false,
        label: String? = String(localized: "브랜치 전환"),
    ) async throws {
        struct Body: Encodable { let name: String; let track: Bool }
        struct OK: Decodable { let ok: Bool? }
        do {
            let _: OK = try await send(
                "POST",
                "/api/sessions/\(sessionId)/git/checkout",
                body: Body(name: name, track: track),
                label: label,
            )
        } catch {
            throw Self.mapGitError(error)
        }
    }

    /// 새 브랜치 생성. `checkout: true` 면 생성 후 바로 전환.
    func createBranch(
        sessionId: String,
        name: String,
        from: String? = nil,
        checkout: Bool = false,
        label: String? = String(localized: "브랜치 생성"),
    ) async throws {
        struct Body: Encodable { let name: String; let from: String?; let checkout: Bool }
        struct OK: Decodable { let ok: Bool? }
        do {
            let _: OK = try await send(
                "POST",
                "/api/sessions/\(sessionId)/git/branch",
                body: Body(name: name, from: from, checkout: checkout),
                label: label,
            )
        } catch {
            throw Self.mapGitError(error)
        }
    }

    /// 브랜치 삭제(로컬 전용). 병합 안 된 브랜치라 실패하면(409) 호출부가 `force: true` 로
    /// 재시도할 수 있다(`git branch -D`). 현재 브랜치는 daemon 이 막는다.
    func deleteBranch(
        sessionId: String,
        name: String,
        force: Bool = false,
        label: String? = String(localized: "브랜치 삭제"),
    ) async throws {
        struct OK: Decodable { let ok: Bool? }
        let encoded = name.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? name
        let q = force ? "?name=\(encoded)&force=1" : "?name=\(encoded)"
        do {
            let _: OK = try await send(
                "DELETE",
                "/api/sessions/\(sessionId)/git/branch\(q)",
                label: label,
            )
        } catch {
            throw Self.mapGitError(error)
        }
    }

    /// worktree 생성 — daemon 이 인접 경로를 자동 산정해 만든 뒤 그 경로를 돌려준다.
    /// `newBranch: true` 면 새 브랜치를 만들며, 아니면 기존 브랜치를 체크아웃.
    @discardableResult
    func addWorktree(
        sessionId: String,
        branch: String,
        newBranch: Bool,
        from: String? = nil,
        label: String? = String(localized: "worktree 생성"),
    ) async throws -> GitWorktree {
        struct Body: Encodable { let branch: String; let newBranch: Bool; let from: String? }
        struct Resp: Decodable { let path: String; let branch: String }
        do {
            let resp: Resp = try await send(
                "POST",
                "/api/sessions/\(sessionId)/git/worktrees",
                body: Body(branch: branch, newBranch: newBranch, from: from),
                label: label,
            )
            // 방금 만든 worktree 는 detached 아님 · main/current 아님이 자명 — 목록 재조회 없이 구성.
            return GitWorktree(
                path: resp.path,
                branch: resp.branch,
                head: nil,
                isMain: false,
                isCurrent: false,
                locked: false,
                prunable: false,
            )
        } catch {
            throw Self.mapGitError(error)
        }
    }

    // MARK: - 머지 큐 (merge_queue_v1)

    /// 이 레포의 머지 큐(목록 + 상태 요약). BranchSheet 의 «머지 큐» 섹션이 진입/새로고침 시
    /// 호출. label nil — 화면 spinner 에 안 잡히게(시트 자체 로딩만 표시).
    func mergeQueue(repoPath: String, label: String? = nil) async throws -> MergeQueueResponse {
        let q = repoPath.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? repoPath
        return try await send("GET", "/api/merge-queue?repoPath=\(q)", label: label)
    }

    /// 머지 요청 enqueue — 세션 컨텍스트로 보낸다(daemon 이 sessionId → repo_path 도출 + provenance).
    /// 직접 머지하지 않고 큐에 적재하는 게 핵심 — daemon 이 한 번에 하나씩 직렬 처리한다.
    @discardableResult
    func enqueueMerge(
        sessionId: String,
        sourceBranch: String,
        targetBranch: String,
        cleanup: Bool = false,
        noFF: Bool = false,
        label: String? = String(localized: "머지 요청"),
    ) async throws -> MergeRequest {
        struct Body: Encodable {
            let sessionId: String
            let sourceBranch: String
            let targetBranch: String
            let cleanup: Bool
            let noFF: Bool
        }
        struct Resp: Decodable { let request: MergeRequest }
        do {
            let resp: Resp = try await send(
                "POST",
                "/api/merge-queue",
                body: Body(sessionId: sessionId, sourceBranch: sourceBranch, targetBranch: targetBranch, cleanup: cleanup, noFF: noFF),
                label: label,
            )
            return resp.request
        } catch {
            throw Self.mapGitError(error)
        }
    }

    /// 머지 사전 «읽기 전용» 충돌 미리보기 — repo 무변경. enqueue 전에 충돌/관계를 보여줄 때.
    /// label nil(저소음)이라 전역 진행 스피너를 잡지 않는다. 실패는 throw(호출부가 graceful 처리).
    func previewMerge(
        sessionId: String,
        sourceBranch: String,
        targetBranch: String,
        label: String? = nil,
    ) async throws -> MergePreview {
        struct Body: Encodable {
            let sessionId: String
            let sourceBranch: String
            let targetBranch: String
        }
        return try await send(
            "POST",
            "/api/merge-queue/preview",
            body: Body(sessionId: sessionId, sourceBranch: sourceBranch, targetBranch: targetBranch),
            label: label,
        )
    }

    /// 충돌/실패/취소된 머지 요청을 다시 큐에 넣는다(재시도).
    @discardableResult
    func retryMerge(id: String, label: String? = String(localized: "머지 재시도")) async throws -> MergeRequest {
        struct Resp: Decodable { let request: MergeRequest }
        let resp: Resp = try await send("POST", "/api/merge-queue/\(id)/retry", label: label)
        return resp.request
    }

    /// 머지 요청 취소(queued) 또는 종결 항목 이력 삭제. 처리 중(processing)은 daemon 이 409 로 막는다.
    func cancelMerge(id: String, label: String? = nil) async throws {
        struct Resp: Decodable { let ok: Bool?; let deleted: Bool?; let request: MergeRequest? }
        let _: Resp = try await send("DELETE", "/api/merge-queue/\(id)", label: label)
    }

    /// 경로가 git 작업트리인지 + 현재 브랜치 — 세션 없이 repoPath 로 조회. 새 세션 스크린이
    /// 레포를 고를 때 «worktree 섹션을 노출할지» 판단하는 용도라 가볍게 호출한다. 비-repo 도
    /// 200 으로 `isRepo:false` 가 온다(에러 아님). label nil — 화면 spinner 에 안 잡히게.
    func repoGitInfo(repoPath: String, label: String? = nil) async throws -> RepoGitInfo {
        let q = repoPath.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? repoPath
        return try await send("GET", "/api/git/info?path=\(q)", label: label)
    }

    /// 세션 없이 repoPath 로 worktree 생성 — 새 세션 스크린 전용. daemon 이 인접 경로를 자동
    /// 산정해 만든 뒤 그 경로를 돌려준다(세션 스코프 `addWorktree` 와 동일 동작 · 동일 헬퍼).
    @discardableResult
    func createWorktreeForRepo(
        repoPath: String,
        branch: String,
        newBranch: Bool,
        from: String? = nil,
        label: String? = String(localized: "worktree 생성"),
    ) async throws -> GitWorktree {
        struct Body: Encodable { let repoPath: String; let branch: String; let newBranch: Bool; let from: String? }
        struct Resp: Decodable { let path: String; let branch: String }
        do {
            let resp: Resp = try await send(
                "POST",
                "/api/git/worktrees",
                body: Body(repoPath: repoPath, branch: branch, newBranch: newBranch, from: from),
                label: label,
            )
            // 방금 만든 worktree 는 detached 아님 · main/current 아님이 자명 — 목록 재조회 없이 구성.
            return GitWorktree(
                path: resp.path,
                branch: resp.branch,
                head: nil,
                isMain: false,
                isCurrent: false,
                locked: false,
                prunable: false,
            )
        } catch {
            throw Self.mapGitError(error)
        }
    }

    /// worktree 삭제. dirty/locked 로 실패하면(409) 호출부가 `force: true` 로 재시도할 수 있다.
    /// 메인/현재 worktree 는 daemon 이 막는다.
    func removeWorktree(
        sessionId: String,
        path: String,
        force: Bool = false,
        label: String? = String(localized: "worktree 삭제"),
    ) async throws {
        struct OK: Decodable { let ok: Bool? }
        let encoded = path.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? path
        let q = force ? "?path=\(encoded)&force=1" : "?path=\(encoded)"
        do {
            let _: OK = try await send(
                "DELETE",
                "/api/sessions/\(sessionId)/git/worktrees\(q)",
                label: label,
            )
        } catch {
            throw Self.mapGitError(error)
        }
    }

    // MARK: - Git 커밋 (CommitsView)

    /// 커밋 로그 한 페이지. `ref` 가 nil 이면 현재 HEAD, 아니면 그 브랜치/커밋 기준.
    /// 비-repo / unborn HEAD 면 빈 배열이 온다. `skip` 으로 «더 보기» 페이지네이션.
    func gitCommits(
        sessionId: String,
        ref: String? = nil,
        limit: Int = 50,
        skip: Int = 0,
        checkpointsOnly: Bool = false,
        label: String? = String(localized: "커밋 목록"),
    ) async throws -> GitCommitsResponse {
        var q = "?limit=\(limit)&skip=\(skip)"
        if let ref, !ref.isEmpty {
            let enc = ref.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ref
            q += "&ref=\(enc)"
        }
        // 체크포인트 타임라인 — daemon 이 식별 prefix 커밋만 grep 해서 돌려준다.
        if checkpointsOnly { q += "&checkpointsOnly=1" }
        return try await send("GET", "/api/sessions/\(sessionId)/git/commits\(q)", label: label)
    }

    /// 한 커밋의 메타 + 변경 파일 목록.
    func gitCommitDetail(
        sessionId: String,
        sha: String,
        label: String? = String(localized: "커밋 정보"),
    ) async throws -> GitCommitDetail {
        let enc = sha.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? sha
        return try await send("GET", "/api/sessions/\(sessionId)/git/commit/\(enc)", label: label)
    }

    /// 한 커밋이 한 파일에 가한 변경만 담은 unified diff (commit-scoped). 응답은 `gitDiff` 와 동일 shape.
    func gitCommitDiff(
        sessionId: String,
        sha: String,
        path: String,
        label: String? = String(localized: "변경 내역"),
    ) async throws -> GitFileDiffResponse {
        let encSha = sha.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? sha
        let encPath = path.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? path
        return try await send(
            "GET",
            "/api/sessions/\(sessionId)/git/commit/\(encSha)/diff?path=\(encPath)",
            label: label,
        )
    }

    // MARK: - 체크포인트 (git 쓰기)

    /// 체크포인트 커밋 생성 — `git add -A && git commit --allow-empty -m "checkpoint(ps): …"`.
    /// 작업트리 전체를 스냅샷해 식별 prefix 커밋으로 남긴다. `note` 가 있으면 제목에 붙는다.
    @discardableResult
    func createCheckpoint(
        sessionId: String,
        note: String? = nil,
        label: String? = String(localized: "체크포인트 만들기"),
    ) async throws -> GitCheckpointResult {
        struct Body: Encodable { let note: String? }
        do {
            return try await send(
                "POST",
                "/api/sessions/\(sessionId)/git/checkpoint",
                body: Body(note: note),
                label: label,
            )
        } catch {
            throw Self.mapGitError(error)
        }
    }

    /// 체크포인트로 되돌리기. `mode: "revert"` 는 비파괴(기록 보존), `"reset"` 은 파괴(이후 커밋 삭제).
    /// 비파괴 우선 정책상 daemon 이 먼저 «되돌리기 전 자동 체크포인트» 를 만든 뒤 동작을 수행한다.
    @discardableResult
    func rollbackToCheckpoint(
        sessionId: String,
        sha: String,
        mode: String,
        label: String? = String(localized: "되돌리는 중"),
    ) async throws -> GitRollbackResult {
        struct Body: Encodable { let sha: String; let mode: String }
        do {
            return try await send(
                "POST",
                "/api/sessions/\(sessionId)/git/rollback",
                body: Body(sha: sha, mode: mode),
                label: label,
            )
        } catch {
            throw Self.mapGitError(error)
        }
    }

    /// daemon 의 4xx git 응답(`{ error, message? }`)을 `GitOperationError` 로 변환.
    /// 그 외(취소/transport/디코드/5xx)는 원래 에러를 그대로 흘린다.
    private static func mapGitError(_ error: Error) -> Error {
        guard case ApiError.httpStatus(let code, let body) = error,
              (400..<500).contains(code) else { return error }
        struct E: Decodable { let error: String?; let message: String? }
        let parsed = body.data(using: .utf8).flatMap { try? JSONDecoder().decode(E.self, from: $0) }
        return GitOperationError(code: parsed?.error ?? "git_error", message: parsed?.message)
    }

    /// repo 루트(빈 path) 또는 그 하위 디렉토리의 listing.
    /// 보안: daemon 이 `..`/절대경로/심볼릭링크 탈출을 거절. iOS 측은 그대로 전달만 한다.
    func listDirectory(
        sessionId: String,
        path: String = "",
        label: String? = String(localized: "디렉토리 열기"),
    ) async throws -> DirectoryListing {
        let encoded = path.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? path
        return try await send(
            "GET",
            "/api/sessions/\(sessionId)/fs/list?path=\(encoded)",
            label: label,
        )
    }

    /// 한 파일의 본문 — 텍스트면 utf8, 이미지/바이너리면 base64. 호출 측은 `FileContent.isText/isImage`
    /// 로 분기한다. daemon 측 cap: 텍스트 1MB (잘리면 truncated), 그 외 5MB (초과 시 too_large 에러).
    func readFile(
        sessionId: String,
        path: String,
        label: String? = String(localized: "파일 열기"),
    ) async throws -> FileContent {
        let encoded = path.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? path
        return try await send(
            "GET",
            "/api/sessions/\(sessionId)/fs/file?path=\(encoded)",
            label: label,
        )
    }

    /// 특정 git ref (기본 HEAD) 에 들어 있는 파일 본문 — 이미지 diff 의 «변경 전» 측.
    /// 첫 commit 이전 / 신규 파일이면 daemon 이 404 (이미지 diff UI 는 «변경 후» 만 표시).
    func readGitBlob(
        sessionId: String,
        path: String,
        ref: String = "HEAD",
        label: String? = String(localized: "이전 버전"),
    ) async throws -> FileContent {
        let encodedPath = path.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? path
        let encodedRef = ref.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ref
        return try await send(
            "GET",
            "/api/sessions/\(sessionId)/git/blob?path=\(encodedPath)&ref=\(encodedRef)",
            label: label,
        )
    }

    // MARK: - 라이브 산출물 (artifacts_v1)

    /// 세션이 만든 «시각적 산출물» 목록 — daemon 이 repo 를 walk 해 mtime 내림차순으로 반환.
    func listArtifacts(
        _ sessionId: String,
        limit: Int = 100,
        dir: String = "",
        label: String? = nil,
    ) async throws -> ArtifactsResult {
        // dir 로 발견 범위를 하위 폴더로 좁힌다(빈 문자열 = repo 루트 전체).
        var query = "limit=\(limit)"
        if !dir.isEmpty {
            let encoded = dir.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? dir
            query += "&dir=\(encoded)"
        }
        return try await send("GET", "/api/sessions/\(sessionId)/artifacts?\(query)", label: label)
    }

    /// 산출물 raw 바이트를 받아 temp 파일로 저장하고 그 URL 을 반환 — QLPreviewController 에 넘긴다.
    /// QuickLook 은 확장자로 타입을 판별하므로 원본 파일명을 보존한다.
    func downloadArtifact(
        _ sessionId: String,
        path: String,
        fileName: String,
    ) async throws -> URL {
        let encoded = path.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? path
        let data = try await downloadRaw("/api/sessions/\(sessionId)/fs/raw?path=\(encoded)")
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("artifacts", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let safeName = fileName.replacingOccurrences(of: "/", with: "_")
        let url = dir.appendingPathComponent("\(UUID().uuidString.prefix(8))-\(safeName)")
        try data.write(to: url, options: .atomic)
        return url
    }

    /// 화면 원샷 스크린샷 (screen_shot_v1) — daemon 이 macOS screencapture 로 뜬 JPEG bytes.
    /// display 는 1-기반 (screencapture -D 그대로). 미러링 «캡처/녹화 → 채팅 첨부» 데이터원.
    /// window(CGWindowID, screen_window_target_v1)를 주면 그 창만 — 미러링이 창 스코프일 때
    /// 캡처/녹화도 같은 창만 담는다. 0 이면 디스플레이 전체(옛 동작, 옛 daemon 은 쿼리 무시).
    func screenShot(display: Int, window: Int = 0) async throws -> Data {
        var path = "/api/screen/shot?display=\(max(1, display))"
        if window > 0 { path += "&window=\(window)" }
        return try await downloadRaw(path)
    }

    /// raw 바이트 GET — JSON 디코드 없이 본문 Data 그대로. send 와 같은 2단계(1차 실패 시 재연결) 회복.
    private func downloadRaw(_ path: String) async throws -> Data {
        do {
            return try await downloadRawOnce(path)
        } catch ApiError.transport(let underlying) where !Self.isCancelledTransport(underlying) {
            await conn.reconnect()
        }
        return try await downloadRawOnce(path)
    }

    private func downloadRawOnce(_ path: String) async throws -> Data {
        let session = try makeSession()
        let req = try authedRequest(method: "GET", path: path, body: nil)
        do {
            let (data, resp) = try await session.data(for: req)
            guard let http = resp as? HTTPURLResponse else { throw ApiError.httpStatus(0, "no response") }
            guard (200..<300).contains(http.statusCode) else {
                if http.statusCode == 426 { Self.handleClientTooOldResponse(data: data) }
                throw ApiError.httpStatus(http.statusCode, String(data: data, encoding: .utf8) ?? "")
            }
            return data
        } catch let e as ApiError {
            throw e
        } catch {
            throw ApiError.transport(error)
        }
    }

    /// 한 RTT 로 messages 증분 + pendingApprovals + questions 를 다 받아온다.
    /// ChatViewModel 의 폴링 루프가 기존 3 round-trip 을 이걸로 1 round-trip 으로 치환하면
    /// Tor 회로 1 회 사용 / 폴링 cycle 로 줄어든다.
    ///
    /// - Parameter afterCreatedAt: messages 의 created_at > 이 값 인 행만 받는다. 0 또는 nil 이면 콜드.
    ///   첫 호출은 nil (또는 0), 이후 응답의 `nextCreatedAt` 을 다음 호출에 넘긴다.
    /// - Parameter limit: 콜드 진입에서만 의미 — 최신 limit 행만(tail 캡). nil 이면 전체(옛 동작).
    ///   `session_history_v1` daemon 만 해석하고 옛 daemon 은 무시(전체 반환)하므로 caller 가
    ///   capability 게이트로 줄지 말지 정한다.
    /// - Parameter label: default nil (폴링이라 tracker 노이즈 X).
    func pollSession(
        _ id: String,
        afterCreatedAt: Int64? = nil,
        limit: Int? = nil,
        label: String? = nil,
    ) async throws -> SessionPollResponse {
        var params: [String] = []
        if let afterCreatedAt { params.append("afterCreatedAt=\(afterCreatedAt)") }
        if let limit { params.append("limit=\(limit)") }
        let q = params.isEmpty ? "" : "?" + params.joined(separator: "&")
        return try await send("GET", "/api/sessions/\(id)/poll\(q)", label: label)
    }

    /// `GET /:id/messages` — 역방향(과거) 메시지 히스토리 한 페이지 (session_history_v1).
    /// `(beforeCreatedAt, beforeId)` 복합 keyset 커서보다 «엄격히 오래된» 행을 limit 개. 커서가
    /// nil 이면 최신부터. 「이전 더보기」 가 응답의 `oldestCreatedAt/oldestId` 를 다음 커서로 쓴다.
    func messageHistory(
        _ id: String,
        beforeCreatedAt: Int64?,
        beforeId: String?,
        limit: Int,
        label: String? = nil,
    ) async throws -> MessageHistoryResponse {
        var params: [String] = ["limit=\(limit)"]
        if let beforeCreatedAt { params.append("beforeCreatedAt=\(beforeCreatedAt)") }
        if let beforeId { params.append("beforeId=\(beforeId)") }
        let q = "?" + params.joined(separator: "&")
        return try await send("GET", "/api/sessions/\(id)/messages\(q)", label: label)
    }

    /// `GET /:id/pty/snapshot` — 헤드리스 VT 가 재구성한 PTY 화면 스냅샷 (pty_snapshot_v1).
    /// 콜드 진입에서 «전체 청크 replay» 대신 현재 화면+scrollback 을 한 덩이로 받아 O(화면)
    /// 비용으로 즉시 복원한다. 옛 daemon 은 이 라우트를 몰라 404 → caller 가 try? 로 nil 받아
    /// P1 tail 캡 콜드 poll 로 폴백한다.
    func ptySnapshot(
        _ id: String,
        label: String? = nil,
    ) async throws -> PtySnapshotResponse {
        try await send("GET", "/api/sessions/\(id)/pty/snapshot", label: label)
    }

    func sendMessage(
        _ sessionId: String,
        text: String,
        label: String? = String(localized: "메시지 전송"),
    ) async throws {
        struct OK: Codable { let ok: Bool }
        let _: OK = try await send(
            "POST",
            "/api/sessions/\(sessionId)/messages",
            body: SendMessageRequest(text: text),
            label: label,
        )
    }

    /// 이미지 첨부 업로드 — base64 이미지(들)를 세션 repo 의 `dir`(기본 attachments)에 저장하고
    /// 저장된 repo-relative 경로를 돌려준다. 호출부는 그 경로를 프롬프트에 매핑해 에이전트가
    /// Read 도구로 이미지를 읽게 한다. 업로드 페이로드가 크므로 호출 전에 다운스케일/압축을 권장.
    func uploadAttachments(
        _ sessionId: String,
        dir: String?,
        images: [(filename: String, data: Data)],
        label: String? = String(localized: "이미지 업로드 중…"),
    ) async throws -> [SavedAttachment] {
        struct ReqImage: Encodable { let filename: String; let data_b64: String }
        struct Req: Encodable { let dir: String?; let images: [ReqImage] }
        struct Resp: Decodable { let saved: [SavedAttachment] }
        let req = Req(
            dir: dir,
            images: images.map {
                ReqImage(filename: $0.filename, data_b64: $0.data.base64EncodedString())
            },
        )
        let resp: Resp = try await send(
            "POST",
            "/api/sessions/\(sessionId)/attachments",
            body: req,
            label: label,
        )
        return resp.saved
    }

    func deleteSession(_ sessionId: String, label: String? = String(localized: "세션 삭제")) async throws {
        struct OK: Codable { let ok: Bool }
        let _: OK = try await send("DELETE", "/api/sessions/\(sessionId)", label: label)
    }

    /// 세션 메타데이터 부분 업데이트 — 현재는 title 만 편집 가능.
    /// - Parameter title: nil 또는 빈 문자열을 보내면 서버에서 NULL 로 저장 (UI 가 "제목 없음" 으로 빠짐).
    /// - Returns: 업데이트가 반영된 최신 세션 요약. 호출자는 이 값으로 로컬 상태를 동기화한다.
    @discardableResult
    func updateSession(
        _ sessionId: String,
        title: String?,
        label: String? = String(localized: "이름 변경"),
    ) async throws -> SessionSummary {
        struct Body: Encodable { let title: String? }
        struct Resp: Codable { let ok: Bool; let session: SessionSummary }
        let resp: Resp = try await send(
            "PATCH",
            "/api/sessions/\(sessionId)",
            body: Body(title: title),
            label: label,
        )
        return resp.session
    }

    /// 세션 agent 의 토큰 잔량 — rate limit 윈도우별 사용률 + 리셋 시각.
    /// 더보기 메뉴를 열 때마다 background 로 조회 — InFlight 칩 노이즈를 피하려 label nil.
    /// daemon 이 agent 별 소스 (claude: OAuth usage API / codex: 세션 스냅샷) 를 흡수하고,
    /// 토큰 개념이 없는 agent (shell/agy) 는 supported:false 로 응답한다.
    func agentUsage(sessionId: String) async throws -> AgentUsageResponse {
        try await send("GET", "/api/sessions/\(sessionId)/usage", label: nil)
    }

    /// 세션 단위 알림 음소거 토글 — PATCH /api/sessions/:id { notifyMuted }.
    /// title 키를 안 보내므로 제목은 건드리지 않는다 (daemon 의 부분 PATCH 시멘틱).
    /// - Returns: 갱신된 세션 요약. 호출자가 이 값으로 로컬 상태를 동기화한다.
    @discardableResult
    func setSessionNotifyMuted(
        _ sessionId: String,
        muted: Bool,
        label: String? = String(localized: "세션 알림 설정"),
    ) async throws -> SessionSummary {
        struct Body: Encodable { let notifyMuted: Bool }
        struct Resp: Codable { let ok: Bool; let session: SessionSummary }
        let resp: Resp = try await send(
            "PATCH",
            "/api/sessions/\(sessionId)",
            body: Body(notifyMuted: muted),
            label: label,
        )
        return resp.session
    }

    /// 세션 단위 «보관»/«복구» 토글 (session_archive_v1) — PATCH /api/sessions/:id { archived }.
    /// title/notifyMuted 키를 안 보내므로 그 필드는 건드리지 않는다 (daemon 의 부분 PATCH 시멘틱).
    /// archived=true 면 기본 목록에서 사라지고, false 면 «보관함» 에서 복구된다.
    /// - Returns: 갱신된 세션 요약. 호출자가 이 값으로 로컬 상태를 동기화한다.
    @discardableResult
    func setSessionArchived(
        _ sessionId: String,
        archived: Bool,
        label: String? = String(localized: "세션 보관"),
    ) async throws -> SessionSummary {
        struct Body: Encodable { let archived: Bool }
        struct Resp: Codable { let ok: Bool; let session: SessionSummary }
        let resp: Resp = try await send(
            "PATCH",
            "/api/sessions/\(sessionId)",
            body: Body(archived: archived),
            label: label,
        )
        return resp.session
    }

    /// 세션 일괄 보관/복구/삭제 (session_archive_v1) — POST /api/sessions/bulk { action, ids }.
    /// 완료/오래된 세션을 그룹 단위로 한 번에 치운다 (세션 목록 그룹 헤더의 «모두 보관»/«모두 삭제»).
    /// 부분 성공 허용 — 이미 사라진 id 는 daemon 이 건너뛰고 affected(실제 반영 수)만 돌려준다.
    /// `session_archive_v1` capability 없는 옛 daemon 은 404 — 호출처가 throw 를 흡수(버튼도 게이팅).
    /// - Returns: 실제로 반영된 세션 수 (affected).
    @discardableResult
    func bulkSessions(
        action: BulkSessionAction,
        ids: [String],
        label: String? = String(localized: "세션 일괄 처리"),
    ) async throws -> Int {
        struct Body: Encodable { let action: String; let ids: [String] }
        struct Resp: Decodable { let ok: Bool; let affected: Int? }
        let resp: Resp = try await send(
            "POST",
            "/api/sessions/bulk",
            body: Body(action: action.rawValue, ids: ids),
            label: label,
        )
        return resp.affected ?? 0
    }

    /// 「다음 정지 시 알림」 1회성 수동 구독 토글 — POST /api/sessions/:id/notify-next-stop { enabled }.
    /// 12초 idle 휴리스틱이 놓치는 «조용히 멈춘» 세션을 사람이 메우는 안전장치. 활성 PTY 한정
    /// 메모리 신호라 음소거(PATCH)와 달리 DB 영속이 아니다.
    /// - Returns: 실제로 무장/해제됐는지 (활성 PTY 가 있었는지). false 면 «적용 불가»(종료된 세션).
    @discardableResult
    func setSessionNotifyNextStop(
        _ sessionId: String,
        enabled: Bool,
        label: String? = String(localized: "다음 정지 알림 설정"),
    ) async throws -> Bool {
        struct Body: Encodable { let enabled: Bool }
        struct Resp: Decodable { let ok: Bool; let applied: Bool? }
        let resp: Resp = try await send(
            "POST",
            "/api/sessions/\(sessionId)/notify-next-stop",
            body: Body(enabled: enabled),
            label: label,
        )
        return resp.applied ?? false
    }

    // MARK: - 알림 채널 설정 (daemon-level Discord)

    /// 알림 설정 중 iOS 가 다루는 부분. webhook URL·이벤트 토글은 Mac 앱이 담당하고,
    /// 폰은 «미리보기 포함» 옵트인만 읽고 쓴다. `configured` 가 false 면 Discord 가 아직
    /// 연결되지 않아 미리보기 토글이 무의미하다 (UI 가 비활성 + 안내).
    struct NotifyConfigInfo {
        let configured: Bool
        let enabled: Bool
        let includePreview: Bool
    }

    /// daemon 알림 설정 조회 — GET /api/notify/config (webhook URL 은 redact 되어 안 옴).
    func getNotifyConfig(label: String? = nil) async throws -> NotifyConfigInfo {
        struct Resp: Decodable {
            struct Discord: Decodable {
                let configured: Bool
                let enabled: Bool
                let includePreview: Bool
            }
            let discord: Discord
        }
        let r: Resp = try await send("GET", "/api/notify/config", label: label)
        return NotifyConfigInfo(
            configured: r.discord.configured,
            enabled: r.discord.enabled,
            includePreview: r.discord.includePreview,
        )
    }

    /// 알림 본문 «미리보기 포함» 토글 — POST /api/notify/config { discord: { includePreview } }.
    /// webhookUrl/events 키는 보내지 않아 daemon 이 기존 값을 유지한다 (부분 갱신 시멘틱).
    func setNotifyIncludePreview(
        _ include: Bool,
        label: String? = String(localized: "알림 설정"),
    ) async throws {
        struct Body: Encodable {
            struct Discord: Encodable { let includePreview: Bool }
            let discord: Discord
        }
        struct OK: Decodable { let ok: Bool? }
        let _: OK = try await send(
            "POST",
            "/api/notify/config",
            body: Body(discord: .init(includePreview: include)),
            label: label,
        )
    }

    // MARK: - PTY (pty mode)

    /// PTY 모드 터미널 크기 동기화 — TerminalView 의 sizeChanged delegate 콜백.
    func resizePty(
        sessionId: String,
        cols: Int,
        rows: Int,
        label: String? = nil,
    ) async throws {
        struct Body: Encodable { let cols: Int; let rows: Int }
        struct OK: Decodable { let ok: Bool? }
        let _: OK = try await send(
            "POST",
            "/api/sessions/\(sessionId)/pty/resize",
            body: Body(cols: cols, rows: rows),
            label: label,
        )
    }

    /// PTY 강제 재시작 — 현재 REPL 프로세스를 SIGTERM 으로 죽이고, 메시지/승인/질문을 비운 뒤
    /// 새 PTY 를 즉시 prewarm 한다. iOS 의 "터미널 강제 재시작" 메뉴가 호출.
    func restartPty(
        sessionId: String,
        label: String? = String(localized: "터미널 재시작"),
    ) async throws {
        struct OK: Decodable { let ok: Bool }
        let _: OK = try await send(
            "POST",
            "/api/sessions/\(sessionId)/pty/restart",
            label: label,
        )
    }

    /// 가상 키보드 단일 키 입력 — REPL 의 다항 선택 wizard 를 모바일에서 화살표/Enter 로
    /// 제어하기 위한 채널. 화이트리스트: up/down/left/right/space/enter.
    /// 폴링과 같은 빈도로 자주 호출되므로 default label 은 nil (in-flight 배너 노이즈 차단).
    func sendPtyKey(
        sessionId: String,
        key: PtyKey,
        label: String? = nil,
    ) async throws {
        struct Body: Encodable { let key: String }
        struct OK: Decodable { let ok: Bool? }
        let _: OK = try await send(
            "POST",
            "/api/sessions/\(sessionId)/pty/key",
            body: Body(key: key.rawValue),
            label: label,
        )
    }

    /// 세션 일괄 제어 — 목록 그룹 헤더의 «모두 승인»(approve) / «모두 중지»(interrupt) 가 세션
    /// 하나당 호출. daemon 이 Enter/ESC 제어 byte 를 PTY 에 흘려 채팅방을 열지 않고도 결재
    /// 병목을 줄인다. `bulk_session_actions_v1` capability 없는 옛 daemon 은 404 — 호출처가
    /// throw 를 흡수한다 (UI 버튼 자체도 capability 로 게이팅).
    func ptyControl(
        sessionId: String,
        action: PtyControlAction,
        label: String? = nil,
    ) async throws {
        struct Body: Encodable { let action: String }
        struct OK: Decodable { let ok: Bool? }
        let _: OK = try await send(
            "POST",
            "/api/sessions/\(sessionId)/pty/control",
            body: Body(action: action.rawValue),
            label: label,
        )
    }

    // MARK: - Recent projects

    func recentProjects(label: String? = String(localized: "최근 프로젝트")) async throws -> [RecentProject] {
        let resp: RecentProjectsResponse = try await send("GET", "/api/recent-projects", label: label)
        return resp.projects
    }

    /// `GET /api/fs/list-dir?path=<prefix>` — <prefix> 디렉터리 바로 아래 하위 디렉터리 이름
    /// 목록. 새 세션 경로 자동완성이 recents 추측을 넘어 실제 디렉터리 트리를 탐색하는 데 쓴다.
    /// 옛 daemon (이 라우트 모르는 빌드) 은 404 → 호출처가 throw 를 잡아 빈 목록으로 흡수.
    func listDir(_ path: String, label: String? = nil) async throws -> [String] {
        struct Resp: Codable { let dirs: [String] }
        let q = path.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? path
        let resp: Resp = try await send("GET", "/api/fs/list-dir?path=\(q)", label: label)
        return resp.dirs
    }

    /// `GET /api/fs/list-dir?path=<prefix>` — 해소된 절대경로(base) + 하위 디렉터리 이름.
    /// 폴더 탐색기(DirectoryPickerSheet)가 절대경로 트리를 따라 내려가는 데 쓴다. 빈 path 는
    /// daemon 이 홈 디렉터리로 해소한다. 404(옛 daemon)면 호출처가 throw 를 잡아 흡수.
    func listDirBase(_ path: String, label: String? = nil) async throws -> (base: String, dirs: [String]) {
        struct Resp: Codable { let base: String; let dirs: [String]; let exists: Bool? }
        let q = path.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? path
        let resp: Resp = try await send("GET", "/api/fs/list-dir?path=\(q)", label: label)
        return (resp.base, resp.dirs)
    }

    /// `GET /api/fs/list-dir?path=<prefix>&files=1` — 하위 디렉터리 + 일반 파일 이름. 예약 «터미널»
    /// 의 쉘 스크립트 파일 선택용. `files` 를 안 보내는 옛 daemon 은 nil → 빈 파일 목록으로 흡수.
    func listDirEntries(_ path: String, label: String? = nil) async throws -> (dirs: [String], files: [String]) {
        struct Resp: Codable { let dirs: [String]; let files: [String]? }
        let q = path.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? path
        let resp: Resp = try await send("GET", "/api/fs/list-dir?path=\(q)&files=1", label: label)
        return (resp.dirs, resp.files ?? [])
    }

    // MARK: - Cron (예약 작업)

    /// `GET /api/cron` — 전체 예약 작업. cron_v1 capability 없는 옛 daemon 은 404 → 호출처가
    /// throw 를 잡아 빈 목록으로 흡수 (메뉴 진입점도 capability 로 숨겨지므로 보통 도달 안 함).
    func listCronJobs(label: String? = String(localized: "예약 작업 목록")) async throws -> [CronJob] {
        let resp: CronJobsResponse = try await send("GET", "/api/cron", label: label)
        return resp.jobs
    }

    /// `GET /api/cron/:id` — 작업 1건 + 최근 실행 이력.
    func cronJob(_ id: String, label: String? = String(localized: "예약 작업")) async throws -> CronJobDetailResponse {
        try await send("GET", "/api/cron/\(id)", label: label)
    }

    /// `POST /api/cron` — 생성. 식/agent/repo 검증 실패는 400 → ApiError.httpStatus.
    func createCronJob(_ req: CronJobUpsertRequest, label: String? = String(localized: "예약 작업 생성")) async throws -> CronJob {
        let resp: CronJobResponse = try await send("POST", "/api/cron", body: req, label: label)
        return resp.job
    }

    /// `PATCH /api/cron/:id` — 수정 (편집 저장은 full body, 토글은 부분 body).
    func updateCronJob(_ id: String, _ req: CronJobUpsertRequest, label: String? = String(localized: "예약 작업 수정")) async throws -> CronJob {
        let resp: CronJobResponse = try await send("PATCH", "/api/cron/\(id)", body: req, label: label)
        return resp.job
    }

    /// enabled 토글 — 목록의 스위치가 호출하는 최소 PATCH.
    func setCronJobEnabled(_ id: String, _ enabled: Bool, label: String? = String(localized: "예약 작업 켜기/끄기")) async throws -> CronJob {
        try await updateCronJob(id, CronJobUpsertRequest(enabled: enabled), label: label)
    }

    /// `DELETE /api/cron/:id`.
    func deleteCronJob(_ id: String, label: String? = String(localized: "예약 작업 삭제")) async throws {
        struct OK: Decodable { let ok: Bool }
        let _: OK = try await send("DELETE", "/api/cron/\(id)", label: label)
    }

    /// `POST /api/cron/:id/run` — 지금 즉시 실행. 세션이 생기면 status="running" + sessionId
    /// (iOS 가 그 세션으로 딥링크). overlap/제약으로 못 돌면 status="skipped".
    func runCronJob(_ id: String, label: String? = String(localized: "지금 실행")) async throws -> CronRunStartResult {
        try await send("POST", "/api/cron/\(id)/run", label: label)
    }

    /// `POST /api/cron/preview` — 식이 바뀔 때마다 에디터가 디바운스로 호출. 다음 실행 시각.
    func previewSchedule(_ schedule: String, timezone: String?, label: String? = nil) async throws -> SchedulePreview {
        struct Req: Encodable { let schedule: String; let timezone: String? }
        return try await send("POST", "/api/cron/preview", body: Req(schedule: schedule, timezone: timezone), label: label)
    }

    // MARK: - MCP 「도구」 서버

    /// `GET /api/mcp/catalog` — 알려진 제공자(캘린더/Gmail/사용자지정) + 최소권한 scope.
    /// mcp_tools_v1 없는 옛 daemon 은 404 → 호출처가 흡수(진입점도 capability 로 숨겨짐).
    func mcpCatalog(label: String? = String(localized: "도구 카탈로그")) async throws -> [McpCatalogEntry] {
        let resp: McpCatalogResponse = try await send("GET", "/api/mcp/catalog", label: label)
        return resp.catalog
    }

    /// `GET /api/mcp` — 등록된 MCP 서버 목록 (토큰 본문 미포함, custody 상태만).
    func listMcpServers(label: String? = String(localized: "도구 목록")) async throws -> [McpServer] {
        let resp: McpServersResponse = try await send("GET", "/api/mcp", label: label)
        return resp.servers
    }

    /// `GET /api/mcp/:id` — 서버 + 도달성 프로브 헬스.
    func mcpServerDetail(_ id: String, label: String? = String(localized: "도구 상태")) async throws -> McpServerDetailResponse {
        try await send("GET", "/api/mcp/\(id)", label: label)
    }

    /// `POST /api/mcp` — 서버 등록. catalogId/agent/repoPath/url + writeEnabled opt-in.
    func addMcpServer(
        catalogId: String,
        agent: String,
        repoPath: String,
        url: String,
        writeEnabled: Bool,
        label: String? = String(localized: "도구 추가"),
    ) async throws -> McpServer {
        struct Req: Encodable {
            let catalogId: String; let agent: String; let repoPath: String
            let url: String; let writeEnabled: Bool
        }
        let req = Req(catalogId: catalogId, agent: agent, repoPath: repoPath, url: url, writeEnabled: writeEnabled)
        let resp: McpServerResponse = try await send("POST", "/api/mcp", body: req, label: label)
        guard let s = resp.server else {
            throw ApiError.httpStatus(500, "missing server in response")
        }
        return s
    }

    /// `POST /api/mcp/:id/oauth` — OAuth 동의 트리거(실제 인가 흐름은 에이전트 CLI 네이티브 MCP
    /// 위임). custody 상태를 connected 로 기록하고 갱신된 서버를 돌려준다.
    func triggerMcpOauth(_ id: String, label: String? = String(localized: "도구 연결")) async throws -> McpServer? {
        let resp: McpServerResponse = try await send("POST", "/api/mcp/\(id)/oauth", label: label)
        return resp.server
    }

    /// `POST /api/mcp/:id/revoke` — 토큰 custody 취소(미설정으로 되돌림) + native 등록 해제.
    func revokeMcpServer(_ id: String, label: String? = String(localized: "도구 연결 해제")) async throws -> McpServer? {
        let resp: McpServerResponse = try await send("POST", "/api/mcp/\(id)/revoke", label: label)
        return resp.server
    }

    /// `DELETE /api/mcp/:id` — 등록 완전 삭제 + native 해제.
    func deleteMcpServer(_ id: String, label: String? = String(localized: "도구 삭제")) async throws {
        struct OK: Decodable { let ok: Bool }
        let _: OK = try await send("DELETE", "/api/mcp/\(id)", label: label)
    }

    // MARK: - Mac 앱 업데이트 원격 트리거

    /// 페어된 Mac 앱의 Sparkle 업데이트 확인을 원격으로 트리거.
    ///
    /// daemon (`mac/daemon/src/routes/admin.ts`) 이 부모 (Mac 앱) 에 SIGUSR1 을
    /// 보내고, Mac 앱의 `UpdaterBridge` 가 가로채 `SPUUpdater.checkForUpdates()`
    /// 를 호출한다. Sparkle 가 EdDSA 검증된 DMG 를 받아 .app 자동 교체 + relaunch.
    ///
    /// 응답은 `{ ok: true }` 가 끝 — 실제 업데이트 진행은 비동기. relaunch 가 일어나면
    /// SSH 채널이 끊겨 `ConnectionManager.reconnect` 가 자동 재연결까지 5~15s 정도
    /// 걸린다. UI 는 그동안 "재연결 중…" 으로 표시.
    ///
    /// 옛 daemon (이 라우트 모르는 빌드) 은 404 — 호출처가 일반 ApiError.httpStatus(404, _)
    /// 로 catch 해서 "지금 페어된 Mac 앱이 너무 옛 버전이라 원격 업데이트가 불가, 수동으로
    /// 메뉴바에서 업데이트 확인을 눌러주세요" 같은 안내로 분기 가능.
    func triggerMacUpdate(label: String? = String(localized: "Mac 앱 업데이트 요청")) async throws {
        struct OK: Decodable { let ok: Bool }
        let _: OK = try await send("POST", "/api/admin/trigger-update", label: label)
    }

}
