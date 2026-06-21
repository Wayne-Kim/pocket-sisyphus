/**
 * `createPtyFlushHandler` 신뢰성 회귀 테스트.
 *
 * 기회 브리프: cron·workflow·다중 PTY 가 같은 SQLite messages 테이블에 동시에 쓰면
 * SQLITE_BUSY/디스크 풀 같은 일시 오류가 가능하고, 그때 onFlush 의 insert 가 throw 하면
 * (보호 없이는) broadcast 가 안 돌아 출력이 유실되고 flush 타이머 콜백이 죽어 세션이 멎는다.
 *
 * 여기선 `db().prepare().run()` 이 throw 하도록 스파이를 박아, onFlush 핸들러가:
 *   - 예외를 격리해 throw 를 밖으로 내보내지 않고(타이머 루프 생존),
 *   - 실패 청크는 broadcast 도 스킵하며(원자성),
 *   - 「후속」 flush 는 정상적으로 insert + broadcast 함을
 * 검증한다. PtyChunkBuffer 와 묶어, 실제 타이머 flush 경로로도 살아남는지 본다.
 *
 * 격리 전략은 `pty-snapshot.test.ts` 와 동일 — `../config.js` 를 tmpdir 로 mock 하고
 * DB singleton 을 매 테스트마다 비운다. `../ws/hub.js` 는 broadcast 만 캡처하도록 mock.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

const H = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fsH = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const osH = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pathH = require("node:path") as typeof import("node:path");
  const dir = fsH.mkdtempSync(pathH.join(osH.tmpdir(), "ps-flush-test-"));
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

const broadcasts: Array<{ sessionId: string; message: unknown }> = [];
vi.mock("../ws/hub.js", () => ({
  broadcastToSession: (sessionId: string, message: unknown) => {
    broadcasts.push({ sessionId, message });
  },
  broadcastAll: () => {},
}));

const fs = await import("node:fs");
const { createPtyFlushHandler } = await import("./pty-runner.js");
const { PtyChunkBuffer } = await import("./pty-coalesce.js");
const { db, _resetDbForTest } = await import("../db/index.js");

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

beforeEach(() => {
  broadcasts.length = 0;
  vi.restoreAllMocks();
  _resetDbForTest();
  for (const ext of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(H.dbFile + ext); } catch { /* not exists */ }
  }
});
afterAll(() => {
  vi.restoreAllMocks();
  _resetDbForTest();
  try { fs.rmSync(H.tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe("createPtyFlushHandler", () => {
  it("insert 가 throw 해도 onFlush 가 throw 하지 않고, 실패 청크는 broadcast 도 스킵(원자성)", () => {
    const sid = "s-fail";
    seedSession(sid);
    const handler = createPtyFlushHandler(sid);

    // 다음 prepare() 의 run() 이 SQLITE_BUSY 류로 throw 하게 박는다.
    const real = db();
    const spy = vi.spyOn(real, "prepare").mockImplementationOnce(() => {
      return { run: () => { throw new Error("SQLITE_BUSY: database is locked"); } } as never;
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // onFlush 자체가 throw 하면 안 된다(타이머 루프 사망 금지).
    expect(() => handler(Buffer.from("first"))).not.toThrow();
    // insert 실패 → broadcast 스킵, DB 미저장.
    expect(broadcasts.length).toBe(0);
    expect(chunkCount(sid)).toBe(0);
    expect(warn).toHaveBeenCalled();

    spy.mockRestore();
    // 후속 flush 는 정상 동작해야 한다 — insert + broadcast 둘 다.
    expect(() => handler(Buffer.from("second"))).not.toThrow();
    expect(chunkCount(sid)).toBe(1);
    expect(broadcasts.length).toBe(1);
    const msg = broadcasts[0].message as { type: string; id: string; bytes_b64: string };
    expect(msg.type).toBe("pty_output");
    expect(Buffer.from(msg.bytes_b64, "base64").toString()).toBe("second");
  });

  it("PtyChunkBuffer 타이머 flush 경로에서 insert 실패를 견디고 버퍼가 살아남아 다음 flush 가 동작", () => {
    vi.useFakeTimers();
    try {
      const sid = "s-buffer";
      seedSession(sid);
      const buf = new PtyChunkBuffer({ delayMs: 15, onFlush: createPtyFlushHandler(sid) });

      const real = db();
      const failSpy = vi.spyOn(real, "prepare").mockImplementationOnce(() => {
        return { run: () => { throw new Error("disk I/O error"); } } as never;
      });
      vi.spyOn(console, "warn").mockImplementation(() => {});

      // 1차 flush — insert throw. 타이머 콜백이 죽으면 안 됨.
      buf.push(Buffer.from("alpha"));
      expect(() => vi.advanceTimersByTime(15)).not.toThrow();
      expect(chunkCount(sid)).toBe(0);
      expect(broadcasts.length).toBe(0);

      failSpy.mockRestore();
      // 버퍼가 살아있어야 2차 flush 가 정상 동작.
      buf.push(Buffer.from("beta"));
      vi.advanceTimersByTime(15);
      expect(chunkCount(sid)).toBe(1);
      expect(broadcasts.length).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("연속 insert 실패 시 로그를 레이트 리밋(5초 윈도우에 1회)", () => {
    const sid = "s-spam";
    seedSession(sid);
    const handler = createPtyFlushHandler(sid);

    const real = db();
    vi.spyOn(real, "prepare").mockImplementation(() => {
      return { run: () => { throw new Error("SQLITE_BUSY"); } } as never;
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const base = 1_000_000;
    const nowSpy = vi.spyOn(Date, "now");
    // 같은 5초 윈도우 안의 3회 실패 → 1회만 로그.
    nowSpy.mockReturnValue(base);
    handler(Buffer.from("a"));
    nowSpy.mockReturnValue(base + 100);
    handler(Buffer.from("b"));
    nowSpy.mockReturnValue(base + 200);
    handler(Buffer.from("c"));
    expect(warn).toHaveBeenCalledTimes(1);

    // 5초 경과 후 다시 1회 허용.
    nowSpy.mockReturnValue(base + 6000);
    handler(Buffer.from("d"));
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
