/**
 * `git status --porcelain=v1 -z` 출력을 파싱하는 순수 함수.
 *
 * sessions.ts 의 `/git/status` 엔드포인트가 사용하는 핵심 파싱 단계만 따로 떼서
 * vitest 가 hono / db / pty-runner 등 무거운 의존성을 import 하지 않고 회귀를
 * 잡을 수 있게 한다.
 *
 * 형식 (porcelain v1, NUL 구분):
 *   XY SP PATH NUL                       (보통 변경)
 *   XY SP NEW NUL ORIG NUL               (rename / copy — X 가 R 또는 C)
 *
 *   X = index (staged) 측 상태, Y = worktree 측 상태.
 *   M=modified  A=added  D=deleted  R=renamed  C=copied  U=unmerged
 *   ??=untracked  !!=ignored  (단일 글자 두 번)
 *
 * -z 옵션은 path 안의 newline/space 를 그대로 두므로 안전하다.
 */

export type GitStatusEntry = {
  /** worktree+index 통합 path. rename 의 경우 새 경로. */
  path: string;
  /** 두 글자 status code (예: " M", "M ", "MM", "??"). */
  status: string;
  /** rename/copy 의 원본 path. 그 외 entry 에서는 undefined. */
  origPath?: string;
};

export function parsePorcelainZ(raw: string): GitStatusEntry[] {
  const out: GitStatusEntry[] = [];
  // -z 출력은 NUL 로 구분된 토큰들의 평탄한 시퀀스다. 끝에 trailing NUL 이 있어
  // split 결과에 빈 끝 토큰이 생기는데, 헤더 형태가 아니라 자연스럽게 건너뛴다.
  const tokens = raw.split("\0");
  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i++];
    if (!tok) continue;
    // 헤더는 "XY PATH" — 정확히는 "X" + "Y" + " " + PATH (총 3바이트 prefix).
    // 너무 짧으면 손상된 토큰이라 skip — 방어적으로.
    if (tok.length < 3) continue;
    const status = tok.slice(0, 2);
    const path = tok.slice(3);
    if (status[0] === "R" || status[0] === "C") {
      // 다음 토큰이 원본 path. 누락된 입력(잘린 stdout)에 대비해 fallback 없이도
      // 본 entry 는 보존.
      const origPath = tokens[i++];
      out.push({ path, status, origPath });
    } else {
      out.push({ path, status });
    }
  }
  return out;
}
