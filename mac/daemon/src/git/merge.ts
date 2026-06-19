// ─────────────────────────────────────────────────────────────────────────────
// git 머지 오케스트레이션 — sessionId 에 의존하지 않는 순수 git 로직 (worktree.ts 와 짝).
//
// 「재결합(recombination)」 단계의 핵심: 워크트리/세션이 만든 작업 브랜치(po/<id8> 등)를
// main / release/* 로 합칠 때, daemon 이 «직렬 큐» 로 한 번에 하나씩만 target 에 쓴다
// (merge/queue.ts). 이 파일은 그 큐가 호출하는 «한 건» 의 머지 연산만 담는다:
//
//   1. previewMerge(...)  — 사전 «읽기 전용» 충돌 탐지. repo 를 절대 변경하지 않는다
//                           (3-인자 `git merge-tree <base> <S> <T>` — ref/worktree/index 무변경).
//   2. performMerge(...)  — 충돌 없을 때 fast-forward / --no-ff 머지를 실제로 수행.
//   3. cleanupMergedSource — 머지 완료된 source 워크트리 + 브랜치를 정리(옵션).
//
// 안전: 모든 동작은 repoPath 안에서 `-C` 로만 돈다. execFile 은 shell 을 거치지 않으므로
// shell 주입은 없고, 남는 위협은 «`-` 로 시작하는 인자가 git 플래그로 해석되는»
// argument injection 뿐 → isValidRef 가 거른다 (worktree.ts 와 동일 수준).
// ─────────────────────────────────────────────────────────────────────────────

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isValidRef, listWorktrees, parseWorktreeList } from "./worktree.js";

const execFileAsync = promisify(execFile);

/**
 * `git -C <repo> <args...>` 실행. ok=false 면 stderr 를 message 로, stdout 도 함께 담는다
 * (`merge-tree --write-tree` 는 충돌 시 exit 1 이지만 충돌 파일 목록을 stdout 으로 내보낸다).
 */
async function git(
  repoPath: string,
  args: string[],
  timeout = 20000,
): Promise<
  | { ok: true; stdout: string }
  | { ok: false; code: number; message: string; stdout: string }
> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", repoPath, ...args], {
      timeout,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { ok: true, stdout };
  } catch (e: any) {
    const message = (e?.stderr ?? e?.message ?? "git failed").toString().trim();
    const stdout = (e?.stdout ?? "").toString();
    return { ok: false, code: typeof e?.code === "number" ? e.code : 1, message, stdout };
  }
}

/** ref → full SHA. 존재하지 않으면 null. */
async function revParse(repoPath: string, ref: string): Promise<string | null> {
  // `--verify <ref>^{commit}` 으로 «커밋을 가리키는 ref» 만 통과 — 태그/트리 오용 방지.
  const r = await git(repoPath, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], 5000);
  if (!r.ok) return null;
  const sha = r.stdout.trim();
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

/** 두 커밋의 merge-base. 공통 조상이 없으면(완전 무관 히스토리) null. */
async function mergeBase(repoPath: string, a: string, b: string): Promise<string | null> {
  const r = await git(repoPath, ["merge-base", a, b], 5000);
  if (!r.ok) return null;
  const sha = r.stdout.trim();
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

/** source/target 가 어떤 관계인지 — 머지 전략 결정용. */
export type MergeRelation =
  /** source 가 이미 target 안에 있음 (B===S 또는 S===T) → 할 일 없음. */
  | "up_to_date"
  /** target 이 source 의 조상 (B===T) → fast-forward 가능. */
  | "fast_forward"
  /** 갈라짐 — 3-way 머지 필요 (충돌 여부는 conflict 로 판정). */
  | "diverged"
  /** 공통 조상 없음 — 머지 불가. */
  | "unrelated";

export type MergePreview =
  | {
      ok: true;
      sourceSha: string;
      targetSha: string;
      base: string | null;
      relation: MergeRelation;
      /** diverged 일 때만 의미 — 읽기 전용 탐지가 본 충돌 여부. */
      conflict: boolean;
      /** 충돌 파일 (best-effort, 3-인자 merge-tree 출력에서 추출). */
      conflictFiles: string[];
    }
  | { ok: false; error: "invalid_ref" | "not_found"; message?: string };

/**
 * 사전 «읽기 전용» 충돌 탐지. **repo 를 절대 변경하지 않는다** — ref/worktree/index/object
 * 무엇도 안 건드린다. 3-인자 `git merge-tree <merge-base> <S> <T>` 의 출력을 파싱한다.
 *
 * 3-인자 merge-tree 는 (구형이라) 충돌 여부를 exit code 로 알려주지 않고 — 깨끗한
 * 자동 머지에도 «changed in both» 섹션을 찍는다. 그래서 충돌 판정은 출력의 «충돌 마커»
 * (`<<<<<<<`) 유무로 한다. 비-내용 충돌(modify/delete 등 마커 없는 종류)을 이 단계가 놓쳐도,
 * performMerge 가 실제 머지 시도(Case A: `git merge` 후 abort / Case B: `--write-tree` exit 1)
 * 로 권위 있게 다시 잡아 큐가 결국 conflict 로 보류하므로 안전망이 이중이다.
 */
export async function previewMerge(
  repoPath: string,
  source: string,
  target: string,
): Promise<MergePreview> {
  if (!isValidRef(source) || !isValidRef(target)) {
    return { ok: false, error: "invalid_ref" };
  }
  const sourceSha = await revParse(repoPath, source);
  const targetSha = await revParse(repoPath, target);
  if (!sourceSha) return { ok: false, error: "not_found", message: `source: ${source}` };
  if (!targetSha) return { ok: false, error: "not_found", message: `target: ${target}` };

  const base = await mergeBase(repoPath, sourceSha, targetSha);
  if (base === null) {
    return { ok: true, sourceSha, targetSha, base: null, relation: "unrelated", conflict: false, conflictFiles: [] };
  }
  if (sourceSha === targetSha || base === sourceSha) {
    return { ok: true, sourceSha, targetSha, base, relation: "up_to_date", conflict: false, conflictFiles: [] };
  }
  if (base === targetSha) {
    // target 이 source 의 조상 → fast-forward. 충돌 불가능.
    return { ok: true, sourceSha, targetSha, base, relation: "fast_forward", conflict: false, conflictFiles: [] };
  }
  // 갈라짐 — 읽기 전용 3-인자 merge-tree 로 충돌만 본다 (repo 무변경).
  const r = await git(repoPath, ["merge-tree", base, sourceSha, targetSha], 30000);
  // merge-tree 자체가 실패(매우 드묾)하면 보수적으로 «충돌» 로 본다 — performMerge 가 다시 검증.
  if (!r.ok) {
    return { ok: true, sourceSha, targetSha, base, relation: "diverged", conflict: true, conflictFiles: [] };
  }
  const conflict = r.stdout.includes("<<<<<<<");
  return {
    ok: true,
    sourceSha,
    targetSha,
    base,
    relation: "diverged",
    conflict,
    conflictFiles: conflict ? parseConflictFiles(r.stdout) : [],
  };
}

/**
 * 3-인자 `git merge-tree` 출력에서 충돌 파일 경로를 추출한다 (best-effort). 충돌 섹션의
 * 인덴트 라인 `  base|our|their <mode> <sha> <path>` 에서 path 를 모은다.
 */
export function parseConflictFiles(stdout: string): string[] {
  const files = new Set<string>();
  const re = /^\s+(?:base|our|their|result)\s+\d{6}\s+[0-9a-f]{7,40}\s+(.+)$/;
  for (const line of stdout.split("\n")) {
    const m = re.exec(line);
    if (m) files.add(m[1].trim());
  }
  return [...files];
}

export type MergeOutcome =
  | { ok: true; result: "up_to_date" | "fast_forward" | "merged"; targetSha: string; mergeCommit?: string }
  | { ok: false; reason: "conflict"; conflictFiles: string[]; message?: string }
  | { ok: false; reason: "blocked"; message: string }
  | { ok: false; reason: "unrelated" | "invalid_ref" | "not_found" | "git_error"; message?: string };

/**
 * 실제 머지 수행. 큐(merge/queue.ts)가 previewMerge 로 «충돌 없음» 을 확인한 뒤 호출한다.
 *
 * 두 경로:
 *   Case A — target 브랜치가 어느 워크트리에 체크아웃돼 있으면 거기서 «정상» `git merge` 를
 *            돈다 (워크트리/인덱스/ref 가 일관되게 갱신됨). 워크트리가 dirty 면 blocked
 *            (사용자 미커밋 작업을 덮어쓰지 않으려고 — 큐는 이 항목만 보류).
 *   Case B — target 이 아무 워크트리에도 없으면 «플러밍» 으로 ref 만 옮긴다
 *            (fast-forward = update-ref, --no-ff = merge-tree --write-tree → commit-tree → update-ref).
 *
 * 어느 경로든 충돌이 (preview 가 놓쳐) 실제로 드러나면 깨끗이 되돌리고 conflict 를 반환한다 —
 * 절반쯤 머지된 상태로 두지 않는다.
 */
export async function performMerge(
  repoPath: string,
  source: string,
  target: string,
  opts: { noFF?: boolean } = {},
): Promise<MergeOutcome> {
  if (!isValidRef(source) || !isValidRef(target)) return { ok: false, reason: "invalid_ref" };

  const sourceSha = await revParse(repoPath, source);
  const targetSha = await revParse(repoPath, target);
  if (!sourceSha) return { ok: false, reason: "not_found", message: `source: ${source}` };
  if (!targetSha) return { ok: false, reason: "not_found", message: `target: ${target}` };

  const base = await mergeBase(repoPath, sourceSha, targetSha);
  if (base === null) return { ok: false, reason: "unrelated", message: "no common ancestor" };
  if (sourceSha === targetSha || base === sourceSha) {
    return { ok: true, result: "up_to_date", targetSha };
  }
  const canFastForward = base === targetSha;

  // target 이 체크아웃된 워크트리 찾기.
  const targetWorktree = await findWorktreeForBranch(repoPath, target);

  if (targetWorktree) {
    return mergeInWorktree(repoPath, targetWorktree, source, { canFastForward, noFF: opts.noFF === true, target });
  }
  return mergePlumbing(repoPath, { sourceSha, targetSha, base, source, target, canFastForward, noFF: opts.noFF === true });
}

/** branch (short name) 가 체크아웃된 워크트리 경로. 없으면 null. */
async function findWorktreeForBranch(repoPath: string, branch: string): Promise<string | null> {
  const r = await git(repoPath, ["worktree", "list", "--porcelain"], 5000);
  if (!r.ok) return null;
  const entries = parseWorktreeList(r.stdout);
  const match = entries.find((e) => e.branch === branch);
  return match ? match.path : null;
}

/** Case A — 체크아웃된 워크트리에서 정상 `git merge`. */
async function mergeInWorktree(
  repoPath: string,
  worktreePath: string,
  source: string,
  o: { canFastForward: boolean; noFF: boolean; target: string },
): Promise<MergeOutcome> {
  // dirty 면 보류 — 사용자 미커밋 변경을 위험에 빠뜨리지 않는다.
  const status = await git(worktreePath, ["status", "--porcelain"], 5000);
  if (!status.ok) return { ok: false, reason: "git_error", message: status.message };
  if (status.stdout.trim().length > 0) {
    return { ok: false, reason: "blocked", message: "target worktree has uncommitted changes" };
  }

  const id = await identityArgs(repoPath);
  const ffArgs = o.canFastForward && !o.noFF ? ["--ff-only"] : ["--no-ff", "--no-edit"];
  const msg = `Merge ${source} into ${o.target} (pocket-sisyphus merge queue)`;
  const args = [...id, "merge", ...ffArgs, ...(o.canFastForward && !o.noFF ? [] : ["-m", msg]), source];
  const r = await git(worktreePath, args, 60000);
  if (r.ok) {
    const t = await revParse(worktreePath, "HEAD");
    return { ok: true, result: o.canFastForward && !o.noFF ? "fast_forward" : "merged", targetSha: t ?? "", mergeCommit: o.canFastForward && !o.noFF ? undefined : (t ?? undefined) };
  }
  // 예기치 못한 충돌 — 충돌 파일을 먼저 수집한 뒤 abort 로 깨끗이 되돌린다.
  const conflicted = await git(worktreePath, ["diff", "--name-only", "--diff-filter=U"], 5000);
  const files = conflicted.ok ? conflicted.stdout.split("\n").map((s) => s.trim()).filter(Boolean) : [];
  await git(worktreePath, ["merge", "--abort"], 10000);
  if (files.length > 0) return { ok: false, reason: "conflict", conflictFiles: files };
  // 충돌이 아니라 다른 git 에러(identity 등).
  return { ok: false, reason: "git_error", message: r.message };
}

/** Case B — target 이 체크아웃 안 됨 → 플러밍으로 ref 만 갱신 (워크트리 없음). */
async function mergePlumbing(
  repoPath: string,
  o: { sourceSha: string; targetSha: string; base: string; source: string; target: string; canFastForward: boolean; noFF: boolean },
): Promise<MergeOutcome> {
  const ref = `refs/heads/${o.target}`;
  if (o.canFastForward && !o.noFF) {
    // fast-forward — CAS update-ref (old value 검증으로 직렬성 이중 보장).
    const r = await git(repoPath, ["update-ref", ref, o.sourceSha, o.targetSha], 10000);
    if (!r.ok) return { ok: false, reason: "git_error", message: r.message };
    return { ok: true, result: "fast_forward", targetSha: o.sourceSha };
  }
  // --no-ff 또는 갈라진 머지 — 머지 트리를 만들고 2-parent 커밋을 단다.
  const wt = await git(
    repoPath,
    ["merge-tree", "--write-tree", `--merge-base=${o.base}`, o.targetSha, o.sourceSha],
    60000,
  );
  if (!wt.ok) {
    // exit 1 = 충돌. stdout 첫 줄(트리 oid) 이후로 충돌 파일이 나열된다.
    const files = parseWriteTreeConflictFiles(wt.message, wt.stdout);
    return { ok: false, reason: "conflict", conflictFiles: files };
  }
  const tree = wt.stdout.split("\n")[0]?.trim();
  if (!tree || !/^[0-9a-f]{40}$/.test(tree)) {
    return { ok: false, reason: "git_error", message: "merge-tree produced no tree" };
  }
  const id = await identityArgs(repoPath);
  const msg = `Merge ${o.source} into ${o.target} (pocket-sisyphus merge queue)`;
  const commit = await git(repoPath, [...id, "commit-tree", tree, "-p", o.targetSha, "-p", o.sourceSha, "-m", msg], 10000);
  if (!commit.ok) return { ok: false, reason: "git_error", message: commit.message };
  const newCommit = commit.stdout.trim();
  const upd = await git(repoPath, ["update-ref", ref, newCommit, o.targetSha], 10000);
  if (!upd.ok) return { ok: false, reason: "git_error", message: upd.message };
  return { ok: true, result: "merged", targetSha: newCommit, mergeCommit: newCommit };
}

/** `merge-tree --write-tree` 충돌 출력에서 파일명 추출 — 트리 oid 줄 이후 «<mode> <sha> <stage>\t<path>». */
function parseWriteTreeConflictFiles(stderr: string, stdout?: string): string[] {
  const files = new Set<string>();
  const text = `${stdout ?? ""}\n${stderr}`;
  for (const line of text.split("\n")) {
    // "100644 <sha> 1\tpath" (stage 표기) 또는 "CONFLICT (content): Merge conflict in <path>"
    const stage = /^\d{6} [0-9a-f]{7,40} [123]\t(.+)$/.exec(line);
    if (stage) { files.add(stage[1].trim()); continue; }
    const conf = /Merge conflict in (.+)$/.exec(line);
    if (conf) files.add(conf[1].trim());
  }
  return [...files];
}

/**
 * 커밋/머지에 쓸 identity 보강용 `-c` 인자. repo 에 user.email 이 설정돼 있으면 빈 배열을
 * 반환해 «사용자 신원 그대로» 쓰고, 없으면(글로벌 git config 미설정 환경) 큐 봇 신원을
 * 주입해 commit-tree / --no-ff 머지가 «identity unknown» 으로 실패하지 않게 한다.
 */
async function identityArgs(repoPath: string): Promise<string[]> {
  const r = await git(repoPath, ["config", "user.email"], 3000);
  if (r.ok && r.stdout.trim().length > 0) return [];
  return [
    "-c",
    "user.name=Pocket Sisyphus Merge Queue",
    "-c",
    "user.email=merge-queue@pocket-sisyphus.local",
  ];
}

export type CleanupResult = {
  removedWorktree: boolean;
  deletedBranch: boolean;
  message?: string;
};

/**
 * 머지 완료된 source 워크트리 + 브랜치를 정리한다 (옵션). 디스크/브랜치 누적 방지.
 *
 * 안전 가드:
 *   - 메인 워크트리(목록 첫 항목)는 절대 제거하지 않는다.
 *   - source 브랜치가 «현재 어딘가 체크아웃돼 있는» 워크트리만 제거 대상 — 그 워크트리가
 *     메인이면 건너뛴다. 브랜치 삭제는 `git branch -d`(머지된 것만; 미머지면 git 이 거절).
 *   - source === target 같은 자기 정리 시도는 호출부가 막지만 여기서도 메인 가드로 안전.
 */
export async function cleanupMergedSource(
  repoPath: string,
  sourceBranch: string,
): Promise<CleanupResult> {
  const out: CleanupResult = { removedWorktree: false, deletedBranch: false };
  if (!isValidRef(sourceBranch)) {
    out.message = "invalid source branch";
    return out;
  }
  const { entries } = await listWorktrees(repoPath);
  const mainPath = entries[0]?.path;
  const wt = entries.find((e) => e.branch === sourceBranch);
  // 워크트리 제거 — 메인이 아니고, source 브랜치가 체크아웃된 워크트리가 있을 때만.
  if (wt && wt.path !== mainPath) {
    const rm = await git(repoPath, ["worktree", "remove", "--force", wt.path], 20000);
    if (rm.ok) {
      out.removedWorktree = true;
      await git(repoPath, ["worktree", "prune"], 5000);
    } else {
      out.message = rm.message;
    }
  }
  // 브랜치 삭제 — 머지된 브랜치만 (`-d`). 워크트리가 아직 잡고 있으면 git 이 거절.
  const del = await git(repoPath, ["branch", "-d", sourceBranch], 10000);
  if (del.ok) out.deletedBranch = true;
  else if (!out.message) out.message = del.message;
  return out;
}
