// PO 루프 — 브리프 승인의 «워크플로우로 실행» 경로 (po_workflow_v1).
//
// 설계 문서 §3.4 의 «스펙 확정 → 구현 → 자가 검증 → 사람 승인 게이트 → 머지» DAG 연결.
// 흐름: 승인(mode=workflow) → ① 워크플로우 설계 에이전트 세션 spawn (수집과 같은
// tmp JSON 산출 → ingest 계약) → ② daemon 이 산출을 sanitize(위험 필드 화이트리스트) +
// 사람 게이트 강제 + validateDef → ③ 실패/누락/타임아웃이면 기본 4노드 템플릿 fallback —
// 승인 액션이 실패로 끝나지 않는다 → ④ «PO: <제목>» 워크플로우 저장 + run 시작 →
// ⑤ run 감시: 게이트 도달 알림(po_gate, 딥링크 backlog/<briefId> — 상세의 캔버스 진입점이
//    해당 run 에 착지) / settle 시 브리프 전이
// (done→shipped, 게이트 거부→running 유지+메모, failed→running 유지+메모+po_failed 알림).
//
// 비-목표 (브리프): 워크플로우 엔진 자체는 건드리지 않는다 — 감시는 DB 폴링으로만 한다.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { db, type WorkflowNodeRunRow } from "../db/index.js";
import { getAgent, hasAgent, listAgents } from "../agent/registry.js";
import { gitRepoInfo, isValidRef, defaultBranch } from "../git/worktree.js";
import { insertMergeRequest, getMergeRequest } from "../merge/store.js";
import { getMergeQueue } from "../merge/queue.js";
import {
  runUserMessagePty,
  abortPtySession,
  awaitPtyExit,
} from "../agent/pty-runner.js";
import { createSession, resolveAndEnsureRepoDir } from "../routes/sessions.js";
import { markCronSession, unmarkCronSession } from "../cron/registry.js";
import { waitForSessionSettle } from "../cron/executor.js";
import {
  validateDef,
  parseSnapshot,
  type NodeDef,
  type EdgeDef,
  type WorkflowDef,
} from "../workflow/types.js";
import { insertWorkflow } from "../workflow/store.js";
import { getRun, listNodeRuns, countActiveWorktreeRuns } from "../workflow/store.js";
import { startWorkflowRun } from "../workflow/engine.js";
import { createWorktree } from "../git/worktree.js";
import { prepareUnattendedCwd } from "../mcp/unattended.js";
import { computeInitialTaint, markSessionTainted } from "../taint.js";
import { dispatchPoWorkflowNotification } from "../notify/index.js";
import { buildPoWorkflowDesignPrompt, buildDesignerReviewPrompt, poLoc } from "./prompt.js";
import { t } from "./i18n/t.js";

/** 설계 산출 노드/간선 상한 — 폭주 산출 방어 (엔진 MAX_NODES 보다 훨씬 작게). */
const MAX_DESIGN_NODES = 20;
const MAX_DESIGN_EDGES = 40;

/**
 * 동시 run-worktree 상한 (po_run_worktree_v1). per-run worktree 는 작업트리 파일을 통째로
 * 복제하므로(디스크 비용), 동시에 살아있는 격리 run 수를 막아 폭주를 방어한다. 상한에 닿으면
 * 조용히 공유 repo 로 폴백하지 않고(그게 충돌 버그의 원인) 명시 실패로 승인을 거절한다.
 * 실패/완료한 run 의 worktree 정리(GC)는 별 brief(reaper)가 닫는다 — 그전까지 이 상한이
 * 디스크 누수의 천장이다 (reaper 와 한 릴리스로 묶음).
 */
const MAX_CONCURRENT_RUN_WORKTREES = 8;

/** run 감시 폴 간격 / 상한 — 게이트는 사람이 며칠 뒤 승인할 수 있어 넉넉히. */
const WATCH_INTERVAL_MS = 5_000;
const WATCH_MAX_MS = 7 * 24 * 60 * 60 * 1000;

export type PoBriefForWorkflow = {
  id: string;
  repo_path: string;
  title: string;
  problem: string;
  scope: string;
  spec: string;
};

/**
 * 사람 승인 게이트(머지) 노드의 prompt — AI 설계 자동 삽입과 fallback 템플릿이 공유한다.
 *
 * «커밋까지» 로 축소한다 — 작업 브랜치를 기본 브랜치로 합치는 «재결합» 은 게이트가 직접
 * git merge 로 하지 않고, 게이트 승인+커밋이 끝나면 daemon 이 작업 브랜치를 MergeQueue 에
 * 올려 직렬로(사전 충돌 탐지·머지 후 정리 포함) 처리한다. 자연어 머지의 비신뢰(직렬 미보장·
 * force-push·충돌로 멈춤)를 제거하는 게 이 노드의 핵심 변경이다.
 */
export function buildGatePrompt(briefTitle: string, locale?: string): string {
  return t("wf.gate.body", poLoc(locale), { briefTitle });
}

/**
 * 설계 에이전트 산출 → 화이트리스트 통과 정의. 위험/무관 필드는 daemon 이 결정한다:
 *   - `skip_permissions` 는 항상 true (무인 실행 — 산출값 무시. 화이트리스트 강제)
 *   - `agent` 는 등록된 id 만, 아니면 defaultAgent
 *   - `triggers` / `repo_path` / `result_spec` 은 버린다 (AI 가 크론 등록·타 레포 실행을 만들 수 없게)
 * 형식이 아예 아니면 null — 호출부가 fallback 으로 간다.
 */
export function sanitizeDesignedDef(
  raw: unknown,
  opts: { defaultAgent: string; isValidAgent: (id: string) => boolean },
): { nodes: unknown[]; edges: unknown[] } | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as { nodes?: unknown; edges?: unknown };
  if (!Array.isArray(o.nodes) || !Array.isArray(o.edges)) return null;

  const nodes: unknown[] = [];
  for (const n of o.nodes.slice(0, MAX_DESIGN_NODES)) {
    if (!n || typeof n !== "object") continue;
    const x = n as Record<string, unknown>;
    if (typeof x.id !== "string" || typeof x.type !== "string") continue;
    const isTask = x.type === "task" || x.type === "general" || x.type === "test";
    const agent =
      isTask && typeof x.agent === "string" && opts.isValidAgent(x.agent)
        ? x.agent
        : isTask
          ? opts.defaultAgent
          : undefined;
    nodes.push({
      id: x.id.slice(0, 80),
      type: x.type,
      title: typeof x.title === "string" ? x.title.slice(0, 120) : undefined,
      prompt: isTask && typeof x.prompt === "string" ? x.prompt.slice(0, 16000) : undefined,
      agent,
      // 화이트리스트: 무인 워크플로우 실행이라 daemon 이 항상 true 로 강제 (산출값 무시).
      skip_permissions: isTask ? true : undefined,
      requires_approval: x.requires_approval === true ? true : undefined,
      x: typeof x.x === "number" && Number.isFinite(x.x) ? x.x : undefined,
      y: typeof x.y === "number" && Number.isFinite(x.y) ? x.y : undefined,
    });
  }
  if (nodes.length === 0) return null;

  const edges: unknown[] = [];
  for (const e of o.edges.slice(0, MAX_DESIGN_EDGES)) {
    if (!e || typeof e !== "object") continue;
    const x = e as Record<string, unknown>;
    if (typeof x.from !== "string" || typeof x.to !== "string") continue;
    edges.push({
      id: typeof x.id === "string" ? x.id.slice(0, 80) : `${x.from}->${x.to}`,
      from: x.from,
      to: x.to,
      condition: x.condition === "fail" ? "fail" : undefined,
    });
  }
  return { nodes, edges };
}

/**
 * end 도달 전 `requires_approval` 사람 게이트 최소 1개 보장 — 없으면 자동 삽입.
 * AI 가 게이트를 빼먹어도 무인 머지가 불가능해야 한다 (거부하지 않고 고쳐 쓴다).
 * end 노드가 없으면 만들어 붙인다 (게이트를 «종료 직전» 에 둘 자리 확보).
 */
export function ensureHumanGate(
  def: WorkflowDef,
  gate: { prompt: string; agent: string },
): WorkflowDef {
  if (def.nodes.some((n) => n.type === "task" && n.requires_approval === true)) {
    return def;
  }
  const ids = new Set(def.nodes.map((n) => n.id));
  const uniq = (base: string): string => {
    let id = base;
    let i = 2;
    while (ids.has(id)) id = `${base}_${i++}`;
    ids.add(id);
    return id;
  };
  const maxY = Math.max(0, ...def.nodes.map((n) => n.y ?? 0));

  const nodes = [...def.nodes];
  let edges = [...def.edges];

  let ends = nodes.filter((n) => n.type === "end");
  if (ends.length === 0) {
    const endNode: NodeDef = {
      id: uniq("end"),
      type: "end",
      title: "종료",
      x: 60,
      y: maxY + 340,
    };
    // end 가 없으면 «꼬리»(나가는 무조건 간선이 없는 비-end 노드)들을 end 로 이어 줄 자리를 만든다.
    const hasForwardOut = (id: string) =>
      edges.some((e) => e.from === id && e.condition !== "fail");
    const tails = nodes.filter((n) => n.type !== "end" && !hasForwardOut(n.id));
    nodes.push(endNode);
    for (const t of tails) {
      edges.push({ id: `e_${t.id}_end`, from: t.id, to: endNode.id });
    }
    ends = [endNode];
  }

  const endIds = new Set(ends.map((n) => n.id));
  const gateNode: NodeDef = {
    id: uniq("po_gate"),
    type: "task",
    title: "머지 승인 게이트",
    prompt: gate.prompt,
    agent: gate.agent,
    skip_permissions: true,
    requires_approval: true,
    x: ends[0].x ?? 60,
    y: (ends[0].y ?? maxY + 340) - 170,
  };
  // end 로 들어가던 모든 간선을 게이트로 돌리고, 게이트 → 첫 end 한 줄만 잇는다.
  edges = edges.map((e) => (endIds.has(e.to) ? { ...e, to: gateNode.id } : e));
  nodes.push(gateNode);
  edges.push({ id: `e_${gateNode.id}_end`, from: gateNode.id, to: ends[0].id });
  return { nodes, edges };
}

/**
 * 기본 템플릿 — 설계 실패/타임아웃/검증 실패 시의 fallback.
 * ①스펙 확정(브리프 spec → 레포의 스펙/문서 컨벤션을 따라 저장) ②구현 ③자가검증(레포의
 * 기존 검증 수단, 실패 시 구현으로 fail 루프) ④디자이너 리뷰(스크린샷→SSOT 대비 비평→
 * findings, UI 무관이면 자가 생략·통과) ⑤사람 승인 게이트(머지) → 종료.
 *
 * 디자이너 리뷰는 게이트의 «직전» 노드라 findings 가 게이트의 입력 evidence 로 흘러간다
 * (Task 폴더가 게이트의 부모 폴더). «증거 수집» 전용이라 fail 간선이 없다 — 회귀를 자동
 * 차단하지 않고 사람이 결재 때 본다. UI 표면이 없는 브리프면 노드 prompt 의 0단계가 빌드/
 * 스크린샷 없이 즉시 통과시킨다 (buildDesignContext 와 같은 «항상 두되 내부에서 게이트» 철학).
 */
export function buildPoFallbackDef(
  brief: PoBriefForWorkflow,
  agentId: string,
  designDirective?: string,
  locale?: string,
): WorkflowDef {
  const loc = poLoc(locale);
  const briefBody = t("wf.fallback.briefBody", loc, {
    title: brief.title,
    problem: brief.problem,
    scope: brief.scope,
    spec: brief.spec,
  });

  const task = (
    id: string,
    title: string,
    prompt: string,
    y: number,
    requiresApproval = false,
  ): NodeDef => ({
    id,
    type: "task",
    title,
    prompt,
    agent: agentId,
    skip_permissions: true,
    requires_approval: requiresApproval || undefined,
    x: 60,
    y,
  });

  const nodes: NodeDef[] = [
    { id: "start", type: "start", title: t("wf.node.start", loc), x: 60, y: 40 },
    task("spec", t("wf.node.spec", loc), t("wf.fallback.spec", loc, { briefBody }), 210),
    task("impl", t("wf.node.impl", loc), t("wf.fallback.impl", loc, { briefBody }), 380),
    task("verify", t("wf.node.verify", loc), t("wf.fallback.verify", loc, { briefBody }), 550),
    // 디자이너 리뷰 — 렌더된 화면을 디자인 SSOT 대비 비평해 findings 를 게이트로 «공급». UI
    // 무관 브리프면 노드 prompt 의 0단계가 빌드 없이 즉시 통과시킨다 (always-두되 내부 게이트).
    task(
      "design_review",
      t("wf.node.designReview", loc),
      buildDesignerReviewPrompt({ briefTitle: brief.title, designDirective, locale }),
      720,
    ),
    task("gate", t("wf.node.gate", loc), buildGatePrompt(brief.title, locale), 890, true),
    { id: "end", type: "end", title: t("wf.node.end", loc), x: 60, y: 1060 },
  ];
  const edges: EdgeDef[] = [
    { id: "e1", from: "start", to: "spec" },
    { id: "e2", from: "spec", to: "impl" },
    { id: "e3", from: "impl", to: "verify" },
    // 자가검증 통과 → 디자이너 리뷰 → 게이트 (디자이너 리뷰가 게이트의 직전 = 입력 evidence).
    { id: "e4", from: "verify", to: "design_review" },
    // 자가검증 실패 → 구현으로 되돌아가는 재시도 루프 (엔진 MAX_ITERATIONS 가 bound).
    { id: "e5", from: "verify", to: "impl", condition: "fail" },
    // 디자이너 리뷰는 «증거 수집» 전용 — fail 간선 없이 게이트로 통과만 (자동 차단 아님).
    { id: "e6", from: "design_review", to: "gate" },
    { id: "e7", from: "gate", to: "end" },
  ];
  return { nodes, edges };
}

export type PoWorkflowApprovalResult =
  | { status: "running"; sessionId: string }
  | { status: "error"; error: string };

/**
 * «워크플로우로 실행» 승인 — per-run 격리 worktree 를 만들고, 그 안에서 도는 설계 에이전트
 * 세션을 띄운 뒤 반환한다 (iOS 가 sessionId 로 설계 과정을 관전). 설계 ingest → 검증 → run
 * 생성은 백그라운드이며 모든 노드가 같은 worktree 에서 돈다.
 *
 * 격리 (po_run_worktree_v1): run 의 모든 노드 세션이 공유 repo(defRepoPath)에서 돌면 동시
 * run 이 같은 작업트리·git 인덱스를 밟아 충돌한다. 그래서 승인 «즉시» `po/<id8>` worktree 를
 * 만들고(세션 모드 po_worktree_v1·po.ts 와 동일 createWorktree 헬퍼 재사용) 설계 세션 + 모든
 * 노드의 cwd 를 그 worktree 로 고정한다. worktree 생성 실패는 «조용한 shared-dir 폴백 금지» —
 * 그게 충돌 버그의 원인이므로 run 을 만들지 않고 명시 실패로 거절한다 (브리프는 그대로 두어
 * 사용자가 원인을 보고 재시도). createWorktree 가 git 을 거치므로 약간의 지연이 있지만 세션
 * 모드 승인과 동일한 트레이드오프다.
 *
 * worktree 생성 외의 단계(설계 ingest/검증/run 시작)는 절대 throw 하지 않고 어떤 실패에도
 * fallback 템플릿으로 run 을 만들어 낸다.
 */
export async function startPoWorkflowApproval(
  brief: PoBriefForWorkflow,
  agentIdRaw?: string,
  locale?: string,
): Promise<PoWorkflowApprovalResult> {
  const dir = resolveAndEnsureRepoDir(brief.repo_path);
  if ("error" in dir) return { status: "error", error: dir.error };
  const repoPath = dir.path;

  const agentId = agentIdRaw || "claude_code";
  if (!hasAgent(agentId)) return { status: "error", error: `에이전트 없음: ${agentId}` };

  // 동시 run-worktree 상한 — 디스크 폭주 방어 (worktree 는 작업트리 파일 복제). 상한이면
  // 조용히 공유 repo 로 폴백하지 않고 명시 실패. GC(reaper brief)가 끝난 run 의 worktree 를
  // 정리하면 자리가 빈다.
  const activeWorktrees = countActiveWorktreeRuns();
  if (activeWorktrees >= MAX_CONCURRENT_RUN_WORKTREES) {
    return {
      status: "error",
      error: `동시 워크플로우 worktree 상한(${MAX_CONCURRENT_RUN_WORKTREES}) 도달 — 진행 중 run 이 끝난 뒤 다시 시도하세요`,
    };
  }

  // per-run worktree 생성 — `po/<id8>` 새 브랜치. 세션 모드(po.ts:716)와 같은 헬퍼·브랜치
  // 규칙. 실패(target_exists/mkdir_failed/worktree_add_failed/타임아웃)는 shared-dir 폴백 없이
  // 명시 실패 — 브리프를 건드리지 않아 사용자가 사유를 보고 재시도할 수 있다 («run 을 만들지 않음»).
  const branch = `po/${brief.id.slice(0, 8)}`;
  const wt = await createWorktree(repoPath, { branch, newBranch: true });
  if (!wt.ok) {
    return {
      status: "error",
      error: `worktree 생성 실패(${wt.body.error}): ${wt.body.message ?? branch}`,
    };
  }
  const worktree = { path: wt.path, branch };
  console.log(`[po] workflow run worktree created brief=${brief.id} branch=${branch} path=${wt.path}`);

  // 무인 trifecta(capability_caps C1/M3·C2) — 설계 세션·모든 노드가 이 격리 worktree 에서 돈다.
  // 그 `.mcp.json` 을 READ/LOCAL 만 남게 다시 써서 EGRESS·SOURCE_WRITE 도구를 «미연결» 로 둔다.
  prepareUnattendedCwd(worktree.path, { isolated: true });

  // 설계 세션 + 모든 노드가 worktree 에서 돈다 (공유 repo 아님).
  const sessionId = createSession(
    worktree.path,
    t("wf.session.designLabel", poLoc(locale), { title: brief.title }).slice(0, 120),
    undefined,
    true,
    agentId,
  );
  // 오염 전파(capability_caps T1) — worktree 의 cwd 로는 원본 repo 의 MCP 가 안 잡히므로, 원본
  // repo 에 개인-데이터 MCP 가 연결돼 있으면 이 worktree 세션을 명시적으로 오염 표시한다.
  if (computeInitialTaint(repoPath)) markSessionTainted(sessionId, "worktree:origin-mcp");
  const outFile = path.join(os.tmpdir(), `ps-po-wf-${sessionId}.json`);
  // 설계 노드들이 쓸 수 있는 에이전트 — 무인 실행 적합(cron_eligible_v1)만 후보로 준다.
  const eligible = listAgents()
    .filter((a) => a.capabilities().includes("cron_eligible_v1"))
    .map((a) => a.id);
  // 디자인 컨텍스트 선언 — 수집과 동형. 있으면 「디자인 제약」 섹션에 그대로, 없으면 자동 발견.
  // 설계 노드 prompt 가 색 의미·로케일 집합·상태·접근성을 담도록 이 컨텍스트를 주입한다.
  const designDirective = (
    db()
      .prepare(`SELECT design_directive FROM po_profiles WHERE repo_path = ?`)
      .get(repoPath) as { design_directive: string | null } | undefined
  )?.design_directive;
  const prompt = buildPoWorkflowDesignPrompt({
    brief,
    outFile,
    agentIds: eligible.length > 0 ? eligible : [agentId],
    defaultAgent: agentId,
    designDirective: designDirective ?? undefined,
    locale,
  });

  console.log(`[po] workflow design start brief=${brief.id} session=${sessionId} agent=${agentId}`);
  void finalizeWorkflowApproval(
    brief,
    sessionId,
    repoPath,
    worktree,
    outFile,
    prompt,
    agentId,
    designDirective ?? undefined,
    locale,
  ).catch((e) =>
    console.warn(`[po] workflow finalize failed brief=${brief.id}:`, (e as Error).message),
  );
  return { status: "running", sessionId };
}

/** 설계 세션 settle → 산출 ingest(sanitize+게이트 강제+validateDef, 실패 시 fallback) → run 생성 + 감시. */
async function finalizeWorkflowApproval(
  brief: PoBriefForWorkflow,
  sessionId: string,
  /** 실제 레포 절대경로 — 저장되는 워크플로우 자산(insertWorkflow)의 repo_path (재사용 가능). */
  repoPath: string,
  /** per-run 격리 worktree — 설계 세션 cwd + run 의 모든 노드 cwd + run 행 기록(po_run_worktree_v1). */
  worktree: { path: string; branch: string },
  outFile: string,
  prompt: string,
  agentId: string,
  /** po_profiles.design_directive — fallback 의 디자이너 리뷰 노드에 전달 (없으면 자동 발견). */
  designDirective?: string,
  /** 산출 언어 (po_locale_v1) — 게이트·fallback 노드 프롬프트를 앱 언어로. */
  locale?: string,
): Promise<void> {
  markCronSession(sessionId);
  let note: string | null = null;
  try {
    const settle = waitForSessionSettle(sessionId);
    void runUserMessagePty(
      // 설계 세션도 worktree 에서 돈다 (공유 repo 아님 — 브리프 수용 기준 ①).
      { sessionId, cwd: worktree.path, adapter: getAgent(agentId) },
      prompt,
      { bypassPermissions: true },
    ).catch((e) => {
      console.warn(`[po] design runUserMessagePty failed session=${sessionId}:`, (e as Error).message);
    });
    const result = await settle;

    abortPtySession(sessionId);
    await awaitPtyExit(sessionId, 4000);
    db()
      .prepare(`UPDATE sessions SET status = ?, ended_at = ? WHERE id = ?`)
      .run(result.status === "error" ? "error" : "completed", Date.now(), sessionId);

    // ① 설계 산출 ingest — 어느 단계가 실패해도 def 는 fallback 으로 채워진다.
    let def: WorkflowDef | null = null;
    if (result.status !== "ok") {
      note = `AI 설계 실패(${result.status}) — 기본 워크플로우 사용`;
    } else {
      let raw: unknown = null;
      try {
        raw = JSON.parse(fs.readFileSync(outFile, "utf8"));
      } catch {
        note = "AI 설계 실패(산출 파일 없음/JSON 파싱 실패) — 기본 워크플로우 사용";
      }
      if (raw != null) {
        const sanitized = sanitizeDesignedDef(raw, {
          defaultAgent: agentId,
          isValidAgent: hasAgent,
        });
        if (!sanitized) {
          note = "AI 설계 실패(스키마 불일치) — 기본 워크플로우 사용";
        } else {
          const valid = validateDef(sanitized.nodes, sanitized.edges);
          if (!valid.ok) {
            note = `AI 설계 실패(${valid.error}) — 기본 워크플로우 사용`;
          } else {
            // ② 사람 게이트 강제 — 게이트 자동 삽입 후 재검증 (삽입이 그래프를 깨면 fallback).
            const gated = ensureHumanGate(valid.def, {
              prompt: buildGatePrompt(brief.title, locale),
              agent: agentId,
            });
            const revalid = validateDef(gated.nodes, gated.edges);
            if (revalid.ok) {
              def = revalid.def;
            } else {
              note = `AI 설계 실패(게이트 삽입 후 검증 실패: ${revalid.error}) — 기본 워크플로우 사용`;
            }
          }
        }
      }
    }
    if (!def) def = buildPoFallbackDef(brief, agentId, designDirective, locale);

    // ③ «PO: <제목>» 워크플로우로 저장 — 캔버스에서 열람/수정 가능한 재사용 자산.
    // repo_path 는 «실제 레포» (worktree 아님) — 저장된 자산을 나중에 다시 돌릴 때 살아있는
    // 레포를 가리켜야 한다. 격리 worktree 는 run 한정 오버라이드로만 쓴다 (아래 startWorkflowRun).
    const wf = insertWorkflow({
      title: `PO: ${brief.title}`.slice(0, 120),
      repoPath,
      nodes: JSON.stringify(def.nodes),
      edges: JSON.stringify(def.edges),
      enabled: true,
    });
    // suppressNotify — PO run 은 watchPoWorkflowRun 이 po_gate/po_failed 를 쏜다. 엔진의
    // workflow_* 알림을 끄지 않으면 게이트/실패에서 이중 발화된다 (브리프 수용 기준).
    // worktree — 이 run 의 모든 노드 cwd 를 격리 worktree 로 고정 + run 행에 경로/브랜치 기록.
    const run = startWorkflowRun(wf, "manual", { suppressNotify: true, worktree });
    if ("error" in run) {
      // validateDef 통과 정의라 사실상 도달 불가 — 그래도 브리프에 흔적은 남긴다.
      note = `워크플로우 실행 시작 실패: ${run.error}`;
      db()
        .prepare(`UPDATE po_briefs SET exec_workflow_id = ?, exec_note = ?, updated_at = ? WHERE id = ?`)
        .run(wf.id, note, Date.now(), brief.id);
      void dispatchPoWorkflowNotification({
        kind: "po_failed",
        repoPath,
        briefId: brief.id,
        briefTitle: brief.title,
        sessionId,
      });
      return;
    }

    db()
      .prepare(
        `UPDATE po_briefs SET exec_workflow_id = ?, exec_run_id = ?, exec_note = ?, updated_at = ? WHERE id = ?`,
      )
      .run(wf.id, run.runId, note, Date.now(), brief.id);
    console.log(
      `[po] workflow approved brief=${brief.id} workflow=${wf.id} run=${run.runId}${note ? ` (${note})` : ""}`,
    );
    watchPoWorkflowRun(brief.id, brief.title, repoPath, run.runId);
  } finally {
    unmarkCronSession(sessionId);
    try {
      fs.rmSync(outFile, { force: true });
    } catch {
      /* best-effort */
    }
  }
}

// ── 게이트 승인 → 머지 큐 enqueue (재결합) ──────────────────────────────────────
//
// 게이트 노드는 «커밋까지» 만 하고(buildGatePrompt), 작업 브랜치를 기본 브랜치로 합치는
// «재결합» 은 daemon 이 MergeQueue 에 올려 직렬로 처리한다 — 세션/에이전트가 «직접 머지 말고
// enqueue» 하는 계약을 워크플로우 게이트도 따르게 하는 것이 이 절의 목적이다 (자연어 머지의
// 직렬 미보장·force-push·충돌로 멈춤 제거). 충돌/실패는 큐의 기존 보장(markConflict + 큐 계속,
// /api/merge-queue/:id/retry 재시도, reconcileStaleProcessing 회수)을 그대로 탄다.

/** po_briefs.exec_note 갱신 (브리프 상세에 표시되는 진행 메모). */
function setPoBriefNote(briefId: string, note: string): void {
  db()
    .prepare(`UPDATE po_briefs SET exec_note = ?, updated_at = ? WHERE id = ?`)
    .run(note, Date.now(), briefId);
}

/** running 브리프를 shipped 로 (가드된 UPDATE — 그새 다른 전이가 있었으면 no-op). */
function shipPoBrief(briefId: string, runId: string, logSuffix = ""): void {
  const info = db()
    .prepare(`UPDATE po_briefs SET status = 'shipped', updated_at = ? WHERE id = ? AND status = 'running'`)
    .run(Date.now(), briefId);
  if (info.changes > 0) {
    console.log(`[po] brief shipped (workflow) id=${briefId} run=${runId}${logSuffix ? ` ${logSuffix}` : ""}`);
  }
}

/**
 * 격리 작업 브랜치(source)를 기본 브랜치(target)로 큐에 올릴지 판정 — «서로 다를» 때만.
 * 같으면(선행 per-run worktree 미도입 → 작업 브랜치 == 기본 브랜치) 커밋이 이미 기본 브랜치에
 * 있어 머지할 게 없다. 비유효 ref 도 안 올린다(머지 큐가 어차피 거르지만 미리 거른다).
 */
export function shouldEnqueueGateMerge(
  source: string | null | undefined,
  target: string | null | undefined,
): boolean {
  if (!source || !target) return false;
  if (!isValidRef(source) || !isValidRef(target)) return false;
  return source !== target;
}

/**
 * run 의 «사람 승인 게이트» 노드가 돈 세션 + 작업트리 경로를 찾는다 (머지 enqueue 의 출처).
 * requires_approval def 노드 중 done 으로 끝나 세션을 만든 노드를 고른다 (게이트가 여럿이면
 * 가장 마지막에 끝난 것 — 보통 머지 게이트가 종료 직전). 세션 repo_path 가 격리 worktree 면
 * 그 안에서 작업 브랜치를 읽게 된다. 세션/경로를 못 찾으면 null.
 */
export function resolveGateSession(
  nodeRuns: WorkflowNodeRunRow[],
  def: WorkflowDef,
): { sessionId: string; repoPath: string } | null {
  const gateDefIds = new Set(
    def.nodes.filter((n) => n.requires_approval === true).map((n) => n.id),
  );
  if (gateDefIds.size === 0) return null;
  const gate = nodeRuns
    .filter(
      (nr) =>
        nr.def_node_id != null &&
        gateDefIds.has(nr.def_node_id) &&
        nr.status === "done" &&
        nr.session_id != null,
    )
    .sort((a, b) => (b.ended_at ?? 0) - (a.ended_at ?? 0))[0];
  if (!gate || !gate.session_id) return null;
  const row = db()
    .prepare(`SELECT repo_path FROM sessions WHERE id = ?`)
    .get(gate.session_id) as { repo_path: string } | undefined;
  if (!row?.repo_path) return null;
  return { sessionId: gate.session_id, repoPath: row.repo_path };
}

export type GateMergePlan =
  | { kind: "enqueued"; requestId: string; sourceBranch: string; targetBranch: string }
  | { kind: "skip"; reason: string };

/**
 * 게이트 승인+커밋 후 — run 의 격리 작업 브랜치를 기본 브랜치로 합치도록 MergeQueue 에
 * enqueue(cleanup=1)하고 kick 한다 (직렬 처리·사전 충돌 탐지·머지 후 worktree/브랜치 정리는
 * 큐가 담당). 격리 브랜치가 없으면(작업 브랜치 == 기본 브랜치 = 선행 worktree 미도입) skip —
 * 커밋이 이미 기본 브랜치에 있어 합칠 게 없다. 절대 throw 하지 않는다 (실패는 skip 으로 흡수).
 */
export async function enqueueGateMerge(args: {
  /** merge_request.repo_path — 워크플로우(=run) 메인 레포. iOS 격리 배지가 이 키로 큐를 조회한다. */
  repoPath: string;
  /** 게이트가 실제로 돈 작업트리 — 격리 worktree 면 그 경로(작업 브랜치를 여기서 읽는다). */
  sourceRepoPath: string;
  /** 게이트 노드 세션 — iOS 가 머지요청을 이 run 에 귀속시키는 키 (sessionId 교차). */
  sessionId: string | null;
}): Promise<GateMergePlan> {
  try {
    const sourceBranch = (await gitRepoInfo(args.sourceRepoPath)).branch;
    const targetBranch = await defaultBranch(args.repoPath);
    if (!shouldEnqueueGateMerge(sourceBranch, targetBranch)) {
      return {
        kind: "skip",
        reason: `격리 브랜치 없음 (source=${sourceBranch ?? "?"} target=${targetBranch ?? "?"})`,
      };
    }
    if (!(await gitRepoInfo(args.repoPath)).isRepo) {
      return { kind: "skip", reason: "not_a_repo" };
    }
    const row = insertMergeRequest({
      repoPath: args.repoPath,
      sourceBranch: sourceBranch!,
      targetBranch: targetBranch!,
      sessionId: args.sessionId,
      cleanup: true, // 머지 성공 후 source worktree+브랜치 회수 — 디스크 누적 방지(브리프 비용·확장).
      noFF: false, // 머지 전략(ff/--no-ff)은 큐 기본을 따른다 (브리프 비-목표: 전략 정책 변경 안 함).
    });
    getMergeQueue().kick();
    return {
      kind: "enqueued",
      requestId: row.id,
      sourceBranch: sourceBranch!,
      targetBranch: targetBranch!,
    };
  } catch (e) {
    return { kind: "skip", reason: `enqueue 실패: ${(e as Error).message}` };
  }
}

/**
 * 게이트 머지 enqueue 후 — 머지 큐가 그 요청을 종결할 때까지 폴링해 브리프를 마감한다:
 *   merged/up_to_date → shipped, conflict → exec_note(충돌 파일)+po_failed 알림(큐는 계속·재시도
 *   가능), failed → exec_note+po_failed 알림, cancelled → exec_note. 직접 머지가 아니라 큐 «상태»
 *   만 관측한다 (재결합 실행은 전적으로 큐 책임).
 * in-memory 라 daemon 재시작 시 끊긴다 — 큐 자체는 영속(reconcileStaleProcessing 이 처리 중 죽은
 * 항목을 회수)이라 머지·정리는 끝나고, 사용자는 머지 배지/캔버스로 상태를 본다 (watchPoWorkflowRun
 * 과 같은 폴링 정책). timer.unref 로 프로세스를 붙잡지 않는다.
 */
function watchMergeSettle(
  requestId: string,
  briefId: string,
  briefTitle: string,
  repoPath: string,
  runId: string,
): void {
  const startedAt = Date.now();
  const timer = setInterval(() => {
    try {
      const mr = getMergeRequest(requestId);
      if (!mr || Date.now() - startedAt > WATCH_MAX_MS) {
        clearInterval(timer);
        return;
      }
      if (mr.status === "queued" || mr.status === "processing") return; // 아직 처리 중 — 계속 폴링.
      clearInterval(timer);

      if (mr.status === "merged") {
        shipPoBrief(briefId, runId, `(merged req=${requestId})`);
        return;
      }
      if (mr.status === "conflict") {
        let files: string[] = [];
        try {
          const p = JSON.parse(mr.conflict_files ?? "[]");
          if (Array.isArray(p)) files = p.filter((x): x is string => typeof x === "string");
        } catch {
          /* 손상된 JSON — 파일 목록 없이 */
        }
        const tail = files.length > 0 ? ` (${files.slice(0, 5).join(", ")}${files.length > 5 ? " …" : ""})` : "";
        setPoBriefNote(
          briefId,
          `머지 충돌 — 작업 브랜치를 기본 브랜치로 합치지 못했어요${tail}. 머지 큐에서 재시도하거나 충돌을 해소하세요`,
        );
        void dispatchPoWorkflowNotification({ kind: "po_failed", repoPath, briefId, briefTitle });
        console.warn(
          `[po] workflow gate merge conflict brief=${briefId} req=${requestId} files=${files.slice(0, 10).join(",")}`,
        );
        return;
      }
      if (mr.status === "failed") {
        setPoBriefNote(
          briefId,
          `머지 실패 — ${mr.error ?? "알 수 없는 오류"}. 머지 큐에서 재시도하세요`,
        );
        void dispatchPoWorkflowNotification({ kind: "po_failed", repoPath, briefId, briefTitle });
        console.warn(`[po] workflow gate merge failed brief=${briefId} req=${requestId}: ${mr.error ?? ""}`);
        return;
      }
      // cancelled — 사용자가 큐에서 취소. 브리프는 running 유지 (사용자가 다시 올림).
      setPoBriefNote(briefId, "머지 요청이 취소됨 — 머지 큐에서 다시 올리세요");
    } catch (e) {
      console.warn(`[po] merge settle tick failed req=${requestId}:`, (e as Error).message);
    }
  }, WATCH_INTERVAL_MS);
  timer.unref?.();
}

/**
 * run 감시 (DB 폴링 — 엔진 무변경 정책):
 *   - 게이트(awaiting_approval) 도달 → po_gate 알림 1회 (딥링크 backlog/<briefId>).
 *   - run done — 게이트가 거부(skipped)됐으면 running 유지 + 메모(수정 지시 유도),
 *     아니면 게이트 승인+커밋이 끝난 것 → 작업 브랜치를 머지 큐에 올리고(enqueueGateMerge)
 *     머지가 종결될 때 shipped (격리 브랜치가 없으면 커밋이 이미 기본 브랜치라 즉시 shipped).
 *   - run failed (자가검증 fail 루프 소진 포함) → running 유지 + 메모 + po_failed 알림.
 *   - run cancelled → running 유지 + 메모.
 * in-memory 라 daemon 재시작 시 감시가 끊긴다 — 엔진도 재시작 시 run 을 failed 로
 * reconcile 하므로 사용자는 캔버스/브리프 메모로 상태를 추적할 수 있다.
 */
export function watchPoWorkflowRun(
  briefId: string,
  briefTitle: string,
  repoPath: string,
  runId: string,
): void {
  const notifiedGates = new Set<string>();
  const startedAt = Date.now();

  const setNote = (note: string) => setPoBriefNote(briefId, note);

  const timer = setInterval(() => {
    try {
      const run = getRun(runId);
      if (!run || Date.now() - startedAt > WATCH_MAX_MS) {
        clearInterval(timer);
        return;
      }
      const nodeRuns = listNodeRuns(runId);

      // 게이트 도달 알림 — «검증 완료 — 머지 승인 대기». 노드별 1회.
      for (const nr of nodeRuns) {
        if (nr.status === "awaiting_approval" && !notifiedGates.has(nr.id)) {
          notifiedGates.add(nr.id);
          void dispatchPoWorkflowNotification({
            kind: "po_gate",
            repoPath,
            briefId,
            briefTitle,
            nodeTitle: nr.title ?? undefined,
          });
        }
      }

      if (run.status === "running") return;
      clearInterval(timer);

      if (run.status === "done") {
        // 게이트 거부 판정 — requires_approval def 노드의 node_run 이 skipped 면 reject 경로.
        const def = parseSnapshot(run.def_snapshot);
        const gateDefIds = new Set(
          def.nodes.filter((n) => n.requires_approval === true).map((n) => n.id),
        );
        const rejected = nodeRuns.some(
          (nr) => nr.def_node_id && gateDefIds.has(nr.def_node_id) && nr.status === "skipped",
        );
        if (rejected) {
          // 게이트 reject — 머지하지 않고 멈춘다. 브리프는 running 유지 + 수정 지시 유도.
          setNote("머지 게이트에서 거부됨 — 워크플로우 캔버스에서 수정 후 재실행하거나 세션에서 직접 수습하세요");
          console.log(`[po] workflow run rejected at gate brief=${briefId} run=${runId}`);
          return;
        }
        // 게이트 승인+커밋 완료 — 작업 브랜치를 기본 브랜치로 «머지 큐» 에 올린다 (게이트가
        // 직접 git merge 하지 않는 계약). 격리 브랜치가 없으면(선행 worktree 미도입) 커밋이 이미
        // 기본 브랜치라 바로 shipped. enqueue 됐으면 머지 종결 시 watchMergeSettle 이 shipped.
        const gate = resolveGateSession(nodeRuns, def);
        void enqueueGateMerge({
          repoPath,
          sourceRepoPath: gate?.repoPath ?? repoPath,
          sessionId: gate?.sessionId ?? null,
        }).then((plan) => {
          if (plan.kind === "enqueued") {
            setNote(`머지 큐에 올림 — ${plan.sourceBranch} → ${plan.targetBranch} (대기 중)`);
            console.log(
              `[po] workflow gate merge enqueued brief=${briefId} req=${plan.requestId} ${plan.sourceBranch}→${plan.targetBranch}`,
            );
            watchMergeSettle(plan.requestId, briefId, briefTitle, repoPath, runId);
          } else {
            shipPoBrief(briefId, runId, `(merge skip: ${plan.reason})`);
          }
        });
        return;
      }

      if (run.status === "failed") {
        // 자가검증 fail 루프 소진(MAX_ITERATIONS) 등 — 브리프에 실패 표시 + po_failed 알림.
        setNote("워크플로우 실행 실패 — 자가검증 재시도가 소진됐거나 노드가 실패했어요. 캔버스에서 확인하세요");
        void dispatchPoWorkflowNotification({
          kind: "po_failed",
          repoPath,
          briefId,
          briefTitle,
        });
        console.warn(`[po] workflow run failed brief=${briefId} run=${runId}`);
        return;
      }

      // cancelled — 사용자가 정지. running 유지 (사용자가 수습).
      setNote("워크플로우 실행이 취소됨");
    } catch (e) {
      console.warn(`[po] workflow watch tick failed run=${runId}:`, (e as Error).message);
    }
  }, WATCH_INTERVAL_MS);
  // 테스트/종료 시 이 타이머가 프로세스를 붙잡지 않게.
  timer.unref?.();
}
