/**
 * 모델 다운로드 매니저 — 옛 standalone 다운로드 스크립트의 데몬 이식.
 *
 * 책임:
 *  - 디스크 가드 (여유 < 파일크기 + 10GB headroom 이면 거부)
 *  - resume 지원 다운로드 (aria2c 16분할 우선, 없으면 Node fetch + HTTP Range)
 *  - sha256 스트리밍 검증 (38GB 를 메모리에 올리지 않음)
 *  - 진행률(percent/speed/eta) 보고 + cancel + downloaded 모델 삭제
 *
 * 동시 다운로드는 1개 (단일 서버/단일 모델 현실에 맞춤). 진행 상태는 module singleton.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn as childSpawn, type ChildProcess } from "node:child_process";
import { MODELS_DIR, modelFilePath } from "./paths.js";
import { emitLocalLlmChange } from "./events.js";
import { MODEL_CATALOG, type CatalogModel } from "./catalog.js";

const GiB = 1024 ** 3;
const DISK_HEADROOM_BYTES = 10 * GiB;

export type DownloadState =
  | "idle"
  | "downloading"
  | "verifying"
  | "ready"
  | "error";

export type DownloadProgress = {
  modelId: string | null;
  state: DownloadState;
  bytesDownloaded: number;
  bytesTotal: number;
  percent: number;
  bytesPerSec: number;
  etaSeconds: number | null;
  /** state==="error" 일 때 사람이 읽는 한 줄. snake_case 에러코드 + 설명. */
  error: string | null;
  startedAt: number | null;
};

export interface DownloadDeps {
  existsSync: (p: string) => boolean;
  statSizeBytes: (p: string) => number; // statSync(p).size, 없으면 throw
  /** MODELS_DIR 의 여유 공간(bytes). */
  freeBytes: (dir: string) => number;
  mkdirp: (p: string) => void;
  unlink: (p: string) => void;
  /** 파일 sha256 (소문자 hex) 스트리밍 계산. */
  hashFile: (p: string) => Promise<string>;
  /** aria2c 절대경로 또는 null. */
  resolveAria2: () => string | null;
  spawn: typeof childSpawn;
  fetch: typeof fetch;
  modelsDir: string;
};

function statfsFree(dir: string): number {
  // Node 18+ statfsSync. bavail*bsize = 비특권 사용자 가용 바이트.
  // statfs 는 «존재하는» 경로만 받는다 — 아직 안 만든 모델 디렉토리(fresh Mac)면 ENOENT 로
  // throw 하므로, 가장 가까운 «존재하는 상위» 로 올라가 같은 볼륨의 여유를 잰다(이중 안전장치).
  let probe = dir;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break; // 루트까지 올라왔으면 그만
    probe = parent;
  }
  const s = fs.statfsSync(probe);
  return Number(s.bavail) * Number(s.bsize);
}

async function hashFileSha256(p: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const h = createHash("sha256");
    const rs = fs.createReadStream(p);
    rs.on("error", reject);
    rs.on("data", (chunk) => h.update(chunk));
    rs.on("end", () => resolve(h.digest("hex")));
  });
}

export const defaultDownloadDeps: DownloadDeps = {
  existsSync: fs.existsSync,
  statSizeBytes: (p) => fs.statSync(p).size,
  freeBytes: statfsFree,
  mkdirp: (p) => fs.mkdirSync(p, { recursive: true }),
  unlink: (p) => fs.unlinkSync(p),
  hashFile: hashFileSha256,
  resolveAria2: () => {
    for (const c of ["/opt/homebrew/bin/aria2c", "/usr/local/bin/aria2c"]) {
      if (fs.existsSync(c)) return c;
    }
    return null;
  },
  spawn: childSpawn,
  fetch: (...args) => fetch(...args),
  modelsDir: MODELS_DIR,
};

let progress: DownloadProgress = {
  modelId: null,
  state: "idle",
  bytesDownloaded: 0,
  bytesTotal: 0,
  percent: 0,
  bytesPerSec: 0,
  etaSeconds: null,
  error: null,
  startedAt: null,
};

let abortController: AbortController | null = null;
let activeAria: ChildProcess | null = null;
let progressTimer: ReturnType<typeof setInterval> | null = null;
let lastSample: { t: number; bytes: number } | null = null;

export function getDownloadProgress(): DownloadProgress {
  return { ...progress };
}

/** 남은 다운로드량 + 10GB headroom (순수 — resume 시 existing 만큼 필요량이 준다). */
export function diskNeedBytes(model: CatalogModel, existingBytes: number): number {
  return Math.max(0, model.fileSizeBytes - existingBytes) + DISK_HEADROOM_BYTES;
}

export function hasEnoughDisk(
  model: CatalogModel,
  existingBytes: number,
  freeBytes: number,
): boolean {
  return freeBytes >= diskNeedBytes(model, existingBytes);
}

function setProgress(patch: Partial<DownloadProgress>): void {
  progress = { ...progress, ...patch };
  emitLocalLlmChange();
}

/** 파일이 «완성»됐는지 — 존재 + 크기 정확 일치 (partial 은 작아서 false). */
export function isModelDownloaded(
  model: CatalogModel,
  deps: DownloadDeps = defaultDownloadDeps,
): boolean {
  const dest = (deps.modelsDir === MODELS_DIR)
    ? modelFilePath(model.fileName)
    : `${deps.modelsDir}/${model.fileName}`;
  try {
    return deps.existsSync(dest) && deps.statSizeBytes(dest) === model.fileSizeBytes;
  } catch {
    return false;
  }
}

export function listDownloaded(deps: DownloadDeps = defaultDownloadDeps): string[] {
  return MODEL_CATALOG.filter((m) => isModelDownloaded(m, deps)).map((m) => m.id);
}

export function deleteDownloadedModel(
  model: CatalogModel,
  deps: DownloadDeps = defaultDownloadDeps,
): { ok: boolean; reason?: string } {
  if (progress.state === "downloading" && progress.modelId === model.id) {
    return { ok: false, reason: "downloading" };
  }
  const dest = modelFilePath(model.fileName);
  try {
    if (deps.existsSync(dest)) deps.unlink(dest);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}

export function cancelDownload(): boolean {
  if (progress.state !== "downloading") return false;
  abortController?.abort();
  if (activeAria) {
    try {
      activeAria.kill("SIGTERM");
    } catch {
      /* 이미 종료 */
    }
  }
  stopProgressTimer();
  setProgress({ state: "idle", modelId: null, error: null });
  return true;
}

function stopProgressTimer(): void {
  if (progressTimer) {
    clearInterval(progressTimer);
    progressTimer = null;
  }
  lastSample = null;
}

function startProgressTimer(dest: string, total: number, deps: DownloadDeps): void {
  stopProgressTimer();
  lastSample = { t: Date.now(), bytes: safeSize(dest, deps) };
  progressTimer = setInterval(() => {
    const cur = safeSize(dest, deps);
    const now = Date.now();
    let bps = 0;
    if (lastSample && now > lastSample.t) {
      bps = ((cur - lastSample.bytes) * 1000) / (now - lastSample.t);
    }
    lastSample = { t: now, bytes: cur };
    const percent = total > 0 ? Math.min(100, (cur / total) * 100) : 0;
    const eta = bps > 0 ? Math.max(0, (total - cur) / bps) : null;
    setProgress({ bytesDownloaded: cur, percent, bytesPerSec: Math.max(0, bps), etaSeconds: eta });
  }, 1000);
}

function safeSize(p: string, deps: DownloadDeps): number {
  try {
    return deps.existsSync(p) ? deps.statSizeBytes(p) : 0;
  } catch {
    return 0;
  }
}

function hfUrl(model: CatalogModel): string {
  return `https://huggingface.co/${model.hfRepo}/resolve/main/${model.fileName}`;
}

/**
 * 다운로드 시작. 가드 실패는 동기 throw (라우트가 4xx 로 매핑). 성공 경로는 async 진행.
 * 같은 모델을 이미 받는 중이면 멱등 (no-op). 다른 모델 받는 중이면 "busy" throw.
 */
export async function startDownload(
  model: CatalogModel,
  deps: DownloadDeps = defaultDownloadDeps,
): Promise<void> {
  if (progress.state === "downloading") {
    if (progress.modelId === model.id) return; // 멱등
    throw new Error("busy");
  }

  const dest = `${deps.modelsDir}/${model.fileName}`;
  const existing = (() => {
    try {
      return deps.existsSync(dest) ? deps.statSizeBytes(dest) : 0;
    } catch {
      return 0;
    }
  })();

  // 이미 완성돼 있으면 즉시 ready.
  if (existing === model.fileSizeBytes) {
    setProgress({
      modelId: model.id,
      state: "ready",
      bytesDownloaded: existing,
      bytesTotal: model.fileSizeBytes,
      percent: 100,
      bytesPerSec: 0,
      etaSeconds: 0,
      error: null,
      startedAt: Date.now(),
    });
    return;
  }

  // 모델 디렉토리를 «먼저» 만든다 — 디스크 가드의 statfs 는 존재하는 경로만 잴 수 있다.
  // (fresh Mac: CONFIG_DIR/models 가 아직 없으면 statfsSync 가 ENOENT 로 throw → 첫 다운로드가
  //  download_failed 로 즉사하던 회귀를 차단. 같은 볼륨이라 디렉토리 생성 후 여유량은 동일.)
  deps.mkdirp(deps.modelsDir);

  // 디스크 가드 — 남은 다운로드량 + 10GB headroom.
  if (!hasEnoughDisk(model, existing, deps.freeBytes(deps.modelsDir))) {
    throw new Error("insufficient_disk");
  }

  abortController = new AbortController();
  setProgress({
    modelId: model.id,
    state: "downloading",
    bytesDownloaded: existing,
    bytesTotal: model.fileSizeBytes,
    percent: model.fileSizeBytes > 0 ? (existing / model.fileSizeBytes) * 100 : 0,
    bytesPerSec: 0,
    etaSeconds: null,
    error: null,
    startedAt: Date.now(),
  });
  startProgressTimer(dest, model.fileSizeBytes, deps);

  // fire-and-forget 본체 — 호출자(라우트)는 즉시 응답하고 진행은 status 로 본다.
  void runDownload(model, dest, existing, deps).catch((e) => {
    stopProgressTimer();
    if (abortController?.signal.aborted) {
      setProgress({ state: "idle", modelId: null, error: null });
    } else {
      setProgress({ state: "error", error: `download_failed: ${(e as Error).message}` });
    }
  });
}

async function runDownload(
  model: CatalogModel,
  dest: string,
  offset: number,
  deps: DownloadDeps,
): Promise<void> {
  const url = hfUrl(model);
  const aria = deps.resolveAria2();

  if (aria) {
    await downloadViaAria(aria, model, deps, url);
  } else {
    await downloadViaFetch(url, dest, offset, deps);
  }
  if (abortController?.signal.aborted) return;

  stopProgressTimer();
  // 무결성 검증
  if (model.sha256) {
    setProgress({ state: "verifying" });
    const actual = await deps.hashFile(dest);
    if (actual.toLowerCase() !== model.sha256.toLowerCase()) {
      setProgress({ state: "error", error: `sha256_mismatch: 파일 손상 — 재다운로드 필요` });
      return; // 파일 보존 (resume 재시도 가능)
    }
  }
  const finalSize = safeSize(dest, deps);
  setProgress({
    state: "ready",
    bytesDownloaded: finalSize,
    percent: 100,
    bytesPerSec: 0,
    etaSeconds: 0,
    error: null,
  });
}

function downloadViaAria(
  aria: string,
  model: CatalogModel,
  deps: DownloadDeps,
  url: string,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const proc = deps.spawn(
      aria,
      [
        "-x16",
        "-s16",
        "-k1M",
        "-c", // resume
        "--file-allocation=none",
        "-d",
        deps.modelsDir,
        "-o",
        model.fileName,
        url,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    activeAria = proc;
    proc.on("error", (e) => {
      activeAria = null;
      reject(e);
    });
    proc.on("exit", (code, signal) => {
      activeAria = null;
      if (signal) return reject(new Error(`aria2c killed (${signal})`));
      if (code !== 0) return reject(new Error(`aria2c exit ${code}`));
      resolve();
    });
  });
}

async function downloadViaFetch(
  url: string,
  dest: string,
  offset: number,
  deps: DownloadDeps,
): Promise<void> {
  const headers: Record<string, string> = {};
  if (offset > 0) headers["Range"] = `bytes=${offset}-`;
  const res = await deps.fetch(url, {
    headers,
    signal: abortController?.signal,
  });
  if (!res.ok && res.status !== 206) {
    throw new Error(`http ${res.status}`);
  }
  // 206 이면 append, 아니면 처음부터.
  const append = res.status === 206 && offset > 0;
  const ws = fs.createWriteStream(dest, { flags: append ? "a" : "w" });
  const body = res.body;
  if (!body) throw new Error("no_response_body");
  const reader = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (abortController?.signal.aborted) throw new Error("aborted");
      await new Promise<void>((resolve, reject) => {
        ws.write(Buffer.from(value), (err) => (err ? reject(err) : resolve()));
      });
    }
  } finally {
    ws.close();
  }
}
