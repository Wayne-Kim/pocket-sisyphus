/**
 * opencode 데스크탑 세션 디스커버리 — opencode(v1.17+)의 단일 SQLite 스토어
 * (`~/.local/share/opencode/opencode.db`)에서 「이어받기」 후보 메타데이터를 뽑아
 * DesktopSessionSummary 배열로 돌려준다. Mac 에서 시작한 opencode 세션을 폰의 세션 목록에서
 * 발견·이어받게 하는 게 목적 — claude/codex/agy/qwen 과 동일한 경로(buildSpawnArgs 의
 * ctx.resumeFrom → `opencode --session <id>`).
 *
 * 왜 SQLite 인가 (claude/qwen 의 per-file jsonl 패턴이 아닌 이유):
 *  - claude/qwen 은 세션별 평문 jsonl 을 디렉터리 트리에 쓰지만, opencode 는 모든 세션을
 *    한 SQLite DB(`opencode.db`, WAL 모드)에 담는다. `session` 테이블 한 row = 세션 하나이고
 *    필요한 메타(id·작업 디렉터리·제목·생성/갱신 시각)가 전부 «컬럼» 으로 있어, 파일을
 *    sampling-파싱할 필요 없이 한 번의 SELECT 로 후보를 만든다.
 *  - daemon 은 이미 better-sqlite3 에 의존한다(src/db). 그걸 read-only 로 재사용한다 —
 *    실행 중인 opencode 의 DB 를 절대 쓰지 않도록(체크포인트/락 회피) readonly 로 연다.
 *
 * 포맷 견고성 (브리프 엣지케이스: 「버전마다 포맷이 다를 수 있음 — 발견되는 포맷만 견고히
 * 파싱, 미지원은 조용히 스킵」):
 *  - DB 파일이 없으면(=opencode 미실행) → 빈 목록.
 *  - 열기/쿼리 실패(권한·스키마 drift·손상·옛 파일기반 포맷 등) → 빈 목록 + 조용한 폴백
 *    (에러 토스트 없음). claude/qwen 의 «root 부재 → []» 와 동일한 견고성.
 *
 * 필드 매핑 (DesktopSessionSummary):
 *  - sessionId   ← session.id        (`opencode --session <id>` 로 이어받는 값)
 *  - repoPath    ← session.directory (작업 디렉터리; repoPathFilter 가 이 값으로 매칭)
 *  - preview     ← session.title     (opencode 가 대화에서 자동 생성한 제목 = 사람용 요약)
 *  - startedAt   ← session.time_created  (ms epoch)
 *  - lastActiveAt← session.time_updated  (ms epoch)
 *  - turnCount   ← message 테이블의 role='user' 메시지 수 (실패 시 null)
 *  - gitBranch   ← null (opencode 가 세션에 브랜치를 안 남김; workspace.branch 는 비어 있음)
 *
 * parent_id 가 있는 row 는 서브에이전트(child) 세션이라 이어받기 후보에서 제외한다 —
 * top-level 세션만 노출(예: `@explore subagent` 세션은 부모만 보여준다).
 *
 * Cache 정책 (claude/qwen 과 동일):
 *  - scanCache: per-key (repo-scoped 또는 unscoped) 결과를 30s 까지 보관.
 *  - watcher 의 onOpencodeWatcherInvalidation 으로 무효화 (DB 변동 시).
 *  - 세션별 inspection 캐시는 불필요 — 한 번의 SELECT 가 전체 후보를 만들어 per-file 재파싱
 *    회피 대상이 없다.
 */
import fs from "node:fs";
import Database from "better-sqlite3";
import type {
  DesktopAgentWatcher,
  DesktopListOptions,
  DesktopSessionSummary,
} from "../../types.js";
import {
  OPENCODE_DB_PATH,
  onOpencodeWatcherInvalidation,
  startOpencodeWatcher,
} from "./watcher.js";

const STALE_GRACE_MS = 30_000;
/** preview(=title) 길이 상한 — claude/qwen 의 preview truncate 와 같은 정책. */
const PREVIEW_MAX = 140;

type CacheEntry = { value: DesktopSessionSummary[]; computedAt: number };
const scanCache = new Map<string, CacheEntry>();

// watcher 이벤트로 캐시 전체 무효화 — DB 변동이면 어떤 row 든 갱신될 수 있어 부분 무효화는
// 의미 없음 (claude/qwen 과 동일).
onOpencodeWatcherInvalidation(() => {
  scanCache.clear();
});

function getScanCached(
  key: string,
  compute: () => DesktopSessionSummary[],
): DesktopSessionSummary[] {
  const now = Date.now();
  const hit = scanCache.get(key);
  if (hit && now - hit.computedAt < STALE_GRACE_MS) {
    return hit.value;
  }
  const value = compute();
  scanCache.set(key, { value, computedAt: now });
  return value;
}

type SessionRow = {
  id: string;
  directory: string | null;
  title: string | null;
  time_created: number;
  time_updated: number;
};

/**
 * dbPath 의 opencode SQLite 스토어에서 이어받기 후보를 스캔한다. 경로를 인자로 받아 테스트가
 * tmpdir 픽스처 DB 로 검증할 수 있게 한다 (기본값은 OPENCODE_DB_PATH).
 *
 * 어떤 단계에서 실패하든(파일 부재·열기 실패·쿼리 실패) 조용히 [] 로 폴백한다.
 */
export function scanOpencodeSessions(
  dbPath: string,
  opts: DesktopListOptions,
): DesktopSessionSummary[] {
  if (!fs.existsSync(dbPath)) return [];

  let db: Database.Database | null = null;
  try {
    // readonly + fileMustExist: 실행 중인 opencode 의 DB 를 절대 변경하지 않는다(체크포인트
    // 유발·락 경합 회피). WAL 모드 DB 도 readonly 로 커밋된 WAL 까지 읽힌다.
    db = new Database(dbPath, { readonly: true, fileMustExist: true });

    const where = opts.repoPathFilter
      ? "WHERE parent_id IS NULL AND directory = ?"
      : "WHERE parent_id IS NULL";
    const params = opts.repoPathFilter ? [opts.repoPathFilter] : [];
    const rows = db
      .prepare(
        `SELECT id, directory, title, time_created, time_updated
           FROM session
           ${where}
           ORDER BY time_updated DESC`,
      )
      .all(...params) as SessionRow[];

    // turnCount 보강 — message 테이블의 role='user' 개수. 별도 try 로 격리해, message
    // 테이블 스키마가 다른 버전이어도 세션 목록 자체는 살아남게 한다 (turnCount 만 null).
    const turnsBySession = countUserTurns(db);

    const items: DesktopSessionSummary[] = [];
    for (const r of rows) {
      // directory 가 비면 이어받을 작업 위치가 불명 — 스킵.
      if (!r.directory || r.directory.length === 0) continue;
      const turns = turnsBySession.get(r.id);
      items.push({
        sessionId: r.id,
        repoPath: r.directory,
        preview: previewFromTitle(r.title),
        turnCount: turns !== undefined && turns > 0 ? turns : null,
        lastActiveAt: r.time_updated,
        startedAt: r.time_created,
        gitBranch: null,
      });
    }
    return items;
  } catch (e) {
    // 손상·권한·스키마 drift·미지원(옛 파일기반) 포맷 등 — 조용한 폴백.
    console.error(
      "[opencode-sessions] scan failed (폴백 → 빈 목록):",
      (e as Error).message,
    );
    return [];
  } finally {
    try {
      db?.close();
    } catch {
      // already closed / never opened
    }
  }
}

/** session.id → role='user' 메시지 수. message 테이블이 없거나 쿼리 실패 시 빈 Map. */
function countUserTurns(db: Database.Database): Map<string, number> {
  const map = new Map<string, number>();
  try {
    const rows = db
      .prepare(
        `SELECT session_id AS sid, count(*) AS n
           FROM message
           WHERE json_extract(data, '$.role') = 'user'
           GROUP BY session_id`,
      )
      .all() as { sid: string; n: number }[];
    for (const row of rows) map.set(row.sid, row.n);
  } catch {
    // message 테이블/포맷 차이 — turnCount 는 null 로 둔다.
  }
  return map;
}

function previewFromTitle(title: string | null): string | null {
  if (!title) return null;
  const t = title.trim();
  if (t.length === 0) return null;
  return t.length <= PREVIEW_MAX ? t : t.slice(0, PREVIEW_MAX) + "…";
}

/**
 * opencodeAdapter.desktopWatcher() 가 반환하는 객체. 라우트는 이걸 통해서만 scan / watcher
 * 에 접근한다 (claude/codex/agy/qwen 과 동일한 형태).
 */
export const opencodeDesktopWatcher: DesktopAgentWatcher = {
  list(opts: DesktopListOptions): DesktopSessionSummary[] {
    const key = opts.repoPathFilter ? `repo:${opts.repoPathFilter}` : "all";
    return getScanCached(key, () => scanOpencodeSessions(OPENCODE_DB_PATH, opts));
  },
  start(onInvalidate): () => void {
    // 외부 listener 등록 + fs.watch 시작. 내부 listener (캐시 무효화) 는 모듈 import 시점에
    // 이미 등록돼 있다.
    const off = onOpencodeWatcherInvalidation((scope, sessionId) => {
      onInvalidate(scope, sessionId);
    });
    const handle = startOpencodeWatcher();
    return () => {
      off();
      handle?.stop();
    };
  },
};
