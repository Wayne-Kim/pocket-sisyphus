import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PtyChunkBuffer } from "./pty-coalesce.js";

describe("PtyChunkBuffer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("타이머 만료 시 1번 flush + 누적된 청크를 concat 한 결과 전달", () => {
    const flushed: Buffer[] = [];
    const buf = new PtyChunkBuffer({
      delayMs: 15,
      onFlush: (b) => flushed.push(b),
    });

    buf.push(Buffer.from("hello "));
    buf.push(Buffer.from("world"));

    expect(flushed.length).toBe(0); // 아직 timer 안 만료
    vi.advanceTimersByTime(15);
    expect(flushed.length).toBe(1);
    expect(flushed[0].toString()).toBe("hello world");
  });

  it("연달아 push 들어와도 첫 timer 만 살아남고 1회 flush", () => {
    const flushed: Buffer[] = [];
    const buf = new PtyChunkBuffer({ delayMs: 15, onFlush: (b) => flushed.push(b) });

    buf.push(Buffer.from("a"));
    vi.advanceTimersByTime(5);
    buf.push(Buffer.from("b"));
    vi.advanceTimersByTime(5);
    buf.push(Buffer.from("c"));
    vi.advanceTimersByTime(5); // 누적 15ms — flush

    expect(flushed.length).toBe(1);
    expect(flushed[0].toString()).toBe("abc");
  });

  it("maxBytes 초과하면 timer 무시 즉시 flush", () => {
    const flushed: Buffer[] = [];
    const buf = new PtyChunkBuffer({
      delayMs: 15,
      maxBytes: 8,
      onFlush: (b) => flushed.push(b),
    });

    buf.push(Buffer.from("12345"));
    expect(flushed.length).toBe(0);
    buf.push(Buffer.from("6789"));   // 9 bytes 누적 → maxBytes(8) 초과
    expect(flushed.length).toBe(1);
    expect(flushed[0].toString()).toBe("123456789");
  });

  it("flush() 명시 호출 시 즉시 비움", () => {
    const flushed: Buffer[] = [];
    const buf = new PtyChunkBuffer({ delayMs: 15, onFlush: (b) => flushed.push(b) });

    buf.push(Buffer.from("partial"));
    buf.flush();

    expect(flushed.length).toBe(1);
    expect(flushed[0].toString()).toBe("partial");
    expect(buf.pendingBytes).toBe(0);
  });

  it("빈 상태에서 flush 호출은 콜백 안 부름", () => {
    const flushed: Buffer[] = [];
    const buf = new PtyChunkBuffer({ delayMs: 15, onFlush: (b) => flushed.push(b) });

    buf.flush();
    expect(flushed.length).toBe(0);
  });

  it("dispose 후엔 더 이상 push 가 accept 되지 않음", () => {
    const flushed: Buffer[] = [];
    const buf = new PtyChunkBuffer({ delayMs: 15, onFlush: (b) => flushed.push(b) });

    buf.push(Buffer.from("kept"));
    buf.dispose(); // 잔여 flush + 폐쇄

    expect(flushed.length).toBe(1);
    expect(flushed[0].toString()).toBe("kept");

    buf.push(Buffer.from("ignored"));
    vi.advanceTimersByTime(100);
    expect(flushed.length).toBe(1); // 변함 없음
  });

  it("빈 청크 push 는 noop", () => {
    const flushed: Buffer[] = [];
    const buf = new PtyChunkBuffer({ delayMs: 15, onFlush: (b) => flushed.push(b) });

    buf.push(Buffer.from(""));
    vi.advanceTimersByTime(100);
    expect(flushed.length).toBe(0);
  });

  it("UTF-8 multi-byte 가 청크 경계를 가로질러도 concat 결과는 동일 bytes", () => {
    const flushed: Buffer[] = [];
    const buf = new PtyChunkBuffer({ delayMs: 15, onFlush: (b) => flushed.push(b) });

    // "한" (U+D55C) = ED 95 9C (UTF-8 3 bytes). 청크 경계를 그 사이에 끼움.
    buf.push(Buffer.from([0xed]));
    buf.push(Buffer.from([0x95, 0x9c]));
    vi.advanceTimersByTime(15);

    expect(flushed.length).toBe(1);
    expect(flushed[0].toString("utf8")).toBe("한");
  });

  it("flush 후 새 push 도 정상적으로 누적 + 다음 timer 시작", () => {
    const flushed: Buffer[] = [];
    const buf = new PtyChunkBuffer({ delayMs: 15, onFlush: (b) => flushed.push(b) });

    buf.push(Buffer.from("first"));
    vi.advanceTimersByTime(15);
    expect(flushed.length).toBe(1);

    buf.push(Buffer.from("second"));
    vi.advanceTimersByTime(15);
    expect(flushed.length).toBe(2);
    expect(flushed[1].toString()).toBe("second");
  });
});
