// ─────────────────────────────────────────────────────────────────────────────
// git worktree 공유 헬퍼 — sessionId 에 의존하지 않는 순수 git 로직.
//
// 두 라우트가 같은 코드를 공유한다:
//   - routes/sessions.ts : POST /api/sessions/:id/git/worktrees (세션 → repo_path 조회 후 위임)
//   - routes/git.ts      : POST /api/git/worktrees             (repoPath 직접)
//
// 안전: 모든 동작은 repoPath 안에서 `-C` 로만 돈다. execFile 은 shell 을 거치지 않으므로
// shell 주입은 없고, 남는 위협은 «`-` 로 시작하는 인자가 git 플래그로 해석되는»
// argument injection 뿐 → isValidRef 가 거른다.
// ─────────────────────────────────────────────────────────────────────────────

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs/promises";

const execFileAsync = promisify(execFile);

/**
 * 브랜치명 / start-point / 원격추적명 검증. execFile 은 shell 이 없어 주입 위험은 낮지만
 * `-X` 같은 값이 git 플래그로 먹히는 argument injection 을 막는 게 핵심이다. 허용 문자는
 * 영숫자 + `/` `_` `.` `-` (브랜치·원격명). 공백/제어문자/`~^:?*[`/`..`/선행 `-` 는 거부.
 * 남는 형식 오류(예: 끝의 `.lock`)는 git 자체가 거절하므로 그건 stderr 로 사용자에게 보낸다.
 */
export function isValidRef(name: unknown): name is string {
  if (typeof name !== "string") return false;
  if (name.length === 0 || name.length > 255) return false;
  if (name.startsWith("-")) return false;
  if (name.includes("..")) return false;
  return /^[A-Za-z0-9._/-]+$/.test(name);
}

export type WorktreeEntry = {
  path: string;
  head?: string;
  /** short 브랜치명. detached / bare 면 undefined. */
  branch?: string;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  prunable: boolean;
};

/** `git worktree list --porcelain` 출력 파싱. 블록(빈 줄 구분)당 worktree 한 개. */
export function parseWorktreeList(stdout: string): WorktreeEntry[] {
  const out: WorktreeEntry[] = [];
  for (const block of stdout.split("\n\n")) {
    const lines = block.split("\n").filter((l) => l.length > 0);
    if (lines.length === 0) continue;
    const e: WorktreeEntry = {
      path: "",
      detached: false,
      bare: false,
      locked: false,
      prunable: false,
    };
    for (const line of lines) {
      if (line.startsWith("worktree ")) e.path = line.slice("worktree ".length);
      else if (line.startsWith("HEAD ")) e.head = line.slice("HEAD ".length);
      else if (line.startsWith("branch "))
        e.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
      else if (line === "detached") e.detached = true;
      else if (line === "bare") e.bare = true;
      else if (line === "locked" || line.startsWith("locked ")) e.locked = true;
      else if (line === "prunable" || line.startsWith("prunable ")) e.prunable = true;
    }
    if (e.path) out.push(e);
  }
  return out;
}

/**
 * repo_path 의 worktree 목록 + 현재 세션이 위치한 worktree 의 realpath toplevel 을 함께 조회.
 * 비-repo / git 미설치면 `{ entries: [], currentTop: null }` 로 조용히 흡수.
 * currentTop 은 isCurrent 판정 / 삭제 보호에 쓰인다 — 경로 비교는 symlink 차이를 없애려
 * 양쪽 모두 realpath 로 정규화한다.
 */
export async function listWorktrees(
  repoPath: string,
): Promise<{ entries: WorktreeEntry[]; currentTop: string | null }> {
  let entries: WorktreeEntry[] = [];
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", repoPath, "worktree", "list", "--porcelain"],
      { timeout: 5000, maxBuffer: 4 * 1024 * 1024 },
    );
    entries = parseWorktreeList(stdout);
  } catch {
    return { entries: [], currentTop: null };
  }
  let currentTop: string | null = null;
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", repoPath, "rev-parse", "--show-toplevel"],
      { timeout: 3000, maxBuffer: 64 * 1024 },
    );
    currentTop = await fs.realpath(stdout.trim());
  } catch {
    currentTop = null;
  }
  return { entries, currentTop };
}

/** createWorktree 의 실패 — 라우트가 그대로 `c.json(body, status)` 로 보낸다. */
export type CreateWorktreeResult =
  | { ok: true; path: string; branch: string }
  | {
      ok: false;
      status: 400 | 404 | 409 | 500;
      body: { error: string; message?: string; path?: string };
    };

/**
 * worktree 생성. 경로는 daemon 이 자동 산정한다:
 *   <메인worktree부모>/<repoName>.worktrees/<branchSlug>.
 * newBranch=true → `git worktree add -b branch <target> [from]` (신규 브랜치),
 * 아니면 `git worktree add <target> branch` (기존 브랜치).
 *
 * branch/from 검증을 내부에서 하므로(isValidRef) 호출부는 body 원본을 그대로 넘기면 된다.
 */
export async function createWorktree(
  repoPath: string,
  opts: { branch?: unknown; newBranch?: unknown; from?: unknown },
): Promise<CreateWorktreeResult> {
  const branch = opts.branch;
  if (!isValidRef(branch)) return { ok: false, status: 400, body: { error: "invalid_branch" } };
  const newBranch = opts.newBranch === true;
  const fromRaw = opts.from;
  const from = typeof fromRaw === "string" && fromRaw.length > 0 ? fromRaw : undefined;
  if (from !== undefined && !isValidRef(from))
    return { ok: false, status: 400, body: { error: "invalid_from" } };

  // 메인 worktree 를 기준점으로 인접 경로를 산정 — 현재 세션이 이미 worktree 안이어도
  // 모든 worktree 가 한 곳(<repo>.worktrees/)에 모이게.
  const { entries } = await listWorktrees(repoPath);
  if (entries.length === 0) return { ok: false, status: 404, body: { error: "no_repo" } };
  const mainPath = entries[0].path;
  const base = path.dirname(mainPath);
  const repoName = path.basename(mainPath);
  const slug = branch.replace(/[^\w.-]/g, "-");
  const target = path.join(base, `${repoName}.worktrees`, slug);

  // 이미 존재하면 거절 — 사용자가 같은 브랜치 worktree 를 중복 생성하는 사고 방지.
  try {
    await fs.access(target);
    return { ok: false, status: 409, body: { error: "target_exists", path: target } };
  } catch {
    // ENOENT — 정상(아직 없음).
  }
  try {
    await fs.mkdir(path.dirname(target), { recursive: true });
  } catch {
    return { ok: false, status: 500, body: { error: "mkdir_failed" } };
  }

  const args = newBranch
    ? ["-C", repoPath, "worktree", "add", "-b", branch, target, ...(from ? [from] : [])]
    : ["-C", repoPath, "worktree", "add", target, branch];
  try {
    await execFileAsync("git", args, { timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
    return { ok: true, path: target, branch };
  } catch (e: any) {
    const message = (e?.stderr ?? e?.message ?? "worktree add failed").toString().trim();
    return { ok: false, status: 409, body: { error: "worktree_add_failed", message } };
  }
}

/**
 * repo 의 «기본(default) 브랜치» — per-run 격리 작업 브랜치를 다시 합칠 target 후보.
 * 우선순위: 원격 HEAD(origin/HEAD) 가 가리키는 브랜치 → 로컬 main → 로컬 master.
 * 모두 `-C` 안에서 ref 만 읽어 repo 를 변경하지 않는다. 못 찾으면 null (호출부가 머지를
 * 건너뛴다). isValidRef 로 한 번 거른 값만 돌려준다 (argument-injection 방어 일관).
 */
export async function defaultBranch(repoPath: string): Promise<string | null> {
  // 1) origin/HEAD → "origin/<branch>" 에서 branch 추출 (원격이 정한 기본 브랜치).
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", repoPath, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
      { timeout: 3000, maxBuffer: 64 * 1024 },
    );
    const b = stdout.trim().replace(/^origin\//, "");
    if (isValidRef(b)) return b;
  } catch {
    /* 원격 HEAD 미설정 — 다음 후보로 */
  }
  // 2) 로컬 main / master 존재 확인 (관례적 기본 브랜치).
  for (const cand of ["main", "master"]) {
    try {
      await execFileAsync(
        "git",
        ["-C", repoPath, "show-ref", "--verify", "--quiet", `refs/heads/${cand}`],
        { timeout: 3000, maxBuffer: 64 * 1024 },
      );
      return cand;
    } catch {
      /* 없음 — 다음 후보 */
    }
  }
  return null;
}

/**
 * 경로가 git 작업트리인지 + 현재 브랜치. 새 세션 스크린에서 «worktree 섹션을 보여줄지»
 * 판단하는 용도라 가볍게 한두 번의 `git rev-parse` 만 돈다. 비-repo / git 미설치 / detached
 * 는 모두 조용히 흡수한다(branch=null). detached HEAD 도 isRepo=true, branch=null.
 */
export async function gitRepoInfo(
  repoPath: string,
): Promise<{ isRepo: boolean; branch: string | null }> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", repoPath, "rev-parse", "--is-inside-work-tree"],
      { timeout: 3000, maxBuffer: 64 * 1024 },
    );
    if (stdout.trim() !== "true") return { isRepo: false, branch: null };
  } catch {
    return { isRepo: false, branch: null };
  }
  let branch: string | null = null;
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", repoPath, "rev-parse", "--abbrev-ref", "HEAD"],
      { timeout: 3000, maxBuffer: 64 * 1024 },
    );
    const b = stdout.trim();
    branch = b.length > 0 && b !== "HEAD" ? b : null;
  } catch {
    branch = null;
  }
  return { isRepo: true, branch };
}
