/**
 * 알림 디스패치 — PTY runner 등이 «턴 끝남 / 세션 종료 / 에러» 이벤트를 던지면 설정된
 * 채널(현재 Discord webhook)로 보낸다.
 *
 * 정책:
 *  - 설정이 없거나 disabled 면 no-op.
 *  - 이벤트별 on/off (config.notify.discord.events) 존중.
 *  - **away-gating**: 폰이 그 세션을 실시간 구독 중이면 보내지 않는다 — 이미 화면에서 봄.
 *  - 절대 throw 하지 않는다 — 알림 실패가 PTY 흐름을 깨면 안 됨.
 *
 * 호출부(pty-runner)는 sessionId + 최소 정보만 넘기고, 여기서 DB + agent registry 로
 * repo 이름 / 세션 제목 / 에이전트 표시 이름을 보강한다.
 */
import path from "node:path";
import { readConfig, type DiscordNotifyConfig } from "../config.js";
import { hasActiveSubscriber } from "../ws/hub.js";
import { db } from "../db/index.js";
import { getAgent, hasAgent } from "../agent/registry.js";
import { isCronSessionActive } from "../cron/registry.js";
import {
  buildDiscordBody,
  postDiscordWebhook,
  type DiscordPostResult,
  type NotifyEventKind,
} from "./discord.js";
import {
  extractAgentPreview,
  redactSecretsForPreview,
  isFullyRedacted,
  PREVIEW_ALL_REDACTED,
} from "./preview.js";
import { type CollectSignals, type SignalSourceState, isSignalFailure } from "../persona/signals.js";

/** Discord 완료 알림용 — 한 신호원 상태의 영어 라벨. off/empty 는 «조용» 대상이라 호출처가 거른다. */
function signalStateLabel(s: SignalSourceState): string {
  switch (s.state) {
    case "used":
      return `${s.count} used`;
    case "empty":
      return "no new data";
    case "off":
      return "off";
    case "key_missing":
      return "key not set";
    case "auth":
      return "key/permission error";
    case "app_id":
      return "app id error";
    case "network":
      return "network error";
  }
}

/**
 * CollectSignals → Discord 완료 알림 «Signals» 필드 한 줄. used 와 실패만 싣는다 — off(안 켬)·
 * empty(정상 빈)뿐이면 빈 문자열을 돌려 필드 자체가 안 뜨게 한다(거짓 경고 금지). 영어 고정
 * (webhook 은 비-로컬라이즈 표면). 예: "Store reviews: 12 used · Crashes: network error".
 */
export function formatSignalsLine(sig: CollectSignals): string {
  const parts: string[] = [];
  const consider = (label: string, s: SignalSourceState): void => {
    if (s.state === "used" || isSignalFailure(s)) {
      parts.push(`${label}: ${signalStateLabel(s)}`);
    }
  };
  consider("Store reviews", sig.store);
  consider("Crashes", sig.crash);
  return parts.join(" · ");
}

export type DispatchEvent = {
  kind: Exclude<NotifyEventKind, "test">;
  sessionId: string;
  /** turn 소요 시간(ms) — turn_complete 에서만. */
  elapsedMs?: number;
  /** 응답을 기다린 시간(ms) — still_waiting 에서만. */
  waitingMs?: number;
  /** 비정상 종료 시 exit code. */
  exitCode?: number | null;
  /** 비정상 종료 시 signal. */
  signal?: string | null;
  /**
   * 직전 에이전트 출력의 raw tail (PTY 바이트, ANSI 포함). turn_complete / still_waiting 만
   * 싣는다. config.notify.discord.includePreview 옵트인이 켜져 있을 때만 여기서 한 줄
   * 미리보기로 추출해 본문에 더한다 — 꺼져 있으면 raw tail 은 추출/전송되지 않고 버려진다.
   */
  outputTail?: string;
};

export function eventEnabled(
  kind: DispatchEvent["kind"],
  events: DiscordNotifyConfig["events"],
): boolean {
  if (!events) return true; // 설정 누락 = 전부 켜짐
  if (kind === "turn_complete") return events.turnComplete !== false;
  // still_waiting 은 turn_complete 의 에스컬레이션 — 같은 토글을 따른다 (별도 설정 UI 없음).
  if (kind === "still_waiting") return events.turnComplete !== false;
  if (kind === "session_exit") return events.sessionExit !== false;
  if (kind === "error") return events.error !== false;
  return true;
}

/**
 * 이벤트를 설정된 채널로 디스패치. fire-and-forget 으로 호출 — await 불필요하지만
 * await 해도 throw 하지 않는다.
 */
export async function dispatchNotification(ev: DispatchEvent): Promise<void> {
  try {
    const cfg = readConfig();
    const d = cfg?.notify?.discord;
    if (!d || !d.enabled || !d.webhookUrl) return;
    if (!eventEnabled(ev.kind, d.events)) return;

    // 예약 실행이 진행 중인 세션은 일반 알림을 억제 — executor 가 끝에 cron 전용 알림을
    // 한 번만 보낸다 (한 완료에 알림 두 번 나가는 것 방지). 실행이 끝나면 unmark 되어
    // 사용자가 그 세션을 직접 이어 대화할 땐 다시 정상 알림.
    if (isCronSessionActive(ev.sessionId)) return;

    // away-gating — 폰이 이 세션을 실시간으로 보고 있으면 보내지 않는다.
    if (hasActiveSubscriber(ev.sessionId)) return;

    // DB + registry 로 사람 가독 정보 보강. 실패해도 fallback 으로 진행.
    let repoPath = "";
    let title: string | null = null;
    let agentId = "";
    try {
      const row = db()
        .prepare("SELECT repo_path, title, agent, notify_muted FROM sessions WHERE id = ?")
        .get(ev.sessionId) as
        | { repo_path: string; title: string | null; agent: string; notify_muted: number }
        | undefined;
      // 세션 단위 음소거 — iOS bell 토글이 PATCH 로 세팅. 모든 이벤트 종류에 적용된다.
      // (조회 실패 시엔 fail-open — 알림은 best-effort 로 나간다.)
      if (row && row.notify_muted === 1) return;
      if (row) {
        repoPath = row.repo_path;
        title = row.title;
        agentId = row.agent;
      }
    } catch {
      /* best-effort — repo 이름 없이도 알림은 의미 있음 */
    }

    const agentName =
      agentId && hasAgent(agentId) ? getAgent(agentId).displayName : agentId || "agent";
    const repoName = repoPath ? path.basename(repoPath) : "—";

    // 미리보기는 옵트인(includePreview) 일 때만. 추출은 절대 throw 하지 않게 감싸 — 실패해도
    // preview=null 로 폴백(정적 안내문)하고 알림 자체는 항상 나간다. raw tail 은 옵트아웃이면
    // 아예 추출하지 않아 외부로 새지 않는다.
    let preview: string | null = null;
    if (d.includePreview && ev.outputTail) {
      try {
        preview = extractAgentPreview(ev.outputTail);
        // 외부(제3자 Discord)로 나가기 «직전» 에만 흔한 비밀 패턴을 가린다 — best-effort
        // 휴리스틱(완벽한 DLP 아님). in-app 대기 미리보기 등 다른 extractAgentPreview
        // 소비자엔 영향 0: 마스킹은 추출 함수 안이 아니라 이 송신 경로에서만 건다.
        if (preview) {
          const redacted = redactSecretsForPreview(preview);
          preview = isFullyRedacted(redacted) ? PREVIEW_ALL_REDACTED : redacted;
        }
      } catch {
        preview = null;
      }
    }

    const body = buildDiscordBody({
      kind: ev.kind,
      repoName,
      repoPath,
      agentName,
      sessionTitle: title,
      sessionId: ev.sessionId,
      deepLinkBaseUrl: d.deepLinkBaseUrl,
      elapsedMs: ev.elapsedMs,
      waitingMs: ev.waitingMs,
      exitCode: ev.exitCode,
      signal: ev.signal,
      preview,
    });

    const res = await postDiscordWebhook(d.webhookUrl, body);
    if (!res.ok) {
      // webhook URL 자체는 로그에 남기지 않는다 (비밀). status/detail 만.
      console.warn(
        `[notify] discord delivery failed kind=${ev.kind} status=${res.status} detail=${res.detail ?? ""}`,
      );
    }
  } catch (e) {
    console.warn("[notify] dispatch error:", (e as Error).message);
  }
}

/**
 * 예약 작업(cron) 완료 알림 — executor 가 턴이 끝난(또는 실패/타임아웃) 직후 호출한다.
 *
 * dispatchNotification 과 다른 점:
 *   - away-gating / isCronSessionActive 억제를 «무시» 한다 (무인 실행이라 폰이 볼 일이 없고,
 *     이 알림 자체가 cron 의 의도된 결과 통지다).
 *   - notify_muted 도 무시 — 발사 여부는 cron job 의 notify 플래그가 이미 호출 전에 가렸다.
 *   - 성공이면 cron_complete(초록), 실패/타임아웃이면 cron_failed(빨강).
 *
 * enabled/webhookUrl 부재면 no-op. 절대 throw 하지 않는다.
 */
export async function dispatchCronNotification(ev: {
  sessionId: string;
  status: "ok" | "error" | "timeout";
  elapsedMs?: number;
}): Promise<void> {
  try {
    const cfg = readConfig();
    const d = cfg?.notify?.discord;
    if (!d || !d.enabled || !d.webhookUrl) return;

    let repoPath = "";
    let title: string | null = null;
    let agentId = "";
    try {
      const row = db()
        .prepare("SELECT repo_path, title, agent FROM sessions WHERE id = ?")
        .get(ev.sessionId) as
        | { repo_path: string; title: string | null; agent: string }
        | undefined;
      if (row) {
        repoPath = row.repo_path;
        title = row.title;
        agentId = row.agent;
      }
    } catch {
      /* best-effort */
    }

    const agentName =
      agentId && hasAgent(agentId) ? getAgent(agentId).displayName : agentId || "agent";
    const repoName = repoPath ? path.basename(repoPath) : "—";

    const body = buildDiscordBody({
      kind: ev.status === "ok" ? "cron_complete" : "cron_failed",
      repoName,
      repoPath,
      agentName,
      sessionTitle: title,
      sessionId: ev.sessionId,
      deepLinkBaseUrl: d.deepLinkBaseUrl,
      elapsedMs: ev.elapsedMs,
    });

    const res = await postDiscordWebhook(d.webhookUrl, body);
    if (!res.ok) {
      console.warn(
        `[notify] cron discord delivery failed status=${res.status} detail=${res.detail ?? ""}`,
      );
    }
  } catch (e) {
    console.warn("[notify] cron dispatch error:", (e as Error).message);
  }
}

/**
 * PO 루프 수집 완료 알림 — po/executor 가 ingest 직후 호출한다. cron 알림과 같은
 * 무인-실행 정책 (away-gating / mute 무시, enabled/webhookUrl 부재면 no-op, 절대 throw 없음).
 * 성공 + 브리프 0건이면 보내지 않는다 — «결재할 것이 생겼을 때» 만 울리는 알림.
 */
export async function dispatchPoNotification(ev: {
  sessionId: string;
  status: "ok" | "error" | "timeout";
  briefCount: number;
  /** 새 브리프가 정확히 1건일 때 그 id — 딥링크가 브리프 상세로 바로 착지. */
  briefId?: string;
  /** App Store 신호원 실행 상태 (po_signal_status_v1) — 완료 알림 상세에 한 줄로 surface. */
  signals?: CollectSignals;
}): Promise<void> {
  try {
    const cfg = readConfig();
    const d = cfg?.notify?.discord;
    if (!d || !d.enabled || !d.webhookUrl) return;
    if (ev.status === "ok" && ev.briefCount === 0) return;

    let repoPath = "";
    try {
      const row = db()
        .prepare("SELECT repo_path FROM sessions WHERE id = ?")
        .get(ev.sessionId) as { repo_path: string } | undefined;
      if (row) repoPath = row.repo_path;
    } catch {
      /* best-effort */
    }
    const repoName = repoPath ? path.basename(repoPath) : "—";

    const body = buildDiscordBody({
      kind: ev.status === "ok" ? "po_briefs" : "po_failed",
      repoName,
      repoPath,
      agentName: "PO agent",
      // 제목 요약 자리에 결재 수량을 싣는다 — "📋 New product briefs · 3 proposals".
      sessionTitle: ev.status === "ok" ? `${ev.briefCount} proposal${ev.briefCount === 1 ? "" : "s"}` : null,
      sessionId: ev.sessionId,
      // 성공(결재 요청)이면 세션 대신 백로그 탭으로 착지 — 결재는 백로그에서 한다.
      // 1건이면 그 브리프 상세로 직행. 실패는 세션 딥링크 유지 (transcript 진단용).
      deepLinkPath:
        ev.status === "ok" ? (ev.briefId ? `backlog/${ev.briefId}` : "backlog") : undefined,
      deepLinkBaseUrl: d.deepLinkBaseUrl,
      // 신호원 실행 상태 한 줄 — used/실패만 싣고 off/empty(안 켬/정상 빈)는 빈 문자열로 침묵.
      signalsLine: ev.signals ? formatSignalsLine(ev.signals) : undefined,
    });
    const res = await postDiscordWebhook(d.webhookUrl, body);
    if (!res.ok) {
      console.warn(
        `[notify] po discord delivery failed status=${res.status} detail=${res.detail ?? ""}`,
      );
    }
  } catch (e) {
    console.warn("[notify] po dispatch error:", (e as Error).message);
  }
}

/**
 * PO «워크플로우로 실행» 경로 알림 — po/workflow-exec 가 호출한다.
 *   - po_gate: 사람 승인 게이트 도달 («검증 완료 — 머지 승인 대기»).
 *   - po_failed: run 실패 (자가검증 재시도 소진 등) — 브리프 상세의 exec_note 가 원인.
 * 딥링크는 backlog/<briefId> 로 브리프 상세에 착지한다 — 상세의 «워크플로우 캔버스 열기»
 * 가 execRunId 로 정확히 그 run 에 들어간다. (workflow/<runId> 직행 fragment 는 배포된
 * 딥링크 브리지 페이지의 route 화이트리스트(session/backlog)에 아직 없어 — 브리지가
 * workflow route 를 배우면 직행으로 바꾼다. iOS 는 pocketsisyphus://workflow/<runId>
 * 를 이미 해석한다.)
 * 수집 알림과 같은 무인-실행 정책 (away-gating/mute 무시, 설정 부재 no-op, 절대 throw 없음).
 */
export async function dispatchPoWorkflowNotification(ev: {
  kind: "po_gate" | "po_failed";
  repoPath: string;
  briefId: string;
  briefTitle: string;
  /** briefId 마저 못 쓸 때(이론상)의 폴백 착지점 — 설계 세션. */
  sessionId?: string;
  /** 게이트 노드 제목 (있으면 제목 요약에 함께). */
  nodeTitle?: string;
}): Promise<void> {
  try {
    const cfg = readConfig();
    const d = cfg?.notify?.discord;
    if (!d || !d.enabled || !d.webhookUrl) return;

    const body = buildDiscordBody({
      kind: ev.kind,
      repoName: ev.repoPath ? path.basename(ev.repoPath) : "—",
      repoPath: ev.repoPath,
      agentName: "PO agent",
      sessionTitle: ev.nodeTitle ? `${ev.briefTitle} · ${ev.nodeTitle}` : ev.briefTitle,
      sessionId: ev.sessionId,
      deepLinkPath: `backlog/${ev.briefId}`,
      deepLinkBaseUrl: d.deepLinkBaseUrl,
    });
    const res = await postDiscordWebhook(d.webhookUrl, body);
    if (!res.ok) {
      console.warn(
        `[notify] po workflow discord delivery failed kind=${ev.kind} status=${res.status} detail=${res.detail ?? ""}`,
      );
    }
  } catch (e) {
    console.warn("[notify] po workflow dispatch error:", (e as Error).message);
  }
}

/**
 * 일반 워크플로우(fleet orchestration) run 알림 — workflow/engine 의 상태 전이 훅이 호출한다.
 * PO «워크플로우로 실행» 경로(po_gate/po_failed)에서 빠져 있던, 사용자가 직접 만든 워크플로우
 * run 의 «에이전트가 멈춰 나를 기다림 / 실패» 를 폰으로 띄운다.
 *   - workflow_gate     : requires_approval 노드가 awaiting_approval 진입 (사람 승인 대기, 주황)
 *   - workflow_attention: 노드가 needs_attention (수동 개입 필요, 노랑)
 *   - workflow_failed   : run 이 failed 로 마감 (노드 하드 실패/루프 소진/재시작 reconcile, 빨강)
 *   - workflow_done     : run 이 done(성공)으로 마감 (와서 리뷰/머지하라는 완료 신호, 초록)
 * cancelled(사용자가 스스로 멈춘 것)는 의도된 종료라 무음 — 이 함수로 들어오지 않는다.
 * PO 경로와 같은 무인-실행 정책 — away-gating/세션 mute 무시(결재류라 away 무시), 설정 부재면
 * no-op, 절대 throw 없음. 딥링크는 workflow/<runId> 로 해당 run 캔버스에 직행한다 (iOS
 * DeepLinkRouter 가 pocketsisyphus://workflow/<runId> 를 해석; 브리지 페이지 ROUTES 에도 workflow
 * 추가됨). PO run 은 engine 이 suppressNotify 로 이 경로를 건너뛰고 po_gate 만 쏜다(이중 발화 방지).
 */
export async function dispatchWorkflowNotification(ev: {
  kind: "workflow_gate" | "workflow_attention" | "workflow_failed" | "workflow_done";
  /** run 캔버스 딥링크용 — pocketsisyphus://workflow/<runId>. */
  runId: string;
  workflowTitle: string | null;
  /** 게이트/주의가 발생한 노드 제목 (있으면 제목 요약에 함께). */
  nodeTitle?: string | null;
  /** repo 이름 보강용 (없으면 «—»). */
  repoPath?: string | null;
}): Promise<void> {
  try {
    const cfg = readConfig();
    const d = cfg?.notify?.discord;
    if (!d || !d.enabled || !d.webhookUrl) return;

    const wfTitle = ev.workflowTitle?.trim() || "Workflow";
    const nodeTitle = ev.nodeTitle?.trim();
    const summary = nodeTitle ? `${wfTitle} · ${nodeTitle}` : wfTitle;

    const body = buildDiscordBody({
      kind: ev.kind,
      repoName: ev.repoPath ? path.basename(ev.repoPath) : "—",
      repoPath: ev.repoPath ?? "",
      // 제목 요약(워크플로우·노드)이 어떤 run 인지 이미 식별 — 별도 Agent 필드는 생략.
      agentName: "",
      sessionTitle: summary,
      deepLinkPath: `workflow/${ev.runId}`,
      deepLinkBaseUrl: d.deepLinkBaseUrl,
    });
    const res = await postDiscordWebhook(d.webhookUrl, body);
    if (!res.ok) {
      console.warn(
        `[notify] workflow discord delivery failed kind=${ev.kind} status=${res.status} detail=${res.detail ?? ""}`,
      );
    }
  } catch (e) {
    console.warn("[notify] workflow dispatch error:", (e as Error).message);
  }
}

/**
 * 설정 화면의 «테스트 알림» 버튼이 호출 — 주어진 URL 로 즉시 한 발 쏜다 (away-gating /
 * enabled 무시). 저장 전에 입력한 URL 을 검증하는 용도라 결과를 그대로 반환한다.
 *
 * 가능하면 «가장 최근 세션» 의 실제 repo/제목/딥링크로 enrich 한다 — 사용자가 테스트
 * 버튼만 눌러도 진짜 완료 알림이 어떤 모양인지 (요약 제목 + Open in app 딥링크) 그대로
 * 보게 된다. 딥링크도 실제 세션을 가리켜 탭/복사로 바로 진입 가능. 세션이 하나도 없으면
 * 빈 샘플로 폴백 (순수 URL 검증).
 *
 * deepLinkBaseUrl: 입력칸의 «저장 전» 값으로 테스트할 수 있게 webhookUrl 과 동일한
 * override 패턴 — 없으면 저장된 설정, 그것도 없으면 기본 브리지.
 */
export async function dispatchTestNotification(
  webhookUrl: string,
  deepLinkBaseUrl?: string | null,
): Promise<DiscordPostResult> {
  let repoName = "—";
  let agentName = "";
  let sessionTitle: string | null = null;
  let sessionId: string | undefined;
  try {
    const row = db()
      .prepare(
        "SELECT id, repo_path, title, agent FROM sessions ORDER BY created_at DESC LIMIT 1",
      )
      .get() as
      | { id: string; repo_path: string; title: string | null; agent: string }
      | undefined;
    if (row) {
      repoName = row.repo_path ? path.basename(row.repo_path) : "—";
      agentName =
        row.agent && hasAgent(row.agent) ? getAgent(row.agent).displayName : row.agent || "";
      sessionTitle = row.title;
      sessionId = row.id;
    }
  } catch {
    /* best-effort — 세션 enrich 실패해도 빈 샘플로 webhook 검증은 된다 */
  }

  const body = buildDiscordBody({
    kind: "test",
    repoName,
    repoPath: "",
    agentName,
    sessionTitle,
    sessionId,
    deepLinkBaseUrl: deepLinkBaseUrl ?? readConfig()?.notify?.discord?.deepLinkBaseUrl,
  });
  return postDiscordWebhook(webhookUrl, body);
}
