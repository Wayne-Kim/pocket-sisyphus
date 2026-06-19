/**
 * `buildOpencodeConfig` — opencode.json 프로바이더 본문이 우리 로컬 서버를 OpenAI 호환
 * 프로바이더로 정확히 front 하는지. 이게 틀어지면 opencode 가 (키도 없이) 공식 API 로
 * 나가려다 실패하거나 모델을 못 찾는다.
 */
import { describe, it, expect } from "vitest";
import {
  buildOpencodeConfig,
  OPENCODE_PROVIDER_ID,
  OPENCODE_API_KEY,
} from "./config.js";
import { LLM_OPENAI_BASE_URL } from "../../../local-llm/paths.js";

describe("buildOpencodeConfig", () => {
  const cfg = buildOpencodeConfig("qwen3.6-35b-a3b-q8") as any;

  it("@ai-sdk/openai-compatible 프로바이더로 로컬 서버를 가리킨다", () => {
    const p = cfg.provider[OPENCODE_PROVIDER_ID];
    expect(p.npm).toBe("@ai-sdk/openai-compatible");
    expect(p.options.baseURL).toBe(LLM_OPENAI_BASE_URL);
    expect(p.options.baseURL).toContain("127.0.0.1:51100/v1");
    expect(p.options.apiKey).toBe(OPENCODE_API_KEY);
    expect(p.options.apiKey).not.toBe("");
  });

  it("모델이 provider.models 에 등록되고 기본 model 이 <id>/<modelId> 형식", () => {
    const p = cfg.provider[OPENCODE_PROVIDER_ID];
    expect(p.models["qwen3.6-35b-a3b-q8"]).toBeTruthy();
    expect(cfg.model).toBe(`${OPENCODE_PROVIDER_ID}/qwen3.6-35b-a3b-q8`);
  });

  it("schema 키를 박아 opencode 가 검증/자동완성할 수 있게 한다", () => {
    expect(cfg.$schema).toBe("https://opencode.ai/config.json");
  });

  it("모델 id 가 바뀌면 provider.models 와 기본 model 둘 다 따라간다", () => {
    const other = buildOpencodeConfig("qwen3-8b-q4") as any;
    expect(other.provider[OPENCODE_PROVIDER_ID].models["qwen3-8b-q4"]).toBeTruthy();
    expect(other.model).toBe(`${OPENCODE_PROVIDER_ID}/qwen3-8b-q4`);
  });

  it("외부 엔드포인트 모드 — opts.baseUrl 을 주면 그 baseURL 로 front (번들 서버 우회)", () => {
    const ext = buildOpencodeConfig("qwen2.5-coder", {
      baseUrl: "http://localhost:11434/v1",
    }) as any;
    const p = ext.provider[OPENCODE_PROVIDER_ID];
    expect(p.options.baseURL).toBe("http://localhost:11434/v1");
    expect(p.options.baseURL).not.toContain("127.0.0.1:51100");
    expect(p.models["qwen2.5-coder"]).toBeTruthy();
    expect(ext.model).toBe(`${OPENCODE_PROVIDER_ID}/qwen2.5-coder`);
  });

  it("opts 없으면 기본은 번들 llama-server", () => {
    const def = buildOpencodeConfig("qwen3-8b-q4") as any;
    expect(def.provider[OPENCODE_PROVIDER_ID].options.baseURL).toBe(LLM_OPENAI_BASE_URL);
  });

  it("기본 — permission 키 없음 (opencode 기본 정책: TUI 안에서 사람이 결재)", () => {
    expect(cfg.permission).toBeUndefined();
  });

  it("bypassPermissions → permission: \"allow\" (전 도구 자동 승인, YOLO)", () => {
    const yolo = buildOpencodeConfig("qwen3-8b-q4", { bypassPermissions: true }) as any;
    expect(yolo.permission).toBe("allow");
  });

  it("bypassPermissions:false 면 permission 키를 생략", () => {
    const noBypass = buildOpencodeConfig("qwen3-8b-q4", { bypassPermissions: false }) as any;
    expect(noBypass.permission).toBeUndefined();
  });
});
