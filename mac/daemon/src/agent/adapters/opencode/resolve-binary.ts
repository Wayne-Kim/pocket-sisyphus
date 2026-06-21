/**
 * 사용자 시스템의 `opencode` CLI 절대경로를 해석한다.
 *
 * local-llm/resolve-binary.ts (qwen) 와 같은 패턴 — 잘 알려진 설치 위치 순차 탐색 후
 * 마지막 수단으로 login-shell PATH (`zsh -l -c 'command -v opencode'`). Deps 주입으로
 * unit test 가 fs/execSync 를 가로챈다.
 *
 * opencode 는 npm i -g opencode-ai 로 설치되며 Homebrew node 환경에선
 * /opt/homebrew/bin/opencode 가 기본 결과. 공식 curl 설치 스크립트는
 * ~/.opencode/bin/opencode 에 떨군다.
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

/** 잘 알려진 설치 위치들 — 우선순위 순. */
export function knownCandidates(home: string): string[] {
  return [
    "/opt/homebrew/bin/opencode",
    `${home}/.opencode/bin/opencode`,
    `${home}/.local/bin/opencode`,
    "/usr/local/bin/opencode",
  ];
}

export function resolveOpencodeBinary(
  deps: ResolveDeps = defaultResolveDeps,
): string {
  for (const c of knownCandidates(deps.home)) {
    if (c && deps.existsSync(c)) return c;
  }
  try {
    const out = deps.execSync("zsh -l -c 'command -v opencode'").trim();
    if (out && deps.existsSync(out)) return out;
  } catch {
    // zsh 없거나 PATH 에 없거나 — fall through.
  }
  throw new Error(
    "opencode CLI 를 찾을 수 없습니다. 설치: `npm install -g opencode-ai` " +
      "(Mac 앱 도구 선택의 설치 안내 참고)",
  );
}
