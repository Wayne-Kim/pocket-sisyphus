import { describe, it, expect } from "vitest";
import { isOurDaemonCommand } from "./reclaim.js";

describe("isOurDaemonCommand", () => {
  const ENTRY =
    "/Applications/PocketSisyphusMac.app/Contents/Resources/daemon/src/index.ts";

  it("단일 프로세스 invocation 매치 (node --import tsx <entry>)", () => {
    const cmd = `/path/daemon/bin/node --import tsx ${ENTRY}`;
    expect(isOurDaemonCommand(cmd, ENTRY)).toBe(true);
  });

  it("옛 tsx 셔임이 띄운 자식 daemon 매치 (--require/--import loader <entry>)", () => {
    const cmd = `/path/bin/node --require /x/preflight.cjs --import file:///x/loader.mjs ${ENTRY}`;
    expect(isOurDaemonCommand(cmd, ENTRY)).toBe(true);
  });

  it("다른 경로의 daemon 은 매치 안 함 (다른 .app / dev 워크스페이스)", () => {
    const other =
      "/Users/me/Projects/pocket-sisyphus/mac/daemon/src/index.ts";
    expect(isOurDaemonCommand(`node --import tsx ${other}`, ENTRY)).toBe(false);
  });

  it("무관한 node 프로세스는 매치 안 함", () => {
    expect(isOurDaemonCommand("node /some/other/server.js", ENTRY)).toBe(false);
    expect(isOurDaemonCommand("/usr/bin/node --version", ENTRY)).toBe(false);
  });

  it("빈 entry 면 절대 매치 안 함 (안전 가드)", () => {
    expect(isOurDaemonCommand(`node --import tsx ${ENTRY}`, "")).toBe(false);
  });
});
