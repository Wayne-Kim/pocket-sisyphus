import { Hono } from "hono";
import { compress } from "hono/compress";
import { serve } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import qrcodeTerminal from "qrcode-terminal";
import { sessions } from "./routes/sessions.js";
import { recent } from "./routes/recent.js";
import { git } from "./routes/git.js";
import { fsRoutes } from "./routes/fs.js";
import { claudeCodeSessions } from "./routes/claude-code-sessions.js";
import { desktopSessions } from "./routes/desktop-sessions.js";
import { admin } from "./routes/admin.js";
import { notify } from "./routes/notify.js";
import { localLlm } from "./routes/local-llm.js";
import { opencode } from "./routes/opencode.js";
import { cron } from "./routes/cron.js";
import { mcp } from "./routes/mcp.js";
import { workflows } from "./routes/workflows.js";
import { screen } from "./routes/screen.js";
import { po } from "./routes/po.js";
import { merge } from "./routes/merge.js";
import { preview } from "./routes/preview.js";
import { startPreviewProxy, type PreviewProxyHandle } from "./preview/proxy.js";
import {
  startCaptureForSession,
  stopCaptureForSession,
  setControlEnabled,
  setDisplayForSession,
  setWindowForSession,
  requestWindowList,
  setROIForSession,
  currentDisplays,
  currentWindows,
  currentWindowTarget,
  relayInput,
  captureOnClientGone,
  stopCapture,
} from "./capture/sidecar.js";
import { reconcileStaleRuns } from "./workflow/engine.js";
import { startWorktreeReaper, getWorktreeReaper } from "./workflow/reaper.js";
import {
  startWorkflowTriggerScheduler,
  getWorkflowTriggerScheduler,
} from "./workflow/triggers.js";
import { startCronScheduler, getCronScheduler } from "./cron/scheduler.js";
import { startPoScheduler, getPoScheduler } from "./po/scheduler.js";
import { startMergeQueue } from "./merge/queue.js";
import { initLocalLlmStatusBroadcast } from "./local-llm/status.js";
import { stopServer as stopLocalLlmServer } from "./local-llm/supervisor.js";
import { version } from "./routes/version.js";
import { attest } from "./routes/attest.js";
import { DAEMON_VERSION, requireClientVersion } from "./version.js";
import { verifyWsToken } from "./auth.js";
import { requireAttestation, verifyWsAttest } from "./attest.js";
import {
  registerClient,
  unregisterClient,
  attachToSession,
  setClientActive,
  replayPtyChunksSince,
  connectedClientCount,
} from "./ws/hub.js";
import {
  writePtyRaw,
  prewarmPty,
  emitSpawnFailure,
  getPtyPid,
  KS_TRACE,
} from "./agent/pty-runner.js";
import { db } from "./db/index.js";
import { getAgent, hasAgent } from "./agent/registry.js";
import { readConfig, writeConfig, CONFIG_DIR } from "./config.js";
import { generateToken, hashToken } from "./auth.js";
import {
  startTor,
  getActiveTorProcess,
  kickTorReconnect,
  type TorHandle,
} from "./tor/sidecar.js";
import { buildPairingPayload, writePairingQRPng } from "./tor/pairing.js";
import { registerBuiltinAgents } from "./agent/index.js";
import { listAgents } from "./agent/registry.js";
import { startSsh, SSH_PORT, type SshHandle } from "./ssh/server.js";
import {
  ensureHostKey,
  loadOrCreateClientKeypair,
  setAuthorizedClientExclusive,
} from "./ssh/keys.js";
import { endpointRoute } from "./routes/endpoint.js";
import {
  tryMapSSHPort,
  tryUnmapSSHPort,
  type PortMappingResult,
} from "./nat/port-mapping.js";
import { getExternalIPv4, startWanIPv4Watcher } from "./nat/external-ip.js";
import { reclaimStaleDaemon } from "./reclaim.js";
import { findAvailablePort } from "./ports.js";
import { makeLogger } from "./logging/log.js";

/** Tor onion 으로만 노출되는 endpoint-only HTTP listener 포트. /endpoint 라우트 하나만. */
const ENDPOINT_LISTENER_PORT = 7778;

/** 라이브 프리뷰 리버스 프록시의 선호 포트 (preview_proxy_v1). sshd PermitOpen 에 «고정» 으로
 *  들어가는 daemon 소유 포트 — 실제 dev 포트는 안 들어가고 프록시 등록부가 통과를 결정한다. */
const PREVIEW_PROXY_PREFERRED_PORT = 7779;


const log = makeLogger("daemon");
const wsLog = makeLogger("ws");
const apiLog = makeLogger("api");
const authLog = makeLogger("auth");

/** iOS 가 캡처/제어를 요구했음을 «앱» 에 알리는 stdout 마커(DaemonManager 가 스캔). 앱이 해당 TCC
 *  권한이 없으면 설정창 권한 탭을 연다. 종류별 throttle(8s) — iOS begin 루프가 반복 전송해도 한 번만. */
const lastPermSignal: Record<string, number> = {};
function signalPermissionRequest(kind: "screen" | "accessibility"): void {
  const now = Date.now();
  if (now - (lastPermSignal[kind] ?? 0) < 8000) return;
  lastPermSignal[kind] = now;
  // 평문 console — DaemonManager.appendLog 가 라인 스캔(구조화 로거 우회).
  console.log(`__PS_PERMISSION_REQUEST__ ${kind}`);
}

export type StartOptions = {
  port?: number;
  bindHost?: string;
  /** false면 Tor 띄우지 않음 (dev/loopback 테스트용) */
  withTor?: boolean;
};

export async function start(opts: StartOptions = {}): Promise<void> {
  // 등록된 모든 adapter (claude_code / agy / codex) 를 registry 에 박는다. 라우트와
  // PTY runner 가 getAgent(id) 를 호출하기 전에 한 번 일어나야 함.
  registerBuiltinAgents();

  // Mac 앱이 spawn 할 때 POCKET_CLAUDE_AUTO_INIT=1 을 넘기면 config 가 없으면 자동 init.
  // 평소 CLI 호출자(`pocket-sisyphus start`)는 이 env 없이 동작 → 종전대로 "init 먼저" 에러.
  // 이유: GUI 사용자는 init/start 를 구분할 이유가 없다. token 은 pair QR 출력으로 확인.
  let cfg = readConfig();
  if (!cfg && process.env.POCKET_CLAUDE_AUTO_INIT === "1") {
    const token = generateToken();
    cfg = {
      port: 7777,
      token,
      tokenHash: hashToken(token),
      createdAt: Date.now(),
      localAdminSecret: generateToken(),
    };
    writeConfig(cfg);
    log.info("auto-init: new token generated", {
      "event.action": "daemon.init.auto",
    });
  }
  // 기존 설치(localAdminSecret 없던 config)에도 1회 채워 넣는다 — 로컬 Mac 앱 운영자 우회의
  // 전제. 폰 등록 후 Mac 앱 자기 호출이 attest 게이트에 막히지 않으려면 반드시 있어야 한다.
  if (cfg && !cfg.localAdminSecret) {
    cfg = { ...cfg, localAdminSecret: generateToken() };
    writeConfig(cfg);
  }
  if (!cfg) {
    log.fatal("daemon not initialized — run `npm run init`", {
      "event.action": "daemon.init.missing",
    });
    console.error(
      "❌ Daemon not initialized. Run: npm run init  (or: pocket-sisyphus init)",
    );
    process.exit(1);
  }

  // 사용자가 지정한(또는 기본 7777) 선호 포트. 환경에 따라 다른 프로그램이 이미 쓰고 있을 수
  // 있어 «선호» 일 뿐 — 실제 바인딩 포트는 아래 reclaim + findAvailablePort 로 결정된다.
  const preferredPort = opts.port ?? cfg.port;
  // 사용자가 지정한(또는 기본 22022) SSH 포트. 데몬 포트와 달리 임의 폴백은 안 한다 — 외부
  // 노출 채널(UPnP / Tor onion virtual 22)이 이 포트를 가리켜야 하므로. 점유 시 reclaim(우리
  // 것) 후에도 막히면 startSsh 가 명확한 에러를 던지고, 사용자가 「포트 설정」 에서 바꾼다.
  const sshPortPreferred = cfg.sshPort ?? SSH_PORT;
  // v2: 127.0.0.1 only. 외부 트래픽은 tor sidecar가 hidden service로 노출.
  // 0.0.0.0 바인딩 금지 — Tor 외 경로로 들어오는 모든 트래픽 차단.
  const bindHost = opts.bindHost ?? cfg.bindHost ?? "127.0.0.1";
  const withTor = opts.withTor ?? true;

  const app = new Hono();

  // 프리뷰 라우트가 참조하는 «확정 포트» 들 — 라우트는 app 구성 단계(아래)에서 mount 되지만
  // 실제 포트 값은 그 뒤 findAvailablePort 로 정해진다. 클로저가 이 mutable 들을 읽으므로
  // 늦게 채워도 정상 동작. reserved 는 daemon/endpoint/ssh/프록시 + 특권 SSH(22) 차단용.
  let resolvedPreviewProxyPort = 0;
  let resolvedDaemonPort = 0;
  let resolvedEndpointPort = 0;
  const resolvedSshPort = sshPortPreferred;
  const previewReservedPorts = (): Set<number> =>
    new Set(
      [
        resolvedDaemonPort,
        resolvedEndpointPort,
        resolvedPreviewProxyPort,
        resolvedSshPort,
        22,
      ].filter((p) => p > 0),
    );

  // Tor 의 ~50–200 KB/s 대역폭에서 JSON 응답 압축은 직접적인 체감 차이. 세션 목록 /
  // 메시지 페이로드는 보통 3–6배 압축된다. threshold 1024B 이하는 압축 안 함 (오버헤드 ↓).
  // Hono v4 의 compress 는 Node 18+ 의 native CompressionStream 을 쓴다.
  app.use("*", compress({ threshold: 1024 }));

  // 루트 응답 — 외부 health-check / 디버깅용. 단일 source of truth(version.ts)에서
  // 읽어 `/api/version` 응답과 늘 일치하도록 한다.
  app.get("/", (c) =>
    c.json({ name: "pocket-sisyphus-daemon", version: DAEMON_VERSION }),
  );

  app.get("/health", (c) =>
    c.json({
      ok: true,
      time: new Date().toISOString(),
      connectedClients: connectedClientCount(),
    }),
  );

  // /api/* 전체에 클라이언트 버전 강제 미들웨어 — `requireClientVersion` 내부에서
  // /api/version 만 예외 처리. 헤더가 없으면 통과 (옛 빌드 호환), 있고 너무 낮으면 426.
  app.use("/api/*", requireClientVersion);

  // /api/* 전체에 Secure Enclave 기기 인증 강제 — `requireAttestation` 내부에서 soft 모드
  // (공개키 미등록 시 통과) + /api/attest/*·/api/version 예외 처리. 등록된 뒤로는 X-PS-Attest
  // 헤더 없거나 무효면 401 attest_required.
  app.use("/api/*", requireAttestation);

  app.route("/api/sessions", sessions);
  app.route("/api/recent-projects", recent);
  // 세션 없이 repoPath 로 도는 git 동작 — 새 세션 스크린에서 worktree 를 바로 만들 때.
  app.route("/api/git", git);
  app.route("/api/fs", fsRoutes);
  app.route("/api/claude-code-sessions", claudeCodeSessions);
  app.route("/api/agents", desktopSessions);
  app.route("/api/admin", admin);
  // 알림 채널 설정 (Discord webhook). Mac 앱 설정 창 / iOS 설정이 호출.
  app.route("/api/notify", notify);
  // 로컬 LLM(llama-server) 수명주기 + 모델 카탈로그/다운로드/하드웨어 추천. iOS 모델 관리 화면.
  app.route("/api/local-llm", localLlm);
  // OpenCode 어댑터 — 외부 엔드포인트 모드(내 로컬 서버 사용) 설정 + /v1/models 헬스체크.
  app.route("/api/opencode", opencode);
  // 예약 작업(cron). iOS 가 관리, daemon 의 CronScheduler 가 정해진 시각에 세션을 만들어 실행.
  app.route("/api/cron", cron);
  // MCP 「도구」 — 에이전트가 붙을 사용자 본인 Calendar/Gmail 등 MCP 서버 등록·연결·헬스.
  // daemon 은 등록·토큰 custody(0600)·헬스만 소유, 전송·OAuth 는 에이전트 CLI 네이티브 MCP 위임.
  app.route("/api/mcp", mcp);
  // 멀티 에이전트 워크플로우. iOS 캔버스에서 그린 DAG 를 daemon 의 WorkflowEngine 이 노드=세션
  // 으로 위상 순서대로 실행. 노드 간 결과물 전달은 Task 폴더 계약 (workflow/task-folder.ts).
  app.route("/api/workflows", workflows);
  // 화면 원샷 스크린샷 (screen_shot_v1) — 미러링 «캡처/녹화 → 채팅 첨부» 데이터원.
  app.route("/api/screen", screen);
  // PO 루프 — 기회 브리프 백로그. 수집(에이전트 세션) + 결정(승인→실행 세션 spawn).
  app.route("/api/po", po);
  // 머지 큐 — 워크트리/세션의 작업 브랜치를 main/release 로 합치는 «재결합» 을 직렬 큐로 처리.
  // 동시 머지 요청을 큐에 적재해 한 번에 하나씩만 target 에 쓰고, 충돌은 보류 후 나머지 계속.
  app.route("/api/merge-queue", merge);
  // 라이브 프리뷰 — 세션별 dev 포트 명시 등록(기본 차단). 프록시가 등록된 포트만 forward.
  app.route(
    "/api/preview",
    preview({
      getProxyPort: () => resolvedPreviewProxyPort,
      getReservedPorts: previewReservedPorts,
      getSessionPtyPid: (sessionId) => getPtyPid(sessionId),
    }),
  );
  // 상태 변경(다운로드/서버) → WS push 구독 연결 (1회).
  initLocalLlmStatusBroadcast();
  // iOS ↔ daemon 호환성 핸드셰이크 — 부팅 시 1회 호출되는 가벼운 라우트.
  app.route("/api/version", version);
  // Secure Enclave 기기 인증 — 페어링 시 공개키 등록 + 매 세션 challenge-response.
  app.route("/api/attest", attest);

  let torHandle: TorHandle | null = null;
  let sshHandle: SshHandle | null = null;
  let endpointServer: ReturnType<typeof serve> | null = null;
  let previewProxy: PreviewProxyHandle | null = null;
  /** UPnP/PMP 매핑 결과 — endpoint 응답의 direct_ipv4 entry 포함 여부 결정. */
  let portMapping: PortMappingResult = {
    protocol: null,
    externalIPv4: null,
    error: null,
  };
  // 등록된 각 agent 의 데스크탑 세션 watcher 를 띄운다. 옛 jsonl 변동을 감지해
  // routes/recent + routes/claude-code-sessions / desktop-sessions 의 in-memory 캐시를
  // 무효화 — 이어받기 picker / 최근 레포 목록의 staleness 방지.
  const watcherStops: Array<() => void> = [];
  for (const adapter of listAgents()) {
    const w = adapter.desktopWatcher?.();
    if (!w) continue;
    const stop = w.start(() => {
      /* 모듈 내부의 listener 가 캐시 무효화를 처리 — 여기서 추가로 할 일 없음. */
    });
    watcherStops.push(stop);
  }
  // 예약 작업 스케줄러 정리 — daemon 종료 시 등록된 croner 인스턴스를 모두 stop.
  watcherStops.push(() => {
    try {
      getCronScheduler().stop();
    } catch {
      /* best-effort */
    }
  });
  // 워크플로우 트리거 스케줄러 정리 — croner + github 폴 타이머 stop.
  watcherStops.push(() => {
    try {
      getWorkflowTriggerScheduler().stop();
    } catch {
      /* best-effort */
    }
  });
  // PO 주기 수집 스케줄러 정리.
  watcherStops.push(() => {
    try {
      getPoScheduler().stop();
    } catch {
      /* best-effort */
    }
  });
  // worktree 회수기 주기 타이머 정리.
  watcherStops.push(() => {
    try {
      getWorktreeReaper().stop();
    } catch {
      /* best-effort */
    }
  });

  // 이전 인스턴스의 orphan daemon 이 daemon 포트 / endpoint 포트를 아직 잡고 있으면 serve()
  // 가 EADDRINUSE 로 실패한다. bind 전에 «우리 stale daemon» 만 골라 회수 — sshd
  // (reclaimSshPort) / tor(reclaimStaleTor) 와 같은 안전망 패턴.
  reclaimStaleDaemon([preferredPort, ENDPOINT_LISTENER_PORT]);

  // reclaim 후에도 선호 포트가 점유돼 있으면(= 우리 것이 아닌 무관한 프로그램), 죽이지 않고
  // 빈 포트로 폴백한다. 사용자가 포트에 대해 몰라도 앱이 어쨌든 뜨도록. 실제 바인딩 포트는
  // info.port 로 startSsh(PermitOpen) / endpoint(daemon_local_port) 에 그대로 전달돼 폰이
  // /endpoint 재조회로 자동으로 따라온다.
  const endpointPortResolved = await findAvailablePort(
    ENDPOINT_LISTENER_PORT,
    "127.0.0.1",
    new Set([preferredPort]),
  );
  const ENDPOINT_PORT = endpointPortResolved.port;
  const daemonPortResolved = await findAvailablePort(
    preferredPort,
    bindHost,
    new Set([ENDPOINT_PORT]),
  );
  const port = daemonPortResolved.port;
  // 프리뷰 프록시 «고정» 포트 — daemon/endpoint 와 안 겹치게 확정. 127.0.0.1 전용(외부는 SSH/Tor
  // forward 로만 도달). 이 값이 sshd PermitOpen + /api/preview 응답 + 프록시 listen 에 일관 적용.
  const previewProxyResolved = await findAvailablePort(
    PREVIEW_PROXY_PREFERRED_PORT,
    "127.0.0.1",
    new Set([port, ENDPOINT_PORT]),
  );
  resolvedDaemonPort = port;
  resolvedEndpointPort = ENDPOINT_PORT;
  resolvedPreviewProxyPort = previewProxyResolved.port;
  if (daemonPortResolved.fellBack || endpointPortResolved.fellBack) {
    log.warn("preferred port in use — fell back to free port", {
      "event.action": "daemon.port.fallback",
      "daemon.preferred_port": preferredPort,
      "daemon.bound_port": port,
      "daemon.endpoint_port": ENDPOINT_PORT,
    });
    console.warn(
      `⚠️  포트 ${preferredPort} 사용 중 — 빈 포트 ${port} 로 자동 전환 (endpoint ${ENDPOINT_PORT})`,
    );
  }

  const server = serve(
    {
      fetch: app.fetch,
      port,
      hostname: bindHost,
    },
    async (info) => {
      log.info("daemon listening", {
        "event.action": "daemon.listen",
        "host.address": info.address,
        port: info.port,
      });
      console.log(`✔ daemon listening on http://${info.address}:${info.port}`);
      // 실제 바인딩 포트 기록 — Mac 앱(DaemonAPI/LocalDaemonClient)이 선호 포트(config.port)
      // 대신 이 값을 읽는다. 선호 포트가 다른 프로그램에 점유돼 빈 포트로 폴백한 경우에도
      // 로컬 API 호출이 따라오도록. 매 부팅 listen 시점에 덮어써 항상 현재 인스턴스 기준.
      try {
        fs.writeFileSync(
          path.join(CONFIG_DIR, "daemon-runtime.json"),
          JSON.stringify({
            port: info.port,
            endpointPort: ENDPOINT_PORT,
            pid: process.pid,
          }),
          { mode: 0o600 },
        );
      } catch {
        /* best-effort — 파일이 없으면 Mac 앱이 선호 포트로 폴백한다 */
      }
      // 부팅 self-check: 등록된 각 agent 의 CLI binary 가 시스템에 있는지 즉시 확인.
      // 못 찾으면 첫 사용자 메시지가 올 때 silent failure 로 묻히지 않게 stderr 에
      // 명확히 경고. 회귀 대상: 2026-05-23 의 옛 번들 SDK 경로 stale 버그.
      const agentLog = makeLogger("agent");
      for (const adapter of listAgents()) {
        try {
          const bin = adapter.resolveBinary();
          agentLog.info("agent CLI detected", {
            "event.action": "agent.detect.ok",
            "agent.id": adapter.id,
            "agent.binary": bin,
          });
        } catch (e) {
          agentLog.error("agent CLI missing", {
            "event.action": "agent.detect.fail",
            "agent.id": adapter.id,
            "agent.display_name": adapter.displayName,
            "error.message": (e as Error).message,
          });
          console.error("");
          console.error(`⚠️  ${adapter.displayName} CLI MISSING — 사용자가 이 agent 로 세션을`);
          console.error("    만들고 메시지를 보내면 PTY spawn 이 실패한다.");
          console.error(`    ${(e as Error).message}`);
          console.error("");
        }
      }
      // 예약 작업 스케줄러 시작 — enabled 작업을 croner 에 등록하고 catch-up 보충.
      // SSH/Tor 와 무관(예약 실행은 로컬 PTY) 하므로 여기서 바로 시작해도 안전.
      try {
        startCronScheduler();
      } catch (e) {
        console.warn("[cron] scheduler start failed:", (e as Error).message);
      }
      // PO 주기 수집 스케줄러 — po_profiles.schedule 등록 («매일 아침 수집» 프리셋).
      try {
        startPoScheduler();
      } catch (e) {
        console.warn("[po] scheduler start failed:", (e as Error).message);
      }
      // 머지 큐 — 이전 프로세스가 처리 중 죽어 'processing' 으로 남은 항목을 'queued' 로 되돌린 뒤
      // (reconcile) 대기 항목 처리를 시작. 로컬 git 동작이라 SSH/Tor 와 무관 — 여기서 바로 시작.
      try {
        startMergeQueue();
      } catch (e) {
        console.warn("[merge] queue start failed:", (e as Error).message);
      }
      // 워크플로우 — 이전 프로세스에서 in-memory 진행 상태를 잃은 채 'running' 으로 남은 run 을
      // 'failed' 로 정리 (resumable 은 추후 Phase). 새 트리거 스케줄러는 Phase 1 에서 추가.
      try {
        reconcileStaleRuns();
      } catch (e) {
        console.warn("[workflow] reconcile stale runs failed:", (e as Error).message);
      }
      // worktree 회수기 — reconcileStaleRuns 가 막 running→failed 로 돌린, 이전 프로세스가 남긴
      // per-run worktree 누수를 «부팅 직후 1회 + 주기» 로 회수한다 (브랜치 prefix po//wf/, main·
      // 활성 run·세션은 보호, 비-force 라 dirty 는 skip). 로컬 git 동작이라 여기서 바로 시작.
      try {
        startWorktreeReaper();
      } catch (e) {
        console.warn("[reaper] start failed:", (e as Error).message);
      }
      // 워크플로우 트리거 스케줄러 — 시작 노드의 크론/GitHub 트리거를 정의에서 등록·감시.
      try {
        startWorkflowTriggerScheduler();
      } catch (e) {
        console.warn("[workflow] trigger scheduler start failed:", (e as Error).message);
      }
      // === SSH 서버 + Tor 듀얼 채널 부팅 ===
      //
      // 새 아키텍처 — SSH-first with Tor fallback:
      //  1. sshd 임베드 시작 (0.0.0.0:22022 + [::]:22022 listen, direct-tcpip → 127.0.0.1:7777)
      //  2. endpoint-only HTTP listener 시작 (127.0.0.1:7778, Tor onion 으로만 노출)
      //  3. UPnP/PMP 자동 매핑 시도 (best-effort, 실패해도 graceful)
      //  4. Tor 시작 — onion 으로 endpoint listener (port 80) + sshd (port 22) 둘 다 노출
      //  5. 페어링 QR v=3 출력 (onion + ssh fingerprint + client keypair + tokens)
      //
      // Tor data plane 은 fallback 채널로 살아있음 — 사용자의 라우터/ISP 가 직접 SSH inbound 를
      // 막을 때 iOS happy eyeballs 가 자동으로 tor_onion endpoint 채택.
      const hostKey = ensureHostKey();
      const sshLog = makeLogger("sshd");
      sshLog.info("ssh host key loaded", {
        "event.action": "sshd.hostkey.load",
        "ssh.fingerprint": hostKey.fingerprint,
      });
      console.log(`✔ ssh host key: ${hostKey.fingerprint}`);

      try {
        sshHandle = await startSsh({
          daemonPort: info.port,
          sshPort: sshPortPreferred,
          previewProxyPort: resolvedPreviewProxyPort,
        });
      } catch (e) {
        sshLog.error("sshd start failed", {
          "event.action": "sshd.start.fail",
          "ssh.preferred_port": sshPortPreferred,
          "error.message": (e as Error).message,
        });
        console.error("[ssh] failed:", (e as Error).message);
      }

      // endpoint-only HTTP listener — Tor onion 으로만 노출. /endpoint 라우트 하나만.
      const endpointApp = new Hono();
      endpointApp.route(
        "/",
        endpointRoute({
          getOnionAddress: () => torHandle?.onionAddress ?? null,
          getSshHostKeyFingerprint: () => hostKey.fingerprint,
          getSshPort: () => sshHandle?.port ?? SSH_PORT,
          getSshUser: () => sshHandle?.sshUser ?? "",
          getDaemonLocalPort: () => info.port,
          isIPv4Mapped: () => portMapping.externalIPv4 !== null,
          // LAN 전용 모드 — config.json `lanOnly`. 켜지면 endpoint 에서 공인/onion 을 빼고
          // direct_lan 만 광고(서버측 fail-closed). Mac 「포트」 설정 토글이 이 값을 쓴다.
          isLanOnly: () => cfg.lanOnly === true,
        }),
      );
      endpointServer = serve(
        {
          fetch: endpointApp.fetch,
          port: ENDPOINT_PORT,
          hostname: "127.0.0.1",
        },
        (eInfo) => {
          log.info("endpoint listener up", {
            "event.action": "endpoint.listen",
            "host.address": eInfo.address,
            port: eInfo.port,
          });
          console.log(
            `✔ endpoint listener on http://${eInfo.address}:${eInfo.port} (Tor onion only)`,
          );
        },
      );

      // 라이브 프리뷰 리버스 프록시 — 127.0.0.1:<고정포트> listen. sshd PermitOpen 에 이 포트가
      // 들어가 있어(startSsh 위에서 전달) iOS 가 기존 SSH 세션 위에 forward 를 하나 더 열어 도달.
      // dev 포트 자체는 PermitOpen 에 없고, 프록시가 등록부로 «등록된 포트만» forward 한다.
      try {
        previewProxy = await startPreviewProxy(resolvedPreviewProxyPort);
      } catch (e) {
        log.warn("preview proxy start failed", {
          "event.action": "preview.proxy.fail",
          "error.message": (e as Error).message,
        });
        console.error("[preview] proxy failed:", (e as Error).message);
      }

      // UPnP/PMP 자동 매핑 — 비동기, 실패해도 graceful.
      // 성공: endpoint 응답에 direct_ipv4 entry 추가. iOS 가 happy eyeballs 로 우선 시도.
      // 실패: tor_onion fallback 으로 동작. 메뉴바에 ⚠️ + 사용자 가이드.
      // 실제 바인딩된 SSH 포트(sshHandle.port)를 매핑 — 사용자가 커스텀 포트로 바꿨어도 일치.
      const activeSshPort = sshHandle?.port ?? sshPortPreferred;
      tryMapSSHPort(activeSshPort).then((result) => {
        portMapping = result;
        if (result.externalIPv4) {
          console.log(
            `✔ UPnP/PMP mapped: external ${result.externalIPv4}:${activeSshPort} → local ${activeSshPort}`,
          );
        } else {
          console.warn(
            `⚠️  UPnP/PMP mapping failed (${result.error ?? "unknown"}) — Tor fallback only`,
          );
        }
      });

      // 외부 IPv4 echo 도 비동기 — endpoint 응답이 호출되기 전에 캐시 채워두기.
      const natLog = makeLogger("nat");
      getExternalIPv4().then((ip) => {
        if (ip) {
          natLog.info("external IPv4 echo resolved", {
            "event.action": "nat.external_ip.resolve",
            "secret.external_ipv4": ip,
          });
          console.log(`✔ external IPv4 (echo): ${ip}`);
        }
      });

      if (withTor) {
        const torLog = makeLogger("tor");
        try {
          torHandle = await startTor({
            hiddenServicePort: 80,
            targetPort: ENDPOINT_PORT,
            // SSH fallback 채널 — 같은 onion 의 virtual port 22 → 임베디드 sshd.
            // 실제 바인딩된 SSH 포트로 forward (사용자 커스텀 포트 반영).
            sshHiddenServicePort: 22,
            sshTargetPort: activeSshPort,
          });
          torLog.info("onion address available", {
            "event.action": "tor.onion.ready",
            "secret.onion.address": torHandle.onionAddress,
          });
          console.log(`✔ onion: ${torHandle.onionAddress}`);

          // WAN IPv4 변경 감시 시작 — 5분 주기. 가정용 dynamic IP 환경에서 ISP DHCP 갱신
          // 으로 공유기 WAN IP 가 바뀌면 onion introduction point 가 stale 해진다. Mac 앱의
          // NetworkChangeMonitor 는 «Mac 인터페이스» IPv4 만 보기 때문에 NAT 안쪽 LAN IP
          // (192.168.x.x) 가 안 바뀌면 path 이벤트가 안 나가 SIGHUP 도 안 보내진다.
          // daemon 안에서 외부 echo 폴링으로 그 갭을 메우고, 변경 감지 시 kickTorReconnect
          // (SIGHUP) 호출 — Tor 자체 timeout (1~5분) 대신 5~10s 안에 복구.
          const stopWanWatcher = startWanIPv4Watcher((prev, next) => {
            const r = kickTorReconnect();
            natLog.info("WAN IPv4 change detected", {
              "event.action": "nat.wan_ipv4.change",
              "secret.previous_ipv4": prev,
              "secret.next_ipv4": next,
              "tor.kick_result": r,
            });
            console.log(
              `[wan-watch] WAN IPv4 ${prev} → ${next} 감지 → kickTorReconnect: ${r}`,
            );
          });
          watcherStops.push(stopWanWatcher);

          // 페어링 QR 자동 출력 (v=3 — SSH host fingerprint + client keypair 포함)
          await printPairingQR({
            onion: torHandle.onionAddress,
            daemonToken: cfg.token,
            clientAuthPriv: torHandle.clientAuthPriv,
            sshHostKeyFingerprint: hostKey.fingerprint,
            sshHostKeyLine: hostKey.publicKeyLine,
            sshUser: sshHandle?.sshUser ?? "",
          });
        } catch (e) {
          torLog.error("tor start failed", {
            "event.action": "tor.start.fail",
            "error.message": (e as Error).message,
          });
          console.error("[tor] failed:", (e as Error).message);
        }
      }
    },
  );

  // TCP_NODELAY — Nagle 비활성화. 응답 페이로드가 작아도 (예: 승인 ack, 작은 JSON)
  // 즉시 flush 되어 client RTT 추가 ~40ms 버퍼링 제거. Tor 위에서는 hop RTT 가
  // 100ms+ 인 환경이라 40ms 가 의미 있는 비중. WS upgrade 도 같은 소켓이라 함께 효과.
  server.on("connection", (socket) => {
    socket.setNoDelay(true);
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    const token = url.searchParams.get("token");
    if (!verifyWsToken(token)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    // WS 는 헤더를 못 붙이므로 attest 토큰도 query(?attest=) 로 받는다. soft 모드(미등록)면
    // 통과, 등록된 뒤엔 유효 토큰 필수 — HTTP `/api/*` 와 동일한 기기 인증 게이트.
    // ?local=(localAdminSecret) 은 HTTP X-PS-Local 과 짝인 로컬 운영자 우회.
    if (!verifyWsAttest(url.searchParams.get("attest"), url.searchParams.get("local"))) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const clientId = randomUUID();
      registerClient(clientId, ws);
      wsLog.info("client connected", {
        "event.action": "ws.connect",
        "client.id": clientId,
      });
      ws.send(JSON.stringify({ type: "hello", clientId }));

      ws.on("message", (raw) => {
        try {
          const msg = JSON.parse(String(raw));
          if (msg.type === "subscribe" && typeof msg.sessionId === "string") {
            attachToSession(clientId, msg.sessionId);
            ws.send(JSON.stringify({ type: "subscribed", sessionId: msg.sessionId }));
            // Catch-up: 클라이언트가 마지막으로 본 created_at 을 since 로 보냈다면
            // 그 이후의 pty_chunk 를 즉시 unicast 로 backfill. polling fallback 대신
            // WS 한 사이클로 빠진 chunk 가 채워진다 (백그라운드 복귀 latency 개선).
            if (typeof msg.since === "number" && msg.since > 0) {
              replayPtyChunksSince(ws, msg.sessionId, msg.since);
            }
            // PTY 모드 세션이면 lazy prewarm — daemon 재시작 / PTY 죽음 후 사용자가 채팅방
            // 진입해 WS subscribe 보내는 시점에 PTY 가 살아있도록 보장. 옛 동작은 사용자가
            // 첫 keystroke 보낼 때까지 PTY 가 없어 WS pty_input 이 silent drop 되는 버그
            // (사용자 보고: 「소프트 키보드 입력 → PTY 안 감」, 2026-05).
            //
            // 이미 active 이면 prewarmPty 가 no-op. idempotent.
            try {
              const row = db()
                .prepare(
                  "SELECT id, repo_path, mode, agent, parent_sdk_session_id, skip_permissions FROM sessions WHERE id = ?",
                )
                .get(msg.sessionId) as {
                  id: string;
                  repo_path: string;
                  mode: string;
                  agent: string;
                  parent_sdk_session_id: string | null;
                  skip_permissions: number;
                } | undefined;
              if (row && row.mode === "pty" && hasAgent(row.agent)) {
                const adapter = getAgent(row.agent);
                try {
                  prewarmPty(
                    {
                      sessionId: row.id,
                      cwd: row.repo_path,
                      adapter,
                      resumeFrom: row.parent_sdk_session_id ?? undefined,
                    },
                    { bypassPermissions: row.skip_permissions === 1 },
                  );
                } catch (e) {
                  // CLI 미설치 등 spawn 실패 — 사용자가 방금 채팅방에 들어와 subscribe 한
                  // 시점이라, 안내를 터미널 스트림에 바로 노출해 빈 화면을 보지 않게 한다.
                  // 모든 키보드 모드 (ASCII keystroke / CJK 줄 입력) 공통 진입점이라 여기서
                  // 잡으면 입력 전에도 사용자가 원인을 본다.
                  wsLog.warn("subscribe lazy prewarm failed", {
                    "event.action": "ws.subscribe.prewarm_failed",
                    "session.id": msg.sessionId,
                    "error.message": (e as Error).message,
                  });
                  emitSpawnFailure(row.id, e);
                }
              }
            } catch (e) {
              // 위 prewarm 자체가 아닌 DB 조회 등의 실패 — 로그만. (터미널엔 안 그림)
              wsLog.warn("subscribe lazy prewarm setup failed", {
                "event.action": "ws.subscribe.prewarm_failed",
                "session.id": msg.sessionId,
                "error.message": (e as Error).message,
              });
            }
          } else if (
            // 실시간 keystroke 채널 — SwiftTerm 이 키 입력 raw byte 를 base64 로 보낸다.
            // ack 를 굳이 보내지 않는 이유: 키스트로크 단위로 ack 가 가면 트래픽이 두 배.
            // 출력 echo (pty_chunk broadcast) 가 자연스러운 ack 역할.
            msg.type === "pty_input" &&
            typeof msg.sessionId === "string" &&
            typeof msg.bytes_b64 === "string"
          ) {
            try {
              const buf = Buffer.from(msg.bytes_b64, "base64");
              const ok = writePtyRaw(msg.sessionId, buf);
              // 입력 바이트 추적(PS_KS_TRACE=1) — WS 도착 시점의 raw bytes + writePtyRaw 결과.
              // writePtyRaw 안의 KS-TRACE recv 와 짝 — 이쪽은 sanitize «전» bytes 라 양쪽을
              // 같이 보면 sanitize 가 무엇을 떨궜는지까지 드러난다. OFF 면 로그 0(영향 0).
              if (KS_TRACE) {
                console.log(
                  `[KS-TRACE] ws-recv clientId=${clientId} session=${msg.sessionId} ` +
                  `bytes=${buf.length} hex=[${buf.subarray(0, 64).toString("hex").match(/.{1,2}/g)?.join(" ") ?? ""}] ` +
                  `writeResult=${ok}`,
                );
              }
            } catch (e) {
              wsLog.warn("pty_input decode failed", {
                "event.action": "ws.pty_input_decode",
                "client.id": clientId,
                "error.message": (e as Error).message,
              });
            }
          } else if (msg.type === "ping") {
            // RTT 측정용 — 데몬은 그냥 echo. 클라이언트가 send 시점과 receive 시점의
            // delta 를 본다. WS 가 살아있는지 healthcheck 역할도 겸함.
            ws.send(JSON.stringify({ type: "pong", t: msg.t }));
          } else if (msg.type === "visibility" && typeof msg.state === "string") {
            // iOS scenePhase 미러링 — foreground 면 «보는 중», background 면 away.
            // background 일 때 away-gating 을 다시 켜서 Discord 알림이 나가게 한다
            // (앱은 떠 있어 소켓이 OPEN 이지만 사용자가 화면을 안 보는 상태).
            // 옛 iOS 는 이 메시지를 안 보내므로 active 가 기본 true 로 남아 옛 동작 유지.
            setClientActive(clientId, msg.state === "foreground");
          } else if (msg.type === "capture_start" && typeof msg.sessionId === "string") {
            // 네이티브 화면 캡처 시작 — 헬퍼 spawn, 이 세션을 활성 캡처로. macOS 화면 기록 TCC
            // 미승인 시 검은/빈 프레임일 수 있다. 코덱은 클라가 요청(h264 디코드 가능할 때만 보냄,
            // 옛 iOS 는 미전송 → jpeg). h264=바이너리 WS(고fps), jpeg=base64 screen_frame(폴백).
            const codec = msg.codec === "h264" ? "h264" : "jpeg";
            // 채널별 품질 티어 — iOS 가 엔드포인트(Tor/직결)에 맞춰 maxDim/fps/bitrate 를 보낸다.
            const fps = typeof msg.fps === "number" ? msg.fps : undefined;
            const bitrate = typeof msg.bitrate === "number" ? msg.bitrate : undefined;
            const maxDim = typeof msg.maxDim === "number" ? msg.maxDim : undefined;
            // 시스템 오디오(h264 전용) — iOS 가 소리 토글에 맞춰 보낸다. 옛 iOS 미전송 = off.
            const audio = typeof msg.audio === "boolean" ? msg.audio : undefined;
            const r = startCaptureForSession(msg.sessionId, codec, fps, bitrate, maxDim, audio);
            // 캡처 = 화면 기록 권한 필요. 앱이 받아 권한 없으면 설정창 권한 탭을 연다.
            signalPermissionRequest("screen");
            ws.send(JSON.stringify(
              r.ok
                ? { type: "capture_status", running: true }
                : { type: "capture_status", running: false, reason: r.reason },
            ));
            // 헬퍼가 이미 떠 있어 디스플레이 목록이 캐시돼 있으면 즉시 전달(멀티모니터 선택).
            // 첫 spawn 이면 헬퍼가 곧 __PS_DISPLAYS__ 를 보고하고 sidecar 가 broadcast 한다.
            const ds = currentDisplays();
            if (r.ok && ds.length > 0) {
              ws.send(JSON.stringify({ type: "capture_displays", sessionId: msg.sessionId, displays: ds }));
            }
            // 창 목록 + 현재 캡처 대상도 캐시돼 있으면 즉시 전달 — 캡처 대상 피커가 바로 차고,
            // 헬퍼가 살아남은 재진입에서 iOS 선택 상태가 실제 대상과 동기화된다.
            const wins = currentWindows();
            if (r.ok && wins.length > 0) {
              ws.send(JSON.stringify({ type: "capture_windows", sessionId: msg.sessionId, windows: wins }));
              ws.send(JSON.stringify({ type: "capture_target", sessionId: msg.sessionId, window: currentWindowTarget() }));
            }
          } else if (msg.type === "capture_stop" && typeof msg.sessionId === "string") {
            stopCaptureForSession(msg.sessionId);
            ws.send(JSON.stringify({ type: "capture_status", running: false }));
          } else if (msg.type === "control_set" && typeof msg.sessionId === "string") {
            // 원격 제어 보안 게이트 — 이 메시지로 켠 세션만 input_event 가 헬퍼로 전달된다.
            setControlEnabled(msg.sessionId, msg.enabled === true);
            // 제어 켜기 = 손쉬운 사용 권한 필요. 앱이 받아 권한 없으면 설정창 권한 탭을 연다.
            if (msg.enabled === true) signalPermissionRequest("accessibility");
          } else if (
            msg.type === "capture_set_display" &&
            typeof msg.sessionId === "string" &&
            typeof msg.index === "number"
          ) {
            // 멀티모니터 — 캡처/입력 대상 디스플레이 선택.
            setDisplayForSession(msg.sessionId, msg.index);
          } else if (
            msg.type === "capture_set_window" &&
            typeof msg.sessionId === "string" &&
            typeof msg.windowId === "number"
          ) {
            // 캡처 대상 창 선택(screen_window_target_v1) — windowId<=0 이면 전체 화면 복귀.
            setWindowForSession(msg.sessionId, msg.windowId);
          } else if (msg.type === "capture_list_windows" && typeof msg.sessionId === "string") {
            // 창 목록 재보고 요청 — 헬퍼가 __PS_WINDOWS__ 로 응답 → capture_windows broadcast.
            requestWindowList(msg.sessionId);
          } else if (msg.type === "capture_roi" && typeof msg.sessionId === "string") {
            // 줌 관심영역(하이브리드 D) — 정규화 rect. w<=0(또는 미지정)이면 전체로 리셋.
            const w = typeof msg.w === "number" ? msg.w : 0;
            if (w > 0 && typeof msg.x === "number" && typeof msg.y === "number" && typeof msg.h === "number") {
              setROIForSession(msg.sessionId, { x: msg.x, y: msg.y, w, h: msg.h });
            } else {
              setROIForSession(msg.sessionId, null);
            }
          } else if (
            msg.type === "input_event" &&
            typeof msg.sessionId === "string" &&
            msg.event && typeof msg.event === "object"
          ) {
            // 원격 입력 주입 — relayInput 이 «제어 허용» 게이트를 통과한 경우에만 헬퍼로 전달.
            relayInput(msg.sessionId, msg.event as Record<string, unknown>);
          }
        } catch (e) {
          wsLog.warn("bad message", {
            "event.action": "ws.bad_message",
            "client.id": clientId,
            "error.message": (e as Error).message,
          });
        }
      });

      ws.on("close", () => {
        unregisterClient(clientId);
        // 아무도 안 보면 화면 캡처 헬퍼를 내린다 (배터리/프라이버시).
        captureOnClientGone();
        wsLog.info("client disconnected", {
          "event.action": "ws.disconnect",
          "client.id": clientId,
        });
      });
    });
  });

  async function printPairingQR(args: {
    onion: string;
    daemonToken: string | undefined;
    clientAuthPriv: string;
    sshHostKeyFingerprint: string;
    sshHostKeyLine: string;
    sshUser: string;
  }): Promise<void> {
    if (!args.daemonToken) {
      console.log("");
      console.log("⚠️  config에 평문 token이 없습니다. QR 페어링을 쓰려면:");
      console.log("    npm run init -- --force   (token 재생성)");
      console.log("    그 후 daemon 재시작.");
      console.log("");
      return;
    }
    if (!args.sshUser) {
      console.log("");
      console.log("⚠️  sshd 가 부팅 안 됨 — 페어링 QR 생성 불가. sshd 시작 로그 확인.");
      console.log("");
      return;
    }

    // 페어링용 SSH client keypair — «영속 단일 키». 기존 키가 있으면 그대로 재사용하므로
    // 폰에 박힌 옛 QR 이 계속 유효하고, 매 부팅 새 키를 만들어 authorized_keys 에 쌓던 버그를
    // 막는다. authorized_keys 는 항상 이 한 키로만 설정 → 옛/유령 키 전부 무효화(자동 정리).
    const sshKeys = loadOrCreateClientKeypair();
    setAuthorizedClientExclusive(sshKeys.publicKeyLine, "paired");

    // endpoint Bearer 는 daemon token 과 분리 — Tor onion 에 노출되는 채널의 가벼운 인증.
    // 1차 구현에선 daemon token 을 그대로 재사용 (단순화). 향후 분리 가능.
    const endpointToken = args.daemonToken;

    // v=3 payload — SSH host key fingerprint + ed25519 client keypair priv + tokens.
    // 구버전 iOS 앱(v=2 이하) 은 sshd 인증 필드 부재로 daemon 거부 → 재페어링 안내.
    const payload = buildPairingPayload({
      onion: args.onion,
      daemonToken: args.daemonToken,
      endpointToken,
      clientAuthPriv: args.clientAuthPriv,
      sshHostKeyFingerprint: args.sshHostKeyFingerprint,
      sshHostKeyLine: args.sshHostKeyLine,
      sshClientPrivBase64: sshKeys.privBase64,
      sshUser: args.sshUser,
      sshPort: resolvedSshPort,
      daemonPort: resolvedDaemonPort,
    });

    console.log("");
    console.log("──────────────────────────────────────────────────");
    console.log("📱 폰 앱에서 이 QR을 스캔하세요 (Pair > QR 스캔):");
    console.log("──────────────────────────────────────────────────");
    qrcodeTerminal.generate(payload, { small: true });

    // PNG로도 저장 + macOS 미리보기 자동 오픈 (큰 화면용)
    const pngPath = path.join(CONFIG_DIR, "pair-qr.png");
    try {
      await writePairingQRPng(payload, pngPath);
      console.log(`✔ QR PNG도 저장: ${pngPath}`);
      if (process.platform === "darwin" && !process.env.POCKET_CLAUDE_NO_OPEN) {
        spawn("open", [pngPath], { detached: true, stdio: "ignore" }).unref();
      }
    } catch (e) {
      console.warn("[qr] png save failed:", (e as Error).message);
    }
    console.log("──────────────────────────────────────────────────");
    console.log("");
  }

  const shutdown = async () => {
    log.info("shutdown initiated", { "event.action": "daemon.shutdown.start" });
    console.log("\n[shutdown] stopping…");
    for (const stop of watcherStops) {
      try { stop(); } catch { /* best-effort */ }
    }
    // UPnP/PMP 매핑 해제 — 좀비 매핑 방지. 라우터가 응답 안 해도 TTL 로 자동 expire.
    if (portMapping.externalIPv4) {
      try {
        await tryUnmapSSHPort(SSH_PORT);
      } catch {
        /* best-effort */
      }
    }
    // 우리가 띄운 llama-server 정리 (adopt 한 외부/LaunchAgent 서버는 stopServer 가 no-op).
    try {
      await stopLocalLlmServer();
    } catch (e) {
      console.warn("[local-llm] stop error:", (e as Error).message);
    }
    if (sshHandle) {
      try {
        await sshHandle.stop();
      } catch (e) {
        console.warn("[ssh] stop error:", (e as Error).message);
      }
    }
    if (torHandle) {
      try {
        await torHandle.stop();
      } catch (e) {
        console.warn("[tor] stop error:", (e as Error).message);
      }
    } else {
      // bootstrap 중 (waitForOnion ~30s) 에 SIGTERM 받으면 torHandle 아직 null.
      // 그래도 sidecar 가 spawn 한 Tor child 는 살아있음 → module-level 참조로 받아 직접 SIGTERM.
      // 안 그러면 daemon 만 죽고 Tor 가 PPID=1 reparent 로 orphan.
      const tp = getActiveTorProcess();
      if (tp) {
        console.log("[tor] bootstrap 중 SIGTERM — fallback 으로 직접 정리");
        tp.kill("SIGTERM");
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    // 화면 캡처 헬퍼 정리.
    try {
      stopCapture();
    } catch {
      /* best-effort */
    }
    if (endpointServer) {
      endpointServer.close();
    }
    if (previewProxy) {
      try {
        await previewProxy.stop();
      } catch {
        /* best-effort */
      }
    }
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
