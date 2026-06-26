// 비밀 마스킹 단위 테스트 — 크래시 로그·진단 번들로 «밖에 나갈 수 있는» 텍스트에서
// 토큰·키·웹훅 URL 이 가려지되, 비-비밀(스택 프레임)은 보존됨을 단언한다.

import { describe, expect, it } from "vitest";
import { maskSecrets } from "./redact.js";

describe("maskSecrets — 패턴 기반", () => {
  it("Discord webhook 토큰을 가린다(id 는 남김)", () => {
    const url =
      "https://discord.com/api/webhooks/123456789012345678/AbC-dEf_GhIjKlMnOpQrStUvWxYz0123456789";
    const masked = maskSecrets(`POST ${url} failed`);
    expect(masked).toContain("discord.com/api/webhooks/123456789012345678/***");
    expect(masked).not.toContain("AbC-dEf_GhIjKlMnOpQrStUvWxYz0123456789");
  });

  it("Authorization: Bearer 토큰을 가린다", () => {
    const masked = maskSecrets("Authorization: Bearer abc123DEF456ghi789._-=");
    expect(masked).toBe("Authorization: Bearer ***");
  });

  it("PEM 개인키 본문을 가린다(머리·꼬리 보존)", () => {
    const pem =
      "-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASC\nQ==\n-----END PRIVATE KEY-----";
    const masked = maskSecrets(`key=\n${pem}`);
    expect(masked).toContain("-----BEGIN PRIVATE KEY-----");
    expect(masked).toContain("-----END PRIVATE KEY-----");
    expect(masked).not.toContain("MIIEvgIBADANBgkqhkiG9w0BAQEFAASC");
  });

  it("secret-keyed JSON 값을 가린다", () => {
    const json = '{"token":"super-secret-value-123","port":7777}';
    const masked = maskSecrets(json);
    expect(masked).toContain('"token":"***"');
    expect(masked).toContain('"port":7777');
    expect(masked).not.toContain("super-secret-value-123");
  });

  it("쿼리스트링 token=… 을 가린다", () => {
    const masked = maskSecrets("ws://127.0.0.1:7777/ws?token=deadbeefcafelongtoken&x=1");
    expect(masked).toContain("token=***");
    expect(masked).toContain("x=1");
    expect(masked).not.toContain("deadbeefcafelongtoken");
  });

  it('"secret." 접두 JSON 키(공인 IP·onion)를 가린다', () => {
    const line =
      '{"event.action":"nat.external_ip.resolve","secret.external_ipv4":"203.0.113.7"}';
    const masked = maskSecrets(line);
    expect(masked).toContain('"secret.external_ipv4":"***"');
    expect(masked).not.toContain("203.0.113.7");
    expect(masked).toContain('"event.action":"nat.external_ip.resolve"');

    const onion = '{"secret.onion.address":"abcdef0123456789.onion"}';
    const maskedOnion = maskSecrets(onion);
    expect(maskedOnion).toContain('"secret.onion.address":"***"');
    expect(maskedOnion).not.toContain("abcdef0123456789.onion");
  });

  it("비-비밀 스택 프레임은 보존한다", () => {
    const stack =
      "Error: boom\n    at start (/Users/x/mac/daemon/src/server.ts:42:7)\n    at run (/Users/x/index.ts:10:1)";
    expect(maskSecrets(stack)).toBe(stack);
  });
});

describe("maskSecrets — 아는 비밀 literal 치환", () => {
  it("config 에서 읽은 토큰 값을 통째로 가린다", () => {
    const secret = "Hm6K2pLq9XyZ-abc_DEF_456token"; // ≥ 8자
    const text = `boot ok; daemonToken=${secret} bound`;
    const masked = maskSecrets(text, [secret]);
    expect(masked).not.toContain(secret);
    expect(masked).toContain("***");
  });

  it("8자 미만 «비밀» 은 본문 오염 방지를 위해 치환하지 않는다", () => {
    const text = "the cat sat on the mat";
    // "cat"(3자) 를 비밀로 줘도 무시 → 본문 그대로.
    expect(maskSecrets(text, ["cat"])).toBe(text);
  });

  it("부분문자열 누락 방지 — 긴 비밀 먼저 치환", () => {
    const short = "tokenABCD"; // 9자
    const long = "tokenABCDEFGHIJ"; // 15자, short 를 포함
    const masked = maskSecrets(`a=${long} b=${short}`, [short, long]);
    expect(masked).not.toContain(short);
    expect(masked).not.toContain(long);
  });
});
