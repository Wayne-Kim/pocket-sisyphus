/**
 * croner 래퍼 — cron 식 검증 + 다음 실행 계산. cron 스케줄링의 «날짜 수학» 을 한 곳에 모은다
 * (타임존/DST 정확성은 croner 가 책임). iOS 는 프리셋으로 5필드 식을 만들고, 미리보기
 * (POST /api/cron/preview) 는 여기서 계산한 다음 실행 timestamp 를 그대로 받아 사용자 로케일로
 * 포맷한다 — daemon 측 i18n 불필요.
 */
import { Cron } from "croner";

/** job.timezone 이 NULL 일 때 쓰는 Mac 로컬 타임존 (IANA). */
export function localTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/**
 * cron 식 + 타임존 검증. croner 는 잘못된 패턴/타임존에 throw 하므로 try/catch 로 흡수한다.
 * 사람이 읽을 사유 문자열을 함께 반환 — iOS 에디터가 라이브로 빨간 안내에 띄운다.
 */
export function validateSchedule(
  schedule: string,
  timezone?: string | null,
): { valid: true } | { valid: false; error: string } {
  const expr = (schedule ?? "").trim();
  if (!expr) return { valid: false, error: "cron 식이 비어 있어요." };
  try {
    // paused 로 만들어 콜백 없이 패턴만 파싱시킨다.
    const c = new Cron(expr, { timezone: timezone || localTimezone(), paused: true });
    // 다음 실행이 영영 없는 식 (과거 고정 등) 도 막는다.
    if (!c.nextRun()) {
      c.stop();
      return { valid: false, error: "이 식은 앞으로 실행될 시점이 없어요." };
    }
    c.stop();
    return { valid: true };
  } catch (e) {
    return { valid: false, error: (e as Error).message };
  }
}

/**
 * 다음 N 회 실행 시각 (epoch ms). 잘못된 식이면 빈 배열.
 * 미리보기 + next_run_at 캐시 갱신에 쓴다.
 */
export function nextRuns(
  schedule: string,
  timezone: string | null | undefined,
  count: number,
): number[] {
  try {
    const c = new Cron((schedule ?? "").trim(), {
      timezone: timezone || localTimezone(),
      paused: true,
    });
    const runs = c.nextRuns(Math.max(1, Math.min(20, count)));
    c.stop();
    return runs.map((d) => d.getTime());
  } catch {
    return [];
  }
}

/** 다음 1회 실행 시각 (epoch ms) 또는 null. */
export function nextRun(schedule: string, timezone?: string | null): number | null {
  const [first] = nextRuns(schedule, timezone, 1);
  return first ?? null;
}
