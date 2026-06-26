// `GET /endpoint` — iOS 가 Tor onion 으로 접근해서 받아가는 SSH endpoint 배열.
//
// 응답 구조는 happy eyeballs 친화 — priority 순으로 병렬 시도하고 첫 성공 채택.
// `tor_onion` 은 항상 마지막 fallback 으로 포함. 직접 채널 (IPv6/IPv4) 은 환경에 따라
// 동적으로 포함/제외.
//
// 이 라우트는 daemon 의 endpoint-only HTTP listener (별도 포트, Tor 만 노출) 에서 serving.
// 메인 daemon listener (`/api/*`, 127.0.0.1:7777) 와 분리해서 Tor 와 SSH 채널 별 권한 경계를
// 명확히 한다.

import { Hono } from "hono";
import { bearerAuth } from "../auth.js";
import {
  getExternalIPv4,
  getGlobalIPv6,
  getCachedExternalIPv4,
} from "../nat/external-ip.js";
import { getLanHosts } from "../nat/lan-addr.js";

export type EndpointEntry = {
  type: "direct_lan" | "direct_ipv6" | "direct_ipv4" | "tor_onion";
  host: string;
  port: number;
  priority: number;
};

export type EndpointResponse = {
  v: 1;
  endpoints: EndpointEntry[];
  ssh_host_key_fingerprint: string;
  ssh_user: string;
  daemon_local_port: number;
  issued_at: string;
  ip_fetched_at: string | null;
  ttl_sec: number;
};

export type EndpointDeps = {
  /** Tor hidden service 의 onion 주소 (`<fp>.onion`). 부팅 후 set. */
  getOnionAddress: () => string | null;
  /** sshd host key fingerprint (`SHA256:...`). ensureHostKey() 결과. */
  getSshHostKeyFingerprint: () => string;
  /** sshd 가 listen 중인 SSH 포트 (직접 + Tor onion 둘 다 같은 포트로 forward). */
  getSshPort: () => number;
  /** SSH user 이름. 임베디드 sshd 가 받아들이는 사용자명. */
  getSshUser: () => string;
  /** daemon 의 HTTP/WS 메인 listener 포트 — SSH local forward 가 도달할 목적지. */
  getDaemonLocalPort: () => number;
  /** UPnP/PMP 로 IPv4 외부 매핑이 성공했는지. true 면 direct_ipv4 entry 포함. */
  isIPv4Mapped: () => boolean;
  /**
   * LAN 전용(사설망 직결) 모드 여부. true 면 endpoint 응답에서 공인 IPv4/IPv6·onion 을
   * «제거» 하고 direct_lan 만 남긴다 — 서버측 fail-closed 강화(폰의 LAN 전용 정책과 짝).
   * 미설정/false 면 기존 듀얼 채널(공인 + onion 폴백) 그대로.
   */
  isLanOnly?: () => boolean;
};

/** endpoint TTL — 5분. iOS 의 EndpointCache 와 동일. 갱신 트리거는 연결 실패. */
const ENDPOINT_TTL_SEC = 5 * 60;

export function endpointRoute(deps: EndpointDeps) {
  const app = new Hono();

  // 2차 방어선(BL-04): onion client-auth(x25519)가 Tor 계층에서 «QR 보유자»로 1차 게이트하지만,
  // 페어링 페이로드의 endpointToken(= daemon token)을 bearer 로도 검증한다. 클라이언트(iOS
  // ConnectionManager·Android EndpointResolver)는 이미 `Authorization: Bearer <endpointToken>` 을
  // 보내므로 호환 깨짐 없음 — 토큰 없이/틀린 토큰이면 401 로 사용자명·공인 IP·호스트키 지문 노출을 막는다.
  app.use("*", bearerAuth);

  app.get("/endpoint", async (c) => {
    const onion = deps.getOnionAddress();
    if (!onion) {
      // Tor 부팅 중. iOS 가 이 라우트를 호출했다는 건 Tor 회로는 이미 빌드된 상태라
      // 거의 일어나지 않지만, 부팅 직후 race 안전망.
      return c.json({ error: "tor_not_ready" }, 503);
    }

    const sshPort = deps.getSshPort();
    const lanOnly = deps.isLanOnly?.() === true;
    const endpoints: EndpointEntry[] = [];

    // direct_lan: 사설/링크로컬 주소 + mDNS hostname. priority 0 = 최우선.
    // 같은 LAN 일 때만 도달 — 패킷이 사설망을 벗어나지 않는다. LAN 전용 모드의 유일한 채널.
    for (const lan of getLanHosts()) {
      endpoints.push({
        type: "direct_lan",
        host: lan.host,
        port: sshPort,
        // mDNS hostname(rank 0) → 사설 IPv4(rank 1) → unique-local IPv6(rank 2) 순.
        priority: lan.rank,
      });
    }

    // LAN 전용 모드: 여기서 «끝». 공인 IPv4/IPv6·onion 을 후보에서 통째로 제거한다
    // (단순 비선호가 아니라 서버도 외부 경로를 광고하지 않음 — 폰 정책과 이중 fail-closed).
    if (lanOnly) {
      const ipCache = getCachedExternalIPv4();
      const resp: EndpointResponse = {
        v: 1,
        endpoints,
        ssh_host_key_fingerprint: deps.getSshHostKeyFingerprint(),
        ssh_user: deps.getSshUser(),
        daemon_local_port: deps.getDaemonLocalPort(),
        issued_at: new Date().toISOString(),
        ip_fetched_at: ipCache ? new Date(ipCache.fetchedAt).toISOString() : null,
        ttl_sec: ENDPOINT_TTL_SEC,
      };
      return c.json(resp);
    }

    // IPv6: NAT 가 없어서 라우터 매핑 불필요. 글로벌 주소만 있으면 포함.
    // 사용자 라우터의 IPv6 firewall 이 차단해도 happy eyeballs 가 알아서 다음 후보로.
    const ipv6 = getGlobalIPv6();
    if (ipv6) {
      endpoints.push({
        type: "direct_ipv6",
        host: ipv6,
        port: sshPort,
        priority: 1,
      });
    }

    // IPv4: UPnP/PMP 로 외부 매핑이 성공해야 의미 있음. 아니면 라우터에서 drop 됨.
    // mapping 결과 + echo 로 받은 외부 IP 가 일치할 때만 포함.
    if (deps.isIPv4Mapped()) {
      const ipv4 = await getExternalIPv4();
      if (ipv4) {
        endpoints.push({
          type: "direct_ipv4",
          host: ipv4,
          port: sshPort,
          priority: 2,
        });
      }
    }

    // Tor onion: 항상 마지막 fallback. 모든 환경에서 동작 — 라우터 설정 무관.
    // onion 위 SSH 는 sshd 가 같은 22022 포트로 listen, Tor torrc 가
    // `HiddenServicePort 22 127.0.0.1:22022` 로 매핑.
    endpoints.push({
      type: "tor_onion",
      host: onion,
      port: 22,
      priority: 99,
    });

    const ipCache = getCachedExternalIPv4();
    const resp: EndpointResponse = {
      v: 1,
      endpoints,
      ssh_host_key_fingerprint: deps.getSshHostKeyFingerprint(),
      ssh_user: deps.getSshUser(),
      daemon_local_port: deps.getDaemonLocalPort(),
      issued_at: new Date().toISOString(),
      ip_fetched_at: ipCache ? new Date(ipCache.fetchedAt).toISOString() : null,
      ttl_sec: ENDPOINT_TTL_SEC,
    };
    return c.json(resp);
  });

  return app;
}
