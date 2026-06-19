#!/usr/bin/env bash
# Mac .app 의 self-contained 화 — node + tor 바이너리와 의존 dylib 들을 .app 안에 embed.
#
# ## 왜 필요한가
# 이 .app 은 DMG 로 임의의 Mac 에 배포된다. 받는 쪽에:
#   - Homebrew 가 깔려 있을 보장 0
#   - 깔려 있어도 위치가 /opt/homebrew (Apple Silicon) vs /usr/local (Intel) 로 갈림
#   - 우리가 테스트한 Node 25.4.0 / tor 0.4.9.8 와 같은 버전일 보장 0
# 그래서 빌드 시점에 모든 런타임 의존성을 .app 안에 결정적으로 박는다.
# Sandbox 비활성과 무관 — distribution 이 본질적 이유.
#
# 동작:
#   1) Node.js 공식 darwin-arm64 배포본을 다운로드해 mac/daemon/bin/node 로 배치
#      (Homebrew node 는 의존 dylib 수십 개라 부적합 — 공식 배포본은 system libs 만 의존)
#   2) Homebrew tor 를 mac/daemon/bin/tor 로 복사 + dylibbundler 로 의존 dylib
#      들(libevent, openssl, libscrypt 등)을 mac/daemon/bin/libs/ 로 같이 묶고
#      @executable_path 기반 상대 경로로 재작성
#   3) tor 의 geoip 데이터 파일(share/tor/geoip*) 도 mac/daemon/share/tor/ 로 복사
#   4) Homebrew OpenSSH portable sshd 를 mac/daemon/bin/sshd 로 복사 + dylibbundler
#      로 의존 dylib (libcrypto 등) 을 같은 libs/ 에 묶는다. 듀얼 채널 모델의 SSH 서버
#      채널 — iOS happy eyeballs 가 직접 SSH (UPnP/IPv6) 또는 Tor onion 22 포트로 접근.
#
# 결과 디렉토리(`mac/daemon/bin/`, `mac/daemon/share/`)는 .gitignore 됨.
# 매 빌드마다 결정적으로 재생성된다 (캐시는 사용).
# Xcode postCompileScript("Bundle daemon") 가 daemon/ 전체를
# .app/Contents/Resources/daemon/ 으로 그대로 옮긴다.

set -euo pipefail

# xcodebuild 가 띄우는 PATH 는 /usr/bin:/bin:/usr/sbin:/sbin 만 박혀 있어 Homebrew
# 의 dylibbundler, tor 등이 검색되지 않는다. 두 architecture 의 brew prefix 를 모두
# 박아 인터랙티브 셸과 동일한 검색 경로를 만든다.
export PATH="/opt/homebrew/bin:/usr/local/bin:${PATH:-}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DAEMON_DIR="$ROOT/mac/daemon"
BIN_DIR="$DAEMON_DIR/bin"
LIBS_DIR="$DAEMON_DIR/bin/libs"
SHARE_TOR_DIR="$DAEMON_DIR/share/tor"
CACHE_DIR="$ROOT/build/embed-cache"

# 버전을 코드에 고정 — 결정적 빌드. 업그레이드는 명시적으로.
NODE_VERSION="25.4.0"
NODE_TARBALL="node-v${NODE_VERSION}-darwin-arm64.tar.xz"
NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/${NODE_TARBALL}"
NODE_TARBALL_PATH="$CACHE_DIR/$NODE_TARBALL"
NODE_EXTRACT_DIR="$CACHE_DIR/node-v${NODE_VERSION}-darwin-arm64"

SRC_TOR="/opt/homebrew/bin/tor"

# OpenSSH portable sshd — Homebrew openssh formula 의 sbin/sshd.
# /usr/sbin/sshd (시스템) 는 macOS sysroot 의존이 강하고 SIP 보호를 받아 .app 안에 직접
# 복사하면 동작 보장 어려움. Homebrew 본을 명시적으로 임베드한다.
SRC_SSHD="/opt/homebrew/sbin/sshd"

# OpenSSH 9.8+ 멀티프로세스 모델: sshd(listener) 는 연결마다 sshd-session 을, 인증 단계에선
# sshd-auth 를 re-exec 한다. 이 헬퍼 경로는 sshd 바이너리에 «컴파일타임 절대경로»
# (…/Cellar/openssh/<버전>/libexec/sshd-session) 로 박혀 있다 — argv[0] 상대로 찾지 않는다.
# 따라서 sshd 본체만 번들하면, Homebrew openssh 가 없는(또는 버전이 다른) Mac 에선 sshd 가
# 그 Cellar 경로를 못 찾아 exit 255 로 즉사 → SSH listener 가 안 떠 페어링/연결이 전부 불가.
# 두 헬퍼를 같이 번들하고, sshd_config 의 SshdSessionPath/SshdAuthPath 로 번들 경로를 가리킨다.
# libexec 경로는 sshd symlink → Cellar 실경로에서 파생 (버전 하드코딩 회피).
SSHD_REAL="$(readlink -f "$SRC_SSHD" 2>/dev/null || greadlink -f "$SRC_SSHD" 2>/dev/null || echo "$SRC_SSHD")"
SSHD_LIBEXEC="$(dirname "$SSHD_REAL")/../libexec"
SRC_SSHD_SESSION="$SSHD_LIBEXEC/sshd-session"
SRC_SSHD_AUTH="$SSHD_LIBEXEC/sshd-auth"

red()    { printf "\033[31m%s\033[0m\n" "$*" >&2; }
green()  { printf "\033[32m%s\033[0m\n" "$*"; }
step()   { printf "\033[1;36m▸ %s\033[0m\n" "$*"; }

step "embed: 사전 점검"
if [ ! -e "$SRC_TOR" ]; then
    red "tor 가 없습니다: $SRC_TOR (brew install tor)"
    exit 1
fi
if [ ! -e "$SRC_SSHD" ]; then
    red "sshd 가 없습니다: $SRC_SSHD (brew install openssh)"
    exit 1
fi
if [ ! -e "$SRC_SSHD_SESSION" ]; then
    red "sshd-session 이 없습니다: $SRC_SSHD_SESSION (OpenSSH 9.8+ 헬퍼 — brew install openssh)"
    exit 1
fi
if [ ! -e "$SRC_SSHD_AUTH" ]; then
    red "sshd-auth 가 없습니다: $SRC_SSHD_AUTH (OpenSSH 9.8+ 헬퍼 — brew install openssh)"
    exit 1
fi
command -v dylibbundler >/dev/null || { red "dylibbundler 없음 — brew install dylibbundler"; exit 1; }

mkdir -p "$BIN_DIR" "$LIBS_DIR" "$SHARE_TOR_DIR" "$CACHE_DIR"

step "embed: Node.js v$NODE_VERSION 다운로드 (캐시)"
# 캐시 hit 시 다운로드 스킵 — CI/로컬 모두 빠른 재빌드.
if [ ! -d "$NODE_EXTRACT_DIR/bin" ]; then
    if [ ! -f "$NODE_TARBALL_PATH" ]; then
        curl -sL "$NODE_URL" -o "$NODE_TARBALL_PATH"
    fi
    tar xJf "$NODE_TARBALL_PATH" -C "$CACHE_DIR"
fi

step "embed: node 본체 복사"
# 공식 배포본 node 는 system libs 만 의존 (CoreFoundation, libSystem) → self-contained.
# Homebrew node 처럼 libnode.141.dylib + 수십 개 brotli/icu/etc 안 끌고 옴.
rsync -aL "$NODE_EXTRACT_DIR/bin/node" "$BIN_DIR/node"
chmod +x "$BIN_DIR/node"

step "embed: tor 복사"
rsync -aL "$SRC_TOR" "$BIN_DIR/tor"
chmod +x "$BIN_DIR/tor"

step "embed: sshd (+ sshd-session, sshd-auth 헬퍼) 복사"
rsync -aL "$SRC_SSHD" "$BIN_DIR/sshd"
rsync -aL "$SRC_SSHD_SESSION" "$BIN_DIR/sshd-session"
rsync -aL "$SRC_SSHD_AUTH" "$BIN_DIR/sshd-auth"
chmod +x "$BIN_DIR/sshd" "$BIN_DIR/sshd-session" "$BIN_DIR/sshd-auth"

step "embed: tor + sshd(+헬퍼) 의 dylib 의존 번들 (dylibbundler)"
# -of: overwrite, -b: install_name 자동 갱신, -x: 처리 대상 바이너리(들),
# -d: 출력 lib 디렉토리, -p: 재작성될 install_name 의 prefix.
# 모든 binary 를 한 번에 같은 libs/ 로 묶음 → 공유 dylib (libcrypto/libldns 등) 중복 방지.
# sshd-session/sshd-auth 는 sshd 와 같은 bin/ 에 두므로 @executable_path/libs/ 가 그대로 맞음.
# 매 실행마다 깨끗하게 — 잔존 lib 가 남으면 추적 어려움.
rm -rf "$LIBS_DIR"
mkdir -p "$LIBS_DIR"
dylibbundler \
    -of \
    -b \
    -x "$BIN_DIR/tor" \
    -x "$BIN_DIR/sshd" \
    -x "$BIN_DIR/sshd-session" \
    -x "$BIN_DIR/sshd-auth" \
    -d "$LIBS_DIR" \
    -p "@executable_path/libs/" \
    >/dev/null

step "embed: capture-helper 컴파일 (Swift)"
# 화면 캡처(CGDisplay) + 입력 주입(CGEvent) 헬퍼. 시스템 프레임워크(Foundation/CoreGraphics/
# ImageIO/UniformTypeIdentifiers)만 의존 → dylibbundler 불필요. daemon 의 capture/sidecar.ts 가
# POCKET_CLAUDE_CAPTURE_BIN 으로 spawn. 실행 시 화면 기록 + 손쉬운 사용 TCC 권한 필요.
xcrun swiftc -O \
    -target arm64-apple-macosx13.0 \
    -o "$BIN_DIR/capture-helper" \
    "$DAEMON_DIR/helper/capture-helper.swift"
chmod +x "$BIN_DIR/capture-helper"

step "embed: tor geoip 데이터 복사"
# tor 가 share/tor/geoip{,6} 를 기본 위치에서 찾음. torrc 의 GeoIPFile / GeoIPv6File
# 옵션으로 sidecar.ts 가 명시적으로 지정해주면 어떤 경로에 둬도 OK.
TOR_REAL="$(readlink -f "$SRC_TOR" 2>/dev/null || greadlink -f "$SRC_TOR" 2>/dev/null || echo "$SRC_TOR")"
TOR_CELLAR_SHARE="$(dirname "$TOR_REAL")/../share/tor"
if [ -d "$TOR_CELLAR_SHARE" ]; then
    rsync -a "$TOR_CELLAR_SHARE/geoip" "$TOR_CELLAR_SHARE/geoip6" "$SHARE_TOR_DIR/" 2>/dev/null || true
fi
if [ ! -f "$SHARE_TOR_DIR/geoip" ]; then
    red "geoip 파일을 찾지 못함 — Homebrew tor share 디렉토리 확인 필요"
    exit 1
fi

green "✔ embed 완료"
green "  node: $BIN_DIR/node (v$NODE_VERSION, self-contained)"
green "  tor:  $BIN_DIR/tor"
green "  sshd: $BIN_DIR/sshd (+ sshd-session, sshd-auth 헬퍼, OpenSSH portable from Homebrew)"
green "  capture: $BIN_DIR/capture-helper (Swift — 화면 캡처 + 입력 주입)"
green "  libs: $LIBS_DIR ($(ls "$LIBS_DIR" | wc -l | xargs) shared dylibs)"
green "  data: $SHARE_TOR_DIR/{geoip,geoip6}"
