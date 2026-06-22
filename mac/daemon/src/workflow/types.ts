/**
 * 워크플로우 그래프 정의의 타입 + 파싱/검증.
 *
 * 정의(workflows.nodes/edges)는 JSON blob 으로 저장된다 — 한 화면(캔버스)에서 통째로
 * 편집되고 좌표를 포함하므로. 라우트가 저장 전 validateDef 로 구조 + DAG(비순환) 를 검증하고,
 * 엔진이 parseDef 로 읽어 위상 순서대로 실행한다.
 *
 * docs/ARCHITECTURE.md §12.2 (데이터 모델·DB) 참고.
 */

// 노드 타입: 시작 / 작업 / 종료 3종. «작업(task)» 은 옛 general·test 를 통합한 것 —
// 모든 작업은 성공/실패 결과를 갖고, «실패» 간선을 이으면 분기·재시도가 된다.
// (옛 정의 호환: 저장된 "general"/"test" 는 asNodeArray 에서 "task" 로 매핑.)
export type NodeType = "start" | "task" | "end";
export const NODE_TYPES: ReadonlySet<string> = new Set(["start", "task", "end"]);

/** 옛 타입(general/test) 을 task 로 정규화. 그 외는 그대로. */
function normalizeType(t: string): NodeType {
  if (t === "general" || t === "test") return "task";
  return t as NodeType;
}

/** 시작 노드가 들고 있는 트리거 정의 (캔버스에 박혀 정의의 일부). manual 은 항상 가능. */
export type TriggerDef = {
  kind: "manual" | "cron" | "github";
  /** kind='cron' */
  schedule?: string;
  timezone?: string;
  /** kind='github' */
  repo_path?: string;
  branch?: string;
  poll_seconds?: number;
};

export type NodeDef = {
  id: string;
  type: NodeType;
  title?: string;
  /** task — 어떤 코드 에이전트 CLI 로 spawn 할지 (registry id). */
  agent?: string;
  /** repo override (절대경로). 없으면 workflow.repo_path 사용. */
  repo_path?: string;
  /** task — 에이전트에 보낼 프롬프트. */
  prompt?: string;
  /** task — 결과물 처리(저장) 세부 지시. 비면 기본(Task 폴더 result.md)만 안내. */
  result_spec?: string;
  /**
   * task — 통과/실패를 판정할 «검사 명령»(예: 테스트·린트·타입체크·빌드). 비어 있지 않으면
   * 에이전트 자기 판단(verdict.json) 대신 이 명령의 «종료 코드»(0=pass, 비0=fail)로 판정한다.
   * 비면 «검사 미설정» — 종전대로 verdict.json 폴백.
   */
  check_command?: string;
  skip_permissions?: boolean;
  /** true 면 실행 전 사용자 승인 게이트 (Phase 2). */
  requires_approval?: boolean;
  /** start 노드 — 트리거 목록 (Phase 1+). */
  triggers?: TriggerDef[];
  /** 캔버스 좌표 — node_run 의 기본 x/y 로 복사된다. */
  x?: number;
  y?: number;
};

// 간선 조건: «fail» 하나만. 조건 없는(무조건) 간선 = «성공/다음» 경로, «fail» 간선 = 실패 경로.
// (옛 test 노드의 "pass" 간선은 무조건 간선과 같으므로 asEdgeArray 에서 undefined 로 매핑.)
export type EdgeCondition = "fail";

export type EdgeDef = {
  id: string;
  from: string;
  to: string;
  /** «fail» 이면 출발 작업이 실패했을 때만 활성화. 없으면 성공 시(또는 fail 간선이 없을 때 fall-through) 활성화. */
  condition?: EdgeCondition;
};

export type WorkflowDef = {
  nodes: NodeDef[];
  edges: EdgeDef[];
};

function asNodeArray(raw: unknown): NodeDef[] {
  if (!Array.isArray(raw)) return [];
  const out: NodeDef[] = [];
  for (const n of raw) {
    if (!n || typeof n !== "object") continue;
    const o = n as Record<string, unknown>;
    if (typeof o.id !== "string" || typeof o.type !== "string") continue;
    out.push({
      id: o.id,
      type: normalizeType(o.type),
      title: typeof o.title === "string" ? o.title : undefined,
      agent: typeof o.agent === "string" ? o.agent : undefined,
      repo_path: typeof o.repo_path === "string" ? o.repo_path : undefined,
      prompt: typeof o.prompt === "string" ? o.prompt : undefined,
      result_spec: typeof o.result_spec === "string" ? o.result_spec : undefined,
      check_command: typeof o.check_command === "string" ? o.check_command : undefined,
      skip_permissions: o.skip_permissions === true,
      requires_approval: o.requires_approval === true,
      triggers: Array.isArray(o.triggers) ? (o.triggers as TriggerDef[]) : undefined,
      x: typeof o.x === "number" ? o.x : undefined,
      y: typeof o.y === "number" ? o.y : undefined,
    });
  }
  return out;
}

function asEdgeArray(raw: unknown): EdgeDef[] {
  if (!Array.isArray(raw)) return [];
  const out: EdgeDef[] = [];
  for (const e of raw) {
    if (!e || typeof e !== "object") continue;
    const o = e as Record<string, unknown>;
    if (typeof o.from !== "string" || typeof o.to !== "string") continue;
    const id = typeof o.id === "string" ? o.id : `${o.from}->${o.to}`;
    // "fail" 만 보존. 옛 "pass"(및 그 외) 는 무조건(성공/다음) 간선과 동치 → undefined.
    const condition = o.condition === "fail" ? "fail" : undefined;
    out.push({ id, from: o.from, to: o.to, condition });
  }
  return out;
}

/** 두 JSON 문자열(nodes/edges) 을 안전하게 파싱. 깨진 JSON 은 빈 배열로 흡수. */
export function parseDef(nodesJson: string, edgesJson: string): WorkflowDef {
  let nodesRaw: unknown = [];
  let edgesRaw: unknown = [];
  try {
    nodesRaw = JSON.parse(nodesJson);
  } catch {
    /* 빈 배열 */
  }
  try {
    edgesRaw = JSON.parse(edgesJson);
  } catch {
    /* 빈 배열 */
  }
  return { nodes: asNodeArray(nodesRaw), edges: asEdgeArray(edgesRaw) };
}

/** def_snapshot(JSON 한 덩어리) 파싱 — { nodes, edges }. */
export function parseSnapshot(snapshot: string): WorkflowDef {
  try {
    const o = JSON.parse(snapshot) as { nodes?: unknown; edges?: unknown };
    return { nodes: asNodeArray(o.nodes), edges: asEdgeArray(o.edges) };
  } catch {
    return { nodes: [], edges: [] };
  }
}

export type ValidationResult = { ok: true; def: WorkflowDef } | { ok: false; error: string };

/**
 * 구조 + DAG(비순환) 검증. Phase 0 은 사이클을 거부한다 (테스트 fail 루프는 Phase 2 에서
 * test 노드 한정으로 허용). 노드 id 유일성, 간선이 존재하는 노드를 가리키는지, 노드 타입이
 * 유효한지, general/test 가 prompt 를 갖는지 본다.
 */
export function validateDef(rawNodes: unknown, rawEdges: unknown): ValidationResult {
  const nodes = asNodeArray(rawNodes);
  const edges = asEdgeArray(rawEdges);

  if (nodes.length === 0) return { ok: false, error: "노드가 비어 있어요." };

  const ids = new Set<string>();
  for (const n of nodes) {
    if (ids.has(n.id)) return { ok: false, error: `중복된 노드 id: ${n.id}` };
    ids.add(n.id);
    if (!NODE_TYPES.has(n.type)) {
      return { ok: false, error: `알 수 없는 노드 타입: ${n.type}` };
    }
    if (n.type === "task" && !(n.prompt && n.prompt.trim())) {
      return { ok: false, error: `노드 "${n.title ?? n.id}" 에 프롬프트가 필요해요.` };
    }
  }

  for (const e of edges) {
    if (!ids.has(e.from)) return { ok: false, error: `간선 출발 노드 없음: ${e.from}` };
    if (!ids.has(e.to)) return { ok: false, error: `간선 도착 노드 없음: ${e.to}` };
  }

  // 순환 금지 — 단 «작업의 fail 간선» 은 의도적 루프(실패 → 되돌아가 재시도)라 허용한다.
  // 그래서 fail 간선을 제외한 그래프(전진 그래프)가 비순환이면 통과. 그 외 간선으로 만든
  // 순환은 거부 (무한 루프 + 토큰 폭주 방지 — 루프는 fail 간선으로만, MAX_ITERATIONS 로 bound).
  const forwardEdges = edges.filter((e) => e.condition !== "fail");
  if (hasCycle(nodes, forwardEdges)) {
    return {
      ok: false,
      error: "순환(cycle)이 있어요 — 루프는 작업의 «실패» 간선으로만 만들 수 있어요.",
    };
  }

  return { ok: true, def: { nodes, edges } };
}

/** Kahn 위상정렬로 사이클 검출. 모든 노드를 소진 못 하면 사이클 존재. */
function hasCycle(nodes: NodeDef[], edges: EdgeDef[]): boolean {
  const indeg = new Map<string, number>();
  for (const n of nodes) indeg.set(n.id, 0);
  for (const e of edges) indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  const queue: string[] = [];
  for (const [id, d] of indeg) if (d === 0) queue.push(id);
  let visited = 0;
  while (queue.length) {
    const id = queue.shift()!;
    visited++;
    for (const e of edges) {
      if (e.from !== id) continue;
      const d = (indeg.get(e.to) ?? 0) - 1;
      indeg.set(e.to, d);
      if (d === 0) queue.push(e.to);
    }
  }
  return visited < nodes.length;
}

/** from → [child node ids]. condition 무시(Phase 0). */
export function childrenOf(edges: EdgeDef[], nodeId: string): EdgeDef[] {
  return edges.filter((e) => e.from === nodeId);
}

/** 노드별 들어오는 간선 수 (정적 indegree). */
export function indegreeMap(nodes: NodeDef[], edges: EdgeDef[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const n of nodes) m.set(n.id, 0);
  for (const e of edges) m.set(e.to, (m.get(e.to) ?? 0) + 1);
  return m;
}
