/**
 * llama-server 감독 — tor/sidecar.ts 의 구조를 그대로 미러한 child 프로세스 관리.
 *
 * 책임:
 *  - 온디맨드 기동(ensureServer): /health 멱등 + 외부 서버 adopt + preflight + spawn + readiness
 *  - 자동 재시작(backoff) on 예기치 않은 crash (우리가 띄운 것만)
 *  - graceful stop (우리가 띄운 것만 — adopt 한 외부/LaunchAgent 서버는 안 죽임)
 *  - readiness 직후 프리픽스 캐시 프라이밍 (fire-and-forget)
 *
 * serve 플래그는 selected catalog 모델에 의해 parameterize 된다. 순수 함수
 * buildLlamaServerArgs / decideServerAction 가 테스트 가능 핵심.
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { makeLogger } from "../logging/log.js";
import { LLM_HOST, LLM_PORT, LLM_BASE_URL, LLM_OPENAI_BASE_URL, LLM_LOG_DIR, MODELS_DIR, modelFilePath } from "./paths.js";
import { emitLocalLlmChange } from "./events.js";
import { getCatalogModel, type CatalogModel } from "./catalog.js";
import { resolveLlamaServerBinary, findLlamaServerBinary } from "./resolve-llama-server.js";
import { resolveQwenBinary } from "../agent/adapters/local-llm/resolve-binary.js";
import { readConfig } from "../config.js";

const log = makeLogger("local-llm");

const READINESS_TIMEOUT_MS = 120_000;
const READINESS_POLL_MS = 1000;
const MIN_RESTART_BACKOFF_MS = 1000;
const MAX_RESTART_BACKOFF_MS = 30_000;
const LOG_MAX_BYTES = 50 * 1024 * 1024;
const LLM_API_KEY = "sk-local-dummy"; // adapter 와 동일 (llama-server 는 키 미검증)

// ── 순수 함수 (단위 테스트 대상) ─────────────────────────────────────────

/**
 * config 오버라이드 적용 후 실제 serve 할 ctx — [바닥, model.ctxMax] 로 clamp.
 *
 * 바닥은 도구호출 모델이면 model.minToolCtx(≥16k), 아니면 4096. 도구호출 모델을 4k 로 띄우면
 * tool-call 시스템 프롬프트+스키마가 컨텍스트에 안 들어가 «초록불인데 파일이 안 써지는» 사고가
 * 난다 — 사용자가 ctxSize 를 작게 적어도 supervisor 가 권장 최소 컨텍스트를 강제 보장한다.
 */
export function effectiveCtxSize(model: CatalogModel, configCtx: number | null | undefined): number {
  const wanted = configCtx && configCtx > 0 ? configCtx : model.ctxDefault;
  const floor = model.toolCallCapable ? model.minToolCtx : 4096;
  return Math.min(Math.max(wanted, floor), model.ctxMax);
}

/**
 * llama-server serve 인자 (옛 standalone 프로토타입에서 이식). MTP 는 hasMtpHead 일 때만.
 * ctxSize 가 model.ctxNative 를 넘으면 Qwen 공식 가이드대로 YaRN rope 스케일링을 붙인다
 * (없으면 네이티브 윈도 밖에서 출력 품질이 무너진다).
 */
export function buildLlamaServerArgs(
  model: CatalogModel,
  cfg: { host: string; port: number; ctxSize: number; modelPath?: string },
): string[] {
  const args = [
    "--model", cfg.modelPath ?? modelFilePath(model.fileName),
    "--host", cfg.host,
    "--port", String(cfg.port),
    "--ctx-size", String(cfg.ctxSize),
    "--parallel", "1",
    "--n-gpu-layers", "999",
    "--jinja",
    "--mlock",
    "--flash-attn", "on",
    // Qwen 공식 코딩 샘플링 프리셋
    "--temp", "0.6",
    "--top-p", "0.95",
    "--top-k", "20",
    "--min-p", "0",
  ];
  if (cfg.ctxSize > model.ctxNative) {
    // 예: Qwen3 32k 네이티브에서 96k 요청 → scale 3. Qwen 권장 상한은 4 (=131072).
    const scale = Math.ceil(cfg.ctxSize / model.ctxNative);
    args.push(
      "--rope-scaling", "yarn",
      "--rope-scale", String(scale),
      "--yarn-orig-ctx", String(model.ctxNative),
    );
  }
  if (model.hasMtpHead) {
    args.push("--spec-type", "draft-mtp", "--spec-draft-n-max", "2");
  }
  return args;
}

export type ServerDecision = "adopt" | "spawn" | "error-port-occupied";

/**
 * 포트 51100 의 현재 상태로 무엇을 할지 결정 (순수).
 *  - health OK → adopt (안 띄움, shutdown 때 안 죽임 — LaunchAgent/수동서버 공존 허용)
 *  - health 실패 + 우리 llama-server(=MODELS_DIR 인자) 점유 → spawn (stale 재시작; 호출부가 reclaim)
 *  - health 실패 + 미상 점유 → error (남의 프로세스 안 죽임)
 *  - 점유 없음 → spawn
 */
export function decideServerAction(args: {
  healthOk: boolean;
  listenerPid: number | null;
  listenerCmd: string | null;
  modelsDir: string;
}): ServerDecision {
  if (args.healthOk) return "adopt";
  if (args.listenerPid == null) return "spawn";
  if (args.listenerCmd && args.listenerCmd.includes(args.modelsDir)) return "spawn";
  return "error-port-occupied";
}

// ── 상태 머신 ─────────────────────────────────────────────────────────────

export type LlmServerState =
  | "stopped"
  | "preflight"
  | "starting"
  | "ready"
  | "error"
  | "adopted";

export type LlmServerStatus = {
  state: LlmServerState;
  modelId: string | null;
  spawnedByUs: boolean;
  pid: number | null;
  error: string | null;
  readyAt: number | null;
  ctxSize: number | null;
};

let activeProcess: ChildProcess | null = null;
let adoptedExternal = false;
let intentionalShutdown = false;
let everReady = false;
let restartBackoffMs = MIN_RESTART_BACKOFF_MS;
let pendingRestartTimer: ReturnType<typeof setTimeout> | null = null;
let startPromise: Promise<LlmServerStatus> | null = null;
let currentModelId: string | null = null;
let currentCtxSize: number | null = null;
let serverState: LlmServerState = "stopped";
let lastError: string | null = null;
let readyAt: number | null = null;

export function getServerStatus(): LlmServerStatus {
  return {
    state: serverState,
    modelId: currentModelId,
    spawnedByUs: !!activeProcess && !adoptedExternal,
    pid: activeProcess?.pid ?? null,
    error: lastError,
    readyAt,
    ctxSize: currentCtxSize,
  };
}

function setState(s: LlmServerState, err: string | null = null): void {
  serverState = s;
  lastError = err;
  if (s === "stopped" || s === "error") {
    currentCtxSize = null;
  }
  emitLocalLlmChange();
}

async function probeHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${LLM_BASE_URL}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function findPortListener(port: number): { pid: number | null; cmd: string | null } {
  try {
    const out = execFileSync(
      "/usr/sbin/lsof",
      ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
      { encoding: "utf8", timeout: 2000 },
    ).trim();
    const pid = Number.parseInt(out.split(/\s+/)[0] ?? "", 10);
    if (!Number.isFinite(pid)) return { pid: null, cmd: null };
    let cmd: string | null = null;
    try {
      cmd = execFileSync("/bin/ps", ["-o", "command=", "-p", String(pid)], {
        encoding: "utf8",
        timeout: 2000,
      }).trim();
    } catch {
      cmd = null;
    }
    return { pid, cmd };
  } catch {
    return { pid: null, cmd: null }; // lsof 매치 없음(exit 1) 또는 부재
  }
}

/** memory_pressure 여유 % (못 읽으면 null — 가드 skip). */
function freeMemoryPercent(): number | null {
  try {
    const out = execFileSync("/usr/bin/memory_pressure", ["-Q"], {
      encoding: "utf8",
      timeout: 3000,
    });
    const m = out.match(/System-wide memory free percentage:\s*([0-9]+)/);
    return m ? Number.parseInt(m[1], 10) : null;
  } catch {
    return null;
  }
}

function mtpFlagAvailable(bin: string): boolean {
  try {
    const help = execFileSync(bin, ["--help"], {
      encoding: "utf8",
      timeout: 5000,
    });
    return help.includes("draft-mtp");
  } catch {
    return false;
  }
}

function rotateLogIfNeeded(logFile: string): void {
  try {
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > LOG_MAX_BYTES) {
      for (const i of [2, 1]) {
        const from = `${logFile}.${i}`;
        if (fs.existsSync(from)) fs.renameSync(from, `${logFile}.${i + 1}`);
      }
      fs.renameSync(logFile, `${logFile}.1`);
    }
  } catch {
    // 로테이션 실패는 무해 — append 로 진행.
  }
}

/**
 * 온디맨드 기동. 멱등: 이미 ready(우리/adopt)면 그대로 반환, starting 이면 같은 promise 반환.
 * 다른 모델이 이미 떠 있어도 자동 교체하지 않는다 (switchModel 이 명시 경로).
 */
export async function ensureServer(modelId: string): Promise<LlmServerStatus> {
  const model = getCatalogModel(modelId);
  if (!model) {
    setState("error", `unknown_model: ${modelId}`);
    return getServerStatus();
  }

  // 이미 우리가 띄워 ready 거나 adopt 한 상태면 그대로.
  if ((serverState === "ready" || serverState === "adopted") && activeProcessAlive()) {
    return getServerStatus();
  }
  // 기동 진행 중이면 같은 promise 공유.
  if (startPromise) return startPromise;

  startPromise = doEnsure(model).finally(() => {
    startPromise = null;
  });
  return startPromise;
}

function activeProcessAlive(): boolean {
  if (adoptedExternal) return true; // 외부 — 우리 child 없음
  return !!activeProcess && activeProcess.exitCode === null && !activeProcess.killed;
}

async function doEnsure(model: CatalogModel): Promise<LlmServerStatus> {
  setState("preflight");
  currentModelId = model.id;

  // 1) /health probe → 포트 점유자 판정 → adopt/spawn/error
  const healthOk = await probeHealth();
  const { pid, cmd } = findPortListener(LLM_PORT);
  const decision = decideServerAction({
    healthOk,
    listenerPid: pid,
    listenerCmd: cmd,
    modelsDir: MODELS_DIR,
  });

  if (decision === "adopt") {
    adoptedExternal = true;
    activeProcess = null;
    everReady = true;
    readyAt = Date.now();
    currentCtxSize = null;
    log.info("adopted external llama-server", { "event.action": "llm.adopt", "llm.port": LLM_PORT });
    setState("adopted");
    return getServerStatus();
  }
  if (decision === "error-port-occupied") {
    setState("error", `port_occupied: ${LLM_PORT} 가 미상 프로세스(pid=${pid})에 점유됨`);
    return getServerStatus();
  }

  // 2) preflight 가드
  const modelPath = modelFilePath(model.fileName);
  if (!fs.existsSync(modelPath)) {
    setState("error", `model_not_downloaded: ${model.fileName}`);
    return getServerStatus();
  }
  const freePct = freeMemoryPercent();
  if (freePct != null && freePct < 15) {
    setState("error", `insufficient_memory: 여유 ${freePct}% < 15%`);
    return getServerStatus();
  }
  let bin: string;
  try {
    bin = resolveLlamaServerBinary();
  } catch (e) {
    setState("error", `llama_server_not_found: ${(e as Error).message}`);
    return getServerStatus();
  }
  if (model.hasMtpHead && !mtpFlagAvailable(bin)) {
    setState("error", "mtp_unsupported: 설치된 llama-server 에 draft-mtp 없음 (버전 드리프트)");
    return getServerStatus();
  }

  // 3) stale 우리 프로세스가 점유 중이면 reclaim 후 spawn
  if (pid != null) {
    try {
      process.kill(pid, "SIGKILL");
      log.warn("reclaimed stale llama-server", { "event.action": "llm.reclaim", "process.pid": pid });
    } catch {
      /* 이미 죽음 */
    }
  }

  return spawnAndWait(model, bin);
}

async function spawnAndWait(model: CatalogModel, bin: string): Promise<LlmServerStatus> {
  adoptedExternal = false;
  intentionalShutdown = false;
  restartBackoffMs = MIN_RESTART_BACKOFF_MS;
  if (pendingRestartTimer) {
    clearTimeout(pendingRestartTimer);
    pendingRestartTimer = null;
  }

  fs.mkdirSync(LLM_LOG_DIR, { recursive: true });
  const logFile = path.join(LLM_LOG_DIR, "server.log");
  rotateLogIfNeeded(logFile);
  const logStream = fs.createWriteStream(logFile, { flags: "a" });

  const ctxSize = effectiveCtxSize(model, readConfig()?.localLlm?.ctxSize);
  const args = buildLlamaServerArgs(model, {
    host: LLM_HOST,
    port: LLM_PORT,
    ctxSize,
  });
  log.info("spawning llama-server", {
    "event.action": "llm.spawn",
    "llm.model": model.id,
    "llm.bin": bin,
    "llm.ctx_size": ctxSize,
  });
  const proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
  activeProcess = proc; // bootstrap 중 shutdown 안전망 — 즉시 셋
  currentModelId = model.id;
  currentCtxSize = ctxSize;
  setState("starting");

  proc.stdout?.on("data", (c: Buffer) => logStream.write(c));
  proc.stderr?.on("data", (c: Buffer) => logStream.write(c));

  proc.on("exit", (code, signal) => {
    log.info("llama-server exited", { "event.action": "llm.exit", "process.exit_code": code, signal });
    if (activeProcess === proc) activeProcess = null;
    try {
      logStream.end();
    } catch {
      /* noop */
    }
    if (intentionalShutdown) {
      setState("stopped");
      return;
    }
    if (adoptedExternal) return;
    if (pendingRestartTimer) return;
    // 예기치 않은 종료 → backoff 재시작 (한 번이라도 spawn 됐던 모델로).
    const delay = restartBackoffMs;
    setState("error", `crashed: code=${code} signal=${signal} — ${Math.round(delay / 1000)}s 후 재시작`);
    log.warn("unexpected llama-server exit — scheduling restart", {
      "event.action": "llm.restart.schedule",
      "llm.restart.delay_ms": delay,
    });
    pendingRestartTimer = setTimeout(() => {
      pendingRestartTimer = null;
      if (intentionalShutdown) return;
      const m = currentModelId ? getCatalogModel(currentModelId) : undefined;
      if (!m) return;
      restartBackoffMs = Math.min(restartBackoffMs * 2, MAX_RESTART_BACKOFF_MS);
      let b: string;
      try {
        b = resolveLlamaServerBinary();
      } catch {
        return;
      }
      void spawnAndWait(m, b).catch(() => {
        /* exit 핸들러가 다음 backoff 로 이어감 */
      });
    }, delay);
  });

  // readiness 폴링 — /health OK 또는 child 사망 또는 타임아웃.
  const start = Date.now();
  while (Date.now() - start < READINESS_TIMEOUT_MS) {
    if (activeProcess !== proc || proc.exitCode !== null) {
      setState("error", "process_died_during_startup");
      return getServerStatus();
    }
    if (await probeHealth()) {
      everReady = true;
      readyAt = Date.now();
      restartBackoffMs = MIN_RESTART_BACKOFF_MS;
      setState("ready");
      log.info("llama-server ready", { "event.action": "llm.ready", "llm.model": model.id });
      void primeCache(model); // fire-and-forget
      return getServerStatus();
    }
    await delay(READINESS_POLL_MS);
  }
  setState("error", `readiness_timeout: ${READINESS_TIMEOUT_MS}ms 내 미기동`);
  return getServerStatus();
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 우리가 띄운 서버만 정지. adopt/외부 서버는 건드리지 않음. */
export async function stopServer(): Promise<void> {
  if (pendingRestartTimer) {
    clearTimeout(pendingRestartTimer);
    pendingRestartTimer = null;
  }
  const proc = activeProcess;
  if (!proc || adoptedExternal) {
    // 우리 child 가 없으면(외부/미기동) 상태만 정리.
    if (adoptedExternal) {
      adoptedExternal = false;
      setState("stopped");
    }
    return;
  }
  intentionalShutdown = true;
  await new Promise<void>((resolve) => {
    proc.once("exit", () => resolve());
    try {
      proc.kill("SIGTERM");
    } catch {
      resolve();
    }
    setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* 이미 종료 */
      }
      resolve();
    }, 5000);
  });
  activeProcess = null;
  setState("stopped");
}

/** 명시적 모델 교체 — 우리 서버면 정지 후 새 모델로 기동. */
export async function switchModel(modelId: string): Promise<LlmServerStatus> {
  await stopServer();
  return ensureServer(modelId);
}

/**
 * 프리픽스 캐시 프라이밍 — qwen 을 빈 워크스페이스에서 한 번 돌려
 * 시스템 프롬프트를 서버 프리픽스 캐시에 적재. fire-and-forget, never throw.
 */
function primeCache(model: CatalogModel): void {
  let qwenBin: string;
  try {
    qwenBin = resolveQwenBinary();
  } catch {
    return; // qwen 없으면 생략 (서버 자체는 정상)
  }
  try {
    const primeDir = path.join(MODELS_DIR, "..", "prime-workspace");
    fs.mkdirSync(primeDir, { recursive: true });
    fs.mkdirSync(LLM_LOG_DIR, { recursive: true });
    const primeLog = fs.openSync(path.join(LLM_LOG_DIR, "prime.log"), "a");
    const child = spawn(
      qwenBin,
      ["-p", "캐시 프라이밍 요청입니다. 다른 말 없이 ok 라고만 답하세요."],
      {
        cwd: primeDir,
        stdio: ["ignore", primeLog, primeLog],
        env: {
          ...process.env,
          OPENAI_BASE_URL: LLM_OPENAI_BASE_URL,
          OPENAI_API_KEY: LLM_API_KEY,
          OPENAI_MODEL: model.id,
        },
      },
    );
    child.on("error", () => {
      /* 프라이밍 실패는 무해 */
    });
    child.unref();
  } catch {
    /* 무해 */
  }
}

/** status 합성용 — llama-server 바이너리 존재 여부. */
export function isLlamaServerInstalled(): boolean {
  return findLlamaServerBinary() !== null;
}
