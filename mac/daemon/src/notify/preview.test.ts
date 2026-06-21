/**
 * 알림 미리보기 추출(extractAgentPreview) 단위 테스트 — 순수 함수, 네트워크/PTY 없음.
 *
 * 회귀 방지:
 *  - ANSI escape 제거 후 마지막 의미있는 줄 추출
 *  - 입력 프롬프트 박스 + 그 아래 chrome(단축키/모드) 절단
 *  - 진행바(\r 덮어쓰기) / 빈 출력 / 순수 ANSI → 의미있는 줄 없으면 null
 *  - CJK·이모지 grapheme 단위 truncate (글자 안 깨짐)
 */
import { describe, it, expect } from "vitest";
import {
  extractAgentPreview,
  redactSecretsForPreview,
  isFullyRedacted,
  PREVIEW_MAX_GRAPHEMES,
  PREVIEW_REDACTION_MASK,
} from "./preview.js";

const E = "\x1b";

describe("extractAgentPreview", () => {
  it("마지막 질문 한 줄을 뽑는다 (ANSI 제거 + 입력 박스/푸터 절단)", () => {
    const tail =
      `${E}[1mDone refactoring.${E}[0m\r\n` +
      `\r\n` +
      `Should I run the tests now?\r\n` +
      `╭────────────────────────╮\r\n` +
      `│ > ${E}[7m ${E}[0m            │\r\n` +
      `╰────────────────────────╯\r\n` +
      `  ? for shortcuts          ⏵⏵ accept edits on\r\n`;
    expect(extractAgentPreview(tail)).toBe("Should I run the tests now?");
  });

  it("연속한 두 줄까지 합친다 (한~두 줄)", () => {
    const tail = `All 42 tests passed.\r\nShould I commit and push?\r\n`;
    expect(extractAgentPreview(tail)).toBe("All 42 tests passed. Should I commit and push?");
  });

  it("빈 줄 경계 위쪽 잡음은 끌어오지 않는다 (마지막 블록만)", () => {
    const tail = `old unrelated line\r\n\r\nthe actual answer\r\n`;
    expect(extractAgentPreview(tail)).toBe("the actual answer");
  });

  it("빈 출력 → null", () => {
    expect(extractAgentPreview("")).toBeNull();
    expect(extractAgentPreview("   \r\n\r\n  ")).toBeNull();
  });

  it("순수 ANSI 진행바(의미있는 글자 없음) → null", () => {
    const bar = `\r${E}[32m████████${E}[0m  \r${E}[K   `;
    expect(extractAgentPreview(bar)).toBeNull();
  });

  it("진행바 \\r 덮어쓰기는 마지막 비지 않은 세그먼트로 렌더", () => {
    const bar = `Building ${E}[32m####${E}[0m\rBuilding ########  \r${E}[K`;
    expect(extractAgentPreview(bar)).toBe("Building ########");
  });

  it("코드펜스/단축키 chrome 줄은 제외", () => {
    const tail = "```\r\nThe summary line.\r\n```\r\n? for shortcuts\r\n";
    expect(extractAgentPreview(tail)).toBe("The summary line.");
  });

  it("CJK·이모지는 grapheme 단위로 truncate (글자 안 깨짐, 끝에 …)", () => {
    const long = "작업을 마쳤어요 ".repeat(60) + "🎉";
    const out = extractAgentPreview(long)!;
    expect(out).not.toBeNull();
    expect(out.endsWith("…")).toBe(true);
    const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    // … 1개 포함 → 최대 +1.
    expect(Array.from(seg.segment(out)).length).toBeLessThanOrEqual(PREVIEW_MAX_GRAPHEMES + 1);
  });

  it("짧은 출력은 그대로 (truncate/… 없음)", () => {
    expect(extractAgentPreview("짧은 답변입니다")).toBe("짧은 답변입니다");
  });

  it("maxGraphemes 오버라이드 적용", () => {
    expect(extractAgentPreview("abcdefghij", 4)).toBe("abcd…");
  });
});

describe("redactSecretsForPreview", () => {
  const MASK = PREVIEW_REDACTION_MASK;
  const masked = (s: string) => redactSecretsForPreview(s).includes(MASK);

  it("GitHub 토큰 prefix (ghp_ / github_pat_) 마스킹", () => {
    expect(masked("token is ghp_" + "A".repeat(36))).toBe(true);
    expect(masked("github_pat_11ABCDE0123456789_" + "x".repeat(20))).toBe(true);
  });

  it("OpenAI/Anthropic sk- / sk-ant- 마스킹", () => {
    expect(masked("export KEY=sk-" + "a".repeat(40))).toBe(true);
    expect(masked("sk-ant-api03-" + "Zz0".repeat(20))).toBe(true);
  });

  it("AWS AKIA 액세스 키 마스킹", () => {
    expect(masked("aws id AKIAIOSFODNN7EXAMPLE done")).toBe(true);
  });

  it("Slack xoxb-/xoxp- 토큰 마스킹", () => {
    expect(masked("xoxb-123456789012-abcdefABCDEF")).toBe(true);
    expect(masked("xoxp-987654321098-zzzzzzzzzz")).toBe(true);
  });

  it("Bearer 토큰 — 라벨은 남기고 토큰만 가린다", () => {
    const out = redactSecretsForPreview("Authorization: Bearer abcDEF1234567890xyz");
    expect(out).toContain("Bearer " + MASK);
    expect(out).not.toContain("abcDEF1234567890xyz");
  });

  it("Google AIza API 키 마스킹", () => {
    expect(masked("key AIza" + "B".repeat(35) + " end")).toBe(true);
  });

  it("PEM BEGIN 블록 마스킹", () => {
    const pem =
      "-----BEGIN RSA PRIVATE KEY----- MIIEpAIBAAKCAQEA0Zx -----END RSA PRIVATE KEY-----";
    const out = redactSecretsForPreview(pem);
    expect(out).toContain(MASK);
    expect(out).not.toContain("MIIEpAIBAAKCAQEA0Zx");
  });

  it("api_key= / password: 할당의 값만 마스킹 (키 이름은 남는다)", () => {
    const out = redactSecretsForPreview('api_key="ak_live_8d3f1029abcd"');
    expect(out).toContain("api_key=");
    expect(out).toContain(MASK);
    expect(out).not.toContain("ak_live_8d3f1029abcd");
    expect(masked("password: hunter2pass")).toBe(true);
  });

  it("긴 고엔트로피 base64 런 마스킹", () => {
    expect(masked("blob aB3" + "Xy9Zk2Qw".repeat(6) + " tail")).toBe(true);
  });

  it("일반 산문은 오탐 없이 통과", () => {
    const prose = "All 42 tests passed. Should I commit and push the changes now?";
    expect(redactSecretsForPreview(prose)).toBe(prose);
  });

  it("평범한 코드/짧은 식별자는 통과 (token = useToken 등)", () => {
    const code = "const token = useToken(); const apiKey = getKey();";
    expect(redactSecretsForPreview(code)).toBe(code);
    expect(masked("set password: ok")).toBe(false); // 짧고 숫자 없는 값
  });

  it("git SHA (40자 소문자 hex) 는 마스킹하지 않는다", () => {
    const sha = "merged at 2f6767cabcdef0123456789abcdef0123456789ab now";
    expect(redactSecretsForPreview(sha)).toBe(sha);
  });

  it("isFullyRedacted — 전부 비밀이면 true, 본문이 남으면 false", () => {
    expect(isFullyRedacted(redactSecretsForPreview("ghp_" + "A".repeat(36)))).toBe(true);
    expect(isFullyRedacted(redactSecretsForPreview("done: ghp_" + "A".repeat(36)))).toBe(false);
  });

  it("빈 입력은 그대로 통과", () => {
    expect(redactSecretsForPreview("")).toBe("");
  });
});
