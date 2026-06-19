#!/usr/bin/env bash
#
# po-agent-lint.sh — PO 세션 spawn 진입점의 «에이전트 선택 passthrough» 정적 검사.
#
# 왜: PO 세션을 spawn 하는 진입점(collect/research/decide/cleanup/restart)이 «하나라도»
#     daemon 으로 agent 인자를 안 실으면, 사용자가 픽커로 어떤 도구를 골라도 무시되고 항상
#     claude_code 로 «조용히» 폴백한다. 토스트·에러 없는 silent 실패라 사람이 화면에서
#     알아채기 어렵다. ARCHITECTURE.md §14.4 가 이걸 «3회+ 반복된 버그» 로 못박고(shipped 의
#     «지금 수집해 검증» = collect, rejected 의 «코드 흔적 정리» = cleanup 둘 다 2026-06 수정)
#     수동 4항목 체크리스트로만 막아 왔다 — 사람 리뷰에 의존하는 한 같은 종류가 또 샌다.
#     이 레포가 이미 정착시킨 «정적 드리프트 검사»(i18n-lint·design-lint)와 같은 톤·계약으로
#     이 회귀를 입구에서 «후보» 로 잡는다.
#
# 탐지 (텍스트 휴리스틱 — 완전한 Swift/TS 파서 아님):
#   P1. iOS: PO 세션 spawn API 호출(startPoCollection/startPoResearch/decidePoBrief/
#       cleanupPoBrief/restartPoBriefExec)이 `agent:` 인자를 안 싣는다.
#       (decidePoBrief 가 action: "reject"/"hold" 면 세션 spawn 이 없어 제외 — 결재만.)
#   P2. iOS: 픽커(PoAgentSection)를 쓰는 «화면(struct)» 에서, 어떤 상태(brief.status == "…")
#       에 묶인 spawn 액션이 보이는데 그 상태에 묶인 픽커가 «하나도» 없다. (decidable=approve
#       처럼 한 상태에만 픽커를 달면 다른 상태(shipped/rejected)의 액션엔 선택 UI 가 없다 —
#       §14.4 의 회귀가 정확히 이거였다.)
#   P3. daemon: routes/po.ts 의 spawn 라우트(/collect·/briefs/:id/decide·/restart·/cleanup·
#       /research) 핸들러가 body 의 `agent` 를 읽지 않거나(parseAgent(body.agent) 부재),
#       읽어도 세션 spawn(startPoCollection/startPoResearch/createSession/
#       startPoWorkflowApproval)에 «전달» 하지 않는다.
#
# 정당 패턴(후보 아님): 픽커 미노출/옛 daemon 대응으로 `agents.isEmpty ? nil : execAgentId`
#   처럼 «의도적 nil» 을 두는 건 호출에 `agent:` «인자» 가 그대로 있으니 P1 후보가 아니다
#   (값이 nil 일 뿐 라벨은 실린다 — daemon 이 안전 폴백). 워크플로우 노드 등 PO 세션 spawn 이
#   아닌 다른 agent 흐름은 스코프 밖(오탐 안 함).
#
# 화이트리스트(진입점 메서드·라우트·spawn 헬퍼 이름)는 파이썬 «한 곳» 에서 관리한다 — 새
#   진입점이 추가되면 그 목록에만 더하면 검사가 따라잡는다(§14.4 의 함수명 화이트리스트 정신).
#
# 의도적 예외: 해당 라인(또는 호출/핸들러)에 `// po-agent-lint: allow` 주석을 달면 빠진다.
#
# 사용법(기존 i18n-lint.sh/design-lint.sh 와 동일 인터페이스):
#   ./scripts/po-agent-lint.sh            # 기본: iOS 소스 + daemon routes/po.ts 스캔
#   ./scripts/po-agent-lint.sh PATH...    # 지정 경로만(.swift→P1·P2, .ts→P3) — 회귀 테스트가 사용
#   ./scripts/po-agent-lint.sh --soft     # «리포트만» — 후보가 있어도 항상 0 종료(게이트 끔)
#   ./scripts/po-agent-lint.sh --quiet    # 안내/가이드 헤더 생략(기계 소비용)
#
# 종료코드: 후보 0 → 0, 1건 이상 → 1 (호출자가 게이트로 쓸 수 있게). --soft 면 항상 0.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

SOFT=0
QUIET=0
PATHS=()

for arg in "$@"; do
  case "$arg" in
    --soft|--no-fail) SOFT=1 ;;
    --quiet|-q)       QUIET=1 ;;
    -h|--help)
      sed -n '2,46p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    --*) echo "po-agent-lint: 알 수 없는 옵션: $arg" >&2; exit 2 ;;
    *)   PATHS+=("$arg") ;;
  esac
done

# 인자로 경로가 없으면 iOS 소스 루트 + daemon routes/po.ts 를 스캔.
if [ ${#PATHS[@]} -eq 0 ]; then
  PATHS=("$REPO_ROOT/ios/PocketSisyphus" "$REPO_ROOT/mac/daemon/src/routes/po.ts")
fi

# 모든 휴리스틱은 파이썬에 둔다 — 유니코드·문자열/주석 렉싱·괄호 균형 매칭이 grep/sed 보다 안정적.
# 따옴표 친 heredoc('PYEOF') 라 셸 확장이 없어 정규식의 역슬래시/달러가 그대로 전달된다.
SOFT="$SOFT" QUIET="$QUIET" python3 - "${PATHS[@]}" <<'PYEOF'
import os, re, sys, bisect

SOFT  = os.environ.get("SOFT", "0") == "1"
QUIET = os.environ.get("QUIET", "0") == "1"
paths = sys.argv[1:]

ALLOW = "po-agent-lint: allow"

# ── 화이트리스트 (SSOT — 새 진입점은 여기만 손대면 검사가 따라잡는다) ─────────────────────
# iOS: PO 세션 spawn API 메서드 → 진입점 라벨.
IOS_SPAWN_METHODS = {
    "startPoCollection":  "collect",
    "startPoResearch":    "research",
    "cleanupPoBrief":     "cleanup",
    "restartPoBriefExec": "restart",
    "decidePoBrief":      "decide",
}
# decide 는 같은 메서드로 hold/reject 결재도 한다 — 그땐 세션 spawn 이 없어 agent 불필요.
DECIDE_NO_AGENT_ACTIONS = ("reject", "hold")

# iOS: 뷰 본문에서 «상태별» spawn 액션을 트리거하는 진입점 func 이름(P2 의 액션 측).
IOS_ACTION_FNS = (
    "startVerifyCollect", "cleanup", "rejectAndCleanup", "decide", "restart",
    "startCollect", "startResearch",
)

# daemon: PO 세션 spawn 라우트 경로(리터럴) 와 세션 spawn 헬퍼 함수.
DAEMON_SPAWN_ROUTE_PATHS = (
    "/collect",
    "/briefs/:id/decide",
    "/briefs/:id/restart",
    "/briefs/:id/cleanup",
    "/research",
)
DAEMON_SPAWN_FNS = (
    "startPoCollection", "startPoResearch", "createSession", "startPoWorkflowApproval",
)

# brief.status == "<lit>" / .status != "<lit>" — P2 의 «상태» 차원.
RE_STATUS_LIT = re.compile(r'\.status\s*(?:==|!=)\s*"(\w+)"')

EXCLUDE_DIRS = {'build', 'DerivedData', '.build', 'SourcePackages',
                'Pods', 'Carthage', '.swiftpm', '.git', 'node_modules', 'dist'}

# ── 파일 수집 ────────────────────────────────────────────────────────────────────────
def collect(roots, exts):
    out = []
    for p in roots:
        if os.path.isfile(p):
            if any(p.endswith(e) for e in exts):
                out.append(p)
        elif os.path.isdir(p):
            for dp, dirs, files in os.walk(p):
                dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS]
                for fn in files:
                    if any(fn.endswith(e) for e in exts):
                        out.append(os.path.join(dp, fn))
    return sorted(set(out))

swift_files = collect(paths, ('.swift',))
ts_files    = collect(paths, ('.ts',))

# ── 렉서: 주석 제거 + 문자열 인지. (code, skel) 두 형태(원본과 «길이/줄» 정렬) ──────────────
#   code : 주석만 공백 — 문자열 내용은 보존(내용 정규식이 쓴다: agent:, action 리터럴 …).
#   skel : 주석 + 문자열 내부까지 공백 — 괄호/중괄호 «균형 매칭» 이 쓴다(문자열 속 (),{} 오인 방지).
# Swift·TS 공통(// , /* */ , " ' ` 문자열). 줄바꿈은 양쪽 모두 보존 → 인덱스→줄번호 매핑 안전.
def lex_full(text):
    code, skel = [], []
    i, n = 0, len(text)
    while i < n:
        c = text[i]; two = text[i:i+2]
        if two == '//':
            j = text.find('\n', i); j = n if j < 0 else j
            pad = ' ' * (j - i); code.append(pad); skel.append(pad); i = j; continue
        if two == '/*':
            j = text.find('*/', i); j = n if j < 0 else j + 2
            seg = text[i:j]
            p = ''.join('\n' if ch == '\n' else ' ' for ch in seg)
            code.append(p); skel.append(p); i = j; continue
        if c in '"\'`':
            q = c
            code.append(c); skel.append(' '); i += 1
            while i < n:
                if text[i] == '\\' and i + 1 < n:
                    code.append(text[i:i+2]); skel.append('  '); i += 2; continue
                ch = text[i]
                if ch == q:
                    code.append(ch); skel.append(' '); i += 1; break
                if ch == '\n' and q != '`':
                    break  # 미종료 단일행 문자열 — 바깥 루프가 '\n' 을 처리
                code.append(ch); skel.append('\n' if ch == '\n' else ' '); i += 1
            continue
        code.append(c); skel.append(c); i += 1
    return ''.join(code), ''.join(skel)

def line_starts(text):
    starts = [0]
    for m in re.finditer('\n', text):
        starts.append(m.end())
    return starts

def lineno_of(starts, idx):
    return bisect.bisect_right(starts, idx)

def balanced(skel, open_idx, op='(', cl=')'):
    """skel[open_idx] == op 라 가정. 짝 맞는 닫힘 인덱스 반환(없으면 끝)."""
    depth = 0; i = open_idx; n = len(skel)
    while i < n:
        ch = skel[i]
        if ch == op: depth += 1
        elif ch == cl:
            depth -= 1
            if depth == 0: return i
        i += 1
    return n

def excerpt(s):
    s = s.strip()
    return s if len(s) <= 160 else s[:157] + '…'

findings = []   # (path, lineno, code, detail, excerpt)
def add(path, lineno, code, detail, exc):
    findings.append((path, lineno, code, detail, excerpt(exc)))

def span_has_allow(text, starts, a, b, lookback=0):
    la = lineno_of(starts, a) - lookback; lb = lineno_of(starts, b)
    body = text.split('\n')
    for ln in range(la, lb + 1):
        if 1 <= ln <= len(body) and ALLOW in body[ln - 1]:
            return True
    return False

# ── P1: iOS spawn 호출에 agent: 인자 누락 ────────────────────────────────────────────────
def check_ios_calls(fp, text, code, skel, starts):
    for method, label in IOS_SPAWN_METHODS.items():
        for m in re.finditer(r'\.' + method + r'\s*\(', code):
            open_idx = code.index('(', m.start())
            close = balanced(skel, open_idx)
            args = code[open_idx + 1:close]          # 내용(문자열 보존)
            start = m.start()
            if span_has_allow(text, starts, start, close, lookback=1):
                continue
            if method == 'decidePoBrief':
                ma = re.search(r'action\s*:\s*"(\w+)"', args)
                if ma and ma.group(1) in DECIDE_NO_AGENT_ACTIONS:
                    continue
            if not re.search(r'\bagent\s*:', args):
                ln = lineno_of(starts, start)
                exc = text.split('\n')[ln - 1] if ln <= text.count('\n') + 1 else ''
                add(fp, ln, 'P1', "%s 호출 agent: 누락" % label, exc)

# ── P2: 픽커 쓰는 화면(struct)에서 상태별 spawn 액션에 픽커 미커버 ─────────────────────────
def check_ios_pickers(fp, text):
    code, skel = lex_full(text)
    code_lines = code.split('\n')
    skel_lines = skel.split('\n')
    orig_lines = text.split('\n')

    frames = []   # 각 '{' 프레임: {'statuses': set, 'struct': name|None}
    pickers = []  # (struct, frozenset(statuses), lineno)
    actions = []  # (struct, frozenset(statuses), fn, lineno, excerpt)

    for idx in range(len(code_lines)):
        cl = code_lines[idx]; sl = skel_lines[idx]; ol = orig_lines[idx]
        line_statuses = set(RE_STATUS_LIT.findall(cl))
        m_struct = re.search(r'\bstruct\s+(\w+)', cl)
        struct_here = m_struct.group(1) if m_struct else None

        cur_struct = None
        for fr in reversed(frames):
            if fr['struct']:
                cur_struct = fr['struct']; break
        active = set()
        for fr in frames:
            active |= fr['statuses']
        active = active | line_statuses

        if 'PoAgentSection(' in cl and ALLOW not in ol:
            pickers.append((cur_struct, frozenset(active), idx + 1))

        if 'func ' not in cl and ALLOW not in ol:
            for fn in IOS_ACTION_FNS:
                if re.search(r'\b' + fn + r'\s*\(', cl):
                    if fn == 'decide':
                        ma = re.search(r'decide\s*\(\s*"(\w+)"', cl)
                        if ma and ma.group(1) in DECIDE_NO_AGENT_ACTIONS:
                            continue
                    actions.append((cur_struct, frozenset(active), fn, idx + 1, ol.strip()))
                    break

        # 중괄호 균형으로 프레임 push/pop (skel 기준). 한 줄의 «첫» '{' 만 struct 본문으로 태깅.
        for ch in sl:
            if ch == '{':
                frames.append({'statuses': set(line_statuses), 'struct': struct_here})
                struct_here = None
            elif ch == '}':
                if frames: frames.pop()

    picker_states = {}   # struct -> set(statuses)
    for st, sts, _ in pickers:
        picker_states.setdefault(st, set()).update(sts)

    for st, sts, fn, ln, exc in actions:
        if st not in picker_states:   # 픽커를 «안» 쓰는 화면은 스코프 밖(오탐 방지)
            continue
        if not sts:                   # 상태에 안 묶인 액션은 P2 대상 아님
            continue
        missing = sts - picker_states[st]
        if missing:
            add(fp, ln, 'P2',
                "%s 액션(상태 %s)에 PoAgentSection 픽커 없음" % (fn, ', '.join(sorted(missing))),
                exc)

# ── P3: daemon 핸들러가 body.agent 를 읽어 세션 spawn 에 전달하는가 ─────────────────────────
def check_daemon(fp, text):
    code, skel = lex_full(text)
    starts = line_starts(text)
    orig_lines = text.split('\n')
    for path in DAEMON_SPAWN_ROUTE_PATHS:
        for rm in re.finditer(r'po\.post\(\s*"' + re.escape(path) + r'"', code):
            brace = skel.find('{', rm.end())
            if brace < 0:
                continue
            close = balanced(skel, brace, '{', '}')
            body = code[brace:close]
            ln = lineno_of(starts, rm.start())
            # allow: 핸들러 본문 어디든 주석이 있으면 제외.
            la = ln; lb = lineno_of(starts, close)
            if any(ALLOW in orig_lines[k - 1] for k in range(la, min(lb, len(orig_lines)) + 1)):
                continue
            reads_agent = bool(re.search(r'parseAgent\s*\(\s*body\.agent', body) or
                               re.search(r'\bbody\.agent\b', body))
            exc = orig_lines[ln - 1] if ln <= len(orig_lines) else path
            if not reads_agent:
                add(fp, ln, 'P3', "POST %s 핸들러가 body.agent 를 안 읽음" % path, exc)
                continue
            # 세션 spawn 헬퍼 호출을 찾아 인자에 agent/agentId 가 실리는지.
            spawn_found = False
            passes = False
            for fn in DAEMON_SPAWN_FNS:
                for fm in re.finditer(r'\b' + fn + r'\s*\(', body):
                    spawn_found = True
                    oi = body.index('(', fm.start())
                    # body 는 code(문자열 보존) — 균형은 skel 의 같은 구간으로.
                    skb = skel[brace:close]
                    ce = balanced(skb, oi, '(', ')')
                    cargs = body[oi + 1:ce]
                    if re.search(r'\bagent(?:Id)?\b', cargs):
                        passes = True
            if spawn_found and not passes:
                add(fp, ln, 'P3', "POST %s 핸들러가 agent 를 세션 spawn 에 전달 안 함" % path, exc)

# ── 실행 ─────────────────────────────────────────────────────────────────────────────
for fp in swift_files:
    try:
        with open(fp, encoding='utf-8') as f:
            text = f.read()
    except (OSError, UnicodeDecodeError):
        continue
    code, skel = lex_full(text)
    starts = line_starts(text)
    check_ios_calls(fp, text, code, skel, starts)
    check_ios_pickers(fp, text)

for fp in ts_files:
    try:
        with open(fp, encoding='utf-8') as f:
            text = f.read()
    except (OSError, UnicodeDecodeError):
        continue
    check_daemon(fp, text)

# ── 출력 ─────────────────────────────────────────────────────────────────────────────
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

META = {
    'P1': ('iOS spawn 호출 agent: 누락', '높음',
           '호출에 `agent:` 인자를 싣는다(픽커 미노출/옛 daemon 은 `agents.isEmpty ? nil : execAgentId` 로 nil — 라벨은 유지).'),
    'P2': ('iOS 상태별 액션에 픽커 미커버', '중간',
           '액션이 보이는 «모든» 상태(shipped/rejected 포함)에 PoAgentSection 픽커를 단다(§14.4 체크리스트 2).'),
    'P3': ('daemon agent passthrough 누락', '높음',
           '핸들러가 parseAgent(body.agent) 로 읽어 세션 spawn(createSession/startPo…)에 그 agent 를 넘긴다.'),
}

if not QUIET:
    print("%spo-agent-lint%s — PO 세션 spawn agent passthrough 후보 스캔 (ARCHITECTURE §14.4 기준)" % (BOLD, RST))
    print("%s스캔 대상: %s%s" % (DIM, ', '.join(relp(p) for p in paths), RST))
    print()

if not findings:
    if not QUIET:
        print("✅ 후보 0건 — PO 세션 spawn 진입점이 모두 agent 를 싣고/전달합니다.")
    sys.exit(0)

order = {'P1': 0, 'P2': 1, 'P3': 2}
findings.sort(key=lambda x: (order[x[2]], x[0], x[1]))
counts = {'P1': 0, 'P2': 0, 'P3': 0}
for _, _, c, _, _ in findings:
    counts[c] += 1

last = None
for path, ln, c, detail, exc in findings:
    if c != last:
        name, conf, fix = META[c]
        print("%s■ [%s] %s — 신뢰도 %s (%d건)%s" % (BOLD, c, name, conf, counts[c], RST))
        print("%s   고치는 법: %s%s" % (DIM, fix, RST))
        last = c
    print("%s:%d — [%s] %s — %s" % (relp(path), ln, c, detail, exc))

print()
print("%s합계: %d건  (P1=%d  P2=%d  P3=%d)%s" %
      (BOLD, len(findings), counts['P1'], counts['P2'], counts['P3'], RST))

if not QUIET:
    print()
    print("%s거짓 양성 처리법:%s" % (BOLD, RST))
    print("  · 정당한 «의도적 nil»(픽커 미노출/옛 daemon)은 호출에 `agent:` 라벨이 그대로 있으면 P1 후보가 아닙니다.")
    print("  · PO 세션 spawn 이 아닌 다른 agent 흐름(워크플로우 노드 등)은 스코프 밖 — 이 도구는 안 봅니다.")
    print("  · 정말 예외라면 해당 라인(또는 핸들러)에 `// po-agent-lint: allow` 로 «명시» 하면 빠집니다.")
    print("  · 이 도구는 «후보 표면화» 가 목적입니다(완전한 파서 아님). 최종 판정은 사람이 합니다.")
    print("%s  PO 자가검증/‐verify-ios 에서는 «이 변경(diff)이 새로 들인» 후보에 집중하세요.%s" % (DIM, RST))

sys.exit(0 if SOFT else 1)
PYEOF
