/**
 * `llama-server` (llama.cpp) 절대경로 해석.
 *
 * agent/adapters/local-llm/resolve-binary.ts (qwen 해석) 와 같은 패턴 — 잘 알려진 설치
 * 위치 순차 탐색 후 마지막 수단으로 login-shell PATH. Deps 주입으로 unit test 가
 * fs/execSync 를 가로챈다. PATH 해석 only (번들 아님); dev override 는 env.
 *
 * llama.cpp 는 `brew install llama.cpp` 로 설치되며 Homebrew 환경에선
 * /opt/homebrew/bin/llama-server 가 기본 결과.
 */

import fs from "node:fs";
import { execSync as nodeExecSync } from "node:child_process";

export interface ResolveDeps {
  existsSync: (p: string) => boolean;
  execSync: (cmd: string) => string;
  /** dev override — 설정 시 최우선. (tor/sshd 가 번들 경로 env 를 받는 것과 일관) */
  envOverride: string | undefined;
}

export const defaultResolveDeps: ResolveDeps = {
  existsSync: fs.existsSync,
  execSync: (cmd) =>
    nodeExecSync(cmd, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }),
  envOverride: process.env.POCKET_CLAUDE_LLAMA_SERVER_BIN,
};

/** 잘 알려진 설치 위치들 — 우선순위 순. */
export function knownCandidates(): string[] {
  return [
    "/opt/homebrew/bin/llama-server",
    "/usr/local/bin/llama-server",
  ];
}

/** throw 없이 경로를 찾으면 반환, 못 찾으면 null (status/binary-presence 체크용). */
export function findLlamaServerBinary(
  deps: ResolveDeps = defaultResolveDeps,
): string | null {
  if (deps.envOverride && deps.existsSync(deps.envOverride)) return deps.envOverride;
  for (const c of knownCandidates()) {
    if (deps.existsSync(c)) return c;
  }
  try {
    const out = deps.execSync("zsh -l -c 'command -v llama-server'").trim();
    if (out && deps.existsSync(out)) return out;
  } catch {
    // zsh 없거나 PATH 에 없거나 — fall through.
  }
  return null;
}

export function resolveLlamaServerBinary(
  deps: ResolveDeps = defaultResolveDeps,
): string {
  const found = findLlamaServerBinary(deps);
  if (found) return found;
  throw new Error(
    "llama-server (llama.cpp) 를 찾을 수 없습니다. 설치: `brew install llama.cpp` " +
      "(Mac 앱 설정 → 로컬 LLM 탭의 설치 안내 참고)",
  );
}
