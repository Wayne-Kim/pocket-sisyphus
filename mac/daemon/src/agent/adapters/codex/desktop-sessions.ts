/**
 * codex 데스크탑 세션 디스커버리 — `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` 에서
 * 이어받기 후보 메타데이터를 추출한다.
 *
 * 파일 레이아웃:
 *   ~/.codex/sessions/2026/03/03/rollout-2026-03-03T22-39-01-<uuid>.jsonl
 *
 * 각 jsonl 의 첫 줄은 `{"type":"session_meta","payload":{"id":"<uuid>","cwd":"…","timestamp":"…"}}`.
 * 두 번째 줄부터는 response_item / event_msg — 그 중 role:user 인 response_item 의 input_text
 * 가 사용자 입력. 단 codex 가 자체적으로 주입하는 boilerplate (AGENTS.md / environment_context
 * / permissions instructions) 은 preview / turn 계산에서 제외한다.
 *
 * 성능: 캐시 30s + watcher 무효화. 첫 N KB 만 읽어 session_meta + 첫 실제 user 메시지만
 * 뽑는다 — 한 파일이 수백 KB ~ 수 MB 까지 커지므로 전체 스캔은 비효율.
 */
import fs from "node:fs";
import path from "node:path";
import type {
  DesktopAgentWatcher,
  DesktopListOptions,
  DesktopSessionSummary,
} from "../../types.js";
import {
  CODEX_SESSIONS_DIR,
  onCodexWatcherInvalidation,
  startCodexWatcher,
} from "./watcher.js";

const STALE_GRACE_MS = 30_000;
/**
 * 한 jsonl 파일에서 preview/메타 추출 시 읽는 최대 바이트. session_meta + 초반 user
 * 메시지 몇 개면 충분 — 사용자가 첫 turn 에서 수 MB 의 입력을 붙여 넣는 경우는 드물고,
 * 그런 경우라도 preview 가 잘리는 것은 허용 가능.
 */
const PER_FILE_MAX_BYTES = 256 * 1024;
/**
 * 디스크에서 한 번에 후보로 올릴 최대 파일 수. 사용자가 codex 를 수년 써 누적 jsonl 이
 * 만 개 단위가 되면 전체 파싱은 비용이 큼 — mtime 기준 상위 N 개만.
 */
const MAX_FILES = 200;

type CacheEntry = { value: DesktopSessionSummary[]; computedAt: number };
let cached: CacheEntry | null = null;

onCodexWatcherInvalidation(() => {
  cached = null;
});

type ParsedFile = {
  sessionId: string;
  cwd: string;
  startedAt: number | null;
  lastActiveAt: number;
  preview: string | null;
  turnCount: number;
};

function listJsonlFiles(): { path: string; mtime: number }[] {
  if (!fs.existsSync(CODEX_SESSIONS_DIR)) return [];
  const out: { path: string; mtime: number }[] = [];
  // recursive 디렉터리 트리 워크. 디렉터리 자체가 YYYY/MM/DD 라 깊이 3 이하.
  const stack: string[] = [CODEX_SESSIONS_DIR];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(full);
      } else if (e.isFile() && e.name.endsWith(".jsonl")) {
        try {
          const stat = fs.statSync(full);
          out.push({ path: full, mtime: stat.mtimeMs });
        } catch {
          // 파일이 사라지는 경쟁 케이스 — 무시.
        }
      }
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, MAX_FILES);
}

function parseFile(filePath: string, mtimeMs: number): ParsedFile | null {
  const buf = readHead(filePath, PER_FILE_MAX_BYTES);
  if (!buf) return null;

  let sessionId = "";
  let cwd = "";
  let startedAt: number | null = null;
  let preview: string | null = null;
  let turnCount = 0;

  let lineStart = 0;
  for (let i = 0; i <= buf.length; i++) {
    if (i < buf.length && buf[i] !== 0x0a) continue;
    const line = buf.subarray(lineStart, i).toString("utf8").trim();
    lineStart = i + 1;
    if (!line) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line);
    } catch {
      // 우리가 cap 으로 자르다 마지막 줄이 잘렸을 수 있음 — 그냥 스킵.
      continue;
    }
    const type = obj.type;
    const payload = obj.payload as Record<string, unknown> | undefined;
    if (!payload) continue;
    if (type === "session_meta") {
      const id = payload.id;
      const c = payload.cwd;
      if (typeof id === "string") sessionId = id;
      if (typeof c === "string") cwd = c;
      const ts = parseIso(payload.timestamp);
      if (ts !== null) startedAt = ts;
    } else if (type === "response_item") {
      const role = (payload as { role?: unknown }).role;
      if (role !== "user") continue;
      const content = (payload as { content?: unknown }).content;
      if (!Array.isArray(content)) continue;
      const text = extractFirstText(content);
      if (!text || isBoilerplate(text)) continue;
      turnCount++;
      if (preview === null) preview = truncate(text, 140);
    }
  }

  if (!sessionId || !cwd) return null;
  return {
    sessionId,
    cwd,
    startedAt,
    lastActiveAt: mtimeMs,
    preview,
    turnCount,
  };
}

/**
 * codex 가 자체적으로 user role 로 주입하는 boilerplate 메시지를 걸러낸다. AGENTS.md
 * instructions / environment_context / permissions instructions 가 매 세션 첫 user
 * message 들로 들어가는데 — 사용자 입력이 아니므로 preview / turn count 에서 제외.
 */
function isBoilerplate(text: string): boolean {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("<environment_context>")) return true;
  if (trimmed.startsWith("<permissions instructions>")) return true;
  if (trimmed.startsWith("# AGENTS.md")) return true;
  return false;
}

function extractFirstText(content: unknown[]): string | null {
  for (const c of content) {
    if (!c || typeof c !== "object") continue;
    const obj = c as { type?: unknown; text?: unknown };
    if (
      (obj.type === "input_text" || obj.type === "text") &&
      typeof obj.text === "string"
    ) {
      return obj.text;
    }
  }
  return null;
}

function parseIso(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

function scanAll(): DesktopSessionSummary[] {
  const files = listJsonlFiles();
  const items: DesktopSessionSummary[] = [];
  for (const f of files) {
    const parsed = parseFile(f.path, f.mtime);
    if (!parsed) continue;
    items.push({
      sessionId: parsed.sessionId,
      repoPath: parsed.cwd,
      preview: parsed.preview,
      turnCount: parsed.turnCount > 0 ? parsed.turnCount : null,
      lastActiveAt: parsed.lastActiveAt,
      startedAt: parsed.startedAt,
      // codex 는 git branch 안 기록.
      gitBranch: null,
    });
  }
  items.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  return items;
}

function getCached(): DesktopSessionSummary[] {
  const now = Date.now();
  if (cached && now - cached.computedAt < STALE_GRACE_MS) {
    return cached.value;
  }
  const value = scanAll();
  cached = { value, computedAt: now };
  return value;
}

function readHead(filePath: string, length: number): Buffer | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(length);
    const n = fs.readSync(fd, buf, 0, length, 0);
    return buf.subarray(0, n);
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

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "…";
}

export const codexDesktopWatcher: DesktopAgentWatcher = {
  list(opts: DesktopListOptions): DesktopSessionSummary[] {
    const all = getCached();
    if (!opts.repoPathFilter) return all;
    return all.filter((s) => s.repoPath === opts.repoPathFilter);
  },
  start(onInvalidate): () => void {
    const off = onCodexWatcherInvalidation(() => {
      onInvalidate("list");
    });
    const handle = startCodexWatcher();
    return () => {
      off();
      handle?.stop();
    };
  },
};
