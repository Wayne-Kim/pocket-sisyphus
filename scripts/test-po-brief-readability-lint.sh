#!/usr/bin/env bash
#
# test-po-brief-readability-lint.sh — scripts/po-brief-readability-lint.sh 의 회귀/단위 테스트.
#
# 1) «단위»: R1/R2/R3/R4 네 패밀리 각각의 positive/negative 픽스처(합성 브리프 JSON)로 검출·비검출을
#    단언한다. 특히 수용 기준이 요구하는 «빽빽한 표본 제목(파일경로.ts … — … — …)이 걸리고 평이
#    제목은 통과» 를 명시 케이스로 못박는다.
# 2) «화이트리스트»: URL·이슈번호(#123)·밑줄 없는 약어(SSH·API)·고유명(Tor) 시작은 «안» 잡히는지 음성 검증.
# 3) «종료코드 계약»: 후보 0→0, 후보≥1→1(기본), --soft→항상 0 (design-lint.sh 와 동일).
# 4) «stdin»: 인자 없이 stdin 의 JSON 을 읽어 동작하는지.
# 5) «깨진 입력»: 유효 소스 0 + JSON 파싱 실패는 비-0(게이트가 조용히 통과 안 함), --soft 면 0.
#
# 종료코드: 모든 검사 통과 0, 하나라도 실패 1.
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LINT="$SCRIPT_DIR/po-brief-readability-lint.sh"

PASS=0
FAIL=0
ok()  { PASS=$((PASS+1)); printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  \033[31m✗ %s\033[0m\n' "$1"; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# ── 픽스처: 브리프 배열 JSON (합성 — 작업 트리/히스토리 무관) ─────────────────────────────────
# 제목에 «고유 마커»(밑줄 없는 소문자 토큰)를 박아, 린트 출력의 제목 발췌 줄로 케이스를 식별한다.
# 마커는 R2(SCREAMING_SNAKE)·확장자에 안 걸리는 형태라 그 자체가 신호를 만들지 않는다.
FX="$TMP/briefs.json"
cat > "$FX" <<'JSON'
[
  { "title": "r1long 이 제목은 의도적으로 아주 길게 늘여서 팔십자 권고 한계를 분명히 넘기도록 작성한 가독성 회귀 표본 제목이며 충분히 더 길게 이어집니다 정말로",
    "problem": "사용자가 제목이 길어 한눈에 못 읽는다" },

  { "title": "lifecycle.ts 정착 r2path",
    "problem": "정착 흐름이 불명확하다" },
  { "title": "MAX_BRIEFS_PER_RUN 상한 r2sym",
    "problem": "상한이 헷갈린다" },

  { "title": "정착 — 대기 — 전이 r3dash",
    "problem": "단계가 많다" },

  { "title": "r4backtick 정리",
    "problem": "`parseBriefDraft` 가 신뢰 못 할 입력에 약하다" },
  { "title": "r4path 검증",
    "problem": "executor.ts:537 의 검증이 길이만 본다" },
  { "title": "r4snake 상한",
    "problem": "MAX_BRIEFS 상한이 선언과 다르다" },
  { "title": "r4member 토큰",
    "problem": "Theme.Spacing.large 토큰을 우회한다" },

  { "title": "plainok 라벨 추가",
    "problem": "사용자가 항목을 분류할 방법이 없다" },
  { "title": "정착 — 전이 onedashok",
    "problem": "전이가 한 번 더 필요하다" },
  { "title": "SSH 연결 안정화 acronymok",
    "problem": "가끔 연결이 끊긴다" },
  { "title": "릴리스 노트 https://x.com/a.ts urltitleok",
    "problem": "노트 작성이 번거롭다" },
  { "title": "#42 관련 정리 issueok",
    "problem": "이슈가 흩어져 있다" },
  { "title": "r4urlok 보고",
    "problem": "https://github.com/o/r/issues/9 에서 보고됨" },
  { "title": "r4apiok 안정화",
    "problem": "API.fetch 가 가끔 실패한다" },
  { "title": "r4proseok 분류",
    "problem": "사용자가 분류 기준을 모른다" },

  { "title": "messages.collect.ts 보정 — 드리프트 — 빽빽 densesample",
    "problem": "보정 앵커로 제목이 다시 빽빽해진다" },
  { "title": "보정 앵커 단순화 plaindense",
    "problem": "보정 지침이 길어 읽기 어렵다" }
]
JSON

FX_OUT="$("$LINT" --soft --quiet "$FX" 2>&1)"

# 양성: 그 [코드] 로 needle(제목 마커/발췌) 줄이 떠야 한다.
assert_hit() { # <code> <needle> <설명>
  if printf '%s\n' "$FX_OUT" | grep -F -- "[$1]" | grep -Fq -- "$2"; then ok "[$1] $3"
  else bad "[$1] 양성 누락: $3  (needle: $2)"; fi
}
# 음성: 어떤 finding 으로도 그 needle 가 뜨면 안 된다.
assert_miss() { # <needle> <설명>
  if printf '%s\n' "$FX_OUT" | grep -Fq -- "$1"; then bad "오탐(떠선 안 됨): $2  (needle: $1)"
  else ok "제외 OK: $2"; fi
}

echo "[1] [R1] 제목 80자 초과"
assert_hit R1 'r1long' "긴 제목(>80자) → R1"
assert_miss 'plainok' "평이한 짧은 제목 → 후보 아님"

echo "[2] [R2] 제목 파일경로 / 전부-대문자 심볼 + 제외(약어·URL·이슈)"
assert_hit R2 'lifecycle.ts'         "제목 내 파일경로(.ts) → R2"
assert_hit R2 'MAX_BRIEFS_PER_RUN'   "제목 내 SCREAMING_SNAKE 심볼 → R2"
assert_miss 'acronymok'              "밑줄 없는 약어(SSH) → 후보 아님"
assert_miss 'urltitleok'             "제목 내 URL(안의 .ts) → 화이트리스트(후보 아님)"
assert_miss 'issueok'                "제목 내 이슈번호(#42) → 화이트리스트"

echo "[3] [R3] 제목 «—» 다중 절(2개 초과) + 제외(대시 1개)"
assert_hit R3 'r3dash'      "em-dash 2개(절 3개) → R3"
assert_miss 'onedashok'     "em-dash 1개(절 2개) → 후보 아님"

echo "[4] [R4] problem 첫 줄 코드 시작 + 제외(프로즈·URL·고유명)"
assert_hit R4 'r4backtick'  "problem 첫 줄 백틱(\`…\`) 시작 → R4"
assert_hit R4 'r4path'      "problem 첫 줄 파일:라인 시작 → R4"
assert_hit R4 'r4snake'     "problem 첫 줄 SCREAMING_SNAKE 시작 → R4"
assert_hit R4 'r4member'    "problem 첫 줄 점-멤버(Theme.Spacing.large) 시작 → R4"
assert_miss 'r4proseok'     "problem 첫 줄 평이한 프로즈 → 후보 아님"
assert_miss 'r4urlok'       "problem 첫 줄 URL 시작 → 화이트리스트"
assert_miss 'r4apiok'       "problem 첫 줄 API.fetch(고유명 멤버) → 화이트리스트"

echo "[5] 수용 기준: 빽빽한 표본 제목(파일경로 … — … —)은 걸리고 평이 제목은 통과"
assert_hit R2 'densesample'   "빽빽 표본(messages.collect.ts) 파일경로 → R2"
assert_hit R3 'densesample'   "빽빽 표본 «—» 다중 절 → R3"
assert_miss 'plaindense'      "평이한 대응 제목 → 후보 아님"

# ── (6) 종료코드 계약 ─────────────────────────────────────────────────────────────────
echo "[6] 종료코드 계약: 후보 0→0, 후보≥1→1(기본), --soft→항상 0"
CLEAN="$TMP/clean.json"
cat > "$CLEAN" <<'JSON'
[ { "title": "라벨 추가 기능", "problem": "사용자가 항목을 분류할 방법이 없다" } ]
JSON
"$LINT" --quiet "$CLEAN" >/dev/null 2>&1; rc_clean=$?
[ "$rc_clean" -eq 0 ] && ok "후보 0건 → 종료코드 0" || bad "후보 0건인데 종료코드 $rc_clean"

CLEAN_MSG="$("$LINT" "$CLEAN" 2>&1)"
printf '%s\n' "$CLEAN_MSG" | grep -Fq "후보 0건" && ok "매치0 → 「후보 0건」 한 줄" \
  || bad "매치0 인데 「후보 0건」 안내 없음"

"$LINT" --quiet "$FX" >/dev/null 2>&1; rc_find=$?
[ "$rc_find" -ne 0 ] && ok "후보 있음 → 비-0 종료코드($rc_find)" || bad "후보 있는데 종료코드 0"

"$LINT" --soft --quiet "$FX" >/dev/null 2>&1; rc_soft=$?
[ "$rc_soft" -eq 0 ] && ok "--soft → 후보 있어도 종료코드 0" || bad "--soft 인데 종료코드 $rc_soft"

# ── (7) stdin ──────────────────────────────────────────────────────────────────────
echo "[7] stdin: 인자 없이 stdin JSON 을 읽어 동작"
STDIN_OUT="$(printf '%s' '[{"title":"lifecycle.ts stdincase","problem":"x"}]' | "$LINT" --soft --quiet 2>&1)"
printf '%s\n' "$STDIN_OUT" | grep -F -- "[R2]" | grep -Fq "stdincase" \
  && ok "stdin 파이프 입력 → R2 검출" || bad "stdin 입력이 검출되지 않음"

# ── (8) 깨진 입력 ─────────────────────────────────────────────────────────────────────
echo "[8] 깨진 JSON(유효 소스 0): 비-0(게이트가 조용히 통과 안 함), --soft 면 0"
BROKEN="$TMP/broken.json"; printf '%s' '{ not json ]' > "$BROKEN"
"$LINT" --quiet "$BROKEN" >/dev/null 2>&1; rc_broken=$?
[ "$rc_broken" -ne 0 ] && ok "깨진 JSON → 비-0($rc_broken)" || bad "깨진 JSON 인데 0 종료(조용히 통과)"
"$LINT" --soft --quiet "$BROKEN" >/dev/null 2>&1; rc_broken_soft=$?
[ "$rc_broken_soft" -eq 0 ] && ok "깨진 JSON + --soft → 0" || bad "--soft 인데 종료코드 $rc_broken_soft"

# ── 결과 ──────────────────────────────────────────────────────────────────────────────
echo
echo "─────────────────────────────────────────────"
echo "통과 $PASS · 실패 $FAIL"
[ "$FAIL" -eq 0 ] && { echo "✅ ALL PASS"; exit 0; } || { echo "❌ FAIL"; exit 1; }
