// 프리뷰 프록시 «실제 데이터 경로» 통합 테스트 — 더미 upstream(dev 서버 흉내)을 띄우고
// 프록시를 통해 검증한다 (네트워크 없이 loopback, in-process):
//   - preview_v1: 진입→쿠키→302, 쿠키로 root + root-relative 자산 forward, 미등록 차단(기본 차단).
//   - preview_v2: HTML/JS 응답의 «등록된» loopback 절대 URL 리라이트(미등록/외부 비변형), HTML 에
//     WS shim 주입, 보조 포트(`/__psport__/<port>`) HTTP 라우팅, 미등록 포트 라우팅 차단,
//     보조 포트 WS upgrade 라운드트립(쿠키 게이트 통과 → raw 파이프).
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs";
import { WebSocketServer, WebSocket } from "ws";

const H = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fsH = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const osH = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pathH = require("node:path") as typeof import("node:path");
  const dir = fsH.mkdtempSync(pathH.join(osH.tmpdir(), "ps-proxy-it-"));
  return { tmpDir: dir, dbFile: pathH.join(dir, "test.db") };
});

vi.mock("../config.js", () => ({
  CONFIG_DIR: H.tmpDir,
  DB_FILE: H.dbFile,
  ensureConfigDir: () => fs.mkdirSync(H.tmpDir, { recursive: true }),
}));

import { db, _resetDbForTest } from "../db/index.js";
import { registerPreviewPort } from "./registry.js";
import { startPreviewProxy, type PreviewProxyHandle } from "./proxy.js";
import { PREVIEW_PORT_PREFIX } from "./rewrite.js";

const SID = "sess-it";
let upstream: http.Server; // 주포트 (앱)
let upstreamPort = 0;
let api: http.Server; // 보조포트 (API + WS)
let apiPort = 0;
let proxy: PreviewProxyHandle;
let proxyBase = "";

/** v1 단일 포트 쿠키 헤더. */
function cookieV1(port: number): string {
  return `ps_preview=${encodeURIComponent(`${SID}~${port}`)}`;
}
/** v2 활성 셋 쿠키 헤더 (주포트 + 보조 포트들). */
function cookieV2(primary: number, ports: number[]): string {
  return `ps_preview=${encodeURIComponent(`${SID}~${primary}~${ports.join(",")}`)}`;
}

beforeAll(async () => {
  // 보조포트(API + WS echo) 를 먼저 띄워 포트를 확정 — 주포트 HTML 이 이 포트를 절대 URL 로 참조.
  api = http.createServer((req, res) => {
    if (req.url === "/api/data") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, from: "api" }));
    } else {
      res.writeHead(404);
      res.end("nope");
    }
  });
  const wss = new WebSocketServer({ server: api, path: "/ws" });
  wss.on("connection", (ws) => {
    ws.on("message", (data) => ws.send(`echo:${data.toString()}`));
  });
  await new Promise<void>((r) => api.listen(0, "127.0.0.1", r));
  apiPort = (api.address() as AddressInfo).port;

  // 주포트(앱) — HTML 은 자기 포트·보조 포트·«외부»(미등록) 포트의 절대 URL 을 섞어 참조.
  upstream = http.createServer((req, res) => {
    if (req.url === "/") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        `<!doctype html><html><head><title>t</title></head><body>DEV ROOT` +
          `<script src="/assets/app.js"></script>` +
          `<link href="http://localhost:${upstreamPort}/style.css">` +
          `<img src="http://127.0.0.1:${apiPort}/api/data">` +
          `<a href="https://cdn.example.com/lib.js">ext</a>` +
          `<span data-ws="ws://localhost:${apiPort}/ws"></span>` +
          `</body></html>`,
      );
    } else if (req.url === "/assets/app.js") {
      res.writeHead(200, { "content-type": "application/javascript" });
      res.end(`console.log("hello from dev"); fetch("http://localhost:${apiPort}/api/data");`);
    } else {
      res.writeHead(404);
      res.end("nope");
    }
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  upstreamPort = (upstream.address() as AddressInfo).port;

  // 세션 + 등록 (주포트 + 보조포트 둘 다 허용).
  db()
    .prepare("INSERT OR IGNORE INTO sessions (id, repo_path, created_at) VALUES (?, ?, ?)")
    .run(SID, "/tmp/repo", Date.now());
  registerPreviewPort(SID, upstreamPort);
  registerPreviewPort(SID, apiPort);

  proxy = await startPreviewProxy(0);
  proxyBase = `http://127.0.0.1:${proxy.port}`;
});

afterAll(async () => {
  await proxy?.stop();
  await new Promise<void>((r) => upstream.close(() => r()));
  await new Promise<void>((r) => api.close(() => r()));
  _resetDbForTest();
  try {
    fs.rmSync(H.tmpDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe("preview proxy data path (v1)", () => {
  it("진입 경로 → 302 + ps_preview 쿠키 (활성 셋 인코딩)", async () => {
    const res = await fetch(`${proxyBase}/__psproxy__/${SID}/${upstreamPort}`, {
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("ps_preview=");
    // 등록된 두 포트가 활성 셋에 인코딩됐는지 (URL 인코딩된 `~`/`,`).
    const decoded = decodeURIComponent(setCookie);
    expect(decoded).toContain(`${SID}~${upstreamPort}~`);
    expect(decoded).toContain(String(apiPort));
  });

  it("쿠키로 root forward — dev 서버 HTML 그대로 (DEV ROOT)", async () => {
    const res = await fetch(`${proxyBase}/`, { headers: { cookie: cookieV1(upstreamPort) } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("DEV ROOT");
  });

  it("root-relative 자산(/assets/app.js)도 forward", async () => {
    const res = await fetch(`${proxyBase}/assets/app.js`, { headers: { cookie: cookieV1(upstreamPort) } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("hello from dev");
  });

  it("미등록 포트는 진입에서 차단(403, 기본 차단)", async () => {
    const res = await fetch(`${proxyBase}/__psproxy__/${SID}/59999`, { redirect: "manual" });
    expect(res.status).toBe(403);
  });

  it("쿠키 없는 일반 요청도 차단(403)", async () => {
    const res = await fetch(`${proxyBase}/`);
    expect(res.status).toBe(403);
  });
});

describe("preview proxy absolute URL rewrite + multi-port (v2)", () => {
  const cookie = () => cookieV2(upstreamPort, [upstreamPort, apiPort]);

  it("HTML 응답의 등록된 loopback 절대 URL 을 프록시 경로로 리라이트", async () => {
    const res = await fetch(`${proxyBase}/`, { headers: { cookie: cookie() } });
    const body = await res.text();
    // 자기 포트 절대 URL → 프록시 경로
    expect(body).toContain(`${PREVIEW_PORT_PREFIX}/${upstreamPort}/style.css`);
    // 보조 포트(127.0.0.1) 절대 URL → 프록시 경로
    expect(body).toContain(`${PREVIEW_PORT_PREFIX}/${apiPort}/api/data`);
    // 원본 절대 URL 은 남지 않아야 (자기·보조)
    expect(body).not.toContain(`http://localhost:${upstreamPort}/style.css`);
    expect(body).not.toContain(`http://127.0.0.1:${apiPort}/api/data`);
  });

  it("외부 도메인은 변형하지 않는다", async () => {
    const res = await fetch(`${proxyBase}/`, { headers: { cookie: cookie() } });
    const body = await res.text();
    expect(body).toContain("https://cdn.example.com/lib.js");
  });

  it("ws(s) 정적 텍스트는 손대지 않고, HTML 에 WS shim 을 주입", async () => {
    const res = await fetch(`${proxyBase}/`, { headers: { cookie: cookie() } });
    const body = await res.text();
    expect(body).toContain(`ws://localhost:${apiPort}/ws`); // 텍스트는 그대로 (shim 이 런타임 처리)
    expect(body).toContain("__psPatched"); // shim 주입됨
    expect(body).toContain("<head>"); // <head> 보존
  });

  it("JS 응답의 절대 URL 도 리라이트 (shim 주입은 안 함)", async () => {
    const res = await fetch(`${proxyBase}/assets/app.js`, { headers: { cookie: cookie() } });
    const body = await res.text();
    expect(body).toContain(`fetch("${PREVIEW_PORT_PREFIX}/${apiPort}/api/data")`);
    expect(body).not.toContain("__psPatched");
  });

  it("보조 포트 HTTP 라우팅 — /__psport__/<apiPort>/api/data → 보조 서버", async () => {
    const res = await fetch(`${proxyBase}${PREVIEW_PORT_PREFIX}/${apiPort}/api/data`, {
      headers: { cookie: cookie() },
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true, from: "api" });
  });

  it("활성 셋에 없는 포트 라우팅은 차단 (403)", async () => {
    // 쿠키 활성 셋을 주포트만으로 한정 → 보조 포트 경로는 미허용.
    const res = await fetch(`${proxyBase}${PREVIEW_PORT_PREFIX}/${apiPort}/api/data`, {
      headers: { cookie: cookieV2(upstreamPort, [upstreamPort]) },
    });
    expect(res.status).toBe(403);
  });

  it("미등록 포트(9999) 라우팅은 차단 (403)", async () => {
    const res = await fetch(`${proxyBase}${PREVIEW_PORT_PREFIX}/9999/x`, {
      headers: { cookie: cookieV2(upstreamPort, [upstreamPort, 9999]) },
    });
    expect(res.status).toBe(403);
  });

  it("보조 포트 WS upgrade 라운드트립 (쿠키 게이트 통과 → echo)", async () => {
    const url = `ws://127.0.0.1:${proxy.port}${PREVIEW_PORT_PREFIX}/${apiPort}/ws`;
    const ws = new WebSocket(url, { headers: { cookie: cookie() } });
    const echoed = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout")), 4000);
      ws.on("open", () => ws.send("ping"));
      ws.on("message", (d) => {
        clearTimeout(timer);
        resolve(d.toString());
        ws.close();
      });
      ws.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
    expect(echoed).toBe("echo:ping");
  });

  it("미등록 포트 WS upgrade 는 거부", async () => {
    const url = `ws://127.0.0.1:${proxy.port}${PREVIEW_PORT_PREFIX}/9999/ws`;
    const ws = new WebSocket(url, { headers: { cookie: cookieV2(upstreamPort, [upstreamPort, 9999]) } });
    const failed = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 4000);
      ws.on("open", () => {
        clearTimeout(timer);
        ws.close();
        resolve(false);
      });
      ws.on("error", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    expect(failed).toBe(true);
  });
});
