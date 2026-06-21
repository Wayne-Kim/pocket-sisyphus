// ─────────────────────────────────────────────────────────────────────────────
// repoPath 기반 git 라우트 — 세션 없이도 동작한다.
//
// 새 세션 생성 스크린(iOS NewSessionSheet)이 «아직 세션이 없는» 상태에서 선택한 레포로
// worktree 를 만들 수 있게 한다. 세션 스코프 라우트(routes/sessions.ts)는 sessionId 로
// repo_path 를 조회할 뿐 git 로직은 동일하므로, 공유 헬퍼(../git/worktree.js)를 함께 쓴다.
//
// 안전: repoPath 는 클라이언트가 보낸 절대경로지만 모든 동작은 git `-C` 안에서만 돌고
// branch/from 은 isValidRef 가 거른다(공유 헬퍼). 임의 경로를 받아도 git 이 아닌 곳이면
// listWorktrees 가 빈 결과 → no_repo 로 떨어진다.
// ─────────────────────────────────────────────────────────────────────────────

import { Hono } from "hono";
import { bearerAuth } from "../auth.js";
import { createWorktree, gitRepoInfo } from "../git/worktree.js";

export const git = new Hono();

git.use("*", bearerAuth);

// 경로가 git 작업트리인지 + 현재 브랜치. ?path=<절대경로>.
//   → { isRepo: boolean, branch: string | null }
// 새 세션 스크린이 «worktree 섹션을 보여줄지» 판단하는 용도. 비-repo 도 200 으로 응답한다
// (에러가 아니라 «아님» 이라는 사실 자체가 답).
git.get("/info", async (c) => {
  const repoPath = c.req.query("path");
  if (!repoPath) return c.json({ error: "path_required" }, 400);
  const info = await gitRepoInfo(repoPath);
  return c.json(info);
});

// worktree 생성. body: { repoPath: string, branch: string, newBranch?: boolean, from?: string }
//   → { path, branch }  (경로는 daemon 이 <repo>.worktrees/<slug> 로 자동 산정)
git.post("/worktrees", async (c) => {
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const repoPath = (body as { repoPath?: unknown }).repoPath;
  if (typeof repoPath !== "string" || repoPath.length === 0) {
    return c.json({ error: "repo_path_required" }, 400);
  }
  const r = await createWorktree(repoPath, body as Record<string, unknown>);
  if (!r.ok) return c.json(r.body, r.status);
  return c.json({ path: r.path, branch: r.branch });
});
