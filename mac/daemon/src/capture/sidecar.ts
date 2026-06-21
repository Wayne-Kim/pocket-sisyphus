/**
 * 네이티브 화면 캡처 + 원격 입력 주입 — 번들 Swift 헬퍼(capture-helper) 슈퍼바이저.
 *
 * tor/sshd 처럼 daemon 이 자식으로 spawn 한다. 헬퍼가 macOS 의 CGDisplay 캡처 + CGEvent 주입을
 * 담당하고(권한: 화면 기록 + 손쉬운 사용 TCC), daemon 은 데이터 평면 허브:
 *   - 헬퍼 stdout 의 길이-prefix JPEG 프레임을 파싱 → `broadcastScreenFrameToSession` 로 WS 푸시.
 *   - iOS 의 `input_event` 를 헬퍼 stdin 으로 줄 단위 JSON 명령으로 전달.
 *
 * ## 단일 활성 캡처 (한 번에 하나)
 * 폰 UX 상 한 화면만 본다 — 활성 세션 하나. 다른 세션이 capture_start 하면 그 세션으로 교체.
 * 캡처는 «보는 중» 일 때만 — 마지막 시청자가 떠나면 헬퍼를 내려 배터리/프라이버시 보호.
 *
 * ## 보안 게이트 (원격 제어)
 * 캡처(보기)는 화면 기록 권한만 있으면 동작하지만, 입력 주입(조작)은 **세션별로 명시적으로
 * «제어 허용» 을 켠 경우에만** 헬퍼로 전달한다 — 폰이 Mac 데스크톱을 조작하는, 추가할 수 있는
 * 가장 강력한 능력이라 블랭킷 금지. (setControlEnabled 로 토글.)
 */

import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  broadcastScreenFrameToSession,
  broadcastBinaryToSession,
  broadcastToSession,
  hasActiveSubscriber,
  sessionMaxBufferedAmount,
} from "../ws/hub.js";
import { makeLogger } from "../logging/log.js";

const log = makeLogger("capture");

/** 번들 헬퍼 경로 — Mac 앱이 POCKET_CLAUDE_CAPTURE_BIN 으로 주입. dev fallback 은 컴파일 산출물. */
const CAPTURE_BIN =
  process.env.POCKET_CLAUDE_CAPTURE_BIN ??
  fileURLToPath(new URL("../../bin/capture-helper", import.meta.url));

export type CaptureCodec = "jpeg" | "h264";

let proc: ChildProcess | null = null;
let activeSessionId: string | null = null;
/** 현재 헬퍼가 인코딩 중인 코덱 — drainFrames 파싱 분기 + 코덱 변경 시 재시작 판단. */
let activeCodec: CaptureCodec = "jpeg";
let intentionalStop = false;
/** 헬퍼가 보고한 활성 디스플레이 목록(멀티모니터 선택용). 헬퍼 재spawn 마다 갱신. */
let latestDisplays: unknown[] = [];
/** 헬퍼가 보고한 화면에 보이는 창 목록(캡처 대상 피커용). 헬퍼 재spawn 마다 갱신. */
let latestWindows: unknown[] = [];
/** 헬퍼가 보고한 현재 캡처 대상 창(CGWindowID, 0=전체 화면). capture_start 시 즉시 동기화용. */
let latestWindowTarget = 0;
/** 명시적으로 원격 제어가 허용된 세션 — 입력 주입 게이트. */
const controlEnabled = new Set<string>();

// ── TCC 권한 상태 (헬퍼가 매 spawn 시 __PS_SCREENPERM__/__PS_AXPERM__ 로 라이브 보고) ──────
// 헬퍼는 매번 «새 프로세스» 라 라이브 TCC 를 읽고(책임 프로세스=Mac 앱), 앱의 CGPreflight 캐시보다
// 신뢰할 수 있다. 캡처가 «조용히 검은 화면» 으로 실패하지 않도록 이 신호를 iOS 에 상태로 중계한다.
//   - screen 미부여 → capture_status running:false reason:"screen_permission" (보기 자체가 막힘)
//   - accessibility 미부여 + 제어 활성 → control_status enabled:false reason:"accessibility_permission"
//     (보기는 되고 조작만 막힘 — 분리 안내)
// null = 아직 보고 전(헬퍼 spawn 직후). false 일 때만 «미부여» 로 단정해 거짓 경보를 막는다.
let screenPermGranted: boolean | null = null;
let axPermGranted: boolean | null = null;

/** 활성 세션에 제어가 켜져 있고 AX 가 미부여로 «확정» 이면 control_status(blocked)를 브로드캐스트.
 *  AX 보고 도착(헬퍼 spawn 후)·제어 켜기(control_set) 양쪽 타이밍에서 호출돼 순서 무관하게 안내된다. */
function maybeReportControlPermission(sessionId: string): void {
  if (!controlEnabled.has(sessionId)) return;
  if (axPermGranted === false) {
    broadcastToSession(sessionId, {
      type: "control_status",
      sessionId,
      enabled: false,
      reason: "accessibility_permission",
    });
  } else if (axPermGranted === true) {
    // 부여됨 — 이전에 띄운 «조작 막힘» 안내를 내린다.
    broadcastToSession(sessionId, { type: "control_status", sessionId, enabled: true });
  }
}

// ── 동적 적응(C): WS backpressure 기반 fps/bitrate 자동 조절 ────────────────────
// SSH 채널이 못 빼면 bufferedAmount 가 커진다 → fps/bitrate 를 내려 채널을 안 막고(크래시 방지)
// 지연을 억제. 여유가 생기면 천장(iOS 가 보낸 티어)까지 다시 올린다. 해상도는 안 건드린다(바꾸면
// 스트림 재시작 = 키프레임/jank). H.264 레퍼런스 체인을 안 깨려 와이어 드롭 대신 «소스 레이트» 조절.
const ADAPT_INTERVAL_MS = 250; // 1초 폴링은 혼잡을 1초 늦게 보고 1초 과잉 backoff 함 — 4Hz 로 즉응.
const ADAPT_BUF_HIGH = 256 * 1024; // 이 이상 쌓이면 backoff
const ADAPT_BUF_LOW = 64 * 1024; //  이 미만이면 ramp up
const ADAPT_FLOOR_FPS = 5;
/** 혼잡이 이 틱 수만큼 «연속» 일 때만 backoff — 키프레임 버스트 같은 일시 스파이크(1틱=250ms)에
 *  과민반응해 화질이 톱니로 출렁이는 걸 막는다. */
const ADAPT_HIGH_STREAK = 2;
/** backoff 간 최소 간격 — 한 번 내렸으면 채널이 빠질 시간을 주고 재평가(연쇄 급강하 방지). */
const ADAPT_BACKOFF_COOLDOWN_MS = 1000;
let adaptTimer: ReturnType<typeof setInterval> | null = null;
let adaptFps = 0;
let adaptBitrate = 0;
let adaptCeilFps = 0;
let adaptCeilBitrate = 0;
let adaptFloorBitrate = 0;
let adaptHighStreak = 0;
let adaptLastBackoffAt = 0;
let adaptLastLogAt = 0;

function startAdaptation(ceilFps: number, ceilBitrate: number, startFps: number, startBitrate: number): void {
  stopAdaptation();
  adaptCeilFps = ceilFps;
  adaptCeilBitrate = ceilBitrate;
  adaptFloorBitrate = Math.max(600_000, Math.round(ceilBitrate * 0.25));
  adaptFps = startFps;
  adaptBitrate = startBitrate;
  adaptHighStreak = 0;
  adaptLastBackoffAt = 0;
  adaptTimer = setInterval(adaptTick, ADAPT_INTERVAL_MS);
}

function stopAdaptation(): void {
  if (adaptTimer) {
    clearInterval(adaptTimer);
    adaptTimer = null;
  }
}

function adaptTick(): void {
  const sid = activeSessionId;
  if (!proc || activeCodec !== "h264" || !sid) return;
  const buffered = sessionMaxBufferedAmount(sid);
  const now = Date.now();
  let nf = adaptFps;
  let nb = adaptBitrate;
  let backedOff = false;
  if (buffered > ADAPT_BUF_HIGH) {
    adaptHighStreak += 1;
    // «지속» 혼잡일 때만 backoff — 연속 2틱(500ms) + 직전 backoff 후 쿨다운 경과.
    // fps 는 부드러움의 핵심이라 비트레이트보다 천천히 깎는다(×0.75 vs ×0.7).
    if (adaptHighStreak >= ADAPT_HIGH_STREAK && now - adaptLastBackoffAt >= ADAPT_BACKOFF_COOLDOWN_MS) {
      nf = Math.max(ADAPT_FLOOR_FPS, Math.round(adaptFps * 0.75));
      nb = Math.max(adaptFloorBitrate, Math.round(adaptBitrate * 0.7));
      adaptLastBackoffAt = now;
      backedOff = true;
    }
  } else {
    adaptHighStreak = 0;
    if (buffered < ADAPT_BUF_LOW) {
      // 여유 — 틱당 +1fps/+150kbps = 초당 +4fps/+600kbps 로 천장까지 회복.
      nf = Math.min(adaptCeilFps, adaptFps + 1);
      nb = Math.min(adaptCeilBitrate, adaptBitrate + 150_000);
    }
  }
  if (nf !== adaptFps || nb !== adaptBitrate) {
    adaptFps = nf;
    adaptBitrate = nb;
    try {
      proc.stdin?.write(JSON.stringify({ cmd: "config", fps: adaptFps, bitrate: adaptBitrate }) + "\n");
    } catch {
      /* stdin 닫힘 — 무해 */
    }
    // 4Hz 틱이라 ramp-up 변경 로그는 1초로 묶고, backoff 는 항상 남긴다(혼잡 진단 신호).
    if (backedOff || now - adaptLastLogAt >= 1000) {
      adaptLastLogAt = now;
      log.info("capture adapt", {
        "event.action": "capture.adapt",
        buffered,
        fps: adaptFps,
        bitrate: adaptBitrate,
        backoff: backedOff,
      });
    }
  }
}

// stdout 프레임 파서 상태: [4바이트 BE 길이][JPEG] 반복.
let stdoutBuf: Buffer = Buffer.alloc(0);

/** 헬퍼가 떠 있나. */
export function isCaptureRunning(): boolean {
  return proc !== null;
}

/** 현재 캡처 중인 세션 (없으면 null). */
export function activeCaptureSession(): string | null {
  return activeSessionId;
}

/**
 * 세션의 화면 캡처를 시작한다. 헬퍼가 없으면 spawn, 있으면 활성 세션만 교체.
 * 반환 ok=false 면 reason (spawn_failed 등).
 */
export function startCaptureForSession(
  sessionId: string,
  codec: CaptureCodec = "jpeg",
  fps?: number,
  bitrate?: number,
  maxDim?: number,
  audio?: boolean,
): { ok: true } | { ok: false; reason: string } {
  // 코덱이 바뀌면(예: jpeg→h264) 헬퍼를 내리고 새 코덱으로 재시작.
  if (proc && activeCodec !== codec) stopHelper();
  activeSessionId = sessionId;
  if (proc) {
    // 같은 코덱 헬퍼 재사용(품질 티어는 spawn 시 고정). 오디오 토글만 라이브 전달 —
    // 헬퍼가 현재 스트림과 다르면 스스로 재구성한다.
    if (audio !== undefined) {
      try {
        proc.stdin?.write(JSON.stringify({ cmd: "config", audio }) + "\n");
      } catch {
        /* stdin 닫힘 — 무해 */
      }
    }
    return { ok: true };
  }
  try {
    spawnHelper(codec, fps, bitrate, maxDim, audio);
    return { ok: true };
  } catch (e) {
    log.error("capture helper spawn failed", {
      "event.action": "capture.spawn.fail",
      "error.message": (e as Error).message,
    });
    return { ok: false, reason: "spawn_failed" };
  }
}

/** 세션 캡처 중단 — 그 세션이 활성일 때만 헬퍼를 내린다. */
export function stopCaptureForSession(sessionId: string): void {
  if (activeSessionId !== sessionId) return;
  stopHelper();
}

/** 헬퍼가 마지막으로 보고한 디스플레이 목록. capture_start 시 즉시 iOS 에 실어 보내는 데 쓴다. */
export function currentDisplays(): unknown[] {
  return latestDisplays;
}

/** 헬퍼가 마지막으로 보고한 창 목록(캡처 대상 피커). capture_start 시 즉시 iOS 에 실어 보낸다. */
export function currentWindows(): unknown[] {
  return latestWindows;
}

/** 헬퍼가 보고한 현재 캡처 대상 창 id (0=전체 화면). capture_start 시 iOS 선택 상태 동기화용. */
export function currentWindowTarget(): number {
  return latestWindowTarget;
}

/** 캡처/입력 대상 디스플레이 선택(멀티모니터). 활성 세션일 때만 헬퍼 config 로 전달. */
export function setDisplayForSession(sessionId: string, index: number): void {
  if (!proc || activeSessionId !== sessionId) return;
  try {
    proc.stdin?.write(JSON.stringify({ cmd: "config", display: index }) + "\n");
  } catch {
    /* stdin 닫힘 — 무해 */
  }
}

/** 캡처 대상 창 선택(screen_window_target_v1) — windowId<=0 이면 해제(전체 화면 복귀).
 *  헬퍼가 적용 후 __PS_TARGET__ 으로 결과를 보고해 iOS 선택 상태가 동기화된다. */
export function setWindowForSession(sessionId: string, windowId: number): void {
  if (!proc || activeSessionId !== sessionId) return;
  try {
    proc.stdin?.write(JSON.stringify({ cmd: "config", window: Math.max(0, Math.floor(windowId)) }) + "\n");
  } catch {
    /* stdin 닫힘 — 무해 */
  }
}

/** 창 목록 재보고 요청 — iOS 더보기 메뉴가 열릴 때 최신 목록으로 갱신. */
export function requestWindowList(sessionId: string): void {
  if (!proc || activeSessionId !== sessionId) return;
  try {
    proc.stdin?.write(JSON.stringify({ cmd: "targets" }) + "\n");
  } catch {
    /* stdin 닫힘 — 무해 */
  }
}

/** 줌 관심영역(ROI, 하이브리드 D) — iOS 가 줌 정착 시 보는 영역(정규화 rect)을 보내면 헬퍼가
 *  그 영역만 native 해상도로 인코딩. roi=null 이면 전체로 리셋. h264 활성 세션일 때만 의미. */
export function setROIForSession(
  sessionId: string,
  roi: { x: number; y: number; w: number; h: number } | null,
): void {
  if (!proc || activeSessionId !== sessionId) return;
  const cmd = roi ? { cmd: "roi", x: roi.x, y: roi.y, w: roi.w, h: roi.h } : { cmd: "roi", w: 0 };
  try {
    proc.stdin?.write(JSON.stringify(cmd) + "\n");
  } catch {
    /* stdin 닫힘 — 무해 */
  }
}

/** 원격 제어 허용 토글 (입력 주입 게이트). disable 시 즉시 제어 차단. */
export function setControlEnabled(sessionId: string, enabled: boolean): void {
  if (enabled) controlEnabled.add(sessionId);
  else controlEnabled.delete(sessionId);
  log.info("remote control gate", {
    "event.action": "capture.control.gate",
    "session.id": sessionId,
    enabled,
  });
  // 제어를 켰는데 손쉬운 사용 권한이 (헬퍼 보고 기준) 미부여면 즉시 «조작 막힘» 안내.
  // (헬퍼가 아직 AX 를 보고하기 전이면 axPermGranted=null → 안내 보류, 보고 도착 시 그쪽에서 처리.)
  if (enabled) maybeReportControlPermission(sessionId);
}

/**
 * iOS input_event 를 헬퍼 stdin 으로 전달 — 활성 세션 + 제어 허용된 경우에만.
 * event 는 헬퍼 stdin 프로토콜의 명령 객체(cmd + 인자). 반환: 실제 전달 여부.
 */
export function relayInput(sessionId: string, event: Record<string, unknown>): boolean {
  if (!proc || activeSessionId !== sessionId) return false;
  if (!controlEnabled.has(sessionId)) return false; // 보안 게이트
  try {
    proc.stdin?.write(JSON.stringify(event) + "\n");
    return true;
  } catch {
    return false;
  }
}

/**
 * 클라이언트가 떠났을 때 호출(WS close) — 활성 캡처 세션에 보는 사람이 더 없으면 헬퍼를 내린다.
 * 배터리/프라이버시: 아무도 안 보는데 화면 캡처가 계속 돌지 않게.
 */
export function captureOnClientGone(): void {
  if (!proc || !activeSessionId) return;
  if (!hasActiveSubscriber(activeSessionId)) {
    log.info("no viewers left — stopping capture", {
      "event.action": "capture.idle.stop",
      "session.id": activeSessionId,
    });
    stopHelper();
  }
}

/** daemon 종료 시 정리. */
export function stopCapture(): void {
  stopHelper();
}

// ── 내부 ────────────────────────────────────────────────────────────────────

function spawnHelper(codec: CaptureCodec, fps?: number, bitrate?: number, maxDim?: number, audio?: boolean): void {
  intentionalStop = false;
  stdoutBuf = Buffer.alloc(0);
  activeCodec = codec;
  latestWindows = []; // 새 헬퍼가 곧 __PS_WINDOWS__ 로 갱신.
  latestWindowTarget = 0; // 새 헬퍼는 항상 전체 화면으로 시작.
  screenPermGranted = null; // 새 헬퍼가 곧 __PS_SCREENPERM__ 로 라이브 보고.
  axPermGranted = null; //     "       __PS_AXPERM__       "
  const child = spawn(CAPTURE_BIN, [], { stdio: ["pipe", "pipe", "pipe"] });
  proc = child;

  child.stdout?.on("data", (chunk: Buffer) => {
    stdoutBuf = stdoutBuf.length === 0 ? chunk : Buffer.concat([stdoutBuf, chunk]);
    drainFrames();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n")) {
      const s = line.trimEnd();
      if (!s) continue;
      // 디스플레이 목록 태그 라인 — 캐시 + 활성 세션 구독자에게 capture_displays 로 전달.
      const m = /^__PS_DISPLAYS__ (.+)$/.exec(s);
      if (m) {
        try {
          latestDisplays = JSON.parse(m[1]) as unknown[];
        } catch {
          latestDisplays = [];
        }
        if (activeSessionId) {
          broadcastToSession(activeSessionId, {
            type: "capture_displays",
            sessionId: activeSessionId,
            displays: latestDisplays,
          });
        }
        continue;
      }
      // 창 목록 태그 라인 — 캐시 + 활성 세션 구독자에게 capture_windows 로 전달(캡처 대상 피커).
      const mw = /^__PS_WINDOWS__ (.+)$/.exec(s);
      if (mw) {
        try {
          latestWindows = JSON.parse(mw[1]) as unknown[];
        } catch {
          latestWindows = [];
        }
        if (activeSessionId) {
          broadcastToSession(activeSessionId, {
            type: "capture_windows",
            sessionId: activeSessionId,
            windows: latestWindows,
          });
        }
        continue;
      }
      // 캡처 대상 태그 — 헬퍼가 창 타겟 적용/폴백을 보고. iOS 가 선택 상태를 동기화하고,
      // reason=window_closed 면 «창이 닫혀 전체 화면으로 돌아왔어요» 캡슐을 띄운다.
      const mt = /^__PS_TARGET__ (.+)$/.exec(s);
      if (mt) {
        let window = 0;
        let reason: string | undefined;
        try {
          const t = JSON.parse(mt[1]) as { window?: number; reason?: string };
          window = typeof t.window === "number" ? t.window : 0;
          reason = typeof t.reason === "string" ? t.reason : undefined;
        } catch {
          /* malformed — 전체 화면으로 간주 */
        }
        latestWindowTarget = window;
        if (activeSessionId) {
          broadcastToSession(activeSessionId, {
            type: "capture_target",
            sessionId: activeSessionId,
            window,
            ...(reason ? { reason } : {}),
          });
        }
        continue;
      }
      // 잠금 상태 태그 — 헬퍼가 화면 잠금/해제를 보고. iOS 에 capture_status(reason)로 전달해
      // 미러가 무한 «화면 수신 대기 중…» 대신 «Mac이 잠겨 있어요» 를 명확히 띄우도록.
      const ml = /^__PS_CAPTURE_STATUS__ (.+)$/.exec(s);
      if (ml) {
        let locked = false;
        try {
          locked = (JSON.parse(ml[1]) as { locked?: boolean }).locked === true;
        } catch {
          /* malformed — 무시 */
        }
        if (activeSessionId) {
          broadcastToSession(activeSessionId, {
            type: "capture_status",
            sessionId: activeSessionId,
            running: true,
            // 잠금이면 reason 부여, 해제면 reason 생략 → iOS 가 statusReason 을 nil 로 클리어.
            ...(locked ? { reason: "screen_locked" } : {}),
          });
        }
        continue;
      }
      // 화면 기록 권한 상태 — 헬퍼가 spawn 직후 CGPreflightScreenCaptureAccess 를 라이브로 읽어 보고.
      // 미부여면 캡처가 검은/빈 프레임으로 «조용히» 실패하므로, iOS 에 capture_status(권한 사유)로
      // 능동 보고해 검은 화면 대신 «화면 기록 권한을 켜세요» 안내를 띄우게 한다(조용한 실패 방지).
      const msp = /^__PS_SCREENPERM__ ([01])$/.exec(s);
      if (msp) {
        screenPermGranted = msp[1] === "1";
        if (activeSessionId) {
          broadcastToSession(activeSessionId, {
            type: "capture_status",
            sessionId: activeSessionId,
            running: screenPermGranted,
            // 미부여면 reason 부여(권한 안내), 부여면 reason 생략 → iOS 가 statusReason 클리어.
            ...(screenPermGranted ? {} : { reason: "screen_permission" }),
          });
        }
        continue;
      }
      // 손쉬운 사용(원격 제어) 권한 상태 — 캐시 후 «제어 활성 + 미부여» 면 control_status 로 분리 안내.
      const map = /^__PS_AXPERM__ ([01])$/.exec(s);
      if (map) {
        axPermGranted = map[1] === "1";
        if (activeSessionId) maybeReportControlPermission(activeSessionId);
        continue;
      }
      log.info(s, { "event.action": "capture.helper.log" });
    }
  });
  child.on("exit", (code, signal) => {
    const wasIntentional = intentionalStop;
    if (proc === child) proc = null;
    stdoutBuf = Buffer.alloc(0);
    if (!wasIntentional) {
      log.warn("capture helper exited unexpectedly", {
        "event.action": "capture.exit",
        "process.exit_code": code,
        signal,
      });
      // 자동 재시작하지 않는다 — 캡처는 on-demand. iOS 가 다시 capture_start 하면 respawn.
      activeSessionId = null;
    }
  });

  // 초기 설정 — 코덱별. maxDim(긴 변)은 단순 화질이 아니라 **안정성**: 원본(5K)을 그대로 흘리면
  // SSH directTCPIP 채널(swift-nio-ssh 0.3.x) 윈도우가 폭주해 iOS 가 죽는다.
  //   - h264: 델타 인코딩 + 동적 적응(C). iOS 티어를 «천장» 으로 삼아 slow-start(70%) 로 시작해
  //     채널 여유에 맞춰 ramp up, 혼잡하면 backoff(크래시 방지). maxDim 은 고정(바꾸면 재시작).
  //   - jpeg: 프레임마다 풀 이미지라 대역폭이 fps 에 비례 → 저fps 유지(폴백/옛 iOS).
  if (codec === "h264") {
    const ceilFps = fps ?? 15;
    const ceilBitrate = bitrate ?? 5_000_000;
    // slow-start: 천장보다 낮게 시작해 첫 버스트로 약한 채널을 막지 않는다(TCP slow-start 처럼).
    // 적응 루프가 4Hz 로 빨라져 혼잡 시 즉시 내릴 수 있으므로 시작점은 85%/70% 로 공격적으로 —
    // 직결에서 30fps 천장까지 1초 내 도달이 목표(낮게 시작하면 첫 몇 초가 «느린 화면» 으로 보인다).
    const startFps = Math.max(ADAPT_FLOOR_FPS, Math.round(ceilFps * 0.85));
    const startBitrate = Math.round(ceilBitrate * 0.7);
    const cfg = {
      cmd: "config",
      codec: "h264",
      fps: startFps,
      maxDim: maxDim ?? 1440,
      bitrate: startBitrate,
      audio: audio ?? false,
    };
    try {
      child.stdin?.write(JSON.stringify(cfg) + "\n");
    } catch {
      /* stdin 아직 준비 안 됨 — 무해 */
    }
    startAdaptation(ceilFps, ceilBitrate, startFps, startBitrate);
  } else {
    try {
      child.stdin?.write(
        JSON.stringify({ cmd: "config", codec: "jpeg", fps: 2, quality: 0.6, maxDim: 1280 }) + "\n",
      );
    } catch {
      /* stdin 아직 준비 안 됨 — 무해 */
    }
  }
  log.info("capture helper spawned", {
    "event.action": "capture.spawn.ok",
    bin: CAPTURE_BIN,
    codec,
  });
}

function stopHelper(): void {
  intentionalStop = true;
  activeSessionId = null;
  stopAdaptation();
  const c = proc;
  proc = null;
  if (!c) return;
  try {
    c.stdin?.end();
  } catch {
    /* ignore */
  }
  c.kill("SIGTERM");
  setTimeout(() => {
    try {
      c.kill("SIGKILL");
    } catch {
      /* 이미 죽음 */
    }
  }, 1500);
}

/** stdout 누적 버퍼에서 완성된 프레임을 꺼내 broadcast. 코덱별로 분기:
 *  - jpeg: payload=JPEG → base64 JSON screen_frame.
 *  - h264: payload=[1B type][...] → 그대로 바이너리 WS (iOS 가 .data 로 디코드). */
function drainFrames(): void {
  while (stdoutBuf.length >= 4) {
    const len = stdoutBuf.readUInt32BE(0);
    if (len <= 0 || len > 64 * 1024 * 1024) {
      // 프로토콜 깨짐 — 버퍼 폐기(안전).
      stdoutBuf = Buffer.alloc(0);
      return;
    }
    if (stdoutBuf.length < 4 + len) return; // 프레임 아직 미완성
    const payload = stdoutBuf.subarray(4, 4 + len);
    stdoutBuf = stdoutBuf.subarray(4 + len);
    const sid = activeSessionId;
    if (!sid) continue;
    if (activeCodec === "h264") {
      broadcastBinaryToSession(sid, Buffer.from(payload));
    } else {
      broadcastScreenFrameToSession(sid, Buffer.from(payload), Date.now());
    }
  }
}
