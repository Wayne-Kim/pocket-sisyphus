/**
 * `copilotAdapter` (GitHub Copilot CLI) 의 인자 빌더 단위 테스트.
 *
 * 회귀 차단의 핵심:
 *  - bypassPermissions → `--allow-all` (도구·경로·URL 확인 전체 우회).
 *  - resumeFrom → `--resume <id>`.
 *  - capability 'copilot_resume_v1' / 'cron_eligible_v1' 광고 — iOS picker 분기용.
 */
import { describe, it, expect } from "vitest";
import { copilotAdapter } from "./index.js";

describe("copilotAdapter — 메타", () => {
  it("id / displayName", () => {
    expect(copilotAdapter.id).toBe("copilot");
    expect(copilotAdapter.displayName).toBe("Copilot CLI");
  });

  it("installHint — npm 글로벌 설치 명령", () => {
    expect(copilotAdapter.installHint).toBe("npm install -g @github/copilot");
  });

  it("capability — copilot_resume_v1 광고", () => {
    expect(copilotAdapter.capabilities()).toContain("copilot_resume_v1");
  });

  it("capability — cron_eligible_v1 (예약 픽커 노출)", () => {
    expect(copilotAdapter.capabilities()).toContain("cron_eligible_v1");
  });

  it("capability — wheel_scroll_v1 (휠로만 스크롤되는 alt-screen TUI → iOS 스크롤 버튼 게이트)", () => {
    // copilot TUI 는 본문을 마우스 휠로만 굴린다(부팅 시 1002+1006 ON, 실측 검증 — index.ts
    // 주석). 이 capability 가 iOS 의 하드코딩 isCopilot 분기를 대체해 스크롤 버튼 노출을 일반화한다.
    expect(copilotAdapter.capabilities()).toContain("wheel_scroll_v1");
  });
});

describe("copilotAdapter.buildSpawnArgs", () => {
  it("아무 ctx 없으면 빈 인자 (마우스 트래킹은 copilot 기본 ON — 휠 스크롤 위해 끄지 않음)", () => {
    expect(copilotAdapter.buildSpawnArgs({ bypassPermissions: false })).toEqual([]);
  });

  it("resumeFrom 만 → --resume <id>", () => {
    expect(
      copilotAdapter.buildSpawnArgs({
        resumeFrom: "sess-1",
        bypassPermissions: false,
      }),
    ).toEqual(["--resume", "sess-1"]);
  });

  it("빈 resumeFrom 은 무시", () => {
    expect(
      copilotAdapter.buildSpawnArgs({ resumeFrom: "", bypassPermissions: false }),
    ).toEqual([]);
  });

  it("bypassPermissions → --allow-all", () => {
    expect(copilotAdapter.buildSpawnArgs({ bypassPermissions: true })).toEqual([
      "--allow-all",
    ]);
  });

  it("bypass + resume 동시 → --allow-all 먼저, 그 뒤 --resume <id>", () => {
    expect(
      copilotAdapter.buildSpawnArgs({
        resumeFrom: "sess-2",
        bypassPermissions: true,
      }),
    ).toEqual(["--allow-all", "--resume", "sess-2"]);
  });
});

describe("copilotAdapter.buildSpawnEnv", () => {
  it("추가 env 없음", () => {
    expect(copilotAdapter.buildSpawnEnv()).toEqual({});
  });
});

describe("copilotAdapter.firstReadyTiming — 부팅 race 보정", () => {
  it("기본 settle(상한 1.2s)보다 넉넉한 floor/상한 — 무인 흐름에서 첫 프롬프트 유실 방지", () => {
    const t = copilotAdapter.firstReadyTiming?.();
    expect(t).toBeDefined();
    // copilot TUI 가 입력 박스를 렌더할 때까지 기다리는 floor — DEFAULT_FIRST_READY.minMs(250) 보다 큼.
    expect(t!.minMs).toBeGreaterThanOrEqual(2000);
    // hard cap 도 기본(1200) 보다 충분히 커서 스플래시가 늦어도 강행 전 settle 기회를 준다.
    expect(t!.maxMs).toBeGreaterThan(1200);
    // idleMs ≤ minMs ≤ maxMs 불변식.
    expect(t!.idleMs).toBeLessThanOrEqual(t!.minMs);
    expect(t!.minMs).toBeLessThanOrEqual(t!.maxMs);
  });
});
