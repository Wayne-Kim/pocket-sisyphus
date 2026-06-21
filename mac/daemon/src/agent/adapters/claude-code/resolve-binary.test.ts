/**
 * `resolveClaudeBinary` 단위 테스트.
 *
 * 회귀 방지 대상: 2026-05-23 의 «옛 번들 SDK 경로가 더 이상 존재하지 않는데 resolver 가
 * 거기만 찾아 throw 했고 그 throw 가 silent failure 로 묻혀 사용자가 빈 터미널만 보는»
 * 버그. 각 분기 (각 잘 알려진 경로 / fallback / 모두 실패→throw) 를 mocked deps 로
 * 검증해 향후 어떤 refactor 가 들어와도 같은 함정에 빠지지 않게 한다.
 */
import { describe, it, expect } from "vitest";
import {
  resolveClaudeBinary,
  knownCandidates,
  type ResolveDeps,
} from "./resolve-binary.js";

/** 모든 분기를 통제 가능한 mock deps 빌더. */
function mockDeps(opts: {
  existing?: Set<string>;
  execOutput?: string | (() => string);
  home?: string;
}): ResolveDeps {
  const existing = opts.existing ?? new Set();
  return {
    existsSync: (p) => existing.has(p),
    execSync: (_cmd) => {
      if (typeof opts.execOutput === "function") return opts.execOutput();
      return opts.execOutput ?? "";
    },
    home: opts.home ?? "/home/test",
  };
}

describe("resolveClaudeBinary", () => {
  describe("후보 발견 (우선순위 검증)", () => {
    it("~/.local/bin/claude 가 있으면 가장 우선", () => {
      const result = resolveClaudeBinary(
        mockDeps({
          existing: new Set([
            "/home/test/.local/bin/claude",
            "/opt/homebrew/bin/claude",
          ]),
        }),
      );
      expect(result).toBe("/home/test/.local/bin/claude");
    });

    it("/opt/homebrew/bin/claude 는 ~/.local/bin 없을 때 다음 후보", () => {
      const result = resolveClaudeBinary(
        mockDeps({
          existing: new Set([
            "/opt/homebrew/bin/claude",
            "/usr/local/bin/claude",
          ]),
        }),
      );
      expect(result).toBe("/opt/homebrew/bin/claude");
    });

    it("/usr/local/bin/claude 도 후보", () => {
      const result = resolveClaudeBinary(
        mockDeps({ existing: new Set(["/usr/local/bin/claude"]) }),
      );
      expect(result).toBe("/usr/local/bin/claude");
    });

    it("~/.claude/local/claude 도 후보 (마지막 알려진 경로)", () => {
      const result = resolveClaudeBinary(
        mockDeps({
          existing: new Set(["/home/test/.claude/local/claude"]),
        }),
      );
      expect(result).toBe("/home/test/.claude/local/claude");
    });
  });

  describe("execSync fallback (login-shell PATH lookup)", () => {
    it("알려진 후보 모두 없으면 zsh -l -c 'command -v claude' 결과 사용", () => {
      const customPath = "/custom/path/to/claude";
      const result = resolveClaudeBinary(
        mockDeps({
          existing: new Set([customPath]),
          execOutput: `${customPath}\n`,
        }),
      );
      expect(result).toBe(customPath);
    });

    it("execSync 출력 trim — 끝의 newline 제거", () => {
      const customPath = "/custom/claude";
      const result = resolveClaudeBinary(
        mockDeps({
          existing: new Set([customPath]),
          execOutput: `${customPath}\n\n  `,
        }),
      );
      expect(result).toBe(customPath);
    });

    it("execSync 가 결과 줘도 그 path 가 실제론 없으면 못 쓴다", () => {
      // zsh 가 '/old/claude' 반환하는데 그 파일이 실제론 없는 경우.
      expect(() =>
        resolveClaudeBinary(
          mockDeps({
            existing: new Set(), // 아무것도 없음
            execOutput: "/old/missing/claude\n",
          }),
        ),
      ).toThrow(/claude CLI 를 찾을 수 없습니다/);
    });

    it("execSync 가 throw 해도 명확한 에러로 fall-through", () => {
      expect(() =>
        resolveClaudeBinary(
          mockDeps({
            existing: new Set(),
            execOutput: () => {
              throw new Error("zsh: command not found");
            },
          }),
        ),
      ).toThrow(/claude CLI 를 찾을 수 없습니다/);
    });
  });

  describe("regression: 모든 경로 실패 시 throw (silent failure 차단)", () => {
    it("후보 + fallback 다 실패하면 install 안내 포함한 throw", () => {
      expect(() =>
        resolveClaudeBinary(
          mockDeps({ existing: new Set(), execOutput: "" }),
        ),
      ).toThrowError(
        /npm install -g @anthropic-ai\/claude-code/,
      );
    });

    it("에러 메시지에 잘 알려진 위치 힌트 포함", () => {
      expect(() =>
        resolveClaudeBinary(
          mockDeps({ existing: new Set(), execOutput: "" }),
        ),
      ).toThrowError(/~\/.local\/bin\/claude|opt\/homebrew\/bin\/claude/);
    });
  });

  describe("knownCandidates 자체", () => {
    it("HOME 을 모든 home-relative 후보에 반영", () => {
      const cs = knownCandidates("/Users/wayne");
      expect(cs).toContain("/Users/wayne/.local/bin/claude");
      expect(cs).toContain("/Users/wayne/.claude/local/claude");
      expect(cs).toContain("/opt/homebrew/bin/claude");
      expect(cs).toContain("/usr/local/bin/claude");
    });

    it("순서는 ~/.local/bin → /opt/homebrew → /usr/local → ~/.claude/local", () => {
      const cs = knownCandidates("/Users/wayne");
      expect(cs).toEqual([
        "/Users/wayne/.local/bin/claude",
        "/opt/homebrew/bin/claude",
        "/usr/local/bin/claude",
        "/Users/wayne/.claude/local/claude",
      ]);
    });

    it("regression: 옛 SDK 경로 (@anthropic-ai/claude-agent-sdk-darwin-arm64) 는 사용 안 함", () => {
      // 2026-05-23 root-cause: 그 경로는 package.json 에서 의존성이 사라진 뒤로
      // 영구히 빈 디렉토리. resolver 가 거기 다시 보면 같은 silent failure 재발.
      const cs = knownCandidates("/Users/wayne");
      for (const c of cs) {
        expect(c).not.toMatch(/claude-agent-sdk-darwin-arm64/);
      }
    });
  });
});
