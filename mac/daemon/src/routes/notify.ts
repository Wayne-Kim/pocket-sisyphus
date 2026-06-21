/**
 * 알림 채널 설정 라우트 — Mac 앱의 «Discord 알림 설정» 창(과 이후 iOS 설정)이 호출.
 *
 *  - GET  /api/notify/config  — 현재 설정 (webhook URL 은 redact 해서 노출).
 *  - POST /api/notify/config  — Discord webhook 설정 저장/수정/해제.
 *  - POST /api/notify/test    — 지금 한 발 테스트 발사 (저장 전 URL 검증 겸용).
 *
 * 인증: admin 라우트와 동일하게 bearer 만. daemon 은 127.0.0.1 바인딩 + Tor 뒤이므로
 * 같은 머신의 Mac 앱이 config.json 의 평문 token 으로 호출한다.
 */
import { Hono } from "hono";
import { bearerAuth } from "../auth.js";
import { readConfig, writeConfig, type DiscordNotifyConfig } from "../config.js";
import {
  DEFAULT_DEEP_LINK_BRIDGE_BASE,
  checkDeepLinkBridgeHealth,
  isValidDeepLinkBaseUrl,
  isValidDiscordWebhookUrl,
  normalizeDeepLinkBaseUrl,
  redactWebhookUrl,
} from "../notify/discord.js";
import { dispatchTestNotification } from "../notify/index.js";

export const notify = new Hono();

notify.use("*", bearerAuth);

type EventsBody = {
  turnComplete?: boolean;
  sessionExit?: boolean;
  error?: boolean;
};

type ConfigBody = {
  discord?: {
    /** "" 또는 null 이면 설정 해제 (URL 제거). 키 자체가 없으면 기존 URL 유지. */
    webhookUrl?: string | null;
    enabled?: boolean;
    events?: EventsBody;
    /** «Open in app» 딥링크 브리지 base URL. ""/null 이면 기본 페이지 사용으로 복귀. */
    deepLinkBaseUrl?: string | null;
    /** 알림 본문에 에이전트 마지막 출력 미리보기 포함 (프라이버시 옵트인). 키 생략 = 기존 값 유지. */
    includePreview?: boolean;
  };
};

/** GET — 현재 설정을 redact 해서 반환 (UI 가 「설정됨/꺼짐」 + 미리보기 표시). */
notify.get("/config", (c) => {
  const cfg = readConfig();
  const d = cfg?.notify?.discord;
  return c.json({
    discord: {
      configured: !!d?.webhookUrl,
      enabled: d?.enabled ?? false,
      webhookUrlPreview: d?.webhookUrl ? redactWebhookUrl(d.webhookUrl) : null,
      // 브리지 URL 은 비밀이 아니라 (공개 정적 페이지 주소) 평문 반환 — UI 입력칸 복원용.
      deepLinkBaseUrl: d?.deepLinkBaseUrl ?? null,
      deepLinkBaseUrlDefault: DEFAULT_DEEP_LINK_BRIDGE_BASE,
      events: {
        turnComplete: d?.events?.turnComplete ?? true,
        sessionExit: d?.events?.sessionExit ?? true,
        error: d?.events?.error ?? true,
      },
      // 미리보기 옵트인 — 기본 OFF. iOS 「알림」 토글이 이 값을 읽어 초기 상태를 맞춘다.
      includePreview: d?.includePreview ?? false,
    },
  });
});

/**
 * POST — Discord webhook 설정 저장. webhookUrl 빈값("",null)이면 설정 해제, 키 생략이면
 * 기존 URL 을 유지한 채 나머지(enabled/events/deepLinkBaseUrl)만 갱신 — UI 가 저장 후
 * 입력칸을 비우므로 (평문 비표시 정책) 재입력 없이 설정 변경이 가능해야 한다.
 */
notify.post("/config", async (c) => {
  const cfg = readConfig();
  if (!cfg) return c.json({ error: "daemon_not_initialized" }, 500);

  const body = (await c.req.json().catch(() => null)) as ConfigBody | null;
  const inDiscord = body?.discord;
  if (!inDiscord) return c.json({ error: "missing_discord" }, 400);

  // 키 생략 = 기존 URL 유지. 빈값 = 해제.
  const prev = cfg.notify?.discord;
  const url =
    "webhookUrl" in inDiscord ? inDiscord.webhookUrl : (prev?.webhookUrl ?? null);
  let nextDiscord: DiscordNotifyConfig | undefined;

  if (url == null || url.trim() === "") {
    // 설정 해제 — URL 제거.
    nextDiscord = undefined;
  } else {
    const trimmed = url.trim();
    if (!isValidDiscordWebhookUrl(trimmed)) {
      return c.json({ error: "invalid_webhook_url" }, 400);
    }

    // 딥링크 브리지: 키 생략 = 기존 값 유지, ""/null = 기본 페이지로 복귀.
    let deepLinkBaseUrl: string | undefined;
    if ("deepLinkBaseUrl" in inDiscord) {
      const rawBase = inDiscord.deepLinkBaseUrl?.trim() ?? "";
      if (rawBase !== "") {
        if (!isValidDeepLinkBaseUrl(rawBase)) {
          return c.json({ error: "invalid_deep_link_url" }, 400);
        }
        deepLinkBaseUrl = normalizeDeepLinkBaseUrl(rawBase);
      }
    } else {
      deepLinkBaseUrl = prev?.deepLinkBaseUrl;
    }

    // events / enabled / includePreview 는 «키 생략 = 기존 값 유지» — iOS 가 includePreview
    // 하나만 부분 POST 해도 Mac 에서 설정한 events 토글 등이 지워지지 않게 한다.
    const events = "events" in inDiscord ? inDiscord.events : prev?.events;
    const enabled = "enabled" in inDiscord ? (inDiscord.enabled ?? true) : (prev?.enabled ?? true);
    const includePreview =
      "includePreview" in inDiscord ? !!inDiscord.includePreview : prev?.includePreview;

    nextDiscord = {
      webhookUrl: trimmed,
      enabled,
      ...(events ? { events } : {}),
      ...(deepLinkBaseUrl ? { deepLinkBaseUrl } : {}),
      ...(includePreview ? { includePreview: true } : {}),
    };
  }

  const nextNotify = { ...cfg.notify, discord: nextDiscord };
  writeConfig({ ...cfg, notify: nextNotify });

  return c.json({ ok: true, configured: !!nextDiscord, enabled: nextDiscord?.enabled ?? false });
});

/**
 * POST — 테스트 알림 한 발. body 에 webhookUrl / deepLinkBaseUrl 을 주면 그걸로(저장 전
 * 검증), 없으면 저장된 설정으로. away-gating / enabled 무시하고 무조건 발사.
 */
notify.post("/test", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    webhookUrl?: string;
    deepLinkBaseUrl?: string;
  };
  const cfg = readConfig();
  const url = (body.webhookUrl?.trim() || cfg?.notify?.discord?.webhookUrl) ?? "";
  if (!url) return c.json({ error: "not_configured" }, 400);
  if (!isValidDiscordWebhookUrl(url)) return c.json({ error: "invalid_webhook_url" }, 400);

  const base = body.deepLinkBaseUrl?.trim() || null;
  if (base && !isValidDeepLinkBaseUrl(base)) {
    return c.json({ error: "invalid_deep_link_url" }, 400);
  }

  const result = await dispatchTestNotification(url, base && normalizeDeepLinkBaseUrl(base));
  if (!result.ok) {
    return c.json(
      { error: "delivery_failed", status: result.status, detail: result.detail },
      502,
    );
  }
  return c.json({ ok: true });
});

/**
 * GET — 딥링크 브리지(«Open in app» 가 거치는 https 페이지) 도달 가능성 점검.
 *
 * 설정 화면 진입 / 테스트 알림 시 Mac 앱이 호출 — 죽은 주소를 «디스코드에서 눌러보기 전» 에
 * 설정 화면 경고로 드러낸다. 비차단(알림 발송과 무관) + discord.com control 핑으로 오프라인
 * 거짓경고를 방지한다.
 *
 * `?base=` 쿼리를 주면 그 주소를(저장 전 입력값 검증용), 없으면 저장된 설정의 deepLinkBaseUrl
 * (또는 기본 페이지)을 점검한다. 검사 실패는 알림 발송을 막지 않는다 — 여기선 점검만 한다.
 */
notify.get("/deeplink-health", async (c) => {
  const override = c.req.query("base")?.trim();
  let base: string | null;
  if (override !== undefined && override !== "") {
    if (!isValidDeepLinkBaseUrl(override)) {
      return c.json({ error: "invalid_deep_link_url" }, 400);
    }
    base = override;
  } else {
    base = readConfig()?.notify?.discord?.deepLinkBaseUrl ?? null;
  }
  const health = await checkDeepLinkBridgeHealth(base);
  return c.json(health);
});
