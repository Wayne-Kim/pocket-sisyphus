#!/usr/bin/env bash
#
# doc-pair-lint.sh — 추적되는 모든 «레포 문서»(*.md) 가 CLAUDE.md 「Documentation — maintain
# English & Korean, both」 절의 약속(영어 1차본 NAME.md + 한국어 NAME.ko.md 쌍 · 첫 본문 줄에
# 언어 스위처 헤더 · 한쪽만 노출되는 «언어 슬롯 역전» 금지)을 지키는지 «정적 휴리스틱» 으로
# 스캔해, 위반 후보를 «경로:라인 — 종류» 로 표면화한다.
# design-lint.sh·i18n-lint.sh·agent-surfaces-lint.sh 와 같은 패밀리(휴리스틱·리포트·게이트 계약).
#
# 왜: 그 문서쌍 규칙만 출시 전 정적 검사가 0이라 «사람 눈» 에 의존했다. 결과적으로 이미 드리프트가
#   있다 — ios/README.md·web/README.md 는 본문이 한국어 단독인데 짝이 되는 .ko.md 도, 영어 1차본도
#   없다(공개·source-available 레포를 영어로 읽는 사람은 이 두 서브프로젝트 README 에서 영어를 못
#   본다 = «English is primary» 정면 위반). agent-surfaces-lint·po-agent-lint 를 만들 때 이미 인정한
#   «사람이 6곳을 수동으로 맞추는 한 또 어긋난다» 는 토일을, 이 스크립트가 그 입구에서 막는다.
#
# ── 검출 종류 ────────────────────────────────────────────────────────────────────────────
#   A. 짝 없음        : 영어 1차본 NAME.md 에 NAME.ko.md 가 없다(또는 NAME.ko.md 에 1차본
#                       NAME.md 가 없다). 한쪽 언어만 머지된 드리프트.
#   B. 헤더 누락/오방향: 첫 본문 줄(스킬은 YAML frontmatter «다음» 첫 줄)이 그 파일의 언어
#                       스위처 헤더와 다르다.  영어 파일 == `**English** · [한국어](NAME.ko.md)`
#                       · 한국어 파일 == `[English](NAME.md) · **한국어**`.
#   C. 슬롯 역전      : 영어 1차본 슬롯(NAME.md)에 «한국어 단독» 본문이 들어가 있다
#                       (English-is-primary 역전). 코드블록·인라인코드·링크·HTML 을 걷어낸
#                       «산문» 의 한글 비율이 임계를 넘고 한글 글자 수가 바닥값 이상이면 후보.
#                       — C 가 뜨면 그 파일의 B(헤더)는 «종속 증상» 이라 따로 띄우지 않는다
#                         (영어 1차본을 만들면 헤더는 자연히 따라온다).
#
# ── 허용목록(베이스라인) — 의도적 영어 단독/벤더링으로 노이즈 차단 ───────────────────────────
#   i18n-lint-baseline.tsv 와 같은 «기존/의도된 예외» 파일. 한 줄당 «레포 루트 상대 경로».
#   «#» 주석·빈 줄 허용. 등재된 파일은 A/B/C 어떤 후보도 띄우지 않는다. 예) 벤더링된 Next.js
#   에이전트 규칙(web/AGENTS.md), 사실상 본문이 없는 한 줄 include(web/CLAUDE.md `@AGENTS.md`).
#   기본 경로 scripts/doc-pair-lint-baseline.tsv (있으면 자동 사용), --baseline=PATH 또는
#   환경변수 DOC_PAIR_LINT_BASELINE 로 교체. — «진짜 드리프트» 를 여기 숨기지 말 것: 허용목록은
#   오직 «의도적 영어 단독/벤더링» 전용이다(ios/README.md 같은 미번역 드리프트는 «고쳐야» 한다).
#
# ── 제외(스캔 대상 아님) ─────────────────────────────────────────────────────────────────
#   · LICENSE.md·CLA.md : 규칙상 «단일 바이링궐» 법무 파일(영어 정본 + 한국어 비공식 요약) — 분리
#     대상이 아니므로 짝/헤더/슬롯 검사에서 제외(basename 기준).
#   · *.ko.md «자체» 는 «영어 1차본을 또 요구» 하지 않는다(짝의 짝 금지) — .ko.md 는 자기 헤더(B,
#     한국어 방향)와 «자기 1차본 NAME.md 존재»(A)만 본다. 한국어 본문이라 슬롯 역전(C)은 안 본다.
#   · 빌드/벤더 디렉터리(node_modules/.git/build/DerivedData/…)는 디렉터리 스캔 시 건너뛴다.
#
# ── 한계(리포트에 명시) ──────────────────────────────────────────────────────────────────
#   · «후보 표면화» 가 목적이다(완전 파서·번역 품질/내용 동기화 판정 아님). 슬롯 역전(C)은 «산문
#     한글 비율» 휴리스틱이라 거짓 양성/음성이 가능하다 — 최종 판정은 사람이. 의도적 영어 단독은
#     허용목록에 등재해 억제한다. «내용» 이 두 언어로 같은지(번역 동기화)는 검사하지 않는다.
#
# 사용법:
#   ./scripts/doc-pair-lint.sh                 # 기본: git 추적 *.md 전체 스캔, 후보 있으면 비-0 종료
#   ./scripts/doc-pair-lint.sh --soft          # «리포트만» — 후보가 있어도 항상 0 종료(게이트 끔)
#   ./scripts/doc-pair-lint.sh --quiet         # 안내/가이드 헤더 생략(기계 소비용)
#   ./scripts/doc-pair-lint.sh --baseline=PATH # 허용목록 파일 교체(기본 scripts/doc-pair-lint-baseline.tsv)
#   ./scripts/doc-pair-lint.sh --strict        # 위 + 더는 매칭 안 되는 «stale» 허용목록 등재 표면화(비차단) + burn-down
#   ./scripts/doc-pair-lint.sh PATH...         # 지정 디렉터리/파일의 *.md 만 스캔(자가 테스트가 사용)
#
# 종료코드: 후보 0 → 0, 1건 이상 → 1 (호출자가 게이트로 쓸 수 있게). --soft 면 항상 0.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

SOFT=0
QUIET=0
STRICT=0
BASELINE="${DOC_PAIR_LINT_BASELINE:-}"
PATHS=()

for arg in "$@"; do
  case "$arg" in
    --soft|--no-fail) SOFT=1 ;;
    --quiet|-q)       QUIET=1 ;;
    --strict)         STRICT=1 ;;
    --baseline=*)     BASELINE="${arg#*=}" ;;
    -h|--help)
      sed -n '2,55p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    --*) echo "doc-pair-lint: 알 수 없는 옵션: $arg" >&2; exit 2 ;;
    *)   PATHS+=("$arg") ;;
  esac
done

# 인자로 경로가 없고 baseline 미지정이면 표준 허용목록을 자동 사용한다.
if [ ${#PATHS[@]} -eq 0 ] && [ -z "$BASELINE" ] && [ -f "$SCRIPT_DIR/doc-pair-lint-baseline.tsv" ]; then
  BASELINE="$SCRIPT_DIR/doc-pair-lint-baseline.tsv"
fi

# 모든 휴리스틱은 파이썬에 둔다 — 유니코드(한글) 비율·frontmatter 렉싱·git 추적목록 조회가
# BSD grep/sed 보다 안정적이다. 따옴표 친 heredoc('PYEOF') 라 셸 확장이 없어 본문이 그대로 전달된다.
SOFT="$SOFT" QUIET="$QUIET" STRICT="$STRICT" BASELINE="$BASELINE" REPO_ROOT="$REPO_ROOT" \
  python3 - ${PATHS[@]+"${PATHS[@]}"} <<'PYEOF'
import os, re, sys, subprocess

SOFT     = os.environ.get("SOFT", "0") == "1"
QUIET    = os.environ.get("QUIET", "0") == "1"
STRICT   = os.environ.get("STRICT", "0") == "1"
BASELINE_PATH = os.environ.get("BASELINE", "") or ""
REPO_ROOT = os.environ.get("REPO_ROOT") or os.getcwd()
paths = sys.argv[1:]

# ── 언어 스위처 헤더(SSOT: CLAUDE.md) ───────────────────────────────────────────────────
# 구분자는 U+00B7(가운뎃점) 양옆 공백. 링크 타깃은 «형제 basename»(쌍은 항상 같은 디렉터리).
EN_HEADER = "**English** · [한국어](%s)"   # %s = NAME.ko.md (basename)
KO_HEADER = "[English](%s) · **한국어**"   # %s = NAME.md   (basename)

# ── 슬롯 역전(C) 휴리스틱 임계 ──────────────────────────────────────────────────────────
# 코드/인라인코드/링크/HTML 을 걷어낸 «산문» 의 한글 비율이 이 값을 넘고, 한글 글자 수가
# 바닥값 이상이면 «한국어 단독 본문» 후보. 캘리브레이션(이 레포): 정상 영어 1차본 ≤0.07,
# 역전 파일(ios/web README) 0.35·0.54 — 그 사이 0.20 으로 가른다(바닥값으로 스트레이 한글 방지).
C_RATIO_MIN = 0.20
C_HANGUL_MIN = 30

LEGAL_BASENAMES = {"LICENSE.md", "CLA.md"}   # 단일 바이링궐 법무 파일 — 규칙상 제외

EXCLUDE_DIRS = {'.git', 'node_modules', 'build', 'DerivedData', '.build',
                'SourcePackages', 'Pods', 'Carthage', '.swiftpm', 'out', 'dist'}

HANGUL = re.compile(r'[가-힣ᄀ-ᇿ]')
LATIN  = re.compile(r'[A-Za-z]')

def norm(p):
    return os.path.normpath(os.path.abspath(p))

def relroot(p):
    """허용목록 매칭/표시용 «레포 루트 상대» 경로(머신·cwd 비의존)."""
    try:
        return os.path.relpath(norm(p), REPO_ROOT)
    except ValueError:
        return norm(p)

cwd = os.getcwd()
def relp(p):
    try:
        r = os.path.relpath(p, cwd)
        return r if not r.startswith('..') else relroot(p)
    except ValueError:
        return p

# ── 허용목록(베이스라인) 로드 — 레포 상대 경로, «#» 주석·빈 줄 무시 ─────────────────────────
def load_baseline(p):
    s = set()
    if not p:
        return s
    try:
        with open(p, encoding='utf-8') as f:
            for ln in f:
                ln = ln.strip()
                if not ln or ln.startswith('#'):
                    continue
                s.add(os.path.normpath(ln))
    except OSError:
        pass
    return s
ALLOW = load_baseline(BASELINE_PATH)

# ── 스캔 대상 *.md 수집 ──────────────────────────────────────────────────────────────────
# 인자 없음 → git 추적 *.md 전체(레포 루트 기준). 인자 있음 → 그 디렉터리/파일의 *.md 워크.
def collect_tracked():
    try:
        out = subprocess.run(["git", "-C", REPO_ROOT, "ls-files", "*.md"],
                             capture_output=True, text=True, check=True).stdout
    except (OSError, subprocess.CalledProcessError) as e:
        sys.stderr.write("doc-pair-lint: git ls-files 실패: %s\n" % e)
        return []
    return [norm(os.path.join(REPO_ROOT, rel)) for rel in out.split('\n') if rel.strip()]

def collect_walk(roots):
    out = []
    for p in roots:
        ap = norm(p)
        if os.path.isfile(ap):
            if ap.endswith('.md'):
                out.append(ap)
        elif os.path.isdir(ap):
            for dp, dirs, files in os.walk(ap):
                dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS]
                for fn in files:
                    if fn.endswith('.md'):
                        out.append(norm(os.path.join(dp, fn)))
    return out

md_files = sorted(set(collect_tracked() if not paths else collect_walk(paths)))
present = set(md_files)   # 짝 존재 판정의 «우주»(추적/스캔된 .md 집합)

# ── down-ratchet: 더는 매칭 안 되는 «stale» 허용목록 등재 표면화(비차단) + burn-down ──────────
# i18n-lint.sh --strict 와 동형(SSOT). 허용목록(ALLOW)에 등재됐지만 이번 스캔의 어떤 .md 경로와도
# 안 맞는 줄 = 그 파일이 지워졌거나 이동한 «죽은» 등재. 차단(비-0 종료)하지 않고 표면화만 하며,
# 사람이 검토 후 허용목록에서 지운다(자동 삭제·재기록 안 함). 주석·빈 줄은 load_baseline 에서 이미
# 제외. baseline 이 없거나(빈 집합) --strict 가 아니면 미실행(기존대로 동작). burn-down 으로 진척 가시화.
scanned_rel = {os.path.normpath(relroot(ap)) for ap in md_files}
def emit_stale():
    if not (STRICT and ALLOW):
        return
    stale = sorted(ALLOW - scanned_rel)
    n_stale = len(stale)        # 고친(=매칭 안 되는) 등재 후보
    n_live  = len(ALLOW) - n_stale   # 남은(=여전히 매칭되는) 등재
    if n_stale:
        if not QUIET:
            print("%sℹ 허용목록 stale 후보 %d건%s — 비차단(사람 판정). 등재됐지만 이번 스캔에서 한 번도"
                  % (DIM, n_stale, RST))
            print("%s   매칭 안 됨(파일이 지워졌거나 이동). 검토 후 허용목록(%s)에서 아래 줄을 «지우»세요(자동 삭제 안 함):%s"
                  % (DIM, relp(BASELINE_PATH) if BASELINE_PATH else "scripts/doc-pair-lint-baseline.tsv", RST))
        # 기계 소비용 — QUIET 여도 항상(테스트/자동화가 파싱).
        print("### BASELINE-STALE-BEGIN")
        for f in stale:
            print(f)
        print("### BASELINE-STALE-END")
    if not QUIET:
        print("%sbaseline burn-down: 고친 부채 %d건 · 남은 부채 %d건 (등재 %d)%s"
              % (BOLD, n_stale, n_live, len(ALLOW), RST))


# ── 본문 헬퍼 ────────────────────────────────────────────────────────────────────────────
def read(p):
    try:
        with open(p, encoding='utf-8') as f:
            return f.read()
    except (OSError, UnicodeDecodeError):
        return None

def first_body_line(text):
    """첫 본문 줄 (lineno 1-based, 내용). YAML frontmatter(--- … ---)와 선행 빈 줄을 건너뛴다 —
       스킬 SKILL.md 는 frontmatter «다음» 첫 줄이 헤더이므로."""
    lines = text.split('\n')
    i = 0
    if i < len(lines) and lines[i].strip() == '---':   # frontmatter
        j = i + 1
        while j < len(lines) and lines[j].strip() != '---':
            j += 1
        i = j + 1
    while i < len(lines) and lines[i].strip() == '':
        i += 1
    return (i + 1, lines[i] if i < len(lines) else '')

def prose(text):
    """코드블록·인라인코드·링크 타깃·URL·HTML 태그를 걷어낸 «산문» — 한글 비율 측정용.
       코드/식별자는 두 언어 모두 라틴이라, 안 걷으면 코드 많은 영어 문서와 한국어 문서가
       라틴 수로 안 갈린다(이게 핵심: 산문만 봐야 슬롯 역전이 깔끔히 분리된다)."""
    text = re.sub(r'```.*?```', ' ', text, flags=re.S)   # 펜스 코드블록
    text = re.sub(r'`[^`]*`', ' ', text)                  # 인라인 코드
    text = re.sub(r'\]\([^)]*\)', '] ', text)             # [텍스트](타깃) 의 타깃
    text = re.sub(r'https?://\S+', ' ', text)
    text = re.sub(r'<[^>]+>', ' ', text)                  # HTML 태그
    return text

def hangul_ratio(text):
    body = prose(text)
    h = len(HANGUL.findall(body))
    l = len(LATIN.findall(body))
    return (h, l, (h / (h + l) if (h + l) else 0.0))

# ── 종류 메타 (코드 → (이름, 고치는 법)) ──────────────────────────────────────────────────
META = {
    'A': ('짝(번역본) 파일 없음',
          '쌍을 만든다 — 영어 1차본 NAME.md ↔ 한국어 NAME.ko.md 를 같은 디렉터리에 두고 같은 커밋에서 갱신'),
    'B': ('언어 스위처 헤더 누락/오방향',
          '첫 본문 줄(스킬은 frontmatter 다음)을 영어=`**English** · [한국어](NAME.ko.md)` / 한국어=`[English](NAME.md) · **한국어**` 로'),
    'C': ('한국어 단독 본문이 영어 1차 슬롯에 (English-is-primary 역전)',
          '영어를 1차본(NAME.md)으로 작성하고 한국어 본문은 NAME.ko.md 로 옮긴다(공개 레포의 1차 언어는 영어)'),
}

findings = []   # (path, lineno, code, detail)
def add(path, lineno, code, detail):
    findings.append((path, lineno, code, detail))

for ap in md_files:
    base = os.path.basename(ap)
    if base in LEGAL_BASENAMES:          # 단일 바이링궐 법무 파일 — 제외
        continue
    if os.path.normpath(relroot(ap)) in ALLOW:   # 의도적 영어 단독/벤더링 — 허용목록
        continue

    text = read(ap)
    if text is None:
        continue
    lineno, hdr = first_body_line(text)
    is_ko = ap.endswith('.ko.md')

    if is_ko:
        # .ko.md: 자기 1차본(NAME.md) 존재(A) + 자기 헤더(B, 한국어 방향)만 본다.
        en_sibling = norm(ap[:-len('.ko.md')] + '.md')
        if en_sibling not in present:
            add(ap, lineno, 'A', "영어 1차본(%s) 없음 — 한국어만 머지된 드리프트"
                % os.path.basename(en_sibling))
        expected = KO_HEADER % os.path.basename(en_sibling)
        if hdr != expected:
            add(ap, lineno, 'B', "기대: `%s` · 실제: `%s`" % (expected, hdr.strip() or '(빈 줄)'))
        continue

    # 영어 1차본 NAME.md
    ko_sibling = norm(ap[:-len('.md')] + '.ko.md')
    pair_missing = ko_sibling not in present
    if pair_missing:
        add(ap, lineno, 'A', "짝(%s) 없음 — 영어만 있고 한국어 번역본이 없다"
            % os.path.basename(ko_sibling))

    h, l, ratio = hangul_ratio(text)
    inverted = (ratio >= C_RATIO_MIN and h >= C_HANGUL_MIN)
    if inverted:
        add(ap, lineno, 'C', "산문 한글 비율 %.0f%% (한글 %d자) — 영어 1차본이 한국어로 채워져 있다"
            % (ratio * 100, h))

    # C(슬롯 역전)가 뜨면 B(헤더)는 종속 증상 → 억제. 아니면 영어 방향 헤더를 검사한다.
    if not inverted:
        expected = EN_HEADER % os.path.basename(ko_sibling)
        if hdr != expected:
            add(ap, lineno, 'B', "기대: `%s` · 실제: `%s`" % (expected, hdr.strip() or '(빈 줄)'))

# ── 출력 ─────────────────────────────────────────────────────────────────────────────────
RST, BOLD, DIM = '\033[0m', '\033[1m', '\033[2m'
if not sys.stdout.isatty():
    RST = BOLD = DIM = ''

if not QUIET:
    scope = "git 추적 *.md 전체" if not paths else ', '.join(relp(p) for p in paths)
    bl = relp(BASELINE_PATH) if BASELINE_PATH else "(없음)"
    print("%sdoc-pair-lint%s — 영어·한국어 문서쌍 정합 후보 스캔 (CLAUDE.md 「Documentation」 기준 휴리스틱)" % (BOLD, RST))
    print("%s스캔 대상: %s  ·  허용목록: %s  ·  대상 %d개%s" % (DIM, scope, bl, len(md_files), RST))
    print()

if not findings:
    if not QUIET:
        print("✅ 후보 0건 — 추적 문서쌍의 짝·헤더·슬롯이 모두 정합합니다.")
    emit_stale()
    sys.exit(0)

# 경로별 그룹, 그 안은 A→B→C 순.
order = {'A': 0, 'B': 1, 'C': 2}
findings.sort(key=lambda x: (relp(x[0]), order[x[2]], x[1]))

counts = {'A': 0, 'B': 0, 'C': 0}
for _, _, code, _ in findings:
    counts[code] += 1

last_path = None
for path, lineno, code, detail in findings:
    rp = relp(path)
    if rp != last_path:
        print("%s■ %s%s" % (BOLD, rp, RST))
        last_path = rp
    name = META[code][0]
    # 수용 기준 출력 형식: «경로:라인 — 종류».
    print("  %s:%d — [%s] %s — %s" % (rp, lineno, code, name, detail))
print()

print("%s합계: %d건  (A=%d  B=%d  C=%d)%s" % (BOLD, len(findings), counts['A'], counts['B'], counts['C'], RST))

if not QUIET:
    print()
    print("%s고치는 법:%s" % (BOLD, RST))
    for code in ('A', 'B', 'C'):
        if counts[code]:
            print("  · [%s] %s: %s" % (code, META[code][0], META[code][1]))
    print()
    print("%s거짓 양성 처리법:%s" % (BOLD, RST))
    print("  · 의도적 영어 단독/벤더링(예: 벤더링된 에이전트 규칙, 한 줄 include)이면 그 «레포 상대 경로» 를")
    print("    허용목록(%s)에 한 줄 추가하세요 — A/B/C 가 모두 빠집니다." % (relp(BASELINE_PATH) if BASELINE_PATH else "scripts/doc-pair-lint-baseline.tsv"))
    print("  · 단, 미번역 «드리프트»(영어만/한국어만 진짜로 빠진 것)는 허용목록에 숨기지 말고 «쌍을 맞춰» 고치세요.")
    print("  · [C] 슬롯 역전은 «산문 한글 비율» 휴리스틱이라 거짓 양성/음성이 가능합니다 — 최종 판정은 사람이 합니다.")
    print("  · 이 도구는 «후보 표면화» 가 목적입니다(번역 «내용» 동기화 여부는 검사하지 않습니다).")

emit_stale()
sys.exit(0 if SOFT else 1)
PYEOF
