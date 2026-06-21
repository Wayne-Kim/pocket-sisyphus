**English** · [한국어](SECURITY.ko.md)

# Security Policy

Pocket Sisyphus is a product that puts «secure control» front and center. To keep that promise seriously,
we publish here the channel through which outside researchers can **responsibly** report flaws, along with our response commitments.

For the full threat model, trust boundaries, and accepted residual risk, see [`docs/THREAT_MODEL.md`](THREAT_MODEL.md);
for the defensive implementation, see [`docs/ARCHITECTURE.md`](ARCHITECTURE.md) (§4 Security model · §8 Known risks); and for
the capability caps on the personal-data path (blocking the lethal trifecta), see [`docs/CAPABILITY_CAPS.md`](CAPABILITY_CAPS.md).

---

## Supported versions

The iOS app and the Mac app operate as a single «set» and **always keep their marketing version (`MAJOR.MINOR.PATCH`) identical**
([README — Versioning policy](README.md#versioning-policy)). Security fixes are **rolled forward to the latest release** —
there is no backport to older versions.

| Version | Eligible for security fixes |
|---|---|
| **Latest release** (iOS TestFlight / latest Mac notarized DMG) | ✅ Supported |
| Previous minor (operating under the compatibility handshake) | ⚠️ Fixed forward in the next release — no separate backport |
| Old MAJOR with broken compatibility | ❌ Unsupported (re-pairing / update required) |

- iOS ships via **TestFlight**; Mac ships via **Developer ID + notarized DMG + Sparkle in-app updates**.
  Mac users get a new version within at most 1 hour via Sparkle detection, or immediately via the menu bar «Check for Updates…».
- Affected builds are identified by the «marketing version + build number» pair (see README for where the runtime displays it).
- The static landing site (`web/`) has no secrets or backend, so it is not subject to «version support» (always the latest deploy).

---

## Reporting a vulnerability

> ⚠️ **Do not post vulnerability details (especially undisclosed 0-days) to public GitHub issues/PRs, Discord, or any other public channel.**
> Please use the private path below.

### Primary channel — GitHub private security advisory (recommended)

Please report via **Security → Report a vulnerability** (Private Vulnerability Reporting) on the public distribution repository
[`Wayne-Kim/pocket-sisyphus`](https://github.com/Wayne-Kim/pocket-sisyphus):

→ <https://github.com/Wayne-Kim/pocket-sisyphus/security/advisories/new>

This path creates a private advisory thread, which is best suited for coordinating the patch, CVE issuance, and disclosure timing
together with the maintainer (coordinated disclosure).

### Secondary channel — email

If using a GitHub account is difficult: **wayne@soomgo.com** (prefix the subject with `[security]`).
Sensitive information is exchanged over an encrypted channel after separate arrangement (a dedicated PGP key is currently not published — to be arranged on request).

### Helpful things to include in a report

- The affected component (iOS app / Mac app·daemon / sshd / tor / capture helper) and version (`vX.Y.Z (build)`).
- Reproduction steps / PoC, the impact (which asset — see [THREAT_MODEL §2](THREAT_MODEL.md)), and the preconditions.
- A proposed mitigation, if possible.

---

## Response SLA

These are «target» times, given that this is an OSS project run by a single maintainer (business days, best-effort):

| Stage | Target |
|---|---|
| **Acknowledgement** | within **3 business days** |
| **Triage + initial assessment (triage / severity)** | within **7 business days** |
| **Sharing a fix plan / schedule** | progress updated in the advisory thread after triage |
| **Disclosure (coordinated disclosure)** | after the fix ships, or **at most 90 days** from the initial report — whichever is sooner, coordinated with the reporter |

For high-severity issues with evidence of active exploitation, we shorten the above schedule and prioritize them.

---

## Scope

**In-scope** — reports welcome:
- **iOS app** (`ios/`) and **Mac app + daemon** (`mac/`): the transport plane (direct SSH / Tor onion / bridge),
  the sshd allowlist, host key verification, pairing/rotation, daemon API/WS authorization, the PTY runner, screen capture / remote control,
  secret storage (Keychain), and so on — across the assets and boundaries in [THREAT_MODEL](THREAT_MODEL.md).

**Out-of-scope** — not for reporting:
- **Accepted residual risk** — the destructiveness of the user running their own agent, the terminal ANSI render surface, the server-anonymity
  forfeiture of single-hop onion, and so on. These are intended design and are spelled out in [THREAT_MODEL §6](THREAT_MODEL.md).
- The content/availability of the **static landing site** (`web/`) — it has no secrets or backend. (Report issues with the hosting platform itself
  to that platform.)
- Issues on the side of the code-agent CLI / providers (Anthropic·Google·OpenAI) APIs — please report those to the respective vendor.
- Social engineering, physical device access, and attacks that assume an already-compromised user device (trust assumptions — THREAT_MODEL §4).

---

## Safe harbor

We welcome and support good-faith security research. As long as you abide by the following, we will not take legal action against
research activity conducted under this policy and will treat it as «good faith»:

- Test only with **your own / controlled devices and your own pairing** (no access to third-party data or devices).
- Avoid service disruption, data destruction, and privacy violations, and confirm only within the minimum scope necessary.
- Report findings via the private channels above, and keep them confidential until the agreed disclosure time.

If you are unsure, please ask first — we will find a way to verify it safely together.
