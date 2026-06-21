---
name: device
description: >-
  WiFi 로 연결된 iPhone 17 Pro Max 실기기에 iOS dev 앱(Debug)을 빌드·설치한다.
  `scripts/dev.sh ios` 를 iPhone 17 Pro Max UDID 로 오버라이드해 재사용한다.
  사용자가 "/device", "17 프로맥스에 설치", "WiFi 기기에 앱 설치", "iPhone 17에 깔아줘"
  등을 요청할 때 사용. (케이블 연결 iPhone 13 mini + Mac 은 `/dev` 를 쓴다.)
---

[English](SKILL.md) · **한국어**

# /device — iPhone 17 Pro Max (WiFi) 에 iOS 앱 설치

WiFi 로 연결된 iPhone 17 Pro Max 실기기에 iOS dev 앱을 Debug 로 빌드·설치한다.
빌드/설치/Tor 셀프링크 재시도 로직은 전부 `scripts/dev.sh` 에 있고, 이 스킬은
기기 UDID 만 17 Pro Max 로 바꿔 `dev.sh ios` 를 호출한다.

## 실행

iPhone 17 Pro Max 의 하드웨어 UDID 를 `PS_DEV_DEVICE_UDID` 로 넘겨 iOS 타겟만 실행한다:

```bash
PS_DEV_DEVICE_UDID=00008150-000E7D4902C0401C ./scripts/dev.sh ios
```

빌드는 수 분 걸릴 수 있으니 충분한 타임아웃으로 foreground 실행하고, 출력을 그대로
사용자에게 전달한다. 끝나면 설치 성공/실패를 한 줄로 요약한다.

## 동작 요약

- `xcodebuild build`(Debug, `platform=iOS,id=00008150-000E7D4902C0401C`) → 빌드.
  Tor 셀프링크(`can't link a dylib with itself`) 충돌 시 산출물 자동 청소 후 1회 재시도.
- `xcrun devicectl device install app --device <UDID>` 로 in-place 설치
  (컨테이너/Keychain 보존 → 페어링 유지). WiFi/케이블 전송은 `devicectl` 이 투명하게 처리.

## 전제 / 주의

- iPhone 17 Pro Max 가 **WiFi 로 페어링**돼 있어야 한다 (Xcode → Window → Devices &
  Simulators 에서 "Connect via network" 체크). Mac 과 **같은 네트워크**에 있고,
  **잠금 해제 + 개발자 모드 ON + 신뢰**된 상태여야 한다.
- WiFi 전송은 케이블보다 느릴 수 있다 (빌드 후 install 단계에서 시간이 더 걸림).
- UDID 가 바뀌었거나 다른 기기에 깔려면: `xcrun devicectl list devices` 의 Identifier
  대신 `xcrun xctrace list devices` 의 **하드웨어 UDID**(`0000...` 형식) 를
  `PS_DEV_DEVICE_UDID` 로 넘긴다 — `xcodebuild -destination` 이 하드웨어 UDID 만 받는다.
- `project.yml` 을 바꿨다면 `PS_DEV_REGEN=1` 도 같이: `PS_DEV_REGEN=1 PS_DEV_DEVICE_UDID=… ./scripts/dev.sh ios`.

## 실패 시

`dev.sh` 가 마지막 빌드 로그 40줄을 출력한다. WiFi 설치 특유의 흔한 원인:
- 기기가 네트워크에서 안 보임(같은 WiFi 인지, "Connect via network" 켜졌는지 확인) →
  스크립트가 "연결 목록에 없음" 경고를 내고 그래도 xcodebuild 에 맡겨 시도한다.
- 잠금/미신뢰/개발자 모드 off, 프로비저닝.
그대로 사용자에게 전달하고, 코드 수정이 필요하면 알린다.
