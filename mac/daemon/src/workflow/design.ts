// 워크플로우 «AI 초안» 설계 (workflow_design_v1).
//
// 배경: 캔버스에서 노드를 손으로 그리고 포트를 끌어 잇는 방식은 모바일 터치에서 불편하다.
// 사용자가 «만들고 싶은 걸 한 문장으로» 적으면, 설계 에이전트(po_workflow_v1 의 설계 경로와
// 같은 «자기 에이전트 CLI → tmp JSON 산출 → ingest» 계약)가 start/task/end + fail 간선 DAG
// «초안» 을 만든다. 이 초안은 «곧장 실행하지 않는다» — validateDef 로 구조만 검증해 iOS 캔버스에
// 띄우고, 사용자가 검토·미세수정한 뒤에만 저장/실행한다 (Zapier «draft not live» 원칙).
//
// PO 의 워크플로우 승인(po/workflow-exec.ts)과의 차이:
//   - PO 는 설계 후 «즉시» 워크플로우 저장 + run 시작 + 사람 게이트 강제 + 실패 시 fallback.
//   - 여기선 «초안만» 돌려준다 — 저장도 실행도 안 하고, 게이트 강제·fallback 도 없다(사용자가
//     캔버스에서 검토하므로). 산출 sanitize + validateDef 까지만 daemon 책임.
//
// 메인테이너 서버 0 유지: 설계는 전적으로 사용자 Mac 의 에이전트 CLI 가 수행한다.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { db } from "../db/index.js";
import { getAgent, hasAgent, listAgents } from "../agent/registry.js";
import { runUserMessagePty, abortPtySession, awaitPtyExit } from "../agent/pty-runner.js";
import { createSession, resolveAndEnsureRepoDir } from "../routes/sessions.js";
import { markCronSession, unmarkCronSession } from "../cron/registry.js";
import { waitForSessionSettle } from "../cron/executor.js";
import { sanitizeDesignedDef } from "../persona/workflow-exec.js";
import { validateDef, type NodeDef, type EdgeDef } from "./types.js";
import { poLoc } from "../persona/prompt.js";
import { t } from "../persona/i18n/t.js";

/** 진행 중/완료된 설계 작업의 in-memory 상태. designId = 설계 세션 id (1:1). */
type DesignStatus = "designing" | "ready" | "failed";

export type DesignJob = {
  sessionId: string;
  status: DesignStatus;
  /** ready 일 때만 — validateDef 통과한 초안. */
  nodes?: NodeDef[];
  edges?: EdgeDef[];
  /** failed 일 때만 — 사용자에게 보일 사유. */
  error?: string;
  createdAt: number;
};

/**
 * 초안은 사용자가 «곧» 받아 가는 단명 자산이라 in-memory 로 둔다 (daemon 재시작 시 사라져도
 * 사용자는 다시 «AI 초안» 을 누르면 된다 — run 과 달리 영속이 의미 없다). TTL 로 오래된 작업을
 * 청소해 메모리 누수를 막는다.
 */
const jobs = new Map<string, DesignJob>();
const JOB_TTL_MS = 30 * 60 * 1000;

function sweepJobs(): void {
  const now = Date.now();
  for (const [id, j] of jobs) {
    if (now - j.createdAt > JOB_TTL_MS) jobs.delete(id);
  }
}

export type StartDesignResult = { designId: string; sessionId: string } | { error: string };

/**
 * «한 문장으로 설명» → 설계 에이전트 세션을 spawn 하고 «즉시» designId 를 돌려준다 (iOS 가
 * 폴링으로 진행/결과를 받는다). 산출 ingest(sanitize + validateDef)는 백그라운드. 절대 throw
 * 하지 않는다 — 어떤 실패도 작업 상태를 failed 로 남길 뿐 호출(POST)은 성공한다.
 */
export function startWorkflowDesign(opts: {
  description: string;
  repoPath: string;
  agentId?: string;
  /** 산출 언어 (po_locale_v1) — 설계 프롬프트·세션 라벨을 앱 언어로. */
  locale?: string;
}): StartDesignResult {
  sweepJobs();
  const dir = resolveAndEnsureRepoDir(opts.repoPath);
  if ("error" in dir) return { error: dir.error };
  const repoPath = dir.path;

  const agentId = opts.agentId || "claude_code";
  if (!hasAgent(agentId)) return { error: `에이전트 없음: ${agentId}` };

  const sessionId = createSession(
    repoPath,
    t("wf.session.designDraftLabel", poLoc(opts.locale)).slice(0, 120),
    undefined,
    true,
    agentId,
  );
  jobs.set(sessionId, { sessionId, status: "designing", createdAt: Date.now() });

  const outFile = path.join(os.tmpdir(), `ps-wf-design-${sessionId}.json`);
  // 설계 노드들이 쓸 수 있는 에이전트 — 무인 실행 적합(cron_eligible_v1)만 후보로 준다
  // (po/workflow-exec.ts 와 같은 정책).
  const eligible = listAgents()
    .filter((a) => a.capabilities().includes("cron_eligible_v1"))
    .map((a) => a.id);
  const prompt = buildWorkflowDesignPrompt({
    description: opts.description,
    outFile,
    agentIds: eligible.length > 0 ? eligible : [agentId],
    defaultAgent: agentId,
    locale: opts.locale,
  });

  console.log(`[workflow] design start session=${sessionId} agent=${agentId}`);
  void finalizeDesign(sessionId, repoPath, outFile, prompt, agentId).catch((e) => {
    const job = jobs.get(sessionId);
    if (job) {
      job.status = "failed";
      job.error = `설계 처리 중 오류: ${(e as Error).message}`;
    }
    console.warn(`[workflow] design finalize failed session=${sessionId}:`, (e as Error).message);
  });
  return { designId: sessionId, sessionId };
}

/** 설계 세션 settle → 산출 ingest(sanitize + validateDef) → 작업 상태 ready/failed 로 확정. */
async function finalizeDesign(
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
      console.warn(`[workflow] design runUserMessagePty failed session=${sessionId}:`, (e as Error).message);
    });
    const result = await settle;

    abortPtySession(sessionId);
    await awaitPtyExit(sessionId, 4000);
    db()
      .prepare(`UPDATE sessions SET status = ?, ended_at = ? WHERE id = ?`)
      .run(result.status === "error" ? "error" : "completed", Date.now(), sessionId);

    const job = jobs.get(sessionId);
    if (!job) return; // TTL 로 청소됨 — 사용자가 이미 떠났다.
    const fail = (msg: string) => {
      job.status = "failed";
      job.error = msg;
    };

    if (result.status !== "ok") {
      return fail(`설계 에이전트가 끝내지 못했어요 (${result.status})`);
    }
    let raw: unknown = null;
    try {
      raw = JSON.parse(fs.readFileSync(outFile, "utf8"));
    } catch {
      return fail("설계 결과 파일이 없거나 JSON 파싱에 실패했어요");
    }
    const sanitized = sanitizeDesignedDef(raw, { defaultAgent: agentId, isValidAgent: hasAgent });
    if (!sanitized) return fail("설계 결과 형식이 올바르지 않아요");
    // 초안이라도 캔버스에 띄우기 전 구조 검증은 거친다 (스펙: validateDef 후 «초안» 으로 표시).
    const valid = validateDef(sanitized.nodes, sanitized.edges);
    if (!valid.ok) return fail(valid.error);

    job.nodes = valid.def.nodes;
    job.edges = valid.def.edges;
    job.status = "ready";
    console.log(
      `[workflow] design ready session=${sessionId} nodes=${valid.def.nodes.length} edges=${valid.def.edges.length}`,
    );
  } finally {
    unmarkCronSession(sessionId);
    try {
      fs.rmSync(outFile, { force: true });
    } catch {
      /* best-effort */
    }
  }
}

/** 설계 작업 상태 조회 (폴링). 없으면(미존재/TTL 만료) null. */
export function getWorkflowDesign(designId: string): DesignJob | null {
  sweepJobs();
  return jobs.get(designId) ?? null;
}

/**
 * 설계 에이전트 프롬프트 — «한 문장» 을 입력으로 start/task/end + fail 간선 DAG 초안을 만든다.
 * po/prompt.ts 의 buildPoWorkflowDesignPrompt 와 같은 산출 계약(단일 객체 { nodes, edges } 를
 * outFile 에 기록)·같은 스키마·같은 sanitize 규칙을 쓰되, PO 의 «스펙확정→구현→머지게이트»
 * 골격을 강제하지 않는다 — 사용자가 임의 워크플로우를 설명할 수 있고, 초안이라 사람 게이트도
 * 사용자가 캔버스에서 직접 넣는다.
 */
export function buildWorkflowDesignPrompt(opts: {
  description: string;
  outFile: string;
  /** 노드 agent 필드에 쓸 수 있는 등록된 에이전트 id 들 (이외 값은 daemon 이 기본값으로 교체). */
  agentIds: string[];
  /** 노드 기본 에이전트. */
  defaultAgent: string;
  /** 산출 언어 (선택, po_locale_v1) — 누락/ko/미지원이면 ko verbatim. */
  locale?: string;
}): string {
  return t("wf.design.body", poLoc(opts.locale), {
    description: opts.description,
    agentIds: JSON.stringify(opts.agentIds),
    defaultAgent: opts.defaultAgent,
    outFile: opts.outFile,
  });
}

// 타입 재노출 — 라우트가 NodeDef/EdgeDef 를 다룰 때 한 곳에서.
export type { NodeDef, EdgeDef };
