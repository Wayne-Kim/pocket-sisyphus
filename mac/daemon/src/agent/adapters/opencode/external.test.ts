/**
 * OpenCode 외부 엔드포인트 모드의 순수 로직 + /v1/models 헬스체크 단위 테스트.
 *
 * 회귀 차단의 핵심:
 *  - baseURL 정규화(끝 슬래시 제거) — 안 하면 `${base}//models` 로 404.
 *  - /v1/models 파싱 — OpenAI 호환 { data: [{id}] } 에서 id 만, 중복 제거 + 정렬.
 *  - 판정(decideProbeResult) — 도달/빈목록/모델없음/정상 4갈래가 «막다른 길» 가드의 본체.
 *  - probeExternalModels 가 어떤 실패에도 throw 하지 않고 error 코드로 환원.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  normalizeBaseUrl,
  parseModelsResponse,
  decideProbeResult,
  probeExternalModels,
} from "./external.js";

describe("normalizeBaseUrl", () => {
  it("끝의 슬래시를 제거한다 (한 개/여러 개 모두)", () => {
    expect(normalizeBaseUrl("http://localhost:11434/v1/")).toBe("http://localhost:11434/v1");
    expect(normalizeBaseUrl("http://localhost:11434/v1///")).toBe("http://localhost:11434/v1");
  });
  it("앞뒤 공백을 제거한다", () => {
    expect(normalizeBaseUrl("  http://localhost:11434/v1  ")).toBe("http://localhost:11434/v1");
  });
  it("슬래시 없는 정상 URL 은 그대로", () => {
    expect(normalizeBaseUrl("http://localhost:11434/v1")).toBe("http://localhost:11434/v1");
  });
});

describe("parseModelsResponse", () => {
  it("OpenAI 호환 { data: [{id}] } 에서 id 만 뽑아 정렬", () => {
    const json = { object: "list", data: [{ id: "qwen2.5-coder" }, { id: "llama3.1" }] };
    expect(parseModelsResponse(json)).toEqual(["llama3.1", "qwen2.5-coder"]);
  });
  it("중복 id 는 한 번만", () => {
    const json = { data: [{ id: "a" }, { id: "a" }, { id: "b" }] };
    expect(parseModelsResponse(json)).toEqual(["a", "b"]);
  });
  it("data 가 없거나 형식이 다르면 빈 배열", () => {
    expect(parseModelsResponse(null)).toEqual([]);
    expect(parseModelsResponse({})).toEqual([]);
    expect(parseModelsResponse({ data: "nope" })).toEqual([]);
    expect(parseModelsResponse({ data: [{ name: "no-id" }, 42, null] })).toEqual([]);
  });
});

describe("decideProbeResult", () => {
  it("도달 못 하면 reachable:false + 그 에러 그대로", () => {
    const r = decideProbeResult({
      reachable: false,
      reachError: "unreachable",
      models: [],
      modelId: "x",
      httpStatus: null,
    });
    expect(r).toEqual({
      reachable: false,
      models: [],
      modelPresent: false,
      error: "unreachable",
      httpStatus: null,
    });
  });
  it("도달했지만 목록이 비면 no_models (막다른 길)", () => {
    const r = decideProbeResult({
      reachable: true,
      reachError: null,
      models: [],
      modelId: "x",
      httpStatus: 200,
    });
    expect(r.error).toBe("no_models");
    expect(r.modelPresent).toBe(false);
  });
  it("도달 + 모델은 있으나 설정 modelId 가 목록에 없으면 model_not_found", () => {
    const r = decideProbeResult({
      reachable: true,
      reachError: null,
      models: ["a", "b"],
      modelId: "c",
      httpStatus: 200,
    });
    expect(r.error).toBe("model_not_found");
    expect(r.modelPresent).toBe(false);
  });
  it("도달 + 설정 modelId 가 목록에 있으면 정상(error null)", () => {
    const r = decideProbeResult({
      reachable: true,
      reachError: null,
      models: ["a", "b"],
      modelId: "b",
      httpStatus: 200,
    });
    expect(r.error).toBeNull();
    expect(r.modelPresent).toBe(true);
  });
});

describe("probeExternalModels (fetch mock)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("정상 — 200 + 모델 존재면 reachable + modelPresent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "qwen2.5-coder" }] }), { status: 200 })),
    );
    const r = await probeExternalModels("http://localhost:11434/v1/", "qwen2.5-coder");
    expect(r.reachable).toBe(true);
    expect(r.modelPresent).toBe(true);
    expect(r.error).toBeNull();
  });

  it("연결 거부 — fetch reject 면 unreachable (throw 안 함)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    const r = await probeExternalModels("http://localhost:11434/v1", "x");
    expect(r.reachable).toBe(false);
    expect(r.error).toBe("unreachable");
  });

  it("HTTP 500 — http_error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("oops", { status: 500 })));
    const r = await probeExternalModels("http://localhost:11434/v1", "x");
    expect(r.reachable).toBe(false);
    expect(r.error).toBe("http_error");
    expect(r.httpStatus).toBe(500);
  });

  it("빈 baseURL — 두드리지 않고 unreachable", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    const r = await probeExternalModels("   ", "x");
    expect(r.error).toBe("unreachable");
    expect(f).not.toHaveBeenCalled();
  });
});
