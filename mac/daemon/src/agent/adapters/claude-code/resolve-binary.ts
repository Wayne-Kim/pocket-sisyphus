/**
 * 사용자 시스템의 `claude` CLI 절대경로를 해석한다.
 *
 * # 왜 이게 별도 모듈인가
 *
 * 이전 코드는 옛 SDK 의 `@anthropic-ai/claude-agent-sdk-darwin-arm64/claude` 번들 binary
 * 를 찾았다. SDK 의존성이 PTY-only 마이그레이션 시점에 package.json 에서 제거되면서 그
 * 경로는 영구히 사라졌지만 spawn 코드는 안 따라와 PTY runner 가 «bundled claude not
 * found» 로 실패했다. 그 실패가 console.error 한 줄로만 stderr 에 떨어지고 HTTP 는 이미
 * `{ok: true}` 응답을 보낸 뒤라 사용자는 영문 없이 빈 터미널을 보는 조용한 실패가 됐다.
 *
 * 재발 방지: 이 모듈을 별도 파일로 두고 unit test 로 모든 분기를 mocked fs/execSync 로
 * 검증한다. CI 가 매 커밋마다 돈다.
 *
 * # 동작
 *
 * 1. 잘 알려진 설치 위치를 순차 탐색 (npm i -g 의 기본 결과 + Homebrew + manual install):
 *   - ~/.local/bin/claude
 *   - /opt/homebrew/bin/claude
 *   - /usr/local/bin/claude
 *   - ~/.claude/local/claude
 *
 * 2. 마지막 수단: `zsh -l -c 'command -v claude'` — login-shell PATH 까지 읽어
 *    사용자가 비표준 위치에 깔아도 잡아낸다.
 *
 * 3. 모두 실패 시 명확한 메시지로 throw — fast-fail 로 조용한 실패를 피한다.
 */

import fs from "node:fs";
import { execSync as nodeExecSync } from "node:child_process";

/**
 * Deps 가 외부 주입 가능해서 unit test 가 fs / execSync 호출을 가로챌 수 있다.
 * 운영 코드는 `resolveClaudeBinary()` (no args) 로 호출 → 기본 deps 사용.
 */
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
    `${home}/.local/bin/claude`,
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    `${home}/.claude/local/claude`,
  ];
}

export function resolveClaudeBinary(
  deps: ResolveDeps = defaultResolveDeps,
): string {
  for (const c of knownCandidates(deps.home)) {
    if (c && deps.existsSync(c)) return c;
  }
  // 마지막 수단: login-shell PATH 까지 보는 `command -v claude`.
  try {
    const out = deps.execSync("zsh -l -c 'command -v claude'").trim();
    if (out && deps.existsSync(out)) return out;
  } catch {
    // zsh 없거나 PATH 에 없거나 — fall through.
  }
  throw new Error(
    "claude CLI 를 찾을 수 없습니다. ~/.local/bin/claude 또는 /opt/homebrew/bin/claude " +
      "에 설치되어 있어야 합니다. 설치: `npm install -g @anthropic-ai/claude-code`",
  );
}
