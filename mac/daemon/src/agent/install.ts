/**
 * 코드 에이전트 CLI 의 «어댑터별 설치» 단일 실행기.
 *
 * # 왜 daemon 이 설치를 대신 하나
 *
 * 폰만 든 사용자가 새 세션에서 고른 CLI (claude_code / codex …) 가 Mac 에 없으면 옛 흐름은
 * 「Mac 책상으로 가서 직접 설치하라」 는 막다른 길이었다. daemon 은 어댑터마다 installHint
 * (`npm install -g …`) 상수를 이미 들고 CLI 를 직접 spawn 하는 주체이므로, 그 명령을 daemon
 * 이 실행해 주면 폰을 떠나지 않고 막힘을 푼다.
 *
 * # 보안 경계 (중요)
 *
 * - **클라이언트가 보낸 임의 문자열은 절대 실행하지 않는다.** 호출자는 어댑터 id 만 보내고,
 *   실행되는 명령은 오직 registry 에 박힌 adapter.installHint **상수** 다 (어댑터 id → 상수
 *   매핑). 셸 인젝션 표면 0 — 명령은 우리 소스의 리터럴이다.
 * - **URL hint (agy 의 https://…) 는 «실행 가능한 명령» 이 아니라 자동 설치 대상에서 제외**
 *   한다 (`installHintIsCommand`). GUI 설치형은 비-목표.
 *
 * # 동작
 *
 * 1. login shell (`zsh -l -c '<installHint>'`) 로 spawn — npm/node 가 사용자 PATH 에만
 *    있어도 잡힌다 (resolve-binary 의 `command -v` fallback 과 같은 이유).
 * 2. stdout/stderr 를 말미 LOG_MAX 바이트만 누적해 폰이 폴링으로 본다.
 * 3. exit code 로 성공/실패 판정 + 즉시 adapter.resolveBinary() 로 재탐지 → `installed`.
 *    code 0 이어도 바이너리가 안 잡히면 (PATH 문제 등) error 로 본다.
 * 4. 동시 중복 요청은 단일화 — 같은 어댑터면 진행 중인 job 에 합류(멱등), 다른 어댑터면
 *    409 `busy`.
 *
 * # 코드 에이전트 CLI 외 — local_llm 런타임 구성요소
 *
 * 같은 «막다른 길 제거» 패턴을 local_llm 의 두 런타임 바이너리에도 쓴다: 추론 서버
 * (llama.cpp → `brew install llama.cpp`) 와 에이전트 CLI (qwen → `npm install …`).
 * 이들은 어댑터가 아니라 «구성요소» 라 `LOCAL_LLM_INSTALL_TARGETS` 상수 whitelist 에
 * component → (상수 명령 + 재탐지) 로 박아 둔다. 라우트가 component 파라미터로 고르고,
 * 실행 명령은 여전히 우리 소스의 리터럴 상수 (클라이언트 입력 아님 — 셸 인젝션 표면 0).
 */

import { spawn as childSpawn, type ChildProcess } from "node:child_process";
import type { AgentAdapter } from "./types.js";
import { resolveLlamaServerBinary } from "../local-llm/resolve-llama-server.js";
import { resolveQwenBinary } from "./adapters/local-llm/resolve-binary.js";

export type AgentInstallState = "idle" | "installing" | "done" | "error";

/** 폰이 폴링으로 읽는 설치 진행 스냅샷. */
export type AgentInstallProgress = {
  /** 설치 중/했던 어댑터 id. idle 이면 null. */
  adapterId: string | null;
  state: AgentInstallState;
  /** 실행 중/했던 설치 명령 (코드성 상수). 실패 시 폰이 복사용 폴백으로 노출. */
  command: string | null;
  /** 누적 stdout+stderr (말미 LOG_MAX 바이트). */
  log: string;
  /** 프로세스 종료 코드. 진행 중/ spawn 실패면 null. */
  exitCode: number | null;
  /**
   * 실패 사유 코드 (사람용 매핑은 iOS/Mac):
   * "spawn_failed" | "nonzero_exit" | "not_detected" | "homebrew_missing" | "node_missing" | null.
   * "homebrew_missing" 은 brew 명령이 brew 자체를 못 찾아 실패한 경우 — 일반 「설치 실패」 가
   * 아니라 Homebrew 설치 안내로 분기하라는 신호. "node_missing" 은 npm/node 기반 설치 명령이
   * npm(또는 node) 자체를 못 찾아 실패한 경우 — Node.js 설치 안내로 분기하라는 신호.
   */
  error: string | null;
  /** 설치 직후 재탐지 결과 — resolveBinary 성공 여부. */
  installed: boolean;
  /** 시작 시각 (epoch ms). */
  startedAt: number | null;
};

/** stdout/stderr 누적 상한 — Tor 폴링으로 통째 실어 나르므로 말미만 유지. */
const LOG_MAX = 16 * 1024;

/** install.ts 가 외부에 의존하는 부분 — 단위 테스트가 spawn/clock 을 가로챈다. */
export interface InstallDeps {
  spawn: typeof childSpawn;
  now: () => number;
}

export const defaultInstallDeps: InstallDeps = {
  spawn: childSpawn,
  now: () => Date.now(),
};

const IDLE: AgentInstallProgress = {
  adapterId: null,
  state: "idle",
  command: null,
  log: "",
  exitCode: null,
  error: null,
  installed: false,
  startedAt: null,
};

let progress: AgentInstallProgress = { ...IDLE };
let active: ChildProcess | null = null;

/**
 * installHint 가 «실행 가능한 셸 명령» 인지 — URL (agy 의 https://…) 이거나 비어 있으면 false.
 * 자동 설치 게이트의 단일 판정. iOS 도 같은 규칙으로 버튼/링크를 분기한다.
 */
export function installHintIsCommand(hint?: string | null): boolean {
  if (!hint) return false;
  const t = hint.trim();
  if (t.length === 0) return false;
  return !/^https?:\/\//i.test(t);
}

/**
 * 설치 실행기가 다루는 «설치 대상» — 코드 에이전트 어댑터든 local_llm 런타임 구성요소든
 * 같은 spawn/재탐지 코어를 공유한다.
 *  - id: 진행 스냅샷의 `adapterId` 자리에 들어가는 식별자 (어댑터면 adapter.id, 구성요소면
 *    `local_llm/<component>`). 폰/Mac 이 «무엇이 설치 중인지» 를 이 값으로 매칭한다.
 *  - command: 실행할 설치 명령 — 우리 소스의 리터럴 상수 (클라이언트 입력 아님).
 *  - resolveBinary: 설치 직후 재탐지. 성공하면 경로 반환, 못 찾으면 throw.
 */
export type InstallTarget = {
  id: string;
  command: string;
  resolveBinary: () => string;
};

/**
 * local_llm 런타임 구성요소 설치 whitelist — component 키 → 상수 명령 + 재탐지.
 *
 * 임의 셸 명령을 절대 실행하지 않는다는 안전 모델을 유지: 클라이언트는 component 키만
 * 보내고, 실행되는 명령은 여기 박힌 리터럴 상수다. 새 구성요소는 이 표에 한 줄 추가.
 */
export const LOCAL_LLM_INSTALL_TARGETS: Record<string, InstallTarget> = {
  "llama-server": {
    id: "local_llm/llama-server",
    command: "brew install llama.cpp",
    resolveBinary: () => resolveLlamaServerBinary(),
  },
  qwen: {
    id: "local_llm/qwen",
    // claude-code/codex 와 동일 메커니즘(npm -g) — 기존 설치 경로 재사용.
    command: "npm install -g @qwen-code/qwen-code",
    resolveBinary: () => resolveQwenBinary(),
  },
};

/** component 키로 local_llm 설치 대상을 찾는다. 알 수 없는 키면 null (라우트가 400). */
export function getLocalLlmInstallTarget(component: string): InstallTarget | null {
  return LOCAL_LLM_INSTALL_TARGETS[component] ?? null;
}

/**
 * brew 설치 명령이 «brew 자체를 못 찾아» 실패했는지 — Apple Silicon 의 전형적 막다른 길
 * (PATH 에 /opt/homebrew/bin 누락). 명령이 brew 명령일 때만, 로그에 'command not found' /
 * 'brew: not found' 패턴이 보이면 true. (npm 등 다른 명령의 not-found 를 brew 로 오인하지
 * 않도록 brew 명령으로 한정.)
 *
 * 이게 잡히면 install 실패 코드가 "homebrew_missing" 으로 세분화돼, iOS/Mac 이 일반 「설치
 * 실패」 대신 정확한 Homebrew 설치 안내로 분기한다.
 */
export function isHomebrewMissingFailure(command: string, log: string): boolean {
  if (!/(^|\s)brew(\s|$)/.test(command)) return false;
  return /command not found/i.test(log) || /brew:\s*(command\s+)?not found/i.test(log);
}

/**
 * npm/node 기반 설치 명령이 «npm(또는 node) 자체를 못 찾아» 실패했는지 — Node.js 미설치의
 * 전형적 막다른 길 (`zsh: command not found: npm`). npm/npx/node 명령일 때만, 로그에
 * 'command not found: npm' / 'npm: not found' (npx/node 포함) 패턴이 보이면 true.
 *
 * brew 와 달리 일반 'command not found' 로 폭넓게 잡지 않고 npm/npx/node 바이너리로 한정한다 —
 * `npm install` 은 빌드 도중 다른 도구의 not-found 를 흘릴 수 있어(node-gyp 등) 오인 위험이 크다.
 *
 * 이게 잡히면 install 실패 코드가 "node_missing" 으로 세분화돼, iOS/Mac 이 일반 「설치 실패」
 * 대신 정확한 Node.js 설치 안내로 분기한다.
 */
export function isNodeMissingFailure(command: string, log: string): boolean {
  if (!/(^|\s)(npm|npx|node)(\s|$)/.test(command)) return false;
  return (
    /command not found:\s*(npm|npx|node)\b/i.test(log) ||
    /\b(npm|npx|node):\s*(command\s+)?not found/i.test(log)
  );
}

export function getAgentInstallProgress(): AgentInstallProgress {
  return { ...progress };
}

function appendLog(chunk: string): void {
  progress.log = (progress.log + chunk).slice(-LOG_MAX);
}

/**
 * 설치 대상 하나를 시작한다 (또는 진행 중이면 합류) — 어댑터/구성요소 공용 코어.
 *
 * - 다른 대상이 설치 중이면 `busy` throw — 라우트가 409.
 * - 같은 대상이 이미 설치 중이면 현재 진행 스냅샷을 그대로 반환 (멱등 — 중복 spawn 안 함).
 *
 * 반환은 시작 시점 스냅샷. 이후 진행은 getAgentInstallProgress() 폴링으로 읽는다.
 */
export function startInstall(
  target: InstallTarget,
  deps: InstallDeps = defaultInstallDeps,
): AgentInstallProgress {
  if (progress.state === "installing") {
    if (progress.adapterId === target.id) {
      return { ...progress }; // 합류 — 같은 대상 중복 요청은 기존 진행에 흡수.
    }
    throw new Error("busy");
  }

  progress = {
    adapterId: target.id,
    state: "installing",
    command: target.command,
    log: "",
    exitCode: null,
    error: null,
    installed: false,
    startedAt: deps.now(),
  };

  // login shell 경유 — npm/node/brew 가 사용자 PATH(.zprofile 등)에만 있어도 잡힌다. command
  // 는 우리 소스의 리터럴 상수라 셸 인젝션 표면이 없다 (클라이언트 입력이 아님).
  let proc: ChildProcess;
  try {
    proc = deps.spawn("zsh", ["-l", "-c", target.command], {
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    progress = {
      ...progress,
      state: "error",
      error: "spawn_failed",
    };
    appendLog(`[spawn error] ${(e as Error).message}\n`);
    return { ...progress };
  }
  active = proc;

  proc.stdout?.on("data", (d: Buffer | string) => appendLog(d.toString()));
  proc.stderr?.on("data", (d: Buffer | string) => appendLog(d.toString()));

  proc.on("error", (e: Error) => {
    active = null;
    appendLog(`[spawn error] ${e.message}\n`);
    progress = { ...progress, state: "error", error: "spawn_failed" };
  });

  proc.on("exit", (code: number | null) => {
    active = null;
    // 즉시 재탐지 — resolve-binary 는 캐시가 없어 새로 설치된 바이너리를 바로 잡는다.
    // code 0 이어도 PATH/권한 문제로 바이너리가 안 보이면 「설치 안 됨」 으로 본다.
    let installed = false;
    try {
      target.resolveBinary();
      installed = true;
    } catch {
      installed = false;
    }
    if (code === 0 && installed) {
      progress = { ...progress, state: "done", exitCode: 0, error: null, installed: true };
    } else {
      // 비정상 종료 중 brew/npm 미탐지면 nonzero_exit 보다 한 단계 세분화 — 정확한 설치 안내로 분기.
      const cmd = progress.command ?? "";
      const homebrewMissing = code !== 0 && isHomebrewMissingFailure(cmd, progress.log);
      const nodeMissing = code !== 0 && !homebrewMissing && isNodeMissingFailure(cmd, progress.log);
      progress = {
        ...progress,
        state: "error",
        exitCode: code,
        error:
          code === 0
            ? "not_detected"
            : homebrewMissing
              ? "homebrew_missing"
              : nodeMissing
                ? "node_missing"
                : "nonzero_exit",
        installed,
      };
    }
  });

  return { ...progress };
}

/**
 * 어댑터 설치를 시작한다 (또는 진행 중이면 합류).
 *
 * - installHint 가 명령이 아니면 (URL/빈값) `not_installable` throw — 라우트가 400.
 * - 그 외는 startInstall 코어와 동일 (busy / 합류 / 재탐지).
 */
export function startAgentInstall(
  adapter: AgentAdapter,
  deps: InstallDeps = defaultInstallDeps,
): AgentInstallProgress {
  const hint = adapter.installHint ?? "";
  if (!installHintIsCommand(hint)) {
    throw new Error("not_installable");
  }
  return startInstall(
    { id: adapter.id, command: hint, resolveBinary: () => adapter.resolveBinary() },
    deps,
  );
}

/** 테스트 전용 — 모듈 상태를 idle 로 되돌린다. 운영 코드에서 호출 금지. */
export function _resetInstallStateForTest(): void {
  active = null;
  progress = { ...IDLE };
}
