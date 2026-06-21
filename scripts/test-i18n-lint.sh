#!/usr/bin/env bash
#
# test-i18n-lint.sh — scripts/i18n-lint.sh 의 회귀/단위 테스트.
#
# 1) «회귀 고정» (핵심): HEAD 직전 커밋(37bb50a^, 즉 12곳 수정 «이전») 상태에서 돌리면
#    그 12곳이 [A] 후보로 잡히고, 현재 HEAD 에서는 그 12곳이 사라졌음을 검증한다.
#    (git blob 비교 — 작업 트리·히스토리를 건드리지 않는다.)
# 2) «단위»: B/C/D 패턴과 제외 규칙(verbatim·주석·로깅·LocalizedStringKey·분리된 Text)을
#    합성 픽스처로 검증한다(양성/음성).
#
# 종료코드: 모든 검사 통과 0, 하나라도 실패 1.
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LINT="$SCRIPT_DIR/i18n-lint.sh"

# 12곳 수정 커밋. 그 «부모» 가 수정 직전 상태.
FIX_COMMIT="37bb50a"

PASS=0
FAIL=0
ok()   { PASS=$((PASS+1)); printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[31m✗ %s\033[0m\n' "$1"; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# 12곳 수정이 닿은 6개 파일 (commit 37bb50a stat).
FIXED_FILES=(
  "ios/PocketSisyphus/Views/ChatView.swift"
  "ios/PocketSisyphus/Views/PreviewView.swift"
  "ios/PocketSisyphus/Views/RemoteScreenView.swift"
  "ios/PocketSisyphus/Views/SessionsView.swift"
  "mac/PocketSisyphusMac/Views/SettingsWindow.swift"
  "mac/PocketSisyphusMac/Views/WorkflowWindow.swift"
)

# 12곳의 «수정 전» ternary 코어 (basename<TAB>needle). needle 은 발췌에 그대로 들어가는
# `<cond> ? "한글" : "…"` 조각 — #1/#5 는 문자열이 같아 파일명으로 구분한다.
KNOWN_12=(
  "ChatView.swift	chromeHidden ? \"컨트롤 표시\" : \"컨트롤 숨기기\""
  "ChatView.swift	isBusy ? \"음성 모델 준비 중\" : \"음성 입력 (누르고 말하기)\""
  "ChatView.swift	isRecording ? \"녹음 중\" : \"\""
  "PreviewView.swift	up ? \"실행 중\" : \"꺼짐\""
  "RemoteScreenView.swift	chromeHidden ? \"컨트롤 표시\" : \"컨트롤 숨기기\""
  "RemoteScreenView.swift	running ? \"화면 수신 대기 중…\" : \"화면 캡처 시작 중…\""
  "RemoteScreenView.swift	screen_permission\" ? \"Mac 에서 화면 기록 권한이 필요해요\""
  "RemoteScreenView.swift	saved ? \"즐겨찾기 적용\" : \"즐겨찾기 저장\""
  "SessionsView.swift	ok ? \"준비됨\" : \"필요\""
  "SettingsWindow.swift	granted ? \"허용됨\" : \"아직 허용되지 않음\""
  "SettingsWindow.swift	ok ? \"설치됨\" : \"미설치\""
  "WorkflowWindow.swift	cron\" ? \"크론 스케줄\" : \"GitHub 변경 감지 (준비 중)\""
)

# ── (1a) 수정 «전»(37bb50a^) → 6파일 추출 후 린트 → 12곳이 [A] 로 잡혀야 한다 ──────────
echo "[1a] 회귀: 수정 직전(${FIX_COMMIT}^) 상태에서 12곳이 [A] 후보로 잡히는가"
BEFORE_DIR="$TMP/before"
for f in "${FIXED_FILES[@]}"; do
  mkdir -p "$BEFORE_DIR/$(dirname "$f")"
  if ! git -C "$REPO_ROOT" show "${FIX_COMMIT}^:$f" > "$BEFORE_DIR/$f" 2>/dev/null; then
    bad "git blob 추출 실패: ${FIX_COMMIT}^:$f"
  fi
done
BEFORE_OUT="$(cd "$REPO_ROOT" && "$LINT" --soft --quiet "$BEFORE_DIR" 2>&1)"

before_hits=0
for entry in "${KNOWN_12[@]}"; do
  base="${entry%%	*}"; needle="${entry#*	}"
  # 발췌에 needle 이 들어가고 [A] 이며 해당 basename 파일인 줄이 있는가
  if printf '%s\n' "$BEFORE_OUT" | grep -F "$base" | grep -F -- "[A]" | grep -Fq -- "$needle"; then
    before_hits=$((before_hits+1))
  else
    bad "수정 전인데 [A] 후보로 안 잡힘: $base — $needle"
  fi
done
[ "$before_hits" -eq 12 ] && ok "수정 전 12곳 모두 [A] 후보로 표면화됨 (12/12)" \
                          || bad "수정 전 [A] 후보 누락: $before_hits/12"

# ── (1b) 현재 HEAD → 같은 6파일에서 그 12곳이 사라졌는가(=후보에 안 뜸) ────────────────
echo "[1b] 회귀: 현재 HEAD 에서 그 12곳이 [A] 후보에서 사라졌는가"
HEAD_FILES=()
for f in "${FIXED_FILES[@]}"; do HEAD_FILES+=("$REPO_ROOT/$f"); done
HEAD_OUT="$(cd "$REPO_ROOT" && "$LINT" --soft --quiet "${HEAD_FILES[@]}" 2>&1)"

gone=0
for entry in "${KNOWN_12[@]}"; do
  base="${entry%%	*}"; needle="${entry#*	}"
  if printf '%s\n' "$HEAD_OUT" | grep -F "$base" | grep -Fq -- "$needle"; then
    bad "HEAD 인데 아직 [A] 후보로 남아있음(수정 안 됨?): $base — $needle"
  else
    gone=$((gone+1))
  fi
done
[ "$gone" -eq 12 ] && ok "HEAD 에서 12곳 모두 후보에서 사라짐 (12/12)" \
                   || bad "HEAD 에서 일부 12곳이 아직 후보로 남음: $((12-gone))곳"

# ── (2) 단위: B/C/D + 제외 규칙 픽스처 ────────────────────────────────────────────────
echo "[2] 단위: B/C/D 패턴 + 제외 규칙(verbatim/주석/로깅/LSK/분리Text)"
FX="$TMP/fixtures"; mkdir -p "$FX"
cat > "$FX/Sample.swift" <<'SWIFT'
import SwiftUI

// [A] 양성: 양 갈래 한글 ternary가 Text/래퍼 «안» 에 그대로
struct A1: View { var body: some View { Text(flag ? "예" : "아니오") } }
struct A2: View { var body: some View { EmptyView().navigationTitle(edit ? "편집" : "새로") } }

// [A] 음성: 이미 Text 두 개로 분리됨 → 통과
struct A3: View { var body: some View { flag ? Text("예") : Text("아니오") } }
struct A4: View { var body: some View { (flag ? Text("예") : Text("아니오")) } }

// [A] 제외: verbatim 의도 명시 → 통과
struct A5: View { var body: some View { Text(verbatim: flag ? "코드값" : "식별자") } }

// 제외: 주석 안의 안티패턴 → 통과
struct C1: View { var body: some View {
    // Text(flag ? "주석한글" : "주석둘")
    EmptyView()
} }

// 제외: 로깅 → 통과
func logIt() { print(flag ? "로그한글" : "로그둘") }

// [B] 양성: 한글 String 리터럴 변수 경유
struct B1: View { var body: some View {
    let title = "비번역제목"
    return Text(title)
} }
// [B] 음성: LocalizedStringKey 명시 변수 → 통과
struct B2: View { var body: some View {
    let key: LocalizedStringKey = "엘에스케이"
    return Text(key)
} }

// [C] 양성: enum case raw 한글 return
enum Status { case on, off
    var label: String { switch self { case .on: return "켜짐"; case .off: return "꺼짐2" } }
}
// [C] 양성: errorDescription 본문(case 아님) raw 한글 return
struct MyErr: LocalizedError {
    var errorDescription: String? {
        return "치명적 한글 오류"
    }
}
// [C] 음성: String(localized:) 로 감쌈 → 통과
enum Status2 { case a
    var label: String { switch self { case .a: return String(localized: "정상값") } }
}

// [C] 음성: enclosing 선언이 -> LocalizedStringKey → case 한글은 자동 localize (누수 아님)
enum Lens: String { case design, bug
    var label: LocalizedStringKey { switch self { case .design: return "엘에스케이디자인"; case .bug: return "엘에스케이디버깅" } }
}
// [C] 음성: 여러 줄 func -> LocalizedStringKey 반환 컨텍스트 «안» 의 case 한글
func lensName(_ lens: String) -> LocalizedStringKey {
    switch lens {
    case "design": return "엘에스케이렌즈디자인"
    default: return "엘에스케이렌즈기본"
    }
}
// [C] 음성: LocalizedStringResource 반환도 동일 제외
func resourceName(_ s: String) -> LocalizedStringResource {
    switch s { case "x": return "엘에스알자원"; default: return "엘에스알기본" }
}

// [C] 양성: 반환 타입이 String → case 한글이 Text(값) 로 새는 회귀 (여전히 검출)
enum RawStatus: String { case good, bad
    var label: String { switch self { case .good: return "문자열양성좋음"; case .bad: return "문자열양성나쁨" } }
}
struct RawStatusView: View {
    let s: RawStatus
    var body: some View { Text(s.label) }   // String 경유 → 카탈로그 우회 누수
}
// [C] 양성: 여러 줄 func -> String 반환 case 한글
func rawName(_ s: String) -> String {
    switch s { case "x": return "문자열함수양성"; default: return "기타" }
}
// [C] 양성(수용기준 #5): errorDescription 가 switch-case 로 String? 반환 — LSK 예외에 휩쓸리면 안 됨
enum DomainErr: LocalizedError { case auth, net
    var errorDescription: String? { switch self { case .auth: return "인증실패양성"; case .net: return "네트워크실패양성" } }
}

// [D] 양성: 중첩 보간 String(localized:)
func typeMsg(_ x: Int) -> String { return String(localized: "타입 불일치 \("\(x)")") }
// [D] 음성: 일반 보간 → 통과
func okMsg(_ x: Int) -> String { return String(localized: "값 \(x)") }
SWIFT

FX_OUT="$(cd "$REPO_ROOT" && "$LINT" --soft --quiet "$FX" 2>&1)"

# 양성 단언: 해당 [코드] 로 그 줄이 떠야 한다.
assert_hit() { # <pattern> <needle> <설명>
  if printf '%s\n' "$FX_OUT" | grep -F -- "[$1]" | grep -Fq -- "$2"; then ok "[$1] $3"
  else bad "[$1] 양성 누락: $3  (needle: $2)"; fi
}
# 음성 단언: 어떤 패턴으로도 그 줄/문구가 뜨면 안 된다.
assert_miss() { # <needle> <설명>
  if printf '%s\n' "$FX_OUT" | grep -Fq -- "$1"; then bad "오탐(떠선 안 됨): $2  (needle: $1)"
  else ok "제외 OK: $2"; fi
}

assert_hit A 'flag ? "예" : "아니오"'                 "Text 양갈래 한글 ternary"
assert_hit A 'edit ? "편집" : "새로"'                 "navigationTitle ternary"
assert_hit B 'Text(title)   ← 변수 `title`'           "한글 String 변수 경유 Text(title)"
assert_hit C 'return "켜짐"'                          "enum case raw 한글 return"
assert_hit C '치명적 한글 오류'                        "errorDescription 본문 raw 한글 return"
assert_hit D '타입 불일치'                            "중첩 보간 String(localized:)"

assert_miss 'flag ? Text("예")'                       "분리된 ternary(Text 두 개)"
assert_miss '코드값'                                  "Text(verbatim:) 명시"
assert_miss '주석한글'                                "주석 안 안티패턴"
assert_miss '로그한글'                                "print 로깅"
assert_miss '엘에스케이'                              "LocalizedStringKey 변수"
assert_miss '정상값'                                  "String(localized:) 감싼 case return"
assert_miss '값 \(x)'                                 "일반 보간(중첩 아님)"

# [C] LocalizedStringKey/Resource 반환 컨텍스트의 case 한글 → 자동 localize → 제외(음성)
assert_miss '엘에스케이디자인'                         "var -> LocalizedStringKey case return(한 줄)"
assert_miss '엘에스케이렌즈디자인'                     "func -> LocalizedStringKey case return(여러 줄)"
assert_miss '엘에스알자원'                             "func -> LocalizedStringResource case return"
# [C] String/String? 반환은 LSK 예외와 무관하게 여전히 양성
assert_hit C 'return "문자열양성좋음"'                 "var -> String case return (Text(값) 노출 회귀)"
assert_hit C 'return "문자열함수양성"'                 "func -> String case return"
assert_hit C '인증실패양성'                            "errorDescription switch-case String?(LSK 예외 비대상)"

# ── (3) 종료코드 계약 ─────────────────────────────────────────────────────────────────
echo "[3] 종료코드 계약: 후보 0→0, 후보≥1→1(기본), --soft→항상 0"
EMPTY="$TMP/empty"; mkdir -p "$EMPTY"
cat > "$EMPTY/Clean.swift" <<'SWIFT'
import SwiftUI
struct Clean: View { var body: some View { Text("정상") + Text(verbatim: "코드") } }
SWIFT
(cd "$REPO_ROOT" && "$LINT" --quiet "$EMPTY" >/dev/null 2>&1); rc_empty=$?
[ "$rc_empty" -eq 0 ] && ok "후보 0건 → 종료코드 0" || bad "후보 0건인데 종료코드 $rc_empty"

(cd "$REPO_ROOT" && "$LINT" --quiet "$FX" >/dev/null 2>&1); rc_find=$?
[ "$rc_find" -ne 0 ] && ok "후보 있음 → 비-0 종료코드($rc_find)" || bad "후보 있는데 종료코드 0"

(cd "$REPO_ROOT" && "$LINT" --soft --quiet "$FX" >/dev/null 2>&1); rc_soft=$?
[ "$rc_soft" -eq 0 ] && ok "--soft → 후보 있어도 종료코드 0" || bad "--soft 인데 종료코드 $rc_soft"

# ── (4) [O] orphan: 합성 카탈로그 ↔ 소스 픽스처 (보간 정규화 포함) ──────────────────────
# 핵심: 카탈로그 ko 키를 «보간 정규화»(%lld ↔ \(…)) 한 형태가 소스 리터럴에 없으면 orphan.
#   - 소스에 쓰이는 키 / 보간으로 쓰이는 키 → orphan 아님(음성)
#   - 소스 어디에도 없는 키 → orphan(양성), 비-ko 키는 애초에 대상 아님
#   - --orphans 없이는 [O] 점검을 «안» 한다(옵트인)
echo "[4] orphan: 카탈로그↔소스 픽스처 + 보간 정규화 + 옵트인"
ORF="$TMP/orphan"; mkdir -p "$ORF"
cat > "$ORF/Localizable.xcstrings" <<'JSON'
{
  "sourceLanguage" : "ko",
  "strings" : {
    "사용되는 문자열" : {
      "localizations" : {
        "en" : { "stringUnit" : { "state" : "translated", "value" : "Used" } },
        "ja" : { "stringUnit" : { "state" : "translated", "value" : "使用" } }
      }
    },
    "커밋되지 않은 변경 %lld개" : {
      "localizations" : {
        "en" : { "stringUnit" : { "state" : "translated", "value" : "%lld uncommitted changes" } },
        "ja" : { "stringUnit" : { "state" : "translated", "value" : "未コミット %lld 件" } }
      }
    },
    "삭제된 죽은 문자열" : {
      "localizations" : {
        "en" : { "stringUnit" : { "state" : "translated", "value" : "Dead removed string" } },
        "ja" : { "stringUnit" : { "state" : "translated", "value" : "死んだ文字列" } }
      }
    },
    "Terminal 실행 실패" : {
      "localizations" : {
        "en" : { "stringUnit" : { "state" : "translated", "value" : "Terminal launch failed" } }
      }
    },
    "번역없는 죽은키" : {
      "localizations" : { }
    },
    "PTY" : {
      "localizations" : {
        "en" : { "stringUnit" : { "state" : "translated", "value" : "PTY" } }
      }
    }
  },
  "version" : "1.0"
}
JSON
cat > "$ORF/OrphanFixture.swift" <<'SWIFT'
import SwiftUI
struct OrphanFixture: View {
    var count = 0
    var body: some View {
        Text("사용되는 문자열")
        Text("커밋되지 않은 변경 \(count)개")   // 보간 → 카탈로그 %lld 키와 정규화 후 일치
        Text(verbatim: "PTY")                  // 비-ko·verbatim — orphan 대상 아님
    }
}
SWIFT

ORF_OUT="$(cd "$REPO_ROOT" && "$LINT" --orphans --soft --quiet "$ORF" 2>&1)"

# [O] 양성: 그 키가 [O] orphan 줄로 떠야 한다.
assert_orphan() { # <key> <설명>
  if printf '%s\n' "$ORF_OUT" | grep -F -- "[O] orphan" | grep -Fq -- "$1"; then ok "[O] $2"
  else bad "[O] orphan 누락: $2  (key: $1)"; fi
}
# 음성: 그 키/문구가 출력 어디에도 떠선 안 된다(=쓰이는 키, 정규화 일치, 비-ko 제외).
assert_not_orphan() { # <needle> <설명>
  if printf '%s\n' "$ORF_OUT" | grep -Fq -- "$1"; then bad "오탐(orphan 아닌데 뜸): $2  (needle: $1)"
  else ok "non-orphan OK: $2"; fi
}

assert_orphan "삭제된 죽은 문자열"     "소스에 없는 죽은 키"
assert_orphan "Terminal 실행 실패"     "삭제된 창 문자열(브리프 예시형)"
assert_not_orphan "사용되는 문자열"    "Text() 로 쓰이는 키"
assert_not_orphan "커밋되지 않은 변경" "보간 %lld ↔ \\(count) 정규화 일치 — 오탐 방지(핵심)"
assert_not_orphan "PTY"               "비-ko 키는 orphan 대상 아님"
# 번역 0개 키도 잡되 «번역 0/» 분모 표기 확인 (브리프: 번역 0개 변형)
if printf '%s\n' "$ORF_OUT" | grep -F "번역없는 죽은키" | grep -Fq "번역 0/"; then
  ok "[O] 번역 0개 키도 잡고 «번역 0/L» 로 비용 표기"
else bad "[O] 번역 0개 키 표기 누락 (번역없는 죽은키 / 번역 0/)"; fi

# 옵트인: --orphans 없으면 [O] 점검을 «안» 한다.
NOORF_OUT="$(cd "$REPO_ROOT" && "$LINT" --soft --quiet "$ORF" 2>&1)"
if printf '%s\n' "$NOORF_OUT" | grep -Fq "[O]"; then
  bad "--orphans 없이도 [O] 가 떴다(옵트인 위반)"
else ok "옵트인 OK: --orphans 없으면 [O] 미실행"; fi

# 종료코드: --orphans + orphan 존재 → 비-0, --soft 면 0.
(cd "$REPO_ROOT" && "$LINT" --orphans --quiet "$ORF" >/dev/null 2>&1); rc_orf=$?
[ "$rc_orf" -ne 0 ] && ok "--orphans + orphan 있음 → 비-0($rc_orf)" || bad "--orphans 인데 orphan 있는데 0"
(cd "$REPO_ROOT" && "$LINT" --orphans --soft --quiet "$ORF" >/dev/null 2>&1); rc_orfs=$?
[ "$rc_orfs" -eq 0 ] && ok "--orphans --soft → 0" || bad "--orphans --soft 인데 $rc_orfs"

# ── (5) 실제 카탈로그 스모크: --orphans 가 실제 두 앱에서 well-formed 하게 돈다 ──────────
# 특정 키에 결합하지 않는다(이 도구가 성공하면 그 키가 정리돼 사라지므로 자기 테스트가 깨진다).
# 대신 «end-to-end 로 돌고, [O] 섹션·O= 합계를 well-formed 하게 낸다» 만 본다.
# 주의: 실제 출력은 수백 줄 → `printf | grep -q` 는 grep 이 첫 매치에서 빠져 printf 가
#   SIGPIPE 로 죽고 pipefail 이 그 실패를 전파해 if 가 뒤집힌다. here-string(<<<)·중간 캡처로
#   writer 프로세스 없이 단일 grep 만 돌려 그 함정을 피한다.
echo "[5] 실제 카탈로그 스모크(특정 키 비결합)"
REAL_OUT="$(cd "$REPO_ROOT" && "$LINT" --orphans --soft --quiet 2>&1)"
if grep -Eq 'O=[0-9]+' <<<"$REAL_OUT"; then
  ok "실제 실행: 합계에 O=N 표기"
else bad "실제 실행 합계에 O=N 없음"; fi
# [O] 가 한 건이라도 있으면 «카탈로그 — [O] orphan(번역 N/L) — …» 형식이어야.
REAL_ORPHANS="$(grep -F "[O] orphan" <<<"$REAL_OUT" || true)"
if [ -n "$REAL_ORPHANS" ]; then
  if grep -Eq 'Localizable\.xcstrings — \[O\] orphan\(번역 [0-9]+/[0-9]+\) — ' <<<"$REAL_ORPHANS"; then
    ok "실제 [O] 출력 형식: «카탈로그 — [O] orphan(번역 N/L) — 발췌»"
  else bad "실제 [O] 출력 형식 불일치"; fi
else
  ok "실제 [O] 0건(카탈로그가 깨끗) — 형식 검사 생략"
fi

# ── (6) [T] 완역 커버리지: 합성 카탈로그(+project.yml knownRegions) ↔ 소스 픽스처 ──────────
# 핵심: 코드가 «쓰는»(=orphan 아닌) ko 키인데 비-source 로케일이 누락/빈값/state∈{new,needs_review}
#   면 [T] 양성. knownRegions(SSOT)는 옆에 둔 project.yml 에서 읽는다(로케일 하드코딩 금지 검증).
#   - 완전히 빈({}) 키는 orphan 이어도 양성(추출만 되고 안 채워짐)
#   - 부분 누락은 «non-orphan» 만 양성(orphan 부분누락은 [O] 소관 → [T] 제외)
#   - 비번역 의도(shouldTranslate:false / present 로케일 모두 원문=식별자)는 억제
#   - --coverage 없이는 [T] 점검을 «안» 한다(옵트인)
echo "[6] coverage: 카탈로그(+knownRegions)↔소스 + 빈키/부분누락/state + 억제 + 옵트인"
COV="$TMP/coverage"; mkdir -p "$COV"
# knownRegions(SSOT): ko(source)·en·ja·Base → 필수 검사 로케일 = en, ja.
cat > "$COV/project.yml" <<'YML'
name: Fixture
options:
  knownRegions: [ko, en, ja, Base]
YML
cat > "$COV/Localizable.xcstrings" <<'JSON'
{
  "sourceLanguage" : "ko",
  "strings" : {
    "커버리지 사용되는 문자열" : {
      "localizations" : {
        "en" : { "stringUnit" : { "state" : "translated", "value" : "Used" } }
      }
    },
    "커버리지 완전히 빈 키" : {
      "localizations" : { }
    },
    "커버리지 리뷰 필요 문자열" : {
      "localizations" : {
        "en" : { "stringUnit" : { "state" : "new", "value" : "Needs review" } },
        "ja" : { "stringUnit" : { "state" : "translated", "value" : "レビュー" } }
      }
    },
    "커버리지 정상 완역 문자열" : {
      "localizations" : {
        "en" : { "stringUnit" : { "state" : "translated", "value" : "Complete" } },
        "ja" : { "stringUnit" : { "state" : "translated", "value" : "完了" } }
      }
    },
    "PTY" : {
      "localizations" : {
        "en" : { "stringUnit" : { "state" : "translated", "value" : "PTY" } }
      }
    },
    "커버리지 shouldTranslate 꺼진 키" : {
      "shouldTranslate" : false,
      "localizations" : {
        "en" : { "stringUnit" : { "state" : "translated", "value" : "NoTranslate" } }
      }
    },
    "커버리지 고아 부분누락 키" : {
      "localizations" : {
        "en" : { "stringUnit" : { "state" : "translated", "value" : "OrphanPartial" } }
      }
    }
  },
  "version" : "1.0"
}
JSON
cat > "$COV/CoverageFixture.swift" <<'SWIFT'
import SwiftUI
struct CoverageFixture: View {
    var body: some View {
        Text("커버리지 사용되는 문자열")        // 비-orphan, ja 누락 → [T] 양성
        Text("커버리지 리뷰 필요 문자열")        // 비-orphan, en state=new → [T] 양성
        Text("커버리지 정상 완역 문자열")        // 비-orphan, en+ja 완역 → 음성
        Text(verbatim: "PTY")                   // 비-orphan, present(en)=원문 → 식별자 억제(음성)
        Text("커버리지 shouldTranslate 꺼진 키") // 비-orphan, shouldTranslate:false → 억제(음성)
        // "커버리지 완전히 빈 키" / "커버리지 고아 부분누락 키" 는 소스 미참조(orphan)
    }
}
SWIFT

COV_OUT="$(cd "$REPO_ROOT" && "$LINT" --coverage --soft --quiet "$COV" 2>/dev/null)"

# [T] 양성: 그 키가 [T] 미완역 줄로 떠야 한다.
assert_cov() { # <key> <설명>
  if printf '%s\n' "$COV_OUT" | grep -F -- "[T] 미완역" | grep -Fq -- "$1"; then ok "[T] $2"
  else bad "[T] 양성 누락: $2  (key: $1)"; fi
}
# 음성: 그 키가 [T] 줄로 떠선 안 된다.
assert_not_cov() { # <key> <설명>
  if printf '%s\n' "$COV_OUT" | grep -F -- "[T] 미완역" | grep -Fq -- "$1"; then
    bad "오탐([T] 떠선 안 됨): $2  (key: $1)"
  else ok "non-[T] OK: $2"; fi
}

assert_cov "커버리지 사용되는 문자열"        "비-orphan 부분 누락(ja 없음)"
assert_cov "커버리지 완전히 빈 키"           "localizations {} 빈 키(orphan 이어도 양성)"
assert_cov "커버리지 리뷰 필요 문자열"       "state=new 인 로케일(en) 미완역"
assert_not_cov "커버리지 정상 완역 문자열"   "en+ja 완역 키"
assert_not_cov "PTY"                          "present 로케일=원문(식별자) 억제"
assert_not_cov "커버리지 shouldTranslate"     "shouldTranslate:false 억제"
assert_not_cov "커버리지 고아 부분누락 키"   "orphan 부분누락은 [O] 소관 → [T] 제외"

# 빈 키는 비-source 로케일 «전부»(en, ja = 2) 누락으로 떠야 한다.
if printf '%s\n' "$COV_OUT" | grep -F "커버리지 완전히 빈 키" | grep -Eq '누락 2: '; then
  ok "[T] 빈 키: 비-source 로케일 전부(2) 누락 표기"
else bad "[T] 빈 키 누락 로케일 수 표기 오류(누락 2 기대)"; fi

# 옵트인: --coverage 없으면 [T] 점검을 «안» 한다.
NOCOV_OUT="$(cd "$REPO_ROOT" && "$LINT" --soft --quiet "$COV" 2>/dev/null)"
if printf '%s\n' "$NOCOV_OUT" | grep -Fq "[T]"; then
  bad "--coverage 없이도 [T] 가 떴다(옵트인 위반)"
else ok "옵트인 OK: --coverage 없으면 [T] 미실행"; fi

# 종료코드: --coverage + 후보 존재 → 비-0, --soft 면 0.
(cd "$REPO_ROOT" && "$LINT" --coverage --quiet "$COV" >/dev/null 2>&1); rc_cov=$?
[ "$rc_cov" -ne 0 ] && ok "--coverage + 후보 있음 → 비-0($rc_cov)" || bad "--coverage 인데 후보 있는데 0"
(cd "$REPO_ROOT" && "$LINT" --coverage --soft --quiet "$COV" >/dev/null 2>&1); rc_covs=$?
[ "$rc_covs" -eq 0 ] && ok "--coverage --soft → 0" || bad "--coverage --soft 인데 $rc_covs"

# knownRegions(SSOT) 미발견 시 그 카탈로그 커버리지 생략(로케일 하드코딩 금지) — project.yml 없는 dir.
NOYML="$TMP/coverage_noyml"; mkdir -p "$NOYML"
cp "$COV/Localizable.xcstrings" "$NOYML/Localizable.xcstrings"
NOYML_OUT="$(cd "$REPO_ROOT" && "$LINT" --coverage --soft --quiet "$NOYML" 2>&1)"
if printf '%s\n' "$NOYML_OUT" | grep -Fq "knownRegions 미발견"; then
  ok "knownRegions(SSOT) 없으면 커버리지 생략(하드코딩 금지)"
else bad "project.yml 없는데 커버리지 생략 안내 누락"; fi

# ── (7) 회귀: 실제 iOS 카탈로그의 잔존 빈 키가 [T] 양성으로 잡힌다 ───────────────────────
# 브리프 evidence: `claude --dangerously-skip-permissions` 가 든 키의 localizations 가 통째로 비어
#   9개 비-ko 로케일에서 ko 가 새어 나간다. 이 회귀가 [T] 로 «양성» 잡히는지 고정한다.
#   (이 키가 나중에 번역되거나 정리되면 이 검사는 갱신/제거한다 — 수용 기준 #7 고정 목적.)
echo "[7] 회귀: 실제 iOS 카탈로그 잔존 빈 키가 [T] 양성"
IOS_COV="$(cd "$REPO_ROOT" && "$LINT" --coverage --soft --quiet ios/PocketSisyphus 2>/dev/null)"
DANGER_LINE="$(grep -F "[T] 미완역" <<<"$IOS_COV" | grep -F "dangerously-skip-permissions" || true)"
if [ -n "$DANGER_LINE" ]; then
  ok "잔존 빈 키(claude --dangerously-skip-permissions)가 [T] 양성으로 표면화됨"
  if grep -Eq '누락 9: ' <<<"$DANGER_LINE"; then
    ok "잔존 빈 키: 비-source 9개 로케일 전부 누락 표기"
  else bad "잔존 빈 키 누락 로케일 수 표기 오류(누락 9 기대)"; fi
else
  bad "잔존 빈 키가 [T] 후보로 안 잡힘(수용 기준 #7 회귀 실패)"
fi

# ── (8) --strict (CI 게이트): A–D+[T] 차단 · [O] 비차단 · baseline 래칫 ──────────────────
# 핵심(수용 기준 ①②③): 노출 문자열은 knownRegions «전부» 채워야 통과, orphan 은 비차단(후보),
#   기존/의도된 부채는 baseline 으로 차감해 «새» 후보만 PR 을 막는다(레포의 diff-집중 래칫).
echo "[8] strict: A–D+[T] 차단 · [O] 비차단 · baseline 래칫 + 옵트인/종료코드"
STR="$TMP/strict"; mkdir -p "$STR"
# knownRegions(SSOT): ko(source)·en·ja → 필수 검사 로케일 = en, ja (스크립트가 여기서 읽음).
cat > "$STR/project.yml" <<'YML'
name: Fixture
options:
  knownRegions: [ko, en, ja, Base]
YML
cat > "$STR/Localizable.xcstrings" <<'JSON'
{
  "sourceLanguage" : "ko",
  "strings" : {
    "스트릭트 미완역 키" : {
      "localizations" : {
        "en" : { "stringUnit" : { "state" : "translated", "value" : "Partial" } }
      }
    },
    "스트릭트 완역 키" : {
      "localizations" : {
        "en" : { "stringUnit" : { "state" : "translated", "value" : "Done" } },
        "ja" : { "stringUnit" : { "state" : "translated", "value" : "完了" } }
      }
    },
    "스트릭트 죽은 키" : {
      "localizations" : {
        "en" : { "stringUnit" : { "state" : "translated", "value" : "Dead" } },
        "ja" : { "stringUnit" : { "state" : "translated", "value" : "死" } }
      }
    }
  },
  "version" : "1.0"
}
JSON
cat > "$STR/StrictFixture.swift" <<'SWIFT'
import SwiftUI
struct StrictFixture: View {
    var flag = false
    var body: some View {
        Text("스트릭트 미완역 키")    // 비-orphan, ja 누락 → [T] 차단
        Text("스트릭트 완역 키")      // 비-orphan, en+ja 완역 → 통과
        Text(flag ? "스트릭트 양갈래 한글하나" : "스트릭트 양갈래 한글둘")  // [A] 차단
        // "스트릭트 죽은 키" 는 소스 미참조 → [O] orphan(비차단)
    }
}
SWIFT

# (8a) baseline 없음 → 새 차단 [A]+[T] = 2 건이 게이트로 잡혀 비-0 종료. [O] 는 비차단.
STR_OUT="$(cd "$REPO_ROOT" && "$LINT" --strict --soft --quiet --baseline=/dev/null "$STR" 2>/dev/null)"
if printf '%s\n' "$STR_OUT" | grep -F -- "[T] 미완역" | grep -Fq -- "스트릭트 미완역 키"; then
  ok "[strict] 노출 문자열의 미완역(ja 누락)이 [T] 차단으로 잡힘(수용 기준 ①)"
else bad "[strict] [T] 차단 누락: 스트릭트 미완역 키"; fi
if printf '%s\n' "$STR_OUT" | grep -Fq -- '스트릭트 양갈래 한글하나'; then
  ok "[strict] A–D(양갈래 한글 ternary)도 차단 집합에 포함"
else bad "[strict] A–D 차단 누락"; fi
if printf '%s\n' "$STR_OUT" | grep -F -- "[T] 미완역" | grep -Fq -- "스트릭트 완역 키"; then
  bad "[strict] 오탐: 완역 키가 [T] 로 떴다"
else ok "[strict] 완역 키(en+ja)는 차단 안 됨(음성)"; fi

# 종료코드: baseline 없이 새 차단 있으면 비-0, --soft 면 0.
(cd "$REPO_ROOT" && "$LINT" --strict --quiet --baseline=/dev/null "$STR" >/dev/null 2>&1); rc_str=$?
[ "$rc_str" -ne 0 ] && ok "[strict] 새 차단 후보 있음 → 비-0($rc_str) (수용 기준: 실패 케이스)" \
                    || bad "[strict] 새 차단 있는데 종료코드 0"
(cd "$REPO_ROOT" && "$LINT" --strict --soft --quiet --baseline=/dev/null "$STR" >/dev/null 2>&1); rc_strs=$?
[ "$rc_strs" -eq 0 ] && ok "[strict] --soft → 차단 있어도 0" || bad "[strict] --soft 인데 $rc_strs"

# (8b) 래칫: 막을 때 찍는 «### BASELINE-PASTE» fingerprint 를 baseline 에 넣으면 통과(0).
PASTE="$(printf '%s\n' "$STR_OUT" | sed -n '/BASELINE-PASTE-BEGIN/,/BASELINE-PASTE-END/p' \
         | grep -v 'BASELINE-PASTE' | grep -Ev '^[[:space:]]*$')"
PASTE_N="$(printf '%s\n' "$PASTE" | grep -c . )"
[ "$PASTE_N" -eq 2 ] && ok "[strict] paste 블록에 새 차단 fingerprint 2건(A+T)" \
                     || bad "[strict] paste 블록 fingerprint 수 이상($PASTE_N, 2 기대)"
STR_BASE="$TMP/strict_base.tsv"
printf '%s\n' "$PASTE" > "$STR_BASE"
(cd "$REPO_ROOT" && "$LINT" --strict --quiet --baseline="$STR_BASE" "$STR" >/dev/null 2>&1); rc_ratchet=$?
[ "$rc_ratchet" -eq 0 ] && ok "[strict] 래칫: baseline 등재 후 동일 후보는 통과(0) (수용 기준 ③ 사람 판정)" \
                       || bad "[strict] 래칫 실패: baseline 등재했는데 $rc_ratchet"

# (8c) [O] 비차단: orphan «만» 있고 차단(A–D·[T]) 없으면 strict 는 통과(0)여야 한다(수용 기준 ③).
STRO="$TMP/strict_orphan"; mkdir -p "$STRO"
cat > "$STRO/project.yml" <<'YML'
name: Fixture
options:
  knownRegions: [ko, en, ja, Base]
YML
cat > "$STRO/Localizable.xcstrings" <<'JSON'
{
  "sourceLanguage" : "ko",
  "strings" : {
    "오펀온리 완역 키" : {
      "localizations" : {
        "en" : { "stringUnit" : { "state" : "translated", "value" : "OK" } },
        "ja" : { "stringUnit" : { "state" : "translated", "value" : "OK" } }
      }
    },
    "오펀온리 죽은 키" : {
      "localizations" : {
        "en" : { "stringUnit" : { "state" : "translated", "value" : "Dead" } },
        "ja" : { "stringUnit" : { "state" : "translated", "value" : "死" } }
      }
    }
  },
  "version" : "1.0"
}
JSON
cat > "$STRO/OrphanOnly.swift" <<'SWIFT'
import SwiftUI
struct OrphanOnly: View {
    var body: some View { Text("오펀온리 완역 키") }   // "오펀온리 죽은 키" 는 미참조 → [O] orphan
}
SWIFT
(cd "$REPO_ROOT" && "$LINT" --strict --quiet --baseline=/dev/null "$STRO" >/dev/null 2>&1); rc_oonly=$?
[ "$rc_oonly" -eq 0 ] && ok "[strict] orphan 만 있고 차단 없음 → 통과(0): [O] 비차단(수용 기준 ③)" \
                      || bad "[strict] orphan 이 게이트를 막았다(비차단 위반): $rc_oonly"
STRO_OUT="$(cd "$REPO_ROOT" && "$LINT" --strict --orphans --soft "$STRO" 2>/dev/null)"
if printf '%s\n' "$STRO_OUT" | grep -F -- "[O]" | grep -Fq -- "비차단"; then
  ok "[strict] [O] orphan 이 «비차단» 으로 표면화됨(후보)"
else bad "[strict] [O] 비차단 표기 누락"; fi
if printf '%s\n' "$STRO_OUT" | grep -F -- "[O] orphan" | grep -Fq -- "오펀온리 죽은 키"; then
  ok "[strict] --orphans 동반 시 [O] 전체 목록(죽은 키) 표면화"
else bad "[strict] --orphans 동반 [O] 목록 누락"; fi

# (8d) 기본(비-strict)은 [T]·[O] 옵트아웃 유지: 같은 픽스처에서 [A] 만 잡고 [T] 는 안 잡는다.
DEF_OUT="$(cd "$REPO_ROOT" && "$LINT" --soft --quiet "$STR" 2>/dev/null)"
if printf '%s\n' "$DEF_OUT" | grep -Fq -- "[T]"; then
  bad "[strict] 기본 실행이 [T] 를 켰다(옵트인 위반)"
else ok "[strict] 기본 실행은 [T] 미포함(옵트인 유지) — strict 만 강제"; fi

# (8e) knownRegions(SSOT) 미발견이면 strict 도 그 카탈로그 [T] 를 생략(로케일 하드코딩 금지).
STRNOY="$TMP/strict_noyml"; mkdir -p "$STRNOY"
cp "$STR/Localizable.xcstrings" "$STRNOY/Localizable.xcstrings"
cp "$STR/StrictFixture.swift" "$STRNOY/StrictFixture.swift"
STRNOY_OUT="$(cd "$REPO_ROOT" && "$LINT" --strict --soft --baseline=/dev/null "$STRNOY" 2>&1)"
if printf '%s\n' "$STRNOY_OUT" | grep -Fq "knownRegions 미발견"; then
  ok "[strict] knownRegions 없으면 [T] 생략(하드코딩 금지) — A–D 만 차단"
else bad "[strict] project.yml 없는데 [T] 생략 안내 누락"; fi

# (8f) down-ratchet: baseline 에 있지만 코드엔 없는 줄 → stale 로 표면화(비차단) + burn-down.
# 죽은 등재(고쳐졌거나 코드 이동)를 «차단 아닌 surfacing» 으로 띄우고 «고친 N · 남은 M» 진척을 보인다.
# 깨끗한 스캔 디렉터리 + 죽은 등재만으론 비-0 으로 막지 않는다(비차단).
SSTALE="$TMP/strict_stale_dir"; mkdir -p "$SSTALE"
cat > "$SSTALE/CleanFixture.swift" <<'SWIFT'
import SwiftUI
struct CleanFixture: View { var body: some View { Text("hello") } }
SWIFT
SSTALE_BASE="$TMP/strict_stale.tsv"
printf '# c\nA\tios/PocketSisyphus/GoneNowhere.swift\t죽은식별자한글\n' > "$SSTALE_BASE"
(cd "$REPO_ROOT" && "$LINT" --strict --quiet --baseline="$SSTALE_BASE" "$SSTALE" >/dev/null 2>&1); rc_st=$?
[ "$rc_st" -eq 0 ] && ok "[strict] stale: 죽은 등재만으론 비차단(0 종료)" || bad "[strict] stale 가 막음(rc=$rc_st, 비차단 기대)"
SSTALE_OUT="$(cd "$REPO_ROOT" && "$LINT" --strict --baseline="$SSTALE_BASE" "$SSTALE" 2>/dev/null)"
if printf '%s\n' "$SSTALE_OUT" | sed -n '/BASELINE-STALE-BEGIN/,/BASELINE-STALE-END/p' | grep -Fq '죽은식별자한글'; then
  ok "[strict] stale: 코드에 없는 baseline 줄이 BASELINE-STALE 로 표면화"
else bad "[strict] stale 등재가 표면화 안 됨"; fi
if printf '%s\n' "$SSTALE_OUT" | grep -q 'burn-down: 고친 부채 1건 · 남은 부채 0건'; then
  ok "[strict] stale: burn-down «고친 1 · 남은 0» 진척 표기"
else bad "[strict] burn-down 진척 라인 누락/오표기"; fi

# ── 결과 ──────────────────────────────────────────────────────────────────────────────
echo
echo "─────────────────────────────────────────────"
echo "통과 $PASS · 실패 $FAIL"
[ "$FAIL" -eq 0 ] && { echo "✅ ALL PASS"; exit 0; } || { echo "❌ FAIL"; exit 1; }
