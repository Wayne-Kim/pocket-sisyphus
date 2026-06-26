**English** · [한국어](README.ko.md)

# Pocket Sisyphus — Android client

A native Android client that reproduces the iPhone "daily flow": watch and steer your code agents
from your phone, away from your desk. It consumes the **same Mac-daemon API** the iOS app uses —
session list, per-session chat/terminal (instant screen snapshot + live ANSI over WebSocket), and
git status.

> Proprietary / source-available — not open source. Public ≠ a grant of commercial use.

## What it does

- **Session list** — live list of your daemon's sessions with run-state (running · waiting · done),
  agent kind (Claude Code · Codex · Copilot · …), worktree branch, recent activity, and the
  "awaiting input" preview. Filter by state, search by title/path, and **create a new session**.
- **Chat / terminal** — opening a session paints the PTY **screen snapshot** immediately, then a
  **WebSocket** streams live ANSI into an in-house VT100/xterm emulator (SGR colors, cursor
  addressing, scroll regions, alt-screen). Send a message to the agent, drive REPL prompts with
  Esc / Enter / ↑ / ↓, and see the current branch + changed-file count with a tap-through diff.

## Architecture

```
Android app ──sshj LocalPortForward──▶ ssh(host:22022, ed25519) ──▶ remote 127.0.0.1:7777 (daemon)
   OkHttp HTTP/WS ──▶ http://127.0.0.1:<localPort>   (Authorization: Bearer <daemon_token>,
                                                       X-PS-Attest: <attest token>)
```

- **Transport** (`transport/`): LAN/SSH-direct. An SSH local port-forward (sshj, ed25519 client key,
  host-key pinned by the daemon's `SHA256:` fingerprint) reaches the daemon's loopback HTTP/WS.
  Structured behind a `Transport` interface so a Tor-SOCKS leg can drop in later.
- **Attestation** (`data/Attestation.kt`): the daemon's P256 challenge-response. An Android-Keystore
  secp256r1 key enrolls the device and signs challenges for the `X-PS-Attest` token.
- **API/WS** (`data/`): OkHttp + kotlinx.serialization. `ApiClient` (typed endpoints, transparent
  reconnect + attest refresh) and `WsClient` (subscribe / pty_input / ping, backoff reconnect).
- **Terminal** (`terminal/`): a self-contained VT100/xterm emulator + Compose renderer (no GPL deps).
- **UI** (`ui/`): Jetpack Compose, MVVM. Pairing → session list → session detail.

Stack: Kotlin 2.2, Compose (BOM 2025.09), AGP 8.12 / Gradle 8.14, minSdk 26 / target 36.

## Build & run

```bash
cd android
./gradlew :app:installDebug      # builds + installs on a connected device/emulator
```

Requires the Android SDK (platform 36, build-tools 36) and JDK 17. Point Gradle at your SDK via
`local.properties` (`sdk.dir=…`) — not checked in.

## Pairing

1. On your Mac, open Pocket Sisyphus and show the pairing QR.
2. In the Android app, **Scan QR** (camera) or **Paste payload** (the QR's JSON), then Connect.
3. The device enrolls itself for attestation. If the Mac reports no free device slot, enable an
   extra device slot in Pocket Sisyphus settings (or unpair another device) and retry.

> The first device-slot enrollment requires a free slot on the daemon (physical access to the Mac),
> by design.

## Status / limitations (v1)

- **Tor transport is deferred.** v1 connects over LAN/SSH-direct. The QR's `onion` / `onion_auth`
  are stored but unused; the transport layer is structured so a Tor-SOCKS + `/endpoint` discovery
  leg can be added without touching the API/UI layers.
- **App localization** is English/Korean source strings; the full 10-language catalog the iOS/Mac
  apps ship is a follow-up.
- A debug-only launch-intent hook (`DevBootstrap`, behind `BuildConfig.DEBUG`) allows injecting a
  pairing payload for emulator testing; it has no effect in release builds.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
