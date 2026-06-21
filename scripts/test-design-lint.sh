#!/usr/bin/env bash
#
# test-design-lint.sh — scripts/design-lint.sh 의 회귀/단위 테스트.
#
# 1) «단위»: L/W/T/A/S/R/O/I 여덟 패밀리 각각의 positive/negative 픽스처로 검출·비검출을 단언한다
#    (합성 픽스처 — 작업 트리·히스토리를 건드리지 않는다). L 패밀리는 iOS·Mac «모두» raw
#    .orange/.yellow/.blue 를 후보로 잡고(Mac 도 DesignTokens.swift 에 Theme 색 미러가 도입돼
#    raw hue 가 warning↔pro 혼동을 숨기는 사각이 닫혔다), Theme.pro/.warning 의미 상수 경유·
#    토큰정의 파일(DesignTokens.swift 화이트리스트)·allow 는 «안» 잡히는지까지 픽스처로 검증한다.
#    S/R(spacing·radius)은 «토큰값 SSOT = 실제 DesignTokens.swift» 를 파싱하므로, 권장 토큰명이
#    실제 토큰(보정으로 추가된 Spacing.xxxxl=32·Radius.sm=8 포함)을 정확히 가리키는지, 그리고
#    온그리드 무토큰(20)·오프그리드(14)를 반올림하지 «않고» 구분 표기하는지까지 단언한다.
#    O/I(opacity·IconSize)는 «토큰값과 정확히 일치» 하는 리터럴만 후보임을(임의 opacity(0.5)·임의
#    frame·width≠height 비정사각은 비대상) + 권장명이 실제 토큰(Opacity.badge·IconSize.l 등)을
#    가리킴을 단언한다.
# 2) «제외 규칙»: DesignTokens.swift 화이트리스트·`// design-lint: allow`·Text/Label 동반·
#    .shadow/배경·neutral/accent tint, S/R 의 토큰 사용·변수 인자·0/1 미만이 «안» 잡히는지 음성 검증.
# 3) «종료코드 계약»: 후보 0→0, 후보≥1→1(기본), --soft→항상 0 (i18n-lint.sh 와 동일).
# 4) «스모크»: 실제 소스 루트에 돌려 크래시 없이(종료코드 0/1) 완료하는지 확인.
# 5) «--strict baseline 래칫»: i18n-lint --strict 와 동형. 후보를 baseline 으로 차감해 «새»(미등재)
#    후보만 비-0 으로 막고, baseline 등재 후엔 통과(0)하며, 막을 때 «### BASELINE-PASTE» 블록을
#    찍는지 + 실제 scripts/design-lint-baseline.tsv 로 repo 가 0 통과(기존 부채 차감)하는지 단언한다.
#
# 종료코드: 모든 검사 통과 0, 하나라도 실패 1.
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LINT="$SCRIPT_DIR/design-lint.sh"

PASS=0
FAIL=0
ok()   { PASS=$((PASS+1)); printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[31m✗ %s\033[0m\n' "$1"; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

FX="$TMP/fixtures"
mkdir -p "$FX/ios" "$FX/PocketSisyphusMac"

# ── iOS 픽스처 (iOS 경로: Theme 토큰을 쓰는 게 정답이라 .orange/.yellow/.blue 전부 후보) ──────────
cat > "$FX/ios/Sample.swift" <<'SWIFT'
import SwiftUI

// ── [L] 의미 토큰 우회 리터럴 색 ─────────────────────────────────────────────
// [L] 양성: 리터럴 .orange / .yellow / Color.blue (Theme.pro/.warning/.info 를 써야 함)
struct LPos: View { var body: some View {
    Text("프로").foregroundStyle(.orange)
    Text("주의").foregroundStyle(.yellow)
    Text("정보").foregroundStyle(Color.blue)
} }
// [L] 음성: 의미 토큰 / AccentColor 경유는 정답 → 통과
struct LNeg: View { var body: some View {
    Text("강조").foregroundStyle(Theme.pro)          // ok_theme_pro
    Text("틴트").foregroundStyle(Color.accentColor)  // ok_accent_color
} }
// [L] 음성: 의도적 우회 — design-lint: allow 면 통과
struct LAllow: View { var body: some View {
    Text("예외").foregroundStyle(.orange)  // design-lint: allow
} }

// ── [W] 하드코딩 흑백 ────────────────────────────────────────────────────────
// [W] 양성: .white / .black 을 전경/틴트에 하드코딩
struct WPos: View { var body: some View {
    Text("흰글자").foregroundStyle(.white)
    Text("검글자").foregroundColor(.black)
    Text("삼항").foregroundStyle(on ? .white : .primary)
} }
// [W] 음성: 자동 적응색 / 그림자 / 전체배경 — 본문 색이 아님 → 통과
struct WNeg: View { var body: some View {
    Text("자동").foregroundStyle(.primary)
    Text("그림자마커").shadow(color: .black.opacity(0.2), radius: 4)
    Color.black  // bg_black_marker (전체화면 배경 — 본문 색 아님)
} }

// ── [T] 콘텐츠/전역 .tint() 번짐 ─────────────────────────────────────────────
// [T] 양성: 컨테이너(TabView/WindowGroup/NavigationStack)에 건 비-중립 tint
struct TPosTab: View { var body: some View {
    TabView {
        Text("탭콘텐츠")
    }
    .tint(Theme.pro)
} }
struct TPosWindowGlobal: App { var body: some Scene {
    WindowGroup {
        Text("앱루트")
    }
    .tint(Theme.info)
} }
struct TPosSameLine: View { var body: some View {
    NavigationStack { Text("내비콘텐츠") }.tint(Theme.pro)  // tpos_sameline
} }
// [T] 음성: per-element tint / 중립(primary) / accent(=기본) → 통과
struct TNeg: View { var body: some View {
    Button("버튼프로") { save() }.tint(Theme.pro)          // tneg_button_pro
    NavigationStack { Text("중립") }.tint(Color.primary)   // tneg_neutral
    NavigationStack { Text("기본") }.tint(Theme.accent)    // tneg_accent
} }

// ── [A] 아이콘 전용 버튼 접근성 라벨 누락 ────────────────────────────────────
// [A] 양성: Image(systemName:) 만 든 버튼에 .accessibilityLabel 없음
struct APos: View { var body: some View {
    Button(action: doDeleteApos) {
        Image(systemName: "trash.apos")
    }
} }
// [A] 음성: 라벨 있음 / 텍스트 동반 / Label → 통과
struct ANegLabeled: View { var body: some View {
    Button { doGear() } label: {
        Image(systemName: "gear.aneg")
    }
    .accessibilityLabel(Text("설정버튼라벨"))
} }
struct ANegText: View { var body: some View {
    Button("저장아네그") { doSave() }   // aneg_text_button
} }
struct ANegLabelView: View { var body: some View {
    Button { doTrash() } label: {
        Label("삭제아네그", systemImage: "trash.labelview")
    }
} }
// [A] 음성: 커스텀 키버튼(ChatKeyButton) — accessibilityLabel: 파라미터가 «다음 줄» 에 옴.
//          라인 기반이면 못 잡아 오탐났지만, 호출 블록 범위 스캔은 라벨이 있음을 안다 → 통과.
struct ANegParamMultiline: View { var body: some View {
    ChatKeyButton(
        tint: .secondary,
        accessibilityLabel: "파일탐색아네그",
        action: { doBrowseAneg() },
    ) {
        Image(systemName: "folder.anegparam")
    }
} }
// [A] 음성: 같은 줄 파라미터 라벨도 통과.
struct ANegParamSameLine: View { var body: some View {
    ChatKeyButton(accessibilityLabel: "스페이스아네그", action: { doSpaceAneg() }) {
        Image(systemName: "space.anegsame")
    }
} }
// [A] 양성: 같은 커스텀 키버튼인데 «라벨 파라미터를 의도적으로 제거» → 여전히 검출.
struct APosNoParamLabel: View { var body: some View {
    ChatKeyButton(tint: .secondary, action: { doNoLabelApos() }) {
        Image(systemName: "bolt.aposnolabel")
    }
} }
SWIFT

# ── Mac 픽스처 (Mac 경로: 이제 DesignTokens.swift 에 Theme 색 미러가 있어, raw .orange/.yellow/.blue
#    는 «의미를 숨기는» 후보다. 의미 상수(Theme.pro/.warning) 경유·토큰정의 파일·allow 만 제외) ────────
cat > "$FX/PocketSisyphusMac/Sample.swift" <<'SWIFT'
import SwiftUI

// [L] Mac 양성: raw 리터럴 .orange/.yellow/.blue 는 의미 상수 부재 → 후보.
//   Theme 없던 시절 «.orange=pro» 가정이 깨졌다 — raw orange 는 warning↔pro 혼동을 숨긴다.
struct MacLRaw: View { var body: some View {
    Text("맥주황raw").foregroundStyle(.orange)  // mac_orange_pos
    Text("맥노랑raw").foregroundStyle(.yellow)  // mac_yellow_pos
    Text("맥파랑raw").foregroundStyle(.blue)    // mac_blue_pos
} }
// [L] Mac 음성: 의미 상수(Theme.pro/.warning) 경유 = 정답 → 통과 (pro 강조 orange 정상 사용은 안 잡힘)
struct MacLSemantic: View { var body: some View {
    Text("맥프로").foregroundStyle(Theme.pro)            // mac_pro_legit
    Text("맥경고").foregroundStyle(Theme.warning)        // mac_warning_legit
    Text("맥액센트").foregroundStyle(Color.accentColor)  // mac_accent_legit
} }
// [L] Mac 음성: 의도적 우회 allow → 통과
struct MacLAllow: View { var body: some View {
    Text("맥예외").foregroundStyle(.orange)  // design-lint: allow  mac_orange_allow
} }
SWIFT

# ── Mac 토큰정의 픽스처 (basename DesignTokens.swift = 화이트리스트 — raw 색이 정상인 SSOT) ──────────
# iOS 와 동일한 EXCLUDE 계약: 토큰 «정의» 파일은 통째로 제외돼 후보를 만들지 않는다(Mac 도 동일).
cat > "$FX/PocketSisyphusMac/DesignTokens.swift" <<'SWIFT'
import SwiftUI
// Mac 의미-색 레이어(iOS Theme 색 미러). 여기선 raw 색이 정상 — 화이트리스트로 통째 제외돼야 한다.
enum Theme {
    static let pro = Color.orange       // mac_tokendef_orange
    static let warning = Color.yellow   // mac_tokendef_yellow
}
SWIFT

# ── S·R 픽스처 (spacing/radius 리터럴 — 토큰값 SSOT 는 «실제» DesignTokens.swift 를 파싱) ─────────
# 린트는 REPO_ROOT 의 DesignTokens.swift 를 읽어 토큰표를 만든다. 그래서 「pad32spos」 는 보정으로
# 추가된 Theme.Spacing.xxxxl(32), 「corner8rpos」 는 Theme.Radius.sm(8) 을 «정확한 이름» 으로 권장해야
# 한다 — 이 단언이 곧 「권장 토큰이 실제 존재하는 토큰명을 가리킨다」 + 「보정이 반영됐다」 의 검증이다.
cat > "$FX/ios/SpacingRadius.swift" <<'SWIFT'
import SwiftUI

// ── [S] Spacing 리터럴 (Theme.Spacing 우회) ──────────────────────────────────
// [S] 양성(토큰화): 리터럴이 토큰값과 «정확히 일치» → Theme.Spacing.<크기> 권장(값 동일 = 픽셀 불변)
struct SPosTokenize: View { var body: some View {
    VStack(spacing: 8) { Text("m8spos") }                  // → Theme.Spacing.m
    HStack(spacing: 10) { Text("l10spos") }                // → Theme.Spacing.l (10 은 토큰이라 오프-4그리드여도 토큰화)
    Text("pad32spos").padding(.horizontal, 32)             // → Theme.Spacing.xxxxl (보정 추가 토큰)
    HStack { Spacer(minLength: 8); Text("spacer8spos") }   // → Theme.Spacing.m (Spacer(minLength:))
} }
// [S] 양성(온그리드 무토큰): 20 은 4pt 온그리드인데 토큰 없음 → 「토큰 추가 검토」(반올림-강제 금지)
struct SPosAddToken: View { var body: some View {
    VStack(spacing: 20) { Text("grid20spos") }
} }
// [S] 음성(비-그리드): 오프그리드 14 는 토큰화/반올림 후보가 «아님» — 토큰명을 권장하지 않는다.
//      (BacklogView 빈 상태의 14 가 바로 이 경우 → 쌍둥이 정합으로 «사람이» xxl 토큰화하는 자리.)
struct SNegOffGrid: View { var body: some View {
    VStack(spacing: 14) { Text("offgrid14sneg") }
} }
// [S] 음성: 이미 토큰 사용 → 리터럴 숫자가 없으니 비대상
struct SNegToken: View { var body: some View {
    VStack(spacing: Theme.Spacing.m) { Text("tokenused_sneg") }
    Text("padtoken_sneg").padding(.horizontal, Theme.Spacing.xxxxl)
} }
// [S] 음성: 변수/보간 인자 → 숫자 없음 → 비대상
struct SNegVar: View { let gap: CGFloat = 8; var body: some View {
    VStack(spacing: gap) { Text("varspacing_sneg") }
} }
// [S] 음성: allow 주석 / 0·1 미만(레이아웃 토큰 아님 — padding(0)·minLength 0)
struct SNegExempt: View { var body: some View {
    VStack(spacing: 8) { Text("allow8_sneg") }   // design-lint: allow
    Text("zero_sneg").padding(0)
    HStack { Spacer(minLength: 0); Text("spacer0_sneg") }
    Text("one_sneg").padding(1)
} }

// ── [R] Radius 리터럴 (Theme.Radius 우회) ────────────────────────────────────
// [R] 양성(토큰화): cornerRadius 리터럴이 토큰값과 정확히 일치
struct RPos: View { var body: some View {
    Text("corner12rpos").background(RoundedRectangle(cornerRadius: 12))            // → Theme.Radius.l
    Text("corner8rpos").background(RoundedRectangle(cornerRadius: 8, style: .continuous))  // → Theme.Radius.sm (보정 추가)
} }
// [R] 음성(비-그리드): cornerRadius 14 오프그리드 → 토큰명 권장 안 함(반올림-강제 금지)
struct RNegOffGrid: View { var body: some View {
    Text("corner14rneg").background(RoundedRectangle(cornerRadius: 14))
} }
// [R] 음성: 토큰 사용 / allow
struct RNegExempt: View { var body: some View {
    Text("cornertoken_rneg").background(RoundedRectangle(cornerRadius: Theme.Radius.l))
    Text("cornerallow_rneg").background(RoundedRectangle(cornerRadius: 8))  // design-lint: allow
} }
SWIFT

# ── O·I 픽스처 (opacity/IconSize 리터럴 — 토큰값 SSOT 는 «실제» DesignTokens.swift 의
#    Theme.Opacity(.06/.12/.18/.30)·Theme.IconSize(36/44/48/56/64) 를 파싱) ─────────────────────
# O·I 는 S·R 과 달리 «토큰값과 정확히 일치» 하는 리터럴만 후보다(온그리드/오프그리드·0/1 반올림
# 개념 없음). 권장 토큰명이 실제 토큰(Opacity.badge·IconSize.l 등)을 가리키는지까지 단언한다.
cat > "$FX/ios/OpacityIconSize.swift" <<'SWIFT'
import SwiftUI

// ── [O] Opacity 리터럴 (Theme.Opacity 우회) ──────────────────────────────────
// [O] 양성(토큰화): .opacity 리터럴이 토큰값과 «정확히 일치» → Theme.Opacity.<단계> 권장
struct OPos: View { var body: some View {
    Image(systemName: "a").foregroundStyle(Theme.accent.opacity(0.18))   // o18opos → Theme.Opacity.badge
    Text("o06opos").background(Theme.accent.opacity(0.06))               // → Theme.Opacity.hairline
    Text("o30opos").overlay(Theme.accent.opacity(0.30))                 // → Theme.Opacity.border
    Text("o12chain_opos").foregroundStyle(.white.opacity(0.12))         // 체이닝(.white.opacity) → Theme.Opacity.fill
} }
// [O] 음성: 토큰셋과 안 겹치는 임의 opacity → 후보 아님(의도/시맨틱)
struct ONegArbitrary: View { var body: some View {
    Text("oneg_half").opacity(0.5)
    Text("oneg_quarter").opacity(0.25)
} }
// [O] 음성: 이미 토큰 사용(숫자 없음) / allow
struct ONegExempt: View { var body: some View {
    Text("oneg_token").opacity(Theme.Opacity.badge)
    Text("oneg_allow").opacity(0.18)  // design-lint: allow
} }

// ── [I] IconSize 정사각 프레임 리터럴 (Theme.IconSize 우회) ───────────────────
// [I] 양성(토큰화): .frame(width: N, height: N) 정사각 N 이 토큰값과 일치
struct IPos: View { var body: some View {
    Image(systemName: "b").frame(width: 44, height: 44)                  // i44ipos → Theme.IconSize.l
    Image(systemName: "c").frame(width: 36, height: 36)                  // i36ipos → Theme.IconSize.m
    Image(systemName: "d").frame(width: 64, height: 64)                  // i64ipos → Theme.IconSize.xxxl
} }
// [I] 음성: width≠height(아이콘 아님) — 한 변이 토큰값이어도 후보 아님
struct INegNonSquare: View { var body: some View {
    Image(systemName: "e").frame(width: 44, height: 60)                  // ineg_nonsquare
    Color.red.frame(width: 160, height: 14)                             // ineg_dummy (placeholder 더미)
} }
// [I] 음성: 토큰셋과 안 겹치는 임의 정사각 치수 → 후보 아님
struct INegArbitrary: View { var body: some View {
    Image(systemName: "f").frame(width: 100, height: 100)               // ineg_arbitrary
} }
// [I] 음성: 변수 인자(숫자 없음) / allow
struct INegExempt: View { let side: CGFloat = 44; var body: some View {
    Image(systemName: "g").frame(width: side, height: side)            // ineg_var
    Image(systemName: "h").frame(width: 44, height: 44)  // design-lint: allow  ineg_allow
} }
SWIFT

FX_OUT="$(cd "$REPO_ROOT" && "$LINT" --soft --quiet "$FX" 2>&1)"

# 양성 단언: 해당 [코드] 로 그 needle 줄이 떠야 한다.
assert_hit() { # <pattern> <needle> <설명>
  if printf '%s\n' "$FX_OUT" | grep -F -- "[$1]" | grep -Fq -- "$2"; then ok "[$1] $3"
  else bad "[$1] 양성 누락: $3  (needle: $2)"; fi
}
# 음성 단언: 어떤 패턴으로도 그 needle 가 뜨면 안 된다.
assert_miss() { # <needle> <설명>
  if printf '%s\n' "$FX_OUT" | grep -Fq -- "$1"; then bad "오탐(떠선 안 됨): $2  (needle: $1)"
  else ok "제외 OK: $2"; fi
}
# 양성+권장 단언: needle 줄이 [code] 로 뜨고, 그 줄의 «권장» 문구가 기대값을 «정확히» 포함해야 한다.
#   (토큰화면 실제 토큰명 Theme.X.<크기>, 온그리드 무토큰이면 「토큰 추가 검토」 문구 등.)
assert_rec() { # <code> <needle> <expect_rec> <설명>
  local line
  line="$(printf '%s\n' "$FX_OUT" | grep -F -- "[$1]" | grep -F -- "$2")"
  if [ -n "$line" ] && printf '%s\n' "$line" | grep -Fq -- "$3"; then ok "[$1] $4"
  else bad "[$1] 양성/권장 불일치: $4  (needle: $2  기대: $3)"; fi
}
# 비-그리드 단언: needle 줄이 (떠도) «토큰명 반올림 권장» 을 달면 안 된다 — 오프그리드를 가까운
#   토큰으로 강제 반올림하면 픽셀이 옮겨간다(레포 「1px 도 안 바뀐다」 원칙 위반). 「비-그리드」 표기만 허용.
assert_no_round() { # <needle> <kind: Spacing|Radius> <설명>
  local line
  line="$(printf '%s\n' "$FX_OUT" | grep -F -- "$1")"
  if printf '%s\n' "$line" | grep -Eq -- "권장: Theme\.$2\."; then
    bad "오프그리드 강제 반올림(떠선 안 됨): $3  (needle: $1)"
  else ok "비-그리드(반올림-강제 안 함): $3"; fi
}

echo "[1] [L] 리터럴 색 우회 (iOS·Mac 모두 셋다 — Mac 도 Theme 미러 도입) + 제외(토큰정의·의미상수·accent·allow)"
assert_hit L '.foregroundStyle(.orange)'        "iOS .orange 리터럴"
assert_hit L '.foregroundStyle(.yellow)'        "iOS .yellow 리터럴"
assert_hit L 'Color.blue'                       "iOS Color.blue 리터럴"
assert_hit L 'mac_orange_pos'                   "Mac raw .orange (의미 상수 부재 → 후보)"
assert_hit L 'mac_yellow_pos'                   "Mac raw .yellow (의미 상수 부재 → 후보)"
assert_hit L 'mac_blue_pos'                     "Mac raw .blue (accent 누락 의심)"
# 권장 단언: raw orange 는 pro↔warning 판별을 위해 Theme.pro 를(경고면 Theme.warning), yellow 는 Theme.warning 을 가리켜야 한다.
assert_rec  L 'mac_orange_pos' 'Theme.pro'      "Mac raw .orange 권장 = Theme.pro(경고 의미면 Theme.warning)"
assert_rec  L 'mac_yellow_pos' 'Theme.warning'  "Mac raw .yellow 권장 = Theme.warning"
assert_miss 'ok_theme_pro'                      "Theme.pro 의미 토큰"
assert_miss 'ok_accent_color'                   "Color.accentColor (AccentColor 에셋 경유)"
assert_miss 'design-lint: allow'                "// design-lint: allow 우회"
assert_miss 'mac_pro_legit'                     "Mac Theme.pro 의미 상수(pro 강조 정상 사용 → 안 잡힘)"
assert_miss 'mac_warning_legit'                 "Mac Theme.warning 의미 상수 (→ 안 잡힘)"
assert_miss 'mac_accent_legit'                  "Mac Color.accentColor (→ 안 잡힘)"
assert_miss 'mac_orange_allow'                  "Mac .orange // design-lint: allow → 스킵"
assert_miss 'mac_tokendef_orange'               "Mac DesignTokens.swift 토큰정의 raw .orange → 화이트리스트(안 잡힘)"
assert_miss 'mac_tokendef_yellow'               "Mac DesignTokens.swift 토큰정의 raw .yellow → 화이트리스트(안 잡힘)"

echo "[2] [W] 흑백 하드코딩 + 제외(.primary·그림자·전체배경)"
assert_hit W '.foregroundStyle(.white)'         ".foregroundStyle(.white)"
assert_hit W '.foregroundColor(.black)'         ".foregroundColor(.black)"
assert_hit W 'on ? .white : .primary'           "삼항 안의 .white"
assert_miss '.foregroundStyle(.primary)'        ".primary 자동 적응색"
assert_miss '그림자마커'                         ".shadow(color: .black…) — 본문 색 아님"
assert_miss 'bg_black_marker'                   "Color.black 전체화면 배경"

echo "[3] [T] 콘텐츠/전역 tint 번짐 + 제외(per-element·neutral·accent)"
assert_hit T '.tint(Theme.pro)'                 "TabView 컨테이너 tint (멀티라인)"
assert_hit T '.tint(Theme.info)'                "WindowGroup 전역 tint"
assert_hit T 'tpos_sameline'                    "NavigationStack 같은-줄 tint"
assert_miss 'tneg_button_pro'                   "per-element Button .tint(Theme.pro)"
assert_miss 'tneg_neutral'                      "컨테이너 .tint(Color.primary) 중립"
assert_miss 'tneg_accent'                       "컨테이너 .tint(Theme.accent) (=기본)"

echo "[4] [A] 아이콘 전용 버튼 접근성 라벨 누락 + 제외(라벨·텍스트·Label)"
assert_hit A 'doDeleteApos'                      "Image-only 버튼 라벨 없음"
assert_hit A 'doNoLabelApos'                     "커스텀 키버튼 라벨 파라미터 제거 → 검출"
assert_miss 'gear.aneg'                          "버튼에 .accessibilityLabel 있음"
assert_miss 'aneg_text_button'                   "텍스트 라벨 버튼"
assert_miss 'trash.labelview'                    "Label(텍스트+아이콘) 버튼"
assert_miss 'folder.anegparam'                   "커스텀 키버튼 accessibilityLabel: 파라미터(멀티라인)"
assert_miss 'space.anegsame'                     "커스텀 키버튼 accessibilityLabel: 파라미터(같은 줄)"

echo "[5] [S]/[R] spacing·radius 리터럴 (토큰화 / 온그리드-무토큰 / 비-그리드) + 제외(토큰·allow·0·1·변수)"
# 양성(토큰화) — 권장이 «실제» 토큰명을 정확히 가리켜야 한다(보정된 SSOT 기준).
assert_rec  S 'm8spos'        'Theme.Spacing.m'      "spacing:8 → Theme.Spacing.m"
assert_rec  S 'l10spos'       'Theme.Spacing.l'      "spacing:10 → Theme.Spacing.l (오프-4그리드 토큰)"
assert_rec  S 'pad32spos'     'Theme.Spacing.xxxxl'  ".padding 32 → Theme.Spacing.xxxxl (보정 추가 토큰)"
assert_rec  S 'spacer8spos'   'Theme.Spacing.m'      "Spacer(minLength:8) → Theme.Spacing.m"
assert_rec  R 'corner12rpos'  'Theme.Radius.l'       "cornerRadius:12 → Theme.Radius.l"
assert_rec  R 'corner8rpos'   'Theme.Radius.sm'      "cornerRadius:8 → Theme.Radius.sm (보정 추가 토큰)"
# 양성(온그리드 무토큰) — 가까운 토큰으로 반올림하지 말고 「토큰 추가 검토」 로 구분 표기.
assert_rec  S 'grid20spos'    '토큰 추가 검토'        "spacing:20 온그리드 무토큰 → 토큰 추가 검토(반올림 금지)"
# 음성(비-그리드) — 오프그리드 14 는 토큰 반올림 권장을 «달면 안 된다».
assert_no_round 'offgrid14sneg' 'Spacing'  "spacing:14 오프그리드 — 토큰 반올림 안 함"
assert_no_round 'corner14rneg'  'Radius'   "cornerRadius:14 오프그리드 — 토큰 반올림 안 함"
# 음성(제외) — 이미 토큰 사용 / 변수 인자 / allow / 0·1 미만은 후보가 아니다.
assert_miss 'tokenused_sneg'  "이미 Theme.Spacing.m 사용 → 비대상(리터럴 아님)"
assert_miss 'padtoken_sneg'   "이미 Theme.Spacing.xxxxl 사용 → 비대상"
assert_miss 'varspacing_sneg' "변수 인자 spacing: gap → 비대상(숫자 없음)"
assert_miss 'allow8_sneg'     "spacing:8 // design-lint: allow → 스킵"
assert_miss 'zero_sneg'       ".padding(0) → 스킵(레이아웃 토큰 아님)"
assert_miss 'spacer0_sneg'    "Spacer(minLength: 0) → 스킵"
assert_miss 'one_sneg'        ".padding(1) → 스킵"
assert_miss 'cornertoken_rneg' "이미 Theme.Radius.l 사용 → 비대상"
assert_miss 'cornerallow_rneg' "cornerRadius:8 // design-lint: allow → 스킵"

echo "[5b] [O]/[I] opacity·IconSize 리터럴 (토큰값 정확 일치만 후보) + 제외(임의값·토큰·변수·allow·비정사각)"
# 양성(토큰화) — 권장이 «실제» Opacity/IconSize 토큰명을 정확히 가리켜야 한다.
assert_rec  O 'o18opos'        'Theme.Opacity.badge'    ".opacity(0.18) → Theme.Opacity.badge"
assert_rec  O 'o06opos'        'Theme.Opacity.hairline' ".opacity(0.06) → Theme.Opacity.hairline"
assert_rec  O 'o30opos'        'Theme.Opacity.border'   ".opacity(0.30) → Theme.Opacity.border"
assert_rec  O 'o12chain_opos'  'Theme.Opacity.fill'     ".white.opacity(0.12) 체이닝 → Theme.Opacity.fill"
assert_rec  I 'i44ipos'        'Theme.IconSize.l'       ".frame(44×44) → Theme.IconSize.l"
assert_rec  I 'i36ipos'        'Theme.IconSize.m'       ".frame(36×36) → Theme.IconSize.m"
assert_rec  I 'i64ipos'        'Theme.IconSize.xxxl'    ".frame(64×64) → Theme.IconSize.xxxl"
# 음성(제외) — 토큰셋과 안 겹치는 임의값·토큰 사용·변수·allow·비정사각/더미는 후보가 아니다.
assert_miss 'oneg_half'        ".opacity(0.5) 임의값 → 비대상(토큰 비일치)"
assert_miss 'oneg_quarter'     ".opacity(0.25) 임의값 → 비대상"
assert_miss 'oneg_token'       "이미 Theme.Opacity.badge 사용 → 비대상(숫자 없음)"
assert_miss 'oneg_allow'       ".opacity(0.18) // design-lint: allow → 스킵"
assert_miss 'ineg_nonsquare'   ".frame(width≠height) → 정사각 아님 → 비대상"
assert_miss 'ineg_dummy'       ".frame(160×14) placeholder 더미 → 비대상"
assert_miss 'ineg_arbitrary'   ".frame(100×100) 임의 정사각 → 비대상(토큰 비일치)"
assert_miss 'ineg_var'         ".frame(side×side) 변수 인자 → 비대상(숫자 없음)"
assert_miss 'ineg_allow'       ".frame(44×44) // design-lint: allow → 스킵"

# ── (6) 종료코드 계약 ─────────────────────────────────────────────────────────────────
echo "[6] 종료코드 계약: 후보 0→0, 후보≥1→1(기본), --soft→항상 0"
EMPTY="$TMP/empty"; mkdir -p "$EMPTY"
cat > "$EMPTY/Clean.swift" <<'SWIFT'
import SwiftUI
struct Clean: View { var body: some View {
    Text("정상").foregroundStyle(Theme.accent)
    Button("저장") { save() }
} }
SWIFT
(cd "$REPO_ROOT" && "$LINT" --quiet "$EMPTY" >/dev/null 2>&1); rc_empty=$?
[ "$rc_empty" -eq 0 ] && ok "후보 0건 → 종료코드 0" || bad "후보 0건인데 종료코드 $rc_empty"

EMPTY_MSG="$(cd "$REPO_ROOT" && "$LINT" "$EMPTY" 2>&1)"
printf '%s\n' "$EMPTY_MSG" | grep -Fq "후보 0건" && ok "빈/매치0 → 「후보 0건」 한 줄" \
  || bad "빈/매치0 인데 「후보 0건」 안내 없음"

(cd "$REPO_ROOT" && "$LINT" --quiet "$FX" >/dev/null 2>&1); rc_find=$?
[ "$rc_find" -ne 0 ] && ok "후보 있음 → 비-0 종료코드($rc_find)" || bad "후보 있는데 종료코드 0"

(cd "$REPO_ROOT" && "$LINT" --soft --quiet "$FX" >/dev/null 2>&1); rc_soft=$?
[ "$rc_soft" -eq 0 ] && ok "--soft → 후보 있어도 종료코드 0" || bad "--soft 인데 종료코드 $rc_soft"

# ── (7) 스모크: 실제 소스 루트에 돌려 크래시 없이 완료(종료코드 0 또는 1) ─────────────────────
echo "[7] 스모크: 실제 iOS·Mac 소스 루트에서 크래시 없이 완료"
(cd "$REPO_ROOT" && "$LINT" --soft --quiet "$REPO_ROOT/ios/PocketSisyphus" "$REPO_ROOT/mac/PocketSisyphusMac" >/dev/null 2>&1); rc_smoke=$?
[ "$rc_smoke" -eq 0 ] && ok "실제 소스 스캔 완료(--soft → 0, 파이썬 크래시 없음)" \
  || bad "실제 소스 스캔이 비정상 종료: $rc_smoke (2=옵션오류/그 외=크래시)"
# DesignTokens.swift 화이트리스트 — 토큰 정의 파일은 후보를 만들지 않는다.
DT_OUT="$(cd "$REPO_ROOT" && "$LINT" --soft "$REPO_ROOT/ios/PocketSisyphus/DesignSystem/DesignTokens.swift" 2>&1)"
printf '%s\n' "$DT_OUT" | grep -Fq "후보 0건" && ok "DesignTokens.swift 화이트리스트(토큰 정의 → 후보 0)" \
  || bad "DesignTokens.swift 가 후보를 만들었다(화이트리스트 깨짐)"

# ── (8) --strict baseline 래칫 (i18n-lint --strict 와 동형) ────────────────────────────────
echo "[8] strict: baseline 차감 후 «새» 후보만 차단 + BASELINE-PASTE 래칫"
STR="$TMP/strict"; mkdir -p "$STR"
# 새 색-드리프트 후보(의미 토큰 밖 .orange) 하나를 둔다.
cat > "$STR/New.swift" <<'SWIFT'
import SwiftUI
struct NewProbe: View { var body: some View {
    Text("프로").foregroundStyle(.orange)
} }
SWIFT

# (8a) baseline 없음 → 새 후보가 게이트로 잡혀 비-0 종료(--soft 면 0).
(cd "$REPO_ROOT" && "$LINT" --strict --quiet --baseline=/dev/null "$STR" >/dev/null 2>&1); rc_str=$?
[ "$rc_str" -ne 0 ] && ok "[strict] baseline 없이 새 후보 → 비-0($rc_str) (수용 기준: 새 위반 차단)" \
                    || bad "[strict] 새 후보 있는데 종료코드 0"
(cd "$REPO_ROOT" && "$LINT" --strict --soft --quiet --baseline=/dev/null "$STR" >/dev/null 2>&1); rc_strs=$?
[ "$rc_strs" -eq 0 ] && ok "[strict] --soft → 차단 있어도 0" || bad "[strict] --soft 인데 $rc_strs"

# (8b) 래칫: 막을 때 찍는 «### BASELINE-PASTE» fingerprint 를 baseline 에 넣으면 통과(0).
STR_OUT="$(cd "$REPO_ROOT" && "$LINT" --strict --soft --quiet --baseline=/dev/null "$STR" 2>/dev/null)"
PASTE="$(printf '%s\n' "$STR_OUT" | sed -n '/BASELINE-PASTE-BEGIN/,/BASELINE-PASTE-END/p' \
         | grep -v 'BASELINE-PASTE' | grep -Ev '^[[:space:]]*$')"
PASTE_N="$(printf '%s\n' "$PASTE" | grep -c . )"
[ "$PASTE_N" -eq 1 ] && ok "[strict] paste 블록에 새 후보 fingerprint 1건" \
                     || bad "[strict] paste 블록 fingerprint 수 이상($PASTE_N, 1 기대)"
STR_BASE="$TMP/strict_base.tsv"
printf '%s\n' "$PASTE" > "$STR_BASE"
(cd "$REPO_ROOT" && "$LINT" --strict --quiet --baseline="$STR_BASE" "$STR" >/dev/null 2>&1); rc_ratchet=$?
[ "$rc_ratchet" -eq 0 ] && ok "[strict] 래칫: baseline 등재 후 동일 후보는 통과(0)" \
                       || bad "[strict] 래칫 실패: baseline 등재했는데 $rc_ratchet"

# (8c) 실제 repo baseline(scripts/design-lint-baseline.tsv)로 repo 스캔 시 0 통과(기존 부채 차감).
(cd "$REPO_ROOT" && "$LINT" --strict --quiet >/dev/null 2>&1); rc_repo=$?
[ "$rc_repo" -eq 0 ] && ok "[strict] 현재 repo 상태 → 게이트 통과(0): 기존 부채는 baseline 으로 차감" \
                     || bad "[strict] repo baseline 차감 실패: 종료코드 $rc_repo (새 부채 유입 or baseline 스테일)"

# (8d) down-ratchet: baseline 에 있지만 코드엔 없는 줄 → stale 로 표면화(비차단) + burn-down.
# i18n-lint --strict 와 동형. 죽은 등재(고쳐졌거나 코드 이동)를 «차단 아닌 surfacing» 으로 띄우고
# «고친 N · 남은 M» 진척을 보인다. 깨끗한 스캔 디렉터리 + 죽은 등재만으론 비-0 으로 막지 않는다.
SDIR="$TMP/strict_stale_dir"; mkdir -p "$SDIR"
cat > "$SDIR/Clean.swift" <<'SWIFT'
import SwiftUI
struct CleanProbe: View { var body: some View { Text("ok").foregroundStyle(Theme.pro) } }
SWIFT
STALE_BASE="$TMP/strict_stale.tsv"
printf '# c\nL\tmac/PocketSisyphusMac/GoneNowhere.swift\t.foregroundStyle(.orange)\n' > "$STALE_BASE"
(cd "$REPO_ROOT" && "$LINT" --strict --quiet --baseline="$STALE_BASE" "$SDIR" >/dev/null 2>&1); rc_st=$?
[ "$rc_st" -eq 0 ] && ok "[strict] stale: 죽은 등재만으론 비차단(0 종료)" || bad "[strict] stale 가 막음(rc=$rc_st, 비차단 기대)"
STALE_OUT="$(cd "$REPO_ROOT" && "$LINT" --strict --baseline="$STALE_BASE" "$SDIR" 2>/dev/null)"
if printf '%s\n' "$STALE_OUT" | sed -n '/BASELINE-STALE-BEGIN/,/BASELINE-STALE-END/p' | grep -Fq 'GoneNowhere.swift'; then
  ok "[strict] stale: 코드에 없는 baseline 줄이 BASELINE-STALE 로 표면화"
else bad "[strict] stale 등재가 표면화 안 됨"; fi
if printf '%s\n' "$STALE_OUT" | grep -q 'burn-down: 고친 부채 1건 · 남은 부채 0건'; then
  ok "[strict] stale: burn-down «고친 1 · 남은 0» 진척 표기"
else bad "[strict] burn-down 진척 라인 누락/오표기"; fi

# ── 결과 ──────────────────────────────────────────────────────────────────────────────
echo
echo "─────────────────────────────────────────────"
echo "통과 $PASS · 실패 $FAIL"
[ "$FAIL" -eq 0 ] && { echo "✅ ALL PASS"; exit 0; } || { echo "❌ FAIL"; exit 1; }
