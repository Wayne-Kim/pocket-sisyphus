// PO 프롬프트 다국어 — locale 집합 + 메시지 타입 + 보간 헬퍼.
//
// 배경: PO 루프가 에이전트에게 보내는 프롬프트는 runUserMessagePty 로 세션에 «사용자 메시지» 로
// 들어가 iOS/Mac 세션 transcript 에 그대로 보인다. 본문이 한국어로 하드코딩돼 있어 비-ko 사용자는
// «프롬프트로 무엇이 들어가는지» 를 못 읽었다. 이 모듈이 프롬프트 산문을 «기기 표시 언어» 로
// 지역화하는 정적 카탈로그의 토대다 — ko 는 SSOT(소스 언어), 나머지 9개는 번역.
//
// 지원 집합은 이 레포가 «선언» 한 10개(iOS/Mac Localizable.xcstrings·prompt.ts PO_OUTPUT_LANGUAGE 와
// 동일). 카탈로그 값은 ko 가 기존 프롬프트 리터럴과 «byte-identical» 하게 verbatim 으로 들어가,
// locale 누락/ko/미지원이면 t() 가 ko 를 돌려줘 기존 동작과 회귀 0 으로 폴백한다.

/** 지원 locale 집합 (canonical 표기). prompt.ts 의 PO_OUTPUT_LANGUAGE + "ko" 와 동일. */
export const PO_LOCALES = [
  "ar",
  "en",
  "es",
  "fr",
  "hi",
  "ja",
  "ko",
  "pt-BR",
  "ru",
  "zh-Hans",
] as const;

export type PoLocale = (typeof PO_LOCALES)[number];

/** 한 메시지의 10개 언어 값. ko 는 필수(소스/폴백), 나머지는 번역. */
export type Msg = Record<PoLocale, string>;

/**
 * 메시지 템플릿의 «{{name}}» 플레이스홀더를 params 로 치환한다. JSON 스키마 예시의 «단일» 중괄호
 * (`{ "title": ... }`)와 충돌하지 않도록 «이중» 중괄호 + 식별자만 매칭한다 (`/\{\{(\w+)\}\}/g`).
 * params 에 없는 키는 원형 유지(부분 포맷 안전). params 가 없으면 템플릿 그대로 반환.
 */
export function format(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (whole, key: string) =>
    Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : whole,
  );
}
