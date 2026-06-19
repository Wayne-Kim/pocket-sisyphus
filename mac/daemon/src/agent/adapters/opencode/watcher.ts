// opencode 데이터 디렉터리(`~/.local/share/opencode`)의 SQLite 스토어 변화를 감지해
// local_llm(Qwen Code) / claude 와 같은 «이어받기 picker» 라우트 캐시를 무효화한다.
//
// claude / qwen 의 watcher 와 «형태» 는 같지만 감시 대상이 다르다 — claude/qwen 은 세션별
// jsonl 파일(프로젝트 디렉터리 트리)을 recursive watch 하지만, opencode(v1.17+)는 모든
// 세션을 단일 SQLite DB(`opencode.db` + WAL/SHM)에 담는다. 그래서 데이터 디렉터리를
// «non-recursive» 로 보고, 파일명이 `opencode.db*` 인 변동만 잡아 캐시를 비운다.
//   - WAL 모드라 세션이 흐르는 동안 `opencode.db-wal` 이 빈번히 갱신된다 → 디바운스.
//   - 세션별 «tail» 개념이 없다(DB 가 파일 단위로 안 쪼개짐) → scope 는 항상 "list".
//
// WS 푸시는 없다 (iOS LiveSessionView 제거 이후 dead). 내부 listener 패턴만 남겨
// routes/desktop-sessions 의 in-memory 캐시 staleness 를 막는다 (claude/qwen 과 동일).

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * opencode 데이터 디렉터리 — XDG_DATA_HOME 을 존중하고(opencode 가 그렇게 한다), 없으면
 * `~/.local/share`. macOS 에서도 opencode 는 `~/Library/...` 가 아니라 XDG 식 경로를 쓴다.
 */
const XDG_DATA_HOME =
  process.env.XDG_DATA_HOME && process.env.XDG_DATA_HOME.length > 0
    ? process.env.XDG_DATA_HOME
    : path.join(os.homedir(), ".local", "share");
export const OPENCODE_DATA_DIR = path.join(XDG_DATA_HOME, "opencode");
/** 모든 세션 메타가 담긴 단일 SQLite DB. desktop-sessions.ts 가 read-only 로 연다. */
export const OPENCODE_DB_PATH = path.join(OPENCODE_DATA_DIR, "opencode.db");

const LIST_DEBOUNCE_MS = 500;

/**
 * scope:
 *  - "list": DB(세션 스토어) 변동. opencode 는 세션별 파일이 없어 tail 개념이 없다 →
 *    항상 "list". (인터페이스 호환을 위해 시그니처는 claude/qwen 과 동일하게 유지.)
 */
export type WatcherInvalidationListener = (
  scope: "tail" | "list",
  sessionId?: string,
) => void;

const listeners = new Set<WatcherInvalidationListener>();

export function onOpencodeWatcherInvalidation(
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
      console.error("[opencode-watcher] listener error:", (e as Error).message);
    }
  }
}

let listTimer: NodeJS.Timeout | null = null;
let watcher: fs.FSWatcher | null = null;

export type WatcherHandle = {
  stop: () => void;
};

/**
 * fs.watch 시작. 데이터 디렉터리가 아직 없으면 (opencode 를 한 번도 안 돌린 상태) null 반환 —
 * 사용자가 opencode 를 처음 쓰면 daemon 재시작 시 자연스럽게 잡힌다 (claude/qwen watcher 와
 * 같은 정책: 부모를 watch 해 후속 생성을 감지하는 비용은 낭비).
 */
export function startOpencodeWatcher(): WatcherHandle | null {
  if (!fs.existsSync(OPENCODE_DATA_DIR)) {
    console.log(
      `[opencode-watcher] ${OPENCODE_DATA_DIR} 없음 — 데스크탑 opencode 가 실행된 적 없는 상태. 건너뜀.`,
    );
    return null;
  }

  try {
    // 단일 DB 스토어라 recursive 불필요 — 데이터 디렉터리 직속의 `opencode.db*` 변동만 본다.
    watcher = fs.watch(OPENCODE_DATA_DIR, (_eventType, filename) => {
      if (!filename) return;
      // opencode.db / opencode.db-wal / opencode.db-shm 만 관심. log/·snapshot/ 등은 무시.
      const base = filename.split(path.sep).at(-1) ?? "";
      if (!base.startsWith("opencode.db")) return;
      debounceListDirty();
    });
    watcher.on("error", (err) => {
      console.error("[opencode-watcher] error:", err.message);
    });
    console.log(`[opencode-watcher] watching ${OPENCODE_DATA_DIR}`);
    return {
      stop: () => {
        watcher?.close();
        watcher = null;
        if (listTimer) clearTimeout(listTimer);
        listTimer = null;
      },
    };
  } catch (e) {
    console.error("[opencode-watcher] failed to start:", (e as Error).message);
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
