/**
 * Adapter registration entry — daemon 부팅 시 한 번 import 되어 registry 에 모든 adapter
 * 를 등록한다. 새 adapter 추가 시 import + registerAgent 한 줄 추가.
 */
import { registerAgent, hasAgent } from "./registry.js";
import { claudeCodeAdapter } from "./adapters/claude-code/index.js";
import { agyAdapter } from "./adapters/agy/index.js";
import { codexAdapter } from "./adapters/codex/index.js";
import { shellAdapter } from "./adapters/shell/index.js";
import { localLlmAdapter } from "./adapters/local-llm/index.js";
import { opencodeAdapter } from "./adapters/opencode/index.js";
import { copilotAdapter } from "./adapters/copilot/index.js";

/**
 * idempotent. server.ts start() 가 첫 부팅 + 테스트 setup 양쪽에서 호출 가능하도록.
 * idempotency 는 registry 의 상태로 판단 — `_resetRegistryForTest()` 가 호출되면
 * 이 함수도 다시 등록한다 (별도 플래그를 두면 reset 과 동기화가 깨짐).
 */
export function registerBuiltinAgents(): void {
  if (hasAgent("claude_code")) return;
  registerAgent(claudeCodeAdapter);
  registerAgent(agyAdapter);
  registerAgent(codexAdapter);
  registerAgent(copilotAdapter);
  registerAgent(shellAdapter);
  registerAgent(localLlmAdapter);
  registerAgent(opencodeAdapter);
}
