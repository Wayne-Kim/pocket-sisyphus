/**
 * `resolveCopilotBinary` 의 모든 분기 — mocked fs/execSync 로 검증.
 * codex/opencode resolve-binary 와 같은 회귀 방지 목적: 경로 탐색이 조용히 깨져
 * «빈 터미널» 류 silent failure 가 되는 것을 차단.
 */
import { describe, it, expect } from "vitest";
import {
  resolveCopilotBinary,
  knownCandidates,
  type ResolveDeps,
} from "./resolve-binary.js";

const HOME = "/Users/tester";

function deps(overrides: Partial<ResolveDeps>): ResolveDeps {
  return {
    existsSync: () => false,
    execSync: () => {
      throw new Error("not stubbed");
    },
    home: HOME,
    ...overrides,
  };
}

describe("knownCandidates", () => {
  it("homebrew 가 1순위 (npm i -g / brew 의 기본 결과)", () => {
    expect(knownCandidates(HOME)[0]).toBe("/opt/homebrew/bin/copilot");
  });

  it("Intel mac / 옛 npm prefix(/usr/local/bin)도 후보에 포함", () => {
    expect(knownCandidates(HOME)).toContain("/usr/local/bin/copilot");
  });
});

describe("resolveCopilotBinary", () => {
  it("첫 번째로 존재하는 후보를 반환", () => {
    const d = deps({
      existsSync: (p) => p === "/usr/local/bin/copilot",
    });
    expect(resolveCopilotBinary(d)).toBe("/usr/local/bin/copilot");
  });

  it("후보 전멸 → login-shell PATH fallback", () => {
    const d = deps({
      existsSync: (p) => p === "/custom/path/copilot",
      execSync: (cmd) => {
        expect(cmd).toContain("command -v copilot");
        return "/custom/path/copilot\n";
      },
    });
    expect(resolveCopilotBinary(d)).toBe("/custom/path/copilot");
  });

  it("execSync 결과 경로가 실존하지 않으면 throw", () => {
    const d = deps({
      existsSync: () => false,
      execSync: () => "/ghost/copilot\n",
    });
    expect(() => resolveCopilotBinary(d)).toThrow(/Copilot CLI/);
  });

  it("execSync 자체가 throw 해도 사용자 친화 메시지로 throw", () => {
    const d = deps({});
    expect(() => resolveCopilotBinary(d)).toThrow(/npm install -g @github\/copilot/);
  });
});
