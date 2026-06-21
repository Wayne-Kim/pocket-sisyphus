// 외부 IPv4 echo 파싱 + 캐시 TTL + IPv6 발견 단위 테스트.
//
// echo 응답은 외부 무료 endpoint 의 plain text 라 기형 입력이 흔하다. 핵심 계약:
//  - 정상 응답을 trim 해서 파싱하고, fallback 체인으로 한 endpoint 장애에 안 죽는다.
//  - 기형/빈 응답·네트워크 오류는 «throw 가 아니라 null» — 호출자(endpoint 라우트)가 죽지 않게.
//  - 캐시 TTL(5분)을 지켜 echo 트래픽을 줄이고, 전부 실패하면 stale 라도 마지막 IP 를 준다.
//  - IPv6 는 NAT 가 없어 로컬 글로벌 주소가 곧 외부 주소 — link/unique-local/loopback 은 제외.
//
// (LAN 전용 모드의 echo skip 은 egress.test.ts 가 담당하므로 여기선 게이트를 OFF 로 고정한다.)

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import {
  getExternalIPv4,
  invalidateExternalIPv4Cache,
  getCachedExternalIPv4,
  getGlobalIPv6,
} from "./external-ip.js";
import { setLanOnlyModeOverride } from "../egress.js";

const CACHE_TTL_MS = 5 * 60 * 1000;

function ipResponse(body: string, status = 200): Response {
  return new Response(body, { status });
}

beforeEach(() => {
  // egress 게이트 OFF — fetch 경로가 실제로 돌게(LAN 전용 모드 검증은 egress.test.ts).
  setLanOnlyModeOverride(false);
  invalidateExternalIPv4Cache();
  // echo 실패 경로의 console.warn 소음 억제.
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  setLanOnlyModeOverride(null);
  invalidateExternalIPv4Cache();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("getExternalIPv4 — 정상 파싱 / fallback 체인", () => {
  it("정상 echo 응답을 trim 해서 파싱한다", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(ipResponse("  203.0.113.7\n"));
    const ip = await getExternalIPv4();
    expect(ip).toBe("203.0.113.7");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("첫 endpoint 가 기형이면 다음으로 넘어가 성공한다 (fallback)", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(ipResponse("not-an-ip")) // ipify → 기형
      .mockResolvedValueOnce(ipResponse("198.51.100.4")); // ifconfig.me → 정상
    const ip = await getExternalIPv4();
    expect(ip).toBe("198.51.100.4");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("첫 endpoint 가 non-ok(500)면 다음으로 넘어간다", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(ipResponse("", 500))
      .mockResolvedValueOnce(ipResponse("198.51.100.4"));
    const ip = await getExternalIPv4();
    expect(ip).toBe("198.51.100.4");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("동시 호출은 inflight promise 를 공유 — echo 는 한 번만", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => ipResponse("203.0.113.7"));
    const [a, b] = await Promise.all([getExternalIPv4(), getExternalIPv4()]);
    expect(a).toBe("203.0.113.7");
    expect(b).toBe("203.0.113.7");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("getCachedExternalIPv4 가 캐시 상태를 반영한다", async () => {
    expect(getCachedExternalIPv4()).toBeNull(); // invalidate 직후
    vi.spyOn(globalThis, "fetch").mockResolvedValue(ipResponse("203.0.113.7"));
    await getExternalIPv4();
    expect(getCachedExternalIPv4()?.ipv4).toBe("203.0.113.7");
  });
});

describe("getExternalIPv4 — 실패는 throw 가 아니라 null", () => {
  it("모든 endpoint 가 기형이면 null (캐시 없음)", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => ipResponse("garbage"));
    const ip = await getExternalIPv4();
    expect(ip).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(3); // 3개 endpoint 전부 시도
  });

  it("빈 응답이면 null", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => ipResponse(""));
    expect(await getExternalIPv4()).toBeNull();
  });

  it("범위 밖 IPv4(999.x)는 기형으로 취급 → null", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      ipResponse("999.1.2.3"),
    );
    expect(await getExternalIPv4()).toBeNull();
  });

  it("네트워크 오류(fetch reject)에도 throw 하지 않고 null 을 resolve", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(getExternalIPv4()).resolves.toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });
});

describe("getExternalIPv4 — 캐시 TTL (5분)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("TTL 직전(만료 1ms 전)에는 캐시 재사용 — 재요청 0", async () => {
    vi.setSystemTime(1_000_000);
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => ipResponse("203.0.113.1"));
    expect(await getExternalIPv4()).toBe("203.0.113.1");

    vi.setSystemTime(1_000_000 + CACHE_TTL_MS - 1); // 만료 직전
    expect(await getExternalIPv4()).toBe("203.0.113.1");
    expect(fetchSpy).toHaveBeenCalledTimes(1); // 재요청 없음
  });

  it("TTL 도달(정확히 5분)하면 캐시 만료 → 재요청", async () => {
    vi.setSystemTime(2_000_000);
    let n = 0;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => ipResponse(n++ === 0 ? "203.0.113.1" : "203.0.113.9"));
    expect(await getExternalIPv4()).toBe("203.0.113.1");

    vi.setSystemTime(2_000_000 + CACHE_TTL_MS); // now-fetchedAt === TTL → (< TTL) false → 만료
    expect(await getExternalIPv4()).toBe("203.0.113.9");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("TTL 경과 후 전부 실패하면 stale 캐시(마지막 알려진 IP)를 반환", async () => {
    vi.setSystemTime(3_000_000);
    const ok = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => ipResponse("203.0.113.50"));
    expect(await getExternalIPv4()).toBe("203.0.113.50");
    ok.mockRestore();

    vi.setSystemTime(3_000_000 + CACHE_TTL_MS + 1); // 만료
    const fail = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("network down"));
    expect(await getExternalIPv4()).toBe("203.0.113.50"); // stale 라도 반환
    expect(fail).toHaveBeenCalledTimes(3);
  });
});

describe("getGlobalIPv6 — IPv6 전용 환경", () => {
  it("글로벌 IPv6 만 있는 환경에서 그 주소를 반환한다", () => {
    vi.spyOn(os, "networkInterfaces").mockReturnValue({
      en0: [
        { address: "2001:db8::1234", family: "IPv6", internal: false } as os.NetworkInterfaceInfo,
      ],
    } as unknown as ReturnType<typeof os.networkInterfaces>);
    expect(getGlobalIPv6()).toBe("2001:db8::1234");
  });

  it("link-local(fe80)/unique-local(fd)/loopback(::1)/internal/IPv4 는 제외 → null", () => {
    vi.spyOn(os, "networkInterfaces").mockReturnValue({
      lo0: [
        { address: "::1", family: "IPv6", internal: true } as os.NetworkInterfaceInfo,
      ],
      en0: [
        { address: "fe80::1", family: "IPv6", internal: false } as os.NetworkInterfaceInfo,
        { address: "fd00::99", family: "IPv6", internal: false } as os.NetworkInterfaceInfo,
        { address: "192.168.1.5", family: "IPv4", internal: false } as os.NetworkInterfaceInfo,
      ],
    } as unknown as ReturnType<typeof os.networkInterfaces>);
    expect(getGlobalIPv6()).toBeNull();
  });

  it("글로벌과 비-글로벌이 섞이면 글로벌만 채택", () => {
    vi.spyOn(os, "networkInterfaces").mockReturnValue({
      en0: [
        { address: "fe80::1", family: "IPv6", internal: false } as os.NetworkInterfaceInfo,
        { address: "2400:cb00:abcd::42", family: "IPv6", internal: false } as os.NetworkInterfaceInfo,
      ],
    } as unknown as ReturnType<typeof os.networkInterfaces>);
    expect(getGlobalIPv6()).toBe("2400:cb00:abcd::42");
  });
});
