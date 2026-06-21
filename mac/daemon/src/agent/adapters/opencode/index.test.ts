/**
 * `opencodeAdapter` 의 인자/env 빌더 단위 테스트.
 *
 * 회귀 차단의 핵심:
 *  - buildSpawnEnv 의 OPENCODE_CONFIG 가 daemon 소유 경로를 가리킴 + OPENAI_BASE_URL 이
 *    로컬 서버 포트(51100) 를 가리킴 — 이게 틀어지면 opencode 가 공식 API 로 나가려다 실패.
 *  - 인터랙티브 TUI 인자 매핑(--session). bypassPermissions 는 «CLI 플래그가 아니라»
 *    opencode.json 의 permission 으로 처리하므로 args 엔 절대 안 들어간다 — 예전
 *    `--dangerously-skip-permissions`(claude-code 플래그)는 opencode 가 거부해 help 만 찍고
 *    TUI 가 안 떴다(입력 불가 회귀). `opencode run`(비대화형)도 1차 비목표라 등장 금지.
 */
import { describe, it, expect } from "vitest";
import { opencodeAdapter, OPENCODE_BASE_URL } from "./index.js";
import { OPENCODE_CONFIG_PATH } from "./config.js";

describe("opencodeAdapter — 메타", () => {
  it("id / displayName / installHint", () => {
    expect(opencodeAdapter.id).toBe("opencode");
    expect(opencodeAdapter.displayName).toBe("Local · OpenCode");
    expect(opencodeAdapter.installHint).toBe("npm install -g opencode-ai");
  });

  it("usage 미지원 — 메서드 자체가 없어야 라우트가 supported:false 로 응답", () => {
    expect(opencodeAdapter.usage).toBeUndefined();
  });

  it("백엔드 공유 — prepareBackend/releaseBackend 둘 다 구현", () => {
    expect(typeof opencodeAdapter.prepareBackend).toBe("function");
    expect(typeof opencodeAdapter.releaseBackend).toBe("function");
  });

  it("desktopWatcher 구현 — Mac 데스크탑 opencode 세션을 이어받기 후보로 노출 (claude/codex/agy/qwen 패리티)", () => {
    const watcher = opencodeAdapter.desktopWatcher?.();
    expect(watcher).toBeTruthy();
    expect(typeof watcher!.list).toBe("function");
    expect(typeof watcher!.start).toBe("function");
  });

  it("capabilities — opencode_external_v1 만(cron_eligible 미포함: 로컬 추론 콜드스타트 과다)", () => {
    expect(opencodeAdapter.capabilities()).toEqual(["opencode_external_v1"]);
  });
});

describe("opencodeAdapter.buildSpawnArgs", () => {
  it("기본 — 인자 없음 (대화형 TUI 그대로 기동)", () => {
    expect(opencodeAdapter.buildSpawnArgs({ bypassPermissions: false })).toEqual([]);
  });

  it("resumeFrom → --session <id>", () => {
    expect(
      opencodeAdapter.buildSpawnArgs({ resumeFrom: "sess-1", bypassPermissions: false }),
    ).toEqual(["--session", "sess-1"]);
  });

  it("빈 resumeFrom 은 무시", () => {
    expect(
      opencodeAdapter.buildSpawnArgs({ resumeFrom: "", bypassPermissions: false }),
    ).toEqual([]);
  });

  it("bypassPermissions 는 CLI 인자로 새지 않는다 (opencode.json 의 permission 으로 처리)", () => {
    // 회귀 가드: opencode 엔 권한우회 플래그가 없어 — args 에 뭐든 넣으면 yargs 가 거부하고
    // help 만 찍어 TUI 가 안 뜬다. bypassPermissions=true 여도 args 는 비어 있어야 한다.
    expect(opencodeAdapter.buildSpawnArgs({ bypassPermissions: true })).toEqual([]);
  });

  it("어떤 조합에서도 opencode 가 모르는 플래그/비대화형 `run` 을 넣지 않는다", () => {
    const combos = [
      opencodeAdapter.buildSpawnArgs({ bypassPermissions: false }),
      opencodeAdapter.buildSpawnArgs({ bypassPermissions: true }),
      opencodeAdapter.buildSpawnArgs({ resumeFrom: "x", bypassPermissions: true }),
    ];
    for (const args of combos) {
      expect(args).not.toContain("run");
      expect(args).not.toContain("--dangerously-skip-permissions");
    }
  });
});

describe("opencodeAdapter.buildSpawnEnv", () => {
  it("OPENCODE_CONFIG + 로컬 서버를 가리키는 OpenAI 호환 env", () => {
    const env = opencodeAdapter.buildSpawnEnv();
    expect(env.OPENCODE_CONFIG).toBe(OPENCODE_CONFIG_PATH);
    expect(env.OPENAI_BASE_URL).toBe(OPENCODE_BASE_URL);
    expect(env.OPENAI_BASE_URL).toContain("127.0.0.1:51100");
    expect(env.OPENAI_API_KEY).not.toBe("");
    expect(env.FORCE_COLOR).toBe("1");
  });
});
