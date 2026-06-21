/**
 * shell adapter — 코드 에이전트 CLI 가 아니라 그냥 사용자 셸(`zsh`/`bash`) 을 PTY 로
 * 띄우는 어댑터. iOS picker 에 "Terminal" 로 노출돼 "단순 터미널 열기" 기능을 담당한다.
 *
 * 다른 adapter 들과 달리 resumeFrom / bypassPermissions 가 의미 없다 — 둘 다 무시한다.
 * desktopWatcher 도 제공 안 함 (zsh 자체에 "이어받을 데스크탑 세션" 개념이 없음). 라우트
 * `/api/agents/shell/desktop-sessions` 는 자동으로 `{sessions: []}` 를 반환하도록 desktop-
 * sessions.ts:48 가 처리해 준다.
 *
 * 셸 선택은 `$SHELL` 우선, 없으면 `/bin/zsh` (macOS 디폴트). launchd 로 띄워진 daemon 에서는
 * `$SHELL` 이 비어있을 수 있어 fallback 이 실질적인 디폴트.
 *
 * `-l` 로 login shell 부팅 — Terminal.app 의 디폴트와 동일한 경험을 주려면 zprofile/zshrc
 * 가 풀로 평가돼 PATH/aliases 가 잡혀야 한다. 첫 spawn 이 100~300ms 더 걸리지만 「내 셸」 처럼
 * 느끼는 게 더 중요.
 */
import type { AgentAdapter } from "../../types.js";

export const shellAdapter: AgentAdapter = {
  id: "shell",
  displayName: "Terminal",

  resolveBinary(): string {
    return process.env.SHELL ?? "/bin/zsh";
  },

  buildSpawnArgs(): string[] {
    return ["-l"];
  },

  buildSpawnEnv(): Record<string, string> {
    return {};
  },

  /**
   * 「중지」 제어 byte — Ctrl-C(\x03, SIGINT). 셸엔 ESC 가 무의미(편집 키일 뿐)하고, 실행 중
   * foreground 명령을 끊는 건 SIGINT 다. 명령이 없으면 입력 줄만 취소돼 무해 — 셸은 죽지 않는다.
   */
  interruptBytes(): Buffer {
    return Buffer.from([0x03]); // Ctrl-C (SIGINT)
  },

  capabilities(): string[] {
    return [];
  },
};
