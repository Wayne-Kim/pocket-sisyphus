/**
 * agent 토큰 잔량 조회의 공용 wrapper — adapter.usage() 호출을 60s 캐시로 감싸고,
 * 라우트가 그대로 c.json() 할 수 있는 응답 shape 으로 변환한다.
 *
 * 응답 계약 (iOS AgentUsageResponse 와 1:1):
 *   - supported:false                → 이 agent 는 잔량 개념 없음/조회 불가 (shell, agy).
 *                                      iOS 는 메뉴에서 관련 UI 를 통째로 숨긴다.
 *   - supported:true  + windows[]    → 정상. 윈도우별 사용률/리셋 시각.
 *   - supported:true  + error        → 지원 agent 의 일시 실패 (키체인/네트워크 등).
 *                                      iOS 는 «잔량 조회 불가» 한 줄로 표시.
 *
 * 캐시는 agent 단위 (계정 단위 데이터라 세션과 무관). 실패 결과는 캐시하지 않아
 * 다음 메뉴 열기가 곧장 재시도가 된다.
 */
import type { AgentAdapter, AgentUsageReport } from "./types.js";

export type AgentUsageResponse = {
  supported: boolean;
  windows: AgentUsageReport["windows"];
  fetchedAt?: number;
  error?: string;
};

const CACHE_TTL_MS = 60_000;

const cache = new Map<string, { report: AgentUsageReport; at: number }>();

/** 테스트 전용 — 캐시 비우기. */
export function _clearUsageCacheForTest(): void {
  cache.clear();
}

export async function getAgentUsage(adapter: AgentAdapter): Promise<AgentUsageResponse> {
  if (!adapter.usage) {
    return { supported: false, windows: [] };
  }
  const hit = cache.get(adapter.id);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return { supported: true, ...hit.report };
  }
  try {
    const report = await adapter.usage();
    cache.set(adapter.id, { report, at: Date.now() });
    return { supported: true, ...report };
  } catch (e) {
    return { supported: true, windows: [], error: (e as Error).message };
  }
}
