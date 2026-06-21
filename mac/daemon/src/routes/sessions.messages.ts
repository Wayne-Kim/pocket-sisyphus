import type { Hono } from "hono";
import { db } from "../db/index.js";
import {
  runUserMessagePty,
} from "../agent/pty-runner.js";
import { getAgent } from "../agent/registry.js";
import { sanitizeMessageRows } from "../agent/pty-sanitize.js";
import { getSession, attentionFields, DEFAULT_AGENT_ID } from "./sessions-shared.js";

export function registerMessagesRoutes(sessions: Hono): void {
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

}
