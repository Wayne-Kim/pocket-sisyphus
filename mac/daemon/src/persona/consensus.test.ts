import { describe, expect, it } from "vitest";
import { selectConsensusBriefs, type ConsensusBrief } from "./consensus.js";

/**
 * consensus.selectConsensusBriefs 의 계약 테스트 — 순수·결정적(LLM/DB 무관). 합치 채택의 핵심
 * 불변식: ① 충분한 패스에 반복 등장한 기회만 채택 ② 한 패스만 성공해도 graceful fallback
 * ③ 전부 실패면 빈 산출 ④ 같은 입력 → 같은 채택(결정성). 중복 판정은 similarity 백스톱 재사용.
 */

/** 테스트용 브리프 — evidence 는 ref 추출용 JSON 문자열(없으면 트라이그램 판정으로 폴백). */
function brief(title: string, problem: string, refs: string[] = []): ConsensusBrief {
  const evidence = JSON.stringify(refs.map((ref) => ({ kind: "code", ref, summary: "" })));
  return { title, problem, evidence };
}

// 의미상 «같은 기회» 의 두 표현(조사/어미만 흔들림 — lexical 백스톱이 같은 것으로 본다).
const A1 = brief("로그인 화면 접근성 라벨 추가", "로그인 버튼에 접근성 라벨이 없어 보이스오버가 못 읽는다");
const A2 = brief("로그인 화면 접근성 라벨 추가하기", "로그인 버튼에 접근성 라벨이 없어서 보이스오버가 못 읽는다");
const A3 = brief("로그인 화면 접근성 라벨 달기", "로그인 버튼에 접근성 라벨이 없으니 보이스오버가 못 읽는다");
// 전혀 다른 기회.
const B1 = brief("PDF 내보내기", "리포트를 PDF 로 저장하는 기능이 필요하다");
const C1 = brief("다크 모드 지원", "설정에서 다크 모드를 켤 수 있어야 한다");

describe("selectConsensusBriefs — 합치 채택", () => {
  it("2패스 모두에 등장한 기회만 채택, 한 패스에만 튄 건 탈락 (minAgree=2)", () => {
    const r = selectConsensusBriefs([[A1, B1], [A2, C1]], 2);
    expect(r.adopted).toHaveLength(1);
    expect(r.adopted[0].title).toBe(A1.title); // 가장 이른 패스의 대표
    expect(r.rejected.map((x) => x.brief.title).sort()).toEqual([B1.title, C1.title].sort());
    expect(r.effectiveMinAgree).toBe(2);
  });

  it("3패스 중 2패스 등장(=minAgree)이면 채택, 1패스만이면 탈락", () => {
    const r = selectConsensusBriefs([[A1], [A2], [B1]], 2);
    expect(r.adopted.map((x) => x.title)).toEqual([A1.title]);
    expect(r.rejected.map((x) => ({ t: x.brief.title, n: x.agree }))).toEqual([
      { t: B1.title, n: 1 },
    ]);
  });

  it("같은 패스 안에 같은 기회가 둘이면 합치 수는 1만(패스 단위 집계 — 부풀지 않음)", () => {
    // 한 패스가 같은 기회를 A1·A2 로 쪼개 내놔도 «합의 2» 가 아니라 1. 다른 패스가 없으면 탈락.
    const r = selectConsensusBriefs([[A1, A2], [B1]], 2);
    expect(r.adopted).toHaveLength(0);
    const a = r.rejected.find((x) => x.brief.title === A1.title);
    expect(a?.agree).toBe(1);
  });

  it("graceful fallback — 한 패스만 산출(나머지 빈 배열)이면 그 패스를 그대로 채택", () => {
    const r = selectConsensusBriefs([[A1, B1], [], []], 2);
    expect(r.passesWithOutput).toBe(1);
    expect(r.effectiveMinAgree).toBe(1); // 임계가 산출 있는 패스 수로 캡됨
    expect(r.adopted.map((x) => x.title).sort()).toEqual([A1.title, B1.title].sort());
  });

  it("전부 실패(모든 패스 빈 배열)면 빈 산출", () => {
    const r = selectConsensusBriefs([[], []], 2);
    expect(r.adopted).toHaveLength(0);
    expect(r.passesWithOutput).toBe(0);
    expect(r.effectiveMinAgree).toBe(0);
  });

  it("ref 겹침으로도 같은 기회로 묶인다 (제목/문제 안 닮아도 evidence ref 신호)", () => {
    // 제목·문제는 다르게 썼지만 같은 file:line 을 가리키는 두 패스의 브리프 → 합치 2 → 채택.
    const p1 = brief("크래시 핫스팟", "여기서 자주 죽는다", ["src/app.ts:42"]);
    const p2 = brief("널 역참조 가능", "방어 코드가 없다", ["src/app.ts:43"]);
    const r = selectConsensusBriefs([[p1], [p2]], 2);
    expect(r.adopted).toHaveLength(1);
    expect(r.adopted[0].title).toBe(p1.title);
  });

  it("결정성 — 같은 입력이면 항상 같은 채택/순서", () => {
    const input: ConsensusBrief[][] = [
      [A1, B1, C1],
      [A2, C1],
      [A3, C1],
    ];
    const r1 = selectConsensusBriefs(input, 2);
    const r2 = selectConsensusBriefs(input, 2);
    expect(r1.adopted.map((x) => x.title)).toEqual(r2.adopted.map((x) => x.title));
    // A(3패스)·C(3패스)는 채택, B(1패스)는 탈락. 채택 순서는 클러스터 등장 순(A 먼저).
    expect(r1.adopted.map((x) => x.title)).toEqual([A1.title, C1.title]);
  });

  it("minAgree=1 이면 모든 (산출 있는) 클러스터 채택 — 1패스 등가(회귀 0 경로)", () => {
    const r = selectConsensusBriefs([[A1, B1]], 1);
    expect(r.adopted.map((x) => x.title).sort()).toEqual([A1.title, B1.title].sort());
    expect(r.rejected).toHaveLength(0);
  });

  it("입력이 아예 없으면(패스 0개) 빈 산출 — throw 안 함", () => {
    const r = selectConsensusBriefs([], 2);
    expect(r.adopted).toHaveLength(0);
    expect(r.passesWithOutput).toBe(0);
  });
});
