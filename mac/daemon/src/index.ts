import { start } from "./server.js";
import { startParentWatchdog } from "./lifecycle.js";
import { bridgeConsoleToUnifiedLog, makeLogger } from "./logging/log.js";
import { installCrashHandlers } from "./logging/crash.js";

// 첫 줄 — 이후 console.* 가 unified.log 로 함께 흐르게.
bridgeConsoleToUnifiedLog();

// 엔트리포인트 최상단 — uncaughtException·unhandledRejection 을 잡아 풀스택+컨텍스트를
// unified.log 에 fatal 로 기록하고 crash 마커를 남긴 뒤 비정상 종료(crash-only). 무리한
// in-process 복구는 하지 않는다 — 부모 워치독(아래)이 orphan 정리를 하므로 재기동은 기존
// 라이프사이클(Mac 앱 → daemon spawn)에 위임. 외부 텔레메트리 0(LAN 전용·무텔레메트리 원칙).
installCrashHandlers();

// Mac 앱이 spawn 했다면 그 PID 를 추적 — 부모 죽으면 우리도 죽는다 (orphan 방지).
startParentWatchdog();

const log = makeLogger("daemon");

// 크래시 핸들러 «재현/검증» 플래그 — 의도적 uncaughtException 으로 핸들러 경로를 탄다.
// start() 전에 던져 tor/ssh 부팅 없이 핸들러만 검증한다(setImmediate 로 uncaughtException 화).
// 평소 운영 경로엔 이 env 가 없어 동작 동일.
if (process.env.POCKET_SISYPHUS_CRASH_TEST === "1") {
  log.warn("crash-test flag set — throwing intentional uncaughtException", {
    "event.action": "daemon.crash.test",
  });
  setImmediate(() => {
    throw new Error(
      "intentional uncaughtException for crash-handler verification (POCKET_SISYPHUS_CRASH_TEST=1)",
    );
  });
} else {
  start().catch((e) => {
    log.fatal("daemon start failed", {
      "event.action": "daemon.start.fail",
      "error.message": e instanceof Error ? e.message : String(e),
      "error.stack": e instanceof Error ? e.stack : undefined,
    });
    console.error("[fatal]", e);
    process.exit(1);
  });
}
