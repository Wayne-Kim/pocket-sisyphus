import type { Hono } from "hono";
import { db } from "../db/index.js";
import {
  prewarmPty,
  abortPtySession,
  awaitPtyExit,
} from "../agent/pty-runner.js";
import { getAgent, hasAgent } from "../agent/registry.js";
import { getAgentUsage } from "../agent/usage.js";
import { sanitizeMessageRows } from "../agent/pty-sanitize.js";
import { getSession, attentionFields, createSession, resolveAndEnsureRepoDir, DEFAULT_AGENT_ID } from "./sessions-shared.js";

export function registerCoreRoutes(sessions: Hono): void {
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

}
