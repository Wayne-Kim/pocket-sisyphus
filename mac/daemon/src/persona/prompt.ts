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
  collectLensHeadmatter,
  researchLensHeadmatter,
  lensPersona,
  type PoLens,
} from "./lens.js";
import { type PoLocale } from "./i18n/locale.js";
import { t, type MsgId } from "./i18n/t.js";

/**
 * 빌더가 받은 raw locale 을 카탈로그 조회용 PoLocale 로 좁힌다. 누락/ko/미지원은 "ko" 로 수렴 →
 * t() 가 ko verbatim 을 돌려줘 기존 프롬프트와 byte-identical (회귀 0). route 는 이미
 * normalizePoLocale 로 정규화해 보내지만, 빌더가 raw 를 받는 경로(테스트 등)도 한 번 더 거른다.
 */
export function poLoc(raw?: string): PoLocale {
  return (normalizePoLocale(raw) ?? "ko") as PoLocale;
}

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

/** 기존·과거 백로그 한 줄의 status 라벨 catalog id — 닫힌 결정(기각/출시 등)을 사람이 읽기 쉽게. */
const STATUS_LABEL_ID: Record<string, MsgId> = {
  proposed: "status.proposed",
  held: "status.held",
  approved: "status.approved",
  running: "status.running",
  rejected: "status.rejected",
  shipped: "status.shipped",
  verified: "status.verified",
  missed: "status.missed",
};

/** status → 지역화 라벨. 알 수 없는 status 는 raw 그대로 (기존 `?? b.status` 폴백 유지). */
function statusLabel(status: string, loc: PoLocale): string {
  const id = STATUS_LABEL_ID[status];
  return id ? t(id, loc) : status;
}

/** 백로그 한 줄 렌더 — `- [상태] 제목 — 문제(1줄)`. */
function renderBriefLine(b: PoExistingBrief, loc: PoLocale): string {
  const label = statusLabel(b.status, loc);
  const problem = b.problem.replace(/\s+/g, " ").trim().slice(0, 80);
  return problem ? `- [${label}] ${b.title} — ${problem}` : `- [${label}] ${b.title}`;
}

/** 백로그 목록을 프롬프트 줄로 렌더. 0건이면 "(없음)". */
function renderBriefLines(briefs: PoExistingBrief[], loc: PoLocale): string {
  if (briefs.length === 0) return t("backlog.none", loc);
  return briefs.map((b) => renderBriefLine(b, loc)).join("\n");
}

/**
 * 세 빌더(수집·디자이너·리서치)에 공통으로 박는 백로그 dedup 앵커. status 로 두 묶음으로 나눈다 —
 * (1) 닫힌 결정/살아있는 제안(rejected/shipped/verified + proposed/held/approved/running) = «재제안 금지»,
 * (2) missed = «재시도 후보». missed 는 의미상 «미해결» 인데 옛 방식은 닫힌 결정과 똑같이 «영구 제외»
 * 시켜 베팅이 빗나간 미해결 갭이 백로그에 다시 못 올라오는 모순이 있었다 — 그래서 별도 분기로 안내한다.
 */
function renderBacklogAnchor(briefs: PoExistingBrief[], loc: PoLocale): string {
  const forbidden = briefs.filter((b) => b.status !== "missed");
  const missed = briefs.filter((b) => b.status === "missed");
  let block = `${t("backlog.forbiddenHeader", loc)}\n${renderBriefLines(forbidden, loc)}`;
  if (missed.length > 0) {
    block += `\n\n${t("backlog.missedHeader", loc)}\n${renderBriefLines(missed, loc)}\n${t("backlog.missedInstruction", loc)}`;
  }
  return block;
}

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

/** 결정 이력 한 줄의 «결정/결과» 라벨 catalog id — 프롬프트가 사람 평가를 읽기 쉽게. */
const DECISION_LABEL_ID: Record<PoDecisionRecord["status"], MsgId> = {
  rejected: "decision.rejected",
  approved: "decision.approved",
  verified: "decision.verified",
  missed: "decision.missed",
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
 * 산출 언어 지시 블록 — locale 이 지원 집합의 «비-ko» 면 «산출 파일의 사람이 읽는 값을 그 언어로,
 * JSON 키/경로/코드/URL 은 비번역으로 유지하라» 를 만들어 프롬프트 «끝» 에 덧붙인다. 본문이 이미
 * 대상 언어로 지역화되므로 이 블록도 그 언어로 쓴다(카탈로그 shared.outputDirective). ko/누락/미지원
 * 이면 빈 문자열 → 프롬프트가 기존과 byte-identical (회귀 0, graceful fallback).
 */
function localeOutputDirective(locale?: string): string {
  const loc = normalizePoLocale(locale);
  if (!loc || loc === "ko") return "";
  const lang = PO_OUTPUT_LANGUAGE[loc];
  if (!lang) return "";
  return t("shared.outputDirective", loc as PoLocale, { lang });
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
  /** 산출 언어 (선택, po_locale_v1) — 누락/ko/미지원이면 ko verbatim (회귀 0). */
  locale?: string;
}): string {
  const loc = poLoc(opts.locale);
  const declared = opts.designDirective?.trim();
  // 선언이 있으면 그대로, 없으면 스택-중립 «자동 발견» 지시. 어느 쪽도 특정 hue/로케일 수를
  // 박지 않는다 — 정책은 «이 레포» 에서 나온다. declared(레포가 직접 쓴 텍스트)는 번역하지 않고 그대로 박는다.
  const source = declared
    ? `${t("design.context.declaredIntro", loc)}\n\n${declared}`
    : t("design.context.autodiscover", loc);

  return `${t("design.context.header", loc)}
${source}

${t("design.context.footer", loc)}`;
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
  /** 산출 언어 (선택, po_locale_v1) — 누락/ko/미지원이면 ko verbatim. */
  locale?: string;
}): string {
  const loc = poLoc(opts.locale);
  return t("designer.review.body", loc, {
    briefTitle: opts.briefTitle,
    designContext: buildDesignContext({ designDirective: opts.designDirective, locale: opts.locale }),
  });
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
  /** 산출 언어 (선택, po_locale_v1) — 누락/ko/미지원이면 ko verbatim. */
  locale?: string;
}): string {
  return t("design.bootstrap.body", poLoc(opts.locale), { outFile: opts.outFile });
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
   * 이 레포의 origin 은 개발용 소스 repo 라 사용자에게 직접 안내하지 않아 글이 안 모인다 — 실제 피드백(이슈·
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
  const loc = poLoc(opts.locale);
  const backlog = renderBacklogAnchor(opts.existingBriefs, loc);

  // 프로젝트 프로필 — 이 레포의 «표준 조사 방식». 신호 소스/관점/제외 영역을 여기에 맞춘다.
  const profile = opts.profileDirective?.trim()
    ? t("collect.profile", loc, { profileDirective: opts.profileDirective.trim() })
    : "";

  // 사용자 지시가 있으면 최우선 — 전방위 스캔 대신 지시를 중심으로 종합한다.
  const directive = opts.instruction?.trim()
    ? t("collect.directive", loc, { instruction: opts.instruction.trim() })
    : "";

  // 출시 후 검증 — shipped 브리프의 가설(problem)이 해소됐는지 같은 수집 파이프가 대조한다.
  // PO 루프가 자기 제안의 성적표를 만드는 구조 (§3.5) — 판정은 별도 verdict 파일로 산출.
  const verification =
    opts.shippedBriefs && opts.shippedBriefs.length > 0 && opts.verdictFile
      ? t("collect.verification", loc, {
          shippedList: opts.shippedBriefs
            .map((b) =>
              t("collect.verificationItem", loc, {
                id: b.id,
                title: b.title,
                problem: b.problem.slice(0, 500),
              }),
            )
            .join("\n"),
          verdictFile: opts.verdictFile,
        })
      : "";

  // 스토어 리뷰 신호 — 출시된 앱의 «진짜 사용자 불만/요청». 켠 레포 + fetch 성공 시에만.
  const storeReviews = opts.storeReviews
    ? t("collect.storeReviews", loc, {
        count: opts.storeReviews.count,
        file: opts.storeReviews.file,
      })
    : "";

  // 크래시 신호 — 사용자가 리뷰로 말해주기 «전» 의 가장 빠르고 객관적인 불만. 켠 레포 +
  // 보고서 데이터가 실제로 있을 때만. 안정성 문제가 기능 제안에 밀리지 않게 명시 지시한다.
  const crashSignals = opts.crashSignals
    ? t("collect.crashSignals", loc, {
        from: opts.crashSignals.from,
        to: opts.crashSignals.to,
        totalCrashes: opts.crashSignals.totalCrashes,
        file: opts.crashSignals.file,
      })
    : "";

  // 과거 결정 요약 — 점수와 제안 방향을 «사람의 누적 평가» 에 맞춰 보정한다(점수 보정).
  // impact/effort 를 매 회차 감으로 매기면 과거 승인/기각·출시 후 검증과 무관해져 점수가
  // 신뢰를 못 얻는다 — 그러면 30초 결재가 무너진다. 이력 0건이면 섹션을 통째로 빼서 기존
  // 동작과 동일(회귀 없음). 건당 1줄·호출부가 N건으로 잘라 넘기므로 프롬프트가 비대해지지 않는다.
  const history =
    opts.decisionHistory && opts.decisionHistory.length > 0
      ? t("collect.history", loc, {
          historyList: opts.decisionHistory
            .map((d) => {
              const note = d.note?.trim() ? ` · ${d.note.trim().slice(0, 140)}` : "";
              return `- [${t(DECISION_LABEL_ID[d.status], loc)}] I${d.impact}/E${d.effort} · ${d.title}${note}`;
            })
            .join("\n"),
        })
      : "";

  // GitHub 신호 분기 — 피드백 repo 가 설정되면 로컬 origin 대신 그 repo 를 `gh -R` 로 읽는다.
  // 비면 현행 그대로 (로컬 origin 을 gh 의 기본 대상으로). 코드·TODO·git·문서 신호는 어느
  // 경우든 로컬 repoPath 기준 — 피드백 repo 는 이슈·Discussions 출처만 바꾼다. -R 한 곳만 읽으니
  // origin 과 같아도 중복 읽기가 없다.
  // 디자인 제약 — 레포가 정한 디자인 SSOT 를 발견/선언받아 spec 이 색 의미·i18n·상태·접근성을
  // 알고 태어나게 한다. 레포-무관(특정 팔레트/로케일 수 비-하드코딩). 항상 들어간다 — UI 무관
  // 브리프는 섹션 «안» 의 「UI 가 닿으면」 게이트가 거른다.
  const designContext = `\n${buildDesignContext({ designDirective: opts.designDirective, locale: opts.locale })}\n`;

  const fbRepo = opts.githubFeedbackRepo?.trim();
  const githubSignal = fbRepo
    ? t("collect.githubFeedback", loc, { fbRepo })
    : t("collect.githubLocal", loc);

  // 디자인 렌즈 (po_collect_lens_v1 — 옛 designer 페르소나와 «같은» 동작, designer→design 동치) —
  // 디자인을 다른 일의 «제약» 이 아니라 «1급 주제» 로 삼아, UI 표면을 위 「디자인 제약」 의 SSOT
  // 대비로 스캔해 디자인 부채를 발굴한다. 산출 스키마/저장소·근거 역추적·중복 방지·점수 보정·출시
  // 후 검증은 기본 수집과 «동일» — 다른 것은 무엇을 신호로 보고(코드 기능 vs UI 디자인) 어떻게
  // 종합하느냐(기회 vs 부채)뿐이다. 기본("default"/생략)은 아래 전방위 수집과 byte-identical (회귀 없음).
  if (opts.lens === "design") {
    // 디자인 부채 evidence kind — 위반 «종류» 를 분류한다(ref=파일:라인, summary=위반 토큰/패턴명).
    // ingest 는 kind 를 자유 문자열로 받으므로(스키마 동일) 프롬프트에서만 정의한다.
    const designKinds = `design_token_drift|design_color_misuse|design_a11y|design_contrast|design_pattern|design_i18n|code_comment${opts.storeReviews ? "|asc_review" : ""}`;
    return t("collect.design.body", loc, {
      persona: lensPersona("design", loc),
      profile,
      directive,
      history,
      verification,
      storeReviews,
      crashSignals,
      designContext,
      focus: t("lens.designFocus", loc),
      githubSignal,
      storeTail: opts.storeReviews ? t("collect.storeTailDesign", loc) : "",
      crashTail: opts.crashSignals ? t("collect.crashTail", loc) : "",
      dedup: t("dedup.instruction", loc),
      backlog,
      outFile: opts.outFile,
      designKinds,
      dedupSchema: t("dedup.schemaField", loc),
      outputDirective: localeOutputDirective(opts.locale),
    });
  }

  // 렌즈 머리말 — "bug" 면 디버깅·신뢰성 신호를 우선 모으게 하는 머리말을 주입한다. 전방위(default)·
  // qa·security 는 빈 문자열 → lensBlock 이 통째로 사라져 기존 수집 프롬프트와 byte-identical (회귀 0).
  const collectHeadmatter = collectLensHeadmatter(opts.lens ?? "default", loc);
  const lensBlock = collectHeadmatter ? `\n${collectHeadmatter}\n` : "";
  const kinds = `github_issue|repo_todo|code_comment|git_log|doc${opts.storeReviews ? "|asc_review" : ""}${opts.crashSignals ? "|crash" : ""}`;
  return t("collect.defaultBody", loc, {
    persona: lensPersona(opts.lens ?? "default", loc),
    profile,
    directive,
    history,
    verification,
    storeReviews,
    crashSignals,
    designContext,
    lensBlock,
    githubSignal,
    storeTail: opts.storeReviews ? t("collect.storeTailDefault", loc) : "",
    crashTail: opts.crashSignals ? t("collect.crashTail", loc) : "",
    dedup: t("dedup.instruction", loc),
    backlog,
    outFile: opts.outFile,
    kinds,
    dedupSchema: t("dedup.schemaField", loc),
    outputDirective: localeOutputDirective(opts.locale),
  });
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
  const loc = poLoc(opts.locale);
  const backlog = renderBacklogAnchor(opts.existingBriefs, loc);
  const repoOnly = opts.scope === "repo_only";
  // 렌즈 머리말 — design SSOT 대비/재현·로그 등 «무엇을 우선·어떤 근거» 를 강조. 전방위(default)는
  // 빈 문자열 → 아래 블록이 통째로 사라져 기존 프롬프트와 byte-identical (디자인 제약과 1단계 사이의
  // 간격까지 그대로 유지된다). uxScreens 는 ux 렌즈에서만 «화면 포함» 블록을 추가로 붙인다.
  const headmatter = researchLensHeadmatter(opts.lens ?? "default", loc, {
    uxScreens: opts.lens === "ux" && opts.screens === true,
  });
  const lensBlock = headmatter ? `\n${headmatter}\n` : "";

  // 도입/조사/보고서 구성/근거 규칙은 scope(web_repo/repo_only) 분기로 web/repo 변형을 고른다.
  const intro = t(repoOnly ? "research.intro.repo" : "research.intro.web", loc);
  const investigation = t(repoOnly ? "research.investigation.repo" : "research.investigation.web", loc);
  const reportStructure = t(
    repoOnly ? "research.reportStructure.repo" : "research.reportStructure.web",
    loc,
  );
  const evidenceRule = t(repoOnly ? "research.evidenceRule.repo" : "research.evidenceRule.web", loc);

  return t("research.body", loc, {
    persona: lensPersona(opts.lens ?? "default", loc),
    intro,
    topic: opts.topic,
    designContext: buildDesignContext({ designDirective: opts.designDirective, locale: opts.locale }),
    lensBlock,
    investigation,
    reportFile: opts.reportFile,
    reportStructure,
    briefsFile: opts.briefsFile,
    evidenceRule,
    dedup: t("dedup.instruction", loc),
    backlog,
    outputDirective: localeOutputDirective(opts.locale),
  });
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
  const loc = poLoc(opts.locale);
  return t("revise.body", loc, {
    title: opts.brief.title,
    problem: opts.brief.problem,
    evidence: opts.brief.evidence,
    impact: opts.brief.impact,
    effort: opts.brief.effort,
    scope: opts.brief.scope,
    spec: opts.brief.spec,
    comment: opts.comment,
    outFile: opts.outFile,
    outputDirective: localeOutputDirective(opts.locale),
  });
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
export function buildPoCleanupPrompt(
  brief: {
    title: string;
    problem: string;
    scope: string;
    evidence: string; // JSON string (DB 원형)
  },
  locale?: string,
): string {
  const loc = poLoc(locale);
  // evidence 는 DB 원형(JSON string) — 파싱해 «파일:라인» 출발점 목록으로 펼친다.
  // 깨진 evidence 는 빈 목록으로 (행 자체를 살리는 toApi 와 같은 정책).
  let refs = t("cleanup.refsNone", loc);
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

  return t("cleanup.body", loc, {
    title: brief.title,
    problem: brief.problem,
    scope: brief.scope,
    refs,
  });
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
  /** 산출 언어 (선택, po_locale_v1) — 누락/ko/미지원이면 ko verbatim. */
  locale?: string;
}): string {
  const { brief } = opts;
  return t("workflow.design.body", poLoc(opts.locale), {
    title: brief.title,
    problem: brief.problem,
    scope: brief.scope,
    spec: brief.spec,
    designContext: buildDesignContext({ designDirective: opts.designDirective, locale: opts.locale }),
    agentIds: JSON.stringify(opts.agentIds),
    defaultAgent: opts.defaultAgent,
    outFile: opts.outFile,
  });
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
  locale?: string,
): string {
  const loc = poLoc(locale);
  return t("exec.body", loc, {
    problem: brief.problem,
    scope: brief.scope,
    spec: brief.spec,
    designContext: buildDesignContext({ designDirective, locale }),
  });
}
