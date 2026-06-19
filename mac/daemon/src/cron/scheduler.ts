/**
 * CronScheduler — 부팅 시 enabled 작업을 croner 에 등록하고, tick 마다 runCronJob 을 호출한다.
 * 생성/수정/삭제 라우트가 reschedule/remove 로 등록을 갱신한다. daemon 종료 시 stop().
 *
 * 싱글톤 — daemon 프로세스당 하나. server.ts 가 부팅 시 startCronScheduler(), 라우트가
 * getCronScheduler() 로 reschedule 한다.
 */
import { Cron } from "croner";
import type { CronJobRow } from "../db/index.js";
import { listEnabledCronJobs, getCronJob, setNextRunAt } from "./store.js";
import { runCronJob } from "./executor.js";
import { localTimezone } from "./schedule.js";

class CronScheduler {
  private crons = new Map<string, Cron>();
  private started = false;

  start(): void {
    if (this.started) return;
    this.started = true;
    const jobs = listEnabledCronJobs();

    // catch-up: 스케줄 등록 «전» 에 판정 — schedule() 이 next_run_at 을 덮어쓰기 때문.
    // 잠자기/앱 종료로 놓친 실행을, catch_up=1 인 작업에 한해 부팅 직후 1회 보충한다.
    const now = Date.now();
    for (const job of jobs) {
      if (job.catch_up === 1 && job.next_run_at != null && job.next_run_at < now) {
        console.log(`[cron] catch-up job=${job.id} (missed next_run_at=${job.next_run_at})`);
        void runCronJob(job, "schedule").catch((e) =>
          console.warn(`[cron] catch-up failed job=${job.id}:`, (e as Error).message),
        );
      }
    }

    for (const job of jobs) this.schedule(job);
    console.log(`[cron] scheduler started — ${this.crons.size} job(s) registered`);
  }

  private schedule(job: CronJobRow): void {
    this.unschedule(job.id);
    if (job.enabled !== 1) {
      setNextRunAt(job.id, null);
      return;
    }
    try {
      const c = new Cron(
        job.schedule,
        {
          timezone: job.timezone || localTimezone(),
          name: job.id,
          // overlap='skip' 이면 croner 가 in-flight 실행 중의 tick 을 자체적으로 건너뛴다
          // (콜백이 돌려주는 promise 가 turn 완료까지 살아 있음). 'allow' 면 겹쳐 실행.
          protect: job.overlap_policy === "skip",
        },
        async () => {
          // 콜백마다 최신 job 재조회 — 등록 후 PATCH 로 바뀐 값을 stale 없이 반영.
          const fresh = getCronJob(job.id);
          if (!fresh || fresh.enabled !== 1) return;
          await runCronJob(fresh, "schedule");
        },
      );
      this.crons.set(job.id, c);
      const next = c.nextRun();
      setNextRunAt(job.id, next ? next.getTime() : null);
    } catch (e) {
      console.warn(
        `[cron] invalid schedule job=${job.id} "${job.schedule}":`,
        (e as Error).message,
      );
      setNextRunAt(job.id, null);
    }
  }

  /** 생성/수정 후 호출 — 최신 job 으로 다시 등록 (없거나 disabled 면 해제). */
  reschedule(jobId: string): void {
    const job = getCronJob(jobId);
    if (job) this.schedule(job);
    else this.unschedule(jobId);
  }

  /** 삭제 후 호출. */
  remove(jobId: string): void {
    this.unschedule(jobId);
  }

  private unschedule(jobId: string): void {
    const c = this.crons.get(jobId);
    if (c) {
      try {
        c.stop();
      } catch {
        /* already stopped */
      }
      this.crons.delete(jobId);
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

let _scheduler: CronScheduler | null = null;

export function getCronScheduler(): CronScheduler {
  if (!_scheduler) _scheduler = new CronScheduler();
  return _scheduler;
}

/** server.ts 가 부팅 시 1회 호출 — 스케줄러를 시작하고 핸들을 반환 (shutdown 에서 stop). */
export function startCronScheduler(): CronScheduler {
  const s = getCronScheduler();
  s.start();
  return s;
}
