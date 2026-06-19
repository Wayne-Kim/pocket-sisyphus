/**
 * AgentAdapter registry — id → adapter 의 단일 source of truth.
 *
 * 등록은 src/agent/index.ts 의 module init 시점에 1회. 라우트 / PTY runner 는
 * `getAgent(id)` 로만 adapter 를 얻는다 — 직접 import 금지.
 *
 * 등록 안 된 id 로 getAgent() 를 부르면 throw 한다 — 「알 수 없는 agent」 가 사용자에게
 * 도달하기 전에 실패하도록.
 */
import type { AgentAdapter } from "./types.js";

const adapters = new Map<string, AgentAdapter>();

export function registerAgent(adapter: AgentAdapter): void {
  if (adapters.has(adapter.id)) {
    throw new Error(`agent already registered: ${adapter.id}`);
  }
  adapters.set(adapter.id, adapter);
}

/**
 * id 로 adapter 를 가져온다. 없으면 throw — 호출자가 사용자 입력을 받기 전에 valid 한 id
 * 인지 검증해 두는 게 안전 (예: routes/sessions 의 POST body 검증).
 */
export function getAgent(id: string): AgentAdapter {
  const a = adapters.get(id);
  if (!a) throw new Error(`unknown agent: ${id}`);
  return a;
}

/** 등록된 모든 adapter — /api/agents 응답이나 부팅 self-check 에 쓴다. */
export function listAgents(): AgentAdapter[] {
  return Array.from(adapters.values());
}

/** id 가 등록돼 있는지 — POST 라우트의 200/400 분기용. */
export function hasAgent(id: string): boolean {
  return adapters.has(id);
}

/**
 * 테스트 / hot-reload 용 — adapter 들을 모두 비운다. 운영 코드에서는 호출하지 말 것.
 * (현재는 export 만 해두고 호출처 0 — 후속 unit test 에서 사용)
 */
export function _resetRegistryForTest(): void {
  adapters.clear();
}
