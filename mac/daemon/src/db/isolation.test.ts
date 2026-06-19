import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// POCKET_CLAUDE_CONFIG_DIR escape hatch 가 «검증 표준 스위치» 로 승격된 뒤의 회귀 가드.
//
// 핵심 계약: daemon 은 단일 db()/applyMigrations 경로만 거치고, 그 경로는 전적으로
// CONFIG_DIR(= POCKET_CLAUDE_CONFIG_DIR ?? 실 경로) 로 결정된다. 따라서 env 로 격리
// 디렉터리를 가리키면 «실 DB» 파일은 절대 열리지 않는다 → 시드/정리 누락이 실 데이터를
// 오염시킬 수 없다. 새 DB 추상화 없이 같은 경로를 그대로 쓰므로 스키마 드리프트도 없다.
//
// 모듈 최상단 const(CONFIG_DIR/DB_FILE)가 import 시점에 env 를 읽으므로, env 를 바꾼 뒤
// vi.resetModules() 로 config.js/db.js 를 새로 import 해 평가한다.
async function loadConfig() {
  const { vi } = await import("vitest");
  vi.resetModules();
  return import("../config.js");
}

async function loadDb() {
  const { vi } = await import("vitest");
  vi.resetModules();
  return import("./index.js");
}

const ORIG = process.env.POCKET_CLAUDE_CONFIG_DIR;
let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ps-isolation-"));
});

afterEach(() => {
  if (ORIG === undefined) delete process.env.POCKET_CLAUDE_CONFIG_DIR;
  else process.env.POCKET_CLAUDE_CONFIG_DIR = ORIG;
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

function countSessions(dbFile: string): number {
  const ro = new Database(dbFile, { readonly: true });
  try {
    return (
      ro.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }
    ).n;
  } finally {
    ro.close();
  }
}

describe("CONFIG_DIR 기본값 (회귀 0)", () => {
  it("env 없으면 종전대로 실 «Application Support/PocketSisyphus» 경로", async () => {
    delete process.env.POCKET_CLAUDE_CONFIG_DIR;
    const cfg = await loadConfig();
    const expected = path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "PocketSisyphus",
    );
    expect(cfg.CONFIG_DIR).toBe(expected);
    expect(cfg.DB_FILE).toBe(path.join(expected, "pocket-sisyphus.db"));
  });
});

describe("격리 모드 — env 가 CONFIG_DIR 을 가리키면 그 디렉터리만 쓴다", () => {
  it("DB_FILE 이 격리 디렉터리 안으로 해석된다", async () => {
    const isoDir = path.join(tmpRoot, "PocketSisyphus-dev");
    process.env.POCKET_CLAUDE_CONFIG_DIR = isoDir;
    const cfg = await loadConfig();
    expect(cfg.CONFIG_DIR).toBe(isoDir);
    expect(cfg.DB_FILE).toBe(path.join(isoDir, "pocket-sisyphus.db"));
  });

  it("격리 시드는 격리 DB 에만 INSERT 되고, 실 DB 는 mtime·행수 불변 (정리 누락도 안전)", async () => {
    // 1) «실» DB 를 시드해 기준선을 만든다 (별도 temp 디렉터리를 실 경로로 가정).
    const realDir = path.join(tmpRoot, "PocketSisyphus");
    const isoDir = path.join(tmpRoot, "PocketSisyphus-dev");
    const realDbFile = path.join(realDir, "pocket-sisyphus.db");
    const isoDbFile = path.join(isoDir, "pocket-sisyphus.db");

    process.env.POCKET_CLAUDE_CONFIG_DIR = realDir;
    {
      const dbmod = await loadDb();
      dbmod
        .db()
        .prepare(
          "INSERT INTO sessions (id, repo_path, created_at) VALUES (?,?,?)",
        )
        .run("real-1", "/real/repo", Date.now());
      dbmod._resetDbForTest(); // WAL 체크포인트 후 닫아 mtime 을 고정
    }

    expect(fs.existsSync(realDbFile)).toBe(true);
    const realBaselineRows = countSessions(realDbFile);
    const realBaselineMtime = fs.statSync(realDbFile).mtimeMs;
    expect(realBaselineRows).toBe(1);

    // 2) 격리 모드로 전환해 «demo» 행을 시드한다 (에이전트 시드 모사). 정리(DELETE)는 «일부러»
    //    하지 않는다 — 정리 누락 시에도 실 DB 가 안 다치는지 검증해야 하므로.
    process.env.POCKET_CLAUDE_CONFIG_DIR = isoDir;
    {
      const dbmod = await loadDb();
      const insert = dbmod
        .db()
        .prepare(
          "INSERT INTO sessions (id, repo_path, created_at) VALUES (?,?,?)",
        );
      insert.run("demo-1", "/demo/repo", Date.now());
      insert.run("demo-2", "/demo/repo", Date.now());
      dbmod._resetDbForTest();
    }

    // 3) demo 행은 격리 DB 에만 존재한다.
    expect(fs.existsSync(isoDbFile)).toBe(true);
    expect(countSessions(isoDbFile)).toBe(2);

    // 4) 실 DB 파일은 열린 적조차 없다 → mtime·행수 불변. (정리 누락과 무관하게 안전)
    expect(countSessions(realDbFile)).toBe(realBaselineRows);
    expect(fs.statSync(realDbFile).mtimeMs).toBe(realBaselineMtime);

    // 5) 두 DB 의 행 집합이 분리돼 있음을 교차 확인.
    const realIds = new Database(realDbFile, { readonly: true });
    const isoIds = new Database(isoDbFile, { readonly: true });
    try {
      const real = realIds
        .prepare("SELECT id FROM sessions ORDER BY id")
        .all()
        .map((r) => (r as { id: string }).id);
      const iso = isoIds
        .prepare("SELECT id FROM sessions ORDER BY id")
        .all()
        .map((r) => (r as { id: string }).id);
      expect(real).toEqual(["real-1"]);
      expect(iso).toEqual(["demo-1", "demo-2"]);
    } finally {
      realIds.close();
      isoIds.close();
    }
  });
});
