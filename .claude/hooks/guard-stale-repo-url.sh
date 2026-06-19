#!/usr/bin/env bash
# PostToolUse 가드 — 옛/잘못된 «공개 repo» 슬러그가 GitHub URL 로 다시 박히는 사고를 막는다.
#
# 배경: 앱의 「도움받기·공유하기」 링크가 한동안 존재하지 않는 옛 repo
#   github.com/Wayne-Kim/pocket-claude 를 가리켜 404 가 났다. 공개 가이드/배포 repo 는
#   github.com/Wayne-Kim/pocket-sisyphus-mac 이다 (이 메인 저장소 pocket-sisyphus 는 private).
#
# 이 훅은 방금 Edit/Write/MultiEdit 한 «소스 파일» 이 금지 패턴을 담고 있으면 exit 2 로
# Claude 에게 피드백을 돌려준다. 보존 대상인 `pocket-claude.db`(DB 파일명, github.com 없음)는
# 패턴에 github.com 호스트를 요구하므로 걸리지 않는다.
set -euo pipefail

# stdin 으로 들어오는 PostToolUse 페이로드에서 편집된 파일 경로를 뽑는다.
payload="$(cat)"
file_path="$(printf '%s' "$payload" | python3 -c 'import sys,json
try:
    d=json.load(sys.stdin)
    print(d.get("tool_input",{}).get("file_path",""))
except Exception:
    print("")' 2>/dev/null || true)"

[ -n "$file_path" ] || exit 0
[ -f "$file_path" ] || exit 0

# 이 훅 스크립트 자신 / 문서화 목적 파일은 패턴을 «설명» 하느라 슬러그를 담으니 면제.
case "$file_path" in
  */.claude/hooks/guard-stale-repo-url.sh) exit 0 ;;
esac

# 금지: 존재하지 않는 옛 공개 repo 를 가리키는 GitHub URL.
#   github.com/Wayne-Kim/pocket-claude...  (host 가 github.com 이어야 매치 → pocket-claude.db 면제)
if grep -nE 'github\.com/Wayne-Kim/pocket-claude' "$file_path" >/dev/null 2>&1; then
  hits="$(grep -nE 'github\.com/Wayne-Kim/pocket-claude' "$file_path")"
  {
    echo "✋ 잘못된 공개 repo 링크가 박혔습니다 — github.com/Wayne-Kim/pocket-claude 는 존재하지 않는 옛 repo 입니다 (404)."
    echo "   공개 가이드/배포 repo 는 github.com/Wayne-Kim/pocket-sisyphus-mac 입니다."
    echo "   (이 메인 저장소 pocket-sisyphus 는 private — 사용자에게 보이는 링크로 쓰지 마세요.)"
    echo "   파일: $file_path"
    echo "$hits" | sed 's/^/     /'
    echo "   → pocket-claude 를 pocket-sisyphus-mac 으로 고치세요."
  } >&2
  exit 2
fi

exit 0
