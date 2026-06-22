/**
 * `/api/repeat` — 「반복 실행」(repeat_run_v1). 워크플로우 캔버스 없이 (repo·에이전트·목표 스펙·
 * 완료 검사·최대 횟수)만 받아 자기교정 루프를 즉석 합성해 엔진으로 돌린다(workflow/repeat.ts).
 *
 *   POST /api/repeat                 → 시작 → { runId, workflowId }
 *   GET  /api/repeat/runs            → 「반복 실행」 run 목록(진행/완료/실패) — 최신순
 *   GET  /api/repeat/runs/:id        → 한 run 의 상태(반복 회차/상한/판정)
 *   POST /api/repeat/runs/:id/cancel → 진행 중 run 중지(엔진 cancelWorkflowRun 재사용)
 *
 * 모든 라우트 bearerAuth. 진행/완료/실패 등 run 상태는 워크플로우 run 과 같은 엔진 상태를 파생한다.
 */
import { Hono } from "hono";
import { bearerAuth } from "../auth.js";
import { getRun, listNodeRuns, listRepeatRuns, getWorkflow } from "../workflow/store.js";
import { cancelWorkflowRun } from "../workflow/engine.js";
import {
  startRepeatRun,
  summarizeRepeatRun,
  repoPathForRun,
  type RepeatRunInput,
} from "../workflow/repeat.js";

export const repeat = new Hono();
repeat.use("*", bearerAuth);

function nonEmptyString(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

/** 이 run 이 정말 「반복 실행」(ephemeral 워크플로우)의 run 인지 — 일반 캔버스 run 을 repeat 경로로 노출 금지. */
function isRepeatRun(workflowId: string): boolean {
  return getWorkflow(workflowId)?.ephemeral === 1;
}

// 시작 — 5필드 + 격리/승인 옵션. worktree 생성(격리)을 동기로 await 하므로 async.
repeat.post("/", async (c) => {
  const body = await c.req.json().catch(() => ({}));

  const repoPath = nonEmptyString(body.repoPath);
  if (!repoPath) return c.json({ error: "repoPath required" }, 400);
  const goal = nonEmptyString(body.goal);
  if (!goal) return c.json({ error: "goal required" }, 400);
  const check = nonEmptyString(body.check);
  if (!check) return c.json({ error: "check required" }, 400);

  const maxIterations = Number(body.maxIterations);
  if (!Number.isFinite(maxIterations) || maxIterations < 1) {
    return c.json({ error: "maxIterations must be >= 1" }, 400);
  }

  const input: RepeatRunInput = {
    repoPath,
    agent: nonEmptyString(body.agent) ?? undefined,
    goal,
    check,
    maxIterations,
    // 기본 격리 + 무인 승인 — 무인 경로. 명시적으로 false 면 끈다(per-실행 옵션).
    isolated: body.isolated !== false,
    skipPermissions: body.skipPermissions !== false,
  };

  const res = await startRepeatRun(input);
  if ("error" in res) return c.json({ error: res.error }, res.status as 400);
  return c.json(res, 201);
});

// 「반복 실행」 run 목록 — 진행/완료/실패 카드의 원천. ephemeral 워크플로우 run 만(일반 캔버스 제외).
repeat.get("/runs", (c) => {
  const runs = listRepeatRuns().map((r) => summarizeRepeatRun(r, listNodeRuns(r.id)));
  return c.json({ runs });
});

repeat.get("/runs/:id", (c) => {
  const id = c.req.param("id");
  const run = getRun(id);
  if (!run || !isRepeatRun(run.workflow_id)) return c.json({ error: "not_found" }, 404);
  const summary = summarizeRepeatRun({ ...run, repo_path: repoPathForRun(run) }, listNodeRuns(id));
  return c.json({ run: summary });
});

repeat.post("/runs/:id/cancel", (c) => {
  const id = c.req.param("id");
  const run = getRun(id);
  if (!run || !isRepeatRun(run.workflow_id)) return c.json({ error: "not_found" }, 404);
  const ok = cancelWorkflowRun(id);
  return c.json({ ok });
});
