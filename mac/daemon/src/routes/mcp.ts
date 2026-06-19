/**
 * `/api/mcp` — MCP «도구» 서버 등록·연결·상태. iOS 「도구」 화면이 단일 소비자.
 *
 *   GET    /api/mcp/catalog       → 알려진 제공자(캘린더/Gmail/사용자지정) + 최소권한 scope
 *   GET    /api/mcp               → 등록된 서버 목록 + custody 헬스 상태 (토큰 본문 미포함)
 *   POST   /api/mcp               → 서버 등록 (.mcp.json 에 native 등록) → 서버
 *   GET    /api/mcp/:id           → 서버 + 도달성 프로브 헬스
 *   POST   /api/mcp/:id/oauth     → OAuth 동의 트리거(CLI 위임) + custody 상태 connected 기록
 *   POST   /api/mcp/:id/revoke    → 토큰 custody 취소(unconfigured) + native 해제, 레코드 유지
 *   DELETE /api/mcp/:id           → 등록 완전 삭제 + native 해제
 *
 * 경계: MCP 전송·OAuth 인가 흐름은 에이전트 CLI 네이티브 MCP 에 위임 — daemon 은 등록·토큰
 * custody(0600)·헬스만 소유한다. 응답엔 OAuth access/refresh 토큰 본문이 절대 들어가지 않는다
 * (애초에 저장도 안 함 — 폰 평문 미전송). 인증: 다른 /api/* 와 동일 bearer.
 */
import { Hono } from "hono";
import { bearerAuth } from "../auth.js";
import { hasAgent } from "../agent/registry.js";
import { resolveAndEnsureRepoDir } from "./sessions.js";
import { MCP_CATALOG, getCatalogEntry, resolveScopes } from "../mcp/catalog.js";
import {
  listServers,
  getServer,
  insertServer,
  updateServer,
  deleteServer,
} from "../mcp/store.js";
import { registerNative, unregisterNative } from "../mcp/native.js";
import { healthOf, probeServer } from "../mcp/health.js";
import type { McpHealth } from "../mcp/health.js";
import type { McpServerConfig } from "../config.js";

export const mcp = new Hono();
mcp.use("*", bearerAuth);

function nonEmptyString(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

/** 응답용 서버 뷰 — 토큰/오류 본문은 빼고 custody 헬스 상태를 합친다(폰 평문 안전). */
function toView(server: McpServerConfig, now = Date.now()) {
  const h = healthOf(server, now);
  return baseView(server, h);
}

/** 공통 직렬화 — 헬스(custody-only 또는 probed)를 합쳐 폰 안전 뷰로. */
function baseView(server: McpServerConfig, h: McpHealth) {
  return {
    id: server.id,
    catalogId: server.catalogId,
    label: server.label,
    agent: server.agent,
    repoPath: server.repoPath,
    url: server.url,
    scopes: server.scopes,
    writeEnabled: server.writeEnabled,
    status: h.status,
    // 도달성 신호(신규 옵셔널 필드 — 옛 클라는 무시). 색은 status 로 이미 하위호환.
    reachable: h.reachable ?? null,
    detail: h.detail ?? null,
    createdAt: server.createdAt,
    connectedAt: server.connectedAt ?? null,
    tokenExpiresAt: server.tokenExpiresAt ?? null,
  };
}

/**
 * 프로브를 반영한 서버 뷰 — 목록·디테일에서 «거짓 초록» 제거용. custody=connected 인 서버만
 * 실제 네트워크 프로브를 타고(나머지는 즉시 custody 헬스 반환), 확정 음성이면 status 를 강등한다.
 */
async function toProbedView(server: McpServerConfig, now = Date.now()) {
  const h = await probeServer(server, fetch, 4000, now);
  return baseView(server, h);
}

mcp.get("/catalog", (c) => {
  return c.json({ catalog: MCP_CATALOG });
});

mcp.get("/", async (c) => {
  const now = Date.now();
  // 목록 표시에도 프로브 반영 — connected 서버만 실제로 네트워크를 타고(병렬), 확정 음성은 강등.
  const servers = await Promise.all(
    listServers().map((s) => toProbedView(s, now)),
  );
  return c.json({ servers });
});

mcp.post("/", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

  const catalogId = nonEmptyString(body.catalogId);
  if (!catalogId) return c.json({ error: "catalogId required" }, 400);
  const entry = getCatalogEntry(catalogId);
  if (!entry) return c.json({ error: "unknown_catalog_id" }, 400);

  const agent = nonEmptyString(body.agent);
  if (!agent) return c.json({ error: "agent required" }, 400);
  if (!hasAgent(agent)) return c.json({ error: "unknown_agent" }, 400);

  const repoInput = nonEmptyString(body.repoPath);
  if (!repoInput) return c.json({ error: "repoPath required" }, 400);
  const dir = resolveAndEnsureRepoDir(repoInput);
  if ("error" in dir) {
    return c.json({ error: "repo_dir_failed", message: dir.error }, 400);
  }

  // URL: body.url 우선, 없으면 카탈로그 기본값. 사용자 지정/기본값 없으면 필수.
  const url = nonEmptyString(body.url) ?? entry.defaultUrl;
  if (!url) return c.json({ error: "url required" }, 400);
  try {
    // http(s) URL 만 허용 — remote MCP 전송 + OAuth 보호 리소스.
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return c.json({ error: "invalid_url" }, 400);
    }
  } catch {
    return c.json({ error: "invalid_url" }, 400);
  }

  const writeEnabled = body.writeEnabled === true;
  // 최소권한: custom 은 body.scopes 를 그대로(없으면 빈), 그 외는 카탈로그 read(+opt-in write).
  const scopes =
    catalogId === "custom"
      ? (Array.isArray(body.scopes) ? body.scopes.filter((s) => typeof s === "string") : [])
      : resolveScopes(entry, writeEnabled);

  const label = nonEmptyString(body.label) ?? entry.label;

  const server = insertServer({
    catalogId,
    label,
    agent,
    repoPath: dir.path,
    url,
    scopes,
    writeEnabled,
  });

  // native 등록 — 에이전트 CLI 가 읽는 .mcp.json 에 기록(전송/OAuth 는 CLI 위임).
  try {
    registerNative(server);
  } catch (e) {
    updateServer(server.id, { status: "error", lastError: (e as Error).message });
    return c.json({ error: "native_register_failed", message: (e as Error).message }, 500);
  }

  return c.json({ server: toView(server) }, 201);
});

mcp.get("/:id", async (c) => {
  const server = getServer(c.req.param("id"));
  if (!server) return c.json({ error: "not_found" }, 404);
  const health = await probeServer(server);
  // server.status 도 프로브 반영(거짓 초록 제거) — health 와 동일 신호.
  return c.json({ server: baseView(server, health), health });
});

// OAuth 동의 트리거 — 실제 인가 흐름(401→PRM 자동발견→PKCE 동의)은 에이전트 CLI 네이티브 MCP 가
// 수행한다. daemon 은 (1) native 등록을 보장하고 (2) custody 상태를 connected 로 기록한다.
// body.tokenExpiresAt(epoch ms) 가 오면 만료 추정 메타로 보관(토큰 본문은 저장 안 함).
mcp.post("/:id/oauth", async (c) => {
  const server = getServer(c.req.param("id"));
  if (!server) return c.json({ error: "not_found" }, 404);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

  try {
    registerNative(server);
  } catch (e) {
    return c.json({ error: "native_register_failed", message: (e as Error).message }, 500);
  }

  const tokenExpiresAt =
    typeof body.tokenExpiresAt === "number" ? body.tokenExpiresAt : undefined;
  const updated = updateServer(server.id, {
    status: "connected",
    connectedAt: Date.now(),
    ...(tokenExpiresAt != null ? { tokenExpiresAt } : {}),
    lastError: undefined,
  });

  return c.json({
    server: updated ? toView(updated) : null,
    // 위임 안내 — iOS 가 «에이전트 세션에서 동의를 완료하세요» 로 표시.
    delegated: { agent: server.agent, repoPath: server.repoPath },
  });
});

// 토큰 custody 취소 — 레코드는 유지하되 unconfigured 로 되돌리고 native 등록을 해제(CLI 가 드롭).
mcp.post("/:id/revoke", (c) => {
  const server = getServer(c.req.param("id"));
  if (!server) return c.json({ error: "not_found" }, 404);
  try {
    unregisterNative(server);
  } catch {
    /* best-effort — .mcp.json 이 이미 없거나 못 읽어도 custody 취소는 진행 */
  }
  const updated = updateServer(server.id, {
    status: "unconfigured",
    connectedAt: undefined,
    tokenExpiresAt: undefined,
    lastError: undefined,
  });
  return c.json({ server: updated ? toView(updated) : null });
});

mcp.delete("/:id", (c) => {
  const server = getServer(c.req.param("id"));
  if (!server) return c.json({ error: "not_found" }, 404);
  try {
    unregisterNative(server);
  } catch {
    /* best-effort */
  }
  deleteServer(server.id);
  return c.json({ ok: true });
});
