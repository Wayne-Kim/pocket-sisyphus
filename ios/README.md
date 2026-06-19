# Pocket Sisyphus — iOS

듀얼 채널 모델 (SSH-first + Tor fallback) iOS 클라이언트. NEPacketTunnelProvider 익스텐션 없음 — Tor.framework 를 메인 앱 프로세스 내에서 lazy 운용, SSH 채택 후 stop. 「같은 Wi‑Fi 전용」 모드(opt-in)면 Tor 를 아예 건너뛰고 사설 주소로만 직결한다(`LanOnlyPolicy`/`ConnectionModeView`, fail-closed).

## 빌드 / 실행

```bash
cd ios
xcodegen generate           # project.yml → PocketSisyphus.xcodeproj + Pods 자동 install
open PocketSisyphus.xcworkspace   # CocoaPods 라 .xcworkspace 사용

# 또는 CLI:
# 시뮬레이터:
xcodebuild -workspace PocketSisyphus.xcworkspace -scheme PocketSisyphus \
  -destination 'generic/platform=iOS Simulator' -configuration Debug build

# 실기기 (Apple Dev 팀 ID 필요):
xcodebuild -workspace PocketSisyphus.xcworkspace -scheme PocketSisyphus \
  -destination 'generic/platform=iOS' -configuration Debug \
  -allowProvisioningUpdates build

# 디바이스에 설치:
xcrun devicectl device install app --device <DEVICE-UUID> \
  ~/Library/Developer/Xcode/DerivedData/PocketSisyphus-*/Build/Products/Debug-iphoneos/PocketSisyphus.app
xcrun devicectl device process launch --device <DEVICE-UUID> pe.wayne.pocketsisyphus
```

## 구조

```
ios/
├── project.yml                  # xcodegen spec (source of truth)
├── Podfile                      # Tor (CocoaPods) 의존
├── PocketSisyphus/
│   ├── PocketSisyphusApp.swift  # @main 진입점 + 환경 객체 셋업
│   ├── Info.plist
│   ├── PocketSisyphus.entitlements   # Keychain only (NetworkExtension/App Group 제거됨)
│   ├── Services/
│   │   ├── AuthStore.swift          # PairConfig Keychain 저장
│   │   ├── TorManager.swift         # in-process Tor + stop/start 5단계 시퀀스
│   │   ├── SSHClient.swift          # Citadel + NWListener local TCP forwarding
│   │   ├── ConnectionManager.swift  # happy eyeballs SSH 채택 + Tor lazy + LAN 전용 분기
│   │   ├── LanOnlyPolicy.swift       # 「같은 Wi‑Fi 전용」 순수 정책(후보 필터·Tor skip·fail-closed)
│   │   ├── ConnectionModePolicy.swift # 연결 방식 최초 선택 여부(modeChosen) 게이트 키
│   │   ├── EndpointCache.swift      # /endpoint 응답 Keychain 캐시
│   │   ├── ApiClient.swift          # HTTP via SSH local forward
│   │   ├── WSClient.swift           # WS via SSH local forward
│   │   ├── ChatViewModel.swift      # PTY stream + 폴링 + 송신 이력
│   │   ├── EntitlementDecision.swift  # trial / IAP 게이트 (단위 테스트 있음)
│   │   └── ...
│   └── Views/
│       ├── AppRoot.swift            # 상태 기반 라우팅 + 연결 방식 게이트 + Tor fallback banner
│       ├── ConnectionModeView.swift # 첫 실행 연결 방식 선택(어디서나(Tor)/같은 Wi‑Fi 전용)
│       ├── BootView.swift           # Tor bootstrap progress / SSH 채택 spinner
│       ├── PairView.swift           # 페어링 v=3 QR 검증
│       ├── SessionsView.swift       # 세션 리스트
│       ├── ChatView.swift           # PTY SwiftTerm 렌더
│       └── ...
├── Shared/
│   └── PairConfig.swift             # v=3 페어링 페이로드 + 모델
└── PocketSisyphusTests/             # XCTest — 순수 struct 단위만
```

## 의존성

- **Tor.framework** (CocoaPods, iCepa `~> 409.8`) — Tor 0.4.9.x 임베드. 메인 앱 프로세스 내 in-process 운용.
- **Citadel** (SwiftPM, `from: 0.12.1`) — swift-nio-ssh wrapper. SSH client + direct-tcpip channel.
- **SwiftTerm** (SwiftPM, `1.13.0`) — xterm-호환 터미널 에뮬레이터. PTY raw bytes 렌더.

NMSSH 는 검토 후 폐기 — vendored libcrypto.a 가 Xcode 26 + arm64-sim linker 와 alignment 충돌.

## 빌드 노트

- `DEVELOPMENT_TEAM`: `project.yml` 의 `AZ9NKP8D9G` (개인 Apple Dev 팀 ID)
- Bundle ID: `pe.wayne.pocketsisyphus`
- Deployment target: **iOS 17.0+** (Citadel 의 swift-nio 의존)
- Code Signing: Debug 는 Automatic (개발용). Release(배포) 서명은 메인테이너 전용.
- `EAGER_LINKING=NO` + `EAGER_LINKING_TBDS=NO` 필수 (Xcode 26+ 의 Tor.framework self-link 회피)

## 백그라운드 정책

iOS 앱은 백그라운드에서 **아무것도 유지하지 않음**:
- 백그라운드 진입 → SSH + Tor 모두 stop
- 포그라운드 복귀 → 캐시 endpoint 로 SSH 직행 시도 → 실패 시 Tor → `/endpoint` 갱신
- APNs / BGAppRefreshTask / BGProcessingTask **영구 미구현**. 백그라운드 push 없음. 도구 승인 등 실시간 이벤트는 사용자가 앱을 포그라운드로 가져온 시점에 처리

## 페어링 QR (v=3)

Mac daemon 이 발급하는 페어링 페이로드:
- `onion` + `onion_auth` — Tor 회로 빌드 + endpoint 조회용
- `endpoint_token` / `daemon_token` — Bearer 인증
- `ssh_host_key_fingerprint` — SSH 연결 시 host key pin (현재 1차 acceptAnything, P3.6 에서 strict pin)
- `ssh_client_priv` — 페어링당 새 ed25519 priv (PKCS8 PEM base64)
- `ssh_user` — sshd AllowUsers (macOS 현재 user)

v<3 페이로드는 거부 — 사용자에게 "Mac 앱 업데이트 후 재페어링" 안내.

## 자세한 아키텍처

[`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) 참고.
