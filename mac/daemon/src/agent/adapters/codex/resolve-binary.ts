/**
 * 사용자 시스템의 `codex` CLI (OpenAI Codex) 절대경로를 해석한다.
 *
 * 우선순위:
 *   1. /opt/homebrew/bin/codex   (npm i -g + Homebrew node, Apple Silicon 기본)
 *   2. /usr/local/bin/codex      (Intel mac / 옛 npm prefix)
 *   3. ~/.local/bin/codex        (수동 설치 케이스)
 *   4. `zsh -l -c 'command -v codex'` — login-shell PATH 까지 탐색
 *
 * 모두 실패 시 사용자 친화 메시지로 throw — 부팅 self-check 와 첫 spawn 양쪽에서 동일
 * 메시지로 안내된다.
 *
 * agy / claude 의 resolve-binary 와 같은 deps 주입 패턴을 따라 fs/execSync 를 mock 가능하게
 * 둔다 (단위 테스트 용).
 */

import fs from "node:fs";
import { execSync as nodeExecSync } from "node:child_process";

export interface ResolveDeps {
  existsSync: (p: string) => boolean;
  execSync: (cmd: string) => string;
  home: string;
}

export const defaultResolveDeps: ResolveDeps = {
  existsSync: fs.existsSync,
  execSync: (cmd) =>
    nodeExecSync(cmd, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }),
  home: process.env.HOME ?? "",
};

export function knownCandidates(home: string): string[] {
  return [
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
    `${home}/.local/bin/codex`,
  ];
}

export function resolveCodexBinary(
  deps: ResolveDeps = defaultResolveDeps,
): string {
  for (const c of knownCandidates(deps.home)) {
    if (c && deps.existsSync(c)) return c;
  }
  try {
    const out = deps.execSync("zsh -l -c 'command -v codex'").trim();
    if (out && deps.existsSync(out)) return out;
  } catch {
    // zsh 없거나 PATH 에 없거나 — fall through.
  }
  throw new Error(
    "codex CLI 를 찾을 수 없습니다. /opt/homebrew/bin/codex 또는 /usr/local/bin/codex 에 " +
      "설치되어 있어야 합니다. 설치: `npm install -g @openai/codex`",
  );
}
