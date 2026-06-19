/**
 * PTY 청크 coalescing 버퍼.
 *
 * ## 문제
 *
 * `node-pty` 의 `onData` 는 PTY 가 출력을 토할 때마다 작은 청크 (수십 ~ 수백 바이트) 를
 * 연달아 발화한다. ANSI 화면 redraw 한 번이 보통 5~20 개의 작은 청크로 쪼개져 나오는데,
 * 그 각각을 곧장 WS broadcast 하면:
 *   - 매 청크마다 SQLite INSERT + JSON.stringify + ws.send → CPU 부하
 *   - Tor 회로 위에서 매 청크가 별도 onion-layer 암호화 + 작은 TCP 세그먼트
 *   - 클라이언트의 «화면 완성» 까지 latency = 마지막 청크 RTT, RTT 가 작아도 N 회 직렬화 비용
 *
 * ## 해법
 *
 * 짧은 윈도우 (기본 15ms) 안에 들어온 청크들을 모아 1발로 송신. 윈도우는:
 *   - 첫 청크 도착 시 타이머 시작
 *   - 같은 윈도우 안의 추가 청크는 단순 누적
 *   - 타이머 만료 또는 누적 크기가 maxBytes 초과 시 1회 onFlush 콜백
 *
 * ## 사용자 입력 echo 영향
 *
 * 사용자가 키 입력 → PTY echo 회로: 단일 키스트로크 echo 청크 한 개는 15ms 대기 후 flush.
 * 14ms 추가 latency 는 1 프레임 미만 (60Hz=16.67ms) — 체감 무영향. 반면 ANSI 화면
 * redraw 처럼 ms 단위로 연달아 오는 burst 케이스는 큰 폭으로 압축된다.
 *
 * ## 안전성
 *
 * - ANSI escape sequence 가 청크 경계를 가로질러도 OK — 합쳐서 보내면 클라이언트가 한
 *   덩어리로 파싱. 분리해서 보내도 (현재 동작) iOS SwiftTerm 이 stateful 하게 잘 처리하므로
 *   회귀 위험 없음.
 * - UTF-8 multi-byte sequence 도 같은 이유로 안전.
 *
 * 이 모듈은 timer 외부 의존성이 없어 단위 테스트가 쉽다 — vitest fake timer 로 검증.
 */

export type PtyChunkBufferOptions = {
  /** 첫 청크 후 flush 까지의 대기 시간. 기본 15ms. */
  delayMs?: number;
  /** 누적 바이트가 이 값 이상이면 timer 무시 즉시 flush. 기본 16KB. */
  maxBytes?: number;
  /** flush 시 호출. 호출 후 내부 버퍼는 비워진 상태. */
  onFlush: (bytes: Buffer) => void;
};

export class PtyChunkBuffer {
  private bytes: Buffer[] = [];
  private totalBytes = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly delayMs: number;
  private readonly maxBytes: number;
  private readonly onFlush: (bytes: Buffer) => void;
  private disposed = false;

  constructor(opts: PtyChunkBufferOptions) {
    this.delayMs = opts.delayMs ?? 15;
    this.maxBytes = opts.maxBytes ?? 16 * 1024;
    this.onFlush = opts.onFlush;
  }

  /** 청크 누적. maxBytes 초과 시 즉시 flush. */
  push(chunk: Buffer): void {
    if (this.disposed) return;
    if (chunk.length === 0) return;
    this.bytes.push(chunk);
    this.totalBytes += chunk.length;

    if (this.totalBytes >= this.maxBytes) {
      this.flush();
      return;
    }
    if (this.timer === null) {
      this.timer = setTimeout(() => this.flush(), this.delayMs);
    }
  }

  /** 강제 flush — pty.onExit / session 종료 시. 버퍼가 비어 있으면 noop. */
  flush(): void {
    if (this.disposed) return;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.bytes.length === 0) return;
    const merged = Buffer.concat(this.bytes, this.totalBytes);
    this.bytes = [];
    this.totalBytes = 0;
    this.onFlush(merged);
  }

  /** 세션 종료 — 잔여 flush 후 모든 콜백 차단. */
  dispose(): void {
    if (this.disposed) return;
    this.flush();
    this.disposed = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** 진단용 — 테스트에서 버퍼 상태 확인. */
  get pendingBytes(): number {
    return this.totalBytes;
  }
}
