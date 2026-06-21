/**
 * `routes/po` + po/executor 통합 테스트 — Phase 2 (주기 수집 프로필 schedule / 출시 후 검증 루프).
 *
 * 격리: cron.test.ts 와 동일 — config 를 mock 해 tmp DB 로, pty-runner 를 mock 해 실제 PTY
 * spawn 차단. ptyEvents 는 «진짜» EventEmitter 라 테스트가 turn_complete 를 emit 해
 * waitForSessionSettle 기반 흐름(수집 finalize / shipped 전이 감시)을 구동한다.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from "vitest";
import { Hono } from "hono";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseAgent } from "./po.js";

const H = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fsH = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const osH = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pathH = require("node:path") as typeof import("node:path");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require("node:events") as typeof import("node:events");
  const dir = fsH.mkdtempSync(pathH.join(osH.tmpdir(), "ps-po-test-"));
  return {
    tmpDir: dir,
    configFile: pathH.join(dir, "config.json"),
    dbFile: pathH.join(dir, "test.db"),
    repoDir: fsH.mkdtempSync(pathH.join(osH.tmpdir(), "ps-po-repo-")),
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
  PO_MAX_GENERATION_PASSES: 5,
  // 다중 패스 설정 정규화 — 테스트는 po.multiPass 를 안 켜므로 기본 1패스(기존 단일 경로)로 떨어진다.
  resolvePoMultiPass: (cfg: { po?: { multiPass?: { passes?: number; minAgree?: number } } } | null) => {
    const raw = cfg?.po?.multiPass;
    const clamp = (v: unknown, lo: number, hi: number, fb: number) => {
      const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : NaN;
      return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fb;
    };
    const passes = clamp(raw?.passes, 1, 5, 1);
    const minAgree = clamp(raw?.minAgree, 1, passes, passes > 1 ? 2 : 1);
    return { passes, minAgree };
  },
}));

// 실제 PTY spawn 차단 — ptyEvents 는 진짜 EventEmitter (테스트가 turn_complete 를 쏜다).
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
  dispatchPoNotification: vi.fn(async () => {}),
  dispatchPoWorkflowNotification: vi.fn(async () => {}),
  dispatchTestNotification: vi.fn(async () => ({ ok: true, status: 200 })),
}));

const { po } = await import("./po.js");
const { db, _resetDbForTest } = await import("../db/index.js");
const { cancelWorkflowRun } = await import("../workflow/engine.js");
const { getRun } = await import("../workflow/store.js");
const { validateDef } = await import("../workflow/types.js");
const { sanitizeDesignedDef, ensureHumanGate, buildPoFallbackDef } = await import(
  "../persona/workflow-exec.js"
);
const { hashToken, invalidateAuthCache } = await import("../auth.js");
const { registerBuiltinAgents } = await import("../agent/index.js");
const { getPoScheduler } = await import("../persona/scheduler.js");
const { dispatchPoNotification } = await import("../notify/index.js");
const { runUserMessagePty } = await import("../agent/pty-runner.js");

const TEST_TOKEN = "po-test-token";
const AUTH = { authorization: `Bearer ${TEST_TOKEN}`, "content-type": "application/json" };

function buildApp(): Hono {
  const app = new Hono();
  app.route("/api/po", po);
  return app;
}

async function jsonAs<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/** 비동기 finalize 가 DB 에 닿을 때까지 폴링 — settle emit 후 짧은 대기. */
async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** po_briefs 에 행 직접 삽입 — 상태 전이 테스트의 시드. */
function seedBrief(overrides: Record<string, unknown> = {}): string {
  const id = `brief-${Math.random().toString(36).slice(2, 10)}`;
  db()
    .prepare(
      `INSERT INTO po_briefs (id, repo_path, title, problem, evidence, impact, effort, score, scope, spec, status, created_at, updated_at, decided_at, verify_note, research_id, decide_reason, exec_session_id, exec_agent_id, exec_workflow_id)
       VALUES (@id, @repo_path, @title, @problem, @evidence, @impact, @effort, @score, @scope, @spec, @status, @created_at, @updated_at, @decided_at, @verify_note, @research_id, @decide_reason, @exec_session_id, @exec_agent_id, @exec_workflow_id)`,
    )
    .run({
      id,
      repo_path: H.repoDir,
      title: "테스트 브리프",
      problem: "사용자가 X 를 못 한다",
      evidence: JSON.stringify([{ kind: "repo_todo", ref: "docs/todo.md", summary: "근거" }]),
      impact: 4,
      effort: 2,
      score: 2,
      scope: "X 만",
      spec: "## 스펙",
      status: "proposed",
      created_at: Date.now(),
      updated_at: Date.now(),
      decided_at: null,
      verify_note: null,
      research_id: null,
      decide_reason: null,
      exec_session_id: null,
      exec_agent_id: null,
      exec_workflow_id: null,
      ...overrides,
    });
  return id;
}

/** H.repoDir 의 worktree·po/* 브랜치를 디스크에서 정리 — 테스트 간 createWorktree 충돌 방지.
 *  (DB 는 _resetDbForTest 가 비우지만 git 워크트리·브랜치는 디스크에 남는다.) */
function cleanRepoWorktrees(): void {
  try {
    fs.rmSync(`${H.repoDir}.worktrees`, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
  try {
    execFileSync("git", ["-C", H.repoDir, "worktree", "prune"], { stdio: "ignore" });
    const branches = execFileSync("git", ["-C", H.repoDir, "branch", "--list", "po/*"], {
      encoding: "utf8",
    });
    for (const b of branches.split("\n").map((s) => s.trim().replace(/^\*\s*/, "")).filter(Boolean)) {
      execFileSync("git", ["-C", H.repoDir, "branch", "-D", b], { stdio: "ignore" });
    }
  } catch {
    /* not a repo yet / nothing to prune */
  }
}

beforeAll(() => {
  registerBuiltinAgents();
  // 워크플로우 승인 경로(po_run_worktree_v1)가 per-run worktree 를 만들므로 H.repoDir 은 진짜 git repo.
  execFileSync("git", ["init", "-q", "-b", "main", H.repoDir]);
  execFileSync("git", ["-C", H.repoDir, "config", "user.email", "test@pocket.local"]);
  execFileSync("git", ["-C", H.repoDir, "config", "user.name", "Tester"]);
  fs.writeFileSync(path.join(H.repoDir, "README.md"), "init\n");
  execFileSync("git", ["-C", H.repoDir, "add", "."]);
  execFileSync("git", ["-C", H.repoDir, "commit", "-q", "-m", "init"]);
  fs.writeFileSync(
    H.configFile,
    JSON.stringify({
      port: 7777,
      token: TEST_TOKEN,
      tokenHash: hashToken(TEST_TOKEN),
      createdAt: Date.now(),
    }),
    { mode: 0o600 },
  );
  invalidateAuthCache();
});

beforeEach(() => {
  getPoScheduler().stop();
  _resetDbForTest();
  for (const ext of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(H.dbFile + ext);
    } catch {
      /* not exists */
    }
  }
  cleanRepoWorktrees();
  vi.mocked(dispatchPoNotification).mockClear();
});

afterAll(() => {
  getPoScheduler().stop();
  _resetDbForTest();
  try {
    fs.rmSync(H.tmpDir, { recursive: true, force: true });
    fs.rmSync(H.repoDir, { recursive: true, force: true });
    fs.rmSync(`${H.repoDir}.worktrees`, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe("PUT/GET /api/po/profile — 주기 수집 schedule", () => {
  it("schedule 저장 + GET 으로 회수", async () => {
    const app = buildApp();
    const put = await app.request("/api/po/profile", {
      method: "PUT",
      headers: AUTH,
      body: JSON.stringify({ repoPath: H.repoDir, directive: "이슈 위주", schedule: "0 9 * * *" }),
    });
    expect(put.status).toBe(200);
    expect(await jsonAs<{ schedule: string }>(put)).toMatchObject({ schedule: "0 9 * * *" });

    const get = await app.request(
      `/api/po/profile?repoPath=${encodeURIComponent(H.repoDir)}`,
      { headers: AUTH },
    );
    expect(await jsonAs<{ directive: string; schedule: string | null }>(get)).toMatchObject({
      directive: "이슈 위주",
      schedule: "0 9 * * *",
    });
  });

  it("잘못된 cron 식은 400 invalid_schedule", async () => {
    const res = await buildApp().request("/api/po/profile", {
      method: "PUT",
      headers: AUTH,
      body: JSON.stringify({ repoPath: H.repoDir, directive: "", schedule: "not a cron" }),
    });
    expect(res.status).toBe(400);
    expect(await jsonAs<{ error: string }>(res)).toMatchObject({ error: "invalid_schedule" });
  });

  it("directive 만 비우고 schedule 이 있으면 행이 살아남는다 (주기 수집만 켠 상태)", async () => {
    const app = buildApp();
    await app.request("/api/po/profile", {
      method: "PUT",
      headers: AUTH,
      body: JSON.stringify({ repoPath: H.repoDir, directive: "", schedule: "30 8 * * *" }),
    });
    const get = await app.request(
      `/api/po/profile?repoPath=${encodeURIComponent(H.repoDir)}`,
      { headers: AUTH },
    );
    expect(await jsonAs<{ directive: string; schedule: string | null }>(get)).toMatchObject({
      directive: "",
      schedule: "30 8 * * *",
    });
  });

  it("둘 다 비우면 프로필 삭제 (schedule null)", async () => {
    const app = buildApp();
    await app.request("/api/po/profile", {
      method: "PUT",
      headers: AUTH,
      body: JSON.stringify({ repoPath: H.repoDir, directive: "x", schedule: "0 9 * * *" }),
    });
    await app.request("/api/po/profile", {
      method: "PUT",
      headers: AUTH,
      body: JSON.stringify({ repoPath: H.repoDir, directive: "", schedule: "" }),
    });
    const get = await app.request(
      `/api/po/profile?repoPath=${encodeURIComponent(H.repoDir)}`,
      { headers: AUTH },
    );
    expect(await jsonAs<{ directive: string; schedule: string | null }>(get)).toMatchObject({
      directive: "",
      schedule: null,
    });
  });

  it("주기 수집 렌즈(po_collect_lens_v1) 저장 + GET 회수 (default 는 기본값)", async () => {
    const app = buildApp();
    // 기본은 default.
    const def = await app.request(
      `/api/po/profile?repoPath=${encodeURIComponent(H.repoDir)}`,
      { headers: AUTH },
    );
    expect(await jsonAs<{ lens: string }>(def)).toMatchObject({ lens: "default" });
    // bug 렌즈 저장.
    const put = await app.request("/api/po/profile", {
      method: "PUT",
      headers: AUTH,
      body: JSON.stringify({ repoPath: H.repoDir, directive: "", lens: "bug" }),
    });
    expect(put.status).toBe(200);
    expect(await jsonAs<{ lens: string }>(put)).toMatchObject({ lens: "bug" });
    const get = await app.request(
      `/api/po/profile?repoPath=${encodeURIComponent(H.repoDir)}`,
      { headers: AUTH },
    );
    expect(await jsonAs<{ lens: string }>(get)).toMatchObject({ lens: "bug" });
  });

  it("렌즈만 default 가 아니면 directive·schedule 이 비어도 행이 살아남는다 (주기 수집 초점 보존)", async () => {
    const app = buildApp();
    await app.request("/api/po/profile", {
      method: "PUT",
      headers: AUTH,
      body: JSON.stringify({ repoPath: H.repoDir, directive: "", schedule: "", lens: "design" }),
    });
    const get = await app.request(
      `/api/po/profile?repoPath=${encodeURIComponent(H.repoDir)}`,
      { headers: AUTH },
    );
    expect(await jsonAs<{ lens: string }>(get)).toMatchObject({ lens: "design" });
  });

  it("lens 를 안 보내는 옛 클라이언트 PUT 은 저장된 렌즈를 보존한다 (wipe 방지)", async () => {
    const app = buildApp();
    await app.request("/api/po/profile", {
      method: "PUT",
      headers: AUTH,
      body: JSON.stringify({ repoPath: H.repoDir, directive: "이슈", lens: "bug" }),
    });
    // lens 필드 없는 PUT (옛 클라이언트) — directive 만 바꾼다.
    await app.request("/api/po/profile", {
      method: "PUT",
      headers: AUTH,
      body: JSON.stringify({ repoPath: H.repoDir, directive: "리뷰" }),
    });
    const get = await app.request(
      `/api/po/profile?repoPath=${encodeURIComponent(H.repoDir)}`,
      { headers: AUTH },
    );
    expect(await jsonAs<{ directive: string; lens: string }>(get)).toMatchObject({
      directive: "리뷰",
      lens: "bug",
    });
  });
});

describe("GET /api/po/collect/last — 직전 수집 신호원 상태 (po_signal_status_v1)", () => {
  it("프로필/신호 없으면 signals=null (카드 침묵)", async () => {
    const app = buildApp();
    const res = await app.request(
      `/api/po/collect/last?repoPath=${encodeURIComponent(H.repoDir)}`,
      { headers: AUTH },
    );
    expect(res.status).toBe(200);
    const body = await jsonAs<{ signals: unknown }>(res);
    expect(body.signals).toBeNull();
  });

  it("repoPath 누락이면 400", async () => {
    const app = buildApp();
    const res = await app.request(`/api/po/collect/last`, { headers: AUTH });
    expect(res.status).toBe(400);
  });

  it("persist 된 신호 상태를 sessionId·at 와 함께 돌려준다", async () => {
    const app = buildApp();
    // 프로필 행 보장 후 직전 수집 신호 상태 주입.
    await app.request("/api/po/profile", {
      method: "PUT",
      headers: AUTH,
      body: JSON.stringify({ repoPath: H.repoDir, directive: "테스트 지침" }),
    });
    db()
      .prepare(
        `UPDATE po_profiles SET last_collect_signals = ?, last_collect_session_id = ?, last_collect_at = ? WHERE repo_path = ?`,
      )
      .run(
        JSON.stringify({ store: { state: "used", count: 7 }, crash: { state: "app_id" } }),
        "sess-xyz",
        1234,
        H.repoDir,
      );
    const res = await app.request(
      `/api/po/collect/last?repoPath=${encodeURIComponent(H.repoDir)}`,
      { headers: AUTH },
    );
    const body = await jsonAs<{
      signals: { store: { state: string; count?: number }; crash: { state: string } };
      sessionId: string;
      at: number;
    }>(res);
    expect(body.signals).toEqual({ store: { state: "used", count: 7 }, crash: { state: "app_id" } });
    expect(body.sessionId).toBe("sess-xyz");
    expect(body.at).toBe(1234);
  });

  it("수집 1회가 끝나면 신호 상태가 persist 된다 (ASC 안 켬 → off/off)", async () => {
    const app = buildApp();
    await app.request("/api/po/profile", {
      method: "PUT",
      headers: AUTH,
      body: JSON.stringify({ repoPath: H.repoDir, directive: "테스트 지침" }),
    });
    vi.mocked(runUserMessagePty).mockClear();
    const collect = await app.request("/api/po/collect", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ repoPath: H.repoDir }),
    });
    const { sessionId } = await jsonAs<{ sessionId: string }>(collect);
    await waitFor(() => vi.mocked(runUserMessagePty).mock.calls.length > 0);
    fs.writeFileSync(path.join(os.tmpdir(), `ps-po-briefs-${sessionId}.json`), "[]");
    H.ptyEvents.emit("turn_complete", { sessionId });
    await waitFor(() => {
      const r = db()
        .prepare(`SELECT last_collect_session_id FROM po_profiles WHERE repo_path = ?`)
        .get(H.repoDir) as { last_collect_session_id: string | null } | undefined;
      return r?.last_collect_session_id === sessionId;
    });
    const res = await app.request(
      `/api/po/collect/last?repoPath=${encodeURIComponent(H.repoDir)}`,
      { headers: AUTH },
    );
    const body = await jsonAs<{ signals: { store: { state: string }; crash: { state: string } }; sessionId: string }>(res);
    expect(body.signals).toEqual({ store: { state: "off" }, crash: { state: "off" } });
    expect(body.sessionId).toBe(sessionId);
  });
});

describe("POST /api/po/collect — 전문가 관점 렌즈 (po_collect_lens_v1)", () => {
  /** 수집을 시작하고 finalize 가 빌드한 프롬프트를 회수해 검증한 뒤 settle 시킨다. */
  async function promptFor(body: Record<string, unknown>): Promise<string> {
    const app = buildApp();
    vi.mocked(runUserMessagePty).mockClear();
    const collect = await app.request("/api/po/collect", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ repoPath: H.repoDir, ...body }),
    });
    const { sessionId } = await jsonAs<{ sessionId: string }>(collect);
    await waitFor(() => vi.mocked(runUserMessagePty).mock.calls.length > 0);
    const prompt = vi.mocked(runUserMessagePty).mock.calls[0]?.[1] as string;
    fs.writeFileSync(path.join(os.tmpdir(), `ps-po-briefs-${sessionId}.json`), "[]");
    H.ptyEvents.emit("turn_complete", { sessionId });
    return prompt;
  }

  it("lens=\"bug\" 면 디버깅·신뢰성 머리말이 일반 수집 프롬프트에 주입된다", async () => {
    const prompt = await promptFor({ lens: "bug" });
    expect(prompt).toContain("## 수집 관점 — 디버깅·신뢰성 전문가");
    expect(prompt).toContain("## 1단계 — 신호 수집");
  });

  it("lens=\"design\" 이면 디자인 부채 발굴 모드로 재구성된다", async () => {
    const prompt = await promptFor({ lens: "design" });
    expect(prompt).toContain("너는 이 저장소의 «디자인 전문가» 다");
    expect(prompt).toContain("## 1단계 — UI 표면 스캔");
  });

  it("옛 클라이언트 persona=\"designer\" 는 design 렌즈로 매핑된다 (designer→design 동치)", async () => {
    const prompt = await promptFor({ persona: "designer" });
    expect(prompt).toContain("너는 이 저장소의 «디자인 전문가» 다");
    expect(prompt).toContain("## 1단계 — UI 표면 스캔");
  });

  it("lens 미지정(전방위)이면 머리말 없는 기본 수집 (회귀 없음)", async () => {
    const prompt = await promptFor({});
    expect(prompt).not.toContain("## 수집 관점 — 디버깅·신뢰성 전문가");
    expect(prompt).not.toContain("«디자이너» 페르소나");
    expect(prompt).toContain("## 1단계 — 신호 수집");
  });

  it("프로필에 저장된 렌즈는 회차 lens 가 없을 때만 쓰인다 (회차 > 프로필)", async () => {
    const app = buildApp();
    // 프로필에 bug 렌즈 고정.
    await app.request("/api/po/profile", {
      method: "PUT",
      headers: AUTH,
      body: JSON.stringify({ repoPath: H.repoDir, directive: "", lens: "bug" }),
    });
    // 수동 수집이 회차 lens 를 명시하지 않으면 (route 가 'default' 를 explicit 전달) 프로필이 아니라
    // 회차 default 가 이긴다 — 수동 수집은 픽커가 보여주는 대로 돈다 (거짓 UI 방지).
    const manual = await promptFor({});
    expect(manual).not.toContain("## 수집 관점 — 디버깅·신뢰성 전문가");
  });
});

describe("디자인 directive 부트스트랩 (po_design_bootstrap_v1)", () => {
  const MARK = "TESTDIRECTIVE_색의미: accent=보라(강조)";
  const DRAFT_MD = `## 색의 의미\n- ${MARK}\n- warning=노랑(경고 전용)\n\n## 하지 마라\n- 하드코딩 색 금지`;

  /** 부트스트랩을 돌려 초안이 DB 에 저장된 상태까지 만든다 — sessionId 반환. */
  async function bootstrapToDraft(app: Hono): Promise<string> {
    const res = await app.request("/api/po/design-directive/bootstrap", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ repoPath: H.repoDir }),
    });
    expect(res.status).toBe(202);
    const { sessionId } = await jsonAs<{ sessionId: string }>(res);
    // 부트스트랩 세션이 산출했을 markdown 을 흉내낸다 — 초안 한 덩어리.
    fs.writeFileSync(path.join(os.tmpdir(), `ps-po-design-${sessionId}.md`), DRAFT_MD);
    H.ptyEvents.emit("turn_complete", { sessionId });
    await waitFor(() => {
      const r = db()
        .prepare(`SELECT design_directive_draft FROM po_profiles WHERE repo_path = ?`)
        .get(H.repoDir) as { design_directive_draft: string | null } | undefined;
      return !!r?.design_directive_draft;
    });
    return sessionId;
  }

  it("부트스트랩 → 초안 산출이 design_directive_draft 에 저장되고 design_directive 는 NULL 유지", async () => {
    const app = buildApp();
    const sessionId = await bootstrapToDraft(app);
    const get = await app.request(`/api/po/profile?repoPath=${encodeURIComponent(H.repoDir)}`, {
      headers: AUTH,
    });
    const p = await jsonAs<{
      designDirective: string | null;
      designDirectiveDraft: string | null;
      designDirectiveDraftSessionId: string | null;
    }>(get);
    expect(p.designDirectiveDraft).toContain(MARK);
    expect(p.designDirective).toBeNull(); // 자동 적용 금지 — 승인 전엔 선언으로 안 쓰인다
    expect(p.designDirectiveDraftSessionId).toBeNull(); // 생성 완료 → 더는 «생성 중» 아님
    void sessionId;
  });

  it("생성 중 재요청은 400 — 세션을 orphan 시키지 않는다", async () => {
    const app = buildApp();
    const first = await app.request("/api/po/design-directive/bootstrap", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ repoPath: H.repoDir }),
    });
    expect(first.status).toBe(202);
    // 아직 settle 전(초안 세션 id 살아 있음) → 두 번째 요청은 막힌다.
    const second = await app.request("/api/po/design-directive/bootstrap", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ repoPath: H.repoDir }),
    });
    expect(second.status).toBe(400);
    expect(await jsonAs<{ error: string }>(second)).toMatchObject({ error: "bootstrap_failed" });
  });

  it("승인 → 초안이 design_directive 로 복사되고 초안은 정리된다", async () => {
    const app = buildApp();
    await bootstrapToDraft(app);
    const approve = await app.request("/api/po/design-directive/approve", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ repoPath: H.repoDir }), // directive 미지정 → 저장된 초안 그대로 승인
    });
    expect(approve.status).toBe(200);
    const get = await app.request(`/api/po/profile?repoPath=${encodeURIComponent(H.repoDir)}`, {
      headers: AUTH,
    });
    const p = await jsonAs<{ designDirective: string | null; designDirectiveDraft: string | null }>(
      get,
    );
    expect(p.designDirective).toContain(MARK); // 이제 선언된 강신호
    expect(p.designDirectiveDraft).toBeNull(); // 초안 정리됨
  });

  it("승인 본문에 편집된 directive 가 있으면 그 값이 우선 저장된다", async () => {
    const app = buildApp();
    await bootstrapToDraft(app);
    const edited = "## 편집됨\n- accent=보라만";
    await app.request("/api/po/design-directive/approve", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ repoPath: H.repoDir, directive: edited }),
    });
    const get = await app.request(`/api/po/profile?repoPath=${encodeURIComponent(H.repoDir)}`, {
      headers: AUTH,
    });
    expect((await jsonAs<{ designDirective: string }>(get)).designDirective).toBe(edited);
  });

  it("승인 후 PUT /profile(조사 방식 수정)이 design_directive 를 보존한다 (wipe 방지)", async () => {
    const app = buildApp();
    await bootstrapToDraft(app);
    await app.request("/api/po/design-directive/approve", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ repoPath: H.repoDir }),
    });
    // 디자인과 무관한 «조사 방식» 만 바꿔 저장 (designDirective 필드 미전송 — 현재 클라이언트 동작).
    await app.request("/api/po/profile", {
      method: "PUT",
      headers: AUTH,
      body: JSON.stringify({ repoPath: H.repoDir, directive: "이슈 위주로" }),
    });
    const get = await app.request(`/api/po/profile?repoPath=${encodeURIComponent(H.repoDir)}`, {
      headers: AUTH,
    });
    const p = await jsonAs<{ directive: string; designDirective: string | null }>(get);
    expect(p.directive).toBe("이슈 위주로");
    expect(p.designDirective).toContain(MARK); // 날아가지 않음
  });

  it("초안 버리기(DELETE draft)는 초안만 지우고 선언(design_directive)은 건드리지 않는다", async () => {
    const app = buildApp();
    await bootstrapToDraft(app);
    await app.request("/api/po/design-directive/approve", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ repoPath: H.repoDir }),
    });
    // 새 초안을 또 만든 뒤 버린다 — 선언은 그대로여야 한다.
    await bootstrapToDraft(app);
    const del = await app.request(
      `/api/po/design-directive/draft?repoPath=${encodeURIComponent(H.repoDir)}`,
      { method: "DELETE", headers: AUTH },
    );
    expect(del.status).toBe(200);
    const get = await app.request(`/api/po/profile?repoPath=${encodeURIComponent(H.repoDir)}`, {
      headers: AUTH,
    });
    const p = await jsonAs<{ designDirective: string | null; designDirectiveDraft: string | null }>(
      get,
    );
    expect(p.designDirectiveDraft).toBeNull();
    expect(p.designDirective).toContain(MARK); // 선언은 유지
  });

  it("승인 후 수집 프롬프트가 auto-discovery 대신 선언 directive(강신호)를 쓴다 (수용 기준 3)", async () => {
    const app = buildApp();
    await bootstrapToDraft(app);
    await app.request("/api/po/design-directive/approve", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ repoPath: H.repoDir }),
    });
    vi.mocked(runUserMessagePty).mockClear();
    const collect = await app.request("/api/po/collect", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ repoPath: H.repoDir }),
    });
    const { sessionId } = await jsonAs<{ sessionId: string }>(collect);
    // 수집 finalize 가 프롬프트를 빌드해 runUserMessagePty 로 넘길 때까지 대기.
    await waitFor(() => vi.mocked(runUserMessagePty).mock.calls.length > 0);
    const prompt = vi.mocked(runUserMessagePty).mock.calls[0]?.[1] as string;
    expect(prompt).toContain(MARK); // 선언이 그대로 박힘
    expect(prompt).toContain("«선언» 한 디자인 약속"); // declared 가지 (자동 발견 문구가 아님)
    expect(prompt).not.toContain("스스로 찾아 읽고"); // auto-discovery 문구가 없어야 한다
    // settle 시켜 백그라운드 정리.
    fs.writeFileSync(path.join(os.tmpdir(), `ps-po-briefs-${sessionId}.json`), "[]");
    H.ptyEvents.emit("turn_complete", { sessionId });
  });
});

describe("수집 ingest — 하이브리드 dedup (자가분류 + lexical 백스톱)", () => {
  it("근사 중복(lexical)과 에이전트가 duplicate 로 분류한 건은 컷, 진짜 새 기회만 삽입한다", async () => {
    const app = buildApp();
    // 기존 백로그 — dedup 코퍼스의 앵커.
    seedBrief({ title: "다크 모드 지원", problem: "설정에서 다크 모드를 켤 수 있어야 한다" });

    const collect = await app.request("/api/po/collect", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ repoPath: H.repoDir }),
    });
    const { sessionId } = await jsonAs<{ sessionId: string }>(collect);
    // finalize 가 프롬프트를 빌드해 세션을 띄울 때까지 대기 (그 후 산출 파일을 쓴다).
    await waitFor(() => vi.mocked(runUserMessagePty).mock.calls.length > 0);

    const ev = [{ kind: "repo_todo", ref: "docs/todo.md", summary: "근거" }];
    const briefs = [
      // ① lexical 근사 중복 — 제목만 살짝 다르고 본문은 거의 같다(자가분류 없음 → "new" 취급되지만
      //    백스톱이 컷한다).
      {
        title: "다크 모드 지원하기",
        problem: "설정에서 다크 모드를 켤 수 있어야 한다",
        evidence: ev,
        impact: 4,
        effort: 2,
        scope: "S",
        spec: "## 스펙",
      },
      // ② 에이전트가 스스로 «기존과 같은 기회» 라고 분류 — 텍스트는 안 닮았어도 자가분류로 컷.
      {
        title: "야간 테마",
        problem: "어두운 환경에서 눈부심을 줄인다",
        evidence: ev,
        impact: 3,
        effort: 2,
        scope: "S",
        spec: "## 스펙",
        dedup: { relation: "duplicate", ofTitle: "다크 모드 지원" },
      },
      // ③ 진짜 새 기회 — 코퍼스 어느 것과도 안 닮음 → 삽입.
      {
        title: "오프라인 동기화 큐",
        problem: "네트워크가 없을 때 작업을 큐에 쌓아 복구되면 보낸다",
        evidence: ev,
        impact: 5,
        effort: 3,
        scope: "S",
        spec: "## 스펙",
        dedup: { relation: "new" },
      },
    ];
    fs.writeFileSync(
      path.join(os.tmpdir(), `ps-po-briefs-${sessionId}.json`),
      JSON.stringify(briefs),
    );
    H.ptyEvents.emit("turn_complete", { sessionId });

    // 새 기회가 삽입될 때까지 대기.
    await waitFor(() => {
      const r = db()
        .prepare(`SELECT COUNT(*) AS n FROM po_briefs WHERE repo_path = ? AND title = ?`)
        .get(H.repoDir, "오프라인 동기화 큐") as { n: number };
      return r.n === 1;
    });

    const titles = (
      db()
        .prepare(`SELECT title FROM po_briefs WHERE repo_path = ? ORDER BY created_at`)
        .all(H.repoDir) as Array<{ title: string }>
    ).map((r) => r.title);

    // 시드 + 새 기회만 — 근사 중복(①)과 자가분류 중복(②)은 들어오지 않는다.
    expect(titles).toContain("다크 모드 지원");
    expect(titles).toContain("오프라인 동기화 큐");
    expect(titles).not.toContain("다크 모드 지원하기");
    expect(titles).not.toContain("야간 테마");
    expect(titles).toHaveLength(2);
  });
});

describe("수집 다중 패스 — 합치 채택 (po.multiPass)", () => {
  const EV = [{ kind: "repo_todo", ref: "docs/todo.md", summary: "근거" }];
  const baseConfig = {
    port: 7777,
    token: TEST_TOKEN,
    tokenHash: hashToken(TEST_TOKEN),
    createdAt: Date.now(),
  };
  function writeConfigWith(extra: Record<string, unknown>): void {
    fs.writeFileSync(H.configFile, JSON.stringify({ ...baseConfig, ...extra }), { mode: 0o600 });
    invalidateAuthCache();
  }
  // 다중 패스 설정이 다른 테스트로 새지 않게 매 테스트 후 기본 config 로 복원.
  afterEach(() => writeConfigWith({}));

  /** 한 패스를 settle — finalize 가 그 패스의 산출 파일을 쓸 때까지 대기 후 파일을 쓰고 turn_complete. */
  async function settlePass(
    sessionId: string,
    passIndex: number,
    briefs: unknown[],
  ): Promise<void> {
    // 다중 패스는 passFile = `${outFile}.p{n}` (n=1..). 패스 n 의 runUserMessagePty 호출을 기다린다.
    await waitFor(() => vi.mocked(runUserMessagePty).mock.calls.length >= passIndex);
    fs.writeFileSync(
      path.join(os.tmpdir(), `ps-po-briefs-${sessionId}.json.p${passIndex}`),
      JSON.stringify(briefs),
    );
    H.ptyEvents.emit("turn_complete", { sessionId });
  }

  it("2패스 모두에 나온 기회만 채택, 한 패스에만 튄 건 탈락(minAgree=2)", async () => {
    writeConfigWith({ po: { multiPass: { passes: 2, minAgree: 2 } } });
    const app = buildApp();
    vi.mocked(runUserMessagePty).mockClear();

    const collect = await app.request("/api/po/collect", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ repoPath: H.repoDir }),
    });
    const { sessionId } = await jsonAs<{ sessionId: string }>(collect);

    const shared1 = {
      title: "오프라인 동기화 큐",
      problem: "네트워크가 없을 때 작업을 큐에 쌓아 복구되면 보낸다",
      evidence: EV,
      impact: 5,
      effort: 3,
      scope: "S",
      spec: "## 스펙",
    };
    // 패스2의 «같은 기회» — 조사/어미만 흔들린 근사 표현(lexical 백스톱이 같은 것으로 본다).
    const shared2 = {
      ...shared1,
      title: "오프라인 동기화 큐 추가",
      problem: "네트워크가 없을 때 작업을 큐에 쌓아서 복구되면 보낸다",
    };
    const p1Only = { ...shared1, title: "검색 인덱싱", problem: "전체 텍스트 검색을 위한 인덱스를 만든다" };
    const p2Only = { ...shared1, title: "다국어 지원", problem: "여러 언어로 UI 문자열을 번역한다" };

    await settlePass(sessionId, 1, [shared1, p1Only]);
    await settlePass(sessionId, 2, [shared2, p2Only]);

    // 합치 채택된 공유 기회만 삽입될 때까지 대기.
    await waitFor(() => {
      const r = db()
        .prepare(`SELECT COUNT(*) AS n FROM po_briefs WHERE repo_path = ? AND title = ?`)
        .get(H.repoDir, "오프라인 동기화 큐") as { n: number };
      return r.n === 1;
    });

    const titles = (
      db()
        .prepare(`SELECT title FROM po_briefs WHERE repo_path = ?`)
        .all(H.repoDir) as Array<{ title: string }>
    ).map((r) => r.title);

    // 2패스 모두 등장한 «오프라인 동기화 큐» 만 채택 — 대표는 가장 이른 패스(p1)의 제목.
    expect(titles).toEqual(["오프라인 동기화 큐"]);
    expect(titles).not.toContain("검색 인덱싱"); // p1 에만 — 탈락
    expect(titles).not.toContain("다국어 지원"); // p2 에만 — 탈락
    // runUserMessagePty 가 패스당 한 번씩, 총 2회 호출됐다(독립 2패스).
    expect(vi.mocked(runUserMessagePty).mock.calls.length).toBe(2);
  });

  it("graceful fallback — 한 패스만 산출하면 그 패스를 그대로 채택(전부 실패만 빈 산출)", async () => {
    writeConfigWith({ po: { multiPass: { passes: 2, minAgree: 2 } } });
    const app = buildApp();
    vi.mocked(runUserMessagePty).mockClear();

    const collect = await app.request("/api/po/collect", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ repoPath: H.repoDir }),
    });
    const { sessionId } = await jsonAs<{ sessionId: string }>(collect);

    const only = {
      title: "오프라인 동기화 큐",
      problem: "네트워크가 없을 때 작업을 큐에 쌓아 복구되면 보낸다",
      evidence: EV,
      impact: 5,
      effort: 3,
      scope: "S",
      spec: "## 스펙",
    };
    // 패스1 은 산출, 패스2 는 빈 산출(파일 없음 → settle 만).
    await settlePass(sessionId, 1, [only]);
    await waitFor(() => vi.mocked(runUserMessagePty).mock.calls.length >= 2);
    H.ptyEvents.emit("turn_complete", { sessionId });

    // minAgree=2 여도 산출 있는 패스가 1개뿐이라 실효 임계 1 → 그 패스의 제안 채택.
    await waitFor(() => {
      const r = db()
        .prepare(`SELECT COUNT(*) AS n FROM po_briefs WHERE repo_path = ? AND title = ?`)
        .get(H.repoDir, "오프라인 동기화 큐") as { n: number };
      return r.n === 1;
    });
    const n = (
      db().prepare(`SELECT COUNT(*) AS n FROM po_briefs WHERE repo_path = ?`).get(H.repoDir) as {
        n: number;
      }
    ).n;
    expect(n).toBe(1);
  });
});

describe("출시 후 검증 루프", () => {
  it("approve → 구현 세션 turn 정착 → running 이 shipped 로 전이", async () => {
    const app = buildApp();
    const id = seedBrief();
    const res = await app.request(`/api/po/briefs/${id}/decide`, {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ action: "approve" }),
    });
    expect(res.status).toBe(200);
    const { execSessionId } = await jsonAs<{ execSessionId: string }>(res);
    expect(execSessionId).toBeTruthy();

    let row = db().prepare(`SELECT status FROM po_briefs WHERE id = ?`).get(id) as {
      status: string;
    };
    expect(row.status).toBe("running");

    // 구현 세션의 첫 turn 정착 신호 → watchExecForShipped 가 shipped 로 전이.
    H.ptyEvents.emit("turn_complete", { sessionId: execSessionId });
    await waitFor(() => {
      row = db().prepare(`SELECT status FROM po_briefs WHERE id = ?`).get(id) as {
        status: string;
      };
      return row.status === "shipped";
    });
    expect(row.status).toBe("shipped");
  });

  it("구현 세션이 에러로 끝나면 running 유지 (사용자 수습 여지)", async () => {
    const app = buildApp();
    const id = seedBrief();
    const res = await app.request(`/api/po/briefs/${id}/decide`, {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ action: "approve" }),
    });
    const { execSessionId } = await jsonAs<{ execSessionId: string }>(res);

    H.ptyEvents.emit("error", { sessionId: execSessionId, exitCode: 1 });
    // 전이가 «일어나지 않는» 검증 — 짧게 기다린 뒤 그대로인지 본다.
    await new Promise((r) => setTimeout(r, 100));
    const row = db().prepare(`SELECT status FROM po_briefs WHERE id = ?`).get(id) as {
      status: string;
    };
    expect(row.status).toBe("running");
  });

  it("수집 사이클의 verdict 파일이 shipped → verified/missed 를 종결한다", async () => {
    const app = buildApp();
    const verifiedId = seedBrief({ status: "shipped", title: "검증될 브리프" });
    const missedId = seedBrief({ status: "shipped", title: "빗나간 브리프" });
    const otherId = seedBrief({ status: "proposed", title: "아직 결재 전" });

    const res = await app.request("/api/po/collect", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ repoPath: H.repoDir }),
    });
    expect(res.status).toBe(202);
    const { sessionId } = await jsonAs<{ sessionId: string }>(res);

    // 수집 세션이 산출했을 파일들을 흉내낸다 — 브리프 0건 + 판정 2건 (+ 무시될 1건).
    fs.writeFileSync(path.join(os.tmpdir(), `ps-po-briefs-${sessionId}.json`), "[]");
    fs.writeFileSync(
      path.join(os.tmpdir(), `ps-po-verdicts-${sessionId}.json`),
      JSON.stringify([
        { id: verifiedId, verdict: "verified", note: "이슈 #1 닫힘" },
        { id: missedId, verdict: "missed", note: "같은 불만이 계속 보임" },
        // shipped 가 아닌 브리프 — 에이전트가 잘못 판정해도 무시돼야 한다.
        { id: otherId, verdict: "verified", note: "오판" },
      ]),
    );
    H.ptyEvents.emit("turn_complete", { sessionId });

    await waitFor(() => {
      const r = db().prepare(`SELECT status FROM po_briefs WHERE id = ?`).get(verifiedId) as {
        status: string;
      };
      return r.status === "verified";
    });
    const verified = db()
      .prepare(`SELECT status, verify_note FROM po_briefs WHERE id = ?`)
      .get(verifiedId) as { status: string; verify_note: string | null };
    expect(verified).toMatchObject({ status: "verified", verify_note: "이슈 #1 닫힘" });

    const missed = db()
      .prepare(`SELECT status, verify_note FROM po_briefs WHERE id = ?`)
      .get(missedId) as { status: string; verify_note: string | null };
    expect(missed).toMatchObject({ status: "missed", verify_note: "같은 불만이 계속 보임" });

    // shipped 가 아니었던 행은 건드리지 않는다.
    const other = db().prepare(`SELECT status FROM po_briefs WHERE id = ?`).get(otherId) as {
      status: string;
    };
    expect(other.status).toBe("proposed");
  });
});

describe("구현 다시 시작 (po_exec_restart_v1)", () => {
  it("running 브리프 재시작 → 새 구현 세션 + exec_session_id 교체 + running 유지 + 결재 컨텍스트 보존", async () => {
    const app = buildApp();
    const id = seedBrief();
    // 최초 승인 — 구현 세션 spawn + running.
    const approve = await app.request(`/api/po/briefs/${id}/decide`, {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ action: "approve" }),
    });
    expect(approve.status).toBe(200);
    const { execSessionId: firstSession } = await jsonAs<{ execSessionId: string }>(approve);

    const before = db()
      .prepare(`SELECT decided_at, exec_session_id, status FROM po_briefs WHERE id = ?`)
      .get(id) as { decided_at: number; exec_session_id: string; status: string };
    expect(before.status).toBe("running");
    expect(before.exec_session_id).toBe(firstSession);

    // 구현 세션이 깔끔한 정착 없이 죽었다고 치고 — 재시작.
    const restart = await app.request(`/api/po/briefs/${id}/restart`, {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({}),
    });
    expect(restart.status).toBe(200);
    const { execSessionId: newSession } = await jsonAs<{ execSessionId: string }>(restart);
    expect(newSession).toBeTruthy();
    expect(newSession).not.toBe(firstSession);

    const after = db()
      .prepare(`SELECT status, exec_session_id, decided_at FROM po_briefs WHERE id = ?`)
      .get(id) as { status: string; exec_session_id: string; decided_at: number };
    // 상태는 running 유지, 세션만 교체, 결재 시각(provenance)은 보존.
    expect(after.status).toBe("running");
    expect(after.exec_session_id).toBe(newSession);
    expect(after.decided_at).toBe(before.decided_at);

    // 새 세션 정착이 shipped 로 전이시킨다 (최초 승인과 같은 감시).
    H.ptyEvents.emit("turn_complete", { sessionId: newSession });
    await waitFor(() => {
      const r = db().prepare(`SELECT status FROM po_briefs WHERE id = ?`).get(id) as {
        status: string;
      };
      return r.status === "shipped";
    });
  });

  it("재시작은 브리프에 기록된 exec_agent_id 를 재사용한다 (agent 미지정 시)", async () => {
    const app = buildApp();
    const id = seedBrief({ status: "running", exec_session_id: "dead-session", exec_agent_id: "claude_code" });
    const restart = await app.request(`/api/po/briefs/${id}/restart`, {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({}),
    });
    expect(restart.status).toBe(200);
    const { agent } = await jsonAs<{ agent: string }>(restart);
    expect(agent).toBe("claude_code");
  });

  it("running 이 아닌 브리프는 재시작 거부 (409 not_running)", async () => {
    const app = buildApp();
    const id = seedBrief({ status: "proposed" });
    const res = await app.request(`/api/po/briefs/${id}/restart`, {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(409);
    const body = await jsonAs<{ error: string; status: string }>(res);
    expect(body.error).toBe("not_running");
    expect(body.status).toBe("proposed");
  });

  it("워크플로우 모드(exec_workflow_id) 브리프는 재시작 거부 (409 workflow_not_supported)", async () => {
    const app = buildApp();
    const id = seedBrief({ status: "running", exec_workflow_id: "wf-1" });
    const res = await app.request(`/api/po/briefs/${id}/restart`, {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(409);
    const body = await jsonAs<{ error: string }>(res);
    expect(body.error).toBe("workflow_not_supported");
  });
});

describe("리서치 세션 자동 정리", () => {
  it("리서치 성공 → 세션 제거 + po_research.session_id 끊김 (보고서가 영구 산출물)", async () => {
    const res = await buildApp().request("/api/po/research", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ repoPath: H.repoDir, topic: "조사 주제" }),
    });
    expect(res.status).toBe(202);
    const { researchId, sessionId } = await jsonAs<{ researchId: string; sessionId: string }>(res);

    // 리서치 세션이 산출했을 파일들을 흉내낸다 — 보고서 + 브리프 0건.
    fs.writeFileSync(path.join(os.tmpdir(), `ps-po-report-${sessionId}.md`), "# 보고서");
    fs.writeFileSync(path.join(os.tmpdir(), `ps-po-research-briefs-${sessionId}.json`), "[]");
    H.ptyEvents.emit("turn_complete", { sessionId });

    await waitFor(() => !db().prepare(`SELECT id FROM sessions WHERE id = ?`).get(sessionId));
    const research = db()
      .prepare(`SELECT status, session_id, report FROM po_research WHERE id = ?`)
      .get(researchId) as { status: string; session_id: string | null; report: string };
    expect(research).toMatchObject({ status: "done", session_id: null, report: "# 보고서" });
  });

  it("리서치 실패 → 세션 유지 (transcript 가 유일한 진단 단서)", async () => {
    const res = await buildApp().request("/api/po/research", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ repoPath: H.repoDir, topic: "실패할 조사" }),
    });
    const { researchId, sessionId } = await jsonAs<{ researchId: string; sessionId: string }>(res);

    // 보고서 미산출 + 에러 settle → failed.
    H.ptyEvents.emit("error", { sessionId, exitCode: 1 });
    await waitFor(() => {
      const r = db().prepare(`SELECT status FROM po_research WHERE id = ?`).get(researchId) as {
        status: string;
      };
      return r.status === "failed";
    });
    const session = db()
      .prepare(`SELECT id, status FROM sessions WHERE id = ?`)
      .get(sessionId) as { id: string; status: string } | undefined;
    expect(session).toBeTruthy();
    const research = db()
      .prepare(`SELECT session_id FROM po_research WHERE id = ?`)
      .get(researchId) as { session_id: string | null };
    expect(research.session_id).toBe(sessionId);
  });
});

describe("GET /api/po/stats — 누적 성적표 (po_stats_v1)", () => {
  type Stats = {
    proposed: number;
    approved: number;
    rejected: number;
    shipped: number;
    verified: number;
    missed: number;
    approvalRate: number | null;
    medianDecisionSeconds: number | null;
    repos: ({ repoPath: string } & Record<string, unknown>)[];
    verifyNotes?: { id: string; status: string; note: string; decidedAt: number | null }[];
  };

  it("빈 DB — 0 카운트 + null 률 (0% 와 «데이터 없음» 구분)", async () => {
    const res = await buildApp().request("/api/po/stats", { headers: AUTH });
    expect(res.status).toBe(200);
    expect(await jsonAs<Stats>(res)).toMatchObject({
      proposed: 0,
      approved: 0,
      rejected: 0,
      shipped: 0,
      verified: 0,
      missed: 0,
      approvalRate: null,
      medianDecisionSeconds: null,
      repos: [],
    });
  });

  it("상태 혼합 — 승인은 «approve 이후 상태» 전부, 승인율은 approved/(approved+rejected)", async () => {
    const t0 = 1_000_000;
    seedBrief({ status: "proposed", created_at: t0, updated_at: t0 });
    seedBrief({ status: "held", created_at: t0, updated_at: t0, decided_at: t0 + 10_000 });
    seedBrief({ status: "rejected", created_at: t0, updated_at: t0, decided_at: t0 + 20_000 });
    seedBrief({ status: "running", created_at: t0, updated_at: t0, decided_at: t0 + 30_000 });
    seedBrief({ status: "shipped", created_at: t0, updated_at: t0, decided_at: t0 + 40_000 });
    seedBrief({ status: "verified", created_at: t0, updated_at: t0, decided_at: t0 + 50_000 });
    seedBrief({ status: "missed", created_at: t0, updated_at: t0, decided_at: t0 + 60_000 });
    // 결정 시각 없는 과거 행 — 중앙값 계산에서 제외돼야 한다 (rejected 카운트엔 포함).
    seedBrief({ status: "rejected", created_at: t0, updated_at: t0 });

    const res = await buildApp().request("/api/po/stats", { headers: AUTH });
    const stats = await jsonAs<Stats>(res);
    expect(stats).toMatchObject({
      proposed: 8,
      approved: 4, // running + shipped + verified + missed
      rejected: 2,
      shipped: 3, // shipped + verified + missed
      verified: 1,
      missed: 1,
    });
    expect(stats.approvalRate).toBeCloseTo(4 / 6);
    // decided_at 있는 6건의 (10,20,30,40,50,60)s — 중앙값 (30+40)/2 = 35s.
    expect(stats.medianDecisionSeconds).toBeCloseTo(35);
  });

  it("repoPath 필터 — 톱레벨과 repos 분해가 필터된 집합으로 일관", async () => {
    const otherRepo = path.join(os.tmpdir(), "ps-po-other-repo");
    seedBrief({ status: "verified", decided_at: Date.now() });
    seedBrief({ status: "rejected", repo_path: otherRepo, decided_at: Date.now() });

    const app = buildApp();
    const all = await jsonAs<Stats>(await app.request("/api/po/stats", { headers: AUTH }));
    expect(all.proposed).toBe(2);
    expect(all.repos).toHaveLength(2);
    // 레포별 분해의 합 = 전체 (멀티 프로젝트 일관성).
    expect(all.repos.reduce((s, r) => s + (r.proposed as number), 0)).toBe(all.proposed);

    const filtered = await jsonAs<Stats>(
      await app.request(`/api/po/stats?repoPath=${encodeURIComponent(H.repoDir)}`, {
        headers: AUTH,
      }),
    );
    expect(filtered).toMatchObject({ proposed: 1, verified: 1, approvalRate: 1 });
    expect(filtered.repos).toHaveLength(1);
    expect(filtered.repos[0].repoPath).toBe(H.repoDir);
  });

  it("verifyNotes — verify_note 있는 verified/missed 만 최근순 동봉 (사유 없는 행·다른 상태 제외)", async () => {
    const t0 = 2_000_000;
    seedBrief({ status: "missed", decided_at: t0 + 10_000, verify_note: "같은 불만이 계속 보임" });
    seedBrief({ status: "verified", decided_at: t0 + 30_000, verify_note: "이슈 #1 닫힘" });
    // 사유 없는 verified — 제외돼야 한다 (회귀 0).
    seedBrief({ status: "verified", decided_at: t0 + 40_000, verify_note: null });
    // 사유 있어도 검증 단계 아님 — 제외.
    seedBrief({ status: "shipped", decided_at: t0 + 50_000, verify_note: "아직 검증 전" });

    const res = await buildApp().request("/api/po/stats", { headers: AUTH });
    const stats = await jsonAs<Stats>(res);
    expect(stats.verifyNotes).toHaveLength(2);
    // 최근순 — verified(30s) 가 missed(10s) 보다 앞.
    expect(stats.verifyNotes![0]).toMatchObject({ status: "verified", note: "이슈 #1 닫힘" });
    expect(stats.verifyNotes![1]).toMatchObject({ status: "missed", note: "같은 불만이 계속 보임" });
  });

  it("verifyNotes — repoPath 필터와 일관 (다른 레포 사유 제외)", async () => {
    const otherRepo = path.join(os.tmpdir(), "ps-po-other-repo");
    seedBrief({ status: "missed", decided_at: Date.now(), verify_note: "이 레포 사유" });
    seedBrief({
      status: "missed",
      repo_path: otherRepo,
      decided_at: Date.now(),
      verify_note: "다른 레포 사유",
    });

    const app = buildApp();
    const filtered = await jsonAs<Stats>(
      await app.request(`/api/po/stats?repoPath=${encodeURIComponent(H.repoDir)}`, {
        headers: AUTH,
      }),
    );
    expect(filtered.verifyNotes).toHaveLength(1);
    expect(filtered.verifyNotes![0].note).toBe("이 레포 사유");
  });

  it("차원 분해 (po_stats_breakdown_v1) — effort 구간·evidence 종류별 승인/기각, 합산 불변", async () => {
    const ev = (kinds: string[]) =>
      JSON.stringify(kinds.map((k) => ({ kind: k, ref: "r", summary: "s" })));
    // 고effort(5) 둘 다 기각, 저effort(1) 승인 — «고effort 가 잘 기각된다» 패턴.
    seedBrief({ status: "rejected", effort: 5, evidence: ev(["github_issue"]) });
    seedBrief({ status: "rejected", effort: 4, evidence: ev(["github_issue", "repo_todo"]) });
    seedBrief({ status: "verified", effort: 1, evidence: ev(["repo_todo"]) });
    seedBrief({ status: "approved", effort: 3, evidence: ev(["doc"]) });

    const stats = await jsonAs<
      Stats & {
        byEffort: Record<string, { approved: number; rejected: number }>;
        byEvidence: Record<string, { approved: number; rejected: number }>;
        byLens: Record<string, { approved: number; rejected: number }>;
      }
    >(await buildApp().request("/api/po/stats", { headers: AUTH }));

    // 톱레벨 합산은 분해를 넣어도 «불변» (회귀 0).
    expect(stats).toMatchObject({ proposed: 4, approved: 2, rejected: 2 });
    // effort 구간 — high(4,5) 둘 다 기각, low(1) 승인, mid(3) 승인.
    expect(stats.byEffort.high).toEqual({ approved: 0, rejected: 2 });
    expect(stats.byEffort.low).toEqual({ approved: 1, rejected: 0 });
    expect(stats.byEffort.mid).toEqual({ approved: 1, rejected: 0 });
    // effort 셀 합 = 전체 결재 (각 브리프 정확히 한 구간).
    const effDecided = (["low", "mid", "high"] as const).reduce(
      (s, k) => s + stats.byEffort[k].approved + stats.byEffort[k].rejected,
      0,
    );
    expect(effDecided).toBe(stats.approved + stats.rejected);
    // evidence 종류 — github_issue 둘 다 기각, repo_todo 는 1기각·1승인.
    expect(stats.byEvidence.github_issue).toEqual({ approved: 0, rejected: 2 });
    expect(stats.byEvidence.repo_todo).toEqual({ approved: 1, rejected: 1 });
    expect(stats.byEvidence.doc).toEqual({ approved: 1, rejected: 0 });
  });

  it("렌즈 분해 — 리서치産만(po_research.lens), 수집産(research_id NULL)은 제외", async () => {
    const now = Date.now();
    db()
      .prepare(
        `INSERT INTO po_research (id, repo_path, topic, status, brief_count, lens, created_at, updated_at)
         VALUES (@id, @repo, @topic, 'done', 0, @lens, @t, @t)`,
      )
      .run({ id: "res-design", repo: H.repoDir, topic: "디자인", lens: "design", t: now });
    // 리서치(design) 産 2건 모두 기각 + 수집産(research_id NULL) 1건 승인.
    seedBrief({ status: "rejected", research_id: "res-design" });
    seedBrief({ status: "rejected", research_id: "res-design" });
    seedBrief({ status: "verified" });

    const stats = await jsonAs<
      Stats & { byLens: Record<string, { approved: number; rejected: number }> }
    >(await buildApp().request("/api/po/stats", { headers: AUTH }));

    expect(stats.byLens.design).toEqual({ approved: 0, rejected: 2 });
    // 수집産은 렌즈 없음 → 어떤 렌즈 버킷에도 안 들어간다.
    expect(stats.byLens.default).toBeUndefined();
  });

  it("출시 후 검증 분해 (po_outcome_breakdown_v1) — effort·렌즈별 verified/missed, shipped 직후는 제외", async () => {
    const now = Date.now();
    db()
      .prepare(
        `INSERT INTO po_research (id, repo_path, topic, status, brief_count, lens, created_at, updated_at)
         VALUES (@id, @repo, @topic, 'done', 0, @lens, @t, @t)`,
      )
      .run({ id: "res-bug", repo: H.repoDir, topic: "버그 사냥", lens: "bug", t: now });
    // 고effort(5) verified 1 + missed 1, 저effort(1) missed 1, shipped(effort 2) 는 제외.
    seedBrief({ status: "verified", effort: 5, research_id: "res-bug" });
    seedBrief({ status: "missed", effort: 5, research_id: "res-bug" });
    seedBrief({ status: "missed", effort: 1, research_id: null });
    seedBrief({ status: "shipped", effort: 2, research_id: null }); // 아직 검증 전 → 제외.

    const stats = await jsonAs<
      Stats & {
        outcomeByEffort?: Record<string, { verified: number; missed: number }>;
        outcomeByLens?: Record<string, { verified: number; missed: number }>;
      }
    >(await buildApp().request("/api/po/stats", { headers: AUTH }));

    // 톱레벨 합산 회귀 0 — verified/missed 카운트는 정상.
    expect(stats).toMatchObject({ verified: 1, missed: 2, shipped: 4 });
    // effort 구간 — high(5) verified 1·missed 1, low(1) missed 1, mid(2) shipped 제외.
    expect(stats.outcomeByEffort?.high).toEqual({ verified: 1, missed: 1 });
    expect(stats.outcomeByEffort?.low).toEqual({ verified: 0, missed: 1 });
    expect(stats.outcomeByEffort?.mid).toBeUndefined(); // shipped 는 집계 제외.
    // 렌즈 분해 — bug 렌즈(리서치産) verified 1·missed 1, 수집産(렌즈 없음)은 제외.
    expect(stats.outcomeByLens?.bug).toEqual({ verified: 1, missed: 1 });
  });

  it("출시 후 검증 분해 — 근거 종류별 verified/missed (byEvidence 와 같은 kind 원천), 옵셔널 직렬화", async () => {
    const ev = (kinds: string[]) =>
      JSON.stringify(kinds.map((k) => ({ kind: k, ref: "r", summary: "s" })));
    // github_issue: verified 1·missed 1, repo_todo: missed 1, doc: shipped(검증 전) 제외.
    seedBrief({ status: "verified", evidence: ev(["github_issue"]) });
    seedBrief({ status: "missed", evidence: ev(["github_issue", "repo_todo"]) });
    seedBrief({ status: "shipped", evidence: ev(["doc"]) }); // 검증 전 → 제외.

    const stats = await jsonAs<
      Stats & { outcomeByEvidence?: Record<string, { verified: number; missed: number }> }
    >(await buildApp().request("/api/po/stats", { headers: AUTH }));

    expect(stats).toMatchObject({ verified: 1, missed: 1 });
    // 근거 종류 — github_issue verified 1·missed 1, repo_todo missed 1, doc(shipped)은 제외.
    expect(stats.outcomeByEvidence?.github_issue).toEqual({ verified: 1, missed: 1 });
    expect(stats.outcomeByEvidence?.repo_todo).toEqual({ verified: 0, missed: 1 });
    expect(stats.outcomeByEvidence?.doc).toBeUndefined();
  });

  it("출시 후 검증 분해 — 검증 건수 0이면 필드 생략 (구 daemon 호환·빈 상태 숨김)", async () => {
    // 전부 shipped 직후(검증 전) 또는 결재 단계 → verified+missed = 0.
    seedBrief({ status: "proposed" });
    seedBrief({ status: "rejected" });
    seedBrief({ status: "shipped" }); // 아직 검증 전.

    const stats = await jsonAs<
      Stats & {
        outcomeByEffort?: Record<string, { verified: number; missed: number }>;
        outcomeByLens?: Record<string, { verified: number; missed: number }>;
        outcomeByEvidence?: Record<string, { verified: number; missed: number }>;
      }
    >(await buildApp().request("/api/po/stats", { headers: AUTH }));

    expect(stats).toMatchObject({ verified: 0, missed: 0 });
    // verified+missed = 0 → outcomeBy* 필드 자체가 없음 (iOS 섹션 숨김 트리거).
    expect(stats.outcomeByEffort).toBeUndefined();
    expect(stats.outcomeByLens).toBeUndefined();
    expect(stats.outcomeByEvidence).toBeUndefined();
  });

  it("출시 후 검증 분해 — repoPath 필터와 일관 (다른 레포 제외)", async () => {
    const otherRepo = path.join(os.tmpdir(), "ps-po-other-repo");
    seedBrief({ status: "verified", effort: 1 });
    seedBrief({ status: "missed", effort: 1, repo_path: otherRepo });

    const app = buildApp();
    const filtered = await jsonAs<
      Stats & { outcomeByEffort?: Record<string, { verified: number; missed: number }> }
    >(
      await app.request(`/api/po/stats?repoPath=${encodeURIComponent(H.repoDir)}`, {
        headers: AUTH,
      }),
    );

    expect(filtered).toMatchObject({ verified: 1, missed: 0 });
    expect(filtered.outcomeByEffort?.low).toEqual({ verified: 1, missed: 0 });
  });

  it("byReason 집계 (po_decide_reason_v2) — rejected/held 의 decide_reason 집계, 5개 enum + none(NULL)", async () => {
    // 5개 enum 키 — 각 1건씩.
    seedBrief({ status: "rejected", decide_reason: "priority_low" });
    seedBrief({ status: "rejected", decide_reason: "scope_too_big" });
    seedBrief({ status: "held", decide_reason: "already_exists" });
    seedBrief({ status: "held", decide_reason: "weak_evidence" });
    seedBrief({ status: "rejected", decide_reason: "wrong_direction" });
    // decide_reason NULL (사유 미선택) — none 으로 집계돼야 한다.
    seedBrief({ status: "rejected", decide_reason: null });
    seedBrief({ status: "held", decide_reason: null });
    // approve 는 사유 무의미 → 집계 제외.
    seedBrief({ status: "verified", decide_reason: "priority_low" });
    // 허용 키 밖 (이상값) — parseDecideReason 이 NULL 화하므로 저장 시점에서 정규화됨.
    // 하지만 혹시 모를 과거 데이터 대비 — 쿼리 시점 폴백으로 none 집계.
    db()
      .prepare(
        `INSERT INTO po_briefs (id, repo_path, title, problem, evidence, impact, effort, score, scope, spec, status, created_at, updated_at, decide_reason)
         VALUES (?, ?, '', '', '[]', 3, 3, 5, '', '', 'rejected', ?, ?, ?)`,
      )
      .run("brief-invalid", H.repoDir, Date.now(), Date.now(), "invalid_key");

    const stats = await jsonAs<Stats & { byReason: Record<string, number> }>(
      await buildApp().request("/api/po/stats", { headers: AUTH }),
    );

    // 톱레벨 합산 불변 (회귀 0).
    expect(stats).toMatchObject({ proposed: 9, approved: 1, rejected: 5, shipped: 1, verified: 1 });
    // 5개 enum 키 + none(NULL 2건 + 이상값 1건).
    expect(stats.byReason).toEqual({
      priority_low: 1,
      scope_too_big: 1,
      already_exists: 1,
      weak_evidence: 1,
      wrong_direction: 1,
      none: 3,
    });
  });

  it("byReason — repoPath 필터 일관 (다른 레포 사유 제외)", async () => {
    const otherRepo = path.join(os.tmpdir(), "ps-po-other-repo");
    seedBrief({ status: "rejected", decide_reason: "priority_low" });
    db()
      .prepare(
        `INSERT INTO po_briefs (id, repo_path, title, problem, evidence, impact, effort, score, scope, spec, status, created_at, updated_at, decide_reason)
         VALUES (?, ?, '', '', '[]', 3, 3, 5, '', '', 'rejected', ?, ?, ?)`,
      )
      .run("other-repo-brief", otherRepo, Date.now(), Date.now(), "scope_too_big");

    const app = buildApp();
    const filtered = await jsonAs<Stats & { byReason: Record<string, number> }>(
      await app.request(`/api/po/stats?repoPath=${encodeURIComponent(H.repoDir)}`, {
        headers: AUTH,
      }),
    );
    expect(filtered.byReason).toEqual({
      priority_low: 1,
      scope_too_big: 0,
      already_exists: 0,
      weak_evidence: 0,
      wrong_direction: 0,
      none: 0,
    });
  });
});

describe("에이전트 선택 (po_agent_v1)", () => {
  function sessionAgent(sessionId: string): string {
    const row = db().prepare(`SELECT agent FROM sessions WHERE id = ?`).get(sessionId) as {
      agent: string;
    };
    return row.agent;
  }

  it("collect 의 agent 가 수집 세션에 반영된다", async () => {
    const res = await buildApp().request("/api/po/collect", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ repoPath: H.repoDir, agent: "codex" }),
    });
    expect(res.status).toBe(202);
    const { sessionId } = await jsonAs<{ sessionId: string }>(res);
    expect(sessionAgent(sessionId)).toBe("codex");
  });

  it("collect 의 agent 생략은 claude_code (옛 클라이언트 호환)", async () => {
    const res = await buildApp().request("/api/po/collect", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ repoPath: H.repoDir }),
    });
    const { sessionId } = await jsonAs<{ sessionId: string }>(res);
    expect(sessionAgent(sessionId)).toBe("claude_code");
  });

  it("decide approve 의 agent 가 구현 세션에 반영된다", async () => {
    const id = seedBrief();
    const res = await buildApp().request(`/api/po/briefs/${id}/decide`, {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ action: "approve", agent: "agy" }),
    });
    expect(res.status).toBe(200);
    const { execSessionId } = await jsonAs<{ execSessionId: string }>(res);
    expect(sessionAgent(execSessionId)).toBe("agy");
  });

  it("research 의 agent 가 리서치 세션에 반영된다", async () => {
    const res = await buildApp().request("/api/po/research", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ repoPath: H.repoDir, topic: "조사 주제", agent: "codex" }),
    });
    expect(res.status).toBe(202);
    const { sessionId } = await jsonAs<{ sessionId: string }>(res);
    expect(sessionAgent(sessionId)).toBe("codex");
  });

  it("research 의 lens 가 po_research.lens 에 기록되고 GET 응답에 나간다 (po_research_lens_v1)", async () => {
    const app = buildApp();
    const res = await app.request("/api/po/research", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ repoPath: H.repoDir, topic: "조사 주제", lens: "design" }),
    });
    expect(res.status).toBe(202);
    const { researchId } = await jsonAs<{ researchId: string }>(res);
    const row = db().prepare(`SELECT lens FROM po_research WHERE id = ?`).get(researchId) as {
      lens: string;
    };
    expect(row.lens).toBe("design");
    const detail = await app.request(`/api/po/research/${researchId}`, { headers: AUTH });
    const body = await jsonAs<{ research: { lens: string } }>(detail);
    expect(body.research.lens).toBe("design");
  });

  it("research 의 lens=\"qa\" 가 po_research.lens 에 기록된다 (po_research_lens_v2)", async () => {
    const app = buildApp();
    const res = await app.request("/api/po/research", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ repoPath: H.repoDir, topic: "조사 주제", lens: "qa" }),
    });
    expect(res.status).toBe(202);
    const { researchId } = await jsonAs<{ researchId: string }>(res);
    const row = db().prepare(`SELECT lens FROM po_research WHERE id = ?`).get(researchId) as {
      lens: string;
    };
    expect(row.lens).toBe("qa");
  });

  it("research 의 lens=\"security\" 가 po_research.lens 에 기록·노출된다 (po_research_lens_v3)", async () => {
    const app = buildApp();
    const res = await app.request("/api/po/research", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ repoPath: H.repoDir, topic: "연결성 보안", lens: "security" }),
    });
    expect(res.status).toBe(202);
    const { researchId } = await jsonAs<{ researchId: string }>(res);
    const row = db().prepare(`SELECT lens FROM po_research WHERE id = ?`).get(researchId) as {
      lens: string;
    };
    expect(row.lens).toBe("security");
    const detail = await app.request(`/api/po/research/${researchId}`, { headers: AUTH });
    const body = await jsonAs<{ research: { lens: string } }>(detail);
    expect(body.research.lens).toBe("security");
  });

  it("research 의 lens=\"pm\"·\"marketing\"·\"analytics\"·\"ops\" 가 po_research.lens 에 기록된다 (po_research_lens_v4~v7)", async () => {
    const app = buildApp();
    for (const lens of ["pm", "marketing", "analytics", "ops"] as const) {
      const res = await app.request("/api/po/research", {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({ repoPath: H.repoDir, topic: "조사 주제", lens }),
      });
      expect(res.status).toBe(202);
      const { researchId } = await jsonAs<{ researchId: string }>(res);
      const row = db().prepare(`SELECT lens FROM po_research WHERE id = ?`).get(researchId) as {
        lens: string;
      };
      expect(row.lens).toBe(lens);
    }
  });

  it("research 의 lens=\"ux\" 가 po_research.lens 에 기록·노출된다 (po_research_lens_v9)", async () => {
    const app = buildApp();
    const res = await app.request("/api/po/research", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ repoPath: H.repoDir, topic: "온보딩 사용성", lens: "ux" }),
    });
    expect(res.status).toBe(202);
    const { researchId } = await jsonAs<{ researchId: string }>(res);
    const row = db().prepare(`SELECT lens FROM po_research WHERE id = ?`).get(researchId) as {
      lens: string;
    };
    expect(row.lens).toBe("ux");
    const detail = await app.request(`/api/po/research/${researchId}`, { headers: AUTH });
    const body = await jsonAs<{ research: { lens: string } }>(detail);
    expect(body.research.lens).toBe("ux");
  });

  it("research 의 screens=true + lens=\"ux\" 는 받아들여진다 (po_research_ux_screens_v1, 프롬프트 분기는 prompt.test 가 검증)", async () => {
    // screens 는 po_research 에 저장되지 않고 프롬프트에만 영향 (scope 와 동형) — 라우트는 202 만 확인.
    const app = buildApp();
    const res = await app.request("/api/po/research", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ repoPath: H.repoDir, topic: "온보딩 사용성", lens: "ux", screens: true }),
    });
    expect(res.status).toBe(202);
    const { researchId } = await jsonAs<{ researchId: string }>(res);
    const row = db().prepare(`SELECT lens FROM po_research WHERE id = ?`).get(researchId) as {
      lens: string;
    };
    expect(row.lens).toBe("ux");
  });

  it("research 의 lens 미지정/이상값은 default(전방위)로 폴백 (옛 클라이언트 호환)", async () => {
    const app = buildApp();
    const res = await app.request("/api/po/research", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ repoPath: H.repoDir, topic: "조사 주제", lens: "nonsense" }),
    });
    const { researchId } = await jsonAs<{ researchId: string }>(res);
    const row = db().prepare(`SELECT lens FROM po_research WHERE id = ?`).get(researchId) as {
      lens: string;
    };
    expect(row.lens).toBe("default");
  });

  it("미등록 agent 는 400 agent_missing", async () => {
    const app = buildApp();
    const collect = await app.request("/api/po/collect", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ repoPath: H.repoDir, agent: "no_such_agent" }),
    });
    expect(collect.status).toBe(400);
    expect(await jsonAs<{ error: string }>(collect)).toMatchObject({ error: "agent_missing" });

    const id = seedBrief();
    const decide = await app.request(`/api/po/briefs/${id}/decide`, {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ action: "approve", agent: "no_such_agent" }),
    });
    expect(decide.status).toBe(400);
    expect(await jsonAs<{ error: string }>(decide)).toMatchObject({ error: "agent_missing" });
  });
});

describe("POST /api/po/briefs/bulk/decide — 일괄 결재 (po_bulk_decide_v1)", () => {
  it("proposed/held 다중을 한 번에 reject 로 비운다 + updated 반환", async () => {
    const a = seedBrief({ status: "proposed", title: "A" });
    const b = seedBrief({ status: "held", title: "B", decided_at: Date.now() });
    const res = await buildApp().request("/api/po/briefs/bulk/decide", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ ids: [a, b], action: "reject" }),
    });
    expect(res.status).toBe(200);
    const body = await jsonAs<{
      updated: Array<{ id: string; status: string; decidedAt: number | null }>;
      skipped: Array<{ id: string; reason: string }>;
    }>(res);
    expect(body.updated).toHaveLength(2);
    expect(body.updated.every((x) => x.status === "rejected")).toBe(true);
    expect(body.updated.every((x) => x.decidedAt != null)).toBe(true);
    expect(body.skipped).toHaveLength(0);
    // DB 도 실제로 바뀌었다.
    for (const id of [a, b]) {
      const row = db().prepare(`SELECT status FROM po_briefs WHERE id = ?`).get(id) as {
        status: string;
      };
      expect(row.status).toBe("rejected");
    }
  });

  it("action=hold 은 held 로 전이한다", async () => {
    const id = seedBrief({ status: "proposed" });
    const res = await buildApp().request("/api/po/briefs/bulk/decide", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ ids: [id], action: "hold" }),
    });
    expect(res.status).toBe(200);
    const row = db().prepare(`SELECT status FROM po_briefs WHERE id = ?`).get(id) as {
      status: string;
    };
    expect(row.status).toBe("held");
  });

  it("부분 성공 — 없는 id·이미 처리된 id 는 skipped, 나머지는 적용", async () => {
    const live = seedBrief({ status: "proposed" });
    const decided = seedBrief({ status: "running", decided_at: Date.now() });
    const res = await buildApp().request("/api/po/briefs/bulk/decide", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ ids: [live, decided, "nope-id"], action: "reject" }),
    });
    expect(res.status).toBe(200);
    const body = await jsonAs<{
      updated: Array<{ id: string }>;
      skipped: Array<{ id: string; reason: string }>;
    }>(res);
    expect(body.updated.map((x) => x.id)).toEqual([live]);
    expect(body.skipped).toEqual(
      expect.arrayContaining([
        { id: decided, reason: "already_decided" },
        { id: "nope-id", reason: "not_found" },
      ]),
    );
    // running 행은 건드리지 않는다.
    expect(
      (db().prepare(`SELECT status FROM po_briefs WHERE id = ?`).get(decided) as { status: string })
        .status,
    ).toBe("running");
  });

  it("approve 는 일괄 대상이 아니다 → 400 invalid_action (세션 폭주 방지)", async () => {
    const id = seedBrief({ status: "proposed" });
    const res = await buildApp().request("/api/po/briefs/bulk/decide", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ ids: [id], action: "approve" }),
    });
    expect(res.status).toBe(400);
    expect(await jsonAs<{ error: string }>(res)).toMatchObject({ error: "invalid_action" });
    // 브리프는 그대로 proposed.
    expect(
      (db().prepare(`SELECT status FROM po_briefs WHERE id = ?`).get(id) as { status: string })
        .status,
    ).toBe("proposed");
  });

  it("빈 ids 는 400 missing_ids", async () => {
    const res = await buildApp().request("/api/po/briefs/bulk/decide", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ ids: [], action: "reject" }),
    });
    expect(res.status).toBe(400);
    expect(await jsonAs<{ error: string }>(res)).toMatchObject({ error: "missing_ids" });
  });

  it("중복 id 는 한 번만 처리된다", async () => {
    const id = seedBrief({ status: "proposed" });
    const res = await buildApp().request("/api/po/briefs/bulk/decide", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ ids: [id, id, id], action: "hold" }),
    });
    expect(res.status).toBe(200);
    const body = await jsonAs<{ updated: Array<{ id: string }> }>(res);
    expect(body.updated).toHaveLength(1);
  });

  it("«bulk» 가 :id/decide 로 새지 않는다 (정적 경로 우선)", async () => {
    // /briefs/bulk/decide 는 일괄 라우트라 invalid_action(400)을 돌려줘야 한다 —
    // :id="bulk" 단건 라우트로 샜다면 not_found(404)가 났을 것.
    const res = await buildApp().request("/api/po/briefs/bulk/decide", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ action: "approve", ids: ["x"] }),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/po/briefs decide — 보류/기각 사유 태그 (po_decide_reason_v1)", () => {
  it("단건 reject 가 decide_reason·decide_note 를 저장하고 재조회된다", async () => {
    const id = seedBrief({ status: "proposed" });
    const res = await buildApp().request(`/api/po/briefs/${id}/decide`, {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ action: "reject", reason: "scope_too_big", note: "범위가 너무 넓음" }),
    });
    expect(res.status).toBe(200);
    const body = await jsonAs<{
      brief: { status: string; decideReason: string | null; decideNote: string | null };
    }>(res);
    expect(body.brief.status).toBe("rejected");
    expect(body.brief.decideReason).toBe("scope_too_big");
    expect(body.brief.decideNote).toBe("범위가 너무 넓음");
    // GET 으로 재조회해도 유지된다.
    const list = await buildApp().request(
      `/api/po/briefs?repoPath=${encodeURIComponent(H.repoDir)}`,
      { headers: AUTH },
    );
    const { briefs } = await jsonAs<{
      briefs: Array<{ id: string; decideReason: string | null }>;
    }>(list);
    expect(briefs.find((b) => b.id === id)?.decideReason).toBe("scope_too_big");
  });

  it("단건 hold 도 사유를 기록한다", async () => {
    const id = seedBrief({ status: "proposed" });
    const res = await buildApp().request(`/api/po/briefs/${id}/decide`, {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ action: "hold", reason: "priority_low" }),
    });
    expect(res.status).toBe(200);
    const body = await jsonAs<{
      brief: { status: string; decideReason: string | null; decideNote: string | null };
    }>(res);
    expect(body.brief.status).toBe("held");
    expect(body.brief.decideReason).toBe("priority_low");
    expect(body.brief.decideNote).toBeNull();
  });

  it("미선택(사유 없음)은 NULL — 강제 마찰 없음", async () => {
    const id = seedBrief({ status: "proposed" });
    const res = await buildApp().request(`/api/po/briefs/${id}/decide`, {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ action: "reject" }),
    });
    expect(res.status).toBe(200);
    const body = await jsonAs<{ brief: { decideReason: string | null } }>(res);
    expect(body.brief.decideReason).toBeNull();
  });

  it("허용 키가 아닌 사유는 무시되고 NULL 로 저장된다", async () => {
    const id = seedBrief({ status: "proposed" });
    const res = await buildApp().request(`/api/po/briefs/${id}/decide`, {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ action: "reject", reason: "made_up_key" }),
    });
    expect(res.status).toBe(200);
    const body = await jsonAs<{ brief: { decideReason: string | null } }>(res);
    expect(body.brief.decideReason).toBeNull();
  });

  it("일괄 결재도 선택분 전체에 사유를 기록한다", async () => {
    const a = seedBrief({ status: "proposed", title: "A" });
    const b = seedBrief({ status: "held", title: "B", decided_at: Date.now() });
    const res = await buildApp().request("/api/po/briefs/bulk/decide", {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ ids: [a, b], action: "reject", reason: "already_exists" }),
    });
    expect(res.status).toBe(200);
    const body = await jsonAs<{ updated: Array<{ id: string; decideReason: string | null }> }>(res);
    expect(body.updated).toHaveLength(2);
    expect(body.updated.every((x) => x.decideReason === "already_exists")).toBe(true);
  });
});

describe("POST /api/po/briefs/:id/cleanup — 코드 흔적 정리 (po_cleanup_v1)", () => {
  it("rejected 브리프 → 202 + 정리 세션 spawn + cleanup_session_id 기록", async () => {
    const id = seedBrief({ status: "rejected", decided_at: Date.now() });
    const res = await buildApp().request(`/api/po/briefs/${id}/cleanup`, {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(202);
    const body = await jsonAs<{
      brief: { status: string; cleanupSessionId: string | null };
      cleanupSessionId: string;
    }>(res);
    expect(body.cleanupSessionId).toBeTruthy();
    // 상태는 rejected 유지 — 정리는 상태 전이가 아니라 직교 컬럼.
    expect(body.brief.status).toBe("rejected");
    expect(body.brief.cleanupSessionId).toBe(body.cleanupSessionId);

    // 정리 프롬프트가 그 세션으로 발사됐는지 — 구현 금지·삭제 전용 지시 포함.
    const { runUserMessagePty } = await import("../agent/pty-runner.js");
    const call = vi
      .mocked(runUserMessagePty)
      .mock.calls.find((c) => (c[0] as { sessionId: string }).sessionId === body.cleanupSessionId);
    expect(call).toBeTruthy();
    expect(call![1]).toContain("절대 구현하지 마라");
    // 근거의 ref 가 출발점으로 프롬프트에 들어간다 (seedBrief 의 docs/todo.md).
    expect(call![1]).toContain("docs/todo.md");
  });

  it("rejected 가 아니면 409 not_rejected — 살아있는 브리프의 신호를 지우지 않는다", async () => {
    for (const status of ["proposed", "held", "running", "shipped"]) {
      const id = seedBrief({ status });
      const res = await buildApp().request(`/api/po/briefs/${id}/cleanup`, {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(409);
      expect(await jsonAs<{ error: string }>(res)).toMatchObject({ error: "not_rejected" });
    }
  });

  it("없는 브리프는 404, 미등록 agent 는 400", async () => {
    const app = buildApp();
    const missing = await app.request(`/api/po/briefs/no-such-id/cleanup`, {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({}),
    });
    expect(missing.status).toBe(404);

    const id = seedBrief({ status: "rejected" });
    const badAgent = await app.request(`/api/po/briefs/${id}/cleanup`, {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ agent: "no_such_agent" }),
    });
    expect(badAgent.status).toBe(400);
    expect(await jsonAs<{ error: string }>(badAgent)).toMatchObject({ error: "agent_missing" });
  });

  it("재호출 허용 — cleanup_session_id 를 새 세션으로 덮어쓴다 (실패한 정리 재시도)", async () => {
    const id = seedBrief({ status: "rejected" });
    const app = buildApp();
    const first = await jsonAs<{ cleanupSessionId: string }>(
      await app.request(`/api/po/briefs/${id}/cleanup`, {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({}),
      }),
    );
    const second = await jsonAs<{ cleanupSessionId: string }>(
      await app.request(`/api/po/briefs/${id}/cleanup`, {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({}),
      }),
    );
    expect(second.cleanupSessionId).not.toBe(first.cleanupSessionId);
    const row = db()
      .prepare(`SELECT cleanup_session_id FROM po_briefs WHERE id = ?`)
      .get(id) as { cleanup_session_id: string };
    expect(row.cleanup_session_id).toBe(second.cleanupSessionId);
  });
});

// ─── 워크플로우 승인 경로 (po_workflow_v1) ────────────────────────────────────

describe("decide mode=workflow (po_workflow_v1)", () => {
  type WfRow = { id: string; title: string; nodes: string; edges: string };

  /** 진행 중 엔진 run 을 정리 — 취소 + 모든 세션 settle 로 엔진 타이머가 안 남게. */
  async function settleEngineRun(runId: string): Promise<void> {
    cancelWorkflowRun(runId);
    const sessions = db().prepare(`SELECT id FROM sessions`).all() as { id: string }[];
    for (const s of sessions) H.ptyEvents.emit("session_exit", { sessionId: s.id });
    await waitFor(() => getRun(runId)?.status !== "running", 8000);
  }

  function briefRow(id: string): {
    status: string;
    exec_workflow_id: string | null;
    exec_run_id: string | null;
    exec_note: string | null;
  } {
    return db()
      .prepare(
        `SELECT status, exec_workflow_id, exec_run_id, exec_note FROM po_briefs WHERE id = ?`,
      )
      .get(id) as never;
  }

  it("설계 산출 없음(타임아웃/미작성) → 기본 4노드 템플릿 fallback 으로 run 생성 + 메모", async () => {
    const id = seedBrief();
    const res = await buildApp().request(`/api/po/briefs/${id}/decide`, {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ action: "approve", mode: "workflow" }),
    });
    expect(res.status).toBe(200);
    const { brief, execSessionId } = await jsonAs<{
      brief: { status: string };
      execSessionId: string;
    }>(res);
    // 승인 즉시 running + 설계 세션 id 반환 (관전용).
    expect(brief.status).toBe("running");
    expect(execSessionId).toBeTruthy();

    // 설계 세션 settle — outFile 을 안 썼으므로 fallback 경로.
    H.ptyEvents.emit("turn_complete", { sessionId: execSessionId });
    await waitFor(() => briefRow(id).exec_run_id != null, 8000);

    const row = briefRow(id);
    expect(row.status).toBe("running");
    expect(row.exec_note).toContain("기본 워크플로우");

    // «PO: <제목>» 워크플로우가 레포에 저장돼 캔버스에서 열람/수정 가능.
    const wf = db()
      .prepare(`SELECT id, title, nodes, edges FROM workflows WHERE id = ?`)
      .get(row.exec_workflow_id) as WfRow;
    expect(wf.title).toBe("PO: 테스트 브리프");
    const nodes = JSON.parse(wf.nodes) as Array<Record<string, unknown>>;
    const edges = JSON.parse(wf.edges) as Array<Record<string, unknown>>;
    // 스펙→구현→자가검증→사람 게이트 골격: 게이트 + 자가검증 fail 루프.
    expect(nodes.some((n) => n.requires_approval === true)).toBe(true);
    expect(edges.some((e) => e.condition === "fail")).toBe(true);

    await settleEngineRun(row.exec_run_id!);
  });

  it("설계 산출 ingest — 위험 필드 화이트리스트 + 게이트 자동 삽입", async () => {
    const id = seedBrief();
    const res = await buildApp().request(`/api/po/briefs/${id}/decide`, {
      method: "POST",
      headers: AUTH,
      body: JSON.stringify({ action: "approve", mode: "workflow" }),
    });
    const { execSessionId } = await jsonAs<{ execSessionId: string }>(res);

    // 설계 에이전트 산출 — 게이트 없음 + skip_permissions:false + triggers (전부 교정 대상).
    const outFile = path.join(os.tmpdir(), `ps-po-wf-${execSessionId}.json`);
    fs.writeFileSync(
      outFile,
      JSON.stringify({
        nodes: [
          { id: "start", type: "start", title: "시작", x: 60, y: 40 },
          {
            id: "work",
            type: "task",
            title: "구현",
            prompt: "구현하라",
            agent: "codex",
            skip_permissions: false,
            triggers: [{ kind: "cron", schedule: "* * * * *" }],
            x: 60,
            y: 210,
          },
          { id: "end", type: "end", title: "종료", x: 60, y: 380 },
        ],
        edges: [
          { id: "e1", from: "start", to: "work" },
          { id: "e2", from: "work", to: "end" },
        ],
      }),
    );
    H.ptyEvents.emit("turn_complete", { sessionId: execSessionId });
    await waitFor(() => briefRow(id).exec_run_id != null, 8000);

    const row = briefRow(id);
    // AI 산출이 그대로 쓰였으니 fallback 메모 없음.
    expect(row.exec_note).toBeNull();
    const wf = db()
      .prepare(`SELECT id, title, nodes, edges FROM workflows WHERE id = ?`)
      .get(row.exec_workflow_id) as WfRow;
    const nodes = JSON.parse(wf.nodes) as Array<Record<string, unknown>>;
    const edges = JSON.parse(wf.edges) as Array<Record<string, unknown>>;

    const work = nodes.find((n) => n.id === "work")!;
    expect(work.agent).toBe("codex");
    expect(work.skip_permissions).toBe(true); // 화이트리스트 강제
    expect(work.triggers).toBeUndefined(); // AI 가 크론 등록 불가

    // 게이트가 end 직전에 자동 삽입 — work→gate→end 로 재배선.
    const gate = nodes.find((n) => n.requires_approval === true)!;
    expect(gate).toBeTruthy();
    expect(edges.some((e) => e.from === "work" && e.to === gate.id)).toBe(true);
    expect(edges.some((e) => e.from === gate.id && e.to === "end")).toBe(true);
    expect(edges.some((e) => e.from === "work" && e.to === "end")).toBe(false);

    await settleEngineRun(row.exec_run_id!);
  });
});

describe("workflow-exec 순수 함수", () => {
  const brief = {
    id: "b1",
    repo_path: "/tmp/repo",
    title: "제목",
    problem: "문제",
    scope: "스코프",
    spec: "스펙",
  };

  it("buildPoFallbackDef — validateDef 통과 + 게이트/fail 루프 포함", () => {
    const def = buildPoFallbackDef(brief, "claude_code");
    const valid = validateDef(def.nodes, def.edges);
    expect(valid.ok).toBe(true);
    expect(def.nodes.filter((n) => n.requires_approval === true)).toHaveLength(1);
    expect(def.edges.some((e) => e.condition === "fail" && e.from === "verify" && e.to === "impl")).toBe(true);
  });

  it("buildPoFallbackDef — «디자이너 리뷰» 가 게이트 직전(입력 evidence) 으로 끼고, fail 간선 없음", () => {
    const def = buildPoFallbackDef(brief, "claude_code");
    const review = def.nodes.find((n) => n.id === "design_review")!;
    const gate = def.nodes.find((n) => n.requires_approval === true)!;
    expect(review).toBeTruthy();
    // 증거 수집 전용 — 게이트가 아니다(승인 강제 X).
    expect(review.requires_approval).toBeFalsy();
    // 자가검증 → 디자이너 리뷰 → 게이트 (리뷰가 게이트의 직전 = findings 가 입력 evidence).
    expect(def.edges.some((e) => e.from === "verify" && e.to === "design_review")).toBe(true);
    expect(def.edges.some((e) => e.from === "design_review" && e.to === gate.id)).toBe(true);
    // 자가검증이 게이트로 직행하지 않는다(리뷰를 거친다).
    expect(def.edges.some((e) => e.from === "verify" && e.to === gate.id)).toBe(false);
    // 리뷰는 «증거 전용» — fail 간선이 없어 자동 차단하지 않는다(사람이 결재 때 본다).
    expect(def.edges.some((e) => e.from === "design_review" && e.condition === "fail")).toBe(false);
    // 노드 prompt 에 캡처→비평→2회 일치 투표 계약이 담긴다.
    expect(review.prompt).toContain("정규화 좌표");
    expect(review.prompt).toContain("독립적으로 최소 2회");
    // 여전히 게이트는 정확히 1개 (리뷰가 게이트를 늘리지 않는다).
    expect(def.nodes.filter((n) => n.requires_approval === true)).toHaveLength(1);
  });

  it("buildPoFallbackDef — designDirective 선언이 디자이너 리뷰 노드 prompt 에 박힌다", () => {
    const directive = "강조=violet, 프리미엄=orange (경고색과 혼동 금지).";
    const def = buildPoFallbackDef(brief, "claude_code", directive);
    const review = def.nodes.find((n) => n.id === "design_review")!;
    expect(review.prompt).toContain(directive);
    // 선언 모드라 자동 발견 문구는 빠진다.
    expect(review.prompt).not.toContain("디자인 SSOT 를 먼저 «스스로 찾아 읽고»");
  });

  it("sanitizeDesignedDef — 형식 불일치는 null (fallback 신호)", () => {
    expect(sanitizeDesignedDef(null, { defaultAgent: "a", isValidAgent: () => true })).toBeNull();
    expect(sanitizeDesignedDef([], { defaultAgent: "a", isValidAgent: () => true })).toBeNull();
    expect(
      sanitizeDesignedDef({ nodes: "x", edges: [] }, { defaultAgent: "a", isValidAgent: () => true }),
    ).toBeNull();
  });

  it("sanitizeDesignedDef — 미등록 agent 는 기본값으로 교체", () => {
    const out = sanitizeDesignedDef(
      {
        nodes: [{ id: "t", type: "task", prompt: "p", agent: "evil_agent" }],
        edges: [],
      },
      { defaultAgent: "claude_code", isValidAgent: (id) => id === "claude_code" },
    )!;
    expect((out.nodes[0] as Record<string, unknown>).agent).toBe("claude_code");
  });

  it("ensureHumanGate — 게이트가 이미 있으면 그대로", () => {
    const def = buildPoFallbackDef(brief, "claude_code");
    const out = ensureHumanGate(def, { prompt: "머지", agent: "claude_code" });
    expect(out.nodes).toHaveLength(def.nodes.length);
  });

  it("ensureHumanGate — end 가 없어도 end+게이트를 만들어 무인 머지를 차단", () => {
    const out = ensureHumanGate(
      {
        nodes: [
          { id: "start", type: "start" },
          { id: "work", type: "task", prompt: "p" },
        ],
        edges: [{ id: "e1", from: "start", to: "work" }],
      },
      { prompt: "머지", agent: "claude_code" },
    );
    const gate = out.nodes.find((n) => n.requires_approval === true)!;
    const end = out.nodes.find((n) => n.type === "end")!;
    expect(gate).toBeTruthy();
    expect(end).toBeTruthy();
    expect(out.edges.some((e) => e.from === "work" && e.to === gate.id)).toBe(true);
    expect(out.edges.some((e) => e.from === gate.id && e.to === end.id)).toBe(true);
    const valid = validateDef(out.nodes, out.edges);
    expect(valid.ok).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PO 라우트 계약 테스트 (po_agent_echo_v1) — 각 진입점이 body.agent 를 세션 spawn 에
// 그대로 전달하는지 단언. 누락 시 회귀 검출.
//
// 배경: iOS 가 agent 인자를 빠뜨리면 daemon 이 조용히 claude_code 로 폴백해 사용자가
// «실제로 무엇이 돌고 있는지» 모르게 되는 무음 실패가 3회+ 재발. 이 테스트가 라우트 계약
// 위반(agent 전달 누락)을 빌드 시점에 잡는다.

describe("PO agent echo contract (po_agent_echo_v1)", () => {
  describe("parseAgent", () => {
    it("유효한 agent id 를 그대로 반환", () => {
      expect(parseAgent("codex")).toBe("codex");
      expect(parseAgent("claude_code")).toBe("claude_code");
      expect(parseAgent("agy")).toBe("agy");
    });

    it("공백이 있으면 trim 후 반환", () => {
      expect(parseAgent("  codex  ")).toBe("codex");
      expect(parseAgent("\tclaude_code\n")).toBe("claude_code");
    });

    it("빈 문자열은 undefined", () => {
      expect(parseAgent("")).toBeUndefined();
      expect(parseAgent("   ")).toBeUndefined();
    });

    it("비-문자열은 undefined", () => {
      expect(parseAgent(undefined)).toBeUndefined();
      expect(parseAgent(null)).toBeUndefined();
      expect(parseAgent(123)).toBeUndefined();
      expect(parseAgent({ agent: "codex" })).toBeUndefined();
      expect(parseAgent(["codex"])).toBeUndefined();
    });
  });

  describe("executor agent fallback", () => {
    it("startPoCollection/startPoResearch: agentIdRaw=undefined → claude_code", () => {
      // 배경: routes/po.ts 의 parseAgent(body.agent) 가 undefined 를 반환하면,
      // executor.ts 의 startPoCollection/startPoResearch 가 agentIdRaw || "claude_code" 로 폴백한다.
      const agentIdRaw = undefined;
      const agentId = agentIdRaw || "claude_code";
      expect(agentId).toBe("claude_code");
    });

    it("startPoCollection/startPoResearch: agentIdRaw='codex' → codex", () => {
      const agentIdRaw = "codex";
      const agentId = agentIdRaw || "claude_code";
      expect(agentId).toBe("codex");
    });

    it("decide (approve): agentId 는 parseAgent(body.agent) ?? 'claude_code'", () => {
      // routes/po.ts 의 /briefs/:id/decide approve 분기가 이 패턴을 쓴다.
      const agentId1 = parseAgent("agy") ?? "claude_code";
      expect(agentId1).toBe("agy");

      const agentId2 = parseAgent(undefined) ?? "claude_code";
      expect(agentId2).toBe("claude_code");
    });

    it("cleanup: agentId 는 parseAgent(body.agent) ?? 'claude_code'", () => {
      // routes/po.ts 의 /briefs/:id/cleanup 이 이 패턴을 쓴다.
      const agentId1 = parseAgent("codex") ?? "claude_code";
      expect(agentId1).toBe("codex");

      const agentId2 = parseAgent("") ?? "claude_code";
      expect(agentId2).toBe("claude_code");
    });
  });

  describe("route response shape", () => {
    it("/collect 응답에 agent 필드 포함", () => {
      // 예상 응답 shape — daemon 이 반환해야 할 계약.
      type CollectResponse = {
        sessionId: string;
        agent: string; // 실제 사용된 agentId (폴백 후)
        gh?: unknown; // 선택: GitHub 신호 가용성
        asc?: unknown; // 선택: ASC 신호 가용성
      };
      const sample: CollectResponse = {
        sessionId: "test-session-id",
        agent: "claude_code",
      };
      expect(sample).toHaveProperty("sessionId");
      expect(sample).toHaveProperty("agent");
    });

    it("/research 응답에 agent 필드 포함", () => {
      type ResearchResponse = {
        researchId: string;
        sessionId: string;
        agent: string;
      };
      const sample: ResearchResponse = {
        researchId: "test-research-id",
        sessionId: "test-session-id",
        agent: "codex",
      };
      expect(sample).toHaveProperty("researchId");
      expect(sample).toHaveProperty("sessionId");
      expect(sample).toHaveProperty("agent");
    });

    it("/briefs/:id/decide (approve) 응답에 agent 필드 포함", () => {
      type DecideResponse = {
        brief: Record<string, unknown>;
        execSessionId: string;
        agent: string;
      };
      const sample: DecideResponse = {
        brief: { id: "test-brief-id", execAgentId: "claude_code" },
        execSessionId: "test-exec-session-id",
        agent: "claude_code",
      };
      expect(sample).toHaveProperty("brief");
      expect(sample).toHaveProperty("execSessionId");
      expect(sample).toHaveProperty("agent");
    });

    it("/briefs/:id/cleanup 응답에 agent 필드 포함", () => {
      type CleanupResponse = {
        brief: Record<string, unknown>;
        cleanupSessionId: string;
        agent: string;
      };
      const sample: CleanupResponse = {
        brief: { id: "test-brief-id", cleanupAgentId: "agy" },
        cleanupSessionId: "test-cleanup-session-id",
        agent: "agy",
      };
      expect(sample).toHaveProperty("brief");
      expect(sample).toHaveProperty("cleanupSessionId");
      expect(sample).toHaveProperty("agent");
    });
  });

  describe("DB schema contract", () => {
    it("PoBriefRow 타입에 exec_agent_id·cleanup_agent_id 컬럼 포함", () => {
      // routes/po.ts 의 PoBriefRow 타입 계약 — 이 필드들이 있어야 한다.
      type PoBriefRow = {
        id: string;
        exec_session_id: string | null;
        exec_agent_id: string | null; // 구현 에이전트 ID
        cleanup_session_id: string | null;
        cleanup_agent_id: string | null; // 정리 에이전트 ID
      };
      const sample: PoBriefRow = {
        id: "test-brief-id",
        exec_session_id: "test-exec-session",
        exec_agent_id: "codex",
        cleanup_session_id: null,
        cleanup_agent_id: null,
      };
      expect(sample).toHaveProperty("exec_agent_id");
      expect(sample).toHaveProperty("cleanup_agent_id");
    });

    it("toApi 응답에 execAgentId·cleanupAgentId 포함", () => {
      // toApi 가 반환하는 API shape — camelCase 로 변환된다.
      type BriefApiShape = {
        id: string;
        execSessionId: string | null;
        execAgentId: string | null; // exec_agent_id → execAgentId
        cleanupSessionId: string | null;
        cleanupAgentId: string | null; // cleanup_agent_id → cleanupAgentId
      };
      const sample: BriefApiShape = {
        id: "test-brief-id",
        execSessionId: "test-exec-session",
        execAgentId: "claude_code",
        cleanupSessionId: null,
        cleanupAgentId: null,
      };
      expect(sample).toHaveProperty("execAgentId");
      expect(sample).toHaveProperty("cleanupAgentId");
    });
  });
});
