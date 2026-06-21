import { describe, it, expect } from "vitest";
import { listWorkflowTemplates } from "./templates.js";
import { validateDef } from "../workflow/types.js";

describe("workflow templates (출발 템플릿 프리셋)", () => {
  it("역할 파이프라인과 자기교정 루프를 노출한다", () => {
    const tpls = listWorkflowTemplates();
    expect(tpls.map((t) => t.id)).toEqual(["role_pipeline", "self_correcting_loop"]);
  });

  it("모든 템플릿은 유효한 DAG 다 (validateDef 통과)", () => {
    for (const t of listWorkflowTemplates()) {
      const res = validateDef(t.nodes, t.edges);
      expect(res.ok, `${t.id}: ${res.ok ? "" : res.error}`).toBe(true);
    }
  });

  it("역할 파이프라인은 start→기획→디자인→개발→QA→운영→end 순서다", () => {
    const t = listWorkflowTemplates().find((x) => x.id === "role_pipeline")!;
    expect(t.nodes.map((n) => n.id)).toEqual([
      "start",
      "plan",
      "design",
      "dev",
      "qa",
      "ops",
      "end",
    ]);
    // 노드 «종류» 는 start/task/end 뿐 — 역할은 종류가 아니라 prompt/title 로 표현(종류색 유지).
    const byId = new Map(t.nodes.map((n) => [n.id, n]));
    expect(byId.get("start")!.type).toBe("start");
    expect(byId.get("end")!.type).toBe("end");
    for (const id of ["plan", "design", "dev", "qa", "ops"]) {
      expect(byId.get(id)!.type, id).toBe("task");
      expect((byId.get(id)!.prompt ?? "").trim().length, id).toBeGreaterThan(0);
    }
  });

  it("사람 결재 게이트는 QA 노드에만 있다 (경계 동작 전 승인)", () => {
    const t = listWorkflowTemplates().find((x) => x.id === "role_pipeline")!;
    const gated = t.nodes.filter((n) => n.requires_approval === true).map((n) => n.id);
    expect(gated).toEqual(["qa"]);
  });

  it("선형 파이프라인이다 (각 단계가 다음으로만 이어짐)", () => {
    const t = listWorkflowTemplates().find((x) => x.id === "role_pipeline")!;
    const pairs = t.edges.map((e) => `${e.from}->${e.to}`);
    expect(pairs).toEqual([
      "start->plan",
      "plan->design",
      "design->dev",
      "dev->qa",
      "qa->ops",
      "ops->end",
    ]);
    // fail 간선(루프) 없음 — 순수 전진 파이프라인.
    expect(t.edges.every((e) => e.condition === undefined)).toBe(true);
  });

  it("자기교정 루프는 start→생성→점검→end 순서다", () => {
    const t = listWorkflowTemplates().find((x) => x.id === "self_correcting_loop")!;
    expect(t.nodes.map((n) => n.id)).toEqual(["start", "make", "check", "end"]);
    const byId = new Map(t.nodes.map((n) => [n.id, n]));
    expect(byId.get("start")!.type).toBe("start");
    expect(byId.get("end")!.type).toBe("end");
    for (const id of ["make", "check"]) {
      expect(byId.get(id)!.type, id).toBe("task");
      expect((byId.get(id)!.prompt ?? "").trim().length, id).toBeGreaterThan(0);
    }
  });

  it("자기교정 루프는 점검 실패 시 생성으로 되돌아가는 fail 간선을 갖는다", () => {
    const t = listWorkflowTemplates().find((x) => x.id === "self_correcting_loop")!;
    // 전진 간선: start→make→check→end (조건 없음).
    const forward = t.edges.filter((e) => e.condition === undefined).map((e) => `${e.from}->${e.to}`);
    expect(forward).toEqual(["start->make", "make->check", "check->end"]);
    // 루프(되돌아가는 실패 간선): 점검 → 생성, condition="fail" 하나뿐.
    const failEdges = t.edges.filter((e) => e.condition === "fail");
    expect(failEdges.map((e) => `${e.from}->${e.to}`)).toEqual(["check->make"]);
    expect(failEdges.every((e) => e.condition === "fail")).toBe(true);
  });
});