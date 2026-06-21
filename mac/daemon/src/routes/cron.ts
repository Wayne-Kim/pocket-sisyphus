/**
 * `/api/cron` — 예약 작업(cron) CRUD + 미리보기 + 「지금 실행」.
 *
 *   GET    /api/cron            → 전체 작업 목록
 *   POST   /api/cron            → 작업 생성 (식/agent/repo 검증 후 스케줄 등록)
 *   GET    /api/cron/:id        → 작업 + 최근 실행 이력
 *   PATCH  /api/cron/:id        → 부분 수정 / enabled 토글 → 재스케줄
 *   DELETE /api/cron/:id        → 삭제 + 스케줄 해제
 *   POST   /api/cron/:id/run    → 즉시 실행 (manual) → { sessionId }
 *   POST   /api/cron/preview    → { schedule, timezone } → { valid, nextRuns }
 *
 * 모든 라우트 bearerAuth. iOS 가 관리 UI 의 단일 소비자 (Mac 은 실행만).
 */
import { Hono } from "hono";
import { bearerAuth } from "../auth.js";
import { hasAgent } from "../agent/registry.js";
import { resolveAndEnsureRepoDir } from "./sessions.js";
import { validateSchedule, nextRuns } from "../cron/schedule.js";
import {
  listCronJobs,
  getCronJob,
  insertCronJob,
  updateCronJob,
  deleteCronJob,
  recentRuns,
  type CronJobInput,
  type CronJobPatch,
} from "../cron/store.js";
import { getCronScheduler } from "../cron/scheduler.js";
import { startCronJob } from "../cron/executor.js";
import { resolveScriptFile, normalizeShell } from "../cron/terminal.js";
import { guardUnattendedRepo } from "../mcp/unattended.js";

export const cron = new Hono();
cron.use("*", bearerAuth);

const SESSION_MODES = new Set(["fresh", "continue"]);
const OVERLAP_POLICIES = new Set(["skip", "allow"]);
const KINDS = new Set(["agent", "terminal"]);

function asBool(v: unknown, dflt: boolean): boolean {
  return typeof v === "boolean" ? v : dflt;
}
function nonEmptyString(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

cron.get("/", (c) => {
  return c.json({ jobs: listCronJobs() });
});

cron.post("/", async (c) => {
    const body = await c.req.json().catch(() => ({}));

    const kind = body.kind === "terminal" ? "terminal" : "agent";

    // 스케줄/repo 는 두 종류 공통.
    const schedule = nonEmptyString(body.schedule);
    if (!schedule) return c.json({ error: "schedule required" }, 400);
    const timezone = nonEmptyString(body.timezone);
    const sched = validateSchedule(schedule, timezone);
    if (!sched.valid) {
      return c.json({ error: "invalid_schedule", message: sched.error }, 400);
    }

    const repoInput = nonEmptyString(body.repoPath);
    if (!repoInput) return c.json({ error: "repoPath required" }, 400);
    const dir = resolveAndEnsureRepoDir(repoInput);
    if ("error" in dir) {
      return c.json({ error: "repo_dir_failed", message: dir.error }, 400);
    }

    // 무인 trifecta 정적 거부(capability_caps C1/M3) — 이 repo 에 EGRESS·SOURCE_WRITE MCP 가
    // 연결돼 있으면 무인 cron 을 «아예 만들 수 없다»(개인-데이터+외부통신 동시 불가). iOS 가
    // 코드로 로컬라이즈한다.
    const guard = guardUnattendedRepo(dir.path);
    if (!guard.ok) {
      return c.json({ error: guard.code, capped: guard.capped }, 409);
    }

    // 종류별 실행 스펙: 에이전트면 agent+프롬프트, 터미널이면 shell+스크립트 파일.
    const spec = resolveExecSpec(kind, body);
    if ("error" in spec) return c.json(spec.error, 400);

    const overlapPolicy = OVERLAP_POLICIES.has(body.overlapPolicy) ? body.overlapPolicy : "skip";

    const input: CronJobInput = {
      title: nonEmptyString(body.title),
      kind,
      agent: spec.agent,
      repoPath: dir.path,
      command: spec.command,
      shell: spec.shell,
      schedule,
      timezone,
      // 무인 실행 기본값 — 도구 자동 승인 ON (안 하면 승인 대기로 멈춤). 터미널은 무의미라 false.
      skipPermissions: spec.skipPermissions,
      sessionMode: spec.sessionMode,
      overlapPolicy,
      catchUp: asBool(body.catchUp, false),
      notify: asBool(body.notify, true),
      enabled: asBool(body.enabled, true),
    };
    const job = insertCronJob(input);
    getCronScheduler().reschedule(job.id);
    // reschedule 이 next_run_at 을 채웠으니 최신 row 를 다시 읽어 반환.
    return c.json({ job: getCronJob(job.id) }, 201);
});

/**
 * 생성 body 에서 종류별 실행 스펙을 뽑고 검증한다. 에러는 {error: <c.json 인자>} 로 반환.
 * - agent: command=프롬프트(필수), agent=등록된 CLI(필수), skipPermissions/sessionMode 사용.
 * - terminal: command=스크립트 파일 절대경로(존재 검증), agent='shell' 고정, shell 인터프리터.
 */
type ExecSpec = {
  agent: string;
  command: string;
  shell: string | null;
  skipPermissions: boolean;
  sessionMode: "fresh" | "continue";
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function resolveExecSpec(
  kind: "agent" | "terminal",
  body: any,
): ExecSpec | { error: Record<string, unknown> } {
  if (kind === "terminal") {
    const scriptInput = nonEmptyString(body.command);
    if (!scriptInput) return { error: { error: "script required" } };
    const script = resolveScriptFile(scriptInput);
    if ("error" in script) return { error: { error: "script_invalid", message: script.error } };
    return {
      agent: "shell",
      command: script.path,
      shell: normalizeShell(body.shell), // null → 사용자 기본 셸
      skipPermissions: false,
      sessionMode: "fresh",
    };
  }
  const command = nonEmptyString(body.command);
  if (!command) return { error: { error: "command required" } };
  const agent = nonEmptyString(body.agent);
  if (!agent || !hasAgent(agent)) return { error: { error: `unknown agent: ${agent ?? ""}` } };
  return {
    agent,
    command,
    shell: null,
    skipPermissions: asBool(body.skipPermissions, true),
    sessionMode: SESSION_MODES.has(body.sessionMode) ? body.sessionMode : "fresh",
  };
}

cron.get("/:id", (c) => {
  const id = c.req.param("id");
  const job = getCronJob(id);
  if (!job) return c.json({ error: "not_found" }, 404);
  return c.json({ job, runs: recentRuns(id, 20) });
});

cron.patch("/:id", async (c) => {
    const id = c.req.param("id");
    const existing = getCronJob(id);
    if (!existing) return c.json({ error: "not_found" }, 404);
    const body = await c.req.json().catch(() => ({}));
    const patch: CronJobPatch = {};

    if ("title" in body) patch.title = nonEmptyString(body.title);

    // 실행 스펙(종류/명령/에이전트/셸) 편집 — bare enabled 토글 등은 건드리지 않는다.
    if ("kind" in body || "command" in body || "agent" in body || "shell" in body) {
      let effectiveKind: "agent" | "terminal" = existing.kind;
      if ("kind" in body) {
        if (!KINDS.has(body.kind)) return c.json({ error: "invalid kind" }, 400);
        patch.kind = body.kind;
        effectiveKind = body.kind;
      }
      if (effectiveKind === "terminal") {
        // 터미널: command=스크립트 파일(존재 검증), agent='shell' 고정, shell 인터프리터.
        if ("command" in body) {
          const scriptInput = nonEmptyString(body.command);
          if (!scriptInput) return c.json({ error: "script required" }, 400);
          const script = resolveScriptFile(scriptInput);
          if ("error" in script) {
            return c.json({ error: "script_invalid", message: script.error }, 400);
          }
          patch.command = script.path;
        }
        patch.agent = "shell";
        if ("shell" in body) patch.shell = normalizeShell(body.shell);
      } else {
        // 에이전트: command=프롬프트, agent 검증, shell 비움.
        if ("command" in body) {
          const command = nonEmptyString(body.command);
          if (!command) return c.json({ error: "command required" }, 400);
          patch.command = command;
        }
        if ("agent" in body) {
          const agent = nonEmptyString(body.agent);
          if (!agent || !hasAgent(agent)) {
            return c.json({ error: `unknown agent: ${agent ?? ""}` }, 400);
          }
          patch.agent = agent;
        }
        patch.shell = null;
      }
    }
    if ("repoPath" in body) {
      const repoInput = nonEmptyString(body.repoPath);
      if (!repoInput) return c.json({ error: "repoPath required" }, 400);
      const dir = resolveAndEnsureRepoDir(repoInput);
      if ("error" in dir) {
        return c.json({ error: "repo_dir_failed", message: dir.error }, 400);
      }
      patch.repoPath = dir.path;
    }
    if ("sessionMode" in body) {
      if (!SESSION_MODES.has(body.sessionMode)) {
        return c.json({ error: "invalid sessionMode" }, 400);
      }
      patch.sessionMode = body.sessionMode;
    }
    if ("overlapPolicy" in body) {
      if (!OVERLAP_POLICIES.has(body.overlapPolicy)) {
        return c.json({ error: "invalid overlapPolicy" }, 400);
      }
      patch.overlapPolicy = body.overlapPolicy;
    }
    if ("skipPermissions" in body) patch.skipPermissions = asBool(body.skipPermissions, true);
    if ("catchUp" in body) patch.catchUp = asBool(body.catchUp, false);
    if ("notify" in body) patch.notify = asBool(body.notify, true);
    if ("enabled" in body) patch.enabled = asBool(body.enabled, true);
    if ("schedule" in body) {
      const schedule = nonEmptyString(body.schedule);
      if (!schedule) return c.json({ error: "schedule required" }, 400);
      patch.schedule = schedule;
    }
    if ("timezone" in body) patch.timezone = nonEmptyString(body.timezone);

    // 식/타임존이 바뀌면 «합쳐진» 값으로 검증 (한쪽만 바뀌어도 정확히 본다).
    if (patch.schedule !== undefined || patch.timezone !== undefined) {
      const effSchedule = patch.schedule ?? existing.schedule;
      const effTz = patch.timezone !== undefined ? patch.timezone : existing.timezone;
      const sched = validateSchedule(effSchedule, effTz);
      if (!sched.valid) {
        return c.json({ error: "invalid_schedule", message: sched.error }, 400);
      }
    }

    // 무인 trifecta 정적 거부(capability_caps C1/M3) — 「합쳐진」 결과가 enabled 인데 그 repo 에
    // EGRESS·SOURCE_WRITE MCP 가 연결돼 있으면 거부(disabled 토글·repo 변경 모두 커버). 이미
    // disabled 로 끄는 패치는 막지 않는다(무인 실행이 아니므로).
    const effEnabled = patch.enabled !== undefined ? patch.enabled : existing.enabled === 1;
    if (effEnabled) {
      const effRepo = patch.repoPath ?? existing.repo_path;
      const guard = guardUnattendedRepo(effRepo);
      if (!guard.ok) {
        return c.json({ error: guard.code, capped: guard.capped }, 409);
      }
    }

    const job = updateCronJob(id, patch);
    if (!job) return c.json({ error: "not_found" }, 404);
    getCronScheduler().reschedule(id);
    return c.json({ job: getCronJob(id) });
});

cron.delete("/:id", (c) => {
  const id = c.req.param("id");
  const ok = deleteCronJob(id);
  if (!ok) return c.json({ error: "not_found" }, 404);
  getCronScheduler().remove(id);
  return c.json({ ok: true });
});

// 즉시 실행 — disabled 작업도 사용자가 명시적으로 누른 거라 실행한다. 세션이 만들어지면
// sessionId 를 즉시 반환 → iOS 가 그 세션으로 딥링크. skip/사전에러면 그 상태를 반환.
cron.post("/:id/run", (c) => {
  const id = c.req.param("id");
  const job = getCronJob(id);
  if (!job) return c.json({ error: "not_found" }, 404);
  const result = startCronJob(job, "manual");
  return c.json(result);
});

// 미리보기 — 식이 바뀔 때마다 iOS 에디터가 디바운스로 호출. 다음 실행 timestamp 만 돌려주고
// 사람 가독 포맷은 iOS 가 로케일에 맞춰 한다.
cron.post("/preview", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const schedule = nonEmptyString(body.schedule);
    const timezone = nonEmptyString(body.timezone);
    if (!schedule) return c.json({ valid: false, error: "schedule required", nextRuns: [] });
    const sched = validateSchedule(schedule, timezone);
    if (!sched.valid) {
      return c.json({ valid: false, error: sched.error, nextRuns: [] });
    }
    return c.json({ valid: true, nextRuns: nextRuns(schedule, timezone, 3) });
});
