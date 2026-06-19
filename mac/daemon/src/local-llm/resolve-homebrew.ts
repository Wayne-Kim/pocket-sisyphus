/**
 * Homebrew(`brew`) 절대경로 탐지.
 *
 * resolve-llama-server.ts 의 knownCandidates 패턴을 본떴다 — Deps 주입으로 unit test 가
 * fs/execSync 를 가로챈다. llama-server 와 달리 «탐지 only»: brew 는 우리가 spawn 하는
 * 대상이 아니라, 그게 있어야 `brew install llama.cpp` 가 가능한 선행 조건이다.
 *
 * # 왜 login-shell PATH 를 «먼저» 보나
 *
 * Apple Silicon 에서 brew 가 설치돼 있어도 GUI 앱이 물려받는 PATH 에 /opt/homebrew/bin 이
 * 없으면 `command -v brew` 가 실패한다. 사용자가 .zprofile 등에서 `brew shellenv` 로 PATH 를
 * 잡았다면 login shell(`zsh -l`) 은 그걸 본다 — 그래서 ① login-shell PATH 를 먼저 확인하고,
 * 못 잡으면 ② Apple Silicon · ③ Intel 의 기본 prefix 절대경로로 폴백한다. 첫 적중 경로를
 * 반환하고 아무 데도 없으면 null.
 */

import fs from "node:fs";
import { execSync as nodeExecSync } from "node:child_process";

export interface HomebrewDeps {
  /** 경로가 실행 가능한 파일인지 (`test -x`). brew 는 «실행되는» 바이너리라 존재만으론 부족. */
  isExecutable: (p: string) => boolean;
  execSync: (cmd: string) => string;
}

export const defaultHomebrewDeps: HomebrewDeps = {
  isExecutable: (p) => {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
  execSync: (cmd) =>
    nodeExecSync(cmd, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }),
};

/** brew 의 잘 알려진 prefix — Apple Silicon(/opt/homebrew) → Intel(/usr/local) 순. */
export function brewCandidates(): string[] {
  return ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"];
}

/**
 * brew 절대경로를 찾으면 반환, 못 찾으면 null (status binaries.homebrew 합성용).
 * ① login-shell PATH(`command -v brew`) → ② /opt/homebrew/bin/brew → ③ /usr/local/bin/brew.
 */
export function detectHomebrew(deps: HomebrewDeps = defaultHomebrewDeps): string | null {
  // ① login shell PATH — 사용자가 brew shellenv 로 PATH 를 잡았으면 GUI PATH 누락을 우회.
  try {
    const out = deps.execSync("zsh -l -c 'command -v brew'").trim();
    if (out && deps.isExecutable(out)) return out;
  } catch {
    // zsh 없거나 PATH 에 brew 없거나 — fall through.
  }
  // ② / ③ 기본 prefix 절대경로 — PATH 가 비어도 설치돼 있으면 잡힌다.
  for (const c of brewCandidates()) {
    if (deps.isExecutable(c)) return c;
  }
  return null;
}
