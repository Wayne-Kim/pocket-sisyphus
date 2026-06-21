/**
 * `claudeCodeAdapter` 의 명세 (인자/env/메타) 단위 테스트.
 *
 * 회귀 차단 대상:
 *  - --resume <uuid> 는 resumeFrom 이 있을 때만, 빈 문자열 / undefined 에서는 안 박힘
 *  - --permission-mode bypassPermissions 는 bypass 가 true 일 때만
 *  - 두 옵션 동시 + 순서 보존 (resume → permission-mode)
 *  - latency 튜닝 env 들이 빠진 채 회귀하지 않게 핵심 키 존재 확인
 *
 * resolveBinary() 는 별도 resolve-binary.test.ts 가 mock 으로 검증.
 */
import { describe, it, expect } from "vitest";
import { claudeCodeAdapter } from "./index.js";

describe("claudeCodeAdapter — 메타", () => {
  it("id / displayName / capabilities", () => {
    expect(claudeCodeAdapter.id).toBe("claude_code");
    expect(claudeCodeAdapter.displayName).toBe("Claude Code");
    // 예약 픽커 노출 표식만 — claude_code 전용 capability 는 라이브 tail 제거 후 없음.
    expect(claudeCodeAdapter.capabilities()).toEqual(["cron_eligible_v1"]);
  });
});

describe("claudeCodeAdapter.buildSpawnArgs", () => {
  it("ctx 둘 다 비어 있으면 빈 인자", () => {
    expect(claudeCodeAdapter.buildSpawnArgs({ bypassPermissions: false })).toEqual([]);
  });

  it("resumeFrom 만 → --resume <id>", () => {
    expect(
      claudeCodeAdapter.buildSpawnArgs({
        resumeFrom: "abc-123",
        bypassPermissions: false,
      }),
    ).toEqual(["--resume", "abc-123"]);
  });

  it("빈 resumeFrom 은 무시 (옛 클라이언트가 빈 문자열 보내는 케이스 차단)", () => {
    expect(
      claudeCodeAdapter.buildSpawnArgs({ resumeFrom: "", bypassPermissions: false }),
    ).toEqual([]);
  });

  it("bypassPermissions 만 → --permission-mode bypassPermissions", () => {
    expect(claudeCodeAdapter.buildSpawnArgs({ bypassPermissions: true })).toEqual([
      "--permission-mode",
      "bypassPermissions",
    ]);
  });

  it("둘 다 → resume 가 permission-mode 보다 앞", () => {
    expect(
      claudeCodeAdapter.buildSpawnArgs({
        resumeFrom: "uuid-1",
        bypassPermissions: true,
      }),
    ).toEqual(["--resume", "uuid-1", "--permission-mode", "bypassPermissions"]);
  });
});

describe("claudeCodeAdapter.buildSpawnEnv", () => {
  it("부팅 latency 튜닝에 필요한 핵심 env 들이 모두 들어 있다", () => {
    const env = claudeCodeAdapter.buildSpawnEnv();
    // 회귀 차단 — 빠지면 첫 부팅 latency 가 30s+ 증가했었다 (claude-code/index.ts 헤더 참고).
    expect(env.DISABLE_AUTOUPDATER).toBe("1");
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
    expect(env.CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL).toBe("1");
    expect(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe("1");
    expect(env.CLAUDE_CODE_DISABLE_TERMINAL_TITLE).toBe("1");
    // 모바일 ANSI 렌더러가 색 출력을 받아야 하므로.
    expect(env.FORCE_COLOR).toBe("1");
  });
});
