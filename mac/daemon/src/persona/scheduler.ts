/**
 * PoScheduler — 주기 수집 («매일 아침 신호 수집+종합» 프리셋).
 *
 * po_profiles.schedule (5필드 cron 식, NULL=꺼짐) 을 부팅 시 croner 에 등록하고, tick 마다
 * startPoCollection 을 호출한다. CronScheduler 와 같은 골격의 싱글톤이되 등록 단위가
 * cron_jobs row 가 아니라 «repo» 라는 점만 다르다 — 수집 파이프(프롬프트/ingest/알림)는
 * 수동 «지금 수집» 과 완전히 동일해서 새 실행 경로가 없다.
 *
 * overlap 정책: 같은 repo 의 수집이 아직 진행 중이면 이번 tick 은 건너뛴다 (skip 고정 —
 * 수집은 멱등에 가깝고 겹쳐 돌릴 이유가 없다). catch-up 없음 — 놓친 아침 수집을 부팅
 * 직후 보충하면 «컴퓨터 켜자마자 에이전트가 돌기 시작» 하는 놀람이 더 크다.
 */
import { Cron } from "croner";
import { db } from "../db/index.js";
import { localTimezone } from "../cron/schedule.js";
import {
  startPoCollection,
  isPoCollectionRunning,
  recordScheduledCollectOutcome,
} from "./executor.js";

class PoScheduler {
  private crons = new Map<string, Cron>(); // key = repo_path
  private started = false;

  start(): void {
    if (this.started) return;
    this.started = true;
    const rows = db()
      .prepare(`SELECT repo_path, schedule FROM po_profiles WHERE schedule IS NOT NULL`)
      .all() as Array<{ repo_path: string; schedule: string }>;
    for (const row of rows) this.schedule(row.repo_path, row.schedule);
    console.log(`[po] scheduler started — ${this.crons.size} repo(s) registered`);
  }

  private schedule(repoPath: string, schedule: string): void {
    this.unschedule(repoPath);
    try {
      const c = new Cron(schedule, { timezone: localTimezone(), name: `po:${repoPath}` }, () => {
        // 콜백마다 최신 프로필 재조회 — 등록 후 PUT 으로 바뀐/꺼진 값을 stale 없이 반영.
        const fresh = db()
          .prepare(`SELECT schedule FROM po_profiles WHERE repo_path = ?`)
          .get(repoPath) as { schedule: string | null } | undefined;
        if (!fresh?.schedule) return;
        if (isPoCollectionRunning(repoPath)) {
          // overlap=skip — 직전 수집이 아직 진행 중. 이건 «실패» 가 아니다 (멱등에 가까운 수집을
          // 겹쳐 돌릴 이유가 없을 뿐) → 결말 통지도 하지 않는다 (엣지케이스: skip≠failure).
          console.log(`[po] scheduled collect skipped repo=${repoPath} — 직전 수집이 아직 진행 중`);
          return;
        }
        const result = startPoCollection(repoPath, undefined, undefined, undefined, undefined, "scheduled");
        if (result.status === "error") {
          console.warn(`[po] scheduled collect failed repo=${repoPath}: ${result.error}`);
          // 시작 자체가 실패(에이전트 없음·무인 trifecta 캡·repo 해석 실패 등) — 예전엔 콘솔 경고만
          // 남고 무인 사용자에겐 보이지 않았다. 결말을 «failed» 로 표면화한다 (앱 카드 + 억제 안 되면
          // 알림). 세션이 없어 sessionId=null — 알림 딥링크는 백로그 탭으로 폴백한다.
          void recordScheduledCollectOutcome({
            repoPath,
            sessionId: null,
            status: "error",
            briefCount: 0,
            errorSummary: result.error,
          });
        } else {
          console.log(`[po] scheduled collect repo=${repoPath} session=${result.sessionId}`);
        }
      });
      this.crons.set(repoPath, c);
    } catch (e) {
      console.warn(`[po] invalid schedule repo=${repoPath} "${schedule}":`, (e as Error).message);
    }
  }

  /** 프로필 PUT 후 호출 — 최신 schedule 로 다시 등록 (NULL/행 삭제면 해제). */
  reschedule(repoPath: string): void {
    const row = db()
      .prepare(`SELECT schedule FROM po_profiles WHERE repo_path = ?`)
      .get(repoPath) as { schedule: string | null } | undefined;
    if (row?.schedule) this.schedule(repoPath, row.schedule);
    else this.unschedule(repoPath);
  }

  private unschedule(repoPath: string): void {
    const c = this.crons.get(repoPath);
    if (c) {
      try {
        c.stop();
      } catch {
        /* already stopped */
      }
      this.crons.delete(repoPath);
    }
  }

  stop(): void {
    for (const c of this.crons.values()) {
      try {
        c.stop();
      } catch {
        /* best-effort */
      }
    }
    this.crons.clear();
    this.started = false;
  }
}

let _scheduler: PoScheduler | null = null;

export function getPoScheduler(): PoScheduler {
  if (!_scheduler) _scheduler = new PoScheduler();
  return _scheduler;
}

/** server.ts 가 부팅 시 1회 호출 — 스케줄러를 시작하고 핸들을 반환 (shutdown 에서 stop). */
export function startPoScheduler(): PoScheduler {
  const s = getPoScheduler();
  s.start();
  return s;
}
