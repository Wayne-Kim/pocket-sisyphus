#!/usr/bin/env bash
#
# test-agent-surfaces-lint.sh — scripts/agent-surfaces-lint.sh 의 회귀/단위 테스트.
#
# 1) «정합 고정»: 현재 HEAD 의 실제 repo 에서 돌리면 4개 표면이 모두 픽커 SSOT 와 «정합»(0 종료).
# 2) «드리프트 탐지»(합성 픽스처 repo): 표면별 누락=실패 / 순서=경고 / 표기불일치=실패 /
#    고급도구 분류 오탐 없음 / SSOT 내부 드리프트=실패 / 종료코드 계약을 양성·음성으로 검증.
# 3) «표면 집합 ↔ README SSOT 주석 일치»: --list-surfaces 의 5개 경로가 README 주석이 열거한
#    표면과 일치(하나 빠지면 검사가 헛돈다는 수용 기준).
#
# 종료코드: 모든 검사 통과 0, 하나라도 실패 1.
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LINT="$SCRIPT_DIR/agent-surfaces-lint.sh"

PASS=0
FAIL=0
ok()  { PASS=$((PASS+1)); printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  \033[31m✗ %s\033[0m\n' "$1"; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# ── 합성 픽스처 repo 생성기 (정합 상태) ──────────────────────────────────────────────────
# 코드 에이전트 4종(Claude Code/Antigravity/Codex/Copilot) + 고급 2종(Terminal/Qwen Code).
# threshold = max(2, 4-1) = 3 → «3개 이상 나열한 줄» 은 4개 «전부» 나열해야 한다.
seed_good() {
  local R="$1"
  mkdir -p "$R/ios/PocketSisyphus/Models" "$R/mac/daemon/src/agent" \
           "$R/mac/PocketSisyphusMac" "$R/web/content"

  cat > "$R/ios/PocketSisyphus/Models/AgentKind.swift" <<'SWIFT'
enum AgentKind: Equatable {
    var rawId: String {
        switch self {
        case .claudeCode: return "claude_code"
        case .antigravity: return "agy"
        case .codex: return "codex"
        case .copilot: return "copilot"
        case .shell: return "shell"
        case .localLlm: return "local_llm"
        case .unknown(let raw): return raw
        }
    }
    var displayName: String {
        switch self {
        case .claudeCode: return "Claude Code"
        case .antigravity: return "Antigravity"
        case .codex: return "Codex"
        case .copilot: return "Copilot"
        case .shell: return "Terminal"
        case .localLlm: return "Qwen Code"
        case .unknown(let raw): return raw
        }
    }
}
SWIFT

  cat > "$R/mac/daemon/src/agent/index.ts" <<'TS'
import { registerAgent, hasAgent } from "./registry.js";
import { claudeCodeAdapter } from "./adapters/claude-code/index.js";
import { agyAdapter } from "./adapters/agy/index.js";
import { codexAdapter } from "./adapters/codex/index.js";
import { copilotAdapter } from "./adapters/copilot/index.js";
import { shellAdapter } from "./adapters/shell/index.js";
import { localLlmAdapter } from "./adapters/local-llm/index.js";
export function registerBuiltinAgents(): void {
  if (hasAgent("claude_code")) return;
  registerAgent(claudeCodeAdapter);
  registerAgent(agyAdapter);
  registerAgent(codexAdapter);
  registerAgent(copilotAdapter);
  registerAgent(shellAdapter);
  registerAgent(localLlmAdapter);
}
TS

  cat > "$R/README.md" <<'MD'
## Supported code agents

- **Claude Code** (Anthropic)
- **Google Antigravity** (Google)
- **OpenAI Codex** (OpenAI)
- **GitHub Copilot CLI** (GitHub)

<!-- SSOT 표면: README.ko.md · web/content/site.en.ts · ios/PocketSisyphus/Models/GuideContent.swift ·
     mac/PocketSisyphusMac/GuideContent.swift -->

모델 추론은 각 제공자로 직접.
MD

  cat > "$R/README.ko.md" <<'MD'
## 지원하는 코드 에이전트

- **Claude Code** (Anthropic)
- **Google Antigravity** (Google)
- **OpenAI Codex** (OpenAI)
- **GitHub Copilot CLI** (GitHub)

모델 추론은 각 제공자로 직접.
MD

  cat > "$R/web/content/site.en.ts" <<'TSX'
export const site = {
  agents: {
    heading: "Bring your own agent",
    items: [
      { id: "claude-code", name: "Claude Code", vendor: "Anthropic" },
      { id: "antigravity", name: "Google Antigravity", vendor: "Google" },
      { id: "codex", name: "OpenAI Codex", vendor: "OpenAI" },
      { id: "copilot", name: "GitHub Copilot CLI", vendor: "GitHub" },
      { id: "terminal", name: "Terminal", vendor: "Pro" },
      { id: "local-llm", name: "Qwen Code", vendor: "Pro" },
    ],
  },
} as const;
TSX

  cat > "$R/ios/PocketSisyphus/Models/GuideContent.swift" <<'SWIFT'
enum GuideContent {
    static let s = [
        .paragraph("코드 에이전트 CLI 를 실행 — Claude Code / Google Antigravity / OpenAI Codex / GitHub Copilot CLI 등) 입니다."),
        .paragraph("키체인 접근 (Claude Code-credentials) — 단일 언급은 나열 줄이 아니다."),
    ]
}
SWIFT

  cat > "$R/mac/PocketSisyphusMac/GuideContent.swift" <<'SWIFT'
enum GuideContent {
    static let s = [
        .paragraph("세션마다 코드 에이전트 CLI 를 고를 수 있습니다 (현재 Claude Code, Google Antigravity, OpenAI Codex, GitHub Copilot CLI 지원)."),
    ]
}
SWIFT

}

GOOD="$TMP/good"
seed_good "$GOOD"

mut() { # <fixture dir> — copy GOOD into it, returns via stdout the new dir
  local d="$1"; cp -R "$GOOD" "$d"; echo "$d"
}
run() { (cd "$REPO_ROOT" && "$LINT" --quiet "$@"); }   # --quiet for stable machine output

# ── (0) 실제 repo 정합 고정 ───────────────────────────────────────────────────────────────
echo "[0] 실제 repo: 4개 표면이 픽커 SSOT 와 정합(0 종료)"
REAL_OUT="$(cd "$REPO_ROOT" && "$LINT" 2>&1)"; rc=$?
if [ "$rc" -eq 0 ] && printf '%s\n' "$REAL_OUT" | grep -q "정합 OK"; then
  ok "실제 repo 정합 OK + 0 종료"
else
  bad "실제 repo 가 정합이 아님(rc=$rc) — 이 변경이 표면을 다 못 맞춤?"; printf '%s\n' "$REAL_OUT" | sed 's/^/    /'
fi
# 실제 repo SSOT 요약에 OpenCode 가 코드 에이전트로, Terminal/Qwen Code 가 고급 도구로 잡히는가
SUM="$(cd "$REPO_ROOT" && "$LINT" 2>&1 | grep '픽커 SSOT')"
printf '%s\n' "$SUM" | grep -q "OpenCode" && ok "SSOT 요약: OpenCode = 코드 에이전트" || bad "SSOT 요약에 OpenCode 없음"
printf '%s\n' "$SUM" | grep -q "고급 도구 = Terminal · Qwen Code" && ok "SSOT 요약: 고급 도구 = Terminal · Qwen Code" || bad "고급 도구 분류 표기 불일치"

# ── (1) 정합 픽스처 → 0 종료, finding 0 ──────────────────────────────────────────────────
echo "[1] 정합 픽스처: finding 0건 + 0 종료"
OUT="$(run "$GOOD" 2>&1)"; rc=$?     # --quiet: 정합이면 출력이 비어 있어야 한다
[ "$rc" -eq 0 ] && ok "정합 픽스처 0 종료" || bad "정합 픽스처가 비-0($rc)"
if printf '%s\n' "$OUT" | grep -qE '\[(MISS|ORDER|WARN|SSOT)'; then
  bad "정합 픽스처에 finding 발생"; printf '%s\n' "$OUT" | sed 's/^/    /'
else ok "정합 픽스처 finding 0건"; fi
# 검증을 위해 비-quiet 로도 '정합 OK' 가 나오는지 확인
(cd "$REPO_ROOT" && "$LINT" "$GOOD" 2>&1) | grep -q "정합 OK" && ok "비-quiet 에서 '정합 OK' 출력" || bad "'정합 OK' 미출력"
# 고급 도구 분류: 가이드는 코드 에이전트만 — Terminal/Qwen Code 누락을 «요구하지 않아야»(오탐 0)
if printf '%s\n' "$OUT" | grep -qE '\[MISS.*(Terminal|Qwen Code)'; then
  bad "오탐: 가이드/표면에서 고급 도구(Terminal/Qwen Code)를 요구함(분류 무시)"
else ok "분류 OK: 가이드에서 Terminal/Qwen Code 를 요구하지 않음(오탐 0)"; fi

# ── (2) 누락 = 실패: README 에서 Copilot 제거 ────────────────────────────────────────────
echo "[2] 집합 누락 = 실패 (README 에서 Copilot 항목 제거)"
D="$(mut "$TMP/t_readme")"
python3 - "$D/README.md" <<'PY'
import sys; p=sys.argv[1]; t=open(p).read()
open(p,'w').write(t.replace("- **GitHub Copilot CLI** (GitHub)\n",""))
PY
OUT="$(run "$D" 2>&1)"; rc=$?
[ "$rc" -ne 0 ] && ok "Copilot 누락 → 비-0($rc)" || bad "Copilot 누락인데 0 종료"
printf '%s\n' "$OUT" | grep -E "README.*\[MISS/실패\].*Copilot" >/dev/null && ok "README:라인 — [MISS] Copilot 보고" || { bad "README Copilot 누락 미보고"; printf '%s\n' "$OUT" | sed 's/^/    /'; }

# ── (3) 누락 = 실패: iOS 가이드 나열 줄에서 Copilot 제거(파일:라인 보고) ──────────────────
echo "[3] 가이드 나열 줄 누락 = 실패 + 파일:라인 보고"
D="$(mut "$TMP/t_guide")"
python3 - "$D/ios/PocketSisyphus/Models/GuideContent.swift" <<'PY'
import sys; p=sys.argv[1]; t=open(p).read()
open(p,'w').write(t.replace(" / GitHub Copilot CLI 등"," 등"))
PY
OUT="$(run "$D" 2>&1)"; rc=$?
[ "$rc" -ne 0 ] && ok "가이드 Copilot 누락 → 비-0($rc)" || bad "가이드 누락인데 0 종료"
printf '%s\n' "$OUT" | grep -E "ios/PocketSisyphus/Models/GuideContent\.swift:[0-9]+ — \[MISS/실패\].*Copilot" >/dev/null \
  && ok "가이드 파일:라인 — [MISS] Copilot 보고" || { bad "가이드 파일:라인 미보고"; printf '%s\n' "$OUT" | sed 's/^/    /'; }

# ── (4) 표기불일치 = 실패: web 에서 Qwen Code → Local LLM ─────────────────────────────────
echo "[4] 표기불일치 = 실패 (web local-llm 항목명을 Local LLM 으로)"
D="$(mut "$TMP/t_web")"
python3 - "$D/web/content/site.en.ts" <<'PY'
import sys; p=sys.argv[1]; t=open(p).read()
open(p,'w').write(t.replace('name: "Qwen Code"','name: "Local LLM"'))
PY
OUT="$(run "$D" 2>&1)"; rc=$?
[ "$rc" -ne 0 ] && ok "Qwen Code 표기불일치 → 비-0($rc)" || bad "표기불일치인데 0 종료"
printf '%s\n' "$OUT" | grep -E "web.*\[MISS/실패\].*Qwen Code" >/dev/null && ok "web — [MISS] Qwen Code(표기불일치) 보고" || { bad "web Qwen Code 표기불일치 미보고"; printf '%s\n' "$OUT" | sed 's/^/    /'; }
# 코드 에이전트는 다 있으므로 그쪽 MISS 는 없어야(고급 도구만 실패)
printf '%s\n' "$OUT" | grep -E "web.*\[MISS/실패\].*(Claude Code|Codex|Copilot|Antigravity)" >/dev/null \
  && bad "오탐: web 코드 에이전트가 누락으로 잡힘" || ok "web 코드 에이전트는 정상(고급 도구만 실패)"

# ── (5) 순서 불일치 = 경고(실패 아님): README 불릿 순서 뒤집기 ────────────────────────────
echo "[5] 순서 불일치 = 경고 (집합은 맞고 순서만 다름 → 0 종료)"
D="$(mut "$TMP/t_order")"
cat > "$D/README.md" <<'MD'
## 지원하는 코드 에이전트

- **Claude Code** (Anthropic)
- **OpenAI Codex** (OpenAI)
- **Google Antigravity** (Google)
- **GitHub Copilot CLI** (GitHub)

MD
OUT="$(run "$D" 2>&1)"; rc=$?
[ "$rc" -eq 0 ] && ok "순서만 다름 → 0 종료(실패 아님)" || bad "순서 불일치인데 비-0($rc)"
printf '%s\n' "$OUT" | grep -E "README.*\[ORDER/경고\]" >/dev/null && ok "README — [ORDER/경고] 보고" || { bad "[ORDER] 경고 미보고"; printf '%s\n' "$OUT" | sed 's/^/    /'; }
printf '%s\n' "$OUT" | grep -E "README.*\[MISS" >/dev/null && bad "오탐: 순서만 다른데 MISS 보고" || ok "순서 불일치는 MISS 가 아님"

# ── (6) SSOT 내부 드리프트 = 실패: daemon 에 AgentKind 에 없는 어댑터 등록 ────────────────
echo "[6] SSOT 내부 드리프트 = 실패 (daemon 이 AgentKind 에 없는 id 등록)"
D="$(mut "$TMP/t_ssot")"
python3 - "$D/mac/daemon/src/agent/index.ts" <<'PY'
import sys; p=sys.argv[1]; t=open(p).read()
t=t.replace('import { codexAdapter } from "./adapters/codex/index.js";',
            'import { codexAdapter } from "./adapters/codex/index.js";\nimport { geminiAdapter } from "./adapters/gemini-cli/index.js";')
t=t.replace('  registerAgent(codexAdapter);',
            '  registerAgent(codexAdapter);\n  registerAgent(geminiAdapter);')
open(p,'w').write(t)
PY
OUT="$(run "$D" 2>&1)"; rc=$?
[ "$rc" -ne 0 ] && ok "SSOT 내부 드리프트 → 비-0($rc)" || bad "SSOT 드리프트인데 0 종료"
printf '%s\n' "$OUT" | grep -E "\[SSOT\]" >/dev/null && ok "[SSOT] 내부 정합 실패 보고" || { bad "[SSOT] 미보고"; printf '%s\n' "$OUT" | sed 's/^/    /'; }

# ── (7) 종료코드 계약: --soft 항상 0 ─────────────────────────────────────────────────────
echo "[7] 종료코드 계약: 실패 있어도 --soft → 0"
(cd "$REPO_ROOT" && "$LINT" --soft --quiet "$TMP/t_readme" >/dev/null 2>&1); rc=$?
[ "$rc" -eq 0 ] && ok "--soft → 실패 있어도 0" || bad "--soft 인데 $rc"

# ── (8) 표면 누락 = 실패: 표면 파일 자체가 없을 때 ────────────────────────────
echo "[8] 선언된 표면 파일 누락 = 실패"
D="$(mut "$TMP/t_missing")"; rm -f "$D/mac/PocketSisyphusMac/GuideContent.swift"
OUT="$(run "$D" 2>&1)"; rc=$?
[ "$rc" -ne 0 ] && ok "표면 파일 없음 → 비-0($rc)" || bad "표면 파일 없는데 0 종료"
printf '%s\n' "$OUT" | grep -E "GuideContent\.swift — \[MISS/실패\].*표면 파일이 없음" >/dev/null && ok "표면 파일 누락 보고" || { bad "표면 파일 누락 미보고"; printf '%s\n' "$OUT" | sed 's/^/    /'; }

# ── (9) 표면 집합 ↔ README SSOT 주석 일치 ────────────────────────────────────────────────
echo "[9] --list-surfaces 5개 + 각 경로가 실제 README SSOT 주석에 열거됨"
LIST="$(cd "$REPO_ROOT" && "$LINT" --list-surfaces 2>&1)"
ncnt="$(printf '%s\n' "$LIST" | grep -c $'\t')"
[ "$ncnt" -eq 5 ] && ok "표면 5개" || bad "표면 개수 $ncnt (기대 5)"
README_TXT="$(cat "$REPO_ROOT/README.md")"
miss=0
while IFS=$'\t' read -r key path; do
  case "$key" in
    README|README.ko) continue ;;   # 주석 1번 항목 «이 README»(영어 원본 + 한국어 미러) 자기 자신
  esac
  if printf '%s' "$README_TXT" | grep -Fq "$path"; then :; else
    bad "README SSOT 주석에 표면 경로 미열거: $key ($path)"; miss=1
  fi
done <<< "$LIST"
[ "$miss" -eq 0 ] && ok "모든 표면 경로가 README SSOT 주석에 열거됨"

# ── 결과 ──────────────────────────────────────────────────────────────────────────────────
echo
echo "─────────────────────────────────────────────"
echo "통과 $PASS · 실패 $FAIL"
[ "$FAIL" -eq 0 ] && { echo "✅ ALL PASS"; exit 0; } || { echo "❌ FAIL"; exit 1; }
