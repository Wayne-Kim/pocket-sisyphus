import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { checkAscForCollect } from "./asc-check.js";
import { setLanOnlyModeOverride } from "../egress.js";
import type { AscConfig } from "../config.js";

/** 테스트용 EC P-256 키 — makeAscJwt 가 throw 하지 않게 (저장 시 검증을 통과한 정상 키 흉내). */
function makeTestAsc(): AscConfig {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    keyId: "KEY123",
    issuerId: "issuer-uuid",
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

/** fetch 를 한 번 stub — status 만 흉내 (본문은 안 읽으므로 빈 Response). */
function stubFetch(impl: () => Promise<Response> | Response): void {
  vi.stubGlobal("fetch", vi.fn(impl));
}

afterEach(() => {
  vi.unstubAllGlobals();
  // egress 모드 오버라이드 해제 — 다음 파일/테스트가 ambient config 를 보게 되돌린다.
  setLanOnlyModeOverride(null);
});

beforeEach(() => {
  // ASC 프로브 시나리오(200/401/403/5xx/네트워크)는 «LAN 전용 모드 OFF» 를 전제로 한다.
  // 이걸 고정하지 않으면 머신의 실제 config.json(lanOnly:true)에서 guardNonLanEgress 가
  // outbound 를 차단 → 모든 프로브가 «uncertain(null)» 이 돼 401/403 음성 판정 테스트가 깨진다.
  setLanOnlyModeOverride(false);
});

describe("checkAscForCollect", () => {
  it("ASC 신호가 꺼져 있으면(appId 없음) enabled=false — 키 프로브 없이 침묵", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const result = await checkAscForCollect(null, makeTestAsc());
    expect(result).toEqual({ enabled: false, keyConfigured: false, reachable: false });
    // 꺼져 있으면 네트워크 호출 자체를 안 한다.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("공백 appId 도 꺼짐으로 취급한다", async () => {
    const result = await checkAscForCollect("   ", makeTestAsc());
    expect(result?.enabled).toBe(false);
  });

  it("appId 는 있는데 키가 없으면 keyConfigured=false (확정 음성, 네트워크 호출 없음)", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const result = await checkAscForCollect("123456", undefined);
    expect(result).toEqual({ enabled: true, keyConfigured: false, reachable: false });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("키로 인증 성공(200)이면 reachable=true — 정상, 안내 안 띄움", async () => {
    stubFetch(() => new Response("{}", { status: 200 }));
    const result = await checkAscForCollect("123456", makeTestAsc());
    expect(result).toEqual({ enabled: true, keyConfigured: true, reachable: true });
  });

  it("401(만료·폐기)은 확정 음성 reachable=false", async () => {
    stubFetch(() => new Response("", { status: 401 }));
    const result = await checkAscForCollect("123456", makeTestAsc());
    expect(result).toEqual({ enabled: true, keyConfigured: true, reachable: false });
  });

  it("403(권한 부족)도 확정 음성 reachable=false", async () => {
    stubFetch(() => new Response("", { status: 403 }));
    const result = await checkAscForCollect("123456", makeTestAsc());
    expect(result?.reachable).toBe(false);
  });

  it("5xx(Apple 쪽 일시 문제)는 불확실 → null (거짓 경고 방지)", async () => {
    stubFetch(() => new Response("", { status: 503 }));
    const result = await checkAscForCollect("123456", makeTestAsc());
    expect(result).toBeNull();
  });

  it("네트워크 장애/타임아웃은 불확실 → null (일시 blip 을 키 만료로 오인 금지)", async () => {
    stubFetch(() => {
      throw new Error("fetch failed");
    });
    const result = await checkAscForCollect("123456", makeTestAsc());
    expect(result).toBeNull();
  });
});
