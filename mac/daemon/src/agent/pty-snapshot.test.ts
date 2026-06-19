/**
 * `agent/pty-snapshot` + `prunePtyChunks` 테스트.
 *
 * 격리 전략은 `routes/sessions.test.ts` 와 동일 — `../config.js` 를 tmpdir 로 mock 하고
 * DB singleton 을 매 테스트마다 비운다. 여기선 pty-runner 를 mock 하지 «않고» 실제
 * `prunePtyChunks` 를 부른다 (node-pty top-level import 포함).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";

const H = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fsH = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const osH = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pathH = require("node:path") as typeof import("node:path");
  const dir = fsH.mkdtempSync(pathH.join(osH.tmpdir(), "ps-snap-test-"));
  return { tmpDir: dir, configFile: pathH.join(dir, "config.json"), dbFile: pathH.join(dir, "test.db") };
});

vi.mock("../config.js", () => ({
  CONFIG_DIR: H.tmpDir,
  CONFIG_FILE: H.configFile,
  DB_FILE: H.dbFile,
  ensureConfigDir: () => {},
  readConfig: () => null,
  writeConfig: () => {},
}));

const fs = await import("node:fs");
const { buildPtySnapshot, SNAPSHOT_TAIL_CHUNKS } = await import("./pty-snapshot.js");
const { prunePtyChunks } = await import("./pty-runner.js");
const { db, _resetDbForTest } = await import("../db/index.js");

function seed(sessionId: string, id: string, text: string, createdAt: number): void {
  db().prepare(
    `INSERT INTO messages (id, session_id, role, type, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    id, sessionId, "assistant", "pty_chunk",
    JSON.stringify({ bytes_b64: Buffer.from(text, "utf8").toString("base64") }),
    createdAt,
  );
}
/** messages 의 FK 충족용 — 세션 행 1개 직접 삽입. */
function seedSession(sessionId: string): void {
  db().prepare(
    `INSERT INTO sessions (id, repo_path, created_at) VALUES (?, ?, ?)`,
  ).run(sessionId, "/tmp/x", Date.now());
}
function chunkCount(sessionId: string): number {
  return (db().prepare(
    `SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND type = 'pty_chunk'`,
  ).get(sessionId) as { n: number }).n;
}

beforeAll(() => {});
beforeEach(() => {
  _resetDbForTest();
  for (const ext of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(H.dbFile + ext); } catch { /* not exists */ }
  }
});
afterAll(() => {
  _resetDbForTest();
  try { fs.rmSync(H.tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe("buildPtySnapshot", () => {
  it("색/속성을 보존하며 화면을 재구성", async () => {
    const id = "s1";
    seedSession(id);
    seed(id, "a", "\x1b[31mRED\x1b[0m normal\r\n", 10);
    seed(id, "b", "line two", 11);
    const snap = await buildPtySnapshot(id, { cols: 40, rows: 5 });
    expect(snap.snapshot).toContain("RED");
    expect(snap.snapshot).toContain("line two");
    expect(snap.snapshot).toContain("\x1b["); // SGR 보존
    expect(snap.throughCreatedAt).toBe(11);
    expect(snap.cols).toBe(40);
    expect(snap.rows).toBe(5);
  });

  it("청크가 tail 상한을 넘으면 truncated=true 이고 최신만 반영", async () => {
    const id = "s2";
    seedSession(id);
    const total = SNAPSHOT_TAIL_CHUNKS + 5;
    for (let i = 0; i < total; i++) seed(id, `m${i}`, `n${i}\r\n`, 1000 + i);
    const snap = await buildPtySnapshot(id, { cols: 40, rows: 5 });
    expect(snap.truncated).toBe(true);
    // 마지막 청크 created_at 이 watermark.
    expect(snap.throughCreatedAt).toBe(1000 + total - 1);
  });
});

describe("prunePtyChunks", () => {
  it("최신 retain 개만 남기고 오래된 pty_chunk 삭제", () => {
    const id = "p1";
    seedSession(id);
    for (let i = 0; i < 100; i++) seed(id, `m${i}`, `x${i}`, 5000 + i);
    expect(chunkCount(id)).toBe(100);
    const deleted = prunePtyChunks(id, 30);
    // 경계(created_at) 미만을 지우므로 정확히 30 또는 그 부근(동률 created_at 없으니 70 삭제).
    expect(deleted).toBe(70);
    expect(chunkCount(id)).toBe(30);
  });

  it("retain 보다 적으면 아무것도 안 지운다", () => {
    const id = "p2";
    seedSession(id);
    for (let i = 0; i < 10; i++) seed(id, `m${i}`, `x${i}`, 6000 + i);
    expect(prunePtyChunks(id, 50)).toBe(0);
    expect(chunkCount(id)).toBe(10);
  });

  it("user/exit 메시지는 건드리지 않는다", () => {
    const id = "p3";
    seedSession(id);
    for (let i = 0; i < 50; i++) seed(id, `c${i}`, `x${i}`, 7000 + i);
    db().prepare(
      `INSERT INTO messages (id, session_id, role, type, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("u1", id, "user", "user", JSON.stringify({ text: "hi" }), 7000);
    prunePtyChunks(id, 10);
    expect(chunkCount(id)).toBe(10);
    const userRows = (db().prepare(
      `SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND type = 'user'`,
    ).get(id) as { n: number }).n;
    expect(userRows).toBe(1);
  });
});
