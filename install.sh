#!/usr/bin/env bash
#
# Pocket Sisyphus for Mac — 한 줄 설치 스크립트.
#
# 사용자는 이거 한 줄만 실행하면 된다 (사전 의존성 0 — macOS 에 기본 탑재된 curl 만 필요):
#
#   curl -fsSL https://raw.githubusercontent.com/Wayne-Kim/pocket-sisyphus/main/install.sh | bash
#
# 동작:
#   1) GitHub Release 의 «최신» appcast.xml (고정 URL) 에서 최신 DMG 다운로드 URL 을 파싱
#      — appcast.xml 의 <enclosure> 가 곧 «최신 DMG» 의 single source of truth.
#      (파싱 실패 시 GitHub API 로 fallback)
#   2) DMG 다운로드 → 마운트 → 안에 있는 .app 을 /Applications 로 복사 → 언마운트
#   3) 실행 중이던 기존 인스턴스가 있으면 종료한 뒤 교체
#   4) 설치된 앱 실행 (open)
#
# DMG 는 Apple notarize + staple 완료본이라 Gatekeeper 가 조용히 통과한다
# (curl 다운로드는 quarantine 플래그도 안 붙어 첫 실행 경고 없음).
#
# 환경변수 (선택):
#   PS_REPO          : 릴리스 저장소 (기본 Wayne-Kim/pocket-sisyphus)
#   PS_INSTALL_DIR   : 설치 위치 (기본 /Applications)
#   PS_NO_LAUNCH=1   : 설치 후 자동 실행 생략
#   PS_LANG=en|ko    : 출력 언어 강제 (기본: 시스템 로케일 자동 감지)

set -euo pipefail

REPO="${PS_REPO:-Wayne-Kim/pocket-sisyphus}"
INSTALL_DIR="${PS_INSTALL_DIR:-/Applications}"

# 언어 결정: PS_LANG 강제값 > 시스템 로케일(LC_ALL>LC_MESSAGES>LANG). ko* 면 한국어, 그 외 영어.
_loc="${PS_LANG:-${LC_ALL:-${LC_MESSAGES:-${LANG:-}}}}"
case "$_loc" in
    ko*) LANGCODE=ko ;;
    *)   LANGCODE=en ;;
esac

# 번역 테이블. t <key> [printf-args...] → 현재 언어의 문자열을 stdout 으로.
t() {
    local key="$1"; shift
    local fmt
    if [ "$LANGCODE" = ko ]; then
        case "$key" in
            need_macos)       fmt="macOS 전용 설치 스크립트입니다." ;;
            need_curl)        fmt="curl 이 필요합니다." ;;
            need_hdiutil)     fmt="hdiutil 이 필요합니다 (macOS 기본 제공)." ;;
            start)            fmt="Pocket Sisyphus for Mac — 설치를 시작합니다." ;;
            step_check)       fmt="최신 버전 확인" ;;
            fallback_api)     fmt="appcast.xml 파싱 실패 — GitHub API 로 fallback." ;;
            no_dmg_url)       fmt="최신 DMG 다운로드 URL 을 찾지 못했습니다." ;;
            check_repo)       fmt="  저장소: https://github.com/%s/releases/latest 를 직접 확인해 주세요." ;;
            latest)           fmt="최신" ;;
            version_line)     fmt="  %s → %s" ;;
            step_download)    fmt="다운로드" ;;
            step_mount)       fmt="DMG 마운트" ;;
            no_app)           fmt="DMG 안에서 .app 을 찾지 못했습니다." ;;
            step_install)     fmt="%s 에 설치" ;;
            need_sudo)        fmt="  %s 쓰기 권한이 없어 관리자 비밀번호가 필요합니다." ;;
            gk_ok)            fmt="  Gatekeeper 통과 확인 (notarized)." ;;
            gk_skip)          fmt="  Gatekeeper 평가를 생략했습니다 — 첫 실행 시 우클릭→열기 가 필요할 수 있습니다." ;;
            done)             fmt="✔ 설치 완료: %s" ;;
            step_launch)      fmt="실행" ;;
            launched_menubar) fmt="  메뉴바에서 Pocket Sisyphus 아이콘을 확인하세요." ;;
            launch_manually)  fmt="  Launchpad / Spotlight 에서 «Pocket Sisyphus» 로 실행하세요." ;;
            update_note)      fmt="  이후 업데이트는 앱 내장 Sparkle 이 자동 감지합니다 (메뉴바 → «업데이트 확인…»)." ;;
            *)                fmt="$key" ;;
        esac
    else
        case "$key" in
            need_macos)       fmt="This installer is for macOS only." ;;
            need_curl)        fmt="curl is required." ;;
            need_hdiutil)     fmt="hdiutil is required (bundled with macOS)." ;;
            start)            fmt="Pocket Sisyphus for Mac — starting installation." ;;
            step_check)       fmt="Checking the latest version" ;;
            fallback_api)     fmt="Failed to parse appcast.xml — falling back to the GitHub API." ;;
            no_dmg_url)       fmt="Could not find the latest DMG download URL." ;;
            check_repo)       fmt="  Please check https://github.com/%s/releases/latest directly." ;;
            latest)           fmt="latest" ;;
            version_line)     fmt="  %s → %s" ;;
            step_download)    fmt="Downloading" ;;
            step_mount)       fmt="Mounting the DMG" ;;
            no_app)           fmt="Could not find a .app inside the DMG." ;;
            step_install)     fmt="Installing to %s" ;;
            need_sudo)        fmt="  No write permission to %s — your administrator password is required." ;;
            gk_ok)            fmt="  Gatekeeper check passed (notarized)." ;;
            gk_skip)          fmt="  Skipped Gatekeeper assessment — you may need to right-click → Open on first launch." ;;
            done)             fmt="✔ Installation complete: %s" ;;
            step_launch)      fmt="Launching" ;;
            launched_menubar) fmt="  Look for the Pocket Sisyphus icon in the menu bar." ;;
            launch_manually)  fmt="  Launch «Pocket Sisyphus» from Launchpad / Spotlight." ;;
            update_note)      fmt="  Future updates are detected automatically by the built-in Sparkle (menu bar → «Check for Updates…»)." ;;
            *)                fmt="$key" ;;
        esac
    fi
    # shellcheck disable=SC2059
    printf "$fmt" "$@"
}

red()    { printf "\033[31m%s\033[0m\n" "$*" >&2; }
green()  { printf "\033[32m%s\033[0m\n" "$*"; }
yellow() { printf "\033[33m%s\033[0m\n" "$*"; }
step()   { printf "\n\033[1;36m▸ %s\033[0m\n" "$*"; }

# ----------------------------------------------------------------------------
# 0) 환경 점검
# ----------------------------------------------------------------------------

[ "$(uname -s)" = "Darwin" ] || { red "$(t need_macos)"; exit 1; }
command -v curl   >/dev/null || { red "$(t need_curl)"; exit 1; }
command -v hdiutil>/dev/null || { red "$(t need_hdiutil)"; exit 1; }

printf "\033[1;35m"
cat <<'BANNER'
  ____           _        _     ____  _                       _
 |  _ \ ___   ___| | _____| |_  / ___|(_)___ _   _ _ __  _ __ | |_   _ ___
 | |_) / _ \ / __| |/ / _ \ __| \___ \| / __| | | | '_ \| '_ \| | | | / __|
 |  __/ (_) | (__|   <  __/ |_   ___) | \__ \ |_| | |_) | | | | | |_| \__ \
 |_|   \___/ \___|_|\_\___|\__| |____/|_|___/\__, | .__/|_| |_|_|\__,_|___/
                                             |___/|_|
BANNER
printf "\033[0m"
green "$(t start)"

# 임시 작업공간 + 정리 트랩.
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pocket-sisyphus.XXXXXX")"
DMG_PATH="$WORK_DIR/PocketSisyphus.dmg"
MOUNT_POINT="$WORK_DIR/mnt"
mkdir -p "$MOUNT_POINT"

cleanup() {
    if [ -d "${MOUNT_POINT:-}" ] && mount | grep -q " ${MOUNT_POINT} "; then
        hdiutil detach "$MOUNT_POINT" -quiet 2>/dev/null || true
    fi
    [ -n "${WORK_DIR:-}" ] && rm -rf "$WORK_DIR" 2>/dev/null || true
}
trap cleanup EXIT

# ----------------------------------------------------------------------------
# 1) 최신 DMG URL 해석
# ----------------------------------------------------------------------------

step "$(t step_check)"

# 1차: 고정 URL 의 appcast.xml (<enclosure> = 최신 DMG 직링크).
APPCAST_URL="https://github.com/${REPO}/releases/latest/download/appcast.xml"
APPCAST="$(curl -fsSL "$APPCAST_URL" 2>/dev/null || true)"

DMG_URL="$(printf '%s' "$APPCAST" \
    | grep -o 'enclosure url="[^"]*\.dmg"' \
    | head -1 \
    | sed -E 's/.*url="([^"]*)".*/\1/' || true)"
VERSION="$(printf '%s' "$APPCAST" \
    | grep -o '<title>v[^<]*</title>' \
    | head -1 \
    | sed -E 's@</?title>@@g' || true)"

# 2차 (fallback): GitHub API 로 최신 release 의 .dmg asset 직접 조회.
if [ -z "$DMG_URL" ]; then
    yellow "$(t fallback_api)"
    DMG_URL="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" 2>/dev/null \
        | grep -o '"browser_download_url"[^,]*\.dmg"' \
        | head -1 \
        | sed -E 's/.*"(https[^"]*)".*/\1/' || true)"
fi

if [ -z "$DMG_URL" ]; then
    red "$(t no_dmg_url)"
    red "$(t check_repo "$REPO")"
    exit 1
fi
green "$(t version_line "${VERSION:-$(t latest)}" "$(basename "$DMG_URL")")"

# ----------------------------------------------------------------------------
# 2) 다운로드
# ----------------------------------------------------------------------------

step "$(t step_download)"
curl -fL --progress-bar -o "$DMG_PATH" "$DMG_URL"

# ----------------------------------------------------------------------------
# 3) 마운트 → .app 추출
# ----------------------------------------------------------------------------

step "$(t step_mount)"
hdiutil attach -nobrowse -readonly -mountpoint "$MOUNT_POINT" "$DMG_PATH" >/dev/null

APP_SRC="$(find "$MOUNT_POINT" -maxdepth 1 -name '*.app' -type d | head -1)"
if [ -z "$APP_SRC" ]; then
    red "$(t no_app)"
    exit 1
fi
APP_NAME="$(basename "$APP_SRC")"
DEST="$INSTALL_DIR/$APP_NAME"

# ----------------------------------------------------------------------------
# 4) 실행 중 인스턴스 종료 → 설치
# ----------------------------------------------------------------------------

# 실행 중이면 먼저 점잖게 종료 (열린 채 번들을 덮어쓰면 손상 가능).
osascript -e "quit app \"${APP_NAME%.app}\"" >/dev/null 2>&1 || true

step "$(t step_install "$INSTALL_DIR")"
# /Applications 는 보통 admin 그룹 쓰기 가능. 권한 없으면 sudo 로 한 번만 승격
# (sudo 는 /dev/tty 에서 비밀번호를 받으므로 curl|bash 파이프에서도 동작).
if [ -w "$INSTALL_DIR" ] && { [ ! -e "$DEST" ] || [ -w "$DEST" ]; }; then
    rm -rf "$DEST"
    ditto "$APP_SRC" "$DEST"
else
    yellow "$(t need_sudo "$INSTALL_DIR")"
    sudo rm -rf "$DEST"
    sudo ditto "$APP_SRC" "$DEST"
    sudo chown -R "$(id -un):$(id -gn)" "$DEST" 2>/dev/null || true
fi

# curl 다운로드면 quarantine 가 없지만, 혹시 모를 경로(브라우저 경유 등) 대비해 제거.
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null \
    || sudo xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true

# Gatekeeper 평가 (soft check — 실패해도 설치는 진행).
if spctl --assess --type execute "$DEST" >/dev/null 2>&1; then
    green "$(t gk_ok)"
else
    yellow "$(t gk_skip)"
fi

# ----------------------------------------------------------------------------
# 5) 실행
# ----------------------------------------------------------------------------

green ""
green "$(t done "$DEST")"
if [ "${PS_NO_LAUNCH:-0}" != "1" ]; then
    step "$(t step_launch)"
    open "$DEST"
    green "$(t launched_menubar)"
else
    green "$(t launch_manually)"
fi
green ""
green "$(t update_note)"
