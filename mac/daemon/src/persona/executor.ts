// PO 루프 실행기 — 수집 세션 spawn → settle → 브리프 파일 ingest.
//
// cron/executor 와 같은 골격(세션 1개 + 프롬프트 1번 + settle 대기)이되, 끝에서 산출 파일
// (JSON 브리프 배열)을 거둬 po_briefs 에 넣고 «브리프 도착» 알림을 보낸다는 점만 다르다.
// 수집 세션은 iOS 세션 목록에 그대로 떠서 사용자가 transcript 를 열어볼 수 있다.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { db } from "../db/index.js";
import { getAgent, hasAgent } from "../agent/registry.js";
import {
  runUserMessagePty,
  abortPtySession,
  awaitPtyExit,
} from "../agent/pty-runner.js";
import { createSession, resolveAndEnsureRepoDir } from "../routes/sessions.js";
import { guardUnattendedRepo } from "../mcp/unattended.js";
import { markCronSession, unmarkCronSession } from "../cron/registry.js";
import { waitForSessionSettle } from "../cron/executor.js";
import { dispatchPoNotification } from "../notify/index.js";
import {
  buildPoCollectPrompt,
  buildPoResearchPrompt,
  buildPoRevisePrompt,
  buildPoDesignBootstrapPrompt,
  poLoc,
  type PoBriefDraft,
  type PoDecisionRecord,
  type PoOutcomeRecord,
} from "./prompt.js";
import { t } from "./i18n/t.js";
import { parseLens, type PoLens } from "./lens.js";
import { fetchCustomerReviews } from "./asc.js";
import { fetchCrashDigest } from "./crash.js";
import { findSimilar, evidenceRefs } from "./similarity.js";
import { selectConsensusBriefs } from "./consensus.js";
import { analyzeBriefReadability, formatReadabilitySignals } from "./readability.js";
import { readConfig, resolvePoMultiPass } from "../config.js";
import {
  type CollectSignals,
  type SignalSourceState,
  type ScheduledOutcomeKind,
  serializeSignals,
  classifyAscFailure,
  classifyScheduledOutcome,
  shouldNotifyScheduledOutcome,
} from "./signals.js";

/**
 * 수집 1회의 신호원 실행 상태를 그 repo 의 «직전 수집» 으로 persist 한다 (po_signal_status_v1).
 * iOS 백로그가 `GET /api/po/collect/last?repoPath=` 로 읽어, 방금 끝난 수집(sessionId 일치)의
 * store/crash 신호가 실제 반영됐는지(혹은 키/네트워크로 빠졌는지)를 결과 카드로 보여준다.
 * 절대 throw 하지 않는다 — 수집 본류를 신호 메타 persist 가 죽이지 않게 한다.
 */
function persistCollectSignals(
  repoPath: string,
  sessionId: string,
  signals: CollectSignals,
): void {
  try {
    db()
      .prepare(
        `UPDATE po_profiles
           SET last_collect_signals = ?, last_collect_session_id = ?, last_collect_at = ?
         WHERE repo_path = ?`,
      )
      .run(serializeSignals(signals), sessionId, Date.now(), repoPath);
  } catch (e) {
    console.warn(`[po] persist collect signals failed repo=${repoPath}:`, (e as Error).message);
  }
}

/** 직전 예약 수집의 결말 — 알림 폭주 억제 비교용 (shouldNotifyScheduledOutcome 입력). */
function readPrevScheduledOutcome(
  repoPath: string,
): { outcome: ScheduledOutcomeKind; error: string | null } | null {
  try {
    const row = db()
      .prepare(
        `SELECT last_scheduled_outcome, last_scheduled_error FROM po_profiles WHERE repo_path = ?`,
      )
      .get(repoPath) as
      | { last_scheduled_outcome: string | null; last_scheduled_error: string | null }
      | undefined;
    const o = row?.last_scheduled_outcome;
    if (o === "new" || o === "empty" || o === "failed") {
      return { outcome: o, error: row?.last_scheduled_error ?? null };
    }
  } catch {
    /* best-effort — 못 읽으면 «직전 없음»(=알린다) 으로 폴백 */
  }
  return null;
}

/**
 * 예약 수집의 결말을 그 repo 프로필에 persist (po_scheduled_status_v1) — 앱 내 «마지막 예약 수집»
 * 카드의 원천. 알림 억제/꺼짐과 무관하게 «항상» 기록한다 (알림을 꺼도 결말을 앱에서 확인 가능 — AC6).
 * 절대 throw 하지 않는다.
 */
function persistScheduledOutcome(
  repoPath: string,
  rec: {
    outcome: ScheduledOutcomeKind;
    briefCount: number;
    error: string | null;
    sessionId: string | null;
    signals: CollectSignals | null;
  },
): void {
  try {
    db()
      .prepare(
        `UPDATE po_profiles
           SET last_scheduled_outcome = ?, last_scheduled_brief_count = ?, last_scheduled_error = ?,
               last_scheduled_session_id = ?, last_scheduled_signals = ?, last_scheduled_at = ?
         WHERE repo_path = ?`,
      )
      .run(
        rec.outcome,
        rec.briefCount,
        rec.error,
        rec.sessionId,
        rec.signals ? serializeSignals(rec.signals) : null,
        Date.now(),
        repoPath,
      );
  } catch (e) {
    console.warn(`[po] persist scheduled outcome failed repo=${repoPath}:`, (e as Error).message);
  }
}

/**
 * 예약(scheduled) 수집의 결말을 기록 + (억제되지 않으면) 무인 알림. 수동 «지금 수집» 은 이 경로로
 * 들어오지 않는다 — 화면 앞 사용자라 중복 알림이 잡음이다 (AC4). 두 호출처:
 *   - finalizeCollection: 인입 끝(성공 N건 / 정상 0건 / 에러·타임아웃) 직후.
 *   - PoScheduler: tick 의 startPoCollection 이 «시작 자체» 에 실패했을 때(세션 없음).
 * persist 는 항상, 알림은 shouldNotifyScheduledOutcome 으로 폭주 억제(연속 empty/동일 failed 묶음).
 * 절대 throw 하지 않는다 — 수집 본류/스케줄러 tick 을 결말 통지가 깨면 안 됨.
 */
export async function recordScheduledCollectOutcome(ev: {
  repoPath: string;
  /** 수집 세션 id. 시작 실패(스케줄러 tick)는 세션이 없어 null. */
  sessionId: string | null;
  status: "ok" | "error" | "timeout";
  briefCount: number;
  /** 새 브리프가 정확히 1건일 때 그 id — 알림 딥링크가 브리프 상세로 직행. */
  briefId?: string;
  /** failed 결말의 사유 요약 (알림 «Reason» 필드 + 카드). */
  errorSummary?: string;
  /** 그 수집의 App Store 신호원 실행 상태 — 카드/알림에 함께 surface. */
  signals?: CollectSignals;
}): Promise<void> {
  try {
    const outcome = classifyScheduledOutcome(ev.status, ev.briefCount);
    const error = outcome === "failed" ? (ev.errorSummary?.trim().slice(0, 500) ?? null) : null;
    const prev = readPrevScheduledOutcome(ev.repoPath);
    // 결말은 늘 기록 — 알림이 꺼져 있거나 억제돼도 앱 내 카드로 확인 가능해야 한다 (AC5/AC6).
    persistScheduledOutcome(ev.repoPath, {
      outcome,
      briefCount: ev.briefCount,
      error,
      sessionId: ev.sessionId,
      signals: ev.signals ?? null,
    });
    if (!shouldNotifyScheduledOutcome(prev, { outcome, error })) {
      console.log(
        `[po] scheduled outcome notify suppressed repo=${ev.repoPath} outcome=${outcome} (폭주 억제)`,
      );
      return;
    }
    await dispatchPoNotification({
      sessionId: ev.sessionId ?? undefined,
      repoPath: ev.repoPath,
      status: ev.status,
      briefCount: ev.briefCount,
      briefId: ev.briefId,
      signals: ev.signals,
      errorSummary: error ?? undefined,
    });
  } catch (e) {
    console.warn(
      `[po] recordScheduledCollectOutcome failed repo=${ev.repoPath}:`,
      (e as Error).message,
    );
  }
}

/** 한 번의 수집에 첨부할 스토어 리뷰 상한 — 프롬프트 첨부 파일 크기 통제. */
const MAX_ASC_REVIEWS = 50;

/** 한 번의 수집이 만들 수 있는 브리프 상한 — 폰에서 훑을 수 있는 양으로 제한. */
const MAX_BRIEFS_PER_RUN = 8;

/**
 * repo 별 «수집 진행 중» 표시 — 주기 수집(PoScheduler)의 overlap 가드.
 * cron executor 의 runningJobs 와 같은 in-memory 정책: daemon 재시작 시 자동으로 비워져
 * stale-lock 이 안 생기고, finalizeCollection 의 finally 가 항상 해제한다.
 */
const collectingRepos = new Set<string>();

/** 이 repo 의 수집이 지금 진행 중인가 — 스케줄러가 tick 을 건너뛸지 판단. */
export function isPoCollectionRunning(repoPath: string): boolean {
  return collectingRepos.has(repoPath);
}

export type PoCollectResult =
  | { status: "running"; sessionId: string; agentId: string }
  | { status: "error"; error: string };

/**
 * 수집 세션 제목에 붙일 «언제 돌린 수집인지» 꼬리표 — `M/D HH:mm` (daemon 로컬시).
 * 모든 수집(주기·검증 버튼)이 같은 "📋 PO 신호 수집" 한 이름이라 세션 목록에서 구별이
 * 불가능했다(어떤 게 무엇을 언제 본 수집인지 모름). 시각을 붙여 매 수집을 고유·시간순으로.
 */
function collectStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** dedup 코퍼스 상한 — 프롬프트 비대화 방지 + 백스톱 비교 비용 통제. */
const MAX_DEDUP_CORPUS = 60;

/**
 * dedup 코퍼스 한 건 — 프롬프트 앵커(prompt.ts PoExistingBrief)이자 lexical 백스톱 비교 대상.
 * evidence(JSON 원형)는 백스톱의 ref-겹침 신호 입력 — 프롬프트 앵커는 이 필드를 무시한다.
 */
type DedupBrief = { id: string; title: string; problem: string; evidence: string; status: string };

/**
 * repo 의 «중복 방지 코퍼스» — 살아있는 제안(proposed/held/approved/running)뿐 아니라 닫힌
 * 결정(rejected/shipped/verified/missed)까지 포함한다. 옛 activeBriefTitles 는 «제목·살아있는
 * 것만» 줘서 ① 표현만 다른 의미-중복 ② 이미 기각/출시된 것의 재제안을 못 막았다 — 이 코퍼스가
 * 그 두 누수를 메운다. 살아있는 것 먼저, 그다음 닫힌 것 최신순, 상한 N.
 */
function dedupCorpus(repoPath: string): DedupBrief[] {
  return db()
    .prepare(
      `SELECT id, title, problem, evidence, status FROM po_briefs
       WHERE repo_path = ?
         AND status IN ('proposed','held','approved','running','rejected','shipped','verified','missed')
       ORDER BY
         CASE WHEN status IN ('proposed','held','approved','running') THEN 0 ELSE 1 END,
         updated_at DESC
       LIMIT ?`,
    )
    .all(repoPath, MAX_DEDUP_CORPUS) as DedupBrief[];
}

/** 과거 결정 이력 상한 — 프롬프트 비대화 방지 (건당 1줄 × 이 상한). */
const MAX_DECISION_HISTORY = 12;

/**
 * 점수 보정용 — 이 repo 의 «결정/검증된» 최근 브리프 이력 (po_briefs).
 * repo_path 로 격리해 다른 레포의 결정이 새 제안을 오염시키지 않는다(멀티 프로젝트 엣지).
 * status 를 사람 결정/검증 결과 4종으로 좁혀 매핑한다(approved/running/shipped 는 모두
 * «승인됨» — 아직 검증 전). 결재/검증 시각 최신순, 상한 N건. proposed/held(미결정)는 제외.
 */
function decisionHistory(repoPath: string): PoDecisionRecord[] {
  const rows = db()
    .prepare(
      `SELECT title, impact, effort, status, verify_note, decide_reason FROM po_briefs
       WHERE repo_path = ? AND status IN ('rejected','approved','running','shipped','verified','missed')
       ORDER BY COALESCE(decided_at, updated_at) DESC LIMIT ?`,
    )
    .all(repoPath, MAX_DECISION_HISTORY) as Array<{
    title: string;
    impact: number;
    effort: number;
    status: string;
    verify_note: string | null;
    decide_reason: string | null;
  }>;
  return rows.map((r) => {
    const status: PoDecisionRecord["status"] =
      r.status === "rejected"
        ? "rejected"
        : r.status === "verified"
          ? "verified"
          : r.status === "missed"
            ? "missed"
            : "approved"; // approved / running / shipped — 사람이 승인, 아직 검증 전
    // 근거 한 줄: 검증된 행만 verify_note 가 있다. 기각/승인·옛 레코드는 없음(엣지) → 생략.
    const note = status === "verified" || status === "missed" ? r.verify_note : null;
    // 결재 사유 enum 키 — «기각» 행만 의미 있다(approve/검증/빗나감엔 사유 피커가 없다). 렌더가
    // 다시 status·키를 검증해 라벨을 붙이므로 여기선 기각 행의 원형을 그대로 싣는다(미선택은 NULL).
    const reason = status === "rejected" ? r.decide_reason : null;
    return { title: r.title, impact: r.impact, effort: r.effort, status, note, reason };
  });
}

/**
 * 점수대별 «과신 보정» 입력 — 이 repo 의 «결과가 정해진» 브리프 전체 (po_briefs).
 * decisionHistory 가 «최근 N건 한 줄 나열» 이라면 이건 «누적» 집계용이라 LIMIT 없이 결과 행
 * (rejected/verified/missed)만 거둔다. approved/running/shipped(아직 검증 전)는 결과 미정이라 제외.
 * repo_path 로 격리해 다른 레포 결과가 이 레포 새 제안을 오염시키지 않는다(수용 기준 2). 0건이면
 * 빈 배열 → 빌더가 보정 블록을 통째로 빼 기존과 byte-identical (수용 기준 1, 회귀 0). impact 만 쓰니
 * effort/title 은 안 읽는다(집계 무관). 정렬 불필요 — 집계는 합이라 행 순서에 불변(결정적).
 */
function outcomeHistory(repoPath: string): PoOutcomeRecord[] {
  const rows = db()
    .prepare(
      `SELECT impact, status FROM po_briefs
       WHERE repo_path = ? AND status IN ('rejected','verified','missed')`,
    )
    .all(repoPath) as Array<{ impact: number; status: PoOutcomeRecord["status"] }>;
  return rows.map((r) => ({ impact: r.impact, status: r.status }));
}

// ─── 닫힌 결정 «지문» 누적 보존 (po_dedup_fingerprint_v1) ──────────────────────
//
// dedupCorpus 는 MAX_DEDUP_CORPUS(60) 윈도우라, 그 밖으로 밀려난 옛 기각/출시 결정이 ingest 의
// 재제안 백스톱에서 사라진다(prompt.ts buildPoCleanupPrompt 주석이 인정하는 한계). po_dedup_fingerprints
// 는 그 그물을 «윈도우와 무관하게» 복원한다 — 닫힌 결정의 dedup-relevant 필드(제목·문제·evidence ref)만
// 추려 누적 보존하고, ingestBriefs 가 이 지문 집합도 «두 번째 코퍼스» 로 findSimilar 에 함께 건다.
// 매칭 로직은 similarity.findSimilar 를 그대로 재사용한다 — 트라이그램 + evidence ref 겹침 OR. 프롬프트에
// 박는 «재제안 금지» 목록은 비대화 방지를 위해 현행 윈도우 그대로 두고, 이 백스톱만 전체 닫힌 결정을 본다.

/**
 * 이 repo 의 닫힌 결정(rejected/shipped/verified/missed)을 po_dedup_fingerprints 로 동기화한다 —
 * 매 ingest 직전 호출해 새로 닫힌 결정의 지문을 누적하고(멱등 upsert: brief_id PK), 이미 있는 건
 * 텍스트/상태만 갱신한다. po_briefs 에서 파생하지만 «삭제는 하지 않아», 닫힌 결정이 윈도우 밖으로
 * 밀리거나 옛 브리프가 정리돼도 지문은 살아남는다(= 누적 보존). reject 는 routes/po.ts 에서 일어나
 * 이 동기화가 그것까지 (전이 위치와 무관하게) 모두 거둔다. ref 는 similarity 가 비교 시점에 구조를
 * 인식하므로 evidenceRefs 의 원형 문자열을 그대로 저장한다. 절대 throw 하지 않는다 — 지문 동기화가
 * ingest 본류를 죽이지 않게 (persistCollectSignals 와 동일 정책).
 */
function syncClosedFingerprints(repoPath: string): void {
  try {
    const rows = db()
      .prepare(
        `SELECT id, title, problem, evidence, status FROM po_briefs
         WHERE repo_path = ? AND status IN ('rejected','shipped','verified','missed')`,
      )
      .all(repoPath) as Array<{
      id: string;
      title: string;
      problem: string;
      evidence: string;
      status: string;
    }>;
    if (rows.length === 0) return;
    const now = Date.now();
    const upsert = db().prepare(
      `INSERT INTO po_dedup_fingerprints (brief_id, repo_path, title, problem, refs, status, created_at, updated_at)
       VALUES (@brief_id, @repo_path, @title, @problem, @refs, @status, @now, @now)
       ON CONFLICT(brief_id) DO UPDATE SET
         title = excluded.title, problem = excluded.problem, refs = excluded.refs,
         status = excluded.status, updated_at = excluded.updated_at`,
    );
    // 한 트랜잭션으로 묶어 ingest 핫패스의 쓰기 락 경합을 줄인다 (created_at 은 INSERT 때만 박혀
    // 보존, DO UPDATE 는 건드리지 않는다 — 최초 기록 시각 유지).
    db().transaction((items: typeof rows) => {
      for (const r of items) {
        upsert.run({
          brief_id: r.id,
          repo_path: repoPath,
          title: r.title,
          problem: r.problem,
          refs: JSON.stringify(evidenceRefs(r.evidence)),
          status: r.status,
          now,
        });
      }
    })(rows);
  } catch (e) {
    console.warn(`[po] sync fingerprints failed repo=${repoPath}:`, (e as Error).message);
  }
}

/**
 * 재제안 백스톱이 조회할 닫힌 결정 지문 — findSimilar 가 바로 쓰는 {title, problem, refs} 형태로
 * 돌려준다. missed 는 «제외» 한다(윈도우 코퍼스의 missed 제외 정책과 동형: missed 는 «미해결 갭/재시도
 * 후보» 라 같은 주제의 «다른 접근» 을 하드 컷하면 안 된다). 지문 표 자체는 missed 도 보존하되 조회에서만
 * 뺀다. 실패 시 [] — 백스톱이 죽어도 ingest 는 계속.
 */
function loadClosedFingerprints(
  repoPath: string,
): Array<{ title: string; problem: string; refs: string[] }> {
  try {
    const rows = db()
      .prepare(
        `SELECT title, problem, refs FROM po_dedup_fingerprints
         WHERE repo_path = ? AND status != 'missed'`,
      )
      .all(repoPath) as Array<{ title: string; problem: string; refs: string }>;
    return rows.map((r) => {
      let refs: string[] = [];
      try {
        const parsed = JSON.parse(r.refs);
        if (Array.isArray(parsed)) refs = parsed.filter((x): x is string => typeof x === "string");
      } catch {
        /* 깨진 refs — 빈 목록 (트라이그램 신호만 쓴다) */
      }
      return { title: r.title, problem: r.problem, refs };
    });
  } catch (e) {
    console.warn(`[po] load fingerprints failed repo=${repoPath}:`, (e as Error).message);
    return [];
  }
}

/**
 * 수집을 시작하고 «즉시» 반환 — iOS 가 sessionId 로 진행을 관전할 수 있다.
 * settle → ingest → 알림은 백그라운드에서 진행. 절대 throw 하지 않는다.
 * `instruction` — 사용자의 대략적 지시 (선택). 있으면 그것을 중심으로 브리프를 만든다.
 * `agentIdRaw` — 수집을 돌릴 코드 에이전트 (po_agent_v1). 생략(옛 클라이언트/주기 수집)은
 * claude_code. 무인 실행이라 cron 픽커와 같은 «cron_eligible» 군이 전제.
 * `lens` — 수집 «전문가 관점» (po_collect_lens_v1). "design" 이면 코드 기회 대신 UI 디자인 부채를
 * 디자인 SSOT 대비로 발굴(옛 designer 페르소나와 동치), "bug" 면 디버깅·신뢰성 신호를 우선 모은다.
 * 생략(주기 수집/옛 클라이언트)이면 프로필의 저장된 렌즈(po_profiles.lens)로 폴백 — 회차 인자가
 * 프로필보다 우선한다 (instruction↔directive 와 동형). 프로필도 비면 "default"(전방위 수집).
 * `locale` — 산출 언어 (po_locale_v1, 선택). iOS 가 실은 «앱 표시 언어». 지원 집합의 비-ko 면
 * 브리프 산출을 그 언어로 쓰게 프롬프트에 지시가 붙는다. 생략(주기 수집/옛 클라이언트)/ko/미지원은
 * 한국어 산출(byte-identical) — route 에서 normalizePoLocale 로 이미 정규화돼 들어온다.
 * `trigger` — "scheduled"(PoScheduler tick) | "manual"(라우트의 «지금 수집», 기본). 예약만 결말을
 * persist + 무인 알림한다 (po_scheduled_status_v1) — 수동은 화면 앞 사용자라 통지가 잡음(AC4).
 */
export function startPoCollection(
  repoPathRaw: string,
  instruction?: string,
  agentIdRaw?: string,
  lens?: PoLens,
  locale?: string,
  trigger: "manual" | "scheduled" = "manual",
): PoCollectResult {
  const dir = resolveAndEnsureRepoDir(repoPathRaw);
  if ("error" in dir) return { status: "error", error: dir.error };
  const repoPath = dir.path;

  // 수집은 도구 사용(gh/grep/git)이 많아 권한 자동 승인 PTY 가 전제.
  const agentId = agentIdRaw || "claude_code";
  if (!hasAgent(agentId)) {
    return { status: "error", error: `에이전트 없음: ${agentId}` };
  }
  // 무인 trifecta(capability_caps C1/M3) — PO 수집은 skip_permissions 무인 세션이다. repo 에
  // EGRESS·SOURCE_WRITE MCP 가 연결돼 있으면 시작 전 정적 거부(개인-데이터+외부통신 동시 불가).
  const guard = guardUnattendedRepo(repoPath);
  if (!guard.ok) return { status: "error", error: `${guard.code}: ${guard.capped.join(", ")}` };

  // 매 수집을 시각으로 구별 — 안 그러면 세션 목록이 죄다 "📋 PO 신호 수집" 한 이름이 된다.
  const sessionId = createSession(
    repoPath,
    `📋 PO 신호 수집 · ${collectStamp(new Date())}`,
    undefined,
    true,
    agentId,
  );
  const outFile = path.join(os.tmpdir(), `ps-po-briefs-${sessionId}.json`);
  const verdictFile = path.join(os.tmpdir(), `ps-po-verdicts-${sessionId}.json`);
  // 프로젝트별 «조사 방식» 프로필 — 있으면 표준 지침으로 프롬프트에 들어간다 (재사용 자산).
  // asc_app_id 는 스토어 리뷰 신호 켬 표시 — finalize 가 fetch 해 프롬프트에 첨부한다.
  // github_feedback_repo 가 있으면 GitHub 신호 분기가 로컬 origin 대신 그 repo 를 읽는다.
  const profileRow = db()
    .prepare(
      `SELECT directive, asc_app_id, github_feedback_repo, design_directive, lens FROM po_profiles WHERE repo_path = ?`,
    )
    .get(repoPath) as
    | {
        directive: string;
        asc_app_id: string | null;
        github_feedback_repo: string | null;
        design_directive: string | null;
        lens: string | null;
      }
    | undefined;
  // 렌즈 — 회차 인자(수동 수집의 일회성 선택)가 있으면 그것을, 없으면(주기 수집/옛 클라이언트)
  // 프로필에 저장된 렌즈로 폴백한다 (회차 > 프로필, instruction↔directive 와 동형). parseLens 로
  // 옛 row/이상값/NULL 은 "default"(전방위)로 안전 폴백.
  const collectLens: PoLens = lens ?? parseLens(profileRow?.lens);
  // 출시 후 검증 대상 — shipped 브리프의 가설을 이 수집 사이클이 대조한다 (§3.5).
  const shippedBriefs = db()
    .prepare(
      `SELECT id, title, problem FROM po_briefs WHERE repo_path = ? AND status = 'shipped' ORDER BY updated_at ASC LIMIT 10`,
    )
    .all(repoPath) as Array<{ id: string; title: string; problem: string }>;
  const promptOpts = {
    repoPath,
    outFile,
    existingBriefs: dedupCorpus(repoPath),
    instruction,
    profileDirective: profileRow?.directive,
    shippedBriefs,
    verdictFile,
    // 과거 결정 요약 — 점수·방향을 사람의 누적 평가에 맞춰 보정 (이 repo 이력만, N건 상한).
    decisionHistory: decisionHistory(repoPath),
    // 점수대별 과신 보정 — 이 repo 결과(기각/적중/빗나감) 전체를 영향도 점수대로 결정적 집계.
    // 0건이면 빌더가 블록을 빼 기존과 byte-identical. repo_path 격리 (다른 레포 오염 방지).
    outcomeHistory: outcomeHistory(repoPath),
    // GitHub 피드백 repo — 있으면 GitHub 신호를 로컬 origin 이 아니라 이 repo 에서 읽는다.
    githubFeedbackRepo: profileRow?.github_feedback_repo ?? undefined,
    // 디자인 컨텍스트 선언 — 있으면 「디자인 제약」 섹션에 그대로, 없으면 자동 발견으로 폴백.
    designDirective: profileRow?.design_directive ?? undefined,
    // 렌즈 — "design" 면 디자인 부채 발굴, "bug" 면 디버깅·신뢰성 우선. 생략/그 외는 기본 전방위 수집.
    lens: collectLens,
    // 산출 언어 — iOS 가 실은 앱 표시 언어. 비-ko 지원 로케일이면 브리프를 그 언어로 산출하게
    // 지시가 붙는다. 누락(주기 수집/옛 클라이언트)/ko/미지원은 한국어 산출(byte-identical).
    locale,
  };

  console.log(`[po] collect start session=${sessionId} repo=${repoPath} agent=${agentId}`);
  void finalizeCollection(
    sessionId,
    repoPath,
    outFile,
    verdictFile,
    promptOpts,
    agentId,
    profileRow?.asc_app_id ?? null,
    trigger,
  ).catch((e) =>
    console.warn(`[po] finalize failed session=${sessionId}:`, (e as Error).message),
  );
  return { status: "running", sessionId, agentId };
}

/**
 * (선택) 크래시 집계 fetch → 임시 JSON 파일. 리뷰와 같은 게이트(asc_app_id)·같은 정책 —
 * 실패/데이터 없음은 섹션을 생략하되 그 «종류»(used/off/empty/key_missing/auth/app_id/network)를
 * state 로 함께 돌려 수집 결과에 surface 한다. 첫 활성화 직후엔 ASC 보고서가 아직 생성 중이라
 * 비어 있는 게 정상(empty) — 진짜 실패(auth/app_id/network)와 구분된다.
 */
async function prepareCrashSignals(
  ascAppId: string | null,
  crashFile: string,
): Promise<{
  data?: { file: string; totalCrashes: number; from: string; to: string };
  state: SignalSourceState;
}> {
  if (!ascAppId) return { state: { state: "off" } };
  const asc = readConfig()?.asc;
  if (!asc) return { state: { state: "key_missing" } };
  try {
    const digest = await fetchCrashDigest(asc, ascAppId);
    if (!digest || digest.totalCrashes === 0) {
      // 데이터 0 — 첫 활성화 직후 Apple 보고서 생성 대기 등 «정상 빈-상태» (degradation 아님).
      console.log(`[po] crash: 집계 데이터 없음 — 섹션 생략 app=${ascAppId}`);
      return { state: { state: "empty" } };
    }
    fs.writeFileSync(crashFile, JSON.stringify(digest, null, 1), { mode: 0o600 });
    console.log(
      `[po] crash: ${digest.totalCrashes}건 (${digest.from}~${digest.to}) 첨부 app=${ascAppId}`,
    );
    return {
      data: { file: crashFile, totalCrashes: digest.totalCrashes, from: digest.from, to: digest.to },
      state: { state: "used", count: digest.totalCrashes },
    };
  } catch (e) {
    const kind = classifyAscFailure(e);
    console.warn(`[po] crash: 집계 fetch 실패(${kind}) — 섹션 생략: ${(e as Error).message}`);
    return { state: { state: kind } };
  }
}

/**
 * (선택) 스토어 리뷰 fetch → 임시 JSON 파일. 실패/0건은 섹션을 생략하되, 그 «종류» 를 state 로
 * 함께 돌려 수집 결과(알림/카드)에 실어 보낸다 (키 만료·네트워크가 수집을 죽이면 주기 수집이
 * 조용히 멎으므로 수집 자체는 안 막는다 — 다만 무음 강등은 surface 한다).
 */
async function prepareStoreReviews(
  ascAppId: string | null,
  reviewsFile: string,
): Promise<{ data?: { file: string; count: number }; state: SignalSourceState }> {
  if (!ascAppId) return { state: { state: "off" } };
  const asc = readConfig()?.asc;
  if (!asc) {
    console.warn(`[po] asc: 리뷰 수집이 켜져 있지만 API 키 미설정 — 섹션 생략`);
    return { state: { state: "key_missing" } };
  }
  try {
    const reviews = await fetchCustomerReviews(asc, ascAppId, MAX_ASC_REVIEWS);
    if (reviews.length === 0) {
      console.log(`[po] asc: 리뷰 0건 — 섹션 생략 app=${ascAppId}`);
      return { state: { state: "empty" } };
    }
    fs.writeFileSync(reviewsFile, JSON.stringify(reviews, null, 1), { mode: 0o600 });
    console.log(`[po] asc: 리뷰 ${reviews.length}건 첨부 app=${ascAppId}`);
    return { data: { file: reviewsFile, count: reviews.length }, state: { state: "used", count: reviews.length } };
  } catch (e) {
    const kind = classifyAscFailure(e);
    console.warn(`[po] asc: 리뷰 fetch 실패(${kind}) — 섹션 생략: ${(e as Error).message}`);
    return { state: { state: kind } };
  }
}

/**
 * 한 생성 패스 — 완료 구독 → 프롬프트 발사 → 정착 대기 → PTY 회수. settle 상태를 돌려준다.
 * cron finalizeRun 의 «단일 턴» 과 동형이며, 다중 패스는 같은 세션에서 이 함수를 순차로 N회
 * 돌린다(매 패스가 PTY 를 새로 띄워 종료 → 직전 패스 맥락 없는 «독립» 생성). 항상 resolve.
 */
async function runCollectPass(
  sessionId: string,
  repoPath: string,
  agentId: string,
  prompt: string,
): Promise<{ status: "ok" | "error" | "timeout"; error?: string }> {
  const settle = waitForSessionSettle(sessionId);
  void runUserMessagePty(
    { sessionId, cwd: repoPath, adapter: getAgent(agentId) },
    prompt,
    { bypassPermissions: true },
  ).catch((e) => {
    console.warn(`[po] runUserMessagePty failed session=${sessionId}:`, (e as Error).message);
  });
  const result = await settle;
  abortPtySession(sessionId);
  await awaitPtyExit(sessionId, 4000);
  return result;
}

/** 여러 패스 상태를 하나로 — 하나라도 ok 면 ok, 아니면 error 우선, 그다음 마지막(=timeout) 상태. */
function combinePassStatuses(
  statuses: ReadonlyArray<{ status: "ok" | "error" | "timeout"; error?: string }>,
): { status: "ok" | "error" | "timeout"; error?: string } {
  if (statuses.some((s) => s.status === "ok")) return { status: "ok" };
  return statuses.find((s) => s.status === "error") ?? statuses[statuses.length - 1] ?? { status: "timeout" };
}

/** 프롬프트 발사 → settle → PTY 회수 → 브리프 ingest + 검증 판정 적용 → 알림. cron finalizeRun 과 동형. */
async function finalizeCollection(
  sessionId: string,
  repoPath: string,
  outFile: string,
  verdictFile: string,
  promptOpts: Omit<Parameters<typeof buildPoCollectPrompt>[0], "storeReviews" | "crashSignals">,
  agentId: string,
  ascAppId: string | null,
  // "scheduled" 면 결말을 persist + 무인 알림(po_scheduled_status_v1), "manual" 이면 둘 다 안 한다(AC4).
  trigger: "manual" | "scheduled",
): Promise<void> {
  // 수집 중 일반 turn_complete 알림 억제 — 끝에 po 전용 알림 한 번만.
  markCronSession(sessionId);
  collectingRepos.add(repoPath);
  const reviewsFile = path.join(os.tmpdir(), `ps-po-reviews-${sessionId}.json`);
  const crashFile = path.join(os.tmpdir(), `ps-po-crashes-${sessionId}.json`);
  // 다중 패스 합치 채택 설정 — 미설정/passes===1 이면 기존 단일 패스 경로(회귀 0).
  const { passes, minAgree } = resolvePoMultiPass(readConfig());
  const lens = promptOpts.lens ?? "default";
  // 패스별 산출 파일 — 단일 패스는 기존 outFile 그대로(회귀 0), 다중은 .pN 접미로 분리(서로 덮지 않게).
  const passFiles =
    passes === 1 ? [outFile] : Array.from({ length: passes }, (_, i) => `${outFile}.p${i + 1}`);
  try {
    // 프롬프트는 신호 fetch «후» 에 빌드 — 실패 시 섹션 자체가 없어 에이전트가 헛 경로를 안 읽는다.
    const [store, crash] = await Promise.all([
      prepareStoreReviews(ascAppId, reviewsFile),
      prepareCrashSignals(ascAppId, crashFile),
    ]);
    const signals: CollectSignals = { store: store.state, crash: crash.state };
    // 신호원 실행 상태를 수집 세션별로 persist — iOS 백로그가 GET /collect/last 로 읽어 카드를 띄운다.
    persistCollectSignals(repoPath, sessionId, signals);
    const prompt = buildPoCollectPrompt({
      ...promptOpts,
      storeReviews: store.data,
      crashSignals: crash.data,
    });
    // 단일 패스(passes===1)면 기존과 동일하게 한 번만 발사. 다중 패스면 패스별 산출 파일을 쓰도록
    // outFile 만 바꿔 프롬프트를 다시 빌드해 N회 «독립» 발사한다(각 패스는 PTY 를 새로 띄움).
    const statuses: Array<{ status: "ok" | "error" | "timeout"; error?: string }> = [];
    for (let i = 0; i < passFiles.length; i++) {
      const passPrompt =
        passes === 1
          ? prompt
          : buildPoCollectPrompt({
              ...promptOpts,
              outFile: passFiles[i],
              storeReviews: store.data,
              crashSignals: crash.data,
            });
      if (passes > 1) {
        console.log(`[po] collect pass ${i + 1}/${passes} session=${sessionId}`);
      }
      statuses.push(await runCollectPass(sessionId, repoPath, agentId, passPrompt));
    }
    const result = combinePassStatuses(statuses);

    const endedAt = Date.now();
    db()
      .prepare(`UPDATE sessions SET status = ?, ended_at = ? WHERE id = ?`)
      .run(result.status === "error" ? "error" : "completed", endedAt, sessionId);

    // 산출 파일은 «쓰였으면 거둔다» — settle 가 ok 가 아니어도(turn_complete 미검출, 또는 느린
    // 에이전트가 MAX_RUNTIME_MS(30분) 상한을 쳐 timeout) 에이전트가 이미 쓴 유효 브리프를 버리지
    // 않는다. 옛 «status===ok 일 때만 ingest» 게이트는 산출 파일이 멀쩡해도 통째로 버려 «수집했는데
    // 브리프 0건» 을 만들었다 (산출 파일만 /tmp 에 잔존·미-ingest). xhigh effort 처럼 한 턴이 길어지는
    // 설정에선 settle 상한을 넘기기 쉬워 이 유실이 자주 난다. ingestBriefs/ingestVerdicts 는 파일 없음/
    // 깨진 JSON/부분 산출에 모두 안전([] / 0)이라 status 무관하게 거둬도 손해가 없다.
    let insertedIds: string[];
    if (passes === 1) {
      insertedIds = ingestBriefs(sessionId, repoPath, outFile, undefined, lens);
    } else {
      // 다중 패스 합치 채택 — 패스별 draft 를 모아, 의미상 같은 기회로 minAgree(실효) 패스 이상에
      // 반복 등장한 것만 채택한 뒤 기존 dedup 게이트(ingestParsedDrafts)에 통과시킨다. 한 패스만
      // 성공해도 graceful fallback(consensus 가 임계를 산출 있는 패스 수로 캡), 전부 실패면 빈 산출.
      const passDrafts = passFiles.map((f) => parseBriefDrafts(f));
      const consensus = selectConsensusBriefs(passDrafts, minAgree);
      // 채택/탈락 사유 로그 — 디버깅용(수용 기준 4).
      console.log(
        `[po] consensus session=${sessionId} passes=${passes}(out:${consensus.passesWithOutput}) minAgree=${minAgree}(eff:${consensus.effectiveMinAgree}) adopted=${consensus.adopted.length} rejected=${consensus.rejected.length}`,
      );
      for (const r of consensus.rejected) {
        console.log(
          `[po] consensus reject (agree ${r.agree}/${consensus.effectiveMinAgree}): «${r.brief.title}»`,
        );
      }
      for (const a of consensus.adopted) {
        console.log(`[po] consensus adopt: «${a.title}»`);
      }
      insertedIds = ingestParsedDrafts(sessionId, repoPath, consensus.adopted, undefined, lens);
    }
    const verdicts = ingestVerdicts(repoPath, verdictFile);
    console.log(
      `[po] collect done session=${sessionId} status=${result.status} briefs=${insertedIds.length} verdicts=${verdicts} signals=store:${signals.store.state}/crash:${signals.crash.state}`,
    );
    // 예약 수집만 결말을 표면화한다 (수동 «지금 수집» 은 화면 앞 사용자라 통지가 중복·잡음 — AC4).
    // 브리프를 실제로 거뒀으면 «성공(new)» — settle 가 timeout 이어도 산출이 도착한 건 사실이라
    // status 를 ok 로 맞춰 «새 제안» 결말이 되게 한다. 0건이면 settle 결과 그대로(ok→empty, 에러/
    // timeout→failed). recordScheduledCollectOutcome 가 persist(항상) + 폭주 억제 알림을 맡는다.
    if (trigger === "scheduled") {
      // void(fire-and-forget) — persist 는 recordScheduledCollectOutcome 의 첫 await «앞» 에서
      // 동기로 끝나므로 결말 기록은 보장되고, Discord POST 가 finally 의 /tmp 정리를 막지 않는다
      // (기존 `void dispatchPoNotification` 와 같은 비차단 의미). 절대 throw 안 함(내부 try/catch).
      void recordScheduledCollectOutcome({
        repoPath,
        sessionId,
        status: insertedIds.length > 0 ? "ok" : result.status,
        briefCount: insertedIds.length,
        briefId: insertedIds.length === 1 ? insertedIds[0] : undefined,
        errorSummary: result.error,
        signals,
      });
    }
  } finally {
    unmarkCronSession(sessionId);
    collectingRepos.delete(repoPath);
    // 산출 파일은 ingest 성공/실패와 무관하게 정리 (비밀 아님 — /tmp 잔존 방지).
    for (const f of [...passFiles, verdictFile, reviewsFile, crashFile]) {
      try {
        fs.rmSync(f, { force: true });
      } catch {
        /* best-effort */
      }
    }
  }
}

/** impact/effort 정수 1~5 로 클램프 (비숫자는 중간값 3). */
function clamp(v: unknown): number {
  const n = typeof v === "number" ? Math.round(v) : NaN;
  return Number.isFinite(n) ? Math.min(5, Math.max(1, n)) : 3;
}
/** 문자열 필드 정규화 — trim + 길이 cap. 비문자열은 "". */
function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

/** 산출 객체 하나 → 검증된 브리프 필드. 필수(제목/문제/스펙/근거) 미달이면 null. */
export function parseBriefDraft(item: unknown): {
  title: string;
  problem: string;
  evidence: string; // JSON string
  impact: number;
  effort: number;
  score: number;
  scope: string;
  spec: string;
  /** 에이전트 자가 중복 분류 — ingest 하이브리드 게이트의 1차 신호. 없으면 "new" 취급. */
  dedupRelation?: "new" | "refinement" | "duplicate";
} | null {
  const b = item as Partial<PoBriefDraft>;
  // title 의 200 은 «하드 안전 백스톱» 이다 — 비정상 거대 제목이 DB/UI 를 깨지 않게 자르는 cap 이지
  // «선언» 이 아니다. 프롬프트(messages.collect 의 모든 로케일)가 선언하는 «권고 한계» 는 80 자
  // (readability.TITLE_ADVISORY_MAX) 이고, 초과는 ingestBriefs 가 readability 로 «소프트 경고» 한다
  // (자르지 않음 — 기존 cap 동작 보존). 둘은 목적이 달라 공존한다(80=선언/권고, 200=하드 백스톱).
  const title = str(b.title, 200);
  const problem = str(b.problem, 4000);
  const spec = str(b.spec, 16000);
  // 근거 필수 — evidence 가 비면 «상상 제안» 으로 보고 버린다 (백로그 신뢰 콜드스타트 보호).
  const evidence = Array.isArray(b.evidence)
    ? b.evidence
        .filter((e) => e && typeof e === "object")
        .map((e) => ({
          kind: str((e as Record<string, unknown>).kind, 40) || "unknown",
          ref: str((e as Record<string, unknown>).ref, 400),
          summary: str((e as Record<string, unknown>).summary, 400),
        }))
        .filter((e) => e.ref || e.summary)
        .slice(0, 10)
    : [];
  if (!title || !problem || !spec || evidence.length === 0) return null;
  const impact = clamp(b.impact);
  const effort = clamp(b.effort);
  // dedup 자가분류 — 알 수 없는 값은 무시(undefined → "new" 취급). 산출 신뢰의 1차 신호일 뿐,
  // 최종 컷은 lexical 백스톱이 함께 본다(에이전트가 "new" 로 잘못 분류해도 텍스트가 닮으면 컷).
  const rel = b.dedup?.relation;
  const dedupRelation =
    rel === "duplicate" || rel === "refinement" || rel === "new" ? rel : undefined;
  return {
    title,
    problem,
    evidence: JSON.stringify(evidence),
    impact,
    effort,
    score: Math.round((impact / effort) * 100) / 100,
    scope: str(b.scope, 2000) || "—",
    spec,
    dedupRelation,
  };
}

/** parseBriefDraft 의 산출 — 검증·정규화된 브리프 1건. */
export type ParsedBriefDraft = NonNullable<ReturnType<typeof parseBriefDraft>>;

/** 산출 JSON 을 검증해 po_briefs 에 넣는다. 깨진 원소는 건너뛴다. 넣은 브리프 id 배열 반환. */
/**
 * 산출 JSON 파일 → 검증된 브리프 draft 목록. 파일 없음/깨진 JSON/비배열은 빈 목록(안전).
 * 옛 ingestBriefs 의 «읽기·파싱·검증» 단계만 분리한 것 — MAX_BRIEFS_PER_RUN 상한·깨진 원소 스킵
 * 동작 그대로(회귀 0). 다중 패스 생성은 패스별로 이 함수를 돌려 draft 배열을 모은 뒤 합치 채택한다.
 */
export function parseBriefDrafts(outFile: string): ParsedBriefDraft[] {
  let raw: string;
  try {
    raw = fs.readFileSync(outFile, "utf8");
  } catch {
    console.warn(`[po] 산출 파일 없음 — 에이전트가 ${outFile} 를 쓰지 않음`);
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.warn(`[po] 산출 JSON 파싱 실패:`, (e as Error).message);
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const drafts: ParsedBriefDraft[] = [];
  for (const item of (parsed as unknown[]).slice(0, MAX_BRIEFS_PER_RUN)) {
    const draft = parseBriefDraft(item);
    if (draft) drafts.push(draft);
  }
  return drafts;
}

/** 산출 JSON 을 검증해 po_briefs 에 넣는다. 깨진 원소는 건너뛴다. 넣은 브리프 id 배열 반환. */
export function ingestBriefs(
  sessionId: string,
  repoPath: string,
  outFile: string,
  researchId?: string,
  // 이 배치를 «쓴 전문가» 렌즈 (po_brief_lens_v1) — 수집(collectLens)/리서치(research.lens)가 고른 값.
  // 생략/전방위는 'default' → iOS 카드 배지 숨김(회귀 0). 호출부가 명시 전달한다.
  lens: PoLens = "default",
): string[] {
  return ingestParsedDrafts(sessionId, repoPath, parseBriefDrafts(outFile), researchId, lens);
}

/**
 * 검증된 draft 목록을 dedup 게이트(에이전트 자가분류 + lexical/ref 백스톱 + 닫힌 결정 지문)에
 * 통과시켜 po_briefs 에 넣는다. 넣은 id 배열 반환. ingestBriefs(단일 패스)와 다중 패스 합치 채택이
 * 공유하는 «삽입» 단계 — 파일 읽기/파싱만 호출부가 달리한다(여기 dedup 동작은 양쪽 동일).
 */
export function ingestParsedDrafts(
  sessionId: string,
  repoPath: string,
  drafts: readonly ParsedBriefDraft[],
  researchId?: string,
  lens: PoLens = "default",
): string[] {
  // 하이브리드 dedup — ① 에이전트 자가분류(dedupRelation==="duplicate" 면 컷) + ② 결정적
  // lexical 백스톱(findSimilar). 비교 코퍼스엔 닫힌 결정(기각/출시)·살아있는 제안은 넣어 재제안을
  // 막고, 이번 배치에 넣은 것도 누적해 배치-내 중복까지 거른다. 옛 «제목 완전일치» 는 lexical(완전일치
  // → score 1.0)이 포함하므로 제거.
  // 백스톱은 «제목/문제 트라이그램» 과 «evidence ref 겹침» 을 OR 로 본다(similarity.findSimilar) —
  // 제목·문구는 다르게 썼지만 같은 파일:라인/같은 이슈를 가리키는 의미-중복도 ref 신호로 잡는다.
  // 그래서 코퍼스에 evidence 의 ref 목록도 함께 싣는다(인식 못 한 ref 는 트라이그램으로 폴백).
  // 단 «빗나감(missed)» 은 백스톱에서 «뺀다» — missed 는 닫힌 결정이 아니라 «미해결 갭/재시도 후보»라,
  // 같은 주제를 «다른 접근» 으로 다루는 새 브리프가 lexical 유사도로 하드 컷되면 안 된다(프롬프트가
  // missed 분기를 별도 안내해 «같은 접근 반복» 만 빼게 한다). 살아있는 동일 주제 제안은 여전히 코퍼스에
  // 남아 우선하므로 «살아있는 앵커 > missed 분기» 가 유지된다.
  const corpus: Array<{ title: string; problem: string; refs: string[] }> = dedupCorpus(repoPath)
    .filter((b) => b.status !== "missed")
    .map((b) => ({
      title: b.title,
      problem: b.problem,
      refs: evidenceRefs(b.evidence),
    }));
  // ③ 닫힌 결정 «지문» 백스톱 — dedupCorpus 는 N건(MAX_DEDUP_CORPUS) 윈도우라 그 밖으로 밀려난 옛
  // 기각/출시 결정을 못 막는다. 매 ingest 직전 닫힌 결정을 지문으로 동기화한 뒤, «윈도우와 무관한»
  // 전체 닫힌 결정을 두 번째 코퍼스로 findSimilar 에 함께 걸어 옛 재제안까지 컷한다(missed 제외).
  syncClosedFingerprints(repoPath);
  const closedFingerprints = loadClosedFingerprints(repoPath);
  const now = Date.now();
  const insertedIds: string[] = [];
  const insert = db().prepare(
    `INSERT INTO po_briefs (id, repo_path, title, problem, evidence, impact, effort, score, scope, spec, status, created_at, updated_at, collect_session_id, research_id, lens)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?, ?, ?, ?)`,
  );

  for (const draft of drafts) {
    // ① 에이전트가 스스로 «기존과 같은 기회» 라고 분류한 건 신뢰하고 컷.
    if (draft.dedupRelation === "duplicate") {
      console.log(`[po] dedup skip (agent=duplicate): ${draft.title}`);
      continue;
    }
    // ② lexical 백스톱 — 자가분류가 놓쳤어도 ⓐ 거의 같은 텍스트거나 ⓑ 같은 evidence ref(파일:라인/
    // 이슈)면 컷 (코퍼스 + 이번 배치 누적). reason 으로 어느 신호가 걸렸는지 로그에 남긴다.
    const draftRefs = evidenceRefs(draft.evidence);
    const hit = findSimilar({ title: draft.title, problem: draft.problem, refs: draftRefs }, corpus);
    if (hit) {
      const why = hit.reason === "ref" ? "ref" : `lexical ${hit.score.toFixed(2)}`;
      console.log(`[po] dedup skip (${why}): «${draft.title}» ≈ «${hit.item.title}»`);
      continue;
    }
    // ③ 닫힌 결정 지문 백스톱 — 윈도우 밖 옛 기각/출시까지 (trigram 또는 evidence ref 겹침으로 컷).
    const fpHit = findSimilar(
      { title: draft.title, problem: draft.problem, refs: draftRefs },
      closedFingerprints,
    );
    if (fpHit) {
      const why = fpHit.reason === "ref" ? "ref" : `lexical ${fpHit.score.toFixed(2)}`;
      console.log(`[po] dedup skip (closed ${why}): «${draft.title}» ≈ «${fpHit.item.title}»`);
      continue;
    }
    // 가독성 «소프트» 게이트 — 차단/감점/재작성이 아니라 «표면화» 다. 통과한(INSERT 될) 브리프의
    // 제목·problem 이 다시 빽빽해졌는지(80자 초과·파일경로/심볼·«—» 다중 절·코드로 시작) 결정적
    // 휴리스틱으로 보고, 후보가 있으면 수집 세션 로그에 한 줄 남긴다. 기존 길이 cap·dedup 동작은 불변.
    const readability = analyzeBriefReadability({ title: draft.title, problem: draft.problem });
    if (readability.length > 0) {
      console.warn(`[po] readability «${draft.title}»: ${formatReadabilitySignals(readability)}`);
    }
    const id = randomUUID();
    insert.run(
      id,
      repoPath,
      draft.title,
      draft.problem,
      draft.evidence,
      draft.impact,
      draft.effort,
      draft.score,
      draft.scope,
      draft.spec,
      now,
      now,
      sessionId,
      researchId ?? null,
      lens,
    );
    corpus.push({ title: draft.title, problem: draft.problem, refs: draftRefs });
    insertedIds.push(id);
  }
  return insertedIds;
}

/**
 * 출시 후 검증 판정 ingest — verdictFile 의 [{id, verdict, note}] 를 읽어
 * shipped → verified|missed 전이를 적용한다. shipped 가 아닌(또는 다른 repo 의) id 는
 * 무시 — 에이전트 산출을 그대로 믿지 않는다. 적용한 개수 반환. 파일 없음 = 판정 없음(0).
 */
export function ingestVerdicts(repoPath: string, verdictFile: string): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(verdictFile, "utf8"));
  } catch {
    return 0;
  }
  if (!Array.isArray(parsed)) return 0;

  const now = Date.now();
  const update = db().prepare(
    `UPDATE po_briefs SET status = ?, verify_note = ?, updated_at = ?
     WHERE id = ? AND repo_path = ? AND status = 'shipped'`,
  );
  let applied = 0;
  for (const item of parsed as unknown[]) {
    const v = item as Record<string, unknown>;
    const id = str(v.id, 80);
    const verdict = str(v.verdict, 20);
    if (!id || (verdict !== "verified" && verdict !== "missed")) continue;
    const info = update.run(verdict, str(v.note, 1000) || null, now, id, repoPath);
    if (info.changes > 0) {
      applied += 1;
      console.log(`[po] verify ${verdict} brief=${id}`);
    }
  }
  return applied;
}

/**
 * 승인된 브리프의 구현 세션을 감시 — 첫 turn 이 정상 정착하면 running → shipped 전이.
 * 이후 «출시 후 검증» 사이클(다음 수집)이 가설을 대조해 verified/missed 로 종결한다.
 * 구현 세션은 사용자가 관전/개입하는 일반 세션이라 PTY 회수는 하지 않는다 — 상태 전이만.
 * 에러/타임아웃이면 running 유지 (사용자가 세션에서 직접 수습할 수 있게).
 */
export function watchExecForShipped(briefId: string, sessionId: string): void {
  void waitForSessionSettle(sessionId)
    .then((result) => {
      if (result.status !== "ok") {
        console.warn(`[po] exec session settle=${result.status} brief=${briefId} — running 유지`);
        return;
      }
      const info = db()
        .prepare(
          `UPDATE po_briefs SET status = 'shipped', updated_at = ? WHERE id = ? AND status = 'running'`,
        )
        .run(Date.now(), briefId);
      if (info.changes > 0) console.log(`[po] brief shipped id=${briefId} session=${sessionId}`);
    })
    .catch((e) => console.warn(`[po] shipped watch failed brief=${briefId}:`, (e as Error).message));
}

// ─── 리서치 요청 (주제 기반 시장 조사 → 보고서 + 브리프) ─────────────────────

export type PoResearchResult =
  | { status: "running"; researchId: string; sessionId: string; agentId: string }
  | { status: "error"; error: string };

/**
 * 리서치를 시작하고 «즉시» 반환 — 사용자가 sessionId 로 조사 과정을 관전할 수 있다.
 * 보고서/브리프 ingest 는 백그라운드. 절대 throw 하지 않는다.
 * `agentIdRaw` — 조사를 돌릴 코드 에이전트 (po_agent_v1). 생략은 claude_code.
 * `lens` — «전문가 관점» 렌즈 (po_research_lens_v1). "design"/"bug" 면 프롬프트에 렌즈별 머리말을
 * 주입하고 po_research.lens 에 기록한다(보고서 머리 칩으로 노출). 생략/"default"(옛 클라이언트)는
 * 전방위 — 머리말 없이 기존 리서치와 동일.
 * `scope` — 조사 범위 (po_research_scope_v1). 생략/"web_repo" 면 웹+레포(기존), "repo_only" 면
 *   웹 검색을 끄고 레포 근거만으로 보고서·브리프를 쓴다(lens 와 직교 — 함께 적용). 옛 클라이언트는 안 보냄 → 웹+레포.
 * `screens` — UX 렌즈 «화면 포함» (po_research_ux_screens_v1). ux 렌즈에서만 의미 — true 면
 *   프롬프트에 «렌더된 화면을 캡처해 그 화면으로 휴리스틱을 판정» 하는 블록을 추가한다(화면 못
 *   얻으면 코드+웹으로 graceful fallback). 생략/false·ux 외 렌즈면 프롬프트가 byte-identical (회귀 0).
 * `locale` — 산출 언어 (po_locale_v1, 선택). 비-ko 지원 로케일이면 보고서·브리프를 그 언어로
 *   산출하게 지시가 붙는다. 생략(옛 클라이언트)/ko/미지원은 한국어 산출(byte-identical).
 */
export function startPoResearch(
  repoPathRaw: string,
  topic: string,
  agentIdRaw?: string,
  lens: PoLens = "default",
  scope?: "web_repo" | "repo_only",
  screens?: boolean,
  locale?: string,
): PoResearchResult {
  const dir = resolveAndEnsureRepoDir(repoPathRaw);
  if ("error" in dir) return { status: "error", error: dir.error };
  const repoPath = dir.path;
  const agentId = agentIdRaw || "claude_code";
  if (!hasAgent(agentId)) return { status: "error", error: `에이전트 없음: ${agentId}` };
  // 무인 trifecta(capability_caps C1/M3) — 리서치도 skip_permissions 무인 세션.
  const rGuard = guardUnattendedRepo(repoPath);
  if (!rGuard.ok) return { status: "error", error: `${rGuard.code}: ${rGuard.capped.join(", ")}` };

  const researchId = randomUUID();
  const sessionId = createSession(
    repoPath,
    `🔍 리서치: ${topic}`.slice(0, 120),
    undefined,
    true,
    agentId,
  );
  const reportFile = path.join(os.tmpdir(), `ps-po-report-${sessionId}.md`);
  const briefsFile = path.join(os.tmpdir(), `ps-po-research-briefs-${sessionId}.json`);
  // 디자인 컨텍스트 선언 — 수집과 동형. 있으면 「디자인 제약」 섹션에 그대로, 없으면 자동 발견.
  const designDirective = (
    db()
      .prepare(`SELECT design_directive FROM po_profiles WHERE repo_path = ?`)
      .get(repoPath) as { design_directive: string | null } | undefined
  )?.design_directive;
  const prompt = buildPoResearchPrompt({
    repoPath,
    topic,
    reportFile,
    briefsFile,
    existingBriefs: dedupCorpus(repoPath),
    // 과거 결정 요약 — 수집과 «같은» decisionHistory(repoPath) 헬퍼로 이 repo 이력만(다른 레포
    // 결정이 새 제안을 오염시키지 않게, repo_path 격리) 최근 N건을 채워 넘긴다. 리서치산 브리프도
    // 수집산과 같은 백로그·같은 30초 결재를 받으니 점수를 사람의 누적 평가에 맞춰 보정한다.
    decisionHistory: decisionHistory(repoPath),
    // 점수대별 과신 보정 — 수집과 동형. 이 repo 결과 전체를 점수대로 결정적 집계 (repo_path 격리).
    outcomeHistory: outcomeHistory(repoPath),
    designDirective: designDirective ?? undefined,
    lens,
    scope,
    screens,
    // 산출 언어 — 비-ko 지원 로케일이면 보고서·브리프를 그 언어로. 누락/ko/미지원은 한국어(회귀 0).
    locale,
  });

  const now = Date.now();
  db()
    .prepare(
      `INSERT INTO po_research (id, repo_path, topic, lens, status, session_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'running', ?, ?, ?)`,
    )
    .run(researchId, repoPath, topic, lens, sessionId, now, now);

  console.log(
    `[po] research start id=${researchId} session=${sessionId} repo=${repoPath} agent=${agentId} lens=${lens} scope=${scope ?? "web_repo"} screens=${screens === true}`,
  );
  void finalizeResearch(
    researchId,
    sessionId,
    repoPath,
    reportFile,
    briefsFile,
    prompt,
    agentId,
    lens,
  ).catch(
    (e) => console.warn(`[po] research finalize failed id=${researchId}:`, (e as Error).message),
  );
  return { status: "running", researchId, sessionId, agentId };
}

/** 리서치 세션 settle → 보고서 저장 + 브리프 ingest → 상태 종결 + 알림. */
async function finalizeResearch(
  researchId: string,
  sessionId: string,
  repoPath: string,
  reportFile: string,
  briefsFile: string,
  prompt: string,
  agentId: string,
  // 이 리서치를 «쓴 전문가» 렌즈 — 브리프에 직접 박아 카드가 JOIN 없이 배지를 띄운다 (po_research.lens 와 동치).
  lens: PoLens,
): Promise<void> {
  markCronSession(sessionId);
  try {
    const settle = waitForSessionSettle(sessionId);
    void runUserMessagePty(
      { sessionId, cwd: repoPath, adapter: getAgent(agentId) },
      prompt,
      { bypassPermissions: true },
    ).catch((e) => {
      console.warn(`[po] research runUserMessagePty failed session=${sessionId}:`, (e as Error).message);
    });
    const result = await settle;

    abortPtySession(sessionId);
    await awaitPtyExit(sessionId, 4000);

    const endedAt = Date.now();
    db()
      .prepare(`UPDATE sessions SET status = ?, ended_at = ? WHERE id = ?`)
      .run(result.status === "error" ? "error" : "completed", endedAt, sessionId);

    // 보고서 — 없으면(조기 실패) 빈 채로 실패 처리. 브리프 0건은 정당한 결과 («하지 마라» 결론).
    let report = "";
    try {
      report = fs.readFileSync(reportFile, "utf8").trim().slice(0, 200_000);
    } catch {
      /* 보고서 미산출 */
    }
    // 보고서가 «쓰였으면» 완료로 본다 — settle 가 ok 가 아니어도(turn_complete 미검출/timeout)
    // 에이전트가 이미 쓴 보고서·브리프를 버리지 않는다 (수집 finalize 와 동형). 조기 실패로 보고서
    // 자체가 없을 때만 failed. ingestBriefs 는 파일 없음/깨진 JSON 에 [] 로 안전.
    const ok = report.length > 0;
    const insertedIds = ok ? ingestBriefs(sessionId, repoPath, briefsFile, researchId, lens) : [];

    db()
      .prepare(
        `UPDATE po_research SET status = ?, report = ?, brief_count = ?, updated_at = ? WHERE id = ?`,
      )
      .run(ok ? "done" : "failed", report || null, insertedIds.length, endedAt, researchId);
    console.log(
      `[po] research done id=${researchId} status=${ok ? "done" : "failed"} briefs=${insertedIds.length}`,
    );

    // 알림 — 브리프 0건이어도 보고서가 결과물이므로 (수집과 달리) 완료를 알린다.
    // 세션 삭제 «전» 에 await — 알림이 세션 row(repo_path)를 읽기 때문 (절대 throw 안 함).
    await dispatchPoNotification({
      sessionId,
      status: ok ? "ok" : "error",
      briefCount: Math.max(insertedIds.length, ok ? 1 : 0),
      briefId: insertedIds.length === 1 ? insertedIds[0] : undefined,
    });
    // 성공한 리서치의 세션은 자동 제거 — 보고서(po_research.report)가 영구 산출물이라
    // 세션 transcript 는 잔해고, 사용자가 세션 탭에서 매번 수동 삭제해야 했다. 실패는
    // 세션을 남긴다 — transcript 가 유일한 진단 단서.
    if (ok) deleteResearchSession(researchId, sessionId);
  } finally {
    unmarkCronSession(sessionId);
    for (const f of [reportFile, briefsFile]) {
      try {
        fs.rmSync(f, { force: true });
      } catch {
        /* best-effort */
      }
    }
  }
}

/**
 * 성공한 리서치의 세션 행 제거 — DELETE /api/sessions/:id 와 같은 정리(workflow_node_runs
 * 참조 끊기 + messages/approvals CASCADE)를 트랜잭션으로 수행하고, po_research.session_id
 * 도 함께 끊는다 (지워진 세션을 가리키는 dangling 참조 방지 — iOS 는 done 리서치를
 * researchId 로만 연다). PTY 는 finalizeResearch 가 이미 abort + exit 대기를 끝낸 뒤다.
 */
function deleteResearchSession(researchId: string, sessionId: string): void {
  db().transaction(() => {
    db()
      .prepare(`UPDATE workflow_node_runs SET session_id = NULL WHERE session_id = ?`)
      .run(sessionId);
    db().prepare(`UPDATE po_research SET session_id = NULL WHERE id = ?`).run(researchId);
    db().prepare(`DELETE FROM sessions WHERE id = ?`).run(sessionId);
  })();
  console.log(`[po] research session removed research=${researchId} session=${sessionId}`);
}

// ─── 수정 지시 (재종합) ───────────────────────────────────────────────────────

export type PoReviseResult =
  | { status: "running"; sessionId: string }
  | { status: "error"; error: string };

/**
 * 브리프 «수정 지시» 재종합을 시작하고 «즉시» 반환. 갱신은 백그라운드 —
 * po_briefs.revising_session_id 가 진행 중 표시이고, 끝나면 NULL 로 돌아온다.
 * `locale` — 산출 언어 (po_locale_v1, 선택). 비-ko 지원 로케일이면 갱신본을 그 언어로 재종합하게
 * 지시가 붙는다(원형이 한국어여도 앱 언어로). 생략/ko/미지원은 한국어 산출(byte-identical).
 */
export function startPoRevision(briefId: string, comment: string, locale?: string): PoReviseResult {
  const row = db().prepare(`SELECT * FROM po_briefs WHERE id = ?`).get(briefId) as
    | {
        id: string;
        repo_path: string;
        title: string;
        problem: string;
        evidence: string;
        impact: number;
        effort: number;
        scope: string;
        spec: string;
      }
    | undefined;
  if (!row) return { status: "error", error: "브리프 없음" };

  const dir = resolveAndEnsureRepoDir(row.repo_path);
  if ("error" in dir) return { status: "error", error: dir.error };
  if (!hasAgent("claude_code")) return { status: "error", error: "에이전트 없음: claude_code" };
  // 무인 trifecta(capability_caps C1/M3) — 브리프 수정 재종합도 skip_permissions 무인 세션.
  const revGuard = guardUnattendedRepo(dir.path);
  if (!revGuard.ok) return { status: "error", error: `${revGuard.code}: ${revGuard.capped.join(", ")}` };

  const sessionId = createSession(
    dir.path,
    `📋 수정: ${row.title}`.slice(0, 120),
    undefined,
    true,
    "claude_code",
  );
  const outFile = path.join(os.tmpdir(), `ps-po-revise-${sessionId}.json`);
  const prompt = buildPoRevisePrompt({ brief: row, comment, outFile, locale });

  const now = Date.now();
  db()
    .prepare(`UPDATE po_briefs SET revising_session_id = ?, updated_at = ? WHERE id = ?`)
    .run(sessionId, now, briefId);

  console.log(`[po] revise start brief=${briefId} session=${sessionId}`);
  void finalizeRevision(briefId, sessionId, dir.path, outFile, prompt).catch((e) =>
    console.warn(`[po] revise finalize failed brief=${briefId}:`, (e as Error).message),
  );
  return { status: "running", sessionId };
}

/** 재종합 세션 settle → 갱신본 ingest (UPDATE) → revising 표시 해제. */
async function finalizeRevision(
  briefId: string,
  sessionId: string,
  repoPath: string,
  outFile: string,
  prompt: string,
): Promise<void> {
  markCronSession(sessionId);
  try {
    const settle = waitForSessionSettle(sessionId);
    void runUserMessagePty(
      { sessionId, cwd: repoPath, adapter: getAgent("claude_code") },
      prompt,
      { bypassPermissions: true },
    ).catch((e) => {
      console.warn(`[po] revise runUserMessagePty failed session=${sessionId}:`, (e as Error).message);
    });
    const result = await settle;

    abortPtySession(sessionId);
    await awaitPtyExit(sessionId, 4000);

    const endedAt = Date.now();
    db()
      .prepare(`UPDATE sessions SET status = ?, ended_at = ? WHERE id = ?`)
      .run(result.status === "error" ? "error" : "completed", endedAt, sessionId);

    // 갱신본도 «쓰였으면 적용» — settle 가 ok 가 아니어도(turn_complete 미검출/timeout) 에이전트가
    // 이미 쓴 재종합 결과를 버리지 않는다 (수집/리서치 finalize 와 동형). 파일 없음/깨진 JSON 은
    // 아래 try/catch 가 흡수해 원형 유지 — status 게이트 없이도 안전.
    let applied = false;
    try {
      const draft = parseBriefDraft(JSON.parse(fs.readFileSync(outFile, "utf8")));
      if (draft) {
        db()
          .prepare(
            `UPDATE po_briefs SET title = ?, problem = ?, evidence = ?, impact = ?, effort = ?, score = ?, scope = ?, spec = ?, updated_at = ? WHERE id = ?`,
          )
          .run(
            draft.title,
            draft.problem,
            draft.evidence,
            draft.impact,
            draft.effort,
            draft.score,
            draft.scope,
            draft.spec,
            endedAt,
            briefId,
          );
        applied = true;
      }
    } catch (e) {
      console.warn(`[po] revise ingest failed brief=${briefId}:`, (e as Error).message);
    }
    console.log(`[po] revise done brief=${briefId} status=${result.status} applied=${applied}`);
  } finally {
    // 성공/실패 무관 진행 표시 해제 — 실패 시 브리프는 원형 그대로 남는다.
    db()
      .prepare(`UPDATE po_briefs SET revising_session_id = NULL, updated_at = ? WHERE id = ?`)
      .run(Date.now(), briefId);
    unmarkCronSession(sessionId);
    try {
      fs.rmSync(outFile, { force: true });
    } catch {
      /* best-effort */
    }
  }
}

// ─── 디자인 부트스트랩 (design_directive 초안 자동 작성) ─────────────────────────

/** 디자인 directive 초안 길이 cap — routes/po.ts 의 design_directive cap(4000)과 일치. */
const DESIGN_DIRECTIVE_MAX = 4000;

export type PoDesignBootstrapResult =
  | { status: "running"; sessionId: string }
  | { status: "error"; error: string };

/**
 * 디자인 «부트스트랩» 을 시작하고 «즉시» 반환 (po_design_bootstrap_v1). 디자이너 에이전트가 이
 * 레포의 디자인 SSOT(토큰/테마·i18n 카탈로그·디자인 문서)를 스캔해 design_directive 마크다운
 * «초안» 을 만든다. 초안은 po_profiles.design_directive_draft 에 들어갈 뿐 — 사람이 설정 화면에서
 * 승인해야 비로소 design_directive(선언된 강신호)가 된다(자동 적용 금지). 절대 throw 하지 않는다.
 * 이미 생성 중이면(초안 세션 살아 있음) error 로 막아 세션을 orphan 시키지 않는다.
 */
export function startPoDesignBootstrap(
  repoPathRaw: string,
  agentIdRaw?: string,
  locale?: string,
): PoDesignBootstrapResult {
  const dir = resolveAndEnsureRepoDir(repoPathRaw);
  if ("error" in dir) return { status: "error", error: dir.error };
  const repoPath = dir.path;
  const agentId = agentIdRaw || "claude_code";
  if (!hasAgent(agentId)) return { status: "error", error: `에이전트 없음: ${agentId}` };
  // 무인 trifecta(capability_caps C1/M3) — 디자인 부트스트랩도 skip_permissions 무인 세션.
  const dbGuard = guardUnattendedRepo(repoPath);
  if (!dbGuard.ok) return { status: "error", error: `${dbGuard.code}: ${dbGuard.capped.join(", ")}` };

  // 이미 «생성 중» 이면 막는다 — 두 번 누르면 새 세션이 옛 세션 id 를 덮어써 추적 불능이 된다.
  const running = (
    db()
      .prepare(`SELECT design_directive_draft_session_id FROM po_profiles WHERE repo_path = ?`)
      .get(repoPath) as { design_directive_draft_session_id: string | null } | undefined
  )?.design_directive_draft_session_id;
  if (running) return { status: "error", error: "이미 초안을 생성하고 있어요" };

  // 디자인 SSOT 스캔은 grep/ls 등 도구 사용이 많아 권한 자동 승인 PTY 가 전제 (수집과 동형).
  const sessionId = createSession(
    repoPath,
    t("design.bootstrap.sessionLabel", poLoc(locale)),
    undefined,
    true,
    agentId,
  );
  const outFile = path.join(os.tmpdir(), `ps-po-design-${sessionId}.md`);
  const prompt = buildPoDesignBootstrapPrompt({ repoPath, outFile, locale });

  // «생성 중» 표시 — 초안 세션 id 를 둔다(아직 초안 없음). 프로필 row 가 없으면 directive='' 로
  // 만든다(NOT NULL). 기존 design_directive/초안은 건드리지 않는다 (생성 실패해도 옛 값 보존).
  const now = Date.now();
  db()
    .prepare(
      `INSERT INTO po_profiles (repo_path, directive, design_directive_draft_session_id, updated_at)
       VALUES (?, '', ?, ?)
       ON CONFLICT(repo_path) DO UPDATE SET design_directive_draft_session_id = excluded.design_directive_draft_session_id, updated_at = excluded.updated_at`,
    )
    .run(repoPath, sessionId, now);

  console.log(`[po] design bootstrap start session=${sessionId} repo=${repoPath} agent=${agentId}`);
  void finalizeDesignBootstrap(sessionId, repoPath, outFile, prompt, agentId).catch((e) =>
    console.warn(`[po] design bootstrap finalize failed session=${sessionId}:`, (e as Error).message),
  );
  return { status: "running", sessionId };
}

/** 부트스트랩 세션 settle → 산출 markdown 을 초안 컬럼에 저장 → «생성 중» 해제. */
async function finalizeDesignBootstrap(
  sessionId: string,
  repoPath: string,
  outFile: string,
  prompt: string,
  agentId: string,
): Promise<void> {
  markCronSession(sessionId);
  try {
    const settle = waitForSessionSettle(sessionId);
    void runUserMessagePty(
      { sessionId, cwd: repoPath, adapter: getAgent(agentId) },
      prompt,
      { bypassPermissions: true },
    ).catch((e) => {
      console.warn(
        `[po] design bootstrap runUserMessagePty failed session=${sessionId}:`,
        (e as Error).message,
      );
    });
    const result = await settle;

    abortPtySession(sessionId);
    await awaitPtyExit(sessionId, 4000);

    const endedAt = Date.now();
    db()
      .prepare(`UPDATE sessions SET status = ?, ended_at = ? WHERE id = ?`)
      .run(result.status === "error" ? "error" : "completed", endedAt, sessionId);

    // 산출 markdown — 성공 + 파일 있을 때만. trim/cap 후 초안 컬럼에 둔다(자동 적용 아님).
    let draft = "";
    if (result.status === "ok") {
      try {
        draft = fs.readFileSync(outFile, "utf8").trim().slice(0, DESIGN_DIRECTIVE_MAX);
      } catch {
        /* 산출 파일 없음 (조기 실패) */
      }
    }
    if (draft.length > 0) {
      db()
        .prepare(
          `UPDATE po_profiles SET design_directive_draft = ?, design_directive_draft_session_id = NULL, design_directive_draft_at = ?, updated_at = ? WHERE repo_path = ?`,
        )
        .run(draft, endedAt, endedAt, repoPath);
      console.log(
        `[po] design bootstrap draft ready session=${sessionId} repo=${repoPath} chars=${draft.length}`,
      );
    } else {
      // 실패/빈 산출 — «생성 중» 표시만 해제하고 초안은 비운 채로 둔다(검토 UI 가 다시 «생성» 으로).
      db()
        .prepare(
          `UPDATE po_profiles SET design_directive_draft_session_id = NULL, updated_at = ? WHERE repo_path = ?`,
        )
        .run(endedAt, repoPath);
      console.warn(
        `[po] design bootstrap produced no draft session=${sessionId} status=${result.status}`,
      );
    }
  } finally {
    unmarkCronSession(sessionId);
    try {
      fs.rmSync(outFile, { force: true });
    } catch {
      /* best-effort */
    }
  }
}
