/**
 * Local LLM (Qwen Code + 로컬 llama-server) adapter — Mac 에서 직접 도는
 * Qwen3.6-35B-A3B Q8 을 백엔드로 쓰는 에이전트 CLI 를 PTY 로 띄우기 위한 spawn 명세.
 *
 * 구성 요소:
 *  - 추론 서버: llama-server (포트 51100, MTP speculative decoding) — 수명주기는 daemon
 *    supervisor 가 소유한다 (prepareBackend 가 온디맨드 기동, releaseBackend 가 마지막
 *    세션 종료 시 정지). 서버가 죽어 있으면 qwen 이 PTY 안에 연결 에러를 표시한다 —
 *    claude 가 네트워크 없을 때와 같은 UX.
 *  - 에이전트 CLI: qwen (Qwen Code) — OPENAI_* env 로 로컬 서버를 가리키게 한다.
 *    ~/.qwen/settings.json 의 modelProviders 와 무관하게 env 가 self-contained 라
 *    daemon spawn 이 사용자 설정에 의존하지 않는다.
 *
 * 인자 매핑:
 *  - `qwen --resume <id>` ↔ AgentSpawnContext.resumeFrom
 *    (resume 동작에는 --chat-recording 필요 — 항상 켠다)
 *  - `qwen --approval-mode yolo` ↔ AgentSpawnContext.bypassPermissions
 *
 * 데스크탑 세션 디스커버리는 same-dir `desktop-sessions.ts` 가 구현 —
 * `~/.qwen/projects/<slug>/chats/<uuid>.jsonl` (평문) 을 세션별로 파싱해 이어받기 후보를
 * 뽑는다. qwen 의 기록 포맷이 claude 와 동형이라 claude-code 의 per-file 패턴을 따른다.
 */
import type {
  AgentAdapter,
  AgentSpawnContext,
  DesktopAgentWatcher,
} from "../../types.js";
import { resolveQwenBinary } from "./resolve-binary.js";
import { localLlmDesktopWatcher } from "./desktop-sessions.js";
import { LLM_OPENAI_BASE_URL } from "../../../local-llm/paths.js";
import { ensureServer, stopServer } from "../../../local-llm/supervisor.js";
import { effectiveModelId } from "../../../local-llm/status.js";
import { getCatalogModel } from "../../../local-llm/catalog.js";
import { isModelDownloaded } from "../../../local-llm/download.js";

/** 로컬 추론 서버 — supervisor 의 LLM_PORT 단일 상수에서 파생 (drift 방지). */
export const LOCAL_LLM_BASE_URL = LLM_OPENAI_BASE_URL;
/** llama-server 는 키를 검증하지 않지만 qwen 의 openai auth 경로가 비어있지 않은 키를 요구. */
export const LOCAL_LLM_API_KEY = "sk-local-dummy";
/** 모델 id — 서버가 단일 모델 서빙이라 라우팅엔 안 쓰이고 로그/표시용. */
export const LOCAL_LLM_MODEL = "qwen3.6-35b-a3b-q8";

export const localLlmAdapter: AgentAdapter = {
  id: "local_llm",
  displayName: "Local · Qwen Code",

  resolveBinary(): string {
    return resolveQwenBinary();
  },

  /**
   * 세션 prewarm 시 llama-server 를 온디맨드 기동. selected/추천 모델이 받아져 있을 때만
   * 시작 — 안 받아져 있으면 no-op (iOS 가 모델 관리 화면으로 안내). fire-and-forget +
   * 멱등 (ensureServer 가 /health OK 면 adopt, 아니면 spawn). throw 금지.
   */
  prepareBackend(): void {
    try {
      const modelId = effectiveModelId();
      const model = getCatalogModel(modelId);
      if (!model || !isModelDownloaded(model)) return;
      // 도구호출 불가(분석 전용) 모델은 에이전트 백엔드로 띄우지 않는다 — qwen 이 tool-call 을
      // 보내도 모델이 못 받아 «초록불인데 파일이 안 써지는» 사고가 난다. no-op 으로 둔다.
      if (!model.toolCallCapable) return;
      void ensureServer(modelId);
    } catch {
      // 백엔드 준비 실패가 PTY 스폰을 막으면 안 됨 — qwen 이 연결 에러를 표시 (허용 UX).
    }
  },

  buildSpawnArgs(ctx: AgentSpawnContext): string[] {
    // --chat-recording: 세션을 디스크에 기록해야 --resume 이 동작한다.
    const args: string[] = ["--chat-recording"];
    if (ctx.resumeFrom && ctx.resumeFrom.length > 0) {
      args.push("--resume", ctx.resumeFrom);
    }
    if (ctx.bypassPermissions) {
      args.push("--approval-mode", "yolo");
    }
    return args;
  },

  buildSpawnEnv(): Record<string, string> {
    return {
      // 로컬 서버를 가리키는 self-contained 설정 — ~/.qwen/settings.json 불필요.
      OPENAI_BASE_URL: LOCAL_LLM_BASE_URL,
      OPENAI_API_KEY: LOCAL_LLM_API_KEY,
      OPENAI_MODEL: LOCAL_LLM_MODEL,
      // 모바일 ANSI 렌더러용 컬러 유지 (claude-code adapter 와 동일한 이유).
      FORCE_COLOR: "1",
    };
  },

  /**
   * 마지막 local_llm 세션 PTY 가 끝나면 llama-server 를 정지해 점유 메모리(~38GB)를 회수.
   * iOS 에서 로컬 Qwen Code 세션을 종료(삭제/quit)하면 PTY runner 가 디바운스 후 호출한다.
   * stopServer 는 우리가 띄운 서버만 정지(adopt 한 외부/LaunchAgent 서버는 no-op) + 멱등.
   * fire-and-forget — SIGTERM→SIGKILL 대기는 supervisor 내부에서.
   */
  releaseBackend(): void {
    void stopServer();
  },

  /**
   * 데스크탑(Mac)에서 시작한 로컬 Qwen Code 세션을 폰의 이어받기 후보로 노출한다 —
   * claude/agy 와 같은 패리티. 선택 시 buildSpawnArgs 의 ctx.resumeFrom → `--resume <id>`
   * 경로로 데스크탑 세션을 이어받는다. 기록(`~/.qwen/projects`)이 없으면 watcher 가 빈
   * 목록을 반환해 회귀 없이 동작.
   */
  desktopWatcher(): DesktopAgentWatcher {
    return localLlmDesktopWatcher;
  },

  // usage 생략 — 로컬 서버는 rate limit 윈도우 개념이 없음 (iOS 가 UI 를 숨긴다).

  /**
   * 「중지」 제어 byte — ESC(\x1b). 명시적이지만 «기본값과 동일» 한 키를 광고한다.
   *
   * local_llm 의 에이전트 CLI 는 qwen(Qwen Code) — Gemini CLI 의 포크다. 진행 중 요청의 취소
   * 키는 ESC 다(qwen-code 소스의 tips: 「Press Esc to cancel an in-flight request」,
   * AppContainer 의 escape 핸들러가 스트림을 cancel; 답변 중 푸터 「Press Escape, Ctrl+C, or
   * Ctrl+D to cancel」). ESC 는 진행 turn 만 끊고 세션은 살린다 — Ctrl-C/Ctrl-D 는 종료까지
   * 가므로 1회로 세션을 죽일 위험이 있어 피한다(가장 안전한 중단 = ESC).
   *
   * 백엔드 주의: qwen 은 llama-server(51100)를 백엔드로 쓴다 — 이 ESC 는 PTY stdin 에만
   * 흘러가(writePtyRaw) qwen 의 진행 turn 만 끊고, 백엔드 프로세스 수명(supervisor 소유)엔
   * 영향이 없다.
   *
   * 미정의면 어차피 ESC 폴백이라 동작은 같지만(회귀 0), 명시해 어댑터별 단위 테스트로 못박는다.
   */
  interruptBytes(): Buffer {
    return Buffer.from([0x1b]); // ESC — Qwen Code(Gemini CLI 포크)의 in-flight 취소 키
  },

  capabilities(): string[] {
    // install_runtime_v1: 런타임 구성요소(llama-server/qwen)를 폰에서 한 탭으로 Mac 에
    // 설치하는 라우트(POST /api/admin/install-agent { component }) 지원. 옛 daemon 은 이
    // 플래그가 없어 iOS 가 기존 «Mac 에서 설치» 안내로 폴백(회귀 없음).
    return ["install_runtime_v1"];
  },
};
