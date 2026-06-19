#!/usr/bin/env bash
#
# i18n-lint.sh — iOS·Mac Swift 소스를 «정규식 휴리스틱» 으로 스캔해, CLAUDE.md 가
# «즉시 고친다» 고 명시한 i18n 안티패턴(카탈로그 우회 → 비-ko 로케일에서 한글 노출)
# 후보를 «경로:라인 — 패턴명 — 발췌» 로 표면화한다.
#
# 왜: HEAD 직전(37bb50a)이 「ternary Text 번역 누락 12곳」 을 사람이 수동으로 찾아 고쳤다.
# 카탈로그엔 12종 키가 이미 10/10 번역돼 있었는데도 코드가 `Text(cond ? "한글" : "한글")`
# 형태로 String(verbatim) init 을 타 카탈로그를 건너뛰어 ko 원문이 새어 나갔다. 빌드는
# 통과하므로 사람 눈에만 의존하면 같은 패턴이 조용히 재유입된다. 이 스크립트가 그 회귀를
# 근원에서 막는다 — 출시 전(/verify-ios)과 PO 자가검증 노드에서 «후보» 를 띄운다.
#
# 탐지 패턴 (CLAUDE.md 안티패턴 표 기준):
#   A. Text/Label/.accessibility* 등에서 양 갈래가 한글 리터럴인 ternary  (← 12곳 회귀)
#   B. Text(식별자) — 같은 파일의 한글 String 변수를 경유(LocalizedStringKey 미선언)
#   C. enum case / errorDescription 가 String(localized:) 없이 raw 한글 return
#      (단, 가장 가까운 enclosing 선언이 -> LocalizedStringKey/Resource 면 case 의 한글은
#       자동 localize 대상이라 후보에서 «제외» — 누수가 아니다.)
#   D. 중첩 보간  String(localized: "…\("\(x)")")  — 자동 추출기가 키를 못 잡음
#
# 카탈로그 점검 (옵트인, 위 A–D 와 «방향이 반대» — 소스가 아니라 카탈로그를 본다):
#   O. orphan — 코드 어디서도 안 쓰이는 카탈로그 ko 키(죽은 번역). 리팩터가 문자열을 바꾸거나
#      지우면 원문 키가 카탈로그에 조용히 남아 (a) 번역비가 죽은 문자열에 계속 들고
#      (b) 비슷한 문자열을 다시 넣을 때 stale/엉뚱한 번역으로 드리프트한다. 카탈로그 ko 키를
#      «보간 정규화»(%@/%lld/%1$@/%.1f/%% ↔ \(…)) 한 형태가 소스 문자열 리터럴 어디에도
#      안 나타나면 후보로 띄운다. 보간 정규화가 핵심 — 안 하면 `변경 %lld개` 가 소스의
#      `변경 \(n)개` 와 안 맞아 오탐이 쏟아진다.  (--orphans)
#   T. 미완역(완역 커버리지) — [O] 와 «방향은 같고 의미는 반대». 코드가 «쓰는»(=orphan 아닌) ko
#      키인데 비-source 로케일 일부/전체가 (a) stringUnit/variations 누락, (b) value 빈 문자열,
#      (c) state∈{new,needs_review} 면 «미완역» 후보로 «키 + 누락 로케일» 을 띄운다. CLAUDE.md 가
#      «자동 추출 ≠ 번역 완료» 라 못박은 회귀(영어 로케일에서 ko 가 새는) 를 정적으로 막는다.
#      기준 로케일은 각 앱 project.yml 의 knownRegions(SSOT, Base·source 제외)에서 읽는다 —
#      스크립트에 로케일을 «하드코딩하지 않는다». 비번역 의도(shouldTranslate:false, 또는 present
#      로케일이 모두 원문=식별자/단위)는 [O] 가 쓰는 휴리스틱을 재사용해 억제. localizations 가
#      «통째로 빈»({}) 키는 추출만 되고 안 채워진 미완역이라 orphan 이어도 보고한다.  (--coverage)
#
# 제외: 빌드 산출물(build/DerivedData/SourcePackages/Pods), 디버그 로깅(print/NSLog/
#       os_log/Logger), 주석, Text(verbatim:), 한글 미포함 고정 문자열(코드/식별자/.onion/단위).
#       [O]·[T] 는 ko(한글 포함) 키만 본다 — 코드/식별자/단위 키는 애초에 대상 아님.
#
# 스코프(비-목표): 완전한 Swift 파서/자동 수정 아님. [T] 는 «번역 채움(자동 생성)·번역 품질 판정·
#                  knownRegions iOS↔Mac 드리프트» 를 하지 않는다(각각 사람·번역 패치·별개 작업 몫).
#                  «후보 표면화» 가 목적이다 — 거짓 양성이 있을 수 있으니 사람이 판정한다.
#                  [O] 도 «자동 삭제 안 함» — 동적 조회(Text(LocalizedStringKey(변수)))는
#                  정적으로 못 풀어 거짓 양성이 날 수 있다. 후보를 확인하고 «사람이» 지운다.
#
# 사용법:
#   ./scripts/i18n-lint.sh                 # 기본: iOS·Mac 소스 A–D 스캔, 후보 있으면 비-0 종료
#   ./scripts/i18n-lint.sh --orphans       # 위에 더해 카탈로그 orphan([O]) 점검을 «추가»(유지보수 스윕)
#   ./scripts/i18n-lint.sh --coverage      # 위에 더해 완역 커버리지([T]) 점검을 «추가»(미완역 게이트)
#   ./scripts/i18n-lint.sh PATH...         # 지정한 디렉터리/파일만 스캔(회귀 테스트가 사용)
#   ./scripts/i18n-lint.sh --soft          # «리포트만» — 후보가 있어도 항상 0 종료(게이트 끔)
#   ./scripts/i18n-lint.sh --quiet         # 안내/가이드 헤더 생략(기계 소비용)
#
# 종료코드: 후보 0 → 0, 1건 이상 → 1 (호출자가 게이트로 쓸 수 있게). --soft 면 항상 0.
#           («후보» 는 A–D + (옵트인 시) [O] + (옵트인 시) [T] 합산. 기본 실행은 [O]·[T] 미포함.)
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

SOFT=0
QUIET=0
ORPHANS=0
COVERAGE=0
PATHS=()

for arg in "$@"; do
  case "$arg" in
    --soft|--no-fail) SOFT=1 ;;
    --quiet|-q)       QUIET=1 ;;
    --orphans)        ORPHANS=1 ;;
    --coverage)       COVERAGE=1 ;;
    -h|--help)
      sed -n '2,57p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    --*) echo "i18n-lint: 알 수 없는 옵션: $arg" >&2; exit 2 ;;
    *)   PATHS+=("$arg") ;;
  esac
done

# 인자로 경로가 없으면 두 앱의 소스 루트를 스캔 (ios/build 는 자연히 제외됨).
if [ ${#PATHS[@]} -eq 0 ]; then
  PATHS=("$REPO_ROOT/ios/PocketSisyphus" "$REPO_ROOT/mac/PocketSisyphusMac")
fi

# 모든 휴리스틱은 파이썬에 둔다 — 유니코드(한글)·문자열/주석 렉싱·파일 내 상관(변수 추적)이
# BSD grep/sed 보다 안정적이다. 따옴표 친 heredoc('PYEOF') 라 셸 확장이 없어 정규식의
# 역슬래시/달러가 그대로 전달된다.
SOFT="$SOFT" QUIET="$QUIET" ORPHANS="$ORPHANS" COVERAGE="$COVERAGE" python3 - "${PATHS[@]}" <<'PYEOF'
import os, re, sys, json

SOFT     = os.environ.get("SOFT", "0") == "1"
QUIET    = os.environ.get("QUIET", "0") == "1"
ORPHANS  = os.environ.get("ORPHANS", "0") == "1"
COVERAGE = os.environ.get("COVERAGE", "0") == "1"
paths = sys.argv[1:]

# ── 한글 탐지 (음절 + 자모) ──────────────────────────────────────────────────
HANGUL = re.compile(r'[가-힣ᄀ-ᇿ㄰-㆏]')
def has_hangul(s): return bool(HANGUL.search(s))

# 한 줄 Swift 문자열 리터럴 (이스케이프 포함). 보간 \(…) 안에 따옴표가 와도
# \\. 가 \" 를 흡수하므로 단순 케이스는 안전하다.
STR = r'"(?:\\.|[^"\\])*"'

# A 패턴이 노릴 «LocalizedStringKey 를 받는» 래퍼들.
WRAP_A = (r'(?:Text|Label|Button|Toggle|Picker|TextField|Stepper|Link|'
          r'accessibilityLabel|accessibilityValue|accessibilityHint|'
          r'navigationTitle|navigationBarTitle|help|alert|confirmationDialog)')

# A: 래퍼(…cond ? "한글" : "…")  — 양 갈래가 «맨» 문자열 리터럴(=Text 분리 전).
#    조건부엔 따옴표(예: == "cron")·1단계 괄호가 올 수 있어 허용한다.
RE_TERNARY = re.compile(
    WRAP_A + r'\('
    r'(?P<cond>(?:[^()"]|' + STR + r'|\([^()]*\))*?)'
    r'\?\s*(?P<t>' + STR + r')\s*:\s*(?P<f>' + STR + r')\s*[,)]'
)

# B: 같은 파일의 한글 String 리터럴 변수 정의(LocalizedStringKey 미선언) …
RE_STRVAR_DEF = re.compile(
    r'\b(?:let|var)\s+(?P<name>[A-Za-z_]\w*)\s*'
    r'(?::\s*(?P<type>[A-Za-z_][\w.<>\[\]?, ]*?)\s*)?'
    r'=\s*(?P<val>' + STR + r')'
)
# … 그리고 그 변수를 Text/Label/.accessibility* 로 그대로 노출하는 사용처.
RE_STRVAR_USE = re.compile(
    r'(?:Text|Label|accessibilityLabel|accessibilityValue|navigationTitle|help)'
    r'\(\s*(?P<name>[A-Za-z_]\w*)\s*\)'
)

# C: enum case 가 String(localized:) 없이 raw 한글 return.
RE_CASE_RET = re.compile(r'\bcase\b.*?:\s*return\s+(?P<s>' + STR + r')')
# C(보조): errorDescription/failureReason/… 프로퍼티 «안» 의 raw 한글 return.
RE_ERRDESC_DECL = re.compile(
    r'\b(?:errorDescription|failureReason|recoverySuggestion|helpAnchor)\b'
)
RE_RAW_RETURN = re.compile(r'\breturn\s+(?P<s>' + STR + r')')
# C(예외): case-return 의 «가장 가까운 enclosing 선언» 이 LocalizedStringKey/Resource 를
#   반환하면 그 case 의 한글 리터럴은 SwiftUI 가 자동 localize 하므로 누수가 아니다 →
#   그 블록 «안» 의 case-return 은 [C] 후보에서 제외한다([A] 영역/err_depth, [B] 타입
#   검사와 동형으로 «중괄호 깊이» 로 선언 본문을 추적). «본문 여는 { » 를 이 줄에서 여는
#   선언만 잡는다 — 연산 메서드(func … -> T {)·연산 프로퍼티(var x: T {).
#   func 은 «마지막» -> 에 바인딩해 클로저 파라미터의 -> 를 건너뛴다(그리디 [^{}]*).
#   저장 프로퍼티(var x: T = …)는 '{' 앞에 '=' 가 와서 RE_VAR_OPEN 에 안 걸린다(연산만).
RE_FUNC_OPEN = re.compile(r'\bfunc\b[^{}]*->\s*(?P<type>[^{}]+?)\s*\{')
RE_VAR_OPEN  = re.compile(r'\b(?:var|let)\s+[A-Za-z_]\w*\s*:\s*(?P<type>[^={}]+?)\s*\{')
def is_lsk_type(t):
    return 'LocalizedStringKey' in t or 'LocalizedStringResource' in t

# D: String(localized:)/NSLocalizedString 안에 중첩 보간 \(" .
RE_LOC_CALL   = re.compile(r'(?:String\(localized:|NSLocalizedString\()')

# 로깅 줄 — 한글이 있어도 사용자 노출 아님(스킵).
RE_LOG = re.compile(
    r'(?:^|[\s.;{(])(?:print|NSLog|os_log|debugPrint|assertionFailure|'
    r'preconditionFailure|fatalError)\s*\(|'
    r'\bLogger\(\)\.(?:info|debug|error|warning|notice|trace|critical|fault)\s*\(|'
    r'\.(?:info|debug|error|warning|notice|trace|critical|fault)\s*\(\s*"'
)

EXCLUDE_DIRS = {'build', 'DerivedData', '.build', 'SourcePackages',
                'Pods', 'Carthage', '.swiftpm', '.git', 'node_modules'}

def swift_files(roots):
    out = []
    for p in roots:
        if os.path.isfile(p):
            if p.endswith('.swift'):
                out.append(p)
        elif os.path.isdir(p):
            for dp, dirs, files in os.walk(p):
                dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS]
                for fn in files:
                    if fn.endswith('.swift'):
                        out.append(os.path.join(dp, fn))
    return sorted(set(out))

def lex(line, st):
    """주석 제거 + 문자열 인지. (code, skel) 두 형태를 한 번에 만든다.
       code : 주석만 공백으로 — 문자열 내용은 보존(탐지 정규식이 쓴다).
       skel : 주석 + 문자열 내부까지 공백으로 — 구조 카운팅(중괄호)이 쓴다.
       st['block'] 로 여러 줄 블록 주석(/* */) 상태를 줄 간 보존한다."""
    code, skel = [], []
    i, n = 0, len(line)
    in_str = False
    while i < n:
        c = line[i]
        two = line[i:i+2]
        if st['block']:
            j = line.find('*/', i)
            if j == -1:
                pad = ' ' * (n - i); code.append(pad); skel.append(pad); i = n; break
            pad = ' ' * (j + 2 - i); code.append(pad); skel.append(pad)
            i = j + 2; st['block'] = False; continue
        if in_str:
            if two == '\\(':                      # 보간: 균형 잡힌 (…) 통째로
                depth = 1; code.append('\\('); skel.append('  '); i += 2
                while i < n and depth > 0:
                    ch = line[i]
                    if ch == '(': depth += 1
                    elif ch == ')': depth -= 1
                    code.append(ch); skel.append(' '); i += 1
                continue
            if c == '\\' and i + 1 < n:            # 그 외 이스케이프
                code.append(line[i:i+2]); skel.append('  '); i += 2; continue
            code.append(c); skel.append(' ' if c != '"' else '"')
            if c == '"': in_str = False
            i += 1; continue
        # 코드 모드
        if two == '//':
            pad = ' ' * (n - i); code.append(pad); skel.append(pad); break
        if two == '/*':
            st['block'] = True; code.append('  '); skel.append('  '); i += 2; continue
        if c == '"':
            in_str = True; code.append('"'); skel.append('"'); i += 1; continue
        code.append(c); skel.append(c); i += 1
    return ''.join(code), ''.join(skel)

def excerpt(orig):
    s = orig.strip()
    return s if len(s) <= 160 else s[:157] + '…'

# ── [O] orphan 헬퍼 (카탈로그 ko 키 ↔ 소스 리터럴, «보간 정규화» 후 비교) ─────────────
# 핵심: 양쪽의 «값이 들어갈 자리» 를 같은 자리표시자로 접어 비교한다. 안 그러면 카탈로그의
#   `변경 %lld개` 가 소스의 `변경 \(n)개` 와 안 맞아 산 키가 죄다 orphan 으로 오탐 난다.
SENT = '\x00'   # 보간/포맷 지정자 자리표시자 (소스에도 카탈로그에도 안 나오는 문자).
# 카탈로그 키의 printf 포맷 지정자(%@ %lld %1$@ %.1f %c …). «%%» 는 리터럴 % 라 따로 처리.
RE_FMT = re.compile(
    r'%(?:\d+\$)?[-+ 0#]*\d*(?:\.\d+)?(?:hh|h|ll|l|q|L|z|t|j)?[@dDiuUxXoOfeEgGcsSpaAF]')

def norm_key(k):
    """카탈로그 키의 포맷 지정자 → SENT (%% → 리터럴 %)."""
    out = []; i = 0; n = len(k)
    while i < n:
        if k[i:i+2] == '%%':
            out.append('%'); i += 2; continue
        m = RE_FMT.match(k, i)
        if m:
            out.append(SENT); i = m.end(); continue
        out.append(k[i]); i += 1
    return ''.join(out)

def norm_lit(s):
    """소스 문자열 «리터럴» 의 \\(…) 보간(균형 괄호 통째) → SENT. 그 외 이스케이프 보존."""
    out = []; i = 0; n = len(s)
    while i < n:
        if s[i:i+2] == '\\(':
            depth = 1; i += 2
            while i < n and depth > 0:
                if s[i] == '(': depth += 1
                elif s[i] == ')': depth -= 1
                i += 1
            out.append(SENT); continue
        if s[i] == '\\' and i + 1 < n:
            out.append(s[i:i+2]); i += 2; continue
        out.append(s[i]); i += 1
    return ''.join(out)

def src_literals(text):
    """한 .swift 본문에서 문자열 리터럴 내용만 뽑는다(주석 제외, \"\"\" 블록 포함).
       \"\"\" 블록과 보통 \"…\" 둘 다 잡고, // 와 /* */ 주석은 건너뛴다. 리터럴 안의
       // 나 \"\"\" 안의 \" 는 문자열 모드라 주석/종료로 오인하지 않는다."""
    lits = []; i = 0; n = len(text)
    while i < n:
        two = text[i:i+2]
        if two == '//':
            j = text.find('\n', i); i = n if j < 0 else j; continue
        if two == '/*':
            j = text.find('*/', i); i = n if j < 0 else j + 2; continue
        if text[i:i+3] == '"""':
            j = text.find('"""', i + 3)
            if j < 0: break
            lits.append(text[i+3:j]); i = j + 3; continue
        if text[i] == '"':
            j = i + 1; buf = []
            while j < n:
                if text[j] == '\\' and j + 1 < n:
                    buf.append(text[j:j+2]); j += 2; continue
                if text[j] == '"' or text[j] == '\n': break
                buf.append(text[j]); j += 1
            lits.append(''.join(buf)); i = j + 1; continue
        i += 1
    return lits

# ── [T] 완역 커버리지 헬퍼 (코드가 쓰는 ko 키 ↔ knownRegions 각 로케일이 «실제로 채워졌나») ──
# 방향은 [O] 와 같다(카탈로그를 본다). 단 [O] 는 «죽은 키»(코드 미사용), [T] 는 그 반대 —
# 코드가 «쓰는» 키인데 비-source 로케일 일부/전체가 누락/빈값/state∈{new,needs_review} 인
# «미완역» 을 띄운다. 기준 로케일 집합은 각 앱 project.yml 의 knownRegions(SSOT)에서 읽는다
# — 스크립트에 로케일을 하드코딩하지 않는다(수용 기준).
RE_KNOWN_REGIONS = re.compile(r'knownRegions\s*:\s*\[([^\]]*)\]')

def parse_known_regions(yml_path):
    """project.yml 의 `knownRegions: [ko, en, …, Base]` 한 줄을 정규식으로 읽는다(YAML 의존 없음)."""
    try:
        with open(yml_path, encoding='utf-8') as f:
            txt = f.read()
    except OSError:
        return None
    m = RE_KNOWN_REGIONS.search(txt)
    if not m:
        return None
    regs = [r.strip().strip('"\'') for r in m.group(1).split(',')]
    return [r for r in regs if r]

def find_project_yml(start_dir):
    """카탈로그가 사는 디렉터리에서 위로 올라가며 project.yml(knownRegions SSOT)을 찾는다."""
    cur = os.path.abspath(start_dir)
    while True:
        cand = os.path.join(cur, 'project.yml')
        if os.path.isfile(cand):
            return cand
        parent = os.path.dirname(cur)
        if parent == cur:
            return None
        cur = parent

def _unit_status(su):
    """stringUnit 한 칸의 (ok, reason). value 누락/빈값·state∈{new,needs_review} 면 미완역."""
    if not isinstance(su, dict):
        return (False, 'missing')
    val = su.get('value')
    if val is None:
        return (False, 'missing')
    if val == '':
        return (False, 'empty')
    if su.get('state') in ('new', 'needs_review'):
        return (False, su.get('state'))
    return (True, None)

def locale_status(locmeta):
    """한 로케일 localization 의 (ok, reason). 보간/복수형 키는 stringUnit 이 아니라
       variations(plural/device) 아래 있을 수 있어 두 구조를 모두 본다 — variations 면
       그 안의 모든 하위 stringUnit 이 채워져야 «ok»."""
    if not locmeta:
        return (False, 'missing')
    su = locmeta.get('stringUnit')
    if su is not None:
        return _unit_status(su)
    var = locmeta.get('variations')
    if isinstance(var, dict) and var:
        units = []
        def collect(d):
            for v in d.values():
                if isinstance(v, dict):
                    if 'stringUnit' in v:
                        units.append(v['stringUnit'])
                    else:
                        collect(v)
        collect(var)
        if not units:
            return (False, 'missing')
        for su2 in units:
            ok, reason = _unit_status(su2)
            if not ok:
                return (False, reason)
        return (True, None)
    return (False, 'missing')

def find_catalogs(roots):
    """스캔 경로마다 가장 가까운 조상(자기 포함)의 Localizable.xcstrings 를 찾아
       catalog_path → 그 카탈로그가 사는 «앱 소스 루트 디렉터리» 로 매핑.
       orphan 점검은 (오탐을 줄이려) 루트 «전체» 소스를 봐야 하므로 카탈로그 디렉터리를 쓴다."""
    cats = {}
    for p in roots:
        d = p if os.path.isdir(p) else (os.path.dirname(p) or '.')
        cur = os.path.abspath(d)
        while True:
            cand = os.path.join(cur, 'Localizable.xcstrings')
            if os.path.isfile(cand):
                cats.setdefault(cand, cur); break
            parent = os.path.dirname(cur)
            if parent == cur: break
            cur = parent
    return cats

# 패턴 메타 (코드 → (이름, 신뢰도, 고치는 법))
META = {
    'A': ('ternary-Text(양갈래 한글)', '높음',
          'Text(cond ? "A" : "B") → cond ? Text("A") : Text("B")  (모디파이어 있으면 (…) 로 감싸 바인딩 보존)'),
    'B': ('Text(한글 String변수 경유)', '중간',
          '변수 타입을 LocalizedStringKey 로 (let x: LocalizedStringKey = "…") — String 경유는 verbatim 으로 샌다'),
    'C': ('raw 한글 return (case/errorDescription)', '중간',
          'return "한글" → return String(localized: "한글")'),
    'D': ('중첩 보간 String(localized:)', '높음',
          '보간 안 문자열을 변수로 분리: let s = "\\(x)"; String(localized: "… \\(s)")'),
    'O': ('orphan(코드 미사용 카탈로그 키)', '중간',
          '소스 리터럴 어디에도 안 쓰이는 ko 키 = 죽은 번역. «확인 후» 카탈로그에서 제거. '
          '동적 조회 Text(LocalizedStringKey(변수))면 거짓 양성일 수 있으니 자동 삭제 금지'),
    'T': ('미완역(코드가 쓰는 키인데 일부/전 로케일 누락)', '높음',
          '카탈로그의 해당 로케일에 번역을 채운다(사람/번역 패치 스크립트). knownRegions(SSOT) '
          '각 로케일이 stringUnit value 로 채워지고 state 가 new/needs_review 가 아니어야 함. '
          'localizations 가 «통째로 빈» 키는 추출만 되고 안 채워진 것 — 죽은 키일 수도 있어 --orphans 도 확인'),
}

findings = []   # (path, lineno, code, excerpt)
def add(path, lineno, code, orig):
    findings.append((path, lineno, code, excerpt(orig)))

for fp in swift_files(paths):
    try:
        with open(fp, encoding='utf-8') as f:
            raw = f.read().splitlines()
    except (OSError, UnicodeDecodeError):
        continue

    st = {'block': False}
    depth = 0          # 중괄호 깊이(skel 기준)
    err_depth = None   # errorDescription 류 본문에 들어간 깊이(=재진입 추적)
    decl_stack = []    # [(open_depth, is_lsk)] — case-return 의 가장 가까운 enclosing
                       #   func/연산프로퍼티 선언 반환 타입(LSK 여부). 깊이로 push/pop.
    # B: 파일 단위로 한글 String 리터럴 변수를 먼저 모은다(LocalizedStringKey 미선언만).
    strvars = {}       # name -> def lineno
    lexed = []
    for idx, line in enumerate(raw, 1):
        code, skel = lex(line, st)
        lexed.append((idx, line, code, skel))
        m = RE_STRVAR_DEF.search(code)
        if m and has_hangul(m.group('val')):
            typ = (m.group('type') or '')
            if 'LocalizedStringKey' not in typ and 'LocalizedStringResource' not in typ:
                strvars.setdefault(m.group('name'), idx)

    # 본 스캔은 위에서 만든 lexed 캐시를 그대로 쓴다(재렉싱 없음).
    for idx, line, code, skel in lexed:
        is_log = bool(RE_LOG.search(line))

        # ── A: ternary ─────────────────────────────────────────────
        if not is_log:
            for m in RE_TERNARY.finditer(code):
                seg = m.group(0)
                if 'verbatim:' in seg:
                    continue
                if has_hangul(m.group('t')) or has_hangul(m.group('f')):
                    add(fp, idx, 'A', line); break

        # ── B: Text(식별자) 가 한글 String 변수를 경유 ────────────────
        if not is_log:
            for m in RE_STRVAR_USE.finditer(code):
                nm = m.group('name')
                if nm in strvars and strvars[nm] != idx:
                    add(fp, idx, 'B',
                        line.rstrip() + '   ← 변수 `%s` 한글 리터럴 정의 @L%d' % (nm, strvars[nm]))
                    break

        # ── D: 중첩 보간 String(localized:) ──────────────────────────
        if RE_LOC_CALL.search(code) and '\\("' in code:
            add(fp, idx, 'D', line)

        # ── C: raw 한글 return ───────────────────────────────────────
        # errorDescription 류 «진입» 을 C 검사 «전» 에 판정해 한 줄짜리
        #   var errorDescription: String? { return "한글" } 형태도 잡는다.
        entering = (err_depth is None and RE_ERRDESC_DECL.search(code) and '{' in skel)
        in_err = (err_depth is not None) or entering

        # case-return 의 «가장 가까운 enclosing 선언» 반환 타입이 LSK 인가.
        # 이 줄에서 본문을 여는 선언(func ret / 연산 프로퍼티)이 곧 그 줄 case-return 의
        # 최내곽 — 한 줄짜리 `var x: LocalizedStringKey { switch … case: return "…" }`
        # 형태를 위해 같은 줄에서 먼저 판정한다(skel 로 검사해 문자열 속 '{' 오인 방지).
        mdecl = RE_FUNC_OPEN.search(skel) or RE_VAR_OPEN.search(skel)
        line_decl_lsk = is_lsk_type(mdecl.group('type')) if mdecl else None
        if line_decl_lsk is not None:
            nearest_lsk = line_decl_lsk
        elif decl_stack:
            nearest_lsk = decl_stack[-1][1]
        else:
            nearest_lsk = False

        if not is_log:
            mc = RE_CASE_RET.search(code)
            if mc and has_hangul(mc.group('s')):
                # 가장 가까운 enclosing 선언이 -> LocalizedStringKey/Resource 면 그 case
                # 한글은 자동 localize → 제외. String/String?·미선언이면 양성 유지.
                if not nearest_lsk:
                    add(fp, idx, 'C', line)
            elif in_err and 'case ' not in code:
                # errorDescription 본문 «안» 의 (case 아닌) raw 한글 return.
                # — String? 반환이라 LSK 예외 비대상: 기존대로 [C] 양성 유지.
                mr = RE_RAW_RETURN.search(code)
                if mr and has_hangul(mr.group('s')):
                    add(fp, idx, 'C', line)

        # 중괄호 깊이 갱신 + 선언/errorDescription 컨텍스트 진입·이탈 (skel 기준).
        net = skel.count('{') - skel.count('}')
        depth_end = depth + net
        # 이 줄에서 연 선언이 다음 줄까지 «지속» 하면(net 양수) 스택에 push.
        # 한 줄짜리(net 0, 같은 줄에서 닫힘)는 쌓지 않는다 — 위에서 line_decl_lsk 로 이미 판정.
        if line_decl_lsk is not None and depth_end > depth:
            decl_stack.append((depth, line_decl_lsk))
        if entering:
            err_depth = depth
        depth = depth_end
        if err_depth is not None and depth <= err_depth:
            err_depth = None
        # 닫힌 선언 스코프 pop (가장 안쪽부터).
        while decl_stack and depth <= decl_stack[-1][0]:
            decl_stack.pop()

# ── [O] orphan: 코드 어디서도 안 쓰이는 카탈로그 ko 키 (--orphans 일 때만) ──────────────
# A–D 와 «방향이 반대» — 소스가 아니라 카탈로그를 본다. 카탈로그 ko 키를 보간 정규화한 형태가
# (스캔 경로의) 앱 소스 루트의 어떤 문자열 «리터럴» 과도 안 맞으면 죽은 키 후보로 띄운다.
orphan_findings = []   # (cat_path, key, n_tr, n_locales)
if ORPHANS:
    for cat_path, root in find_catalogs(paths).items():
        try:
            with open(cat_path, encoding='utf-8') as f:
                data = json.load(f)
        except (OSError, ValueError):
            continue
        strings = data.get('strings', {})
        # 소스 루트의 모든 .swift 리터럴을 보간 정규화해 «쓰임» 집합으로.
        used = set()
        for fp in swift_files([root]):
            try:
                with open(fp, encoding='utf-8') as f:
                    text = f.read()
            except (OSError, UnicodeDecodeError):
                continue
            for lit in src_literals(text):
                used.add(norm_lit(lit))
        # 이 카탈로그에 등장하는 로케일 수(=번역 «분모») — «N/L» 로 죽은 비용을 보인다.
        locale_set = set()
        for meta in strings.values():
            locale_set.update((meta or {}).get('localizations', {}).keys())
        n_locales = len(locale_set)
        for key, meta in strings.items():
            if not has_hangul(key):          # ko(한글 포함) 키만 — 코드/식별자/단위 제외
                continue
            if norm_key(key) in used:        # 보간 정규화 후 소스 리터럴과 일치 → 살아있음
                continue
            locs = (meta or {}).get('localizations', {})
            n_tr = sum(1 for v in locs.values()
                       if (v or {}).get('stringUnit', {}).get('value'))
            orphan_findings.append((cat_path, key, n_tr, n_locales))

# ── [T] 완역 커버리지: 코드가 쓰는 ko 키가 knownRegions 각 로케일에 «실제로» 채워졌나 (--coverage) ──
# [O] 와 «방향은 같고 의미는 반대»: 코드가 쓰는(=orphan 아닌) 키인데 비-source 로케일이
#   누락/빈값/state∈{new,needs_review} 면 «미완역» 후보로 띄운다(키 + 누락 로케일). 기준 로케일은
#   각 앱 project.yml 의 knownRegions(SSOT, Base·source 제외)에서 읽는다 — 하드코딩 안 함.
coverage_findings = []   # (cat_path, key, [missing_locale, …])
if COVERAGE:
    for cat_path, root in find_catalogs(paths).items():
        try:
            with open(cat_path, encoding='utf-8') as f:
                data = json.load(f)
        except (OSError, ValueError):
            continue
        yml = find_project_yml(root)
        regions = parse_known_regions(yml) if yml else None
        if not regions:
            # knownRegions(SSOT)를 못 읽으면 «로케일 하드코딩 금지» 원칙상 이 카탈로그는 건너뛴다.
            # (stderr 진단 — --quiet 여도 «왜 점검을 건너뛰었는지» 는 알려야 한다.)
            sys.stderr.write(
                "i18n-lint: [T] %s — project.yml knownRegions 미발견, 커버리지 점검 생략\n"
                % cat_path)
            continue
        source = data.get('sourceLanguage', 'ko')
        required = [r for r in regions if r not in ('Base', source)]
        strings = data.get('strings', {})
        # orphan 판정 재사용을 위해 소스 루트 리터럴을 보간 정규화해 «쓰임» 집합으로.
        used = set()
        for fp in swift_files([root]):
            try:
                with open(fp, encoding='utf-8') as f:
                    text = f.read()
            except (OSError, UnicodeDecodeError):
                continue
            for lit in src_literals(text):
                used.add(norm_lit(lit))
        for key, meta in strings.items():
            if not has_hangul(key):            # 코드/식별자/단위 키는 번역 대상 아님 → 제외
                continue
            meta = meta or {}
            if meta.get('shouldTranslate') is False:   # 비번역 의도 명시
                continue
            locs = meta.get('localizations', {}) or {}
            # 비번역 의도(식별자/단위류): present 로케일이 «있고» 그 값이 모두 원문(키)과 동일.
            #   (present 가 하나도 없으면 빈 집합 → 이 억제를 적용하지 않는다 = 빈 키는 보고 대상.)
            present_vals = [su.get('value')
                            for lm in locs.values()
                            for su in [((lm or {}).get('stringUnit') or {})]
                            if 'value' in su]
            if present_vals and all(v == key for v in present_vals):
                continue
            missing = [loc for loc in required if not locale_status(locs.get(loc))[0]]
            if not missing:
                continue
            is_orphan = norm_key(key) not in used
            locs_empty = len(locs) == 0
            # 완전히 빈({}) 키는 orphan 이어도 보고(추출만 되고 안 채워진 미완역).
            #   그 외 «부분» 누락은 코드가 실제로 쓰는(=non-orphan) 키만 — orphan 은 [O] 소관.
            if is_orphan and not locs_empty:
                continue
            coverage_findings.append((cat_path, key, sorted(missing)))

# ── 출력 ─────────────────────────────────────────────────────────────────────
RST, BOLD, DIM = '\033[0m', '\033[1m', '\033[2m'
if not sys.stdout.isatty():
    RST = BOLD = DIM = ''

cwd = os.getcwd()
def relp(p):
    try:
        r = os.path.relpath(p, cwd)
        return r if not r.startswith('..') else p
    except ValueError:
        return p

if not QUIET:
    title = "카탈로그 우회 안티패턴 후보 스캔"
    if ORPHANS:
        title += " + orphan(죽은 카탈로그 키) 점검"
    if COVERAGE:
        title += " + 완역 커버리지([T]) 점검"
    print("%si18n-lint%s — %s (CLAUDE.md 기준 휴리스틱)" % (BOLD, RST, title))
    print("%s스캔 대상: %s%s" % (DIM, ', '.join(relp(p) for p in paths), RST))
    print()

total_src = len(findings)
total_orphan = len(orphan_findings)
total_coverage = len(coverage_findings)

if total_src == 0 and total_orphan == 0 and total_coverage == 0:
    if not QUIET:
        extra = []
        if ORPHANS:  extra.append("orphan(죽은 키)")
        if COVERAGE: extra.append("미완역([T])")
        if extra:
            print("✅ 후보 0건 — 카탈로그 우회 안티패턴·%s 모두 안 보입니다." % "·".join(extra))
        else:
            print("✅ 후보 0건 — 카탈로그 우회 안티패턴이 보이지 않습니다.")
    sys.exit(0)

# ── 소스 안티패턴 (A–D) ───────────────────────────────────────────────────────
# 패턴별 그룹 (A,B,C,D 순), 그 안은 경로:라인 순.
order = {'A': 0, 'B': 1, 'C': 2, 'D': 3}
findings.sort(key=lambda x: (order[x[2]], x[0], x[1]))

counts = {'A': 0, 'B': 0, 'C': 0, 'D': 0}
for _, _, code, _ in findings:
    counts[code] += 1

last_code = None
for path, lineno, code, exc in findings:
    if code != last_code:
        name, conf, fix = META[code]
        print("%s■ [%s] %s — 신뢰도 %s (%d건)%s" % (BOLD, code, name, conf, counts[code], RST))
        print("%s   고치는 법: %s%s" % (DIM, fix, RST))
        last_code = code
    name = META[code][0]
    # 수용 기준 출력 형식: «경로:라인 — 패턴명 — 발췌»
    print("%s:%d — [%s] %s — %s" % (relp(path), lineno, code, name, exc))
if findings:
    print()

# ── [O] orphan (죽은 카탈로그 키) ─────────────────────────────────────────────
if orphan_findings:
    name, conf, fix = META['O']
    print("%s■ [O] %s — 신뢰도 %s (%d건)%s" % (BOLD, name, conf, total_orphan, RST))
    print("%s   고치는 법: %s%s" % (DIM, fix, RST))
    # 카탈로그별 그룹, 그 안은 번역수(=죽은 비용) 많은 순 → 키 길이 순 → 키 순.
    orphan_findings.sort(key=lambda x: (relp(x[0]), -x[2], -len(x[1]), x[1]))
    last_cat = None
    for cat_path, key, n_tr, n_locales in orphan_findings:
        rc = relp(cat_path)
        if rc != last_cat:
            print("%s   ─ %s%s" % (DIM, rc, RST))
            last_cat = rc
        # 수용 기준 출력 형식: «카탈로그 — 패턴명 — 발췌» (라인 대신 «번역 N/L»).
        print("%s — [O] orphan(번역 %d/%d) — %s" % (rc, n_tr, n_locales, excerpt(key)))
    print()

# ── [T] 미완역 커버리지 (코드가 쓰는 키인데 일부/전 로케일 누락) ─────────────────────
if coverage_findings:
    name, conf, fix = META['T']
    print("%s■ [T] %s — 신뢰도 %s (%d건)%s" % (BOLD, name, conf, total_coverage, RST))
    print("%s   고치는 법: %s%s" % (DIM, fix, RST))
    # 카탈로그별 그룹, 그 안은 누락 로케일 많은 순 → 키 순.
    coverage_findings.sort(key=lambda x: (relp(x[0]), -len(x[2]), x[1]))
    last_cat = None
    for cat_path, key, missing in coverage_findings:
        rc = relp(cat_path)
        if rc != last_cat:
            print("%s   ─ %s%s" % (DIM, rc, RST))
            last_cat = rc
        # 수용 기준 출력 형식: «키 + 누락 로케일». (라인 대신 «누락 N: 로케일들».)
        print("%s — [T] 미완역(누락 %d: %s) — %s" % (rc, len(missing), ','.join(missing), excerpt(key)))
    print()

total = total_src + total_orphan + total_coverage
counts_str = "A=%d  B=%d  C=%d  D=%d" % (counts['A'], counts['B'], counts['C'], counts['D'])
if ORPHANS:
    counts_str += "  O=%d" % total_orphan
if COVERAGE:
    counts_str += "  T=%d" % total_coverage
print("%s합계: %d건  (%s)%s" % (BOLD, total, counts_str, RST))

if not QUIET:
    print()
    print("%s거짓 양성 처리법:%s" % (BOLD, RST))
    print("  · 정말 번역 대상이 아니면(코드/식별자/.onion/단위 등) Text(verbatim:) 로 «명시» 하면 스캔에서 빠집니다.")
    print("  · 변수가 이미 LocalizedStringKey 면 [B] 는 오탐 — 무시하거나 타입 주석을 명시하세요.")
    print("  · [C] 는 enclosing 선언이 -> LocalizedStringKey/Resource 면 자동 제외 — String 반환에서만 뜹니다.")
    print("  · [C] 의 raw 한글 return 이 «화면에 안 보이는» 내부 값이면 의도를 한 줄 주석으로 남기세요.")
    if orphan_findings:
        print("  · [O] 는 «자동 삭제 안 함» — 동적 조회 Text(LocalizedStringKey(변수))로 쓰는 키는 거짓 양성입니다.")
        print("    카탈로그에서 지우기 «전» 에 그 키가 정말 안 쓰이는지(런타임/백엔드 문자열 포함) 확인하세요.")
        print("    «번역 N/L» 이 클수록 죽은 채 굳은 번역 비용이 큽니다(=우선 정리 대상).")
    if coverage_findings:
        print("  · [T] 는 «번역 채움» 이 약이지 자동 생성이 아닙니다 — 누락 로케일에 사람/번역 패치로 value 를 채우세요.")
        print("    카탈로그에 키가 «통째로 빈»({}) 채 남았는데 코드가 안 쓰면 죽은 키일 수 있으니 --orphans 도 보세요.")
        print("    비번역 의도(식별자/단위)면 모든 로케일을 원문과 동일하게 두거나 shouldTranslate:false 로 «명시» 하세요.")
    print("  · 이 도구는 «후보 표면화» 가 목적입니다(완전한 파서 아님). 최종 판정은 사람이 합니다.")
    print("%s  PO 자가검증/‐verify-ios 에서는 «이 변경(diff)이 새로 들인» 후보에 집중하세요 — 기존 부채를 한꺼번에 막진 않습니다.%s" % (DIM, RST))

sys.exit(0 if SOFT else 1)
PYEOF
