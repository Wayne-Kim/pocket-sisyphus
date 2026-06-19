/**
 * MCP 서버 연결 «헬스» — daemon 이 소유하는 세 번째 책임(등록·custody·헬스 중 헬스).
 *
 * 토큰 본문은 에이전트 CLI 가 보관하므로 daemon 이 상류(Google) 토큰을 직접 검증하진 않는다.
 * 대신 (1) custody 상태(config 의 status·tokenExpiresAt)와 (2) MCP 서버 base 의 가벼운 도달성
 * 프로브를 합쳐 «표시용 헬스» 를 만든다. 이 신호로 iOS 가 색(연결=초록 / 만료·오류=danger /
 * 미설정=warning)을 정한다.
 */
import type { McpServerConfig } from "../config.js";

export type McpHealth = {
  id: string;
  /** custody + 프로브를 합친 표시 상태. */
  status: "connected" | "expired" | "error" | "unconfigured";
  /** MCP 서버 base 가 도달 가능한가 (프로브 수행 시). undefined = 프로브 안 함. */
  reachable?: boolean;
  /** 진단 메시지 (있을 때만). */
  detail?: string;
};

/** 토큰 만료가 지났는지 — custody 메타만으로 판정 (네트워크 없이). */
export function isExpired(server: McpServerConfig, now = Date.now()): boolean {
  return server.tokenExpiresAt != null && server.tokenExpiresAt <= now;
}

/** custody 상태만으로 표시 상태 도출 (프로브 없이) — 만료 시각이 지났으면 expired 로 승격. */
export function deriveStatus(
  server: McpServerConfig,
  now = Date.now(),
): McpHealth["status"] {
  if (server.status === "connected" && isExpired(server, now)) return "expired";
  return server.status;
}

/** custody-only 헬스 (네트워크 없음). */
export function healthOf(server: McpServerConfig, now = Date.now()): McpHealth {
  return {
    id: server.id,
    status: deriveStatus(server, now),
    ...(server.lastError ? { detail: server.lastError } : {}),
  };
}

/**
 * 도달성 프로브 — MCP 서버 base 의 RFC 9728 Protected Resource Metadata 엔드포인트를 친다.
 * 200/401 둘 다 «서버 살아있음» 신호다(401 은 인가 필요 = 정상). 네트워크/타임아웃 오류만
 * reachable=false. 토큰은 보내지 않는다 — 순수 도달성 확인.
 */
export async function probeServer(
  server: McpServerConfig,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 4000,
): Promise<McpHealth> {
  const base = healthOf(server);
  if (!server.url) return { ...base, reachable: false, detail: "no url" };
  const probeUrl = new URL(
    "/.well-known/oauth-protected-resource",
    server.url,
  ).toString();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(probeUrl, { signal: ctrl.signal });
    const reachable = res.status > 0;
    return { ...base, reachable };
  } catch (e) {
    return { ...base, reachable: false, detail: (e as Error).message };
  } finally {
    clearTimeout(timer);
  }
}
