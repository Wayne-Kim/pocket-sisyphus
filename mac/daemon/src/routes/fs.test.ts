/**
 * `routes/fs` — `GET /api/fs/list-dir` 단위 테스트.
 *
 * 검증 대상:
 *  - 인증 (bearer 누락/오류 → 401)
 *  - 실제 임시 디렉터리의 하위 폴더 목록 (파일·숨김 제외, 디렉터리 심볼릭 링크 포함, 정렬)
 *  - 존재하지 않는 경로 → exists:false + 빈 목록 (타이핑 중인 미완성 경로 — 에러 아님)
 *  - 상대경로 → exists:false (절대경로 / ~ 만 허용)
 *  - 파일 경로 → exists:false
 *  - path 누락 → home 디렉터리 기준 (exists:true)
 *
 * 격리: sessions.test.ts 와 동일하게 `../config.js` 를 mock 해 고정 token 으로 bearerAuth 를
 * 통과시킨다. 이 라우트는 DB / PTY 를 안 타므로 config mock 만으로 충분하다.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { Hono } from "hono";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// vi.mock 팩토리는 hoisted 라 file-level const 를 못 본다. vi.hoisted 로 tmpdir 만 미리
// 만들어 mock 에 박는다 (sessions.test.ts 와 동일 패턴).
const H = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fsH = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const osH = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pathH = require("node:path") as typeof import("node:path");
  const dir = fsH.mkdtempSync(pathH.join(osH.tmpdir(), "ps-fs-test-"));
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

const { fsRoutes } = await import("./fs.js");
const { hashToken, invalidateAuthCache } = await import("../auth.js");

const TEST_TOKEN = "test-token-fixed-for-determinism";
const AUTH_HEADER = { authorization: `Bearer ${TEST_TOKEN}` };

function buildApp(): Hono {
  const app = new Hono();
  app.route("/api/fs", fsRoutes);
  return app;
}

type ListDirResponse = { base: string; dirs: string[]; exists: boolean };

async function jsonAs<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

// list-dir 테스트가 들여다볼 고정 트리. tmpDir 아래 별도 루트를 둬서 config.json 등과 안 섞이게.
let listRoot: string;

beforeAll(() => {
  fs.writeFileSync(
    H.configFile,
    JSON.stringify({
      port: 7777,
      token: TEST_TOKEN,
      tokenHash: hashToken(TEST_TOKEN),
      createdAt: 0,
    }),
    { mode: 0o600 },
  );
  invalidateAuthCache();

  // 디렉터리 2개 + 파일 1개 + 숨김 디렉터리 1개 + (디렉터리/파일) 심볼릭 링크.
  listRoot = path.join(H.tmpDir, "list-root");
  fs.mkdirSync(path.join(listRoot, "alpha"), { recursive: true });
  fs.mkdirSync(path.join(listRoot, "beta"), { recursive: true });
  fs.mkdirSync(path.join(listRoot, ".hidden"), { recursive: true });
  fs.writeFileSync(path.join(listRoot, "afile.txt"), "x");
  fs.symlinkSync(path.join(listRoot, "alpha"), path.join(listRoot, "link-to-dir"));
  fs.symlinkSync(path.join(listRoot, "afile.txt"), path.join(listRoot, "link-to-file"));
});

afterAll(() => {
  try {
    fs.rmSync(H.tmpDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe("GET /api/fs/list-dir — 인증", () => {
  it("Authorization 헤더 없으면 401", async () => {
    const app = buildApp();
    const res = await app.request("/api/fs/list-dir?path=/tmp");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "missing_bearer" });
  });

  it("틀린 token 이면 401", async () => {
    const app = buildApp();
    const res = await app.request("/api/fs/list-dir?path=/tmp", {
      headers: { authorization: "Bearer wrong-token" },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid_token" });
  });
});

describe("GET /api/fs/list-dir — 목록", () => {
  it("하위 디렉터리만 — 파일·숨김 제외, 디렉터리 심볼릭 링크 포함, 정렬", async () => {
    const app = buildApp();
    const res = await app.request(`/api/fs/list-dir?path=${encodeURIComponent(listRoot)}`, {
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);
    const body = await jsonAs<ListDirResponse>(res);
    expect(body.exists).toBe(true);
    expect(body.base).toBe(listRoot);
    // alpha / beta (실제 디렉터리) + link-to-dir (디렉터리 가리키는 링크) 만.
    // afile.txt (파일), link-to-file (파일 링크), .hidden (숨김) 은 빠진다.
    expect(body.dirs).toEqual(["alpha", "beta", "link-to-dir"]);
  });

  it("존재하지 않는 경로 → exists:false + 빈 목록 (타이핑 중)", async () => {
    const app = buildApp();
    const missing = path.join(listRoot, "no-such-subdir");
    const res = await app.request(`/api/fs/list-dir?path=${encodeURIComponent(missing)}`, {
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);
    expect(await jsonAs<ListDirResponse>(res)).toMatchObject({ dirs: [], exists: false });
  });

  it("상대경로 → exists:false (절대경로 / ~ 만)", async () => {
    const app = buildApp();
    const res = await app.request("/api/fs/list-dir?path=relative/path", { headers: AUTH_HEADER });
    expect(res.status).toBe(200);
    expect(await jsonAs<ListDirResponse>(res)).toMatchObject({ dirs: [], exists: false });
  });

  it("파일을 가리키는 경로 → exists:false", async () => {
    const app = buildApp();
    const file = path.join(listRoot, "afile.txt");
    const res = await app.request(`/api/fs/list-dir?path=${encodeURIComponent(file)}`, {
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);
    expect(await jsonAs<ListDirResponse>(res)).toMatchObject({ dirs: [], exists: false });
  });

  it("path 누락 → home 디렉터리 기준 (exists:true)", async () => {
    const app = buildApp();
    const res = await app.request("/api/fs/list-dir", { headers: AUTH_HEADER });
    expect(res.status).toBe(200);
    const body = await jsonAs<ListDirResponse>(res);
    expect(body.exists).toBe(true);
    expect(body.base).toBe(os.homedir());
    expect(Array.isArray(body.dirs)).toBe(true);
  });

  it("~ 는 home 으로 확장된다", async () => {
    const app = buildApp();
    const res = await app.request("/api/fs/list-dir?path=~", { headers: AUTH_HEADER });
    expect(res.status).toBe(200);
    const body = await jsonAs<ListDirResponse>(res);
    expect(body.base).toBe(os.homedir());
    expect(body.exists).toBe(true);
  });
});
