// 라이브 프리뷰 — «이 세션이 띄운» dev 서버 포트 자동 감지 (preview_proxy_v1).
//
// 세션 PTY 자식 프로세스 트리(PTY → 셸 → vite/next/...)가 LISTEN 중인 TCP 포트를 열거해
// «감지된 포트» 후보로 돌려준다. 자동 등록은 절대 하지 않는다 — 후보만 제공하고, 실제 노출은
// 사용자가 UI 에서 탭해 POST /ports 로 명시 등록할 때만 일어난다(기본 차단 모델 불변).
//
// lsof 부재/권한 거부/매칭 없음은 모두 «빈 배열»(에러 아님) — UI 는 수동 입력으로 폴백한다.
// 트리는 PTY 자식 기준이라 세션이 worktree 에서 돌아 cwd 가 repo 와 달라도 영향 없다.

import { execFileSync } from "node:child_process";

const LSOF_PATHS = ["/usr/sbin/lsof", "/usr/bin/lsof", "lsof"];

/** 감지된 LISTEN 포트 한 건. command 는 포트를 연 프로세스 이름(있으면). */
export type DetectedPort = { port: number; command?: string };

/** ps -axo pid=,ppid= 로 전체 프로세스의 (부모→자식) 맵. 실패 시 빈 맵. */
function childrenMap(): Map<number, number[]> {
  const map = new Map<number, number[]>();
  try {
    const out = execFileSync("/bin/ps", ["-axo", "pid=,ppid="], {
      encoding: "utf8",
      timeout: 2000,
    });
    for (const line of out.split("\n")) {
      const m = line.trim().match(/^(\d+)\s+(\d+)$/);
      if (!m) continue;
      const pid = Number.parseInt(m[1], 10);
      const ppid = Number.parseInt(m[2], 10);
      const arr = map.get(ppid);
      if (arr) arr.push(pid);
      else map.set(ppid, [pid]);
    }
  } catch {
    /* ps 실패 — 빈 맵 (감지 0건으로 폴백) */
  }
  return map;
}

/** rootPid 와 그 모든 하위 자손 PID 집합 (root 포함). */
export function descendantPids(rootPid: number): Set<number> {
  const children = childrenMap();
  const result = new Set<number>([rootPid]);
  const queue = [rootPid];
  while (queue.length) {
    const pid = queue.shift() as number;
    for (const child of children.get(pid) ?? []) {
      if (!result.has(child)) {
        result.add(child);
        queue.push(child);
      }
    }
  }
  return result;
}

/** "*:3000" / "127.0.0.1:5173" / "[::1]:8080" 등에서 포트만 추출. 실패 시 0. */
function portFromAddr(addr: string): number {
  const idx = addr.lastIndexOf(":");
  if (idx < 0) return 0;
  const p = Number.parseInt(addr.slice(idx + 1), 10);
  return Number.isInteger(p) && p > 0 ? p : 0;
}

/**
 * `lsof -F pcn` 필드 출력 파싱 → (pid, command, port) 목록. 필드 한 줄당 한 항목:
 * `p<pid>` 가 프로세스 시작, `c<command>` 명령명, `n<addr>` 가 각 소켓 주소.
 * export 해서 파서를 단위 테스트로 고정한다(주소 표기 다양성 회귀 방지).
 */
export function parseLsofListeners(
  out: string,
): { pid: number; command: string; port: number }[] {
  const result: { pid: number; command: string; port: number }[] = [];
  let pid = 0;
  let command = "";
  for (const line of out.split("\n")) {
    if (!line) continue;
    const tag = line[0];
    const rest = line.slice(1);
    if (tag === "p") {
      pid = Number.parseInt(rest, 10) || 0;
      command = "";
    } else if (tag === "c") {
      command = rest;
    } else if (tag === "n") {
      const port = portFromAddr(rest);
      if (pid > 0 && port > 0) result.push({ pid, command, port });
    }
  }
  return result;
}

/** 전체 LISTEN TCP 소켓을 (pid, command, port) 로 열거. lsof 부재/실패면 빈 배열. */
function listAllListeners(): { pid: number; command: string; port: number }[] {
  for (const lsof of LSOF_PATHS) {
    try {
      const out = execFileSync(
        lsof,
        ["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcn"],
        { encoding: "utf8", timeout: 2500 },
      );
      return parseLsofListeners(out);
    } catch (e: any) {
      // status 1 = 매칭 소켓 없음(정상). 그 외(127=lsof 부재 등)는 다음 경로 시도.
      if (e?.status === 1) return [];
    }
  }
  return [];
}

/**
 * rootPid(세션 PTY) 자식 트리가 LISTEN 중인 후보 포트 열거. rootPid 가 null(PTY 미가동)
 * 이거나 lsof 부재/권한 거부면 빈 배열. reserved/<1024 제외는 호출자(라우트)가
 * validatePreviewPort 로 거른다 — 단일 정책 정의를 재사용.
 */
export function detectListeningPorts(rootPid: number | null): DetectedPort[] {
  if (!rootPid || rootPid <= 1) return [];
  const listeners = listAllListeners();
  if (listeners.length === 0) return [];
  const tree = descendantPids(rootPid);
  // 같은 포트를 여러 소켓(IPv4/IPv6)이 열 수 있어 포트당 한 건으로 합친다.
  const byPort = new Map<number, string | undefined>();
  for (const l of listeners) {
    if (!tree.has(l.pid)) continue;
    if (!byPort.has(l.port)) byPort.set(l.port, l.command || undefined);
  }
  return [...byPort.entries()].map(([port, command]) => ({ port, command }));
}
