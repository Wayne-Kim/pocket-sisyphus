/**
 * workflow/engine 상태 전이 → notify 디스패치 통합 테스트.
 *
 * 검증 (브리프 수용 기준):
 *  - awaiting_approval(승인 게이트) 진입 → workflow_gate 1회 (본문에 워크플로우명·노드명).
 *  - needs_attention 진입 → workflow_attention 1회.
 *  - run failed 마감 → workflow_failed 1회 (done 은 안 옴).
 *  - run done(성공) 마감 → workflow_done 1회 (failed/attention 은 안 옴).
 *  - cancelled(사용자가 스스로 멈춤) 마감 → 완료/실패 알림 0건 (의도된 종료라 무음).
 *  - 같은 전이당 중복 미발화 (게이트는 1회, 실패/주의/완료도 1회).
 *  - PO run (suppressNotify) 은 엔진 알림을 안 쏜다 (po_gate/po_failed 와 이중 발화 방지) — done 도 무음.
 *  - 재시작 reconcile(running→failed) 도 failed 알림 1회.
 *
 * 격리: cron.test.ts 와 동일 패턴 — config 를 tmp DB 로 mock, pty-runner 를 mock(진짜
 * ptyEvents EventEmitter 로 settle 구동), notify/index 를 mock(Discord POST 차단 + dispatch
 * 호출 단언). task-folder 는 harvestTaskFolder 만 부분 mock 해 needs_attention 을 주입한다.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import fs from "node:fs";

const H = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fsH = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const osH = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pathH = require("node:path") as typeof import("node:path");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require("node:events") as typeof import("node:events");
  const dir = fsH.mkdtempSync(pathH.join(osH.tmpdir(), "ps-wfengine-test-"));
  return {
    tmpDir: dir,
    configFile: pathH.join(dir, "config.json"),
    dbFile: pathH.join(dir, "test.db"),
    repoDir: fsH.mkdtempSync(pathH.join(osH.tmpdir(), "ps-wfengine-repo-")),
    ptyEvents: new EventEmitter(),
    /** runUserMessagePty 가 받은 sessionId (테스트가 ptyEvents 를 어디로 쏠지 알아야 함). */
    startedSessions: [] as string[],
    /** dispatchWorkflowNotification 호출 단언 핸들. ev 는 { kind, runId, workflowTitle, … }. */
    notifyMock: vi.fn(async (_ev: { kind: string; runId: string; [k: string]: unknown }) => {}),
    /** harvestTaskFolder 부분 mock — needs_attention 주입 (실제 기본값은 beforeEach 가 세팅). */
    harvestMock: vi.fn(async (_repoPath: string, _rel: string) => ({
      resultMd: null as string | null,
      done: false,
      verdictPass: null as boolean | null,
      branches: null,
      needsAttention: false,
    })),
  };
});

vi.mock("../config.js", () => ({
  CONFIG_DIR: H.tmpDir,
  CONFIG_FILE: H.configFile,
  DB_FILE: H.dbFile,
  ensureConfigDir: () => fs.mkdirSync(H.tmpDir, { recursive: true }),
  readConfig: () => {
    try {
      return JSON.parse(fs.readFileSync(H.configFile, "utf8"));
    } catch {
      return null;
    }
  },
  writeConfig: (cfg: unknown) => {
    fs.writeFileSync(H.configFile, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  },
}));

// 실제 PTY spawn 차단. ptyEvents 는 진짜 EventEmitter — 테스트가 session_exit/error 를 쏴
// waitForNodeDone 의 settle 을 구동한다. runUserMessagePty 는 받은 sessionId 만 기록한다.
vi.mock("../agent/pty-runner.js", () => ({
  ptyEvents: H.ptyEvents,
  isPtyActive: vi.fn(() => false),
  runUserMessagePty: vi.fn(async (opts: { sessionId: string }) => {
    H.startedSessions.push(opts.sessionId);
  }),
  runTerminalScriptPty: vi.fn(() => {}),
  abortPtySession: vi.fn(() => true),
  awaitPtyExit: vi.fn(async () => {}),
  prewarmPty: vi.fn(),
  resizePty: vi.fn(() => false),
  writePtyRaw: vi.fn(() => false),
  sendPtyKey: vi.fn(),
  emitSpawnFailure: vi.fn(),
}));

// Discord POST 차단 + dispatch 호출 단언. dispatchWorkflowNotification 이 핵심 단언 대상.
vi.mock("../notify/index.js", () => ({
  dispatchNotification: vi.fn(async () => {}),
  dispatchCronNotification: vi.fn(async () => {}),
  dispatchPoNotification: vi.fn(async () => {}),
  dispatchPoWorkflowNotification: vi.fn(async () => {}),
  dispatchWorkflowNotification: H.notifyMock,
  dispatchTestNotification: vi.fn(async () => ({ ok: true, status: 200 })),
  eventEnabled: vi.fn(() => true),
}));

// harvestTaskFolder 만 부분 mock — 나머지(ensureTaskFolder/writeRunManifest/resultMdExists…)는
// 진짜를 써서 tmp repo 폴더에 실제로 쓴다. harvest 결과로 done/needs_attention 을 제어한다.
vi.mock("../workflow/task-folder.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../workflow/task-folder.js")>();
  return { ...actual, harvestTaskFolder: H.harvestMock };
});

const { db, _resetDbForTest } = await import("../db/index.js");
const { hashToken, invalidateAuthCache } = await import("../auth.js");
const { registerBuiltinAgents } = await import("../agent/index.js");
const { insertWorkflow, insertRun, getRun, listNodeRuns } = await import("../workflow/store.js");
const { startWorkflowRun, cancelWorkflowRun, resolveWorkflowDecision, reconcileStaleRuns } =
  await import("../workflow/engine.js");

type RawNode = Record<string, unknown>;
type RawEdge = Record<string, unknown>;

const DONE_HARVEST = {
  resultMd: "# ok\n",
  done: true,
  verdictPass: null,
  branches: null,
  needsAttention: false,
};

const TASK_NODES: RawNode[] = [
  { id: "start", type: "start", title: "시작", x: 0, y: 0 },
  { id: "task", type: "task", title: "작업", prompt: "일해라", skip_permissions: true, x: 0, y: 100 },
  { id: "end", type: "end", title: "종료", x: 0, y: 200 },
];
const TASK_EDGES: RawEdge[] = [
  { id: "e1", from: "start", to: "task" },
  { id: "e2", from: "task", to: "end" },
];

const GATE_NODES: RawNode[] = [
  { id: "start", type: "start", title: "시작", x: 0, y: 0 },
  {
    id: "gate",
    type: "task",
    title: "머지 승인 게이트",
    prompt: "검토 후 머지",
    requires_approval: true,
    skip_permissions: true,
    x: 0,
    y: 100,
  },
  { id: "end", type: "end", title: "종료", x: 0, y: 200 },
];
const GATE_EDGES: RawEdge[] = [
  { id: "e1", from: "start", to: "gate" },
  { id: "e2", from: "gate", to: "end" },
];

function makeWorkflow(nodes: RawNode[], edges: RawEdge[]) {
  return insertWorkflow({
    title: "Fleet WF",
    repoPath: H.repoDir,
    nodes: JSON.stringify(nodes),
    edges: JSON.stringify(edges),
    enabled: true,
  });
}

function runIdOf(res: { runId: string } | { error: string }): string {
  expect("runId" in res, "error" in res ? (res as { error: string }).error : "").toBe(true);
  return (res as { runId: string }).runId;
}

async function waitUntil(cond: () => boolean, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return cond();
}

function notifyKinds(): string[] {
  return H.notifyMock.mock.calls.map((c) => (c[0] as { kind: string }).kind);
}

beforeAll(() => {
  registerBuiltinAgents();
  fs.writeFileSync(
    H.configFile,
    JSON.stringify({ port: 7777, tokenHash: hashToken("t"), createdAt: Date.now() }),
    { mode: 0o600 },
  );
  invalidateAuthCache();
});

beforeEach(() => {
  _resetDbForTest();
  for (const ext of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(H.dbFile + ext);
    } catch {
      /* not exists */
    }
  }
  H.startedSessions.length = 0;
  H.notifyMock.mockClear();
  H.harvestMock.mockReset();
  H.harvestMock.mockResolvedValue({ ...DONE_HARVEST });
});

afterAll(() => {
  _resetDbForTest();
  try {
    fs.rmSync(H.tmpDir, { recursive: true, force: true });
    fs.rmSync(H.repoDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe("승인 게이트(awaiting_approval) → workflow_gate", () => {
  it("requires_approval 노드 도달 시 주황 결재 알림 1회 + 워크플로우명·노드명", () => {
    const wf = makeWorkflow(GATE_NODES, GATE_EDGES);
    const runId = runIdOf(startWorkflowRun(wf, "manual"));

    // gate() 는 pump 안에서 동기 발화 — 세션을 안 띄우고(슬롯 미점유) 즉시 알림.
    expect(H.notifyMock).toHaveBeenCalledTimes(1);
    expect(H.startedSessions).toHaveLength(0);
    expect(H.notifyMock.mock.calls[0][0]).toMatchObject({
      kind: "workflow_gate",
      runId,
      workflowTitle: "Fleet WF",
      nodeTitle: "머지 승인 게이트",
      repoPath: H.repoDir,
    });

    // 중복 미발화 — 더 이상 전이가 없으면 재발화하지 않는다 (cancel 은 cancelled 라 무알림).
    cancelWorkflowRun(runId);
    expect(H.notifyMock).toHaveBeenCalledTimes(1);
  });

  it("approve 해도 게이트 재발화 없음 (approved 셋이 재게이트 차단)", async () => {
    const wf = makeWorkflow(GATE_NODES, GATE_EDGES);
    const runId = runIdOf(startWorkflowRun(wf, "manual"));
    expect(H.notifyMock).toHaveBeenCalledTimes(1);

    const gateNr = listNodeRuns(runId).find((n) => n.def_node_id === "gate")!;
    expect(gateNr.status).toBe("awaiting_approval");

    // 승인 → 게이트 노드가 실제 실행에 들어간다 (세션 1개). harvest 는 기본 done.
    expect(resolveWorkflowDecision(runId, gateNr.id, "approve")).toBe(true);
    expect(await waitUntil(() => H.startedSessions.length > 0)).toBe(true);
    H.ptyEvents.emit("session_exit", { sessionId: H.startedSessions[0] });
    expect(await waitUntil(() => getRun(runId)?.status === "done")).toBe(true);

    // 게이트 알림은 여전히 1회 (approve 가 두 번째를 만들지 않는다). 성공 마감이라 failed 는 없고,
    // done 완료 알림 1발이 뒤따른다 — 게이트 통과 후 성공한 run 도 «완료» 신호를 받는다.
    expect(notifyKinds()).toEqual(["workflow_gate", "workflow_done"]);
  });
});

describe("needs_attention → workflow_attention", () => {
  it(".needs-attention harvest → 주의 알림 1회 + run 은 parked(미실패)", async () => {
    H.harvestMock.mockResolvedValueOnce({
      resultMd: null,
      done: false,
      verdictPass: null,
      branches: null,
      needsAttention: true,
    });
    const wf = makeWorkflow(TASK_NODES, TASK_EDGES);
    const runId = runIdOf(startWorkflowRun(wf, "manual"));

    expect(await waitUntil(() => H.startedSessions.length > 0)).toBe(true);
    H.ptyEvents.emit("session_exit", { sessionId: H.startedSessions[0] });

    expect(await waitUntil(() => notifyKinds().includes("workflow_attention"))).toBe(true);
    const attn = H.notifyMock.mock.calls.filter((c) => (c[0] as { kind: string }).kind === "workflow_attention");
    expect(attn).toHaveLength(1);
    expect(attn[0][0]).toMatchObject({ kind: "workflow_attention", runId, nodeTitle: "작업" });

    // parked — failed 알림은 없고 노드 상태는 needs_attention.
    expect(notifyKinds()).not.toContain("workflow_failed");
    expect(listNodeRuns(runId).find((n) => n.def_node_id === "task")?.status).toBe("needs_attention");

    cancelWorkflowRun(runId);
  });
});

describe("run failed → workflow_failed", () => {
  it("노드 세션 에러로 run 이 failed 마감되면 빨강 실패 알림 1회", async () => {
    const wf = makeWorkflow(TASK_NODES, TASK_EDGES);
    const runId = runIdOf(startWorkflowRun(wf, "manual"));

    expect(await waitUntil(() => H.startedSessions.length > 0)).toBe(true);
    H.ptyEvents.emit("error", { sessionId: H.startedSessions[0] });

    expect(await waitUntil(() => notifyKinds().includes("workflow_failed"))).toBe(true);
    const failed = H.notifyMock.mock.calls.filter((c) => (c[0] as { kind: string }).kind === "workflow_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0][0]).toMatchObject({ kind: "workflow_failed", runId, workflowTitle: "Fleet WF" });
    expect(getRun(runId)?.status).toBe("failed");
    // 실패 run 에는 완료(done) 알림이 섞이지 않는다 — failed/done 은 상호 배타 분기.
    expect(notifyKinds()).not.toContain("workflow_done");
  });
});

describe("run done(성공) → workflow_done", () => {
  it("게이트/주의 없이 끝까지 성공하면 초록 완료 알림 1회 + failed/attention 없음", async () => {
    const wf = makeWorkflow(TASK_NODES, TASK_EDGES);
    const runId = runIdOf(startWorkflowRun(wf, "manual"));

    expect(await waitUntil(() => H.startedSessions.length > 0)).toBe(true);
    H.ptyEvents.emit("session_exit", { sessionId: H.startedSessions[0] });
    expect(await waitUntil(() => getRun(runId)?.status === "done")).toBe(true);

    // 완료 알림 정확히 1발, 본문에 워크플로우명. 게이트/주의/실패는 전혀 없다.
    const done = H.notifyMock.mock.calls.filter((c) => (c[0] as { kind: string }).kind === "workflow_done");
    expect(done).toHaveLength(1);
    expect(done[0][0]).toMatchObject({ kind: "workflow_done", runId, workflowTitle: "Fleet WF", repoPath: H.repoDir });
    expect(notifyKinds()).toEqual(["workflow_done"]);
  });

  it("일부 노드가 skip 됐어도 실패 노드가 없으면 done → 완료 알림 발사", async () => {
    // start→task→end 의 단순 그래프지만, harvest done(verdict 없음)으로 정상 성공 → status done.
    // (skip 경로의 핵심: anyFailed=false 면 done — 별도 skip 노드 없이도 동일 분기를 탄다.)
    const wf = makeWorkflow(TASK_NODES, TASK_EDGES);
    const runId = runIdOf(startWorkflowRun(wf, "manual"));
    expect(await waitUntil(() => H.startedSessions.length > 0)).toBe(true);
    H.ptyEvents.emit("session_exit", { sessionId: H.startedSessions[0] });
    expect(await waitUntil(() => getRun(runId)?.status === "done")).toBe(true);
    expect(notifyKinds()).toContain("workflow_done");
    expect(notifyKinds()).not.toContain("workflow_failed");
  });
});

describe("cancelled → 완료/실패 알림 없음", () => {
  it("사용자가 게이트 대기 run 을 취소하면 done/failed 어느 쪽도 안 온다 (의도된 종료)", () => {
    const wf = makeWorkflow(GATE_NODES, GATE_EDGES);
    const runId = runIdOf(startWorkflowRun(wf, "manual"));
    // 게이트 도달 알림 1회 (워크플로우 정상 동작).
    expect(notifyKinds()).toEqual(["workflow_gate"]);

    cancelWorkflowRun(runId);
    expect(getRun(runId)?.status).toBe("cancelled");
    // 취소는 무음 — 새 알림(done/failed)이 추가되지 않는다.
    expect(notifyKinds()).toEqual(["workflow_gate"]);
    expect(notifyKinds()).not.toContain("workflow_done");
    expect(notifyKinds()).not.toContain("workflow_failed");
  });
});

describe("PO run 이중 발화 방지 (suppressNotify)", () => {
  it("suppressNotify=true 면 게이트 도달에도 엔진 알림을 안 쏜다", () => {
    const wf = makeWorkflow(GATE_NODES, GATE_EDGES);
    const runId = runIdOf(startWorkflowRun(wf, "manual", { suppressNotify: true }));
    // gate 동기 발화 시점에 이미 호출됐어야 정상인데, suppress 라 0건.
    expect(H.notifyMock).not.toHaveBeenCalled();
    expect(listNodeRuns(runId).find((n) => n.def_node_id === "gate")?.status).toBe("awaiting_approval");
    cancelWorkflowRun(runId);
  });

  it("suppressNotify=true run 의 세션 에러 실패에도 알림 0건", async () => {
    const wf = makeWorkflow(TASK_NODES, TASK_EDGES);
    const runId = runIdOf(startWorkflowRun(wf, "manual", { suppressNotify: true }));
    expect(await waitUntil(() => H.startedSessions.length > 0)).toBe(true);
    H.ptyEvents.emit("error", { sessionId: H.startedSessions[0] });
    expect(await waitUntil(() => getRun(runId)?.status === "failed")).toBe(true);
    expect(H.notifyMock).not.toHaveBeenCalled();
  });

  it("suppressNotify=true run 이 성공(done) 마감돼도 완료 알림 0건 (PO 가 따로 쏨)", async () => {
    const wf = makeWorkflow(TASK_NODES, TASK_EDGES);
    const runId = runIdOf(startWorkflowRun(wf, "manual", { suppressNotify: true }));
    expect(await waitUntil(() => H.startedSessions.length > 0)).toBe(true);
    H.ptyEvents.emit("session_exit", { sessionId: H.startedSessions[0] });
    expect(await waitUntil(() => getRun(runId)?.status === "done")).toBe(true);
    expect(H.notifyMock).not.toHaveBeenCalled();
  });
});

describe("재시작 reconcile(running→failed) → workflow_failed", () => {
  it("in-memory 상태 없는 stale running run 을 failed 로 정리하며 실패 알림 1회", () => {
    const wf = makeWorkflow(TASK_NODES, TASK_EDGES);
    // startWorkflowRun 을 안 거치고 running run 만 만든다 = «재시작으로 상태 잃은» 상황 재현.
    const run = insertRun(wf.id, JSON.stringify({ nodes: TASK_NODES, edges: TASK_EDGES }), "manual");
    expect(getRun(run.id)?.status).toBe("running");

    reconcileStaleRuns();

    expect(getRun(run.id)?.status).toBe("failed");
    const failed = H.notifyMock.mock.calls.filter(
      (c) => (c[0] as { kind: string; runId: string }).kind === "workflow_failed" && (c[0] as { runId: string }).runId === run.id,
    );
    expect(failed).toHaveLength(1);
    expect(failed[0][0]).toMatchObject({ kind: "workflow_failed", runId: run.id, workflowTitle: "Fleet WF" });
  });
});
