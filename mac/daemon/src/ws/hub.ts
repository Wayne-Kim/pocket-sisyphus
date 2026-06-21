import type { WebSocket } from "ws";
import { db } from "../db/index.js";
import { stripTerminalQueries } from "../agent/pty-sanitize.js";

type ClientId = string;

interface Client {
  id: ClientId;
  ws: WebSocket;
  sessionId: string | null;
  /**
   * 앱이 foreground 에서 이 세션을 실제로 «보고 있는» 상태인지. iOS scenePhase 를
   * 미러링한 `visibility` 메시지로 갱신된다. 기본 true — subscribe == 채팅창 진입 ==
   * 보는 중. background 로 가면 false 가 되어 away-gating 이 다시 켜진다.
   *
   * # 왜 필요한가 (소켓 OPEN ≠ 보는 중)
   *
   * iOS 앱이 백그라운드로 가도 (잠금 / 앱 전환) WS 소켓은 한동안 OPEN 으로 남는다 —
   * OS 가 프로세스를 suspend 해도 daemon 쪽 TCP 는 ping timeout 전까지 살아있다.
   * 옛 away-gating 은 `readyState === OPEN` 만 봐서, 정작 사용자가 화면을 안 보는
   * (주머니 속) 그 순간에 Discord 알림을 막아버렸다 — 알림이 가장 필요한 타이밍.
   * 그래서 «보는 중» 판정에 명시적 foreground 신호를 함께 본다.
   */
  active: boolean;
}

const clients = new Map<ClientId, Client>();

/**
 * 한 소켓에 best-effort 로 send 한다. ws 의 send() 는 콜백 없이 부르면 소켓이 OPEN 이 아닌
 * 경계 상태(CLOSING·전송 오류)에서 동기 throw 한다 — readyState 체크와 send 사이의 TOCTOU 로
 * 충분히 발생한다. broadcast 루프가 한 클라이언트의 throw 로 중단되면 (1) 그 뒤 같은 세션
 * 구독자들이 이번 메시지를 못 받고(부분 유실), (2) 예외가 호출자로 샌다. 여기서 per-client
 * 로 격리해 둘 다 막는다 — 실패는 조용히 삼키되 디버그 로깅으로 흔적만 남긴다.
 * 콜백 경로(비동기 오류)는 현재 미사용이라 동기 throw 만 잡으면 충분하다.
 */
function safeSend(
  ws: WebSocket,
  data: string | Buffer,
  options?: { binary: boolean },
): void {
  try {
    if (options) ws.send(data, options);
    else ws.send(data);
  } catch (e) {
    console.warn("[ws] send failed:", (e as Error).message);
  }
}

export function registerClient(id: ClientId, ws: WebSocket): void {
  clients.set(id, { id, ws, sessionId: null, active: true });
}

export function unregisterClient(id: ClientId): void {
  clients.delete(id);
}

export function attachToSession(id: ClientId, sessionId: string): void {
  const c = clients.get(id);
  if (c) {
    c.sessionId = sessionId;
    // subscribe == 사용자가 방금 채팅창에 진입 == 보는 중. background 에서 재연결된
    // 경우라도 iOS 가 subscribe 직후 현재 visibility 를 다시 송신해 곧 교정한다.
    c.active = true;
  }
}

/**
 * 클라이언트의 «보는 중» 상태를 갱신한다. iOS 의 `visibility` WS 메시지 (scenePhase
 * background ↔ foreground 미러링) 가 호출. background → false 면 away-gating 이 다시
 * 켜져 Discord 알림이 나간다.
 */
export function setClientActive(id: ClientId, active: boolean): void {
  const c = clients.get(id);
  if (c) c.active = active;
}

/**
 * WS catch-up — subscribe 시 클라이언트가 since 를 보내면 그 이후 누적된 pty_chunk
 * 들을 즉시 직접 (broadcast 가 아닌 1:1 unicast) 흘려준다.
 *
 * # 왜 필요한가
 *
 * 이전 동작: WS 가 끊겼다 다시 붙으면 daemon 은 «앞으로 들어올» chunk 만 push.
 * 끊긴 동안 발생한 chunk 는 iOS 의 polling fallback 이 줍는데, polling 주기 (1~5s
 * adaptive) 만큼 latency 가 보인다. 사용자 체감: 백그라운드 복귀 직후 화면이
 * 한 박자 늦게 채워지는 현상.
 *
 * # 정책
 *
 * - `since` (epoch ms) 이후의 pty_chunk row 만 backfill. 다른 type (pty_user_input,
 *   pty_exit) 은 iOS 가 polling 으로 충분히 받음.
 * - 한도 1000 — 너무 긴 백로그가 한 번에 쏟아져 socket buffer 가 막히는 걸 방지.
 *   초과 시 가장 최근 1000개로 자르고 «1000 개 한도 도달» 표시는 안 함 (사용자가
 *   안다고 행동을 바꿀 게 없음, 어차피 polling 이 나머지를 채움).
 * - 같은 id 는 iOS 의 seenMessageIds 가드가 막아주므로 중복 feed 걱정 X.
 */
export function replayPtyChunksSince(
  ws: WebSocket,
  sessionId: string,
  since: number,
): void {
  if (ws.readyState !== ws.OPEN) return;
  const rows = db()
    .prepare(
      `SELECT id, payload FROM messages
       WHERE session_id = ? AND type = 'pty_chunk' AND created_at > ?
       ORDER BY created_at ASC LIMIT 1000`,
    )
    .all(sessionId, since) as Array<{ id: string; payload: string }>;
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.payload) as { bytes_b64?: string };
      const b64 = parsed.bytes_b64;
      if (!b64) continue;
      // replay 청크에서 stale 터미널 질의(DA1/kitty/OSC/DSR) 를 제거 — 안 그러면 새로 붙은
      // SwiftTerm 이 옛 질의에 응답을 돌려보내고, 그 응답이 에이전트 입력창에 텍스트로 박힌다.
      // 라이브 broadcast 는 정화하지 않으므로 부팅 시 테마/키보드 협상은 그대로 동작. 변경이
      // 없으면 stripTerminalQueries 가 동일 버퍼를 반환해 base64 재인코딩을 건너뛴다.
      const raw = Buffer.from(b64, "base64");
      const clean = stripTerminalQueries(raw);
      safeSend(
        ws,
        JSON.stringify({
          type: "pty_output",
          sessionId,
          id: row.id,
          bytes_b64: clean === raw ? b64 : clean.toString("base64"),
        }),
      );
    } catch {
      // 손상된 payload 는 조용히 skip — polling 이 정상 row 로 다시 채움.
    }
  }
}

export function broadcastToSession(
  sessionId: string,
  message: unknown,
): void {
  const payload = JSON.stringify(message);
  for (const c of clients.values()) {
    if (c.sessionId === sessionId && c.ws.readyState === c.ws.OPEN) {
      safeSend(c.ws, payload);
    }
  }
}

/** 세션 구독자에게 «바이너리» 프레임 broadcast — H.264 액세스 유닛/파라미터셋 전송용.
 *  Buffer 를 그대로 보내면 ws 가 바이너리 프레임으로 전송한다(iOS 는 .data 로 수신). base64
 *  JSON 대비 +33% 오버헤드와 파싱 비용을 없앤다. */
export function broadcastBinaryToSession(sessionId: string, data: Buffer): void {
  for (const c of clients.values()) {
    if (c.sessionId === sessionId && c.ws.readyState === c.ws.OPEN) {
      safeSend(c.ws, data, { binary: true });
    }
  }
}

/** 세션 소켓들의 최대 bufferedAmount(아직 전송 못 한 바이트) — backpressure 신호. SSH 채널이
 *  못 빼면 sshd→daemon 로컬 소켓이 막혀 이 값이 커진다. 캡처 동적 적응(C)의 입력. */
export function sessionMaxBufferedAmount(sessionId: string): number {
  let max = 0;
  for (const c of clients.values()) {
    if (c.sessionId === sessionId && c.ws.readyState === c.ws.OPEN) {
      const b = c.ws.bufferedAmount ?? 0;
      if (b > max) max = b;
    }
  }
  return max;
}

/**
 * 화면 캡처 프레임을 세션 구독 클라이언트에게 broadcast — capture/sidecar.ts 가 헬퍼 stdout
 * 에서 프레임 한 장을 파싱할 때마다 호출. JPEG 를 base64 로 실어 `screen_frame` 으로 보낸다.
 * 데이터가 커서 (수십~수백 KB) DB 저장/replay 는 하지 않는다 — 실시간 전용, 라이브 시청 중만.
 */
export function broadcastScreenFrameToSession(
  sessionId: string,
  jpeg: Buffer,
  timestampMs: number,
): void {
  const payload = JSON.stringify({
    type: "screen_frame",
    sessionId,
    bytes_b64: jpeg.toString("base64"),
    timestamp: timestampMs,
  });
  for (const c of clients.values()) {
    if (c.sessionId === sessionId && c.ws.readyState === c.ws.OPEN) {
      safeSend(c.ws, payload);
    }
  }
}

export function broadcastAll(message: unknown): void {
  const payload = JSON.stringify(message);
  for (const c of clients.values()) {
    if (c.ws.readyState === c.ws.OPEN) safeSend(c.ws, payload);
  }
}

/**
 * 지금 이 세션을 실시간으로 «보고 있는» (subscribe 한 + 소켓 살아있는 + foreground)
 * 클라이언트가 하나라도 있는지. 알림 away-gating 에 쓴다 — 폰이 채팅창을 열고 스트림을
 * 받는 중이면 Discord 알림을 보내지 않는다 (이미 화면에서 결과를 보고 있으므로 중복/소음).
 *
 * `c.active` 까지 보는 이유는 Client.active 주석 참고 — 앱이 백그라운드로 가면 소켓은
 * OPEN 이어도 사용자가 화면을 안 보므로 «보는 중» 이 아니다.
 */
export function hasActiveSubscriber(sessionId: string): boolean {
  for (const c of clients.values()) {
    if (c.sessionId === sessionId && c.active && c.ws.readyState === c.ws.OPEN) {
      return true;
    }
  }
  return false;
}

export function connectedClientCount(): number {
  let n = 0;
  for (const c of clients.values()) {
    if (c.ws.readyState === c.ws.OPEN) n++;
  }
  return n;
}

/**
 * 모든 WS 클라이언트 연결을 끊고 레지스트리 비움. 페어링 토큰 회전 시 호출 — 옛 토큰으로
 * 인증된 살아 있는 소켓들이 그대로 message 받는 사고 방지.
 */
export function disconnectAllClients(): void {
  for (const c of clients.values()) {
    try {
      // policy violation (1008): 토큰 회전으로 인한 강제 종료.
      c.ws.close(1008, "pairing rotated");
    } catch {
      // 이미 닫혔거나 망가진 소켓 — 무시.
    }
  }
  clients.clear();
}
