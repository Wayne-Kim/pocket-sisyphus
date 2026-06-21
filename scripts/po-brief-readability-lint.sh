#!/usr/bin/env bash
#
# po-brief-readability-lint.sh — PO 산출 «기회 브리프» 의 가독성(이해 가능성) 정적 검사.
# i18n-lint.sh·design-lint.sh·po-agent-lint.sh 와 같은 패밀리(휴리스틱·리포트·게이트 계약).
#
# 왜: 시각 디자인(design-lint)·중복(similarity dedup)엔 자동 게이트가 있는데 «이해 가능성» 엔 없었다.
#   프롬프트를 평이하게 고쳐도(브리프 1), 보정 앵커(과거 결정 요약)와 모델 드리프트로 몇 달 운영하면
#   제목이 다시 빽빽해진다(파일경로·코드심볼·«—» 다중 절이 제목/problem 으로 샌다). 막을 자동 장치가
#   없어 사람이 매번 눈으로 잡지 않으면 «점점 어려워짐» 이 재발한다. 이 린트가 그 회귀를 근원에서
#   «후보» 로 띄운다 — daemon 런타임 측 미러는 readability.ts(ingest 소프트 경고)다(둘 다 테스트 고정).
#
# 탐지 패밀리:
#   R1. 제목 80자 초과 — 프롬프트가 모든 로케일에서 «80자 이내» 로 선언하는 권고 한계(코드측 SSOT 는
#       readability.TITLE_ADVISORY_MAX). executor 의 하드 cap(200)은 DB 안전 백스톱이지 선언이 아니다.
#   R2. 제목에 파일경로(.ts/.swift/.sh…) 또는 전부-대문자 코드 심볼(SCREAMING_SNAKE) 단독 포함 —
#       코드 참조는 제목이 아니라 evidence.ref 로. (밑줄 없는 약어 SSH·URL·API 는 비대상.)
#   R3. 제목을 «—»(em/en-dash)로 잇는 절이 2개 초과(=대시 ≥2 → 절 ≥3개) — 한 문장으로.
#   R4. problem 첫 줄이 코드 참조/심볼로 시작(백틱·파일경로·file:line·SCREAMING_SNAKE·점-멤버/호출) —
#       «누가·언제·무엇이 불편한가» 로 시작하라.
#
# 화이트리스트(거짓양성 최소화): URL·이슈번호(#123)는 코드-형태 검사 «전» 에 비운다. 불가피한 고유명/
#   약어(Tor·SSH·Onion·API…)는 R2 가 «밑줄 있는» 심볼만 보므로 자연 통과하고, R4 의 점-멤버/호출
#   시작 판정에선 첫 토큰이 고유명이면 제외한다. (디자인 토큰 검사는 아님 — 비-UI 브리프에도 동일 적용.)
#
# 비-목표: 내용 자동 재작성(브리프 1 의 프롬프트 측)·하드 reject(이 린트는 «표면화» 뿐)·사람이 쓴
#   GitHub 이슈 검사. 최종 판정은 사람이 한다(design-lint 와 같은 톤·계약).
#
# 입력: 인자로 «브리프 배열 JSON 파일» 경로들(회귀 테스트가 사용). 인자가 없으면 stdin 의 JSON 을 읽는다
#   (예: cat briefs.json | po-brief-readability-lint.sh). 배열·단일 객체·{briefs:[…]} 모두 받는다.
#
# 사용법(기존 린트와 동일 인터페이스):
#   ./scripts/po-brief-readability-lint.sh FILE.json ...   # 지정 JSON 파일들
#   cat briefs.json | ./scripts/po-brief-readability-lint.sh
#   ./scripts/po-brief-readability-lint.sh --soft           # «리포트만» — 후보 있어도 항상 0 종료(게이트 끔)
#   ./scripts/po-brief-readability-lint.sh --quiet          # 안내/가이드 헤더 생략(기계 소비용)
#
# 종료코드: 후보 0 → 0, 1건 이상 → 1 (호출자가 게이트로 쓸 수 있게). --soft 면 항상 0.
#
set -euo pipefail

SOFT=0
QUIET=0
PATHS=()

for arg in "$@"; do
  case "$arg" in
    --soft|--no-fail) SOFT=1 ;;
    --quiet|-q)       QUIET=1 ;;
    -h|--help)
      sed -n '2,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    --*) echo "po-brief-readability-lint: 알 수 없는 옵션: $arg" >&2; exit 2 ;;
    *)   PATHS+=("$arg") ;;
  esac
done

# 모든 휴리스틱은 파이썬에 둔다 — 유니코드(코드포인트 길이·«—» 대시)·JSON 파싱이 grep/sed 보다 안정적.
# 따옴표 친 heredoc('PYEOF') 라 셸 확장이 없어 정규식의 역슬래시/달러가 그대로 전달된다. 이 규칙은
# readability.ts 와 «미러» 다 — 한쪽을 고치면 다른 쪽도 고치고, 양쪽 테스트가 드리프트를 잡는다.
# 스크립트를 변수로 받아 «프로세스 치환» 으로 실행한다 — 그래야 stdin 이 비어, 인자 없을 때 stdin 의
# JSON 을 읽을 수 있다(heredoc 을 python 의 stdin 으로 주면 stdin 이 스크립트로 점유돼 입력을 못 읽음).
PYSRC="$(cat <<'PYEOF'
import os, re, sys, json

SOFT  = os.environ.get("SOFT", "0") == "1"
QUIET = os.environ.get("QUIET", "0") == "1"
paths = sys.argv[1:]

# ── 가독성 휴리스틱 (readability.ts 미러) ───────────────────────────────────────────────
TITLE_ADVISORY_MAX = 80          # 프롬프트 «80자 이내» 선언과 동일. readability.TITLE_ADVISORY_MAX 미러.
MAX_TITLE_CLAUSE_DASHES = 1      # 대시 ≥2 → 절 ≥3개 → R3.

CODE_EXT = ("ts|tsx|js|jsx|mjs|cjs|swift|sh|bash|zsh|py|rb|go|rs|java|kt|kts|c|h|cc|cpp|hpp|"
            "m|mm|json|yml|yaml|toml|sql|css|scss|html|htm|md|plist|xcstrings")

# 불가피한 고유명/약어 (소문자화) — R4 의 점-멤버/호출 시작 판정에서 첫 토큰이 이거면 제외.
PROPER_NOUNS = set(s.lower() for s in (
    "Tor","SSH","SSHD","Onion","HTTP","HTTPS","URL","URI","API","CLI","GUI",
    "PTY","QR","LLM","UI","UX","OS","iOS","macOS","ID","PO","CI","CD",
    "DB","SQL","JWT","ASC","JSON","YAML","TOML","CSV","TSV","SDK","MCP",
    "DAG","DMG","PR","IP","TCP","UDP","DNS","TLS","SSL","NAT","UPnP",
    "GitHub","TestFlight","SwiftUI","UIKit","Xcode","npm","pnpm","Discord","Markdown",
))

RE_URL        = re.compile(r'\bhttps?://\S+', re.I)
RE_ISSUE      = re.compile(r'#\d+\b', re.A)
RE_FILEPATH   = re.compile(r'(?:[\w.\-]+/)*[\w.\-]+\.(?:' + CODE_EXT + r')\b(?::\d+(?:-\d+)?)?', re.I | re.A)
RE_SNAKE      = re.compile(r'\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b', re.A)
RE_SNAKE_HEAD = re.compile(r'^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+', re.A)
RE_MEMBER     = re.compile(r'^([A-Za-z_$][\w$]*)((?:\.[A-Za-z_$][\w$]*)+|\s*\()', re.A)
RE_LONGDASH   = re.compile('[—–]')   # em-dash · en-dash. ASCII 하이픈은 비대상.

def strip_whitelisted(s):
    return RE_ISSUE.sub(" ", RE_URL.sub(" ", s))

def first_nonempty_line(s):
    for ln in s.splitlines():
        t = ln.strip()
        if t:
            return t
    return ""

def analyze_title(title):
    out = []   # (code, message)
    t = (title or "").strip()
    if not t:
        return out
    # ① 길이(코드포인트). 파이썬 str len 은 코드포인트라 [...str].length 와 일치.
    n = len(t)
    if n > TITLE_ADVISORY_MAX:
        out.append(("R1", "제목 %d자 (권고 %d자 초과)" % (n, TITLE_ADVISORY_MAX)))
    scrubbed = strip_whitelisted(t)
    # ② 파일경로 / 전부-대문자 심볼.
    fp = RE_FILEPATH.search(scrubbed)
    if fp:
        out.append(("R2", "제목에 파일경로 «%s» — 코드 참조는 evidence.ref 로" % fp.group(0)))
    else:
        sym = RE_SNAKE.search(scrubbed)
        if sym:
            out.append(("R2", "제목에 코드 심볼 «%s» — 평이한 말로" % sym.group(0)))
    # ③ «—» 다중 절.
    dashes = len(RE_LONGDASH.findall(scrubbed))
    if dashes > MAX_TITLE_CLAUSE_DASHES:
        out.append(("R3", "제목 «—» 다중 절 %d개 (권고 2개 이하) — 한 문장으로" % (dashes + 1)))
    return out

def analyze_problem(problem):
    out = []
    line = first_nonempty_line(problem or "")
    if not line:
        return out
    # 화이트리스트: URL·이슈번호 시작은 정당한 참조 — 위반 아님.
    if re.match(r'https?://', line, re.I) or re.match(r'#\d+\b', line, re.A):
        return out
    if line.startswith('`'):
        out.append(("R4", "problem 첫 줄이 코드 스팬(`…`)으로 시작 — 누가/언제/무엇이 불편한가로"))
        return out
    fp = RE_FILEPATH.search(line)
    if fp and fp.start() == 0:
        out.append(("R4", "problem 첫 줄이 파일경로 «%s» 로 시작 — 코드 참조는 evidence.ref 로" % fp.group(0)))
        return out
    snake = RE_SNAKE_HEAD.match(line)
    if snake:
        out.append(("R4", "problem 첫 줄이 코드 심볼 «%s» 로 시작 — 평이한 말로" % snake.group(0)))
        return out
    member = RE_MEMBER.match(line)
    if member and member.group(1).lower() not in PROPER_NOUNS:
        out.append(("R4", "problem 첫 줄이 코드 참조/심볼 «%s» 로 시작 — 평이한 말로" % member.group(0).strip()))
        return out
    return out

def analyze_brief(b):
    title = b.get("title") if isinstance(b, dict) else None
    problem = b.get("problem") if isinstance(b, dict) else None
    title = title if isinstance(title, str) else ""
    problem = problem if isinstance(problem, str) else ""
    return analyze_title(title), analyze_problem(problem), title

# ── 입력 수집: 파일 경로들 또는 stdin. 각 소스의 JSON 을 «브리프 목록» 으로 정규화. ─────────────
def to_brief_list(parsed):
    if isinstance(parsed, list):
        return parsed
    if isinstance(parsed, dict):
        if isinstance(parsed.get("briefs"), list):
            return parsed["briefs"]
        return [parsed]   # 단일 브리프 객체
    return []

sources = []   # (label, [briefs])
errors = []
if paths:
    for p in paths:
        try:
            with open(p, encoding="utf-8") as f:
                parsed = json.load(f)
        except (OSError, UnicodeDecodeError) as e:
            errors.append("%s: 읽기 실패 (%s)" % (p, e))
            continue
        except json.JSONDecodeError as e:
            errors.append("%s: JSON 파싱 실패 (%s)" % (p, e))
            continue
        sources.append((p, to_brief_list(parsed)))
else:
    raw = sys.stdin.read()
    if raw.strip():
        try:
            sources.append(("stdin", to_brief_list(json.loads(raw))))
        except json.JSONDecodeError as e:
            errors.append("stdin: JSON 파싱 실패 (%s)" % e)

# ── 분석 ────────────────────────────────────────────────────────────────────────────
findings = []   # (source, idx, code, title_excerpt, detail)
def excerpt(s):
    s = (s or "").strip().replace("\n", " ")
    return s if len(s) <= 80 else s[:77] + "…"

for label, briefs in sources:
    for i, b in enumerate(briefs, 1):
        tsigs, psigs, title = analyze_brief(b)
        for code, msg in (tsigs + psigs):
            findings.append((label, i, code, excerpt(title), msg))

# ── 출력 (design-lint 와 동형) ─────────────────────────────────────────────────────────
RST, BOLD, DIM = '\033[0m', '\033[1m', '\033[2m'
if not sys.stdout.isatty():
    RST = BOLD = DIM = ''

cwd = os.getcwd()
def relp(p):
    if p == "stdin":
        return p
    try:
        r = os.path.relpath(p, cwd)
        return r if not r.startswith('..') else p
    except ValueError:
        return p

META = {
    'R1': ('제목 길이 초과', '권고 80자',
           '제목을 %d자 이내로. 프롬프트가 모든 로케일에서 «80자 이내» 로 선언한다(하드 cap 200 은 DB 백스톱).' % TITLE_ADVISORY_MAX),
    'R2': ('제목 코드참조/심볼', '중간',
           '파일경로/SCREAMING_SNAKE 심볼을 제목에서 빼고 평이한 말로 — 코드 참조는 evidence.ref 에 둔다.'),
    'R3': ('제목 «—» 다중 절', '중간',
           '«—»(em/en-dash)로 절을 3개 이상 잇지 말고 한 문장으로. (절 2개 이하 권고.)'),
    'R4': ('problem 첫 줄 코드 시작', '중간',
           'problem 은 «누가·언제·무엇이 불편한가» 로 시작 — 백틱/파일경로/심볼로 시작하지 않는다.'),
}

if not QUIET:
    print("%spo-brief-readability-lint%s — PO 브리프 가독성 위반 «후보» 스캔 (readability.ts 휴리스틱 미러)" % (BOLD, RST))
    if paths:
        print("%s스캔 대상: %s%s" % (DIM, ', '.join(relp(p) for p in paths), RST))
    else:
        print("%s스캔 대상: stdin%s" % (DIM, RST))
    print()

for e in errors:
    print("%s⚠ %s%s" % (DIM, e, RST), file=sys.stderr)

if not findings:
    if not QUIET:
        print("✅ 후보 0건 — 브리프 제목·요약 가독성 위반 후보가 보이지 않습니다.")
    # 입력 자체가 깨졌으면(파싱 0건+에러) 비-0 으로 알린다(게이트가 «조용히 통과» 하지 않게).
    if errors and not sources:
        sys.exit(0 if SOFT else 1)
    sys.exit(0)

order = {'R1': 0, 'R2': 1, 'R3': 2, 'R4': 3}
findings.sort(key=lambda x: (order[x[2]], x[0], x[1]))
counts = {'R1': 0, 'R2': 0, 'R3': 0, 'R4': 0}
for f in findings:
    counts[f[2]] += 1

last = None
for src, idx, code, exc, detail in findings:
    if code != last:
        name, conf, fix = META[code]
        print("%s■ [%s] %s — %s (%d건)%s" % (BOLD, code, name, conf, counts[code], RST))
        print("%s   고치는 법: %s%s" % (DIM, fix, RST))
        last = code
    print("%s#%d  %s  ← [%s] %s" % (relp(src), idx, exc, code, detail))

print()
print("%s합계: %d건  (R1=%d  R2=%d  R3=%d  R4=%d)%s" %
      (BOLD, len(findings), counts['R1'], counts['R2'], counts['R3'], counts['R4'], RST))

if not QUIET:
    print()
    print("%s거짓 양성 처리법:%s" % (BOLD, RST))
    print("  · URL·이슈번호(#123)·불가피한 고유명(Tor·SSH·Onion·API…)은 화이트리스트라 후보가 아닙니다.")
    print("  · 이 린트는 «후보 표면화» 가 목적입니다(내용 재작성·하드 reject 아님). 최종 판정은 사람이 합니다.")
    print("%s  PO 자가검증에서는 «이번 산출이 새로 들인» 후보에 집중하세요.%s" % (DIM, RST))

sys.exit(0 if SOFT else 1)
PYEOF
)"

# 인자(PATHS)가 비어도 set -u 에서 안전한 확장(${arr[@]+...}). stdin 은 프로세스 치환 덕에 비어 있다.
SOFT="$SOFT" QUIET="$QUIET" python3 <(printf '%s' "$PYSRC") ${PATHS[@]+"${PATHS[@]}"}
