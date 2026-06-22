// PO 수집 — «App Store 신호원»(스토어 리뷰 + 크래시) 의 «실행 시점» 건강 상태 (po_signal_status_v1).
//
// 배경: asc-check.ts(po_asc_check_v1)는 수집 «직전» 키 인증을 한 번 프로브해 off/키미설정/키권한
// 만 본다. 하지만 진짜 fetch 는 그 «후» 에 일어나고(executor prepareStoreReviews/prepareCrashSignals),
// 그 시점 실패(키 만료·권한·app id 오류·네트워크)는 console.warn 으로만 남고 섹션이 조용히
// 생략된다 — 사용자는 신호가 반영된 줄 착각한다. 이 모듈은 그 «1회 수집 실행» 결과를 신호원별로
// 구조화해, 완료 알림 + 백로그 수집 결과 카드로 사용자에게 보이게 한다 (gh 가 GitHub 신호에
// 대해 막은 silent-degradation 을 ASC 계열의 «실행 시점» 에도 똑같이 막는다).
//
// 상태 taxonomy (스토어·크래시 각각 독립 — 한쪽만 실패할 수 있다):
//   used(N)      신호 N건 실제 반영됨.
//   off          asc_app_id 미설정 = 신호 안 켬 → 카드 자체가 침묵 (잡음 금지).
//   empty        켰고 키 정상인데 데이터 0 — 정상 빈-상태 (crash 첫 활성화 직후 Apple 보고서
//                생성 대기 등). degradation 이 아니라 기대된 빈-상태라 «경고» 아닌 중립으로 표기.
//   key_missing  ASC 키 미설정 = «꺼짐/설정 필요» (에러 아닌 안내).
//   auth         401/403 — 키 만료·폐기·권한 부족.
//   app_id       404/앱 없음/번들 ID 못 찾음 — app id 설정 오류.
//   network      타임아웃·5xx·LAN 전용 모드 차단·네트워크 — 점검/호출 자체 실패.

/** 한 신호원(스토어 또는 크래시)의 «1회 수집» 실행 결과. */
export type SignalSourceState =
  | { state: "used"; count: number }
  | { state: "off" }
  | { state: "empty" }
  | { state: "key_missing" }
  | { state: "auth" }
  | { state: "app_id" }
  | { state: "network" };

/** 한 번의 수집에서 두 ASC 신호원의 실행 결과. */
export type CollectSignals = {
  store: SignalSourceState;
  crash: SignalSourceState;
};

/** 실패 상태 4종 — «실패» 로 묶어 표시할지 판정용. */
const FAILURE_STATES: ReadonlySet<SignalSourceState["state"]> = new Set([
  "key_missing",
  "auth",
  "app_id",
  "network",
]);

/** 이 상태가 사용자에게 «실패(설정 필요)» 로 보여야 하는가 — warning 톤. off/empty/used 는 아님. */
export function isSignalFailure(s: SignalSourceState): boolean {
  return FAILURE_STATES.has(s.state);
}

/**
 * ASC fetch 가 throw 한 에러를 실패 종류로 분류한다 (순수 — 네트워크 호출 없음).
 * asc.ts ascGet/ascPost 는 throw 에 `.status`(HTTP 코드)를 부착하므로 그것을 1차로 보고,
 * 없으면(앱 없음/번들 못 찾음/LAN 차단/타임아웃 등 비-HTTP 경로) 메시지로 폴백한다.
 * 불확실(타임아웃/5xx/LAN)은 «network» 로 모은다 — 일시 blip 을 «키 만료» 로 오인하지 않는다.
 */
export function classifyAscFailure(e: unknown): "auth" | "app_id" | "network" {
  const status =
    typeof (e as { status?: unknown })?.status === "number"
      ? (e as { status: number }).status
      : undefined;
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "app_id";
  const msg = e instanceof Error ? e.message : String(e ?? "");
  // resolveAscAppId 의 «앱 없음»/«번들 ID 로 앱을 찾지 못함» 은 200 응답에 데이터가 빈 경우라
  // status 가 없다 — 메시지로 app_id 오류로 분류.
  if (/앱 없음|찾지 못함|\bASC 404\b/.test(msg)) return "app_id";
  if (/\bASC (401|403)\b/.test(msg)) return "auth";
  // 5xx·LAN 전용 모드 차단·타임아웃·기타 네트워크 — 점검/호출 자체 실패.
  return "network";
}

/** persist/전송용 JSON 직렬화 (좁은 화이트리스트 — 임의 필드 유입 차단). */
export function serializeSignals(sig: CollectSignals): string {
  return JSON.stringify(sig);
}

/** 저장된 JSON → CollectSignals. 깨졌거나 옛 형식이면 null (호출처가 카드 숨김). */
export function parseSignals(json: string | null | undefined): CollectSignals | null {
  if (!json) return null;
  try {
    const o = JSON.parse(json) as Partial<CollectSignals>;
    if (o && isState(o.store) && isState(o.crash)) {
      return { store: o.store, crash: o.crash };
    }
  } catch {
    /* 깨진 JSON → null */
  }
  return null;
}

// ─── 예약(scheduled) 수집의 «결말» (po_scheduled_status_v1) ──────────────────────
//
// 무인 사용자가 «오늘은 제안이 없네» 와 «수집이 깨졌네» 를 혼동하지 않게, 예약 수집의 끝을
// 세 결말로 가른다. 신호원 상태(CollectSignals)와 별개 축 — 신호는 «무엇을 봤나», 결말은
// «그래서 무엇이 나왔나» 다.
//   new   — 새 제안 N(≥1)건이 인입됨 (결재 대상 — 항상 알린다).
//   empty — 정상 종료했으나 제안 0건 («이번엔 없음» — 실패와 시각적으로 구분).
//   failed— 시작 실패(스케줄러 tick) 또는 인입 파이프 에러/타임아웃.
export type ScheduledOutcomeKind = "new" | "empty" | "failed";

/** settle 상태 + 인입 건수 → 결말. 순수 — db/네트워크 없음. */
export function classifyScheduledOutcome(
  status: "ok" | "error" | "timeout",
  briefCount: number,
): ScheduledOutcomeKind {
  if (status !== "ok") return "failed";
  return briefCount > 0 ? "new" : "empty";
}

/** failed 사유 비교를 위한 정규화 — trim + 길이 cap (같은 실패의 미세 변형을 같게 본다). */
function normalizeScheduledError(e: string | null | undefined): string {
  return (e ?? "").trim().slice(0, 200);
}

/**
 * 이 결말을 알림으로 «보낼지» 결정 (알림 폭주 방지 — po 브리프 엣지케이스).
 * persist 는 호출처가 «항상» 한다(앱 내 카드는 억제와 무관). 이 함수는 «알림» 만 가린다.
 *   new   → 항상 (새 결재 대상이라 묶지 않는다).
 *   첫 결말(prev 없음) → 항상.
 *   empty → 직전이 empty 면 억제 («여전히 빈손» 을 매일 반복 통지하지 않는다).
 *   failed→ 직전도 failed 고 사유가 같으면 억제 (매일 같은 실패 폭주 방지). 사유가 바뀌면 다시 알린다.
 */
export function shouldNotifyScheduledOutcome(
  prev: { outcome: ScheduledOutcomeKind; error?: string | null } | null,
  next: { outcome: ScheduledOutcomeKind; error?: string | null },
): boolean {
  if (next.outcome === "new") return true;
  if (!prev) return true;
  if (next.outcome === "empty") return prev.outcome !== "empty";
  // next.outcome === "failed"
  if (prev.outcome !== "failed") return true;
  return normalizeScheduledError(prev.error) !== normalizeScheduledError(next.error);
}

function isState(v: unknown): v is SignalSourceState {
  if (!v || typeof v !== "object") return false;
  const s = (v as { state?: unknown }).state;
  return (
    s === "used" ||
    s === "off" ||
    s === "empty" ||
    s === "key_missing" ||
    s === "auth" ||
    s === "app_id" ||
    s === "network"
  );
}
