/**
 * Replay/catch-up 시 PTY 출력에서 «터미널이 응답해야 하는 질의» 시퀀스를 제거한다.
 *
 * ## 문제 (Qwen Code 입력창에 박히는 깨진 텍스트)
 *
 * qwen / claude / codex 같은 에이전트 CLI 는 부팅 시 터미널에게 능력을 물어본다 — Primary
 * Device Attributes (DA1), Kitty keyboard protocol 플래그, OSC 10/11 배경/전경색, DSR 커서
 * 위치 등. 이 질의들은 짧은 타임아웃 안에 응답이 도착하면 협상에 쓰이고, 늦게 오면 그냥
 * stdin 의 일반 입력으로 취급된다.
 *
 * Pocket Sisyphus 는 PTY 출력을 `messages.pty_chunk` 로 저장해 두고 클라이언트 재접속/세션
 * 재진입 때 replay 한다 (hub.replayPtyChunksSince, GET /:id, GET /:id/poll). 이 replay 버퍼
 * 안에는 에이전트가 부팅 시 보낸 질의 시퀀스가 그대로 들어 있어서, 새로 붙은 SwiftTerm 이
 * 그 옛 질의를 받고 충실히 응답을 PTY 로 돌려보낸다. 하지만 에이전트의 질의 타임아웃은
 * 이미 한참 지났으므로 그 응답은 입력창에 텍스트로 박힌다:
 *
 *   [?0u[?65;4;1;2;6;21;22;17;28c11;rgb:0000/0000/0000
 *   └ kitty 응답  └ DA1 응답                  └ OSC 11 응답
 *
 * Claude Code 는 늦은 응답을 조용히 삼켜 안 보였을 뿐, 같은 stale 응답이 모든 에이전트의
 * PTY 로 흘러들고 있었다.
 *
 * ## 해법 — replay/읽기 경로에서만 질의를 걷어낸다
 *
 * 라이브 broadcast (pty-runner onFlush) 는 건드리지 않는다 — 클라이언트가 붙어 있는 동안의
 * 테마 감지/키보드 협상은 정상 동작해야 하므로. 오직 «과거 청크를 다시 흘리는» 읽기 경로에서만
 * 질의 시퀀스를 제거한다. replay 시점엔 어떤 응답도 이미 stale 라 어느 에이전트에게도 쓸모가
 * 없으므로 손실이 없다.
 *
 * ## 안전성 — 무엇을 매칭하고 무엇을 절대 안 건드리나
 *
 * 오직 «응답을 유발하는 질의» 형태만 매칭한다. 화면 상태에 영향을 주는 시퀀스는 매칭 대상이
 * 아니라 replay 후 터미널 상태가 어긋나지 않는다:
 *   - 모드 설정 CSI ... h / l (bracketed paste ?2004, alt screen ?1049, 커서 가시성 ?25) — 미매칭
 *   - Kitty push CSI > flags u / pop CSI < u / set CSI = ... u — 미매칭 (질의 CSI ? u 만 제거)
 *   - SGR/커서 이동 등 일반 렌더 시퀀스 — final byte 가 c/u/n 이 아니라 미매칭
 *
 * ## 한계
 *
 * 청크 단위 stateless 처리라, 질의 시퀀스가 두 pty_chunk row 에 반토막으로 걸치면 (15ms
 * coalescing 경계가 시퀀스 중간에 떨어지는 희귀 케이스) 놓칠 수 있다. 그 경우 동작은 현재와
 * 동일 (질의 1개 통과) — 악화는 없다. 에이전트는 보통 질의들을 한 번의 write 로 묶어 보내므로
 * 실제로는 한 청크 안에 들어온다.
 */

/**
 * 제거 대상 질의 시퀀스. 모두 global 플래그 — String.replace 가 모든 occurrence 를 지우고,
 * replace 는 lastIndex 를 건드리지 않아 정규식 재사용이 안전하다.
 */
const QUERY_PATTERNS: RegExp[] = [
  // DA1/DA2/DA3 device attributes 질의: CSI [<=>]? Ps c
  // 응답 형태 CSI ? ... c 는 '[' 다음이 '?' 라 미매칭 (방어적 — 응답은 출력 스트림에 안 나옴).
  // final byte 'c' 는 CSI 에서 device attributes 전용이라 일반 렌더 시퀀스와 충돌하지 않는다.
  /\x1b\[[<=>]?[0-9;]*c/g,
  // Kitty keyboard protocol 현재 플래그 질의: CSI ? u
  // push(CSI > u) / pop(CSI < u) / set(CSI = ... u) 은 상태 변경이라 매칭하지 않는다.
  /\x1b\[\?u/g,
  // DSR 커서/장치 상태 질의: CSI ?? [56] n
  // 응답 CSI row;col R / CSI 0 n 은 final byte 가 달라 미매칭.
  /\x1b\[\??[56]n/g,
  // OSC 10/11/12 색상 질의: OSC 1[012] ; ? (BEL | ST)
  // 종결자는 BEL(0x07) 또는 ST(ESC \). '?' 가 있는 «질의» 만 — 색 «설정» (OSC 11 ; rgb:...) 은 미매칭.
  /\x1b\]1[012];\?(?:\x07|\x1b\\)/g,
];

/**
 * 버퍼에서 터미널 질의 시퀀스를 제거한다. 변경이 없으면 입력 버퍼를 그대로(동일 참조) 반환해
 * 호출부가 `=== ` 로 no-op 을 싸게 판별할 수 있게 한다.
 *
 * latin1 경유 이유: 매칭 대상 바이트가 모두 < 0x80 이라 latin1 의 1바이트=1문자 매핑이
 * 한글 등 multi-byte UTF-8 바이트를 깨지 않고 byte 단위로 정확히 스캔/복원한다.
 */
export function stripTerminalQueries(buf: Buffer): Buffer {
  // 빠른 경로 — ESC 가 없으면 어떤 질의도 없다.
  if (!buf.includes(0x1b)) return buf;
  const before = buf.toString("latin1");
  let after = before;
  for (const re of QUERY_PATTERNS) after = after.replace(re, "");
  if (after.length === before.length) return buf;
  return Buffer.from(after, "latin1");
}

/**
 * 입력 방향(클라이언트 → PTY)에서 «터미널이 질의에 자동 회신한 응답» 시퀀스를 제거한다.
 *
 * stripTerminalQueries 가 출력/replay 의 «질의» 를 지운다면, 이쪽은 입력의 «응답» 을 지운다.
 * 폰↔데몬 高지연 왕복 탓에 SwiftTerm 의 응답(DA/kitty/OSC color)이 에이전트의 질의 탐지
 * 타임아웃을 넘겨 stdin 에 도착하면 입력창에 텍스트로 박힌다([?0u[?65;...c11;rgb:... 버그).
 * 1차 방어는 iOS send() 가 source 에서 막지만, 데몬도 마지막 게이트로 한 번 더 거른다 —
 * 구버전/타 클라이언트가 붙어도 에이전트 stdin 이 깨끗하도록.
 *
 * 보존: 화살표(CSI A-D), 커서 위치 응답(CSI ... R), kitty «키» 인코딩(CSI <code> u — '?' 없음),
 * Ctrl-C/D/Z 등 — 사용자 입력은 그대로 흐른다.
 */
const RESPONSE_PATTERNS: RegExp[] = [
  // Kitty keyboard 현재 플래그 응답: CSI ? flags u  (키 인코딩 CSI <code> u 는 '?' 없음 → 미매칭)
  /\x1b\[\?[0-9;]*u/g,
  // DA1/DA2/DA3 응답: CSI [?>=] ... c
  /\x1b\[[?>=][0-9;]*c/g,
  // OSC 10/11/12 색상 응답: OSC 1[012] ; ... (BEL | ST). non-greedy 로 첫 종결자까지.
  /\x1b\]1[012];[\s\S]*?(?:\x07|\x1b\\)/g,
];

export function stripTerminalQueryResponses(buf: Buffer): Buffer {
  if (!buf.includes(0x1b)) return buf;
  const before = buf.toString("latin1");
  let after = before;
  for (const re of RESPONSE_PATTERNS) after = after.replace(re, "");
  if (after.length === before.length) return buf;
  return Buffer.from(after, "latin1");
}

/**
 * 라이브 PTY 출력에서 «위험» 시퀀스를 중화한다 (broadcast/저장 직전).
 *
 * ## 위협 모델 — 인젝션 «진입 이후 표면»
 *
 * 에이전트가 신뢰 못 할 콘텐츠(cat 한 파일, fetch 한 웹페이지, LLM 응답)를 그대로 출력하면
 * 그 바이트가 폰 SwiftTerm 에 raw 로 렌더된다. 정상 렌더 시퀀스(SGR 색·커서 이동·alt
 * screen·모드 설정)는 무해하지만, 일부 OSC/CSI 는 터미널 자체를 공격면으로 만든다:
 *
 *   - OSC 52: 터미널 «클립보드 set». 악성 콘텐츠가 사용자 클립보드를 조용히 덮어쓴다
 *     (다음 붙여넣기에 rm -rf / 피싱 URL 주입). → 통째 제거.
 *   - OSC 0/1/2: 창/탭 «제목» 변조. 신뢰 UI 사칭·혼란 유발. → 통째 제거.
 *   - REP (CSI Ps b): 직전 글자를 Ps 번 반복. `CSI 99999999 b` 한 줄이 수천만 글자로
 *     폭발 → 메모리/렌더 DoS (character multiplier). → Ps 를 MAX_REP_COUNT 로 클램프.
 *
 * 질의 strip(stripTerminalQueries)과 달리 이 정화는 «라이브» 경로에 적용한다 — 이 시퀀스들은
 * 터미널 협상에 필요 없는 순수 위험이라 항상 막아도 정상 동작 손실이 없다. SGR·커서 이동·
 * alt screen·bracketed paste 같은 정상 렌더/모드 시퀀스는 매칭 대상이 아니라 보존된다.
 *
 * 기본 차단. 디버그로 원본을 봐야 하면 PS_PTY_ALLOW_UNSAFE_OSC=1 로 옵트아웃(passthrough).
 *
 * 한계: stripTerminalQueries 와 동일하게 청크 단위 stateless 처리라, OSC 가 두 pty_chunk 에
 * 종결자 기준으로 반토막 걸치는 희귀 케이스(>16KB 클립보드 등)는 놓칠 수 있다. 제목/일반
 * 클립보드 set 은 한 번의 write 로 종결자까지 한 청크에 들어오므로 실제로는 잡힌다.
 */
/** REP(CSI Ps b) 반복 횟수 상한 — 한 화면을 채우고도 남는 값. DoS 폭발만 막고 정상 사용은 안 건드린다. */
export const MAX_REP_COUNT = 4096;

// OSC 52 클립보드 set: OSC 52 ; ... (BEL | ST). base64 페이로드는 BEL/ESC 를 안 가져 non-greedy 안전.
const OSC_CLIPBOARD = /\x1b\]52;[\s\S]*?(?:\x07|\x1b\\)/g;
// OSC 0/1/2 제목: OSC [012] ; ... (BEL | ST). 색상 질의 OSC 10/11/12 는 '[012]' 뒤가 ';' 가 아니라(두 자리) 미매칭.
const OSC_TITLE = /\x1b\][012];[\s\S]*?(?:\x07|\x1b\\)/g;
// REP: CSI Ps b — 직전 graphic 글자를 Ps 번 반복. 파라미터 없는 CSI b(=1회)는 무해해 미매칭.
const REP_SEQ = /\x1b\[([0-9]+)b/g;

export function sanitizeLivePtyOutput(buf: Buffer): Buffer {
  // 빠른 경로 — ESC 가 없으면 어떤 위험 시퀀스도 없다.
  if (!buf.includes(0x1b)) return buf;
  const before = buf.toString("latin1");
  let after = before.replace(OSC_CLIPBOARD, "").replace(OSC_TITLE, "");
  after = after.replace(REP_SEQ, (m, n: string) => {
    const count = Number(n);
    return count > MAX_REP_COUNT ? `\x1b[${MAX_REP_COUNT}b` : m;
  });
  if (after === before) return buf;
  return Buffer.from(after, "latin1");
}

/**
 * `pty_chunk` payload (JSON: { bytes_b64 }) 한 건을 정화. 변경이 없으면 원본 payload 문자열을
 * 그대로 반환해 불필요한 재직렬화를 피한다.
 */
export function sanitizePtyChunkPayload(payload: string): string {
  try {
    const parsed = JSON.parse(payload) as { bytes_b64?: string };
    if (!parsed.bytes_b64) return payload;
    const raw = Buffer.from(parsed.bytes_b64, "base64");
    const stripped = stripTerminalQueries(raw);
    if (stripped === raw) return payload; // 변경 없음
    parsed.bytes_b64 = stripped.toString("base64");
    return JSON.stringify(parsed);
  } catch {
    // 손상된 payload — 손대지 않고 그대로 (읽기 경로의 기존 정책과 동일).
    return payload;
  }
}

/**
 * 메시지 row 배열에서 `pty_chunk` 의 payload 만 정화해 새 배열을 만든다. 다른 type 은 그대로.
 * HTTP 읽기 경로 (GET /:id, GET /:id/poll) 가 응답 직전에 호출한다.
 */
export function sanitizeMessageRows<T extends { type: string; payload: string }>(
  rows: T[],
): T[] {
  return rows.map((r) =>
    r.type === "pty_chunk" ? { ...r, payload: sanitizePtyChunkPayload(r.payload) } : r,
  );
}
