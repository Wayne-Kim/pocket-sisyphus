---
name: dev-android
description: >-
  Android dev 빌드 + 설치 + 실행. 연결된 실기기/에뮬레이터를 골라(없으면 AVD 부팅)
  ./gradlew :app:installDebug 로 Debug APK 를 설치하고 am start 로 앱을 띄운다.
  사용자가 "/dev-android", "안드로이드 앱 설치", "에뮬레이터에 깔아줘", "안드 dev 빌드",
  "gradle 설치" 등을 요청할 때 사용. 인자로 emulator(무조건 에뮬) 또는 adb serial 을 줄 수 있다.
---

[English](SKILL.md) · **한국어**

# /dev-android — Android dev 앱 빌드 + 설치 + 실행

Android Debug APK 를 연결된 기기/에뮬레이터에 빌드·설치하고(없으면 AVD 부팅) 앱을 실행한다.
모든 로직은 `scripts/dev-android.sh` 에 있다 — 이 스킬은 그것을 실행하고 결과를 보고한다.

## 실행

`$ARGUMENTS` 에 `emulator` 또는 adb serial 이 있으면 그대로 넘기고, 없으면 인자 없이
(= 대상 기기 자동 선택) 실행한다:

```bash
./scripts/dev-android.sh             # 자동: 연결된 기기 사용, 없으면 첫 AVD 부팅
./scripts/dev-android.sh emulator    # 무조건 에뮬레이터(떠 있으면 재사용, 없으면 AVD 부팅)
./scripts/dev-android.sh <serial>    # 특정 기기에 설치(예: emulator-5554, R3CN30…)
```

Gradle 빌드는 (특히 첫 실행/클린 후) 수 분 걸릴 수 있으니 충분한 타임아웃으로 foreground
실행하고, 출력을 그대로 사용자에게 전달한다. 끝나면 대상 기기 + 설치/실행 성공을 한 줄로 요약한다.

## 동작 요약

1. **SDK 경로 결정** — `ANDROID_HOME` → `android/local.properties`(`sdk.dir`) → `~/Library/Android/sdk`.
   `ANDROID_HOME`/`ANDROID_SDK_ROOT` 를 export 하고 `platform-tools`/`emulator` 를 `PATH` 에 추가한다.
2. **대상 선택** — `device` 상태인 serial 을 우선 사용. `emulator`(또는 연결 기기가 없을 때)는
   떠 있는 에뮬레이터를 재사용하거나 부팅(`PS_ANDROID_AVD`, 없으면 `emulator -list-avds` 첫 줄)하고
   `sys.boot_completed` 까지 기다린다.
3. **빌드·설치** — `cd android && ./gradlew :app:installDebug`, `ANDROID_SERIAL` 을 대상에 고정해
   Gradle 이 올바른 기기에 설치하도록 한다. in-place 설치 → 기존 앱 데이터/페어링 보존.
4. **개발 페어링 주입**(자동) — Debug 빌드 + **에뮬레이터** 대상이면, 스크립트가 Mac daemon 의
   `config.json` 을 찾아 `token`/`localAdminSecret`/`port` 를 런치 인텐트 extra 로 넘긴다(아래 참고).
   `PS_ANDROID_NO_DEV_PAIR=1` 이거나 응답하는 daemon 을 못 찾으면 생략.
5. **실행** — `adb shell am start -n com.pocketsisyphus.android/.MainActivity` (`PS_ANDROID_NO_LAUNCH=1`
   이면 건너뜀).

## 에뮬레이터 페어링 (debug 전용 `DevBootstrap`)

갓 설치한 에뮬레이터에는 페어링된 daemon 이 없고, 에뮬레이터 카메라로 QR 을 스캔하기도 번거롭다 —
그래서 iOS 시뮬레이터(`/verify-ios`)와 «동일하게» debug 빌드는 런치 인텐트 extra 를 한 번 읽어 QR
페어링을 우회한다(release 빌드에선 무시). `DevBootstrap` 는 두 모드를 지원한다:

**1. 직결(기본, iOS 시뮬레이터 동형).** QR/SSH/Tor 없이, Mac 의 `config.json` 값 3개만으로 에뮬레이터
loopback 별칭을 통해 호스트 Mac daemon 에 직접 붙는다. attest 게이트는 `X-PS-Local` 헤더(HTTP) /
`?local=` query(WS)로 우회 — Mac 앱이 쓰는 바로 그 경로다. **`scripts/dev-android.sh` 가 에뮬레이터 +
Debug 빌드에서 이걸 자동으로 채운다**. 수동 형태는:

```bash
adb shell am start -n com.pocketsisyphus.android/.MainActivity \
    --es devDaemonToken "<config.json 의 token>" \
    --es devLocalSecret "<config.json 의 localAdminSecret>" \
    --ei devDaemonPort 7777 \
    --es devHost 10.0.2.2     # 10.0.2.2 = 에뮬레이터에서 본 호스트 Mac 의 loopback
```

**2. 전체 페이로드(실 SSH/Tor 플로우).** 완전한 QR 페어링 JSON 을 주입해 정상 페어링 플로우를 탄다:

```bash
adb shell am start -n com.pocketsisyphus.android/.MainActivity \
    --es devPairingB64 "<페어링 페이로드 JSON 의 base64>" \
    --es devHost 10.0.2.2
```

`--ez devForceLock true` 는 (페어링 없이) 앱 진입 잠금 화면을 강제로 켜 시각 검증할 때 쓴다.

## 전제 / 주의

- **JDK 17** + **Android SDK**(platform 36, build-tools 36) 필요. `local.properties`(`sdk.dir=…`)는
  커밋되지 않으니 거기서 또는 `ANDROID_HOME` 으로 SDK 경로를 지정한다.
- 에뮬레이터 안에서 호스트 Mac 은 `127.0.0.1`/`localhost` 가 아니라 **`10.0.2.2`** 다 — Mac 의
  loopback daemon 은 `10.0.2.2` 로 접근해야 한다(`devHost` 기본값이 그것). 이 별칭이 호스트 loopback
  으로 매핑되므로 loopback 전용 daemon 도 닿는다. 단 직결 페어링이 붙으려면 **Mac 앱이 실행 중**이어야 한다.
- daemon `config.json` 탐색 순서: `POCKET_CLAUDE_CONFIG_DIR` →
  `~/Library/Application Support/PocketSisyphus-dev`(격리 dev) →
  `~/Library/Application Support/PocketSisyphus`(공유). `/health` 에 응답하는 첫 항목을 쓴다.
- 실기기는 **USB 디버깅 켜짐 + 인증됨**이어야 한다(RSA 프롬프트 수락). `adb devices` 에서
  `unauthorized`/`offline` 이 아니라 `device` 로 보이는지 확인. 직결 페어링은 기본적으로 **에뮬레이터
  전용**(10.0.2.2)이다 — 실기기엔 `PS_ANDROID_DEV_HOST=<mac-lan-ip>` 를 지정한다(daemon 이 LAN 에 listen 해야 함).
- 다른 Gradle 태스크: `PS_ANDROID_TASK=installRelease ./scripts/dev-android.sh` (임의 `:app:` 태스크).

## 실패 시

`set -euo pipefail` 로 즉시 중단되고, Gradle 이 자체 에러/스택트레이스를 출력한다. 흔한 원인:
- 기기도 없고 부팅할 AVD 도 없음 → Android Studio 에서 가상 기기 생성 또는 `PS_ANDROID_AVD` 지정.
- `unauthorized`/`offline` 기기 → USB 디버깅 프롬프트 재수락, 또는 `adb kill-server && adb start-server`.
- SDK 못 찾음 → `ANDROID_HOME` 설정 또는 `android/local.properties` 의 `sdk.dir` 수정.
그대로 사용자에게 전달하고, 코드 수정이 필요하면 알린다.
