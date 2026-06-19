/**
 * Claude Code 데스크탑 세션 디스커버리 — `~/.claude/projects/<slug>/<uuid>.jsonl` 에서
 * 「이어받기」 후보 메타데이터를 뽑아 DesktopSessionSummary 배열로 돌려준다.
 *
 * 옛 위치: routes/claude-code-sessions.ts 안에 인라인. PR 1 (agent adapter 추상화) 에서
 * 라우트와 분리해 claude-code adapter 의 desktopWatcher() 가 노출하는 list() 의 구현이
 * 됨. 라우트 (routes/claude-code-sessions.ts, routes/desktop-sessions.ts) 는 이 모듈을
 * 직접 호출하지 않고 adapter.desktopWatcher().list() 경로로 접근.
 *
 * Cache 정책:
 *  - getScanCached: per-key (repo-scoped 또는 unscoped) 결과를 30s 까지 보관.
 *  - inspectionCache: filePath → 첫 user/cwd/branch summary. mtime 비교로 freshness 검증
 *    → 안 바뀐 파일은 256KB read + parse 회피.
 *  - 두 캐시 모두 watcher 의 onWatcherInvalidation 으로 무효화 (디렉터리 변동 / tail 변동).
 *  - STALE_GRACE_MS: 30s. watcher 가 recursive 모드 한계로 어떤 이벤트를 놓쳤어도
 *    그 시간 뒤엔 강제 재스캔.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type {
  DesktopAgentWatcher,
  DesktopListOptions,
  DesktopSessionSummary,
} from "../../types.js";
import { onWatcherInvalidation, startClaudeCodeWatcher } from "./watcher.js";

const STALE_GRACE_MS = 30_000;

type CacheEntry = { value: DesktopSessionSummary[]; computedAt: number };
const scanCache = new Map<string, CacheEntry>();

// watcher 이벤트로 캐시 전체 무효화 — 디렉터리 / 파일 변동 어느 쪽이든 결과 row 의
// mtime / turnCount 가 달라지므로 부분 무효화는 의미 없음.
onWatcherInvalidation(() => {
  scanCache.clear();
});

function getScanCached(
  key: string,
  compute: () => DesktopSessionSummary[],
): DesktopSessionSummary[] {
  const now = Date.now();
  const hit = scanCache.get(key);
  if (hit && now - hit.computedAt < STALE_GRACE_MS) {
    return hit.value;
  }
  const value = compute();
  scanCache.set(key, { value, computedAt: now });
  return value;
}

function scanAll(opts: DesktopListOptions): DesktopSessionSummary[] {
  const root = path.join(os.homedir(), ".claude", "projects");
  if (!fs.existsSync(root)) return [];
  const items: DesktopSessionSummary[] = [];
  const projectDirs = safeReadDir(root).filter((d) => d.isDirectory());
  for (const dir of projectDirs) {
    const slugDir = path.join(root, dir.name);
    const files = safeReadDir(slugDir).filter(
      (f) => f.isFile() && f.name.endsWith(".jsonl"),
    );
    for (const f of files) {
      const filePath = path.join(slugDir, f.name);
      const summary = inspectJsonl(filePath);
      if (!summary) continue;
      if (opts.repoPathFilter && summary.cwd !== opts.repoPathFilter) continue;
      items.push({
        sessionId: f.name.replace(/\.jsonl$/, ""),
        repoPath: summary.cwd,
        preview: summary.firstUserText,
        turnCount: summary.userTurnCount,
        // stat.mtimeMs 는 부동소수점 → JSON 디코딩 mismatch 회피 위해 round.
        lastActiveAt: Math.round(summary.mtimeMs),
        startedAt: summary.firstUserAt,
        gitBranch: summary.gitBranch,
      });
    }
  }
  items.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  return items;
}

type Summary = {
  cwd: string;
  firstUserText: string | null;
  firstUserAt: number | null;
  userTurnCount: number;
  gitBranch: string | null;
  mtimeMs: number;
};

const inspectionCache = new Map<string, Summary>();

// 디렉터리 구조가 바뀌면 (파일 삭제 등) stale 항목이 있을 수 있어 전체 청소.
// tail 이벤트는 mtime 검증으로 자연 무효화되므로 별도 처리 불필요.
onWatcherInvalidation((scope) => {
  if (scope === "list") {
    inspectionCache.clear();
  }
});

function inspectJsonl(filePath: string): Summary | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
  }
  // 캐시 hit & mtime 일치 → 즉시 반환 (256KB read + parse 회피).
  const cached = inspectionCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs) {
    return cached;
  }
  // 큰 파일은 전체 파싱 비용을 피하려고 앞 256KB 만 sampling — 첫 user 메시지 / cwd /
  // git branch 는 앞부분에서 잡히고, userTurnCount 는 근사치로 충분.
  const head = readSlice(filePath, 0, Math.min(256 * 1024, stat.size));
  if (!head) return null;

  let cwd: string | null = null;
  let firstUserText: string | null = null;
  let firstUserAt: number | null = null;
  let userTurnCount = 0;
  let gitBranch: string | null = null;

  for (const line of head.split("\n")) {
    if (!line.trim()) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!cwd && typeof obj.cwd === "string" && (obj.cwd as string).length > 0) {
      cwd = obj.cwd as string;
    }
    if (!gitBranch && typeof obj.gitBranch === "string") {
      gitBranch = obj.gitBranch as string;
    }
    if (obj.type === "user") {
      userTurnCount++;
      if (firstUserText === null) {
        const text = extractUserText(obj);
        if (text) {
          firstUserText = truncate(text, 140);
          if (typeof obj.timestamp === "string") {
            const t = Date.parse(obj.timestamp);
            if (!Number.isNaN(t)) firstUserAt = t;
          }
        }
      }
    }
  }
  if (!cwd) return null;
  const summary: Summary = {
    cwd,
    firstUserText,
    firstUserAt,
    userTurnCount,
    gitBranch,
    mtimeMs: stat.mtimeMs,
  };
  inspectionCache.set(filePath, summary);
  return summary;
}

function extractUserText(obj: Record<string, unknown>): string | null {
  // jsonl 의 user 행은 다양한 모양: { message: { content: "..." | [{text:...}] } } 등.
  const msg = obj.message as Record<string, unknown> | undefined;
  const content = msg?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const block of content as Array<Record<string, unknown>>) {
      if (typeof block?.text === "string") return block.text as string;
    }
  }
  // 평면 형태도 시도
  if (typeof obj.text === "string") return obj.text as string;
  return null;
}

function readSlice(filePath: string, offset: number, length: number): string | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(length);
    const n = fs.readSync(fd, buf, 0, length, offset);
    return buf.subarray(0, n).toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

function safeReadDir(p: string): fs.Dirent[] {
  try {
    return fs.readdirSync(p, { withFileTypes: true });
  } catch {
    return [];
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "…";
}

/**
 * claudeCodeAdapter.desktopWatcher() 가 반환하는 객체. 라우트와 다른 호출자는 이걸 통해서만
 * scanAll / watcher 에 접근한다.
 */
export const claudeCodeDesktopWatcher: DesktopAgentWatcher = {
  list(opts: DesktopListOptions): DesktopSessionSummary[] {
    const key = opts.repoPathFilter ? `repo:${opts.repoPathFilter}` : "all";
    return getScanCached(key, () => scanAll(opts));
  },
  start(onInvalidate): () => void {
    // 외부에서 받은 listener 를 onWatcherInvalidation 으로 등록 + start 한 watcher 의
    // 정리 함수를 그대로 노출. 이 모듈 내부의 listener (scanCache / inspectionCache 무효화) 는
    // 모듈 import 시점에 이미 등록돼 있다.
    const off = onWatcherInvalidation((scope, sessionId) => {
      onInvalidate(scope, sessionId);
    });
    const handle = startClaudeCodeWatcher();
    return () => {
      off();
      handle?.stop();
    };
  },
};
