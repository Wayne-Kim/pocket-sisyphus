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
  /**
   * custody + 프로브를 합친 «표시» 상태(색의 SSOT).
   *  - connected   : custody 유효 + (프로브 안 함 | 도달 확인 | 확인 불가) → 초록.
   *  - expired     : 토큰 만료 — custody 가 우선(도달성보다 먼저). → 빨강.
   *  - unreachable : custody 는 connected 이나 «확정» 도달불가(서버가 깨졌거나 죽음). → 빨강.
   *  - error       : 등록/헬스 오류. → 빨강.
   *  - unconfigured: 미동의. → 노랑(설정 필요).
   *
   * 주의: `unreachable` 은 «표시 전용» 으로만 쓰고 config(custody)에는 절대 쓰지 않는다 —
   * 도달성은 매 조회마다 달라지는 휘발 신호이지 custody 상태가 아니다. 옛 iOS 클라이언트는
   * 미지 status 를 .error(빨강)로 폴백하므로 색 매핑은 하위호환된다.
   */
  status: "connected" | "expired" | "error" | "unconfigured" | "unreachable";
  /**
   * 프로브 도달성 3-값:
   *  - true      : «정상 도달 신호»(HTTP 200/401)를 확인.
   *  - false     : «확정 음성» — 서버가 깨진 응답(403/404/5xx) 또는 능동 거부(ECONNREFUSED).
   *  - undefined : 프로브 안 함 | «확인 불가»(타임아웃·DNS·오프라인 등 네트워크 부재 가능).
   */
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
 *
 * 판정(엄격화):
 *  - HTTP 200(메타데이터) 또는 401(인가 필요 = 정상 보호 리소스) → reachable=true.
 *  - 그 외 HTTP(403/404/5xx 등 «살아있지만 깨진» 응답) → reachable=false «확정 음성» → unreachable 로 강등.
 *  - ECONNREFUSED(서버 능동 거부 = 죽음) → reachable=false «확정 음성» → unreachable 로 강등.
 *  - 타임아웃 / DNS / 오프라인 등 → «확인 불가»: reachable 미정(undefined), status 유지 — 단말
 *    네트워크 부재일 수 있으므로 거짓 빨강을 만들지 않는다(확정 음성만 강등).
 *
 * 우선순위: custody 가 connected 가 «아니면»(expired·error·unconfigured) 프로브하지 않고 그대로 둔다 —
 * 만료가 도달성보다 우선이고, 미설정/오류는 이미 비-초록이라 프로브가 색을 바꿀 일이 없다.
 *
 * 한계: 토큰은 에이전트 CLI 가 보관하므로 이 프로브는 «도달성/OAuth 보호 리소스 여부» 까지만
 * 확인한다 — 실제 MCP 도구 호출(list/read) 가능 여부는 검증하지 않는다(상류 토큰 직접 검증은 비-목표).
 */
export async function probeServer(
  server: McpServerConfig,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 4000,
  now = Date.now(),
): Promise<McpHealth> {
  const base = healthOf(server, now);
  // 만료(우선)·미설정·오류는 프로브로 바꾸지 않는다.
  if (base.status !== "connected") return base;
  if (!server.url) {
    return { ...base, status: "error", reachable: false, detail: "no url" };
  }
  const probeUrl = new URL(
    "/.well-known/oauth-protected-resource",
    server.url,
  ).toString();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(probeUrl, { signal: ctrl.signal });
    if (res.status === 200 || res.status === 401) {
      // 도달 확인 — 도구 호출 가능 여부까지는 미검증(한계).
      return {
        ...base,
        reachable: true,
        detail: "도달 확인(OAuth 보호 리소스) — 도구 호출 가능 여부는 미검증",
      };
    }
    // 살아있지만 깨진 응답 — 확정 음성 → 강등.
    return {
      ...base,
      status: "unreachable",
      reachable: false,
      detail: `도달불가: 프로브 HTTP ${res.status}`,
    };
  } catch (e) {
    const code = errorCode(e);
    if (code === "ECONNREFUSED") {
      // 서버가 능동 거부 — 죽음 확정 → 강등.
      return {
        ...base,
        status: "unreachable",
        reachable: false,
        detail: "도달불가: 연결 거부(ECONNREFUSED)",
      };
    }
    // 타임아웃·DNS·오프라인 등 — 확인 불가(네트워크 부재일 수 있음). 강등하지 않음.
    const isTimeout =
      code === "ABORT_ERR" || (e as Error).name === "AbortError";
    return {
      ...base,
      detail: isTimeout
        ? `확인 불가: 프로브 타임아웃(${timeoutMs}ms)`
        : `확인 불가: ${(e as Error).message}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** fetch/네트워크 오류에서 OS 레벨 코드(ECONNREFUSED 등) 또는 AbortError 를 추출. */
function errorCode(e: unknown): string | undefined {
  if (e && typeof e === "object") {
    const anyE = e as { name?: string; code?: string; cause?: { code?: string } };
    if (anyE.name === "AbortError") return "ABORT_ERR";
    return anyE.cause?.code ?? anyE.code;
  }
  return undefined;
}
