/**
 * `~/.gemini/antigravity-cli/history.jsonl` 변동 감지 — agy adapter 의 desktopWatcher 가
 * 이어받기 후보 목록 캐시를 무효화하기 위해 쓴다.
 *
 * claude 의 watcher 와 달리 **단일 파일** 만 watch — agy 가 모든 conversation 의 사용자
 * 입력을 한 history.jsonl 에 append 하므로 recursive 디렉터리 watch 가 필요 없다 (훨씬
 * 단순 + 안정).
 *
 * Debounce: 사용자가 한 turn 에서 길게 타이핑하면 짧은 시간에 여러 line 이 append 될 수
 * 있다 — 250ms 디바운스로 noise 차단.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const AGY_HISTORY_PATH = path.join(
  os.homedir(),
  ".gemini",
  "antigravity-cli",
  "history.jsonl",
);

const DEBOUNCE_MS = 250;

export type WatcherInvalidationListener = () => void;

const listeners = new Set<WatcherInvalidationListener>();

export function onAgyWatcherInvalidation(l: WatcherInvalidationListener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

function notify(): void {
  for (const l of listeners) {
    try {
      l();
    } catch (e) {
      console.error("[agy-watcher] listener error:", (e as Error).message);
    }
  }
}

let watcher: fs.FSWatcher | null = null;
let debounceTimer: NodeJS.Timeout | null = null;

export type WatcherHandle = {
  stop: () => void;
};

/**
 * fs.watch 시작. history.jsonl 이 아직 없으면 (사용자가 agy 한 번도 안 돌린 상태) null
 * 반환 — 후속 file 생성을 감지하려면 부모 디렉터리 watch 가 필요한데 그 비용은 낭비.
 * 사용자가 agy 를 처음 쓰면 daemon 을 재시작하면 그때 자연스럽게 잡힌다.
 */
export function startAgyWatcher(): WatcherHandle | null {
  if (!fs.existsSync(AGY_HISTORY_PATH)) {
    console.log(
      `[agy-watcher] ${AGY_HISTORY_PATH} 없음 — agy 가 아직 실행된 적 없는 상태. 건너뜀.`,
    );
    return null;
  }
  try {
    watcher = fs.watch(AGY_HISTORY_PATH, () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        notify();
      }, DEBOUNCE_MS);
    });
    watcher.on("error", (err) => {
      console.error("[agy-watcher] error:", err.message);
    });
    console.log(`[agy-watcher] watching ${AGY_HISTORY_PATH}`);
    return {
      stop: () => {
        watcher?.close();
        watcher = null;
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = null;
      },
    };
  } catch (e) {
    console.error("[agy-watcher] failed to start:", (e as Error).message);
    return null;
  }
}
