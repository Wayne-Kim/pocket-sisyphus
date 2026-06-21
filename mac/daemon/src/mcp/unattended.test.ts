/**
 * 무인 trifecta 하드 차단 계약 테스트 (CAPABILITY_CAPS.md §C1/M3/M1·M2).
 *
 * 단언:
 *  - 무인 경로에서 EGRESS·SOURCE_WRITE(또는 비-pocket 정체불명) MCP 가 `.mcp.json` 에 «미등록»
 *    임을 보장하는 필터/머티리얼라이즈.
 *  - taint 소스(개인-데이터 쓰기 MCP)+EGRESS 가 연결된 repo 의 무인 실행이 시작 전 «정적 거부».
 *  - READ 전용(읽기 메일/캘린더)·MCP 없는 repo 는 ok(회귀 0).
 *
 * 격리: POCKET_CLAUDE_CONFIG_DIR 을 tmp 로 박아 실제 config.json(0600)·DB·`.mcp.json` 을 쓰되
 * 운영 경로엔 손대지 않는다(routes/mcp.test.ts 와 동일).
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

const H = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fsH = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const osH = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pathH = require("node:path") as typeof import("node:path");
  const dir = fsH.mkdtempSync(pathH.join(osH.tmpdir(), "ps-caps-cfg-"));
  const repo = fsH.mkdtempSync(pathH.join(osH.tmpdir(), "ps-caps-repo-"));
  process.env.POCKET_CLAUDE_CONFIG_DIR = dir;
  return { tmpDir: dir, repoDir: repo };
});

import fs from "node:fs";
import path from "node:path";
import { writeConfig } from "../config.js";
import { insertServer, listServers } from "./store.js";
import {
  registerNative,
  serverKey,
  filterMcpServersForUnattended,
  cappedMcpJsonKeys,
  materializeUnattendedMcpJson,
} from "./native.js";
import { guardUnattendedRepo, prepareUnattendedCwd, repoHasUnattendedAutomation } from "./unattended.js";
import { insertCronJob } from "../cron/store.js";
import { db } from "../db/index.js";

const mcpJsonPath = (repo: string) => path.join(repo, ".mcp.json");
function readMcp(repo: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(mcpJsonPath(repo), "utf8")).mcpServers;
}

beforeEach(() => {
  writeConfig({ port: 3000, tokenHash: "x", createdAt: Date.now() });
  try { fs.rmSync(mcpJsonPath(H.repoDir), { force: true }); } catch { /* noop */ }
  db().prepare("DELETE FROM cron_jobs").run();
});

afterAll(() => {
  fs.rmSync(H.tmpDir, { recursive: true, force: true });
  fs.rmSync(H.repoDir, { recursive: true, force: true });
});

describe("filterMcpServersForUnattended (M1/M3 — 순수)", () => {
  it("pocket READ 는 남기고, pocket 캡(EGRESS/SOURCE_WRITE)·비-pocket·orphan 은 제거", () => {
    const readGmail = insertServer({
      catalogId: "gmail", label: "g", agent: "claude_code", repoPath: H.repoDir,
      url: "https://g", scopes: [], writeEnabled: false,
    });
    const writeGmail = insertServer({
      catalogId: "gmail", label: "gw", agent: "claude_code", repoPath: H.repoDir,
      url: "https://gw", scopes: [], writeEnabled: true,
    });
    const custom = insertServer({
      catalogId: "custom", label: "c", agent: "claude_code", repoPath: H.repoDir,
      url: "https://c", scopes: [], writeEnabled: false,
    });
    const mcpServers = {
      [serverKey(readGmail)]: { type: "http", url: "https://g" },     // READ → 남김
      [serverKey(writeGmail)]: { type: "http", url: "https://gw" },   // SOURCE_WRITE → 제거
      [serverKey(custom)]: { type: "http", url: "https://c" },        // EGRESS → 제거
      pocket_gmail_orphan99: { type: "http", url: "https://o" },      // orphan pocket → 제거
      hand_added_server: { type: "http", url: "https://h" },          // 비-pocket → 제거
    };
    const { kept, removed } = filterMcpServersForUnattended(mcpServers, listServers());
    expect(Object.keys(kept)).toEqual([serverKey(readGmail)]);
    expect(removed.sort()).toEqual(
      [serverKey(writeGmail), serverKey(custom), "pocket_gmail_orphan99", "hand_added_server"].sort(),
    );
  });
});

describe("guardUnattendedRepo + cappedMcpJsonKeys (C1/M3 정적 거부)", () => {
  it("쓰기 메일(SOURCE_WRITE)이 .mcp.json 에 박혀 있으면 무인 실행 거부", () => {
    const writeGmail = insertServer({
      catalogId: "gmail", label: "gw", agent: "claude_code", repoPath: H.repoDir,
      url: "https://gw", scopes: [], writeEnabled: true,
    });
    registerNative(writeGmail);
    expect(cappedMcpJsonKeys(H.repoDir, listServers())).toEqual([serverKey(writeGmail)]);
    const g = guardUnattendedRepo(H.repoDir);
    expect(g.ok).toBe(false);
    if (!g.ok) {
      expect(g.code).toBe("unattended_trifecta_denied");
      expect(g.capped).toEqual([serverKey(writeGmail)]);
    }
  });

  it("custom(EGRESS) MCP 도 거부", () => {
    const custom = insertServer({
      catalogId: "custom", label: "c", agent: "claude_code", repoPath: H.repoDir,
      url: "https://c", scopes: [], writeEnabled: false,
    });
    registerNative(custom);
    expect(guardUnattendedRepo(H.repoDir).ok).toBe(false);
  });

  it("읽기 전용 메일만 연결되면 ok (무인 허용 — EGRESS leg 없음)", () => {
    const readGmail = insertServer({
      catalogId: "gmail", label: "g", agent: "claude_code", repoPath: H.repoDir,
      url: "https://g", scopes: [], writeEnabled: false,
    });
    registerNative(readGmail);
    expect(cappedMcpJsonKeys(H.repoDir, listServers())).toEqual([]);
    expect(guardUnattendedRepo(H.repoDir).ok).toBe(true);
  });

  it(".mcp.json 이 없는 repo(절대다수)는 ok — 회귀 0", () => {
    expect(guardUnattendedRepo(H.repoDir).ok).toBe(true);
  });
});

describe("materializeUnattendedMcpJson (C2 격리 — worktree)", () => {
  it("캡 대상을 제거하고 READ 만 남게 다시 쓴다 (무인 세션이 미연결로 시작)", () => {
    const readGmail = insertServer({
      catalogId: "gmail", label: "g", agent: "claude_code", repoPath: H.repoDir,
      url: "https://g", scopes: [], writeEnabled: false,
    });
    const writeGmail = insertServer({
      catalogId: "gmail", label: "gw", agent: "claude_code", repoPath: H.repoDir,
      url: "https://gw", scopes: [], writeEnabled: true,
    });
    registerNative(readGmail);
    registerNative(writeGmail);
    fs.writeFileSync(
      mcpJsonPath(H.repoDir),
      JSON.stringify({
        mcpServers: {
          ...readMcp(H.repoDir),
          hand_added: { type: "http", url: "https://h" },
        },
      }),
    );
    const removed = materializeUnattendedMcpJson(H.repoDir, listServers());
    expect(removed.sort()).toEqual([serverKey(writeGmail), "hand_added"].sort());
    // 다시 쓴 파일엔 READ pocket 만 남고 캡/정체불명은 사라졌다.
    expect(Object.keys(readMcp(H.repoDir))).toEqual([serverKey(readGmail)]);
  });

  it("prepareUnattendedCwd: isolated 면 머티리얼라이즈하고 항상 ok", () => {
    const custom = insertServer({
      catalogId: "custom", label: "c", agent: "claude_code", repoPath: H.repoDir,
      url: "https://c", scopes: [], writeEnabled: false,
    });
    registerNative(custom);
    const r = prepareUnattendedCwd(H.repoDir, { isolated: true });
    expect(r.ok).toBe(true);
    expect(Object.keys(readMcp(H.repoDir))).toEqual([]); // 캡 대상 미연결
  });

  it("prepareUnattendedCwd: 공유 repo 면 캡 대상에 대해 정적 거부", () => {
    const custom = insertServer({
      catalogId: "custom", label: "c", agent: "claude_code", repoPath: H.repoDir,
      url: "https://c", scopes: [], writeEnabled: false,
    });
    registerNative(custom);
    expect(prepareUnattendedCwd(H.repoDir, { isolated: false }).ok).toBe(false);
  });
});

describe("repoHasUnattendedAutomation (설정 단계 거부 판정)", () => {
  it("enabled cron 이 있으면 true, 없으면 false", () => {
    expect(repoHasUnattendedAutomation(H.repoDir)).toBe(false);
    insertCronJob({
      title: "t", kind: "agent", agent: "claude_code", repoPath: H.repoDir,
      command: "echo hi", shell: null, schedule: "0 9 * * *", timezone: null,
      skipPermissions: true, sessionMode: "fresh", overlapPolicy: "skip",
      catchUp: false, notify: false, enabled: true,
    });
    expect(repoHasUnattendedAutomation(H.repoDir)).toBe(true);
  });

  it("disabled cron 만 있으면 false (무인 자동화 아님)", () => {
    insertCronJob({
      title: "t", kind: "agent", agent: "claude_code", repoPath: H.repoDir,
      command: "echo hi", shell: null, schedule: "0 9 * * *", timezone: null,
      skipPermissions: true, sessionMode: "fresh", overlapPolicy: "skip",
      catchUp: false, notify: false, enabled: false,
    });
    expect(repoHasUnattendedAutomation(H.repoDir)).toBe(false);
  });
});
