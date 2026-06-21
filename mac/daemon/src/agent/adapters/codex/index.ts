/**
 * codex (OpenAI Codex CLI) adapter — `codex` CLI 의 인터랙티브 REPL 을 PTY 로 띄우기
 * 위한 spawn 명세. claude_code / agy adapter 와 인자 모양이 대응:
 *
 *   claude --resume <id>                       ↔  codex resume <id>      (subcommand)
 *   claude --permission-mode bypassPermissions ↔  codex --dangerously-bypass-approvals-and-sandbox
 *
 * codex 의 resume 는 subcommand 형태 (`codex resume <uuid>`). top-level OPTION 은 subcommand
 * 보다 앞에 와야 한다 (clap convention): 즉 `codex --dangerously-... resume <uuid>`.
 *
 * 데스크탑 세션 디스커버리는 same-dir `desktop-sessions.ts` 가 구현 —
 * `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` 의 session_meta line 파싱.
 */
import type {
  AgentAdapter,
  AgentSpawnContext,
  DesktopAgentWatcher,
} from "../../types.js";
import { resolveCodexBinary } from "./resolve-binary.js";
import { codexDesktopWatcher } from "./desktop-sessions.js";
import { codexUsage } from "./usage.js";

export const codexAdapter: AgentAdapter = {
  id: "codex",
  displayName: "Codex CLI",
  installHint: "npm install -g @openai/codex",

  resolveBinary(): string {
    return resolveCodexBinary();
  },

  buildSpawnArgs(ctx: AgentSpawnContext): string[] {
    const args: string[] = [];
    // 도구 자동 승인 — claude 의 --permission-mode bypassPermissions / agy 의
    // --dangerously-skip-permissions 와 동등. top-level option 이므로 subcommand 보다 앞에.
    if (ctx.bypassPermissions) {
      args.push("--dangerously-bypass-approvals-and-sandbox");
    }
    // 데스크탑 세션 이어받기 — UUID 가 있으면 `resume <id>` subcommand. 잘못된 UUID 면
    // codex 가 부팅 직후 에러 메시지를 PTY 에 찍고 종료 — 모바일 화면에 그대로 노출.
    if (ctx.resumeFrom && ctx.resumeFrom.length > 0) {
      args.push("resume", ctx.resumeFrom);
    }
    return args;
  },

  buildSpawnEnv(): Record<string, string> {
    // 일단 추가 env 없음. codex 의 latency 튜닝 / auto-update 비활성 env 가 명확해지면 여기로.
    return {};
  },

  desktopWatcher(): DesktopAgentWatcher {
    return codexDesktopWatcher;
  },

  // 토큰 잔량 — 최신 세션 rollout jsonl 의 token_count.rate_limits 스냅샷 (same-dir usage.ts).
  usage() {
    return codexUsage();
  },

  capabilities(): string[] {
    // 이어받기 지원. 별도 capability flag 는 필요해질 때 추가.
    // cron_eligible_v1: 예약 작업 픽커에 노출되는 «무인 실행에 적합한» 코드 에이전트 표식.
    return ["codex_resume_v1", "cron_eligible_v1"];
  },
};
