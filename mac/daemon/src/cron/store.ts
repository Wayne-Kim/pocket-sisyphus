/**
 * cron_jobs / cron_runs 테이블 접근 계층 — 순수 DB 연산만. 검증/스케줄링/실행은 라우트와
 * scheduler/executor 가 한다. better-sqlite3 prepared statement 패턴 (routes/sessions.ts 와 동일).
 */
import { randomUUID } from "node:crypto";
import { db, type CronJobRow, type CronRunRow } from "../db/index.js";

/** 생성 시 받는 필드 — 검증/정규화는 라우트가 끝낸 뒤 넘긴다. */
export type CronJobInput = {
  title: string | null;
  /** 'agent' = 에이전트 프롬프트, 'terminal' = 쉘 스크립트 파일 실행. */
  kind: "agent" | "terminal";
  agent: string;
  repoPath: string;
  /** kind='agent': 프롬프트. kind='terminal': 쉘 스크립트 파일 절대경로. */
  command: string;
  /** kind='terminal' 인터프리터 ('zsh'|'bash'|'sh'). null = 사용자 기본 셸. agent 면 null. */
  shell: string | null;
  schedule: string;
  timezone: string | null;
  skipPermissions: boolean;
  sessionMode: "fresh" | "continue";
  overlapPolicy: "skip" | "allow";
  catchUp: boolean;
  notify: boolean;
  enabled: boolean;
};

/** 수정 가능한 컬럼만 — 부분 패치. undefined 인 키는 건드리지 않는다. */
export type CronJobPatch = Partial<CronJobInput>;

const SELECT_COLS = `id, title, kind, agent, repo_path, command, shell, schedule, timezone,
  skip_permissions, session_mode, overlap_policy, catch_up, notify, enabled,
  created_at, updated_at, last_run_at, last_status, last_session_id, next_run_at, run_count`;

export function listCronJobs(): CronJobRow[] {
  return db()
    .prepare(`SELECT ${SELECT_COLS} FROM cron_jobs ORDER BY created_at DESC`)
    .all() as CronJobRow[];
}

/** enabled=1 인 작업만 — 부팅 시 스케줄러가 등록할 대상. */
export function listEnabledCronJobs(): CronJobRow[] {
  return db()
    .prepare(`SELECT ${SELECT_COLS} FROM cron_jobs WHERE enabled = 1 ORDER BY created_at DESC`)
    .all() as CronJobRow[];
}

export function getCronJob(id: string): CronJobRow | undefined {
  return db()
    .prepare(`SELECT ${SELECT_COLS} FROM cron_jobs WHERE id = ?`)
    .get(id) as CronJobRow | undefined;
}

export function insertCronJob(input: CronJobInput): CronJobRow {
  const id = randomUUID();
  const now = Date.now();
  db()
    .prepare(
      `INSERT INTO cron_jobs
        (id, title, kind, agent, repo_path, command, shell, schedule, timezone,
         skip_permissions, session_mode, overlap_policy, catch_up, notify, enabled,
         created_at, updated_at, run_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    )
    .run(
      id,
      input.title,
      input.kind,
      input.agent,
      input.repoPath,
      input.command,
      input.shell,
      input.schedule,
      input.timezone,
      input.skipPermissions ? 1 : 0,
      input.sessionMode,
      input.overlapPolicy,
      input.catchUp ? 1 : 0,
      input.notify ? 1 : 0,
      input.enabled ? 1 : 0,
      now,
      now,
    );
  return getCronJob(id)!;
}

/** key → (column, sqlValue) 매핑. 화이트리스트라 임의 컬럼 주입 불가. */
const PATCH_COLUMNS: Record<keyof CronJobInput, (v: unknown) => [string, unknown]> = {
  title: (v) => ["title", v ?? null],
  kind: (v) => ["kind", v],
  agent: (v) => ["agent", v],
  repoPath: (v) => ["repo_path", v],
  command: (v) => ["command", v],
  shell: (v) => ["shell", v ?? null],
  schedule: (v) => ["schedule", v],
  timezone: (v) => ["timezone", v ?? null],
  skipPermissions: (v) => ["skip_permissions", v ? 1 : 0],
  sessionMode: (v) => ["session_mode", v],
  overlapPolicy: (v) => ["overlap_policy", v],
  catchUp: (v) => ["catch_up", v ? 1 : 0],
  notify: (v) => ["notify", v ? 1 : 0],
  enabled: (v) => ["enabled", v ? 1 : 0],
};

export function updateCronJob(id: string, patch: CronJobPatch): CronJobRow | undefined {
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const key of Object.keys(patch) as (keyof CronJobInput)[]) {
    if (patch[key] === undefined) continue;
    const mapper = PATCH_COLUMNS[key];
    if (!mapper) continue;
    const [col, val] = mapper(patch[key]);
    sets.push(`${col} = ?`);
    vals.push(val);
  }
  // updated_at 은 항상 갱신.
  sets.push("updated_at = ?");
  vals.push(Date.now());
  vals.push(id);
  const info = db()
    .prepare(`UPDATE cron_jobs SET ${sets.join(", ")} WHERE id = ?`)
    .run(...(vals as never[]));
  if (info.changes === 0) return undefined;
  return getCronJob(id);
}

export function deleteCronJob(id: string): boolean {
  const info = db().prepare(`DELETE FROM cron_jobs WHERE id = ?`).run(id);
  return info.changes > 0;
}

/** 표시용 다음 실행 캐시. 스케줄 등록/변경 때마다 갱신. */
export function setNextRunAt(id: string, ts: number | null): void {
  db().prepare(`UPDATE cron_jobs SET next_run_at = ? WHERE id = ?`).run(ts, id);
}

// ── 실행 이력 (cron_runs) ────────────────────────────────────────────────────

export function recordRunStart(
  jobId: string,
  sessionId: string | null,
  trigger: "schedule" | "manual",
  startedAt: number,
): string {
  const id = randomUUID();
  db()
    .prepare(
      `INSERT INTO cron_runs (id, cron_job_id, session_id, trigger, started_at, status)
       VALUES (?, ?, ?, ?, ?, 'running')`,
    )
    .run(id, jobId, sessionId, trigger, startedAt);
  return id;
}

export function recordRunEnd(
  runId: string,
  status: CronRunRow["status"],
  endedAt: number,
  error?: string | null,
): void {
  db()
    .prepare(`UPDATE cron_runs SET status = ?, ended_at = ?, error = ? WHERE id = ?`)
    .run(status, endedAt, error ?? null, runId);
}

/** skipped 실행 — 시작과 동시에 종료된 한 줄 기록 (세션 생성 안 함). */
export function recordSkippedRun(
  jobId: string,
  trigger: "schedule" | "manual",
  at: number,
  reason: string,
): string {
  const id = randomUUID();
  db()
    .prepare(
      `INSERT INTO cron_runs (id, cron_job_id, session_id, trigger, started_at, ended_at, status, error)
       VALUES (?, ?, NULL, ?, ?, ?, 'skipped', ?)`,
    )
    .run(id, jobId, trigger, at, at, reason);
  return id;
}

/** 작업의 최신 실행 요약 캐시 갱신 (목록 화면에서 join 없이 보이게). */
export function updateJobRunSummary(
  jobId: string,
  fields: {
    lastRunAt: number;
    lastStatus: string;
    lastSessionId: string | null;
    incrementRunCount?: boolean;
  },
): void {
  if (fields.incrementRunCount) {
    db()
      .prepare(
        `UPDATE cron_jobs SET last_run_at = ?, last_status = ?, last_session_id = ?, run_count = run_count + 1 WHERE id = ?`,
      )
      .run(fields.lastRunAt, fields.lastStatus, fields.lastSessionId, jobId);
  } else {
    db()
      .prepare(
        `UPDATE cron_jobs SET last_run_at = ?, last_status = ?, last_session_id = ? WHERE id = ?`,
      )
      .run(fields.lastRunAt, fields.lastStatus, fields.lastSessionId, jobId);
  }
}

export function recentRuns(jobId: string, limit = 20): CronRunRow[] {
  return db()
    .prepare(
      `SELECT id, cron_job_id, session_id, trigger, started_at, ended_at, status, error
       FROM cron_runs WHERE cron_job_id = ? ORDER BY started_at DESC LIMIT ?`,
    )
    .all(jobId, Math.max(1, Math.min(100, limit))) as CronRunRow[];
}
