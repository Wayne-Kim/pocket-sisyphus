/**
 * buildNodePrompt 의 «실패 사유를 먹인 재시도» 동작 단위 테스트 (po 자기교정 브리프).
 *
 *  - 첫 시도(priorFailure 없음/빈 문자열) → 프롬프트에 «이전 시도 실패» 섹션이 없다(무회귀).
 *  - 2회차(priorFailure 있음) → «직전 시도는 다음 이유로 통과하지 못했다: …» 가 본문 앞에 붙는다.
 *  - harvestTaskFolder 가 verdict.json 의 summary 를 verdictSummary 로 수확한다.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildNodePrompt, harvestTaskFolder, ensureTaskFolder } from "./task-folder.js";

describe("buildNodePrompt priorFailure (실패 사유 먹인 재시도)", () => {
  const base = {
    prompt: "기능을 구현하라",
    thisFolderRel: ".posiworkflow/wf/run/node",
    parents: [],
    runToken: "deadbeef",
    wantsVerdict: false,
  };

  it("첫 시도(priorFailure 없음) → 실패 사유 섹션이 없다", () => {
    const out = buildNodePrompt(base);
    expect(out).not.toContain("이전 시도 실패");
    expect(out).not.toContain("통과하지 못했다");
    expect(out).toContain("기능을 구현하라");
  });

  it("빈 priorFailure → 종전과 동일(무회귀)", () => {
    const out = buildNodePrompt({ ...base, priorFailure: "   " });
    expect(out).not.toContain("이전 시도 실패");
  });

  it("2회차(priorFailure 있음) → 직전 실패 사유가 본문 앞에 붙는다", () => {
    const out = buildNodePrompt({ ...base, priorFailure: "테스트 3개 실패: null 역참조" });
    expect(out).toContain("[이전 시도 실패] 직전 시도는 다음 이유로 통과하지 못했다:");
    expect(out).toContain("테스트 3개 실패: null 역참조");
    // 실패 사유가 노드 본문 프롬프트보다 «앞» 에 와야 한다.
    expect(out.indexOf("통과하지 못했다")).toBeLessThan(out.indexOf("기능을 구현하라"));
  });
});

describe("harvestTaskFolder verdictSummary 수확", () => {
  let repo: string;
  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "pswf-"));
  });
  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("verdict.json 의 summary 를 verdictSummary 로 읽는다", async () => {
    const rel = ".posiworkflow/wf/run/node";
    ensureTaskFolder(repo, rel);
    await fsp.writeFile(path.join(repo, rel, "verdict.json"), JSON.stringify({ pass: false, summary: "린트 에러 12건" }));
    const h = await harvestTaskFolder(repo, rel);
    expect(h.verdictPass).toBe(false);
    expect(h.verdictSummary).toBe("린트 에러 12건");
  });

  it("summary 없으면 verdictSummary 는 null", async () => {
    const rel = ".posiworkflow/wf/run/node";
    ensureTaskFolder(repo, rel);
    await fsp.writeFile(path.join(repo, rel, "verdict.json"), JSON.stringify({ pass: true }));
    const h = await harvestTaskFolder(repo, rel);
    expect(h.verdictSummary).toBeNull();
  });
});
