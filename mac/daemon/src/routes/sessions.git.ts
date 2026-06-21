import type { Hono } from "hono";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { parsePorcelainZ, type GitStatusEntry } from "./git-status-parser.js";
import { isValidRef, listWorktrees, createWorktree } from "../git/worktree.js";
import { getSession, resolveRepoRelative, FS_FILE_MAX_BYTES, FS_TEXT_MAX_BYTES } from "./sessions-shared.js";

const execFileAsync = promisify(execFile);

export function registerGitRoutes(sessions: Hono): void {
  // diff 본문 cap — 모바일 메모리 부담 회피. 한 파일 200KB 이상이면 잘라서 보낸다.
  const GIT_DIFF_MAX_BYTES = 200 * 1024;

  /**
   * `git diff --numstat HEAD -- <paths>` 로 path 별 +/- 라인 수를 한꺼번에 조회한다.
   * untracked 는 결과에 없음 — 호출자가 0/0 으로 흡수한다.
   *
   * 출력 형식: `ADD\tDEL\tPATH\n` 또는 binary 면 `-\t-\tPATH\n`.
   */
  async function getNumstat(
    repoPath: string,
    paths: string[],
  ): Promise<Map<string, { additions: number; deletions: number; binary: boolean }>> {
    const map = new Map<string, { additions: number; deletions: number; binary: boolean }>();
    if (paths.length === 0) return map;
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["-C", repoPath, "diff", "--numstat", "HEAD", "--", ...paths],
        { timeout: 5000, maxBuffer: 4 * 1024 * 1024 },
      );
      for (const line of stdout.split("\n")) {
        if (!line) continue;
        const [a, d, ...rest] = line.split("\t");
        const path = rest.join("\t");
        const binary = a === "-" || d === "-";
        map.set(path, {
          additions: binary ? 0 : parseInt(a ?? "0", 10) || 0,
          deletions: binary ? 0 : parseInt(d ?? "0", 10) || 0,
          binary,
        });
      }
    } catch {
      // 첫 commit 이전 / HEAD 없음 등은 무시 — UI 가 0/0 으로 흡수.
    }
    return map;
  }

  // 모바일 ChatView 상태바용 — 세션의 repo_path 에서 현재 git 브랜치를 조회.
  // `symbolic-ref --short HEAD` 로 현재 브랜치명을 얻는다 — 커밋 0개(갓 git init) 에서도 동작.
  // 분리된 HEAD 면 symbolic-ref 가 실패 → 짧은 sha(@xxxxxxx)로 보여준다 (사용자는 «어떤
  // commit 에 있는지» 만 알면 충분). repo_path 가 git repo 가 아니거나 git 자체가 없으면
  // { branch: null } 로 조용히 응답.
  sessions.get("/:id/git/branch", async (c) => {
    const id = c.req.param("id");
    const session = getSession(id);
    if (!session) return c.json({ error: "not_found" }, 404);

    const repoPath = session.repo_path;
    if (!repoPath) return c.json({ branch: null });

    // `symbolic-ref --short HEAD` 를 먼저 — 이게 «현재 브랜치» 의 정석. 갓 `git init` 한
    // 커밋 0개 repo(unborn HEAD)에서도 `main` 을 그대로 반환(exit 0)한다. 옛 구현이 쓰던
    // `rev-parse --abbrev-ref HEAD` 는 커밋이 없으면 fatal(exit 128) → null 로 흡수돼
    // 「git init 했는데도 Git 없음」 으로 보이던 버그의 원인이었다.
    // 실패하면(=detached HEAD 이거나 repo 가 아님) 짧은 sha 로 fallback.
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["-C", repoPath, "symbolic-ref", "--short", "HEAD"],
        { timeout: 3000, maxBuffer: 64 * 1024 },
      );
      const name = stdout.trim();
      if (name) return c.json({ branch: name });
      return c.json({ branch: null });
    } catch {
      // symbolic-ref 실패 — detached HEAD(커밋 있음)면 짧은 sha 로, 그 외(repo 아님/git
      // 미설치/경로 없음)는 «브랜치 표시 없음» 으로 흡수.
      try {
        const { stdout: shaOut } = await execFileAsync(
          "git",
          ["-C", repoPath, "rev-parse", "--short", "HEAD"],
          { timeout: 3000, maxBuffer: 64 * 1024 },
        );
        const sha = shaOut.trim();
        return c.json({ branch: sha ? `@${sha}` : null });
      } catch {
        return c.json({ branch: null });
      }
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 모바일 ChatView 상태바 + Diff 시트 — 세션의 repo_path 에서 커밋되지 않은
  // 변경점을 조회한다.
  //
  // 두 엔드포인트가 한 쌍:
  //   GET .../git/status        — 파일 목록 + 가벼운 +/- 통계 (상태바 카운트 + 시트 리스트)
  //   GET .../git/diff?path=…   — 한 파일의 unified diff 본문 (시트 상세)
  //
  // 모두 repo_path 가 git repo 가 아니거나 git 자체가 없을 때 조용히 빈 응답을
  // 돌려준다 — iOS 측 UI 가 슬롯을 숨기는 것으로 흡수.
  // ─────────────────────────────────────────────────────────────────────────────

  // 모바일 ChatView 상태바 + Diff 시트의 1단계 — 커밋되지 않은 파일 목록과 가벼운 통계.
  // 응답: { files: [{ path, status, additions, deletions, binary, origPath? }], total }
  // repo 가 아님 / git 미설치 → { files: [], total: 0 } (조용히).
  sessions.get("/:id/git/status", async (c) => {
    const id = c.req.param("id");
    const session = getSession(id);
    if (!session) return c.json({ error: "not_found" }, 404);

    const repoPath = session.repo_path;
    if (!repoPath) return c.json({ files: [], total: 0 });

    let entries: GitStatusEntry[] = [];
    try {
      // --untracked-files=all 필수: 기본값(normal)은 untracked 디렉터리를
      // "foo/" 한 줄로 접어버려 새 폴더 안의 개별 파일이 UI 에 안 보인다.
      const { stdout } = await execFileAsync(
        "git",
        ["-C", repoPath, "status", "--porcelain=v1", "-z", "--untracked-files=all"],
        { timeout: 5000, maxBuffer: 4 * 1024 * 1024 },
      );
      entries = parsePorcelainZ(stdout);
    } catch {
      return c.json({ files: [], total: 0 });
    }

    // numstat 은 tracked path 에 대해서만 의미가 있다. untracked('??') 와 deleted 는 제외하고
    // 한 번에 조회 — 모바일 UI 의 «+12 −3» 칩 표시용 가벼운 통계.
    const trackedPaths = entries
      .filter((e) => e.status !== "??" && !e.status.startsWith("D"))
      .map((e) => e.path);
    const stats = await getNumstat(repoPath, trackedPaths);

    const files = entries.map((e) => {
      const s = stats.get(e.path);
      return {
        path: e.path,
        status: e.status,
        additions: s?.additions ?? 0,
        deletions: s?.deletions ?? 0,
        binary: s?.binary ?? false,
        ...(e.origPath ? { origPath: e.origPath } : {}),
      };
    });

    return c.json({ files, total: files.length });
  });

  // 한 파일의 unified diff 본문. tracked 면 `git diff HEAD -- <path>` (staged+worktree
  // 통합) — 사용자가 보고 싶은 "마지막 커밋과의 차이". untracked 는 별도 가공해서 가짜
  // unified diff 를 만들어 보낸다 (전 라인 +). binary 는 본문을 생략하고 binary=true.
  sessions.get("/:id/git/diff", async (c) => {
    const id = c.req.param("id");
    const session = getSession(id);
    if (!session) return c.json({ error: "not_found" }, 404);

    const repoPath = session.repo_path;
    if (!repoPath) return c.json({ error: "no_repo" }, 404);

    const path = c.req.query("path");
    if (!path) return c.json({ error: "path_required" }, 400);

    // 보안: 절대경로/상위참조 차단. repo_path 안의 상대경로만 받는다.
    if (path.startsWith("/") || path.includes("..")) {
      return c.json({ error: "invalid_path" }, 400);
    }

    // untracked 인지 한 번 확인 — status 결과를 한 번 더 부르긴 무겁지만, 정확성 우선.
    // 평소 경로(tracked)는 git diff 가 untracked 를 무시하므로 빈 본문이 나와 사용자가 혼란.
    let isUntracked = false;
    try {
      // --untracked-files=all: 새 폴더 안 개별 파일의 디프 요청도 정확히 ?? 로
      // 잡으려면 필요. 없으면 디렉터리("foo/")로만 접혀 path 매칭이 어긋나고,
      // tracked 로 오인해 빈 디프가 떠버린다.
      const { stdout } = await execFileAsync(
        "git",
        ["-C", repoPath, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--", path],
        { timeout: 3000, maxBuffer: 256 * 1024 },
      );
      const entries = parsePorcelainZ(stdout);
      isUntracked = entries.some((e) => e.status === "??" && e.path === path);
    } catch {
      // status 가 실패하면 tracked 로 가정하고 아래 diff 로 진행한다.
    }

    if (isUntracked) {
      // 파일을 직접 읽어 가짜 unified diff 합성. binary 일 가능성도 있어 NUL 검출.
      try {
        const fs = await import("node:fs/promises");
        // 심볼릭 링크로 repo 밖(예: ~/.ssh/id_rsa, /etc/*)을 가리키는 untracked path 차단.
        // 기존엔 startsWith("/")||includes("..") 문자열 검사 + 문자열 연결로 repo 밖 파일이
        // 읽혔다 → fs/file 등과 동일하게 resolveRepoRelative 의 realpath prefix 검증을 거친다.
        const r = await resolveRepoRelative(repoPath, path);
        if (!r.ok) return c.json({ error: r.error }, r.error === "no_repo" ? 404 : 400);
        const buf = await fs.readFile(r.abs);
        // 가벼운 binary 휴리스틱 — 앞 8KB 안에 NUL 이 있으면 binary 로 본다.
        const slice = buf.subarray(0, 8192);
        const isBinary = slice.includes(0);
        if (isBinary) {
          return c.json({ path, diff: "", binary: true, truncated: false, untracked: true });
        }
        const text = buf.toString("utf8");
        const lines = text.split("\n");
        // 마지막 빈 줄(파일 끝 newline) 은 +로 표시할 필요 없음.
        const last = lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
        const body =
          `--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${last} @@\n` +
          lines.slice(0, last).map((l) => `+${l}`).join("\n") +
          (lines.slice(0, last).length > 0 ? "\n" : "");
        const truncated = body.length > GIT_DIFF_MAX_BYTES;
        return c.json({
          path,
          diff: truncated ? body.slice(0, GIT_DIFF_MAX_BYTES) : body,
          binary: false,
          truncated,
          untracked: true,
        });
      } catch {
        return c.json({ path, diff: "", binary: false, truncated: false, untracked: true });
      }
    }

    // tracked — staged+worktree 통합 diff. 색 코드는 빼고, no-prefix 는 unified diff 의
    // 표준 `a/`,`b/` 헤더가 사라져서 파서/디스플레이 단순화에 유리하지만 사용자가 익숙한
    // 형식을 유지하기 위해 그대로 둔다.
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["-C", repoPath, "diff", "--no-color", "HEAD", "--", path],
        { timeout: 5000, maxBuffer: 4 * 1024 * 1024 },
      );
      const body = stdout ?? "";
      // binary diff 는 본문에 "Binary files ... differ" 한 줄만 나온다. 그 경우 본문 생략.
      const binary = /^Binary files .* differ$/m.test(body);
      if (binary) {
        return c.json({ path, diff: "", binary: true, truncated: false, untracked: false });
      }
      const truncated = body.length > GIT_DIFF_MAX_BYTES;
      return c.json({
        path,
        diff: truncated ? body.slice(0, GIT_DIFF_MAX_BYTES) : body,
        binary: false,
        truncated,
        untracked: false,
      });
    } catch {
      return c.json({ path, diff: "", binary: false, truncated: false, untracked: false });
    }
  });

  // 모바일 파일 브라우저 / viewer 용 — 세션 repo_path 아래의 디렉토리·파일을 읽기 전용으로 노출.
  // 보안 모델:
  //   - 절대경로 / `..` 토큰 차단 (diff 와 동일 패턴).
  //   - 심볼릭 링크가 repo 밖을 가리키면 거부 — realpath 로 prefix 검증.
  //   - `.git/` 디렉토리는 listing 에서 숨김 (실수 노출 방지). 그 안의 파일 read 도 거부.
  //   - 응답 크기 cap — 텍스트 1MB, 이미지 5MB. 초과 시 truncated 또는 too_large.

  // 특정 git ref 의 파일 내용 (주로 HEAD) — 이미지 diff 의 «변경 전» 측에서 사용.
  // 응답은 fs/file 과 동일 형식. ref 가 없는(HEAD 없는 신규 repo) 경우 not_found.
  sessions.get("/:id/git/blob", async (c) => {
    const id = c.req.param("id");
    const session = getSession(id);
    if (!session) return c.json({ error: "not_found" }, 404);

    const repoPath = session.repo_path;
    if (!repoPath) return c.json({ error: "no_repo" }, 404);

    const queryPath = c.req.query("path");
    if (!queryPath) return c.json({ error: "path_required" }, 400);

    const r = await resolveRepoRelative(repoPath, queryPath);
    if (!r.ok) return c.json({ error: r.error }, 400);

    const refRaw = c.req.query("ref") ?? "HEAD";
    // 보안: ref 도 외부 인자 — `..` 같은 path-traversal 토큰은 git 의 rev-parse 가 막아주지만
    // shell escape 가능성을 줄이기 위해 토큰 자체를 좁힌다 (영숫자 / `_` `/` `-` `.` `^` `~`).
    if (!/^[A-Za-z0-9_./^~-]{1,200}$/.test(refRaw)) {
      return c.json({ error: "invalid_ref" }, 400);
    }
    const spec = `${refRaw}:${r.rel}`;

    // 1) 사이즈 체크 — cat-file -s 로 먼저 cap 검사. 큰 파일을 통째로 받은 뒤에 거절하면 메모리 낭비.
    let size: number;
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["-C", repoPath, "cat-file", "-s", spec],
        { timeout: 5000, maxBuffer: 64 * 1024 },
      );
      size = parseInt(stdout.trim(), 10);
      if (!Number.isFinite(size)) throw new Error("bad_size");
    } catch {
      return c.json({ error: "not_found" }, 404);
    }
    if (size > FS_FILE_MAX_BYTES) {
      return c.json({ error: "too_large", size, max: FS_FILE_MAX_BYTES }, 413);
    }

    let buf: Buffer;
    try {
      // raw bytes 가 필요 — encoding 미지정으로 호출하면 stdout 이 Buffer.
      const { stdout } = await execFileAsync(
        "git",
        ["-C", repoPath, "cat-file", "blob", spec],
        { timeout: 5000, maxBuffer: FS_FILE_MAX_BYTES + 4096, encoding: "buffer" },
      );
      buf = stdout as unknown as Buffer;
    } catch {
      return c.json({ error: "not_found" }, 404);
    }

    const ext = r.rel.toLowerCase().split(".").pop() ?? "";
    const imageExt: Record<string, string> = {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      webp: "image/webp",
      heic: "image/heic",
      heif: "image/heif",
      bmp: "image/bmp",
      tiff: "image/tiff",
      tif: "image/tiff",
      svg: "image/svg+xml",
    };
    if (imageExt[ext]) {
      return c.json({
        path: r.rel,
        ref: refRaw,
        size,
        encoding: "base64",
        contentType: imageExt[ext],
        content: buf.toString("base64"),
        truncated: false,
      });
    }

    const head = buf.subarray(0, Math.min(8192, buf.length));
    const isBinary = head.includes(0);
    if (isBinary) {
      return c.json({
        path: r.rel,
        ref: refRaw,
        size,
        encoding: "base64",
        contentType: "application/octet-stream",
        content: buf.toString("base64"),
        truncated: false,
      });
    }
    const truncated = buf.length > FS_TEXT_MAX_BYTES;
    const sliced = truncated ? buf.subarray(0, FS_TEXT_MAX_BYTES) : buf;
    return c.json({
      path: r.rel,
      ref: refRaw,
      size,
      encoding: "utf8",
      contentType: "text/plain",
      content: sliced.toString("utf8"),
      truncated,
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 모바일 BranchSheet — 브랜치 목록 / 전환 / 생성 + git worktree 관리.
  //
  // 한 세션은 하나의 repo_path(에이전트 cwd)에 묶여 있다. 여러 브랜치를 병렬로 작업하려면
  // in-place checkout(미커밋 변경이 있으면 실패하고 현재 세션 작업 디렉토리를 흔든다) 대신
  // worktree(인접 디렉토리에 다른 브랜치를 동시 체크아웃)가 자연스럽다 — 새 worktree 경로로
  // 새 세션을 만들면 원래 세션을 건드리지 않고 다른 브랜치를 작업할 수 있다.
  //
  // 안전: 모든 mutating 동작은 repo_path 안에서 `-C` 로만 돈다. execFile 은 shell 을 거치지
  // 않으므로 shell 주입은 없고, 남는 위협은 «`-` 로 시작하는 인자가 git 플래그로 해석되는»
  // argument injection 뿐 → isValidRef 가 거른다. worktree 삭제는 git 이 실제로 추적 중인
  // path 만(목록 대조), 그것도 main / 현재 세션 worktree 가 아닐 때만 허용한다.
  // ─────────────────────────────────────────────────────────────────────────────

  // isValidRef / WorktreeEntry / parseWorktreeList / listWorktrees 는 ../git/worktree.js 로
  // 옮겨 새 세션 스크린의 repoPath 기반 worktree 생성(routes/git.ts)과 코드를 공유한다.
  // (파일 상단 import 참고.) samePath 는 세션 라우트 전용이라 여기 남는다.

  /** 두 경로가 같은 worktree 를 가리키는지 — realpath 정규화 후 비교. */
  async function samePath(a: string, b: string | null): Promise<boolean> {
    if (!b) return false;
    const fs = await import("node:fs/promises");
    try {
      return (await fs.realpath(a)) === (await fs.realpath(b));
    } catch {
      return a === b;
    }
  }

  // 브랜치 목록 — 로컬(refs/heads) + 원격(refs/remotes). 응답:
  //   { current: string|null, local: [Branch], remote: [Branch] }
  //   Branch = { name, sha, upstream: string|null, subject, current }
  // current 는 git/branch 와 동일하게 symbolic-ref 로 구한다(unborn HEAD 도 main 반환).
  // 비-repo / git 미설치 → 모두 비고 current=null.
  //
  // 원격 목록은 refs/remotes(로컬 캐시) 를 읽기 «전에» git fetch --prune 을 best-effort 로
  // 한 번 돌려 최신화한다 — 안 그러면 (a) 원격에 새로 생긴 브랜치가 안 보이고 (b) 원격에서
  // 삭제된 브랜치의 유령 ref 가 계속 남는다. fetch 는 네트워크/인증 실패·타임아웃이어도 무시하고
  // 캐시된 ref 로 폴백한다(목록이 절대 멈추지 않게). 폴링이 아니라 시트 열기/당겨서 새로고침에서만
  // 호출되므로 매 호출 fetch 가 허용된다. ?fetch=0 으로 명시적으로 끌 수 있다(폴백/디버그용).
  sessions.get("/:id/git/branches", async (c) => {
    const id = c.req.param("id");
    const session = getSession(id);
    if (!session) return c.json({ error: "not_found" }, 404);
    const repoPath = session.repo_path;
    if (!repoPath) return c.json({ current: null, local: [], remote: [] });
    const doFetch = c.req.query("fetch") !== "0";

    let current: string | null = null;
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["-C", repoPath, "symbolic-ref", "--short", "HEAD"],
        { timeout: 3000, maxBuffer: 64 * 1024 },
      );
      current = stdout.trim() || null;
    } catch {
      current = null;
    }

    // NUL 필드 구분 + 줄(\n) 레코드 구분. contents:subject 는 첫 줄만이라 개행 없음 → 안전.
    const FMT = "%(refname:short)%00%(objectname:short)%00%(upstream:short)%00%(contents:subject)";
    const fetchRefs = async (
      ns: string,
    ): Promise<Array<{ name: string; sha: string; upstream: string | null; subject: string }>> => {
      try {
        const { stdout } = await execFileAsync(
          "git",
          ["-C", repoPath, "for-each-ref", `--format=${FMT}`, ns],
          { timeout: 5000, maxBuffer: 4 * 1024 * 1024 },
        );
        const rows: Array<{ name: string; sha: string; upstream: string | null; subject: string }> = [];
        for (const line of stdout.split("\n")) {
          if (!line) continue;
          const [name, sha, upstream, subject] = line.split("\0");
          if (!name) continue;
          // origin/HEAD 같은 원격 symref 포인터는 목록에서 제외.
          if (name.endsWith("/HEAD")) continue;
          rows.push({ name, sha: sha ?? "", upstream: upstream || null, subject: subject ?? "" });
        }
        return rows;
      } catch {
        return [];
      }
    };

    // 원격 추적 ref 를 읽기 전에 한 번 fetch --prune (best-effort). remote 가 하나도 없으면
    // 건너뛴다(로컬-only repo 에서 무의미한 fetch 시도 방지). 로컬 브랜치 조회는 fetch 를
    // 기다리지 않고 병렬로 진행한다.
    const refreshRemotes = async (): Promise<void> => {
      if (!doFetch) return;
      let hasRemote = false;
      try {
        const { stdout } = await execFileAsync("git", ["-C", repoPath, "remote"], {
          timeout: 3000,
          maxBuffer: 64 * 1024,
        });
        hasRemote = stdout.trim().length > 0;
      } catch {
        hasRemote = false;
      }
      if (!hasRemote) return;
      try {
        await execFileAsync("git", ["-C", repoPath, "fetch", "--prune", "--quiet"], {
          timeout: 20000,
          maxBuffer: 1024 * 1024,
        });
      } catch {
        // 네트워크 없음/인증 실패/타임아웃 — 캐시된 refs/remotes 로 폴백.
      }
    };

    const [localRows, remoteRows] = await Promise.all([
      fetchRefs("refs/heads"),
      refreshRemotes().then(() => fetchRefs("refs/remotes")),
    ]);
    const local = localRows.map((r) => ({ ...r, current: r.name === current }));
    const remote = remoteRows.map((r) => ({ ...r, current: false }));
    return c.json({ current, local, remote });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 모바일 CommitsView — 커밋 로그 / 한 커밋의 변경 파일 / 파일별 commit-scoped diff.
  // BranchSheet 에서 진입한다. 모두 읽기 전용(git log / git show)이고 repo_path 안에서 `-C`
  // 로만 돈다. ref(브랜치/커밋 sha)는 isValidRef 로 거른다(argument injection 차단).
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * `git show --name-status -z` 출력 파싱 → path 별 { status, origPath }.
   * 비-rename 은 `STATUS\0path\0`, rename/copy(R/C)는 `R100\0old\0new\0` (세 토큰).
   * status 는 두 글자 porcelain 모양으로 정규화 (예 "M ") — iOS GitStatusFile.primaryStatus 와 호환.
   */
  function parseCommitNameStatus(
    stdout: string,
  ): Map<string, { status: string; origPath?: string }> {
    const map = new Map<string, { status: string; origPath?: string }>();
    const parts = stdout.split("\0");
    let i = 0;
    while (i < parts.length) {
      const code = parts[i];
      if (!code) {
        i++;
        continue;
      }
      if (/^[RC]/.test(code)) {
        const oldP = parts[i + 1];
        const newP = parts[i + 2];
        if (newP) map.set(newP, { status: `${code[0]} `, origPath: oldP || undefined });
        i += 3;
      } else {
        const p = parts[i + 1];
        if (p) map.set(p, { status: `${code[0]} ` });
        i += 2;
      }
    }
    return map;
  }

  /**
   * `git show --numstat -z` 출력 파싱 → path 별 { additions, deletions, binary }.
   * 비-rename 은 `ADD\tDEL\tpath\0`, binary 는 `-\t-\tpath\0`,
   * rename 은 `ADD\tDEL\t\0old\0new\0` (남은 path 가 빈 토큰 → 다음 두 토큰이 old·new).
   */
  function parseCommitNumstat(
    stdout: string,
  ): Map<string, { additions: number; deletions: number; binary: boolean }> {
    const map = new Map<string, { additions: number; deletions: number; binary: boolean }>();
    const parts = stdout.split("\0");
    let i = 0;
    while (i < parts.length) {
      const head = parts[i];
      if (!head) {
        i++;
        continue;
      }
      const m = head.match(/^(-|\d+)\t(-|\d+)\t([\s\S]*)$/);
      if (!m) {
        i++;
        continue;
      }
      const binary = m[1] === "-" || m[2] === "-";
      const val = {
        additions: binary ? 0 : parseInt(m[1], 10) || 0,
        deletions: binary ? 0 : parseInt(m[2], 10) || 0,
        binary,
      };
      if (m[3].length > 0) {
        map.set(m[3], val);
        i += 1;
      } else {
        // rename/copy — old=parts[i+1], new=parts[i+2].
        const newP = parts[i + 2];
        if (newP) map.set(newP, val);
        i += 3;
      }
    }
    return map;
  }

  /**
   * 한 커밋이 바꾼 파일 목록 — name-status(상태/rename) 와 numstat(+/-,binary)를 병합한다.
   * git status 와 같은 GitStatusFile shape 로 돌려줘 iOS DiffFileRow 를 그대로 재사용한다.
   * 머지 커밋은 `git show` 가 기본으로 diff 를 안 내므로 빈 배열(앱이 «변경 내용 없음» 표시).
   */
  async function getCommitFiles(
    repoPath: string,
    sha: string,
  ): Promise<
    Array<{
      path: string;
      status: string;
      additions: number;
      deletions: number;
      binary: boolean;
      origPath?: string;
    }>
  > {
    let statusMap = new Map<string, { status: string; origPath?: string }>();
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["-C", repoPath, "show", "--no-color", "--format=", "--name-status", "-z", sha],
        { timeout: 8000, maxBuffer: 8 * 1024 * 1024 },
      );
      statusMap = parseCommitNameStatus(stdout);
    } catch {
      return [];
    }
    let statMap = new Map<string, { additions: number; deletions: number; binary: boolean }>();
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["-C", repoPath, "show", "--no-color", "--format=", "--numstat", "-z", sha],
        { timeout: 8000, maxBuffer: 8 * 1024 * 1024 },
      );
      statMap = parseCommitNumstat(stdout);
    } catch {
      // 통계 없이도 파일 목록·상태는 보여준다 — 카운트는 0/0 으로 흡수(iOS 가 라벨 생략).
    }
    const files: Array<{
      path: string;
      status: string;
      additions: number;
      deletions: number;
      binary: boolean;
      origPath?: string;
    }> = [];
    for (const [path, s] of statusMap) {
      const st = statMap.get(path);
      files.push({
        path,
        status: s.status,
        additions: st?.additions ?? 0,
        deletions: st?.deletions ?? 0,
        binary: st?.binary ?? false,
        ...(s.origPath ? { origPath: s.origPath } : {}),
      });
    }
    return files;
  }

  // 커밋 로그. query: ?limit=(기본50,최대200) &skip= &ref=(브랜치/커밋, 기본 현재 HEAD)
  // 응답: { commits: [{ sha, shortSha, author, date, subject }], total }
  //   total 은 이 페이지 개수(전체 카운트는 비싸서 생략) — 클라가 limit 만큼 받으면 «더 보기».
  //   date 는 author date 의 strict ISO-8601(%aI). 비-repo / unborn HEAD / git 미설치 →
  //   { commits: [], total: 0 } 로 조용히 흡수.
  sessions.get("/:id/git/commits", async (c) => {
    const id = c.req.param("id");
    const session = getSession(id);
    if (!session) return c.json({ error: "not_found" }, 404);
    const repoPath = session.repo_path;
    if (!repoPath) return c.json({ commits: [], total: 0 });

    const limitRaw = c.req.query("limit");
    const limit = limitRaw ? Math.min(200, Math.max(1, parseInt(limitRaw, 10) || 50)) : 50;
    const skipRaw = c.req.query("skip");
    const skip = skipRaw ? Math.max(0, parseInt(skipRaw, 10) || 0) : 0;
    const refRaw = c.req.query("ref");
    const ref = refRaw && refRaw.length > 0 ? refRaw : undefined;
    if (ref !== undefined && !isValidRef(ref)) return c.json({ error: "invalid_ref" }, 400);
    // checkpointsOnly=1 → 체크포인트 타임라인용. 식별 prefix 로 시작하는 커밋만 추린다.
    // CHECKPOINT_PREFIX 는 고정 리터럴(사용자 입력 아님)이라 주입 위험 없음. `(` `)` `:` 는
    // git 기본(basic) 정규식에서 리터럴이고 `^` 만 메시지 줄 시작에 앵커한다 → subject 가 prefix
    // 로 시작하는 커밋만 매치(자동/수동/되돌림 마커 모두 같은 prefix 를 쓴다).
    const checkpointsOnly = c.req.query("checkpointsOnly") === "1";

    // NUL 필드 + \x1e 레코드 구분 — author/subject 에 어떤 문자가 와도 안 깨진다(subject %s 는
    // 한 줄). git 은 레코드마다 개행을 덧붙이므로 split 후 앞쪽 개행 한 개를 떼어낸다.
    const FMT = "%H%x00%h%x00%an%x00%aI%x00%s%x1e";
    const args = [
      "-C",
      repoPath,
      "log",
      `--format=${FMT}`,
      `--max-count=${limit}`,
      `--skip=${skip}`,
    ];
    if (checkpointsOnly) args.push(`--grep=^${CHECKPOINT_PREFIX}`);
    if (ref) args.push(ref);
    let stdout = "";
    try {
      ({ stdout } = await execFileAsync("git", args, {
        timeout: 8000,
        maxBuffer: 16 * 1024 * 1024,
      }));
    } catch {
      return c.json({ commits: [], total: 0 });
    }
    const commits: Array<{
      sha: string;
      shortSha: string;
      author: string;
      date: string;
      subject: string;
    }> = [];
    for (const rec of stdout.split("\x1e")) {
      const line = rec.replace(/^\n/, "");
      if (!line) continue;
      const [sha, shortSha, author, date, subject] = line.split("\0");
      if (!sha) continue;
      commits.push({
        sha,
        shortSha: shortSha ?? "",
        author: author ?? "",
        date: date ?? "",
        subject: subject ?? "",
      });
    }
    return c.json({ commits, total: commits.length });
  });

  // 한 커밋 메타 + 변경 파일 목록. 응답:
  //   { sha, shortSha, author, date, subject, body, files: [GitStatusFile shape] }
  // sha 가 없거나 해석 불가면 404.
  sessions.get("/:id/git/commit/:sha", async (c) => {
    const id = c.req.param("id");
    const session = getSession(id);
    if (!session) return c.json({ error: "not_found" }, 404);
    const repoPath = session.repo_path;
    if (!repoPath) return c.json({ error: "no_repo" }, 404);
    const sha = c.req.param("sha");
    if (!isValidRef(sha)) return c.json({ error: "invalid_ref" }, 400);

    let meta: {
      sha: string;
      shortSha: string;
      author: string;
      date: string;
      subject: string;
      body: string;
    };
    try {
      const FMT = "%H%x00%h%x00%an%x00%aI%x00%s%x00%b";
      const { stdout } = await execFileAsync(
        "git",
        ["-C", repoPath, "show", "-s", `--format=${FMT}`, sha],
        { timeout: 5000, maxBuffer: 2 * 1024 * 1024 },
      );
      const [full, short, author, date, subject, ...bodyParts] = stdout.split("\0");
      meta = {
        sha: (full ?? "").trim(),
        shortSha: short ?? "",
        author: author ?? "",
        date: date ?? "",
        subject: subject ?? "",
        body: bodyParts.join("\0").replace(/\n+$/, ""),
      };
      if (!meta.sha) return c.json({ error: "not_found" }, 404);
    } catch {
      return c.json({ error: "not_found" }, 404);
    }
    const files = await getCommitFiles(repoPath, sha);
    return c.json({ ...meta, files });
  });

  // 한 커밋이 한 파일에 가한 변경만 unified diff (commit-scoped). query: ?path=
  //   `git show <sha> -- <path>` — 그 커밋의 그 파일 patch. 응답은 git/diff 와 동일 shape:
  //   { path, diff, binary, truncated, untracked:false }. binary 면 본문 생략, 200KB 초과면 cut.
  sessions.get("/:id/git/commit/:sha/diff", async (c) => {
    const id = c.req.param("id");
    const session = getSession(id);
    if (!session) return c.json({ error: "not_found" }, 404);
    const repoPath = session.repo_path;
    if (!repoPath) return c.json({ error: "no_repo" }, 404);
    const sha = c.req.param("sha");
    if (!isValidRef(sha)) return c.json({ error: "invalid_ref" }, 400);
    const path = c.req.query("path");
    if (!path) return c.json({ error: "path_required" }, 400);
    if (path.startsWith("/") || path.includes("..")) {
      return c.json({ error: "invalid_path" }, 400);
    }

    try {
      const { stdout } = await execFileAsync(
        "git",
        ["-C", repoPath, "show", "--no-color", "--format=", sha, "--", path],
        { timeout: 8000, maxBuffer: 8 * 1024 * 1024 },
      );
      // `--format=` 가 빈 헤더 자리에 남기는 선두 개행을 제거 — diff 본문만 깔끔히.
      const body = (stdout ?? "").replace(/^\n+/, "");
      const binary = /^Binary files .* differ$/m.test(body);
      if (binary) {
        return c.json({ path, diff: "", binary: true, truncated: false, untracked: false });
      }
      const truncated = body.length > GIT_DIFF_MAX_BYTES;
      return c.json({
        path,
        diff: truncated ? body.slice(0, GIT_DIFF_MAX_BYTES) : body,
        binary: false,
        truncated,
        untracked: false,
      });
    } catch {
      return c.json({ path, diff: "", binary: false, truncated: false, untracked: false });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 체크포인트 (git 쓰기) — «나비효과» 공포 흡수용 안전망.
  //
  //   체크포인트 = 작업트리 전체 스냅샷 = `git add -A && git commit --allow-empty -m
  //   "checkpoint(ps): …"`. 식별 prefix `checkpoint(ps):` 로 일반 커밋과 구분 — iOS 가
  //   이 prefix 로 «되돌리기» 가능한 항목을 가려낸다. --allow-empty 라 깨끗한 트리에서도
  //   «현재 상태» 를 가리키는 복원점을 항상 남긴다.
  // ─────────────────────────────────────────────────────────────────────────────

  /** 체크포인트 커밋 메시지의 식별 prefix. 변경 시 iOS `GitCommit.isCheckpoint` 도 함께. */
  const CHECKPOINT_PREFIX = "checkpoint(ps):";

  /** 사용자 노트를 커밋 제목 한 줄로 정제 — 개행/제어문자 제거, 길이 제한. */
  function sanitizeCheckpointNote(raw: unknown): string | null {
    if (typeof raw !== "string") return null;
    const oneLine = raw.replace(/[\r\n\t]+/g, " ").trim();
    if (oneLine.length === 0) return null;
    return oneLine.slice(0, 200);
  }

  /** `git rev-parse [--short] <rev>` — 실패하면 빈 문자열. */
  async function revParse(repoPath: string, rev: string, short: boolean): Promise<string> {
    try {
      const args = short
        ? ["-C", repoPath, "rev-parse", "--short", rev]
        : ["-C", repoPath, "rev-parse", rev];
      const { stdout } = await execFileAsync("git", args, { timeout: 5000, maxBuffer: 64 * 1024 });
      return stdout.trim();
    } catch {
      return "";
    }
  }

  // 체크포인트 생성. body: { note?: string } → { ok, sha, shortSha, subject }
  //   `git add -A` 로 작업트리 전체를 stage 한 뒤 --allow-empty 커밋. note 가 있으면 제목에
  //   붙이고, 없으면 ISO 타임스탬프를 붙인다. git 미설치/비-repo 등 실패는 409 + stderr.
  sessions.post("/:id/git/checkpoint", async (c) => {
    const id = c.req.param("id");
    const session = getSession(id);
    if (!session) return c.json({ error: "not_found" }, 404);
    const repoPath = session.repo_path;
    if (!repoPath) return c.json({ error: "no_repo" }, 404);

    const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
    const note = sanitizeCheckpointNote((body as { note?: unknown }).note);
    const subject = note
      ? `${CHECKPOINT_PREFIX} ${note}`
      : `${CHECKPOINT_PREFIX} ${new Date().toISOString()}`;

    try {
      await execFileAsync("git", ["-C", repoPath, "add", "-A"], {
        timeout: 30000,
        maxBuffer: 1024 * 1024,
      });
      await execFileAsync(
        "git",
        ["-C", repoPath, "commit", "--allow-empty", "-m", subject],
        { timeout: 30000, maxBuffer: 1024 * 1024 },
      );
    } catch (e: any) {
      const message = (e?.stderr ?? e?.message ?? "checkpoint failed").toString().trim();
      return c.json({ error: "checkpoint_failed", message }, 409);
    }
    const sha = await revParse(repoPath, "HEAD", false);
    const shortSha = await revParse(repoPath, "HEAD", true);
    return c.json({ ok: true, sha, shortSha, subject });
  });

  // 체크포인트로 되돌리기. body: { sha: string, mode: "revert"|"reset", autoCheckpoint?: boolean }
  //   비파괴 우선: autoCheckpoint(기본 true)면 «되돌리기 전» 현재 상태를 자동 체크포인트로 먼저
  //   저장한다 — 미커밋 변경을 잡아두고 트리를 깨끗이 해 revert/reset 이 진행 가능하게 한다.
  //     mode=revert : `git revert --no-commit <sha>..HEAD` + 커밋 — 기록을 지우지 않고 되돌림(안전).
  //     mode=reset  : `git reset --hard <sha>` — 이후 커밋을 버림(파괴적, 자동 체크포인트로 복구 가능).
  //   응답: { ok, mode, autoCheckpointSha?, autoCheckpointShortSha?, resultSha, resultShortSha }
  sessions.post("/:id/git/rollback", async (c) => {
    const id = c.req.param("id");
    const session = getSession(id);
    if (!session) return c.json({ error: "not_found" }, 404);
    const repoPath = session.repo_path;
    if (!repoPath) return c.json({ error: "no_repo" }, 404);

    const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
    const sha = (body as { sha?: unknown }).sha;
    if (!isValidRef(sha)) return c.json({ error: "invalid_ref" }, 400);
    const mode = (body as { mode?: unknown }).mode;
    if (mode !== "revert" && mode !== "reset") return c.json({ error: "invalid_mode" }, 400);
    const autoCheckpoint = (body as { autoCheckpoint?: unknown }).autoCheckpoint !== false;

    // 1) 되돌리기 전 자동 체크포인트 — 미커밋 변경을 잡아두고(트리 clean) 복원점을 남긴다.
    let autoCheckpointSha = "";
    let autoCheckpointShortSha = "";
    if (autoCheckpoint) {
      const subject = `${CHECKPOINT_PREFIX} 되돌리기 전 자동 저장 (${new Date().toISOString()})`;
      try {
        await execFileAsync("git", ["-C", repoPath, "add", "-A"], {
          timeout: 30000,
          maxBuffer: 1024 * 1024,
        });
        await execFileAsync(
          "git",
          ["-C", repoPath, "commit", "--allow-empty", "-m", subject],
          { timeout: 30000, maxBuffer: 1024 * 1024 },
        );
      } catch (e: any) {
        const message = (e?.stderr ?? e?.message ?? "auto checkpoint failed").toString().trim();
        return c.json({ error: "auto_checkpoint_failed", message }, 409);
      }
      autoCheckpointSha = await revParse(repoPath, "HEAD", false);
      autoCheckpointShortSha = await revParse(repoPath, "HEAD", true);
    }

    // 2) 되돌리기 수행.
    const shortTarget = await revParse(repoPath, sha, true);
    if (mode === "revert") {
      try {
        // <sha>..HEAD 의 모든 커밋을 역순으로 되돌려 트리를 sha 시점과 동일하게 — 기록은 보존.
        await execFileAsync(
          "git",
          ["-C", repoPath, "revert", "--no-commit", `${sha}..HEAD`],
          { timeout: 30000, maxBuffer: 4 * 1024 * 1024 },
        );
      } catch (e: any) {
        // 충돌 등 실패 — revert 진행 상태를 깨끗이 되돌려 레포를 원상복구한다.
        try {
          await execFileAsync("git", ["-C", repoPath, "revert", "--abort"], {
            timeout: 10000,
            maxBuffer: 256 * 1024,
          });
        } catch {
          // abort 실패는 무시 — 아래로 에러를 흘린다.
        }
        const message = (e?.stderr ?? e?.message ?? "revert failed").toString().trim();
        return c.json({ error: "revert_failed", message }, 409);
      }
      try {
        const subject = `${CHECKPOINT_PREFIX} ${shortTarget || sha} 시점으로 되돌림`;
        await execFileAsync(
          "git",
          ["-C", repoPath, "commit", "--allow-empty", "-m", subject],
          { timeout: 30000, maxBuffer: 1024 * 1024 },
        );
      } catch (e: any) {
        const message = (e?.stderr ?? e?.message ?? "revert commit failed").toString().trim();
        return c.json({ error: "revert_failed", message }, 409);
      }
    } else {
      // reset --hard — HEAD 를 sha 로 옮기고 작업트리를 맞춘다. 이후 커밋은 버려지지만
      // 자동 체크포인트(autoCheckpointSha)로 reflog 없이도 복구 가능.
      try {
        await execFileAsync("git", ["-C", repoPath, "reset", "--hard", sha], {
          timeout: 30000,
          maxBuffer: 1024 * 1024,
        });
      } catch (e: any) {
        const message = (e?.stderr ?? e?.message ?? "reset failed").toString().trim();
        return c.json({ error: "reset_failed", message }, 409);
      }
    }

    const resultSha = await revParse(repoPath, "HEAD", false);
    const resultShortSha = await revParse(repoPath, "HEAD", true);
    return c.json({
      ok: true,
      mode,
      autoCheckpointSha: autoCheckpointSha || null,
      autoCheckpointShortSha: autoCheckpointShortSha || null,
      resultSha,
      resultShortSha,
    });
  });

  // worktree 목록. 응답:
  //   { worktrees: [{ path, branch: string|null, head, isMain, isCurrent, locked, prunable }] }
  // isMain = 목록 첫 항목(메인 worktree), isCurrent = 이 세션 repo_path 의 toplevel.
  sessions.get("/:id/git/worktrees", async (c) => {
    const id = c.req.param("id");
    const session = getSession(id);
    if (!session) return c.json({ error: "not_found" }, 404);
    const repoPath = session.repo_path;
    if (!repoPath) return c.json({ worktrees: [] });

    const { entries, currentTop } = await listWorktrees(repoPath);
    const worktrees = await Promise.all(
      entries.map(async (e, i) => ({
        path: e.path,
        branch: e.branch ?? null,
        head: e.head ?? null,
        isMain: i === 0,
        isCurrent: await samePath(e.path, currentTop),
        locked: e.locked,
        prunable: e.prunable,
      })),
    );
    return c.json({ worktrees });
  });

  // 브랜치 전환(checkout). body: { name: string, track?: boolean }
  //   track=true 면 원격추적 브랜치(origin/foo)를 받아 로컬 추적 브랜치를 만들며 전환.
  // 미커밋 변경 충돌 등으로 git 이 거절하면 409 + stderr(앱이 안내로 표시).
  sessions.post("/:id/git/checkout", async (c) => {
    const id = c.req.param("id");
    const session = getSession(id);
    if (!session) return c.json({ error: "not_found" }, 404);
    const repoPath = session.repo_path;
    if (!repoPath) return c.json({ error: "no_repo" }, 404);

    const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
    const name = (body as { name?: unknown }).name;
    if (!isValidRef(name)) return c.json({ error: "invalid_branch" }, 400);
    const track = (body as { track?: unknown }).track === true;

    const args = track
      ? ["-C", repoPath, "checkout", "--track", name]
      : ["-C", repoPath, "checkout", name];
    try {
      await execFileAsync("git", args, { timeout: 15000, maxBuffer: 1024 * 1024 });
      return c.json({ ok: true, branch: name });
    } catch (e: any) {
      const message = (e?.stderr ?? e?.message ?? "checkout failed").toString().trim();
      return c.json({ error: "checkout_failed", message }, 409);
    }
  });

  // 새 브랜치 생성. body: { name: string, from?: string, checkout?: boolean }
  //   checkout=true → `git checkout -b name [from]` (생성+전환), 아니면 `git branch name [from]`.
  sessions.post("/:id/git/branch", async (c) => {
    const id = c.req.param("id");
    const session = getSession(id);
    if (!session) return c.json({ error: "not_found" }, 404);
    const repoPath = session.repo_path;
    if (!repoPath) return c.json({ error: "no_repo" }, 404);

    const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
    const name = (body as { name?: unknown }).name;
    if (!isValidRef(name)) return c.json({ error: "invalid_branch" }, 400);
    const fromRaw = (body as { from?: unknown }).from;
    const from = typeof fromRaw === "string" && fromRaw.length > 0 ? fromRaw : undefined;
    if (from !== undefined && !isValidRef(from)) return c.json({ error: "invalid_from" }, 400);
    const checkout = (body as { checkout?: unknown }).checkout === true;

    const args = checkout
      ? ["-C", repoPath, "checkout", "-b", name, ...(from ? [from] : [])]
      : ["-C", repoPath, "branch", name, ...(from ? [from] : [])];
    try {
      await execFileAsync("git", args, { timeout: 15000, maxBuffer: 1024 * 1024 });
      return c.json({ ok: true, branch: name, checkedOut: checkout });
    } catch (e: any) {
      const message = (e?.stderr ?? e?.message ?? "branch failed").toString().trim();
      return c.json({ error: "branch_failed", message }, 409);
    }
  });

  // worktree 생성. body: { branch: string, newBranch?: boolean, from?: string } → { path, branch }
  //   경로는 daemon 이 자동 산정: <메인worktree부모>/<repoName>.worktrees/<branchSlug>.
  //   newBranch=true → `git worktree add -b branch <target> [from]` (신규 브랜치),
  //   아니면 `git worktree add <target> branch` (기존 브랜치).
  sessions.post("/:id/git/worktrees", async (c) => {
    const id = c.req.param("id");
    const session = getSession(id);
    if (!session) return c.json({ error: "not_found" }, 404);
    const repoPath = session.repo_path;
    if (!repoPath) return c.json({ error: "no_repo" }, 404);

    // 검증·경로산정·git add 는 공유 헬퍼가 전담 — repoPath 기반 routes/git.ts 와 동일 동작.
    const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
    const r = await createWorktree(repoPath, body as Record<string, unknown>);
    if (!r.ok) return c.json(r.body, r.status);
    return c.json({ path: r.path, branch: r.branch });
  });

  // worktree 삭제. query: ?path=<절대경로>&force=1
  //   안전: path 가 `worktree list` 에 실제로 있는 것만(임의 디렉토리 삭제 차단), 그것도
  //   메인 / 현재 세션 worktree 가 아닐 때만. dirty/locked 로 실패하면 409(앱이 force 재확인).
  sessions.delete("/:id/git/worktrees", async (c) => {
    const id = c.req.param("id");
    const session = getSession(id);
    if (!session) return c.json({ error: "not_found" }, 404);
    const repoPath = session.repo_path;
    if (!repoPath) return c.json({ error: "no_repo" }, 404);

    const target = c.req.query("path");
    if (!target) return c.json({ error: "path_required" }, 400);
    const force = c.req.query("force") === "1";

    const { entries, currentTop } = await listWorktrees(repoPath);
    // git 이 추적하는 worktree 중 같은 경로를 찾는다 — 못 찾으면 임의 경로이므로 거절.
    let matchIdx = -1;
    for (let i = 0; i < entries.length; i++) {
      if (await samePath(entries[i].path, target)) {
        matchIdx = i;
        break;
      }
    }
    if (matchIdx === -1) return c.json({ error: "not_a_worktree" }, 404);
    if (matchIdx === 0) return c.json({ error: "cannot_remove_main" }, 403);
    if (await samePath(entries[matchIdx].path, currentTop)) {
      return c.json({ error: "cannot_remove_current" }, 403);
    }

    const args = force
      ? ["-C", repoPath, "worktree", "remove", "--force", entries[matchIdx].path]
      : ["-C", repoPath, "worktree", "remove", entries[matchIdx].path];
    try {
      await execFileAsync("git", args, { timeout: 15000, maxBuffer: 1024 * 1024 });
    } catch (e: any) {
      const message = (e?.stderr ?? e?.message ?? "worktree remove failed").toString().trim();
      return c.json({ error: "worktree_remove_failed", message }, 409);
    }
    // 메타데이터 정리(best effort) — 삭제된 worktree 의 administrative 파일 제거.
    try {
      await execFileAsync("git", ["-C", repoPath, "worktree", "prune"], {
        timeout: 5000,
        maxBuffer: 64 * 1024,
      });
    } catch {
      // prune 실패는 무시 — 제거 자체는 성공.
    }
    return c.json({ ok: true });
  });

  // 브랜치 삭제(로컬 전용). query: ?name=<브랜치>&force=1
  //   안전: 현재 브랜치는 거절(cannot_delete_current — git 도 거절하지만 깔끔한 에러로 먼저 막는다).
  //   기본은 `git branch -d`(병합 안 된 브랜치는 git 이 거절 → 409 + stderr, 앱이 force 재확인).
  //   force=1 이면 `git branch -D`(강제). 원격 브랜치(origin/*)는 대상 아님 — 로컬만 지운다.
  sessions.delete("/:id/git/branch", async (c) => {
    const id = c.req.param("id");
    const session = getSession(id);
    if (!session) return c.json({ error: "not_found" }, 404);
    const repoPath = session.repo_path;
    if (!repoPath) return c.json({ error: "no_repo" }, 404);

    const name = c.req.query("name");
    if (!isValidRef(name)) return c.json({ error: "invalid_branch" }, 400);
    const force = c.req.query("force") === "1";

    // 현재 체크아웃된 브랜치는 삭제 불가. detached / unborn HEAD 면 symbolic-ref 가 실패 →
    // 현재 브랜치 없음으로 보고 계속 진행.
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["-C", repoPath, "symbolic-ref", "--short", "HEAD"],
        { timeout: 3000, maxBuffer: 64 * 1024 },
      );
      if (stdout.trim() === name) return c.json({ error: "cannot_delete_current" }, 403);
    } catch {
      // 현재 브랜치 없음(detached/unborn) — 계속.
    }

    const args = force
      ? ["-C", repoPath, "branch", "-D", name]
      : ["-C", repoPath, "branch", "-d", name];
    try {
      await execFileAsync("git", args, { timeout: 15000, maxBuffer: 1024 * 1024 });
      return c.json({ ok: true });
    } catch (e: any) {
      const message = (e?.stderr ?? e?.message ?? "branch delete failed").toString().trim();
      return c.json({ error: "branch_delete_failed", message }, 409);
    }
  });

}
