// `~/.claude/projects/<slug>/<uuid>.jsonl` 변화를 감지해 «이어받기 picker» / «최근 레포»
// 라우트의 캐시를 무효화한다.
//
// 옛 동작은 WS 로도 `claude_code_tail` / `claude_code_list_dirty` 를 broadcastAll 했지만
// iOS 의 LiveSessionView 와 그 소비 경로가 제거되면서 WS 푸시 쪽은 dead 가 됨. 내부 listener
// 패턴 (`onWatcherInvalidation`) 만 남겨 routes/recent.ts 와 routes/claude-code-sessions.ts
// 의 in-memory 캐시 staleness 를 막는다.
//
// ## Debounce
// jsonl 에 토큰이 흐르면 짧은 시간에 수십 번 write 가 일어난다. 매번 listener 를 부르면
// 캐시 무효화 + 재스캔 비용이 누적된다 — file 별로 250ms 디바운스.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const ROOT = path.join(os.homedir(), ".claude", "projects");
const TAIL_DEBOUNCE_MS = 250;
const LIST_DEBOUNCE_MS = 500;

/**
 * 외부 모듈이 watcher 의 invalidation 이벤트에 후킹할 수 있게 한다.
 * (예: claude-code-sessions 라우트가 디렉터리 스캔 결과를 캐시하다가 디렉터리가
 * 변동되면 무효화.)
 *
 * scope:
 *  - "tail": 특정 jsonl 파일 내용 변경. sessionId 알 수 있을 때.
 *  - "list": 디렉터리 구조 변동 (파일 생성/삭제). sessionId 불명.
 */
export type WatcherInvalidationListener = (
  scope: "tail" | "list",
  sessionId?: string,
) => void;

const listeners = new Set<WatcherInvalidationListener>();

export function onWatcherInvalidation(l: WatcherInvalidationListener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

function notify(scope: "tail" | "list", sessionId?: string): void {
  for (const l of listeners) {
    try {
      l(scope, sessionId);
    } catch (e) {
      // listener 의 실패가 watcher 자체를 죽이지 않게 격리.
      console.error("[cc-watcher] listener error:", (e as Error).message);
    }
  }
}

// 파일별 마지막 broadcast 타이머.
const tailTimers = new Map<string, NodeJS.Timeout>();
let listTimer: NodeJS.Timeout | null = null;

let watcher: fs.FSWatcher | null = null;

export type WatcherHandle = {
  stop: () => void;
};

export function startClaudeCodeWatcher(): WatcherHandle | null {
  if (!fs.existsSync(ROOT)) {
    console.log(`[cc-watcher] ${ROOT} 없음 — 데스크탑 Claude Code 가 설치되지 않은 상태. 건너뜀.`);
    return null;
  }

  try {
    // recursive: true 는 macOS/Windows 에서만 동작 (Linux 미지원).
    // PocketSisyphus 는 macOS daemon 이라 OK. 향후 Linux 지원 시 chokidar 등으로 교체.
    watcher = fs.watch(ROOT, { recursive: true }, (eventType, filename) => {
      if (!filename) return;
      handleChange(eventType, filename);
    });
    watcher.on("error", (err) => {
      console.error("[cc-watcher] error:", err.message);
    });
    console.log(`[cc-watcher] watching ${ROOT}`);
    return {
      stop: () => {
        watcher?.close();
        watcher = null;
        for (const t of tailTimers.values()) clearTimeout(t);
        tailTimers.clear();
        if (listTimer) clearTimeout(listTimer);
        listTimer = null;
      },
    };
  } catch (e) {
    console.error("[cc-watcher] failed to start:", (e as Error).message);
    return null;
  }
}

function handleChange(eventType: string, relPath: string): void {
  // relPath 모양: "<slug>/<uuid>.jsonl" 또는 "<slug>"
  // 파일 자체 변동인지 디렉터리/이름 변동인지 구분.
  const segments = relPath.split(path.sep);
  const isJsonl = segments.at(-1)?.endsWith(".jsonl") ?? false;

  if (isJsonl && eventType === "change") {
    // 파일 내용 변경 — tail event.
    const filename = segments.at(-1) ?? "";
    const sessionId = filename.replace(/\.jsonl$/, "");
    debounceTail(sessionId);
    return;
  }

  // 그 외 (rename, 신규 디렉터리, 파일 생성·삭제 등) → list dirty.
  // rename 은 jsonl 생성/삭제 양쪽에 다 emit 되므로 list refresh 가 적절.
  debounceListDirty();
}

function debounceTail(sessionId: string): void {
  const existing = tailTimers.get(sessionId);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => {
    tailTimers.delete(sessionId);
    notify("tail", sessionId);
  }, TAIL_DEBOUNCE_MS);
  tailTimers.set(sessionId, t);
}

function debounceListDirty(): void {
  if (listTimer) clearTimeout(listTimer);
  listTimer = setTimeout(() => {
    listTimer = null;
    notify("list");
  }, LIST_DEBOUNCE_MS);
}
