/**
 * WorkflowEngine — 그래프(DAG)를 위상 순서대로 실행한다.
 *
 * 핵심 통찰 (cron 과 동일): 일하는 노드(task) 1개 = 세션 1개. createSession +
 * runUserMessagePty 로 평범한 세션을 만들고, pty-runner 의 turn 정착(turn_complete/exit)을
 * ptyEvents 로 기다린 뒤 Task 폴더에서 결과를 harvest 한다. 시작/종료 노드는 에이전트 일을
 * 안 하는 터미네이터 — 즉시 done 처리하고 하위를 활성화한다.
 *
 * 지원: 정적 DAG, 작업 성공/실패 분기(verdict pass→무조건 간선 / fail→fail 간선 + dead-path
 * 전파), 동적 분기 (branches.json → 런타임 자식 노드, MAX_NODES/MAX_DEPTH 캡), 트리거
 * (triggers.ts), 승인 게이트(requires_approval → 사용자 승인 전까지 대기), 수동 개입
 * (needs_attention → 완료/재시도), 실패 fail 루프(back-edge reset+rerun, MAX_ITERATIONS 캡). run 상태는
 * in-memory — daemon 재시작 시 진행 중 run 은 부팅 시 reconcileStaleRuns 로 'failed' 처리.
 *
 * docs/ARCHITECTURE.md §12.2 (워크플로우 엔진) 참고.
 */
import { randomBytes } from "node:crypto";
import { db, type WorkflowRow } from "../db/index.js";
import {
  runUserMessagePty,
  abortPtySession,
  awaitPtyExit,
  ptyEvents,
  type PtyLifecycleEvent,
} from "../agent/pty-runner.js";
import { getAgent, hasAgent } from "../agent/registry.js";
import { createSession, resolveAndEnsureRepoDir } from "../routes/sessions.js";
import { broadcastAll } from "../ws/hub.js";
import {
  parseDef,
  childrenOf,
  type NodeDef,
  type EdgeDef,
  type WorkflowDef,
} from "./types.js";
import {
  insertRun,
  insertNodeRun,
  updateNodeRun,
  setRunStatus,
  listNodeRuns,
  listRunningRuns,
  getNodeRun,
  getWorkflow,
} from "./store.js";
import { dispatchWorkflowNotification } from "../notify/index.js";
import {
  ensureTaskFolder,
  taskFolderRel,
  buildNodePrompt,
  harvestTaskFolder,
  writeResultMd,
  resultMdExists,
  runFolderRel,
  writeRunManifest,
  type ParentFolderRef,
  type BranchSpec,
} from "./task-folder.js";

/** 동시에 실행 중인 일하는 노드 수 상한 — PTY(메모리/CPU) 폭증 방지. */
const MAX_CONCURRENT_NODES = 4;
/** 한 노드가 무한히 매달리지 않도록 하는 hard cap — 초과 시 settle 'timeout'. */
const MAX_NODE_RUNTIME_MS = 30 * 60 * 1000;
/** 기본 에이전트 (노드가 agent 를 안 줬거나 미등록일 때). */
const DEFAULT_AGENT_ID = "claude_code";
/** 동적 분기 무한증식 차단 — run 당 노드 총수 상한. */
const MAX_NODES = 200;
/** 동적 분기 체인 깊이 상한 (자식의 자식의 …). */
const MAX_DEPTH = 8;
/** 테스트 fail 루프 반복 상한 — 무한 루프 + 토큰 폭주 차단 (back-edge 1개당). */
const MAX_ITERATIONS = 10;

/** 동적 분기로 생성된 노드의 실행 대기 항목. */
type DynamicItem = {
  nodeRunId: string;
  spec: BranchSpec;
  /** 실행 repo (부모와 동일). */
  repoInput: string;
  /** 부모 Task 폴더 (헤더 주입용). */
  parentFolderRel: string;
  parentTitle: string;
  depth: number;
  requiresApproval: boolean;
};

type RunState = {
  runId: string;
  wfId: string;
  wfTitle: string | null;
  /** run 시작시각 — 폴더 스탬프(로컬 YYYYMMDD-HHMMSS)와 매니페스트(ISO). */
  runStamp: string;
  runStartedIso: string;
  trigger: "manual" | "cron" | "github";
  def: WorkflowDef;
  defRepoPath: string | null;
  runToken: string;
  nodeById: Map<string, NodeDef>;
  /** def node id → node_run id. */
  nodeRunByDefId: Map<string, string>;
  /** def node id → 아직 안 끝난 부모 수. */
  remaining: Map<string, number>;
  /** 이미 큐에 넣은(또는 skip 확정된) def node id (중복 처리 방지). */
  enqueued: Set<string>;
  /** 들어오는 간선 중 «taken» 된 게 하나라도 있는 def node id — dead-path 판정용. */
  anyTaken: Set<string>;
  /** 실행 준비된 def node id. */
  queue: string[];
  /** 동적 분기로 생성된 노드의 실행 대기열. */
  dynamicQueue: DynamicItem[];
  /** 지금까지 만든 node_run 총수 (MAX_NODES 캡). */
  nodeCount: number;
  /** node_run id → 동적 분기 체인 깊이 (정적 노드는 0). */
  depth: Map<string, number>;
  /** 전진 그래프(루프 back-edge 제외) 위의 도달 가능성 — defId → 도달 가능한 defId 집합. */
  reach: Map<string, Set<string>>;
  /** 루프 back-edge(테스트 fail → 조상) 인 간선 id 집합. indegree 에서 제외, 루프로만 처리. */
  backEdgeIds: Set<string>;
  /** back-edge id → 지금까지 돈 루프 반복 수 (MAX_ITERATIONS 캡). */
  loopIter: Map<string, number>;
  /** 사용자 결정 대기 중인 노드 — nodeRunId → { action: handler }. 승인(approve/reject) +
   *  수동 개입(complete/retry). 비어 있지 않으면 run 은 끝나지 않고 사용자를 기다린다. */
  pending: Map<string, Record<string, () => void>>;
  /** 이미 승인된 nodeRunId — 재실행/재큐 시 다시 게이트하지 않게. */
  approved: Set<string>;
  /** 지금 실행 중인 일하는 노드 수. */
  active: number;
  /** 현재 활성 노드들의 sessionId (취소 시 abort 용). */
  activeSessions: Set<string>;
  cancelled: boolean;
  anyFailed: boolean;
  finished: boolean;
  /** true 면 엔진의 워크플로우 알림(게이트/주의/실패)을 끈다 — PO «워크플로우로 실행» run 은
   *  자체 watch 루프가 po_gate/po_failed 를 쏘므로 이중 발화를 막는다. */
  suppressNotify: boolean;
};

/** run 폴더 스탬프 — 로컬 시각 YYYYMMDD-HHMMSS. */
function localStamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const runs = new Map<string, RunState>();

// ── 공개 API ──────────────────────────────────────────────────────────────────

/** 워크플로우를 한 번 실행한다. 세션을 만들고 즉시 runId 반환 — 진행은 백그라운드.
 *
 * opts.worktree (po_run_worktree_v1): 주어지면 이 run 의 «모든 노드 cwd» 를 공유
 * workflow.repo_path 대신 그 격리 worktree 로 고정한다 (defRepoPath 오버라이드). 동시 run 이
 * 같은 작업트리·git 인덱스를 밟지 않게 PO «워크플로우로 실행» 이 run 전에 만들어 넘긴다.
 * 저장된 워크플로우 자산(workflow.repo_path)은 «실제 레포» 그대로 — 오버라이드는 run 한정.
 * worktree 경로/브랜치는 run 행에 기록해 추적·정리(reaper brief)를 가능케 한다. */
export function startWorkflowRun(
  workflow: WorkflowRow,
  triggerKind: "manual" | "cron" | "github",
  opts?: { suppressNotify?: boolean; worktree?: { path: string; branch: string } },
): { runId: string } | { error: string } {
  const def = parseDef(workflow.nodes, workflow.edges);
  if (def.nodes.length === 0) return { error: "노드가 비어 있어요." };

  const snapshot = JSON.stringify({ nodes: def.nodes, edges: def.edges });
  const run = insertRun(workflow.id, snapshot, triggerKind, opts?.worktree);

  const nodeById = new Map<string, NodeDef>();
  for (const n of def.nodes) nodeById.set(n.id, n);

  // 모든 정의 노드에 대해 node_run 을 미리 만든다 (status pending) — iOS 캔버스가 전체
  // 그래프를 즉시 그릴 수 있게. 정적 노드는 parent_node_run_id=NULL (간선은 def_snapshot
  // 에서 읽는다); 동적 노드(Phase 2)만 parent 링크를 쓴다.
  const nodeRunByDefId = new Map<string, string>();
  for (const n of def.nodes) {
    const nr = insertNodeRun({
      runId: run.id,
      defNodeId: n.id,
      nodeType: n.type,
      parentNodeRunId: null,
      title: n.title ?? null,
      agent: n.type === "task" ? n.agent ?? DEFAULT_AGENT_ID : null,
      x: n.x ?? null,
      y: n.y ?? null,
    });
    nodeRunByDefId.set(n.id, nr.id);
  }

  // 루프 back-edge 분류 — «작업의 fail 간선» 이 조상으로 되돌아가면 루프 back-edge.
  // 판정: fail 간선을 뺀 그래프(G0)에서 도착(to)이 출발(from)에 도달 가능하면 back-edge.
  // back-edge 는 indegree/reach 에서 제외하고, 루프(reset+rerun)로만 처리한다.
  const isFailEdge = (e: EdgeDef): boolean => e.condition === "fail";
  const g0Edges = def.edges.filter((e) => !isFailEdge(e));
  const reach0 = computeReach(def.nodes, g0Edges);
  const backEdgeIds = new Set<string>();
  for (const e of def.edges) {
    if (isFailEdge(e) && reach0.get(e.to)?.has(e.from)) backEdgeIds.add(e.id);
  }
  const forwardEdges = def.edges.filter((e) => !backEdgeIds.has(e.id));
  const reach = computeReach(def.nodes, forwardEdges);

  // indegree 는 전진 간선(back-edge 제외) 기준.
  const remaining = new Map<string, number>();
  for (const n of def.nodes) remaining.set(n.id, 0);
  for (const e of forwardEdges) remaining.set(e.to, (remaining.get(e.to) ?? 0) + 1);

  const state: RunState = {
    runId: run.id,
    wfId: workflow.id,
    wfTitle: workflow.title,
    runStamp: localStamp(run.started_at),
    runStartedIso: new Date(run.started_at).toISOString(),
    trigger: triggerKind,
    def,
    // per-run worktree 가 있으면 그게 «모든 노드의 cwd» (공유 repo 오버라이드). 정적·동적·게이트
    // 노드 모두 node.repo_path 미설정 시 이 값을 cwd 로 쓴다 (executeWorkNode/executeDynamicNode).
    defRepoPath: opts?.worktree?.path ?? workflow.repo_path,
    runToken: randomBytes(6).toString("hex"),
    nodeById,
    nodeRunByDefId,
    remaining,
    enqueued: new Set(),
    anyTaken: new Set(),
    queue: [],
    dynamicQueue: [],
    nodeCount: def.nodes.length,
    depth: new Map(),
    reach,
    backEdgeIds,
    loopIter: new Map(),
    pending: new Map(),
    approved: new Set(),
    active: 0,
    activeSessions: new Set(),
    cancelled: false,
    anyFailed: false,
    finished: false,
    suppressNotify: opts?.suppressNotify === true,
  };
  runs.set(run.id, state);

  // 루트 = 전진 indegree 0 (보통 시작 노드).
  for (const n of def.nodes) {
    if ((remaining.get(n.id) ?? 0) === 0) {
      state.enqueued.add(n.id);
      state.queue.push(n.id);
    }
  }
  console.log(
    `[workflow] run=${run.id} workflow=${workflow.id} nodes=${def.nodes.length} trigger=${triggerKind}`,
  );
  broadcastRun(run.id, "running");
  pump(state);
  return { runId: run.id };
}

/** 진행 중인 run 을 취소 — 활성 노드의 PTY 를 abort 하고 하위 활성화를 막는다. */
export function cancelWorkflowRun(runId: string): boolean {
  const state = runs.get(runId);
  if (!state) return false;
  state.cancelled = true;
  // 대기열 + 사용자 결정 대기 비움 — 안 그러면 maybeFinish 가 영영 안 끝난다 (대기 노드는
  // maybeFinish 의 정리 루프가 skipped 로 마감).
  state.queue = [];
  state.dynamicQueue = [];
  state.pending.clear();
  for (const sid of state.activeSessions) {
    try {
      abortPtySession(sid);
    } catch {
      /* best-effort */
    }
  }
  // 즉시 종료를 시도한다. 활성 세션이 있으면 maybeFinish 가 early-return 하고, abort 된 세션이
  // settle→finally→pump→maybeFinish 로 마감한다. 활성 세션이 없는 경우(노드가 needs_attention/
  // 승인대기로 parked 돼 pending 에만 있던 경우)에는 여기서 바로 마감해야 «정지» 가 먹는다.
  // (이전엔 maybeFinish 를 안 불러서 parked 상태 run 이 영영 'running' 으로 남는 버그가 있었다.)
  maybeFinish(state);
  return true;
}

/** 부팅 시 — 이전 프로세스에서 in-memory 상태를 잃은 채 'running' 으로 남은 run 을 정리. */
export function reconcileStaleRuns(): void {
  for (const r of listRunningRuns()) {
    if (runs.has(r.id)) continue;
    setRunStatus(r.id, "failed", Date.now());
    // pending/running 노드도 정리.
    for (const nr of listNodeRuns(r.id)) {
      if (nr.status === "pending" || nr.status === "running" || nr.status === "awaiting_approval") {
        updateNodeRun(nr.id, { status: "skipped", endedAt: Date.now() });
      }
    }
    // 재시작으로 in-memory 상태(+PO watch 루프)가 사라진 run 이라 알림 경로도 끊겼다 — 여기서
    // 직접 실패 알림 1회. (PO run 도 watch 가 죽어 po_failed 를 못 쏘므로 이중 발화 우려 없음.)
    const wf = getWorkflow(r.workflow_id);
    void dispatchWorkflowNotification({
      kind: "workflow_failed",
      runId: r.id,
      workflowTitle: wf?.title ?? null,
      repoPath: wf?.repo_path ?? null,
    });
    console.log(`[workflow] reconciled stale run=${r.id} → failed (daemon restart)`);
  }
}

/**
 * 지금 in-memory 로 진행 중인 run 들이 «선» worktree 경로 — worktree reaper 가 활성 run 의
 * worktree 를 절대 회수하지 않도록 보호 집합으로 쓴다. 현재는 run 의 활성 노드 세션 cwd(=세션
 * repo_path) 로 도출한다 — per-run worktree 가 도입되면 노드 세션이 그 worktree 안에서 돌므로
 * 자동으로 포함된다. DB 의 «활성 세션» 질의와 중복되지만, in-memory 엔진 상태가 권위 있는
 * 출처라 둘을 같이 쓴다 (방어적 — 세션 status 갱신 지연 창을 메운다).
 */
export function activeRunWorktreePaths(): string[] {
  const out = new Set<string>();
  for (const state of runs.values()) {
    for (const sid of state.activeSessions) {
      try {
        const row = db()
          .prepare(`SELECT repo_path FROM sessions WHERE id = ?`)
          .get(sid) as { repo_path: string } | undefined;
        if (row?.repo_path) out.add(row.repo_path);
      } catch {
        /* best-effort — 조회 실패는 무시 */
      }
    }
  }
  return [...out];
}

// ── 진행 루프 ─────────────────────────────────────────────────────────────────

function pump(state: RunState): void {
  if (state.finished) return;
  while (
    !state.cancelled &&
    state.active < MAX_CONCURRENT_NODES &&
    (state.queue.length > 0 || state.dynamicQueue.length > 0)
  ) {
    if (state.queue.length > 0) {
      const defId = state.queue.shift()!;
      const node = state.nodeById.get(defId);
      if (!node) continue;
      if (node.type === "start" || node.type === "end") {
        // 터미네이터 — 세션 없이 즉시 done. 하위 활성화는 completeNode 가 큐에 넣는다.
        completeNode(state, defId, "done", null);
      } else {
        const nodeRunId = state.nodeRunByDefId.get(defId)!;
        // 승인 게이트 — requires_approval 노드는 사용자 승인 전까지 실행하지 않는다 (슬롯도 안 잡음).
        if (node.requires_approval === true && !state.approved.has(nodeRunId)) {
          gate(state, nodeRunId, {
            approve: () => {
              state.approved.add(nodeRunId);
              state.queue.unshift(defId);
              pump(state);
            },
            reject: () => {
              completeNode(state, defId, "skipped", null);
              pump(state);
            },
          });
          continue;
        }
        state.active++;
        void executeWorkNode(state, defId)
          .catch((e) => {
            console.warn(`[workflow] node ${defId} threw:`, (e as Error).message);
            completeNode(state, defId, "failed", null);
          })
          .finally(() => {
            state.active--;
            pump(state);
          });
      }
    } else {
      const item = state.dynamicQueue.shift()!;
      if (item.requiresApproval && !state.approved.has(item.nodeRunId)) {
        gate(state, item.nodeRunId, {
          approve: () => {
            state.approved.add(item.nodeRunId);
            state.dynamicQueue.unshift(item);
            pump(state);
          },
          reject: () => {
            finishDynamic(state, item.nodeRunId, "skipped", null);
            pump(state);
          },
        });
        continue;
      }
      state.active++;
      void executeDynamicNode(state, item)
        .catch((e) => {
          console.warn(`[workflow] dynamic node ${item.nodeRunId} threw:`, (e as Error).message);
          finishDynamic(state, item.nodeRunId, "failed", null);
        })
        .finally(() => {
          state.active--;
          pump(state);
        });
    }
  }
  maybeFinish(state);
}

/** 한 작업 노드를 세션으로 실행하고 harvest 결과를 돌려준다 (정적·동적 공통). */
type NodeOutcome = {
  status: "done" | "failed" | "needs_attention";
  verdict: "pass" | "fail" | null;
  branches: BranchSpec[] | null;
};

async function runNodeSession(
  state: RunState,
  p: {
    nodeRunId: string;
    /** «실패» 분기가 있어 명시적 성공/실패 판정(verdict.json)을 요청할지. */
    wantsVerdict: boolean;
    prompt: string;
    /** 노드별 결과물 처리 지시 (없으면 기본 Task 폴더 안내만). */
    resultSpec?: string;
    agentId: string;
    skipPermissions: boolean;
    repoPath: string;
    parents: ParentFolderRef[];
    title: string;
  },
): Promise<NodeOutcome> {
  const parts = {
    workflowTitle: state.wfTitle,
    workflowId: state.wfId,
    runStamp: state.runStamp,
    runId: state.runId,
    nodeTitle: p.title,
    nodeType: "task",
    nodeRunId: p.nodeRunId,
  };
  const thisFolderRel = ensureTaskFolder(p.repoPath, taskFolderRel(parts));
  writeRunManifest(p.repoPath, runFolderRel(parts), {
    workflow_id: state.wfId,
    workflow_title: state.wfTitle,
    run_id: state.runId,
    trigger: state.trigger,
    started_at: state.runStartedIso,
  });
  const sessionId = createSession(p.repoPath, `🔀 ${p.title}`, undefined, p.skipPermissions, p.agentId);
  state.activeSessions.add(sessionId);
  updateNodeRun(p.nodeRunId, { sessionId, taskFolder: thisFolderRel, status: "running" });
  broadcastNode(state.runId, p.nodeRunId, "running");
  console.log(
    `[workflow] run=${state.runId} nodeRun=${p.nodeRunId} → session=${sessionId} agent=${p.agentId}`,
  );

  const prompt = buildNodePrompt({
    prompt: p.prompt,
    thisFolderRel,
    parents: p.parents,
    runToken: state.runToken,
    wantsVerdict: p.wantsVerdict,
    resultSpec: p.resultSpec,
  });
  const settle = waitForNodeDone(sessionId, p.repoPath, thisFolderRel);
  const adapter = getAgent(p.agentId);

  // add~정리 구간을 try/finally 로 감싼다. settle/abortPtySession/awaitPtyExit 중
  // 어디서 throw 해도 finally 에서 activeSessions.delete·markSessionEnded 가 항상 실행돼
  // 세션이 activeSessions(=reaper 보호 경로)에 영구 잔류하지 않게 한다.
  let result: Awaited<typeof settle> | undefined;
  try {
    void runUserMessagePty(
      { sessionId, cwd: p.repoPath, adapter },
      prompt,
      { bypassPermissions: p.skipPermissions },
    ).catch((e) => {
      console.warn(`[workflow] runUserMessagePty failed session=${sessionId}:`, (e as Error).message);
    });
    result = await settle;

    abortPtySession(sessionId);
    await awaitPtyExit(sessionId, 4000);
  } finally {
    state.activeSessions.delete(sessionId);
    markSessionEnded(sessionId, result?.status === "error" ? "error" : "completed");
  }

  const harvest = await harvestTaskFolder(p.repoPath, thisFolderRel);
  let status: "done" | "failed" | "needs_attention";
  let verdict: "pass" | "fail" | null = null;
  if (result!.status === "error" || result!.status === "timeout") {
    // 하드 실패(세션 에러/타임아웃) — 실행 자체가 안 됨. run 을 failed 로 표시(엣지 비활성→dead-path).
    status = "failed";
    state.anyFailed = true;
  } else if (harvest.needsAttention) {
    // 에이전트가 .needs-attention 마커로 사람 개입을 명시 요청 — 체인을 멈추고 사람을 부른다
    // (opt-in 이라 정상 흐름엔 영향 0). result.md 가 있으면 그대로 두고, 없으면 굳이 합성하지
    // 않는다 — 어차피 사람이 결정(complete/retry)할 노드라.
    status = "needs_attention";
  } else {
    // 에이전트가 result.md 를 안 남겼으면 세션 출력(터미널 캡처)으로 합성한다 — 그래야 다음 노드가
    // «이전 단계 결과» 폴더를 읽고 이어서 작업할 수 있다. (예전엔 needs_attention 으로 멈춰 체인이
    // 끊겼다. 특히 터미널 도구는 프로토콜대로 result.md 를 못 쓰므로 이 폴백이 필수.)
    if (!harvest.resultMd) {
      const captured = readSessionText(sessionId);
      const body =
        captured.length > 0
          ? `# ${p.title}\n\n<!-- 에이전트가 result.md 를 남기지 않아 터미널 출력으로 자동 생성됨 -->\n\n\`\`\`\n${captured}\n\`\`\`\n`
          : `# ${p.title}\n\n(에이전트가 result.md 를 남기지 않았고 캡처된 출력도 없습니다.)\n`;
      writeResultMd(p.repoPath, thisFolderRel, body);
    }
    // verdict.json 이 있으면 그 판정, 없으면 성공으로 간주.
    verdict = harvest.verdictPass === true ? "pass" : harvest.verdictPass === false ? "fail" : "pass";
    status = "done";
  }
  return { status, verdict, branches: harvest.branches };
}

/** 정적 노드(def) 1개 실행 → completeNode(간선 활성화) + 동적 분기 spawn. */
async function executeWorkNode(state: RunState, defId: string): Promise<void> {
  if (state.cancelled) {
    completeNode(state, defId, "skipped", null);
    return;
  }
  const node = state.nodeById.get(defId)!;
  const nodeRunId = state.nodeRunByDefId.get(defId)!;

  const repoInput = node.repo_path || state.defRepoPath;
  if (!repoInput) {
    state.anyFailed = true;
    completeNode(state, defId, "failed", null);
    return;
  }
  const dir = resolveAndEnsureRepoDir(repoInput);
  if ("error" in dir) {
    state.anyFailed = true;
    completeNode(state, defId, "failed", null);
    return;
  }
  const repoPath = dir.path;
  const agentId = node.agent && hasAgent(node.agent) ? node.agent : DEFAULT_AGENT_ID;

  // 정적 부모 폴더 (def 간선 기준).
  const parents: ParentFolderRef[] = [];
  for (const e of state.def.edges) {
    if (e.to !== defId) continue;
    const parentDef = state.nodeById.get(e.from);
    if (!parentDef || parentDef.type !== "task") continue;
    const parentRunId = state.nodeRunByDefId.get(e.from);
    if (!parentRunId) continue;
    const parentFolder = getNodeRun(parentRunId)?.task_folder;
    if (!parentFolder) continue;
    parents.push({ rel: parentFolder, title: parentDef.title ?? e.from });
  }

  // «실패» 분기(fail 간선)가 있으면 명시적 성공/실패 판정을 요청한다.
  const wantsVerdict = state.def.edges.some((e) => e.from === defId && e.condition === "fail");

  const r = await runNodeSession(state, {
    nodeRunId,
    wantsVerdict,
    prompt: node.prompt ?? "",
    resultSpec: node.result_spec,
    agentId,
    skipPermissions: node.skip_permissions === true,
    repoPath,
    parents,
    title: node.title ?? defId,
  });
  if (r.status === "needs_attention") {
    parkNeedsAttention(state, nodeRunId, {
      complete: () => completeNode(state, defId, "done", null),
      retry: () => { state.queue.unshift(defId); },
    });
    return;
  }
  completeNode(state, defId, r.status, r.verdict);
  if (r.status === "done" && r.branches) {
    maybeSpawnBranches(state, nodeRunId, repoPath, r.branches);
  }
}

/** 동적 분기 노드 1개 실행 → 상태 마킹(간선 없음) + (재귀) 분기 spawn. */
async function executeDynamicNode(state: RunState, item: DynamicItem): Promise<void> {
  if (state.cancelled) {
    finishDynamic(state, item.nodeRunId, "skipped", null);
    return;
  }
  const dir = resolveAndEnsureRepoDir(item.repoInput);
  if ("error" in dir) {
    state.anyFailed = true;
    finishDynamic(state, item.nodeRunId, "failed", null);
    return;
  }
  const repoPath = dir.path;
  const agentId =
    item.spec.agent && hasAgent(item.spec.agent) ? item.spec.agent : DEFAULT_AGENT_ID;

  const r = await runNodeSession(state, {
    nodeRunId: item.nodeRunId,
    wantsVerdict: item.spec.wants_verdict === true,
    prompt: item.spec.prompt,
    agentId,
    skipPermissions: true, // 동적 분기는 무인 실행.
    repoPath,
    parents: [{ rel: item.parentFolderRel, title: item.parentTitle }],
    title: item.spec.title ?? "분기",
  });
  if (r.status === "needs_attention") {
    parkNeedsAttention(state, item.nodeRunId, {
      complete: () => finishDynamic(state, item.nodeRunId, "done", null),
      retry: () => { state.dynamicQueue.unshift(item); },
    });
    return;
  }
  finishDynamic(state, item.nodeRunId, r.status, r.verdict);
  if (r.status === "done" && r.branches) {
    maybeSpawnBranches(state, item.nodeRunId, repoPath, r.branches);
  }
}

/** 동적 노드의 terminal 상태 마킹 (간선 활성화 없음 — def 그래프 밖). */
function finishDynamic(
  state: RunState,
  nodeRunId: string,
  status: "done" | "failed" | "needs_attention" | "skipped",
  verdict: "pass" | "fail" | null,
): void {
  updateNodeRun(nodeRunId, { status, verdict, endedAt: Date.now() });
  broadcastNode(state.runId, nodeRunId, status);
}

/**
 * branches.json 의 자식 작업들을 동적 노드로 생성한다 (요구사항 ③). 부모 좌표 아래로
 * 가로 분산 오토레이아웃. MAX_DEPTH / MAX_NODES 로 무한증식 차단 (초과 시 로그 + 생략).
 */
function maybeSpawnBranches(
  state: RunState,
  parentRunId: string,
  parentRepoPath: string,
  branches: BranchSpec[],
): void {
  const parentDepth = state.depth.get(parentRunId) ?? 0;
  if (parentDepth + 1 > MAX_DEPTH) {
    console.warn(`[workflow] run=${state.runId} MAX_DEPTH(${MAX_DEPTH}) 도달 — 분기 생략 parent=${parentRunId}`);
    return;
  }
  const parentRow = getNodeRun(parentRunId);
  const px = parentRow?.x ?? 60;
  const py = parentRow?.y ?? 60;
  const parentFolderRel = parentRow?.task_folder ?? "";
  const parentTitle = parentRow?.title ?? "상위";
  const n = branches.length;
  for (let i = 0; i < n; i++) {
    if (state.nodeCount >= MAX_NODES) {
      console.warn(`[workflow] run=${state.runId} MAX_NODES(${MAX_NODES}) 도달 — 이후 분기 생략`);
      break;
    }
    const spec = branches[i];
    const x = px + (i - (n - 1) / 2) * 200;
    const y = py + 170;
    const nr = insertNodeRun({
      runId: state.runId,
      defNodeId: null,
      nodeType: "task",
      parentNodeRunId: parentRunId,
      title: spec.title ?? null,
      agent: spec.agent && hasAgent(spec.agent) ? spec.agent : DEFAULT_AGENT_ID,
      x,
      y,
    });
    state.nodeCount++;
    state.depth.set(nr.id, parentDepth + 1);
    state.dynamicQueue.push({
      nodeRunId: nr.id,
      spec,
      repoInput: parentRepoPath,
      parentFolderRel,
      parentTitle,
      depth: parentDepth + 1,
      requiresApproval: spec.requires_approval === true,
    });
    broadcastNode(state.runId, nr.id, "pending");
  }
  pump(state);
}

/**
 * 노드를 terminal 상태로 마킹하고 하위 간선을 해소(resolve)한다.
 *
 * 분기 모델(통합 작업): 작업은 성공(verdict pass)이면 «무조건(성공/다음)» 간선을, 실패(verdict
 * fail)면 «fail» 간선을 활성화한다 — fail 간선이 없으면 무조건 간선으로 fall-through(순차 진행).
 * 시작/종료는 verdict 없이 무조건 간선만. 하드 실패(status=failed)·취소·skip 은 모든 간선
 * not-taken. 한 노드의 모든 incoming 이 해소됐는데 taken 이 하나도 없으면 skip + 하위 전파(dead-path).
 */
function completeNode(
  state: RunState,
  defId: string,
  status: "done" | "failed" | "needs_attention" | "skipped",
  verdict: "pass" | "fail" | null,
): void {
  const nodeRunId = state.nodeRunByDefId.get(defId);
  if (nodeRunId) {
    updateNodeRun(nodeRunId, { status, verdict, endedAt: Date.now() });
    broadcastNode(state.runId, nodeRunId, status);
  }
  const outgoing = childrenOf(state.def.edges, defId);

  // 작업 실패(verdict fail) + 루프 back-edge → 루프 반복 (reset+rerun). MAX_ITERATIONS 까지.
  // 루프 중에는 다른 간선을 해소하지 않는다 (return) — 통과하거나 MAX 도달 시에만 해소한다.
  if (status === "done" && verdict === "fail" && !state.cancelled) {
    const back = outgoing.find((e) => state.backEdgeIds.has(e.id));
    if (back) {
      const it = state.loopIter.get(back.id) ?? 0;
      if (it < MAX_ITERATIONS) {
        state.loopIter.set(back.id, it + 1);
        runLoop(state, defId, back.to, it + 1);
        return;
      }
      console.warn(`[workflow] run=${state.runId} MAX_ITERATIONS(${MAX_ITERATIONS}) — 루프 종료 ${defId}`);
      // 루프가 끝내 통과 못 함 → run 을 failed 로 표시. fall through 로 일반 간선 해소.
      state.anyFailed = true;
    }
  }

  // 엣지를 활성화할 수 있는 상태 = done(에이전트가 실행 완료). failed(하드 에러)/skipped/취소는 비활성.
  const terminalOk = status === "done" && !state.cancelled;
  const failure = status === "done" && verdict === "fail";
  // back-edge 가 아닌 fail 간선이 있는지 (있으면 실패 시 무조건 간선은 fall-through 하지 않음).
  const hasFailEdge = outgoing.some((e) => !state.backEdgeIds.has(e.id) && e.condition === "fail");
  for (const e of outgoing) {
    if (state.backEdgeIds.has(e.id)) continue; // back-edge 는 루프로만 처리, resolveEdge 안 함.
    let taken = false;
    if (terminalOk) {
      if (e.condition === "fail") {
        taken = failure;
      } else {
        // 무조건(성공/다음) 간선: 성공이면 taken. 실패라도 fail 간선이 없으면 fall-through.
        taken = !failure || !hasFailEdge;
      }
    }
    resolveEdge(state, e.to, taken);
  }
}

/**
 * 테스트 fail 루프 한 번 — 루프 몸통(back-edge 타깃 B 에서 테스트 T 까지의 전진 경로 노드들)을
 * 리셋하고 다시 enqueue 한다. 같은 node_run 을 재사용(iteration 컬럼 bump)해 캔버스가 최신
 * 반복 상태를 보여 준다. reset 후 intra-loop indegree 로 remaining 을 다시 잡아 B 부터 재실행.
 */
function runLoop(state: RunState, testDefId: string, backTarget: string, iter: number): void {
  const inBody = (x: string): boolean => {
    const reachFromB = backTarget === x || state.reach.get(backTarget)?.has(x) === true;
    const reachToT = x === testDefId || state.reach.get(x)?.has(testDefId) === true;
    return reachFromB && reachToT;
  };
  const body = state.def.nodes.map((n) => n.id).filter(inBody);
  const bodySet = new Set(body);
  console.log(`[workflow] run=${state.runId} loop iter=${iter} body=[${body.join(",")}]`);

  for (const xid of body) {
    const nrId = state.nodeRunByDefId.get(xid);
    if (nrId) {
      updateNodeRun(nrId, { status: "pending", verdict: null, iteration: iter, endedAt: null });
      broadcastNode(state.runId, nrId, "pending");
    }
    state.enqueued.delete(xid);
    state.anyTaken.delete(xid);
    // intra-loop 전진 indegree — 루프 안의 간선만 카운트 (back-edge 제외).
    let indeg = 0;
    for (const e of state.def.edges) {
      if (state.backEdgeIds.has(e.id)) continue;
      if (e.to === xid && bodySet.has(e.from)) indeg++;
    }
    state.remaining.set(xid, indeg);
  }
  for (const xid of body) {
    if ((state.remaining.get(xid) ?? 0) === 0 && !state.enqueued.has(xid)) {
      state.enqueued.add(xid);
      state.queue.push(xid);
    }
  }
  pump(state);
}

/** 전진 그래프 위의 도달 가능성 — 각 노드에서 DFS 로 도달 가능한 노드 집합. */
function computeReach(nodes: NodeDef[], edges: EdgeDef[]): Map<string, Set<string>> {
  const adj = new Map<string, string[]>();
  for (const n of nodes) adj.set(n.id, []);
  for (const e of edges) adj.get(e.from)?.push(e.to);
  const reach = new Map<string, Set<string>>();
  for (const n of nodes) {
    const seen = new Set<string>();
    const stack = [...(adj.get(n.id) ?? [])];
    while (stack.length) {
      const cur = stack.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const nx of adj.get(cur) ?? []) if (!seen.has(nx)) stack.push(nx);
    }
    reach.set(n.id, seen);
  }
  return reach;
}

/**
 * 상태 전이 훅 → Discord 알림 (워크플로우 게이트/주의/실패/완료). 전이 함수에서 «1회만»
 * 호출되므로 한 전이당 한 발 (중복 없음). PO run 은 suppressNotify 로 건너뛴다 (po_gate/po_failed
 * 가 따로 쏘므로 이중 발화 방지 — done 도 동일하게 억제). fire-and-forget — dispatch 는 절대
 * throw 하지 않는다. */
function notifyWorkflow(
  state: RunState,
  kind: "workflow_gate" | "workflow_attention" | "workflow_failed" | "workflow_done",
  nodeRunId: string | null,
): void {
  if (state.suppressNotify) return;
  const nodeTitle = nodeRunId ? getNodeRun(nodeRunId)?.title ?? null : null;
  void dispatchWorkflowNotification({
    kind,
    runId: state.runId,
    workflowTitle: state.wfTitle,
    nodeTitle,
    repoPath: state.defRepoPath,
  });
}

/** 노드를 사용자 결정 대기 상태로 둔다 (승인 게이트). 슬롯을 안 잡고 pending 에 핸들러를 등록. */
function gate(state: RunState, nodeRunId: string, handlers: Record<string, () => void>): void {
  updateNodeRun(nodeRunId, { status: "awaiting_approval" });
  broadcastNode(state.runId, nodeRunId, "awaiting_approval");
  state.pending.set(nodeRunId, handlers);
  // 승인 게이트 도달 — 결재류(주황) 알림 1회. 같은 노드는 approve 후 approved 셋이 막아 재진입
  // 안 하므로 게이트 도달마다 정확히 한 발 (run 안 게이트 여러 개면 각 노드별 1회).
  notifyWorkflow(state, "workflow_gate", nodeRunId);
}

/** 노드를 needs_attention 으로 두고 수동 개입(complete/retry) 핸들러를 등록. */
function parkNeedsAttention(
  state: RunState,
  nodeRunId: string,
  handlers: { complete: () => void; retry: () => void },
): void {
  updateNodeRun(nodeRunId, { status: "needs_attention", endedAt: Date.now() });
  broadcastNode(state.runId, nodeRunId, "needs_attention");
  // 수동 개입 필요 — 주의(노랑) 알림 1회. parking 전이당 한 발 (retry 후 다시 멈추면 그건 새 전이).
  notifyWorkflow(state, "workflow_attention", nodeRunId);
  state.pending.set(nodeRunId, {
    complete: () => {
      state.pending.delete(nodeRunId);
      handlers.complete();
      pump(state);
    },
    retry: () => {
      state.pending.delete(nodeRunId);
      handlers.retry();
      pump(state);
    },
  });
}

/**
 * 라우트가 호출 — 대기 중인 노드의 사용자 결정을 적용한다. action ∈
 * approve|reject (승인 게이트) / complete|retry (수동 개입). 매칭되는 핸들러가 있으면 실행.
 */
export function resolveWorkflowDecision(
  runId: string,
  nodeRunId: string,
  action: string,
): boolean {
  const state = runs.get(runId);
  if (!state) return false;
  const handlers = state.pending.get(nodeRunId);
  if (!handlers) return false;
  const h = handlers[action];
  if (!h) return false;
  // approve/reject 는 gate 가 pending 을 안 지웠으니 여기서 지운다 (complete/retry 는 핸들러가 직접 지움).
  if (action === "approve" || action === "reject") state.pending.delete(nodeRunId);
  h();
  return true;
}

/** 한 간선을 해소한다 — 도착 노드의 미해소 incoming 을 1 줄이고, 0 이 되면 실행/skip 결정. */
function resolveEdge(state: RunState, childId: string, taken: boolean): void {
  if (taken) state.anyTaken.add(childId);
  const rem = (state.remaining.get(childId) ?? 1) - 1;
  state.remaining.set(childId, rem);
  if (rem > 0) return;
  if (state.enqueued.has(childId)) return;
  state.enqueued.add(childId);
  if (state.anyTaken.has(childId) && !state.cancelled) {
    state.queue.push(childId);
  } else {
    // 모든 incoming 이 not-taken → 이 노드는 실행 안 함(skip) + 하위로 dead 전파.
    markSkippedAndPropagate(state, childId);
  }
}

/** 도달 못 한 노드를 skipped 로 마킹하고, 그 하위 간선을 전부 not-taken 으로 해소(전파). */
function markSkippedAndPropagate(state: RunState, defId: string): void {
  const nodeRunId = state.nodeRunByDefId.get(defId);
  if (nodeRunId) {
    updateNodeRun(nodeRunId, { status: "skipped", endedAt: Date.now() });
    broadcastNode(state.runId, nodeRunId, "skipped");
  }
  for (const e of childrenOf(state.def.edges, defId)) {
    resolveEdge(state, e.to, false);
  }
}

function maybeFinish(state: RunState): void {
  if (state.finished) return;
  // 사용자 결정 대기(승인/수동개입)가 남아 있으면 끝내지 않는다 — 사용자를 기다린다.
  if (
    state.active > 0 ||
    state.queue.length > 0 ||
    state.dynamicQueue.length > 0 ||
    state.pending.size > 0
  ) {
    return;
  }
  state.finished = true;
  // 도달 못 한(부모가 실패/취소된) 노드 + 미처리 대기 노드는 skipped 로 마감.
  for (const nr of listNodeRuns(state.runId)) {
    if (nr.status === "pending" || nr.status === "awaiting_approval" || nr.status === "needs_attention") {
      updateNodeRun(nr.id, { status: "skipped", endedAt: Date.now() });
      broadcastNode(state.runId, nr.id, "skipped");
    }
  }
  const status = state.cancelled ? "cancelled" : state.anyFailed ? "failed" : "done";
  setRunStatus(state.runId, status, Date.now());
  broadcastRun(state.runId, status);
  // run 마감 알림 1회. finished 가드(상단)가 maybeFinish 재진입을 막아 run 당 정확히 1발.
  //   - failed → 실패(빨강) 알림.
  //   - done   → 완료(초록) 알림 — 무인 함대를 돌려둔 사용자에게 «와서 리뷰/머지하라» 신호.
  //   - cancelled → 무음 (사용자가 스스로 멈춘 의도된 종료라 알릴 게 없다).
  if (status === "failed") notifyWorkflow(state, "workflow_failed", null);
  else if (status === "done") notifyWorkflow(state, "workflow_done", null);
  runs.delete(state.runId);
  console.log(`[workflow] run=${state.runId} finished — ${status}`);
}

// ── helpers ───────────────────────────────────────────────────────────────────

/** 출력 idle 판정 임계 — 이 시간만큼 «새 출력» 이 전혀 없으면 에이전트가 멈춤/완료로 본다.
 *  옛 12초 turn_complete 는 부팅+장고(xhigh effort) 중에 발사돼 에이전트가 result.md 를 쓰기도
 *  전에 턴을 끊어버렸다 — 그래서 훨씬 넉넉히. (스피너/스트리밍이 도는 동안은 출력이 계속 변해
 *  idle 로 안 빠진다.) */
const NODE_IDLE_MS = 90 * 1000;
/** 부팅 동안의 초기 정적을 idle 로 오판하지 않도록 하는 최소 가동 시간. */
const NODE_MIN_RUNTIME_MS = 8 * 1000;
/** result.md 가 처음 보인 뒤 쓰기 마무리를 기다리는 settle. */
const RESULT_SETTLE_MS = 2500;

/**
 * 작업 노드의 «완료» 를 기다린다. 완료 신호의 우선순위:
 *   1) result.md 가 써짐 — 에이전트가 계약을 이행함(가장 신뢰). 잠깐 더 기다려 쓰기 마무리.
 *   2) session_exit(REPL 종료) / error.
 *   3) 출력이 NODE_IDLE_MS 동안 완전히 잠잠 — 에이전트가 멈춤(완료 또는 정지)으로 간주.
 *   4) MAX_NODE_RUNTIME_MS 하드 타임아웃.
 * pty-runner 의 12초 turn_complete 는 더 이상 쓰지 않는다(조기 abort 원인).
 */
function waitForNodeDone(
  sessionId: string,
  repoPath: string,
  folderRel: string,
): Promise<{ status: "ok" | "error" | "timeout" }> {
  return new Promise((resolve) => {
    let settled = false;
    const start = Date.now();
    let lastCount = -1;
    let lastChange = Date.now();
    let resultSeenAt = 0;
    const finish = (status: "ok" | "error" | "timeout") => {
      if (settled) return;
      settled = true;
      ptyEvents.off("session_exit", onExit);
      ptyEvents.off("error", onErr);
      clearInterval(iv);
      clearTimeout(timer);
      resolve({ status });
    };
    const onExit = (e: PtyLifecycleEvent) => {
      if (e.sessionId === sessionId) finish("ok");
    };
    const onErr = (e: PtyLifecycleEvent) => {
      if (e.sessionId === sessionId) finish("error");
    };
    ptyEvents.on("session_exit", onExit);
    ptyEvents.on("error", onErr);
    const iv = setInterval(() => {
      const now = Date.now();
      // 1) result.md — 에이전트가 결과물을 남기면 그게 곧 «완료». 쓰기 마무리를 살짝 더 기다린다.
      if (resultMdExists(repoPath, folderRel)) {
        if (resultSeenAt === 0) resultSeenAt = now;
        else if (now - resultSeenAt >= RESULT_SETTLE_MS) return finish("ok");
        return;
      }
      // 3) 출력 idle — pty_chunk 행 수가 늘면 출력이 흐르는 중(스피너/스트리밍 포함). 안 늘면 잠잠.
      const count = sessionChunkCount(sessionId);
      if (count !== lastCount) {
        lastCount = count;
        lastChange = now;
      }
      if (now - start > NODE_MIN_RUNTIME_MS && now - lastChange > NODE_IDLE_MS) {
        return finish("ok");
      }
    }, 2000);
    const timer = setTimeout(() => finish("timeout"), MAX_NODE_RUNTIME_MS);
  });
}

/** 이 세션의 pty_chunk(출력) 메시지 수 — idle 판정용 싸구려 프록시(늘면 출력이 흐르는 중). */
function sessionChunkCount(sessionId: string): number {
  try {
    const r = db()
      .prepare(`SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND type = 'pty_chunk'`)
      .get(sessionId) as { n: number };
    return r.n;
  } catch {
    return 0;
  }
}

/**
 * 세션의 PTY 출력(messages.pty_chunk)을 읽어 사람이 읽을 수 있는 평문으로 정화한다.
 * 에이전트가 result.md 를 안 남겼을 때 폴백 result.md 본문으로 쓴다 — 터미널 도구나
 * 계약 미준수 에이전트라도 다음 노드가 이전 출력을 이어받을 수 있게 한다. 너무 길면 뒤쪽을 자른다.
 */
function readSessionText(sessionId: string): string {
  let rows: Array<{ payload: string }> = [];
  try {
    rows = db()
      .prepare(
        `SELECT payload FROM messages WHERE session_id = ? AND type = 'pty_chunk' ORDER BY created_at ASC`,
      )
      .all(sessionId) as Array<{ payload: string }>;
  } catch {
    return "";
  }
  const parts: Buffer[] = [];
  for (const r of rows) {
    try {
      const o = JSON.parse(r.payload) as { bytes_b64?: string };
      if (o.bytes_b64) parts.push(Buffer.from(o.bytes_b64, "base64"));
    } catch {
      /* skip */
    }
  }
  let text = Buffer.concat(parts).toString("utf8");
  // ANSI/제어 시퀀스 + TUI 글리프 제거 → 읽을 수 있는 평문 (폴백 result.md 노이즈 최소화).
  text = text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "") // OSC
    .replace(/\x1b[P_^X][^\x1b]*\x1b\\/g, "") // DCS/APC/PM/SOS
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "") // CSI (색/커서)
    .replace(/\x1b[@-Z\\-_]/g, "") // 그 외 escape
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "") // 남은 제어문자(탭/개행 제외)
    .replace(/[─-▟⠀-⣿]/g, "") // box-drawing / blocks / braille 스피너
    .replace(/[ \t]+\n/g, "\n") // 줄 끝 공백
    .replace(/\n{3,}/g, "\n\n"); // 빈 줄 과다 축소
  const MAX = 200_000;
  if (text.length > MAX) text = "…(앞부분 생략)…\n" + text.slice(text.length - MAX);
  return text.trim();
}

function markSessionEnded(sessionId: string, status: "completed" | "error"): void {
  db()
    .prepare(`UPDATE sessions SET status = ?, ended_at = ? WHERE id = ?`)
    .run(status, Date.now(), sessionId);
}

function broadcastNode(runId: string, nodeRunId: string, status: string): void {
  broadcastAll({ type: "workflow_event", kind: "node_status", runId, nodeRunId, status });
}

function broadcastRun(runId: string, status: string): void {
  broadcastAll({ type: "workflow_event", kind: "run_status", runId, status });
}
