/**
 * 카탈로그 무결성 단위 테스트 — 필드 누락 / id 중복 / 잘못된 MTP 정합을 회귀 차단.
 */
import { describe, it, expect } from "vitest";
import { MODEL_CATALOG, getCatalogModel, DEFAULT_MODEL_ID } from "./catalog.js";

describe("MODEL_CATALOG", () => {
  it("id 가 모두 유일하다", () => {
    const ids = MODEL_CATALOG.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("모든 엔트리가 필수 필드를 갖는다 (양수 크기/RAM, repo/파일 비어있지 않음)", () => {
    for (const m of MODEL_CATALOG) {
      expect(m.hfRepo).toMatch(/\//); // owner/repo
      expect(m.fileName).toMatch(/\.gguf$/);
      expect(m.fileSizeBytes).toBeGreaterThan(0);
      expect(m.minRamBytes).toBeGreaterThan(0);
      expect(m.recommendedRamBytes).toBeGreaterThanOrEqual(m.minRamBytes);
      expect(m.ctxDefault).toBeGreaterThan(0);
      // ctxDefault ≤ ctxNative ≤ ctxMax — 기본값에 YaRN 이 붙거나 clamp 가 기본값을 깎으면 안 된다.
      expect(m.ctxNative).toBeGreaterThanOrEqual(m.ctxDefault);
      expect(m.ctxMax).toBeGreaterThanOrEqual(m.ctxNative);
      expect(m.estRssBytes).toBeGreaterThan(0);
    }
  });

  it("sha256 는 null 이거나 64자리 hex", () => {
    for (const m of MODEL_CATALOG) {
      if (m.sha256 !== null) expect(m.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("DEFAULT_MODEL_ID 와 getCatalogModel 이 카탈로그 안에서 resolve 된다", () => {
    expect(getCatalogModel(DEFAULT_MODEL_ID)).toBeDefined();
    expect(getCatalogModel("nope-not-real")).toBeUndefined();
  });

  it("flagship(35B-A3B)만 MTP head 를 가진다 (Q4 빌드엔 MTP 없음)", () => {
    const mtp = MODEL_CATALOG.filter((m) => m.hasMtpHead).map((m) => m.id);
    expect(mtp).toEqual(["qwen3.6-35b-a3b-q8"]);
  });

  it("도구호출 가능 모델은 권장 최소 컨텍스트가 16k 이상 (4k 침묵 실패 가드)", () => {
    for (const m of MODEL_CATALOG) {
      expect(typeof m.toolCallCapable).toBe("boolean");
      if (m.toolCallCapable) {
        expect(m.minToolCtx).toBeGreaterThanOrEqual(16384);
        // 바닥이 ctxMax 를 넘으면 clamp 가 거꾸로 동작 — minToolCtx ≤ ctxMax 보장.
        expect(m.minToolCtx).toBeLessThanOrEqual(m.ctxMax);
      }
    }
  });

  it("브리프 확장 모델(Qwen3-Coder·Devstral·GLM-Air)이 도구호출 가능으로 담겨 있다", () => {
    for (const id of ["qwen3-coder-30b-a3b-q4", "devstral-small-2507-q4", "glm-4.5-air-q2kxl"]) {
      const m = getCatalogModel(id);
      expect(m, id).toBeDefined();
      expect(m!.toolCallCapable, id).toBe(true);
    }
  });
});
