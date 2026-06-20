// PO 루프 — 수집 «GitHub 신호» 가용성 점검 (po_gh_check_v1).
//
// 배경: 수집 프롬프트(prompt.ts)의 1단계는 «`gh` CLI 가 있고 이 레포가 GitHub 원격이면»
// 열린 이슈·discussions 를 읽는다. 그런데 `gh` 는 macOS 기본 포함이 아니라 brew 설치가
// 필요하고, launchd 가 띄운 GUI 앱의 PATH 엔 /opt/homebrew/bin 이 없는 경우가 흔하다 —
// 그러면 GitHub 분기가 «조용히» 0건을 내고, 사용자는 그 사실을 모른 채 «제안 품질이 낮네»
// 라고만 느낀다 (신뢰를 갉아먹는다). 이 모듈은 수집 직전 그 가용성을 점검해 결과 메타로
// iOS 에 전달한다 — iOS 가 안내 톤으로 «GitHub 신호 없이 수집됨, gh 설치/로그인하면 더 좋은
// 브리프» 를 띄울 수 있도록.
//
// 실행 컨텍스트: execFile 은 daemon process.env(PATH 포함)를 그대로 상속한다 — 수집 PTY 도
// 같은 process.env 를 상속하므로(pty-runner.ts), 이 점검은 «수집 에이전트가 실제로 gh 를
// 찾을 수 있는가» 와 같은 PATH 를 본다. 즉 여기서 not-installed 면 수집의 GitHub 분기도 0건.
//
// 불확실할 땐 조용히: 타임아웃 등 «점검 자체의 실패» 는 null 로 돌려 iOS 가 거짓 경고를 띄우지
// 않게 한다 (command-not-found 같은 «확정 음성» 만 installed:false 로 전한다).

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * 수집의 GitHub 신호 가용성 점검 결과. iOS 는 이 셋을 보고 안내를 띄울지 결정한다:
 * `githubRemote && (!installed || !authed)` 일 때만 (정상이면 아무 UI 도 안 뜬다).
 */
export type GhCollectCheck = {
  /** 이 레포가 GitHub 원격을 가지는가 — false 면 gh 가 있어도 GitHub 신호가 무의미. */
  githubRemote: boolean;
  /** `gh --version` 이 exit 0 (설치/실행 가능). PATH 에 없으면(ENOENT) false. */
  installed: boolean;
  /** `gh auth status` 가 exit 0 (로그인됨). 미설치면 무의미한 false. */
  authed: boolean;
  /**
   * 점검 대상이 «피드백 repo» 였으면 그 식별자(owner/name). 로컬 origin 점검이면 생략.
   * iOS 가 안내 배너 문구를 «로컬 origin» vs «피드백 repo» 로 분기하는 read-only 정보.
   */
  feedbackRepo?: string;
  /**
   * 피드백 repo 점검 시에만 의미 — `gh repo view <repo>` 가 exit 0 (그 계정으로 실제 읽힘).
   * false = repo 가 없거나 private 인데 권한 없음(거짓 «로그인 필요» 가 아니라 «접근 불가»).
   * 로컬 origin 점검이면 생략.
   */
  feedbackRepoAccessible?: boolean;
};

/** `git remote -v` 출력에 GitHub 원격이 있는가 — http(s)/ssh 형태 모두 github.com 매칭. */
export function hasGithubRemote(remoteOutput: string): boolean {
  return /github\.com/i.test(remoteOutput);
}

/**
 * 프로브 한 건의 판정. execFile 은 실패를 throw 한다:
 * - exit 0 → "ok"
 * - ENOENT(미설치) / 비-0 exit(미인증·실행 실패) → "fail" (확정 음성)
 * - 타임아웃/시그널 killed → "uncertain" (점검 자체 실패 — 거짓 경고 방지로 조용히)
 */
type ProbeVerdict = "ok" | "fail" | "uncertain";

async function runProbe(cmd: string, args: string[], timeout: number): Promise<ProbeVerdict> {
  try {
    await execFileAsync(cmd, args, { timeout, maxBuffer: 1 << 20 });
    return "ok";
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null };
    // 타임아웃/강제종료는 «불확실» — installed/authed 를 단정하지 않는다.
    if (err.killed || err.signal) return "uncertain";
    // ENOENT(command not found) 와 비-0 exit 는 모두 «확정 음성».
    return "fail";
  }
}

/**
 * 수집 직전 GitHub 신호 가용성을 점검한다. 절대 throw 하지 않는다.
 * - null 반환 = 점검 자체가 불확실(타임아웃 등) → iOS 는 아무 안내도 안 띄운다.
 * - 객체 반환 = 점검 완료. iOS 가 위 규칙으로 안내 여부를 판단한다.
 *
 * 비-GitHub 레포면 gh 프로브를 생략한다 (GitHub 신호가 무의미 — 안내도 무의미).
 *
 * `feedbackRepo`(owner/name) 가 주어지면 «로컬 origin» 이 아니라 그 repo 의 접근 가능성으로
 * 판정한다 — 수집 프롬프트의 GitHub 분기가 `gh -R <feedbackRepo>` 로 그 repo 를 읽기 때문.
 * 명시된 GitHub 타깃이므로 githubRemote 는 항상 true 이고, repo 가 private 이고 권한이 없으면
 * (gh 비-0 exit) feedbackRepoAccessible:false 로 «접근 불가» 를 전한다 (거짓 «설정 필요» 금지).
 */
export async function checkGhForCollect(
  repoPath: string,
  feedbackRepo?: string,
): Promise<GhCollectCheck | null> {
  const fb = feedbackRepo?.trim();
  if (fb) {
    // 피드백 repo 모드 — 로컬 origin 대신 명시된 repo 의 접근성으로 판정. 명시 GitHub 타깃이라
    // githubRemote 는 항상 true.
    const ver = await runProbe("gh", ["--version"], 5000);
    if (ver === "uncertain") return null; // 불확실 — 조용히
    const installed = ver === "ok";
    if (!installed) {
      return { githubRemote: true, installed: false, authed: false, feedbackRepo: fb, feedbackRepoAccessible: false };
    }
    const auth = await runProbe("gh", ["auth", "status"], 8000);
    if (auth === "uncertain") return null; // 불확실 — 조용히
    const authed = auth === "ok";
    if (!authed) {
      return { githubRemote: true, installed: true, authed: false, feedbackRepo: fb, feedbackRepoAccessible: false };
    }
    // 설치+인증됨 — 그 계정으로 «이 repo 를 실제로 읽을 수 있는가». private+무권한이면 비-0 exit.
    const access = await runProbe("gh", ["repo", "view", fb, "--json", "nameWithOwner"], 8000);
    if (access === "uncertain") return null; // 불확실 — 조용히
    return {
      githubRemote: true,
      installed: true,
      authed: true,
      feedbackRepo: fb,
      feedbackRepoAccessible: access === "ok",
    };
  }

  // 1) GitHub 원격인가 — 아니면 gh 유무와 무관하게 GitHub 신호가 의미 없다.
  let githubRemote = false;
  try {
    const { stdout } = await execFileAsync("git", ["-C", repoPath, "remote", "-v"], {
      timeout: 5000,
      maxBuffer: 1 << 20,
    });
    githubRemote = hasGithubRemote(stdout);
  } catch {
    // 비-git / 원격 없음 / git 오류 → GitHub 신호 무의미 (안내 안 띄움). 점검 실패는 아님.
    githubRemote = false;
  }
  if (!githubRemote) {
    // GitHub 원격이 아니면 gh 점검 자체가 불필요 — iOS 는 githubRemote=false 로 침묵한다.
    return { githubRemote: false, installed: false, authed: false };
  }

  // 2) gh 설치/실행 가능?
  const ver = await runProbe("gh", ["--version"], 5000);
  if (ver === "uncertain") return null; // 불확실 — 조용히
  const installed = ver === "ok";

  // 3) 로그인됨? (설치돼 있을 때만 의미)
  let authed = false;
  if (installed) {
    const auth = await runProbe("gh", ["auth", "status"], 8000);
    if (auth === "uncertain") return null; // 불확실 — 조용히
    authed = auth === "ok";
  }

  return { githubRemote, installed, authed };
}
