/**
 * codex 잔량 조회의 «순수» 부분 단위 테스트 — rollout jsonl 꼬리에서 마지막
 * token_count.rate_limits 추출. 파일 IO 는 다루지 않는다.
 */
import { describe, it, expect } from "vitest";
import { extractCodexRateLimits } from "./usage.js";

/** 2026-06-01 실측 이벤트 shape 의 한 줄을 만든다. */
function tokenCountLine(rateLimits: unknown): string {
  return JSON.stringify({
    timestamp: "2026-06-01T00:27:19.456Z",
    type: "event_msg",
    payload: { type: "token_count", info: { total_token_usage: {} }, rate_limits: rateLimits },
  });
}

describe("extractCodexRateLimits", () => {
  it("마지막 token_count 의 primary 윈도우를 매핑 (resets_at 초 → ms)", () => {
    const content = [
      tokenCountLine({ primary: { used_percent: 4.0, window_minutes: 10080, resets_at: 1780000000 } }),
      JSON.stringify({ type: "response_item", payload: {} }),
      tokenCountLine({ primary: { used_percent: 9.0, window_minutes: 10080, resets_at: 1780878222 } }),
    ].join("\n");
    const w = extractCodexRateLimits(content);
    expect(w).toEqual([
      { id: "primary", windowMinutes: 10080, usedPercent: 9.0, resetsAt: 1780878222000 },
    ]);
  });

  it("secondary 윈도우도 있으면 함께", () => {
    const content = tokenCountLine({
      primary: { used_percent: 30.5, window_minutes: 300, resets_at: 1780000000 },
      secondary: { used_percent: 12.0, window_minutes: 10080, resets_at: 1780878222 },
    });
    const w = extractCodexRateLimits(content);
    expect(w).toHaveLength(2);
    expect(w?.[0]?.id).toBe("primary");
    expect(w?.[0]?.windowMinutes).toBe(300);
    expect(w?.[1]?.id).toBe("secondary");
  });

  it("rate_limits 없는 파일 / 빈 내용은 null", () => {
    expect(extractCodexRateLimits("")).toBeNull();
    expect(
      extractCodexRateLimits(JSON.stringify({ type: "session_meta", payload: {} })),
    ).toBeNull();
  });

  it("꼬리 청크의 잘린 첫 줄 (partial JSON) 은 건너뛰고 온전한 줄을 찾는다", () => {
    const good = tokenCountLine({
      primary: { used_percent: 5.0, window_minutes: 10080, resets_at: 1780878222 },
    });
    // 잘린 줄이 «마지막» 에 있어도 (쓰는 도중 읽힘) 그 앞의 온전한 스냅샷으로 폴백.
    const truncatedTail = good.slice(0, 40); // "rate_limits" 포함 전이라 그냥 무시됨
    const content = `${good}\n${truncatedTail}`;
    const w = extractCodexRateLimits(content);
    expect(w?.[0]?.usedPercent).toBe(5.0);
  });

  it("used_percent 가 숫자가 아니면 그 윈도우는 제외", () => {
    const content = tokenCountLine({ primary: { used_percent: "9", window_minutes: 10080 } });
    expect(extractCodexRateLimits(content)).toBeNull();
  });
});
