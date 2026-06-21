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

/**
 * evidence JSON(DB 원형 / draft 산출 문자열) → ref 문자열 목록. dedup 백스톱의 ref-겹침 신호 입력.
 * 깨진 JSON·비배열·ref 없는 원소는 안전히 빈 목록/스킵 — 인식 가능한 ref 가 없으면 백스톱이
 * 트라이그램 판정으로 폴백한다(회귀 0). 정규화/겹침 판정은 아래 normalizeRef/refsOverlap 가 맡는다.
 */
export function evidenceRefs(evidenceJson: string): string[] {
  try {
    const parsed = JSON.parse(evidenceJson);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((e) =>
        e && typeof e === "object" ? String((e as Record<string, unknown>).ref ?? "").trim() : "",
      )
      .filter((r) => r.length > 0);
  } catch {
    return [];
  }
}

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

/** 유사도 비교에 필요한 브리프의 최소 텍스트 — 제목 + 문제 정의. (+ 선택: evidence ref 목록.) */
export type DedupText = { title: string; problem: string; refs?: readonly string[] };

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

// ─── evidence ref 겹침 신호 (트라이그램 백스톱의 보강) ───────────────────────────
//
// 배경: 트라이그램은 «제목/문제 텍스트» 만 본다. 그래서 «같은 파일:라인 / 같은 이슈» 를
// 가리키지만 제목·문구를 다르게 쓴 두 브리프(수집 회차가 다르면 흔하다)는 텍스트가 안 닮아
// 그물을 빠져나간다 — evidence 는 스키마상 ref 를 갖는데도 그 신호를 안 썼다. 이 블록이 그
// ref 신호를 더한다: 정규화된 ref 가 «정확 일치»(또는 같은 파일 인접 라인)면 제목 유사도와
// 무관하게 중복 후보로 본다(트라이그램과 OR — findSimilar 에서 둘 중 하나라도 걸리면 컷).
//
// 보수성(위 13–15줄의 «오탐 > 놓친 중복» 정책 유지): «구조를 인식한» ref 만 신호로 쓴다 —
// file:line · issue# · URL. 라인 없는 맨 파일경로·자유 요약·깨진 ref 는 normalizeRef 가 null 로
// 떨궈 트라이그램 판정으로 안전 폴백한다(서로 다른 두 기회가 같은 파일을 막연히 가리켜도
// «인접 라인» 이 아니면 안 묶인다). evidence kind 와 무관 — design_token_drift 등 디자인 렌즈의
// ref=파일:라인도 동일하게 적용된다.

/** 같은 파일에서 «인접» 으로 보는 라인 폭 — 회차 사이 코드가 몇 줄 밀려도 같은 위치로 본다. */
const REF_ADJACENT_LINES = 3;

/** 정규화된 evidence ref — 구조가 분명한 세 종류만(그 외는 normalizeRef 가 null). */
type NormalizedRef =
  | { kind: "file"; path: string; lo: number; hi: number }
  | { kind: "issue"; id: string }
  | { kind: "url"; url: string };

/**
 * evidence ref 한 건 → 비교용 정규형(인식 못 하면 null). 보수적으로 «구조» 가 분명한 것만:
 *  - `http(s)://…`            → url (소문자·꼬리 슬래시/프래그먼트 제거; /issues/N 은 issue 로 승격)
 *  - `path:line[-line]`       → file (path 소문자·구분자 정규화, lo..hi)
 *  - `…#123` (URL/파일 아님)  → issue#123 (#앞이 owner/repo 든 issue 든 무관)
 * 라인 없는 맨 경로·자유 텍스트·빈 문자열은 null → ref 신호에 기여 안 함(트라이그램 폴백).
 */
export function normalizeRef(raw: string): NormalizedRef | null {
  const s = raw.trim();
  if (!s) return null;

  // URL — 단, GitHub 류 `/issues/N` 은 issue 로 정규화해 «#N» 표기와도 겹치게 한다.
  if (/^https?:\/\//i.test(s)) {
    const issue = s.match(/\/issues\/(\d+)/i);
    if (issue) return { kind: "issue", id: issue[1] };
    const url = s
      .toLowerCase()
      .replace(/#.*$/, "")
      .replace(/\/+$/, "");
    return { kind: "url", url };
  }

  // 파일:라인[-라인] — path 부분이 «경로처럼» 보일 때만(. 또는 / 포함). 라인 번호는 필수.
  const file = s.match(/^(.*?):(\d+)(?:\s*-\s*(\d+))?$/);
  if (file && /[./]/.test(file[1])) {
    const path = file[1].trim().toLowerCase().replace(/\\/g, "/").replace(/^\.\//, "");
    const a = Number(file[2]);
    const b = file[3] ? Number(file[3]) : a;
    if (path && Number.isFinite(a) && Number.isFinite(b)) {
      return { kind: "file", path, lo: Math.min(a, b), hi: Math.max(a, b) };
    }
  }

  // 이슈 — #123 / issue#123 / owner/repo#123 (URL·파일 아님). 끝의 #숫자를 쓴다.
  const issue = s.match(/#\s*(\d+)\s*$/);
  if (issue) return { kind: "issue", id: issue[1] };

  return null;
}

/** 두 정규 ref 가 «같은 위치» 인가 — file 은 같은 경로+인접 라인, issue/url 은 정확 일치. */
function refMatch(a: NormalizedRef, b: NormalizedRef): boolean {
  if (a.kind === "file" && b.kind === "file") {
    if (a.path !== b.path) return false;
    // [lo,hi] 두 구간이 겹치거나 인접 폭(REF_ADJACENT_LINES) 이내면 같은 위치로 본다.
    return a.lo <= b.hi + REF_ADJACENT_LINES && b.lo <= a.hi + REF_ADJACENT_LINES;
  }
  if (a.kind === "issue" && b.kind === "issue") return a.id === b.id;
  if (a.kind === "url" && b.kind === "url") return a.url === b.url;
  return false;
}

/**
 * 두 브리프의 evidence ref 목록이 «겹치는가» — 하나라도 같은 위치면 true. 인식 못 한 ref 는
 * normalizeRef 가 빼므로, 어느 쪽이든 인식된 ref 가 없으면 false(→ 호출부가 트라이그램으로 폴백).
 */
export function refsOverlap(a: readonly string[], b: readonly string[]): boolean {
  const na = a.map(normalizeRef).filter((r): r is NormalizedRef => r !== null);
  if (na.length === 0) return false;
  const nb = b.map(normalizeRef).filter((r): r is NormalizedRef => r !== null);
  for (const x of na) for (const y of nb) if (refMatch(x, y)) return true;
  return false;
}

/**
 * a 가 corpus 의 «어떤» 항목과 중복 후보인지 — ① 트라이그램 유사도 ≥ threshold 거나 ② evidence
 * ref 가 겹치면(제목 무관) 히트. 둘은 OR — 한쪽만 걸려도 컷, 둘 다 약하면 통과. 여러 히트면
 * 트라이그램 점수가 가장 높은 것을 고른다(ref-only 히트는 점수가 낮아 lexical 히트에 밀린다).
 * reason 은 «어느 신호로 걸렸나» — executor 가 컷 로그에 남긴다.
 */
export function findSimilar<T extends DedupText>(
  a: DedupText,
  corpus: readonly T[],
  threshold: number = DEDUP_SIMILARITY_THRESHOLD,
): { item: T; score: number; reason: "lexical" | "ref" } | null {
  let best: { item: T; score: number; reason: "lexical" | "ref" } | null = null;
  for (const item of corpus) {
    const score = briefSimilarity(a, item);
    const lexical = score >= threshold;
    // lexical 히트면 ref 비교는 생략(어차피 컷) — reason 도 더 강한 신호인 lexical 로.
    const ref = !lexical && refsOverlap(a.refs ?? [], item.refs ?? []);
    if (!lexical && !ref) continue;
    if (!best || score > best.score) {
      best = { item, score, reason: lexical ? "lexical" : "ref" };
    }
  }
  return best;
}
