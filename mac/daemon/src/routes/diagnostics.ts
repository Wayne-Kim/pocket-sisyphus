// 진단 엔드포인트 — iOS 「문제 신고/진단」 화면이 «사용자가 직접» 묶어 공유/내보내기 할
// 로컬 진단 번들(서브시스템 스냅샷 + 최근 crash 마커 + 마스킹된 unified.log tail)을 돌려준다.
//
// 자동 전송 없음(LAN 전용·무텔레메트리 원칙). 이 라우트는 «읽기» 만 하고 어떤 outbound 도
// 내지 않는다. 비밀(webhook URL·토큰·키)은 diagnostics.ts 가 마스킹한다.
//
// 인증: 다른 /api/* 와 같은 bearer. 127.0.0.1 바인딩 + Tor onion 뒤라 추가 채널 불필요.

import { Hono } from "hono";
import { bearerAuth } from "../auth.js";
import { buildDiagnosticsBundle } from "../diagnostics.js";
import { connectedClientCount } from "../ws/hub.js";
import { getActiveTorProcess } from "../tor/sidecar.js";

export const diagnostics = new Hono();

diagnostics.use("*", bearerAuth);

diagnostics.get("/", (c) => {
  const bundle = buildDiagnosticsBundle({
    connectedClients: connectedClientCount(),
    torActive: getActiveTorProcess() !== null,
  });
  return c.json(bundle);
});
