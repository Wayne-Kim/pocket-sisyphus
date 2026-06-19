#!/usr/bin/env bash
# 자율 UX iterate 헬퍼.
#
# 1) Debug 빌드 (iPhone 17 Pro Max)
# 2) devicectl 재설치 (앱 데이터/페어링 보존)
# 3) 앱 launch
# 4) 1.5s 대기 후 iPhone Mirroring 창을 screencapture
#
# 사전 조건 (사용자 1회):
#   - macOS iPhone Mirroring 켜고 PocketSisyphus 화면 띄워두기
#   - dev profile 발급 (Xcode 한 번 Run 또는 -allowProvisioningUpdates 첫 빌드)
#
# 사용법:  scripts/ios-iterate.sh [out.png]

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IOS_DIR="$ROOT/ios"
SCHEME="PocketSisyphus"
WORKSPACE="$IOS_DIR/PocketSisyphus.xcworkspace"
DERIVED="$ROOT/build/ios-device"
BUNDLE_ID="pe.wayne.pocketsisyphus"
DEVICE_ID="540EA3BD-5AE3-5083-86B5-23D912ED8B93"   # iPhone 17 Pro Max (devicectl)
UDID="00008150-000E7D4902C0401C"                    # xcodebuild destination id

OUT="${1:-/tmp/pocket-sisyphus-iter-$(date +%s).png}"

red()    { printf "\033[31m%s\033[0m\n" "$*" >&2; }
green()  { printf "\033[32m%s\033[0m\n" "$*"; }
step()   { printf "\n\033[1;36m▸ %s\033[0m\n" "$*"; }

step "Debug 빌드 (incremental, quiet)"
mkdir -p "$DERIVED"
xcodebuild \
  -workspace "$WORKSPACE" \
  -scheme "$SCHEME" \
  -configuration Debug \
  -destination "platform=iOS,id=${UDID}" \
  -derivedDataPath "$DERIVED" \
  -allowProvisioningUpdates \
  -quiet \
  build 2> "$DERIVED/build.err" > "$DERIVED/build.log" || {
    red "빌드 실패. 마지막 로그:"
    tail -50 "$DERIVED/build.log" "$DERIVED/build.err" >&2
    exit 1
  }
APP="$DERIVED/Build/Products/Debug-iphoneos/PocketSisyphus.app"
[ -d "$APP" ] || { red ".app 산출물 없음: $APP"; exit 1; }

step "재설치 + launch"
xcrun devicectl device install app --device "$DEVICE_ID" "$APP" >/dev/null
xcrun devicectl device process launch --device "$DEVICE_ID" "$BUNDLE_ID" >/dev/null

# PocketTunnel NetworkExtension 이 install 마다 재시작될 수 있어 Tor 회로 빌드 8-15s 필요할 수도.
# 12s 기본. 더 빠른 cycle 원하면 ITER_WAIT_SECS 줄여서 호출.
WAIT_SECS="${ITER_WAIT_SECS:-12}"
step "${WAIT_SECS}s 대기"
sleep "$WAIT_SECS"

step "iPhone Mirroring window id 검출"
WINDOW_ID=$(swift - <<'SWIFT'
import Cocoa
let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
guard let ws = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else { exit(1) }
var best: (id: Int, area: Int)? = nil
for w in ws {
    let n = w["kCGWindowOwnerName"] as? String ?? ""
    guard n.contains("iPhone Mirroring") || n.contains("iPhone") else { continue }
    let layer = w["kCGWindowLayer"] as? Int ?? 0
    guard layer == 0 else { continue }   // normal layer 만
    guard let id = w["kCGWindowNumber"] as? Int else { continue }
    let b = w["kCGWindowBounds"] as? [String: CGFloat] ?? [:]
    let area = Int((b["Width"] ?? 0) * (b["Height"] ?? 0))
    if area < 100_000 { continue }       // 작은 trayicon/system window 컷
    if best == nil || area > best!.area { best = (id, area) }
}
if let b = best { print(b.id) } else { exit(2) }
SWIFT
) || {
    red "iPhone Mirroring 창을 못 찾았다. macOS 의 iPhone Mirroring 앱이 열려 있어야 한다."
    exit 1
}
green "  → window id $WINDOW_ID"

step "스크린샷"
screencapture -x -l"$WINDOW_ID" "$OUT"
green "  → $OUT"
echo "$OUT"
