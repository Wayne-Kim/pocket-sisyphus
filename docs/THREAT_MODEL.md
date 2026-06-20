**English** · [한국어](THREAT_MODEL.ko.md)

# Threat Model — Pocket Sisyphus

> This document states «what we protect / what we trust / what we block and what we cannot block».
> Implementation details have their SSOT in [ARCHITECTURE.md](ARCHITECTURE.md) (especially §4 Security Model · §8 Known Risks),
> and the vulnerability reporting procedure is in [SECURITY.md](SECURITY.md). This document ties those two together
> from a «threat model» perspective.
>
> The **capability cap guardrails** spec applied to personal-data paths (future mail · calendar, etc.) has its
> canonical reference in [CAPABILITY_CAPS.md](CAPABILITY_CAPS.md) — bound 1:1 to §5.8 (attack surface) · §6 (residual risk) of this document.

Pocket Sisyphus's promise is **«securely control a code-agent CLI running on your Mac from your phone's LTE/5G»**.
Exactly what "securely" means — against which adversary, on which assumptions — is written below.

---

## 1. Scope

As with the [project boundaries in the README](../README.md#프로젝트-경계), this repository contains three projects, and the
center of gravity of the threat model differs across them.

| Project | Threat-model target | Notes |
|---|---|---|
| **iOS app** (`ios/`) | ✅ **Core** | The private data plane between phone ↔ my Mac. Secret storage (Keychain). |
| **Mac app + daemon** (`mac/`) | ✅ **Core** | sshd · tor · daemon · PTY runner · screen capture helper. The center of the trust boundary. |
| **Web** (`web/`) | ⚠️ **Peripheral** | Static intro page (landing). No secrets · no backend · no DB. Unrelated to the data plane. |

**Non-goals (what this threat model does NOT cover):**
- The security of the code-agent CLIs (`claude`/`agy`/`codex`) and each provider's (Anthropic/Google/OpenAI) API traffic —
  Pocket Sisyphus does not relay that traffic (§3.6).
- The integrity of the user's macOS · iOS · hardware · OS Keychain · Secure Enclave themselves (trust assumptions, §4).
- Availability / content tampering of the static landing site — it has no secrets, so it is not a data-plane threat (only classic web-hosting threats apply).

**Expanding surface (personal-data plane):** Future features (paths that inject personal data such as mail · calendar into the
agent) pull «external content whose body an attacker can control» into the data plane, opening an **indirect prompt
injection → lethal trifecta** attack surface (§5.8). The capability caps to be enforced on those paths have their canonical
reference in [CAPABILITY_CAPS.md](CAPABILITY_CAPS.md), and this threat model records that attack surface · residual risk in §5.8 · §6.

---

## 2. Assets — what we protect

| Asset | Where | Impact if exposed |
|---|---|---|
| **A1. Data-plane traffic** | Phone ↔ Mac (PTY raw ANSI stream, `/api/*`, WS events) | Eavesdropping/tampering of session content · keystrokes · outputs |
| **A2. Agent execution privilege** | Mac daemon → `node-pty` → CLI | read/write/exec over arbitrary repos in the user's home + all of `~/.claude/projects` |
| **A3. Pairing secret bundle** | Pairing QR (v=3) + both-side stores | If fully stolen, daemon impersonation or unauthorized access |
| ├ onion v3 key (Ed25519) | Mac HiddenServiceDir | onion address = identity. If leaked, server impersonation possible |
| ├ onion client-auth key (x25519) | Mac + phone Keychain | descriptor decryption capability — the onion address alone cannot open a circuit |
| ├ daemon Bearer token | Mac daemon + phone Keychain | `/api/*` authorization |
| ├ SSH client priv (ed25519) | Phone Keychain (issued per pairing) | sshd connection credential |
| └ SSH host key (ed25519) | Mac (permanent) | fingerprint pin target — daemon identity |
| **A4. Screen capture / remote control capability** | Mac capture helper (`CGEvent` injection) | «view» = screen leak, «manipulate» = unauthorized control of the Mac desktop (the most powerful) |
| **A5. ASC .p8 EC private key** (opt-in) | Resident in Mac `config.json` (0600) — `asc.privateKeyPem`/`keyId`/`issuerId` | Long-lived credential. If leaked, App Store Connect API access within the key's role scope (reviews · crashes, etc.). Outside pairing rotation → valid until the user manually revokes it in the ASC console |

---

## 3. Trust boundaries — where data crosses a boundary

```
[ user's fingers ]                          ← trusted
  │ QR scan (out-of-band, directly on screen) — pairing once
  ▼
┌── boundary B1: phone app process ───────┐  ← trusted (user's device + Keychain)
│  PocketSisyphus.app                      │
│  secrets: A3 (Keychain, hardware-protectable)  │
└──────────────┬──────────────────────────┘
               │ outbound TCP
  ┌────────────▼─────────────────────────┐
  │ boundary B2: transport plane (adversarial)  │  ← untrusted (public Internet/LAN/Tor relay)
  │  · direct SSH (IPv6/IPv4 UPnP)        │     attacker may attempt observe/tamper/forge
  │  · Tor onion (3 hops, or obfs4 bridge) │
  └────────────┬─────────────────────────┘
               │ inbound
┌──────────────▼──────────────────────────┐  ← trusted (user's Mac)
│ boundary B3: Mac sshd (22022, whitelisted)  │
│  direct-tcpip → 127.0.0.1:7777 only allowed  │
├──────────────┬──────────────────────────┤
│ boundary B4: daemon loopback (127.0.0.1) │  ← trusted
│  Hono /api/* (+Bearer) · WS · /endpoint  │
├──────────────┬──────────────────────────┤
│ boundary B5: PTY ↔ code-agent CLI        │  ← «semi-trusted»: repo content the CLI processes
│  node-pty spawn(claude/agy/codex/…)      │     may be adversarial (prompt injection, §5)
└──────────────┬──────────────────────────┘
               ▼
        user filesystem / shell (A2 — full user privilege)
```

- **Inside B1 · B3 · B4 · B5 is trusted** — we trust the user's own two devices and their OS · Keychain (§4 assumptions).
- **B2 (transport plane) is entirely untrusted** — the full weight of every defense rests here (§4 security model). We assume an adversarial LAN,
  ISP/carrier, Tor relay, or man-in-the-middle (MITM) that tries to see · alter traffic and impersonate the server.
- **B5 (agent boundary) is «semi-trusted»** — even if the channel is safe, the *repo content the CLI reads* can be planted by an attacker
  (prompt injection from a malicious repo). Since by nature the user runs the agent with their own privilege, we «accept» the residual
  risk of this boundary (§6).
- **The web (landing) is not in this graph** — it handles no secrets and does not touch the data plane; it is a separate boundary.

---

## 4. Assumptions — if these break, the guarantees break too

1. **The user trusts their own Mac · phone.** An already-compromised device (rooted/jailbroken/resident malware) is out of scope.
2. **The pairing QR is delivered over an out-of-band safe channel** — a one-time act of scanning the Mac screen «directly» with the phone camera.
   We assume the QR capture is not shared/transmitted (violating this realizes the §5 «QR leak» threat).
3. **OS security primitives are intact** — iOS Keychain (Secure Enclave hardware protection when available), macOS
   Keychain, code signing/Gatekeeper/notarization, TCC permission gates.
4. **The bundled OSS dependencies are honest** — Tor, OpenSSH portable, Citadel (swift-nio-ssh), Node, IPtProxy.
   Supply-chain tampering is a separate threat (this model assumes we embed those «known-good» builds).
5. **The code-agent CLI and its provider are chosen and trusted by the user.** Pocket Sisyphus only spawns the CLI
   and does not relay model traffic (§3.6) — trusting the CLI/provider is the user's responsibility.
6. **The cryptographic primitives are not broken** — Ed25519, x25519, ECDHE, SSH/Tor v3 protocols.

---

## 5. Adversaries → Mitigations

Each row is «what the attacker targets (asset), what they do, and what we block it with». The canonical reference for implementation is
the [ARCHITECTURE.md §4](ARCHITECTURE.md#4-보안-모델) table.

### 5.1 Adversarial LAN / man-in-the-middle (MITM) — *transport plane B2*
- **Target:** A1 (traffic eavesdropping · tampering), stealing A3 · A2 via daemon impersonation.
- **Method:** ARP/DNS spoofing on the same Wi-Fi/LAN, fake daemon responses, intercepting the SSH/Tor handshake.
- **Mitigation:**
  - **Cryptographic identity, doubly assured** — onion v3 address = hash of the Ed25519 public key (the address itself is the identity),
    plus the SSH **host key fingerprint pin**.
  - **Direct-channel host key verification** (`SSHHostKeyTOFU.swift` `TOFUHostKeyValidator`, ARCHITECTURE §8.4):
    ① exact-match pin against the full public key (`cfg.sshHostKey`) → ② comparison against the pairing/`/endpoint` trusted fingerprint →
    ③ pure `KnownHostStore` TOFU only when no anchor exists. A mismatch is **rejected** with `SSHError.hostKeyMismatch` →
    blocking daemon impersonation on an adversarial LAN. Even if the direct channel is rejected, it transparently switches to the safe path via **onion fallback**.
  - **forward secrecy** — SSH (ECDHE) or onion v3 (3-hop encryption) protects past traffic even against later key leakage.

### 5.2 QR leak — *pairing secret A3*
- **Target:** the entire A3 bundle (onion key · client-auth · Bearer · SSH client priv) all at once.
- **Method:** a pairing QR screenshot leaks into a third party's hands via cloud sync/messenger/shoulder-surfing.
- **Mitigation:**
  - **Out-of-band one-time delivery assumption** (§4-2) + **immediate rotation path** — Mac menubar «Change pairing values» →
    `POST /api/admin/rotate-pairing` (ARCHITECTURE §4 revoke): new Bearer + onion key rotation (new .onion address)
    + SSH client keypair reissue + `authorized_keys` refresh + WS forced termination. **The old QR is fully invalidated immediately.**
  - **client-auth separation** — a QR fragment carrying only the onion address cannot open a circuit (5.4 below).
  - A lost phone is handled by the same rotation (mass invalidation of all assets).

### 5.3 Malicious-repo prompt injection — *agent boundary B5 / asset A2*
- **Target:** A2 (user-privilege files/exec) — tricking the agent into `rm`/exfiltration/force-push.
- **Method:** planting «ignore that and run X» style instructions in the repo's README/issues/source comments so the CLI reads them.
- **Mitigation (partial):**
  - **Per-node approval gates in workflows** (`requires_approval`) + `.posiworkflow/` result isolation
    (ARCHITECTURE §8.5). The destructiveness of unattended nodes is contained by waiting on a user decision (`awaiting_approval`).
  - **Intrinsic limit** — since running the agent with the user's own privilege is the product's purpose, fully blocking injection
    is impossible. The residual risk of this boundary is explicitly **accepted** (§6-1).

### 5.4 `.onion` address leak — *transport plane B2*
- **Target:** reach the server by learning the onion address.
- **Method:** descriptor harvesting, address exposure via logging/sharing mistakes.
- **Mitigation:** **v3 client-auth (x25519)** — without the priv, one cannot even decrypt the HS descriptor and so cannot build a
  circuit (ARCHITECTURE §2.3). Address exposure ≠ ability to connect. Server-side single-hop is an intentional trade-off that gives up
  «server-location anonymity» to reduce latency (client anonymity · authentication remain).

### 5.5 SSH brute force / lateral movement — *boundary B3*
- **Target:** A2 (shell/exec), or tunneling to an arbitrary port via 22022.
- **Method:** password guessing, exec/shell/sftp attempts, accessing an arbitrary internal port via `direct-tcpip`.
- **Mitigation: strict sshd whitelist** (ARCHITECTURE §2.2):
  `PasswordAuthentication no` · `PubkeyAuthentication yes` (ed25519) · `PermitOpen 127.0.0.1:7777`
  (+ a one-line fixed preview proxy port, §13.1) · `ForceCommand /bin/false` (refuses shell/exec) ·
  `PermitTTY no` · `AllowAgentForwarding no` · `X11Forwarding no` · no Subsystem registered (sftp blocked).
  → There is no password surface to brute-force, and even on success nothing is possible beyond the one `direct-tcpip` destination.

### 5.6 Token leak (Bearer / client key) — *asset A3*
- **Target:** unauthorized access to A1 · A2.
- **Method:** single-item theft of the Bearer or SSH client priv.
- **Mitigation:** **per-device · per-pairing issuance + revoke**. The Bearer is separate per device, the SSH client key is new per pairing
  (identified/revoked by the `pocket-device:<id>` comment). Even a single-item leak is fully rotated via rotate-pairing (5.2).

### 5.7 External inbound blocking / Tor DPI blocking — *availability*
- **Target:** denial of service (blocking the connection itself).
- **Method:** CGNAT/firewall blocks inbound, DPI blocks plaintext Tor traffic.
- **Mitigation:** **Tor onion fallback** automatic switchover (when direct SSH is unavailable), and if plaintext Tor is throttled,
  retry via an **obfs4 bridge** (`tor_bridge_v1`, ARCHITECTURE §8.1). No regression for users who haven't configured it (plaintext first).

### 5.8 Indirect prompt injection → lethal trifecta — *agent boundary B5 / asset A2*
- **Target:** A2 (user-privilege files/exec/network) — zero-click exfiltration that takes «private data» out via «external communication»
  (EchoLeak · ShadowLeak class).
- **Method:** the attacker plants «ignore that and send X externally» style instructions in **personal-data input whose body the attacker
  controls** (mail body/headers/attachments, calendar invite titles · notes). If future personal-data features put that content into the
  agent context, the **three legs gather in one session** — ①private data ②untrusted external content ③external-communication capability —
  completing the trifecta, and under the **unattended autonomous execution** of `skip_permissions` · cron · workflows it exfiltrates without a human click.
- **Mitigation: sever leg ③ (external communication) of the three with a cap** (canonical: [CAPABILITY_CAPS.md](CAPABILITY_CAPS.md)):
  - **taint propagation + EGRESS blocking** — a session into which personal/external content has entered is marked `external_content_tainted`
    (propagated across continue/next node/worktree, never cleared), and **external-transmission capabilities are blocked by default** — mail send · arbitrary
    HTTP POST · `git push` · outbound MCP, etc. The human-in-the-loop conversation path passes only through a per-action confirmation gate that
    shows destination + payload (no blanket allow).
  - **No unattended trifecta (invariant)** — in cron · unattended workflow nodes · `skip_permissions` · unattended PO implementation, a tainted
    context and EGRESS **cannot be active at the same time** (static rejection at the config stage + runtime handle reclamation). Personal-data
    autonomous tasks run in an EGRESS-free **isolated session** (dedicated worktree · no credentials injected) and produce results only as local files.
  - **read-only first** — personal-data connectors default to a read-only scope; write-back to the source (mail send · calendar edit) requires
    per-action confirmation and is forbidden on unattended paths.
  - **domain allowlist + MCP least privilege** — outbound default deny + allowlist; tainted/unattended sessions have EGRESS · write-back-natured
    MCP tools left unconnected.
  - **notification consistency** — existing EGRESS-natured notifications (Discord, etc.) do not carry the tainted session's «result/body» in the
    payload and send only a meta signal (additional constraint in ARCHITECTURE §12.6).
- **Intrinsic limit (residual):** as with §5.3, the «being read» of the injection itself cannot be blocked — the defense extends only to severing
  leg ③, the communication leg, to prevent «completion of exfiltration». The residual risk is accepted in §6-7.

### 5.9 Forged deep link (custom scheme) — *external entry / screen navigation*
- **Target:** making the user tap a forged `pocketsisyphus://…` link to «steer» the app's screen navigation —
  dragging them to a specific session/backlog/workflow/mirror screen. It does not directly target A2 · A3 (secrets); rather it targets
  the «absence of a lock + arbitrary screen transition» on a no-gate pair.
- **Method:** **custom schemes have no OS ownership verification** — unlike Universal Links, anyone can craft a URL with the same scheme (forgery),
  and if another app on the same device registers the same scheme it may even intercept it. The attacker plants a link like
  `pocketsisyphus://mirror` in a messenger/web/QR, etc., luring the user into tapping it.
- **Assumption:** **URLs arriving via the custom scheme (`pocketsisyphus://`) are treated as forgeable/interceptable** — the entry
  itself is not trusted (no OS ownership guarantee compared to Universal Links; an extension of the §4 assumptions).
- **Mitigation:**
  - **The handler does not execute «actions»** — `DeepLinkRouter.handle` parses the URL and only sets **«view-request» flags** like
    `pendingSessionId`/`pendingBacklog`/`pendingMirror`/`pendingWorkflowRunId`. Side-effecting actions like delete · execute · send · purchase do not
    occur via deep link.
  - **Consumption only behind the LockView · capability · Pro gate** — the flags are received by `SessionsView`/`MainTabView`/`BacklogView` for
    navigation, and these are all screens that mount only after AppRoot has passed `LockView` (Secure Enclave biometric lock) — when on a registered
    pair. The mirror goes through the `screen_capture_v1` **capability + Pro gate**, and backlog/workflow go through the `.poLoop`/`.workflow` **Pro
    gate** as usual — the deep link cannot bypass the gate.
  - **No secret carried in the scheme** — the URL carries only session/brief/run «identifiers» and does not carry the Bearer · keys · credentials
    (A3 is handled only via Keychain · per-pairing issuance as in §5.6). A link leak/forgery does not lead to a secret leak.
- **Intrinsic limit (residual):** on a no-gate pair (`needsAuthGate=false`) there is no `LockView`, so a forged deep link can cause the «screen
  transition» itself. The residual risk is accepted in §6-8.

### 5.10 ASC .p8 key leak + ASC outbound channel — *asset A5 / exception to «zero external servers»*
- **Target:** A5 (ASC .p8 EC private key) — stealing the key via daemon compromise/`config.json` leak to access the owner's App Store
  Connect API within the key's role scope.
- **Method:** compromising the daemon process or directly stealing the 0600 file (`config.json`) to extract `asc.privateKeyPem` · `keyId` ·
  `issuerId`. Self-signing an ES256 JWT with this key (15-minute expiry, but unlimited reissuance as long as one has the key) lets one call
  `api.appstoreconnect.apple.com` per the key's role permissions.
- **New outbound boundary (accepted exception):** the daemon makes **direct outbound calls** to `api.appstoreconnect.apple.com` for PO
  collection's «store reviews» · «crashes» signals (`asc.ts` ES256 JWT signing + `crash.ts` Analytics Reports download — both paths use the same
  ASC key · same channel). This is an **explicit · accepted exception** to the README core principle «zero external-server dependency». Rationale:
  ① the call target is merely **Apple's own API**, not maintainer infrastructure · a third-party server (we do not see the traffic) — of the same
  nature as the «provider API traffic» in §1 non-goals, ② it is **owner opt-in** (below) and off by default, ③ what is fetched is only
  **aggregated read signals** (reviews · crashes).
- **Mitigation:**
  - **0600 permissions** — the key lives only in `config.json` (owner-only read/write). The PEM body is embedded, not a file path.
  - **opt-in + owner-only** — the Mac app Settings «App Store» tab saves it only via `/api/po/asc-key` (a local-operator-only path).
    **It never enters the phone (QR/pairing)** — a separate asset fully decoupled from the A3 pairing bundle.
  - **read-signals only** — the channel is used only for «aggregated reads» of reviews · crashes (no write-back · deploy · metadata change).
  - **No channel when the key is unset** — if `asc` is unset, the outbound ASC call simply does not happen (when the feature is off, the boundary
    does not exist). No regression.
  - **least-role recommendation** — issue the narrowest possible key role in the ASC console (e.g., read-only Analytics).
    ⚠️ **Issuing with a broad role like App Manager makes the impact of a leak grow to that entire role** — a narrow role is recommended.
- **Relation to §5.6 (the key residual risk):** the Bearer · SSH client key (A3) neutralize single-item leaks via **per-device · per-pairing
  issuance + full rotation by rotate-pairing** (§5.6, §5.2). **The ASC .p8 key is outside that rotation model** — it is not a credential we
  issue/revoke but a long-lived key issued by Apple, so no amount of pairing rotation invalidates it. Therefore **the responsibility to
  rotate/revoke rests with the user**: on suspected leak, **directly revoke that API key in the ASC console** and reconfigure with a new key.
  This residual risk is accepted in §6-9.

### 5.11 Non-LAN outbound leak (egress confinement / LAN-only mode) — *transport plane B2 / reinforcing «zero external servers»*
- **Target:** the user switches the phone↔Mac channel to «LAN direct» and believes «packets do not leave the company», yet the daemon, «separately»
  from that, quietly leaks metadata/traffic out to the public Internet through incidental outbound calls — public-IP echo (ipify, etc.) · UPnP/NAT-PMP ·
  App Store Connect · Discord webhook.
- **Method:** even after switching the data plane to LAN direct, the daemon still fires ① WAN-IP discovery echo (`api.ipify.org`, etc.), ②
  UPnP/NAT-PMP router mapping for public inbound exposure, ③ PO collection's ASC signals (`api.appstoreconnect.apple.com`),
  ④ notification Discord webhook, as is. If the existence · timing · destination of these calls leaks outside the corporate network, the «full
  external blocking» guarantee becomes only half true (metadata leak of connection fact · IP · app identifier, etc.).
- **New trust boundary/control (accepted control):** **«LAN-only mode»** (`config.lanOnly === true`, default OFF). When on, it gates the daemon's
  «non-LAN» outbound to **default deny**. The phone↔Mac private data plane (LAN direct · sshd · endpoint, bound to 127.0.0.1) is «not» a gate target —
  the control target is the incidental outbound «that goes out to the public Internet/Tor relay». The discovery channel, too, in this mode **switches
  from Tor onion exposure to LAN discovery** (no public mapping needed).
- **Mitigation:**
  - **single gate (preventing omission)** — every non-LAN outbound path goes through **one helper** (`guardNonLanEgress()` in
   `mac/daemon/src/egress.ts`). As long as whoever adds a new outbound does not forget that one line, the «forgot just one path» leak is structurally
   blocked. Application points: `nat/external-ip.ts` (echo) · `nat/port-mapping.ts` (UPnP/PMP) ·
   `po/asc.ts` · `po/crash.ts` · `po/asc-check.ts` (ASC) · `notify/discord.ts` (webhook).
  - **per-path default-deny behavior** — echo **skips the call** (last IP if cached, else `none`), UPnP/NAT-PMP **aborts the mapping attempt**
   (no public exposure needed), ASC **blocks outbound + throws «conflicts with mode»** (collection does not die, only the relevant signal section is
   omitted; the ASC availability probe is treated as «uncertain» to suppress a false «key expired» warning), Discord **blocks notification sending**
   (no metadata leak of repo · session title, etc.).
  - **zero regression when mode OFF** — when the mode is OFF the gate «just passes through» with zero side effects (not even a log). Because the
   default is OFF, existing users' behavior does not change by a single bit.
  - **contract tests** — `mac/daemon/src/egress.test.ts` asserts that with the mode ON the actual `fetch` calls of echo/UPnP/ASC/Discord are **0**,
   and with the mode OFF that echo takes the normal fetch path.
- **Residual risk:** ① **OS-level traffic cannot be blocked** — packets emitted not by the daemon but by the operating system/other processes —
  DNS resolution · ARP · NTP · OS update checks, etc. — are outside this gate's control (true «egress 0» is the responsibility of the OS/network
  firewall layer). ② **prior exposure when mode OFF** — since the default is OFF, a user who has not explicitly turned it on retains the prior
  outbound exposure such as §5.10 as is (this control is opt-in). ③ the mode toggle relies on trust in `config.json` (0600) —
  if `lanOnly` is turned off via daemon/file compromise the gate is lifted (same as the config-trust assumption of §5.6 · §5.10). This
  residual risk is accepted in §6-10.

---

## 6. Accepted residual risk

What we have explicitly chosen «not to block» — threats that are intrinsic to the product's purpose, or low-value relative to cost/complexity.

1. **The user's own agent execution can be destructive.** Running a code agent with the user's own privilege is the essence of the product —
   the agent can perform destructive actions like `rm` · force-push (especially on `skip_permissions` unattended nodes). The defense is not «full
   blocking» but extends only to **per-node approval gates + result isolation** (§5.3, ARCHITECTURE §8.5).
   The responsibility to handle only trusted repos and to enable unattended automation carefully rests with the user.
2. **The terminal render surface.** PTY output flows as raw ANSI and SwiftTerm renders it — there is room for an adversarial repo to disrupt the
   screen with escape sequences. The input path has defenses such as high-bit byte drop (§5.3 input), but it does not block all ANSI abuse of
   *output rendering*. Interactive-prompt detection is also heuristic (ARCHITECTURE §8.3).
3. **Citadel single maintainer.** The swift-nio-ssh (NIO)-based stack is proven, but the possibility of bugs in Citadel itself we handle by
   directly fixing them (ARCHITECTURE §8.2).
4. **Tor bridge limits.** The added latency via a bridge can make live preview/mirror rough, and the built-in default bridge
   set must be rotated · refreshed by the maintainer (ARCHITECTURE §8.1). Automatic BridgeDB distribution · HTTPS termination · Mac-side
   bridge are non-goals.
5. **Remote control = the most powerful capability.** Input injection (manipulation) is delivered only when per-session «control allowed» is
   explicitly turned on (no blanket allow) + Accessibility TCC is separately required (ARCHITECTURE §13.3). Still, the fact that while on, the phone
   can manipulate the Mac desktop is accepted by design. Capture auto-stops when there is no viewer (privacy/battery).
6. **Giving up server-location anonymity.** Single-hop onion intentionally gives up server anonymity to reduce latency (§5.4).
   Client anonymity · client-auth authentication remain.
7. **The «being read» of indirect prompt injection cannot be blocked.** That a personal-data path (mail · calendar) puts attacker-controlled
   content into the agent is itself the feature's input and cannot be blocked (§5.8). The defense extends only to **severing leg ③, external
   communication, of the lethal trifecta with a capability cap** ([CAPABILITY_CAPS.md](CAPABILITY_CAPS.md)) to prevent «completion of exfiltration» —
   tainted-session EGRESS blocking/gating, no unattended trifecta, read-only first, allowlist, MCP least privilege. The responsibility to connect
   only trusted sources and not to enable personal-data + external communication together in unattended automation remains with the user.
8. **On a no-gate pair, a forged deep link's screen navigation cannot be blocked.** Custom schemes have no OS ownership verification, so they are
   forgeable/interceptable (§5.9). Since the handler does not execute actions, consumption happens only behind the LockView · capability · Pro gate,
   and no secret is carried in the scheme, there is no secret leak/side effect; but **on a pair with `needsAuthGate=false`
   (soft · old daemon · simulator), there is no `LockView`**, so a forged deep link can **induce a screen transition** to mirror/backlog, etc.
   **The impact is low** — the mirror additionally needs the `screen_capture_v1` capability + Pro gate + a separate user confirmation · permission,
   and backlog/workflow also go through the Pro gate, amounting not to a «destructive action» but to a «read-only screen transition». A registered
   pair (`needsAuthGate=true`) closes this surface because the LockView precedes it.
9. **The ASC .p8 key is outside pairing rotation — the rotation responsibility rests with the user.** The ASC API key for store-review · crash
   signals is an **Apple-issued long-lived credential** that the owner opt-in places in `config.json` (0600), so unlike Bearer · SSH it is not
   neutralized by rotate-pairing (§5.10, vs §5.6). On daemon compromise/`config.json` leak, ASC read access within the key's role scope leaks, and to
   invalidate it **the user must directly revoke · reissue the key in the ASC console**. This is also a (accepted) exception to the README «zero
   external servers» principle — accepted because the target is Apple's own API · opt-in · owner-only · limited to read signals. The responsibility
   to issue a narrow key role and to manually revoke on leak remains with the user.
10. **LAN-only mode is opt-in + outside OS-level traffic.** Egress confinement (§5.11) default-denies the daemon's «non-LAN» incidental outbound
    (echo · UPnP/NAT-PMP · ASC · Discord) through a single gate, but **the default is OFF** and **OS-level traffic like DNS · ARP · NTP is outside its
    control**. The full guarantee of «not a single bit of a packet leaves the company» is the responsibility of the OS/network firewall layer, and
    this control extends only to «blocking the incidental outbound the daemon voluntarily emits». That the mode toggle relies on trust in
    `config.json` (can be lifted on compromise) is also accepted.

---

## 7. If you find a vulnerability

The responsible (coordinated) disclosure path follows [SECURITY.md](SECURITY.md) — use a GitHub
private security advisory as the primary channel. Do not post 0-day details to public issues/PRs/Discord.
