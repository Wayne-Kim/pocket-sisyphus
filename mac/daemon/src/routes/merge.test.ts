/**
 * `routes/merge` + merge/store + merge/queue + git/merge 통합 테스트.
 *
 * 격리: cron.test.ts 와 동일 — config 를 mock 해 tmp DB 로 띄운다. PTY/notify 는 머지 경로가
 * 건드리지 않으므로 mock 불필요(머지는 순수 로컬 git). 실제 tmp git repo 를 만들어 직렬 처리·
 * 충돌 보류·읽기 전용 사전 탐지·isValidRef 거부·취소/재시도를 검증한다.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { Hono } from "hono";
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const H = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fsH = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const osH = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pathH = require("node:path") as typeof import("node:path");
  const dir = fsH.mkdtempSync(pathH.join(osH.tmpdir(), "ps-mq-test-"));
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

const { merge } = await import("./merge.js");
const { db, _resetDbForTest } = await import("../db/index.js");
const { hashToken, invalidateAuthCache } = await import("../auth.js");
const { getMergeQueue, _resetMergeQueueForTest } = await import("../merge/queue.js");
const { claimNextQueued, queueCounts } = await import("../merge/store.js");

const os = await import("node:os");
const path = await import("node:path");

const TEST_TOKEN = "merge-test-token";
const AUTH = { authorization: `Bearer ${TEST_TOKEN}`, "content-type": "application/json" };

function buildApp(): Hono {
  const app = new Hono();
  app.route("/api/merge-queue", merge);
  return app;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function j(res: Response): Promise<any> {
  return res.json();
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

const repos: string[] = [];
function mkRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ps-mq-repo-"));
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  git(dir, ["config", "user.email", "test@pocket.local"]);
  git(dir, ["config", "user.name", "Tester"]);
  fs.writeFileSync(path.join(dir, "README.md"), "init\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "init"]);
  repos.push(dir);
  return dir;
}
/** main 에서 분기해 file 을 써서 커밋한 새 브랜치. 끝나면 main 복귀. */
function branch(dir: string, name: string, file: string, content: string): void {
  git(dir, ["checkout", "-q", "-b", name, "main"]);
  fs.writeFileSync(path.join(dir, file), content);
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", `${name}`]);
  git(dir, ["checkout", "-q", "main"]);
}

type MergeReq = {
  id: string;
  status: string;
  result: string | null;
  conflictFiles: string[];
  sourceBranch: string;
  targetBranch: string;
  error: string | null;
};

async function enqueue(
  app: Hono,
  repoPath: string,
  sourceBranch: string,
  targetBranch = "main",
  extra: Record<string, unknown> = {},
): Promise<{ status: number; request?: MergeReq; body: any }> {
  const res = await app.request("/api/merge-queue", {
    method: "POST",
    headers: AUTH,
    body: JSON.stringify({ repoPath, sourceBranch, targetBranch, ...extra }),
  });
  const body = await j(res);
  return { status: res.status, request: body.request, body };
}

beforeAll(() => {
  fs.writeFileSync(
    H.configFile,
    JSON.stringify({ port: 7777, token: TEST_TOKEN, tokenHash: hashToken(TEST_TOKEN), createdAt: Date.now() }),
    { mode: 0o600 },
  );
  invalidateAuthCache();
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
  _resetDbForTest();
  try {
    fs.rmSync(H.tmpDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
  for (const r of repos) {
    try {
      fs.rmSync(r, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

describe("auth + 입력 검증", () => {
  it("Bearer 없으면 401", async () => {
    const res = await buildApp().request("/api/merge-queue");
    expect(res.status).toBe(401);
  });

  it("잘못된 브랜치명/주입은 isValidRef 수준에서 400", async () => {
    const app = buildApp();
    const dir = mkRepo();
    const r1 = await enqueue(app, dir, "--upload-pack=x", "main");
    expect(r1.status).toBe(400);
    expect(r1.body.error).toBe("invalid_source_branch");
    const r2 = await enqueue(app, dir, "feature", "../evil");
    expect(r2.status).toBe(400);
    expect(r2.body.error).toBe("invalid_target_branch");
  });

  it("source===target 는 거부", async () => {
    const app = buildApp();
    const dir = mkRepo();
    const r = await enqueue(app, dir, "main", "main");
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("source_equals_target");
  });

  it("비-repo 경로는 400 not_a_repo", async () => {
    const app = buildApp();
    const nonRepo = fs.mkdtempSync(path.join(os.tmpdir(), "ps-mq-norepo-"));
    repos.push(nonRepo);
    const r = await enqueue(app, nonRepo, "feature", "main");
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("not_a_repo");
  });
});

describe("직렬 처리 — 동시 다수 요청", () => {
  it("15개 브랜치를 동시에 enqueue 해도 모두 직렬로 main 에 병합", async () => {
    const app = buildApp();
    const dir = mkRepo();
    const N = 15;
    for (let i = 0; i < N; i++) branch(dir, `po/f${i}`, `file${i}.txt`, `content ${i}\n`);

    // 동시에 enqueue (Promise.all) — 큐에 적재되고 직렬로 처리돼야 한다.
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) => enqueue(app, dir, `po/f${i}`, "main")),
    );
    for (const r of results) expect(r.status).toBe(201);

    await getMergeQueue().runToIdle();

    // 전부 merged + main 워크트리에 15개 파일 모두 존재 + 워크트리 깨끗(직렬성의 증거 —
    // 동시 쓰기였다면 인덱스/워크트리가 깨졌을 것).
    const list = (await j(await app.request("/api/merge-queue", { headers: AUTH }))) as {
      requests: MergeReq[];
      counts: Record<string, number>;
    };
    expect(list.counts.merged).toBe(N);
    expect(list.counts.queued).toBe(0);
    expect(list.counts.processing).toBe(0);
    for (let i = 0; i < N; i++) {
      expect(fs.existsSync(path.join(dir, `file${i}.txt`)), `file${i}.txt`).toBe(true);
    }
    expect(git(dir, ["status", "--porcelain"])).toBe("");
  }, 30000); // 15회 실제 git 머지 — 프로세스 스폰이 많아 기본 5s 초과.

  it("claimNextQueued 는 항목을 «배타적» 으로 집는다 (직렬 보장의 한 축)", async () => {
    const app = buildApp();
    const dir = mkRepo();
    branch(dir, "po/a", "a.txt", "a\n");
    branch(dir, "po/b", "b.txt", "b\n");
    // 큐만 채우고 처리는 막기 위해 라우트의 kick 후 즉시 claim 을 동기로 두 번.
    _resetMergeQueueForTest(); // kick 이 띄운 루프와 분리 (이 테스트는 claim 원자성만 본다)
    // DB 에 직접 두 건 적재.
    const { insertMergeRequest } = await import("../merge/store.js");
    insertMergeRequest({ repoPath: dir, sourceBranch: "po/a", targetBranch: "main", sessionId: null, cleanup: false, noFF: false });
    insertMergeRequest({ repoPath: dir, sourceBranch: "po/b", targetBranch: "main", sessionId: null, cleanup: false, noFF: false });

    const c1 = claimNextQueued();
    const c2 = claimNextQueued();
    const c3 = claimNextQueued();
    expect(c1?.status).toBe("processing");
    expect(c2?.status).toBe("processing");
    expect(c1?.id).not.toBe(c2?.id); // 서로 다른 항목
    expect(c3).toBeUndefined(); // 더 없음
    expect(queueCounts(dir).processing).toBe(2);
    expect(queueCounts(dir).queued).toBe(0);
  });
});

describe("충돌 — 해당 항목만 보류, 나머지 계속", () => {
  it("충돌 항목은 conflict, 깨끗한 항목은 merged (큐는 멈추지 않음)", async () => {
    const app = buildApp();
    const dir = mkRepo();
    // 공통 파일.
    fs.writeFileSync(path.join(dir, "shared.txt"), "base\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-q", "-m", "add shared"]);
    // 충돌 브랜치: shared.txt 같은 줄 변경 + main 도 변경.
    branch(dir, "po/conflict", "shared.txt", "conflict edit\n");
    git(dir, ["checkout", "-q", "main"]);
    fs.writeFileSync(path.join(dir, "shared.txt"), "main edit\n");
    git(dir, ["commit", "-q", "-am", "main edits shared"]);
    const mainTipBefore = git(dir, ["rev-parse", "main"]);
    // 깨끗한 브랜치.
    branch(dir, "po/clean", "clean.txt", "clean\n");

    const rc = await enqueue(app, dir, "po/conflict", "main");
    const rk = await enqueue(app, dir, "po/clean", "main");
    expect(rc.status).toBe(201);
    expect(rk.status).toBe(201);

    await getMergeQueue().runToIdle();

    const conflictReq = (await j(await app.request(`/api/merge-queue/${rc.request!.id}`, { headers: AUTH }))).request as MergeReq;
    const cleanReq = (await j(await app.request(`/api/merge-queue/${rk.request!.id}`, { headers: AUTH }))).request as MergeReq;

    expect(conflictReq.status).toBe("conflict");
    expect(conflictReq.conflictFiles).toContain("shared.txt");
    expect(cleanReq.status).toBe("merged");
    // 충돌은 main 을 바꾸지 않았다 — 충돌 항목의 변경만 보류, shared.txt 는 main edit 유지.
    expect(fs.readFileSync(path.join(dir, "shared.txt"), "utf8")).toBe("main edit\n");
    // 깨끗 항목은 main 을 전진시켰다(머지 커밋) → main tip 이 바뀜.
    expect(git(dir, ["rev-parse", "main"])).not.toBe(mainTipBefore);
    expect(fs.existsSync(path.join(dir, ".git", "MERGE_HEAD"))).toBe(false);
    expect(git(dir, ["status", "--porcelain"])).toBe("");
  });
});

describe("preview — 읽기 전용", () => {
  it("충돌 쌍을 미리 보면 conflict=true + repo 무변경", async () => {
    const app = buildApp();
    const dir = mkRepo();
    fs.writeFileSync(path.join(dir, "shared.txt"), "base\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-q", "-m", "add shared"]);
    branch(dir, "po/c", "shared.txt", "c edit\n");
    git(dir, ["checkout", "-q", "main"]);
    fs.writeFileSync(path.join(dir, "shared.txt"), "m edit\n");
    git(dir, ["commit", "-q", "-am", "m"]);

    const refsBefore = git(dir, ["show-ref"]);
    const res = await app.request("/api/merge-queue/preview", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ repoPath: dir, sourceBranch: "po/c", targetBranch: "main" }),
    });
    const body = await j(res);
    expect(res.status).toBe(200);
    expect(body.relation).toBe("diverged");
    expect(body.conflict).toBe(true);
    expect(body.conflictFiles).toContain("shared.txt");
    expect(git(dir, ["show-ref"])).toBe(refsBefore); // repo 무변경
  });
});

describe("취소 / 재시도 / 삭제", () => {
  it("queued 항목 DELETE → cancelled", async () => {
    const dir = mkRepo();
    const { insertMergeRequest } = await import("../merge/store.js");
    const row = insertMergeRequest({ repoPath: dir, sourceBranch: "po/x", targetBranch: "main", sessionId: null, cleanup: false, noFF: false });
    const app = buildApp();
    const res = await app.request(`/api/merge-queue/${row.id}`, { method: "DELETE", headers: AUTH });
    expect(res.status).toBe(200);
    const body = await j(res);
    expect(body.request.status).toBe("cancelled");
  });

  it("conflict 항목 retry → 다시 queued", async () => {
    const dir = mkRepo();
    const { insertMergeRequest, markConflict } = await import("../merge/store.js");
    const row = insertMergeRequest({ repoPath: dir, sourceBranch: "po/x", targetBranch: "main", sessionId: null, cleanup: false, noFF: false });
    markConflict(row.id, { conflictFiles: ["a.txt"], error: "conflict" });
    _resetMergeQueueForTest();
    const app = buildApp();
    const res = await app.request(`/api/merge-queue/${row.id}/retry`, { method: "POST", headers: AUTH });
    expect(res.status).toBe(200);
    const body = await j(res);
    // retry 직후 kick 으로 처리될 수 있으니 queued 또는 (없는 브랜치라) failed 중 하나 — queued 로 시작했음만 확인.
    expect(["queued", "failed", "processing"]).toContain(body.request.status);
  });

  it("merged 항목 DELETE → 행 제거", async () => {
    const dir = mkRepo();
    const { insertMergeRequest, markMerged } = await import("../merge/store.js");
    const row = insertMergeRequest({ repoPath: dir, sourceBranch: "po/x", targetBranch: "main", sessionId: null, cleanup: false, noFF: false });
    markMerged(row.id, { result: "merged", mergeCommit: "abc" });
    const app = buildApp();
    const res = await app.request(`/api/merge-queue/${row.id}`, { method: "DELETE", headers: AUTH });
    expect(res.status).toBe(200);
    expect((await j(res)).deleted).toBe(true);
    const res2 = await app.request(`/api/merge-queue/${row.id}`, { headers: AUTH });
    expect(res2.status).toBe(404);
  });
});

describe("cleanup 옵션", () => {
  it("cleanup=true 면 머지 후 source 브랜치 삭제", async () => {
    const app = buildApp();
    const dir = mkRepo();
    branch(dir, "po/cleanme", "c.txt", "c\n");
    const r = await enqueue(app, dir, "po/cleanme", "main", { cleanup: true });
    expect(r.status).toBe(201);
    await getMergeQueue().runToIdle();
    const got = (await j(await app.request(`/api/merge-queue/${r.request!.id}`, { headers: AUTH }))).request as MergeReq;
    expect(got.status).toBe("merged");
    // 브랜치가 정리됐는지 (워크트리 없으니 브랜치만).
    expect(git(dir, ["branch", "--list", "po/cleanme"])).toBe("");
  });
});

describe("세션 연동", () => {
  it("sessionId 로 enqueue 하면 그 세션의 repo_path 를 쓰고 목록 필터로 조회된다", async () => {
    const app = buildApp();
    const dir = mkRepo();
    branch(dir, "po/s", "s.txt", "s\n");
    // 세션 행 직접 삽입.
    const now = Date.now();
    db()
      .prepare(
        "INSERT INTO sessions (id, repo_path, created_at, status, mode, agent) VALUES (?, ?, ?, 'active', 'pty', 'claude_code')",
      )
      .run("sess-1", dir, now);
    const res = await app.request("/api/merge-queue", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ sessionId: "sess-1", sourceBranch: "po/s", targetBranch: "main" }),
    });
    expect(res.status).toBe(201);
    await getMergeQueue().runToIdle();
    const filtered = (await j(await app.request("/api/merge-queue?sessionId=sess-1", { headers: AUTH }))) as { requests: MergeReq[] };
    expect(filtered.requests.length).toBe(1);
    expect(filtered.requests[0].sourceBranch).toBe("po/s");
  });
});
