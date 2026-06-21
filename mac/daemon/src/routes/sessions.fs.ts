import type { Hono } from "hono";
import fs from "node:fs";
import path from "node:path";
import { bodyLimit } from "hono/body-limit";
import { getSession, resolveRepoRelative, FS_FILE_MAX_BYTES, FS_TEXT_MAX_BYTES } from "./sessions-shared.js";

export function registerFsRoutes(sessions: Hono): void {
  // 파일 / 디렉토리 listing. 응답:
  //   { path, parent: <rel|null>, entries: [{ name, isDirectory, size, modifiedAt }] }
  // entries 는 디렉토리 먼저, 그 안에서 이름 사전순.
  sessions.get("/:id/fs/list", async (c) => {
    const id = c.req.param("id");
    const session = getSession(id);
    if (!session) return c.json({ error: "not_found" }, 404);

    const repoPath = session.repo_path;
    if (!repoPath) return c.json({ error: "no_repo" }, 404);

    const r = await resolveRepoRelative(repoPath, c.req.query("path"));
    if (!r.ok) return c.json({ error: r.error }, r.error === "no_repo" ? 404 : 400);

    const fs = await import("node:fs/promises");
    const path = await import("node:path");

    let dirents: Array<{ name: string; isDirectory: boolean; size: number; modifiedAt: number }>;
    try {
      const list = await fs.readdir(r.abs, { withFileTypes: true });
      dirents = await Promise.all(
        list
          // `.git` 디렉토리는 숨김. 그 외 dotfile 은 노출 (사용자가 보고 싶을 수 있음).
          .filter((d) => !(d.name === ".git" && d.isDirectory()))
          .map(async (d) => {
            let size = 0;
            let modifiedAt = 0;
            try {
              const st = await fs.stat(path.join(r.abs, d.name));
              size = Number(st.size);
              modifiedAt = Math.floor(st.mtimeMs);
            } catch {
              // 권한 없음 / broken symlink — 0 으로 흡수.
            }
            return { name: d.name, isDirectory: d.isDirectory(), size, modifiedAt };
          }),
      );
    } catch (e: any) {
      if (e?.code === "ENOENT") return c.json({ error: "not_found" }, 404);
      if (e?.code === "ENOTDIR") return c.json({ error: "not_a_directory" }, 400);
      return c.json({ error: "read_failed" }, 500);
    }
    dirents.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    const parent = r.rel === "" ? null : r.rel.includes("/") ? r.rel.slice(0, r.rel.lastIndexOf("/")) : "";
    return c.json({ path: r.rel, parent, entries: dirents });
  });

  // 파일 read. Content-Type 자동 판별:
  //   - 텍스트(NUL 없음) → { encoding: "utf8", content, contentType: "text/plain" }
  //   - 이미지 확장자 → { encoding: "base64", content, contentType: "image/<ext>" }
  //   - 그 외 binary → { encoding: "base64", content, contentType: "application/octet-stream" }
  // truncated 는 텍스트 한정 — binary 는 cap 초과 시 too_large 로 거절 (잘린 base64 는 deserialize 불가).
  sessions.get("/:id/fs/file", async (c) => {
    const id = c.req.param("id");
    const session = getSession(id);
    if (!session) return c.json({ error: "not_found" }, 404);

    const repoPath = session.repo_path;
    if (!repoPath) return c.json({ error: "no_repo" }, 404);

    const queryPath = c.req.query("path");
    if (!queryPath) return c.json({ error: "path_required" }, 400);

    const r = await resolveRepoRelative(repoPath, queryPath);
    if (!r.ok) return c.json({ error: r.error }, 400);

    const fs = await import("node:fs/promises");
    let buf: Buffer;
    let size: number;
    try {
      const st = await fs.stat(r.abs);
      if (st.isDirectory()) return c.json({ error: "is_a_directory" }, 400);
      size = Number(st.size);
      if (size > FS_FILE_MAX_BYTES) return c.json({ error: "too_large", size, max: FS_FILE_MAX_BYTES }, 413);
      buf = await fs.readFile(r.abs);
    } catch (e: any) {
      if (e?.code === "ENOENT") return c.json({ error: "not_found" }, 404);
      return c.json({ error: "read_failed" }, 500);
    }

    const ext = r.rel.toLowerCase().split(".").pop() ?? "";
    const imageExt: Record<string, string> = {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      webp: "image/webp",
      heic: "image/heic",
      heif: "image/heif",
      bmp: "image/bmp",
      tiff: "image/tiff",
      tif: "image/tiff",
      svg: "image/svg+xml",
    };
    if (imageExt[ext]) {
      return c.json({
        path: r.rel,
        size,
        encoding: "base64",
        contentType: imageExt[ext],
        content: buf.toString("base64"),
        truncated: false,
      });
    }

    // 텍스트 판정 — 앞 8KB 에 NUL 이 있으면 binary 로 분류.
    const head = buf.subarray(0, Math.min(8192, buf.length));
    const isBinary = head.includes(0);
    if (isBinary) {
      return c.json({
        path: r.rel,
        size,
        encoding: "base64",
        contentType: "application/octet-stream",
        content: buf.toString("base64"),
        truncated: false,
      });
    }
    const truncated = buf.length > FS_TEXT_MAX_BYTES;
    const sliced = truncated ? buf.subarray(0, FS_TEXT_MAX_BYTES) : buf;
    return c.json({
      path: r.rel,
      size,
      encoding: "utf8",
      contentType: "text/plain",
      content: sliced.toString("utf8"),
      truncated,
    });
  });

  // ── 라이브 산출물(artifacts_v1) ──────────────────────────────────────────────
  // 세션이 만든 «시각적 산출물» 을 자동 발견 + raw 스트리밍. iOS «결과» 시트의 «산출물»
  // 세그먼트가 QuickLook 으로 렌더 (이미지·PDF·동영상·오디오·Office·USDZ).

  /** 확장자 → 산출물 종류. iOS 가 썸네일/아이콘/렌더 경로를 분기. */
  const ARTIFACT_KIND: Record<string, string> = {
    png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image",
    heic: "image", heif: "image", bmp: "image", tiff: "image", tif: "image", svg: "image",
    pdf: "pdf",
    mp4: "video", mov: "video", m4v: "video", webm: "video",
    mp3: "audio", wav: "audio", m4a: "audio", aac: "audio",
    usdz: "model",
    md: "markdown", markdown: "markdown",
    doc: "doc", docx: "doc", xls: "doc", xlsx: "doc", ppt: "doc", pptx: "doc",
    html: "web", htm: "web",
  };

  /** 발견 walk 에서 통째로 건너뛸 디렉토리 — 의존성/빌드 산출물(노이즈 + 거대). .git 도. */
  const ARTIFACT_SKIP_DIRS = new Set([
    ".git", "node_modules", "dist", "build", ".next", ".nuxt", "out", "target",
    ".venv", "venv", "__pycache__", ".cache", "coverage", ".turbo", "vendor",
    "Pods", "DerivedData", ".gradle", ".idea", "bower_components",
  ]);

  const ARTIFACT_MAX_RESULTS = 200;
  const ARTIFACT_MAX_DEPTH = 6;
  const ARTIFACT_MAX_VISITED = 20000; // walk 비용 상한 (거대 repo 방어)

  // raw 스트리밍 cap — 대부분의 산출물(스크린샷·PDF·짧은 클립)은 한참 아래. 초과 시 413.
  const FS_RAW_MAX_BYTES = 64 * 1024 * 1024;

  /** 확장자별 raw content-type (QuickLook 은 temp 파일 확장자로도 판별하지만 명시). */
  const RAW_CONTENT_TYPE: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
    webp: "image/webp", heic: "image/heic", heif: "image/heif", bmp: "image/bmp",
    tiff: "image/tiff", tif: "image/tiff", svg: "image/svg+xml",
    pdf: "application/pdf",
    mp4: "video/mp4", mov: "video/quicktime", m4v: "video/x-m4v", webm: "video/webm",
    mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", aac: "audio/aac",
    usdz: "model/vnd.usdz+zip",
    md: "text/markdown", markdown: "text/markdown",
    html: "text/html", htm: "text/html",
  };

  // GET /api/sessions/:id/artifacts?limit=N
  // 세션 repo_path 를 재귀 walk 해 렌더 가능한 파일을 mtime 내림차순으로 반환.
  // 응답: { artifacts: [{ path, name, ext, kind, size, modifiedAt }], total, truncated }
  sessions.get("/:id/artifacts", async (c) => {
    const id = c.req.param("id");
    const session = getSession(id);
    if (!session) return c.json({ error: "not_found" }, 404);
    const repoPath = session.repo_path;
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    if (!repoPath) return c.json({ artifacts: [], total: 0, truncated: false, dir: "", subdirs: [] });

    const limit = Math.max(1, Math.min(ARTIFACT_MAX_RESULTS, Number(c.req.query("limit")) || 100));

    // dir: 발견 범위를 repo 하위 폴더로 좁힌다(프로젝트에 산출물과 무관한 파일이 많을 때 노이즈
    // 제거). 빈 문자열 = repo 루트(전체). 정규화 후 traversal(..)·절대경로·스킵 디렉토리를 막고
    // resolve 결과가 repo 밖으로 새지 않는지 확인한다.
    const rawDir = (c.req.query("dir") ?? "").replace(/^\/+|\/+$/g, "");
    const dirParts = rawDir === "" ? [] : rawDir.split("/");
    const badDir = dirParts.some(
      (p) => p === "" || p === "." || p === ".." || ARTIFACT_SKIP_DIRS.has(p),
    );
    if (badDir) return c.json({ error: "bad_dir" }, 400);
    const baseAbs = dirParts.length ? path.join(repoPath, ...dirParts) : repoPath;
    const resolvedBase = path.resolve(baseAbs);
    const resolvedRepo = path.resolve(repoPath);
    if (resolvedBase !== resolvedRepo && !resolvedBase.startsWith(resolvedRepo + path.sep)) {
      return c.json({ error: "bad_dir" }, 400);
    }
    const dir = dirParts.join("/");
    try {
      const st = await fs.stat(baseAbs);
      if (!st.isDirectory()) return c.json({ error: "bad_dir" }, 400);
    } catch {
      // 폴더가 사라짐(세션 중 삭제/이동 등) — 빈 결과로 안전 반환.
      return c.json({ artifacts: [], total: 0, truncated: false, dir, subdirs: [] });
    }

    type Art = { path: string; name: string; ext: string; kind: string; size: number; modifiedAt: number };
    const found: Art[] = [];
    let visited = 0;

    async function walk(absDir: string, relDir: string, depth: number): Promise<void> {
      if (depth > ARTIFACT_MAX_DEPTH || visited > ARTIFACT_MAX_VISITED) return;
      let entries: import("node:fs").Dirent[];
      try {
        entries = await fs.readdir(absDir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (visited > ARTIFACT_MAX_VISITED) return;
        visited++;
        const rel = relDir === "" ? e.name : `${relDir}/${e.name}`;
        if (e.isDirectory()) {
          if (ARTIFACT_SKIP_DIRS.has(e.name)) continue;
          await walk(path.join(absDir, e.name), rel, depth + 1);
          continue;
        }
        if (!e.isFile()) continue;
        const ext = e.name.toLowerCase().split(".").pop() ?? "";
        const kind = ARTIFACT_KIND[ext];
        if (!kind) continue;
        try {
          const st = await fs.stat(path.join(absDir, e.name));
          found.push({
            path: rel, name: e.name, ext, kind,
            size: Number(st.size), modifiedAt: Math.floor(st.mtimeMs),
          });
        } catch {
          // 권한 없음 / broken symlink — skip.
        }
      }
    }

    try {
      await walk(baseAbs, dir, 0);
    } catch {
      return c.json({ artifacts: [], total: 0, truncated: false, dir, subdirs: [] });
    }
    found.sort((a, b) => b.modifiedAt - a.modifiedAt);

    // 현재 dir «바로 아래» 자식 폴더 중 (하위까지 통틀어) 산출물을 가진 것 — iOS 드릴다운 칩용.
    const prefix = dir === "" ? "" : dir + "/";
    const subdirSet = new Set<string>();
    for (const a of found) {
      const relToBase = prefix === "" ? a.path : a.path.slice(prefix.length);
      const slash = relToBase.indexOf("/");
      if (slash > 0) subdirSet.add(relToBase.slice(0, slash));
    }
    const subdirs = [...subdirSet].sort((a, b) => a.localeCompare(b));

    const truncated = found.length > limit;
    return c.json({ artifacts: found.slice(0, limit), total: found.length, truncated, dir, subdirs });
  });

  // GET /api/sessions/:id/fs/raw?path=<rel>
  // 파일 raw 바이트를 content-type 과 함께 반환 (QuickLook 다운로드용 — base64/JSON cap 회피).
  sessions.get("/:id/fs/raw", async (c) => {
    const id = c.req.param("id");
    const session = getSession(id);
    if (!session) return c.json({ error: "not_found" }, 404);
    const repoPath = session.repo_path;
    if (!repoPath) return c.json({ error: "no_repo" }, 404);

    const queryPath = c.req.query("path");
    if (!queryPath) return c.json({ error: "path_required" }, 400);
    const r = await resolveRepoRelative(repoPath, queryPath);
    if (!r.ok) return c.json({ error: r.error }, 400);

    const fs = await import("node:fs/promises");
    let buf: Buffer;
    try {
      const st = await fs.stat(r.abs);
      if (st.isDirectory()) return c.json({ error: "is_a_directory" }, 400);
      if (Number(st.size) > FS_RAW_MAX_BYTES) {
        return c.json({ error: "too_large", size: Number(st.size), max: FS_RAW_MAX_BYTES }, 413);
      }
      buf = await fs.readFile(r.abs);
    } catch (e: any) {
      if (e?.code === "ENOENT") return c.json({ error: "not_found" }, 404);
      return c.json({ error: "read_failed" }, 500);
    }
    const ext = r.rel.toLowerCase().split(".").pop() ?? "";
    const contentType = RAW_CONTENT_TYPE[ext] ?? "application/octet-stream";
    // Buffer → fresh ArrayBuffer-backed Uint8Array (Hono Data 타입 호환).
    return c.body(new Uint8Array(buf), 200, {
      "Content-Type": contentType,
      "Content-Length": String(buf.length),
      "Cache-Control": "no-store",
    });
  });

  // 이미지 첨부 업로드 한도. Tor 대역폭상 iOS 가 다운스케일해 올리는 걸 전제로 잡았다.
  const ATTACH_BODY_MAX = 60 * 1024 * 1024; // base64 팽창(~33%) 포함 전체 body cap
  const ATTACH_PER_FILE_MAX = 12 * 1024 * 1024; // 디코드 후 장당 cap
  const ATTACH_MAX_COUNT = 20;
  const ATTACH_DEFAULT_DIR = "attachments";

  /**
   * 이미지 첨부 업로드 — iOS 가 base64 이미지(들)를 올리면 세션 repo 안에 저장하고 저장된
   * repo-relative 경로를 돌려준다. 그 경로는 이후 사용자 메시지(프롬프트)에서 참조돼 에이전트
   * (claude 등)가 Read 도구로 이미지를 읽는다. 기본 디렉토리는 repo_path/attachments.
   *
   * body: { dir?: string(repo-relative), images: [{ filename: string, data_b64: string }] }
   * 응답: { saved: [{ rel, abs, bytes }] }
   *
   * 업로드라 daemon 기본 body 처리로는 부족 — 라우트 단위 bodyLimit 으로 넉넉히 허용.
   * 경로는 fs 라우트와 동일하게 resolveRepoRelative 로 repo 밖 / `.git` 쓰기를 차단한다.
   */
  sessions.post(
    "/:id/attachments",
    bodyLimit({
      maxSize: ATTACH_BODY_MAX,
      onError: (c) => c.json({ error: "payload_too_large" }, 413),
    }),
    async (c) => {
      const id = c.req.param("id");
      const session = getSession(id);
      if (!session) return c.json({ error: "not_found" }, 404);
      const repoPath = session.repo_path;
      if (!repoPath) return c.json({ error: "no_repo" }, 404);

      const body = await c.req.json().catch(() => null);
      const images = body?.images;
      if (!Array.isArray(images) || images.length === 0) {
        return c.json({ error: "images_required" }, 400);
      }
      if (images.length > ATTACH_MAX_COUNT) {
        return c.json({ error: "too_many_images" }, 400);
      }

      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const fileExists = async (p: string): Promise<boolean> => {
        try {
          await fs.access(p);
          return true;
        } catch {
          return false;
        }
      };

      // 대상 디렉토리 해석 + 생성 (기본 attachments).
      const dirRel =
        typeof body.dir === "string" && body.dir.trim() !== "" ? body.dir : ATTACH_DEFAULT_DIR;
      const dirR = await resolveRepoRelative(repoPath, dirRel);
      if (!dirR.ok) return c.json({ error: dirR.error }, dirR.error === "no_repo" ? 404 : 400);
      try {
        await fs.mkdir(dirR.abs, { recursive: true });
      } catch {
        return c.json({ error: "mkdir_failed" }, 500);
      }

      const saved: Array<{ rel: string; abs: string; bytes: number }> = [];
      const usedNames = new Set<string>();
      for (let i = 0; i < images.length; i++) {
        const img = images[i];
        if (!img || typeof img.data_b64 !== "string") {
          return c.json({ error: "invalid_image", index: i }, 400);
        }
        // 파일명 정리 — basename 만, 안전 문자만, 비면 기본값. 디스크/배치 내 충돌 시 -n 접미.
        let base = path.basename(typeof img.filename === "string" ? img.filename : "").trim();
        base = base.replace(/[^\w.\-]/g, "_");
        if (base === "" || base === "." || base === "..") base = `image-${i + 1}.png`;
        let name = base;
        let n = 1;
        while (usedNames.has(name) || (await fileExists(path.join(dirR.abs, name)))) {
          const ext = path.extname(base);
          const stem = base.slice(0, base.length - ext.length);
          name = `${stem}-${n}${ext}`;
          n++;
        }
        usedNames.add(name);

        // 혹시 모를 data URI 접두 제거 후 디코드.
        const b64 = img.data_b64.replace(/^data:[^,]*,/, "");
        const buf = Buffer.from(b64, "base64");
        if (buf.length === 0) return c.json({ error: "empty_image", index: i }, 400);
        if (buf.length > ATTACH_PER_FILE_MAX) {
          return c.json({ error: "image_too_large", index: i }, 413);
        }

        const fileR = await resolveRepoRelative(repoPath, path.posix.join(dirR.rel, name));
        if (!fileR.ok) return c.json({ error: fileR.error, index: i }, 400);
        try {
          await fs.writeFile(fileR.abs, buf);
        } catch {
          return c.json({ error: "write_failed", index: i }, 500);
        }
        saved.push({ rel: fileR.rel, abs: fileR.abs, bytes: buf.length });
      }

      return c.json({ saved });
    },
  );

}
