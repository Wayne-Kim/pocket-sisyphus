/**
 * `localLlmAdapter` (Qwen Code + 로컬 llama-server) 의 인자/env 빌더 단위 테스트.
 *
 * 회귀 차단의 핵심:
 *  - --chat-recording 이 항상 포함 — 빠지면 --resume 이 조용히 동작하지 않는 회귀.
 *  - buildSpawnEnv 의 OPENAI_BASE_URL 이 로컬 서버 포트(51100) 를 가리킴 — 이게
 *    틀어지면 qwen 이 (키도 없이) 공식 API 로 나가려다 실패한다.
 */
import { describe, it, expect } from "vitest";
import {
  localLlmAdapter,
  LOCAL_LLM_BASE_URL,
} from "./index.js";

describe("localLlmAdapter — 메타", () => {
  it("id / displayName", () => {
    expect(localLlmAdapter.id).toBe("local_llm");
    expect(localLlmAdapter.displayName).toBe("Local · Qwen Code");
  });

  it("usage 미지원 — 메서드 자체가 없어야 라우트가 supported:false 로 응답", () => {
    expect(localLlmAdapter.usage).toBeUndefined();
  });

  it("desktopWatcher 구현 — Mac 데스크탑 qwen 세션을 이어받기 후보로 노출 (claude/agy 패리티)", () => {
    const watcher = localLlmAdapter.desktopWatcher?.();
    expect(watcher).toBeTruthy();
    expect(typeof watcher!.list).toBe("function");
    expect(typeof watcher!.start).toBe("function");
  });
});

describe("localLlmAdapter.buildSpawnArgs", () => {
  it("기본 — chat-recording 만 (resume 동작의 전제)", () => {
    expect(localLlmAdapter.buildSpawnArgs({ bypassPermissions: false })).toEqual([
      "--chat-recording",
    ]);
  });

  it("resumeFrom → --resume <id>", () => {
    expect(
      localLlmAdapter.buildSpawnArgs({
        resumeFrom: "sess-1",
        bypassPermissions: false,
      }),
    ).toEqual(["--chat-recording", "--resume", "sess-1"]);
  });

  it("빈 resumeFrom 은 무시", () => {
    expect(
      localLlmAdapter.buildSpawnArgs({ resumeFrom: "", bypassPermissions: false }),
    ).toEqual(["--chat-recording"]);
  });

  it("bypassPermissions → --approval-mode yolo", () => {
    expect(localLlmAdapter.buildSpawnArgs({ bypassPermissions: true })).toEqual([
      "--chat-recording",
      "--approval-mode",
      "yolo",
    ]);
  });
});

describe("localLlmAdapter.buildSpawnEnv", () => {
  it("로컬 서버를 가리키는 self-contained OPENAI_* env", () => {
    const env = localLlmAdapter.buildSpawnEnv();
    expect(env.OPENAI_BASE_URL).toBe(LOCAL_LLM_BASE_URL);
    expect(env.OPENAI_BASE_URL).toContain("127.0.0.1:51100");
    expect(env.OPENAI_API_KEY).not.toBe("");
    expect(env.OPENAI_MODEL).not.toBe("");
    expect(env.FORCE_COLOR).toBe("1");
  });
});
