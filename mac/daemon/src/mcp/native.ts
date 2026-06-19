/**
 * 네이티브 MCP 등록 — 에이전트 CLI(claude 등)가 읽는 프로젝트 `.mcp.json` 에 서버를 쓰고/지운다.
 *
 * 경계(브리프 SSOT): MCP 전송·OAuth 인가 흐름(OAuth 2.1+PKCE, RFC 9728 Protected Resource
 * Metadata 자동발견, RFC 8707 resource indicator, DCR)은 «에이전트 CLI 의 네이티브 MCP» 가
 * 담당한다. daemon 은 그 CLI 가 읽는 `.mcp.json` 에 «등록» 만 하고(전송/동의는 CLI 가), 토큰
 * custody·헬스 메타는 config.json(0600)에 들고 있는다. 토큰 본문은 CLI 가 보관 — 폰엔 안 나간다.
 *
 * `.mcp.json` 형식(Claude Code 호환):
 *   { "mcpServers": { "<name>": { "type": "http", "url": "https://..." } } }
 * remote OAuth MCP 는 url + http/sse 전송이면 CLI 가 401→PRM 자동발견→OAuth 동의를 알아서 한다.
 */
import fs from "node:fs";
import path from "node:path";
import type { McpServerConfig } from "../config.js";

type McpJson = {
  mcpServers?: Record<string, { type?: string; url?: string }>;
  [k: string]: unknown;
};

/** `.mcp.json` 안에서 이 서버가 차지하는 안정적 키 — id 앞 8자로 충돌을 피한다. */
export function serverKey(server: Pick<McpServerConfig, "catalogId" | "id">): string {
  const slug = server.catalogId.replace(/[^a-z0-9_]/gi, "_");
  return `pocket_${slug}_${server.id.slice(0, 8)}`;
}

function mcpJsonPath(repoPath: string): string {
  return path.join(repoPath, ".mcp.json");
}

function readMcpJson(repoPath: string): McpJson {
  try {
    return JSON.parse(fs.readFileSync(mcpJsonPath(repoPath), "utf8")) as McpJson;
  } catch {
    return {};
  }
}

function writeMcpJson(repoPath: string, json: McpJson): void {
  fs.writeFileSync(mcpJsonPath(repoPath), JSON.stringify(json, null, 2) + "\n", "utf8");
}

/** 전송 종류 추정 — `/sse` 로 끝나면 sse, 아니면 http(streamable). */
function transportType(url: string): "http" | "sse" {
  return /\/sse\/?$/.test(url) ? "sse" : "http";
}

/** 서버를 프로젝트 `.mcp.json` 에 등록(머지). 다른 서버 엔트리는 보존한다. */
export function registerNative(server: McpServerConfig): void {
  const json = readMcpJson(server.repoPath);
  const servers = json.mcpServers ?? {};
  servers[serverKey(server)] = { type: transportType(server.url), url: server.url };
  writeMcpJson(server.repoPath, { ...json, mcpServers: servers });
}

/** 서버를 `.mcp.json` 에서 제거. 마지막 엔트리면 mcpServers 키를 비운다. 없으면 무시. */
export function unregisterNative(server: McpServerConfig): void {
  const json = readMcpJson(server.repoPath);
  if (!json.mcpServers) return;
  delete json.mcpServers[serverKey(server)];
  writeMcpJson(server.repoPath, json);
}
