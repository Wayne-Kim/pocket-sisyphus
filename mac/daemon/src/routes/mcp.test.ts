/**
 * `routes/mcp` + mcp/store + mcp/native + mcp/health 통합 테스트.
 *
 * 격리: POCKET_CLAUDE_CONFIG_DIR 을 tmp 로 박아 config.json(0600)·`.mcp.json` 을 실제로 쓰되
 * 운영 경로엔 손대지 않는다. 네트워크(probeServer)는 fetch mock 으로 차단. agent registry 는
 * 실제(claude_code 등 기본 어댑터가 등록돼 있음).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { Hono } from "hono";

const H = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fsH = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const osH = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pathH = require("node:path") as typeof import("node:path");
  const dir = fsH.mkdtempSync(pathH.join(osH.tmpdir(), "ps-mcp-test-"));
  const repo = fsH.mkdtempSync(pathH.join(osH.tmpdir(), "ps-mcp-repo-"));
  process.env.POCKET_CLAUDE_CONFIG_DIR = dir;
  return { tmpDir: dir, repoDir: repo };
});

// bearerAuth 통과 — 토큰 검증을 우회(다른 라우트 테스트와 동일하게 인증 미들웨어를 no-op).
vi.mock("../auth.js", () => ({
  bearerAuth: async (_c: unknown, next: () => Promise<void>) => {
    await next();
  },
}));

import fs from "node:fs";
import path from "node:path";

let app: Hono;
let writeConfig: typeof import("../config.js").writeConfig;

beforeAll(async () => {
  // agent 어댑터 등록(claude_code 등) — registry 는 registerBuiltinAgents() 로 채워진다.
  const { registerBuiltinAgents } = await import("../agent/index.js");
  registerBuiltinAgents();
  const config = await import("../config.js");
  writeConfig = config.writeConfig;
  const { mcp } = await import("./mcp.js");
  app = new Hono();
  app.route("/api/mcp", mcp);
});

beforeEach(() => {
  // 매 테스트 깨끗한 config — 토큰 custody 의 집. 0600 으로 초기화.
  writeConfig({ port: 3000, tokenHash: "x", createdAt: Date.now() });
  // .mcp.json 초기화 — 기존 무관 서버 보존을 검증하기 위한 시드.
  fs.writeFileSync(
    path.join(H.repoDir, ".mcp.json"),
    JSON.stringify({ mcpServers: { existing_other: { type: "http", url: "https://x" } } }),
  );
});

afterAll(() => {
  fs.rmSync(H.tmpDir, { recursive: true, force: true });
  fs.rmSync(H.repoDir, { recursive: true, force: true });
});

function req(method: string, pathname: string, body?: unknown) {
  return app.request(pathname, {
    method,
    headers: { "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

describe("GET /catalog", () => {
  it("알려진 제공자와 최소권한 scope 를 반환한다", async () => {
    const res = await req("GET", "/api/mcp/catalog");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { catalog: Array<{ id: string; readScopes: string[]; writeScopes: string[] }> };
    const ids = json.catalog.map((e) => e.id);
    expect(ids).toContain("google_calendar");
    expect(ids).toContain("gmail");
    const cal = json.catalog.find((e) => e.id === "google_calendar")!;
    expect(cal.readScopes[0]).toContain("calendar.events.readonly");
  });
});

describe("POST / (서버 등록)", () => {
  it("기본은 읽기 전용 scope 만 부여하고 .mcp.json 에 등록한다", async () => {
    const res = await req("POST", "/api/mcp", {
      catalogId: "google_calendar",
      agent: "claude_code",
      repoPath: H.repoDir,
      url: "https://cal.example.com/mcp",
    });
    expect(res.status).toBe(201);
    const { server } = (await res.json()) as { server: { id: string; scopes: string[]; writeEnabled: boolean; status: string } };
    expect(server.writeEnabled).toBe(false);
    expect(server.scopes.some((s) => s.includes("readonly"))).toBe(true);
    expect(server.scopes.some((s) => s.endsWith("calendar.events"))).toBe(false);
    expect(server.status).toBe("unconfigured");

    // .mcp.json 에 등록되고 기존 서버는 보존.
    const mcpJson = JSON.parse(fs.readFileSync(path.join(H.repoDir, ".mcp.json"), "utf8"));
    expect(mcpJson.mcpServers.existing_other).toBeDefined();
    const keys = Object.keys(mcpJson.mcpServers).filter((k) => k.startsWith("pocket_google_calendar_"));
    expect(keys).toHaveLength(1);
    expect(mcpJson.mcpServers[keys[0]].url).toBe("https://cal.example.com/mcp");

    // 토큰 본문/평문은 응답에 없다.
    expect(JSON.stringify(server)).not.toContain("token_");
  });

  it("writeEnabled=true 면 쓰기 scope 를 opt-in 으로 추가한다", async () => {
    const res = await req("POST", "/api/mcp", {
      catalogId: "google_calendar",
      agent: "claude_code",
      repoPath: H.repoDir,
      url: "https://cal.example.com/mcp",
      writeEnabled: true,
    });
    const { server } = (await res.json()) as { server: { scopes: string[]; writeEnabled: boolean } };
    expect(server.writeEnabled).toBe(true);
    expect(server.scopes.some((s) => s.endsWith("calendar.events"))).toBe(true);
  });

  it("미지원 agent / 잘못된 URL / 누락 필드를 400 으로 거부한다", async () => {
    expect((await req("POST", "/api/mcp", { catalogId: "gmail", agent: "nope", repoPath: H.repoDir, url: "https://x" })).status).toBe(400);
    expect((await req("POST", "/api/mcp", { catalogId: "gmail", agent: "claude_code", repoPath: H.repoDir, url: "ftp://x" })).status).toBe(400);
    expect((await req("POST", "/api/mcp", { catalogId: "unknown", agent: "claude_code", repoPath: H.repoDir, url: "https://x" })).status).toBe(400);
  });
});

describe("OAuth 트리거 / 취소 / 삭제 라이프사이클", () => {
  async function makeServer() {
    const res = await req("POST", "/api/mcp", {
      catalogId: "gmail",
      agent: "claude_code",
      repoPath: H.repoDir,
      url: "https://gmail.example.com/mcp",
    });
    return ((await res.json()) as { server: { id: string } }).server.id;
  }

  it("oauth 트리거가 custody 상태를 connected 로 기록한다", async () => {
    const id = await makeServer();
    const res = await req("POST", `/api/mcp/${id}/oauth`, { tokenExpiresAt: Date.now() + 3600_000 });
    expect(res.status).toBe(200);
    const { server } = (await res.json()) as { server: { status: string; connectedAt: number | null } };
    expect(server.status).toBe("connected");
    expect(server.connectedAt).toBeGreaterThan(0);
  });

  it("만료 시각이 지나면 헬스가 expired 로 승격된다", async () => {
    const id = await makeServer();
    await req("POST", `/api/mcp/${id}/oauth`, { tokenExpiresAt: Date.now() - 1000 });
    const res = await req("GET", "/api/mcp");
    const { servers } = (await res.json()) as { servers: Array<{ id: string; status: string }> };
    expect(servers.find((s) => s.id === id)!.status).toBe("expired");
  });

  it("revoke 가 custody 를 unconfigured 로 되돌리고 native 등록을 해제한다", async () => {
    const id = await makeServer();
    await req("POST", `/api/mcp/${id}/oauth`);
    const res = await req("POST", `/api/mcp/${id}/revoke`);
    expect(res.status).toBe(200);
    const { server } = (await res.json()) as { server: { status: string } };
    expect(server.status).toBe("unconfigured");
    const mcpJson = JSON.parse(fs.readFileSync(path.join(H.repoDir, ".mcp.json"), "utf8"));
    const keys = Object.keys(mcpJson.mcpServers).filter((k) => k.startsWith("pocket_gmail_"));
    expect(keys).toHaveLength(0);
  });

  it("DELETE 가 레코드와 native 등록을 모두 제거한다", async () => {
    const id = await makeServer();
    expect((await req("DELETE", `/api/mcp/${id}`)).status).toBe(200);
    const list = (await (await req("GET", "/api/mcp")).json()) as { servers: unknown[] };
    expect(list.servers).toHaveLength(0);
  });
});

describe("GET /:id 헬스 프로브", () => {
  it("도달 가능한 서버는 reachable=true 를 보고한다", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 401 }));
    const res = await req("POST", "/api/mcp", {
      catalogId: "gmail",
      agent: "claude_code",
      repoPath: H.repoDir,
      url: "https://gmail.example.com/mcp",
    });
    const id = ((await res.json()) as { server: { id: string } }).server.id;
    const probe = await req("GET", `/api/mcp/${id}`);
    const { health } = (await probe.json()) as { health: { reachable: boolean } };
    expect(health.reachable).toBe(true);
    fetchSpy.mockRestore();
  });
});
