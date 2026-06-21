/**
 * codex 토큰 잔량 조회 — codex CLI 는 비-인터랙티브 usage 명령이 없지만 (0.133.0 기준,
 * REPL `/status` 뿐), 매 turn 의 `token_count` 이벤트에 서버가 내려준 rate limit
 * 스냅샷을 세션 rollout jsonl 에 그대로 기록한다:
 *
 *   ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
 *   {"type":"event_msg","payload":{"type":"token_count","info":{...},
 *     "rate_limits":{"primary":{"used_percent":9.0,"window_minutes":10080,
 *                                "resets_at":1780878222},"secondary":null,...}}}
 *
 * 가장 최근 파일의 «마지막» rate_limits 를 읽는다 — 활성 codex 세션이 있으면 매 turn
 * 갱신되는 사실상 라이브 값이고, 없으면 마지막 사용 시점 스냅샷 (fetchedAt = file mtime
 * 로 정직하게 보고).
 */
import fs from "node:fs";
import path from "node:path";
import type { AgentUsageReport, AgentUsageWindow } from "../../types.js";
import { CODEX_SESSIONS_DIR } from "./watcher.js";

/** 파일 꼬리에서 읽는 최대 바이트 — token_count 는 turn 마다 찍히므로 꼬리면 충분. */
const TAIL_MAX_BYTES = 256 * 1024;
/** 최근 파일 몇 개까지 거슬러 보나 — 막 시작해 rate_limits 가 아직 없는 파일 스킵용. */
const MAX_FILES_TO_SCAN = 5;

type CodexRateLimitWindow = {
  used_percent?: unknown;
  window_minutes?: unknown;
  resets_at?: unknown;
} | null;

/**
 * jsonl 본문 (꼬리 청크) 에서 마지막 token_count 의 rate_limits 를 정규화해 추출.
 * 순수 함수 — 단위 테스트 대상. 못 찾으면 null.
 */
export function extractCodexRateLimits(content: string): AgentUsageWindow[] | null {
  const lines = content.split("\n");
  // 마지막 줄부터 역방향 — 가장 최신 스냅샷이 답.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || !line.includes('"rate_limits"')) continue;
    let parsed: {
      type?: string;
      payload?: {
        type?: string;
        rate_limits?: { primary?: CodexRateLimitWindow; secondary?: CodexRateLimitWindow };
      };
    };
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // 꼬리 청크의 첫 줄이 잘린 partial line 인 경우 등 — 다음 후보로.
    }
    const rl = parsed?.payload?.rate_limits;
    if (parsed?.type !== "event_msg" || parsed?.payload?.type !== "token_count" || !rl) {
      continue;
    }
    const out: AgentUsageWindow[] = [];
    const push = (id: "primary" | "secondary"): void => {
      const w = rl[id];
      if (!w || typeof w !== "object") return;
      const used = typeof w.used_percent === "number" ? w.used_percent : null;
      if (used === null) return;
      const mins = typeof w.window_minutes === "number" ? w.window_minutes : null;
      // resets_at 은 epoch «초» — ms 로 정규화.
      const resetsAt = typeof w.resets_at === "number" ? w.resets_at * 1000 : null;
      out.push({ id, windowMinutes: mins, usedPercent: used, resetsAt });
    };
    push("primary");
    push("secondary");
    if (out.length > 0) return out;
  }
  return null;
}

/** sessions 트리에서 mtime 내림차순 jsonl 목록. desktop-sessions 의 walk 와 같은 모양. */
function listJsonlByMtimeDesc(): { path: string; mtime: number }[] {
  if (!fs.existsSync(CODEX_SESSIONS_DIR)) return [];
  const out: { path: string; mtime: number }[] = [];
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
          out.push({ path: full, mtime: fs.statSync(full).mtimeMs });
        } catch {
          // 경쟁 삭제 — 무시.
        }
      }
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

/** 파일 꼬리 TAIL_MAX_BYTES 만 읽는다 — rollout 파일은 수 MB 까지 자란다. */
function readTail(file: string): string {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, TAIL_MAX_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return buf.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

export async function codexUsage(): Promise<AgentUsageReport> {
  const files = listJsonlByMtimeDesc().slice(0, MAX_FILES_TO_SCAN);
  for (const f of files) {
    let windows: AgentUsageWindow[] | null = null;
    try {
      windows = extractCodexRateLimits(readTail(f.path));
    } catch {
      continue;
    }
    if (windows && windows.length > 0) {
      return { windows, fetchedAt: Math.floor(f.mtime) };
    }
  }
  throw new Error("codex 세션 기록에서 잔량 정보를 찾지 못했어요 — codex 를 한 번 사용하면 생겨요.");
}
