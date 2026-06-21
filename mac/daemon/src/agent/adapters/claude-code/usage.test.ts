/**
 * claude_code 잔량 조회의 «순수» 부분 단위 테스트 — oauth/usage 응답 매핑 +
 * Keychain JSON 토큰 추출. 네트워크/키체인 exec 는 여기서 다루지 않는다 (수동 검증).
 */
import { describe, it, expect } from "vitest";
import { extractAccessToken, mapClaudeOauthUsage } from "./usage.js";

describe("mapClaudeOauthUsage", () => {
  // 2026-06-02 실측 응답 shape.
  const sample = {
    five_hour: { utilization: 7.0, resets_at: "2026-06-02T15:40:00.856226+00:00" },
    seven_day: { utilization: 47.0, resets_at: "2026-06-04T07:00:00.856254+00:00" },
    seven_day_oauth_apps: null,
    seven_day_opus: null,
    seven_day_sonnet: { utilization: 0.0, resets_at: null },
    extra_usage: { is_enabled: false },
  };

  it("five_hour / seven_day 를 windowMinutes 와 함께 매핑", () => {
    const w = mapClaudeOauthUsage(sample);
    expect(w).toHaveLength(2); // sonnet 은 0%+resets null = 비활성 → 제외
    expect(w[0]).toEqual({
      id: "five_hour",
      windowMinutes: 300,
      usedPercent: 7.0,
      resetsAt: Date.parse("2026-06-02T15:40:00.856226+00:00"),
    });
    expect(w[1]?.id).toBe("seven_day");
    expect(w[1]?.windowMinutes).toBe(10080);
    expect(w[1]?.usedPercent).toBe(47.0);
  });

  it("모델별 주간 윈도우는 의미 있는 값일 때만 포함", () => {
    const w = mapClaudeOauthUsage({
      ...sample,
      seven_day_opus: { utilization: 12.5, resets_at: "2026-06-04T07:00:00+00:00" },
    });
    const opus = w.find((x) => x.id === "seven_day_opus");
    expect(opus?.usedPercent).toBe(12.5);
    expect(opus?.windowMinutes).toBe(10080);
  });

  it("윈도우 누락 / null / 잘못된 타입은 조용히 건너뛴다", () => {
    expect(mapClaudeOauthUsage({})).toEqual([]);
    expect(mapClaudeOauthUsage({ five_hour: null, seven_day: "garbage" })).toEqual([]);
    expect(
      mapClaudeOauthUsage({ five_hour: { utilization: "7", resets_at: 123 } }),
    ).toEqual([]);
  });

  it("resets_at 파싱 실패는 null 로 흡수하고 윈도우는 유지", () => {
    const w = mapClaudeOauthUsage({
      five_hour: { utilization: 3.0, resets_at: "not-a-date" },
    });
    expect(w).toHaveLength(1);
    expect(w[0]?.resetsAt).toBeNull();
  });
});

describe("extractAccessToken", () => {
  it("claudeAiOauth.accessToken 추출", () => {
    const raw = JSON.stringify({
      claudeAiOauth: { accessToken: "sk-ant-oat01-xxx", refreshToken: "r" },
    });
    expect(extractAccessToken(raw)).toBe("sk-ant-oat01-xxx");
  });

  it("비-JSON / 키 누락 / 빈 토큰은 null", () => {
    expect(extractAccessToken("not json")).toBeNull();
    expect(extractAccessToken("{}")).toBeNull();
    expect(extractAccessToken(JSON.stringify({ claudeAiOauth: { accessToken: "" } }))).toBeNull();
  });
});
