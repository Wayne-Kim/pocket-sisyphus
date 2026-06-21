#!/usr/bin/env bash
#
# /dev-mac — 실행 중인 PocketSisyphusMac 을 «완전히» 종료하고 Debug dev 빌드를 재실행한다.
#
#   • /dev mac 은 `pkill -x PocketSisyphusMac` 로 GUI 프로세스만 죽인다 → 앱이 띄운
#     daemon(node)/tor/sshd 자식이 orphan 으로 살아남는다. daemon 코드를 바꾼 뒤 검증하면
#     «옛 daemon» 이 그대로 서빙해 새 코드가 안 도는 것처럼 보인다 (실제로 과거 dev 실행이
#     남긴 orphan 들이 ps 에 쌓여 있는 게 확인됨).
#   • 이 스크립트는 번들 경로(PocketSisyphusMac.app/Contents)로 묶인 모든 프로세스 —
#     GUI 앱 + daemon/tor/sshd 자식 + DerivedData dev orphan — 를 전부 정리해 새 빌드의
#     daemon 만 남게 한다.
#
# 사용:
#   ./scripts/dev-mac.sh
#
# env:
#   PS_DEV_REGEN=1   # 빌드 전 xcodegen generate (project.yml 변경 후)
#   PS_DEV_FORCE=1   # 프리플라이트(Release 공존/진행 중 세션/연결된 폰) 경고를 무시하고 무확인 진행.
#                    #   비대화형(CI/agent)에서 위험이 감지되면 이 값이 없는 한 중단한다.
#
# 프리플라이트: 빌드 직후·kill 직전에 (a) Release 인스턴스 공존 (b) 진행 중 세션(살아있는 PTY/턴)
#   (c) 연결된 폰 을 점검한다. 위험이 있으면 대화형에선 재확인을, 비대화형에선 PS_DEV_FORCE=1 을
#   요구한다. 위험이 없으면 종전대로 묻지 않고 통과한다.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
MAC_DIR="$ROOT/mac"
DD="$HOME/Library/Developer/Xcode/DerivedData"

export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"

step() { printf "\n\033[1;36m▸ %s\033[0m\n" "$*"; }
ok()   { printf "\033[32m%s\033[0m\n" "$*"; }
red()  { printf "\033[31m%s\033[0m\n" "$*" >&2; }

# dev(Debug) 빌드 산출물 경로로 묶인 프로세스 전부를 잡는 패턴 — GUI 앱
# (…/Build/Products/Debug/<App>.app/Contents/MacOS/<App>) + 자식 daemon(node)/tor/sshd
# (…/Debug/<App>.app/Contents/Resources/daemon/bin/…) 가 모두 이 경로를 cmdline 에 포함한다.
# Dev 앱 이름이 "Pocket Sisyphus Dev.app" 로 바뀌어도(이름 무관 [^/]*) 잡히고, /Applications 의
# Release 는 «Build/Products/Debug/» 가 cmdline 에 없어 안 잡힌다(이전엔 같은 .app 이름이라
# Release 까지 잡혔는데 이젠 dev 만 정확히 잡는다).
#
# 빌드 자신(xcodebuild)과는 안 겹친다 — 그쪽 cmdline 엔 '.app/Contents' 가 없어서.
KILL_PAT='Build/Products/Debug/[^/]*\.app/Contents'

# 번들 프로세스 전부 종료: SIGTERM 으로 한 번 (daemon node 가 자기 tor/sshd 자식을 정리할
# 기회를 줌) → 남으면 SIGKILL. 앱이 daemon 을 다시 띄우는 race 까지 흡수하려고 몇 번
# 재확인한다. 전부 사라지면 즉시 반환.
kill_all() {
  pkill -f "$KILL_PAT" 2>/dev/null || true
  for _ in 1 2 3 4 5; do
    sleep 0.6
    pgrep -f "$KILL_PAT" >/dev/null 2>&1 || return 0
    pkill -9 -f "$KILL_PAT" 2>/dev/null || true
  done
}

# ── 1. Debug 빌드 — 앱은 빌드 동안 옛 코드로 계속 떠 있어 downtime 최소화 ─────────────
if [ "${PS_DEV_REGEN:-0}" = "1" ]; then
  step "xcodegen generate (mac)"
  ( cd "$MAC_DIR" && xcodegen generate )
fi

LOG="/tmp/ps-dev-mac-build.log"
step "build (Debug, macOS — daemon/tor nested 서명 포함, 시간 좀 걸림)"
if ! ( cd "$MAC_DIR" && xcodebuild build \
        -project PocketSisyphusMac.xcodeproj \
        -scheme PocketSisyphusMac \
        -configuration Debug \
        -destination 'platform=macOS' \
        -allowProvisioningUpdates ) > "$LOG" 2>&1; then
  red "Mac 빌드 실패. 마지막 40줄:"; tail -40 "$LOG" >&2; exit 1
fi
ok "build succeeded"

# 방금 빌드가 «실제로 쓴» 산출물 경로를 빌드 로그의 TARGET_BUILD_DIR/WRAPPER_NAME 에서
# 읽는다. (예전의 `ls -dt` 글로브는 DerivedData 가 두 개일 때 — 프로젝트 재생성 등으로
# 해시가 바뀐 경우 — 실행할 때마다 mtime 이 갱신되는 «옛» .app 을 계속 골라, 새로 빌드한
# 코드가 영영 실행되지 않는 자기강화 버그가 있었다.)
TBD="$(grep -m1 'export TARGET_BUILD_DIR' "$LOG" | sed 's/^.*TARGET_BUILD_DIR\\\?=//' | sed 's/\\//g')"
WRAP="$(grep -m1 'export WRAPPER_NAME' "$LOG" | sed 's/^.*WRAPPER_NAME\\\?=//' | sed 's/\\//g')"
APP="$TBD/$WRAP"
if [ -z "$TBD" ] || [ ! -d "$APP" ]; then
  # no-op 빌드라 로그에 export 가 없을 수 있음 — showBuildSettings 로 폴백 (느리지만 정확).
  APP="$(cd "$MAC_DIR" && xcodebuild -project PocketSisyphusMac.xcodeproj \
          -scheme PocketSisyphusMac -configuration Debug -destination 'platform=macOS' \
          -showBuildSettings 2>/dev/null \
        | awk -F' = ' '/ TARGET_BUILD_DIR =/{t=$2} / WRAPPER_NAME =/{w=$2} END{print t "/" w}')"
fi
if [ -z "$APP" ] || [ ! -d "$APP" ]; then
  red "빌드된 Mac .app 을 못 찾음: $APP"; exit 1
fi

# ── 1.5 프리플라이트 — kill 직전 안전 점검 ───────────────────────────────────────────
# build→kill→open 으로 직진하면 두 사고가 난다:
#   (1) Release 앱(/Applications 또는 Xcode Release 빌드)이 떠 있으면 dev daemon 과 «두 daemon»
#       이 같은 configDir·포트 7777·onion 을 다퉈 폰이 어느 쪽에도 못 붙는다 — 한쪽만 떠야 한다.
#   (2) 진행 중이던 agent 세션을 SIGTERM→SIGKILL 로 «턴 도중» 날린다.
# 그래서 kill 직전에 (a) Release 공존 (b) 진행 중 세션 (c) 연결된 폰 을 점검한다. 위험이 있으면
# 대화형에선 재확인을 받고, 비대화형(CI/agent)에선 PS_DEV_FORCE=1 오버라이드 없이는 중단한다.
# 평상시(Release 미실행 + 세션 없음 + 폰 미연결)엔 아무것도 묻지 않고 종전대로 무중단 통과한다.
step "프리플라이트 점검 (Release 공존 / 진행 중 세션 / 연결된 폰)"

FORCE="${PS_DEV_FORCE:-0}"
WARN=()  # 누적된 위험 메시지

# (a) Release 인스턴스 — cmdline 에 'Build/Products/Debug/' 가 «없는» PocketSisyphus*.app/Contents
#     프로세스. /Applications 설치본이든 Xcode Release 빌드(…/Release/…)든 Debug 산출물 경로가
#     없어 잡히고, 곧 우리가 정리할 dev(Debug) 빌드는 그 경로를 포함해 제외된다.
RELEASE_COUNT=0
while IFS= read -r pid; do
  [ -n "$pid" ] || continue
  cmd="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  case "$cmd" in
    *Build/Products/Debug/*) ;;                    # dev(Debug) 빌드 — 건너뜀
    *) RELEASE_COUNT=$((RELEASE_COUNT + 1)) ;;      # Debug 산출물 아님 → Release 공존
  esac
done < <(pgrep -f 'PocketSisyphus[^/]*\.app/Contents' 2>/dev/null || true)
if [ "$RELEASE_COUNT" != "0" ]; then
  WARN+=("Release 인스턴스가 실행 중 (${RELEASE_COUNT}개 프로세스) — dev 와 Release 가 같은 configDir·포트 7777·onion 을 다퉈 폰이 어느 쪽에도 못 붙습니다. «한쪽만 실행» 을 권장합니다.")
fi

# boundDaemonPort + localAdminSecret 확보 — daemon-runtime.json(실바인딩 포트)을 우선,
# 없으면 config.json 의 선호 포트, 그래도 없으면 7777. 로컬 운영자는 X-PS-Local 로 attest 우회.
CONFIG_DIR="$HOME/Library/Application Support/PocketSisyphus"
DPORT=7777
LOCAL_SECRET=""
if [ -f "$CONFIG_DIR/config.json" ]; then
  read -r DPORT LOCAL_SECRET < <(python3 - "$CONFIG_DIR/daemon-runtime.json" "$CONFIG_DIR/config.json" <<'PY' || true
import json, sys
rt_path, cfg_path = sys.argv[1], sys.argv[2]
try:
    cfg = json.load(open(cfg_path))
except Exception:
    cfg = {}
port = 0
try:
    port = int(json.load(open(rt_path)).get("port") or 0)
except Exception:
    port = 0
if not port:
    try:
        port = int(cfg.get("port") or 7777)
    except Exception:
        port = 7777
print(port, cfg.get("localAdminSecret", ""))
PY
)
  [ -n "${DPORT:-}" ] || DPORT=7777
fi

# (b)(c) 떠 있는 daemon 을 boundDaemonPort 로 조회. /health 로 connectedClients, /api/sessions
#        (X-PS-Local) 로 살아있는 PTY/턴 수를 센다. daemon 미응답이면 조용히 건너뛴다(평상시).
LIVE=0; RUNNING=0; WAITING=0; CLIENTS=0
HEALTH_JSON="$(curl -fsS -m 3 "http://127.0.0.1:${DPORT}/health" 2>/dev/null || true)"
if [ -n "$HEALTH_JSON" ]; then
  CLIENTS="$(printf '%s' "$HEALTH_JSON" | jq -r '.connectedClients // 0' 2>/dev/null || echo 0)"
  if [ -n "$LOCAL_SECRET" ]; then
    SESSIONS_JSON="$(curl -fsS -m 4 -H "X-PS-Local: $LOCAL_SECRET" \
                      "http://127.0.0.1:${DPORT}/api/sessions?limit=100" 2>/dev/null || true)"
    if [ -n "$SESSIONS_JSON" ]; then
      # last_activity != null ⟺ 메모리에 살아있는 PTY(=kill 대상). idle_ms 가 작으면 턴이
      # 실행 중(출력 생산 중), waiting_since != null 이면 입력 대기에서 멈춤.
      read -r LIVE RUNNING WAITING < <(printf '%s' "$SESSIONS_JSON" | jq -r '
        ([.sessions[]? | select(.last_activity != null)]) as $live
        | [ ($live | length),
            ($live | map(select((.idle_ms // 999999) < 30000)) | length),
            ([.sessions[]? | select(.waiting_since != null)] | length) ]
        | @tsv' 2>/dev/null || echo "0	0	0")
    fi
  fi
fi
LIVE="${LIVE:-0}"; RUNNING="${RUNNING:-0}"; WAITING="${WAITING:-0}"; CLIENTS="${CLIENTS:-0}"

# (b) 진행 중 세션 — 살아있는 PTY 가 있으면 kill 시 손실 위험.
if [ "$LIVE" != "0" ]; then
  WARN+=("진행 중 세션 ${LIVE}개의 PTY 가 살아 있습니다 (실행 중 ${RUNNING}, 입력 대기 ${WAITING}) — kill 하면 SIGTERM→SIGKILL 로 «턴 도중» 세션이 손실될 수 있습니다.")
fi

# (c) 연결된 폰 — 재시작 동안 끊김을 사전 고지.
if [ "$CLIENTS" != "0" ]; then
  WARN+=("연결된 폰/클라이언트 ${CLIENTS}대 — 재시작 동안 끊깁니다 (새 daemon 이 뜨면 폰이 /endpoint 를 다시 받아 자동 재연결).")
fi

if [ "${#WARN[@]}" -eq 0 ]; then
  ok "프리플라이트 통과 — Release 공존·진행 중 세션·연결된 폰 없음"
else
  printf "\n\033[33m⚠ 프리플라이트 경고:\033[0m\n" >&2
  for w in "${WARN[@]}"; do printf "  • %s\n" "$w" >&2; done
  if [ "$FORCE" = "1" ]; then
    red "PS_DEV_FORCE=1 — 경고를 무시하고 계속합니다."
  elif [ -t 0 ]; then
    printf "\n계속 진행할까요? 실행 중 세션이 손실되거나 폰이 끊길 수 있습니다 [y/N] " >&2
    read -r ans || ans=""
    case "$ans" in
      y | Y | yes | YES) red "사용자 확인 — 계속합니다." ;;
      *) red "중단했습니다 — 한쪽만 실행하거나 세션을 마친 뒤 다시 시도하세요 (강제 진행: PS_DEV_FORCE=1)."; exit 1 ;;
    esac
  else
    red "비대화형 실행 — 위험이 감지돼 중단합니다. 무확인 진행은 PS_DEV_FORCE=1 을 지정하세요."
    exit 1
  fi
fi

# ── 2. 완전 종료 — 앱 + daemon/tor/sshd 자식 + 과거 dev orphan ────────────────────────
step "실행 중인 PocketSisyphusMac 완전 종료 (앱 + daemon/tor/sshd 자식 + orphan)"
BEFORE="$(pgrep -f "$KILL_PAT" 2>/dev/null | wc -l | tr -d ' ' || true)"
kill_all
AFTER="$(pgrep -f "$KILL_PAT" 2>/dev/null | wc -l | tr -d ' ' || true)"
ok "종료: ${BEFORE}개 → ${AFTER}개 프로세스"
[ "$AFTER" = "0" ] || red "경고: ${AFTER}개가 아직 남아 있음 (권한/좀비 가능) — 계속 진행"

# ── 3. 새 dev 빌드 실행 ───────────────────────────────────────────────────────────────
step "새 dev 빌드 실행 ($APP)"
open "$APP"
ok "✔ Mac dev 재실행 — 메뉴바 아이콘 + 새 daemon 확인"

step "done"
