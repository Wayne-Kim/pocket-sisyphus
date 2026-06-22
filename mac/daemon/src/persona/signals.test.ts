import { describe, expect, it } from "vitest";
import {
  classifyAscFailure,
  isSignalFailure,
  serializeSignals,
  parseSignals,
  classifyScheduledOutcome,
  shouldNotifyScheduledOutcome,
  type CollectSignals,
} from "./signals.js";
import { formatSignalsLine } from "../notify/index.js";

describe("classifyAscFailure — 실행 시점 ASC 실패 분류", () => {
  it("status 401/403 → auth (키 만료·폐기·권한)", () => {
    expect(classifyAscFailure(Object.assign(new Error("ASC 401 x"), { status: 401 }))).toBe("auth");
    expect(classifyAscFailure(Object.assign(new Error("ASC 403 x"), { status: 403 }))).toBe("auth");
  });

  it("status 404 → app_id", () => {
    expect(classifyAscFailure(Object.assign(new Error("ASC 404 x"), { status: 404 }))).toBe("app_id");
  });

  it("resolveAscAppId 의 «앱 없음 / 찾지 못함» 은 status 없이도 app_id", () => {
    expect(classifyAscFailure(new Error("앱 없음: 123"))).toBe("app_id");
    expect(classifyAscFailure(new Error("번들 ID 로 앱을 찾지 못함: com.x"))).toBe("app_id");
  });

  it("status 없는 메시지 «ASC 401/403» 도 auth 로 폴백", () => {
    expect(classifyAscFailure(new Error("ASC 403 /v1/apps: forbidden"))).toBe("auth");
  });

  it("5xx·LAN 차단·타임아웃·기타는 network (일시 blip 을 키 만료로 오인 금지)", () => {
    expect(classifyAscFailure(Object.assign(new Error("ASC 503 x"), { status: 503 }))).toBe("network");
    expect(classifyAscFailure(new Error("LAN 전용 모드와 충돌 — App Store Connect outbound 차단됨"))).toBe("network");
    expect(classifyAscFailure(new Error("The operation was aborted due to timeout"))).toBe("network");
    expect(classifyAscFailure(new Error("segment 500"))).toBe("network");
    expect(classifyAscFailure("weird")).toBe("network");
  });
});

describe("isSignalFailure — 실패 4종만 warning 대상", () => {
  it("key_missing/auth/app_id/network 는 실패", () => {
    for (const state of ["key_missing", "auth", "app_id", "network"] as const) {
      expect(isSignalFailure({ state } as never)).toBe(true);
    }
  });
  it("used/empty/off 는 실패 아님", () => {
    expect(isSignalFailure({ state: "used", count: 3 })).toBe(false);
    expect(isSignalFailure({ state: "empty" })).toBe(false);
    expect(isSignalFailure({ state: "off" })).toBe(false);
  });
});

describe("serializeSignals / parseSignals — round-trip + 방어", () => {
  it("정상 round-trip", () => {
    const sig: CollectSignals = { store: { state: "used", count: 12 }, crash: { state: "auth" } };
    expect(parseSignals(serializeSignals(sig))).toEqual(sig);
  });
  it("null/빈/깨진 JSON → null (카드 숨김)", () => {
    expect(parseSignals(null)).toBeNull();
    expect(parseSignals("")).toBeNull();
    expect(parseSignals("{ not json")).toBeNull();
    expect(parseSignals('{"store":{"state":"bogus"},"crash":{"state":"off"}}')).toBeNull();
  });
});

describe("formatSignalsLine — Discord 완료 알림 한 줄", () => {
  it("used 와 실패만 싣는다", () => {
    expect(
      formatSignalsLine({ store: { state: "used", count: 12 }, crash: { state: "network" } }),
    ).toBe("Store reviews: 12 used · Crashes: network error");
  });

  it("off/empty 만이면 빈 문자열 (정상/안 켬은 침묵 → 필드 안 뜸)", () => {
    expect(formatSignalsLine({ store: { state: "off" }, crash: { state: "off" } })).toBe("");
    expect(formatSignalsLine({ store: { state: "empty" }, crash: { state: "empty" } })).toBe("");
    expect(formatSignalsLine({ store: { state: "empty" }, crash: { state: "off" } })).toBe("");
  });

  it("한쪽만 실패면 그 한쪽만", () => {
    expect(
      formatSignalsLine({ store: { state: "empty" }, crash: { state: "app_id" } }),
    ).toBe("Crashes: app id error");
    expect(
      formatSignalsLine({ store: { state: "key_missing" }, crash: { state: "key_missing" } }),
    ).toBe("Store reviews: key not set · Crashes: key not set");
  });
});

describe("classifyScheduledOutcome — settle 상태 + 인입 건수 → 결말", () => {
  it("ok + N(≥1) → new", () => {
    expect(classifyScheduledOutcome("ok", 1)).toBe("new");
    expect(classifyScheduledOutcome("ok", 7)).toBe("new");
  });
  it("ok + 0 → empty (정상 종료·빈손)", () => {
    expect(classifyScheduledOutcome("ok", 0)).toBe("empty");
  });
  it("error/timeout → failed (건수 무관)", () => {
    expect(classifyScheduledOutcome("error", 0)).toBe("failed");
    expect(classifyScheduledOutcome("timeout", 3)).toBe("failed");
  });
});

describe("shouldNotifyScheduledOutcome — 알림 폭주 억제 (앱 카드는 항상, 알림만 가린다)", () => {
  it("new 는 항상 알린다 (직전이 무엇이든·새 결재 대상)", () => {
    expect(shouldNotifyScheduledOutcome(null, { outcome: "new" })).toBe(true);
    expect(shouldNotifyScheduledOutcome({ outcome: "new" }, { outcome: "new" })).toBe(true);
    expect(shouldNotifyScheduledOutcome({ outcome: "empty" }, { outcome: "new" })).toBe(true);
    expect(shouldNotifyScheduledOutcome({ outcome: "failed", error: "x" }, { outcome: "new" })).toBe(true);
  });

  it("첫 결말(직전 없음)은 항상 알린다", () => {
    expect(shouldNotifyScheduledOutcome(null, { outcome: "empty" })).toBe(true);
    expect(shouldNotifyScheduledOutcome(null, { outcome: "failed", error: "boom" })).toBe(true);
  });

  it("empty 가 연속이면 억제 (여전히 빈손을 매일 반복 통지 안 함)", () => {
    expect(shouldNotifyScheduledOutcome({ outcome: "empty" }, { outcome: "empty" })).toBe(false);
  });

  it("empty 직전이 empty 가 아니면 알린다 (상태 전이)", () => {
    expect(shouldNotifyScheduledOutcome({ outcome: "new" }, { outcome: "empty" })).toBe(true);
    expect(shouldNotifyScheduledOutcome({ outcome: "failed", error: "x" }, { outcome: "empty" })).toBe(true);
  });

  it("failed 가 연속이고 사유가 같으면 억제 (매일 같은 실패 폭주 방지)", () => {
    expect(
      shouldNotifyScheduledOutcome(
        { outcome: "failed", error: "agent_missing: codex" },
        { outcome: "failed", error: "agent_missing: codex" },
      ),
    ).toBe(false);
    // 공백/길이 변형은 같은 사유로 본다 (정규화).
    expect(
      shouldNotifyScheduledOutcome(
        { outcome: "failed", error: "boom" },
        { outcome: "failed", error: "  boom  " },
      ),
    ).toBe(false);
  });

  it("failed 인데 사유가 바뀌면 다시 알린다 (새 고장)", () => {
    expect(
      shouldNotifyScheduledOutcome(
        { outcome: "failed", error: "network" },
        { outcome: "failed", error: "agent_missing" },
      ),
    ).toBe(true);
  });

  it("직전이 failed 가 아니면 failed 를 알린다 (정상→고장 전이)", () => {
    expect(shouldNotifyScheduledOutcome({ outcome: "empty" }, { outcome: "failed", error: "x" })).toBe(true);
    expect(shouldNotifyScheduledOutcome({ outcome: "new" }, { outcome: "failed", error: "x" })).toBe(true);
  });
});
