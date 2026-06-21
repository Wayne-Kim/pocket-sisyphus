/**
 * 콘텐츠 진입점. 지금은 영어 단일 — i18n 을 켤 때 여기서 locale 에 따라
 * `site.<locale>.ts` 를 고르도록 바꾼다 (구조는 이미 분리돼 있음).
 */
export { site } from "./site.en";
export type { Site } from "./site.en";

// 차별화 카피 + 비교표 — 10개 로케일 번역 데이터(소스 ko). 라이브 렌더는 en,
// `getDifferentiators(locale)` 로 이미 locale 선택 가능(라우팅 붙이면 i18n 완성).
export {
  differentiators,
  getDifferentiators,
  DEFAULT_LOCALE,
  AXIS_META,
  ROW_META,
} from "./differentiators";
export type { Differentiators, Locale } from "./differentiators";
