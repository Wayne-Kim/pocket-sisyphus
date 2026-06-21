/**
 * 외부-콘텐츠 오염(taint) 표식 — CAPABILITY_CAPS.md §2.1·T1 의 정본 spec.
 *
 * 모델: 개인/외부 데이터를 에이전트 컨텍스트에 «적재» 하는 경로는 그 세션을
 * `external_content_tainted = true` 로 표시한다. 이 표식은 **단조(monotonic)** — 한 번 오염되면
 * 세션 수명 동안 유지되고 «해제가 없다». continue(cron) · 다음 워크플로우 노드 · worktree 처럼
 * 컨텍스트를 물려받는 후속 세션으로 propagateTaint 가 전파한다.
 *
 * 오염 세션의 EGRESS 는 기본 deny(T1). daemon 이 «그 세션을 대신해» 내는 outbound(예: 알림
 * payload 의 본문 미리보기)는 sessionEgressAllowed/guardTaintedEgress 를 SSOT 로 막는다 —
 * egress.ts(LAN 전용)와 같은 «단일 게이트» 결. 에이전트 CLI 가 자기 프로세스 안에서 내는
 * git push·임의 HTTP 같은 outbound 는 daemon 이 호출 단위로 가로채지 못하므로, 그쪽은 §M1/M3
 * (무인 세션엔 EGRESS MCP 미연결) + §C1(정적 거부)로 «능력 자체를 안 주는» 방식으로 막는다.
 *
 * 현 스코프의 daemon 측 taint «소스» = repo 에 개인-데이터(메일/캘린더) MCP 가 연결된 세션
 * (computeInitialTaint). #1·#2(메일/캘린더 기능)가 실제 본문을 컨텍스트에 적재하는 코드 경로를
 * 추가하면 그 지점에서 markSessionTainted 를 직접 호출해 정밀화한다.
 */
import { db } from "./db/index.js";
import { listServers } from "./mcp/store.js";
import { hasTaintSource } from "./mcp/policy.js";

/** 세션이 오염됐는지 — DB 의 external_content_tainted 컬럼(0/1). 없는 세션/조회 실패는 false. */
export function isSessionTainted(sessionId: string): boolean {
  try {
    const row = db()
      .prepare(`SELECT external_content_tainted AS t FROM sessions WHERE id = ?`)
      .get(sessionId) as { t: number } | undefined;
    return row?.t === 1;
  } catch {
    return false;
  }
}

/**
 * 세션을 오염으로 표시(단조 — 1 로만 올리고 절대 0 으로 안 내린다). 이미 오염이면 no-op.
 * `source` 는 진단 로그용(디버그 문자열은 로케일 대상 아님). 절대 throw 하지 않는다.
 */
export function markSessionTainted(sessionId: string, source: string): void {
  try {
    const res = db()
      .prepare(
        `UPDATE sessions SET external_content_tainted = 1
          WHERE id = ? AND external_content_tainted = 0`,
      )
      .run(sessionId);
    if (res.changes > 0) {
      console.log(`[taint] session=${sessionId} 오염 표시 — source=${source}`);
    }
  } catch (e) {
    console.warn(`[taint] mark 실패 session=${sessionId}:`, (e as Error).message);
  }
}

/**
 * 컨텍스트를 물려받는 후속 세션으로 오염을 전파(해제 없음). from 이 오염이면 to 도 오염.
 * cron session_mode=continue · 다음 워크플로우 노드 · PO worktree 계승에서 호출한다.
 */
export function propagateTaint(fromSessionId: string | null | undefined, toSessionId: string): void {
  if (!fromSessionId) return;
  if (isSessionTainted(fromSessionId)) {
    markSessionTainted(toSessionId, `inherit:${fromSessionId}`);
  }
}

/**
 * 새 세션의 «초기 오염» 판정 — 이 repo 에 개인-데이터(메일/캘린더) taint 소스 MCP 가 연결돼
 * 있으면 그 세션은 외부 콘텐츠를 적재할 수 있으므로 오염으로 본다(보수적 fail-closed).
 * MCP 가 없는 절대다수 repo 는 false → 회귀 0. config 미초기화/조회 실패도 false.
 */
export function computeInitialTaint(repoPath: string): boolean {
  try {
    const servers = listServers().filter((s) => s.repoPath === repoPath);
    return hasTaintSource(servers);
  } catch {
    return false;
  }
}

/**
 * 이 세션의 EGRESS 가 허용되는가(정책 SSOT). 오염 세션은 기본 deny(T1) → false.
 * 비-오염 세션은 종전대로 true(회귀 0).
 */
export function sessionEgressAllowed(sessionId: string): boolean {
  return !isSessionTainted(sessionId);
}

/**
 * 세션을 대신한 outbound 직전에 부르는 단일 게이트 — 오염 세션이면 차단(true 반환 = skip).
 * egress.ts 의 guardNonLanEgress 와 같은 호출 규약(true=차단, false=평소대로). `channel` 은
 * 진단 로그용. 비-오염이면 부작용 0.
 */
export function guardTaintedEgress(sessionId: string, channel: string): boolean {
  if (sessionEgressAllowed(sessionId)) return false;
  console.warn(`[taint] 오염 세션 EGRESS 차단(deny) session=${sessionId} channel='${channel}'`);
  return true;
}
