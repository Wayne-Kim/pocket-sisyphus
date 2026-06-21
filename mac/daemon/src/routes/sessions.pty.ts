import type { Hono } from "hono";
import { db } from "../db/index.js";
import {
  runUserMessagePty,
  prewarmPty,
  abortPtySession,
  awaitPtyExit,
  resizePty,
  sendPtyKey,
  writePtyRaw,
  setNotifyNextStop,
  getPtySize,
} from "../agent/pty-runner.js";
import { getAgent } from "../agent/registry.js";
import { buildPtySnapshot } from "../agent/pty-snapshot.js";
import { getSession, attentionFields, DEFAULT_AGENT_ID } from "./sessions-shared.js";

export function registerPtyRoutes(sessions: Hono): void {
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

}
