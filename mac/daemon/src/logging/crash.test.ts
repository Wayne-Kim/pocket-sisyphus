// 크래시 핸들러 회귀 테스트 — 핸들러가 (a) 풀스택을 기록하고 (b) 비정상 종료코드로 끝나며
// (c) 비밀을 마스킹하는지. crash-only 정책(복구 시도 없이 비정상 종료)과 컨텍스트(인스턴스
// id·boot ppid·마지막 채널 이벤트) 보존도 함께 단언한다.

import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildCrashReport,
  makeCrashHandler,
  CRASH_EXIT_CODE,
  type CrashContext,
} from "./crash.js";

const CTX: CrashContext = {
  instanceId: "abc123",
  bootPpid: 1000,
  currentPpid: 1,
  pid: 2000,
  lastChannelEvent: {
    channel: "ws",
    level: "info",
    action: "ws.connect",
    at: "2026-06-20T00:00:00.000Z",
  },
};

describe("buildCrashReport", () => {
  it("(a) 풀스택을 보존한다 (메시지 + 다중 프레임)", () => {
    function inner(): never {
      throw new Error("boom-xyz");
    }
    let err: unknown;
    try {
      inner();
    } catch (e) {
      err = e;
    }
    const r = buildCrashReport("uncaughtException", err, CTX, []);
    expect(r.error.name).toBe("Error");
    expect(r.error.message).toContain("boom-xyz");
    // 풀스택 = 메시지 + 적어도 한 개의 «at …» 프레임.
    expect(r.error.stack).toContain("boom-xyz");
    expect(r.error.stack).toContain("at ");
    expect(r.kind).toBe("uncaughtException");
  });

  it("컨텍스트(인스턴스 id·boot ppid·마지막 채널 이벤트)를 보존한다", () => {
    const r = buildCrashReport("uncaughtException", new Error("x"), CTX, []);
    expect(r.context.instanceId).toBe("abc123");
    expect(r.context.bootPpid).toBe(1000);
    expect(r.context.lastChannelEvent?.channel).toBe("ws");
    expect(r.context.lastChannelEvent?.action).toBe("ws.connect");
  });

  it("(c) 비밀(아는 값·Bearer 패턴)을 마스킹하되 스택 프레임은 보존한다", () => {
    const secret = "Hm6K2pLq9XyZ-supersecrettoken";
    const err = new Error(`auth failed token=${secret} Authorization: Bearer ${secret}`);
    const r = buildCrashReport("uncaughtException", err, CTX, [secret]);
    expect(r.error.message).not.toContain(secret);
    expect(r.error.message).toContain("***");
    // 스택의 «at …» 프레임은 비밀이 아니므로 그대로 남는다.
    expect(r.error.stack).toContain("at ");
  });

  it("Error 가 아닌 reason(문자열)도 정규화해 기록한다", () => {
    const r = buildCrashReport("unhandledRejection", "string-reason", CTX, []);
    expect(r.kind).toBe("unhandledRejection");
    expect(r.error.message).toContain("string-reason");
  });
});

describe("makeCrashHandler — crash-only", () => {
  it("(b) record 후 비정상 종료코드로 exit 한다", () => {
    const exit = vi.fn();
    const record = vi.fn();
    const handler = makeCrashHandler({
      exit,
      record,
      context: () => CTX,
      secrets: () => [],
    });
    handler("uncaughtException", new Error("kaboom"));
    expect(record).toHaveBeenCalledTimes(1);
    const report = record.mock.calls[0]![0]! as { error: { stack: string } };
    // 풀스택을 record 로 넘겼는지.
    expect(report.error.stack).toContain("kaboom");
    // 비정상 종료코드 — 0(정상)이 아님.
    expect(exit).toHaveBeenCalledWith(CRASH_EXIT_CODE);
    expect(CRASH_EXIT_CODE).not.toBe(0);
  });

  it("record 가 던져도 반드시 exit 한다 (크래시 처리 중 매달림 방지)", () => {
    const exit = vi.fn();
    const record = vi.fn(() => {
      throw new Error("logging subsystem itself broke");
    });
    const handler = makeCrashHandler({
      exit,
      record,
      context: () => CTX,
      secrets: () => [],
    });
    handler("unhandledRejection", new Error("x"));
    expect(exit).toHaveBeenCalledWith(CRASH_EXIT_CODE);
  });
});

describe("recordCrash — 디스크 기록 (격리 CONFIG_DIR)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ps-crash-"));
    vi.stubEnv("POCKET_CLAUDE_CONFIG_DIR", tmp);
    // CONFIG_DIR/LOGS_DIR/CRASH_DIR 가 stub 된 env 로 재계산되도록 모듈 캐시 초기화.
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it("unified.log 에 fatal 라인 + crash 마커 파일을 남긴다", async () => {
    const mod = await import("./crash.js");
    const report = mod.buildCrashReport(
      "uncaughtException",
      new Error("disk-boom"),
      {
        instanceId: "deadbe",
        bootPpid: 1,
        currentPpid: 1,
        pid: 42,
        lastChannelEvent: null,
      },
      [],
    );
    const { markerPath } = mod.recordCrash(report);

    // (마커) 파일이 존재하고 풀스택을 담는다.
    expect(markerPath).toBeTruthy();
    expect(fs.existsSync(markerPath!)).toBe(true);
    const marker = JSON.parse(fs.readFileSync(markerPath!, "utf8"));
    expect(marker.kind).toBe("uncaughtException");
    expect(marker.error.stack).toContain("disk-boom");

    // (fatal 로그) unified.log 에 crash 라인이 fatal 로 남는다.
    const logFile = path.join(tmp, "logs", "unified.log");
    expect(fs.existsSync(logFile)).toBe(true);
    const logText = fs.readFileSync(logFile, "utf8");
    expect(logText).toContain("daemon.crash");
    expect(logText).toContain("disk-boom");
    expect(logText).toContain('"log.level":"fatal"');
  });
});
