/**
 * Discord incoming webhook notifier — 단방향 (daemon → Discord).
 *
 * # 왜 webhook 인가
 *
 * iOS 푸시(APNs)는 사용자마다 Apple Developer 푸시키(.p8) + push entitlement +
 * sandbox/production 토큰 환경 셋업을 강요하고, OSS 로 각자 빌드하는 모델에선 마찰이 크다.
 * Discord incoming webhook 은 «푸시 전달(잠긴 폰 깨우기)» 을 Discord 인프라가 대행하므로
 * 우리는 서버를 한 대도 띄우지 않는다 — 프로젝트의 «외부서버 0» 원칙 그대로. daemon 은
 * 이미 outbound HTTPS 가 가능하고(ipify 등), webhook URL 로 POST 한 번이면 끝.
 *
 * # 보안
 *
 * webhook URL 자체가 비밀 (URL 을 아는 누구나 그 채널에 글을 쓸 수 있음). config.json
 * (0600) 에만 보관하고 로그에 평문으로 남기지 않는다. /api/notify/config 응답도 redact.
 *
 * # 메시지 언어
 *
 * embed 의 라벨은 영어 + 이모지 (✅ / ⏹️ / ❌ / 🧪) 로 둔다 — 개발 도구 알림에서 보편적이고
 * daemon 측 i18n 시스템을 별도로 만들지 않아도 된다. 사용자 고유 데이터(repo 이름, 세션
 * 제목)는 그대로 싣는다. (Mac 앱의 설정 «화면» 은 10개 언어로 완전 현지화되어 있다.)
 */

import { guardNonLanEgress } from "../egress.js";

/** webhook POST body 에 들어가는 embed 한 개. Discord embed 스펙의 부분집합만 사용. */
export type DiscordEmbed = {
  title?: string;
  description?: string;
  /** 0xRRGGBB 정수. */
  color?: number;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  footer?: { text: string };
  /** ISO 8601. */
  timestamp?: string;
};

export type DiscordWebhookBody = {
  username?: string;
  content?: string;
  embeds?: DiscordEmbed[];
};

export type NotifyEventKind =
  | "turn_complete"
  | "session_exit"
  | "error"
  | "test"
  // 예약 작업(cron) 전용 — executor 가 보낸다. 일반 turn_complete 와 분리해 «예약» 이라는
  // 맥락 + 성공/실패를 제목에 드러낸다. away-gating 무시 (무인 실행이 본질).
  | "cron_complete"
  | "cron_failed"
  // turn_complete 후에도 사용자가 응답하지 않을 때의 에스컬레이션 — pty-runner 의 리마인더
  // 체인(10m/30m/60m)이 보낸다. «한 번 놓치면 에이전트가 무한 대기» 하는 약한고리 보강.
  // on/off 는 turnComplete 토글을 따른다 (같은 의도의 이벤트 family).
  | "still_waiting"
  // PO 루프 — 수집 세션이 끝나 새 기회 브리프가 백로그에 들어왔다 (또는 수집 실패).
  // cron 과 같은 무인 실행이라 away-gating 무시. po/executor 가 보낸다.
  | "po_briefs"
  | "po_failed"
  // PO 루프 «워크플로우로 실행» (po_workflow_v1) — 구현/자가검증이 끝나 사람 승인 게이트에
  // 도달했다. 결재 요청이라 po_briefs 와 같은 정책 (무인 실행, away-gating 무시). 딥링크는
  // workflow/<runId> 로 해당 run 캔버스에 착지한다.
  | "po_gate"
  // 일반 워크플로우(fleet orchestration) — workflow/engine 의 상태 전이 훅이 보낸다. PO 가 아닌
  // 사용자 워크플로우 run 이 사람을 기다리거나(게이트/주의) 끝났을(완료/실패) 때 폰을 울린다.
  // po_gate 와 같은 «결재/완료» family 정책 (무인 실행, away-gating 무시). 딥링크는 workflow/<runId>.
  //   - workflow_gate     : requires_approval 노드가 awaiting_approval 진입 (승인 대기, 주황)
  //   - workflow_attention: 노드가 needs_attention (수동 개입 필요, 노랑 — still_waiting 과 동형)
  //   - workflow_failed   : run 이 failed 로 마감 (노드 하드 실패/루프 소진/재시작 reconcile, 빨강)
  //   - workflow_done     : run 이 done(성공)으로 마감 (와서 리뷰/머지하라는 «완료» 신호, 초록).
  //                         cancelled(사용자가 스스로 멈춤)는 의도된 종료라 무음 — kind 없음.
  | "workflow_gate"
  | "workflow_attention"
  | "workflow_failed"
  | "workflow_done";

/** buildDiscordBody 입력 — notify/index 의 enrich 결과. */
export type NotifyRenderInput = {
  kind: NotifyEventKind;
  /** repo 디렉터리 basename (식별용 짧은 이름). */
  repoName: string;
  /** repo 절대경로 (footer/디버그용). */
  repoPath: string;
  /** 에이전트 표시 이름 (Claude Code / Antigravity / Codex …). */
  agentName: string;
  /** 세션 제목 — 없으면 생략. */
  sessionTitle?: string | null;
  /**
   * 세션 ID — Discord 메시지에 https 딥링크 브리지(`.../open/#<id>`)를 싣는 데 쓴다.
   * 그 브리지 페이지가 `pocketsisyphus://session/<id>` 로 핸드오프한다. 없거나 test 면 생략.
   */
  sessionId?: string;
  /**
   * 딥링크의 앱 내 «경로» 오버라이드 — 브리지 fragment 에 그대로 실린다 (예: "backlog" /
   * "backlog/<briefId>"). 없으면 sessionId 기반 세션 딥링크. PO 브리프 알림이 세션 대신
   * 백로그 탭으로 착지할 때 쓴다. 브리지 페이지가 route prefix(session/backlog)를 해석한다.
   */
  deepLinkPath?: string;
  /**
   * 딥링크 브리지 base URL 오버라이드 — config.notify.discord.deepLinkBaseUrl.
   * 없으면 기본 GitHub Pages (DEFAULT_DEEP_LINK_BRIDGE_BASE).
   */
  deepLinkBaseUrl?: string | null;
  /** turn 소요 시간(ms) — turn_complete 에서만. */
  elapsedMs?: number;
  /** 응답을 기다린 시간(ms) — still_waiting 에서만. */
  waitingMs?: number;
  /** 비정상 종료 시 exit code. */
  exitCode?: number | null;
  /** 비정상 종료 시 signal. */
  signal?: string | null;
  /**
   * 에이전트의 마지막 의미있는 출력 한~두 줄 미리보기 (turn_complete / still_waiting 에서만,
   * config.notify.discord.includePreview 옵트인 시). 있으면 정적 안내문 대신 description 으로
   * 싣는다 — 폰을 안 열어도 무슨 응답/질문인지 보인다. 없으면(추출 실패/옵트아웃) 정적 안내문.
   */
  preview?: string | null;
  /**
   * App Store 신호원 실행 상태 한 줄 (po_signal_status_v1) — PO 수집 완료 알림 전용. 예:
   * "Store reviews: 12 used · Crashes: key auth failed". off/empty(안 켬/정상 빈)만이면 빈
   * 문자열/생략 → 필드 안 뜸 (정상은 조용히). 영어로 둔다 — Discord webhook 은 테마/로케일이
   * 없는 daemon 텍스트 표면(앱 내 카드가 로컬라이즈된 본 surface).
   */
  signalsLine?: string;
};

const WEBHOOK_USERNAME = "Pocket Sisyphus";

/**
 * GitHub Pages 딥링크 «브리지». 탭하면 결국 앱이 `pocketsisyphus://session/<id>` 로
 * 열려 해당 세션 채팅창에 진입한다 (scheme 합의는 iOS 의 DeepLinkRouter.swift /
 * Info.plist CFBundleURLSchemes 와 1:1).
 *
 * # 왜 커스텀 scheme 을 직접 안 싣고 https 브리지를 거치나
 *
 * Discord 는 (Slack 과 달리) 커스텀 scheme 을 **절대** 탭 가능한 링크로 만들지 않는다.
 * 2023 보안 패치 이후 링크 scheme 화이트리스트가 http/https/discord 뿐이라, 평문도
 * `<pocketsisyphus://…>` 꺾쇠도 `[label](pocketsisyphus://…)` 마스크 링크도 전부 죽은
 * 평문으로 렌더되고, 버튼에 넣으면 400(`Scheme … is not supported`)으로 거부된다.
 * (예전 steam:// 시절엔 됐지만 막힘.) 그래서 daemon 은 커스텀 scheme 대신 공개 레포
 * pocket-sisyphus-mac 의 GitHub Pages 정적 페이지(`/open`)로 가는 «https» 링크를 싣고,
 * 그 페이지가 클라이언트에서 `pocketsisyphus://session/<id>` 로 핸드오프한다.
 *
 * 외부서버 0: 정적 호스팅이라 운영 서버가 없고, 세션 id 는 URL fragment(`#<id>`)로만
 * 다뤄 네트워크에 흘리지 않는다 (페이지에 비밀값 없음 — 한 장이 모든 빌드 공용).
 * Universal Link(AASA) 대신 리다이렉트 페이지인 이유: Discord iOS 는 링크를 인앱 Safari
 * 모달로 여는데 거기선 universal link 핸드오프가 우회되지만, 커스텀 scheme 리다이렉트는
 * 「앱으로 열기?」 프롬프트로 동작한다.
 *
 * 페이지 소스: Wayne-Kim/pocket-sisyphus-mac : main /docs/open/index.html.
 *
 * 사용자가 config.notify.discord.deepLinkBaseUrl 로 자기 GitHub Pages 등에 올린 브리지
 * 페이지를 지정할 수 있다 — 미지정이면 이 기본값.
 */
export const DEFAULT_DEEP_LINK_BRIDGE_BASE = "https://wayne-kim.github.io/pocket-sisyphus-mac/open";

/**
 * 사용자 지정 딥링크 브리지 base URL 검증. https 만 — http 는 Discord 인앱 브라우저에서
 * 경고/차단되고 비밀은 없지만 다운그레이드 의미도 없다. fragment 자리는 세션 id 가 쓰고
 * (`${base}/#<id>`), query 가 섞이면 `/#` 가 query 값으로 빨려 들어가므로 둘 다 거부.
 */
export function isValidDeepLinkBaseUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  if (u.search !== "" || u.hash !== "") return false;
  return true;
}

/** 저장/사용 전 정규화 — 공백 제거 + 끝 슬래시 제거 (`${base}/#…` 조립이 이중 슬래시 안 되게). */
export function normalizeDeepLinkBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

/**
 * fragment → https 브리지 링크. id/경로는 fragment 로 실어 네트워크에 안 흘린다.
 * fragment 는 bare 세션 id(하위호환) 또는 «route 경로» ("backlog", "backlog/<id>") —
 * 브리지 페이지가 route prefix 를 해석해 `pocketsisyphus://<경로>` 로 핸드오프한다.
 * 경로 구분자 `/` 는 fragment 에서 합법이라 인코딩하지 않고, 각 세그먼트만 인코딩한다.
 */
function bridgeWebLink(fragment: string, baseUrl?: string | null): string {
  const base = baseUrl ? normalizeDeepLinkBaseUrl(baseUrl) : DEFAULT_DEEP_LINK_BRIDGE_BASE;
  const encoded = fragment.split("/").map(encodeURIComponent).join("/");
  return `${base}/#${encoded}`;
}

/**
 * Discord 메시지 content 에 실을 «탭 가능한» 딥링크 한 줄. https 브리지 URL 을 마스크
 * 링크로 싣고 `<>` 로 감싸 embed 미리보기(unfurl)를 억제한다. https 라 Discord 가 정상
 * 링크로 렌더 → 탭하면 브리지 페이지가 앱 scheme 으로 넘긴다.
 */
function deepLinkContentLine(fragment: string, baseUrl?: string | null): string {
  return `🔗 [Open in app](<${bridgeWebLink(fragment, baseUrl)}>)`;
}

const EMBED_COLOR: Record<NotifyEventKind, number> = {
  turn_complete: 0x5865f2, // Discord blurple — "네 차례"
  session_exit: 0x95a5a6, // grey — 정상 종료
  error: 0xed4245, // red — 비정상 종료
  test: 0x57f287, // green — 테스트 성공
  cron_complete: 0x57f287, // green — 예약 작업 완료
  cron_failed: 0xed4245, // red — 예약 작업 실패/타임아웃
  still_waiting: 0xfee75c, // Discord yellow — 주의: 에이전트가 입력 못 받고 멈춰 있음
  po_briefs: 0xe67e22, // orange — «주황 = 프로» 약속색. 새 브리프 결재 요청
  po_failed: 0xed4245, // red — 수집 실패
  po_gate: 0xe67e22, // orange — 머지 승인 결재 요청 (po_briefs 와 같은 «결재» family)
  workflow_gate: 0xe67e22, // orange — «주황 = 프로» 결재류. 워크플로우 승인 게이트 도달
  workflow_attention: 0xfee75c, // yellow — 주의: 노드가 멈춰 수동 개입 대기 (still_waiting 과 동색)
  workflow_failed: 0xed4245, // red — 워크플로우 run 실패
  workflow_done: 0x57f287, // green — 성공: 워크플로우 run 완료 (와서 리뷰/머지). cron_complete 와 동색
};

const EMBED_TITLE: Record<NotifyEventKind, string> = {
  turn_complete: "✅ Your turn",
  session_exit: "⏹️ Session ended",
  error: "❌ Session error",
  test: "🧪 Test notification",
  cron_complete: "⏰ Scheduled task done",
  cron_failed: "⚠️ Scheduled task failed",
  still_waiting: "⏳ Still waiting",
  po_briefs: "📋 New product briefs",
  po_failed: "⚠️ Brief collection failed",
  po_gate: "🚦 Merge approval needed",
  workflow_gate: "🚦 Workflow approval needed",
  workflow_attention: "⏳ Workflow needs attention",
  workflow_failed: "❌ Workflow run failed",
  workflow_done: "✅ Workflow run complete",
};

const EMBED_HINT: Partial<Record<NotifyEventKind, string>> = {
  turn_complete:
    "The agent is waiting for you — it finished its reply, is asking a question, or needs approval.",
  session_exit: "The agent's session process has exited.",
  error: "The agent's session ended unexpectedly — check the exit status.",
  test: "Wiring OK. Real alerts look like this — repo · session title in the heading, plus a link to open the session in the app.",
  cron_complete: "A scheduled task finished — tap to open the session it ran.",
  cron_failed: "A scheduled task ended with an error or timed out — tap to open the session.",
  still_waiting:
    "The agent is still blocked on your input — tap to answer so it can keep going.",
  po_briefs:
    "The PO agent collected signals and proposed opportunity briefs — review them in the Backlog tab.",
  po_failed: "The PO signal-collection session ended with an error — tap to inspect it.",
  po_gate:
    "Implementation and self-verification are done — approve the gate in the workflow canvas to merge.",
  workflow_gate:
    "A workflow node is waiting for your approval — open the run canvas to approve or reject.",
  workflow_attention:
    "A workflow node stopped and needs your input — open the run canvas to complete or retry it.",
  workflow_failed:
    "A workflow run ended in failure — open the run canvas to see which node failed.",
  workflow_done:
    "A workflow run finished successfully — open the run canvas to review and merge the result.",
};

/** ms → "2m 13s" / "45s" / "1h 03m" 같은 짧은 사람 가독 표현. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

/**
 * Discord incoming webhook URL 검증. 잘못된 URL 을 저장/발사하기 전에 거른다.
 *
 * 허용: https://(canary.|ptb.)?discord(app)?.com/api/(vN/)?webhooks/<id>/<token>
 * id 는 숫자, token 은 [A-Za-z0-9_-]. http / 다른 호스트 / 경로 불일치는 거부.
 */
export function isValidDiscordWebhookUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  const allowedHosts = new Set([
    "discord.com",
    "discordapp.com",
    "canary.discord.com",
    "ptb.discord.com",
  ]);
  if (!allowedHosts.has(host)) return false;
  return /^\/api\/(?:v\d+\/)?webhooks\/\d+\/[\w-]+$/.test(u.pathname);
}

/** webhook URL 을 로그/응답에 안전하게 노출하기 위한 마스킹 (token 부분 가림). */
export function redactWebhookUrl(raw: string): string {
  try {
    const u = new URL(raw);
    // 마지막 path segment(토큰)만 가린다.
    const parts = u.pathname.split("/");
    if (parts.length > 0) parts[parts.length - 1] = "•••";
    return `${u.origin}${parts.join("/")}`;
  } catch {
    return "•••";
  }
}

/**
 * 알림 종류 + enrich 데이터 → Discord webhook body (embed 1개).
 *
 * 제목이 «무엇이 / 어디서» 끝났는지 한눈에 보이도록 요약(세션 제목 또는 repo 이름)을
 * 상태 라벨 뒤에 붙인다 — "✅ Your turn · 리팩터링". 푸시 미리보기에서도 이 제목이
 * 보이므로 본문을 안 열어도 어떤 세션인지 식별된다.
 *
 * 필드는 kind 가 아니라 «데이터 유무» 로 판단한다 — 그래서 테스트 알림도 (최근 세션을
 * enrich 해 넘기면) 진짜 알림과 동일한 모양의 미리보기로 보인다.
 */
export function buildDiscordBody(input: NotifyRenderInput): DiscordWebhookBody {
  const fields: NonNullable<DiscordEmbed["fields"]> = [];

  const repoName = input.repoName?.trim();
  const hasRepo = !!repoName && repoName !== "—";
  if (hasRepo) {
    fields.push({ name: "Repo", value: "`" + repoName + "`", inline: true });
  }
  // agentName 이 webhook 이름(=세션 정보 없음)과 같으면 의미 없는 필드라 생략.
  if (input.agentName && input.agentName !== WEBHOOK_USERNAME) {
    fields.push({ name: "Agent", value: input.agentName, inline: true });
  }
  if (input.elapsedMs != null) {
    fields.push({ name: "Elapsed", value: formatDuration(input.elapsedMs), inline: true });
  }
  if (input.waitingMs != null) {
    fields.push({ name: "Waiting", value: formatDuration(input.waitingMs), inline: true });
  }
  if (input.kind === "error") {
    const exit = input.signal
      ? `signal ${input.signal}`
      : input.exitCode != null
        ? `code ${input.exitCode}`
        : "abnormal";
    fields.push({ name: "Exit", value: exit, inline: true });
  }
  // App Store 신호원 실행 상태 (po_signal_status_v1) — PO 수집 완료 알림에서만. «스토어/크래시
  // 신호 사용됨/실패» 한 줄로 무음 강등을 폰에서도 보이게 한다. off/empty 만이면 호출처가 빈
  // 문자열을 넘겨 이 필드가 안 뜬다 (정상/안 켬은 조용히).
  if (input.signalsLine && input.signalsLine.trim()) {
    fields.push({ name: "Signals", value: input.signalsLine.trim().slice(0, 1024), inline: false });
  }

  // 제목 = 상태 라벨 + 요약(세션 제목 우선, 없으면 repo 이름). 요약이 없으면 라벨만.
  const summary = input.sessionTitle?.trim() || (hasRepo ? repoName : "");
  const title = summary ? `${EMBED_TITLE[input.kind]} · ${summary}` : EMBED_TITLE[input.kind];

  const embed: DiscordEmbed = {
    title,
    color: EMBED_COLOR[input.kind],
    fields: fields.length > 0 ? fields : undefined,
    footer: { text: WEBHOOK_USERNAME },
    timestamp: new Date().toISOString(),
  };
  // description: 미리보기(에이전트의 마지막 말)가 있으면 그것을, 없으면 종류별 정적 안내문.
  // 미리보기는 «인용» 블록으로 — 에이전트가 한 말임을 시각적으로 분리하고, 푸시 미리보기에
  // 본문으로 떠 폰을 안 열어도 결재 가치를 판단할 수 있다 (옵트인 시에만 채워짐).
  const preview = input.preview?.trim();
  if (preview) {
    // Discord 인용 블록 — 여러 줄이 합쳐졌어도 한 인용으로. embed description 4096자 한도라
    // 추출 단계에서 이미 ~200자로 truncate 됐지만 방어적으로 한 번 더 자른다.
    embed.description = "> " + preview.replace(/\n+/g, " ").slice(0, 1000);
  } else {
    const hint = EMBED_HINT[input.kind];
    if (hint) embed.description = hint;
  }

  const body: DiscordWebhookBody = { username: WEBHOOK_USERNAME, embeds: [embed] };
  // 딥링크는 «메시지 content» 에 https 브리지 마스크 링크로 싣는다 — Discord 는 커스텀
  // scheme 을 링크로 안 만들지만 https 는 만들어 주므로, 브리지 페이지를 거쳐 앱으로 넘긴다.
  // deepLinkPath(앱 내 경로) 가 있으면 그것을, 없으면 sessionId(세션 딥링크 — 하위호환
  // bare id fragment)를 싣는다.
  if (input.deepLinkPath) {
    body.content = deepLinkContentLine(input.deepLinkPath, input.deepLinkBaseUrl);
  } else if (input.sessionId) {
    body.content = deepLinkContentLine(input.sessionId, input.deepLinkBaseUrl);
  }
  return body;
}

export type DiscordPostResult = { ok: boolean; status: number; detail?: string };

/**
 * webhook 으로 POST. 절대 throw 하지 않고 결과 객체를 반환한다 (호출자가 알림 실패로
 * PTY 흐름을 깨지 않도록). 10초 타임아웃 — Tor 와 무관한 일반 인터넷 경로.
 */
export async function postDiscordWebhook(
  webhookUrl: string,
  body: DiscordWebhookBody,
): Promise<DiscordPostResult> {
  // LAN 전용 모드 — Discord webhook 은 discord.com 으로 나가는 비-LAN outbound 라 차단.
  // 알림 메타데이터(repo·세션 제목 등)가 사내망 밖으로 나가지 않게 한다.
  if (guardNonLanEgress("Discord webhook")) {
    return { ok: false, status: 0, detail: "lan-only mode: 알림 outbound 차단" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (res.ok) return { ok: true, status: res.status };
    // 실패 본문 일부를 detail 로 — rate-limit(429) / 잘못된 URL(401/404) 등 진단용.
    let detail = "";
    try {
      detail = (await res.text()).slice(0, 200);
    } catch {
      /* body 못 읽어도 status 로 충분 */
    }
    return { ok: false, status: res.status, detail };
  } catch (e) {
    return { ok: false, status: 0, detail: (e as Error).message };
  } finally {
    clearTimeout(timer);
  }
}
