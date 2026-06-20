// 워크플로우 «출발 템플릿» — 매번 빈 캔버스에서 손으로 잇지 않도록, 업계 표준
// 오케스트레이터-워커 파이프라인(기획→디자인→개발→QA→운영)을 «프리셋» 으로 준다.
//
// 설계 의도:
//   - 각 task 노드 prompt 는 «해당 역할 전문가» 관점이다. 디자인·QA 노드는 PO 리서치 렌즈
//     (lens.ts) 의 머리말과 «같은 의미» 를 공유한다 — 중복 정의 드리프트를 막으려고 디자인은
//     DESIGN_LENS_FOCUS 를, QA 는 같은 «QA 전문가» 초점을 재사용한다.
//   - 노드 «종류» 는 start/task/end 3종뿐이라(types.ts), 역할은 «종류» 가 아니라 prompt + title
//     로 표현한다. 따라서 캔버스 노드 종류색(시작=초록·작업=분홍·종료=파랑)은 그대로 유지된다 —
//     역할별로 색을 새로 발명하거나 상태색을 빌리지 않는다.
//   - 사람-개입(human-in-the-loop): 경계 동작(배포/운영) 전에 사람 결재가 끼도록 QA 노드에
//     requires_approval=true 를 둔다. 자동 전체 실행이 아니라, QA·운영 구간 진입 전 run 이
//     멈춰 사용자의 approve 를 기다린다(engine.ts 의 승인 게이트).
//
// 노드 «제목»(기획/디자인/…)과 템플릿 «이름/설명» 같은 화면 노출 문자열은 클라이언트(iOS·Mac)
// 가 카탈로그(Localizable.xcstrings)로 지역화한다 — 여기 한국어 title 은 소스/폴백일 뿐, 노드 id
// 가 의미 키라 클라가 id→지역화 제목으로 덮어쓴다. prompt 는 «에이전트에게 보내는 지시문» 이라
// 소스 언어(ko)로 둔다(사용자 화면 노출 문자열 아님 — 디버그/지시문과 같은 범주).

import type { NodeDef, EdgeDef } from "../workflow/types.js";
import { type PoLocale } from "./i18n/locale.js";
import { poLoc } from "./prompt.js";
import { t } from "./i18n/t.js";

/** 템플릿 식별자 — 클라이언트가 이름/설명 지역화 키로 쓰는 안정적 id. */
export type WorkflowTemplateId = "role_pipeline";

/** 템플릿 한 개 — 클라이언트가 캔버스에 시드할 노드/간선 프리셋. */
export type WorkflowTemplate = {
  id: WorkflowTemplateId;
  nodes: NodeDef[];
  edges: EdgeDef[];
};

/** 세로 파이프라인 레이아웃 — 노드를 한 열에 균일 간격으로 쌓는다(캔버스 좌표). */
const COL_X = 80;
const ROW_GAP = 130;
const TOP_Y = 60;
function rowY(index: number): number {
  return TOP_Y + index * ROW_GAP;
}

/**
 * 역할 파이프라인 프리셋: start → 기획 → 디자인 → 개발 → QA(승인 게이트) → 운영 → end.
 * 각 task 노드는 직전 단계의 결과(Task 폴더 result.md)를 읽고 자기 역할의 산출을 남긴다 —
 * 오케스트레이터-워커가 순서대로 손을 넘기는 표준 흐름.
 */
function roleNode(
  id: string,
  title: string,
  rowIndex: number,
  prompt: string,
  opts: { requires_approval?: boolean } = {},
): NodeDef {
  return {
    id,
    type: "task",
    title,
    prompt,
    requires_approval: opts.requires_approval === true ? true : undefined,
    x: COL_X,
    y: rowY(rowIndex),
  };
}

/**
 * 역할 파이프라인 프리셋(단일)을 «앱 언어» 로 빌드. 각 노드 prompt 는 카탈로그(messages.workflow.ts)
 * 의 tpl.* 에서 온다 — ko 는 기존 리터럴과 byte-identical, 비-ko 는 번역. 공통 꼬리말(handoff)·디자인
 * 초점(focus)은 보간으로 넣는다. 노드 «제목»(시작/기획/…)은 ko 소스로 두고 클라이언트가 id 로 지역화한다.
 */
function buildRolePipeline(loc: PoLocale): WorkflowTemplate {
  const handoff = t("tpl.handoff", loc);
  return {
    id: "role_pipeline",
    nodes: [
      { id: "start", type: "start", title: "시작", x: COL_X, y: rowY(0) },
      roleNode("plan", "기획", 1, t("tpl.plan", loc, { handoff })),
      roleNode("design", "디자인", 2, t("tpl.design", loc, { focus: t("lens.designFocus", loc), handoff })),
      roleNode("dev", "개발", 3, t("tpl.dev", loc, { handoff })),
      // 사람 결재 게이트 — 경계 동작(QA·운영) 전에 멈춰 사용자의 승인을 기다린다(human-in-the-loop).
      roleNode("qa", "QA", 4, t("tpl.qa", loc, { handoff }), { requires_approval: true }),
      roleNode("ops", "운영", 5, t("tpl.ops", loc, { handoff })),
      { id: "end", type: "end", title: "종료", x: COL_X, y: rowY(6) },
    ],
    edges: [
      { id: "e_start_plan", from: "start", to: "plan" },
      { id: "e_plan_design", from: "plan", to: "design" },
      { id: "e_design_dev", from: "design", to: "dev" },
      { id: "e_dev_qa", from: "dev", to: "qa" },
      { id: "e_qa_ops", from: "qa", to: "ops" },
      { id: "e_ops_end", from: "ops", to: "end" },
    ],
  };
}

/** 라우트용 — 알려진 템플릿 목록(노드/간선 프리셋). locale 누락/ko/미지원이면 ko (회귀 0). */
export function listWorkflowTemplates(locale?: string): WorkflowTemplate[] {
  return [buildRolePipeline(poLoc(locale))];
}
