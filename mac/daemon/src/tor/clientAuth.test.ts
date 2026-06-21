// Tor v3 client-auth base32 인코더 단위 테스트 — THREAT_MODEL keystone.
//
// base32Encode 는 결정적 순수 함수다. .auth / .auth_private 파일에 박히는 x25519 키를
// «정확히» 인코딩해야 한다 — 알파벳/패딩이 한 글자만 틀려도 Tor 가 키를 거부하거나(페어링
// 깨짐), 더 위험하게는 다른 키로 조용히 인코딩돼 인증 경계가 약해진다. 그래서 RFC 4648 §10
// 공식 테스트 벡터에 정확히 일치하는지(+ 무패딩/대문자/길이 불변식) 를 못으로 박는다.

import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { base32Encode, ensureClientAuthKeypair } from "./clientAuth.js";

// 구현이 쓰는 알파벳과 동일 (회귀 센티넬에서 «1글자 틀린» 대조군을 만들기 위해 복제).
const RFC4648_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

// 임의 알파벳으로 도는 base32 (구현과 같은 알고리즘) — 회귀 센티넬용.
function base32WithAlphabet(buf: Buffer, alphabet: string): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += alphabet[(value << (5 - bits)) & 0x1f];
  }
  return out;
}

describe("base32Encode — RFC 4648 §10 공식 테스트 벡터", () => {
  // RFC 4648 §10: BASE32(x) 의 표준 벡터 (단, 이 인코더는 무패딩이라 '=' 를 뗀 형태).
  const VECTORS: Array<[string, string]> = [
    ["", ""],
    ["f", "MY"],
    ["fo", "MZXQ"],
    ["foo", "MZXW6"],
    ["foob", "MZXW6YQ"],
    ["fooba", "MZXW6YTB"],
    ["foobar", "MZXW6YTBOI"],
  ];

  it.each(VECTORS)("BASE32(%j) === %j", (input, expected) => {
    expect(base32Encode(Buffer.from(input, "ascii"))).toBe(expected);
  });

  it("빈 버퍼는 빈 문자열", () => {
    expect(base32Encode(Buffer.alloc(0))).toBe("");
  });
});

describe("base32Encode — 5비트 패딩 경계 (입력 1·2·3·4·5바이트)", () => {
  // 출력 길이 = ceil(n*8/5). 1→2, 2→4, 3→5, 4→7, 5→8. 각 경계에서 패딩 없이 정확히.
  const BOUNDARY: Array<[number, number]> = [
    [1, 2],
    [2, 4],
    [3, 5],
    [4, 7],
    [5, 8],
  ];

  it.each(BOUNDARY)("%i바이트 입력 → %i글자 (무패딩)", (nbytes, outLen) => {
    const out = base32Encode(Buffer.alloc(nbytes, 0xab));
    expect(out).toHaveLength(outLen);
    expect(out).not.toContain("="); // 무패딩 불변식
    expect(out).toMatch(/^[A-Z2-7]*$/); // RFC4648 알파벳만
  });
});

describe("base32Encode — 32B 키 불변식 (대문자·무패딩·길이)", () => {
  // 32바이트 = 256비트 → ceil(256/5) = 52글자. client-auth x25519 키가 정확히 이 길이.
  it("32바이트 → 52글자, 대문자/무패딩/RFC 알파벳", () => {
    const out = base32Encode(Buffer.alloc(32, 0x5a));
    expect(out).toHaveLength(52);
    expect(out).not.toContain("=");
    expect(out).toBe(out.toUpperCase()); // 대문자 불변식
    expect(out).toMatch(/^[A-Z2-7]{52}$/); // 알파벳 + 길이 동시
  });

  it("all-zero 32B → 'A' 52개 (결정적)", () => {
    expect(base32Encode(Buffer.alloc(32, 0x00))).toBe("A".repeat(52));
  });

  it("all-ones 32B → '7' 51개 + 'Q' (마지막 1비트 잔여)", () => {
    expect(base32Encode(Buffer.alloc(32, 0xff))).toBe("7".repeat(51) + "Q");
  });
});

describe("base32Encode — 회귀 센티넬 (1글자 틀리면 빨갛게 잡힌다)", () => {
  it("알파벳을 1글자만(M→m) 틀면 RFC 벡터와 불일치 — 동등성 검사가 잡는다", () => {
    // index 12 의 'M' → 'm'. 'foobar' 의 첫 글자가 'M'(value 12)이라 출력이 바뀐다.
    const wrong = "ABCDEFGHIJKLmNOPQRSTUVWXYZ234567";
    expect(wrong).not.toBe(RFC4648_ALPHABET); // 단 한 글자 차이
    expect(base32WithAlphabet(Buffer.from("foobar"), wrong)).not.toBe("MZXW6YTBOI");
    // 대조군: «올바른» 알파벳이면 정확히 일치.
    expect(base32WithAlphabet(Buffer.from("foobar"), RFC4648_ALPHABET)).toBe(
      "MZXW6YTBOI",
    );
  });

  it("패딩을 붙인 변형은 무패딩 불변식과 불일치 — '=' 가 끼면 잡는다", () => {
    const padded = base32Encode(Buffer.from("f")) + "======"; // RFC 의 패딩형 'MY======'
    expect(padded).not.toBe(base32Encode(Buffer.from("f")));
    expect(base32Encode(Buffer.from("f"))).toBe("MY"); // 무패딩이 정답
  });
});

describe("ensureClientAuthKeypair — 생성·영속·잘못된 키 안전 복구", () => {
  let tmpDir: string;

  afterEach(() => {
    vi.restoreAllMocks();
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("빈 디렉터리면 keypair 생성 — pub/priv 가 유효한 base32(52글자·대문자·무패딩)", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ps-clientauth-"));
    const kp = ensureClientAuthKeypair(tmpDir);
    for (const key of [kp.pubB32, kp.privB32]) {
      expect(key).toMatch(/^[A-Z2-7]{52}$/);
      expect(key).not.toContain("=");
    }
    // 파일이 0600 (같은 머신의 다른 사용자/프로세스 차단) — 비밀 키이므로.
    const jwkFile = path.join(tmpDir, "client_auth.jwk");
    expect(fs.existsSync(jwkFile)).toBe(true);
    expect(fs.statSync(jwkFile).mode & 0o077).toBe(0); // group/other 접근 0
  });

  it("두 번째 호출은 같은 keypair 를 재사용한다 (키는 영구)", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ps-clientauth-"));
    const first = ensureClientAuthKeypair(tmpDir);
    const second = ensureClientAuthKeypair(tmpDir);
    expect(second).toEqual(first);
  });

  it("잘못된 base64url priv(길이≠32B) JWK 는 길이 불일치 키를 흘리지 않고 안전 재생성", () => {
    // 내부 길이 가드(jwkToKeypair) 가 «pub/priv != 32B» 를 throw 하지만, 로드 경로의
    // try/catch 가 그걸 잡아 «재생성» 으로 복구한다 → 호출자에게 throw 도, 길이 불일치
    // 키도 새어나가지 않는다. 인증 경계가 깨진 키로 조용히 약해지는 걸 막는 방어.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ps-clientauth-"));
    const jwkFile = path.join(tmpDir, "client_auth.jwk");
    // 스키마(kty/crv/x/d)는 갖췄지만 d 가 10바이트로 디코딩되는 «잘못된» priv 키.
    const badJwk = {
      kty: "OKP",
      crv: "X25519",
      x: Buffer.alloc(32).toString("base64url"), // 32B(정상)
      d: Buffer.alloc(10).toString("base64url"), // 10B(불량) → 길이 가드 발동
    };
    fs.writeFileSync(jwkFile, JSON.stringify(badJwk));

    let kp!: ReturnType<typeof ensureClientAuthKeypair>;
    expect(() => {
      kp = ensureClientAuthKeypair(tmpDir);
    }).not.toThrow();
    // 재생성된 키는 «유효한» 52글자 base32 (길이 불일치 키가 안 나온다).
    expect(kp.pubB32).toMatch(/^[A-Z2-7]{52}$/);
    expect(kp.privB32).toMatch(/^[A-Z2-7]{52}$/);
    // 불량 파일은 유효한 JWK 로 덮어써져, 두 번째 호출은 안정적으로 같은 키를 준다.
    expect(ensureClientAuthKeypair(tmpDir)).toEqual(kp);
  });

  it("깨진(non-JSON) JWK 파일도 throw 없이 안전 재생성", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ps-clientauth-"));
    fs.writeFileSync(path.join(tmpDir, "client_auth.jwk"), "}}garbage{{ not json");
    const kp = ensureClientAuthKeypair(tmpDir);
    expect(kp.pubB32).toMatch(/^[A-Z2-7]{52}$/);
    expect(kp.privB32).toMatch(/^[A-Z2-7]{52}$/);
  });
});
