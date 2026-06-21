#!/usr/bin/env bash
#
# agent-surfaces-lint.sh — 에이전트 픽커 «SSOT» 와 «사용자에게 에이전트 목록을 노출하는 5개
# 다운스트림 표면» 의 정합을 정적으로 대조해, 표면이 뒤처졌을 때 «표면:라인 — 누락/표기불일치»
# 를 표면화한다. design-lint.sh·i18n-lint.sh 와 같은 패밀리(휴리스틱·리포트·게이트 계약).
#
# 왜: README SSOT 주석이 «픽커가 SSOT 이고 모든 표면을 함께 갱신해야 드리프트가 안 난다» 고
# 못박았는데도, 사람이 6곳을 수동으로 맞추는 한 또 어긋난다(OpenCode 가 픽커엔 있는데 README·
# 가이드·웹·스토어·Discussions 엔 빠진 채로 carry-forward 된 이력). 이 스크립트가 픽커에
# 에이전트를 추가/제거하면 어느 표면이 뒤처졌는지 자동으로 알려 그 수동 점검 토일을 없앤다.
#
# ── SSOT (1차 기준) ─────────────────────────────────────────────────────────────────────
#   · 표시명(displayName) : iOS `ios/PocketSisyphus/Models/AgentKind.swift` 의 `displayName`
#     switch (+ `rawId` switch 로 daemon id ↔ 표시명 매핑).
#   · 등록·열거 순서       : daemon `mac/daemon/src/agent/index.ts` 의 `registerBuiltinAgents()`
#     registerAgent(...) 호출 순서 (adapter import 경로 dir → rawId, '-'→'_').
#   · 분류                 : shell=Terminal·local_llm=Qwen Code 는 «코드 에이전트» 가 아니라
#     «고급 도구» — README/가이드의 «코드 에이전트» 목록엔 넣지 않는 규약(이 분류를 인지해
#     가이드에서 그 둘을 요구하지 않아 오탐을 막는다). 웹 agents.items 만 «선택 가능한 항목»
#     이라 고급 도구까지 포함해 검사한다. unknown(raw) 는 표면 동기화 대상 아님.
#
# ── 검사하는 5개 표면 (README SSOT 주석이 열거한 집합과 «일치» — 하나 빠지면 검사가 헛돈다) ──
#   1. README           README.md  「Supported code agents」 섹션          (코드)
#   2. README.ko        README.ko.md  「지원하는 코드 에이전트」 섹션       (코드)
#   3. web              web/content/site.en.ts  `agents.items`            (코드+고급)
#   4. iOS 가이드        ios/PocketSisyphus/Models/GuideContent.swift     (코드)
#   5. Mac 가이드        mac/PocketSisyphusMac/GuideContent.swift          (코드)
#
# ── 판정 (수용 기준: 집합 누락 = «실패», 순서 불일치 = «경고») ─────────────────────────────
#   · [MISS]  표면에 픽커 에이전트의 표시명이 «없음»(또는 표기불일치 — 예: 웹이 «Local LLM»
#             으로 적어 displayName 「Qwen Code」 와 어긋남). → 실패(비-0 종료).
#   · [ORDER] 모든 에이전트가 있으나 열거 순서가 daemon 등록 순서와 다름. → 경고(종료코드 영향 없음).
#   · [WARN]  표면에서 «에이전트 나열 줄» 을 못 찾음(구조가 바뀌었을 수 있음) 등. → 경고.
#   · [SSOT]  daemon 등록 집합과 AgentKind 집합이 어긋남(SSOT 내부 드리프트). → 실패.
#
# ── 한계 (리포트에 명시) ─────────────────────────────────────────────────────────────────
#   · «후보 표면화» 가 목적이다(완전 파서 아님) — 거짓 양성이 있을 수 있고 최종 판정은 사람이.
#
# 사용법:
#   ./scripts/agent-surfaces-lint.sh                 # 기본: repo 루트의 5개 표면 대조, 실패 있으면 비-0
#   ./scripts/agent-surfaces-lint.sh ROOT            # ROOT 를 repo 루트로 보고 대조(회귀 테스트가 사용)
#   ./scripts/agent-surfaces-lint.sh --soft          # «리포트만» — 실패가 있어도 항상 0 종료(게이트 끔)
#   ./scripts/agent-surfaces-lint.sh --quiet         # 안내/가이드 헤더 생략(기계 소비용)
#   ./scripts/agent-surfaces-lint.sh --list-surfaces # 검사 표면 목록 출력(key<TAB>경로) 후 종료
#
# 종료코드: [MISS]/[SSOT] 0건 → 0, 1건 이상 → 1. --soft 면 항상 0. [ORDER]/[WARN] 은 종료코드에 영향 없음.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

SOFT=0
QUIET=0
LIST=0
ROOT="$REPO_ROOT"

for arg in "$@"; do
  case "$arg" in
    --soft|--no-fail)   SOFT=1 ;;
    --quiet|-q)         QUIET=1 ;;
    --list-surfaces)    LIST=1 ;;
    -h|--help)
      sed -n '2,62p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    --*) echo "agent-surfaces-lint: 알 수 없는 옵션: $arg" >&2; exit 2 ;;
    *)   ROOT="$arg" ;;
  esac
done

# 모든 휴리스틱(스위치 파싱·등록 순서·표면 추출)은 파이썬에. 따옴표 친 heredoc('PYEOF') 라
# 셸 확장이 없어 정규식의 역슬래시/달러가 그대로 전달된다.
SOFT="$SOFT" QUIET="$QUIET" LIST="$LIST" ROOT="$ROOT" python3 - <<'PYEOF'
import os, re, sys, glob

SOFT  = os.environ.get("SOFT", "0") == "1"
QUIET = os.environ.get("QUIET", "0") == "1"
LIST  = os.environ.get("LIST", "0") == "1"
ROOT  = os.environ.get("ROOT", ".")

def read(p):
    try:
        with open(p, encoding='utf-8') as f:
            return f.read()
    except (OSError, UnicodeDecodeError):
        return None

# ── 출력 유틸 ────────────────────────────────────────────────────────────────────────────
RST, BOLD, DIM = '\033[0m', '\033[1m', '\033[2m'
if not sys.stdout.isatty():
    RST = BOLD = DIM = ''

def relp(p):
    try:
        r = os.path.relpath(p, os.getcwd())
        return r if not r.startswith('..') else p
    except ValueError:
        return p

# ── 중괄호/대괄호 매칭 영역 ───────────────────────────────────────────────────────────────
def matched_region(txt, open_idx, op='{', cl='}'):
    """txt[open_idx] == op 인 위치에서 시작해 균형 잡힌 닫힘까지의 «내부» 문자열."""
    depth = 0; i = open_idx; n = len(txt)
    while i < n:
        c = txt[i]
        if c == op: depth += 1
        elif c == cl:
            depth -= 1
            if depth == 0:
                return txt[open_idx + 1:i]
        i += 1
    return txt[open_idx + 1:]

# ── SSOT 파싱 ────────────────────────────────────────────────────────────────────────────
def parse_switch(txt, varname):
    """AgentKind.swift 의 `var <varname>: String { switch … case .X: return "Y" }` → {case: val}."""
    m = re.search(r'var\s+' + re.escape(varname) + r'\s*:\s*String\s*\{', txt)
    if not m:
        return {}
    body = matched_region(txt, txt.index('{', m.start()))
    out = {}
    for mm in re.finditer(r'case\s+\.(\w+)\s*:\s*return\s+"((?:\\.|[^"\\])*)"', body):
        out[mm.group(1)] = mm.group(2)
    return out

def parse_agentkind(txt):
    """AgentKind.swift → {rawId: displayName} (case 이름으로 두 switch 를 조인)."""
    rawid   = parse_switch(txt, 'rawId')       # case -> raw id
    display = parse_switch(txt, 'displayName') # case -> display name
    agents = {}
    for case, rid in rawid.items():
        if case in display:
            agents[rid] = display[case]
    return agents

def parse_daemon_order(txt):
    """index.ts → registerBuiltinAgents() 의 registerAgent(...) 순서 → [rawId, …].
       adapter import 경로 dir 를 rawId 로 환산('-'→'_')한다(= 각 adapter 의 id 규약)."""
    imp = {}
    for m in re.finditer(
            r'import\s*\{\s*(\w+)\s*\}\s*from\s*["\']\./adapters/([\w-]+)/index\.js["\']', txt):
        imp[m.group(1)] = m.group(2).replace('-', '_')
    fm = re.search(r'function\s+registerBuiltinAgents\s*\([^)]*\)\s*(?::\s*\w+\s*)?\{', txt)
    body = matched_region(txt, txt.index('{', fm.start())) if fm else txt
    order = []
    for m in re.finditer(r'registerAgent\(\s*(\w+)\s*\)', body):
        v = m.group(1)
        if v in imp and imp[v] not in order:
            order.append(imp[v])
    return order

# 고급 도구(코드 에이전트 아님) — README/가이드의 «코드 에이전트» 목록에서 제외하는 분류.
ADVANCED = {'shell', 'local_llm'}

AK_PATH  = os.path.join(ROOT, 'ios/PocketSisyphus/Models/AgentKind.swift')
DMN_PATH = os.path.join(ROOT, 'mac/daemon/src/agent/index.ts')

ak_txt  = read(AK_PATH)
dmn_txt = read(DMN_PATH)

ssot_errors = []   # SSOT 파싱/내부 정합 실패(meta)
agents = parse_agentkind(ak_txt) if ak_txt else {}
order  = parse_daemon_order(dmn_txt) if dmn_txt else []

if not agents:
    ssot_errors.append("AgentKind.swift 에서 displayName/rawId 스위치를 못 읽음: %s" % relp(AK_PATH))
if not order:
    ssot_errors.append("daemon index.ts 에서 registerBuiltinAgents 등록 순서를 못 읽음: %s" % relp(DMN_PATH))

# daemon 등록 집합 ↔ AgentKind 집합 교차검증(unknown 제외).
if agents and order:
    only_daemon = [r for r in order if r not in agents]
    only_ak     = [r for r in agents if r not in order]
    if only_daemon:
        ssot_errors.append("daemon 등록 id 가 AgentKind 에 없음(매핑 누락): %s" % ', '.join(only_daemon))
    if only_ak:
        ssot_errors.append("AgentKind id 가 daemon 등록에 없음: %s" % ', '.join(only_ak))

# 등록 순서 기준 코드 에이전트/고급 도구 표시명.
code_order = [r for r in order if r not in ADVANCED]
CODE  = [agents[r] for r in code_order if r in agents]          # 코드 에이전트 displayName(순서)
ADV   = [agents[r] for r in order if r in ADVANCED and r in agents]  # Terminal, Qwen Code
ALL   = CODE + ADV

# ── 표면 정의 ────────────────────────────────────────────────────────────────────────────
SURFACES = [
    {'key': 'README',       'path': os.path.join(ROOT, 'README.md'),
     'kind': 'readme_section', 'category': 'code'},
    {'key': 'README.ko',    'path': os.path.join(ROOT, 'README.ko.md'),
     'kind': 'readme_section', 'category': 'code'},
    {'key': 'web',          'path': os.path.join(ROOT, 'web/content/site.en.ts'),
     'kind': 'web_items', 'category': 'all'},
    {'key': 'iOS 가이드',    'path': os.path.join(ROOT, 'ios/PocketSisyphus/Models/GuideContent.swift'),
     'kind': 'line_enum', 'category': 'code'},
    {'key': 'Mac 가이드',    'path': os.path.join(ROOT, 'mac/PocketSisyphusMac/GuideContent.swift'),
     'kind': 'line_enum', 'category': 'code'},
]

if LIST:
    for s in SURFACES:
        shown = s.get('pattern') or (relp(s['path']) if s['path'] else '(없음)')
        print("%s\t%s" % (s['key'], shown))
    sys.exit(0)

# ── 표면 추출 헬퍼 ───────────────────────────────────────────────────────────────────────
def strip_md_comments(text):
    """<!-- … --> 영역을 «줄 수 보존하며» 공백화(라인 기반 스캔이 주석 속 목록을 안 잡게)."""
    out = []
    for ch in re.split(r'(<!--.*?-->)', text, flags=re.S):
        if ch.startswith('<!--') and ch.endswith('-->'):
            out.append(re.sub(r'[^\n]', ' ', ch))
        else:
            out.append(ch)
    return ''.join(out)

def first_pos(names, text):
    """각 name 의 text 내 최초 등장 위치(없으면 None)."""
    return {nm: (text.find(nm)) for nm in names}

def order_ok(required_in_reg_order, positions):
    """required(등록 순서) 중 «등장한» 것만 뽑아 등장 위치 순서가 등록 순서와 같은지."""
    present = [nm for nm in required_in_reg_order if positions.get(nm, -1) >= 0]
    by_pos  = sorted(present, key=lambda nm: positions[nm])
    return present == by_pos, present

def extract_readme_section(text):
    """README 「지원하는 코드 에이전트」 섹션 블록 + 시작 라인번호.

    영어 우선 구조(커밋 d042ab5) 이후 README.md 는 영어 제목('## Supported code agents'),
    README.ko.md 는 한국어 제목('## 지원하는 코드 에이전트') 을 쓴다. 정확한 한 줄 매치 대신
    «코드 에이전트 목록 섹션» 을 식별하는 견고한 기준(레벨-2 제목에 '코드 에이전트' 또는
    'code agent(s)' 가 등장)으로 양쪽을 함께 인지한다(미래 문구 변화에도 덜 취약)."""
    lines = text.splitlines()
    start = None
    for i, ln in enumerate(lines):
        m = re.match(r'^##\s+(.*)$', ln)
        if not m:
            continue
        title = m.group(1)
        if re.search(r'코드\s*에이전트', title) or re.search(r'code\s+agents?', title, re.I):
            start = i; break
    if start is None:
        return None, None
    buf = []
    for j in range(start + 1, len(lines)):
        ln = lines[j]
        if re.match(r'^##\s', ln) or ln.lstrip().startswith('<!--'):
            break
        buf.append(ln)
    return '\n'.join(buf), start + 1   # 1-based heading line

def extract_web_items(text):
    """web `agents:` 안 `items: [ … ]` 의 name 값 목록 + items 시작 라인번호."""
    am = re.search(r'\bagents\s*:\s*\{', text)
    if not am:
        return None, None
    agents_body_start = text.index('{', am.start())
    agents_body = matched_region(text, agents_body_start)
    im = re.search(r'\bitems\s*:\s*\[', agents_body)
    if not im:
        return None, None
    abs_items_open = agents_body_start + 1 + agents_body.index('[', im.start())
    items_body = matched_region(text, abs_items_open, '[', ']')
    names = re.findall(r'\bname\s*:\s*"((?:\\.|[^"\\])*)"', items_body)
    lineno = text.count('\n', 0, abs_items_open) + 1
    return names, lineno

# ── 표면별 판정 ──────────────────────────────────────────────────────────────────────────
# finding: (surface_key, file, lineno, severity, code, detail)
findings = []
def add(skey, fpath, lineno, sev, code, detail):
    findings.append((skey, relp(fpath) if fpath else '(없음)', lineno, sev, code, detail))

def required_for(cat):
    return ALL if cat == 'all' else CODE

for s in SURFACES:
    skey, kind, cat = s['key'], s['kind'], s['category']
    fpath = s['path']
    required = required_for(cat)
    if not required:                       # SSOT 를 못 읽었으면 표면 검사 불가(아래 SSOT 에서 보고)
        continue
    if not fpath or not os.path.isfile(fpath):
        shown = s.get('pattern') or (relp(fpath) if fpath else skey)
        add(skey, fpath, None, 'MISS', 'MISS', "표면 파일이 없음(%s) — README SSOT 주석이 선언한 표면이 누락" % shown)
        continue
    text = read(fpath)
    if text is None:
        add(skey, fpath, None, 'WARN', 'WARN', "파일을 읽지 못함")
        continue

    if kind == 'readme_section':
        block, lineno = extract_readme_section(text)
        if block is None:
            add(skey, fpath, None, 'WARN', 'WARN', "「지원하는 코드 에이전트」 섹션을 못 찾음")
            continue
        pos = first_pos(required, block)
        missing = [nm for nm in required if pos.get(nm, -1) < 0]
        for nm in missing:
            add(skey, fpath, lineno, 'MISS', 'MISS', "「%s」 가 목록에 없음" % nm)
        ok, _ = order_ok(required, pos)
        if not missing and not ok:
            add(skey, fpath, lineno, 'WARN', 'ORDER', "열거 순서가 등록 순서(%s)와 다름" % ' → '.join(required))

    elif kind == 'web_items':
        names, lineno = extract_web_items(text)
        if names is None:
            add(skey, fpath, None, 'WARN', 'WARN', "agents.items 배열을 못 찾음")
            continue
        joined = '  '.join(names)
        # 표시명이 «어떤 item name 의 부분 문자열» 이면 존재(예: «Antigravity» ⊂ «Google Antigravity»).
        pos = {nm: (joined.find(nm)) for nm in required}
        missing = [nm for nm in required if pos[nm] < 0]
        for nm in missing:
            hint = ""
            if nm in ADV:
                hint = " (표기불일치 의심 — 항목명을 displayName 「%s」 로 정합)" % nm
            add(skey, fpath, lineno, 'MISS', 'MISS', "agents.items 에 「%s」 항목 없음%s" % (nm, hint))
        # 순서는 «코드 에이전트» 부분수열만 본다(고급 도구는 별도 묶음이라 순서 비강제).
        ok, _ = order_ok(CODE, {nm: pos.get(nm, -1) for nm in CODE})
        if not [nm for nm in CODE if pos.get(nm, -1) < 0] and not ok:
            add(skey, fpath, lineno, 'WARN', 'ORDER', "agents.items 코드 에이전트 순서가 등록 순서와 다름")

    elif kind == 'line_enum':
        scan = strip_md_comments(text) if s.get('md') else text
        lines = scan.splitlines()
        # «나열 줄» = 코드 에이전트 표시명을 임계값 이상 담은 줄. 임계값 = max(2, |CODE|-1):
        # «거의 다 나열한» 줄은 «전부» 나열해야 한다(단일 언급 줄을 오탐하지 않는다).
        threshold = max(2, len(CODE) - 1)
        enum_lines = []
        for i, ln in enumerate(lines, 1):
            present = [nm for nm in CODE if nm in ln]
            if len(present) >= threshold:
                enum_lines.append((i, ln))
        if not enum_lines:
            add(skey, fpath, None, 'WARN', 'WARN',
                "코드 에이전트 나열 줄(표시명 %d개 이상)을 못 찾음 — 구조 변경 가능" % threshold)
            continue
        for i, ln in enum_lines:
            pos = first_pos(CODE, ln)
            missing = [nm for nm in CODE if pos.get(nm, -1) < 0]
            for nm in missing:
                add(skey, fpath, i, 'MISS', 'MISS', "나열 줄에 「%s」 누락" % nm)
            ok, _ = order_ok(CODE, pos)
            if not missing and not ok:
                add(skey, fpath, i, 'WARN', 'ORDER', "나열 순서가 등록 순서와 다름")

# ── 출력 ─────────────────────────────────────────────────────────────────────────────────
n_fail = sum(1 for f in findings if f[3] == 'MISS') + len(ssot_errors)
n_warn = sum(1 for f in findings if f[3] == 'WARN')

if not QUIET:
    print("%sagent-surfaces-lint%s — 픽커 SSOT ↔ 5개 노출 표면 정합 대조 (README SSOT 주석 기준)" % (BOLD, RST))
    print("%sROOT: %s%s" % (DIM, relp(ROOT), RST))
    if CODE or ADV:
        print("%s픽커 SSOT(등록 순서):%s 코드 에이전트 = %s%s%s  ·  고급 도구 = %s%s%s" % (
            DIM, RST, BOLD, ' → '.join(CODE) or '(없음)', RST, BOLD, ' · '.join(ADV) or '(없음)', RST))
    print()

# SSOT 내부 오류 먼저.
if ssot_errors:
    print("%s■ [SSOT] 픽커 SSOT 파싱/정합 실패 (%d건)%s" % (BOLD, len(ssot_errors), RST))
    for e in ssot_errors:
        print("  - %s" % e)
    print()

if not findings and not ssot_errors:
    if not QUIET:
        print("✅ 정합 OK — 5개 표면 모두 픽커 SSOT 의 에이전트 집합과 일치합니다.")
    sys.exit(0)

# 표면 순서대로 그룹, 그 안은 (심각도 MISS 먼저) → 라인.
sorder = {s['key']: i for i, s in enumerate(SURFACES)}
sev_rank = {'MISS': 0, 'WARN': 1}
findings.sort(key=lambda f: (sorder.get(f[0], 99), sev_rank.get(f[3], 9), f[2] or 0))

last = None
for skey, fpath, lineno, sev, code, detail in findings:
    if skey != last:
        print("%s■ %s%s" % (BOLD, skey, RST))
        last = skey
    tag = '실패' if sev == 'MISS' else '경고'
    loc = "%s:%d" % (fpath, lineno) if lineno else fpath
    print("  %s — [%s/%s] %s" % (loc, code, tag, detail))
print()

print("%s합계: 실패 %d건 · 경고 %d건%s" % (BOLD, n_fail, n_warn, RST))

if not QUIET:
    print()
    print("%s판정 규칙:%s" % (BOLD, RST))
    print("  · [MISS] 집합 누락/표기불일치 = «실패»(비-0 종료). 픽커에 있는 에이전트가 그 표면에 없음.")
    print("  · [ORDER] 순서만 다름 = «경고»(종료코드 영향 없음). 집합은 맞으나 등록 순서와 열거 순서가 다름.")
    print("  · [WARN] 나열 줄을 못 찾음 등 = «경고».")
    print("  · 표시명은 «부분 문자열» 로 인정합니다(예: 「Antigravity」 ⊂ 「Google Antigravity」) — 벤더 수식은 정상.")
    print("  · «후보 표면화» 가 목적입니다 — 최종 판정은 사람이 합니다.")

sys.exit(0 if (SOFT or n_fail == 0) else 1)
PYEOF
