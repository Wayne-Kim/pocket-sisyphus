// v=3 페어링 페이로드 계약 테스트 — 폰↔Mac 계약.
//
// buildPairingPayload 의 출력은 iOS 앱이 파싱하는 «계약» 이다. 필드명 한 개·버전 상수 한 개가
// 바뀌면 구버전 폰이 페어링을 못 푼다. 그래서 (1) v=3 상수, (2) 필수 필드 «정확한 집합»,
// (3) 입력→출력 매핑 을 못으로 박아 둔다 — 계약을 바꾸면 이 테스트가 빨갛게 잡아 «iOS 도
// 같이 고쳐야 한다» 는 회귀 알람이 울린다.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "node:os";
import { buildPairingPayload, type PairingPayloadInput } from "./pairing.js";

function fullInput(over: Partial<PairingPayloadInput> = {}): PairingPayloadInput {
  return {
    onion: "abc123def456ghi789.onion",
    daemonToken: "daemon-bearer-token",
    endpointToken: "endpoint-bearer-token",
    clientAuthPriv: "MZXW6YTBOIMZXW6YTBOIMZXW6YTBOIMZXW6YTBOIMZXW6YTBOIQQ",
    sshHostKeyFingerprint: "SHA256:abcdEF0123456789",
    sshHostKeyLine: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA mac",
    sshClientPrivBase64: "LS0tLS1CRUdJTiBPUEVOU1NIIFBSSVZBVEUgS0VZ",
    sshUser: "pocket",
    sshPort: 22022,
    daemonPort: 7777,
    ...over,
  };
}

// v=3 스키마가 «반드시 가져야 하고, 그 이상도 이하도 아닌» 키 집합.
const V3_KEYS = [
  "v",
  "onion",
  "onion_auth",
  "endpoint_token",
  "daemon_token",
  "ssh_host_key_fingerprint",
  "ssh_host_key",
  "ssh_client_priv",
  "ssh_user",
  "lan_host",
  "ssh_port",
  "daemon_port",
  "name",
].sort();

describe("buildPairingPayload — v=3 계약", () => {
  beforeEach(() => {
    // lan_host / name fallback 이 os.hostname 에 의존하므로 결정적으로 고정.
    vi.spyOn(os, "hostname").mockReturnValue("my-mac.local");
  });
  afterEach(() => vi.restoreAllMocks());

  it("유효한 JSON 을 만든다", () => {
    expect(() => JSON.parse(buildPairingPayload(fullInput()))).not.toThrow();
  });

  it("버전 상수 v === 3 (버전이 바뀌면 이 테스트가 계약 회귀로 잡는다)", () => {
    const p = JSON.parse(buildPairingPayload(fullInput()));
    expect(p.v).toBe(3);
  });

  it("필드 집합이 v=3 스키마와 정확히 일치 — 필드 추가/삭제가 회귀로 잡힌다", () => {
    const p = JSON.parse(buildPairingPayload(fullInput()));
    expect(Object.keys(p).sort()).toEqual(V3_KEYS);
  });

  it("입력→출력 매핑이 정확하다", () => {
    const input = fullInput();
    const p = JSON.parse(buildPairingPayload(input));
    expect(p.onion).toBe(input.onion);
    expect(p.onion_auth).toBe(input.clientAuthPriv);
    expect(p.endpoint_token).toBe(input.endpointToken);
    expect(p.daemon_token).toBe(input.daemonToken);
    expect(p.ssh_host_key_fingerprint).toBe(input.sshHostKeyFingerprint);
    expect(p.ssh_host_key).toBe(input.sshHostKeyLine);
    expect(p.ssh_client_priv).toBe(input.sshClientPrivBase64);
    expect(p.ssh_user).toBe(input.sshUser);
    expect(p.ssh_port).toBe(input.sshPort);
    expect(p.daemon_port).toBe(input.daemonPort);
  });

  it("포트는 number, 토큰은 string 타입", () => {
    const p = JSON.parse(buildPairingPayload(fullInput()));
    expect(typeof p.ssh_port).toBe("number");
    expect(typeof p.daemon_port).toBe("number");
    expect(typeof p.daemon_token).toBe("string");
    expect(typeof p.endpoint_token).toBe("string");
  });

  it("name 미지정 시 hostname 에서 .local 을 떼고, lan_host 는 .local 그대로", () => {
    const p = JSON.parse(buildPairingPayload(fullInput({ name: undefined })));
    expect(p.name).toBe("my-mac");
    expect(p.lan_host).toBe("my-mac.local");
  });

  it("name 지정 시 그 값을 그대로 쓴다", () => {
    const p = JSON.parse(buildPairingPayload(fullInput({ name: "Wayne's Mac" })));
    expect(p.name).toBe("Wayne's Mac");
  });
});
