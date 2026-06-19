import { Hono } from "hono";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { bearerAuth } from "../auth.js";
import { onWatcherInvalidation } from "../agent/adapters/claude-code/watcher.js";

export const recent = new Hono();

recent.use("*", bearerAuth);

type Entry = {
  path: string;        // 실제 cwd (예: /Users/foo/Projects/bar)
  lastUsedAt: number;  // ms epoch — 가장 최근 jsonl mtime
  sessionCount: number;
};

/**
 * 결과 캐시. recent-projects 는 SessionsView 가 진입 시마다 / 폴링 시 호출하는데,
 * 매번 ~/.claude/projects/ 전체를 readdir + statSync + readFile 하면 N (~수십) 파일에
 * 대해 ms 단위 cost 가 쌓인다 (측정: ~3ms/req, 다른 엔드포인트의 ~40배).
 *
 * 무효화: claude-code-watcher 가 jsonl 디렉터리 변동을 push 해 줌. 변동 없으면 캐시 유지.
 * 안전망 STALE_GRACE_MS — watcher 가 어떤 이벤트를 놓쳤어도 30s 안에 재계산.
 */
let cachedResult: Entry[] | null = null;
let cachedAt = 0;
const STALE_GRACE_MS = 30_000;

onWatcherInvalidation(() => {
  cachedResult = null;
});

/** ~/.claude/projects/* 를 스캔해서 최근 사용 프로젝트 목록을 돌려준다. */
recent.get("/", (c) => {
  const now = Date.now();
  if (cachedResult && now - cachedAt < STALE_GRACE_MS) {
    return c.json({ projects: cachedResult });
  }
  const projects = computeRecent();
  cachedResult = projects;
  cachedAt = now;
  return c.json({ projects });
});

function computeRecent(): Entry[] {
  const root = path.join(os.homedir(), ".claude", "projects");
  if (!fs.existsSync(root)) return [];

  const entries: Entry[] = [];
  let dirs: fs.Dirent[];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const slugDir = path.join(root, d.name);
    let files: string[];
    try {
      files = fs.readdirSync(slugDir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    if (files.length === 0) continue;

    // mtime 가장 최신 파일
    let newestMtime = 0;
    let newestFile: string | null = null;
    for (const f of files) {
      try {
        const stat = fs.statSync(path.join(slugDir, f));
        const t = stat.mtimeMs;
        if (t > newestMtime) {
          newestMtime = t;
          newestFile = f;
        }
      } catch {
        // 무시
      }
    }
    if (!newestFile) continue;

    const cwd = readCwdFromJsonl(path.join(slugDir, newestFile));
    if (!cwd) continue;

    entries.push({
      path: cwd,
      lastUsedAt: Math.round(newestMtime),
      sessionCount: files.length,
    });
  }

  // 중복 path 합치기 (slug 충돌 가능)
  const dedup = new Map<string, Entry>();
  for (const e of entries) {
    const cur = dedup.get(e.path);
    if (!cur || cur.lastUsedAt < e.lastUsedAt) {
      dedup.set(e.path, e);
    } else {
      cur.sessionCount += e.sessionCount;
    }
  }

  return Array.from(dedup.values())
    .filter((e) => existsSyncSafe(e.path))
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
    .slice(0, 30);
}

function readCwdFromJsonl(filePath: string): string | null {
  // 첫 ~50KB만 읽어서 cwd 가 있는 첫 줄을 찾는다.
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(64 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const text = buf.subarray(0, n).toString("utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (typeof obj?.cwd === "string" && obj.cwd.length > 0) {
          return obj.cwd as string;
        }
      } catch {
        // 끊긴 줄(마지막) 또는 비-JSON, 무시
      }
    }
  } catch {
    // 무시
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // 무시
      }
    }
  }
  return null;
}

function existsSyncSafe(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}
