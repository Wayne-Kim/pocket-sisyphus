/**
 * agy (Google Antigravity) adapter — `agy` CLI 의 인터랙티브 REPL 을 PTY 로 띄우기 위한
 * spawn 명세. claude_code adapter 와 인자 모양이 거의 1:1 대응:
 *
 *   claude --resume <id>                       ↔  agy --conversation <id>
 *   claude --permission-mode bypassPermissions ↔  agy --dangerously-skip-permissions
 *
 * 데스크탑 세션 디스커버리는 same-dir `desktop-sessions.ts` 가 구현 —
 * `~/.gemini/antigravity-cli/history.jsonl` 의 conversationId group-by 로 이어받기
 * 후보를 뽑는다. agy 본문 (`.pb`) 은 사설 컨테이너라 디코드 불가, history.jsonl 만 사용.
 *
 * env 는 일단 비어 있음 — agy 의 auto-updater / nonessential traffic 환경변수가 있는지
 * 운영 중 추가 조사 후 빌드 코멘트로 옮길 예정.
 */
import type {
  AgentAdapter,
  AgentSpawnContext,
  DesktopAgentWatcher,
} from "../../types.js";
import { resolveAgyBinary } from "./resolve-binary.js";
import { agyDesktopWatcher } from "./desktop-sessions.js";

export const agyAdapter: AgentAdapter = {
  id: "agy",
  displayName: "Antigravity CLI",
  // 공식 macOS 원라인 설치 스크립트 — claude_code/codex 의 `npm install -g …` 와 같은 «실행
  // 가능한 명령» 이라 installHintIsCommand 가 true → 폰에서 「Mac 에 설치」 버튼이 그대로 동작
  // (URL hint 였을 땐 가이드 열기로만 폴백했다). install.sh 는 바이너리를 ~/.local/bin/agy 에
  // 떨궈 resolveAgyBinary 의 1순위 후보로 바로 잡힌다. 우리 소스의 리터럴 상수 (셸 인젝션 표면 0).
  installHint: "curl -fsSL https://antigravity.google/cli/install.sh | bash",

  resolveBinary(): string {
    return resolveAgyBinary();
  },

  buildSpawnArgs(ctx: AgentSpawnContext): string[] {
    const args: string[] = [];
    // 데스크탑 세션 이어받기 — conversation id 가 있으면 `--conversation <id>`. 잘못된
    // id 면 agy 가 부팅 직후 에러 메시지 찍고 종료 — 모바일 화면에 그대로 노출.
    if (ctx.resumeFrom && ctx.resumeFrom.length > 0) {
      args.push("--conversation", ctx.resumeFrom);
    }
    // 도구 자동 승인 — claude 의 --permission-mode bypassPermissions 와 동등.
    if (ctx.bypassPermissions) {
      args.push("--dangerously-skip-permissions");
    }
    return args;
  },

  buildSpawnEnv(): Record<string, string> {
    // 일단 추가 env 없음. agy 의 latency 튜닝 env 발견 시 여기로.
    return {};
  },

  /**
   * agy 는 부팅 직후 Google 로그인/auth 를 ~10s 진행하고, 그 사이 stdin 으로 들어온 입력은
   * 무시된다. 기본 settle(상한 1.2s)로는 로그인 도중에 첫 프롬프트를 써버려 — 특히 무인
   * 예약 실행에서 — 명령이 통째로 사라진다. spawn 후 최소 11s 는 기다리고(로그인 floor),
   * 그 뒤 출력이 0.6s 멎으면 진행(로그인 막바지의 짧은 공백에 조기 발사 안 하도록 여유),
   * 최대 20s 에서 강행.
   */
  firstReadyTiming() {
    return { minMs: 11_000, idleMs: 600, maxMs: 20_000 };
  },

  desktopWatcher(): DesktopAgentWatcher {
    return agyDesktopWatcher;
  },

  /**
   * 「중지」 제어 byte — ESC(\x1b). 명시적이지만 «기본값과 동일» 한 키를 광고한다.
   *
   * agy(Antigravity CLI)는 Gemini CLI 계보의 인터랙티브 REPL 이라 — claude_code 와 1:1 대응
   * (이 어댑터 상단 주석 참고), 그 설정도 `~/.gemini/antigravity-cli/` 아래에 둔다 — 진행 중
   * turn(스트리밍)의 취소 키가 ESC 다(Gemini CLI 의 `basic.cancel`; 공식 cheatsheet 「Esc to
   * cancel current request / stop streaming」). Ctrl-C 는 프롬프트가 비어 있으면 «종료» 로도
   * 작동해 위험하다 — 1회로 세션을 죽일 수 있다. ESC 는 진행 작업만 끊고 세션은 살리는 «가장
   * 안전한 중단» 이라, 무인 예약/워크플로우 실행에 적합하다.
   *
   * 미정의면 어차피 ESC 폴백이라 동작은 같지만(회귀 0), interruptBytes 를 명시해 — copilot/shell
   * 처럼 — 어댑터별 단위 테스트로 「중지 = 이 키」를 못박고 폴백 의존을 끊는다.
   *
   * 엣지: 부팅 직후 ~10s 로그인(firstReadyTiming 참고) 동안 agy 는 stdin 입력을 무시하므로
   * 이 ESC 도 무시될 수 있다 — 그 구간엔 진행 중 turn 자체가 없어 끊을 게 없다(무해). 로그인이
   * 끝나 실제 turn 이 돌면 정상적으로 끊긴다.
   */
  interruptBytes(): Buffer {
    return Buffer.from([0x1b]); // ESC — Gemini CLI 계보의 진행 turn 취소 키
  },

  capabilities(): string[] {
    // 이어받기는 지원 / 라이브 본문 tail 은 미지원 (`.pb` 디코드 불가). iOS picker 가
    // capability 보고 라이브 관전 같은 기능을 grey-out 할 때 쓴다.
    // cron_eligible_v1: 예약 작업 픽커에 노출되는 «무인 실행에 적합한» 코드 에이전트 표식
    // (terminal/local_llm 은 제외 — 셸은 무인 작업 의미 없음, 로컬 LLM 은 콜드스타트 과다).
    return ["agy_resume_v1", "cron_eligible_v1"];
  },
};
