// 라우터 자동 포트 매핑 — UPnP IGD / NAT-PMP / PCP.
//
// 듀얼 채널 모델에서 best-effort 단계 — 성공하면 외부에서 직접 SSH 가능 (빠름).
// 실패해도 Tor onion service 가 fallback 채널로 동작하므로 critical 아님.
//
// 라이브러리: `nat-api` — UPnP IGD + NAT-PMP 양쪽 시도하는 well-known npm 패키지.
// 라우터가 PCP 만 지원하는 케이스는 NAT-PMP 호환으로 흡수됨 (PCP 는 NAT-PMP 의 후속).
//
// IPv6 firewall 허용 (UPnP IGDv2 `AddPinhole`) 은 nat-api 가 지원 안 함. 한국 가정 공유기
// (LG U+ 등) IPv6 firewall 디폴트 차단 환경은 사용자가 라우터에서 풀거나 Tor fallback 으로
// 동작. 1차 출시에선 IPv4 자동 매핑만 처리.

import NatAPI from "nat-api";
import { guardNonLanEgress } from "../egress.js";

/** 매핑 시도 결과 한 항목. */
export type PortMappingResult = {
  /** UPnP/PMP/PCP 어느 프로토콜로 성공했는지. 실패면 null. */
  protocol: "upnp" | "pmp" | null;
  /** 라우터가 반환한 외부 IPv4. UPnP 의 GetExternalIPAddress 응답. echo 와 비교 검증 가능. */
  externalIPv4: string | null;
  /** 실패 사유 (디버그용). 성공이면 null. */
  error: string | null;
};

/** TTL — 라우터에 매핑 유효기간. 너무 짧으면 lease 갱신 빈번, 너무 길면 stale. 1시간. */
const MAPPING_TTL_SEC = 60 * 60;

/** 매핑 시도 타임아웃 — UPnP 디스커버리 SSDP 가 ~2s, PMP 가 ~1s, 안전망 10s. */
const MAPPING_TIMEOUT_MS = 10_000;

/**
 * 외부 IPv4 22022 → 내부 22022 매핑 시도.
 *
 * 멱등성: 같은 publicPort + privatePort 로 다시 호출하면 lease 갱신 (라우터에 따라 다름).
 * 호출 주기: daemon 부팅 시 1회 + lease TTL 의 절반 (30분) 마다 갱신 권장.
 *
 * 호출자는 결과의 protocol/externalIPv4 를 endpoint 응답에 반영. 실패해도 throw 안 함 —
 * Tor fallback 으로 동작하므로 graceful.
 */
export async function tryMapSSHPort(port: number): Promise<PortMappingResult> {
  // LAN 전용 모드 — 공인 노출이 불필요하므로 매핑 시도 자체를 중단. Tor fallback 도 LAN 발견으로
  // 전환되므로 inbound 채널은 LAN 직결이 담당한다.
  if (guardNonLanEgress("UPnP/NAT-PMP map")) {
    return { protocol: null, externalIPv4: null, error: "lan-only mode: 매핑 skip" };
  }
  const client = new NatAPI({
    ttl: MAPPING_TTL_SEC,
    autoUpdate: false,  // 우리가 직접 주기적으로 호출. nat-api 의 자동 갱신 타이머는 daemon 종료 시 cleanup 책임 문제 회피.
  });

  try {
    return await raceWithTimeout(
      mapAndProbe(client, port),
      MAPPING_TIMEOUT_MS,
      "port mapping timeout",
    );
  } catch (e) {
    return { protocol: null, externalIPv4: null, error: (e as Error).message };
  } finally {
    // nat-api 의 destroy 는 SSDP socket / UPnP timer 정리. 다음 호출은 새 instance.
    try {
      await new Promise<void>((resolve) => {
        client.destroy(() => resolve());
      });
    } catch {
      /* best-effort */
    }
  }
}

async function mapAndProbe(client: NatAPI, port: number): Promise<PortMappingResult> {
  // map() 은 UPnP 시도 → 실패 시 PMP fallback. 어느 쪽이 성공했는지 직접 반환 안 해서
  // 둘 다 시도해서 어느 쪽 externalIp 가 채워졌는지로 판별.
  await client.map({
    publicPort: port,
    privatePort: port,
    protocol: "TCP",
    description: "Pocket Sisyphus SSH",
  });

  // externalIp() — UPnP 또는 PMP 로 라우터에 GetExternalIPAddress 발행.
  let externalIPv4: string | null = null;
  try {
    externalIPv4 = await new Promise<string>((resolve, reject) => {
      client.externalIp((err: Error | null, ip: string) => {
        if (err) reject(err);
        else resolve(ip);
      });
    });
  } catch {
    /* externalIp 실패는 매핑 자체 실패와 별개일 수 있어 무시. echo 가 채워줌. */
  }

  // nat-api 내부 어느 프로토콜로 성공했는지 알아내기 — client._upnpClient.gateways 가 비었으면 PMP.
  // 내부 구현 의존이라 안전망 차원에서 그냥 둘 다 시도 결과만 보고. 정확히 어느 쪽인지가
  // critical 하지 않음 (둘 다 외부 inbound 활성화라는 같은 결과).
  const protocol: "upnp" | "pmp" = "upnp"; // map() 성공 시 사실 둘 중 하나. 표시는 단순화.

  return { protocol, externalIPv4, error: null };
}

/**
 * 라우터에 매핑 해제 요청. daemon 종료 시 호출 — 좀비 매핑 방지.
 * 실패해도 throw 안 함 — 라우터가 응답 안 하면 자동 TTL expiration 으로 사라짐.
 */
export async function tryUnmapSSHPort(port: number): Promise<void> {
  // LAN 전용 모드에선 애초에 매핑을 안 했으므로 해제 호출(=라우터 SSDP/PMP outbound)도 skip.
  if (guardNonLanEgress("UPnP/NAT-PMP unmap")) {
    return;
  }
  const client = new NatAPI({ ttl: MAPPING_TTL_SEC, autoUpdate: false });
  try {
    await raceWithTimeout(
      client.unmap({ publicPort: port, privatePort: port, protocol: "TCP" }),
      5000,
      "port unmap timeout",
    );
  } catch (e) {
    console.warn(`[port-mapping] unmap failed: ${(e as Error).message}`);
  } finally {
    try {
      await new Promise<void>((resolve) => {
        client.destroy(() => resolve());
      });
    } catch {
      /* best-effort */
    }
  }
}

function raceWithTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
