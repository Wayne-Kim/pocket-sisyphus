// preview/rewrite 의 순수 함수 + 스트리밍 Transform 단위 테스트 — 절대 URL 리라이트, 미등록/외부
// 비변형, 청크 경계 안전, 포트 경로 파싱을 고정한다.
import { describe, it, expect } from "vitest";
import { Readable } from "node:stream";
import {
  rewriteUrls,
  isHttpTokenPrefix,
  parsePortRoute,
  stripPortPrefix,
  classifyContentType,
  buildWsShim,
  PreviewRewriteStream,
  PREVIEW_PORT_PREFIX,
} from "./rewrite.js";

const PORTS = new Set([3000, 3001]);

describe("rewriteUrls", () => {
  it("등록된 loopback 절대 URL(http/https, localhost/127.0.0.1)을 프록시 경로로", () => {
    expect(rewriteUrls("http://localhost:3000/assets/x.js", PORTS)).toBe(`${PREVIEW_PORT_PREFIX}/3000/assets/x.js`);
    expect(rewriteUrls("https://127.0.0.1:3001/api", PORTS)).toBe(`${PREVIEW_PORT_PREFIX}/3001/api`);
    expect(rewriteUrls('fetch("http://localhost:3001/api/users")', PORTS)).toBe(
      `fetch("${PREVIEW_PORT_PREFIX}/3001/api/users")`,
    );
  });

  it("미등록 포트는 건드리지 않는다", () => {
    const s = "http://localhost:9999/x";
    expect(rewriteUrls(s, PORTS)).toBe(s);
  });

  it("외부 도메인은 건드리지 않는다 (동일 호스트 loopback 만 대상)", () => {
    const s = "https://cdn.example.com:3000/lib.js and http://api.foo.dev:3001/x";
    expect(rewriteUrls(s, PORTS)).toBe(s);
  });

  it("ws(s) 는 정적 텍스트에서 손대지 않는다 (런타임 shim 담당)", () => {
    const s = "ws://localhost:3000/hmr wss://127.0.0.1:3001/s";
    expect(rewriteUrls(s, PORTS)).toBe(s);
  });

  it("여러 URL 을 한 번에", () => {
    const s = "a http://localhost:3000/x b http://localhost:3001/y c http://localhost:4444/z";
    expect(rewriteUrls(s, PORTS)).toBe(
      `a ${PREVIEW_PORT_PREFIX}/3000/x b ${PREVIEW_PORT_PREFIX}/3001/y c http://localhost:4444/z`,
    );
  });

  it("포트 숫자 경계 — 3000 등록이 30001 을 잘못 매칭하지 않음", () => {
    expect(rewriteUrls("http://localhost:30001/x", PORTS)).toBe("http://localhost:30001/x");
  });
});

describe("isHttpTokenPrefix", () => {
  it("scheme/host/port 부분토큰을 접두로 인식", () => {
    for (const p of ["h", "ht", "http", "https", "http:", "http://", "http://l", "http://localhost", "http://localhost:", "http://localhost:30", "https://127.0.0.1:300"]) {
      expect(isHttpTokenPrefix(p)).toBe(true);
    }
  });
  it("토큰이 될 수 없는 것은 false", () => {
    for (const p of ["", "x", "xhttp", "ws", "ftp", "http://example", "http://localhostx", "http://localhost:30x"]) {
      expect(isHttpTokenPrefix(p)).toBe(false);
    }
  });
});

describe("parsePortRoute / stripPortPrefix", () => {
  it("`/__psport__/<port>/...` 를 포트 + 남은 path 로", () => {
    expect(parsePortRoute(`${PREVIEW_PORT_PREFIX}/3001/api/users`)).toEqual({ port: 3001, rest: "/api/users" });
    expect(parsePortRoute(`${PREVIEW_PORT_PREFIX}/3001`)).toEqual({ port: 3001, rest: "/" });
  });
  it("형식 불일치는 null", () => {
    expect(parsePortRoute("/api/users")).toBeNull();
    expect(parsePortRoute(`${PREVIEW_PORT_PREFIX}/notaport/x`)).toBeNull();
  });
  it("stripPortPrefix 는 쿼리를 보존", () => {
    expect(stripPortPrefix(`${PREVIEW_PORT_PREFIX}/3001/api?x=1`, 3001)).toBe("/api?x=1");
    expect(stripPortPrefix(`${PREVIEW_PORT_PREFIX}/3001`, 3001)).toBe("/");
    expect(stripPortPrefix(`${PREVIEW_PORT_PREFIX}/3001?x=1`, 3001)).toBe("/?x=1");
  });
});

describe("classifyContentType", () => {
  it("html/js 만 rewrite=true, html 플래그 구분", () => {
    expect(classifyContentType("text/html; charset=utf-8")).toEqual({ rewrite: true, html: true });
    expect(classifyContentType("application/javascript")).toEqual({ rewrite: true, html: false });
    expect(classifyContentType("text/javascript")).toEqual({ rewrite: true, html: false });
    expect(classifyContentType("application/json")).toEqual({ rewrite: false, html: false });
    expect(classifyContentType(undefined)).toEqual({ rewrite: false, html: false });
  });
});

describe("buildWsShim", () => {
  it("리라이트 정규식에 걸릴 «완성 토큰» 리터럴을 담지 않는다 (자기 리라이트 방지)", () => {
    const shim = buildWsShim([3000, 3001]);
    expect(rewriteUrls(shim, PORTS)).toBe(shim);
    expect(shim).toContain("__psPatched");
    expect(shim).toContain("[3000,3001]");
  });
});

/** Transform 에 임의 청크 분할로 흘려 넣고 출력 문자열을 모은다. */
async function runStream(input: string, chunkSize: number, stream: PreviewRewriteStream): Promise<string> {
  const chunks: Buffer[] = [];
  for (let i = 0; i < input.length; i += chunkSize) {
    chunks.push(Buffer.from(input.slice(i, i + chunkSize), "utf8"));
  }
  const src = Readable.from(chunks);
  const out: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    src.pipe(stream);
    stream.on("data", (d: Buffer) => out.push(d));
    stream.on("end", resolve);
    stream.on("error", reject);
  });
  return Buffer.concat(out).toString("utf8");
}

describe("PreviewRewriteStream — 스트리밍 경계 안전", () => {
  it("아무 크기로 잘라도 결과가 동일하다 (토큰이 청크 경계에서 안 깨짐)", async () => {
    const input =
      'PRE http://localhost:3000/assets/app.js MID http://localhost:3001/api/x END http://localhost:9999/skip';
    const expected = rewriteUrls(input, PORTS);
    for (const size of [1, 2, 3, 5, 7, 13, 1000]) {
      const got = await runStream(input, size, new PreviewRewriteStream({ ports: PORTS, injectScript: null }));
      expect(got).toBe(expected);
    }
  });

  it("HTML 이면 <head> 뒤에 shim 을 1회 주입한다 (청크가 잘게 쪼개져도)", async () => {
    const shim = buildWsShim([3000]);
    const input = '<!doctype html><html><head><title>t</title></head><body>x http://localhost:3000/a</body></html>';
    for (const size of [1, 4, 9, 1000]) {
      const got = await runStream(input, size, new PreviewRewriteStream({ ports: new Set([3000]), injectScript: shim }));
      expect(got).toContain(shim);
      // <head> 바로 뒤에 들어갔는지
      expect(got).toContain(`<head>${shim}`);
      // shim 은 정확히 한 번만
      expect(got.split("__psPatched").length - 1).toBe(2); // shim 내부에 __psPatched 가 2회 등장
      // 본문 URL 도 리라이트됨
      expect(got).toContain(`${PREVIEW_PORT_PREFIX}/3000/a`);
    }
  });

  it("injectScript=null 이면 주입 없이 리라이트만", async () => {
    const input = "<html><head></head><body>http://localhost:3000/a</body></html>";
    const got = await runStream(input, 3, new PreviewRewriteStream({ ports: new Set([3000]), injectScript: null }));
    expect(got).not.toContain("__psPatched");
    expect(got).toContain(`${PREVIEW_PORT_PREFIX}/3000/a`);
  });
});
