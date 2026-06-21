---
name: verify-ios
description: >-
  iOS 변경을 에이전트가 시뮬레이터에서 «직접 보고» 검증하는 자가 검증 루프.
  빌드 → 설치 → 개발 페어링 주입 launch → (딥링크 조작) → 스크린샷을 에이전트가 읽어
  눈으로 확인한다. 사용자가 "/verify-ios", "시뮬레이터에서 확인해줘", "iOS 화면 검증",
  "구현한 거 눈으로 확인해라" 등을 요청할 때, 또는 iOS UI 변경을 구현한 뒤 스스로
  검증할 때 사용. 인자로 확인할 화면/딥링크 힌트를 줄 수 있다.
---

**English** · [한국어](SKILL.ko.md)

# /verify-ios — iOS simulator self-verification loop

When you make an iOS change, don't hand it back to a human with «please tap through it on a
real device». **Look at it yourself in the simulator and judge.** Zero human intervention
is the goal.

## Run one cycle

```bash
./scripts/verify-ios.sh                                      # build+install+launch+screenshot
./scripts/verify-ios.sh -d 'pocketsisyphus://session/<id>'   # transition the screen via deep link after launch
./scripts/verify-ios.sh -s                                   # skip the build (already built) — observe only
./scripts/verify-ios.sh -o /tmp/shot.png                     # specify the screenshot path
```

The script prints the screenshot path on its last line — **open that file directly with
Read and check it with your own eyes**, and if it differs from what you expected, fix the
code and run the cycle again.

Speed discipline (user requirement):
- **Screenshots are kept in the repo's `attachments/` folder** (the app-attachment
  convention folder, already gitignored — a dot-folder is hidden from the attachment
  preview so it can't be used). Tell the user the path when reporting results.
- **Observation (snap + check) is at most 30 seconds** — the script clamps the wait to 30s.
  If the code didn't change, you must run with `-s` (skip build, ~20s/cycle). The 10-minute
  timeout is only allowed for the «first build after a code change».

Prerequisite: the Mac app (daemon) must be running (`http://127.0.0.1:7777/health`). If
it's not up, bring it up with `/dev-mac`.

## How it works (pairing bootstrap)

- The simulator has no camera, so QR pairing isn't possible → it uses **dev pairing
  injection** (`ios/PocketSisyphus/Services/DevPairing.swift`, DEBUG+simulator only).
- The script carries the plaintext `token` + `localAdminSecret` from the daemon's
  `config.json` into launch as `SIMCTL_CHILD_PS_DEV_*` environment variables; the app then
  plants a stub pairing into the Keychain and goes straight to `127.0.0.1:7777` without
  SSH/Tor.
- Even on a daemon where the real phone is attest (Secure Enclave) registered: HTTP passes
  the localAdminSecret gate via the `X-PS-Local` header, and WS via the `?local=` query.
- **The env must be passed on every launch** (the script does it automatically). Running
  without the env tries a real Tor connection to a stub onion and fails.
- The WS `?local=` bypass requires a daemon-side `verifyWsAttest` change (2026-06-11) — if
  an older daemon than that is up, HTTP polling works fine but only the WS realtime push
  is broken (screen refresh lags by the polling interval). In that case, rebuild the daemon
  with `/dev-mac`.

## Manipulation (screen transitions)

1. **Deep link first** — enter a specific session's chat screen via
   `pocketsisyphus://session/<id>`. Look up/create the session id with the daemon API:
   ```bash
   TOKEN=$(python3 -c "import json;print(json.load(open('$HOME/Library/Application Support/PocketSisyphus/config.json'))['token'])")
   LOCAL=$(python3 -c "import json;print(json.load(open('$HOME/Library/Application Support/PocketSisyphus/config.json'))['localAdminSecret'])")
   curl -s -H "Authorization: Bearer $TOKEN" -H "X-PS-Local: $LOCAL" http://127.0.0.1:7777/api/sessions
   # create a verification session (the shell agent is lightweight):
   curl -s -H "Authorization: Bearer $TOKEN" -H "X-PS-Local: $LOCAL" -H 'Content-Type: application/json' \
     -d '{"repoPath":"/tmp/ps-verify-repo","agent":"shell","title":"VERIFY"}' http://127.0.0.1:7777/api/sessions
   ```
2. **Reproduce state by data injection** — use the same API to create sessions/messages and
   reproduce state like the list, badges, etc., then re-run and re-snap with `-s`.
3. **If a touch sequence is truly required**, use XCUITest (`ios/PocketSisyphusUITests`,
   `PocketSisyphusE2E` scheme) — only for modal/gesture flows that deep links can't reach.
   It's expensive, so last resort.

## i18n static checks (omissions you can't see in a screenshot)

An English-locale screenshot catches **visible** leftover Korean, but it misses catalog
bypasses in screens/states you can't see (HEAD history: «12 places of ternary Text
translation omission» — the build passed while ko source leaked in non-ko locales). For
changes that touch strings/translations, also check at the **code level**:

```bash
./scripts/i18n-lint.sh            # two-armed Korean ternary · Text(String variable) · raw Korean return · nested-interpolation candidates
./scripts/i18n-lint.sh --orphans  # above + catalog orphan ([O]) check (below) — dead-key maintenance sweep
./scripts/i18n-lint.sh --coverage # above + full-translation coverage ([T]) check (below) — is each knownRegions locale «actually» filled
./scripts/i18n-lint.sh --strict   # CI gate (below): blocks A–D + [T], surfaces [O] non-blocking, subtracts baseline (enforced in PR)
./scripts/design-lint.sh          # literal color (.orange/.yellow/.blue) bypass · black/white hardcode · global .tint() bleed · icon-button a11y label omission candidates
./scripts/po-agent-lint.sh        # candidates for agent passthrough omission at PO session spawn (collect/research/decide/cleanup/restart) entry points (ARCHITECTURE §14.4)
```

Candidates show up as `path:line — pattern name — excerpt`. Prioritize the candidates this
change (diff) **newly introduced** — it's not a tool that blocks all pre-existing i18n
debt. If it really isn't a translation target, make it explicit with `Text(verbatim:)` and
it'll be excluded from the scan. If there are candidates, the exit code is non-0 (whether to
use it as a gate is the caller's call; `--soft` always returns 0).

### orphan (dead catalog key) — `--orphans` (opt-in maintenance sweep)

If A–D above are «source→catalog leaks», `[O]` is the **opposite direction** — it catches
the drift where a refactor changed or deleted a string so that a «ko key used nowhere in
code» is left dead in the catalog. It's invisible, but (a) translation cost keeps being
spent on dead strings and (b) when a similar string is added again, the stale translation
gets dragged in and drifts to the wrong place. When a catalog ko key's **interpolation-
normalized** form (`%@`/`%lld`/`%1$@`/`%.1f`/`%%` ↔ `\(…)`) matches no string literal
anywhere in the app source, it's surfaced as `catalog — [O] orphan(translations N/L) —
excerpt` (the bigger N/L, the higher the cost frozen dead = clean up first). Interpolation
normalization is the key part — without it, live keys (`변경 %lld개` ↔ source `변경 \(n)개`)
all become false positives.

It's **not included** in the default run (a periodic cleanup, not a per-diff gate). Run it
once after a «big refactor / string deletion that touches translations» to recover dead
keys. But it **doesn't auto-delete** — places that look up keys dynamically at runtime like
`Text(LocalizedStringKey(variable))` can't be resolved statically and can be false
positives. «Before» deleting from the catalog, a human confirms the key really isn't used
(including runtime/backend strings) and then deletes it.

### untranslated (full-translation coverage) — `--coverage` (opt-in untranslated gate)

If `[O]` is a «dead key code doesn't use», `[T]` is the **opposite** — a ko key that code
«uses» (i.e. not an orphan) but where some/all locales of `knownRegions` (the SSOT in each
app's `project.yml`, excluding `Base`·source) have (a) missing `stringUnit`/`variations`,
(b) an empty `value` string, or (c) `state∈{new,needs_review}`, surfaced as
`catalog — [T] untranslated(missing N: locales) — excerpt`. It statically blocks, «before»
the build, the «auto-extraction ≠ translation complete» regression that CLAUDE.md nails
down — where ko leaks in the English locale (the «ko-only visible» incident on new Mac
screens). Locales are read from project.yml `knownRegions`, **not hardcoded**. Non-
translation intent (`shouldTranslate:false`, or all present locales being source=identifier/
unit) is suppressed by reusing the heuristic [O] uses. A key whose `localizations` is
«entirely empty» (`{}`) is extracted-only-and-unfilled untranslated, so it's reported even
if it's an orphan (other «partial» omissions are non-orphan only — orphan partial omissions
are [O]'s domain).

It's **not included** in the default run (opt-in). After adding new strings, run it once to
confirm «all 10 locales are filled». The cure is «filling translations» (a human/translation
patch script), not auto-generation — for non-translation intent, make it explicit with
`Text(verbatim:)`·`shouldTranslate:false`·all-locales=source and it's excluded. The exit-code
convention is the same (candidates≥1→non-0, `--soft`→always 0, `--quiet` supported).

### CI gate — `--strict` (enforced in PR)

`--coverage`/`--orphans` being opt-in meant they were skipped in the default run and there
was no CI enforcement, so new exposed strings could be merged untranslated. `--strict` is
the gate that closes that hole: it bundles **A–D + [T] as blocking** and **[O] as non-
blocking** (orphans are surfaced as candidates for human judgment — false-positive prone via
dynamic lookup — so they never fail the gate). Locales come from `knownRegions` (SSOT), never
hardcoded. To avoid CI being born red on pre-existing debt, blocking candidates listed in the
**baseline** (`scripts/i18n-lint-baseline.tsv`, override with `--baseline=PATH` or
`I18N_LINT_BASELINE`) are **subtracted** from the gate — only «new» (non-baselined) blocking
candidates fail the PR (the repo's «focus on what the diff newly introduced» ratchet). When
the gate blocks, it prints the candidates' fingerprints in a `### BASELINE-PASTE-BEGIN..END`
block — if it's known/intended debt, paste those lines straight into the baseline; if it's a
real omission, fill the translation (or fix the catalog bypass) instead. CI runs
`./scripts/i18n-lint.sh --strict` + `./scripts/test-i18n-lint.sh` (the detection-logic self-
test) on every PR via `.github/workflows/i18n.yml`.

A screenshot only sees «visible» colors — color-policy violations in screens/states you
can't see (the drift CLAUDE.md's «Color Token Policy» calls out as having «an incident
history of being broken») are caught as text by `design-lint.sh`. Same tone/contract:
candidates show up as `path:line  excerpt  ← violation kind · recommended token`, you
prioritize the candidates this change (diff) **newly introduced** (it doesn't block all
pre-existing color debt either), and if intentional, make it explicit with
`// design-lint: allow` on that line and it's excluded. The exit-code convention is the same
as i18n-lint.sh (candidates≥1→non-0, `--soft`→always 0). But checks that need rendering,
like «actual contrast ratio · warning↔pro meaning discrimination», are the job of the
«judgment criteria» screenshot above, not this lint.

A screenshot also can't see «silent» regressions where «a tool is ignored» — if the code
agent the user picked in the picker isn't carried to the daemon at a PO session spawn entry
point, it always falls back to claude_code with no toast/error on screen (ARCHITECTURE §14.4
«bug repeated 3+ times»). `po-agent-lint.sh` catches that entrance as text: **P1** an
`agent:` argument omission on iOS spawn calls (startPoCollection/…/decidePoBrief), **P2** a
picker not covering the per-state (shipped/rejected) action on a screen that uses the picker
(PoAgentSection), **P3** a daemon `routes/po.ts` handler not reading `body.agent` or not
passing it to the session spawn. Same tone/contract (candidates≥1→non-0, `--soft`→always 0),
and legitimate «intentional nil» (picker not shown / old daemon) is not a candidate because
the `agent:` label stays on the call as-is. Make a genuine exception explicit with
`// po-agent-lint: allow`. A new entry point catches up once you add it in the single
whitelist (method · route · spawn-helper names) inside the script.

## Judgment criteria

- Look at whether the **changed UI is drawn as expected** in the screenshot — color tokens
  (purple=accent, orange=pro, yellow=warning), layout, strings (whether Korean leftovers
  remain if the English locale).
- If a connection-failure screen / PairView shows, the injection broke: diagnose in this
  order — daemon running? → env delivered? →
  `xcrun simctl spawn booted log show --last 2m --predicate 'process == "PocketSisyphus"'`
  and its `[DevPairing]`/`[ConnMgr]` logs.
- Check a different locale: `xcrun simctl spawn booted defaults write pe.wayne.pocketsisyphus AppleLanguages '(en)'`
  then re-run with `-s` (when verification is done, restore with `defaults delete`).

## Remainder unverifiable in the simulator — request user verification only then

- **Haptics/vibration**, **the camera QR pairing flow itself** (the very path DevPairing
  bypasses),
- **Secure Enclave attest / Face ID lock (LockView)** — the simulator has no SE,
- **Cellular/real network/Tor channel quality** (the simulator goes straight over loopback,
  so the happy-eyeballs · Tor fallback path never even runs), same for the **SSH channel
  connection flow**,
- **Real-device performance/heat/background suspend behavior**, **push/Discord
  notification → deep-link cold launch**.

For a change that touches the above items, request real-device confirmation from the user
for that part only, with it spelled out, and verify the rest yourself end-to-end with this
loop.
