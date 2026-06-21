// `GET /api/connection-diagnostics` — 서브시스템 «읽기 전용» 연결 스냅샷.
//
// (별개 기능과의 구분: `/api/diagnostics`(routes/diagnostics.ts) 는 «문제 신고/진단 번들»
//  — crash 마커 + 마스킹된 로그 tail. 여기 «연결 진단» 은 Tor/sshd/디스크/에이전트 CLI 의
//  서브시스템 «상태» 를 안정적 코드로 분류해 iOS 「연결 진단」 화면이 원인·조치를 안내하게 한다.)
//
// 동기: 연결이 실패해도 daemon 의 /health 는 {ok,time,connectedClients} 뿐이라 Tor/sshd/디스크/
// 에이전트 CLI 상태를 노출하지 못했고, 에러는 구조화 코드 없이 문자열뿐이라 iOS 가 「왜·무엇을
// 하라」 를 안내할 수 없었다. 이 엔드포인트는 각 서브시스템의 상태를 안정적 코드(connection-
// diagnostics/codes.ts) + 원시 지표로 내보내 iOS 진단 화면이 사람이 읽는 localize 문구·권장 조치로 매핑한다.
//
// 경계: daemon 은 UI 표면이 없으므로 «사용자 문구» 를 만들지 않는다 — 코드(식별자)·숫자·boolean
// 만 내보낸다. 색·문구·시각 포맷은 전부 iOS 가 한다. 외부 IPv4 «값» 은 싣지 않고 존재 여부
// (boolean)만 — 로그의 `secret.*` redact 정책과 같은 취지(주소 자체는 진단에 불필요).
//
// 모든 I/O(프로세스 생존·디스크 statfs·DB count 등)는 deps 로 «주입» 받아, 분류 로직과 응답
// 계약을 실제 시스템 없이 테스트할 수 있게 한다 (connection-diagnostics.test.ts).

import { Hono } from "hono";
import { bearerAuth } from "../auth.js";
import {
  classifyTor,
  classifySsh,
  classifyReachability,
  classifyAgentCli,
  classifyDisk,
  classifyLogs,
  worstLevel,
  type DiagnosticLevel,
  type DiagnosticCode,
} from "../connection-diagnostics/codes.js";

/** 서브시스템 식별자 — iOS 가 표시명·아이콘으로 매핑한다(번역 대상은 표시명, id 는 식별자). */
export type DiagnosticSubsystemId =
  | "tor"
  | "sshd"
  | "reachability"
  | "agent_cli"
  | "disk"
  | "logs"
  | "network";

/**
 * 표시용 원시 지표 — 전부 옵셔널(서브시스템마다 관련 필드만 채운다). iOS 가 사람이 읽는 형식
 * (바이트→사람 단위, epoch→날짜)으로 포맷한다. 여기엔 사용자 문구를 담지 않는다.
 */
export type DiagnosticMetrics = {
  torProcessAlive?: boolean;
  torBootstrapPercent?: number;
  onionPublished?: boolean;
  sshListening?: boolean;
  sshPort?: number;
  diskFreeBytes?: number;
  diskTotalBytes?: number;
  unifiedLogBytes?: number;
  ptyChunkCount?: number;
  lanOnly?: boolean;
  lanCandidateCount?: number;
  externalIPv4Present?: boolean;
  ipFetchedAt?: number;
  lastIpChangeAt?: number;
  lastReconnectAt?: number;
};

/** 서브시스템 안의 개별 항목(예: 에이전트 CLI 하나). */
export type DiagnosticItem = {
  id: string;
  /** 사람 친화 이름(예: "Claude Code") — 식별자성. iOS 가 verbatim 표시. */
  label: string;
  level: DiagnosticLevel;
  code: DiagnosticCode;
  /** 코드성 보조 문자열(예: 설치 명령 installHint) — 번역 대상 아님. */
  detail?: string;
};

export type DiagnosticSubsystem = {
  id: DiagnosticSubsystemId;
  level: DiagnosticLevel;
  code: DiagnosticCode;
  metrics?: DiagnosticMetrics;
  items?: DiagnosticItem[];
};

export type DiagnosticsResponse = {
  v: 1;
  /** 스냅샷 생성 시각 (epoch ms). */
  generatedAt: number;
  /** 서브시스템 중 가장 나쁜 심각도. */
  overall: DiagnosticLevel;
  subsystems: DiagnosticSubsystem[];
};

/** 스냅샷 수집에 필요한 모든 관측 신호 — server.ts 가 실제 핸들/모듈로 채운다. */
export type DiagnosticsDeps = {
  getTorProcessAlive: () => boolean;
  /** 0~100. 100 이면 부트스트랩 완료. */
  getTorBootstrapPercent: () => number;
  /** onion 주소 (게시됨 신호). null 이면 미게시. */
  getOnionAddress: () => string | null;
  getSshListening: () => boolean;
  getSshPort: () => number;
  getDiskFree: () => { freeBytes: number; totalBytes: number } | null;
  listAgentCli: () => Array<{
    id: string;
    displayName: string;
    detected: boolean;
    installHint?: string;
  }>;
  isLanOnly: () => boolean;
  getLanCandidateCount: () => number;
  getUnifiedLogBytes: () => number | null;
  getPtyChunkCount: () => number | null;
  /** 외부 IPv4 (있음/없음만 노출 — 값 자체는 싣지 않는다). */
  getExternalIPv4: () => string | null;
  getIpFetchedAt: () => number | null;
  getLastIpChangeAt: () => number | null;
  getLastReconnectAt: () => number | null;
  now: () => number;
};

/**
 * 관측 신호 → 진단 스냅샷. 순수(주입 deps 의 결과만 사용) — 분류·집계를 실제 I/O 없이 테스트.
 */
export function buildDiagnosticsSnapshot(deps: DiagnosticsDeps): DiagnosticsResponse {
  const subsystems: DiagnosticSubsystem[] = [];

  // Tor — 부트스트랩%·onion 게시 여부.
  const torProcessAlive = deps.getTorProcessAlive();
  const torPct = deps.getTorBootstrapPercent();
  const onion = deps.getOnionAddress();
  const torVerdict = classifyTor({
    processAlive: torProcessAlive,
    bootstrapped: torPct >= 100,
    onionPresent: onion != null,
  });
  subsystems.push({
    id: "tor",
    level: torVerdict.level,
    code: torVerdict.code,
    metrics: {
      torProcessAlive,
      torBootstrapPercent: torPct,
      onionPublished: onion != null,
    },
  });

  // sshd — listening 여부 + 포트.
  const sshListening = deps.getSshListening();
  const sshVerdict = classifySsh({ processAlive: sshListening });
  subsystems.push({
    id: "sshd",
    level: sshVerdict.level,
    code: sshVerdict.code,
    metrics: { sshListening, sshPort: deps.getSshPort() },
  });

  // 외부 연결성 — LAN 전용 정책 + LAN 후보 수.
  const lanOnly = deps.isLanOnly();
  const lanCount = deps.getLanCandidateCount();
  const reachVerdict = classifyReachability({ lanOnly, lanCandidateCount: lanCount });
  subsystems.push({
    id: "reachability",
    level: reachVerdict.level,
    code: reachVerdict.code,
    metrics: { lanOnly, lanCandidateCount: lanCount },
  });

  // 에이전트 CLI — 등록된 어댑터별 탐지 결과. 서브시스템 level/code = 항목 중 가장 나쁜 것.
  const agents = deps.listAgentCli();
  const items: DiagnosticItem[] = agents.map((a) => {
    const v = classifyAgentCli({ detected: a.detected });
    return {
      id: a.id,
      label: a.displayName,
      level: v.level,
      code: v.code,
      // 미설치일 때만 설치 명령(installHint)을 보조로 — 코드성 문자열, iOS 가 monospace 로 표시.
      ...(a.detected ? {} : a.installHint ? { detail: a.installHint } : {}),
    };
  });
  subsystems.push({
    id: "agent_cli",
    level: worstLevel(items.map((i) => i.level)),
    code: items.find((i) => i.code !== "ok")?.code ?? "ok",
    items,
  });

  // 디스크 여유.
  const disk = deps.getDiskFree();
  const diskVerdict = classifyDisk({ freeBytes: disk?.freeBytes ?? null });
  subsystems.push({
    id: "disk",
    level: diskVerdict.level,
    code: diskVerdict.code,
    metrics: disk ? { diskFreeBytes: disk.freeBytes, diskTotalBytes: disk.totalBytes } : {},
  });

  // 로그 — unified.log / pty_chunk 크기.
  const unifiedLogBytes = deps.getUnifiedLogBytes();
  const ptyChunkCount = deps.getPtyChunkCount();
  const logsVerdict = classifyLogs({ unifiedLogBytes, ptyChunkCount });
  subsystems.push({
    id: "logs",
    level: logsVerdict.level,
    code: logsVerdict.code,
    metrics: {
      ...(unifiedLogBytes != null ? { unifiedLogBytes } : {}),
      ...(ptyChunkCount != null ? { ptyChunkCount } : {}),
    },
  });

  // 네트워크 — 정보성(외부 IP 존재·마지막 IP변경/재연결 시각). 실패 코드 없음(ok).
  const ipv4 = deps.getExternalIPv4();
  const ipFetchedAt = deps.getIpFetchedAt();
  const lastIpChangeAt = deps.getLastIpChangeAt();
  const lastReconnectAt = deps.getLastReconnectAt();
  subsystems.push({
    id: "network",
    level: "ok",
    code: "ok",
    metrics: {
      externalIPv4Present: ipv4 != null,
      ...(ipFetchedAt != null ? { ipFetchedAt } : {}),
      ...(lastIpChangeAt != null ? { lastIpChangeAt } : {}),
      ...(lastReconnectAt != null ? { lastReconnectAt } : {}),
    },
  });

  return {
    v: 1,
    generatedAt: deps.now(),
    overall: worstLevel(subsystems.map((s) => s.level)),
    subsystems,
  };
}

/** `/api/connection-diagnostics` 라우트 — 다른 `/api/*` 와 동일하게 bearer 인증. */
export function connectionDiagnosticsRoute(deps: DiagnosticsDeps) {
  const app = new Hono();
  app.use("*", bearerAuth);
  app.get("/", (c) => c.json(buildDiagnosticsSnapshot(deps)));
  return app;
}
