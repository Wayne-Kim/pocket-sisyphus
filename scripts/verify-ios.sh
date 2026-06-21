#!/usr/bin/env bash
#
# /verify-ios — 에이전트의 iOS 자가 검증 루프 (시뮬레이터).
#
#   빌드(시뮬레이터) → 설치 → 개발 페어링 주입 launch → (선택) 딥링크 → 스크린샷.
#   에이전트가 스크린샷 파일을 직접 읽어 «눈으로» 확인하는 루프의 한 사이클을 담당한다.
#
# 페어링 주입 (DevPairing.swift 와 짝):
#   daemon config.json 의 평문 token + localAdminSecret 을 SIMCTL_CHILD_* 환경변수로
#   넘기면, DEBUG+시뮬레이터 빌드의 앱이 QR 스캔 없이 127.0.0.1:7777 daemon 에 직행한다.
#   (HTTP 는 X-PS-Local 헤더, WS 는 ?local= query 로 attest 게이트 통과.)
#
# 사용:
#   scripts/verify-ios.sh                                  # 빌드+설치+실행+스크린샷
#   scripts/verify-ios.sh -d 'pocketsisyphus://session/ID' # launch 후 딥링크 주입
#   scripts/verify-ios.sh -s                               # 빌드 생략 (관측만 재실행)
#   scripts/verify-ios.sh -o /tmp/shot.png                 # 스크린샷 경로 지정
#
# env:
#   PS_VERIFY_SIM_NAME=<이름>   # 기본 "iPhone 17 Pro"
#   PS_VERIFY_WAIT=<초>         # launch→스크린샷 대기 (기본 5)
#   POCKET_CLAUDE_CONFIG_DIR    # daemon config 디렉토리 오버라이드 (기본: 격리 dev 디렉터리)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
IOS_DIR="$ROOT/ios"
DERIVED="$ROOT/build/ios-sim"
# 기본 Xcode DerivedData — Tor 셀프링크 산출물 청소 시 커스텀 derivedDataPath($DERIVED)
# 외에 이 기본 위치까지 함께 비운다.
DD="$HOME/Library/Developer/Xcode/DerivedData"
BUNDLE_ID="pe.wayne.pocketsisyphus"
SIM_NAME="${PS_VERIFY_SIM_NAME:-iPhone 17 Pro}"
WAIT_SECS="${PS_VERIFY_WAIT:-5}"
# 검증/스크린샷은 «격리(dev) 데이터» 를 기본으로 쓴다 — 실 DB(pocket-sisyphus.db) 오염 방지.
# Mac DEBUG 앱(DaemonManager)의 PS_ISOLATED_DATA 격리 모드와 «같은 경로»여야 daemon 과
# 정렬된다. 실 DB 를 굳이 쓰려면 POCKET_CLAUDE_CONFIG_DIR 로 명시 오버라이드.
CONFIG_DIR="${POCKET_CLAUDE_CONFIG_DIR:-$HOME/Library/Application Support/PocketSisyphus-dev}"

DEEPLINK=""
# 스크린샷은 레포의 attachments/ 에 보관 (이미 gitignore 된 앱 첨부 컨벤션 폴더).
# dot-폴더(.verify)는 첨부/미리보기에서 숨겨져 안 보이는 이슈가 있어 여기로 통일.
OUT="$ROOT/attachments/verify-$(date +%m%d-%H%M%S).png"
SKIP_BUILD=0
while getopts "d:o:s" opt; do
  case "$opt" in
    d) DEEPLINK="$OPTARG" ;;
    o) OUT="$OPTARG" ;;
    s) SKIP_BUILD=1 ;;
    *) echo "usage: $0 [-d deeplink] [-o out.png] [-s]" >&2; exit 2 ;;
  esac
done

export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"

step() { printf "\n\033[1;36m▸ %s\033[0m\n" "$*"; }
ok()   { printf "\033[32m%s\033[0m\n" "$*"; }
red()  { printf "\033[31m%s\033[0m\n" "$*" >&2; }

# Tor.framework «can't link a dylib with itself» 회피 — dev.sh 의 clean_tor_products 와
# 동일 + 우리 derivedDataPath 분까지. clean 상태에서 한 번 링크하면 안 터진다.
clean_tor_products() {
  find "$DD" "$DERIVED" -path '*EagerLinkingTBDs*Tor.framework*' \
    -prune -exec rm -rf {} + 2>/dev/null || true
  find "$DD"/PocketSisyphus-*/Build/Products "$DERIVED/Build/Products" \
    -maxdepth 2 -type d -name Tor -prune -exec rm -rf {} + 2>/dev/null || true
}

# ── 0) daemon + 페어링 비밀 확보 ──────────────────────────────────────────────
step "daemon 확인 (config: $CONFIG_DIR)"
if [ ! -f "$CONFIG_DIR/config.json" ]; then
  red "config.json 없음: $CONFIG_DIR/config.json — Mac 앱(daemon)을 먼저 실행하라."
  exit 1
fi
read -r TOKEN LOCAL_SECRET DAEMON_PORT < <(python3 - "$CONFIG_DIR/config.json" <<'PY'
import json, sys
cfg = json.load(open(sys.argv[1]))
print(cfg.get("token", ""), cfg.get("localAdminSecret", ""), cfg.get("port", 7777))
PY
)
if [ -z "$TOKEN" ]; then red "config.json 에 평문 token 이 없다."; exit 1; fi
if ! curl -fsS -m 3 "http://127.0.0.1:${DAEMON_PORT}/health" >/dev/null 2>&1; then
  red "daemon 이 http://127.0.0.1:${DAEMON_PORT} 에서 응답하지 않는다 — Mac 앱을 실행하라."
  exit 1
fi
ok "daemon OK (port ${DAEMON_PORT})"

# ── 1) 시뮬레이터 부팅 ────────────────────────────────────────────────────────
step "시뮬레이터 «${SIM_NAME}» 확보"
SIM_UDID="$(xcrun simctl list devices available | awk -v n="$SIM_NAME" '
  index($0, n " (") { if (match($0, /[0-9A-F-]{36}/)) { print substr($0, RSTART, RLENGTH); exit } }')"
if [ -z "$SIM_UDID" ]; then
  red "시뮬레이터 «${SIM_NAME}» 를 찾을 수 없다. xcrun simctl list devices available 확인."
  exit 1
fi
xcrun simctl bootstatus "$SIM_UDID" -b >/dev/null
ok "booted ($SIM_UDID)"

# ── 2) 빌드 ───────────────────────────────────────────────────────────────────
APP="$DERIVED/Build/Products/Debug-iphonesimulator/PocketSisyphus.app"
if [ "$SKIP_BUILD" = "1" ]; then
  step "빌드 생략 (-s)"
  [ -d "$APP" ] || { red "기존 .app 없음: $APP — -s 없이 한 번 빌드하라."; exit 1; }
else
  step "빌드 (Debug, iOS Simulator)"
  log="/tmp/ps-verify-ios-build.log"
  _build() {
    ( cd "$IOS_DIR" && xcodebuild build \
        -workspace PocketSisyphus.xcworkspace \
        -scheme PocketSisyphus \
        -configuration Debug \
        -destination "platform=iOS Simulator,id=${SIM_UDID}" \
        -derivedDataPath "$DERIVED" \
        EAGER_LINKING=NO EAGER_LINKING_TBDS=NO ) > "$log" 2>&1
  }
  if ! _build; then
    if grep -q "can't link a dylib with itself" "$log"; then
      step "Tor 셀프링크 충돌 → 산출물 청소 후 재시도"
      clean_tor_products
      _build || { red "빌드 실패. 마지막 40줄:"; tail -40 "$log" >&2; exit 1; }
    else
      red "빌드 실패. 마지막 40줄:"; tail -40 "$log" >&2; exit 1
    fi
  fi
  ok "build succeeded"
fi

# ── 3) 설치 + 개발 페어링 주입 launch (딥링크 포함) ──────────────────────────
# 딥링크는 `simctl openurl` 이 아니라 launch env 로 — openurl 은 시스템 «열겠습니까?»
# 확인 다이얼로그를 띄워 무인 검증이 막힌다. 앱이 PS_DEV_DEEPLINK 를 읽어 내부 라우팅.
step "설치 + launch (개발 페어링 주입${DEEPLINK:+ + 딥링크})"
xcrun simctl install "$SIM_UDID" "$APP"
xcrun simctl terminate "$SIM_UDID" "$BUNDLE_ID" 2>/dev/null || true
SIMCTL_CHILD_PS_DEV_DAEMON_TOKEN="$TOKEN" \
SIMCTL_CHILD_PS_DEV_LOCAL_SECRET="$LOCAL_SECRET" \
SIMCTL_CHILD_PS_DEV_DAEMON_PORT="$DAEMON_PORT" \
SIMCTL_CHILD_PS_DEV_DEEPLINK="$DEEPLINK" \
SIMCTL_CHILD_PS_DEV_PRO=1 \
  xcrun simctl launch "$SIM_UDID" "$BUNDLE_ID" >/dev/null
ok "launched${DEEPLINK:+ (deeplink: $DEEPLINK)}"

# ── 4) 스크린샷 ───────────────────────────────────────────────────────────────
# 관측 대기는 최대 30초 — 그 이상은 «관측» 이 아니라 «방치». 더 긴 작업은 폴링으로.
[ "$WAIT_SECS" -gt 30 ] && WAIT_SECS=30
step "${WAIT_SECS}s 대기 후 스크린샷"
sleep "$WAIT_SECS"
mkdir -p "$(dirname "$OUT")"
xcrun simctl io "$SIM_UDID" screenshot "$OUT" >/dev/null
ok "→ $OUT"
echo "$OUT"
