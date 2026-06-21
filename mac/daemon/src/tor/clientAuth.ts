// Tor v3 hidden service Client Authorization 헬퍼.
//
// 목적: .onion 주소가 어디서 새도 x25519 client-auth 키 없는 사람은 디스크립터를
// 풀 수 없어 introduction points 조차 발견 못 한다 → HTTP 인증 경계까지 도달 불가.
//
// 파일 배치:
//  - <TOR_DIR>/client_auth.jwk         서버 보관용 keypair (JWK, 0600)
//  - <HS_DIR>/authorized_clients/<n>.auth   pub 키 한 줄짜리 파일 (Tor 요구 포맷)
//
// 클라이언트(폰)는 priv 키 base32 한 줄을 페어링 QR 로 전달받아
// `<onion>:descriptor:x25519:<priv-b32>` 형태의 .auth_private 파일을 작성한다.
//
// 키는 영구 — 한번 생성하면 페어링 재발급 시까지 재사용. onion 주소처럼 안정적.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type ClientAuthKeypair = {
  /** 32B x25519 public key, base32(RFC4648, no padding, uppercase) */
  pubB32: string;
  /** 32B x25519 private key, base32(RFC4648, no padding, uppercase) */
  privB32: string;
};

type Jwk = {
  kty: "OKP";
  crv: "X25519";
  x: string; // base64url, 32B pub
  d: string; // base64url, 32B priv
};

const RFC4648_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32, uppercase, no padding. Tor 가 받아들이는 정확한 포맷. */
export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += RFC4648_ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += RFC4648_ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  return out;
}

function b64urlToBuf(s: string): Buffer {
  return Buffer.from(s, "base64url");
}

function generateJwk(): Jwk {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("x25519");
  const pubJwk = publicKey.export({ format: "jwk" }) as { x: string };
  const privJwk = privateKey.export({ format: "jwk" }) as { d: string };
  return {
    kty: "OKP",
    crv: "X25519",
    x: pubJwk.x,
    d: privJwk.d,
  };
}

function jwkToKeypair(jwk: Jwk): ClientAuthKeypair {
  const pub = b64urlToBuf(jwk.x);
  const priv = b64urlToBuf(jwk.d);
  if (pub.length !== 32 || priv.length !== 32) {
    throw new Error(
      `client auth keypair length mismatch: pub=${pub.length} priv=${priv.length}`,
    );
  }
  return { pubB32: base32Encode(pub), privB32: base32Encode(priv) };
}

/**
 * `<TOR_DIR>/client_auth.jwk` 에 keypair 가 없으면 생성, 있으면 로드.
 * 파일은 0600. 이후 .auth / .auth_private 작성에 사용.
 */
export function ensureClientAuthKeypair(torDir: string): ClientAuthKeypair {
  const jwkFile = path.join(torDir, "client_auth.jwk");
  if (fs.existsSync(jwkFile)) {
    try {
      const jwk = JSON.parse(fs.readFileSync(jwkFile, "utf8")) as Jwk;
      if (jwk.kty === "OKP" && jwk.crv === "X25519" && jwk.x && jwk.d) {
        return jwkToKeypair(jwk);
      }
    } catch {
      // fall through — 재생성
    }
  }
  const jwk = generateJwk();
  fs.writeFileSync(jwkFile, JSON.stringify(jwk), { mode: 0o600 });
  return jwkToKeypair(jwk);
}

/**
 * `<HS_DIR>/authorized_clients/<nickname>.auth` 를 쓴다.
 * 이 파일이 하나라도 존재하면 Tor 는 client-auth 를 강제하기 시작한다
 * (= 키 없는 클라이언트는 디스크립터 자체를 복호화 못 함).
 */
export function writeAuthorizedClient(
  hsDir: string,
  nickname: string,
  pubB32: string,
): void {
  const dir = path.join(hsDir, "authorized_clients");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const file = path.join(dir, `${nickname}.auth`);
  fs.writeFileSync(file, `descriptor:x25519:${pubB32}\n`, { mode: 0o600 });
}
