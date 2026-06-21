/**
 * PO 워크플로우 «게이트 승인 → 머지 큐 enqueue» 재결합 wiring 단위/통합 테스트.
 *
 * 검증 대상 (브리프 수용 기준):
 *   (1) 동작: 게이트 승인+커밋 후 daemon 이 작업 브랜치(source)→기본 브랜치(target)로
 *       MergeQueue.enqueue(cleanup=1, sessionId=게이트 세션) 하고 kick 한다. 게이트 프롬프트는
 *       «커밋까지» 로 축소(머지 지시 없음).
 *   (2) 신뢰성: 충돌이면 큐가 markConflict 로 보류하고 멈추지 않는다 (기존 queue.ts 보장 재사용).
 *   (4) 비용: cleanup=1 이 머지 성공 source worktree+브랜치를 회수한다.
 *   격리 미적용(작업 브랜치 == 기본 브랜치 = 선행 worktree 미도입)이면 enqueue 를 «skip» 한다.
 *
 * 격리: merge.test.ts 와 동일 — config 를 mock 해 tmp DB 로 띄우고, 실제 tmp git repo+worktree 를
 * 만들어 머지/정리를 진짜로 돌린다 (PTY/notify 는 이 경로가 안 건드림 — 머지는 순수 로컬 git).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const H = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fsH = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const osH = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pathH = require("node:path") as typeof import("node:path");
  const dir = fsH.mkdtempSync(pathH.join(osH.tmpdir(), "ps-wfmrg-test-"));
  return {
    tmpDir: dir,
    configFile: pathH.join(dir, "config.json"),
    dbFile: pathH.join(dir, "test.db"),
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

const {
  buildGatePrompt,
  shouldEnqueueGateMerge,
  enqueueGateMerge,
  resolveGateSession,
} = await import("./workflow-exec.js");
const { defaultBranch } = await import("../git/worktree.js");
const { db, _resetDbForTest } = await import("../db/index.js");
const { getMergeQueue, _resetMergeQueueForTest } = await import("../merge/queue.js");
const { listMergeRequests } = await import("../merge/store.js");
const { parseSnapshot } = await import("../workflow/types.js");

const os = await import("node:os");
const path = await import("node:path");

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

const repos: string[] = [];
const worktrees: string[] = [];

/** main 브랜치 + 초기 커밋 1개 tmp repo. */
function mkRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ps-wfmrg-repo-"));
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  git(dir, ["config", "user.email", "test@pocket.local"]);
  git(dir, ["config", "user.name", "Tester"]);
  fs.writeFileSync(path.join(dir, "file.txt"), "base\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "init"]);
  repos.push(dir);
  return dir;
}

/** main 에서 분기한 «격리 worktree» — 그 안에서 file 을 써서 커밋(작업 브랜치). worktree 경로 반환. */
function addWorktreeBranch(mainRepo: string, branch: string, file: string, content: string): string {
  const slug = branch.replace(/[^\w.-]/g, "-");
  const wt = path.join(path.dirname(mainRepo), `${path.basename(mainRepo)}.worktrees`, slug);
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  git(mainRepo, ["worktree", "add", "-q", "-b", branch, wt, "main"]);
  fs.writeFileSync(path.join(wt, file), content);
  git(wt, ["add", "."]);
  git(wt, ["commit", "-q", "-m", `${branch}: ${file}`]);
  worktrees.push(wt);
  return wt;
}

function insertSession(id: string, repoPath: string): void {
  db()
    .prepare(`INSERT INTO sessions (id, repo_path, created_at, status) VALUES (?, ?, ?, 'completed')`)
    .run(id, repoPath, Date.now());
}

beforeAll(() => {
  fs.writeFileSync(
    H.configFile,
    JSON.stringify({ port: 7777, token: "t", createdAt: Date.now() }),
    { mode: 0o600 },
  );
});

beforeEach(() => {
  _resetMergeQueueForTest();
  _resetDbForTest();
  for (const ext of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(H.dbFile + ext);
    } catch {
      /* not exists */
    }
  }
});

afterAll(() => {
  for (const w of worktrees) {
    try {
      fs.rmSync(w, { recursive: true, force: true });
    } catch {
      /* */
    }
  }
  for (const r of repos) {
    try {
      fs.rmSync(r, { recursive: true, force: true });
    } catch {
      /* */
    }
  }
});

describe("buildGatePrompt — «커밋까지» 로 축소 (머지는 큐가 담당)", () => {
  const out = buildGatePrompt("내 기능");

  it("커밋만 지시하고 직접 머지/푸시는 금지한다", () => {
    expect(out).toContain("커밋까지만");
    expect(out).toContain("머지 큐");
    // 직접 git merge/push 를 하라는 지시가 없어야 한다 (자연어 머지 제거가 이 브리프의 핵심).
    expect(out).not.toContain("기본 브랜치로 머지까지 수행");
    expect(out).toContain("직접 합치지 마라");
  });

  it("브리프 제목을 담는다", () => {
    expect(out).toContain("내 기능");
  });
});

describe("shouldEnqueueGateMerge — 격리 브랜치가 기본 브랜치와 다를 때만", () => {
  it("source !== target 이고 둘 다 유효하면 true", () => {
    expect(shouldEnqueueGateMerge("po/abc123", "main")).toBe(true);
  });
  it("source === target 이면 false (격리 미적용 — 합칠 게 없음)", () => {
    expect(shouldEnqueueGateMerge("main", "main")).toBe(false);
  });
  it("null/빈 ref 면 false", () => {
    expect(shouldEnqueueGateMerge(null, "main")).toBe(false);
    expect(shouldEnqueueGateMerge("po/x", null)).toBe(false);
    expect(shouldEnqueueGateMerge(undefined, undefined)).toBe(false);
  });
  it("비유효 ref(선행 -, 공백, ..)면 false", () => {
    expect(shouldEnqueueGateMerge("-evil", "main")).toBe(false);
    expect(shouldEnqueueGateMerge("po/x", "ma in")).toBe(false);
    expect(shouldEnqueueGateMerge("a..b", "main")).toBe(false);
  });
});

describe("defaultBranch — 기본 브랜치 탐지", () => {
  it("로컬 main repo 면 main", async () => {
    const dir = mkRepo();
    expect(await defaultBranch(dir)).toBe("main");
  });
  it("비-repo 면 null", async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "ps-wfmrg-empty-"));
    repos.push(empty);
    expect(await defaultBranch(empty)).toBeNull();
  });
});

describe("resolveGateSession — 게이트 노드 세션/작업트리 찾기", () => {
  it("done 으로 끝난 requires_approval 게이트의 세션 repo_path 를 돌려준다", () => {
    insertSession("sess-gate", "/tmp/some/worktree");
    const def = parseSnapshot(
      JSON.stringify({
        nodes: [
          { id: "start", type: "start" },
          { id: "impl", type: "task" },
          { id: "gate", type: "task", requires_approval: true },
          { id: "end", type: "end" },
        ],
        edges: [],
      }),
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nodeRuns: any[] = [
      { id: "nr-impl", def_node_id: "impl", status: "done", session_id: "sess-impl", ended_at: 1 },
      { id: "nr-gate", def_node_id: "gate", status: "done", session_id: "sess-gate", ended_at: 2 },
    ];
    const r = resolveGateSession(nodeRuns, def);
    expect(r).toEqual({ sessionId: "sess-gate", repoPath: "/tmp/some/worktree" });
  });

  it("게이트가 거부(skipped)면 null", () => {
    const def = parseSnapshot(
      JSON.stringify({
        nodes: [{ id: "gate", type: "task", requires_approval: true }],
        edges: [],
      }),
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nodeRuns: any[] = [
      { id: "nr-gate", def_node_id: "gate", status: "skipped", session_id: "s", ended_at: 1 },
    ];
    expect(resolveGateSession(nodeRuns, def)).toBeNull();
  });

  it("requires_approval 노드가 없으면 null", () => {
    const def = parseSnapshot(
      JSON.stringify({ nodes: [{ id: "t", type: "task" }], edges: [] }),
    );
    expect(resolveGateSession([], def)).toBeNull();
  });
});

describe("enqueueGateMerge — 게이트 승인 후 머지 큐 enqueue", () => {
  it("격리 브랜치(po/x)를 main 으로 enqueue(cleanup=1, sessionId) 하고 머지+정리한다", async () => {
    const mainRepo = mkRepo();
    const wt = addWorktreeBranch(mainRepo, "po/x", "feature.txt", "feature\n");
    insertSession("sess-gate", wt);

    const plan = await enqueueGateMerge({
      repoPath: mainRepo,
      sourceRepoPath: wt,
      sessionId: "sess-gate",
    });
    expect(plan.kind).toBe("enqueued");
    if (plan.kind !== "enqueued") return;
    expect(plan.sourceBranch).toBe("po/x");
    expect(plan.targetBranch).toBe("main");

    // 큐에 «sessionId=게이트 세션» 으로 귀속(= iOS 격리 배지 매핑 키) + cleanup=1.
    const queued = listMergeRequests({ repoPath: mainRepo });
    expect(queued).toHaveLength(1);
    expect(queued[0].session_id).toBe("sess-gate");
    expect(queued[0].cleanup).toBe(1);
    expect(queued[0].source_branch).toBe("po/x");
    expect(queued[0].target_branch).toBe("main");

    // 직렬 큐를 끝까지 돌린다 → 머지 성공 + cleanup 으로 worktree/브랜치 회수.
    await getMergeQueue().runToIdle();
    const done = listMergeRequests({ repoPath: mainRepo })[0];
    expect(done.status).toBe("merged");

    // cleanup=1 — source worktree 제거 + 브랜치 삭제 (디스크 누적 방지).
    expect(fs.existsSync(wt)).toBe(false);
    const branches = git(mainRepo, ["branch", "--list", "po/x"]);
    expect(branches).toBe("");
  });

  it("충돌이면 markConflict 로 보류하고 큐는 멈추지 않는다 (재시도 가능)", async () => {
    const mainRepo = mkRepo();
    // worktree 를 main(C0)에서 분기해 file.txt 를 바꿔 커밋(C2).
    const wt = addWorktreeBranch(mainRepo, "po/conf", "file.txt", "from-branch\n");
    // main(C0)→C1: 같은 file.txt 를 다르게 바꿔 충돌을 만든다.
    fs.writeFileSync(path.join(mainRepo, "file.txt"), "from-main\n");
    git(mainRepo, ["add", "."]);
    git(mainRepo, ["commit", "-q", "-m", "main diverge"]);
    insertSession("sess-gate2", wt);

    const plan = await enqueueGateMerge({
      repoPath: mainRepo,
      sourceRepoPath: wt,
      sessionId: "sess-gate2",
    });
    expect(plan.kind).toBe("enqueued");

    await getMergeQueue().runToIdle();
    const mr = listMergeRequests({ repoPath: mainRepo })[0];
    expect(mr.status).toBe("conflict");
    // 충돌이라 worktree/브랜치는 그대로 남아 사용자가 수습/재시도할 수 있다.
    expect(fs.existsSync(wt)).toBe(true);
    const branches = git(mainRepo, ["branch", "--list", "po/conf"]);
    expect(branches).toContain("po/conf");
  });

  it("격리 브랜치가 없으면(작업 브랜치 == 기본 브랜치) skip — 큐에 안 올린다", async () => {
    const mainRepo = mkRepo();
    insertSession("sess-gate3", mainRepo); // 게이트가 main 그대로에서 돌았다 = 격리 미적용.
    const plan = await enqueueGateMerge({
      repoPath: mainRepo,
      sourceRepoPath: mainRepo,
      sessionId: "sess-gate3",
    });
    expect(plan.kind).toBe("skip");
    expect(listMergeRequests({ repoPath: mainRepo })).toHaveLength(0);
  });
});
