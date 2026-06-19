/**
 * PTY 화면 스냅샷 (pty_snapshot_v1).
 *
 * # 왜 필요한가 — «로그» 가 아니라 «상태» 를 보낸다
 *
 * PTY 출력은 ANSI 바이트 스트림이라 K번째 청크의 화면 의미가 1..K-1 전체에 의존한다(커서·
 * 색·alt-screen·scroll region·clear). 그래서 콜드 진입 때 «전체 청크» 를 내려보내면 긴 세션은
 * 수천 행(base64)이 되어 Tor 경유 ~5s 가 걸렸다 (P1 tail 캡이 1차로 줄였다).
 *
 * 이 모듈은 한 발 더 나아가, 요청 시점에 헤드리스 VT(@xterm/headless)로 최근 tail 을 replay 해
 * «현재 화면 + 경계지은 scrollback» 을 한 덩이로 직렬화(@xterm/addon-serialize)한다. 그러면
 * 전송량이 «청크 바이트 총합(스피너/리페인트 프레임 포함)» 이 아니라 «최종 화면 상태» = O(화면
 * +scrollback) 로 고정된다. 중간 스피너 프레임/리페인트가 접혀 사라지므로 글리치도 없다.
 *
 * # 라이브 서브시스템이 아니라 «요청 시 재구성» 인 이유
 *
 * 세션마다 살아있는 헤드리스 터미널을 유지하면 메모리/수명/write 타이밍 레이스가 따라온다.
 * 콜드 진입은 드문 이벤트라, 그때만 bounded tail 을 새 터미널에 동기로 replay 하면 충분하다 —
 * 상태가 없어 단순하고, write 콜백으로 drain 한 뒤 직렬화해 레이스도 없다.
 */
import xtermHeadless from "@xterm/headless";
import xtermAddonSerialize from "@xterm/addon-serialize";
import { db } from "../db/index.js";
import { stripTerminalQueries } from "./pty-sanitize.js";

// @xterm/headless·addon-serialize 는 CJS 패키지(main=lib-headless/*.js)라 named import 가
// 런타임 로더(tsx)에서 «export named 'Terminal' 없음» 으로 깨진다(cjs-module-lexer 가 동적
// 할당 export 를 못 잡음). default import = module.exports 로 받아 구조분해해야 tsx/node ESM
// 양쪽에서 동작한다. (vitest 의 esbuild 변환은 named 도 통과하지만 앱은 tsx 로 돈다.)
const { Terminal } = xtermHeadless;
const { SerializeAddon } = xtermAddonSerialize;

/** PTY 가 죽어 cols/rows 를 못 읽을 때의 기본값 — pty-runner 의 spawn 초기값과 같은 자릿수. */
const DEFAULT_COLS = 130;
const DEFAULT_ROWS = 40;
/** 스냅샷 재구성에 쓸 최근 pty_chunk tail 상한 — 화면+scrollback 복원에 충분하면서 비용 bounded. */
export const SNAPSHOT_TAIL_CHUNKS = 4000;
/** 직렬화 scrollback 줄 상한 — 응답 크기 bounded. */
export const SNAPSHOT_SCROLLBACK = 5000;

export interface PtySnapshot {
  /** 화면+scrollback 을 재구성하는 직렬화 ANSI. fresh 터미널(콜드 SwiftTerm)에 그대로 feed. */
  snapshot: string;
  cols: number;
  rows: number;
  /** 이 스냅샷에 반영된 마지막 pty_chunk 의 created_at — 클라이언트가 이후를 증분으로 잇는 watermark. */
  throughCreatedAt: number;
  /** tail 캡으로 더 오래된 청크가 잘렸는가 (정보용). */
  truncated: boolean;
}

/**
 * 세션의 최근 PTY 출력을 헤드리스 터미널로 replay 해 화면 스냅샷을 만든다.
 *
 * @param sessionId 대상 세션.
 * @param opts.cols/rows 헤드리스 터미널 폭 — 보통 살아있는 PTY 의 현재 cols/rows(`getPtySize`).
 *        없으면 기본값. (과거 청크가 다른 폭에서 났어도 xterm 이 reflow 한다.)
 */
export async function buildPtySnapshot(
  sessionId: string,
  opts?: { cols?: number; rows?: number },
): Promise<PtySnapshot> {
  const cols = Math.max(1, opts?.cols ?? DEFAULT_COLS);
  const rows = Math.max(1, opts?.rows ?? DEFAULT_ROWS);

  // 최신 tail 청크 — DESC 로 끌어와 ASC 로 뒤집어 시간순 replay. +1 로 truncated 판정.
  const desc = db()
    .prepare(
      `SELECT id, payload, created_at FROM messages
       WHERE session_id = ? AND type = 'pty_chunk'
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    )
    .all(sessionId, SNAPSHOT_TAIL_CHUNKS + 1) as Array<{
    id: string;
    payload: string;
    created_at: number;
  }>;
  const truncated = desc.length > SNAPSHOT_TAIL_CHUNKS;
  const ordered = desc.slice(0, SNAPSHOT_TAIL_CHUNKS).reverse();

  const buffers: Buffer[] = [];
  let throughCreatedAt = 0;
  for (const r of ordered) {
    try {
      const parsed = JSON.parse(r.payload) as { bytes_b64?: string };
      if (!parsed.bytes_b64) continue;
      const raw = Buffer.from(parsed.bytes_b64, "base64");
      // replay 청크의 stale 터미널 질의(DA1/kitty/OSC/DSR) 제거 — 헤드리스 터미널이 응답을
      // 만들 일은 없지만(소켓 없음), 출력 스트림에 섞인 질의 바이트가 직렬화에 새는 걸 막는다.
      buffers.push(stripTerminalQueries(raw));
      throughCreatedAt = r.created_at;
    } catch {
      // 손상 payload 는 skip.
    }
  }

  if (buffers.length === 0) {
    return { snapshot: "", cols, rows, throughCreatedAt: 0, truncated: false };
  }

  const term = new Terminal({
    cols,
    rows,
    scrollback: SNAPSHOT_SCROLLBACK,
    allowProposedApi: true,
  });
  const ser = new SerializeAddon();
  term.loadAddon(ser);
  try {
    // write 는 비동기 파싱 — 콜백으로 drain 한 뒤에 직렬화해야 마지막 바이트까지 반영된다.
    await new Promise<void>((resolve) => term.write(Buffer.concat(buffers), () => resolve()));
    const snapshot = ser.serialize({ scrollback: SNAPSHOT_SCROLLBACK });
    return { snapshot, cols, rows, throughCreatedAt, truncated };
  } finally {
    term.dispose();
  }
}
