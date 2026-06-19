/**
 * 로컬 LLM 관리 라우트 — iOS 「로컬 LLM 모델」 화면이 호출.
 *
 *  GET    /api/local-llm/status            — 서버 상태 + 선택 모델 + 다운로드 진행 + 하드웨어 + 바이너리
 *  GET    /api/local-llm/models            — 카탈로그(+downloaded 플래그) + 추천/선택 모델
 *  POST   /api/local-llm/select            — 선택 모델/컨텍스트 크기 저장 (config.localLlm.{selectedModelId,ctxSize})
 *  POST   /api/local-llm/download          — 다운로드 시작
 *  POST   /api/local-llm/download/cancel   — 진행 중 다운로드 취소
 *  DELETE /api/local-llm/models/:id        — 받은 모델 삭제 (디스크 회수)
 *  POST   /api/local-llm/server/start      — 온디맨드 서버 기동 (modelId? — 기본 선택/추천)
 *  POST   /api/local-llm/server/stop       — 우리가 띄운 서버 정지
 *
 * 인증: 다른 /api/* 와 동일하게 bearer (routes/notify.ts 패턴).
 */
import { Hono } from "hono";
import { bearerAuth } from "../auth.js";
import { readConfig, writeConfig } from "../config.js";
import { getCatalogModel } from "../local-llm/catalog.js";
import { getLocalLlmStatus, getCatalogResponse, effectiveModelId } from "../local-llm/status.js";
import { ensureServer, stopServer, switchModel, getServerStatus, effectiveCtxSize } from "../local-llm/supervisor.js";
import {
  startDownload,
  cancelDownload,
  deleteDownloadedModel,
} from "../local-llm/download.js";

export const localLlm = new Hono();

localLlm.use("*", bearerAuth);

localLlm.get("/status", (c) => c.json(getLocalLlmStatus()));

localLlm.get("/models", (c) => c.json(getCatalogResponse()));

localLlm.post("/select", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { modelId?: string; ctxSize?: number | null } | null;
  const modelId = body?.modelId;
  const ctxSize = body?.ctxSize;

  const cfg = readConfig();
  if (!cfg) return c.json({ error: "daemon_not_initialized" }, 500);

  const nextLlm = { ...cfg.localLlm };
  if (modelId !== undefined) {
    if (modelId) {
      if (!getCatalogModel(modelId)) {
        return c.json({ error: "unknown_model" }, 400);
      }
      nextLlm.selectedModelId = modelId;
    }
  }

  if (ctxSize !== undefined) {
    if (ctxSize === null || ctxSize === 0) {
      delete nextLlm.ctxSize;     // 기본값(ctxDefault) 복귀
    } else if (!Number.isInteger(ctxSize) || ctxSize < 4096 || ctxSize > 262_144) {
      return c.json({ error: "invalid_ctx_size" }, 400);
    } else {
      nextLlm.ctxSize = ctxSize;
    }
  }

  writeConfig({ ...cfg, localLlm: nextLlm });

  // 실행 중 서버를 자동 교체하지 않는다 (활성 세션의 백엔드 yank 방지). iOS/Mac 이
  // restartRequired 를 보고 사용자에게 재시작을 안내.
  const running = getServerStatus();
  const targetModelId = nextLlm.selectedModelId ?? effectiveModelId();
  const targetModel = targetModelId ? getCatalogModel(targetModelId) : undefined;
  const targetCtxSize = targetModel ? effectiveCtxSize(targetModel, nextLlm.ctxSize) : null;

  // adopted 외부 서버는 ctxSize 를 모른다(null) → ctx 변경만으로 재시작을 강요하지 않는다.
  const restartRequired =
    (running.state === "ready" || running.state === "adopted") &&
    (running.modelId !== targetModelId ||
      (running.ctxSize !== null && running.ctxSize !== targetCtxSize));

  return c.json({
    ok: true,
    selectedModelId: nextLlm.selectedModelId,
    ctxSize: nextLlm.ctxSize ?? null,
    restartRequired,
  });
});

localLlm.post("/download", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { modelId?: string } | null;
  const model = body?.modelId ? getCatalogModel(body.modelId) : undefined;
  if (!model) return c.json({ error: "unknown_model" }, 400);
  try {
    await startDownload(model);
    return c.json({ ok: true, state: "downloading" });
  } catch (e) {
    const msg = (e as Error).message;
    if (msg === "insufficient_disk") return c.json({ error: "insufficient_disk" }, 400);
    if (msg === "busy") return c.json({ error: "busy" }, 409);
    return c.json({ error: "download_failed", detail: msg }, 500);
  }
});

localLlm.post("/download/cancel", (c) => {
  return c.json({ ok: true, cancelled: cancelDownload() });
});

localLlm.delete("/models/:id", (c) => {
  const model = getCatalogModel(c.req.param("id"));
  if (!model) return c.json({ error: "unknown_model" }, 400);
  // 실행 중 모델이면 거부 (백엔드가 쥐고 있는 파일).
  const running = getServerStatus();
  if (
    (running.state === "ready" || running.state === "adopted") &&
    running.modelId === model.id
  ) {
    return c.json({ error: "model_in_use" }, 409);
  }
  const r = deleteDownloadedModel(model);
  if (!r.ok) return c.json({ error: r.reason ?? "delete_failed" }, 409);
  return c.json({ ok: true });
});

localLlm.post("/server/start", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { modelId?: string };
  const modelId =
    body.modelId && getCatalogModel(body.modelId) ? body.modelId : effectiveModelId();
  // body.modelId 가 현재와 다르고 서버가 이미 떠 있으면 명시적 교체.
  const running = getServerStatus();
  const status =
    body.modelId && running.state === "ready" && running.modelId !== modelId
      ? await switchModel(modelId)
      : await ensureServer(modelId);
  return c.json({ ok: status.state !== "error", server: status });
});

localLlm.post("/server/stop", async (c) => {
  await stopServer();
  return c.json({ ok: true, server: getServerStatus() });
});
