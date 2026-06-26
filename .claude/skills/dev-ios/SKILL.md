---
name: dev-ios
description: >-
  iOS dev 빌드 + 설치. 케이블 연결된 실기기(기본 iPhone 13 mini)에 Debug 빌드를 설치한다.
  `/dev` 에서 iOS 만 떼어낸 스킬 (Mac 은 건드리지 않음). 사용자가 "/dev-ios", "아이폰에 설치",
  "iOS dev 빌드", "iOS 앱만 설치해줘", "폰에 깔아줘(iOS)" 등을 요청할 때 사용.
  다른 기기는 PS_DEV_DEVICE_UDID 로 오버라이드.
---

**English** · [한국어](SKILL.ko.md)

# /dev-ios — Build + install the iOS dev app

Builds and installs the iOS Debug build onto the cable-connected physical device (default: iPhone 13 mini).
This is the **iOS-only slice of `/dev`** — all the logic lives in `scripts/dev.sh`; this skill just runs it
with the `ios` argument and reports the result. (For Mac, use `/dev-mac`; for both, use `/dev`.)

## Run

```bash
./scripts/dev.sh ios
```

For a different device, override the hardware UDID:

```bash
PS_DEV_DEVICE_UDID=<udid> ./scripts/dev.sh ios
```

The build can take several minutes, so run it in the foreground with a generous timeout and relay the output
directly to the user. When it finishes, summarize install success/failure in one line.

## Behavior summary

- **iOS dev** → after `xcodebuild build` (Debug, `platform=iOS,id=<iPhone 13 mini UDID>`), installs in-place
  onto the physical device with `xcrun devicectl device install app` (container/Keychain preserved → pairing
  kept). On a Tor self-link collision (`can't link a dylib with itself`), auto-cleans artifacts and retries once.
- **Mac is not touched** — only the iOS target builds/installs.

## Prerequisites / cautions

- The iPhone 13 mini must be cable-connected + unlocked + have developer mode / trust set up. For a different
  device use `PS_DEV_DEVICE_UDID=<udid>` (or `/device` for the WiFi-connected iPhone 17 Pro Max).
- In-place install keeps the existing container → the phone stays paired to the daemon.
- If you changed `project.yml`, also regenerate via xcodegen with `PS_DEV_REGEN=1 ./scripts/dev.sh ios`.

## On failure

The script prints the last 40 lines of the build log. Common causes: device not connected / not trusted,
developer mode off, provisioning/signing. Relay it as is to the user, and flag if a code fix is needed.
