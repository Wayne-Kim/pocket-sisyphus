---
name: dev-ios
description: >-
  iOS dev 빌드 + 설치. 케이블 연결된 실기기(기본 iPhone 13 mini)에 Debug 빌드를 설치한다.
  `/dev` 에서 iOS 만 떼어낸 스킬 (Mac 은 건드리지 않음). 사용자가 "/dev-ios", "아이폰에 설치",
  "iOS dev 빌드", "iOS 앱만 설치해줘", "폰에 깔아줘(iOS)" 등을 요청할 때 사용.
  다른 기기는 PS_DEV_DEVICE_UDID 로 오버라이드.
---

[English](SKILL.md) · **한국어**

# /dev-ios — iOS dev 앱 빌드 + 설치

케이블 연결된 실기기(기본 iPhone 13 mini)에 iOS Debug 빌드를 설치한다. **`/dev` 에서 iOS 만
떼어낸 스킬** — 모든 로직은 `scripts/dev.sh` 에 있고, 이 스킬은 `ios` 인자로 그것을 실행하고 결과를
보고한다. (Mac 은 `/dev-mac`, 둘 다는 `/dev` 를 쓴다.)

## 실행

```bash
./scripts/dev.sh ios
```

다른 기기는 하드웨어 UDID 를 오버라이드한다:

```bash
PS_DEV_DEVICE_UDID=<udid> ./scripts/dev.sh ios
```

빌드는 몇 분 걸릴 수 있으니 넉넉한 타임아웃으로 포그라운드에서 실행하고 출력을 사용자에게 그대로
전달한다. 끝나면 설치 성공/실패를 한 줄로 요약한다.

## 동작 요약

- **iOS dev** → `xcodebuild build`(Debug, `platform=iOS,id=<iPhone 13 mini UDID>`) 후
  `xcrun devicectl device install app` 으로 실기기에 인플레이스 설치(컨테이너/Keychain 보존 → 페어링
  유지). Tor self-link 충돌(`can't link a dylib with itself`) 시 산출물을 자동 정리하고 1회 재시도.
- **Mac 은 건드리지 않음** — iOS 타깃만 빌드/설치한다.

## 사전 조건 / 주의

- iPhone 13 mini 가 케이블 연결 + 잠금 해제 + 개발자 모드/신뢰 설정이 되어 있어야 한다. 다른 기기는
  `PS_DEV_DEVICE_UDID=<udid>` 로(또는 WiFi 연결 iPhone 17 Pro Max 는 `/device` 로) 지정한다.
- 인플레이스 설치라 기존 컨테이너가 유지된다 → 폰이 daemon 에 그대로 페어링된 채로 남는다.
- `project.yml` 을 바꿨다면 `PS_DEV_REGEN=1 ./scripts/dev.sh ios` 로 xcodegen 재생성도 함께 한다.

## 실패 시

스크립트가 빌드 로그 마지막 40줄을 출력한다. 흔한 원인: 기기 미연결/미신뢰, 개발자 모드 꺼짐,
프로비저닝/서명. 그대로 사용자에게 전달하고, 코드 수정이 필요하면 짚어 준다.
