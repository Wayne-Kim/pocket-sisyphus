/**
 * 터미널(쉘 스크립트) 예약의 보조 함수 — 라우트(생성 검증)와 executor(실행) 둘 다 쓴다.
 *
 * 터미널 예약 = «쉘 스크립트 파일 1개» 를 정해진 시각에 인터프리터로 한 번 실행. 에이전트
 * 예약과 달리 프롬프트가 아니라 «파일 경로» 를 받고, 어떤 셸(zsh/bash/sh)로 돌릴지 고른다.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** 고를 수 있는 인터프리터. iOS picker 와 daemon 검증이 같은 목록을 공유한다. */
export const TERMINAL_SHELLS = ["zsh", "bash", "sh"] as const;
export type TerminalShell = (typeof TERMINAL_SHELLS)[number];

/** 알려진 셸의 절대경로. macOS 에 항상 있는 위치. */
const SHELL_BINARIES: Record<TerminalShell, string> = {
  zsh: "/bin/zsh",
  bash: "/bin/bash",
  sh: "/bin/sh",
};

/** 사용자가 보낸 shell 값을 화이트리스트로 정규화. 모르면 null (→ 기본 셸 사용). */
export function normalizeShell(v: unknown): TerminalShell | null {
  return typeof v === "string" && (TERMINAL_SHELLS as readonly string[]).includes(v)
    ? (v as TerminalShell)
    : null;
}

/**
 * 인터프리터 → 실행 바이너리 절대경로. null/모르는 값이면 shell 어댑터와 같은 규칙으로
 * 사용자 기본 셸($SHELL), 없으면 /bin/zsh (macOS 디폴트). launchd 로 띄워진 daemon 은
 * $SHELL 이 비어있을 수 있어 fallback 이 실질 디폴트.
 */
export function resolveShellBinary(shell: string | null): string {
  const norm = normalizeShell(shell);
  if (norm) return SHELL_BINARIES[norm];
  return process.env.SHELL ?? "/bin/zsh";
}

/**
 * 스크립트 파일 경로를 정규화·검증한다. resolveAndEnsureRepoDir 의 «파일판» — ~ 확장 +
 * 절대경로 강제 + «실제로 존재하는 파일» 확인. 디렉터리는 거부. throw 하지 않고 사용자에게
 * 보여줄 한국어 메시지로 에러를 반환 (라우트는 400, executor 는 earlyError 로 변환).
 *
 * 실행 가능 비트(+x)는 요구하지 않는다 — `zsh -l script.sh` 처럼 인터프리터에 파일을 넘겨
 * 돌리므로 스크립트 자체가 executable 일 필요는 없다.
 */
export function resolveScriptFile(input: string): { path: string } | { error: string } {
  let p = input.trim();
  if (p === "~" || p.startsWith("~/")) {
    p = path.join(os.homedir(), p.slice(1));
  }
  if (!path.isAbsolute(p)) {
    return { error: String("스크립트는 절대 경로로 지정해 주세요 (예: /Users/<나>/scripts/backup.sh).") };
  }
  p = path.resolve(p);
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) {
      return { error: `이 경로는 파일이 아니에요: ${p}` };
    }
    return { path: p };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { error: `스크립트 파일을 찾을 수 없어요: ${p}` };
    }
    return { error: `스크립트를 확인할 수 없어요: ${(e as Error).message}` };
  }
}

/**
 * 인터프리터 인자. `<shell> -l <script>` — login 셸로 띄워 ~/.zprofile·~/.bash_profile 의
 * PATH/환경을 로드한 뒤 스크립트를 한 번 돌리고 종료한다. launchd daemon 의 빈약한 PATH 가
 * 아니라 «Terminal.app 에서 직접 친 것» 과 같은 환경에서 돌게 하려는 것 (brew·node 등 경로).
 */
export function buildScriptSpawnArgs(scriptPath: string): string[] {
  return ["-l", scriptPath];
}
