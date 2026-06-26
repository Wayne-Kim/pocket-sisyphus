**English** · [한국어](ANDROID_CLIENT.ko.md)

# Android client — tech-stack decision & walking-skeleton contract

> Proprietary / source-available — not open source. Public ≠ a grant of commercial use.

This records the decision behind the Android client and the **OS-neutral contracts** it shares
with the existing iOS client and the Mac daemon. Scope here is the *walking skeleton*: QR pair →
Tor → direct SSH → device attestation → first authed API call → one diagnostic screen. Product
feature UI (sessions/chat/workflows) is out of scope for this document.

## Decision: native Kotlin + Jetpack Compose (no shared mobile runtime)

We build the Android client as a **native Kotlin / Jetpack Compose** app rather than sharing a
cross-platform runtime (KMP / Flutter / React Native) with iOS.

**Why native over a shared runtime**

- The thing worth sharing isn't code — it's the **daemon contract**, which is already OS-neutral
  (plain JSON, P-256 ECDSA, SSH, Tor v3). iOS is SwiftUI; mirroring its small surface in Compose
  is cheaper and lower-risk than introducing a KMP toolchain across two mature native apps.
- The skeleton leans hard on **platform-specific security primitives** that a shared runtime would
  only wrap thinly: Android Keystore (StrongBox/TEE) attestation keys, BiometricPrompt, and an
  in-process Tor service. Native access keeps these first-class.
- The daemon was explicitly designed client-OS-agnostic (see `mac/daemon/src/tor/pairing.ts`,
  `routes/endpoint.ts`, `attest.ts`), so almost no daemon change is needed — the leverage is in a
  faithful client, not shared UI.

**What is shared (the contract, not the code)** — kept in sync by mirroring, not a shared module:

| Contract | Source of truth | Android mirror |
| --- | --- | --- |
| Pairing QR `PairQRPayload` v=3 (JSON) | `mac/daemon/src/tor/pairing.ts` | `data/model/ApiModels.kt` `PairPayload` |
| `GET /endpoint` (happy-eyeballs candidates) | `mac/daemon/src/routes/endpoint.ts` | `data/model/ApiModels.kt` `EndpointResponse` |
| Happy-eyeballs ordering | iOS `HappyEyeballsPolicy.swift` | `data/HappyEyeballs.kt` |
| Device attestation P-256 challenge-response | `mac/daemon/src/attest.ts` | `data/Attestation.kt` |
| Client-version handshake | `mac/daemon/src/version.ts` | `X-Client-Version` header (= app `versionName`) |
| Color / spacing / locale design tokens | iOS `DesignTokens.swift` | `ui/theme/Color.kt` `PsColor` |

## Decision: in-process Tor via Guardian Project `tor-android`

The Tor data plane (onion `/endpoint` lookup + `tor_onion` SSH fallback) runs **in-process** via
`info.guardianproject:tor-android` — the Android analogue of the iCepa `Tor.framework` the iOS app
embeds. It ships the tor binary + `jtorctl` control library and exposes a local **SOCKS5** port.

- **Version pin `0.4.8.19`** — the latest release whose AAR metadata compiles against `compileSdk`
  36; `0.4.9.x` requires `compileSdk` 37 (newer than this AGP's recommended max). Bump together with
  the SDK/AGP later.
- **v3 client-auth** is provisioned before bootstrap by writing `<onionBase>.auth_private` =
  `<onionBase>:descriptor:x25519:<privBase32>` into a `ClientOnionAuthDir` — byte-identical to the
  iOS `TorManager` contract.
- **sshj over Tor** (`transport/TorSocketFactory.kt`): returns an *already-connected* SOCKS5 socket
  to an **unresolved** onion address, so sshj skips local DNS and the proxy does remote resolution.
- **OkHttp over Tor** (`data/EndpointResolver.kt`): a SOCKS proxy on the client; OkHttp hands the
  `.onion` host to the proxy (no local DNS).

Alternatives considered: Arti (Rust, `arti-mobile`) — promising but less battle-tested for onion
client-auth on Android than the Guardian Project stack; obfs4 bridges — out of scope here (need a
separate PT binary; see «Optional bridge bypass» below).

## Optional bridge bypass (DPI-blocked networks)

An **optional** bypass that keeps the onion fallback alive on networks where plaintext Tor is
DPI-blocked (schools, offices, some countries). It mirrors the iOS `TorBridgeStore`/`TorManager`
contract verbatim — the *same* bridge line works on either phone.

- **Plaintext first.** `TorManager.ensureBootstrapped` always tries plaintext first and, only on a
  stall, auto-retries through the user's bridges (injecting `UseBridges 1` + `Bridge …` into the
  torrc). Users who never opt in are unaffected.
- **Status / entry.** When plaintext stalls, `likelyBlocked` flips on so the diagnostic «Tor blocked»
  card offers the bridge setup. The bridge-through result (connecting / connected / failed) surfaces
  via `BridgeStore.status`.
- **obfs4 not supported.** `tor-android` 0.4.8.19 ships only `libtor.so` — no obfs4proxy binary (same
  as iOS without `IPtProxy`) — so obfs4 bridges can't be dialed; only vanilla bridges are tried and
  the UI warns. Bundling obfs4 is an explicit non-goal of this brief.

## Walking-skeleton flow (what the diagnostic screen proves)

1. **Pairing** — scan the Mac's QR; parse `PairPayload` v=3. Pre-v3 QR is **rejected** with an
   "update the Mac app and re-pair" message (the old formats lack the SSH keypair sshd needs).
2. **Direct first** — if the QR carries a LAN host, dial it over plain SSH (host key pinned to the
   QR `SHA256:` fingerprint; mismatch fails closed). Fast path, no Tor.
3. **Tor + `/endpoint`** — otherwise / in full-proof mode: bootstrap Tor, `GET /endpoint` over the
   onion → `[direct_ipv6, direct_ipv4, tor_onion]` + host-key fingerprint + `daemon_local_port`.
4. **Happy-eyeballs SSH** — try candidates in priority order (direct first, `tor_onion` last);
   `tor_onion` routes SSH through the Tor SOCKS5 proxy. `direct-tcpip` reaches daemon `127.0.0.1:7777`.
5. **Device attestation** — an Android-Keystore secp256r1 key (StrongBox where available, else TEE),
   **biometric-gated** (BiometricPrompt — lost-phone protection, the Face ID equivalent). Register the
   X9.63 public key → sign the `/api/attest/challenge` nonce (ECDSA-P256-SHA256, DER) → `/api/attest/verify`
   → attest token. On daemon reboot (token invalidation) a single re-auth recovers (401 `attest_required`).
6. **First authed API call** — `X-PS-Attest` + `Bearer <daemonToken>` + `X-Client-Version` headers →
   `GET /api/version` and `GET /api/sessions` return **200**.

The diagnostic screen renders each stage with status-only color (success = green, failure = red,
in-progress/pending = neutral), localized (ko source + en), with accessibility labels.

## Go / no-go

**Go.** The contracts line up and the client builds against the live daemon protocol with **no daemon
changes**. Compile + full `assembleDebug` are green in CI-less local verification; the live circuit
(real QR + real daemon + real Tor) is verified **on-device** as the next step. Edge cases scoped for
on-device: StrongBox-absent → TEE fallback, expired/single-use nonce, daemon-reboot re-auth, and
DPI-blocked Tor surfaced as an explicit "connection failed" (with the optional bridge bypass as the user remedy).
