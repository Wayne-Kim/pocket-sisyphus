import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { db, type SessionRow } from "../db/index.js";
import { bearerAuth } from "../auth.js";
import { parsePorcelainZ, type GitStatusEntry } from "./git-status-parser.js";
import { isValidRef, listWorktrees, createWorktree } from "../git/worktree.js";

const execFileAsync = promisify(execFile);
import {
  runUserMessagePty,
  prewarmPty,
  abortPtySession,
  awaitPtyExit,
  resizePty,
  sendPtyKey,
  writePtyRaw,
  getPtyWaitingSince,
  getPtyPendingPreview,
  getPtyAttention,
  setNotifyNextStop,
  getPtySize,
} from "../agent/pty-runner.js";
import { getAgent, hasAgent } from "../agent/registry.js";
import { getAgentUsage } from "../agent/usage.js";
import { sanitizeMessageRows } from "../agent/pty-sanitize.js";
import { buildPtySnapshot } from "../agent/pty-snapshot.js";

/**
 * 클라이언트가 agent 를 명시 안 했을 때 (옛 iOS 빌드) 의 기본값. 옛 사용자가 만든 row 와
 * 동일한 가정을 유지해 사용자 영향 0.
 */
const DEFAULT_AGENT_ID = "claude_code";

/**
 * 로컬 추론(llama-server) 백엔드를 공유하는 어댑터들 — local_llm(Qwen Code) 과 opencode 가
 * 같은 단일 llama-server(포트 51100)를 front 한다. 모델이 메모리에 ~38GB(Q8 35B)를 mlock 으로
 * 잡고 서버가 `--parallel 1` 이라, 둘을 동시에 굴리면 메모리 압박 + 요청 직렬화로 UX 가 무너진다.
 * 게다가 두 어댑터의 releaseBackend 가 모두 같은 stopServer 를 호출하므로, 한쪽 세션이 끝나며
 * 서버를 내리면 다른 쪽 살아있는 세션이 조용히 끊긴다(cross-adapter race).
 *
 * 그래서 이 «로컬 추론 군» 전체에서 활성 세션을 한 번에 하나만 허용한다 — local_llm 1개든
 * opencode 1개든, 군을 통틀어 1개. iOS picker 도 같은 제약을 client-side 로 반영하지만 여기가
 * 진실의 원천 — 초과 생성 요청은 409 로 거절한다. 마지막 세션이 끝나면 supervisor 가 서버를
 * 회수한다 (각 어댑터 releaseBackend → stopServer).
 */
const LOCAL_INFERENCE_AGENT_IDS = ["local_llm", "opencode"];
const LOCAL_INFERENCE_MAX_ACTIVE_SESSIONS = 1;

/** 이 agent 가 로컬 추론 백엔드를 공유하는 군에 속하는지. */
function isLocalInferenceAgent(agentId: string): boolean {
  return LOCAL_INFERENCE_AGENT_IDS.includes(agentId);
}

export const sessions = new Hono();

sessions.use("*", bearerAuth);

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
  db().prepare(
    `INSERT INTO sessions (id, title, repo_path, created_at, status, parent_sdk_session_id, skip_permissions, mode, agent)
     VALUES (?, ?, ?, ?, 'active', ?, ?, 'pty', ?)`,
  ).run(
    id,
    title ?? null,
    repoPath,
    now,
    resumeFrom ?? null,
    skipPermissions ? 1 : 0,
    agent,
  );
  return id;
}

function getSession(id: string): SessionRow | undefined {
  return db()
    .prepare(`SELECT * FROM sessions WHERE id = ?`)
    .get(id) as SessionRow | undefined;
}

/**
 * 세션 응답에 합성할 «대기 추정 근거» 메모리 신호 — activePtys 상태라 SQL 이 아니라 응답
 * 시점에 붙인다. 휴리스틱이 «대기» 로 못 잡은 조용한 세션을 폰에서 식별/구독하게 한다.
 *   - waiting_since: 기존 «입력 대기» 배지 신호 (재사용).
 *   - last_activity: 마지막 출력 시각(epoch ms) — iOS 가 «조용함 N분» 라이브 계산. 비활성 PTY 면 null.
 *   - idle_ms: 서버 시점 idle 스냅샷.
 *   - waiting_reminder_idx: 발사된 응답 대기 리마인더 단계.
 *   - notify_next_stop: 「다음 정지 시 알림」 수동 구독 무장 여부.
 *   - pending_prompt_preview: 대기 세션이 «지금 무엇을 묻고 멈췄는지» 한~두 줄 미리보기 —
 *     iOS 대기 카드 인라인 표시 + 일괄 「모두 승인」 다이얼로그 요약. 대기가 아니거나 추출
 *     가능한 본문이 없으면(순수 스피너/진행바) undefined → 응답에서 생략(구 iOS 호환·회귀 0).
 */
/**
 * 세션→출처 브리프 역참조 (po_provenance). 브리프 승인/기각·수정·수집이 세션을 spawn 할 때
 * daemon 은 po_briefs 의 4 종 *_session_id 컬럼에 세션 id 를 박지만, 그 «역방향»(세션이 어떤
 * 브리프에서 왔나) 신호가 세션 API 엔 없었다. 새 컬럼을 두지 않고 이 역조회 한 줄로 합성한다.
 * 컬럼→종류 매핑:
 *   exec_session_id → exec / collect_session_id → collect /
 *   cleanup_session_id → cleanup / revising_session_id → revise.
 * 일치 없으면 빈 객체 → 응답에서 source_brief 생략(일반 세션·구 클라이언트는 «출처 없음»으로 처리).
 * (워크플로우 run 출처는 스코프 밖 — workflow_run_id 가 따로 담당한다.)
 */
function sourceBriefField(
  sessionId: string,
): { source_brief: { id: string; title: string | null; kind: string } } | Record<string, never> {
  const row = db()
    .prepare(
      `SELECT id, title,
              CASE
                WHEN exec_session_id = @sid THEN 'exec'
                WHEN collect_session_id = @sid THEN 'collect'
                WHEN cleanup_session_id = @sid THEN 'cleanup'
                WHEN revising_session_id = @sid THEN 'revise'
              END AS kind
         FROM po_briefs
        WHERE exec_session_id = @sid
           OR collect_session_id = @sid
           OR cleanup_session_id = @sid
           OR revising_session_id = @sid
        ORDER BY updated_at DESC
        LIMIT 1`,
    )
    .get({ sid: sessionId }) as { id: string; title: string | null; kind: string } | undefined;
  if (!row) return {};
  return { source_brief: { id: row.id, title: row.title ?? null, kind: row.kind } };
}

function attentionFields(id: string): Record<string, unknown> {
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

sessions.get("/", (c) => {
  // 응답에 parent_sdk_session_id 포함 — 맥 GUI 가 메뉴바에서 `claude --resume <id>` 로
  // 이어붙으려면 이 값이 필요. NULL 이면 한 turn 도 안 돈 빈 세션.
  //
  // 세 쿼리 파라미터는 모바일 클라이언트는 안 보내도 되도록 모두 선택적.
  // - onlyResumable=1: parent_sdk_session_id 가 있는(=실제 대화가 시작된) 세션만 반환.
  //   맥 GUI 의 "이어가기" 목록은 빈 세션이 100 개 누적된 상황에서도 결과가 빌 위험을
  //   원천 차단하기 위해 SQL 단 필터를 쓴다.
  // - limit: 정수, 1..100. 미지정 시 기존 동작(=100).
  // - archived (session_archive_v1): 미지정/'0' → 미보관(archived=0)만 (기본·기존 동작 보존),
  //   '1' → 보관분만, 'all' → 둘 다. 기본을 미보관으로 둬 완료/오래된 보관 세션이 100 캡을
  //   잠식해 활성 목록을 가리는 일을 막는다 — 보관의 핵심 가치(활성 목록 슬림)를 SQL 단에서 보장.
  const onlyResumable = c.req.query("onlyResumable") === "1";
  const limitRaw = c.req.query("limit");
  const limit = limitRaw
    ? Math.min(100, Math.max(1, parseInt(limitRaw, 10) || 100))
    : 100;
  const archivedRaw = c.req.query("archived");

  const clauses: string[] = [];
  if (onlyResumable) {
    clauses.push(`s.parent_sdk_session_id IS NOT NULL AND s.parent_sdk_session_id <> ''`);
  }
  // 보관 필터 — 기본(미지정/'0')은 미보관만. 'all' 은 필터 없음.
  if (archivedRaw === "1") {
    clauses.push(`s.archived = 1`);
  } else if (archivedRaw !== "all") {
    clauses.push(`s.archived = 0`);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ``;

  // workflow_run_id: 이 세션을 만든 워크플로우 실행의 run id (없으면 NULL=일반 세션). iOS 가
  // 세션 탭에서 워크플로우 세션을 걸러내고, 워크플로우 탭에서 따로 보여 주는 데 쓴다.
  const rows = db()
    .prepare(
      `SELECT s.id, s.title, s.repo_path, s.created_at, s.ended_at, s.status,
              s.parent_sdk_session_id, s.skip_permissions, s.mode, s.agent, s.notify_muted,
              s.archived, wnr.run_id AS workflow_run_id
       FROM sessions s
       LEFT JOIN workflow_node_runs wnr ON wnr.session_id = s.id
       ${where} ORDER BY s.created_at DESC LIMIT ?`,
    )
    .all(limit) as Array<Record<string, unknown> & { id: string }>;
  // waiting_since: 이 세션의 에이전트가 사용자 입력을 기다리기 시작한 시각 (epoch ms,
  // 아니면 null). 메모리(activePtys) 상태라 SQL 이 아니라 응답 시점에 합성한다 —
  // iOS 세션 목록이 «입력 대기» 배지 + 대기 우선 정렬에 쓴다 (triage).
  const withAttention = rows.map((r) => ({ ...r, ...attentionFields(r.id), ...sourceBriefField(r.id) }));
  return c.json({ sessions: withAttention });
});

/**
 * 세션 일괄 처리 (session_archive_v1) — POST /api/sessions/bulk { action, ids }.
 *
 * 너무 많은 세션을 «하나씩» 보관/삭제하던 병목을 그룹 단위로 해소한다 (iOS 세션 목록의
 * 그룹 헤더 일괄 액션). action:
 *  - "archive"   : ids 의 archived 를 1 로 — 기본 목록에서 숨긴다 (한 트랜잭션).
 *  - "unarchive" : ids 의 archived 를 0 으로 — «보관됨» 섹션에서 복구.
 *  - "delete"    : ids 를 완전히 삭제 — 각 세션의 PTY 를 먼저 중단·종료 대기 후, 단일 DELETE
 *                  와 동일하게 workflow_node_runs 참조를 끊고 지운다(파괴적, iOS 가 확인 다이얼로그).
 *
 * 부분 성공 허용: 존재하지 않는 id 는 조용히 건너뛰고 affected(실제 반영 수)만 돌려준다 —
 * 동시 삭제/이미 사라진 세션이 섞여도 전체가 실패하지 않는다(클라가 reload 로 수렴).
 */
sessions.post("/bulk", async (c) => {
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const action = (body as { action?: unknown }).action;
  const idsRaw = (body as { ids?: unknown }).ids;
  if (action !== "archive" && action !== "unarchive" && action !== "delete") {
    return c.json({ error: "action must be archive|unarchive|delete" }, 400);
  }
  if (!Array.isArray(idsRaw) || idsRaw.some((x) => typeof x !== "string")) {
    return c.json({ error: "ids must be string[]" }, 400);
  }
  // 과도한 페이로드 방어 — 목록 캡(100)의 여유 배수까지만. 초과분은 잘라 affected 로 드러난다.
  const ids = (idsRaw as string[]).slice(0, 500);
  if (ids.length === 0) {
    return c.json({ ok: true, action, affected: 0 });
  }

  if (action === "archive" || action === "unarchive") {
    const next = action === "archive" ? 1 : 0;
    const placeholders = ids.map(() => "?").join(", ");
    const result = db()
      .prepare(`UPDATE sessions SET archived = ? WHERE id IN (${placeholders})`)
      .run(next, ...ids);
    return c.json({ ok: true, action, affected: result.changes });
  }

  // delete — 진행 중 PTY 를 먼저 끊고 실제 종료까지 대기(단일 DELETE 와 같은 race 방지).
  // 한 건씩 직렬: PTY 종료 대기가 섞여 있어 트랜잭션으로 묶기보다 각 세션을 독립 처리한다
  // (한 건 실패해도 나머지 진행 — 부분 성공). workflow_node_runs 참조는 NULL 로 끊고 지운다.
  let affected = 0;
  for (const id of ids) {
    if (!getSession(id)) continue;
    abortPtySession(id);
    await awaitPtyExit(id);
    const tx = db().transaction((sid: string) => {
      db().prepare(`UPDATE workflow_node_runs SET session_id = NULL WHERE session_id = ?`).run(sid);
      return db().prepare(`DELETE FROM sessions WHERE id = ?`).run(sid);
    });
    affected += tx(id).changes;
  }
  return c.json({ ok: true, action, affected });
});

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

sessions.post("/", async (c) => {
  const body = await c.req.json();
  const repoPathInput = body.repoPath ?? body.cwd;
  if (!repoPathInput || typeof repoPathInput !== "string") {
    return c.json({ error: "repoPath required" }, 400);
  }
  // 폴더 없으면 생성 (mkdir -p) + 정규화. 실패하면 사용자에게 사유를 그대로 알린다.
  const dir = resolveAndEnsureRepoDir(repoPathInput);
  if ("error" in dir) {
    return c.json({ error: "repo_dir_failed", message: dir.error }, 400);
  }
  const repoPath = dir.path;
  // 선택적 — 데스크탑 Claude Code 세션을 이어 받을 때의 그 UUID.
  // 형식 검증은 가볍게 (UUID like). 잘못된 값이면 SDK 가 resume 시 에러를 낸다.
  const resumeFrom =
    typeof body.resumeFrom === "string" && body.resumeFrom.length > 0
      ? body.resumeFrom
      : undefined;
  // 새 세션의 영구 "모든 권한 우회" 플래그. 한 번 켜면 그 세션의 매 turn 마다 자동 적용된다.
  // 명시적으로 true 일 때만 우회 — 누락/잘못된 타입은 안전 기본값 false.
  const skipPermissions = body.skipPermissions === true;
  // runner 는 PTY 만 지원. body.mode 가 'pty' 가 아니면 잘못 만들어진 옛 클라이언트 신호 →
  // 명시적으로 거절해 사용자가 잘못된 옛 모드 세션을 새로 만드는 사고를 막는다.
  if (body.mode !== undefined && body.mode !== "pty") {
    return c.json(
      { error: `mode '${body.mode}' is no longer supported; only 'pty' is available` },
      400,
    );
  }
  // 어떤 코드 에이전트 CLI 로 spawn 할지 — 옛 iOS 빌드는 안 보냄 → DEFAULT_AGENT_ID
  // (claude_code) 로 fallback. 등록 안 된 id 면 즉시 400 으로 거절해 사용자가 동작 안
  // 하는 세션을 만드는 사고 차단.
  const agentId =
    typeof body.agent === "string" && body.agent.length > 0
      ? body.agent
      : DEFAULT_AGENT_ID;
  if (!hasAgent(agentId)) {
    return c.json({ error: `unknown agent: ${agentId}` }, 400);
  }
  // 로컬 추론 세션 동시 1개 제약 — 메모리(~38GB) + `--parallel 1` 서버 공유 보호. local_llm /
  // opencode 를 군으로 묶어, 군을 통틀어 활성 세션이 이미 있으면 거절(cross-adapter race 도 차단).
  if (isLocalInferenceAgent(agentId)) {
    const placeholders = LOCAL_INFERENCE_AGENT_IDS.map(() => "?").join(", ");
    const { n } = db()
      .prepare(
        `SELECT COUNT(*) AS n FROM sessions WHERE agent IN (${placeholders}) AND status = 'active'`,
      )
      .get(...LOCAL_INFERENCE_AGENT_IDS) as { n: number };
    if (n >= LOCAL_INFERENCE_MAX_ACTIVE_SESSIONS) {
      // 에러코드는 기존 호환 유지 — iOS ApiClient 가 `local_llm_session_limit` 를 친절한
      // 메시지로 변환하는 경로를 그대로 재사용한다 (로컬 LLM·OpenCode 공통 안내).
      return c.json(
        { error: "local_llm_session_limit", limit: LOCAL_INFERENCE_MAX_ACTIVE_SESSIONS },
        409,
      );
    }
  }
  const id = createSession(repoPath, body.title, resumeFrom, skipPermissions, agentId);
  // PTY 를 즉시 prewarm — 사용자가 채팅 화면 진입 직후 (=메시지 첫 전송 전에) CLI REPL
  // 의 splash / 이어받기 컨텍스트 복원이 화면에 흐르게 한다. 옛 lazy spawn 은 이어받기
  // 세션을 만들고 들어가면 화면이 비어 있어 「이어받기가 작동 안 한다」 오해를 부름.
  // fire-and-forget — POST 응답은 spawn 완료를 기다리지 않는다.
  try {
    const adapter = getAgent(agentId);
    prewarmPty(
      { sessionId: id, cwd: repoPath, adapter, resumeFrom },
      { bypassPermissions: skipPermissions },
    );
  } catch (e) {
    // adapter 의 binary 없음 등 — 사용자에겐 다음 메시지 전송 시 동일하게 에러가 떠야
    // 일관성. 여기서는 console 만 노이즈로 남기고 응답은 정상 200 유지.
    console.warn(`[sessions.post] prewarm 실패 session=${id}:`, (e as Error).message);
  }
  return c.json({
    sessionId: id,
    repoPath,
    title: body.title ?? null,
    resumeFrom: resumeFrom ?? null,
    skipPermissions,
    mode: "pty",
    agent: agentId,
  });
});

sessions.get("/:id", (c) => {
  const id = c.req.param("id");
  const session = getSession(id);
  if (!session) return c.json({ error: "not_found" }, 404);
  const messages = db()
    .prepare(
      `SELECT id, role, type, payload, created_at
       FROM messages WHERE session_id = ? ORDER BY created_at ASC`,
    )
    .all(id) as Array<{ type: string; payload: string }>;
  // pty_chunk 의 stale 터미널 질의 제거 — replay 경로(WS catch-up)와 동일 정화. 안 하면
  // 초기 전체 로드 때 옛 질의가 SwiftTerm 으로 흘러 에이전트 입력창에 응답이 박힌다.
  return c.json({ session: { ...session, ...sourceBriefField(id) }, messages: sanitizeMessageRows(messages) });
});

// 모바일 ChatView 더보기 메뉴 — 이 세션이 쓰는 코드 에이전트의 토큰 잔량 + 리셋 시각.
// agent 별 조회 경로는 adapter.usage() (claude_code: Keychain+OAuth usage API,
// codex: 세션 rollout jsonl 스냅샷). 토큰 개념이 없거나 (shell) 조회 경로가 없는 (agy)
// agent 는 supported:false — iOS 가 메뉴에서 UI 를 통째로 숨긴다.
sessions.get("/:id/usage", async (c) => {
  const id = c.req.param("id");
  const session = getSession(id);
  if (!session) return c.json({ error: "not_found" }, 404);
  const agentId = session.agent || "claude_code";
  if (!hasAgent(agentId)) return c.json({ supported: false, windows: [] });
  return c.json(await getAgentUsage(getAgent(agentId)));
});

// 모바일 ChatView 상태바용 — 세션의 repo_path 에서 현재 git 브랜치를 조회.
// `symbolic-ref --short HEAD` 로 현재 브랜치명을 얻는다 — 커밋 0개(갓 git init) 에서도 동작.
// 분리된 HEAD 면 symbolic-ref 가 실패 → 짧은 sha(@xxxxxxx)로 보여준다 (사용자는 «어떤
// commit 에 있는지» 만 알면 충분). repo_path 가 git repo 가 아니거나 git 자체가 없으면
// { branch: null } 로 조용히 응답.
sessions.get("/:id/git/branch", async (c) => {
  const id = c.req.param("id");
  const session = getSession(id);
  if (!session) return c.json({ error: "not_found" }, 404);

  const repoPath = session.repo_path;
  if (!repoPath) return c.json({ branch: null });

  // `symbolic-ref --short HEAD` 를 먼저 — 이게 «현재 브랜치» 의 정석. 갓 `git init` 한
  // 커밋 0개 repo(unborn HEAD)에서도 `main` 을 그대로 반환(exit 0)한다. 옛 구현이 쓰던
  // `rev-parse --abbrev-ref HEAD` 는 커밋이 없으면 fatal(exit 128) → null 로 흡수돼
  // 「git init 했는데도 Git 없음」 으로 보이던 버그의 원인이었다.
  // 실패하면(=detached HEAD 이거나 repo 가 아님) 짧은 sha 로 fallback.
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", repoPath, "symbolic-ref", "--short", "HEAD"],
      { timeout: 3000, maxBuffer: 64 * 1024 },
    );
    const name = stdout.trim();
    if (name) return c.json({ branch: name });
    return c.json({ branch: null });
  } catch {
    // symbolic-ref 실패 — detached HEAD(커밋 있음)면 짧은 sha 로, 그 외(repo 아님/git
    // 미설치/경로 없음)는 «브랜치 표시 없음» 으로 흡수.
    try {
      const { stdout: shaOut } = await execFileAsync(
        "git",
        ["-C", repoPath, "rev-parse", "--short", "HEAD"],
        { timeout: 3000, maxBuffer: 64 * 1024 },
      );
      const sha = shaOut.trim();
      return c.json({ branch: sha ? `@${sha}` : null });
    } catch {
      return c.json({ branch: null });
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 모바일 ChatView 상태바 + Diff 시트 — 세션의 repo_path 에서 커밋되지 않은
// 변경점을 조회한다.
//
// 두 엔드포인트가 한 쌍:
//   GET .../git/status        — 파일 목록 + 가벼운 +/- 통계 (상태바 카운트 + 시트 리스트)
//   GET .../git/diff?path=…   — 한 파일의 unified diff 본문 (시트 상세)
//
// 모두 repo_path 가 git repo 가 아니거나 git 자체가 없을 때 조용히 빈 응답을
// 돌려준다 — iOS 측 UI 가 슬롯을 숨기는 것으로 흡수.
// ─────────────────────────────────────────────────────────────────────────────

// diff 본문 cap — 모바일 메모리 부담 회피. 한 파일 200KB 이상이면 잘라서 보낸다.
const GIT_DIFF_MAX_BYTES = 200 * 1024;

/**
 * `git diff --numstat HEAD -- <paths>` 로 path 별 +/- 라인 수를 한꺼번에 조회한다.
 * untracked 는 결과에 없음 — 호출자가 0/0 으로 흡수한다.
 *
 * 출력 형식: `ADD\tDEL\tPATH\n` 또는 binary 면 `-\t-\tPATH\n`.
 */
async function getNumstat(
  repoPath: string,
  paths: string[],
): Promise<Map<string, { additions: number; deletions: number; binary: boolean }>> {
  const map = new Map<string, { additions: number; deletions: number; binary: boolean }>();
  if (paths.length === 0) return map;
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", repoPath, "diff", "--numstat", "HEAD", "--", ...paths],
      { timeout: 5000, maxBuffer: 4 * 1024 * 1024 },
    );
    for (const line of stdout.split("\n")) {
      if (!line) continue;
      const [a, d, ...rest] = line.split("\t");
      const path = rest.join("\t");
      const binary = a === "-" || d === "-";
      map.set(path, {
        additions: binary ? 0 : parseInt(a ?? "0", 10) || 0,
        deletions: binary ? 0 : parseInt(d ?? "0", 10) || 0,
        binary,
      });
    }
  } catch {
    // 첫 commit 이전 / HEAD 없음 등은 무시 — UI 가 0/0 으로 흡수.
  }
  return map;
}

// 모바일 ChatView 상태바 + Diff 시트의 1단계 — 커밋되지 않은 파일 목록과 가벼운 통계.
// 응답: { files: [{ path, status, additions, deletions, binary, origPath? }], total }
// repo 가 아님 / git 미설치 → { files: [], total: 0 } (조용히).
sessions.get("/:id/git/status", async (c) => {
  const id = c.req.param("id");
  const session = getSession(id);
  if (!session) return c.json({ error: "not_found" }, 404);

  const repoPath = session.repo_path;
  if (!repoPath) return c.json({ files: [], total: 0 });

  let entries: GitStatusEntry[] = [];
  try {
    // --untracked-files=all 필수: 기본값(normal)은 untracked 디렉터리를
    // "foo/" 한 줄로 접어버려 새 폴더 안의 개별 파일이 UI 에 안 보인다.
    const { stdout } = await execFileAsync(
      "git",
      ["-C", repoPath, "status", "--porcelain=v1", "-z", "--untracked-files=all"],
      { timeout: 5000, maxBuffer: 4 * 1024 * 1024 },
    );
    entries = parsePorcelainZ(stdout);
  } catch {
    return c.json({ files: [], total: 0 });
  }

  // numstat 은 tracked path 에 대해서만 의미가 있다. untracked('??') 와 deleted 는 제외하고
  // 한 번에 조회 — 모바일 UI 의 «+12 −3» 칩 표시용 가벼운 통계.
  const trackedPaths = entries
    .filter((e) => e.status !== "??" && !e.status.startsWith("D"))
    .map((e) => e.path);
  const stats = await getNumstat(repoPath, trackedPaths);

  const files = entries.map((e) => {
    const s = stats.get(e.path);
    return {
      path: e.path,
      status: e.status,
      additions: s?.additions ?? 0,
      deletions: s?.deletions ?? 0,
      binary: s?.binary ?? false,
      ...(e.origPath ? { origPath: e.origPath } : {}),
    };
  });

  return c.json({ files, total: files.length });
});

// 한 파일의 unified diff 본문. tracked 면 `git diff HEAD -- <path>` (staged+worktree
// 통합) — 사용자가 보고 싶은 "마지막 커밋과의 차이". untracked 는 별도 가공해서 가짜
// unified diff 를 만들어 보낸다 (전 라인 +). binary 는 본문을 생략하고 binary=true.
sessions.get("/:id/git/diff", async (c) => {
  const id = c.req.param("id");
  const session = getSession(id);
  if (!session) return c.json({ error: "not_found" }, 404);

  const repoPath = session.repo_path;
  if (!repoPath) return c.json({ error: "no_repo" }, 404);

  const path = c.req.query("path");
  if (!path) return c.json({ error: "path_required" }, 400);

  // 보안: 절대경로/상위참조 차단. repo_path 안의 상대경로만 받는다.
  if (path.startsWith("/") || path.includes("..")) {
    return c.json({ error: "invalid_path" }, 400);
  }

  // untracked 인지 한 번 확인 — status 결과를 한 번 더 부르긴 무겁지만, 정확성 우선.
  // 평소 경로(tracked)는 git diff 가 untracked 를 무시하므로 빈 본문이 나와 사용자가 혼란.
  let isUntracked = false;
  try {
    // --untracked-files=all: 새 폴더 안 개별 파일의 디프 요청도 정확히 ?? 로
    // 잡으려면 필요. 없으면 디렉터리("foo/")로만 접혀 path 매칭이 어긋나고,
    // tracked 로 오인해 빈 디프가 떠버린다.
    const { stdout } = await execFileAsync(
      "git",
      ["-C", repoPath, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--", path],
      { timeout: 3000, maxBuffer: 256 * 1024 },
    );
    const entries = parsePorcelainZ(stdout);
    isUntracked = entries.some((e) => e.status === "??" && e.path === path);
  } catch {
    // status 가 실패하면 tracked 로 가정하고 아래 diff 로 진행한다.
  }

  if (isUntracked) {
    // 파일을 직접 읽어 가짜 unified diff 합성. binary 일 가능성도 있어 NUL 검출.
    try {
      const fs = await import("node:fs/promises");
      // 심볼릭 링크로 repo 밖(예: ~/.ssh/id_rsa, /etc/*)을 가리키는 untracked path 차단.
      // 기존엔 startsWith("/")||includes("..") 문자열 검사 + 문자열 연결로 repo 밖 파일이
      // 읽혔다 → fs/file 등과 동일하게 resolveRepoRelative 의 realpath prefix 검증을 거친다.
      const r = await resolveRepoRelative(repoPath, path);
      if (!r.ok) return c.json({ error: r.error }, r.error === "no_repo" ? 404 : 400);
      const buf = await fs.readFile(r.abs);
      // 가벼운 binary 휴리스틱 — 앞 8KB 안에 NUL 이 있으면 binary 로 본다.
      const slice = buf.subarray(0, 8192);
      const isBinary = slice.includes(0);
      if (isBinary) {
        return c.json({ path, diff: "", binary: true, truncated: false, untracked: true });
      }
      const text = buf.toString("utf8");
      const lines = text.split("\n");
      // 마지막 빈 줄(파일 끝 newline) 은 +로 표시할 필요 없음.
      const last = lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
      const body =
        `--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${last} @@\n` +
        lines.slice(0, last).map((l) => `+${l}`).join("\n") +
        (lines.slice(0, last).length > 0 ? "\n" : "");
      const truncated = body.length > GIT_DIFF_MAX_BYTES;
      return c.json({
        path,
        diff: truncated ? body.slice(0, GIT_DIFF_MAX_BYTES) : body,
        binary: false,
        truncated,
        untracked: true,
      });
    } catch {
      return c.json({ path, diff: "", binary: false, truncated: false, untracked: true });
    }
  }

  // tracked — staged+worktree 통합 diff. 색 코드는 빼고, no-prefix 는 unified diff 의
  // 표준 `a/`,`b/` 헤더가 사라져서 파서/디스플레이 단순화에 유리하지만 사용자가 익숙한
  // 형식을 유지하기 위해 그대로 둔다.
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", repoPath, "diff", "--no-color", "HEAD", "--", path],
      { timeout: 5000, maxBuffer: 4 * 1024 * 1024 },
    );
    const body = stdout ?? "";
    // binary diff 는 본문에 "Binary files ... differ" 한 줄만 나온다. 그 경우 본문 생략.
    const binary = /^Binary files .* differ$/m.test(body);
    if (binary) {
      return c.json({ path, diff: "", binary: true, truncated: false, untracked: false });
    }
    const truncated = body.length > GIT_DIFF_MAX_BYTES;
    return c.json({
      path,
      diff: truncated ? body.slice(0, GIT_DIFF_MAX_BYTES) : body,
      binary: false,
      truncated,
      untracked: false,
    });
  } catch {
    return c.json({ path, diff: "", binary: false, truncated: false, untracked: false });
  }
});

// 모바일 파일 브라우저 / viewer 용 — 세션 repo_path 아래의 디렉토리·파일을 읽기 전용으로 노출.
// 보안 모델:
//   - 절대경로 / `..` 토큰 차단 (diff 와 동일 패턴).
//   - 심볼릭 링크가 repo 밖을 가리키면 거부 — realpath 로 prefix 검증.
//   - `.git/` 디렉토리는 listing 에서 숨김 (실수 노출 방지). 그 안의 파일 read 도 거부.
//   - 응답 크기 cap — 텍스트 1MB, 이미지 5MB. 초과 시 truncated 또는 too_large.

// fs/file 응답 body cap. 텍스트와 base64 인코딩된 binary 가 합쳐서 이 한도를 넘으면 거부.
// 5MB 면 일반적인 PNG/JPEG 스크린샷은 충분히 통과하고, 비현실적인 RAW/PSD 는 막힌다.
const FS_FILE_MAX_BYTES = 5 * 1024 * 1024;
// 텍스트로 읽을 때만 별도로 적용되는 더 작은 cap — 모바일에서 1MB 넘는 텍스트 viewer 는 부담.
const FS_TEXT_MAX_BYTES = 1 * 1024 * 1024;

/**
 * repoPath 안의 상대경로를 절대경로로 안전하게 해석한다.
 *   - 빈 문자열 / undefined 면 repo root.
 *   - 절대경로 / `..` 토큰은 거부.
 *   - 심볼릭 링크가 repo 밖을 가리키면 거부 (realpath prefix 검증).
 *   - `.git` 직접/하위 경로는 차단.
 *
 * 반환: `{ ok: true, abs }` 또는 `{ ok: false, error }`.
 */
async function resolveRepoRelative(
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

// 파일 / 디렉토리 listing. 응답:
//   { path, parent: <rel|null>, entries: [{ name, isDirectory, size, modifiedAt }] }
// entries 는 디렉토리 먼저, 그 안에서 이름 사전순.
sessions.get("/:id/fs/list", async (c) => {
  const id = c.req.param("id");
  const session = getSession(id);
  if (!session) return c.json({ error: "not_found" }, 404);

  const repoPath = session.repo_path;
  if (!repoPath) return c.json({ error: "no_repo" }, 404);

  const r = await resolveRepoRelative(repoPath, c.req.query("path"));
  if (!r.ok) return c.json({ error: r.error }, r.error === "no_repo" ? 404 : 400);

  const fs = await import("node:fs/promises");
  const path = await import("node:path");

  let dirents: Array<{ name: string; isDirectory: boolean; size: number; modifiedAt: number }>;
  try {
    const list = await fs.readdir(r.abs, { withFileTypes: true });
    dirents = await Promise.all(
      list
        // `.git` 디렉토리는 숨김. 그 외 dotfile 은 노출 (사용자가 보고 싶을 수 있음).
        .filter((d) => !(d.name === ".git" && d.isDirectory()))
        .map(async (d) => {
          let size = 0;
          let modifiedAt = 0;
          try {
            const st = await fs.stat(path.join(r.abs, d.name));
            size = Number(st.size);
            modifiedAt = Math.floor(st.mtimeMs);
          } catch {
            // 권한 없음 / broken symlink — 0 으로 흡수.
          }
          return { name: d.name, isDirectory: d.isDirectory(), size, modifiedAt };
        }),
    );
  } catch (e: any) {
    if (e?.code === "ENOENT") return c.json({ error: "not_found" }, 404);
    if (e?.code === "ENOTDIR") return c.json({ error: "not_a_directory" }, 400);
    return c.json({ error: "read_failed" }, 500);
  }
  dirents.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  const parent = r.rel === "" ? null : r.rel.includes("/") ? r.rel.slice(0, r.rel.lastIndexOf("/")) : "";
  return c.json({ path: r.rel, parent, entries: dirents });
});

// 파일 read. Content-Type 자동 판별:
//   - 텍스트(NUL 없음) → { encoding: "utf8", content, contentType: "text/plain" }
//   - 이미지 확장자 → { encoding: "base64", content, contentType: "image/<ext>" }
//   - 그 외 binary → { encoding: "base64", content, contentType: "application/octet-stream" }
// truncated 는 텍스트 한정 — binary 는 cap 초과 시 too_large 로 거절 (잘린 base64 는 deserialize 불가).
sessions.get("/:id/fs/file", async (c) => {
  const id = c.req.param("id");
  const session = getSession(id);
  if (!session) return c.json({ error: "not_found" }, 404);

  const repoPath = session.repo_path;
  if (!repoPath) return c.json({ error: "no_repo" }, 404);

  const queryPath = c.req.query("path");
  if (!queryPath) return c.json({ error: "path_required" }, 400);

  const r = await resolveRepoRelative(repoPath, queryPath);
  if (!r.ok) return c.json({ error: r.error }, 400);

  const fs = await import("node:fs/promises");
  let buf: Buffer;
  let size: number;
  try {
    const st = await fs.stat(r.abs);
    if (st.isDirectory()) return c.json({ error: "is_a_directory" }, 400);
    size = Number(st.size);
    if (size > FS_FILE_MAX_BYTES) return c.json({ error: "too_large", size, max: FS_FILE_MAX_BYTES }, 413);
    buf = await fs.readFile(r.abs);
  } catch (e: any) {
    if (e?.code === "ENOENT") return c.json({ error: "not_found" }, 404);
    return c.json({ error: "read_failed" }, 500);
  }

  const ext = r.rel.toLowerCase().split(".").pop() ?? "";
  const imageExt: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    heic: "image/heic",
    heif: "image/heif",
    bmp: "image/bmp",
    tiff: "image/tiff",
    tif: "image/tiff",
    svg: "image/svg+xml",
  };
  if (imageExt[ext]) {
    return c.json({
      path: r.rel,
      size,
      encoding: "base64",
      contentType: imageExt[ext],
      content: buf.toString("base64"),
      truncated: false,
    });
  }

  // 텍스트 판정 — 앞 8KB 에 NUL 이 있으면 binary 로 분류.
  const head = buf.subarray(0, Math.min(8192, buf.length));
  const isBinary = head.includes(0);
  if (isBinary) {
    return c.json({
      path: r.rel,
      size,
      encoding: "base64",
      contentType: "application/octet-stream",
      content: buf.toString("base64"),
      truncated: false,
    });
  }
  const truncated = buf.length > FS_TEXT_MAX_BYTES;
  const sliced = truncated ? buf.subarray(0, FS_TEXT_MAX_BYTES) : buf;
  return c.json({
    path: r.rel,
    size,
    encoding: "utf8",
    contentType: "text/plain",
    content: sliced.toString("utf8"),
    truncated,
  });
});

// ── 라이브 산출물(artifacts_v1) ──────────────────────────────────────────────
// 세션이 만든 «시각적 산출물» 을 자동 발견 + raw 스트리밍. iOS «결과» 시트의 «산출물»
// 세그먼트가 QuickLook 으로 렌더 (이미지·PDF·동영상·오디오·Office·USDZ).

/** 확장자 → 산출물 종류. iOS 가 썸네일/아이콘/렌더 경로를 분기. */
const ARTIFACT_KIND: Record<string, string> = {
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image",
  heic: "image", heif: "image", bmp: "image", tiff: "image", tif: "image", svg: "image",
  pdf: "pdf",
  mp4: "video", mov: "video", m4v: "video", webm: "video",
  mp3: "audio", wav: "audio", m4a: "audio", aac: "audio",
  usdz: "model",
  md: "markdown", markdown: "markdown",
  doc: "doc", docx: "doc", xls: "doc", xlsx: "doc", ppt: "doc", pptx: "doc",
  html: "web", htm: "web",
};

/** 발견 walk 에서 통째로 건너뛸 디렉토리 — 의존성/빌드 산출물(노이즈 + 거대). .git 도. */
const ARTIFACT_SKIP_DIRS = new Set([
  ".git", "node_modules", "dist", "build", ".next", ".nuxt", "out", "target",
  ".venv", "venv", "__pycache__", ".cache", "coverage", ".turbo", "vendor",
  "Pods", "DerivedData", ".gradle", ".idea", "bower_components",
]);

const ARTIFACT_MAX_RESULTS = 200;
const ARTIFACT_MAX_DEPTH = 6;
const ARTIFACT_MAX_VISITED = 20000; // walk 비용 상한 (거대 repo 방어)

// raw 스트리밍 cap — 대부분의 산출물(스크린샷·PDF·짧은 클립)은 한참 아래. 초과 시 413.
const FS_RAW_MAX_BYTES = 64 * 1024 * 1024;

/** 확장자별 raw content-type (QuickLook 은 temp 파일 확장자로도 판별하지만 명시). */
const RAW_CONTENT_TYPE: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", heic: "image/heic", heif: "image/heif", bmp: "image/bmp",
  tiff: "image/tiff", tif: "image/tiff", svg: "image/svg+xml",
  pdf: "application/pdf",
  mp4: "video/mp4", mov: "video/quicktime", m4v: "video/x-m4v", webm: "video/webm",
  mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", aac: "audio/aac",
  usdz: "model/vnd.usdz+zip",
  md: "text/markdown", markdown: "text/markdown",
  html: "text/html", htm: "text/html",
};

// GET /api/sessions/:id/artifacts?limit=N
// 세션 repo_path 를 재귀 walk 해 렌더 가능한 파일을 mtime 내림차순으로 반환.
// 응답: { artifacts: [{ path, name, ext, kind, size, modifiedAt }], total, truncated }
sessions.get("/:id/artifacts", async (c) => {
  const id = c.req.param("id");
  const session = getSession(id);
  if (!session) return c.json({ error: "not_found" }, 404);
  const repoPath = session.repo_path;
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  if (!repoPath) return c.json({ artifacts: [], total: 0, truncated: false, dir: "", subdirs: [] });

  const limit = Math.max(1, Math.min(ARTIFACT_MAX_RESULTS, Number(c.req.query("limit")) || 100));

  // dir: 발견 범위를 repo 하위 폴더로 좁힌다(프로젝트에 산출물과 무관한 파일이 많을 때 노이즈
  // 제거). 빈 문자열 = repo 루트(전체). 정규화 후 traversal(..)·절대경로·스킵 디렉토리를 막고
  // resolve 결과가 repo 밖으로 새지 않는지 확인한다.
  const rawDir = (c.req.query("dir") ?? "").replace(/^\/+|\/+$/g, "");
  const dirParts = rawDir === "" ? [] : rawDir.split("/");
  const badDir = dirParts.some(
    (p) => p === "" || p === "." || p === ".." || ARTIFACT_SKIP_DIRS.has(p),
  );
  if (badDir) return c.json({ error: "bad_dir" }, 400);
  const baseAbs = dirParts.length ? path.join(repoPath, ...dirParts) : repoPath;
  const resolvedBase = path.resolve(baseAbs);
  const resolvedRepo = path.resolve(repoPath);
  if (resolvedBase !== resolvedRepo && !resolvedBase.startsWith(resolvedRepo + path.sep)) {
    return c.json({ error: "bad_dir" }, 400);
  }
  const dir = dirParts.join("/");
  try {
    const st = await fs.stat(baseAbs);
    if (!st.isDirectory()) return c.json({ error: "bad_dir" }, 400);
  } catch {
    // 폴더가 사라짐(세션 중 삭제/이동 등) — 빈 결과로 안전 반환.
    return c.json({ artifacts: [], total: 0, truncated: false, dir, subdirs: [] });
  }

  type Art = { path: string; name: string; ext: string; kind: string; size: number; modifiedAt: number };
  const found: Art[] = [];
  let visited = 0;

  async function walk(absDir: string, relDir: string, depth: number): Promise<void> {
    if (depth > ARTIFACT_MAX_DEPTH || visited > ARTIFACT_MAX_VISITED) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (visited > ARTIFACT_MAX_VISITED) return;
      visited++;
      const rel = relDir === "" ? e.name : `${relDir}/${e.name}`;
      if (e.isDirectory()) {
        if (ARTIFACT_SKIP_DIRS.has(e.name)) continue;
        await walk(path.join(absDir, e.name), rel, depth + 1);
        continue;
      }
      if (!e.isFile()) continue;
      const ext = e.name.toLowerCase().split(".").pop() ?? "";
      const kind = ARTIFACT_KIND[ext];
      if (!kind) continue;
      try {
        const st = await fs.stat(path.join(absDir, e.name));
        found.push({
          path: rel, name: e.name, ext, kind,
          size: Number(st.size), modifiedAt: Math.floor(st.mtimeMs),
        });
      } catch {
        // 권한 없음 / broken symlink — skip.
      }
    }
  }

  try {
    await walk(baseAbs, dir, 0);
  } catch {
    return c.json({ artifacts: [], total: 0, truncated: false, dir, subdirs: [] });
  }
  found.sort((a, b) => b.modifiedAt - a.modifiedAt);

  // 현재 dir «바로 아래» 자식 폴더 중 (하위까지 통틀어) 산출물을 가진 것 — iOS 드릴다운 칩용.
  const prefix = dir === "" ? "" : dir + "/";
  const subdirSet = new Set<string>();
  for (const a of found) {
    const relToBase = prefix === "" ? a.path : a.path.slice(prefix.length);
    const slash = relToBase.indexOf("/");
    if (slash > 0) subdirSet.add(relToBase.slice(0, slash));
  }
  const subdirs = [...subdirSet].sort((a, b) => a.localeCompare(b));

  const truncated = found.length > limit;
  return c.json({ artifacts: found.slice(0, limit), total: found.length, truncated, dir, subdirs });
});

// GET /api/sessions/:id/fs/raw?path=<rel>
// 파일 raw 바이트를 content-type 과 함께 반환 (QuickLook 다운로드용 — base64/JSON cap 회피).
sessions.get("/:id/fs/raw", async (c) => {
  const id = c.req.param("id");
  const session = getSession(id);
  if (!session) return c.json({ error: "not_found" }, 404);
  const repoPath = session.repo_path;
  if (!repoPath) return c.json({ error: "no_repo" }, 404);

  const queryPath = c.req.query("path");
  if (!queryPath) return c.json({ error: "path_required" }, 400);
  const r = await resolveRepoRelative(repoPath, queryPath);
  if (!r.ok) return c.json({ error: r.error }, 400);

  const fs = await import("node:fs/promises");
  let buf: Buffer;
  try {
    const st = await fs.stat(r.abs);
    if (st.isDirectory()) return c.json({ error: "is_a_directory" }, 400);
    if (Number(st.size) > FS_RAW_MAX_BYTES) {
      return c.json({ error: "too_large", size: Number(st.size), max: FS_RAW_MAX_BYTES }, 413);
    }
    buf = await fs.readFile(r.abs);
  } catch (e: any) {
    if (e?.code === "ENOENT") return c.json({ error: "not_found" }, 404);
    return c.json({ error: "read_failed" }, 500);
  }
  const ext = r.rel.toLowerCase().split(".").pop() ?? "";
  const contentType = RAW_CONTENT_TYPE[ext] ?? "application/octet-stream";
  // Buffer → fresh ArrayBuffer-backed Uint8Array (Hono Data 타입 호환).
  return c.body(new Uint8Array(buf), 200, {
    "Content-Type": contentType,
    "Content-Length": String(buf.length),
    "Cache-Control": "no-store",
  });
});

// 특정 git ref 의 파일 내용 (주로 HEAD) — 이미지 diff 의 «변경 전» 측에서 사용.
// 응답은 fs/file 과 동일 형식. ref 가 없는(HEAD 없는 신규 repo) 경우 not_found.
sessions.get("/:id/git/blob", async (c) => {
  const id = c.req.param("id");
  const session = getSession(id);
  if (!session) return c.json({ error: "not_found" }, 404);

  const repoPath = session.repo_path;
  if (!repoPath) return c.json({ error: "no_repo" }, 404);

  const queryPath = c.req.query("path");
  if (!queryPath) return c.json({ error: "path_required" }, 400);

  const r = await resolveRepoRelative(repoPath, queryPath);
  if (!r.ok) return c.json({ error: r.error }, 400);

  const refRaw = c.req.query("ref") ?? "HEAD";
  // 보안: ref 도 외부 인자 — `..` 같은 path-traversal 토큰은 git 의 rev-parse 가 막아주지만
  // shell escape 가능성을 줄이기 위해 토큰 자체를 좁힌다 (영숫자 / `_` `/` `-` `.` `^` `~`).
  if (!/^[A-Za-z0-9_./^~-]{1,200}$/.test(refRaw)) {
    return c.json({ error: "invalid_ref" }, 400);
  }
  const spec = `${refRaw}:${r.rel}`;

  // 1) 사이즈 체크 — cat-file -s 로 먼저 cap 검사. 큰 파일을 통째로 받은 뒤에 거절하면 메모리 낭비.
  let size: number;
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", repoPath, "cat-file", "-s", spec],
      { timeout: 5000, maxBuffer: 64 * 1024 },
    );
    size = parseInt(stdout.trim(), 10);
    if (!Number.isFinite(size)) throw new Error("bad_size");
  } catch {
    return c.json({ error: "not_found" }, 404);
  }
  if (size > FS_FILE_MAX_BYTES) {
    return c.json({ error: "too_large", size, max: FS_FILE_MAX_BYTES }, 413);
  }

  let buf: Buffer;
  try {
    // raw bytes 가 필요 — encoding 미지정으로 호출하면 stdout 이 Buffer.
    const { stdout } = await execFileAsync(
      "git",
      ["-C", repoPath, "cat-file", "blob", spec],
      { timeout: 5000, maxBuffer: FS_FILE_MAX_BYTES + 4096, encoding: "buffer" },
    );
    buf = stdout as unknown as Buffer;
  } catch {
    return c.json({ error: "not_found" }, 404);
  }

  const ext = r.rel.toLowerCase().split(".").pop() ?? "";
  const imageExt: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    heic: "image/heic",
    heif: "image/heif",
    bmp: "image/bmp",
    tiff: "image/tiff",
    tif: "image/tiff",
    svg: "image/svg+xml",
  };
  if (imageExt[ext]) {
    return c.json({
      path: r.rel,
      ref: refRaw,
      size,
      encoding: "base64",
      contentType: imageExt[ext],
      content: buf.toString("base64"),
      truncated: false,
    });
  }

  const head = buf.subarray(0, Math.min(8192, buf.length));
  const isBinary = head.includes(0);
  if (isBinary) {
    return c.json({
      path: r.rel,
      ref: refRaw,
      size,
      encoding: "base64",
      contentType: "application/octet-stream",
      content: buf.toString("base64"),
      truncated: false,
    });
  }
  const truncated = buf.length > FS_TEXT_MAX_BYTES;
  const sliced = truncated ? buf.subarray(0, FS_TEXT_MAX_BYTES) : buf;
  return c.json({
    path: r.rel,
    ref: refRaw,
    size,
    encoding: "utf8",
    contentType: "text/plain",
    content: sliced.toString("utf8"),
    truncated,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 모바일 BranchSheet — 브랜치 목록 / 전환 / 생성 + git worktree 관리.
//
// 한 세션은 하나의 repo_path(에이전트 cwd)에 묶여 있다. 여러 브랜치를 병렬로 작업하려면
// in-place checkout(미커밋 변경이 있으면 실패하고 현재 세션 작업 디렉토리를 흔든다) 대신
// worktree(인접 디렉토리에 다른 브랜치를 동시 체크아웃)가 자연스럽다 — 새 worktree 경로로
// 새 세션을 만들면 원래 세션을 건드리지 않고 다른 브랜치를 작업할 수 있다.
//
// 안전: 모든 mutating 동작은 repo_path 안에서 `-C` 로만 돈다. execFile 은 shell 을 거치지
// 않으므로 shell 주입은 없고, 남는 위협은 «`-` 로 시작하는 인자가 git 플래그로 해석되는»
// argument injection 뿐 → isValidRef 가 거른다. worktree 삭제는 git 이 실제로 추적 중인
// path 만(목록 대조), 그것도 main / 현재 세션 worktree 가 아닐 때만 허용한다.
// ─────────────────────────────────────────────────────────────────────────────

// isValidRef / WorktreeEntry / parseWorktreeList / listWorktrees 는 ../git/worktree.js 로
// 옮겨 새 세션 스크린의 repoPath 기반 worktree 생성(routes/git.ts)과 코드를 공유한다.
// (파일 상단 import 참고.) samePath 는 세션 라우트 전용이라 여기 남는다.

/** 두 경로가 같은 worktree 를 가리키는지 — realpath 정규화 후 비교. */
async function samePath(a: string, b: string | null): Promise<boolean> {
  if (!b) return false;
  const fs = await import("node:fs/promises");
  try {
    return (await fs.realpath(a)) === (await fs.realpath(b));
  } catch {
    return a === b;
  }
}

// 브랜치 목록 — 로컬(refs/heads) + 원격(refs/remotes). 응답:
//   { current: string|null, local: [Branch], remote: [Branch] }
//   Branch = { name, sha, upstream: string|null, subject, current }
// current 는 git/branch 와 동일하게 symbolic-ref 로 구한다(unborn HEAD 도 main 반환).
// 비-repo / git 미설치 → 모두 비고 current=null.
//
// 원격 목록은 refs/remotes(로컬 캐시) 를 읽기 «전에» git fetch --prune 을 best-effort 로
// 한 번 돌려 최신화한다 — 안 그러면 (a) 원격에 새로 생긴 브랜치가 안 보이고 (b) 원격에서
// 삭제된 브랜치의 유령 ref 가 계속 남는다. fetch 는 네트워크/인증 실패·타임아웃이어도 무시하고
// 캐시된 ref 로 폴백한다(목록이 절대 멈추지 않게). 폴링이 아니라 시트 열기/당겨서 새로고침에서만
// 호출되므로 매 호출 fetch 가 허용된다. ?fetch=0 으로 명시적으로 끌 수 있다(폴백/디버그용).
sessions.get("/:id/git/branches", async (c) => {
  const id = c.req.param("id");
  const session = getSession(id);
  if (!session) return c.json({ error: "not_found" }, 404);
  const repoPath = session.repo_path;
  if (!repoPath) return c.json({ current: null, local: [], remote: [] });
  const doFetch = c.req.query("fetch") !== "0";

  let current: string | null = null;
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", repoPath, "symbolic-ref", "--short", "HEAD"],
      { timeout: 3000, maxBuffer: 64 * 1024 },
    );
    current = stdout.trim() || null;
  } catch {
    current = null;
  }

  // NUL 필드 구분 + 줄(\n) 레코드 구분. contents:subject 는 첫 줄만이라 개행 없음 → 안전.
  const FMT = "%(refname:short)%00%(objectname:short)%00%(upstream:short)%00%(contents:subject)";
  const fetchRefs = async (
    ns: string,
  ): Promise<Array<{ name: string; sha: string; upstream: string | null; subject: string }>> => {
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["-C", repoPath, "for-each-ref", `--format=${FMT}`, ns],
        { timeout: 5000, maxBuffer: 4 * 1024 * 1024 },
      );
      const rows: Array<{ name: string; sha: string; upstream: string | null; subject: string }> = [];
      for (const line of stdout.split("\n")) {
        if (!line) continue;
        const [name, sha, upstream, subject] = line.split("\0");
        if (!name) continue;
        // origin/HEAD 같은 원격 symref 포인터는 목록에서 제외.
        if (name.endsWith("/HEAD")) continue;
        rows.push({ name, sha: sha ?? "", upstream: upstream || null, subject: subject ?? "" });
      }
      return rows;
    } catch {
      return [];
    }
  };

  // 원격 추적 ref 를 읽기 전에 한 번 fetch --prune (best-effort). remote 가 하나도 없으면
  // 건너뛴다(로컬-only repo 에서 무의미한 fetch 시도 방지). 로컬 브랜치 조회는 fetch 를
  // 기다리지 않고 병렬로 진행한다.
  const refreshRemotes = async (): Promise<void> => {
    if (!doFetch) return;
    let hasRemote = false;
    try {
      const { stdout } = await execFileAsync("git", ["-C", repoPath, "remote"], {
        timeout: 3000,
        maxBuffer: 64 * 1024,
      });
      hasRemote = stdout.trim().length > 0;
    } catch {
      hasRemote = false;
    }
    if (!hasRemote) return;
    try {
      await execFileAsync("git", ["-C", repoPath, "fetch", "--prune", "--quiet"], {
        timeout: 20000,
        maxBuffer: 1024 * 1024,
      });
    } catch {
      // 네트워크 없음/인증 실패/타임아웃 — 캐시된 refs/remotes 로 폴백.
    }
  };

  const [localRows, remoteRows] = await Promise.all([
    fetchRefs("refs/heads"),
    refreshRemotes().then(() => fetchRefs("refs/remotes")),
  ]);
  const local = localRows.map((r) => ({ ...r, current: r.name === current }));
  const remote = remoteRows.map((r) => ({ ...r, current: false }));
  return c.json({ current, local, remote });
});

// ─────────────────────────────────────────────────────────────────────────────
// 모바일 CommitsView — 커밋 로그 / 한 커밋의 변경 파일 / 파일별 commit-scoped diff.
// BranchSheet 에서 진입한다. 모두 읽기 전용(git log / git show)이고 repo_path 안에서 `-C`
// 로만 돈다. ref(브랜치/커밋 sha)는 isValidRef 로 거른다(argument injection 차단).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `git show --name-status -z` 출력 파싱 → path 별 { status, origPath }.
 * 비-rename 은 `STATUS\0path\0`, rename/copy(R/C)는 `R100\0old\0new\0` (세 토큰).
 * status 는 두 글자 porcelain 모양으로 정규화 (예 "M ") — iOS GitStatusFile.primaryStatus 와 호환.
 */
function parseCommitNameStatus(
  stdout: string,
): Map<string, { status: string; origPath?: string }> {
  const map = new Map<string, { status: string; origPath?: string }>();
  const parts = stdout.split("\0");
  let i = 0;
  while (i < parts.length) {
    const code = parts[i];
    if (!code) {
      i++;
      continue;
    }
    if (/^[RC]/.test(code)) {
      const oldP = parts[i + 1];
      const newP = parts[i + 2];
      if (newP) map.set(newP, { status: `${code[0]} `, origPath: oldP || undefined });
      i += 3;
    } else {
      const p = parts[i + 1];
      if (p) map.set(p, { status: `${code[0]} ` });
      i += 2;
    }
  }
  return map;
}

/**
 * `git show --numstat -z` 출력 파싱 → path 별 { additions, deletions, binary }.
 * 비-rename 은 `ADD\tDEL\tpath\0`, binary 는 `-\t-\tpath\0`,
 * rename 은 `ADD\tDEL\t\0old\0new\0` (남은 path 가 빈 토큰 → 다음 두 토큰이 old·new).
 */
function parseCommitNumstat(
  stdout: string,
): Map<string, { additions: number; deletions: number; binary: boolean }> {
  const map = new Map<string, { additions: number; deletions: number; binary: boolean }>();
  const parts = stdout.split("\0");
  let i = 0;
  while (i < parts.length) {
    const head = parts[i];
    if (!head) {
      i++;
      continue;
    }
    const m = head.match(/^(-|\d+)\t(-|\d+)\t([\s\S]*)$/);
    if (!m) {
      i++;
      continue;
    }
    const binary = m[1] === "-" || m[2] === "-";
    const val = {
      additions: binary ? 0 : parseInt(m[1], 10) || 0,
      deletions: binary ? 0 : parseInt(m[2], 10) || 0,
      binary,
    };
    if (m[3].length > 0) {
      map.set(m[3], val);
      i += 1;
    } else {
      // rename/copy — old=parts[i+1], new=parts[i+2].
      const newP = parts[i + 2];
      if (newP) map.set(newP, val);
      i += 3;
    }
  }
  return map;
}

/**
 * 한 커밋이 바꾼 파일 목록 — name-status(상태/rename) 와 numstat(+/-,binary)를 병합한다.
 * git status 와 같은 GitStatusFile shape 로 돌려줘 iOS DiffFileRow 를 그대로 재사용한다.
 * 머지 커밋은 `git show` 가 기본으로 diff 를 안 내므로 빈 배열(앱이 «변경 내용 없음» 표시).
 */
async function getCommitFiles(
  repoPath: string,
  sha: string,
): Promise<
  Array<{
    path: string;
    status: string;
    additions: number;
    deletions: number;
    binary: boolean;
    origPath?: string;
  }>
> {
  let statusMap = new Map<string, { status: string; origPath?: string }>();
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", repoPath, "show", "--no-color", "--format=", "--name-status", "-z", sha],
      { timeout: 8000, maxBuffer: 8 * 1024 * 1024 },
    );
    statusMap = parseCommitNameStatus(stdout);
  } catch {
    return [];
  }
  let statMap = new Map<string, { additions: number; deletions: number; binary: boolean }>();
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", repoPath, "show", "--no-color", "--format=", "--numstat", "-z", sha],
      { timeout: 8000, maxBuffer: 8 * 1024 * 1024 },
    );
    statMap = parseCommitNumstat(stdout);
  } catch {
    // 통계 없이도 파일 목록·상태는 보여준다 — 카운트는 0/0 으로 흡수(iOS 가 라벨 생략).
  }
  const files: Array<{
    path: string;
    status: string;
    additions: number;
    deletions: number;
    binary: boolean;
    origPath?: string;
  }> = [];
  for (const [path, s] of statusMap) {
    const st = statMap.get(path);
    files.push({
      path,
      status: s.status,
      additions: st?.additions ?? 0,
      deletions: st?.deletions ?? 0,
      binary: st?.binary ?? false,
      ...(s.origPath ? { origPath: s.origPath } : {}),
    });
  }
  return files;
}

// 커밋 로그. query: ?limit=(기본50,최대200) &skip= &ref=(브랜치/커밋, 기본 현재 HEAD)
// 응답: { commits: [{ sha, shortSha, author, date, subject }], total }
//   total 은 이 페이지 개수(전체 카운트는 비싸서 생략) — 클라가 limit 만큼 받으면 «더 보기».
//   date 는 author date 의 strict ISO-8601(%aI). 비-repo / unborn HEAD / git 미설치 →
//   { commits: [], total: 0 } 로 조용히 흡수.
sessions.get("/:id/git/commits", async (c) => {
  const id = c.req.param("id");
  const session = getSession(id);
  if (!session) return c.json({ error: "not_found" }, 404);
  const repoPath = session.repo_path;
  if (!repoPath) return c.json({ commits: [], total: 0 });

  const limitRaw = c.req.query("limit");
  const limit = limitRaw ? Math.min(200, Math.max(1, parseInt(limitRaw, 10) || 50)) : 50;
  const skipRaw = c.req.query("skip");
  const skip = skipRaw ? Math.max(0, parseInt(skipRaw, 10) || 0) : 0;
  const refRaw = c.req.query("ref");
  const ref = refRaw && refRaw.length > 0 ? refRaw : undefined;
  if (ref !== undefined && !isValidRef(ref)) return c.json({ error: "invalid_ref" }, 400);
  // checkpointsOnly=1 → 체크포인트 타임라인용. 식별 prefix 로 시작하는 커밋만 추린다.
  // CHECKPOINT_PREFIX 는 고정 리터럴(사용자 입력 아님)이라 주입 위험 없음. `(` `)` `:` 는
  // git 기본(basic) 정규식에서 리터럴이고 `^` 만 메시지 줄 시작에 앵커한다 → subject 가 prefix
  // 로 시작하는 커밋만 매치(자동/수동/되돌림 마커 모두 같은 prefix 를 쓴다).
  const checkpointsOnly = c.req.query("checkpointsOnly") === "1";

  // NUL 필드 + \x1e 레코드 구분 — author/subject 에 어떤 문자가 와도 안 깨진다(subject %s 는
  // 한 줄). git 은 레코드마다 개행을 덧붙이므로 split 후 앞쪽 개행 한 개를 떼어낸다.
  const FMT = "%H%x00%h%x00%an%x00%aI%x00%s%x1e";
  const args = [
    "-C",
    repoPath,
    "log",
    `--format=${FMT}`,
    `--max-count=${limit}`,
    `--skip=${skip}`,
  ];
  if (checkpointsOnly) args.push(`--grep=^${CHECKPOINT_PREFIX}`);
  if (ref) args.push(ref);
  let stdout = "";
  try {
    ({ stdout } = await execFileAsync("git", args, {
      timeout: 8000,
      maxBuffer: 16 * 1024 * 1024,
    }));
  } catch {
    return c.json({ commits: [], total: 0 });
  }
  const commits: Array<{
    sha: string;
    shortSha: string;
    author: string;
    date: string;
    subject: string;
  }> = [];
  for (const rec of stdout.split("\x1e")) {
    const line = rec.replace(/^\n/, "");
    if (!line) continue;
    const [sha, shortSha, author, date, subject] = line.split("\0");
    if (!sha) continue;
    commits.push({
      sha,
      shortSha: shortSha ?? "",
      author: author ?? "",
      date: date ?? "",
      subject: subject ?? "",
    });
  }
  return c.json({ commits, total: commits.length });
});

// 한 커밋 메타 + 변경 파일 목록. 응답:
//   { sha, shortSha, author, date, subject, body, files: [GitStatusFile shape] }
// sha 가 없거나 해석 불가면 404.
sessions.get("/:id/git/commit/:sha", async (c) => {
  const id = c.req.param("id");
  const session = getSession(id);
  if (!session) return c.json({ error: "not_found" }, 404);
  const repoPath = session.repo_path;
  if (!repoPath) return c.json({ error: "no_repo" }, 404);
  const sha = c.req.param("sha");
  if (!isValidRef(sha)) return c.json({ error: "invalid_ref" }, 400);

  let meta: {
    sha: string;
    shortSha: string;
    author: string;
    date: string;
    subject: string;
    body: string;
  };
  try {
    const FMT = "%H%x00%h%x00%an%x00%aI%x00%s%x00%b";
    const { stdout } = await execFileAsync(
      "git",
      ["-C", repoPath, "show", "-s", `--format=${FMT}`, sha],
      { timeout: 5000, maxBuffer: 2 * 1024 * 1024 },
    );
    const [full, short, author, date, subject, ...bodyParts] = stdout.split("\0");
    meta = {
      sha: (full ?? "").trim(),
      shortSha: short ?? "",
      author: author ?? "",
      date: date ?? "",
      subject: subject ?? "",
      body: bodyParts.join("\0").replace(/\n+$/, ""),
    };
    if (!meta.sha) return c.json({ error: "not_found" }, 404);
  } catch {
    return c.json({ error: "not_found" }, 404);
  }
  const files = await getCommitFiles(repoPath, sha);
  return c.json({ ...meta, files });
});

// 한 커밋이 한 파일에 가한 변경만 unified diff (commit-scoped). query: ?path=
//   `git show <sha> -- <path>` — 그 커밋의 그 파일 patch. 응답은 git/diff 와 동일 shape:
//   { path, diff, binary, truncated, untracked:false }. binary 면 본문 생략, 200KB 초과면 cut.
sessions.get("/:id/git/commit/:sha/diff", async (c) => {
  const id = c.req.param("id");
  const session = getSession(id);
  if (!session) return c.json({ error: "not_found" }, 404);
  const repoPath = session.repo_path;
  if (!repoPath) return c.json({ error: "no_repo" }, 404);
  const sha = c.req.param("sha");
  if (!isValidRef(sha)) return c.json({ error: "invalid_ref" }, 400);
  const path = c.req.query("path");
  if (!path) return c.json({ error: "path_required" }, 400);
  if (path.startsWith("/") || path.includes("..")) {
    return c.json({ error: "invalid_path" }, 400);
  }

  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", repoPath, "show", "--no-color", "--format=", sha, "--", path],
      { timeout: 8000, maxBuffer: 8 * 1024 * 1024 },
    );
    // `--format=` 가 빈 헤더 자리에 남기는 선두 개행을 제거 — diff 본문만 깔끔히.
    const body = (stdout ?? "").replace(/^\n+/, "");
    const binary = /^Binary files .* differ$/m.test(body);
    if (binary) {
      return c.json({ path, diff: "", binary: true, truncated: false, untracked: false });
    }
    const truncated = body.length > GIT_DIFF_MAX_BYTES;
    return c.json({
      path,
      diff: truncated ? body.slice(0, GIT_DIFF_MAX_BYTES) : body,
      binary: false,
      truncated,
      untracked: false,
    });
  } catch {
    return c.json({ path, diff: "", binary: false, truncated: false, untracked: false });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 체크포인트 (git 쓰기) — «나비효과» 공포 흡수용 안전망.
//
//   체크포인트 = 작업트리 전체 스냅샷 = `git add -A && git commit --allow-empty -m
//   "checkpoint(ps): …"`. 식별 prefix `checkpoint(ps):` 로 일반 커밋과 구분 — iOS 가
//   이 prefix 로 «되돌리기» 가능한 항목을 가려낸다. --allow-empty 라 깨끗한 트리에서도
//   «현재 상태» 를 가리키는 복원점을 항상 남긴다.
// ─────────────────────────────────────────────────────────────────────────────

/** 체크포인트 커밋 메시지의 식별 prefix. 변경 시 iOS `GitCommit.isCheckpoint` 도 함께. */
const CHECKPOINT_PREFIX = "checkpoint(ps):";

/** 사용자 노트를 커밋 제목 한 줄로 정제 — 개행/제어문자 제거, 길이 제한. */
function sanitizeCheckpointNote(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const oneLine = raw.replace(/[\r\n\t]+/g, " ").trim();
  if (oneLine.length === 0) return null;
  return oneLine.slice(0, 200);
}

/** `git rev-parse [--short] <rev>` — 실패하면 빈 문자열. */
async function revParse(repoPath: string, rev: string, short: boolean): Promise<string> {
  try {
    const args = short
      ? ["-C", repoPath, "rev-parse", "--short", rev]
      : ["-C", repoPath, "rev-parse", rev];
    const { stdout } = await execFileAsync("git", args, { timeout: 5000, maxBuffer: 64 * 1024 });
    return stdout.trim();
  } catch {
    return "";
  }
}

// 체크포인트 생성. body: { note?: string } → { ok, sha, shortSha, subject }
//   `git add -A` 로 작업트리 전체를 stage 한 뒤 --allow-empty 커밋. note 가 있으면 제목에
//   붙이고, 없으면 ISO 타임스탬프를 붙인다. git 미설치/비-repo 등 실패는 409 + stderr.
sessions.post("/:id/git/checkpoint", async (c) => {
  const id = c.req.param("id");
  const session = getSession(id);
  if (!session) return c.json({ error: "not_found" }, 404);
  const repoPath = session.repo_path;
  if (!repoPath) return c.json({ error: "no_repo" }, 404);

  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const note = sanitizeCheckpointNote((body as { note?: unknown }).note);
  const subject = note
    ? `${CHECKPOINT_PREFIX} ${note}`
    : `${CHECKPOINT_PREFIX} ${new Date().toISOString()}`;

  try {
    await execFileAsync("git", ["-C", repoPath, "add", "-A"], {
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    });
    await execFileAsync(
      "git",
      ["-C", repoPath, "commit", "--allow-empty", "-m", subject],
      { timeout: 30000, maxBuffer: 1024 * 1024 },
    );
  } catch (e: any) {
    const message = (e?.stderr ?? e?.message ?? "checkpoint failed").toString().trim();
    return c.json({ error: "checkpoint_failed", message }, 409);
  }
  const sha = await revParse(repoPath, "HEAD", false);
  const shortSha = await revParse(repoPath, "HEAD", true);
  return c.json({ ok: true, sha, shortSha, subject });
});

// 체크포인트로 되돌리기. body: { sha: string, mode: "revert"|"reset", autoCheckpoint?: boolean }
//   비파괴 우선: autoCheckpoint(기본 true)면 «되돌리기 전» 현재 상태를 자동 체크포인트로 먼저
//   저장한다 — 미커밋 변경을 잡아두고 트리를 깨끗이 해 revert/reset 이 진행 가능하게 한다.
//     mode=revert : `git revert --no-commit <sha>..HEAD` + 커밋 — 기록을 지우지 않고 되돌림(안전).
//     mode=reset  : `git reset --hard <sha>` — 이후 커밋을 버림(파괴적, 자동 체크포인트로 복구 가능).
//   응답: { ok, mode, autoCheckpointSha?, autoCheckpointShortSha?, resultSha, resultShortSha }
sessions.post("/:id/git/rollback", async (c) => {
  const id = c.req.param("id");
  const session = getSession(id);
  if (!session) return c.json({ error: "not_found" }, 404);
  const repoPath = session.repo_path;
  if (!repoPath) return c.json({ error: "no_repo" }, 404);

  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const sha = (body as { sha?: unknown }).sha;
  if (!isValidRef(sha)) return c.json({ error: "invalid_ref" }, 400);
  const mode = (body as { mode?: unknown }).mode;
  if (mode !== "revert" && mode !== "reset") return c.json({ error: "invalid_mode" }, 400);
  const autoCheckpoint = (body as { autoCheckpoint?: unknown }).autoCheckpoint !== false;

  // 1) 되돌리기 전 자동 체크포인트 — 미커밋 변경을 잡아두고(트리 clean) 복원점을 남긴다.
  let autoCheckpointSha = "";
  let autoCheckpointShortSha = "";
  if (autoCheckpoint) {
    const subject = `${CHECKPOINT_PREFIX} 되돌리기 전 자동 저장 (${new Date().toISOString()})`;
    try {
      await execFileAsync("git", ["-C", repoPath, "add", "-A"], {
        timeout: 30000,
        maxBuffer: 1024 * 1024,
      });
      await execFileAsync(
        "git",
        ["-C", repoPath, "commit", "--allow-empty", "-m", subject],
        { timeout: 30000, maxBuffer: 1024 * 1024 },
      );
    } catch (e: any) {
      const message = (e?.stderr ?? e?.message ?? "auto checkpoint failed").toString().trim();
      return c.json({ error: "auto_checkpoint_failed", message }, 409);
    }
    autoCheckpointSha = await revParse(repoPath, "HEAD", false);
    autoCheckpointShortSha = await revParse(repoPath, "HEAD", true);
  }

  // 2) 되돌리기 수행.
  const shortTarget = await revParse(repoPath, sha, true);
  if (mode === "revert") {
    try {
      // <sha>..HEAD 의 모든 커밋을 역순으로 되돌려 트리를 sha 시점과 동일하게 — 기록은 보존.
      await execFileAsync(
        "git",
        ["-C", repoPath, "revert", "--no-commit", `${sha}..HEAD`],
        { timeout: 30000, maxBuffer: 4 * 1024 * 1024 },
      );
    } catch (e: any) {
      // 충돌 등 실패 — revert 진행 상태를 깨끗이 되돌려 레포를 원상복구한다.
      try {
        await execFileAsync("git", ["-C", repoPath, "revert", "--abort"], {
          timeout: 10000,
          maxBuffer: 256 * 1024,
        });
      } catch {
        // abort 실패는 무시 — 아래로 에러를 흘린다.
      }
      const message = (e?.stderr ?? e?.message ?? "revert failed").toString().trim();
      return c.json({ error: "revert_failed", message }, 409);
    }
    try {
      const subject = `${CHECKPOINT_PREFIX} ${shortTarget || sha} 시점으로 되돌림`;
      await execFileAsync(
        "git",
        ["-C", repoPath, "commit", "--allow-empty", "-m", subject],
        { timeout: 30000, maxBuffer: 1024 * 1024 },
      );
    } catch (e: any) {
      const message = (e?.stderr ?? e?.message ?? "revert commit failed").toString().trim();
      return c.json({ error: "revert_failed", message }, 409);
    }
  } else {
    // reset --hard — HEAD 를 sha 로 옮기고 작업트리를 맞춘다. 이후 커밋은 버려지지만
    // 자동 체크포인트(autoCheckpointSha)로 reflog 없이도 복구 가능.
    try {
      await execFileAsync("git", ["-C", repoPath, "reset", "--hard", sha], {
        timeout: 30000,
        maxBuffer: 1024 * 1024,
      });
    } catch (e: any) {
      const message = (e?.stderr ?? e?.message ?? "reset failed").toString().trim();
      return c.json({ error: "reset_failed", message }, 409);
    }
  }

  const resultSha = await revParse(repoPath, "HEAD", false);
  const resultShortSha = await revParse(repoPath, "HEAD", true);
  return c.json({
    ok: true,
    mode,
    autoCheckpointSha: autoCheckpointSha || null,
    autoCheckpointShortSha: autoCheckpointShortSha || null,
    resultSha,
    resultShortSha,
  });
});

// worktree 목록. 응답:
//   { worktrees: [{ path, branch: string|null, head, isMain, isCurrent, locked, prunable }] }
// isMain = 목록 첫 항목(메인 worktree), isCurrent = 이 세션 repo_path 의 toplevel.
sessions.get("/:id/git/worktrees", async (c) => {
  const id = c.req.param("id");
  const session = getSession(id);
  if (!session) return c.json({ error: "not_found" }, 404);
  const repoPath = session.repo_path;
  if (!repoPath) return c.json({ worktrees: [] });

  const { entries, currentTop } = await listWorktrees(repoPath);
  const worktrees = await Promise.all(
    entries.map(async (e, i) => ({
      path: e.path,
      branch: e.branch ?? null,
      head: e.head ?? null,
      isMain: i === 0,
      isCurrent: await samePath(e.path, currentTop),
      locked: e.locked,
      prunable: e.prunable,
    })),
  );
  return c.json({ worktrees });
});

// 브랜치 전환(checkout). body: { name: string, track?: boolean }
//   track=true 면 원격추적 브랜치(origin/foo)를 받아 로컬 추적 브랜치를 만들며 전환.
// 미커밋 변경 충돌 등으로 git 이 거절하면 409 + stderr(앱이 안내로 표시).
sessions.post("/:id/git/checkout", async (c) => {
  const id = c.req.param("id");
  const session = getSession(id);
  if (!session) return c.json({ error: "not_found" }, 404);
  const repoPath = session.repo_path;
  if (!repoPath) return c.json({ error: "no_repo" }, 404);

  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const name = (body as { name?: unknown }).name;
  if (!isValidRef(name)) return c.json({ error: "invalid_branch" }, 400);
  const track = (body as { track?: unknown }).track === true;

  const args = track
    ? ["-C", repoPath, "checkout", "--track", name]
    : ["-C", repoPath, "checkout", name];
  try {
    await execFileAsync("git", args, { timeout: 15000, maxBuffer: 1024 * 1024 });
    return c.json({ ok: true, branch: name });
  } catch (e: any) {
    const message = (e?.stderr ?? e?.message ?? "checkout failed").toString().trim();
    return c.json({ error: "checkout_failed", message }, 409);
  }
});

// 새 브랜치 생성. body: { name: string, from?: string, checkout?: boolean }
//   checkout=true → `git checkout -b name [from]` (생성+전환), 아니면 `git branch name [from]`.
sessions.post("/:id/git/branch", async (c) => {
  const id = c.req.param("id");
  const session = getSession(id);
  if (!session) return c.json({ error: "not_found" }, 404);
  const repoPath = session.repo_path;
  if (!repoPath) return c.json({ error: "no_repo" }, 404);

  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const name = (body as { name?: unknown }).name;
  if (!isValidRef(name)) return c.json({ error: "invalid_branch" }, 400);
  const fromRaw = (body as { from?: unknown }).from;
  const from = typeof fromRaw === "string" && fromRaw.length > 0 ? fromRaw : undefined;
  if (from !== undefined && !isValidRef(from)) return c.json({ error: "invalid_from" }, 400);
  const checkout = (body as { checkout?: unknown }).checkout === true;

  const args = checkout
    ? ["-C", repoPath, "checkout", "-b", name, ...(from ? [from] : [])]
    : ["-C", repoPath, "branch", name, ...(from ? [from] : [])];
  try {
    await execFileAsync("git", args, { timeout: 15000, maxBuffer: 1024 * 1024 });
    return c.json({ ok: true, branch: name, checkedOut: checkout });
  } catch (e: any) {
    const message = (e?.stderr ?? e?.message ?? "branch failed").toString().trim();
    return c.json({ error: "branch_failed", message }, 409);
  }
});

// worktree 생성. body: { branch: string, newBranch?: boolean, from?: string } → { path, branch }
//   경로는 daemon 이 자동 산정: <메인worktree부모>/<repoName>.worktrees/<branchSlug>.
//   newBranch=true → `git worktree add -b branch <target> [from]` (신규 브랜치),
//   아니면 `git worktree add <target> branch` (기존 브랜치).
sessions.post("/:id/git/worktrees", async (c) => {
  const id = c.req.param("id");
  const session = getSession(id);
  if (!session) return c.json({ error: "not_found" }, 404);
  const repoPath = session.repo_path;
  if (!repoPath) return c.json({ error: "no_repo" }, 404);

  // 검증·경로산정·git add 는 공유 헬퍼가 전담 — repoPath 기반 routes/git.ts 와 동일 동작.
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const r = await createWorktree(repoPath, body as Record<string, unknown>);
  if (!r.ok) return c.json(r.body, r.status);
  return c.json({ path: r.path, branch: r.branch });
});

// worktree 삭제. query: ?path=<절대경로>&force=1
//   안전: path 가 `worktree list` 에 실제로 있는 것만(임의 디렉토리 삭제 차단), 그것도
//   메인 / 현재 세션 worktree 가 아닐 때만. dirty/locked 로 실패하면 409(앱이 force 재확인).
sessions.delete("/:id/git/worktrees", async (c) => {
  const id = c.req.param("id");
  const session = getSession(id);
  if (!session) return c.json({ error: "not_found" }, 404);
  const repoPath = session.repo_path;
  if (!repoPath) return c.json({ error: "no_repo" }, 404);

  const target = c.req.query("path");
  if (!target) return c.json({ error: "path_required" }, 400);
  const force = c.req.query("force") === "1";

  const { entries, currentTop } = await listWorktrees(repoPath);
  // git 이 추적하는 worktree 중 같은 경로를 찾는다 — 못 찾으면 임의 경로이므로 거절.
  let matchIdx = -1;
  for (let i = 0; i < entries.length; i++) {
    if (await samePath(entries[i].path, target)) {
      matchIdx = i;
      break;
    }
  }
  if (matchIdx === -1) return c.json({ error: "not_a_worktree" }, 404);
  if (matchIdx === 0) return c.json({ error: "cannot_remove_main" }, 403);
  if (await samePath(entries[matchIdx].path, currentTop)) {
    return c.json({ error: "cannot_remove_current" }, 403);
  }

  const args = force
    ? ["-C", repoPath, "worktree", "remove", "--force", entries[matchIdx].path]
    : ["-C", repoPath, "worktree", "remove", entries[matchIdx].path];
  try {
    await execFileAsync("git", args, { timeout: 15000, maxBuffer: 1024 * 1024 });
  } catch (e: any) {
    const message = (e?.stderr ?? e?.message ?? "worktree remove failed").toString().trim();
    return c.json({ error: "worktree_remove_failed", message }, 409);
  }
  // 메타데이터 정리(best effort) — 삭제된 worktree 의 administrative 파일 제거.
  try {
    await execFileAsync("git", ["-C", repoPath, "worktree", "prune"], {
      timeout: 5000,
      maxBuffer: 64 * 1024,
    });
  } catch {
    // prune 실패는 무시 — 제거 자체는 성공.
  }
  return c.json({ ok: true });
});

// 브랜치 삭제(로컬 전용). query: ?name=<브랜치>&force=1
//   안전: 현재 브랜치는 거절(cannot_delete_current — git 도 거절하지만 깔끔한 에러로 먼저 막는다).
//   기본은 `git branch -d`(병합 안 된 브랜치는 git 이 거절 → 409 + stderr, 앱이 force 재확인).
//   force=1 이면 `git branch -D`(강제). 원격 브랜치(origin/*)는 대상 아님 — 로컬만 지운다.
sessions.delete("/:id/git/branch", async (c) => {
  const id = c.req.param("id");
  const session = getSession(id);
  if (!session) return c.json({ error: "not_found" }, 404);
  const repoPath = session.repo_path;
  if (!repoPath) return c.json({ error: "no_repo" }, 404);

  const name = c.req.query("name");
  if (!isValidRef(name)) return c.json({ error: "invalid_branch" }, 400);
  const force = c.req.query("force") === "1";

  // 현재 체크아웃된 브랜치는 삭제 불가. detached / unborn HEAD 면 symbolic-ref 가 실패 →
  // 현재 브랜치 없음으로 보고 계속 진행.
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", repoPath, "symbolic-ref", "--short", "HEAD"],
      { timeout: 3000, maxBuffer: 64 * 1024 },
    );
    if (stdout.trim() === name) return c.json({ error: "cannot_delete_current" }, 403);
  } catch {
    // 현재 브랜치 없음(detached/unborn) — 계속.
  }

  const args = force
    ? ["-C", repoPath, "branch", "-D", name]
    : ["-C", repoPath, "branch", "-d", name];
  try {
    await execFileAsync("git", args, { timeout: 15000, maxBuffer: 1024 * 1024 });
    return c.json({ ok: true });
  } catch (e: any) {
    const message = (e?.stderr ?? e?.message ?? "branch delete failed").toString().trim();
    return c.json({ error: "branch_delete_failed", message }, 409);
  }
});

sessions.post("/:id/messages", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json();
  const text = body.text;
  if (!text || typeof text !== "string") {
    return c.json({ error: "text required" }, 400);
  }
  // 모바일 사용자가 켠 "도구 자동 승인" 토글. turn 단위로 들어와서 다음 메시지부터 즉시 적용된다.
  // 누락 / 잘못된 타입이면 안전 기본값(false).
  const bypassPermissions = body.bypassPermissions === true;
  const session = getSession(id);
  if (!session) return c.json({ error: "not_found" }, 404);

  // 옛 SDK 모드 세션은 더 이상 실행할 수 없다. DB 마이그레이션 시점 (이 변경 직전) 의
  // 사용자 데이터에는 SDK 세션이 없음을 확인했지만, 어떤 경로로든 mode='sdk' 가 남아
  // 있다면 명확히 거절해 사용자가 회복 불가능한 흐름에 빠지지 않게 한다.
  if (session.mode !== "pty") {
    return c.json(
      { error: `session was created with the legacy '${session.mode}' runner which is no longer supported` },
      410,
    );
  }
  // 비동기 실행 (응답은 즉시 반환, 결과는 WS 로 흐름).
  // PTY 모드: 한 PTY 프로세스가 세션 내내 살아서 입력만 흘려보냄. await 완료 ≈ stdin 쓰기 완료.
  // 실제 응답은 onData 가 WS 로 streaming.
  //
  // session.skip_permissions 가 true 면 bypassPermissions 로 spawn (REPL 안에서 텍스트 prompt
  // 가 안 뜨도록). turn 별 토글(body.bypassPermissions)은 PTY 가 이미 떠 있는 다음 turn 부터는
  // 적용 불가 — 첫 spawn 결정이 영구. 사용자 UX 일관성 위해 두 신호를 OR.
  const ptyBypass = bypassPermissions || session.skip_permissions === 1;
  // resumeFrom: 세션 생성 시 사용자가 골랐던 데스크탑 세션 핸들.
  // 첫 spawn 때만 의미 있음 (PTY 가 한 번 뜨면 그 후엔 in-process 컨텍스트 유지로 충분).
  // adapter.buildSpawnArgs 가 자기 agent 의 인자 모양으로 박는다 (`--resume <id>` claude,
  // `--conversation <id>` agy 등). sessions.agent 가 옛 row 에서 NULL/누락이면 DEFAULT 로
  // fallback (마이그레이션 시점에 채워져 있어야 정상).
  const agentId = session.agent || DEFAULT_AGENT_ID;
  let adapter;
  try {
    adapter = getAgent(agentId);
  } catch {
    return c.json(
      { error: `unknown agent '${agentId}' for this session — agent CLI may have been removed from the daemon` },
      410,
    );
  }
  runUserMessagePty(
    {
      sessionId: id,
      cwd: session.repo_path,
      adapter,
      resumeFrom: session.parent_sdk_session_id ?? undefined,
    },
    text,
    { bypassPermissions: ptyBypass },
  ).catch((e) => {
    console.error("[runUserMessagePty]", e);
  });

  return c.json({ ok: true, sessionId: id });
});

// 이미지 첨부 업로드 한도. Tor 대역폭상 iOS 가 다운스케일해 올리는 걸 전제로 잡았다.
const ATTACH_BODY_MAX = 60 * 1024 * 1024; // base64 팽창(~33%) 포함 전체 body cap
const ATTACH_PER_FILE_MAX = 12 * 1024 * 1024; // 디코드 후 장당 cap
const ATTACH_MAX_COUNT = 20;
const ATTACH_DEFAULT_DIR = "attachments";

/**
 * 이미지 첨부 업로드 — iOS 가 base64 이미지(들)를 올리면 세션 repo 안에 저장하고 저장된
 * repo-relative 경로를 돌려준다. 그 경로는 이후 사용자 메시지(프롬프트)에서 참조돼 에이전트
 * (claude 등)가 Read 도구로 이미지를 읽는다. 기본 디렉토리는 repo_path/attachments.
 *
 * body: { dir?: string(repo-relative), images: [{ filename: string, data_b64: string }] }
 * 응답: { saved: [{ rel, abs, bytes }] }
 *
 * 업로드라 daemon 기본 body 처리로는 부족 — 라우트 단위 bodyLimit 으로 넉넉히 허용.
 * 경로는 fs 라우트와 동일하게 resolveRepoRelative 로 repo 밖 / `.git` 쓰기를 차단한다.
 */
sessions.post(
  "/:id/attachments",
  bodyLimit({
    maxSize: ATTACH_BODY_MAX,
    onError: (c) => c.json({ error: "payload_too_large" }, 413),
  }),
  async (c) => {
    const id = c.req.param("id");
    const session = getSession(id);
    if (!session) return c.json({ error: "not_found" }, 404);
    const repoPath = session.repo_path;
    if (!repoPath) return c.json({ error: "no_repo" }, 404);

    const body = await c.req.json().catch(() => null);
    const images = body?.images;
    if (!Array.isArray(images) || images.length === 0) {
      return c.json({ error: "images_required" }, 400);
    }
    if (images.length > ATTACH_MAX_COUNT) {
      return c.json({ error: "too_many_images" }, 400);
    }

    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const fileExists = async (p: string): Promise<boolean> => {
      try {
        await fs.access(p);
        return true;
      } catch {
        return false;
      }
    };

    // 대상 디렉토리 해석 + 생성 (기본 attachments).
    const dirRel =
      typeof body.dir === "string" && body.dir.trim() !== "" ? body.dir : ATTACH_DEFAULT_DIR;
    const dirR = await resolveRepoRelative(repoPath, dirRel);
    if (!dirR.ok) return c.json({ error: dirR.error }, dirR.error === "no_repo" ? 404 : 400);
    try {
      await fs.mkdir(dirR.abs, { recursive: true });
    } catch {
      return c.json({ error: "mkdir_failed" }, 500);
    }

    const saved: Array<{ rel: string; abs: string; bytes: number }> = [];
    const usedNames = new Set<string>();
    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      if (!img || typeof img.data_b64 !== "string") {
        return c.json({ error: "invalid_image", index: i }, 400);
      }
      // 파일명 정리 — basename 만, 안전 문자만, 비면 기본값. 디스크/배치 내 충돌 시 -n 접미.
      let base = path.basename(typeof img.filename === "string" ? img.filename : "").trim();
      base = base.replace(/[^\w.\-]/g, "_");
      if (base === "" || base === "." || base === "..") base = `image-${i + 1}.png`;
      let name = base;
      let n = 1;
      while (usedNames.has(name) || (await fileExists(path.join(dirR.abs, name)))) {
        const ext = path.extname(base);
        const stem = base.slice(0, base.length - ext.length);
        name = `${stem}-${n}${ext}`;
        n++;
      }
      usedNames.add(name);

      // 혹시 모를 data URI 접두 제거 후 디코드.
      const b64 = img.data_b64.replace(/^data:[^,]*,/, "");
      const buf = Buffer.from(b64, "base64");
      if (buf.length === 0) return c.json({ error: "empty_image", index: i }, 400);
      if (buf.length > ATTACH_PER_FILE_MAX) {
        return c.json({ error: "image_too_large", index: i }, 413);
      }

      const fileR = await resolveRepoRelative(repoPath, path.posix.join(dirR.rel, name));
      if (!fileR.ok) return c.json({ error: fileR.error, index: i }, 400);
      try {
        await fs.writeFile(fileR.abs, buf);
      } catch {
        return c.json({ error: "write_failed", index: i }, 500);
      }
      saved.push({ rel: fileR.rel, abs: fileR.abs, bytes: buf.length });
    }

    return c.json({ saved });
  },
);

/**
 * PTY 모드 전용 — 터미널 윈도우 크기 동기화.
 * iOS 회전/폰트 변경 시 호출. body: { cols: number, rows: number }
 */
sessions.post("/:id/pty/resize", async (c) => {
  const id = c.req.param("id");
  const session = getSession(id);
  if (!session) return c.json({ error: "not_found" }, 404);
  if (session.mode !== "pty") {
    return c.json({ error: "session is not in pty mode" }, 400);
  }
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const cols = Number((body as { cols?: unknown }).cols);
  const rows = Number((body as { rows?: unknown }).rows);
  if (!Number.isFinite(cols) || !Number.isFinite(rows)) {
    return c.json({ error: "cols/rows required (number)" }, 400);
  }
  // 한 PTY 를 여러 클라이언트(iOS + Mac mirror) 가 동시에 보는 시나리오 대비 — 서로
  // 다른 폭으로 resize 를 보내면 마지막 호출이 이겨 다른 화면이 깨진다 (좁은 쪽
  // 줄바꿈 지옥, 넓은 쪽 여백). 양 극단을 막아 어느 화면도 치명적으로 깨지지 않는
  // 공통 범위로 강제. 클라이언트가 어떤 값을 보내든 우회 불가.
  const clampedCols = Math.max(80, Math.min(160, cols));
  const clampedRows = Math.max(20, Math.min(60, rows));
  const ok = resizePty(id, clampedCols, clampedRows);
  return c.json({ ok, cols: clampedCols, rows: clampedRows });
});

/**
 * 가상 키보드 단일 키 입력 — iOS statusBar 의 inverted-T 화살표 키패드 호출.
 *
 * 다항 선택 REPL prompt (claude/codex 의 select wizard) 를 모바일에서 제어하기 위한
 * 채널. body: { key: "up" | "down" | "left" | "right" | "scroll_up" | "scroll_down" }.
 * scroll_* 는 copilot 같은 alt-screen TUI 본문을 굴리는 휠 이벤트 (sendPtyKey 가 SGR 휠로 변환).
 *
 * 텍스트는 WS `pty_input` (writePtyRaw) 으로 보낸다 — 이 endpoint 는 의도된 키만 허용해
 * 임의 stdin 인젝션 면을 막는다. 공백/Enter 는 시스템 소프트 키보드의 같은
 * 키가 PTY 로 직통으로 흘러 별도 가상 버튼이 불필요해져 제거됨 (2026-05).
 */
sessions.post("/:id/pty/key", async (c) => {
  const id = c.req.param("id");
  const session = getSession(id);
  if (!session) return c.json({ error: "not_found" }, 404);
  if (session.mode !== "pty") {
    return c.json({ error: "session is not in pty mode" }, 400);
  }
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const key = (body as { key?: unknown }).key;
  const allowed = ["up", "down", "left", "right", "scroll_up", "scroll_down"] as const;
  if (typeof key !== "string" || !(allowed as readonly string[]).includes(key)) {
    return c.json({ error: `key must be one of ${allowed.join("|")}` }, 400);
  }
  const ok = sendPtyKey(id, key as typeof allowed[number]);
  return c.json({ ok });
});

/**
 * 세션 일괄 제어 — iOS 세션 목록의 그룹 헤더 «모두 승인» / «모두 중지» 가 호출.
 *
 * 동기: 한 사람이 여러 에이전트를 동시에 굴릴 때 «대기 N건» 이 쌓이면 카드를 하나씩 열어
 * 승인해야 했다 (결재 병목). 목록에서 채팅방을 열지 않고도 그룹 단위로 같은 키를 PTY 에
 * 흘려보내 병목을 분 단위로 줄인다. 채팅방 ESC 버튼 / Enter 와 «정확히 같은» 제어 byte 라
 * (writePtyRaw) — 사람이 키보드로 누른 것과 동치다. PTY 를 죽이지 않고(=세션 유지) REPL 의
 * 현재 turn 만 제어한다 (abort 처럼 프로세스를 SIGTERM 하지 않는다).
 *
 * body: { action: "approve" | "interrupt" }
 *   - approve   → Enter(\r, 0x0d) : 권한 prompt 의 기본 강조 선택지(보통 «예») 를 그대로 확정.
 *                 writePtyRaw 가 CR 을 보면 turn submit 으로 표시 (대기 → 실행중 전이 신호).
 *   - interrupt → 어댑터의 취소 키 : 진행 중인 turn 을 중단. claude/codex 는 ESC(\x1b) 지만
 *                 copilot/shell 은 ESC 가 무력해 Ctrl-C(\x03) 다 — 어느 byte 를 쓸지는 세션의
 *                 agent 어댑터(adapter.interruptBytes)가 결정한다. 모르는 agent 면 ESC 폴백.
 *
 * 화살표 4종(pty/key)과 달리 임의 byte 가 아니라 2 종 의미 액션만 화이트리스트 — stdin 인젝션
 * 면을 늘리지 않는다. 텍스트/그 외 키는 기존 WS pty_input / runUserMessagePty 경로를 쓴다.
 */
sessions.post("/:id/pty/control", async (c) => {
  const id = c.req.param("id");
  const session = getSession(id);
  if (!session) return c.json({ error: "not_found" }, 404);
  if (session.mode !== "pty") {
    return c.json({ error: "session is not in pty mode" }, 400);
  }
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const action = (body as { action?: unknown }).action;
  // interrupt 의 취소 byte 는 에이전트마다 다르다 — 세션의 agent 어댑터가 광고한다(미정의면 ESC).
  // copilot/shell 은 ESC 가 진행 작업을 안 멈춰 Ctrl-C(\x03) 를 쓴다. (interruptBytes 주석 참고)
  let interruptBytes: Buffer = Buffer.from([0x1b]); // ESC — 기본(claude/codex)
  try {
    const adapter = getAgent(session.agent || DEFAULT_AGENT_ID);
    if (adapter.interruptBytes) interruptBytes = adapter.interruptBytes();
  } catch {
    // 알 수 없는 agent (구 daemon 에서 옮겨온 세션 등) — ESC 폴백 유지.
  }
  // 의미 액션 → 제어 byte. Enter/interrupt 2 종만 명시 매칭 (prototype 키가 새지 않게 in 대신 ===).
  // 사람이 채팅방에서 누르는 키와 동일한 byte.
  const bytes =
    action === "approve" ? Buffer.from([0x0d]) // CR (Enter)
    : action === "interrupt" ? interruptBytes // ESC 또는 Ctrl-C — 어댑터가 결정
    : null;
  if (!bytes) {
    return c.json({ error: "action must be one of approve|interrupt" }, 400);
  }
  const ok = writePtyRaw(id, bytes);
  return c.json({ ok });
});

/**
 * PTY 강제 재시작 — 현재 PTY 를 SIGTERM 으로 죽이고 messages 를 비운 뒤 새 PTY 를
 * 즉시 prewarm 한다. 사용자에겐 "이전 터미널 출력은 사라지고 새 splash 가 곧장 흐른다".
 *
 * 의도: REPL 이 멈추거나 화면이 깨졌을 때 한 번에 완전 회생. iOS 메뉴의 "터미널 강제 재시작"
 * 이 호출. "내용 비우기" 와의 차이는 *호출 직후 새 PTY 가 자동으로 살아난다는 점* — 사용자가
 * 다음 메시지를 보낼 때까지 빈 화면을 보지 않는다.
 *
 * messages/approvals/questions 를 함께 지우는 이유는 iOS 가 화면을 비웠는데 DB 에 옛
 * pty_chunk 가 남아 있으면 백그라운드 복귀/세션 재진입 시 그 청크들이 다시 replay 되어
 * "지웠던 게 돌아오는" 회귀가 생기기 때문. 청크만 지우고 user 입력은 남기면 echo 없는
 * 외로운 사용자 줄만 나와 더 어색하므로 한꺼번에 정리한다.
 */
sessions.post("/:id/pty/restart", async (c) => {
  const id = c.req.param("id");
  const session = getSession(id);
  if (!session) return c.json({ error: "not_found" }, 404);
  if (session.mode !== "pty") {
    return c.json({ error: "session is not in pty mode" }, 400);
  }

  const agentId = session.agent || DEFAULT_AGENT_ID;
  let adapter;
  try {
    adapter = getAgent(agentId);
  } catch {
    return c.json(
      { error: `unknown agent '${agentId}' for this session — agent CLI may have been removed from the daemon` },
      410,
    );
  }

  // 현재 PTY 가 살아있다면 SIGTERM 후 실제로 빠져나갈 때까지 대기.
  // onExit 핸들러가 activePtys 에서 제거해야 아래 prewarm 이 새 PTY 를 띄운다 (idempotent
  // guard 회피). 살아있지 않았다면 abort 는 false, awaitPtyExit 은 즉시 resolve.
  // 잔여 stdout 이 다음 트랜잭션의 DELETE 와 race 해서 foreign-key constraint 로 깨지지
  // 않도록 await 가 필수 — clearSession 과 동일한 이유.
  abortPtySession(id);
  await awaitPtyExit(id);

  // 메시지/승인/질문을 한 트랜잭션으로 비운다. 부분 삭제 상태가 보이지 않게.
  const tx = db().transaction((sid: string) => {
    db().prepare(`DELETE FROM messages WHERE session_id = ?`).run(sid);
    db().prepare(`DELETE FROM approvals WHERE session_id = ?`).run(sid);
    db().prepare(`DELETE FROM questions WHERE session_id = ?`).run(sid);
    db().prepare(
      `UPDATE sessions
         SET status = 'active',
             ended_at = NULL
       WHERE id = ?`,
    ).run(sid);
  });
  tx(id);

  // 새 PTY 를 prewarm — 사용자 입력 없이도 REPL splash 가 즉시 화면에 흐른다.
  // skip_permissions 는 세션 영구 플래그라 신규 메시지 흐름과 동일하게 그대로 옮긴다.
  const ptyBypass = session.skip_permissions === 1;
  try {
    prewarmPty(
      {
        sessionId: id,
        cwd: session.repo_path,
        adapter,
        resumeFrom: session.parent_sdk_session_id ?? undefined,
      },
      { bypassPermissions: ptyBypass },
    );
  } catch (e) {
    console.warn(
      `[sessions.post /pty/restart] respawn failed session=${id}:`,
      (e as Error).message,
    );
    return c.json({ ok: false, error: "respawn_failed" }, 500);
  }
  return c.json({ ok: true });
});

/** 한 번에 돌려줄 수 있는 메시지 행 상한 — 콜드 tail 캡 / 히스토리 페이지 공용 (DoS·과대 응답 방지). */
const MAX_MESSAGE_PAGE = 2000;
/** 히스토리 엔드포인트 기본 페이지 크기 — 클라이언트가 limit 을 안 주면 이만큼. */
const DEFAULT_HISTORY_PAGE = 400;

type MessageQueryRow = {
  id: string;
  role: string;
  type: string;
  payload: string;
  created_at: number;
};

/** `limit` 쿼리 파싱 — 1..MAX_MESSAGE_PAGE 로 클램프. 없거나 0/음수/NaN 이면 fallback(0=캡 없음). */
function parsePageLimit(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(MAX_MESSAGE_PAGE, n);
}

/**
 * 통합 polling 엔드포인트.
 *
 * Query:
 *  - afterCreatedAt: number (옵션). messages.created_at > 이 값 인 행만 반환(증분). 0/생략 = 콜드.
 *  - limit: number (옵션, `session_history_v1`). 콜드 진입에서만 의미 — 최신 limit 행만 반환(tail 캡).
 *    옛 클라이언트는 안 보내므로 전체 반환(기존 동작 그대로). 증분(afterCreatedAt>0)엔 적용 안 함.
 *
 * Response:
 *  ```
 *  {
 *    session: SessionSummary,
 *    messages: MessageRow[],         // 증분이면 after 이후, 콜드+limit 이면 최신 tail(ASC)
 *    nextCreatedAt: number,          // 다음 poll 에 보낼 afterCreatedAt (증분 keyset)
 *    hasMoreBefore: boolean,         // tail 캡으로 잘려서 더 오래된 메시지가 있는가 (콜드만 true 가능)
 *    oldestCreatedAt: number|null,   // 이번 페이지 가장 오래된 행의 created_at — 역방향 히스토리 커서
 *    oldestId: string|null,          // 같은-ms tiebreak 용 복합 커서
 *  }
 *  ```
 *
 * 클라이언트는 nextCreatedAt 으로 앞(최신)을 증분 따라가고, (oldestCreatedAt, oldestId) 로
 * `GET /:id/messages` 를 호출해 뒤(과거)로 keyset 페이지네이션한다. 첫 진입에서 limit 을 주면
 * 무한 누적된 pty_chunk 를 전부 내려받던 ~5s 콜드 로드가 사라진다.
 */
sessions.get("/:id/poll", (c) => {
  const id = c.req.param("id");
  const session = getSession(id);
  if (!session) return c.json({ error: "not_found" }, 404);

  const afterRaw = c.req.query("afterCreatedAt");
  const after = afterRaw ? Math.max(0, parseInt(afterRaw, 10) || 0) : 0;
  // 콜드 진입에서만 tail 캡 — fallback 0 = 캡 없음(옛 클라이언트 = 전체 유지).
  const limit = parsePageLimit(c.req.query("limit"), 0);

  let messages: MessageQueryRow[];
  let hasMoreBefore = false;

  if (after > 0) {
    // 증분 — 변경 없음. created_at > after 를 ASC. (같은-ms 누락은 클라이언트 id dedup 으로 흡수.)
    messages = db()
      .prepare(
        `SELECT id, role, type, payload, created_at
         FROM messages WHERE session_id = ? AND created_at > ?
         ORDER BY created_at ASC`,
      )
      .all(id, after) as MessageQueryRow[];
  } else if (limit > 0) {
    // 콜드 + tail 캡 — 최신 limit 행만. limit+1 을 DESC 로 끌어와 «더 있는가»(hasMoreBefore)를
    // 판정한 뒤 limit 만 남겨 ASC 로 뒤집어 replay 순서를 맞춘다. 복합 keyset (created_at, id)
    // 으로 같은-ms 행도 안정 정렬.
    const desc = db()
      .prepare(
        `SELECT id, role, type, payload, created_at
         FROM messages WHERE session_id = ?
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .all(id, limit + 1) as MessageQueryRow[];
    hasMoreBefore = desc.length > limit;
    messages = desc.slice(0, limit).reverse();
  } else {
    // 콜드 + 캡 없음 (옛 클라이언트) — 전체 반환(기존 동작 그대로).
    messages = db()
      .prepare(
        `SELECT id, role, type, payload, created_at
         FROM messages WHERE session_id = ?
         ORDER BY created_at ASC`,
      )
      .all(id) as MessageQueryRow[];
  }

  // nextCreatedAt: 가장 최근 메시지의 created_at, 없으면 입력값 유지. (같은-ms 중복은 id dedup 흡수.)
  const nextCreatedAt = messages.length > 0
    ? messages[messages.length - 1].created_at
    : after;
  const oldest = messages.length > 0 ? messages[0] : null;

  // pty_chunk 의 stale 터미널 질의 제거 — WS catch-up / GET /:id 와 동일 정화. polling 만
  // 안 거르면 WS 가 끊긴 동안의 청크를 줍는 fallback 경로로 질의가 다시 새어 재발한다.
  return c.json({
    // waiting_since: 목록 API 와 동일한 «입력 대기» 신호 — 채팅 화면이 폴링만으로
    // 대기 배너를 켜고 끌 수 있게 (WS turn_complete push 의 폴링 fallback).
    session: { ...session, ...attentionFields(id) },
    messages: sanitizeMessageRows(messages),
    nextCreatedAt,
    hasMoreBefore,
    oldestCreatedAt: oldest ? oldest.created_at : null,
    oldestId: oldest ? oldest.id : null,
  });
});

/**
 * 역방향(과거) 메시지 히스토리 — `session_history_v1`. 콜드 tail 캡으로 잘린 «이전» 묶음을
 * keyset 으로 한 페이지씩 올라가며 가져온다.
 *
 * Query:
 *  - beforeCreatedAt: number, beforeId: string — 복합 keyset 커서. 이 커서보다 «엄격히 오래된»
 *    행만. 생략하면 최신부터(콜드와 동일 tail).
 *  - limit: number (기본 DEFAULT_HISTORY_PAGE).
 *
 * Response: { messages(ASC), hasMoreBefore, oldestCreatedAt, oldestId }.
 *
 * OFFSET 대신 keyset 을 쓰는 이유: 페이지를 넘기는 동안 새 메시지가 append 되어도 인덱스가
 * 밀리지 않아 중복/누락이 없고, idx_messages_session(session_id, created_at) 로 O(log n).
 */
sessions.get("/:id/messages", (c) => {
  const id = c.req.param("id");
  const session = getSession(id);
  if (!session) return c.json({ error: "not_found" }, 404);

  const limit = parsePageLimit(c.req.query("limit"), DEFAULT_HISTORY_PAGE);
  const beforeCreatedAtRaw = c.req.query("beforeCreatedAt");
  const beforeCreatedAt = beforeCreatedAtRaw ? parseInt(beforeCreatedAtRaw, 10) : NaN;
  const beforeId = c.req.query("beforeId") ?? "";

  const desc = (Number.isFinite(beforeCreatedAt)
    ? db()
        .prepare(
          `SELECT id, role, type, payload, created_at
           FROM messages
           WHERE session_id = ?
             AND (created_at < ? OR (created_at = ? AND id < ?))
           ORDER BY created_at DESC, id DESC
           LIMIT ?`,
        )
        .all(id, beforeCreatedAt, beforeCreatedAt, beforeId, limit + 1)
    : db()
        .prepare(
          `SELECT id, role, type, payload, created_at
           FROM messages WHERE session_id = ?
           ORDER BY created_at DESC, id DESC
           LIMIT ?`,
        )
        .all(id, limit + 1)) as MessageQueryRow[];

  const hasMoreBefore = desc.length > limit;
  const page = desc.slice(0, limit).reverse(); // ASC — replay/표시 순서.
  const oldest = page.length > 0 ? page[0] : null;

  return c.json({
    messages: sanitizeMessageRows(page),
    hasMoreBefore,
    oldestCreatedAt: oldest ? oldest.created_at : null,
    oldestId: oldest ? oldest.id : null,
  });
});

/**
 * PTY 화면 스냅샷 (pty_snapshot_v1). 콜드 진입에서 «전체 청크 replay» 대신 현재 화면+scrollback
 * 을 한 덩이로 받아 O(화면) 비용으로 즉시 복원한다.
 *
 * Response: `{ snapshot: string(ANSI), cols, rows, throughCreatedAt, truncated }`.
 * 클라이언트는 snapshot 을 fresh 터미널에 feed 한 뒤, `throughCreatedAt` 을 다음 poll 의
 * afterCreatedAt 로 써서 이후만 증분으로 잇는다(이중 렌더 없음).
 */
sessions.get("/:id/pty/snapshot", async (c) => {
  const id = c.req.param("id");
  const session = getSession(id);
  if (!session) return c.json({ error: "not_found" }, 404);
  // 살아있는 PTY 의 현재 cols/rows 로 헤드리스 터미널 폭을 맞춘다(줄바꿈 일치). 죽었으면 기본값.
  const size = getPtySize(id);
  const snap = await buildPtySnapshot(id, size ?? undefined);
  return c.json(snap);
});

/**
 * 세션 메타데이터 부분 업데이트. 편집 가능 필드: `title`, `notifyMuted`, `archived`.
 *
 * - body.title 이 string 이면 trim 후 200자 제한해 저장.
 * - body.title 이 빈 문자열 또는 null 이면 컬럼을 NULL 로 만들어 UI 가 "제목 없음" 으로 빠지게 한다.
 * - body.notifyMuted 가 boolean 이면 notify_muted 컬럼을 0/1 로 갱신 — 세션 단위 알림 음소거
 *   (iOS ChatView 우측 상단 bell 토글). dispatchNotification 이 이 값을 보고 발송을 건너뛴다.
 * - body.archived 가 boolean 이면 archived 컬럼을 0/1 로 갱신 (session_archive_v1) — iOS 세션
 *   목록의 스와이프 «보관»/«복구» 가 호출. true 면 기본 목록에서 숨고, false 면 복구된다.
 * - 키 자체가 없으면 그 필드는 변경하지 않는다 (안전한 PATCH 시멘틱).
 */
sessions.patch("/:id", async (c) => {
  const id = c.req.param("id");
  const existing = getSession(id);
  if (!existing) return c.json({ error: "not_found" }, 404);

  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));

  if (Object.prototype.hasOwnProperty.call(body, "title")) {
    const raw = (body as { title: unknown }).title;
    if (raw !== null && typeof raw !== "string") {
      return c.json({ error: "title must be string or null" }, 400);
    }
    let next: string | null = null;
    if (typeof raw === "string") {
      const trimmed = raw.trim().slice(0, 200);
      next = trimmed.length > 0 ? trimmed : null;
    }
    db().prepare(`UPDATE sessions SET title = ? WHERE id = ?`).run(next, id);
  }

  if (Object.prototype.hasOwnProperty.call(body, "notifyMuted")) {
    const raw = (body as { notifyMuted: unknown }).notifyMuted;
    if (typeof raw !== "boolean") {
      return c.json({ error: "notifyMuted must be boolean" }, 400);
    }
    db()
      .prepare(`UPDATE sessions SET notify_muted = ? WHERE id = ?`)
      .run(raw ? 1 : 0, id);
  }

  if (Object.prototype.hasOwnProperty.call(body, "archived")) {
    const raw = (body as { archived: unknown }).archived;
    if (typeof raw !== "boolean") {
      return c.json({ error: "archived must be boolean" }, 400);
    }
    db()
      .prepare(`UPDATE sessions SET archived = ? WHERE id = ?`)
      .run(raw ? 1 : 0, id);
  }

  const updated = getSession(id);
  return c.json({ ok: true, session: updated });
});

/**
 * 「다음 정지 시 알림」 1회성 수동 구독 토글 — POST /api/sessions/:id/notify-next-stop { enabled }.
 *
 * 12초 idle 휴리스틱이 놓치는 false-negative(에이전트가 prompt 띄워 놓고도 출력이 깜빡여
 * 영영 «대기» 로 안 잡히는 세션)를 사람이 메우는 안전장치. 켜면 그 세션의 다음 idle 을
 * 더 짧은 임계값으로 잡아 한 번 더 대기 알림을 발사한다(발사 후 자동 해제).
 *
 * notify_muted 와 달리 «활성 PTY 한정» 메모리 신호라 DB 에 영속하지 않는다 — PTY 가 죽으면
 * 자연 소멸. 무장 결과(applied)는 활성 PTY 가 있었는지로, 현재 근거(attentionFields)와 함께 반환.
 */
sessions.post("/:id/notify-next-stop", async (c) => {
  const id = c.req.param("id");
  const existing = getSession(id);
  if (!existing) return c.json({ error: "not_found" }, 404);

  const body = await c.req.json().catch(() => ({} as Record<string, unknown>));
  const raw = (body as { enabled: unknown }).enabled;
  if (typeof raw !== "boolean") {
    return c.json({ error: "enabled must be boolean" }, 400);
  }
  const applied = setNotifyNextStop(id, raw);
  return c.json({ ok: true, applied, ...attentionFields(id) });
});

sessions.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const existing = getSession(id);
  if (!existing) return c.json({ error: "not_found" }, 404);
  // 진행 중이면 먼저 중단 → PTY 가 실제로 빠져나갈 때까지 대기. 잔여 stdout 이 끝나기 전에
  // DELETE 하면 insertMessage 가 foreign-key constraint 로 깨진다 (log 노이즈 + 가짜 error 이벤트).
  abortPtySession(id);
  await awaitPtyExit(id);
  // messages / approvals 는 ON DELETE CASCADE 로 함께 제거. 단, workflow_node_runs.session_id
  // 는 ON DELETE 규칙이 없어(=RESTRICT) 워크플로우가 만든 세션을 지우면 foreign-key 위반으로
  // DELETE 가 깨졌다(=세션 삭제 불가 버그). 참조를 먼저 NULL 로 끊고 한 트랜잭션으로 지운다.
  const tx = db().transaction((sid: string) => {
    db().prepare(`UPDATE workflow_node_runs SET session_id = NULL WHERE session_id = ?`).run(sid);
    return db().prepare(`DELETE FROM sessions WHERE id = ?`).run(sid);
  });
  const result = tx(id);
  return c.json({ ok: true, deleted: result.changes });
});

/**
 * 세션의 "내용"만 비운다 — 세션 행 자체는 유지하고, 그 안의 대화/승인/질문 기록을 비운다.
 *
 * 의도: 사용자가 "처음부터 다시" 시작하고 싶을 때, 새 세션을 만들지 않고도 같은 repo/타이틀로
 *       PTY 컨텍스트까지 깨끗하게 리셋. 진행 중인 PTY 가 있으면 먼저 정리한 뒤 트랜잭션으로 비운다.
 */
sessions.post("/:id/clear", async (c) => {
  const id = c.req.param("id");
  const existing = getSession(id);
  if (!existing) return c.json({ error: "not_found" }, 404);

  // 진행 중인 PTY 와 매달려 있는 질문 wait 를 먼저 풀어준다. 그리고 PTY 가 실제로
  // 빠져나갈 때까지 대기 — 잔여 insertMessage 가 이어지는 transaction 의 DELETE 와
  // race 해서 깨지지 않도록.
  abortPtySession(id);
  await awaitPtyExit(id);

  // 트랜잭션으로 묶어 부분 삭제 상태가 보이지 않도록.
  const tx = db().transaction((sid: string) => {
    db().prepare(`DELETE FROM messages WHERE session_id = ?`).run(sid);
    db().prepare(`DELETE FROM approvals WHERE session_id = ?`).run(sid);
    db().prepare(`DELETE FROM questions WHERE session_id = ?`).run(sid);
    // 상태/종료시각을 깨끗한 active 로 되돌린다. parent_sdk_session_id 는 PTY 모드에서
    // 의미가 없지만 컬럼은 schema 호환을 위해 그대로 유지.
    db().prepare(
      `UPDATE sessions
         SET status = 'active',
             ended_at = NULL
       WHERE id = ?`,
    ).run(sid);
  });
  tx(id);

  return c.json({ ok: true });
});
