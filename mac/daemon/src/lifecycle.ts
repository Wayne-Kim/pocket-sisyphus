// 부모 프로세스 watchdog.
//
// macOS 에는 Linux 의 PR_SET_PDEATHSIG 같은 "부모 죽으면 자식도 같이 죽음" 시스템 콜이
// 없다. 대신 부모(Mac 앱) 가 죽었는지 자식(daemon) 이 주기적으로 감지해 self-SIGTERM 한다.
// 이게 없으면 Mac 앱 강제 종료 / 크래시 / 디버그 세션 중단 시 daemon 이 orphan 되어
// 7777/7778 포트를 계속 잡아 다음 Mac 앱 부팅이 EADDRINUSE 로 실패한다.
//
// 1차 신호 — **ppid reparent**: 부모가 죽으면 OS 가 우리를 launchd(PID 1) 로 reparent
// 한다. 부팅 시 ppid 를 기억해 두고 그게 바뀌거나 1 이 되면 부모가 죽은 것 — 이 신호는
// PID 재사용에 면역이라 가장 신뢰도가 높다.
//
// 2차 신호 — env 로 받은 부모 PID 의 `kill(pid, 0)` ESRCH: 보조. 단, macOS 는 PID 를
// 재사용하므로 죽은 부모의 PID 를 무관한 새 프로세스가 차지하면 kill -0 가 계속 성공해
// 영원히 살아남는다(실측: orphan daemon 56분 생존). 그래서 이건 단독으로 못 믿고 1차 신호의
// 백업으로만 쓴다.

import { makeLogger } from "./logging/log.js";

const log = makeLogger("lifecycle");

export function startParentWatchdog(): void {
  const raw = process.env.POCKET_CLAUDE_PARENT_PID;
  if (!raw) return; // 부모 PID 안 받았으면 standalone 실행 — watchdog 비활성.

  const parentPid = parseInt(raw, 10);
  if (!Number.isFinite(parentPid) || parentPid <= 1) {
    log.warn("invalid parent pid env — watchdog disabled", {
      "event.action": "lifecycle.watchdog.invalid_env",
      "env.value": raw,
    });
    return;
  }

  // 부팅 시점의 ppid 를 기준선으로. Mac 앱이 단일 프로세스(`node --import tsx`)로 우리를
  // spawn 하므로 이 값은 보통 parentPid 와 같다. 부모가 죽으면 OS reparent 로 바뀐다.
  const bootPpid = process.ppid;

  log.info("watching parent pid", {
    "event.action": "lifecycle.watchdog.start",
    "parent.pid": parentPid,
    "lifecycle.boot_ppid": bootPpid,
  });

  let fired = false;
  const selfTerminate = (
    reason: string,
    fields: Record<string, unknown>,
  ): void => {
    if (fired) return;
    fired = true;
    clearInterval(interval);
    log.error("parent gone — self SIGTERM", {
      "event.action": "lifecycle.parent.gone",
      "lifecycle.reason": reason,
      ...fields,
    });
    // 직접 process.exit 보다 SIGTERM 으로 보내야 server.ts 의 shutdown 핸들러가
    // sshd / Tor child 까지 깨끗하게 정리한다.
    process.kill(process.pid, "SIGTERM");
  };

  // 2초 간격이면 reparent 감지 후 ≤2s 안에 self-kill. 더 짧게는 CPU 낭비.
  const interval = setInterval(() => {
    // 1차: reparent 감지 (PID 재사용 면역). ppid 가 기준선에서 바뀌거나 1 이면 부모 죽음.
    const ppid = process.ppid;
    if (ppid !== bootPpid || ppid <= 1) {
      selfTerminate("reparented", {
        "lifecycle.boot_ppid": bootPpid,
        "lifecycle.current_ppid": ppid,
      });
      return;
    }
    // 2차: env 부모 PID 존재 검사. ESRCH = 부모 죽음. EPERM = 권한 없지만 살아있음 — 무시.
    try {
      process.kill(parentPid, 0);
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code === "ESRCH") {
        selfTerminate("env-parent-gone", { "parent.pid": parentPid });
      }
    }
  }, 2000);
  // interval 이 살아있어도 SIGTERM 핸들러가 process.exit 호출하므로 unref 불필요.
}
