/**
 * OpenCode 어댑터 라우트 — iOS 「고급: 내 로컬 서버 사용」 설정이 호출.
 *
 *  GET    /api/opencode/external          — 현재 외부 엔드포인트 설정 (기본값 채움)
 *  PUT    /api/opencode/external          — 설정 저장 (config.opencode.external)
 *  POST   /api/opencode/external/verify   — /v1/models 헬스체크 (도달성 + 모델 존재)
 *
 * 외부 엔드포인트 모드: 사용자가 이미 자기 Mac 에서 돌리는 OpenAI 호환 로컬 서버(Ollama 등)를
 * baseURL 로 지정하면, opencode 어댑터가 번들 llama-server 의 ensureServer 를 건너뛰고 그
 * baseURL 을 OPENAI_BASE_URL 로 주입한다 — «내 모델 그대로».
 *
 * 인증: 다른 /api/* 와 동일하게 bearer (routes/local-llm.ts 패턴).
 */
import { Hono } from "hono";
import { bearerAuth } from "../auth.js";
import {
  readConfig,
  writeConfig,
  OPENCODE_DEFAULT_EXTERNAL_BASE_URL,
  type OpencodeExternalEndpoint,
} from "../config.js";
import { normalizeBaseUrl, probeExternalModels } from "../agent/adapters/opencode/external.js";

export const opencode = new Hono();

opencode.use("*", bearerAuth);

/** http(s) URL 인지 가볍게 검증 (loopback 강제는 안 함 — LAN 서버도 허용). */
function isValidHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** 저장된 설정을 응답형으로 — 미설정이면 기본값(비활성 + 기본 baseURL)을 돌려준다. */
function externalResponse(ext: OpencodeExternalEndpoint | undefined) {
  return {
    enabled: ext?.enabled ?? false,
    baseUrl: ext?.baseUrl ?? OPENCODE_DEFAULT_EXTERNAL_BASE_URL,
    modelId: ext?.modelId ?? "",
  };
}

opencode.get("/external", (c) => {
  return c.json(externalResponse(readConfig()?.opencode?.external));
});

opencode.put("/external", async (c) => {
  const body = (await c.req.json().catch(() => null)) as
    | { enabled?: unknown; baseUrl?: unknown; modelId?: unknown }
    | null;
  if (!body) return c.json({ error: "invalid_json" }, 400);

  const cfg = readConfig();
  if (!cfg) return c.json({ error: "daemon_not_initialized" }, 500);

  const enabled = body.enabled === true;
  const baseUrlRaw = typeof body.baseUrl === "string" ? body.baseUrl : "";
  const baseUrl = normalizeBaseUrl(baseUrlRaw);
  const modelId = typeof body.modelId === "string" ? body.modelId.trim() : "";

  // 켤 때만 엄격히 검증 — 끄는(enabled=false) 저장은 baseURL/모델이 비어 있어도 허용.
  if (enabled) {
    if (!baseUrl || !isValidHttpUrl(baseUrl)) {
      return c.json({ error: "invalid_base_url" }, 400);
    }
    if (!modelId) {
      return c.json({ error: "missing_model_id" }, 400);
    }
  }

  const next: OpencodeExternalEndpoint = {
    enabled,
    // 비활성 저장 시에도 사용자가 적던 값은 보존 (다시 켤 때 재입력 불필요).
    baseUrl: baseUrl || OPENCODE_DEFAULT_EXTERNAL_BASE_URL,
    modelId,
  };
  writeConfig({ ...cfg, opencode: { ...cfg.opencode, external: next } });

  return c.json({ ok: true, ...externalResponse(next) });
});

opencode.post("/external/verify", async (c) => {
  const body = (await c.req.json().catch(() => null)) as
    | { baseUrl?: unknown; modelId?: unknown }
    | null;
  // body 가 있으면 그 값으로(저장 전 «확인»), 없으면 저장된 설정으로 검증.
  const saved = readConfig()?.opencode?.external;
  const baseUrl =
    typeof body?.baseUrl === "string" && body.baseUrl.trim()
      ? body.baseUrl
      : saved?.baseUrl ?? OPENCODE_DEFAULT_EXTERNAL_BASE_URL;
  const modelId =
    typeof body?.modelId === "string" ? body.modelId : saved?.modelId ?? "";

  const result = await probeExternalModels(baseUrl, modelId);
  // probe 는 절대 throw 하지 않으므로 항상 200 — iOS 가 reachable/error 로 분기.
  return c.json(result);
});
