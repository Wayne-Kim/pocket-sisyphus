/**
 * cron/schedule — 순수 croner 래퍼 테스트 (DB 불필요).
 */
import { describe, it, expect } from "vitest";
import { validateSchedule, nextRuns, nextRun } from "./schedule.js";

describe("validateSchedule", () => {
  it("정상 5필드 식은 valid", () => {
    expect(validateSchedule("0 9 * * 1-5", "Asia/Seoul")).toEqual({ valid: true });
    expect(validateSchedule("*/15 * * * *")).toEqual({ valid: true });
  });

  it("빈 식은 invalid + 사유", () => {
    const r = validateSchedule("");
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.error.length).toBeGreaterThan(0);
  });

  it("잘못된 패턴은 invalid + 사유", () => {
    const r = validateSchedule("not a cron expr");
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.error.length).toBeGreaterThan(0);
  });

  it("잘못된 타임존은 invalid", () => {
    const r = validateSchedule("0 9 * * *", "Not/AZone");
    expect(r.valid).toBe(false);
  });
});

describe("nextRuns", () => {
  it("요청한 개수만큼 미래 timestamp 를 오름차순으로 돌려준다", () => {
    const runs = nextRuns("0 9 * * 1-5", "Asia/Seoul", 3);
    expect(runs).toHaveLength(3);
    expect(runs[0]).toBeLessThan(runs[1]!);
    expect(runs[1]).toBeLessThan(runs[2]!);
    // 전부 미래.
    for (const t of runs) expect(t).toBeGreaterThan(Date.now());
  });

  it("평일 9시(Asia/Seoul)는 주말을 건너뛴다", () => {
    const runs = nextRuns("0 9 * * 1-5", "Asia/Seoul", 10);
    for (const t of runs) {
      // KST 기준 요일 — UTC+9.
      const dow = new Date(t + 9 * 3600 * 1000).getUTCDay();
      expect(dow).toBeGreaterThanOrEqual(1);
      expect(dow).toBeLessThanOrEqual(5);
    }
  });

  it("잘못된 식은 빈 배열", () => {
    expect(nextRuns("garbage", null, 3)).toEqual([]);
  });
});

describe("nextRun", () => {
  it("다음 1회 또는 null", () => {
    expect(typeof nextRun("0 0 * * *")).toBe("number");
    expect(nextRun("garbage")).toBeNull();
  });
});
