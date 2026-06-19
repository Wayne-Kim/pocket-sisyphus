/**
 * `~/.codex/sessions/` 변동 감지 — codex adapter 의 desktopWatcher 가 이어받기 후보 목록
 * 캐시를 무효화하기 위해 쓴다.
 *
 * codex 의 세션 저장 레이아웃은 날짜로 트리화된 디렉터리:
 *   ~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl
 *
 * 각 conversation 이 별도 jsonl 파일이라 agy 처럼 single-file watch 가 안 된다 — recursive
 * 디렉터리 watch (macOS 의 fs.watch + {recursive: true}) 로 신규 파일 생성 / 기존 파일
 * append 양쪽을 잡는다.
 *
 * Debounce: 사용자가 한 turn 에서 길게 타이핑하면 짧은 시간에 여러 line 이 append 될 수
 * 있다 — 250ms 디바운스로 noise 차단.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const CODEX_SESSIONS_DIR = path.join(
  os.homedir(),
  ".codex",
  "sessions",
);

const DEBOUNCE_MS = 250;

export type WatcherInvalidationListener = () => void;

const listeners = new Set<WatcherInvalidationListener>();

export function onCodexWatcherInvalidation(
  l: WatcherInvalidationListener,
): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

function notify(): void {
  for (const l of listeners) {
    try {
      l();
    } catch (e) {
      console.error("[codex-watcher] listener error:", (e as Error).message);
    }
  }
}

let watcher: fs.FSWatcher | null = null;
let debounceTimer: NodeJS.Timeout | null = null;

export type WatcherHandle = {
  stop: () => void;
};

/**
 * fs.watch 시작. sessions 디렉터리가 아직 없으면 (사용자가 codex 한 번도 안 돌린 상태)
 * null 반환. 사용자가 codex 를 처음 쓰면 daemon 재시작 시 자연스럽게 잡힌다.
 *
 * recursive 옵션은 macOS 의 FSEvents 위에서 동작 — 날짜 디렉터리가 새로 생기거나 그 안의
 * 새 .jsonl 가 append 되어도 모두 잡힌다.
 */
export function startCodexWatcher(): WatcherHandle | null {
  if (!fs.existsSync(CODEX_SESSIONS_DIR)) {
    console.log(
      `[codex-watcher] ${CODEX_SESSIONS_DIR} 없음 — codex 가 아직 실행된 적 없는 상태. 건너뜀.`,
    );
    return null;
  }
  try {
    watcher = fs.watch(
      CODEX_SESSIONS_DIR,
      { recursive: true },
      (_eventType, filename) => {
        // .jsonl 가 아닌 변동 (tmp / lock 파일 등) 은 무시 — preview 캐시에 영향 0.
        if (filename && !filename.endsWith(".jsonl")) return;
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          debounceTimer = null;
          notify();
        }, DEBOUNCE_MS);
      },
    );
    watcher.on("error", (err) => {
      console.error("[codex-watcher] error:", err.message);
    });
    console.log(`[codex-watcher] watching ${CODEX_SESSIONS_DIR}`);
    return {
      stop: () => {
        watcher?.close();
        watcher = null;
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = null;
      },
    };
  } catch (e) {
    console.error("[codex-watcher] failed to start:", (e as Error).message);
    return null;
  }
}
