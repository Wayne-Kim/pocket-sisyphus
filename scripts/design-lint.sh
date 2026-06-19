#!/usr/bin/env bash
#
# design-lint.sh — iOS·Mac Swift 소스를 «정규식 휴리스틱» 으로 스캔해, CLAUDE.md 「색상 토큰
# 정책」 + DesignTokens.swift 의 `Theme`(디자인 SSOT)가 «어겨서 사고난 이력 있음» 이라 명시한
# 색-드리프트 후보를 «경로:라인  발췌  ← 위반 종류·권장 토큰» 으로 표면화한다.
#
# 왜: 색 정책을 어긴 사고 이력이 명시돼 있는데도(warning(노랑)↔pro(주황) 혼동, 리터럴
# .orange/.yellow/.blue 를 의미 토큰 대신 쓰기, .white/.black 하드코딩, 전역 .tint() 로 본문
# 텍스트까지 보라 물듦) 이를 출시 «전» 에 막는 정적 점검이 0 이었다. 디자이너 페르소나는 출시
# «후» 에 비결정적으로 발굴할 뿐이다. 이 스크립트가 i18n-lint.sh 와 동형으로 그 회귀를
# 근원에서 막는다 — 출시 전(/verify-ios)과 PO 자가검증 노드에서 «후보» 를 띄운다.
#
# 탐지 패밀리 (CLAUDE.md 「색상 토큰 정책」 기준):
#   L. 의미 토큰 우회 리터럴 색 — `.orange`/`.yellow`/`.blue` 가 Theme/토큰 정의 밖에서 직접 쓰임.
#        iOS: 셋 다 후보 (Theme.pro/.warning/.info 를 쓰라).
#        Mac: Theme 가 없어 .orange(pro)·.yellow(warning) 리터럴은 «정상» — `.blue` 만 후보
#             (accent 누락 의심 → Color.accentColor; info=파랑이면 의도일 수 있음).
#   W. 하드코딩 흑백 — `.foregroundColor/.foregroundStyle/.tint/.fill(... .white/.black ...)`.
#        본문 텍스트/아이콘은 .primary/.secondary(자동 적응), 색 배경 위 텍스트면 Theme.onAccent.
#   T. 콘텐츠/전역 .tint() 번짐 — 컨텐츠 컨테이너(TabView/WindowGroup/NavigationStack/Scene…)에
#        건 `.tint(비-중립색)`. 본문/아이콘까지 그 색으로 물든다. 컨트롤 색은 AccentColor 에셋이
#        잡으니 전역 tint 가 필요 없다. (해제 버튼 등 per-element `.tint(Color.primary)` 는 정상.)
#   A. 아이콘 전용 버튼 접근성 — `Image(systemName:)` 만 든 Button 에 `.accessibilityLabel` 누락.
#   S. Spacing 리터럴 (DesignTokens.swift 의 `Theme.Spacing` 우회) — `spacing: N`·`.padding(… N)`·
#        `Spacer(minLength: N)` 의 «리터럴» N. N 이 Theme.Spacing 토큰값과 정확히 일치하면
#        «Theme.Spacing.<크기>로» 권고(픽셀 불변), 온그리드(4pt)인데 무토큰이면 «토큰 추가 검토»
#        (반올림 금지), 오프그리드(14/5/7/3/18…)면 «비-그리드»(토큰 신설 말고 구조/쌍둥이 검토).
#   R. Radius 리터럴 (`Theme.Radius` 우회) — `cornerRadius: N`·`RoundedRectangle(cornerRadius: N)`
#        의 리터럴 N. S 와 동형으로 토큰화/온그리드-무토큰/비-그리드 3분류.
#   O. Opacity 리터럴 (`Theme.Opacity` 우회) — `.opacity(N)` 의 리터럴 N 이 Theme.Opacity 토큰값
#        (hairline .06·fill .12·badge .18·border .30)과 «정확히 일치» 하면 후보(틴트 채움 표준 단계
#        우회). 토큰셋과 안 겹치는 임의 opacity(.opacity(0.5) 등)는 의도/시맨틱이라 후보 아님 —
#        S·R 의 온그리드/오프그리드 분류와 달리 «토큰값 일치» 만 본다(0/1 반올림 개념 없음).
#   I. IconSize 리터럴 (`Theme.IconSize` 우회) — `.frame(width: N, height: N)` 처럼 정사각(width==height)
#        프레임의 N 이 Theme.IconSize 토큰값(m 36·l 44·xl 48·xxl 56·xxxl 64)과 «정확히 일치» 하면
#        후보. width≠height(아이콘 아님)·토큰과 안 겹치는 치수는 후보 아님. O 와 같이 «토큰값 일치» 만.
#
#   ※ S·R·O·I 의 토큰값 SSOT 는 «DesignTokens.swift 의 Theme.Spacing/Radius/Opacity/IconSize enum» 이다 —
#     이 스크립트가 그 파일을 «파싱» 해 토큰표를 만든다. 그래서 토큰을 추가/이름변경하면 권장 토큰
#     메시지가 자동으로 그 «실제 이름» 을 가리킨다(하드코딩 드리프트 없음). 핵심 불변식: 토큰셋이
#     실사용 온그리드 값을 빠짐없이 덮는 상위집합이어야 토큰화가 화면을 1px 도 안 바꾼다(반올림-강제
#     금지). O·I 는 «토큰값과 정확히 일치» 하는 리터럴만 후보로 잡아 임의값 오탐을 원천 차단한다.
#
# ── EXCLUDE (오탐 억제 규칙 — 문서화) ───────────────────────────────────────────────────────
#   · 토큰 «정의» 파일: `DesignTokens.swift` 는 통째로 제외 — Theme.pro = .orange 처럼 리터럴 색이
#     정상인 SSOT 다(여기 값을 바꾸면 앱 전체에 전파). Theme.Syntax/Node 팔레트 정의도 여기 있음.
#   · 의도적 우회: 해당 라인에 `// design-lint: allow` 주석이 있으면 그 라인의 모든 후보를 건너뛴다.
#   · AccentColor 에셋 경유는 «정답» 이라 후보 아님: `Color.accentColor`/`Theme.accent`/`.accent`/
#     `.primary`/`.secondary` 는 L·T·W 어디서도 잡지 않는다(구조상 제외).
#   · 텍스트 동반: Button 안에 `Text(`/`Label(` 또는 `Button("…")` 문자열 라벨/ `Text(verbatim:)` 가
#     있으면 접근 가능한 이름이 있는 것 → A 에서 제외. 순수 «장식» Image 는 A 가 안 잡는다(버튼/탭
#     아닌 자리는 디자이너 페르소나·비전 비평의 몫 — 이 린트는 텍스트로 잡히는 것만).
#   · a11y 라벨은 «호출 블록 전체»(여는 괄호~닫는 괄호, 트레일링 모디파이어 포함)에서 찾는다 —
#     모디파이어 `.accessibilityLabel(…)`/`.accessibilityHidden(…)` 뿐 아니라 커스텀 컴포넌트의
#     생성자 파라미터 `accessibilityLabel:`/`accessibilityHidden:`(예: ChatKeyButton) 도 인정.
#     그 라벨 인자가 «다음 줄» 에 와도 잡으므로 라인 기반 오탐이 없다.
#   · W 는 «전경/틴트/채움» 모디파이어로 한정 — `.shadow(color: .black…)`·전체화면 `Color.black`
#     배경·UIKit `UIColor.white.cgColor` 처럼 «본문 색이 아닌» 자리는 안 잡는다.
#   · 빌드 산출물(build/DerivedData/SourcePackages/Pods)·주석·디버그 로깅(print/NSLog/os_log/
#     Logger)·문자열 리터럴 내부는 렉서가 제거 → 후보 아님.
#   · S·R·O·I 은 «리터럴 숫자» 만 본다 — 보간/변수 인자(`spacing: gap`·`.opacity(alpha)`·
#     `.frame(width: side, height: side)`)는 숫자가 없어 비대상. S·R 은 0/1 미만(`.padding(0)`·
#     `Spacer(minLength: 0)`·hairline)도 레이아웃 토큰이 아니라 스킵. O·I 는 «토큰값과 정확히 일치»
#     하는 리터럴만 후보라 0/1·임의값은 자연히 비대상. `.frame(width:height:)` 는 S/R 의 spacing/
#     padding/cornerRadius 키워드가 아니라 S·R 범위 밖이지만, width==height 정사각이고 그 변이
#     IconSize 토큰값이면 I 가 잡는다(아닌 더미 치수 width:160/height:14 류는 I 도 안 잡음).
#
# 스코프(비-목표): 렌더링이 필요한 점검(실제 대비비 측정·warning↔pro 의미 «판별»)은 디자이너
#   페르소나/비전 비평에 남긴다. 이 도구는 «텍스트로 잡히는 후보 표면화» 가 목적 — 거짓 양성이
#   있을 수 있으니 사람이 판정한다(i18n-lint.sh 와 같은 톤·계약).
#
# 사용법:
#   ./scripts/design-lint.sh                 # 기본: iOS·Mac 소스 스캔, 후보 있으면 비-0 종료
#   ./scripts/design-lint.sh PATH...         # 지정한 디렉터리/파일만 스캔(회귀 테스트가 사용)
#   ./scripts/design-lint.sh --soft          # «리포트만» — 후보가 있어도 항상 0 종료(게이트 끔)
#   ./scripts/design-lint.sh --quiet         # 안내/가이드 헤더 생략(기계 소비용)
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
      sed -n '2,78p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    --*) echo "design-lint: 알 수 없는 옵션: $arg" >&2; exit 2 ;;
    *)   PATHS+=("$arg") ;;
  esac
done

# 인자로 경로가 없으면 두 앱의 소스 루트를 스캔 (ios/build 는 자연히 제외됨).
if [ ${#PATHS[@]} -eq 0 ]; then
  PATHS=("$REPO_ROOT/ios/PocketSisyphus" "$REPO_ROOT/mac/PocketSisyphusMac")
fi

# 모든 휴리스틱은 파이썬에 둔다 — 유니코드·문자열/주석 렉싱·중괄호 깊이 추적(컨테이너 .tint /
# 버튼 영역)이 BSD grep/sed 보다 안정적이다. 따옴표 친 heredoc('PYEOF') 라 셸 확장이 없어
# 정규식의 역슬래시/달러가 그대로 전달된다.
SOFT="$SOFT" QUIET="$QUIET" REPO_ROOT="$REPO_ROOT" python3 - "${PATHS[@]}" <<'PYEOF'
import os, re, sys

SOFT  = os.environ.get("SOFT", "0") == "1"
QUIET = os.environ.get("QUIET", "0") == "1"
REPO_ROOT = os.environ.get("REPO_ROOT", "")
paths = sys.argv[1:]

# ── 경로 분류: Mac 앱인가? (Theme 타입이 없어 리터럴 .orange/.yellow 가 «정상» 인 경로) ──────────
def is_mac(path):
    p = path.replace(os.sep, '/')
    return ('PocketSisyphusMac' in p) or ('/mac/' in p)

# 한 줄 Swift 문자열 리터럴 (이스케이프 포함).
STR = r'"(?:\\.|[^"\\])*"'

# L: 리터럴 색 토큰 — `.orange`/`.yellow`/`.blue` (= `Color.orange` 와 `.orange` 모두 포괄).
RE_LIT = re.compile(r'\.(?P<c>orange|yellow|blue)\b')

# W: 전경/틴트/채움 모디파이어 인자에 .white/.black 하드코딩. 한 단계 중첩 괄호(.white.opacity(…))까지.
RE_BW = re.compile(
    r'\.(?:foregroundColor|foregroundStyle|tint|fill)\(\s*'
    r'(?P<arg>(?:[^()]|\([^()]*\))*?)\)')
RE_BW_HIT = re.compile(r'\.(?:white|black)\b')

# T: .tint(인자) — 인자 추출(한 단계 중첩 괄호 허용).
RE_TINT = re.compile(r'\.tint\(\s*(?P<arg>(?:[^()]|\([^()]*\))*?)\)')

# 콘텐츠가 흐르는 컨테이너 — 여기 건 비-중립 .tint 는 본문까지 번진다.
RE_CONTAINER = re.compile(
    r'\b(?:TabView|WindowGroup|NavigationStack|NavigationView|'
    r'NavigationSplitView|Scene|DocumentGroup)\b')

# A: 버튼 텍스트 라벨 / 접근 가능한 이름 / a11y 라벨 판별.
RE_BTN_TEXTARG = re.compile(r'\bButton\s*\(\s*(?:verbatim\s*:\s*)?(?:"|LocalizedStringKey)')
RE_HAS_TEXT    = re.compile(r'\b(?:Text|Label)\s*\(')
# 접근 가능한 이름이 «호출 블록 어딘가» 에 있으면 라벨이 있는 것으로 본다. 두 형태 모두 인정:
#   · 모디파이어  : `.accessibilityLabel("…")` / `.accessibilityHidden(true)` / `.accessibility(label:`
#   · 생성자 파라미터: `accessibilityLabel: "…"` / `accessibilityHidden: true`
#     (ChatKeyButton 처럼 «아이콘 버튼» 을 감싼 커스텀 컴포넌트는 라벨을 파라미터로 받는다 —
#      그 파라미터가 호출 다음 줄에 와도 블록 범위 스캔이 잡는다. 라인 기반이던 과거엔 오탐.)
RE_HAS_A11Y    = re.compile(
    r'\.accessibilityLabel\s*\(|'
    r'\.accessibilityHidden\s*\(|'
    r'\.accessibility\(\s*label:|'
    r'\baccessibilityLabel\s*:|'
    r'\baccessibilityHidden\s*:')
RE_IMG         = re.compile(r'\bImage\(systemName:')

# 로깅 줄 — 색/접근성과 무관(스킵).
RE_LOG = re.compile(
    r'(?:^|[\s.;{(])(?:print|NSLog|os_log|debugPrint|assertionFailure|'
    r'preconditionFailure|fatalError)\s*\(|'
    r'\bLogger\(\)\.(?:info|debug|error|warning|notice|trace|critical|fault)\s*\(|'
    r'\.(?:info|debug|error|warning|notice|trace|critical|fault)\s*\(\s*"')

ALLOW = 'design-lint: allow'

# ── S · R: spacing/radius 리터럴 (Theme.Spacing/Radius 우회) ──────────────────────────────────
# 값 SSOT 는 DesignTokens.swift 의 enum 이다 — 아래 정규식은 «리터럴 숫자» 만 추출하고,
# 그 값을 «파싱한 토큰표» 와 대조해 토큰화/온그리드-무토큰/비-그리드를 가른다.
_VAL = r'(\d+(?:\.\d+)?)'                  # 리터럴 숫자(정수/소수). 변수/보간(gap)은 숫자 없음 → 비대상.
_END = r'(?=\s*(?:[,)\]}]|$))'             # 값이 «인자 전체» 임을 보장 — `8 * scale` 같은 식은 제외.
# `spacing:` 과 흔한 합성형(`horizontalSpacing:`/`verticalSpacing:`)까지. Theme.Spacing.m 은 숫자 없음.
RE_SP_SPACING = re.compile(r'[Ss]pacing:\s*' + _VAL + _END)
# `.padding(N)` / `.padding(.edge, N)` — 트레일링 `)` 로 단일 값임을 한정.
RE_SP_PADDING = re.compile(
    r'\.padding\(\s*(?:\.(?:horizontal|vertical|top|bottom|leading|trailing)\s*,\s*)?'
    + _VAL + r'\s*\)')
RE_SP_SPACER  = re.compile(r'\bSpacer\(\s*minLength:\s*' + _VAL + r'\s*\)')
# `cornerRadius: N` / `cornerRadius(N` (RoundedRectangle·.cornerRadius 모디파이어 공통).
RE_R_CORNER   = re.compile(r'cornerRadius(?:\(|:)\s*' + _VAL + _END)
# O: `.opacity(N)` 의 리터럴 N. `.white.opacity(…)` 처럼 앞에 체이닝이 붙어도 인자만 본다.
#    값(0.06/.06 둘 다)을 잡되, 후보 판정은 «토큰값과 정확히 일치» 일 때만(아래 classify_opacity).
RE_OPACITY    = re.compile(r'\.opacity\(\s*(0?\.\d+|\d+(?:\.\d+)?)\s*\)')
# I: `.frame(인자블록)` — 인자 블록을 뽑아(한 단계 중첩 괄호 허용) width/height 리터럴을 대조.
RE_FRAME      = re.compile(r'\.frame\(\s*(?P<args>(?:[^()]|\([^()]*\))*?)\)')
RE_FRAME_W    = re.compile(r'\bwidth:\s*' + _VAL + _END)
RE_FRAME_H    = re.compile(r'\bheight:\s*' + _VAL + _END)

def parse_token_enum(text, enum_name):
    """DesignTokens.swift 에서 `enum <name> { static let X: CGFloat = N … }` 를 파싱해
       {value(float): name} 표를 만든다. 중괄호 깊이로 enum 본문 범위를 잡는다."""
    out = {}
    m = re.search(r'\benum\s+' + re.escape(enum_name) + r'\s*\{', text)
    if not m:
        return out
    i = m.end(); depth = 1; n = len(text)
    start = i
    while i < n and depth > 0:
        c = text[i]
        if c == '{': depth += 1
        elif c == '}': depth -= 1
        i += 1
    body = text[start:i-1]
    for d in re.finditer(r'static\s+let\s+(\w+)\s*:\s*(?:CGFloat|Double)\s*=\s*(\d+(?:\.\d+)?|\.\d+)', body):
        name, val = d.group(1), float(d.group(2))
        # 같은 값에 여러 이름이면 «먼저 선언된» 이름을 권장(스케일 순서상 위쪽).
        out.setdefault(val, name)
    return out

def load_design_tokens():
    """Theme.Spacing/Radius/Opacity/IconSize 토큰표를 DesignTokens.swift 에서 읽는다. 못 찾으면
       기본값으로 폴백(합성 픽스처만 스캔하는 테스트도 정확한 토큰명을 쓰게)."""
    fallback_sp = {2.0:'xxs',4.0:'xs',6.0:'s',8.0:'m',10.0:'l',12.0:'xl',16.0:'xxl',24.0:'xxxl',32.0:'xxxxl'}
    fallback_r  = {4.0:'xs',6.0:'s',8.0:'sm',10.0:'m',12.0:'l',16.0:'xl'}
    fallback_op = {0.06:'hairline',0.12:'fill',0.18:'badge',0.30:'border'}
    fallback_ic = {36.0:'m',44.0:'l',48.0:'xl',56.0:'xxl',64.0:'xxxl'}
    cand = []
    if REPO_ROOT:
        cand.append(os.path.join(REPO_ROOT, 'ios', 'PocketSisyphus', 'DesignSystem', 'DesignTokens.swift'))
    for c in cand:
        try:
            with open(c, encoding='utf-8') as f:
                txt = f.read()
        except OSError:
            continue
        sp = parse_token_enum(txt, 'Spacing')
        r  = parse_token_enum(txt, 'Radius')
        op = parse_token_enum(txt, 'Opacity')
        ic = parse_token_enum(txt, 'IconSize')
        if sp and r and op and ic:
            return sp, r, op, ic
    return fallback_sp, fallback_r, fallback_op, fallback_ic

SPACING_TOKENS, RADIUS_TOKENS, OPACITY_TOKENS, ICONSIZE_TOKENS = load_design_tokens()

def classify_metric(value, tokens, kind):
    """리터럴 metric 값 → (권장 메시지 rec) 또는 None(스킵).
       kind: 'Spacing' | 'Radius'. tokens: {value: name}."""
    if value < 2:                       # 0/0.5/1 — padding(0)·hairline 등 레이아웃 토큰 아님.
        return None
    name = tokens.get(value)
    if name is not None:                # ① 토큰값과 정확히 일치 → 토큰화 후보(픽셀 불변).
        return 'Theme.%s.%s' % (kind, name)
    if value > 0 and value % 4 == 0:    # ② 온그리드(4pt)인데 무토큰 → 토큰 추가 검토(반올림 금지).
        return '온그리드(4pt) 무토큰 → Theme.%s 에 토큰 추가 검토 (반올림-강제 금지)' % kind
    return '비-그리드(오프그리드) — 토큰 신설·반올림 금지, 구조/쌍둥이 정합 검토'   # ③ 오프그리드.

def classify_exact(value, tokens, kind):
    """O·I 전용 — «토큰값과 정확히 일치» 할 때만 토큰화 권장, 아니면 None(후보 아님).
       S·R 과 달리 온그리드/오프그리드 분류·0/1 반올림 개념이 없다(틴트 단계·아이콘 치수는
       이산 토큰셋이라 임의값은 의도/시맨틱으로 본다)."""
    name = tokens.get(value)
    if name is not None:
        return 'Theme.%s.%s' % (kind, name)
    return None

EXCLUDE_DIRS = {'build', 'DerivedData', '.build', 'SourcePackages',
                'Pods', 'Carthage', '.swiftpm', '.git', 'node_modules'}
# 토큰 «정의» 파일 — 리터럴 색이 정상인 SSOT. 통째로 화이트리스트.
WHITELIST_FILES = {'DesignTokens.swift'}

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
    """주석 제거 + 문자열 인지. (code, skel) 두 형태를 만든다.
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

# .tint(인자) 가 «후보» 인가 — 중립(primary/secondary)·accent(AccentColor 에셋 = 정답)은 제외.
def tint_flaggable(arg):
    if re.search(r'\b(?:primary|secondary)\b', arg): return False
    if re.search(r'accent', arg, re.I):              return False   # accentColor/Theme.accent/.accent
    return True

# 패턴 메타 (코드 → (이름, 신뢰도, 권장 토큰/고치는 법))
META = {
    'L': ('의미 토큰 우회 리터럴 색', '중간',
          '리터럴 대신 의미 토큰: orange→Theme.pro · yellow→Theme.warning · blue→Theme.info '
          '(Mac 은 Theme 없음 → blue 는 Color.accentColor; info=파랑이면 의도일 수 있음)'),
    'W': ('하드코딩 흑백(.white/.black)', '중간',
          '.primary/.secondary(라이트·다크 자동 적응). 색 배경 위 텍스트면 Theme.onAccent. '
          '.white/.black 하드코딩은 반대 테마에서 안 보인다'),
    'T': ('콘텐츠/전역 .tint() 번짐', '높음',
          '컨테이너에 전역 .tint() 금지 — 본문/아이콘까지 물든다. 컨트롤 색은 AccentColor 에셋이 '
          '잡으니 불필요. per-element 해제 버튼은 .tint(Color.primary)'),
    'A': ('아이콘 버튼 접근성 라벨 누락', '중간',
          '아이콘 전용 버튼/이미지에 .accessibilityLabel("…") 추가 (VoiceOver 가 읽을 이름)'),
    'S': ('Spacing 리터럴 (Theme.Spacing 우회)', '중간',
          'spacing:/.padding/Spacer(minLength:) 리터럴 → 토큰값과 일치하면 Theme.Spacing.<크기>로 '
          '(픽셀 불변). 온그리드(4pt) 무토큰이면 토큰 추가 검토, 오프그리드면 비-그리드(구조 검토). '
          '반올림-강제 금지 — 토큰셋이 실사용 온그리드 값을 못 덮으면 토큰을 «추가» 하지 옮기지 않는다'),
    'R': ('Radius 리터럴 (Theme.Radius 우회)', '중간',
          'cornerRadius:/RoundedRectangle(cornerRadius:) 리터럴 → 토큰값과 일치하면 '
          'Theme.Radius.<크기>로 (픽셀 불변). 온그리드 무토큰이면 토큰 추가 검토, 오프그리드면 비-그리드'),
    'O': ('Opacity 리터럴 (Theme.Opacity 우회)', '중간',
          '.opacity(리터럴) 값이 Theme.Opacity 토큰값(.06/.12/.18/.30)과 «정확히 일치» 하면 '
          'Theme.Opacity.<단계>로 (틴트 채움 표준 단계 — 값 동일 = 픽셀 불변). 토큰과 안 겹치는 '
          '임의 opacity(.opacity(0.5) 등)는 의도/시맨틱이라 후보 아님'),
    'I': ('IconSize 정사각 프레임 리터럴 (Theme.IconSize 우회)', '중간',
          '.frame(width: N, height: N) 의 정사각 N 이 Theme.IconSize 토큰값(36/44/48/56/64)과 '
          '«정확히 일치» 하면 Theme.IconSize.<크기>로 (값 동일 = 픽셀 불변). width≠height(아이콘 '
          '아님)·토큰과 안 겹치는 임의 치수는 후보 아님'),
}

findings = []   # (path, lineno, code, excerpt, rec)
def add(path, lineno, code, orig, rec):
    findings.append((path, lineno, code, excerpt(orig), rec))

for fp in swift_files(paths):
    if os.path.basename(fp) in WHITELIST_FILES:
        continue
    mac = is_mac(fp)
    try:
        with open(fp, encoding='utf-8') as f:
            raw = f.read().splitlines()
    except (OSError, UnicodeDecodeError):
        continue

    st = {'block': False}
    lexed = []
    for idx, line in enumerate(raw, 1):
        code, skel = lex(line, st)
        lexed.append((idx, line, code, skel))

    # ── L · W · T · S · R (한 줄 + 컨테이너 컨텍스트) ─────────────────────────────────────
    depth = 0
    container_depths = []   # 컨테이너 블록이 «진입» 한 시점의 깊이들
    pending = False         # 직전에 컨테이너가 닫혔고 아직 모디파이어 체인 중인가
    sr_seen = set()         # S·R 중복 억제 — (라인, 코드, 값) 동일 매치는 한 번만
    for idx, line, code, skel in lexed:
        allow = ALLOW in line
        is_log = bool(RE_LOG.search(line))
        stripped = code.strip()
        is_trailing = stripped[:1] in ('.', '}')
        cont_m = RE_CONTAINER.search(code)

        opens = skel.count('{'); closes = skel.count('}')
        new_depth = depth + opens - closes
        closes_container_now = any(cd >= new_depth for cd in container_depths)

        # ── T: 컨테이너에 건 비-중립 .tint() ──────────────────────────────────────────────
        if not allow and not is_log:
            for m in RE_TINT.finditer(code):
                arg = m.group('arg')
                if not tint_flaggable(arg):
                    continue
                if RE_BW_HIT.search(arg):
                    continue   # .tint(.white/.black) 은 W 의 몫(이중 보고 방지)
                same_line = bool(cont_m) and cont_m.start() < m.start()
                if same_line or ((pending or closes_container_now) and is_trailing):
                    add(fp, idx, 'T', line, '전역 .tint() 제거 (컨트롤 색은 AccentColor 에셋이 잡음)')
                    break

        # 컨테이너 스택/pending 갱신 (T 판정 «후»).
        if cont_m and opens > closes:
            container_depths.append(depth)
        while container_depths and container_depths[-1] >= new_depth:
            container_depths.pop(); pending = True
        depth = new_depth
        if not is_trailing and not cont_m:
            pending = False

        if is_log:
            continue

        # ── L: 리터럴 색 우회 ─────────────────────────────────────────────────────────────
        if not allow:
            L_REC = {'orange': 'Theme.pro', 'yellow': 'Theme.warning', 'blue': 'Theme.info'}
            for m in RE_LIT.finditer(code):
                col = m.group('c')
                if mac and col != 'blue':
                    continue   # Mac: .orange(pro)·.yellow(warning) 리터럴은 정상
                rec = 'Color.accentColor (Mac; info=파랑이면 의도)' if mac else L_REC[col]
                add(fp, idx, 'L', line, rec)
                break

        # ── W: 흑백 하드코딩 ──────────────────────────────────────────────────────────────
        if not allow:
            for m in RE_BW.finditer(code):
                if RE_BW_HIT.search(m.group('arg')):
                    add(fp, idx, 'W', line, '.primary/.secondary (색 배경 위면 Theme.onAccent)')
                    break

        # ── S · R: spacing/radius 리터럴 (Theme.Spacing/Radius 우회) ───────────────────────
        # «리터럴 숫자» 만 본다 → skel(문자열 내부 공백화) 위에서 매칭해 문자열 안 "spacing: 8"
        # 같은 가짜 매치를 막는다. 변수/보간 인자(spacing: gap)는 숫자가 없어 자연히 비대상.
        if not allow:
            for rx, kind, codeletter in ((RE_SP_SPACING, 'Spacing', 'S'),
                                         (RE_SP_PADDING, 'Spacing', 'S'),
                                         (RE_SP_SPACER,  'Spacing', 'S'),
                                         (RE_R_CORNER,   'Radius',  'R')):
                tokens = SPACING_TOKENS if kind == 'Spacing' else RADIUS_TOKENS
                for m in rx.finditer(skel):
                    raw_val = m.group(1)
                    rec = classify_metric(float(raw_val), tokens, kind)
                    if rec is None:
                        continue
                    key = (idx, codeletter, raw_val)
                    if key in sr_seen:
                        continue
                    sr_seen.add(key)
                    add(fp, idx, codeletter, line, rec)

        # ── O: opacity 리터럴 (Theme.Opacity 우회) ─────────────────────────────────────────
        # «토큰값과 정확히 일치» 하는 리터럴만 후보(임의 opacity 는 의도/시맨틱). skel 위에서 매칭해
        # 문자열 안 가짜값을 막는다. `.white.opacity(0.18)` 처럼 체이닝돼도 인자만 본다.
        if not allow:
            for m in RE_OPACITY.finditer(skel):
                raw_val = m.group(1)
                rec = classify_exact(float(raw_val), OPACITY_TOKENS, 'Opacity')
                if rec is None:
                    continue
                key = (idx, 'O', raw_val)
                if key in sr_seen:
                    continue
                sr_seen.add(key)
                add(fp, idx, 'O', line, rec)

        # ── I: IconSize 정사각 프레임 리터럴 (Theme.IconSize 우회) ──────────────────────────
        # `.frame(width: N, height: N)` 의 width==height 정사각 N 이 IconSize 토큰값이면 후보.
        # width≠height(아이콘 아님)·토큰 비일치·변수 인자(숫자 없음)는 비대상.
        if not allow:
            for m in RE_FRAME.finditer(skel):
                args = m.group('args')
                wm = RE_FRAME_W.search(args)
                hm = RE_FRAME_H.search(args)
                if not wm or not hm:
                    continue
                if float(wm.group(1)) != float(hm.group(1)):
                    continue   # width≠height → 정사각 아이콘 아님
                raw_val = wm.group(1)
                rec = classify_exact(float(raw_val), ICONSIZE_TOKENS, 'IconSize')
                if rec is None:
                    continue
                key = (idx, 'I', raw_val)
                if key in sr_seen:
                    continue
                sr_seen.add(key)
                add(fp, idx, 'I', line, rec)

    # ── A: 아이콘 전용 버튼에 .accessibilityLabel 누락 (버튼 영역 윈도우) ─────────────────────
    n = len(lexed)
    for i in range(n):
        idx, line, code, skel = lexed[i]
        if 'Button' not in code or ALLOW in line or RE_LOG.search(line):
            continue
        # i 부터 «호출 블록» 의 괄호·중괄호를 맞춰 영역을 잡는다. 파라미터(괄호 안)와
        # ViewBuilder 클로저(중괄호 안)를 모두 포함해야 accessibilityLabel: 가 다음 줄에 와도 잡힌다.
        region = []
        d = 0; started = False; j = i
        while j < n and j < i + 200:
            region.append(j)
            _, _, _, s_j = lexed[j]
            opens = s_j.count('{') + s_j.count('(')
            d += opens - s_j.count('}') - s_j.count(')')
            if opens > 0:
                started = True
            if started and d <= 0:
                break
            j += 1
        # 블록 «뒤» 의 순수 트레일링 모디파이어(.accessibilityLabel 이 흔히 여기 붙는다)도 영역에 포함.
        k = j + 1
        while k < n and k < i + 220:
            _, _, c_k, _ = lexed[k]
            st_k = c_k.strip()
            if st_k[:1] == '.' or st_k[:2] in ('})', '}.'):
                region.append(k); k += 1
            else:
                break

        has_image = False; has_text = bool(RE_BTN_TEXTARG.search(code)); has_a11y = False
        for r in region:
            _, _, c_r, _ = lexed[r]
            if RE_IMG.search(c_r):     has_image = True
            if RE_HAS_TEXT.search(c_r): has_text = True
            if RE_HAS_A11Y.search(c_r): has_a11y = True
        if has_image and not has_text and not has_a11y:
            add(fp, idx, 'A', line, '.accessibilityLabel("…")')

# ── 출력 ─────────────────────────────────────────────────────────────────────────────────
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
    print("%sdesign-lint%s — 색/토큰 정책 위반 «후보(candidate)» 스캔 (CLAUDE.md 「색상 토큰 정책」 + DesignTokens.swift 휴리스틱)" % (BOLD, RST))
    print("%s스캔 대상: %s%s" % (DIM, ', '.join(relp(p) for p in paths), RST))
    print()

if not findings:
    if not QUIET:
        print("✅ 후보 0건 — 색/토큰 정책 위반 후보가 보이지 않습니다.")
    sys.exit(0)

# 패턴별 그룹 (L,W,T,A,S,R,O,I 순), 그 안은 경로:라인 순.
order = {'L': 0, 'W': 1, 'T': 2, 'A': 3, 'S': 4, 'R': 5, 'O': 6, 'I': 7}
findings.sort(key=lambda x: (order[x[2]], x[0], x[1]))

counts = {'L': 0, 'W': 0, 'T': 0, 'A': 0, 'S': 0, 'R': 0, 'O': 0, 'I': 0}
for f in findings:
    counts[f[2]] += 1

last_code = None
for path, lineno, code, exc, rec in findings:
    if code != last_code:
        name, conf, fix = META[code]
        print("%s■ [%s] %s — 신뢰도 %s (%d건)%s" % (BOLD, code, name, conf, counts[code], RST))
        print("%s   권장: %s%s" % (DIM, fix, RST))
        last_code = code
    name = META[code][0]
    # 수용 기준 출력 형식: «경로:라인  발췌  ← 위반 종류·권장 토큰»
    print("%s:%d  %s  ← [%s] %s · 권장: %s" % (relp(path), lineno, exc, code, name, rec))
print()

total = len(findings)
print("%s합계: %d건  (L=%d  W=%d  T=%d  A=%d  S=%d  R=%d  O=%d  I=%d)%s"
      % (BOLD, total, counts['L'], counts['W'], counts['T'], counts['A'],
         counts['S'], counts['R'], counts['O'], counts['I'], RST))

if not QUIET:
    print()
    print("%s거짓 양성 처리법:%s" % (BOLD, RST))
    print("  · 의도적이면 해당 라인에 `// design-lint: allow` 주석을 달면 스캔에서 빠집니다.")
    print("  · [L] Mac 은 Theme 가 없어 .orange/.yellow 리터럴이 정상 — blue 만 후보(accent 누락 의심).")
    print("  · [T] 해제/취소 버튼·피커 값 텍스트는 per-element `.tint(Color.primary)` 가 정답입니다.")
    print("  · [A] 장식용 이미지면 `.accessibilityHidden(true)`, 라벨이 필요하면 `.accessibilityLabel(\"…\")`.")
    print("  · [S/R] 「Theme.X.<크기>」 권장은 «값이 정확히 같은» 토큰 — 그대로 바꾸면 1px 도 안 변합니다. ")
    print("          「토큰 추가 검토」(온그리드 무토큰)·「비-그리드」(오프그리드)는 반올림하지 말고, 토큰을 ")
    print("          새로 «추가» 하거나 쌍둥이 화면에 맞춰 구조를 정합하세요(임의 반올림은 픽셀을 옮깁니다).")
    print("  · [O/I] «토큰값과 정확히 일치» 하는 리터럴만 후보입니다(.opacity(0.5)·임의 frame 은 비대상).")
    print("          시맨틱·의도적 값이면 그대로 두거나 `// design-lint: allow` 로 빼세요. width≠height ")
    print("          프레임은 정사각 아이콘이 아니라 I 후보가 아닙니다.")
    print("  · 이 도구는 «후보 표면화» 가 목적입니다(렌더링 대비비·warning↔pro 의미 판별은 디자이너 페르소나/비전 비평). 최종 판정은 사람이 합니다.")
    print("%s  PO 자가검증/‐verify-ios 에서는 «이 변경(diff)이 새로 들인» 후보에 집중하세요 — 기존 부채를 한꺼번에 막진 않습니다.%s" % (DIM, RST))

sys.exit(0 if SOFT else 1)
PYEOF
