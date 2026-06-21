/**
 * coalesce flush 경계 + `prunePtyChunks` vs reader 윈도우 경합 스트레스 테스트.
 *
 * ## 왜
 *
 * 핫패스에서 createPtyFlushHandler 는 512 flush 마다 prunePtyChunks 로 오래된 pty_chunk 를
 * 자른다(테이블 무한 증식 방지). 동시에 콜드 진입/재접속 reader 들이 «최근 윈도우» 를 읽는다:
 *   - 스냅샷 재구성: 최신 SNAPSHOT_TAIL_CHUNKS(4000) tail.
 *   - 콜드 poll/history: 최신 MAX_MESSAGE_PAGE(2000) tail.
 *   - WS catch-up: since 이후 최대 1000.
 * prune 의 보존량(PTY_CHUNK_RETAIN=8000)이 이 윈도우들보다 «크다» 는 약속이 깨지거나, prune 의
 * 경계 계산이 off-by-one 이면 reader 가 보는 화면/스크롤백에 «조용한 손실» 이 생긴다. 여기서
 * 그 불변식과 경계, 그리고 read-vs-prune 격리를 자동 단언으로 못박는다.
 *
 * 격리 전략은 pty-snapshot.test.ts 와 동일 — config tmpdir mock + 실제 DB(`_resetDbForTest`).
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";

const H = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fsH = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const osH = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pathH = require("node:path") as typeof import("node:path");
  const dir = fsH.mkdtempSync(pathH.join(osH.tmpdir(), "ps-prune-race-"));
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
const { PtyChunkBuffer } = await import("./pty-coalesce.js");
const { prunePtyChunks, PTY_CHUNK_RETAIN } = await import("./pty-runner.js");
const { buildPtySnapshot, SNAPSHOT_TAIL_CHUNKS } = await import("./pty-snapshot.js");
const { db, _resetDbForTest } = await import("../db/index.js");

/** 실제 reader 들이 쓰는 윈도우 상한 (출처: 코드 주석/쿼리). 골든 — 바뀌면 같이 갱신해야 한다. */
const READER_WINDOWS = {
  snapshotTail: SNAPSHOT_TAIL_CHUNKS, // pty-snapshot.ts (4000)
  coldPoll: 2000, // routes/sessions.ts MAX_MESSAGE_PAGE
  wsCatchUp: 1000, // ws/hub.ts replayPtyChunksSince LIMIT
};

function seedSession(sessionId: string): void {
  db().prepare(`INSERT INTO sessions (id, repo_path, created_at) VALUES (?, ?, ?)`).run(
    sessionId,
    "/tmp/x",
    Date.now(),
  );
}

const insertChunkStmt = () =>
  db().prepare(
    `INSERT INTO messages (id, session_id, role, type, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  );

/** seq 라벨이 박힌 pty_chunk 하나. created_at 으로 정렬 순서를 «직접» 통제한다. */
function seedChunk(sessionId: string, seq: number, createdAt: number): void {
  insertChunkStmt().run(
    `c${seq}`,
    sessionId,
    "assistant",
    "pty_chunk",
    JSON.stringify({ bytes_b64: Buffer.from(`seq:${seq}\n`, "utf8").toString("base64") }),
    createdAt,
  );
}

/** seq=[from..to) 를 created_at=seq 로 한 트랜잭션에 삽입 (단조 증가 = 삽입 순서). */
function seedRange(sessionId: string, from: number, to: number): void {
  const stmt = insertChunkStmt();
  const tx = db().transaction((lo: number, hi: number) => {
    for (let i = lo; i < hi; i++) {
      stmt.run(
        `c${i}`,
        sessionId,
        "assistant",
        "pty_chunk",
        JSON.stringify({ bytes_b64: Buffer.from(`seq:${i}\n`, "utf8").toString("base64") }),
        i,
      );
    }
  });
  tx(from, to);
}

function chunkCount(sessionId: string): number {
  return (
    db()
      .prepare(`SELECT COUNT(*) AS n FROM messages WHERE session_id = ? AND type = 'pty_chunk'`)
      .get(sessionId) as { n: number }
  ).n;
}

/** reader 가 보는 «최신 W개» 윈도우의 seq 들 (오래된→최신 순). */
function newestWindowSeqs(sessionId: string, w: number): number[] {
  const rows = db()
    .prepare(
      `SELECT payload FROM messages WHERE session_id = ? AND type = 'pty_chunk'
       ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
    .all(sessionId, w) as Array<{ payload: string }>;
  return rows
    .map((r) => {
      const txt = Buffer.from(
        (JSON.parse(r.payload) as { bytes_b64: string }).bytes_b64,
        "base64",
      ).toString("utf8");
      return Number(/^seq:(\d+)/.exec(txt)?.[1]);
    })
    .reverse();
}

/** [from..to) 의 정수 배열. */
function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let i = from; i < to; i++) out.push(i);
  return out;
}

beforeEach(() => {
  _resetDbForTest();
  for (const ext of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(H.dbFile + ext);
    } catch {
      /* not exists */
    }
  }
});

afterAll(() => {
  _resetDbForTest();
  try {
    fs.rmSync(H.tmpDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe("coalesce flush 경계 정밀", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("maxBytes 경계 off-by-one — maxBytes-1 까지는 보류, 경계 바이트에서 flush", () => {
    const flushed: Buffer[] = [];
    const buf = new PtyChunkBuffer({ delayMs: 15, maxBytes: 8, onFlush: (b) => flushed.push(b) });

    buf.push(Buffer.alloc(7, 0x61)); // total 7 < 8 → 아직
    expect(flushed.length).toBe(0);
    buf.push(Buffer.alloc(1, 0x62)); // total 8 >= 8 → flush
    expect(flushed.length).toBe(1);
    expect(flushed[0].length).toBe(8);
  });

  it("타이머 경계 — delayMs-1 에선 안 나가고 delayMs 에 정확히 나간다", () => {
    const flushed: Buffer[] = [];
    const buf = new PtyChunkBuffer({ delayMs: 15, onFlush: (b) => flushed.push(b) });

    buf.push(Buffer.from("x"));
    vi.advanceTimersByTime(14);
    expect(flushed.length).toBe(0);
    vi.advanceTimersByTime(1); // 누적 15ms
    expect(flushed.length).toBe(1);
  });

  it("maxBytes flush 가 타이머를 깨끗이 정리 — 잔여만 다음 윈도우로 (스테일 타이머 발사 없음)", () => {
    const flushed: Buffer[] = [];
    const buf = new PtyChunkBuffer({ delayMs: 15, maxBytes: 8, onFlush: (b) => flushed.push(b) });

    buf.push(Buffer.alloc(10, 0x61)); // maxBytes 초과 → 즉시 flush(10B)
    expect(flushed.length).toBe(1);
    buf.push(Buffer.from("tail")); // 새 윈도우
    vi.advanceTimersByTime(15);
    expect(flushed.length).toBe(2);
    expect(flushed[1].toString()).toBe("tail"); // 첫 윈도우 잔재가 새지 않음
  });

  it("maxBytes·타이머 혼합 트리거에도 concat == 입력, 순서/경계 보존", () => {
    const flushed: Buffer[] = [];
    const buf = new PtyChunkBuffer({ delayMs: 15, maxBytes: 16, onFlush: (b) => flushed.push(b) });

    const inputs = ["ab", "cdefghij", "kl", "mnopqrstuvwxyz", "z", "01234567"];
    for (const s of inputs) {
      buf.push(Buffer.from(s));
      vi.advanceTimersByTime(3); // 윈도우 안에서 조금씩 — 일부는 maxBytes, 일부는 타이머로 flush
    }
    buf.flush(); // 잔여
    const merged = Buffer.concat(flushed).toString();
    expect(merged).toBe(inputs.join(""));
  });
});

describe("prunePtyChunks vs reader 윈도우 — 불변식 + 경계", () => {
  it("불변식: PTY_CHUNK_RETAIN 이 모든 reader 윈도우보다 크거나 같다 (조용한 회귀 가드)", () => {
    // 이 단언이 깨지면 = 누군가 retain 을 reader 윈도우 아래로 내린 것 → 콜드 리플레이/스냅샷에
    // 손실이 생긴다. retain 을 다시 올리거나 reader 윈도우를 함께 줄여야 한다.
    expect(PTY_CHUNK_RETAIN).toBeGreaterThanOrEqual(READER_WINDOWS.snapshotTail);
    expect(PTY_CHUNK_RETAIN).toBeGreaterThanOrEqual(READER_WINDOWS.coldPoll);
    expect(PTY_CHUNK_RETAIN).toBeGreaterThanOrEqual(READER_WINDOWS.wsCatchUp);
  });

  it("경계 정확성 — retain+K 를 넣고 prune 하면 정확히 newest retain 만 남는다 (off-by-one 없음)", () => {
    const sid = "boundary";
    seedSession(sid);
    const retain = 30;
    const K = 12;
    const N = retain + K;
    seedRange(sid, 0, N); // created_at = seq = 0..N-1

    const deleted = prunePtyChunks(sid, retain);
    expect(deleted).toBe(K);
    expect(chunkCount(sid)).toBe(retain);

    // 남은 것은 «정확히» 최신 retain 개 — [K .. N-1], 연속·정렬·무손실.
    expect(newestWindowSeqs(sid, retain)).toEqual(range(K, N));
    // newest-1 은 마지막, newest-retain 은 윈도우 전체.
    expect(newestWindowSeqs(sid, 1)).toEqual([N - 1]);
  });

  it("retain 보다 적게 들어있으면 prune 은 아무것도 안 지운다", () => {
    const sid = "under-retain";
    seedSession(sid);
    seedRange(sid, 0, 10);
    expect(prunePtyChunks(sid, 50)).toBe(0);
    expect(chunkCount(sid)).toBe(10);
  });

  it("동률 created_at 경계는 «과보존» 만 한다 — reader 윈도우를 절대 깎지 않는다", () => {
    const sid = "ties";
    seedSession(sid);
    // 0..19 는 distinct, 그리고 경계가 떨어질 지점에 동률 created_at 을 심는다.
    seedRange(sid, 0, 20);
    // seq 20,21,22 모두 created_at=10 (경계 근처 동률) — prune 은 created_at < boundary 만 지우므로
    // 동률은 통째로 남아 retain 을 초과 보존(손실 0).
    seedChunk(sid, 20, 10);
    seedChunk(sid, 21, 10);
    seedChunk(sid, 22, 10);

    const before = chunkCount(sid);
    prunePtyChunks(sid, 5);
    const after = chunkCount(sid);
    // 최신 5개(=created_at 15..19)는 반드시 보존돼 있어야 한다 (윈도우 손실 0).
    expect(newestWindowSeqs(sid, 5)).toEqual([15, 16, 17, 18, 19]);
    expect(after).toBeLessThanOrEqual(before);
    expect(after).toBeGreaterThanOrEqual(5);
  });
});

describe("prune/reader 경합 스트레스 — newest-W 윈도우가 절대 찢기지 않는다", () => {
  it("insert→prune→read 를 다양한 배치 크기로 반복해도 윈도우가 정확·연속·무손실", () => {
    const sid = "stress";
    seedSession(sid);
    const retain = 40;
    // 경계(=retain) 전후를 모두 밟는 배치 크기들 — off-by-one 이 있으면 어디선가 찢긴다.
    const batches = [1, 7, retain - 1, retain, retain + 3, 2 * retain, 5, retain, 13, retain + 1];

    let total = 0; // 지금까지 삽입한 seq 개수 (= 다음 seq)
    for (const batch of batches) {
      seedRange(sid, total, total + batch); // created_at = seq, 단조 증가
      total += batch;
      prunePtyChunks(sid, retain);

      // 보존량은 항상 min(total, retain).
      expect(chunkCount(sid)).toBe(Math.min(total, retain));

      // 여러 reader 윈도우(W ≤ retain)가 항상 «정확히 최신 W» 를 본다 — 갭/중복/손실/뒤섞임 0.
      for (const w of [1, Math.floor(retain / 2), retain]) {
        const expectedFrom = Math.max(0, total - w);
        expect(newestWindowSeqs(sid, w)).toEqual(range(expectedFrom, total));
      }
    }
  });

  it("read(snapshot) 와 prune 이 겹쳐도 스냅샷이 찢기지 않는다 (read-vs-prune 격리)", async () => {
    const sid = "snap-vs-prune";
    seedSession(sid);
    const retain = 200;
    const N = retain + 150; // retain 초과 — prune 이 실제로 자른다
    seedRange(sid, 0, N);

    // 스냅샷 읽기를 «시작» 한 직후, 같은 틱에서 prune 을 쏜다. buildPtySnapshot 은 행을 한 번의
    // 동기 SELECT 로 materialize 한 뒤 xterm.write 를 await 하므로, 이미 읽은 스냅샷은 뒤이은
    // prune 에 의해 손상되지 않아야 한다(읽기-쓰기 격리).
    const snapPromise = buildPtySnapshot(sid, { cols: 80, rows: 24 });
    const deleted = prunePtyChunks(sid, retain);
    const snap = await snapPromise;

    expect(deleted).toBe(N - retain); // prune 은 제 몫을 했고
    // 스냅샷은 «완전한 tail» — 가장 최신 줄(seq N-1)을 반드시 포함하고, 손실로 비지 않는다.
    expect(snap.snapshot.length).toBeGreaterThan(0);
    expect(snap.snapshot).toContain(`seq:${N - 1}`);

    // prune 후에도 reader 윈도우는 무손실: 최신 retain 이 [N-retain .. N-1] 로 온전.
    expect(chunkCount(sid)).toBe(retain);
    expect(newestWindowSeqs(sid, retain)).toEqual(range(N - retain, N));
  });

  it("createPtyFlushHandler 의 주기적 prune 과 reader 가 공존해도 최신 윈도우 무손실", async () => {
    // 실제 핫패스 모사: prune 을 반복 호출하는 사이사이 reader 가 최신 윈도우를 읽는다.
    const sid = "hotpath";
    seedSession(sid);
    const retain = 100;
    let total = 0;
    for (let round = 0; round < 8; round++) {
      seedRange(sid, total, total + 60);
      total += 60;
      prunePtyChunks(sid, retain); // onFlush 의 주기적 compaction 자리
      // reader: 스냅샷 tail 윈도우(여기선 retain 이하) — 항상 최신 내용 포함, 무손실.
      const snap = await buildPtySnapshot(sid, { cols: 80, rows: 24 });
      expect(snap.snapshot).toContain(`seq:${total - 1}`);
      expect(chunkCount(sid)).toBe(Math.min(total, retain));
      expect(newestWindowSeqs(sid, 10)).toEqual(range(total - 10, total));
    }
  });
});
