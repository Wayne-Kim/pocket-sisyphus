/**
 * 크래시 핸들러 — uncaughtException / unhandledRejection.
 *
 * 배경: daemon 은 지금껏 SIGINT/SIGTERM 만 처리하고(server.ts) 처리되지 않은 예외/거부
 * 핸들러가 없어, 크래시 시 풀스택이 stderr 로 증발하고 종료 후 추적이 불가능했다. 사생활
 * 원칙(LAN 전용 모드가 모든 외부 outbound 차단 — egress.ts)상 Sentry 등 외부 텔레메트리는
 * 쓸 수 없으므로, 「로컬에만 남기는」 크래시 로그가 모든 사후 디버깅의 토대가 된다.
 *
 * 정책 — **crash-only**: 풀스택+컨텍스트(daemon 인스턴스 id·boot ppid·마지막 채널 이벤트)를
 * unified.log 에 fatal 로 기록하고, 별도 crash 마커 파일 1건을 남긴 뒤 «비정상 종료» 한다.
 * 무리한 in-process 복구는 시도하지 않는다 — 부모 워치독(lifecycle.ts)이 이미 orphan 정리를
 * 하므로 재기동은 기존 라이프사이클(Mac 앱 → daemon spawn)에 위임한다.
 *
 * 비밀(webhook URL·토큰·키)은 기록 전에 redact.maskSecrets 로 가린다 — 크래시 로그/진단
 * 번들이 «밖으로 나갈 수 있는» 텍스트라서.
 */

import fs from "node:fs";
import path from "node:path";

import {
  makeLogger,
  getLastChannelEvent,
  INSTANCE_ID,
  LOGS_DIR,
  type LastChannelEvent,
} from "./log.js";
import { maskSecrets, knownConfigSecrets } from "./redact.js";

const log = makeLogger("daemon");

/**
 * 비정상 종료 코드. sysexits.h 의 `EX_SOFTWARE`(70) — 내부 소프트웨어 오류. 0(정상) 과
 * 명확히 구분되는 «비정상» 값이면 충분하고, 부모 워치독/사람이 「깨끗한 종료가 아니었다」 를
 * 한눈에 알 수 있다.
 */
export const CRASH_EXIT_CODE = 70;

/** crash 마커 파일을 모으는 디렉터리 (unified.log 와 같은 logs/ 아래). */
export const CRASH_DIR = path.join(LOGS_DIR, "crashes");

/** 디스크에 쌓아둘 마커 최대 개수 — 그 이상은 오래된 것부터 정리. */
const MAX_CRASH_MARKERS = 20;

export type CrashKind = "uncaughtException" | "unhandledRejection";

/** 크래시 시점의 프로세스/인스턴스 맥락. */
export interface CrashContext {
  /** daemon 인스턴스 id (PID 재활용 면역). */
  instanceId: string;
  /** 부팅 시점의 ppid — 부모(Mac 앱) 식별. reparent 전 기준선. */
  bootPpid: number;
  /** 크래시 시점의 현재 ppid — bootPpid 와 다르면 이미 reparent 된 것. */
  currentPpid: number;
  /** 크래시한 프로세스 PID. */
  pid: number;
  /** 죽기 직전 마지막 채널 이벤트(없으면 null). */
  lastChannelEvent: LastChannelEvent | null;
}

/** 마스킹까지 끝난, 기록·공유 가능한 크래시 리포트. */
export interface CrashReport {
  kind: CrashKind;
  /** 생성 시각 ISO 8601 UTC. */
  at: string;
  error: {
    name: string;
    /** 마스킹된 메시지. */
    message: string;
    /** 마스킹된 풀스택 (스택 없으면 name+message). */
    stack: string;
  };
  context: CrashContext;
}

/** Error 가 아닌 reason(문자열·객체·null 등)을 안전하게 Error 로 정규화. */
function normalizeError(err: unknown): Error {
  if (err instanceof Error) return err;
  if (typeof err === "string") return new Error(err);
  try {
    return new Error(JSON.stringify(err));
  } catch {
    return new Error(String(err));
  }
}

/**
 * 마스킹까지 끝난 CrashReport 를 만든다 (순수 — I/O·exit 없음. 단위 테스트의 핵심 진입점).
 *
 * @param kind    크래시 종류.
 * @param err     던져진 값(Error 든 아니든).
 * @param ctx     프로세스/인스턴스 맥락.
 * @param secrets literal 치환할 «아는» 비밀. 기본 knownConfigSecrets().
 */
export function buildCrashReport(
  kind: CrashKind,
  err: unknown,
  ctx: CrashContext,
  secrets: string[] = knownConfigSecrets(),
): CrashReport {
  const e = normalizeError(err);
  const rawStack = e.stack ?? `${e.name}: ${e.message}`;
  return {
    kind,
    at: new Date().toISOString(),
    error: {
      name: e.name,
      message: maskSecrets(e.message, secrets),
      stack: maskSecrets(rawStack, secrets),
    },
    context: ctx,
  };
}

/** crash 마커 파일 1건을 디스크에 쓰고(0600) 경로를 돌려준다. 오래된 마커는 정리. */
export function writeCrashMarker(report: CrashReport): string {
  fs.mkdirSync(CRASH_DIR, { recursive: true });
  // 파일시스템에 안전한 시각 스탬프 + 인스턴스 id — 정렬·식별 둘 다 된다.
  const stamp = report.at.replace(/[:.]/g, "-");
  const file = path.join(CRASH_DIR, `crash-${stamp}-${report.context.instanceId}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2), { mode: 0o600 });
  pruneOldMarkers();
  return file;
}

/** crash 마커가 MAX 를 넘으면 오래된 것부터(이름 사전순 = 시각순) 삭제. best-effort. */
function pruneOldMarkers(): void {
  try {
    const files = fs
      .readdirSync(CRASH_DIR)
      .filter((f) => f.startsWith("crash-") && f.endsWith(".json"))
      .sort();
    for (const f of files.slice(0, Math.max(0, files.length - MAX_CRASH_MARKERS))) {
      try {
        fs.unlinkSync(path.join(CRASH_DIR, f));
      } catch {
        /* best-effort */
      }
    }
  } catch {
    /* best-effort */
  }
}

/**
 * CrashReport 를 (1) unified.log 에 fatal 로 기록하고 (2) crash 마커 파일을 남긴다.
 * 로깅 destination 은 sync 라 exit 전에 디스크 flush 가 보장된다(log.ts 참고).
 */
export function recordCrash(report: CrashReport): { markerPath: string | null } {
  const ev = report.context.lastChannelEvent;
  log.fatal(`daemon crash (${report.kind})`, {
    "event.action": "daemon.crash",
    "crash.kind": report.kind,
    "error.type": report.error.name,
    "error.message": report.error.message,
    "error.stack": report.error.stack,
    "service.instance.id": report.context.instanceId,
    "lifecycle.boot_ppid": report.context.bootPpid,
    "process.parent.pid": report.context.currentPpid,
    "process.pid": report.context.pid,
    // 마지막 채널 이벤트 — 죽기 직전 무슨 일을 하고 있었나의 단서(채널/레벨/action/시각).
    "crash.last_event.channel": ev?.channel,
    "crash.last_event.level": ev?.level,
    "crash.last_event.action": ev?.action,
    "crash.last_event.at": ev?.at,
  });
  let markerPath: string | null = null;
  try {
    markerPath = writeCrashMarker(report);
    log.fatal("crash marker written", {
      "event.action": "daemon.crash.marker",
      "file.path": markerPath,
    });
  } catch (e) {
    // 마커 쓰기 실패해도 fatal 로그는 이미 남았다 — 알리기만 하고 계속 진행(exit 까지).
    log.error("crash marker write failed", {
      "event.action": "daemon.crash.marker.fail",
      "error.message": e instanceof Error ? e.message : String(e),
    });
  }
  return { markerPath };
}

/** makeCrashHandler 가 받는 의존성(테스트에서 주입). */
interface CrashHandlerDeps {
  /** 비정상 종료. 기본 process.exit. */
  exit: (code: number) => void;
  /** CrashReport 기록기. 기본 recordCrash (fatal 로그 + 마커). */
  record?: (report: CrashReport) => void;
  /** 맥락 수집기. 기본 현재 프로세스/인스턴스/마지막 이벤트. */
  context?: () => CrashContext;
  /** literal 치환 비밀. 기본 knownConfigSecrets(). */
  secrets?: () => string[];
}

/**
 * 크래시 핸들러 함수를 만든다 (테스트 가능 — exit·record·context 를 주입).
 *
 * 핸들러는: 리포트 빌드(마스킹 포함) → record → exit(CRASH_EXIT_CODE). 어떤 단계가 던져도
 * 최후 안전망(stderr)으로 잡고 «반드시» 비정상 종료한다 — 크래시 처리 중의 크래시로
 * daemon 이 종료 못 하고 매달리는 일이 없게.
 */
export function makeCrashHandler(deps: CrashHandlerDeps): (kind: CrashKind, err: unknown) => void {
  const record = deps.record ?? recordCrash;
  const getContext = deps.context ?? defaultContext;
  const getSecrets = deps.secrets ?? knownConfigSecrets;
  return (kind, err) => {
    try {
      const report = buildCrashReport(kind, err, getContext(), getSecrets());
      record(report);
    } catch (inner) {
      // 로깅 자체가 실패 — stderr 로라도 흔적을 남기고 그래도 비정상 종료한다.
      try {
        console.error("[crash] handler failure", inner, "original:", err);
      } catch {
        /* 최후의 noop */
      }
    } finally {
      deps.exit(CRASH_EXIT_CODE);
    }
  };
}

/** 부팅 시점 ppid — installCrashHandlers 호출 시 한 번 고정해 둔다(reparent 전 기준선). */
let bootPpidAtInstall = process.ppid;

function defaultContext(): CrashContext {
  return {
    instanceId: INSTANCE_ID,
    bootPpid: bootPpidAtInstall,
    currentPpid: process.ppid,
    pid: process.pid,
    lastChannelEvent: getLastChannelEvent(),
  };
}

/**
 * 엔트리포인트 최상단에서 1회 호출. uncaughtException·unhandledRejection 을 잡아
 * crash-only 로 처리하도록 등록한다. 부팅 ppid 를 이 시점에 고정한다.
 *
 * @param overrides 테스트용 exit 등의 의존성 주입(평소 운영 경로에선 비움).
 */
export function installCrashHandlers(overrides?: Partial<CrashHandlerDeps>): void {
  bootPpidAtInstall = process.ppid;
  const handler = makeCrashHandler({
    exit: overrides?.exit ?? ((code) => process.exit(code)),
    record: overrides?.record,
    context: overrides?.context,
    secrets: overrides?.secrets,
  });
  process.on("uncaughtException", (err) => handler("uncaughtException", err));
  process.on("unhandledRejection", (reason) => handler("unhandledRejection", reason));
}
