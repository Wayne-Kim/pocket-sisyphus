/**
 * 무인 trifecta 하드 차단 게이트 (CAPABILITY_CAPS.md §C1/M3) — IO 를 거치는 «상태 의존» 부분.
 *
 * 정본 불변식: 한 무인 실행 단위(cron tick · 워크플로우 run · skip_permissions · PO 무인 구현)
 * 에서 EGRESS·SOURCE_WRITE 클래스 MCP 도구는 «연결돼 있으면 안 된다». 두 방향으로 강제:
 *
 *  1) 실행 시작 직전(런타임 fail-closed): guardUnattendedRepo(repoPath) — repo `.mcp.json` 에
 *     캡 대상/정체불명 MCP 가 박혀 있으면 «정적 거부»(세션을 아예 안 띄움). 공유 repo(cron)는
 *     파일을 안전하게 못 깎으므로 «거부» 가 최후 방어선이다.
 *  2) 설정 단계(config-phase): repoHasUnattendedAutomation(repoPath) — repo 에 무인 자동화가
 *     이미 있으면, 그 위에 캡 대상 MCP 를 새로 «붙이는» 것 자체를 라우트가 거부한다.
 *
 * 두 게이트가 만나, taint 소스(개인-데이터 MCP)와 EGRESS 가 무인 단위에서 «동시 활성» 이 되는
 * 경로를 양쪽에서 막는다. 분류는 순수 모듈 mcp/policy.ts, `.mcp.json` 읽기는 mcp/native.ts.
 */
import { db } from "../db/index.js";
import { listServers } from "./store.js";
import { cappedMcpJsonKeys, materializeUnattendedMcpJson } from "./native.js";
import { UNATTENDED_TRIFECTA_DENIED } from "./policy.js";

export type UnattendedGuardResult =
  | { ok: true }
  | { ok: false; code: typeof UNATTENDED_TRIFECTA_DENIED; capped: string[] };

/**
 * 이 repo 의 `.mcp.json` 에 무인 경로에서 미연결돼야 할(EGRESS·SOURCE_WRITE·정체불명) MCP 가
 * 박혀 있으면 거부. 디스크의 실제 `.mcp.json` 을 정본으로 본다(손편집·orphan 까지 fail-closed).
 * 캡 대상이 없으면 ok — MCP 가 없는 절대다수 repo 는 영향 0(회귀 0).
 */
export function guardUnattendedRepo(repoPath: string): UnattendedGuardResult {
  const capped = cappedMcpJsonKeys(repoPath, listServers());
  if (capped.length === 0) return { ok: true };
  console.warn(
    `[caps] 무인 trifecta 차단 — repo=${repoPath} 에 캡 대상 MCP 연결됨(미연결 필요): ${capped.join(", ")}`,
  );
  return { ok: false, code: UNATTENDED_TRIFECTA_DENIED, capped };
}

/**
 * 무인 세션을 띄우기 직전, 그 실행 cwd 의 MCP 노출을 §C1/M3·C2 로 안전화한다.
 *  - isolated(per-run worktree): 그 worktree `.mcp.json` 을 READ/LOCAL 만 남게 다시 써서(EGRESS-
 *    free 격리) 세션이 캡 대상 도구를 «미연결» 로 시작하게 한다. 항상 ok.
 *  - 공유 repo(cron·worktree 없는 워크플로우 run): 같은 파일을 대화형 세션이 읽으므로 안전하게
 *    못 깎는다 → 캡 대상이 있으면 fail-closed 로 «정적 거부»(세션을 아예 안 띄움).
 */
export function prepareUnattendedCwd(cwd: string, opts: { isolated: boolean }): UnattendedGuardResult {
  if (opts.isolated) {
    const removed = materializeUnattendedMcpJson(cwd, listServers());
    if (removed.length > 0) {
      console.warn(
        `[caps] 격리 worktree .mcp.json 에서 캡 대상 MCP 미연결 처리: ${removed.join(", ")} (cwd=${cwd})`,
      );
    }
    return { ok: true };
  }
  return guardUnattendedRepo(cwd);
}

/**
 * 이 repo 에 «무인 자동화» 가 하나라도 등록돼 있는가 — 캡 대상 MCP 신규 등록을 거부할지 판정.
 * 무인 자동화 = enabled cron job · enabled 워크플로우 트리거(cron/github 자동발화) · 주기 PO 수집.
 * 수동(manual) 워크플로우 트리거는 사람이 누르는 거라 «무인» 으로 세지 않는다.
 */
export function repoHasUnattendedAutomation(repoPath: string): boolean {
  const d = db();
  const cron = d
    .prepare(`SELECT 1 FROM cron_jobs WHERE repo_path = ? AND enabled = 1 LIMIT 1`)
    .get(repoPath);
  if (cron) return true;

  const trig = d
    .prepare(
      `SELECT 1 FROM workflow_triggers
        WHERE repo_path = ? AND enabled = 1 AND kind IN ('cron','github') LIMIT 1`,
    )
    .get(repoPath);
  if (trig) return true;

  const po = d
    .prepare(`SELECT 1 FROM po_profiles WHERE repo_path = ? AND schedule IS NOT NULL LIMIT 1`)
    .get(repoPath);
  return !!po;
}
