// ─────────────────────────────────────────────────────────────────────────────
// `/api/merge-queue` — 머지 큐 (merge_queue_v1).
//
//   POST   /api/merge-queue           → 머지 요청 enqueue ({ repoPath|sessionId, sourceBranch,
//                                        targetBranch, cleanup?, noFF? }) → { request }
//   GET    /api/merge-queue           → 목록(?repoPath=&sessionId=&status=) + 상태 요약(counts)
//   GET    /api/merge-queue/:id        → 단건
//   DELETE /api/merge-queue/:id        → queued 면 취소(cancelled), 종결 항목이면 행 삭제
//   POST   /api/merge-queue/:id/retry  → conflict/failed/cancelled 를 다시 큐에 (queued)
//   POST   /api/merge-queue/preview    → 읽기 전용 사전 충돌 탐지 (repo 무변경) → { relation, conflict, files }
//
// 세션/에이전트는 머지를 «직접» 시도하지 않고 여기에 enqueue 한다. daemon 의 MergeQueue 가
// 한 번에 하나씩 직렬로 처리해 동시에 둘 이상이 target 에 쓰지 않게 보장한다 (재결합 단계의
// 충돌로 에이전트가 멈추는 구조적 실패 지점 제거).
//
// 안전: 브랜치명은 isValidRef 가 거른다 (worktree 라우트와 동일 수준의 argument-injection
// 방어). repoPath 는 클라이언트 절대경로지만 모든 git 동작은 `-C` 안에서만 돌고, 비-repo 면
// gitRepoInfo 가 거른다. 사전 탐지는 읽기 전용이라 잘못된 입력이 repo 를 변경할 수 없다.
// ─────────────────────────────────────────────────────────────────────────────

import { Hono } from "hono";
import { bearerAuth } from "../auth.js";
import { db, type MergeRequestRow } from "../db/index.js";
import { isValidRef, gitRepoInfo } from "../git/worktree.js";
import { previewMerge } from "../git/merge.js";
import {
  insertMergeRequest,
  getMergeRequest,
  listMergeRequests,
  cancelQueued,
  reEnqueue,
  deleteMergeRequest,
  queueCounts,
  type MergeListFilter,
} from "../merge/store.js";
import { getMergeQueue } from "../merge/queue.js";

export const merge = new Hono();
merge.use("*", bearerAuth);

const STATUSES = new Set(["queued", "processing", "merged", "conflict", "failed", "cancelled"]);

/** conflict_files JSON 을 배열로 펴서 응답한다 (DB 는 문자열로 보관). */
function toApi(row: MergeRequestRow): Record<string, unknown> {
  let conflictFiles: string[] = [];
  if (row.conflict_files) {
    try {
      const p = JSON.parse(row.conflict_files);
      if (Array.isArray(p)) conflictFiles = p.filter((x) => typeof x === "string");
    } catch {
      /* 손상된 JSON — 빈 배열로 */
    }
  }
  return {
    id: row.id,
    repoPath: row.repo_path,
    sourceBranch: row.source_branch,
    targetBranch: row.target_branch,
    sessionId: row.session_id,
    cleanup: row.cleanup === 1,
    noFF: row.no_ff === 1,
    status: row.status,
    result: row.result,
    mergeCommit: row.merge_commit,
    conflictFiles,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}

/** body/세션에서 repoPath 를 확정한다 — repoPath 직접 또는 sessionId → repo_path 조회. */
function resolveRepoPath(body: {
  repoPath?: unknown;
  sessionId?: unknown;
}): { repoPath: string; sessionId: string | null } | { error: string } {
  const sessionId =
    typeof body.sessionId === "string" && body.sessionId.length > 0 ? body.sessionId : null;
  let repoPath =
    typeof body.repoPath === "string" && body.repoPath.trim().length > 0
      ? body.repoPath.trim()
      : null;
  if (!repoPath && sessionId) {
    const row = db()
      .prepare("SELECT repo_path FROM sessions WHERE id = ?")
      .get(sessionId) as { repo_path: string } | undefined;
    if (!row) return { error: "session_not_found" };
    repoPath = row.repo_path;
  }
  if (!repoPath) return { error: "repo_path_required" };
  return { repoPath, sessionId };
}

merge.post("/", async (c) => {
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);

  const resolved = resolveRepoPath(body);
  if ("error" in resolved) return c.json({ error: resolved.error }, 400);
  const { repoPath, sessionId } = resolved;

  const sourceBranch = (body as { sourceBranch?: unknown }).sourceBranch;
  const targetBranch = (body as { targetBranch?: unknown }).targetBranch;
  if (!isValidRef(sourceBranch)) return c.json({ error: "invalid_source_branch" }, 400);
  if (!isValidRef(targetBranch)) return c.json({ error: "invalid_target_branch" }, 400);
  if (sourceBranch === targetBranch) return c.json({ error: "source_equals_target" }, 400);

  // repo 가 진짜 git 작업트리인지 — 비-repo 면 큐에 무의미한 항목이 쌓이지 않게 미리 거른다.
  const info = await gitRepoInfo(repoPath);
  if (!info.isRepo) return c.json({ error: "not_a_repo" }, 400);

  const cleanup = (body as { cleanup?: unknown }).cleanup === true;
  const noFF = (body as { noFF?: unknown }).noFF === true;

  const row = insertMergeRequest({
    repoPath,
    sourceBranch,
    targetBranch,
    sessionId,
    cleanup,
    noFF,
  });
  // 직렬 처리 루프를 깨운다 — 이미 돌고 있으면 이 항목을 마저 집는다.
  getMergeQueue().kick();
  return c.json({ request: toApi(row) }, 201);
});

merge.get("/", (c) => {
  const filter: MergeListFilter = {};
  const repoPath = c.req.query("repoPath");
  const sessionId = c.req.query("sessionId");
  const status = c.req.query("status");
  if (repoPath) filter.repoPath = repoPath;
  if (sessionId) filter.sessionId = sessionId;
  if (status && STATUSES.has(status)) filter.status = status as MergeRequestRow["status"];

  const requests = listMergeRequests(filter).map(toApi);
  // counts 는 «레포 스코프» 가 있으면 그 레포만 — 세션 필터는 counts 에 안 반영(전역 큐 상태).
  const counts = queueCounts(filter.repoPath);
  return c.json({ requests, counts });
});

merge.get("/:id", (c) => {
  const row = getMergeRequest(c.req.param("id"));
  if (!row) return c.json({ error: "not_found" }, 404);
  return c.json({ request: toApi(row) });
});

merge.delete("/:id", (c) => {
  const id = c.req.param("id");
  const row = getMergeRequest(id);
  if (!row) return c.json({ error: "not_found" }, 404);
  if (row.status === "processing") {
    // 처리 중인 머지는 끊지 않는다 — 직렬 보장이 흔들리지 않게.
    return c.json({ error: "processing", message: "cannot cancel a merge in progress" }, 409);
  }
  if (row.status === "queued") {
    cancelQueued(id);
    return c.json({ request: toApi(getMergeRequest(id)!) });
  }
  // 종결(merged/conflict/failed/cancelled) — 이력에서 제거.
  deleteMergeRequest(id);
  return c.json({ ok: true, deleted: true });
});

merge.post("/:id/retry", (c) => {
  const id = c.req.param("id");
  const row = getMergeRequest(id);
  if (!row) return c.json({ error: "not_found" }, 404);
  const re = reEnqueue(id);
  if (!re) {
    return c.json(
      { error: "not_retryable", message: `status=${row.status} (conflict/failed/cancelled 만 재시도)` },
      409,
    );
  }
  getMergeQueue().kick();
  return c.json({ request: toApi(re) });
});

// 읽기 전용 사전 충돌 탐지 — repo 를 변경하지 않는다. enqueue 전에 충돌 여부를 미리 볼 때.
merge.post("/preview", async (c) => {
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const resolved = resolveRepoPath(body);
  if ("error" in resolved) return c.json({ error: resolved.error }, 400);
  const { repoPath } = resolved;
  const sourceBranch = (body as { sourceBranch?: unknown }).sourceBranch;
  const targetBranch = (body as { targetBranch?: unknown }).targetBranch;
  if (!isValidRef(sourceBranch)) return c.json({ error: "invalid_source_branch" }, 400);
  if (!isValidRef(targetBranch)) return c.json({ error: "invalid_target_branch" }, 400);

  const preview = await previewMerge(repoPath, sourceBranch, targetBranch);
  if (!preview.ok) return c.json({ error: preview.error, message: preview.message }, 400);
  return c.json({
    relation: preview.relation,
    conflict: preview.conflict,
    conflictFiles: preview.conflictFiles,
    sourceSha: preview.sourceSha,
    targetSha: preview.targetSha,
  });
});
