/**
 * `routes/sessions` 단위/통합 테스트.
 *
 * 검증 대상:
 *  - 인증 (bearer 누락/오류 → 401)
 *  - 입력 검증 (repoPath 누락, 잘못된 mode, 모르는 agent → 400)
 *  - 생성 → 조회 round-trip 의 필드 보존 (agent / skip_permissions / mode)
 *  - GET 의 limit / onlyResumable 쿼리 동작
 *
 * 격리 전략:
 *  - `../config.js` 를 mock 해 임시 디렉터리로 CONFIG_DIR / DB_FILE 을 박는다. 매 테스트
 *    파일은 자신의 tmpdir 하나만 — 테스트 간엔 sessions/messages 테이블을 truncate.
 *  - `../agent/pty-runner.js` 를 mock 해 실제 PTY spawn (`claude` 바이너리 필요) 을 차단.
 *  - DB singleton 은 `_resetDbForTest()` 로 비우고, auth 캐시는 `invalidateAuthCache()` 로
 *    비워서 mock 된 config 가 적용되게 한다.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from "vitest";
import { Hono } from "hono";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

// vi.mock 팩토리는 hoisted 라 file-level const 를 못 본다. vi.hoisted 로 tmpdir 만
// 미리 만들어서 mock 에 박아넣는다.
const H = vi.hoisted(() => {
  // ESM 환경에서 hoist 시점에 안전한 동기 API 만 사용.
  // (node:fs / node:os / node:path 모듈은 builtin 이라 hoist 시점에도 사용 가능.)
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fsH = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const osH = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pathH = require("node:path") as typeof import("node:path");
  const dir = fsH.mkdtempSync(pathH.join(osH.tmpdir(), "ps-daemon-test-"));
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
  ensureConfigDir: () => {
    fs.mkdirSync(H.tmpDir, { recursive: true });
  },
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

// PTY 는 실제 CLI 바이너리 spawn — 테스트 환경에선 차단해야 한다. 라우트가 fire-and-forget
// 으로 호출하는 prewarmPty 만 no-op 로 둬도 충분.
vi.mock("../agent/pty-runner.js", () => ({
  prewarmPty: vi.fn(),
  runUserMessagePty: vi.fn(async () => {}),
  abortPtySession: vi.fn(() => false),
  awaitPtyExit: vi.fn(async () => {}),
  resizePty: vi.fn(() => false),
  writePtyRaw: vi.fn(() => false),
  sendPtyKey: vi.fn(),
  // 목록/poll 응답의 waiting_since 합성용 — 기본 «대기 아님». 개별 테스트가 mockReturnValue
  // 로 시각을 흉내 낸다.
  getPtyWaitingSince: vi.fn(() => null),
  // 목록/poll 응답의 pending_prompt_preview 합성용 — 기본 «미리보기 없음».
  getPtyPendingPreview: vi.fn(() => null),
  // 「대기 추정 근거」(idle/리마인더/수동 구독) 합성용 — 기본 «활성 PTY 없음».
  getPtyAttention: vi.fn(() => null),
  // 「다음 정지 시 알림」 토글 — 테스트 환경엔 활성 PTY 가 없어 기본 false(미적용).
  setNotifyNextStop: vi.fn(() => false),
  // 스냅샷 엔드포인트가 헤드리스 터미널 폭을 맞추려 조회 — 테스트 환경엔 활성 PTY 없음 → null(기본값).
  getPtySize: vi.fn(() => null),
}));

// mock 이 박힌 뒤에야 import — 이러면 라우트가 mock 된 config/pty-runner 를 본다.
const { sessions } = await import("./sessions.js");
const { db, _resetDbForTest } = await import("../db/index.js");
const { hashToken, invalidateAuthCache } = await import("../auth.js");
const { registerBuiltinAgents } = await import("../agent/index.js");

const TEST_TOKEN = "test-token-fixed-for-determinism";
const AUTH_HEADER = { authorization: `Bearer ${TEST_TOKEN}` };

function buildApp(): Hono {
  const app = new Hono();
  app.route("/api/sessions", sessions);
  return app;
}

// ─── 응답 shape 타입 ───────────────────────────────────────────────────────
// fetch Response.json() 은 `unknown` 을 돌려준다. 매 호출 사이트에서 ad-hoc 캐스팅을
// 반복하면 typo / drift 위험이 커진다 — 라우트가 실제로 돌려주는 모양을 한 자리에 적고
// `jsonAs<T>` 로 한 줄 캐스팅한다.

type ErrorResponse = { error: string };

type CreateSessionResponse = {
  sessionId: string;
  repoPath: string;
  title: string | null;
  resumeFrom: string | null;
  skipPermissions: boolean;
  mode: string;
  agent: string;
};

type SessionListItem = {
  id: string;
  title: string | null;
  repo_path: string;
  parent_sdk_session_id: string | null;
  skip_permissions: number;
  mode: string;
  agent: string;
  notify_muted: number;
  /** «보관됨» 플래그 (session_archive_v1) — 0=미보관(기본)·1=보관됨. */
  archived: number;
  /** «입력 대기» 시작 시각 (epoch ms) — 대기 아님/구버전이면 null. */
  waiting_since: number | null;
  /** 대기 세션의 보류 prompt 미리보기 — 대기 아님/추출 불가면 응답에서 생략(undefined). */
  pending_prompt_preview?: string;
  /** 세션→출처 브리프 역참조 (po_provenance) — 브리프 출처 없으면 응답에서 생략(undefined). */
  source_brief?: { id: string; title: string | null; kind: string };
};

type SessionListResponse = { sessions: SessionListItem[] };

type SessionDetailResponse = {
  session: SessionListItem;
  messages: unknown[];
};

async function jsonAs<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

beforeAll(() => {
  // Adapter registry — module level singleton, idempotent.
  registerBuiltinAgents();
  // 알려진 token 으로 config 박기. auth cache 도 비워서 다음 readConfig() 호출 시 새 값을 본다.
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
  // 매 테스트마다 깨끗한 DB — singleton reset 후 다음 db() 호출이 새 파일을 연다.
  _resetDbForTest();
  try {
    fs.unlinkSync(H.dbFile);
  } catch {
    /* not exists */
  }
  // WAL 파일도 같이 정리
  for (const ext of ["-wal", "-shm"]) {
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
});

describe("GET /api/sessions — 인증", () => {
  it("Authorization 헤더 없으면 401", async () => {
    const app = buildApp();
    const res = await app.request("/api/sessions");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "missing_bearer" });
  });

  it("틀린 token 이면 401", async () => {
    const app = buildApp();
    const res = await app.request("/api/sessions", {
      headers: { authorization: "Bearer wrong-token" },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid_token" });
  });

  it("올바른 token 이면 빈 DB 에선 빈 목록", async () => {
    const app = buildApp();
    const res = await app.request("/api/sessions", { headers: AUTH_HEADER });
    expect(res.status).toBe(200);
    expect(await jsonAs<SessionListResponse>(res)).toEqual({ sessions: [] });
  });
});

describe("POST /api/sessions — 입력 검증", () => {
  it("repoPath 없으면 400", async () => {
    const app = buildApp();
    const res = await app.request("/api/sessions", {
      method: "POST",
      headers: { ...AUTH_HEADER, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(await jsonAs<ErrorResponse>(res)).toEqual({ error: "repoPath required" });
  });

  it("mode 가 pty 아니면 400 (옛 'sdk' 클라이언트 차단)", async () => {
    const app = buildApp();
    const res = await app.request("/api/sessions", {
      method: "POST",
      headers: { ...AUTH_HEADER, "content-type": "application/json" },
      body: JSON.stringify({ repoPath: "/tmp/x", mode: "sdk" }),
    });
    expect(res.status).toBe(400);
    expect((await jsonAs<ErrorResponse>(res)).error).toMatch(/no longer supported/);
  });

  it("등록 안 된 agent id 면 400", async () => {
    const app = buildApp();
    const res = await app.request("/api/sessions", {
      method: "POST",
      headers: { ...AUTH_HEADER, "content-type": "application/json" },
      body: JSON.stringify({ repoPath: "/tmp/x", agent: "nonexistent_agent" }),
    });
    expect(res.status).toBe(400);
    expect(await jsonAs<ErrorResponse>(res)).toEqual({
      error: "unknown agent: nonexistent_agent",
    });
  });
});

describe("POST /api/sessions — 성공 경로", () => {
  it("body 의 agent 가 응답 / DB 양쪽에 보존된다", async () => {
    const app = buildApp();
    const res = await app.request("/api/sessions", {
      method: "POST",
      headers: { ...AUTH_HEADER, "content-type": "application/json" },
      body: JSON.stringify({
        repoPath: "/tmp/x",
        title: "안티그래비티 시도",
        agent: "agy",
        skipPermissions: true,
        mode: "pty",
      }),
    });
    expect(res.status).toBe(200);
    const body = await jsonAs<CreateSessionResponse>(res);
    expect(body).toMatchObject({
      repoPath: "/tmp/x",
      title: "안티그래비티 시도",
      agent: "agy",
      skipPermissions: true,
      mode: "pty",
    });
    expect(body.sessionId).toMatch(/^[0-9a-f-]{36}$/);

    // DB 가 같은 값을 들고 있는지 — schema 단언과 동시에 SELECT 가 동작하는지 확인.
    const row = db()
      .prepare("SELECT agent, skip_permissions, mode, title FROM sessions WHERE id = ?")
      .get(body.sessionId) as {
      agent: string;
      skip_permissions: number;
      mode: string;
      title: string | null;
    };
    expect(row).toEqual({
      agent: "agy",
      skip_permissions: 1,
      mode: "pty",
      title: "안티그래비티 시도",
    });
  });

  it("agent 누락 시 claude_code 로 기본 (옛 iOS 빌드 호환)", async () => {
    const app = buildApp();
    const res = await app.request("/api/sessions", {
      method: "POST",
      headers: { ...AUTH_HEADER, "content-type": "application/json" },
      body: JSON.stringify({ repoPath: "/tmp/x" }),
    });
    expect(res.status).toBe(200);
    expect((await jsonAs<CreateSessionResponse>(res)).agent).toBe("claude_code");
  });

  it("4개 어댑터 모두 spawn 가능 — claude_code / shell / codex / agy", async () => {
    const app = buildApp();
    for (const id of ["claude_code", "shell", "codex", "agy"]) {
      const res = await app.request("/api/sessions", {
        method: "POST",
        headers: { ...AUTH_HEADER, "content-type": "application/json" },
        body: JSON.stringify({ repoPath: "/tmp/x", agent: id }),
      });
      expect(res.status, `agent=${id}`).toBe(200);
      expect((await jsonAs<CreateSessionResponse>(res)).agent).toBe(id);
    }
  });
});

describe("POST /api/sessions — 로컬 추론 군 동시 1개 제약", () => {
  // local_llm 과 opencode 는 같은 llama-server(--parallel 1)를 공유한다 — 군을 통틀어 활성
  // 세션 1개. 초과는 409 local_llm_session_limit (iOS ApiClient 가 친절한 메시지로 변환).
  async function create(app: Hono, agent: string): Promise<Response> {
    return app.request("/api/sessions", {
      method: "POST",
      headers: { ...AUTH_HEADER, "content-type": "application/json" },
      body: JSON.stringify({ repoPath: "/tmp/x", agent }),
    });
  }

  it("local_llm 활성 중 opencode 생성은 409 (cross-adapter 군 제약)", async () => {
    const app = buildApp();
    expect((await create(app, "local_llm")).status).toBe(200);
    const blocked = await create(app, "opencode");
    expect(blocked.status).toBe(409);
    expect((await jsonAs<ErrorResponse>(blocked)).error).toBe("local_llm_session_limit");
  });

  it("opencode 활성 중 또 다른 opencode/local_llm 생성도 409", async () => {
    const app = buildApp();
    expect((await create(app, "opencode")).status).toBe(200);
    expect((await create(app, "opencode")).status).toBe(409);
    expect((await create(app, "local_llm")).status).toBe(409);
  });

  it("비-로컬추론 에이전트는 군 제약과 무관 — 활성 opencode 가 있어도 claude_code 생성 가능", async () => {
    const app = buildApp();
    expect((await create(app, "opencode")).status).toBe(200);
    expect((await create(app, "claude_code")).status).toBe(200);
  });
});

describe("POST /api/sessions — repo 경로 자동 생성 / 검증", () => {
  // 회귀: 예전엔 입력 경로의 폴더가 없으면 PTY 가 그 cwd 로 spawn 하다 ENOENT 로 죽어
  // 사용자는 빈 채팅 화면(silent failure)만 봤다. 이제 mkdir -p 로 만들거나, 못 만들면
  // repo_dir_failed + 한국어 사유로 400 (iOS 가 alert).

  it("존재하지 않는 절대경로는 폴더를 만들고 200 — silent ENOENT 방지", async () => {
    const app = buildApp();
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "ps-newrepo-"));
    const target = path.join(parent, "nested", "repo"); // 중간 경로까지 mkdir -p 여야 한다.
    expect(fs.existsSync(target)).toBe(false);
    const res = await app.request("/api/sessions", {
      method: "POST",
      headers: { ...AUTH_HEADER, "content-type": "application/json" },
      body: JSON.stringify({ repoPath: target }),
    });
    expect(res.status).toBe(200);
    expect((await jsonAs<CreateSessionResponse>(res)).repoPath).toBe(target);
    expect(fs.statSync(target).isDirectory()).toBe(true);
    fs.rmSync(parent, { recursive: true, force: true });
  });

  it("상대경로는 400 repo_dir_failed + 한국어 사유 (절대경로 강제)", async () => {
    const app = buildApp();
    const res = await app.request("/api/sessions", {
      method: "POST",
      headers: { ...AUTH_HEADER, "content-type": "application/json" },
      body: JSON.stringify({ repoPath: "relative/repo" }),
    });
    expect(res.status).toBe(400);
    const body = await jsonAs<{ error: string; message: string }>(res);
    expect(body.error).toBe("repo_dir_failed");
    expect(body.message.length).toBeGreaterThan(0);
  });

  it("파일을 가리키는 경로는 400 repo_dir_failed (폴더가 아님)", async () => {
    const app = buildApp();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ps-repofile-"));
    const file = path.join(dir, "f.txt");
    fs.writeFileSync(file, "x");
    const res = await app.request("/api/sessions", {
      method: "POST",
      headers: { ...AUTH_HEADER, "content-type": "application/json" },
      body: JSON.stringify({ repoPath: file }),
    });
    expect(res.status).toBe(400);
    expect((await jsonAs<ErrorResponse>(res)).error).toBe("repo_dir_failed");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("GET /api/sessions — 쿼리", () => {
  it("limit 가 결과 개수를 제한", async () => {
    const app = buildApp();
    for (let i = 0; i < 7; i++) {
      await app.request("/api/sessions", {
        method: "POST",
        headers: { ...AUTH_HEADER, "content-type": "application/json" },
        body: JSON.stringify({ repoPath: `/tmp/r${i}` }),
      });
    }
    const res = await app.request("/api/sessions?limit=3", { headers: AUTH_HEADER });
    expect(res.status).toBe(200);
    expect((await jsonAs<SessionListResponse>(res)).sessions).toHaveLength(3);
  });

  it("waiting_since — 입력 대기 중인 세션만 시각이 실리고 나머지는 null", async () => {
    const app = buildApp();
    const created = await app.request("/api/sessions", {
      method: "POST",
      headers: { ...AUTH_HEADER, "content-type": "application/json" },
      body: JSON.stringify({ repoPath: "/tmp/rw1" }),
    });
    const { sessionId } = await jsonAs<CreateSessionResponse>(created);
    await app.request("/api/sessions", {
      method: "POST",
      headers: { ...AUTH_HEADER, "content-type": "application/json" },
      body: JSON.stringify({ repoPath: "/tmp/rw2" }),
    });

    const ptyRunner = await import("../agent/pty-runner.js");
    vi.mocked(ptyRunner.getPtyWaitingSince).mockImplementation((id: string) =>
      id === sessionId ? 1_700_000_000_000 : null,
    );
    try {
      const res = await app.request("/api/sessions", { headers: AUTH_HEADER });
      expect(res.status).toBe(200);
      const list = (await jsonAs<SessionListResponse>(res)).sessions;
      expect(list.find((s) => s.id === sessionId)?.waiting_since).toBe(1_700_000_000_000);
      expect(list.find((s) => s.id !== sessionId)?.waiting_since).toBeNull();
    } finally {
      vi.mocked(ptyRunner.getPtyWaitingSince).mockReturnValue(null);
    }
  });

  it("pending_prompt_preview — 대기 세션만 미리보기가 실리고 나머지는 생략(undefined)", async () => {
    const app = buildApp();
    const created = await app.request("/api/sessions", {
      method: "POST",
      headers: { ...AUTH_HEADER, "content-type": "application/json" },
      body: JSON.stringify({ repoPath: "/tmp/pp1" }),
    });
    const { sessionId } = await jsonAs<CreateSessionResponse>(created);
    await app.request("/api/sessions", {
      method: "POST",
      headers: { ...AUTH_HEADER, "content-type": "application/json" },
      body: JSON.stringify({ repoPath: "/tmp/pp2" }),
    });

    const ptyRunner = await import("../agent/pty-runner.js");
    vi.mocked(ptyRunner.getPtyPendingPreview).mockImplementation((id: string) =>
      id === sessionId ? "이 변경을 적용할까요? (y/n)" : null,
    );
    try {
      const res = await app.request("/api/sessions", { headers: AUTH_HEADER });
      expect(res.status).toBe(200);
      const list = (await jsonAs<SessionListResponse>(res)).sessions;
      expect(list.find((s) => s.id === sessionId)?.pending_prompt_preview).toBe(
        "이 변경을 적용할까요? (y/n)",
      );
      // 대기 아님(추출 null) 세션은 필드 자체가 생략된다 — 구 iOS 호환·회귀 0.
      expect(list.find((s) => s.id !== sessionId)).not.toHaveProperty("pending_prompt_preview");
    } finally {
      vi.mocked(ptyRunner.getPtyPendingPreview).mockReturnValue(null);
    }
  });

  it("onlyResumable=1 는 parent_sdk_session_id 가 있는 row 만", async () => {
    const app = buildApp();
    // 둘 만들고, 하나엔 resumeFrom 박는다.
    await app.request("/api/sessions", {
      method: "POST",
      headers: { ...AUTH_HEADER, "content-type": "application/json" },
      body: JSON.stringify({ repoPath: "/tmp/r1" }),
    });
    await app.request("/api/sessions", {
      method: "POST",
      headers: { ...AUTH_HEADER, "content-type": "application/json" },
      body: JSON.stringify({
        repoPath: "/tmp/r2",
        resumeFrom: "11111111-2222-3333-4444-555555555555",
      }),
    });

    const all = await app.request("/api/sessions", { headers: AUTH_HEADER });
    expect((await jsonAs<SessionListResponse>(all)).sessions).toHaveLength(2);

    const resumable = await app.request("/api/sessions?onlyResumable=1", {
      headers: AUTH_HEADER,
    });
    const list = (await jsonAs<SessionListResponse>(resumable)).sessions;
    expect(list).toHaveLength(1);
    expect(list[0]?.parent_sdk_session_id).toBe("11111111-2222-3333-4444-555555555555");
  });
});

describe("출처 브리프 역참조 (po_provenance)", () => {
  // po_briefs 의 4 종 *_session_id 컬럼 중 하나에 세션 id 를 박아 «브리프에서 만든 세션» 을 흉내낸다.
  function seedBrief(briefId: string, title: string, sessionColumn: string, sessionId: string): void {
    const now = Date.now();
    db()
      .prepare(
        `INSERT INTO po_briefs
           (id, repo_path, title, problem, evidence, impact, effort, score, scope, spec, status, created_at, updated_at, ${sessionColumn})
         VALUES (?, ?, ?, ?, '[]', 3, 2, 1.5, ?, ?, 'running', ?, ?, ?)`,
      )
      .run(briefId, "/tmp/repo", title, "문제", "스코프", "스펙", now, now, sessionId);
  }

  async function createSession(app: Hono, repoPath: string): Promise<string> {
    const res = await app.request("/api/sessions", {
      method: "POST",
      headers: { ...AUTH_HEADER, "content-type": "application/json" },
      body: JSON.stringify({ repoPath }),
    });
    return (await jsonAs<CreateSessionResponse>(res)).sessionId;
  }

  // 4 종 출처 컬럼 → kind 매핑 — 각 경로가 올바른 종류로 실리는지 검증.
  const cases: Array<{ column: string; kind: string }> = [
    { column: "exec_session_id", kind: "exec" },
    { column: "collect_session_id", kind: "collect" },
    { column: "cleanup_session_id", kind: "cleanup" },
    { column: "revising_session_id", kind: "revise" },
  ];

  for (const { column, kind } of cases) {
    it(`목록·조회 응답에 ${column} → kind=${kind} 출처 브리프가 실린다`, async () => {
      const app = buildApp();
      const sid = await createSession(app, `/tmp/${kind}`);
      seedBrief(`brief-${kind}`, `브리프 ${kind}`, column, sid);

      // 목록
      const listRes = await app.request("/api/sessions", { headers: AUTH_HEADER });
      const item = (await jsonAs<SessionListResponse>(listRes)).sessions.find((s) => s.id === sid);
      expect(item?.source_brief).toEqual({ id: `brief-${kind}`, title: `브리프 ${kind}`, kind });

      // 조회
      const getRes = await app.request(`/api/sessions/${sid}`, { headers: AUTH_HEADER });
      const detail = await jsonAs<SessionDetailResponse>(getRes);
      expect(detail.session.source_brief).toEqual({ id: `brief-${kind}`, title: `브리프 ${kind}`, kind });
    });
  }

  it("브리프 출처가 없는 일반 세션은 source_brief 가 생략(undefined)된다", async () => {
    const app = buildApp();
    const sid = await createSession(app, "/tmp/plain");

    const listRes = await app.request("/api/sessions", { headers: AUTH_HEADER });
    const item = (await jsonAs<SessionListResponse>(listRes)).sessions.find((s) => s.id === sid);
    expect(item).not.toHaveProperty("source_brief");

    const getRes = await app.request(`/api/sessions/${sid}`, { headers: AUTH_HEADER });
    const detail = await jsonAs<SessionDetailResponse>(getRes);
    expect(detail.session).not.toHaveProperty("source_brief");
  });

  it("title 이 비어도(NULL) id·kind 는 실린다", async () => {
    const app = buildApp();
    const sid = await createSession(app, "/tmp/notitle");
    const now = Date.now();
    db()
      .prepare(
        `INSERT INTO po_briefs
           (id, repo_path, title, problem, evidence, impact, effort, score, scope, spec, status, created_at, updated_at, exec_session_id)
         VALUES (?, ?, '', '문제', '[]', 3, 2, 1.5, '스코프', '스펙', 'running', ?, ?, ?)`,
      )
      .run("brief-empty", "/tmp/repo", now, now, sid);

    const getRes = await app.request(`/api/sessions/${sid}`, { headers: AUTH_HEADER });
    const detail = await jsonAs<SessionDetailResponse>(getRes);
    expect(detail.session.source_brief?.id).toBe("brief-empty");
    expect(detail.session.source_brief?.kind).toBe("exec");
  });
});

describe("세션 보관 (session_archive_v1)", () => {
  type PatchResponse = { ok: boolean; session: SessionListItem };
  type BulkResponse = { ok: boolean; action: string; affected: number };

  async function createOne(app: Hono, repoPath = "/tmp/x"): Promise<string> {
    const res = await app.request("/api/sessions", {
      method: "POST",
      headers: { ...AUTH_HEADER, "content-type": "application/json" },
      body: JSON.stringify({ repoPath }),
    });
    return (await jsonAs<CreateSessionResponse>(res)).sessionId;
  }

  async function list(app: Hono, query = ""): Promise<SessionListItem[]> {
    const res = await app.request(`/api/sessions${query}`, { headers: AUTH_HEADER });
    expect(res.status).toBe(200);
    return (await jsonAs<SessionListResponse>(res)).sessions;
  }

  async function patchArchived(app: Hono, id: string, archived: unknown): Promise<Response> {
    return app.request(`/api/sessions/${id}`, {
      method: "PATCH",
      headers: { ...AUTH_HEADER, "content-type": "application/json" },
      body: JSON.stringify({ archived }),
    });
  }

  async function bulk(app: Hono, action: unknown, ids: unknown): Promise<Response> {
    return app.request("/api/sessions/bulk", {
      method: "POST",
      headers: { ...AUTH_HEADER, "content-type": "application/json" },
      body: JSON.stringify({ action, ids }),
    });
  }

  it("새 세션은 미보관(archived=0)이고 기본 목록에 실린다", async () => {
    const app = buildApp();
    const id = await createOne(app);
    const sessions = await list(app);
    expect(sessions.find((s) => s.id === id)?.archived).toBe(0);
  });

  it("PATCH archived:true → 기본 목록에서 사라지고 ?archived=1 에서만 보인다", async () => {
    const app = buildApp();
    const id = await createOne(app);

    const res = await patchArchived(app, id, true);
    expect(res.status).toBe(200);
    expect((await jsonAs<PatchResponse>(res)).session.archived).toBe(1);

    // 기본 목록(미보관만)에서 사라진다.
    expect((await list(app)).find((s) => s.id === id)).toBeUndefined();
    // ?archived=1 (보관분만) 에서 보인다.
    const archivedOnly = await list(app, "?archived=1");
    expect(archivedOnly.find((s) => s.id === id)?.archived).toBe(1);
    // ?archived=all 은 둘 다 — 보관분도 포함.
    expect((await list(app, "?archived=all")).find((s) => s.id === id)?.archived).toBe(1);
  });

  it("PATCH archived:false → 보관 해제(복구) round-trip", async () => {
    const app = buildApp();
    const id = await createOne(app);
    await patchArchived(app, id, true);
    const res = await patchArchived(app, id, false);
    expect(res.status).toBe(200);
    expect((await jsonAs<PatchResponse>(res)).session.archived).toBe(0);
    // 기본 목록에 다시 보인다.
    expect((await list(app)).find((s) => s.id === id)?.archived).toBe(0);
  });

  it("archived 가 boolean 아니면 400 (다른 필드는 안 건드림)", async () => {
    const app = buildApp();
    const id = await createOne(app);
    const res = await patchArchived(app, id, 1);
    expect(res.status).toBe(400);
  });

  it("archived 키 없으면 변경 안 함 — title PATCH 가 archived 를 보존 (부분 PATCH 시멘틱)", async () => {
    const app = buildApp();
    const id = await createOne(app);
    await patchArchived(app, id, true);
    const res = await app.request(`/api/sessions/${id}`, {
      method: "PATCH",
      headers: { ...AUTH_HEADER, "content-type": "application/json" },
      body: JSON.stringify({ title: "이름만 바꿈" }),
    });
    const patched = await jsonAs<PatchResponse>(res);
    expect(patched.session.title).toBe("이름만 바꿈");
    expect(patched.session.archived).toBe(1);
  });

  it("bulk archive → 여러 세션을 한 번에 보관, affected 가 반영 수", async () => {
    const app = buildApp();
    const a = await createOne(app, "/tmp/a");
    const b = await createOne(app, "/tmp/b");
    const c = await createOne(app, "/tmp/c");

    const res = await bulk(app, "archive", [a, b]);
    expect(res.status).toBe(200);
    expect(await jsonAs<BulkResponse>(res)).toEqual({ ok: true, action: "archive", affected: 2 });

    const visible = (await list(app)).map((s) => s.id);
    expect(visible).toContain(c);
    expect(visible).not.toContain(a);
    expect(visible).not.toContain(b);
    expect((await list(app, "?archived=1")).map((s) => s.id).sort()).toEqual([a, b].sort());
  });

  it("bulk unarchive → 보관분을 한 번에 복구", async () => {
    const app = buildApp();
    const a = await createOne(app, "/tmp/a");
    const b = await createOne(app, "/tmp/b");
    await bulk(app, "archive", [a, b]);
    const res = await bulk(app, "unarchive", [a, b]);
    expect(await jsonAs<BulkResponse>(res)).toEqual({ ok: true, action: "unarchive", affected: 2 });
    const visible = (await list(app)).map((s) => s.id);
    expect(visible).toContain(a);
    expect(visible).toContain(b);
  });

  it("bulk delete → 세션을 완전히 제거", async () => {
    const app = buildApp();
    const a = await createOne(app, "/tmp/a");
    const b = await createOne(app, "/tmp/b");
    const c = await createOne(app, "/tmp/c");
    const res = await bulk(app, "delete", [a, b]);
    expect(res.status).toBe(200);
    expect(await jsonAs<BulkResponse>(res)).toEqual({ ok: true, action: "delete", affected: 2 });
    // 둘 다 사라지고 c 만 남는다 (?archived=all 로 보관 여부 무관하게 전수 확인).
    expect((await list(app, "?archived=all")).map((s) => s.id)).toEqual([c]);
  });

  it("bulk 는 존재하지 않는 id 를 건너뛰고 부분 성공 — affected 는 실제 반영 수", async () => {
    const app = buildApp();
    const a = await createOne(app, "/tmp/a");
    const res = await bulk(app, "archive", [a, "no-such-id"]);
    expect(await jsonAs<BulkResponse>(res)).toEqual({ ok: true, action: "archive", affected: 1 });
  });

  it("bulk — 모르는 action 은 400", async () => {
    const app = buildApp();
    const id = await createOne(app);
    const res = await bulk(app, "nuke", [id]);
    expect(res.status).toBe(400);
  });

  it("bulk — ids 가 배열 아니면 400", async () => {
    const app = buildApp();
    const res = await bulk(app, "archive", "not-an-array");
    expect(res.status).toBe(400);
  });

  it("bulk — 빈 ids 는 affected:0 (no-op)", async () => {
    const app = buildApp();
    const res = await bulk(app, "archive", []);
    expect(res.status).toBe(200);
    expect((await jsonAs<BulkResponse>(res)).affected).toBe(0);
  });
});

describe("GET /api/sessions/:id/usage — 토큰 잔량", () => {
  it("usage() 없는 agent (shell) 는 supported:false — iOS 가 UI 를 숨긴다", async () => {
    const app = buildApp();
    const created = await app.request("/api/sessions", {
      method: "POST",
      headers: { ...AUTH_HEADER, "content-type": "application/json" },
      body: JSON.stringify({ repoPath: "/tmp/x", agent: "shell" }),
    });
    const id = (await jsonAs<CreateSessionResponse>(created)).sessionId;

    const res = await app.request(`/api/sessions/${id}/usage`, { headers: AUTH_HEADER });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ supported: false, windows: [] });
  });

  it("없는 세션이면 404", async () => {
    const app = buildApp();
    const res = await app.request("/api/sessions/nonexistent/usage", { headers: AUTH_HEADER });
    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/sessions/:id — notifyMuted (세션 단위 알림 음소거)", () => {
  type PatchResponse = { ok: boolean; session: SessionListItem };

  async function createOne(app: Hono): Promise<string> {
    const res = await app.request("/api/sessions", {
      method: "POST",
      headers: { ...AUTH_HEADER, "content-type": "application/json" },
      body: JSON.stringify({ repoPath: "/tmp/x" }),
    });
    return (await jsonAs<CreateSessionResponse>(res)).sessionId;
  }

  it("기본은 0(켜짐) — 목록 응답에도 notify_muted 가 실린다", async () => {
    const app = buildApp();
    await createOne(app);
    const res = await app.request("/api/sessions", { headers: AUTH_HEADER });
    const list = (await jsonAs<SessionListResponse>(res)).sessions;
    expect(list[0]?.notify_muted).toBe(0);
  });

  it("true → 1 저장, false → 0 복원 — round-trip", async () => {
    const app = buildApp();
    const id = await createOne(app);

    const mute = await app.request(`/api/sessions/${id}`, {
      method: "PATCH",
      headers: { ...AUTH_HEADER, "content-type": "application/json" },
      body: JSON.stringify({ notifyMuted: true }),
    });
    expect(mute.status).toBe(200);
    expect((await jsonAs<PatchResponse>(mute)).session.notify_muted).toBe(1);

    const unmute = await app.request(`/api/sessions/${id}`, {
      method: "PATCH",
      headers: { ...AUTH_HEADER, "content-type": "application/json" },
      body: JSON.stringify({ notifyMuted: false }),
    });
    expect((await jsonAs<PatchResponse>(unmute)).session.notify_muted).toBe(0);
  });

  it("boolean 아니면 400", async () => {
    const app = buildApp();
    const id = await createOne(app);
    const res = await app.request(`/api/sessions/${id}`, {
      method: "PATCH",
      headers: { ...AUTH_HEADER, "content-type": "application/json" },
      body: JSON.stringify({ notifyMuted: 1 }),
    });
    expect(res.status).toBe(400);
  });

  it("notifyMuted 키 없으면 변경 안 함 — title 만 바꿔도 mute 유지 (PATCH 시멘틱)", async () => {
    const app = buildApp();
    const id = await createOne(app);
    await app.request(`/api/sessions/${id}`, {
      method: "PATCH",
      headers: { ...AUTH_HEADER, "content-type": "application/json" },
      body: JSON.stringify({ notifyMuted: true }),
    });
    const res = await app.request(`/api/sessions/${id}`, {
      method: "PATCH",
      headers: { ...AUTH_HEADER, "content-type": "application/json" },
      body: JSON.stringify({ title: "새 제목" }),
    });
    const patched = await jsonAs<PatchResponse>(res);
    expect(patched.session.title).toBe("새 제목");
    expect(patched.session.notify_muted).toBe(1);
  });
});

describe("POST /api/sessions/:id/pty/control — 일괄 승인/중지", () => {
  type OkResponse = { ok: boolean };

  async function createPty(app: Hono, agent?: string): Promise<string> {
    const res = await app.request("/api/sessions", {
      method: "POST",
      headers: { ...AUTH_HEADER, "content-type": "application/json" },
      body: JSON.stringify({ repoPath: "/tmp/x", mode: "pty", ...(agent ? { agent } : {}) }),
    });
    return (await jsonAs<CreateSessionResponse>(res)).sessionId;
  }

  it("없는 세션 → 404", async () => {
    const app = buildApp();
    const res = await app.request("/api/sessions/nope/pty/control", {
      method: "POST",
      headers: { ...AUTH_HEADER, "content-type": "application/json" },
      body: JSON.stringify({ action: "approve" }),
    });
    expect(res.status).toBe(404);
  });

  it("모르는 action → 400", async () => {
    const app = buildApp();
    const id = await createPty(app);
    const res = await app.request(`/api/sessions/${id}/pty/control`, {
      method: "POST",
      headers: { ...AUTH_HEADER, "content-type": "application/json" },
      body: JSON.stringify({ action: "nuke" }),
    });
    expect(res.status).toBe(400);
  });

  it("approve → Enter(0x0d), interrupt → ESC(0x1b) 를 writePtyRaw 로 보낸다", async () => {
    const ptyRunner = await import("../agent/pty-runner.js");
    vi.mocked(ptyRunner.writePtyRaw).mockClear().mockReturnValue(true);
    const app = buildApp();
    const id = await createPty(app);

    const approve = await app.request(`/api/sessions/${id}/pty/control`, {
      method: "POST",
      headers: { ...AUTH_HEADER, "content-type": "application/json" },
      body: JSON.stringify({ action: "approve" }),
    });
    expect(approve.status).toBe(200);
    expect((await jsonAs<OkResponse>(approve)).ok).toBe(true);
    expect(vi.mocked(ptyRunner.writePtyRaw)).toHaveBeenLastCalledWith(id, Buffer.from([0x0d]));

    const interrupt = await app.request(`/api/sessions/${id}/pty/control`, {
      method: "POST",
      headers: { ...AUTH_HEADER, "content-type": "application/json" },
      body: JSON.stringify({ action: "interrupt" }),
    });
    expect(interrupt.status).toBe(200);
    expect(vi.mocked(ptyRunner.writePtyRaw)).toHaveBeenLastCalledWith(id, Buffer.from([0x1b]));
  });

  it("copilot/shell 세션의 interrupt → Ctrl-C(0x03) — ESC 가 무력한 어댑터는 어댑터 취소 키를 쓴다", async () => {
    const ptyRunner = await import("../agent/pty-runner.js");
    const app = buildApp();

    for (const agent of ["copilot", "shell"] as const) {
      vi.mocked(ptyRunner.writePtyRaw).mockClear().mockReturnValue(true);
      const id = await createPty(app, agent);
      const interrupt = await app.request(`/api/sessions/${id}/pty/control`, {
        method: "POST",
        headers: { ...AUTH_HEADER, "content-type": "application/json" },
        body: JSON.stringify({ action: "interrupt" }),
      });
      expect(interrupt.status).toBe(200);
      // 어댑터가 광고한 Ctrl-C(0x03) 로 진행 turn 을 끊는다 (claude/codex 의 ESC 가 아님).
      expect(vi.mocked(ptyRunner.writePtyRaw)).toHaveBeenLastCalledWith(id, Buffer.from([0x03]));

      // approve 는 어댑터 무관하게 Enter(0x0d) 그대로.
      const approve = await app.request(`/api/sessions/${id}/pty/control`, {
        method: "POST",
        headers: { ...AUTH_HEADER, "content-type": "application/json" },
        body: JSON.stringify({ action: "approve" }),
      });
      expect(approve.status).toBe(200);
      expect(vi.mocked(ptyRunner.writePtyRaw)).toHaveBeenLastCalledWith(id, Buffer.from([0x0d]));
    }
  });

  it("agy/opencode/local_llm 세션의 interrupt → ESC(0x1b) — 어댑터가 광고한 취소 키를 쓴다", async () => {
    const ptyRunner = await import("../agent/pty-runner.js");
    const app = buildApp();

    // 셋 다 Gemini CLI 계보(agy·qwen) 또는 TUI(opencode)라 진행 turn 취소 키가 ESC.
    // 폴백과 같은 키지만 어댑터의 interruptBytes() 를 «실제로» 거치는지 못박는다.
    for (const agent of ["agy", "opencode", "local_llm"] as const) {
      vi.mocked(ptyRunner.writePtyRaw).mockClear().mockReturnValue(true);
      const id = await createPty(app, agent);
      const interrupt = await app.request(`/api/sessions/${id}/pty/control`, {
        method: "POST",
        headers: { ...AUTH_HEADER, "content-type": "application/json" },
        body: JSON.stringify({ action: "interrupt" }),
      });
      expect(interrupt.status).toBe(200);
      expect(vi.mocked(ptyRunner.writePtyRaw)).toHaveBeenLastCalledWith(id, Buffer.from([0x1b]));

      // approve 는 어댑터 무관하게 Enter(0x0d) 그대로.
      const approve = await app.request(`/api/sessions/${id}/pty/control`, {
        method: "POST",
        headers: { ...AUTH_HEADER, "content-type": "application/json" },
        body: JSON.stringify({ action: "approve" }),
      });
      expect(approve.status).toBe(200);
      expect(vi.mocked(ptyRunner.writePtyRaw)).toHaveBeenLastCalledWith(id, Buffer.from([0x0d]));

      // opencode·local_llm 은 같은 llama-server 를 공유해 동시 활성 세션이 1개로 제한된다
      // (local_llm_session_limit). 다음 반복이 409 로 막히지 않게 검증 끝난 세션은 비활성화.
      db().prepare("UPDATE sessions SET status = 'completed' WHERE id = ?").run(id);
    }
  });
});

describe("GET /api/sessions/:id/git/branch", () => {
  type BranchResponse = { branch: string | null };

  // repoPath 로 세션 하나 만들고 그 id 를 돌려준다 — git/branch 가 session.repo_path 를 본다.
  async function createSessionAt(repoPath: string): Promise<{ app: Hono; id: string }> {
    const app = buildApp();
    const res = await app.request("/api/sessions", {
      method: "POST",
      headers: { ...AUTH_HEADER, "content-type": "application/json" },
      body: JSON.stringify({ repoPath }),
    });
    expect(res.status).toBe(200);
    const id = (await jsonAs<CreateSessionResponse>(res)).sessionId;
    return { app, id };
  }

  // 글로벌 init.defaultBranch 에 의존하지 않도록 HEAD 를 명시 브랜치로 박는다(커밋 0개 unborn).
  function gitInitAt(dir: string, branch: string): void {
    execFileSync("git", ["init", dir], { stdio: "ignore" });
    execFileSync("git", ["-C", dir, "symbolic-ref", "HEAD", `refs/heads/${branch}`], {
      stdio: "ignore",
    });
  }

  it("갓 git init 한 (커밋 0개) repo 도 브랜치명을 반환한다 — 회귀", async () => {
    // 회귀: 옛 구현(rev-parse --abbrev-ref HEAD)은 커밋이 없으면 fatal → null → 「Git 없음」.
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ps-gitbranch-init-"));
    gitInitAt(repo, "trunk");
    const { app, id } = await createSessionAt(repo);
    const res = await app.request(`/api/sessions/${id}/git/branch`, { headers: AUTH_HEADER });
    expect(res.status).toBe(200);
    expect(await jsonAs<BranchResponse>(res)).toEqual({ branch: "trunk" });
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("git repo 가 아니면 branch: null", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ps-gitbranch-none-"));
    const { app, id } = await createSessionAt(dir);
    const res = await app.request(`/api/sessions/${id}/git/branch`, { headers: AUTH_HEADER });
    expect(res.status).toBe(200);
    expect(await jsonAs<BranchResponse>(res)).toEqual({ branch: null });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("커밋이 있는 repo 는 현재 브랜치명을 반환한다", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ps-gitbranch-commit-"));
    gitInitAt(repo, "work");
    fs.writeFileSync(path.join(repo, "a.txt"), "hi");
    execFileSync("git", ["-C", repo, "add", "a.txt"], { stdio: "ignore" });
    execFileSync(
      "git",
      ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "init"],
      { stdio: "ignore" },
    );
    const { app, id } = await createSessionAt(repo);
    const res = await app.request(`/api/sessions/${id}/git/branch`, { headers: AUTH_HEADER });
    expect(res.status).toBe(200);
    expect(await jsonAs<BranchResponse>(res)).toEqual({ branch: "work" });
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("detached HEAD 는 @짧은sha 로 표시한다", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ps-gitbranch-detach-"));
    gitInitAt(repo, "work");
    fs.writeFileSync(path.join(repo, "a.txt"), "hi");
    execFileSync("git", ["-C", repo, "add", "a.txt"], { stdio: "ignore" });
    execFileSync(
      "git",
      ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "init"],
      { stdio: "ignore" },
    );
    // HEAD 를 커밋 sha 로 detach.
    const sha = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    execFileSync("git", ["-C", repo, "checkout", sha], { stdio: "ignore" });
    const { app, id } = await createSessionAt(repo);
    const res = await app.request(`/api/sessions/${id}/git/branch`, { headers: AUTH_HEADER });
    expect(res.status).toBe(200);
    const body = await jsonAs<BranchResponse>(res);
    expect(body.branch).toMatch(/^@[0-9a-f]{7,}$/);
    fs.rmSync(repo, { recursive: true, force: true });
  });
});

describe("git 브랜치 + worktree 엔드포인트", () => {
  type Branch = {
    name: string;
    sha: string;
    upstream: string | null;
    subject: string;
    current: boolean;
  };
  type BranchesResponse = { current: string | null; local: Branch[]; remote: Branch[] };
  type Worktree = {
    path: string;
    branch: string | null;
    head: string | null;
    isMain: boolean;
    isCurrent: boolean;
    locked: boolean;
    prunable: boolean;
  };
  type WorktreesResponse = { worktrees: Worktree[] };
  type WorktreeAddResponse = { path: string; branch: string };
  type OkResponse = { ok: boolean };

  function gitC(dir: string, ...args: string[]): string {
    return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
  }

  // 명시 브랜치(unborn HEAD) + 첫 커밋까지 — worktree/브랜치 동작은 HEAD 가 있어야 한다.
  function initRepoWithCommit(prefix: string, branch: string): string {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    execFileSync("git", ["init", repo], { stdio: "ignore" });
    execFileSync("git", ["-C", repo, "symbolic-ref", "HEAD", `refs/heads/${branch}`], {
      stdio: "ignore",
    });
    fs.writeFileSync(path.join(repo, "a.txt"), "hi");
    execFileSync("git", ["-C", repo, "add", "a.txt"], { stdio: "ignore" });
    execFileSync(
      "git",
      ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "init"],
      { stdio: "ignore" },
    );
    return repo;
  }

  async function makeSessionAt(repoPath: string): Promise<{ app: Hono; id: string }> {
    const app = buildApp();
    const res = await app.request("/api/sessions", {
      method: "POST",
      headers: { ...AUTH_HEADER, "content-type": "application/json" },
      body: JSON.stringify({ repoPath }),
    });
    expect(res.status).toBe(200);
    const id = (await jsonAs<CreateSessionResponse>(res)).sessionId;
    return { app, id };
  }

  // 테스트가 만든 임시 디렉토리 — afterEach 에서 한 번에 정리(worktree 는 repo 의 형제로
  // 생기므로 <repo>.worktrees 까지 같이 지운다).
  const cleanup: string[] = [];
  afterEach(() => {
    for (const d of cleanup.splice(0)) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  });

  describe("GET .../git/branches", () => {
    it("비-git repo 면 current/local/remote 모두 빈다", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ps-branches-none-"));
      cleanup.push(dir);
      const { app, id } = await makeSessionAt(dir);
      const res = await app.request(`/api/sessions/${id}/git/branches`, { headers: AUTH_HEADER });
      expect(res.status).toBe(200);
      expect(await jsonAs<BranchesResponse>(res)).toEqual({
        current: null,
        local: [],
        remote: [],
      });
    });

    it("로컬 브랜치 목록 + 현재 브랜치 표시", async () => {
      const repo = initRepoWithCommit("ps-branches-local-", "main");
      cleanup.push(repo, `${repo}.worktrees`);
      gitC(repo, "branch", "feature-x");
      const { app, id } = await makeSessionAt(repo);
      const res = await app.request(`/api/sessions/${id}/git/branches`, { headers: AUTH_HEADER });
      expect(res.status).toBe(200);
      const body = await jsonAs<BranchesResponse>(res);
      expect(body.current).toBe("main");
      const names = body.local.map((b) => b.name).sort();
      expect(names).toEqual(["feature-x", "main"]);
      expect(body.local.find((b) => b.name === "main")?.current).toBe(true);
      expect(body.local.find((b) => b.name === "feature-x")?.current).toBe(false);
      expect(body.local.find((b) => b.name === "main")?.subject).toBe("init");
    });

    it("clone 한 repo 는 원격(origin/*) 브랜치를 remote 로, upstream 을 채운다", async () => {
      const origin = initRepoWithCommit("ps-branches-origin-", "main");
      const clone = fs.mkdtempSync(path.join(os.tmpdir(), "ps-branches-clone-"));
      cleanup.push(origin, `${origin}.worktrees`, clone, `${clone}.worktrees`);
      // clone 디렉토리는 비어 있어야 git clone 이 받는다 → 한 단계 하위로.
      const dst = path.join(clone, "wc");
      execFileSync("git", ["clone", origin, dst], { stdio: "ignore" });
      const { app, id } = await makeSessionAt(dst);
      const res = await app.request(`/api/sessions/${id}/git/branches`, { headers: AUTH_HEADER });
      expect(res.status).toBe(200);
      const body = await jsonAs<BranchesResponse>(res);
      expect(body.current).toBe("main");
      expect(body.local.find((b) => b.name === "main")?.upstream).toBe("origin/main");
      expect(body.remote.map((b) => b.name)).toContain("origin/main");
      // origin/HEAD symref 포인터는 목록에서 빠진다.
      expect(body.remote.map((b) => b.name)).not.toContain("origin/HEAD");
    });

    it("원격 목록을 fetch --prune 으로 최신화한다 — 삭제분 제거 + 신규 반영 (회귀)", async () => {
      // 회귀: 예전엔 refs/remotes(로컬 캐시)만 읽어서 (a) 원격에서 삭제된 브랜치의 유령
      // ref 가 계속 남고 (b) 원격에 새로 생긴 브랜치가 안 보였다.
      const origin = initRepoWithCommit("ps-branches-prune-origin-", "main");
      gitC(origin, "branch", "gone-on-origin");
      const clone = fs.mkdtempSync(path.join(os.tmpdir(), "ps-branches-prune-clone-"));
      cleanup.push(origin, `${origin}.worktrees`, clone, `${clone}.worktrees`);
      const dst = path.join(clone, "wc");
      execFileSync("git", ["clone", origin, dst], { stdio: "ignore" });
      // clone 이후 origin 이 바뀐다: 한 브랜치는 삭제, 한 브랜치는 새로 생성.
      gitC(origin, "branch", "-D", "gone-on-origin");
      gitC(origin, "branch", "fresh-on-origin");
      const { app, id } = await makeSessionAt(dst);

      // fetch=0 → 캐시된 stale 상태 그대로: 삭제된 게 남아 있고 신규는 안 보인다.
      const stale = await app.request(`/api/sessions/${id}/git/branches?fetch=0`, {
        headers: AUTH_HEADER,
      });
      const staleNames = (await jsonAs<BranchesResponse>(stale)).remote.map((b) => b.name);
      expect(staleNames).toContain("origin/gone-on-origin");
      expect(staleNames).not.toContain("origin/fresh-on-origin");

      // 기본(fetch on) → prune 으로 삭제분 제거 + 신규 반영.
      const fresh = await app.request(`/api/sessions/${id}/git/branches`, { headers: AUTH_HEADER });
      const freshNames = (await jsonAs<BranchesResponse>(fresh)).remote.map((b) => b.name);
      expect(freshNames).toContain("origin/main");
      expect(freshNames).toContain("origin/fresh-on-origin");
      expect(freshNames).not.toContain("origin/gone-on-origin");
    });
  });

  describe("POST .../git/checkout", () => {
    it("기존 브랜치로 전환하면 current 가 바뀐다", async () => {
      const repo = initRepoWithCommit("ps-checkout-", "main");
      cleanup.push(repo, `${repo}.worktrees`);
      gitC(repo, "branch", "dev");
      const { app, id } = await makeSessionAt(repo);
      const res = await app.request(`/api/sessions/${id}/git/checkout`, {
        method: "POST",
        headers: { ...AUTH_HEADER, "content-type": "application/json" },
        body: JSON.stringify({ name: "dev" }),
      });
      expect(res.status).toBe(200);
      expect(gitC(repo, "symbolic-ref", "--short", "HEAD")).toBe("dev");
    });

    it("`-` 로 시작하는 이름은 400 invalid_branch (argument injection 차단)", async () => {
      const repo = initRepoWithCommit("ps-checkout-inj-", "main");
      cleanup.push(repo, `${repo}.worktrees`);
      const { app, id } = await makeSessionAt(repo);
      const res = await app.request(`/api/sessions/${id}/git/checkout`, {
        method: "POST",
        headers: { ...AUTH_HEADER, "content-type": "application/json" },
        body: JSON.stringify({ name: "-f" }),
      });
      expect(res.status).toBe(400);
      expect((await jsonAs<ErrorResponse>(res)).error).toBe("invalid_branch");
    });

    it("없는 브랜치로 전환하면 409 checkout_failed + message", async () => {
      const repo = initRepoWithCommit("ps-checkout-miss-", "main");
      cleanup.push(repo, `${repo}.worktrees`);
      const { app, id } = await makeSessionAt(repo);
      const res = await app.request(`/api/sessions/${id}/git/checkout`, {
        method: "POST",
        headers: { ...AUTH_HEADER, "content-type": "application/json" },
        body: JSON.stringify({ name: "no-such-branch" }),
      });
      expect(res.status).toBe(409);
      const body = await jsonAs<{ error: string; message: string }>(res);
      expect(body.error).toBe("checkout_failed");
      expect(body.message.length).toBeGreaterThan(0);
    });
  });

  describe("POST .../git/branch", () => {
    it("checkout=false 면 브랜치만 만들고 current 는 그대로", async () => {
      const repo = initRepoWithCommit("ps-branch-create-", "main");
      cleanup.push(repo, `${repo}.worktrees`);
      const { app, id } = await makeSessionAt(repo);
      const res = await app.request(`/api/sessions/${id}/git/branch`, {
        method: "POST",
        headers: { ...AUTH_HEADER, "content-type": "application/json" },
        body: JSON.stringify({ name: "topic", checkout: false }),
      });
      expect(res.status).toBe(200);
      expect(gitC(repo, "symbolic-ref", "--short", "HEAD")).toBe("main");
      expect(gitC(repo, "branch", "--list", "topic")).toContain("topic");
    });

    it("checkout=true 면 생성 후 전환된다", async () => {
      const repo = initRepoWithCommit("ps-branch-co-", "main");
      cleanup.push(repo, `${repo}.worktrees`);
      const { app, id } = await makeSessionAt(repo);
      const res = await app.request(`/api/sessions/${id}/git/branch`, {
        method: "POST",
        headers: { ...AUTH_HEADER, "content-type": "application/json" },
        body: JSON.stringify({ name: "topic2", checkout: true }),
      });
      expect(res.status).toBe(200);
      expect(gitC(repo, "symbolic-ref", "--short", "HEAD")).toBe("topic2");
    });

    it("잘못된 이름은 400 invalid_branch", async () => {
      const repo = initRepoWithCommit("ps-branch-bad-", "main");
      cleanup.push(repo, `${repo}.worktrees`);
      const { app, id } = await makeSessionAt(repo);
      const res = await app.request(`/api/sessions/${id}/git/branch`, {
        method: "POST",
        headers: { ...AUTH_HEADER, "content-type": "application/json" },
        body: JSON.stringify({ name: "bad name with spaces" }),
      });
      expect(res.status).toBe(400);
      expect((await jsonAs<ErrorResponse>(res)).error).toBe("invalid_branch");
    });
  });

  describe("POST .../git/checkpoint", () => {
    type CheckpointResponse = { ok: boolean; sha: string; shortSha: string; subject: string };

    async function checkpoint(app: Hono, id: string, note?: string) {
      return app.request(`/api/sessions/${id}/git/checkpoint`, {
        method: "POST",
        headers: { ...AUTH_HEADER, "content-type": "application/json" },
        body: JSON.stringify(note === undefined ? {} : { note }),
      });
    }

    it("작업트리 변경을 통째로 스냅샷 커밋으로 남긴다 (`checkpoint(ps):` prefix)", async () => {
      const repo = initRepoWithCommit("ps-cp-make-", "main");
      cleanup.push(repo, `${repo}.worktrees`);
      // 미커밋 변경 — 신규 파일 + 기존 파일 수정.
      fs.writeFileSync(path.join(repo, "a.txt"), "changed");
      fs.writeFileSync(path.join(repo, "b.txt"), "new");
      const { app, id } = await makeSessionAt(repo);
      const res = await checkpoint(app, id, "내 스냅샷");
      expect(res.status).toBe(200);
      const body = await jsonAs<CheckpointResponse>(res);
      expect(body.ok).toBe(true);
      expect(body.subject).toBe("checkpoint(ps): 내 스냅샷");
      // HEAD 가 방금 만든 체크포인트 + 작업트리가 깨끗해졌다(add -A 로 전부 스테이지·커밋).
      expect(gitC(repo, "log", "-1", "--format=%s")).toBe("checkpoint(ps): 내 스냅샷");
      expect(gitC(repo, "status", "--porcelain")).toBe("");
      expect(gitC(repo, "show", "HEAD:b.txt")).toBe("new");
    });

    it("깨끗한 트리에서도 --allow-empty 로 복원점을 남긴다", async () => {
      const repo = initRepoWithCommit("ps-cp-clean-", "main");
      cleanup.push(repo, `${repo}.worktrees`);
      const before = gitC(repo, "rev-parse", "HEAD");
      const { app, id } = await makeSessionAt(repo);
      const res = await checkpoint(app, id);
      expect(res.status).toBe(200);
      const body = await jsonAs<CheckpointResponse>(res);
      expect(body.sha).not.toBe(before);
      expect(body.subject.startsWith("checkpoint(ps):")).toBe(true);
    });
  });

  describe("POST .../git/rollback", () => {
    type RollbackResponse = {
      ok: boolean;
      mode: string;
      autoCheckpointSha: string | null;
      resultSha: string;
    };

    async function rollback(app: Hono, id: string, sha: string, mode: string) {
      return app.request(`/api/sessions/${id}/git/rollback`, {
        method: "POST",
        headers: { ...AUTH_HEADER, "content-type": "application/json" },
        body: JSON.stringify({ sha, mode }),
      });
    }

    // 첫 커밋(init) 위에 두 번째 커밋을 더 쌓아 «되돌릴 대상» 을 만든다 → 첫 커밋 sha 반환.
    function repoWithTwoCommits(prefix: string): { repo: string; first: string } {
      const repo = initRepoWithCommit(prefix, "main");
      const first = gitC(repo, "rev-parse", "HEAD");
      fs.writeFileSync(path.join(repo, "a.txt"), "v2");
      gitC(repo, "add", "a.txt");
      gitC(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "second");
      return { repo, first };
    }

    it("revert(비파괴) — 트리를 그 시점으로 되돌리되 기록은 보존한다", async () => {
      const { repo, first } = repoWithTwoCommits("ps-rb-revert-");
      cleanup.push(repo, `${repo}.worktrees`);
      const { app, id } = await makeSessionAt(repo);
      const res = await rollback(app, id, first, "revert");
      expect(res.status).toBe(200);
      const body = await jsonAs<RollbackResponse>(res);
      expect(body.mode).toBe("revert");
      expect(body.autoCheckpointSha).toBeTruthy();
      // 트리 내용은 first 시점과 동일하지만, first 보다 «앞» 의 새 커밋들이 쌓였다(기록 보존).
      expect(gitC(repo, "show", "HEAD:a.txt")).toBe("hi");
      const count = gitC(repo, "rev-list", "--count", "HEAD");
      expect(Number(count)).toBeGreaterThan(2);
    });

    it("reset(파괴) — HEAD 를 그 시점으로 옮기고, 직전 상태는 자동 체크포인트로 남는다", async () => {
      const { repo, first } = repoWithTwoCommits("ps-rb-reset-");
      cleanup.push(repo, `${repo}.worktrees`);
      // 미커밋 변경도 자동 체크포인트가 잡아내는지 확인.
      fs.writeFileSync(path.join(repo, "a.txt"), "dirty");
      const { app, id } = await makeSessionAt(repo);
      const res = await rollback(app, id, first, "reset");
      expect(res.status).toBe(200);
      const body = await jsonAs<RollbackResponse>(res);
      expect(body.mode).toBe("reset");
      expect(body.resultSha).toBe(first);
      expect(gitC(repo, "rev-parse", "HEAD")).toBe(first);
      expect(gitC(repo, "show", "HEAD:a.txt")).toBe("hi");
      // 자동 체크포인트는 reflog 로 복구 가능(미커밋 'dirty' 까지 담겼다).
      expect(body.autoCheckpointSha).toBeTruthy();
      expect(gitC(repo, "show", `${body.autoCheckpointSha}:a.txt`)).toBe("dirty");
    });

    it("잘못된 mode 는 400 invalid_mode", async () => {
      const { repo, first } = repoWithTwoCommits("ps-rb-mode-");
      cleanup.push(repo, `${repo}.worktrees`);
      const { app, id } = await makeSessionAt(repo);
      const res = await rollback(app, id, first, "nuke");
      expect(res.status).toBe(400);
      expect((await jsonAs<ErrorResponse>(res)).error).toBe("invalid_mode");
    });

    it("`-` 로 시작하는 sha 는 400 invalid_ref (argument injection 차단)", async () => {
      const repo = initRepoWithCommit("ps-rb-inj-", "main");
      cleanup.push(repo, `${repo}.worktrees`);
      const { app, id } = await makeSessionAt(repo);
      const res = await rollback(app, id, "-f", "reset");
      expect(res.status).toBe(400);
      expect((await jsonAs<ErrorResponse>(res)).error).toBe("invalid_ref");
    });
  });

  describe("GET .../git/commits — checkpointsOnly", () => {
    type Commit = { sha: string; shortSha: string; subject: string };
    type CommitsResponse = { commits: Commit[]; total: number };

    it("checkpointsOnly=1 이면 `checkpoint(ps):` prefix 커밋만 추린다", async () => {
      const repo = initRepoWithCommit("ps-cp-filter-", "main");
      cleanup.push(repo, `${repo}.worktrees`);
      const { app, id } = await makeSessionAt(repo);

      // 체크포인트 1개 + 일반 커밋 1개를 더 쌓는다.
      await app.request(`/api/sessions/${id}/git/checkpoint`, {
        method: "POST",
        headers: { ...AUTH_HEADER, "content-type": "application/json" },
        body: JSON.stringify({ note: "안전 지점" }),
      });
      fs.writeFileSync(path.join(repo, "a.txt"), "edit");
      gitC(repo, "add", "a.txt");
      gitC(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "일반 커밋");

      // 필터 없음 — init/체크포인트/일반 커밋이 모두 보인다.
      const all = await jsonAs<CommitsResponse>(
        await app.request(`/api/sessions/${id}/git/commits`, { headers: AUTH_HEADER }),
      );
      expect(all.commits.length).toBeGreaterThanOrEqual(3);

      // checkpointsOnly=1 — 체크포인트 커밋만.
      const filtered = await jsonAs<CommitsResponse>(
        await app.request(`/api/sessions/${id}/git/commits?checkpointsOnly=1`, {
          headers: AUTH_HEADER,
        }),
      );
      expect(filtered.commits.length).toBe(1);
      expect(filtered.commits.every((c) => c.subject.startsWith("checkpoint(ps):"))).toBe(true);
      expect(filtered.commits[0]!.subject).toBe("checkpoint(ps): 안전 지점");
    });

    it("체크포인트가 없으면 빈 배열", async () => {
      const repo = initRepoWithCommit("ps-cp-filter-empty-", "main");
      cleanup.push(repo, `${repo}.worktrees`);
      const { app, id } = await makeSessionAt(repo);
      const filtered = await jsonAs<CommitsResponse>(
        await app.request(`/api/sessions/${id}/git/commits?checkpointsOnly=1`, {
          headers: AUTH_HEADER,
        }),
      );
      expect(filtered.commits).toEqual([]);
    });
  });

  describe("worktree add / list / remove", () => {
    it("worktree 생성 → 자동 인접 경로에 디렉토리가 생기고 목록에 뜬다", async () => {
      const repo = initRepoWithCommit("ps-wt-add-", "main");
      cleanup.push(repo, `${repo}.worktrees`);
      const { app, id } = await makeSessionAt(repo);
      const res = await app.request(`/api/sessions/${id}/git/worktrees`, {
        method: "POST",
        headers: { ...AUTH_HEADER, "content-type": "application/json" },
        body: JSON.stringify({ branch: "feature/login", newBranch: true }),
      });
      expect(res.status).toBe(200);
      const added = await jsonAs<WorktreeAddResponse>(res);
      expect(added.branch).toBe("feature/login");
      // slug: `/` → `-`.
      expect(path.basename(added.path)).toBe("feature-login");
      expect(path.basename(path.dirname(added.path))).toMatch(/\.worktrees$/);
      expect(fs.existsSync(added.path)).toBe(true);

      const listRes = await app.request(`/api/sessions/${id}/git/worktrees`, {
        headers: AUTH_HEADER,
      });
      const { worktrees } = await jsonAs<WorktreesResponse>(listRes);
      expect(worktrees.length).toBe(2);
      const main = worktrees.find((w) => w.isMain)!;
      expect(main.isCurrent).toBe(true); // 세션 repo_path = 메인 worktree
      expect(main.branch).toBe("main");
      const wt = worktrees.find((w) => !w.isMain)!;
      expect(wt.branch).toBe("feature/login");
      expect(wt.isCurrent).toBe(false);
    });

    it("같은 경로 중복 생성은 409 target_exists", async () => {
      const repo = initRepoWithCommit("ps-wt-dup-", "main");
      cleanup.push(repo, `${repo}.worktrees`);
      const { app, id } = await makeSessionAt(repo);
      const mk = () =>
        app.request(`/api/sessions/${id}/git/worktrees`, {
          method: "POST",
          headers: { ...AUTH_HEADER, "content-type": "application/json" },
          body: JSON.stringify({ branch: "dup", newBranch: true }),
        });
      expect((await mk()).status).toBe(200);
      const second = await mk();
      expect(second.status).toBe(409);
      expect((await jsonAs<ErrorResponse>(second)).error).toBe("target_exists");
    });

    it("worktree 삭제 → 디렉토리가 사라지고 목록이 메인만 남는다", async () => {
      const repo = initRepoWithCommit("ps-wt-rm-", "main");
      cleanup.push(repo, `${repo}.worktrees`);
      const { app, id } = await makeSessionAt(repo);
      const addRes = await app.request(`/api/sessions/${id}/git/worktrees`, {
        method: "POST",
        headers: { ...AUTH_HEADER, "content-type": "application/json" },
        body: JSON.stringify({ branch: "scratch", newBranch: true }),
      });
      const added = await jsonAs<WorktreeAddResponse>(addRes);
      const del = await app.request(
        `/api/sessions/${id}/git/worktrees?path=${encodeURIComponent(added.path)}`,
        { method: "DELETE", headers: AUTH_HEADER },
      );
      expect(del.status).toBe(200);
      expect(await jsonAs<OkResponse>(del)).toEqual({ ok: true });
      expect(fs.existsSync(added.path)).toBe(false);
      const listRes = await app.request(`/api/sessions/${id}/git/worktrees`, {
        headers: AUTH_HEADER,
      });
      expect((await jsonAs<WorktreesResponse>(listRes)).worktrees.length).toBe(1);
    });

    it("메인 worktree 삭제는 403 cannot_remove_main", async () => {
      const repo = initRepoWithCommit("ps-wt-main-", "main");
      cleanup.push(repo, `${repo}.worktrees`);
      const { app, id } = await makeSessionAt(repo);
      const top = gitC(repo, "rev-parse", "--show-toplevel");
      const del = await app.request(
        `/api/sessions/${id}/git/worktrees?path=${encodeURIComponent(top)}`,
        { method: "DELETE", headers: AUTH_HEADER },
      );
      expect(del.status).toBe(403);
      expect((await jsonAs<ErrorResponse>(del)).error).toBe("cannot_remove_main");
    });

    it("git 이 추적하지 않는 임의 경로 삭제는 404 not_a_worktree", async () => {
      const repo = initRepoWithCommit("ps-wt-arb-", "main");
      cleanup.push(repo, `${repo}.worktrees`);
      const { app, id } = await makeSessionAt(repo);
      const del = await app.request(
        `/api/sessions/${id}/git/worktrees?path=${encodeURIComponent("/tmp/definitely-not-a-worktree-xyz")}`,
        { method: "DELETE", headers: AUTH_HEADER },
      );
      expect(del.status).toBe(404);
      expect((await jsonAs<ErrorResponse>(del)).error).toBe("not_a_worktree");
    });

    it("현재 세션이 위치한 worktree 는 cannot_remove_current 로 보호", async () => {
      const repo = initRepoWithCommit("ps-wt-cur-", "main");
      cleanup.push(repo, `${repo}.worktrees`);
      // 메인 세션에서 worktree 하나 만들고,
      const main = await makeSessionAt(repo);
      const addRes = await main.app.request(`/api/sessions/${main.id}/git/worktrees`, {
        method: "POST",
        headers: { ...AUTH_HEADER, "content-type": "application/json" },
        body: JSON.stringify({ branch: "inside", newBranch: true }),
      });
      const added = await jsonAs<WorktreeAddResponse>(addRes);
      // 그 worktree 경로를 repo_path 로 하는 새 세션을 만든 뒤 자기 자신을 지우려 하면 막혀야 한다.
      const inside = await makeSessionAt(added.path);
      const del = await inside.app.request(
        `/api/sessions/${inside.id}/git/worktrees?path=${encodeURIComponent(added.path)}`,
        { method: "DELETE", headers: AUTH_HEADER },
      );
      expect(del.status).toBe(403);
      expect((await jsonAs<ErrorResponse>(del)).error).toBe("cannot_remove_current");
    });
  });
});

// ─── 콜드 tail 캡 + 역방향 keyset 히스토리 (session_history_v1) ─────────────────
describe("GET /:id/poll?limit + GET /:id/messages — 페이지네이션", () => {
  type PollResponse = {
    messages: Array<{ id: string; type: string; payload: string; created_at: number }>;
    nextCreatedAt: number;
    hasMoreBefore: boolean;
    oldestCreatedAt: number | null;
    oldestId: string | null;
  };
  type HistoryResponse = {
    messages: Array<{ id: string; created_at: number }>;
    hasMoreBefore: boolean;
    oldestCreatedAt: number | null;
    oldestId: string | null;
  };

  /** 세션을 만들고 created_at 을 통제해 N 개의 pty_chunk 를 박는다 (i 번째 created_at = base+i). */
  async function seedSession(app: Hono, count: number, base = 1000): Promise<string> {
    const res = await app.request("/api/sessions", {
      method: "POST",
      headers: { ...AUTH_HEADER, "content-type": "application/json" },
      body: JSON.stringify({ repoPath: "/tmp/x", agent: "claude_code", mode: "pty" }),
    });
    const { sessionId } = await jsonAs<CreateSessionResponse>(res);
    const stmt = db().prepare(
      `INSERT INTO messages (id, session_id, role, type, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (let i = 0; i < count; i++) {
      stmt.run(
        `m${String(i).padStart(4, "0")}`,
        sessionId,
        "assistant",
        "pty_chunk",
        JSON.stringify({ bytes_b64: Buffer.from(`chunk-${i}`).toString("base64") }),
        base + i,
      );
    }
    return sessionId;
  }

  it("콜드 + limit 이면 최신 N 행만 + hasMoreBefore + 가장 오래된 커서", async () => {
    const app = buildApp();
    const id = await seedSession(app, 50);
    const res = await app.request(`/api/sessions/${id}/poll?limit=10`, { headers: AUTH_HEADER });
    expect(res.status).toBe(200);
    const body = await jsonAs<PollResponse>(res);
    expect(body.messages).toHaveLength(10);
    // 최신 10개 (created_at 1040..1049) 가 ASC 로.
    expect(body.messages[0].created_at).toBe(1040);
    expect(body.messages[9].created_at).toBe(1049);
    expect(body.hasMoreBefore).toBe(true);
    expect(body.oldestCreatedAt).toBe(1040);
    expect(body.oldestId).toBe("m0040");
    expect(body.nextCreatedAt).toBe(1049);
  });

  it("limit 없으면(옛 클라이언트) 전체 반환 + hasMoreBefore=false", async () => {
    const app = buildApp();
    const id = await seedSession(app, 30);
    const res = await app.request(`/api/sessions/${id}/poll`, { headers: AUTH_HEADER });
    const body = await jsonAs<PollResponse>(res);
    expect(body.messages).toHaveLength(30);
    expect(body.hasMoreBefore).toBe(false);
  });

  it("증분(afterCreatedAt>0)엔 limit 미적용 — after 이후 전부", async () => {
    const app = buildApp();
    const id = await seedSession(app, 30);
    // 30개 → created_at 1000..1029. 1024 이후 = 1025..1029 (5개). limit=2 를 줘도 증분은 캡하지 않는다.
    const res = await app.request(
      `/api/sessions/${id}/poll?afterCreatedAt=1024&limit=2`,
      { headers: AUTH_HEADER },
    );
    const body = await jsonAs<PollResponse>(res);
    expect(body.messages).toHaveLength(5);
    expect(body.hasMoreBefore).toBe(false);
    expect(body.messages[0].created_at).toBe(1025);
  });

  it("history 가 커서보다 오래된 행만 keyset 으로 역페이지네이션", async () => {
    const app = buildApp();
    const id = await seedSession(app, 50);
    // 콜드로 최신 10개(1040..1049) → oldest 커서 (1040, m0040).
    const cold = await jsonAs<PollResponse>(
      await app.request(`/api/sessions/${id}/poll?limit=10`, { headers: AUTH_HEADER }),
    );
    const res = await app.request(
      `/api/sessions/${id}/messages?beforeCreatedAt=${cold.oldestCreatedAt}&beforeId=${cold.oldestId}&limit=10`,
      { headers: AUTH_HEADER },
    );
    const body = await jsonAs<HistoryResponse>(res);
    expect(body.messages).toHaveLength(10);
    // 1030..1039 (커서 1040 보다 엄격히 오래된 최신 10개) ASC.
    expect(body.messages[0].created_at).toBe(1030);
    expect(body.messages[9].created_at).toBe(1039);
    expect(body.hasMoreBefore).toBe(true);
    expect(body.oldestCreatedAt).toBe(1030);
  });

  it("history 커서 없이 호출하면 최신부터 (콜드와 동일 tail)", async () => {
    const app = buildApp();
    const id = await seedSession(app, 5);
    const body = await jsonAs<HistoryResponse>(
      await app.request(`/api/sessions/${id}/messages?limit=10`, { headers: AUTH_HEADER }),
    );
    expect(body.messages).toHaveLength(5);
    expect(body.hasMoreBefore).toBe(false);
    expect(body.messages[0].created_at).toBe(1000);
  });

  it("같은-ms 행도 복합 커서(created_at,id)로 안 겹치고 안 빠진다", async () => {
    const app = buildApp();
    const res = await app.request("/api/sessions", {
      method: "POST",
      headers: { ...AUTH_HEADER, "content-type": "application/json" },
      body: JSON.stringify({ repoPath: "/tmp/x", agent: "claude_code", mode: "pty" }),
    });
    const { sessionId } = await jsonAs<CreateSessionResponse>(res);
    const stmt = db().prepare(
      `INSERT INTO messages (id, session_id, role, type, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    // 6개 모두 같은 created_at(2000) — id 로만 정렬이 갈린다.
    for (const sfx of ["a", "b", "c", "d", "e", "f"]) {
      stmt.run(`id-${sfx}`, sessionId, "assistant", "pty_chunk", JSON.stringify({ bytes_b64: "AA==" }), 2000);
    }
    const cold = await jsonAs<PollResponse>(
      await app.request(`/api/sessions/${sessionId}/poll?limit=3`, { headers: AUTH_HEADER }),
    );
    // 최신 3 = id DESC 상위 3 = f,e,d → ASC d,e,f.
    expect(cold.messages.map((m) => m.id)).toEqual(["id-d", "id-e", "id-f"]);
    expect(cold.oldestId).toBe("id-d");
    const hist = await jsonAs<HistoryResponse>(
      await app.request(
        `/api/sessions/${sessionId}/messages?beforeCreatedAt=2000&beforeId=id-d&limit=3`,
        { headers: AUTH_HEADER },
      ),
    );
    // 커서 id-d 보다 엄격히 작은 = a,b,c. 겹침/누락 없음.
    expect(hist.messages.map((m) => m.id)).toEqual(["id-a", "id-b", "id-c"]);
    expect(hist.hasMoreBefore).toBe(false);
  });
});

// ─── PTY 화면 스냅샷 (pty_snapshot_v1) ───────────────────────────────────────
describe("GET /:id/pty/snapshot — 헤드리스 VT 스냅샷", () => {
  type SnapshotResponse = {
    snapshot: string;
    cols: number;
    rows: number;
    throughCreatedAt: number;
    truncated: boolean;
  };

  async function makePtySession(app: Hono): Promise<string> {
    const res = await app.request("/api/sessions", {
      method: "POST",
      headers: { ...AUTH_HEADER, "content-type": "application/json" },
      body: JSON.stringify({ repoPath: "/tmp/x", agent: "claude_code", mode: "pty" }),
    });
    return (await jsonAs<CreateSessionResponse>(res)).sessionId;
  }
  function seedChunk(sessionId: string, id: string, text: string, createdAt: number): void {
    db().prepare(
      `INSERT INTO messages (id, session_id, role, type, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      id, sessionId, "assistant", "pty_chunk",
      JSON.stringify({ bytes_b64: Buffer.from(text, "utf8").toString("base64") }),
      createdAt,
    );
  }

  it("청크를 화면으로 재구성 + clear 이전은 접힌다 + watermark", async () => {
    const app = buildApp();
    const id = await makePtySession(app);
    seedChunk(id, "c1", "OLD line before clear\r\n", 1000);
    seedChunk(id, "c2", "\x1b[2J\x1b[H", 1001);            // clear + home
    seedChunk(id, "c3", "hello after clear\r\n", 1002);
    seedChunk(id, "c4", "second line", 1003);

    const res = await app.request(`/api/sessions/${id}/pty/snapshot`, { headers: AUTH_HEADER });
    expect(res.status).toBe(200);
    const body = await jsonAs<SnapshotResponse>(res);
    // clear 이전 라인은 사라지고, 이후 화면만 직렬화에 남는다.
    expect(body.snapshot).toContain("hello after clear");
    expect(body.snapshot).toContain("second line");
    expect(body.snapshot).not.toContain("OLD line before clear");
    expect(body.throughCreatedAt).toBe(1003);
    expect(body.truncated).toBe(false);
  });

  it("청크 없으면 빈 스냅샷", async () => {
    const app = buildApp();
    const id = await makePtySession(app);
    const body = await jsonAs<SnapshotResponse>(
      await app.request(`/api/sessions/${id}/pty/snapshot`, { headers: AUTH_HEADER }),
    );
    expect(body.snapshot).toBe("");
    expect(body.throughCreatedAt).toBe(0);
  });

  it("없는 세션은 404", async () => {
    const app = buildApp();
    const res = await app.request(`/api/sessions/nope/pty/snapshot`, { headers: AUTH_HEADER });
    expect(res.status).toBe(404);
  });
});
