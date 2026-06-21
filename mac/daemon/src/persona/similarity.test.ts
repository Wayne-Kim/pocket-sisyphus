import { describe, expect, it } from "vitest";
import {
  briefSimilarity,
  DEDUP_SIMILARITY_THRESHOLD,
  findSimilar,
  normalizeForDedup,
  normalizeRef,
  refsOverlap,
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

  it("트라이그램으로 걸린 히트의 reason 은 'lexical'", () => {
    const hit = findSimilar(
      { title: "다크 모드 지원!", problem: "설정에서 다크 모드를 켤 수 있어야 한다." },
      corpus,
    );
    expect(hit?.reason).toBe("lexical");
  });
});

describe("normalizeRef", () => {
  it("file:line / range 를 같은 경로+라인 구간으로 정규화(경로 소문자·구분자 정규화)", () => {
    expect(normalizeRef("executor.ts:507")).toEqual({
      kind: "file",
      path: "executor.ts",
      lo: 507,
      hi: 507,
    });
    expect(normalizeRef("src/Foo.ts:10-20")).toEqual({
      kind: "file",
      path: "src/foo.ts",
      lo: 10,
      hi: 20,
    });
    // 역순 범위·역슬래시·선행 ./ 도 정규화.
    expect(normalizeRef("./a\\b.ts:20-10")).toEqual({ kind: "file", path: "a/b.ts", lo: 10, hi: 20 });
  });

  it("issue #N / issue#N / owner/repo#N / issues URL 은 issue#N 으로 수렴", () => {
    expect(normalizeRef("#123")).toEqual({ kind: "issue", id: "123" });
    expect(normalizeRef("issue#123")).toEqual({ kind: "issue", id: "123" });
    expect(normalizeRef("owner/repo#123")).toEqual({ kind: "issue", id: "123" });
    expect(normalizeRef("https://github.com/o/r/issues/123")).toEqual({ kind: "issue", id: "123" });
  });

  it("URL 은 소문자화·꼬리 슬래시/프래그먼트 제거", () => {
    expect(normalizeRef("https://Example.com/Docs/")).toEqual({
      kind: "url",
      url: "https://example.com/docs",
    });
    expect(normalizeRef("https://example.com/a#frag")).toEqual({
      kind: "url",
      url: "https://example.com/a",
    });
  });

  it("라인 없는 맨 경로·자유 텍스트·빈 문자열은 null (트라이그램 폴백)", () => {
    expect(normalizeRef("docs/todo.md")).toBeNull(); // 라인 없는 파일경로 → 너무 거칠어 신호 제외
    expect(normalizeRef("라벨 요청 누적")).toBeNull(); // 자유 요약성 ref
    expect(normalizeRef("r")).toBeNull();
    expect(normalizeRef("   ")).toBeNull();
  });
});

describe("refsOverlap", () => {
  it("같은 file:line 은 겹침", () => {
    expect(refsOverlap(["executor.ts:507"], ["executor.ts:507"])).toBe(true);
  });

  it("같은 파일 인접 라인(±폭 이내)은 겹침, 멀리 떨어지면 안 겹침", () => {
    expect(refsOverlap(["a.ts:100"], ["a.ts:102"])).toBe(true); // 인접 (코드가 몇 줄 밀림)
    expect(refsOverlap(["a.ts:100-110"], ["a.ts:108"])).toBe(true); // 범위가 겹침
    expect(refsOverlap(["a.ts:100"], ["a.ts:500"])).toBe(false); // 같은 파일 다른 위치 = 다른 기회
  });

  it("다른 파일은 안 겹침", () => {
    expect(refsOverlap(["a.ts:10"], ["b.ts:10"])).toBe(false);
  });

  it("같은 이슈/URL 은 겹침 (#N ↔ issues URL 포함)", () => {
    expect(refsOverlap(["#42"], ["https://github.com/o/r/issues/42"])).toBe(true);
    expect(refsOverlap(["https://x.io/a"], ["https://x.io/a/"])).toBe(true);
  });

  it("인식 못 한 ref(맨 경로/자유 텍스트)만 있거나 한쪽이 비면 안 겹침 → 폴백", () => {
    expect(refsOverlap(["docs/todo.md"], ["docs/todo.md"])).toBe(false); // 둘 다 null → 폴백
    expect(refsOverlap([], ["a.ts:1"])).toBe(false);
    expect(refsOverlap(["a.ts:1"], [])).toBe(false);
  });
});

describe("findSimilar — evidence ref 겹침 신호 (트라이그램과 OR)", () => {
  // 결정적 회귀 고정 — 같은 입력 같은 결과.
  const corpus = [
    { id: "1", title: "다크 모드 지원", problem: "야간에 화면이 너무 밝다", refs: ["ui/theme.ts:42"] },
  ];

  it("같은 ref·다른 제목 = 중복 (트라이그램 미달이어도 ref 로 컷, reason='ref')", () => {
    const hit = findSimilar(
      { title: "어두운 테마 옵션", problem: "밤에 눈이 부셔서 쓰기 힘들다", refs: ["ui/theme.ts:43"] },
      corpus,
    );
    expect(hit?.item.id).toBe("1");
    expect(hit?.reason).toBe("ref");
    // 제목·문제는 실제로 트라이그램 임계값 미만임을 함께 고정(ref 단독으로 걸린 것).
    expect(briefSimilarity(corpus[0], { title: "어두운 테마 옵션", problem: "밤에 눈이 부셔서 쓰기 힘들다" })).toBeLessThan(
      DEDUP_SIMILARITY_THRESHOLD,
    );
  });

  it("다른 ref·비슷한 제목 = 기존 트라이그램 경로 (reason='lexical')", () => {
    const hit = findSimilar(
      { title: "다크 모드 지원!", problem: "야간에 화면이 너무 밝다.", refs: ["other/x.ts:99"] },
      corpus,
    );
    expect(hit?.item.id).toBe("1");
    expect(hit?.reason).toBe("lexical");
  });

  it("ref 없음 = 폴백 (트라이그램만; 안 닮으면 통과)", () => {
    expect(
      findSimilar({ title: "오프라인 동기화", problem: "지하철에서 끊기면 작업이 사라진다" }, corpus),
    ).toBeNull();
  });

  it("다른 ref·다른 제목 = 통과 (둘 다 약함)", () => {
    expect(
      findSimilar(
        { title: "전혀 다른 기회", problem: "관련 없는 문제 정의", refs: ["zzz/q.ts:1"] },
        corpus,
      ),
    ).toBeNull();
  });

  it("인식 못 한 ref(맨 경로)는 ref 신호로 안 걸린다 — 제목도 다르면 통과", () => {
    expect(
      findSimilar(
        { title: "전혀 다른 기회", problem: "관련 없는 문제 정의", refs: ["ui/theme.ts"] }, // 라인 없음
        corpus,
      ),
    ).toBeNull();
  });
});
