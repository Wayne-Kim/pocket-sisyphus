// Secure Enclave 기기 인증 (challenge-response) 의 daemon 측 코어.
//
// 배경: 폰↔daemon 인증은 원래 전부 QR 에 담긴 «정적» 비밀(SSH client priv + bearer token)
// 에 의존했다 — QR 사진 한 장이 유출되면 폰을 완전히 가장 가능. 이 모듈은 거기에 «추출
// 불가능한 하드웨어 키» 한 겹을 더 얹는다:
//
//  1) 페어링 시 폰이 Secure Enclave 에 P-256 키 한 쌍을 만들고 «공개키» 만 등록한다.
//  2) 매 세션 시작 시 daemon 이 nonce 를 발급 → 폰이 SE 키로 서명 → daemon 이 등록된
//     공개키로 «오프라인» 검증 → 단기 attest 토큰 발급.
//  3) 이후 모든 `/api/*`·WS 요청은 그 토큰을 지참해야 한다 (requireAttestation).
//
// 검증은 Apple 인프라와 무관하게 daemon 이 직접 한다 (외부서버 0 원칙 유지). private key 는
// 폰 enclave 밖으로 절대 안 나오므로, QR/토큰을 모두 탈취해도 nonce 에 유효 서명을 못 만든다.

import crypto from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { getCachedConfig, timingSafeEqualStr } from "./auth.js";
import { listAttestDevices } from "./config.js";

// ─── P-256 공개키 / 서명 검증 ────────────────────────────────────────────────

/**
 * iOS `SecKeyCopyExternalRepresentation` 의 EC 공개키 = X9.63 uncompressed point
 * (`0x04 || X(32) || Y(32)`, 65 bytes). 이를 Node `KeyObject` 로 만든다.
 *
 * 직접 SPKI DER 를 손으로 짜는 대신 JWK import 를 쓴다 — X/Y 를 base64url 로 떼어 넣으면
 * Node 가 알아서 P-256 공개키를 구성. (DER prefix 오타로 디버깅 지옥 가는 것 방지.)
 */
function publicKeyFromRawP256(pubBase64: string): crypto.KeyObject {
  const raw = Buffer.from(pubBase64, "base64");
  if (raw.length !== 65 || raw[0] !== 0x04) {
    throw new Error(
      `invalid P-256 public key: expected 65B uncompressed point, got ${raw.length}B`,
    );
  }
  const x = raw.subarray(1, 33);
  const y = raw.subarray(33, 65);
  return crypto.createPublicKey({
    key: {
      kty: "EC",
      crv: "P-256",
      x: x.toString("base64url"),
      y: y.toString("base64url"),
    },
    format: "jwk",
  });
}

/**
 * 메시지(raw bytes)에 대한 ECDSA-P256-SHA256 서명 검증.
 *
 * iOS `SecKeyCreateSignature(.ecdsaSignatureMessageX962SHA256)` 는 메시지를 SHA-256 해시한
 * 뒤 ECDSA 서명을 «ASN.1 DER» 로 낸다. Node `crypto.verify` 의 EC 기본 `dsaEncoding` 도
 * "der" 라 그대로 호환된다 (IEEE-P1363 변환 불필요).
 *
 * 어떤 입력(깨진 키/서명)이 와도 throw 하지 않고 false 로 수렴 — 인증 게이트라 «실패=거부».
 */
export function verifyP256Signature(
  pubBase64: string,
  message: Buffer,
  signatureDer: Buffer,
): boolean {
  try {
    const key = publicKeyFromRawP256(pubBase64);
    return crypto.verify("sha256", message, { key, dsaEncoding: "der" }, signatureDer);
  } catch {
    return false;
  }
}

// ─── Challenge nonce 저장소 (in-memory, 단일 사용) ────────────────────────────

const NONCE_TTL_MS = 60_000;
/** nonce(base64url) → 만료 epoch ms. verify 성공 시 삭제(단일 사용), 만료분은 발급 때 청소. */
const pendingNonces = new Map<string, number>();

/** 새 challenge nonce 발급. 32B 랜덤 → base64url. TTL 60s, 단일 사용. */
export function issueChallenge(): { nonce: string; ttlSec: number } {
  pruneExpiredNonces();
  const nonce = crypto.randomBytes(32).toString("base64url");
  pendingNonces.set(nonce, Date.now() + NONCE_TTL_MS);
  return { nonce, ttlSec: NONCE_TTL_MS / 1000 };
}

/** nonce 가 유효(존재 + 미만료)하면 소비(삭제)하고 true. 재사용/만료/미존재면 false. */
export function consumeNonce(nonce: string): boolean {
  const exp = pendingNonces.get(nonce);
  if (exp === undefined) return false;
  pendingNonces.delete(nonce);
  return Date.now() <= exp;
}

function pruneExpiredNonces(): void {
  const now = Date.now();
  for (const [n, exp] of pendingNonces) {
    if (exp < now) pendingNonces.delete(n);
  }
}

// ─── Attest 토큰 (HMAC, in-memory boot secret) ───────────────────────────────

/**
 * daemon 부팅 시 1회 생성하는 HMAC 서명 키. 디스크에 안 적는다 — daemon 재시작 시 모든
 * attest 토큰이 자동 무효화돼 폰이 재인증(Face ID 1회)하게 된다. 단기 토큰이라 충분.
 */
const BOOT_HMAC_SECRET = crypto.randomBytes(32);

/** attest 토큰 수명 — 24h. 만료되면 폰이 challenge-response 를 다시 1회 수행. */
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * 등록된 공개키에 묶인 device id (= 공개키 SHA256 의 앞 16B hex). 토큰을 이 값에 바인딩하면
 * rotate-pairing(공개키 삭제)·재등록(공개키 교체) 시 옛 토큰이 자동 무효가 된다.
 * 다중 기기에서도 각 키가 서로 다른 deviceId 를 가져 토큰/lastSeen 을 기기별로 가른다.
 */
export function deviceIdFor(pubBase64: string): string {
  return crypto.createHash("sha256").update(pubBase64).digest("hex").slice(0, 32);
}

function signPayload(b64Payload: string): string {
  return crypto
    .createHmac("sha256", BOOT_HMAC_SECRET)
    .update(b64Payload)
    .digest("base64url");
}

/** 현재 등록된 공개키에 바인딩된 attest 토큰 발급. `"<payload>.<sig>"`. */
export function issueAttestToken(pubBase64: string): { token: string; exp: number } {
  const exp = Date.now() + TOKEN_TTL_MS;
  const payload = JSON.stringify({ d: deviceIdFor(pubBase64), exp });
  const b64 = Buffer.from(payload, "utf8").toString("base64url");
  return { token: `${b64}.${signPayload(b64)}`, exp };
}

/**
 * attest 토큰 검증: HMAC 일치(timing-safe) + 미만료 + 등록된 «어느» 기기 공개키에 바인딩.
 * 검증을 통과하면 그 토큰이 묶인 deviceId 를 반환(미들웨어가 lastSeen 기록에 사용),
 * 실패하면 null. 어떤 깨진 입력도 throw 없이 null 로 수렴.
 *
 * 다중 기기: 현재 등록된 모든 기기의 deviceId 집합에 payload.d 가 포함되면 통과.
 */
export function verifyAttestToken(token: string | null | undefined): string | null {
  if (!token) return null;
  const devices = listAttestDevices(getCachedConfig());
  if (devices.length === 0) return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const b64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const expectedSig = signPayload(b64);
  if (
    sig.length !== expectedSig.length ||
    !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))
  ) {
    return null;
  }
  try {
    const payload = JSON.parse(Buffer.from(b64, "base64url").toString("utf8")) as {
      d?: string;
      exp?: number;
    };
    if (typeof payload.exp !== "number" || Date.now() > payload.exp) return null;
    const match = devices.find((d) => deviceIdFor(d.publicKey) === payload.d);
    return match ? (payload.d as string) : null;
  } catch {
    return null;
  }
}

/** 이 daemon 이 기기 인증을 강제하는 상태인지 (= 기기가 1대 이상 등록됨). */
export function isAttestEnrolled(): boolean {
  return listAttestDevices(getCachedConfig()).length > 0;
}

/** 임의 공개키의 표시용 지문 ("SHA256:<base64-no-padding>"). iOS DeviceAttestor 와 동일 포맷. */
export function fingerprintForPublicKey(pubBase64: string): string {
  const hash = crypto
    .createHash("sha256")
    .update(Buffer.from(pubBase64, "base64"))
    .digest("base64")
    .replace(/=+$/, "");
  return `SHA256:${hash}`;
}

/** 첫 등록 기기의 표시용 지문 (레거시 단일 응답 호환). 미등록이면 null. */
export function attestKeyFingerprint(): string | null {
  const devices = listAttestDevices(getCachedConfig());
  return devices.length > 0 ? fingerprintForPublicKey(devices[0].publicKey) : null;
}

/** 현재 등록된 모든 기기의 지문 목록. 미등록이면 빈 배열. */
export function attestKeyFingerprints(): string[] {
  return listAttestDevices(getCachedConfig()).map((d) => fingerprintForPublicKey(d.publicKey));
}

// ─── 마지막 접속(lastSeen) — in-memory, 기기별 ───────────────────────────────
//
// 각 등록 기기가 «인증된» 요청을 마지막으로 보낸 시각(epoch ms) 을 deviceId 별로 기록.
// 디스크에 안 적는다 — daemon 재시작 시 초기화(이번 부팅 후 폰이 다시 붙으면 갱신).
// Mac 앱 「기기」 탭이 기기별로 표시한다.

const lastSeenByDevice = new Map<string, number>();

/** 인증된 요청을 받을 때마다 호출 — 해당 deviceId 의 마지막 접속 시각 갱신. */
export function recordDeviceSeen(deviceId: string): void {
  lastSeenByDevice.set(deviceId, Date.now());
}

/** 한 기기의 마지막 인증 접속 시각(epoch ms). 이번 부팅 후 기록 없으면 null. */
export function getDeviceSeen(deviceId: string): number | null {
  return lastSeenByDevice.get(deviceId) ?? null;
}

// ─── 강제 게이트 (HTTP 미들웨어 + WS 검증) ────────────────────────────────────

/**
 * `/api/*` 에 거는 기기 인증 미들웨어.
 *
 *  - soft 모드: 공개키 미등록(`isAttestEnrolled()===false`)이면 통과 — 옛 iOS / 아직
 *    SE 키를 안 올린 새 기기와의 하위 호환. 등록된 «뒤로는» 강제로 전환된다.
 *  - 예외 경로: attest 흐름 자체(`/api/attest/*`)와 버전 핸드셰이크(`/api/version`)는
 *    토큰 발급 «전» 단계라 게이트를 통과시켜야 닭-달걀을 피한다.
 *  - 그 외엔 `X-PS-Attest` 헤더의 토큰을 검증, 실패 시 401 `attest_required`.
 *    (iOS ApiClient 가 이 코드를 보고 challenge-response 1회 재수행 후 재시도.)
 */
export const requireAttestation: MiddlewareHandler = async (c, next) => {
  if (!isAttestEnrolled()) return next();
  const p = c.req.path;
  if (p.startsWith("/api/attest/") || p === "/api/version") return next();
  // 로컬 운영자(같은 머신의 Mac 앱)는 페어링과 무관한 daemon 호스트라 attest 면제. 폰이 가질
  // 수 없는 localAdminSecret(QR 미포함)을 X-PS-Local 로 제시하면 통과.
  if (isLocalAdmin(c.req.header("x-ps-local"))) return next();
  const deviceId = verifyAttestToken(c.req.header("x-ps-attest"));
  if (!deviceId) {
    return c.json({ error: "attest_required" }, 401);
  }
  // 인증된 폰 요청 — 그 기기의 마지막 접속 시각 갱신(「기기」 탭 표시용).
  recordDeviceSeen(deviceId);
  return next();
};

/** X-PS-Local 헤더가 config 의 localAdminSecret 과 일치하는지 (로컬 Mac 앱 운영자). */
function isLocalAdmin(secret: string | undefined): boolean {
  const expected = getCachedConfig()?.localAdminSecret;
  if (!expected || !secret) return false;
  return timingSafeEqualStr(secret, expected);
}

/**
 * WS 업그레이드용 게이트 — 헤더를 못 붙이는 WS 라 `?attest=` query 로 받는다.
 * soft 모드(미등록)면 항상 true. 등록된 뒤엔 토큰 검증 결과.
 *
 * `localSecret`(`?local=` query) 은 HTTP 의 X-PS-Local 과 짝인 로컬 운영자 우회 —
 * 같은 머신의 클라이언트(Mac 앱, 시뮬레이터 자가 검증 루프)가 attest 없이 통과한다.
 * localAdminSecret 은 QR 에 안 실리므로 원격 폰은 이 경로를 못 쓴다.
 */
export function verifyWsAttest(
  token: string | null,
  localSecret?: string | null,
): boolean {
  if (!isAttestEnrolled()) return true;
  if (localSecret && isLocalAdmin(localSecret)) return true;
  const deviceId = verifyAttestToken(token);
  if (!deviceId) return false;
  recordDeviceSeen(deviceId);
  return true;
}
