#!/usr/bin/env bash
#
# Claude Code SessionStart 훅 — 워크트리 세션 이름 자동 지정.
#
# 새 세션이 git "링크된 워크트리" 안에서 시작되면, 세션 표시 이름
# (세션 선택기 / 터미널 타이틀) 을 워크트리 디렉터리 이름(예: q2)으로
# 박는다. 이름을 안 줘서 임시 이름으로 뜨던 걸 대체.
#
# 안 건드리는 경우:
#   • 메인 체크아웃 (.git 이 디렉터리) — 워크트리가 아니므로 그대로 둔다.
#   • resume / clear / compact 로 들어온 세션 — source != "startup" 이면
#     손대지 않는다. → /rename 으로 바꾼 이름이 재개 시에도 유지된다.
#
# 출력: hookSpecificOutput.sessionTitle 로 제목을 넘긴다.
#
set -euo pipefail

input="$(cat)"

# 새 세션(startup)이 아니면 손대지 않는다. (source 를 못 읽으면 새 세션으로 간주)
src="$(printf '%s' "$input" | sed -n 's/.*"source"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
if [ -n "$src" ] && [ "$src" != "startup" ]; then
  exit 0
fi

# 세션 cwd (훅 입력에 없으면 프로세스 PWD).
cwd="$(printf '%s' "$input" | sed -n 's/.*"cwd"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
[ -n "$cwd" ] || cwd="$PWD"

# git 워크트리 최상위. git 저장소가 아니면 종료.
top="$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null)" || exit 0

# 링크된 워크트리는 최상위에 .git "파일"(gitfile)을 둔다.
# 메인 체크아웃은 .git "디렉터리" → 대상 아님.
[ -f "$top/.git" ] || exit 0

name="$(basename "$top")"
[ -n "$name" ] || exit 0

# JSON 문자열 이스케이프 (역슬래시 먼저, 그다음 큰따옴표).
esc="$(printf '%s' "$name" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')"

printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","sessionTitle":"%s"}}\n' "$esc"
