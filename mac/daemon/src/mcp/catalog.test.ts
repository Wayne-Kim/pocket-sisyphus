/**
 * mcp/catalog + mcp/health 순수 단위 테스트 — 최소권한 scope 계산과 custody 상태 도출.
 */
import { describe, it, expect } from "vitest";
import { getCatalogEntry, resolveScopes } from "./catalog.js";
import { deriveStatus, isExpired } from "./health.js";
import type { McpServerConfig } from "../config.js";

describe("resolveScopes — 최소권한", () => {
  it("write=false 면 읽기 전용 scope 만", () => {
    const cal = getCatalogEntry("google_calendar")!;
    const scopes = resolveScopes(cal, false);
    expect(scopes).toEqual(cal.readScopes);
    expect(scopes.some((s) => s.endsWith("calendar.events"))).toBe(false);
  });

  it("write=true 면 읽기+쓰기 scope (중복 제거)", () => {
    const cal = getCatalogEntry("google_calendar")!;
    const scopes = resolveScopes(cal, true);
    expect(scopes).toEqual([...cal.readScopes, ...cal.writeScopes]);
    expect(new Set(scopes).size).toBe(scopes.length);
  });
});

describe("health — custody 상태 도출", () => {
  const base: McpServerConfig = {
    id: "x",
    catalogId: "gmail",
    label: "Gmail",
    agent: "claude_code",
    repoPath: "/tmp/x",
    url: "https://x",
    scopes: [],
    writeEnabled: false,
    status: "connected",
    createdAt: 0,
  };

  it("connected + 만료 지남 → expired 로 승격", () => {
    const s = { ...base, tokenExpiresAt: 1000 };
    expect(isExpired(s, 2000)).toBe(true);
    expect(deriveStatus(s, 2000)).toBe("expired");
  });

  it("connected + 만료 전 → connected 유지", () => {
    const s = { ...base, tokenExpiresAt: 5000 };
    expect(deriveStatus(s, 2000)).toBe("connected");
  });

  it("unconfigured 는 그대로", () => {
    expect(deriveStatus({ ...base, status: "unconfigured" })).toBe("unconfigured");
  });
});
