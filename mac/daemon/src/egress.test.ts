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
import { ascGet, ascPost } from "./persona/asc.js";
import { checkAscForCollect } from "./persona/asc-check.js";
import { postDiscordWebhook } from "./notify/discord.js";
import {
  startDownload,
  getDownloadProgress,
  type DownloadDeps,
} from "./local-llm/download.js";
import { getCatalogModel } from "./local-llm/catalog.js";
import { makeCrashHandler, CRASH_EXIT_CODE } from "./logging/crash.js";
import { buildDiagnosticsBundle } from "./diagnostics.js";

const DUMMY_ASC = { keyId: "K", issuerId: "I", privateKeyPem: "pem-not-used-when-blocked" };

const DL_MODEL = getCatalogModel("qwen3-8b-q4")!;
const HUGE_FREE = DL_MODEL.fileSizeBytes + 100 * 1024 ** 3; // 디스크는 거부 사유가 아님(게이트가 먼저)

/** 다운로드 계약 테스트용 DownloadDeps — spawn/fetch 는 «호출되면 안 됨»을 카운트로 단언. */
function dlDeps(over: Partial<DownloadDeps>): DownloadDeps {
  return {
    existsSync: () => false,
    statSizeBytes: () => {
      throw new Error("nofile");
    },
    freeBytes: () => HUGE_FREE,
    mkdirp: () => {},
    unlink: () => {},
    hashFile: async () => "",
    resolveAria2: () => "/fake/aria2c",
    spawn: (() => {
      throw new Error("spawn 가 호출되면 안 된다 (LAN 전용 모드)");
    }) as unknown as DownloadDeps["spawn"],
    fetch: (async () => {
      throw new Error("fetch 가 호출되면 안 된다 (LAN 전용 모드)");
    }) as unknown as DownloadDeps["fetch"],
    modelsDir: "/fake/models",
    ...over,
  };
}

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

  it("모델 다운로드: outbound 거부(lan_only_mode), 실제 fetch 0 · aria2c spawn 0", async () => {
    let spawned = 0;
    let injectedFetch = 0;
    const deps = dlDeps({
      // aria2c 가 있는 환경이라도 spawn 까지 가면 안 된다(서브프로세스는 spawn 후엔 못 막음).
      spawn: (() => {
        spawned++;
        throw new Error("spawn 가 호출되면 안 된다");
      }) as unknown as DownloadDeps["spawn"],
      fetch: (async () => {
        injectedFetch++;
        throw new Error("fetch 가 호출되면 안 된다");
      }) as unknown as DownloadDeps["fetch"],
    });
    await expect(startDownload(DL_MODEL, deps)).rejects.toThrow(/lan_only_mode/);
    expect(spawned).toBe(0);
    expect(injectedFetch).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    // 부분 다운로드 방지 — 진행 상태가 downloading 으로도 안 넘어간다.
    expect(getDownloadProgress().state).not.toBe("downloading");
  });
});

// 크래시 로깅·진단 번들은 «사후 디버깅의 토대» 지만, LAN 전용·무텔레메트리 원칙상 어떤
// 자동 outbound 도 내선 안 된다(Sentry 등 외부 텔레메트리 금지). 여기서 크래시 핸들러와
// 진단 번들 조립이 «fetch 0» 임을 단언해, 향후 누군가 외부 전송을 끼워 넣으면 회귀로 잡힌다.
describe("egress gate — 크래시·진단 자동 outbound 0 (무텔레메트리)", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    setLanOnlyModeOverride(true);
    fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("fetch 가 호출되면 안 된다 (무텔레메트리)"));
  });

  afterEach(() => {
    setLanOnlyModeOverride(null);
    fetchSpy.mockRestore();
  });

  it("크래시 핸들러는 비정상 종료만 하고 어떤 outbound 도 내지 않는다", () => {
    const exit = vi.fn();
    const handler = makeCrashHandler({
      exit,
      // record/secrets 를 no-op 으로 주입 — 디스크 쓰기 없이 «outbound 0» 만 검증.
      record: () => {},
      context: () => ({
        instanceId: "t",
        bootPpid: 1,
        currentPpid: 1,
        pid: 1,
        lastChannelEvent: null,
      }),
      secrets: () => [],
    });
    handler("uncaughtException", new Error("boom"));
    expect(exit).toHaveBeenCalledWith(CRASH_EXIT_CODE);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("진단 번들 조립은 순수 로컬 읽기 — fetch 0", () => {
    const bundle = buildDiagnosticsBundle({ connectedClients: 0, torActive: false });
    expect(bundle.subsystem.daemonVersion).toBeTruthy();
    expect(Array.isArray(bundle.crashes)).toBe(true);
    expect(typeof bundle.unifiedLogTail).toBe("string");
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

  it("모드 OFF 면 모델 다운로드가 정상 경로(aria2c spawn)를 탄다 (회귀 0)", async () => {
    setLanOnlyModeOverride(false);
    let spawned = 0;
    const fakeProc = {
      on(ev: string, cb: (...a: unknown[]) => void) {
        if (ev === "exit") queueMicrotask(() => cb(0, null)); // aria2c 즉시 성공 종료
        return fakeProc;
      },
      kill() {},
    };
    const deps = dlDeps({
      spawn: (() => {
        spawned++;
        return fakeProc;
      }) as unknown as DownloadDeps["spawn"],
      hashFile: async () => DL_MODEL.sha256!, // 무결성 통과 → ready
    });
    await expect(startDownload(DL_MODEL, deps)).resolves.toBeUndefined();
    // fire-and-forget 본체(spawn→exit(0)→검증→ready)가 끝나도록 한 틱 양보.
    await new Promise((r) => setTimeout(r, 0));
    expect(spawned).toBe(1);
    expect(getDownloadProgress().state).toBe("ready");
  });
});
