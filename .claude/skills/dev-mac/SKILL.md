---
name: dev-mac
description: >-
  macOS 에서 실행 중인 Pocket Sisyphus Mac 앱을 (GUI 앱 + 자식 daemon/tor/sshd + 과거 dev
  빌드 orphan 까지) 완전히 종료하고, Debug dev 빌드를 새로 빌드해 재실행한다. daemon 코드를
  바꾼 뒤 stale daemon 없이 실기 검증할 때 쓴다. 사용자가 "/dev-mac", "맥 앱 완전 종료하고
  재실행", "포켓 맥 재시작", "dev 맥 다시 띄워", "Mac 앱 깨끗하게 재실행" 등을 요청할 때 사용.
---

# /dev-mac — Mac 앱 완전 종료 + dev 재실행

실행 중인 `PocketSisyphusMac` 을 자식 프로세스(daemon node / tor / sshd)와 과거 dev
빌드가 남긴 orphan 까지 전부 종료한 뒤, Debug dev 빌드를 새로 빌드·실행한다. 모든 로직은
`scripts/dev-mac.sh` 에 있다 — 이 스킬은 그것을 실행하고 결과를 보고한다.

## 왜 `/dev mac` 이 아니라 별도인가

`/dev mac` 은 `pkill -x PocketSisyphusMac` 로 **GUI 프로세스만** 죽인다 → 앱이 띄운
daemon(node)/tor/sshd 자식이 orphan 으로 살아남는다. daemon 코드를 바꾼 뒤 검증하면
«옛 daemon» 이 그대로 서빙해 새 코드가 안 도는 것처럼 보인다(실제로 과거 dev 실행이 남긴
daemon/tor/sshd orphan 들이 `ps` 에 쌓여 있는 게 확인됨). `/dev-mac` 은 번들 경로
(`PocketSisyphusMac.app/Contents`)로 묶인 자식까지 전부 정리해 **새 빌드의 daemon 만**
남게 한다.

## 실행

인자 없음. 빌드가 수 분 걸릴 수 있으니 충분한 타임아웃으로 foreground 실행하고 출력을
그대로 사용자에게 전달한다.

```bash
./scripts/dev-mac.sh
```

`project.yml` 을 바꿨다면 `PS_DEV_REGEN=1 ./scripts/dev-mac.sh` 로 xcodegen 재생성까지.

## 동작 요약

1. **build (Debug, macOS)** — 빌드 동안 옛 앱은 그대로 떠 있어 downtime 을 빌드 끝까지 미룬다.
2. **완전 종료** — `pkill -f 'PocketSisyphusMac.app/Contents'` (SIGTERM → 재확인 → SIGKILL)
   로 GUI 앱 + daemon/tor/sshd 자식 + DerivedData dev orphan 까지. 빌드 자신
   (`xcodebuild -scheme PocketSisyphusMac`)과는 cmdline 이 안 겹쳐 빌드를 죽일 위험이 없다.
   종료 전/후 프로세스 수를 한 줄로 보고한다.
3. **재실행** — 새 Debug `.app` 을 `open`.

## 전제 / 주의

- 재실행 과정에서 daemon 이 재기동되므로 연결 중이던 폰이 잠시 끊겼다 새 daemon 으로 다시 붙는다.
- Debug 빌드라 nested daemon/tor/sshd 서명이 포함된다 — 서명 identity 가 없으면 빌드 단계에서 실패.
- 종료 후에도 프로세스가 남으면(«N개 아직 남아 있음») 권한/좀비 가능성 — 그대로 사용자에게 전달.

## 안전 프로토콜 (실행 «전» 확인 — 어기면 사고)

`/dev-mac` 은 daemon 을 강제 종료·재기동하고 포트/configDir 을 새 빌드가 가져간다. 그래서
«연결만 잠깐 끊겼다 다시 붙는다» 로 끝나지 않고, 아래를 안 지키면 **진행 중 작업이 날아가거나
폰이 아예 못 붙는다**. 실행 전 다음을 차례로 확인한다:

1. **진행 중인 agent 세션이 있으면 먼저 끝낸다.** daemon 재시작 시 «진행 중인 턴» 은 복구되지
   않는다 — 모델이 응답을 쓰는 중이거나 도구 실행 중이면 그 턴이 통째로 유실된다. 돌고 있는
   세션이 있으면 끝나길 기다리거나, 사용자에게 명시적으로 확인(«진행 중 세션을 끊어도 되나»)을
   받은 뒤에만 실행한다.
2. **Release(/Applications) 앱이 떠 있으면 한쪽을 먼저 종료한다.** dev 빌드와 Release 는
   **같은 configDir 과 포트 7777 을 공유**한다 — 둘이 동시에 뜨면 포트가 충돌해 **폰이 접속
   불가**가 되고 configDir 이 꼬일 수 있다. dev 로 검증하려면 Release 앱을 먼저 끄고
   (`/dev-mac` 의 KILL 패턴은 Release 를 «안» 죽인다 — 직접 끈다), 반대도 마찬가지.
3. **실행 «직후» Mac 메뉴에서 두 가지를 눈으로 확인한다.** (a) 포트 충돌 경고가 «없는지»,
   (b) 폰이 새 daemon 으로 다시 «재연결» 됐는지. 둘 중 하나라도 어긋나면 위 1~2 를 다시 점검한다.

> 프리플라이트 가드: 위 1~2 를 `scripts/dev-mac.sh` 가 자동 점검하게 되면(진행 중 세션·Release
> 동시 실행 감지 후 중단/확인), 가드가 무엇을 막고 어떻게 우회(`--force` 등)하는지를 이 절에
> 함께 적는다. 현재 스크립트엔 가드가 없어 위 확인은 «수동» 이다.

## 실패 시

스크립트가 fail-fast 하며 빌드 실패 시 마지막 40줄을 출력한다. 그대로 전달하고, 코드/서명
설정 수정이 필요하면 알린다.
