[English](ANDROID_CLIENT.md) · **한국어**

# 안드로이드 클라이언트 — 기술 스택 결정 & 걷는 뼈대 계약

> 독점 / 소스 공개 — 오픈소스 아님. 공개 ≠ 상업적 사용 허가.

안드로이드 클라이언트의 «결정»과, 기존 iOS 클라이언트·Mac 데몬과 공유하는 **OS 중립 계약**을
기록한다. 범위는 *걷는 뼈대*: QR 페어링 → Tor → 직접 SSH → 기기 인증 → 첫 인증 API 호출 →
진단 화면 1장. 제품 기능 UI(세션/채팅/워크플로우)는 이 문서의 범위가 아니다.

## 결정: 네이티브 Kotlin + Jetpack Compose (공유 모바일 런타임 없음)

안드로이드 클라이언트를 iOS 와 크로스플랫폼 런타임(KMP / Flutter / RN)을 공유하는 대신
**네이티브 Kotlin / Jetpack Compose** 앱으로 만든다.

**왜 공유 런타임이 아니라 네이티브인가**

- 공유할 가치가 있는 건 코드가 아니라 **데몬 계약**이고, 그건 이미 OS 중립이다(순수 JSON,
  P-256 ECDSA, SSH, Tor v3). iOS 는 SwiftUI 이고, 그 작은 표면을 Compose 로 미러하는 편이 성숙한
  두 네이티브 앱에 KMP 툴체인을 들이는 것보다 싸고 위험이 적다.
- 이 뼈대는 공유 런타임이라면 얇게만 감쌀 **플랫폼 고유 보안 프리미티브**에 크게 기댄다:
  안드로이드 키스토어(StrongBox/TEE) 인증 키, BiometricPrompt, 인프로세스 Tor 서비스. 네이티브
  접근이 이들을 일급으로 다룬다.
- 데몬은 처음부터 클라이언트-OS 중립으로 설계됐다(`mac/daemon/src/tor/pairing.ts`,
  `routes/endpoint.ts`, `attest.ts`). 그래서 데몬 변경이 거의 필요 없다 — 지렛대는 공유 UI 가
  아니라 «충실한 클라이언트»에 있다.

**무엇을 공유하는가(코드가 아니라 계약)** — 공유 모듈이 아니라 미러링으로 동기화:

| 계약 | SSOT | 안드로이드 미러 |
| --- | --- | --- |
| 페어링 QR `PairQRPayload` v=3 (JSON) | `mac/daemon/src/tor/pairing.ts` | `data/model/ApiModels.kt` `PairPayload` |
| `GET /endpoint` (happy-eyeballs 후보) | `mac/daemon/src/routes/endpoint.ts` | `data/model/ApiModels.kt` `EndpointResponse` |
| Happy-eyeballs 정렬 | iOS `HappyEyeballsPolicy.swift` | `data/HappyEyeballs.kt` |
| 기기 인증 P-256 challenge-response | `mac/daemon/src/attest.ts` | `data/Attestation.kt` |
| 클라이언트 버전 핸드셰이크 | `mac/daemon/src/version.ts` | `X-Client-Version` 헤더(= 앱 `versionName`) |
| 색/간격/로케일 디자인 토큰 | iOS `DesignTokens.swift` | `ui/theme/Color.kt` `PsColor` |

## 결정: Guardian Project `tor-android` 인프로세스 Tor

Tor 데이터 플레인(onion `/endpoint` 조회 + `tor_onion` SSH 폴백)을 `info.guardianproject:tor-android`
로 **인프로세스** 운용한다 — iOS 가 임베드한 iCepa `Tor.framework` 의 안드로이드 대응이다. tor 바이너리
+ `jtorctl` 제어 라이브러리를 동봉하고 로컬 **SOCKS5** 포트를 노출한다.

- **버전 핀 `0.4.8.19`** — AAR 메타데이터가 `compileSdk` 36 에서 컴파일되는 마지막 릴리스. `0.4.9.x`
  는 `compileSdk` 37(이 AGP 권장 최대보다 높음)을 요구. 후속에 SDK/AGP 와 함께 올린다.
- **v3 client-auth** 는 부트스트랩 전에 `<onionBase>.auth_private` =
  `<onionBase>:descriptor:x25519:<privBase32>` 를 `ClientOnionAuthDir` 에 써서 준비한다 — iOS
  `TorManager` 계약과 바이트 동일.
- **Tor 위 sshj**(`transport/TorSocketFactory.kt`): **미해석** onion 주소로 «이미 연결된» SOCKS5
  소켓을 돌려줘 sshj 가 로컬 DNS 를 건너뛰고 프록시가 원격 해석하게 한다.
- **Tor 위 OkHttp**(`data/EndpointResolver.kt`): SOCKS 프록시를 두면 OkHttp 가 `.onion` 호스트를
  프록시에 넘긴다(로컬 DNS 없음).

검토한 대안: Arti(Rust, `arti-mobile`) — 유망하나 안드로이드 onion client-auth 운영 검증은 Guardian
Project 스택이 더 충분. obfs4 브리지 — 별도 PT 바이너리가 필요해 이번 스코프 밖(아래 «선택형 브리지 우회» 참고).

## 선택형 브리지 우회 (DPI 차단망)

평문 Tor 가 DPI 로 막히는 망(학교·회사·일부 국가)에서 onion fallback 을 살리는 **선택형** 우회.
iOS `TorBridgeStore`/`TorManager` 계약을 그대로 미러한다 — 같은 브리지 라인을 양쪽 폰에 그대로 쓸 수 있다.

- **평문 우선.** `TorManager.ensureBootstrapped` 는 항상 평문을 먼저 시도하고, 정체될 때만
  사용자의 브리지(`UseBridges 1` + `Bridge …` 를 torrc 에 주입)로 자동 재시도한다. 미설정 사용자엔 영향 없음.
- **상태/진입.** 평문이 정체되면 `likelyBlocked` 가 켜져 진단 화면의 «Tor 차단» 카드가 브리지 설정으로
  유도한다. 브리지 경유 결과(연결 중/연결됨/실패)는 `BridgeStore.status` 로 표시.
- **obfs4 는 미지원.** `tor-android` 0.4.8.19 는 `libtor.so` 만 동봉하고 obfs4proxy 바이너리가 없어
  (iOS 의 `IPtProxy` 부재와 동일) obfs4 브리지는 동작하지 않는다 — vanilla 브리지만 시도하며 UI 가 경고한다.
  obfs4 동봉은 이 브리프의 명시적 비-목표.

## 걷는 뼈대 흐름 (진단 화면이 증명하는 것)

1. **페어링** — Mac QR 스캔, `PairPayload` v=3 파싱. 구버전 v<3 QR 은 «맥 앱 업데이트 후 재페어링»
   안내로 **거부**(옛 포맷엔 sshd 가 요구하는 SSH 키쌍이 없음).
2. **직접 우선** — QR 에 LAN host 가 있으면 평문 SSH 로 다이얼(host key 를 QR `SHA256:` fingerprint
   로 핀; 불일치 시 fail-closed). 빠른 경로, Tor 없음.
3. **Tor + `/endpoint`** — 아니거나 full-proof 모드: Tor 부트스트랩, onion 위 `GET /endpoint` →
   `[direct_ipv6, direct_ipv4, tor_onion]` + host-key fingerprint + `daemon_local_port`.
4. **Happy-eyeballs SSH** — 우선순위대로 후보 시도(직접 먼저, `tor_onion` 마지막); `tor_onion` 은
   Tor SOCKS5 프록시로 SSH 라우팅. `direct-tcpip` 로 데몬 `127.0.0.1:7777` 도달.
5. **기기 인증** — 안드로이드 키스토어 secp256r1 키(가능하면 StrongBox, 아니면 TEE), **생체 게이트**
   (BiometricPrompt — 분실 폰 보호, Face ID 등가). X9.63 공개키 등록 → `/api/attest/challenge` nonce
   서명(ECDSA-P256-SHA256, DER) → `/api/attest/verify` → attest 토큰. 데몬 재부팅(토큰 무효화) 시
   1회 재인증으로 복구(401 `attest_required`).
6. **첫 인증 API 호출** — `X-PS-Attest` + `Bearer <daemonToken>` + `X-Client-Version` 헤더 →
   `GET /api/version`·`GET /api/sessions` **200**.

진단 화면은 각 단계를 상태 전용 색(성공=초록, 실패=빨강, 진행/대기=중립)으로, 로컬라이즈(ko 소스 +
en)와 접근성 라벨과 함께 그린다.

## Go / No-go

**Go.** 계약이 들어맞고, **데몬 변경 없이** 라이브 데몬 프로토콜에 맞춰 클라이언트가 빌드된다.
컴파일 + 전체 `assembleDebug` 가 로컬 검증에서 통과. 라이브 회로(실제 QR + 실데몬 + 실제 Tor)는
다음 단계로 **온디바이스** 검증한다. 온디바이스로 미룬 엣지: StrongBox 미지원 → TEE 폴백, 만료/단일
사용 nonce, 데몬 재부팅 재인증, DPI 차단 Tor 는 명시적 «연결 실패»(선택형 브리지 우회가 사용자 구제책).
