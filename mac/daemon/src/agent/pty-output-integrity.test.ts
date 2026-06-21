/**
 * PTY 출력 무결성 테스트 — 빠른 대용량 버스트가 coalesce 를 거쳐 `pty_chunk` 로 «유실 없이»
 * 들어오고, 순서·경계가 보존되며, 종료 시 잔여가 빠짐없이 flush 되는지 자동 단언으로 못박는다.
 *
 * ## 대비하는 node-pty 무결성 버그
 *
 * - #726 «빠른 >4KB 출력 유실» — seq/yes 류가 토하는 빠른 버스트가 onData→coalesce→DB 경로에서
 *   조용히 새는지. 핵심 단언: «흘려보낸 바이트 합 == 재구성한 바이트 합» + 순서 보존.
 * - #140 «데이터 다 받기 전 exit» — 종료(onExit→outputBuffer.dispose) 시 버퍼에 남은 잔여
 *   청크가 flush 돼 DB·broadcast 양쪽에 도착하는지. 마지막 한 조각이 사라지면 안 된다.
 *
 * ## 무엇을 «진실» 로 삼나
 *
 * createPtyFlushHandler 는 onFlush 마다 insert(DB) 와 broadcast(WS) 를 «같은 messageId» 로
 * 한다. broadcast 배열은 flush 순서(= 라이브 WS 스트림 순서 = 삽입 순서)를 그대로 보존하므로
 * 이걸 «라이브 스트림의 ground truth» 로 삼는다. DB 는 별도로 «완전성»(모든 청크가 같은 id 로
 * 남았는지)을 확인한다. 콜드 리플레이의 «reader 정렬» 무결성은 별도 테스트에서 created_at 을
 * 통제해 검증한다(같은 ms 동기 flush 의 id tiebreak 모호성을 피하려고 분리).
 *
 * 격리 전략은 pty-flush.test.ts 와 동일 — config tmpdir mock + ws/hub broadcast 캡처 + 실제 DB.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

const H = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fsH = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const osH = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pathH = require("node:path") as typeof import("node:path");
  const dir = fsH.mkdtempSync(pathH.join(osH.tmpdir(), "ps-output-integrity-"));
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

type Broadcast = { sessionId: string; message: { type: string; id: string; bytes_b64: string } };
const broadcasts: Broadcast[] = [];
vi.mock("../ws/hub.js", () => ({
  broadcastToSession: (sessionId: string, message: unknown) => {
    broadcasts.push({ sessionId, message: message as Broadcast["message"] });
  },
  broadcastAll: () => {},
}));

const fs = await import("node:fs");
const { createPtyFlushHandler } = await import("./pty-runner.js");
const { PtyChunkBuffer } = await import("./pty-coalesce.js");
const { db, _resetDbForTest } = await import("../db/index.js");

const MAX_BYTES = 16 * 1024; // ensurePty 의 PtyChunkBuffer maxBytes 와 동일

function seedSession(sessionId: string): void {
  db().prepare(`INSERT INTO sessions (id, repo_path, created_at) VALUES (?, ?, ?)`).run(
    sessionId,
    "/tmp/x",
    Date.now(),
  );
}

/** 라이브 WS 스트림(broadcast 순서)을 이어붙인 바이트 — flush 순서 = 삽입 순서. */
function liveStream(sessionId: string): Buffer {
  return Buffer.concat(
    broadcasts
      .filter((b) => b.sessionId === sessionId)
      .map((b) => Buffer.from(b.message.bytes_b64, "base64")),
  );
}

/** DB 의 모든 pty_chunk 를 id→바이트로. 완전성(개수/내용) 확인용. */
function dbChunksById(sessionId: string): Map<string, Buffer> {
  const rows = db()
    .prepare(`SELECT id, payload FROM messages WHERE session_id = ? AND type = 'pty_chunk'`)
    .all(sessionId) as Array<{ id: string; payload: string }>;
  const map = new Map<string, Buffer>();
  for (const r of rows) {
    const b64 = (JSON.parse(r.payload) as { bytes_b64: string }).bytes_b64;
    map.set(r.id, Buffer.from(b64, "base64"));
  }
  return map;
}

/** «실제 reader» 가 콜드 리플레이에서 쓰는 정렬로 재구성 (catch-up/snapshot 과 동일 키). */
function readerOrderedStream(sessionId: string): Buffer {
  const rows = db()
    .prepare(
      `SELECT payload FROM messages WHERE session_id = ? AND type = 'pty_chunk'
       ORDER BY created_at ASC, id ASC`,
    )
    .all(sessionId) as Array<{ payload: string }>;
  return Buffer.concat(
    rows.map((r) => Buffer.from((JSON.parse(r.payload) as { bytes_b64: string }).bytes_b64, "base64")),
  );
}

/**
 * seq/yes 류의 «빠른 대용량 출력» 을 흉내 — `0\n1\n2\n…` 를 sizeBytes 이상 만든다.
 * 각 줄이 distinct 하므로 순서가 뒤바뀌면 재구성 비교에서 바로 드러난다.
 */
function makeSeqOutput(sizeBytes: number): Buffer {
  const parts: string[] = [];
  let total = 0;
  let n = 0;
  while (total < sizeBytes) {
    const line = `${n}\n`;
    parts.push(line);
    total += Buffer.byteLength(line);
    n++;
  }
  return Buffer.from(parts.join(""), "utf8");
}

/**
 * node-pty 가 한 버스트를 «작은 청크 여러 개» 로 쪼개 onData 하는 걸 흉내 — full 을 chunkSize
 * 단위로 잘라 순서대로 push 한다. 동기 루프라 setTimeout 이 중간에 끼어들지 않는다(실타이머 안전).
 */
function pushInChunks(buf: InstanceType<typeof PtyChunkBuffer>, full: Buffer, chunkSize: number): void {
  for (let off = 0; off < full.length; off += chunkSize) {
    buf.push(full.subarray(off, Math.min(off + chunkSize, full.length)));
  }
}

beforeEach(() => {
  broadcasts.length = 0;
  vi.restoreAllMocks();
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
  vi.restoreAllMocks();
  _resetDbForTest();
  try {
    fs.rmSync(H.tmpDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe("출력 무결성 — 빠른 버스트 무손실 + 순서/경계 보존 (#726)", () => {
  it("빠른 >4KB 버스트가 coalesce→broadcast 로 유실 없이, 순서 그대로 들어온다", () => {
    const sid = "burst-4k";
    seedSession(sid);
    const buf = new PtyChunkBuffer({ delayMs: 15, maxBytes: MAX_BYTES, onFlush: createPtyFlushHandler(sid) });

    const full = makeSeqOutput(8 * 1024); // >4KB
    pushInChunks(buf, full, 64); // node-pty 식 작은 청크
    buf.dispose(); // 종료 — 잔여까지 flush

    // 라이브 스트림(broadcast 순서) == 입력 (무손실 + 순서/경계 보존).
    expect(liveStream(sid).equals(full)).toBe(true);
  });

  it("동기 >16KB 버스트도 한 바이트도 안 잃고 전부 보존 (maxBytes 경계 다회 통과)", () => {
    const sid = "burst-64k";
    seedSession(sid);
    const flushes: number[] = [];
    const handler = createPtyFlushHandler(sid);
    // flush 횟수/크기를 보기 위해 핸들러를 감싼다.
    const buf = new PtyChunkBuffer({
      delayMs: 15,
      maxBytes: MAX_BYTES,
      onFlush: (b) => {
        flushes.push(b.length);
        handler(b);
      },
    });

    const full = makeSeqOutput(64 * 1024);
    pushInChunks(buf, full, 1024);
    buf.dispose();

    // 무손실 + 순서.
    expect(liveStream(sid).equals(full)).toBe(true);
    // maxBytes 경계를 여러 번 넘었으니 «한 덩어리로 버퍼링» 이 아니라 다회 flush 여야 한다
    // (메모리 bounded — 무한 버퍼링 방지). 64KB / 16KB ≈ 최소 4회.
    expect(flushes.length).toBeGreaterThanOrEqual(4);
    // 각 flush 는 maxBytes + 한 청크 미만으로 bounded (무한 누적 아님).
    for (const len of flushes) expect(len).toBeLessThan(MAX_BYTES + 1024);
  });

  it("DB 완전성 — 모든 broadcast 청크가 같은 id 로 DB 에 남고, 누락/잉여가 없다", () => {
    const sid = "db-complete";
    seedSession(sid);
    const buf = new PtyChunkBuffer({ delayMs: 15, maxBytes: MAX_BYTES, onFlush: createPtyFlushHandler(sid) });

    const full = makeSeqOutput(40 * 1024);
    pushInChunks(buf, full, 333); // 16KB 와 안 떨어지는 청크 → 경계가 청크 중간
    buf.dispose();

    const live = broadcasts.filter((b) => b.sessionId === sid);
    const dbMap = dbChunksById(sid);
    // 개수 일치 (누락/잉여 없음).
    expect(dbMap.size).toBe(live.length);
    // 각 broadcast id 가 DB 에 «같은 바이트» 로 존재.
    for (const b of live) {
      const dbBytes = dbMap.get(b.message.id);
      expect(dbBytes).toBeDefined();
      expect(dbBytes!.equals(Buffer.from(b.message.bytes_b64, "base64"))).toBe(true);
    }
    // 합산 무손실.
    expect(liveStream(sid).equals(full)).toBe(true);
  });

  it("UTF-8 multi-byte(한글)가 청크 경계에 걸쳐도 재구성 시 깨지지 않는다", () => {
    const sid = "utf8-boundary";
    seedSession(sid);
    const buf = new PtyChunkBuffer({ delayMs: 15, maxBytes: MAX_BYTES, onFlush: createPtyFlushHandler(sid) });

    const full = Buffer.from("안녕하세요 세계 🙂 ".repeat(2000), "utf8"); // 큰 다국어 버스트
    pushInChunks(buf, full, 7); // 일부러 3바이트 한글 중간을 자르는 홀수 청크
    buf.dispose();

    const live = liveStream(sid);
    expect(live.equals(full)).toBe(true);
    // 바이트가 맞으니 디코딩도 원문과 동일.
    expect(live.toString("utf8")).toBe(full.toString("utf8"));
  });
});

describe("종료 시 잔여 flush (#140 — 데이터 다 받기 전 exit)", () => {
  it("타이머 만료 전에 dispose 해도 버퍼의 잔여가 빠짐없이 flush 된다", () => {
    const sid = "exit-residual";
    seedSession(sid);
    const buf = new PtyChunkBuffer({ delayMs: 15, maxBytes: MAX_BYTES, onFlush: createPtyFlushHandler(sid) });

    // maxBytes 미만 — 타이머만 무장된 «pending» 상태. 타이머를 «발사하지 않고» 바로 종료.
    const tail = Buffer.from("마지막 출력 — 이게 사라지면 #140\n", "utf8");
    buf.push(tail);
    expect(buf.pendingBytes).toBeGreaterThan(0); // 아직 안 나감
    expect(broadcasts.length).toBe(0);

    buf.dispose(); // onExit 경로: 잔여 flush 후 폐쇄

    expect(buf.pendingBytes).toBe(0);
    expect(liveStream(sid).equals(tail)).toBe(true);
    // DB 에도 도착.
    expect(dbChunksById(sid).size).toBe(1);
  });

  it("큰 버스트 직후 dispose — maxBytes flush 분 + 잔여분이 합쳐 전부 보존", () => {
    const sid = "exit-after-burst";
    seedSession(sid);
    const buf = new PtyChunkBuffer({ delayMs: 15, maxBytes: MAX_BYTES, onFlush: createPtyFlushHandler(sid) });

    // 16KB 를 넘겨 한 번 maxBytes flush 가 일어난 뒤, 16KB 미만의 잔여가 남게 만든다.
    const full = makeSeqOutput(20 * 1024);
    pushInChunks(buf, full, 256);
    // dispose 직전: 일부는 이미 flush(maxBytes), 일부는 pending.
    const flushedBefore = liveStream(sid).length;
    expect(flushedBefore).toBeGreaterThan(0);
    expect(flushedBefore).toBeLessThan(full.length); // 잔여가 남아 있음

    buf.dispose();
    expect(liveStream(sid).equals(full)).toBe(true); // 잔여까지 합쳐 무손실
  });

  it("dispose 이후 push 는 DB·broadcast 어디에도 닿지 않는다", () => {
    const sid = "post-dispose-drop";
    seedSession(sid);
    const buf = new PtyChunkBuffer({ delayMs: 15, maxBytes: MAX_BYTES, onFlush: createPtyFlushHandler(sid) });

    buf.push(Buffer.from("kept\n", "utf8"));
    buf.dispose();
    const afterDispose = broadcasts.length;

    buf.push(Buffer.from("ignored\n", "utf8")); // 폐쇄된 버퍼
    expect(broadcasts.length).toBe(afterDispose); // 변화 없음
    expect(liveStream(sid).toString("utf8")).toBe("kept\n");
  });
});

describe("콜드 리플레이 — reader 정렬로 재구성해도 무손실 + 순서 보존", () => {
  it("flush 가 시간차로 나면 reader 정렬(created_at ASC) 재구성 == 입력", () => {
    const sid = "cold-replay";
    seedSession(sid);

    // created_at 을 단조 증가시켜 각 flush 가 distinct 타임스탬프를 갖게 한다 — 콜드 리플레이가
    // ORDER BY created_at ASC 로 읽을 때 순서가 삽입 순서와 일치함을 보장(15ms 코얼레스 윈도우로
    // 실제 flush 들이 시간상 떨어지는 정상 케이스를 모사).
    let clock = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => clock);

    const handler = createPtyFlushHandler(sid);
    const buf = new PtyChunkBuffer({
      delayMs: 15,
      maxBytes: MAX_BYTES,
      onFlush: (b) => {
        handler(b);
        clock += 15; // 다음 flush 는 다음 타임스탬프
      },
    });

    const full = makeSeqOutput(50 * 1024);
    pushInChunks(buf, full, 512);
    buf.dispose();

    // 콜드 리플레이 reader 가 보는 스트림 == 입력 (유실/재정렬 없음).
    expect(readerOrderedStream(sid).equals(full)).toBe(true);
  });
});
