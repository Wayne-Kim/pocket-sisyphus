// ─────────────────────────────────────────────────────────────────────────────
// git worktree 회수기(reaper) — terminal 한 run/brief 이 남긴 worktree 의 «작업트리(디스크)»
// 를 회수한다. worktree.ts / merge.ts 와 짝을 이루는 «sessionId 에 의존하지 않는 순수 git 로직».
//
// 왜 필요한가: cleanupMergedSource 는 «머지 성공» source 만 회수한다. daemon 재시작 시
// reconcileStaleRuns 가 진행 중 run 을 전부 failed 로 reconcile 하는데, 그 run 이 만든
// worktree 는 디스크에 남고 자동 회수 경로가 없었다 (수동 `worktree remove`/`prune` 뿐).
// per-run worktree 를 자동 생성하기 시작하면 이 누수가 «새로» 쌓이므로 여기서 닫는다.
// worktree 는 full 작업트리 체크아웃이라 누적 = 디스크 비용 + 사용자 수동 정리.
//
// 안전 (핵심 — 어겨서 사고나면 사용자 작업 손실):
//   - 브랜치 prefix(po//wf/) 로 «daemon 이 만든 run/brief worktree» 만 후보로 한정한다.
//     사용자가 직접 만든 worktree(임의 브랜치)·세션 worktree·main 은 prefix 가 안 맞아
//     애초에 후보가 아니다 (비-목표 보호).
//   - main(목록 0번)·현재 서 있는 worktree·잠긴(locked) worktree·살아있는 owner 의 worktree
//     (protectedBranches / protectedPaths) 는 절대 제거하지 않는다.
//   - 제거는 «비-force» `git worktree remove` — dirty/untracked 가 있으면 git 이 거부하므로
//     미커밋 작업을 덮어쓰지 않는다 (다음 주기에 재시도). 브랜치 ref 는 «절대» 지우지 않는다
//     — 작업트리(디스크)만 회수하므로 미머지 커밋도 브랜치에 그대로 보존되고, 롤백해도
//     수동 prune 경로가 남아 안전하다 (브랜치 삭제는 cleanupMergedSource 의 머지-성공 경로 몫).
//   - best-effort: 어떤 단계가 실패해도 throw 하지 않고 로그만 남긴다 (queue.ts cleanup 철학과 동형).
//     머지/run 상태를 절대 뒤집지 않는다.
// ─────────────────────────────────────────────────────────────────────────────

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import { listWorktrees, type WorktreeEntry } from "./worktree.js";

const execFileAsync = promisify(execFile);

/** daemon 이 자동 생성하는 run/brief worktree 의 브랜치 prefix. 회수 후보를 이 prefix 로만 한정한다. */
export const MANAGED_WORKTREE_PREFIXES = ["po/", "wf/"] as const;

export type ReapOptions = {
  /** 회수 후보로 볼 브랜치 prefix (기본: po//wf/). */
  managedPrefixes?: readonly string[];
  /** 살아있는 owner 의 브랜치 — 절대 제거 안 함 (예: 진행 중 브리프 po/<id8>). */
  protectedBranches?: ReadonlySet<string>;
  /** 살아있는 owner 의 worktree 경로(realpath) — 절대 제거 안 함 (예: 활성 세션이 선 worktree). */
  protectedPaths?: ReadonlySet<string>;
  /** 한 주기에 제거할 최대 개수 (동시 git 프로세스 폭주 방지). 미지정이면 후보 전부. */
  maxRemove?: number;
};

export type ReapReport = {
  repoPath: string;
  /** 실제로 제거된 worktree 경로(realpath). */
  removed: string[];
  /** 제거 시도했으나 건너뛴 것 (dirty/locked/실패) — 다음 주기 재시도 대상. */
  skipped: Array<{ path: string; reason: string }>;
  /** main 을 뺀, 관리 prefix 를 가진 worktree 총수 — soft cap 모니터링용. */
  managedTotal: number;
};

function hasManagedPrefix(branch: string | undefined, prefixes: readonly string[]): boolean {
  if (!branch) return false;
  return prefixes.some((p) => branch.startsWith(p));
}

/**
 * 회수 «대상» worktree 를 고른다 (순수 — I/O 없음, 단위 테스트로 안전 경계를 고정한다).
 * entries 는 `git worktree list --porcelain` 파싱 결과로 entries[0] 은 항상 main.
 * 경로 비교는 호출부(reapWorktrees)가 entries[].path / protectedPaths 를 같은 좌표계(realpath)
 * 로 정규화한 뒤 넘긴다고 가정한다.
 *
 * 한 worktree 가 회수 대상이 되려면 «전부» 만족해야 한다:
 *   - main(0번)·bare 가 아님
 *   - locked 아님 (사용자/시스템이 보호 의도를 명시)
 *   - 브랜치가 있음 (detached 는 owner 식별 불가 → 건드리지 않음)
 *   - 브랜치가 관리 prefix(po//wf/) — 비-관리는 사용자/세션 worktree 라 후보 제외
 *   - 브랜치가 protectedBranches 에 없음 (살아있는 owner)
 *   - 경로가 protectedPaths 에 없음 (활성 세션/활성 run 이 선 worktree)
 */
export function selectReapable(
  entries: WorktreeEntry[],
  opts: {
    managedPrefixes: readonly string[];
    protectedBranches: ReadonlySet<string>;
    protectedPaths: ReadonlySet<string>;
  },
): WorktreeEntry[] {
  const out: WorktreeEntry[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (i === 0) continue; // main — 절대 제거 안 함.
    if (e.bare) continue; // bare — 작업트리 없음.
    if (e.locked) continue; // 잠김 — 보호.
    if (e.detached || !e.branch) continue; // 브랜치 없음 — owner 식별 불가.
    if (!hasManagedPrefix(e.branch, opts.managedPrefixes)) continue; // 비-관리 prefix.
    if (opts.protectedBranches.has(e.branch)) continue; // 살아있는 owner.
    if (opts.protectedPaths.has(e.path)) continue; // 활성 세션/run 이 선 worktree.
    out.push(e);
  }
  return out;
}

async function realpathOrSelf(p: string): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch {
    return p;
  }
}

/** best-effort `git -C <repo> <args...>` — 실패해도 throw 하지 않고 stderr 를 message 로 돌려준다. */
async function runGit(
  repoPath: string,
  args: string[],
  timeout = 20000,
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    await execFileAsync("git", ["-C", repoPath, ...args], { timeout, maxBuffer: 1024 * 1024 });
    return { ok: true };
  } catch (e: any) {
    return { ok: false, message: (e?.stderr ?? e?.message ?? "git failed").toString().trim() };
  }
}

/**
 * repoPath 의 관리 worktree 중 terminal(=protected 아님) 인 것들의 «작업트리» 를 회수한다.
 * 비-force 제거이므로 dirty/locked 는 git 이 거부 → skip + 다음 주기 재시도. 브랜치는 안 지운다.
 * 절대 throw 하지 않는다 (비-repo / git 미설치면 빈 report).
 */
export async function reapWorktrees(repoPath: string, opts: ReapOptions = {}): Promise<ReapReport> {
  const report: ReapReport = { repoPath, removed: [], skipped: [], managedTotal: 0 };
  const prefixes = opts.managedPrefixes ?? MANAGED_WORKTREE_PREFIXES;

  const { entries, currentTop } = await listWorktrees(repoPath);
  if (entries.length === 0) return report; // 비-repo / git 미설치 — 조용히 흡수.

  // entries[].path 를 realpath 정규화 — protectedPaths / currentTop 과 같은 좌표계로 비교.
  const normalized: WorktreeEntry[] = [];
  for (const e of entries) normalized.push({ ...e, path: await realpathOrSelf(e.path) });

  const protectedPaths = new Set<string>(opts.protectedPaths ?? []);
  if (currentTop) protectedPaths.add(currentTop); // 내가 선 worktree 는 절대 제거 안 함.

  report.managedTotal = normalized.filter(
    (e, i) => i > 0 && hasManagedPrefix(e.branch, prefixes),
  ).length;

  const reapable = selectReapable(normalized, {
    managedPrefixes: prefixes,
    protectedBranches: opts.protectedBranches ?? new Set<string>(),
    protectedPaths,
  });

  const limit = opts.maxRemove ?? reapable.length;
  let removedAny = false;
  for (const e of reapable.slice(0, Math.max(0, limit))) {
    // 비-force — dirty/untracked 면 git 이 거부 → skip (미커밋 작업 보존, 다음 주기 재시도).
    const r = await runGit(repoPath, ["worktree", "remove", e.path]);
    if (r.ok) {
      report.removed.push(e.path);
      removedAny = true;
      console.log(`[reaper] removed worktree ${e.path} (branch=${e.branch})`);
    } else {
      report.skipped.push({ path: e.path, reason: r.message });
      console.warn(`[reaper] skip worktree ${e.path} (branch=${e.branch}): ${r.message}`);
    }
  }
  // 메타데이터 정리 — 제거가 하나라도 있었으면 prune (sessions.ts 의 remove→prune 패턴과 동형).
  if (removedAny) {
    const p = await runGit(repoPath, ["worktree", "prune"], 5000);
    if (!p.ok) console.warn(`[reaper] prune failed repo=${repoPath}: ${p.message}`); // 제거 자체는 성공.
  }
  return report;
}
