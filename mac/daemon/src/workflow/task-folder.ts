/**
 * «Task 폴더» 계약 — 노드 간 결과물 전달의 인터페이스 (docs/ARCHITECTURE.md §12.2).
 *
 * 워크플로우 / run / 노드 3단으로 중첩해 «어느 워크플로우의 어느 run 인지» 폴더만 봐도 안다:
 *
 *   <repo>/.posiworkflow/
 *     <wf-slug>--<wfId8>/                 워크플로우 (같은 wf 의 모든 run 이 여기 모임)
 *       <YYYYMMDD-HHMMSS>--<runId8>/       run (시작시각 + 짧은 id)
 *         _run.json                        run 메타 (워크플로우·run·trigger·시각) — DB 없이 식별
 *         <node-slug>--<nodeRunId8>/       노드 (사람용 slug + 충돌 방지 짧은 id)
 *         ├── result.md      (필수) 사람·다음 노드가 읽는 핵심 결과
 *         ├── verdict.json   («실패» 분기가 있는 작업) { "pass": bool, "summary"? }
 *         ├── branches.json  (선택) 동적 분기 지시
 *         └── .done          완료 마커 (폴백 감지)
 *
 * 경로는 «컴포넌트(wf/run/node) → rel» 빌더로 만들고, 한 번 만든 rel 은 node_run.task_folder 에
 * 저장된다. 부모 폴더를 자식 프롬프트에 주입할 땐 «재계산하지 말고» 저장된 task_folder 를 읽는다
 * — 그래야 경로 스킴을 자유롭게 바꿀 수 있다. 슬러그는 한글/CJK 를 유지하고 '--' 를 구분자로 쓴다.
 *
 * 헤드리스(claude -p)로 도망가지 않고 PTY 인터랙티브 안에서 동작하므로 구독 청구 모델을
 * 깨지 않는다. fs 연산은 daemon 프로세스가 직접 한다 (iOS fs 라우트가 아님).
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

/** repo 안의 워크플로우 산출물 루트. .gitignore 권장. */
const WORKFLOW_DIR = ".posiworkflow";

/** 파일시스템·구분자 안전 슬러그. 한글/CJK 유지, 공백·슬래시·콜론·제어문자 → '-', 구분자 '--' 충돌 방지. */
function slug(s: string | null | undefined, fallback: string): string {
  const cleaned = (s ?? "")
    .trim()
    .replace(/[\/\\:]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return cleaned || fallback;
}

/** uuid 등에서 대시를 빼고 앞 8자 — 사람용 슬러그에 붙는 충돌 방지 꼬리표. */
function shortId(id: string): string {
  return id.replace(/-/g, "").slice(0, 8) || "x";
}

/** 폴더 경로 빌드에 필요한 식별자 묶음. */
export type TaskPathParts = {
  workflowTitle: string | null;
  workflowId: string;
  /** run 시작시각 스탬프 (YYYYMMDD-HHMMSS, 로컬). 엔진이 만들어 넘긴다. */
  runStamp: string;
  runId: string;
  nodeTitle: string | null;
  nodeType: string;
  nodeRunId: string;
};

/** run 폴더 (repo 기준 상대) — .posiworkflow/<wf>--<id>/<stamp>--<id>. */
export function runFolderRel(p: TaskPathParts): string {
  const wf = `${slug(p.workflowTitle, "workflow")}--${shortId(p.workflowId)}`;
  const run = `${p.runStamp}--${shortId(p.runId)}`;
  return path.join(WORKFLOW_DIR, wf, run);
}

/** 노드 Task 폴더 (repo 기준 상대) — <runFolder>/<node>--<id>. */
export function taskFolderRel(p: TaskPathParts): string {
  const node = `${slug(p.nodeTitle, p.nodeType || "task")}--${shortId(p.nodeRunId)}`;
  return path.join(runFolderRel(p), node);
}

function absOf(repoPath: string, rel: string): string {
  return path.join(repoPath, rel);
}

/** 이 노드의 result.md 가 (비어있지 않게) 써졌는지 — 완료 폴링용. rel = node_run.task_folder. */
export function resultMdExists(repoPath: string, rel: string): boolean {
  try {
    const st = fs.statSync(path.join(absOf(repoPath, rel), "result.md"));
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

/** Task 폴더를 만들고(mkdir -p) 받은 rel 을 그대로 돌려준다. */
export function ensureTaskFolder(repoPath: string, rel: string): string {
  fs.mkdirSync(absOf(repoPath, rel), { recursive: true });
  return rel;
}

/**
 * result.md 를 직접 쓴다 — 에이전트가 계약대로 result.md 를 안 남겼을 때, 엔진이 세션
 * 출력(터미널 캡처)을 정화해 넣는 폴백. 이게 있어야 다음 노드가 «이전 단계 결과» 폴더를
 * 읽고 이어서 작업할 수 있다 (특히 터미널 도구처럼 프로토콜을 따르지 않는 경우).
 */
export function writeResultMd(repoPath: string, rel: string, body: string): void {
  const a = absOf(repoPath, rel);
  fs.mkdirSync(a, { recursive: true });
  fs.writeFileSync(path.join(a, "result.md"), body, "utf8");
}

/** run 폴더 메타. DB 없이도 «어느 워크플로우의 언제 run 인지» 식별. */
export type RunManifest = {
  workflow_id: string;
  workflow_title: string | null;
  run_id: string;
  trigger: string;
  /** ISO 8601 (UTC). */
  started_at: string;
};

/** run 폴더에 _run.json 을 쓴다 (멱등 — 매 노드 spawn 마다 같은 내용 덮어쓰기). repo 별 1개. */
export function writeRunManifest(repoPath: string, runRel: string, m: RunManifest): void {
  const a = absOf(repoPath, runRel);
  fs.mkdirSync(a, { recursive: true });
  fs.writeFileSync(
    path.join(a, "_run.json"),
    JSON.stringify({ ps_schema: 1, ...m }, null, 2),
    "utf8",
  );
}

/** 한 부모 노드의 폴더 경로 + 라벨 (헤더 주입용). */
export type ParentFolderRef = {
  /** repo 기준 상대 경로 (부모 node_run.task_folder). */
  rel: string;
  /** 사람이 읽는 노드 라벨. */
  title: string;
};

export type BuildPromptArgs = {
  /** 노드의 사용자 프롬프트 본문. */
  prompt: string;
  /** 이 노드의 Task 폴더 상대 경로. */
  thisFolderRel: string;
  /** 부모 노드들의 폴더 (없으면 빈 배열 = 시작 직후 노드). */
  parents: ParentFolderRef[];
  /** run 고유 센티널 토큰 — 에이전트 서술과 충돌 안 나게 고엔트로피. */
  runToken: string;
  /** «실패» 분기가 있는 작업이면 verdict.json + :PASS/:FAIL 센티널 안내를 추가(성공/실패 판정 요청). */
  wantsVerdict: boolean;
  /** 노드별 «결과물 처리 지시» — result.md 에 무엇을/어떻게 담을지 추가 지침. 비면 기본만. */
  resultSpec?: string;
};

/**
 * 엔진이 PTY 에 보내는 «실제» 프롬프트를 조립한다 — 헤더(부모 폴더) + 본문 + 푸터(센티널).
 * 푸터의 센티널은 완료 «신호» 이자 transcript 에 남는 표식. (Phase 0 은 완료 감지를 turn
 * 정착(turn_complete/exit)으로 하지만, 푸터는 에이전트가 «언제 멈추고 무엇을 남길지» 를
 * 명확히 알게 해 result.md 작성률을 높인다. 스트림 센티널 감시는 Phase 1 강화.)
 */
export function buildNodePrompt(args: BuildPromptArgs): string {
  const lines: string[] = [];

  if (args.parents.length > 0) {
    lines.push("[이전 단계 결과] 다음 폴더(들)를 먼저 읽고 시작하라:");
    for (const p of args.parents) {
      lines.push(`  - ${p.rel}/   (노드 "${p.title}")`);
    }
    lines.push("");
  }

  lines.push(args.prompt.trim());
  lines.push("");
  lines.push("[작업을 마치면 — 워크플로우 프로토콜]");
  lines.push(`  1. 결과를 ${args.thisFolderRel}/result.md 에 마크다운으로 써라.`);
  lines.push(`     (관련 산출물이 있으면 같은 폴더에 함께 둬라.)`);
  const spec = args.resultSpec?.trim();
  if (spec) {
    lines.push(`     결과물 작성 지침: ${spec}`);
  }
  if (args.wantsVerdict) {
    lines.push(
      `  2. 성공/실패 판정을 ${args.thisFolderRel}/verdict.json 에 {"pass": true 또는 false, "summary": "..."} 로 써라.`,
    );
    lines.push(`  3. 마지막에 정확히 이 한 줄을 출력하라:  PSWF_DONE_${args.runToken}:PASS  (성공) 또는  PSWF_DONE_${args.runToken}:FAIL  (실패)`);
  } else {
    lines.push(`  2. 마지막에 정확히 이 한 줄을 출력하라:  PSWF_DONE_${args.runToken}`);
  }
  lines.push(
    `  · 혼자 끝낼 수 없어 사람의 결정/개입이 필요하면, 빈 파일 ${args.thisFolderRel}/.needs-attention 을 만들고(이유는 result.md 에) 멈춰라 — 워크플로우가 사람을 호출한다.`,
  );

  return lines.join("\n");
}

/** 동적 분기 한 개 — branches.json 의 항목. 노드가 런타임에 만들 자식 작업. */
export type BranchSpec = {
  title?: string;
  prompt: string;
  agent?: string;
  /** 동적 분기 노드도 «작업». (옛 general/test 표기는 task 로 정규화.) */
  type?: "task";
  /** 이 분기에서 성공/실패 판정을 받을지 — verdict.json 안내를 프롬프트에 넣는다. */
  wants_verdict?: boolean;
  requires_approval?: boolean;
};

export type HarvestResult = {
  /** result.md 본문 (없으면 null). */
  resultMd: string | null;
  /** .done 마커 존재 여부. */
  done: boolean;
  /** verdict.json 의 pass (없거나 파싱 실패면 null). */
  verdictPass: boolean | null;
  /** branches.json 의 동적 분기 (없거나 비면 null). */
  branches: BranchSpec[] | null;
  /**
   * `.needs-attention` 마커 존재 여부 — 에이전트가 «혼자 못 끝낸다, 사람을 불러달라» 고 명시
   * 요청한 경우. 엔진이 노드를 needs_attention 으로 parking 하고 알림을 쏜다. 기본 흐름(마커
   * 없음)은 그대로 result.md → done — 마커는 순수 opt-in 이라 정상 체인을 끊지 않는다.
   */
  needsAttention: boolean;
};

/** 노드 정착 후 Task 폴더에서 결과물을 수확한다. 던지지 않는다 — 없는 파일은 null/false. */
export async function harvestTaskFolder(
  repoPath: string,
  rel: string,
): Promise<HarvestResult> {
  const abs = absOf(repoPath, rel);
  let resultMd: string | null = null;
  try {
    resultMd = await fsp.readFile(path.join(abs, "result.md"), "utf8");
  } catch {
    resultMd = null;
  }
  let done = false;
  try {
    await fsp.access(path.join(abs, ".done"));
    done = true;
  } catch {
    done = false;
  }
  let needsAttention = false;
  try {
    await fsp.access(path.join(abs, ".needs-attention"));
    needsAttention = true;
  } catch {
    needsAttention = false;
  }
  let verdictPass: boolean | null = null;
  try {
    const raw = await fsp.readFile(path.join(abs, "verdict.json"), "utf8");
    const o = JSON.parse(raw) as { pass?: unknown };
    if (typeof o.pass === "boolean") verdictPass = o.pass;
  } catch {
    verdictPass = null;
  }
  let branches: BranchSpec[] | null = null;
  try {
    const raw = await fsp.readFile(path.join(abs, "branches.json"), "utf8");
    const arr = JSON.parse(raw) as unknown;
    if (Array.isArray(arr)) {
      const out: BranchSpec[] = [];
      for (const b of arr) {
        if (b && typeof b === "object") {
          const o = b as Record<string, unknown>;
          if (typeof o.prompt === "string" && o.prompt.trim()) {
            out.push({
              title: typeof o.title === "string" ? o.title : undefined,
              prompt: o.prompt,
              agent: typeof o.agent === "string" ? o.agent : undefined,
              type: "task",
              wants_verdict: o.wants_verdict === true || o.type === "test" ? true : undefined,
              requires_approval: o.requires_approval === true ? true : undefined,
            });
          }
        }
      }
      branches = out.length > 0 ? out : null;
    }
  } catch {
    branches = null;
  }
  return { resultMd, done, verdictPass, branches, needsAttention };
}
