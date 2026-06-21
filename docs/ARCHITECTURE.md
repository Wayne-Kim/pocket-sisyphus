**English** · [한국어](ARCHITECTURE.ko.md)

# Architecture — Dual-Channel Transport + 3 Planes (Transport / Application / PO)

> Read this document in three layers. The **transport & security plane** (§1–4, §9–11) covers "how the phone and the Mac are connected securely," the **application plane** (§12) covers "what runs on top of it," the **result plane** (§13) covers "how execution results are viewed and operated from the phone," and the **PO plane** (§14) covers "who decides what to build."

## 1. System Overview

```
┌──────────────── 사용자 Mac ────────────────┐
│                                             │
│  Pocket Sisyphus.app (메뉴바, Sparkle)       │
│   ├ 설정 창(8탭) · QR 창 · 터미널 미러 창       │
│   └ 권한/전원 관리 + 사일런트 업데이트 브리지     │
│                                             │
│  ┌─ daemon (Node 25 + Hono + WS) ─────────┐ │
│  │ - 127.0.0.1:7777 (API/WS)              │ │
│  │ - 127.0.0.1:7778 (endpoint — onion 전용)│ │
│  │ - PTY runner: claude/agy/codex/shell/   │ │
│  │   local-llm (멀티 에이전트 레지스트리)      │ │
│  │ - SQLite (sessions/messages/cron/        │ │
│  │   workflows/po_*)                       │ │
│  │ - App Attest 검증 게이트                  │ │
│  └─────────────────────────────────────────┘ │
│  ┌─ 자식 프로세스 (daemon spawn) ──────────┐ │
│  │ tor (번들 C tor)  · sshd (OpenSSH portable)│ │
│  │ capture-helper (Swift, 화면 캡처/제어)     │ │
│  │ llama-server (온디맨드 로컬 LLM)           │ │
│  └─────────────────────────────────────────┘ │
│  ┌─ tor sidecar ──────┐ ┌─ embedded sshd ──┐│
│  │ HSPort 80 → 7778    │ │ Listen :22022     ││
│  │ HSPort 22 → 22022   │ │ Pubkey only       ││
│  │ v3 client-auth      │ │ PermitOpen 7777   ││
│  │ single-hop          │ │ +preview proxy    ││
│  └─────────────────────┘ │ ForceCommand false││
│  ┌─ NAT 매핑 (best-effort)┐└──────────────────┘│
│  │ UPnP IGD / NAT-PMP    │                     │
│  │ 외부 IPv4 echo + IPv6  │                     │
│  └────────────────────────┘                    │
└──────────────────────┬──────────────────────────┘
                       │
        ┌──────────────┼──────────────┐
        │ 직접 SSH      │ Tor onion    │
        │ inbound (IPv6 │ (모든 환경    │
        │  /IPv4 UPnP)  │  fallback)   │
        ▼              ▼
┌────────────────────────────────────┐
│ Tor Network (분산 자원봉사 relay)   │
└────────────┬───────────────────────┘
             ▲ outbound
             │
┌────────────┴────────────────────────┐
│             iPhone                   │
│                                      │
│  PocketSisyphus.app (3탭: 백로그/세션/자동화) │
│  ┌─ DeviceAttestor / AttestSession ┐  │
│  │ Secure Enclave P-256 + Face ID  │  │
│  │ 기기 인증 (challenge-response)    │  │
│  └─────────────────────────────────┘  │
│  ┌─ TorManager (in-process) ──────┐   │
│  │ Tor.framework + obfs4 bridge    │   │
│  │ lazy 시작 + §2.4 stop 시퀀스    │   │
│  └─────────────────────────────────┘   │
│  ┌─ EndpointCache (Keychain) ─────┐    │
│  ┌─ SSHClient (Citadel) + host key│    │
│  │  TOFU/strict-pin 검증           │    │
│  └─────────────────────────────────┘    │
│  ┌─ ConnectionManager (happy eyeballs)┐ │
│  └─────────────────────────────────────┘ │
└──────────────────────────────────────┘
```

### Core Principles
- **NEPacketTunnelProvider extension removed**. Does not meet the Apple Guideline 5.4 trigger conditions (VPN-app classification).
- **The data plane is SSH**. In environments where direct SSH reaches, latency is 10–50 ms (10–50× faster than the Tor data plane's 200–800 ms).
- **Tor is the endpoint-discovery + SSH-fallback channel**. Lazily started/stopped within the main app process. Stopped immediately once direct SSH is adopted. In DPI-blocked environments it is circumvented via an obfs4 bridge (§2.6).
- **"Same-Wi‑Fi-only (LAN-only)" mode (opt-in, fail-closed)**. When enabled, the phone↔Mac do direct SSH to private/link-local·mDNS addresses «only when on the same LAN», skipping and refusing Tor discovery, public IP, and onion fallback entirely (off-LAN means an explicit block, `.offLanBlocked`). On first launch you choose the connection method (Anywhere (Tor) / Same-Wi‑Fi-only); in LAN-only mode the Tor bootstrap itself is not started (§2.6). On the daemon side, the same flag blocks non-LAN outbound (egress confinement, THREAT_MODEL §5.11).
- **No background runtime whatsoever**. APNs/BGAppRefreshTask/BGProcessingTask are permanently unimplemented. Every connection is re-established from scratch on foreground entry. Real-time notifications are delegated to a Discord webhook (§12.6).
- **Zero operational infrastructure**. Uses only «someone else's infrastructure» — the Tor distributed network + public-IP echo (ipify, etc.) + (optionally) Discord/GitHub Pages. Zero maintainer servers.
- **Triple cryptographic identity guarantee**. ① onion v3 address (Ed25519 hash) + ② SSH host key fingerprint (pairing-QR pin + TOFU ledger) + ③ Secure Enclave device attestation (App Attest, §2.9).

## 2. Component Spec (Transport & Security)

### 2.1 Mac daemon (Node)

| Listener | Port | Purpose |
|---|---|---|
| Hono API | `127.0.0.1:7777` | `/api/*` + `/ws` — accessible only through the SSH channel |
| Endpoint listener | `127.0.0.1:7778` | the single `/endpoint` route — accessible only via Tor onion |
| sshd | `0.0.0.0:22022` + `[::]:22022` | OpenSSH portable. direct-tcpip → `127.0.0.1:7777` |
| preview proxy | `127.0.0.1:<fixed>` | reverse proxy for the dev server (§13.1). Added statically to PermitOpen |

- **PTY runner**: every session spawns the code-agent CLI via `node-pty`. The WS streams raw ANSI chunks + question/exit events. `writePtyRaw(sessionId, Buffer)` passes the iOS `pty_input` WS message straight through with no byte processing — no Korean multi-byte corruption. Adapters are registered as 5 kinds (claude_code / agy / codex / shell / local_llm) (§12.1).
- **Cold-entry pagination / screen snapshot** (`session_history_v1` / `pty_snapshot_v1`): PTY output accumulates indefinitely as 15 ms-coalesced `pty_chunk`s, so when a cold-entry poll downloaded the whole thing with no LIMIT, a long session took ~5 s to load over Tor. Resolved in two steps — ① `GET /:id/poll?limit=N` caps the cold tail + `GET /:id/messages` for reverse history via composite keyset `(created_at,id)` (increments still use `afterCreatedAt`). ② `GET /:id/pty/snapshot` — on request, the recent tail is replayed through a headless VT (`@xterm/headless`+`addon-serialize`) to serialize «the current screen + scrollback» into one chunk → cost goes from O(total chunk bytes) → O(screen). A watermark (`throughCreatedAt`) lets the client stitch only what follows incrementally (no double render). `pty_chunk` is compacted by `prunePtyChunks` (every 512 onFlush calls, keeping the latest 8000) — its retain is larger than every reader window (snapshot 4000 / cold 600 / catch-up 1000) so there is no loss. An old daemon ignores limit (returns everything)·snapshot 404 → iOS works without regression via the tail cap/fallback. Cold WS catch-up is skipped because `since=0`, so the cold full-history path is poll alone. (`@xterm` is CJS — a named import breaks under the tsx runtime, so it is taken via a default import.)
- **`/endpoint` route** (`routes/endpoint.ts`): a priority-ordered endpoint array (`direct_ipv6` p1 / `direct_ipv4` p2 / `tor_onion` p99) + SSH host key fingerprint + ssh_user + daemon_local_port + ttl 300s. iOS adopts via happy eyeballs.
- **Automatic NAT mapping**: attempts UPnP IGD / NAT-PMP via `nat-api`. External IPv4 echo (`ipify`/`ifconfig.me`/`icanhazip` fallback + 5-minute cache). If a global IPv6 exists, it is priority 1 without mapping.
- **App Attest gate**: the `requireAttestation` middleware protects `/api/*`. The WS is also verified via the `?attest=` query (§2.9).
- **Application·result·PO plane modules**: multi-agent / workflow DAG / scheduling (cron) / local LLM / live preview / screen capture·control / Discord notifications / PO loop — all hosted by the same daemon and soft-gated by `/api/version` capability. Details in §12–§14.

### 2.2 Mac embedded sshd

`scripts/embed-daemon-binaries.sh` embeds the Homebrew OpenSSH portable binary + dependent dylibs (`libcrypto`, `libssl`) into `.app/Contents/Resources/daemon/bin/` at build time. Relative paths are rewritten to `@executable_path/libs/` with dylibbundler.

**OpenSSH 9.8+ multiprocess model**: not `sshd` alone — the re-exec helpers `sshd-session` + `sshd-auth` are embedded together (each connection spawns a privilege-separated process). Without these two, the newer sshd cannot boot.

**sshd_config whitelist** (generated dynamically by `mac/daemon/src/ssh/server.ts`):
```
HostKey "<영구 ed25519 host key>"
AuthorizedKeysFile "<authorized_keys 동적 관리>"
PasswordAuthentication no
PubkeyAuthentication yes
AllowTcpForwarding local
PermitOpen 127.0.0.1:7777 127.0.0.1:<previewProxyPort>   # direct-tcpip 목적지 화이트리스트
AllowAgentForwarding no
X11Forwarding no
PermitTTY no
ForceCommand /bin/false        # session channel exec/shell 거부
# Subsystem 일체 미등록 (sftp 차단)
```

Only `direct-tcpip` is let through, exposing only the daemon HTTP/WS port (+ the live-preview fixed proxy port). Rather than dynamically reloading per dev port, the strict whitelist is maintained by **statically adding just the single fixed-proxy-port line** (§13.1). One pairing = a new ed25519 client keypair issued; the priv is delivered to the phone via QR, and the pub is added as an `authorized_keys` line (identified for revocation by the `pocket-device:<id>` comment).

### 2.3 Mac Tor Integration — Dual HiddenServicePort

```
HiddenServiceNonAnonymousMode 1
HiddenServiceSingleHopMode 1
HiddenServiceDir <hs>
HiddenServicePort 80 127.0.0.1:7778    # endpoint 조회용
HiddenServicePort 22 127.0.0.1:22022   # SSH fallback 채널 — sshd 와 같은 daemon
LongLivedPorts 80,22
MaxCircuitDirtiness 3600               # 회로 1시간 유지
HiddenServiceNumIntroductionPoints 5   # IP 변경 복구 (기본 3)
NumEntryGuards 3
KeepalivePeriod 60
```

Two virtual ports are exposed under the same onion address. v3 client-auth (x25519) restricts descriptor decryption — even if the onion address leaks, only the phone can build a circuit. Circuit-stability tuning (more introduction points·keepalive) shortens the reconnect time after an IP change/idle.

### 2.4 iOS TorManager (in-process)

Tor.framework is operated directly **within the main app process**. NEPacketTunnelProvider is removed.

iCepa Tor.framework's `TORThread` assumes a single start per process. For a clean restart, the stop sequence is followed without omission:

1. `SIGNAL HALT`
2. `controller.disconnect()` + nil
3. `torThread.cancel()` + nil
4. remove the `<dataDir>/lock` file
5. `waitForPortRelease(socksPort)` — wait for TIME_WAIT to clear

**3-layer safety net**: ① stop on background entry (within `beginBackgroundTask` 30 s), ② stale-state cleanup just before `start()`, ③ on forced termination, a fresh process resolves it naturally.

Tor is active **only when looking up the endpoint + when SSH-over-Tor fallback is adopted**. After direct SSH is adopted, `stopAsync()` is called → memory savings.

### 2.5 iOS SSHClient (Citadel) + Host Key Verification

Based on Citadel (a swift-nio-ssh wrapper). NMSSH's vendored libcrypto.a has an alignment clash with the Xcode 26 + arm64-sim linker, so it is avoided.

- SSH session via `Citadel.SSHClient.connect(...)`. Authentication: ed25519 priv (pairing-QR PKCS8 PEM base64).
- **Host key verification (implemented — `SSHHostKeyTOFU.swift` `TOFUHostKeyValidator`)**: every SSH channel is verified with a 3-level priority on top of the standard NIOSSH fingerprint API.
  1. **Pinned key** — if `cfg.sshHostKey` (a single public-key line, the QR's `ssh_host_key` field) is present, an exact-match pin (strongest).
  2. **Trusted fingerprint** — strict comparison against the `ssh_host_key_fingerprint` given by the pairing QR / onion `/endpoint`.
  3. **Pure TOFU** — only when there is no anchor at all, compare/record against `KnownHostStore` (onion address→fingerprint, Keychain ledger).
  A mismatch is refused with `SSHError.hostKeyMismatch` to block daemon impersonation (MITM) on a hostile LAN/Wi-Fi. The onion channel passes harmlessly since Tor already guarantees identity and shares the same host key.
- **Local TCP forwarding**: brings up an `NWListener` (`127.0.0.1:<dynamic>`) and calls `createDirectTCPIPChannel` for each incoming TCP. `NWConnectionBridge` (a ChannelInboundHandler) copies ByteBuffer bidirectionally. Live preview does a secondary forward to the proxy port (`openForward`).

### 2.6 iOS ConnectionManager + Tor bridge

**happy eyeballs**:
```
1. EndpointCache 있으면 endpoint 배열을 priority 순으로 SSH 동시 시도.
   - 직접 IPv6 / IPv4 → 빠른 SSH (10~50ms)
   - Tor onion → SSH-over-Tor (200~800ms)
2. 첫 성공 채택, 나머지 cancel. 직접 채널 채택 시 Tor stop.
3. 모두 실패 → Tor 부팅 → /endpoint 갱신 → 재시도.
```
- `connect()` is idempotent (`.running` early return + inflight dedup), `reconnect()` is the transport-failure recovery path.

**Tor bridge / pluggable transport (obfs4)** — for environments where DPI blocks plaintext Tor.
- `TorBridgeStore` parses·persists user-entered bridge lines (obfs4/vanilla). iOS Settings → "Tor bridge" (`TorBridgeView`).
- Since iOS blocks executing a separate binary for the obfs4 PT, it runs via `IPtProxy` (in-process gomobile lyrebird, `PluggableTransport.swift`) and connects to Tor with `ClientTransportPlugin obfs4 socks5 127.0.0.1:<port>`.
- **Plaintext first, retry via bridge only on failure** — no behavior regression for users who have not configured it.

**"Same-Wi‑Fi-only (LAN-only)" mode** (`LanOnlyPolicy` / `ConnectionModePolicy` / `connectLanOnly`) — direct private-network connection·fail-closed.
- **Connection-method choice**: while `ConnectionModePolicy.modeChosen` is false, `AppRoot` shows `ConnectionModeView` «before» the Tor bootstrap to make you pick one of "Anywhere (Tor)" / "Same-Wi‑Fi-only" (common before/after pairing). While unchosen, the launch `.task` does not start Tor. Once chosen, `modeChosen` becomes true → connection starts via re-running `.task(id:)`.
- **LAN-only path**: when enabled, `ConnectionManager.connectImpl` branches to `connectLanOnly` — after `tor.stopAsync()`, SSH to «only» the pairing QR's `lan_host` (mDNS `<host>.local`) ∪ cached `direct_lan` candidates. Host key verification (TOFU/pin) is applied identically to the direct channel to refuse MITM on a hostile LAN.
- **Cold bootstrap**: with just the QR's `lan_host`/`ssh_port`, LAN pairing happens immediately even in an unpaired state without Tor·`/endpoint` → pairing is possible even on a network where Tor is blocked (even when unpaired, `AppRoot` goes straight to `PairView`).
- **fail-closed**: if there is no LAN candidate to adopt or all fail, it does not fall back to public/onion but explicitly blocks with `.offLanBlocked` — guaranteeing packets never leave the private network. The pure policy (candidate filtering·Tor skip·fail-closed) is split out host-less into `LanOnlyPolicy` and pinned by `LanOnlyPolicyTests`.
- daemon-side counterpart: the same `config.lanOnly` blocks «non-LAN outbound» (public-IP echo·UPnP·ASC·Discord) via the single `egress.ts` gate (egress confinement, THREAT_MODEL §5.11).

### 2.7 iOS ApiClient / WSClient

- base URL: `http://127.0.0.1:<ConnectionManager.currentLocalPort>` (HTTP) / `ws://127.0.0.1:<localPort>/ws`
- Bearer: `cfg.daemonToken`. Additionally, every request carries an `X-Client-Version` header (server enforces 426, §11) + attest token (§2.9).
- transport failure 1st → `conn.reconnect()` → retry. 2nd failure → markUnrecoverable.
- **WS channel**:
  - inbound: `pty_chunk` (PTY raw ANSI), `question`/`exit` events, `screen_frame` (JPEG)/H.264 binary frames, workflow/cron/PO events.
  - outbound: `pty_input` (base64 byte), `pty_resize`, `subscribe` (since= for §catchup), screen `input_event`/`capture_*`.
  - ping/pong: 30 s cycle. The pong RTT is reflected into `ConnectionManager.recordRTT` as an EMA (α=0.4) → "connection status" display.
  - **catch-up (`ws_catchup_v1`)**: on reconnect, `subscribe { since }` backfills the missed `pty_chunk`s in one RTT — no waiting for the poll cycle.

### 2.8 Pairing QR (v=3)

```json
{
  "v": 3,
  "onion": "<fp>.onion",
  "onion_auth": "<x25519 priv base32>",
  "endpoint_token": "...",
  "daemon_token": "...",
  "ssh_host_key_fingerprint": "SHA256:...",
  "ssh_host_key": "ssh-ed25519 AAAA... (선택 — 있으면 strict pin)",
  "ssh_client_priv": "<ed25519 PKCS8 PEM, base64>",
  "ssh_user": "<macOS 현재 user>",
  "name": "Wayne's Mac",
  "lan_host": "<mDNS hostname, 예: Waynes-Mac.local> (선택 — LAN 전용 콜드 부트스트랩)",
  "ssh_port": 22022,
  "daemon_port": 7777
}
```

iOS rejects payloads below v=3 → prompts "Re-pair after updating the Mac app." `ssh_host_key` (a single public-key line) is an optional field added later; when present it is used as the level-1 strict pin in §2.5 (optional for backward compatibility). `lan_host`/`ssh_port`/`daemon_port` are also optional fields, used by "Same-Wi‑Fi-only" mode to do LAN direct-connect pairing with a single QR without Tor·`/endpoint` (§2.6).

### 2.9 App Attest — Secure Enclave Device Attestation (new)

With the pairing token alone, «anyone who gets hold of the token» can attach to the daemon. On top of it, one more layer of **hardware-bound device attestation** is added.

- **iOS (`DeviceAttestor` / `AttestSession`)**: generates a Secure Enclave P-256 keypair (preserved in the Keychain even after reinstall). At pairing, registers the public key (X9.63 uncompressed) + self-signature via `/api/attest/register`. Thereafter `/api/attest/challenge` → sign the nonce with the SE key → receive a short-lived attest token (HMAC, ~24h) via `/api/attest/verify`. Face ID/Touch ID biometric gate (`LAContext` reuse makes registration+verification a single prompt).
- **daemon (`attest.ts` / `routes/attest.ts`)**: issues a nonce (60s TTL·single use) → verifies the signature with the registered public key → issues an HMAC token. `BOOT_HMAC_SECRET` is generated once at boot → all attest tokens are invalidated on daemon restart. The public key is TOFU per pairing (`fingerprintForPublicKey` = `SHA256:` format, same as iOS).
- **Multiple device slots**: default 1, up to 2 as a user option. `config.ts` normalizes the legacy single field into an array.
- **Gate policy**: unregistered (old daemon/old phone) passes soft (zero regression), and the local operator (`X-PS-Local` + `localAdminSecret`) also passes. A registered device is blocked without an attest token → iOS prompts biometric authentication via `LockView`.
- The iOS "Security Status" (`SecurityStatusView`)·"Devices" (`DevicesView`) screens show registration status·channel·host key grade·the list of registered devices in human-readable form.

## 3. Traffic Flow

### Normal (direct SSH adopted)

```
iPhone — 콜드 부팅:
  1) TorManager.startIfNeeded → bootstrap → .running
  2) ConnectionManager.connect — 캐시 endpoint 없음 → /endpoint 조회
  3) Tor 위에서 GET http://<onion>/endpoint
     Response: [direct_ipv6, direct_ipv4, tor_onion] + host key fp + daemon_local_port
  4) Happy eyeballs SSH 시도 — direct_ipv6 채택, host key 3단계 검증 통과
  5) NWListener 127.0.0.1:52073 띄움
  6) Tor stopAsync (직접 채택 → idle)

iPhone 사용 중:
  ApiClient: GET http://127.0.0.1:52073/api/sessions (Bearer + X-Client-Version + attest)
     ↓ NWConnection inbound → NWListener
  Citadel SSHClient.createDirectTCPIPChannel("127.0.0.1", 7777)
     ↓ NWConnectionBridge: ByteBuffer ↔ NWConnection
  SSH transport (TCP outbound, 직접 IPv6/IPv4)
     ↓ Mac sshd (22022) — direct-tcpip channel
  daemon 127.0.0.1:7777 — Hono /api/sessions (Bearer + attest 검증 + 응답)
     ↓ 역경로
```

### Fallback (CGNAT / UPnP-blocked environment)
Both direct_ipv6/ipv4 connect-timeout → tor_onion adopted. All inbound flows over the Tor SOCKS proxy via direct-tcpip. Tor stays up. A banner at the top of ChatView informs "Communicating over a Tor circuit (slow)." If DPI also blocks plaintext Tor, see §2.6 obfs4 bridge.

### LAN-only (Same-Wi‑Fi-only mode)
```
iPhone — 콜드 부팅 (modeChosen=false):
  1) AppRoot 가 Tor 시작 전에 ConnectionModeView 표시 → 「같은 Wi‑Fi 전용」 선택
     → LanOnlyPolicy ON, modeChosen=true (launch .task 재실행 — Tor 부트스트랩 skip)
  2) ConnectionManager.connectLanOnly:
     - tor.stopAsync()
     - 후보 = QR lan_host(<host>.local) ∪ 캐시 direct_lan  (공인/onion 제외)
     - 같은 LAN 이면 사설 주소로 직접 SSH (host key 검증 동일)
  3) 채택 실패/오프-LAN → .offLanBlocked 로 fail-closed (외부 폴백 금지)
```
Even when unpaired, choosing "Same-Wi‑Fi-only" at step 1) makes AppRoot go straight to PairView and pair over LAN without Tor using the QR's lan_host/ssh_port (§2.6). In the same mode the daemon blocks non-LAN outbound (§5.11).

### IP-change recovery
SSH keepalive failure → `ApiClient.send` transport failure → `reconnect()` cache retry (old IP fails) → Tor boot → `/endpoint` new IP → SSH re-adopted. From the user's view, a 1–5 s freeze followed by automatic recovery. When the Mac `NetworkChangeMonitor` detects an IP change, it SIGHUPs the daemon.

## 4. Security Model

| Threat | Mitigation |
|---|---|
| ISP/carrier eavesdropping | SSH (forward secrecy, ECDHE) or Tor onion (3-hop encryption) |
| Fake daemon impersonation | `.onion` address = Ed25519 public-key hash. SSH host key 3-level verification (pin/fingerprint/TOFU, §2.5) |
| MITM (hostile LAN/Wi-Fi) | On SSH host key mismatch, refuse with `hostKeyMismatch`. onion v3 cryptographic identity |
| Token leak (QR/Bearer) | **Hardware-bound device attestation** (App Attest, §2.9) — the token alone is not enough; a signature from the registered Secure Enclave key is required |
| Lost phone | Biometric lock (`LockView`). Revoke that device in the Mac "Devices" window. Rotate everything at once via the menu's «Change pairing values» |
| `.onion` address leak | Without the v3 client-auth (x25519) priv, no one can decrypt the descriptor |
| SSH brute-force | Only direct-tcpip allowed, exec/shell/sftp refused, password auth off |
| External inbound blocked (CGNAT) | Tor onion fallback. If Tor itself is DPI-blocked, obfs4 bridge (§2.6) |
| Non-LAN outbound leak (corporate security requirement) | **"Same-Wi‑Fi-only" mode** (opt-in) — the client connects directly to private addresses only·fail-closed (`connectLanOnly`/`.offLanBlocked`), and the daemon blocks non-LAN outbound at a single gate (`egress.ts`). No Tor·public IP·onion used (§2.6, THREAT_MODEL §5.11) |
| Tampered DMG (update) | Sparkle EdDSA signature verification — even a silent install has the core refuse a forgery (§11) |

### Unpairing (revoke)
`/api/admin/rotate-pairing` in `routes/admin.ts`: ① issues a new daemon Bearer, ② drops live WS, ③ rotates the Tor onion key + client-auth key (new .onion), ④ issues a new SSH client keypair + updates `authorized_keys`, ⑤ resets attest registration, ⑥ generates a new QR PNG. The old pairing is invalidated immediately. Individual revocation of a specific device slot from the "Devices" window is also possible.

## 5. iOS App Design

### 5.1 Stack
- Swift 5.10, SwiftUI, deployment target **iOS 17.0+**. Single app target, no extensions.
- Dependencies:
  - `Tor.framework` (CocoaPods, iCepa) — in-process
  - `IPtProxy` (CocoaPods, obfs4pt) — Tor bridge pluggable transport
  - `Citadel` (SwiftPM, swift-nio-ssh) — SSH client (NMSSH removed)
  - `SwiftTerm` (SwiftPM) — PTY ANSI rendering
  - `Runestone` + TreeSitter — code/diff highlighting
  - `WhisperKit` (SwiftPM) — on-device speech→text (§5.6)
  - `PencilKit` — capture markup (§13.5)
- Storage: Keychain (pairing + SE device key + host key ledger). No App Group.

### 5.2 Screens — 3-Tab Main
The main has evolved into the **3 tabs** of `MainTabView` (previously the 2-tab "Sessions + Workflows"). Each tab has its own NavigationStack.

1. **Backlog tab** (`BacklogTab` / `BacklogView`) — «tab 1». The PO loop (§14). `po_loop_v1` + pro (`.poLoop`) gate. Hidden on an unsupported daemon.
2. **Sessions tab** (`SessionsView`) — always shown (free). Session list + new-session sheet (dynamic agent picker) + settings/help. Sessions created by workflow/cron/PO also gather here, separated by filter. Pulls daemon capabilities on reload to decide the visibility of the other tabs.
3. **Automation tab** (`AutomationTab`) — shown if either `workflow_v1` or `cron_v1` is present. Inside, grouped into "Workflows | Schedule" segments, showing only the supported segment. Pro (`.workflow`) gate. Opening a node/scheduled-run session switches to the Sessions tab via deepLink.

App entry flow (`AppRoot`):
```
연결 방식 미선택(modeChosen=false, 비-DevPairing) → ConnectionModeView  ← Tor 부트스트랩 «전» 게이트
  · 「어디서나(Tor)」 선택 → lanOnly=false → 아래 흐름(Tor)
  · 「같은 Wi‑Fi 전용」 선택 → lanOnly=true → Tor skip, LAN 직결(§2.6/§3)
페어 안 됨 → (LAN 전용이면) PairView 직행 / (어디서나) Tor 상태로 BootView / PairView(QR v=3)
페어 됨   → attest 진행 / 호환성 hard-block 이면 IncompatibleView
          → ConnectionManager.running:
              · attest.needsAuthGate → LockView (생체 인증)
              · 아니면 MainTabView
          → connecting/idle → BootView, failed → ErrorView
```
The connection method is the gate of the launch `.task(id: modeChosen)`, so before you pick, no onion circuit is built at all (user requirement: «ask before going through Tor»). Afterward you can switch freely via the LAN-only toggle in Settings → "Connection & Security." **Tab color**: only the Backlog·Automation «tab buttons» are pro orange (alwaysOriginal); buttons inside the tab content keep the default accent (purple) — adhering to the "Color Token Policy" (§12.7).

### 5.3 Chat Input Path — Branching by Keyboard Language (retained)
When the Korean IME passes through SwiftTerm's `UITextInput`, the screen corrupts due to a byte cycle. So the path branches in two by the active keyboard language:
- **English (ASCII)** — `InteractiveTerminalView` (a SwiftTerm subclass) as first responder, sending 1:1 bytes to `WSClient.sendPtyInput` immediately on each keystroke. inputBar hidden.
- **Korean/CJK** — SwiftUI `TextField` (inputBar) as first responder, absorbing IME markedText then accumulating completed syllables → on "Send," sends `text + "\r"` all at once. SwiftTerm is render-only.

Auto-detect the mode (`UITextInputMode.currentInputModeDidChangeNotification` + `primaryLanguage` inspection), auto-swap the first responder, an ASCII byte filter on the `send` delegate, and auto-focus SwiftTerm when a virtual arrow is pressed.

#### Input Byte Tracing (KS-TRACE) + Per-Agent CJK Input Reproduction Recipe
There is no per-agent branching in the input path — `writePtyRaw(sessionId, Buffer)` treats all adapters identically and streams bytes to the PTY with no processing. So a CJK/IME input regression in one adapter (e.g. Korean corruption when adding Copilot) can recur in the «next agent» too. The diagnostic that catches this by comparing both ends is **KS-TRACE**.

- **Enabling (default OFF, zero production impact)** — daemon: start the daemon with `PS_KS_TRACE=1` env. iOS: `PS_KS_TRACE=1` env (Xcode scheme/`simctl launch SIMCTL_CHILD_PS_KS_TRACE`) or the `UserDefaults` key `PS_KS_TRACE=true` (without rebuilding).
- **Same format (send=iOS / recv=daemon)** — `KSTrace.swift` (iOS) and `pty-runner.ts` (daemon) are 1:1:
  ```
  [KS-TRACE] send session=<id> agent=<id> bytes=<n> hex=[xx xx …]   (iOS  sendPtyInput)
  [KS-TRACE] recv session=<id> agent=<id> bytes=<n> hex=[xx xx …]   (daemon writePtyRaw)
  ```
  hex is up to 64 B (excess `+Nmore`). If the daemon sanitize dropped a term-query response, the recv ends with `(dropped NB term-response)`. The WS-arrival moment (before sanitize) is seen separately via the server's `[KS-TRACE] ws-recv`.
- **Comparison** — iOS: `idevicesyslog | grep KS-TRACE` (or the simulator console). daemon: `grep KS-TRACE` in `~/.../logs/unified.log`. If the same `session`·`bytes`·`hex` pair up as `send`→`recv`, it is normal. If a byte is transformed (e.g. `e5 88 9c` → `c3 a5 c2 88 c2 9c` double-encoding)·lost, that span is the culprit.

**Reproduction recipe (same procedure in any agent session)** — turn `PS_KS_TRACE` on at both ends, and in the target agent (claude_code / agy / codex / copilot / opencode / local_llm / shell) session, type→send the following in order on the Korean IME keyboard:
1. **1 syllable** — `가` → send. Whether `가` is reflected·submitted as-is in the input box, and whether the `send`/`recv` hex matches UTF-8 3B (`ea b0 80`).
2. **Multiple syllables** — `안녕하세요` → send. Whether the syllables are submitted combined (no jamo splitting·duplication).
3. **Emoji** — `안녕👋` → send. Whether the surrogate/4B UTF-8 (`f0 9f 91 8b`) flows without corruption.
4. **Including a line break** — type the body then Enter (`0d`) → submit one turn. Whether `0d` reaches recv and a turn begins.
At each step, confirm both (a) input-box reflection·submission and (b) `send`↔`recv` byte matching. Reproducing the same recipe before/after the Copilot fix (brief 1) reveals the difference in hex.

### 5.4 ChatView Status Bar·Toolbar
- **Status bar**: git branch chip (`session_git_branch_v1`) + changed-N chip→Diff sheet (`session_git_status_v1`) + token balance (`agent_usage_v1`). Virtual arrows/Space/Enter/terminate.
- **Toolbar buttons** (top-right·tools group):
  - Live preview (`preview_v1`/`v2`, pro `.preview`) → `PreviewView` sheet (§13.1).
  - Monitor mirroring (`screen_capture_v1`, pro `.monitorMirror`) → `MonitorMirrorView` fullscreen (§13.3).
  - "Advanced tools" chip (pro `.chatTools`, orange): branch/worktree·file explorer·diff·image attach·session notification mute, etc.
  - Voice-input mic (§5.6).
- **Attachments**: photo-library images (per-image requirements)·file/line references·mirroring captures/recordings·screen feedback (markup) are gathered into «pending send» and sent (§13.5).
- **The old «Results» unified sheet is abolished** — web preview / mirror / artifacts are split into their own entry points (the mirror is the session-agnostic synthetic id `__desktop__`).

### 5.5 Voice Input (WhisperKit, new)
`WhisperSpeechRecognizer` (app-global singleton, model loaded once) + reusable components (`VoiceDictation.swift`: `DictationMicButton` / `VoiceInputField` / `.voiceDictationChrome()`). On-device processing — voice never leaves the device, only the model weights are downloaded·cached once. All languages including Korean.

### 5.6 Background Policy (retained)
- Background entry → close all connections (SSH + Tor stop). Foreground return → reconnect from scratch.
- **APNs / BGAppRefreshTask / BGProcessingTask permanently unimplemented**. Real-time notifications are delegated to a Discord webhook (§12.6).
- `AppLifecycle`: cold launch/short background under 60 s is silent; a long trip of 60 s or more triggers `longTripReawake()` for each view to do a targeted refresh (NavigationStack/input preserved).

### 5.7 Monetization — Pro (Orange) Feature Gating + Subscription/Lifetime IAP (full overhaul)
**The full-screen forced paywall has been abolished** (a premium pivot). The base app is free; it is gated by ownership **«only when tapping an orange (Theme.pro) feature»**.

- **3 products** (`ProductCatalog` SSOT): monthly sub `…sub.monthly` (₩5,000) · yearly sub `…sub.yearly` (₩50,000) · lifetime `…lifetime` (₩250,000, non-consumable). Subscriptions have a 7-day free introductory offer (once per `pocketsisyphus.pro` group).
- **`ProFeature` registry** (single source of truth): `workflow / poLoop / cron / monitorMirror / terminal / localLLM / worktree / chatTools / preview`. A pro feature must be tagged with this case and go through `PurchaseStore.gate(_:_:_:)` / `isUnlocked(_:)` — the entry point requires the type, preventing a missed gate (a free-exposure regression). 1:1 with the color policy's «orange=pro».
- **`EntitlementDecision.iapEnabled`** master switch: when false, all pro features open free + StoreKit fetch skipped (the free-release stage). true after ASC approval.
- `EntitlementDecision`/`ProductCatalog` pin ids·decisions with host-less XCTest.

## 6. Mac App Design

### 6.1 Stack
- Swift 5.10 + SwiftUI, deployment target macOS 13.0+. MenuBarExtra (LSUIElement, no Dock icon).
- Sandbox disabled (`ENABLE_APP_SANDBOX: NO` — §10). Hardened runtime + NodeRuntime entitlements (`cs.allow-jit`/`cs.allow-unsigned-executable-memory`/`cs.disable-library-validation`).

### 6.2 Menu Bar + Windows
- **Menu-bar icon** (`StatusIcon`): shows daemon state (stopped/starting/running/failed) as a dot. Shows a blue download indicator during a silent update.
- **Menu statusBlock**: Onion address / SSH direct (UPnP mapping result) / SSH onion channel status. On UPnP failure, a "Port-forwarding guide" (opens the router page) + a silent-update progress banner.
- **Settings window** (`SettingsWindow`, 8 tabs unified): Local LLM · Discord notifications · App Store auth (ASC) · SSH port · Power · Permissions · Devices · Language.
- **QR window** — generate/show/copy pairing v=3 + rotate.
- **Terminal mirror window** — real-time mirror of the daemon WS `pty_output` (SwiftTerm) — the same screen as the phone.
- **Workflow window** (`WorkflowWindow`) — DAG canvas editing/execution (equivalent to iOS, §12.5).
- Sparkle in-app updates (§11).

### 6.3 Permissions·Power Management (newly stated)
- **Screen Recording TCC** (`RemoteControlPermissions`): `CGPreflight/RequestScreenCaptureAccess` + a real capture-helper functional test (`__PS_SCREENPERM__`). Since the capture-helper's responsible process is this app, the helper works once the app is granted (§13.3).
- **Accessibility TCC**: `AXIsProcessTrusted(WithOptions)` — for the capture-helper's `CGEvent` input injection (remote control). «Viewing» is automatic; «input injection» only when explicitly approved per session via `control_set`.
- **Full Disk Access (FDA, `FullDiskAccess`)**: a TCC.db-access heuristic + a settings link. Even with the sandbox disabled, when the daemon touches TCC-protected paths like Documents/Desktop/iCloud it prompts every time → grant in bulk with FDA.
- **Power (`PowerManager`)**: sleep prevention (`IOPMAssertion`, no permission needed) + clamshell mode (`pmset disablesleep`, requires root → osascript admin). While clamshell is on, the whole system stays awake → UI warning.
- The daemon stdout's `__PS_PERMISSION_REQUEST__ screen|accessibility` marker → auto-open·highlight the Permissions tab (15 s throttle).

## 7. Implementation Phases (historical record)

| Phase | Content | Status |
|---|---|---|
| P1~P7 | Mac daemon (sshd/Tor dual/`/endpoint`) + iOS in-process Tor + Citadel direct-tcpip + extension removal + Mac UI + ASC resubmission | ✅ |
| P8 | PTY real-time keystroke (WS `pty_input` + per-keyboard-language branching) | ✅ |
| P9 | Multi-agent (adapter registry + `/api/agents`, `multi_agent_v1`) | ✅ |
| P10 | Scheduled jobs (croner session cron + workflow cron trigger, `cron_v1`) | ✅ |
| P11 | Workflows (DAG engine + node=session + result.md + iOS/Mac canvas, `workflow_v1`) | ✅ |
| P12 | Local LLM (llama-server on-demand supervisor + Qwen Code, `local_llm_lifecycle_v1`) | ✅ |
| P13 | Result plane (preview/artifacts/screen capture·control, §13) | ✅ |
| P14 | SSH host key strict pin + TOFU ledger (§2.5) | ✅ |
| P15 | App Attest — Secure Enclave device attestation (§2.9) | ✅ |
| P16 | H.264 screen relay + system audio + window-scoped capture (§13.3, `screen_h264_v1`/`screen_window_target_v1`) | ✅ |
| P17 | Live preview v2 — multi-port + absolute-URL rewrite (§13.1, `preview_v2`) | ✅ |
| P18 | Discord notifications + session mute (§12.6, `notify_discord_v1`/`session_notify_mute_v1`) | ✅ |
| P19 | Token usage tracking + desktop session import + git status/diff (§12.1, `agent_usage_v1`/`recent_projects_v1`/`session_git_*`) | ✅ |
| P20 | cron terminal — shell-script scheduling (§12.5, `cron_terminal_v1`) | ✅ |
| P21 | Silent forced update (§11, `silent_update_v1`) | ✅ |
| P22 | Tor bridge / obfs4 (§2.6, `tor_bridge_v1`) | ✅ |
| P23 | Voice input (WhisperKit, §5.5) | ✅ |
| P24 | Monetization overhaul — pro feature gating + subscription/lifetime (§5.7) | ✅ |
| P25 | bulk session actions — group bulk approve/stop (`bulk_session_actions_v1`) | ✅ |
| P26 | **PO loop** — opportunity-brief backlog (§14, `po_*_v1` family) | ✅ |

## 8. Known Risks / Verification
1. **CGNAT + Tor DPI blocking**: circumvented via obfs4 bridge (`tor_bridge_v1`) when plaintext fails. *Remaining limits: going via a bridge has high latency so live preview/mirror can get choppy; the built-in default bridge set (`TorBridgeStore.builtInObfs4Bridges`) rotates so it needs maintainer updates; BridgeDB auto-distribution·HTTPS termination·a Mac-side bridge are non-goals.*
2. **Citadel maintained by one person**: since it is swift-nio-ssh-based, NIO is proven, but Citadel's own bugs may need us to fix them directly.
3. **PTY-mode limits**: tool calls flow inside ANSI. Interactive-prompt detection is heuristic (`agent/pty-*`). Waits missed by the 12 s idle estimate as a false-negative (a prompt is up but output blinks within every 12 s so it is never caught as «waiting») are reinforced by a **human-in-the-loop safety device**: the daemon exposes the per-session «basis for the wait estimate» (idle since last output·fired reminder stage) to the phone (`getPtyAttention`), iOS surfaces it as «quiet for N minutes», and when the user subscribes a session to "notify on next stop" (`setNotifyNextStop`, `POST /api/sessions/:id/notify-next-stop`) that session alone is caught once more sensitively at a 4 s threshold (active-PTY only·one-shot, auto-released on the next turn/output resumption).
4. **App Attest trust model**: not Apple's DCAppAttest but a «TOFU registration of the SE key itself» approach — the first-registration moment is the anchor of trust. Key theft after registration (jailbroken devices, etc.) is out of scope. Since more device slots widen the attack surface, the default is 1 slot.
5. **Destructiveness of unattended (`skip_permissions`) workflow/PO nodes**: an auto-approve node could run `rm`/force-push, etc. without human confirmation. Defense = per-node approval gates (`requires_approval`) + workflow-result-folder isolation + the forced human gate of PO workflow mode (§14.4) + worktree isolation (`po_worktree_v1`).
6. **Local LLM memory pressure**: OOM-guarded by forcing 1 concurrent session (daemon). Recommendation of models the hardware cannot meet is blocked (§12.4).

## 9. The daemon's V8 / Embedded Child Processes

A self-contained tree inside `.app/Contents/Resources/daemon/`:
- **Node.js 25.4.0** official darwin-arm64 (version-pinned — deterministic builds).
- **C tor** + dependent dylibs (`libevent`, `libssl`, `libcrypto`, `libscrypt`) + geoip data.
- **OpenSSH portable sshd** + `sshd-session` + `sshd-auth` (9.8+ multiprocess) + dylibs.
- **capture-helper** (our Swift code, compiled at build with `xcrun swiftc -O` — screen capture/control).
- llama-server is not bundled (on-demand via the model catalog — §12.4).
- Core npm dependencies: hono · @hono/node-server · better-sqlite3 · croner · node-pty · ws · pino · nat-api.

**Child-process spawn**: tor · sshd (+session/auth helpers) · capture-helper · llama-server (on-demand) · the agent CLI per session (node-pty). V8 JIT (`node`, `claude` CLI) gets `cs.allow-jit` + `cs.allow-unsigned-executable-memory`. Ordinary native (tor/sshd/capture-helper/esbuild) is signed with hardened runtime alone. `lifecycle.ts` prevents orphans (daemon/tor/sshd left after the parent app exits) via ppid monitoring + self-SIGTERM.

## 10. Distribution Model

iOS = TestFlight (App Store Connect). Mac = Developer ID signed + notarized DMG + Sparkle.
Why not MAS — the daemon needs to access arbitrary repos in the user's home + `~/.claude/projects`, fundamentally conflicting with the sandbox.
The concrete distribution procedure·scripts·version bump are maintainer-only (not included in this repository). The repository is public but the license is proprietary (source-available does not mean open source, and commercial use is not granted).

## 11. Version-Compatibility Handshake + Silent Update

`mac/daemon/src/version.ts` is the SSOT. Both sides bake into the build ① their own version ② the counterpart's minVersion ③ the capability set.
- iOS calls `/api/version` once at boot → **Hard** (minVersion violation): blocked by `IncompatibleView` / **Soft** (capability mismatch): a top banner ("Enabled when the Mac app is updated").
- **Secondary safety net**: the `requireClientVersion` middleware checks `X-Client-Version` on every `/api/*` → below min, `426 Upgrade Required`. Only `/api/version` is exempt (the channel by which an old client learns of its own obsolescence).
- capability naming: lowercase_underscore + `_v<number>`. A protocol-breaking change gets a new identifier with `_v2` (do not silently change a key's meaning).

**Silent forced update (`silent_update_v1`)**: iOS `/api/admin/trigger-update` → daemon `SIGUSR1` → Mac `UpdaterBridge` signal handler → `SilentUpdateUserDriver` (an SPUStandardUserDriver subclass) switches mode to `.silent` (all UI callbacks no-op, reply auto `.install`) → the Sparkle core installs the **EdDSA-verified** DMG + relaunch. Progress is shown via the menu banner + the menu-bar blue dot. iOS confirms the result via `/api/version`'s `lastUpdate` (a successful install is itself signaled by daemonVersion ↑). For an old Mac app, the "Check Sparkle on the Mac screen" fallback.

## 12. Application Plane — Multi-Agent / Workflows / Scheduling / Local LLM / Notifications

If §1–11 is the «transport & security» plane, this section is the «application» plane on top of it. All new features are soft-gated by `/api/version` capability — a phone attached to an old daemon merely «doesn't see» that UI; nothing breaks.

### 12.1 Agent Registry + Token Usage + Desktop Session Import (`multi_agent_v1` / `agent_usage_v1` / `recent_projects_v1`)
- `agent/registry.ts` + `adapters/{claude-code,agy,codex,shell,local-llm}` — registers the 5 adapters as id→adapter. Each adapter: `displayName / capabilities / resolveBinary / buildSpawnArgs / buildSpawnEnv` (+ optional `prepareBackend/releaseBackend` — local_llm prepares/releases llama-server, `desktopWatcher()`, `usage()`).
- `GET /api/agents` → `[{id, displayName, capabilities, installed?, installHint?}]`. The iOS·Mac «tools» picker draws dynamically — adding a new agent needs no app rebuild. An uninstalled CLI is `installed:false` + `installHint`. An old daemon collapses to claude_code alone (zero behavior change).
- **Token usage (`agent_usage_v1`)**: `GET /api/sessions/:id/usage` — usage rate per rate-limit window + reset time. `agent/usage.ts` wraps the adapter's `usage()` with a 60 s cache. claude_code uses the official API via Keychain OAuth (5h/7d windows), codex uses the `token_count.rate_limits` snapshot from the latest rollout jsonl. shell/agy/local_llm are `supported:false`. The balance is shown in the ChatView status bar.
- **Desktop session import (`recent_projects_v1`)**: the claude_code/codex adapters' `desktopWatcher` FS-watches·parses `~/.claude/projects/*/<uuid>.jsonl` / `~/.codex/sessions/.../rollout-*.jsonl` to let you take over «sessions that were running directly on the Mac» from the phone (`--resume`/`resume` subcommand). `GET /api/recent-projects` (recent cwd) + `GET /api/agents/<id>/desktop-sessions` (takeover candidates).
- **New-adapter checklist (mandatory)**: beyond implementing `displayName/capabilities/resolveBinary/buildSpawnArgs/buildSpawnEnv`·registering in the registry, **it must pass the CJK-input reproduction recipe (§5.3)** — `writePtyRaw` treats all adapters identically, but each CLI's (especially Ink-based) IME/CJK input handling differs, so a regression can newly break per adapter. Turn on both ends with `PS_KS_TRACE=1` (KS-TRACE send/recv) and type→send Korean 1-syllable/multi-syllable/emoji/line-break, confirming (a) input-box reflection·submission and (b) sent-bytes = PTY-write-bytes matching, only then expose the adapter as «supported».

### 12.2 Workflow Engine (`workflow_v1`)
Files: `workflow/{types,store,engine,task-folder,triggers}.ts`.
- **Definition**: `nodes` (start/task/end) + `edges` (an unconditioned «success·sequential» or a `condition:"fail"` path) + the start node's `triggers` (manual·cron·github). Stored in the `workflows` table as JSON (including canvas x/y). The old `general`/`test` node kinds are normalized to `task`.
- **Execution** (`engine.ts`): on start, freeze the definition as `def_snapshot` → topo-sort and pump from start. **Spawns 1 session per task node** (viewable via the Sessions tab/deeplink). Node completion = idle detection or a result.md write or a hard timeout.
- **Result handoff**: `.posiworkflow/<wf-slug>--<wfId8>/<YYYYMMDD-HHMMSS>--<runId8>/<node-slug>--<nodeRunId8>/`. The run folder is identified DB-free via the `_run.json` manifest. Each node writes to `result.md` (+ optional `verdict.json` pass/fail) and the next node takes over via the prompt.
- **Branching·loops**: dynamic children created from the node result's `branches.json`. Caps `MAX_NODES=200` · `MAX_DEPTH=8` · `MAX_ITERATIONS=10`. A "fail" edge going back to an ancestor is a loop — cycles are determined by forward-graph reachability excluding fail edges, allowed only via fail edges.
- **Node state**: pending → (if requires_approval) awaiting_approval → running → done/failed/needs_attention, dead paths are skipped. awaiting_approval·needs_attention place an action handler in the `pending` map and await the user's decision.
- **Cancel/restart**: `cancelWorkflowRun` (cancelled flag + queue emptied + PTY graceful abort → remaining nodes skipped). On daemon restart, a running that was up is reconciled to failed (no resumption).
- **DB**: `workflows` / `workflow_runs` (def_snapshot·status·trigger_kind) / `workflow_node_runs` (def_node_id·parent·session_id·status·verdict·iteration·x/y) / `workflow_triggers`.
- **Routes**: `GET/POST /api/workflows`, `GET/PUT/DELETE /:id`, `POST /:id/run`, `GET /runs/:id` (canvas polling), `POST /runs/:id/cancel`, `POST /runs/:id/nodes/:nid/:action` (approve/reject/complete/retry).

### 12.3 Scheduled Jobs (`cron_v1` / `cron_terminal_v1`)
- **Session-based cron**: `cron/{scheduler,executor,store,registry}.ts`. 5-field cron + IANA tz via `croner`. On each tick, makes 1 session with the designated agent+repo, runs once, and exits. `session_mode` (fresh/continue; for continue, takes over the `last_session_id` SDK session) · `overlap_policy` · `catch_up` · `skip_permissions`.
- **Terminal cron (`cron_terminal_v1`)**: `kind='terminal'` — instead of an agent, runs a «shell-script file» once through an interpreter (zsh/bash/sh login shell `-l`). `cron/terminal.ts` does `resolveScriptFile` (~ expansion·absolute-path enforcement·existence check)·`normalizeShell`·`buildScriptSpawnArgs`. The result session is not retained (logs only). The `cron_jobs.kind/shell/script` columns.
- **Workflow triggers (cron·github)**: reconciles the start node's `triggers` into `workflow_triggers`. cron does `startWorkflowRun(wf,'cron')` on the croner tick. github is poll-based since there is no public webhook (`git ls-remote`, poll floor 60 s) — fires when the last SHA changes. manual requires no registration; the iOS "Run" does a `POST /run`.
- iOS exposure: session cron and workflow triggers are in the **Automation tab**'s "Schedule" segment + the workflow node inspector.

### 12.4 Local LLM (Qwen Code + llama-server, `local_llm_lifecycle_v1`)
- `local-llm/{supervisor,paths,catalog,download,hardware,status,events,resolve-llama-server}.ts` + `agent/adapters/local-llm`. A single llama-server (fixed port, parallel=1) **on-demand**: /health adopt / spawn if dead / error if externally occupied. Only what we launched gets a graceful stop + exponential backoff (1s→30s) restart on abnormal exit.
- **Hardware recommendation (`hardware.ts`)**: `detectHardware()` (total RAM·chip·gpu cores) + `recommendModel()` — judges "recommended" (≤0.70 & ≥recommendedRam) / "allowed" (≥minRam & ≤0.85) by each model's estRss/RAM budget. If under, recommendation is blocked.
- **Catalog/download**: Qwen Code in several sizes (`{fileName, estRssBytes, recommendedRamBytes, minRamBytes, ctxNative, ...}`). YaRN rope scaling when ctx > native. `GET /api/local-llm/{status,models,hardware}` + download.
- Memory pressure → **1 concurrent local-LLM session** (daemon-enforced, the app blocks first). The adapter connects the Qwen Code CLI via OpenAI-compatible (`OPENAI_BASE_URL=…/v1`).

### 12.5 Canvas UI (iOS · Mac)
- **iOS**: the Automation tab "Workflows" segment = list (`WorkflowListView`) → editor (`WorkflowEditorView`: add node·drag·connect ports·inspector·save) → run viewer (`WorkflowCanvasView`: read-only + polling) + `WorkflowRunLoaderView` (deeplink landing). Editing canvas: auto-fit on entry, long-press an empty area to add a node, drag=pan·pinch=zoom.
- **Mac**: `WorkflowWindow` — left sidebar (list CRUD) + right canvas (switches edit/run via `runState`). Sidebar selection re-creates the canvas via `.id(workflow.id)`. Two-finger scroll=pan, one-hand drag=marquee select.
- Node-kind color: iOS `editorTypeColor` / Mac `wfTypeColor` follow the same promise (start green·task pink·end blue) → §12.7.

### 12.6 Discord Notifications (`notify_discord_v1` / `session_notify_mute_v1`)
The answer to the zero-background-runtime principle (§1) — real-time push is delegated to the **user's own Discord webhook** (zero external servers: knowing just the URL, the Discord infrastructure handles delivery).
- `notify/{index,discord,preview}.ts`. Events sent: `turn_complete` · `still_waiting` (a 10/30/60-minute reminder chain) · `session_exit` · `error` (these 4 are **away-gated** — only when there is no live viewer) · `cron_complete`/`cron_failed` · `po_briefs`/`po_failed`/`po_gate` (unattended, so away-gate is ignored) · `test`.
- `notify/preview.ts` extracts a meaningful line or two from the tail of the agent output. The deeplink is a GitHub Pages static bridge (`…/open/#<sessionId>` → `pocketsisyphus://…`, since Discord blocks direct links to a custom scheme).
- **Session mute (`session_notify_mute_v1`)**: `PATCH /api/sessions/:id { notifyMuted }` + `sessions.notify_muted`. A ChatView bell toggle to silence only the noisy session when running many at once.
- Settings are in the Mac Settings window's "Notifications" tab. `GET/POST /api/notify/config` + `POST /api/notify/test`.

### 12.7 Color/Design Token Policy
Semantic color tokens. The SSOT is `Theme` in iOS `DesignSystem/DesignTokens.swift` (the "Color Policy" comment at the top); the Mac has no separate Theme and follows the same promise with literals. Key point: separate **warning=yellow (for genuine warnings only)** and **pro=orange (pro/premium/advanced emphasis)** into tokens with different meaning (do not confuse them). Orange is used for the Backlog·Automation «tab buttons»·schedule·terminal/local-LLM tools·chat-tools chips·mirroring entry, etc. (ordinary buttons «inside» a tab keep the default accent). For detailed rules, see `CLAUDE.md`'s "Color Token Policy."

## 13. Result Plane — Live Preview / Artifacts / Screen Capture·Control

If §12 is «what runs», this section is «how execution results are viewed and operated from the phone». All `/api/version` capability soft-gated. **The old «Results» unified sheet (web/screen/artifacts segments) is abolished** — each feature is split into an independent entry point (§5.4).

### 13.1 Live Web Preview (`preview_v1`; absolute URL·multi-port is `preview_v2`)
- **Detection** (`preview/{detect,registry}.ts`): parses loopback dev URLs from the session PTY output (ANSI strip + remote-URL false-positive filter).
- **Transport**: dev ports are not exposed to the phone directly. The daemon relays the active session's dev server at root-origin via a **fixed-port reverse proxy** (`preview/proxy.ts`, HTTP+WS pass-through). **Only that single fixed-proxy-port line is statically added** to sshd `PermitOpen` (§2.2).
- **iOS** (`PreviewView`): a secondary forward to the proxy port via `SSHClient.openForward` → `WKWebView` loads `http://127.0.0.1:<fwd>/`. **Since WKWebView is a real DOM, viewing=operating**. Routes `GET /api/preview/:id`, `.../enable`·`/disable`, `POST /api/preview/ports`.
- **`preview_v2` (`preview/rewrite.ts`)**: solves the problem of real-world Next.js/Vite full-stacks using absolute-URL assets·separate-port API/HMR.
  - **Multi-port**: `POST /api/preview/ports` batch registration → a cookie active set (`<sid>~<main port>~<p1,p2,...>`). The main port is root, the secondaries are `/__psport__/<port>/...`. **An unregistered port passes nowhere** (must pass both the active set ∩ the registry to forward).
  - **Rewrite**: `PreviewRewriteStream` (chunk-boundary safe) routes only «registered» loopback absolute URLs to the proxy path. HTTP(S) is statically substituted; WS(S) cannot be statically substituted, so a WebSocket shim is injected once into `<head>` (runtime host substitution). A compressed response is taken uncompressed by stripping Accept-Encoding and then rewritten. External domains·unregistered ports·string-concatenated HTTP URLs are left unmodified (non-goal).

### 13.2 Artifact Viewer (`artifacts_v1`)
- `GET /api/sessions/:id/artifacts` recursively walks the repo (excluding node_modules/.git/build, with depth/visited caps) to classify renderable files by kind + descending mtime. `GET .../fs/raw` streams raw bytes (reusing the `resolveRepoRelative` path security).
- iOS `ArtifactsView` does folder drill-down + receives raw into temp and renders with **QuickLook** (image·PDF·Office·USDZ·video·audio). The answer to the foreground-only limit (artifacts «while you are away» remain as files).

### 13.3 Native Screen Capture + Remote Control (`screen_capture_v1` / `screen_h264_v1` / `screen_shot_v1` / `screen_window_target_v1` / `remote_control_v1`)
A **bundled Swift helper** (`mac/daemon/helper/capture-helper.swift`) is spawned as a daemon child like tor/sshd. The daemon's `capture/sidecar.ts` is the data hub.
- **Capture codecs**: there are two by default — **JPEG** (`CGDisplayCreateImage` periodic capture, stdout length-prefix) or **H.264 (`screen_h264_v1`)**: `SCStream` (ScreenCaptureKit) → VideoToolbox H.264 + system audio AAC relayed over a binary WS (type 1 SPS/PPS·2 access unit·3 AAC config·4 AAC packet). Being delta-encoded, fps is higher at the same bandwidth (2fps JPEG → 12fps H.264). iOS `H264Decoder` (AVSampleBufferDisplayLayer, GPU decode) renders. An unsupported daemon falls back to jpeg (soft).
- **Backpressure adaptation**: polls the SSH channel's `bufferedAmount` at 4 Hz (250 ms) to dynamically adjust fps/bitrate.
- **One-shot capture (`screen_shot_v1`)**: `GET /api/screen/shot?display=N&window=ID` — a `screencapture(1)` one-shot JPEG. Since live H.264 goes straight to GPU and still-frame extraction is impossible, «capture/record → chat attach» (conveying a bug repro) draws data from this one-shot.
- **Window-scoped capture (`screen_window_target_v1`)**: the helper reports the on-screen window list (`onScreenWindows`, up to 24 in z-order) (`capture_list_windows`→`capture_windows`), and when the iOS mirroring "more" «capture target» picker selects via `capture_set_window`, it encodes only that window via `SCContentFilter(desktopIndependentWindow:)` (an upstream solution for bandwidth·privacy). A window resize is re-composed by 1 s polling of the stream; when a window closes, full-screen fallback + `capture_target(reason=window_closed)` → an iOS capsule notice.
- **Remote control (`remote_control_v1`)**: iOS gesture → WS `input_event` → helper stdin JSON → `CGEvent` injection (mouse/scroll/key/Korean Unicode). Coordinates are 0..1 normalized → the helper converts via `CGDisplayBounds` (absorbing Retina). **Security gate**: capture (viewing) needs only Screen Recording TCC, but **input injection (operating) only when the per-session «control allowed» (`controlEnabled` Set) is explicitly turned on** (`setControlEnabled`→`control_set`) — Accessibility TCC is separate. When axPerm is not granted, `control_status(reason=accessibility_permission)` → an iOS "control blocked" capsule. A single active capture + the helper auto-terminates when there is no viewer.
- iOS entry: `MonitorMirrorView` (the session-agnostic synthetic id `__desktop__`, from both the session list·ChatView) → `RemoteScreenView` (+`ZoomableScreenView`).

### 13.4 Unimplemented/Follow-up
TCC-permission attribution (the responsible process of the daemon-spawned helper) is a real-device-verification follow-up. Simultaneous multi-window broadcast·advanced window auto-tracking are non-goals. Video smoothness·real-time-control latency in a Tor-fallback environment are inherent limits. Fully capturing a live preview's runtime-dynamically-generated HTTP URLs·external-domain proxy·HTTPS termination are non-goals.

### 13.5 Capture/Preview → Chat Attach + Markup (new)
Rather than stopping at just viewing a captured screen, it streams it into chat as a «bug report».
- `PreviewFeedbackSheet` — a single capture (preview DOM / screen) + **PencilKit freehand drawing (markup)** + a one-line comment. `.ps-preview-feedback`/`.ps-screen-feedback` temp → reuses the chat «pending send» plumbing via `FileReferenceDraft`.
- `AttachmentSheet` / `AttachmentAnnotationEditor` — per-attached-image pen strokes·blur regions (mask after capturing)·undo + per-image requirements + an "overall request" field for the mirroring-recording staged frames. `AttachmentDraft` (annotations/baseImage/baseData) for restoring annotation edits.

## 14. PO Plane — product-owner / Opportunity-Brief Backlog (`po_*_v1`)

If §12–13 is «how to build and view results», this section is «who decides what to build». It reduces the human's role from «production» to «approval» — the agent gathers signals and writes an opportunity brief, and the human only approves/holds/rejects in the Backlog tab. iOS **"Backlog" tab (tab 1)**, daemon `po/{executor,prompt,asc,crash,gh,scheduler,workflow-exec}.ts` + `routes/po.ts`.

### 14.1 The Loop (signal → brief → approval → implementation → verification)
```
1) 수집(startPoCollection) — 신호 fetch → 에이전트가 종합
2) 인제스트(ingestBriefs) — 근거 필수 검증 → po_briefs(status=proposed)
3) 결재 — iOS 백로그에서 승인/보류(held)/기각(rejected)
4) 구현 — 승인 시 세션/worktree/워크플로우 모드로 spawn (running)
5) 출시(watchExecForShipped) — 구현 첫 turn 정착 시 자동 shipped
6) 검증(ingestVerdicts) — 다음 수집 사이클이 가설 적중 판정(verified/missed)
```
Every brief **requires an evidence array** (no imaginary proposals) — the source (issue·file:line·review id) is back-traceable. impact/effort are integers 1–5, `score = round(impact/effort*100)/100`. Title-duplication (against live proposed/held/running) is prevented.

### 14.2 Signal Sources
- **GitHub (`po_gh_check_v1`, `po/gh.ts`)**: just before collection, probes `gh --version` + `gh auth status` + whether a GitHub remote exists → `{gh:{githubRemote,installed,authed}}`. Open issues/Discussions/follow-up comments on closed issues. Uncertainty is null (no false "setup needed"); only a confirmed negative gives an iOS notice (brew install gh / gh auth login). A failed check does not block collection (just 0 GitHub signals).
- **Inside the repo**: incomplete `docs/todo-*.md`, TODO/FIXME/HACK comments (grep), README roadmap, recent direction from `git log`.
- **App Store reviews (`po_asc_v1`, `po/asc.ts`)**: only repos with `po_profiles.asc_app_id` on. ASC API (ES256 JWT; the p8 key is in the Mac config.json 0600 only — it never enters the QR/phone) → the latest ≤50 reviews. evidence kind `asc_review`.
- **Crashes (`po_crash_v1`, `po/crash.ts`)**: reusing the same ASC key → the Analytics "App Crashes" report (ONGOING→Daily→gzip CSV/TSV) aggregated over 7 days (top 25 by version·device group). evidence kind `crash`. No third-party SDK.

### 14.3 Profile + Periodic Collection + Verification (`po_schedule_v1`)
- `po_profiles` (repo_path PK · directive investigation method · schedule 5-field cron · asc_app_id). `GET/PUT /api/po/profile`.
- **PoScheduler** (`po/scheduler.ts`): registers repos with a schedule in croner (keyed by repo_path). overlap=skip fixed (skips the tick if one is in progress), no catch-up (prevents a burst right after waking). Re-fetches the latest profile on each callback.
- **Post-ship verification**: carries a shipped brief into the next collection prompt as a "Verification" section to check against the hypothesis — `verified` if the issue is closed·a commit·the same complaint signal is absent, `missed` if it persists, judgment held if evidence is insufficient (retried next cycle). Records `verify_note`.

### 14.4 Approval Modes (`po_worktree_v1` / `po_workflow_v1` / `po_agent_v1`)
`POST /api/po/briefs/:id/decide { action, mode?, useWorktree?, agent? }`:
| Mode | Execution | Isolation | Human gate |
|---|---|---|---|
| **session** (default) | 1 ordinary implementation session + watchExecForShipped | none | none |
| **workflow** (`po_workflow_v1`) | a design agent generates a brief-tailored DAG (spec→implement→self-verify→gate) → `sanitizeDesignedDef` (whitelist) + `ensureHumanGate` (force-insert a human-approval gate) + validateDef → run. On reaching the gate, a `po_gate` notification + a `workflow/<runId>` deeplink. On failure, falls back to a 4-node template | none | **mandatory (auto-inserted)** |
| **useWorktree** (`po_worktree_v1`) | implement in a new worktree on the `po/<id8>` branch (prevents concurrent-session working-tree clashes) | yes | combined with session/workflow |

- **Agent selection (`po_agent_v1`)**: the `agent` in the collect/research/decide/cleanup body — who runs collection/research/implementation/cleanup (claude_code if omitted; unattended, so `cron_eligible` is required). An old daemon discards the field and always uses claude_code → iOS hides the picker if the capability is absent (preventing a false UI).

> **⚠️ Regression caution — «missing agent selection» (a bug repeated 3+ times)**
> If «even one» entry point that spawns an agent session fails to carry `agent`, whatever tool the user picks is ignored and it always runs as claude_code. There is a history of the same kind of omission recurring several times (e.g. shipped's «collect-and-verify now» = collect but agent not passed; rejected's «clean up code traces» = cleanup but agent not passed → both fixed in 2026-06). When touching a new/existing entry point, **always** check the following.
>
> **Checklist — «every» iOS entry point that calls collect/research/decide/cleanup**:
> 1. Does the call carry the `agent:` argument? (the `agents.isEmpty ? nil : execAgentId` pattern — leave it nil for a hidden picker/old daemon so it falls back to claude_code)
> 2. Is `PoAgentSection` (or an equivalent picker) «exposed» on that screen? If you attach the picker to only one state like `decidable`, the actions of other states (shipped/rejected) have no selection UI — the picker must follow into every state where an action is visible.
> 3. The selected value shares `po.brief.lastAgentId` (@AppStorage `execAgentId`) so it is consistent across all briefs with one tool (a one-tap shortcut for the run-with-the-same-tool-each-time flow).
> 4. Confirm the corresponding handler in the daemon's `routes/po.ts` reads `agent` and passes it to the session spawn (if you fix only iOS and the daemon discards it, it fails silently).
>
> Current iOS entry points (`ios/.../Views/BacklogView.swift`): `startCollect`/`startVerifyCollect` (collect) · `startResearch` (research) · `decide("approve")` (decide) · `cleanup`/`rejectAndCleanup` (cleanup) — all follow the pattern above.

### 14.5 Research · Revise · Reject-Cleanup · Stats
- **Research** (`POST /api/po/research`): the answer to the limit that internal signals alone lack evidence for «something entirely new» — the agent investigates web+repo (every claim requires a source URL) → a report (`po_research.report` markdown) + briefs (at least 1 web/market in evidence). Zero is also a valid answer («do not do it»). On success the session auto-removes (the report is the permanent artifact).
- **Revise instruction** (`POST /briefs/:id/revise`): re-synthesize a proposed/held brief with a one-line comment (polishing the story).
- **Reject cleanup (`po_cleanup_v1`, `POST /briefs/:id/cleanup`)**: removes the signal sources of a rejected idea (TODO/FIXME comments·dead code) to stop the next collection from repeating the same proposal (the duplication check looks only at live titles). To the working tree only, without a commit — the user's review responsibility. The `po_briefs.cleanup_session_id` entry point.
- **Stats (`po_stats_v1`, `GET /api/po/stats`)**: per-repo/overall proposal count·approval rate·shipped·verified/missed·median approval time. A report-card card at the top of the Backlog — showing agent accuracy numerically to solve the trust cold-start with data.

### 14.6 DB + Routes + iOS Exposure
- **DB**: `po_briefs` (title·problem·evidence·impact·effort·score·scope·spec·status·decided_at·collect/exec/revising/cleanup_session_id·research_id·exec_workflow_id·exec_run_id·verify_note) / `po_profiles` / `po_research`. States: proposed → held / rejected / approved → running → shipped → verified / missed.
- **Routes** (`routes/po.ts`): `GET /briefs`·`/stats`, `POST /collect` (async ingest)·`/briefs/:id/decide`·`/cleanup`·`/revise`, `DELETE /briefs/:id`, `GET/POST/DELETE /research(/:id)`, `GET/PUT /profile`, `GET/PUT/DELETE /asc-key` + `/asc-key/verify`.
- **iOS `BacklogView`**: a report-card card (`po_stats_v1`) · project filter · progress/GitHub notice banner (`po_gh_check_v1`) · research · awaiting approval (proposed, score-sorted) · in progress (running, Sessions tab/workflow detail) · shipped · handled sections. "Create" = repo collection / research request. Every sub-feature is capability + pro (`.poLoop`) soft-gated. Deeplinks `pocketsisyphus://backlog` (new brief) · `…/workflow/<runId>` (awaiting merge approval).

### 14.7 Brief-Readability Gate (`readability.ts` ↔ `po-brief-readability-lint.sh`)
Visual design (`design-lint`) and duplication (dedup / `similarity.ts`) have automatic gates, but «understandability» had none — so even after the collect prompt is made plain, the calibration anchor (§14.3 history summary) and model drift let titles get «dense» again (file paths · code symbols · multi-clause «—» leaking into the title/problem). This gate is the last net, same tone as the other lints («surface candidates»; a human judges):
- **Heuristics (R1–R4, deterministic)**: R1 title over 80 chars · R2 a file path (`.ts/.swift/.sh…`) or SCREAMING_SNAKE symbol in the title · R3 «—» (em/en-dash) joining 3+ clauses · R4 the `problem` first line starting with a code reference/symbol (backtick · `file:line` · SCREAMING_SNAKE · dotted member). URLs · issue numbers · acronyms (Tor·SSH·API…) are whitelisted to minimize false positives. Applies to UI and non-UI (daemon/network/CLI) briefs alike — it is title/summary readability, **not** a design-token check.
- **Two mirrors**: `mac/daemon/src/persona/readability.ts` is the runtime side — `ingestBriefs` runs it as a **soft** signal (logs candidates, never drops the brief; the existing 200-char hard cap is preserved — this is logging/surfacing, not a hard reject or auto-rewrite). `scripts/po-brief-readability-lint.sh` (bash + Python, no Node/build) is the CI/manual side — reads a produced brief-array JSON (path args or stdin) and surfaces candidates. Both are pinned (`readability.test.ts` ↔ `scripts/test-po-brief-readability-lint.sh`) so the rules can't drift, same as the iOS↔Mac `Theme` mirror discipline.
- **80 vs 200 alignment**: the collect prompt declares «within 80 chars» in all 10 locales; `readability.TITLE_ADVISORY_MAX = 80` is its code-side SSOT (the advisory limit the gate enforces softly). `executor`'s `str(title, 200)` is a hard DB-safety backstop, not the declared limit — the two coexist by purpose, and `readability.test.ts` pins both (constant == 80 **and** every locale's title schema declares 80) so they can't silently diverge again.
- **CI**: `scripts/test-po-brief-readability-lint.sh` runs as a blocking gate in the lint-gate workflow (`.github/workflows/i18n.yml`), alongside i18n-lint · doc-pair-lint (the detection logic is gated; the lint itself surfaces candidates softly at ingest/manual run).
