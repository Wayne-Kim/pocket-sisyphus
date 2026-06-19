// copilot(GitHub Copilot CLI) 데이터 디렉터리(`~/.copilot`)의 SQLite 세션 스토어 변화를
// 감지해 «이어받기 picker» 라우트 캐시를 무효화한다.
//
// opencode 의 watcher 와 «형태» 가 같다 — copilot 도 모든 세션을 단일 SQLite DB
// (`session-store.db` + WAL/SHM)에 담는다(claude/qwen 의 per-file jsonl 패턴이 아님). 그래서
// 데이터 디렉터리를 «non-recursive» 로 보고, 파일명이 `session-store.db*` 인 변동만 잡아
// 캐시를 비운다.
//   - WAL 모드라 세션이 흐르는 동안 `session-store.db-wal` 이 빈번히 갱신된다 → 디바운스.
//   - 세션별 «tail» 개념이 없다(DB 가 파일 단위로 안 쪼개짐) → scope 는 항상 "list".
//     (agy/opencode 와 같은 경계: 이어받기 디스커버리는 지원 / 라이브 본문 tail 은 미지원.)
//
// WS 푸시는 없다 (iOS LiveSessionView 제거 이후 dead). 내부 listener 패턴만 남겨
// routes/desktop-sessions 의 in-memory 캐시 staleness 를 막는다 (claude/qwen/opencode 와 동일).

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * copilot CLI 데이터 디렉터리 — macOS 에서 copilot 은 `~/.copilot` 아래에 세션·로그·설정을
 * 둔다. 경로가 향후 바뀔 가능성에 대비해 상수화 (브리프 엣지케이스: 경로 변동 시 부재로
 * 조용히 빈 결과).
 */
export const COPILOT_DIR = path.join(os.homedir(), ".copilot");
/** 모든 세션 메타가 담긴 단일 SQLite DB. desktop-sessions.ts 가 read-only 로 연다. */
export const COPILOT_DB_PATH = path.join(COPILOT_DIR, "session-store.db");

const LIST_DEBOUNCE_MS = 500;

/**
 * scope:
 *  - "list": DB(세션 스토어) 변동. copilot 은 세션별 파일이 없어 tail 개념이 없다 →
 *    항상 "list". (인터페이스 호환을 위해 시그니처는 claude/qwen/opencode 와 동일하게 유지.)
 */
export type WatcherInvalidationListener = (
  scope: "tail" | "list",
  sessionId?: string,
) => void;

const listeners = new Set<WatcherInvalidationListener>();

export function onCopilotWatcherInvalidation(
  l: WatcherInvalidationListener,
): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

function notify(scope: "tail" | "list", sessionId?: string): void {
  for (const l of listeners) {
    try {
      l(scope, sessionId);
    } catch (e) {
      // listener 의 실패가 watcher 자체를 죽이지 않게 격리.
      console.error("[copilot-watcher] listener error:", (e as Error).message);
    }
  }
}

let listTimer: NodeJS.Timeout | null = null;
let watcher: fs.FSWatcher | null = null;

export type WatcherHandle = {
  stop: () => void;
};

/**
 * fs.watch 시작. 데이터 디렉터리가 아직 없으면 (copilot 을 한 번도 안 돌린 상태) null 반환 —
 * 사용자가 copilot 을 처음 쓰면 daemon 재시작 시 자연스럽게 잡힌다 (claude/qwen/opencode
 * watcher 와 같은 정책: 부모를 watch 해 후속 생성을 감지하는 비용은 낭비).
 */
export function startCopilotWatcher(): WatcherHandle | null {
  if (!fs.existsSync(COPILOT_DIR)) {
    console.log(
      `[copilot-watcher] ${COPILOT_DIR} 없음 — 데스크탑 copilot 이 실행된 적 없는 상태. 건너뜀.`,
    );
    return null;
  }

  try {
    // 단일 DB 스토어라 recursive 불필요 — 데이터 디렉터리 직속의 `session-store.db*` 변동만 본다.
    watcher = fs.watch(COPILOT_DIR, (_eventType, filename) => {
      if (!filename) return;
      // session-store.db / -wal / -shm 만 관심. logs/·session-state/·config.json 등은 무시.
      const base = filename.split(path.sep).at(-1) ?? "";
      if (!base.startsWith("session-store.db")) return;
      debounceListDirty();
    });
    watcher.on("error", (err) => {
      console.error("[copilot-watcher] error:", err.message);
    });
    console.log(`[copilot-watcher] watching ${COPILOT_DIR}`);
    return {
      stop: () => {
        watcher?.close();
        watcher = null;
        if (listTimer) clearTimeout(listTimer);
        listTimer = null;
      },
    };
  } catch (e) {
    console.error("[copilot-watcher] failed to start:", (e as Error).message);
    return null;
  }
}

function debounceListDirty(): void {
  if (listTimer) clearTimeout(listTimer);
  listTimer = setTimeout(() => {
    listTimer = null;
    notify("list");
  }, LIST_DEBOUNCE_MS);
}
