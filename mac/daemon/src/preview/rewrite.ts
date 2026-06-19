// 라이브 프리뷰 «절대 URL 리라이트» (preview_v2).
//
// preview_v1 은 싱글포트·상대경로 앱에서만 완벽했다. 실무의 Next.js/Vite/풀스택 템플릿은
// 절대 URL 자산(`http://localhost:3000/...`)과 별도 포트 API/HMR(`http://localhost:3001`,
// `ws://localhost:3001`)을 흔히 박아 쓴다 — 그러면 폰 프리뷰에서 그 URL 이 «폰의» loopback
// 으로 향해 빈 화면/깨진 자산이 된다.
//
// 이 모듈은 dev 서버가 돌려준 HTML/JS 응답에서 «동일 호스트(loopback) 절대 URL» 중 사용자가
// 등록한 «알려진 dev 포트» 만 골라 프록시 origin 기준 경로로 바꾼다:
//   - HTTP(S): `http(s)://(localhost|127.0.0.1):PORT/path` → `/__psport__/PORT/path`
//     (루트-상대라 브라우저가 현재 origin(프록시)으로 해석 → 프록시가 포트별로 라우팅.)
//   - WS(S): 정적 텍스트의 ws URL 은 손대지 «않고», 대신 HTML `<head>` 에 작은 shim 스크립트를
//     주입해 런타임에 `window.WebSocket` 을 패치한다. 이유: 상대경로 ws URL 은 스펙상 불가
//     (`new WebSocket('/x')` 는 throw) — 브라우저의 실제 host(`location.host`)를 런타임에만 알
//     수 있으므로 정적 치환으로는 올바른 절대 ws URL 을 만들 수 없다. shim 은 그 host 를 읽어
//     `ws(s)://<host>/__psport__/PORT/path` 로 바꾼다 (정적·동적 생성 ws 모두 포착).
//
// ## 비-목표 (명시)
//   - 외부 도메인/타 호스트 프록시: loopback(localhost·127.0.0.1) «등록된» 포트만 대상.
//     CDN·실제 외부 URL 은 절대 변형하지 않는다.
//   - 코드 안에서 문자열 결합으로 만든 HTTP URL(`'http://'+host`)은 정적 리라이트가 못 잡는다
//     (과잉 변형 금지 — 원본 그대로 둔다). WS 는 shim 이 런타임에 잡으므로 예외.
//
// ## 스트리밍 안전
// 응답은 청크로 흘러오므로, 토큰(`http://localhost:3000`)이 청크 경계에서 갈릴 수 있다.
// PreviewRewriteStream 이 «완성될 수 있는 트레일링 부분토큰» 을 leftover 로 들고 다음 청크와
// 합쳐 처리한다 — 경계에서 토큰이 깨지거나 잘못 매칭(`:300` 뒤에 `0` 이 더 올 수 있음)되지 않게.

import { Transform } from "node:stream";

/** 포트별 라우팅 경로 prefix. 진입(`/__psproxy__`)과 달리, 이미 쿠키가 걸린 뒤 «어느 dev 포트로
 * 보낼지» 를 path 로 지시한다. 리라이트 결과(`/__psport__/3001/...`)와 프록시 라우터가 짝이다. */
export const PREVIEW_PORT_PREFIX = "/__psport__";

/** 리라이트 대상 HTTP(S) loopback URL — scheme + authority 까지만 매칭(뒤 path 는 원본 유지). */
const HTTP_TOKEN_RE = /(https?):\/\/(localhost|127\.0\.0\.1):(\d+)/gi;

/**
 * 텍스트 안의 «등록된 dev 포트» HTTP(S) loopback 절대 URL 을 프록시 경로로 치환한다.
 * 미등록 포트·외부 도메인·ws(s) 는 건드리지 않는다(과잉 변형 금지). 순수 함수 — 단위 테스트 대상.
 */
export function rewriteUrls(text: string, ports: ReadonlySet<number>): string {
  return text.replace(HTTP_TOKEN_RE, (m, _scheme: string, _host: string, port: string) =>
    ports.has(Number.parseInt(port, 10)) ? `${PREVIEW_PORT_PREFIX}/${port}` : m,
  );
}

// ─── 스트리밍 경계 안전: 트레일링 부분토큰 검출 ──────────────────────────────────────────────

const SCHEMES = ["http", "https"] as const;
const HOSTS = ["localhost", "127.0.0.1"] as const;

function isPrefixOf(cand: string, full: string): boolean {
  return full.startsWith(cand);
}

/**
 * `cand` 가 «완성되면 HTTP_TOKEN_RE 에 매칭될 수 있는» 토큰의 (비어있지 않은) 접두인가.
 * 즉 청크 끝에 이게 걸려 있으면 다음 청크에서 완성될 수 있으니 leftover 로 들고 가야 한다.
 * 완성형(`http://localhost:3000`)도 true — 포트 숫자가 더 이어질 수 있어 보류 대상.
 * 순수 함수 — 단위 테스트 대상.
 */
export function isHttpTokenPrefix(cand: string): boolean {
  if (cand === "") return false;
  // 1) scheme 자체의 접두 (예: "h", "ht", "http", "https").
  for (const sc of SCHEMES) if (isPrefixOf(cand, sc)) return true;
  // 2) 완성된 scheme 뒤로 "://" + host + ":" + digits 의 접두.
  for (const sc of SCHEMES) {
    if (!cand.startsWith(sc)) continue;
    const rest = cand.slice(sc.length);
    if (rest === ":" || rest === ":/" || rest === "://") return true;
    if (!rest.startsWith("://")) continue;
    const afterSep = rest.slice(3);
    for (const h of HOSTS) {
      if (isPrefixOf(afterSep, h)) return true; // host 의 접두 (빈 문자열 포함)
      if (afterSep === `${h}:`) return true; // host + ":" (포트 숫자 직전)
      if (afterSep.startsWith(`${h}:`)) {
        const dig = afterSep.slice(h.length + 1);
        if (/^\d+$/.test(dig)) return true; // host + ":" + 숫자 (더 이어질 수 있음)
      }
    }
  }
  return false;
}

/** `<head`/`<html` 의 트레일링 부분(예: 청크가 "...<hea" 로 끝남)을 검출 — shim 주입 지점이
 *  청크 경계에서 갈리지 않게 보류할 길이. injected 전에만 의미 있음. */
function tagPrefixHoldLength(buf: string): number {
  const lower = buf.toLowerCase();
  const max = Math.min(5, lower.length);
  for (let L = max; L >= 1; L--) {
    const suf = lower.slice(lower.length - L);
    if ("<head".startsWith(suf) || "<html".startsWith(suf)) return L;
  }
  return 0;
}

/** scheme+authority 최대 길이(`https://127.0.0.1:65535` = 23) 여유분. 부분토큰 보류 상한. */
const MAX_TOKEN_HOLD = 32;

/** buf 끝에서 leftover 로 들고 갈 길이(부분토큰 + (미주입 시) 태그 접두 중 큰 값). */
function holdLength(buf: string, injected: boolean): number {
  let hold = 0;
  const start = Math.max(0, buf.length - MAX_TOKEN_HOLD);
  for (let s = start; s < buf.length; s++) {
    if (isHttpTokenPrefix(buf.slice(s))) {
      hold = buf.length - s;
      break;
    }
  }
  if (!injected) hold = Math.max(hold, tagPrefixHoldLength(buf));
  return hold;
}

/** 스트리밍 중 주입 위치 — `<head>` 여는 태그 «뒤» 만 본다(없으면 -1, 다음 청크에서 재시도).
 *  `<html>` 폴백을 스트리밍에서 쓰지 않는 이유: 청크가 `<html>` 까지만 와 있을 때 거기 끼우면
 *  같은 문서라도 청크 크기에 따라 주입 위치가 달라진다 — `<head>` 가 곧 오므로 기다린다. */
function headOnlyIndex(buf: string): number {
  const head = /<head[^>]*>/i.exec(buf);
  return head ? head.index + head[0].length : -1;
}

/** 스트림 끝(_flush) 폴백 위치 — `<head>` → `<html>` → (둘 다 없으면) -1(맨 앞 prepend). */
function flushInjectIndex(buf: string): number {
  const at = headOnlyIndex(buf);
  if (at >= 0) return at;
  const html = /<html[^>]*>/i.exec(buf);
  return html ? html.index + html[0].length : -1;
}

/**
 * 런타임 WebSocket shim — HTML `<head>` 에 주입. `window.WebSocket` 을 감싸 «등록된 dev 포트»
 * 의 ws(s) loopback URL 을 `ws(s)://<현재 host>/__psport__/PORT/...` 로 바꾼다. 현재 host 를
 * 런타임에 읽으므로 정적 치환이 못 하는 «올바른 절대 ws URL» 을 만든다. 정적·동적 생성 ws 모두 포착.
 * idempotent(__psPatched) — 중복 주입/이중 패치 방지. 리라이트 정규식에 걸릴 «리터럴 토큰» 을
 * 담지 않는다(scheme 은 런타임 조립) — shim 자신이 다시 리라이트되지 않게.
 */
export function buildWsShim(ports: readonly number[]): string {
  const list = JSON.stringify([...ports]);
  // 주의: 아래 문자열에는 `http://localhost:PORT` 같은 «완성 리터럴» 이 없어야 한다(자기 리라이트 방지).
  return (
    `<script>(function(){try{` +
    `var P=${list};var O=window.WebSocket;if(!O||O.__psPatched)return;` +
    `function W(u,p){try{u=String(u).replace(/^(wss?):\\/\\/(localhost|127\\.0\\.0\\.1):(\\d+)/i,` +
    `function(m,s,h,pt){if(P.indexOf(parseInt(pt,10))<0)return m;` +
    `var sc=(location.protocol==='https:')?'wss':'ws';` +
    `return sc+'://'+location.host+'${PREVIEW_PORT_PREFIX}/'+pt;});}catch(e){}` +
    `return (p!==undefined)?new O(u,p):new O(u);}` +
    `W.prototype=O.prototype;W.CONNECTING=O.CONNECTING;W.OPEN=O.OPEN;` +
    `W.CLOSING=O.CLOSING;W.CLOSED=O.CLOSED;W.__psPatched=true;window.WebSocket=W;` +
    `}catch(e){}})();</script>`
  );
}

/** content-type 으로 리라이트 대상 여부 + HTML 여부 판정. */
export function classifyContentType(ct: string | undefined): { rewrite: boolean; html: boolean } {
  if (!ct) return { rewrite: false, html: false };
  const c = ct.toLowerCase();
  const html = c.includes("text/html");
  const js = c.includes("javascript") || c.includes("ecmascript");
  return { rewrite: html || js, html };
}

/** `/__psport__/<port>[/...]` 경로 파싱 → 포트 + 남은 path. 형식 불일치는 null. 순수 함수. */
export function parsePortRoute(pathname: string): { port: number; rest: string } | null {
  if (!pathname.startsWith(PREVIEW_PORT_PREFIX + "/")) return null;
  const after = pathname.slice(PREVIEW_PORT_PREFIX.length + 1);
  const slash = after.indexOf("/");
  const portStr = slash === -1 ? after : after.slice(0, slash);
  const port = Number.parseInt(portStr, 10);
  if (!Number.isInteger(port) || String(port) !== portStr) return null;
  const rest = slash === -1 ? "/" : after.slice(slash);
  return { port, rest };
}

/** rawUrl(쿼리 포함)에서 `/__psport__/<port>` prefix 를 떼고 upstream 으로 보낼 path 를 만든다. */
export function stripPortPrefix(rawUrl: string, port: number): string {
  const cut = PREVIEW_PORT_PREFIX.length + 1 + String(port).length;
  let fwd = rawUrl.slice(cut);
  if (!fwd.startsWith("/")) fwd = "/" + fwd;
  return fwd;
}

export type RewriteOptions = {
  /** 알려진(등록된) dev 포트 — 이 포트들의 절대 URL 만 리라이트. */
  ports: ReadonlySet<number>;
  /** HTML 이면 주입할 shim `<script>` 문자열. JS 응답 등 비-HTML 이면 null. */
  injectScript: string | null;
};

/**
 * 응답 본문을 흘리면서 (1) HTTP(S) loopback 절대 URL 리라이트, (2) (HTML 일 때) `<head>` 에
 * WS shim 1회 주입. 청크 경계 안전 — 부분토큰/부분태그는 leftover 로 이월.
 */
export class PreviewRewriteStream extends Transform {
  private leftover = "";
  private injected: boolean;
  private readonly ports: ReadonlySet<number>;
  private readonly injectScript: string | null;

  constructor(opts: RewriteOptions) {
    super();
    this.ports = opts.ports;
    this.injectScript = opts.injectScript;
    this.injected = opts.injectScript == null; // 주입 대상이 없으면 «이미 끝남» 취급.
  }

  private maybeInject(buf: string): string {
    if (this.injected || this.injectScript == null) return buf;
    const at = headOnlyIndex(buf);
    if (at < 0) return buf;
    this.injected = true;
    return buf.slice(0, at) + this.injectScript + buf.slice(at);
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: (e?: Error | null, d?: Buffer) => void): void {
    let buf = this.leftover + chunk.toString("utf8");
    buf = this.maybeInject(buf);
    const hold = holdLength(buf, this.injected);
    const emit = buf.slice(0, buf.length - hold);
    this.leftover = buf.slice(buf.length - hold);
    cb(null, Buffer.from(rewriteUrls(emit, this.ports), "utf8"));
  }

  override _flush(cb: (e?: Error | null, d?: Buffer) => void): void {
    let buf = this.leftover;
    if (!this.injected && this.injectScript != null) {
      const at = flushInjectIndex(buf);
      buf = at >= 0 ? buf.slice(0, at) + this.injectScript + buf.slice(at) : this.injectScript + buf;
      this.injected = true;
    }
    cb(null, Buffer.from(rewriteUrls(buf, this.ports), "utf8"));
  }
}
