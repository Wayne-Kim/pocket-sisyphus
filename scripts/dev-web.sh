#!/usr/bin/env bash
#
# /dev-web — web/ (Next.js) dev 서버 실행.
#   • 의존성 설치 (pnpm, node_modules 없거나 lockfile 바뀌었을 때만)
#   • 기존 dev 서버 정리 후 next dev 재기동 (포트 고정 → 매번 같은 URL)
#
# 사용:
#   ./scripts/dev-web.sh
#
# env:
#   PS_WEB_PORT=3000   # dev 서버 포트 (기본 3000)
#   PS_WEB_OPEN=1      # 시작 후 브라우저로 URL 열기 (기본 안 엶)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
WEB_DIR="$ROOT/web"
PORT="${PS_WEB_PORT:-3000}"

# /usr/sbin:/sbin 포함 — lsof(포트 정리)가 거기 산다. 빠지면 포트 점유 탐지가 조용히 실패한다.
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:/usr/sbin:/sbin:$PATH"

step() { printf "\n\033[1;36m▸ %s\033[0m\n" "$*"; }
ok()   { printf "\033[32m%s\033[0m\n" "$*"; }
red()  { printf "\033[31m%s\033[0m\n" "$*" >&2; }

cd "$WEB_DIR"

# pnpm — 프로젝트는 pnpm-lock.yaml 을 쓴다. corepack 으로 떨어지면 그것도 시도.
PNPM="$(command -v pnpm || true)"
if [ -z "$PNPM" ]; then
  if command -v corepack >/dev/null 2>&1; then
    corepack enable >/dev/null 2>&1 || true
    PNPM="$(command -v pnpm || true)"
  fi
fi
if [ -z "$PNPM" ]; then
  red "pnpm 을 찾을 수 없음 — 'brew install pnpm' 또는 'corepack enable' 후 다시 실행."
  exit 1
fi

# 의존성 설치 — node_modules 가 없거나 lockfile 이 더 최신일 때만 (멱등).
step "install (pnpm)"
if [ ! -d node_modules ] || [ pnpm-lock.yaml -nt node_modules ]; then
  "$PNPM" install
else
  ok "node_modules 최신 — 설치 건너뜀"
fi

# 기존 dev 서버 정리 — 포트를 점유 중인 프로세스를 종료해 매번 같은 PORT 로 뜨게(멱등).
# next dev 는 포트가 막혀 있으면 다음 포트로 옮겨가 URL 이 흔들리므로, 먼저 비운다.
step "free port :$PORT"
LSOF="$(command -v lsof || true)"
if [ -z "$LSOF" ]; then
  # lsof 가 없으면 «비어 있음» 으로 착각하지 말고 분명히 알린다 — 점유돼 있으면 next dev 가
  # 다른 포트로 떠 URL 이 흔들릴 수 있으니, 출력의 실제 Local: URL 을 봐야 한다.
  red "lsof 없음 — 포트 점유 확인/정리 불가. next dev 가 다른 포트로 뜰 수 있음(실제 Local: URL 확인)."
else
  STALE="$("$LSOF" -ti tcp:"$PORT" 2>/dev/null || true)"
  if [ -n "$STALE" ]; then
    red "포트 $PORT 점유 PID 종료: $STALE"
    kill $STALE 2>/dev/null || true
    sleep 1
    STALE="$("$LSOF" -ti tcp:"$PORT" 2>/dev/null || true)"
    [ -n "$STALE" ] && kill -9 $STALE 2>/dev/null || true
  else
    ok "포트 $PORT 비어 있음"
  fi
fi

if [ "${PS_WEB_OPEN:-0}" = "1" ]; then
  # 서버가 뜬 뒤 열리도록 잠깐 미뤄서 백그라운드로 open.
  ( sleep 3; open "http://localhost:$PORT" >/dev/null 2>&1 || true ) &
fi

step "next dev (http://localhost:$PORT)"
# foreground 로 실행 — 이 스크립트는 백그라운드로 띄워 서버를 살려둔다.
exec "$PNPM" dev --port "$PORT"
