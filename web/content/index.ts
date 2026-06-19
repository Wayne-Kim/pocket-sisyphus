/**
 * 콘텐츠 진입점. 지금은 영어 단일 — i18n 을 켤 때 여기서 locale 에 따라
 * `site.<locale>.ts` 를 고르도록 바꾼다 (구조는 이미 분리돼 있음).
 */
export { site } from "./site.en";
export type { Site } from "./site.en";
