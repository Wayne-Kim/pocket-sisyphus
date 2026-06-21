/**
 * `shellAdapter` (단순 zsh/bash PTY) 단위 테스트.
 *
 * 다른 adapter 들과 달리 코드 에이전트가 아니라 사용자 셸을 그대로 띄우는 어댑터.
 * 회귀 차단 대상:
 *  - resumeFrom / bypassPermissions 가 와도 *무시* 한다 (의미 없는 인자라 spawn 깨짐
 *    위험)
 *  - 항상 `-l` (login shell) 로 띄움 — Terminal.app 의 디폴트 경험 일치
 *  - $SHELL 우선, 없으면 /bin/zsh (launchd daemon 에서 $SHELL 비어 있는 케이스 보호)
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { shellAdapter } from "./index.js";

describe("shellAdapter — 메타", () => {
  it("id / displayName / capabilities", () => {
    expect(shellAdapter.id).toBe("shell");
    expect(shellAdapter.displayName).toBe("Terminal");
    expect(shellAdapter.capabilities()).toEqual([]);
  });

  it("desktopWatcher 자체를 노출하지 않음 — shell 엔 «이어받기» 개념 없음", () => {
    // optional method — undefined 또는 호출 시 null 어느 쪽이든 의미 동등.
    if (typeof shellAdapter.desktopWatcher === "function") {
      expect(shellAdapter.desktopWatcher()).toBeNull();
    } else {
      expect(shellAdapter.desktopWatcher).toBeUndefined();
    }
  });
});

describe("shellAdapter.buildSpawnArgs", () => {
  it("ctx 무시 — 항상 ['-l']", () => {
    expect(shellAdapter.buildSpawnArgs({ bypassPermissions: false })).toEqual(["-l"]);
    expect(shellAdapter.buildSpawnArgs({ bypassPermissions: true })).toEqual(["-l"]);
    expect(
      shellAdapter.buildSpawnArgs({
        resumeFrom: "would-be-ignored",
        bypassPermissions: true,
      }),
    ).toEqual(["-l"]);
  });
});

describe("shellAdapter.resolveBinary", () => {
  let original: string | undefined;
  beforeEach(() => {
    original = process.env.SHELL;
  });
  afterEach(() => {
    if (original === undefined) {
      delete process.env.SHELL;
    } else {
      process.env.SHELL = original;
    }
  });

  it("$SHELL 가 있으면 그 값", () => {
    process.env.SHELL = "/bin/bash";
    expect(shellAdapter.resolveBinary()).toBe("/bin/bash");
  });

  it("$SHELL 가 없으면 /bin/zsh (launchd 디폴트 환경 보호)", () => {
    delete process.env.SHELL;
    expect(shellAdapter.resolveBinary()).toBe("/bin/zsh");
  });
});

describe("shellAdapter.buildSpawnEnv", () => {
  it("추가 env 없음 — shell 은 사용자 환경 그대로 살아 있어야 함", () => {
    expect(shellAdapter.buildSpawnEnv()).toEqual({});
  });
});
