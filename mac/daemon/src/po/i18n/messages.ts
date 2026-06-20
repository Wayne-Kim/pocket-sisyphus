// PO 프롬프트 다국어 카탈로그 — 영역별 메시지 집계 (SSOT 레지스트리).
//
// 영역별 파일(messages.shared / messages.collect / …)을 한곳에 모아 MESSAGES 로 노출한다.
// MsgId 는 모든 메시지 id 의 유니온 — t() 호출이 오타나 누락 id 를 컴파일 타임에 잡는다.

import { sharedMessages } from "./messages.shared.js";
import { collectMessages } from "./messages.collect.js";
import { researchMessages } from "./messages.research.js";
import { execMessages } from "./messages.exec.js";
import { designMessages } from "./messages.design.js";
import { workflowMessages } from "./messages.workflow.js";
import { lensMessages } from "./messages.lens.js";

export const MESSAGES = {
  ...sharedMessages,
  ...collectMessages,
  ...researchMessages,
  ...execMessages,
  ...designMessages,
  ...workflowMessages,
  ...lensMessages,
} as const;

export type MsgId = keyof typeof MESSAGES;
