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
import { sanitizeDesignedDef } from "../po/workflow-exec.js";
import { validateDef, type NodeDef, type EdgeDef } from "./types.js";

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
}): StartDesignResult {
  sweepJobs();
  const dir = resolveAndEnsureRepoDir(opts.repoPath);
  if ("error" in dir) return { error: dir.error };
  const repoPath = dir.path;

  const agentId = opts.agentId || "claude_code";
  if (!hasAgent(agentId)) return { error: `에이전트 없음: ${agentId}` };

  const sessionId = createSession(
    repoPath,
    "🎨 워크플로우 설계 초안".slice(0, 120),
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
}): string {
  return `너는 이 저장소의 워크플로우 설계 에이전트다. 사용자가 «한 문장» 으로 만들고 싶은 멀티 에이전트 워크플로우를 설명했다. 그 의도를 실현하는 워크플로우(DAG) «초안» 을 설계하라. 코드를 수정하지 마라 — 레포를 읽어 맥락·검증 방법을 파악하는 조사만 하고, 산출은 워크플로우 정의 JSON 하나다.

## 사용자 설명 (만들고 싶은 워크플로우)
${opts.description}

## 설계 지침
- 사용자 의도를 «start → task … → end» 흐름으로 구체화하라. 각 task 는 «그 노드만 보는 새 에이전트 세션» 이 수행하는 하나의 일이다.
- 각 task 의 prompt 는 그 세션에 들어가는 «전체 지시» 다 — 필요한 컨텍스트를 prompt 안에 직접 담아라. 이전 노드의 결과물은 «Task 폴더» 로 자동 전달되니 "이전 단계 결과 폴더를 읽어라" 라고 지시하면 된다.
- task 가 실패할 수 있고 재시도가 의미 있으면, 그 task 의 «실패(fail)» 간선을 앞 task 로 이어 재시도 루프를 만들어라.
- 이건 «초안» 이다 — 사용자가 캔버스에서 검토·수정한 뒤 «직접» 저장/실행한다. 무인 자동 실행을 가정하지 마라.

## 정의 스키마 (이 형식 그대로)
노드(NodeDef): { "id": "고유 문자열", "type": "start" | "task" | "end", "title": "한 줄", "prompt": "task 필수 — 이 노드 세션에 보낼 전체 지시", "agent"?: ${JSON.stringify(opts.agentIds)} 중 하나 (생략 시 ${opts.defaultAgent}), "requires_approval"?: true (사람 승인 게이트가 필요한 노드만), "x": 숫자, "y": 숫자 }
간선(EdgeDef): { "id": "고유 문자열", "from": "노드 id", "to": "노드 id", "condition"?: "fail" }

규칙:
- start 노드 1개, end 노드 1개 필수. task 노드는 prompt 필수.
- 루프(뒤로 가는 간선)는 작업의 "fail" 간선으로만 — 그 외 간선으로 순환을 만들면 거부된다.
- 노드는 4±2개 정도로 — 과도하게 쪼개지 마라. 좌표는 위→아래 흐름으로 보기 좋게 (x 60~400, y 60 간격 170).

## 산출
다음 경로에 JSON «단일 객체» { "nodes": [...], "edges": [...] } 를 써라 (다른 곳에 쓰지 마라):
${opts.outFile}

파일을 쓴 뒤 «워크플로우 설계 완료» 한 줄로 끝내라.`;
}

// 타입 재노출 — 라우트가 NodeDef/EdgeDef 를 다룰 때 한 곳에서.
export type { NodeDef, EdgeDef };
