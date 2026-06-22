#!/usr/bin/env bash
#
# test-po-agent-lint.sh — scripts/po-agent-lint.sh 의 회귀/단위 테스트.
#
# 1) «회귀 고정» (핵심): 「검증수집·정리 진입점 에이전트 선택 누락」 직전 상태를 합성 픽스처로
#    재현하면 그 누락이 P1/P2 후보로 잡히고, 현재 HEAD 의 실제 소스에선 사라졌음을 검증한다.
#    (옛 버전은 git show 7265d2d^ 로 실파일을 떴으나, v2.21.0 공개 스쿼시로 그 커밋이 main 의
#    조상에서 사라져 CI 의 새 체크아웃에선 추출 불가 → 히스토리 비의존 합성 픽스처로 고정한다.)
# 2) «단위»: P1/P2/P3 패턴과 제외 규칙(agent: 인자·의도적 nil·reject/hold·allow 주석)을
#    합성 픽스처로 검증한다(양성/음성/예외).
# 3) 종료코드 계약: 후보 0→0, ≥1→비-0(기본), --soft→항상 0.
#
# 종료코드: 모든 검사 통과 0, 하나라도 실패 1.
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LINT="$SCRIPT_DIR/po-agent-lint.sh"

PASS=0
FAIL=0
ok()   { PASS=$((PASS+1)); printf '  \033[32m✓\033[0m %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[31m✗ %s\033[0m\n' "$1"; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# ── (1a) 수정 «전» 합성 픽스처 → cleanup/collect 가 agent 누락[P1], shipped 액션이 픽커 없음[P2] ──
# 누락 직전 BacklogView 의 핵심 구조만 재현: ① 픽커(PoAgentSection)를 쓰는 화면이라 [P2] 스코프
# 진입, ② shipped 액션(startVerifyCollect)이 픽커 없이 spawn → [P2], ③ 정리(cleanup)·검증수집
# (collect) spawn 이 agent 인자 없이 호출 → 각각 [P1]. (실제 소스 라인 그대로라 검출·발췌 동일.)
echo "[1a] 회귀(합성): 수정 직전 누락이 P1/P2 후보로 잡히는가"
BEFORE="$TMP/before/ios/PocketSisyphus/Views"
mkdir -p "$BEFORE"
cat > "$BEFORE/BacklogView.swift" <<'SWIFT'
import SwiftUI

// 합성 회귀 픽스처(「검증수집·정리 진입점 agent 선택 누락」 직전 상태 재현).
private struct BriefDetailView: View {
    var body: some View {
        Form {
            // approve 픽커(decidable) — 이 화면이 «픽커를 쓰는» 화면임을 표시 → [P2] 스코프 진입.
            if decidable && !agents.isEmpty {
                PoAgentSection(agents: agents, selection: $execAgentId)
            }
            // shipped 액션은 픽커 없이 검증수집을 돌린다 → shipped 가 [P2] 후보(픽커 미커버).
            if brief.status == "shipped" {
                Button { Task { await startVerifyCollect() } } label: { Text("지금 수집해 검증하기") }
            }
        }
    }

    // [P1] 양성: 정리 세션 spawn 인데 agent 인자 없음.
    private func cleanupAndDismiss() async {
        let result = try await api.cleanupPoBrief(id: brief.id)
        onDecided(result.brief, result.cleanupSessionId)
    }

    // [P1] 양성: 검증수집(collect) spawn 인데 agent 인자 없음.
    private func startVerifyCollect() async {
        let started = try await api.startPoCollection(repoPath: brief.repoPath, instruction: nil)
        onVerifyCollect(started)
    }
}
SWIFT
BEFORE_OUT="$(cd "$REPO_ROOT" && "$LINT" --soft --quiet "$TMP/before" 2>&1)"

# cleanup 호출이 agent 없이 → [P1]
if printf '%s\n' "$BEFORE_OUT" | grep -F "[P1]" | grep -Fq "cleanupPoBrief(id: brief.id)"; then
  ok "수정 전: cleanupPoBrief agent 누락이 [P1] 로 잡힘"
else bad "수정 전인데 cleanupPoBrief 누락이 [P1] 로 안 잡힘"; fi
# startPoCollection (검증수집) 이 agent 없이 → [P1] (collect 라벨)
if printf '%s\n' "$BEFORE_OUT" | grep -Fq "[P1] collect 호출 agent: 누락"; then
  ok "수정 전: startPoCollection(검증수집) agent 누락이 [P1] 로 잡힘"
else bad "수정 전인데 검증수집 collect 누락이 [P1] 로 안 잡힘"; fi
# shipped 액션에 픽커 없음 → [P2]
if printf '%s\n' "$BEFORE_OUT" | grep -F "[P2]" | grep -Fq "startVerifyCollect"; then
  ok "수정 전: shipped startVerifyCollect 액션에 픽커 없음이 [P2] 로 잡힘"
else bad "수정 전인데 shipped 액션 픽커 누락이 [P2] 로 안 잡힘"; fi

# ── (1b) 현재 HEAD → 그 누락이 사라졌는가 (실제 소스 = 0 후보) ─────────────────────────────
echo "[1b] 회귀: 현재 HEAD(실제 소스) 에서 후보 0건"
(cd "$REPO_ROOT" && "$LINT" --quiet >/dev/null 2>&1); rc_head=$?
[ "$rc_head" -eq 0 ] && ok "HEAD 실제 소스 → 후보 0건(종료코드 0)" \
                     || bad "HEAD 실제 소스에 후보가 남음(종료코드 $rc_head)"

# ── (2) 단위: P1 (iOS 호출 passthrough) 픽스처 ────────────────────────────────────────────
echo "[2] 단위 P1: iOS spawn 호출 agent: 인자 (양성/음성/reject제외/allow)"
P1="$TMP/p1"; mkdir -p "$P1"
cat > "$P1/Calls.swift" <<'SWIFT'
import SwiftUI
struct Calls {
    func bad1() async throws {
        // [P1] 양성: agent 없이 collect
        _ = try await api.startPoCollection(repoPath: r, instruction: nil)
    }
    func bad2() async throws {
        // [P1] 양성: agent 없이 cleanup
        _ = try await api.cleanupPoBrief(id: x)
    }
    func ok1() async throws {
        // 음성: agent 인자 있음
        _ = try await api.startPoResearch(repoPath: r, topic: t, agent: a)
    }
    func ok2() async throws {
        // 음성: 의도적 nil 도 agent: «라벨» 은 있음 (픽커 미노출/옛 daemon 폴백)
        let agent = agents.isEmpty ? nil : execAgentId
        _ = try await api.restartPoBriefExec(id: x, agent: agent)
    }
    func ok3() async throws {
        // 음성: decide reject 는 세션 spawn 없음 → agent 불필요
        _ = try await api.decidePoBrief(id: x, action: "reject", reason: r)
    }
    func bad3() async throws {
        // [P1] 양성: decide 가 approve 인데 agent 없음
        _ = try await api.decidePoBrief(id: x, action: "approve")
    }
    func allowed() async throws {
        // po-agent-lint: allow (의도적 예외)
        _ = try await api.cleanupPoBrief(id: x)
    }
}
SWIFT
P1_OUT="$(cd "$REPO_ROOT" && "$LINT" --soft --quiet "$P1" 2>&1)"

assert_hit() {  # <code> <needle> <설명>
  if printf '%s\n' "$P1_OUT" | grep -F -- "[$1]" | grep -Fq -- "$2"; then ok "[$1] $3"
  else bad "[$1] 양성 누락: $3  (needle: $2)"; fi
}
assert_miss() { # <needle> <설명>  (전체 출력에서 그 문구가 떠선 안 됨)
  if printf '%s\n' "$P1_OUT" | grep -Fq -- "$1"; then bad "오탐(떠선 안 됨): $2  (needle: $1)"
  else ok "제외 OK: $2"; fi
}
assert_hit P1 'startPoCollection(repoPath: r, instruction: nil)' "agent 없는 collect"
assert_hit P1 'cleanupPoBrief(id: x)'                            "agent 없는 cleanup"
assert_hit P1 'decidePoBrief(id: x, action: "approve")'         "approve 인데 agent 없음"
assert_miss 'startPoResearch(repoPath: r, topic: t, agent: a)'  "agent 인자 있는 research"
assert_miss 'restartPoBriefExec(id: x, agent: agent)'           "의도적 nil 도 agent: 라벨 있음"
assert_miss 'action: "reject"'                                  "decide reject (spawn 없음)"

# allow: cleanupPoBrief 는 2건(bad2 + allowed) — allow 줄(allowed)은 빠지고 1건만 떠야.
n_cleanup="$(printf '%s\n' "$P1_OUT" | grep -F "[P1]" | grep -Fc "cleanupPoBrief(id: x)")"
[ "$n_cleanup" -eq 1 ] && ok "allow 주석: cleanup 2건 중 1건만 후보(allowed 제외)" \
                       || bad "allow 주석 처리 실패: cleanup 후보 $n_cleanup 건(기대 1)"

# ── (3) 단위: P2 (픽커 상태 커버리지) 픽스처 ──────────────────────────────────────────────
echo "[3] 단위 P2: 픽커 쓰는 화면의 상태별 액션 커버리지"
P2="$TMP/p2"; mkdir -p "$P2"
cat > "$P2/Detail.swift" <<'SWIFT'
import SwiftUI
private struct DetailView: View {
    var body: some View {
        Form {
            // approve 픽커 (decidable — 상태 리터럴 아님)
            if decidable && !agents.isEmpty {
                PoAgentSection(agents: agents, selection: $execAgentId)
            }
            // shipped 픽커는 «일부러 뺐다» → shipped 액션이 P2 후보가 돼야 한다.
            if brief.status == "shipped" {
                Button { Task { await startVerifyCollect() } } label: { Text("검증수집") }
            }
            // rejected 액션 + rejected 픽커 둘 다 있음 → 커버됨(음성)
            if brief.status == "rejected" && !agents.isEmpty {
                PoAgentSection(agents: agents, selection: $execAgentId)
            }
            if brief.status == "rejected" {
                Button { Task { await restart(brief) } } label: { Text("정리") }
            }
        }
    }
}
SWIFT
P2_OUT="$(cd "$REPO_ROOT" && "$LINT" --soft --quiet "$P2" 2>&1)"
if printf '%s\n' "$P2_OUT" | grep -F "[P2]" | grep -Fq "startVerifyCollect"; then
  ok "[P2] shipped 액션에 shipped 픽커 없음 → 후보"
else bad "[P2] shipped 액션 픽커 누락 미검출"; fi
if printf '%s\n' "$P2_OUT" | grep -F "[P2]" | grep -Fq "상태 rejected"; then
  bad "[P2] 오탐: rejected 는 픽커가 있는데 후보로 떴다"
else ok "[P2] rejected 는 픽커가 있어 후보 아님(음성)"; fi

# 픽커를 «안» 쓰는 화면은 스코프 밖 — 상태별 액션이 있어도 P2 안 뜬다.
cat > "$P2/NoPicker.swift" <<'SWIFT'
import SwiftUI
private struct NoPickerView: View {
    var body: some View {
        Form {
            if brief.status == "shipped" {
                Button { Task { await startVerifyCollect() } } label: { Text("x") }
            }
        }
    }
}
SWIFT
NOPICK_OUT="$(cd "$REPO_ROOT" && "$LINT" --soft --quiet "$P2/NoPicker.swift" 2>&1)"
if printf '%s\n' "$NOPICK_OUT" | grep -Fq "[P2]"; then
  bad "[P2] 오탐: 픽커 안 쓰는 화면인데 후보로 떴다"
else ok "[P2] 픽커 안 쓰는 화면은 스코프 밖(음성)"; fi

# ── (4) 단위: P3 (daemon passthrough) 픽스처 ──────────────────────────────────────────────
echo "[4] 단위 P3: daemon 핸들러 agent 읽기 + spawn 전달"
P3="$TMP/p3"; mkdir -p "$P3"
cat > "$P3/po.ts" <<'TS'
po.post("/collect", async (c) => {
  const body = await c.req.json();
  // [P3] 양성: body.agent 안 읽음
  const result = startPoCollection(repoPath, undefined);
  return c.json({ sessionId: result.sessionId });
});
po.post("/research", async (c) => {
  const body = await c.req.json();
  const agent = parseAgent(body.agent);
  // [P3] 양성: 읽었지만 spawn 에 안 넘김
  const result = startPoResearch(repoPath, topic, undefined, lens);
  return c.json({ researchId: result.researchId });
});
po.post("/briefs/:id/cleanup", async (c) => {
  const body = await c.req.json();
  // 음성: 읽고 createSession 에 agentId 전달
  const agentId = parseAgent(body.agent) ?? "claude_code";
  const sessionId = createSession(dir.path, title, undefined, true, agentId);
  return c.json({ cleanupSessionId: sessionId });
});
po.post("/briefs/:id/restart", async (c) => {
  // po-agent-lint: allow (의도적 예외 — 테스트용)
  const body = await c.req.json();
  const sessionId = createSession(dir.path, title);
  return c.json({ execSessionId: sessionId });
});
TS
P3_OUT="$(cd "$REPO_ROOT" && "$LINT" --soft --quiet "$P3" 2>&1)"
if printf '%s\n' "$P3_OUT" | grep -F "[P3]" | grep -Fq "POST /collect 핸들러가 body.agent 를 안 읽음"; then
  ok "[P3] body.agent 안 읽는 핸들러 → 후보"
else bad "[P3] body.agent 미읽음 미검출"; fi
if printf '%s\n' "$P3_OUT" | grep -F "[P3]" | grep -Fq "POST /research 핸들러가 agent 를 세션 spawn 에 전달 안 함"; then
  ok "[P3] 읽었지만 spawn 에 안 넘기는 핸들러 → 후보"
else bad "[P3] spawn 미전달 미검출"; fi
if printf '%s\n' "$P3_OUT" | grep -F "[P3]" | grep -Fq "/cleanup"; then
  bad "[P3] 오탐: cleanup 은 제대로 전달하는데 후보로 떴다"
else ok "[P3] cleanup 정상 전달 → 후보 아님(음성)"; fi
if printf '%s\n' "$P3_OUT" | grep -F "[P3]" | grep -Fq "/restart"; then
  bad "[P3] allow 주석 무시됨: restart 가 후보로 떴다"
else ok "[P3] allow 주석: restart 핸들러 제외"; fi

# ── (5) 종료코드 계약 ─────────────────────────────────────────────────────────────────────
echo "[5] 종료코드 계약: 후보 0→0, ≥1→비-0(기본), --soft→0"
EMPTY="$TMP/empty"; mkdir -p "$EMPTY"
cat > "$EMPTY/Clean.swift" <<'SWIFT'
import SwiftUI
struct Clean { func go() async throws { _ = try await api.startPoCollection(repoPath: r, agent: a) } }
SWIFT
(cd "$REPO_ROOT" && "$LINT" --quiet "$EMPTY" >/dev/null 2>&1); rc_e=$?
[ "$rc_e" -eq 0 ] && ok "후보 0건 → 종료코드 0" || bad "후보 0건인데 종료코드 $rc_e"
(cd "$REPO_ROOT" && "$LINT" --quiet "$P1" >/dev/null 2>&1); rc_f=$?
[ "$rc_f" -ne 0 ] && ok "후보 있음 → 비-0 종료코드($rc_f)" || bad "후보 있는데 종료코드 0"
(cd "$REPO_ROOT" && "$LINT" --soft --quiet "$P1" >/dev/null 2>&1); rc_s=$?
[ "$rc_s" -eq 0 ] && ok "--soft → 후보 있어도 종료코드 0" || bad "--soft 인데 종료코드 $rc_s"

# ── 결과 ──────────────────────────────────────────────────────────────────────────────────
echo
echo "─────────────────────────────────────────────"
echo "통과 $PASS · 실패 $FAIL"
[ "$FAIL" -eq 0 ] && { echo "✅ ALL PASS"; exit 0; } || { echo "❌ FAIL"; exit 1; }
