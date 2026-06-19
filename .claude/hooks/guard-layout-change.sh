#!/usr/bin/env bash
# PostToolUse 가드 — SwiftUI «레이아웃» 모디파이어를 건드린 편집을 감지하면, 커밋 전에
# 시뮬레이터/실기기 스크린샷으로 before/after 를 캡처해 «개발자 승인» 을 받으라고 Claude 에게
# 리마인드한다.
#
# 배경(실제 사고, commit f756c74 → e455805): 28pt 짜리 ChatKeyButton 에 a11y 목적으로
#   .frame(minWidth: 44, minHeight: 44) 를 씌웠는데, 의도는 «탭 영역만 키우기» 였으나
#   .frame(minWidth/minHeight) 는 탭 영역이 아니라 «레이아웃 점유 면적» 을 키운다. 작은 시각
#   박스가 44pt 셀 가운데 떠 채팅 가상키·이미지첨부 버튼이 전부 벌어졌다. «눈으로» 안 보고
#   커밋해서 사용자가 실기기에서야 발견 → 이런 회귀를 커밋 전에 잡으려는 가드.
#
# 동작: 방금 Edit/Write/MultiEdit 한 «이번 편집의 변경 텍스트» 가 .swift 파일에서 레이아웃
#   토큰을 담고 있으면 exit 2 로 Claude 에게 체크리스트를 돌려준다(편집을 되돌리진 않음 — 리마인드).
#   순수 로직/비-View 변경엔 토큰이 안 잡혀 조용히 통과한다.
#
# 구현 메모: python 프로그램은 heredoc(=python 의 stdin)으로 주고, 페이로드는 «환경변수» 로
#   넘긴다. (stdin 으로 페이로드를 파이프하면 heredoc 과 충돌해 페이로드가 안 읽힌다.)
set -euo pipefail

payload="$(cat)"

GUARD_LAYOUT_PAYLOAD="$payload" python3 <<'PY'
import os, json, re

try:
    d = json.loads(os.environ.get("GUARD_LAYOUT_PAYLOAD", ""))
except Exception:
    raise SystemExit(0)

ti = d.get("tool_input", {}) or {}
fp = ti.get("file_path", "") or ""
if not fp.endswith(".swift"):
    raise SystemExit(0)

# «이번 편집» 으로 들어간 텍스트만 모은다 (파일 전체가 아니라 — 기존 레이아웃 코드가 있는
# 파일을 로직만 고쳤는데 매번 걸리는 노이즈를 막으려고).
changed = []
if ti.get("new_string") is not None:
    changed.append(str(ti.get("new_string")))
if ti.get("content") is not None:
    changed.append(str(ti.get("content")))
for e in (ti.get("edits") or []):
    if isinstance(e, dict) and e.get("new_string") is not None:
        changed.append(str(e.get("new_string")))
text = "\n".join(changed)
if not text.strip():
    raise SystemExit(0)

# 레이아웃에 영향 주는 SwiftUI 토큰. (색·폰트 등 «그리기만» 하는 모디파이어는 제외 —
# 위치/크기/간격/배치에 영향 주는 것만 잡아 오탐을 줄인다.)
TOKENS = [
    r"\.frame\(", r"\.padding\(", r"spacing:", r"\.offset\(", r"\.position\(",
    r"\.layoutPriority\(", r"\.fixedSize\(", r"\.aspectRatio\(",
    r"\.scaledToFit\b", r"\.scaledToFill\b", r"\.inset\(",
    r"\bHStack\b", r"\bVStack\b", r"\bZStack\b",
    r"\bLazyVStack\b", r"\bLazyHStack\b", r"\bLazyVGrid\b", r"\bLazyHGrid\b",
    r"\bGrid\b", r"\bGridRow\b", r"\bSpacer\(", r"\bGeometryReader\b",
    r"\balignment:", r"\bedgeInsets\b", r"\bsafeArea",
]
pat = re.compile("|".join(TOKENS))
hits = sorted({m.group(0) for m in pat.finditer(text)})
if not hits:
    raise SystemExit(0)

base = os.path.basename(fp)
msg = f"""🖼️ 레이아웃 모디파이어를 건드렸습니다 — {base}
   감지: {", ".join(hits)}

   커밋 전에 «눈으로» 검증하고 개발자 승인을 받으세요 (사고 이력: .frame(minWidth:44) 가
   탭 영역이 아니라 레이아웃 면적을 키워 채팅 가상키가 벌어진 회귀 — f756c74).
     1) /verify-ios (또는 /device) 로 빌드·설치·실행 후 «스크린샷 캡처»
     2) Claude 가 스크린샷을 읽어 before/after 와 함께 개발자에게 «첨부 보고»
     3) AskUserQuestion 으로 개발자 «승인» 을 받은 뒤에만 커밋
   ※ .frame(minWidth/minHeight) 는 탭 영역이 아니라 레이아웃 점유 면적을 키운다 — 탭 타깃만
     넓히려면 시각 크기를 키우거나 밀집 키 HIG 예외를 따른다.
   ※ 순수 로직/비-View 변경(상태·핸들러 등)이라 레이아웃이 안 바뀌면 이 리마인드는 무시 가능."""
import sys
print(msg, file=sys.stderr)
raise SystemExit(2)
PY
