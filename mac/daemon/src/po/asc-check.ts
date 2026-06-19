// PO 루프 — 수집 «App Store 신호»(리뷰 + 크래시) 가용성 점검 (po_asc_check_v1).
//
// 배경: 수집은 ASC 고객 리뷰(po_asc_v1)·크래시(po_crash_v1)를 신호원으로 쓰는데, 둘 다
// «데이터 없음/실패 시 섹션을 조용히 생략»(executor.ts prepareStoreReviews/prepareCrashSignals)
// 한다. 그래서 ASC 키가 «저장 후» 만료·폐기됐거나(설정 시점엔 멀쩡했어도) 인증이 깨지면
// 리뷰·크래시 신호가 0이 되는데 사용자는 모른 채 «제안 품질이 왜 낮은지» 만 느낀다 — gh.ts 가
// GitHub 신호에 대해 막은 silent-degradation 을 ASC 계열에도 똑같이 막는다. 이 모듈은 수집
// 직전 ASC 키 인증 가능성을 점검해 결과 메타로 iOS 에 전달한다.
//
// 리뷰와 크래시는 «같은 ASC 키 + 같은 게이트(asc_app_id)» 를 공유하므로 한 번의 점검으로
// 둘 다 커버한다 (키가 만료면 리뷰·크래시가 함께 0). 크래시의 «첫 활성화 직후 Apple 보고서
// 생성 대기(1~2일)» 같은 정상 빈-상태는 점검 대상이 아니다 — 그건 degradation 이 아니라
// 기대된 빈-상태이고, 점검은 «신호가 0인 원인이 키/인증 실패인가» 만 본다.
//
// 불확실할 땐 조용히 (gh.ts 와 같은 철학): 네트워크 장애·타임아웃·Apple 측 5xx 는 «점검 자체의
// 실패» 로 보아 null 을 돌려 iOS 가 거짓 경고를 안 띄우게 한다 (일시 네트워크 blip 으로 «키
// 만료» 라고 오인하지 않는다). 401/403(만료·폐기·권한)만 «확정 음성» 으로 reachable:false.

import { makeAscJwt } from "./asc.js";
import type { AscConfig } from "../config.js";
import { guardNonLanEgress } from "../egress.js";

const ASC_BASE = "https://api.appstoreconnect.apple.com";

/**
 * 수집의 App Store 신호 가용성 점검 결과. iOS 는 이 셋을 보고 안내를 띄울지 결정한다:
 * `enabled && (!keyConfigured || !reachable)` 일 때만 (정상/꺼짐이면 아무 UI 도 안 뜬다).
 */
export type AscCollectCheck = {
  /** 이 레포가 ASC 신호를 켰는가 — `po_profiles.asc_app_id` 설정 여부. false 면 점검 무의미. */
  enabled: boolean;
  /** config.json(0600) 에 ASC API 키가 저장돼 있는가. 미설정이면 reachable 은 무의미한 false. */
  keyConfigured: boolean;
  /**
   * 저장된 키로 ASC 에 실제 인증되는가 — 만료·폐기·권한 부족(401/403)이면 false.
   * 키 미설정/점검 불확실이면 무의미 (불확실은 애초에 null 반환이라 여기로 안 온다).
   */
  reachable: boolean;
};

/** 키 인증 프로브 한 건의 판정 — gh.ts 의 ProbeVerdict 와 동형. */
type ProbeVerdict = "ok" | "fail" | "uncertain";

/**
 * ASC 키 인증 프로브 — `/v1/apps` 한 건을 읽어 JWT 가 실제로 통하는지만 본다.
 * - 200 → "ok" (키 유효)
 * - 401/403 → "fail" (만료·폐기·권한 부족 — 확정 음성)
 * - 그 외 HTTP(5xx 등)·네트워크·타임아웃 → "uncertain" (점검 자체 실패 — 거짓 경고 방지로 조용히)
 *
 * 특정 앱(asc_app_id)의 리뷰 접근까지는 보지 않는다 — 키 인증 실패가 리뷰·크래시 0의
 * «공유된» 원인이고(브리프의 핵심 우려), 앱 ID 오타는 Mac 설정의 «검증» 이 따로 잡는다.
 */
async function probeAscAuth(asc: AscConfig): Promise<ProbeVerdict> {
  // LAN 전용 모드 — ASC 프로브도 비-LAN outbound 라 skip. «불확실(uncertain)» 로 처리해
  // checkAscForCollect 가 null 을 돌려 거짓 «키 만료» 경고를 띄우지 않게 한다(모드와 충돌은
  // 키 문제가 아니다).
  if (guardNonLanEgress("ASC auth probe")) {
    return "uncertain";
  }
  let token: string;
  try {
    token = makeAscJwt(asc);
  } catch {
    // 키 PEM 자체가 깨짐 — 저장 시 validateAscKey 를 통과했어도 방어. 확정 음성.
    return "fail";
  }
  let res: Response;
  try {
    res = await fetch(`${ASC_BASE}/v1/apps?limit=1&fields[apps]=name`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // 네트워크 장애·타임아웃 — 점검 자체 실패. 일시 blip 을 «키 만료» 로 오인하지 않는다.
    return "uncertain";
  }
  if (res.ok) return "ok";
  // 401/403 = 키 만료·폐기·권한 부족 (확정). 5xx 등은 Apple 쪽 일시 문제 → 불확실.
  if (res.status === 401 || res.status === 403) return "fail";
  return "uncertain";
}

/**
 * 수집 직전 App Store 신호(리뷰+크래시) 가용성을 점검한다. 절대 throw 하지 않는다.
 * - null 반환 = 점검 자체가 불확실(네트워크/타임아웃/5xx) → iOS 는 아무 안내도 안 띄운다.
 * - 객체 반환 = 점검 완료. iOS 가 `enabled && (!keyConfigured || !reachable)` 로 안내 여부 판단.
 *
 * ASC 신호가 꺼져 있으면(asc_app_id 없음) 키 프로브를 생략한다 (신호가 무의미 — 안내도 무의미).
 * 키가 없으면 즉시 «키 미설정» 확정 음성 (네트워크 호출 없음).
 */
export async function checkAscForCollect(
  ascAppId: string | null | undefined,
  asc: AscConfig | undefined,
): Promise<AscCollectCheck | null> {
  // 1) ASC 신호가 켜져 있나 — 아니면 키 유무와 무관하게 리뷰·크래시 신호가 의미 없다.
  if (!ascAppId || !ascAppId.trim()) {
    return { enabled: false, keyConfigured: false, reachable: false };
  }
  // 2) 키가 저장돼 있나 — 없으면 네트워크 호출 없이 «키 미설정» 확정 음성.
  if (!asc) {
    return { enabled: true, keyConfigured: false, reachable: false };
  }
  // 3) 키로 실제 인증되나 — 만료·폐기·권한은 확정 음성, 네트워크 불확실은 조용히 null.
  const verdict = await probeAscAuth(asc);
  if (verdict === "uncertain") return null; // 불확실 — 조용히
  return { enabled: true, keyConfigured: true, reachable: verdict === "ok" };
}
