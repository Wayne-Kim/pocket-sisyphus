import { describe, expect, it } from "vitest";
import { checkGhForCollect, hasGithubRemote } from "./gh.js";

describe("hasGithubRemote", () => {
  it("https 원격을 GitHub 으로 인식한다", () => {
    const out =
      "origin\thttps://github.com/acme/widget.git (fetch)\n" +
      "origin\thttps://github.com/acme/widget.git (push)\n";
    expect(hasGithubRemote(out)).toBe(true);
  });

  it("ssh 원격을 GitHub 으로 인식한다", () => {
    const out = "origin\tgit@github.com:acme/widget.git (fetch)\n";
    expect(hasGithubRemote(out)).toBe(true);
  });

  it("GitLab / 로컬 원격은 GitHub 이 아니다", () => {
    expect(hasGithubRemote("origin\tgit@gitlab.com:acme/x.git (fetch)\n")).toBe(false);
    expect(hasGithubRemote("origin\t/Users/me/mirror.git (fetch)\n")).toBe(false);
    expect(hasGithubRemote("")).toBe(false);
  });
});

describe("checkGhForCollect", () => {
  it("비-git 디렉토리는 githubRemote=false 로 (점검 실패 아님) — gh 프로브 생략", async () => {
    // /tmp 는 git 레포가 아니므로 git remote 가 실패 → githubRemote=false 로 조용히 처리.
    const result = await checkGhForCollect("/tmp");
    expect(result).not.toBeNull();
    expect(result?.githubRemote).toBe(false);
    // 로컬 origin 점검이면 feedbackRepo 메타는 생략된다.
    expect(result?.feedbackRepo).toBeUndefined();
  });

  it("피드백 repo 가 주어지면 로컬 git 과 무관하게 githubRemote=true + repo 메타를 채운다", async () => {
    // /tmp 는 비-git 이라 로컬 origin 점검이면 githubRemote=false 지만, 피드백 repo 모드는
    // «명시된 GitHub 타깃» 이라 항상 githubRemote=true 이고 feedbackRepo 를 echo 한다.
    // (installed/authed/accessible 은 실행 환경의 gh 유무에 따라 달라지므로 단정하지 않는다 —
    //  단, runProbe 타임아웃이 아닌 이상 객체를 돌려준다.)
    const repo = "Wayne-Kim/pocket-sisyphus";
    const result = await checkGhForCollect("/tmp", repo);
    if (result === null) return; // gh 프로브가 타임아웃(불확실)이면 조용히 — 드묾.
    expect(result.githubRemote).toBe(true);
    expect(result.feedbackRepo).toBe(repo);
    expect(typeof result.feedbackRepoAccessible).toBe("boolean");
  });

  it("빈/공백 피드백 repo 는 로컬 origin 점검으로 폴백한다 (미설정과 동일)", async () => {
    const result = await checkGhForCollect("/tmp", "   ");
    expect(result).not.toBeNull();
    expect(result?.githubRemote).toBe(false);
    expect(result?.feedbackRepo).toBeUndefined();
  });
});
