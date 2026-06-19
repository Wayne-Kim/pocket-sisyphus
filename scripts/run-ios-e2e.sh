#!/usr/bin/env bash
#
# iOS ↔ daemon 풀스택 e2e — **실기기 (iPhone 13 mini, 케이블) + XCUITest**.
#
# 설계 원칙
#   • daemon 은 «프로덕션 그대로». e2e 코드 주입 0. 이미 실행 중인 daemon (Mac 앱이 띄운
#     그것 — 기기가 페어링한 바로 그 daemon) 을 재사용한다. 안 떠 있으면 같은 CONFIG_DIR
#     로 best-effort spawn (onion/host key/authorized_keys 가 persisted → 재페어링 불필요).
#   • 카메라 QR 페어링은 자동화 대상 아님 (사용자 영역, 이미 동작). 이 스크립트는 *이미
#     페어링된* 기기를 전제로 한다. 미페어링이면 XCUITest 가 명확한 메시지로 실패한다.
#   • 검증은 전적으로 iOS 화면에서 (XCUITest). 러너는 daemon 을 띄우고, 앱이 쓰는 바로 그
#     공개 API 로 e2e 세션 1개를 미리 만들어 둔 뒤, 실기기에 빌드/설치/테스트만 한다.
#
# 흐름
#   1) 7777 의 daemon 확보 (재사용 우선, 없으면 spawn) + /health 대기
#   2) config.json 의 token 으로 'E2E-ROUNDTRIP' shell 세션 확보 (앱과 동일한 POST /api/sessions)
#   3) PocketSisyphusE2E 스킴을 iPhone 13 mini 에 xcodebuild test
#   4) trap: 우리가 spawn 한 daemon 만 정리
#
# 사용:
#     ./scripts/run-ios-e2e.sh
#
# 다른 기기로:  PS_E2E_DEVICE_UDID=<udid> ./scripts/run-ios-e2e.sh
# project.yml 변경 후 프로젝트 재생성까지:  PS_E2E_REGEN=1 ./scripts/run-ios-e2e.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
IOS_DIR="$ROOT/ios"
DAEMON_DIR="$ROOT/mac/daemon"

# Wayne's iPhone 13 mini (케이블). `xcrun devicectl list devices` 로 확인.
DEVICE_UDID="${PS_E2E_DEVICE_UDID:-00008110-000245DC1E52801E}"
PORT="${PS_E2E_PORT:-7777}"
# 기본 CONFIG_DIR 은 «격리(dev) 데이터» — 실 DB 오염 방지. 안 떠 있으면 이 격리 디렉터리로
# best-effort spawn 하므로 daemon 도 같은 dev DB 를 연다. 실 DB 를 쓰려면 POCKET_CLAUDE_CONFIG_DIR
# 로 명시 오버라이드 (Mac DEBUG 앱의 PS_ISOLATED_DATA 격리 모드와 같은 경로).
CONFIG_DIR="${POCKET_CLAUDE_CONFIG_DIR:-$HOME/Library/Application Support/PocketSisyphus-dev}"
DAEMON_URL="http://127.0.0.1:${PORT}"
SESSION_TITLE="E2E-ROUNDTRIP"          # XCUITest 의 sessionTitle 과 반드시 일치
E2E_REPO="${PS_E2E_REPO:-/tmp/ps-e2e-repo}"
SCHEME="PocketSisyphusE2E"

export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"

step() { printf "\n\033[1;36m▸ %s\033[0m\n" "$*"; }
ok()   { printf "\033[32m%s\033[0m\n" "$*"; }
red()  { printf "\033[31m%s\033[0m\n" "$*" >&2; }

SPAWNED_DAEMON=0
DAEMON_PID=""
DAEMON_LOG="$(mktemp -t ps-e2e-daemon)"

cleanup() {
  local rc=$?
  if [ "$SPAWNED_DAEMON" = "1" ] && [ -n "$DAEMON_PID" ] && kill -0 "$DAEMON_PID" 2>/dev/null; then
    step "Stopping spawned daemon (pid=$DAEMON_PID)"
    kill -TERM "$DAEMON_PID" 2>/dev/null || true
    wait "$DAEMON_PID" 2>/dev/null || true
  fi
  exit $rc
}
trap cleanup EXIT INT TERM

health_ok() { curl -fsS -m 3 "${DAEMON_URL}/health" >/dev/null 2>&1; }

# ── 0) 케이블 연결된 기기 확인 ────────────────────────────────────────────────
#    하드웨어 UDID(00008110-...)는 `xctrace list devices` 가 보여준다 (devicectl 의
#    Identifier 열은 별개의 coredevice UUID 라 매칭 안 됨). 최종 권위는 xcodebuild —
#    여기선 일찍 친절히 경고만 하고, 못 찾아도 계속 진행한다.
step "Checking connected device ($DEVICE_UDID)"
XCTRACE_DEVICES="$(xcrun xctrace list devices 2>/dev/null || true)"
if printf '%s' "$XCTRACE_DEVICES" | awk '/== Devices Offline ==/{off=1} /== Simulators ==/{off=0} !off' | grep -qi "$DEVICE_UDID"; then
  ok "device connected"
else
  red "경고: $DEVICE_UDID 를 연결된 기기 목록에서 못 찾음 (케이블/잠금해제/신뢰 확인). xcodebuild 에 맡기고 계속."
  printf '%s\n' "$XCTRACE_DEVICES" | sed -n '1,20p' >&2 || true
fi

# ── 1) daemon 확보 ────────────────────────────────────────────────────────────
if health_ok; then
  step "daemon 이미 실행 중 — 재사용 (${DAEMON_URL})"
  ok "$(curl -fsS -m 3 "${DAEMON_URL}/health")"
else
  step "daemon 미실행 — 같은 CONFIG_DIR 로 spawn 시도"
  echo "  CONFIG_DIR=$CONFIG_DIR"
  echo "  log=$DAEMON_LOG"
  if [ ! -d "$DAEMON_DIR/node_modules" ]; then
    step "daemon 의존성 설치 (npm install)"
    ( cd "$DAEMON_DIR" && npm install )
  fi
  (
    cd "$DAEMON_DIR"
    POCKET_CLAUDE_CONFIG_DIR="$CONFIG_DIR" \
    POCKET_CLAUDE_AUTO_INIT=1 \
    POCKET_CLAUDE_NO_OPEN=1 \
      exec npx tsx src/index.ts
  ) > "$DAEMON_LOG" 2>&1 &
  DAEMON_PID=$!
  SPAWNED_DAEMON=1

  # Tor 부트스트랩 포함 — 넉넉히 90s.
  for _ in $(seq 1 90); do
    if health_ok; then break; fi
    if ! kill -0 "$DAEMON_PID" 2>/dev/null; then
      red "daemon 이 부팅 중 죽었다. 마지막 50줄:"; tail -50 "$DAEMON_LOG" >&2
      red "팁: Mac 앱(PocketSisyphus)을 직접 실행해 daemon 을 띄운 뒤 다시 시도하라."
      exit 1
    fi
    sleep 1
  done
  if ! health_ok; then
    red "daemon /health 가 90s 안에 응답 안 함. 마지막 50줄:"; tail -50 "$DAEMON_LOG" >&2
    red "팁: Mac 앱(PocketSisyphus)을 직접 실행해 daemon 을 띄운 뒤 다시 시도하라."
    exit 1
  fi
  ok "spawned daemon ready (pid=$DAEMON_PID)"
fi

# ── 2) e2e 세션 확보 (앱과 동일한 공개 API) ──────────────────────────────────
if [ ! -f "$CONFIG_DIR/config.json" ]; then
  red "config.json 이 없다: $CONFIG_DIR/config.json — daemon CONFIG_DIR 확인."
  exit 1
fi
TOKEN="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['token'])" "$CONFIG_DIR/config.json")"
if [ -z "$TOKEN" ]; then red "config.json 에 token 이 없다."; exit 1; fi

step "Ensuring e2e repo dir + git ($E2E_REPO)"
mkdir -p "$E2E_REPO"
( cd "$E2E_REPO" && git rev-parse --git-dir >/dev/null 2>&1 || git init -q )
ok "repo ready"

step "Ensuring '$SESSION_TITLE' shell session via $DAEMON_URL/api/sessions"
EXISTING="$(curl -fsS -m 5 -H "Authorization: Bearer ${TOKEN}" "${DAEMON_URL}/api/sessions" 2>/dev/null || echo '{}')"
HAS_SESSION="$(printf '%s' "$EXISTING" | python3 -c "
import json,sys
try: data=json.load(sys.stdin)
except Exception: data={}
print('yes' if any((s.get('title')=='$SESSION_TITLE') for s in data.get('sessions',[])) else 'no')
" 2>/dev/null || echo no)"

if [ "$HAS_SESSION" = "yes" ]; then
  ok "기존 '$SESSION_TITLE' 세션 재사용"
else
  CREATE="$(curl -fsS -m 10 \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "Content-Type: application/json" \
    -d "{\"repoPath\":\"${E2E_REPO}\",\"agent\":\"shell\",\"title\":\"${SESSION_TITLE}\"}" \
    "${DAEMON_URL}/api/sessions")"
  SID="$(printf '%s' "$CREATE" | python3 -c "import json,sys; print(json.load(sys.stdin).get('sessionId',''))" 2>/dev/null || true)"
  if [ -z "$SID" ]; then red "세션 생성 실패. 응답: $CREATE"; exit 1; fi
  ok "세션 생성: $SID"
fi

# ── 3) (선택) project.yml → xcodeproj 재생성 ─────────────────────────────────
need_regen=0
if ! ( cd "$IOS_DIR" && xcodebuild -list -workspace PocketSisyphus.xcworkspace 2>/dev/null | grep -q "$SCHEME" ); then
  need_regen=1
fi
if [ "${PS_E2E_REGEN:-0}" = "1" ] || [ "$need_regen" = "1" ]; then
  step "xcodegen generate (+ pod install)"
  ( cd "$IOS_DIR" && xcodegen generate )
fi

# ── 4) 실기기 빌드 + 테스트 ───────────────────────────────────────────────────
#
# Tor.framework 의 «can't link a dylib with itself» (EagerLinkingTBDs 셀프충돌) 회피:
#   • test 액션은 메인 앱 + UITest 러너를 같이 링크하는데, 이때 Tor 의 eager-linking
#     TBD 가 생성되고 Tor 타겟이 자기 TBD 를 다시 링크하려다 깨진다. (run/archive 는
#     안 터지지만 test 그래프에선 터진다.) Podfile 의 per-pod EAGER_LINKING=NO 만으론
#     TBD 를 «생성하는» 소비자(러너)까지 못 막는다 → 커맨드라인에 전역으로 NO 를 박는다.
#   • 이전 eager 빌드가 남긴 stale Tor TBD 도 재링크 시 충돌 원인 → 빌드 전에 청소.
#   • 한 방 `test` 대신 build-for-testing → test-without-building 으로 분리: 테스트 실행
#     단계에서 Tor 를 재링크하지 않게 해 충돌 표면을 더 줄인다.
set -o pipefail
EAGER_OFF=(EAGER_LINKING=NO EAGER_LINKING_TBDS=NO)
DEST="platform=iOS,id=${DEVICE_UDID}"

step "Cleaning stale Tor build products + eager-linking TBDs"
# 핵심: Tor 가 «재링크» 될 때 자기 산출물/ TBD 를 search path 에서 발견하면 self-link 충돌.
# clean 상태(산출물 없음)에서 Tor 를 한 번 링크하면 충돌이 없다 → 빌드 전에 둘 다 제거.
find "$HOME/Library/Developer/Xcode/DerivedData" -path '*EagerLinkingTBDs*Tor.framework*' \
  -prune -exec rm -rf {} + 2>/dev/null || true
find "$HOME/Library/Developer/Xcode/DerivedData"/PocketSisyphus-*/Build/Products \
  -maxdepth 2 -type d -name Tor -prune -exec rm -rf {} + 2>/dev/null || true
ok "cleaned"

step "build-for-testing — $SCHEME on device $DEVICE_UDID"
( cd "$IOS_DIR" && xcodebuild build-for-testing \
    -workspace PocketSisyphus.xcworkspace \
    -scheme "$SCHEME" \
    -configuration Debug \
    -destination "$DEST" \
    -allowProvisioningUpdates \
    "${EAGER_OFF[@]}" ) || {
  red "build-for-testing 실패 — 위 로그 확인. (Tor 링크/서명/프로비저닝 확인)"
  exit 1
}

step "test-without-building — $SCHEME on device $DEVICE_UDID"
( cd "$IOS_DIR" && xcodebuild test-without-building \
    -workspace PocketSisyphus.xcworkspace \
    -scheme "$SCHEME" \
    -configuration Debug \
    -destination "$DEST" \
    -allowProvisioningUpdates ) || {
  red "test-without-building 실패 — 위 로그 확인."
  red "흔한 원인: (a) 기기 미페어링 → iPhone 으로 QR 한 번 스캔, (b) 개발자 모드/신뢰 미설정,"
  red "          (c) daemon-기기 연결이 아직 안 닫힘 (Tor 부트스트랩 대기)."
  exit 1
}

ok "✔ 실기기 e2e GREEN — 명령 → daemon PTY 실행 → iOS 터미널 화면 반영까지 라운드트립 확인"
