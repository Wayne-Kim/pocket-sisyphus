/**
 * 검사 명령 실행기 — 반복/워크플로우의 «자기 판단(verdict.json)» 대신 사용자가 지정한 «검사
 * 명령»(테스트·린트·타입체크·빌드 등)의 «종료 코드» 로 pass/fail 을 결정한다.
 *
 * shell 어댑터(adapters/shell)와 동일한 로그인 셸(`$SHELL` 우선, 없으면 `/bin/zsh`, `-l`)을
 * 재사용해 PATH/aliases 가 잡힌 «터미널과 동일한» 환경에서 명령을 돌린다. 종료 코드 0 = pass,
 * 비0(또는 타임아웃/spawn 실패) = fail. 실패 시 출력의 «마지막 의미 있는 몇 줄» 을 사유로 뽑아
 * 다음 반복 프롬프트(priorFailure)·캔버스(loopback_reason)에 먹인다.
 *
 * 보안: cwd 는 호출자가 넘기는 (이미 unattended/worktree 격리된) repoPath 한 곳뿐 — 검사
 * 명령은 그 디렉터리에서만 돈다. 무한 매달림 방지를 위해 타임아웃 캡(SIGKILL)을 둔다.
 */
import { spawn } from "node:child_process";

/** 검사 명령 hard cap — 초과 시 SIGKILL + fail(timeout). 무인 경로가 영원히 매달리지 않게. */
export const CHECK_TIMEOUT_MS = 10 * 60 * 1000;
/** 캡처 출력 상한 — 메모리 폭증 방지(검사 도구가 폭주 출력해도 안전). */
const MAX_OUTPUT_BYTES = 256 * 1024;
/** 실패 사유로 뽑을 «마지막 의미 있는 줄» 기본 개수. */
const DEFAULT_REASON_LINES = 12;

export type CheckResult = {
  /** 종료 코드 0 이면서 타임아웃/오류가 아니면 true. */
  pass: boolean;
  /** 프로세스 종료 코드 (신호로 죽었거나 spawn 실패면 null). */
  exitCode: number | null;
  /** 타임아웃 캡으로 강제 종료됐는지. */
  timedOut: boolean;
  /** stdout+stderr 결합 캡처 (상한까지). */
  output: string;
};

/** shell 어댑터와 같은 셸 선택 규약 — `$SHELL` 우선, 없으면 macOS 디폴트 zsh. */
function shellBinary(): string {
  return process.env.SHELL || "/bin/zsh";
}

/**
 * 검사 명령을 로그인 셸로 실행하고 종료 코드·출력을 돌려준다. throw 하지 않는다 — spawn 실패도
 * fail(CheckResult)로 흡수해 호출부(엔진)가 항상 «판정» 을 받게 한다.
 */
export async function runCheckCommand(
  repoPath: string,
  command: string,
  opts: { timeoutMs?: number } = {},
): Promise<CheckResult> {
  const timeoutMs = opts.timeoutMs ?? CHECK_TIMEOUT_MS;
  return await new Promise<CheckResult>((resolve) => {
    let out = "";
    let bytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const append = (b: Buffer): void => {
      if (truncated) return;
      const remaining = MAX_OUTPUT_BYTES - bytes;
      if (remaining <= 0) {
        truncated = true;
        out += "\n…(출력 잘림)";
        return;
      }
      const chunk = b.length > remaining ? b.subarray(0, remaining) : b;
      bytes += chunk.length;
      out += chunk.toString("utf8");
    };

    let child;
    try {
      child = spawn(shellBinary(), ["-l", "-c", command], {
        cwd: repoPath,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      resolve({
        pass: false,
        exitCode: null,
        timedOut: false,
        output: `검사 명령을 실행하지 못했어요: ${(e as Error).message}`,
      });
      return;
    }

    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.on("data", append);
    child.stderr?.on("data", append);

    child.on("error", (e: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        pass: false,
        exitCode: null,
        timedOut,
        output: `${out}\n검사 명령 오류: ${e.message}`,
      });
    });

    child.on("close", (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ pass: !timedOut && code === 0, exitCode: code, timedOut, output: out });
    });
  });
}

/**
 * 실패 출력에서 «마지막 의미 있는 몇 줄» 을 뽑는다 — 빈 줄/우측 공백을 제거한 뒤 끝에서 n 줄.
 * 검사 도구(테스트·린트)의 실패 요약은 보통 출력 끝에 모여 있어, 이 꼬리가 «직전 실패 사유» 로
 * 가장 유용하다.
 */
export function lastMeaningfulLines(output: string, n: number = DEFAULT_REASON_LINES): string {
  const lines = output
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => l.trim().length > 0);
  return lines.slice(-Math.max(1, n)).join("\n");
}
