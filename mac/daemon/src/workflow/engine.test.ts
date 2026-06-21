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
    /** runUserMessagePty 가 받은 (sessionId, prompt) — 루프 재시도 프롬프트 단언용. */
    startedPrompts: [] as { sessionId: string; prompt: string }[],
    /** dispatchWorkflowNotification 호출 단언 핸들. ev 는 { kind, runId, workflowTitle, … }. */
    notifyMock: vi.fn(async (_ev: { kind: string; runId: string; [k: string]: unknown }) => {}),
    /** harvestTaskFolder 부분 mock — needs_attention 주입 (실제 기본값은 beforeEach 가 세팅). */
    harvestMock: vi.fn(async (_repoPath: string, _rel: string) => ({
      resultMd: null as string | null,
      done: false,
      verdictPass: null as boolean | null,
      verdictSummary: null as string | null,
      branches: null,
      needsAttention: false,
    })),
    /** abortPtySession/awaitPtyExit mock — 회귀 테스트가 throw 주입에 쓴다. */
    abortPtySessionMock: vi.fn((_sessionId: string) => true),
    awaitPtyExitMock: vi.fn(async (_sessionId: string, _ms?: number) => {}),
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
  runUserMessagePty: vi.fn(async (opts: { sessionId: string }, prompt: string) => {
    H.startedSessions.push(opts.sessionId);
    H.startedPrompts.push({ sessionId: opts.sessionId, prompt });
  }),
  runTerminalScriptPty: vi.fn(() => {}),
  abortPtySession: H.abortPtySessionMock,
  awaitPtyExit: H.awaitPtyExitMock,
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
const { insertWorkflow, insertRun, getRun, listNodeRuns, listUnackedAttentionRuns, ackRunAttention } = await import("../workflow/store.js");
const { startWorkflowRun, cancelWorkflowRun, resolveWorkflowDecision, reconcileStaleRuns, activeRunWorktreePaths } =
  await import("../workflow/engine.js");

type RawNode = Record<string, unknown>;
type RawEdge = Record<string, unknown>;

const DONE_HARVEST = {
  resultMd: "# ok\n",
  done: true,
  verdictPass: null,
  verdictSummary: null,
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
  H.startedPrompts.length = 0;
  H.notifyMock.mockClear();
  H.abortPtySessionMock.mockReset();
  H.abortPtySessionMock.mockReturnValue(true);
  H.awaitPtyExitMock.mockReset();
  H.awaitPtyExitMock.mockResolvedValue(undefined);
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
      verdictSummary: null,
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

describe("정리 누수 회귀 — awaitPtyExit throw 시 activeSessions 비움", () => {
  // 병렬 분기: start → task(정리 중 throw) + start → gate(parked 로 run 을 살려둔다).
  // task 의 awaitPtyExit 가 throw 해도 finally 에서 activeSessions.delete 가 돌아,
  // reaper 의 시야(activeRunWorktreePaths)에 누수 세션 경로가 남지 않아야 한다.
  const LEAK_NODES: RawNode[] = [
    { id: "start", type: "start", title: "시작", x: 0, y: 0 },
    { id: "task", type: "task", title: "작업", prompt: "일해라", skip_permissions: true, x: -100, y: 100 },
    { id: "gate", type: "task", title: "게이트", prompt: "검토", requires_approval: true, skip_permissions: true, x: 100, y: 100 },
    { id: "end", type: "end", title: "종료", x: 0, y: 200 },
  ];
  const LEAK_EDGES: RawEdge[] = [
    { id: "e1", from: "start", to: "task" },
    { id: "e2", from: "start", to: "gate" },
    { id: "e3", from: "task", to: "end" },
    { id: "e4", from: "gate", to: "end" },
  ];

  it("awaitPtyExit 가 throw 해도 누수 세션 경로가 reaper 시야에 남지 않는다", async () => {
    H.awaitPtyExitMock.mockRejectedValueOnce(new Error("awaitPtyExit boom"));
    const wf = makeWorkflow(LEAK_NODES, LEAK_EDGES);
    const runId = runIdOf(startWorkflowRun(wf, "manual"));

    // task 세션이 떴고, gate 는 parked(awaiting_approval) 로 run 을 살려둔다.
    expect(await waitUntil(() => H.startedSessions.length > 0)).toBe(true);
    expect(await waitUntil(() => listNodeRuns(runId).find((n) => n.def_node_id === "gate")?.status === "awaiting_approval")).toBe(true);
    expect(activeRunWorktreePaths()).toContain(H.repoDir);

    // task 세션 종료 → settle 해소 → 정리 중 awaitPtyExit throw.
    H.ptyEvents.emit("session_exit", { sessionId: H.startedSessions[0] });

    // throw 가 흡수돼 task 는 failed 로 마감.
    expect(await waitUntil(() => listNodeRuns(runId).find((n) => n.def_node_id === "task")?.status === "failed")).toBe(true);

    // 핵심: 정리(finally)가 항상 돌아 activeSessions 에 누수 세션이 안 남는다.
    // run 은 gate 로 아직 살아있지만, 활성 세션이 없으니 reaper 보호 경로도 비어야 한다.
    expect(activeRunWorktreePaths()).not.toContain(H.repoDir);

    cancelWorkflowRun(runId);
  });

  it("abortPtySession 이 throw 해도 동일하게 정리된다", async () => {
    H.abortPtySessionMock.mockImplementationOnce(() => {
      throw new Error("abortPtySession boom");
    });
    const wf = makeWorkflow(LEAK_NODES, LEAK_EDGES);
    const runId = runIdOf(startWorkflowRun(wf, "manual"));

    expect(await waitUntil(() => H.startedSessions.length > 0)).toBe(true);
    expect(await waitUntil(() => listNodeRuns(runId).find((n) => n.def_node_id === "gate")?.status === "awaiting_approval")).toBe(true);

    H.ptyEvents.emit("session_exit", { sessionId: H.startedSessions[0] });

    expect(await waitUntil(() => listNodeRuns(runId).find((n) => n.def_node_id === "task")?.status === "failed")).toBe(true);
    expect(activeRunWorktreePaths()).not.toContain(H.repoDir);

    cancelWorkflowRun(runId);
  });
});

describe("fail 루프 가시성 — iteration·loopback_reason·limit_reached", () => {
  // start → A(준비) → B(검사); B fail → A (back-edge). B 가 fail 판정이면 루프 반복.
  const LOOP_NODES: RawNode[] = [
    { id: "start", type: "start", title: "시작", x: 0, y: 0 },
    { id: "A", type: "task", title: "준비", prompt: "준비해라", skip_permissions: true, x: 0, y: 100 },
    { id: "B", type: "task", title: "검사", prompt: "검사해라", skip_permissions: true, x: 0, y: 200 },
    { id: "end", type: "end", title: "종료", x: 0, y: 300 },
  ];
  const LOOP_EDGES: RawEdge[] = [
    { id: "e1", from: "start", to: "A" },
    { id: "e2", from: "A", to: "B" },
    { id: "e3", from: "B", to: "end" },
    { id: "e4", from: "B", to: "A", condition: "fail" }, // back-edge
  ];

  // 새로 뜬 세션마다 session_exit 를 쏴 settle 시키며 run 이 terminal 될 때까지 구동한다.
  async function drive(runId: string): Promise<void> {
    const emitted = new Set<string>();
    for (let i = 0; i < 200; i++) {
      for (const s of [...H.startedSessions]) {
        if (!emitted.has(s)) {
          emitted.add(s);
          H.ptyEvents.emit("session_exit", { sessionId: s });
        }
      }
      const st = getRun(runId)?.status;
      if (st === "done" || st === "failed" || st === "cancelled") return;
      await new Promise((r) => setTimeout(r, 15));
    }
  }

  it("한 번 fail→루프 후 통과: 재시도 노드에 iteration=1 + 되돌아간 사유", async () => {
    let bSeen = 0;
    H.harvestMock.mockImplementation(async (_repo: string, rel: string) => {
      if (rel.includes("검사")) {
        bSeen++;
        if (bSeen === 1) {
          // 첫 검사 = fail + 사유 → 루프 1회.
          return { resultMd: "# r\n", done: true, verdictPass: false, verdictSummary: "테스트 2건 실패", branches: null, needsAttention: false };
        }
        return { ...DONE_HARVEST, verdictPass: true }; // 둘째 검사 = 통과.
      }
      return { ...DONE_HARVEST };
    });

    const wf = makeWorkflow(LOOP_NODES, LOOP_EDGES);
    const runId = runIdOf(startWorkflowRun(wf, "manual"));
    await drive(runId);

    expect(getRun(runId)?.status).toBe("done");
    const nodes = listNodeRuns(runId);
    const a = nodes.find((n) => n.def_node_id === "A")!;
    const b = nodes.find((n) => n.def_node_id === "B")!;
    // 루프 몸통(A·B) 둘 다 1회 재시도 + 사유가 실린다.
    expect(a.iteration).toBe(1);
    expect(b.iteration).toBe(1);
    expect(b.loopback_reason).toBe("테스트 2건 실패");
    expect(a.loopback_reason).toBe("테스트 2건 실패");
    // 통과로 끝났으니 한도 도달 아님.
    expect(b.limit_reached).toBe(0);
  });

  it("끝내 통과 못 하면 MAX_ITERATIONS 에서 멈추고 limit_reached + run failed", async () => {
    H.harvestMock.mockImplementation(async (_repo: string, rel: string) => {
      if (rel.includes("검사")) {
        return { resultMd: "# r\n", done: true, verdictPass: false, verdictSummary: "여전히 실패", branches: null, needsAttention: false };
      }
      return { ...DONE_HARVEST };
    });

    const wf = makeWorkflow(LOOP_NODES, LOOP_EDGES);
    const runId = runIdOf(startWorkflowRun(wf, "manual"));
    await drive(runId);

    expect(getRun(runId)?.status).toBe("failed");
    const b = listNodeRuns(runId).find((n) => n.def_node_id === "B")!;
    // MAX_ITERATIONS(10) 까지 돌고 한도 도달 표식 + 마지막 사유.
    expect(b.iteration).toBe(10);
    expect(b.limit_reached).toBe(1);
    expect(b.loopback_reason).toBe("여전히 실패");
    expect(notifyKinds()).toContain("workflow_failed");
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

describe("합성본 표식 + 미해결 표면화 (workflow_attention_v1)", () => {
  // pty_chunk 한 줄을 세션에 박아 readSessionText 가 «캡처 출력» 을 보게 한다 (합성본/synthetic 경로).
  function seedPtyChunk(sessionId: string, text: string) {
    db()
      .prepare(
        `INSERT INTO messages (id, session_id, role, type, payload, created_at) VALUES (?, ?, 'assistant', 'pty_chunk', ?, ?)`,
      )
      .run(
        `m-${Math.random().toString(36).slice(2)}`,
        sessionId,
        JSON.stringify({ bytes_b64: Buffer.from(text, "utf8").toString("base64") }),
        Date.now(),
      );
  }

  it("에이전트가 result.md 를 직접 남기면 result_kind='agent' + 정상 run 엔 미해결 신호 없음", async () => {
    const wf = makeWorkflow(TASK_NODES, TASK_EDGES);
    const runId = runIdOf(startWorkflowRun(wf, "manual"));
    expect(await waitUntil(() => H.startedSessions.length > 0)).toBe(true);
    H.ptyEvents.emit("session_exit", { sessionId: H.startedSessions[0] });
    expect(await waitUntil(() => getRun(runId)?.status === "done")).toBe(true);

    const task = listNodeRuns(runId).find((n) => n.def_node_id === "task");
    expect(task?.result_kind).toBe("agent");
    expect(getRun(runId)?.attention_kind).toBeNull();
  });

  it("result.md 없고 캡처 출력 있으면 result_kind='synthetic' + run attention='synthetic'", async () => {
    H.harvestMock.mockResolvedValue({ ...DONE_HARVEST, resultMd: null });
    const wf = makeWorkflow(TASK_NODES, TASK_EDGES);
    const runId = runIdOf(startWorkflowRun(wf, "cron"));
    expect(await waitUntil(() => H.startedSessions.length > 0)).toBe(true);
    seedPtyChunk(H.startedSessions[0], "프롬프트가 타이핑되는 화면…");
    H.ptyEvents.emit("session_exit", { sessionId: H.startedSessions[0] });
    expect(await waitUntil(() => getRun(runId)?.status === "done")).toBe(true);

    const task = listNodeRuns(runId).find((n) => n.def_node_id === "task");
    expect(task?.result_kind).toBe("synthetic");
    expect(getRun(runId)?.attention_kind).toBe("synthetic");
  });

  it("result.md 없고 캡처도 비면 result_kind='empty' + run attention='empty' (빈 결과 더 강하게)", async () => {
    H.harvestMock.mockResolvedValue({ ...DONE_HARVEST, resultMd: null });
    const wf = makeWorkflow(TASK_NODES, TASK_EDGES);
    const runId = runIdOf(startWorkflowRun(wf, "cron"));
    expect(await waitUntil(() => H.startedSessions.length > 0)).toBe(true);
    H.ptyEvents.emit("session_exit", { sessionId: H.startedSessions[0] });
    expect(await waitUntil(() => getRun(runId)?.status === "done")).toBe(true);

    const task = listNodeRuns(runId).find((n) => n.def_node_id === "task");
    expect(task?.result_kind).toBe("empty");
    expect(getRun(runId)?.attention_kind).toBe("empty");
  });

  it("무인(cron) 미해결만 집계되고, 수동(manual) 빈 결과는 집계에서 빠진다", async () => {
    H.harvestMock.mockResolvedValue({ ...DONE_HARVEST, resultMd: null });
    const wf = makeWorkflow(TASK_NODES, TASK_EDGES);

    const manualRun = runIdOf(startWorkflowRun(wf, "manual"));
    expect(await waitUntil(() => H.startedSessions.length > 0)).toBe(true);
    H.ptyEvents.emit("session_exit", { sessionId: H.startedSessions[0] });
    expect(await waitUntil(() => getRun(manualRun)?.status === "done")).toBe(true);

    const cronRun = runIdOf(startWorkflowRun(wf, "cron"));
    expect(await waitUntil(() => H.startedSessions.length > 1)).toBe(true);
    H.ptyEvents.emit("session_exit", { sessionId: H.startedSessions[1] });
    expect(await waitUntil(() => getRun(cronRun)?.status === "done")).toBe(true);

    const unacked = listUnackedAttentionRuns();
    const ids = unacked.map((r) => r.id);
    expect(ids).toContain(cronRun);
    expect(ids).not.toContain(manualRun);

    // 확인(ack)하면 집계에서 사라진다 (거짓 경보 방지·중복 누적 방지).
    expect(ackRunAttention(cronRun)).toBe(true);
    expect(listUnackedAttentionRuns().map((r) => r.id)).not.toContain(cronRun);
  });

  it("연달아 실패한 예약 실행은 마지막 1건만 덮어쓰지 않고 모두 누적 집계된다", async () => {
    const wf = makeWorkflow(TASK_NODES, TASK_EDGES);
    const failed: string[] = [];
    for (let i = 0; i < 3; i++) {
      const runId = runIdOf(startWorkflowRun(wf, "cron"));
      expect(await waitUntil(() => H.startedSessions.length > i)).toBe(true);
      H.ptyEvents.emit("error", { sessionId: H.startedSessions[i] });
      expect(await waitUntil(() => getRun(runId)?.status === "failed")).toBe(true);
      failed.push(runId);
    }
    const ids = listUnackedAttentionRuns().map((r) => r.id);
    for (const rid of failed) expect(ids).toContain(rid);
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

// 점검 fail 루프 — 되돌아온 작업의 «재시도» 프롬프트에 직전 점검의 실패 사유가 먹여지는지 (자기교정).
const LOOP_NODES: RawNode[] = [
  { id: "start", type: "start", title: "시작", x: 0, y: 0 },
  { id: "work", type: "task", title: "작업노드", prompt: "기능을 구현하라", skip_permissions: true, x: 0, y: 100 },
  { id: "check", type: "task", title: "점검", prompt: "테스트를 돌려라", skip_permissions: true, x: 0, y: 200 },
  { id: "end", type: "end", title: "종료", x: 0, y: 300 },
];
const LOOP_EDGES: RawEdge[] = [
  { id: "e1", from: "start", to: "work" },
  { id: "e2", from: "work", to: "check" },
  { id: "e3", from: "check", to: "work", condition: "fail" }, // back-edge (루프)
  { id: "e4", from: "check", to: "end" }, // 통과 시 진행
];

describe("루프 재시도 → 실패 사유 먹인 재시도(자기교정)", () => {
  it("2회차 작업 프롬프트에 1회차 점검 실패 사유가 포함된다 (첫 시도엔 없음)", async () => {
    // 점검 노드: 1회차 fail(사유 첨부) → 루프, 2회차 pass → 종료. 작업 노드: 항상 done.
    const FAIL_REASON = "테스트 2건 실패: 경계값에서 null 반환";
    let checkCalls = 0;
    H.harvestMock.mockImplementation(async (_repo: string, rel: string) => {
      if (rel.includes("점검")) {
        checkCalls++;
        return checkCalls === 1
          ? { ...DONE_HARVEST, verdictPass: false, verdictSummary: FAIL_REASON }
          : { ...DONE_HARVEST, verdictPass: true };
      }
      return { ...DONE_HARVEST };
    });

    const wf = makeWorkflow(LOOP_NODES, LOOP_EDGES);
    const runId = runIdOf(startWorkflowRun(wf, "manual"));

    // 새 세션이 뜰 때마다 settle(session_exit) 시켜 체인을 진행 — run 이 끝날 때까지.
    let settled = 0;
    const done = await waitUntil(() => {
      while (settled < H.startedSessions.length) {
        H.ptyEvents.emit("session_exit", { sessionId: H.startedSessions[settled] });
        settled++;
      }
      return getRun(runId)?.status === "done";
    }, 5000);
    expect(done).toBe(true);

    // 작업노드 프롬프트만 추린다 (점검 프롬프트 제외) — 순서대로 1회차·2회차.
    const workPrompts = H.startedPrompts.filter((p) => p.prompt.includes("기능을 구현하라")).map((p) => p.prompt);
    expect(workPrompts.length).toBeGreaterThanOrEqual(2);

    // 1회차: 실패 사유 없음(무회귀).
    expect(workPrompts[0]).not.toContain("이전 시도 실패");
    expect(workPrompts[0]).not.toContain(FAIL_REASON);

    // 2회차: «직전 시도는 다음 이유로 통과하지 못했다: …» + 실제 사유 포함.
    expect(workPrompts[1]).toContain("직전 시도는 다음 이유로 통과하지 못했다:");
    expect(workPrompts[1]).toContain(FAIL_REASON);
  });
});

