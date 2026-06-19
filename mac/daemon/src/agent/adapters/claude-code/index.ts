/**
 * Claude Code (`claude` CLI) adapter — Anthropic 공식 CLI 의 인터랙티브 REPL 을 PTY 로
 * 띄우기 위한 spawn 명세.
 *
 * 인자 매핑:
 *  - `claude --resume <id>` ↔ AgentSpawnContext.resumeFrom
 *  - `claude --permission-mode bypassPermissions` ↔ AgentSpawnContext.bypassPermissions
 *
 * 첫 부팅 latency 최적화 env 들 (DISABLE_AUTOUPDATER, CLAUDE_CODE_DISABLE_*) 은 buildSpawnEnv
 * 안에 모여 있다. 첫 spawn 측정 (Opus 4.7, 80% 한도 도달):
 *  - 기본 부팅: 첫 응답까지 ~50-100s (auto-updater + native install 경고 + splash)
 *  - DISABLE_AUTOUPDATER=1 만: ~30-50s
 *  - 위 + 다른 비필수 사이드이펙트: ~10-20s
 *
 * desktopWatcher() 는 같은 디렉터리의 desktop-sessions.ts + watcher.ts 가 구현한다 —
 * jsonl 파싱 + fs.watch + 캐시 무효화.
 */
import type { AgentAdapter, AgentSpawnContext, DesktopAgentWatcher } from "../../types.js";
import { resolveClaudeBinary } from "./resolve-binary.js";
import { claudeCodeDesktopWatcher } from "./desktop-sessions.js";
import { claudeUsage } from "./usage.js";

export const claudeCodeAdapter: AgentAdapter = {
  id: "claude_code",
  displayName: "Claude Code",
  installHint: "npm install -g @anthropic-ai/claude-code",

  resolveBinary(): string {
    return resolveClaudeBinary();
  },

  buildSpawnArgs(ctx: AgentSpawnContext): string[] {
    const args: string[] = [];
    // 데스크탑 Claude Code 세션 이어받기 — UUID 가 있으면 `--resume <id>` 로 spawn 해
    // 이전 conversation 의 컨텍스트가 그대로 살아 있는 PTY 가 된다. 잘못된 UUID 면
    // claude 가 부팅 직후 에러 메시지를 PTY 에 찍고 종료 — 모바일 화면에 그대로 노출.
    if (ctx.resumeFrom && ctx.resumeFrom.length > 0) {
      args.push("--resume", ctx.resumeFrom);
    }
    if (ctx.bypassPermissions) {
      args.push("--permission-mode", "bypassPermissions");
    }
    return args;
  },

  buildSpawnEnv(): Record<string, string> {
    return {
      // Claude Code 가 splash/animation 을 키 입력으로 스킵하지 않도록 CI 표시는 안 함.
      // FORCE_COLOR 는 켜둬서 출력이 색을 갖게 한다 (모바일 ANSI 렌더러용).
      FORCE_COLOR: "1",
      // 자동 업데이트 비활성 — claude 부팅 시 새 버전 확인/다운로드/재시작에 수십초 소요.
      // 우리는 .app 안에 결정적 버전 박혀 있어서 런타임 업데이트가 오히려 노이즈/리스크.
      DISABLE_AUTOUPDATER: "1",
      // claude 의 백그라운드 prefetch / 옵셔널 트래픽 — 부팅 직후 모델 호출과 경쟁해 느림 유발.
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      // 공식 plugin marketplace 자동 설치 — 매 부팅마다 네트워크 호출. 우리는 plugin 미사용.
      CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: "1",
      // 자동 메모리 (~/.claude/CLAUDE.md 등 디스크 스캔/로드) — Tor 위에서 사용자가 폰으로
      // 짧게 묻는 시나리오에선 거의 이득이 없고, 부팅 시 디스크 IO 와 추가 토큰 비용.
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      // 터미널 타이틀 갱신 — 우리 PTY 는 사용자에게 직접 안 보이는 internal terminal.
      CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "1",
    };
  },

  desktopWatcher(): DesktopAgentWatcher {
    return claudeCodeDesktopWatcher;
  },

  // 토큰 잔량 — Keychain 의 OAuth 토큰으로 공식 usage 엔드포인트 조회 (same-dir usage.ts).
  usage() {
    return claudeUsage();
  },

  capabilities(): string[] {
    // claude_code_live_v1 는 라이브 tail 폐기와 함께 제거됨. claude_code 전용 capability
    // 가 다시 생기면 여기에 추가. (이어받기 / 자동 권한승인은 어차피 모든 adapter 공통이라
    // 별도 광고 없음.)
    // cron_eligible_v1: 예약 작업 픽커에 노출되는 «무인 실행에 적합한» 코드 에이전트 표식.
    return ["cron_eligible_v1"];
  },
};
