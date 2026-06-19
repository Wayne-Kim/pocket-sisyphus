// Tor 자식 프로세스 관리.
// - 부팅 시 tor 프로세스를 spawn하고 동적 torrc 생성
// - HiddenService 디렉토리는 ~/Library/Application Support/PocketSisyphus/tor/hs/
// - tor가 onion 주소 파일(hostname)을 그 안에 생성하면 읽어들임
// - SOCKS 는 비활성 — Single-hop 모드 요구사항 (아래 참조).
//
// ## Single-hop hidden service 모드 (속도 최적화)
// 기본 hidden service 는 양쪽 다 3홉 → 총 6홉. 우리는 개인용이라 서버(Mac) 의 IP
// 익명성을 포기할 수 있어 `HiddenServiceSingleHopMode` 를 켠다. 서버측 회로가
// 1홉으로 줄어 총 4홉 → 회로 RTT 가 거의 반토막.
//
// 트레이드오프: rendezvous 릴레이는 Mac 의 실제 IP 를 본다 (3홉 안에 숨지 않음).
// 위협 모델: 클라이언트(폰) 는 어차피 .onion 주소를 알고 있고, 그 .onion = 우리
// Ed25519 공개키 hash. ISP/통신사 대비 익명성은 클라이언트측 3홉으로 충분히 보장된다.
// 서버 자신을 익명화해야 할 이유 0 — `Pocket Sisyphus` 는 본인 Mac 을 본인 폰에서만
// 쓰는 도구다.
//
// 이 모드 요구사항:
// - `HiddenServiceNonAnonymousMode 1`
// - `SOCKSPort 0` (이 tor 인스턴스에서 client 트래픽 금지)
// - daemon 자체가 outbound Tor 트래픽을 쓰지 않음 (지금 그렇다)
//
// onion 주소는 그대로 유지 (Ed25519 key 는 같음). 페어링 재발급 불필요.

import { spawn, execFileSync, ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { CONFIG_DIR, ensureConfigDir } from "../config.js";
import {
  ensureClientAuthKeypair,
  writeAuthorizedClient,
} from "./clientAuth.js";
import { startTorLogTailer, stopTorLogTailer } from "./logTailer.js";
import { makeLogger } from "../logging/log.js";

const log = makeLogger("tor");

// Mac 앱이 spawn 할 땐 POCKET_CLAUDE_TOR_BIN 으로 .app 안의 번들된 tor 경로를 넘긴다.
// 배포된 .app 을 받는 Mac 에 Homebrew tor 가 깔려 있다는 보장이 없으므로 항상 번들된 tor 사용.
// 안 넘긴 경우는 dev 가 daemon 만 단독 실행한 케이스로 간주하고 시스템 tor fallback.
const TOR_BIN = process.env.POCKET_CLAUDE_TOR_BIN ?? "/opt/homebrew/bin/tor";
// 번들된 geoip 데이터 디렉토리. torrc 의 GeoIPFile/GeoIPv6File 옵션으로 명시 지정.
// tor 가 컴파일 시 박힌 기본 경로(/opt/homebrew/share/tor/) 를 못 찾을 때 (배포된 .app
// 환경) 필수.
const TOR_DATA_DIR_BUNDLED = process.env.POCKET_CLAUDE_TOR_DATA_DIR ?? "";
const TOR_DIR = path.join(CONFIG_DIR, "tor");
const HS_DIR = path.join(TOR_DIR, "hs");
const DATA_DIR = path.join(TOR_DIR, "data");
const TORRC = path.join(TOR_DIR, "torrc");
const HOSTNAME_FILE = path.join(HS_DIR, "hostname");
const LOG_FILE = path.join(TOR_DIR, "tor.log");

// Single-hop 모드에서 SOCKSPort 는 0 으로 강제. 값은 더 이상 torrc 에 반영되지 않지만
// 기존 호출자 시그니처 호환을 위해 옵션은 유지한다.
const DEFAULT_SOCKS_PORT = 0;
const DEFAULT_CONTROL_PORT = 9051;

/**
 * 현재 떠 있는 Tor child 참조. `startTor` 가 spawn 직후 동기적으로 채우고 exit 시 비움.
 *
 * 필요한 이유: `startTor` 는 `waitForOnion` (~30s) 후에 TorHandle 을 return 하는데,
 * 그 사이에 daemon 이 SIGTERM 받으면 호출자(server.ts) 는 아직 `torHandle === null`
 * 이라 stop() 호출 못 함 → Tor child 가 orphan. 이 module-level 참조가 안전망.
 */
let activeTorProcess: ChildProcess | null = null;

/**
 * 현재 활성 TorHandle + 마지막으로 사용된 옵션. `rotatePairingKeys` 가 같은 옵션으로
 * Tor 를 재시작할 때 참조. 모듈 캡슐화를 깨지 않으려고 외부 모듈은 두 회전 API 만 보고
 * 내부 상태는 안 본다.
 */
let activeTorHandle: TorHandle | null = null;
let lastTorOptions: Required<TorOptions> | null = null;

/**
 * Tor bootstrap 100% 도달 여부. `kickTorReconnect` 가 너무 일찍 호출되면 SIGHUP 이
 * config reload 만 하고 introduction point 재선정으로 이어지지 않을 수 있어 게이트.
 * stdout 에 "Bootstrapped 100%" 라인이 한 번이라도 떴으면 true 로 stick.
 */
let torBootstrapped = false;

/**
 * 마지막 reconnect kick 시각 (epoch ms). 30s 쿨다운으로 rate limit — 사용자가 모뎀
 * 재부팅 등으로 path 이벤트를 폭주시켜도 회로 재빌드 폭주는 막는다.
 */
let lastKickAt = 0;

/**
 * 의도된 종료 플래그. `handle.stop()` / `rotatePairingKeys` 가 SIGTERM 보내기 직전 true 로
 * 셋하면 exit 핸들러는 자동 재시작을 건너뛴다. spawn 직후 (`startTor`) false 로 reset.
 *
 * 동기: sleep/wake 사이클이나 macOS 자체의 메모리 회수로 Tor child 만 SIGKILL 당하는
 * 경우가 실측에서 관찰됨 (tor.log 의 ORPHAN spawn — `Catching signal TERM` 없이 새 프로세스
 * 등장). 현 코드는 child 가 죽으면 `activeTorProcess = null` 만 셋하고 끝나서 daemon 은
 * Tor 가 죽은 줄도 모른 채 폰 요청에 onion 응답 못 줌 — 사용자에겐 «하루 종일 연결 안 됨»
 * 으로 보임. 이 플래그 + exit handler 의 자동 재시작이 보강.
 */
let intentionalShutdown = false;

/**
 * 자동 재시작 backoff (ms). 의도하지 않은 죽음 → setTimeout 으로 재시작 시도. 연속 실패
 * 시 1s → 2s → 4s … 최대 30s 까지 exponential. 성공적으로 spawn 되면 1s 로 reset.
 */
let restartBackoffMs = 1000;
const MIN_RESTART_BACKOFF_MS = 1000;
const MAX_RESTART_BACKOFF_MS = 30_000;
let pendingRestartTimer: NodeJS.Timeout | null = null;

export function getActiveTorProcess(): ChildProcess | null {
  return activeTorProcess;
}

export type TorOptions = {
  hiddenServicePort: number; // 외부에 노출되는 가상 포트 (endpoint HTTP, 보통 80)
  targetPort: number;        // 로컬에서 listening 중인 endpoint HTTP 포트 (예: 7778)
  /** SSH fallback 채널 — onion virtual port. 보통 22. */
  sshHiddenServicePort?: number;
  /** SSH fallback 채널 — 로컬 sshd listening port. 보통 22022. */
  sshTargetPort?: number;
  /** @deprecated Single-hop 모드에서 SOCKS 는 0. 값은 무시된다. */
  socksPort?: number;
};

export type TorHandle = {
  process: ChildProcess;
  onionAddress: string;
  /** v3 client-auth 의 클라이언트측 x25519 priv (base32, no padding). 페어링 QR 로 전달. */
  clientAuthPriv: string;
  stop: () => Promise<void>;
};

function ensureDirs(): void {
  ensureConfigDir();
  for (const d of [TOR_DIR, HS_DIR, DATA_DIR]) {
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  }
  // HS_DIR은 tor가 0700 권한 강제하므로 미리 맞춤
  fs.chmodSync(HS_DIR, 0o700);
  fs.chmodSync(DATA_DIR, 0o700);
  // orphan tor 를 먼저 회수해야 그 tor 가 쥔 DataDirectory lock 이 풀린다 → 이어지는
  // cleanupStaleLock 이 «죽은 PID 의 lock» 으로 보고 제거. 순서 중요.
  reclaimStaleTor();
  cleanupStaleLock();
}

/**
 * 이전 daemon 의 orphan tor(우리 torrc 로 띄운) 를 종료. 새 tor spawn 전 호출.
 *
 * 배경: orphan daemon(node) 을 reclaimStaleDaemon 으로 죽이면 그 자식 tor 는 PPID=1 로
 * reparent 되어 살아남아 DataDirectory lock 을 계속 쥔다 → 새 tor 가 "Failed to acquire
 * lock" 으로 부팅 실패. cleanupStaleLock 은 «살아있는 PID 의 lock» 은 안전상 안 건드리므로,
 * 살아있는 orphan tor 자체를 여기서 정리해야 한다.
 *
 * 식별: tor 는 SocksPort 0 라 LISTEN 포트가 없을 수 있어 포트로 못 찾는다. 대신 커맨드라인이
 * «우리 torrc 절대경로» 를 들고 있는지로 판별 — 시스템/무관 tor 는 절대 안 건드림. 자기 자신과
 * 살아있는 activeTorProcess(이중 종료 방지) 는 제외.
 */
function reclaimStaleTor(): void {
  let out: string;
  try {
    out = execFileSync("/usr/bin/pgrep", ["-f", TORRC], {
      encoding: "utf8",
      timeout: 2000,
    });
  } catch {
    return; // 매치 없음(pgrep exit 1) 또는 pgrep 부재 — 정리할 것 없음.
  }
  const alivePid = activeTorProcess?.pid ?? -1;
  for (const tok of out.split(/\s+/)) {
    const pid = Number.parseInt(tok, 10);
    if (!Number.isFinite(pid) || pid <= 1) continue;
    if (pid === process.pid || pid === alivePid) continue;
    // pgrep -f 는 인자 어디든 매치하므로(우리 node 커맨드라인엔 TORRC 가 없지만) ps 로
    // 실제 tor 바이너리 + torrc 인자인지 한 번 더 확인 후 종료.
    let cmd: string;
    try {
      cmd = execFileSync("/bin/ps", ["-o", "command=", "-p", String(pid)], {
        encoding: "utf8",
        timeout: 2000,
      }).trim();
    } catch {
      continue;
    }
    if (!cmd.includes(TORRC)) continue;
    try {
      process.kill(pid, "SIGKILL");
      log.warn("reclaimed stale tor", {
        "event.action": "tor.reclaim",
        "process.pid": pid,
      });
      console.log(`[tor] reclaimed stale tor pid=${pid}`);
    } catch {
      /* 이미 죽음 / 권한 없음 */
    }
  }
}

/**
 * `<DATA_DIR>/lock` 이 남아있고 그 안의 PID 가 죽었거나 우리 tor 가 아니면 삭제.
 * 정상 종료된 Tor 는 lock 을 지우지만, daemon 이 SIGKILL 로 죽으면서 Tor 도 같이
 * 강제 종료되는 경로에선 lock 이 남아 다음 Tor spawn 이 "Failed to acquire lock"
 * 으로 실패할 수 있다. 살아있는 PID 의 lock 은 절대 건드리지 않음.
 */
function cleanupStaleLock(): void {
  const lockFile = path.join(DATA_DIR, "lock");
  if (!fs.existsSync(lockFile)) return;
  try {
    const content = fs.readFileSync(lockFile, "utf8").trim();
    const pid = parseInt(content, 10);
    if (!Number.isFinite(pid) || pid <= 1) {
      fs.unlinkSync(lockFile);
      log.info("removed malformed lock file", {
        "event.action": "tor.lock.malformed_removed",
      });
      return;
    }
    // PID 살아있나 검사 (signal 0 = 존재 체크).
    try {
      process.kill(pid, 0);
      // 살아있음 — lock 건드리지 않음 (실제 tor 라면 그 Tor 가 쓰는 중이라 안전 우선).
      log.info("lock held by alive pid — leaving as-is", {
        "event.action": "tor.lock.alive",
        "tor.lock.pid": pid,
      });
    } catch (e: unknown) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ESRCH") {
        fs.unlinkSync(lockFile);
        log.info("removed stale lock", {
          "event.action": "tor.lock.stale_removed",
          "tor.lock.pid": pid,
        });
      }
      // EPERM 이면 다른 user 의 살아있는 프로세스 — 그대로 둠.
    }
  } catch (e) {
    log.warn("lock cleanup failed", {
      "event.action": "tor.lock.cleanup_fail",
      "error.message": (e as Error).message,
    });
  }
}

function renderTorrc(opts: Required<TorOptions>): string {
  // Mac 앱이 .app/Contents/Resources/daemon/share/tor/{geoip,geoip6} 를 번들로 넘김.
  // 이 옵션이 없으면 tor 가 컴파일 시 박힌 기본 경로(/opt/homebrew/share/tor) 를 찾는데,
  // 배포된 .app 환경에선 Homebrew 자체가 없을 수도 있어 항상 번들 경로 명시 → "GeoIP
  // file ... not found" 로그 회피.
  const geoipLines = TOR_DATA_DIR_BUNDLED
    ? [
        `GeoIPFile ${path.join(TOR_DATA_DIR_BUNDLED, "geoip")}`,
        `GeoIPv6File ${path.join(TOR_DATA_DIR_BUNDLED, "geoip6")}`,
      ]
    : [];
  return [
    "# Pocket Sisyphus — auto-generated torrc",
    `DataDirectory ${DATA_DIR}`,
    `Log notice file ${LOG_FILE}`,
    ...geoipLines,
    // SocksPort 0 = 이 tor 인스턴스에서 client 트래픽 금지 (Single-hop 모드 요구사항).
    // daemon 은 outbound Tor 를 쓰지 않으므로 영향 없음. 과거 smoke 테스트의
    // `curl --socks5-hostname 127.0.0.1:9050` 은 동작 안 함 — 외부 tor (e.g. brew tor)
    // 띄워서 테스트하거나 폰에서 직접 검증.
    "SocksPort 0",
    "ClientOnly 0",
    "RunAsDaemon 0",
    "",
    "# === Hidden service v3 (Ed25519) ===",
    "# 듀얼 채널 모델 — 같은 onion 으로 두 개의 가상 포트 노출:",
    "#   - hiddenServicePort (보통 80) → daemon endpoint-only HTTP listener (127.0.0.1:7778)",
    "#       Tor 로만 노출. iOS 가 /endpoint 받아가는 채널.",
    "#   - sshHiddenServicePort (보통 22) → 임베디드 sshd (127.0.0.1:22022)",
    "#       SSH fallback 채널. 직접 SSH (IPv4/IPv6) 가 막힌 환경에서 iOS happy eyeballs 가 채택.",
    `HiddenServiceDir ${HS_DIR}`,
    `HiddenServicePort ${opts.hiddenServicePort} 127.0.0.1:${opts.targetPort}`,
    ...(opts.sshHiddenServicePort && opts.sshTargetPort
      ? [
          `HiddenServicePort ${opts.sshHiddenServicePort} 127.0.0.1:${opts.sshTargetPort}`,
        ]
      : []),
    "",
    "# === Single-hop 모드 (속도 최적화) ===",
    "# 서버측 회로를 3홉→1홉으로 줄여 RTT 거의 반토막. Mac IP 가 rendezvous 릴레이에",
    "# 노출되는 대가 — 개인 기기라 OK. .onion 주소는 그대로 유지.",
    "HiddenServiceNonAnonymousMode 1",
    "HiddenServiceSingleHopMode 1",
    "",
    "# === 회로 안정성 ===",
    // hidden service virtual port 를 long-lived 로 표시 → tor 가 long-lived stream 에
    // 적합한 stable guard 를 고르고 회로 회전 주기를 늘린다. 폰 ↔ Mac 은 분~시간 단위
    // 세션이므로 long-lived 가 맞다. SSH fallback 도 long-lived stream.
    `LongLivedPorts ${[opts.hiddenServicePort, opts.sshHiddenServicePort]
      .filter((p): p is number => typeof p === "number")
      .join(",")}`,
    // 회로 1시간 유지 (기본 10분). 클라이언트(iOS)와 대칭. 짧은 백그라운드 트립 후
    // 사용자 액션이 곧장 기존 회로 재사용.
    "MaxCircuitDirtiness 3600",
    // Introduction point 를 3 → 5 개. 가정용 IP 변경으로 일부 IP 회로가 죽어도 즉시
    // 다른 IP 로 폴백 — 사용자가 1~5분 동안 "연결 안 됨" 보는 케이스 ↓.
    "HiddenServiceNumIntroductionPoints 5",
    // Entry guard 도 1 → 3. guard 한 개가 흔들리는 ISP 환경에서 회로 신규 빌드 시
    // 폴백 후보가 즉시 준비돼 있게.
    "NumEntryGuards 3",
    // NAT 타임아웃 회피 — 일부 가정용 공유기는 idle TCP 를 60~120s 만에 끊는다.
    // 60s keepalive 로 회로 유지를 도움. 트래픽 거의 없음 (작은 keepalive 셀).
    "KeepalivePeriod 60",
    "",
  ].join("\n");
}

async function waitForOnion(timeoutMs = 30_000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(HOSTNAME_FILE)) {
      const content = fs.readFileSync(HOSTNAME_FILE, "utf8").trim();
      if (content.endsWith(".onion")) return content;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`onion hostname not generated within ${timeoutMs}ms`);
}

export async function startTor(opts: TorOptions): Promise<TorHandle> {
  const merged: Required<TorOptions> = {
    hiddenServicePort: opts.hiddenServicePort,
    targetPort: opts.targetPort,
    sshHiddenServicePort: opts.sshHiddenServicePort ?? 0,
    sshTargetPort: opts.sshTargetPort ?? 0,
    socksPort: opts.socksPort ?? DEFAULT_SOCKS_PORT,
  };
  // 회전 호출이 같은 옵션으로 재시작할 수 있게 마지막 옵션 보관.
  lastTorOptions = merged;

  ensureDirs();

  // v3 client auth — pub 은 HS_DIR/authorized_clients/phone.auth, priv 는 페어링 QR.
  // .auth 파일이 하나라도 있으면 Tor 는 client-auth 를 강제한다 → 폰만 디스크립터를
  // 복호화할 수 있게 됨. .onion 주소가 어디 새도 다른 사람은 접근 자체 불가.
  const authKeys = ensureClientAuthKeypair(TOR_DIR);
  writeAuthorizedClient(HS_DIR, "phone", authKeys.pubB32);

  fs.writeFileSync(TORRC, renderTorrc(merged), { mode: 0o600 });

  log.info("starting tor", {
    "event.action": "tor.spawn",
    "tor.config_path": TORRC,
  });
  // 새 spawn — 직전 회차의 자동 재시작 보류 작업 / shutdown 플래그 / backoff 모두 reset.
  // intentionalShutdown 을 spawn 직전에 false 로 박지 않으면, stop() → 자동재시작 race
  // 에서 exit 핸들러가 «의도된 종료» 로 잘못 분기할 수 있다.
  intentionalShutdown = false;
  restartBackoffMs = MIN_RESTART_BACKOFF_MS;
  if (pendingRestartTimer) {
    clearTimeout(pendingRestartTimer);
    pendingRestartTimer = null;
  }

  const proc = spawn(TOR_BIN, ["-f", TORRC], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  // spawn 직후 즉시 module-level 참조 셋팅 — bootstrap (~30s) 중에 daemon 이 죽어도
  // shutdown 핸들러가 이걸로 child 정리할 수 있다.
  activeTorProcess = proc;

  // Tor 가 직접 쓰는 tor.log 의 신규 라인을 unified.log 로 흘려보낸다.
  // (Tor stdout 은 위에서 bootstrap % 만 캡처하고 버린다 — 자세한 정보는 tor.log 만이 갖고 있음.)
  startTorLogTailer(LOG_FILE);

  // 새 spawn — bootstrap 게이트도 초기화.
  torBootstrapped = false;
  let bootstrapShown = false;
  proc.stdout?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    // "Bootstrapped XX% (...)" 라인만 압축 출력
    const m = text.match(/Bootstrapped (\d+)%/);
    if (m && !bootstrapShown) {
      process.stdout.write(`[tor] bootstrap ${m[1]}%   \r`);
      if (m[1] === "100") {
        bootstrapShown = true;
        torBootstrapped = true;
        process.stdout.write("\n");
      }
    }
  });
  proc.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(`[tor:stderr] ${chunk}`);
  });

  proc.on("exit", (code, signal) => {
    log.info("tor process exited", {
      "event.action": "tor.exit",
      "process.exit_code": code,
      signal,
    });
    if (activeTorProcess === proc) activeTorProcess = null;
    if (activeTorHandle && activeTorHandle.process === proc) activeTorHandle = null;
    torBootstrapped = false;
    stopTorLogTailer();

    // 의도된 종료 (handle.stop / rotatePairingKeys / daemon shutdown) 면 여기서 끝.
    if (intentionalShutdown) return;
    // lastTorOptions 가 없으면 한 번도 정상적으로 시작된 적 없는 케이스 — 자동 재시작 불가.
    if (!lastTorOptions) return;
    // 이미 보류된 재시작이 있으면 중복 셋업하지 않음 — pending timer 가 처리.
    if (pendingRestartTimer) return;

    const delay = restartBackoffMs;
    log.warn("unexpected tor exit — scheduling auto-restart", {
      "event.action": "tor.restart.schedule",
      "process.exit_code": code,
      signal,
      "tor.restart.delay_ms": delay,
    });
    pendingRestartTimer = setTimeout(() => {
      pendingRestartTimer = null;
      if (intentionalShutdown) return;  // 그 사이 종료 신호 왔으면 중단
      const opts = lastTorOptions;
      if (!opts) return;
      // 다음 시도까지의 backoff 미리 증가 — startTor 가 성공해서 reset 하면 무시됨.
      restartBackoffMs = Math.min(restartBackoffMs * 2, MAX_RESTART_BACKOFF_MS);
      startTor(opts).catch((e) => {
        log.warn("tor auto-restart failed", {
          "event.action": "tor.restart.fail",
          "error.message": (e as Error).message,
        });
        // catch 안에선 backoff 가 이미 다음 단계로 올라간 상태 → exit 핸들러가 다시
        // 트리거되면 자연스럽게 더 긴 대기로 이어진다.
      });
    }, delay);
  });

  // tor가 hidden service hostname 파일 만들 때까지 대기
  const onionAddress = await waitForOnion();
  console.log(`[tor] hidden service ready: ${onionAddress}`);

  const handle: TorHandle = {
    process: proc,
    onionAddress,
    clientAuthPriv: authKeys.privB32,
    stop: () =>
      new Promise<void>((resolve) => {
        // SIGTERM 보내기 전에 플래그 셋 — exit 핸들러가 «의도된 종료» 로 인식해 자동
        // 재시작을 건너뛰게 한다. server.ts shutdown / rotatePairingKeys 모두 이 경로.
        intentionalShutdown = true;
        if (pendingRestartTimer) {
          clearTimeout(pendingRestartTimer);
          pendingRestartTimer = null;
        }
        proc.once("exit", () => resolve());
        proc.kill("SIGTERM");
        // 안전망: 5초 후 강제 종료
        setTimeout(() => proc.kill("SIGKILL"), 5000);
      }),
  };
  activeTorHandle = handle;
  return handle;
}

/**
 * 페어링 회전 — onion 키 + client-auth 키 + HS descriptor 캐시를 모두 갈아 끼우고
 * Tor 를 재시작한다. 결과적으로:
 *   - 새 .onion 주소 (Ed25519 secret_key 재생성)
 *   - 새 client-auth x25519 keypair (옛 priv 노출돼도 무용)
 *   - 옛 onion 주소 / 옛 priv 의 모든 캐시 청산
 *
 * 호출 전제: 이미 한 번 `startTor` 가 호출돼 `lastTorOptions` 가 채워져 있어야 한다.
 * Bearer token 회전은 이 함수의 책임이 아니다 — 호출자가 `config.json` 갱신 + WS 끊기.
 */
export async function rotatePairingKeys(): Promise<TorHandle> {
  if (!lastTorOptions) {
    throw new Error("rotatePairingKeys: startTor 가 한 번도 호출되지 않음");
  }

  // 1) 살아 있는 Tor child 정리. 옛 key 가 잠겨 있는 동안 unlink 하면 ETXTBSY 위험은
  //    없지만 (그냥 fd 가 살아 있는 정도) 안전상 먼저 종료.
  if (activeTorHandle) {
    try {
      await activeTorHandle.stop();
    } catch {
      // 이미 죽은 child — 무시.
    }
    activeTorHandle = null;
  }

  // 2) 키 자료 삭제. unlink 실패는 무시 (이미 없는 케이스).
  const toUnlink = [
    path.join(HS_DIR, "hs_ed25519_secret_key"),
    path.join(HS_DIR, "hs_ed25519_public_key"),
    path.join(HS_DIR, "hostname"),
    path.join(TOR_DIR, "client_auth.jwk"),
  ];
  for (const p of toUnlink) {
    try {
      fs.unlinkSync(p);
    } catch {
      // 무시
    }
  }
  // authorized_clients/ 안의 옛 .auth 파일도 모두 제거 — 다음 startTor 가 새 priv 로 다시 박는다.
  const ac = path.join(HS_DIR, "authorized_clients");
  if (fs.existsSync(ac)) {
    try {
      for (const f of fs.readdirSync(ac)) {
        try {
          fs.unlinkSync(path.join(ac, f));
        } catch {
          // 무시
        }
      }
    } catch {
      // 무시
    }
  }
  // DataDirectory 의 HS descriptor 캐시도 청소 — keys 새로 받았는데 옛 캐시 흔적이 남아 있으면
  // tor 가 옛 descriptor 를 publish 시도할 수 있다. 안전하게 디렉토리 통째로 비운다.
  if (fs.existsSync(DATA_DIR)) {
    try {
      fs.rmSync(DATA_DIR, { recursive: true, force: true });
    } catch {
      // 무시
    }
  }

  // 3) 같은 옵션으로 재시작. ensureDirs 가 디렉토리 재생성, ensureClientAuthKeypair 가
  //    새 keypair 생성, Tor 가 새 hs_ed25519_* 자동 생성.
  return startTor(lastTorOptions);
}

/**
 * 외부 (Mac 앱의 NWPathMonitor) 가 primary IPv4 변경을 감지했을 때 호출.
 * 살아 있는 Tor 에 SIGHUP 을 보내 torrc reload + introduction point 재선정 +
 * descriptor 재publish 를 강제한다. Tor 자체 timeout 기반 회복 (1~5분) 을 5~10s 로
 * 압축하는 게 목표.
 *
 * 가드:
 *  - bootstrap 100% 도달 전 호출은 무시 — SIGHUP 이 부팅 중 단계와 충돌할 수 있고,
 *    어차피 부팅 끝나면 첫 회로가 새로 빌드되므로 의미 없음.
 *  - 30s 쿨다운 — path 이벤트가 연달아 발화해도 회로 폭주 없음.
 *  - 살아있는 child 가 없으면 noop.
 *
 * SIGHUP vs ControlPort + NEWNYM 선택: 지금은 SIGHUP 한 줄. ControlPort 를 열려면
 * CookieAuthentication 설정 + Node 측 control protocol 클라이언트 추가가 필요한데
 * 실용적으로 SIGHUP 만으로도 동일 효과 (torrc reload 가 hidden service 회로 재평가를
 * 트리거). 부족하면 그때 ControlPort 도입.
 *
 * @returns "kicked" | "cooldown" | "not-bootstrapped" | "no-process" — 진단용.
 */
export function kickTorReconnect(): "kicked" | "cooldown" | "not-bootstrapped" | "no-process" {
  const proc = activeTorProcess;
  if (!proc || proc.killed) return "no-process";
  if (!torBootstrapped) return "not-bootstrapped";

  const now = Date.now();
  if (now - lastKickAt < 30_000) return "cooldown";
  lastKickAt = now;

  try {
    proc.kill("SIGHUP");
    log.info("kicked tor with SIGHUP (IP change detected)", {
      "event.action": "tor.kick",
    });
    return "kicked";
  } catch (e) {
    log.warn("SIGHUP to tor failed", {
      "event.action": "tor.kick.fail",
      "error.message": (e as Error).message,
    });
    return "no-process";
  }
}

export function getStoredOnionAddress(): string | null {
  try {
    if (!fs.existsSync(HOSTNAME_FILE)) return null;
    const c = fs.readFileSync(HOSTNAME_FILE, "utf8").trim();
    return c.endsWith(".onion") ? c : null;
  } catch {
    return null;
  }
}

/**
 * 저장된 client auth priv (base32). 페어링 CLI 가 사용.
 * 키가 아직 없으면 null — 한 번이라도 daemon 을 띄웠어야 생성됨.
 */
export function getStoredClientAuthPriv(): string | null {
  try {
    const jwkFile = path.join(TOR_DIR, "client_auth.jwk");
    if (!fs.existsSync(jwkFile)) return null;
    const keys = ensureClientAuthKeypair(TOR_DIR);
    return keys.privB32;
  } catch {
    return null;
  }
}
