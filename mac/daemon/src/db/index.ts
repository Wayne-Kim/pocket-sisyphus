import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DB_FILE, ensureConfigDir } from "../config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(__dirname, "schema.sql");

let _db: Database.Database | null = null;

export function db(): Database.Database {
  if (_db) return _db;
  ensureConfigDir();
  _db = new Database(DB_FILE);
  _db.pragma("journal_mode = WAL");
  // SQLITE_BUSY 흡수 — cron·workflow·다중 PTY 세션이 같은 DB 파일에 동시에 쓰면 쓰기 락
  // 경합으로 일시 SQLITE_BUSY 가 난다. better-sqlite3 는 «동기» 라 busy_timeout 동안 write 가
  // 락을 얻을 때까지 블로킹 대기하므로, 단발 경합으로 INSERT 가 throw 해 PTY 출력이 유실되는
  // 걸 막는다(핫패스: pty-runner 의 pty_chunk insert). 5초면 정상 경합엔 충분, 진짜 데드락만
  // 그 뒤 throw 되어 상위에서 격리·로깅된다.
  _db.pragma("busy_timeout = 5000");
  _db.pragma("foreign_keys = ON");
  const schema = fs.readFileSync(SCHEMA_PATH, "utf8");
  _db.exec(schema);
  applyMigrations(_db);
  reportCheckConstraintDrift(_db);
  return _db;
}

/**
 * 테스트 전용 — 모듈 레벨 singleton 을 비워서 다음 `db()` 호출이 새 파일을 열도록 한다.
 * 운영 코드 경로에서는 호출되지 않는다 (daemon 은 process 1개 = DB 1개).
 *
 * 호출 후 다음 `db()` 까지의 사이에 `vi.mock("../config.js", ...)` 로 `DB_FILE` 을
 * 다른 경로로 박아두면 새 in-memory / tmp DB 가 열린다.
 */
export function _resetDbForTest(): void {
  if (_db) {
    try { _db.close(); } catch { /* already closed */ }
    _db = null;
  }
}

/**
 * 가벼운 in-place 마이그레이션. CREATE TABLE IF NOT EXISTS 만으론 기존 테이블에
 * 새 컬럼이 안 붙으므로, SQLite 의 PRAGMA table_info 로 확인 후 ALTER TABLE 한다.
 * 새 컬럼만 추가하는 forward-only 마이그레이션 (롤백/제거는 의도적으로 안 함).
 */
function applyMigrations(d: Database.Database): void {
  const ensureColumn = (
    table: string,
    column: string,
    type: string,
  ): void => {
    const rows = d.prepare(`PRAGMA table_info(${table})`).all() as {
      name: string;
    }[];
    if (rows.some((r) => r.name === column)) return;
    d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    console.log(`[db] migration: added ${table}.${column}`);
  };
  ensureColumn("sessions", "parent_sdk_session_id", "TEXT");
  // 0/1 만 들어가지만 SQLite 에 BOOLEAN 타입 alias 없음 → INTEGER. NOT NULL DEFAULT 0
  // 은 ALTER TABLE 에서도 그대로 적용된다 (기존 row 는 0 으로 채워짐).
  ensureColumn("sessions", "skip_permissions", "INTEGER NOT NULL DEFAULT 0");
  // runner 모드 컬럼. 옛 'sdk' runner 제거 이후 신규 세션은 항상 'pty'. 기존 DB 에 mode='sdk'
  // 행이 살아 있을 수 있으나 application 이 routes/sessions.ts 에서 410 으로 reject 한다.
  // CHECK 제약은 schema.sql 에만 박혀 있고 ALTER 로 강화할 수 없어 기존 DB 는 그대로 유지.
  ensureColumn("sessions", "mode", "TEXT NOT NULL DEFAULT 'pty'");
  // 어떤 코드 에이전트 CLI 로 spawn 할지 — 'claude_code' / 'agy' 등. 옛 row 는 모두
  // claude_code 였으므로 DEFAULT 가 그 호환을 잡아 준다.
  ensureColumn("sessions", "agent", "TEXT NOT NULL DEFAULT 'claude_code'");
  // 세션 단위 알림 음소거 — 1 이면 이 세션의 Discord 알림을 모두 끈다. 기존 row 는 0(켜짐).
  ensureColumn("sessions", "notify_muted", "INTEGER NOT NULL DEFAULT 0");
  // "보관됨" 플래그 (session_archive_v1) — 1 이면 기본 세션 목록에서 숨긴다. status 와 직교
  // (완료/오류/활성 무엇이든 보관 가능). 기존 row 는 0(미보관) 으로 채워져 회귀 0.
  ensureColumn("sessions", "archived", "INTEGER NOT NULL DEFAULT 0");
  // 외부-콘텐츠 오염 표식 (capability_caps T1) — 1 이면 이 세션이 개인/외부 데이터를 적재해
  // «오염» 됐고, EGRESS 가 기본 deny 된다(taint.ts). 단조(해제 없음)·continue/노드/worktree 로
  // 전파. 기존 row 는 0(비오염)으로 채워져 회귀 0. SQLite BOOLEAN 없어 INTEGER.
  ensureColumn("sessions", "external_content_tainted", "INTEGER NOT NULL DEFAULT 0");
  // 예약 작업 종류 — 'agent'(에이전트 프롬프트) | 'terminal'(쉘 스크립트 파일). 기존 row 는
  // 모두 에이전트였으므로 DEFAULT 'agent' 가 호환을 잡는다. CHECK 제약은 schema.sql 에만
  // 박혀 있고 ALTER 로 강화 못 하므로 기존 DB 엔 안 붙는다 (mode 컬럼과 같은 정책).
  ensureColumn("cron_jobs", "kind", "TEXT NOT NULL DEFAULT 'agent'");
  // 터미널 예약의 인터프리터 ('zsh'|'bash'|'sh'). NULL = 사용자 기본 셸. 에이전트 예약은 NULL.
  ensureColumn("cron_jobs", "shell", "TEXT");
  // PO 브리프 «수정 지시» 재종합이 진행 중인 세션. non-null = 재종합 중 (iOS 배지).
  // 새 status 값 대신 컬럼인 이유: po_briefs.status 의 CHECK 제약이 기존 DB 에 박혀 있어
  // 값 추가가 마이그레이션 불가 — 상태 직교 컬럼이 안전하다.
  ensureColumn("po_briefs", "revising_session_id", "TEXT");
  // 이 브리프를 만든 리서치(po_research) — 보고서 역추적 링크. 수집産 브리프는 NULL.
  ensureColumn("po_briefs", "research_id", "TEXT");
  // 출시 후 검증의 판정 사유 한 줄 — verified/missed 전이 시 수집 사이클이 채운다.
  ensureColumn("po_briefs", "verify_note", "TEXT");
  // 보류/기각 사유 태그 (po_decide_reason_v1) — 고정 enum 키. 결재가 «왜» 됐는지의 원천
  // 데이터(후속 사유 집계의 선행). 미선택 허용 → NULL. 과거 행은 NULL 회귀 0.
  ensureColumn("po_briefs", "decide_reason", "TEXT");
  // 결재 사유 자유 메모 (선택) — 태그를 보완하는 한 줄. 없으면 NULL.
  ensureColumn("po_briefs", "decide_note", "TEXT");
  // 기각된 브리프의 «코드 흔적 정리»(TODO 주석·죽은 코드 제거) 세션 — po_cleanup_v1.
  // non-null = 정리 세션이 만들어진 적 있음 (iOS 가 «정리 세션 보기» 진입점을 띄운다).
  ensureColumn("po_briefs", "cleanup_session_id", "TEXT");
  // 승인을 «워크플로우로 실행» 한 경우 (po_workflow_v1) — 생성된 워크플로우/run 링크.
  // 세션 모드 승인은 둘 다 NULL (exec_session_id 만). iOS 브리프 상세가 run 진행을 보여준다.
  ensureColumn("po_briefs", "exec_workflow_id", "TEXT");
  ensureColumn("po_briefs", "exec_run_id", "TEXT");
  // 워크플로우 실행 경로의 사람 가독 메모 — «AI 설계 실패 → 기본 템플릿 사용» / «게이트 거부» /
  // «run 실패» 등 원인 추적용. 정상 흐름이면 NULL.
  ensureColumn("po_briefs", "exec_note", "TEXT");
  // «실제로» 돌린 실행/정리 코드 에이전트 ID (po_agent_echo_v1) — iOS 가 agent 인자를 빠뜨려
  // daemon 이 조용히 claude_code 로 폴백한 무음 실패를 드러내기 위함. 옛 row 는 NULL → 칩/경고
  // 숨김으로 회귀 0.
  ensureColumn("po_briefs", "exec_agent_id", "TEXT");
  ensureColumn("po_briefs", "cleanup_agent_id", "TEXT");
  // 이 브리프를 «쓴 전문가» 렌즈 (po_brief_lens_v1) — 수집/리서치가 고른 lens 를 브리프에 직접 박아
  // iOS 카드가 JOIN 없이 전문가 배지를 띄운다. 옛 row·전방위는 DEFAULT 'default' → 배지 숨김으로
  // 회귀 0. po_research.lens / po_profiles.lens 와 동형 (CHECK 는 schema.sql 에만, ALTER 미강화).
  ensureColumn("po_briefs", "lens", "TEXT NOT NULL DEFAULT 'default'");
  // 주기 수집 — 레포별 5필드 cron 식. NULL = 꺼짐 (수동 «지금 수집» 만).
  ensureColumn("po_profiles", "schedule", "TEXT");
  // ASC 스토어 리뷰 신호 — 이 레포 앱의 ASC 앱 ID(또는 번들 ID). NULL = 리뷰 수집 꺼짐.
  ensureColumn("po_profiles", "asc_app_id", "TEXT");
  // GitHub «피드백 repo» 오버라이드 (owner/name). NULL = 현행대로 로컬 origin 을 GitHub 신호로.
  // 비면 기존 동작 그대로 — 옛 row 는 NULL 로 채워져 회귀 없음.
  ensureColumn("po_profiles", "github_feedback_repo", "TEXT");
  // 디자인 컨텍스트 «선언» — 레포가 자기 색/상태/로케일/접근성 약속을 직접 명시한 텍스트.
  // NULL = 선언 없음 → 「디자인 제약」 섹션이 «자동 발견» 으로 동작 (옛 row 는 NULL → 회귀 없음).
  ensureColumn("po_profiles", "design_directive", "TEXT");
  // 디자인 «부트스트랩» 초안 (po_design_bootstrap_v1) — 디자이너 에이전트가 레포 디자인 SSOT 를
  // 스캔해 만든 directive 마크다운 초안. 사람이 승인하면 design_directive 로 «복사»된다(자동 적용
  // 금지). *_session_id = 생성 세션(non-null 이면 «생성 중»), *_at = 초안 산출 epoch ms.
  ensureColumn("po_profiles", "design_directive_draft", "TEXT");
  ensureColumn("po_profiles", "design_directive_draft_session_id", "TEXT");
  ensureColumn("po_profiles", "design_directive_draft_at", "INTEGER");
  // 리서치 «전문가 관점» 렌즈 (po_research_lens_v1) — 'default'(전방위)|'design'|'bug'. 옛 row 는
  // DEFAULT 'default' 로 채워져 회귀 0 (전방위 리서치 = 머리말 없는 기존 동작). CHECK 제약은
  // schema.sql 에만 박히고 ALTER 로 강화 못 하므로 기존 DB 엔 안 붙는다 (mode 컬럼과 같은 정책).
  ensureColumn("po_research", "lens", "TEXT NOT NULL DEFAULT 'default'");
  // 주기 수집 «전문가 관점» 렌즈 (po_collect_lens_v1) — 'default'(전방위)|'design'|'bug'. 주기 수집
  // (scheduler)이 매일 어느 초점으로 신호를 모을지 고정. 수동 수집은 회차 인자가 우선. 옛 row 는
  // DEFAULT 'default' 로 채워져 회귀 0 (전방위 수집 = 머리말 없는 기존 동작). po_research.lens 와 동형.
  ensureColumn("po_profiles", "lens", "TEXT NOT NULL DEFAULT 'default'");
  // 직전 수집의 «App Store 신호원 실행 상태» (po_signal_status_v1) — store/crash 가 실제 반영됐는지
  // (used/empty)·꺼짐(off)·실패(key_missing/auth/app_id/network)를 신호원별로 담은 JSON. iOS 백로그가
  // GET /collect/last 로 읽어 «수집 결과 카드» 를 띄운다. *_session_id 는 그 상태를 만든 수집 세션
  // (iOS 가 방금 시작한 수집과 일치하는지 판정), *_at 은 persist epoch ms. 옛 row 는 NULL → 카드 숨김.
  ensureColumn("po_profiles", "last_collect_signals", "TEXT");
  ensureColumn("po_profiles", "last_collect_session_id", "TEXT");
  ensureColumn("po_profiles", "last_collect_at", "INTEGER");
  // PO «워크플로우로 실행» run 의 per-run 격리 worktree (po_run_worktree_v1) — 동시 run 이
  // 공유 repo 의 작업트리·git 인덱스를 함께 밟지 않도록 run 마다 `po/<id8>` worktree 에서 돈다.
  // 이 두 컬럼은 그 경로/브랜치를 기록해 추적·정리(GC, reaper brief)를 가능케 한다. 일반 캔버스
  // run(트리거·수동)은 worktree 없이 돌아 둘 다 NULL → 회귀 0.
  ensureColumn("workflow_runs", "worktree_path", "TEXT");
  ensureColumn("workflow_runs", "worktree_branch", "TEXT");
  // fail 루프 가시성 (workflow_retry_visibility_v1) — 재시도 중인 노드가 «왜 되돌아갔는지»(한 줄)와
  // «재시도 한도(MAX_ITERATIONS) 도달로 멈췄는지»를 캔버스에 드러낸다. loopback_reason 은 직전 fail
  // 판정의 verdict.json summary, limit_reached 는 0/1. 옛 row 는 NULL/0 으로 채워져 회귀 0.
  ensureColumn("workflow_node_runs", "loopback_reason", "TEXT");
  ensureColumn("workflow_node_runs", "limit_reached", "INTEGER NOT NULL DEFAULT 0");
  // 합성본 표식 + 예약 실패 표면화 (workflow_attention_v1) — 노드 결과가 «에이전트가 직접 남긴 것»
  // (agent)인지 «터미널 출력 자동 합성본»(synthetic)인지 «빈 결과»(empty)인지 구분하고, run 마감 시
  // 그걸 종합해 «미해결» 신호(attention_kind)를 run 행에 새긴다. attention_ack=1 이면 사용자가 확인함.
  // 옛 row 는 NULL/0 으로 채워져 회귀 0 (NULL = 정상, 표시 없음).
  ensureColumn("workflow_node_runs", "result_kind", "TEXT");
  ensureColumn("workflow_runs", "attention_kind", "TEXT");
  ensureColumn("workflow_runs", "attention_ack", "INTEGER NOT NULL DEFAULT 0");
}

/**
 * 한 CREATE TABLE SQL 문에서 모든 `CHECK(...)` 절을 추출한다. 괄호 균형을 직접 세어
 * `CHECK(status IN ('a','b'))` 처럼 안쪽에 괄호가 더 있는 경우도 통째로 잡는다.
 * 반환값은 비교를 위해 «공백 1칸 정규화» 한 문자열들 (예: "CHECK(mode IN ('pty'))").
 */
function extractCheckClauses(createSql: string): string[] {
  const out: string[] = [];
  const re = /CHECK\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(createSql)) !== null) {
    const open = createSql.indexOf("(", m.index);
    if (open === -1) continue;
    let depth = 0;
    let end = -1;
    for (let i = open; i < createSql.length; i++) {
      const ch = createSql[i];
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) continue;
    const clause = createSql.slice(m.index, end + 1).replace(/\s+/g, " ").trim();
    out.push(clause);
  }
  return out;
}

export type CheckDrift = {
  table: string;
  /** fresh schema.sql 에는 있으나 현재 DB 테이블엔 빠진 CHECK 절들. */
  missing: string[];
};

/**
 * fresh schema.sql 로 만든 «기대» 테이블의 CHECK 제약과 현재(살아있는) DB 테이블의 CHECK
 * 제약을 비교해, 현재 DB 에 «빠진» CHECK 절을 테이블별로 돌려준다.
 *
 * 왜 필요한가: applyMigrations 는 ALTER TABLE ADD COLUMN 으로 «컬럼» 만 따라잡고 CHECK 제약은
 * 붙이지 못한다(SQLite 한계). 그래서 fresh test DB(schema.sql → CHECK 엄격)와 오래 살아온 dev
 * DB(ALTER 만 받아 CHECK 없음)의 무결성 규칙이 어긋나, 잘못된 enum 이 환경에 따라 거부/통과로
 * 갈리는 드리프트가 생긴다. 이 함수가 그 드리프트를 «표면화» 한다.
 *
 * 비파괴적·forward-only: 테이블을 재작성하지 않는다(기존 dev row 에 mode='sdk' 같은 레거시 값이
 * 살아 있어 CHECK 를 소급하면 오히려 회귀를 낳기 때문). 감지만 하고 진단으로 올린다.
 */
export function detectCheckConstraintDrift(d: Database.Database): CheckDrift[] {
  const schema = fs.readFileSync(SCHEMA_PATH, "utf8");
  const fresh = new Database(":memory:");
  try {
    fresh.exec(schema);
    const expected = fresh
      .prepare(
        "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      )
      .all() as { name: string; sql: string | null }[];
    const drift: CheckDrift[] = [];
    for (const t of expected) {
      if (!t.sql) continue;
      const expectedChecks = extractCheckClauses(t.sql);
      if (expectedChecks.length === 0) continue;
      const liveRow = d
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type='table' AND name = ?",
        )
        .get(t.name) as { sql: string | null } | undefined;
      if (!liveRow?.sql) continue;
      const liveChecks = new Set(extractCheckClauses(liveRow.sql));
      const missing = expectedChecks.filter((c) => !liveChecks.has(c));
      if (missing.length > 0) drift.push({ table: t.name, missing });
    }
    return drift;
  } finally {
    fresh.close();
  }
}

/**
 * 기동 시 CHECK 제약 드리프트를 «빨강(danger) 진단» 으로 stderr 에 올린다. DB 는 건드리지 않는다.
 */
function reportCheckConstraintDrift(d: Database.Database): void {
  let drift: CheckDrift[];
  try {
    drift = detectCheckConstraintDrift(d);
  } catch (e) {
    console.error("[db][danger] CHECK 제약 드리프트 점검 실패:", (e as Error).message);
    return;
  }
  if (drift.length === 0) return;
  console.error(
    "[db][danger] 스키마 CHECK 제약 드리프트 감지 — 이 DB 는 fresh schema.sql 보다 무결성 규칙이 " +
      "느슨합니다(ALTER 로 추가된 컬럼은 CHECK 가 안 붙음). 잘못된 enum 값이 조용히 INSERT 될 수 " +
      "있습니다. 영향 테이블:",
  );
  for (const { table, missing } of drift) {
    console.error(`[db][danger]   ${table}: 누락된 CHECK ${missing.join(", ")}`);
  }
}

export type SessionRow = {
  id: string;
  title: string | null;
  repo_path: string;
  created_at: number;
  ended_at: number | null;
  status: "active" | "completed" | "error";
  parent_sdk_session_id: string | null;
  /** 1 이면 매 turn 마다 permissionMode=bypassPermissions 적용. SQLite 가 BOOLEAN 없어 INTEGER. */
  skip_permissions: number;
  /** 현재는 'pty' 만 지원. 옛 'sdk' runner 가 제거됐지만 마이그레이션 안 된 row 가 살아 있을 수 있음. */
  mode: string;
  /** 이 세션이 어느 AgentAdapter 로 spawn 될지 — 'claude_code' / 'agy' 등. */
  agent: string;
  /** 1 이면 이 세션의 알림(Discord)을 발송하지 않는다. SQLite 가 BOOLEAN 없어 INTEGER. */
  notify_muted: number;
  /** 1 이면 «보관됨» — 기본 세션 목록에서 숨긴다 (session_archive_v1). SQLite 가 BOOLEAN 없어 INTEGER. */
  archived: number;
  /** 1 이면 외부-콘텐츠 «오염» 세션 (capability_caps T1) — EGRESS 기본 deny. 단조. SQLite INTEGER. */
  external_content_tainted: number;
};

export type MessageRow = {
  id: string;
  session_id: string;
  role: string;
  type: string;
  payload: string;
  created_at: number;
};

export type ApprovalRow = {
  id: string;
  session_id: string;
  tool_name: string;
  tool_use_id: string | null;
  input_json: string;
  title: string | null;
  display_name: string | null;
  description: string | null;
  decision: "pending" | "allow" | "deny" | "always_allow";
  decided_at: number | null;
  created_at: number;
};

/** 예약 작업 한 건의 정의 — cron_jobs 테이블 row (schema.sql 참고). */
export type CronJobRow = {
  id: string;
  title: string | null;
  /** 'agent' = 에이전트 프롬프트, 'terminal' = 쉘 스크립트 파일 실행. */
  kind: "agent" | "terminal";
  agent: string;
  repo_path: string;
  /** kind='agent': 프롬프트. kind='terminal': 쉘 스크립트 파일 절대경로. */
  command: string;
  /** kind='terminal' 의 인터프리터 ('zsh'|'bash'|'sh'). NULL = 사용자 기본 셸. */
  shell: string | null;
  schedule: string;
  timezone: string | null;
  /** 1 이면 매 실행 skipPermissions 적용. SQLite BOOLEAN 없어 INTEGER. */
  skip_permissions: number;
  session_mode: "fresh" | "continue";
  overlap_policy: "skip" | "allow";
  /** 1 이면 부팅 시 놓친 실행 1회 보충. */
  catch_up: number;
  /** 1 이면 완료 시 Discord 알림. */
  notify: number;
  /** 1 이면 스케줄러가 이 작업을 등록. */
  enabled: number;
  created_at: number;
  updated_at: number | null;
  last_run_at: number | null;
  last_status: string | null;
  last_session_id: string | null;
  next_run_at: number | null;
  run_count: number;
};

/** 예약 작업 한 번의 실행 이력 — cron_runs 테이블 row. */
export type CronRunRow = {
  id: string;
  cron_job_id: string;
  session_id: string | null;
  trigger: "schedule" | "manual";
  started_at: number;
  ended_at: number | null;
  status: "running" | "ok" | "error" | "timeout" | "skipped";
  error: string | null;
};

/** 워크플로우 그래프 정의 — workflows 테이블 row (schema.sql 참고). */
export type WorkflowRow = {
  id: string;
  title: string | null;
  repo_path: string | null;
  /** JSON 배열 (NodeDef[]). workflow/types.ts 의 parseNodes 로 파싱. */
  nodes: string;
  /** JSON 배열 (EdgeDef[]). */
  edges: string;
  enabled: number;
  created_at: number;
  updated_at: number | null;
};

/** 시작 노드 트리거의 런타임 등록부 — workflow_triggers 테이블 row. */
export type WorkflowTriggerRow = {
  id: string;
  workflow_id: string;
  start_node_id: string;
  kind: "manual" | "cron" | "github";
  schedule: string | null;
  timezone: string | null;
  repo_path: string | null;
  branch: string | null;
  poll_seconds: number | null;
  last_sha: string | null;
  enabled: number;
  last_fired_at: number | null;
  next_check_at: number | null;
  created_at: number;
};

/** 워크플로우 한 번의 실행 인스턴스 — workflow_runs 테이블 row. */
export type WorkflowRunRow = {
  id: string;
  workflow_id: string;
  /** 실행 시점 정의의 immutable 스냅샷 (JSON). */
  def_snapshot: string;
  status: "running" | "done" | "failed" | "cancelled";
  trigger_kind: "manual" | "cron" | "github";
  /** per-run 격리 worktree 절대경로 (po_run_worktree_v1). NULL = 공유 repo 에서 실행. */
  worktree_path: string | null;
  /** 그 worktree 의 브랜치 (`po/<id8>`). NULL = 격리 없음. 추적·정리(reaper brief)용. */
  worktree_branch: string | null;
  /** «미해결» 신호 (workflow_attention_v1) — run 마감 시 산출. NULL = 정상. 'failed'|'empty'|'synthetic'. */
  attention_kind: "failed" | "empty" | "synthetic" | null;
  /** 1 = 사용자가 확인/처리함 (배너에서 사라짐). */
  attention_ack: number;
  started_at: number;
  ended_at: number | null;
};

/** 노드별 실행 — workflow_node_runs 테이블 row. 그래프 간선은 parent_node_run_id 로 표현. */
export type WorkflowNodeRunRow = {
  id: string;
  run_id: string;
  def_node_id: string | null;
  // 'task' 가 현행. 'general'/'test' 는 옛 정의·옛 run row 호환용으로 남겨 둔다(통합 전 생성분).
  node_type: "start" | "task" | "end" | "general" | "test";
  parent_node_run_id: string | null;
  session_id: string | null;
  title: string | null;
  agent: string | null;
  task_folder: string | null;
  status:
    | "pending"
    | "awaiting_approval"
    | "running"
    | "done"
    | "failed"
    | "needs_attention"
    | "skipped";
  verdict: "pass" | "fail" | null;
  iteration: number;
  /** 직전 fail 루프로 되돌아간 사유 한 줄 (verdict.json summary). 루프 밖이면 null. */
  loopback_reason: string | null;
  /** 1 = 재시도 한도(MAX_ITERATIONS) 도달로 루프가 멈췄음. */
  limit_reached: number;
  /** 결과물 출처 (workflow_attention_v1). NULL/'agent'(직접 작성)|'synthetic'(터미널 합성)|'empty'(빈 합성). */
  result_kind: "agent" | "synthetic" | "empty" | null;
  x: number | null;
  y: number | null;
  created_at: number;
  ended_at: number | null;
};

/** 머지 큐 한 건 — merge_requests 테이블 row (schema.sql 참고). */
export type MergeRequestRow = {
  id: string;
  repo_path: string;
  source_branch: string;
  target_branch: string;
  /** 이 머지를 요청한 세션 (provenance / iOS 배지 매핑). FK 안 검 — 세션 삭제돼도 이력 보존. */
  session_id: string | null;
  /** 1 이면 머지 후 source 워크트리+브랜치 정리. SQLite BOOLEAN 없어 INTEGER. */
  cleanup: number;
  /** 1 이면 fast-forward 가능해도 머지 커밋 강제(--no-ff). */
  no_ff: number;
  status: "queued" | "processing" | "merged" | "conflict" | "failed" | "cancelled";
  /** 성공 종류 — 'up_to_date'|'fast_forward'|'merged'. */
  result: string | null;
  /** 성공 시 머지 커밋/갱신된 target tip SHA. */
  merge_commit: string | null;
  /** JSON 배열 (충돌 파일). conflict 일 때만 채움. */
  conflict_files: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  ended_at: number | null;
};
