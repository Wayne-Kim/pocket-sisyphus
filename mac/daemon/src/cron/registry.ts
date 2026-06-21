/**
 * 예약 실행이 «소유 중인» 세션 id 집합.
 *
 * 예약 작업은 세션을 만들어 프롬프트를 한 번 보내고, 턴이 끝나면(12초 idle) executor 가
 * 직접 cron 전용 알림(cron_complete)을 보낸다. 그런데 그 idle 지점은 pty-runner 의
 * 일반 turn_complete 알림도 함께 발사하는 곳이라, 가만 두면 한 번의 완료에 알림이 두 번
 * 나간다. 이를 막기 위해 executor 가 실행 중인 세션을 여기 등록해 두고, notify/index 의
 * dispatchNotification 이 「예약 실행 중인 세션」 의 일반 알림은 건너뛴다.
 *
 * 실행이 끝나면 unmark 한다 — 그래서 사용자가 나중에 그 세션을 직접 열어 대화를 이어가면
 * 평소처럼 turn_complete 알림을 다시 받는다 (영구 음소거가 아님).
 *
 * 이 모듈은 notify / pty-runner / db 어느 것도 import 하지 않는다 (순환 의존 차단) —
 * 순수 in-memory Set 한 개.
 */
const activeCronSessions = new Set<string>();

export function markCronSession(sessionId: string): void {
  activeCronSessions.add(sessionId);
}

export function unmarkCronSession(sessionId: string): void {
  activeCronSessions.delete(sessionId);
}

/** dispatchNotification 이 일반 알림 억제 여부를 묻는다. */
export function isCronSessionActive(sessionId: string): boolean {
  return activeCronSessions.has(sessionId);
}
