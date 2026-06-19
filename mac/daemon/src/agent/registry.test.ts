/**
 * Adapter registry 동작 단위 테스트.
 *
 * 회귀 차단 대상:
 *  - register/get/has/list 의 기본 round-trip
 *  - 같은 id 중복 등록 시 throw (실수로 두 adapter 가 같은 id 를 들고 와도 silently
 *    덮어쓰지 않게)
 *  - 등록 안 된 id 에 getAgent → throw (사용자 입력이 라우트에 닿기 전 실패하게)
 *  - registerBuiltinAgents 가 7개 adapter 모두 등록 + 두 번 호출해도 idempotent
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  registerAgent,
  getAgent,
  hasAgent,
  listAgents,
  _resetRegistryForTest,
} from "./registry.js";
import { registerBuiltinAgents } from "./index.js";
import type { AgentAdapter } from "./types.js";

function fakeAdapter(id: string, displayName = `Fake ${id}`): AgentAdapter {
  return {
    id,
    displayName,
    resolveBinary: () => "/bin/true",
    buildSpawnArgs: () => [],
    buildSpawnEnv: () => ({}),
    capabilities: () => [],
  };
}

describe("registry", () => {
  beforeEach(() => {
    _resetRegistryForTest();
  });

  it("register → get / has / list round-trip", () => {
    const a = fakeAdapter("fake_a");
    registerAgent(a);

    expect(hasAgent("fake_a")).toBe(true);
    expect(getAgent("fake_a")).toBe(a);
    expect(listAgents()).toEqual([a]);
  });

  it("같은 id 두 번 등록 시 throw — silently 덮어쓰지 않음", () => {
    registerAgent(fakeAdapter("dup"));
    expect(() => registerAgent(fakeAdapter("dup", "Different"))).toThrowError(
      /agent already registered: dup/,
    );
  });

  it("등록 안 된 id 면 getAgent throw — 라우트가 사용자 입력 검증 전에 실패", () => {
    expect(() => getAgent("nonexistent")).toThrowError(/unknown agent: nonexistent/);
  });

  it("hasAgent 는 등록 안 된 id 에 false (throw 안 함)", () => {
    expect(hasAgent("nonexistent")).toBe(false);
  });

  it("listAgents 는 등록 순서를 보존 (Map insertion order)", () => {
    const a = fakeAdapter("a");
    const b = fakeAdapter("b");
    const c = fakeAdapter("c");
    registerAgent(a);
    registerAgent(b);
    registerAgent(c);
    expect(listAgents().map((x) => x.id)).toEqual(["a", "b", "c"]);
  });
});

describe("registerBuiltinAgents", () => {
  beforeEach(() => {
    _resetRegistryForTest();
  });

  it("7개 빌트인 어댑터를 모두 등록", () => {
    registerBuiltinAgents();
    expect(hasAgent("claude_code")).toBe(true);
    expect(hasAgent("agy")).toBe(true);
    expect(hasAgent("codex")).toBe(true);
    expect(hasAgent("shell")).toBe(true);
    expect(hasAgent("local_llm")).toBe(true);
    expect(hasAgent("opencode")).toBe(true);
    expect(hasAgent("copilot")).toBe(true);
    expect(listAgents()).toHaveLength(7);
  });

  it("idempotent — 두 번 호출해도 중복 등록 throw 안 함", () => {
    registerBuiltinAgents();
    expect(() => registerBuiltinAgents()).not.toThrow();
    expect(listAgents()).toHaveLength(7);
  });

  it("displayName 이 iOS picker 가 기대하는 값과 일치", () => {
    registerBuiltinAgents();
    const byId = Object.fromEntries(listAgents().map((a) => [a.id, a.displayName]));
    expect(byId).toEqual({
      claude_code: "Claude Code",
      shell: "Terminal",
      codex: "Codex CLI",
      agy: "Antigravity CLI",
      local_llm: "Local · Qwen Code",
      opencode: "Local · OpenCode",
      copilot: "Copilot CLI",
    });
  });
});
