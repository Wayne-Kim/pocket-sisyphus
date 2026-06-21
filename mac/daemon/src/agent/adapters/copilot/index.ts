/**
 * copilot (GitHub Copilot CLI) adapter — `copilot` CLI 의 인터랙티브 세션을 PTY 로 띄우기
 * 위한 spawn 명세. codex / claude_code adapter 와 인자 모양이 대응:
 *
 *   claude --resume <id>                       ↔  copilot --resume <id>
 *   claude --permission-mode bypassPermissions ↔  copilot --allow-all
 *
 * codex 와 달리 copilot 의 resume / 권한 우회는 모두 top-level OPTION 이라 subcommand 순서
 * 제약이 없다. `--allow-all` 은 `--allow-all-tools --allow-all-paths --allow-all-urls` 와
 * 동등 — 무인(예약) 실행에서 도구/경로/URL 확인 프롬프트에 막히지 않도록 전체 우회한다.
 *
 * 마우스: copilot TUI 는 부팅 시 mouse tracking 을 «기본 ON» 으로 켜고 본문 스크롤을
 * «마우스 휠» 로만 받는다(화살표/터치 무반응). 그래서 `--no-mouse` 를 주면 안 된다 — 휠
 * 보고가 꺼져 iOS 의 «스크롤 위/아래» 버튼(휠 SGR 시퀀스 주입)이 통째로 먹히지 않는다.
 * 인자 없이(=마우스 ON) 둔다.
 *
 * [감사 — copilot 1.0.63, PTY 부팅 출력으로 실측 검증] spawn 직후 mode-set 시퀀스가
 *   ?1049h(alt-screen) → ?2004h(bracketed paste) → ?1004h(focus 보고) →
 *   ?1002h(button-event 마우스 추적) → ?1006h(SGR 확장 좌표)
 * 순으로 나온다. 즉 «1002+1006 이 플래그 없이 켜진다» 는 가정이 실측으로 성립한다. CLI 에는
 * `--mouse` / `--no-mouse` 가 실재하며(`--no-mouse` = alt-screen 마우스 지원 OFF), 이를 주면
 * 위 시퀀스가 사라져 휠 주입이 통째로 죽는다 — 그러므로 절대 추가하지 않는다.
 *
 * 이 가정을 iOS 와 묶는 끈이 capability `wheel_scroll_v1` 이다(아래 capabilities() 참고):
 * 하드코딩 isCopilot 대신 daemon 이 «이 에이전트는 본문을 휠로만 굴린다» 를 광고하고, iOS 는
 * 그 신호가 붙은 세션에만 스크롤 버튼을 노출한다 — 같은 류의 alt-screen TUI 가 새로 들어오면
 * 그 어댑터에 capability 만 달면 iOS 수정 없이 자동 적용된다.
 *
 * (원인 분리) 마우스 모드는 «한글 입력 불가» 의 원인이 «아니다» — 휠 보고는 출력→입력의
 * 단방향 좌표 보고일 뿐 IME/키 입력 경로와 무관하다. 「스크롤이 안 된다 → 마우스를 끈다」 는
 * 잘못된 수정은 휠 스크롤만 깨뜨릴 뿐 한글 입력엔 영향이 없으니 재발 금지.
 *
 * 데스크탑 세션 이어받기 디스커버리는 same-dir `desktop-sessions.ts` 가 구현 — copilot 은
 * 세션을 단일 sqlite(`~/.copilot/session-store.db`)에 보관하므로, 그 `sessions` 테이블을
 * read-only 로 한 번 SELECT 해 이어받기 후보를 뽑는다 (opencode 와 동형 — claude/codex/agy/
 * qwen/opencode 패리티). 선택 시 buildSpawnArgs 의 ctx.resumeFrom → `--resume <id>` 경로로
 * 데스크탑 세션을 이어받는다. agy/opencode 와 같은 경계: 이어받기 디스커버리는 지원하되 라이브
 * 본문 tail(과거 대화 재생)은 미지원. DB 가 없거나(미설치) 읽기 실패면 빈 목록으로 graceful 폴백.
 */
import type {
  AgentAdapter,
  AgentSpawnContext,
  DesktopAgentWatcher,
} from "../../types.js";
import { resolveCopilotBinary } from "./resolve-binary.js";
import { copilotDesktopWatcher } from "./desktop-sessions.js";

export const copilotAdapter: AgentAdapter = {
  id: "copilot",
  displayName: "Copilot CLI",
  installHint: "npm install -g @github/copilot",

  resolveBinary(): string {
    return resolveCopilotBinary();
  },

  buildSpawnArgs(ctx: AgentSpawnContext): string[] {
    const args: string[] = [];
    // 도구 자동 승인 — claude 의 --permission-mode bypassPermissions / codex 의
    // --dangerously-bypass-approvals-and-sandbox 와 동등. --allow-all 은 도구·경로·URL
    // 확인을 모두 끈다 (무인 예약 실행이 프롬프트에 막혀 통째로 사라지는 것 방지).
    if (ctx.bypassPermissions) {
      args.push("--allow-all");
    }
    // 데스크탑 세션 이어받기 — 세션 id/이름/prefix 가 있으면 `--resume <id>`. 잘못된 값이면
    // copilot 이 부팅 직후 에러를 PTY 에 찍고 종료 — 모바일 화면에 그대로 노출된다.
    if (ctx.resumeFrom && ctx.resumeFrom.length > 0) {
      args.push("--resume", ctx.resumeFrom);
    }
    return args;
  },

  buildSpawnEnv(): Record<string, string> {
    // 일단 추가 env 없음. copilot 의 latency 튜닝 / auto-update 비활성 env 가 명확해지면 여기로.
    return {};
  },

  /**
   * copilot CLI 는 부팅 시 alt-screen TUI(스플래시 + auth/init 점검 + 입력 박스 렌더)를
   * 수 초에 걸쳐 그리고, 그 사이 stdin 으로 들어온 입력은 입력 박스가 정착하기 전이라 «먹힌다».
   * 기본 settle(상한 1.2s)로는 — 특히 백로그/예약 같은 무인 흐름에서 spawn 직후 곧장 첫
   * 프롬프트를 써버려 — 명령이 통째로 사라진다(사용자 보고: 「백로그에서 copilot CLI 쓰면
   * 메시지가 copilot 에서 사라짐」). agy(부팅 로그인 ~10s)와 같은 류의 race 라, floor/상한을
   * 넉넉히 늘려 입력 박스가 정착한 뒤에만 첫 프롬프트를 쓴다.
   *
   *   - minMs: spawn 후 최소 2.5s 는 기다린다(TUI 가 입력 박스를 렌더하고 입력 가능해지는 floor).
   *   - idleMs: floor 이후 출력이 0.5s 멎으면 settled 로 보고 진행(스플래시 막바지의 짧은 공백에
   *     조기 발사하지 않도록 기본값보다 여유).
   *   - maxMs: 스피너/푸터가 주기적으로 깜빡여 idle 이 영영 안 잡혀도 8s 에서 강행.
   *
   * waitForPtyFirstReady 는 «첫 입력 1회» 에만 걸리고 경과를 spawnedAt 기준으로 재므로,
   * 사람이 직접 타이핑하는 인터랙티브 채팅은 부팅 시간이 이미 흘러 즉시 통과 — 이 상향은
   * spawn 직후 곧장 쓰는 무인 흐름(버그 케이스)만 보정한다.
   */
  firstReadyTiming() {
    return { minMs: 2500, idleMs: 500, maxMs: 8000 };
  },

  /**
   * 데스크탑(Mac)에서 시작한 copilot 세션을 폰의 이어받기 후보로 노출한다 —
   * claude/codex/agy/qwen/opencode 와 같은 패리티. 선택 시 buildSpawnArgs 의 ctx.resumeFrom →
   * `copilot --resume <id>` 경로로 데스크탑 세션을 이어받는다. copilot 스토어
   * (`~/.copilot/session-store.db`)가 없거나 읽기 실패면 watcher 가 빈 목록을 반환해 회귀
   * 없이 동작 (가이드의 over-promise 제거 — 이제 copilot 도 다른 어댑터와 동등하게 후보가 뜬다).
   */
  desktopWatcher(): DesktopAgentWatcher {
    return copilotDesktopWatcher;
  },

  /**
   * 「중지」 제어 byte — Ctrl-C(\x03). claude/codex 의 기본 ESC 와 다르다.
   *
   * GitHub Copilot CLI 에서 ESC 는 «선택적 개입» 이다: 권한 다이얼로그가 떠 있으면 그걸 닫고,
   * 큐에 쌓인 후속 프롬프트가 있으면 그것부터 비운다 — 그런 게 없을 때만 진행 작업을 끊고,
   * 그마저도 ESC 가 안 듣고 Ctrl-C 만 듣는 버그가 보고돼 있다(공식 문서 + github/copilot-cli
   * #1422·#2681). 무인 PO/예약 run(--allow-all, 다이얼로그 없음)을 «즉시» 멈추려면 하드 스톱인
   * Ctrl-C 1회가 정답 — 진행 작업·큐를 한 번에 취소한다. 종료는 Ctrl-C 2회라 1회로는 세션이 산다.
   */
  interruptBytes(): Buffer {
    return Buffer.from([0x03]); // Ctrl-C (ETX)
  },

  capabilities(): string[] {
    // copilot_resume_v1: `--resume` 인자 지원 표식 (codex_resume_v1 과 같은 자리).
    // cron_eligible_v1: 예약 작업 픽커에 노출되는 «무인 실행에 적합한» 코드 에이전트 표식.
    // wheel_scroll_v1: 본문을 «마우스 휠로만» 굴리는 alt-screen TUI 표식 (위 마우스 주석의 실측
    //   감사 참고). iOS 가 이 신호가 붙은 세션에만 «스크롤 위/아래» 버튼을 노출한다 — 하드코딩
    //   isCopilot 게이트를 대체해, 같은 류의 새 에이전트가 들어와도 이 capability 만 달면
    //   iOS 수정 없이 버튼이 자동으로 붙는다. (daemon 측 휠 주입은 pty-runner.sendPtyKey 의
    //   scroll_up/scroll_down 분기 — 이 capability 와 같은 daemon 버전에 함께 들어가 lockstep.)
    return ["copilot_resume_v1", "cron_eligible_v1", "wheel_scroll_v1"];
  },
};
