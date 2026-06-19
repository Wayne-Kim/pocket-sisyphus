/**
 * `/api/agents` — 코드 에이전트 CLI 의 generic 라우트 집합.
 *
 *   GET /api/agents                                      → 등록된 모든 agent 의 메타
 *   GET /api/agents/:agentId/desktop-sessions?repoPath=… → 해당 agent 의 이어받기 후보
 *
 * 옛 `/api/claude-code-sessions` 는 claude_code 만 알았고, 옛 iOS 빌드 호환을 위해 alias
 * 로 살아남는다 (routes/claude-code-sessions.ts). 신규 iOS 빌드는 이 라우트 집합만 호출.
 *
 * 응답 shape 은 adapter 의 raw DesktopSessionSummary 그대로 — preview / turnCount 가 null
 * 가능. 클라이언트가 null 일 때 "(미리보기 없음)" 같은 fallback 을 그린다.
 */
import { Hono } from "hono";
import { bearerAuth } from "../auth.js";
import { getAgent, hasAgent, listAgents } from "../agent/registry.js";

export const desktopSessions = new Hono();
desktopSessions.use("*", bearerAuth);

const MAX_RESULTS = 50;

/**
 * GET /api/agents — 등록된 모든 adapter 의 메타. iOS picker 가 부팅 시 한 번 호출해 동적
 * 으로 노출 (옛 하드코드 CodingTool enum 대체). 옛 iOS 빌드는 이 라우트를 모르므로 호출
 * 안 함 — 그래도 POST /api/sessions 의 agent default 가 claude_code 라 동작 유지.
 *
 * `installed`: 해당 CLI 가 시스템에 있는지 (resolveBinary 가 throw 안 하는지). iOS picker 가
 * 미설치 agent 를 「설정 필요」 로 표시하고 생성 버튼을 막아, 사용자가 미설치 CLI 로 세션을
 * 만들고 첫 메시지에서 silent failure (resolve-binary.ts 주석 참고) 를 밟는 걸 사전 차단한다.
 * 미설치일 때만 `installHint` (설치 명령/URL) 도 동봉. 옛 daemon 은 이 필드들을 안 보내므로
 * iOS 는 누락 시 「설치됨」 으로 간주 (기존 동작 유지).
 *
 * 비용: 미설치 agent 마다 resolveBinary 가 `zsh -l -c command -v` 를 한 번 spawn (login
 * shell 소싱). 설치된 agent 는 existsSync 한 번으로 즉답. 피커 1회 로드용이라 허용.
 */
desktopSessions.get("/", (c) => {
  const rows = listAgents().map((a) => {
    let installed = true;
    try {
      a.resolveBinary();
    } catch {
      installed = false;
    }
    return {
      id: a.id,
      displayName: a.displayName,
      capabilities: a.capabilities(),
      installed,
      ...(installed ? {} : { installHint: a.installHint ?? null }),
    };
  });
  return c.json({ agents: rows });
});

/**
 * URL 예: GET /api/agents/claude_code/desktop-sessions?repoPath=/Users/foo/bar
 * - 미지원 agent id → 404
 * - desktopWatcher 미지원 (해당 agent 가 디스커버리 자체를 안 함) → { sessions: [] }
 */
desktopSessions.get("/:agentId/desktop-sessions", (c) => {
  const agentId = c.req.param("agentId");
  if (!hasAgent(agentId)) {
    return c.json({ error: `unknown agent: ${agentId}` }, 404);
  }
  const adapter = getAgent(agentId);
  const watcher = adapter.desktopWatcher?.();
  if (!watcher) {
    return c.json({ sessions: [] });
  }
  const repoPath = c.req.query("repoPath") || undefined;
  const rows = watcher.list({ repoPathFilter: repoPath }).slice(0, MAX_RESULTS);
  return c.json({ sessions: rows });
});
