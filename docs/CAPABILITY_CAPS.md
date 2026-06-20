**English** · [한국어](CAPABILITY_CAPS.ko.md)

# Capability Caps — Personal-Data Path Guardrails (Blocking the Lethal Trifecta)

> **Scope**: The guardrail spec applied to every path that «injects» personal/external data into the agent
> (future opportunity briefs #1 Mail, #2 Calendar, etc.). This document is the spec SSOT for «what» is
> enforced; the threat-model perspective is bound by
> [THREAT_MODEL.md §5.8](THREAT_MODEL.md#58-indirect-prompt-injection--lethal-trifecta--agent-boundary-b5--asset-a2),
> and the execution-plane implementation context is bound by [ARCHITECTURE.md](ARCHITECTURE.md) (§12 Workflows/cron, §14 PO loop).
>
> **No UI surface** — this is a daemon/policy-layer spec. Design acceptance criteria (color, spacing, tokens) do not apply.
> However, the «confirmation gate / block» strings that these caps eventually expose through the #1·#2 UI follow the
> [locale requirement](#7-locale-requirement-mandatory).

---

## 1. Why — the lethal trifecta

When three capabilities converge «within a single session», zero-click data exfiltration (the EchoLeak / ShadowLeak family) becomes possible:

1. **Private data** — the user's mail, calendar, files, repo contents.
2. **Untrusted external content** — mail/invitations whose body is controlled by an attacker (the carrier for indirect prompt injection).
3. **External communication capability** — mail send · arbitrary HTTP POST/PUT/DELETE · git push · arbitrary webhook/Discord payloads ·
   MCP tools that send data outward.

This app already runs the agent in **unattended autonomous execution** via `skip_permissions`·cron·workflows, granting it
shell, file, and network access (ARCHITECTURE §8.5, §12, §14). The moment a «personal-data input» that feeds it ② (attacker-controlled
external content) is attached, the trifecta is complete. **The defense strategy is to «sever one of the three legs (③ external communication)»** — ①·② are
intrinsic to the feature and cannot be removed, but capping ③ closes the exfiltration path.

---

## 2. Model — taint + capability classes

### 2.1 taint sources — the «external-content taint» marker

Every path that puts personal/external data into the agent context (prompt · attachments · tool results) marks that session/run as
**`external_content_tainted = true`**. The marker is **monotonic** — once tainted, it persists for the rest of that session's
lifetime and **propagates** to subsequent sessions that inherit the context (cron `session_mode=continue`, the next workflow
node, a PO worktree). There is no clearing.

Examples of taint sources (to be added by future #1·#2):
- Loading mail body/headers/attachments into context (#1).
- Loading calendar event titles, notes, inviter input into context (#2).
- Any other input «whose body a third party can control» (shared documents, webhook payloads, external issue comments, etc.).

> **Note**: Repo-internal content (README · source · issues) is already «semi-trusted» (B5, THREAT_MODEL §5.3), but the
> personal-data path additionally gathers ① (private data), so the trifecta risk is qualitatively different. The caps in this document
> **apply first to personal-data taint sources**, but the policy engine is designed so the same rules can be applied to all taint sources.

### 2.2 Capability classes

| Class | Definition | Examples |
|---|---|---|
| **READ** | Reads that send nothing outward | mail/calendar read, file read, `git ls-remote` (poll) |
| **LOCAL** | Local effect only, no outbound send | local LLM, file write within the worktree, local build/test |
| **EGRESS** | Data leaves the trust boundary (the ③ communication leg) | mail send · HTTP POST/PUT/DELETE (non-allowlist) · `git push` · arbitrary webhook/Discord payloads · outbound MCP tools |
| **SOURCE-WRITE** | Write-back to a personal-data source | sending/moving/deleting mail, creating/editing/deleting calendar entries |

EGRESS·SOURCE-WRITE are the «capped targets». READ·LOCAL are allowed by default.

---

## 3. Rules (a)–(d)

### (a) Block external-send capability in tainted sessions — sever the trifecta

> A session that has ingested calendar/mail-derived context blocks its «external-send capability» by default, or binds it to an explicit confirmation gate.

- **T1 — default-deny EGRESS when tainted**: In a session where `external_content_tainted == true`, EGRESS-class capabilities are
  **default-deny**.
- **T2 — confirmation gate for the interactive (human-present) path**: If it is a foreground conversation session where a human can
  approve in real time, EGRESS is bound to a **per-action explicit confirmation gate** instead of being blocked. The gate shows the
  **destination + payload summary + a «this session is tainted by external content» warning**, and the user must approve «this one
  instance» for it to pass (no blanket «always allow» — every EGRESS asks again).
- **T3 — hard block for the unattended (no-human) path**: On autonomous paths with no one to approve — cron · unattended workflow
  nodes · `skip_permissions` · unattended PO implementation — a gate cannot hold, so EGRESS is **hard-blocked** (not deferred to a
  gate). → Same conclusion as rule (c).
- **T4 — allowlist intersection**: Even after passing the gate, or when non-tainted, the actual outbound network destination is allowed
  only if it is in the [domain allowlist](#4-domain-allowlist) (block and allowlist are AND'd).

### (b) Personal-data sources are read-only first

> Personal-data sources are read-only first; write/send requires user confirmation.

- **R1 — read-only by default**: Personal-data connectors (mail · calendar) are connected with **read scopes only**. Where possible,
  issue the OAuth/token scope itself as read-only («not having» the capability is stronger than «blocking» it).
- **R2 — SOURCE-WRITE requires explicit confirmation**: Source write-back such as sending/deleting mail or creating/editing calendar
  entries always goes through **per-action user confirmation**. No auto-approval.
- **R3 — no SOURCE-WRITE on unattended paths**: On cron/workflow/`skip_permissions`/PO unattended paths, SOURCE-WRITE is
  **not allowed at all** (there is no one to confirm).

### (c) On autonomous paths, forbid/isolate the personal-data + external-communication combination

> On autonomous paths such as cron · workflows · skip_permissions, forbid or isolate the personal-data context + external-communication
> combination.

- **C1 — no-unattended-trifecta (invariant)**: Within a single autonomous execution unit (a cron tick · a workflow run · a PO
  unattended implementation), `external_content_tainted` and EGRESS capability **cannot be active simultaneously**. The policy engine
  statically denies *before* execution starts (config-phase validation), and if taint spreads at runtime it immediately revokes that
  session's EGRESS handles.
- **C2 — isolation**: Autonomous work handling personal data runs in an **EGRESS-free isolated session** (a dedicated worktree · no
  shared credentials injected · no outbound MCP connected). Its output is left only as a local result file (`.posiworkflow/…`
  result.md, a PO report), and «after a human has reviewed it» a separate non-tainted path decides whether to send it outward.
- **C3 — consistency with the away-gate**: Existing EGRESS-type notifications such as Discord alerts **do not carry tainted-session
  content in the payload**. They send only meta signals (title · status) like «quiet for N minutes» · «cron complete» and do not
  include the body/result (preventing summary leakage). This layers an additional constraint onto the event policy in ARCHITECTURE §12.6.

### (d) Record the new attack surface in THREAT_MODEL.md

The new attack surface (indirect prompt injection → shell/file/network abuse → zero-click exfiltration) and its mitigations are recorded in
[THREAT_MODEL.md §5.8](THREAT_MODEL.md#58-indirect-prompt-injection--lethal-trifecta--agent-boundary-b5--asset-a2),
and the accepted residual risk in [§6](THREAT_MODEL.md#6-accepted-residual-risk).

---

## 4. Domain allowlist

- **Deny by default**: Outbound network (HTTP · git remote · MCP endpoint) is allowed only for hosts in the explicit allowlist.
- **Sources (set by the app)**: The official API hosts of personal-data connectors (e.g., mail/calendar provider endpoints) and the
  user's own git remote are in the default allowlist. Anything else the user must add in settings.
- **Powerless against tainted sessions**: Regardless of whether the allowlist passes, EGRESS in a tainted session is governed first by
  rule (a) (T1/T3) — the allowlist is merely an additional narrowing of the «non-tainted» path and does not replace trifecta blocking.
- **Logging**: Block/allow decisions are recorded in the daemon log together with the destination and the session taint state (debug
  strings are not locale targets).

---

## 5. MCP tool least-privilege

- **M1 — minimal exposure**: The MCP servers/tools exposed to a session are only the «minimal set needed» for that task. A
  personal-data tainted session connects only READ/LOCAL tools, and EGRESS·SOURCE-WRITE-type MCP tools are **left unconnected**.
- **M2 — per-tool capability-class tagging**: Each MCP tool is classified into a §2.2 class (outbound send / write-back / pure read).
  A tool of unclear classification is conservatively treated as EGRESS (block first).
- **M3 — no outbound MCP on autonomous paths**: On unattended paths (cron/workflow/`skip_permissions`/PO), EGRESS·SOURCE-WRITE
  MCP tools are fully disabled (part of rule C1).

---

## 6. Acceptance-criteria checklist

When implementing future #1·#2 (and other personal-data paths), check that these caps are satisfied:

- [ ] **taint marker** — the path that puts personal data into context marks the session `external_content_tainted`,
      propagates to continue/next node/worktree, and is never cleared (§2.1).
- [ ] **(a) EGRESS block/gate** — a tainted conversation session gets a per-action EGRESS confirmation gate, a tainted unattended path
      a hard block (T1–T3). The gate exposes destination + payload summary + taint warning, no blanket allow.
- [ ] **(b) read-only first** — connectors default to read-only scope, SOURCE-WRITE is per-action confirmation, unattended-path
      SOURCE-WRITE forbidden (R1–R3).
- [ ] **(c) no-unattended-trifecta invariant** — in cron/workflow/`skip_permissions`/PO, simultaneous taint+EGRESS is denied
      statically and at runtime, runs in an isolated session, notification payload excludes tainted results (C1–C3).
- [ ] **(d) threat-model record** — attack surface · mitigations · residual risk reflected in THREAT_MODEL §5.8/§6 (done).
- [ ] **allowlist** — outbound deny-by-default + allowlist, tainted sessions governed first by (a) (§4).
- [ ] **MCP least-privilege** — tool class tagging, no EGRESS·SOURCE-WRITE MCP connected to tainted/unattended sessions (§5).
- [ ] **locale** — confirmation/block strings exposed by #1·#2 are translated into [all 10 languages](#7-locale-requirement-mandatory).

---

## 7. Locale requirement (mandatory)

These capability caps will be exposed to the user as «confirmation gate / block» strings in the future #1·#2 UI. Those strings
(e.g., «This session is tainted by external mail/invitation content — external send is blocked», «Allow sending to <destination>?»,
«Personal data and external communication cannot be used together in unattended automation», etc.) must be translated into
**all 10 languages** supported by this repo:

> `ar · en · es · fr · hi · ja · ko · pt-BR · ru · zh-Hans` (source language `ko`, catalogs iOS/Mac `Localizable.xcstrings`).

Auto-extraction ≠ translation complete — verify that every language `value` is actually filled in (CLAUDE.md «iOS/Mac multilingual» section).
Debug/logging strings are not targets. Visual-design criteria such as color/tokens do not apply to this document, but when #1·#2 actually
draw the UI, use **danger (red)** for block/danger expressions and **warning (yellow)** for «setup required»-type guidance, and do not
confuse the two (CLAUDE.md «Color token policy»).
