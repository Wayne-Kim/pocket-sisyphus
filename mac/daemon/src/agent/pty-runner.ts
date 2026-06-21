/**
 * PTY-based runner — `claude` CLI 를 진짜 의사 터미널(PTY) 에서 인터랙티브 REPL 모드로 띄워
 * 사용자가 폰에서 입력한 텍스트를 stdin 으로 흘리고, REPL 의 raw 출력을 그대로 WS 로 스트림한다.
 *
 * ## 왜 PTY 인가
 *
 * Anthropic 의 2026-06-15 청구 정책 변경으로 다음이 분리된다:
 *   - Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) → **새 Agent SDK Credit 풀** (API 정가)
 *   - `claude -p` (--print, 비대화) → **새 Agent SDK Credit 풀**
 *   - `claude` (대화형 REPL) → **기존 구독 한도 (Pro/Max)**
 *
 * Pocket Sisyphus 는 본질적으로 "폰에서 사람이 타이핑하는" 인터랙티브 사용임에도, Agent SDK 로
 * 구현돼 있어 6/15 이후 새 풀로 분류돼 사실상 사용량 손해를 본다. PTY 로 우회하면 Anthropic
 * 시그널상으로는 일반적인 인터랙티브 Claude Code 세션과 동일하게 보인다 (실제 TTY 부착,
 * --print 미사용, --input-format=stream-json 미사용).
 *
 * ## 데이터 모델
 *
 * - 세션 단위 PTY 프로세스 하나. 첫 사용자 메시지 도착 시 lazy spawn, 세션 abort/clear/delete
 *   시 정리. PTY 프로세스가 죽으면 다음 메시지에서 재생성.
 * - `messages.type='pty_chunk'` 로 raw 출력을 저장 (payload.bytes_b64). 클라이언트 재접속 시
 *   순서대로 replay 하면 화면 복원이 가능 (단, 작은 ANSI 윈도우 리사이즈/커서 점프는 부정확할 수 있음).
 * - `messages.type='pty_user_input'` 으로 사용자 입력 메시지 저장 (payload.text).
 *
 * ## 옛 화면 파싱 / wizard 응답 파이프라인은 제거됨 (2026-05)
 *
 * SwiftTerm 통합 이후 iOS 는 raw bytes 를 직접 렌더하므로 daemon 측 xterm-headless 가상
 * 터미널과 AskUserQuestion 화면 파서(`pty-question-detect`) 가 더 이상 소비되지 않았다.
 * 사용자 wizard 응답은 이제 일반 텍스트 입력으로만 처리한다 — 필요시 사용자가 화살표/Enter
 * 같은 raw 키를 보내고 싶으면 별도 채널을 다시 도입해야 함.
 */
import path from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { spawn as ptySpawn, type IPty } from "node-pty";
import { db } from "../db/index.js";
import { broadcastToSession, broadcastAll } from "../ws/hub.js";
import { getAgent, hasAgent } from "./registry.js";
import { PtyChunkBuffer } from "./pty-coalesce.js";
import { stripTerminalQueryResponses, sanitizeLivePtyOutput } from "./pty-sanitize.js";
import { dispatchNotification } from "../notify/index.js";
import { extractAgentPreview } from "../notify/preview.js";
import type { AgentAdapter } from "./types.js";

/**
 * 라이브 PTY 위험 시퀀스 정화(OSC 52 클립보드·OSC 0/1/2 제목·REP multiplier)는 «기본 차단».
 * 디버그로 원본 바이트를 봐야 할 때만 PS_PTY_ALLOW_UNSAFE_OSC=1 로 끈다(opt-out passthrough).
 */
const ALLOW_UNSAFE_OSC = /^(1|true|yes)$/i.test(process.env.PS_PTY_ALLOW_UNSAFE_OSC ?? "");
if (ALLOW_UNSAFE_OSC) {
  console.warn(
    "[pty-runner] PS_PTY_ALLOW_UNSAFE_OSC 활성화 — 라이브 OSC 52/제목/REP 정화 비활성(디버그 전용).",
  );
}

/**
 * 입력 바이트 추적 — 송신측(iOS)·수신측(daemon)이 «동일 포맷» 으로 키스트로크 바이트를
 * 찍어 한글/CJK·IME 입력 회귀를 «양끝 대조» 로 잡는 진단. 기본 OFF(성능·로그 영향 0),
 * `PS_KS_TRACE=1` 로 켠다.
 *
 * 포맷은 iOS `KSTrace.swift` 의 `KSTrace.log` 와 1:1 동일:
 *   `[KS-TRACE] <side> session=<id> agent=<id> bytes=<n> hex=[xx xx …]`
 * `grep KS-TRACE` 로 `send`(iOS) 와 `recv`(daemon) 를 짝지어, 송신 바이트와 PTY write
 * 바이트가 일치하는지 (WS·sanitize 경로에서 손상/유실이 없는지) 대조한다.
 */
export const KS_TRACE = /^(1|true|yes)$/i.test(process.env.PS_KS_TRACE ?? "");

/** KS-TRACE hex preview 최대 바이트 — iOS KSTrace.hexCap 과 동일(64). */
const KS_TRACE_HEX_CAP = 64;

/**
 * KS-TRACE 한 줄 — bytes 를 공백 구분 hex 로(최대 64B, 초과분은 `+Nmore`). OFF 면 즉시 반환.
 * `note` 는 SKIP/dropped 같은 보조 사유를 끝에 덧붙인다(대조 시 차이 설명용).
 */
export function ksTrace(
  side: "send" | "recv",
  sessionId: string,
  agent: string,
  bytes: Buffer,
  note?: string,
): void {
  if (!KS_TRACE) return;
  const shown = bytes.subarray(0, KS_TRACE_HEX_CAP);
  const hex = shown.toString("hex").match(/.{1,2}/g)?.join(" ") ?? "";
  const more = bytes.length > KS_TRACE_HEX_CAP ? ` +${bytes.length - KS_TRACE_HEX_CAP}more` : "";
  const noteSuffix = note ? ` ${note}` : "";
  console.log(
    `[KS-TRACE] ${side} session=${sessionId} agent=${agent} bytes=${bytes.length} hex=[${hex}${more}]${noteSuffix}`,
  );
}

type SessionContext = {
  sessionId: string;
  cwd: string;
  /** 이 세션을 운전할 코드 에이전트. ensurePty 가 spawn 인자/env 를 이 adapter 에서 얻는다. */
  adapter: AgentAdapter;
  /**
   * 데스크탑 세션을 이어받을 때의 외부 핸들 — sessions 테이블의 parent_sdk_session_id 컬럼.
   * adapter.buildSpawnArgs(ctx) 가 `--resume <id>` (claude) 또는 `--conversation <id>` (agy)
   * 같은 자기 모양의 인자로 박는다. 빈/undefined 면 새 conversation 으로 시작.
   */
  resumeFrom?: string;
  /**
   * 터미널(쉘 스크립트) 실행 전용 — adapter.resolveBinary()/buildSpawnArgs() 대신 이 binary/args
   * 로 spawn 한다. 예약 터미널 작업이 `zsh -l <script>` 처럼 «정해진 명령» 을 한 번 돌릴 때 쓴다.
   * adapter 는 PtySession 부기(releaseBackend 등)용으로 여전히 필요하다 (cron 은 shell 어댑터).
   */
  spawnOverride?: { binary: string; args: string[] };
};

type PtySession = {
  pty: IPty;
  /**
   * 이 PTY 를 운전하는 adapter — onExit 시 「같은 adapter 를 쓰는 다른 활성 PTY 가 있는지」
   * 판정 + releaseBackend 호출에 쓴다. local_llm 의 llama-server 회수 경로.
   */
  adapter: AgentAdapter;
  /** 세션이 끝났을 때 (PTY exit) resolve. abort/clear/delete 핸들러가 await. */
  done: Promise<void>;
  /** 마지막으로 raw chunk 를 받은 시각. 첫 spawn settle 검출에 사용. */
  lastActivity: number;
  /** PTY 를 spawn 한 시각 (ms). 첫 입력 전 settle 대기를 «호출» 이 아니라 spawn 기준으로 잰다. */
  spawnedAt: number;
  /**
   * 첫 사용자 프롬프트를 이미 PTY 에 썼는지. 첫 입력에만 settle 대기를 걸어 splash/로그인
   * 흐름에 입력이 먹히는 걸 막는다 — prewarm 으로 떠 있던 세션의 첫 메시지도 포함.
   */
  firstInputSent: boolean;
  /** PTY 출력 청크 coalescing 버퍼. onData 마다 push, 15ms 윈도우로 묶어 1번 broadcast. */
  outputBuffer: PtyChunkBuffer;
  /**
   * 사용자가 입력(submit)을 보낸 뒤 그 턴의 완료를 아직 못 본 상태. true 인 동안만 출력
   * idle 디바운스가 «턴 끝남» 알림을 발사한다. 첫 splash 출력(submit 전) 에는 false 라
   * 오발사 안 됨.
   */
  turnActive: boolean;
  /** 현재 턴 submit 시각 (ms). 알림에 소요 시간을 싣는 데 사용. */
  turnStartedAt: number;
  /** 턴 종료 추정 디바운스 타이머. 출력이 들어올 때마다 reset, 발사 시 알림. */
  idleTimer: ReturnType<typeof setTimeout> | null;
  /**
   * 응답 대기 리마인더 체인 타이머 — turn_complete 발사 시점부터 무장, submit/exit 에서 취소.
   * «알림 한 번 놓치면 에이전트가 무한 대기» 약한고리 보강 (WAITING_REMINDER_OFFSETS_MS 참고).
   */
  waitingTimer: ReturnType<typeof setTimeout> | null;
  /** 대기 시작 시각(ms) — turn_complete 발사 시점. 리마인더의 Waiting 표기 기준. */
  waitingSince: number;
  /** 다음에 발사할 리마인더의 WAITING_REMINDER_OFFSETS_MS 인덱스. */
  waitingReminderIdx: number;
  /**
   * «다음 정지 시 알림» 수동 구독 — 사용자가 이 세션의 다음 idle 을 12초보다 짧은
   * SENSITIVE_TURN_IDLE_MS 로 잡아 «꼭» 알림받겠다고 켠 1회성 플래그. armTurnIdle 이 이 값을
   * 보고 임계값을 고른다. turn_complete 발사 시 소진, markTurnSubmitted(다음 턴 시작) /
   * false-fire 보정(출력 재개) 시 해제. 메모리만 — DB 영속 안 함(활성 PTY 한정 신호).
   */
  notifyNextStop: boolean;
  /**
   * 우리가 의도적으로 종료(SIGTERM)시킨 경우 true — restart/clear/delete. onExit 에서
   * 종료/에러 알림을 보내지 않는다 (사용자가 직접 일으킨 종료라 «세션 에러» 오발사 방지).
   */
  intentionalStop: boolean;
  /**
   * 최근 PTY 출력 raw tail (ANSI 포함) — 알림 미리보기 추출용. onData 마다 이어붙이고
   * RECENT_OUTPUT_MAX 자로 캡. «메모리만» 유지하고 영속하지 않는다 (DB 의 pty_chunk 와 별개).
   * dispatch 시점에 includePreview 옵트인이 켜져 있을 때만 한 줄로 추출된다.
   */
  recentOutput: string;
  /**
   * 세션 목록/poll 의 «보류 prompt 미리보기» 캐시. recentOutput 에서 extractAgentPreview 로
   * 뽑은 결과를 waitingSince 기준으로 기억한다 — 목록 polling 마다 재추출하는 비용을 막고,
   * 출력이 재개돼 다시 멎으면(waitingSince 변동) 자동 무효화돼 재계산된다. null = 미계산.
   */
  pendingPreviewCache: { waitingSince: number; preview: string | null } | null;
};

const activePtys = new Map<string, PtySession>();

/**
 * 세션 수명주기 이벤트의 내부 pub/sub. `dispatchNotification` 이 가는 바로 그 지점들에서
 * 함께 emit 한다 — 동작 변화 0, 관전자만 하나 늘어난다. CronScheduler 의 executor 가
 * 「예약 실행이 만든 세션의 턴이 끝났는지」 를 12초 idle 휴리스틱을 복제하지 않고 여기서
 * 구독한다 (cron/executor.ts).
 *
 * 이벤트:
 *   - "turn_complete" { sessionId, elapsedMs }      — 출력이 12초 잠잠 (턴 끝/입력 대기 추정)
 *   - "session_exit"  { sessionId, exitCode, signal } — REPL 정상 종료 (code 0)
 *   - "error"         { sessionId, exitCode, signal } — REPL 비정상 종료 / spawn 실패
 */
export type PtyLifecycleEvent = {
  sessionId: string;
  elapsedMs?: number;
  exitCode?: number | null;
  signal?: string | null;
};
export const ptyEvents = new EventEmitter();

/**
 * 「이 세션에 대해 spawn 실패 안내를 이미 터미널에 노출함」 플래그 — subscribe-prewarm 과
 * 첫 메시지 경로가 같은 missing-binary 에러를 두 번 그리지 않도록 dedup. PTY 가 한 번
 * 성공적으로 뜨면 (ensurePty 의 activePtys.set) 해제돼, 이후 다른 spawn 실패는 다시 보고된다.
 */
const spawnFailureEmitted = new Set<string>();

/**
 * spawn 준비 실패 (resolveBinary throw = CLI 미설치, 혹은 ptySpawn 자체 실패) 를 사용자에게
 * 가시화한다. 옛 동작은 이 에러가 호출부의 `.catch(console.error)` / `wsLog.warn` 으로만
 * 떨어지고 HTTP 는 이미 200 을 보낸 뒤라, 사용자는 자기 말풍선만 뜬 채 빈 터미널을 영영
 * 보는 «조용한 실패» 였다 (adapters/claude-code/resolve-binary.ts 의 도입부 주석 참고).
 *
 * 이제 에러 메시지 (resolveBinary 가 박아 둔 「…설치: npm install -g …」) 를 PTY 출력처럼
 * 터미널 스트림에 흘리고 pty_exit 로 턴을 끝낸다. messages 테이블에도 남겨 재진입/새로고침
 * 시 history replay 로 다시 보인다. dedup 으로 세션당 1회만.
 */
export function emitSpawnFailure(sessionId: string, err: unknown): void {
  if (spawnFailureEmitted.has(sessionId)) return;
  spawnFailureEmitted.add(sessionId);
  const message = err instanceof Error ? err.message : String(err);
  // 빨강 ANSI + 경고 아이콘. SwiftTerm 이 raw bytes 를 그대로 렌더.
  const text = `\r\n\x1b[31m⚠️  ${message}\x1b[0m\r\n`;
  const b64 = Buffer.from(text, "utf8").toString("base64");
  const chunkId = insertMessage(sessionId, "assistant", "pty_chunk", { bytes_b64: b64 });
  broadcastToSession(sessionId, {
    type: "pty_output",
    sessionId,
    id: chunkId,
    bytes_b64: b64,
  });
  // 127 = 「command not found」 관례 exit code. iOS 가 턴 종료/세션 종료로 인지.
  insertMessage(sessionId, "system", "pty_exit", { exitCode: 127, signal: null });
  broadcastToSession(sessionId, {
    type: "pty_exit",
    sessionId,
    exitCode: 127,
    signal: null,
  });
  broadcastAll({
    type: "session_event",
    kind: "turn_complete",
    sessionId,
  });
  // cron executor 가 「예약 실행이 만든 세션의 spawn 이 실패했다」 를 즉시 error 로 기록.
  ptyEvents.emit("error", { sessionId, exitCode: 127, signal: null } satisfies PtyLifecycleEvent);
}

/**
 * 첫 입력 전 splash/init 이 끝나길 기다리는 동적 «settle» 검출의 기본 타이밍 (빠른 CLI 용).
 *
 * `pty.onData` 의 `session.lastActivity` 를 polling 하면서 «출력이 잠시 멎은» 시점을
 * splash 종료로 간주. min/max bound 로 양 극단 차단:
 *   - minMs: 너무 빨리 입력하면 splash UI 가 키 입력을 먹는 위험 — 최소 보장.
 *   - idleMs: 이만큼 새 chunk 가 안 들어오면 settled 로 판정.
 *   - maxMs: claude 가 비정상적으로 오래 splash 를 그릴 때 (네트워크 dns 등) 의 hard cap.
 *
 * 어댑터가 `firstReadyTiming()` 을 구현하면 그 값이 우선한다 — agy 는 부팅 로그인(~10s)
 * 동안 stdin 이 먹히므로 floor(minMs)/상한(maxMs)을 크게 잡아 예약 실행에서 첫 프롬프트가
 * 사라지던 race 를 막는다. 경과 시간은 «호출 시점» 이 아니라 «PTY spawn 시점(spawnedAt)»
 * 기준 — prewarm 으로 미리 떠 있던 세션은 이미 흘러간 부팅 시간만큼 즉시 통과한다.
 */
const DEFAULT_FIRST_READY = { minMs: 250, idleMs: 180, maxMs: 1200 };

/**
 * 「턴 끝남」 추정 임계값 — 사용자 입력(submit) 후 출력이 이만큼 잠잠하면 턴이 끝났거나
 * 입력 대기 중인 것으로 보고 Discord 알림을 발사한다.
 *
 * 살아있는 REPL 에는 깔끔한 «턴 종료» 신호가 없어 휴리스틱이다. 도구 호출 중 출력이 잠깐
 * 멎는 구간에 조기 발사하지 않도록 보수적으로 길게(12s) 잡는다. away-gating 이 있어 폰이
 * 보고 있을 땐 어차피 안 나가므로, 빗나가도 비용은 «안 보고 있을 때 가끔 늦거나 한 번 더» 정도.
 */
const NOTIFY_TURN_IDLE_MS = 12_000;

/**
 * «다음 정지 시 알림» 수동 구독이 켜진 세션의 짧은 idle 임계값. 12초 휴리스틱이 false-negative
 * (prompt 띄워 놓고도 12초 안마다 출력이 깜빡여 영영 안 울림) 로 놓치는 대기를 사람이 메우려고
 * 한 세션에만 «1회성» 으로 더 민감하게 잡는다. 사용자가 명시적으로 구독한 세션이라 false-fire
 * 비용을 감수한다 — 발사하면 즉시 소진(notifyNextStop=false), 다음 턴 시작/출력 재개 시 해제.
 */
const SENSITIVE_TURN_IDLE_MS = 4_000;

/**
 * 알림 미리보기용 «최근 출력» tail 버퍼 상한 (문자). 마지막 의미있는 줄 + 입력 박스 +
 * 푸터 정도면 충분하고, 더 키워봐야 추출이 어차피 마지막 줄만 쓴다. 메모리만 점유.
 */
const RECENT_OUTPUT_MAX = 8192;

/**
 * 응답 대기 리마인더 — turn_complete 가 나간 뒤에도 사용자가 응답하지 않으면 대기 시작
 * 시점 기준 이 오프셋들에서 «⏳ Still waiting» 을 다시 보낸다 (still_waiting).
 *
 * 왜 필요한가: turn_complete 는 «딱 한 번» 발사되고, 폰이 그 세션을 보고 있던 중이면
 * away-gating 으로 아예 억제된다 — 사용자가 그 한 번을 놓치면(또는 보다가 자리를 뜨면)
 * 에이전트는 질문/승인 대기 상태로 무한정 멈춰 있는데 아무 신호가 없다. AI 가 일하는
 * 시간은 분 단위, 사람이 모르는 대기는 시간 단위라 이 구간이 전체 처리량의 병목이 된다.
 *
 * away-gating / 음소거 / cron 억제 / 설정 토글은 fire 시점에 dispatchNotification 이
 * 동일하게 적용한다 — 폰이 보고 있으면 어차피 안 나가므로 체인은 무조건 무장해도 안전하고,
 * 덕분에 «최초 알림이 away-gating 으로 억제된 경우» 도 첫 리마인더가 커버한다.
 * 3회 상한 — 사용자가 보고도 응답 안 하기로 한 세션에 무한 반복하지 않는다.
 */
const WAITING_REMINDER_OFFSETS_MS = [10 * 60_000, 30 * 60_000, 60 * 60_000];

/**
 * 본문 입력과 제출용 CR(Enter) 사이의 지연. 본문+CR 을 한 버스트로 붙이면 REPL 이 «붙여넣기» 로
 * 보고 끝 CR 을 제출로 안 치므로, 본문이 입력 버퍼에 정착한 뒤 CR 을 «단독 키» 로 보낸다.
 * iOS 채팅 전송(ChatView.sendTapped)이 쓰는 50ms 와 같은 취지 — 여유를 두고 넉넉히.
 */
const SUBMIT_CR_DELAY_MS = 150;

/**
 * 제출 워치독 (폴백) — CR 을 보낸 뒤 에이전트가 응답을 시작하는지 «출력 활동» 으로 확인한다.
 *  - WINDOW_MS: 이만큼 기다렸다가 활동을 본다 (본문 echo 는 이 전에 끝나므로 응답으로 오인 X).
 *  - ACTIVE_MS: 최근 이 시간 안에 출력이 있었으면 «응답 진행 중 = 제출됨» 으로 보고 멈춘다.
 *  - MAX_RETRIES: 잠잠하면(제출 실패 의심) CR 을 최대 이만큼 더 보낸다.
 */
const SUBMIT_CONFIRM_WINDOW_MS = 1500;
const SUBMIT_ACTIVE_THRESHOLD_MS = 1000;
const SUBMIT_MAX_RETRIES = 3;

/**
 * PTY 종료 후 공유 백엔드(releaseBackend) 해제를 미루는 디바운스. restart 경로는
 * abort→awaitPtyExit→prewarm 으로 이 창 안에 새 PTY 를 다시 띄우므로, 그 사이 같은
 * adapter 의 활성 PTY 가 생겨 해제가 취소된다. delete/qwen 자체 종료는 재spawn 이 없어
 * 창이 지나면 그대로 해제 → local_llm 의 llama-server(~38GB) 회수.
 */
const BACKEND_RELEASE_DEBOUNCE_MS = 2500;

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * PTY 가 끝났을 때 호출 — 디바운스 후, 같은 adapter.id 를 쓰는 활성 PTY 가 하나도 없으면
 * adapter.releaseBackend() 로 공유 백엔드를 해제한다. local_llm 이 마지막 세션 종료 시
 * llama-server 를 내려 메모리를 회수하는 경로 (다른 adapter 엔 releaseBackend 자체가 없어
 * no-op). 재확인을 fire 시점에 하므로 restart 의 즉시 재spawn 과 안전하게 경쟁한다.
 */
function scheduleBackendReleaseIfIdle(adapter: AgentAdapter): void {
  if (!adapter.releaseBackend) return;
  setTimeout(() => {
    for (const s of activePtys.values()) {
      if (s.adapter.id === adapter.id) return; // 아직 이 백엔드를 쓰는 세션이 살아있음
    }
    try {
      adapter.releaseBackend?.();
    } catch {
      // 백엔드 해제 실패는 무해 — 다음 종료나 데몬 shutdown 에서 다시 시도된다.
    }
  }, BACKEND_RELEASE_DEBOUNCE_MS);
}

/**
 * 「에이전트가 입력/승인 대기에 진입함」 을 모든 WS 클라이언트에게 «컨텍스트와 함께» broadcast.
 * iOS 글로벌 리스너(AgentWaitNotifier)가 이 라이브 이벤트로 actionable 로컬 알림을 즉시 띄운다
 * — 외부 인프라 0 (새 서버/푸시 없이 기존 WS broadcast 데이터 plane 만 사용).
 *
 * away-gating 은 «iOS 쪽» 에서 한다(지금 그 세션 채팅을 보는 중이면 무음) — 여기선 신호만
 * 보낸다. notify_muted 세션은 Discord 와 동일하게 억제(같은 «이 세션 알림 끔» 약속).
 * best-effort: 어떤 enrich 실패도 throw 하지 않고 가능한 정보만으로 broadcast.
 */
function broadcastWaitingEntry(sessionId: string, elapsedMs: number): void {
  try {
    let repoName = "—";
    let title: string | null = null;
    let agentName = "agent";
    try {
      const row = db()
        .prepare("SELECT repo_path, title, agent, notify_muted FROM sessions WHERE id = ?")
        .get(sessionId) as
        | { repo_path: string; title: string | null; agent: string; notify_muted: number }
        | undefined;
      if (row) {
        if (row.notify_muted === 1) return; // 세션 음소거 — 알림 신호도 보내지 않음
        repoName = row.repo_path ? path.basename(row.repo_path) : "—";
        title = row.title;
        agentName =
          row.agent && hasAgent(row.agent) ? getAgent(row.agent).displayName : row.agent || "agent";
      }
    } catch {
      /* best-effort — repo/title 없이도 알림은 의미 있음 */
    }
    let preview: string | null = null;
    try {
      const s = activePtys.get(sessionId);
      if (s) preview = extractAgentPreview(s.recentOutput);
    } catch {
      preview = null;
    }
    broadcastAll({
      type: "session_event",
      kind: "waiting",
      sessionId,
      repoName,
      title,
      agentName,
      preview,
      elapsedMs,
    });
  } catch {
    /* never throw — 알림 신호 실패가 PTY 흐름을 깨면 안 됨 */
  }
}

/**
 * 대기 해제(사용자가 응답 / 출력 재개 / PTY 종료) — iOS 가 해당 세션의 대기 알림을 정리하도록
 * 신호. broadcastWaitingEntry 와 짝. best-effort, 절대 throw 안 함.
 */
function broadcastWaitingResolved(sessionId: string): void {
  try {
    broadcastAll({ type: "session_event", kind: "resolved", sessionId });
  } catch {
    /* never throw */
  }
}

/**
 * 턴 종료 추정 디바운스를 (재)무장한다. 출력이 들어올 때마다 호출되어 타이머를 미루고,
 * NOTIFY_TURN_IDLE_MS 동안 새 출력이 없으면 «턴 끝남» 알림을 발사한다.
 */
function armTurnIdle(sessionId: string): void {
  const s = activePtys.get(sessionId);
  if (!s) return;
  if (s.idleTimer) clearTimeout(s.idleTimer);
  // «다음 정지 시 알림» 을 켠 세션은 한 번 더 민감하게 — 짧은 임계값으로 다음 idle 을 잡는다.
  const idleMs = s.notifyNextStop ? SENSITIVE_TURN_IDLE_MS : NOTIFY_TURN_IDLE_MS;
  s.idleTimer = setTimeout(() => {
    s.idleTimer = null;
    if (!s.turnActive) return;
    s.turnActive = false;
    // 수동 구독은 1회성 — 발사 시 소진해, 이어지는 같은 턴의 잔여 출력이 다시 트리거하지 않게.
    s.notifyNextStop = false;
    const elapsedMs = Date.now() - s.turnStartedAt;
    // fire-and-forget — dispatchNotification 은 throw 하지 않는다. outputTail 은 옵트인 시에만
    // 한 줄 미리보기로 추출되고, 옵트아웃이면 dispatch 가 그냥 버린다 (외부로 안 나감).
    void dispatchNotification({ kind: "turn_complete", sessionId, elapsedMs, outputTail: s.recentOutput });
    ptyEvents.emit("turn_complete", { sessionId, elapsedMs } satisfies PtyLifecycleEvent);
    // 세션 구독자(채팅 화면)에게도 push — iOS WSClient 가 이미 "turn_complete" 타입을
    // 파싱하므로 새 메시지 타입 없이 «에이전트가 입력 대기 시작» 라이브 신호가 된다
    // (ChatViewModel 의 대기 배너 on). 폰이 안 보고 있으면 구독자가 없어 자연히 no-op.
    broadcastToSession(sessionId, { type: "turn_complete", sessionId });
    // «대기 진입» 을 모든 클라이언트에게 컨텍스트와 함께 — iOS 글로벌 리스너가 actionable
    // 로컬 알림을 띄운다. broadcastToSession 과 달리 폰이 그 방을 안 봐도(구독자 0) 도달한다.
    broadcastWaitingEntry(sessionId, elapsedMs);
    // 턴이 끝난(=입력 대기 추정) 시점부터 응답 대기 리마인더 체인 무장.
    startWaitingReminders(sessionId);
  }, NOTIFY_TURN_IDLE_MS);
}

/** 응답 대기 리마인더 체인을 (재)시작한다 — turn_complete 발사 직후 호출. */
function startWaitingReminders(sessionId: string): void {
  const s = activePtys.get(sessionId);
  if (!s) return;
  cancelWaitingReminders(s);
  s.waitingSince = Date.now();
  s.waitingReminderIdx = 0;
  scheduleNextWaitingReminder(sessionId);
}

function cancelWaitingReminders(s: PtySession): void {
  if (s.waitingTimer) {
    clearTimeout(s.waitingTimer);
    s.waitingTimer = null;
  }
}

function scheduleNextWaitingReminder(sessionId: string): void {
  const s = activePtys.get(sessionId);
  if (!s) return;
  if (s.waitingReminderIdx >= WAITING_REMINDER_OFFSETS_MS.length) return;
  const fireAt = s.waitingSince + WAITING_REMINDER_OFFSETS_MS[s.waitingReminderIdx];
  s.waitingTimer = setTimeout(() => {
    s.waitingTimer = null;
    // 새 턴이 시작됐으면(submit) markTurnSubmitted 가 이미 취소했지만, 방어적으로 재확인.
    if (s.turnActive || !activePtys.has(sessionId)) return;
    // 출력이 대기 시작 이후 재개됐다면 12초 idle 추정이 빗나간 것 (도구 호출 중 잠깐 멎었던
    // 경우 등) — «입력 대기» 가 아니었으므로 마지막 출력 시각으로 체인을 다시 앵커한다.
    // 재앵커는 새 출력이 있을 때만 일어나므로 무한 반복하지 않는다. 1s 슬랙: 잔여 flush 허용.
    if (s.lastActivity > s.waitingSince + 1000) {
      s.waitingSince = s.lastActivity;
      s.waitingReminderIdx = 0;
      // 출력이 재개됐으니 «대기» 가 아니었다 — 수동 구독(다음 정지 시 알림)도 함께 취소해
      // false-fire 보정과 일관되게 둔다 (이미 발사 시 소진됐지만 방어적으로 명시).
      s.notifyNextStop = false;
      // 잘못 띄웠을 수 있는 대기 알림을 iOS 가 정리하게 신호 — 출력이 다시 멎으면 armTurnIdle
      // 이 새 waiting 을 broadcast 한다.
      broadcastWaitingResolved(sessionId);
      scheduleNextWaitingReminder(sessionId);
      return;
    }
    const waitingMs = Date.now() - s.waitingSince;
    // away-gating / 음소거 / cron / 설정 토글은 dispatchNotification 이 fire 시점에 적용.
    void dispatchNotification({ kind: "still_waiting", sessionId, waitingMs, outputTail: s.recentOutput });
    s.waitingReminderIdx += 1;
    scheduleNextWaitingReminder(sessionId);
  }, Math.max(0, fireAt - Date.now()));
}

/**
 * 사용자가 한 턴을 submit 했음을 기록 + idle 디바운스 시작. runUserMessagePty (텍스트 +
 * CR) / writePtyRaw (Enter 포함 keystroke) 에서 호출.
 */
function markTurnSubmitted(sessionId: string): void {
  const s = activePtys.get(sessionId);
  if (!s) return;
  s.turnActive = true;
  s.turnStartedAt = Date.now();
  // 사용자가 응답했으니 진행 중이던 응답 대기 리마인더 체인은 해제.
  cancelWaitingReminders(s);
  // 「다음 정지 시 알림」 은 1회성 — 새 턴이 시작되면(=사용자가 응답함) 해제한다.
  s.notifyNextStop = false;
  // 사용자가 응답함 = 더는 대기 아님 — iOS 가 이 세션 대기 알림을 정리하게 신호.
  broadcastWaitingResolved(sessionId);
  armTurnIdle(sessionId);
}

async function waitForPtyFirstReady(session: PtySession): Promise<void> {
  const { minMs, idleMs, maxMs } = session.adapter.firstReadyTiming?.() ?? DEFAULT_FIRST_READY;
  while (true) {
    // spawnedAt 기준 — prewarm 으로 미리 떠서 부팅 시간이 이미 흘렀으면 즉시 통과.
    const elapsed = Date.now() - session.spawnedAt;
    if (elapsed >= maxMs) return;
    if (elapsed >= minMs) {
      const idleFor = Date.now() - session.lastActivity;
      if (idleFor >= idleMs) return;
    }
    await delay(40);
  }
}

function insertMessage(
  sessionId: string,
  role: string,
  type: string,
  payload: unknown,
): string {
  const id = randomUUID();
  db().prepare(
    `INSERT INTO messages (id, session_id, role, type, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, sessionId, role, type, JSON.stringify(payload), Date.now());
  return id;
}

/**
 * pty_chunk 보존 상한 — 이보다 오래된 청크는 compaction 으로 삭제해 messages 테이블이
 * 무한 증식하는 걸 막는다. 모든 «읽기» 경로가 이보다 훨씬 적은 최근분만 보므로 안전:
 *   - 스냅샷 재구성: 최신 SNAPSHOT_TAIL_CHUNKS(4000) tail.
 *   - 콜드 poll tail 캡: 최신 limit(기본 600).
 *   - WS catch-up: since 이후, 최대 1000.
 * 즉 retain ≫ 모든 reader 윈도우라 «화면/스크롤백 복원» 에 손실이 없다. user/exit/result
 * 메시지는 건드리지 않는다(개수가 적고 의미가 큼).
 */
export const PTY_CHUNK_RETAIN = 8000;

/**
 * 세션의 pty_chunk 를 최신 `retain` 개만 남기고 정리. created_at DESC 로 retain 번째 경계를
 * 찾아 그보다 오래된 행을 한 번에 삭제한다. onFlush 가 일정 주기로 호출(핫패스 부담 최소화).
 * @returns 삭제된 행 수.
 */
export function prunePtyChunks(sessionId: string, retain = PTY_CHUNK_RETAIN): number {
  const boundary = db()
    .prepare(
      `SELECT created_at FROM messages
       WHERE session_id = ? AND type = 'pty_chunk'
       ORDER BY created_at DESC, id DESC LIMIT 1 OFFSET ?`,
    )
    .get(sessionId, Math.max(0, retain - 1)) as { created_at: number } | undefined;
  if (!boundary) return 0;
  const res = db()
    .prepare(
      `DELETE FROM messages
       WHERE session_id = ? AND type = 'pty_chunk' AND created_at < ?`,
    )
    .run(sessionId, boundary.created_at);
  return res.changes ?? 0;
}

/**
 * 연속 insert 실패 로그 스팸 억제 윈도우(ms). 한 세션이 디스크 풀/락 경합으로 매 flush 마다
 * 실패하면 15ms 마다 console.warn 이 쏟아질 수 있어, 세션당 최대 이 간격에 1회만 요약 출력한다.
 */
const INSERT_FAIL_LOG_INTERVAL_MS = 5_000;

/**
 * PtyChunkBuffer.onFlush 핸들러 팩토리 — 세션 1개의 coalesced 출력 청크를 받아
 * (1) 위험 OSC/REP 정화 → (2) messages 테이블에 pty_chunk 저장 → (3) 같은 id 로 WS broadcast
 * → (4) 주기적 compaction 을 수행한다. 세션별 카운터(flush/실패)는 클로저에 캡슐화.
 *
 * ## 신뢰성 — flush 타이머 루프를 절대 죽이지 않는다
 *
 * cron·workflow·다중 PTY 세션이 같은 SQLite messages 테이블에 동시에 쓰므로 SQLITE_BUSY·
 * 디스크 풀 같은 «일시» 오류가 충분히 가능하다. insert/broadcast 를 try/catch 로 격리하지
 * 않으면, throw 가 flush 타이머 콜백 밖으로 새어 (1) 같은 콜백의 broadcast 가 실행되지 않아
 * 출력이 유실되고 (2) 타이머 루프가 죽어 세션 터미널이 영영 멎는다. 여기서:
 *   - SQLITE_BUSY 단발 경합은 db() 의 busy_timeout 이 동기 대기로 흡수(파일: db/index.ts).
 *   - 그래도 throw 하면 격리·로깅하고 «다음 flush 는 계속» — 콜백은 죽지 않는다.
 *
 * ## insert/broadcast 의 원자성
 *
 * WS broadcast 와 messages insert 는 «같은 messageId» 를 공유해야 iOS 가 WS push 1회 +
 * polling history 1회를 dedup 한다. 따라서 insert 가 실패하면 broadcast 도 «반드시» 스킵한다
 * — 안 그러면 id 없는(혹은 어긋난) chunk 가 WS 로만 흘러 polling 본과 정합이 깨지고 ANSI
 * cursor 가 어긋난다. 반대로 insert 성공 후 broadcast 만 실패하면, 청크는 이미 DB 에 있어
 * iOS polling/catch-up 이 복구하므로(유실 아님) 로그만 남기고 넘어간다.
 */
export function createPtyFlushHandler(sessionId: string): (merged: Buffer) => void {
  let flushCount = 0;
  let insertFailCount = 0;
  let lastInsertFailLogAt = 0;
  return (merged: Buffer): void => {
    // 위험 OSC/REP 중화 — 신뢰 못 할 콘텐츠(cat/fetch/LLM 응답)가 폰 SwiftTerm 을 공격면으로
    // 삼는 걸 막는다. broadcast 와 저장(replay) 둘 다 정화본을 쓰게 해 진입 이후 표면을 닫는다.
    const safe = ALLOW_UNSAFE_OSC ? merged : sanitizeLivePtyOutput(merged);
    const b64 = safe.toString("base64");

    // (2) insert — 실패 시 격리·로깅 후 «return» 하여 broadcast 까지 스킵(원자성).
    let messageId: string;
    try {
      messageId = insertMessage(sessionId, "assistant", "pty_chunk", { bytes_b64: b64 });
    } catch (e) {
      insertFailCount++;
      const now = Date.now();
      // 로그 스팸 억제 — 폭주 시 INSERT_FAIL_LOG_INTERVAL_MS 마다 1회만 누적 요약.
      if (now - lastInsertFailLogAt >= INSERT_FAIL_LOG_INTERVAL_MS) {
        console.warn(
          `[pty-runner] pty_chunk insert 실패 session=${sessionId} (누적 ${insertFailCount}회): ${(e as Error).message} — 이 청크 출력 유실, 다음 flush 는 계속`,
        );
        lastInsertFailLogAt = now;
      }
      return;
    }

    // (3) broadcast — insert 와 같은 id. 실패해도 청크는 이미 DB 에 있어 polling 이 복구.
    try {
      broadcastToSession(sessionId, {
        type: "pty_output",
        sessionId,
        id: messageId,
        bytes_b64: b64,
      });
    } catch (e) {
      console.warn(
        `[pty-runner] pty_chunk broadcast 실패 session=${sessionId} (DB 저장됨, polling 복구): ${(e as Error).message}`,
      );
    }

    // (4) compaction — 매 512 flush 마다 한 번만 (핫패스 부담 최소화). 오래된 pty_chunk 를
    // 잘라 messages 테이블 무한 증식 방지. 모든 reader 윈도우보다 retain 이 커 손실 없음.
    if ((++flushCount & 0x1ff) === 0) {
      try {
        prunePtyChunks(sessionId);
      } catch (e) {
        console.warn(`[pty-runner] prune failed session=${sessionId}`, (e as Error).message);
      }
    }
  };
}

/**
 * PTY 프로세스를 lazy 하게 spawn 한다. 이미 살아있으면 그걸 재사용. spawn 세부 (binary
 * 경로 / args / env) 는 모두 ctx.adapter 가 결정 — runner 는 agent 무관 transport.
 */
function ensurePty(ctx: SessionContext, bypassPermissions: boolean): PtySession {
  const existing = activePtys.get(ctx.sessionId);
  if (existing) return existing;

  const adapter = ctx.adapter;
  const spawnCtx = {
    resumeFrom: ctx.resumeFrom,
    bypassPermissions,
  };
  // 온디맨드 백엔드 준비 — local_llm 은 여기서 llama-server 를 기동(멱등, fire-and-forget).
  // 다른 adapter 엔 no-op. 첫 spawn 시 1회 — 세션 prewarm 이 곧장 서버 워밍을 시작시킨다.
  // spawnCtx 를 넘겨 opencode 가 bypassPermissions 를 opencode.json 에 반영하게 한다.
  adapter.prepareBackend?.(spawnCtx);
  // 터미널 실행이면 spawnOverride(셸+스크립트)로, 아니면 adapter 가 binary/args 를 결정.
  const binary = ctx.spawnOverride?.binary ?? adapter.resolveBinary();
  const args = ctx.spawnOverride?.args ?? adapter.buildSpawnArgs(spawnCtx);

  // env 는 사용자 자격을 읽도록 process.env 를 그대로 유지하되, adapter 가 권장하는
  // env (auto-updater 비활성 등 first-turn latency 줄이는 것들) 을 위에 덮어쓴다.
  // TERM 은 모든 PTY 공통으로 xterm-256color 강제.
  //
  // LANG/LC_ALL/LC_CTYPE: UTF-8 locale 명시. macOS GUI 앱 (launchd 가 띄운 PocketSisyphusMac)
  // 의 process.env 는 LANG 이 비어있는 경우가 흔한데, PTY readline 의 wcwidth() 가 LANG 없으면
  // 한글/CJK 를 1 cell (narrow) 로 처리 → cursor 가 1 cell 만 이동 → 다음 글자가 옛 글자를
  // 덮어씀 (사용자 보고: 「아 다음 주 치면 아가 덮어씌워짐」, 2026-05).
  // 시스템에 항상 있는 en_US.UTF-8 사용 — charset 이 UTF-8 이면 wcwidth 가 CJK wide 처리.
  const env = {
    ...process.env,
    LANG: process.env.LANG || "en_US.UTF-8",
    LC_ALL: process.env.LC_ALL || "en_US.UTF-8",
    LC_CTYPE: process.env.LC_CTYPE || "en_US.UTF-8",
    TERM: "xterm-256color",
    ...adapter.buildSpawnEnv(),
  };

  console.log(
    `[pty-runner] session=${ctx.sessionId} spawn ${adapter.id} (bypass=${bypassPermissions}) cwd=${ctx.cwd}`,
  );

  // 초기 cols/rows — iOS SwiftTerm 의 sizeChanged delegate 가 즉시 device 폭 기반 값으로
  // resize 요청하므로 이 값은 첫 splash burst 직전 짧은 순간에만 유효. iOS 측 frame
  // 폭(850pt @ 11pt ≈ 130 cols) 과 같은 자릿수로 맞춰 첫 출력의 줄바꿈이 어색하지 않게.
  const COLS = 130;
  const ROWS = 40;
  const pty = ptySpawn(binary, args, {
    name: "xterm-256color",
    cols: COLS,
    rows: ROWS,
    cwd: ctx.cwd,
    env: env as { [key: string]: string },
  });

  let resolveDone!: () => void;
  const done = new Promise<void>((r) => {
    resolveDone = r;
  });

  // PTY 출력 청크 coalescing — 15ms 윈도우. ANSI redraw burst 가 5~20개 청크로 쪼개져
  // 들어오는 케이스에서 SQLite INSERT + JSON.stringify + ws.send + Tor onion 암호화를
  // 모두 1회로 압축. 사용자 입력 echo (단발 청크) 는 ~14ms 추가 latency 만 — 1 프레임 미만.
  const outputBuffer = new PtyChunkBuffer({
    delayMs: 15,
    maxBytes: 16 * 1024,
    onFlush: createPtyFlushHandler(ctx.sessionId),
  });

  const session: PtySession = {
    pty,
    adapter,
    done,
    lastActivity: Date.now(),
    spawnedAt: Date.now(),
    firstInputSent: false,
    outputBuffer,
    turnActive: false,
    turnStartedAt: 0,
    idleTimer: null,
    waitingTimer: null,
    waitingSince: 0,
    waitingReminderIdx: 0,
    notifyNextStop: false,
    intentionalStop: false,
    recentOutput: "",
    pendingPreviewCache: null,
  };
  activePtys.set(ctx.sessionId, session);
  // PTY 가 성공적으로 떴으니 옛 spawn-실패 dedup 플래그 해제 — 이후 다른 실패는 다시 보고.
  spawnFailureEmitted.delete(ctx.sessionId);

  pty.onData((chunk: string) => {
    session.lastActivity = Date.now();
    // 턴이 진행 중이면 출력이 들어올 때마다 idle 디바운스를 미룬다 — 스트림이 멎어야 발사.
    if (session.turnActive) armTurnIdle(ctx.sessionId);
    // 알림 미리보기용 최근 출력 tail — 이어붙이고 상한으로 캡 (메모리만, 영속 X).
    session.recentOutput = (session.recentOutput + chunk).slice(-RECENT_OUTPUT_MAX);
    // raw bytes — iOS SwiftTerm 이 ANSI 그대로 렌더한다.
    outputBuffer.push(Buffer.from(chunk, "utf8"));
  });

  pty.onExit(({ exitCode, signal }) => {
    console.log(
      `[pty-runner] session=${ctx.sessionId} exit code=${exitCode} signal=${signal}`,
    );
    // 진행 중이던 턴 디바운스를 취소 — 종료 알림이 곧 나가므로 turn_complete 와 중복 방지.
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
      session.idleTimer = null;
    }
    // 응답 대기 리마인더도 해제 — 죽은 PTY 는 더 이상 기다리지 않는다.
    cancelWaitingReminders(session);
    session.turnActive = false;
    // REPL 프로세스 종료 알림 — 정상(code 0) 이면 session_exit, 비정상이면 error.
    // 단, 우리가 의도적으로 죽인 경우(restart/clear/delete)는 알림 생략.
    if (!session.intentionalStop) {
      const exitKind = (typeof exitCode === "number" && exitCode !== 0) || signal
        ? "error"
        : "session_exit";
      void dispatchNotification({
        kind: exitKind,
        sessionId: ctx.sessionId,
        exitCode: typeof exitCode === "number" ? exitCode : null,
        signal: signal != null ? String(signal) : null,
      });
      ptyEvents.emit(exitKind, {
        sessionId: ctx.sessionId,
        exitCode: typeof exitCode === "number" ? exitCode : null,
        signal: signal != null ? String(signal) : null,
      } satisfies PtyLifecycleEvent);
    }
    // 잔여 pty_chunk 를 먼저 flush — 그래야 pty_exit 이벤트 전에 마지막 출력이 도착.
    // dispose 는 flush 후 새 push 차단.
    outputBuffer.dispose();
    activePtys.delete(ctx.sessionId);
    insertMessage(ctx.sessionId, "system", "pty_exit", {
      exitCode,
      signal,
    });
    broadcastToSession(ctx.sessionId, {
      type: "pty_exit",
      sessionId: ctx.sessionId,
      exitCode,
      signal,
    });
    broadcastAll({
      type: "session_event",
      kind: "turn_complete",
      sessionId: ctx.sessionId,
    });
    // PTY 종료 = 더는 입력 대기 아님 — iOS 가 이 세션 대기 알림을 정리하게 신호.
    broadcastWaitingResolved(ctx.sessionId);
    resolveDone();
    // 공유 백엔드 해제 — 이 adapter 를 쓰는 다른 활성 PTY 가 없으면 (디바운스 후 재확인)
    // 내린다. local_llm 이 마지막 세션 종료 시 llama-server(~38GB) 를 여기서 회수한다.
    // restart 는 디바운스 안에 새 PTY 가 떠서 자동 취소된다.
    scheduleBackendReleaseIfIdle(ctx.adapter);
  });

  return session;
}

/**
 * PTY 를 미리 spawn 만 한다 (사용자 입력은 안 흘림). 세션 생성 직후 호출하면 사용자가
 * 채팅창 진입하는 동안 claude REPL 이 부팅되고 — 이어받기 세션이면 `--resume <id>` 가
 * 곧장 직전 대화를 PTY 에 토해내 SwiftTerm 으로 즉시 보인다. 옛 동작 (lazy spawn) 은
 * 사용자가 첫 메시지 보낼 때까지 화면이 비어 있어 「이어받기가 작동 안 한다」 오해를
 * 부르고 있었다 (2026-05).
 *
 * idempotent — 이미 active 인 세션이면 no-op.
 */
export function prewarmPty(
  ctx: SessionContext,
  opts: { bypassPermissions?: boolean } = {},
): void {
  if (activePtys.has(ctx.sessionId)) return;
  ensurePty(ctx, opts.bypassPermissions === true);
}

/**
 * 사용자 입력을 처리한다.
 *
 * PTY 는 한 프로세스가 계속 살아있어서 await 가 turn 완료를 의미하지 않는다. 호출자는
 * fire-and-forget 으로 쓸 것 — 실제 응답은 onData 가 WS 로 streaming 한다.
 */
export async function runUserMessagePty(
  ctx: SessionContext,
  userPrompt: string,
  opts: { bypassPermissions?: boolean } = {},
): Promise<void> {
  // 사용자 메시지를 먼저 기록 + WS push (모바일이 input echo 를 즉시 받을 수 있게)
  insertMessage(ctx.sessionId, "user", "pty_user_input", { text: userPrompt });
  broadcastToSession(ctx.sessionId, {
    type: "user_message",
    sessionId: ctx.sessionId,
    text: userPrompt,
  });

  let session: PtySession;
  try {
    session = ensurePty(ctx, opts.bypassPermissions === true);
  } catch (e) {
    // CLI 미설치 등 — 옛 동작은 호출부 `.catch(console.error)` 로 흡수돼 사용자가 자기
    // 말풍선만 보고 빈 터미널에 갇히던 침묵 실패. 이제 안내를 터미널에 노출하고 종료한다.
    emitSpawnFailure(ctx.sessionId, e);
    return;
  }

  // 이 PTY 의 첫 입력이면 splash/init(또는 agy 로그인)이 끝나기를 기다린 뒤 입력. 이후 턴은
  // 즉시. prewarm 으로 미리 떠 있던 세션도 첫 입력은 여기서 보호된다 (이미 흘러간 부팅 시간만큼
  // 즉시 통과 — spawnedAt 기준).
  if (!session.firstInputSent) {
    await waitForPtyFirstReady(session);
    session.firstInputSent = true;
  }

  // iOS 채팅 «전송 버튼» 과 «동일한» 제출 레시피 — 실기기에서 검증된 경로(ChatView.sendTapped /
  // 첨부·파일참조 프롬프트). 두 단계가 «둘 다» 필요하다:
  //
  //  1) 개행(\n)을 공백으로 — REPL 은 «여러 줄» 입력의 제출을 애매하게 처리해, 멀티라인 프롬프트
  //     (워크플로우 노드 프롬프트는 헤더+본문+프로토콜로 여러 줄)는 끝에 CR 을 줘도 실행이 안 된다.
  //     한 줄로 펴면 일반 메시지와 동일해져 CR 한 번으로 확실히 제출된다. (iOS 도 첨부/파일참조
  //     합성 프롬프트를 `\n`→" " 로 펴서 보낸다.)
  //  2) 본문을 먼저 쓰고 «짧은 딜레이 후» CR 을 단독으로 — 본문+CR 을 한 버스트로 붙이면 REPL 이
  //     붙여넣기로 보고 끝 CR 을 제출로 안 친다.
  //
  // (앞선 시도들이 실패한 이유: ① CR 만 지연 분리 → 멀티라인이라 여전히 실패, ② bracketed paste
  //  로 감싸기 → REPL 이 제출을 안 함. 결국 «한 줄로 펴기» 가 빠진 게 핵심이었다.)
  const oneLine = userPrompt.replace(/\r?\n/g, " ");
  session.pty.write(oneLine);
  await new Promise((r) => setTimeout(r, SUBMIT_CR_DELAY_MS));
  session.pty.write("\r");

  // 한 턴 submit — 출력이 잠잠해지면 «턴 끝남» 알림 (away-gating 통과 시).
  markTurnSubmitted(ctx.sessionId);

  // 제출 워치독 (폴백) — CR 이 «제출» 로 안 먹는 경우(REPL 입력 상태/멀티라인 잔재 등)를 대비해,
  // 에이전트가 응답을 시작하는지 확인하고 잠잠하면 CR 을 몇 번 더 보낸다. fire-and-forget.
  void confirmSubmissionWatchdog(session);
}

/**
 * 제출 워치독 — 본문+CR 을 보낸 뒤 에이전트가 «응답을 시작했는지» 를 출력 활동(`lastActivity`)으로
 * 확인한다. WINDOW 동안 새 출력이 없으면(=Enter 가 제출로 안 먹힌 것으로 의심) CR 을 한 번 더
 * 보낸다 (최대 MAX_RETRIES). 응답이 흐르기 시작하면 즉시 멈춘다.
 *
 * 이미 제출된 뒤의 추가 CR 은 대부분 REPL 에서 «빈 입력에 Enter» = no-op 이라 부작용이 거의 없다 —
 * 사용자가 요청한 «엔터가 안 먹으면 다시 눌러주는» 안전 보강. PTY 가 죽으면 write 가 던져 멈춘다.
 */
async function confirmSubmissionWatchdog(session: PtySession): Promise<void> {
  for (let i = 0; i < SUBMIT_MAX_RETRIES; i++) {
    await new Promise((r) => setTimeout(r, SUBMIT_CONFIRM_WINDOW_MS));
    // 최근까지 출력이 흐르면 응답 진행 중 = 제출 성공 → 더 누르지 않는다.
    if (Date.now() - session.lastActivity < SUBMIT_ACTIVE_THRESHOLD_MS) return;
    try {
      session.pty.write("\r");
    } catch {
      return;
    }
  }
}

/**
 * 터미널 예약 실행 — `ctx.spawnOverride` ({binary, args}) 로 쉘+스크립트를 spawn 하고 «즉시»
 * 반환한다. 사용자 입력을 쓰지 않는다: 스크립트가 알아서 돌고 끝나면 onExit 가 발사된다 —
 * code 0 이면 session_exit, 비0/시그널이면 error. cron executor 가 그 이벤트를 결과로 기록한다.
 *
 * runUserMessagePty 와 달리 markTurnSubmitted 를 호출하지 않으므로 12초 idle turn_complete 은
 * 절대 발사되지 않는다 — «프로세스가 끝났을 때» 만 완료로 본다 (장시간 도는 스크립트를 조기
 * 완료로 오판하지 않게). 한없이 매달리는 스크립트는 executor 의 MAX_RUNTIME_MS 가 잘라낸다.
 */
export function runTerminalScriptPty(ctx: SessionContext): void {
  const ov = ctx.spawnOverride;
  // 무엇을 실행하는지 transcript 맨 위에 dim 한 줄로 남긴다 ($ zsh -l /path/script.sh).
  const header = ov ? `\x1b[2m$ ${ov.binary} ${ov.args.join(" ")}\x1b[0m\r\n` : "";
  if (header) {
    const b64 = Buffer.from(header, "utf8").toString("base64");
    const chunkId = insertMessage(ctx.sessionId, "assistant", "pty_chunk", { bytes_b64: b64 });
    broadcastToSession(ctx.sessionId, { type: "pty_output", sessionId: ctx.sessionId, id: chunkId, bytes_b64: b64 });
  }
  try {
    // bypassPermissions 는 터미널엔 무의미 — false. ensurePty 가 spawnOverride 로 셸+스크립트 spawn.
    ensurePty(ctx, false);
  } catch (e) {
    // 셸 바이너리 자체가 없는 등 — 안내를 터미널에 노출하고 error 로 종료시킨다.
    emitSpawnFailure(ctx.sessionId, e);
  }
}

/** 이 세션의 PTY 가 지금 살아있는지 — cron overlap 판정 (직전 실행이 아직 도는지). */
export function isPtyActive(sessionId: string): boolean {
  return activePtys.has(sessionId);
}

/**
 * 이 세션 PTY 프로세스의 PID — 자식 프로세스 트리 추적용(라이브 프리뷰 포트 감지).
 * PTY 미가동이면 null. (감지는 PTY 자식 기준이라 worktree/cwd 와 무관.)
 */
export function getPtyPid(sessionId: string): number | null {
  const s = activePtys.get(sessionId);
  return s ? s.pty.pid : null;
}

/**
 * 이 세션이 «사용자 입력을 기다리는 중» 이면 그 시작 시각(epoch ms), 아니면 null.
 *
 * 세션 목록 / poll 응답이 싣는다 (routes/sessions.ts → iOS 의 목록 «입력 대기» 배지 +
 * 채팅 대기 배너). 사람의 주의를 어느 세션에 먼저 줄지 고르는 triage 신호 — 약한고리
 * 보강의 일부 (still_waiting 리마인더와 같은 상태를 본다).
 *
 * 판정: PTY 살아있음 + 턴 진행 중 아님 + 최소 한 턴의 turn_complete 가 발사됐음
 * (waitingSince>0) + 출력이 NOTIFY_TURN_IDLE_MS 이상 잠잠. 반환값은 turn_complete
 * 발사 시각과 마지막 출력 시각 중 더 최근 — 출력이 재개됐다 다시 멎은 경우의 보정.
 */
export function getPtyWaitingSince(sessionId: string): number | null {
  const s = activePtys.get(sessionId);
  if (!s || s.turnActive || s.waitingSince <= 0) return null;
  if (Date.now() - s.lastActivity < NOTIFY_TURN_IDLE_MS) return null;
  return Math.max(s.waitingSince, s.lastActivity);
}

/**
 * 이 세션이 «입력 대기» 중이면 그 보류 prompt 의 한~두 줄 미리보기, 아니면 null.
 *
 * 세션 목록/poll 응답이 싣는다 (routes/sessions.ts → iOS 대기 카드 인라인 미리보기 +
 * 일괄 «모두 승인» 확인 다이얼로그). 사용자가 카드를 하나씩 열지 않고 «지금 무엇을 묻고
 * 멈췄는지» 를 바로 읽어 triage 하게 하는 신호다.
 *
 * 추출은 알림 미리보기와 «같은» extractAgentPreview 를 이미 라이브 sanitize(OSC/REP 차단)를
 * 거친 recentOutput 에 적용한다 — 새 공격면 없음, ANSI 제거 + 박스/chrome 제외 + grapheme
 * 단위 ~200자 truncate. 순수 스피너/진행바뿐이면 null (카드가 기존 모양 유지).
 *
 * 게이트는 getPtyWaitingSince 와 동일 (대기 중일 때만). 추출 결과는 waitingSince 기준으로
 * 캐시해 목록 polling 마다 재추출하지 않는다 — 출력이 재개돼 다시 멎으면 waitingSince 가
 * 갱신돼 캐시가 무효화된다.
 */
export function getPtyPendingPreview(sessionId: string): string | null {
  const s = activePtys.get(sessionId);
  if (!s || s.turnActive || s.waitingSince <= 0) return null;
  if (Date.now() - s.lastActivity < NOTIFY_TURN_IDLE_MS) return null;
  if (s.pendingPreviewCache && s.pendingPreviewCache.waitingSince === s.waitingSince) {
    return s.pendingPreviewCache.preview;
  }
  const preview = extractAgentPreview(s.recentOutput);
  s.pendingPreviewCache = { waitingSince: s.waitingSince, preview };
  return preview;
}

/**
 * 활성 PTY 의 «대기 추정 근거» 를 폰에 노출하기 위한 스냅샷 — 휴리스틱이 놓친 false-negative
 * 를 사람이 메울 수 있게 한다. PTY 미가동(종료/dead)이면 null → iOS 가 idle 표시·토글을 비활성.
 *
 * 새 추적 상태를 늘리지 않고 기존 `lastActivity` / `waitingReminderIdx` / `notifyNextStop`
 * 을 그대로 읽는다 (수용 기준: 추가 추적 최소화). idleMs 는 «마지막 출력 이후» 라 도구
 * 연쇄로 출력이 흐르는 동안엔 0 으로 갱신돼 헛경보를 막는다.
 *   - lastActivity: 마지막 raw chunk 시각(epoch ms) — iOS 가 «조용함 N분» 을 라이브로 계산.
 *   - idleMs: 지금까지의 idle (ms) — 서버 시점 스냅샷.
 *   - waitingReminderIdx: 발사된 응답 대기 리마인더 단계 (0=아직, 1.. =N회 발사됨).
 *   - notifyNextStop: 「다음 정지 시 알림」 수동 구독이 무장돼 있는지.
 */
export function getPtyAttention(sessionId: string): {
  lastActivity: number;
  idleMs: number;
  waitingReminderIdx: number;
  notifyNextStop: boolean;
} | null {
  const s = activePtys.get(sessionId);
  if (!s) return null;
  return {
    lastActivity: s.lastActivity,
    idleMs: Math.max(0, Date.now() - s.lastActivity),
    waitingReminderIdx: s.waitingReminderIdx,
    notifyNextStop: s.notifyNextStop,
  };
}

/**
 * 「다음 정지 시 알림」 수동 구독을 켜고 끈다 — 활성 PTY 한정. 켜면 그 세션의 다음 idle 을
 * SENSITIVE_TURN_IDLE_MS(4초)로 더 민감하게 잡아 한 번 더 대기 알림을 발사한다(1회성).
 *
 * 반환: 적용됐는지 (활성 PTY 가 있어 무장/해제됨). dead/미가동 세션은 false — iOS 가
 * «적용 불가» 로 처리. 턴이 진행 중이면 즉시 짧은 임계값으로 idle 디바운스를 다시 무장한다.
 * 예약/워크플로우 세션(turnActive=false 인 스크립트 실행)에선 플래그만 서고, 어차피 발사
 * 콜백이 turnActive 를 보고 no-op 이라 «프로세스가 끝났을 때만 완료» 판정과 충돌하지 않는다.
 */
export function setNotifyNextStop(sessionId: string, enabled: boolean): boolean {
  const s = activePtys.get(sessionId);
  if (!s) return false;
  s.notifyNextStop = enabled;
  // 턴이 진행 중이면 바뀐 임계값이 즉시 반영되도록 idle 디바운스를 재무장.
  if (s.turnActive) armTurnIdle(sessionId);
  return true;
}

/**
 * PTY 프로세스를 SIGTERM 으로 종료. abortSession 호환.
 * 반환: 실제로 살아있던 PTY 를 죽였는지.
 */
export function abortPtySession(sessionId: string): boolean {
  const s = activePtys.get(sessionId);
  if (!s) return false;
  // 의도적 종료 표시 — onExit 의 종료/에러 알림 생략. (restart/clear/delete 경로)
  s.intentionalStop = true;
  try {
    s.pty.kill("SIGTERM");
  } catch (e) {
    console.warn(`[pty-runner] kill failed session=${sessionId}`, e);
  }
  return true;
}

/**
 * PTY 가 실제로 종료될 때까지 대기 (clear/delete 핸들러용).
 * 잔여 onData 가 INSERT 를 치는 race 방지.
 */
export function awaitPtyExit(sessionId: string, timeoutMs = 3000): Promise<void> {
  const s = activePtys.get(sessionId);
  if (!s) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      console.warn(
        `[pty-runner] awaitPtyExit(${sessionId}): ${timeoutMs}ms 안에 안 끝남 — 강행`,
      );
      resolve();
    }, timeoutMs);
    s.done.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * PTY 의 cols/rows 를 동기화 (iOS 가 디바이스 회전/폰트 변경 시 호출).
 */
export function resizePty(sessionId: string, cols: number, rows: number): boolean {
  const s = activePtys.get(sessionId);
  if (!s) return false;
  const c = Math.max(1, cols | 0);
  const r = Math.max(1, rows | 0);
  try {
    s.pty.resize(c, r);
    return true;
  } catch (e) {
    console.warn(`[pty-runner] resize failed session=${sessionId}`, e);
    return false;
  }
}

/**
 * 현재 살아있는 PTY 의 cols/rows. 스냅샷 재구성(`pty-snapshot`)이 헤드리스 터미널을 같은
 * 폭으로 띄워 줄바꿈을 맞추는 데 쓴다. PTY 가 죽었거나 없으면 null → 호출자가 기본값 사용.
 */
export function getPtySize(sessionId: string): { cols: number; rows: number } | null {
  const s = activePtys.get(sessionId);
  if (!s) return null;
  const p = s.pty as { cols?: number; rows?: number };
  const cols = Math.max(1, p.cols ?? 0);
  const rows = Math.max(1, p.rows ?? 0);
  if (cols <= 1 && rows <= 1) return null;
  return { cols, rows };
}

/**
 * 실시간 keystroke 채널 — WS `pty_input` 메시지 수신 시 호출. 임의 바이트를 PTY stdin 으로
 * 그대로 흘린다. iOS 의 RealtimeTextField 가 ASCII 매 글자 / 한글 음절 완료 / Ctrl-C 등
 * 특수키를 base64 로 인코딩해 보낸다.
 *
 * sendPtyKey 의 6 종 화이트리스트와 달리 임의 바이트를 허용하는 이유:
 *   - WS 토큰 인증을 통과한 페어된 iOS 만 호출 가능 (trusted client)
 *   - 「진짜 터미널」 UX 를 제공하려면 Ctrl-C/Ctrl-D/Ctrl-Z, escape 시퀀스가 모두 필요
 *   - REPL 이 어차피 stdin 으로 같은 바이트를 받는 환경 (사람이 키보드로 치는 것과 동치)
 *
 * 길이 제한은 64KB — 키스트로크 단위 호출이라 보통 1~10 byte. 큰 페이로드는 기존
 * runUserMessagePty 경로로 가야 한다.
 */
export function writePtyRaw(sessionId: string, bytes: Buffer): boolean {
  const s = activePtys.get(sessionId);
  if (!s) {
    // 진단: activePtys map 의 현재 상태를 함께 박는다. 사용자가 본 «소프트 키보드 입력
    // 안 됨» 의 가장 그럴법한 원인은 daemon 재시작 후 옛 세션 ID 로 pty_input 이 와서
    // activePtys 미스. 명시적 로그가 있어야 다음 디버그가 빠르다.
    const known = [...activePtys.keys()];
    console.warn(
      `[pty-runner] writePtyRaw: NO ACTIVE PTY for session=${sessionId} ` +
      `activePtys.size=${activePtys.size} known=[${known.join(", ")}] dropped_bytes=${bytes.length}`,
    );
    return false;
  }
  if (bytes.length === 0) return true;
  if (bytes.length > 65536) {
    console.warn(`[pty-runner] writePtyRaw too large session=${sessionId} bytes=${bytes.length}`);
    return false;
  }
  // 마지막 게이트 — SwiftTerm 이 stale 하게 회신한 터미널 질의 응답(DA/kitty/OSC color)을
  // 제거해 에이전트 입력창 오염([?0u[?65;...c11;rgb:...)을 막는다. 1차 방어는 iOS send()
  // 지만 구버전 클라이언트 대비. 사용자 입력 byte 는 통과 (pty-sanitize 주석 참고).
  const bytes_ = stripTerminalQueryResponses(bytes);
  if (bytes_.length === 0) {
    // 페이로드 전체가 stale 응답이었음 — 통째 드롭, write 안 함.
    return true;
  }
  try {
    // node-pty 의 write(string | Buffer) — Buffer 를 그대로 넘긴다. binary-safe.
    // 옛 구현은 bytes.toString("binary") 로 latin-1 string 을 만든 다음 pty.write 가
    // 그걸 UTF-8 으로 re-encode 하면서 한글 같은 multi-byte 가 두 배로 깨졌다 (e5 88 9c
    // → c3 a5 c2 88 c2 9c). Buffer 직접 전달이면 byte 가 PTY 까지 그대로 흐른다.
    s.pty.write(bytes_);
    // keystroke 에 CR(0x0d, Enter) 이 들어 있으면 한 턴 submit 으로 본다 — 실시간 ASCII
    // 입력 경로에서도 «턴 끝남» 알림이 동작하도록. (글자 입력 echo 는 turnActive 가 아니라
    // 디바운스를 무장시키지 않으므로 미완성 프롬프트로 오발사되지 않는다.)
    if (bytes_.includes(0x0d)) markTurnSubmitted(sessionId);
    // 입력 바이트 추적(PS_KS_TRACE=1) — iOS send 와 동일 포맷의 recv 라인을 찍어 양끝 대조.
    // sanitize 로 term-query 응답이 떨어졌으면 송신 bytes 와 차이가 나므로 note 로 설명한다.
    // 한글 byte 는 SwiftTerm 송신 시 e5/e6/ec…(UTF-8 BMP lead byte) 로 시작 — WS·sanitize 가
    // 옮기는 동안 손실이 있으면 여기서 다른 byte 로 보인다. OFF 면 포매팅도 안 한다(영향 0).
    if (KS_TRACE) {
      const dropped = bytes.length - bytes_.length;
      ksTrace("recv", sessionId, s.adapter.id, bytes_, dropped > 0 ? `(dropped ${dropped}B term-response)` : undefined);
    }
    return true;
  } catch (e) {
    console.warn(`[pty-runner] raw write failed session=${sessionId}`, e);
    return false;
  }
}

/**
 * 가상 키보드 입력 — REPL 이 다항 선택 prompt (화살표로 위/아래 옮기고 Enter 로 선택) 를
 * 띄울 때 모바일 사용자가 그걸 제어할 수 있도록 raw 키 시퀀스를 stdin 으로 흘려보낸다.
 *
 * 클라이언트가 임의 바이트를 보낼 수 있게 두면 키 입력 외 명령 인젝션 면이 늘어나므로
 * 의도된 6 종만 화이트리스트 — 화살표 4 종 / Space / Enter. 텍스트 입력은 기존
 * runUserMessagePty 경로를 그대로 쓴다.
 *
 * NOTE: WS 의 `pty_input` 채널 (writePtyRaw) 도입 후로는 iOS realtime 모드가 이 함수를
 * 거의 안 쓴다. HTTP POST /pty/key 는 fallback (구버전 iOS / WS 끊김 상태) 로만 남는다.
 */
export function sendPtyKey(
  sessionId: string,
  key: "up" | "down" | "left" | "right" | "scroll_up" | "scroll_down",
): boolean {
  const s = activePtys.get(sessionId);
  if (!s) return false;
  // 휠 스크롤 — `wheel_scroll_v1` 을 광고하는 alt-screen TUI(copilot 등)는 본문 스크롤을
  // «마우스 휠» 로만 받는다 (부팅 시 DECSET 1002 + SGR 1006 을 켜 둠 — copilot 어댑터 주석의
  // 실측 감사: copilot 1.0.63 이 ?1002h+?1006h 를 플래그 없이 방출). 화살표 키로는 안 움직이므로,
  // iOS 의 «스크롤 위/아래» 버튼은 SGR 휠 이벤트를 주입한다: 버튼 64=휠 위, 65=휠 아래, 형식
  // `\x1b[<b;col;rowM`. 좌표는 현재 그리드 중앙 (단일 스크롤 영역이라 정확한 좌표는 중요치
  // 않지만, 화면 밖 좌표를 보내 무시당하지 않도록 중앙으로 고정). 한 번 탭에 3 노치씩 굴려
  // 체감 스크롤폭 확보.
  // (원인 분리) 마우스 모드는 «한글 입력 불가» 의 원인이 아니다 — 휠 보고는 단방향 좌표
  //  보고라 IME/키 입력과 무관하다. 「스크롤이 안 돼서 마우스를 끈다」 는 수정은 휠 스크롤만
  //  깨뜨릴 뿐 한글과 무관하니 금지.
  if (key === "scroll_up" || key === "scroll_down") {
    const cols = Math.max(1, (s.pty as { cols?: number }).cols ?? 80);
    const rows = Math.max(1, (s.pty as { rows?: number }).rows ?? 24);
    const cx = Math.max(1, Math.min(cols, Math.round(cols / 2)));
    const cy = Math.max(1, Math.min(rows, Math.round(rows / 2)));
    const button = key === "scroll_up" ? 64 : 65;
    const wheel = `\x1b[<${button};${cx};${cy}M`;
    try {
      s.pty.write(wheel.repeat(3));
      return true;
    } catch (e) {
      console.warn(`[pty-runner] scroll write failed session=${sessionId} key=${key}`, e);
      return false;
    }
  }
  // ANSI CSI 시퀀스 (xterm) — claude/codex REPL 의 select wizard 가 그대로 해석한다.
  // space / enter 는 시스템 소프트 키보드가 직접 보내므로 가상 버튼이 불필요해 제거됨
  // (2026-05).
  const seq: Record<"up" | "down" | "left" | "right", string> = {
    up: "\x1b[A",
    down: "\x1b[B",
    right: "\x1b[C",
    left: "\x1b[D",
  };
  try {
    s.pty.write(seq[key]);
    return true;
  } catch (e) {
    console.warn(`[pty-runner] key write failed session=${sessionId} key=${key}`, e);
    return false;
  }
}
