/**
 * MCP 서버 등록 저장소 — config.json(0600) 의 `mcp.servers` 배열에 대한 순수 CRUD.
 * 토큰 custody 의 집이 config.json(0600) 이므로 별도 DB 테이블을 쓰지 않는다(ASC 키와 같은
 * 패턴). 검증·정규화·native 등록(.mcp.json 쓰기)·헬스는 라우트/native.ts/health.ts 가 한다.
 *
 * 폰엔 절대 안 나가는 토큰 본문은 애초에 여기 저장하지 않는다 — daemon 은 «등록 + 상태 메타»
 * 만 들고, OAuth access/refresh 토큰 자체는 에이전트 CLI 네이티브 MCP 가 보관한다(위임). 그래도
 * 이 레코드는 0600 파일에만 산다(추가 방어).
 */
import { randomUUID } from "node:crypto";
import { readConfig, writeConfig, type McpServerConfig } from "../config.js";

export type McpServerInput = {
  catalogId: string;
  label: string;
  agent: string;
  repoPath: string;
  url: string;
  scopes: string[];
  writeEnabled: boolean;
};

export function listServers(): McpServerConfig[] {
  return readConfig()?.mcp?.servers ?? [];
}

export function getServer(id: string): McpServerConfig | undefined {
  return listServers().find((s) => s.id === id);
}

export function insertServer(input: McpServerInput): McpServerConfig {
  const cfg = readConfig();
  if (!cfg) throw new Error("config not initialized");
  const server: McpServerConfig = {
    id: randomUUID(),
    catalogId: input.catalogId,
    label: input.label,
    agent: input.agent,
    repoPath: input.repoPath,
    url: input.url,
    scopes: input.scopes,
    writeEnabled: input.writeEnabled,
    status: "unconfigured",
    createdAt: Date.now(),
  };
  const servers = [...(cfg.mcp?.servers ?? []), server];
  writeConfig({ ...cfg, mcp: { ...cfg.mcp, servers } });
  return server;
}

/** 부분 패치 — undefined 키는 건드리지 않는다. 없는 id 면 undefined. */
export function updateServer(
  id: string,
  patch: Partial<Omit<McpServerConfig, "id" | "createdAt">>,
): McpServerConfig | undefined {
  const cfg = readConfig();
  if (!cfg) return undefined;
  const servers = cfg.mcp?.servers ?? [];
  const idx = servers.findIndex((s) => s.id === id);
  if (idx < 0) return undefined;
  const updated: McpServerConfig = { ...servers[idx], ...patch };
  const next = servers.slice();
  next[idx] = updated;
  writeConfig({ ...cfg, mcp: { ...cfg.mcp, servers: next } });
  return updated;
}

/** 삭제 — 토큰 custody 레코드를 0600 에서 제거. 라우트가 native 해제(.mcp.json)도 같이 한다. */
export function deleteServer(id: string): boolean {
  const cfg = readConfig();
  if (!cfg) return false;
  const servers = cfg.mcp?.servers ?? [];
  const next = servers.filter((s) => s.id !== id);
  if (next.length === servers.length) return false;
  writeConfig({ ...cfg, mcp: { ...cfg.mcp, servers: next } });
  return true;
}
