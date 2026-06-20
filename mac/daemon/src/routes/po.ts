// `/api/po/*` — PO 루프 (기회 브리프 백로그). iOS 백로그 탭이 소비한다.
//
//   GET    /briefs?repoPath=…     브리프 목록 (옵션: repo 필터). score·생성순 정렬은 클라이언트.
//   GET    /stats?repoPath=…      누적 성적표 (po_stats_v1) — 승인율·verified/missed·결재 중앙값.
//   POST   /collect { repoPath, agent?, lens?, persona? }  수집 시작 — 즉시 sessionId 반환, ingest
//          는 백그라운드. lens="design"|"bug" (po_collect_lens_v1) | "security" (po_collect_lens_v2)
//          면 «전문가 관점» 으로 수집한다 — design 은 코드 기회 대신 UI 디자인 부채를 발굴(옛
//          persona="designer" 와 동치), bug 는 디버깅·신뢰성, security 는 인증·키 취급·노출면·자격증명·
//          위협모델 신호를 우선 모은다. 옛 클라이언트의 persona="designer" 는 design 으로 매핑.
//   POST   /briefs/:id/decide { action, useWorktree?, agent?, mode? } — approve(→실행 세션 spawn·running) | hold | reject.
//          useWorktree=true 면 새 worktree(`po/<id8>` 브랜치)를 만들어 그 안에서 구현 —
//          동시 세션 간 작업트리 충돌 방지 (po_worktree_v1).
//   POST   /briefs/:id/restart { agent? } — 진행 중(running) 브리프의 «구현 다시 시작»
//          (po_exec_restart_v1). 죽은 구현 세션을 같은 브리프·결재 컨텍스트 보존한 채 새 세션으로
//          교체(exec_session_id 만 바뀌고 status 는 running 유지). 워크플로우 모드는 범위 밖.
//   POST   /briefs/:id/cleanup { agent? } — 기각(rejected)된 브리프의 «코드 흔적 정리» 세션
//          spawn (po_cleanup_v1). 근거의 TODO/죽은 코드를 지워 다음 수집의 재제안을 막는다.
//          mode="workflow" (po_workflow_v1) 면 단일 세션 대신 설계 에이전트가 브리프 맞춤
//          DAG(스펙→구현→자가검증→사람 게이트)를 만들어 워크플로우 run 으로 실행한다.
//   DELETE /briefs/:id            처리 끝난 브리프 정리.

import { Hono } from "hono";
import { bearerAuth } from "../auth.js";
import { db } from "../db/index.js";
import { hasAgent, getAgent } from "../agent/registry.js";
import { runUserMessagePty } from "../agent/pty-runner.js";
import { createSession, resolveAndEnsureRepoDir } from "../routes/sessions.js";
import {
  startPoCollection,
  startPoResearch,
  startPoRevision,
  startPoDesignBootstrap,
  watchExecForShipped,
} from "../persona/executor.js";
import { startPoWorkflowApproval } from "../persona/workflow-exec.js";
import { parseLens } from "../persona/lens.js";
import { checkGhForCollect } from "../persona/gh.js";
import { checkAscForCollect } from "../persona/asc-check.js";
import { parseSignals } from "../persona/signals.js";
import { getPoScheduler } from "../persona/scheduler.js";
import { validateSchedule } from "../cron/schedule.js";
import { buildPoExecPrompt, buildPoCleanupPrompt, normalizePoLocale } from "../persona/prompt.js";
import { createWorktree } from "../git/worktree.js";
import { validateAscKey, verifyAscConnection } from "../persona/asc.js";
import { readConfig, writeConfig, type AscConfig } from "../config.js";

export const po = new Hono();
po.use("*", bearerAuth);

type PoBriefRow = {
  id: string;
  repo_path: string;
  title: string;
  problem: string;
  evidence: string;
  impact: number;
  effort: number;
  score: number;
  scope: string;
  spec: string;
  status: string;
  created_at: number;
  updated_at: number;
  decided_at: number | null;
  decide_reason: string | null;
  decide_note: string | null;
  collect_session_id: string | null;
  exec_session_id: string | null;
  revising_session_id: string | null;
  research_id: string | null;
  verify_note: string | null;
  cleanup_session_id: string | null;
  exec_workflow_id: string | null;
  exec_run_id: string | null;
  exec_note: string | null;
  exec_agent_id: string | null;
  cleanup_agent_id: string | null;
  /** 이 브리프를 «쓴 전문가» 렌즈 (po_brief_lens_v1) — po_research.lens 와 같은 집합. 옛 row 는 DEFAULT 'default'. */
  lens: string;
};

type PoResearchRow = {
  id: string;
  repo_path: string;
  topic: string;
  report: string | null;
  status: string;
  session_id: string | null;
  brief_count: number;
  created_at: number;
  updated_at: number;
  /** «전문가 관점» 렌즈 (po_research_lens_v1~v9) — 'default'(전방위)|'design'|'bug'(디버깅)|'qa'|'security'(보안)|'pm'(기획)|'marketing'(마케팅)|'analytics'(분석)|'ops'(운영)|'logic'(로직)|'ux'(UX·사용성). 옛 row 는 DEFAULT 'default'. */
  lens: string;
};

/** 목록용 — report 본문 제외 (수십 KB 가 될 수 있어 상세에서만). */
function researchToApi(row: PoResearchRow, withReport: boolean): Record<string, unknown> {
  return {
    id: row.id,
    repoPath: row.repo_path,
    topic: row.topic,
    status: row.status,
    sessionId: row.session_id,
    briefCount: row.brief_count,
    // 어느 «전문가 관점» 으로 조사했는지 — iOS 가 보고서 머리/행에 칩으로 노출 (default 면 칩 숨김).
    lens: row.lens ?? "default",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(withReport ? { report: row.report ?? "" } : {}),
  };
}

/** DB row → API shape (camelCase + evidence 파싱). */
function toApi(row: PoBriefRow): Record<string, unknown> {
  let evidence: unknown = [];
  try {
    evidence = JSON.parse(row.evidence);
  } catch {
    /* 깨진 evidence 는 빈 배열로 — 행 자체는 살린다 */
  }
  return {
    id: row.id,
    repoPath: row.repo_path,
    title: row.title,
    problem: row.problem,
    evidence,
    impact: row.impact,
    effort: row.effort,
    score: row.score,
    scope: row.scope,
    spec: row.spec,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    decidedAt: row.decided_at,
    decideReason: row.decide_reason,
    decideNote: row.decide_note,
    collectSessionId: row.collect_session_id,
    execSessionId: row.exec_session_id,
    revisingSessionId: row.revising_session_id,
    researchId: row.research_id,
    verifyNote: row.verify_note,
    cleanupSessionId: row.cleanup_session_id,
    execWorkflowId: row.exec_workflow_id,
    execRunId: row.exec_run_id,
    execNote: row.exec_note,
    execAgentId: row.exec_agent_id,
    cleanupAgentId: row.cleanup_agent_id,
    // 이 브리프를 «쓴 전문가» — iOS 카드가 배지로 노출 (default 면 배지 숨김). 옛 row/누락은 'default'.
    lens: row.lens ?? "default",
  };
}

// 보류/기각 사유 태그 (po_decide_reason_v1) — 고정 enum 키 집합. iOS 가 1탭으로 고르고,
// daemon 은 «허용 키만» 저장한다 (자유서술 강제 없음 — 미선택은 NULL). 후속 사유 집계의 원천.
const DECIDE_REASONS = new Set([
  "priority_low", // 우선순위 낮음
  "scope_too_big", // 범위 과대
  "already_exists", // 이미 있음
  "weak_evidence", // 근거 약함
  "wrong_direction", // 방향 안 맞음
]);

/** body.reason 검증 — 허용 키면 그 키, 아니면(미선택·이상값) null. 마찰 없이 떨군다. */
function parseDecideReason(v: unknown): string | null {
  return typeof v === "string" && DECIDE_REASONS.has(v) ? v : null;
}

/** body.note 검증 — 선택적 자유 메모 한 줄. 빈/비-문자열은 null, 과대 입력은 500자 cap. */
function parseDecideNote(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length === 0 ? null : t.slice(0, 500);
}

po.get("/briefs", (c) => {
  const repoPath = c.req.query("repoPath");
  const rows = (
    repoPath
      ? db()
          .prepare(`SELECT * FROM po_briefs WHERE repo_path = ? ORDER BY created_at DESC LIMIT 200`)
          .all(repoPath)
      : db().prepare(`SELECT * FROM po_briefs ORDER BY created_at DESC LIMIT 200`).all()
  ) as PoBriefRow[];
  return c.json({ briefs: rows.map(toApi) });
});

// ─── 누적 성적표 (po_stats_v1) ───────────────────────────────────────────────
// 설계 문서의 성공 지표(승인율 / 승인→shipped 처리량 / 결재까지 시간)를 po_briefs 의
// 상태·시각만으로 산출한다 — 별도 이벤트 로그 없이 «출시 후 검증으로 신뢰를 쌓는 구조» 의
// 누적 성적을 보여주는 데이터원. iOS 백로그 상단 성적표 카드가 소비한다.

/** 한 «차원 값» 의 결재 분해 (po_stats_breakdown_v1) — 승인된 적 있음 / 기각. 둘의 합이 결재 수. */
type PoStatsCell = { approved: number; rejected: number };

/** 한 «차원 값» 의 출시 후 검증 결과 분해 (po_outcome_breakdown_v1) — 검증됨 / 빗나감. 둘의 합이 검증 수. */
type PoOutcomeCell = { verified: number; missed: number };

type PoStatsBucket = {
  /** 전체 제안 수 — 모든 브리프는 proposed 로 시작하므로 행 수 그대로. */
  proposed: number;
  /** «승인된 적 있는» 수 — approve 는 running→shipped→verified/missed 로 흘러가므로 상태 집합으로 센다. */
  approved: number;
  rejected: number;
  /** 출시까지 간 수 (shipped 이후 — verified/missed 포함). */
  shipped: number;
  verified: number;
  missed: number;
  /** approved / (approved + rejected). 결정이 없으면 null — 0% 와 «데이터 없음» 을 구분한다. */
  approvalRate: number | null;
  /** 제안 → 결재(승인/보류/기각)까지 걸린 시간의 중앙값(초). decided_at 없는 과거 행은 제외. */
  medianDecisionSeconds: number | null;
  // ─── 차원별 승인/기각 분해 (po_stats_breakdown_v1) ─────────────────────────
  // «기각이 어디에 몰리는지» 를 이미 가진 차원으로 분해한다. 톱레벨 합산은 «불변» —
  // 아래 셀들은 부가 산출이며 셀들의 합이 proposed 와 같을 필요는 없다(차원에 따라
  // 한 브리프가 복수 키에 들거나(evidence) 한 키에도 안 들 수 있다(lens 없는 수집産)).
  /** 노력(effort 1~5) 구간별 — low(1~2)·mid(3)·high(4~5). 각 브리프가 «정확히 하나» 의 구간. */
  byEffort: { low: PoStatsCell; mid: PoStatsCell; high: PoStatsCell };
  /** 근거(evidence) 종류별 — 한 브리프의 «서로 다른» kind 마다 한 번 집계(중복 kind 는 1회). */
  byEvidence: Record<string, PoStatsCell>;
  /** 리서치 «전문가 관점»(po_research.lens)별 — research_id 가 가리키는 렌즈. 수집產(렌즈 없음)은 제외. */
  byLens: Record<string, PoStatsCell>;
  // ─── 차원별 출시 후 검증 결과 분해 (po_outcome_breakdown_v1) ───────────────
  // shipped 이후 verified/missed 판정을 effort·렌즈로 분해 — «어떤 베팅이 더 자주 빗나가는지».
  // 톱레벨 verified/missed 합산과 «같은» 원천(EVER_SHIPPED 상태). 구 daemon 미지원 → 옵셔널.
  /** 노력(effort) 구간별 출시 후 검증 — low(1~2)·mid(3)·high(4~5). 검증 0인 구간은 생략. */
  outcomeByEffort?: Record<string, PoOutcomeCell>;
  /** 리서치 «전문가 관점»(lens)별 출시 후 검증 — 리서치産만. 수집産(렌즈 없음)은 제외. */
  outcomeByLens?: Record<string, PoOutcomeCell>;
  /** 근거(evidence) 종류별 출시 후 검증 — byEvidence 와 같은 distinctEvidenceKinds 원천. 검증 0이면 생략. */
  outcomeByEvidence?: Record<string, PoOutcomeCell>;
  /** 보류/기각 사유별 건수 (po_decide_reason_v2) — rejected/held 만 집계. 5개 enum 키 + none(decide_reason NULL). approve 는 제외. */
  byReason: Record<string, number>;
};

type PoStatsRow = Pick<PoBriefRow, "repo_path" | "status" | "created_at" | "decided_at"> & {
  effort: number;
  /** JSON 배열 [{kind, ...}] — evidence 종류 분해의 원천. 깨졌으면 빈 배열로 안전 폴백. */
  evidence: string;
  /** po_research.lens (LEFT JOIN) — 리서치産만 non-null, 수집産은 null. */
  lens: string | null;
  /** 보류/기각 사유 (po_decide_reason_v1) — rejected/held 브리프의 사유 태그. approve/proposed 는 null. */
  decide_reason: string | null;
};

/** 출시 후 검증 사유 한 줄 — verified/missed 중 verify_note 가 있는 행만. 성적표 상세의
 * «검증 사유» 섹션이 «왜 빗나갔나» 패턴을 한눈에 보여주는 데이터원 (po_verify_notes_v1). */
type PoVerifyNote = {
  id: string;
  /** "verified" | "missed" — iOS 가 success/danger 색을 고르는 신호. */
  status: string;
  note: string;
  /** 판정 시각(ms). decided_at 없는 과거 행은 updated_at 으로 폴백 정렬용. */
  decidedAt: number | null;
};

/** 최근 검증 사유를 동봉할 최대 건수 — 상세 시트가 «요약» 이라 과거 전체가 아닌 최근 N 건만. */
const VERIFY_NOTES_LIMIT = 30;

/** approve 이후 도달 가능한 상태 — «승인된 적 있음» 판정용. */
const EVER_APPROVED = new Set(["approved", "running", "shipped", "verified", "missed"]);
const EVER_SHIPPED = new Set(["shipped", "verified", "missed"]);

/** 한 차원 셀에 결재 결과 1건을 더한다 — 톱레벨 approved/rejected 와 «같은» 판정(EVER_APPROVED/rejected). */
function bumpCell(cell: PoStatsCell, status: string): void {
  if (EVER_APPROVED.has(status)) cell.approved++;
  else if (status === "rejected") cell.rejected++;
}

/** 한 차원 셀에 출시 후 검증 결과 1건을 더한다 — verified/missed 만 대상. shipped 직후는 제외. */
function bumpOutcomeCell(cell: PoOutcomeCell, status: string): void {
  if (status === "verified") cell.verified++;
  else if (status === "missed") cell.missed++;
}

/** evidence JSON 에서 «서로 다른» kind 집합을 뽑는다. 깨진 JSON·비배열·빈 kind 는 무시. */
function distinctEvidenceKinds(raw: string): string[] {
  let arr: unknown;
  try {
    arr = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const set = new Set<string>();
  for (const e of arr) {
    const k = (e as Record<string, unknown> | null)?.kind;
    if (typeof k === "string" && k.trim()) set.add(k.trim());
  }
  return [...set];
}

function computePoStats(rows: PoStatsRow[]): PoStatsBucket {
  let approved = 0;
  let rejected = 0;
  let shipped = 0;
  let verified = 0;
  let missed = 0;
  const decisionSeconds: number[] = [];
  const byEffort = {
    low: { approved: 0, rejected: 0 },
    mid: { approved: 0, rejected: 0 },
    high: { approved: 0, rejected: 0 },
  };
  const byEvidence: Record<string, PoStatsCell> = {};
  const byLens: Record<string, PoStatsCell> = {};
  // 출시 후 검증 결과 분해 (po_outcome_breakdown_v1) — verified/missed 전용.
  const outcomeByEffort = {
    low: { verified: 0, missed: 0 },
    mid: { verified: 0, missed: 0 },
    high: { verified: 0, missed: 0 },
  };
  const outcomeByLens: Record<string, PoOutcomeCell> = {};
  const outcomeByEvidence: Record<string, PoOutcomeCell> = {};
  // byReason 집계 — 5개 enum 키 + none(NULL). rejected/held 만 집계. approve 는 제외.
  const byReason: Record<string, number> = {
    priority_low: 0,
    scope_too_big: 0,
    already_exists: 0,
    weak_evidence: 0,
    wrong_direction: 0,
    none: 0,
  };
  for (const r of rows) {
    if (EVER_APPROVED.has(r.status)) approved++;
    if (r.status === "rejected") rejected++;
    if (EVER_SHIPPED.has(r.status)) shipped++;
    if (r.status === "verified") verified++;
    if (r.status === "missed") missed++;
    // 결재 시각 — held 도 결재 행동이라 포함 (응답 속도 지표). 시계 역행 행은 버린다.
    if (r.decided_at != null && r.decided_at >= r.created_at) {
      decisionSeconds.push((r.decided_at - r.created_at) / 1000);
    }
    // 차원 분해 — effort 구간(정확히 한 칸), evidence 종류(서로 다른 kind마다), 렌즈(있을 때만).
    const eff = r.effort <= 2 ? "low" : r.effort >= 4 ? "high" : "mid";
    bumpCell(byEffort[eff], r.status);
    // 출시 후 검증 분해 — verified/missed 만 집계 (shipped 직후는 제외).
    if (r.status === "verified" || r.status === "missed") {
      bumpOutcomeCell(outcomeByEffort[eff], r.status);
      if (r.lens) {
        bumpOutcomeCell((outcomeByLens[r.lens] ??= { verified: 0, missed: 0 }), r.status);
      }
    }
    for (const kind of distinctEvidenceKinds(r.evidence)) {
      bumpCell((byEvidence[kind] ??= { approved: 0, rejected: 0 }), r.status);
      // 출시 후 검증 분해 — verified/missed 만, 서로 다른 kind 마다 1회 (byEvidence 와 동일 원천).
      if (r.status === "verified" || r.status === "missed") {
        bumpOutcomeCell((outcomeByEvidence[kind] ??= { verified: 0, missed: 0 }), r.status);
      }
    }
    if (r.lens) bumpCell((byLens[r.lens] ??= { approved: 0, rejected: 0 }), r.status);
    // 기각 사유 집계 — rejected/held 만, approve 는 제외 (사유가 무의미).
    if (r.status === "rejected" || r.status === "held") {
      const reason = r.decide_reason;
      // 허용 enum 이면 그 키로, 아니면(NULL·이상값) none 으로 집계.
      if (reason && DECIDE_REASONS.has(reason)) {
        byReason[reason]++;
      } else {
        byReason.none++;
      }
    }
  }
  const decided = approved + rejected;
  decisionSeconds.sort((a, b) => a - b);
  const mid = decisionSeconds.length >> 1;
  const median =
    decisionSeconds.length === 0
      ? null
      : decisionSeconds.length % 2
        ? decisionSeconds[mid]
        : (decisionSeconds[mid - 1] + decisionSeconds[mid]) / 2;
  // 출시 후 검증 분해 — 검증 건수 0인 차원은 필드 생략 (노이즈 방지).
  const cleanedOutcomeByEffort: Record<string, PoOutcomeCell> = {};
  for (const [k, v] of Object.entries(outcomeByEffort)) {
    if ((v.verified ?? 0) + (v.missed ?? 0) > 0) cleanedOutcomeByEffort[k] = v;
  }
  const cleanedOutcomeByLens: Record<string, PoOutcomeCell> = {};
  for (const [k, v] of Object.entries(outcomeByLens)) {
    if ((v.verified ?? 0) + (v.missed ?? 0) > 0) cleanedOutcomeByLens[k] = v;
  }
  const cleanedOutcomeByEvidence: Record<string, PoOutcomeCell> = {};
  for (const [k, v] of Object.entries(outcomeByEvidence)) {
    if ((v.verified ?? 0) + (v.missed ?? 0) > 0) cleanedOutcomeByEvidence[k] = v;
  }
  return {
    proposed: rows.length,
    approved,
    rejected,
    shipped,
    verified,
    missed,
    approvalRate: decided ? approved / decided : null,
    medianDecisionSeconds: median,
    byEffort,
    byEvidence,
    byLens,
    // 출시 후 검증 분해 — verified+missed 합이 0이면 필드 생략 (구 daemon 호환·빈 상태 숨김).
    ...(verified + missed > 0
      ? {
          outcomeByEffort: Object.keys(cleanedOutcomeByEffort).length > 0 ? cleanedOutcomeByEffort : undefined,
          outcomeByLens: Object.keys(cleanedOutcomeByLens).length > 0 ? cleanedOutcomeByLens : undefined,
          outcomeByEvidence:
            Object.keys(cleanedOutcomeByEvidence).length > 0 ? cleanedOutcomeByEvidence : undefined,
        }
      : {}),
    byReason,
  };
}

// 누적 성적표 — 전체(또는 repoPath 필터) 합산을 톱레벨에, 레포별 분해를 repos 에.
// 필터를 줘도 repos 는 «필터된 집합» 의 분해라 전체/레포 수치가 항상 합산-일관이다.
po.get("/stats", (c) => {
  const repoPath = (c.req.query("repoPath") ?? c.req.query("repo"))?.trim();
  // po_research LEFT JOIN — 리서치産 브리프의 «전문가 관점»(lens)을 렌즈 분해에 쓴다. 수집産은
  // research_id 가 NULL → lens NULL (렌즈 분해에서 제외). 합산·repo 필터는 b.* 기준이라 불변.
  // decide_reason 도 조회 — byReason 집계의 원천 (po_decide_reason_v2).
  const SELECT_STATS =
    `SELECT b.repo_path AS repo_path, b.status AS status, b.created_at AS created_at,` +
    ` b.decided_at AS decided_at, b.effort AS effort, b.evidence AS evidence, r.lens AS lens,` +
    ` b.decide_reason AS decide_reason` +
    ` FROM po_briefs b LEFT JOIN po_research r ON b.research_id = r.id`;
  const rows = (
    repoPath
      ? db()
          .prepare(`${SELECT_STATS} WHERE b.repo_path = ?`)
          .all(repoPath)
      : db().prepare(SELECT_STATS).all()
  ) as PoStatsRow[];

  const byRepo = new Map<string, PoStatsRow[]>();
  for (const r of rows) {
    const list = byRepo.get(r.repo_path);
    if (list) list.push(r);
    else byRepo.set(r.repo_path, [r]);
  }
  const repos = [...byRepo.entries()]
    .map(([repo, list]) => ({ repoPath: repo, ...computePoStats(list) }))
    .sort((a, b) => b.proposed - a.proposed);

  // 검증 사유 — verify_note 가 있는 verified/missed 행을 최근순으로 동봉 (repo 필터 일관 유지).
  // decided_at 없는 과거 행은 updated_at 으로 폴백 정렬. 빈/없는 사유는 SQL 에서 걸러 회귀 0.
  const noteRows = (
    repoPath
      ? db()
          .prepare(
            `SELECT id, status, verify_note, decided_at, updated_at FROM po_briefs
             WHERE repo_path = ? AND status IN ('verified','missed')
               AND verify_note IS NOT NULL AND TRIM(verify_note) != ''
             ORDER BY COALESCE(decided_at, updated_at) DESC LIMIT ?`,
          )
          .all(repoPath, VERIFY_NOTES_LIMIT)
      : db()
          .prepare(
            `SELECT id, status, verify_note, decided_at, updated_at FROM po_briefs
             WHERE status IN ('verified','missed')
               AND verify_note IS NOT NULL AND TRIM(verify_note) != ''
             ORDER BY COALESCE(decided_at, updated_at) DESC LIMIT ?`,
          )
          .all(VERIFY_NOTES_LIMIT)
  ) as Array<{ id: string; status: string; verify_note: string; decided_at: number | null }>;
  const verifyNotes: PoVerifyNote[] = noteRows.map((r) => ({
    id: r.id,
    status: r.status,
    note: r.verify_note,
    decidedAt: r.decided_at,
  }));

  return c.json({ ...computePoStats(rows), repos, verifyNotes });
});

/** decide/collect/research 공용 — body.agent (po_agent_v1). 옛 클라이언트는 안 보냄 → undefined. */
export function parseAgent(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * GitHub «피드백 repo» 식별자(owner/name) 형식 검증 — `owner/name` 한 쌍만 허용한다
 * (슬래시 없음·여러 슬래시·공백 거부). 자동 추론을 막고 명시 입력만 받기 위함 (엉뚱한 repo
 * 읽기 방지). 비면 null(=로컬 origin), 형식 오류면 에러 문구.
 */
function parseFeedbackRepo(value: unknown): { repo: string | null; error?: string } {
  if (typeof value !== "string") return { repo: null };
  const v = value.trim();
  if (!v) return { repo: null };
  // owner/name — 각 세그먼트는 GitHub 허용 문자(영숫자·._-)만, 슬래시 정확히 하나.
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(v)) {
    return { repo: null, error: "owner/name 형식이어야 합니다 (예: Wayne-Kim/pocket-sisyphus-mac)" };
  }
  return { repo: v.slice(0, 200) };
}

// 직전 수집의 «App Store 신호원 실행 상태» (po_signal_status_v1) — iOS 백로그가 수집 시작 후
// 폴링해, 방금 끝난 수집(sessionId 일치)의 store/crash 신호가 실제 반영됐는지(혹은 키/네트워크로
// 빠졌는지)를 «수집 결과 카드» 로 띄운다. asc-check 의 «수집 직전 프로브»(off/키미설정/키권한)와
// 달리 이건 fetch «후» 의 실제 결과라 used(N)·app id 오류·네트워크 실패까지 구분된다.
// 신호 안 켠 레포/옛 row 는 signals=null → 카드 침묵.
po.get("/collect/last", (c) => {
  const repoPath = c.req.query("repoPath");
  if (!repoPath) return c.json({ error: "missing_repo_path" }, 400);
  const row = db()
    .prepare(
      `SELECT last_collect_signals, last_collect_session_id, last_collect_at
         FROM po_profiles WHERE repo_path = ?`,
    )
    .get(repoPath) as
    | {
        last_collect_signals: string | null;
        last_collect_session_id: string | null;
        last_collect_at: number | null;
      }
    | undefined;
  const signals = parseSignals(row?.last_collect_signals);
  if (!signals) return c.json({ signals: null });
  return c.json({
    signals,
    sessionId: row?.last_collect_session_id ?? null,
    at: row?.last_collect_at ?? null,
  });
});

po.post("/collect", async (c) => {
  let body: {
    repoPath?: unknown;
    instruction?: unknown;
    agent?: unknown;
    persona?: unknown;
    lens?: unknown;
    locale?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const repoPath = typeof body.repoPath === "string" ? body.repoPath.trim() : "";
  if (!repoPath) return c.json({ error: "missing_repo_path" }, 400);
  // 사용자의 대략적 지시 (선택) — 프롬프트에 그대로 들어가므로 길이만 cap.
  const instruction =
    typeof body.instruction === "string" ? body.instruction.trim().slice(0, 2000) : undefined;
  const agent = parseAgent(body.agent);
  if (agent && !hasAgent(agent)) return c.json({ error: "agent_missing", message: agent }, 400);
  // 수집 «전문가 관점» 렌즈 (po_collect_lens_v1, +security 는 po_collect_lens_v2) — 새 클라이언트는
  // lens('default'|'design'|'bug'|'security')를, 옛 클라이언트(po_designer_v1만 아는)는 persona='designer'
  // 를 보낸다. lens 가 오면 그것을(자유 문자열은 parseLens 화이트리스트로 안전 폴백), 없고
  // persona='designer' 면 'design' 으로 매핑한다
  // (designer→design 동치). 둘 다 없으면 'default'(전방위). route 는 «항상» explicit lens 를 넘겨
  // 수동 수집이 프로필 렌즈에 흔들리지 않게 한다 — 프로필 렌즈 폴백은 인자 없는 주기 수집 전용.
  const lens =
    body.lens !== undefined
      ? parseLens(body.lens)
      : body.persona === "designer"
        ? ("design" as const)
        : ("default" as const);
  // 산출 언어 (po_locale_v1) — iOS 가 실은 앱 표시 언어. 지원 집합의 비-ko 면 브리프를 그 언어로
  // 산출하게 빌더가 지시를 붙인다. 누락(옛 클라이언트)/ko/미지원은 normalizePoLocale 이 undefined
  // 로 떨궈 한국어 산출(byte-identical) — parseLens 와 같은 경계 화이트리스트 검증.
  const locale = normalizePoLocale(body.locale);

  const result = startPoCollection(repoPath, instruction || undefined, agent, lens, locale);
  if (result.status === "error") {
    return c.json({ error: "collect_failed", message: result.error }, 400);
  }
  // 신호 가용성 점검 — 수집은 이미 백그라운드로 시작됐으니 이 점검은 응답에만 지연을 더한다
  // (수집 자체는 안 막음). 두 신호원의 silent-degradation 을 폰에 표면화한다:
  //  • gh (po_gh_check_v1): gh 미설치/미인증/피드백 repo 접근 불가. 불확실/비-GitHub 레포는 침묵.
  //  • asc (po_asc_check_v1): ASC 키 미설정/만료·폐기로 리뷰·크래시 신호가 0. 불확실/꺼짐은 침묵.
  // 피드백 repo 가 설정됐으면 로컬 origin 이 아니라 그 repo 의 접근성을 점검한다 (수집 프롬프트가
  // 읽는 대상과 같아야 안내가 정확하다). 옛 클라이언트가 못 저장하면 null → 현행 로컬 origin 점검.
  const profile = db()
    .prepare(`SELECT github_feedback_repo, asc_app_id FROM po_profiles WHERE repo_path = ?`)
    .get(repoPath) as
    | { github_feedback_repo: string | null; asc_app_id: string | null }
    | undefined;
  const [gh, asc] = await Promise.all([
    checkGhForCollect(repoPath, profile?.github_feedback_repo ?? undefined),
    checkAscForCollect(profile?.asc_app_id ?? null, readConfig()?.asc),
  ]);
  return c.json(
    { sessionId: result.sessionId, agent: result.agentId, ...(gh ? { gh } : {}), ...(asc ? { asc } : {}) },
    202,
  );
});

// 일괄 결재 (po_bulk_decide_v1) — 트리아지 «우선» 흐름: 저점수 다수를 한 동작으로 비운다.
// hold/reject «만» 받는다 — approve 는 brief 마다 구현 세션/워크플로우를 spawn 하므로 일괄
// 대상이 아니다(단건 /decide 만 approve 를 다룬다). 살아있는(proposed/held) 행만 바꾸고,
// 없는/이미 처리된 id 는 건드리지 않고 skipped 로 돌려준다(부분 성공). :id/decide 보다 «먼저»
// 등록해 "bulk" 가 :id 로 잡히지 않게 한다.
po.post("/briefs/bulk/decide", async (c) => {
  let body: { ids?: unknown; action?: unknown; reason?: unknown; note?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const action = typeof body.action === "string" ? body.action : "";
  if (!["hold", "reject"].includes(action)) {
    return c.json({ error: "invalid_action" }, 400);
  }
  // 중복 제거 + 빈 문자열 거름. 옛/이상 클라이언트가 보낸 비-문자열도 떨군다.
  const ids = Array.isArray(body.ids)
    ? [...new Set(body.ids.filter((x): x is string => typeof x === "string" && x.length > 0))]
    : [];
  if (ids.length === 0) return c.json({ error: "missing_ids" }, 400);
  // 한 요청 cap — 목록 LIMIT(200)과 정합. 그 이상은 거부해 거대 트랜잭션을 막는다.
  if (ids.length > 200) return c.json({ error: "too_many_ids" }, 400);

  // 보류/기각 사유 태그 + 선택 메모 (po_decide_reason_v1) — 일괄 결재는 한 사유를 선택분
  // 전체에 적용한다. 미선택(허용)이면 NULL.
  const reason = parseDecideReason((body as { reason?: unknown }).reason);
  const note = parseDecideNote((body as { note?: unknown }).note);

  const status = action === "hold" ? "held" : "rejected";
  const now = Date.now();
  const updatedIds: string[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  const sel = db().prepare(`SELECT status FROM po_briefs WHERE id = ?`);
  const upd = db().prepare(
    `UPDATE po_briefs SET status = ?, updated_at = ?, decided_at = ?, decide_reason = ?, decide_note = ? WHERE id = ?`,
  );
  // 트랜잭션 1회 — 부분 실패 없이 «적용한 것만» 일관되게 커밋한다.
  db().transaction(() => {
    for (const id of ids) {
      const row = sel.get(id) as { status: string } | undefined;
      if (!row) {
        skipped.push({ id, reason: "not_found" });
        continue;
      }
      if (!["proposed", "held"].includes(row.status)) {
        skipped.push({ id, reason: "already_decided" });
        continue;
      }
      upd.run(status, now, now, reason, note, id);
      updatedIds.push(id);
    }
  })();

  const updated = updatedIds.length
    ? (db()
        .prepare(`SELECT * FROM po_briefs WHERE id IN (${updatedIds.map(() => "?").join(",")})`)
        .all(...updatedIds) as PoBriefRow[])
    : [];
  console.log(`[po] bulk ${action} updated=${updatedIds.length} skipped=${skipped.length}`);
  return c.json({ updated: updated.map(toApi), skipped });
});

po.post("/briefs/:id/decide", async (c) => {
  const id = c.req.param("id");
  let body: {
    action?: unknown;
    useWorktree?: unknown;
    agent?: unknown;
    mode?: unknown;
    reason?: unknown;
    note?: unknown;
    locale?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  // 산출 언어 (po_locale_v1) — 구현 세션 프롬프트를 앱 언어로. 누락/ko/미지원은 ko (회귀 0).
  const locale = normalizePoLocale(body.locale);
  const action = typeof body.action === "string" ? body.action : "";
  if (!["approve", "hold", "reject"].includes(action)) {
    return c.json({ error: "invalid_action" }, 400);
  }
  // approve 전용 — true 면 구현 세션을 원본 레포가 아닌 새 worktree 에서 돌린다
  // (동시 세션 간 작업트리 충돌 방지). 옛 클라이언트는 필드를 안 보내 false.
  const useWorktree = body.useWorktree === true;
  // approve 전용 (po_workflow_v1) — "workflow" 면 단일 세션 대신 «설계 에이전트 →
  // 검증된 DAG run» 경로. 옛 클라이언트/생략은 "session" (하위호환).
  const mode = body.mode === "workflow" ? "workflow" : "session";

  const row = db().prepare(`SELECT * FROM po_briefs WHERE id = ?`).get(id) as
    | PoBriefRow
    | undefined;
  if (!row) return c.json({ error: "not_found" }, 404);
  // 결정은 살아있는(proposed/held) 브리프에만 — running/종결 상태 재결정은 거부.
  if (!["proposed", "held"].includes(row.status)) {
    return c.json({ error: "already_decided", status: row.status }, 409);
  }

  const now = Date.now();

  if (action === "hold" || action === "reject") {
    const status = action === "hold" ? "held" : "rejected";
    // 보류/기각 사유 태그 + 선택 메모 (po_decide_reason_v1) — 미선택(허용)이면 NULL.
    const reason = parseDecideReason(body.reason);
    const note = parseDecideNote(body.note);
    db()
      .prepare(
        `UPDATE po_briefs SET status = ?, updated_at = ?, decided_at = ?, decide_reason = ?, decide_note = ? WHERE id = ?`,
      )
      .run(status, now, now, reason, note, id);
    const updated = db().prepare(`SELECT * FROM po_briefs WHERE id = ?`).get(id) as PoBriefRow;
    return c.json({ brief: toApi(updated) });
  }

  // approve — 구현 세션을 만들어 스펙 프롬프트를 쏘고 running 으로. 세션은 일반 세션이라
  // 사용자가 세션 탭에서 관전/개입할 수 있다 (iOS 가 곧장 딥링크로 연다).
  const dir = resolveAndEnsureRepoDir(row.repo_path);
  if ("error" in dir) return c.json({ error: "repo_dir_failed", message: dir.error }, 400);
  // 구현 세션을 돌릴 에이전트 (po_agent_v1) — 옛 클라이언트는 안 보내 claude_code.
  const agentId = parseAgent(body.agent) ?? "claude_code";
  if (!hasAgent(agentId)) return c.json({ error: "agent_missing", message: agentId }, 400);

  // mode=workflow (po_workflow_v1) — 설계 에이전트가 브리프 맞춤 DAG 를 만들고, daemon 이
  // 검증(+사람 게이트 강제) 후 run 을 생성한다. 설계 세션 id 를 돌려줘 iOS 가 관전 가능 —
  // 설계 실패는 백그라운드에서 기본 템플릿으로 fallback (승인이 실패로 안 끝남). 단, run 전
  // per-run worktree 생성(po_run_worktree_v1)은 동기로 await 한다 — 실패 시 조용히 공유 repo 로
  // 폴백하지 않고(충돌 버그의 원인) 승인을 거절해 브리프를 proposed/held 로 남긴다 (재시도 가능).
  if (mode === "workflow") {
    const wf = await startPoWorkflowApproval(row, agentId, locale);
    if (wf.status === "error") {
      return c.json({ error: "workflow_approve_failed", message: wf.error }, 400);
    }
    db()
      .prepare(
        `UPDATE po_briefs SET status = 'running', updated_at = ?, decided_at = ?, exec_session_id = ?, exec_agent_id = ? WHERE id = ?`,
      )
      .run(now, now, wf.sessionId, agentId, id);
    console.log(`[po] brief approved (workflow) id=${id} design session=${wf.sessionId} agent=${agentId}`);
    const updatedWf = db().prepare(`SELECT * FROM po_briefs WHERE id = ?`).get(id) as PoBriefRow;
    return c.json({ brief: toApi(updatedWf), execSessionId: wf.sessionId, agent: agentId });
  }

  // useWorktree — `po/<id8>` 새 브랜치의 worktree 를 만들어 거기서 구현한다. 실패하면
  // 브리프를 건드리지 않고 거절 — 사용자가 명시적으로 고른 격리를 조용히 무시하지 않는다.
  let cwd = dir.path;
  if (useWorktree) {
    const branch = `po/${id.slice(0, 8)}`;
    const wt = await createWorktree(dir.path, { branch, newBranch: true });
    if (!wt.ok) {
      return c.json(
        { error: "worktree_failed", message: wt.body.message ?? wt.body.error },
        wt.status,
      );
    }
    cwd = wt.path;
    console.log(`[po] brief ${id} exec worktree created branch=${branch} path=${cwd}`);
  }

  // 디자인 컨텍스트 선언 — workflow-exec / executor 와 동형. 있으면 「디자인 제약」 섹션에
  // 그대로, 없으면 자동 발견으로 폴백. 기본(세션) 승인의 구현 프롬프트가 UI 브리프면 레포가
  // 정한 색 의미·로케일 집합·상태·접근성을 알고 시작하게 한다 (워크플로우를 안 켜도). 옛
  // 프로필/미설정은 null → 자동 발견 (회귀 없음).
  const designDirective = (
    db()
      .prepare(`SELECT design_directive FROM po_profiles WHERE repo_path = ?`)
      .get(row.repo_path) as { design_directive: string | null } | undefined
  )?.design_directive;

  const sessionId = createSession(cwd, `📋 ${row.title}`.slice(0, 120), undefined, true, agentId);
  void runUserMessagePty(
    { sessionId, cwd, adapter: getAgent(agentId) },
    buildPoExecPrompt(row, designDirective ?? undefined, locale),
    { bypassPermissions: true },
  ).catch((e) => {
    console.warn(`[po] exec runUserMessagePty failed session=${sessionId}:`, (e as Error).message);
  });

  db()
    .prepare(
      `UPDATE po_briefs SET status = 'running', updated_at = ?, decided_at = ?, exec_session_id = ?, exec_agent_id = ? WHERE id = ?`,
    )
    .run(now, now, sessionId, agentId, id);
  // 구현 세션 첫 turn 이 정착하면 running → shipped — 다음 수집 사이클의 검증 대상이 된다.
  watchExecForShipped(id, sessionId);
  console.log(`[po] brief approved id=${id} exec session=${sessionId} agent=${agentId}`);
  const updated = db().prepare(`SELECT * FROM po_briefs WHERE id = ?`).get(id) as PoBriefRow;
  return c.json({ brief: toApi(updated), execSessionId: sessionId, agent: agentId });
});

// 진행 중(running) 브리프의 «구현 다시 시작» (po_exec_restart_v1) — 구현 세션을 사용자가
// 임의로 정지하거나 세션이 깔끔한 정착 신호 없이 죽으면 브리프가 running 에 영원히 남는다
// (shipped 전이는 세션 정착 시에만). 유일한 수습이 «삭제» 뿐이라 승인 이력·결재 사유·출처가
// 함께 증발했다 — 이 엔드포인트가 같은 브리프 id·결재 컨텍스트(decided_at·decide_reason·
// impact/effort·provenance)를 «그대로 보존» 한 채 새 구현 세션을 spawn 하고 exec_session_id 만
// 교체한다. 상태는 running 유지 (삭제→재승인과 달리 이력이 남는다).
//   • 살아있는 running 세션 모드 브리프에만 — proposed/held/종결 상태는 거부(decide 가 다룬다).
//   • 워크플로우(po_workflow_v1) 모드(exec_workflow_id != null)는 이번 범위 밖 — run 재시작은 별건.
//   • 에이전트는 body.agent → 브리프에 기록된 exec_agent_id → claude_code 순으로 폴백 (마지막 선택 재사용).
//   • shipped 직전 race — 가드된 UPDATE(status='running' 조건)로 멱등하게 처리해 중복 세션을 막는다.
//   • 이전 exec_session 은 orphan (강제 종료 안 함 — 비-목표) — 사용자가 세션 탭에서 정리 가능.
po.post("/briefs/:id/restart", async (c) => {
  const id = c.req.param("id");
  let body: { agent?: unknown; locale?: unknown };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  const locale = normalizePoLocale(body.locale);

  const row = db().prepare(`SELECT * FROM po_briefs WHERE id = ?`).get(id) as
    | PoBriefRow
    | undefined;
  if (!row) return c.json({ error: "not_found" }, 404);
  // 재시작은 «진행 중» 브리프에만 — proposed/held(decide 경로) 와 종결(shipped/verified/missed/
  // rejected) 은 재시작 대상이 아니다 (running 에 갇힌 죽은 세션의 수습 전용).
  if (row.status !== "running") {
    return c.json({ error: "not_running", status: row.status }, 409);
  }
  // 워크플로우 모드(po_workflow_v1)는 이번 범위 밖 — run 재시작은 캔버스의 노드 재시도가 다룬다.
  if (row.exec_workflow_id) {
    return c.json({ error: "workflow_not_supported" }, 409);
  }

  const dir = resolveAndEnsureRepoDir(row.repo_path);
  if ("error" in dir) return c.json({ error: "repo_dir_failed", message: dir.error }, 400);
  // 에이전트 — body.agent(픽커가 보낸 마지막 선택) → 브리프에 기록된 exec_agent_id → claude_code.
  // 옛 클라이언트/픽커 미노출은 agent 를 안 보내므로 브리프의 원래 에이전트를 재사용한다.
  const agentId = parseAgent(body.agent) ?? row.exec_agent_id ?? "claude_code";
  if (!hasAgent(agentId)) return c.json({ error: "agent_missing", message: agentId }, 400);

  // 디자인 컨텍스트 — 최초 승인과 동형 (있으면 「디자인 제약」 주입, 없으면 자동 발견 폴백).
  const designDirective = (
    db()
      .prepare(`SELECT design_directive FROM po_profiles WHERE repo_path = ?`)
      .get(row.repo_path) as { design_directive: string | null } | undefined
  )?.design_directive;

  const now = Date.now();
  const sessionId = createSession(dir.path, `🔁 ${row.title}`.slice(0, 120), undefined, true, agentId);
  void runUserMessagePty(
    { sessionId, cwd: dir.path, adapter: getAgent(agentId) },
    buildPoExecPrompt(row, designDirective ?? undefined, locale),
    { bypassPermissions: true },
  ).catch((e) => {
    console.warn(`[po] restart runUserMessagePty failed session=${sessionId}:`, (e as Error).message);
  });

  // 가드된 UPDATE — 그새(이전 세션 정착) shipped 로 넘어갔으면 changes=0 → 새 세션은 watch 하지
  // 않고 현재 상태로 409. decided_at·decide_reason·decide_note·impact/effort 등은 건드리지 않아
  // 승인 이력·결재 사유·출처가 보존된다 (exec_session_id·exec_agent_id·updated_at 만 교체).
  const info = db()
    .prepare(
      `UPDATE po_briefs SET exec_session_id = ?, exec_agent_id = ?, updated_at = ? WHERE id = ? AND status = 'running'`,
    )
    .run(sessionId, agentId, now, id);
  if (info.changes === 0) {
    const current = db().prepare(`SELECT status FROM po_briefs WHERE id = ?`).get(id) as {
      status: string;
    };
    return c.json({ error: "not_running", status: current.status }, 409);
  }
  // 새 구현 세션 첫 turn 이 정착하면 running → shipped (최초 승인과 같은 감시).
  watchExecForShipped(id, sessionId);
  console.log(`[po] brief exec restarted id=${id} exec session=${sessionId} agent=${agentId}`);
  const updated = db().prepare(`SELECT * FROM po_briefs WHERE id = ?`).get(id) as PoBriefRow;
  return c.json({ brief: toApi(updated), execSessionId: sessionId, agent: agentId });
});

// 기각된 브리프의 «코드 흔적 정리» (po_cleanup_v1) — 기각된 아이디어의 신호원(TODO/FIXME
// 주석·죽은 코드·문서 할 일)이 레포에 남으면 다음 수집이 같은 제안을 또 만든다 (중복 방지는
// 살아있는 브리프 제목만 본다). 이 엔드포인트가 그 신호원을 지우는 정리 세션을 spawn 한다.
// 세션은 일반 세션 — 사용자가 관전/개입하고, 변경은 커밋 없이 작업 트리에 남는다(검토 몫).
// 재호출 허용 — 정리 세션이 실패했을 때 다시 돌릴 수 있게 cleanup_session_id 를 덮어쓴다.
po.post("/briefs/:id/cleanup", async (c) => {
  const id = c.req.param("id");
  let body: { agent?: unknown; locale?: unknown };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  const locale = normalizePoLocale(body.locale);

  const row = db().prepare(`SELECT * FROM po_briefs WHERE id = ?`).get(id) as
    | PoBriefRow
    | undefined;
  if (!row) return c.json({ error: "not_found" }, 404);
  // 정리는 «하지 않기로 결정난» 브리프에만 — 살아있는 브리프의 신호를 지우면 안 된다.
  if (row.status !== "rejected") {
    return c.json({ error: "not_rejected", status: row.status }, 409);
  }

  const dir = resolveAndEnsureRepoDir(row.repo_path);
  if ("error" in dir) return c.json({ error: "repo_dir_failed", message: dir.error }, 400);
  const agentId = parseAgent(body.agent) ?? "claude_code";
  if (!hasAgent(agentId)) return c.json({ error: "agent_missing", message: agentId }, 400);

  const sessionId = createSession(
    dir.path,
    `🧹 정리: ${row.title}`.slice(0, 120),
    undefined,
    true,
    agentId,
  );
  void runUserMessagePty(
    { sessionId, cwd: dir.path, adapter: getAgent(agentId) },
    buildPoCleanupPrompt(row, locale),
    { bypassPermissions: true },
  ).catch((e) => {
    console.warn(
      `[po] cleanup runUserMessagePty failed session=${sessionId}:`,
      (e as Error).message,
    );
  });

  db()
    .prepare(`UPDATE po_briefs SET cleanup_session_id = ?, cleanup_agent_id = ?, updated_at = ? WHERE id = ?`)
    .run(sessionId, agentId, Date.now(), id);
  console.log(`[po] cleanup start brief=${id} session=${sessionId} agent=${agentId}`);
  const updated = db().prepare(`SELECT * FROM po_briefs WHERE id = ?`).get(id) as PoBriefRow;
  return c.json({ brief: toApi(updated), cleanupSessionId: sessionId, agent: agentId }, 202);
});

// «리서치 요청» — 사용자가 정한 주제를 조사 → 보고서 + 브리프. 즉시 반환. scope 로 범위 분기:
// "web_repo"(기본) 웹+레포 / "repo_only" 레포만 (웹 검색 없이 — 가볍고 빠른 분석, po_research_scope_v1).
// screens=true (po_research_ux_screens_v1) — ux 렌즈일 때 «렌더된 화면» 을 캡처해 그 화면으로 휴리스틱을
// 판정하게 한다(화면 못 얻으면 코드+웹 graceful fallback). lens·scope 와 직교.
po.post("/research", async (c) => {
  let body: {
    repoPath?: unknown;
    topic?: unknown;
    agent?: unknown;
    lens?: unknown;
    scope?: unknown;
    screens?: unknown;
    locale?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const repoPath = typeof body.repoPath === "string" ? body.repoPath.trim() : "";
  if (!repoPath) return c.json({ error: "missing_repo_path" }, 400);
  const topic = typeof body.topic === "string" ? body.topic.trim().slice(0, 2000) : "";
  if (!topic) return c.json({ error: "missing_topic" }, 400);
  const agent = parseAgent(body.agent);
  if (agent && !hasAgent(agent)) return c.json({ error: "agent_missing", message: agent }, 400);
  // «전문가 관점» 렌즈 (po_research_lens_v1~v9) — 알려진 값(default·design·bug·qa·security·pm·
  // marketing·analytics·ops·logic·ux)만 통과, 누락/이상값/옛 클라이언트는 "default"(전방위) 로 폴백
  // (designer persona 화이트리스트와 동형).
  const lens = parseLens(body.lens);
  // 조사 범위 (po_research_scope_v1) — "repo_only" 만 웹 조사를 끈다. 그 외/생략(옛 클라이언트)은
  // undefined → 기존 웹+레포 (회귀 없음). 자유 문자열을 그대로 믿지 않고 알려진 값만 통과시킨다.
  const scope = body.scope === "repo_only" ? "repo_only" : undefined;
  // UX 렌즈 «화면 포함» (po_research_ux_screens_v1) — ux 렌즈에서만 의미. true 면 프롬프트에
  // «렌더된 화면을 캡처해 그 화면으로 휴리스틱 판정» 블록을 추가한다(화면 못 얻으면 코드+웹
  // graceful fallback). 누락/false·ux 외 렌즈는 buildPoResearchPrompt 가 무시 → 기존 동작(회귀 0).
  const screens = body.screens === true;
  // 산출 언어 (po_locale_v1) — 수집과 동형. 비-ko 지원 로케일이면 보고서·브리프를 그 언어로.
  // 누락/ko/미지원은 undefined → 한국어 산출(byte-identical).
  const locale = normalizePoLocale(body.locale);

  const result = startPoResearch(repoPath, topic, agent, lens, scope, screens, locale);
  if (result.status === "error") {
    return c.json({ error: "research_failed", message: result.error }, 400);
  }
  return c.json({ researchId: result.researchId, sessionId: result.sessionId, agent: result.agentId }, 202);
});

po.get("/research", (c) => {
  const rows = db()
    .prepare(`SELECT * FROM po_research ORDER BY created_at DESC LIMIT 50`)
    .all() as PoResearchRow[];
  return c.json({ research: rows.map((r) => researchToApi(r, false)) });
});

po.get("/research/:id", (c) => {
  const row = db().prepare(`SELECT * FROM po_research WHERE id = ?`).get(c.req.param("id")) as
    | PoResearchRow
    | undefined;
  if (!row) return c.json({ error: "not_found" }, 404);
  return c.json({ research: researchToApi(row, true) });
});

po.delete("/research/:id", (c) => {
  const info = db().prepare(`DELETE FROM po_research WHERE id = ?`).run(c.req.param("id"));
  return c.json({ ok: true, deleted: info.changes });
});

// 프로젝트별 «조사 방식» 프로필 + 주기 수집 schedule + ASC 리뷰 신호 — 레포마다 저장·재사용.
// 비어 있으면 directive: "" / schedule: null / ascAppId: null. ascKeyConfigured 는 iOS 가
// «App Store 리뷰» 토글의 안내문(키 미설정이면 Mac 설정 유도)을 분기하는 read-only 정보.
po.get("/profile", (c) => {
  const repoPath = c.req.query("repoPath")?.trim();
  if (!repoPath) return c.json({ error: "missing_repo_path" }, 400);
  const row = db()
    .prepare(
      `SELECT directive, schedule, asc_app_id, github_feedback_repo, lens, design_directive, design_directive_draft, design_directive_draft_session_id, design_directive_draft_at FROM po_profiles WHERE repo_path = ?`,
    )
    .get(repoPath) as
    | {
        directive: string;
        schedule: string | null;
        asc_app_id: string | null;
        github_feedback_repo: string | null;
        lens: string | null;
        design_directive: string | null;
        design_directive_draft: string | null;
        design_directive_draft_session_id: string | null;
        design_directive_draft_at: number | null;
      }
    | undefined;
  return c.json({
    repoPath,
    directive: row?.directive ?? "",
    schedule: row?.schedule ?? null,
    ascAppId: row?.asc_app_id ?? null,
    githubFeedbackRepo: row?.github_feedback_repo ?? null,
    // 주기 수집 «전문가 관점» 렌즈 (po_collect_lens_v1, +security 는 po_collect_lens_v2) —
    // 'default'(전방위)|'design'|'bug'|'security'. 옛 row 는 DEFAULT 'default'. iOS 설정의 «전문가
    // 관점» 픽커가 이 값을 보여주고 PUT 으로 갱신한다 (security 옵션은 v2 게이팅).
    lens: row?.lens ?? "default",
    // design_directive = 승인돼 «선언» 으로 쓰이는 약속(강신호). draft = 디자이너 에이전트가 만든
    // 검토 대기 초안(승인 전엔 적용 안 됨). draftSessionId 가 non-null 이면 «생성 중».
    designDirective: row?.design_directive ?? null,
    designDirectiveDraft: row?.design_directive_draft ?? null,
    designDirectiveDraftSessionId: row?.design_directive_draft_session_id ?? null,
    designDirectiveDraftAt: row?.design_directive_draft_at ?? null,
    ascKeyConfigured: !!readConfig()?.asc,
  });
});

po.put("/profile", async (c) => {
  let body: {
    repoPath?: unknown;
    directive?: unknown;
    schedule?: unknown;
    ascAppId?: unknown;
    githubFeedbackRepo?: unknown;
    designDirective?: unknown;
    lens?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const repoPath = typeof body.repoPath === "string" ? body.repoPath.trim() : "";
  if (!repoPath) return c.json({ error: "missing_repo_path" }, 400);
  const directive =
    typeof body.directive === "string" ? body.directive.trim().slice(0, 4000) : "";
  // 주기 수집 — 5필드 cron 식 (Mac 로컬 타임존). 비우면 꺼짐(null).
  const scheduleRaw = typeof body.schedule === "string" ? body.schedule.trim() : "";
  const schedule = scheduleRaw || null;
  if (schedule) {
    const v = validateSchedule(schedule);
    if (!v.valid) return c.json({ error: "invalid_schedule", message: v.error }, 400);
  }
  // ASC 스토어 리뷰 신호 — 앱 ID(숫자) 또는 번들 ID. 비우면 꺼짐(null). 옛 클라이언트는
  // 필드를 안 보내 null → 끔 유지가 아니라 끔이 되지만, 옛 클라이언트는 켤 수단 자체가
  // 없었으므로 동작 변화 없음.
  const ascRaw = typeof body.ascAppId === "string" ? body.ascAppId.trim().slice(0, 200) : "";
  const ascAppId = ascRaw || null;
  // GitHub 피드백 repo (owner/name). 비우면 null(=로컬 origin). 형식 오류는 즉시 400 — iOS 가
  // inline 검증 안내를 띄운다. 옛 클라이언트는 필드를 안 보내 null (현행 로컬 origin 동작 유지).
  const fb = parseFeedbackRepo(body.githubFeedbackRepo);
  if (fb.error) return c.json({ error: "invalid_feedback_repo", message: fb.error }, 400);
  const githubFeedbackRepo = fb.repo;
  // 디자인 컨텍스트는 이 PUT 이 «기본적으로 건드리지 않는다» — design_directive(승인된 선언)는
  // POST /design-directive/approve 로만, 초안은 부트스트랩/승인/버리기 전용 라우트로만 바뀐다.
  // 여기서 비워 덮어쓰면 «조사 방식» 한 줄 저장이 승인된 강신호를 통째로 날린다(실제 회귀 위험).
  // 그래서 기존 design_directive + 초안 컬럼을 읽어 «보존» 하고, «모두 비움 → 삭제» 판정에도 그
  // 존재를 포함시킨다. body 에 designDirective 가 «명시» 됐을 때만 그 값으로 설정/해제를 허용한다
  // (하위호환 — 현재 클라이언트는 안 보낸다 → 항상 보존 경로).
  const existing = db()
    .prepare(
      `SELECT lens, design_directive, design_directive_draft, design_directive_draft_session_id, design_directive_draft_at FROM po_profiles WHERE repo_path = ?`,
    )
    .get(repoPath) as
    | {
        lens: string | null;
        design_directive: string | null;
        design_directive_draft: string | null;
        design_directive_draft_session_id: string | null;
        design_directive_draft_at: number | null;
      }
    | undefined;
  // 주기 수집 «전문가 관점» 렌즈 (po_collect_lens_v1, +security 는 po_collect_lens_v2) — body 에 lens 가
  // «명시» 됐을 때만 그 값으로 갱신, 없으면 기존 값을 보존한다(옛 클라이언트 PUT 이 렌즈를 날리지 않게
  // — designDirective 와 동형). parseLens 로 이상값/누락은 'default' 폴백. 'default' 가 아닌 렌즈는
  // «의미 있는 설정» 이라 «모두 비움» 삭제 판정에서 row 를 살린다 (주기 수집의 고정 초점을 보존).
  const lens =
    "lens" in body ? parseLens(body.lens) : parseLens(existing?.lens);
  const hasLens = lens !== "default";
  const designDirective =
    "designDirective" in body
      ? (typeof body.designDirective === "string"
          ? body.designDirective.trim().slice(0, 4000)
          : "") || null
      : existing?.design_directive ?? null;
  const draft = existing?.design_directive_draft ?? null;
  const draftSession = existing?.design_directive_draft_session_id ?? null;
  const draftAt = existing?.design_directive_draft_at ?? null;
  // 디자인 상태(선언/초안/생성중)가 살아 있으면 «모두 비움» 이어도 row 를 지우지 않는다.
  const hasDesignState = !!designDirective || !!draft || !!draftSession;

  if (!directive && !schedule && !ascAppId && !githubFeedbackRepo && !hasDesignState && !hasLens) {
    // 다 비우기 = 프로필 삭제 — 다음 수집은 기본 전방위 조사로, 주기 수집·리뷰 신호·피드백 repo
    // 는 모두 꺼짐(로컬 origin 으로 복귀), 디자인 컨텍스트는 자동 발견으로 복귀.
    db().prepare(`DELETE FROM po_profiles WHERE repo_path = ?`).run(repoPath);
  } else {
    // 초안 컬럼은 ON CONFLICT SET 에 «없어서» 보존된다. 신규 INSERT 시엔 위에서 읽은 보존값(없으면
    // null)을 그대로 넣는다 — 어느 경로든 디자인 상태가 PUT 으로 사라지지 않는다.
    db()
      .prepare(
        `INSERT INTO po_profiles (repo_path, directive, schedule, asc_app_id, github_feedback_repo, lens, design_directive, design_directive_draft, design_directive_draft_session_id, design_directive_draft_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(repo_path) DO UPDATE SET directive = excluded.directive, schedule = excluded.schedule, asc_app_id = excluded.asc_app_id, github_feedback_repo = excluded.github_feedback_repo, lens = excluded.lens, design_directive = excluded.design_directive, updated_at = excluded.updated_at`,
      )
      .run(
        repoPath,
        directive,
        schedule,
        ascAppId,
        githubFeedbackRepo,
        lens,
        designDirective,
        draft,
        draftSession,
        draftAt,
        Date.now(),
      );
  }
  // croner 등록 갱신 — 켜기/끄기/시각 변경이 즉시 반영된다.
  getPoScheduler().reschedule(repoPath);
  return c.json({ repoPath, directive, schedule, ascAppId, githubFeedbackRepo, lens, designDirective });
});

// ─── 디자인 directive 부트스트랩 (po_design_bootstrap_v1) ─────────────────────────
// design_directive 가 NULL 이면 「디자인 제약」 이 «자동 발견»(약한 신호)으로 떨어진다. 손으로
// directive 를 쓰는 건 채택 장벽 — 그래서 디자이너 에이전트가 레포 디자인 SSOT 를 스캔해 초안을
// 만들고, 사람이 iOS/Mac 설정 «디자인» 영역에서 승인해야 design_directive(강신호)로 «복사»된다
// (자동 적용 금지). bootstrap=초안 생성, approve=초안→선언 복사+정리, draft DELETE=초안 버리기.

// POST — 부트스트랩 시작. 즉시 세션 id 반환, 스캔·초안 산출은 백그라운드(생성 중 표시는 프로필).
po.post("/design-directive/bootstrap", async (c) => {
  let body: { repoPath?: unknown; agent?: unknown; locale?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const repoPath = typeof body.repoPath === "string" ? body.repoPath.trim() : "";
  if (!repoPath) return c.json({ error: "missing_repo_path" }, 400);
  const agent = parseAgent(body.agent);
  if (agent && !hasAgent(agent)) return c.json({ error: "agent_missing", message: agent }, 400);
  const locale = normalizePoLocale(body.locale);

  const result = startPoDesignBootstrap(repoPath, agent, locale);
  if (result.status === "error") {
    return c.json({ error: "bootstrap_failed", message: result.error }, 400);
  }
  return c.json({ sessionId: result.sessionId }, 202);
});

// POST — 승인. 검토(가능하면 편집)한 directive 를 design_directive 로 복사하고 초안을 정리한다.
// 본문 directive 가 있으면 그걸(편집 반영), 없으면 저장된 초안을 그대로 승인한다. 이 라우트만이
// design_directive 를 «켜는» 사람-게이트 — 어떤 자동 경로도 design_directive 를 쓰지 않는다.
po.post("/design-directive/approve", async (c) => {
  let body: { repoPath?: unknown; directive?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const repoPath = typeof body.repoPath === "string" ? body.repoPath.trim() : "";
  if (!repoPath) return c.json({ error: "missing_repo_path" }, 400);
  const row = db()
    .prepare(`SELECT design_directive_draft FROM po_profiles WHERE repo_path = ?`)
    .get(repoPath) as { design_directive_draft: string | null } | undefined;
  const bodyDirective =
    typeof body.directive === "string" ? body.directive.trim().slice(0, 4000) : "";
  const directive = bodyDirective || (row?.design_directive_draft ?? "").trim().slice(0, 4000);
  if (!directive) return c.json({ error: "no_directive" }, 400);

  const now = Date.now();
  db()
    .prepare(
      `INSERT INTO po_profiles (repo_path, directive, design_directive, updated_at) VALUES (?, '', ?, ?)
       ON CONFLICT(repo_path) DO UPDATE SET design_directive = excluded.design_directive, design_directive_draft = NULL, design_directive_draft_session_id = NULL, design_directive_draft_at = NULL, updated_at = excluded.updated_at`,
    )
    .run(repoPath, directive, now);
  console.log(`[po] design directive approved repo=${repoPath} chars=${directive.length}`);
  return c.json({ repoPath, designDirective: directive });
});

// DELETE — 초안 버리기(승인 안 함). design_directive(이미 선언된 값)는 건드리지 않는다.
po.delete("/design-directive/draft", (c) => {
  const repoPath = c.req.query("repoPath")?.trim();
  if (!repoPath) return c.json({ error: "missing_repo_path" }, 400);
  db()
    .prepare(
      `UPDATE po_profiles SET design_directive_draft = NULL, design_directive_draft_session_id = NULL, design_directive_draft_at = NULL, updated_at = ? WHERE repo_path = ?`,
    )
    .run(Date.now(), repoPath);
  return c.json({ ok: true });
});

// ─── ASC API 키 설정 (Mac 설정 «App Store» 탭 전용) ──────────────────────────
// 키는 config.json(0600) 에만 산다 — 폰/QR 에 절대 안 들어간다. notify/config 와 같은
// bearer 인증 (127.0.0.1 바인딩 + 같은 머신의 Mac 앱이 평문 token 으로 호출).

// GET — 설정 여부 + 비밀 아닌 식별자만 (p8 본문은 절대 반환 안 함).
po.get("/asc-key", (c) => {
  const asc = readConfig()?.asc;
  return c.json({
    configured: !!asc,
    keyId: asc?.keyId ?? null,
    issuerId: asc?.issuerId ?? null,
  });
});

// PUT — 키 저장. 저장 전에 PEM 형식 검증(즉시 피드백) — 실호출 검증은 /asc-key/verify.
po.put("/asc-key", async (c) => {
  const cfg = readConfig();
  if (!cfg) return c.json({ error: "daemon_not_initialized" }, 500);
  let body: { keyId?: unknown; issuerId?: unknown; privateKeyPem?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const asc: AscConfig = {
    keyId: typeof body.keyId === "string" ? body.keyId.trim() : "",
    issuerId: typeof body.issuerId === "string" ? body.issuerId.trim() : "",
    privateKeyPem: typeof body.privateKeyPem === "string" ? body.privateKeyPem.trim() : "",
  };
  const invalid = validateAscKey(asc);
  if (invalid) return c.json({ error: "invalid_key", message: invalid }, 400);
  writeConfig({ ...cfg, asc });
  console.log(`[po] asc: API 키 저장 keyId=${asc.keyId}`);
  return c.json({ ok: true, configured: true });
});

// DELETE — 키 제거. 프로필의 asc_app_id 는 남는다 (키 재등록 시 그대로 재개).
po.delete("/asc-key", (c) => {
  const cfg = readConfig();
  if (!cfg) return c.json({ error: "daemon_not_initialized" }, 500);
  const { asc: _drop, ...rest } = cfg;
  writeConfig(rest);
  console.log(`[po] asc: API 키 삭제`);
  return c.json({ ok: true, configured: false });
});

// POST — 실호출 검증 (만료·권한 부족을 설정 화면에서 즉시 피드백). body.appId 가 있으면
// 그 앱의 리뷰 읽기 권한까지 확인. 저장된 키가 없으면 body 의 키 후보로 저장 전 검증.
po.post("/asc-key/verify", async (c) => {
  let body: { appId?: unknown; keyId?: unknown; issuerId?: unknown; privateKeyPem?: unknown };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  const candidate: AscConfig | undefined =
    typeof body.keyId === "string" && typeof body.privateKeyPem === "string"
      ? {
          keyId: body.keyId.trim(),
          issuerId: typeof body.issuerId === "string" ? body.issuerId.trim() : "",
          privateKeyPem: body.privateKeyPem.trim(),
        }
      : undefined;
  const asc = candidate ?? readConfig()?.asc;
  if (!asc) return c.json({ error: "asc_not_configured" }, 400);
  const invalid = validateAscKey(asc);
  if (invalid) return c.json({ error: "invalid_key", message: invalid }, 400);
  const appId = typeof body.appId === "string" ? body.appId.trim() : undefined;
  try {
    const result = await verifyAscConnection(asc, appId);
    return c.json(result);
  } catch (e) {
    return c.json({ error: "verify_failed", message: (e as Error).message }, 502);
  }
});

// 브리프 «수정 지시» — 티켓 코멘트처럼 한 줄 지시로 재종합. 결재 전(proposed/held)에만.
po.post("/briefs/:id/revise", async (c) => {
  const id = c.req.param("id");
  let body: { comment?: unknown; locale?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const comment = typeof body.comment === "string" ? body.comment.trim().slice(0, 2000) : "";
  if (!comment) return c.json({ error: "missing_comment" }, 400);
  // 산출 언어 (po_locale_v1) — 비-ko 지원 로케일이면 갱신본을 그 언어로 재종합. 누락/ko/미지원은
  // undefined → 한국어 산출(byte-identical).
  const locale = normalizePoLocale(body.locale);

  const row = db().prepare(`SELECT status, revising_session_id FROM po_briefs WHERE id = ?`).get(id) as
    | { status: string; revising_session_id: string | null }
    | undefined;
  if (!row) return c.json({ error: "not_found" }, 404);
  if (!["proposed", "held"].includes(row.status)) {
    return c.json({ error: "already_decided", status: row.status }, 409);
  }
  if (row.revising_session_id) {
    return c.json({ error: "revision_in_progress" }, 409);
  }

  const result = startPoRevision(id, comment, locale);
  if (result.status === "error") {
    return c.json({ error: "revise_failed", message: result.error }, 400);
  }
  return c.json({ sessionId: result.sessionId }, 202);
});

po.delete("/briefs/:id", (c) => {
  const id = c.req.param("id");
  const info = db().prepare(`DELETE FROM po_briefs WHERE id = ?`).run(id);
  return c.json({ ok: true, deleted: info.changes });
});
