/**
 * git/merge — 순수 git 머지 로직 단위 테스트. 실제 tmp git repo 를 만들어 돌린다 (DB/네트워크
 * 무관). 사전 충돌 탐지의 «읽기 전용» 성질, ff/--no-ff 머지(워크트리/플러밍 양 경로), 충돌
 * 안전망, dirty 보류, 정리, isValidRef 거부를 검증한다.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { previewMerge, performMerge, cleanupMergedSource, parseConflictFiles } from "./merge.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

/** main 브랜치 + 초기 커밋 1개를 가진 tmp repo. */
function mkRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ps-merge-"));
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  git(dir, ["config", "user.email", "test@pocket.local"]);
  git(dir, ["config", "user.name", "Tester"]);
  fs.writeFileSync(path.join(dir, "README.md"), "init\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

/** branch 에서 file 을 content 로 써서 커밋. newBranch 면 현재 HEAD 에서 분기 후. 끝나면 main 복귀. */
function commit(
  dir: string,
  branch: string,
  file: string,
  content: string,
  opts: { newBranch?: boolean; from?: string } = {},
): void {
  if (opts.newBranch) git(dir, ["checkout", "-q", "-b", branch, ...(opts.from ? [opts.from] : [])]);
  else git(dir, ["checkout", "-q", branch]);
  fs.writeFileSync(path.join(dir, file), content);
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", `${branch}: ${file}`]);
  git(dir, ["checkout", "-q", "main"]);
}

let repos: string[] = [];
function repo(): string {
  const r = mkRepo();
  repos.push(r);
  return r;
}
beforeEach(() => {
  repos = [];
});
afterEach(() => {
  for (const r of repos) fs.rmSync(r, { recursive: true, force: true });
});

describe("previewMerge — 읽기 전용 사전 탐지", () => {
  it("source 가 이미 target 에 있으면 up_to_date", async () => {
    const dir = repo();
    // feature 를 main 기준으로 만들되 main 은 그대로 → main 이 feature 의 조상.
    commit(dir, "feature", "a.txt", "A\n", { newBranch: true });
    // main → feature 머지 검사: target=feature 는 source=main 의 후손이므로 up_to_date.
    const p = await previewMerge(dir, "main", "feature");
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.relation).toBe("up_to_date");
  });

  it("target 이 source 의 조상이면 fast_forward", async () => {
    const dir = repo();
    commit(dir, "feature", "a.txt", "A\n", { newBranch: true });
    const p = await previewMerge(dir, "feature", "main");
    expect(p.ok).toBe(true);
    if (p.ok) {
      expect(p.relation).toBe("fast_forward");
      expect(p.conflict).toBe(false);
    }
  });

  it("서로 다른 파일을 바꾼 갈라짐은 diverged + 충돌 없음", async () => {
    const dir = repo();
    commit(dir, "feature", "feat.txt", "feature work\n", { newBranch: true });
    commit(dir, "main", "main.txt", "main work\n");
    const p = await previewMerge(dir, "feature", "main");
    expect(p.ok).toBe(true);
    if (p.ok) {
      expect(p.relation).toBe("diverged");
      expect(p.conflict).toBe(false);
    }
  });

  it("같은 줄을 양쪽이 바꾸면 diverged + 충돌 + 파일 목록", async () => {
    const dir = repo();
    fs.writeFileSync(path.join(dir, "shared.txt"), "base\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-q", "-m", "add shared"]);
    commit(dir, "feature", "shared.txt", "feature edit\n", { newBranch: true });
    commit(dir, "main", "shared.txt", "main edit\n");
    const p = await previewMerge(dir, "feature", "main");
    expect(p.ok).toBe(true);
    if (p.ok) {
      expect(p.relation).toBe("diverged");
      expect(p.conflict).toBe(true);
      expect(p.conflictFiles).toContain("shared.txt");
    }
  });

  it("사전 탐지는 repo 를 변경하지 않는다 (refs/worktree/MERGE_HEAD 불변)", async () => {
    const dir = repo();
    fs.writeFileSync(path.join(dir, "shared.txt"), "base\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-q", "-m", "add shared"]);
    commit(dir, "feature", "shared.txt", "feature edit\n", { newBranch: true });
    commit(dir, "main", "shared.txt", "main edit\n");

    const refsBefore = git(dir, ["show-ref"]);
    const statusBefore = git(dir, ["status", "--porcelain"]);
    await previewMerge(dir, "feature", "main");
    const refsAfter = git(dir, ["show-ref"]);
    const statusAfter = git(dir, ["status", "--porcelain"]);
    expect(refsAfter).toBe(refsBefore);
    expect(statusAfter).toBe(statusBefore);
    expect(fs.existsSync(path.join(dir, ".git", "MERGE_HEAD"))).toBe(false);
  });

  it("공통 조상 없는 히스토리는 unrelated", async () => {
    const dir = repo();
    git(dir, ["checkout", "-q", "--orphan", "orphan"]);
    fs.writeFileSync(path.join(dir, "orphan.txt"), "orphan\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-q", "-m", "orphan root"]);
    git(dir, ["checkout", "-q", "main"]);
    const p = await previewMerge(dir, "orphan", "main");
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.relation).toBe("unrelated");
  });

  it("잘못된 브랜치명/주입은 invalid_ref 로 거부", async () => {
    const dir = repo();
    const p1 = await previewMerge(dir, "--upload-pack=evil", "main");
    expect(p1.ok).toBe(false);
    if (!p1.ok) expect(p1.error).toBe("invalid_ref");
    const p2 = await previewMerge(dir, "feature", "a..b");
    expect(p2.ok).toBe(false);
    if (!p2.ok) expect(p2.error).toBe("invalid_ref");
  });

  it("존재하지 않는 브랜치는 not_found", async () => {
    const dir = repo();
    const p = await previewMerge(dir, "nope", "main");
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.error).toBe("not_found");
  });
});

describe("performMerge — Case A (target 체크아웃됨)", () => {
  it("fast-forward 머지 (main 체크아웃)", async () => {
    const dir = repo();
    commit(dir, "feature", "a.txt", "A\n", { newBranch: true });
    const featureSha = git(dir, ["rev-parse", "feature"]);
    const out = await performMerge(dir, "feature", "main");
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.result).toBe("fast_forward");
    expect(git(dir, ["rev-parse", "main"])).toBe(featureSha);
    expect(git(dir, ["status", "--porcelain"])).toBe("");
  });

  it("갈라진 깨끗한 머지는 --no-ff 머지 커밋 (부모 2개)", async () => {
    const dir = repo();
    commit(dir, "feature", "feat.txt", "feature\n", { newBranch: true });
    commit(dir, "main", "main.txt", "main\n");
    const out = await performMerge(dir, "feature", "main");
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.result).toBe("merged");
    const parents = git(dir, ["rev-list", "--parents", "-n", "1", "main"]).split(" ");
    expect(parents.length).toBe(3); // 커밋 + 부모 2
    // 두 파일 모두 머지 결과에 존재.
    expect(fs.existsSync(path.join(dir, "feat.txt"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "main.txt"))).toBe(true);
  });

  it("noFF=true 면 fast-forward 가능해도 머지 커밋 강제", async () => {
    const dir = repo();
    commit(dir, "feature", "a.txt", "A\n", { newBranch: true });
    const out = await performMerge(dir, "feature", "main", { noFF: true });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.result).toBe("merged");
    const parents = git(dir, ["rev-list", "--parents", "-n", "1", "main"]).split(" ");
    expect(parents.length).toBe(3);
  });

  it("실제 충돌이면 깨끗이 되돌리고 conflict (절반 머지 상태 안 남김)", async () => {
    const dir = repo();
    fs.writeFileSync(path.join(dir, "shared.txt"), "base\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-q", "-m", "add shared"]);
    commit(dir, "feature", "shared.txt", "feature\n", { newBranch: true });
    commit(dir, "main", "shared.txt", "main\n");
    const mainBefore = git(dir, ["rev-parse", "main"]);
    const out = await performMerge(dir, "feature", "main");
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toBe("conflict");
      if (out.reason === "conflict") expect(out.conflictFiles).toContain("shared.txt");
    }
    // main 불변 + 워크트리 깨끗 + MERGE_HEAD 없음.
    expect(git(dir, ["rev-parse", "main"])).toBe(mainBefore);
    expect(git(dir, ["status", "--porcelain"])).toBe("");
    expect(fs.existsSync(path.join(dir, ".git", "MERGE_HEAD"))).toBe(false);
  });

  it("target 워크트리가 dirty 면 blocked (사용자 작업 보호)", async () => {
    const dir = repo();
    commit(dir, "feature", "a.txt", "A\n", { newBranch: true });
    // main 워크트리를 dirty 로.
    fs.writeFileSync(path.join(dir, "README.md"), "uncommitted change\n");
    const out = await performMerge(dir, "feature", "main");
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe("blocked");
  });

  it("이미 합쳐진 source 는 up_to_date (멱등)", async () => {
    const dir = repo();
    commit(dir, "feature", "a.txt", "A\n", { newBranch: true });
    await performMerge(dir, "feature", "main"); // 1차 ff
    const out = await performMerge(dir, "feature", "main"); // 2차 — 이미 들어감
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.result).toBe("up_to_date");
  });
});

describe("performMerge — Case B (target 체크아웃 안 됨, 플러밍)", () => {
  it("체크아웃 안 된 release/* 로 fast-forward (update-ref)", async () => {
    const dir = repo();
    // release/x 를 main 에서 분기만 하고 체크아웃하지 않는다 (main 체크아웃 유지).
    git(dir, ["branch", "release/x"]);
    // feature 를 release/x 에서 분기해 한 커밋 앞서게.
    commit(dir, "feature", "a.txt", "A\n", { newBranch: true, from: "release/x" });
    const featureSha = git(dir, ["rev-parse", "feature"]);
    const out = await performMerge(dir, "feature", "release/x");
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.result).toBe("fast_forward");
    expect(git(dir, ["rev-parse", "release/x"])).toBe(featureSha);
    // main 워크트리는 건드리지 않음.
    expect(git(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
    expect(git(dir, ["status", "--porcelain"])).toBe("");
  });

  it("체크아웃 안 된 target 으로 갈라진 머지는 플러밍 merge 커밋", async () => {
    const dir = repo();
    git(dir, ["branch", "release/y"]);
    // release/y 에 커밋 하나 (체크아웃 없이는 못 하므로 잠깐 체크아웃 후 main 복귀).
    git(dir, ["checkout", "-q", "release/y"]);
    fs.writeFileSync(path.join(dir, "rel.txt"), "rel\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-q", "-m", "rel work"]);
    git(dir, ["checkout", "-q", "main"]);
    // feature 를 공통 base 에서 분기해 다른 파일 커밋 → release/y 와 갈라짐(깨끗).
    commit(dir, "feature", "feat.txt", "feat\n", { newBranch: true, from: "main" });

    const out = await performMerge(dir, "feature", "release/y");
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.result).toBe("merged");
    const parents = git(dir, ["rev-list", "--parents", "-n", "1", "release/y"]).split(" ");
    expect(parents.length).toBe(3);
    // main 체크아웃/워크트리 불변.
    expect(git(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
    expect(git(dir, ["status", "--porcelain"])).toBe("");
  });
});

describe("cleanupMergedSource", () => {
  it("머지된 source 워크트리 + 브랜치를 정리", async () => {
    const dir = repo();
    commit(dir, "po/abc123", "a.txt", "A\n", { newBranch: true });
    // po/abc123 를 인접 워크트리로 체크아웃.
    const wtPath = path.join(dir, "..", `${path.basename(dir)}-po`);
    git(dir, ["worktree", "add", wtPath, "po/abc123"]);
    repos.push(wtPath); // afterEach 정리 보강
    // main 에 머지(ff) 후 정리.
    await performMerge(dir, "po/abc123", "main");
    const c = await cleanupMergedSource(dir, "po/abc123");
    expect(c.removedWorktree).toBe(true);
    expect(c.deletedBranch).toBe(true);
    // 브랜치가 사라졌는지.
    const branches = git(dir, ["branch", "--list", "po/abc123"]);
    expect(branches).toBe("");
  });

  it("메인 워크트리/현재 브랜치는 건드리지 않는다", async () => {
    const dir = repo();
    // main 을 source 로 정리 시도 — 메인 가드로 워크트리 제거 안 함.
    const c = await cleanupMergedSource(dir, "main");
    expect(c.removedWorktree).toBe(false);
  });

  it("잘못된 브랜치명은 정리 거부", async () => {
    const dir = repo();
    const c = await cleanupMergedSource(dir, "--evil");
    expect(c.removedWorktree).toBe(false);
    expect(c.deletedBranch).toBe(false);
  });
});

describe("parseConflictFiles", () => {
  it("3-인자 merge-tree 충돌 섹션에서 파일명 추출", () => {
    const out = [
      "changed in both",
      "  base   100644 78981922613b2afb6025042ff6bd878ac1994e85 f",
      "  our    100644 60a2a01cf33a5dcfee46d0ed37b60c8f645ac71b f",
      "  their  100644 6670a6874dfd39d3724f7d880926d90f3a80c8c3 f",
      "@@ -1,2 +1,6 @@",
    ].join("\n");
    expect(parseConflictFiles(out)).toEqual(["f"]);
  });
});
