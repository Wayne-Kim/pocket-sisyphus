// `/api/attest/*` — Secure Enclave 기기 인증 (challenge-response) 엔드포인트.
//
// 흐름 (상세 배경은 ../attest.ts 주석 참고):
//   1) POST /register   — 폰이 SE 공개키를 «1회» 등록. 이미 등록돼 있으면 409.
//   2) GET  /challenge  — daemon 이 nonce 발급.
//   3) POST /verify     — 폰이 nonce 를 SE 키로 서명 → daemon 검증 → 단기 attest 토큰 발급.
//   4) GET  /status     — 등록 여부(enrolled) 조회. iOS 가 등록 필요 여부 판단용.
//
// 모든 라우트 bearerAuth. 이 라우트들은 requireAttestation 게이트의 «예외» 경로라
// (server.ts 가 `/api/attest/*` 를 통과시킴) 토큰 없이도 도달 가능 — 토큰을 «받는» 곳이니 당연.

import { Hono } from "hono";
import { bearerAuth, invalidateAuthCache } from "../auth.js";
import {
  readConfig,
  writeConfig,
  listAttestDevices,
  allowedDeviceSlots,
} from "../config.js";
import {
  issueAttestToken,
  issueChallenge,
  consumeNonce,
  verifyP256Signature,
  isAttestEnrolled,
  attestKeyFingerprint,
  attestKeyFingerprints,
  deviceIdFor,
  recordDeviceSeen,
} from "../attest.js";

export const attest = new Hono();

attest.use("*", bearerAuth);

/**
 * 등록 여부 — iOS 가 페어링 시 «등록 필요? / 빈 슬롯 있음?» 를 판단하는 가벼운 조회.
 *
 * - `fingerprint`: 첫 등록 기기 지문 (레거시 단일 응답 — 옛 iOS 호환). 미등록 시 null.
 * - `fingerprints`: 현재 등록된 모든 기기의 지문 목록. 새 폰이 자기 SE 키 지문이 이미
 *   들어 있는지(=재페어링) 비교하는 데 쓴다.
 * - `slotAvailable`: 지금 새 기기를 «추가» 등록할 빈 슬롯이 있는지(= 등록 수 < 허용 슬롯).
 *   false 면 iOS 가 Face ID 프롬프트 «전» 에 «추가 기기 허용을 켜라/기존 기기 해제» 를
 *   명확히 안내한다. 옛 iOS 는 이 필드를 무시하고 fingerprint 단일 비교만 한다.
 *
 * 지문은 비밀이 아니다(공개키의 해시). admin/device-info 도 같은 값을 돌려준다.
 */
attest.get("/status", (c) => {
  const cfg = readConfig();
  const devices = listAttestDevices(cfg);
  return c.json({
    enrolled: isAttestEnrolled(),
    fingerprint: attestKeyFingerprint(),
    fingerprints: attestKeyFingerprints(),
    slotAvailable: devices.length < allowedDeviceSlots(cfg),
  });
});

/**
 * 폰의 Secure Enclave 공개키를 등록한다 (기기당 1회 = TOFU).
 *
 * body: { publicKey: base64(X9.63 65B), signature: base64(DER over publicKey bytes) }
 *
 * - 소유 증명: 등록 요청은 «공개키 그 자체» 에 대한 서명을 동봉한다. 그 서명이 바로 그
 *   공개키로 검증되면, 요청자가 대응 private key (SE 안) 를 실제로 쥐고 있다는 뜻.
 * - 슬롯 모델: 등록 가능한 기기 수는 `allowedDeviceSlots(cfg)` (기본 1, 추가 기기 슬롯을
 *   사용자가 켜면 최대 `MAX_DEVICE_SLOTS`). 빈 슬롯이 없으면 409 `slot_unavailable` —
 *   사용자가 Mac 에서 추가 기기 슬롯을 켜거나 기존 기기를 해제해야 한다 = 물리 접근 필요(의도된 보안).
 * - 멱등: 같은 공개키 재등록은 ok (재페어링 중 중복 호출 방어).
 */
attest.post("/register", async (c) => {
  const cfg = readConfig();
  if (!cfg) return c.json({ error: "daemon_not_initialized" }, 503);

  let body: { publicKey?: unknown; signature?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const publicKey = typeof body.publicKey === "string" ? body.publicKey : "";
  const signature = typeof body.signature === "string" ? body.signature : "";
  if (!publicKey || !signature) {
    return c.json({ error: "missing_fields" }, 400);
  }

  // 소유 증명: 공개키 바이트에 대한 self-signature 검증.
  const pubBytes = Buffer.from(publicKey, "base64");
  const sigDer = Buffer.from(signature, "base64");
  if (!verifyP256Signature(publicKey, pubBytes, sigDer)) {
    return c.json({ error: "signature_invalid" }, 400);
  }

  const devices = listAttestDevices(cfg);
  // 멱등: 이미 등록된 기기면 그대로 ok (중복 등록 호출 무해).
  if (devices.some((d) => d.publicKey === publicKey)) {
    return c.json({ ok: true });
  }
  // 빈 슬롯 없음 — 사용자가 추가 기기 슬롯을 켜거나 기존 기기를 해제해야 한다.
  if (devices.length >= allowedDeviceSlots(cfg)) {
    return c.json({ error: "slot_unavailable" }, 409);
  }

  // 신규 기기 추가. 항상 attestDevices 배열로 정규화하며 레거시 단일 필드는 비운다.
  const next = [...devices, { publicKey, registeredAt: Date.now() }];
  writeConfig({
    ...cfg,
    attestDevices: next,
    attestPublicKey: undefined,
    attestRegisteredAt: undefined,
  });
  // bearerAuth / attest 게이트가 config 를 메모리 캐시하므로 새 등록 즉시 반영되도록 무효화.
  invalidateAuthCache();
  return c.json({ ok: true });
});

/** 새 challenge nonce 발급. 폰은 이 nonce 의 UTF-8 바이트를 SE 키로 서명한다. */
attest.get("/challenge", (c) => {
  const { nonce, ttlSec } = issueChallenge();
  return c.json({ nonce, ttlSec });
});

/**
 * challenge 응답 검증 → 단기 attest 토큰 발급.
 *
 * body: { nonce: string, signature: base64(DER over UTF-8 bytes of nonce) }
 *
 * nonce 는 단일 사용(consumeNonce) + 60s TTL. 서명은 등록된 공개키로 검증.
 */
attest.post("/verify", async (c) => {
  const cfg = readConfig();
  const devices = listAttestDevices(cfg);
  if (devices.length === 0) {
    return c.json({ error: "not_enrolled" }, 409);
  }

  let body: { nonce?: unknown; signature?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const nonce = typeof body.nonce === "string" ? body.nonce : "";
  const signature = typeof body.signature === "string" ? body.signature : "";
  if (!nonce || !signature) {
    return c.json({ error: "missing_fields" }, 400);
  }
  if (!consumeNonce(nonce)) {
    return c.json({ error: "nonce_invalid" }, 400);
  }
  // 등록된 «어느» 기기 키로든 서명이 검증되면 그 기기에 토큰을 발급한다.
  const nonceBytes = Buffer.from(nonce, "utf8");
  const sigDer = Buffer.from(signature, "base64");
  const matched = devices.find((d) =>
    verifyP256Signature(d.publicKey, nonceBytes, sigDer),
  );
  if (!matched) {
    return c.json({ error: "signature_invalid" }, 401);
  }

  recordDeviceSeen(deviceIdFor(matched.publicKey)); // 성공적 challenge-response = 방금 접속
  const { token, exp } = issueAttestToken(matched.publicKey);
  return c.json({ token, exp });
});
