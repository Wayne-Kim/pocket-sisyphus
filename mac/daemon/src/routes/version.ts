import { Hono } from "hono";
import { bearerAuth } from "../auth.js";
import { buildVersionResponse } from "../version.js";

/**
 * `/api/version` — 호환성 핸드셰이크 엔드포인트.
 *
 * iOS 클라이언트가 부팅 직후 (페어된 상태에서 Tor .running 진입 시) 한 번 호출해
 * Hard/Soft 호환성을 판정한다. 응답은 시간에 따라 바뀌지 않으므로 (daemon
 * 재시작 없이는) 클라이언트 측에서 세션 단위로만 캐시.
 *
 * Auth: bearer. 다른 `/api/*` 와 같은 규약. 페어링 직후에 호출되므로 token 은
 * 이미 손에 있다.
 */
export const version = new Hono();

version.use("*", bearerAuth);

version.get("/", (c) => c.json(buildVersionResponse()));
