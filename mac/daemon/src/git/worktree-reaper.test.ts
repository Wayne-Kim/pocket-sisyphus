/**
 * git/worktree-reaper — terminal run/brief worktree 회수기의 순수 git 로직 단위 테스트.
 * 실제 tmp git repo + worktree 를 만들어 돌린다 (DB/네트워크 무관).
 *
 * 수용 기준 보증:
 *   - main 및 «현재 활성 run»(protectedPaths/protectedBranches) 의 worktree 는 절대 제거 안 됨.
 *   - terminal(보호 안 된 관리 prefix) worktree 만 제거 + 브랜치 ref 는 보존(작업트리만 회수).
 *   - 비-관리 prefix(사용자/세션 worktree) 는 손대지 않음.
 *   - dirty/locked 는 비-force 라 skip + 다음 주기 재시도. best-effort — throw 없음.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { selectReapable, reapWorktrees, MANAGED_WORKTREE_PREFIXES } from "./worktree-reaper.js";
import { parseWorktreeList, type WorktreeEntry } from "./worktree.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

/** main 브랜치 + 초기 커밋 1개를 가진 tmp repo. */
function mkRepo(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ps-reaper-")));
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  git(dir, ["config", "user.email", "test@pocket.local"]);
  git(dir, ["config", "user.name", "Tester"]);
  fs.writeFileSync(path.join(dir, "README.md"), "init\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

/** branch 를 main 에서 새로 만들고 커밋 1개를 단 뒤 main 복귀 (worktree add 가능 상태). */
function mkBranch(dir: string, branch: string): void {
  git(dir, ["checkout", "-q", "-b", branch]);
  fs.writeFileSync(path.join(dir, `${branch.replace(/\//g, "_")}.txt`), `${branch}\n`);
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", `${branch}: work`]);
  git(dir, ["checkout", "-q", "main"]);
}

/** branch 를 인접 디렉토리에 worktree 로 체크아웃하고 그 realpath 를 돌려준다. */
function addWorktree(dir: string, branch: string): string {
  const wt = path.join(path.dirname(dir), `${path.basename(dir)}--${branch.replace(/\//g, "_")}`);
  git(dir, ["worktree", "add", "-q", wt, branch]);
  return fs.realpathSync(wt);
}

let repos: string[] = [];
let extraPaths: string[] = [];
function repo(): string {
  const r = mkRepo();
  repos.push(r);
  return r;
}
beforeEach(() => {
  repos = [];
  extraPaths = [];
});
afterEach(() => {
  for (const p of [...extraPaths, ...repos]) {
    try {
      fs.rmSync(p, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

// ── selectReapable (순수 선택 로직) ──────────────────────────────────────────────

describe("selectReapable — 순수 안전 경계", () => {
  const main: WorktreeEntry = {
    path: "/repo",
    branch: "main",
    detached: false,
    bare: false,
    locked: false,
    prunable: false,
  };
  const mk = (over: Partial<WorktreeEntry>): WorktreeEntry => ({
    path: "/x",
    branch: "po/aaa",
    detached: false,
    bare: false,
    locked: false,
    prunable: false,
    ...over,
  });
  const base = {
    managedPrefixes: MANAGED_WORKTREE_PREFIXES,
    protectedBranches: new Set<string>(),
    protectedPaths: new Set<string>(),
  };

  it("관리 prefix(po//wf/) terminal worktree 만 고른다", () => {
    const entries = [
      main,
      mk({ path: "/po1", branch: "po/aaa11111" }),
      mk({ path: "/wf1", branch: "wf/bbb22222" }),
      mk({ path: "/usr", branch: "feature/x" }), // 비-관리 → 제외
    ];
    const out = selectReapable(entries, base).map((e) => e.path);
    expect(out.sort()).toEqual(["/po1", "/wf1"]);
  });

  it("main(0번)·bare·locked·detached 는 절대 안 고른다", () => {
    const entries = [
      main,
      mk({ path: "/bare", branch: undefined, bare: true }),
      mk({ path: "/lock", branch: "po/locked11", locked: true }),
      mk({ path: "/det", branch: undefined, detached: true }),
      mk({ path: "/ok", branch: "po/ok000000" }),
    ];
    expect(selectReapable(entries, base).map((e) => e.path)).toEqual(["/ok"]);
  });

  it("protectedBranches / protectedPaths 의 worktree 는 보호한다", () => {
    const entries = [
      main,
      mk({ path: "/live-branch", branch: "po/live1111" }),
      mk({ path: "/live-path", branch: "po/live2222" }),
      mk({ path: "/dead", branch: "po/dead3333" }),
    ];
    const out = selectReapable(entries, {
      ...base,
      protectedBranches: new Set(["po/live1111"]),
      protectedPaths: new Set(["/live-path"]),
    });
    expect(out.map((e) => e.path)).toEqual(["/dead"]);
  });

  it("main 이 관리 prefix 처럼 보여도(0번이면) 절대 안 고른다", () => {
    // 방어: 0번 항목 브랜치가 po/* 라도 main 자리이므로 보호.
    const entries = [mk({ path: "/repo", branch: "po/main0000" }), mk({ path: "/x", branch: "po/x111" })];
    expect(selectReapable(entries, base).map((e) => e.path)).toEqual(["/x"]);
  });
});

// ── reapWorktrees (실제 git repo) ────────────────────────────────────────────────

describe("reapWorktrees — 실제 worktree 회수", () => {
  it("terminal 관리 worktree 의 작업트리만 회수하고 브랜치 ref 는 보존", async () => {
    const dir = repo();
    mkBranch(dir, "po/dead0001");
    const deadWt = addWorktree(dir, "po/dead0001");
    extraPaths.push(deadWt);

    const before = fs.existsSync(deadWt);
    expect(before).toBe(true);

    const rep = await reapWorktrees(dir);
    expect(rep.removed).toEqual([deadWt]);
    expect(rep.skipped).toEqual([]);
    // 작업트리(디스크)는 사라졌지만 브랜치 ref 는 남아 미머지 커밋 보존.
    expect(fs.existsSync(deadWt)).toBe(false);
    expect(git(dir, ["branch", "--list", "po/dead0001"])).toContain("po/dead0001");
    // worktree 목록에서도 빠졌다 (prune 완료).
    const list = parseWorktreeList(git(dir, ["worktree", "list", "--porcelain"]));
    expect(list.some((e) => e.branch === "po/dead0001")).toBe(false);
  });

  it("main 및 현재 활성 run(protected) worktree 는 절대 제거 안 함", async () => {
    const dir = repo();
    mkBranch(dir, "po/active01"); // 활성 run worktree (protectedPaths)
    mkBranch(dir, "po/live0001"); // 활성 브리프 (protectedBranches)
    mkBranch(dir, "po/dead0002"); // terminal
    const activeWt = addWorktree(dir, "po/active01");
    const liveWt = addWorktree(dir, "po/live0001");
    const deadWt = addWorktree(dir, "po/dead0002");
    extraPaths.push(activeWt, liveWt, deadWt);

    const rep = await reapWorktrees(dir, {
      protectedPaths: new Set([activeWt]),
      protectedBranches: new Set(["po/live0001"]),
    });

    expect(rep.removed).toEqual([deadWt]);
    // main 보존.
    expect(fs.existsSync(path.join(dir, "README.md"))).toBe(true);
    // 활성 run/브리프 worktree 보존.
    expect(fs.existsSync(activeWt)).toBe(true);
    expect(fs.existsSync(liveWt)).toBe(true);
    // terminal 만 회수.
    expect(fs.existsSync(deadWt)).toBe(false);
  });

  it("비-관리 prefix(사용자/세션 worktree) 는 손대지 않는다", async () => {
    const dir = repo();
    mkBranch(dir, "feature/manual");
    mkBranch(dir, "po/dead0003");
    const manualWt = addWorktree(dir, "feature/manual");
    const deadWt = addWorktree(dir, "po/dead0003");
    extraPaths.push(manualWt, deadWt);

    const rep = await reapWorktrees(dir);
    expect(rep.removed).toEqual([deadWt]);
    expect(fs.existsSync(manualWt)).toBe(true); // 사용자 worktree 무사.
  });

  it("dirty 관리 worktree 는 비-force 라 skip + 디스크 보존 (다음 주기 재시도)", async () => {
    const dir = repo();
    mkBranch(dir, "po/dirty001");
    const dirtyWt = addWorktree(dir, "po/dirty001");
    extraPaths.push(dirtyWt);
    // 미커밋 변경(추적 파일 수정) — git worktree remove 가 거부해야 한다.
    fs.writeFileSync(path.join(dirtyWt, "po_dirty001.txt"), "uncommitted edit\n");

    const rep = await reapWorktrees(dir);
    expect(rep.removed).toEqual([]);
    expect(rep.skipped.length).toBe(1);
    expect(rep.skipped[0].path).toBe(dirtyWt);
    expect(fs.existsSync(dirtyWt)).toBe(true); // 미커밋 작업 보존.
  });

  it("locked 관리 worktree 는 보호한다", async () => {
    const dir = repo();
    mkBranch(dir, "po/locked01");
    const lockedWt = addWorktree(dir, "po/locked01");
    extraPaths.push(lockedWt);
    git(dir, ["worktree", "lock", lockedWt]);

    const rep = await reapWorktrees(dir);
    expect(rep.removed).toEqual([]);
    expect(fs.existsSync(lockedWt)).toBe(true);

    git(dir, ["worktree", "unlock", lockedWt]); // afterEach rm 전 해제.
  });

  it("maxRemove 상한을 지킨다 (나머지는 다음 주기)", async () => {
    const dir = repo();
    const wts: string[] = [];
    for (const b of ["po/d0000001", "po/d0000002", "po/d0000003"]) {
      mkBranch(dir, b);
      wts.push(addWorktree(dir, b));
    }
    extraPaths.push(...wts);

    const rep = await reapWorktrees(dir, { maxRemove: 1 });
    expect(rep.removed.length).toBe(1);
    expect(rep.managedTotal).toBe(3); // 3개 다 «관리» 로 셈 (cap 모니터링).
    // 나머지 2개는 아직 디스크에 있다.
    const remaining = wts.filter((w) => fs.existsSync(w));
    expect(remaining.length).toBe(2);
  });

  it("관리 worktree 가 없으면 no-op (removed/skipped 비어 있음)", async () => {
    const dir = repo();
    mkBranch(dir, "feature/only");
    const wt = addWorktree(dir, "feature/only");
    extraPaths.push(wt);
    const rep = await reapWorktrees(dir);
    expect(rep.removed).toEqual([]);
    expect(rep.skipped).toEqual([]);
    expect(rep.managedTotal).toBe(0);
  });

  it("비-repo / 없는 경로는 throw 없이 빈 report (best-effort)", async () => {
    const rep = await reapWorktrees(path.join(os.tmpdir(), "ps-reaper-nonexistent-xyz"));
    expect(rep.removed).toEqual([]);
    expect(rep.skipped).toEqual([]);
    expect(rep.managedTotal).toBe(0);
  });
});
