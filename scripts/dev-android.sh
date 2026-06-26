#!/usr/bin/env bash
#
# /dev-android — Android dev 빌드 + 설치 + 실행.
#   • 대상 기기를 고른다: 연결된 실기기/에뮬레이터가 있으면 그걸 쓰고, 없으면 AVD 를 부팅한다.
#   • ./gradlew :app:installDebug 로 Debug APK 를 빌드·설치한다(멱등 — 기존 데이터 보존).
#   • adb shell am start 로 런처 액티비티를 띄운다.
#
# 사용:
#   ./scripts/dev-android.sh              # 기기 자동 선택(없으면 첫 AVD 부팅) → 빌드·설치·실행
#   ./scripts/dev-android.sh emulator     # 연결된 실기기가 있어도 무조건 AVD 부팅해서 사용
#   ./scripts/dev-android.sh <serial>     # 특정 기기(adb serial)에 설치 — 예: emulator-5554 / R3CN30…
#
# env:
#   PS_ANDROID_SERIAL=<serial>   대상 기기 serial 고정(인자보다 우선)
#   PS_ANDROID_AVD=<name>        부팅할 AVD 이름(기본: `emulator -list-avds` 첫 줄)
#   PS_ANDROID_TASK=installDebug Gradle 태스크(기본 installDebug — installRelease 등으로 교체 가능)
#   PS_ANDROID_NO_LAUNCH=1       설치 후 am start(앱 실행)를 건너뜀
#   PS_ANDROID_NO_DEV_PAIR=1     개발 페어링(직결) 자동 주입을 끔(QR 수동 스캔/실 SSH 플로우 테스트용)
#   PS_ANDROID_DEV_HOST=<host>   직결 호스트 오버라이드(기본: 에뮬레이터=10.0.2.2). 실기기 주입 시 명시.
#   POCKET_CLAUDE_CONFIG_DIR     daemon config 디렉토리 오버라이드(미설정 시 dev → 공유 순으로 탐색)
#   ANDROID_HOME / sdk.dir       SDK 경로(미설정 시 android/local.properties → ~/Library/Android/sdk 순)
#
# 개발 페어링 직결 주입 (DevBootstrap 와 짝, iOS verify-ios.sh 와 동형):
#   에뮬레이터는 카메라 QR 스캔이 어렵다 → installDebug + 에뮬레이터 대상이면, Mac daemon 의
#   config.json(token·localAdminSecret·port)을 launch 인텐트 익스트라로 넘겨 QR/SSH/Tor 없이
#   10.0.2.2:<port> daemon 에 «직결»한다(HTTP 는 X-PS-Local, WS 는 ?local= 로 attest 게이트 통과).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
ANDROID_DIR="$ROOT/android"
APP_ID="com.pocketsisyphus.android"
LAUNCH_ACTIVITY="$APP_ID/.MainActivity"
TASK="${PS_ANDROID_TASK:-installDebug}"

step() { printf "\n\033[1;36m▸ %s\033[0m\n" "$*"; }
ok()   { printf "\033[32m%s\033[0m\n" "$*"; }
red()  { printf "\033[31m%s\033[0m\n" "$*" >&2; }

# ── SDK 경로 결정 ──────────────────────────────────────────────────────────
# 우선순위: ANDROID_HOME(/ANDROID_SDK_ROOT) → android/local.properties 의 sdk.dir → 기본 경로.
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
if [ -z "$SDK" ] && [ -f "$ANDROID_DIR/local.properties" ]; then
  # sdk.dir=/path 형태. 값에 '=' 가 또 들어갈 일은 없지만, 첫 '=' 뒤만 취한다.
  SDK="$(sed -n 's/^sdk\.dir=//p' "$ANDROID_DIR/local.properties" | head -1)"
fi
[ -z "$SDK" ] && SDK="$HOME/Library/Android/sdk"
if [ ! -d "$SDK" ]; then
  red "Android SDK 를 찾을 수 없음: $SDK"
  red "ANDROID_HOME 을 설정하거나 android/local.properties 의 sdk.dir 를 확인하세요."
  exit 1
fi
export ANDROID_HOME="$SDK"
export ANDROID_SDK_ROOT="$SDK"

ADB="$SDK/platform-tools/adb"
EMULATOR="$SDK/emulator/emulator"
[ -x "$ADB" ] || ADB="$(command -v adb || true)"
if [ -z "$ADB" ] || [ ! -x "$ADB" ]; then
  red "adb 를 찾을 수 없음($SDK/platform-tools/adb). SDK platform-tools 설치를 확인하세요."
  exit 1
fi
# /usr/sbin:/sbin 포함 — 일부 환경 점검 도구가 거기 산다.
export PATH="$SDK/platform-tools:$SDK/emulator:/opt/homebrew/bin:/usr/local/bin:/usr/sbin:/sbin:$PATH"

# ── 연결된 기기 목록(state=device 인 것만) ─────────────────────────────────
connected_serials() {
  # 헤더("List of devices attached")와 빈 줄을 빼고, 상태가 'device' 인 serial 만.
  "$ADB" devices 2>/dev/null | awk 'NR>1 && $2=="device" {print $1}'
}

wait_boot() {
  # $1 = serial. wait-for-device 후 sys.boot_completed=1 까지 폴링(최대 ~180s).
  local serial="$1"
  step "wait boot ($serial)"
  "$ADB" -s "$serial" wait-for-device
  local i=0
  while [ "$i" -lt 180 ]; do
    if [ "$("$ADB" -s "$serial" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; then
      ok "부팅 완료: $serial"
      return 0
    fi
    sleep 2
    i=$((i + 2))
  done
  red "부팅 대기 시간 초과($serial) — 그래도 설치를 시도합니다."
  return 0
}

boot_emulator() {
  # PS_ANDROID_AVD(없으면 첫 AVD)를 백그라운드로 부팅하고, 새로 뜬 emulator serial 을 반환(stdout).
  local avd="${PS_ANDROID_AVD:-}"
  if [ -z "$avd" ]; then
    [ -x "$EMULATOR" ] || { red "emulator 실행기를 찾을 수 없음: $EMULATOR"; exit 1; }
    avd="$("$EMULATOR" -list-avds 2>/dev/null | head -1)"
  fi
  if [ -z "$avd" ]; then
    red "부팅할 AVD 가 없음. Android Studio 에서 가상 기기를 하나 만들거나 PS_ANDROID_AVD 를 지정하세요."
    exit 1
  fi
  step "boot emulator ($avd)" >&2
  # 스크립트가 끝나도 살아있도록 분리해서 띄운다.
  ( nohup "$EMULATOR" -avd "$avd" -no-snapshot-save >/dev/null 2>&1 & ) || true
  # 새 기기가 adb 에 붙을 때까지 대기.
  local i=0 serial=""
  while [ "$i" -lt 120 ]; do
    serial="$(connected_serials | grep '^emulator-' | head -1 || true)"
    [ -n "$serial" ] && break
    sleep 2
    i=$((i + 2))
  done
  if [ -z "$serial" ]; then
    red "에뮬레이터가 adb 에 나타나지 않음 — '$ADB devices' 로 상태를 확인하세요."
    exit 1
  fi
  wait_boot "$serial" >&2
  printf '%s' "$serial"
}

# ── 대상 기기 선택 ─────────────────────────────────────────────────────────
ARG="${1:-}"
TARGET="${PS_ANDROID_SERIAL:-}"

if [ "$ARG" = "emulator" ]; then
  # 이미 떠 있는 에뮬레이터가 있으면 재사용, 없으면 부팅.
  TARGET="$(connected_serials | grep '^emulator-' | head -1 || true)"
  [ -z "$TARGET" ] && TARGET="$(boot_emulator)"
elif [ -z "$TARGET" ] && [ -n "$ARG" ]; then
  # 인자가 serial 로 보이면 그걸 대상으로.
  TARGET="$ARG"
fi

if [ -n "$TARGET" ]; then
  # 지정 기기가 아직 안 붙어 있으면(부팅 직후 등) 잠깐 기다린다.
  if ! connected_serials | grep -qx "$TARGET"; then
    step "wait for $TARGET"
    "$ADB" -s "$TARGET" wait-for-device || true
  fi
else
  # 자동 선택: 연결된 기기가 있으면 첫 번째, 없으면 에뮬레이터 부팅.
  TARGET="$(connected_serials | head -1 || true)"
  if [ -z "$TARGET" ]; then
    red "연결된 기기/에뮬레이터 없음 — AVD 를 부팅합니다."
    TARGET="$(boot_emulator)"
  fi
fi

ok "대상 기기: $TARGET"
# Gradle install 태스크와 adb 가 같은 기기를 고르도록 serial 을 고정.
export ANDROID_SERIAL="$TARGET"

# ── 빌드·설치 ──────────────────────────────────────────────────────────────
step "gradle :app:$TASK ($TARGET)"
# foreground 실행 — 빌드는 수 분 걸릴 수 있다. 실패 시 set -e 로 즉시 중단.
( cd "$ANDROID_DIR" && ./gradlew ":app:$TASK" )
ok "설치 완료: $APP_ID → $TARGET"

# ── 개발 페어링(직결) 주입 준비 ──────────────────────────────────────────────
# 성공 시 DEV_PAIR_EXTRAS 에 `am start` 익스트라(--es devDaemonToken … 등)를 채운다.
DEV_PAIR_EXTRAS=()
prepare_dev_pairing() {
  [ "${PS_ANDROID_NO_DEV_PAIR:-0}" = "1" ] && return 0
  # Debug 빌드일 때만 — release 는 인텐트 익스트라(DevBootstrap)를 읽지 않는다.
  case "$TASK" in installDebug|assembleDebug) ;; *) return 0 ;; esac
  # 직결 호스트: 명시 오버라이드 우선, 없으면 에뮬레이터 대상에서만 10.0.2.2(=Mac loopback).
  local dev_host="${PS_ANDROID_DEV_HOST:-}"
  if [ -z "$dev_host" ]; then
    case "$TARGET" in emulator-*) dev_host="10.0.2.2" ;; *) return 0 ;; esac
  fi
  command -v python3 >/dev/null 2>&1 || { red "python3 없음 — 개발 페어링 주입 생략(수동 QR 필요)."; return 0; }

  # config 디렉토리 탐색: 명시 → 격리 dev → 공유. config.json 이 있고 daemon 이 응답하는 첫 항목.
  local dirs=()
  [ -n "${POCKET_CLAUDE_CONFIG_DIR:-}" ] && dirs+=("$POCKET_CLAUDE_CONFIG_DIR")
  dirs+=("$HOME/Library/Application Support/PocketSisyphus-dev")
  dirs+=("$HOME/Library/Application Support/PocketSisyphus")

  local d cfg tok sec port
  for d in "${dirs[@]}"; do
    cfg="$d/config.json"
    [ -f "$cfg" ] || continue
    read -r tok sec port < <(python3 - "$cfg" <<'PY'
import json, sys
try:
    c = json.load(open(sys.argv[1]))
    print(c.get("token", "") or "-", c.get("localAdminSecret", "") or "-", c.get("port", 7777))
except Exception:
    pass
PY
)
    [ -n "${tok:-}" ] && [ "$tok" != "-" ] || continue
    # daemon 이 실제로 떠 있는지 확인(127.0.0.1 = Mac loopback; 에뮬레이터는 10.0.2.2 로 닿는다).
    if curl -fsS -m 3 "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then
      DEV_PAIR_EXTRAS=(--es devDaemonToken "$tok" --ei devDaemonPort "$port" --es devHost "$dev_host")
      [ "$sec" != "-" ] && [ -n "$sec" ] && DEV_PAIR_EXTRAS+=(--es devLocalSecret "$sec")
      ok "개발 페어링 직결 주입: ${dev_host}:${port} (config: $d)"
      return 0
    fi
  done
  red "Mac daemon 미발견/미응답 — 개발 페어링 주입 생략(Mac 앱 실행 후 재시도하거나 QR 수동 스캔)."
}

# ── 실행 ───────────────────────────────────────────────────────────────────
if [ "${PS_ANDROID_NO_LAUNCH:-0}" = "1" ]; then
  ok "PS_ANDROID_NO_LAUNCH=1 — 앱 실행은 건너뜀."
else
  prepare_dev_pairing
  step "launch $LAUNCH_ACTIVITY"
  if [ "${#DEV_PAIR_EXTRAS[@]}" -gt 0 ]; then
    # 인텐트 익스트라는 onCreate 에서만 읽으므로, 콜드 스타트가 되도록 먼저 강제 종료.
    "$ADB" -s "$TARGET" shell am force-stop "$APP_ID" >/dev/null 2>&1 || true
  fi
  "$ADB" -s "$TARGET" shell am start -n "$LAUNCH_ACTIVITY" \
    ${DEV_PAIR_EXTRAS[@]+"${DEV_PAIR_EXTRAS[@]}"} >/dev/null
  ok "앱 실행: $LAUNCH_ACTIVITY"
fi
