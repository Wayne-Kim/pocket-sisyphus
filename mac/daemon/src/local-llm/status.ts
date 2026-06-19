/**
 * 로컬 LLM 상태 합성 + WS 브로드캐스트.
 *
 * download(진행) + supervisor(서버) + hardware + binaries 를 한 객체로 합쳐 라우트가 GET 으로,
 * WS 가 push 로 같은 truth 를 내보낸다 (updateStatus.ts + ws/hub.ts 의 idiom).
 * onLocalLlmChange 구독 → byte 진행 폭주를 막기 위해 ~1/s 스로틀로 broadcastAll.
 */
import fs from "node:fs";
import { broadcastAll } from "../ws/hub.js";
import { readConfig } from "../config.js";
import { onLocalLlmChange } from "./events.js";
import { getServerStatus, isLlamaServerInstalled, type LlmServerStatus } from "./supervisor.js";
import { getDownloadProgress, isModelDownloaded, listDownloaded, type DownloadProgress } from "./download.js";
import { detectHardware, recommendModel, type HardwareSummary } from "./hardware.js";
import { detectHomebrew } from "./resolve-homebrew.js";
import { resolveQwenBinary } from "../agent/adapters/local-llm/resolve-binary.js";
import { MODEL_CATALOG, getCatalogModel, DEFAULT_MODEL_ID, type CatalogModel } from "./catalog.js";
import { LLM_PORT } from "./paths.js";

function isQwenInstalled(): boolean {
  try {
    resolveQwenBinary();
    return true;
  } catch {
    return false;
  }
}

function isAria2cInstalled(): boolean {
  return ["/opt/homebrew/bin/aria2c", "/usr/local/bin/aria2c"].some((p) => fs.existsSync(p));
}

/**
 * Homebrew(brew) 존재 여부 — login-shell PATH + Apple Silicon/Intel 기본 prefix 까지 본다.
 * detectHomebrew() 가 절대경로 또는 null 을 주므로 그 유무로 합성한다 (PATH 에 brew 가 없어도
 * /opt/homebrew/bin/brew 가 있으면 «설치됨»).
 */
function isHomebrewInstalled(): boolean {
  return detectHomebrew() !== null;
}

export type LocalLlmStatus = {
  hardware: HardwareSummary;
  recommendedModelId: string | null;
  selectedModelId: string | null;
  modelPresent: boolean;
  port: number;
  server: LlmServerStatus;
  download: DownloadProgress;
  binaries: { homebrew: boolean; llamaServer: boolean; qwen: boolean; aria2c: boolean };
  ctxSize: number | null;
};

/** config.selectedModelId → 없으면 하드웨어 추천 → 없으면 DEFAULT. */
export function effectiveModelId(hw?: HardwareSummary): string {
  const sel = readConfig()?.localLlm?.selectedModelId;
  if (sel && getCatalogModel(sel)) return sel;
  const ram = (hw ?? detectHardware()).totalRamBytes;
  return recommendModel(ram) ?? DEFAULT_MODEL_ID;
}

export function getLocalLlmStatus(): LocalLlmStatus {
  const hardware = detectHardware();
  const selectedModelId = effectiveModelId(hardware);
  const selected = getCatalogModel(selectedModelId);
  return {
    hardware,
    recommendedModelId: recommendModel(hardware.totalRamBytes),
    selectedModelId,
    modelPresent: selected ? isModelDownloaded(selected) : false,
    port: LLM_PORT,
    server: getServerStatus(),
    download: getDownloadProgress(),
    binaries: {
      homebrew: isHomebrewInstalled(),
      llamaServer: isLlamaServerInstalled(),
      qwen: isQwenInstalled(),
      aria2c: isAria2cInstalled(),
    },
    ctxSize: readConfig()?.localLlm?.ctxSize ?? null,
  };
}

export type CatalogResponse = {
  catalog: (CatalogModel & { downloaded: boolean })[];
  downloaded: string[];
  recommendedModelId: string | null;
  selectedModelId: string | null;
  ctxSize: number | null;
};

export function getCatalogResponse(): CatalogResponse {
  const hardware = detectHardware();
  const dl = new Set(listDownloaded());
  return {
    catalog: MODEL_CATALOG.map((m) => ({ ...m, downloaded: dl.has(m.id) })),
    downloaded: [...dl],
    recommendedModelId: recommendModel(hardware.totalRamBytes),
    selectedModelId: effectiveModelId(hardware),
    ctxSize: readConfig()?.localLlm?.ctxSize ?? null,
  };
}

// ── WS 브로드캐스트 (스로틀) ───────────────────────────────────────────────
let pendingBroadcast = false;
let lastBroadcastAt = 0;
const MIN_BROADCAST_INTERVAL_MS = 1000;

function flushBroadcast(): void {
  pendingBroadcast = false;
  lastBroadcastAt = Date.now();
  try {
    broadcastAll({ type: "local_llm_status", status: getLocalLlmStatus() });
  } catch {
    /* WS 없음 등 — 무해 */
  }
}

/** 상태 변경 통지를 ~1/s 로 묶어 broadcast. download byte 진행이 폭주해도 Tor 링크 안전. */
export function broadcastLocalLlmStatus(): void {
  const elapsed = Date.now() - lastBroadcastAt;
  if (elapsed >= MIN_BROADCAST_INTERVAL_MS) {
    flushBroadcast();
    return;
  }
  if (pendingBroadcast) return;
  pendingBroadcast = true;
  setTimeout(flushBroadcast, MIN_BROADCAST_INTERVAL_MS - elapsed);
}

/** 데몬 부팅 시 한 번 호출 — 이벤트 버스 구독 연결. */
export function initLocalLlmStatusBroadcast(): void {
  onLocalLlmChange(broadcastLocalLlmStatus);
}
