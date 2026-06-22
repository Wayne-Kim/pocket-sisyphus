/**
 * workflow/repeat — 「반복 실행」(repeat_run_v1) 단위 + 엔진 통합 테스트.
 *
 * 검증 (브리프 수용 기준):
 *  - buildRepeatDef: start→실행→점검→end + «점검 fail→실행» back-edge 구조 + 프롬프트/에이전트 주입.
 *  - startRepeatRun: ephemeral 워크플로우를 만들고(캔버스 목록에서 숨김) 엔진으로 돌린다.
 *  - 점검이 매번 fail → 「최대 횟수」(per-run maxIterations)에서 멈추고 run=failed + limit_reached.
 *  - 점검이 N회째 pass → run=done + verdict=pass (완료).
 *  - summarizeRepeatRun: 반복 회차(1-based)·상한·판정·goal/check/agent 파생.
 *
 * 격리: engine.test.ts 와 동일 mock 패턴(config tmp DB, pty-runner, notify, task-folder harvest).
 * worktree(git)를 피하려 isolated:false 로 돌린다 — 루프/상한 로직은 worktree 와 직교.
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
  const dir = fsH.mkdtempSync(pathH.join(osH.tmpdir(), "ps-repeat-test-"));
  return {
    tmpDir: dir,
    configFile: pathH.join(dir, "config.json"),
    dbFile: pathH.join(dir, "test.db"),
    repoDir: fsH.mkdtempSync(pathH.join(osH.tmpdir(), "ps-repeat-repo-")),
    ptyEvents: new EventEmitter(),
    startedSessions: [] as string[],
    harvestMock: vi.fn(async (_repoPath: string, _rel: string) => ({
      resultMd: "# ok\n" as string | null,
      done: true,
      verdictPass: null as boolean | null,
      verdictSummary: null as string | null,
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

vi.mock("../notify/index.js", () => ({
  dispatchNotification: vi.fn(async () => {}),
  dispatchCronNotification: vi.fn(async () => {}),
  dispatchPoNotification: vi.fn(async () => {}),
  dispatchPoWorkflowNotification: vi.fn(async () => {}),
  dispatchWorkflowNotification: vi.fn(async () => {}),
  dispatchTestNotification: vi.fn(async () => ({ ok: true, status: 200 })),
  eventEnabled: vi.fn(() => true),
}));

vi.mock("../workflow/task-folder.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../workflow/task-folder.js")>();
  return { ...actual, harvestTaskFolder: H.harvestMock };
});

const { _resetDbForTest } = await import("../db/index.js");
const { hashToken, invalidateAuthCache } = await import("../auth.js");
const { registerBuiltinAgents } = await import("../agent/index.js");
const { listWorkflows, listRepeatRuns, getRun, listNodeRuns } = await import("../workflow/store.js");
const { buildRepeatDef, startRepeatRun, summarizeRepeatRun } = await import("../workflow/repeat.js");

const DONE_HARVEST = {
  resultMd: "# ok\n" as string | null,
  done: true,
  verdictPass: null as boolean | null,
  verdictSummary: null as string | null,
  branches: null,
  needsAttention: false,
};

async function waitUntil(cond: () => boolean, ms = 4000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return cond();
}

/** 새로 뜬 세션마다 session_exit 를 쏴 settle 시키며 run 이 terminal 될 때까지 구동한다. */
async function drive(runId: string): Promise<void> {
  const emitted = new Set<string>();
  for (let i = 0; i < 400; i++) {
    for (const s of [...H.startedSessions]) {
      if (!emitted.has(s)) {
        emitted.add(s);
        H.ptyEvents.emit("session_exit", { sessionId: s });
      }
    }
    const st = getRun(runId)?.status;
    if (st === "done" || st === "failed" || st === "cancelled") return;
    await new Promise((r) => setTimeout(r, 12));
  }
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

describe("buildRepeatDef — 자기교정 루프 합성", () => {
  it("start→실행→점검→end + «점검 fail→실행» back-edge", () => {
    const def = buildRepeatDef({ goal: "목표", check: "검사", agent: "claude_code" });
    expect(def.nodes.map((n) => n.id)).toEqual(["start", "make", "check", "end"]);
    expect(def.nodes.find((n) => n.id === "make")?.prompt).toBe("목표");
    expect(def.nodes.find((n) => n.id === "check")?.prompt).toBe("검사");
    expect(def.nodes.find((n) => n.id === "make")?.agent).toBe("claude_code");
    // 점검 → 실행 back-edge 는 condition="fail" 만 (순환 허용 조건).
    const back = def.edges.find((e) => e.from === "check" && e.to === "make");
    expect(back?.condition).toBe("fail");
    // 성공 경로 점검 → end 는 무조건 간선.
    expect(def.edges.find((e) => e.from === "check" && e.to === "end")?.condition).toBeUndefined();
  });

  it("skipPermissions=true 면 작업 노드에 skip_permissions 를 박는다", () => {
    const def = buildRepeatDef({ goal: "g", check: "c", skipPermissions: true });
    expect(def.nodes.find((n) => n.id === "make")?.skip_permissions).toBe(true);
    expect(def.nodes.find((n) => n.id === "check")?.skip_permissions).toBe(true);
  });
});

describe("startRepeatRun — ephemeral 워크플로우 + 엔진 실행", () => {
  it("합성 워크플로우는 캔버스 목록(listWorkflows)에서 숨고 listRepeatRuns 엔 뜬다", async () => {
    const res = await startRepeatRun({
      repoPath: H.repoDir,
      goal: "목표",
      check: "검사",
      maxIterations: 2,
      isolated: false,
    });
    expect("runId" in res).toBe(true);
    const runId = (res as { runId: string }).runId;
    // 점검 통과(기본 harvest 는 verdictPass=null → pass 간주)로 곧장 완료.
    await drive(runId);
    expect(getRun(runId)?.status).toBe("done");
    // ephemeral 이라 캔버스 목록엔 없다.
    expect(listWorkflows().length).toBe(0);
    // 반복 실행 목록엔 있다.
    const repeats = listRepeatRuns();
    expect(repeats.length).toBe(1);
    expect(repeats[0].repo_path).toBe(H.repoDir);
  });

  it("goal/check 누락은 거절", async () => {
    expect(await startRepeatRun({ repoPath: H.repoDir, goal: "  ", check: "c", maxIterations: 2, isolated: false }))
      .toMatchObject({ error: "goal_required" });
    expect(await startRepeatRun({ repoPath: H.repoDir, goal: "g", check: " ", maxIterations: 2, isolated: false }))
      .toMatchObject({ error: "check_required" });
  });

  it("점검이 매번 fail → 「최대 횟수」에서 멈춘다 (run=failed + limit_reached)", async () => {
    H.harvestMock.mockImplementation(async (_repo: string, rel: string) => {
      if (rel.includes("점검")) {
        return { resultMd: "# r\n", done: true, verdictPass: false, verdictSummary: "아직 미통과", branches: null, needsAttention: false };
      }
      return { ...DONE_HARVEST };
    });

    const res = await startRepeatRun({
      repoPath: H.repoDir,
      goal: "목표",
      check: "검사",
      maxIterations: 3,
      isolated: false,
    });
    const runId = (res as { runId: string }).runId;
    await drive(runId);

    expect(getRun(runId)?.status).toBe("failed");
    const summary = summarizeRepeatRun(
      { ...getRun(runId)!, repo_path: H.repoDir },
      listNodeRuns(runId),
    );
    expect(summary.max_iterations).toBe(3);
    expect(summary.iteration).toBe(3); // 상한까지 돌고 멈춤
    expect(summary.limit_reached).toBe(true);
    expect(summary.verdict).toBe("fail");
    expect(summary.goal).toBe("목표");
    expect(summary.check).toBe("검사");
  });

  it("점검이 2회째 pass → run=done + verdict=pass (완료)", async () => {
    let checkSeen = 0;
    H.harvestMock.mockImplementation(async (_repo: string, rel: string) => {
      if (rel.includes("점검")) {
        checkSeen++;
        if (checkSeen === 1) {
          return { resultMd: "# r\n", done: true, verdictPass: false, verdictSummary: "1차 미통과", branches: null, needsAttention: false };
        }
        return { ...DONE_HARVEST, verdictPass: true };
      }
      return { ...DONE_HARVEST };
    });

    const res = await startRepeatRun({
      repoPath: H.repoDir,
      goal: "목표",
      check: "검사",
      maxIterations: 5,
      isolated: false,
    });
    const runId = (res as { runId: string }).runId;
    await drive(runId);

    expect(getRun(runId)?.status).toBe("done");
    const summary = summarizeRepeatRun({ ...getRun(runId)!, repo_path: H.repoDir }, listNodeRuns(runId));
    expect(summary.verdict).toBe("pass");
    expect(summary.limit_reached).toBe(false);
    expect(summary.iteration).toBe(2); // 1차 fail → 2차 pass
  });

  it("maxIterations 를 받았으면 run 행에 그 상한이 기록된다", async () => {
    const res = await startRepeatRun({
      repoPath: H.repoDir,
      goal: "g",
      check: "c",
      maxIterations: 4,
      isolated: false,
    });
    const runId = (res as { runId: string }).runId;
    expect(getRun(runId)?.max_iterations).toBe(4);
    await drive(runId);
  });
});
