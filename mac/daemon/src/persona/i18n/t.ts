// PO 프롬프트 다국어 — 메시지 조회 헬퍼.
//
// t(id, locale, params): 카탈로그에서 메시지를 골라 보간한다. locale 값은 «호출부가 이미
// normalizePoLocale 로 정규화» 한 PoLocale 이다 (누락/미지원은 "ko" 로 수렴). 만약 어떤 번역
// 값이 비어 있으면(번역 누락 — i18n.test.ts 가 막지만 런타임 방어) ko 로 폴백한다.

import { type PoLocale, format } from "./locale.js";
import { MESSAGES, type MsgId } from "./messages.js";

export function t(
  id: MsgId,
  locale: PoLocale,
  params?: Record<string, string | number>,
): string {
  const entry = MESSAGES[id] as Record<PoLocale, string>;
  const value = entry[locale] || entry.ko;
  return format(value, params);
}

export type { MsgId };
