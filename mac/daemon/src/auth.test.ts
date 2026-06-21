/**
 * `auth.ts` — 폰→데몬 모든 요청의 «1차 인증 게이트» 단위 테스트.
 *
 * 라우트 테스트들은 `Authorization: Bearer` 를 실어 «성공 경로» 만 간접적으로 밟는다.
 * 정작 보안을 보장하는 «거부 경로» 와 순수 헬퍼는 여기서 직접 고정한다 — 누군가
 * `timingSafeEqualStr` 를 `===` 로 바꾸거나 길이검사 단락을 지우면 이 파일이 즉시 실패한다.
 *
 * 검증 대상:
 *  - 순수 헬퍼: hashToken(결정성/길이), generateToken(base64url 길이·유일성),
 *    timingSafeEqualStr(길이불일치 즉시 false 단락 / 동일·상이값).
 *  - bearerAuth 미들웨어(hono 테스트 클라이언트): 헤더 없음→401, 접두 없음→401,
 *    cfg 미초기화→503, 틀린 토큰→401, 올바른 토큰→핸들러 도달(200).
 *  - verifyWsToken(null·빈문자·틀린·올바른·cfg 미초기화).
 *  - getCachedConfig/invalidateAuthCache(캐시 후 재읽기, fail-closed).
 *
 * auth.ts 는 readConfig(→config.js) 를 거치므로 in-memory config 로 mock 한다
 * (attest.test.ts 와 동일 패턴). 동작 코드는 손대지 않는다 — 테스트만 추가.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import crypto from "node:crypto";
import { Hono } from "hono";
import type { DaemonConfig } from "./config.js";

// 메모리 config 홀더 + readConfig 호출 횟수(캐시 재읽기 검증용).
const H = vi.hoisted(() => ({
  cfg: null as DaemonConfig | null,
  readCount: 0,
}));

vi.mock("./config.js", () => ({
  readConfig: () => {
    H.readCount++;
    return H.cfg;
  },
}));

const {
  hashToken,
  generateToken,
  timingSafeEqualStr,
  bearerAuth,
  verifyWsToken,
  getCachedConfig,
  invalidateAuthCache,
} = await import("./auth.js");

/** config 를 세팅하고 캐시를 무효화 — getCachedConfig 가 새 값을 읽도록. */
function setConfig(cfg: DaemonConfig | null): void {
  H.cfg = cfg;
  invalidateAuthCache();
}

/** 주어진 평문 토큰에 대해 유효한 config(tokenHash 박제). */
function cfgForToken(token: string): DaemonConfig {
  return { port: 7777, tokenHash: hashToken(token), createdAt: 0 };
}

describe("hashToken — 결정적 sha256 hex", () => {
  it("동일 입력은 동일한 64자 hex sha256 을 낸다", () => {
    const a = hashToken("my-secret-token");
    const b = hashToken("my-secret-token");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    // crypto 로 직접 계산한 값과 일치(포맷 고정).
    const expected = crypto
      .createHash("sha256")
      .update("my-secret-token")
      .digest("hex");
    expect(a).toBe(expected);
  });

  it("다른 입력은 다른 해시", () => {
    expect(hashToken("token-a")).not.toBe(hashToken("token-b"));
  });

  it("빈 문자열도 64자 hex(throw 없음)", () => {
    expect(hashToken("")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("generateToken — base64url ≈43자 + 호출마다 상이", () => {
  it("32바이트 base64url → 43자, 패딩 없음", () => {
    const t = generateToken();
    expect(t).toHaveLength(43); // 32 bytes → base64url(패딩 제거) = 43자
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/); // base64url 알파벳(+,/,= 없음)
    expect(t).not.toContain("=");
  });

  it("호출마다 유일하다", () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 100; i++) tokens.add(generateToken());
    expect(tokens.size).toBe(100);
  });
});

describe("timingSafeEqualStr — 길이단락 / 상수시간 비교", () => {
  it("길이가 다르면 crypto.timingSafeEqual 호출 전에 false(단락) — throw 없음", () => {
    // 단락이 없으면 길이 다른 Buffer 로 crypto.timingSafeEqual 이 RangeError 를 throw 한다.
    // 따라서 «throw 없이 false» + «timingSafeEqual 미호출» 이 단락의 증거.
    const spy = vi.spyOn(crypto, "timingSafeEqual");
    expect(timingSafeEqualStr("abc", "ab")).toBe(false);
    expect(timingSafeEqualStr("", "x")).toBe(false);
    expect(timingSafeEqualStr("longer-string", "")).toBe(false);
    expect(() => timingSafeEqualStr("abc", "ab")).not.toThrow();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("같은 길이 동일값 → true", () => {
    expect(timingSafeEqualStr("abcdef", "abcdef")).toBe(true);
    expect(timingSafeEqualStr("", "")).toBe(true);
  });

  it("같은 길이 상이값 → false", () => {
    expect(timingSafeEqualStr("abcdef", "abcdeg")).toBe(false);
    expect(timingSafeEqualStr("x", "y")).toBe(false);
  });
});

describe("bearerAuth 미들웨어 — 거부 경로 / 성공 경로", () => {
  const TOKEN = "pairing-token-for-bearer-test";
  let app: Hono;

  beforeEach(() => {
    app = new Hono();
    app.use("*", bearerAuth);
    app.get("/", (c) => c.json({ ok: true }));
    setConfig(cfgForToken(TOKEN)); // 기본: 정상 초기화 상태
  });

  it("정확한 토큰 → 핸들러 도달(200)", async () => {
    const res = await app.request("/", {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean }).toEqual({ ok: true });
  });

  it("Authorization 헤더 없음 → 401 missing_bearer", async () => {
    const res = await app.request("/");
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("missing_bearer");
  });

  it("'Bearer ' 접두 없음 → 401 missing_bearer", async () => {
    const res = await app.request("/", { headers: { authorization: `Token ${TOKEN}` } });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("missing_bearer");
  });

  it("소문자 'bearer ' 는 대소문자 구분으로 거부(401 missing_bearer)", async () => {
    const res = await app.request("/", { headers: { authorization: `bearer ${TOKEN}` } });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("missing_bearer");
  });

  it("cfg=null(미초기화) → 503 daemon_not_initialized (올바른 헤더라도 fail-closed)", async () => {
    setConfig(null);
    const res = await app.request("/", {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe("daemon_not_initialized");
  });

  it("토큰 불일치 → 401 invalid_token (상수시간 거부)", async () => {
    const res = await app.request("/", {
      headers: { authorization: "Bearer wrong-token" },
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_token");
  });

  it("'Bearer' 뒤 공백만(빈 토큰) → HTTP 헤더 정규화로 접두 붕괴 → 401 거부(fail-closed)", async () => {
    // WHATWG fetch 가 헤더 값의 후행 공백을 제거 → "Bearer   " 가 "Bearer" 로 정규화되어
    // "Bearer " 접두가 깨진다 → missing_bearer. 토큰이 비면 어느 분기로든 401 로 닫힌다.
    const res = await app.request("/", { headers: { authorization: "Bearer    " } });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("missing_bearer");
  });

  it("'Bearer' 뒤 여분 공백이 끼어도 trim 으로 흡수돼 통과(200)", async () => {
    // "Bearer ".length(7) 만큼 slice → 남는 선행 공백은 trim 으로 제거되어 토큰 일치.
    const res = await app.request("/", {
      headers: { authorization: `Bearer   ${TOKEN}` },
    });
    expect(res.status).toBe(200);
  });
});

describe("verifyWsToken — WS 업그레이드 query 토큰 검증", () => {
  const TOKEN = "ws-pairing-token";

  beforeEach(() => setConfig(cfgForToken(TOKEN)));

  it("정확한 토큰 → true", () => {
    expect(verifyWsToken(TOKEN)).toBe(true);
  });

  it("null → false", () => {
    expect(verifyWsToken(null)).toBe(false);
  });

  it("빈 문자열 → false", () => {
    expect(verifyWsToken("")).toBe(false);
  });

  it("틀린 토큰 → false", () => {
    expect(verifyWsToken("nope")).toBe(false);
  });

  it("cfg=null(미초기화) → 정확한 토큰이라도 false (fail-closed)", () => {
    setConfig(null);
    expect(verifyWsToken(TOKEN)).toBe(false);
  });
});

describe("getCachedConfig / invalidateAuthCache — 캐시 + 재읽기 + fail-closed", () => {
  beforeEach(() => {
    setConfig({ port: 1, tokenHash: "hash-one", createdAt: 0 });
    H.readCount = 0; // setConfig 가 부른 invalidate 후부터 카운트
  });

  it("readConfig 를 한 번만 호출하고 같은 객체를 캐시한다", () => {
    const c1 = getCachedConfig();
    const c2 = getCachedConfig();
    expect(c1).toBe(c2);
    expect(c1?.tokenHash).toBe("hash-one");
    expect(H.readCount).toBe(1); // 두 번째 호출은 디스크/readConfig 재호출 없음
  });

  it("invalidateAuthCache 후 다음 getCachedConfig 가 새 config 를 다시 읽는다", () => {
    expect(getCachedConfig()?.tokenHash).toBe("hash-one"); // 최초 읽기(1)
    // config 가 바뀌어도 무효화 전엔 옛 캐시값.
    H.cfg = { port: 1, tokenHash: "hash-two", createdAt: 0 };
    expect(getCachedConfig()?.tokenHash).toBe("hash-one");
    expect(H.readCount).toBe(1);
    // 무효화 후엔 새 값 반영.
    invalidateAuthCache();
    expect(getCachedConfig()?.tokenHash).toBe("hash-two"); // 재읽기(2)
    expect(H.readCount).toBe(2);
  });

  it("readConfig 가 null(설정 파일 없음/파싱 실패)이면 getCachedConfig 도 null — fail-closed", () => {
    setConfig(null);
    expect(getCachedConfig()).toBeNull();
  });
});
