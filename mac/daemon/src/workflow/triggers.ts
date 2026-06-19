/**
 * WorkflowTriggerScheduler — 시작 노드의 트리거를 등록/감시해 워크플로우 run 을 시작한다.
 *
 * 트리거 3종 (docs/ARCHITECTURE.md §12.3):
 *   - manual : 등록 안 함 (iOS 「실행」 버튼이 직접 POST /run). workflow_triggers 행도 안 만든다.
 *   - cron   : croner 인스턴스 — 정해진 시각에 startWorkflowRun(wf, "cron"). CronScheduler 와 같은 패턴.
 *   - github : 폴 기반 — daemon 은 공개 webhook 이 없으므로 감시 브랜치를 git ls-remote 로 주기 확인,
 *              마지막 본 SHA 와 달라지면 startWorkflowRun(wf, "github"). (poll_seconds, 하한 60s)
 *
 * 정의(시작 노드 node.triggers)가 source-of-truth. 워크플로우 저장(POST/PUT) 시 reconcile 로
 * workflow_triggers 행 + croner 등록을 다시 만든다. 부팅 시 모든 워크플로우를 reconcile.
 */
import { Cron } from "croner";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import {
  getWorkflow,
  listWorkflows,
  listTriggers,
  listTriggersForWorkflow,
  deleteTriggersForWorkflow,
  insertTrigger,
  updateTriggerRuntime,
} from "./store.js";
import { parseDef } from "./types.js";
import { startWorkflowRun } from "./engine.js";
import { localTimezone } from "../cron/schedule.js";
import type { WorkflowTriggerRow } from "../db/index.js";

const execFileAsync = promisify(execFile);

/** github 폴 간격 하한 (초) — 너무 잦은 fetch 방지. */
const GITHUB_MIN_POLL_SECONDS = 60;
/** github 폴 루프 tick (ms) — 개별 트리거는 자기 next_check_at 으로 게이팅된다. */
const GITHUB_TICK_MS = 30_000;

class WorkflowTriggerScheduler {
  private crons = new Map<string, Cron>(); // trigger id → Cron
  private githubTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;

  start(): void {
    if (this.started) return;
    this.started = true;
    // 정의(node.triggers)에서 모든 워크플로우의 트리거를 재생성 — 부팅 전 만들어진 워크플로우도 등록.
    // (workflow_triggers 행은 정의에서 파생되는 캐시라, 부팅 시 def 기준으로 다시 만든다.)
    for (const wf of listWorkflows()) this.reconcile(wf.id);
    this.githubTimer = setInterval(() => void this.pollGithub(), GITHUB_TICK_MS);
    console.log(`[workflow] trigger scheduler started — ${this.crons.size} cron trigger(s)`);
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
    if (this.githubTimer) {
      clearInterval(this.githubTimer);
      this.githubTimer = null;
    }
    this.started = false;
  }

  /** 워크플로우 저장 후 호출 — 그 워크플로우의 트리거 행 + croner 등록을 정의에서 다시 만든다. */
  reconcile(workflowId: string): void {
    // 기존 등록 해제 + 행 삭제.
    for (const t of listTriggersForWorkflow(workflowId)) this.unregister(t.id);
    deleteTriggersForWorkflow(workflowId);

    const wf = getWorkflow(workflowId);
    if (!wf || wf.enabled !== 1) return;
    const def = parseDef(wf.nodes, wf.edges);
    for (const n of def.nodes) {
      if (n.type !== "start" || !n.triggers) continue;
      for (const tr of n.triggers) {
        if (tr.kind !== "cron" && tr.kind !== "github") continue; // manual 은 등록 안 함
        const row = insertTrigger({
          workflowId,
          startNodeId: n.id,
          kind: tr.kind,
          schedule: tr.schedule ?? null,
          timezone: tr.timezone ?? null,
          repoPath: tr.repo_path ?? null,
          branch: tr.branch ?? null,
          pollSeconds: tr.poll_seconds ?? null,
        });
        this.register(row);
      }
    }
  }

  /** 워크플로우 삭제 직전 호출 — croner 등록 해제 (행은 ON DELETE CASCADE). */
  removeWorkflow(workflowId: string): void {
    for (const t of listTriggersForWorkflow(workflowId)) this.unregister(t.id);
  }

  private register(t: WorkflowTriggerRow): void {
    if (t.enabled !== 1) return;
    if (t.kind === "cron" && t.schedule) {
      try {
        const c = new Cron(
          t.schedule,
          { timezone: t.timezone || localTimezone(), name: t.id, protect: true },
          async () => {
            const wf = getWorkflow(t.workflow_id);
            if (!wf || wf.enabled !== 1) return;
            startWorkflowRun(wf, "cron");
          },
        );
        this.crons.set(t.id, c);
      } catch (e) {
        console.warn(`[workflow] invalid cron trigger ${t.id} "${t.schedule}":`, (e as Error).message);
      }
    } else if (t.kind === "github") {
      // 다음 폴 루프에서 즉시 baseline 을 잡도록 next_check_at 을 now 로.
      updateTriggerRuntime(t.id, { nextCheckAt: Date.now() });
    }
  }

  private unregister(id: string): void {
    const c = this.crons.get(id);
    if (c) {
      try {
        c.stop();
      } catch {
        /* already stopped */
      }
      this.crons.delete(id);
    }
  }

  /** github 트리거 폴 — next_check_at 도래분만 git ls-remote 로 SHA 비교, 변하면 발사. */
  private async pollGithub(): Promise<void> {
    const now = Date.now();
    for (const t of listTriggers()) {
      if (t.kind !== "github" || t.enabled !== 1 || !t.repo_path) continue;
      if (t.next_check_at != null && t.next_check_at > now) continue;
      const intervalMs = Math.max(GITHUB_MIN_POLL_SECONDS, t.poll_seconds ?? 300) * 1000;
      updateTriggerRuntime(t.id, { nextCheckAt: now + intervalMs });

      const sha = await remoteHeadSha(t.repo_path, t.branch);
      if (!sha) continue;
      if (t.last_sha == null) {
        // 첫 관측 — baseline 만 기록하고 발사 안 함 (등록 즉시 폭주 방지).
        updateTriggerRuntime(t.id, { lastSha: sha });
        continue;
      }
      if (t.last_sha !== sha) {
        const wf = getWorkflow(t.workflow_id);
        if (wf && wf.enabled === 1) {
          console.log(`[workflow] github trigger ${t.id} fired — ${t.last_sha.slice(0, 7)}→${sha.slice(0, 7)}`);
          startWorkflowRun(wf, "github");
        }
        updateTriggerRuntime(t.id, { lastSha: sha, lastFiredAt: now });
      }
    }
  }
}

/** 감시 브랜치의 원격 HEAD SHA — git ls-remote (fetch 불필요). 실패 시 null. */
async function remoteHeadSha(repoPath: string, branch: string | null): Promise<string | null> {
  try {
    if (!fs.existsSync(repoPath)) return null;
    const ref = branch && branch.trim() ? `refs/heads/${branch.trim()}` : "HEAD";
    const { stdout } = await execFileAsync("git", ["-C", repoPath, "ls-remote", "origin", ref], {
      timeout: 15000,
      maxBuffer: 256 * 1024,
    });
    const first = stdout.split("\n").find((l) => l.trim().length > 0);
    const sha = first?.split(/\s+/)[0]?.trim();
    return sha && /^[0-9a-f]{7,40}$/i.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

let _scheduler: WorkflowTriggerScheduler | null = null;

export function getWorkflowTriggerScheduler(): WorkflowTriggerScheduler {
  if (!_scheduler) _scheduler = new WorkflowTriggerScheduler();
  return _scheduler;
}

export function startWorkflowTriggerScheduler(): WorkflowTriggerScheduler {
  const s = getWorkflowTriggerScheduler();
  s.start();
  return s;
}
