/**
 * `agyAdapter` (Google Antigravity CLI) 의 인자 빌더 단위 테스트.
 *
 * 회귀 차단 대상:
 *  - resumeFrom → `--conversation <id>` (claude 의 `--resume` 와 인자 이름이 다름)
 *  - bypassPermissions → `--dangerously-skip-permissions`
 *  - 빈 resumeFrom 무시
 *  - capability 'agy_resume_v1' 광고 — iOS picker 가 이걸 보고 이어받기 UI 분기
 */
import { describe, it, expect } from "vitest";
import { agyAdapter } from "./index.js";
import { installHintIsCommand } from "../../install.js";

describe("agyAdapter — 메타", () => {
  it("id / displayName", () => {
    expect(agyAdapter.id).toBe("agy");
    expect(agyAdapter.displayName).toBe("Antigravity CLI");
  });

  it("installHint — 공식 원라인 설치 명령 (URL 아님 → 폰에서 바로 설치 가능)", () => {
    // URL hint 였을 땐 「가이드 열기」 로만 폴백했지만, 실행 가능한 명령이라 다른 CLI 처럼
    // installHintIsCommand 가 true → iOS 「Mac 에 설치」 버튼 + daemon 자동 설치로 흐른다.
    expect(agyAdapter.installHint).toBe(
      "curl -fsSL https://antigravity.google/cli/install.sh | bash",
    );
    expect(installHintIsCommand(agyAdapter.installHint)).toBe(true);
  });

  it("capability — agy_resume_v1 광고", () => {
    expect(agyAdapter.capabilities()).toContain("agy_resume_v1");
  });

  it("capability — cron_eligible_v1 (예약 픽커 노출)", () => {
    expect(agyAdapter.capabilities()).toContain("cron_eligible_v1");
  });

  it("firstReadyTiming — 로그인 floor 로 첫 입력 지연", () => {
    const t = agyAdapter.firstReadyTiming?.();
    expect(t).toBeDefined();
    // 로그인(~10s) 동안 stdin 이 먹히므로 최소 대기가 그 이상이어야 한다.
    expect(t!.minMs).toBeGreaterThanOrEqual(10_000);
    expect(t!.maxMs).toBeGreaterThan(t!.minMs);
  });
});

describe("agyAdapter.buildSpawnArgs", () => {
  it("아무 ctx 없으면 빈 인자", () => {
    expect(agyAdapter.buildSpawnArgs({ bypassPermissions: false })).toEqual([]);
  });

  it("resumeFrom → --conversation <id> (인자 이름이 claude 와 다름)", () => {
    expect(
      agyAdapter.buildSpawnArgs({
        resumeFrom: "conv-1",
        bypassPermissions: false,
      }),
    ).toEqual(["--conversation", "conv-1"]);
  });

  it("빈 resumeFrom 은 무시", () => {
    expect(
      agyAdapter.buildSpawnArgs({ resumeFrom: "", bypassPermissions: false }),
    ).toEqual([]);
  });

  it("bypassPermissions → --dangerously-skip-permissions", () => {
    expect(agyAdapter.buildSpawnArgs({ bypassPermissions: true })).toEqual([
      "--dangerously-skip-permissions",
    ]);
  });

  it("둘 다 → conversation 가 permission 보다 앞", () => {
    expect(
      agyAdapter.buildSpawnArgs({
        resumeFrom: "conv-2",
        bypassPermissions: true,
      }),
    ).toEqual(["--conversation", "conv-2", "--dangerously-skip-permissions"]);
  });
});
