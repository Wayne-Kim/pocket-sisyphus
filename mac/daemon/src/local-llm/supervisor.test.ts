/**
 * supervisor 순수 함수 단위 테스트.
 *  - buildLlamaServerArgs: flagship 이 기대 serve 인자와 토큰 단위로 일치 (anti-drift),
 *    MTP 없는 모델은 spec 플래그 미포함.
 *  - decideServerAction: adopt / spawn / error-port-occupied 분기.
 */
import { describe, it, expect } from "vitest";
import { buildLlamaServerArgs, decideServerAction, effectiveCtxSize } from "./supervisor.js";
import { getCatalogModel } from "./catalog.js";

const flagship = getCatalogModel("qwen3.6-35b-a3b-q8")!;
const mid = getCatalogModel("qwen3-30b-a3b-q4")!;

describe("buildLlamaServerArgs", () => {
  it("flagship — 기대 serve 토큰과 정확히 일치 (MTP 포함)", () => {
    const args = buildLlamaServerArgs(flagship, {
      host: "127.0.0.1",
      port: 51100,
      ctxSize: 32768,
      modelPath: "/M/Qwen3.6-35B-A3B-Q8_0.gguf",
    });
    expect(args).toEqual([
      "--model", "/M/Qwen3.6-35B-A3B-Q8_0.gguf",
      "--host", "127.0.0.1",
      "--port", "51100",
      "--ctx-size", "32768",
      "--parallel", "1",
      "--n-gpu-layers", "999",
      "--jinja",
      "--mlock",
      "--flash-attn", "on",
      "--temp", "0.6",
      "--top-p", "0.95",
      "--top-k", "20",
      "--min-p", "0",
      "--spec-type", "draft-mtp",
      "--spec-draft-n-max", "2",
    ]);
  });

  it("MTP head 없는 모델은 spec 플래그를 안 붙인다", () => {
    const args = buildLlamaServerArgs(mid, { host: "127.0.0.1", port: 51100, ctxSize: 32768, modelPath: "/m.gguf" });
    expect(args).not.toContain("--spec-type");
    expect(args).not.toContain("draft-mtp");
    // 나머지 공통 플래그는 그대로.
    expect(args).toContain("--mlock");
    expect(args).toContain("--flash-attn");
  });

  it("ctxSize override 반영", () => {
    const args = buildLlamaServerArgs(mid, { host: "127.0.0.1", port: 51100, ctxSize: 8192, modelPath: "/m.gguf" });
    const i = args.indexOf("--ctx-size");
    expect(args[i + 1]).toBe("8192");
  });

  it("ctxNative 초과 시 YaRN rope 플래그 (Qwen3 32k 네이티브 → 128k 는 scale 4)", () => {
    const args = buildLlamaServerArgs(mid, { host: "127.0.0.1", port: 51100, ctxSize: 131072, modelPath: "/m.gguf" });
    const i = args.indexOf("--rope-scaling");
    expect(args[i + 1]).toBe("yarn");
    expect(args[args.indexOf("--rope-scale") + 1]).toBe("4");
    expect(args[args.indexOf("--yarn-orig-ctx") + 1]).toBe("32768");
  });

  it("96k 요청은 scale 3 (workload 에 맞춘 최소 factor — 과한 스케일은 단문 품질 저하)", () => {
    const args = buildLlamaServerArgs(mid, { host: "127.0.0.1", port: 51100, ctxSize: 98304, modelPath: "/m.gguf" });
    expect(args[args.indexOf("--rope-scale") + 1]).toBe("3");
  });

  it("ctxNative 이하면 YaRN 미적용 — flagship(네이티브 256k)은 128k 에도 안 붙는다", () => {
    const a32 = buildLlamaServerArgs(mid, { host: "127.0.0.1", port: 51100, ctxSize: 32768, modelPath: "/m.gguf" });
    expect(a32).not.toContain("--rope-scaling");
    const f128 = buildLlamaServerArgs(flagship, { host: "127.0.0.1", port: 51100, ctxSize: 131072, modelPath: "/m.gguf" });
    expect(f128).not.toContain("--rope-scaling");
  });
});

describe("effectiveCtxSize", () => {
  it("미설정이면 ctxDefault", () => {
    expect(effectiveCtxSize(mid, null)).toBe(32768);
    expect(effectiveCtxSize(mid, undefined)).toBe(32768);
    expect(effectiveCtxSize(mid, 0)).toBe(32768);
  });
  it("오버라이드 통과 + [minToolCtx, ctxMax] clamp (도구호출 모델)", () => {
    expect(effectiveCtxSize(mid, 65536)).toBe(65536);
    // 도구호출 모델은 권장 최소 컨텍스트(16k) 미만으로 절대 기동 안 함 — 4k 요청도 16384 로 바닥 보장.
    expect(effectiveCtxSize(mid, 1024)).toBe(mid.minToolCtx);
    expect(effectiveCtxSize(mid, 1024)).toBe(16384);
    expect(effectiveCtxSize(mid, 1_000_000)).toBe(131072);
    expect(effectiveCtxSize(flagship, 262144)).toBe(262144);
  });
  it("비-tool(분석 전용) 모델은 4096 바닥 — minToolCtx 강제 안 함", () => {
    const analysisOnly = { ...mid, toolCallCapable: false };
    expect(effectiveCtxSize(analysisOnly, 1024)).toBe(4096);
    expect(effectiveCtxSize(analysisOnly, 8192)).toBe(8192);
  });
});

describe("decideServerAction", () => {
  const modelsDir = "/Users/x/Library/Application Support/PocketSisyphus/models";

  it("health OK → adopt (외부 서버 채택)", () => {
    expect(decideServerAction({ healthOk: true, listenerPid: 123, listenerCmd: "llama-server", modelsDir })).toBe("adopt");
  });
  it("점유 없음 → spawn", () => {
    expect(decideServerAction({ healthOk: false, listenerPid: null, listenerCmd: null, modelsDir })).toBe("spawn");
  });
  it("우리 llama-server(MODELS_DIR 인자) stale 점유 → spawn(reclaim)", () => {
    const cmd = `/opt/homebrew/bin/llama-server --model ${modelsDir}/Qwen.gguf`;
    expect(decideServerAction({ healthOk: false, listenerPid: 999, listenerCmd: cmd, modelsDir })).toBe("spawn");
  });
  it("미상 프로세스 점유 → error (남의 것 안 죽임)", () => {
    expect(decideServerAction({ healthOk: false, listenerPid: 555, listenerCmd: "/usr/bin/something-else", modelsDir })).toBe("error-port-occupied");
  });
});
