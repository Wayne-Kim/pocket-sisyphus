// `routes/endpoint.ts` + `nat/lan-addr.ts` — LAN 전용(사설망 직결) 모드 단위 테스트.
//
// 핵심 계약:
//  - lan-addr: getLanHosts 가 사설/링크로컬만 고르고 글로벌은 거른다 (mocked getifaddrs).
//  - endpoint: 평소엔 direct_lan + 공인/onion 을 함께, lanOnly 면 direct_lan «만» 광고
//    (서버측 fail-closed — 공인 IPv4/IPv6·onion 을 후보에서 통째로 제거).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "node:os";
import { endpointRoute, type EndpointDeps } from "./endpoint.js";

vi.mock("../nat/external-ip.js", () => ({
  getExternalIPv4: vi.fn(async () => "203.0.113.5"),
  getGlobalIPv6: vi.fn(() => "2001:db8::1234"),
  getCachedExternalIPv4: vi.fn(() => ({ ipv4: "203.0.113.5", fetchedAt: 0 })),
}));

// /endpoint 는 endpointToken(=daemon token) bearer 를 요구한다(BL-04). auth.ts 의
// getCachedConfig → readConfig 가 매칭 tokenHash 를 돌려주도록 config 를 모킹한다.
const TOKEN = "test-endpoint-token";
const AUTH = { Authorization: `Bearer ${TOKEN}` };
vi.mock("../config.js", async (importActual) => {
  const actual = await importActual<typeof import("../config.js")>();
  const crypto = await import("node:crypto");
  // vi.mock 은 파일 최상단으로 호이스트되므로 위 TOKEN 상수를 참조할 수 없다 — 리터럴 고정.
  const tokenHash = crypto
    .createHash("sha256")
    .update("test-endpoint-token")
    .digest("hex");
  return { ...actual, readConfig: () => ({ tokenHash }) as never };
});

function baseDeps(over: Partial<EndpointDeps> = {}): EndpointDeps {
  return {
    getOnionAddress: () => "abc123.onion",
    getSshHostKeyFingerprint: () => "SHA256:test",
    getSshPort: () => 22022,
    getSshUser: () => "tester",
    getDaemonLocalPort: () => 7777,
    isIPv4Mapped: () => true,
    ...over,
  };
}

describe("nat/lan-addr getLanHosts", () => {
  afterEach(() => vi.restoreAllMocks());

  it("사설/링크로컬만 고르고 글로벌·loopback 은 거른다", async () => {
    vi.spyOn(os, "hostname").mockReturnValue("my-mac");
    vi.spyOn(os, "networkInterfaces").mockReturnValue({
      lo0: [
        { address: "127.0.0.1", family: "IPv4", internal: true } as os.NetworkInterfaceInfo,
      ],
      en0: [
        { address: "192.168.1.42", family: "IPv4", internal: false } as os.NetworkInterfaceInfo,
        { address: "203.0.113.9", family: "IPv4", internal: false } as os.NetworkInterfaceInfo, // 공인 → 제외
        { address: "2001:db8::5", family: "IPv6", internal: false } as os.NetworkInterfaceInfo, // 글로벌 → 제외
        { address: "fe80::1", family: "IPv6", internal: false } as os.NetworkInterfaceInfo, // link-local → 제외(scope 없음)
        { address: "fd00::99", family: "IPv6", internal: false } as os.NetworkInterfaceInfo, // unique-local → 포함
      ],
    } as unknown as ReturnType<typeof os.networkInterfaces>);

    const { getLanHosts } = await import("../nat/lan-addr.js");
    const hosts = getLanHosts().map((h) => h.host);
    expect(hosts).toContain("my-mac.local");
    expect(hosts).toContain("192.168.1.42");
    expect(hosts).toContain("fd00::99");
    expect(hosts).not.toContain("203.0.113.9");
    expect(hosts).not.toContain("2001:db8::5");
    expect(hosts).not.toContain("fe80::1");
  });
});

describe("routes/endpoint LAN 전용", () => {
  beforeEach(() => {
    vi.spyOn(os, "hostname").mockReturnValue("my-mac");
    vi.spyOn(os, "networkInterfaces").mockReturnValue({
      en0: [
        { address: "192.168.1.42", family: "IPv4", internal: false } as os.NetworkInterfaceInfo,
      ],
    } as unknown as ReturnType<typeof os.networkInterfaces>);
  });
  afterEach(() => vi.restoreAllMocks());

  it("bearer 토큰이 없으면 401 (BL-04 — 사용자명·공인 IP 노출 차단)", async () => {
    const app = endpointRoute(baseDeps());
    const res = await app.request("/endpoint");
    expect(res.status).toBe(401);
    const wrong = await app.request("/endpoint", {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(wrong.status).toBe(401);
  });

  it("기본(off): direct_lan + 공인/onion 을 함께 광고", async () => {
    const app = endpointRoute(baseDeps());
    const res = await app.request("/endpoint", { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { endpoints: { type: string }[] };
    const types = body.endpoints.map((e) => e.type);
    expect(types).toContain("direct_lan");
    expect(types).toContain("tor_onion");
    // 공인 채널(ipv4/ipv6) 중 적어도 하나 포함.
    expect(types.some((t) => t === "direct_ipv4" || t === "direct_ipv6")).toBe(true);
  });

  it("lanOnly: direct_lan «만» — 공인/onion 을 후보에서 제거 (fail-closed)", async () => {
    const app = endpointRoute(baseDeps({ isLanOnly: () => true }));
    const res = await app.request("/endpoint", { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { endpoints: { type: string; host: string }[] };
    const types = new Set(body.endpoints.map((e) => e.type));
    expect(types).toEqual(new Set(["direct_lan"]));
    expect(types.has("tor_onion")).toBe(false);
    expect(types.has("direct_ipv4")).toBe(false);
    expect(types.has("direct_ipv6")).toBe(false);
    // mDNS hostname 이 최우선(priority 0).
    const mdns = body.endpoints.find((e) => e.host === "my-mac.local");
    expect(mdns).toBeDefined();
  });
});
