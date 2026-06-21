// preview/proxy 의 «순수» 파서 단위 테스트 — 보안 게이트의 입력 파싱 엣지를 고정한다.
// (라우팅/네트워킹은 통합 영역이라 여기선 파싱만; 등록부 검증은 registry.test 에서.)
import { describe, it, expect } from "vitest";
import { parsePreviewCookie, parseEntryPath, PREVIEW_ENTRY_PREFIX } from "./proxy.js";

describe("parsePreviewCookie", () => {
  it("v1 단일 포트 쿠키에서 (sessionId, port) 복원 — ports 는 [port]", () => {
    const sid = "11111111-2222-3333-4444-555555555555";
    const out = parsePreviewCookie(`ps_preview=${encodeURIComponent(`${sid}~3000`)}`);
    expect(out).toEqual({ sessionId: sid, port: 3000, ports: [3000] });
  });

  it("v2 다중 포트 쿠키에서 주포트 + 활성 셋 복원", () => {
    const sid = "11111111-2222-3333-4444-555555555555";
    const out = parsePreviewCookie(`ps_preview=${encodeURIComponent(`${sid}~3000~3000,3001,5173`)}`);
    expect(out).toEqual({ sessionId: sid, port: 3000, ports: [3000, 3001, 5173] });
  });

  it("v2 셋에 주포트가 빠져 있어도 주포트는 항상 활성 셋에 포함", () => {
    const sid = "abc-def";
    const out = parsePreviewCookie(`ps_preview=${encodeURIComponent(`${sid}~3000~3001`)}`);
    expect(out?.port).toBe(3000);
    expect(new Set(out?.ports)).toEqual(new Set([3000, 3001]));
  });

  it("다른 쿠키들 사이에서도 ps_preview 만 골라낸다", () => {
    const sid = "abc-def";
    const out = parsePreviewCookie(`foo=bar; ps_preview=${sid}~5173; baz=qux`);
    expect(out).toEqual({ sessionId: sid, port: 5173, ports: [5173] });
  });

  it("쿠키 없음/형식 불일치는 null", () => {
    expect(parsePreviewCookie(undefined)).toBeNull();
    expect(parsePreviewCookie("foo=bar")).toBeNull();
    expect(parsePreviewCookie("ps_preview=noport")).toBeNull();
    expect(parsePreviewCookie("ps_preview=~3000")).toBeNull();
  });
});

describe("parseEntryPath", () => {
  it("진입 경로에서 (sessionId, port) 파싱", () => {
    const sid = "11111111-2222-3333-4444-555555555555";
    expect(parseEntryPath(`${PREVIEW_ENTRY_PREFIX}/${sid}/3000`)).toEqual({
      sessionId: sid,
      port: 3000,
    });
    // 뒤에 subpath 가 붙어도 sid/port 만 쓴다.
    expect(parseEntryPath(`${PREVIEW_ENTRY_PREFIX}/${sid}/3000/foo/bar`)).toEqual({
      sessionId: sid,
      port: 3000,
    });
  });

  it("prefix 불일치/세그먼트 부족은 null", () => {
    expect(parseEntryPath("/")).toBeNull();
    expect(parseEntryPath("/assets/app.js")).toBeNull();
    expect(parseEntryPath(`${PREVIEW_ENTRY_PREFIX}/onlysid`)).toBeNull();
    expect(parseEntryPath(`${PREVIEW_ENTRY_PREFIX}/sid/notaport`)).toBeNull();
  });
});
