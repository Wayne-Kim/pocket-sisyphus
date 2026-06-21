/**
 * PTY 입력 골든 테스트 — KS-TRACE 가 «수동으로» 검증하던 «송신 바이트 == PTY write 바이트»
 * 를 어댑터별 자동 단언으로 못박는다. CJK/IME 입력 회귀(copilot 등에서 이력)를 CI 에서 차단.
 *
 * ## 무엇을 대체하나 (현행 수동 절차 → 자동화)
 *
 * 현행: `PS_KS_TRACE=1` 로 띄운 뒤 각 어댑터에 한글/이모지를 입력하고, 로그의
 *   `[KS-TRACE] send …`(iOS) 와 `[KS-TRACE] recv …`(daemon) hex 짝을 «눈으로» 대조해
 *   WS·sanitize 경로에서 바이트가 어긋났는지 확인했다(pty-runner.ts 의 ksTrace 주석).
 * 자동: daemon 쪽 종착지인 `writePtyRaw` 가 PTY 로 흘려보내는 «실제 write 바이트» 를 가짜
 *   node-pty 로 캡처해, 입력 바이트와 «정확히 같은지» 단언한다. 한글이 latin-1 로 재인코딩돼
 *   두 배로 깨지던 옛 회귀(e5 88 9c → c3 a5 c2 88 c2 9c, pty-runner.ts:1162 주석)가 다시
 *   들어오면 이 단언이 즉시 깨진다.
 *
 * ## 왜 writePtyRaw 인가
 *
 * iOS RealtimeTextField 는 ASCII 매 글자 / 한글 음절 완료 / 특수키를 base64 로 인코딩해
 * WS `pty_input` 으로 보내고, daemon 은 그걸 `writePtyRaw(sessionId, bytes)` 로 PTY stdin 에
 * 그대로 흘린다(pty-runner.ts:1135). CJK/IME 회귀가 사는 «실시간 키스트로크» 경로가 바로
 * 여기다 — KS-TRACE 의 recv 라인도 이 함수 안에서 찍힌다.
 *
 * ## 격리 전략
 *
 * - `node-pty` 를 mock — spawn 이 write 를 기록하는 가짜 PTY 를 돌려준다(실제 CLI 불필요).
 * - `../config.js`(tmpdir) · `../ws/hub.js`(broadcast 캡처) · `../notify/index.js`(no-op) mock.
 *   DB singleton 은 실제(`_resetDbForTest`) — pty-flush.test.ts / pty-snapshot.test.ts 와 동일.
 * - 어댑터의 `prepareBackend`/`releaseBackend`(local_llm·opencode 의 백엔드 기동/정지)는 이
 *   테스트의 스코프(= I/O 바이트 무결성) 밖이라 no-op 로 중화 — prewarm 을 부작용 없이 한다.
 * - PS_KS_TRACE=1 을 import 전에 켜서 ksTrace 포맷도 함께 검증한다(아래 별도 describe).
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from "vitest";
import type { IPty } from "node-pty";
import type { AgentAdapter } from "./types.js";

const H = vi.hoisted(() => {
  // ksTrace 포맷 검증을 위해 import «전에» 켠다 (KS_TRACE 는 모듈 로드 시 1회 평가).
  process.env.PS_KS_TRACE = "1";
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fsH = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const osH = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pathH = require("node:path") as typeof import("node:path");
  const dir = fsH.mkdtempSync(pathH.join(osH.tmpdir(), "ps-input-golden-"));
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

vi.mock("../ws/hub.js", () => ({
  broadcastToSession: () => {},
  broadcastAll: () => {},
}));

vi.mock("../notify/index.js", () => ({
  dispatchNotification: () => Promise.resolve(),
}));

/**
 * 가짜 PTY — node-pty 의 IPty 중 runner 가 쓰는 표면만 구현한다. write 인자를 그대로
 * 보관해 «PTY 가 실제로 받은 바이트» 를 단언할 수 있게 한다. kill 은 등록된 onExit 를
 * 호출해 runner 의 정리 경로(activePtys.delete 등)를 그대로 태운다.
 */
class FakePty {
  writes: Array<string | Buffer> = [];
  pid = 4242;
  cols = 130;
  rows = 40;
  private dataCb: ((d: string) => void) | null = null;
  private exitCb: ((e: { exitCode: number; signal?: number }) => void) | null = null;
  onData(cb: (d: string) => void): { dispose(): void } {
    this.dataCb = cb;
    return { dispose() {} };
  }
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): { dispose(): void } {
    this.exitCb = cb;
    return { dispose() {} };
  }
  write(data: string | Buffer): void {
    this.writes.push(data);
  }
  resize(): void {}
  kill(): void {
    this.exitCb?.({ exitCode: 0, signal: undefined });
  }
  emitData(s: string): void {
    this.dataCb?.(s);
  }
  /** write 로 들어온 모든 조각을 바이트로 이어붙인다 (Buffer/string 혼재 정규화). */
  writtenBytes(): Buffer {
    return Buffer.concat(this.writes.map((w) => (Buffer.isBuffer(w) ? w : Buffer.from(w, "utf8"))));
  }
}

const fakes: FakePty[] = [];
vi.mock("node-pty", () => ({
  spawn: (..._args: unknown[]) => {
    const p = new FakePty();
    fakes.push(p);
    return p as unknown as IPty;
  },
}));

const fs = await import("node:fs");
const { db, _resetDbForTest } = await import("../db/index.js");
const { registerBuiltinAgents } = await import("./index.js");
const { listAgents, getAgent } = await import("./registry.js");
const { prewarmPty, writePtyRaw, abortPtySession, ksTrace } = await import("./pty-runner.js");

/** 브리프가 못박길 요구한 어댑터 7종. roster 트립와이어의 골든 집합. */
const EXPECTED_ADAPTERS = [
  "claude_code",
  "agy",
  "codex",
  "copilot",
  "opencode",
  "shell",
  "local_llm",
] as const;

/**
 * 어댑터별 «중지(interrupt)» 제어 바이트의 골든 — routes/sessions.ts 의 해석과 동일:
 * adapter.interruptBytes() 가 있으면 그 값, 없으면 ESC(\x1b) 폴백(claude_code·codex).
 */
const EXPECTED_INTERRUPT: Record<string, number[]> = {
  claude_code: [0x1b], // ESC 폴백 (메서드 생략)
  codex: [0x1b], // ESC 폴백 (메서드 생략)
  agy: [0x1b], // ESC
  opencode: [0x1b], // ESC
  local_llm: [0x1b], // ESC
  copilot: [0x03], // Ctrl-C
  shell: [0x03], // Ctrl-C
};

/**
 * 입력 골든 벡터 — 브리프의 예시를 그대로. 모두 «터미널 질의 응답» 시퀀스가 아니라서
 * writePtyRaw 의 stripTerminalQueryResponses 를 무손실 통과해야 한다(= byte 보존).
 */
const INPUT_VECTORS: Array<{ name: string; bytes: Buffer; hex: string }> = [
  { name: "CJK 한 글자 '가'", bytes: Buffer.from("가", "utf8"), hex: "ea b0 80" },
  {
    name: "CJK 어구 '안녕하세요'",
    bytes: Buffer.from("안녕하세요", "utf8"),
    hex: "ec 95 88 eb 85 95 ed 95 98 ec 84 b8 ec 9a 94",
  },
  { name: "이모지 '🙂' (4바이트)", bytes: Buffer.from("🙂", "utf8"), hex: "f0 9f 99 82" },
  { name: "텍스트+Enter 'ls -la\\r'", bytes: Buffer.from("ls -la\r", "utf8"), hex: "6c 73 20 2d 6c 61 0d" },
  { name: "단일 ASCII 'a'", bytes: Buffer.from("a", "utf8"), hex: "61" },
];

const createdSids: string[] = [];
/** beforeEach 가 console.log 를 여기로 캡처 — ksTrace 포맷 단언이 읽는다. */
let logLines: string[] = [];

/** messages 의 FK 충족 + onExit 의 pty_exit insert 가 throw 안 하도록 세션 행을 직접 삽입. */
function seedSession(sessionId: string): void {
  db().prepare(`INSERT INTO sessions (id, repo_path, created_at) VALUES (?, ?, ?)`).run(
    sessionId,
    "/tmp/x",
    Date.now(),
  );
}

/** spawnOverride 로 resolveBinary/buildSpawnArgs 를 우회해 미설치 CLI 에서도 prewarm 가능. */
function makeCtx(sessionId: string, adapter: AgentAdapter) {
  return {
    sessionId,
    cwd: H.tmpDir,
    adapter,
    spawnOverride: { binary: "/usr/bin/true", args: [] as string[] },
  };
}

/** 어댑터로 PTY 를 띄우고 그 가짜 PTY 핸들을 돌려준다. */
function prewarmFor(sessionId: string, adapter: AgentAdapter): FakePty {
  seedSession(sessionId);
  createdSids.push(sessionId);
  const before = fakes.length;
  prewarmPty(makeCtx(sessionId, adapter));
  expect(fakes.length).toBe(before + 1); // spawn 이 정확히 1번
  return fakes[fakes.length - 1];
}

beforeAll(() => {
  registerBuiltinAgents();
  // 백엔드 기동/정지는 이 테스트(= I/O 바이트 무결성)의 스코프 밖 — prewarm 을 부작용 없이
  // 하도록 no-op 로 중화한다. (vitest 는 파일 단위 모듈 격리라 다른 테스트로 새지 않는다.)
  for (const a of listAgents()) {
    (a as { prepareBackend?: unknown }).prepareBackend = undefined;
    (a as { releaseBackend?: unknown }).releaseBackend = undefined;
  }
});

beforeEach(() => {
  // markTurnSubmitted(CR 입력) 가 거는 idle/release 타이머를 흡수 — 발사시키지 않고 정리한다.
  vi.useFakeTimers();
  logLines = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logLines.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  fakes.length = 0;
  createdSids.length = 0;
  _resetDbForTest();
  for (const ext of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(H.dbFile + ext);
    } catch {
      /* not exists */
    }
  }
});

afterEach(() => {
  // 살아있는 PTY 를 정리 — onExit 가 타이머를 걷어내고 activePtys 에서 제거.
  for (const sid of createdSids) {
    try {
      abortPtySession(sid);
    } catch {
      /* 이미 정리됨 */
    }
  }
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

afterAll(() => {
  _resetDbForTest();
  try {
    fs.rmSync(H.tmpDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe("어댑터 roster 골든 (추가/변경 트립와이어)", () => {
  it("등록된 어댑터 id 집합이 브리프의 7종과 정확히 일치", () => {
    const ids = listAgents()
      .map((a) => a.id)
      .sort();
    expect(ids).toEqual([...EXPECTED_ADAPTERS].sort());
  });
});

describe("입력 골든 — 송신 바이트 == PTY write 바이트 (어댑터별)", () => {
  for (const adapterId of EXPECTED_ADAPTERS) {
    describe(`adapter=${adapterId}`, () => {
      for (const vec of INPUT_VECTORS) {
        it(`${vec.name} 가 손실/변형 없이 PTY 로 전달`, () => {
          const adapter = getAgent(adapterId);
          const sid = `golden-${adapterId}-${vec.hex.replace(/ /g, "")}`;
          const pty = prewarmFor(sid, adapter);

          pty.writes.length = 0; // splash 등 prewarm 시 write 가 있을 수 있으니 비우고 시작
          const ok = writePtyRaw(sid, vec.bytes);
          expect(ok).toBe(true);

          const written = pty.writtenBytes();
          // 핵심 단언: PTY 가 받은 바이트 == 입력 바이트 (hex 골든).
          expect(written.toString("hex").match(/.{1,2}/g)?.join(" ")).toBe(vec.hex);
          expect(written.equals(vec.bytes)).toBe(true);
        });
      }

      it("여러 입력을 연달아 보내도 바이트 순서·경계가 보존", () => {
        const adapter = getAgent(adapterId);
        const sid = `golden-seq-${adapterId}`;
        const pty = prewarmFor(sid, adapter);
        pty.writes.length = 0;

        const parts = [Buffer.from("가", "utf8"), Buffer.from("a", "utf8"), Buffer.from("🙂", "utf8")];
        for (const p of parts) writePtyRaw(sid, p);

        const expected = Buffer.concat(parts);
        expect(pty.writtenBytes().equals(expected)).toBe(true);
      });
    });
  }
});

describe("어댑터별 interrupt(중지) 제어 바이트 골든", () => {
  for (const adapterId of EXPECTED_ADAPTERS) {
    it(`adapter=${adapterId} 의 effective interrupt byte 가 골든과 일치 + writePtyRaw 무손실 통과`, () => {
      const adapter = getAgent(adapterId);
      const expected = Buffer.from(EXPECTED_INTERRUPT[adapterId]);

      // routes/sessions.ts 와 동일 해석: 메서드 있으면 그 값, 없으면 ESC 폴백.
      const resolved = adapter.interruptBytes ? adapter.interruptBytes() : Buffer.from([0x1b]);
      expect(resolved.equals(expected)).toBe(true);

      // 그 바이트가 PTY 까지 그대로 흐르는지 (interrupt 도 writePtyRaw 경로).
      const sid = `interrupt-${adapterId}`;
      const pty = prewarmFor(sid, adapter);
      pty.writes.length = 0;
      writePtyRaw(sid, resolved);
      expect(pty.writtenBytes().equals(expected)).toBe(true);
    });
  }
});

describe("ksTrace 포맷 (iOS KSTrace.swift 와 1:1)", () => {
  it("send/recv 라인이 정확한 hex 포맷으로 찍힌다", () => {
    logLines.length = 0;
    ksTrace("send", "sess-1", "claude_code", Buffer.from("가", "utf8"));
    expect(logLines).toContain(
      "[KS-TRACE] send session=sess-1 agent=claude_code bytes=3 hex=[ea b0 80]",
    );

    logLines.length = 0;
    ksTrace("recv", "sess-1", "copilot", Buffer.from("안녕", "utf8"));
    expect(logLines[0]).toBe(
      "[KS-TRACE] recv session=sess-1 agent=copilot bytes=6 hex=[ec 95 88 eb 85 95]",
    );
  });

  it("64바이트 초과분은 +Nmore 로 표기 (hexCap=64)", () => {
    logLines.length = 0;
    const big = Buffer.alloc(70, 0x41); // 'A' * 70
    ksTrace("recv", "s", "shell", big);
    expect(logLines[0]).toContain("bytes=70");
    expect(logLines[0]).toContain("+6more"); // 70 - 64
    // hex 프리뷰는 정확히 64바이트만 (초과분은 +Nmore 로만).
    const inside = /hex=\[(.*)\]/.exec(logLines[0])?.[1] ?? "";
    const body = inside.replace(/ \+\d+more$/, "");
    expect(body.split(" ").length).toBe(64);
  });

  it("note 가 라인 끝에 덧붙는다 (대조 시 차이 설명용)", () => {
    logLines.length = 0;
    ksTrace("recv", "s", "agy", Buffer.from([0x61]), "(dropped 3B term-response)");
    expect(logLines[0]).toBe(
      "[KS-TRACE] recv session=s agent=agy bytes=1 hex=[61] (dropped 3B term-response)",
    );
  });
});

describe("입력 정화 — 사용자 CJK/이모지는 보존, stale 터미널 응답만 제거", () => {
  it("writePtyRaw 는 Buffer 를 그대로 전달 (latin-1 재인코딩 회귀 가드)", () => {
    const adapter = getAgent("claude_code");
    const sid = "no-double-encode";
    const pty = prewarmFor(sid, adapter);
    pty.writes.length = 0;

    // 옛 회귀: bytes.toString("binary") 로 latin-1 string 을 만들면 한글이 두 배로 깨졌다.
    // '한'(ed 95 9c) 가 그대로 도착해야 한다.
    writePtyRaw(sid, Buffer.from("한", "utf8"));
    expect(pty.writtenBytes().toString("hex")).toBe("ed959c");
  });

  it("stale 터미널 질의 응답(DA/kitty)이 섞이면 그 부분만 떨어지고 사용자 입력은 통과", () => {
    const adapter = getAgent("claude_code");
    const sid = "strip-stale";
    const pty = prewarmFor(sid, adapter);
    pty.writes.length = 0;

    // SwiftTerm 이 늦게 회신한 kitty 플래그 응답(CSI ? 0 u) + DA1 응답(CSI ? ... c) 뒤에
    // 사용자가 친 '가'. 응답 시퀀스만 제거되고 '가'(ea b0 80) 는 남아야 한다.
    const stale = Buffer.from("\x1b[?0u\x1b[?65;4;1;2;6;21;22;17;28c", "latin1");
    const payload = Buffer.concat([stale, Buffer.from("가", "utf8")]);
    const ok = writePtyRaw(sid, payload);
    expect(ok).toBe(true);
    expect(pty.writtenBytes().toString("hex")).toBe("eab080");
  });

  it("페이로드 전체가 stale 응답이면 PTY write 자체를 안 한다 (드롭)", () => {
    const adapter = getAgent("claude_code");
    const sid = "all-stale";
    const pty = prewarmFor(sid, adapter);
    pty.writes.length = 0;

    const stale = Buffer.from("\x1b[?0u", "latin1");
    const ok = writePtyRaw(sid, stale);
    expect(ok).toBe(true); // 드롭은 «성공» 으로 취급 (호출부 회귀 없음)
    expect(pty.writes.length).toBe(0);
  });
});
