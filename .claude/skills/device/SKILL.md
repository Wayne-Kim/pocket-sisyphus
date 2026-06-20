---
name: device
description: >-
  WiFi 로 연결된 iPhone 17 Pro Max 실기기에 iOS dev 앱(Debug)을 빌드·설치한다.
  `scripts/dev.sh ios` 를 iPhone 17 Pro Max UDID 로 오버라이드해 재사용한다.
  사용자가 "/device", "17 프로맥스에 설치", "WiFi 기기에 앱 설치", "iPhone 17에 깔아줘"
  등을 요청할 때 사용. (케이블 연결 iPhone 13 mini + Mac 은 `/dev` 를 쓴다.)
---

**English** · [한국어](SKILL.ko.md)

# /device — install the iOS app on the iPhone 17 Pro Max (WiFi)

Builds and installs the iOS dev app in Debug onto the WiFi-connected iPhone 17 Pro Max
physical device. The build/install/Tor self-link retry logic all lives in
`scripts/dev.sh`; this skill just swaps the device UDID to the 17 Pro Max and calls
`dev.sh ios`.

## Running

Pass the iPhone 17 Pro Max's hardware UDID as `PS_DEV_DEVICE_UDID` and run the iOS target
only:

```bash
PS_DEV_DEVICE_UDID=00008150-000E7D4902C0401C ./scripts/dev.sh ios
```

The build can take several minutes, so run it in the foreground with an ample timeout and
pass the output through to the user as-is. When done, summarize install success/failure in
a single line.

## What it does

- `xcodebuild build` (Debug, `platform=iOS,id=00008150-000E7D4902C0401C`) → build. On a Tor
  self-link conflict (`can't link a dylib with itself`), auto-cleans artifacts and retries
  once.
- In-place install via `xcrun devicectl device install app --device <UDID>`
  (preserves container/Keychain → keeps pairing). `devicectl` handles WiFi/cable transfer
  transparently.

## Prerequisites / caveats

- The iPhone 17 Pro Max must be **paired over WiFi** (check "Connect via network" in
  Xcode → Window → Devices & Simulators). It must be on the **same network** as the Mac,
  and **unlocked + Developer Mode ON + trusted**.
- WiFi transfer can be slower than cable (the install step after the build takes longer).
- If the UDID changed or you want to install on a different device: instead of the
  Identifier from `xcrun devicectl list devices`, pass the **hardware UDID**
  (`0000...` format) from `xcrun xctrace list devices` as `PS_DEV_DEVICE_UDID` —
  `xcodebuild -destination` only accepts the hardware UDID.
- If you changed `project.yml`, add `PS_DEV_REGEN=1` too: `PS_DEV_REGEN=1 PS_DEV_DEVICE_UDID=… ./scripts/dev.sh ios`.

## On failure

`dev.sh` prints the last 40 lines of the build log. Common causes specific to WiFi
install:
- Device not visible on the network (check it's on the same WiFi and "Connect via network"
  is on) → the script emits a "not in the connection list" warning and still hands it off
  to xcodebuild to try anyway.
- Locked / untrusted / Developer Mode off, provisioning.
Pass it through to the user as-is, and let them know if a code change is needed.
