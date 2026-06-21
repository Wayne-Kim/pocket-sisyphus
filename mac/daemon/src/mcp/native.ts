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
import { classifyServer, isCappedClass } from "./policy.js";

type McpJson = {
  mcpServers?: Record<string, { type?: string; url?: string }>;
  [k: string]: unknown;
};

/** pocket 이 관리하는 `.mcp.json` 엔트리 키의 접두사 — serverKey 가 박는다. */
const POCKET_KEY_PREFIX = "pocket_";

/** `.mcp.json` 안에서 이 서버가 차지하는 안정적 키 — id 앞 8자로 충돌을 피한다. */
export function serverKey(server: Pick<McpServerConfig, "catalogId" | "id">): string {
  const slug = server.catalogId.replace(/[^a-z0-9_]/gi, "_");
  return `${POCKET_KEY_PREFIX}${slug}_${server.id.slice(0, 8)}`;
}

/** 이 `.mcp.json` 키가 pocket 이 등록한 것인가 (사용자가 손으로 넣은 비-pocket 엔트리와 구분). */
export function isPocketServerKey(key: string): boolean {
  return key.startsWith(POCKET_KEY_PREFIX);
}

/**
 * 무인 경로용 `.mcp.json` 필터 (순수). §M1/M3 «무인 세션엔 READ/LOCAL 만 연결, EGRESS·
 * SOURCE_WRITE 는 미연결». 보수 규칙(M2: 분류 불명은 EGRESS 취급):
 *  - pocket 키: 매칭되는 등록 서버를 찾아 클래스 분류 → 캡 대상(EGRESS/SOURCE_WRITE)이면 제거.
 *    매칭 서버가 없는 orphan pocket 키도 정체 불명 → 보수적으로 제거.
 *  - 비-pocket 키(사용자 직접 추가): daemon 이 분류를 모름 → 보수적으로 EGRESS 취급 → 제거.
 * 즉 «pocket 이 관리하는 READ/LOCAL» 만 남는다.
 *
 * @returns 남길 mcpServers 와 제거된 키 목록.
 */
export function filterMcpServersForUnattended(
  mcpServers: Record<string, { type?: string; url?: string }>,
  registered: readonly McpServerConfig[],
): { kept: Record<string, { type?: string; url?: string }>; removed: string[] } {
  const byKey = new Map<string, McpServerConfig>();
  for (const s of registered) byKey.set(serverKey(s), s);

  const kept: Record<string, { type?: string; url?: string }> = {};
  const removed: string[] = [];
  for (const [key, entry] of Object.entries(mcpServers)) {
    if (!isPocketServerKey(key)) {
      removed.push(key); // 비-pocket: 분류 불명 → 보수적으로 차단.
      continue;
    }
    const server = byKey.get(key);
    if (server && !isCappedClass(classifyServer(server))) {
      kept[key] = entry; // pocket READ/LOCAL — 연결 허용.
    } else {
      removed.push(key); // pocket 캡 대상 또는 orphan(정체 불명) → 차단.
    }
  }
  return { kept, removed };
}

/**
 * repo `.mcp.json` 에 «무인 경로에서 미연결돼야 할» 캡/정체불명 엔트리 키를 돌려준다(IO, 읽기만).
 * 무인 세션이 실제로 무엇을 물려받는지의 «정본» 신호 — 계약 테스트가 이걸로 «미등록» 을 단언한다.
 * 등록 custody 뷰(registered)와 무관하게, 디스크의 `.mcp.json` 을 직접 읽어 손편집까지 잡는다.
 */
export function cappedMcpJsonKeys(repoPath: string, registered: readonly McpServerConfig[]): string[] {
  const json = readMcpJson(repoPath);
  if (!json.mcpServers) return [];
  return filterMcpServersForUnattended(json.mcpServers, registered).removed;
}

/**
 * worktree 등 «격리 가능» 한 무인 실행 디렉토리의 `.mcp.json` 을 READ/LOCAL 만 남게 다시 쓴다
 * (§C2 격리 — EGRESS-free 세션). 변경이 없으면 파일을 건드리지 않는다. @returns 제거된 키.
 *
 * 주의: 공유 repo(cron 처럼 cwd=repo)에는 쓰지 말 것 — 대화형 세션이 같은 파일을 읽으므로
 * 손상 위험. 공유 repo 의 무인 보호는 «정적 거부»(guardUnattendedRepo)가 fail-closed 로 맡는다.
 */
export function materializeUnattendedMcpJson(
  repoPath: string,
  registered: readonly McpServerConfig[],
): string[] {
  const json = readMcpJson(repoPath);
  if (!json.mcpServers) return [];
  const { kept, removed } = filterMcpServersForUnattended(json.mcpServers, registered);
  if (removed.length === 0) return [];
  writeMcpJson(repoPath, { ...json, mcpServers: kept });
  return removed;
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
