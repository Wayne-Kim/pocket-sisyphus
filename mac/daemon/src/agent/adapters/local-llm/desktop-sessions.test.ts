/**
 * `scanQwenSessions` 단위 테스트 — `~/.qwen/projects/<slug>/chats/<uuid>.jsonl` (+ runtime.json)
 * 픽스처를 tmpdir 에 깔고 이어받기 후보 추출을 검증한다.
 *
 * 커버:
 *  - 평문 jsonl 파싱 → preview(parts[].text) / turnCount / cwd / gitBranch / startedAt.
 *  - repoPathFilter 로 특정 repo 만.
 *  - 메타-only 폴백 (jsonl 에서 cwd/시각을 못 뽑으면 runtime.json 으로 보강, preview=null).
 *  - 터미널 capability 노이즈가 첫 user 행이면 preview/turn 에서 제외.
 *  - jsonl 없이 runtime.json 만 있는(본문 없는) 세션은 후보에서 제외.
 *  - root 부재 → 빈 목록 (회귀 없음).
 *  - lastActiveAt(=jsonl mtime) 내림차순 정렬.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { scanQwenSessions } from "./desktop-sessions.js";

let root: string;

function writeSession(
  slug: string,
  sessionId: string,
  opts: {
    jsonl?: string;
    runtime?: Record<string, unknown>;
    mtimeSec?: number;
  },
): void {
  const chatsDir = path.join(root, slug, "chats");
  fs.mkdirSync(chatsDir, { recursive: true });
  if (opts.jsonl !== undefined) {
    const p = path.join(chatsDir, `${sessionId}.jsonl`);
    fs.writeFileSync(p, opts.jsonl);
    if (opts.mtimeSec !== undefined) {
      fs.utimesSync(p, opts.mtimeSec, opts.mtimeSec);
    }
  }
  if (opts.runtime !== undefined) {
    fs.writeFileSync(
      path.join(chatsDir, `${sessionId}.runtime.json`),
      JSON.stringify(opts.runtime),
    );
  }
}

/** qwen user 행 한 줄을 만든다. */
function userLine(sessionId: string, text: string, ts: string, cwd: string, branch: string): string {
  return JSON.stringify({
    uuid: `${sessionId}-${ts}`,
    sessionId,
    timestamp: ts,
    type: "user",
    cwd,
    gitBranch: branch,
    message: { role: "user", parts: [{ text }] },
  });
}

function systemLine(sessionId: string, cwd: string): string {
  return JSON.stringify({
    uuid: `${sessionId}-sys`,
    sessionId,
    timestamp: "2026-06-11T00:00:00.000Z",
    type: "system",
    cwd,
    subtype: "attribution_snapshot",
  });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "qwen-ds-test-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("scanQwenSessions", () => {
  it("root 가 없으면 빈 목록 (회귀 없음)", () => {
    expect(scanQwenSessions(path.join(root, "does-not-exist"), {})).toEqual([]);
  });

  it("평문 jsonl → preview/turnCount/cwd/gitBranch/startedAt 추출", () => {
    const repo = "/Users/me/Projects/foo";
    const slug = "-Users-me-Projects-foo";
    const sid = "11111111-1111-1111-1111-111111111111";
    const jsonl =
      [
        systemLine(sid, repo),
        userLine(sid, "첫 질문입니다", "2026-06-11T14:39:54.930Z", repo, "main"),
        userLine(sid, "둘째 질문", "2026-06-11T14:42:23.139Z", repo, "main"),
      ].join("\n") + "\n";
    writeSession(slug, sid, { jsonl, mtimeSec: 1_000_000 });

    const rows = scanQwenSessions(root, {});
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.sessionId).toBe(sid);
    expect(r.repoPath).toBe(repo);
    expect(r.preview).toBe("첫 질문입니다");
    expect(r.turnCount).toBe(2);
    expect(r.gitBranch).toBe("main");
    expect(r.startedAt).toBe(Date.parse("2026-06-11T14:39:54.930Z"));
    expect(r.lastActiveAt).toBe(1_000_000 * 1000);
  });

  it("repoPathFilter 로 특정 repo 만", () => {
    const sidA = "aaaaaaaa-0000-0000-0000-000000000000";
    const sidB = "bbbbbbbb-0000-0000-0000-000000000000";
    writeSession("-Users-me-a", sidA, {
      jsonl: userLine(sidA, "a 질문", "2026-06-11T10:00:00.000Z", "/Users/me/a", "main") + "\n",
    });
    writeSession("-Users-me-b", sidB, {
      jsonl: userLine(sidB, "b 질문", "2026-06-11T11:00:00.000Z", "/Users/me/b", "dev") + "\n",
    });

    const onlyB = scanQwenSessions(root, { repoPathFilter: "/Users/me/b" });
    expect(onlyB).toHaveLength(1);
    expect(onlyB[0].sessionId).toBe(sidB);
    expect(onlyB[0].repoPath).toBe("/Users/me/b");
  });

  it("메타-only 폴백 — jsonl 에서 cwd/시각을 못 뽑으면 runtime.json 으로 보강 (preview=null)", () => {
    const sid = "cccccccc-0000-0000-0000-000000000000";
    // cwd 도 user 메시지도 없는 jsonl (본문 디코드 실패 시뮬레이션) — 한 줄만.
    const jsonl = JSON.stringify({ type: "system", subtype: "noise" }) + "\n";
    writeSession("-Users-me-c", sid, {
      jsonl,
      runtime: {
        schema_version: 1,
        session_id: sid,
        work_dir: "/Users/me/Projects/c",
        started_at: 1781188695.876,
        qwen_version: "0.17.1",
      },
    });

    const rows = scanQwenSessions(root, {});
    expect(rows).toHaveLength(1);
    expect(rows[0].repoPath).toBe("/Users/me/Projects/c");
    expect(rows[0].preview).toBeNull();
    expect(rows[0].turnCount).toBeNull();
    expect(rows[0].startedAt).toBe(Math.round(1781188695.876 * 1000));
  });

  it("터미널 capability 노이즈가 첫 user 행이면 제외, 실제 메시지를 preview 로", () => {
    const repo = "/Users/me/Projects/d";
    const sid = "dddddddd-0000-0000-0000-000000000000";
    const noise = "[?0u[?65;4;1;2;6;21;22;17;28c";
    const jsonl =
      [
        userLine(sid, noise, "2026-06-11T09:00:00.000Z", repo, "main"),
        userLine(sid, "진짜 첫 메시지", "2026-06-11T09:01:00.000Z", repo, "main"),
      ].join("\n") + "\n";
    writeSession("-Users-me-d", sid, { jsonl });

    const rows = scanQwenSessions(root, {});
    expect(rows).toHaveLength(1);
    expect(rows[0].preview).toBe("진짜 첫 메시지");
    // 노이즈 행은 turn 으로 세지 않는다.
    expect(rows[0].turnCount).toBe(1);
    expect(rows[0].startedAt).toBe(Date.parse("2026-06-11T09:01:00.000Z"));
  });

  it("jsonl 없이 runtime.json 만 있는(본문 없는) 세션은 후보에서 제외", () => {
    const sid = "eeeeeeee-0000-0000-0000-000000000000";
    writeSession("-Users-me-e", sid, {
      runtime: { session_id: sid, work_dir: "/Users/me/Projects/e", started_at: 1781188000 },
    });
    expect(scanQwenSessions(root, {})).toEqual([]);
  });

  it("lastActiveAt(=jsonl mtime) 내림차순 정렬", () => {
    const older = "f0000000-0000-0000-0000-000000000000";
    const newer = "f1111111-0000-0000-0000-000000000000";
    writeSession("-Users-me-old", older, {
      jsonl: userLine(older, "오래된", "2026-06-01T00:00:00.000Z", "/Users/me/old", "main") + "\n",
      mtimeSec: 1_000,
    });
    writeSession("-Users-me-new", newer, {
      jsonl: userLine(newer, "최근", "2026-06-12T00:00:00.000Z", "/Users/me/new", "main") + "\n",
      mtimeSec: 2_000,
    });

    const rows = scanQwenSessions(root, {});
    expect(rows.map((r) => r.sessionId)).toEqual([newer, older]);
  });
});
