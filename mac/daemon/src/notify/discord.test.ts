/**
 * Discord webhook notifier 단위 테스트 — 네트워크 없이 순수 함수만.
 *
 * 회귀 방지 대상:
 *  - webhook URL 검증 (정상 / http / 잘못된 호스트 / 경로 불일치)
 *  - URL redact (token 부분만 가림)
 *  - duration 포맷
 *  - embed body 빌드 (종류별 title/color/fields)
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  isValidDiscordWebhookUrl,
  isValidDeepLinkBaseUrl,
  normalizeDeepLinkBaseUrl,
  redactWebhookUrl,
  formatDuration,
  buildDiscordBody,
  checkDeepLinkBridgeHealth,
} from "./discord.js";
import { eventEnabled } from "./index.js";

describe("isValidDiscordWebhookUrl", () => {
  it("정상 discord.com webhook 통과", () => {
    expect(
      isValidDiscordWebhookUrl("https://discord.com/api/webhooks/123456789/abcDEF-_123"),
    ).toBe(true);
  });
  it("버전 prefix(/api/v10) 통과", () => {
    expect(
      isValidDiscordWebhookUrl("https://discord.com/api/v10/webhooks/123/tok-EN_v10"),
    ).toBe(true);
  });
  it("legacy discordapp.com + canary/ptb 서브도메인 통과", () => {
    expect(isValidDiscordWebhookUrl("https://discordapp.com/api/webhooks/1/t")).toBe(true);
    expect(isValidDiscordWebhookUrl("https://canary.discord.com/api/webhooks/1/t")).toBe(true);
    expect(isValidDiscordWebhookUrl("https://ptb.discord.com/api/webhooks/1/t")).toBe(true);
  });
  it("http(평문) 거부", () => {
    expect(
      isValidDiscordWebhookUrl("http://discord.com/api/webhooks/123/abc"),
    ).toBe(false);
  });
  it("엉뚱한 호스트 거부 (피싱 방지)", () => {
    expect(
      isValidDiscordWebhookUrl("https://evil.com/api/webhooks/123/abc"),
    ).toBe(false);
    expect(
      isValidDiscordWebhookUrl("https://discord.com.evil.com/api/webhooks/1/t"),
    ).toBe(false);
  });
  it("경로 불일치 거부 (id 가 숫자 아님 / token 누락)", () => {
    expect(isValidDiscordWebhookUrl("https://discord.com/api/webhooks/abc/tok")).toBe(false);
    expect(isValidDiscordWebhookUrl("https://discord.com/api/webhooks/123")).toBe(false);
    expect(isValidDiscordWebhookUrl("https://discord.com/")).toBe(false);
  });
  it("쓰레기 입력 거부", () => {
    expect(isValidDiscordWebhookUrl("")).toBe(false);
    expect(isValidDiscordWebhookUrl("not a url")).toBe(false);
  });
});

describe("isValidDeepLinkBaseUrl", () => {
  it("https URL 통과 — 호스트 제한 없음 (자기 GitHub Pages / 커스텀 도메인)", () => {
    expect(isValidDeepLinkBaseUrl("https://someone.github.io/my-bridge/open")).toBe(true);
    expect(isValidDeepLinkBaseUrl("https://bridge.example.com")).toBe(true);
  });
  it("http(평문) 거부", () => {
    expect(isValidDeepLinkBaseUrl("http://someone.github.io/open")).toBe(false);
  });
  it("query/fragment 포함 거부 — 세션 id fragment 조립을 깨뜨림", () => {
    expect(isValidDeepLinkBaseUrl("https://x.github.io/open?a=b")).toBe(false);
    expect(isValidDeepLinkBaseUrl("https://x.github.io/open#frag")).toBe(false);
  });
  it("쓰레기 입력 거부", () => {
    expect(isValidDeepLinkBaseUrl("")).toBe(false);
    expect(isValidDeepLinkBaseUrl("not a url")).toBe(false);
    expect(isValidDeepLinkBaseUrl("pocketsisyphus://session/x")).toBe(false);
  });
});

describe("normalizeDeepLinkBaseUrl", () => {
  it("공백 + 끝 슬래시 제거", () => {
    expect(normalizeDeepLinkBaseUrl("  https://x.github.io/open/  ")).toBe(
      "https://x.github.io/open",
    );
    expect(normalizeDeepLinkBaseUrl("https://x.github.io/open//")).toBe(
      "https://x.github.io/open",
    );
  });
});

describe("redactWebhookUrl", () => {
  it("token(마지막 segment)만 가린다", () => {
    const r = redactWebhookUrl("https://discord.com/api/webhooks/123456789/SECRETtoken");
    expect(r).toContain("123456789");
    expect(r).not.toContain("SECRETtoken");
    expect(r).toContain("•••");
  });
  it("파싱 실패 시 전체 마스킹", () => {
    expect(redactWebhookUrl("garbage")).toBe("•••");
  });
});

describe("formatDuration", () => {
  it("초 / 분 / 시간", () => {
    expect(formatDuration(5_000)).toBe("5s");
    expect(formatDuration(73_000)).toBe("1m 13s");
    expect(formatDuration(3_780_000)).toBe("1h 03m");
  });
  it("음수/NaN 은 0s", () => {
    expect(formatDuration(-1)).toBe("0s");
    expect(formatDuration(NaN)).toBe("0s");
  });
});

describe("buildDiscordBody", () => {
  it("turn_complete — 제목에 세션 요약, repo/agent/elapsed 필드 + blurple", () => {
    const body = buildDiscordBody({
      kind: "turn_complete",
      repoName: "my-repo",
      repoPath: "/Users/x/my-repo",
      agentName: "Claude Code",
      sessionTitle: "리팩터링",
      elapsedMs: 73_000,
    });
    expect(body.username).toBe("Pocket Sisyphus");
    const e = body.embeds?.[0];
    // 요약(세션 제목)이 제목 라벨에 붙는다 — 본문 안 열어도 무엇이 끝났는지 식별.
    expect(e?.title).toContain("Your turn");
    expect(e?.title).toContain("리팩터링");
    expect(e?.color).toBe(0x5865f2);
    // 요약이 제목으로 올라갔으니 description 은 종류별 안내 문장.
    expect(e?.description).toMatch(/finished|input/i);
    const fieldNames = (e?.fields ?? []).map((f) => f.name);
    expect(fieldNames).toEqual(["Repo", "Agent", "Elapsed"]);
    expect(e?.fields?.find((f) => f.name === "Repo")?.value).toContain("my-repo");
  });

  it("세션 제목 없으면 제목 요약은 repo 이름으로 폴백", () => {
    const body = buildDiscordBody({
      kind: "turn_complete",
      repoName: "my-repo",
      repoPath: "/my-repo",
      agentName: "Codex",
      sessionTitle: null,
    });
    const e = body.embeds?.[0];
    expect(e?.title).toContain("my-repo");
    expect(e?.description).toMatch(/finished|input/i);
  });

  it("error — Exit 필드 + 빨강", () => {
    const body = buildDiscordBody({
      kind: "error",
      repoName: "r",
      repoPath: "/r",
      agentName: "Claude Code",
      exitCode: 1,
    });
    const e = body.embeds?.[0];
    expect(e?.color).toBe(0xed4245);
    expect(e?.fields?.find((f) => f.name === "Exit")?.value).toBe("code 1");
  });

  it("error — signal 우선", () => {
    const body = buildDiscordBody({
      kind: "error",
      repoName: "r",
      repoPath: "/r",
      agentName: "Claude Code",
      exitCode: null,
      signal: "SIGTERM",
    });
    expect(body.embeds?.[0]?.fields?.find((f) => f.name === "Exit")?.value).toBe(
      "signal SIGTERM",
    );
  });

  it("sessionId 있으면 https 브리지 딥링크를 content 에 마스크 링크로 싣는다 (탭 가능)", () => {
    const body = buildDiscordBody({
      kind: "turn_complete",
      repoName: "r",
      repoPath: "/r",
      agentName: "Claude Code",
      sessionId: "abc-123",
    });
    // Discord 는 커스텀 scheme 을 링크로 안 만든다 → https 브리지 페이지 URL 을 싣는다.
    // 커스텀 scheme(pocketsisyphus://)은 메시지에 직접 넣지 않는다 (죽은 평문/400 거부).
    expect(body.content).not.toContain("pocketsisyphus://");
    expect(body.content).toContain(
      "https://pocketsisyphus.app/open/#abc-123",
    );
    // 마스크 링크 + embed unfurl 억제(<>) 형태.
    expect(body.content).toContain("[Open in app](<https://");
    // embed 필드엔 딥링크 없음.
    const link = body.embeds?.[0]?.fields?.find((f) => f.name === "Open in app");
    expect(link).toBeUndefined();
  });

  it("deepLinkBaseUrl 지정 시 사용자 브리지로 딥링크를 만든다 (끝 슬래시 정규화 포함)", () => {
    const body = buildDiscordBody({
      kind: "turn_complete",
      repoName: "r",
      repoPath: "/r",
      agentName: "Claude Code",
      sessionId: "abc-123",
      deepLinkBaseUrl: "https://someone.github.io/my-bridge/open/",
    });
    expect(body.content).toContain("https://someone.github.io/my-bridge/open/#abc-123");
    expect(body.content).not.toContain("wayne-kim.github.io");
  });

  it("deepLinkPath 가 있으면 sessionId 대신 route 경로 fragment 로 딥링크를 만든다 (PO 백로그 착지)", () => {
    const body = buildDiscordBody({
      kind: "po_briefs",
      repoName: "r",
      repoPath: "/r",
      agentName: "PO agent",
      sessionId: "collect-session-1",
      deepLinkPath: "backlog/brief-42",
    });
    // 경로 구분자 / 는 fragment 에서 합법 — 인코딩하지 않고 그대로 싣는다.
    expect(body.content).toContain(
      "https://pocketsisyphus.app/open/#backlog/brief-42",
    );
    // 세션 딥링크로 폴백하지 않는다.
    expect(body.content).not.toContain("collect-session-1");
  });

  it("deepLinkPath — id 없는 백로그 루트 착지", () => {
    const body = buildDiscordBody({
      kind: "po_briefs",
      repoName: "r",
      repoPath: "/r",
      agentName: "PO agent",
      sessionId: "s-1",
      deepLinkPath: "backlog",
    });
    expect(body.content).toContain("/open/#backlog");
    expect(body.content).not.toContain("#s-1");
  });

  it("sessionId 없으면 content 도 없음", () => {
    const body = buildDiscordBody({
      kind: "turn_complete",
      repoName: "r",
      repoPath: "/r",
      agentName: "Claude Code",
    });
    expect(body.content).toBeUndefined();
  });

  it("test 미리보기 — 세션 enrich 되면 진짜 알림 모양 (요약 제목 + 딥링크 필드)", () => {
    const body = buildDiscordBody({
      kind: "test",
      repoName: "my-repo",
      repoPath: "/my-repo",
      agentName: "Claude Code",
      sessionTitle: "예시 작업",
      sessionId: "abc-123",
    });
    const e = body.embeds?.[0];
    expect(e?.color).toBe(0x57f287); // 여전히 test 색(green)
    expect(e?.title).toContain("예시 작업"); // 요약 제목
    expect(body.content).toContain(
      "https://pocketsisyphus.app/open/#abc-123",
    ); // 딥링크 미리보기(content) — https 브리지
    expect(e?.fields?.find((f) => f.name === "Repo")?.value).toContain("my-repo");
  });

  it("test — enrich 안 된 빈 샘플은 필드 없이 green (URL 검증용)", () => {
    const body = buildDiscordBody({
      kind: "test",
      repoName: "—", // 세션 없음 → repo 폴백
      repoPath: "",
      agentName: "", // 세션 없음 → agent 비움
    });
    const e = body.embeds?.[0];
    expect(e?.color).toBe(0x57f287);
    expect(e?.fields ?? []).toHaveLength(0);
    expect(e?.title).toContain("Test");
  });

  it("preview 있으면 description 이 정적 안내문 대신 인용된 미리보기", () => {
    const body = buildDiscordBody({
      kind: "turn_complete",
      repoName: "r",
      repoPath: "/r",
      agentName: "Claude Code",
      sessionId: "abc-123",
      preview: "Should I run the tests now?",
    });
    const e = body.embeds?.[0];
    expect(e?.description).toBe("> Should I run the tests now?");
    // 정적 안내문이 아니다.
    expect(e?.description).not.toMatch(/finished its reply/);
  });

  it("preview 비었으면 정적 안내문으로 폴백 + 개행은 한 줄로", () => {
    const empty = buildDiscordBody({
      kind: "still_waiting",
      repoName: "r",
      repoPath: "/r",
      agentName: "Claude Code",
      preview: "   ",
    });
    expect(empty.embeds?.[0]?.description).toMatch(/still blocked/i);

    const multi = buildDiscordBody({
      kind: "turn_complete",
      repoName: "r",
      repoPath: "/r",
      agentName: "Claude Code",
      preview: "line one\nline two",
    });
    expect(multi.embeds?.[0]?.description).toBe("> line one line two");
  });

  it("still_waiting — Waiting 필드(대기 시간) + yellow + 딥링크", () => {
    const body = buildDiscordBody({
      kind: "still_waiting",
      repoName: "my-repo",
      repoPath: "/my-repo",
      agentName: "Claude Code",
      sessionTitle: "리팩터링",
      sessionId: "abc-123",
      waitingMs: 10 * 60_000,
    });
    const e = body.embeds?.[0];
    expect(e?.title).toContain("Still waiting");
    expect(e?.title).toContain("리팩터링");
    expect(e?.color).toBe(0xfee75c);
    expect(e?.fields?.find((f) => f.name === "Waiting")?.value).toBe("10m 00s");
    // 막힌 세션으로 바로 진입할 수 있어야 리마인더가 의미 있다 — 딥링크 필수.
    expect(body.content).toContain("#abc-123");
  });
});

describe("eventEnabled", () => {
  it("still_waiting 은 turnComplete 토글을 따른다 (별도 설정 없음)", () => {
    expect(eventEnabled("still_waiting", undefined)).toBe(true);
    expect(eventEnabled("still_waiting", { turnComplete: true })).toBe(true);
    expect(eventEnabled("still_waiting", { turnComplete: false })).toBe(false);
  });
  it("기존 이벤트 토글 회귀 없음", () => {
    expect(eventEnabled("turn_complete", { turnComplete: false })).toBe(false);
    expect(eventEnabled("session_exit", { sessionExit: false })).toBe(false);
    expect(eventEnabled("error", { error: false })).toBe(false);
    expect(eventEnabled("turn_complete", undefined)).toBe(true);
  });
});

describe("checkDeepLinkBridgeHealth", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // 응답(status)으로 분류: <400 = ok, >=400 = http_error.
  it("브리지가 정상 응답(2xx)이면 ok", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    const r = await checkDeepLinkBridgeHealth(null);
    expect(r.status).toBe("ok");
    expect(r.custom).toBe(false);
    expect(r.base).toBe("https://pocketsisyphus.app/open");
  });

  it("사용자 지정 주소도 동일하게 점검 (custom=true)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
    const r = await checkDeepLinkBridgeHealth("https://example.com/open/");
    expect(r.status).toBe("ok");
    expect(r.custom).toBe(true);
    expect(r.base).toBe("https://example.com/open"); // 끝 슬래시 정규화
  });

  it("서버가 4xx/5xx 면 http_error (HEAD·GET 모두 오류)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 404 }));
    const r = await checkDeepLinkBridgeHealth(null);
    expect(r.status).toBe("http_error");
    expect(r.httpStatus).toBe(404);
  });

  // 브리지 네트워크 실패 + control(discord.com) 성공 = 도메인 사망 → unreachable(경고).
  it("브리지 응답 없음 + 인터넷은 됨 → unreachable", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.includes("discord.com")) return new Response(null, { status: 200 });
      throw new Error("ENOTFOUND");
    });
    const r = await checkDeepLinkBridgeHealth(null);
    expect(r.status).toBe("unreachable");
  });

  // 브리지 실패 + control 도 실패 = 오프라인 → inconclusive(거짓 경고 방지).
  it("브리지·인터넷 모두 응답 없음 → inconclusive (오프라인)", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    const r = await checkDeepLinkBridgeHealth(null);
    expect(r.status).toBe("inconclusive");
    expect(r.detail).toBe("offline");
  });
});
