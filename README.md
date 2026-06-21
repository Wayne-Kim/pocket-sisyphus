**English** · [한국어](README.ko.md)

<div align="center">

<img src="docs/assets/icon.png" alt="Pocket Sisyphus icon" width="116" height="116" />

# Pocket Sisyphus

<p><strong>Securely drive the code-agent CLIs running on your Mac, from your phone over LTE/5G.</strong></p>

<p>Dual channel (SSH-first + Tor fallback) + a native iOS app. Zero external servers · zero paid infrastructure · a 100% OSS stack (for the two apps). Free, with an optional Pro tier.</p>

<p>
  <a href="https://apps.apple.com/app/pocket-sisyphus/id6772206998"><strong>📱 App Store (iPhone)</strong></a> &nbsp;·&nbsp;
  <a href="#install-mac"><strong>💻 Install on Mac</strong></a> &nbsp;·&nbsp;
  <a href="https://pocketsisyphus.app"><strong>🌐 pocketsisyphus.app</strong></a>
</p>

<p>
  <img src="docs/assets/screenshots/0_sessions.png" width="19%" alt="Session board" />
  <img src="docs/assets/screenshots/2_chat.png" width="19%" alt="Chat / terminal" />
  <img src="docs/assets/screenshots/3_workflow.png" width="19%" alt="Workflow canvas" />
  <img src="docs/assets/screenshots/4_backlog.png" width="19%" alt="Backlog AI" />
  <img src="docs/assets/screenshots/5_security.png" width="19%" alt="Security" />
</p>

</div>

## Supported code agents

You pick which code-agent CLI to use per session from a picker (the daemon spawns the CLI binary installed on your system via `node-pty`).

- **Claude Code** (Anthropic)
- **Google Antigravity (`agy`)** (Google)
- **OpenAI Codex** (OpenAI)
- **GitHub Copilot CLI** (GitHub)
- **OpenCode** (open source · OpenAI-compatible endpoint)

<!-- The SSOT for this list is the agent picker: the adapter registration order in
     iOS `ios/PocketSisyphus/Models/AgentKind.swift` + daemon `mac/daemon/src/agent/index.ts`.
     When you add/remove a code agent in the picker, update «every surface that exposes the
     agent list» together to keep them consistent (fixing only one place causes drift, where a
     new user reads «is my agent supported» differently on each surface):
       1. The "Supported code agents" list above in this README, and its Korean mirror
          `README.ko.md` (kept in sync as a doc pair).
       2. Web landing `web/content/site.en.ts` — the `agents.items` structured list + body copy
          (`meta.description`, `hero.tagline`, the «Agent usage (…)» in pricing). It is a single
          English landing page, so it is intentionally not localized.
       3. iOS in-app guide `ios/PocketSisyphus/Models/GuideContent.swift` (3 places: app intro,
          session CLI, resume candidates) + since that copy is user-facing, the translations in
          `ios/PocketSisyphus/Localizable.xcstrings` across all 10 locales (auto-extraction ≠
          translation done — product names are not translated, identical across all locales).
       4. Mac in-app guide `mac/PocketSisyphusMac/GuideContent.swift` (same 3 places) +
          `mac/PocketSisyphusMac/Localizable.xcstrings` across 10 locales.
     Naming and ordering follow the picker — product names use displayName (e.g. "GitHub Copilot
     CLI"), order follows daemon registration (Claude Code → Antigravity → Codex → Copilot →
     OpenCode). The special / non-exposed (not code agents) shell=Terminal and local_llm=Qwen Code
     are classified as «advanced tools» and are not in the "Supported code agents" list (they
     appear only under the guide's «Pro features» group).
     `scripts/agent-surfaces-lint.sh` checks these 5 surfaces against the picker SSOT. -->

Model inference itself is sent by each agent CLI directly to its own provider's API — Pocket Sisyphus does not relay that traffic.

## Core principles

> The principles below are **properties of «the two apps you run yourself — iOS · Mac»**. The data
> plane of those two apps (phone ↔ your Mac) never passes through any maintainer infrastructure.
> The **web** (`web/`) in this repository is just a static intro page (landing) — it ships only as
> a GitHub Pages build with no backend/DB — so it is not subject to the principles above. There is
> no separate community feature — questions, sharing, and bug reports all run on the public repo's
> **[GitHub Discussions](https://github.com/Wayne-Kim/pocket-sisyphus/discussions)** (the same
> destination the iOS in-app «Community» and the web footer point to). For scope, see
> [Project boundaries](#project-boundaries) below.

- 🎯 **A «one-person legion» tool — for solo developers & founders**: drive code agents «solo or as a legion» right from your phone, and build and run a service alone — no team, server, or outsourcing. The «zero external infra · zero cost · 100% OSS stack» below is the very foundation of this «self-sufficiency» — the user must be able to keep running it to the end even if the maintainer disappears (so the principles below do not conflict with this goal; rather, they exist *for* it).
- ⛔ **Zero external server dependency**: no maintainer infrastructure. Uses only the Tor distributed network + public-IP echo (ipify, etc.).
- ⛔ **Zero paid services**: no domains/certificates/relays/SaaS whatsoever.
- ⛔ **Zero external app dependency**: iOS embeds `Tor.framework` inside the main process; Mac bundles `tor` + `sshd` binaries inside the daemon.
- ✅ **The data plane is SSH**. In an environment where direct SSH reaches (a retail router + IPv6 enabled / UPnP), latency is 10–50ms.
- ✅ **Tor fallback in CGNAT/UPnP-blocked environments** works automatically — zero-config for the user.
- 🔒 **«Same Wi‑Fi only» mode (opt-in, fail-closed)**: when on, the phone ↔ Mac connect directly only via the private address on the same Wi‑Fi, and Tor / public IP / external outbound are all blocked (explicitly blocked when off-LAN). On first launch you choose the connection mode (Anywhere (Tor) / Same Wi‑Fi only) — you can still pair and use over LAN even on networks where Tor is blocked.
- ✅ **Dual cryptographic identity assurance**: `.onion` v3 (Ed25519 hash) + SSH host-key fingerprint (pinned in the pairing QR).
- ✅ **100% OSS stack**: BSD/Apache/MIT components only — this means it is *built with* OSS, not that the project «itself» is OSS (the license is the [EULA](LICENSE.md)).
- ⛔ **No VPN entitlement**: NEPacketTunnelProvider is not used → Apple Guideline 5.4 is not triggered.

### Project boundaries

This repository contains **three projects**, and the scope of the «zero external infra» principle above differs across them:

| Project | External-infra dependency | Why |
|---|---|---|
| **iOS app** (`ios/`) | ⛔ 0 | The «private» data plane from the user's phone → their Mac. Zero maintainer server/SaaS. |
| **Mac app** (`mac/`) | ⛔ 0 | The user's host/daemon. Self-sufficient with bundled `tor`+`sshd` — no external infra needed. |
| **Web** (`web/`) | Static hosting only | Just a static **intro page (landing)**. Ships only as a GitHub Pages build, no dynamic backend/DB — a lightweight marketing page, separate from the apps' «zero infra» principle. |

The community feature was **deliberately not built** — the public repo's **[GitHub Discussions](https://github.com/Wayne-Kim/pocket-sisyphus/discussions)** stands in for it (an external platform outside the repo, unrelated to «zero infra»).

<!-- Community = «one destination» SSOT. Every surface exposing a «Community / Discussions» entry
     points to the public repo's GitHub Discussions, and its label matches that destination (say
     «Discussions», never «Discord» — Discord here is only the optional session-notification
     webhook, a separate feature):
       1. Root README — README.md (here + the Core-principles note + the Cost note) + README.ko.md.
       2. Web footer — `web/content/site.en.ts` `URLS.discussions` (the URL SSOT) → `footer.links`.
       3. iOS Settings «Community» — `ios/PocketSisyphus/Views/SettingsSheet.swift`
          `CommunityLinks.discussions` (reused by the bug-report prefill + `StuckHelpLink`).
     A single surface drifting means a user following the funnel meets two different «community»
     promises — when the destination changes, change every platform's SSOT above together. -->

In short, «zero external infra» is a principle that protects the private data path of *the two apps the user runs*, not one that also binds the *public intro site* — because an intro page inherently presumes external access.

## Architecture at a glance

```
iPhone (Pocket Sisyphus.app)
  ├─ Tor.framework (in-process in the main process, lazy)
  ├─ Citadel SSH client (swift-nio-ssh)
  └─ ConnectionManager — happy eyeballs:
        direct_ipv6 / direct_ipv4 / tor_onion tried in parallel, fastest wins
       │
       │ outbound TCP (direct SSH) or outbound TCP (Tor)
       ▼
  ┌──────────────────────────────────────┐
  │  direct SSH or Tor Network (fallback) │
  └────────────────┬─────────────────────┘
                   │ inbound
                   ▼
Mac (Pocket Sisyphus.app, menu-bar only)
  ├─ tor process (hidden service — endpoint lookup + SSH-over-Tor 22 exposed)
  ├─ embedded sshd (OpenSSH portable, listens on 22022 — direct-tcpip only)
  └─ daemon (Node + Hono + WS, 127.0.0.1:7777)
       └─ PTY spawn → claude / agy / codex / copilot CLI
```

**Zero cloud hops.** On a retail router (UPnP enabled) + IPv6 environment it needs **zero router config**; default KT/LG routers (UPnP OFF) need UPnP enabled just once (or it works via Tor fallback). iPhone ships via the App Store; Mac ships via Developer ID + notarized DMG direct download + Sparkle in-app updates.

## Install (iPhone)

Get it on the App Store: **[Pocket Sisyphus on the App Store](https://apps.apple.com/app/pocket-sisyphus/id6772206998)**. The Mac companion app below must also be installed and running — the iPhone app and the Mac app work as one set (keep their versions matched).

## Install (Mac)

Paste one line into your terminal and the latest version installs automatically into `/Applications` and launches — zero prerequisites (only `curl`, which ships with macOS, is needed):

```bash
curl -fsSL https://raw.githubusercontent.com/Wayne-Kim/pocket-sisyphus/main/install.sh | bash
```

`install.sh` is a tracked file in this repository ([`install.sh`](install.sh)) — you can read the source before piping it. What it does: read the latest DMG direct link from the latest release's `appcast.xml` → download → **verify the DMG SHA-256 against the published value in `appcast.xml` (or the release notes) + verify the Apple notarization staple & code signature** (aborts on failure) → mount → copy the `.app` into `/Applications` → unmount → launch. The DMG is Apple-notarized + stapled, so it passes Gatekeeper with no warning. After install, updates are detected automatically by the app's built-in Sparkle.

For a manual install, grab the DMG from [releases/latest](https://github.com/Wayne-Kim/pocket-sisyphus/releases/latest) and drag the `.app` into `Applications`.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Threat model](docs/THREAT_MODEL.md) — assets · trust boundaries · mitigations · accepted residual risk
- [Capability-cap guardrails](docs/CAPABILITY_CAPS.md) — the spec for blocking the lethal trifecta on the personal-data path
- [Security policy · vulnerability reporting](docs/SECURITY.md) — supported versions · reporting process · response SLA (`/.well-known/security.txt`)

## Versioning policy

The Mac desktop app and the iOS app operate as one «set». So that users can identify a «compatible pair» at a glance, the marketing version (`MAJOR.MINOR.PATCH`) of the two apps is **always kept identical**.

| Class | When to bump | User impact |
|---|---|---|
| **MAJOR** | Mac ↔ iOS compatibility is **broken**. The old app rejects the new one / vice versa. | *Both* apps must be updated immediately for pairing/sessions to work. Permanently cut off from the old pair. |
| **MINOR** | One side added a **new feature** but the old side still runs its *existing features*. | Updating only one side late is OK for basic use; you just can't use the new feature. |
| **PATCH** | **100% compatible**. Bug fix / internal refactor / text change. | Updating either side late doesn't matter. |

The compatibility handshake itself works via the `/api/version` route + a set of capability strings — for the detailed model, see the module docstring in `mac/daemon/src/version.ts`.

### Version bump · deployment

The two apps' marketing version is always kept identical. **Version bumps and deployment (TestFlight / Developer ID DMG) are a maintainer-only procedure** — they are not kept in the public repository.

### Where the version is shown

Where users check their own build at runtime:
- **Mac**: click the menu-bar icon → in the popover header, to the right of «Pocket Sisyphus», `vX.Y.Z (build)`
- **iOS**: top-left ⚙ on the Sessions screen → at the bottom of the menu, `vX.Y.Z (build)`

`build` is a monotonically increasing integer stamped automatically by the deploy script every deploy via `git rev-list --count` — it always +1s even without a marketing-version bump. The «marketing version + build number» pair is used to pin down «the exact build at the time of an issue».

## Deployment

iOS and Mac have different distribution channels.

| Platform | Channel | Reason |
|---|---|---|
| **iOS** | TestFlight (App Store Connect) | iOS has no install path other than the App Store / TestFlight |
| **Mac** | Developer ID + notarization + direct DMG download + Sparkle | The daemon must access arbitrary repos in the user's home + all of `~/.claude/projects`, which inherently conflicts with the sandbox → MAS abandoned |

> **The deployment procedure (API key/certificate setup, signing/notarization, upload) is maintainer-only and not published.**
> Operational docs live in a maintainer-only `docs/ops/` (not included in this repository). For ordinary user installation, see the "Install" section above.

## Cost

The apps are free to use. Only advanced features are gated behind an optional Pro (subscription or lifetime license), and model-inference cost is billed directly by your chosen AI provider — Pocket Sisyphus does not relay it or add a margin.

| Item | Cost |
|---|---|
| Pocket Sisyphus app (iPhone + Mac) | **Free** |
| Pro — workflows · scheduling · terminal/local LLM · live preview · monitor mirroring | Optional · subscription or lifetime license (App Store) |
| Code-agent CLI usage fees | Billed directly by each provider (Anthropic / Google / OpenAI) — does not pass through us |

> The maintainer «infrastructure» cost is $0/yr for the two apps (→ [Core principles](#core-principles)). The web (intro site) uses external hosting and the community runs on GitHub Discussions, so they are separate — see [Project boundaries](#project-boundaries).

## License · Contributing

**The source is public, but the license is proprietary — this is not open source.** Source being public does NOT grant any commercial-use rights. Full text: [`LICENSE.md`](LICENSE.md).

- ✅ Anyone may view/clone the source, build it themselves on their own PC for **personal, non-commercial** use, modify it for personal use, and modify it for the purpose of contributing (PRs).
- ⛔ **Redistribution to third parties** of the source/builds, or **commercial use/sale** in any form.
- The rights to use, distribute, and sell commercially are **reserved exclusively** to the copyright holder (Wayne Kim). Official builds are provided only through the App Store / Mac distribution channels.
- **Contributing requires agreeing to [`CLA.md`](CLA.md)** — you assign the economic copyright in your contribution to the copyright holder (falling back to an exclusive license in jurisdictions where assignment is not permitted). This is what makes «commercial rights belong solely to the copyright holder» hold airtight, even through contributor code.
- **New contributor?** [`CONTRIBUTING.md`](CONTRIBUTING.md) is the one place that covers how to build each project, the checks your PR must pass, the SSOT contracts to respect, and the CLA.

> The «100% OSS stack» (in [Core principles](#core-principles) above) means it is *built with* bundled dependencies/components (BSD/Apache/MIT), not that the project «itself» is open source. The code in this repository is governed by the EULA above.
