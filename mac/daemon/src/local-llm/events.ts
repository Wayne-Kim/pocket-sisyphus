/**
 * 로컬 LLM 상태 변경 이벤트 버스 — download/supervisor(상태 소유자) → status(브로드캐스터)
 * 의 단방향 통지. status 가 download/supervisor 를 import 하는데, 역방향 import 를 두면
 * 순환이 되므로 이 leaf 모듈로 디커플.
 */
type Listener = () => void;
const listeners = new Set<Listener>();

export function onLocalLlmChange(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function emitLocalLlmChange(): void {
  for (const l of listeners) {
    try {
      l();
    } catch {
      // listener 오류는 격리 — 통지가 상태 머신을 깨면 안 됨.
    }
  }
}
