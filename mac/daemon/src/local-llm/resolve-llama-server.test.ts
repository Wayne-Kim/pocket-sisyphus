/**
 * llama-server 바이너리 해석 단위 테스트 (dep 주입) — resolve-binary.test.ts 와 같은 형태.
 */
import { describe, it, expect } from "vitest";
import {
  findLlamaServerBinary,
  resolveLlamaServerBinary,
  type ResolveDeps,
} from "./resolve-llama-server.js";

function deps(overrides: Partial<ResolveDeps>): ResolveDeps {
  return {
    existsSync: () => false,
    execSync: () => {
      throw new Error("no zsh");
    },
    envOverride: undefined,
    ...overrides,
  };
}

describe("findLlamaServerBinary", () => {
  it("env override 가 존재하면 최우선", () => {
    const d = deps({ envOverride: "/custom/llama-server", existsSync: (p) => p === "/custom/llama-server" });
    expect(findLlamaServerBinary(d)).toBe("/custom/llama-server");
  });

  it("known candidate 를 우선순위대로 찾는다", () => {
    const d = deps({ existsSync: (p) => p === "/opt/homebrew/bin/llama-server" });
    expect(findLlamaServerBinary(d)).toBe("/opt/homebrew/bin/llama-server");
  });

  it("candidate 없으면 zsh PATH fallback", () => {
    const d = deps({
      execSync: () => "/somewhere/llama-server\n",
      existsSync: (p) => p === "/somewhere/llama-server",
    });
    expect(findLlamaServerBinary(d)).toBe("/somewhere/llama-server");
  });

  it("아무 데도 없으면 null", () => {
    expect(findLlamaServerBinary(deps({}))).toBeNull();
  });
});

describe("resolveLlamaServerBinary", () => {
  it("못 찾으면 brew 설치 안내로 throw", () => {
    expect(() => resolveLlamaServerBinary(deps({}))).toThrow(/brew install llama\.cpp/);
  });
});
