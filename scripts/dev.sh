#!/usr/bin/env bash
#
# /dev — dev 빌드 + 설치.
#   • iOS dev : 케이블 연결된 실기기 (iPhone 13 mini) 에 Debug 빌드 설치.
#   • Mac dev : Debug 빌드 후 실행 중 인스턴스 교체(재실행).
#
# 사용:
#   ./scripts/dev.sh            # iOS(실기기) + Mac 둘 다
#   ./scripts/dev.sh ios        # iOS 실기기만
#   ./scripts/dev.sh mac        # Mac 만
#
# env:
#   PS_DEV_DEVICE_UDID=<udid>   # 다른 iPhone (기본: iPhone 13 mini)
#   PS_DEV_REGEN=1              # 빌드 전 xcodegen generate (project.yml 변경 후)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
IOS_DIR="$ROOT/ios"
MAC_DIR="$ROOT/mac"

# Wayne's iPhone 13 mini (케이블). `xcrun xctrace list devices` 로 확인.
DEVICE_UDID="${PS_DEV_DEVICE_UDID:-00008110-000245DC1E52801E}"
TARGET="${1:-all}"
DD="$HOME/Library/Developer/Xcode/DerivedData"

export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"

step() { printf "\n\033[1;36m▸ %s\033[0m\n" "$*"; }
ok()   { printf "\033[32m%s\033[0m\n" "$*"; }
red()  { printf "\033[31m%s\033[0m\n" "$*" >&2; }

# Tor.framework «can't link a dylib with itself» 회피 — Tor 가 재링크될 때 자기 산출물/ TBD
# 를 search path 에서 발견하면 self-link 충돌. clean 상태에서 한 번 링크하면 안 터진다.
clean_tor_products() {
  find "$DD" -path '*EagerLinkingTBDs*Tor.framework*' -prune -exec rm -rf {} + 2>/dev/null || true
  find "$DD"/PocketSisyphus-*/Build/Products -maxdepth 2 -type d -name Tor \
    -prune -exec rm -rf {} + 2>/dev/null || true
}

regen() {
  [ "${PS_DEV_REGEN:-0}" = "1" ] || return 0
  step "xcodegen generate ($1)"
  ( cd "$1" && xcodegen generate )
}

# ── iOS dev → 실기기 ──────────────────────────────────────────────────────────
build_install_ios() {
  step "iOS dev — 실기기 ($DEVICE_UDID) 대상 빌드 + 설치"

  if ! xcrun xctrace list devices 2>/dev/null \
       | awk '/== Devices Offline ==/{o=1} /== Simulators ==/{o=0} !o' \
       | grep -qi "$DEVICE_UDID"; then
    red "경고: $DEVICE_UDID 가 연결 목록에 없음 (케이블/잠금해제/신뢰/개발자 모드 확인). xcodebuild 에 맡기고 계속."
  fi

  regen "$IOS_DIR"

  local log="/tmp/ps-dev-ios-build.log"
  _ios_build() {
    ( cd "$IOS_DIR" && xcodebuild build \
        -workspace PocketSisyphus.xcworkspace \
        -scheme PocketSisyphus \
        -configuration Debug \
        -destination "platform=iOS,id=${DEVICE_UDID}" \
        -allowProvisioningUpdates \
        EAGER_LINKING=NO EAGER_LINKING_TBDS=NO ) > "$log" 2>&1
  }
  step "build (Debug, device)"
  if ! _ios_build; then
    if grep -q "can't link a dylib with itself" "$log"; then
      step "Tor 셀프링크 충돌 → 산출물 청소 후 재시도"
      clean_tor_products
      _ios_build || { red "iOS 빌드 실패. 마지막 40줄:"; tail -40 "$log" >&2; return 1; }
    else
      red "iOS 빌드 실패. 마지막 40줄:"; tail -40 "$log" >&2; return 1
    fi
  fi
  ok "build succeeded"

  local app
  app="$(ls -dt "$DD"/PocketSisyphus-*/Build/Products/Debug-iphoneos/PocketSisyphus.app 2>/dev/null | head -1)"
  if [ -z "$app" ] || [ ! -d "$app" ]; then
    red "빌드된 .app 을 못 찾음: $DD/PocketSisyphus-*/Build/Products/Debug-iphoneos/PocketSisyphus.app"; return 1
  fi

  step "install on device ($app)"
  xcrun devicectl device install app --device "$DEVICE_UDID" "$app" 2>&1 | tail -6
  ok "✔ iOS dev 설치 완료 — iPhone 에서 앱 실행"
}

# ── Mac dev → 빌드 + 재실행 ───────────────────────────────────────────────────
build_install_mac() {
  step "Mac dev — 빌드 + 설치(재실행)"
  regen "$MAC_DIR"

  local log="/tmp/ps-dev-mac-build.log"
  step "build (Debug, macOS — daemon/tor nested 서명 포함, 시간 좀 걸림)"
  if ! ( cd "$MAC_DIR" && xcodebuild build \
          -project PocketSisyphusMac.xcodeproj \
          -scheme PocketSisyphusMac \
          -configuration Debug \
          -destination 'platform=macOS' \
          -allowProvisioningUpdates ) > "$log" 2>&1; then
    red "Mac 빌드 실패. 마지막 40줄:"; tail -40 "$log" >&2; return 1
  fi
  ok "build succeeded"

  local app
  # dev 빌드는 PRODUCT_NAME="Pocket Sisyphus Dev" 라 .app 이름이 PocketSisyphusMac 이 아님 →
  # 이름에 의존하지 말고 Debug 산출물의 .app 을 최신순으로 집는다.
  app="$(ls -dt "$DD"/PocketSisyphusMac-*/Build/Products/Debug/*.app 2>/dev/null | head -1)"
  if [ -z "$app" ] || [ ! -d "$app" ]; then
    red "빌드된 Mac .app 을 못 찾음."; return 1
  fi

  step "기존 인스턴스 종료 후 새 빌드 실행 ($app)"
  # GUI + daemon/tor/sshd 자식까지 번들 경로로 종료(이름 무관). pkill -x 는 옛 이름 대비 보조.
  pkill -f 'Build/Products/Debug/[^/]*\.app/Contents' 2>/dev/null || true
  pkill -x PocketSisyphusMac 2>/dev/null || true
  sleep 0.5
  pkill -9 -f 'Build/Products/Debug/[^/]*\.app/Contents' 2>/dev/null || true
  open "$app"
  ok "✔ Mac dev 실행 — 메뉴바 아이콘 확인"
}

case "$TARGET" in
  ios) build_install_ios ;;
  mac) build_install_mac ;;
  all) build_install_ios; build_install_mac ;;
  *)   red "알 수 없는 타겟 '$TARGET' — ios | mac | all 중 하나"; exit 2 ;;
esac

step "done"
