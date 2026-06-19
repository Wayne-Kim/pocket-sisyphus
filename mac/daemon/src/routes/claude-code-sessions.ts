/**
 * `/api/claude-code-sessions` — claude_code 전용 데스크탑 세션 디스커버리 라우트.
 *
 * 옛 모놀리식 구현 (~/.claude/projects 직접 스캔 + 캐시) 은 claude-code adapter 의
 * desktopWatcher() 안으로 흡수됐다. 이 라우트는 그 adapter 를 호출하는 얇은 wrapper.
 *
 * 새 코드는 `/api/agents/:agentId/desktop-sessions` (generic) 를 쓰는 게 권장. 이 라우트는
 * iOS 구버전 호환을 위해 유지 — 같은 데이터를 같은 JSON shape 으로 돌려준다.
 */
import { Hono } from "hono";
import { bearerAuth } from "../auth.js";
import { getAgent } from "../agent/registry.js";
import type { DesktopSessionSummary } from "../agent/types.js";

export const claudeCodeSessions = new Hono();
claudeCodeSessions.use("*", bearerAuth);

const MAX_RESULTS = 50;

claudeCodeSessions.get("/", (c) => {
  const repoPath = c.req.query("repoPath");
  if (!repoPath) return c.json({ error: "repoPath required" }, 400);
  const adapter = getAgent("claude_code");
  const watcher = adapter.desktopWatcher?.();
  if (!watcher) return c.json({ sessions: [] });
  const rows = watcher.list({ repoPathFilter: repoPath }).slice(0, MAX_RESULTS);
  return c.json({ sessions: rows.map(toLegacyIosShape) });
});

/**
 * iOS 의 `ClaudeCodeSession` (Codable) 은 `preview: String` 비-nullable, `turnCount: Int`
 * 비-nullable 로 디코드한다. adapter 의 `DesktopSessionSummary` 는 nullable 쪽으로 통일된
 * 새 shape — 옛 iOS 호환을 위해 여기서 fallback 을 박는다.
 */
function toLegacyIosShape(s: DesktopSessionSummary): {
  sessionId: string;
  repoPath: string;
  preview: string;
  turnCount: number;
  lastActiveAt: number;
  startedAt: number | null;
  gitBranch: string | null;
} {
  return {
    sessionId: s.sessionId,
    repoPath: s.repoPath,
    preview: s.preview ?? "(첫 user 메시지 없음)",
    turnCount: s.turnCount ?? 0,
    lastActiveAt: s.lastActiveAt,
    startedAt: s.startedAt,
    gitBranch: s.gitBranch,
  };
}
