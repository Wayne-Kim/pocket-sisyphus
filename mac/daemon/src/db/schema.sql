CREATE TABLE IF NOT EXISTS sessions (
  id                     TEXT PRIMARY KEY,
  title                  TEXT,
  repo_path              TEXT NOT NULL,
  created_at             INTEGER NOT NULL,
  ended_at               INTEGER,
  status                 TEXT CHECK(status IN ('active','completed','error')) NOT NULL DEFAULT 'active',
  -- 데스크탑 Claude Code 세션 (~/.claude/projects/<slug>/<uuid>.jsonl) 을 이어 받을 때 그 UUID.
  -- 모바일에서 새 세션을 만들 때 "이어가기" 옵션으로 지정되거나, 우리 runner 가 첫 turn 이후
  -- SDK 가 알려준 session_id 로 갱신해서 turn 사이 컨텍스트가 유지되도록 한다.
  parent_sdk_session_id  TEXT,
  -- "이 세션은 모든 권한을 자동 승인" 플래그. 세션 생성 시 한 번 결정되어 영구 보존된다.
  -- `claude --dangerously-skip-permissions` 와 동등. 이유: 세션 상세 화면의 "섹션 전체 승인"
  -- 토글이 기대대로 안 동작해서 매 turn 마다 bash/Write 같은 도구가 prompt 를 띄움.
  -- 신뢰하는 repo 에서 빠르게 작업하고 싶을 때 켜고, list 화면에서 시각적으로 구분된다.
  skip_permissions       INTEGER NOT NULL DEFAULT 0,
  -- runner 모드. 현재는 'pty' 만 지원 — CLI 를 진짜 PTY 로 띄워 인터랙티브 REPL 로
  -- 구동. 2026-06-15 Anthropic 청구 변경 (Agent SDK 사용량을 별도 풀로 분리) 이후 구독 한도에서
  -- 차감되게 하기 위함. 옛 'sdk' 모드 runner 는 제거됨. 컬럼 자체는 향후 다른 runner 도입
  -- 가능성을 위해 유지. 자세한 건 src/agent/pty-runner.ts 헤더 코멘트 참고.
  mode                   TEXT CHECK(mode IN ('pty')) NOT NULL DEFAULT 'pty',
  -- 어떤 코드 에이전트 CLI 로 spawn 할지 — daemon 의 AgentAdapter registry id.
  -- 'claude_code' (claude CLI) / 'agy' (Google Antigravity CLI) 등. CHECK 제약은 의도적으로
  -- 안 박음 — 새 adapter 추가 시 schema 갱신 강제 없이 코드 등록만으로 동작. 등록 안 된
  -- id 는 routes/sessions.ts 의 createSession 단계에서 hasAgent() 검증으로 막힘.
  -- 옛 row (이 컬럼 추가 전) 는 마이그레이션에서 'claude_code' 로 기본값 채워짐.
  agent                  TEXT NOT NULL DEFAULT 'claude_code',
  -- "이 세션의 알림(Discord 등) 끄기" 플래그. 여러 세션을 동시에 굴릴 때 시끄러운 세션만
  -- 골라 음소거하는 용도 — iOS ChatView 우측 상단 bell 토글이 PATCH 로 켜고 끈다.
  -- 전역 notify 설정(config.notify.discord)과 별개로, 이 값이 1 이면 그 세션의 모든
  -- 이벤트(turn_complete / session_exit / error)가 발송되지 않는다.
  notify_muted           INTEGER NOT NULL DEFAULT 0,
  -- "보관됨" 플래그 (session_archive_v1). 1 이면 기본 세션 목록에서 숨긴다 — 완료/오래된
  -- 세션이 쌓여 «지금 리뷰할 것» 을 가리지 않도록 시야에서 치우는 용도. status 와 직교한다
  -- (완료/오류/활성 무엇이든 보관 가능). GET /api/sessions 는 기본 archived=0 만, ?archived=1
  -- 은 보관분만, ?archived=all 은 둘 다 반환한다. iOS 가 스와이프/일괄로 0↔1 을 토글하고
  -- (PATCH .../:id { archived } · POST .../bulk), «보관됨» 섹션에서 복구(unarchive)한다.
  -- 기존 row 는 마이그레이션에서 0(미보관)으로 채워져 회귀 0.
  archived               INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role         TEXT NOT NULL,
  type         TEXT NOT NULL,
  payload      TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);

CREATE TABLE IF NOT EXISTS approvals (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  tool_name     TEXT NOT NULL,
  tool_use_id   TEXT,
  input_json    TEXT NOT NULL,
  title         TEXT,
  display_name  TEXT,
  description   TEXT,
  decision      TEXT CHECK(decision IN ('pending','allow','deny','always_allow')) NOT NULL DEFAULT 'pending',
  decided_at    INTEGER,
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_approvals_session ON approvals(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_approvals_pending ON approvals(decision) WHERE decision = 'pending';

CREATE TABLE IF NOT EXISTS pair_tokens (
  id            TEXT PRIMARY KEY,
  token_hash    TEXT UNIQUE NOT NULL,
  device_label  TEXT,
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER,
  revoked_at    INTEGER
);

-- AskUserQuestion: 모델이 옵션형 질문을 던졌을 때 모바일 응답을 받아 보관.
-- payload_json   = AskUserQuestionInput (질문/옵션/multiSelect)
-- answers_json   = { [questionText]: "label" 또는 "기타: <자유텍스트>" } — answered 후 채움
CREATE TABLE IF NOT EXISTS questions (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  payload_json  TEXT NOT NULL,
  answers_json  TEXT,
  status        TEXT CHECK(status IN ('pending','answered','cancelled')) NOT NULL DEFAULT 'pending',
  created_at    INTEGER NOT NULL,
  answered_at   INTEGER
);

CREATE INDEX IF NOT EXISTS idx_questions_session ON questions(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_questions_pending ON questions(status) WHERE status = 'pending';

-- wg_peers 테이블 (v1) 폐기. v2는 Tor onion service로 peer 식별 → 별도 테이블 불필요
-- DROP TABLE은 migration에서 처리 (현 schema에서는 단순 제거)

-- ─────────────────────────────────────────────────────────────────────────────
-- 예약 작업 (cron). iOS 에서 «어떤 repo 에서 / 어떤 에이전트로 / 어떤 명령을 / 언제»
-- 돌릴지 정의하고, daemon 의 CronScheduler 가 그 시각에 세션을 만들어 한 번 실행한다.
-- 실행 = createSession + runUserMessagePty(command) — 결과는 평범한 세션으로 남는다.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cron_jobs (
  id               TEXT PRIMARY KEY,
  -- 사용자 라벨 ("매일 PR 리뷰"). 세션 제목에 "⏰ <title>" 로 박힌다.
  title            TEXT,
  -- 예약의 «종류». 'agent' = 코드 에이전트 CLI 에 프롬프트(command)를 보내 실행.
  -- 'terminal' = command 를 «쉘 스크립트 파일 경로» 로 보고 shell 인터프리터로 한 번 실행.
  -- 에이전트와 터미널은 iOS 에디터에서 별도 카테고리로 고른다 (agent picker 에 섞지 않음).
  kind             TEXT CHECK(kind IN ('agent','terminal')) NOT NULL DEFAULT 'agent',
  -- 어떤 코드 에이전트 CLI 로 spawn 할지 — sessions.agent 와 동일한 registry id.
  -- kind='terminal' 이면 셸 PTY 부기(bookkeeping)용으로 'shell' 이 박힌다.
  agent            TEXT NOT NULL,
  -- 에이전트 cwd. 없으면 실행 시 mkdir -p (resolveAndEnsureRepoDir).
  repo_path        TEXT NOT NULL,
  -- kind='agent': 에이전트에 보낼 프롬프트. kind='terminal': 실행할 쉘 스크립트 «파일 절대경로».
  command          TEXT NOT NULL,
  -- kind='terminal' 의 인터프리터 — 'zsh' | 'bash' | 'sh'. NULL 이면 사용자 기본 셸($SHELL→zsh).
  -- kind='agent' 면 NULL.
  shell            TEXT,
  -- 5필드 cron 식 ("0 9 * * 1-5"). croner 가 파싱/다음실행 계산.
  schedule         TEXT NOT NULL,
  -- IANA timezone. NULL = Mac 로컬.
  timezone         TEXT,
  -- 무인 실행 → 도구 자동 승인 기본 ON (안 하면 승인 대기로 멈춤). sessions.skip_permissions 로 전달.
  skip_permissions INTEGER NOT NULL DEFAULT 1,
  -- 'fresh' = 매번 새 세션, 'continue' = 직전 실행 대화 이어가기(resume).
  session_mode     TEXT CHECK(session_mode IN ('fresh','continue')) NOT NULL DEFAULT 'fresh',
  -- 'skip' = 직전 실행이 아직 도는 중이면 이번 트리거 생략, 'allow' = 겹쳐 실행 허용.
  overlap_policy   TEXT CHECK(overlap_policy IN ('skip','allow')) NOT NULL DEFAULT 'skip',
  -- 1 이면 부팅 시 «놓친 실행» 1회 보충 (기본 OFF — 깨어날 때마다 폭주 방지).
  catch_up         INTEGER NOT NULL DEFAULT 0,
  -- 1 이면 이 작업 완료를 Discord 로 알림.
  notify           INTEGER NOT NULL DEFAULT 1,
  enabled          INTEGER NOT NULL DEFAULT 1,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER,
  -- 최신 실행 요약 캐시 (cron_runs join 없이 목록 화면에서 바로 표시).
  last_run_at      INTEGER,
  last_status      TEXT,                              -- 'ok'|'error'|'timeout'|'skipped'
  last_session_id  TEXT,                              -- 마지막 실행이 만든 sessions.id (딥링크)
  next_run_at      INTEGER,                           -- croner 가 계산한 다음 실행 (표시용)
  run_count        INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_cron_enabled ON cron_jobs(enabled);

CREATE TABLE IF NOT EXISTS cron_runs (
  id            TEXT PRIMARY KEY,
  cron_job_id   TEXT NOT NULL REFERENCES cron_jobs(id) ON DELETE CASCADE,
  session_id    TEXT,                                 -- 만든 세션 (skipped 면 NULL)
  trigger       TEXT NOT NULL,                        -- 'schedule'|'manual'
  started_at    INTEGER NOT NULL,
  ended_at      INTEGER,
  status        TEXT NOT NULL,                        -- 'running'|'ok'|'error'|'timeout'|'skipped'
  error         TEXT
);

CREATE INDEX IF NOT EXISTS idx_cron_runs_job ON cron_runs(cron_job_id, started_at);

-- ─────────────────────────────────────────────────────────────────────────────
-- 멀티 에이전트 워크플로우 (workflow). iOS 의 GUI 캔버스에서 노드(에이전트 작업)를
-- 화살표로 이어 그린 DAG 를, daemon 의 WorkflowEngine 이 위상 순서대로 실행한다.
-- 일하는 노드(general/test) 1개 = 세션 1개 (createSession + runUserMessagePty) — cron 과
-- 같은 «노드 = 세션» 재사용. 노드 간 결과물 전달은 «Task 폴더» 계약 (task-folder.ts):
-- 각 노드가 <repo>/.psworkflow/Task-<nodeRunId>/result.md 를 쓰고 다음 노드가 그 폴더를 참조.
-- docs/WORKFLOW_PLAN.md 참고.
-- ─────────────────────────────────────────────────────────────────────────────

-- 그래프 «정의» — 캔버스에 그린 것. nodes/edges 는 JSON blob (한 화면에서 통째로 편집되고
-- 좌표 x/y 를 포함하므로 정규화 이득보다 비용이 큼). 실행 시점에 workflow_runs.def_snapshot
-- 으로 immutable 복사돼, 실행 중 편집이 진행 중 run 을 흔들지 않는다.
CREATE TABLE IF NOT EXISTS workflows (
  id          TEXT PRIMARY KEY,
  title       TEXT,
  -- 기본 repo (절대경로). 노드가 repo_path 로 개별 override 가능. 없으면 노드별 repo 필수.
  repo_path   TEXT,
  -- JSON 배열. 각 노드: { id, type:'start'|'general'|'test'|'end', title?, agent?, repo_path?,
  --   prompt?, skip_permissions?, requires_approval?, triggers?, x, y }. (Phase 0 은 start/
  --   general/end + 정적 간선만 실행; test/triggers/requires_approval 은 이후 Phase.)
  nodes       TEXT NOT NULL,
  -- JSON 배열. 각 간선: { id, from, to, condition?:'pass'|'fail' }. 방향 = from→to.
  edges       TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER
);

-- 시작 노드 트리거의 daemon 런타임 등록부. 정의(node.triggers)에서 저장 시 reconcile 된다
-- (cron_jobs.next_run_at 캐시와 같은 성격). manual 은 등록 불필요 — cron/github 만 행 생성.
-- (Phase 1 에서 스케줄러가 소비; Phase 0 은 스키마만.)
CREATE TABLE IF NOT EXISTS workflow_triggers (
  id            TEXT PRIMARY KEY,
  workflow_id   TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  start_node_id TEXT NOT NULL,
  kind          TEXT CHECK(kind IN ('manual','cron','github')) NOT NULL,
  schedule      TEXT,                                 -- kind='cron': 5필드 cron 식
  timezone      TEXT,                                 -- IANA tz, NULL=Mac 로컬
  repo_path     TEXT,                                 -- kind='github': git fetch 대상 repo
  branch        TEXT,                                 -- kind='github': 감시 브랜치
  poll_seconds  INTEGER,                              -- kind='github': 폴 간격
  last_sha      TEXT,                                 -- kind='github': 마지막 본 커밋
  enabled       INTEGER NOT NULL DEFAULT 1,
  last_fired_at INTEGER,
  next_check_at INTEGER,
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wf_trig_next ON workflow_triggers(enabled, next_check_at);

-- 실행 인스턴스. def_snapshot 은 «run 시작 시점» 정의의 immutable 복사 (JSON).
-- worktree_path/worktree_branch (po_run_worktree_v1): PO «워크플로우로 실행» run 은 공유
-- repo 가 아니라 per-run worktree(`po/<id8>` 브랜치)에서 돈다 — 동시 run 간 작업트리·git
-- 인덱스 충돌 방지. 이 두 컬럼은 그 격리 worktree 의 경로/브랜치를 «기록»해 추적·정리(GC,
-- reaper brief)를 가능케 한다. 일반 캔버스 run(트리거·수동)은 worktree 없이 돌아 둘 다 NULL.
CREATE TABLE IF NOT EXISTS workflow_runs (
  id              TEXT PRIMARY KEY,
  workflow_id     TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  def_snapshot    TEXT NOT NULL,
  status          TEXT CHECK(status IN ('running','done','failed','cancelled')) NOT NULL DEFAULT 'running',
  trigger_kind    TEXT NOT NULL,                      -- 'manual'|'cron'|'github'
  worktree_path   TEXT,                               -- per-run 격리 worktree 절대경로 (없으면 NULL = 공유 repo)
  worktree_branch TEXT,                               -- 그 worktree 의 브랜치 (`po/<id8>`). NULL = 격리 없음
  started_at      INTEGER NOT NULL,
  ended_at        INTEGER
);

CREATE INDEX IF NOT EXISTS idx_wf_runs_wf ON workflow_runs(workflow_id, started_at);

-- 노드별 실행. 그래프 간선(=화살표)은 parent_node_run_id 로 표현 — 정적·동적·테스트 분기·
-- 루프 노드가 전부 이 한 테이블에 산다. 동적 생성 노드만 def_node_id=NULL + 엔진이 채운 x/y.
-- 일하는 노드(general/test)는 session_id 로 기존 세션(ChatView/transcript) 을 그대로 물려받는다.
CREATE TABLE IF NOT EXISTS workflow_node_runs (
  id                 TEXT PRIMARY KEY,
  run_id             TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  def_node_id        TEXT,                            -- 정의상 노드 id (동적 노드면 NULL)
  node_type          TEXT NOT NULL,                   -- 'start'|'task'|'end' (옛 'general'/'test' 호환)
  parent_node_run_id TEXT REFERENCES workflow_node_runs(id),
  session_id         TEXT REFERENCES sessions(id),    -- task 가 만든 세션 (start/end 면 NULL)
  title              TEXT,
  agent              TEXT,
  task_folder        TEXT,                            -- <repo>/.psworkflow/Task-<id>/
  status             TEXT NOT NULL DEFAULT 'pending', -- pending|awaiting_approval|running|done|failed|needs_attention|skipped
  verdict            TEXT,                            -- 테스트 노드: 'pass'|'fail' (Phase 1+)
  iteration          INTEGER NOT NULL DEFAULT 0,      -- 루프 반복 횟수 (Phase 2)
  x                  REAL,
  y                  REAL,
  created_at         INTEGER NOT NULL,
  ended_at           INTEGER
);

CREATE INDEX IF NOT EXISTS idx_wf_node_runs_run ON workflow_node_runs(run_id, created_at);

-- PO 루프 — 수집 에이전트가 신호(이슈·레포 todo 등)를 종합해 만든 «기회 브리프».
-- iOS 백로그 탭이 목록/결정(승인·보류·기각)을 소비한다. 수집 세션이 합의된 JSON 파일로
-- 산출하면 po/executor 가 settle 후 ingest 한다. status 전이:
--   proposed → approved(즉시 running, 실행 세션 spawn) | held | rejected
--   running → shipped (구현 세션 첫 turn 정착 시 executor 가 자동 전이)
--   shipped → verified | missed (출시 후 검증 — 다음 수집 사이클이 가설 대조해 종결)
CREATE TABLE IF NOT EXISTS po_briefs (
  id                 TEXT PRIMARY KEY,
  repo_path          TEXT NOT NULL,
  title              TEXT NOT NULL,        -- 문제/기회 한 줄
  problem            TEXT NOT NULL,        -- 상세 문제 정의
  evidence           TEXT NOT NULL,        -- JSON 배열 [{kind, ref, summary}] — 근거 역추적용
  impact             INTEGER NOT NULL,     -- 1~5
  effort             INTEGER NOT NULL,     -- 1~5
  score              REAL NOT NULL,        -- impact/effort 파생 — 백로그 정렬 키
  scope              TEXT NOT NULL,        -- 제안 스코프 (무엇까지 / 무엇은 비-목표)
  spec               TEXT NOT NULL,        -- 초안 스펙 (markdown) — 승인 즉시 실행 가능 수준
  status             TEXT CHECK(status IN ('proposed','approved','held','rejected','running','shipped','verified','missed')) NOT NULL DEFAULT 'proposed',
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  decided_at         INTEGER,
  decide_reason      TEXT,                  -- 보류/기각 사유 태그 (고정 enum 키) — po_decide_reason_v1. 미선택은 NULL.
  decide_note        TEXT,                  -- 결재 사유 자유 메모 (선택) — 태그를 보완하는 한 줄. 없으면 NULL.
  collect_session_id TEXT,                 -- 이 브리프를 만든 수집 세션 (provenance)
  exec_session_id    TEXT,                 -- 승인 후 구현 실행 세션
  revising_session_id TEXT,                -- «수정 지시» 재종합 진행 중 세션 (없으면 NULL)
  research_id        TEXT,                 -- 이 브리프를 만든 리서치 (po_research) — 수집産은 NULL
  verify_note        TEXT,                 -- 출시 후 검증의 판정 사유 한 줄 (verified/missed 에서만)
  exec_workflow_id   TEXT,                 -- «워크플로우로 실행» 승인이 만든 워크플로우 (po_workflow_v1)
  exec_run_id        TEXT,                 -- 그 워크플로우의 run — iOS 브리프 상세가 진행을 표시
  exec_note          TEXT,                 -- 워크플로우 경로 메모 (AI 설계 실패 fallback / 게이트 거부 / run 실패)
  lens               TEXT NOT NULL DEFAULT 'default'  -- 이 브리프를 «쓴 전문가» (po_brief_lens_v1). 수집/리서치가 고른 lens (default/design/bug/qa/security/pm/marketing/analytics/ops/logic/ux). 옛 row·전방위는 'default'. iOS 카드가 전문가 배지로 표시.
);

CREATE INDEX IF NOT EXISTS idx_po_briefs_status ON po_briefs(status, score DESC, created_at DESC);

-- PO 루프 — 프로젝트별 «조사 방식» 프로필. 레포마다 무엇을 어떻게 조사할지(신호 소스,
-- 관점, 제외 영역)를 저장해 두고 매 수집에 재사용한다 — 일회성 지시만으로는 조사 방식이
-- 자산으로 쌓이지 않는다는 피드백(2026-06-11)의 답. 수집 프롬프트에 «프로젝트 프로필»
-- 섹션으로 들어가고, 회차별 지시(instruction)는 그 위에 «이번 지시» 로 얹힌다.
CREATE TABLE IF NOT EXISTS po_profiles (
  repo_path  TEXT PRIMARY KEY,
  directive  TEXT NOT NULL,
  -- 주기 수집 — 5필드 cron 식 (Mac 로컬 타임존). NULL = 주기 수집 꺼짐(수동 «지금 수집» 만).
  -- PoScheduler 가 부팅/저장 시 croner 에 등록하고, tick 마다 startPoCollection 을 호출한다.
  schedule   TEXT,
  -- ASC 스토어 리뷰 신호 — 이 레포 앱의 ASC 앱 ID(또는 번들 ID). NULL = 리뷰 수집 꺼짐.
  -- 켠 레포의 수집만 App Store 고객 리뷰를 fetch 해 프롬프트에 첨부한다 (API 키는 config.json).
  asc_app_id TEXT,
  -- GitHub «피드백 repo» 오버라이드 (owner/name). NULL = 현행대로 로컬 origin 을 GitHub 신호로.
  -- 배경: 이 레포의 origin 은 개발용 소스 repo 라 사용자에게 직접 안내하지 않고, 모든 사용자 피드백(질문·버그·아이디어·
  -- Show&Tell)은 welcome.md 가 안내하는 «공개» repo 의 Discussions/Issues 에 모인다. 비우면
  -- gh 가 로컬 origin(=글 안 쓰는 개발 repo)을 읽어 0건 — 이 컬럼이 «사용자가 실제로 글을 쓰는»
  -- repo 를 명시해 수집 프롬프트가 `gh -R <repo>` 로 읽게 한다. 코드/TODO/git/문서 신호는 그대로
  -- 로컬 repo_path 기준 (피드백 repo 는 GitHub 이슈·Discussions 에만 영향).
  github_feedback_repo TEXT,
  -- 디자인 컨텍스트 «선언» — 이 레포가 자기 색/상태/로케일/접근성 약속을 직접 명시한 텍스트.
  -- NULL = 선언 없음 → 수집·리서치·워크플로우 설계 프롬프트의 「디자인 제약」 섹션이 «자동
  -- 발견»(레포의 디자인 SSOT 를 스택-중립적으로 탐색해 따르라)으로 동작한다. 설정 시 그 텍스트가
  -- 섹션에 그대로 박힌다 — github_feedback_repo 와 동형의 «프로젝트별 주입». 특정 팔레트/로케일
  -- 수를 코드에 하드코딩하지 않는다(레포-무관): 정책은 언제나 «이 레포» 에서 나온다.
  design_directive TEXT,
  -- 디자인 «부트스트랩» 초안 (po_design_bootstrap_v1) — design_directive 를 손으로 쓰는 건 채택
  -- 장벽이라 대부분 NULL 로 방치된다. 디자이너 에이전트가 이 레포의 디자인 SSOT(토큰/테마·i18n
  -- 카탈로그·디자인 문서)를 스캔해 directive 마크다운 «초안» 을 만들어 여기 둔다. 사람이 iOS/Mac
  -- 설정 «디자인» 영역에서 검토·승인하면 그때 design_directive 로 «복사»된다 (자동 적용 금지).
  -- NULL = 초안 없음. design_directive_draft_session_id = 생성 세션(NULL 이면 «생성 중» 아님),
  -- design_directive_draft_at = 초안 산출 epoch ms (검토 UI 표시용).
  design_directive_draft TEXT,
  design_directive_draft_session_id TEXT,
  design_directive_draft_at INTEGER,
  -- 주기 수집 «전문가 관점» 렌즈 (po_collect_lens_v1, +'security' 는 po_collect_lens_v2) —
  -- 'default'(전방위)|'design'(디자인 부채)|'bug'(디버깅·신뢰성)|'security'(인증·키·노출면·자격증명·
  -- 위협모델). 주기 수집(scheduler)이 매일 어느 초점으로 신호를 모을지 «고정»해 둔다. 수동 수집은
  -- 회차 인자가 이 값보다 우선(instruction↔directive 와 동형). 옛 row 는 DEFAULT 'default' 로 채워져
  -- 회귀 0 (렌즈 미선택 = 머리말 없는 전방위 수집). 자유 텍스트라 마이그레이션 불필요(parseLens 가
  -- 화이트리스트 검증·폴백). lens.ts 가 SSOT.
  lens TEXT NOT NULL DEFAULT 'default',
  -- 직전 수집의 «App Store 신호원 실행 상태» (po_signal_status_v1) — store/crash 가 실제 반영됐는지
  -- (used/empty)·꺼짐(off)·실패(key_missing/auth/app_id/network)를 신호원별로 담은 JSON. iOS 백로그가
  -- GET /collect/last 로 읽어 «수집 결과 카드» 를 띄운다 (signals.ts CollectSignals 와 1:1). 무음
  -- 강등 차단 — 켠 신호가 키/네트워크로 빠졌는데도 «반영된 줄» 착각하던 구멍을 메운다. NULL = 아직
  -- 수집 없음/옛 row → 카드 숨김. last_collect_session_id = 그 상태를 만든 수집 세션(iOS 가 방금
  -- 시작한 수집과 일치하는지로 «이번 수집 결과» 인지 판정), last_collect_at = persist epoch ms.
  last_collect_signals TEXT,
  last_collect_session_id TEXT,
  last_collect_at INTEGER,
  updated_at INTEGER NOT NULL
);

-- PO 루프 — «리서치 요청». 사용자가 주제를 정하면 에이전트가 웹+레포를 조사해 보고서와
-- 브리프를 만든다 (내부 신호 채굴로는 «완전히 새로운 일» 의 근거를 못 만든다는 피드백의 답).
-- 보고서는 브리프 근거의 원문으로 보존 — po_briefs.research_id 가 역추적 링크.
CREATE TABLE IF NOT EXISTS po_research (
  id          TEXT PRIMARY KEY,
  repo_path   TEXT NOT NULL,
  topic       TEXT NOT NULL,                -- 사용자가 정한 조사 주제/질문
  report      TEXT,                         -- 조사 보고서 (markdown) — 완료 시 채움
  status      TEXT CHECK(status IN ('running','done','failed')) NOT NULL DEFAULT 'running',
  session_id  TEXT,                         -- 리서치 세션 (관전용)
  brief_count INTEGER NOT NULL DEFAULT 0,   -- 이 리서치가 만든 브리프 수
  lens        TEXT NOT NULL DEFAULT 'default', -- «전문가 관점» (po_research_lens_v1) — default(전방위)|design|bug
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 라이브 프리뷰 (preview_proxy_v1) — 사용자가 «세션별로 명시 허용» 한 로컬 dev 서버 포트.
-- 폰에서 dev 서버(localhost:3000 류)를 보려면, daemon 의 프리뷰 리버스 프록시가 이 표에
-- «등록된» (session_id, port) 로만 forward 한다(기본 차단). sshd direct-tcpip 화이트리스트는
-- 프록시 «고정 포트» 하나만 열고, 실제 dev 포트의 허용 여부는 이 등록부가 결정한다 — 즉
-- «사용자가 등록한 포트만» 이 효과적으로 뚫린다. 세션이 지워지면 CASCADE 로 함께 정리.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS preview_ports (
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  port        INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (session_id, port)
);

CREATE INDEX IF NOT EXISTS idx_preview_ports_session ON preview_ports(session_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- 머지 큐 (merge_queue_v1) — 워크트리/세션이 만든 작업 브랜치(po/<id8> 등)를 main / release/*
-- 로 합치는 «재결합» 을 daemon 이 «직렬 큐» 로 한 번에 하나씩 처리한다. 10~20 워크트리가
-- 동시에 머지 요청해도 둘 이상이 동시에 target 에 쓰지 않게(직렬 보장) — 충돌로 에이전트가
-- 멈추는 구조적 실패 지점을 제거한다. 처리 단위는 MergeQueue(merge/queue.ts) 싱글톤이며,
-- 충돌이면 머지를 «보류» 하고 해당 항목만 conflict 로 표시한 뒤 나머지를 계속 처리한다.
-- status 전이:
--   queued → processing → merged (성공)
--                       → conflict (사전/실제 머지가 충돌 — 사용자 개입 필요, 큐는 계속)
--                       → failed (dirty 워크트리·무관 히스토리·git 오류 등)
--   queued → cancelled (사용자가 처리 전 취소)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS merge_requests (
  id              TEXT PRIMARY KEY,
  repo_path       TEXT NOT NULL,
  source_branch   TEXT NOT NULL,                 -- 합칠 작업 브랜치 (po/<id8> 등)
  target_branch   TEXT NOT NULL,                 -- main | release/*
  -- 이 머지를 요청한 세션 (provenance + iOS 세션 행 배지 매핑). 세션이 지워져도 큐 이력은
  -- 남겨야 하므로 FK/CASCADE 를 의도적으로 안 건다 (cron_runs.session_id 와 같은 정책).
  session_id      TEXT,
  -- 1 이면 머지 성공 후 source 워크트리(git worktree remove) + 브랜치 삭제로 누적 방지.
  cleanup         INTEGER NOT NULL DEFAULT 0,
  -- 1 이면 fast-forward 가능해도 머지 커밋을 강제(--no-ff) — 합류 이력 보존용. 기본 0(ff 허용).
  no_ff           INTEGER NOT NULL DEFAULT 0,
  status          TEXT CHECK(status IN ('queued','processing','merged','conflict','failed','cancelled')) NOT NULL DEFAULT 'queued',
  result          TEXT,                          -- 성공 종류 'up_to_date'|'fast_forward'|'merged'
  merge_commit    TEXT,                          -- 성공 시 머지 커밋/갱신된 target tip SHA
  conflict_files  TEXT,                          -- JSON 배열 — 충돌 파일 (conflict 일 때)
  error           TEXT,                          -- 실패/충돌 사람 가독 메시지
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  started_at      INTEGER,                        -- processing 진입 시각
  ended_at        INTEGER                         -- 종결(merged/conflict/failed/cancelled) 시각
);

CREATE INDEX IF NOT EXISTS idx_merge_requests_status ON merge_requests(status, created_at);
CREATE INDEX IF NOT EXISTS idx_merge_requests_session ON merge_requests(session_id);
CREATE INDEX IF NOT EXISTS idx_merge_requests_repo ON merge_requests(repo_path, created_at);

-- ─────────────────────────────────────────────────────────────────────────────
-- PO 브리프 — 실행·정리 에이전트 ID 컬럼 (po_agent_echo_v1).
-- 배경: iOS 가 agent 인자를 빠뜨리면 daemon 이 조용히 claude_code 로 폴백해 사용자가
-- «실제로 무엇이 돌고 있는지» 모르게 되는 무음 실패가 3회+ 재발. 브리프 카드/상세에
-- 실행 에이전트를 표시하고, 픽커와 다르면 경고를 띄운다.
--
-- 이 컬럼들은 schema.sql 의 «무조건» ALTER 가 아니라 db/index.ts 의 applyMigrations
-- (ensureColumn: po_briefs.exec_agent_id / cleanup_agent_id) 가 멱등으로 추가한다.
-- 옛 버전엔 여기에 raw `ALTER TABLE ... ADD COLUMN` 두 줄이 있었으나, db() 가 매 오픈마다
-- schema.sql 을 exec 하므로 «이미 마이그레이션된 DB» 를 두 번째로 열면 "duplicate column
-- name" 으로 깨졌다 (daemon 재시작·시드/정리 별도 호출 등). 멱등 보장을 위해 제거하고
-- applyMigrations 로 일원화한다.
