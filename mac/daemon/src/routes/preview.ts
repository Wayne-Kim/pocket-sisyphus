// `/api/preview/*` — 라이브 프리뷰 포트 등록 관리 (preview_proxy_v1).
//
// iOS 가 «세션별로 dev 포트를 명시 등록» 하고, 등록 응답으로 받은 proxyPort/entryPath 로
// 프리뷰 프록시(preview/proxy)를 가리킨다. 실제 forwarding 은 프록시가 등록부를 조회해
// «등록된 포트만» 통과시키므로(기본 차단), 이 라우트가 보안의 «명시 허용» 지점이다.
//
// 전역 `/api/*` 미들웨어(requireClientVersion / requireAttestation)가 이미 걸려 있고,
// 여기서 bearerAuth 를 추가로 강제한다 (recent/git 등 다른 라우트와 동일 패턴).

import { Hono } from "hono";
import net from "node:net";
import { bearerAuth } from "../auth.js";
import { db } from "../db/index.js";
import {
  validatePreviewPort,
  registerPreviewPort,
  unregisterPreviewPort,
  listPreviewPorts,
} from "../preview/registry.js";
import { detectListeningPorts } from "../preview/detect.js";
import { PREVIEW_ENTRY_PREFIX } from "../preview/proxy.js";

export type PreviewDeps = {
  /** 프리뷰 리버스 프록시의 확정 포트. 미설정(0)이면 프리뷰 비활성 → 503. */
  getProxyPort: () => number;
  /** direct-tcpip/내부 예약 포트 — 등록 금지(daemon HTTP/endpoint/ssh/proxy 등). */
  getReservedPorts: () => Set<number>;
  /** 세션 PTY 프로세스 PID — «감지된 포트» 가 자식 트리를 훑을 root. 미가동이면 null. */
  getSessionPtyPid: (sessionId: string) => number | null;
};

function sessionExists(sessionId: string): boolean {
  const row = db()
    .prepare("SELECT 1 FROM sessions WHERE id = ? LIMIT 1")
    .get(sessionId);
  return row !== undefined;
}

/** 등록 포트 목록을 entryPath 까지 붙여 응답용으로 만든다. */
function portsPayload(sessionId: string) {
  return listPreviewPorts(sessionId).map((p) => ({
    port: p.port,
    createdAt: p.createdAt,
    entryPath: `${PREVIEW_ENTRY_PREFIX}/${encodeURIComponent(sessionId)}/${p.port}`,
  }));
}

export function preview(deps: PreviewDeps): Hono {
  const app = new Hono();
  app.use("*", bearerAuth);

  // 프리뷰 사용 가능 여부 + 프록시 포트 (iOS 가 forward 대상으로 사용).
  app.get("/config", (c) => {
    const proxyPort = deps.getProxyPort();
    return c.json({
      enabled: proxyPort > 0,
      proxyPort,
      entryPrefix: PREVIEW_ENTRY_PREFIX,
    });
  });

  // 「이 세션이 띄운」 dev 서버 후보 포트 감지 — 세션 PTY 자식 트리가 LISTEN 중인 TCP 포트.
  // 자동 등록 안 함(노출 0): 후보만 돌려주고 실제 노출은 사용자가 탭해 POST /ports 로 명시
  // 등록할 때만 일어난다(기본 차단 불변). reserved/<1024 는 validatePreviewPort 로 제외.
  // lsof 부재/권한 거부/감지 0건은 빈 배열(에러 아님) → UI 는 수동 입력으로 폴백.
  app.get("/detect", (c) => {
    const sessionId = c.req.query("sessionId");
    if (!sessionId) return c.json({ error: "sessionId required" }, 400);
    const pid = deps.getSessionPtyPid(sessionId);
    const reserved = deps.getReservedPorts();
    const ports = detectListeningPorts(pid)
      .filter((cand) => validatePreviewPort(cand.port, reserved).ok)
      .map((cand) => ({ port: cand.port, command: cand.command }));
    return c.json({ ports });
  });

  // 세션의 등록 포트 목록.
  app.get("/ports", (c) => {
    const sessionId = c.req.query("sessionId");
    if (!sessionId) return c.json({ error: "sessionId required" }, 400);
    return c.json({
      proxyPort: deps.getProxyPort(),
      entryPrefix: PREVIEW_ENTRY_PREFIX,
      ports: portsPayload(sessionId),
    });
  });

  // dev 포트 등록 — 보안의 «명시 허용» 지점. 형식 검증 + 세션 존재 확인 후 등록.
  // preview_v2: 단일 `port` 또는 «여러 포트» `ports: number[]` (주 포트 + 보조 포트들)를 받는다.
  // 하나라도 형식 위반이면 전부 거부(부분 등록으로 «반쯤 열린» 상태를 만들지 않는다).
  app.post("/ports", async (c) => {
    const proxyPort = deps.getProxyPort();
    if (proxyPort <= 0) {
      return c.json({ error: "preview_disabled" }, 503);
    }
    const body = await c.req.json().catch(() => null);
    const sessionId = body?.sessionId;
    if (typeof sessionId !== "string" || !sessionId) {
      return c.json({ error: "sessionId required" }, 400);
    }
    if (!sessionExists(sessionId)) {
      return c.json({ error: "session_not_found" }, 404);
    }
    // `ports` 배열이 있으면 그걸, 없으면 단일 `port` 를 본다(하위호환).
    const raw: unknown[] = Array.isArray(body?.ports) ? body.ports : [body?.port];
    if (raw.length === 0) {
      return c.json({ error: "out_of_range" }, 400);
    }
    const reserved = deps.getReservedPorts();
    const validated: number[] = [];
    for (const r of raw) {
      const v = validatePreviewPort(r, reserved);
      if (!v.ok) {
        return c.json({ error: v.reason }, 400);
      }
      validated.push(v.port);
    }
    for (const port of validated) {
      registerPreviewPort(sessionId, port);
    }
    return c.json({
      ok: true,
      proxyPort,
      entryPrefix: PREVIEW_ENTRY_PREFIX,
      ports: portsPayload(sessionId),
    });
  });

  // dev 포트 등록 해제.
  app.delete("/ports", async (c) => {
    const body = await c.req.json().catch(() => null);
    const sessionId = body?.sessionId;
    const port = typeof body?.port === "number" ? body.port : Number.parseInt(String(body?.port), 10);
    if (typeof sessionId !== "string" || !sessionId || !Number.isInteger(port)) {
      return c.json({ error: "sessionId and port required" }, 400);
    }
    unregisterPreviewPort(sessionId, port);
    return c.json({ ok: true, ports: portsPayload(sessionId) });
  });

  // dev 서버가 그 포트에서 실제로 듣고 있는지 — 등록 UI 의 «실행 중» 표시용(등록과 무관).
  app.get("/probe", async (c) => {
    const raw = c.req.query("port");
    const port = raw ? Number.parseInt(raw, 10) : NaN;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return c.json({ error: "port required" }, 400);
    }
    const listening = await probeTcp(port);
    return c.json({ listening });
  });

  return app;
}

/** 127.0.0.1:port 에 짧게 TCP connect 시도해 listener 가 있는지 확인. */
function probeTcp(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port }, () => {
      socket.end();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
    socket.setTimeout(800, () => {
      socket.destroy();
      resolve(false);
    });
  });
}
