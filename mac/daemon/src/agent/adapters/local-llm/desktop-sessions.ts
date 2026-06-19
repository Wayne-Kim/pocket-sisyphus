/**
 * local_llm (Qwen Code) 데스크탑 세션 디스커버리 — `~/.qwen/projects/<slug>/chats/<uuid>.jsonl`
 * 에서 「이어받기」 후보 메타데이터를 뽑아 DesktopSessionSummary 배열로 돌려준다. Mac 에서
 * 시작한 로컬 Qwen Code 세션을 폰의 세션 목록에서 발견·이어받게 하는 게 목적 — claude/agy
 * 세션과 동일한 경로(buildSpawnArgs 의 ctx.resumeFrom → `--resume <id>`).
 *
 * 왜 claude 패턴인가 (agy 아님):
 *  - agy 는 본문(`.pb`)이 사설 컨테이너라 못 읽고 단일 history.jsonl 의 메타만 group-by 했다.
 *  - qwen 은 claude 와 사실상 동형이다 — 프로젝트별 디렉터리 아래 세션별 **평문 jsonl** 이라
 *    파일 하나 = 세션 하나(파일명 UUID = sessionId)이고 본문을 그대로 디코드할 수 있다. 그래서
 *    claude-code/desktop-sessions.ts 구조(per-file inspect + 캐시)를 그대로 따른다.
 *
 * qwen jsonl 한 줄 모양 (claude 와 거의 동일, message 형태만 다름):
 *   {"sessionId":"…","timestamp":"<ISO>","type":"user","cwd":"…","gitBranch":"…",
 *    "message":{"role":"user","parts":[{"text":"…"}]}}
 *  → claude 는 message.content, qwen 은 message.parts[].text 를 쓴다.
 *
 * 메타-only 폴백: jsonl 이 비었거나 cwd/시각을 못 뽑으면 같은 디렉터리의 `<uuid>.runtime.json`
 * (`work_dir` + `started_at`) 으로 후보를 구성한다 — 본문 디코드를 더 시도하지 않고 메타만으로.
 * 본문이 아예 없는(jsonl 없이 runtime.json 만 있는) 세션은 이어받을 대화가 없으므로 제외한다.
 *
 * Cache 정책 (claude 와 동일):
 *  - scanCache: per-key (repo-scoped 또는 unscoped) 결과를 30s 까지 보관.
 *  - inspectionCache: jsonlPath → 요약. mtime 비교로 freshness 검증 → 안 바뀐 파일은 재파싱 회피.
 *  - 두 캐시 모두 watcher 의 onQwenWatcherInvalidation 으로 무효화.
 */
import fs from "node:fs";
import path from "node:path";
import type {
  DesktopAgentWatcher,
  DesktopListOptions,
  DesktopSessionSummary,
} from "../../types.js";
import {
  QWEN_PROJECTS_DIR,
  onQwenWatcherInvalidation,
  startQwenWatcher,
} from "./watcher.js";

const STALE_GRACE_MS = 30_000;
/**
 * 한 jsonl 에서 cwd/gitBranch/첫 user 메시지를 뽑을 때 읽는 최대 바이트. 이 메타는 모두
 * 파일 앞부분에서 잡히고 turnCount 는 근사치로 충분 — 수백 KB ~ 수 MB jsonl 전체 파싱 회피.
 */
const PER_FILE_MAX_BYTES = 256 * 1024;

type CacheEntry = { value: DesktopSessionSummary[]; computedAt: number };
const scanCache = new Map<string, CacheEntry>();

// watcher 이벤트로 캐시 전체 무효화 — 디렉터리 / 파일 변동 어느 쪽이든 결과 row 의
// mtime / turnCount 가 달라지므로 부분 무효화는 의미 없음.
onQwenWatcherInvalidation(() => {
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

/**
 * projectsRoot 아래 모든 `<slug>/chats/<uuid>.jsonl` 을 후보로 스캔한다. root 를 인자로 받아
 * 테스트가 tmpdir 픽스처로 검증할 수 있게 한다 (기본값은 QWEN_PROJECTS_DIR).
 */
export function scanQwenSessions(
  projectsRoot: string,
  opts: DesktopListOptions,
): DesktopSessionSummary[] {
  if (!fs.existsSync(projectsRoot)) return [];
  const items: DesktopSessionSummary[] = [];
  for (const dir of safeReadDir(projectsRoot)) {
    if (!dir.isDirectory()) continue;
    // qwen 은 claude 와 달리 세션 jsonl 을 <slug>/chats/ 한 단계 아래에 둔다.
    const chatsDir = path.join(projectsRoot, dir.name, "chats");
    const files = safeReadDir(chatsDir).filter(
      (f) => f.isFile() && f.name.endsWith(".jsonl"),
    );
    for (const f of files) {
      const sessionId = f.name.replace(/\.jsonl$/, "");
      const jsonlPath = path.join(chatsDir, f.name);
      const runtimePath = path.join(chatsDir, `${sessionId}.runtime.json`);
      const summary = inspectSession(jsonlPath, runtimePath);
      if (!summary) continue;
      if (opts.repoPathFilter && summary.cwd !== opts.repoPathFilter) continue;
      items.push({
        sessionId,
        repoPath: summary.cwd,
        preview: summary.firstUserText,
        turnCount: summary.userTurnCount > 0 ? summary.userTurnCount : null,
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

onQwenWatcherInvalidation((scope) => {
  if (scope === "list") {
    inspectionCache.clear();
  }
});

function inspectSession(jsonlPath: string, runtimePath: string): Summary | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(jsonlPath);
  } catch {
    return null;
  }
  // 캐시 hit & mtime 일치 → 즉시 반환 (256KB read + parse 회피).
  const cached = inspectionCache.get(jsonlPath);
  if (cached && cached.mtimeMs === stat.mtimeMs) {
    return cached;
  }

  let cwd: string | null = null;
  let firstUserText: string | null = null;
  let firstUserAt: number | null = null;
  let userTurnCount = 0;
  let gitBranch: string | null = null;

  const head = readSlice(jsonlPath, 0, Math.min(PER_FILE_MAX_BYTES, stat.size));
  if (head) {
    for (const line of head.split("\n")) {
      if (!line.trim()) continue;
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(line);
      } catch {
        // cap 으로 자르다 마지막 줄이 잘렸을 수 있음 — 스킵.
        continue;
      }
      if (!cwd && typeof obj.cwd === "string" && (obj.cwd as string).length > 0) {
        cwd = obj.cwd as string;
      }
      if (
        !gitBranch &&
        typeof obj.gitBranch === "string" &&
        (obj.gitBranch as string).length > 0
      ) {
        gitBranch = obj.gitBranch as string;
      }
      if (obj.type === "user") {
        const text = meaningfulText(extractUserText(obj));
        if (!text) continue;
        userTurnCount++;
        if (firstUserText === null) {
          firstUserText = truncate(text, 140);
          if (typeof obj.timestamp === "string") {
            const t = Date.parse(obj.timestamp as string);
            if (!Number.isNaN(t)) firstUserAt = t;
          }
        }
      }
    }
  }

  // 메타-only 폴백 — 본문에서 cwd/시각을 못 뽑으면 runtime.json 의 메타로 보강.
  if (!cwd || firstUserAt === null) {
    const rt = readRuntime(runtimePath);
    if (rt) {
      if (!cwd && rt.workDir) cwd = rt.workDir;
      if (firstUserAt === null && rt.startedAt !== null) firstUserAt = rt.startedAt;
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
  inspectionCache.set(jsonlPath, summary);
  return summary;
}

/** qwen 의 user 행: { message: { role:"user", parts:[{text:…}] } }. gemini-cli 계열 포맷
 *  변동 대비로 claude 식 content (string | [{text}]) 도 방어적으로 지원. */
function extractUserText(obj: Record<string, unknown>): string | null {
  const msg = obj.message as Record<string, unknown> | undefined;
  const parts = msg?.parts;
  if (Array.isArray(parts)) {
    for (const p of parts as Array<Record<string, unknown>>) {
      if (typeof p?.text === "string") return p.text as string;
    }
  }
  const content = msg?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const block of content as Array<Record<string, unknown>>) {
      if (typeof block?.text === "string") return block.text as string;
    }
  }
  return null;
}

// 터미널이 부팅 시 stdin 으로 흘려보내는 capability 응답(DA/DSR 등)이 첫 "user" 행으로
// 잡히는 케이스가 있어, ANSI/CSI escape + C0 컨트롤을 제거한 뒤 남는 게 있을 때만 본문으로
// 본다 (이 정리 결과가 그대로 preview 가 되므로 폰 화면에 ANSI 잔재가 안 새도록 하는 역할도
// 겸한다). 빈 결과면 preview/turn 에서 제외 (preview 는 null 허용).
// CSI: ESC '[' params(0-9;?) intermediates(0x20-0x2f) final(0x40-0x7e). ESC 접두를 요구해
// 본문의 평범한 대괄호([0] 같은)를 잘못 먹지 않게 한다.
const ANSI_CSI = /\u001b\[[0-9;?]*[\u0020-\u002f]*[\u0040-\u007e]/g;
function meaningfulText(text: string | null): string | null {
  if (!text) return null;
  const stripped = text
    .replace(ANSI_CSI, "") // CSI escape (DA/DSR 응답 등) 제거
    .replace(/[\u0000-\u001f\u007f]/g, " ") // 남은 C0 컨트롤·DEL → 공백
    .replace(/\s+/g, " ") // 연속 공백 합치기 (멀티라인 입력 → 한 줄 preview)
    .trim();
  return stripped.length > 0 ? stripped : null;
}

type Runtime = { workDir: string | null; startedAt: number | null };
function readRuntime(filePath: string): Runtime | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  const workDir =
    typeof obj.work_dir === "string" && (obj.work_dir as string).length > 0
      ? (obj.work_dir as string)
      : null;
  // started_at 은 epoch 초(부동소수점) — ms 로 변환.
  const sa = obj.started_at;
  const startedAt =
    typeof sa === "number" && Number.isFinite(sa) ? Math.round(sa * 1000) : null;
  return { workDir, startedAt };
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
 * localLlmAdapter.desktopWatcher() 가 반환하는 객체. 라우트는 이걸 통해서만 scan / watcher
 * 에 접근한다 (claude/agy/codex 와 동일한 형태).
 */
export const localLlmDesktopWatcher: DesktopAgentWatcher = {
  list(opts: DesktopListOptions): DesktopSessionSummary[] {
    const key = opts.repoPathFilter ? `repo:${opts.repoPathFilter}` : "all";
    return getScanCached(key, () => scanQwenSessions(QWEN_PROJECTS_DIR, opts));
  },
  start(onInvalidate): () => void {
    // 외부 listener 등록 + fs.watch 시작. 내부 listener (캐시 무효화) 는 모듈 import 시점에
    // 이미 등록돼 있다.
    const off = onQwenWatcherInvalidation((scope, sessionId) => {
      onInvalidate(scope, sessionId);
    });
    const handle = startQwenWatcher();
    return () => {
      off();
      handle?.stop();
    };
  },
};
