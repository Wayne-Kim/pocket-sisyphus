/**
 * Homebrew 탐지 단위 테스트 (dep 주입) — resolve-llama-server.test.ts 와 같은 형태.
 */
import { describe, it, expect } from "vitest";
import { detectHomebrew, type HomebrewDeps } from "./resolve-homebrew.js";

function deps(overrides: Partial<HomebrewDeps>): HomebrewDeps {
  return {
    isExecutable: () => false,
    execSync: () => {
      throw new Error("no zsh");
    },
    ...overrides,
  };
}

describe("detectHomebrew", () => {
  it("login-shell PATH(command -v brew) 가 최우선", () => {
    const d = deps({
      execSync: () => "/opt/homebrew/bin/brew\n",
      // 다른 후보도 «있다» 고 해도 PATH 결과를 먼저 반환해야 한다.
      isExecutable: (p) => p === "/opt/homebrew/bin/brew" || p === "/usr/local/bin/brew",
    });
    expect(detectHomebrew(d)).toBe("/opt/homebrew/bin/brew");
  });

  it("PATH 에 없으면 Apple Silicon prefix(/opt/homebrew/bin/brew) 로 폴백", () => {
    const d = deps({ isExecutable: (p) => p === "/opt/homebrew/bin/brew" });
    expect(detectHomebrew(d)).toBe("/opt/homebrew/bin/brew");
  });

  it("Apple Silicon 도 없으면 Intel prefix(/usr/local/bin/brew)", () => {
    const d = deps({ isExecutable: (p) => p === "/usr/local/bin/brew" });
    expect(detectHomebrew(d)).toBe("/usr/local/bin/brew");
  });

  it("command -v 가 경로를 줘도 실행 불가면 무시하고 prefix 폴백", () => {
    const d = deps({
      execSync: () => "/some/stale/brew\n",
      isExecutable: (p) => p === "/opt/homebrew/bin/brew", // stale 경로는 -x 실패
    });
    expect(detectHomebrew(d)).toBe("/opt/homebrew/bin/brew");
  });

  it("아무 데도 없으면 null", () => {
    expect(detectHomebrew(deps({}))).toBeNull();
  });
});
