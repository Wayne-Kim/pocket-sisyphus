/**
 * agy 데스크탑 세션 디스커버리 — `~/.gemini/antigravity-cli/history.jsonl` 에서 이어받기
 * 후보 메타데이터를 추출한다.
 *
 * 왜 history.jsonl 인가:
 * - agy 의 conversation 본문은 `~/.gemini/antigravity-cli/conversations/<uuid>.pb` 에
 *   protobuf-like 사설 컨테이너로 저장돼 우리가 디코드할 수 없다 (magic byte 가 표준
 *   protobuf 와 다르고 바이트 분포가 랜덤 — 암호화/난독화).
 * - 다행히 history.jsonl 에 사용자 입력의 평문 메타가 그대로 들어간다:
 *     {"display":"…", "timestamp":…, "workspace":"…", "conversationId":"…"}
 *   conversationId 별로 group-by 하면 claude jsonl 에서 추출하던 정보의 user-side
 *   subset 을 그대로 얻는다 — 첫 user 메시지 미리보기 / cwd / turn count / mtime.
 *
 * Live tail (read-only 관전) 은 지원 X — history.jsonl 에는 어시스턴트 응답이 없고
 * .pb 는 우리가 못 읽음. 어차피 iOS LiveSessionView 자체가 제거됐으므로 영향 0.
 */
import fs from "node:fs";
import type {
  DesktopAgentWatcher,
  DesktopListOptions,
  DesktopSessionSummary,
} from "../../types.js";
import {
  AGY_HISTORY_PATH,
  onAgyWatcherInvalidation,
  startAgyWatcher,
} from "./watcher.js";

const STALE_GRACE_MS = 30_000;
/**
 * history.jsonl 파일이 무한 성장 가능 — 한 번 읽을 때 최대 이만큼만 read. 한 line ≈
 * 100~300B 이라 4MB 면 수만 line, 사용자가 보통 가질 turn 수 (수백) 의 넉넉 cap.
 */
const HISTORY_MAX_BYTES = 4 * 1024 * 1024;

type CacheEntry = { value: DesktopSessionSummary[]; computedAt: number };
let cached: CacheEntry | null = null;

// watcher 가 history.jsonl 변동 push 하면 캐시 무효화 — 모듈 import 시 1회 등록.
onAgyWatcherInvalidation(() => {
  cached = null;
});

/**
 * history.jsonl 의 모든 entry 를 읽어 conversationId 별로 group 한다. 각 group 이 한
 * 데스크탑 세션. workspace 가 group 안에서 일관되지 않을 가능성은 무시하고 첫 entry 의
 * 값을 권위로.
 */
function scanAll(): DesktopSessionSummary[] {
  if (!fs.existsSync(AGY_HISTORY_PATH)) return [];

  let stat: fs.Stats;
  try {
    stat = fs.statSync(AGY_HISTORY_PATH);
  } catch {
    return [];
  }

  // 파일 끝에서 cap 만큼만 읽는다 (옛 entry 가 너무 많으면 어차피 사용자에게 의미 0).
  const readSize = Math.min(stat.size, HISTORY_MAX_BYTES);
  const sliceStart = stat.size - readSize;
  const buf = readSliceBuf(AGY_HISTORY_PATH, sliceStart, readSize);
  if (!buf) return [];

  // tail mode 라 첫 줄이 짤렸을 수 있음 — 첫 \n 까지 스킵.
  let lineStart = 0;
  if (sliceStart > 0) {
    const firstNewline = buf.indexOf(0x0a);
    if (firstNewline < 0) return [];
    lineStart = firstNewline + 1;
  }

  type Group = {
    conversationId: string;
    workspace: string;
    firstDisplay: string;
    firstTs: number;
    lastTs: number;
    count: number;
  };
  const groups = new Map<string, Group>();

  for (let i = lineStart; i < buf.length; i++) {
    if (buf[i] !== 0x0a) continue;
    const line = buf.subarray(lineStart, i).toString("utf8").trim();
    lineStart = i + 1;
    if (!line) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const cid = obj.conversationId;
    if (typeof cid !== "string" || cid.length === 0) continue;
    const ws = typeof obj.workspace === "string" ? obj.workspace : "";
    const display = typeof obj.display === "string" ? obj.display : "";
    const ts = typeof obj.timestamp === "number" ? obj.timestamp : 0;

    const existing = groups.get(cid);
    if (existing) {
      if (ts > existing.lastTs) existing.lastTs = ts;
      if (ts > 0 && ts < existing.firstTs) {
        existing.firstTs = ts;
        existing.firstDisplay = display;
      }
      existing.count++;
    } else {
      groups.set(cid, {
        conversationId: cid,
        workspace: ws,
        firstDisplay: display,
        firstTs: ts || Number.MAX_SAFE_INTEGER,
        lastTs: ts,
        count: 1,
      });
    }
  }

  const items: DesktopSessionSummary[] = [];
  for (const g of groups.values()) {
    if (!g.workspace) continue;
    items.push({
      sessionId: g.conversationId,
      repoPath: g.workspace,
      preview: g.firstDisplay ? truncate(g.firstDisplay, 140) : null,
      turnCount: g.count,
      lastActiveAt: g.lastTs,
      startedAt: g.firstTs === Number.MAX_SAFE_INTEGER ? null : g.firstTs,
      // agy 는 git branch 안 기록.
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

function readSliceBuf(filePath: string, offset: number, length: number): Buffer | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(length);
    const n = fs.readSync(fd, buf, 0, length, offset);
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

export const agyDesktopWatcher: DesktopAgentWatcher = {
  list(opts: DesktopListOptions): DesktopSessionSummary[] {
    const all = getCached();
    if (!opts.repoPathFilter) return all;
    return all.filter((s) => s.repoPath === opts.repoPathFilter);
  },
  start(onInvalidate): () => void {
    // 외부 listener 등록 + fs.watch 시작. 내부 listener (캐시 무효화) 는 모듈 import
    // 시점에 이미 등록되어 있다.
    const off = onAgyWatcherInvalidation(() => {
      onInvalidate("list");
    });
    const handle = startAgyWatcher();
    return () => {
      off();
      handle?.stop();
    };
  },
};
