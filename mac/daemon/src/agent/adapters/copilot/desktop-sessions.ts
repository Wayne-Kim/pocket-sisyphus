/**
 * copilot(GitHub Copilot CLI) 데스크탑 세션 디스커버리 — copilot 의 단일 SQLite 스토어
 * (`~/.copilot/session-store.db`)의 `sessions` 테이블에서 「이어받기」 후보 메타데이터를 뽑아
 * DesktopSessionSummary 배열로 돌려준다. Mac 에서 시작한 copilot 세션을 폰의 세션 목록에서
 * 발견·이어받게 하는 게 목적 — claude/codex/agy/qwen/opencode 와 동일한 경로(buildSpawnArgs
 * 의 ctx.resumeFrom → `copilot --resume <id>`).
 *
 * 왜 SQLite 인가 (claude/qwen 의 per-file jsonl 패턴이 아닌 이유):
 *  - copilot 은 모든 세션을 한 SQLite DB(`session-store.db`, WAL 모드)에 담는다. `sessions`
 *    테이블 한 row = 세션 하나이고 필요한 메타(id·작업 디렉터리·요약 제목·브랜치·생성/갱신
 *    시각)가 전부 «컬럼» 으로 있어, 한 번의 SELECT 로 후보를 만든다 (opencode 와 동형).
 *  - daemon 은 이미 better-sqlite3 에 의존한다(src/db). 그걸 read-only 로 재사용한다 —
 *    실행 중인 copilot 의 DB 를 절대 쓰지 않도록(체크포인트/락 회피) readonly 로 연다.
 *
 * 경계 (브리프 비-목표): 라이브 본문 tail(과거 대화 재생)은 안 한다 — agy/opencode 와 같은
 * 「이어받기는 지원 / 라이브 tail 은 미지원」 경계. 디스커버리(어떤 세션이 있는지 노출)만 한다.
 *
 * 포맷 견고성 (브리프 엣지케이스: 「스키마가 향후 바뀔 수 있음 — best-effort 파싱, 깨지면
 * graceful 빈 결과 + 로그」):
 *  - DB 파일이 없으면(=copilot 미설치/미사용) → 빈 목록.
 *  - 열기/쿼리 실패(권한·스키마 drift·손상·WAL 잠금 등) → 빈 목록 + 조용한 폴백
 *    (에러 토스트 없음). 다른 watcher 의 «미지원 = null/[]» 동작과 정합.
 *
 * 필드 매핑 (DesktopSessionSummary):
 *  - sessionId   ← sessions.id         (`copilot --resume <id>` 로 이어받는 값)
 *  - repoPath    ← sessions.cwd         (작업 디렉터리; repoPathFilter 가 이 값으로 매칭.
 *                                        `repository` 는 `owner/repo` 깃 슬러그라 경로 아님)
 *  - preview     ← sessions.summary      (copilot 자동 생성 제목), 비면 첫 user_message 폴백
 *  - startedAt   ← sessions.created_at   (ISO-8601 → ms epoch)
 *  - lastActiveAt← max(sessions.updated_at, 최신 turn timestamp)  (ISO-8601 → ms epoch)
 *  - turnCount   ← turns 의 user_message 가 있는 row 수 (실패/0 시 null)
 *  - gitBranch   ← sessions.branch       (비면 null)
 *
 * 중복/정렬 (브리프 엣지케이스: 「같은 repo 에 세션 여러 개 → 최근순 정렬·중복 제거」):
 *  - sessions.id 가 PRIMARY KEY 라 SELECT 결과는 세션당 한 row(중복 원천 차단 — turns 는
 *    JOIN 으로 row 를 불리지 않고 별도 집계 Map 으로 보강한다).
 *  - 최종 정렬은 lastActiveAt 내림차순 (turn timestamp 로 보강된 최신 활동 기준).
 *
 * Cache 정책 (opencode/claude/qwen 과 동일):
 *  - scanCache: per-key (repo-scoped 또는 unscoped) 결과를 30s 까지 보관.
 *  - watcher 의 onCopilotWatcherInvalidation 으로 무효화 (DB 변동 시).
 */
import fs from "node:fs";
import Database from "better-sqlite3";
import type {
  DesktopAgentWatcher,
  DesktopListOptions,
  DesktopSessionSummary,
} from "../../types.js";
import {
  COPILOT_DB_PATH,
  onCopilotWatcherInvalidation,
  startCopilotWatcher,
} from "./watcher.js";

const STALE_GRACE_MS = 30_000;
/** preview(=summary/첫 메시지) 길이 상한 — claude/qwen/opencode 의 preview truncate 와 동일. */
const PREVIEW_MAX = 140;

type CacheEntry = { value: DesktopSessionSummary[]; computedAt: number };
const scanCache = new Map<string, CacheEntry>();

// watcher 이벤트로 캐시 전체 무효화 — DB 변동이면 어떤 row 든 갱신될 수 있어 부분 무효화는
// 의미 없음 (opencode 와 동일).
onCopilotWatcherInvalidation(() => {
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
  cwd: string | null;
  summary: string | null;
  branch: string | null;
  created_at: string | null;
  updated_at: string | null;
};

/** turns 테이블에서 세션별로 보강하는 메타 (turnCount + 최신 활동 + 첫 user 메시지). */
type TurnMeta = {
  userTurns: number;
  lastTurnAt: number | null;
  firstUserMessage: string | null;
};

/**
 * copilot 의 created_at/updated_at/turns.timestamp 는 모두 TEXT.
 * 실측(copilot 1.x)은 ISO-8601 + 'Z'(UTC) 포맷("2026-06-19T03:45:09.322Z") — Date.parse 가
 * 그대로 UTC 로 읽는다. 단, 스키마 컬럼 DEFAULT 는 sqlite `datetime('now')` →
 * "YYYY-MM-DD HH:MM:SS"(UTC, 존 없음) 이라, copilot 이 값을 안 박은 희귀 row 는 그 모양일 수
 * 있다 — 그 경우 Date 가 local time 으로 오독하지 않도록 'T'+ 'Z' 로 정규화한다.
 */
function parseCopilotTs(s: string | null | undefined): number | null {
  if (!s) return null;
  const t = s.trim();
  if (t.length === 0) return null;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(t)
    ? t.replace(" ", "T") + "Z"
    : t;
  const ms = Date.parse(normalized);
  return Number.isNaN(ms) ? null : ms;
}

function clip(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = s.trim();
  if (t.length === 0) return null;
  return t.length <= PREVIEW_MAX ? t : t.slice(0, PREVIEW_MAX) + "…";
}

/**
 * dbPath 의 copilot SQLite 스토어에서 이어받기 후보를 스캔한다. 경로를 인자로 받아 테스트가
 * tmpdir 픽스처 DB 로 검증할 수 있게 한다 (기본값은 COPILOT_DB_PATH).
 *
 * 어떤 단계에서 실패하든(파일 부재·열기 실패·쿼리 실패) 조용히 [] 로 폴백한다.
 */
export function scanCopilotSessions(
  dbPath: string,
  opts: DesktopListOptions,
): DesktopSessionSummary[] {
  if (!fs.existsSync(dbPath)) return [];

  let db: Database.Database | null = null;
  try {
    // readonly + fileMustExist: 실행 중인 copilot 의 DB 를 절대 변경하지 않는다(체크포인트
    // 유발·락 경합 회피). WAL 모드 DB 도 readonly 로 커밋된 WAL 까지 읽힌다 — 동시 쓰기(WAL
    // 잠금) 중이어도 reader 는 막히지 않고, 그래도 실패하면 아래 catch 가 빈 목록으로 폴백.
    db = new Database(dbPath, { readonly: true, fileMustExist: true });

    const where = opts.repoPathFilter
      ? "WHERE cwd IS NOT NULL AND cwd != '' AND cwd = ?"
      : "WHERE cwd IS NOT NULL AND cwd != ''";
    const params = opts.repoPathFilter ? [opts.repoPathFilter] : [];
    const rows = db
      .prepare(
        `SELECT id, cwd, summary, branch, created_at, updated_at
           FROM sessions
           ${where}
           ORDER BY updated_at DESC`,
      )
      .all(...params) as SessionRow[];

    // turnCount / 최신 활동 / 첫 user 메시지 보강 — 별도 try 로 격리해, turns 테이블 스키마가
    // 다른 버전이어도 세션 목록 자체는 살아남게 한다 (보강만 비고, 목록은 유지).
    const metaBySession = loadTurnMeta(db);

    const items: DesktopSessionSummary[] = [];
    for (const r of rows) {
      // cwd 가 비면 이어받을 작업 위치가 불명 — 스킵 (WHERE 에서 이미 거르지만 방어적으로).
      if (!r.cwd || r.cwd.length === 0) continue;
      const meta = metaBySession.get(r.id);
      const createdMs = parseCopilotTs(r.created_at);
      const updatedMs = parseCopilotTs(r.updated_at);
      // 실측상 turns.timestamp 가 sessions.updated_at 보다 최신인 경우가 있다(세션 row 의
      // updated_at 이 매 turn 마다 갱신되지 않음) — 최신 활동 시각으로 둘의 max 를 쓴다.
      const lastActiveAt = Math.max(
        updatedMs ?? 0,
        meta?.lastTurnAt ?? 0,
        createdMs ?? 0,
      );
      const turns = meta?.userTurns ?? 0;
      items.push({
        sessionId: r.id,
        repoPath: r.cwd,
        preview: clip(r.summary) ?? clip(meta?.firstUserMessage ?? null),
        turnCount: turns > 0 ? turns : null,
        lastActiveAt,
        startedAt: createdMs,
        gitBranch: r.branch && r.branch.trim().length > 0 ? r.branch : null,
      });
    }
    // turn timestamp 보강으로 SQL ORDER BY(updated_at) 와 어긋날 수 있어 최종 정렬을 다시 한다.
    items.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
    return items;
  } catch (e) {
    // 손상·권한·스키마 drift·WAL 잠금·미지원 포맷 등 — 조용한 폴백.
    console.error(
      "[copilot-sessions] scan failed (폴백 → 빈 목록):",
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

/**
 * session_id → {userTurns, lastTurnAt, firstUserMessage}. turns 테이블이 없거나 쿼리 실패 시
 * 빈 Map (→ turnCount null, lastActiveAt 은 sessions.updated_at 만으로 폴백, preview 는
 * summary 만으로).
 */
function loadTurnMeta(db: Database.Database): Map<string, TurnMeta> {
  const map = new Map<string, TurnMeta>();
  try {
    // 집계: user_message 가 있는 turn 수 + 최신 turn timestamp. JOIN 으로 세션 row 를 불리지
    // 않도록 GROUP BY 집계만 — 세션당 한 entry 보장(중복 원천 차단).
    const aggRows = db
      .prepare(
        `SELECT session_id AS sid, count(*) AS n, max(timestamp) AS last_ts
           FROM turns
           WHERE user_message IS NOT NULL
           GROUP BY session_id`,
      )
      .all() as { sid: string; n: number; last_ts: string | null }[];
    for (const row of aggRows) {
      map.set(row.sid, {
        userTurns: row.n,
        lastTurnAt: parseCopilotTs(row.last_ts),
        firstUserMessage: null,
      });
    }

    // 첫 user 메시지(가장 낮은 turn_index) — summary 가 빌 때의 preview 폴백. 세션별 1행만
    // 잡도록 min(turn_index) 서브쿼리와 self-join. 실패해도 위 집계는 유지(별도 try).
    try {
      const firstRows = db
        .prepare(
          `SELECT t.session_id AS sid, t.user_message AS msg
             FROM turns t
             JOIN (SELECT session_id, min(turn_index) AS mi
                     FROM turns
                     WHERE user_message IS NOT NULL
                     GROUP BY session_id) f
               ON t.session_id = f.session_id AND t.turn_index = f.mi`,
        )
        .all() as { sid: string; msg: string | null }[];
      for (const row of firstRows) {
        const meta = map.get(row.sid);
        if (meta) meta.firstUserMessage = row.msg;
      }
    } catch {
      // 첫 메시지 보강 실패 — preview 는 summary 만으로 (turnCount 등은 유지).
    }
  } catch {
    // turns 테이블/포맷 차이 — turnCount 는 null, lastActiveAt 은 updated_at 만으로.
  }
  return map;
}

/**
 * copilotAdapter.desktopWatcher() 가 반환하는 객체. 라우트는 이걸 통해서만 scan / watcher
 * 에 접근한다 (claude/codex/agy/qwen/opencode 와 동일한 형태).
 */
export const copilotDesktopWatcher: DesktopAgentWatcher = {
  list(opts: DesktopListOptions): DesktopSessionSummary[] {
    const key = opts.repoPathFilter ? `repo:${opts.repoPathFilter}` : "all";
    return getScanCached(key, () => scanCopilotSessions(COPILOT_DB_PATH, opts));
  },
  start(onInvalidate): () => void {
    // 외부 listener 등록 + fs.watch 시작. 내부 listener (캐시 무효화) 는 모듈 import 시점에
    // 이미 등록돼 있다.
    const off = onCopilotWatcherInvalidation((scope, sessionId) => {
      onInvalidate(scope, sessionId);
    });
    const handle = startCopilotWatcher();
    return () => {
      off();
      handle?.stop();
    };
  },
};
