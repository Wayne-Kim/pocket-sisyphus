/**
 * `ws/hub` 의 catch-up — `replayPtyChunksSince` 윈도우/멱등/필터/정렬 단위 테스트.
 *
 * 회귀 방지: 폰이 끊겼다 재연결할 때(WiFi↔셀룰러·백그라운드 복귀) daemon 은 subscribe 의
 * `since`(마지막 본 created_at) 이후 pty_chunk 만 1:1 backfill 한다. 이 계약이 조용히
 * 깨지면 Mac 에이전트 출력이 «끊겨» 보이거나(누락) 중복이 새므로 명시적으로 고정한다:
 *   - 윈도우: created_at > since «초과» 만(경계 동률 제외).
 *   - 멱등: 같은 since 로 두 번 호출 → 동일한 id/순서/바이트(클라 seenMessageIds 가 dedup).
 *   - 타입 필터: pty_chunk 만(user/exit 는 polling 이 받음).
 *   - 정렬: created_at ASC(시간순 replay — ANSI 상태가 누적 의존).
 *   - 한도: 1000 으로 잘라 socket buffer 폭주 방지.
 *
 * 격리 전략은 `agent/pty-snapshot.test.ts` 와 동일 — `../config.js` 를 tmpdir 로 mock.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

const H = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fsH = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const osH = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pathH = require("node:path") as typeof import("node:path");
  const dir = fsH.mkdtempSync(pathH.join(osH.tmpdir(), "ps-catchup-test-"));
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
const { replayPtyChunksSince } = await import("./hub.js");
const { db, _resetDbForTest } = await import("../db/index.js");

const OPEN = 1;

interface SentMsg {
  type: string;
  sessionId: string;
  id: string;
  bytes_b64: string;
}

interface FakeWs {
  readyState: number;
  OPEN: number;
  send: (data: unknown) => void;
  sent: SentMsg[];
}

function makeWs(opts?: { closed?: boolean }): FakeWs {
  const sent: SentMsg[] = [];
  return {
    readyState: opts?.closed ? 3 : OPEN,
    OPEN,
    sent,
    send(data: unknown) {
      sent.push(JSON.parse(String(data)) as SentMsg);
    },
  };
}

function seedChunk(sessionId: string, id: string, text: string, createdAt: number): void {
  db().prepare(
    `INSERT INTO messages (id, session_id, role, type, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    id, sessionId, "assistant", "pty_chunk",
    JSON.stringify({ bytes_b64: Buffer.from(text, "utf8").toString("base64") }),
    createdAt,
  );
}

function seedOther(sessionId: string, id: string, type: string, createdAt: number): void {
  db().prepare(
    `INSERT INTO messages (id, session_id, role, type, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, sessionId, "user", type, JSON.stringify({ text: "x" }), createdAt);
}

function seedSession(sessionId: string): void {
  db().prepare(
    `INSERT INTO sessions (id, repo_path, created_at) VALUES (?, ?, ?)`,
  ).run(sessionId, "/tmp/x", Date.now());
}

function decode(b64: string): string {
  return Buffer.from(b64, "base64").toString("utf8");
}

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

describe("replayPtyChunksSince — catch-up 윈도우", () => {
  it("created_at > since «초과» 만 backfill(경계 동률 제외)", () => {
    const sid = "s1";
    seedSession(sid);
    seedChunk(sid, "a", "A", 100);
    seedChunk(sid, "b", "B", 200); // == since (경계) → 제외
    seedChunk(sid, "c", "C", 300);
    seedChunk(sid, "d", "D", 400);
    const ws = makeWs();
    replayPtyChunksSince(ws as never, sid, 200);
    expect(ws.sent.map((m) => m.id)).toEqual(["c", "d"]);
  });

  it("since 이후가 없으면 아무것도 보내지 않는다", () => {
    const sid = "s2";
    seedSession(sid);
    seedChunk(sid, "a", "A", 100);
    const ws = makeWs();
    replayPtyChunksSince(ws as never, sid, 100);
    expect(ws.sent).toHaveLength(0);
  });

  it("created_at ASC 시간순으로 replay(상태 누적 의존)", () => {
    const sid = "s3";
    seedSession(sid);
    // 삽입 순서를 일부러 뒤섞어도 정렬은 created_at ASC.
    seedChunk(sid, "c", "C", 300);
    seedChunk(sid, "a", "A", 100);
    seedChunk(sid, "b", "B", 200);
    const ws = makeWs();
    replayPtyChunksSince(ws as never, sid, 0);
    expect(ws.sent.map((m) => m.id)).toEqual(["a", "b", "c"]);
  });
});

describe("replayPtyChunksSince — 멱등성", () => {
  it("같은 since 로 두 번 호출하면 동일한 id/순서/바이트(클라가 dedup)", () => {
    const sid = "i1";
    seedSession(sid);
    seedChunk(sid, "a", "alpha", 100);
    seedChunk(sid, "b", "bravo", 200);
    seedChunk(sid, "c", "charlie", 300);

    const ws1 = makeWs();
    const ws2 = makeWs();
    replayPtyChunksSince(ws1 as never, sid, 100);
    replayPtyChunksSince(ws2 as never, sid, 100);

    // 같은 입력 → 결정론적으로 같은 결과(멱등). iOS seenMessageIds 가 중복 feed 를 무해화.
    expect(ws1.sent).toEqual(ws2.sent);
    expect(ws1.sent.map((m) => m.id)).toEqual(["b", "c"]);
    // 바이트가 원본과 일치.
    expect(decode(ws1.sent[0].bytes_b64)).toBe("bravo");
    expect(decode(ws1.sent[1].bytes_b64)).toBe("charlie");
  });

  it("진행된 since(watermark) 로 다시 호출하면 이미 본 청크는 다시 안 온다", () => {
    const sid = "i2";
    seedSession(sid);
    seedChunk(sid, "a", "A", 100);
    seedChunk(sid, "b", "B", 200);
    seedChunk(sid, "c", "C", 300);

    // 1차: since=0 → a,b,c. 클라가 마지막 created_at(300)을 watermark 로 갱신.
    const ws1 = makeWs();
    replayPtyChunksSince(ws1 as never, sid, 0);
    expect(ws1.sent.map((m) => m.id)).toEqual(["a", "b", "c"]);

    // 새 청크 도착 후 2차: since=300 → d 만(앞의 것은 재전송 안 함).
    seedChunk(sid, "d", "D", 400);
    const ws2 = makeWs();
    replayPtyChunksSince(ws2 as never, sid, 300);
    expect(ws2.sent.map((m) => m.id)).toEqual(["d"]);
  });
});

describe("replayPtyChunksSince — 타입 필터 / 한도 / 소켓상태", () => {
  it("pty_chunk «만» backfill — user/exit 류는 제외", () => {
    const sid = "f1";
    seedSession(sid);
    seedChunk(sid, "a", "A", 100);
    seedOther(sid, "u", "pty_user_input", 150);
    seedOther(sid, "e", "pty_exit", 160);
    seedChunk(sid, "b", "B", 200);
    const ws = makeWs();
    replayPtyChunksSince(ws as never, sid, 0);
    expect(ws.sent.map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("1000 개 한도 — 초과분은 잘린다(가장 오래된 1000개)", () => {
    const sid = "f2";
    seedSession(sid);
    for (let i = 0; i < 1200; i++) seedChunk(sid, `m${i}`, `n${i}`, 1000 + i);
    const ws = makeWs();
    replayPtyChunksSince(ws as never, sid, 0);
    expect(ws.sent).toHaveLength(1000);
    // ASC LIMIT 1000 → 가장 오래된 1000개(m0..m999).
    expect(ws.sent[0].id).toBe("m0");
    expect(ws.sent[999].id).toBe("m999");
  });

  it("소켓이 OPEN 이 아니면 즉시 반환(아무것도 안 보냄)", () => {
    const sid = "f3";
    seedSession(sid);
    seedChunk(sid, "a", "A", 100);
    const ws = makeWs({ closed: true });
    replayPtyChunksSince(ws as never, sid, 0);
    expect(ws.sent).toHaveLength(0);
  });

  it("다른 세션의 청크는 섞이지 않는다", () => {
    seedSession("g1");
    seedSession("g2");
    seedChunk("g1", "a", "A", 100);
    seedChunk("g2", "b", "B", 110);
    const ws = makeWs();
    replayPtyChunksSince(ws as never, "g1", 0);
    expect(ws.sent.map((m) => m.id)).toEqual(["a"]);
  });
});
