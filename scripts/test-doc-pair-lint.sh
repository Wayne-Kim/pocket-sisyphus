#!/usr/bin/env bash
#
# test-doc-pair-lint.sh — scripts/doc-pair-lint.sh 의 회귀/단위 테스트.
#
# 1) «실제 레포 회귀»(핵심·수용 기준 ③④⑤): ios/README·web/README 드리프트를 쌍으로 고쳐
#    «게이트를 닫은» 뒤의 상태를 고정한다 — 기본 실행(git 추적 + 표준 허용목록)이 후보 0·
#    종료코드 0(블로킹 게이트 통과)이고, 두 README 쌍·허용목록에 등재된 web/AGENTS.md·
#    web/CLAUDE.md·법무 파일 LICENSE.md·CLA.md·정상 영어 1차본을 모두 띄우지 «않는다»
#    (드리프트가 재발하면 이 절이 깨진다 = 회귀 가드).
# 2) «단위»(수용 기준 ⑥): A/B/C 검출과 제외 규칙(정상 쌍·frontmatter 스킵·허용목록·법무 제외·
#    슬롯 역전 시 B 억제·산문 비율 오탐 방지)을 합성 픽스처로 검증한다(양성/음성).
# 3) «종료코드 계약»(수용 기준 ①): 후보 0→0, 후보≥1→1(기본), --soft→항상 0.
#
# 종료코드: 모든 검사 통과 0, 하나라도 실패 1.
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LINT="$SCRIPT_DIR/doc-pair-lint.sh"

PASS=0
FAIL=0
ok()  { PASS=$((PASS+1)); printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  \033[31m✗ %s\033[0m\n' "$1"; }

# 픽스처는 «레포 루트 아래» 임시 디렉터리에 만든다 — 허용목록(레포 상대 경로) 매칭이 깔끔하도록.
# (git ls-files 는 추적 파일만 보므로, 미추적 임시 디렉터리는 기본 실행 스캔에 안 잡힌다.)
FX="$(mktemp -d "$REPO_ROOT/.docpair-test.XXXXXX")"
trap 'rm -rf "$FX"' EXIT
FX_REL="${FX#"$REPO_ROOT"/}"

# ── (1) 실제 레포 회귀: 기본 실행(표준 허용목록) ────────────────────────────────────────────
# 드리프트를 쌍으로 고쳐 게이트를 닫은 뒤라, 기본 실행은 후보 0·종료코드 0(블로킹 통과)이어야 한다.
echo "[1] 실제 레포: 기본 실행이 후보 0·종료코드 0(게이트 통과), 두 README 쌍·허용목록·법무는 클린"
REAL_OUT="$(cd "$REPO_ROOT" && "$LINT" --quiet 2>&1)"; REAL_RC=$?

[ "$REAL_RC" -eq 0 ] && ok "기본 실행 종료코드 0 (블로킹 게이트 통과 — 추적 문서쌍 모두 정합)" \
  || bad "기본 실행 종료코드 $REAL_RC (게이트가 막혔다 — 드리프트 잔존?)"

assert_real_miss() { # <경로> <설명>
  if printf '%s\n' "$REAL_OUT" | grep -Fq -- "$1:"; then bad "표면화돼선 안 됨: $2  ($1)"
  else ok "$2"; fi
}

# 쌍으로 고친 두 README — 영어 1차본·한국어 짝 모두 클린(드리프트 재발 방지 고정).
assert_real_miss "ios/README.md"    "ios/README.md(영어 1차본) 클린 — 후보 없음"
assert_real_miss "ios/README.ko.md" "ios/README.ko.md(한국어 짝) 클린 — 후보 없음"
assert_real_miss "web/README.md"    "web/README.md(영어 1차본) 클린 — 후보 없음"
assert_real_miss "web/README.ko.md" "web/README.ko.md(한국어 짝) 클린 — 후보 없음"
# 허용목록(의도적 영어 단독/벤더링)·법무 파일은 여전히 억제/제외.
assert_real_miss "web/AGENTS.md"  "허용목록(벤더링) web/AGENTS.md 는 미표면화"
assert_real_miss "web/CLAUDE.md"  "허용목록(한 줄 include) web/CLAUDE.md 는 미표면화"
assert_real_miss "LICENSE.md"     "단일 바이링궐 법무 LICENSE.md 는 제외"
assert_real_miss "CLA.md"         "단일 바이링궐 법무 CLA.md 는 제외"
# 정상 쌍(README/CLAUDE/docs/SKILL)은 안 떠야 한다(B=0 = 헤더 오탐 없음).
if printf '%s\n' "$REAL_OUT" | grep -Eq 'CLAUDE\.md:|docs/ARCHITECTURE\.md:|SKILL\.md:'; then
  bad "정상 영어 1차본(헤더 정합)이 후보로 떴다(오탐)"
else ok "정상 영어 1차본(CLAUDE/docs/SKILL)은 후보 없음(헤더 오탐 0)"; fi

# ── (2) 단위 픽스처: A/B/C + 제외/억제/오탐 방지 ────────────────────────────────────────────
echo "[2] 단위: A/B/C 검출 + 정상쌍/frontmatter/허용목록/법무/슬롯역전-B억제/산문비율"

# 정상 쌍(음성) — 헤더 정합 + 짝 존재.
cat > "$FX/Good.md" <<'MD'
**English** · [한국어](Good.ko.md)

# Good doc

This is a properly paired English primary document with an English body.
MD
cat > "$FX/Good.ko.md" <<'MD'
[English](Good.md) · **한국어**

# 좋은 문서

이것은 올바르게 짝을 이룬 한국어 번역본입니다. 본문은 한국어로 작성됩니다.
MD

# A 양성: 짝(.ko.md) 없음, 본문은 영어(슬롯 역전 아님), 헤더는 정상.
cat > "$FX/OnlyEnglish.md" <<'MD'
**English** · [한국어](OnlyEnglish.ko.md)

# Only English

This English primary has no Korean counterpart at all, so the pair is missing.
MD

# B 양성: 짝은 있는데 헤더가 «없다»(첫 본문 줄이 제목).
cat > "$FX/BadHeader.md" <<'MD'
# Bad header

This English doc is paired but is missing the language-switcher header line.
MD
cat > "$FX/BadHeader.ko.md" <<'MD'
[English](BadHeader.md) · **한국어**

# 헤더 없는 영어 문서의 짝

이 한국어 번역본은 헤더가 올바릅니다.
MD

# B 양성(오방향): 영어 파일인데 «한국어 방향» 헤더가 붙어 있다.
cat > "$FX/WrongDir.md" <<'MD'
[English](WrongDir.md) · **한국어**

# Wrong direction header

The header points the wrong way for an English primary file.
MD
cat > "$FX/WrongDir.ko.md" <<'MD'
[English](WrongDir.md) · **한국어**

# 방향 헤더 문서의 짝

이 번역본 헤더는 올바릅니다.
MD

# C 양성: 영어 1차 슬롯에 «한국어 단독» 본문(헤더 없음·짝 없음) — ios/README.md 형. A+C, B는 억제.
cat > "$FX/Inverted.md" <<'MD'
# 한국어 단독 문서

이 문서는 영어 1차본 슬롯에 있는데 본문이 전부 한국어로 작성되어 있습니다.
공개 레포를 영어로 읽는 사람은 여기서 영어를 볼 수 없습니다. 이것이 슬롯 역전입니다.
MD

# frontmatter 스킵(음성): 스킬처럼 YAML frontmatter «다음» 첫 줄이 헤더 → B 안 떠야 함.
cat > "$FX/WithFM.md" <<'MD'
---
name: withfm
description: a skill-like doc with YAML frontmatter
---

**English** · [한국어](WithFM.ko.md)

# With frontmatter

The header sits after the YAML frontmatter, like a SKILL.md file.
MD
cat > "$FX/WithFM.ko.md" <<'MD'
---
name: withfm
description: a skill-like doc with YAML frontmatter
---

[English](WithFM.md) · **한국어**

# frontmatter 가 있는 문서

frontmatter 다음 줄이 헤더입니다.
MD

# 산문 비율 오탐 방지(음성): 영어 본문에 한국어가 «살짝» 섞여도 C 가 안 떠야 함(짝·헤더 정상).
cat > "$FX/Sprinkle.md" <<'MD'
**English** · [한국어](Sprinkle.ko.md)

# Sprinkle

This is an English document. It mentions one Korean word 안녕 in passing, but the
prose is overwhelmingly English and must not be flagged as a slot inversion.
MD
cat > "$FX/Sprinkle.ko.md" <<'MD'
[English](Sprinkle.md) · **한국어**

# 살짝 섞임

이 번역본은 한국어 본문입니다.
MD

# ko-고아(A 양성, 반대 방향): NAME.ko.md 만 있고 영어 1차본 NAME.md 가 없다.
cat > "$FX/Orphan.ko.md" <<'MD'
[English](Orphan.md) · **한국어**

# 고아 번역본

영어 1차본이 없는 한국어 단독 파일입니다.
MD

# 법무 제외(음성): basename 으로 제외 — 짝/헤더가 없어도 후보로 안 뜸.
cat > "$FX/LICENSE.md" <<'MD'
# License

Single bilingual legal file. 한국어 요약도 같은 파일에 둡니다.
MD
cat > "$FX/CLA.md" <<'MD'
# CLA

Single bilingual legal file. 한국어 요약도 같은 파일에 둡니다.
MD

# 허용목록(음성): 짝/헤더 없는 영어 단독이지만 baseline 에 등재 → A/B 모두 억제.
cat > "$FX/Allowed.md" <<'MD'
<!-- vendored: intentional English-only -->
# Allowed English only

Intentionally English-only, listed in the allowlist baseline.
MD
BL="$FX/baseline.tsv"
printf '# fixture allowlist\n%s/Allowed.md\n' "$FX_REL" > "$BL"

FX_OUT="$(cd "$REPO_ROOT" && "$LINT" --soft --quiet --baseline="$BL" "$FX" 2>&1)"

# 양성 단언: 해당 basename 줄에 그 [코드] 가 떠야 한다.
assert_hit() { # <basename> <코드> <설명>
  if printf '%s\n' "$FX_OUT" | grep -F -- "$1:" | grep -Fq -- "[$2]"; then ok "[$2] $3"
  else bad "[$2] 양성 누락: $3  ($1)"; fi
}
# 음성(코드별): 해당 basename 줄에 그 [코드] 가 떠선 «안» 된다.
assert_no_code() { # <basename> <코드> <설명>
  if printf '%s\n' "$FX_OUT" | grep -F -- "$1:" | grep -Fq -- "[$2]"; then
    bad "오탐([$2] 떠선 안 됨): $3  ($1)"
  else ok "제외 OK([$2]): $3"; fi
}
# 음성(파일 전체): 해당 basename 이 출력 어디에도 떠선 «안» 된다.
assert_clean() { # <basename> <설명>
  if printf '%s\n' "$FX_OUT" | grep -Fq -- "$1:"; then bad "오탐(후보 떠선 안 됨): $2  ($1)"
  else ok "clean OK: $2"; fi
}

assert_hit "OnlyEnglish.md" A "짝(.ko.md) 없는 영어 1차본 → A"
assert_hit "BadHeader.md"   B "헤더 누락(첫 줄이 제목) → B"
assert_hit "WrongDir.md"    B "오방향 헤더(영어 파일에 한국어 방향) → B"
assert_hit "Inverted.md"    A "슬롯 역전 파일도 짝 없음 → A"
assert_hit "Inverted.md"    C "한국어 단독 본문(영어 슬롯) → C"
assert_no_code "Inverted.md" B "슬롯 역전 시 B(헤더)는 억제"
assert_hit "Orphan.ko.md"   A "영어 1차본 없는 ko 고아 → A(영어 1차본 없음)"

assert_clean "Good.md"      "정상 쌍(영어) — 후보 없음"
assert_clean "Good.ko.md"   "정상 쌍(한국어) — 후보 없음"
assert_clean "WithFM.md"    "frontmatter 다음 헤더 — B 오탐 없음"
assert_clean "WithFM.ko.md" "frontmatter 다음 헤더(한국어) — 후보 없음"
assert_clean "Sprinkle.md"  "영어 본문 + 한국어 살짝 — C 오탐 없음(산문 비율 바닥)"
assert_clean "Sprinkle.ko.md" "정상 쌍(한국어) — 후보 없음"
assert_clean "LICENSE.md"   "법무 파일 LICENSE.md 제외"
assert_clean "CLA.md"       "법무 파일 CLA.md 제외"
assert_clean "Allowed.md"   "허용목록 등재 영어 단독 — 억제"

# ── (3) 종료코드 계약 ──────────────────────────────────────────────────────────────────────
echo "[3] 종료코드 계약: 후보 0→0, 후보≥1→1(기본), --soft→항상 0"
CLEAN="$FX/clean"; mkdir -p "$CLEAN"
cat > "$CLEAN/Pair.md" <<'MD'
**English** · [한국어](Pair.ko.md)

# Clean pair

English body, proper header, paired.
MD
cat > "$CLEAN/Pair.ko.md" <<'MD'
[English](Pair.md) · **한국어**

# 깨끗한 쌍

한국어 본문입니다.
MD
(cd "$REPO_ROOT" && "$LINT" --quiet "$CLEAN" >/dev/null 2>&1); rc_clean=$?
[ "$rc_clean" -eq 0 ] && ok "후보 0건 → 종료코드 0" || bad "후보 0건인데 종료코드 $rc_clean"

(cd "$REPO_ROOT" && "$LINT" --quiet --baseline=/dev/null "$FX" >/dev/null 2>&1); rc_find=$?
[ "$rc_find" -ne 0 ] && ok "후보 있음 → 비-0 종료코드($rc_find)" || bad "후보 있는데 종료코드 0"

(cd "$REPO_ROOT" && "$LINT" --soft --quiet --baseline=/dev/null "$FX" >/dev/null 2>&1); rc_soft=$?
[ "$rc_soft" -eq 0 ] && ok "--soft → 후보 있어도 종료코드 0" || bad "--soft 인데 종료코드 $rc_soft"

# ── (4) down-ratchet: 허용목록에 있지만 스캔엔 없는 줄 → stale 로 표면화(비차단) + burn-down ──────
# i18n-lint --strict 와 동형. 죽은 등재(파일이 지워졌거나 이동)를 «차단 아닌 surfacing» 으로 띄우고
# «고친 N · 남은 M» 진척을 보인다. 기본(비-strict) 모드는 stale 점검 미실행(byte-동등 보존).
echo "[4] --strict: 죽은 허용목록 등재가 BASELINE-STALE 로 표면화 + burn-down(비차단)"
STALE_BASE="$FX/stale_allow.tsv"
printf '# c\n%s/clean/Pair.md\nweb/GONE-NOWHERE.md\n' "$FX_REL" > "$STALE_BASE"
(cd "$REPO_ROOT" && "$LINT" --strict --quiet --baseline="$STALE_BASE" "$CLEAN" >/dev/null 2>&1); rc_st=$?
[ "$rc_st" -eq 0 ] && ok "[strict] 죽은 등재만으론 비차단(0 종료)" || bad "[strict] stale 가 막음(rc=$rc_st, 비차단 기대)"
STALE_OUT="$(cd "$REPO_ROOT" && "$LINT" --strict --baseline="$STALE_BASE" "$CLEAN" 2>/dev/null)"
STALE_BLK="$(printf '%s\n' "$STALE_OUT" | sed -n '/BASELINE-STALE-BEGIN/,/BASELINE-STALE-END/p' | grep -v BASELINE-STALE | grep -Ev '^[[:space:]]*$')"
if printf '%s\n' "$STALE_BLK" | grep -Fq 'web/GONE-NOWHERE.md' && ! printf '%s\n' "$STALE_BLK" | grep -Fq 'Pair.md'; then
  ok "[strict] stale: 매칭 안 되는 등재만 표면화(살아있는 등재는 제외)"
else bad "[strict] stale 표면화 오류(GONE 만 기대): $STALE_BLK"; fi
if printf '%s\n' "$STALE_OUT" | grep -q 'burn-down: 고친 부채 1건 · 남은 부채 1건'; then
  ok "[strict] stale: burn-down «고친 1 · 남은 1» 진척 표기"
else bad "[strict] burn-down 진척 라인 누락/오표기"; fi
NONSTRICT_OUT="$(cd "$REPO_ROOT" && "$LINT" --baseline="$STALE_BASE" "$CLEAN" 2>/dev/null)"
printf '%s\n' "$NONSTRICT_OUT" | grep -q 'BASELINE-STALE' \
  && bad "[non-strict] stale 점검이 실행됨(미실행 기대 — byte-동등 위반)" \
  || ok "[non-strict] stale 점검 미실행(기존 동작 보존)"

# ── 결과 ──────────────────────────────────────────────────────────────────────────────────
echo
echo "─────────────────────────────────────────────"
echo "통과 $PASS · 실패 $FAIL"
[ "$FAIL" -eq 0 ] && { echo "✅ ALL PASS"; exit 0; } || { echo "❌ FAIL"; exit 1; }
