// PO 다중 패스 «합치 채택» — 여러 독립 생성 패스의 산출을 모아, 의미상 같은 기회로 충분한 수의
// 패스에 반복해 나온 제안만 채택한다(나머지는 «한 패스의 잡음» 으로 보고 탈락).
//
// 배경: 단일 생성은 모델 임의성 때문에 회차마다 제안의 질·점수가 흔들린다 — 어떤 회차엔 좋은
// 제안이, 어떤 회차엔 잡음이 섞인다. 같은 기회를 «독립» 패스 여럿이 반복해 내놓았다면 그건
// 모델이 안정적으로 본 신호라 채택하고, 한 패스에만 튀어나온 건 변동으로 보고 거른다.
//
// 중복(=「같은 기회」) 판정은 새 로직을 만들지 않고 이미 있는 «결정적 유사도 백스톱»
// (similarity.findSimilar — 제목/문제 트라이그램 + evidence ref 겹침 OR)을 그대로 재사용한다.
// 그래서 이 모듈도 LLM 무관·결정적이고 vitest 로 회귀를 고정할 수 있다(같은 입력 → 같은 채택).
//
// graceful fallback: 채택 임계(minAgree)는 «실제로 산출을 낸 패스 수» 로 캡된다. 그래서 한
// 패스만 성공해도(나머지 빈 산출) 그 한 패스의 제안을 그대로 채택하고, 모든 패스가 실패했을
// 때만 빈 산출이 된다. 즉 다중 패스는 «좋을 때 더 좋게» 일 뿐, 단일 패스보다 나빠지지 않는다.

import { DEDUP_SIMILARITY_THRESHOLD, evidenceRefs, findSimilar } from "./similarity.js";

/** 합치 채택이 보는 브리프의 최소 형태 — 제목·문제·evidence(ref 추출용 JSON 문자열). */
export type ConsensusBrief = {
  title: string;
  problem: string;
  /** parseBriefDraft 산출과 동형의 evidence JSON 문자열 (ref 겹침 신호 추출용). */
  evidence: string;
};

/** 합치 채택 결과 — 채택본 + 탈락본(+사유 카운트) + 실제 적용 임계. */
export type ConsensusResult<T> = {
  /** 채택된 대표 브리프 — 각 클러스터의 «가장 이른 패스의 첫» 원소(결정적). */
  adopted: T[];
  /** 탈락한 클러스터 — 대표 브리프와 실제 합치 수(채택 임계 미만). 로그/디버깅용. */
  rejected: Array<{ brief: T; agree: number }>;
  /** 채택에 실제 적용된 임계 — minAgree 를 «산출 있는 패스 수» 로 캡한 값(graceful fallback). */
  effectiveMinAgree: number;
  /** 산출(원소 ≥1)을 낸 패스 수. 0 이면 전부 실패 → adopted 빈 배열. */
  passesWithOutput: number;
};

type Cluster<T> = {
  /** 유사도 비교용 대표 텍스트 — 클러스터를 처음 연 원소의 것. */
  rep: { title: string; problem: string; refs: readonly string[] };
  /** 이 클러스터에 모인 원소들(인코딩 순서 = 패스/원소 순서 보존). */
  members: T[];
  /** 이 클러스터에 «기여한 서로 다른 패스» 인덱스 집합 — 합치 수 = 이 크기. */
  passes: Set<number>;
};

/**
 * 여러 패스의 브리프 목록을 합쳐 «합치 채택» 한다 — 의미상 같은 기회로 minAgree(실효) 개 이상의
 * 서로 다른 패스에 등장한 클러스터만 채택본으로 반환한다.
 *
 * 결정성: passes·원소 순서를 그대로 본다. 클러스터는 처음 등장 순서로 생기고, 채택본도 그 순서·
 * 각 클러스터의 «첫(가장 이른 패스) 원소» 로 고정된다 → 같은 입력이면 항상 같은 채택.
 *
 * 같은 패스 안에서 같은 클러스터에 두 원소가 매칭돼도 합치 수는 1만 더한다(패스 단위 집계) —
 * 한 패스가 같은 기회를 둘로 쪼개 내도 «합의 2» 로 부풀지 않게.
 *
 * @param passes   패스별 검증된 브리프 목록(빈 배열 = 그 패스 실패/무산출).
 * @param minAgree 채택 최소 합치 수(설정값). 산출 있는 패스 수로 캡된다(graceful fallback).
 * @param threshold 같은 기회로 볼 유사도 임계 — 기본은 기존 dedup 백스톱과 동일.
 */
export function selectConsensusBriefs<T extends ConsensusBrief>(
  passes: ReadonlyArray<readonly T[]>,
  minAgree: number,
  threshold: number = DEDUP_SIMILARITY_THRESHOLD,
): ConsensusResult<T> {
  const passesWithOutput = passes.filter((p) => p.length > 0).length;
  // 실효 임계 = 설정 임계를 «산출 있는 패스 수» 로 캡(최소 1). 한 패스만 성공하면 1 → 그 패스의
  // 제안을 그대로 채택(graceful fallback). 전부 실패면 0 → 클러스터 없음 → 빈 채택.
  const effectiveMinAgree = passesWithOutput === 0 ? 0 : Math.min(minAgree, passesWithOutput);

  const clusters: Array<Cluster<T>> = [];
  passes.forEach((briefs, passIdx) => {
    for (const brief of briefs) {
      const refs = evidenceRefs(brief.evidence);
      const dt = { title: brief.title, problem: brief.problem, refs };
      // 기존 클러스터 대표들과 유사도 비교 — findSimilar(트라이그램 + ref 겹침 OR)를 그대로 재사용.
      const corpus = clusters.map((c, i) => ({ ...c.rep, _idx: i }));
      const hit = findSimilar(dt, corpus, threshold);
      if (hit) {
        const cluster = clusters[hit.item._idx];
        cluster.members.push(brief);
        cluster.passes.add(passIdx);
      } else {
        clusters.push({ rep: dt, members: [brief], passes: new Set([passIdx]) });
      }
    }
  });

  const adopted: T[] = [];
  const rejected: Array<{ brief: T; agree: number }> = [];
  for (const c of clusters) {
    const agree = c.passes.size;
    if (effectiveMinAgree > 0 && agree >= effectiveMinAgree) {
      adopted.push(c.members[0]);
    } else {
      rejected.push({ brief: c.members[0], agree });
    }
  }
  return { adopted, rejected, effectiveMinAgree, passesWithOutput };
}
