// PO «전문가 관점»(렌즈) — 분석에 «맞는 전문가» 에게 조사를 맡기는 일반화된 관점.
//
// 배경: 수집(collect)엔 이미 «디자이너» 페르소나(po_designer_v1)가 있어 디자인 렌즈로 신호를
// 본다. 리서치(research)는 일반 PO 프롬프트 «하나» 로만 돌아 같은 기계장치가 절반만 깔려
// 있었다. 이 모듈이 렌즈를 «한 곳» 에 정의해 — ① 수집의 designer 와 리서치의 design 이 «같은
// 의미» 를 공유하고(중복 정의 금지), ② 리서치 프롬프트가 렌즈별 «머리말»(무엇을 우선 조사·어떤
// 근거를 강조)을 주입하게 한다. Claude Code/Cursor 가 code-reviewer·debugger 처럼 «역할별
// 전문가» 를 배정하는 흐름과 같은 약속이다 (에이전트 픽커 po_agent_v1 의 «어느 CLI» 와는 직교 —
// 이건 «어느 전문가 관점»).

/**
 * 리서치 렌즈 — "default"(전방위) / "design"(디자인) / "bug"(디버깅) / "qa"(QA) / "security"(보안)
 * / "pm"(기획) / "marketing"(마케팅) / "analytics"(분석) / "ops"(운영) / "logic"(로직).
 * "default" 는 렌즈 미선택(옛 클라이언트)과 동치 — 머리말 없이 기존 전방위 리서치로 돈다.
 * "bug" 는 «디버깅» 전문가(무엇이 어떻게 깨지는가 — 재현·로그·회귀), "qa" 는 «QA» 전문가
 * (무엇을 어떻게 검증하는가 — 테스트·수용 기준·커버리지), "security" 는 «보안» 전문가
 * (무엇이 노출되고 어떻게 악용되나 — 인증·키 취급·네트워크 노출면·자격증명 흐름·위협모델 대비)로
 * 직교한다. 이 제품은 SSH host key·Tor onion v3·페어링 QR·로컬 자격증명처럼 보안이 «1급 관심사»
 * 라(docs/THREAT_MODEL.md·SECURITY.md) 디자인·디버깅을 깐 같은 기계장치에 «가장 중요한» 렌즈를
 * 채운다. ("bug" id 는 옛 row 호환을 위해 유지하되 표시명은 클라이언트에서 «디버깅».)
 * "pm"(기획)·"marketing"(마케팅)·"analytics"(분석)·"ops"(운영)은 시장 카탈로그가 표준으로 주는
 * 핵심 직무 관점 — 기획=요구 우선순위·로드맵·트레이드오프, 마케팅=메시징·포지셔닝·채널, 분석=
 * 지표·퍼널·인사이트, 운영=배포·신뢰성·비용으로 직교한다.
 * "logic"(로직)은 «기존 비즈니스 로직을 이해하고 개선하는» 관점 — 도메인 정합성·불변식·중복·죽은
 * 코드·과복잡을 본다. bug(왜 깨지나)·qa(어떻게 보증)·security(어떻게 악용되나)·ops(어떻게 운영)와
 * 직교하는 이유: 이 넷은 «깨짐·노출·운영» 을 다루지만 logic 은 «정상 동작하지만 복잡·중복·불명료한
 * 로직» 의 정확성·단순성·유지보수성을 본다 (버그가 아니다 — 동작은 맞는데 도메인에 안 맞거나 더
 * 단순할 수 있는 곳). 이 제품은 상태머신(브리프 status·워크플로우 노드·엔타이틀먼트·세션
 * resume/fork)이 풍부해 도메인 정합성·불변식을 전담해 볼 렌즈가 정작 비어 있어 채운다.
 * 머리말은 보고서에 «도메인 규칙/상태머신 맵»(상태·전이 조건·불변식·트리거) 1절을 «이해 산출물» 로
 * 남기게 해(별도 저장소·UI 없이 기존 보고서 마크다운 재사용), 같은 영역을 다음에 또 reverse-
 * engineering 하지 않고 제안을 평가하게 한다.
 * "ux"(UX·사용성)는 design(시각)과 «다른» 렌즈 — design 이 토큰·색·간격 같은 «시각 디자인» 이라면
 * ux 는 «플로우 마찰·이해(인식 vs 회상)·완수» 를 Nielsen 10 휴리스틱으로 본다(업계가 시각 디자인
 * 리뷰와 UX 휴리스틱 평가를 다른 방법론으로 구분하는 그대로). 같은 기계장치에 «사용성» 렌즈를 별개로
 * 채운 것이다 — design 이 «어떻게 보이나» 라면 ux 는 «어떻게 쓰이나».
 */
import { type PoLocale } from "./i18n/locale.js";
import { t, type MsgId } from "./i18n/t.js";

export type PoLens =
  | "default"
  | "design"
  | "bug"
  | "qa"
  | "security"
  | "pm"
  | "marketing"
  | "analytics"
  | "ops"
  | "logic"
  | "ux";

/** 알려진 렌즈 id (UI 노출 집합 + 입구 검증의 SSOT). */
export const PO_LENSES = [
  "default",
  "design",
  "bug",
  "qa",
  "security",
  "pm",
  "marketing",
  "analytics",
  "ops",
  "logic",
  "ux",
] as const;

/**
 * 자유 문자열 → 알려진 렌즈만 통과. 옛 클라이언트/이상값/누락은 "default"(전방위) 로 폴백한다
 * (designer persona 의 화이트리스트 패턴과 동형 — 자유 문자열을 그대로 믿지 않는다).
 */
export function parseLens(value: unknown): PoLens {
  return value === "design" ||
    value === "bug" ||
    value === "qa" ||
    value === "security" ||
    value === "pm" ||
    value === "marketing" ||
    value === "analytics" ||
    value === "ops" ||
    value === "logic" ||
    value === "ux"
    ? value
    : "default";
}

/**
 * 전문가 «페르소나» — 프롬프트 첫 «정체성 문장» 한 줄. 렌즈가 그동안 «무엇을 우선 볼지»(머리말)만
 * 바꿨다면, 이 함수는 «누가 쓰는가»(정체성)까지 바꿔 — 고른 전문가가 PO 가 아니라 «직접» 브리프를
 * 쓰게 한다. 전엔 어느 렌즈를 골라도 프롬프트 첫 줄이 PO 로 고정돼 모든 브리프가 «PO 기반» 이었다.
 * 미션 문장·"코드 수정 금지"·intro 등 나머지 첫 문단은 각 프롬프트가 그대로 유지하고 이 함수는
 * «정체성 문장만» 돌려준다 — "default" 는 기존 PO 문장과 byte-identical 이라 전방위/옛 클라이언트
 * 회귀 0. 명칭은 researchLensHeadmatter 의 «조사 관점 — X 전문가» 와 일치시켜 한 전문가 개념을
 * 공유한다 (중복 정의 금지). collect/research 공통 SSOT.
 *
 * 산문은 i18n 카탈로그 messages.lens.ts(persona.*) 로 외부화 — ko 는 byte-identical, 비-ko 는 번역.
 * loc 생략(테스트 등 1-arg 호출)이면 ko (회귀 0). default 는 기존 PO 정체성과 byte-identical.
 */
const PERSONA_ID: Record<PoLens, MsgId> = {
  default: "persona.default",
  design: "persona.design",
  bug: "persona.bug",
  qa: "persona.qa",
  security: "persona.security",
  pm: "persona.pm",
  marketing: "persona.marketing",
  analytics: "persona.analytics",
  ops: "persona.ops",
  logic: "persona.logic",
  ux: "persona.ux",
};

export function lensPersona(lens: PoLens, loc?: PoLocale): string {
  return t(PERSONA_ID[lens], loc ?? "ko");
}

/**
 * «디자인» 렌즈의 초점 — 무엇을 우선 보고 어떤 근거를 모을지의 한 줄 요약. 수집의 designer
 * 페르소나(buildPoCollectPrompt 의 designer 분기)와 리서치의 design 렌즈가 «같은 의미» 를
 * 쓰도록 여기 «한 곳» 에서 정의한다 (중복 정의 금지 — 둘이 따로 정의돼 드리프트하는 걸 막는다).
 * 특정 hue/로케일 수를 박지 않는다(레포-무관) — 색·간격·타이포의 «의미» 와 상태/접근성이 기준.
 */
export const DESIGN_LENS_FOCUS =
  "토큰 드리프트(의미 토큰 우회 리터럴·하드코딩)·색 의미 혼동/겸용·접근성(라벨·대비·동적 타입·터치 타깃)·패턴 불일치(간격/모서리/상태 누락)·i18n 표면";

/**
 * «보안» 렌즈의 초점 — 무엇을 우선 보고 어떤 신호/근거를 모을지의 한 줄 요약. 수집의 security
 * 머리말(collectLensHeadmatter)과 리서치의 security 렌즈(researchLensHeadmatter)가 «같은 의미» 를
 * 쓰도록 여기 «한 곳» 에서 정의한다. i18n 카탈로그(messages.lens.ts)의 lens.collect.security /
 * lens.research.security ko 값이 이 텍스트를 그대로 담아 byte-identical (외부 import 호환용 유지).
 */
export const SECURITY_LENS_FOCUS =
  "인증·인가 흐름, 키·시크릿 취급(생성·저장·회전·폐기), 네트워크 노출면(열린 포트·바인딩·전송 암호화), 자격증명 흐름(로컬 보관·전달·페어링), 신뢰 경계와 위협모델 대비(가정·완화책·잔여 위험)";

// UX 렌즈의 «화면 포함» 추가 머리말(po_research_ux_screens_v1)은 i18n 카탈로그
// messages.lens.ts 의 "lens.research.uxScreens" 로 외부화됐다 — researchLensHeadmatter 의 ux 분기가
// uxScreens=true 일 때 기본 ux 머리말 «뒤» 에 «추가» 한다. ko 는 byte-identical, 비-ko 는 번역.

/**
 * 리서치 프롬프트에 주입할 렌즈 «머리말» — 무엇을 «우선 조사» 하고 어떤 «근거» 를 강조할지.
 * 보고서·브리프 스키마는 건드리지 않는다 (조사 방향만 바꾼다). "default"(전방위) 는 빈 문자열을
 * 돌려줘 기존 리서치 프롬프트와 byte-identical — 옛 클라이언트/렌즈 미선택의 회귀를 0으로 만든다.
 * "design" 머리말은 위 DESIGN_LENS_FOCUS 를 공유해 수집 designer 와 의미가 일치한다.
 *
 * `opts.uxScreens` — ux 렌즈에서만 의미 (po_research_ux_screens_v1). true 면 기본 ux 머리말 «뒤» 에
 * UX_SCREENS_HEADMATTER(렌더된 화면 캡처·판정·화면 근거·graceful fallback)를 «추가» 한다. false/생략
 * 이면 붙지 않아 기존 ux 머리말과 byte-identical. ux 외 렌즈는 이 옵션을 무시한다.
 */
export function researchLensHeadmatter(
  lens: PoLens,
  loc: PoLocale,
  opts?: { uxScreens?: boolean },
): string {
  if (lens === "design")
    return t("lens.research.design", loc, { focus: t("lens.designFocus", loc) });
  if (lens === "bug") return t("lens.research.bug", loc);
  if (lens === "qa") return t("lens.research.qa", loc);
  if (lens === "security") return t("lens.research.security", loc);
  if (lens === "pm") return t("lens.research.pm", loc);
  if (lens === "marketing") return t("lens.research.marketing", loc);
  if (lens === "analytics") return t("lens.research.analytics", loc);
  if (lens === "ops") return t("lens.research.ops", loc);
  if (lens === "logic") return t("lens.research.logic", loc);
  if (lens === "ux") {
    const base = t("lens.research.ux", loc);
    // «화면 포함» — 기본 ux 머리말 «뒤» 에 화면 캡처·판정 블록을 «추가» 만 한다. uxScreens 가
    // false/생략이면 base 그대로 반환 → 기존 ux 머리말과 byte-identical (회귀 0).
    return opts?.uxScreens ? `${base}\n${t("lens.research.uxScreens", loc)}` : base;
  }
  return ""; // default(전방위) — 머리말 없음, 기존 리서치 프롬프트와 byte-identical (회귀 없음)
}

/**
 * 수집(collect) 프롬프트에 주입할 렌즈 «머리말» — «무엇을 우선 신호로 모으고 어떻게 종합할지».
 * 산문은 i18n 카탈로그 messages.lens.ts(lens.collect.*) 로 외부화 — ko 는 byte-identical, 비-ko 는 번역.
 * "default"(전방위)·"design"(buildPoCollectPrompt 의 전용 분기가 처리)은 빈 문자열 → 일반 수집과
 * byte-identical (회귀 0). 그 외 전문가(bug/security 는 po_collect_lens_v2, qa/pm/marketing/analytics/
 * ops/logic/ux 는 po_collect_lens_v3)는 각자 «우선 신호 + 종합(spec 요건)» 머리말을 주입한다 — 리서치의
 * 같은 렌즈와 의미를 짝 맞추되 수집 맥락으로 표현한다. 옛 daemon 이 모르는 lens 는 parseLens 가
 * 통과시켜도 여기서 빈 문자열로 떨어져 «머리말 없는 default 수집» 으로 안전 폴백한다.
 */
export function collectLensHeadmatter(lens: PoLens, loc: PoLocale): string {
  switch (lens) {
    case "bug":
      return t("lens.collect.bug", loc);
    case "security":
      return t("lens.collect.security", loc);
    case "qa":
      return t("lens.collect.qa", loc);
    case "pm":
      return t("lens.collect.pm", loc);
    case "marketing":
      return t("lens.collect.marketing", loc);
    case "analytics":
      return t("lens.collect.analytics", loc);
    case "ops":
      return t("lens.collect.ops", loc);
    case "logic":
      return t("lens.collect.logic", loc);
    case "ux":
      return t("lens.collect.ux", loc);
    default:
      return ""; // default(전방위)·design(전용 분기가 처리) — 머리말 없음, 일반 수집과 byte-identical
  }
}
