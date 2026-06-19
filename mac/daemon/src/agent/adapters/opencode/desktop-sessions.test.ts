/**
 * `scanOpencodeSessions` 단위 테스트 — opencode 의 단일 SQLite 스토어(`opencode.db`)
 * 픽스처를 tmpdir 에 만들고 이어받기 후보 추출을 검증한다.
 *
 * 커버:
 *  - session 테이블 → preview(title)/turnCount/repoPath(directory)/startedAt/lastActiveAt.
 *  - repoPathFilter 로 특정 repo(directory)만.
 *  - parent_id 가 있는 서브에이전트 세션은 후보에서 제외 (top-level 만).
 *  - turnCount = message 테이블의 role='user' 개수, 없으면 null.
 *  - directory 가 비면 제외.
 *  - lastActiveAt(=time_updated) 내림차순 정렬.
 *  - DB 파일 부재 → 빈 목록 (회귀 없음).
 *  - 손상/미지원 포맷(비-sqlite, session 테이블 없음) → 조용한 폴백(빈 목록).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import Database from "better-sqlite3";
import { scanOpencodeSessions } from "./desktop-sessions.js";

let dir: string;
let dbPath: string;

type SessionSeed = {
  id: string;
  directory: string;
  title: string;
  timeCreated: number;
  timeUpdated: number;
  parentId?: string | null;
  /** role='user' 메시지 수 — message 테이블에 그만큼 row 를 만든다. */
  userTurns?: number;
};

/** 실제 opencode 스키마 중 우리가 읽는 컬럼만 추린 최소 픽스처 DB 를 만든다. */
function seedDb(sessions: SessionSeed[], opts?: { withMessageTable?: boolean }): void {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      parent_id TEXT,
      directory TEXT NOT NULL,
      title TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL
    );
  `);
  const withMsg = opts?.withMessageTable ?? true;
  if (withMsg) {
    db.exec(`
      CREATE TABLE message (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        data TEXT NOT NULL
      );
    `);
  }
  const insS = db.prepare(
    `INSERT INTO session (id, parent_id, directory, title, time_created, time_updated)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insM = withMsg
    ? db.prepare(`INSERT INTO message (id, session_id, data) VALUES (?, ?, ?)`)
    : null;
  for (const s of sessions) {
    insS.run(s.id, s.parentId ?? null, s.directory, s.title, s.timeCreated, s.timeUpdated);
    if (insM) {
      const turns = s.userTurns ?? 0;
      for (let i = 0; i < turns; i++) {
        insM.run(`${s.id}-u${i}`, s.id, JSON.stringify({ role: "user", text: `q${i}` }));
      }
      // assistant 메시지도 섞어 — role 필터가 user 만 세는지 검증.
      insM.run(`${s.id}-a`, s.id, JSON.stringify({ role: "assistant", text: "a" }));
    }
  }
  db.close();
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-ds-test-"));
  dbPath = path.join(dir, "opencode.db");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("scanOpencodeSessions", () => {
  it("DB 파일이 없으면 빈 목록 (회귀 없음)", () => {
    expect(scanOpencodeSessions(path.join(dir, "nope.db"), {})).toEqual([]);
  });

  it("session 테이블 → preview/turnCount/repoPath/startedAt/lastActiveAt 추출", () => {
    const repo = "/Users/me/Projects/foo";
    seedDb([
      {
        id: "ses_aaa",
        directory: repo,
        title: "Greeting",
        timeCreated: 1781431083904,
        timeUpdated: 1781431091783,
        userTurns: 2,
      },
    ]);

    const rows = scanOpencodeSessions(dbPath, {});
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.sessionId).toBe("ses_aaa");
    expect(r.repoPath).toBe(repo);
    expect(r.preview).toBe("Greeting");
    expect(r.turnCount).toBe(2);
    expect(r.startedAt).toBe(1781431083904);
    expect(r.lastActiveAt).toBe(1781431091783);
    expect(r.gitBranch).toBeNull();
  });

  it("repoPathFilter(directory) 로 특정 repo 만", () => {
    seedDb([
      {
        id: "ses_a",
        directory: "/Users/me/a",
        title: "A",
        timeCreated: 1000,
        timeUpdated: 1100,
        userTurns: 1,
      },
      {
        id: "ses_b",
        directory: "/Users/me/b",
        title: "B",
        timeCreated: 2000,
        timeUpdated: 2100,
        userTurns: 1,
      },
    ]);

    const onlyB = scanOpencodeSessions(dbPath, { repoPathFilter: "/Users/me/b" });
    expect(onlyB).toHaveLength(1);
    expect(onlyB[0].sessionId).toBe("ses_b");
    expect(onlyB[0].repoPath).toBe("/Users/me/b");
  });

  it("parent_id 가 있는 서브에이전트 세션은 후보에서 제외", () => {
    seedDb([
      {
        id: "ses_parent",
        directory: "/Users/me/p",
        title: "Test message",
        timeCreated: 100,
        timeUpdated: 200,
        userTurns: 1,
      },
      {
        id: "ses_child",
        parentId: "ses_parent",
        directory: "/Users/me/p",
        title: "Find test setup (@explore subagent)",
        timeCreated: 110,
        timeUpdated: 250,
        userTurns: 1,
      },
    ]);

    const rows = scanOpencodeSessions(dbPath, {});
    expect(rows.map((r) => r.sessionId)).toEqual(["ses_parent"]);
  });

  it("turnCount = role='user' 개수 (assistant 는 안 셈), 0 이면 null", () => {
    seedDb([
      { id: "ses_t", directory: "/r", title: "T", timeCreated: 1, timeUpdated: 2, userTurns: 3 },
      { id: "ses_z", directory: "/r", title: "Z", timeCreated: 1, timeUpdated: 1, userTurns: 0 },
    ]);
    const rows = scanOpencodeSessions(dbPath, {});
    const byId = Object.fromEntries(rows.map((r) => [r.sessionId, r.turnCount]));
    expect(byId["ses_t"]).toBe(3);
    expect(byId["ses_z"]).toBeNull();
  });

  it("message 테이블이 없으면 turnCount 는 null 이지만 목록은 살아남는다", () => {
    seedDb(
      [{ id: "ses_nm", directory: "/r", title: "NoMsg", timeCreated: 1, timeUpdated: 2 }],
      { withMessageTable: false },
    );
    const rows = scanOpencodeSessions(dbPath, {});
    expect(rows).toHaveLength(1);
    expect(rows[0].sessionId).toBe("ses_nm");
    expect(rows[0].turnCount).toBeNull();
    expect(rows[0].preview).toBe("NoMsg");
  });

  it("lastActiveAt(=time_updated) 내림차순 정렬", () => {
    seedDb([
      { id: "ses_old", directory: "/o", title: "old", timeCreated: 1, timeUpdated: 1000, userTurns: 1 },
      { id: "ses_new", directory: "/n", title: "new", timeCreated: 1, timeUpdated: 2000, userTurns: 1 },
    ]);
    const rows = scanOpencodeSessions(dbPath, {});
    expect(rows.map((r) => r.sessionId)).toEqual(["ses_new", "ses_old"]);
  });

  it("손상/미지원 포맷(비-sqlite 파일) → 조용한 폴백(빈 목록)", () => {
    fs.writeFileSync(dbPath, "this is not a sqlite database");
    expect(scanOpencodeSessions(dbPath, {})).toEqual([]);
  });

  it("session 테이블이 없는 DB → 조용한 폴백(빈 목록)", () => {
    const db = new Database(dbPath);
    db.exec("CREATE TABLE unrelated (id TEXT);");
    db.close();
    expect(scanOpencodeSessions(dbPath, {})).toEqual([]);
  });
});
