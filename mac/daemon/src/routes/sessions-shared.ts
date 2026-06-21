import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { db, type SessionRow } from "../db/index.js";
import {
  getPtyWaitingSince,
  getPtyPendingPreview,
  getPtyAttention,
} from "../agent/pty-runner.js";
import { computeInitialTaint } from "../taint.js";

/**
 * 클라이언트가 agent 를 명시 안 했을 때 (옛 iOS 빌드) 의 기본값. 옛 사용자가 만든 row 와
 * 동일한 가정을 유지해 사용자 영향 0.
 */
export const DEFAULT_AGENT_ID = "claude_code";

// fs/file 응답 body cap. 텍스트와 base64 인코딩된 binary 가 합쳐서 이 한도를 넘으면 거부.
// 5MB 면 일반적인 PNG/JPEG 스크린샷은 충분히 통과하고, 비현실적인 RAW/PSD 는 막힌다.
export const FS_FILE_MAX_BYTES = 5 * 1024 * 1024;
// 텍스트로 읽을 때만 별도로 적용되는 더 작은 cap — 모바일에서 1MB 넘는 텍스트 viewer 는 부담.
export const FS_TEXT_MAX_BYTES = 1 * 1024 * 1024;

// daemon 은 PTY runner 만 사용한다 — 옛 SDK runner 와 그 의존성은 제거됨. mode 컬럼은
// 향후 다른 runner 가 도입될 가능성을 위해 schema 에만 남기고, 신규 세션은 항상 'pty'.
//
// export 이유: cron/executor.ts 가 예약 실행 시 정확히 같은 컬럼 구조로 세션을 만든다 —
// 코드 에이전트 세션 생성 경로를 한 곳으로 유지하기 위해 재사용한다.
export function createSession(
  repoPath: string,
  title: string | undefined,
  resumeFrom: string | undefined,
  skipPermissions: boolean,
  agent: string,
): string {
  const id = randomUUID();
  const now = Date.now();
  // 초기 오염(capability_caps T1) — 이 repo 에 개인-데이터(메일/캘린더) taint 소스 MCP 가 연결돼
  // 있으면 세션을 «오염» 으로 시작한다(외부 콘텐츠 적재 가능 → EGRESS 기본 deny·알림 본문 미동봉).
  // MCP 없는 절대다수 repo 는 0 → 회귀 0.
  const tainted = computeInitialTaint(repoPath) ? 1 : 0;
  db().prepare(
    `INSERT INTO sessions (id, title, repo_path, created_at, status, parent_sdk_session_id, skip_permissions, mode, agent, external_content_tainted)
     VALUES (?, ?, ?, ?, 'active', ?, ?, 'pty', ?, ?)`,
  ).run(
    id,
    title ?? null,
    repoPath,
    now,
    resumeFrom ?? null,
    skipPermissions ? 1 : 0,
    agent,
    tainted,
  );
  return id;
}

export function getSession(id: string): SessionRow | undefined {
  return db()
    .prepare(`SELECT * FROM sessions WHERE id = ?`)
    .get(id) as SessionRow | undefined;
}

export function attentionFields(id: string): Record<string, unknown> {
  const att = getPtyAttention(id);
  return {
    waiting_since: getPtyWaitingSince(id),
    last_activity: att?.lastActivity ?? null,
    idle_ms: att?.idleMs ?? null,
    waiting_reminder_idx: att?.waitingReminderIdx ?? null,
    notify_next_stop: att?.notifyNextStop ?? false,
    pending_prompt_preview: getPtyPendingPreview(id) ?? undefined,
  };
}

/**
 * repoPath 안의 상대경로를 절대경로로 안전하게 해석한다.
 *   - 빈 문자열 / undefined 면 repo root.
 *   - 절대경로 / `..` 토큰은 거부.
 *   - 심볼릭 링크가 repo 밖을 가리키면 거부 (realpath prefix 검증).
 *   - `.git` 직접/하위 경로는 차단.
 *
 * 반환: `{ ok: true, abs }` 또는 `{ ok: false, error }`.
 */
export async function resolveRepoRelative(
  repoPath: string,
  rel: string | undefined,
): Promise<
  | { ok: true; abs: string; rel: string }
  | { ok: false; error: string }
> {
  const path = await import("node:path");
  const fs = await import("node:fs/promises");
  const norm = (rel ?? "").trim();
  if (norm.startsWith("/")) return { ok: false, error: "invalid_path" };
  if (norm.split("/").some((seg) => seg === "..")) {
    return { ok: false, error: "invalid_path" };
  }
  // `.git` 차단 — `.gitignore`, `.github` 같은 다른 dotfile 은 허용.
  if (norm === ".git" || norm.startsWith(".git/")) {
    return { ok: false, error: "forbidden" };
  }
  const abs = norm === "" ? repoPath : path.join(repoPath, norm);
  // realpath 로 심볼릭 링크 통과 — root 도 같이 정규화해야 prefix 비교가 의미를 가진다.
  let realAbs: string;
  let realRoot: string;
  try {
    realRoot = await fs.realpath(repoPath);
  } catch {
    return { ok: false, error: "no_repo" };
  }
  try {
    realAbs = await fs.realpath(abs);
  } catch (e: any) {
    // ENOENT 면 그대로 통과시켜서 라우터가 404 로 처리하게 한다 (디렉토리/파일이 없는 정상 케이스).
    if (e?.code === "ENOENT") {
      // 최종 구성요소가 아직 없을 수 있다(새 파일/디렉토리 쓰기). 다만 «부모» 가 symlink 로
      // repo 밖을 가리키면 논리 경로 검증만으론 못 막는다(attachments 업로드의 write-outside
      // 가능성) → 부모를 realpath 해서 그것이 repo 안에 있는지 확인한다.
      const parent = path.dirname(abs);
      try {
        const realParent = await fs.realpath(parent);
        if (realParent !== realRoot && !realParent.startsWith(realRoot + path.sep)) {
          return { ok: false, error: "invalid_path" };
        }
        return { ok: true, abs: path.join(realParent, path.basename(abs)), rel: norm };
      } catch {
        // 부모도 아직 없으면(중첩 새 디렉토리, recursive mkdir 케이스) 논리 경로 기준 검증.
        const logical = path.resolve(realRoot, norm);
        if (logical !== realRoot && !logical.startsWith(realRoot + path.sep)) {
          return { ok: false, error: "invalid_path" };
        }
        return { ok: true, abs: logical, rel: norm };
      }
    }
    return { ok: false, error: "invalid_path" };
  }
  if (realAbs !== realRoot && !realAbs.startsWith(realRoot + path.sep)) {
    return { ok: false, error: "invalid_path" };
  }
  return { ok: true, abs: realAbs, rel: norm };
}

/**
 * 세션 repo 경로를 정규화하고, 폴더가 없으면 생성한다.
 *
 * iOS 가 직접 입력한 경로의 폴더가 없을 때, PTY 가 그 cwd 로 spawn 하려다 ENOENT 로 실패 →
 * 사용자는 빈 채팅 화면(silent failure)만 보던 문제를 막는다. ~ 는 home 으로 확장하고,
 * 절대경로만 허용한다 (상대경로는 daemon cwd 기준 생성이라 사용자에게 혼란). 생성 실패
 * (권한/디스크/파일과 충돌 등)는 사용자에게 보여줄 한국어 메시지로 반환해 호출부가 400 으로
 * 변환 → iOS 가 alert 로 노출한다.
 *
 * export 이유: cron/executor.ts 가 예약 실행 직전 같은 정규화 + mkdir -p 를 거친다.
 */
export function resolveAndEnsureRepoDir(input: string): { path: string } | { error: string } {
  let p = input.trim();
  if (p === "~" || p.startsWith("~/")) {
    p = path.join(os.homedir(), p.slice(1));
  }
  if (!path.isAbsolute(p)) {
    return { error: "절대 경로를 입력해 주세요 (예: /Users/<나>/projects/repo)." };
  }
  p = path.resolve(p);
  try {
    const st = fs.statSync(p);
    if (!st.isDirectory()) {
      return { error: `이 경로는 폴더가 아니라 파일이에요: ${p}` };
    }
    return { path: p };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      return { error: `경로를 확인할 수 없어요: ${(e as Error).message}` };
    }
    // ENOENT — 존재하지 않음. 아래에서 생성 시도.
  }
  try {
    fs.mkdirSync(p, { recursive: true });
    return { path: p };
  } catch (e) {
    return { error: `폴더를 만들 수 없어요 (${p}): ${(e as Error).message}` };
  }
}

