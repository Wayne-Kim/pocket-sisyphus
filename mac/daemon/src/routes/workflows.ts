/**
 * `/api/workflows` — 멀티 에이전트 워크플로우 CRUD + 실행 + 실행 상태.
 *
 *   GET    /api/workflows              → 워크플로우 목록 (정의)
 *   POST   /api/workflows              → 생성 (그래프 검증 후 저장)
 *   GET    /api/workflows/:id          → 정의 + 최근 실행 목록
 *   PUT    /api/workflows/:id          → 수정 (그래프 재검증)
 *   DELETE /api/workflows/:id          → 삭제 (run/node_run cascade)
 *   POST   /api/workflows/:id/run      → 실행 시작 (manual) → { runId }
 *   GET    /api/workflows/runs/:id     → run 상태 (def 노드/간선 + node_runs + 좌표)
 *   POST   /api/workflows/runs/:id/cancel → 진행 중 run 취소
 *
 * 모든 라우트 bearerAuth. iOS 가 관리 UI 의 단일 소비자 (Mac 은 실행만 — cron 과 같은 정책).
 * docs/ARCHITECTURE.md §12.2 (라우트) 참고.
 */
import { Hono } from "hono";
import { bearerAuth } from "../auth.js";
import { resolveAndEnsureRepoDir } from "./sessions.js";
import { validateDef, parseDef, parseSnapshot } from "../workflow/types.js";
import {
  listWorkflows,
  getWorkflow,
  insertWorkflow,
  updateWorkflow,
  deleteWorkflow,
  listRunsForWorkflow,
  getRun,
  listNodeRuns,
  listUnackedAttentionRuns,
  ackRunAttention,
  type WorkflowInput,
} from "../workflow/store.js";
import { startWorkflowRun, cancelWorkflowRun, resolveWorkflowDecision, WORKFLOW_MAX_ITERATIONS } from "../workflow/engine.js";
import { startWorkflowDesign, getWorkflowDesign } from "../workflow/design.js";
import { listWorkflowTemplates } from "../persona/templates.js";
import { normalizePoLocale } from "../persona/prompt.js";
import { getWorkflowTriggerScheduler } from "../workflow/triggers.js";
import { db, type WorkflowRow } from "../db/index.js";

export const workflows = new Hono();
workflows.use("*", bearerAuth);

function nonEmptyString(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

/** DB row → iOS 응답 형태. nodes/edges 를 파싱된 배열로 펴서 보낸다 (문자열 이중 파싱 회피). */
function workflowResponse(row: WorkflowRow) {
  const def = parseDef(row.nodes, row.edges);
  return {
    id: row.id,
    title: row.title,
    repo_path: row.repo_path,
    nodes: def.nodes,
    edges: def.edges,
    enabled: row.enabled === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function tryParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return [];
  }
}

workflows.get("/", (c) => {
  return c.json({ workflows: listWorkflows().map(workflowResponse) });
});

workflows.post("/", async (c) => {
  const body = await c.req.json().catch(() => ({}));

  const valid = validateDef(body.nodes, body.edges);
  if (!valid.ok) return c.json({ error: "invalid_graph", message: valid.error }, 400);

  // 워크플로우 단위 repo 는 필수 — 노드가 개별 repo_path 로 override 하지 않는 한 기본 cwd.
  const repoInput = nonEmptyString(body.repoPath);
  if (!repoInput) return c.json({ error: "repoPath required" }, 400);
  const dir = resolveAndEnsureRepoDir(repoInput);
  if ("error" in dir) return c.json({ error: "repo_dir_failed", message: dir.error }, 400);

  const input: WorkflowInput = {
    title: nonEmptyString(body.title),
    repoPath: dir.path,
    nodes: JSON.stringify(valid.def.nodes),
    edges: JSON.stringify(valid.def.edges),
    enabled: body.enabled !== false,
  };
  const row = insertWorkflow(input);
  // 시작 노드 트리거(크론/GitHub)를 정의에서 등록.
  getWorkflowTriggerScheduler().reconcile(row.id);
  return c.json({ workflow: workflowResponse(row) }, 201);
});

// 「AI 초안」 — «한 문장으로 설명» 을 받아 설계 에이전트가 start/task/end + fail 간선 DAG
// «초안» 을 만든다 (workflow_design_v1). 곧장 저장·실행하지 않는다: settle 후 sanitize +
// validateDef 까지만 하고 노드/간선을 돌려준다. iOS 가 그걸 캔버스에 초안으로 띄우고, 사용자가
// 검토·수정한 뒤 «일반 생성(POST /)» 으로 저장한 다음에야 실행한다 (Zapier «draft not live»).
//   POST /api/workflows/design            → { designId, sessionId } (즉시 반환, 설계는 백그라운드)
//   GET  /api/workflows/design/:id        → { status, nodes?, edges?, error?, sessionId }
// 설계 세션은 일반 세션처럼 만들어져 사용자가 진행을 관전할 수 있다 (sessionId).
workflows.post("/design", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const description = nonEmptyString(body.description);
  if (!description) return c.json({ error: "description required" }, 400);
  const repoInput = nonEmptyString(body.repoPath);
  if (!repoInput) return c.json({ error: "repoPath required" }, 400);
  const agentId = nonEmptyString(body.agent) ?? undefined;
  const locale = normalizePoLocale(body.locale);

  const res = startWorkflowDesign({ description, repoPath: repoInput, agentId, locale });
  if ("error" in res) return c.json({ error: "design_failed", message: res.error }, 400);
  return c.json(res, 201);
});

workflows.get("/design/:id", (c) => {
  const job = getWorkflowDesign(c.req.param("id"));
  if (!job) return c.json({ error: "not_found" }, 404);
  return c.json({
    status: job.status,
    nodes: job.nodes ?? null,
    edges: job.edges ?? null,
    error: job.error ?? null,
    sessionId: job.sessionId,
  });
});

// 「출발 템플릿」 — 빈 캔버스 대신 손으로 잇는 마찰을 없애는 «프리셋» 목록(workflow_templates_v1).
// 업계 표준 오케스트레이터-워커 파이프라인(기획→디자인→개발→QA(승인 게이트)→운영)을 노드/간선
// 프리셋으로 내려보낸다. AI 초안(design)과 달리 «즉시·결정적» 이라 에이전트 spawn 없이 바로
// 캔버스에 시드된다. 노드 «종류» 는 start/task/end 뿐이라 캔버스 종류색은 그대로 유지된다.
// 노드 «제목»·템플릿 «이름/설명» 같은 화면 노출 문자열은 클라이언트가 카탈로그로 지역화한다.
workflows.get("/templates", (c) => {
  // 산출 언어 (po_locale_v1) — 프리셋 노드 prompt 를 앱 언어로. GET 이라 쿼리 ?locale= 로 받는다.
  const locale = normalizePoLocale(c.req.query("locale"));
  return c.json({ templates: listWorkflowTemplates(locale) });
});

// 모든 워크플로우에 걸친 «미해결 무인 실행» 집계 (workflow_attention_v1). attention_kind 가 있고
// 아직 확인 안 됐으며(ack=0) 무인 트리거(cron/github)인 run 들 — 최근 N건 페이징 너머의 실패도
// 여기엔 집계되므로 사용자가 «미해결이 있다» 를 놓치지 않는다(AC5). 워크플로우 탭이 이걸 폴링해
// 상단 배너로 표면화한다. `/:id` 보다 «먼저» 등록해야 id="attention" 으로 안 먹힌다.
workflows.get("/attention", (c) => {
  const items = listUnackedAttentionRuns().map((r) => ({
    run_id: r.id,
    workflow_id: r.workflow_id,
    workflow_title: r.workflow_title,
    attention_kind: r.attention_kind,
    trigger_kind: r.trigger_kind,
    started_at: r.started_at,
    ended_at: r.ended_at,
  }));
  // 워크플로우별 미해결 수 — 탭 행 배지에 쓸 수 있게 함께 내려준다.
  const byWorkflow: Record<string, number> = {};
  for (const it of items) byWorkflow[it.workflow_id] = (byWorkflow[it.workflow_id] ?? 0) + 1;
  return c.json({ total: items.length, items, byWorkflow });
});

workflows.get("/:id", (c) => {
  const id = c.req.param("id");
  const row = getWorkflow(id);
  if (!row) return c.json({ error: "not_found" }, 404);
  return c.json({
    workflow: workflowResponse(row),    runs: listRunsForWorkflow(id, 20).map((r) => ({
      id: r.id,
      status: r.status,
      trigger_kind: r.trigger_kind,
      started_at: r.started_at,
      ended_at: r.ended_at,
      // «미해결» 신호 (workflow_attention_v1) — 정상 결과와 시각 구분(합성본/빈 결과/실패)할 원천.
      attention_kind: r.attention_kind,
      attention_ack: r.attention_ack,
    })),
  });
});

// 이 워크플로우가 (어떤 run 에서든) 만든 세션 목록 — 워크플로우 탭에서 보기/삭제용.
// node_title/node_status 로 «어느 노드의 세션인지/상태» 를 함께 내려보낸다.
workflows.get("/:id/sessions", (c) => {
  const id = c.req.param("id");
  if (!getWorkflow(id)) return c.json({ error: "not_found" }, 404);
  const rows = db()
    .prepare(
      `SELECT s.id, s.title, s.repo_path, s.created_at, s.ended_at, s.status, s.agent,
              wnr.run_id AS run_id, wnr.title AS node_title, wnr.status AS node_status
       FROM workflow_runs wr
       JOIN workflow_node_runs wnr ON wnr.run_id = wr.id
       JOIN sessions s ON s.id = wnr.session_id
       WHERE wr.workflow_id = ?
       ORDER BY s.created_at DESC`,
    )
    .all(id);
  return c.json({ sessions: rows });
});

workflows.put("/:id", async (c) => {
  const id = c.req.param("id");
  const existing = getWorkflow(id);
  if (!existing) return c.json({ error: "not_found" }, 404);
  const body = await c.req.json().catch(() => ({}));

  const patch: Partial<WorkflowInput> = {};
  if ("title" in body) patch.title = nonEmptyString(body.title);
  if ("enabled" in body) patch.enabled = body.enabled !== false;
  if ("repoPath" in body) {
    const repoInput = nonEmptyString(body.repoPath);
    if (!repoInput) return c.json({ error: "repoPath required" }, 400);
    const dir = resolveAndEnsureRepoDir(repoInput);
    if ("error" in dir) return c.json({ error: "repo_dir_failed", message: dir.error }, 400);
    patch.repoPath = dir.path;
  }
  // nodes/edges 는 한 쌍으로 같이 검증 (한쪽만 바뀌어도 그래프 전체 정합성).
  if ("nodes" in body || "edges" in body) {
    const nodes = "nodes" in body ? body.nodes : tryParse(existing.nodes);
    const edges = "edges" in body ? body.edges : tryParse(existing.edges);
    const valid = validateDef(nodes, edges);
    if (!valid.ok) return c.json({ error: "invalid_graph", message: valid.error }, 400);
    patch.nodes = JSON.stringify(valid.def.nodes);
    patch.edges = JSON.stringify(valid.def.edges);
  }

  const row = updateWorkflow(id, patch);
  if (!row) return c.json({ error: "not_found" }, 404);
  // 트리거 정의가 바뀌었을 수 있으니 재등록 (nodes 변경 시 reconcile 이 행을 다시 만든다).
  getWorkflowTriggerScheduler().reconcile(id);
  return c.json({ workflow: workflowResponse(row) });
});

workflows.delete("/:id", (c) => {
  const id = c.req.param("id");
  // croner 등록 해제 먼저 (행은 ON DELETE CASCADE 로 사라진다).
  getWorkflowTriggerScheduler().removeWorkflow(id);
  if (!deleteWorkflow(id)) return c.json({ error: "not_found" }, 404);
  return c.json({ ok: true });
});

// 실행 시작 — disabled 여부와 무관하게 사용자가 명시적으로 누른 거라 실행한다. runId 즉시 반환.
workflows.post("/:id/run", (c) => {
  const id = c.req.param("id");
  const row = getWorkflow(id);
  if (!row) return c.json({ error: "not_found" }, 404);
  const result = startWorkflowRun(row, "manual");
  if ("error" in result) return c.json({ error: "run_failed", message: result.error }, 400);
  return c.json(result, 201);
});

// run 상태 — iOS 캔버스가 폴링. def 노드/간선(레이아웃 + 화살표) + node_runs(라이브 상태).
workflows.get("/runs/:id", (c) => {
  const id = c.req.param("id");
  const run = getRun(id);
  if (!run) return c.json({ error: "not_found" }, 404);
  const def = parseSnapshot(run.def_snapshot);
  return c.json({
    run: {
      id: run.id,
      workflow_id: run.workflow_id,
      status: run.status,
      trigger_kind: run.trigger_kind,
      // per-run 격리 worktree (po_run_worktree_v1) — 없으면 null(공유 repo). 추적·정리(reaper)용.
      worktree_path: run.worktree_path,
      worktree_branch: run.worktree_branch,
      started_at: run.started_at,
      ended_at: run.ended_at,
      // fail 루프 재시도 상한 — 캔버스가 «재시도 N/한도» 를 그린다 (per-node iteration 과 짝).
      max_iterations: WORKFLOW_MAX_ITERATIONS,
    },
    nodes: def.nodes,
    edges: def.edges,
    nodeRuns: listNodeRuns(id),
  });
});

workflows.post("/runs/:id/cancel", (c) => {
  const id = c.req.param("id");
  const run = getRun(id);
  if (!run) return c.json({ error: "not_found" }, 404);
  const ok = cancelWorkflowRun(id);
  return c.json({ ok });
});

// 미해결 신호 «확인» (workflow_attention_v1) — 사용자가 배너에서 확인/처리하면 attention_ack=1 로
// 박아 배너에서 사라지게 한다. 멱등 — 이미 확인됐거나 attention 없는 run 도 ok:true (no-op).
workflows.post("/runs/:id/ack-attention", (c) => {
  const id = c.req.param("id");
  if (!getRun(id)) return c.json({ error: "not_found" }, 404);
  ackRunAttention(id);
  return c.json({ ok: true });
});

// 사용자 결정 — 승인 게이트(approve/reject) + 수동 개입(complete/retry). nid = node_run id.
// 진행 중 run 의 in-memory 대기 노드에만 적용 (대기 중 아니면 ok:false).
const DECISIONS = new Set(["approve", "reject", "complete", "retry"]);
workflows.post("/runs/:id/nodes/:nid/:action", (c) => {
  const id = c.req.param("id");
  const nid = c.req.param("nid");
  const action = c.req.param("action");
  if (!DECISIONS.has(action)) return c.json({ error: "invalid_action" }, 400);
  const ok = resolveWorkflowDecision(id, nid, action);
  return c.json({ ok });
});
