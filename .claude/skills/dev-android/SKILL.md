---
name: dev-android
description: >-
  Android dev 빌드 + 설치 + 실행. 연결된 실기기/에뮬레이터를 골라(없으면 AVD 부팅)
  ./gradlew :app:installDebug 로 Debug APK 를 설치하고 am start 로 앱을 띄운다.
  사용자가 "/dev-android", "안드로이드 앱 설치", "에뮬레이터에 깔아줘", "안드 dev 빌드",
  "gradle 설치" 등을 요청할 때 사용. 인자로 emulator(무조건 에뮬) 또는 adb serial 을 줄 수 있다.
---

**English** · [한국어](SKILL.ko.md)

# /dev-android — Build + install + launch the Android dev app

Builds and installs the Android Debug APK onto a connected device/emulator (booting an AVD if none is
connected), then launches the app. All the logic lives in `scripts/dev-android.sh` — this skill runs it
and reports the result.

## Run

If `$ARGUMENTS` contains `emulator` or an adb serial, pass it through; otherwise run with no argument
(= auto-select the target device):

```bash
./scripts/dev-android.sh             # auto: use a connected device, else boot the first AVD
./scripts/dev-android.sh emulator    # always use an emulator (reuse a running one, else boot an AVD)
./scripts/dev-android.sh <serial>    # install on a specific device (e.g. emulator-5554, R3CN30…)
```

The Gradle build can take several minutes (especially the first run / after a clean), so run it in the
foreground with a generous timeout and relay the output directly to the user. When it finishes, summarize
the target device + install/launch success in one line.

## Behavior summary

1. **Resolve SDK** — `ANDROID_HOME` → `android/local.properties` (`sdk.dir`) → `~/Library/Android/sdk`.
   Exports `ANDROID_HOME`/`ANDROID_SDK_ROOT` and puts `platform-tools`/`emulator` on `PATH`.
2. **Pick the target** — a connected `device`-state serial is preferred; with `emulator` (or none
   connected) it reuses a running emulator or boots one (`PS_ANDROID_AVD`, else the first
   `emulator -list-avds`) and waits for `sys.boot_completed`.
3. **Build + install** — `cd android && ./gradlew :app:installDebug` with `ANDROID_SERIAL` pinned to the
   target (so Gradle installs to the right device). In-place install → existing app data/pairing kept.
4. **Inject dev pairing** (auto) — for a Debug build on an **emulator** target, the script finds the Mac
   daemon's `config.json` and passes `token`/`localAdminSecret`/`port` as launch-intent extras (see below).
   Skipped with `PS_ANDROID_NO_DEV_PAIR=1`, or when no reachable daemon is found.
5. **Launch** — `adb shell am start -n com.pocketsisyphus.android/.MainActivity` (skip with
   `PS_ANDROID_NO_LAUNCH=1`).

## Pairing on the emulator (debug-only `DevBootstrap`)

A fresh emulator install has no paired daemon, and scanning a QR with the emulator camera is awkward — so,
exactly like the iOS simulator (`/verify-ios`), the debug build reads one-shot launch-intent extras to
bypass QR pairing (no effect in release builds). `DevBootstrap` supports two modes:

**1. Direct daemon (default, the iOS-simulator equivalent).** No QR / SSH / Tor — talk straight to the host
Mac's daemon over the emulator loopback alias, using just three values from the Mac's `config.json`. The
attest gate is bypassed with the `X-PS-Local` header (HTTP) / `?local=` query (WS), the same path the Mac
app uses. **`scripts/dev-android.sh` fills this in automatically** for an emulator + Debug build; the
manual form is:

```bash
adb shell am start -n com.pocketsisyphus.android/.MainActivity \
    --es devDaemonToken "<config.json token>" \
    --es devLocalSecret "<config.json localAdminSecret>" \
    --ei devDaemonPort 7777 \
    --es devHost 10.0.2.2     # 10.0.2.2 = the host Mac's loopback from inside the emulator
```

**2. Full payload (real SSH/Tor flow).** Inject a complete QR pairing JSON and run the normal pairing flow:

```bash
adb shell am start -n com.pocketsisyphus.android/.MainActivity \
    --es devPairingB64 "<base64 of the pairing-payload JSON>" \
    --es devHost 10.0.2.2
```

`--ez devForceLock true` forces the app-entry lock screen on for visual verification (no paired daemon
needed).

## Prerequisites / cautions

- **JDK 17** + the **Android SDK** (platform 36, build-tools 36). `local.properties` (`sdk.dir=…`) is not
  checked in — point Gradle at your SDK there or via `ANDROID_HOME`.
- From inside the emulator the host Mac is **`10.0.2.2`**, not `127.0.0.1` / `localhost` — so a daemon on
  the Mac's loopback must be reached via `10.0.2.2` (that's what `devHost` defaults to). The alias maps to
  the host loopback, so even a loopback-only daemon is reachable; the **Mac app must be running** for the
  direct dev pairing to connect.
- The daemon `config.json` is auto-discovered in this order: `POCKET_CLAUDE_CONFIG_DIR` →
  `~/Library/Application Support/PocketSisyphus-dev` (isolated dev) → `~/Library/Application Support/PocketSisyphus`
  (shared). The first one whose daemon answers `/health` wins.
- A physical device must be **USB-debugging-enabled + authorized** (accept the RSA prompt). Check it shows
  up under `adb devices` as `device` (not `unauthorized` / `offline`). Direct dev pairing is **emulator-only**
  by default (10.0.2.2); for a physical device set `PS_ANDROID_DEV_HOST=<mac-lan-ip>` (daemon must listen on the LAN).
- Other Gradle tasks: `PS_ANDROID_TASK=installRelease ./scripts/dev-android.sh` (or any `:app:` task).

## On failure

`set -euo pipefail` makes the script fail fast; Gradle prints its own error/stacktrace. Common causes:
- No device + no AVD to boot → create a virtual device in Android Studio or set `PS_ANDROID_AVD`.
- `unauthorized` / `offline` device → re-accept the USB-debugging prompt, or `adb kill-server && adb start-server`.
- SDK not found → set `ANDROID_HOME` or fix `android/local.properties`'s `sdk.dir`.
Relay the output as is, and flag if a code fix is needed.
