/**
 * 통합 로깅 — daemon, sshd, Tor, Mac 앱이 같은 unified.log 한 파일에 JSON Lines
 * 로 기록한다. 포맷은 ECS (Elastic Common Schema) 필드 명명을 따른다 — Pino /
 * Bunyan / Elastic 생태계 어디든 추가 작업 없이 ingest 된다.
 *
 * 한 줄 = 하나의 JSON 객체. 한 줄 ≤ 4 KiB 보장 (POSIX O_APPEND 의 atomic write
 * 경계). Mac 앱(Swift) 도 같은 파일에 동시 append — 두 writer.
 *
 * 호출 진입점 두 가지:
 *   1) 모듈 단위 child: `const log = makeLogger("tor"); log.info("hidden service ready", {...})`
 *   2) 옛 console.* 캡처: bridgeConsoleToUnifiedLog() — 마이그레이션 안 된
 *      console.log/error/warn 을 stdout-tee 로 흡수해 누락 0 보장.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import pino from "pino";

import { CONFIG_DIR } from "../config.js";
import { DAEMON_VERSION } from "../version.js";

export const LOGS_DIR = path.join(CONFIG_DIR, "logs");
export const UNIFIED_LOG_FILE = path.join(LOGS_DIR, "unified.log");

/** 매 daemon spawn 마다 새 6자 — PID 재활용 위험 없는 인스턴스 식별자. */
const INSTANCE_ID = crypto.randomBytes(3).toString("hex");

/** 한 줄 atomic-append 보장 한도. 초과하면 message 끝을 잘라 들어가게 한다. */
const MAX_LINE_BYTES = 4096;

/** 채널 ID — 컴파일타임 enum 으로 강제해 오타로 인한 채널 분기 사일런트 실패 방지. */
export type LogChannel =
  | "daemon"
  | "tor"
  | "sshd"
  | "nat"
  | "local-llm"
  | "lifecycle"
  | "api"
  | "agent"
  | "ws"
  | "auth"
  | "preview"
  | "capture"
  | "stdout-fallback";

fs.mkdirSync(LOGS_DIR, { recursive: true });

/**
 * ECS 필드 매핑.
 *   - `@timestamp` ISO 8601 UTC ms — Elastic / Kibana 가 인식하는 키
 *   - `log.level` 표준 6단계 (Pino 의 number level 을 텍스트로 변환)
 *   - `log.logger` 우리 채널명
 *   - `process.name` `process.pid` — 두 writer 환경에서 어느 프로세스 산인지 식별
 *   - `service.version` `service.instance.id` — 재시작 전후 라인 구분
 *
 * messageKey 를 "message" 로 잡아 Pino 의 기본 `msg` 대신 ECS 표준 키로 출력.
 *
 * timestamp 는 ISO 문자열로 — epoch ms 보다 사람 친화 + 파일을 직접 grep 할 때
 * 시각 한눈 확인. 성능 손해는 데스크탑 부하 수준 한참 아래.
 */
const baseLogger = pino(
  {
    level: process.env.POCKET_SISYPHUS_LOG_LEVEL ?? "debug",
    base: {
      "process.name": "daemon",
      "process.pid": process.pid,
      "service.version": DAEMON_VERSION,
      "service.instance.id": INSTANCE_ID,
    },
    messageKey: "message",
    timestamp: () => `,"@timestamp":"${new Date().toISOString()}"`,
    formatters: {
      // Pino 기본은 `level: 30` 같은 숫자. ECS / 사람-가독성 위해 텍스트로.
      level(label) {
        return { "log.level": label };
      },
      // bindings 의 키를 그대로 흘려보낸다 (base 와 child 의 bindings 합쳐짐).
      bindings(b) {
        return b;
      },
      log(obj) {
        return enforceLineSize(obj);
      },
    },
  },
  pino.destination({
    dest: UNIFIED_LOG_FILE,
    append: true,
    // sync write — 데스크탑 부하 (< 1000 라인/초) 에선 비용 안 보이지만 daemon 이 부팅 중
    // crash 시 (예: EADDRINUSE, fatal throw) 마지막 라인까지 디스크에 남아야 사후 분석 가능.
    // async 였을 때 EADDRINUSE 한 줄을 통째로 잃는 회귀가 실측됨 (2026-05).
    sync: true,
    mkdir: true,
  }),
);

/**
 * 한 줄 4 KiB 초과 방어. message 가 가장 흔한 비대 원인이라 거기서 잘라낸다.
 * 다른 필드는 일단 그대로 두되, 전체 직렬화 길이가 한계를 넘으면 fields 도 같이
 * 트림한다 (현재는 message 한정 — 더 공격적 정책 필요해지면 여기서 확장).
 */
function enforceLineSize(obj: Record<string, unknown>): Record<string, unknown> {
  const msg = obj.message;
  if (typeof msg === "string" && Buffer.byteLength(msg) > 1024) {
    obj.message = msg.slice(0, 1024) + "...[truncated]";
  }
  // 직렬화 후 길이 점검 — 안전망. 초과면 fields 영역을 모두 잘라 마커만 남긴다.
  const serialized = JSON.stringify(obj);
  if (serialized.length > MAX_LINE_BYTES) {
    return {
      "@timestamp": obj["@timestamp"],
      "log.level": obj["log.level"],
      "log.logger": obj["log.logger"],
      "process.name": obj["process.name"],
      "process.pid": obj["process.pid"],
      message:
        typeof msg === "string" ? msg.slice(0, 512) : "[truncated: oversized]",
      truncated: true,
    };
  }
  return obj;
}

export interface Logger {
  trace(message: string, fields?: Record<string, unknown>): void;
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  fatal(message: string, fields?: Record<string, unknown>): void;
}

/**
 * 채널 단위 logger. 호출 사이트는 `log.info("foo", {key: val})` 만 쓰면 된다.
 * Pino child 로 `log.logger` 가 사전 바인딩되어 매 호출마다 채널명 반복 없음.
 *
 * fields 의 키는 dot-notation 권장 (ECS 컨벤션):
 *   network.interface, error.message, onion.address, event.action 등.
 * 중첩 객체 대신 평면 키 — jq / grep 친화.
 *
 * 민감정보 정책: 키 prefix `secret.*` 는 진단 패키지 추출 시 자동 redact 대상.
 * 토큰, 풀 onion 주소 등은 절대 `message` 본문에 박지 말고 `secret.<name>` 필드로.
 */
export function makeLogger(channel: LogChannel): Logger {
  const child = baseLogger.child({ "log.logger": channel });
  return {
    trace: (m, f) => child.trace(f ?? {}, m),
    debug: (m, f) => child.debug(f ?? {}, m),
    info: (m, f) => child.info(f ?? {}, m),
    warn: (m, f) => child.warn(f ?? {}, m),
    error: (m, f) => child.error(f ?? {}, m),
    fatal: (m, f) => child.fatal(f ?? {}, m),
  };
}

/**
 * 마이그레이션 동안 옛 `console.log/warn/error` 호출을 unified.log 로 흡수한다.
 * 호출 사이트를 한 번에 다 바꾸기엔 139개 (2026-05) 라 risk 큼 — 점진 이전 중에도
 * 로그 누락 0 보장.
 *
 * 흡수 규칙: 첫 인자가 string 이고 `[채널]` prefix 를 달고 있으면 그 채널로 emit,
 * 아니면 `stdout-fallback` 채널로. level 은 console.error → error, warn → warn,
 * 나머지 → info.
 */
export function bridgeConsoleToUnifiedLog(): void {
  const channelCache = new Map<string, Logger>();
  // baseLogger 의 child 를 직접 만들어 동적 채널 이름 (LogChannel 타입 우회) 지원.
  // 정적 호출자는 makeLogger() 로 타입 안전, bridge 는 stdout 에 박힌 임의 prefix 를
  // 그대로 채널화 — `[cc-watcher]`, `[port-mapping]` 같이 enum 에 없는 라인도 그 자체
  // 채널로 분류되어 grep / 필터링이 정확.
  const getChannel = (c: string): Logger => {
    let logger = channelCache.get(c);
    if (!logger) {
      const child = baseLogger.child({ "log.logger": c });
      logger = {
        trace: (m, f) => child.trace(f ?? {}, m),
        debug: (m, f) => child.debug(f ?? {}, m),
        info: (m, f) => child.info(f ?? {}, m),
        warn: (m, f) => child.warn(f ?? {}, m),
        error: (m, f) => child.error(f ?? {}, m),
        fatal: (m, f) => child.fatal(f ?? {}, m),
      };
      channelCache.set(c, logger);
    }
    return logger;
  };

  const tagPattern = /^\[([a-z][a-z0-9_-]*)\]\s*/i;

  function emit(level: "info" | "warn" | "error", args: unknown[]): void {
    const first = args[0];
    let channel = "stdout-fallback";
    let message: string;
    if (typeof first === "string") {
      const m = first.match(tagPattern);
      if (m) {
        channel = m[1].toLowerCase();
        message = first.slice(m[0].length) + restToString(args.slice(1));
      } else {
        message = first + restToString(args.slice(1));
      }
    } else {
      message = args.map(stringifyArg).join(" ");
    }
    getChannel(channel)[level](message);
  }

  // 원본 stdout/stderr 출력은 보존 — Xcode console / DEBUG mirror 가 여전히
  // 읽을 수 있어야 한다. unified.log 는 추가 채널이지 대체 아님.
  const origLog = console.log.bind(console);
  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);

  console.log = (...args: unknown[]) => {
    emit("info", args);
    origLog(...args);
  };
  console.warn = (...args: unknown[]) => {
    emit("warn", args);
    origWarn(...args);
  };
  console.error = (...args: unknown[]) => {
    emit("error", args);
    origError(...args);
  };

  getChannel("daemon").info("console bridge installed", {
    "event.action": "logger.bridge.install",
  });
}

function restToString(rest: unknown[]): string {
  if (rest.length === 0) return "";
  return " " + rest.map(stringifyArg).join(" ");
}

function stringifyArg(v: unknown): string {
  if (typeof v === "string") return v;
  if (v instanceof Error) return `${v.name}: ${v.message}`;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
