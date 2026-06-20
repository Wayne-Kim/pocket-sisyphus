/**
 * PO «워크플로우로 실행» per-run worktree 격리 통합테스트 (po_run_worktree_v1).
 *
 * 검증 (브리프 수용 기준):
 *  ① 동작: run 의 모든 노드 cwd 가 공유 repo 가 아니라 per-run worktree 가 된다. 같은 레포의
 *     «두 run 동시 실행» 이 서로의 작업트리 파일·git 인덱스를 안 밟는다(실제 git repo + worktree
 *     로 증명). startPoWorkflowApproval 의 설계 세션 cwd 도 worktree.
 *  ② 신뢰성: createWorktree 실패(no_repo / target_exists)는 «조용한 shared-dir 폴백 금지» —
 *     run 을 만들지 않고 명시 실패로 승인을 거절한다 (브리프는 건드리지 않아 재시도 가능).
 *  ③ 추적: run 행에 worktree 경로/브랜치가 기록된다.
 *  ④ 비용: 동시 run-worktree 상한에 닿으면 (공유 repo 폴백 없이) 명시 실패.
 *
 * 격리: engine.test.ts 와 같은 패턴 — config 를 tmp DB 로 mock, pty-runner 를 mock(진짜
 * ptyEvents 로 settle 구동) 하되, 노드 세션의 cwd 에 실제 파일을 쓰고 git add 해 «작업트리·
 * 인덱스 분리» 를 검증한다. harvestTaskFolder 는 done 으로 부분 mock.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const H = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fsH = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const osH = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pathH = require("node:path") as typeof import("node:path");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const cp = require("node:child_process") as typeof import("node:child_process");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require("node:events") as typeof import("node:events");
  const dir = fsH.mkdtempSync(pathH.join(osH.tmpdir(), "ps-wfwt-test-"));
  return {
    tmpDir: dir,
    configFile: pathH.join(dir, "config.json"),
    dbFile: pathH.join(dir, "test.db"),
    ptyEvents: new EventEmitter(),
    startedSessions: [] as { sessionId: string; cwd: string }[],
    cp,
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

// 실제 PTY 차단. runUserMessagePty 는 노드 세션의 cwd 에 «실제 파일» 을 써서 git add 한다 —
// 워크트리·인덱스 분리를 검증할 증거를 남긴다. ptyEvents 는 진짜 EventEmitter (테스트가 settle 구동).
vi.mock("../agent/pty-runner.js", () => ({
  ptyEvents: H.ptyEvents,
  isPtyActive: vi.fn(() => false),
  runUserMessagePty: vi.fn(async (opts: { sessionId: string; cwd: string }) => {
    H.startedSessions.push({ sessionId: opts.sessionId, cwd: opts.cwd });
    // cwd(=노드의 worktree)에 sentinel 파일을 쓰고 stage 한다 — «이 노드가 어느 작업트리/인덱스에
    // 썼는가» 의 증거. 비-git cwd 면 add 만 조용히 실패(파일은 남음).
    try {
      const file = path.join(opts.cwd, `wrote_${opts.sessionId.slice(0, 8)}.txt`);
      fs.writeFileSync(file, opts.sessionId);
      H.cp.execFileSync("git", ["-C", opts.cwd, "add", path.basename(file)], { stdio: "ignore" });
    } catch {
      /* best-effort — 일부 케이스(설계 세션)는 git add 가 무의미 */
    }
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

// Discord POST 차단. 이 테스트는 격리만 검증하므로 dispatch 호출은 noop.
vi.mock("../notify/index.js", () => ({
  dispatchNotification: vi.fn(async () => {}),
  dispatchCronNotification: vi.fn(async () => {}),
  dispatchPoNotification: vi.fn(async () => {}),
  dispatchPoWorkflowNotification: vi.fn(async () => {}),
  dispatchWorkflowNotification: vi.fn(async () => {}),
  dispatchTestNotification: vi.fn(async () => ({ ok: true, status: 200 })),
  eventEnabled: vi.fn(() => true),
}));

// harvestTaskFolder 만 부분 mock — 노드를 done 으로 마감 (cwd 격리 검증이 목적, harvest 무관).
vi.mock("../workflow/task-folder.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../workflow/task-folder.js")>();
  return {
    ...actual,
    harvestTaskFolder: vi.fn(async () => ({
      resultMd: "# ok\n",
      done: true,
      verdictPass: null,
      branches: null,
      needsAttention: false,
    })),
  };
});

const { db, _resetDbForTest } = await import("../db/index.js");
const { registerBuiltinAgents } = await import("../agent/index.js");
const { insertWorkflow, insertRun, getRun, listRunsForWorkflow } = await import("../workflow/store.js");
const { startWorkflowRun, cancelWorkflowRun } = await import("../workflow/engine.js");
const { createWorktree } = await import("../git/worktree.js");
const { startPoWorkflowApproval } = await import("./workflow-exec.js");

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

/** main 브랜치 + 초기 커밋 1개를 가진 tmp git repo. 정리용으로 trackedRepos 에 등록. */
const trackedRepos: string[] = [];
function mkRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ps-wfwt-repo-"));
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  git(dir, ["config", "user.email", "test@pocket.local"]);
  git(dir, ["config", "user.name", "Tester"]);
  fs.writeFileSync(path.join(dir, "README.md"), "init\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "init"]);
  trackedRepos.push(dir);
  return dir;
}

const TASK_NODES = [
  { id: "start", type: "start", title: "시작", x: 0, y: 0 },
  { id: "task", type: "task", title: "작업", prompt: "일해라", skip_permissions: true, x: 0, y: 100 },
  { id: "end", type: "end", title: "종료", x: 0, y: 200 },
];
const TASK_EDGES = [
  { id: "e1", from: "start", to: "task" },
  { id: "e2", from: "task", to: "end" },
];

function makeWorkflow(repoPath: string) {
  return insertWorkflow({
    title: "WT WF",
    repoPath,
    nodes: JSON.stringify(TASK_NODES),
    edges: JSON.stringify(TASK_EDGES),
    enabled: true,
  });
}

async function waitUntil(cond: () => boolean, ms = 5000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return cond();
}

/** 시작된(아직 exit 안 보낸) 세션이 보이면 session_exit 를 쏴 settle. ms 동안 반복. */
async function drainSessions(ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  const sent = new Set<string>();
  while (Date.now() < deadline) {
    for (const s of H.startedSessions) {
      if (!sent.has(s.sessionId)) {
        sent.add(s.sessionId);
        H.ptyEvents.emit("session_exit", { sessionId: s.sessionId });
      }
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

beforeAll(() => {
  registerBuiltinAgents();
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
});

afterEach(() => {
  // 생성된 repo + 그 형제 worktrees 디렉토리(<repo>.worktrees) 정리.
  for (const r of trackedRepos.splice(0)) {
    fs.rmSync(r, { recursive: true, force: true });
    fs.rmSync(`${r}.worktrees`, { recursive: true, force: true });
  }
});

afterAll(() => {
  _resetDbForTest();
  try {
    fs.rmSync(H.tmpDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe("① 두 run 동시 실행 — 작업트리·인덱스 분리 (engine worktree 오버라이드)", () => {
  it("각 run 노드가 «자기 worktree» 에만 쓰고 서로/공유 repo 를 안 밟는다 + run 행 기록", async () => {
    const repo = mkRepo();
    const wtA = await createWorktree(repo, { branch: "po/aaaa1111", newBranch: true });
    const wtB = await createWorktree(repo, { branch: "po/bbbb2222", newBranch: true });
    expect(wtA.ok && wtB.ok).toBe(true);
    if (!wtA.ok || !wtB.ok) return;

    const wf = makeWorkflow(repo);
    // 두 run 을 «동시» 시작 (서로 다른 worktree 오버라이드).
    const runA = startWorkflowRun(wf, "manual", { worktree: { path: wtA.path, branch: "po/aaaa1111" } });
    const runB = startWorkflowRun(wf, "manual", { worktree: { path: wtB.path, branch: "po/bbbb2222" } });
    expect("runId" in runA && "runId" in runB).toBe(true);
    if (!("runId" in runA) || !("runId" in runB)) return;

    // 두 노드 세션이 모두 떴는지 — cwd 가 각자의 worktree 여야 한다.
    expect(await waitUntil(() => H.startedSessions.length >= 2)).toBe(true);
    const cwds = H.startedSessions.map((s) => s.cwd);
    expect(cwds).toContain(wtA.path);
    expect(cwds).toContain(wtB.path);
    // 공유 repo 에서 도는 노드 세션은 없어야 한다 (격리의 핵심).
    expect(cwds).not.toContain(repo);

    // 두 노드를 settle → run 완료.
    for (const s of H.startedSessions) H.ptyEvents.emit("session_exit", { sessionId: s.sessionId });
    expect(await waitUntil(() => getRun(runA.runId)?.status === "done")).toBe(true);
    expect(await waitUntil(() => getRun(runB.runId)?.status === "done")).toBe(true);

    // ③ run 행에 worktree 경로/브랜치 기록.
    expect(getRun(runA.runId)).toMatchObject({ worktree_path: wtA.path, worktree_branch: "po/aaaa1111" });
    expect(getRun(runB.runId)).toMatchObject({ worktree_path: wtB.path, worktree_branch: "po/bbbb2222" });

    // 작업트리 분리 — 각 worktree 는 «자기» 노드의 sentinel 만 있고 상대 것은 없다.
    const filesA = fs.readdirSync(wtA.path).filter((f) => f.startsWith("wrote_"));
    const filesB = fs.readdirSync(wtB.path).filter((f) => f.startsWith("wrote_"));
    expect(filesA).toHaveLength(1);
    expect(filesB).toHaveLength(1);
    expect(filesA[0]).not.toBe(filesB[0]);
    expect(fs.existsSync(path.join(wtA.path, filesB[0]))).toBe(false);
    expect(fs.existsSync(path.join(wtB.path, filesA[0]))).toBe(false);
    // 공유 repo 작업트리엔 어느 sentinel 도 없다.
    expect(fs.readdirSync(repo).some((f) => f.startsWith("wrote_"))).toBe(false);

    // git 인덱스 분리 — 각 worktree 의 staged 파일은 «자기» sentinel 뿐, 공유 repo 인덱스는 깨끗.
    expect(git(wtA.path, ["diff", "--cached", "--name-only"])).toBe(filesA[0]);
    expect(git(wtB.path, ["diff", "--cached", "--name-only"])).toBe(filesB[0]);
    expect(git(repo, ["diff", "--cached", "--name-only"])).toBe("");
  });
});

describe("② createWorktree 실패 = 명시 실패 (조용한 shared-dir 폴백 금지)", () => {
  it("비-git repo → no_repo 로 승인 거절 + run 미생성", async () => {
    const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), "ps-wfwt-nongit-"));
    trackedRepos.push(nonGit); // afterEach 정리 (worktrees 는 안 생김)
    const res = await startPoWorkflowApproval(
      { id: "11112222-x", repo_path: nonGit, title: "t", problem: "p", scope: "s", spec: "sp" },
      "claude_code",
    );
    expect(res.status).toBe("error");
    if (res.status === "error") expect(res.error).toContain("no_repo");
    // run/워크플로우가 만들어지지 않았다.
    expect(db().prepare(`SELECT COUNT(*) AS n FROM workflow_runs`).get()).toMatchObject({ n: 0 });
    expect(db().prepare(`SELECT COUNT(*) AS n FROM workflows`).get()).toMatchObject({ n: 0 });
  });

  it("이미 같은 브랜치 worktree 존재 → target_exists 로 거절 (폴백 안 함)", async () => {
    const repo = mkRepo();
    // 같은 `po/<id8>` worktree 를 먼저 만들어 둔다.
    const pre = await createWorktree(repo, { branch: "po/deadbeef", newBranch: true });
    expect(pre.ok).toBe(true);
    const res = await startPoWorkflowApproval(
      { id: "deadbeef-9999", repo_path: repo, title: "t", problem: "p", scope: "s", spec: "sp" },
      "claude_code",
    );
    expect(res.status).toBe("error");
    if (res.status === "error") expect(res.error).toContain("target_exists");
    expect(db().prepare(`SELECT COUNT(*) AS n FROM workflow_runs`).get()).toMatchObject({ n: 0 });
  });
});

describe("④ 동시 run-worktree 상한 — 닿으면 명시 실패 (폴백 안 함)", () => {
  it("running+worktree run 이 상한이면 새 승인을 거절하고 worktree 를 안 만든다", async () => {
    const repo = mkRepo();
    const wf = makeWorkflow(repo);
    // 상한(8)만큼 running+worktree run 을 만들어 둔다.
    for (let i = 0; i < 8; i++) {
      insertRun(wf.id, JSON.stringify({ nodes: TASK_NODES, edges: TASK_EDGES }), "manual", {
        path: `/tmp/fake-wt-${i}`,
        branch: `po/fake${i}`,
      });
    }
    const res = await startPoWorkflowApproval(
      { id: "cafe1234-1", repo_path: repo, title: "t", problem: "p", scope: "s", spec: "sp" },
      "claude_code",
    );
    expect(res.status).toBe("error");
    if (res.status === "error") expect(res.error).toContain("상한");
    // 상한 체크는 createWorktree «전» 이라 새 worktree 디렉토리가 안 생겼다.
    expect(fs.existsSync(`${repo}.worktrees`)).toBe(false);
  });
});

describe("① PO 승인 경로 — 설계 세션 cwd = worktree + run 이 worktree 를 물려받음", () => {
  it("startPoWorkflowApproval 가 worktree 를 만들고 설계 세션·run 모두 그 worktree 를 쓴다", async () => {
    const repo = mkRepo();
    const brief = { id: "abcdef12-7777", repo_path: repo, title: "기회", problem: "p", scope: "s", spec: "sp" };
    const res = await startPoWorkflowApproval(brief, "claude_code");
    expect(res.status).toBe("running");
    if (res.status !== "running") return;

    // 동기 효과: worktree 브랜치 `po/abcdef12` 가 생겼고, 그 worktree 가 등록돼 있다.
    expect(git(repo, ["branch", "--list", "po/abcdef12"])).toContain("po/abcdef12");
    expect(git(repo, ["worktree", "list", "--porcelain"])).toContain("po-abcdef12");

    const designSession = db()
      .prepare(`SELECT repo_path FROM sessions WHERE id = ?`)
      .get(res.sessionId) as { repo_path: string } | undefined;
    expect(designSession).toBeTruthy();
    // 설계 세션 repo_path 는 공유 repo 가 아니라 worktree (<repo>.worktrees/po-abcdef12).
    expect(designSession!.repo_path).not.toBe(repo);
    expect(designSession!.repo_path).toContain("po-abcdef12");
    const wtPath = designSession!.repo_path;

    // 백그라운드 finalize: 설계 세션 settle → fallback def → run 생성 (worktree 물려받음).
    expect(await waitUntil(() => H.startedSessions.some((s) => s.sessionId === res.sessionId))).toBe(true);
    H.ptyEvents.emit("session_exit", { sessionId: res.sessionId });
    expect(await waitUntil(() => getCreatedRun(repo) != null, 6000)).toBe(true);
    const run = getCreatedRun(repo)!;
    // ③ run 행이 같은 worktree 를 기록.
    expect(run.worktree_path).toBe(wtPath);
    expect(run.worktree_branch).toBe("po/abcdef12");

    // 정리 — run 의 노드 세션들을 모두 settle/cancel 해 타이머가 안 남게 한다.
    cancelWorkflowRun(run.id);
    await drainSessions(800);
  });
});

/** 방금 만든 workflow(=PO: …)의 run 을 찾는다 — repo 의 workflows 중 PO 접두 1개의 최신 run. */
function getCreatedRun(repoPath: string) {
  const wfRow = db()
    .prepare(`SELECT id FROM workflows WHERE repo_path = ? ORDER BY created_at DESC LIMIT 1`)
    .get(repoPath) as { id: string } | undefined;
  if (!wfRow) return null;
  return listRunsForWorkflow(wfRow.id, 1)[0] ?? null;
}
