/**
 * `attest.ts` — Secure Enclave 기기 인증 코어 단위 테스트.
 *
 * 검증 대상:
 *  - verifyP256Signature: iOS 가 보내는 «X9.63 raw 65B 공개키 + SHA256 + ASN.1 DER 서명»
 *    포맷을 Node crypto 가 그대로 검증하는지 (cross-format 호환). tamper/wrong-key → false.
 *  - challenge nonce: 단일 사용 + 60s TTL.
 *  - attest 토큰: HMAC 왕복, 만료, 공개키 바인딩(다른 키로는 무효), tamper → false.
 *
 * iOS 실제 SE 서명을 오프라인 생성할 수는 없으므로, Node `crypto.sign("sha256", …, {
 * dsaEncoding:"der" })` 로 «동일 포맷» 서명을 만들어 포맷 호환을 고정 벡터처럼 확인한다.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import crypto from "node:crypto";
import { Hono } from "hono";

// attest.ts 는 getCachedConfig(→config.js) 를 거치므로 in-memory config 로 mock.
const H = vi.hoisted(() => ({ cfg: null as Record<string, unknown> | null }));

vi.mock("./config.js", () => ({
  CONFIG_DIR: "/tmp/ps-attest-test",
  CONFIG_FILE: "/tmp/ps-attest-test/config.json",
  DB_FILE: "/tmp/ps-attest-test/test.db",
  MAX_DEVICE_SLOTS: 3,
  ensureConfigDir: () => {},
  readConfig: () => H.cfg,
  writeConfig: (c: Record<string, unknown>) => {
    H.cfg = c;
  },
  // 실제 config.ts 와 동일 로직 — 신규 attestDevices 우선, 레거시 attestPublicKey 1원소 흡수.
  listAttestDevices: (cfg: Record<string, unknown> | null | undefined) => {
    if (!cfg) return [];
    const arr = cfg.attestDevices as Array<{ publicKey: string; registeredAt: number }> | undefined;
    if (arr && arr.length > 0) return arr.slice(0, 3);
    if (cfg.attestPublicKey) {
      return [{ publicKey: cfg.attestPublicKey as string, registeredAt: (cfg.attestRegisteredAt as number) ?? 0 }];
    }
    return [];
  },
  allowedDeviceSlots: (cfg: Record<string, unknown> | null | undefined) =>
    cfg?.extraDeviceSlotAllowed ? 3 : 1,
}));

const {
  verifyP256Signature,
  issueChallenge,
  consumeNonce,
  issueAttestToken,
  verifyAttestToken,
  isAttestEnrolled,
  attestKeyFingerprint,
  attestKeyFingerprints,
  fingerprintForPublicKey,
  deviceIdFor,
  recordDeviceSeen,
  getDeviceSeen,
  requireAttestation,
} = await import("./attest.js");
const { invalidateAuthCache, hashToken } = await import("./auth.js");
const { attest: attestRoutes } = await import("./routes/attest.js");

/** iOS SecKeyCopyExternalRepresentation 흉내 — EC 공개키를 X9.63 uncompressed 65B 로. */
function rawP256PubKey(pub: crypto.KeyObject): string {
  const jwk = pub.export({ format: "jwk" }) as { x: string; y: string };
  const x = Buffer.from(jwk.x, "base64url");
  const y = Buffer.from(jwk.y, "base64url");
  return Buffer.concat([Buffer.from([0x04]), x, y]).toString("base64");
}

function makeKeyPair() {
  return crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
}

/** iOS .ecdsaSignatureMessageX962SHA256 흉내 — SHA256 해시 + ASN.1 DER 서명. */
function signDer(priv: crypto.KeyObject, msg: Buffer): Buffer {
  return crypto.sign("sha256", msg, { key: priv, dsaEncoding: "der" });
}

function setEnrolled(pubBase64: string | null) {
  H.cfg = pubBase64
    ? { tokenHash: "x", createdAt: 0, port: 7777, attestPublicKey: pubBase64 }
    : { tokenHash: "x", createdAt: 0, port: 7777 };
  invalidateAuthCache(); // getCachedConfig 가 새 config 를 읽도록
}

function setConfig(opts: Record<string, unknown>) {
  H.cfg = { tokenHash: "x", createdAt: 0, port: 7777, ...opts };
  invalidateAuthCache();
}

describe("verifyP256Signature — iOS 포맷 호환", () => {
  it("raw 65B 공개키 + SHA256 + DER 서명을 검증한다", () => {
    const { publicKey, privateKey } = makeKeyPair();
    const pub = rawP256PubKey(publicKey);
    const msg = Buffer.from("challenge-nonce-abc123", "utf8");
    const sig = signDer(privateKey, msg);
    expect(verifyP256Signature(pub, msg, sig)).toBe(true);
  });

  it("메시지가 변조되면 false", () => {
    const { publicKey, privateKey } = makeKeyPair();
    const pub = rawP256PubKey(publicKey);
    const sig = signDer(privateKey, Buffer.from("original", "utf8"));
    expect(verifyP256Signature(pub, Buffer.from("tampered", "utf8"), sig)).toBe(false);
  });

  it("다른 키로 서명하면 false", () => {
    const a = makeKeyPair();
    const b = makeKeyPair();
    const msg = Buffer.from("msg", "utf8");
    const sig = signDer(b.privateKey, msg); // b 로 서명
    expect(verifyP256Signature(rawP256PubKey(a.publicKey), msg, sig)).toBe(false);
  });

  it("깨진 공개키/서명은 throw 없이 false", () => {
    expect(verifyP256Signature("not-base64-65b", Buffer.from("x"), Buffer.from("y"))).toBe(
      false,
    );
    expect(verifyP256Signature("", Buffer.alloc(0), Buffer.alloc(0))).toBe(false);
  });
});

describe("challenge nonce — 단일 사용 + TTL", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("한 번만 소비된다", () => {
    const { nonce } = issueChallenge();
    expect(consumeNonce(nonce)).toBe(true);
    expect(consumeNonce(nonce)).toBe(false); // 재사용 거부
  });

  it("존재하지 않는 nonce 는 false", () => {
    expect(consumeNonce("never-issued")).toBe(false);
  });

  it("60s 지나면 만료된다", () => {
    const { nonce, ttlSec } = issueChallenge();
    expect(ttlSec).toBe(60);
    vi.advanceTimersByTime(61_000);
    expect(consumeNonce(nonce)).toBe(false);
  });
});

describe("attest 토큰 — HMAC 왕복 / 만료 / 공개키 바인딩", () => {
  let pub: string;

  beforeEach(() => {
    const { publicKey } = makeKeyPair();
    pub = rawP256PubKey(publicKey);
    setEnrolled(pub);
  });
  afterEach(() => {
    vi.useRealTimers();
    setEnrolled(null);
  });

  it("발급한 토큰은 검증을 통과하고 deviceId 를 돌려준다", () => {
    const { token } = issueAttestToken(pub);
    expect(verifyAttestToken(token)).toBe(deviceIdFor(pub));
  });

  it("변조된 토큰은 거부된다(null)", () => {
    const { token } = issueAttestToken(pub);
    expect(verifyAttestToken(token + "x")).toBeNull();
    expect(verifyAttestToken("garbage.sig")).toBeNull();
    expect(verifyAttestToken(null)).toBeNull();
  });

  it("24h 지나면 만료된다", () => {
    vi.useFakeTimers();
    const { token } = issueAttestToken(pub);
    vi.advanceTimersByTime(24 * 60 * 60 * 1000 + 1000);
    expect(verifyAttestToken(token)).toBeNull();
  });

  it("등록 공개키가 바뀌면(회전/재등록) 옛 토큰은 무효", () => {
    const { token } = issueAttestToken(pub);
    expect(verifyAttestToken(token)).toBe(deviceIdFor(pub));
    // 다른 키로 재등록 → deviceId 바인딩 불일치
    const { publicKey: other } = makeKeyPair();
    setEnrolled(rawP256PubKey(other));
    expect(verifyAttestToken(token)).toBeNull();
  });

  it("미등록 상태(공개키 없음)면 어떤 토큰도 무효", () => {
    const { token } = issueAttestToken(pub);
    setEnrolled(null);
    expect(isAttestEnrolled()).toBe(false);
    expect(verifyAttestToken(token)).toBeNull();
  });
});

describe("다중 기기 — 두 기기의 토큰이 각각 유효 / 지문 목록", () => {
  let pubA: string;
  let pubB: string;

  beforeEach(() => {
    pubA = rawP256PubKey(makeKeyPair().publicKey);
    pubB = rawP256PubKey(makeKeyPair().publicKey);
    setConfig({
      attestDevices: [
        { publicKey: pubA, registeredAt: 1 },
        { publicKey: pubB, registeredAt: 2 },
      ],
    });
  });
  afterEach(() => setConfig({}));

  it("두 기기 각각의 토큰이 자기 deviceId 로 검증된다", () => {
    expect(verifyAttestToken(issueAttestToken(pubA).token)).toBe(deviceIdFor(pubA));
    expect(verifyAttestToken(issueAttestToken(pubB).token)).toBe(deviceIdFor(pubB));
  });

  it("한 기기를 해제하면(목록에서 제거) 그 토큰만 무효, 남은 기기는 유효", () => {
    const tokA = issueAttestToken(pubA).token;
    const tokB = issueAttestToken(pubB).token;
    // A 해제 = 목록에서 제거
    setConfig({ attestDevices: [{ publicKey: pubB, registeredAt: 2 }] });
    expect(verifyAttestToken(tokA)).toBeNull();
    expect(verifyAttestToken(tokB)).toBe(deviceIdFor(pubB));
  });

  it("attestKeyFingerprints 는 등록된 모든 기기 지문, attestKeyFingerprint 는 첫 기기", () => {
    expect(attestKeyFingerprints()).toEqual([
      fingerprintForPublicKey(pubA),
      fingerprintForPublicKey(pubB),
    ]);
    expect(attestKeyFingerprint()).toBe(fingerprintForPublicKey(pubA));
  });

  it("레거시 attestPublicKey 만 있어도 1원소 목록으로 흡수돼 검증된다", () => {
    setConfig({ attestPublicKey: pubA });
    expect(isAttestEnrolled()).toBe(true);
    expect(verifyAttestToken(issueAttestToken(pubA).token)).toBe(deviceIdFor(pubA));
    expect(attestKeyFingerprints()).toEqual([fingerprintForPublicKey(pubA)]);
  });
});

describe("등록 게이트 (/api/attest/register) — 슬롯 상한 (최대 3대)", () => {
  // 페어링 토큰: bearerAuth 는 hashToken(token) === cfg.tokenHash 를 본다.
  const TOKEN = "pairing-token-for-register-test";
  const BEARER = { authorization: `Bearer ${TOKEN}` };

  /** 새 SE 키쌍 → { publicKey(base64 65B), signature(base64 DER over pubKey bytes) }. */
  function makeRegistration() {
    const { publicKey, privateKey } = makeKeyPair();
    const pub = rawP256PubKey(publicKey);
    const sig = signDer(privateKey, Buffer.from(pub, "base64")); // 공개키 바이트에 self-sign
    return { publicKey: pub, signature: sig.toString("base64") };
  }

  async function register(body: unknown) {
    return attestRoutes.request("/register", {
      method: "POST",
      headers: { ...BEARER, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  afterEach(() => setConfig({}));

  it("추가 기기 허용 ON 이면 폰+태블릿+세컨드폰 3대까지 등록되고 4대째는 409 slot_unavailable", async () => {
    setConfig({ tokenHash: hashToken(TOKEN), extraDeviceSlotAllowed: true });
    for (let i = 0; i < 3; i++) {
      const res = await register(makeRegistration());
      expect(res.status).toBe(200);
      expect((await res.json()) as { ok: boolean }).toEqual({ ok: true });
    }
    // 4대째 — 빈 슬롯 없음.
    const fourth = await register(makeRegistration());
    expect(fourth.status).toBe(409);
    expect(((await fourth.json()) as { error: string }).error).toBe("slot_unavailable");
  });

  it("추가 기기 허용 OFF(기본)면 1대만 등록되고 2대째는 409 slot_unavailable", async () => {
    setConfig({ tokenHash: hashToken(TOKEN) }); // extraDeviceSlotAllowed 미설정 = 1슬롯
    expect((await register(makeRegistration())).status).toBe(200);
    const second = await register(makeRegistration());
    expect(second.status).toBe(409);
    expect(((await second.json()) as { error: string }).error).toBe("slot_unavailable");
  });

  it("같은 공개키 재등록은 멱등(ok) — 슬롯을 새로 먹지 않는다", async () => {
    setConfig({ tokenHash: hashToken(TOKEN), extraDeviceSlotAllowed: true });
    const reg = makeRegistration();
    expect((await register(reg)).status).toBe(200);
    const again = await register(reg);
    expect(again.status).toBe(200);
    expect((await again.json()) as { ok: boolean }).toEqual({ ok: true });
  });
});

describe("표시 메타데이터 — 지문 / lastSeen", () => {
  afterEach(() => setEnrolled(null));

  it("attestKeyFingerprint 는 등록 시 SHA256 지문, 미등록 시 null", () => {
    setEnrolled(null);
    expect(attestKeyFingerprint()).toBeNull();
    const { publicKey } = makeKeyPair();
    const pub = rawP256PubKey(publicKey);
    setEnrolled(pub);
    const fp = attestKeyFingerprint();
    expect(fp).toMatch(/^SHA256:/);
    // crypto 로 직접 계산한 값과 일치
    const expected =
      "SHA256:" +
      crypto
        .createHash("sha256")
        .update(Buffer.from(pub, "base64"))
        .digest("base64")
        .replace(/=+$/, "");
    expect(fp).toBe(expected);
  });

  it("recordDeviceSeen → getDeviceSeen 이 기기별 타임스탬프 반환", () => {
    recordDeviceSeen("dev-A");
    const seen = getDeviceSeen("dev-A");
    expect(typeof seen).toBe("number");
    expect(seen).toBeGreaterThan(0);
    // 다른 기기는 아직 기록 없음
    expect(getDeviceSeen("dev-unseen")).toBeNull();
  });
});

describe("requireAttestation 미들웨어 — soft / 강제 / 로컬 운영자 우회 / 예외경로", () => {
  // 회귀 방지: 폰 등록(enrolled) 후 Mac 앱 자기 /api/* 호출이 X-PS-Local 로 통과해야 한다.
  // 이게 깨지면 폰 등록 순간 Mac 앱 설정·회전 등이 전부 401 로 막힌다(이번 버그).
  const LOCAL = "local-admin-secret-fixed-for-test";
  let pub: string;
  let app: Hono;

  beforeEach(() => {
    const { publicKey } = makeKeyPair();
    pub = rawP256PubKey(publicKey);
    app = new Hono();
    app.use("/api/*", requireAttestation);
    app.get("/api/sessions", (c) => c.json({ ok: true }));
    app.get("/api/attest/status", (c) => c.json({ ok: true }));
    app.get("/api/version", (c) => c.json({ ok: true }));
  });
  afterEach(() => setConfig({})); // attestPublicKey 없음 = 미등록으로 리셋

  it("미등록이면 통과(soft) — 옛 iOS / 미등록 기기 호환", async () => {
    setConfig({ localAdminSecret: LOCAL });
    expect((await app.request("/api/sessions")).status).toBe(200);
  });

  it("등록됐는데 헤더 없으면 401 attest_required", async () => {
    setConfig({ attestPublicKey: pub, localAdminSecret: LOCAL });
    const res = await app.request("/api/sessions");
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("attest_required");
  });

  it("로컬 운영자(X-PS-Local 일치)는 통과 — Mac 앱 회귀 방지", async () => {
    setConfig({ attestPublicKey: pub, localAdminSecret: LOCAL });
    const res = await app.request("/api/sessions", {
      headers: { "x-ps-local": LOCAL },
    });
    expect(res.status).toBe(200);
  });

  it("X-PS-Local 불일치는 거부", async () => {
    setConfig({ attestPublicKey: pub, localAdminSecret: LOCAL });
    const res = await app.request("/api/sessions", {
      headers: { "x-ps-local": "wrong-secret" },
    });
    expect(res.status).toBe(401);
  });

  it("유효 attest 토큰(X-PS-Attest)은 통과 — 폰 정상 경로", async () => {
    setConfig({ attestPublicKey: pub, localAdminSecret: LOCAL });
    const { token } = issueAttestToken(pub);
    const res = await app.request("/api/sessions", {
      headers: { "x-ps-attest": token },
    });
    expect(res.status).toBe(200);
  });

  it("예외 경로(/api/attest/*, /api/version)는 등록됐어도 헤더 없이 통과", async () => {
    setConfig({ attestPublicKey: pub, localAdminSecret: LOCAL });
    expect((await app.request("/api/attest/status")).status).toBe(200);
    expect((await app.request("/api/version")).status).toBe(200);
  });
});
