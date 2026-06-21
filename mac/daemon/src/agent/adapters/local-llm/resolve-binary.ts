/**
 * 사용자 시스템의 `qwen` CLI (Qwen Code) 절대경로를 해석한다.
 *
 * claude-code/resolve-binary.ts 와 같은 패턴 — 잘 알려진 설치 위치 순차 탐색 후
 * 마지막 수단으로 login-shell PATH (`zsh -l -c 'command -v qwen'`). Deps 주입으로
 * unit test 가 fs/execSync 를 가로챈다.
 *
 * qwen 은 npm i -g @qwen-code/qwen-code 로 설치되며 Homebrew node 환경에선
 * /opt/homebrew/bin/qwen 이 기본 결과.
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
    "/opt/homebrew/bin/qwen",
    `${home}/.local/bin/qwen`,
    "/usr/local/bin/qwen",
  ];
}

export function resolveQwenBinary(
  deps: ResolveDeps = defaultResolveDeps,
): string {
  for (const c of knownCandidates(deps.home)) {
    if (c && deps.existsSync(c)) return c;
  }
  try {
    const out = deps.execSync("zsh -l -c 'command -v qwen'").trim();
    if (out && deps.existsSync(out)) return out;
  } catch {
    // zsh 없거나 PATH 에 없거나 — fall through.
  }
  throw new Error(
    "qwen CLI 를 찾을 수 없습니다. 설치: `npm install -g @qwen-code/qwen-code` " +
      "(Mac 앱 설정 → 로컬 LLM 탭의 설치 안내 참고)",
  );
}
