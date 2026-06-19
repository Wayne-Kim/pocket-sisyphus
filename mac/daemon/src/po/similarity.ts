// PO 브리프 «근사 중복» 판정 — 결정적(LLM 무관) lexical 백스톱.
//
// 배경: 수집/리서치 에이전트는 매 회차 같은 기회를 «다른 제목» 으로 다시 뱉는다 — 그래서
// 제목 «완전일치» dedup(ingestBriefs)은 사실상 발화하지 않았고 의미상 같은 브리프가 백로그에
// 중복으로 쌓였다. 이 모듈은 그 마지막 그물이다: 에이전트의 자가분류(dedup.relation)가 놓친
// 근사 중복을 «제목/문제 텍스트 유사도» 로 결정적으로 잡는다.
//
// 왜 char-trigram Jaccard 인가: 한국어는 조사·어미가 붙어 «단어 집합» 이 회차마다 흔들리고
// (예: "라벨 추가" vs "라벨을 추가함"), 영어와 혼용된다. 문자 3-gram 은 형태소 경계에
// 둔감해 한·영 모두에서 «거의 같은 문장» 을 안정적으로 잡는다. 토큰화/사전/임베딩이 필요 없어
// 결정적이고 vitest 로 회귀를 고정할 수 있다(같은 입력 → 같은 점수).
//
// 보수적 임계값 정책: dedup 의 오탐(진짜 새 기회를 조용히 버림)은 «놓친 중복» 보다 비싸다
// (사용자가 영영 못 본다). 그래서 임계값은 높게(near-identical 만 컷) 두고, 의미는 다르지만
// 표현이 비슷한 케이스는 에이전트 자가분류 쪽에 맡긴다. 컷될 때는 executor 가 로그를 남긴다.

/** 비교용 정규화 — 소문자화 + 글자/숫자만 남기고 나머지(구두점·기호)는 공백으로. */
export function normalizeForDedup(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** 정규화 텍스트(공백 제거)의 문자 3-gram 집합. 3글자 미만이면 그 자체를 1원소로. */
function trigrams(s: string): Set<string> {
  const t = normalizeForDedup(s).replace(/\s+/g, "");
  const grams = new Set<string>();
  if (t.length < 3) {
    if (t) grams.add(t);
    return grams;
  }
  for (let i = 0; i + 3 <= t.length; i++) grams.add(t.slice(i, i + 3));
  return grams;
}

/** 두 집합의 Jaccard 유사도 (교집합/합집합). 둘 다 비면 0. */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const g of a) if (b.has(g)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** 유사도 비교에 필요한 브리프의 최소 텍스트 — 제목 + 문제 정의. */
export type DedupText = { title: string; problem: string };

/**
 * 두 브리프의 0..1 근사-중복 점수. 제목끼리의 유사도와 «제목+문제» 본문 유사도 중 큰 값.
 *
 * 왜 max 인가: 같은 기회라도 ① 제목만 거의 같거나(문제 서술은 길이가 달라 희석) ② 제목은
 * 살짝 바뀌었지만 문제 본문이 거의 같은(긴 텍스트라 신호가 안정적) 두 경우가 다 «중복» 이다.
 * 둘 중 하나라도 높으면 중복으로 본다.
 */
export function briefSimilarity(a: DedupText, b: DedupText): number {
  const titleSim = jaccard(trigrams(a.title), trigrams(b.title));
  const bodySim = jaccard(trigrams(`${a.title} ${a.problem}`), trigrams(`${b.title} ${b.problem}`));
  return Math.max(titleSim, bodySim);
}

/**
 * 근사-중복 판정 임계값 — 이 값 «이상» 이면 같은 기회로 보고 컷한다. 보수적(near-identical
 * 위주)으로 잡아 오탐을 줄인다. 의미는 같지만 표현이 꽤 다른 케이스는 에이전트 자가분류가 맡는다.
 */
export const DEDUP_SIMILARITY_THRESHOLD = 0.55;

/** a 가 corpus 의 «어떤» 항목과 임계값 이상으로 닮았으면 그 항목을 반환(없으면 null). */
export function findSimilar<T extends DedupText>(
  a: DedupText,
  corpus: readonly T[],
  threshold: number = DEDUP_SIMILARITY_THRESHOLD,
): { item: T; score: number } | null {
  let best: { item: T; score: number } | null = null;
  for (const item of corpus) {
    const score = briefSimilarity(a, item);
    if (score >= threshold && (!best || score > best.score)) best = { item, score };
  }
  return best;
}
