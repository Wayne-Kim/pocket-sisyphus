// PO 루프 — 수집 에이전트 프롬프트 빌더.
//
// 약한 고리 배경: AI 개발 루프에서 코딩은 분 단위인데 «무엇을 만들지»(신호 수집·종합·스펙)는
// 사람이 생각날 때만 하는 일이라 일~주 단위로 멈춘다. 이 프롬프트는 그 1~5단계(신호 수집 →
// 종합 → 우선순위 초안 → 스펙 초안)를 에이전트 세션 한 번으로 수행시키고, 사람은 iOS 백로그
// 탭에서 «승인/보류/기각» 결정만 한다.
//
// 산출 계약: 에이전트가 `outFile` 에 JSON 배열을 쓴다. po/executor 가 세션 settle 후 파싱해
// po_briefs 테이블에 넣는다. 브리프는 반드시 근거(evidence)로 역추적 가능해야 한다 — 사람이
// 폰에서 30초 안에 승인 판단을 하려면 근거가 한 화면에 있어야 하기 때문.

import {
  DESIGN_LENS_FOCUS,
  collectLensHeadmatter,
  researchLensHeadmatter,
  type PoLens,
} from "./lens.js";

/** 한 브리프의 JSON 계약 — iOS PoBrief / po_briefs 테이블과 1:1. */
export type PoBriefDraft = {
  title: string;
  problem: string;
  evidence: Array<{ kind: string; ref: string; summary: string }>;
  impact: number; // 1~5
  effort: number; // 1~5
  scope: string;
  spec: string;
  /**
   * 에이전트 «자가 중복 분류» (선택) — 산출 직전 기존·과거 백로그와 대조한 결과. ingest 의
   * 하이브리드 dedup 게이트가 이걸 1차 신호로 쓴다(2차는 lexical 백스톱). 없으면 "new" 로 본다.
   * - "new"        : 기존과 무관한 새 기회.
   * - "refinement" : 기존 항목을 의미 있게 «확장» 하는 별개 작업 (ofTitle 명시). 삽입은 허용.
   * - "duplicate"  : 기존/과거(기각·출시 포함)와 «같은 기회» — 게이트가 컷한다.
   */
  dedup?: { relation?: "new" | "refinement" | "duplicate"; ofTitle?: string };
};

/**
 * 수집/리서치 프롬프트에 dedup 앵커로 박는 «기존·과거 백로그» 한 건. 라이프사이클 status 까지
 * 함께 줘서 — 살아있는 제안뿐 아니라 이미 «기각/출시» 된 닫힌 결정도 재제안 대상에서 뺀다
 * (제목만 주던 옛 방식은 의미 중복·닫힌 결정 재제안을 못 막았다). problem 은 호출부가 1줄로 자른다.
 */
export type PoExistingBrief = {
  title: string;
  problem: string;
  status: string;
};

/** 기존·과거 백로그 한 줄의 status 라벨 — 닫힌 결정(기각/출시 등)을 사람이 읽기 쉽게. */
const BRIEF_STATUS_LABEL: Record<string, string> = {
  proposed: "제안",
  held: "보류",
  approved: "승인",
  running: "진행",
  rejected: "기각",
  shipped: "출시",
  verified: "검증",
  missed: "빗나감",
};

/** 백로그 한 줄 렌더 — `- [상태] 제목 — 문제(1줄)`. */
function renderBriefLine(b: PoExistingBrief): string {
  const label = BRIEF_STATUS_LABEL[b.status] ?? b.status;
  const problem = b.problem.replace(/\s+/g, " ").trim().slice(0, 80);
  return problem ? `- [${label}] ${b.title} — ${problem}` : `- [${label}] ${b.title}`;
}

/** 백로그 목록을 프롬프트 줄로 렌더. 0건이면 "(없음)". */
function renderBriefLines(briefs: PoExistingBrief[]): string {
  if (briefs.length === 0) return "(없음)";
  return briefs.map(renderBriefLine).join("\n");
}

/** 닫힌 결정/살아있는 제안 — «재제안 금지» 묶음의 헤더 (세 빌더 공통). */
const FORBIDDEN_BACKLOG_HEADER =
  "기존·과거 백로그 (아래와 «같은 기회» 는 — 제목 재서술·기각·출시 포함 — 재제안 금지):";

/** «빗나감(missed)» — 닫힌 결정이 아니라 «미해결 갭/재시도 후보» 임을 알리는 헤더 + 안내. */
const MISSED_RETRY_HEADER =
  "출시됐으나 «빗나간» 기회 (재시도 후보 — 닫힌 결정 아님, 미해결 갭):";
const MISSED_RETRY_INSTRUCTION =
  "- **빗나감(missed) 재시도 규칙**: 위 항목들은 출시됐으나 «가설이 빗나가» 문제(갭)가 그대로 남았다. 닫힌 결정이 아니므로 «미해결 갭을 다른 접근» 으로 다루는 새 브리프는 «허용» 된다. 단 — ① «같은 가설/같은 접근» 의 단순 재제안이면 빼라(접근이 «달라야» 한다 — 같은 시도를 반복하지 마라). ② 같은 주제로 이미 «살아있는» 제안(제안/보류/승인/진행)이 위 백로그에 있으면 그쪽이 우선이니 새로 만들지 마라.";

/**
 * 세 빌더(수집·디자이너·리서치)에 공통으로 박는 백로그 dedup 앵커. status 로 두 묶음으로 나눈다 —
 * (1) 닫힌 결정/살아있는 제안(rejected/shipped/verified + proposed/held/approved/running) = «재제안 금지»,
 * (2) missed = «재시도 후보». missed 는 의미상 «미해결» 인데 옛 방식은 닫힌 결정과 똑같이 «영구 제외»
 * 시켜 베팅이 빗나간 미해결 갭이 백로그에 다시 못 올라오는 모순이 있었다 — 그래서 별도 분기로 안내한다.
 */
function renderBacklogAnchor(briefs: PoExistingBrief[]): string {
  const forbidden = briefs.filter((b) => b.status !== "missed");
  const missed = briefs.filter((b) => b.status === "missed");
  let block = `${FORBIDDEN_BACKLOG_HEADER}\n${renderBriefLines(forbidden)}`;
  if (missed.length > 0) {
    block += `\n\n${MISSED_RETRY_HEADER}\n${renderBriefLines(missed)}\n${MISSED_RETRY_INSTRUCTION}`;
  }
  return block;
}

/**
 * dedup 자가분류 산출 계약 — 세 빌더(수집·디자이너·리서치)의 스키마/지시에 공통으로 박는다.
 * 에이전트가 «산출 전» 기존·과거 백로그와 대조하게 강제해 의미 중복을 입구에서 거른다.
 */
const DEDUP_INSTRUCTION = `- **중복 금지 (의미 기준, 엄수)**: 아래 «기존·과거 백로그» 와 «같은 기회» 면 — 제목 표현이 달라도, 이미 «기각»·«출시» 된 것이라도 — 절대 다시 제안하지 마라. 산출하는 각 브리프엔 \`dedup\` 을 채워 스스로 대조하라: 기존을 의미 있게 «확장» 하는 별개 작업이면 \`{"relation":"refinement","ofTitle":"<겹치는 기존 제목>"}\`, 기존과 무관한 새 기회면 \`{"relation":"new"}\`. 같은 기회라고 판단되면 \`dedup\` 으로 표시하지 말고 «애초에 산출 배열에서 빼라».`;

/** 산출 스키마 JSON 에 덧붙는 dedup 필드 한 줄 (스키마 본문 끝에 콤마로 이어 붙인다). */
const DEDUP_SCHEMA_FIELD = `  "dedup": { "relation": "new|refinement", "ofTitle": "겹치는 기존 제목(refinement 일 때) 또는 빈 문자열" }`;

/**
 * 점수 보정용 «과거 결정 이력» 한 건 (po_briefs 의 결정/검증된 행 한 줄 요약).
 *
 * status 의미: rejected = 사람이 기각, approved = 사람이 승인(아직 검증 전),
 * verified = 출시 후 가설 적중, missed = 출시됐으나 가설 빗나감.
 * note 는 검증 근거(verify_note) 한 줄 — 기각/승인 행이나 옛 레코드엔 없을 수 있다(엣지).
 */
export type PoDecisionRecord = {
  title: string;
  impact: number; // 1~5
  effort: number; // 1~5
  status: "rejected" | "approved" | "verified" | "missed";
  note?: string | null;
};

/** 결정 이력 한 줄의 «결정/결과» 라벨 — 프롬프트가 사람 평가를 읽기 쉽게. */
const DECISION_LABEL: Record<PoDecisionRecord["status"], string> = {
  rejected: "기각",
  approved: "승인",
  verified: "검증됨",
  missed: "빗나감",
};

/**
 * PO 산출 «언어» — collect/research/revise 가 만드는 «사람이 읽는» 산출(리서치 보고서 본문,
 * 브리프의 title·problem·scope·spec·evidence summary)을 «사용자 앱 언어» 로 쓰게 하는 i18n 축.
 *
 * 배경: 프롬프트의 «지시 본문» 은 한국어다(제품 언어·세션 transcript 와 일치). 그래서 비-한국어
 * 사용자가 백로그를 쓰면 에이전트가 한국어로 산출하고 iOS 가 그걸 그대로 그려 결과가 안 읽혔다.
 * iOS 가 «실제 표시 중인» 앱 언어(Bundle.main.preferredLocalizations.first)를 요청에 실어 보내면
 * 빌더가 프롬프트 끝에 «산출을 그 언어로 써라» 한 줄을 덧붙인다 — «지시 본문» 은 한국어 유지,
 * 산출(사람이 읽는 값)만 앱 언어로 (이 브리프 범위).
 *
 * 지원 집합은 이 레포가 «선언한» 10개(iOS/Mac Localizable.xcstrings 와 동일). 소스 언어는 ko —
 * locale 이 ko / 누락(옛 클라이언트) / 미지원이면 지시를 «붙이지 않아» 기존 한국어 산출과
 * byte-identical 하게 graceful fallback 한다(회귀 0). 키는 정규화된 canonical 표기, 값은 에이전트가
 * 헷갈리지 않게 endonym + 영어 이름을 함께 적는다.
 */
const PO_OUTPUT_LANGUAGE: Record<string, string> = {
  ar: "العربية (Arabic)",
  en: "English",
  es: "Español (Spanish)",
  fr: "Français (French)",
  hi: "हिन्दी (Hindi)",
  ja: "日本語 (Japanese)",
  "pt-BR": "Português do Brasil (Brazilian Portuguese)",
  ru: "Русский (Russian)",
  "zh-Hans": "简体中文 (Simplified Chinese)",
  // ko 는 의도적으로 제외 — 소스 언어라 지시 없이 기존 산출과 동일(no-op).
};

/**
 * 들어온 locale 문자열을 이 레포의 지원 집합 canonical 표기로 정규화한다 (네트워크 경계 방어 —
 * iOS 가 이미 표시 언어를 정규화해 보내지만 daemon 도 그대로 믿지 않고 한 번 더 거른다). 매칭
 * 실패는 undefined → 빌더가 산출 언어 지시를 안 붙여 한국어 산출로 폴백. parseLens/parseAgent
 * 와 같은 «경계에서 화이트리스트 검증» 패턴.
 */
export function normalizePoLocale(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const s = raw.trim();
  if (!s) return undefined;
  const supported = [...Object.keys(PO_OUTPUT_LANGUAGE), "ko"];
  // 정확 매치 (canonical 표기, 대소문자 무시 — "PT-br" → "pt-BR").
  const exact = supported.find((c) => c.toLowerCase() === s.toLowerCase());
  if (exact) return exact;
  // 지역/스크립트 꼬리표 폴백 — "en-US" → en, "pt"/"pt-PT" → pt-BR, "zh"/"zh-Hans-CN" → zh-Hans.
  const base = (s.split(/[-_]/)[0] ?? "").toLowerCase();
  if (["ar", "en", "es", "fr", "hi", "ja", "ko", "ru"].includes(base)) return base;
  if (base === "pt") return "pt-BR";
  if (base === "zh") {
    // 번체(zh-Hant/TW/HK/MO)는 지원 집합에 없다 → undefined(한국어 폴백). 그 외 zh 는 간체로.
    return /hant|tw|hk|mo/.test(s.toLowerCase()) ? undefined : "zh-Hans";
  }
  return undefined;
}

/**
 * 산출 언어 지시 블록 — locale 이 지원 집합의 «비-ko» 면 «사람이 읽는 산출을 그 언어로 써라» 를
 * 만들어 프롬프트 «끝» 에 덧붙인다. ko/누락/미지원이면 빈 문자열 → 프롬프트가 기존과
 * byte-identical (회귀 0, graceful fallback). 앞의 «지시 본문» 은 한국어 유지.
 */
function localeOutputDirective(locale?: string): string {
  const lang = PO_OUTPUT_LANGUAGE[normalizePoLocale(locale) ?? ""];
  if (!lang) return "";
  return `

## 산출 언어 (사용자 앱 언어 — 필수)
사용자의 앱 표시 언어는 «${lang}» 다. 위에서 산출하는 «사람이 읽는» 텍스트 — 리서치 보고서 본문, 그리고 각 브리프의 title·problem·scope·spec 과 evidence 의 summary — 를 반드시 ${lang} 로 작성하라. 사용자 입력(주제·지시)이 다른 언어여도 이해는 하되, 산출은 ${lang} 로 쓴다. JSON 키·enum 값(kind·relation 등)·파일 경로·식별자·코드/명령·URL 은 번역하지 말고 그대로 둔다.`;
}

/**
 * «디자인 제약» 섹션 — 수집·리서치·워크플로우 설계 프롬프트 공통.
 *
 * 왜: PO 가 만드는 spec 은 코드/문서/웹 신호만 보고 «색 의미·i18n·상호작용 상태·접근성» 을
 * 모른 채 구현 노드로 넘어간다. 그래서 에이전트가 패턴을 제각각 발명(16px vs 24px)하고 색
 * 정책을 어긴다(예: 강조색과 경고색 혼동). 이 섹션이 그 공백을 메운다 — 디자인 시스템을
 * «구조화 컨텍스트» 로 프롬프트에 먹인다.
 *
 * 핵심 설계 원칙 — «레포-무관»: 어떤 프로젝트의 색 정책도 코드에 하드코딩하지 않는다. 이 PO
 * 루프는 repo_path 로 키된 다중 레포 대상이라(po_profiles), 특정 팔레트·로케일 수를 박으면
 * 다른 레포(웹/React, 다른 팔레트·로케일, SwiftUI 아님)에 «틀린 정책» 을 강요하게 된다. 그래서
 * 컨텍스트는 언제나 «현재 레포가 정한 디자인 SSOT» 에서 나오게 한다:
 *   - `designDirective` 가 있으면 — 레포가 po_profiles 에 «선언» 한 약속이다. 그대로 박는다(최강 신호).
 *   - 없으면 «자동 발견» — 에이전트가 레포에서 디자인 SSOT 를 스택-중립적으로 탐색해 따르게 한다.
 *
 * 왜 프롬프트에 «직접» 박나: claude_code 외 에이전트(agy/codex/local_llm/opencode)엔 그 레포의
 * CLAUDE.md/AGENTS.md 가 자동 로드되지 않는다 — 「발견해서 따르라」는 지시 자체가 프롬프트에
 * 들어 있어야 레포·에이전트 무관하게 동작한다.
 */
export function buildDesignContext(opts: {
  /**
   * 레포가 po_profiles 에 «선언» 한 디자인 컨텍스트 (선택, design_directive). 있으면 그 텍스트를
   * 그대로 박는다 — 레포가 자기 약속을 직접 명시한 가장 강한 신호다. 없으면 자동 발견으로 폴백.
   */
  designDirective?: string;
}): string {
  const declared = opts.designDirective?.trim();
  // 선언이 있으면 그대로, 없으면 스택-중립 «자동 발견» 지시. 어느 쪽도 특정 hue/로케일 수를
  // 박지 않는다 — 정책은 «이 레포» 에서 나온다.
  const source = declared
    ? `이 레포가 «선언» 한 디자인 약속이다 — 아래를 그대로 따르고, 색·상태·로케일·접근성의 «의미» 를 혼동하지 마라:

${declared}`
    : `이 레포가 «정한» 디자인 SSOT 를 먼저 «스스로 찾아 읽고» 따르라 — 특정 색이나 특정 로케일 수를 미리 가정하지 마라(레포마다 팔레트·약속·지원 언어가 다르다). 후보 위치를 스택-중립적으로 탐색하라(있는 것만):
- **디자인 토큰/테마**: \`*Tokens*\`, \`theme.*\`, \`tokens.json\`, \`tailwind.config.*\`, CSS custom properties(\`--*\`), \`*.css\`/\`*.scss\` 변수 — 색·간격·타이포의 «의미 약속» 과 명명 규칙.
- **디자인 문서**: \`CLAUDE.md\`/\`AGENTS.md\` 의 디자인·색 섹션, \`DESIGN*.md\`, \`docs/design*\`, Storybook(\`*.stories.*\`) — 어떤 hue/토큰이 어떤 «의미» 인지와 «하지 마라» 규칙.
- **로케일 카탈로그**: \`*.xcstrings\`, \`*.strings\`, \`messages/*.json\`, \`i18n/\`, \`locales/\`, \`*.po\` — 이 레포가 «지원하는 언어 집합» 을 추론한다(개수·구성은 레포마다 다르다).

찾았으면 그 약속을 따르라: 색은 «의미» 로 쓰고 의미를 혼동·겸용하지 마라, 노출 문자열은 지원 로케일 «집합 전부» 에 번역, 빈/오류/로딩/비활성/포커스 상태와 접근성(라벨·대비)을 갖춘다. 못 찾으면 보편 UX 기준만 적용하라(상호작용 상태·접근성·대비) — 정책을 «발명» 하지 마라.`;

  return `## 디자인 제약(준수 필수)
${source}

- 이 제약은 «UI 가 닿는» 브리프에만 적용된다 — daemon·네트워크·CLI·스키마처럼 UI 표면이 없는 일에는 디자인 기준을 강요하지 마라.
- UI 가 닿는 브리프라면 위에서 «선언/발견» 된 «이 레포의» 약속을 산출(spec/노드 prompt)의 수용 기준에 반영하라.`;
}

/**
 * «디자이너 리뷰» 노드 prompt — 구현된 UI 를 «실제로 렌더→스크린샷→비평» 해 디자인 회귀를
 * 증거로 만든다 (po_design_review_v1).
 *
 * 배경: buildDesignContext 는 디자인 SSOT 를 «텍스트» 로 구현 노드에 먹이지만, 색 의미 혼동
 * (예: 경고색↔프리미엄색)·대비 부족·간격/노드색 깨짐처럼 «렌더돼야 보이는» 회귀는 텍스트
 * 검수로 못 잡는다 — 연구가 일관되게 가리키는 갭이다. 이 노드가 그 빈 절반을 메운다: 변경
 * 화면을 이 레포의 «기존» 캡처 수단으로 렌더·캡처하고, 스크린샷을 디자인 SSOT 대비 vision
 * 비평해 findings(스크린샷 + 위반 토큰 + 정규화 좌표)를 만든다.
 *
 * 게이트를 «대체» 하지 않는다 — 사람이 폰에서 30초 결재할 때 보는 «입력 evidence» 를 게이트
 * 직전 노드로서 «공급» 할 뿐이다 (Task 폴더가 게이트의 부모 폴더로 흘러간다). 회귀를 자동
 * 차단(fail 루프)하지도 않는다 — 판정/수정은 사람 몫.
 *
 * 레포-무관: 특정 스택(iOS/시뮬레이터)·팔레트를 박지 않는다 — 캡처 수단도 SSOT 도 «이 레포» 에서
 * 발견하게 한다 (buildDesignContext 와 동형). 비결정성 완화: 같은 스크린샷을 ≥2회 독립 비평해
 * 2회 이상 일치한 것만 «확정» 보고한다 (연구상 단일 LLM 디자인 휴리스틱은 ~95%, 100% 아님).
 */
export function buildDesignerReviewPrompt(opts: {
  /** 검토 대상 브리프 제목 — 어떤 변경을 보는지 맥락. */
  briefTitle: string;
  /** 디자인 컨텍스트 «선언» (선택, po_profiles.design_directive) — 비면 자동 발견. */
  designDirective?: string;
}): string {
  return `너는 이 저장소의 «디자이너» 에이전트다. 앞 단계가 구현한 UI 변경(«${opts.briefTitle}»)을 «실제로 렌더해 스크린샷으로 보고» 이 레포의 디자인 SSOT 대비 비평하는 것이 임무다. 코드를 고치거나 커밋하지 마라 — 이 노드의 산출은 «사람 승인 게이트가 30초 결재 전에 보는 증거(findings)» 다 (게이트를 대체하지 않는다).

${buildDesignContext({ designDirective: opts.designDirective })}

## 0단계 — 이 변경이 «렌더되는 UI 표면» 에 닿는가
이전 단계 결과 폴더와 변경 파일(\`git diff --name-only\` 등)을 보고 판단하라. daemon·네트워크·CLI·스키마·문서처럼 화면에 그려지는 표면이 없으면 — 빌드/스크린샷 없이 result.md 에 «UI 표면 없음 — 디자인 리뷰 생략» 한 줄을 남기고 끝내라 (이 경우는 통과다). UI 가 닿을 때만 아래를 수행한다.

## 1단계 — 변경 화면 렌더 + 스크린샷 (이 레포의 «기존» 수단으로)
이 레포가 이미 가진 렌더/캡처 수단을 스스로 찾아 써라 — 새 수단을 발명하지 마라(레포마다 스택·캡처 방법이 다르다). \`.claude/\`·CLAUDE.md·AGENTS.md·\`scripts/\`·README 를 읽어 이 레포가 «화면을 렌더해 스크린샷으로 남기는» 방법을 찾는다(있는 것만): UI 검증/스크린샷 스크립트(시뮬레이터·에뮬레이터·앱 캡처 — 보통 마지막 줄에 스크린샷 경로를 출력), 컴포넌트 카탈로그(Storybook 류 \`*.stories.*\`), 웹이면 dev 서버 + 헤드리스 브라우저 스크린샷. 변경이 닿는 화면(들)을 그 수단으로 렌더해 스크린샷을 «이 노드의 결과 폴더에» 저장하라 — 그래야 게이트로 함께 흘러간다. 이 노드는 이미지를 읽을 수 있는 에이전트로 돈다: 스크린샷 파일을 직접 열어 «눈으로» 본다.

## 2단계 — 디자인 SSOT 대비 비평 (스크린샷을 «눈으로»)
각 스크린샷을 직접 열어 위 「디자인 제약」 의 SSOT(선언 directive 또는 발견한 토큰/카탈로그) 대비 비평하라. 최소 점검:
- **색의 «의미»**: 상태색·강조색·프리미엄색을 혼동·겸용했는가 (이 레포가 정한 약속 기준 — 특정 hue 를 미리 가정하지 말고 «이 레포의 의미» 로 판정).
- **대비**: 텍스트·아이콘이 배경 대비 읽히는가 (약시/저조도).
- **간격·정렬**: 토큰화된 간격/정렬과 어긋나는가 (제각각 발명한 마진/패딩).
- **종류색 정책**: 노드/요소 종류색이 정책대로인가.
- 화면에 보이면 빈/오류/로딩/비활성/포커스 상태와 접근성(라벨)도 본다.

## 3단계 — 비결정성 완화 (2회 일치 투표)
각 스크린샷을 «독립적으로 최소 2회» 비평하라 (단일 LLM 디자인 판정은 연구상 ~95%, 100% 아님). 2회 이상에서 «같이» 잡힌 위반만 «확정(confirmed)» 으로 보고하고, 1회만 잡힌 것은 «저신뢰(1회 관측)» 로 따로 표시하라 — 사람이 결재 때 가중치를 둘 수 있게.

## 산출 — findings
result.md 에 사람이 폰에서 30초에 훑을 수 있게 써라. 각 finding 마다 «무엇이 / 어디서» 를 단다:
- **무엇**: 위반 한 줄 + 관련 토큰명(어떤 의미 토큰을 어떤 의미로 잘못 썼는지) + 기대값.
- **어디서**: 스크린샷 파일명 + 정규화 좌표 \`x=<0..1>, y=<0..1>, w=<0..1>, h=<0..1>\` (중심+크기, 좌상단 원점 — 이 레포 화면 마크업과 같은 규약). 좌표를 못 특정하면 화면상 요소명으로.
- **신뢰도**: confirmed(2회+) / low(1회).
회귀가 하나도 없으면 «디자인 회귀 없음» 과 무엇을 점검했는지(화면·토큰)를 남겨라. 스크린샷 파일은 result.md 와 같은 폴더에 둬 게이트로 함께 흘려보내라.

다시 강조: 코드를 고치거나 커밋하지 마라 — 이 노드는 «증거 수집» 전용이다.`;
}

/**
 * «디자인 부트스트랩» 프롬프트 (po_design_bootstrap_v1) — 디자이너 에이전트가 이 레포의 디자인
 * SSOT 를 스캔해 `design_directive` 마크다운 «초안» 을 만든다.
 *
 * 왜: design_directive 가 NULL 이면 「디자인 제약」 섹션이 매 수집/리서치/워크플로우마다 «자동
 * 발견»(약한 신호 — 에이전트가 매번 새로 탐색하고 패턴을 발명할 여지)으로 떨어진다. 주석 스스로
 * «선언된 directive 가 가장 강한 신호» 라고 적지만, 그 선언을 손으로 쓰라는 건 채택 장벽이라
 * 대부분 NULL 로 방치된다. 이 프롬프트가 그 첫 선언을 «에이전트가 대신 초안 작성» 하게 해 장벽을
 * 없앤다 — 사람은 검토·승인 한 번만 한다(승인 전엔 절대 적용 안 됨, 이건 초안 산출일 뿐).
 *
 * 산출: outFile 에 markdown «한 덩어리» (JSON 아님). executor 가 읽어 trim/cap 후 초안 컬럼에
 * 둔다. 「디자인 제약」 의 «선언» 가지가 이 텍스트를 그대로 박으므로, 그 자리에서 읽혔을 때
 * 자족적이게 쓴다. 레포-무관 — 특정 팔레트/로케일 수를 가정하지 말고 «이 레포가 정한 것» 만 적는다.
 */
export function buildPoDesignBootstrapPrompt(opts: {
  repoPath: string;
  outFile: string;
}): string {
  return `너는 이 저장소의 디자인 시스템을 «읽어내는» 에이전트다. 임무는 이 레포가 «이미 정해 둔» 디자인 약속을 발견해 \`design_directive\` 마크다운 «초안» 으로 정리하는 것이다. 코드를 수정하지 마라 — 읽기/조사만 한다. 디자인 시스템을 새로 «설계» 하지 마라(없는 규칙을 발명 금지) — 레포에 실제로 있는 약속만 옮겨 적는다.

이 초안은 곧장 적용되지 않는다 — 사람이 설정 화면에서 검토·승인해야 비로소 PO 프롬프트의 「디자인 제약」 에 «선언된 강신호» 로 쓰인다. 그러니 사람이 30초 안에 «맞다/고치자» 판단할 수 있게, 근거 있고 간결하게 써라.

## 1단계 — 디자인 SSOT 발견 (있는 것만, 스택-중립적으로)
특정 색·특정 로케일 수를 미리 가정하지 마라(레포마다 팔레트·약속·지원 언어가 다르다). 아래 후보 위치를 탐색하라:
- **디자인 토큰/테마**: \`*Tokens*\`, \`theme.*\`, \`tokens.json\`, \`tailwind.config.*\`, CSS custom properties(\`--*\`), \`*.css\`/\`*.scss\` 변수 — 색·간격·타이포의 «의미 약속» 과 명명 규칙. (예: \`DesignTokens.swift\`·\`tokens.json\`·\`tailwind.config.js\`)
- **디자인 문서**: \`CLAUDE.md\`/\`AGENTS.md\` 의 디자인·색 섹션, \`DESIGN*.md\`, \`docs/design*\`, \`README\` 의 디자인 규칙, Storybook(\`*.stories.*\`) — 어떤 hue/토큰이 어떤 «의미» 인지와 «하지 마라» 규칙.
- **로케일 카탈로그**: \`*.xcstrings\`, \`*.strings\`, \`messages/*.json\`, \`i18n/\`, \`locales/\`, \`*.po\` — 이 레포가 «지원하는 언어 집합» 을 추론한다(개수·구성은 레포마다 다르다).

먼저 \`grep\`/\`ls\` 로 후보를 훑고, 가장 권위 있어 보이는 «단일 출처»(SSOT)부터 정독하라. 디자인 문서의 «정책 주석» 이 토큰 파일보다 의도를 더 잘 설명하면 그쪽을 우선한다.

## 2단계 — directive 초안 작성
다음 절들을 «발견한 것만» 채운 markdown 을 써라 (없는 절은 빼라 — 빈 약속을 지어내지 마라):
- **색의 의미**: 각 색/토큰이 «무슨 의미» 인지 (예: 강조·성공·경고·위험·정보·프리미엄 등 — 이름은 레포가 쓰는 그대로). 한 색이 두 의미를 겸하지 않게 «혼동 금지» 쌍을 명시하라(레포 문서가 그렇게 적었다면).
- **간격·크기·타이포**: 레포가 정한 간격 스케일·모서리·폰트 약속 (토큰/문서에 있으면).
- **지원 로케일**: 이 레포가 지원하는 언어 «집합» (카탈로그에서 추론한 코드 목록). 노출 문자열은 이 집합 전부에 번역돼야 한다는 규칙.
- **상태·접근성**: 빈/오류/로딩/비활성/포커스 상태와 접근성(라벨·대비) 규칙 (문서에 있으면 그대로, 없으면 보편 기준 한 줄).
- **하지 마라(금지 패턴)**: 레포 문서가 명시한 안티패턴 (예: 하드코딩 색 금지, 특정 색을 장식에 쓰지 말 것 등). 레포에 근거가 있는 것만.

작성 원칙:
- **레포 근거 기반** — 각 규칙은 실제로 읽은 토큰/문서에서 나와야 한다. 출처 파일을 본문에 가볍게 인용해도 좋다(예: "DesignTokens.swift 의 색상 정책 주석 기준").
- **간결** — 이 텍스트는 앞으로 모든 PO 프롬프트에 박히므로 비대하면 안 된다. 핵심만, 대략 2500자 이내. 불릿 중심.
- **레포-무관** — 다른 레포의 팔레트/규칙을 끌어오지 마라. «이 레포» 가 정한 것만.
- 발견된 SSOT 가 거의 없으면 그 사실을 한 줄로 적고(«토큰/문서를 못 찾음 — 보편 UX 기준만»), 색 의미를 지어내지 말고 보편 접근성/상호작용 상태 기준만 담아라.

## 3단계 — 산출
위 markdown 을 다음 경로에 «그대로» 써라 (JSON 아님, 다른 곳에 쓰지 마라):
${opts.outFile}

파일을 쓴 뒤 «디자인 directive 초안 작성 완료» 한 줄로 끝내라.`;
}

export function buildPoCollectPrompt(opts: {
  repoPath: string;
  outFile: string;
  /**
   * 기존·과거 백로그 (중복 제안 방지의 dedup 앵커) — 살아있는 제안(proposed/held/approved/
   * running)뿐 아니라 닫힌 결정(rejected/shipped/…)도 포함해, 제목 표현이 달라도·이미 기각/출시
   * 됐어도 «같은 기회» 재제안을 막는다. 제목만 주던 옛 방식의 의미-중복 누수를 메운다.
   */
  existingBriefs: PoExistingBrief[];
  /**
   * 사용자의 «대략적 지시» (선택) — 무엇에 집중해 브리프를 만들지. 비면 레포 신호만으로
   * 전방위 제안. 지시 자체도 정당한 신호(이해관계자 입력)라 evidence 로 인정된다.
   */
  instruction?: string;
  /**
   * 프로젝트별 «조사 방식» 프로필 (선택, po_profiles) — 이 레포의 표준 조사 지침.
   * 매 수집에 재사용되는 자산. 회차별 instruction 이 이보다 우선한다.
   */
  profileDirective?: string;
  /**
   * 출시 후 검증 대상 (선택) — shipped 상태 브리프들. 이 수집 사이클이 «가설(problem)이
   * 해소됐는지» 를 신호로 대조해 verdictFile 에 판정을 쓴다 (§3.5 출시 후 검증 루프).
   */
  shippedBriefs?: Array<{ id: string; title: string; problem: string }>;
  /** 검증 판정 산출 파일 — shippedBriefs 가 있을 때만 의미. */
  verdictFile?: string;
  /**
   * 스토어 리뷰 신호 (선택) — ASC 에서 가져온 최근 App Store 고객 리뷰. executor 가
   * fetch 해 임시 JSON 파일로 두고 경로만 프롬프트에 넣는다. fetch 실패/0건이면 생략
   * — 섹션이 없을 뿐 수집 자체는 그대로 진행된다.
   */
  storeReviews?: { file: string; count: number };
  /**
   * 크래시 신호 (선택) — ASC Analytics «App Crashes» 보고서의 버전·디바이스별 집계.
   * storeReviews 와 같은 정책: executor 가 fetch 해 임시 JSON 으로 두고 경로만 넣는다.
   * fetch 실패/데이터 없음이면 생략 — 섹션이 없을 뿐 수집은 그대로 진행된다.
   */
  crashSignals?: { file: string; totalCrashes: number; from: string; to: string };
  /**
   * «과거 결정 이력» (선택, po_briefs 의 결정/검증된 행) — 점수·제안 방향을 사람의 누적
   * 평가에 맞춰 보정하는 컨텍스트. 이 레포 행만(다른 레포가 새 제안을 오염시키지 않게),
   * 최근 N건, 건당 1줄로 호출부가 미리 잘라 넘긴다. 0건/생략이면 섹션 자체를 빼 기존
   * 동작과 동일하다(회귀 없음).
   */
  decisionHistory?: PoDecisionRecord[];
  /**
   * GitHub «피드백 repo» 오버라이드 (선택, po_profiles.github_feedback_repo, owner/name).
   * 이 레포의 origin 은 개발용 private repo 라 사용자가 글을 안 쓴다 — 실제 피드백(이슈·
   * Discussions)은 별도 공개 repo 에 모인다. 설정되면 GitHub 신호 분기가 로컬 origin 대신
   * 이 repo 를 `gh -R <repo>` 로 읽는다. 비면 현행대로 로컬 origin. 코드/TODO/git/문서 신호는
   * 설정 여부와 무관하게 항상 로컬 repoPath 기준 (피드백 repo 는 이슈·Discussions 에만 영향).
   */
  githubFeedbackRepo?: string;
  /**
   * 디자인 컨텍스트 «선언» (선택, po_profiles.design_directive) — 레포가 자기 색/상태/로케일/
   * 접근성 약속을 직접 명시한 텍스트. 있으면 「디자인 제약」 섹션에 그대로 박힌다. 없으면 그
   * 섹션이 «자동 발견»(레포의 디자인 SSOT 를 스스로 찾아 따르라)으로 폴백한다 — githubFeedbackRepo
   * 와 동형의 «프로젝트별 주입». 특정 팔레트/로케일 수를 하드코딩하지 않는다(레포-무관).
   */
  designDirective?: string;
  /**
   * 수집 «전문가 관점» 렌즈 (선택, po_collect_lens_v1). 생략/"default" 면 기존 전방위 수집(코드·이슈·
   * 리뷰·크래시 신호 → 기회 브리프)과 byte-identical (회귀 0). "design" 이면 디자인이 다른 기능의
   * «제약» 으로만 따라붙던 것을 «1급 주제» 로 올려, UI 표면을 위 「디자인 제약」 이 선언/발견한 디자인
   * SSOT 대비로 스캔해 토큰 드리프트·접근성·대비·패턴 불일치를 «디자인 부채» 브리프로 발굴한다 (옛
   * "designer" 페르소나와 «같은» 동작 — designer→design 동치). "bug" 면 일반 수집 경로에 «디버깅·
   * 신뢰성» 머리말을 주입해 크래시·실패 로그·재현 버그·회귀를 우선 신호로 모은다 (lens.ts SSOT —
   * 리서치의 같은 렌즈와 의미 일치). 산출 스키마/저장소는 모든 렌즈에서 동일 — 같은 백로그에 나란히
   * 들어간다. 픽커는 default/design/bug 만 노출하므로 qa/security 는 머리말 없는 일반 수집으로 폴백한다.
   */
  lens?: PoLens;
  /**
   * 산출 언어 (선택, po_locale_v1) — iOS 가 실은 «앱 표시 언어». 지원 집합의 비-ko 면 «브리프
   * title·problem·scope·spec·evidence summary 를 그 언어로 써라» 지시가 프롬프트 끝에 붙는다.
   * ko/누락(옛 클라이언트)/미지원이면 지시가 없어 기존 한국어 산출과 byte-identical (회귀 0).
   */
  locale?: string;
}): string {
  const backlog = renderBacklogAnchor(opts.existingBriefs);

  // 프로젝트 프로필 — 이 레포의 «표준 조사 방식». 신호 소스/관점/제외 영역을 여기에 맞춘다.
  const profile = opts.profileDirective?.trim()
    ? `
## 조사 방식 (프로젝트 프로필 — 매 수집 공통)
${opts.profileDirective.trim()}

- 1단계의 신호 수집 범위/방법과 2단계의 브리프 관점을 이 지침에 맞춰라.
- 아래 «사용자 지시(이번 회차)» 가 있으면 그것이 이 프로필보다 우선한다.
`
    : "";

  // 사용자 지시가 있으면 최우선 — 전방위 스캔 대신 지시를 중심으로 종합한다.
  const directive = opts.instruction?.trim()
    ? `
## 사용자 지시 (이번 회차 — 최우선)
${opts.instruction.trim()}

- 브리프는 이 지시를 «중심으로» 만들어라. 지시와 무관한 전방위 제안은 줄인다.
- 지시 자체가 정당한 신호다(이해관계자 입력). 레포에서 뒷받침 근거를 찾아 붙이되, 없어도
  evidence 에 { "kind": "user_directive", "ref": "사용자 지시", "summary": "<지시 요지 한 줄>" }
  을 넣어 브리프를 만들어라 — 지시받은 아이디어를 근거 부족으로 버리지 마라.
- 지시가 구체적 기능 하나면 그것을 1건의 충실한 브리프로, 방향성이면 그 방향의 후보 여러 건으로.
`
    : "";

  // 출시 후 검증 — shipped 브리프의 가설(problem)이 해소됐는지 같은 수집 파이프가 대조한다.
  // PO 루프가 자기 제안의 성적표를 만드는 구조 (§3.5) — 판정은 별도 verdict 파일로 산출.
  const verification =
    opts.shippedBriefs && opts.shippedBriefs.length > 0 && opts.verdictFile
      ? `
## 출시 후 검증 (브리프 작성과 별개로 반드시 수행)
아래는 이미 구현이 끝나 «출시됨(shipped)» 상태인 과거 브리프들이다. 각각의 가설(problem 이 말하는 불편)이 실제로 해소됐는지 1단계에서 모은 신호로 대조하라:
${opts.shippedBriefs
  .map((b) => `- id: ${b.id}\n  title: ${b.title}\n  가설(problem): ${b.problem.slice(0, 500)}`)
  .join("\n")}

판정 기준:
- "verified" = 가설이 해소된 근거가 보인다 (관련 이슈 닫힘, 해당 기능 커밋/문서 존재, 같은 불만 신호가 더 안 보임).
- "missed" = 구현됐는데도 같은 불만/신호가 계속 보이거나, 구현이 가설과 다른 문제를 풀었다.
- 근거가 불충분해 판단할 수 없으면 그 브리프는 판정 목록에서 «빼라» — 다음 사이클이 다시 본다. 추측 판정 금지.

판정을 다음 경로에 JSON «배열» 로 써라 (판정 없으면 빈 배열):
${opts.verdictFile}

각 원소: { "id": "<위의 id 그대로>", "verdict": "verified" | "missed", "note": "판정 근거 한 줄 (확인 가능한 참조 포함)" }
`
      : "";

  // 스토어 리뷰 신호 — 출시된 앱의 «진짜 사용자 불만/요청». 켠 레포 + fetch 성공 시에만.
  const storeReviews = opts.storeReviews
    ? `
## 스토어 리뷰 신호 (App Store)
이 레포 앱의 최근 App Store 고객 리뷰 ${opts.storeReviews.count}건이 아래 JSON 파일에 있다 (각 원소: id·rating·title·body·territory·createdDate):
${opts.storeReviews.file}
- 1단계 신호 수집에서 이 파일을 반드시 읽어 사용자 불만/요청을 신호로 포함하라. 리뷰가 다국어면 요지를 요약/번역해 다뤄라.
- 리뷰에서 비롯한 근거는 { "kind": "asc_review", "ref": "<리뷰 id> ★<별점> <territory>", "summary": "<리뷰가 말하는 것 한 줄>" } 형식으로 evidence 에 넣어라.
- 같은 불만이 여러 리뷰에 반복되면 그만큼 impact 를 높게 봐라 — 반복 횟수를 problem 에 적어라.
`
    : "";

  // 크래시 신호 — 사용자가 리뷰로 말해주기 «전» 의 가장 빠르고 객관적인 불만. 켠 레포 +
  // 보고서 데이터가 실제로 있을 때만. 안정성 문제가 기능 제안에 밀리지 않게 명시 지시한다.
  const crashSignals = opts.crashSignals
    ? `
## 크래시 신호 (App Store — 출시 앱 안정성)
이 레포 앱의 최근 크래시 집계(${opts.crashSignals.from} ~ ${opts.crashSignals.to}, 총 ${opts.crashSignals.totalCrashes}건, ASC Analytics «App Crashes» 보고서)가 아래 JSON 파일에 있다 (from·to·totalCrashes·groups[]: appVersion·device·platformVersion·crashes·uniqueDevices):
${opts.crashSignals.file}
- 1단계 신호 수집에서 이 파일을 반드시 읽어라. 크래시는 사용자가 리뷰로 말하기 «전» 의 가장 빠른 불만 신호다 — 집계가 큰 그룹은 그 자체로 기회 브리프 후보이며, «앱이 죽는 문제» 는 기능 제안보다 우선한다.
- 크래시에서 비롯한 근거는 { "kind": "crash", "ref": "<appVersion> <device> <from>..<to>", "summary": "<크래시 규모/경향 한 줄>" } 형식으로 evidence 에 넣어라.
- 특정 버전·디바이스에 크래시가 몰려 있으면 impact 를 높게 봐라 — 건수와 집중 패턴을 problem 에 적어라. 최근 커밋/리뷰와 교차해 원인 가설이 보이면 spec 에 담아라.
`
    : "";

  // 과거 결정 요약 — 점수와 제안 방향을 «사람의 누적 평가» 에 맞춰 보정한다(점수 보정).
  // impact/effort 를 매 회차 감으로 매기면 과거 승인/기각·출시 후 검증과 무관해져 점수가
  // 신뢰를 못 얻는다 — 그러면 30초 결재가 무너진다. 이력 0건이면 섹션을 통째로 빼서 기존
  // 동작과 동일(회귀 없음). 건당 1줄·호출부가 N건으로 잘라 넘기므로 프롬프트가 비대해지지 않는다.
  const history =
    opts.decisionHistory && opts.decisionHistory.length > 0
      ? `
## 과거 결정 요약 (이 레포의 누적 성적표 — 점수·방향 보정)
아래는 사람이 이미 결정했거나 출시 후 검증된 과거 브리프다. 각 줄: [결정/결과] impact/effort · 제목 (· 근거). 새 제안의 점수와 방향을 이 누적 평가에 맞춰 보정하라:
${opts.decisionHistory
  .map((d) => {
    const note = d.note?.trim() ? ` · ${d.note.trim().slice(0, 140)}` : "";
    return `- [${DECISION_LABEL[d.status]}] I${d.impact}/E${d.effort} · ${d.title}${note}`;
  })
  .join("\n")}

보정 지침:
- «기각» 된 것과 비슷한 종류는 제안하지 마라. 그래도 제안할 이유가 있으면 problem 에 «과거 기각과 무엇이 다른지» 를 한 줄로 밝혀라.
- «검증됨» 으로 성공한 종류는 더 적극적으로 제안하고, 점수(impact)를 과거 사람 평가에 맞춰 후하게 봐라.
- «빗나감» 은 승인됐지만 가설이 빗나간 종류다 — 같은 실수를 반복하지 말고 비슷한 제안은 신중히 점수 매겨라.
- 새 제안의 impact/effort 는 위 «유사 건» 에 사람이 매긴 점수 수준에 맞춘다 — 감으로 매기지 마라.
- 단, 위 «사용자 지시(이번 회차)» 가 과거 패턴과 충돌하면 이번 회차 지시가 우선이다.
`
      : "";

  // GitHub 신호 분기 — 피드백 repo 가 설정되면 로컬 origin 대신 그 repo 를 `gh -R` 로 읽는다.
  // 비면 현행 그대로 (로컬 origin 을 gh 의 기본 대상으로). 코드·TODO·git·문서 신호는 어느
  // 경우든 로컬 repoPath 기준 — 피드백 repo 는 이슈·Discussions 출처만 바꾼다. -R 한 곳만 읽으니
  // origin 과 같아도 중복 읽기가 없다.
  // 디자인 제약 — 레포가 정한 디자인 SSOT 를 발견/선언받아 spec 이 색 의미·i18n·상태·접근성을
  // 알고 태어나게 한다. 레포-무관(특정 팔레트/로케일 수 비-하드코딩). 항상 들어간다 — UI 무관
  // 브리프는 섹션 «안» 의 「UI 가 닿으면」 게이트가 거른다.
  const designContext = `\n${buildDesignContext({ designDirective: opts.designDirective })}\n`;

  const fbRepo = opts.githubFeedbackRepo?.trim();
  const githubSignal = fbRepo
    ? `- GitHub 신호 (피드백 repo: ${fbRepo}): 사용자 피드백(질문·버그·아이디어·Show&Tell)은 이 개발 레포의 origin 이 아니라 공개 피드백 repo \`${fbRepo}\` 에 모인다 — \`gh\` CLI 로 «그 repo» 를 읽어라(로컬 origin 이 아니다): 열린 이슈(\`gh issue list -R ${fbRepo} --limit 30 --json number,title,body,labels,comments\`), Discussions(\`gh api repos/${fbRepo}/discussions\` 또는 GraphQL), 최근 닫힌 이슈의 미해결 후속(\`gh issue list -R ${fbRepo} --state closed --limit 20 ...\`). 코드·TODO·git·문서 신호는 아래 항목대로 «로컬 레포» 기준이다.`
    : `- GitHub 신호: \`gh\` CLI 가 있고 이 레포가 GitHub 원격이면 — 열린 이슈(\`gh issue list --limit 30 --json number,title,body,labels,comments\`), 최근 discussions, 최근 닫힌 이슈의 미해결 후속.`;

  // 디자인 렌즈 (po_collect_lens_v1 — 옛 designer 페르소나와 «같은» 동작, designer→design 동치) —
  // 디자인을 다른 일의 «제약» 이 아니라 «1급 주제» 로 삼아, UI 표면을 위 「디자인 제약」 의 SSOT
  // 대비로 스캔해 디자인 부채를 발굴한다. 산출 스키마/저장소·근거 역추적·중복 방지·점수 보정·출시
  // 후 검증은 기본 수집과 «동일» — 다른 것은 무엇을 신호로 보고(코드 기능 vs UI 디자인) 어떻게
  // 종합하느냐(기회 vs 부채)뿐이다. 기본("default"/생략)은 아래 전방위 수집과 byte-identical (회귀 없음).
  if (opts.lens === "design") {
    // 디자인 부채 evidence kind — 위반 «종류» 를 분류한다(ref=파일:라인, summary=위반 토큰/패턴명).
    // ingest 는 kind 를 자유 문자열로 받으므로(스키마 동일) 프롬프트에서만 정의한다.
    const designKinds = `design_token_drift|design_color_misuse|design_a11y|design_contrast|design_pattern|design_i18n|code_comment${opts.storeReviews ? "|asc_review" : ""}`;
    return `너는 이 저장소 프로덕트 오너(PO)의 «디자이너» 페르소나다. 다른 기능의 «제약» 으로만 따라붙던 디자인을 이번엔 «1급 주제» 로 삼아, 이 레포의 UI 표면을 디자인 SSOT 대비로 스캔해 «디자인 부채» 를 기회 브리프로 발굴하는 것이 임무다. 코드를 수정하지 마라 — 읽기/조사만 한다.

이건 «구현 후 검수» 가 아니라 «구현 전 발굴(discovery)» 다 — 이미 만들어진 화면에서 디자인 일관성·접근성·대비·토큰 드리프트·패턴 불일치를 찾아, 코드 기능 백로그와 «나란히» 우선순위 브리프로 올린다. (구현 워크플로우의 «디자인 리뷰 게이트 노드» 나 브리프 카드의 «디자인 수용 기준 블록» 과 역할이 겹치지 않는다 — 그건 만들어진 변경을 검수/수용하는 자리고, 여긴 무엇을 고칠지 «찾는» 자리다.)
${profile}${directive}${history}${verification}${storeReviews}${crashSignals}${designContext}
## 1단계 — UI 표면 스캔 (design SSOT 대비, 가능한 것만)
위 「디자인 제약」 이 «선언/발견» 한 이 레포의 디자인 SSOT 가 «측정 기준자» 다. 초점은 ${DESIGN_LENS_FOCUS} 다 (리서치의 «디자인» 렌즈와 같은 관점). 그 기준 대비 UI 표면을 스캔하라 (스택·팔레트·토큰 명명은 레포가 정한다 — 특정 프레임워크/색을 가정하지 마라):
- **UI 표면 모으기**: 뷰/컴포넌트 파일을 찾는다 (예: \`*View*\`/SwiftUI \`View\`, React/Vue/Svelte 컴포넌트, \`*.css\`/\`*.scss\`/styled-components 등 — 이 레포에 실제로 있는 것). \`grep -rn\` 으로 의심 패턴을 폭넓게 훑어라.
- **토큰 드리프트**: 의미 토큰(SSOT 가 정한 색·간격·타이포 약속)을 우회한 리터럴·하드코딩 값. 예) 의미 토큰 대신 리터럴 색(\`.orange\`/\`.yellow\`/\`.blue\`), 하드코딩 흑백(\`.white\`/\`.black\`), 전역 틴트(\`.tint\`) 남용, 매직 넘버 간격 — 위반 토큰/패턴명은 «이 레포 SSOT 의 명명» 을 따른다.
- **색 의미 혼동·겸용**: 한 색을 두 의미로 쓰거나(상태색을 장식에 빌려쓰기), SSOT 가 «하지 마라» 한 조합.
- **접근성**: 접근성 라벨 누락, 텍스트/배경 대비 부족, 동적 타입·터치 타깃 미대응, 색에만 의존한 정보 전달.
- **패턴 불일치**: 같은 역할 컴포넌트가 화면마다 다른 간격/모서리, 누락된 상태(빈/오류/로딩/비활성/포커스), 중복 정의된 스타일.
- **i18n 표면**: 노출 문자열이 이 레포가 정한 로케일 집합/추출 방식을 안 타는 패턴.
- **보강 신호 (있으면)**: 아래 출처에서 «읽기 어렵다·버튼이 작다·색이 헷갈린다» 류 디자인 불만을 교차로 붙여 impact 를 보강하라.
${githubSignal}
- 최근 흐름: \`git log --oneline -30\` 으로 이미 진행 중인 디자인 작업은 다시 제안하지 마라.${opts.storeReviews ? "\n- 스토어 리뷰: 위 «스토어 리뷰 신호» 섹션의 JSON 파일 (디자인 관련 불만만 골라 보강)." : ""}${opts.crashSignals ? "\n- 크래시: 위 «크래시 신호» 섹션의 JSON 파일." : ""}

## 2단계 — 종합: 디자인 부채 브리프 작성 (최대 5건)
스캔에서 본 위반을 «문제/기회» 단위로 묶어라 — 낱개 위반 하나가 아니라, 같은 드리프트가 여러 화면에 퍼진 «부채» 묶음으로. 각 브리프 요건:
- **근거 필수 — 파일:라인 + 위반 토큰/패턴명**: 모든 evidence 의 ref 에 «파일:라인» 을, summary 에 «위반한 토큰/패턴명과 무엇을 우회했는지» 를 적어라 (예: ref \`Views/FooView.swift:42\`, summary \`리터럴 .orange — 의미 토큰(pro) 우회\`). 실제로 본 위치가 없는 상상 제안 금지.
${DEDUP_INSTRUCTION}
- **impact / effort**: 1~5 정수. impact 는 그 부채가 일관성·접근성·사용자 경험에 주는 타격(접근성 위반·대비 부족은 높게), effort 는 고치는 품(반나절=1, 수 주=5).
- **scope / spec**: 승인 즉시 구현 가능한 수준 — 어느 파일들을 어떤 의미 토큰/패턴으로 바꿀지, 수용 기준(위반이 0 인지 확인하는 방법), 비-목표(동작 변경 없음 등). 이 브리프 자체가 디자인이 주제이므로 problem/spec 이 곧 디자인 기준을 말한다.

${backlog}

## 3단계 — 산출
다음 경로에 JSON «배열» 파일을 써라 (다른 곳에 쓰지 마라):
${opts.outFile}

각 원소 스키마 (코드 기능 브리프와 «동일» 형식 — 같은 백로그에 나란히 들어간다):
{
  "title": "디자인 부채 한 줄 (80자 이내)",
  "problem": "어느 화면들의 무엇이, 어떤 토큰/패턴을 어겨서, 누구에게 어떻게 불편한가",
  "evidence": [{ "kind": "${designKinds}", "ref": "파일:라인", "summary": "위반 토큰/패턴명 + 무엇을 우회했는지" }],
  "impact": 1-5,
  "effort": 1-5,
  "scope": "이번에 고치는 표면 / 비-목표",
  "spec": "유저스토리 + 수용 기준(위반 0 확인) + 엣지케이스 (markdown)",
${DEDUP_SCHEMA_FIELD}
}

제안할 디자인 부채가 정말 없으면 빈 배열 [] 을 써라. 파일을 쓴 뒤 «디자인 부채 N건 작성 완료» 한 줄로 끝내라.${localeOutputDirective(opts.locale)}`;
  }

  // 프롬프트는 한국어 — 사용자 세션 transcript 로 그대로 보이므로 제품 언어와 일치시킨다.
  // 렌즈 머리말 — "bug" 면 디버깅·신뢰성 신호를 우선 모으게 하는 머리말을 주입한다. 전방위(default)·
  // qa·security 는 빈 문자열 → lensBlock 이 통째로 사라져 기존 수집 프롬프트와 byte-identical (회귀 0).
  const collectHeadmatter = collectLensHeadmatter(opts.lens ?? "default");
  const lensBlock = collectHeadmatter ? `\n${collectHeadmatter}\n` : "";
  return `너는 이 저장소의 프로덕트 오너(PO) 에이전트다. 이 레포의 «다음에 만들 가치 있는 일» 을 찾아 기회 브리프로 정리하는 것이 임무다. 코드를 수정하지 마라 — 읽기/조사만 한다.
${profile}${directive}${history}${verification}${storeReviews}${crashSignals}${designContext}${lensBlock}
## 1단계 — 신호 수집 (가능한 것만, 실패해도 계속)
${githubSignal}
- 레포 내부 신호: 이 레포가 쓰는 할 일/로드맵 문서(레포의 문서 컨벤션을 따라 찾아라 — 예: \`docs/\` 아래 todo/roadmap 문서·\`TODO.md\`·\`ROADMAP.md\`·이슈 트래커 등), 코드의 TODO/FIXME/HACK 주석(\`grep -rn\`), README 의 로드맵 섹션.
- 최근 흐름: \`git log --oneline -30\` 으로 최근 작업 방향을 파악해 — 이미 진행 중인 것을 다시 제안하지 마라.${opts.storeReviews ? "\n- 스토어 리뷰: 위 «스토어 리뷰 신호» 섹션의 JSON 파일." : ""}${opts.crashSignals ? "\n- 크래시: 위 «크래시 신호» 섹션의 JSON 파일." : ""}

## 2단계 — 종합: 기회 브리프 작성 (최대 5건)
신호들을 «문제/기회» 단위로 묶어라. 각 브리프 요건:
- **근거 필수**: 모든 브리프는 1단계에서 실제로 본 신호로 역추적 가능해야 한다. 근거 없는 상상 제안 금지. evidence 의 ref 에는 확인 가능한 참조(이슈 번호/URL, 파일:라인, 커밋 sha)를 적는다.
${DEDUP_INSTRUCTION}
- **impact / effort**: 1~5 정수. impact 5 = 핵심 사용자 가치/수익에 직결, 1 = 사소. effort 5 = 수 주, 1 = 반나절.
- **spec**: 승인 즉시 다른 에이전트가 구현을 시작할 수 있는 수준 — 유저스토리, 수용 기준(체크리스트), 엣지케이스, 비-목표.
- **디자인 수용 기준 (UI 가 닿는 브리프만)**: spec 의 수용 기준에 위 「디자인 제약」 을 반영하라 — 쓰는 색의 «의미»(이 레포가 정한 토큰/약속을 따르고 의미를 혼동하지 마라), 노출 문자열의 i18n(이 레포가 지원하는 로케일 «집합» 전부), 상태(빈/오류/로딩/비활성/포커스), 접근성(라벨·대비). 특정 색·로케일 수를 박지 말고 «이 레포가 정한 대로» 표현하라. UI 표면이 없는 브리프(daemon·네트워크·CLI 등)엔 넣지 마라.

${backlog}

## 3단계 — 산출
다음 경로에 JSON «배열» 파일을 써라 (다른 곳에 쓰지 마라):
${opts.outFile}

각 원소 스키마:
{
  "title": "문제/기회 한 줄 (80자 이내)",
  "problem": "상세 문제 정의 — 누가, 언제, 무엇이 불편한가",
  "evidence": [{ "kind": "github_issue|repo_todo|code_comment|git_log|doc${opts.storeReviews ? "|asc_review" : ""}${opts.crashSignals ? "|crash" : ""}", "ref": "확인 가능한 참조", "summary": "이 근거가 말하는 것 한 줄" }],
  "impact": 1-5,
  "effort": 1-5,
  "scope": "이번에 하는 것 / 비-목표",
  "spec": "유저스토리 + 수용 기준 + 엣지케이스 (markdown)",
${DEDUP_SCHEMA_FIELD}
}

제안할 것이 정말 없으면 빈 배열 [] 을 써라. 파일을 쓴 뒤 «브리프 N건 작성 완료» 한 줄로 끝내라.${localeOutputDirective(opts.locale)}`;
}

/**
 * «리서치 요청» — 사용자가 정한 주제를 에이전트가 조사해 ① 보고서(markdown)와 ② 기회 브리프를
 * 만든다. 내부 신호 채굴(수집)로는 «완전히 새로운 일» 의 근거를 만들 수 없다는 한계의 답.
 *
 * `scope` 가 «조사 범위» 를 가른다 (po_research_scope_v1):
 *   - "web_repo" (기본/생략, 옛 클라이언트 호환): 웹+레포 — 시장/경쟁/수요 조사가 브리프의 근거.
 *   - "repo_only": 웹 검색을 끄고 이 레포 근거만으로 보고서·브리프를 쓴다 — 가벼운 분석을 웹의
 *     지연(딥리서치는 쿼리당 수십 분)·토큰 없이 싸고 빠르게. «웹 조사 (핵심)» 단계가 «레포만
 *     조사 — 웹 검색 금지» 로 바뀌고, 보고서 «경쟁/대안» 절은 생략 가능, 브리프 근거는 repo 만으로 허용.
 */
export function buildPoResearchPrompt(opts: {
  repoPath: string;
  topic: string;
  reportFile: string;
  briefsFile: string;
  /** 기존·과거 백로그 (중복 제안 방지 dedup 앵커) — 수집과 동형(닫힌 결정 포함). */
  existingBriefs: PoExistingBrief[];
  /** 디자인 컨텍스트 «선언» (선택, po_profiles.design_directive) — 수집과 동형. 비면 자동 발견. */
  designDirective?: string;
  /**
   * «전문가 관점» 렌즈 (선택, po_research_lens_v1). 생략/"default"(전방위)면 머리말 없이 기존
   * 전방위 리서치와 byte-identical (옛 클라이언트 호환·회귀 0). "design"/"bug" 면 무엇을 우선
   * 조사하고 어떤 근거를 강조할지의 머리말을 주입한다 (lens.ts 가 SSOT — 수집 designer 와 의미 일치).
   * 보고서·브리프 스키마는 동일하게 유지한다 (조사 «방향» 만 바꾼다).
   */
  lens?: PoLens;
  /**
   * 조사 범위 (선택, po_research_scope_v1). 생략/"web_repo" 면 기존 웹+레포 조사(회귀 없음).
   * "repo_only" 면 웹 검색을 끄고 레포 근거만으로 보고서·브리프를 작성한다. lens 와 직교 —
   * lens 가 «무엇을 우선·어떤 근거»를, scope 가 «웹+레포 / 레포만(웹 끄기)»를 정해 함께 적용된다.
   * 옛 클라이언트는 안 보냄 → undefined = 웹+레포.
   */
  scope?: "web_repo" | "repo_only";
  /**
   * UX 렌즈 «화면 포함» (선택, po_research_ux_screens_v1). ux 렌즈에서만 의미. true 면 ux 머리말에
   * «렌더된 화면을 캡처해 그 화면으로 휴리스틱을 판정» 하는 블록을 추가한다 — 대상 레포가 이 앱
   * (iOS/Mac)처럼 화면을 가지면 기존 캡처 수단(verify-ios/device·Storybook·웹 헤드리스)을 스스로
   * 찾아 렌더·캡처하고, 화면을 «눈으로» 보고 판정하며 evidence 에 화면 참조를 남긴다. 화면을 못
   * 얻으면(UI 없음/캡처 불가) 코드+웹으로 평가하되 그 한계를 보고서에 명시(graceful fallback).
   * 생략/false 거나 ux 외 렌즈면 머리말이 byte-identical (회귀 0). 옛 클라이언트는 안 보냄 → false.
   */
  screens?: boolean;
  /**
   * 산출 언어 (선택, po_locale_v1) — 수집과 동형. 지원 집합의 비-ko 면 보고서 본문·브리프
   * title/problem/spec 을 그 언어로 쓰라는 지시가 끝에 붙는다. ko/누락/미지원이면 기존 한국어
   * 산출과 byte-identical (회귀 0).
   */
  locale?: string;
}): string {
  const backlog = renderBacklogAnchor(opts.existingBriefs);
  const repoOnly = opts.scope === "repo_only";
  // 렌즈 머리말 — design SSOT 대비/재현·로그 등 «무엇을 우선·어떤 근거» 를 강조. 전방위(default)는
  // 빈 문자열 → 아래 블록이 통째로 사라져 기존 프롬프트와 byte-identical (디자인 제약과 1단계 사이의
  // 간격까지 그대로 유지된다). uxScreens 는 ux 렌즈에서만 «화면 포함» 블록을 추가로 붙인다.
  const headmatter = researchLensHeadmatter(opts.lens ?? "default", {
    uxScreens: opts.lens === "ux" && opts.screens === true,
  });
  const lensBlock = headmatter ? `\n${headmatter}\n` : "";

  // 도입 — repo_only 면 «시장 조사» 가 아니라 레포 조사로 표현 (웹을 안 쓰는 사실과 일치시킨다).
  const intro = repoOnly
    ? "사용자가 아래 주제의 «리서치» 를 요청하며 «레포만» 범위를 골랐다 — 웹 검색 없이 이 레포만 조사해 보고서를 쓰고, 그 결과를 근거로 기회 브리프를 만들어라."
    : "사용자가 아래 주제의 «리서치» 를 요청했다 — 자료 수집과 시장 조사를 수행해 보고서를 쓰고, 그 결과를 근거로 기회 브리프를 만들어라.";

  // 1단계 조사 — repo_only 면 웹 검색을 끄고 레포 근거만. 기본은 웹+레포(웹이 핵심).
  const investigation = repoOnly
    ? `- **레포만 조사 — 웹 검색 금지**: 사용자가 «레포만» 범위를 선택했다 (가벼운 분석을 빠르게). 웹 검색을 «하지 마라». 이 레포의 코드·문서(README·docs)·이슈·git 이력만으로 주제를 조사하라 — 모든 주장의 근거를 레포 안에서(파일:라인, 커밋 sha, 이슈 번호) 찾아라.
- **레포 컨텍스트**: 이 레포의 현재 상태(README, 구조, 관련 코드)를 읽어 주제가 이 제품에 어떻게 닿는지 파악하라.`
    : `- **웹 조사 (핵심)**: 웹 검색으로 경쟁/유사 제품, 시장 수요 신호(커뮤니티 논의·리뷰), 모범 사례, 기술 검토 자료를 찾아라. **모든 주장에 출처 URL 을 남겨라** — URL 없는 주장은 보고서에 못 쓴다. 웹 검색이 불가능한 환경이면 그 사실을 보고서에 명시하고 레포 조사로 진행하라.
- **레포 컨텍스트**: 이 레포의 현재 상태(README, 구조, 관련 코드)를 읽어 주제가 이 제품에 어떻게 닿는지 파악하라.`;

  // 2단계 보고서 구성 — repo_only 면 «경쟁/대안» 생략 가능 + 범위가 레포 한정이었음(웹 미사용)을 결과에 명시.
  const reportStructure = repoOnly
    ? `**보고서 맨 위에 «조사 범위: 레포만 (웹 미사용)» 을 한 줄로 명시하라** — 시장/경쟁 근거 없이 레포만 본 결과임이 드러나게.
구성: (범위 명시 줄) → 요약(3줄) → 조사 발견(주장마다 레포 근거 — 파일:라인/커밋/이슈) → 이 제품에의 함의 → 권고. «경쟁/대안 현황» 절은 웹을 안 썼으니 생략해도 된다(억지로 추측해 채우지 마라). 분량은 충실하되 모바일에서 읽을 수 있게 (대략 400~1200 단어).`
    : `구성: 요약(3줄) → 조사 발견(주장마다 출처 URL) → 경쟁/대안 현황 → 이 제품에의 함의 → 권고. 분량은 충실하되 모바일에서 읽을 수 있게 (대략 500~1500 단어).`;

  // 3단계 브리프 근거 규칙 — repo_only 면 repo 근거만으로 허용(웹/market 최소 1개 규칙 해제).
  const evidenceRule = repoOnly
    ? `- evidence 의 kind 는 "repo"(레포 근거 — 파일:라인/커밋/이슈) / "user_directive"(이 리서치 요청 자체) 를 쓴다 — 웹을 안 썼으니 web/market 근거는 없다.
- **각 브리프는 레포 근거(repo)를 최소 1개** 포함해야 한다 — 레포가 뒷받침하지 않는 브리프는 만들지 마라. 레포 근거가 약해 만들 브리프가 없으면 브리프 0건(빈 배열)도 정답이다 — 그 사유는 보고서에 담아라.`
    : `- evidence 의 kind 는 "web"(웹 출처 — ref 는 반드시 URL) / "market"(시장 신호 — ref 는 URL) / "repo"(레포 근거 — 파일:라인) / "user_directive"(이 리서치 요청 자체) 를 쓴다.
- **각 브리프는 web/market 근거를 최소 1개** 포함해야 한다 — 조사가 뒷받침하지 않는 브리프는 만들지 마라. 조사 결과 «하지 말아야 한다» 는 결론이면 브리프 0건(빈 배열)도 정답이다 — 그 이유는 보고서에 담아라.`;

  return `너는 이 저장소의 프로덕트 오너(PO) 에이전트다. ${intro} 코드를 수정하지 마라 — 조사만 한다.

## 조사 주제 (사용자 요청)
${opts.topic}

${buildDesignContext({ designDirective: opts.designDirective })}
${lensBlock}
## 1단계 — 조사
${investigation}

## 2단계 — 보고서 작성
다음 경로에 markdown 보고서를 써라:
${opts.reportFile}

${reportStructure}

## 3단계 — 기회 브리프 (보고서 근거로, 최대 4건)
다음 경로에 JSON «배열» 을 써라:
${opts.briefsFile}

스키마는 수집과 동일: { "title", "problem", "evidence": [{"kind","ref","summary"}], "impact": 1-5, "effort": 1-5, "scope", "spec", "dedup": {"relation":"new|refinement","ofTitle"} }.
${evidenceRule}
- **디자인 수용 기준 (UI 가 닿는 브리프만)**: spec 의 수용 기준에 위 「디자인 제약」 을 반영하라 — 쓰는 색의 «의미»(이 레포가 정한 토큰/약속), 노출 문자열의 i18n(이 레포가 지원하는 로케일 «집합» 전부), 상태(빈/오류/로딩/비활성/포커스), 접근성(라벨·대비). 특정 색·로케일 수를 박지 말고 «이 레포가 정한 대로». UI 표면이 없는 브리프엔 넣지 마라.
${DEDUP_INSTRUCTION}

${backlog}

두 파일을 모두 쓴 뒤 «리서치 완료 — 브리프 N건» 한 줄로 끝내라.${localeOutputDirective(opts.locale)}`;
}

/**
 * 브리프 «수정 지시» — 사용자가 티켓에 코멘트 달듯 한 줄 지시를 남기면, 에이전트가 브리프를
 * 재종합해 같은 스키마의 «단일 객체» JSON 으로 갱신본을 outFile 에 쓴다. PO 가 스토리 티켓을
 * 다듬어 개발자에게 넘기는 구간 — 승인 전 사람의 개입 통로.
 */
export function buildPoRevisePrompt(opts: {
  brief: {
    title: string;
    problem: string;
    evidence: string; // JSON string (DB 원형)
    impact: number;
    effort: number;
    scope: string;
    spec: string;
  };
  comment: string;
  outFile: string;
  /**
   * 산출 언어 (선택, po_locale_v1) — 수집/리서치와 동형. 지원 집합의 비-ko 면 갱신본의
   * title/problem/spec 을 그 언어로 쓰라는 지시가 끝에 붙는다(원형 한국어 브리프라도 앱 언어로
   * 재종합). ko/누락/미지원이면 기존 한국어 산출과 byte-identical (회귀 0).
   */
  locale?: string;
}): string {
  return `너는 이 저장소의 프로덕트 오너(PO) 에이전트다. 아래 기회 브리프에 사용자가 수정 지시를 남겼다. 지시를 반영해 브리프를 «재종합» 하라. 코드를 수정하지 마라 — 필요하면 레포를 읽어 근거를 보강하는 조사만 한다.

## 현재 브리프
- title: ${opts.brief.title}
- problem: ${opts.brief.problem}
- evidence: ${opts.brief.evidence}
- impact: ${opts.brief.impact} / effort: ${opts.brief.effort}
- scope: ${opts.brief.scope}
- spec:
${opts.brief.spec}

## 사용자 수정 지시
${opts.comment}

## 산출
지시를 반영한 갱신본을 다음 경로에 JSON «단일 객체» 로 써라 (배열 아님, 다른 곳에 쓰지 마라):
${opts.outFile}

스키마는 수집 때와 동일: { "title", "problem", "evidence": [{"kind","ref","summary"}], "impact": 1-5, "effort": 1-5, "scope", "spec" }.
- 지시가 닿지 않는 필드는 원형을 유지하라 (불필요한 재작성 금지).
- 근거 역추적 원칙 유지 — 지시로 근거가 약해지면 레포에서 보강하거나 user_directive 근거를 추가.
파일을 쓴 뒤 «재종합 완료» 한 줄로 끝내라.${localeOutputDirective(opts.locale)}`;
}

/**
 * 기각된 브리프 → «코드 흔적 정리» 세션의 첫 프롬프트 (po_cleanup_v1).
 *
 * 배경: 기각된 아이디어의 신호원(TODO/FIXME 주석·미완성 스텁·문서 할 일)이 레포에 남아
 * 있으면 다음 수집 사이클이 같은 제안을 또 만든다 — 수집의 중복 방지(dedupCorpus)가 기각된
 * 브리프도 보긴 하지만 최근 N건 상한이라 오래된 기각은 빠지고, 무엇보다 신호원 자체가 살아
 * 있으면 «다르게 표현된» 제안이 다시 샐 수 있기 때문. 이 세션은 그 신호원 자체를 지운다.
 * 삭제 «전용» — 구현 금지, 확신 없는 것은 보존, 커밋은 사용자 검토 몫으로 남긴다.
 */
export function buildPoCleanupPrompt(brief: {
  title: string;
  problem: string;
  scope: string;
  evidence: string; // JSON string (DB 원형)
}): string {
  // evidence 는 DB 원형(JSON string) — 파싱해 «파일:라인» 출발점 목록으로 펼친다.
  // 깨진 evidence 는 빈 목록으로 (행 자체를 살리는 toApi 와 같은 정책).
  let refs = "(없음 — 레포 전체 검색으로 시작하라)";
  try {
    const parsed = JSON.parse(brief.evidence) as Array<{
      kind?: string;
      ref?: string;
      summary?: string;
    }>;
    if (Array.isArray(parsed) && parsed.length > 0) {
      refs = parsed
        .map((e) => `- [${e.kind ?? "?"}] ${e.ref ?? ""} — ${e.summary ?? ""}`)
        .join("\n");
    }
  } catch {
    /* 깨진 evidence — 출발점 없이 진행 */
  }

  return `기각된 기회 브리프의 «코드 흔적» 을 정리하라. 아래 아이디어는 검토 끝에 «하지 않기로» 결정됐다 — 절대 구현하지 마라. 이 아이디어 때문에 코드베이스에 남아 있는 TODO/FIXME/HACK 주석, 죽은 코드(이 아이디어만을 위한 미완성 스텁·미사용 코드), 문서의 할 일 항목을 찾아 «제거» 하는 것이 임무다.

## 기각된 아이디어
- title: ${brief.title}
- problem: ${brief.problem}
- scope: ${brief.scope}

## 근거 (출발점 — 이 신호들이 브리프를 만들었다)
${refs}

## 작업 지침
1. 위 근거의 ref(파일:라인, 문서, 이슈)를 먼저 확인하고, 이 아이디어와 관련된 TODO/FIXME/HACK 주석·문서 항목을 레포 전체에서 추가로 검색하라 (grep).
2. 제거는 «이 기각된 아이디어만을 위한 것» 이라고 확신할 수 있는 것만 — 다른 기능이 쓰는 코드, 무관한 TODO 는 절대 건드리지 마라. 확신이 없으면 남기고 보고만 하라.
3. 동작 변경 금지 — 주석/문서 제거가 대부분이고, 죽은 코드를 지웠다면 가능한 수단(빌드/타입체크)으로 깨지지 않았는지 확인하라.
4. 새 기능/리팩터링 금지 — 이 세션은 삭제·정리 전용이다.
5. 커밋하지 마라 — 변경은 작업 트리에 남겨 사용자가 검토 후 직접 처리한다.

끝나면 «파일:라인 — 무엇을 지웠는지» 목록과, 확신이 없어 남긴 항목(있다면)을 보고하라. 제거할 흔적이 전혀 없으면 그 사실을 한 줄로 보고하라.`;
}

/**
 * «워크플로우로 실행» 승인 — 워크플로우 설계 에이전트의 프롬프트. 브리프(problem/spec)를
 * 입력으로 그 브리프에 맞는 워크플로우 정의(nodes/edges JSON)를 설계해 outFile 에 쓴다.
 * 수집과 같은 «tmp JSON 산출 → ingest» 계약 — daemon 이 settle 후 sanitize + validateDef
 * + 사람 게이트 강제를 거쳐 run 을 만든다. 설계 실패 시 daemon 이 기본 4노드 템플릿으로
 * fallback 하므로, 이 프롬프트가 실패해도 승인 액션은 실패로 끝나지 않는다.
 */
export function buildPoWorkflowDesignPrompt(opts: {
  brief: { title: string; problem: string; scope: string; spec: string };
  outFile: string;
  /** 노드 agent 필드에 쓸 수 있는 등록된 에이전트 id 들 (이외 값은 daemon 이 기본값으로 교체). */
  agentIds: string[];
  /** 노드 기본 에이전트 (사용자가 승인 시 고른 것). */
  defaultAgent: string;
  /** 디자인 컨텍스트 «선언» (선택, po_profiles.design_directive) — 수집과 동형. 비면 자동 발견. */
  designDirective?: string;
}): string {
  const { brief } = opts;
  return `너는 이 저장소의 PO 에이전트다. 아래 «승인된 기회 브리프» 를 구현할 멀티 에이전트 워크플로우(DAG)를 설계하라. 코드를 수정하지 마라 — 레포를 읽어 검증 방법을 파악하는 조사만 하고, 산출은 워크플로우 정의 JSON 하나다.

## 브리프
- title: ${brief.title}
- problem: ${brief.problem}
- scope: ${brief.scope}
- spec:
${brief.spec}

${buildDesignContext({ designDirective: opts.designDirective })}

## 워크플로우가 따라야 할 골격
«스펙 확정 → 구현 → 자가 검증 → 사람 승인 게이트(커밋) → 종료». 이 골격을 브리프에 맞게 구체화하라:
- **스펙 확정**: 브리프 spec 을 이 레포의 스펙/문서 컨벤션을 따르는 스펙 문서로 확정해 저장 (레포가 쓰는 위치·형식을 먼저 찾아 따르고, 없으면 \`docs/\` 아래 새 문서로).
- **구현**: 그 스펙대로 구현. 필요하면 구현을 2개 노드로 나눠도 된다 (예: 백엔드 / 프런트엔드처럼 계층·모듈별로). UI 가 닿는 브리프면 위 「디자인 제약」 의 핵심(이 레포가 선언/발견한 색 의미·지원 로케일 집합·상태·접근성)을 구현 노드 prompt 에 «직접» 담아라 — 노드 세션은 그 레포의 CLAUDE.md/AGENTS.md 를 자동으로 읽지 못한다.
- **자가 검증**: 이 레포의 기존 검증 수단을 그대로 쓰라 — 레포의 \`.claude/\`/CLAUDE.md/AGENTS.md/scripts 를 읽고 브리프 변경 종류에 맞는 것을 고른다 (예: UI 변경이면 그 스택의 UI/스냅샷 검증, 백엔드/CLI 변경이면 테스트+빌드/타입체크). 노출 문자열·번역(i18n)이 닿는 변경이면, 레포에 i18n 린트/카탈로그 점검 수단이 있으면 돌려 «리소스/카탈로그를 우회하는» 안티패턴 후보를 «파일:라인» 으로 표면화하고, 이 변경(diff)이 «새로 들인» 후보를 우선 확인하라 — 스냅샷/실행으론 못 보는 누락 로케일 회귀를 잡는다. 새 검증 방식을 발명하지 마라. 검증 노드의 «실패» 간선을 구현 노드로 이어 재시도 루프를 만들어라.
- **디자이너 리뷰 (UI 가 닿는 브리프만)**: 구현이 «렌더되는 UI 표면» 에 닿으면, 자가 검증과 게이트 사이에 «디자이너 리뷰» 작업 노드 1개를 둬라 (게이트의 «직전» 노드 — 그래야 findings 가 게이트의 입력 evidence 로 흘러간다). 그 노드는 이 레포의 «기존» 캡처 수단(시뮬레이터/앱 스크린샷·Storybook·웹 헤드리스 등)으로 변경 화면을 렌더·캡처하고, 스크린샷을 위 「디자인 제약」 의 디자인 SSOT 대비 «직접 보고» 비평해 위반(색 의미 혼동·대비·간격·종류색)마다 «무엇이/어디서(정규화 좌표 또는 토큰명)» 를 단 findings 를 result.md 로 남긴다. 비결정성 완화로 같은 화면을 2회 이상 비평해 일치한 것만 «확정» 보고하게 하라. 이 노드는 «증거 수집» 전용이라 코드를 고치지 않고 게이트로 통과만 한다(«실패» 간선 없음 — 자동 차단이 아니라 사람이 결재 때 본다). 텍스트만 바뀌는 등 렌더 표면이 없는 브리프면 이 노드를 두지 마라.
- **사람 승인 게이트**: 종료 직전에 \`requires_approval: true\` 작업 노드 1개 — 사용자가 승인하면 그 노드의 세션이 변경을 «커밋까지만» 한다. 작업 브랜치를 기본 브랜치로 직접 합치지(git merge·push) 마라 — 재결합은 daemon 의 머지 큐가 게이트 승인+커밋 후 직렬로(충돌 사전탐지·머지 후 정리 포함) 담당한다. 게이트 없이 진행되는 경로가 있으면 안 된다. UI 브리프면 게이트 prompt 가 «디자이너 리뷰» findings 를 함께 읽어 커밋 요약에 미해결 회귀를 적게 하라.

## 정의 스키마 (이 형식 그대로)
노드(NodeDef): { "id": "고유 문자열", "type": "start" | "task" | "end", "title": "한 줄", "prompt": "task 필수 — 이 노드 세션에 보낼 전체 지시", "agent"?: ${JSON.stringify(opts.agentIds)} 중 하나 (생략 시 ${opts.defaultAgent}), "requires_approval"?: true (게이트만), "x": 숫자, "y": 숫자 }
간선(EdgeDef): { "id": "고유 문자열", "from": "노드 id", "to": "노드 id", "condition"?: "fail" }

규칙:
- start 노드 1개, end 노드 1개 필수. task 노드는 prompt 필수.
- 루프(뒤로 가는 간선)는 작업의 "fail" 간선으로만 — 그 외 간선으로 순환을 만들면 거부된다.
- 각 task 의 prompt 는 «그 노드만 보는 새 세션» 에 들어간다 — 브리프 내용 등 필요한 컨텍스트를 prompt 안에 직접 담아라 (이전 노드 결과는 Task 폴더로 자동 전달되니 "이전 단계 결과 폴더를 읽어라" 라고 지시하면 된다).
- 노드는 6±2개 정도로 — 과도하게 쪼개지 마라. 좌표는 위→아래 흐름으로 보기 좋게 (x 60~400, y 60 간격 170).

## 산출
다음 경로에 JSON «단일 객체» { "nodes": [...], "edges": [...] } 를 써라 (다른 곳에 쓰지 마라):
${opts.outFile}

파일을 쓴 뒤 «워크플로우 설계 완료» 한 줄로 끝내라.`;
}

/**
 * 승인된 브리프 → 구현 세션의 첫 프롬프트. spec 이 본문이고, 검증(자가 확인)까지 지시한다.
 * (이 세션은 일반 세션으로 iOS 세션 탭에 떠서 사용자가 관전/개입할 수 있다.)
 *
 * `designDirective` (선택, po_profiles.design_directive) — 워크플로우(pro) 설계 경로와 동형으로
 * 「디자인 제약」 을 구현 세션 프롬프트에 «직접» 담는다. 워크플로우를 안 켠 «기본(세션)» 승인도
 * UI 브리프면 레포가 정한 색 의미·지원 로케일 집합·상태·접근성을 알고 시작하게 하기 위함이다 —
 * 이 단일 구현 세션을 돌리는 비-Claude 에이전트(codex/local_llm/opencode 등)는 그 레포의
 * CLAUDE.md/AGENTS.md 를 자동으로 읽지 못할 수 있다(워크플로우 노드와 같은 한계). 비면 자동
 * 발견 폴백(수집/워크플로우와 동일). UI 표면이 없는 브리프(daemon·CLI·스키마)는 buildDesignContext
 * 의 「UI 가 닿으면」 게이트가 거른다 — 판단을 프롬프트에 위임한다.
 */
export function buildPoExecPrompt(
  brief: {
    title: string;
    problem: string;
    scope: string;
    spec: string;
  },
  designDirective?: string,
): string {
  return `승인된 기회 브리프를 구현하라.

## 문제
${brief.problem}

## 스코프
${brief.scope}

## 스펙
${brief.spec}

${buildDesignContext({ designDirective })}
- 이 세션을 돌리는 에이전트(codex·로컬 LLM 등)는 이 레포의 CLAUDE.md/AGENTS.md 를 자동으로 읽지 못할 수 있다 — UI 가 닿는 작업이면 위 디자인 제약을 «직접» 따르라(스펙의 디자인 수용 기준은 «무엇을», 이 제약은 «어떻게» 의 SSOT 포인터다).

구현 후 가능한 수단(테스트/빌드/실행)으로 스스로 검증하고, 수용 기준 체크리스트에 따라 결과를 보고하라. 스코프의 비-목표는 건드리지 마라.`;
}
