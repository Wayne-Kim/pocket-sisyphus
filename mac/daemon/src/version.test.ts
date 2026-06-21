/**
 * `version.ts` — daemon ↔ iOS 호환성 협상의 single source of truth 단위 테스트.
 *
 * 라우트 테스트들은 정상 헤더로 «통과 경로» 만 간접적으로 밟는다. 정작 옛 클라이언트를
 * 막는 «426 차단 / 우회 / 통과» 경계와 그 판정을 떠받치는 순수 semver 비교, 그리고
 * 클라이언트가 «자기가 너무 옛버전임을 학습» 하는 유일한 채널인 buildVersionResponse 의
 * 형태는 여기서 직접 고정한다 — 누군가
 *   - 426 경계를 off-by-one(`<` ↔ `<=`)으로 틀거나,
 *   - `/api/version` 우회(학습 채널)를 지우거나(옛 클라가 영구 차단),
 *   - semver 파싱을 `1.10.0 < 1.9.0` 같은 «문자열 비교» 버그로 회귀시키거나,
 *   - VersionResponse 에서 capabilities 를 복사 없이 원본 배열로 흘려보내면(호출부 mutate
 *     → DAEMON_CAPABILITIES 오염),
 * 이 파일이 즉시 실패한다. 직전 승인된 bearerAuth(auth.test.ts)와 «같은 종류의 요청 게이트».
 *
 * 검증 대상:
 *  - requireClientVersion 미들웨어(hono 테스트 클라이언트, 실호출): /api/version 우회,
 *    헤더 없음→통과, 경계(==min)→통과(`<` 이지 `<=` 아님), <min→426 client_too_old,
 *    >min→통과, 빈/공백 헤더 falsy 처리, 헤더 대소문자 정규화.
 *  - compareSemver(순수): 숫자 비교(1.9.0<1.10.0)·동일·길이상이·pre-release·깨진 입력 표.
 *  - buildVersionResponse: shape 고정 + capabilities 복사본(원본 불변) + lastUpdate
 *    additive(getUpdateStatus 모킹: 값 있으면 포함, null 이면 키 부재).
 *
 * version.ts 는 getUpdateStatus(→updateStatus.js) 를 import 하므로 vi.mock 으로 제어한다.
 * 동작 코드는 손대지 않는다 — compareSemver 에 export 키워드만 추가(런타임 동작 불변).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import type { UpdateStatus } from "./updateStatus.js";

// getUpdateStatus 가 돌려줄 값 홀더. 테스트가 H.updateStatus 를 갈아끼우면 mock 이 그걸 반환한다.
const H = vi.hoisted(() => ({
  updateStatus: null as UpdateStatus | null,
}));

vi.mock("./updateStatus.js", () => ({
  // version.ts 가 쓰는 단 하나의 심볼. 나머지(setUpdateStatus/clearUpdateStatus)는 미사용.
  getUpdateStatus: (): UpdateStatus | null => H.updateStatus,
}));

const {
  requireClientVersion,
  buildVersionResponse,
  compareSemver,
  DAEMON_VERSION,
  MIN_SUPPORTED_CLIENT_VERSION,
  DAEMON_CAPABILITIES,
} = await import("./version.js");

// ─────────────────────────────────────────────────────────────────────────────
// requireClientVersion — 426 게이트(우회 / 통과 / 차단)를 Hono 앱에 마운트해 실호출
// ─────────────────────────────────────────────────────────────────────────────

describe("requireClientVersion 미들웨어 — 우회 / 통과 / 426 차단", () => {
  let app: Hono;

  beforeEach(() => {
    // 미들웨어를 모든 경로에 걸고, full path 가 곧 c.req.path 가 되도록 라우트를 등록한다
    // (프로덕션과 동일하게 c.req.path === "/api/version" 분기를 그대로 밟는다).
    app = new Hono();
    app.use("*", requireClientVersion);
    app.get("/api/version", (c) => c.json({ ok: "version" }));
    app.get("/api/sessions", (c) => c.json({ ok: "sessions" }));
  });

  it("/api/version 은 X-Client-Version 없어도 통과(학습 채널 보존)", async () => {
    const res = await app.request("/api/version");
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: string }).toEqual({ ok: "version" });
  });

  it("/api/version 은 아주 낮은 버전이라도 항상 통과(차단 금지 — 학습 채널)", async () => {
    // 옛 클라이언트가 «자기가 너무 옛버전임을» 배울 유일한 채널이므로 426 으로 막으면 안 된다.
    const res = await app.request("/api/version", {
      headers: { "x-client-version": "0.0.1" },
    });
    expect(res.status).toBe(200);
  });

  it("다른 /api/* 에서 헤더 미전송 → 통과(현 정책: enforce 안 함)", async () => {
    const res = await app.request("/api/sessions");
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: string }).toEqual({ ok: "sessions" });
  });

  it("헤더 == MIN_SUPPORTED_CLIENT_VERSION(경계) → 통과 (`<` 이지 `<=` 아님)", async () => {
    // 이 한 케이스가 off-by-one(`<` ↔ `<=`) 회귀를 잡는다: 정확히 min 인 클라는 통과해야 한다.
    const res = await app.request("/api/sessions", {
      headers: { "x-client-version": MIN_SUPPORTED_CLIENT_VERSION },
    });
    expect(res.status).toBe(200);
  });

  it("헤더 < min → 426 + 구조화 body {client_too_old, min, client}", async () => {
    const clientVersion = "0.1.0"; // 0.1.0 < 0.2.0
    const res = await app.request("/api/sessions", {
      headers: { "x-client-version": clientVersion },
    });
    expect(res.status).toBe(426);
    expect(await res.json()).toEqual({
      error: "client_too_old",
      minSupportedClientVersion: MIN_SUPPORTED_CLIENT_VERSION,
      clientVersion,
    });
  });

  it("헤더 < min(같은 major·minor 차이, 0.1.9) → 426", async () => {
    const res = await app.request("/api/sessions", {
      headers: { "x-client-version": "0.1.9" },
    });
    expect(res.status).toBe(426);
  });

  it("헤더 > min(0.2.1 / 1.0.0) → 통과", async () => {
    for (const v of ["0.2.1", "0.3.0", "1.0.0", "10.0.0"]) {
      const res = await app.request("/api/sessions", {
        headers: { "x-client-version": v },
      });
      expect(res.status, `client ${v}`).toBe(200);
    }
  });

  it("/api/version 차단 우회는 426 이 되는 버전이라도 유효 — 같은 낮은 버전이 /api/* 에선 426", async () => {
    // 동일한 «너무 낮은» 버전이 경로에 따라 갈린다: version 은 통과, 그 외는 426.
    const headers = { "x-client-version": "0.1.0" };
    expect((await app.request("/api/version", { headers })).status).toBe(200);
    expect((await app.request("/api/sessions", { headers })).status).toBe(426);
  });

  it("헤더 대소문자(X-Client-Version vs x-client-version) — hono 가 소문자 정규화하여 둘 다 잡힌다", async () => {
    // HTTP 헤더는 대소문자 무관 + hono 가 소문자 키로 조회 → 두 표기 모두 동일하게 426.
    const upper = await app.request("/api/sessions", {
      headers: { "X-Client-Version": "0.1.0" },
    });
    const lower = await app.request("/api/sessions", {
      headers: { "x-client-version": "0.1.0" },
    });
    expect(upper.status).toBe(426);
    expect(lower.status).toBe(426);
  });

  it("빈 문자열/전부-공백 헤더 → falsy(혹은 trim 후 빈) 로 «미전송» 취급 → 통과", async () => {
    // 현 코드: `if (!headerVersion) return next()`. 빈 문자열은 falsy 라 통과한다.
    // 전부-공백 값은 WHATWG fetch 가 헤더 값 양끝 공백을 trim → "" 로 정규화되어 동일하게 통과.
    // (auth.test.ts 의 "Bearer    " → "Bearer" 정규화와 같은 메커니즘.)
    for (const v of ["", "   "]) {
      const res = await app.request("/api/sessions", {
        headers: { "x-client-version": v },
      });
      expect(res.status, `value=${JSON.stringify(v)}`).toBe(200);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// compareSemver — 숫자 단위 비교 / 경계 / 깨진 입력 (표)
// ─────────────────────────────────────────────────────────────────────────────

describe("compareSemver — 숫자 비교·경계·pre-release·깨진 입력 (표)", () => {
  // [a, b, 기대 sign(-1/0/1), 설명]
  const cases: Array<[string, string, number, string]> = [
    ["1.9.0", "1.10.0", -1, "숫자 비교 — 문자열 비교였다면 '9' > '1' 로 부호가 뒤집혀 실패"],
    ["1.10.0", "1.9.0", 1, "역방향도 숫자로"],
    ["1.2.3", "1.2.3", 0, "완전 동일 → 0"],
    ["0.2.0", "0.2.0", 0, "min 경계 자기 자신 → 0 (게이트가 `<` 로 통과시키는 근거)"],
    ["1.2", "1.2.0", 0, "길이 다름 — 빠진 파트는 0 으로 채워 동일 취급"],
    ["1.2.0", "1.2", 0, "길이 다름 (대칭)"],
    ["1.2.0-beta.3", "1.2.0", 0, "pre-release 태그 절단 — 코어만 비교 → 0"],
    ["1.2.0-beta.3", "1.2.0-rc.1", 0, "pre-release 끼리도 코어만 → 0 (태그 구분 안 함)"],
    ["1.x.0", "1.0.0", 0, "깨진 파트 'x' → parseInt||0 = 0 → [1,0,0] 동일"],
    ["1.x.0", "1.2.0", -1, "깨진 파트 'x'(=0) < 2 → -1 (broken 은 0 취급임을 고정)"],
    ["", "", 0, "빈 문자열 → [0] vs [0] → 0 (throw 없음)"],
    ["2.0.0", "1.99.99", 1, "major 우선 — 하위 파트가 커도 major 가 이긴다"],
  ];

  it.each(cases)("compareSemver(%j, %j) → sign %d  // %s", (a, b, expected) => {
    expect(Math.sign(compareSemver(a, b))).toBe(expected);
  });

  it("반대칭성: sign(compare(a,b)) === -sign(compare(b,a))", () => {
    const pairs: Array<[string, string]> = [
      ["1.9.0", "1.10.0"],
      ["2.0.0", "1.99.99"],
      ["1.x.0", "1.2.0"],
    ];
    for (const [a, b] of pairs) {
      expect(Math.sign(compareSemver(a, b))).toBe(-Math.sign(compareSemver(b, a)));
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildVersionResponse — shape 고정 + capabilities 복사본 + lastUpdate additive
// ─────────────────────────────────────────────────────────────────────────────

describe("buildVersionResponse — 형태 / capabilities 불변 / lastUpdate additive", () => {
  beforeEach(() => {
    H.updateStatus = null; // 기본: 사일런트 업데이트 잔존 결과 없음
  });

  it("daemonVersion·minSupportedClientVersion·capabilities 를 상수와 일치시켜 담는다", () => {
    const r = buildVersionResponse();
    expect(r.daemonVersion).toBe(DAEMON_VERSION);
    expect(r.minSupportedClientVersion).toBe(MIN_SUPPORTED_CLIENT_VERSION);
    expect(r.capabilities).toEqual([...DAEMON_CAPABILITIES]);
  });

  it("capabilities 는 DAEMON_CAPABILITIES 의 복사본 — 호출부가 mutate 해도 원본 불변", () => {
    const before = [...DAEMON_CAPABILITIES]; // 원본 스냅샷
    const r = buildVersionResponse();

    // 반환 배열은 원본과 «다른 참조» 여야 한다(스프레드 복사).
    expect(r.capabilities).not.toBe(DAEMON_CAPABILITIES as unknown as string[]);

    // 반환 배열을 오염시켜도…
    r.capabilities.push("__mutation_probe__");

    // …DAEMON_CAPABILITIES 원본은 그대로고,
    expect([...DAEMON_CAPABILITIES]).toEqual(before);
    expect(DAEMON_CAPABILITIES).not.toContain("__mutation_probe__");

    // …다음 호출도 오염되지 않은 깨끗한 복사본을 돌려준다.
    const r2 = buildVersionResponse();
    expect(r2.capabilities).not.toContain("__mutation_probe__");
    expect(r2.capabilities).toEqual(before);
  });

  it("getUpdateStatus 가 null → lastUpdate 키 자체가 없다(additive 안전)", () => {
    H.updateStatus = null;
    const r = buildVersionResponse();
    expect("lastUpdate" in r).toBe(false);
    expect(r.lastUpdate).toBeUndefined();
  });

  it("getUpdateStatus 가 값 반환 → lastUpdate 에 그대로 포함", () => {
    const status: UpdateStatus = { state: "no_update", at: 1_700_000_000_000 };
    H.updateStatus = status;
    const r = buildVersionResponse();
    expect("lastUpdate" in r).toBe(true);
    expect(r.lastUpdate).toEqual(status);
  });

  it("getUpdateStatus 가 error 상태(message 포함) → lastUpdate 에 메시지까지 보존", () => {
    const status: UpdateStatus = {
      state: "error",
      message: "이미 최신 버전입니다",
      at: 1_700_000_000_001,
    };
    H.updateStatus = status;
    const r = buildVersionResponse();
    expect(r.lastUpdate).toEqual(status);
  });
});
