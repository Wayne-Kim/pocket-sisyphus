/**
 * 예약 작업 한 건을 실제로 «실행» 한다.
 *
 * 핵심 통찰: 예약 실행 = 세션 1개 + 프롬프트 1번. createSession + runUserMessagePty 로
 * 평범한 세션을 만들고, pty-runner 의 turn_complete(12초 idle) 이벤트를 ptyEvents 로 기다린
 * 뒤 PTY 를 정리하고 결과를 기록한다. 결과 세션은 iOS 세션 목록에 그대로 떠서, 사용자가 열어
 * transcript 를 읽거나 대화를 이어갈 수 있다.
 *
 * 두 진입점:
 *   - runCronJob(full await)  — 스케줄러 tick. croner protect 가 turn 완료까지 promise 를
 *     붙들어 overlap 을 막을 수 있게 «끝까지» await.
 *   - startCronJob(즉시 반환)  — 「지금 실행」 라우트. 세션을 만들자마자 sessionId 를 돌려줘
 *     iOS 가 곧장 그 세션으로 딥링크. 마무리(settle/정리/알림)는 백그라운드에서 진행.
 */
import { db, type CronJobRow } from "../db/index.js";
import { getAgent, hasAgent } from "../agent/registry.js";
import type { AgentAdapter } from "../agent/types.js";
import {
  runUserMessagePty,
  runTerminalScriptPty,
  abortPtySession,
  awaitPtyExit,
  ptyEvents,
  type PtyLifecycleEvent,
} from "../agent/pty-runner.js";
import { createSession, resolveAndEnsureRepoDir } from "../routes/sessions.js";
import { dispatchCronNotification } from "../notify/index.js";
import { markCronSession, unmarkCronSession } from "./registry.js";
import { resolveScriptFile, resolveShellBinary, buildScriptSpawnArgs } from "./terminal.js";
import {
  recordRunStart,
  recordRunEnd,
  recordSkippedRun,
  updateJobRunSummary,
} from "./store.js";

/** 한 실행이 무한히 매달리지 않도록 하는 hard cap. 초과 시 PTY abort + 'timeout' 기록. */
const MAX_RUNTIME_MS = 30 * 60 * 1000;

/**
 * 지금 «실행(turn 진행) 중» 인 cron job id 집합 — overlap_policy='skip' 판정용.
 *
 * 예전엔 직전 실행 세션의 PTY 활성 여부(isPtyActive)로 overlap 을 판단했는데, 그 세션은
 * 사용자가 iOS 에서 «열어 transcript 를 보면» prewarm 으로 PTY 가 다시 살아나 실행과 무관하게
 * active 가 됐다. 그 결과 아무 실행도 진행 중이 아닌데 «직전 실행이 아직 진행 중» 으로 오판해
 * 다음 예약이 계속 건너뛰던 버그가 있었다. 이제 «이 job 의 cron 실행이 실제로 in-flight 인지»
 * 만으로 판단한다. in-memory 라 daemon 재시작 시 자동으로 비워져, 한 번의 예외로 영구
 * skip 되는 stale-lock 도 생기지 않는다 (finalizeRun 의 finally 가 항상 해제).
 */
const runningJobs = new Set<string>();

/**
 * skip 사유의 «안정적 머신 코드» — iOS 가 이 코드로 메시지를 로컬라이즈한다 (Korean 원문을
 * 그대로 내려보내 화면에 찍지 않는다). 지금은 overlap(직전 실행 진행 중) 하나뿐. 새 제약을
 * 추가하면 여기 코드를 늘리고 iOS 쪽 메시지 매핑(CronListView.skippedMessage)도 같이 채운다.
 */
export type SkipReasonCode = "overlap";

export type CronRunResult = {
  status: "ok" | "error" | "timeout" | "skipped" | "running";
  sessionId: string | null;
  runId: string | null;
  error?: string;
  /** status==='skipped' 일 때만. 어떤 사유로 건너뛰었는지 — iOS 가 로컬라이즈해서 보여준다. */
  skipReason?: SkipReasonCode;
};

/** 세션이 만들어진 한 번의 실행 — finalize 가 필요한 컨텍스트. */
type PreparedRun = {
  kind: "session";
  sessionId: string;
  runId: string;
  repoPath: string;
  resumeFrom?: string;
  adapter: AgentAdapter;
  skipPermissions: boolean;
  startedAt: number;
  /**
   * 터미널 예약이면 셸+스크립트 spawn 스펙. 있으면 finalizeRun 이 runUserMessagePty 대신
   * runTerminalScriptPty 로 실행한다. 에이전트 예약이면 undefined.
   */
  spawnOverride?: { binary: string; args: string[] };
};
/** 세션 없이 끝난 실행 (skip / 사전 에러). */
type EarlyRun = { kind: "early"; result: CronRunResult };

/** 세션을 완료/에러 상태로 마킹하고 ended_at 을 박는다 (transcript 는 보존). */
function markSessionEnded(sessionId: string, status: "completed" | "error", endedAt: number): void {
  db()
    .prepare(`UPDATE sessions SET status = ?, ended_at = ? WHERE id = ?`)
    .run(status, endedAt, sessionId);
}

/**
 * code — API 로 나가 iOS 가 로컬라이즈할 머신 코드. reason — DB(cron_runs.error)·로그에 남길
 * 사람 읽는 한국어 (실행 이력/디버그용, 화면 직접 노출 아님).
 */
function earlySkip(
  job: CronJobRow,
  trigger: "schedule" | "manual",
  at: number,
  code: SkipReasonCode,
  reason: string,
): EarlyRun {
  recordSkippedRun(job.id, trigger, at, reason);
  updateJobRunSummary(job.id, {
    lastRunAt: at,
    lastStatus: "skipped",
    lastSessionId: job.last_session_id,
  });
  console.log(`[cron] job=${job.id} skipped — ${reason}`);
  return { kind: "early", result: { status: "skipped", sessionId: null, runId: null, skipReason: code } };
}

function earlyError(job: CronJobRow, trigger: "schedule" | "manual", at: number, error: string): EarlyRun {
  const runId = recordRunStart(job.id, null, trigger, at);
  recordRunEnd(runId, "error", Date.now(), error);
  updateJobRunSummary(job.id, {
    lastRunAt: at,
    lastStatus: "error",
    lastSessionId: job.last_session_id,
    incrementRunCount: true,
  });
  console.warn(`[cron] job=${job.id} error — ${error}`);
  return { kind: "early", result: { status: "error", sessionId: null, runId, error } };
}

/**
 * 사전 점검 + 세션 생성. 던지지 않는다. skip/에러면 EarlyRun, 정상이면 PreparedRun.
 * kind 에 따라 에이전트 실행(프롬프트) / 터미널 실행(쉘 스크립트)으로 갈라진다.
 */
function prepareRun(job: CronJobRow, trigger: "schedule" | "manual"): PreparedRun | EarlyRun {
  const startedAt = Date.now();

  // overlap: 이 job 의 cron 실행이 «실제로 진행 중» 이면 skip (allow 면 통과). 두 kind 공통.
  //   직전 세션의 PTY 활성 여부가 아니라 — 그 세션은 사용자가 열어보면 다시 active 가 되어
  //   실행과 무관하게 skip 을 유발했다 — runningJobs(in-flight 집합)로만 판단한다.
  if (job.overlap_policy === "skip" && runningJobs.has(job.id)) {
    return earlySkip(job, trigger, startedAt, "overlap", "직전 실행이 아직 진행 중");
  }

  // repo 디렉토리 정규화 + mkdir -p — 두 kind 모두 이 cwd 에서 실행.
  const dir = resolveAndEnsureRepoDir(job.repo_path);
  if ("error" in dir) {
    return earlyError(job, trigger, startedAt, dir.error);
  }
  const repoPath = dir.path;

  return job.kind === "terminal"
    ? prepareTerminalRun(job, trigger, startedAt, repoPath)
    : prepareAgentRun(job, trigger, startedAt, repoPath);
}

/** 공통 마무리 — 세션을 in-flight 로 표시하고 PreparedRun 을 만든다. */
function markPrepared(
  job: CronJobRow,
  startedAt: number,
  sessionId: string,
  runId: string,
  repoPath: string,
  extra: Pick<PreparedRun, "adapter" | "resumeFrom" | "skipPermissions" | "spawnOverride">,
): PreparedRun {
  updateJobRunSummary(job.id, {
    lastRunAt: startedAt,
    lastStatus: "running",
    lastSessionId: sessionId,
  });
  // 이 job 이 실행 중임을 표시 — overlap='skip' 가 다음 tick/«지금 실행» 을 막는다.
  // finalizeRun 의 finally 가 어떤 경로로 끝나든 해제한다.
  runningJobs.add(job.id);
  return { kind: "session", sessionId, runId, repoPath, startedAt, ...extra };
}

/** 에이전트 예약 — CLI 를 띄워 프롬프트(command)를 보낸다. */
function prepareAgentRun(
  job: CronJobRow,
  trigger: "schedule" | "manual",
  startedAt: number,
  repoPath: string,
): PreparedRun | EarlyRun {
  if (!hasAgent(job.agent)) {
    return earlyError(job, trigger, startedAt, `알 수 없는 에이전트: ${job.agent}`);
  }

  // resume: 'continue' 면 직전 실행 세션의 SDK session id 를 이어받는다.
  let resumeFrom: string | undefined;
  if (job.session_mode === "continue" && job.last_session_id) {
    const prev = db()
      .prepare(`SELECT parent_sdk_session_id FROM sessions WHERE id = ?`)
      .get(job.last_session_id) as { parent_sdk_session_id: string | null } | undefined;
    resumeFrom = prev?.parent_sdk_session_id ?? undefined;
  }

  const label = (job.title && job.title.trim()) || job.command.trim().slice(0, 40);
  const title = `⏰ ${label}`;
  const skipPermissions = job.skip_permissions === 1;
  const sessionId = createSession(repoPath, title, resumeFrom, skipPermissions, job.agent);
  const runId = recordRunStart(job.id, sessionId, trigger, startedAt);
  console.log(
    `[cron] job=${job.id} run session=${sessionId} agent=${job.agent} trigger=${trigger} resume=${resumeFrom ?? "-"}`,
  );
  return markPrepared(job, startedAt, sessionId, runId, repoPath, {
    adapter: getAgent(job.agent),
    resumeFrom,
    skipPermissions,
  });
}

/** 터미널 예약 — 쉘 인터프리터로 스크립트 파일을 한 번 실행한다. */
function prepareTerminalRun(
  job: CronJobRow,
  trigger: "schedule" | "manual",
  startedAt: number,
  repoPath: string,
): PreparedRun | EarlyRun {
  // command = 스크립트 파일 절대경로. 실행 직전 다시 검증 — 생성 후 파일이 지워졌을 수 있다.
  const script = resolveScriptFile(job.command);
  if ("error" in script) {
    return earlyError(job, trigger, startedAt, script.error);
  }
  const shellBinary = resolveShellBinary(job.shell);

  // 세션은 shell 어댑터로 만든다 (PTY 부기/아이콘). resume/skipPermissions 는 터미널엔 무의미.
  const fileName = script.path.split("/").pop() || script.path;
  const label = (job.title && job.title.trim()) || fileName;
  const title = `⏰ ${label}`;
  const sessionId = createSession(repoPath, title, undefined, false, "shell");
  const runId = recordRunStart(job.id, sessionId, trigger, startedAt);
  console.log(
    `[cron] job=${job.id} run session=${sessionId} terminal shell=${shellBinary} script=${script.path} trigger=${trigger}`,
  );
  return markPrepared(job, startedAt, sessionId, runId, repoPath, {
    adapter: getAgent("shell"),
    skipPermissions: false,
    spawnOverride: { binary: shellBinary, args: buildScriptSpawnArgs(script.path) },
  });
}

/**
 * 주어진 세션의 한 턴이 «정착» 될 때까지 기다린다 — ptyEvents 의 turn_complete / session_exit /
 * error 중 첫 신호. 12초 idle 휴리스틱을 복제하지 않고 pty-runner 가 쏘는 이벤트를 구독한다.
 * MAX_RUNTIME_MS 안에 아무 신호도 없으면 'timeout'.
 */
export function waitForSessionSettle(
  sessionId: string,
): Promise<{ status: "ok" | "error" | "timeout"; error?: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const cleanup = () => {
      ptyEvents.off("turn_complete", onTurn);
      ptyEvents.off("session_exit", onExit);
      ptyEvents.off("error", onErr);
      clearTimeout(timer);
    };
    const finish = (r: { status: "ok" | "error" | "timeout"; error?: string }) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(r);
    };
    const onTurn = (e: PtyLifecycleEvent) => {
      if (e.sessionId === sessionId) finish({ status: "ok" });
    };
    // REPL 이 한 프롬프트 처리 후 스스로 종료(code 0)했으면 정상 완료로 본다.
    const onExit = (e: PtyLifecycleEvent) => {
      if (e.sessionId === sessionId) finish({ status: "ok" });
    };
    const onErr = (e: PtyLifecycleEvent) => {
      if (e.sessionId !== sessionId) return;
      const detail = e.signal
        ? `signal ${e.signal}`
        : e.exitCode != null
          ? `exit ${e.exitCode}`
          : "error";
      finish({ status: "error", error: detail });
    };
    ptyEvents.on("turn_complete", onTurn);
    ptyEvents.on("session_exit", onExit);
    ptyEvents.on("error", onErr);
    const timer = setTimeout(() => finish({ status: "timeout" }), MAX_RUNTIME_MS);
  });
}

/**
 * 프롬프트를 쏘고 → 정착을 기다리고 → PTY 회수 + 결과 기록 + 알림. 항상 resolve.
 * job 은 알림 발사 여부(notify) 판단에만 쓴다.
 */
async function finalizeRun(prep: PreparedRun, job: CronJobRow): Promise<CronRunResult> {
  const { sessionId, runId, repoPath, resumeFrom, adapter, skipPermissions, startedAt, spawnOverride } = prep;

  // 실행 중인 동안 일반 알림 억제 — 끝에 cron 전용 알림 한 번만.
  markCronSession(sessionId);

  try {
    let result: { status: "ok" | "error" | "timeout"; error?: string };
    try {
      // 완료 신호를 먼저 구독한 뒤 실행을 시작한다 (race 방지). 두 경로 모두 내부에서 ensurePty
      // → (실패 시 emitSpawnFailure → ptyEvents 'error') 를 처리하므로 spawn 실패도 settle 로 흡수.
      const settle = waitForSessionSettle(sessionId);
      if (spawnOverride) {
        // 터미널: 셸+스크립트를 spawn 하고 종료(session_exit/error)를 기다린다 — turn_complete 없음.
        runTerminalScriptPty({ sessionId, cwd: repoPath, adapter, spawnOverride });
      } else {
        // 에이전트: 프롬프트를 쏘고 turn 정착(turn_complete / exit)을 기다린다.
        void runUserMessagePty(
          { sessionId, cwd: repoPath, adapter, resumeFrom },
          job.command,
          { bypassPermissions: skipPermissions },
        ).catch((e) => {
          console.warn(`[cron] runUserMessagePty failed session=${sessionId}:`, (e as Error).message);
        });
      }
      result = await settle;
    } catch (e) {
      result = { status: "error", error: (e as Error).message };
    }

    // PTY 회수 (transcript 는 messages 에 보존) + 상태 기록
    abortPtySession(sessionId);
    await awaitPtyExit(sessionId, 4000);
    unmarkCronSession(sessionId);

    const endedAt = Date.now();
    markSessionEnded(sessionId, result.status === "error" ? "error" : "completed", endedAt);
    recordRunEnd(runId, result.status, endedAt, result.error ?? null);
    updateJobRunSummary(job.id, {
      lastRunAt: startedAt,
      lastStatus: result.status,
      lastSessionId: sessionId,
      incrementRunCount: true,
    });
    console.log(
      `[cron] job=${job.id} done session=${sessionId} status=${result.status}${result.error ? ` (${result.error})` : ""}`,
    );

    if (job.notify === 1) {
      void dispatchCronNotification({
        sessionId,
        status: result.status,
        elapsedMs: endedAt - startedAt,
      });
    }

    return { status: result.status, sessionId, runId, error: result.error };
  } finally {
    // 정상/에러/예외 어떤 경로로 끝나든 in-flight 표시 해제 — 안 그러면 한 번의 예외로
    // 이 job 이 영구히 skip 되는 stale-lock 이 생긴다.
    runningJobs.delete(job.id);
  }
}

/**
 * 예약 작업을 «끝까지» 실행 (스케줄러 tick). turn 완료까지 await 하므로 croner protect 가
 * overlap 을 막을 수 있다. 항상 resolve — 던지지 않는다.
 */
export async function runCronJob(
  job: CronJobRow,
  trigger: "schedule" | "manual",
): Promise<CronRunResult> {
  const prep = prepareRun(job, trigger);
  if (prep.kind === "early") return prep.result;
  return finalizeRun(prep, job);
}

/**
 * 예약 작업을 시작하고 «즉시» 반환 (「지금 실행」 라우트). 세션을 만들자마자 sessionId 를
 * 돌려주고, 마무리는 백그라운드에서 진행한다. skip/에러면 그 결과를 그대로 반환.
 */
export function startCronJob(job: CronJobRow, trigger: "schedule" | "manual"): CronRunResult {
  const prep = prepareRun(job, trigger);
  if (prep.kind === "early") return prep.result;
  void finalizeRun(prep, job).catch((e) =>
    console.warn(`[cron] finalizeRun failed job=${job.id}:`, (e as Error).message),
  );
  return { status: "running", sessionId: prep.sessionId, runId: prep.runId };
}
