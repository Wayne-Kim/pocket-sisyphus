/**
 * `po/executor` 의 ingestBriefs / parseBriefDraft 계약 테스트 — host-less (HTTP/PTY 없이 함수 직접 호출).
 *
 * 왜 이 테스트가 있나: 사람이 결재하는 PO 백로그와 dedup 코퍼스의 신뢰는 «에이전트가 산출한
 * 신뢰 못 할 JSON 이 어떤 형태로 와도 백로그를 오염시키지 못한다»는 불변식에 달려 있다. 그 불변식은
 * parseBriefDraft 의 검증(필수필드/clamp/길이 cap)과 ingestBriefs 의 게이트(MAX_BRIEFS_PER_RUN 상한 +
 * 하이브리드 dedup)로만 지켜진다. 형제 경로인 ingestVerdicts 는 8케이스로 잠겨 있지만 이 경로는
 * 테스트가 0건이었다 — 향후 리팩터가 clamp/상한/필수필드/ dedup 게이트 중 하나라도 떨어뜨리면
 * 근거 없는·범람하는·재제안 브리프가 조용히 INSERT 돼도 아무도 모른다. 이 회귀 테스트가 그 계약을 못박는다.
 *
 * 격리: executor.test.ts(ingestVerdicts) 와 동일 — config 를 mock 해 tmp DB 로, pty-runner/notify 를
 * mock 해 실제 PTY spawn·Discord POST 를 차단한다. ingestBriefs/parseBriefDraft 만 직접 호출하고
 * INSERT 는 임시 디렉터리 DB 에서만 일어난다(실 DB 미접근).
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
  const dir = fsH.mkdtempSync(pathH.join(osH.tmpdir(), "ps-po-brief-test-"));
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

const { ingestBriefs, parseBriefDraft } = await import("./executor.js");
const { db, _resetDbForTest } = await import("../db/index.js");

type EvidenceItem = { kind?: unknown; ref?: unknown; summary?: unknown };

/** 수용 가능한 «정상» 브리프 산출 객체 한 건 — 테스트에서 필드만 덮어쓴다. */
function makeBrief(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "라벨 추가 기능",
    problem: "사용자가 항목을 분류할 방법이 없다",
    evidence: [{ kind: "repo_todo", ref: "docs/todo.md", summary: "라벨 요청 누적" }],
    impact: 4,
    effort: 2,
    scope: "라벨 CRUD 만",
    spec: "## 스펙\n라벨을 붙인다",
    ...overrides,
  };
}

/** 브리프 배열을 tmp JSON 파일로 써서 경로 반환. 문자열이면 raw 로 기록(깨진 JSON 케이스). */
function writeBriefs(value: unknown): string {
  const file = `${H.tmpDir}/briefs-${Math.random().toString(36).slice(2, 8)}.json`;
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
  return file;
}

/** po_briefs 에 dedup 코퍼스 시드 직접 삽입 — lexical 백스톱/상태 제외/ref 겹침 검증용. */
function seedBrief(o: {
  repo_path?: string;
  title: string;
  problem: string;
  status?: string;
  /** evidence ref (선택) — ref-겹침 신호 검증용. 생략 시 인식 불가 ref("r")로 트라이그램 경로만 검증. */
  ref?: string;
}): void {
  db()
    .prepare(
      `INSERT INTO po_briefs (id, repo_path, title, problem, evidence, impact, effort, score, scope, spec, status, created_at, updated_at)
       VALUES (@id, @repo_path, @title, @problem, @evidence, 3, 3, 1, '—', '## s', @status, @t, @t)`,
    )
    .run({
      id: `seed-${Math.random().toString(36).slice(2, 10)}`,
      repo_path: o.repo_path ?? H.repoA,
      title: o.title,
      problem: o.problem,
      evidence: JSON.stringify([{ kind: "x", ref: o.ref ?? "r", summary: "s" }]),
      status: o.status ?? "proposed",
      t: Date.now(),
    });
}

/** id 로 삽입된 브리프 한 행 조회. */
function row(id: string): Record<string, unknown> {
  return db().prepare(`SELECT * FROM po_briefs WHERE id = ?`).get(id) as Record<string, unknown>;
}

/** 현재 repoA 의 브리프 행 수(시드 제외하려면 status='proposed' 등으로 거름). */
function countBriefs(repoPath = H.repoA): number {
  return (
    db().prepare(`SELECT COUNT(*) AS n FROM po_briefs WHERE repo_path = ?`).get(repoPath) as {
      n: number;
    }
  ).n;
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

describe("parseBriefDraft — 신뢰 못 할 산출 검증 불변식", () => {
  it("필수필드 누락(title/problem/spec 빈/누락, evidence 빈 배열)은 null 을 반환한다", () => {
    expect(parseBriefDraft(makeBrief({ title: "" }))).toBeNull();
    expect(parseBriefDraft(makeBrief({ title: "   " }))).toBeNull(); // trim 후 빈
    expect(parseBriefDraft(makeBrief({ problem: "" }))).toBeNull();
    expect(parseBriefDraft(makeBrief({ spec: "" }))).toBeNull();
    expect(parseBriefDraft(makeBrief({ evidence: [] }))).toBeNull();
    expect(parseBriefDraft(makeBrief({ title: undefined }))).toBeNull();
    expect(parseBriefDraft(makeBrief({ evidence: undefined }))).toBeNull();
    // 비배열 evidence 도 근거 0건 취급 → null.
    expect(parseBriefDraft(makeBrief({ evidence: "근거 텍스트" }))).toBeNull();
    expect(parseBriefDraft(makeBrief({ evidence: { ref: "x" } }))).toBeNull();
  });

  it("정상 브리프는 검증된 필드 객체를 반환(evidence 는 정규화된 JSON 문자열)", () => {
    const d = parseBriefDraft(makeBrief())!;
    expect(d).not.toBeNull();
    expect(d.title).toBe("라벨 추가 기능");
    expect(d.problem).toBe("사용자가 항목을 분류할 방법이 없다");
    expect(JSON.parse(d.evidence)).toEqual([
      { kind: "repo_todo", ref: "docs/todo.md", summary: "라벨 요청 누적" },
    ]);
  });

  it("impact/effort 가 범위 밖·비숫자면 1~5 로 clamp, 비숫자는 3; score=round(impact/effort,2)", () => {
    const cases: Array<[unknown, number]> = [
      [0, 1],
      [6, 5],
      [-3, 1],
      [5, 5],
      [1, 1],
      [3.4, 3], // 반올림 후 clamp
      ["x", 3],
      [null, 3],
      [undefined, 3],
      [NaN, 3],
    ];
    for (const [input, expected] of cases) {
      const d = parseBriefDraft(makeBrief({ impact: input, effort: 2 }))!;
      expect(d.impact, `impact=${String(input)}`).toBe(expected);
      const e = parseBriefDraft(makeBrief({ impact: 2, effort: input }))!;
      expect(e.effort, `effort=${String(input)}`).toBe(expected);
    }
    // score = round(impact/effort, 2): 누락된 impact·effort 둘 다 3 → 1.0.
    const both = parseBriefDraft(makeBrief({ impact: undefined, effort: undefined }))!;
    expect(both.impact).toBe(3);
    expect(both.effort).toBe(3);
    expect(both.score).toBe(1);
    // 4/3 = 1.333… → 1.33.
    const frac = parseBriefDraft(makeBrief({ impact: 4, effort: 3 }))!;
    expect(frac.score).toBe(1.33);
  });

  it("문자열 필드는 trim + 길이 cap; 비문자열은 throw 없이 안전 처리(scope 비문자열→'—')", () => {
    const d = parseBriefDraft(
      makeBrief({
        title: "  앞뒤 공백  ",
        scope: 12345, // 비문자열 → "" → "—"
        problem: "정상 문제",
        spec: "정상 스펙",
      }),
    )!;
    expect(d.title).toBe("앞뒤 공백");
    expect(d.scope).toBe("—");

    // 길이 cap: title 200, problem 4000, spec 16000.
    const long = parseBriefDraft(
      makeBrief({
        title: "가".repeat(500),
        problem: "나".repeat(5000),
        spec: "다".repeat(20000),
      }),
    )!;
    expect(long.title.length).toBe(200);
    expect(long.problem.length).toBe(4000);
    expect(long.spec.length).toBe(16000);
  });

  it("evidence 원소: ref·summary 둘 다 비면 그 근거 제외, 결과 0건이면 브리프 null", () => {
    // 한 원소는 유효, 둘은 빈 ref/summary → 유효 1건만 남음.
    const d = parseBriefDraft(
      makeBrief({
        evidence: [
          { kind: "a", ref: "", summary: "" }, // 제외
          { kind: "b", ref: "docs/x.md", summary: "" }, // 포함 (ref 있음)
          { kind: "", ref: "", summary: "요약만" }, // 포함 (summary 있음), kind→unknown
          "문자열원소", // 객체 아님 → 제외
        ] as EvidenceItem[],
      }),
    )!;
    const ev = JSON.parse(d.evidence) as Array<{ kind: string }>;
    expect(ev.length).toBe(2);
    expect(ev[1].kind).toBe("unknown");

    // 모든 근거가 비면 → null.
    expect(
      parseBriefDraft(
        makeBrief({ evidence: [{ kind: "a", ref: "", summary: "" }] as EvidenceItem[] }),
      ),
    ).toBeNull();
  });

  it("dedupRelation 은 'new'|'refinement'|'duplicate' 만 인정, 그 외/누락은 undefined", () => {
    expect(parseBriefDraft(makeBrief({ dedup: { relation: "duplicate" } }))!.dedupRelation).toBe(
      "duplicate",
    );
    expect(parseBriefDraft(makeBrief({ dedup: { relation: "new" } }))!.dedupRelation).toBe("new");
    expect(parseBriefDraft(makeBrief({ dedup: { relation: "xxx" } }))!.dedupRelation).toBeUndefined();
    expect(parseBriefDraft(makeBrief())!.dedupRelation).toBeUndefined();
  });

  it("객체가 아닌 입력(문자열/숫자/빈배열/불리언)은 throw 없이 null — 필수필드 부재로 컷", () => {
    // 산출 배열의 «원소» 로 흔히 섞여올 수 있는 비-브리프 값. 필드 접근이 undefined 라 안전히 null.
    for (const v of ["문자열", 42, [], true]) {
      expect(parseBriefDraft(v)).toBeNull();
    }
  });
});

describe("ingestBriefs — 백로그 INSERT 게이트 불변식", () => {
  it("정상 배열은 검증된 브리프를 proposed 로 INSERT (provenance 채움)", () => {
    const file = writeBriefs([makeBrief()]);
    const ids = ingestBriefs("sess-1", H.repoA, file, "research-9");
    expect(ids.length).toBe(1);
    const r = row(ids[0]);
    expect(r.status).toBe("proposed");
    expect(r.repo_path).toBe(H.repoA);
    expect(r.collect_session_id).toBe("sess-1");
    expect(r.research_id).toBe("research-9");
    expect(r.impact).toBe(4);
    expect(r.effort).toBe(2);
    expect(r.score).toBe(2);
  });

  it("가독성 신호(빽빽한 제목·코드 시작)는 «소프트» — 브리프를 버리지 않고 그대로 INSERT 한다", () => {
    // 제목이 80자 초과 + 파일경로 + «—» 다중 절 (R1/R2/R3), problem 이 코드로 시작 (R4) 인 «빽빽한»
    // 브리프 — readability 가 로깅/표면화만 하고 차단/감점하지 않음을 못박는다(스코프: 하드 reject 금지).
    const dense = makeBrief({
      title:
        "lifecycle.ts 세션 정착 — settle 대기 — running 전이가 다시 빽빽해진 가독성 회귀 표본 제목이며 충분히 길게 이어집니다",
      problem: "`watchExecForShipped` 가 정착 판정을 길이로만 본다",
    });
    const ids = ingestBriefs("s", H.repoA, writeBriefs([dense]));
    expect(ids.length).toBe(1); // 신호가 있어도 버리지 않는다(소프트).
    expect(row(ids[0]).status).toBe("proposed");
  });

  it("기존 길이 cap 동작 보존: 200자 초과 제목은 (가독성과 무관하게) 200 으로 잘려 INSERT 된다", () => {
    const long = makeBrief({ title: "가".repeat(500) });
    const ids = ingestBriefs("s", H.repoA, writeBriefs([long]));
    expect(ids.length).toBe(1);
    expect((row(ids[0]).title as string).length).toBe(200);
  });

  it("필수필드 미달 원소는 건너뛰고 INSERT 되지 않는다", () => {
    const file = writeBriefs([
      makeBrief(), // 유효
      makeBrief({ title: "", problem: "근거 없는 상상" }), // title 빈 → 컷
      makeBrief({ evidence: [] }), // 근거 0 → 컷
    ]);
    const ids = ingestBriefs("s", H.repoA, file);
    expect(ids.length).toBe(1);
    expect(countBriefs()).toBe(1);
  });

  it("배열에 9건 이상 와도 MAX_BRIEFS_PER_RUN(8)건만 처리된다", () => {
    // 서로 dedup 에 안 걸리게 충분히 다른 9건.
    const distinct = [
      { title: "다크모드 대비", problem: "야간에 화면이 너무 밝아 눈이 부시다" },
      { title: "오프라인 동기화", problem: "지하철에서 연결이 끊기면 작업이 사라진다" },
      { title: "전체 검색 속도", problem: "항목이 많으면 찾는 데 한참 걸린다" },
      { title: "알림 묶음", problem: "푸시가 쏟아져 중요한 걸 놓친다" },
      { title: "키보드 단축키", problem: "마우스 없이 빠르게 이동하고 싶다" },
      { title: "내보내기 포맷", problem: "결과를 표 파일로 받아 분석하고 싶다" },
      { title: "온보딩 축약", problem: "처음 켰을 때 단계가 많아 도중에 나간다" },
      { title: "위젯 크기 옵션", problem: "홈 화면 위젯이 작아 정보가 안 보인다" },
      { title: "브랜드 색 지정", problem: "테마 색을 직접 고르고 싶다" },
    ];
    const file = writeBriefs(distinct.map((d) => makeBrief(d)));
    const ids = ingestBriefs("s", H.repoA, file);
    expect(ids.length).toBe(8);
    expect(countBriefs()).toBe(8);
  });

  it("dedup ①: dedupRelation='duplicate' 원소는 컷된다", () => {
    const file = writeBriefs([
      makeBrief({ dedup: { relation: "duplicate" } }),
      makeBrief({ title: "전혀 다른 기회", problem: "관련 없는 문제 정의", dedup: { relation: "new" } }),
    ]);
    const ids = ingestBriefs("s", H.repoA, file);
    expect(ids.length).toBe(1);
    expect(row(ids[0]).title).toBe("전혀 다른 기회");
  });

  it("dedup ②: 코퍼스의 거의 동일 텍스트는 lexical 백스톱으로 컷 (자가분류 'new' 여도)", () => {
    seedBrief({ title: "라벨 추가 기능", problem: "사용자가 항목을 분류할 방법이 없다", status: "proposed" });
    const file = writeBriefs([makeBrief({ dedup: { relation: "new" } })]); // 시드와 동일 텍스트
    const ids = ingestBriefs("s", H.repoA, file);
    expect(ids.length).toBe(0);
  });

  it("dedup ③: 배치-내 거의 동일 텍스트도 누적 코퍼스로 컷 (둘째가 컷)", () => {
    const file = writeBriefs([
      makeBrief(),
      makeBrief(), // 동일 텍스트 → 둘째 컷
    ]);
    const ids = ingestBriefs("s", H.repoA, file);
    expect(ids.length).toBe(1);
  });

  it("dedup ④: missed 상태 브리프는 백스톱 코퍼스에서 제외 → 같은 텍스트가 컷되지 않는다", () => {
    seedBrief({ title: "라벨 추가 기능", problem: "사용자가 항목을 분류할 방법이 없다", status: "missed" });
    const file = writeBriefs([makeBrief({ dedup: { relation: "new" } })]);
    const ids = ingestBriefs("s", H.repoA, file);
    // missed 는 «미해결 갭/재시도 후보» 라 코퍼스에서 빠짐 → 새 제안이 컷되지 않는다.
    expect(ids.length).toBe(1);
  });

  it("repo 격리: 다른 repo 의 동일 텍스트 브리프는 코퍼스에 안 들어와 컷되지 않는다", () => {
    seedBrief({
      repo_path: H.repoB,
      title: "라벨 추가 기능",
      problem: "사용자가 항목을 분류할 방법이 없다",
      status: "proposed",
    });
    const file = writeBriefs([makeBrief()]);
    const ids = ingestBriefs("s", H.repoA, file);
    expect(ids.length).toBe(1);
  });

  it("dedup ⑤: 같은 evidence ref·다른 제목 = ref 겹침으로 컷 (트라이그램 미달이어도)", () => {
    // 제목·문제는 전혀 다르지만 같은 파일:라인을 가리키는 의미-중복 — 옛 백스톱은 못 잡던 누수.
    seedBrief({
      title: "다크 모드 지원",
      problem: "야간에 화면이 너무 밝다",
      status: "proposed",
      ref: "ui/Theme.ts:42",
    });
    const file = writeBriefs([
      makeBrief({
        title: "어두운 테마 옵션",
        problem: "밤에 눈이 부셔서 쓰기 힘들다",
        // 디자인 렌즈 kind(design_token_drift)도 ref=파일:라인이라 동일 적용 — 인접 라인(42↔43)도 컷.
        evidence: [{ kind: "design_token_drift", ref: "ui/Theme.ts:43", summary: "토큰 드리프트" }],
        dedup: { relation: "new" },
      }),
    ]);
    const ids = ingestBriefs("s", H.repoA, file);
    expect(ids.length).toBe(0);
  });

  it("dedup ⑥: 다른 ref·비슷한 제목 = 트라이그램 경로 유지 (OR — 회귀 0)", () => {
    // ref 가 다른 파일이어도 제목/문제가 닮으면 트라이그램이 컷한다(ref 차이가 트라이그램을 억누르지 않음).
    seedBrief({
      title: "라벨 추가 기능",
      problem: "사용자가 항목을 분류할 방법이 없다",
      status: "proposed",
      ref: "a/x.ts:10",
    });
    const file = writeBriefs([
      makeBrief({
        evidence: [{ kind: "repo_todo", ref: "b/y.ts:999", summary: "다른 위치" }],
        dedup: { relation: "new" },
      }),
    ]);
    const ids = ingestBriefs("s", H.repoA, file);
    expect(ids.length).toBe(0);
  });

  it("dedup ⑦: 다른 제목·인식 불가 ref = 통과 (폴백, 회귀 0)", () => {
    // 제목 안 닮고 draft ref 가 라인 없는 맨 경로(인식 불가) → ref 신호 없음 → 트라이그램 폴백 → 통과.
    seedBrief({
      title: "다크 모드 지원",
      problem: "야간에 화면이 너무 밝다",
      status: "proposed",
      ref: "ui/Theme.ts:42",
    });
    const file = writeBriefs([
      makeBrief({
        title: "오프라인 동기화",
        problem: "지하철에서 연결이 끊기면 작업이 사라진다",
        evidence: [{ kind: "repo_todo", ref: "docs/todo.md", summary: "동기화 요청" }],
        dedup: { relation: "new" },
      }),
    ]);
    const ids = ingestBriefs("s", H.repoA, file);
    expect(ids.length).toBe(1);
  });

  it("dedup ⑧: 배치-내 같은 ref·다른 제목도 누적 코퍼스로 컷 (둘째가 ref 로 컷)", () => {
    const file = writeBriefs([
      makeBrief({
        title: "첫 브리프 제목",
        problem: "첫 문제 정의 서술",
        evidence: [{ kind: "code_comment", ref: "src/a.ts:120", summary: "근거1" }],
      }),
      makeBrief({
        title: "둘째 — 전혀 다른 제목",
        problem: "둘째 — 전혀 다른 문제 서술",
        evidence: [{ kind: "code_comment", ref: "src/a.ts:121", summary: "근거2" }], // 같은 파일 인접 라인
      }),
    ]);
    const ids = ingestBriefs("s", H.repoA, file);
    expect(ids.length).toBe(1);
    expect(row(ids[0]).title).toBe("첫 브리프 제목");
  });

  describe("dedup ⑨ — 닫힌 결정 지문 백스톱 (po_dedup_fingerprint_v1, 윈도우 밖)", () => {
    // dedup ②~⑧ 은 «윈도우 안» 코퍼스(dedupCorpus LIMIT 60)를 검증한다. 이 블록은 그 윈도우 «밖» 으로
    // 밀려난 옛 닫힌 결정을 지문 백스톱이 잡는지 — 이 기능의 고유 가치를 못박는다. 60건의 살아있는
    // 제안으로 윈도우를 가득 채워 닫힌 결정을 코퍼스 밖(행 61)으로 밀어낸 뒤 ingest 한다.
    function fillWindow(): void {
      for (let i = 0; i < 60; i++) {
        seedBrief({
          title: `윈도우 채움 제안 ${i}`,
          problem: `이건 단지 코퍼스 윈도우를 채우는 항목 번호 ${i} 일 뿐이고 테스트 브리프와 안 닮았다`,
          status: "proposed",
        });
      }
    }

    it("윈도우 밖으로 밀려난 옛 기각도 지문 lexical 로 재제안 컷", () => {
      fillWindow();
      seedBrief({
        title: "라벨 추가 기능",
        problem: "사용자가 항목을 분류할 방법이 없다",
        status: "rejected",
      });
      // makeBrief 는 기각된 것과 동일 텍스트지만, 그 기각은 윈도우 밖이라 ② 윈도우 백스톱으론 안 잡힌다.
      const ids = ingestBriefs("s", H.repoA, writeBriefs([makeBrief({ dedup: { relation: "new" } })]));
      expect(ids.length).toBe(0);
    });

    it("윈도우 밖 옛 기각도 evidence ref 겹침으로 컷 (제목 미달이어도)", () => {
      fillWindow();
      seedBrief({
        title: "다크 모드 지원",
        problem: "야간에 화면이 너무 밝다",
        status: "rejected",
        ref: "ui/Theme.ts:42",
      });
      // 제목·문제는 전혀 다르지만 같은 파일:라인을 가리킨다 — 윈도우 밖이라 지문 백스톱만 잡을 수 있다.
      const para = makeBrief({
        title: "어두운 테마 옵션",
        problem: "밤에 눈이 부셔서 쓰기 힘들다",
        evidence: [{ kind: "design_token_drift", ref: "ui/Theme.ts:42", summary: "토큰 드리프트" }],
        dedup: { relation: "new" },
      });
      const ids = ingestBriefs("s", H.repoA, writeBriefs([para]));
      expect(ids.length).toBe(0);
    });

    it("missed 지문은 백스톱 조회에서 제외 — 같은 ref·다른 제목이어도 컷되지 않는다", () => {
      // 지문 표는 missed 도 보존하되 조회에서 뺀다 (윈도우 코퍼스의 missed 제외 정책과 동형).
      seedBrief({
        title: "다크 모드 지원",
        problem: "야간에 화면이 너무 밝다",
        status: "missed",
        ref: "ui/Theme.ts:42",
      });
      const para = makeBrief({
        title: "어두운 테마 재시도",
        problem: "밤에 눈이 부셔서 쓰기 힘들다",
        evidence: [{ kind: "design_token_drift", ref: "ui/Theme.ts:42", summary: "토큰 드리프트" }],
        dedup: { relation: "new" },
      });
      const ids = ingestBriefs("s", H.repoA, writeBriefs([para]));
      expect(ids.length).toBe(1);
    });

    it("repo 격리: 다른 repo 의 닫힌 결정 지문은 조회되지 않아 컷되지 않는다", () => {
      seedBrief({
        repo_path: H.repoB,
        title: "라벨 추가 기능",
        problem: "사용자가 항목을 분류할 방법이 없다",
        status: "rejected",
        ref: "ui/Theme.ts:42",
      });
      const ids = ingestBriefs("s", H.repoA, writeBriefs([makeBrief()]));
      expect(ids.length).toBe(1);
    });
  });

  describe("불량 입력 — [] 반환, 예외 없음", () => {
    it("파일 부재", () => {
      expect(ingestBriefs("s", H.repoA, `${H.tmpDir}/nope-${Math.random()}.json`)).toEqual([]);
    });

    it("깨진 JSON", () => {
      expect(ingestBriefs("s", H.repoA, writeBriefs("{ not json ]"))).toEqual([]);
      expect(countBriefs()).toBe(0);
    });

    it("비배열 JSON (객체/문자열/숫자/null)", () => {
      for (const payload of ['{"title":"x"}', '"라벨"', "123", "null"]) {
        expect(ingestBriefs("s", H.repoA, writeBriefs(payload))).toEqual([]);
      }
      expect(countBriefs()).toBe(0);
    });

    it("빈 배열", () => {
      expect(ingestBriefs("s", H.repoA, writeBriefs([]))).toEqual([]);
    });

    it("불량 원소만 든 배열 (모두 컷) → [] / DB 무변", () => {
      const file = writeBriefs(["문자열", 42, { title: "" }, { evidence: [] }]);
      expect(ingestBriefs("s", H.repoA, file)).toEqual([]);
      expect(countBriefs()).toBe(0);
    });
  });
});
