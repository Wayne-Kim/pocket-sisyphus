// 임베디드 OpenSSH portable sshd 라이프사이클 관리.
//
// daemon 부팅 시 sshd_config 를 동적으로 생성하고 sshd binary 를 child process 로 spawn.
// daemon 종료 시 SIGTERM 으로 정리.
//
// 외부 노출 모델:
//  - 직접 listen: 0.0.0.0:<port> + [::]:<port>. UPnP/PMP 자동 매핑 + IPv6 firewall passthrough.
//  - Tor onion: torrc 의 `HiddenServicePort 22 127.0.0.1:<port>` 로 같은 sshd 에 도달.
//
// 보안 경계:
//  - Pubkey only (PasswordAuthentication no). authorized_keys 는 페어링마다 한 줄.
//  - direct-tcpip forwarding 의 목적지는 `PermitOpen 127.0.0.1:<daemonPort>` 로 화이트.
//  - session channel (exec/shell) 은 `ForceCommand /bin/false` 로 즉시 종료.
//  - PTY 거부, agent/X11 forwarding 거부, sftp 거부.
//
// 사용자명: macOS 현재 user 그대로 사용 (`os.userInfo().username`). sshd 는 시스템 사용자
// 데이터베이스에서 검증하므로 별도 user 추가 불필요. endpoint 응답에 그대로 전달.

import { spawn, execFileSync, ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { ensureConfigDir, CONFIG_DIR } from "../config.js";
import { makeLogger } from "../logging/log.js";
import {
  ensureHostKey,
  HOST_KEY_FILE,
  AUTHORIZED_KEYS_FILE,
  HostKeyInfo,
} from "./keys.js";

/** sshd 가 listen 할 포트. 22 회피 — 시스템 sshd 와 충돌 방지 + 기본 fail2ban scan 대상 분리. */
export const SSH_PORT = 22022;

/** sshd_config 동적 생성 경로. CONFIG_DIR/ssh/sshd_config. */
const SSHD_CONFIG_FILE = path.join(CONFIG_DIR, "ssh", "sshd_config");

/** sshd PID 파일 — 외부 진단 + 다음 부팅 시 stale 정리. */
const SSHD_PID_FILE = path.join(CONFIG_DIR, "ssh", "sshd.pid");

/** Mac 앱이 spawn 할 땐 POCKET_CLAUDE_SSHD_BIN 으로 .app 안 sshd 경로 전달. */
const SSHD_BIN_ENV = "POCKET_CLAUDE_SSHD_BIN";

/** dev / 시스템 sshd fallback (Homebrew openssh). 배포 환경에선 안 쓰이지만 dev 편의. */
const SSHD_BIN_FALLBACK_CANDIDATES = [
  "/opt/homebrew/sbin/sshd",
  "/opt/homebrew/opt/openssh/sbin/sshd",
  "/usr/sbin/sshd",
];

export type SshHandle = {
  port: number;
  hostKey: HostKeyInfo;
  sshUser: string;
  /** 라이프사이클 정리. daemon shutdown 에서 호출. */
  stop: () => Promise<void>;
};

export type SshStartOptions = {
  /** daemon HTTP/WS 의 메인 listen 포트. SSH direct-tcpip forwarding 목적지 화이트. */
  daemonPort: number;
  /**
   * 라이브 프리뷰 리버스 프록시의 «고정» 포트 (preview_proxy_v1). direct-tcpip 화이트리스트에
   * daemon 포트와 «함께» 넣는다 — iOS 가 기존 SSH 세션 위에 이 포트로 forward 를 하나 더 열어
   * dev 서버를 본다. 실제 dev 포트는 PermitOpen 에 «안» 들어가고(기본 차단 유지), 프록시가
   * 등록부(preview/registry)로 «사용자가 등록한 포트만» forward 한다. 미지정이면 프리뷰 비활성.
   */
  previewProxyPort?: number;
  /** sshd 가 listen 할 포트. 미지정이면 기본 22022. 환경에 따라 22022 가 다른 프로그램에
   *  점유될 수 있어 사용자가 config.sshPort 로 바꿀 수 있다. 데몬 포트와 달리 외부 노출
   *  채널(UPnP/Tor onion 22)이 이 값을 가리켜야 하므로 임의 fallback 은 하지 않는다 —
   *  점유 시 reclaim(우리 것) 후에도 막히면 명확한 에러로 caller 가 진단. */
  sshPort?: number;
};

let activeProcess: ChildProcess | null = null;

/**
 * 임베디드 sshd child 가 살아 있는지 — 진단 스냅샷(/api/diagnostics)용. exit 시 activeProcess
 * 가 null 로 비워지고, 자동 재시작 backoff 창 동안에도 null 이라 «listener 없음» 을 정직하게
 * 노출한다(재시작 중이면 곧 다시 true). spawn 직후 동기적으로 set 되므로 「떠 있음」 의 근사.
 */
export function isSshProcessAlive(): boolean {
  return activeProcess !== null && !activeProcess.killed;
}

// === sshd 자동 재시작 슈퍼바이저 (tor sidecar 와 대칭) ===
//
// 배경: sleep/wake 사이클이나 macOS 자체의 자원 회수로 «daemon(node) 은 멀쩡히 살아있는데
// sshd child 만» SIGTERM/SIGKILL 당하는 경우가 실측됨 (tor 에서 먼저 관찰 — tor/sidecar.ts 의
// intentionalShutdown 주석 참조). 그 경우 daemon 은 sshd 가 죽은 줄도 모른 채 계속 떠 있어
// 메뉴바·endpoint 는 정상으로 보이지만, 22022 listener 가 사라져 iOS 의 직접 SSH(22022)도,
// onion virtual-port 22 → 22022 fallback 도 전부 «connection refused» 가 된다 — 사용자에겐
// 「맥은 멀쩡한데 폰만 하루 종일 연결 안 됨」 으로 보인다. tor 와 동일한 패턴으로, child 가
// 의도치 않게 죽으면 backoff 를 두고 재spawn 해 22022 를 자가 복구한다.

/** 의도된 종료 플래그. `handle.stop()` / daemon shutdown 이 SIGTERM 직전 true 로 셋하면
 *  exit 핸들러는 자동 재시작을 건너뛴다. startSsh 진입 시 false 로 reset. */
let intentionalShutdown = false;

/** 마지막 시작 옵션 — 자동 재시작이 같은 daemonPort 로 재spawn 할 때 참조. */
let lastStartOptions: SshStartOptions | null = null;

/** 최소 한 번 listen 에 성공했는지. 최초 부팅 bind 실패는 종전대로 throw 진단만 하고
 *  자동 재시작은 «한 번 떠본 뒤 죽은» 경우에만 — 첫 부팅의 stale-sshd 진단 의미를 보존. */
let everListened = false;

/** 자동 재시작 backoff (ms). 연속 실패 시 1s→2s→4s… 최대 30s exponential. 성공 시 1s reset. */
let restartBackoffMs = 1000;
const MIN_RESTART_BACKOFF_MS = 1000;
const MAX_RESTART_BACKOFF_MS = 30_000;
let pendingRestartTimer: NodeJS.Timeout | null = null;

/**
 * sshd 를 부팅한다. host key + authorized_keys + sshd_config 준비 후 spawn.
 * 멱등성 없음 — 이미 떠 있으면 throw. 호출자가 단일 lifecycle.
 *
 * 반환된 핸들은 한 번만 만들어지지만 stop() 은 module-level `activeProcess` 를 보므로
 * 자동 재시작으로 child 가 갈려도 늘 «현재 child» 를 종료한다. hostKey/sshUser 는 재시작
 * 간 불변이라 최초 값으로 고정해도 안전.
 */
export async function startSsh(opts: SshStartOptions): Promise<SshHandle> {
  if (activeProcess) {
    throw new Error("sshd already running");
  }
  // 새 시작 — 직전 회차의 보류 재시작 / shutdown 플래그 / backoff 전부 reset.
  intentionalShutdown = false;
  restartBackoffMs = MIN_RESTART_BACKOFF_MS;
  if (pendingRestartTimer) {
    clearTimeout(pendingRestartTimer);
    pendingRestartTimer = null;
  }
  lastStartOptions = opts;

  const { hostKey, sshUser, sshPort } = await launchSshd(opts);

  return {
    port: sshPort,
    hostKey,
    sshUser,
    stop: async () => {
      // 의도된 종료 — exit 핸들러가 자동 재시작을 건너뛰게 먼저 플래그를 박고 보류 타이머 취소.
      intentionalShutdown = true;
      if (pendingRestartTimer) {
        clearTimeout(pendingRestartTimer);
        pendingRestartTimer = null;
      }
      if (!activeProcess) return;
      const c = activeProcess;
      activeProcess = null;
      c.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          c.kill("SIGKILL");
          resolve();
        }, 3000);
        c.on("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}

/**
 * sshd child 하나를 띄운다 — reclaim → host key/authorized_keys → config → spawn →
 * exit 핸들러(자동 재시작) 부착 → ready 대기. 최초 `startSsh` 와 자동 재시작 타이머가 공유.
 * 반환: 핸들 구성을 위한 hostKey + sshUser (재시작 간 불변이지만 매번 로드해 일관성 유지).
 * 실패(주로 bind 실패) 시 throw — 최초 호출은 caller 가 진단, 재시작은 backoff 로 재시도.
 */
async function launchSshd(
  opts: SshStartOptions,
): Promise<{ hostKey: HostKeyInfo; sshUser: string; sshPort: number }> {
  const sshPort = opts.sshPort ?? SSH_PORT;
  ensureConfigDir();
  fs.mkdirSync(path.dirname(SSHD_CONFIG_FILE), { recursive: true, mode: 0o700 });

  // Stale sshd 회수 — 이전 daemon 인스턴스가 비정상 종료(크래시/force-quit)되면 그 sshd 가
  // orphan 으로 살아남아 SSH_PORT 를 계속 잡는다. 그 상태로 부팅하면 (1) 새 sshd 가 bind 못
  // 하고 즉시 죽고, (2) 옛 sshd 가 «옛 host key» 로 서빙을 계속한다. 옛 host key pinning 이
  // 도입되기 전(acceptAnything)엔 무해했지만, iOS 가 페어링 QR 의 현재 host key 를 strict pin
  // 하면서부터는 옛 sshd 가 제시하는 키와 핀이 불일치 → 연결이 전부 거부된다.
  // 따라서 새 sshd 를 띄우기 전에 «우리 sshd» 만 골라 죽여 포트를 확실히 회수한다.
  reclaimSshPort(sshPort);
  await waitForPortFree(sshPort, 2000);

  const hostKey = ensureHostKey();
  ensureAuthorizedKeysFile();
  const sshUser = os.userInfo().username;
  const bin = resolveSshdBinary();
  writeSshdConfig({
    port: sshPort,
    daemonPort: opts.daemonPort,
    previewProxyPort: opts.previewProxyPort,
    sshUser,
    sshdBin: bin,
  });

  // -f: config 경로
  // -D: daemonize 안 함 (우리가 child 로 관리)
  // -e: 로그를 stderr 로
  const child = spawn(bin, ["-f", SSHD_CONFIG_FILE, "-D", "-e"], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });

  activeProcess = child;

  // sshd subprocess 출력을 unified.log 의 sshd 채널로 라인 단위 emit.
  // 원본 stdout/stderr 도 유지 — Xcode console / DEBUG mirror 가 함께 본다.
  // 라인 buffer: chunk 경계가 라인 경계와 다를 수 있어 누적 후 \n 단위 분할.
  const sshdLog = makeLogger("sshd");
  let stdoutBuf = "";
  let stderrBuf = "";
  child.stdout?.on("data", (chunk) => {
    const s = chunk.toString();
    process.stdout.write(`[sshd] ${s}`);
    stdoutBuf += s;
    let nl;
    while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
      const line = stdoutBuf.slice(0, nl).trimEnd();
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (line) sshdLog.info(line);
    }
  });
  child.stderr?.on("data", (chunk) => {
    const s = chunk.toString();
    process.stderr.write(`[sshd] ${s}`);
    stderrBuf += s;
    let nl;
    while ((nl = stderrBuf.indexOf("\n")) !== -1) {
      const line = stderrBuf.slice(0, nl).trimEnd();
      stderrBuf = stderrBuf.slice(nl + 1);
      if (line) sshdLog.warn(line);
    }
  });

  // 우리가 spawn 한 child 가 죽었는지 추적. waitForSshdReady 는 «포트가 열렸는지» 만 보므로,
  // 회수에 실패해 옛 sshd 가 포트를 계속 잡고 있으면 probe 가 (옛 sshd 때문에) 성공해버려
  // 우리 child 의 bind 실패를 못 잡는다 → child.exit 를 별도로 봐서 진짜 성공만 통과시킨다.
  let childExited = false;
  child.on("exit", (code, signal) => {
    childExited = true;
    if (activeProcess === child) activeProcess = null;
    if (code !== 0) {
      sshdLog.error("sshd exited abnormally", {
        "event.action": "sshd.exit",
        "process.exit_code": code,
        signal,
      });
      console.error(`[sshd] exited code=${code} signal=${signal}`);
    } else {
      sshdLog.info("sshd exited cleanly", { "event.action": "sshd.exit" });
      console.log("[sshd] exited cleanly");
    }
    // sshd 가 SIGTERM 을 받으면 «clean exit(code 0)» 으로 끝나므로 exit code 로는 «의도된
    // 종료» 와 «외부에서 죽임» 을 구분할 수 없다. intentionalShutdown 플래그로만 분기.
    scheduleSshdRestartIfNeeded(code, signal);
  });

  // sshd 가 listen 시작했는지 대충 확인 — sshd 자체는 ready 신호 안 줘서 sleep + port probe.
  await waitForSshdReady(sshPort, 3000);

  // child 가 죽었으면 (대개 "Address already in use" — 회수 못 한 유령 sshd 가 포트 점유,
  // 또는 무관한 프로그램이 이 SSH 포트를 점유) 성공으로 위장하지 않는다. 이대로 진행하면 옛
  // sshd 가 옛 host key 로 서빙해 iOS strict pin 이 전부 불일치한다. throw → caller(server.ts)가
  // sshHandle=undefined 로 두고 진단 로그. (데몬 포트와 달리 SSH 포트는 외부 노출 채널이 가리켜야
  // 해 임의 폴백 대신 명확한 실패 — 사용자가 「포트 설정」 에서 다른 SSH 포트로 바꾸도록 유도.)
  if (childExited) {
    throw new Error(
      `sshd failed to bind ${sshPort} — 포트 점유 중(우리 stale sshd 회수 실패 또는 다른 프로그램). 「포트 설정」 에서 다른 SSH 포트로 변경 가능`,
    );
  }

  everListened = true;
  sshdLog.info("sshd listening", {
    "event.action": "sshd.listen",
    port: sshPort,
    "user.name": sshUser,
  });
  console.log(
    `✔ sshd listening on 0.0.0.0:${sshPort} + [::]:${sshPort} (user=${sshUser})`,
  );

  return { hostKey, sshUser, sshPort };
}

/**
 * child 가 의도치 않게 죽었을 때 backoff 를 두고 sshd 를 재spawn 예약한다. tor sidecar 의
 * 자동 재시작과 같은 형태. 게이트:
 *  - intentionalShutdown → handle.stop() / daemon shutdown. 재시작 안 함.
 *  - !everListened → 최초 부팅 bind 실패. 종전대로 throw 진단만, 자동 재시작 안 함.
 *  - lastStartOptions 없음 → 한 번도 startSsh 안 됨. 불가.
 *  - pendingRestartTimer 있음 → 이미 예약됨. 중복 방지.
 *  - activeProcess 있음 → 이미 새 child 가 떠 있음. 방어.
 */
function scheduleSshdRestartIfNeeded(
  code: number | null,
  signal: NodeJS.Signals | null,
): void {
  const sshdLog = makeLogger("sshd");
  if (intentionalShutdown) return;
  if (!everListened) return;
  if (!lastStartOptions) return;
  if (pendingRestartTimer) return;
  if (activeProcess) return;

  const delay = restartBackoffMs;
  sshdLog.warn("unexpected sshd exit — scheduling auto-restart", {
    "event.action": "sshd.restart.schedule",
    "process.exit_code": code,
    signal,
    "sshd.restart.delay_ms": delay,
  });
  console.warn(
    `[sshd] unexpected exit (code=${code} signal=${signal}) — auto-restart in ${delay}ms`,
  );
  pendingRestartTimer = setTimeout(() => {
    pendingRestartTimer = null;
    if (intentionalShutdown) return; // 그 사이 종료 신호 왔으면 중단
    const opts = lastStartOptions;
    if (!opts) return;
    // 다음 시도까지의 backoff 미리 증가 — launchSshd 성공 시 MIN 으로 reset.
    restartBackoffMs = Math.min(restartBackoffMs * 2, MAX_RESTART_BACKOFF_MS);
    launchSshd(opts)
      .then(() => {
        restartBackoffMs = MIN_RESTART_BACKOFF_MS;
        sshdLog.info("sshd auto-restarted", {
          "event.action": "sshd.restart.ok",
        });
        console.log("[sshd] auto-restarted — listening again");
      })
      .catch((e) => {
        sshdLog.warn("sshd auto-restart failed", {
          "event.action": "sshd.restart.fail",
          "error.message": (e as Error).message,
        });
        // bind 실패(childExited)면 그 child 의 exit 핸들러가 이미 다음 회차를 예약했을 수
        // 있으나, spawn 전 단계에서 throw 한 경우엔 예약이 없다 → 명시적으로 한 번 더 시도
        // (이미 예약돼 있으면 pendingRestartTimer guard 가 흡수). backoff 는 위에서 이미 증가.
        scheduleSshdRestartIfNeeded(null, null);
      });
  }, delay);
}

function resolveSshdBinary(): string {
  const fromEnv = process.env[SSHD_BIN_ENV];
  if (fromEnv && fs.existsSync(fromEnv)) {
    return fromEnv;
  }
  for (const candidate of SSHD_BIN_FALLBACK_CANDIDATES) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    `sshd binary not found. Set ${SSHD_BIN_ENV} or install via Homebrew.`,
  );
}

/**
 * sshd_config 동적 생성. 화이트리스트 엄격 — direct-tcpip forwarding 만 허용,
 * session channel 의 exec/shell 은 ForceCommand 로 차단, sftp/agent/X11 모두 거부.
 */
function writeSshdConfig(args: {
  port: number;
  daemonPort: number;
  previewProxyPort?: number;
  sshUser: string;
  sshdBin: string;
}): void {
  // direct-tcpip 목적지 화이트리스트 — daemon HTTP/WS 포트 + (프리뷰 활성 시) 프리뷰 프록시
  // «고정» 포트. 둘 다 daemon 소유 고정 포트라 정적으로 안전하게 열 수 있다. 실제 dev 포트는
  // 여기 «안» 들어가고 프록시 등록부가 사용자 등록 포트만 통과시킨다(기본 차단 유지).
  const permitTargets = [`127.0.0.1:${args.daemonPort}`];
  if (args.previewProxyPort) {
    permitTargets.push(`127.0.0.1:${args.previewProxyPort}`);
  }

  // OpenSSH 9.8+ 분리 모델 — sshd(listener) 가 연결마다 sshd-session 을, 인증 단계에선
  // sshd-auth 를 re-exec 한다. 그 경로는 sshd 바이너리에 «컴파일타임 절대경로»(Homebrew
  // Cellar 의 libexec) 로 박혀 있어, 그 Cellar 가 없는 Mac(= 우리 .app 만 설치한 사용자)에선
  // sshd 가 헬퍼를 못 찾아 exit 255 로 즉사 → SSH listener 가 안 떠 페어링/연결 전부 불가.
  // embed-daemon-binaries.sh 가 두 헬퍼를 sshd 와 같은 디렉토리에 번들하므로, 옆에 있으면
  // 그 경로로 명시 override. (dev 의 시스템/Homebrew sshd fallback 은 헬퍼가 옆에 없으니
  // 컴파일타임 경로 — 즉 Cellar — 를 그대로 쓰게 둔다.)
  const binDir = path.dirname(args.sshdBin);
  const sessionBin = path.join(binDir, "sshd-session");
  const authBin = path.join(binDir, "sshd-auth");
  const helperLines: string[] = [];
  if (fs.existsSync(sessionBin)) {
    helperLines.push(`SshdSessionPath "${sessionBin}"`);
  }
  if (fs.existsSync(authBin)) {
    helperLines.push(`SshdAuthPath "${authBin}"`);
  }
  const helperBlock = helperLines.length
    ? `\n# OpenSSH 9.8+ re-exec 헬퍼 — .app 안 번들 경로로 고정 (Homebrew 미설치 Mac 대응).\n${helperLines.join("\n")}\n`
    : "";

  const body = `# Auto-generated by pocket-sisyphus daemon — do not edit.
# 임베디드 sshd 화이트리스트 — direct-tcpip 만 허용, 나머지 채널/명령 차단.

Port ${args.port}
ListenAddress 0.0.0.0
ListenAddress ::
${helperBlock}

# PidFile — 기본값 /var/run/sshd.pid 는 user 권한 부족으로 쓰기 실패 (무해하지만 경고 노이즈).
# user 권한 디렉토리로 override.
PidFile "${SSHD_PID_FILE}"

# 자체 host key. 영구. fingerprint 는 페어링 QR 에 박힘.
# macOS 의 "Application Support" 디렉토리는 공백 포함 — sshd_config 는 따옴표 wrap 강제.
HostKey "${HOST_KEY_FILE}"

# 인증
PasswordAuthentication no
ChallengeResponseAuthentication no
KbdInteractiveAuthentication no
PermitEmptyPasswords no
PermitRootLogin no
PubkeyAuthentication yes
AuthenticationMethods publickey
AuthorizedKeysFile "${AUTHORIZED_KEYS_FILE}"

# Pocket Sisyphus 가 만든 사용자명만 허용.
AllowUsers ${args.sshUser}

# 채널 화이트리스트:
#  - direct-tcpip 허용, 목적지는 daemon HTTP/WS 포트(+프리뷰 프록시 고정 포트)만.
#  - session channel 의 exec/shell 은 ForceCommand /bin/false 로 즉시 종료.
#  - PTY 거부, agent/X11 forwarding 거부, sftp 거부.
AllowTcpForwarding local
GatewayPorts no
PermitOpen ${permitTargets.join(" ")}
AllowAgentForwarding no
X11Forwarding no
PermitTTY no
PermitTunnel no
ForceCommand /bin/false

# sftp 등 subsystem 일체 미등록 — Subsystem 라인 없음 = 거부.

# 로깅
LogLevel INFO
SyslogFacility AUTH
`;
  fs.writeFileSync(SSHD_CONFIG_FILE, body, { mode: 0o600 });
}

/** authorized_keys 파일이 없으면 빈 파일 생성. sshd 가 파일 없으면 인증 거부. */
function ensureAuthorizedKeysFile(): void {
  if (!fs.existsSync(AUTHORIZED_KEYS_FILE)) {
    fs.writeFileSync(AUTHORIZED_KEYS_FILE, "", { mode: 0o600 });
  } else {
    // perms 보정 — sshd 가 group/other readable 이면 거부.
    fs.chmodSync(AUTHORIZED_KEYS_FILE, 0o600);
  }
}

/** sshd 가 listen 시작했는지 TCP probe 로 짧게 폴링. timeout 초과는 graceful — caller 가 log 로 확인. */
async function waitForSshdReady(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probeTcp(port)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  console.warn(`[sshd] not responding on port ${port} after ${timeoutMs}ms — continuing anyway`);
}

function probeTcp(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port }, () => {
      socket.end();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
    socket.setTimeout(500, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

/** 포트가 비워질 때까지(아무도 listen 안 할 때까지) 짧게 폴링. 회수 직후 bind 안정화용. */
async function waitForPortFree(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await probeTcp(port))) return;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * SSH 포트(`port`, 기본 22022) 를 잡고 있는 «우리 sshd» 를 종료해 포트를 회수한다.
 *
 * 두 단계로 잡는다:
 *  1) PID 파일에 기록된 옛 sshd — 정상 재시작/크래시 후 잔존 (sshd 가 PidFile 에 자기 PID 기록).
 *  2) PID 파일을 잃은 유령 — 예: dev/Debug 빌드 잔존, force-quit 된 옛 daemon 의 orphan.
 *     포트 listener PID 를 lsof 로 찾아 «우리 sshd» 만 골라 종료.
 *
 * 안전장치: 커맨드라인에 «우리 sshd_config 경로» 가 박힌 프로세스만 죽인다. 시스템 sshd(22)나
 * 무관한 프로세스는 절대 건드리지 않는다 (포트가 바뀌어도 식별은 sshd_config 경로로 하므로 안전).
 */
function reclaimSshPort(port: number = SSH_PORT): void {
  const log = makeLogger("sshd");

  // 1) PID 파일 경로.
  try {
    const raw = fs.readFileSync(SSHD_PID_FILE, "utf8").trim();
    const pid = Number.parseInt(raw, 10);
    if (Number.isFinite(pid) && pid > 1) killIfOurSshd(pid, log);
  } catch {
    /* PID 파일 없음 — 정상 */
  }
  try {
    fs.unlinkSync(SSHD_PID_FILE);
  } catch {
    /* not exist */
  }

  // 2) lsof 로 포트 listener 회수 (PID 파일을 잃은 유령 대비).
  for (const pid of listenerPidsOnPort(port)) {
    killIfOurSshd(pid, log);
  }
}

/**
 * 어떤 프로세스 커맨드라인이 «우리 sshd_config 로 띄운 sshd» 인지 판별.
 *
 * 안전장치의 핵심 — reclaim 이 무관한 프로세스(시스템 sshd:22, 사용자의 다른 sshd 등)를 절대
 * 죽이지 않도록, sshd 프로세스이면서 «우리 sshd_config 경로» 를 인자로 들고 있는 것만 통과.
 * export 해서 단위 테스트로 못 죽일 것/죽일 것을 고정한다.
 */
export function isOurSshdCommand(cmd: string, sshdConfigFile: string): boolean {
  // sshd «실행» 토큰만 매칭 — `.../bin/sshd `, `sshd `, `sshd:`(listener/session label).
  // `.../ssh/sshd_config` 처럼 경로 안에 박힌 "sshd" 부분문자열에는 안 걸린다(뒤가 `_`).
  const invokesSshd = /(^|\s)(\S*\/)?sshd(:|\s|$)/.test(cmd);
  return invokesSshd && cmd.includes(sshdConfigFile);
}

/** PID 가 «우리 sshd_config 로 띄운 sshd» 일 때만 SIGKILL. 그 외엔 절대 안 건드림. */
function killIfOurSshd(pid: number, log: ReturnType<typeof makeLogger>): void {
  if (pid === process.pid) return;
  let cmd: string;
  try {
    cmd = execFileSync("/bin/ps", ["-o", "command=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 2000,
    }).trim();
  } catch {
    return; // 프로세스 없음 / 조회 실패 — 건드리지 않음.
  }
  if (!isOurSshdCommand(cmd, SSHD_CONFIG_FILE)) return;
  try {
    process.kill(pid, "SIGKILL");
    log.warn("reclaimed SSH port from stale sshd", {
      "event.action": "sshd.reclaim",
      "process.pid": pid,
    });
    console.log(`[sshd] reclaimed port ${SSH_PORT} from stale sshd pid=${pid}`);
  } catch {
    /* 이미 죽음 / 권한 없음 */
  }
}

/** 포트를 listen 중인 PID 목록. lsof 부재(127)·listener 없음(1)이면 빈 배열. */
function listenerPidsOnPort(port: number): number[] {
  for (const lsof of ["/usr/sbin/lsof", "/usr/bin/lsof", "lsof"]) {
    try {
      const out = execFileSync(lsof, ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], {
        encoding: "utf8",
        timeout: 2000,
      });
      return out
        .split(/\s+/)
        .map((s) => Number.parseInt(s, 10))
        .filter((n) => Number.isFinite(n) && n > 1);
    } catch (e: any) {
      // exit 1 = listener 없음 (정상) → 빈 결과. ENOENT = 이 lsof 경로 없음 → 다음 후보.
      if (e?.status === 1) return [];
    }
  }
  return [];
}
