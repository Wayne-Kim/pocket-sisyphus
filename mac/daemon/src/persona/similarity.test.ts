import { describe, expect, it } from "vitest";
import {
  briefSimilarity,
  DEDUP_SIMILARITY_THRESHOLD,
  findSimilar,
  normalizeForDedup,
} from "./similarity.js";

describe("normalizeForDedup", () => {
  it("소문자화 + 구두점/기호 제거 + 공백 정규화", () => {
    expect(normalizeForDedup("  Dark   Mode!! ")).toBe("dark mode");
    expect(normalizeForDedup("세션 재실행!")).toBe("세션 재실행");
    // 케이스/구두점만 다른 두 문자열은 같은 정규형으로 수렴한다.
    expect(normalizeForDedup("PDF 내보내기")).toBe(normalizeForDedup("pdf 내보내기."));
  });
});

describe("briefSimilarity", () => {
  it("완전히 같은 제목+문제는 1.0", () => {
    const a = { title: "다크 모드 지원", problem: "설정에서 다크 모드를 켤 수 있어야 한다" };
    expect(briefSimilarity(a, { ...a })).toBeCloseTo(1, 5);
  });

  it("케이스/구두점만 다르면 사실상 1.0 (정규화가 흡수)", () => {
    const a = { title: "PDF 내보내기", problem: "리포트를 PDF 로 저장" };
    const b = { title: "pdf 내보내기!", problem: "리포트를 pdf 로 저장." };
    expect(briefSimilarity(a, b)).toBeCloseTo(1, 5);
  });

  it("조사·어미만 흔들린 근사 중복은 임계값 이상 (lexical 백스톱이 잡는다)", () => {
    const a = {
      title: "로그인 화면 접근성 라벨 추가",
      problem: "로그인 화면의 버튼에 접근성 라벨이 없어 보이스오버 사용자가 쓸 수 없다",
    };
    const b = {
      title: "로그인 화면 접근성 라벨 추가하기",
      problem: "로그인 화면의 버튼에 접근성 라벨이 없어서 보이스오버 사용자가 쓸 수 없다",
    };
    expect(briefSimilarity(a, b)).toBeGreaterThanOrEqual(DEDUP_SIMILARITY_THRESHOLD);
  });

  it("전혀 다른 기회는 낮은 점수 (오탐 방지)", () => {
    const a = { title: "다크 모드 지원", problem: "설정에서 다크 모드를 켤 수 있어야 한다" };
    const b = { title: "PDF 내보내기", problem: "리포트를 PDF 로 저장하는 기능이 필요하다" };
    expect(briefSimilarity(a, b)).toBeLessThan(0.2);
  });

  it("의미는 같아도 표현이 많이 다르면 임계값 미만 — 이건 에이전트 자가분류의 몫(설계 경계)", () => {
    // lexical 만으로는 못 잡는 패러프레이즈. dedup.relation(에이전트)이 1차로 거르고,
    // 이 백스톱은 «거의 같은 텍스트» 만 보수적으로 컷한다.
    const a = { title: "로그인 접근성 라벨 추가", problem: "버튼에 라벨이 없다" };
    const b = { title: "로그인 화면 접근성 개선", problem: "스크린리더 대응이 부족하다" };
    expect(briefSimilarity(a, b)).toBeLessThan(DEDUP_SIMILARITY_THRESHOLD);
  });

  it("빈/짧은 문자열에도 throw 하지 않는다 (엣지)", () => {
    expect(() => briefSimilarity({ title: "", problem: "" }, { title: "", problem: "" })).not.toThrow();
    expect(briefSimilarity({ title: "a", problem: "" }, { title: "b", problem: "" })).toBe(0);
  });
});

describe("findSimilar", () => {
  const corpus = [
    { id: "1", title: "다크 모드 지원", problem: "설정에서 다크 모드를 켤 수 있어야 한다" },
    { id: "2", title: "PDF 내보내기", problem: "리포트를 PDF 로 저장하는 기능" },
  ];

  it("임계값 이상으로 닮은 항목을 찾아 반환한다", () => {
    const hit = findSimilar(
      { title: "다크 모드 지원!", problem: "설정에서 다크 모드를 켤 수 있어야 한다." },
      corpus,
    );
    expect(hit?.item.id).toBe("1");
    expect(hit?.score).toBeGreaterThanOrEqual(DEDUP_SIMILARITY_THRESHOLD);
  });

  it("닮은 항목이 없으면 null", () => {
    expect(findSimilar({ title: "오프라인 동기화", problem: "네트워크 없이 큐잉" }, corpus)).toBeNull();
  });

  it("빈 corpus 면 null", () => {
    expect(findSimilar({ title: "X", problem: "Y" }, [])).toBeNull();
  });

  it("여러 개가 임계값을 넘으면 가장 높은 점수를 고른다", () => {
    const near = [
      { id: "a", title: "다크 모드", problem: "다크 모드 토글" },
      { id: "b", title: "다크 모드 지원", problem: "설정에서 다크 모드를 켤 수 있어야 한다" },
    ];
    const hit = findSimilar(
      { title: "다크 모드 지원", problem: "설정에서 다크 모드를 켤 수 있어야 한다" },
      near,
    );
    expect(hit?.item.id).toBe("b");
  });
});
