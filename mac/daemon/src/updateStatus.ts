/**
 * Mac 앱의 «사일런트(무클릭) 업데이트» 경로가 끝난 결과를 담는 인메모리 스토어.
 *
 * 흐름:
 *   iOS [Mac 앱 업데이트] → daemon SIGUSR1 → Mac 앱이 사일런트로 설치 시도
 *     - 새 버전 설치 성공 → Mac 앱 relaunch → daemon 도 함께 재시작
 *       → 이 스토어는 초기화되지만, 새 daemon 의 DAEMON_VERSION ↑ 자체가 «완료» 신호라
 *         iOS 가 /api/version 으로 그걸 읽어 «업데이트 완료» 로 해석한다.
 *     - 새 버전 없음 / 에러 → 프로세스 생존 → Mac 앱이 POST /api/admin/update-status
 *       로 결과를 여기 적고, /api/version 응답의 `lastUpdate` 로 노출 → iOS 가
 *       «이미 최신 / 실패» 를 사용자에게 보여준다.
 *
 * 그래서 여기 담기는 state 는 프로세스가 살아남는 두 경우뿐이다: "no_update" | "error".
 * "installing"/"installed" 는 relaunch 로 사라지므로 굳이 저장하지 않는다.
 */

export type UpdateStatusState = "no_update" | "error";

export type UpdateStatus = {
  state: UpdateStatusState;
  /** 에러 메시지 (state === "error" 일 때). 사람이 읽을 수 있는 한 줄. */
  message?: string;
  /** 보고 시각 (epoch ms). iOS 가 트리거 이후의 결과인지 판별하는 데 쓴다. */
  at: number;
};

let current: UpdateStatus | null = null;

export function setUpdateStatus(status: UpdateStatus): void {
  current = status;
}

export function getUpdateStatus(): UpdateStatus | null {
  return current;
}

/**
 * 새 업데이트 트리거가 들어올 때 호출 — 직전 시도의 잔존 결과를 지운다. 이후 나타나는
 * `lastUpdate` 는 «이번 트리거» 결과임이 보장되므로, 클라이언트가 폰/Mac 간 시계 차이에
 * 의존한 타임스탬프 비교 없이 안전하게 결과를 판정할 수 있다.
 */
export function clearUpdateStatus(): void {
  current = null;
}
