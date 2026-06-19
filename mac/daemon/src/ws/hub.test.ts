/**
 * ws/hub broadcast per-client 격리 단위 테스트.
 *
 * 회귀 방지: 한 소켓의 send 가 동기 throw 해도(소켓 CLOSING/오류 경계) 같은 세션의 나머지
 * OPEN 구독자는 정상적으로 payload 를 받고, broadcast 가 호출자에게 예외를 던지지 않는다.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  registerClient,
  unregisterClient,
  attachToSession,
  broadcastToSession,
  broadcastBinaryToSession,
  broadcastAll,
} from "./hub.js";

const OPEN = 1;

interface FakeWs {
  readyState: number;
  OPEN: number;
  send: (data: unknown, options?: unknown) => void;
  received: unknown[];
}

function makeWs(opts?: { throwOnSend?: boolean }): FakeWs {
  const received: unknown[] = [];
  return {
    readyState: OPEN,
    OPEN,
    received,
    send(data: unknown) {
      if (opts?.throwOnSend) throw new Error("WebSocket is not open");
      received.push(data);
    },
  };
}

describe("hub broadcast per-client isolation", () => {
  beforeEach(() => {
    // 이전 테스트의 클라이언트 잔류 제거.
    for (const id of ["good", "bad", "other"]) unregisterClient(id);
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("broadcastToSession: 한 소켓의 send throw 가 나머지 구독자 수신을 막지 않는다", () => {
    const bad = makeWs({ throwOnSend: true });
    const good = makeWs();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerClient("bad", bad as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerClient("good", good as any);
    attachToSession("bad", "s1");
    attachToSession("good", "s1");

    expect(() =>
      broadcastToSession("s1", { type: "ping" }),
    ).not.toThrow();

    expect(good.received).toHaveLength(1);
    expect(JSON.parse(good.received[0] as string)).toEqual({ type: "ping" });
  });

  it("broadcastBinaryToSession: throw 격리 + healthy 소켓 수신", () => {
    const bad = makeWs({ throwOnSend: true });
    const good = makeWs();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerClient("bad", bad as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerClient("good", good as any);
    attachToSession("bad", "s1");
    attachToSession("good", "s1");

    const buf = Buffer.from([1, 2, 3]);
    expect(() => broadcastBinaryToSession("s1", buf)).not.toThrow();
    expect(good.received).toEqual([buf]);
  });

  it("broadcastAll: throw 격리 + healthy 소켓 수신", () => {
    const bad = makeWs({ throwOnSend: true });
    const good = makeWs();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerClient("bad", bad as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerClient("good", good as any);

    expect(() => broadcastAll({ type: "status" })).not.toThrow();
    expect(good.received).toHaveLength(1);
    expect(JSON.parse(good.received[0] as string)).toEqual({ type: "status" });
  });
});
