**English** · [한국어](CLAUDE.ko.md)

# pocket-sisyphus — Project conventions

## Color token policy (required)

Color is used as «meaning» — the hue itself is a contract. The single definition is the `Theme` in iOS `ios/PocketSisyphus/DesignSystem/DesignTokens.swift` (the «color policy» comment block at the top is the SSOT). The Mac app (`mac/PocketSisyphusMac`) has no separate `Theme` and uses literal colors, but follows the **same contract**.

- **accent = purple** : brand/selection/primary interactive. The default tint. **The `AccentColor` asset (system purple) in both apps is the «unified» accent token** — uncolored default controls (buttons · toggles · pickers · selection checks · tab selection · links) automatically become purple thanks to this asset. iOS uses `Theme.accent`, Mac uses `Color.accentColor` for the same value. **Blue is barely used** (info · node end, roughly). Dismiss buttons like "Close/Cancel" and the "picker selected value" text are set to **`Color.primary` (neutral, light=black · dark=white)**, not an accent color.
- **success = green / danger = red / info = blue** : status signal colors.
- **warning = yellow** : *for genuine warnings/cautions only* (version mismatch · file warnings · cron errors · «setup required»). **Never use it for decoration, emphasis, or grouping.**
- **pro = orange** : *the «orange = Pro/premium/advanced» contract color.* For membership/lifetime-license-only features (workflows · scheduled jobs) and elements grouped as «advanced» (terminal · local-LLM tools, chat tool chips, session-notification mute). It is **emphasis**, not a warning.
- **Node-kind colors (`Theme.Node`)** : start=green · task=pink · end=blue. Shared by the canvas cards + the add menu. **Always** keep iOS `editorTypeColor` and Mac `wfTypeColor` in sync together.

Key rules (violating them has caused incidents):
1. **Never confuse warning (yellow) with pro (orange).** Orange is only pro, yellow is only warning. One color must not double as two meanings (no borrowing a status color for decoration — when the color policy changes, the wrong places get tinted).
2. **For workflows, only the «tab button» is orange** (alwaysOriginal icon). Ordinary buttons *inside* the tab (Settings/Help/Add/Save, etc.) keep the default tint (accent) — do not apply `.tint(pro)` to the tab content (it would bleed orange into the content too).
3. Before painting anything a new color, read the policy comment in DesignTokens first, and use a semantic token instead of literal `.orange`/`.yellow`/`.blue`.
4. **If you see «blue», it's almost always «a missing accent»** — default controls are captured by the `AccentColor` asset (purple). On Mac, don't use literal `Color.blue` as an accent — use `Color.accentColor`. **No app-wide `.tint()`** — there's an incident history where text that was originally white/primary got tinted purple. Body text/icons should be `.primary` (auto-adapting); do not hardcode `.white`/`.black`.

## Layout changes — verify with your eyes + developer approval (required)

**If you made a change that affects SwiftUI layout, «do not commit it without confirming with your eyes».** Just looking at the code and assuming «it's probably fine» means you only discover the breakage on screen (see the incident history below).

A layout change = anything that touches position/size/spacing/arrangement: `.frame` / `.padding` / `spacing:` / `.offset` / `.position` / `HStack`·`VStack`·`ZStack`·`Lazy*`·`Grid` / `Spacer` / `alignment:` / `GeometryReader` / `.fixedSize` / `.layoutPriority` / `.aspectRatio`, etc. (A «drawing»-only change of color/font only does not count.)

Procedure (commit only after going through all of this):
1. **Build·install·run + screenshot** — bring up the real screen with `/verify-ios` (simulator) or `/device`·`/dev` (real device) and capture it.
2. **Report with before/after attached** — Claude «reads» the screenshot to verify the changed screen with its eyes, and reports the before/after to the developer with attachments.
3. **Developer approval** — commit only after getting «OK as is / fix more» approval via `AskUserQuestion`.

Key pitfalls (violating them has caused incidents — `f756c74` → `e455805`):
1. **`.frame(minWidth:/minHeight:)` grows the «layout footprint», not the «tap area».** When a `.frame(minWidth: 44, minHeight: 44)` was put on the 28pt `ChatKeyButton` (chat virtual key · image-attach button) for a11y, the small visual box floated in the center of a 44pt cell, leaving ~16pt of dead space on each side of every button → tools/keypad all spread apart. To widen only the tap target, grow the visual size itself, or follow the HIG 44pt exception for dense keys.
2. **A shared component bleeds into «every screen that uses it».** `ChatKeyButton` is shared by chat + the mirroring control bar — when you fix one, check both.
3. `.claude/hooks/guard-layout-change.sh` detects layout-token edits via PostToolUse and reminds you of the procedure above. It won't trigger on a pure logic change.

## iOS localization (required)

The iOS app supports 10 languages: `ar / en / es / fr / hi / ja / ko / pt-BR / ru / zh-Hans`. The source language is `ko`, the catalog is `ios/PocketSisyphus/Localizable.xcstrings`. **When you add a new Korean string that appears on a user-facing screen, you must always route it through the catalog.** Otherwise the ko original shows even in the English locale.

### What counts as «user-facing»
- Every string SwiftUI draws on screen: `Text`, `Button`, `Label`, `Picker`, `TextField` placeholder, `Alert` title/message, `confirmationDialog` title, `Section` header/footer, `.navigationTitle`, `.help`, `.accessibilityLabel`, copy inside a toast/sheet, etc.
- Strings that may be displayed, like `Error.errorDescription`, `LocalizedError`, and a `ViewModel`'s `lastError`.
- *Debug/logging (`print`, `NSLog`, `os_log`, `Logger().info/debug/error/...`, the `[Tag] ...` prefix pattern) is not user-facing → fine to leave in Korean.*

### Patterns where auto-localize «works» (write it like this and the catalog picks it up)

```swift
Text("세션을 만들어요")                  // ✅ Text's init takes a LocalizedStringKey
Button("저장") { ... }                    // ✅
Label("글자 작게", systemImage: "...")    // ✅
.navigationTitle("설정")                  // ✅
.accessibilityLabel("닫기")               // ✅
Text("커밋되지 않은 변경 \(count)개")     // ✅ interpolation too (\(count) → extracted as a %lld key)
```

### Anti-patterns where auto-localize «does not work» (fix on sight)

```swift
// ❌ via a String variable — goes to the Text(_:String) init, so it isn't localized
let title = "설정"
Text(title)
//   ↓ fix: make title's type LocalizedStringKey
let title: LocalizedStringKey = "설정"
Text(title)

// ❌ a ternary may be inferred as String → neither enters the catalog
Text(loading ? "불러오는 중…" : "준비됨")
//   ↓ split into two Texts so each takes the LocalizedStringKey extraction path
loading ? Text("불러오는 중…") : Text("준비됨")
.accessibilityLabel(loading ? Text("로딩 중") : Text("완료"))

// ❌ a Korean raw String in an enum's description / errorDescription
case .authFailed: return "SSH 인증 실패"
//   ↓ make a catalog key with String(localized:)
case .authFailed: return String(localized: "SSH 인증 실패")

// ❌ assigning a Korean raw to a ViewModel property (the UI displays it as-is)
self.lastError = "구매 실패: \(error.localizedDescription)"
//   ↓ String(localized:) — interpolation passes through fine
self.lastError = String(localized: "구매 실패: \(error.localizedDescription)")

// ❌ a struct field that is String + exposed via Text(field)
struct EmptyStateView: View {
    let title: String
    var body: some View { Text(title) }
}
//   ↓ make the field type LocalizedStringKey (the call site's string literal stays)
struct EmptyStateView: View {
    let title: LocalizedStringKey
    var body: some View { Text(title) }
}

// ❌ nested string interpolation — the auto-extractor can't grab the key
return String(localized: "타입 불일치 \("\(type)")")
//   ↓ split into a variable
let typeStr = "\(type)"
return String(localized: "타입 불일치 \(typeStr)")

// ❌ Text(verbatim:) — an intentional bypass. Only for things that are «truly not translation targets», like code / identifiers / onion addresses.
```

### Adding keys to the catalog + translating into 10 languages

LocalizedStringKey auto-extraction works at Xcode build time, but **extracted ≠ translated** — if every language `value` is empty, the ko original shows as a fallback even in the English locale. After you drop in a new string, verify the catalog really got all 10 languages filled in.

For bulk additions/backfills, follow the `/tmp/i18n_patch_v2.py` pattern (see commit `d3ba2a3` for the work history): write it as `ENTRIES = [(ko_key, {lang: value, ...}), ...]` and merge it into the catalog in one pass. Non-translation targets (`Pocket Sisyphus`, `한국어`, `PTY`, `·`, `•`, units, etc.) use the identical original across all languages.

Verification: `xcodebuild ... build` passes + launch in the simulator with the English locale and confirm there is no leftover Korean.

### Checklist — when adding a new string

1. Is it a SwiftUI auto-localize pattern? (Text/Button/Label/...) → just write it as a string literal.
2. Is it a spot auto-localize can't reach? (variable, ternary, struct field, enum return, ViewModel property) → reshape it per the «anti-patterns» table above.
3. Besides the ko original, did you fill the other 9 languages into the catalog?
4. Debug/logging Korean is not a catalog target — OK to leave as-is.

## Mac localization (required)

**The Mac app's localization is just as «required» as iOS's.** Same 10 languages (`ar / en / es / fr / hi / ja / ko / pt-BR / ru / zh-Hans`), source language `ko`, catalog `mac/PocketSisyphusMac/Localizable.xcstrings` (the `knownRegions` in `project.yml` is the SSOT). iOS's SwiftUI auto-localize patterns·anti-patterns·checklist apply verbatim — Mac is SwiftUI too, so `Text("…")`/`Label`/`Button`/`.alert`/`LocalizedStringKey` fields are auto-extraction targets.

Pitfalls (there's a history of ko-only showing when actually adding a new screen — the QR window's single-device notice · the Settings «Permissions» tab):
- **Auto-extraction ≠ translation done.** When you drop in a new Mac string, you must verify the 9 languages' `value`s are actually filled into `mac/PocketSisyphusMac/Localizable.xcstrings`. If empty, the ko original is exposed in every non-Korean locale.
- If you added a whole new «screen/tab», cross-check every user-facing string on that screen against the catalog (key exists + 10 languages filled).
- For bulk additions, use the same `ENTRIES = [(ko_key, {lang: value, …}), …]` merge-script pattern as iOS, only with the path pointing to the Mac catalog. Verification: `xcodebuild -scheme PocketSisyphusMac build` passes + launch in a non-ko locale and confirm no leftover Korean.
- Non-translation targets (code/identifiers/onion/units, etc.) use the identical original across all languages or `Text(verbatim:)`, same as iOS.

## Documentation — maintain English & Korean, both (required)

Repository documentation and tracked Claude skills are kept in **both English and Korean**. (This is separate from the app-localization sections above — those are about user-facing *app* strings; this is about *repository docs*.) When you create or substantially edit a doc, produce both versions.

- **English is primary.** For a doc `NAME.md`, the English version lives at `NAME.md` and the Korean version at `NAME.ko.md` in the same directory — e.g. `README.md` / `README.ko.md`, `docs/ARCHITECTURE.md` / `docs/ARCHITECTURE.ko.md`, `.claude/skills/<name>/SKILL.md` / `SKILL.ko.md`.
- **Language-switcher header** as the first body line (for skills, the first line *after* the YAML frontmatter), then a blank line:
  - English file: `**English** · [한국어](NAME.ko.md)`
  - Korean file: `[English](NAME.md) · **한국어**`
- **Cross-links follow the file's language**: inside an English file, links to sibling translated docs use the `.md` path; inside a `.ko.md` file, they use the `.ko.md` path.
- **Keep the pair in sync.** When you change one language, update the other in the **same commit** — don't let them drift.
- **Skills are functional files.** Only `SKILL.md` is loaded by Claude Code, and its YAML `description` carries the invocation triggers (incl. Korean phrases). Copy the frontmatter **byte-for-byte** into both files — translate only the body. `SKILL.ko.md` is a reference copy, not loaded.
- **Legal files are the exception** (`LICENSE.md`, `CLA.md`): keep them as a *single* bilingual file — English governing text + a Korean «비공식 요약». Do not split them (splitting would muddy which text is authoritative).
- **Licensing framing**: the repo is public but **proprietary / source-available — not open source**, and public ≠ a grant of commercial use. Docs must never imply otherwise.

Operational/maintainer-only skills (`deploy`, `deploy-web`, `submitting`) are gitignored and not part of the public repo, so they don't need a bilingual version.

## Build / Deploy

Deployment·release (TestFlight / Developer ID DMG) and version bumps are a **maintainer-only procedure** — they are not kept in the public repository.
