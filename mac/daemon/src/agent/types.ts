/**
 * 코드 에이전트 CLI 추상화.
 *
 * daemon 의 PTY runner 는 「어떤」 CLI 인지 모르고, spawn 세부 (binary 경로 / 인자 /
 * env / 데스크탑 세션 디스커버리) 는 adapter 가 결정한다. 새 에이전트 추가 비용 =
 * adapter 한 파일 + registerAgent 한 줄.
 *
 * 등록은 src/agent/index.ts 에서 한다 (registerAgent). 라우트나 PTY runner 는 항상
 * registry 를 통해서 adapter 를 가져온다 — adapter 직접 import 하지 말 것.
 */

/** 데스크탑 세션 (이어받기 후보) 의 메타데이터. agent 별로 채울 수 있는 필드가 다르다. */
export type DesktopSessionSummary = {
  /** adapter 가 spawn 시 `--resume <id>` (또는 동등) 인자에 박는 값. */
  sessionId: string;
  repoPath: string;
  /**
   * 첫 user 메시지 미리보기. agent 가 평문 jsonl 같은 source 를 갖고 있으면 채우고,
   * 암호화된 본문 (예: agy 의 `.pb`) 이라 못 읽으면 null.
   */
  preview: string | null;
  /** user turn 개수 근사치. 모르면 null. */
  turnCount: number | null;
  /** ms epoch — agent 가 추적할 수 있는 최선의 last-activity 시각. */
  lastActiveAt: number;
  /** 첫 turn 의 timestamp. 모르면 null. */
  startedAt: number | null;
  /** 시작 당시의 git 브랜치. 기록 안 하면 null. */
  gitBranch: string | null;
};

/** scanAll / list 의 옵션. */
export type DesktopListOptions = {
  /** 매칭되는 repo 의 세션만. undefined 면 전체. */
  repoPathFilter?: string;
};

/**
 * 데스크탑 세션 디스커버리 + FS-watch — 기능 자체가 없는 adapter 는 desktopWatcher()
 * 가 null 을 반환한다.
 *
 * 라이브 tail (= LiveSessionView 같은 read-only 관전) 은 의도적으로 인터페이스에서
 * 빠져 있다 — SwiftTerm 통합 이후 iOS 측 소비자가 사라져서. 필요해지면 그때 다시
 * 도입.
 */
export interface DesktopAgentWatcher {
  /** 이어받기 후보 목록. 호출자가 최대 N 개로 자른다. */
  list(opts: DesktopListOptions): DesktopSessionSummary[];
  /**
   * FS-watch 시작. 캐시 무효화 listener 만 받음 (WS 푸시 X — 살아있는 소비자가 routes
   * 의 in-memory 캐시 뿐).
   * 반환값은 stop 함수.
   */
  start(onInvalidate: (scope: "list" | "tail", sessionId?: string) => void): () => void;
}

/** PTY 의 cwd / 이어받기 / 권한우회 결정에 필요한 컨텍스트. */
export type AgentSpawnContext = {
  resumeFrom?: string;
  bypassPermissions: boolean;
};

/**
 * 토큰/사용량 잔량의 한 «윈도우» (구독 rate limit 의 5시간 / 주간 등).
 * agent 마다 윈도우 수·이름이 다르므로 의미 식별자 + 길이(분) 로 정규화하고,
 * 사람용 라벨 매핑 (5시간/주간) 은 iOS 가 windowMinutes 로 한다.
 */
export type AgentUsageWindow = {
  /** 의미 식별자 — claude: "five_hour"/"seven_day"/"seven_day_opus"…, codex: "primary"/"secondary". */
  id: string;
  /** 윈도우 길이 (분). 300=5시간, 10080=주간. 모르면 null. */
  windowMinutes: number | null;
  /** 사용률 0~100 (%). 잔량 = 100 - usedPercent. */
  usedPercent: number;
  /** 이 윈도우가 리셋되는 시각 (epoch ms). 모르면 null. */
  resetsAt: number | null;
};

/** usage() 가 성공적으로 돌려주는 잔량 리포트. */
export type AgentUsageReport = {
  windows: AgentUsageWindow[];
  /** 데이터 기준 시각 (epoch ms). live API 면 now, 파일 스냅샷이면 file mtime. */
  fetchedAt: number;
};

/**
 * 한 코드 에이전트 CLI 의 명세. registry 가 id 로 인덱싱한다.
 *
 * 모든 adapter 는 pure value — daemon 부팅 시 한 번 만들어 등록하고 끝. side effect 가
 * 필요한 (예: watcher start) 것은 메서드가 명시적으로 호출되어야 일어난다.
 */
export interface AgentAdapter {
  /** sessions.agent 컬럼 / iOS picker / API 에서 쓰는 stable identifier. snake_case. */
  readonly id: string;
  /** picker / banner / 가이드 등에서 노출되는 사용자 친화 이름. */
  readonly displayName: string;

  /**
   * 이 CLI 를 설치하는 «명령 / URL» — 코드성 문자열이라 번역 대상 아님. iOS picker 가
   * 미설치 agent (resolveBinary throw) 일 때 monospace 로 그대로 보여 준다 (예:
   * `npm install -g @anthropic-ai/claude-code`). 항상 설치돼 있는 adapter (shell) 나
   * 설치 흐름이 Mac 앱 안에 따로 있는 adapter (local_llm) 는 생략 가능.
   */
  readonly installHint?: string;

  /**
   * CLI 절대경로 해석. 못 찾으면 사용자 친화 메시지로 throw — 부팅 self-check 와 첫
   * spawn 모두 같은 메시지로 안내.
   */
  resolveBinary(): string;

  /**
   * PTY spawn 시 CLI 에 전달할 인자.
   * - resumeFrom 이 있으면 그 세션 이어가기 인자 추가 (--resume / --conversation 등).
   * - bypassPermissions 가 true 면 도구 자동 승인 인자 추가.
   * - 둘 다 모르는 agent 면 그냥 빈 배열을 반환해도 무방.
   */
  buildSpawnArgs(ctx: AgentSpawnContext): string[];

  /**
   * process.env 위에 덮어쓸 env. auto-updater 비활성, 비필수 트래픽 끄기 등 first-turn
   * latency 줄이는 용도. 비어 있어도 됨.
   */
  buildSpawnEnv(): Record<string, string>;

  /**
   * 첫 사용자 입력을 PTY 에 쓰기 전, splash/init(또는 로그인/모델 로딩)이 끝나길 기다리는
   * settle 타이밍. 생략하면 빠른 CLI 용 기본값(pty-runner 의 DEFAULT_FIRST_READY).
   *   - minMs: spawn 후 이 시각 전에는 절대 입력하지 않는다 (floor). agy 처럼 부팅 시
   *     Google 로그인/auth 를 수 초 진행하는 동안 stdin 이 «먹히는» 어댑터의 핵심 안전장치.
   *   - idleMs: floor 이후, 새 출력이 이만큼 멎으면 settled 로 보고 진행.
   *   - maxMs: 출력이 영영 안 멎어도 이 시각엔 강행하는 hard cap.
   * 예약 실행은 무인이라 첫 프롬프트가 로그인 흐름에 묻히면 통째로 사라진다 — 그 어댑터가
   * 여기서 floor/상한을 넉넉히 늘린다.
   */
  firstReadyTiming?(): { minMs: number; idleMs: number; maxMs: number };

  /**
   * 세션이 열릴 때(prewarm) 백엔드를 준비할 기회. local_llm 은 여기서 llama-server 를
   * 온디맨드 기동한다. 멱등 + fire-and-forget (throw 금지 — 서버가 안 떠도 PTY 는 뜨고
   * qwen 이 연결 에러를 표시하는 게 허용된 UX). 다른 adapter 는 구현하지 않는다.
   *
   * spawn ctx 를 받아 spawn 직전에 쓰는 설정 파일에 ctx 의존 값을 반영할 수 있다 (opencode
   * 는 bypassPermissions 를 opencode.json 의 permission 으로 주입 — CLI 플래그가 없으므로).
   * ctx 가 필요 없는 adapter (local_llm) 는 무시한다.
   */
  prepareBackend?(ctx: AgentSpawnContext): void;

  /**
   * prepareBackend 의 대칭 — 이 adapter 를 쓰는 마지막 세션 PTY 가 끝났을 때 공유 백엔드를
   * 해제할 기회. local_llm 은 여기서 llama-server(~38GB) 를 정지해 메모리를 회수한다.
   * PTY runner 가 「같은 adapter 를 쓰는 다른 활성 PTY 가 없을 때만」 디바운스 후 호출한다
   * (restart 의 즉시 재spawn 은 디바운스 안에 흡수돼 호출되지 않는다). 멱등 + throw 금지.
   * 백엔드 개념이 없는 adapter 는 구현하지 않는다.
   */
  releaseBackend?(): void;

  /** 데스크탑 세션 watcher — 미지원 (혹은 미구현) 이면 null. */
  desktopWatcher?(): DesktopAgentWatcher | null;

  /**
   * 토큰/사용량 잔량 조회 — 구독 rate limit 윈도우별 사용률 + 리셋 시각.
   * «미지원 agent 는 메서드 자체를 생략» — shell 처럼 토큰 비사용이거나 agy 처럼
   * 조회 경로가 없는 경우. 라우트가 supported:false 로 응답하고 iOS 가 UI 를 통째로
   * 숨긴다. 지원 agent 의 일시 실패 (키체인 접근 불가 / 네트워크 등) 는 throw —
   * 라우트가 supported:true + error 로 변환한다.
   */
  usage?(): Promise<AgentUsageReport>;

  /**
   * 「중지」(진행 중 turn 중단) 가 PTY 에 흘려보낼 제어 byte. 미정의면 ESC(\x1b) —
   * claude/codex REPL 의 취소 키. 에이전트마다 취소 키가 다르므로 어댑터가 광고한다:
   *   - claude_code / codex : ESC(\x1b) — 진행 turn 을 끊는다 (기본값, 메서드 생략).
   *   - agy / opencode / local_llm : ESC(\x1b) — 모두 Gemini CLI 계보(agy·qwen) 또는 TUI
   *     (opencode)의 «진행 turn 취소» 키가 ESC 라 명시적으로 광고한다. 폴백과 같은 키지만
   *     어댑터별 테스트로 못박아 폴백 의존을 끊는다 (각 어댑터 interruptBytes 주석에 출처).
   *   - copilot            : Ctrl-C(\x03) — GitHub Copilot CLI 는 ESC 가 «다이얼로그 닫기/
   *     큐 비우기» 같은 선택적 개입이라 진행 작업이 안 멈춘다(공식 문서 + github/copilot-cli
   *     #1422·#2681). 하드 스톱은 Ctrl-C 1회 — 진행 작업을 즉시 취소하되 종료는 2회라 세션은 산다.
   *   - shell              : Ctrl-C(\x03) — 셸엔 ESC 가 무의미. SIGINT 로 foreground 명령을 끊는다.
   *
   * writePtyRaw 로 그대로 흘려보내므로 «사람이 키보드로 누른 키» 와 동치 — PTY 를 죽이지 않는다
   * (abort 의 SIGTERM 과 다름). routes/sessions 의 /pty/control { action:"interrupt" } 가 사용.
   */
  interruptBytes?(): Buffer;

  /**
   * /api/version 에 advertise 할 capability 들 — adapter 가 실제 지원하는 기능에 따라
   * 다름. iOS 가 「이 기능이 지금 데몬에 있는지」 분기에 사용.
   */
  capabilities(): string[];
}
