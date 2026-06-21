// 라이브 프리뷰 리버스 프록시 (preview_proxy_v1).
//
// 폰에서 dev 서버(localhost:3000 류)를 보기 위한 daemon 측 프록시. iOS 는 기존 SSH/Tor 채널
// 위에 «고정 프록시 포트» 로 direct-tcpip local-forward 하나를 더 열고(SSHClient.openForward),
// 그 위에서 WKWebView 가 이 프록시를 가리킨다 — 외부 서버 0, 기존 채널 재사용.
//
// ## 왜 «프록시» 인가 (직접 dev 포트 forward 대신)
// PermitOpen 에 실제 dev 포트를 직접 넣으면 (1) 포트가 바뀔 때마다 sshd_config 재작성·reload,
// (2) 기존 SSH 세션은 연결 시점 PermitOpen 으로 고정돼 새 포트를 못 본다는 두 문제가 있다.
// 대신 «daemon 소유의 고정 프록시 포트» 하나만 PermitOpen 에 두고(부팅 시 1회), 실제 dev 포트
// 허용 여부는 등록부(preview/registry)가 결정한다 — 기본 차단이 유지되고 sshd 는 안 건드린다.
//
// ## 라우팅 (root-relative 자산까지 동작)
// dev 서버 HTML 은 보통 `/assets/x.js` 같은 root-absolute 경로를 쓴다. 경로 prefix 방식은 이게
// 깨지므로, «쿠키 고정» 방식을 쓴다:
//   - 진입 `GET /__psproxy__/:sid/:port` → 등록부 검증 → `ps_preview` 쿠키 설정 → `/` 로 302.
//   - 이후 모든 요청은 쿠키의 (sid, port) 를 매 요청 재검증해 `127.0.0.1:<port>` 로 그대로 forward.
// WKWebView 는 프리뷰마다 «비영속 데이터 스토어» 를 써 쿠키가 프리뷰끼리 섞이지 않는다.
//
// ## 다중 포트 + 절대 URL 리라이트 (preview_v2)
// 실무 앱은 절대 URL 자산(`http://localhost:3000/...`)과 «별도 포트» API/HMR(3001 등)을 흔히
// 쓴다. preview_v2 는:
//   - 진입 시 그 세션에 «등록된 포트 전부» 를 쿠키의 «활성 포트 셋» 으로 인코딩
//     (`<sid>~<주포트>~<p1,p2,...>`). 주포트는 root(`/`)로, 보조 포트는 `/__psport__/<port>/...`
//     경로로 라우팅한다. 미등록 포트는 어디서도 통과하지 않는다(기본 차단 불변).
//   - HTML/JS 응답을 흘리며 «등록된» loopback 절대 URL 을 프록시 경로로 리라이트(rewrite.ts).
//     미등록 포트·외부 도메인은 건드리지 않는다. 압축 응답은 Accept-Encoding 을 떼 uncompressed
//     로 받아 안전하게 리라이트(그래도 압축돼 오면 리라이트 스킵).
//
// ## WebSocket
// Vite/Next 의 HMR(라이브 리로드)은 WS 라, upgrade 도 같은 쿠키 게이트로 upstream 에 raw 파이프.
// 보조 포트 HMR/API 의 ws 도 `/__psport__/<port>/...` 경로로 게이트 통과해 그 포트로 파이프한다
// (브라우저 측 ws URL 은 HTML 에 주입한 shim 이 런타임에 이 경로로 바꾼다 — rewrite.ts 참고).

import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { isPreviewPortAllowed, listPreviewPorts } from "./registry.js";
import {
  PreviewRewriteStream,
  buildWsShim,
  classifyContentType,
  parsePortRoute,
  stripPortPrefix,
} from "./rewrite.js";
import { makeLogger } from "../logging/log.js";

const log = makeLogger("preview");

/** 프리뷰 진입 경로 prefix — 쿠키를 심고 dev 서버 root 로 redirect 하는 진입점. */
export const PREVIEW_ENTRY_PREFIX = "/__psproxy__";

/** 쿠키 이름 — 값은 `<sessionId>~<주포트>` (preview_v1) 또는 `<sessionId>~<주포트>~<p1,p2,...>`
 * (preview_v2, 활성 포트 셋 인코딩). (`~`/`,` 는 UUID/숫자에 안 나와 구분자로 안전.) */
const COOKIE_NAME = "ps_preview";

export type PreviewProxyHandle = {
  port: number;
  stop: () => Promise<void>;
};

/** 한 프리뷰 대상 — 쿠키에서 복원. `port` 는 주포트(root 라우팅 대상), `ports` 는 활성 포트 셋
 * (주포트 + 보조 포트들). 리라이트가 «알려진 dev 포트» 판정에, 보조 라우팅이 게이트에 쓴다. */
type PreviewTarget = { sessionId: string; port: number; ports: number[] };

/**
 * Cookie 헤더 문자열에서 ps_preview 값을 파싱해 (sessionId, 주포트, 활성 포트 셋) 으로 복원.
 * 형식이 안 맞거나 없으면 null. 등록부 검증은 «하지 않는다» — 호출자가 매 요청
 * isPreviewPortAllowed 로 재검증. v1 단일 포트 형식과 하위호환(셋 없으면 `[주포트]`).
 * (순수 함수 — 단위 테스트로 파싱 엣지를 고정한다.)
 */
export function parsePreviewCookie(cookieHeader: string | undefined): PreviewTarget | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name !== COOKIE_NAME) continue;
    const value = decodeURIComponent(part.slice(eq + 1).trim());
    // `<sid>~<port>` 또는 `<sid>~<port>~<csv>`. sid 는 UUID(`~` 없음)라 split 안전.
    const segs = value.split("~");
    if (segs.length < 2) return null;
    const sessionId = segs[0];
    const port = Number.parseInt(segs[1], 10);
    if (!sessionId || !Number.isInteger(port)) return null;
    let ports = [port];
    if (segs.length >= 3 && segs[2]) {
      const set = segs[2]
        .split(",")
        .map((s) => Number.parseInt(s, 10))
        .filter((n) => Number.isInteger(n));
      if (set.length) ports = Array.from(new Set([...set, port]));
    }
    return { sessionId, port, ports };
  }
  return null;
}

/**
 * 진입 경로 `/__psproxy__/:sid/:port[/...]` 를 파싱. 형식이 안 맞으면 null.
 * (순수 함수 — 단위 테스트 대상.)
 */
export function parseEntryPath(pathname: string): { sessionId: string; port: number } | null {
  if (!pathname.startsWith(PREVIEW_ENTRY_PREFIX + "/")) return null;
  const rest = pathname.slice(PREVIEW_ENTRY_PREFIX.length + 1);
  const segs = rest.split("/").filter(Boolean);
  if (segs.length < 2) return null;
  const sessionId = decodeURIComponent(segs[0]);
  const port = Number.parseInt(segs[1], 10);
  if (!sessionId || !Number.isInteger(port)) return null;
  return { sessionId, port };
}

/** 등록부 검증을 통과하지 못한 요청에 보여줄 작은 안내 페이지. */
function denyPage(res: http.ServerResponse, message: string): void {
  const body = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<body style="font-family:-apple-system,sans-serif;padding:24px;color:#333;background:#fafafa">
<h3>프리뷰를 열 수 없어요</h3><p>${message}</p></body>`;
  res.writeHead(403, { "content-type": "text/html; charset=utf-8" });
  res.end(body);
}

/** upstream(dev 서버)이 안 떠 있을 때의 502 페이지. */
function upstreamErrorPage(res: http.ServerResponse, port: number): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  const body = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<body style="font-family:-apple-system,sans-serif;padding:24px;color:#333;background:#fafafa">
<h3>dev 서버에 연결할 수 없어요</h3>
<p>포트 <b>${port}</b> 에서 응답이 없습니다. Mac 에서 dev 서버가 실행 중인지 확인하세요.</p></body>`;
  res.writeHead(502, { "content-type": "text/html; charset=utf-8" });
  res.end(body);
}

/**
 * 프리뷰 리버스 프록시를 127.0.0.1:port 에 띄운다. 진입 → 쿠키 → forward 흐름.
 * `port` 는 caller(server.ts)가 findAvailablePort 로 확정한 «고정 프록시 포트» — 이 값이
 * sshd PermitOpen 과 /api/preview 응답(iOS 가 forward 대상으로 사용)에 그대로 전달된다.
 */
export async function startPreviewProxy(port: number): Promise<PreviewProxyHandle> {
  const server = http.createServer((req, res) => {
    const rawUrl = req.url ?? "/";
    const pathname = rawUrl.split("?")[0];

    // 진입 — 쿠키 심고 dev 서버 root 로 redirect. 쿠키에 그 세션의 «등록된 포트 전부» 를
    // 활성 셋으로 인코딩한다(주포트 = 진입 포트). 리라이트/보조 라우팅이 이 셋을 본다.
    const entry = parseEntryPath(pathname);
    if (entry) {
      if (!isPreviewPortAllowed(entry.sessionId, entry.port)) {
        denyPage(res, "이 포트는 등록되지 않았어요. 세션 화면에서 포트를 먼저 등록하세요.");
        return;
      }
      const active = listPreviewPorts(entry.sessionId).map((p) => p.port);
      if (!active.includes(entry.port)) active.push(entry.port);
      const cookieValue = encodeURIComponent(`${entry.sessionId}~${entry.port}~${active.join(",")}`);
      res.writeHead(302, {
        location: "/",
        "set-cookie": `${COOKIE_NAME}=${cookieValue}; Path=/; SameSite=Lax`,
        "cache-control": "no-store",
      });
      res.end();
      return;
    }

    // 그 외 — 쿠키의 대상으로 forward.
    const target = parsePreviewCookie(req.headers.cookie);
    if (!target) {
      denyPage(res, "프리뷰 세션이 없어요. 다시 열어 주세요.");
      return;
    }
    const active = new Set(target.ports);

    // 보조 포트 명시 라우팅 — `/__psport__/<port>/...`. 활성 셋 + 등록부 둘 다 통과해야 한다.
    const route = parsePortRoute(pathname);
    if (route) {
      if (!active.has(route.port) || !isPreviewPortAllowed(target.sessionId, route.port)) {
        denyPage(res, "이 포트는 등록되지 않았어요. 세션 화면에서 포트를 먼저 등록하세요.");
        return;
      }
      proxyHttp(req, res, route.port, stripPortPrefix(rawUrl, route.port), active);
      return;
    }

    // 주포트 — root 로 그대로 forward.
    if (!isPreviewPortAllowed(target.sessionId, target.port)) {
      denyPage(res, "이 포트는 더 이상 허용되지 않아요. 세션 화면에서 다시 등록하세요.");
      return;
    }
    proxyHttp(req, res, target.port, rawUrl, active);
  });

  // HMR 등 WebSocket — 쿠키 게이트 후 upstream 으로 raw 파이프. 보조 포트는 `/__psport__/<port>`
  // 경로로 그 포트에 파이프(주포트는 root). 게이트는 HTTP 경로와 동일(활성 셋 + 등록부).
  server.on("upgrade", (req, clientSocket, head) => {
    const target = parsePreviewCookie(req.headers.cookie);
    if (!target) {
      clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      clientSocket.destroy();
      return;
    }
    const rawUrl = req.url ?? "/";
    const route = parsePortRoute(rawUrl.split("?")[0]);
    let destPort = target.port;
    let fwdUrl = rawUrl;
    if (route) {
      const active = new Set(target.ports);
      if (!active.has(route.port) || !isPreviewPortAllowed(target.sessionId, route.port)) {
        clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        clientSocket.destroy();
        return;
      }
      destPort = route.port;
      fwdUrl = stripPortPrefix(rawUrl, route.port);
    } else if (!isPreviewPortAllowed(target.sessionId, target.port)) {
      clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      clientSocket.destroy();
      return;
    }
    proxyUpgrade(req, clientSocket, head, destPort, fwdUrl);
  });

  server.on("clientError", (_err, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const bound = (server.address() as AddressInfo)?.port ?? port;
  log.info("preview proxy listening", {
    "event.action": "preview.proxy.listen",
    port: bound,
  });
  console.log(`✔ preview proxy on http://127.0.0.1:${bound} (registered ports only)`);

  return {
    port: bound,
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        // close 는 keep-alive 소켓을 기다리므로, 빠른 종료를 위해 강제 닫기도 시도.
        server.closeAllConnections?.();
      }),
  };
}

/**
 * HTTP 요청 하나를 127.0.0.1:port 로 forward (스트리밍). 우리 쿠키는 떼고 보낸다.
 * - `path`: upstream 으로 보낼 경로(주포트는 원본 rawUrl, 보조 포트는 prefix 떼낸 path).
 * - `activePorts`: 응답 HTML/JS 의 절대 URL 리라이트 대상 «알려진 dev 포트» 셋.
 * 응답이 HTML/JS 면 리라이트 스트림을 통과시키고(HTML 은 WS shim 도 주입), 그 외엔 그대로 파이프.
 * 압축(content-encoding)된 응답은 리라이트하면 깨지므로 스킵 — 그래서 Accept-Encoding 을 떼
 * uncompressed 로 요청한다(그래도 압축돼 오면 안전하게 그대로 흘린다).
 */
function proxyHttp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  port: number,
  path: string,
  activePorts: ReadonlySet<number>,
): void {
  const headers = { ...req.headers };
  // dev 서버가 우리 내부 쿠키에 혼동되지 않게 ps_preview 만 제거.
  if (typeof headers.cookie === "string") {
    const cleaned = headers.cookie
      .split(";")
      .filter((p) => p.trim().split("=")[0].trim() !== COOKIE_NAME)
      .join(";")
      .trim();
    if (cleaned) headers.cookie = cleaned;
    else delete headers.cookie;
  }
  headers.host = `127.0.0.1:${port}`;
  // 리라이트를 위해 uncompressed 로 받는다 (loopback dev 라 압축 이득은 미미, 정확성이 우선).
  delete headers["accept-encoding"];

  const upstream = http.request(
    { host: "127.0.0.1", port, method: req.method, path, headers },
    (up) => {
      const status = up.statusCode ?? 502;
      const ctRaw = up.headers["content-type"];
      const ct = Array.isArray(ctRaw) ? ctRaw[0] : ctRaw;
      const encRaw = up.headers["content-encoding"];
      const enc = (Array.isArray(encRaw) ? encRaw[0] : encRaw)?.toLowerCase();
      const compressed = !!enc && enc !== "identity";
      const { rewrite, html } = classifyContentType(ct);

      if (rewrite && !compressed) {
        // 본문 길이가 바뀌므로 content-length 를 떼고 chunked 로 흘린다.
        const outHeaders = { ...up.headers };
        delete outHeaders["content-length"];
        res.writeHead(status, outHeaders);
        const stream = new PreviewRewriteStream({
          ports: activePorts,
          injectScript: html ? buildWsShim([...activePorts]) : null,
        });
        up.pipe(stream).pipe(res);
      } else {
        res.writeHead(status, up.headers);
        up.pipe(res);
      }
    },
  );
  upstream.on("error", () => upstreamErrorPage(res, port));
  req.pipe(upstream);
}

/** WebSocket upgrade 를 upstream(127.0.0.1:port)으로 raw 파이프. `path` 는 prefix 떼낸 경로. */
function proxyUpgrade(
  req: http.IncomingMessage,
  clientSocket: Duplex,
  head: Buffer,
  port: number,
  path: string,
): void {
  const upstream = net.connect(port, "127.0.0.1", () => {
    // upgrade 요청 라인 + 헤더를 그대로 재구성해 upstream 에 전달.
    const headerLines = [`${req.method} ${path} HTTP/1.1`];
    const h = req.rawHeaders;
    for (let i = 0; i < h.length; i += 2) {
      if (h[i].toLowerCase() === "host") {
        headerLines.push(`Host: 127.0.0.1:${port}`);
      } else {
        headerLines.push(`${h[i]}: ${h[i + 1]}`);
      }
    }
    upstream.write(headerLines.join("\r\n") + "\r\n\r\n");
    if (head && head.length) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });
  upstream.on("error", () => clientSocket.destroy());
  clientSocket.on("error", () => upstream.destroy());
}
