// Egress confinement — «LAN 전용 모드» 단일 게이트.
//
// 배경: 폰↔Mac 데이터 plane 을 LAN 직결로 쓰더라도 daemon 은 별개로 공인 IP echo(ipify 등)·
// UPnP/NAT-PMP 매핑·App Store Connect 로 «회사 밖» outbound 를 낸다. 사내 보안팀 관점의
// «패킷이 회사 밖으로 안 나간다» 보증은 이 outbound 들이 남아 있으면 절반만 참이다.
//
// LAN 전용 모드(`config.lanOnly === true`)가 켜지면 daemon 의 «비-LAN» outbound 를 기본 deny
// 로 게이트한다. 누락(한 경로만 깜빡)이 곧 유출이므로, 모든 outbound 경로가 «이 한 곳»을
// 거치게 한다 — 새 outbound 를 추가하는 사람은 `guardNonLanEgress()` 한 줄만 잊지 않으면 된다.
//
// 무엇이 «비-LAN outbound» 인가: 공개 인터넷(또는 Tor relay)으로 나가는 호출. 게이트 대상:
//  - external-ip echo (nat/external-ip.ts)
//  - UPnP / NAT-PMP 포트 매핑 (nat/port-mapping.ts)
//  - App Store Connect (po/asc.ts·po/crash.ts·po/asc-check.ts)
//  - Discord webhook 알림 (notify/discord.ts)
//
// 게이트 «대상이 아닌» 것: 폰↔Mac LAN 직결(127.0.0.1/sshd/endpoint) 같은 사적 데이터 plane,
// 그리고 우리가 통제하지 못하는 OS 레벨 트래픽(DNS 해석·ARP·NTP 등) — 잔여 위험으로 수용한다
// (docs/THREAT_MODEL.md §5.11).

import { readConfig } from "./config.js";

/**
 * 테스트/런타임용 명시 오버라이드. `null` 이면 config(`lanOnly`)를 읽고, true/false 면 그 값을
 * config 보다 우선한다. 계약 테스트가 파일 I/O 없이 모드를 토글할 수 있게 한다.
 */
let modeOverride: boolean | null = null;

/** 모드 오버라이드 설정. `null` 로 되돌리면 다시 config 를 본다(테스트 cleanup). */
export function setLanOnlyModeOverride(value: boolean | null): void {
  modeOverride = value;
}

/**
 * LAN 전용 모드가 활성인가. 오버라이드가 있으면 그 값, 없으면 `config.json` 의 `lanOnly`.
 * 호출 빈도가 낮은 outbound 경로에서만 부르므로 매번 config 를 읽어 «런타임 토글 즉시 반영»을
 * 보장한다(stale 캐시로 모드 OFF 인데 차단되는 회귀 방지).
 */
export function isLanOnlyMode(): boolean {
  if (modeOverride !== null) return modeOverride;
  return readConfig()?.lanOnly === true;
}

/**
 * 비-LAN outbound 를 시도하기 «직전» 에 부르는 단일 게이트.
 *
 * @param channel 진단 로그용 채널 이름 (예: "external-ip echo", "ASC GET").
 * @returns 차단됐으면 `true`(=호출자는 outbound 를 skip) — 모드 OFF 면 `false`(평소대로 진행).
 *
 * 모드 OFF 시 부작용 0(로그조차 없음) — 기존 동작 회귀 0 을 보장한다.
 */
export function guardNonLanEgress(channel: string): boolean {
  if (!isLanOnlyMode()) return false;
  console.warn(`[egress] LAN 전용 모드 활성 — 비-LAN outbound '${channel}' 차단(deny)`);
  return true;
}
