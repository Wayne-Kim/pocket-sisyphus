/**
 * workflows / workflow_runs / workflow_node_runs 테이블 접근 계층 — 순수 DB 연산만.
 * 검증/실행은 라우트와 engine 이 한다. cron/store.ts 와 같은 better-sqlite3 패턴.
 */
import { randomUUID } from "node:crypto";
import {
  db,
  type WorkflowRow,
  type WorkflowRunRow,
  type WorkflowNodeRunRow,
  type WorkflowTriggerRow,
} from "../db/index.js";

// ── 정의 (workflows) ─────────────────────────────────────────────────────────

export type WorkflowInput = {
  title: string | null;
  repoPath: string | null;
  /** JSON 문자열 (NodeDef[]). */
  nodes: string;
  /** JSON 문자열 (EdgeDef[]). */
  edges: string;
  enabled: boolean;
  /** «반복 실행»(repeat_run_v1)이 합성한 일회용 워크플로우면 true — 캔버스 목록에서 숨긴다. */
  ephemeral?: boolean;
};

const WF_COLS = `id, title, repo_path, nodes, edges, enabled, ephemeral, created_at, updated_at`;

/** 사용자가 만든 워크플로우만 (ephemeral=0). «반복 실행» 합성본은 repeat 라우트가 따로 다룬다. */
export function listWorkflows(): WorkflowRow[] {
  return db()
    .prepare(`SELECT ${WF_COLS} FROM workflows WHERE ephemeral = 0 ORDER BY created_at DESC`)
    .all() as WorkflowRow[];
}

export function getWorkflow(id: string): WorkflowRow | undefined {
  return db()
    .prepare(`SELECT ${WF_COLS} FROM workflows WHERE id = ?`)
    .get(id) as WorkflowRow | undefined;
}

export function insertWorkflow(input: WorkflowInput): WorkflowRow {
  const id = randomUUID();
  const now = Date.now();
  db()
    .prepare(
      `INSERT INTO workflows (id, title, repo_path, nodes, edges, enabled, ephemeral, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.title,
      input.repoPath,
      input.nodes,
      input.edges,
      input.enabled ? 1 : 0,
      input.ephemeral ? 1 : 0,
      now,
      now,
    );
  return getWorkflow(id)!;
}

export function updateWorkflow(
  id: string,
  patch: Partial<WorkflowInput>,
): WorkflowRow | undefined {
  const sets: string[] = [];
  const vals: unknown[] = [];
  const push = (col: string, v: unknown) => {
    sets.push(`${col} = ?`);
    vals.push(v);
  };
  if (patch.title !== undefined) push("title", patch.title);
  if (patch.repoPath !== undefined) push("repo_path", patch.repoPath);
  if (patch.nodes !== undefined) push("nodes", patch.nodes);
  if (patch.edges !== undefined) push("edges", patch.edges);
  if (patch.enabled !== undefined) push("enabled", patch.enabled ? 1 : 0);
  sets.push("updated_at = ?");
  vals.push(Date.now());
  vals.push(id);
  const info = db()
    .prepare(`UPDATE workflows SET ${sets.join(", ")} WHERE id = ?`)
    .run(...(vals as never[]));
  if (info.changes === 0) return undefined;
  return getWorkflow(id);
}

export function deleteWorkflow(id: string): boolean {
  // workflow_runs / workflow_node_runs / workflow_triggers 는 ON DELETE CASCADE.
  return db().prepare(`DELETE FROM workflows WHERE id = ?`).run(id).changes > 0;
}

// ── 실행 (workflow_runs) ──────────────────────────────────────────────────────

const RUN_COLS = `id, workflow_id, def_snapshot, status, trigger_kind, worktree_path, worktree_branch, max_iterations, attention_kind, attention_ack, started_at, ended_at`;

export function insertRun(
  workflowId: string,
  defSnapshot: string,
  triggerKind: "manual" | "cron" | "github",
  /** PO «워크플로우로 실행» run 의 per-run 격리 worktree (po_run_worktree_v1). 일반 run 은 생략 → NULL. */
  worktree?: { path: string; branch: string },
  /** «반복 실행»(repeat_run_v1)의 fail-루프 반복 상한. 일반 run 은 생략 → NULL(엔진 기본 상한). */
  maxIterations?: number,
): WorkflowRunRow {
  const id = randomUUID();
  db()
    .prepare(
      `INSERT INTO workflow_runs (id, workflow_id, def_snapshot, status, trigger_kind, worktree_path, worktree_branch, max_iterations, started_at)
       VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      workflowId,
      defSnapshot,
      triggerKind,
      worktree?.path ?? null,
      worktree?.branch ?? null,
      maxIterations ?? null,
      Date.now(),
    );
  return getRun(id)!;
}

/**
 * 지금 running 이면서 per-run worktree 를 가진 run 수 (po_run_worktree_v1). 동시 run-worktree
 * 상한(MAX_CONCURRENT_RUN_WORKTREES) 판정의 원천 — worktree 는 작업트리 파일을 복제하므로
 * 무한히 쌓이면 디스크를 잡아먹는다. 실패한 run 의 worktree 정리(GC)는 별 brief(reaper)가
 * 닫는다 — 그때까지 이 상한이 폭주를 막는다.
 */
export function countActiveWorktreeRuns(): number {
  const r = db()
    .prepare(
      `SELECT COUNT(*) AS n FROM workflow_runs WHERE status = 'running' AND worktree_path IS NOT NULL`,
    )
    .get() as { n: number };
  return r.n;
}

export function getRun(id: string): WorkflowRunRow | undefined {
  return db()
    .prepare(`SELECT ${RUN_COLS} FROM workflow_runs WHERE id = ?`)
    .get(id) as WorkflowRunRow | undefined;
}

export function listRunsForWorkflow(workflowId: string, limit = 20): WorkflowRunRow[] {
  return db()
    .prepare(
      `SELECT ${RUN_COLS} FROM workflow_runs WHERE workflow_id = ? ORDER BY started_at DESC LIMIT ?`,
    )
    .all(workflowId, Math.max(1, Math.min(100, limit))) as WorkflowRunRow[];
}

/** workflow_id 에 상관없이 지금 running 인 run 들 (부팅 시 stale 정리용). */
export function listRunningRuns(): WorkflowRunRow[] {
  return db()
    .prepare(`SELECT ${RUN_COLS} FROM workflow_runs WHERE status = 'running'`)
    .all() as WorkflowRunRow[];
}

/**
 * «반복 실행»(repeat_run_v1) run 목록 — ephemeral 워크플로우(시트가 합성한 자기교정 루프)의 run 들.
 * workflow.repo_path 를 함께 실어(repo 라벨) iOS 가 JOIN 없이 카드를 그린다. 최신순, 표시할 만큼만(50).
 */
export function listRepeatRuns(
  limit = 50,
): Array<WorkflowRunRow & { repo_path: string | null; workflow_title: string | null }> {
  return db()
    .prepare(
      `SELECT wr.id, wr.workflow_id, wr.def_snapshot, wr.status, wr.trigger_kind,
              wr.worktree_path, wr.worktree_branch, wr.max_iterations, wr.attention_kind,
              wr.attention_ack, wr.started_at, wr.ended_at,
              w.repo_path AS repo_path, w.title AS workflow_title
         FROM workflow_runs wr
         JOIN workflows w ON w.id = wr.workflow_id
        WHERE w.ephemeral = 1
        ORDER BY wr.started_at DESC
        LIMIT ?`,
    )
    .all(Math.max(1, Math.min(100, limit))) as Array<
    WorkflowRunRow & { repo_path: string | null; workflow_title: string | null }
  >;
}

export function setRunStatus(
  id: string,
  status: WorkflowRunRow["status"],
  endedAt: number | null,
): void {
  db()
    .prepare(`UPDATE workflow_runs SET status = ?, ended_at = ? WHERE id = ?`)
    .run(status, endedAt, id);
}

/**
 * run 의 «미해결» 신호 (workflow_attention_v1). run 마감 시 한 번 산출해 박는다 — NULL 이면 정상(표시
 * 없음), 'failed'|'empty'|'synthetic' 이면 앱이 배너/칩으로 표면화한다. attention_ack 은 0 으로 둔다
 * (새 신호는 미확인). 정상 run 엔 호출하지 않아 거짓 경보가 안 붙는다.
 */
export function setRunAttention(id: string, kind: "failed" | "empty" | "synthetic"): void {
  db()
    .prepare(`UPDATE workflow_runs SET attention_kind = ?, attention_ack = 0 WHERE id = ?`)
    .run(kind, id);
}

/** 사용자가 미해결 신호를 확인/처리함 — 배너에서 사라진다 (멱등). */
export function ackRunAttention(id: string): boolean {
  return (
    db()
      .prepare(`UPDATE workflow_runs SET attention_ack = 1 WHERE id = ? AND attention_kind IS NOT NULL`)
      .run(id).changes > 0
  );
}

/**
 * 모든 워크플로우에 걸친 «미해결 무인 실행» — attention_kind 가 있고 아직 확인 안 됐으며(ack=0)
 * 무인 트리거(cron/github)인 run 들. 최근 N건 페이징 너머의 실패도 여기엔 집계되므로(AC5), 앱이
 * «미해결이 N건 있다» 신호를 놓치지 않는다. 최신순. 표시할 만큼만 상한(50)으로 자른다.
 */
export function listUnackedAttentionRuns(): Array<
  WorkflowRunRow & { workflow_title: string | null }
> {
  return db()
    .prepare(
      `SELECT wr.id, wr.workflow_id, wr.def_snapshot, wr.status, wr.trigger_kind,
              wr.worktree_path, wr.worktree_branch, wr.attention_kind, wr.attention_ack,
              wr.started_at, wr.ended_at, w.title AS workflow_title
         FROM workflow_runs wr
         JOIN workflows w ON w.id = wr.workflow_id
        WHERE wr.attention_kind IS NOT NULL
          AND wr.attention_ack = 0
          AND wr.trigger_kind IN ('cron', 'github')
        ORDER BY wr.ended_at DESC, wr.started_at DESC
        LIMIT 50`,
    )
    .all() as Array<WorkflowRunRow & { workflow_title: string | null }>;
}

// ── 노드별 실행 (workflow_node_runs) ──────────────────────────────────────────

const NODE_COLS = `id, run_id, def_node_id, node_type, parent_node_run_id, session_id,
  title, agent, task_folder, status, verdict, iteration, loopback_reason, limit_reached, result_kind, x, y, created_at, ended_at`;

export type NodeRunInput = {
  runId: string;
  defNodeId: string | null;
  nodeType: WorkflowNodeRunRow["node_type"];
  parentNodeRunId: string | null;
  title: string | null;
  agent: string | null;
  x: number | null;
  y: number | null;
};

export function insertNodeRun(input: NodeRunInput): WorkflowNodeRunRow {
  const id = randomUUID();
  db()
    .prepare(
      `INSERT INTO workflow_node_runs
        (id, run_id, def_node_id, node_type, parent_node_run_id, title, agent, status, iteration, x, y, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
    )
    .run(
      id,
      input.runId,
      input.defNodeId,
      input.nodeType,
      input.parentNodeRunId,
      input.title,
      input.agent,
      input.x,
      input.y,
      Date.now(),
    );
  return getNodeRun(id)!;
}

export function getNodeRun(id: string): WorkflowNodeRunRow | undefined {
  return db()
    .prepare(`SELECT ${NODE_COLS} FROM workflow_node_runs WHERE id = ?`)
    .get(id) as WorkflowNodeRunRow | undefined;
}

export function listNodeRuns(runId: string): WorkflowNodeRunRow[] {
  return db()
    .prepare(`SELECT ${NODE_COLS} FROM workflow_node_runs WHERE run_id = ? ORDER BY created_at ASC`)
    .all(runId) as WorkflowNodeRunRow[];
}

/** 부분 패치 — undefined 키는 안 건드림. status 변경 시 ended_at 도 같이 줄 수 있다. */
export function updateNodeRun(
  id: string,
  patch: Partial<{
    sessionId: string | null;
    taskFolder: string | null;
    status: WorkflowNodeRunRow["status"];
    verdict: "pass" | "fail" | null;
    iteration: number;
    loopbackReason: string | null;
    limitReached: boolean;
    resultKind: "agent" | "synthetic" | "empty" | null;
    endedAt: number | null;
  }>,
): void {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (patch.sessionId !== undefined) {
    sets.push("session_id = ?");
    vals.push(patch.sessionId);
  }
  if (patch.taskFolder !== undefined) {
    sets.push("task_folder = ?");
    vals.push(patch.taskFolder);
  }
  if (patch.status !== undefined) {
    sets.push("status = ?");
    vals.push(patch.status);
  }
  if (patch.verdict !== undefined) {
    sets.push("verdict = ?");
    vals.push(patch.verdict);
  }
  if (patch.iteration !== undefined) {
    sets.push("iteration = ?");
    vals.push(patch.iteration);
  }
  if (patch.loopbackReason !== undefined) {
    sets.push("loopback_reason = ?");
    vals.push(patch.loopbackReason);
  }
  if (patch.limitReached !== undefined) {
    sets.push("limit_reached = ?");
    vals.push(patch.limitReached ? 1 : 0);
  }
  if (patch.resultKind !== undefined) {
    sets.push("result_kind = ?");
    vals.push(patch.resultKind);
  }
  if (patch.endedAt !== undefined) {
    sets.push("ended_at = ?");
    vals.push(patch.endedAt);
  }
  if (sets.length === 0) return;
  vals.push(id);
  db()
    .prepare(`UPDATE workflow_node_runs SET ${sets.join(", ")} WHERE id = ?`)
    .run(...(vals as never[]));
}

// ── 트리거 (workflow_triggers) — 시작 노드 트리거의 런타임 등록부 ──────────────

const TRIG_COLS = `id, workflow_id, start_node_id, kind, schedule, timezone, repo_path,
  branch, poll_seconds, last_sha, enabled, last_fired_at, next_check_at, created_at`;

export type TriggerInput = {
  workflowId: string;
  startNodeId: string;
  kind: "cron" | "github";
  schedule: string | null;
  timezone: string | null;
  repoPath: string | null;
  branch: string | null;
  pollSeconds: number | null;
};

/** 모든 트리거 (스케줄러가 부팅/폴 때 훑는다). */
export function listTriggers(): WorkflowTriggerRow[] {
  return db().prepare(`SELECT ${TRIG_COLS} FROM workflow_triggers`).all() as WorkflowTriggerRow[];
}

export function listTriggersForWorkflow(workflowId: string): WorkflowTriggerRow[] {
  return db()
    .prepare(`SELECT ${TRIG_COLS} FROM workflow_triggers WHERE workflow_id = ?`)
    .all(workflowId) as WorkflowTriggerRow[];
}

export function deleteTriggersForWorkflow(workflowId: string): void {
  db().prepare(`DELETE FROM workflow_triggers WHERE workflow_id = ?`).run(workflowId);
}

export function insertTrigger(input: TriggerInput): WorkflowTriggerRow {
  const id = randomUUID();
  db()
    .prepare(
      `INSERT INTO workflow_triggers
        (id, workflow_id, start_node_id, kind, schedule, timezone, repo_path, branch,
         poll_seconds, enabled, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    )
    .run(
      id,
      input.workflowId,
      input.startNodeId,
      input.kind,
      input.schedule,
      input.timezone,
      input.repoPath,
      input.branch,
      input.pollSeconds,
      Date.now(),
    );
  return db()
    .prepare(`SELECT ${TRIG_COLS} FROM workflow_triggers WHERE id = ?`)
    .get(id) as WorkflowTriggerRow;
}

/** github 폴러/firing 런타임 필드 갱신. */
export function updateTriggerRuntime(
  id: string,
  fields: { lastSha?: string | null; lastFiredAt?: number; nextCheckAt?: number },
): void {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (fields.lastSha !== undefined) {
    sets.push("last_sha = ?");
    vals.push(fields.lastSha);
  }
  if (fields.lastFiredAt !== undefined) {
    sets.push("last_fired_at = ?");
    vals.push(fields.lastFiredAt);
  }
  if (fields.nextCheckAt !== undefined) {
    sets.push("next_check_at = ?");
    vals.push(fields.nextCheckAt);
  }
  if (sets.length === 0) return;
  vals.push(id);
  db()
    .prepare(`UPDATE workflow_triggers SET ${sets.join(", ")} WHERE id = ?`)
    .run(...(vals as never[]));
}
