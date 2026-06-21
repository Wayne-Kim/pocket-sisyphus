/**
 * merge_requests 테이블 접근 계층 — 순수 DB 연산만. 검증은 라우트(routes/merge.ts)가, 직렬
 * 처리/머지 실행은 MergeQueue(merge/queue.ts)가 한다. better-sqlite3 prepared statement 패턴
 * (cron/store.ts 와 동일). better-sqlite3 는 동기라 claimNextQueued 의 트랜잭션이 «하나만»
 * processing 으로 넘어가게 원자적으로 보장한다 — 직렬성의 한 축.
 */
import { randomUUID } from "node:crypto";
import { db, type MergeRequestRow } from "../db/index.js";

/** 생성 시 받는 필드 — 검증/정규화는 라우트가 끝낸 뒤 넘긴다. */
export type MergeRequestInput = {
  repoPath: string;
  sourceBranch: string;
  targetBranch: string;
  sessionId: string | null;
  cleanup: boolean;
  noFF: boolean;
};

const SELECT_COLS = `id, repo_path, source_branch, target_branch, session_id, cleanup, no_ff,
  status, result, merge_commit, conflict_files, error, created_at, updated_at, started_at, ended_at`;

export function insertMergeRequest(input: MergeRequestInput): MergeRequestRow {
  const id = randomUUID();
  const now = Date.now();
  db()
    .prepare(
      `INSERT INTO merge_requests
        (id, repo_path, source_branch, target_branch, session_id, cleanup, no_ff,
         status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
    )
    .run(
      id,
      input.repoPath,
      input.sourceBranch,
      input.targetBranch,
      input.sessionId,
      input.cleanup ? 1 : 0,
      input.noFF ? 1 : 0,
      now,
      now,
    );
  return getMergeRequest(id)!;
}

export function getMergeRequest(id: string): MergeRequestRow | undefined {
  return db()
    .prepare(`SELECT ${SELECT_COLS} FROM merge_requests WHERE id = ?`)
    .get(id) as MergeRequestRow | undefined;
}

export type MergeListFilter = {
  repoPath?: string;
  sessionId?: string;
  status?: MergeRequestRow["status"];
};

export function listMergeRequests(filter: MergeListFilter = {}): MergeRequestRow[] {
  const where: string[] = [];
  const vals: unknown[] = [];
  if (filter.repoPath) { where.push("repo_path = ?"); vals.push(filter.repoPath); }
  if (filter.sessionId) { where.push("session_id = ?"); vals.push(filter.sessionId); }
  if (filter.status) { where.push("status = ?"); vals.push(filter.status); }
  const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  return db()
    .prepare(`SELECT ${SELECT_COLS} FROM merge_requests ${clause} ORDER BY created_at DESC, id DESC`)
    .all(...(vals as never[])) as MergeRequestRow[];
}

/**
 * 다음에 처리할 queued 항목을 «하나만» 골라 원자적으로 processing 으로 넘긴다. 동시에 여러
 * kick 이 들어와도 트랜잭션이 직렬화하므로 둘 이상이 같은 항목을(또는 두 항목을 동시에)
 * 처리하지 않는다. 큐가 비어 있으면 undefined.
 */
export function claimNextQueued(): MergeRequestRow | undefined {
  const now = Date.now();
  const tx = db().transaction((): MergeRequestRow | undefined => {
    const row = db()
      .prepare(
        `SELECT ${SELECT_COLS} FROM merge_requests
         WHERE status = 'queued' ORDER BY created_at ASC, id ASC LIMIT 1`,
      )
      .get() as MergeRequestRow | undefined;
    if (!row) return undefined;
    db()
      .prepare(`UPDATE merge_requests SET status = 'processing', started_at = ?, updated_at = ? WHERE id = ?`)
      .run(now, now, row.id);
    return { ...row, status: "processing", started_at: now, updated_at: now };
  });
  return tx();
}

export function markMerged(
  id: string,
  fields: { result: string; mergeCommit: string | null },
): void {
  const now = Date.now();
  db()
    .prepare(
      `UPDATE merge_requests SET status = 'merged', result = ?, merge_commit = ?,
        conflict_files = NULL, error = NULL, updated_at = ?, ended_at = ? WHERE id = ?`,
    )
    .run(fields.result, fields.mergeCommit, now, now, id);
}

export function markConflict(
  id: string,
  fields: { conflictFiles: string[]; error?: string | null },
): void {
  const now = Date.now();
  db()
    .prepare(
      `UPDATE merge_requests SET status = 'conflict', conflict_files = ?, error = ?,
        updated_at = ?, ended_at = ? WHERE id = ?`,
    )
    .run(JSON.stringify(fields.conflictFiles), fields.error ?? null, now, now, id);
}

export function markFailed(id: string, error: string): void {
  const now = Date.now();
  db()
    .prepare(
      `UPDATE merge_requests SET status = 'failed', error = ?, updated_at = ?, ended_at = ? WHERE id = ?`,
    )
    .run(error, now, now, id);
}

/** 처리 «전»(queued)인 항목만 취소. 이미 처리 중/종결된 건 건드리지 않는다. */
export function cancelQueued(id: string): boolean {
  const now = Date.now();
  const info = db()
    .prepare(
      `UPDATE merge_requests SET status = 'cancelled', updated_at = ?, ended_at = ? WHERE id = ? AND status = 'queued'`,
    )
    .run(now, now, id);
  return info.changes > 0;
}

/** conflict/failed/cancelled 종결 항목을 다시 큐에 넣는다(재시도). queued/processing 은 no-op. */
export function reEnqueue(id: string): MergeRequestRow | undefined {
  const now = Date.now();
  const info = db()
    .prepare(
      `UPDATE merge_requests SET status = 'queued', result = NULL, merge_commit = NULL,
        conflict_files = NULL, error = NULL, started_at = NULL, ended_at = NULL, updated_at = ?
       WHERE id = ? AND status IN ('conflict','failed','cancelled')`,
    )
    .run(now, id);
  if (info.changes === 0) return undefined;
  return getMergeRequest(id);
}

export function deleteMergeRequest(id: string): boolean {
  return db().prepare(`DELETE FROM merge_requests WHERE id = ?`).run(id).changes > 0;
}

export type QueueCounts = {
  queued: number;
  processing: number;
  conflict: number;
  failed: number;
  merged: number;
  cancelled: number;
  total: number;
};

/** 큐 상태 요약 (대기 N건/처리 중/충돌 …). repoPath 주면 그 레포만 집계. */
export function queueCounts(repoPath?: string): QueueCounts {
  const clause = repoPath ? "WHERE repo_path = ?" : "";
  const rows = db()
    .prepare(`SELECT status, COUNT(*) AS n FROM merge_requests ${clause} GROUP BY status`)
    .all(...((repoPath ? [repoPath] : []) as never[])) as Array<{ status: string; n: number }>;
  const out: QueueCounts = { queued: 0, processing: 0, conflict: 0, failed: 0, merged: 0, cancelled: 0, total: 0 };
  for (const r of rows) {
    if (r.status in out) (out as Record<string, number>)[r.status] = r.n;
    out.total += r.n;
  }
  return out;
}

/**
 * 부팅 시 정리 — 이전 daemon 프로세스가 처리 중 죽어 'processing' 으로 남은 항목을 다시
 * 'queued' 로 되돌린다 (reconcileStaleRuns 와 같은 성격). 머지는 멱등에 가깝다(이미 합쳐졌으면
 * up_to_date 로 무해 종료) — 그래서 failed 가 아니라 재시도 가능한 queued 로 되돌린다.
 * 반환: 되돌린 항목 수.
 */
export function reconcileStaleProcessing(): number {
  const now = Date.now();
  return db()
    .prepare(`UPDATE merge_requests SET status = 'queued', started_at = NULL, updated_at = ? WHERE status = 'processing'`)
    .run(now).changes;
}
