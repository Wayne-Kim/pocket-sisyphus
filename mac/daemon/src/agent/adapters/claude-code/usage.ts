/**
 * claude_code 토큰 잔량 조회 — Claude Code 의 REPL `/usage` 화면이 쓰는 것과 같은
 * 데이터 소스를 daemon 이 직접 읽는다:
 *
 *   1. macOS Keychain 의 "Claude Code-credentials" generic password
 *      (`security find-generic-password -w`) → `claudeAiOauth.accessToken`.
 *      Claude Code 가 로그인 시 만들어 두는 항목 — 같은 사용자 계정의 daemon 이
 *      읽는다. 첫 호출 시 macOS 가 키체인 접근 허용을 1회 물을 수 있다 (거부/타임아웃
 *      → 친화 메시지로 throw, iOS 가 «조회 불가» 표시).
 *   2. GET https://api.anthropic.com/api/oauth/usage — 구독 rate limit 윈도우별
 *      사용률(%) + 리셋 시각. 응답 shape (2026-06 실측):
 *        { five_hour: { utilization: 7.0, resets_at: "2026-06-02T15:40:00.8+00:00" },
 *          seven_day: {...}, seven_day_opus: null, seven_day_sonnet: {...}, ... }
 *
 * CLI 는 비-인터랙티브 usage 명령을 제공하지 않아 (2.1.160 기준 — REPL `/usage` 뿐)
 * 이 경로가 유일하다. PTY 세션에 `/usage` 를 흘려 넣는 방식은 사용자의 REPL 을
 * 방해하므로 채택하지 않음.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentUsageReport, AgentUsageWindow } from "../../types.js";

const execFileAsync = promisify(execFile);

const KEYCHAIN_SERVICE = "Claude Code-credentials";
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

/** oauth/usage 응답의 한 윈도우. null = 그 윈도우 비적용 플랜. */
type OauthUsageWindow = { utilization: number | null; resets_at: string | null } | null;

/**
 * oauth/usage JSON → 정규화된 윈도우 배열. 순수 함수 — 단위 테스트 대상.
 *
 * - five_hour / seven_day 는 항상 포함 (있으면) — /usage 화면의 «Current session /
 *   Current week» 와 동일한 핵심 2개.
 * - 모델별 주간 (seven_day_opus / seven_day_sonnet) 은 «의미 있는 값일 때만» —
 *   utilization 0 + resets_at null 은 비활성 슬롯이라 노이즈로 보고 제외.
 * - 그 외 미래에 추가되는 키 (tangelo 등 실험 슬롯) 는 무시.
 */
export function mapClaudeOauthUsage(json: Record<string, unknown>): AgentUsageWindow[] {
  const out: AgentUsageWindow[] = [];
  const push = (id: string, windowMinutes: number, required: boolean): void => {
    const w = json[id] as OauthUsageWindow;
    if (!w || typeof w !== "object") return;
    const used = typeof w.utilization === "number" ? w.utilization : null;
    const resetsAt =
      typeof w.resets_at === "string" ? Date.parse(w.resets_at) || null : null;
    if (used === null) return;
    // 선택 윈도우 (모델별) 는 둘 다 비어 있으면 비활성으로 보고 제외.
    if (!required && used === 0 && resetsAt === null) return;
    out.push({ id, windowMinutes, usedPercent: used, resetsAt });
  };
  push("five_hour", 300, true);
  push("seven_day", 7 * 24 * 60, true);
  push("seven_day_opus", 7 * 24 * 60, false);
  push("seven_day_sonnet", 7 * 24 * 60, false);
  return out;
}

/** Keychain 의 credentials JSON 에서 accessToken 추출. 순수 함수 — 단위 테스트 대상. */
export function extractAccessToken(raw: string): string | null {
  try {
    const j = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: unknown } };
    const t = j?.claudeAiOauth?.accessToken;
    return typeof t === "string" && t.length > 0 ? t : null;
  } catch {
    return null;
  }
}

export async function claudeUsage(): Promise<AgentUsageReport> {
  // 1) Keychain 에서 OAuth access token. -w 는 비밀값만 stdout 으로 — 로그에 남기지 않는다.
  let secret: string;
  try {
    const { stdout } = await execFileAsync(
      "/usr/bin/security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
      { timeout: 5000, maxBuffer: 64 * 1024 },
    );
    secret = stdout.trim();
  } catch {
    throw new Error(
      "Claude 인증 정보를 읽지 못했어요 — Mac 에서 키체인 접근을 허용해 주세요.",
    );
  }
  const token = extractAccessToken(secret);
  if (!token) {
    throw new Error("Claude 로그인 상태가 아니에요 — Mac 에서 claude 에 로그인해 주세요.");
  }

  // 2) 공식 usage 엔드포인트. Claude Code 자체가 /usage 화면에서 호출하는 것과 동일.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  let json: Record<string, unknown>;
  try {
    const res = await fetch(USAGE_URL, {
      headers: {
        authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
      },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      // 401 = 토큰 만료 (claude 가 다음 turn 에 자동 갱신). 그 외 = API 측 문제.
      throw new Error(`usage API ${res.status}`);
    }
    json = (await res.json()) as Record<string, unknown>;
  } catch (e) {
    throw new Error(`Claude 잔량 조회 실패 — ${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
  }

  return { windows: mapClaudeOauthUsage(json), fetchedAt: Date.now() };
}
