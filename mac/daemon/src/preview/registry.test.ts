// preview/registry — 포트 형식 검증 + DB 등록 round-trip + 기본 차단(default-deny) 핀.
//
// 격리: ../config.js 를 mock 해 임시 DB 파일을 박는다 (sessions.test 와 같은 패턴).
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import fs from "node:fs";

const H = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fsH = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const osH = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pathH = require("node:path") as typeof import("node:path");
  const dir = fsH.mkdtempSync(pathH.join(osH.tmpdir(), "ps-preview-test-"));
  return { tmpDir: dir, dbFile: pathH.join(dir, "test.db") };
});

vi.mock("../config.js", () => ({
  CONFIG_DIR: H.tmpDir,
  DB_FILE: H.dbFile,
  ensureConfigDir: () => fs.mkdirSync(H.tmpDir, { recursive: true }),
}));

import { db, _resetDbForTest } from "../db/index.js";
import {
  validatePreviewPort,
  registerPreviewPort,
  unregisterPreviewPort,
  listPreviewPorts,
  isPreviewPortAllowed,
} from "./registry.js";

const SID = "sess-aaaa";

function seedSession(id: string): void {
  db()
    .prepare(
      "INSERT OR IGNORE INTO sessions (id, repo_path, created_at) VALUES (?, ?, ?)",
    )
    .run(id, "/tmp/repo", Date.now());
}

beforeEach(() => {
  _resetDbForTest();
  db().exec("DELETE FROM preview_ports; DELETE FROM sessions;");
  seedSession(SID);
});

afterAll(() => {
  _resetDbForTest();
  try {
    fs.rmSync(H.tmpDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe("validatePreviewPort", () => {
  const reserved = new Set([7777, 7778, 7779, 22022, 22]);

  it("정상 dev 포트 허용", () => {
    expect(validatePreviewPort(3000, reserved)).toEqual({ ok: true, port: 3000 });
    expect(validatePreviewPort("5173", reserved)).toEqual({ ok: true, port: 5173 });
  });

  it("범위 밖(특권/0/65536+) 차단", () => {
    expect(validatePreviewPort(80, reserved).ok).toBe(false);
    expect(validatePreviewPort(22, reserved).ok).toBe(false);
    expect(validatePreviewPort(0, reserved).ok).toBe(false);
    expect(validatePreviewPort(70000, reserved).ok).toBe(false);
    expect(validatePreviewPort("nope", reserved).ok).toBe(false);
  });

  it("daemon 내부 예약 포트 차단", () => {
    const v = validatePreviewPort(7777, reserved);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toBe("reserved");
  });
});

describe("registry round-trip + default deny", () => {
  it("미등록 포트는 차단 (기본 차단)", () => {
    expect(isPreviewPortAllowed(SID, 3000)).toBe(false);
  });

  it("등록 후 허용, 다른 세션엔 누출 안 됨", () => {
    registerPreviewPort(SID, 3000);
    expect(isPreviewPortAllowed(SID, 3000)).toBe(true);
    expect(isPreviewPortAllowed("other-sess", 3000)).toBe(false);
  });

  it("등록은 idempotent, 목록은 최근 우선", () => {
    registerPreviewPort(SID, 3000);
    registerPreviewPort(SID, 3000);
    registerPreviewPort(SID, 5173);
    const ports = listPreviewPorts(SID).map((p) => p.port);
    expect(ports.sort()).toEqual([3000, 5173]);
  });

  it("해제하면 다시 차단", () => {
    registerPreviewPort(SID, 3000);
    unregisterPreviewPort(SID, 3000);
    expect(isPreviewPortAllowed(SID, 3000)).toBe(false);
  });

  it("세션 삭제 시 CASCADE 로 등록 정리", () => {
    registerPreviewPort(SID, 3000);
    db().prepare("DELETE FROM sessions WHERE id = ?").run(SID);
    expect(listPreviewPorts(SID)).toEqual([]);
  });
});
