/**
 * mcp/policy — 능력 클래스 분류(§2.2)·taint 소스·무인 안전 평가의 순수 단위 테스트.
 * 파일/네트워크 IO 없이 분류 «규칙» 자체를 직접 단언한다.
 */
import { describe, it, expect } from "vitest";
import {
  classifyCatalogEntry,
  classifyServer,
  isCappedClass,
  isTaintSourceServer,
  cappedServers,
  unattendedAllowedServers,
  hasTaintSource,
  evaluateUnattendedMcp,
  UNATTENDED_TRIFECTA_DENIED,
} from "./policy.js";
import type { McpServerConfig } from "../config.js";

function srv(over: Partial<McpServerConfig>): McpServerConfig {
  return {
    id: over.id ?? "id",
    catalogId: over.catalogId ?? "custom",
    label: "x",
    agent: "claude_code",
    repoPath: over.repoPath ?? "/repo",
    url: "https://x",
    scopes: [],
    writeEnabled: over.writeEnabled ?? false,
    status: "connected",
    createdAt: 0,
    ...over,
  };
}

describe("classifyCatalogEntry / classifyServer (§2.2)", () => {
  it("개인-데이터 읽기 전용 → READ", () => {
    expect(classifyCatalogEntry("gmail", false)).toBe("READ");
    expect(classifyCatalogEntry("google_calendar", false)).toBe("READ");
    expect(classifyServer(srv({ catalogId: "gmail", writeEnabled: false }))).toBe("READ");
  });

  it("개인-데이터 쓰기 opt-in → SOURCE_WRITE (캡 대상)", () => {
    expect(classifyCatalogEntry("gmail", true)).toBe("SOURCE_WRITE");
    expect(classifyCatalogEntry("google_calendar", true)).toBe("SOURCE_WRITE");
    expect(classifyServer(srv({ catalogId: "gmail", writeEnabled: true }))).toBe("SOURCE_WRITE");
  });

  it("custom / 미지 카탈로그 → EGRESS (M2: 분류 불명은 보수적으로 차단)", () => {
    expect(classifyCatalogEntry("custom", false)).toBe("EGRESS");
    expect(classifyCatalogEntry("custom", true)).toBe("EGRESS");
    expect(classifyCatalogEntry("some_unknown_thing", false)).toBe("EGRESS");
    expect(classifyServer(srv({ catalogId: "custom" }))).toBe("EGRESS");
  });
});

describe("isCappedClass — EGRESS·SOURCE_WRITE 만 캡 대상", () => {
  it("READ·LOCAL 은 허용", () => {
    expect(isCappedClass("READ")).toBe(false);
    expect(isCappedClass("LOCAL")).toBe(false);
  });
  it("EGRESS·SOURCE_WRITE 는 캡", () => {
    expect(isCappedClass("EGRESS")).toBe(true);
    expect(isCappedClass("SOURCE_WRITE")).toBe(true);
  });
});

describe("isTaintSourceServer — 개인-데이터(메일/캘린더)", () => {
  it("gmail·calendar 는 읽기든 쓰기든 taint 소스", () => {
    expect(isTaintSourceServer(srv({ catalogId: "gmail", writeEnabled: false }))).toBe(true);
    expect(isTaintSourceServer(srv({ catalogId: "google_calendar", writeEnabled: true }))).toBe(true);
  });
  it("custom 은 taint 소스로 세지 않는다 (정체 불명 — 다만 EGRESS 라 무인에선 차단)", () => {
    expect(isTaintSourceServer(srv({ catalogId: "custom" }))).toBe(false);
  });
});

describe("evaluateUnattendedMcp — 무인 안전 평가(C1/M3)", () => {
  it("READ 만 있으면 safe (읽기 전용 메일/캘린더는 무인 허용)", () => {
    const servers = [srv({ id: "a", catalogId: "gmail", writeEnabled: false })];
    const r = evaluateUnattendedMcp(servers);
    expect(r.safe).toBe(true);
    expect(r.capped).toHaveLength(0);
    expect(unattendedAllowedServers(servers)).toHaveLength(1);
  });

  it("쓰기 메일이 섞이면 unsafe (캡 대상 노출)", () => {
    const servers = [
      srv({ id: "a", catalogId: "gmail", writeEnabled: false }),
      srv({ id: "b", catalogId: "gmail", writeEnabled: true }),
    ];
    const r = evaluateUnattendedMcp(servers);
    expect(r.safe).toBe(false);
    expect(r.capped.map((s) => s.id)).toEqual(["b"]);
    expect(cappedServers(servers).map((s) => s.id)).toEqual(["b"]);
  });

  it("custom(EGRESS)도 unsafe", () => {
    const r = evaluateUnattendedMcp([srv({ id: "c", catalogId: "custom" })]);
    expect(r.safe).toBe(false);
    expect(r.capped.map((s) => s.id)).toEqual(["c"]);
  });

  it("서버가 없으면 safe", () => {
    expect(evaluateUnattendedMcp([]).safe).toBe(true);
  });
});

describe("hasTaintSource", () => {
  it("개인-데이터 서버가 하나라도 있으면 true", () => {
    expect(hasTaintSource([srv({ catalogId: "gmail" })])).toBe(true);
    expect(hasTaintSource([srv({ catalogId: "custom" })])).toBe(false);
    expect(hasTaintSource([])).toBe(false);
  });
});

it("UNATTENDED_TRIFECTA_DENIED 는 안정적 머신 코드", () => {
  expect(UNATTENDED_TRIFECTA_DENIED).toBe("unattended_trifecta_denied");
});
