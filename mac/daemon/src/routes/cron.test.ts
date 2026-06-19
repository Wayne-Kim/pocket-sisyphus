/**
 * `routes/cron` + cron/store + cron/executor 통합 테스트.
 *
 * 격리: sessions.test.ts 와 동일 — config 를 mock 해 tmp DB 로, pty-runner 를 mock 해 실제
 * PTY spawn 차단. pty-runner mock 의 ptyEvents 는 «진짜» EventEmitter 라, 테스트가 turn_complete
 * 를 emit 해 executor 의 완료 대기를 구동할 수 있다. notify 는 mock (Discord POST 차단).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { Hono } from "hono";
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
  const dir = fsH.mkdtempSync(pathH.join(osH.tmpdir(), "ps-cron-test-"));
  return {
    tmpDir: dir,
    configFile: pathH.join(dir, "config.json"),
    dbFile: pathH.join(dir, "test.db"),
    repoDir: fsH.mkdtempSync(pathH.join(osH.tmpdir(), "ps-cron-repo-")),
    ptyEvents: new EventEmitter(),
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

// 실제 PTY spawn 차단. ptyEvents 는 진짜 EventEmitter — 테스트가 turn_complete 를 쏴 executor
// 의 완료 대기를 끝낸다. (overlap 판정은 더 이상 isPtyActive 가 아니라 executor 의 in-flight
// 집합으로 한다 — 사용자가 세션을 열어 PTY 가 active 여도 오판 skip 하지 않게.)
vi.mock("../agent/pty-runner.js", () => ({
  ptyEvents: H.ptyEvents,
  isPtyActive: vi.fn(() => false),
  runUserMessagePty: vi.fn(async () => {}),
  runTerminalScriptPty: vi.fn(() => {}),
  abortPtySession: vi.fn(() => true),
  awaitPtyExit: vi.fn(async () => {}),
  prewarmPty: vi.fn(),
  resizePty: vi.fn(() => false),
  writePtyRaw: vi.fn(() => false),
  sendPtyKey: vi.fn(),
  emitSpawnFailure: vi.fn(),
}));

// Discord POST 차단.
vi.mock("../notify/index.js", () => ({
  dispatchNotification: vi.fn(async () => {}),
  dispatchCronNotification: vi.fn(async () => {}),
  dispatchTestNotification: vi.fn(async () => ({ ok: true, status: 200 })),
}));

const { cron } = await import("./cron.js");
const { db, _resetDbForTest } = await import("../db/index.js");
const { hashToken, invalidateAuthCache } = await import("../auth.js");
const { registerBuiltinAgents } = await import("../agent/index.js");
const { getCronScheduler } = await import("../cron/scheduler.js");
// 위 vi.mock 의 isPtyActive 핸들 — 회귀 테스트에서 «직전 세션 PTY 가 살아 있는» 상황을 흉내낸다.
const { isPtyActive, runTerminalScriptPty } = await import("../agent/pty-runner.js");

const TEST_TOKEN = "cron-test-token";
const AUTH = { authorization: `Bearer ${TEST_TOKEN}`, "content-type": "application/json" };

function buildApp(): Hono {
  const app = new Hono();
  app.route("/api/cron", cron);
  return app;
}

type CronJob = {
  id: string;
  title: string | null;
  agent: string;
  repo_path: string;
  command: string;
  schedule: string;
  enabled: number;
  skip_permissions: number;
  session_mode: string;
  overlap_policy: string;
  notify: number;
  next_run_at: number | null;
  last_status: string | null;
  last_session_id: string | null;
  run_count: number;
};

async function jsonAs<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

async function createJob(app: Hono, overrides: Record<string, unknown> = {}): Promise<CronJob> {
  const res = await app.request("/api/cron", {
    method: "POST",
    headers: AUTH,
    body: JSON.stringify({
      title: "데일리",
      agent: "claude_code",
      repoPath: H.repoDir,
      command: "어제 한 일 요약해줘",
      schedule: "0 9 * * 1-5",
      timezone: "Asia/Seoul",
      ...overrides,
    }),
  });
  expect(res.status, await res.clone().text()).toBe(201);
  return (await jsonAs<{ job: CronJob }>(res)).job;
}

beforeAll(() => {
  registerBuiltinAgents();
  fs.writeFileSync(
    H.configFile,
    JSON.stringify({ port: 7777, token: TEST_TOKEN, tokenHash: hashToken(TEST_TOKEN), createdAt: Date.now() }),
    { mode: 0o600 },
  );
  invalidateAuthCache();
});

beforeEach(() => {
  getCronScheduler().stop();
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
  getCronScheduler().stop();
  _resetDbForTest();
  try {
    fs.rmSync(H.tmpDir, { recursive: true, force: true });
    fs.rmSync(H.repoDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe("auth", () => {
  it("Bearer 없으면 401", async () => {
    const res = await buildApp().request("/api/cron");
    expect(res.status).toBe(401);
  });
});

describe("POST /api/cron/preview", () => {
  it("정상 식이면 valid + nextRuns 3개", async () => {
    const res = await buildApp().request("/api/cron/preview", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ schedule: "0 9 * * 1-5", timezone: "Asia/Seoul" }),
    });
    expect(res.status).toBe(200);
    const body = await jsonAs<{ valid: boolean; nextRuns: number[] }>(res);
    expect(body.valid).toBe(true);
    expect(body.nextRuns).toHaveLength(3);
  });

  it("잘못된 식이면 valid:false + error", async () => {
    const res = await buildApp().request("/api/cron/preview", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ schedule: "garbage" }),
    });
    const body = await jsonAs<{ valid: boolean; error?: string }>(res);
    expect(body.valid).toBe(false);
    expect(body.error?.length).toBeGreaterThan(0);
  });
});

describe("POST /api/cron — 검증", () => {
  it("command 없으면 400", async () => {
    const res = await buildApp().request("/api/cron", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ agent: "claude_code", repoPath: H.repoDir, schedule: "0 9 * * *" }),
    });
    expect(res.status).toBe(400);
  });

  it("모르는 agent 면 400", async () => {
    const res = await buildApp().request("/api/cron", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ agent: "nope", repoPath: H.repoDir, command: "x", schedule: "0 9 * * *" }),
    });
    expect(res.status).toBe(400);
  });

  it("잘못된 식이면 400 invalid_schedule + 한국어/사유", async () => {
    const res = await buildApp().request("/api/cron", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ agent: "claude_code", repoPath: H.repoDir, command: "x", schedule: "??" }),
    });
    expect(res.status).toBe(400);
    expect((await jsonAs<{ error: string }>(res)).error).toBe("invalid_schedule");
  });

  it("상대경로 repoPath 면 400 repo_dir_failed", async () => {
    const res = await buildApp().request("/api/cron", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ agent: "claude_code", repoPath: "rel/repo", command: "x", schedule: "0 9 * * *" }),
    });
    expect(res.status).toBe(400);
    expect((await jsonAs<{ error: string }>(res)).error).toBe("repo_dir_failed");
  });
});

describe("터미널 예약 (kind=terminal)", () => {
  it("스크립트 파일로 생성 → agent='shell' 고정 + command(경로)·shell 보존", async () => {
    const app = buildApp();
    const scriptPath = `${H.repoDir}/job.sh`;
    fs.writeFileSync(scriptPath, "#!/bin/zsh\necho hi\n");
    const res = await app.request("/api/cron", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({
        title: "백업",
        kind: "terminal",
        repoPath: H.repoDir,
        command: scriptPath,
        shell: "bash",
        schedule: "0 3 * * *",
        timezone: "Asia/Seoul",
      }),
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const job = (await jsonAs<{ job: CronJob & { kind: string; shell: string | null } }>(res)).job;
    expect(job.kind).toBe("terminal");
    expect(job.agent).toBe("shell"); // 사용자가 agent 를 안 보내도 터미널은 셸로 고정
    expect(job.command).toBe(scriptPath); // 정규화된 절대경로
    expect(job.shell).toBe("bash");
  });

  it("스크립트 파일이 없으면 400 script_invalid", async () => {
    const res = await buildApp().request("/api/cron", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({
        kind: "terminal",
        repoPath: H.repoDir,
        command: `${H.repoDir}/does-not-exist.sh`,
        schedule: "0 3 * * *",
      }),
    });
    expect(res.status).toBe(400);
    expect((await jsonAs<{ error: string }>(res)).error).toBe("script_invalid");
  });

  it("command(스크립트 경로) 없으면 400", async () => {
    const res = await buildApp().request("/api/cron", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ kind: "terminal", repoPath: H.repoDir, schedule: "0 3 * * *" }),
    });
    expect(res.status).toBe(400);
  });

  it("알 수 없는 shell 값은 NULL 로 정규화 (→ 기본 셸)", async () => {
    const app = buildApp();
    const scriptPath = `${H.repoDir}/s2.sh`;
    fs.writeFileSync(scriptPath, "echo hi\n");
    const job = await createJob(app, { kind: "terminal", command: scriptPath, shell: "fish" });
    expect((job as CronJob & { shell: string | null }).shell).toBeNull();
  });

  it("«지금 실행» → shell 어댑터 세션 생성 + runTerminalScriptPty 호출, session_exit(0) → ok", async () => {
    const app = buildApp();
    const scriptPath = `${H.repoDir}/run.sh`;
    fs.writeFileSync(scriptPath, "echo hi\n");
    const job = await createJob(app, { kind: "terminal", command: scriptPath, shell: "zsh" });

    vi.mocked(runTerminalScriptPty).mockClear();
    const res = await app.request(`/api/cron/${job.id}/run`, { method: "POST", headers: AUTH });
    expect(res.status).toBe(200);
    const result = await jsonAs<{ status: string; sessionId: string }>(res);
    expect(result.status).toBe("running");

    // 세션은 shell 어댑터로 만들어진다 (목록 아이콘 = 터미널).
    const sess = db()
      .prepare("SELECT agent FROM sessions WHERE id = ?")
      .get(result.sessionId) as { agent: string };
    expect(sess.agent).toBe("shell");
    // 에이전트 프롬프트 경로가 아니라 터미널 실행 경로를 탔다.
    expect(vi.mocked(runTerminalScriptPty)).toHaveBeenCalledTimes(1);

    // 스크립트가 정상 종료한 상황을 흉내 — session_exit(code 0) → ok.
    H.ptyEvents.emit("session_exit", { sessionId: result.sessionId, exitCode: 0, signal: null });
    const deadline = Date.now() + 2000;
    let status: string | null = null;
    while (Date.now() < deadline) {
      const row = db()
        .prepare("SELECT last_status FROM cron_jobs WHERE id = ?")
        .get(job.id) as { last_status: string | null };
      status = row.last_status;
      if (status === "ok") break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(status).toBe("ok");
  });
});

describe("CRUD round-trip", () => {
  it("생성 → 목록/조회에 보존 + next_run_at 채워짐 + 기본값", async () => {
    const app = buildApp();
    const job = await createJob(app);
    expect(job.agent).toBe("claude_code");
    expect(job.command).toBe("어제 한 일 요약해줘");
    expect(job.skip_permissions).toBe(1); // 무인 실행 기본 ON
    expect(job.session_mode).toBe("fresh");
    expect(job.overlap_policy).toBe("skip");
    expect(job.enabled).toBe(1);
    expect(job.next_run_at).toBeGreaterThan(Date.now()); // 스케줄러가 계산

    const list = await jsonAs<{ jobs: CronJob[] }>(
      await app.request("/api/cron", { headers: AUTH }),
    );
    expect(list.jobs).toHaveLength(1);

    const got = await jsonAs<{ job: CronJob; runs: unknown[] }>(
      await app.request(`/api/cron/${job.id}`, { headers: AUTH }),
    );
    expect(got.job.id).toBe(job.id);
    expect(got.runs).toEqual([]);
  });

  it("PATCH enabled=false 면 next_run_at 이 비워진다", async () => {
    const app = buildApp();
    const job = await createJob(app);
    const res = await app.request(`/api/cron/${job.id}`, {
      method: "PATCH",
      headers: AUTH,
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(200);
    const patched = (await jsonAs<{ job: CronJob }>(res)).job;
    expect(patched.enabled).toBe(0);
    expect(patched.next_run_at).toBeNull();
  });

  it("PATCH 잘못된 식이면 400, 기존 값 유지", async () => {
    const app = buildApp();
    const job = await createJob(app);
    const res = await app.request(`/api/cron/${job.id}`, {
      method: "PATCH",
      headers: AUTH,
      body: JSON.stringify({ schedule: "??" }),
    });
    expect(res.status).toBe(400);
    const got = (await jsonAs<{ job: CronJob }>(await app.request(`/api/cron/${job.id}`, { headers: AUTH }))).job;
    expect(got.schedule).toBe("0 9 * * 1-5");
  });

  it("DELETE 후 404", async () => {
    const app = buildApp();
    const job = await createJob(app);
    expect((await app.request(`/api/cron/${job.id}`, { method: "DELETE", headers: AUTH })).status).toBe(200);
    expect((await app.request(`/api/cron/${job.id}`, { headers: AUTH })).status).toBe(404);
  });
});

describe("POST /api/cron/:id/run — 지금 실행", () => {
  it("세션을 만들고 running + sessionId 반환 → turn_complete 로 ok 기록", async () => {
    const app = buildApp();
    const job = await createJob(app);
    const res = await app.request(`/api/cron/${job.id}/run`, { method: "POST", headers: AUTH });
    expect(res.status).toBe(200);
    const result = await jsonAs<{ status: string; sessionId: string }>(res);
    expect(result.status).toBe("running");
    expect(result.sessionId).toMatch(/^[0-9a-f-]{36}$/);

    // 세션이 실제로 DB 에 생겼고 cron 제목 prefix 가 붙는다.
    const sess = db()
      .prepare("SELECT title, agent FROM sessions WHERE id = ?")
      .get(result.sessionId) as { title: string; agent: string };
    expect(sess.title.startsWith("⏰")).toBe(true);
    expect(sess.agent).toBe("claude_code");

    // executor 가 완료 신호를 기다리는 중 — turn_complete 를 쏴서 마무리시킨다.
    H.ptyEvents.emit("turn_complete", { sessionId: result.sessionId, elapsedMs: 1234 });

    // finalizeRun 이 비동기로 run/job 상태를 'ok' 로 기록할 때까지 폴링.
    const deadline = Date.now() + 2000;
    let status: string | null = null;
    while (Date.now() < deadline) {
      const row = db()
        .prepare("SELECT last_status FROM cron_jobs WHERE id = ?")
        .get(job.id) as { last_status: string | null };
      status = row.last_status;
      if (status === "ok") break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(status).toBe("ok");

    const runs = db()
      .prepare("SELECT status, session_id FROM cron_runs WHERE cron_job_id = ?")
      .all(job.id) as { status: string; session_id: string }[];
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("ok");
    expect(runs[0]?.session_id).toBe(result.sessionId);
  });

  it("직전 실행 세션이 살아 있어도(PTY active) 새 실행을 건너뛰지 않는다", async () => {
    // 회귀(사용자 보고): 예전엔 overlap='skip' 가 «직전 세션의 PTY 활성(isPtyActive)» 으로
    // 실행 중 여부를 판단해서, 사용자가 그 cron 결과 세션을 iOS 에서 열면 prewarm 으로 PTY 가
    // 다시 살아나 — 실행과 무관하게 — active 가 됐고, 그 결과 다음 예약이 계속 skip 됐다.
    // 이제 overlap 은 «실제 in-flight cron 실행» 만 본다: 살아 있는 직전 세션은 skip 을 안 부른다.
    const app = buildApp();
    const job = await createJob(app); // overlap_policy 기본 'skip'

    // 직전 실행이 세션을 남겼고, 사용자가 열어 그 세션 PTY 가 active 인 상황을 흉내낸다.
    db().prepare("UPDATE cron_jobs SET last_session_id = 'prev-session' WHERE id = ?").run(job.id);
    vi.mocked(isPtyActive).mockReturnValue(true);
    try {
      const res = await app.request(`/api/cron/${job.id}/run`, { method: "POST", headers: AUTH });
      expect(res.status).toBe(200);
      const result = await jsonAs<{ status: string; sessionId: string }>(res);
      // 핵심: skip 이 아니라 새 세션을 만들고 실행에 들어가야 한다.
      expect(result.status).toBe("running");
      expect(result.sessionId).toMatch(/^[0-9a-f-]{36}$/);
      // 백그라운드 finalizeRun 을 settle 시켜 누수 없이 마무리.
      H.ptyEvents.emit("turn_complete", { sessionId: result.sessionId, elapsedMs: 1 });
    } finally {
      vi.mocked(isPtyActive).mockReturnValue(false);
    }
  });

  it("직전 cron 실행이 in-flight 면 overlap 으로 skip + skipReason='overlap'", async () => {
    // overlap_policy 기본 'skip' — 한 실행이 아직 turn 완료를 기다리는 중(in-flight)에 다시
    // 「지금 실행」 을 누르면 새 세션을 만들지 않고 사유 코드와 함께 건너뛴다. iOS 는 이 코드로
    // «직전 실행이 아직 진행 중» 안내를 로컬라이즈한다.
    const app = buildApp();
    const job = await createJob(app);

    // 1) 첫 실행 — turn_complete 를 «안» 쏴서 in-flight 로 붙들어 둔다.
    const first = await jsonAs<{ status: string; sessionId: string }>(
      await app.request(`/api/cron/${job.id}/run`, { method: "POST", headers: AUTH }),
    );
    expect(first.status).toBe("running");

    // 2) 두 번째 실행 — overlap 으로 skip + 사유 코드.
    const second = await jsonAs<{ status: string; sessionId: string | null; skipReason?: string }>(
      await app.request(`/api/cron/${job.id}/run`, { method: "POST", headers: AUTH }),
    );
    expect(second.status).toBe("skipped");
    expect(second.sessionId).toBeNull();
    expect(second.skipReason).toBe("overlap");

    // skip 도 cron_runs 에 한 줄 남고 사유(이력/디버그용 한국어)가 기록된다.
    const skipped = db()
      .prepare("SELECT status, error FROM cron_runs WHERE cron_job_id = ? AND status = 'skipped'")
      .all(job.id) as { status: string; error: string }[];
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.error).toContain("직전 실행");

    // 첫 실행을 settle 시켜 누수 없이 마무리.
    H.ptyEvents.emit("turn_complete", { sessionId: first.sessionId, elapsedMs: 1 });
  });
});
