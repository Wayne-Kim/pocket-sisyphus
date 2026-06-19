/**
 * CHECK 제약 «드리프트» 계약 테스트.
 *
 * 배경: applyMigrations 는 ALTER TABLE ADD COLUMN 으로 «컬럼» 만 따라잡고 CHECK 제약은 못 붙인다
 * (SQLite 한계). 그래서 fresh test DB(schema.sql → CHECK 엄격)와 오래 살아온 dev DB(ALTER 만
 * 받아 CHECK 없음)의 무결성 규칙이 어긋나, 같은 잘못된 enum 이 환경에 따라 거부/통과로 갈린다.
 * 이것이 «test 와 dev 스키마가 어긋나는» 버그의 실제 형태다.
 *
 * detectCheckConstraintDrift 는 이 드리프트를 비파괴적으로 «표면화» 한다. 이 테스트는:
 *  1) fresh DB 는 드리프트가 없고 잘못된 enum 을 거부함을,
 *  2) 레거시(ALTER 로 컬럼만 붙은) DB 는 잘못된 enum 을 «조용히» 통과시키지만(재현),
 *  3) 그 차이가 detectCheckConstraintDrift 로 «항상 동일하게 진단» 됨을 어서트한다.
 */
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { detectCheckConstraintDrift } from "./index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");

const MODE_CHECK = "CHECK(mode IN ('pty'))";
const KIND_CHECK = "CHECK(kind IN ('agent','terminal'))";

function freshDb(): Database.Database {
  const d = new Database(":memory:");
  d.pragma("foreign_keys = ON");
  d.exec(SCHEMA);
  return d;
}

/**
 * 오래된 dev DB 를 흉내 낸다: 옛 CREATE TABLE 엔 mode/kind 컬럼이 없었고 나중에 applyMigrations 가
 * `ALTER TABLE ... ADD COLUMN mode TEXT NOT NULL DEFAULT 'pty'` 로 «CHECK 없이» 붙였다 — 결과적으로
 * fresh schema 와 컬럼은 같지만 CHECK 제약만 빠진 상태가 된다. schema.sql 에서 해당 CHECK 절만 떼어
 * 동일 상태를 재현한다.
 */
function legacyDb(): Database.Database {
  const d = new Database(":memory:");
  d.pragma("foreign_keys = ON");
  const legacy = SCHEMA
    .replace(`${MODE_CHECK} `, "")
    .replace(`${KIND_CHECK} `, "");
  d.exec(legacy);
  return d;
}

function insertSession(d: Database.Database, mode: string): void {
  d.prepare(
    "INSERT INTO sessions (id, repo_path, created_at, mode) VALUES (?, ?, ?, ?)",
  ).run("s1", "/tmp/repo", Date.now(), mode);
}

describe("CHECK 제약 드리프트 계약", () => {
  it("fresh DB(schema.sql)는 드리프트가 없다", () => {
    const d = freshDb();
    try {
      expect(detectCheckConstraintDrift(d)).toEqual([]);
    } finally {
      d.close();
    }
  });

  it("fresh DB 는 잘못된 enum(sessions.mode)을 거부한다", () => {
    const d = freshDb();
    try {
      expect(() => insertSession(d, "bogus")).toThrow();
      // 정상 값은 통과
      insertSession(d, "pty");
      expect(
        (d.prepare("SELECT mode FROM sessions WHERE id='s1'").get() as { mode: string }).mode,
      ).toBe("pty");
    } finally {
      d.close();
    }
  });

  it("레거시 DB(ALTER 로 컬럼만 붙음)는 잘못된 enum 을 조용히 통과시킨다 — 재현", () => {
    const d = legacyDb();
    try {
      // 드리프트 버그의 실제 형태: fresh 에선 거부될 값이 여기선 INSERT 된다.
      expect(() => insertSession(d, "bogus")).not.toThrow();
      expect(
        (d.prepare("SELECT mode FROM sessions WHERE id='s1'").get() as { mode: string }).mode,
      ).toBe("bogus");
    } finally {
      d.close();
    }
  });

  it("드리프트는 fresh·legacy 두 DB 에서 «항상 동일하게 진단» 된다", () => {
    const fresh = freshDb();
    const legacy = legacyDb();
    try {
      // fresh: 진단 없음.
      expect(detectCheckConstraintDrift(fresh)).toEqual([]);

      // legacy: 빠진 CHECK 가 테이블별로 표면화된다.
      const drift = detectCheckConstraintDrift(legacy);
      const byTable = Object.fromEntries(drift.map((x) => [x.table, x.missing]));
      expect(byTable["sessions"]).toContain(MODE_CHECK);
      expect(byTable["cron_jobs"]).toContain(KIND_CHECK);

      // 두 환경 모두에서 «잘못된 enum 이 환경에 따라 갈리면» 반드시 진단으로 잡힌다는 계약:
      // 어떤 DB 든 detectCheckConstraintDrift 가 비어 있으면 fresh 와 무결성 규칙이 같다는 보증.
      const freshAcceptsBogus = (() => {
        const d = freshDb();
        try {
          insertSession(d, "bogus");
          return true;
        } catch {
          return false;
        } finally {
          d.close();
        }
      })();
      const legacyAcceptsBogus = (() => {
        const d = legacyDb();
        try {
          insertSession(d, "bogus");
          return true;
        } catch {
          return false;
        } finally {
          d.close();
        }
      })();
      // 행동이 갈린다(fresh 거부 / legacy 통과)는 사실 자체가 드리프트의 증거이고,
      // 그 드리프트는 진단에 «반드시» 잡혀 있어야 한다.
      expect(freshAcceptsBogus).toBe(false);
      expect(legacyAcceptsBogus).toBe(true);
      expect(drift.length).toBeGreaterThan(0);
    } finally {
      fresh.close();
      legacy.close();
    }
  });
});
