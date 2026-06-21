/**
 * `po/readability` 의 가독성 휴리스틱 계약 테스트 — 순수 함수(DB/PTY/HTTP 무관, mock 불필요).
 *
 * 왜 이 테스트가 있나: 브리프 가독성 게이트의 «두 미러»(이 TS = ingest 소프트 경고 측,
 * scripts/po-brief-readability-lint.sh 의 파이썬 = CI/린트 측)는 같은 규칙을 따라야 한다.
 * 이 파일은 TS 측 규칙(R1~R4 + 화이트리스트)을 못박고, 더불어 «프롬프트 선언(80자) ↔ 코드
 * 상수(TITLE_ADVISORY_MAX)» 의 정렬을 고정한다 — 과거엔 선언 80 ↔ executor cap 200 이 말없이
 * 불일치한 채 방치됐다(이 테스트가 그 드리프트를 막는다). 파이썬 미러는 test-po-brief-readability-lint.sh.
 */
import { describe, it, expect } from "vitest";
import {
  analyzeTitleReadability,
  analyzeProblemReadability,
  analyzeBriefReadability,
  titleLength,
  TITLE_ADVISORY_MAX,
} from "./readability.js";
import { collectMessages } from "./i18n/messages.collect.js";

/** 신호 목록에서 code 집합만. */
function codes(sigs: { code: string }[]): string[] {
  return sigs.map((s) => s.code);
}

describe("analyzeTitleReadability — 제목 R1/R2/R3", () => {
  it("R1: 80자 초과 제목만 잡고, 80자 이하는 통과", () => {
    // 정확히 80자면 «초과» 아님(통과), 81자면 R1 (경계).
    const exactly80 = "가".repeat(80);
    const over80 = "가".repeat(81);
    expect(titleLength(exactly80)).toBe(80);
    expect(codes(analyzeTitleReadability(exactly80))).not.toContain("R1");
    expect(codes(analyzeTitleReadability(over80))).toContain("R1");
    // 코드포인트(글자) 기준 — 공백 포함 자연 제목도 80 초과면 R1.
    const long = "아주 긴 제목을 의도적으로 늘여 권고 한계를 분명히 넘기도록 만든 가독성 회귀 표본 제목이며 충분히 더 길게 이어집니다 정말로 길게 길게 더 길게";
    expect(titleLength(long)).toBeGreaterThan(TITLE_ADVISORY_MAX);
    expect(codes(analyzeTitleReadability(long))).toContain("R1");
  });

  it("R2: 파일경로/SCREAMING_SNAKE 심볼은 잡고, 약어·URL·이슈번호는 통과", () => {
    expect(codes(analyzeTitleReadability("lifecycle.ts 정착 단순화"))).toContain("R2");
    expect(codes(analyzeTitleReadability("MAX_BRIEFS_PER_RUN 상한 정리"))).toContain("R2");
    // 밑줄 없는 약어(SSH·API)·URL(안의 .ts)·이슈번호(#42)는 화이트리스트 → R2 아님.
    expect(codes(analyzeTitleReadability("SSH 연결 안정화"))).not.toContain("R2");
    expect(codes(analyzeTitleReadability("릴리스 노트 https://x.com/a.ts 자동화"))).not.toContain("R2");
    expect(codes(analyzeTitleReadability("#42 관련 백로그 정리"))).not.toContain("R2");
  });

  it("R3: «—»(em/en-dash) 2개 이상(절 3개+)은 잡고, 1개(절 2개)는 통과", () => {
    expect(codes(analyzeTitleReadability("정착 — 대기 — 전이"))).toContain("R3");
    expect(codes(analyzeTitleReadability("라벨 추가 — CRUD"))).not.toContain("R3");
    expect(codes(analyzeTitleReadability("라벨 추가 기능"))).not.toContain("R3");
  });

  it("빈/공백 제목은 신호 없음", () => {
    expect(analyzeTitleReadability("")).toEqual([]);
    expect(analyzeTitleReadability("   ")).toEqual([]);
  });
});

describe("analyzeProblemReadability — problem 첫 줄 R4", () => {
  it("R4: 백틱/파일:라인/SCREAMING_SNAKE/점-멤버로 시작하면 잡는다", () => {
    expect(codes(analyzeProblemReadability("`parseBriefDraft` 가 약하다"))).toContain("R4");
    expect(codes(analyzeProblemReadability("executor.ts:537 의 검증이 길이만 본다"))).toContain("R4");
    expect(codes(analyzeProblemReadability("MAX_BRIEFS 상한이 선언과 다르다"))).toContain("R4");
    expect(codes(analyzeProblemReadability("Theme.Spacing.large 토큰을 우회한다"))).toContain("R4");
  });

  it("R4 제외: 평이한 프로즈·URL·이슈번호·고유명(API.x) 시작은 통과", () => {
    expect(codes(analyzeProblemReadability("사용자가 항목을 분류할 방법이 없다"))).not.toContain("R4");
    expect(codes(analyzeProblemReadability("https://github.com/o/r/issues/9 에서 보고됨"))).not.toContain("R4");
    expect(codes(analyzeProblemReadability("#42 에 누적된 요청"))).not.toContain("R4");
    expect(codes(analyzeProblemReadability("API.fetch 가 가끔 실패한다"))).not.toContain("R4");
  });

  it("첫 «비어있지 않은» 줄만 본다 (선행 빈 줄 무시)", () => {
    expect(codes(analyzeProblemReadability("\n\n사용자가 불편하다"))).not.toContain("R4");
    expect(codes(analyzeProblemReadability("\n\n`code` 로 시작"))).toContain("R4");
  });

  it("빈 problem 은 신호 없음", () => {
    expect(analyzeProblemReadability("")).toEqual([]);
  });
});

describe("analyzeBriefReadability — 수용 기준: 빽빽한 표본은 걸리고 평이 제목은 통과", () => {
  it("빽빽한 표본 제목(파일경로 … — … —)은 R2+R3 를 모두 낸다", () => {
    const dense = analyzeBriefReadability({
      title: "messages.collect.ts 보정 — 드리프트 — 빽빽",
      problem: "보정 앵커로 제목이 다시 빽빽해진다",
    });
    expect(codes(dense)).toEqual(expect.arrayContaining(["R2", "R3"]));
  });

  it("평이한 제목 + 평이한 problem 은 신호 0건", () => {
    const plain = analyzeBriefReadability({
      title: "보정 앵커 단순화",
      problem: "보정 지침이 길어 읽기 어렵다",
    });
    expect(plain).toEqual([]);
  });
});

describe("80자 정렬 — 프롬프트 선언 ↔ 코드 상수(드리프트 방지)", () => {
  it("TITLE_ADVISORY_MAX 는 80 (프롬프트 «80자 이내» 선언의 코드측 SSOT)", () => {
    expect(TITLE_ADVISORY_MAX).toBe(80);
  });

  it("collectMessages 의 «모든 로케일» title 스키마가 같은 권고 한계(80)를 선언한다", () => {
    // collectMessages 는 { 메시지키: { 로케일: 템플릿 } } 구조다. title 스키마(«…80자 이내») 를 가진
    // 메시지키를 찾아, 그 키의 10개 로케일이 «전부» 같은 권고 한계를 선언함을 못박는다(자동 추출 ≠ 완역).
    const decls: Array<{ key: string; loc: string; desc: string }> = [];
    for (const [key, val] of Object.entries(collectMessages)) {
      if (!val || typeof val !== "object") continue;
      for (const [loc, tmpl] of Object.entries(val as Record<string, unknown>)) {
        if (typeof tmpl !== "string") continue;
        const m = tmpl.match(/"title":\s*"([^"]+)"/);
        if (m) decls.push({ key, loc, desc: m[1] });
      }
    }
    // title 스키마는 한 메시지키(산출 스키마 본문)에만 있고, 10개 로케일 전부 선언돼 있어야 한다.
    expect(decls.length).toBe(10);
    expect(new Set(decls.map((d) => d.loc)).size).toBe(10);
    for (const d of decls) {
      expect(d.desc, `${d.key}/${d.loc}: 권고 한계 ${TITLE_ADVISORY_MAX} 선언`).toContain(
        String(TITLE_ADVISORY_MAX),
      );
    }
  });
});
