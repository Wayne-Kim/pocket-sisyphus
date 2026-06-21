/**
 * 외부-콘텐츠 오염(taint) 계약 테스트 (CAPABILITY_CAPS.md §2.1·T1·C1 런타임).
 *
 * 단언: 표식의 단조성(해제 없음)·전파·초기 오염(개인-데이터 MCP repo)·오염 세션 EGRESS 기본 deny.
 * 회귀: 비-오염 세션은 종전대로 EGRESS 허용.
 *
 * 격리: POCKET_CLAUDE_CONFIG_DIR 을 tmp 로 — 실제 DB(새 external_content_tainted 컬럼 포함)·config.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

const H = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fsH = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const osH = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pathH = require("node:path") as typeof import("node:path");
  const dir = fsH.mkdtempSync(pathH.join(osH.tmpdir(), "ps-taint-"));
  process.env.POCKET_CLAUDE_CONFIG_DIR = dir;
  return { tmpDir: dir };
});

import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { writeConfig } from "./config.js";
import { insertServer } from "./mcp/store.js";
import { db } from "./db/index.js";
import {
  markSessionTainted,
  isSessionTainted,
  propagateTaint,
  computeInitialTaint,
  sessionEgressAllowed,
  guardTaintedEgress,
} from "./taint.js";

/** 테스트용 세션 row 직접 삽입 — createSession(pty-runner 의존)을 피해 경량으로 컬럼만 검증. */
function insertSession(repoPath = "/repo", tainted = 0): string {
  const id = randomUUID();
  db()
    .prepare(
      `INSERT INTO sessions (id, repo_path, created_at, external_content_tainted)
       VALUES (?, ?, ?, ?)`,
    )
    .run(id, repoPath, Date.now(), tainted);
  return id;
}

beforeEach(() => {
  writeConfig({ port: 3000, tokenHash: "x", createdAt: Date.now() });
  db().prepare("DELETE FROM sessions").run();
});

afterAll(() => {
  fs.rmSync(H.tmpDir, { recursive: true, force: true });
});

describe("markSessionTainted / isSessionTainted — 단조(해제 없음)", () => {
  it("표시 전엔 false, 표시 후 true", () => {
    const s = insertSession();
    expect(isSessionTainted(s)).toBe(false);
    markSessionTainted(s, "test");
    expect(isSessionTainted(s)).toBe(true);
  });

  it("두 번 표시해도 1 유지(멱등) — 절대 0 으로 안 내려감", () => {
    const s = insertSession();
    markSessionTainted(s, "a");
    markSessionTainted(s, "b");
    expect(isSessionTainted(s)).toBe(true);
    // 직접 0 으로 되돌리는 API 가 없음을 보장: mark 는 0→1 만.
    const row = db().prepare("SELECT external_content_tainted AS t FROM sessions WHERE id = ?").get(s) as { t: number };
    expect(row.t).toBe(1);
  });

  it("없는 세션은 false (조회 실패 흡수)", () => {
    expect(isSessionTainted("nope")).toBe(false);
  });
});

describe("propagateTaint — continue/노드/worktree 계승", () => {
  it("오염 from → to 도 오염", () => {
    const from = insertSession("/repo", 1);
    const to = insertSession("/repo", 0);
    propagateTaint(from, to);
    expect(isSessionTainted(to)).toBe(true);
  });

  it("비-오염 from → to 는 그대로(전파 없음)", () => {
    const from = insertSession("/repo", 0);
    const to = insertSession("/repo", 0);
    propagateTaint(from, to);
    expect(isSessionTainted(to)).toBe(false);
  });

  it("from 이 null/undefined 면 no-op", () => {
    const to = insertSession("/repo", 0);
    propagateTaint(null, to);
    propagateTaint(undefined, to);
    expect(isSessionTainted(to)).toBe(false);
  });
});

describe("computeInitialTaint — 개인-데이터 MCP repo 는 오염으로 시작", () => {
  it("repo 에 메일/캘린더 MCP 가 연결되면 true", () => {
    insertServer({
      catalogId: "gmail", label: "g", agent: "claude_code", repoPath: "/repo/mail",
      url: "https://g", scopes: [], writeEnabled: false,
    });
    expect(computeInitialTaint("/repo/mail")).toBe(true);
  });

  it("개인-데이터 MCP 없는 repo 는 false (회귀 0)", () => {
    expect(computeInitialTaint("/repo/clean")).toBe(false);
  });

  it("custom MCP 만 있으면 false (taint 소스 아님 — 다만 EGRESS 라 무인엔 별도 차단)", () => {
    insertServer({
      catalogId: "custom", label: "c", agent: "claude_code", repoPath: "/repo/custom",
      url: "https://c", scopes: [], writeEnabled: false,
    });
    expect(computeInitialTaint("/repo/custom")).toBe(false);
  });
});

describe("sessionEgressAllowed / guardTaintedEgress — 오염 EGRESS 기본 deny(T1)", () => {
  it("오염 세션은 outbound 차단 (HTTP/MCP)", () => {
    const s = insertSession("/repo", 1);
    expect(sessionEgressAllowed(s)).toBe(false);
    expect(guardTaintedEgress(s, "http")).toBe(true); // true = 차단
  });

  it("비-오염 세션은 종전대로 허용 (회귀)", () => {
    const s = insertSession("/repo", 0);
    expect(sessionEgressAllowed(s)).toBe(true);
    expect(guardTaintedEgress(s, "http")).toBe(false);
  });
});
