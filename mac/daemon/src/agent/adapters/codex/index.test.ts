/**
 * `codexAdapter` (OpenAI Codex CLI) 의 인자 빌더 단위 테스트.
 *
 * 회귀 차단의 핵심:
 *  - codex 의 `resume` 는 subcommand. top-level OPTION (`--dangerously-bypass-...`)
 *    이 subcommand 보다 *앞* 에 와야 clap 이 받아준다. 순서가 뒤집히면 codex 가
 *    부팅 즉시 에러로 종료 — 사용자에겐 「Codex 세션이 안 켜진다」 회귀로 보임.
 *  - capability 'codex_resume_v1' 광고 — iOS picker 분기용.
 */
import { describe, it, expect } from "vitest";
import { codexAdapter } from "./index.js";

describe("codexAdapter — 메타", () => {
  it("id / displayName", () => {
    expect(codexAdapter.id).toBe("codex");
    expect(codexAdapter.displayName).toBe("Codex CLI");
  });

  it("capability — codex_resume_v1 광고", () => {
    expect(codexAdapter.capabilities()).toContain("codex_resume_v1");
  });

  it("capability — cron_eligible_v1 (예약 픽커 노출)", () => {
    expect(codexAdapter.capabilities()).toContain("cron_eligible_v1");
  });
});

describe("codexAdapter.buildSpawnArgs", () => {
  it("아무 ctx 없으면 빈 인자", () => {
    expect(codexAdapter.buildSpawnArgs({ bypassPermissions: false })).toEqual([]);
  });

  it("resumeFrom 만 → resume <id> subcommand", () => {
    expect(
      codexAdapter.buildSpawnArgs({
        resumeFrom: "uuid-1",
        bypassPermissions: false,
      }),
    ).toEqual(["resume", "uuid-1"]);
  });

  it("빈 resumeFrom 은 무시", () => {
    expect(
      codexAdapter.buildSpawnArgs({ resumeFrom: "", bypassPermissions: false }),
    ).toEqual([]);
  });

  it("bypassPermissions → --dangerously-bypass-approvals-and-sandbox", () => {
    expect(codexAdapter.buildSpawnArgs({ bypassPermissions: true })).toEqual([
      "--dangerously-bypass-approvals-and-sandbox",
    ]);
  });

  it("회귀 차단 — top-level option 이 subcommand 보다 *앞* 에 와야 clap 이 받아준다", () => {
    const args = codexAdapter.buildSpawnArgs({
      resumeFrom: "uuid-2",
      bypassPermissions: true,
    });
    expect(args).toEqual([
      "--dangerously-bypass-approvals-and-sandbox",
      "resume",
      "uuid-2",
    ]);
    // 명시적 인덱스 단언 — 누가 실수로 resume 을 앞으로 옮기는 회귀 차단.
    const flagIdx = args.indexOf("--dangerously-bypass-approvals-and-sandbox");
    const resumeIdx = args.indexOf("resume");
    expect(flagIdx).toBeLessThan(resumeIdx);
  });
});
