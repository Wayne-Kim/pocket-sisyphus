/**
 * `/api/fs` — 파일시스템 보조 라우트 (iOS 경로 입력 자동완성용).
 *
 *   GET /api/fs/list-dir?path=<prefix> → <prefix> 디렉터리 바로 아래 하위 디렉터리 이름 목록
 *
 * iOS 새 세션 시트의 경로 자동완성이 호출한다. 옛 동작은 recents 에 있는 경로에서만 다음
 * segment 를 추측했는데, 한 번도 작업 안 한 폴더는 추천이 안 떠 사용자가 전체 경로를 직접
 * 타이핑해야 했다. 이 라우트로 실제 디렉터리 트리를 한 단계씩 탐색할 수 있다.
 *
 * 보안: bearerAuth 통과한 페어된 기기만 호출. daemon 은 비-sandbox 라 임의 경로 readdir 이
 * 가능하나(앱의 신뢰 모델상 허용 — 이미 임의 repo 접근), read-only 이고 결과 수를 cap 한다.
 */
import { Hono } from "hono";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bearerAuth } from "../auth.js";

export const fsRoutes = new Hono();
fsRoutes.use("*", bearerAuth);

/** 한 디렉터리에서 돌려줄 하위 디렉터리 최대 수 — 거대한 폴더(node_modules 부모 등) 방어. */
const MAX_ENTRIES = 300;

function expandTilde(p: string): string {
  if (p === "~" || p.startsWith("~/")) return path.join(os.homedir(), p.slice(1));
  return p;
}

/**
 * GET /api/fs/list-dir?path=<prefix>[&files=1]
 *
 * - path 누락/빈값 → home 디렉터리 기준.
 * - 절대경로(또는 ~)만 — 상대경로는 daemon cwd 기준이라 혼란 → exists:false 로 무시.
 * - 숨김(.) 디렉터리 제외. 디렉터리 심볼릭 링크는 target 이 디렉터리면 포함.
 * - files=1 이면 그 디렉터리의 일반 파일 이름도 함께 반환 (예약 «터미널» 의 쉘 스크립트 파일
 *   선택용). 기본(파라미터 없음)은 dirs 만 — 기존 경로 자동완성 호출자의 동작 불변.
 * - 존재하지 않으면 exists:false + dirs:[] (사용자가 새 경로를 타이핑 중 — 에러 아님).
 *
 * 응답: { base: <정규화된 디렉터리>, dirs: string[], files?: string[], exists: boolean }
 */
fsRoutes.get("/list-dir", (c) => {
  const raw = (c.req.query("path") ?? "").trim();
  const includeFiles = c.req.query("files") === "1";
  let dir = raw.length === 0 ? os.homedir() : expandTilde(raw);
  if (!path.isAbsolute(dir)) {
    return c.json({ base: dir, dirs: [], exists: false });
  }
  dir = path.resolve(dir);

  let entries: fs.Dirent[];
  try {
    if (!fs.statSync(dir).isDirectory()) {
      return c.json({ base: dir, dirs: [], exists: false });
    }
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    // ENOENT / EACCES / ENOTDIR 등 — 타이핑 중인 미완성 경로일 뿐이라 빈 목록.
    return c.json({ base: dir, dirs: [], exists: false });
  }

  const dirs = entries
    .filter((e) => {
      if (e.name.startsWith(".")) return false; // 숨김 디렉터리 제외
      if (e.isDirectory()) return true;
      // 디렉터리를 가리키는 심볼릭 링크도 포함 (target 확인 — 파일 링크는 제외).
      if (e.isSymbolicLink()) {
        try {
          return fs.statSync(path.join(dir, e.name)).isDirectory();
        } catch {
          return false;
        }
      }
      return false;
    })
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b))
    .slice(0, MAX_ENTRIES);

  if (!includeFiles) {
    return c.json({ base: dir, dirs, exists: true });
  }

  // 일반 파일 (+ 파일을 가리키는 심볼릭 링크). 숨김 제외, 이름순, cap.
  const files = entries
    .filter((e) => {
      if (e.name.startsWith(".")) return false;
      if (e.isFile()) return true;
      if (e.isSymbolicLink()) {
        try {
          return fs.statSync(path.join(dir, e.name)).isFile();
        } catch {
          return false;
        }
      }
      return false;
    })
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b))
    .slice(0, MAX_ENTRIES);

  return c.json({ base: dir, dirs, files, exists: true });
});
