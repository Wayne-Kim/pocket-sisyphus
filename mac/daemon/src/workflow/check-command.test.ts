/**
 * check-command 실행기 단위 테스트 — 종료 코드로 pass/fail 을 가르고, 실패 출력의 «마지막
 * 의미 있는 줄» 을 뽑는지, 타임아웃·잘못된 명령을 fail 로 흡수하는지 검증.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCheckCommand, lastMeaningfulLines } from "./check-command.js";

const repo = mkdtempSync(join(tmpdir(), "ps-check-"));

describe("runCheckCommand — 종료 코드 게이트", () => {
  it("종료 코드 0 → pass", async () => {
    const r = await runCheckCommand(repo, "exit 0");
    expect(r.pass).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.timedOut).toBe(false);
  });

  it("비0 종료 코드 → fail (출력 캡처)", async () => {
    const r = await runCheckCommand(repo, "echo 'boom line' 1>&2; exit 3");
    expect(r.pass).toBe(false);
    expect(r.exitCode).toBe(3);
    expect(r.output).toContain("boom line");
  });

  it("cwd 는 넘긴 repoPath — 그 디렉터리에서만 돈다", async () => {
    const r = await runCheckCommand(repo, "touch cwd_marker.txt");
    expect(r.pass).toBe(true);
    expect(existsSync(join(repo, "cwd_marker.txt"))).toBe(true);
  });

  it("타임아웃 → fail + timedOut", async () => {
    const r = await runCheckCommand(repo, "sleep 5", { timeoutMs: 150 });
    expect(r.pass).toBe(false);
    expect(r.timedOut).toBe(true);
  });
});

describe("lastMeaningfulLines — 실패 사유 꼬리", () => {
  it("빈 줄을 거르고 끝에서 n 줄을 뽑는다", () => {
    const out = "build start\n\n  \nERROR a\nERROR b\n\n";
    expect(lastMeaningfulLines(out, 2)).toBe("ERROR a\nERROR b");
  });

  it("줄 수가 적으면 있는 만큼만", () => {
    expect(lastMeaningfulLines("only line\n", 5)).toBe("only line");
  });
});
