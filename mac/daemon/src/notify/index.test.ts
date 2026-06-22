/**
 * 알림 디스패치 «코어» 단위 테스트 — lethal-trifecta 캡 C3 의 회귀 백스톱.
 *
 * # 왜 이 테스트가 있나
 *
 * C3 의 핵심 불변식 = «오염(external_content_tainted)된 세션의 결과·본문을 외부 Discord
 * payload 에 절대 싣지 않는다». 이 보장은 dispatchNotification 의
 *   `if (d.includePreview && ev.outputTail && !isSessionTainted(ev.sessionId))`
 * 한 줄로만 강제된다. 누군가 알림을 리팩터하며 이 taint 가드를 떨어뜨리면 zero-click
 * 요약 누출(EchoLeak 류)이 다시 열리는데 빌드·기존 라우트 테스트는 통과한다. 이 파일이
 * 그 «외부로 나가는 마지막 한 홉» 을 못박는다.
 *
 * 단언:
 *  - C3: 오염 세션이면 includePreview 옵트인 + outputTail 이어도 payload.preview == null.
 *  - 비오염 + includePreview + outputTail → preview 가 추출·redact 되어 채워진다.
 *  - includePreview=false 면 taint 여부와 무관하게 preview 는 항상 null (추출조차 안 함).
 *  - extractAgentPreview throw → preview=null 폴백하되 알림은 발사(fail-open).
 *  - dispatchCronNotification: ok→cron_complete, error/timeout→cron_failed; mute·away·
 *    isCronSessionActive 억제를 무시하고 항상 발사 (무인 결과 통지 보장).
 *  - 일반 dispatch 의 억제 경로(cron-active·away·mute·이벤트 off)도 회귀 못박기.
 *  - webhook 미설정/네트워크 실패에 throw 하지 않는다 (best-effort).
 *
 * 격리: isSessionTainted / extractAgentPreview / webhook fetch(postDiscordWebhook) 와
 * config·db·ws·cron·agent registry 를 전부 모킹해 «디스패치 분기 로직» 만 검증한다.
 * buildDiscordBody·redactSecretsForPreview·isFullyRedacted·PREVIEW_ALL_REDACTED 는 «진짜»
 * 를 써 C3 의 redact 경로가 실제로 도는지 end-to-end 로 본다.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// 모든 mock 팩토리가 공유하는 가변 상태 — 각 테스트가 beforeEach 이후 필드만 바꿔 분기를 제어한다.
const state = vi.hoisted(() => ({
  config: null as unknown,
  sessionRow: undefined as
    | { repo_path: string; title: string | null; agent: string; notify_muted: number }
    | undefined,
  tainted: false,
  cronActive: false,
  activeSubscriber: false,
}));

vi.mock("../config.js", () => ({ readConfig: () => state.config }));
vi.mock("../ws/hub.js", () => ({ hasActiveSubscriber: () => state.activeSubscriber }));
vi.mock("../cron/registry.js", () => ({ isCronSessionActive: () => state.cronActive }));
vi.mock("../db/index.js", () => ({
  db: () => ({ prepare: () => ({ get: () => state.sessionRow }) }),
}));
vi.mock("../agent/registry.js", () => ({
  hasAgent: () => false,
  getAgent: () => ({ displayName: "Agent" }),
}));
// C3 게이트의 입력 — 테스트가 state.tainted 로 오염 여부를 좌우한다.
vi.mock("../taint.js", () => ({ isSessionTainted: vi.fn(() => state.tainted) }));
// extractAgentPreview 만 mock(반환 제어 + throw 주입). redact/isFullyRedacted/PREVIEW_ALL_REDACTED
// 는 진짜를 남겨 C3 의 마스킹 경로가 실제로 돌게 한다.
vi.mock("./preview.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./preview.js")>();
  return { ...actual, extractAgentPreview: vi.fn() };
});
// webhook fetch 차단 — buildDiscordBody 는 진짜(payload 모양을 실제로 만든 뒤 캡처),
// postDiscordWebhook 만 mock 해 «무엇을 실어 보냈는지» 를 본다.
vi.mock("./discord.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./discord.js")>();
  return {
    ...actual,
    buildDiscordBody: vi.fn(actual.buildDiscordBody),
    postDiscordWebhook: vi.fn(async () => ({ ok: true, status: 204 })),
  };
});

import {
  dispatchNotification,
  dispatchCronNotification,
  dispatchPoNotification,
  type DispatchEvent,
} from "./index.js";
import { isSessionTainted } from "../taint.js";
import { extractAgentPreview, PREVIEW_ALL_REDACTED } from "./preview.js";
import { buildDiscordBody, postDiscordWebhook } from "./discord.js";

const WEBHOOK = "https://discord.com/api/webhooks/123456789/abcDEF-_123";

// console 잡음 억제(taint/실패 로그). 호출 여부는 실패-경로 테스트에서 assert 한다.
vi.spyOn(console, "warn").mockImplementation(() => {});
vi.spyOn(console, "log").mockImplementation(() => {});

/** 직전 buildDiscordBody 호출에 들어간 enrich 입력 (preview/kind 를 여기서 읽는다). */
function lastBuilt() {
  return vi.mocked(buildDiscordBody).mock.calls.at(-1)?.[0];
}
/** postDiscordWebhook 발사 횟수 (= 외부로 실제 나간 알림 수). */
function firedCount() {
  return vi.mocked(postDiscordWebhook).mock.calls.length;
}
/** 직전에 «실제로 실어 보낸» Discord body (embed description 등 검사용). */
function lastSentBody() {
  return vi.mocked(postDiscordWebhook).mock.calls.at(-1)?.[1];
}
function lastSentDescription(): string | undefined {
  return lastSentBody()?.embeds?.[0]?.description;
}

beforeEach(() => {
  vi.clearAllMocks(); // 호출 이력만 초기화 — 팩토리에서 심은 구현은 유지.
  state.config = {
    notify: { discord: { enabled: true, webhookUrl: WEBHOOK, includePreview: false } },
  };
  state.sessionRow = {
    repo_path: "/Users/me/work/my-repo",
    title: "리팩터링",
    agent: "claude_code",
    notify_muted: 0,
  };
  state.tainted = false;
  state.cronActive = false;
  state.activeSubscriber = false;
  // 기본: 추출은 null (의미있는 줄 없음). 채워짐을 보는 테스트만 mockReturnValueOnce 로 덮는다.
  vi.mocked(extractAgentPreview).mockReturnValue(null);
});

/** turn_complete 이벤트 생성 헬퍼. */
function turnEvent(over: Partial<DispatchEvent> = {}): DispatchEvent {
  return { kind: "turn_complete", sessionId: "sess-1", elapsedMs: 1234, ...over };
}

describe("C3 — 오염 세션 미리보기 누출 차단 (dispatchNotification)", () => {
  it("오염 세션이면 includePreview=true + outputTail 이어도 preview 가 생략(null)된다", async () => {
    (state.config as any).notify.discord.includePreview = true;
    state.tainted = true;

    await dispatchNotification(turnEvent({ outputTail: "Done. Should I deploy now?\r\n" }));

    // C3 핵심: payload 에 preview 가 실리지 않는다.
    expect(lastBuilt()?.preview).toBeNull();
    // 오염이면 추출 자체를 시도하지 않는다 (게이트가 추출 «앞» 에서 끊는다).
    expect(extractAgentPreview).not.toHaveBeenCalled();
    // 그래도 알림 자체는 나간다 (메타 신호만) — 억제가 아니라 «미리보기 생략».
    expect(firedCount()).toBe(1);
    // 실제 전송된 본문은 정적 안내문일 뿐, 에이전트 출력 한 줄이 들어있지 않다.
    expect(lastSentDescription()).not.toContain("deploy now");
  });

  it("비오염 + includePreview=true + outputTail → preview 가 추출·redact 되어 채워진다", async () => {
    (state.config as any).notify.discord.includePreview = true;
    state.tainted = false;
    vi.mocked(extractAgentPreview).mockReturnValueOnce("All 42 tests passed. Commit and push?");

    await dispatchNotification(turnEvent({ outputTail: "raw pty tail…" }));

    expect(extractAgentPreview).toHaveBeenCalledWith("raw pty tail…");
    // 일반 산문은 redact 무변 통과 → 그대로 payload 에.
    expect(lastBuilt()?.preview).toBe("All 42 tests passed. Commit and push?");
    expect(lastSentDescription()).toContain("All 42 tests passed");
    expect(firedCount()).toBe(1);
  });

  it("비오염 + 미리보기가 통째로 비밀이면 PREVIEW_ALL_REDACTED 로 치환된다", async () => {
    (state.config as any).notify.discord.includePreview = true;
    state.tainted = false;
    const secret = "ghp_" + "A".repeat(36); // GitHub PAT — redact 가 전부 가린다.
    vi.mocked(extractAgentPreview).mockReturnValueOnce(secret);

    await dispatchNotification(turnEvent({ outputTail: "raw…" }));

    expect(lastBuilt()?.preview).toBe(PREVIEW_ALL_REDACTED);
    // 토큰 원문이 외부로 나가지 않는다.
    expect(lastSentDescription()).not.toContain(secret);
    expect(lastSentDescription()).toContain(PREVIEW_ALL_REDACTED);
    expect(firedCount()).toBe(1);
  });

  it("includePreview=false 면 비오염이라도 preview 는 항상 null (추출조차 안 함)", async () => {
    (state.config as any).notify.discord.includePreview = false;
    state.tainted = false;

    await dispatchNotification(turnEvent({ outputTail: "Should I run the tests?\r\n" }));

    expect(lastBuilt()?.preview).toBeNull();
    expect(extractAgentPreview).not.toHaveBeenCalled();
    expect(firedCount()).toBe(1);
  });

  it("includePreview=false + 오염이어도 preview 는 null (옵트아웃이 우선)", async () => {
    (state.config as any).notify.discord.includePreview = false;
    state.tainted = true;

    await dispatchNotification(turnEvent({ outputTail: "secret-ish output\r\n" }));

    expect(lastBuilt()?.preview).toBeNull();
    expect(extractAgentPreview).not.toHaveBeenCalled();
    expect(firedCount()).toBe(1);
  });

  it("게이트는 이벤트의 sessionId 로 isSessionTainted 를 조회한다 (오염이면 생략)", async () => {
    (state.config as any).notify.discord.includePreview = true;
    state.tainted = true;

    await dispatchNotification(turnEvent({ sessionId: "sess-xyz", outputTail: "x" }));

    expect(isSessionTainted).toHaveBeenCalledWith("sess-xyz");
    expect(lastBuilt()?.preview).toBeNull();
  });

  it("이중 안전: outputTail 에 ANSI+시크릿이 있어도 오염이면 redact 거치지 않고 통째 생략", async () => {
    (state.config as any).notify.discord.includePreview = true;
    state.tainted = true;
    const tail = "\x1b[1mexport TOKEN=ghp_" + "B".repeat(36) + "\x1b[0m\r\n";

    await dispatchNotification(turnEvent({ outputTail: tail }));

    expect(extractAgentPreview).not.toHaveBeenCalled(); // redact 이전에 끊긴다
    expect(lastBuilt()?.preview).toBeNull();
    expect(lastSentDescription() ?? "").not.toContain("ghp_");
    expect(firedCount()).toBe(1);
  });

  it("fail-open: extractAgentPreview 가 throw 해도 preview=null 폴백 + 알림은 발사", async () => {
    (state.config as any).notify.discord.includePreview = true;
    state.tainted = false;
    vi.mocked(extractAgentPreview).mockImplementationOnce(() => {
      throw new Error("segmenter blew up");
    });

    await expect(
      dispatchNotification(turnEvent({ outputTail: "some tail" })),
    ).resolves.toBeUndefined();

    expect(lastBuilt()?.preview).toBeNull();
    expect(firedCount()).toBe(1); // 추출 실패가 알림 자체를 막지 않는다
  });

  it("outputTail 이 없으면 includePreview=true 라도 추출·preview 없음", async () => {
    (state.config as any).notify.discord.includePreview = true;
    state.tainted = false;

    await dispatchNotification(turnEvent({ outputTail: undefined }));

    expect(extractAgentPreview).not.toHaveBeenCalled();
    expect(lastBuilt()?.preview).toBeNull();
    expect(firedCount()).toBe(1);
  });
});

describe("dispatchCronNotification — status→kind 분기 + 무인 억제 무시", () => {
  const cronEv = (status: "ok" | "error" | "timeout") => ({
    sessionId: "cron-1",
    status,
    elapsedMs: 5000,
  });

  it("status=ok → cron_complete (초록)", async () => {
    await dispatchCronNotification(cronEv("ok"));
    expect(lastBuilt()?.kind).toBe("cron_complete");
    expect(firedCount()).toBe(1);
  });

  it("status=error → cron_failed (빨강)", async () => {
    await dispatchCronNotification(cronEv("error"));
    expect(lastBuilt()?.kind).toBe("cron_failed");
    expect(firedCount()).toBe(1);
  });

  it("status=timeout → cron_failed (빨강)", async () => {
    await dispatchCronNotification(cronEv("timeout"));
    expect(lastBuilt()?.kind).toBe("cron_failed");
    expect(firedCount()).toBe(1);
  });

  it("isCronSessionActive 억제를 무시하고 발사한다 (무인 결과 통지)", async () => {
    state.cronActive = true;
    await dispatchCronNotification(cronEv("ok"));
    expect(firedCount()).toBe(1);
  });

  it("away-gating(활성 구독자)을 무시하고 발사한다", async () => {
    state.activeSubscriber = true;
    await dispatchCronNotification(cronEv("ok"));
    expect(firedCount()).toBe(1);
  });

  it("notify_muted=1 이어도 발사한다 (mute 무시)", async () => {
    state.sessionRow!.notify_muted = 1;
    await dispatchCronNotification(cronEv("ok"));
    expect(firedCount()).toBe(1);
  });

  it("webhook 미설정이면 no-op (발사 안 함, throw 없음)", async () => {
    state.config = { notify: { discord: { enabled: true } } }; // webhookUrl 없음
    await expect(dispatchCronNotification(cronEv("ok"))).resolves.toBeUndefined();
    expect(firedCount()).toBe(0);
  });

  it("네트워크 실패에도 throw 하지 않는다 (best-effort)", async () => {
    vi.mocked(postDiscordWebhook).mockRejectedValueOnce(new Error("ECONNRESET"));
    await expect(dispatchCronNotification(cronEv("ok"))).resolves.toBeUndefined();
  });
});

describe("dispatchNotification — 억제 경로 (cron 과 대비되는 일반 알림 게이팅)", () => {
  it("isCronSessionActive 면 일반 알림은 억제된다 (cron 전용만 나가도록)", async () => {
    state.cronActive = true;
    await dispatchNotification(turnEvent());
    expect(firedCount()).toBe(0);
    expect(buildDiscordBody).not.toHaveBeenCalled();
  });

  it("cron 세션이 동시에 turn_complete 를 내면: 일반은 억제, cron 전용만 발사", async () => {
    state.cronActive = true;
    await dispatchNotification(turnEvent({ sessionId: "cron-1" }));
    await dispatchCronNotification({ sessionId: "cron-1", status: "ok" });
    expect(firedCount()).toBe(1); // 일반은 0, cron 1
    expect(lastBuilt()?.kind).toBe("cron_complete");
  });

  it("활성 구독자(away-gating)면 억제된다 — 폰이 이미 보고 있음", async () => {
    state.activeSubscriber = true;
    await dispatchNotification(turnEvent());
    expect(firedCount()).toBe(0);
  });

  it("세션 notify_muted=1 이면 억제된다", async () => {
    state.sessionRow!.notify_muted = 1;
    await dispatchNotification(turnEvent());
    expect(firedCount()).toBe(0);
    expect(buildDiscordBody).not.toHaveBeenCalled();
  });

  it("이벤트가 events 토글로 off 면 억제된다 (turnComplete=false)", async () => {
    (state.config as any).notify.discord.events = { turnComplete: false };
    await dispatchNotification(turnEvent());
    expect(firedCount()).toBe(0);
  });

  it("disabled / webhook 미설정이면 no-op", async () => {
    (state.config as any).notify.discord.enabled = false;
    await dispatchNotification(turnEvent());
    expect(firedCount()).toBe(0);
  });

  it("네트워크 실패에도 throw 하지 않는다 (best-effort)", async () => {
    vi.mocked(postDiscordWebhook).mockRejectedValueOnce(new Error("ETIMEDOUT"));
    await expect(dispatchNotification(turnEvent())).resolves.toBeUndefined();
  });

  it("미지 세션(row 없음)이어도 enrich 없이 best-effort 로 발사한다", async () => {
    // 세션이 DB 에 없으면 repo/title/mute 없이도 dispatch 는 진행(조회 실패 흡수).
    state.sessionRow = undefined;
    await expect(dispatchNotification(turnEvent())).resolves.toBeUndefined();
    expect(firedCount()).toBe(1);
  });
});

describe("dispatchPoNotification — 예약 수집 세 결말 (po_scheduled_status_v1)", () => {
  // 「보낼지」 판정(폭주 억제·예약 한정)은 호출처가 끝냈다 — 이 함수는 들어오면 무조건 한 발 쏜다.
  it("ok + N(≥1) → po_briefs (백로그 딥링크 + 결재 수량 요약)", async () => {
    await dispatchPoNotification({ sessionId: "sess-1", status: "ok", briefCount: 3 });
    expect(lastBuilt()?.kind).toBe("po_briefs");
    expect(firedCount()).toBe(1);
    // 백로그 탭 딥링크가 content 에 실린다 (결재는 백로그에서).
    expect(lastSentBody()?.content ?? "").toContain("/#backlog");
  });

  it("ok + 1건이면 그 브리프 상세로 직행 (backlog/<id>)", async () => {
    await dispatchPoNotification({ sessionId: "sess-1", status: "ok", briefCount: 1, briefId: "b-9" });
    expect(lastBuilt()?.kind).toBe("po_briefs");
    expect(lastSentBody()?.content ?? "").toContain("/#backlog/b-9");
  });

  it("ok + 0 → po_empty (회색 중립 — 실패와 구분, 그래도 발사)", async () => {
    await dispatchPoNotification({ sessionId: "sess-1", status: "ok", briefCount: 0 });
    expect(lastBuilt()?.kind).toBe("po_empty");
    expect(firedCount()).toBe(1);
    // 제목이 «실패» 가 아니라 «No new briefs» — 시각적으로 구분된다.
    expect(lastSentBody()?.embeds?.[0]?.title ?? "").toContain("No new briefs");
  });

  it("error → po_failed + 사유를 Reason 필드로 (세션 있으면 transcript 딥링크)", async () => {
    await dispatchPoNotification({
      sessionId: "sess-1",
      status: "error",
      briefCount: 0,
      errorSummary: "settle timed out",
    });
    expect(lastBuilt()?.kind).toBe("po_failed");
    expect(lastBuilt()?.reason).toBe("settle timed out");
    const reasonField = lastSentBody()?.embeds?.[0]?.fields?.find((f) => f.name === "Reason");
    expect(reasonField?.value).toBe("settle timed out");
    // 세션이 있으면 그 세션 딥링크 (transcript 진단).
    expect(lastSentBody()?.content ?? "").toContain("/#sess-1");
  });

  it("시작 실패(세션 없음): repoPath 로 repo 보강 + 백로그 폴백 딥링크", async () => {
    // sessionId 없음 → DB 조회 안 하고 ev.repoPath 로 repo 이름 보강.
    await dispatchPoNotification({
      repoPath: "/Users/me/work/cool-repo",
      status: "error",
      briefCount: 0,
      errorSummary: "agent_missing: codex",
    });
    expect(lastBuilt()?.kind).toBe("po_failed");
    expect(lastBuilt()?.repoName).toBe("cool-repo");
    expect(lastBuilt()?.reason).toBe("agent_missing: codex");
    // 세션이 없으니 백로그 탭으로 폴백 착지.
    expect(lastSentBody()?.content ?? "").toContain("/#backlog");
  });

  it("disabled / webhook 미설정이면 no-op (best-effort)", async () => {
    (state.config as any).notify.discord.enabled = false;
    await dispatchPoNotification({ sessionId: "sess-1", status: "ok", briefCount: 5 });
    expect(firedCount()).toBe(0);
  });

  it("네트워크 실패에도 throw 하지 않는다", async () => {
    vi.mocked(postDiscordWebhook).mockRejectedValueOnce(new Error("ETIMEDOUT"));
    await expect(
      dispatchPoNotification({ sessionId: "sess-1", status: "ok", briefCount: 2 }),
    ).resolves.toBeUndefined();
  });
});
