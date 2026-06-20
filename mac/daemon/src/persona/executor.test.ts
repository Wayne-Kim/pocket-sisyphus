/**
 * `po/executor` 의 ingestVerdicts 계약 테스트 — host-less (HTTP/PTY 없이 함수 직접 호출).
 *
 * 왜 이 테스트가 있나: PO 누적 성적표(사람의 점수 보정)의 신뢰는 «출시 후 검증 전이가
 * 정확히 shipped 브리프에만, 같은 repo 에만 적용된다»는 불변식에 달려 있다. 이 불변식은
 * ingestVerdicts 의 SQL WHERE(`status='shipped' AND repo_path=?`) 한 줄로만 지켜진다.
 * 향후 리팩터가 status 가드나 repo_path 필터를 떨어뜨리면, 에이전트가 산출한 «신뢰 못 할»
 * 판정(tmp JSON)이 rejected/running/다른 repo 브리프를 조용히 verified/missed 로 덮어써
 * 성적표와 dedup 입력까지 오염돼도 아무도 모른다. 이 회귀 테스트가 그 계약을 못박는다.
 *
 * 격리: po.test.ts 와 동일 — config 를 mock 해 tmp DB 로, pty-runner/notify 를 mock 해
 * 실제 PTY spawn·Discord POST 를 차단한다. ingestVerdicts 만 직접 호출한다.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import fs from "node:fs";

const H = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fsH = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const osH = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pathH = require("node:path") as typeof import("node:path");
  const dir = fsH.mkdtempSync(pathH.join(osH.tmpdir(), "ps-po-verdict-test-"));
  return {
    tmpDir: dir,
    configFile: pathH.join(dir, "config.json"),
    dbFile: pathH.join(dir, "test.db"),
    repoA: "/repo/a",
    repoB: "/repo/b",
  };
});

vi.mock("../config.js", () => ({
  CONFIG_DIR: H.tmpDir,
  CONFIG_FILE: H.configFile,
  DB_FILE: H.dbFile,
  ensureConfigDir: () => fs.mkdirSync(H.tmpDir, { recursive: true }),
  readConfig: () => {
    try {
      return JSON.parse(fs.readFileSync(H.configFile, "utf8"));
    } catch {
      return null;
    }
  },
  writeConfig: (cfg: unknown) => {
    fs.writeFileSync(H.configFile, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  },
}));

// 실제 PTY spawn 차단 — executor 의 transitive import 가 진짜 PTY 를 만들지 않게.
vi.mock("../agent/pty-runner.js", () => ({
  ptyEvents: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
  isPtyActive: vi.fn(() => false),
  runUserMessagePty: vi.fn(async () => {}),
  runTerminalScriptPty: vi.fn(() => {}),
  abortPtySession: vi.fn(() => true),
  awaitPtyExit: vi.fn(async () => {}),
  prewarmPty: vi.fn(),
  resizePty: vi.fn(() => false),
  writePtyRaw: vi.fn(() => false),
  sendPtyKey: vi.fn(),
  emitSpawnFailure: vi.fn(),
}));

// Discord POST 차단.
vi.mock("../notify/index.js", () => ({
  dispatchNotification: vi.fn(async () => {}),
  dispatchCronNotification: vi.fn(async () => {}),
  dispatchPoNotification: vi.fn(async () => {}),
  dispatchPoWorkflowNotification: vi.fn(async () => {}),
  dispatchTestNotification: vi.fn(async () => ({ ok: true, status: 200 })),
}));

const { ingestVerdicts } = await import("./executor.js");
const { db, _resetDbForTest } = await import("../db/index.js");

/** po_briefs 에 행 직접 삽입 — 전이 테스트의 시드. 삽입한 id 반환. */
function seedBrief(overrides: {
  id?: string;
  repo_path?: string;
  status?: string;
  verify_note?: string | null;
} = {}): string {
  const id = overrides.id ?? `brief-${Math.random().toString(36).slice(2, 10)}`;
  db()
    .prepare(
      `INSERT INTO po_briefs (id, repo_path, title, problem, evidence, impact, effort, score, scope, spec, status, created_at, updated_at, verify_note)
       VALUES (@id, @repo_path, @title, @problem, @evidence, @impact, @effort, @score, @scope, @spec, @status, @created_at, @updated_at, @verify_note)`,
    )
    .run({
      id,
      repo_path: overrides.repo_path ?? H.repoA,
      title: "테스트 브리프",
      problem: "사용자가 X 를 못 한다",
      evidence: JSON.stringify([{ kind: "repo_todo", ref: "docs/todo.md", summary: "근거" }]),
      impact: 4,
      effort: 2,
      score: 2,
      scope: "X 만",
      spec: "## 스펙",
      status: overrides.status ?? "proposed",
      created_at: Date.now(),
      updated_at: Date.now(),
      verify_note: overrides.verify_note ?? null,
    });
  return id;
}

/** 브리프 한 행의 (status, verify_note) 조회. */
function row(id: string): { status: string; verify_note: string | null } {
  return db()
    .prepare(`SELECT status, verify_note FROM po_briefs WHERE id = ?`)
    .get(id) as { status: string; verify_note: string | null };
}

/** verdict 배열을 tmp JSON 파일로 써서 경로 반환. */
function writeVerdicts(value: unknown): string {
  const file = `${H.tmpDir}/verdicts-${Math.random().toString(36).slice(2, 8)}.json`;
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
  return file;
}

beforeAll(() => {
  fs.mkdirSync(H.tmpDir, { recursive: true });
});

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
    /* best effort */
  }
});

describe("ingestVerdicts — 출시 후 검증 전이 불변식", () => {
  it("shipped 만 전이: verified/missed 가 status='shipped' 행만 갱신하고 verify_note 를 채운다", () => {
    const ok = seedBrief({ status: "shipped" });
    const miss = seedBrief({ status: "shipped" });
    const file = writeVerdicts([
      { id: ok, verdict: "verified", note: "가설 적중" },
      { id: miss, verdict: "missed", note: "지표 변화 없음" },
    ]);

    const applied = ingestVerdicts(H.repoA, file);

    expect(applied).toBe(2);
    expect(row(ok)).toEqual({ status: "verified", verify_note: "가설 적중" });
    expect(row(miss)).toEqual({ status: "missed", verify_note: "지표 변화 없음" });
  });

  it("타 repo 무시: 같은 id 라도 repo_path 가 다르면 전이되지 않는다 (applied 미증가)", () => {
    const id = seedBrief({ repo_path: H.repoB, status: "shipped" });
    const file = writeVerdicts([{ id, verdict: "verified", note: "x" }]);

    // 판정은 repoA 컨텍스트로 ingest — 행은 repoB 라 매치 0.
    const applied = ingestVerdicts(H.repoA, file);

    expect(applied).toBe(0);
    expect(row(id)).toEqual({ status: "shipped", verify_note: null });
  });

  it("비-shipped 무시: rejected/running/approved/proposed/held 행은 절대 verified/missed 로 안 바뀐다", () => {
    const statuses = ["rejected", "running", "approved", "proposed", "held"];
    const ids = statuses.map((s) => seedBrief({ status: s }));
    const file = writeVerdicts(ids.map((id) => ({ id, verdict: "verified", note: "강제" })));

    const applied = ingestVerdicts(H.repoA, file);

    expect(applied).toBe(0);
    ids.forEach((id, i) => {
      expect(row(id)).toEqual({ status: statuses[i], verify_note: null });
    });
  });

  it("악성/오타 verdict 거부: 'verified'|'missed' 가 아니면 skip ('shipped','VERIFIED',빈문자열,null,누락,비문자열)", () => {
    const id = seedBrief({ status: "shipped" });
    const file = writeVerdicts([
      { id, verdict: "shipped", note: "상태값 오타" },
      { id, verdict: "VERIFIED", note: "대문자" },
      { id, verdict: "", note: "빈 문자열" },
      { id, verdict: null, note: "null" },
      { id, note: "verdict 누락" },
      { id, verdict: 123, note: "숫자" },
    ]);

    const applied = ingestVerdicts(H.repoA, file);

    expect(applied).toBe(0);
    expect(row(id)).toEqual({ status: "shipped", verify_note: null });
  });

  it("id 누락/비문자열 거부: id 가 없거나 빈 문자열이면 skip", () => {
    seedBrief({ status: "shipped" });
    const file = writeVerdicts([
      { verdict: "verified", note: "id 누락" },
      { id: "", verdict: "verified", note: "빈 id" },
      { id: 42, verdict: "verified", note: "숫자 id" },
    ]);

    expect(ingestVerdicts(H.repoA, file)).toBe(0);
  });

  it("파일 부재 → 0 반환, 예외 없이", () => {
    expect(ingestVerdicts(H.repoA, `${H.tmpDir}/does-not-exist.json`)).toBe(0);
  });

  it("깨진 JSON → 0 반환, 예외 없이", () => {
    const file = writeVerdicts("{ this is not json ]");
    expect(ingestVerdicts(H.repoA, file)).toBe(0);
  });

  it("비배열 JSON(객체/문자열/숫자/null) → 0 반환, 예외 없이", () => {
    for (const payload of ['{"id":"x","verdict":"verified"}', '"verified"', "123", "null"]) {
      const file = writeVerdicts(payload);
      expect(ingestVerdicts(H.repoA, file)).toBe(0);
    }
  });

  it("note 1000자 초과 시 잘려 저장 (str 헬퍼 계약)", () => {
    const id = seedBrief({ status: "shipped" });
    const longNote = "가".repeat(1500);
    const file = writeVerdicts([{ id, verdict: "verified", note: longNote }]);

    expect(ingestVerdicts(H.repoA, file)).toBe(1);
    const r = row(id);
    expect(r.status).toBe("verified");
    expect(r.verify_note).toBe("가".repeat(1000));
    expect(r.verify_note?.length).toBe(1000);
  });

  it("빈 note → NULL 저장", () => {
    const id = seedBrief({ status: "shipped" });
    const file = writeVerdicts([{ id, verdict: "verified", note: "" }]);

    expect(ingestVerdicts(H.repoA, file)).toBe(1);
    expect(row(id)).toEqual({ status: "verified", verify_note: null });
  });

  it("note 누락(shipped 인데 verify_note 없음) → 현행대로 NULL 저장, 전이 허용", () => {
    const id = seedBrief({ status: "shipped" });
    const file = writeVerdicts([{ id, verdict: "missed" }]);

    expect(ingestVerdicts(H.repoA, file)).toBe(1);
    expect(row(id)).toEqual({ status: "missed", verify_note: null });
  });

  it("반환값 applied 가 실제 changes 수와 일치 (전이된 행만 카운트)", () => {
    const shipped1 = seedBrief({ status: "shipped" });
    const shipped2 = seedBrief({ status: "shipped" });
    const rejected = seedBrief({ status: "rejected" });
    const file = writeVerdicts([
      { id: shipped1, verdict: "verified", note: "a" },
      { id: shipped2, verdict: "missed", note: "b" },
      { id: rejected, verdict: "verified", note: "무시됨" },
      { id: "ghost-id", verdict: "verified", note: "없는 행" },
    ]);

    // 4건 입력 중 실제 changes 는 2건 (shipped 2개)만.
    expect(ingestVerdicts(H.repoA, file)).toBe(2);
  });

  describe("엣지케이스", () => {
    it("같은 id 중복 등장: 첫 전이 후 두 번째는 이미 shipped 아니라 changes=0", () => {
      const id = seedBrief({ status: "shipped" });
      const file = writeVerdicts([
        { id, verdict: "verified", note: "첫 판정" },
        { id, verdict: "missed", note: "두 번째 판정" },
      ]);

      // 첫 항목이 shipped→verified 로 전이 → 두 번째는 WHERE status='shipped' 불일치 = 0.
      expect(ingestVerdicts(H.repoA, file)).toBe(1);
      expect(row(id)).toEqual({ status: "verified", verify_note: "첫 판정" });
    });

    it("대량 배열도 크래시 없이 처리 (전이된 행만 정확히 카운트)", () => {
      const shippedIds: string[] = [];
      for (let i = 0; i < 50; i++) shippedIds.push(seedBrief({ status: "shipped" }));
      // 매치 안 되는 잡음 4950건 + 진짜 50건.
      const verdicts: unknown[] = [];
      for (let i = 0; i < 4950; i++) {
        verdicts.push({ id: `noise-${i}`, verdict: "verified", note: "없는 행" });
      }
      for (const id of shippedIds) verdicts.push({ id, verdict: "verified", note: "ok" });
      const file = writeVerdicts(verdicts);

      expect(ingestVerdicts(H.repoA, file)).toBe(50);
    });
  });
});
