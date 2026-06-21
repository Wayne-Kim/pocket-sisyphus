/**
 * 연결/런타임 실패의 «안정적 식별자»(enum) + 분류 함수 — daemon ↔ iOS 진단 계약의 SSOT.
 *
 * # 왜 코드인가
 *
 * 지금까지 연결 실패는 구조화 코드 없이 «문자열» 로만 떨어져, iOS 가 「왜·무엇을 하라」 를
 * 안내하지 못했다 (사용자는 원인 없는 일반 에러만 봄). 이 모듈은 그 실패를 환경·언어와 무관한
 * 안정적 코드(`tor_descriptor_missing` 등)로 «분류» 하는 순수 함수만 모은다. 사람이 읽는 문구·
 * 권장 조치·색·아이콘은 «전부» iOS 가 코드→localize 로 매핑한다 — daemon 은 UI 표면이 없으므로
 * 여기서 한국어/영어 사용자 문구를 만들지 않는다 (식별자·숫자만 내보낸다).
 *
 * # 분류 = 순수 함수 (테스트 가능)
 *
 * 각 `classify*` 는 관측 신호(부트스트랩 여부·listening 여부·디스크 여유 등)를 받아
 * `{ level, code }` 를 돌려주는 부작용 없는 함수다. 스냅샷 수집(I/O)은 routes/diagnostics.ts 가
 * deps 로 주입받아 하고, 이 모듈은 «입력→코드» 만 책임진다 — codes.test.ts 가 코드별로 못박는다.
 */

/** 진단 심각도 — iOS 가 색으로 매핑한다: ok=success(초록)·warning=warning(노랑)·error=danger(빨강)·unknown=secondary. */
export const DIAGNOSTIC_LEVELS = ["ok", "warning", "error", "unknown"] as const;
export type DiagnosticLevel = (typeof DIAGNOSTIC_LEVELS)[number];

/**
 * 연결/런타임 실패의 안정적 식별자. 새 코드를 추가만 하고 «기존 코드의 의미를 바꾸지 말 것»
 * (iOS localize 매핑이 깨진다). iOS `DiagnosticCode` 와 손으로 짝지어 관리한다.
 */
export const DIAGNOSTIC_CODES = [
  "ok",
  /** 상태를 관측할 수 없음 (수집 실패·미측정). */
  "unknown",
  /** Tor 프로세스가 죽어 있음 — onion 응답 불가. 자동 복구 대상이지만 계속되면 재시작 필요. */
  "tor_process_down",
  /** Tor 부팅(회로 빌드) 진행 중 — 아직 100% 부트스트랩 전. 잠시 기다리면 자동 연결. */
  "tor_not_bootstrapped",
  /** onion 주소/HS 디스크립터 미생성·미게시 — 콜드부트에서 onion 이 준비되지 않음. */
  "tor_descriptor_missing",
  /** sshd listener 부재 — 직접 SSH/onion virtual 22 모두 connection refused. */
  "ssh_not_listening",
  /** 서버 호스트 키 불일치 — 재설치 아니면 중간자(MITM) 의심. (클라이언트가 관측해 매핑.) */
  "ssh_hostkey_mismatch",
  /** LAN 전용 모드인데 광고할 LAN 주소 후보가 0 — 외부 폴백도 막혀 아무도 못 붙는다(fail-closed). */
  "lan_blocked_no_public_fallback",
  /** 에이전트 CLI 미설치 — 세션 생성 시 PTY spawn 127(command not found). */
  "agent_cli_missing",
  /** 디스크 여유 부족 — 로그/세션 기록 저장이 실패할 수 있음(주의). */
  "disk_low",
  /** 디스크 여유 매우 부족 — 저장 실패 임박(오류). */
  "disk_critical",
  /** unified.log / pty_chunk 가 비정상적으로 큼 — 동작엔 문제 없으나 정리 권장(주의). */
  "log_oversized",
] as const;
export type DiagnosticCode = (typeof DIAGNOSTIC_CODES)[number];

/** 한 서브시스템(또는 항목)의 판정 — 색·문구 매핑의 입력. */
export type Verdict = { level: DiagnosticLevel; code: DiagnosticCode };

const OK: Verdict = { level: "ok", code: "ok" };
const UNKNOWN: Verdict = { level: "unknown", code: "unknown" };

/**
 * 「가장 나쁜」 심각도 — 서브시스템들의 level 을 모아 overall 을 정한다.
 * 랭크: ok < unknown < warning < error (정상이 아닌 «미확인» 도 정상보다 위로 올려 가린다).
 */
const LEVEL_SEVERITY: Record<DiagnosticLevel, number> = {
  ok: 0,
  unknown: 1,
  warning: 2,
  error: 3,
};
export function worstLevel(levels: DiagnosticLevel[]): DiagnosticLevel {
  return levels.reduce<DiagnosticLevel>(
    (acc, l) => (LEVEL_SEVERITY[l] > LEVEL_SEVERITY[acc] ? l : acc),
    "ok",
  );
}

/**
 * Tor 상태 분류. 우선순위: 프로세스 죽음 > 부팅 미완 > onion 미게시 > 정상.
 * (프로세스가 죽었으면 부트스트랩/onion 신호는 의미 없으므로 먼저 본다.)
 */
export function classifyTor(input: {
  processAlive: boolean;
  bootstrapped: boolean;
  onionPresent: boolean;
}): Verdict {
  if (!input.processAlive) return { level: "error", code: "tor_process_down" };
  if (!input.bootstrapped) return { level: "warning", code: "tor_not_bootstrapped" };
  if (!input.onionPresent) return { level: "error", code: "tor_descriptor_missing" };
  return OK;
}

/**
 * sshd 상태 분류. 호스트 키 불일치(클라 관측)가 최우선 — 변조 의심이라 listening 여부보다 중대.
 * 그 외엔 listener 부재면 오류.
 */
export function classifySsh(input: {
  processAlive: boolean;
  hostKeyMismatch?: boolean;
}): Verdict {
  if (input.hostKeyMismatch) return { level: "error", code: "ssh_hostkey_mismatch" };
  if (!input.processAlive) return { level: "error", code: "ssh_not_listening" };
  return OK;
}

/**
 * 외부 연결성(LAN 정책) 분류. LAN 전용 모드인데 광고할 LAN 후보가 0이면 — 외부(공인·onion)
 * 폴백도 막혀 «아무도» 붙을 수 없다(fail-closed). 그 외(평소·LAN 후보 있음)는 정상.
 */
export function classifyReachability(input: {
  lanOnly: boolean;
  lanCandidateCount: number;
}): Verdict {
  if (input.lanOnly && input.lanCandidateCount <= 0) {
    return { level: "error", code: "lan_blocked_no_public_fallback" };
  }
  return OK;
}

/** 에이전트 CLI 탐지 — 못 찾으면 «설정 필요»(warning). 설치는 사용자 액션이라 오류가 아니라 주의. */
export function classifyAgentCli(input: { detected: boolean }): Verdict {
  return input.detected ? OK : { level: "warning", code: "agent_cli_missing" };
}

/** 디스크 여유 임계값 — 5 GiB 미만 주의, 1 GiB 미만 오류. */
export const DISK_LOW_BYTES = 5 * 1024 ** 3;
export const DISK_CRITICAL_BYTES = 1 * 1024 ** 3;
export function classifyDisk(input: { freeBytes: number | null }): Verdict {
  if (input.freeBytes == null) return UNKNOWN;
  if (input.freeBytes < DISK_CRITICAL_BYTES) return { level: "error", code: "disk_critical" };
  if (input.freeBytes < DISK_LOW_BYTES) return { level: "warning", code: "disk_low" };
  return OK;
}

/** 로그 비대 임계값 — unified.log 512 MiB 초과 또는 pty_chunk 50만 행 초과면 주의(정리 권장). */
export const LOG_OVERSIZED_BYTES = 512 * 1024 ** 2;
export const PTY_CHUNK_OVERSIZED_COUNT = 500_000;
export function classifyLogs(input: {
  unifiedLogBytes: number | null;
  ptyChunkCount: number | null;
}): Verdict {
  const oversized =
    (input.unifiedLogBytes != null && input.unifiedLogBytes > LOG_OVERSIZED_BYTES) ||
    (input.ptyChunkCount != null && input.ptyChunkCount > PTY_CHUNK_OVERSIZED_COUNT);
  if (oversized) return { level: "warning", code: "log_oversized" };
  if (input.unifiedLogBytes == null && input.ptyChunkCount == null) return UNKNOWN;
  return OK;
}

/**
 * 런타임 PTY spawn 실패 → 코드. exit 127(command not found) 또는 «찾을 수 없음/not found/
 * ENOENT» 메시지는 에이전트 CLI 미설치로 분류한다 (재현 (c): 에이전트 CLI 미설치 세션 생성 →
 * spawn 127). 그 외는 unknown. emitSpawnFailure/세션 spawn 경로가 이 코드를 진단에 실어 보낼 수 있다.
 */
export function classifySpawnFailure(input: {
  exitCode: number | null;
  message?: string;
}): DiagnosticCode {
  if (input.exitCode === 127) return "agent_cli_missing";
  const msg = (input.message ?? "").toLowerCase();
  if (
    msg.includes("not found") ||
    msg.includes("command not found") ||
    msg.includes("enoent") ||
    msg.includes("찾을 수 없")
  ) {
    return "agent_cli_missing";
  }
  return "unknown";
}
