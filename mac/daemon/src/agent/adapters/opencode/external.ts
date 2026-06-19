/**
 * OpenCode «외부 엔드포인트» 모드 — 사용자가 이미 자기 Mac 에서 돌리는 OpenAI 호환 로컬
 * 서버(Ollama/LM Studio/vLLM …)를 그대로 백엔드로 쓴다. 번들 llama-server 를 강제하지
 * 않아 중복 다운로드/디스크 낭비를 없애고 «내가 고른 모델» 경험을 잇는다.
 *
 * 두 가지 책임:
 *  ① 설정 읽기(readExternalConfig) — config.opencode.external 을 정규화해 반환. enabled
 *     아니거나 필드가 비면 null(= 번들 llama-server 경로 유지).
 *  ② 연결 전 헬스체크(probeExternalModels) — /v1/models 로 (a) 엔드포인트 도달성과
 *     (b) 설정한 모델 id 존재를 검증해 «막다른 길»(연결했더니 안 떠 있거나 모델명이 틀림)
 *     을 사전 차단. 결과를 iOS 가 도달 불가/모델 없음 → warning 토큰으로 표면화한다.
 *
 * 주의: OpenAI 호환 /v1/models 는 모델 «능력»(tool-calling 지원 여부)을 노출하지 않는다.
 * 그래서 «도구호출 가능 모델 존재» 검증의 실효적·행동가능한 형태는 «설정한 modelId 가
 * 서버 목록에 실재하는가» 다 — 이름 오타/미로딩 같은 막다른 길을 잡아주는 핵심 가드.
 */
import { readConfig, OPENCODE_DEFAULT_EXTERNAL_BASE_URL } from "../../../config.js";

/** 정규화된 외부 엔드포인트 설정 (readExternalConfig 반환형). */
export type ExternalEndpoint = {
  baseUrl: string;
  modelId: string;
};

/**
 * baseURL 정규화 — 양끝 공백 제거 + 끝의 슬래시 1개 제거. opencode/openai-compatible SDK 가
 * `${baseURL}/chat/completions` 식으로 이어 붙이므로 trailing slash 가 있으면 `//` 가 된다.
 */
export function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

/**
 * config 에서 활성 외부 엔드포인트를 읽어 정규화. 비활성/미설정/필드 누락이면 null —
 * 호출부(어댑터)는 null 이면 기존 번들 llama-server 경로를 그대로 탄다.
 */
export function readExternalConfig(): ExternalEndpoint | null {
  const ext = readConfig()?.opencode?.external;
  if (!ext || !ext.enabled) return null;
  const baseUrl = normalizeBaseUrl(ext.baseUrl ?? "");
  const modelId = (ext.modelId ?? "").trim();
  if (!baseUrl || !modelId) return null;
  return { baseUrl, modelId };
}

/** probeExternalModels 의 에러 코드 — iOS 가 로컬라이즈해 warning 으로 표면화. */
export type ExternalProbeError =
  | "unreachable" // 네트워크/타임아웃/연결 거부
  | "http_error" // 응답은 왔으나 2xx 아님
  | "bad_response" // JSON 파싱/형식 불일치
  | "no_models" // 도달했으나 모델 목록이 빔
  | "model_not_found"; // 도달했고 모델은 있으나 설정한 modelId 가 목록에 없음

export type ExternalProbeResult = {
  /** /v1/models 가 2xx + 파싱 가능했는가. */
  reachable: boolean;
  /** 서버가 보고한 모델 id 목록 (정렬). */
  models: string[];
  /** 설정한 modelId 가 목록에 있는가 (모델 미지정이면 false). */
  modelPresent: boolean;
  /** 정상이면 null, 아니면 위 에러 코드. */
  error: ExternalProbeError | null;
  /** HTTP status (도달한 경우만). 진단용. */
  httpStatus: number | null;
};

/** OpenAI 호환 /v1/models 응답에서 모델 id 배열을 뽑는다 (순수 — 테스트 대상). */
export function parseModelsResponse(json: unknown): string[] {
  if (!json || typeof json !== "object") return [];
  const data = (json as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  const ids: string[] = [];
  for (const item of data) {
    if (item && typeof item === "object") {
      const id = (item as { id?: unknown }).id;
      if (typeof id === "string" && id.length > 0) ids.push(id);
    }
  }
  return [...new Set(ids)].sort();
}

/**
 * 헬스체크 판정 (순수 — 테스트 대상). 도달성/모델목록/설정모델에서 결과를 합성한다.
 *  - 도달 못 함 → reachable:false, error 그대로.
 *  - 도달 + 목록 빔 → no_models (막다른 길: 서버는 떴는데 서빙 모델이 없음).
 *  - 도달 + modelId 없음(목록엔 있음) → model_not_found (이름 오타/미로딩).
 *  - 도달 + modelId 있음 → 정상(error null).
 */
export function decideProbeResult(args: {
  reachable: boolean;
  reachError: ExternalProbeError | null;
  models: string[];
  modelId: string;
  httpStatus: number | null;
}): ExternalProbeResult {
  const { reachable, reachError, models, modelId, httpStatus } = args;
  if (!reachable) {
    return { reachable: false, models: [], modelPresent: false, error: reachError, httpStatus };
  }
  const modelPresent = modelId.length > 0 && models.includes(modelId);
  let error: ExternalProbeError | null = null;
  if (models.length === 0) error = "no_models";
  else if (!modelPresent) error = "model_not_found";
  return { reachable: true, models, modelPresent, error, httpStatus };
}

const PROBE_TIMEOUT_MS = 4000;

/**
 * 외부 엔드포인트 /v1/models 를 실제로 두드려 도달성 + 설정 모델 존재를 검증한다.
 * 절대 throw 하지 않는다 — 모든 실패를 ExternalProbeResult.error 로 환원해 라우트가
 * 200 으로 그대로 돌려주고 iOS 가 warning 으로 표면화한다.
 */
export async function probeExternalModels(
  baseUrl: string,
  modelId: string,
  opts?: { timeoutMs?: number },
): Promise<ExternalProbeResult> {
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized) {
    return decideProbeResult({
      reachable: false,
      reachError: "unreachable",
      models: [],
      modelId,
      httpStatus: null,
    });
  }
  const timeout = opts?.timeoutMs ?? PROBE_TIMEOUT_MS;
  let res: Response;
  try {
    res = await fetch(`${normalized}/models`, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(timeout),
    });
  } catch {
    return decideProbeResult({
      reachable: false,
      reachError: "unreachable",
      models: [],
      modelId,
      httpStatus: null,
    });
  }
  if (!res.ok) {
    return decideProbeResult({
      reachable: false,
      reachError: "http_error",
      models: [],
      modelId,
      httpStatus: res.status,
    });
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return decideProbeResult({
      reachable: false,
      reachError: "bad_response",
      models: [],
      modelId,
      httpStatus: res.status,
    });
  }
  const models = parseModelsResponse(json);
  return decideProbeResult({
    reachable: true,
    reachError: null,
    models,
    modelId,
    httpStatus: res.status,
  });
}

export { OPENCODE_DEFAULT_EXTERNAL_BASE_URL };
