import { start } from "./server.js";
import { startParentWatchdog } from "./lifecycle.js";
import { bridgeConsoleToUnifiedLog, makeLogger } from "./logging/log.js";

// 첫 줄 — 이후 console.* 가 unified.log 로 함께 흐르게.
bridgeConsoleToUnifiedLog();

// Mac 앱이 spawn 했다면 그 PID 를 추적 — 부모 죽으면 우리도 죽는다 (orphan 방지).
startParentWatchdog();

const log = makeLogger("daemon");
start().catch((e) => {
  log.fatal("daemon start failed", {
    "event.action": "daemon.start.fail",
    "error.message": e instanceof Error ? e.message : String(e),
    "error.stack": e instanceof Error ? e.stack : undefined,
  });
  console.error("[fatal]", e);
  process.exit(1);
});
