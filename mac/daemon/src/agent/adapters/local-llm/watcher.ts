// `~/.qwen/projects/<slug>/chats/<uuid>.jsonl` 변화를 감지해 local_llm(Qwen Code) 의
// «이어받기 picker» 라우트 캐시를 무효화한다.
//
// claude 의 watcher 와 동형이다 — qwen 도 프로젝트별 디렉터리(<slug>) 아래 세션별 jsonl 을
// 쓰므로 projects 루트를 recursive watch 한다. 차이는 jsonl 이 한 단계 더 깊은 `chats/`
// 서브디렉터리에 있다는 것뿐 (경로 처리는 desktop-sessions.ts 가 담당, watcher 는 파일명만
// 본다).
//
// WS 푸시는 없다 (iOS LiveSessionView 제거 이후 dead). 내부 listener 패턴만 남겨
// routes/desktop-sessions 의 in-memory 캐시 staleness 를 막는다.
//
// ## Debounce
// jsonl 에 토큰이 흐르면 짧은 시간에 수십 번 write 가 일어난다 — file 별 250ms 디바운스.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const QWEN_PROJECTS_DIR = path.join(os.homedir(), ".qwen", "projects");

const TAIL_DEBOUNCE_MS = 250;
const LIST_DEBOUNCE_MS = 500;

/**
 * scope:
 *  - "tail": 특정 jsonl 파일 내용 변경. sessionId 알 수 있을 때.
 *  - "list": 디렉터리 구조 변동 (파일 생성/삭제, runtime.json 갱신 등). sessionId 불명.
 */
export type WatcherInvalidationListener = (
  scope: "tail" | "list",
  sessionId?: string,
) => void;

const listeners = new Set<WatcherInvalidationListener>();

export function onQwenWatcherInvalidation(l: WatcherInvalidationListener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

function notify(scope: "tail" | "list", sessionId?: string): void {
  for (const l of listeners) {
    try {
      l(scope, sessionId);
    } catch (e) {
      // listener 의 실패가 watcher 자체를 죽이지 않게 격리.
      console.error("[qwen-watcher] listener error:", (e as Error).message);
    }
  }
}

const tailTimers = new Map<string, NodeJS.Timeout>();
let listTimer: NodeJS.Timeout | null = null;

let watcher: fs.FSWatcher | null = null;

export type WatcherHandle = {
  stop: () => void;
};

/**
 * fs.watch 시작. projects 루트가 아직 없으면 (사용자가 qwen 을 한 번도 안 돌린 상태) null
 * 반환 — 후속 디렉터리 생성을 감지하려면 부모 watch 가 필요한데 그 비용은 낭비. 사용자가
 * qwen 을 처음 쓰면 daemon 재시작 시 자연스럽게 잡힌다 (agy/claude watcher 와 같은 정책).
 */
export function startQwenWatcher(): WatcherHandle | null {
  if (!fs.existsSync(QWEN_PROJECTS_DIR)) {
    console.log(
      `[qwen-watcher] ${QWEN_PROJECTS_DIR} 없음 — 데스크탑 Qwen Code 가 실행된 적 없는 상태. 건너뜀.`,
    );
    return null;
  }

  try {
    // recursive: true 는 macOS/Windows 에서만 동작 (Linux 미지원). daemon 이 macOS 라 OK.
    watcher = fs.watch(QWEN_PROJECTS_DIR, { recursive: true }, (eventType, filename) => {
      if (!filename) return;
      handleChange(eventType, filename);
    });
    watcher.on("error", (err) => {
      console.error("[qwen-watcher] error:", err.message);
    });
    console.log(`[qwen-watcher] watching ${QWEN_PROJECTS_DIR}`);
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
    console.error("[qwen-watcher] failed to start:", (e as Error).message);
    return null;
  }
}

function handleChange(eventType: string, relPath: string): void {
  // relPath 모양: "<slug>/chats/<uuid>.jsonl" 또는 "<slug>/chats/<uuid>.runtime.json" 등.
  const segments = relPath.split(path.sep);
  const last = segments.at(-1) ?? "";
  const isJsonl = last.endsWith(".jsonl");

  if (isJsonl && eventType === "change") {
    // 파일 내용 변경 — tail event.
    const sessionId = last.replace(/\.jsonl$/, "");
    debounceTail(sessionId);
    return;
  }

  // 그 외 (rename, 신규 디렉터리, runtime.json/메타 파일 생성·삭제 등) → list dirty.
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
