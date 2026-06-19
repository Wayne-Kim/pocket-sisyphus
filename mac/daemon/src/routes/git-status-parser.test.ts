/**
 * `parsePorcelainZ` 단위 테스트.
 *
 * 회귀 방지 대상:
 *  - 일반 modified / staged / both
 *  - untracked (??)
 *  - deleted
 *  - rename / copy — 다음 토큰이 원본 path 로 소비되어야 함
 *  - 손상된/잘린 입력
 *
 * 모두 NUL 종결 문자열을 직접 작성해 git 실행을 거치지 않는다.
 */
import { describe, it, expect } from "vitest";
import { parsePorcelainZ } from "./git-status-parser.js";

const NUL = "\0";

describe("parsePorcelainZ", () => {
  it("빈 입력 → 빈 배열", () => {
    expect(parsePorcelainZ("")).toEqual([]);
    expect(parsePorcelainZ(NUL)).toEqual([]);
  });

  it("단일 modified 파일", () => {
    const raw = ` M src/app.ts${NUL}`;
    expect(parsePorcelainZ(raw)).toEqual([
      { path: "src/app.ts", status: " M" },
    ]);
  });

  it("staged + worktree 같은 파일 두 가지 상태가 한 entry 로", () => {
    const raw = `MM src/app.ts${NUL}`;
    expect(parsePorcelainZ(raw)).toEqual([
      { path: "src/app.ts", status: "MM" },
    ]);
  });

  it("untracked 와 modified 혼합", () => {
    const raw = ` M src/a.ts${NUL}?? new.ts${NUL}`;
    expect(parsePorcelainZ(raw)).toEqual([
      { path: "src/a.ts", status: " M" },
      { path: "new.ts", status: "??" },
    ]);
  });

  it("deleted 도 정상 파싱", () => {
    const raw = ` D gone.txt${NUL}`;
    expect(parsePorcelainZ(raw)).toEqual([
      { path: "gone.txt", status: " D" },
    ]);
  });

  it("rename — 다음 토큰을 원본 path 로 소비", () => {
    const raw = `R  new/path.ts${NUL}old/path.ts${NUL} M other.ts${NUL}`;
    expect(parsePorcelainZ(raw)).toEqual([
      { path: "new/path.ts", status: "R ", origPath: "old/path.ts" },
      { path: "other.ts", status: " M" },
    ]);
  });

  it("copy 도 rename 과 같은 구조", () => {
    const raw = `C  copy.ts${NUL}src.ts${NUL}`;
    expect(parsePorcelainZ(raw)).toEqual([
      { path: "copy.ts", status: "C ", origPath: "src.ts" },
    ]);
  });

  it("path 안에 공백이 있어도 그대로 보존 (NUL 구분이라 안전)", () => {
    const raw = ` M dir with space/file name.txt${NUL}`;
    expect(parsePorcelainZ(raw)).toEqual([
      { path: "dir with space/file name.txt", status: " M" },
    ]);
  });

  it("path 안에 newline 이 있어도 NUL 까지 한 토큰", () => {
    const raw = ` M weird\nname.txt${NUL}`;
    expect(parsePorcelainZ(raw)).toEqual([
      { path: "weird\nname.txt", status: " M" },
    ]);
  });

  it("3자 미만 토큰은 무시 — 손상된 입력 방어", () => {
    const raw = `xx${NUL} M valid.ts${NUL}`;
    expect(parsePorcelainZ(raw)).toEqual([
      { path: "valid.ts", status: " M" },
    ]);
  });

  it("rename 다음 원본 path 토큰이 잘려도 본 entry 는 보존 (origPath 만 undefined)", () => {
    const raw = `R  new.ts${NUL}`;
    const out = parsePorcelainZ(raw);
    expect(out).toHaveLength(1);
    expect(out[0]?.path).toBe("new.ts");
    expect(out[0]?.status).toBe("R ");
    // 잘린 입력 — origPath 가 undefined 또는 빈 문자열 어느 쪽이든 허용.
    expect(out[0]?.origPath === undefined || out[0]?.origPath === "").toBe(true);
  });
});
