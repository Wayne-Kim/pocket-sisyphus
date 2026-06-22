/**
 * 「반복 실행」(repeat_run_v1) — 워크플로우 캔버스 없이, 폰에서 30초에 거는 «랄프 루프».
 *
 * 핵심 통찰: «하나의 목표를 통과할 때까지 매번 새 컨텍스트로 다시 실행» = 자기교정 루프
 * (start → 실행 → 점검 → end + «점검 실패 → 실행» fail back-edge) 1개다. 그래서 이 모듈은 새
 * 엔진을 만들지 않고, 사용자가 고른 (repo·에이전트·목표 스펙·완료 검사·최대 횟수)로 그 루프를
 * 즉석 «합성» 해 *일회용(ephemeral)* 워크플로우로 저장한 뒤, 기존 워크플로우 엔진(startWorkflowRun)
 * 으로 돌린다. 엔진의 fail-루프(reset+rerun)가 매 회 createSession 으로 «새 세션 = 새 컨텍스트» 를
 * 만들고, 점검 노드의 verdict 가 pass 면 end(완료), 끝내 fail 이면 «최대 횟수» 에서 멈춘다(실패).
 *
 * 무인 경로라:
 *   - worktree 격리(po/워크플로우와 동일)로 돌아 동시 run 이 작업트리·git 인덱스를 함께 밟지 않는다.
 *   - no-unattended-trifecta(taint+egress 동시 금지)·skip_permissions 방어는 엔진의
 *     prepareUnattendedCwd(startWorkflowRun 내부)가 그대로 강제한다 — 이 모듈은 우회하지 않는다.
 *
 * docs/ARCHITECTURE.md §12.2 (워크플로우 엔진) 참고.
 */
import { getAgent, hasAgent } from "../agent/registry.js";
import { resolveAndEnsureRepoDir } from "../routes/sessions.js";
import { createWorktree } from "../git/worktree.js";
import { db, type WorkflowRunRow, type WorkflowNodeRunRow } from "../db/index.js";
import { insertWorkflow } from "./store.js";
import { startWorkflowRun, WORKFLOW_MAX_ITERATIONS } from "./engine.js";
import { parseSnapshot, type NodeDef, type EdgeDef } from "./types.js";

/** 캔버스 좌표 — 클라가 캔버스를 안 그리지만, 노드 레이아웃 컬럼을 비워두지 않게 세로로 쌓는다. */
const COL_X = 80;
const ROW_GAP = 130;
const TOP_Y = 60;

/** 「반복 실행」을 거는 입력 — 시트가 모으는 5필드 + 격리/승인 옵션. */
export type RepeatRunInput = {
  repoPath: string;
  /** 실행/점검 에이전트 (registry id). 미지정/미등록이면 claude_code. */
  agent?: string;
  /** 매 회 다시 먹일 목표 스펙(프롬프트). */
  goal: string;
  /** 완료 검사 — 점검 노드의 프롬프트. 통과(pass)면 멈추고, 실패(fail)면 다시 실행. */
  check: string;
  /** 최대 횟수 — 점검 fail-루프 상한. 엔진 하드캡(WORKFLOW_MAX_ITERATIONS)으로 클램프. */
  maxIterations: number;
  /** worktree 격리에서 돌릴지 (기본 true — 무인 경로). false 면 공유 repo. */
  isolated?: boolean;
  /** 민감한 작업을 무인 승인할지(skip_permissions). 무인 루프라 기본 true — 끄면 승인 프롬프트에서 멈춘다. */
  skipPermissions?: boolean;
};

/**
 * 자기교정 루프 def 합성 — start → 실행(목표 스펙) → 점검(완료 검사) → end + «점검 fail → 실행»
 * back-edge. 점검 노드에 fail 간선이 달려 엔진이 명시적 verdict(pass/fail)를 요청하고(wantsVerdict),
 * fail 이면 실행으로 되돌아가 새 세션으로 재시도한다. 노드 종류는 start/task/end 뿐이라 종류색 유지.
 */
export function buildRepeatDef(input: {
  goal: string;
  check: string;
  agent?: string;
  skipPermissions?: boolean;
}): { nodes: NodeDef[]; edges: EdgeDef[] } {
  const agent = input.agent;
  const skip = input.skipPermissions === true ? true : undefined;
  const nodes: NodeDef[] = [
    { id: "start", type: "start", title: "시작", x: COL_X, y: TOP_Y },
    {
      id: "make",
      type: "task",
      title: "실행",
      agent,
      prompt: input.goal,
      skip_permissions: skip,
      x: COL_X,
      y: TOP_Y + ROW_GAP,
    },
    {
      id: "check",
      type: "task",
      title: "점검",
      agent,
      prompt: input.check,
      skip_permissions: skip,
      x: COL_X,
      y: TOP_Y + ROW_GAP * 2,
    },
    { id: "end", type: "end", title: "완료", x: COL_X, y: TOP_Y + ROW_GAP * 3 },
  ];
  const edges: EdgeDef[] = [
    { id: "e_start_make", from: "start", to: "make" },
    { id: "e_make_check", from: "make", to: "check" },
    { id: "e_check_end", from: "check", to: "end" },
    // 점검 실패 → 실행으로 되돌아가는 루프(back-edge). condition="fail" 만 순환 허용(types.ts).
    { id: "e_check_make", from: "check", to: "make", condition: "fail" },
  ];
  return { nodes, edges };
}

/**
 * 「반복 실행」 시작 — ephemeral 워크플로우를 만들고(캔버스 목록에서 숨김), 격리면 worktree 를 만든
 * 뒤 엔진으로 돌린다. worktree 생성 실패는 조용히 공유 repo 로 폴백하지 않고 거절한다(PO 와 동형 —
 * 사용자가 명시한 격리를 무음으로 무시하지 않는다). runId/workflowId 즉시 반환 — 진행은 백그라운드.
 */
export async function startRepeatRun(
  input: RepeatRunInput,
): Promise<{ runId: string; workflowId: string } | { error: string; status: number }> {
  const goal = input.goal.trim();
  const check = input.check.trim();
  if (!goal) return { error: "goal_required", status: 400 };
  if (!check) return { error: "check_required", status: 400 };

  const dir = resolveAndEnsureRepoDir(input.repoPath);
  if ("error" in dir) return { error: dir.error, status: 400 };

  const agentId = input.agent && hasAgent(input.agent) ? input.agent : "claude_code";
  if (!hasAgent(agentId)) return { error: "agent_missing", status: 400 };

  const def = buildRepeatDef({
    goal,
    check,
    agent: agentId,
    skipPermissions: input.skipPermissions !== false,
  });

  // 일회용 워크플로우로 저장 — ephemeral=1 이라 캔버스 목록(GET /api/workflows)에 안 뜬다.
  // 제목은 목표 스펙 첫 줄 요약(추적·기록용). enabled 는 의미 없어 true.
  const title = `🔁 ${goal.split("\n")[0]}`.slice(0, 120);
  const wf = insertWorkflow({
    title,
    repoPath: dir.path,
    nodes: JSON.stringify(def.nodes),
    edges: JSON.stringify(def.edges),
    enabled: true,
    ephemeral: true,
  });

  // worktree 격리 (기본) — `wf/<id8>` 새 브랜치. reaper 의 관리 prefix(wf/)라 종결 후 자동 회수된다.
  let worktree: { path: string; branch: string } | undefined;
  if (input.isolated !== false) {
    const branch = `wf/${wf.id.slice(0, 8)}`;
    const wt = await createWorktree(dir.path, { branch, newBranch: true });
    if (!wt.ok) {
      return { error: wt.body.message ?? wt.body.error ?? "worktree_failed", status: wt.status };
    }
    worktree = { path: wt.path, branch: wt.branch };
  }

  // 엔진으로 실행 — prepareUnattendedCwd(trifecta/skip_permissions 방어)는 startWorkflowRun 내부가 강제.
  const result = startWorkflowRun(wf, "manual", {
    worktree,
    maxIterations: input.maxIterations,
  });
  if ("error" in result) return { error: result.error, status: 400 };
  return { runId: result.runId, workflowId: wf.id };
}

/** 「반복 실행」 한 건의 API 표현 — iOS 가 진행/완료/실패 카드로 그린다(캔버스 없이). */
export type RepeatRunApi = {
  run_id: string;
  workflow_id: string;
  repo_path: string | null;
  agent: string | null;
  /** 목표 스펙(실행 노드 prompt). */
  goal: string | null;
  /** 완료 검사(점검 노드 prompt). */
  check: string | null;
  status: WorkflowRunRow["status"]; // running | done | failed | cancelled
  /** 현재 반복 회차 (1-based). */
  iteration: number;
  /** 최대 횟수. */
  max_iterations: number;
  /** 점검 노드 판정 — pass(완료) | fail | null(아직). */
  verdict: "pass" | "fail" | null;
  /** 1 = 최대 횟수 도달로 멈춤. */
  limit_reached: boolean;
  started_at: number;
  ended_at: number | null;
};

/**
 * run 행 + node_runs 에서 「반복 실행」 상태를 파생한다. iteration 은 task 노드들의 최대 iteration
 * 컬럼 +1(1-based 현재 회차), verdict 는 점검 노드 판정, goal/check/agent 는 def_snapshot 에서 읽는다.
 */
export function summarizeRepeatRun(
  run: WorkflowRunRow & { repo_path?: string | null },
  nodeRuns: WorkflowNodeRunRow[],
): RepeatRunApi {
  const def = parseSnapshot(run.def_snapshot);
  const makeNode = def.nodes.find((n) => n.id === "make");
  const checkNode = def.nodes.find((n) => n.id === "check");
  const checkRun = nodeRuns.find((nr) => nr.def_node_id === "check");

  const taskIters = nodeRuns
    .filter((nr) => nr.node_type === "task" || nr.node_type === "general" || nr.node_type === "test")
    .map((nr) => nr.iteration ?? 0);
  const maxIter = run.max_iterations ?? WORKFLOW_MAX_ITERATIONS;
  // 0-based 최대 iteration +1 = 현재(또는 마지막) 회차. 상한으로 클램프(표시 안정).
  const iteration = Math.min(maxIter, (taskIters.length ? Math.max(...taskIters) : 0) + 1);

  return {
    run_id: run.id,
    workflow_id: run.workflow_id,
    repo_path: run.repo_path ?? null,
    agent: makeNode?.agent ?? null,
    goal: makeNode?.prompt ?? null,
    check: checkNode?.prompt ?? null,
    status: run.status,
    iteration,
    max_iterations: maxIter,
    verdict: checkRun?.verdict ?? null,
    limit_reached: nodeRuns.some((nr) => nr.limit_reached === 1),
    started_at: run.started_at,
    ended_at: run.ended_at,
  };
}

/** repo_path 조인이 없는 run 행을 위해 ephemeral 워크플로우의 repo_path 를 조회한다(단건 status 경로). */
export function repoPathForRun(run: WorkflowRunRow): string | null {
  try {
    const row = db()
      .prepare(`SELECT repo_path FROM workflows WHERE id = ?`)
      .get(run.workflow_id) as { repo_path: string | null } | undefined;
    return row?.repo_path ?? null;
  } catch {
    return null;
  }
}
