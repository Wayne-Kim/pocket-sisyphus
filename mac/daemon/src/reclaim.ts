// 이전 daemon 인스턴스의 잔여(orphan) 프로세스 회수.
//
// Mac 앱이 daemon 을 SIGKILL 하거나(DaemonManager.terminateSynchronously 의 6s 타임아웃),
// 크래시·강제 종료·디버그 세션 중단으로 watchdog 이 늦게 발동하면 daemon(node) 이 orphan
// (PPID=1) 으로 살아남아 7777/7778 을 계속 LISTEN 한다 → 다음 daemon 부팅의 serve() 가
// EADDRINUSE 로 실패한다. (실측: orphan daemon 이 PID 재사용으로 watchdog 을 통과해 56분간
// 7777 점유 → 새 Mac 앱이 데몬을 못 띄움.)
//
// sshd(22022) 는 ssh/server.ts 의 reclaimSshPort 가, tor 는 tor/sidecar.ts 의
// reclaimStaleTor + cleanupStaleLock 이 각자 처리. 여기선 «daemon HTTP 포트를 잡은 우리
// node» 만 회수한다. orphan node 가 죽으면 그 자식(tor/sshd) 은 PPID=1 로 reparent 되지만
// 각 모듈의 marker 기반 reclaim 이 마저 정리하므로 여기서 자식까지 건드리지 않는다
// (PID 로 자식을 죽이면 그 사이 PID 재사용으로 무관 프로세스를 죽일 위험이 있어 회피).
//
// 안전장치: 포트를 잡은 프로세스의 커맨드라인이 «우리 daemon entry(src/index.ts 절대경로)»
// 를 포함할 때만 종료. 시스템 프로세스·무관한 node 는 절대 안 건드림. 자기 자신도 제외.

import { execFileSync } from "node:child_process";
import { makeLogger } from "./logging/log.js";

const log = makeLogger("lifecycle");

/**
 * cmd 가 «우리 daemon» 인지 — daemon entry(src/index.ts 절대경로) 를 인자로 들고 있는지.
 * export 해서 단위 테스트로 죽일 것/안 죽일 것을 고정한다.
 */
export function isOurDaemonCommand(cmd: string, daemonEntryPath: string): boolean {
  if (!daemonEntryPath) return false;
  return cmd.includes(daemonEntryPath);
}

/** PID 의 커맨드라인 (ps -o command=). 조회 실패면 null. */
function pidCommand(pid: number): string | null {
  try {
    return execFileSync("/bin/ps", ["-o", "command=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 2000,
    }).trim();
  } catch {
    return null;
  }
}

/** 포트를 LISTEN 중인 PID 목록. lsof 부재(127)·listener 없음(1)이면 빈 배열. */
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
      if (e?.status === 1) return []; // listener 없음 (정상)
    }
  }
  return [];
}

/**
 * `ports` 를 잡고 있는 «우리 stale daemon» 을 종료해 포트를 회수한다. 새 serve() 가 bind
 * 하기 전에 호출. 자기 자신·무관 프로세스는 절대 안 건드림. 동기(blocking) — 부팅 경로에서
 * 한 번, lsof+ps 몇 번이라 비용 무시 가능.
 */
export function reclaimStaleDaemon(ports: number[]): void {
  const selfEntry = process.argv[1] ?? ""; // .../src/index.ts
  if (!selfEntry) return;
  const killed = new Set<number>();
  for (const port of ports) {
    for (const pid of listenerPidsOnPort(port)) {
      if (pid === process.pid || killed.has(pid)) continue;
      const cmd = pidCommand(pid);
      if (!cmd || !isOurDaemonCommand(cmd, selfEntry)) continue;
      try {
        process.kill(pid, "SIGKILL");
        killed.add(pid);
        log.warn("reclaimed stale daemon holding port", {
          "event.action": "lifecycle.reclaim.daemon",
          "process.pid": pid,
          "network.port": port,
        });
        console.log(`[lifecycle] reclaimed stale daemon pid=${pid} (port ${port})`);
      } catch {
        /* 이미 죽음 / 권한 없음 */
      }
    }
  }
}
