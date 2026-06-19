/**
 * `routes/notify` 단위 테스트 — Discord webhook 설정 저장/조회.
 *
 * 검증 대상:
 *  - webhookUrl 키 생략 = 기존 URL 유지 (UI 가 저장 후 입력칸을 비우는 redact 정책 지원)
 *  - webhookUrl 빈값 = 설정 해제 (기존 동작 보존)
 *  - deepLinkBaseUrl 저장(정규화) / 빈값 → 기본 복귀 / 잘못된 값 → 400
 *  - GET 이 deepLinkBaseUrl(평문) + deepLinkBaseUrlDefault 를 반환
 *
 * 격리 전략: sessions.test.ts 와 동일 — `../config.js` 를 tmpdir 파일로 mock.
 * `../notify/index.js` 는 stub (db/ws 를 끌고 오는 dispatchTestNotification 차단).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs";

const H = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fsH = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const osH = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pathH = require("node:path") as typeof import("node:path");
  const dir = fsH.mkdtempSync(pathH.join(osH.tmpdir(), "ps-notify-test-"));
  return { tmpDir: dir, configFile: pathH.join(dir, "config.json") };
});

vi.mock("../config.js", () => ({
  CONFIG_DIR: H.tmpDir,
  CONFIG_FILE: H.configFile,
  ensureConfigDir: () => {
    fs.mkdirSync(H.tmpDir, { recursive: true });
  },
  readConfig: () => {
    try {
      return JSON.parse(fs.readFileSync(H.configFile, "utf8"));
    } catch {
      return null;
    }
  },
  writeConfig: (cfg: unknown) => {
    fs.writeFileSync(H.configFile, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  },
}));

vi.mock("../notify/index.js", () => ({
  dispatchTestNotification: vi.fn(async () => ({ ok: true, status: 204 })),
}));

import { notify } from "./notify.js";
import { hashToken, invalidateAuthCache } from "../auth.js";
import { readConfig } from "../config.js";
import { DEFAULT_DEEP_LINK_BRIDGE_BASE } from "../notify/discord.js";

const TOKEN = "test-token";
const WEBHOOK = "https://discord.com/api/webhooks/123456789/abcDEF-_123";
const BRIDGE = "https://someone.github.io/my-bridge/open";

function baseConfig() {
  return { port: 7777, tokenHash: hashToken(TOKEN), createdAt: 0 };
}

function writeConfigFile(cfg: unknown) {
  fs.writeFileSync(H.configFile, JSON.stringify(cfg));
}

async function post(path: string, body: unknown): Promise<Response> {
  return notify.request(path, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function getConfig(): Promise<Response> {
  return notify.request("/config", { headers: { Authorization: `Bearer ${TOKEN}` } });
}

beforeEach(() => {
  writeConfigFile(baseConfig());
  invalidateAuthCache();
});

describe("POST /config — webhookUrl", () => {
  it("설정 + deepLinkBaseUrl 저장 (끝 슬래시 정규화)", async () => {
    const res = await post("/config", {
      discord: { webhookUrl: WEBHOOK, enabled: true, deepLinkBaseUrl: `${BRIDGE}/` },
    });
    expect(res.status).toBe(200);
    const saved = readConfig()?.notify?.discord;
    expect(saved?.webhookUrl).toBe(WEBHOOK);
    expect(saved?.deepLinkBaseUrl).toBe(BRIDGE);
  });

  it("키 생략 = 기존 URL 유지한 채 나머지만 갱신", async () => {
    await post("/config", { discord: { webhookUrl: WEBHOOK, enabled: true } });
    const res = await post("/config", {
      discord: { enabled: false, deepLinkBaseUrl: BRIDGE }, // webhookUrl 키 없음
    });
    expect(res.status).toBe(200);
    const saved = readConfig()?.notify?.discord;
    expect(saved?.webhookUrl).toBe(WEBHOOK); // 유지
    expect(saved?.enabled).toBe(false);
    expect(saved?.deepLinkBaseUrl).toBe(BRIDGE);
  });

  it("빈값 = 설정 해제 (기존 동작 보존)", async () => {
    await post("/config", { discord: { webhookUrl: WEBHOOK } });
    const res = await post("/config", { discord: { webhookUrl: "" } });
    expect(res.status).toBe(200);
    expect(readConfig()?.notify?.discord).toBeUndefined();
  });
});

describe("POST /config — includePreview (프라이버시 옵트인)", () => {
  it("기본 OFF — 미설정이면 GET 이 false", async () => {
    await post("/config", { discord: { webhookUrl: WEBHOOK } });
    const body = (await (await getConfig()).json()) as {
      discord: { includePreview: boolean };
    };
    expect(body.discord.includePreview).toBe(false);
    expect(readConfig()?.notify?.discord?.includePreview).toBeUndefined();
  });

  it("켜면 저장되고 GET 이 true", async () => {
    await post("/config", { discord: { webhookUrl: WEBHOOK, includePreview: true } });
    expect(readConfig()?.notify?.discord?.includePreview).toBe(true);
    const body = (await (await getConfig()).json()) as {
      discord: { includePreview: boolean };
    };
    expect(body.discord.includePreview).toBe(true);
  });

  it("includePreview 만 부분 POST 해도 기존 events 가 지워지지 않는다", async () => {
    await post("/config", {
      discord: { webhookUrl: WEBHOOK, events: { turnComplete: false } },
    });
    // webhookUrl·events 키 없이 includePreview 만 토글.
    await post("/config", { discord: { includePreview: true } });
    const saved = readConfig()?.notify?.discord;
    expect(saved?.webhookUrl).toBe(WEBHOOK); // 유지
    expect(saved?.events?.turnComplete).toBe(false); // 유지
    expect(saved?.includePreview).toBe(true);
  });

  it("끄면(false) 필드가 제거된다 (= OFF)", async () => {
    await post("/config", { discord: { webhookUrl: WEBHOOK, includePreview: true } });
    await post("/config", { discord: { includePreview: false } });
    expect(readConfig()?.notify?.discord?.includePreview).toBeUndefined();
  });

  it("키 생략이면 기존 includePreview 유지", async () => {
    await post("/config", { discord: { webhookUrl: WEBHOOK, includePreview: true } });
    await post("/config", { discord: { enabled: true } });
    expect(readConfig()?.notify?.discord?.includePreview).toBe(true);
  });
});

describe("POST /config — deepLinkBaseUrl", () => {
  it("빈값이면 기본 페이지로 복귀 (필드 제거)", async () => {
    await post("/config", { discord: { webhookUrl: WEBHOOK, deepLinkBaseUrl: BRIDGE } });
    await post("/config", { discord: { deepLinkBaseUrl: "" } });
    const saved = readConfig()?.notify?.discord;
    expect(saved?.webhookUrl).toBe(WEBHOOK);
    expect(saved?.deepLinkBaseUrl).toBeUndefined();
  });

  it("키 생략이면 기존 브리지 URL 유지", async () => {
    await post("/config", { discord: { webhookUrl: WEBHOOK, deepLinkBaseUrl: BRIDGE } });
    await post("/config", { discord: { enabled: true } });
    expect(readConfig()?.notify?.discord?.deepLinkBaseUrl).toBe(BRIDGE);
  });

  it("http / query·fragment 포함 → 400 invalid_deep_link_url", async () => {
    for (const bad of ["http://x.github.io/open", `${BRIDGE}?a=b`, `${BRIDGE}#f`, "garbage"]) {
      const res = await post("/config", {
        discord: { webhookUrl: WEBHOOK, deepLinkBaseUrl: bad },
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("invalid_deep_link_url");
    }
  });
});

describe("GET /config", () => {
  it("deepLinkBaseUrl(평문) + 기본값을 반환", async () => {
    await post("/config", { discord: { webhookUrl: WEBHOOK, deepLinkBaseUrl: BRIDGE } });
    const res = await getConfig();
    const body = (await res.json()) as {
      discord: { deepLinkBaseUrl: string | null; deepLinkBaseUrlDefault: string };
    };
    expect(body.discord.deepLinkBaseUrl).toBe(BRIDGE);
    expect(body.discord.deepLinkBaseUrlDefault).toBe(DEFAULT_DEEP_LINK_BRIDGE_BASE);
  });

  it("미설정이면 deepLinkBaseUrl null", async () => {
    const res = await getConfig();
    const body = (await res.json()) as { discord: { deepLinkBaseUrl: string | null } };
    expect(body.discord.deepLinkBaseUrl).toBeNull();
  });
});

describe("POST /test — deepLinkBaseUrl override", () => {
  it("저장 전 값으로 테스트 발사 (검증 통과 시 dispatch 에 전달)", async () => {
    const { dispatchTestNotification } = await import("../notify/index.js");
    const res = await post("/test", { webhookUrl: WEBHOOK, deepLinkBaseUrl: `${BRIDGE}/` });
    expect(res.status).toBe(200);
    expect(dispatchTestNotification).toHaveBeenCalledWith(WEBHOOK, BRIDGE);
  });

  it("잘못된 브리지 URL → 400 (발사 안 함)", async () => {
    const res = await post("/test", { webhookUrl: WEBHOOK, deepLinkBaseUrl: "http://x" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_deep_link_url");
  });
});
