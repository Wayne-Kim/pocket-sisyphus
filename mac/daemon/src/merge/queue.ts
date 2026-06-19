/**
 * MergeQueue — 워크트리/세션의 작업 브랜치를 main/release 로 합치는 «재결합» 을 daemon 이
 * «직렬 큐» 로 한 번에 하나씩 처리한다. 싱글톤 (daemon 프로세스당 하나) — CronScheduler /
 * PoScheduler 와 같은 골격. server.ts 가 부팅 시 startMergeQueue(), 라우트(routes/merge.ts)가
 * enqueue 후 getMergeQueue().kick() 으로 처리 루프를 깨운다.
 *
 * 직렬 보장 (수용 기준의 핵심):
 *   - 처리 루프는 «하나» 뿐이다 (active 플래그). 동시에 둘 이상이 target 에 쓰지 않는다.
 *   - claimNextQueued() 가 트랜잭션으로 «queued → processing» 을 원자 전이 — 동시 kick 이
 *     같은 항목을(또는 두 항목을 동시에) 집지 못한다.
 *   - 처리 중 들어온 새 enqueue 는 rearm 플래그로 흡수해 같은 루프가 마저 처리한다.
 *
 * 충돌/실패는 «에이전트를 멈추게» 두지 않는다:
 *   - 사전 충돌 탐지(previewMerge, 읽기 전용)에서 충돌이면 머지를 «보류» 하고 그 항목만
 *     conflict 로 표시한 뒤 다음 항목을 계속 처리한다.
 *   - 실제 머지가 (preview 가 놓쳐) 충돌하면 깨끗이 되돌리고 conflict, dirty 워크트리 등은
 *     failed — 어느 쪽이든 큐는 멈추지 않는다. 사용자는 큐 상태(API/iOS 배지)로 충돌을 본다.
 */
import type { MergeRequestRow } from "../db/index.js";
import {
  claimNextQueued,
  markMerged,
  markConflict,
  markFailed,
  reconcileStaleProcessing,
} from "./store.js";
import { previewMerge, performMerge, cleanupMergedSource } from "../git/merge.js";

class MergeQueue {
  private active = false;
  private rearm = false;
  private idleWaiters: Array<() => void> = [];

  /** 큐를 깨운다 (fire-and-forget). 이미 돌고 있으면 그 루프가 새 항목을 마저 집는다. */
  kick(): void {
    if (this.active) {
      this.rearm = true;
      return;
    }
    this.active = true;
    void this.loop();
  }

  /** 큐가 «완전히 빌 때까지» 처리하고 await — 테스트/부팅 보충용. 이미 idle 이면 즉시 resolve. */
  async runToIdle(): Promise<void> {
    this.kick();
    if (!this.active) return;
    await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  private async loop(): Promise<void> {
    try {
      do {
        this.rearm = false;
        for (;;) {
          const req = claimNextQueued();
          if (!req) break;
          await this.processOne(req);
        }
      } while (this.rearm); // 처리 중 들어온 enqueue 흡수 (claim 이 이미 집었어도 무해한 1 패스).
    } finally {
      this.active = false;
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      for (const w of waiters) w();
    }
  }

  /** 한 건 처리 — 절대 throw 하지 않는다 (throw 하면 루프가 죽어 큐가 멈춘다). */
  private async processOne(req: MergeRequestRow): Promise<void> {
    try {
      // 1) 사전 충돌 탐지 — 읽기 전용. repo 무변경.
      const preview = await previewMerge(req.repo_path, req.source_branch, req.target_branch);
      if (!preview.ok) {
        markFailed(
          req.id,
          preview.error === "invalid_ref"
            ? "invalid branch name"
            : `ref not found (${preview.message ?? ""})`,
        );
        return;
      }
      if (preview.relation === "unrelated") {
        markFailed(req.id, "unrelated histories — no common ancestor");
        return;
      }
      if (preview.relation === "up_to_date") {
        // 이미 합쳐져 있음 — 무해 성공 (멱등).
        markMerged(req.id, { result: "up_to_date", mergeCommit: preview.targetSha });
        return;
      }
      if (preview.conflict) {
        markConflict(req.id, {
          conflictFiles: preview.conflictFiles,
          error: "merge conflict — user intervention needed",
        });
        this.logConflict(req, preview.conflictFiles);
        return;
      }

      // 2) 충돌 없음 — 실제 머지 (fast-forward / --no-ff).
      const outcome = await performMerge(req.repo_path, req.source_branch, req.target_branch, {
        noFF: req.no_ff === 1,
      });
      if (outcome.ok) {
        markMerged(req.id, {
          result: outcome.result,
          mergeCommit: outcome.mergeCommit ?? outcome.targetSha ?? null,
        });
        // 3) 옵션 정리 — best-effort. 실패해도 머지 성공은 유지(상태 안 뒤집음).
        if (req.cleanup === 1 && outcome.result !== "up_to_date") {
          try {
            const c = await cleanupMergedSource(req.repo_path, req.source_branch);
            console.log(
              `[merge] cleanup source=${req.source_branch} worktree=${c.removedWorktree} branch=${c.deletedBranch}` +
                (c.message ? ` note=${c.message}` : ""),
            );
          } catch (e) {
            console.warn(`[merge] cleanup failed source=${req.source_branch}:`, (e as Error).message);
          }
        }
        console.log(
          `[merge] ${outcome.result} ${req.source_branch} → ${req.target_branch} (req=${req.id})`,
        );
        return;
      }
      // 실패 분기 — 어느 쪽이든 큐는 멈추지 않는다.
      if (outcome.reason === "conflict") {
        markConflict(req.id, {
          conflictFiles: outcome.conflictFiles,
          error: "merge conflict — user intervention needed",
        });
        this.logConflict(req, outcome.conflictFiles);
      } else if (outcome.reason === "blocked") {
        // dirty target 워크트리 등 — 사용자가 정리 후 재시도 가능 (retry → reEnqueue).
        markFailed(req.id, outcome.message);
        console.warn(`[merge] blocked ${req.source_branch} → ${req.target_branch}: ${outcome.message}`);
      } else {
        markFailed(req.id, outcome.message ?? outcome.reason);
        console.warn(
          `[merge] failed ${req.source_branch} → ${req.target_branch} (${outcome.reason}): ${outcome.message ?? ""}`,
        );
      }
    } catch (e) {
      // 예상 못 한 예외 — 항목만 failed 로 종결하고 큐는 계속.
      markFailed(req.id, (e as Error).message);
      console.warn(`[merge] processOne unexpected error (req=${req.id}):`, (e as Error).message);
    }
  }

  private logConflict(req: MergeRequestRow, files: string[]): void {
    console.warn(
      `[merge] conflict ${req.source_branch} → ${req.target_branch} (req=${req.id})` +
        (files.length > 0 ? ` files=${files.slice(0, 10).join(", ")}` : "") +
        " — 사용자 개입 필요 (큐는 계속 처리)",
    );
  }
}

let _queue: MergeQueue | null = null;

export function getMergeQueue(): MergeQueue {
  if (!_queue) _queue = new MergeQueue();
  return _queue;
}

/**
 * server.ts 가 부팅 시 1회 호출 — 이전 프로세스가 처리 중 죽어 'processing' 으로 남은 항목을
 * 'queued' 로 되돌린 뒤(reconcile) 처리 루프를 깨운다. fire-and-forget (await 불필요).
 */
export function startMergeQueue(): MergeQueue {
  const q = getMergeQueue();
  try {
    const n = reconcileStaleProcessing();
    if (n > 0) console.log(`[merge] reconciled ${n} stale processing → queued`);
  } catch (e) {
    console.warn("[merge] reconcile stale failed:", (e as Error).message);
  }
  q.kick();
  return q;
}

/** 테스트 전용 — 싱글톤 초기화. */
export function _resetMergeQueueForTest(): void {
  _queue = null;
}
