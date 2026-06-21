// `diagnostics/codes.ts` — 분류 함수 단위 테스트.
//
// 계약: 각 classify* 가 «관측 신호 입력 → 안정적 코드» 로 결정적이어야 한다. 코드별로 한 줄씩
// 못박아, iOS localize 매핑이 의존하는 식별자가 조용히 바뀌는 회귀를 막는다.

import { describe, it, expect } from "vitest";
import {
  classifyTor,
  classifySsh,
  classifyReachability,
  classifyAgentCli,
  classifyDisk,
  classifyLogs,
  classifySpawnFailure,
  worstLevel,
  DISK_LOW_BYTES,
  DISK_CRITICAL_BYTES,
  LOG_OVERSIZED_BYTES,
  PTY_CHUNK_OVERSIZED_COUNT,
} from "./codes.js";

describe("classifyTor", () => {
  it("프로세스 죽음 → tor_process_down (error, 최우선)", () => {
    // 부트스트랩/onion 신호가 다 정상이어도 프로세스가 죽었으면 그게 먼저.
    expect(classifyTor({ processAlive: false, bootstrapped: true, onionPresent: true })).toEqual({
      level: "error",
      code: "tor_process_down",
    });
  });
  it("부팅 미완 → tor_not_bootstrapped (warning)", () => {
    expect(classifyTor({ processAlive: true, bootstrapped: false, onionPresent: false })).toEqual({
      level: "warning",
      code: "tor_not_bootstrapped",
    });
  });
  it("부팅 완료인데 onion 미게시 → tor_descriptor_missing (error) — 재현 (a)", () => {
    expect(classifyTor({ processAlive: true, bootstrapped: true, onionPresent: false })).toEqual({
      level: "error",
      code: "tor_descriptor_missing",
    });
  });
  it("정상 → ok", () => {
    expect(classifyTor({ processAlive: true, bootstrapped: true, onionPresent: true })).toEqual({
      level: "ok",
      code: "ok",
    });
  });
});

describe("classifySsh", () => {
  it("호스트 키 불일치 → ssh_hostkey_mismatch (error, listening 여부보다 우선)", () => {
    expect(classifySsh({ processAlive: true, hostKeyMismatch: true })).toEqual({
      level: "error",
      code: "ssh_hostkey_mismatch",
    });
  });
  it("listener 부재 → ssh_not_listening (error)", () => {
    expect(classifySsh({ processAlive: false })).toEqual({
      level: "error",
      code: "ssh_not_listening",
    });
  });
  it("정상 → ok", () => {
    expect(classifySsh({ processAlive: true })).toEqual({ level: "ok", code: "ok" });
  });
});

describe("classifyReachability", () => {
  it("LAN 전용 + 후보 0 → lan_blocked_no_public_fallback (error) — 재현 (b)", () => {
    expect(classifyReachability({ lanOnly: true, lanCandidateCount: 0 })).toEqual({
      level: "error",
      code: "lan_blocked_no_public_fallback",
    });
  });
  it("LAN 전용 + 후보 있음 → ok (같은 Wi-Fi 에서 연결 가능)", () => {
    expect(classifyReachability({ lanOnly: true, lanCandidateCount: 2 })).toEqual({
      level: "ok",
      code: "ok",
    });
  });
  it("LAN 전용 아님(듀얼 채널) → ok (후보 0이어도 공인/onion 폴백 있음)", () => {
    expect(classifyReachability({ lanOnly: false, lanCandidateCount: 0 })).toEqual({
      level: "ok",
      code: "ok",
    });
  });
});

describe("classifyAgentCli", () => {
  it("미탐지 → agent_cli_missing (warning, «설정 필요») — 재현 (c)", () => {
    expect(classifyAgentCli({ detected: false })).toEqual({
      level: "warning",
      code: "agent_cli_missing",
    });
  });
  it("탐지 → ok", () => {
    expect(classifyAgentCli({ detected: true })).toEqual({ level: "ok", code: "ok" });
  });
});

describe("classifyDisk", () => {
  it("null → unknown", () => {
    expect(classifyDisk({ freeBytes: null })).toEqual({ level: "unknown", code: "unknown" });
  });
  it("임계 미만 → disk_critical (error)", () => {
    expect(classifyDisk({ freeBytes: DISK_CRITICAL_BYTES - 1 })).toEqual({
      level: "error",
      code: "disk_critical",
    });
  });
  it("low 미만(임계 이상) → disk_low (warning)", () => {
    expect(classifyDisk({ freeBytes: DISK_LOW_BYTES - 1 })).toEqual({
      level: "warning",
      code: "disk_low",
    });
  });
  it("충분 → ok", () => {
    expect(classifyDisk({ freeBytes: DISK_LOW_BYTES })).toEqual({ level: "ok", code: "ok" });
  });
});

describe("classifyLogs", () => {
  it("unified.log 비대 → log_oversized (warning)", () => {
    expect(
      classifyLogs({ unifiedLogBytes: LOG_OVERSIZED_BYTES + 1, ptyChunkCount: 0 }),
    ).toEqual({ level: "warning", code: "log_oversized" });
  });
  it("pty_chunk 과다 → log_oversized (warning)", () => {
    expect(
      classifyLogs({ unifiedLogBytes: 0, ptyChunkCount: PTY_CHUNK_OVERSIZED_COUNT + 1 }),
    ).toEqual({ level: "warning", code: "log_oversized" });
  });
  it("둘 다 null → unknown", () => {
    expect(classifyLogs({ unifiedLogBytes: null, ptyChunkCount: null })).toEqual({
      level: "unknown",
      code: "unknown",
    });
  });
  it("정상 크기 → ok", () => {
    expect(classifyLogs({ unifiedLogBytes: 1024, ptyChunkCount: 10 })).toEqual({
      level: "ok",
      code: "ok",
    });
  });
});

describe("classifySpawnFailure", () => {
  it("exit 127 → agent_cli_missing (command not found 관례)", () => {
    expect(classifySpawnFailure({ exitCode: 127 })).toBe("agent_cli_missing");
  });
  it("ENOENT 메시지 → agent_cli_missing", () => {
    expect(classifySpawnFailure({ exitCode: null, message: "spawn claude ENOENT" })).toBe(
      "agent_cli_missing",
    );
  });
  it("«찾을 수 없» 메시지 → agent_cli_missing", () => {
    expect(
      classifySpawnFailure({ exitCode: null, message: "claude CLI 를 찾을 수 없습니다" }),
    ).toBe("agent_cli_missing");
  });
  it("그 외 → unknown", () => {
    expect(classifySpawnFailure({ exitCode: 1, message: "boom" })).toBe("unknown");
  });
});

describe("worstLevel", () => {
  it("error 가 있으면 error", () => {
    expect(worstLevel(["ok", "warning", "error", "unknown"])).toBe("error");
  });
  it("error 없고 warning 있으면 warning", () => {
    expect(worstLevel(["ok", "unknown", "warning"])).toBe("warning");
  });
  it("unknown 이 ok 보다 위", () => {
    expect(worstLevel(["ok", "unknown"])).toBe("unknown");
  });
  it("전부 ok → ok", () => {
    expect(worstLevel(["ok", "ok"])).toBe("ok");
  });
  it("빈 배열 → ok", () => {
    expect(worstLevel([])).toBe("ok");
  });
});
