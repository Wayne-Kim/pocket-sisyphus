/**
 * 어댑터 설치 실행기 단위 테스트.
 *
 * 회귀 차단 대상:
 *  - installHintIsCommand: npm 명령은 true, URL/빈값은 false (자동 설치 게이트)
 *  - 클라이언트는 id 만 — 실행 명령은 adapter.installHint 상수 (spawn 인자 검증)
 *  - exit 0 + 재탐지 성공 → done/installed, exit≠0 → error/nonzero_exit
 *  - exit 0 인데 바이너리 미탐지 → error/not_detected (PATH 문제 폴백)
 *  - 같은 어댑터 중복 요청 = 합류(멱등, spawn 1회), 다른 어댑터 = busy
 *  - URL hint 어댑터(agy) 는 not_installable throw
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import {
  startAgentInstall,
  startInstall,
  getAgentInstallProgress,
  getLocalLlmInstallTarget,
  installHintIsCommand,
  isHomebrewMissingFailure,
  isNodeMissingFailure,
  LOCAL_LLM_INSTALL_TARGETS,
  _resetInstallStateForTest,
  type InstallDeps,
  type InstallTarget,
} from "./install.js";
import type { AgentAdapter } from "./types.js";

/** spawn 흉내 — stdout/stderr/exit 를 테스트가 수동으로 발화. */
class FakeProc extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
}

function fakeAdapter(
  id: string,
  installHint: string | undefined,
  resolveBinary: () => string,
): AgentAdapter {
  return {
    id,
    displayName: `Fake ${id}`,
    installHint,
    resolveBinary,
    buildSpawnArgs: () => [],
    buildSpawnEnv: () => ({}),
    capabilities: () => [],
  };
}

function makeDeps(proc: FakeProc): InstallDeps {
  return {
    spawn: vi.fn(() => proc) as unknown as InstallDeps["spawn"],
    now: () => 1_000,
  };
}

describe("installHintIsCommand", () => {
  it("npm 명령은 true", () => {
    expect(installHintIsCommand("npm install -g @anthropic-ai/claude-code")).toBe(true);
    expect(installHintIsCommand("npm install -g @openai/codex")).toBe(true);
  });
  it("URL / 빈값 / nullish 는 false", () => {
    expect(installHintIsCommand("https://antigravity.google")).toBe(false);
    expect(installHintIsCommand("http://example.com")).toBe(false);
    expect(installHintIsCommand("")).toBe(false);
    expect(installHintIsCommand("   ")).toBe(false);
    expect(installHintIsCommand(undefined)).toBe(false);
    expect(installHintIsCommand(null)).toBe(false);
  });
});

describe("isHomebrewMissingFailure", () => {
  it("brew 명령 + 'command not found' → true", () => {
    expect(isHomebrewMissingFailure("brew install llama.cpp", "zsh: command not found: brew")).toBe(true);
  });
  it("brew 명령 + 'brew: not found' → true", () => {
    expect(isHomebrewMissingFailure("brew install llama.cpp", "sh: brew: not found")).toBe(true);
  });
  it("brew 명령이지만 다른 실패 로그 → false", () => {
    expect(isHomebrewMissingFailure("brew install llama.cpp", "Error: build failed")).toBe(false);
  });
  it("brew 명령이 아니면 (npm 등) not-found 여도 false", () => {
    expect(isHomebrewMissingFailure("npm install -g @qwen-code/qwen-code", "command not found: npm")).toBe(false);
  });
});

describe("isNodeMissingFailure", () => {
  it("npm 명령 + 'command not found: npm' (zsh 스타일) → true", () => {
    expect(isNodeMissingFailure("npm install -g @qwen-code/qwen-code", "zsh: command not found: npm")).toBe(true);
    expect(isNodeMissingFailure("npm install -g @anthropic-ai/claude-code", "zsh:1: command not found: npm")).toBe(true);
  });
  it("npm 명령 + 'npm: command not found' (sh 스타일) → true", () => {
    expect(isNodeMissingFailure("npm install -g @openai/codex", "/bin/sh: npm: command not found")).toBe(true);
  });
  it("node 명령 + 'command not found: node' → true", () => {
    expect(isNodeMissingFailure("node ./x.js", "zsh: command not found: node")).toBe(true);
  });
  it("npm 명령이지만 다른 실패 로그 → false (빌드 도중 다른 도구 not-found 오인 방지)", () => {
    expect(isNodeMissingFailure("npm install -g @qwen-code/qwen-code", "gyp: command not found: python")).toBe(false);
    expect(isNodeMissingFailure("npm install -g @qwen-code/qwen-code", "npm ERR! 403 Forbidden")).toBe(false);
  });
  it("npm/node 명령이 아니면 (brew 등) not-found 여도 false", () => {
    expect(isNodeMissingFailure("brew install llama.cpp", "command not found: brew")).toBe(false);
  });
});

describe("startAgentInstall", () => {
  beforeEach(() => {
    _resetInstallStateForTest();
  });

  it("클라이언트 id 만 받고 실행 명령은 adapter.installHint 상수 (셸 인젝션 표면 0)", () => {
    const proc = new FakeProc();
    const deps = makeDeps(proc);
    const adapter = fakeAdapter("claude_code", "npm install -g @anthropic-ai/claude-code", () => "/bin/claude");
    startAgentInstall(adapter, deps);
    expect(deps.spawn).toHaveBeenCalledWith(
      "zsh",
      ["-l", "-c", "npm install -g @anthropic-ai/claude-code"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
  });

  it("시작 직후 installing 스냅샷 + 로그 누적", () => {
    const proc = new FakeProc();
    const adapter = fakeAdapter("codex", "npm install -g @openai/codex", () => "/bin/codex");
    const started = startAgentInstall(adapter, makeDeps(proc));
    expect(started.state).toBe("installing");
    expect(started.adapterId).toBe("codex");
    expect(started.command).toBe("npm install -g @openai/codex");

    proc.stdout.emit("data", Buffer.from("downloading...\n"));
    proc.stderr.emit("data", "warn: x\n");
    expect(getAgentInstallProgress().log).toBe("downloading...\nwarn: x\n");
  });

  it("exit 0 + 재탐지 성공 → done/installed", () => {
    const proc = new FakeProc();
    const adapter = fakeAdapter("codex", "npm install -g @openai/codex", () => "/bin/codex");
    startAgentInstall(adapter, makeDeps(proc));
    proc.emit("exit", 0);
    const p = getAgentInstallProgress();
    expect(p.state).toBe("done");
    expect(p.installed).toBe(true);
    expect(p.exitCode).toBe(0);
    expect(p.error).toBeNull();
  });

  it("exit≠0 → error/nonzero_exit", () => {
    const proc = new FakeProc();
    const adapter = fakeAdapter("codex", "npm install -g @openai/codex", () => {
      throw new Error("not found");
    });
    startAgentInstall(adapter, makeDeps(proc));
    proc.emit("exit", 1);
    const p = getAgentInstallProgress();
    expect(p.state).toBe("error");
    expect(p.error).toBe("nonzero_exit");
    expect(p.exitCode).toBe(1);
    expect(p.installed).toBe(false);
  });

  it("exit 0 인데 바이너리 미탐지 → error/not_detected (PATH 문제 폴백)", () => {
    const proc = new FakeProc();
    const adapter = fakeAdapter("codex", "npm install -g @openai/codex", () => {
      throw new Error("still not found");
    });
    startAgentInstall(adapter, makeDeps(proc));
    proc.emit("exit", 0);
    const p = getAgentInstallProgress();
    expect(p.state).toBe("error");
    expect(p.error).toBe("not_detected");
    expect(p.installed).toBe(false);
  });

  it("같은 어댑터 중복 요청 = 합류 (spawn 1회, 멱등)", () => {
    const proc = new FakeProc();
    const deps = makeDeps(proc);
    const adapter = fakeAdapter("codex", "npm install -g @openai/codex", () => "/bin/codex");
    startAgentInstall(adapter, deps);
    const again = startAgentInstall(adapter, deps);
    expect(again.state).toBe("installing");
    expect(deps.spawn).toHaveBeenCalledTimes(1);
  });

  it("다른 어댑터가 설치 중이면 busy throw", () => {
    const proc = new FakeProc();
    const a = fakeAdapter("codex", "npm install -g @openai/codex", () => "/bin/codex");
    const b = fakeAdapter("claude_code", "npm install -g @anthropic-ai/claude-code", () => "/bin/claude");
    startAgentInstall(a, makeDeps(proc));
    expect(() => startAgentInstall(b, makeDeps(new FakeProc()))).toThrowError(/busy/);
  });

  it("URL hint 어댑터는 not_installable throw — 자동 설치 대상 아님 (GUI 설치형)", () => {
    // agy 는 이제 원라인 설치 명령을 쓰지만, 순수 URL hint 인 GUI 설치형 어댑터가 추가될 때를
    // 위해 «URL → not_installable» 게이트 자체를 회귀 차단한다.
    const adapter = fakeAdapter("gui_tool", "https://example.com/download", () => "/bin/gui");
    expect(() => startAgentInstall(adapter, makeDeps(new FakeProc()))).toThrowError(
      /not_installable/,
    );
  });

  it("설치 완료(done) 후 다른 어댑터 설치 시작 가능 (busy 아님)", () => {
    const procA = new FakeProc();
    const a = fakeAdapter("codex", "npm install -g @openai/codex", () => "/bin/codex");
    startAgentInstall(a, makeDeps(procA));
    procA.emit("exit", 0);
    expect(getAgentInstallProgress().state).toBe("done");

    const procB = new FakeProc();
    const b = fakeAdapter("claude_code", "npm install -g @anthropic-ai/claude-code", () => "/bin/claude");
    const started = startAgentInstall(b, makeDeps(procB));
    expect(started.state).toBe("installing");
    expect(started.adapterId).toBe("claude_code");
  });
});

describe("LOCAL_LLM_INSTALL_TARGETS (런타임 구성요소 whitelist)", () => {
  it("llama-server = brew install llama.cpp, qwen = npm -g @qwen-code", () => {
    expect(LOCAL_LLM_INSTALL_TARGETS["llama-server"].command).toBe("brew install llama.cpp");
    expect(LOCAL_LLM_INSTALL_TARGETS["llama-server"].id).toBe("local_llm/llama-server");
    expect(LOCAL_LLM_INSTALL_TARGETS["qwen"].command).toBe("npm install -g @qwen-code/qwen-code");
    expect(LOCAL_LLM_INSTALL_TARGETS["qwen"].id).toBe("local_llm/qwen");
  });

  it("getLocalLlmInstallTarget — 알려진 키만, 임의 키는 null (임의 명령 실행 차단)", () => {
    expect(getLocalLlmInstallTarget("llama-server")?.command).toBe("brew install llama.cpp");
    expect(getLocalLlmInstallTarget("qwen")?.command).toBe("npm install -g @qwen-code/qwen-code");
    expect(getLocalLlmInstallTarget("rm -rf /")).toBeNull();
    expect(getLocalLlmInstallTarget("")).toBeNull();
  });
});

describe("startInstall (구성요소 코어)", () => {
  beforeEach(() => {
    _resetInstallStateForTest();
  });

  function fakeTarget(id: string, command: string, resolveBinary: () => string): InstallTarget {
    return { id, command, resolveBinary };
  }

  it("component 명령은 상수 — zsh login shell 로 spawn (셸 인젝션 표면 0)", () => {
    const proc = new FakeProc();
    const deps = makeDeps(proc);
    const started = startInstall(LOCAL_LLM_INSTALL_TARGETS["llama-server"], deps);
    expect(started.adapterId).toBe("local_llm/llama-server");
    expect(deps.spawn).toHaveBeenCalledWith(
      "zsh",
      ["-l", "-c", "brew install llama.cpp"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
  });

  it("brew 미설치(exit 127, 'command not found: brew') → error/homebrew_missing (정확한 brew 안내 분기)", () => {
    const proc = new FakeProc();
    const target = fakeTarget("local_llm/llama-server", "brew install llama.cpp", () => {
      throw new Error("not found");
    });
    startInstall(target, makeDeps(proc));
    proc.stderr.emit("data", "zsh: command not found: brew\n");
    proc.emit("exit", 127);
    const p = getAgentInstallProgress();
    expect(p.state).toBe("error");
    expect(p.error).toBe("homebrew_missing");
    expect(p.exitCode).toBe(127);
  });

  it("brew 는 있는데 설치가 다른 이유로 실패(빌드 오류 등) → error/nonzero_exit (homebrew_missing 아님)", () => {
    const proc = new FakeProc();
    const target = fakeTarget("local_llm/llama-server", "brew install llama.cpp", () => {
      throw new Error("not found");
    });
    startInstall(target, makeDeps(proc));
    proc.stderr.emit("data", "Error: Failure while executing; `brew install` exited with 1.\n");
    proc.emit("exit", 1);
    const p = getAgentInstallProgress();
    expect(p.state).toBe("error");
    expect(p.error).toBe("nonzero_exit");
  });

  it("npm 미설치(exit 127, 'command not found: npm') → error/node_missing (정확한 Node.js 안내 분기)", () => {
    const proc = new FakeProc();
    const target = fakeTarget("local_llm/qwen", "npm install -g @qwen-code/qwen-code", () => {
      throw new Error("not found");
    });
    startInstall(target, makeDeps(proc));
    proc.stderr.emit("data", "zsh: command not found: npm\n");
    proc.emit("exit", 127);
    const p = getAgentInstallProgress();
    expect(p.state).toBe("error");
    expect(p.error).toBe("node_missing");
    expect(p.exitCode).toBe(127);
  });

  it("npm 은 있는데 설치가 다른 이유로 실패(403 등) → error/nonzero_exit (node_missing 아님)", () => {
    const proc = new FakeProc();
    const target = fakeTarget("local_llm/qwen", "npm install -g @qwen-code/qwen-code", () => {
      throw new Error("not found");
    });
    startInstall(target, makeDeps(proc));
    proc.stderr.emit("data", "npm ERR! code E403\n");
    proc.emit("exit", 1);
    const p = getAgentInstallProgress();
    expect(p.state).toBe("error");
    expect(p.error).toBe("nonzero_exit");
  });

  it("같은 구성요소 중복 = 합류(멱등), 다른 구성요소 = busy", () => {
    const proc = new FakeProc();
    const deps = makeDeps(proc);
    startInstall(LOCAL_LLM_INSTALL_TARGETS["qwen"], deps);
    const again = startInstall(LOCAL_LLM_INSTALL_TARGETS["qwen"], deps);
    expect(again.state).toBe("installing");
    expect(deps.spawn).toHaveBeenCalledTimes(1);
    expect(() =>
      startInstall(LOCAL_LLM_INSTALL_TARGETS["llama-server"], makeDeps(new FakeProc())),
    ).toThrowError(/busy/);
  });

  it("exit 0 + 재탐지 성공 → done/installed (status binariesReady 갱신 근거)", () => {
    const proc = new FakeProc();
    const target = fakeTarget("local_llm/qwen", "npm install -g @qwen-code/qwen-code", () => "/opt/homebrew/bin/qwen");
    startInstall(target, makeDeps(proc));
    proc.emit("exit", 0);
    const p = getAgentInstallProgress();
    expect(p.state).toBe("done");
    expect(p.installed).toBe(true);
  });
});
