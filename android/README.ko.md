[English](README.md) · **한국어**

# Pocket Sisyphus — 안드로이드 클라이언트

아이폰의 «일상 흐름»을 안드로이드에서 재현하는 네이티브 클라이언트 — 책상에 앉아 있지 않아도
폰으로 코드 에이전트를 보고 조종한다. iOS 앱과 **같은 맥 데몬 API** 를 소비한다: 세션 목록,
세션별 채팅/터미널(콜드 진입 시 화면 스냅샷 즉시 로딩 + WS 로 실시간 ANSI), git 상태.

> 독점 / 소스 공개 — 오픈소스 아님. 공개 ≠ 상업적 사용 허가.

## 무엇을 하나

- **세션 목록** — 데몬의 세션을 실시간으로: 실행 상태(실행 중 · 대기 · 완료), 에이전트 종류
  (Claude Code · Codex · Copilot · …), worktree 브랜치, 최근 활동, «입력 대기» 미리보기.
  상태별 필터 · 제목/경로 검색 · **새 세션 생성**.
- **채팅 / 터미널** — 세션을 열면 PTY **화면 스냅샷**을 즉시 그리고, **WebSocket** 이 실시간
  ANSI 를 자체 VT100/xterm 에뮬레이터로 흘려보낸다(SGR 색 · 커서 주소지정 · 스크롤 영역 ·
  대체 화면). 에이전트에 메시지 전송, Esc / Enter / ↑ / ↓ 로 REPL 프롬프트 제어, 현재 브랜치 +
  변경 파일 수와 탭하면 보이는 diff.

## 구조

```
Android 앱 ──sshj LocalPortForward──▶ ssh(host:22022, ed25519) ──▶ 원격 127.0.0.1:7777 (daemon)
   OkHttp HTTP/WS ──▶ http://127.0.0.1:<localPort>   (Authorization: Bearer <daemon_token>,
                                                       X-PS-Attest: <attest 토큰>)
```

- **전송**(`transport/`): LAN/SSH 직결. SSH 로컬 포트포워딩(sshj, ed25519 클라이언트 키, 데몬의
  `SHA256:` 지문으로 host key 핀)으로 데몬 loopback HTTP/WS 에 닿는다. `Transport` 인터페이스
  뒤에 두어 Tor-SOCKS 경로를 나중에 끼워 넣을 수 있게 했다.
- **기기 인증**(`data/Attestation.kt`): 데몬의 P256 challenge-response. Android Keystore 의
  secp256r1 키로 기기를 등록하고 challenge 에 서명해 `X-PS-Attest` 토큰을 받는다.
- **API/WS**(`data/`): OkHttp + kotlinx.serialization. `ApiClient`(타입드 엔드포인트, 투명 재연결
  + attest 갱신)과 `WsClient`(subscribe / pty_input / ping, 백오프 재연결).
- **터미널**(`terminal/`): 자체 완결형 VT100/xterm 에뮬레이터 + Compose 렌더러(GPL 의존성 없음).
- **UI**(`ui/`): Jetpack Compose, MVVM. 페어링 → 세션 목록 → 세션 상세.

스택: Kotlin 2.2, Compose(BOM 2025.09), AGP 8.12 / Gradle 8.14, minSdk 26 / target 36.

## 빌드 & 실행

```bash
cd android
./gradlew :app:installDebug      # 연결된 기기/에뮬레이터에 빌드 + 설치
```

Android SDK(platform 36, build-tools 36) + JDK 17 필요. `local.properties`(`sdk.dir=…`)로 SDK 경로를
지정한다 — 커밋되지 않음.

## 페어링

1. 맥에서 Pocket Sisyphus 를 열어 페어링 QR 을 띄운다.
2. 안드로이드 앱에서 **QR 스캔**(카메라) 또는 **페이로드 붙여넣기**(QR 의 JSON) 후 연결.
3. 기기가 스스로 기기 인증에 등록된다. 맥이 빈 기기 슬롯이 없다고 하면, Pocket Sisyphus 설정에서
   추가 기기 슬롯을 켜거나(또는 다른 기기를 해제하고) 다시 시도한다.

> 첫 기기 슬롯 등록은 데몬에 빈 슬롯이 필요하다(맥에 물리적 접근 필요) — 의도된 보안.

## 상태 / 한계 (v1)

- **Tor 전송은 보류.** v1 은 LAN/SSH 직결로 연결한다. QR 의 `onion` / `onion_auth` 는 저장하되
  쓰지 않는다. 전송 계층은 Tor-SOCKS + `/endpoint` 발견 경로를 API/UI 를 건드리지 않고 추가할 수
  있게 구성돼 있다.
- **앱 현지화**는 영어/한국어 소스 문자열 수준 — iOS/Mac 이 출시하는 10개 언어 카탈로그는 후속.
- 디버그 전용 실행 인텐트 훅(`DevBootstrap`, `BuildConfig.DEBUG` 게이트)으로 에뮬레이터 테스트용
  페어링 페이로드를 주입할 수 있다 — 릴리스 빌드에선 동작하지 않는다.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
