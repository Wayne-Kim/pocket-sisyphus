---
name: dev
description: >-
  dev 빌드 + 설치. iOS dev 앱은 케이블 연결된 실기기(iPhone 13 mini)에 Debug 빌드로
  설치하고, Mac dev 앱은 Debug 로 빌드 후 실행 중 인스턴스를 교체(재실행)한다.
  사용자가 "/dev", "dev 빌드 설치", "앱 설치해줘(개발용)" 등을 요청할 때 사용.
  인자로 ios / mac 을 주면 해당 플랫폼만, 없으면 둘 다.
---

# /dev — dev 앱 빌드 + 설치

iOS(실기기) + Mac dev 빌드를 한 번에 빌드·설치한다. 모든 로직은
`scripts/dev.sh` 에 있다 — 이 스킬은 그것을 실행하고 결과를 보고한다.

## 실행

`$ARGUMENTS` 에 `ios` 또는 `mac` 가 있으면 그 인자를 그대로 넘기고, 없으면 인자 없이
(= 둘 다) 실행한다:

```bash
./scripts/dev.sh            # 인자 없음 → iOS(실기기) + Mac
./scripts/dev.sh ios        # iOS 실기기만
./scripts/dev.sh mac        # Mac 만
```

빌드는 수 분 걸릴 수 있으니 충분한 타임아웃으로 foreground 실행하고, 출력을 그대로
사용자에게 전달한다. 끝나면 각 플랫폼의 설치 성공/실패를 한 줄로 요약한다.

## 동작 요약

- **iOS dev** → `xcodebuild build`(Debug, `platform=iOS,id=<iPhone 13 mini UDID>`)
  후 `xcrun devicectl device install app` 로 실기기에 in-place 설치(컨테이너/Keychain
  보존 → 페어링 유지). Tor 셀프링크 충돌 시 산출물 자동 청소 후 1회 재시도.
- **Mac dev** → `xcodebuild build`(Debug, macOS, daemon/tor nested 서명 포함) 후
  실행 중 `PocketSisyphusMac` 을 종료하고 새 빌드를 `open`.

## 전제 / 주의

- iOS: iPhone 13 mini 가 케이블로 연결 + 잠금 해제 + 개발자 모드/신뢰 설정돼 있어야 함.
  다른 기기는 `PS_DEV_DEVICE_UDID=<udid>`.
- Mac: 설치(재실행) 과정에서 실행 중이던 Mac 앱이 잠깐 종료된다 → 그 앱이 띄운
  daemon 도 재기동되므로 연결 중인 폰이 잠시 끊겼다 다시 붙는다.
- `project.yml` 을 바꿨다면 `PS_DEV_REGEN=1 ./scripts/dev.sh` 로 xcodegen 재생성까지.

## 실패 시

스크립트가 마지막 빌드 로그 40줄을 출력한다. 흔한 원인:
- iOS: 기기 미연결/미신뢰, 개발자 모드 off, 프로비저닝.
- Mac: 서명 identity 누락(nested 바이너리 서명 단계).
그대로 사용자에게 전달하고, 코드 수정이 필요하면 알린다.
