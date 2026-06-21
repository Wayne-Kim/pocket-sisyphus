**English** · [한국어](README.ko.md)

# Pocket Sisyphus — iOS

The iOS client for the dual-channel model (SSH-first + Tor fallback). No NEPacketTunnelProvider extension — Tor.framework runs lazily inside the main app process and is stopped once SSH is adopted. In «same Wi‑Fi only» mode (opt-in), Tor is skipped entirely and the app connects straight to the private address only (`LanOnlyPolicy`/`ConnectionModeView`, fail-closed).

## Build / run

```bash
cd ios
xcodegen generate           # project.yml → PocketSisyphus.xcodeproj + auto-installs Pods
open PocketSisyphus.xcworkspace   # CocoaPods, so use the .xcworkspace

# Or via CLI:
# Simulator:
xcodebuild -workspace PocketSisyphus.xcworkspace -scheme PocketSisyphus \
  -destination 'generic/platform=iOS Simulator' -configuration Debug build

# Real device (requires an Apple Dev team ID):
xcodebuild -workspace PocketSisyphus.xcworkspace -scheme PocketSisyphus \
  -destination 'generic/platform=iOS' -configuration Debug \
  -allowProvisioningUpdates build

# Install on the device:
xcrun devicectl device install app --device <DEVICE-UUID> \
  ~/Library/Developer/Xcode/DerivedData/PocketSisyphus-*/Build/Products/Debug-iphoneos/PocketSisyphus.app
xcrun devicectl device process launch --device <DEVICE-UUID> pe.wayne.pocketsisyphus
```

## Structure

```
ios/
├── project.yml                  # xcodegen spec (source of truth)
├── Podfile                      # Tor (CocoaPods) dependency
├── PocketSisyphus/
│   ├── PocketSisyphusApp.swift  # @main entry point + environment object setup
│   ├── Info.plist
│   ├── PocketSisyphus.entitlements   # Keychain only (NetworkExtension/App Group removed)
│   ├── Services/
│   │   ├── AuthStore.swift          # PairConfig stored in the Keychain
│   │   ├── TorManager.swift         # in-process Tor + 5-step stop/start sequence
│   │   ├── SSHClient.swift          # Citadel + NWListener local TCP forwarding
│   │   ├── ConnectionManager.swift  # happy eyeballs SSH adoption + Tor lazy + LAN-only branch
│   │   ├── LanOnlyPolicy.swift       # «same Wi‑Fi only» pure policy (candidate filter · Tor skip · fail-closed)
│   │   ├── ConnectionModePolicy.swift # gate key for whether the connection mode was first chosen (modeChosen)
│   │   ├── EndpointCache.swift      # Keychain cache of the /endpoint response
│   │   ├── ApiClient.swift          # HTTP via SSH local forward
│   │   ├── WSClient.swift           # WS via SSH local forward
│   │   ├── ChatViewModel.swift      # PTY stream + polling + send history
│   │   ├── EntitlementDecision.swift  # trial / IAP gate (has unit tests)
│   │   └── ...
│   └── Views/
│       ├── AppRoot.swift            # state-based routing + connection-mode gate + Tor fallback banner
│       ├── ConnectionModeView.swift # first-run connection-mode choice (Anywhere (Tor) / same Wi‑Fi only)
│       ├── BootView.swift           # Tor bootstrap progress / SSH adoption spinner
│       ├── PairView.swift           # pairing v=3 QR verification
│       ├── SessionsView.swift       # session list
│       ├── ChatView.swift           # PTY SwiftTerm rendering
│       └── ...
├── Shared/
│   └── PairConfig.swift             # v=3 pairing payload + models
└── PocketSisyphusTests/             # XCTest — pure struct units only
```

## Dependencies

- **Tor.framework** (CocoaPods, iCepa `~> 409.8`) — embeds Tor 0.4.9.x. Runs in-process inside the main app process.
- **Citadel** (SwiftPM, `from: 0.12.1`) — swift-nio-ssh wrapper. SSH client + direct-tcpip channel.
- **SwiftTerm** (SwiftPM, `1.13.0`) — xterm-compatible terminal emulator. Renders PTY raw bytes.

NMSSH was evaluated and dropped — its vendored libcrypto.a conflicts in alignment with the Xcode 26 + arm64-sim linker.

## Build notes

- `DEVELOPMENT_TEAM`: `AZ9NKP8D9G` in `project.yml` (a personal Apple Dev team ID)
- Bundle ID: `pe.wayne.pocketsisyphus`
- Deployment target: **iOS 17.0+** (Citadel's swift-nio dependency)
- Code Signing: Debug is Automatic (for development). Release (distribution) signing is maintainer-only.
- `EAGER_LINKING=NO` + `EAGER_LINKING_TBDS=NO` are required (avoids the Tor.framework self-link on Xcode 26+)

## Background policy

The iOS app keeps **nothing alive** in the background:
- Entering background → stop both SSH and Tor
- Returning to foreground → try a direct SSH to the cached endpoint → on failure, Tor → refresh `/endpoint`
- APNs / BGAppRefreshTask / BGProcessingTask are **permanently unimplemented**. No background push. Real-time events such as tool approvals are handled the moment the user brings the app to the foreground.

## Pairing QR (v=3)

The pairing payload issued by the Mac daemon:
- `onion` + `onion_auth` — for building the Tor circuit + endpoint lookup
- `endpoint_token` / `daemon_token` — Bearer authentication
- `ssh_host_key_fingerprint` — host key pin on SSH connect (currently acceptAnything in the first pass, strict pin in P3.6)
- `ssh_client_priv` — a fresh ed25519 priv per pairing (PKCS8 PEM base64)
- `ssh_user` — sshd AllowUsers (the current macOS user)

v<3 payloads are rejected — the user is told to «update the Mac app, then re-pair».

## Detailed architecture

See [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md).
