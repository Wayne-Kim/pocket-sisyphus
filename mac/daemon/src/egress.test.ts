// Egress confinement 계약 테스트 — LAN 전용 모드 ON 에서 비-LAN outbound 호출 0.
//
// 위협(§5.11): 사용자가 «외부 차단» 으로 믿는데 daemon 이 조용히 ipify·ASC·Discord 로 나간다.
// 이 테스트가 모드 ON 에서 echo/UPnP/ASC/Discord outbound 가 «하나도» 일어나지 않음을 단언하고,
// 모드 OFF 에선 기존 동작이 그대로(회귀 0)임을 단언한다.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  guardNonLanEgress,
  isLanOnlyMode,
  setLanOnlyModeOverride,
} from "./egress.js";
import { getExternalIPv4, invalidateExternalIPv4Cache } from "./nat/external-ip.js";
import { tryMapSSHPort, tryUnmapSSHPort } from "./nat/port-mapping.js";
import { ascGet, ascPost } from "./po/asc.js";
import { checkAscForCollect } from "./po/asc-check.js";
import { postDiscordWebhook } from "./notify/discord.js";

const DUMMY_ASC = { keyId: "K", issuerId: "I", privateKeyPem: "pem-not-used-when-blocked" };

describe("egress gate — LAN 전용 모드 ON", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    setLanOnlyModeOverride(true);
    invalidateExternalIPv4Cache();
    // 어떤 비-LAN outbound 도 fetch 까지 가면 안 된다 — 가면 테스트 실패.
    fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("fetch 가 호출되면 안 된다 (LAN 전용 모드)"));
  });

  afterEach(() => {
    setLanOnlyModeOverride(null);
    fetchSpy.mockRestore();
    invalidateExternalIPv4Cache();
  });

  it("isLanOnlyMode 가 true", () => {
    expect(isLanOnlyMode()).toBe(true);
    expect(guardNonLanEgress("x")).toBe(true);
  });

  it("external-ip echo: 호출 skip, none(null) 반환, fetch 0", async () => {
    const ip = await getExternalIPv4();
    expect(ip).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("UPnP/NAT-PMP map/unmap: 시도 중단, 매핑 실패 반환", async () => {
    const r = await tryMapSSHPort(22022);
    expect(r.protocol).toBeNull();
    expect(r.externalIPv4).toBeNull();
    expect(r.error).toMatch(/lan-only/);
    await expect(tryUnmapSSHPort(22022)).resolves.toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("ASC GET/POST: 모드와 충돌 throw, fetch 0", async () => {
    await expect(ascGet(DUMMY_ASC, "/v1/apps")).rejects.toThrow(/LAN 전용 모드와 충돌/);
    await expect(ascPost(DUMMY_ASC, "/v1/x", {})).rejects.toThrow(/LAN 전용 모드와 충돌/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("ASC 가용성 프로브: outbound 없이 null(불확실) — 거짓 «키 만료» 경고 안 띄움", async () => {
    const check = await checkAscForCollect("123456789", DUMMY_ASC);
    expect(check).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("Discord webhook: 알림 outbound 차단, fetch 0", async () => {
    const res = await postDiscordWebhook("https://discord.com/api/webhooks/x/y", {
      username: "t",
      embeds: [],
    });
    expect(res.ok).toBe(false);
    expect(res.detail).toMatch(/lan-only/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("egress gate — 모드 OFF 회귀 0", () => {
  afterEach(() => {
    setLanOnlyModeOverride(null);
  });

  it("guardNonLanEgress 가 false — 평소대로 진행(부작용 0)", () => {
    setLanOnlyModeOverride(false);
    expect(isLanOnlyMode()).toBe(false);
    expect(guardNonLanEgress("external-ip echo")).toBe(false);
  });

  it("모드 OFF 면 external-ip echo 가 실제 fetch 경로를 탄다", async () => {
    setLanOnlyModeOverride(false);
    invalidateExternalIPv4Cache();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("203.0.113.7"));
    try {
      const ip = await getExternalIPv4();
      expect(ip).toBe("203.0.113.7");
      expect(fetchSpy).toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      invalidateExternalIPv4Cache();
    }
  });
});
