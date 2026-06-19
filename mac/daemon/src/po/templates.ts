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

import { DESIGN_LENS_FOCUS } from "./lens.js";
import type { NodeDef, EdgeDef } from "../workflow/types.js";

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

/** 모든 역할 prompt 가 공유하는 꼬리말 — 직전 단계 결과를 읽고 다음 단계로 손을 넘기는 계약. */
const HANDOFF =
  "직전 단계의 결과 폴더(Task 폴더의 result.md 등)가 있으면 먼저 읽어 맥락을 잇고, 네 역할의 산출과 다음 단계가 이어받을 핵심을 결과로 남겨라.";

const PLAN_PROMPT = `## 역할 — 기획(PO) 전문가
너는 «기획(Product Owner)» 전문가다. 만들 것을 «무엇을·왜·어디까지» 의 눈으로 정의하라.
- 우선 작업: 해결할 문제와 목표, 범위(포함/제외), 수용 기준(acceptance criteria)을 명확히 한다. 모호하면 가정을 적어 좁힌다.
- 산출: 다음 단계(디자인·개발·QA)가 그대로 이어받을 «문제 / 목표 / 범위 / 수용 기준» 을 정리한다.
${HANDOFF}`;

const DESIGN_PROMPT = `## 역할 — 디자인 전문가
너는 «디자인» 전문가다. 산출물을 디자인의 눈으로 — ${DESIGN_LENS_FOCUS} — 검토·설계하라 (PO 리서치의 «디자인» 렌즈와 같은 초점이다).
- 우선 작업: UI 표면이 닿는다면 이 레포가 «선언/발견» 한 디자인 SSOT(의미 토큰·간격·타이포·상태·접근성)와 어긋나지 않게 설계한다. 색·간격·타이포의 «의미» 와 상호작용 상태(빈/오류/로딩/비활성/포커스)·접근성으로 판정한다.
- 산출: 개발이 그대로 구현할 «디자인 결정(의미 토큰·레이아웃·상태별 동작·접근성 라벨)» 을 남긴다. UI 표면이 없으면 그 사실을 명시한다(디자인 0건도 정답).
${HANDOFF}`;

const DEV_PROMPT = `## 역할 — 개발 전문가
너는 «개발(구현)» 전문가다. 기획·디자인 결정을 «정확하고 완전한» 코드로 구현하라.
- 우선 작업: 수용 기준을 충족하는 최소·정확한 변경을 만든다. 관련 없는 코드는 건드리지 않되, 변경이 부른 회귀는 함께 고친다. 기존 컨벤션·디자인 토큰을 따른다.
- 산출: 무엇을 어떻게 바꿨는지(파일·핵심 변경)와 QA 가 검증할 «수용 기준 대비 구현 지점» 을 남긴다. 가능한 빌드/타입체크로 자가 점검한다.
${HANDOFF}`;

const QA_PROMPT = `## 역할 — QA(품질 보증) 전문가
너는 «QA» 전문가다. 산출물을 «무엇을 어떻게 검증하고 품질을 보장하는가» 의 눈으로 점검하라 (PO 리서치의 «QA» 렌즈와 같은 초점 — 테스트 가능성·수용 기준·테스트 케이스(정상·경계·실패)·커버리지 공백·회귀).
- 우선 작업: 기획의 수용 기준 대비 구현을 검증한다. 정상·경계·실패 케이스를 짚고, 가능한 테스트/빌드를 실제로 돌려 결과를 확인한다.
- 산출: 수용 기준별 통과/실패와 근거, 남은 위험·회귀, «운영(배포)으로 넘겨도 되는지» 의 판단을 남긴다.
${HANDOFF}`;

const OPS_PROMPT = `## 역할 — 운영(배포) 전문가
너는 «운영/배포» 전문가다. 사람이 QA 게이트를 승인해 이 단계에 도달했다 — 경계 동작을 신중히 수행하라.
- 우선 작업: 저장소 컨벤션에 따라 변경을 커밋/머지한다. 배포·릴리즈가 필요하면 이 레포의 표준 절차(스크립트)를 따른다. 되돌리기 어려운 동작은 전제(빌드 통과·QA 승인)를 확인하고 진행한다.
- 산출: 커밋/머지·배포 결과와, 운영상 확인할 점(후속 모니터링·롤백 방법)을 결과로 남긴다.
${HANDOFF}`;

/** 역할 파이프라인 템플릿(단일 프리셋). 노드 종류는 start/task/end — 역할은 prompt/title 로. */
const ROLE_PIPELINE: WorkflowTemplate = {
  id: "role_pipeline",
  nodes: [
    { id: "start", type: "start", title: "시작", x: COL_X, y: rowY(0) },
    roleNode("plan", "기획", 1, PLAN_PROMPT),
    roleNode("design", "디자인", 2, DESIGN_PROMPT),
    roleNode("dev", "개발", 3, DEV_PROMPT),
    // 사람 결재 게이트 — 경계 동작(QA·운영) 전에 멈춰 사용자의 승인을 기다린다(human-in-the-loop).
    roleNode("qa", "QA", 4, QA_PROMPT, { requires_approval: true }),
    roleNode("ops", "운영", 5, OPS_PROMPT),
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

/** UI 노출 집합(SSOT) — 현재는 역할 파이프라인 하나. 라우트가 그대로 내려보낸다. */
export const WORKFLOW_TEMPLATES: readonly WorkflowTemplate[] = [ROLE_PIPELINE];

/** 라우트용 — 알려진 템플릿 목록(노드/간선 프리셋). */
export function listWorkflowTemplates(): WorkflowTemplate[] {
  return WORKFLOW_TEMPLATES.map((t) => ({
    id: t.id,
    nodes: t.nodes.map((n) => ({ ...n })),
    edges: t.edges.map((e) => ({ ...e })),
  }));
}
