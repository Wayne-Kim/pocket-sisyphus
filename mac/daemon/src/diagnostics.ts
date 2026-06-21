/**
 * 진단 번들 — iOS 「문제 신고/진단」 화면이 한 번에 묶어 «사용자가 직접» 공유/내보내기 하는
 * 로컬 진단 자료. 자동 전송은 없다(LAN 전용·무텔레메트리 원칙 — egress.ts·docs/THREAT_MODEL.md).
 *
 * 묶는 것: (1) 서브시스템 스냅샷(버전·인스턴스·프로세스·LAN 전용 모드·구성 요약) (2) 최근
 * crash 마커 (3) 마스킹된 unified.log tail. 비밀(webhook URL·토큰·키)은 redact.maskSecrets 로
 * 가린다 — 밖으로 나갈 수 있는 텍스트라서. 어떤 outbound 도 내지 않는다(순수 로컬 읽기).
 */

import fs from "node:fs";
import path from "node:path";

import { readConfig, listAttestDevices } from "./config.js";
import { DAEMON_VERSION } from "./version.js";
import { INSTANCE_ID, UNIFIED_LOG_FILE } from "./logging/log.js";
import { CRASH_DIR, type CrashReport } from "./logging/crash.js";
import { maskSecrets, knownConfigSecrets } from "./logging/redact.js";

/** unified.log tail 의 기본 상한(바이트) — Tor 대역폭에서 무겁지 않게. */
const DEFAULT_TAIL_BYTES = 256 * 1024;
/** 번들에 실을 최근 crash 마커 최대 개수. */
const DEFAULT_CRASH_LIMIT = 5;

/** 비밀이 제거된 구성 요약 — 값이 아니라 «있/없음·개수» 만. */
export interface ConfigSummary {
  hasToken: boolean;
  discordConfigured: boolean;
  ascConfigured: boolean;
  mcpServerCount: number;
  attestDeviceCount: number;
  port: number | null;
  sshPort: number | null;
  lanOnly: boolean;
}

export interface SubsystemSnapshot {
  daemonVersion: string;
  instanceId: string;
  pid: number;
  parentPid: number;
  uptimeSec: number;
  platform: string;
  nodeVersion: string;
  connectedClients: number;
  torActive: boolean;
}

export interface DiagnosticsBundle {
  /** 번들 생성 시각 ISO 8601 UTC. */
  generatedAt: string;
  subsystem: SubsystemSnapshot;
  config: ConfigSummary;
  /** 최근 crash 마커(최신 우선). 없으면 빈 배열. */
  crashes: CrashReport[];
  /** 마스킹된 unified.log tail (없으면 빈 문자열). */
  unifiedLogTail: string;
  /** tail 이 잘렸는지(원본이 상한보다 컸는지). */
  unifiedLogTruncated: boolean;
}

/** 비밀 제거된 구성 요약. 값은 절대 담지 않는다. */
export function buildConfigSummary(): ConfigSummary {
  const cfg = readConfig();
  return {
    hasToken: Boolean(cfg?.tokenHash),
    discordConfigured: Boolean(cfg?.notify?.discord?.webhookUrl),
    ascConfigured: Boolean(cfg?.asc?.privateKeyPem),
    mcpServerCount: cfg?.mcp?.servers?.length ?? 0,
    attestDeviceCount: listAttestDevices(cfg).length,
    port: cfg?.port ?? null,
    sshPort: cfg?.sshPort ?? null,
    lanOnly: cfg?.lanOnly === true,
  };
}

/** 서브시스템 런타임 스냅샷. tor/ws 상태는 호출부가 주입(모듈 결합 최소화·테스트 용이). */
export function buildSubsystemSnapshot(providers: {
  connectedClients?: number;
  torActive?: boolean;
} = {}): SubsystemSnapshot {
  return {
    daemonVersion: DAEMON_VERSION,
    instanceId: INSTANCE_ID,
    pid: process.pid,
    parentPid: process.ppid,
    uptimeSec: Math.round(process.uptime()),
    platform: process.platform,
    nodeVersion: process.version,
    connectedClients: providers.connectedClients ?? 0,
    torActive: providers.torActive ?? false,
  };
}

/** 최근 crash 마커를 최신 우선으로 읽는다(이미 쓰일 때 마스킹됐지만 방어적 재마스킹). */
export function readRecentCrashMarkers(
  limit = DEFAULT_CRASH_LIMIT,
  secrets: string[] = knownConfigSecrets(),
): CrashReport[] {
  let files: string[];
  try {
    files = fs
      .readdirSync(CRASH_DIR)
      .filter((f) => f.startsWith("crash-") && f.endsWith(".json"))
      .sort()
      .reverse(); // 이름이 시각순이라 reverse = 최신 우선.
  } catch {
    return []; // 디렉터리 없음 = 크래시 이력 없음.
  }
  const out: CrashReport[] = [];
  for (const f of files.slice(0, limit)) {
    try {
      const raw = fs.readFileSync(path.join(CRASH_DIR, f), "utf8");
      const parsed = JSON.parse(maskSecrets(raw, secrets)) as CrashReport;
      out.push(parsed);
    } catch {
      /* 손상된 마커는 건너뛴다. */
    }
  }
  return out;
}

/** unified.log 의 마지막 maxBytes 를 마스킹해 읽는다. 라인 경계에서 시작하도록 다듬는다. */
export function readUnifiedLogTail(
  maxBytes = DEFAULT_TAIL_BYTES,
  secrets: string[] = knownConfigSecrets(),
): { text: string; truncated: boolean } {
  let fd: number | null = null;
  try {
    const stat = fs.statSync(UNIFIED_LOG_FILE);
    const size = stat.size;
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    const buf = Buffer.alloc(length);
    fd = fs.openSync(UNIFIED_LOG_FILE, "r");
    fs.readSync(fd, buf, 0, length, start);
    let text = buf.toString("utf8");
    const truncated = start > 0;
    // 잘린 경우 첫 (부분) 라인을 버려 깨진 JSON 라인이 안 보이게.
    if (truncated) {
      const nl = text.indexOf("\n");
      if (nl >= 0) text = text.slice(nl + 1);
    }
    return { text: maskSecrets(text, secrets), truncated };
  } catch {
    return { text: "", truncated: false }; // 로그 없음(빈).
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* best-effort */
      }
    }
  }
}

/** 진단 번들 전체를 조립한다. 순수 로컬 읽기 — 어떤 outbound 도 내지 않는다. */
export function buildDiagnosticsBundle(
  providers: {
    connectedClients?: number;
    torActive?: boolean;
    tailBytes?: number;
    crashLimit?: number;
  } = {},
): DiagnosticsBundle {
  const secrets = knownConfigSecrets();
  const tail = readUnifiedLogTail(providers.tailBytes, secrets);
  return {
    generatedAt: new Date().toISOString(),
    subsystem: buildSubsystemSnapshot(providers),
    config: buildConfigSummary(),
    crashes: readRecentCrashMarkers(providers.crashLimit, secrets),
    unifiedLogTail: tail.text,
    unifiedLogTruncated: tail.truncated,
  };
}
