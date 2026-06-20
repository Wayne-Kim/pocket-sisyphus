---
name: dev
description: >-
  dev 빌드 + 설치. iOS dev 앱은 케이블 연결된 실기기(iPhone 13 mini)에 Debug 빌드로
  설치하고, Mac dev 앱은 Debug 로 빌드 후 실행 중 인스턴스를 교체(재실행)한다.
  사용자가 "/dev", "dev 빌드 설치", "앱 설치해줘(개발용)" 등을 요청할 때 사용.
  인자로 ios / mac 을 주면 해당 플랫폼만, 없으면 둘 다.
---

**English** · [한국어](SKILL.ko.md)

# /dev — Build + install the dev apps

Builds and installs the iOS (physical device) + Mac dev builds in one go. All the logic lives in
`scripts/dev.sh` — this skill runs it and reports the result.

## Run

If `$ARGUMENTS` contains `ios` or `mac`, pass that argument through; if not, run with no argument
(= both):

```bash
./scripts/dev.sh            # no argument → iOS (physical device) + Mac
./scripts/dev.sh ios        # iOS physical device only
./scripts/dev.sh mac        # Mac only
```

The build can take several minutes, so run it in the foreground with a generous timeout and relay the output
directly to the user. When it finishes, summarize each platform's install success/failure in one line.

## Behavior summary

- **iOS dev** → after `xcodebuild build` (Debug, `platform=iOS,id=<iPhone 13 mini UDID>`),
  installs in-place onto the physical device with `xcrun devicectl device install app` (container/Keychain
  preserved → pairing kept). On a Tor self-link collision, auto-cleans artifacts and retries once.
- **Mac dev** → after `xcodebuild build` (Debug, macOS, including daemon/tor nested signing),
  terminates the running `PocketSisyphusMac` and `open`s the new build.

## Prerequisites / cautions

- iOS: the iPhone 13 mini must be cable-connected + unlocked + have developer mode / trust set up.
  For a different device, use `PS_DEV_DEVICE_UDID=<udid>`.
- Mac: during install (re-launch), the running Mac app is briefly terminated → the daemon it launched
  is also restarted, so a connected phone briefly disconnects and reconnects.
- If you changed `project.yml`, also regenerate via xcodegen with `PS_DEV_REGEN=1 ./scripts/dev.sh`.

## On failure

The script prints the last 40 lines of the build log. Common causes:
- iOS: device not connected/not trusted, developer mode off, provisioning.
- Mac: missing signing identity (nested-binary signing step).
Relay it as is to the user, and flag if a code fix is needed.
