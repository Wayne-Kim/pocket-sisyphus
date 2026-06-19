/**
 * Tor 네이티브 로그 파일 → unified.log 재발행.
 *
 * Tor 바이너리는 자기 자신의 stdout 외에 torrc 의 `Log notice file <path>` 로
 * 별도 파일에 매우 상세히 기록한다 (회로 빌드, descriptor publish, IP 변화
 * 감지, introduction point 시도 등). 이 파일 (`tor/tor.log`) 의 신규 라인을
 * tail 해서 ECS 라인으로 변환, unified.log 의 `log.logger: "tor"` 채널로 보낸다.
 *
 * 원본 tor.log 는 그대로 유지 — raw fallback 으로 두고 unified 와 양방향 분석.
 *
 * 포맷:
 *   May 28 06:33:12.000 [notice] Bootstrapped 100% (done)
 *   May 28 06:33:14.500 [warn] ConnectionWatchdog: ...
 *
 * Tor level → ECS level 매핑:
 *   debug → debug
 *   info  → debug   (Tor 의 info 는 매우 많음, ECS 의 debug 가 적절)
 *   notice→ info
 *   warn  → warn
 *   err   → error
 */

import fs from "node:fs";
import { makeLogger } from "../logging/log.js";

const torLog = makeLogger("tor");

/**
 * 한 tailer 만 활성. 재시작 시 옛 tailer 가 늘어진 fs.watch 핸들 가지고 있지 않게.
 */
let activeTimer: NodeJS.Timeout | null = null;
let activeWatcher: fs.FSWatcher | null = null;
let lastOffset = 0;
let lineBuf = "";

const LEVEL_MAP: Record<string, "debug" | "info" | "warn" | "error"> = {
  debug: "debug",
  info: "debug",
  notice: "info",
  warn: "warn",
  err: "error",
};

const TOR_LINE = /^[A-Z][a-z]{2}\s+\d+\s+\d{2}:\d{2}:\d{2}\.\d+\s+\[(\w+)\]\s+(.*)$/;

export function startTorLogTailer(torLogFile: string): void {
  stopTorLogTailer();

  // 파일 없으면 만들어질 때까지 대기 — fs.watch 가 그 시점에 트리거.
  // 대부분 startTor 가 tor 를 spawn 한 직후 호출되므로 곧 생긴다.
  try {
    const stat = fs.statSync(torLogFile);
    lastOffset = stat.size;
  } catch {
    lastOffset = 0;
  }

  const drain = (): void => {
    try {
      const stat = fs.statSync(torLogFile);
      // 로테이션 / truncate 감지 — 파일 크기가 줄었으면 0 부터 다시 읽는다.
      if (stat.size < lastOffset) lastOffset = 0;
      if (stat.size === lastOffset) return;

      const fd = fs.openSync(torLogFile, "r");
      try {
        const len = stat.size - lastOffset;
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, lastOffset);
        lastOffset = stat.size;
        lineBuf += buf.toString("utf8");
        let nl: number;
        while ((nl = lineBuf.indexOf("\n")) !== -1) {
          const line = lineBuf.slice(0, nl);
          lineBuf = lineBuf.slice(nl + 1);
          if (line.trim()) emitLine(line);
        }
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      // 파일 아직 없음 / 한 사이클 동안 사라짐 — 다음 사이클에 재시도.
    }
  };

  try {
    // fs.watch: macOS 의 FSEvents 기반 — append 만 일어나는 파일에서도 'change'
    // 이벤트 정상. 일부 환경 (network drive, special FS) 에서 누락될 수 있어
    // 1s polling 도 안전망으로 같이 돌린다.
    activeWatcher = fs.watch(torLogFile, { persistent: false }, () => drain());
  } catch {
    // 파일 부재 — polling 만으로 충분.
  }
  activeTimer = setInterval(drain, 1000);
  // 부팅 직후 한 번 즉시.
  drain();
}

export function stopTorLogTailer(): void {
  if (activeTimer) {
    clearInterval(activeTimer);
    activeTimer = null;
  }
  if (activeWatcher) {
    try {
      activeWatcher.close();
    } catch {
      // 무시
    }
    activeWatcher = null;
  }
  lineBuf = "";
}

function emitLine(line: string): void {
  const m = line.match(TOR_LINE);
  if (!m) {
    // 포맷 불일치 (예: stack trace 의 후속 라인) — fallback 으로 debug 채널.
    torLog.debug(line);
    return;
  }
  const torLevel = m[1].toLowerCase();
  const message = m[2];
  const level = LEVEL_MAP[torLevel] ?? "info";

  // 안정적 머신 키 — 대표 이벤트만 부여. 나머지는 message 그대로.
  const fields: Record<string, unknown> = { "tor.severity": torLevel };

  const bootstrap = message.match(/Bootstrapped (\d+)%/);
  if (bootstrap) {
    fields["event.action"] =
      bootstrap[1] === "100" ? "tor.bootstrap.complete" : "tor.bootstrap.progress";
    fields["tor.bootstrap.percent"] = parseInt(bootstrap[1], 10);
  } else if (/Opened HiddenService listener/.test(message)) {
    fields["event.action"] = "tor.hs.listener.open";
  } else if (/Tor has successfully opened a circuit/.test(message)) {
    fields["event.action"] = "tor.circuit.open";
  } else if (/Catching signal/.test(message)) {
    fields["event.action"] = "tor.signal";
  }

  torLog[level](message, fields);
}
