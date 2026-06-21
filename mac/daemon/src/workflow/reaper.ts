/**
 * WorktreeReaper — terminal 한 워크플로우 run / PO 브리프가 남긴 worktree 의 «작업트리(디스크)»
 * 를 «부팅 1회 + 주기» 로 회수하는 싱글톤. MergeQueue / PoScheduler 와 같은 골격. server.ts 가
 * 부팅 시 reconcileStaleRuns 직후 startWorktreeReaper() 로 띄운다.
 *
 * 역할 분담:
 *   - git/worktree-reaper.ts (순수) : 브랜치 prefix(po//wf/) 로 후보 한정 + main/현재/잠김 보호 +
 *     비-force 제거(dirty skip) + prune. 브랜치 ref 는 안 지운다 (작업트리만 회수).
 *   - 이 모듈 (오케스트레이터)        : «살아있는 owner» 를 보호하는 protected 집합을 DB/엔진에서
 *     모아 repo 별로 reapWorktrees 를 돌린다.
 *
 * 보호 집합:
 *   - protectedPaths  : 활성 세션(status='active') repo_path + 엔진 in-memory 활성 run worktree.
 *                       → 현재 활성 run/브리프가 선 worktree 는 절대 회수 안 됨.
 *   - protectedBranches: 비-terminal PO 브리프의 po/<id8> 브랜치 (세션 사이 빈 창까지 방어).
 *
 * best-effort: 어떤 단계가 실패해도 throw 하지 않는다 (queue.ts cleanup 철학과 동형) — 머지/run
 * 상태를 절대 뒤집지 않는다.
 */
import fs from "node:fs/promises";
import { db } from "../db/index.js";
import {
  reapWorktrees,
  MANAGED_WORKTREE_PREFIXES,
  type ReapReport,
} from "../git/worktree-reaper.js";
import { activeRunWorktreePaths } from "./engine.js";

/** 주기 회수 간격 — 10분. run 종결/머지가 잦지 않아 촘촘할 필요 없다. */
const REAP_INTERVAL_MS = 10 * 60 * 1000;
/** 한 주기·repo 당 제거 상한 — 회수 폭주(동시 git 프로세스) 방지. */
const MAX_REMOVE_PER_CYCLE = 8;
/** repo 당 관리 worktree soft cap — 초과하면 누수 의심으로 경고 (silent cap 금지). */
const SOFT_CAP_PER_REPO = 24;

/** 살아있는 PO 브리프 status — 이 상태의 po/<id8> worktree 는 보호한다 (구현 진행 중/직전). */
const LIVE_BRIEF_STATUSES = ["proposed", "approved", "held", "running"] as const;

class WorktreeReaper {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  /** 부팅 시 1회 즉시 회수(이전 프로세스 누수 복구) + 주기 타이머 등록. */
  start(): void {
    if (this.timer) return;
    // reconcileStaleRuns 가 막 running→failed 로 돌린, 이전 프로세스가 남긴 worktree 누수를
    // 부팅 직후 1회 회수 (복구 경로). 실패해도 부팅을 막지 않는다 (fire-and-forget).
    void this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), REAP_INTERVAL_MS);
    // 타이머가 이벤트 루프를 살려두지 않게 — daemon 종료를 막지 않는다.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 한 회수 사이클 — 절대 throw 하지 않는다. 겹치면 이번 호출은 건너뛴다(running 가드). */
  async runOnce(): Promise<ReapReport[]> {
    if (this.running) return [];
    this.running = true;
    try {
      const repos = candidateRepos();
      if (repos.length === 0) return [];
      const protectedPaths = await liveWorktreePaths();
      const protectedBranches = liveBriefBranches();
      const reports: ReapReport[] = [];
      for (const repoPath of repos) {
        try {
          const rep = await reapWorktrees(repoPath, {
            managedPrefixes: MANAGED_WORKTREE_PREFIXES,
            protectedPaths,
            protectedBranches,
            maxRemove: MAX_REMOVE_PER_CYCLE,
          });
          if (rep.removed.length > 0 || rep.skipped.length > 0) {
            console.log(
              `[reaper] repo=${repoPath} removed=${rep.removed.length} skipped=${rep.skipped.length} managed=${rep.managedTotal}`,
            );
          }
          if (rep.managedTotal > SOFT_CAP_PER_REPO) {
            console.warn(
              `[reaper] repo=${repoPath} managed worktrees=${rep.managedTotal} > cap ${SOFT_CAP_PER_REPO} — 누수 의심 (dirty/locked 가 회수를 막는지 확인)`,
            );
          }
          reports.push(rep);
        } catch (e) {
          console.warn(`[reaper] repo=${repoPath} reap failed:`, (e as Error).message);
        }
      }
      return reports;
    } catch (e) {
      console.warn("[reaper] cycle failed:", (e as Error).message);
      return [];
    } finally {
      this.running = false;
    }
  }
}

/** 회수를 돌릴 후보 repo — daemon 이 po//wf/ worktree 를 만드는 곳(브리프·워크플로우 정의의 repo). */
function candidateRepos(): string[] {
  const set = new Set<string>();
  const collect = (sql: string) => {
    try {
      for (const r of db().prepare(sql).all() as Array<{ repo_path: string }>) {
        if (r.repo_path) set.add(r.repo_path);
      }
    } catch {
      /* 테이블 없음 등 — 무시 */
    }
  };
  collect(`SELECT DISTINCT repo_path FROM po_briefs WHERE repo_path IS NOT NULL`);
  collect(`SELECT DISTINCT repo_path FROM workflows WHERE repo_path IS NOT NULL`);
  return [...set];
}

/** 살아있는 worktree 경로(realpath) — 활성 세션 repo_path + 엔진 in-memory 활성 run worktree. */
async function liveWorktreePaths(): Promise<Set<string>> {
  const raw = new Set<string>();
  try {
    for (const s of db()
      .prepare(`SELECT DISTINCT repo_path FROM sessions WHERE status = 'active'`)
      .all() as Array<{ repo_path: string }>) {
      if (s.repo_path) raw.add(s.repo_path);
    }
  } catch {
    /* best-effort */
  }
  for (const p of activeRunWorktreePaths()) raw.add(p);
  // realpath 정규화 — reapWorktrees 가 entries[].path 도 realpath 로 비교한다.
  const out = new Set<string>();
  for (const p of raw) {
    try {
      out.add(await fs.realpath(p));
    } catch {
      out.add(p);
    }
  }
  return out;
}

/** 비-terminal PO 브리프의 po/<id8> 브랜치 — 진행 중/직전 구현 worktree 보호. */
function liveBriefBranches(): Set<string> {
  const out = new Set<string>();
  try {
    const placeholders = LIVE_BRIEF_STATUSES.map(() => "?").join(",");
    const rows = db()
      .prepare(
        `SELECT id FROM po_briefs WHERE status IN (${placeholders}) OR revising_session_id IS NOT NULL`,
      )
      .all(...LIVE_BRIEF_STATUSES) as Array<{ id: string }>;
    for (const r of rows) out.add(`po/${r.id.slice(0, 8)}`);
  } catch {
    /* best-effort */
  }
  return out;
}

let _reaper: WorktreeReaper | null = null;

export function getWorktreeReaper(): WorktreeReaper {
  if (!_reaper) _reaper = new WorktreeReaper();
  return _reaper;
}

/** server.ts 가 부팅 시 1회 호출 — 부팅 즉시 회수 + 주기 타이머 등록, 핸들 반환(shutdown 에서 stop). */
export function startWorktreeReaper(): WorktreeReaper {
  const r = getWorktreeReaper();
  r.start();
  return r;
}

/** 테스트 전용 — 싱글톤 초기화. */
export function _resetWorktreeReaperForTest(): void {
  _reaper?.stop();
  _reaper = null;
}
