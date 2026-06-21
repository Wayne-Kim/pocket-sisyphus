/**
 * 캡처/검증용 «데모 데이터» 시드/정리 — 단일 진입점 (demo_seed_v1).
 *
 * 배경: 스토어 스크린샷·브리프 검증에 쓰는 대표 데이터를 그동안 라이브 DB 에 손수
 * INSERT 하고 손수 DELETE 했다. 격리 DB(POCKET_CLAUDE_CONFIG_DIR) 가 생겨도 시드/정리가
 * 문서 속 SQL 스니펫으로만 존재하면 매번 즉흥 SQL 을 짜다 누락·오타로 깨진다. 이 모듈이
 * 재사용 가능한 시드/teardown 진입점이다.
 *
 * ## 불변식
 * - 모든 쓰기는 `db()` 를 거친다 → schema.sql + applyMigrations 를 «항상» 통과한다.
 *   raw sqlite3 로 마이그레이션을 우회하지 않는다 (스키마 드리프트 방지).
 * - teardown 은 `demo-store-` prefix 행만 지운다. 전체 wipe·백업복원·DROP 은 «절대» 안 한다.
 * - seed 는 멱등이다. 같은 prefix 의 기존 데모 행을 먼저 비우고 다시 넣어, 몇 번 돌려도
 *   결과가 동일하다. 비-데모(사용자) 행은 어느 단계에서도 건드리지 않는다.
 *
 * 어느 DB 에 쓸지는 `db()` → `config.DB_FILE` 이 정한다. 검증/캡처 시엔
 * `POCKET_CLAUDE_CONFIG_DIR` 로 격리 디렉터리를 가리켜 실 DB 를 열지 않게 한다.
 */
import { db } from "../db/index.js";
import { isIsolatedConfigDir, DB_FILE } from "../config.js";

/** seed/teardown 진입 가드 옵션. */
export type DemoWriteOptions = {
  /** 격리 미설정이어도 «실 DB» 에 쓰기를 강제 허용. CLI `--force` / `DEMO_ALLOW_REAL_DB=1` 와 동치. */
  force?: boolean;
};

/**
 * 가드 위반(격리 DB 가 아니고 우회도 없음) 시 던지는 에러. CLI 는 이걸 잡아 stderr 로 명확히
 * 안내하고 비-0 종료한다. db() 를 «열기 전» 에 던져, 어떤 행도 INSERT/DELETE 되지 않게 한다.
 */
export class DemoRealDbGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DemoRealDbGuardError";
  }
}

/**
 * 데모 쓰기(seed/teardown)가 «격리 DB» 를 향하는지 db() 를 열기 «전» 에 검증한다.
 *
 * - 격리(POCKET_CLAUDE_CONFIG_DIR 가 실 경로와 다른 디렉터리) → 그대로 통과.
 * - 격리 아님 + 우회 플래그(`force` 또는 `DEMO_ALLOW_REAL_DB=1`) → stderr 경고 후 통과.
 * - 격리 아님 + 우회 없음 → DemoRealDbGuardError 로 거부 (쓰기 0).
 */
export function assertDemoWriteAllowed(opts?: DemoWriteOptions): void {
  if (isIsolatedConfigDir()) return;
  const forced = opts?.force === true || process.env.DEMO_ALLOW_REAL_DB === "1";
  if (forced) {
    process.stderr.write(
      `⚠️  실 DB 에 씁니다 — POCKET_CLAUDE_CONFIG_DIR 격리 없이 우회 플래그로 강제 실행 중입니다.\n` +
        `   대상 DB: ${DB_FILE}\n`,
    );
    return;
  }
  throw new DemoRealDbGuardError(
    `거부: 데모 쓰기는 격리 DB 에서만 허용됩니다 (실 데이터 오염 방지).\n` +
      `현재 대상 DB 는 실(=운영) 경로입니다: ${DB_FILE}\n` +
      `→ 격리 디렉터리를 가리킨 뒤 다시 실행하세요:\n` +
      `    POCKET_CLAUDE_CONFIG_DIR=/tmp/ps-demo tsx src/cli/demo.ts <seed|teardown>\n` +
      `→ 정말 실 DB 에 써야 한다면 --force (또는 DEMO_ALLOW_REAL_DB=1) 로 명시하세요.`,
  );
}

/**
 * 모든 데모 행 식별의 단일 키. 시드가 만드는 모든 행의 PRIMARY KEY 는 이 prefix 로 시작하고,
 * teardown 은 오직 이 prefix 로 시작하는 행만 지운다.
 */
export const DEMO_PREFIX = "demo-store-";

/** teardown/seed 가 정리·삽입하는 테이블과 그 식별 컬럼. 순서 = FK 안전한 삭제 순서. */
const DEMO_TABLES = [
  { table: "messages", column: "id" },
  { table: "po_briefs", column: "id" },
  { table: "sessions", column: "id" },
] as const;

/** 결정적(deterministic) 타임스탬프 기준 — 시드를 몇 번 돌려도 같은 값이 박히도록 고정. */
const BASE_TS = 1_700_000_000_000;

type SessionSeed = {
  id: string;
  title: string;
  repo_path: string;
  created_at: number;
  ended_at: number | null;
  status: "active" | "completed" | "error";
};

type MessageSeed = {
  id: string;
  session_id: string;
  role: string;
  type: string;
  payload: string;
  created_at: number;
};

type BriefSeed = {
  id: string;
  repo_path: string;
  title: string;
  problem: string;
  evidence: string;
  impact: number;
  effort: number;
  score: number;
  scope: string;
  spec: string;
  status:
    | "proposed"
    | "approved"
    | "held"
    | "rejected"
    | "running"
    | "shipped"
    | "verified"
    | "missed";
  created_at: number;
  updated_at: number;
};

const DEMO_REPO = "/Users/demo/Projects/store-demo";

const DEMO_SESSIONS: SessionSeed[] = [
  {
    id: `${DEMO_PREFIX}session-chat`,
    title: "데모 — 결제 화면 리팩터",
    repo_path: DEMO_REPO,
    created_at: BASE_TS,
    ended_at: BASE_TS + 600_000,
    status: "completed",
  },
  {
    id: `${DEMO_PREFIX}session-active`,
    title: "데모 — 온보딩 버그 수정",
    repo_path: DEMO_REPO,
    created_at: BASE_TS + 60_000,
    ended_at: null,
    status: "active",
  },
];

const DEMO_MESSAGES: MessageSeed[] = [
  {
    id: `${DEMO_PREFIX}msg-1`,
    session_id: `${DEMO_PREFIX}session-chat`,
    role: "user",
    type: "text",
    payload: JSON.stringify({ text: "결제 화면 버튼 색을 토큰으로 정리해줘" }),
    created_at: BASE_TS + 1_000,
  },
  {
    id: `${DEMO_PREFIX}msg-2`,
    session_id: `${DEMO_PREFIX}session-chat`,
    role: "assistant",
    type: "pty_chunk",
    payload: JSON.stringify({
      bytes_b64: Buffer.from("결제 버튼을 accent 토큰으로 교체했어요.\n", "utf8").toString("base64"),
    }),
    created_at: BASE_TS + 2_000,
  },
  {
    id: `${DEMO_PREFIX}msg-3`,
    session_id: `${DEMO_PREFIX}session-active`,
    role: "user",
    type: "text",
    payload: JSON.stringify({ text: "온보딩 첫 화면이 빈 채로 뜨는 버그를 봐줘" }),
    created_at: BASE_TS + 61_000,
  },
];

const DEMO_BRIEFS: BriefSeed[] = [
  {
    id: `${DEMO_PREFIX}brief-1`,
    repo_path: DEMO_REPO,
    title: "결제 화면 색 토큰 불일치 정리",
    problem:
      "결제 화면이 리터럴 색(.blue/.orange)을 직접 써서 다크 모드 대비가 깨지고 디자인 약속과 어긋난다.",
    evidence: JSON.stringify([
      { kind: "code", ref: "PaymentView.swift:42", summary: "리터럴 .blue 사용" },
      { kind: "feedback", ref: "discussions/12", summary: "다크 모드에서 버튼이 안 보임" },
    ]),
    impact: 4,
    effort: 2,
    score: 2.0,
    scope: "결제 화면의 색만 의미 토큰으로 교체. 레이아웃·복사문구는 비-목표.",
    spec: "# 스펙\n\n- 리터럴 색을 Theme 토큰(accent/success/danger)으로 교체.\n- 다크/라이트 대비 검증.",
    status: "proposed",
    created_at: BASE_TS + 120_000,
    updated_at: BASE_TS + 120_000,
  },
  {
    id: `${DEMO_PREFIX}brief-2`,
    repo_path: DEMO_REPO,
    title: "온보딩 빈 화면 회귀 가드",
    problem: "온보딩 첫 진입 시 데이터 로드 실패가 빈 화면으로 노출된다.",
    evidence: JSON.stringify([
      { kind: "bug", ref: "issues/34", summary: "첫 실행에서 빈 화면" },
    ]),
    impact: 5,
    effort: 3,
    score: 1.67,
    scope: "온보딩 빈/오류 상태 placeholder 추가. 데이터 파이프라인 재설계는 비-목표.",
    spec: "# 스펙\n\n- 로드 실패 시 IconSize placeholder + 재시도 버튼.\n- localize 된 안내문.",
    status: "approved",
    created_at: BASE_TS + 180_000,
    updated_at: BASE_TS + 180_000,
  },
];

/** 데모 prefix 로 시작하는 행만 삭제한다. 비-데모 행과 다른 테이블은 건드리지 않는다. */
export function teardownDemo(opts?: DemoWriteOptions): { deleted: number } {
  assertDemoWriteAllowed(opts);
  const d = db();
  return teardownDemoOn(d);
}

/** 가드를 «이미 통과한» 호출용 내부 정리 — 같은 db 핸들 위에서 prefix 행만 지운다. */
function teardownDemoOn(d: ReturnType<typeof db>): { deleted: number } {
  let deleted = 0;
  const run = d.transaction(() => {
    for (const { table, column } of DEMO_TABLES) {
      const res = d
        .prepare(`DELETE FROM ${table} WHERE ${column} LIKE ? || '%'`)
        .run(DEMO_PREFIX);
      deleted += res.changes;
    }
  });
  run();
  return { deleted };
}

/**
 * 대표 데모 데이터를 멱등 삽입한다. 같은 prefix 의 기존 데모 행을 먼저 비운 뒤 다시 넣어
 * 몇 번을 돌려도 결과가 동일하다. 비-데모 행은 건드리지 않는다.
 */
export function seedDemo(opts?: DemoWriteOptions): {
  sessions: number;
  messages: number;
  briefs: number;
} {
  assertDemoWriteAllowed(opts);
  const d = db();
  const insertSession = d.prepare(
    `INSERT INTO sessions (id, title, repo_path, created_at, ended_at, status)
     VALUES (@id, @title, @repo_path, @created_at, @ended_at, @status)`,
  );
  const insertMessage = d.prepare(
    `INSERT INTO messages (id, session_id, role, type, payload, created_at)
     VALUES (@id, @session_id, @role, @type, @payload, @created_at)`,
  );
  const insertBrief = d.prepare(
    `INSERT INTO po_briefs (id, repo_path, title, problem, evidence, impact, effort, score, scope, spec, status, created_at, updated_at)
     VALUES (@id, @repo_path, @title, @problem, @evidence, @impact, @effort, @score, @scope, @spec, @status, @created_at, @updated_at)`,
  );
  const run = d.transaction(() => {
    teardownDemoOn(d);
    for (const s of DEMO_SESSIONS) insertSession.run(s);
    for (const m of DEMO_MESSAGES) insertMessage.run(m);
    for (const b of DEMO_BRIEFS) insertBrief.run(b);
  });
  run();
  return {
    sessions: DEMO_SESSIONS.length,
    messages: DEMO_MESSAGES.length,
    briefs: DEMO_BRIEFS.length,
  };
}

/** 현재 격리 DB 에 남아 있는 데모 prefix 행 수 — 검증/리포트용. */
export function countDemoRows(): number {
  const d = db();
  let total = 0;
  for (const { table, column } of DEMO_TABLES) {
    const row = d
      .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} LIKE ? || '%'`)
      .get(DEMO_PREFIX) as { n: number };
    total += row.n;
  }
  return total;
}
