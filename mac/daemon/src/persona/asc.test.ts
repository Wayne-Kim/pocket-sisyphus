import { describe, expect, it } from "vitest";
import { generateKeyPairSync, createPublicKey, verify } from "node:crypto";
import { makeAscJwt, validateAscKey } from "./asc.js";

/** 테스트용 P-256 키쌍 — ASC 의 .p8 과 같은 PKCS#8 PEM. */
function makeTestKey(): { pem: string; publicPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    pem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

describe("makeAscJwt", () => {
  it("header/payload 가 ASC 계약대로 — ES256, kid, aud, 15분 만료", () => {
    const { pem } = makeTestKey();
    const jwt = makeAscJwt(
      { keyId: "KEY123", issuerId: "issuer-uuid", privateKeyPem: pem },
      1_700_000_000_000,
    );
    const [h, p, s] = jwt.split(".");
    const header = JSON.parse(Buffer.from(h, "base64url").toString());
    const payload = JSON.parse(Buffer.from(p, "base64url").toString());
    expect(header).toEqual({ alg: "ES256", kid: "KEY123", typ: "JWT" });
    expect(payload.iss).toBe("issuer-uuid");
    expect(payload.aud).toBe("appstoreconnect-v1");
    expect(payload.iat).toBe(1_700_000_000);
    expect(payload.exp).toBe(1_700_000_000 + 900);
    // JWT 의 ES256 서명은 raw r||s 64바이트 (DER 아님).
    expect(Buffer.from(s, "base64url").length).toBe(64);
  });

  it("서명이 같은 키의 공개키로 검증된다", () => {
    const { pem, publicPem } = makeTestKey();
    const jwt = makeAscJwt({ keyId: "K", issuerId: "I", privateKeyPem: pem });
    const [h, p, s] = jwt.split(".");
    const ok = verify(
      "sha256",
      Buffer.from(`${h}.${p}`),
      { key: createPublicKey(publicPem), dsaEncoding: "ieee-p1363" },
      Buffer.from(s, "base64url"),
    );
    expect(ok).toBe(true);
  });
});

describe("validateAscKey", () => {
  it("정상 EC P-256 키 → null (통과)", () => {
    const { pem } = makeTestKey();
    expect(validateAscKey({ keyId: "K", issuerId: "I", privateKeyPem: pem })).toBeNull();
  });

  it("keyId/issuerId 누락 거절", () => {
    const { pem } = makeTestKey();
    expect(validateAscKey({ keyId: "", issuerId: "I", privateKeyPem: pem })).toContain("누락");
  });

  it("PEM 아닌 내용 거절", () => {
    expect(
      validateAscKey({ keyId: "K", issuerId: "I", privateKeyPem: "not a pem" }),
    ).toContain("p8 파싱 실패");
  });

  it("EC 아닌 키(RSA) 거절", () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const rsaPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    expect(validateAscKey({ keyId: "K", issuerId: "I", privateKeyPem: rsaPem })).toContain(
      "EC 키가 아님",
    );
  });
});
