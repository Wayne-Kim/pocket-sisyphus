**English** · [한국어](CONTRIBUTING.ko.md)

# Contributing to Pocket Sisyphus

Thanks for your interest in contributing. This guide is the single place a contributor
needs in order to answer **«what do I build, and which checks must my PR pass to be
merged?»** — the conventions themselves live in [`CLAUDE.md`](CLAUDE.md) and in the SSOT
comment blocks scattered across the README and the source; this document summarizes them
and links back, rather than restating them.

## Before you start — license & CLA (required)

**The source is public, but the license is proprietary — this is not open source.** Source
being public does **not** grant any commercial-use rights. The full terms are in
[`LICENSE.md`](LICENSE.md) (see also the [License · Contributing](README.md#license--contributing)
section of the README).

- ✅ You may view/clone the source, build it on your own machine for **personal,
  non-commercial** use, modify it for personal use, and **modify it for the purpose of
  contributing** (pull requests).
- ⛔ Redistribution of the source/builds to third parties, or commercial use/sale in any
  form, is not permitted.

**Contributing requires agreeing to the [`CLA.md`](CLA.md) once, before your first
contribution is merged.** By accepting it you assign the economic copyright in your
contribution to the copyright holder (with a fallback to an exclusive license in
jurisdictions where assignment is not permitted). To accept (pick one):

1. **Sign in your PR** — add a row to the *Signatories* table at the bottom of
   [`CLA.md`](CLA.md) with your full legal name, GitHub username, email, and date. Opening
   that PR is your signature.
2. **Email the Owner** the acceptance statement quoted in `CLA.md`.

You also warrant that each contribution is your own original work and does not infringe a
third party's rights — don't paste in code you don't have the right to submit.

## Repository layout

This repo contains **three projects**; see [Project boundaries](README.md#project-boundaries)
for why their constraints differ.

| Path | Project | What it is |
|---|---|---|
| `ios/` | **iOS app** | SwiftUI client (SSH-first + Tor fallback). |
| `mac/` | **Mac app** | SwiftUI menu-bar host. The companion `mac/daemon/` is the Node + Hono + WS daemon that spawns the agent CLIs. |
| `web/` | **Web** | Static Next.js marketing/landing page (GitHub Pages build, no backend). |

Repository docs (this file, the README, `docs/`) are kept in **both English and Korean** —
see [Documentation](#documentation--english--korean-pairs-required) below.

## Building & running

**Prerequisites:** macOS with Xcode (for the apps), [XcodeGen](https://github.com/yonaskolb/XcodeGen)
+ CocoaPods (the `.xcodeproj`/`.xcworkspace` are generated from `project.yml`), Node.js
(daemon), and `pnpm` (web). The helper scripts under `scripts/` wrap the common flows; if
you use Claude Code, the same flows are exposed as skills (shown in the last column).

| Target | Build / run | Claude Code skill |
|---|---|---|
| **iOS** (cable device) | `./scripts/dev.sh ios` — Debug build + install on the connected device | `/dev` |
| **iOS** (Wi‑Fi device) | `PS_DEV_DEVICE_UDID=<udid> ./scripts/dev.sh ios` | `/device` |
| **iOS** (simulator verify) | `./scripts/verify-ios.sh` — build → install → screenshot loop | `/verify-ios` |
| **Mac** | `./scripts/dev.sh mac` — Debug build + relaunch | `/dev` · `/dev-mac` |
| **Daemon** | `cd mac/daemon && npm ci && npm run build` | — |
| **Web** | `./scripts/dev-web.sh` (runs `pnpm` + `next dev`) | `/dev-web` |

Notes:
- The Xcode projects are **generated** — after editing `ios/project.yml` or `mac/project.yml`,
  regenerate with `xcodegen generate` (the dev scripts do this when run with `PS_DEV_REGEN=1`),
  and `pod install` runs as the iOS `postGenCommand`.
- Version bumps and deployment (TestFlight / Developer ID DMG) are a **maintainer-only**
  procedure and are not in this repo — **don't bump the marketing version in a PR.** The iOS
  and Mac apps share one identical marketing version (see [Versioning policy](README.md#versioning-policy)).

## Checks to pass before opening a PR

### CI gates (these block the merge)

| Gate | What runs | Config |
|---|---|---|
| **gitleaks** | Secret scan over the full git history (allowlist is `.gitleaks.toml`). | `.github/workflows/gitleaks.yml` |
| **i18n gate** | `./scripts/i18n-lint.sh --strict`, `./scripts/test-i18n-lint.sh`, `./scripts/doc-pair-lint.sh`, `./scripts/test-doc-pair-lint.sh` — all blocking. | `.github/workflows/i18n.yml` |
| **daemon test** | `mac/daemon`'s `vitest run` (incl. the coverage floor) — any failure blocks. | `.github/workflows/daemon-test.yml` |
| **app unit tests** | The iOS (`PocketSisyphusTests`) and Mac (`PocketSisyphusMacTests`) host-less unit tests, run on a macOS runner via `xcodebuild test` (no code signing) — any failure blocks. | `.github/workflows/app-test.yml` |

### Run locally before you push

There is no single `lint-all` wrapper — run the family scripts (all live in `scripts/`) plus
the daemon test suite. Run the ones relevant to what you touched; run all of them if unsure.

| Command | Checks for | CI-gated? |
|---|---|---|
| `./scripts/i18n-lint.sh --strict` | Localization-catalog bypass + untranslated coverage across all 10 locales. | ✅ |
| `./scripts/doc-pair-lint.sh` | English/Korean doc pairs, language-switcher header, slot inversion. | ✅ |
| `./scripts/design-lint.sh` | Color-token-policy violations in Swift (literal hues, `.white`/`.black`, global `.tint()`). | — |
| `./scripts/agent-surfaces-lint.sh` | The agent-picker SSOT vs. the 4 downstream surfaces that list the agents. | — |
| `./scripts/po-agent-lint.sh` | PO-session spawn entry points carrying the `agent:` passthrough. | — |
| `./scripts/test-*-lint.sh` | Self-tests for each lint script — run the matching one when you modify a lint. | i18n + doc-pair self-tests ✅ |
| `cd mac/daemon && npm test` | The daemon's `vitest` suite. | — |

`design-lint` / `agent-surfaces-lint` / `po-agent-lint` are heuristic checks run before
release and in the PO self-verification nodes; they are not in the public CI **yet**, but if
your change touches the relevant surface (UI color, the agent list, or the PO spawn path),
run the matching one locally so review doesn't bounce on it. Each script accepts `--help`.

## SSOT contracts to respect (summary + pointers)

[`CLAUDE.md`](CLAUDE.md) is the authoritative contributor reference. The contracts most
likely to bounce a PR:

- **Color = meaning.** The SSOT is the `Theme` in
  `ios/PocketSisyphus/DesignSystem/DesignTokens.swift` (its color-policy comment block); Mac
  mirrors the same semantic names, web mirrors them in `lib/tokens.ts` / `app/globals.css`.
  Hue is a contract: **accent = purple** (brand/selection — the default tint via the
  `AccentColor` asset), **success = green**, **danger = red**, **warning = yellow** (*real
  warnings only*), **info = blue** (rare), **pro = orange** (premium/advanced — *emphasis,
  not a warning*). Node-kind colors: start = green · task = pink · end = blue. Never confuse
  warning (yellow) with pro (orange); write the **semantic token**, never a literal
  `.orange`/`.yellow`/`.blue`; no app-wide `.tint()`; don't hardcode `.white`/`.black` for
  body content. `design-lint.sh` surfaces violations.
- **Layout changes need eyes + approval.** Any change touching position/size/spacing
  (`.frame`/`.padding`/`spacing:`/stacks/…) must be verified on a real screen (screenshot)
  and approved before commit — see the «Layout changes» section of `CLAUDE.md`.
- **Localization — 10 locales.** `ar / en / es / fr / hi / ja / ko / pt-BR / ru / zh-Hans`,
  source language `ko`. Every user-facing string must be routed through the catalog
  (`Localizable.xcstrings`) **and** translated into all 10 — auto-extraction ≠ translation
  done. Debug/log strings are exempt. `i18n-lint.sh` enforces this.
- **Documentation — English & Korean pairs.** See below.
- **Agent picker is the SSOT for the agent list.** Adding/removing a code agent means
  updating all of the surfaces that expose the list together; `agent-surfaces-lint.sh`
  checks them against the picker.

## Documentation — English & Korean pairs (required)

Repository docs are maintained in **both languages**, English primary. For a doc `NAME.md`,
the Korean version is `NAME.ko.md` in the same directory, and the **first body line** is a
language-switcher header:

- English file: `**English** · [한국어](NAME.ko.md)`
- Korean file: `[English](NAME.md) · **한국어**`

Update both in the **same commit** so they never drift. `doc-pair-lint.sh` gates the pair,
the header, and English-primary slot inversion. (Legal files — `LICENSE.md`, `CLA.md` — are
the exception: a single bilingual file, not split.)

## Commit & PR conventions

- **Branch from `main`** for your work; open the PR against `main`.
- **Commit messages** follow [Conventional Commits](https://www.conventionalcommits.org/)
  (`type(scope): summary`) — that is the repo's existing style. Keep each commit focused.
- **Keep the doc pair in sync** in the same commit (above), and **don't bump app versions**
  (maintainer-only).
- Keep the PR scoped to one change; describe *what* and *why*, and attach before/after
  screenshots for any UI/layout change.

### PR checklist

Copy this into your pull-request description and tick what applies:

```
- [ ] I have read and agree to CLA.md (signed the Signatories table or emailed acceptance).
- [ ] The change builds (iOS / Mac / daemon / web — whichever I touched).
- [ ] `./scripts/i18n-lint.sh --strict` passes (new user-facing strings translated into all 10 locales).
- [ ] `./scripts/doc-pair-lint.sh` passes (any new/edited doc has its EN+KO pair + switcher header, same commit).
- [ ] Relevant heuristic lints pass: design-lint (UI color) / agent-surfaces-lint (agent list) / po-agent-lint (PO spawn), as applicable.
- [ ] `cd mac/daemon && npm test` passes (if I touched the daemon).
- [ ] No secrets committed (gitleaks-clean).
- [ ] UI/layout changes verified on a real screen with before/after screenshots.
- [ ] I did not bump the app marketing version (maintainer-only).
```

## Questions & reporting

- **Questions, sharing, bug reports:** the public
  [GitHub Discussions](https://github.com/Wayne-Kim/pocket-sisyphus/discussions).
- **Security vulnerabilities:** follow [`docs/SECURITY.md`](docs/SECURITY.md) — do **not**
  open a public issue for a vulnerability.
