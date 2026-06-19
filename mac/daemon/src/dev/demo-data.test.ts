/**
 * 데모 시드/정리 왕복 회귀 테스트 (demo_seed_v1).
 *
 * 격리 전략은 `agent/pty-snapshot.test.ts` 와 동일 — `../config.js` 를 tmpdir 로 mock 하고
 * DB singleton 을 매 테스트마다 비운다. 이 mock 덕에 어느 단계에서도 «실 DB» 가 열리지 않는다
 * (db() 가 보는 DB_FILE 이 tmp 파일이다).
 *
 * 수용 기준:
 *  - seed→teardown 왕복 후 데모 prefix 행수 = 0.
 *  - 비-데모(사용자) 행은 불변.
 *  - 실 DB 경로는 어느 단계에서도 생성/오픈되지 않음.
 *  - 모든 쓰기는 db() 경유 (schema.sql + applyMigrations) — raw sqlite3 우회 없음.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

const H = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fsH = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const osH = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pathH = require("node:path") as typeof import("node:path");
  const dir = fsH.mkdtempSync(pathH.join(osH.tmpdir(), "ps-demo-test-"));
  // «실 DB» 의 대역 — 이 경로가 절대 생성되지 않아야 한다. (mock 으로 격리됐으므로 당연히
  // 안 열리지만, 명시적으로 어서트해 회귀를 막는다.)
  const realDir = fsH.mkdtempSync(pathH.join(osH.tmpdir(), "ps-demo-REAL-"));
  return {
    tmpDir: dir,
    configFile: pathH.join(dir, "config.json"),
    dbFile: pathH.join(dir, "test.db"),
    realDbFile: pathH.join(realDir, "pocket-sisyphus.db"),
    // 가드용 가변 격리 상태 — 테스트가 «격리/실 DB» 를 토글한다.
    state: { isolated: true },
  };
});

vi.mock("../config.js", () => ({
  CONFIG_DIR: H.tmpDir,
  CONFIG_FILE: H.configFile,
  DB_FILE: H.dbFile,
  REAL_CONFIG_DIR: "/nonexistent/real/PocketSisyphus",
  isIsolatedConfigDir: () => H.state.isolated,
  ensureConfigDir: () => {},
  readConfig: () => null,
  writeConfig: () => {},
}));

const fs = await import("node:fs");
const { db, _resetDbForTest } = await import("../db/index.js");
const { seedDemo, teardownDemo, countDemoRows, DEMO_PREFIX, DemoRealDbGuardError } =
  await import("./demo-data.js");

/** 비-데모(사용자) 행 1개씩 — seed/teardown 이 절대 건드리면 안 되는 대조군. */
function insertNonDemoFixtures(): void {
  const d = db();
  d.prepare(
    `INSERT INTO sessions (id, title, repo_path, created_at, status) VALUES (?, ?, ?, ?, ?)`,
  ).run("user-session-keep", "사용자 세션", "/Users/me/proj", 111, "active");
  d.prepare(
    `INSERT INTO messages (id, session_id, role, type, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run("user-msg-keep", "user-session-keep", "user", "text", "{}", 112);
  d.prepare(
    `INSERT INTO po_briefs (id, repo_path, title, problem, evidence, impact, effort, score, scope, spec, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "user-brief-keep", "/Users/me/proj", "유지 브리프", "문제", "[]",
    3, 3, 1, "스코프", "스펙", "proposed", 113, 113,
  );
}

function nonDemoSnapshot(): unknown[] {
  const d = db();
  return [
    d.prepare(`SELECT * FROM sessions WHERE id = 'user-session-keep'`).get(),
    d.prepare(`SELECT * FROM messages WHERE id = 'user-msg-keep'`).get(),
    d.prepare(`SELECT * FROM po_briefs WHERE id = 'user-brief-keep'`).get(),
  ];
}

beforeEach(() => {
  _resetDbForTest();
  H.state.isolated = true; // 기본: 격리 DB — 기존 회귀 케이스는 종전대로 통과해야 한다.
  delete process.env.DEMO_ALLOW_REAL_DB;
  for (const ext of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(H.dbFile + ext); } catch { /* not exists */ }
  }
});

afterAll(() => {
  _resetDbForTest();
});

describe("demo seed/teardown", () => {
  it("seed 는 멱등 — 여러 번 돌려도 데모 행수가 동일하다", () => {
    seedDemo();
    const once = countDemoRows();
    expect(once).toBeGreaterThan(0);
    seedDemo();
    seedDemo();
    expect(countDemoRows()).toBe(once);
  });

  it("seed→teardown 왕복 후 데모 prefix 행수 = 0", () => {
    seedDemo();
    expect(countDemoRows()).toBeGreaterThan(0);
    const { deleted } = teardownDemo();
    expect(deleted).toBeGreaterThan(0);
    expect(countDemoRows()).toBe(0);
  });

  it("teardown 은 비-데모(사용자) 행을 불변으로 둔다", () => {
    insertNonDemoFixtures();
    const before = nonDemoSnapshot();

    seedDemo();
    teardownDemo();

    const after = nonDemoSnapshot();
    expect(after).toEqual(before);
    expect(after.every((r) => r != null)).toBe(true);
    // 데모 prefix 행만 사라지고, 사용자 행 3개는 그대로 남아야 한다.
    const total = (db().prepare(
      `SELECT
         (SELECT COUNT(*) FROM sessions) +
         (SELECT COUNT(*) FROM messages) +
         (SELECT COUNT(*) FROM po_briefs) AS n`,
    ).get() as { n: number }).n;
    expect(total).toBe(3);
  });

  it("teardown 은 데모 prefix 행만 삭제한다 (전체 wipe 아님)", () => {
    insertNonDemoFixtures();
    seedDemo();
    teardownDemo();
    // 사용자 세션은 남고, 어떤 데모 prefix 행도 안 남는다.
    const demoLeft = (db().prepare(
      `SELECT COUNT(*) AS n FROM sessions WHERE id LIKE ? || '%'`,
    ).get(DEMO_PREFIX) as { n: number }).n;
    expect(demoLeft).toBe(0);
    const userLeft = (db().prepare(
      `SELECT COUNT(*) AS n FROM sessions WHERE id = 'user-session-keep'`,
    ).get() as { n: number }).n;
    expect(userLeft).toBe(1);
  });

  it("실 DB 는 어느 단계에서도 열리지 않는다", () => {
    seedDemo();
    teardownDemo();
    // db() 가 연 파일은 mock 된 tmp 경로여야 한다.
    expect(fs.existsSync(H.dbFile)).toBe(true);
    // 실 DB 대역 경로는 생성조차 되지 않았다.
    expect(fs.existsSync(H.realDbFile)).toBe(false);
  });
});

describe("격리 가드 — 실 DB 쓰기 방지", () => {
  it("격리 미설정(=실 DB)이면 seed/teardown 을 쓰기 없이 거부한다", () => {
    H.state.isolated = false;
    // 가드는 db() 를 열기 «전» 에 던진다 → 어떤 행도 INSERT/DELETE 되지 않는다.
    expect(() => seedDemo()).toThrow(DemoRealDbGuardError);
    expect(() => teardownDemo()).toThrow(DemoRealDbGuardError);
    // db() 가 (countDemoRows 로) 열려도 데모 행은 0 — 거부가 쓰기를 막았다.
    expect(countDemoRows()).toBe(0);
  });

  it("격리 디렉터리를 가리킨 상태에서는 종전과 동일하게 동작한다", () => {
    H.state.isolated = true;
    expect(() => seedDemo()).not.toThrow();
    expect(countDemoRows()).toBeGreaterThan(0);
  });

  it("--force 우회는 통과하고 stderr 에 «실 DB» 경고를 남긴다", () => {
    H.state.isolated = false;
    const writes: string[] = [];
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      });
    try {
      expect(() => seedDemo({ force: true })).not.toThrow();
    } finally {
      spy.mockRestore();
    }
    expect(countDemoRows()).toBeGreaterThan(0);
    expect(writes.join("")).toContain("실 DB 에 씁니다");
  });

  it("DEMO_ALLOW_REAL_DB=1 우회도 통과한다", () => {
    H.state.isolated = false;
    process.env.DEMO_ALLOW_REAL_DB = "1";
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      expect(() => seedDemo()).not.toThrow();
    } finally {
      spy.mockRestore();
    }
    expect(countDemoRows()).toBeGreaterThan(0);
  });
});
