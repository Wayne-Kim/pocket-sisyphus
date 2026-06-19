import { describe, expect, it } from "vitest";
import { buildWorkflowDesignPrompt } from "./design.js";
import { sanitizeDesignedDef } from "../po/workflow-exec.js";
import { validateDef } from "./types.js";

const base = {
  description: "매일 아침 새 PR 을 리뷰하고 요약을 남겨줘",
  outFile: "/tmp/ps-wf-design-x.json",
  agentIds: ["claude_code", "codex"],
  defaultAgent: "claude_code",
};

describe("buildWorkflowDesignPrompt", () => {
  it("사용자 설명·산출 경로·후보 에이전트를 프롬프트에 박는다", () => {
    const out = buildWorkflowDesignPrompt(base);
    expect(out).toContain(base.description);
    expect(out).toContain(base.outFile);
    // 후보 에이전트 목록이 JSON 으로, 기본 에이전트가 fallback 으로 명시된다.
    expect(out).toContain(JSON.stringify(base.agentIds));
    expect(out).toContain("생략 시 claude_code");
    // 산출 계약: 단일 객체 { nodes, edges } + 종료 신호 한 줄.
    expect(out).toContain('{ "nodes": [...], "edges": [...] }');
    expect(out).toContain("워크플로우 설계 완료");
  });

  it("«초안» 임을 명시해 무인 자동 실행을 가정하지 않게 한다 (draft not live)", () => {
    const out = buildWorkflowDesignPrompt(base);
    expect(out).toContain("초안");
    expect(out).toContain("무인 자동 실행을 가정하지 마라");
  });
});

// finalizeDesign 의 ingest 경로(sanitize → validateDef)를 순수 함수 수준에서 검증한다.
// (세션 spawn/settle 은 PTY 하니스가 필요해 여기선 다루지 않는다 — 라우트 통합 검증은 별도.)
describe("설계 산출 ingest (sanitize + validateDef)", () => {
  const isValidAgent = (id: string) => id === "claude_code" || id === "codex";

  it("정상 산출 → sanitize 통과 + DAG 검증 통과", () => {
    const raw = {
      nodes: [
        { id: "start", type: "start", title: "시작", x: 60, y: 60 },
        { id: "review", type: "task", title: "PR 리뷰", prompt: "새 PR 을 리뷰하라", x: 60, y: 230 },
        { id: "summary", type: "task", title: "요약", prompt: "리뷰 결과를 요약하라", x: 60, y: 400 },
        { id: "end", type: "end", title: "종료", x: 60, y: 570 },
      ],
      edges: [
        { id: "e1", from: "start", to: "review" },
        { id: "e2", from: "review", to: "summary" },
        { id: "e3", from: "summary", to: "end" },
        // 요약 실패 시 리뷰로 되돌아가는 fail 루프 — validateDef 가 허용해야 한다.
        { id: "e4", from: "summary", to: "review", condition: "fail" },
      ],
    };
    const sanitized = sanitizeDesignedDef(raw, { defaultAgent: "claude_code", isValidAgent });
    expect(sanitized).not.toBeNull();
    const valid = validateDef(sanitized!.nodes, sanitized!.edges);
    expect(valid.ok).toBe(true);
    if (valid.ok) {
      // task 노드의 agent 가 비면 기본값으로 채워진다 (화이트리스트 규칙).
      const review = valid.def.nodes.find((n) => n.id === "review");
      expect(review?.agent).toBe("claude_code");
      expect(review?.skip_permissions).toBe(true);
      expect(valid.def.edges.some((e) => e.condition === "fail")).toBe(true);
    }
  });

  it("형식 불일치(nodes 가 배열 아님) → sanitize 가 null", () => {
    expect(sanitizeDesignedDef({ nodes: "x", edges: [] }, { defaultAgent: "claude_code", isValidAgent })).toBeNull();
  });

  it("prompt 없는 task → validateDef 거부 (사용자에게 사유 노출)", () => {
    const raw = {
      nodes: [
        { id: "start", type: "start" },
        { id: "t", type: "task", title: "할 일" },
        { id: "end", type: "end" },
      ],
      edges: [
        { id: "e1", from: "start", to: "t" },
        { id: "e2", from: "t", to: "end" },
      ],
    };
    const sanitized = sanitizeDesignedDef(raw, { defaultAgent: "claude_code", isValidAgent });
    expect(sanitized).not.toBeNull();
    const valid = validateDef(sanitized!.nodes, sanitized!.edges);
    expect(valid.ok).toBe(false);
  });
});
