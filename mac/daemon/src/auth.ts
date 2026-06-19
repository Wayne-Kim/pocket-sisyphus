import crypto from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { readConfig, type DaemonConfig } from "./config.js";

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function generateToken(): string {
  // 32 bytes → base64url ≈ 43 chars
  return crypto.randomBytes(32).toString("base64url");
}

export function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * 부팅 시 한 번 읽어 메모리에 보관.
 *
 * 변경 전엔 `bearerAuth` 가 매 요청마다 `readConfig()` 를 호출해 `fs.readFileSync`
 * + `JSON.parse` 를 했다. iOS 클라이언트가 5s polling + 사용자 액션 + WS upgrade 를
 * 합치면 분당 수십~수백 회 디스크 I/O. cfg 는 daemon 부팅 후 변경되지 않으므로
 * 캐시하는 게 정상.
 *
 * 무효화: `init` CLI 가 token 을 재발급하면 그건 다른 daemon process 라 자동 적용
 *         (daemon 재시작 필요). 런타임 rotation 은 없음.
 */
let cachedConfig: DaemonConfig | null | undefined; // undefined = 아직 안 읽음

/**
 * 메모리 캐시된 config 접근자. bearerAuth / verifyWsToken 외에 attest 미들웨어도 매 요청
 * 이걸 거쳐 disk I/O 를 피한다. 런타임 변경(token rotation, attest 키 등록)은 그 핸들러가
 * 곧장 `invalidateAuthCache()` 를 불러 다음 읽기에서 새 값이 반영되게 한다.
 */
export function getCachedConfig(): DaemonConfig | null {
  if (cachedConfig !== undefined) return cachedConfig;
  cachedConfig = readConfig();
  return cachedConfig;
}

/**
 * 명시적 무효화 — 테스트 / future hot-reload 용. 일반 runtime path 에선 호출 안 됨.
 */
export function invalidateAuthCache(): void {
  cachedConfig = undefined;
}

/** Hono 미들웨어: Authorization: Bearer <token> 검증 */
export const bearerAuth: MiddlewareHandler = async (c, next) => {
  const cfg = getCachedConfig();
  if (!cfg) {
    return c.json({ error: "daemon_not_initialized" }, 503);
  }
  const header = c.req.header("authorization");
  if (!header?.startsWith("Bearer ")) {
    return c.json({ error: "missing_bearer" }, 401);
  }
  const token = header.slice("Bearer ".length).trim();
  if (!timingSafeEqualStr(hashToken(token), cfg.tokenHash)) {
    return c.json({ error: "invalid_token" }, 401);
  }
  return next();
};

/** WS 업그레이드 시 query param ?token=... 검증 (브라우저는 WS에 헤더 추가 불가) */
export function verifyWsToken(token: string | null): boolean {
  if (!token) return false;
  const cfg = getCachedConfig();
  if (!cfg) return false;
  try {
    return timingSafeEqualStr(hashToken(token), cfg.tokenHash);
  } catch {
    return false;
  }
}
