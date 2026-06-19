/**
 * OpenCode adapter — 오픈소스 표준 코드 에이전트 CLI(opencode)의 인터랙티브 TUI 를 PTY 로
 * 띄우되, 백엔드는 우리가 이미 띄우는 로컬 llama-server(127.0.0.1:51100/v1)를 그대로 쓴다.
 *
 * # 왜 opencode 인가
 *
 * 기존 로컬 LLM 경로는 (Qwen Code CLI ⊗ Qwen 모델) 한 덩어리로 고정돼 다른 에이전트
 * 하네스를 못 썼다. opencode 는 OpenAI 호환 baseURL 한 줄로 로컬 모델을 front 하는 표준
 * CLI라, CLI 만 갈아끼우면 «모델 선택 자유» 가 열린다 (llama-server 가 그대로 백엔드).
 *
 * # 구성 요소 (local-llm 어댑터와 백엔드 공유)
 *  - 추론 서버: llama-server (포트 51100) — 수명주기는 daemon supervisor 소유.
 *    prepareBackend 가 온디맨드 기동, releaseBackend 가 마지막 세션 종료 시 정지. local-llm
 *    어댑터와 «같은» ensureServer/stopServer 를 재사용한다. 두 어댑터가 한 서버를 공유하므로
 *    routes/sessions.ts 가 둘을 묶어 동시 활성 세션을 1개로 제한한다(서버 --parallel 1 +
 *    cross-adapter releaseBackend 가 남의 세션을 끊는 레이스 방지).
 *  - 에이전트 CLI: opencode — 프로바이더 설정(opencode.json, @ai-sdk/openai-compatible)을
 *    OPENCODE_CONFIG 가 가리키는 daemon 소유 파일에 주입(config.ts). 사용자의 전역/프로젝트
 *    설정을 건드리지 않는다.
 *
 * # 인자/설정 매핑 (인터랙티브 TUI — `opencode run` 비대화형은 1차 비목표)
 *  - `opencode --session <id>` ↔ AgentSpawnContext.resumeFrom
 *  - AgentSpawnContext.bypassPermissions ↔ opencode.json 의 `permission: "allow"`
 *    (CLI 플래그 아님 — opencode 엔 권한우회 플래그가 없어 설정 파일로만 가능)
 *
 * 주의: `opencode run` (비대화형) 은 권한 프롬프트가 hang 될 리스크가 있어 1차는 대화형 PTY
 * 세션만 노출한다 — 권한 결재는 TUI 안에서 사람이 한다(또는 bypassPermissions 로 YOLO).
 *
 * 데스크탑 세션 디스커버리는 same-dir `desktop-sessions.ts` 가 구현 — opencode(v1.17+)의 단일
 * SQLite 스토어(`~/.local/share/opencode/opencode.db`)의 `session` 테이블을 read-only 로 읽어
 * 이어받기 후보를 뽑는다. claude/qwen 은 세션별 jsonl 이라 per-file 파싱이지만 opencode 는 한
 * DB 라 한 번의 SELECT 로 끝난다 (claude/codex/agy/qwen 패리티 — 폰에서 데스크탑 opencode
 * 세션을 그대로 이어받는다).
 */
import type {
  AgentAdapter,
  AgentSpawnContext,
  DesktopAgentWatcher,
} from "../../types.js";
import { resolveOpencodeBinary } from "./resolve-binary.js";
import { opencodeDesktopWatcher } from "./desktop-sessions.js";
import { ensureOpencodeConfig, OPENCODE_CONFIG_PATH, OPENCODE_API_KEY } from "./config.js";
import { readExternalConfig } from "./external.js";
import { LLM_OPENAI_BASE_URL } from "../../../local-llm/paths.js";
import { ensureServer, stopServer } from "../../../local-llm/supervisor.js";
import { effectiveModelId } from "../../../local-llm/status.js";
import { getCatalogModel } from "../../../local-llm/catalog.js";
import { isModelDownloaded } from "../../../local-llm/download.js";

/** 로컬 추론 서버 — local-llm 과 같은 LLM_PORT 단일 상수에서 파생 (drift 방지). */
export const OPENCODE_BASE_URL = LLM_OPENAI_BASE_URL;

/**
 * iOS 가 「고급: 내 로컬 서버 사용」 설정 UI 노출을 분기하는 어댑터 capability. 옛 daemon 은
 * 이 플래그가 없어 iOS 가 설정을 숨긴다(회귀 없음 — /api/opencode 라우트도 없으니 막다른 길 0).
 */
export const OPENCODE_EXTERNAL_CAPABILITY = "opencode_external_v1";

export const opencodeAdapter: AgentAdapter = {
  id: "opencode",
  displayName: "Local · OpenCode",
  installHint: "npm install -g opencode-ai",

  resolveBinary(): string {
    return resolveOpencodeBinary();
  },

  /**
   * 세션 prewarm 시 ① opencode 프로바이더 설정을 현재 effective 모델로 materialize 하고
   * ② llama-server 를 온디맨드 기동. 설정 쓰기는 spawn 직전 동기적으로 끝나 buildSpawnEnv
   * 가 OPENCODE_CONFIG 경로를 가리킬 때 파일이 존재함을 보장한다(pty-runner 가 prepareBackend
   * → buildSpawnEnv 순으로 호출). 서버 기동은 selected/추천 모델이 받아져 있을 때만 — 안 받아져
   * 있으면 no-op (opencode 가 연결 에러를 표시, 허용 UX). 멱등 + throw 금지.
   */
  prepareBackend(ctx: AgentSpawnContext): void {
    try {
      const bypassPermissions = ctx.bypassPermissions;
      // 외부 엔드포인트 모드 — 사용자의 OpenAI 호환 로컬 서버(Ollama 등)를 그대로 쓴다.
      // 번들 llama-server 의 ensureServer 를 «건너뛰고» 그 baseURL 로 opencode.json 을 박는다.
      // 도달성/모델 존재 검증은 iOS 설정의 헬스체크가 사전에 한다(여기선 fire-and-forget).
      const ext = readExternalConfig();
      if (ext) {
        ensureOpencodeConfig(ext.modelId, { baseUrl: ext.baseUrl, bypassPermissions });
        return;
      }
      const modelId = effectiveModelId();
      ensureOpencodeConfig(modelId, { bypassPermissions });
      const model = getCatalogModel(modelId);
      if (!model || !isModelDownloaded(model)) return;
      void ensureServer(modelId);
    } catch {
      // 백엔드 준비 실패가 PTY 스폰을 막으면 안 됨 — opencode 가 연결 에러를 표시 (허용 UX).
    }
  },

  buildSpawnArgs(ctx: AgentSpawnContext): string[] {
    const args: string[] = [];
    // 세션 이어받기 — opencode TUI 의 `--session <id>` (대화형 재개). 잘못된 id 면 opencode
    // 가 부팅 직후 에러를 표시 — 모바일 화면에 그대로 노출.
    if (ctx.resumeFrom && ctx.resumeFrom.length > 0) {
      args.push("--session", ctx.resumeFrom);
    }
    // 도구 자동 승인(bypassPermissions)은 CLI 플래그가 아니라 opencode.json 의
    // permission: "allow" 로 처리한다 (prepareBackend → ensureOpencodeConfig). opencode 엔
    // 권한우회 플래그가 없어 — 예전 `--dangerously-skip-permissions`(claude-code 의 플래그)는
    // yargs 가 «알 수 없는 옵션» 으로 거부하고 help 를 찍어 TUI 가 안 떴다(입력 불가 회귀).
    return args;
  },

  buildSpawnEnv(): Record<string, string> {
    // 외부 엔드포인트 모드면 사용자의 baseURL 을, 아니면 번들 llama-server 를 가리킨다.
    // 라우팅의 진실은 opencode.json(prepareBackend 가 같은 baseURL 로 박음) — 이 env 는
    // opencode 빌트인 openai 경로/일부 ai-sdk 변형이 키를 env 에서 읽는 경우의 안전망.
    const ext = readExternalConfig();
    return {
      // daemon 소유 opencode.json 을 가리켜 로컬 프로바이더(@ai-sdk/openai-compatible)를
      // 주입 — 사용자의 전역/프로젝트 설정 비파괴. 파일은 prepareBackend 가 미리 쓴다.
      OPENCODE_CONFIG: OPENCODE_CONFIG_PATH,
      OPENAI_BASE_URL: ext ? ext.baseUrl : OPENCODE_BASE_URL,
      OPENAI_API_KEY: OPENCODE_API_KEY,
      // 모바일 ANSI 렌더러용 컬러 유지 (claude-code / local-llm 어댑터와 동일한 이유).
      FORCE_COLOR: "1",
    };
  },

  /**
   * 마지막 opencode 세션 PTY 가 끝나면 llama-server 를 정지해 점유 메모리(~38GB)를 회수.
   * local-llm 과 같은 stopServer 를 재사용 — 우리가 띄운 서버만 정지(adopt 한 외부/LaunchAgent
   * 서버는 no-op) + 멱등. fire-and-forget. opencode 와 local_llm 은 sessions 라우트가 동시
   * 활성을 1개로 묶어 막으므로, 한 어댑터의 release 가 다른 어댑터의 살아있는 세션을 끊지 않는다.
   */
  releaseBackend(): void {
    void stopServer();
  },

  /**
   * 데스크탑(Mac)에서 시작한 opencode 세션을 폰의 이어받기 후보로 노출한다 —
   * claude/codex/agy/qwen 과 같은 패리티. 선택 시 buildSpawnArgs 의 ctx.resumeFrom →
   * `opencode --session <id>` 경로로 데스크탑 세션을 이어받는다. opencode 스토어
   * (`~/.local/share/opencode/opencode.db`)가 없거나 읽기 실패면 watcher 가 빈 목록을
   * 반환해 회귀 없이 동작.
   */
  desktopWatcher(): DesktopAgentWatcher {
    return opencodeDesktopWatcher;
  },

  // usage 생략 — 로컬 서버는 rate limit 윈도우 개념이 없음 (iOS 가 UI 를 숨긴다).

  /**
   * 「중지」 제어 byte — ESC(\x1b). 명시적이지만 «기본값과 동일» 한 키를 광고한다.
   *
   * opencode TUI 의 공식 기본 키맵에서 진행 중 세션의 취소는 `session_interrupt: "escape"` 다
   * (https://opencode.ai/docs/keybinds — SSOT). ESC 가 다이얼로그 닫기/포커스로만 쓰일까 봐
   * 우려했지만(엣지케이스), 실측 키맵상 자동완성 팝업이 열려 있을 때만 ESC 가 그쪽
   * (`prompt.autocomplete.hide`)으로 가고 — 그 외엔 항상 세션 인터럽트다. 진행 turn 이 도는
   * 「중지」 상황엔 팝업이 없으므로 ESC 가 정확히 중단으로 작동한다. 종료는 Ctrl-C(`app_exit`)
   * 라 ESC 1회로는 세션이 산다.
   *
   * 백엔드 주의: opencode 는 llama-server(51100)를 local_llm 과 공유한다 — 이 ESC 는 PTY
   * stdin 에만 흘러가(writePtyRaw) TUI 의 진행 turn 만 끊고, 백엔드 프로세스 수명(supervisor
   * 소유)엔 일절 영향이 없다.
   *
   * 미정의면 어차피 ESC 폴백이라 동작은 같지만(회귀 0), 명시해 어댑터별 단위 테스트로 못박는다.
   */
  interruptBytes(): Buffer {
    return Buffer.from([0x1b]); // ESC — opencode 의 session_interrupt 기본 키
  },

  capabilities(): string[] {
    // cron_eligible_v1 미포함 — 로컬 추론은 콜드스타트가 과다해 무인 예약 실행에 부적합
    // (local_llm 과 같은 정책). 1차는 대화형 PTY 세션만.
    // opencode_external_v1 — iOS 가 「고급: 내 로컬 서버 사용」 설정 노출을 분기.
    return [OPENCODE_EXTERNAL_CAPABILITY];
  },
};
