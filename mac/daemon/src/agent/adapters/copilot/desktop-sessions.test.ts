/**
 * `scanCopilotSessions` 단위 테스트 — copilot 의 단일 SQLite 스토어(`session-store.db`)
 * 픽스처를 tmpdir 에 만들고 이어받기 후보 추출을 검증한다 (opencode 의 sqlite 픽스처 테스트와
 * 동형).
 *
 * 커버:
 *  - sessions 테이블 → preview(summary)/turnCount/repoPath(cwd)/startedAt/lastActiveAt/gitBranch.
 *  - ISO-8601(+Z) created_at/updated_at → ms epoch 파싱. + sqlite datetime('now') 기본 포맷
 *    ("YYYY-MM-DD HH:MM:SS", UTC) 도 local time 오독 없이 파싱.
 *  - repoPathFilter 로 특정 repo(cwd)만.
 *  - turnCount = turns 의 user_message 가 있는 row 수, 0/없으면 null.
 *  - summary 가 비면 첫 user_message(가장 낮은 turn_index)로 preview 폴백.
 *  - lastActiveAt = max(updated_at, 최신 turn timestamp) — turn 이 더 최신이면 그 값.
 *  - cwd 가 비면 제외.
 *  - lastActiveAt 내림차순 정렬 + 같은 repo 다중 세션 모두 노출(중복 없음).
 *  - branch 가 비면 gitBranch null.
 *  - turns 테이블이 없어도 목록은 살아남고 turnCount 만 null.
 *  - DB 파일 부재 → 빈 목록 (회귀 없음).
 *  - 손상/미지원 포맷(비-sqlite, sessions 테이블 없음) → 조용한 폴백(빈 목록).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import Database from "better-sqlite3";
import { scanCopilotSessions } from "./desktop-sessions.js";

let dir: string;
let dbPath: string;

type Turn = {
  turnIndex: number;
  userMessage: string | null;
  timestamp: string;
};

type SessionSeed = {
  id: string;
  cwd: string | null;
  summary?: string | null;
  branch?: string | null;
  createdAt: string;
  updatedAt: string;
  turns?: Turn[];
};

/** 실제 copilot 스키마 중 우리가 읽는 컬럼만 추린 최소 픽스처 DB 를 만든다. */
function seedDb(sessions: SessionSeed[], opts?: { withTurnsTable?: boolean }): void {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      cwd TEXT,
      repository TEXT,
      host_type TEXT,
      branch TEXT,
      summary TEXT,
      created_at TEXT,
      updated_at TEXT
    );
  `);
  const withTurns = opts?.withTurnsTable ?? true;
  if (withTurns) {
    db.exec(`
      CREATE TABLE turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        turn_index INTEGER NOT NULL,
        user_message TEXT,
        assistant_response TEXT,
        timestamp TEXT
      );
    `);
  }
  const insS = db.prepare(
    `INSERT INTO sessions (id, cwd, repository, host_type, branch, summary, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insT = withTurns
    ? db.prepare(
        `INSERT INTO turns (session_id, turn_index, user_message, assistant_response, timestamp)
         VALUES (?, ?, ?, ?, ?)`,
      )
    : null;
  for (const s of sessions) {
    insS.run(
      s.id,
      s.cwd,
      "Owner/Repo",
      "github",
      s.branch ?? null,
      s.summary ?? null,
      s.createdAt,
      s.updatedAt,
    );
    if (insT && s.turns) {
      for (const t of s.turns) {
        insT.run(s.id, t.turnIndex, t.userMessage, "ok", t.timestamp);
      }
    }
  }
  db.close();
}

const ISO_A = "2026-06-19T00:59:07.610Z";
const ISO_B = "2026-06-19T03:45:09.322Z";

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "copilot-ds-test-"));
  dbPath = path.join(dir, "session-store.db");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("scanCopilotSessions", () => {
  it("DB 파일이 없으면 빈 목록 (회귀 없음)", () => {
    expect(scanCopilotSessions(path.join(dir, "nope.db"), {})).toEqual([]);
  });

  it("sessions → preview/turnCount/repoPath/startedAt/lastActiveAt/gitBranch 추출", () => {
    const repo = "/Users/me/Projects/foo";
    seedDb([
      {
        id: "3825a65b",
        cwd: repo,
        summary: "Remove Unwanted Margins",
        branch: "main",
        createdAt: ISO_A,
        updatedAt: ISO_B,
        turns: [
          { turnIndex: 0, userMessage: "first q", timestamp: ISO_A },
          { turnIndex: 1, userMessage: "second q", timestamp: ISO_B },
        ],
      },
    ]);

    const rows = scanCopilotSessions(dbPath, {});
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.sessionId).toBe("3825a65b");
    expect(r.repoPath).toBe(repo);
    expect(r.preview).toBe("Remove Unwanted Margins");
    expect(r.turnCount).toBe(2);
    expect(r.startedAt).toBe(Date.parse(ISO_A));
    expect(r.lastActiveAt).toBe(Date.parse(ISO_B));
    expect(r.gitBranch).toBe("main");
  });

  it("sqlite datetime('now') 기본 포맷(YYYY-MM-DD HH:MM:SS, UTC)도 파싱", () => {
    seedDb([
      {
        id: "ses_def",
        cwd: "/r",
        summary: "Default ts",
        createdAt: "2026-06-19 00:59:07",
        updatedAt: "2026-06-19 03:45:09",
        turns: [{ turnIndex: 0, userMessage: "q", timestamp: "2026-06-19 03:45:09" }],
      },
    ]);
    const rows = scanCopilotSessions(dbPath, {});
    expect(rows).toHaveLength(1);
    // 공백 구분 UTC 포맷을 'T'+'Z' 로 정규화 → ISO 와 같은 epoch.
    expect(rows[0].startedAt).toBe(Date.parse("2026-06-19T00:59:07Z"));
    expect(rows[0].lastActiveAt).toBe(Date.parse("2026-06-19T03:45:09Z"));
  });

  it("repoPathFilter(cwd) 로 특정 repo 만", () => {
    seedDb([
      { id: "ses_a", cwd: "/Users/me/a", summary: "A", createdAt: ISO_A, updatedAt: ISO_A },
      { id: "ses_b", cwd: "/Users/me/b", summary: "B", createdAt: ISO_B, updatedAt: ISO_B },
    ]);

    const onlyB = scanCopilotSessions(dbPath, { repoPathFilter: "/Users/me/b" });
    expect(onlyB).toHaveLength(1);
    expect(onlyB[0].sessionId).toBe("ses_b");
    expect(onlyB[0].repoPath).toBe("/Users/me/b");
  });

  it("turnCount = user_message 가 있는 turn 수, 0 이면 null", () => {
    seedDb([
      {
        id: "ses_t",
        cwd: "/r",
        summary: "T",
        createdAt: ISO_A,
        updatedAt: ISO_B,
        turns: [
          { turnIndex: 0, userMessage: "q0", timestamp: ISO_A },
          { turnIndex: 1, userMessage: "q1", timestamp: ISO_A },
          { turnIndex: 2, userMessage: null, timestamp: ISO_A }, // user_message 없음 → 안 셈
        ],
      },
      { id: "ses_z", cwd: "/r", summary: "Z", createdAt: ISO_A, updatedAt: ISO_A, turns: [] },
    ]);
    const rows = scanCopilotSessions(dbPath, {});
    const byId = Object.fromEntries(rows.map((r) => [r.sessionId, r.turnCount]));
    expect(byId["ses_t"]).toBe(2);
    expect(byId["ses_z"]).toBeNull();
  });

  it("summary 가 비면 첫 user_message(가장 낮은 turn_index)로 preview 폴백", () => {
    seedDb([
      {
        id: "ses_nosum",
        cwd: "/r",
        summary: "", // 빈 요약 — 갓 시작해 아직 제목 미생성인 세션
        createdAt: ISO_A,
        updatedAt: ISO_B,
        turns: [
          { turnIndex: 1, userMessage: "second message", timestamp: ISO_B },
          { turnIndex: 0, userMessage: "first message", timestamp: ISO_A },
        ],
      },
    ]);
    const rows = scanCopilotSessions(dbPath, {});
    expect(rows).toHaveLength(1);
    expect(rows[0].preview).toBe("first message");
  });

  it("lastActiveAt = max(updated_at, 최신 turn timestamp)", () => {
    const laterThanUpdated = "2026-06-19T03:52:15.208Z";
    seedDb([
      {
        id: "ses_lag",
        cwd: "/r",
        summary: "Lag",
        createdAt: ISO_A,
        updatedAt: ISO_B, // 03:45
        turns: [{ turnIndex: 0, userMessage: "q", timestamp: laterThanUpdated }], // 03:52
      },
    ]);
    const rows = scanCopilotSessions(dbPath, {});
    expect(rows[0].lastActiveAt).toBe(Date.parse(laterThanUpdated));
  });

  it("cwd 가 비면 제외 (NULL / 빈 문자열)", () => {
    seedDb([
      { id: "ses_null", cwd: null, summary: "N", createdAt: ISO_A, updatedAt: ISO_A },
      { id: "ses_empty", cwd: "", summary: "E", createdAt: ISO_A, updatedAt: ISO_A },
      { id: "ses_ok", cwd: "/r", summary: "OK", createdAt: ISO_A, updatedAt: ISO_A },
    ]);
    const rows = scanCopilotSessions(dbPath, {});
    expect(rows.map((r) => r.sessionId)).toEqual(["ses_ok"]);
  });

  it("같은 repo 다중 세션 → 모두 노출 + lastActiveAt 내림차순 (중복 없음)", () => {
    const repo = "/Users/me/same";
    seedDb([
      { id: "ses_old", cwd: repo, summary: "old", createdAt: ISO_A, updatedAt: "2026-06-19T01:00:00.000Z" },
      { id: "ses_new", cwd: repo, summary: "new", createdAt: ISO_A, updatedAt: "2026-06-19T05:00:00.000Z" },
      { id: "ses_mid", cwd: repo, summary: "mid", createdAt: ISO_A, updatedAt: "2026-06-19T03:00:00.000Z" },
    ]);
    const rows = scanCopilotSessions(dbPath, { repoPathFilter: repo });
    expect(rows.map((r) => r.sessionId)).toEqual(["ses_new", "ses_mid", "ses_old"]);
    // 중복 없음 — 세션당 한 번씩만.
    expect(new Set(rows.map((r) => r.sessionId)).size).toBe(rows.length);
  });

  it("branch 가 비면 gitBranch null", () => {
    seedDb([
      { id: "ses_nb", cwd: "/r", summary: "NB", branch: "", createdAt: ISO_A, updatedAt: ISO_A },
    ]);
    expect(scanCopilotSessions(dbPath, {})[0].gitBranch).toBeNull();
  });

  it("turns 테이블이 없으면 turnCount 는 null 이지만 목록은 살아남는다", () => {
    seedDb(
      [{ id: "ses_notbl", cwd: "/r", summary: "NoTurns", createdAt: ISO_A, updatedAt: ISO_B }],
      { withTurnsTable: false },
    );
    const rows = scanCopilotSessions(dbPath, {});
    expect(rows).toHaveLength(1);
    expect(rows[0].sessionId).toBe("ses_notbl");
    expect(rows[0].turnCount).toBeNull();
    expect(rows[0].preview).toBe("NoTurns");
    expect(rows[0].lastActiveAt).toBe(Date.parse(ISO_B));
  });

  it("손상/미지원 포맷(비-sqlite 파일) → 조용한 폴백(빈 목록)", () => {
    fs.writeFileSync(dbPath, "this is not a sqlite database");
    expect(scanCopilotSessions(dbPath, {})).toEqual([]);
  });

  it("sessions 테이블이 없는 DB → 조용한 폴백(빈 목록)", () => {
    const db = new Database(dbPath);
    db.exec("CREATE TABLE unrelated (id TEXT);");
    db.close();
    expect(scanCopilotSessions(dbPath, {})).toEqual([]);
  });
});
