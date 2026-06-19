/**
 * 하드웨어 감지 + 추천 단위 테스트. recommendModel 은 순수 — RAM 만 바꿔 검증.
 */
import { describe, it, expect } from "vitest";
import { detectHardware, recommendModel, type HardwareDeps } from "./hardware.js";
import { MODEL_CATALOG, type CatalogModel } from "./catalog.js";

const GiB = 1024 ** 3;

describe("recommendModel — RAM 티어 매핑", () => {
  it("64GB → flagship(35B-A3B Q8)", () => {
    expect(recommendModel(64 * GiB)).toBe("qwen3.6-35b-a3b-q8");
  });
  it("48GB → 30B-A3B Q4 (flagship RSS 가 예산 초과)", () => {
    expect(recommendModel(48 * GiB)).toBe("qwen3-30b-a3b-q4");
  });
  it("32GB → 30B-A3B Q4", () => {
    expect(recommendModel(32 * GiB)).toBe("qwen3-30b-a3b-q4");
  });
  it("24GB → 14B Q4", () => {
    expect(recommendModel(24 * GiB)).toBe("qwen3-14b-q4");
  });
  it("16GB → 8B Q4", () => {
    expect(recommendModel(16 * GiB)).toBe("qwen3-8b-q4");
  });
  it("12GB → 8B Q4 (허용 fallback)", () => {
    expect(recommendModel(12 * GiB)).toBe("qwen3-8b-q4");
  });
  it("8GB → null (어떤 모델도 권장 불가)", () => {
    expect(recommendModel(8 * GiB)).toBeNull();
  });

  it("도구호출 불가(분석 전용) 모델은 RAM 이 충분해도 추천 후보에서 제외", () => {
    const base = MODEL_CATALOG[0];
    // 가장 능력 좋아 보이는(거대 estRss) 분석 전용 모델 — 그래도 추천되면 안 된다.
    const analysisOnly: CatalogModel = {
      ...base,
      id: "analysis-only-huge",
      toolCallCapable: false,
      estRssBytes: 1 * GiB, // 작아서 예산엔 무조건 들어가지만 tool 불가라 제외돼야 함
      minRamBytes: 4 * GiB,
      recommendedRamBytes: 4 * GiB,
    };
    const toolModel: CatalogModel = {
      ...base,
      id: "tool-ok",
      toolCallCapable: true,
      estRssBytes: 2 * GiB,
      minRamBytes: 4 * GiB,
      recommendedRamBytes: 4 * GiB,
    };
    expect(recommendModel(64 * GiB, [analysisOnly])).toBeNull();
    expect(recommendModel(64 * GiB, [analysisOnly, toolModel])).toBe("tool-ok");
  });
});

describe("detectHardware — dep 주입", () => {
  it("주입된 deps 를 그대로 매핑", () => {
    const deps: HardwareDeps = {
      totalmem: () => 64 * GiB,
      sysctl: (k) =>
        k === "machdep.cpu.brand_string" ? "Apple M4 Pro" : k === "hw.model" ? "Mac16,11" : null,
      gpuCores: () => 20,
    };
    expect(detectHardware(deps)).toEqual({
      totalRamBytes: 64 * GiB,
      chipBrand: "Apple M4 Pro",
      modelId: "Mac16,11",
      gpuCores: 20,
    });
  });

  it("sysctl/gpu 실패 시 null 로 떨어진다 (RAM 은 항상)", () => {
    const deps: HardwareDeps = {
      totalmem: () => 16 * GiB,
      sysctl: () => null,
      gpuCores: () => null,
    };
    expect(detectHardware(deps)).toEqual({
      totalRamBytes: 16 * GiB,
      chipBrand: null,
      modelId: null,
      gpuCores: null,
    });
  });
});
