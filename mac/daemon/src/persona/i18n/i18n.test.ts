import { describe, expect, it } from "vitest";
import { PO_LOCALES, format } from "./locale.js";
import { MESSAGES } from "./messages.js";
import { t } from "./t.js";

describe("PO i18n 카탈로그 — 완전성 (정적 카탈로그의 «번역 누락» 함정 방지)", () => {
  it("모든 메시지가 10개 locale 을 «빠짐없이» 채운다 (ko 만 고치고 번역 누락 방지)", () => {
    const missing: string[] = [];
    for (const [id, entry] of Object.entries(MESSAGES)) {
      for (const loc of PO_LOCALES) {
        const v = (entry as Record<string, string>)[loc];
        if (typeof v !== "string" || v.length === 0) missing.push(`${id}[${loc}]`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("ko 값은 비어 있지 않다 — t() 의 폴백 소스", () => {
    for (const [id, entry] of Object.entries(MESSAGES)) {
      expect((entry as Record<string, string>).ko, id).toBeTruthy();
    }
  });
});

describe("format — {{name}} 보간 (JSON 단일 중괄호와 구분)", () => {
  it("이중 중괄호 식별자만 치환하고, 단일 중괄호 JSON 예시는 보존한다", () => {
    expect(format("경로: {{path}}", { path: "/tmp/x.json" })).toBe("경로: /tmp/x.json");
    // JSON 스키마 예시의 단일 중괄호는 건드리지 않는다.
    expect(format('스키마 { "title": "x" } 와 {{n}}건', { n: 3 })).toBe(
      '스키마 { "title": "x" } 와 3건',
    );
    // params 에 없는 키는 원형 유지 (부분 포맷 안전).
    expect(format("{{a}} / {{b}}", { a: "A" })).toBe("A / {{b}}");
    // params 없으면 템플릿 그대로.
    expect(format("그대로 {{x}}")).toBe("그대로 {{x}}");
  });
});

describe("t — locale 선택 + ko 폴백", () => {
  it("요청 locale 값을 돌려주고, 빈 값이면 ko 로 폴백한다", () => {
    expect(t("status.proposed", "en")).toBe("Proposed");
    expect(t("status.proposed", "ko")).toBe("제안");
    expect(t("status.rejected", "ja")).toBe("却下");
  });
});
