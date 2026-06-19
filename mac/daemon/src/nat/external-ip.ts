// 외부 IPv4 주소 조회 + 5분 메모리 캐시.
//
// Mac 이 NAT 뒤에 있을 때 자기 자신의 공인 IPv4 를 알 방법은 두 가지:
//  1. 라우터에게 UPnP `GetExternalIPAddress` 로 묻기 — port-mapping.ts 가 담당
//  2. 외부 echo 서비스에 묻기 — 이 모듈이 담당
//
// echo 서비스는 "메인테이너 운영 인프라" 가 아니라 무료 공개 endpoint 들.
// 통신 사실 자체는 어차피 ISP/라우터가 보고 있어서 익명성 추가 손실 없음.
// fallback 체인으로 어느 한 서비스 장애에 안 죽도록.
//
// IPv6 외부 주소는 NAT 가 없어 `getifaddrs()` 로 로컬 글로벌 주소 자체가 곧 외부 주소다.
// 이 모듈은 IPv4 만 다룬다.

import os from "node:os";
import { guardNonLanEgress } from "../egress.js";

/** 우선순위 순으로 시도할 IPv4 echo 엔드포인트. 응답 본문은 IP 주소 한 줄 plain text. */
const ECHO_ENDPOINTS = [
  "https://api.ipify.org",
  "https://ifconfig.me/ip",
  "https://icanhazip.com",
];

/** 캐시 TTL — 5분. 가정 인터넷의 IP 변경은 보통 일 단위라 충분. */
const CACHE_TTL_MS = 5 * 60 * 1000;

/** 단일 echo 요청 timeout — 너무 짧으면 모바일 hotspot 등 느린 환경에서 false fail. */
const FETCH_TIMEOUT_MS = 5000;

type CacheEntry = {
  ipv4: string;
  fetchedAt: number;
};

let cache: CacheEntry | null = null;
let inflightFetch: Promise<string | null> | null = null;

/**
 * 캐시된 외부 IPv4. 캐시가 신선하면 그대로 반환, 아니면 echo 호출.
 *
 * 모든 echo 가 실패하면:
 *  - 캐시가 있으면 stale 이라도 반환 (그게 마지막으로 알려진 IP)
 *  - 캐시도 없으면 null
 *
 * 동시 호출이 있으면 inflight promise 를 공유 — 같은 시점에 여러 caller (endpoint 라우트,
 * NetworkChangeMonitor IPC trigger) 가 호출해도 echo 는 한 번만.
 */
export async function getExternalIPv4(): Promise<string | null> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.ipv4;
  }
  // LAN 전용 모드 — echo 호출 skip. 캐시가 있으면 마지막 알려진 IP, 없으면 null(=none).
  if (guardNonLanEgress("external-ip echo")) {
    return cache?.ipv4 ?? null;
  }
  if (inflightFetch) {
    return inflightFetch;
  }
  inflightFetch = fetchFromEchoChain().finally(() => {
    inflightFetch = null;
  });
  return inflightFetch;
}

/** 캐시 강제 무효화 — NetworkChangeMonitor 가 path 변경 신호 보냈을 때. */
export function invalidateExternalIPv4Cache(): void {
  cache = null;
}

/** 마지막으로 알려진 IPv4 + 갱신 시각. 응답 본문에 박을 때 사용. */
export function getCachedExternalIPv4(): { ipv4: string; fetchedAt: number } | null {
  return cache;
}

async function fetchFromEchoChain(): Promise<string | null> {
  for (const url of ECHO_ENDPOINTS) {
    const ip = await fetchOne(url);
    if (ip) {
      cache = { ipv4: ip, fetchedAt: Date.now() };
      return ip;
    }
  }
  // 전부 실패 — stale 라도 있으면 그대로 반환.
  if (cache) {
    console.warn(`[external-ip] all echo endpoints failed, returning stale IP (${cache.ipv4}, ${ageSec(cache.fetchedAt)}s old)`);
    return cache.ipv4;
  }
  console.warn("[external-ip] all echo endpoints failed and no cached value");
  return null;
}

async function fetchOne(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      // Pocket Sisyphus UA 박으면 echo 서비스가 abuse 추적 시 식별 가능 — 일반 fetch UA 그대로.
    });
    if (!resp.ok) {
      console.warn(`[external-ip] ${url} status ${resp.status}`);
      return null;
    }
    const text = (await resp.text()).trim();
    if (isValidIPv4(text)) {
      return text;
    }
    console.warn(`[external-ip] ${url} returned non-IPv4: ${text.slice(0, 40)}`);
    return null;
  } catch (e) {
    console.warn(`[external-ip] ${url} failed: ${(e as Error).message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function isValidIPv4(s: string): boolean {
  const m = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  for (let i = 1; i <= 4; i++) {
    const n = Number(m[i]);
    if (n < 0 || n > 255) return false;
  }
  return true;
}

/**
 * 글로벌 IPv6 주소가 있으면 반환. 없으면 null.
 *
 * IPv6 는 NAT 가 없으므로 로컬에서 본 글로벌 주소가 곧 외부 주소다. echo 호출 불필요.
 * link-local (fe80::), unique-local (fc00::/7), loopback (::1), temporary (privacy ext.) 제외.
 *
 * privacy extensions (RFC 4941) 가 켜져 있으면 매번 IPv6 주소가 바뀌어 inbound 받기 어렵다.
 * macOS 기본은 privacy ext on — endpoint 응답으로 들고가는 IPv6 가 곧 stale 가능성. iOS 가 happy
 * eyeballs 에서 IPv6 실패하면 IPv4 / Tor fallback 으로 자동 전환되므로 critical 은 아님.
 */
export function getGlobalIPv6(): string | null {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const addr of ifaces[name] ?? []) {
      if (addr.family !== "IPv6") continue;
      if (addr.internal) continue;
      const ip = addr.address.toLowerCase();
      // 글로벌 unicast 가 아닌 것 제외.
      if (ip.startsWith("fe80:")) continue;          // link-local
      if (ip.startsWith("fc") || ip.startsWith("fd")) continue;  // unique-local
      if (ip === "::1") continue;                    // loopback
      // 첫 글로벌 주소 채택. multiple 일 땐 macOS source address selection 이 알아서.
      return ip;
    }
  }
  return null;
}

function ageSec(t: number): number {
  return Math.floor((Date.now() - t) / 1000);
}

/**
 * WAN IPv4 변경 감시 — daemon 안에서 주기적으로 외부 echo 호출, 직전 값과 다르면 onChange.
 *
 * 동기: Mac 앱의 `NetworkChangeMonitor` 는 `getifaddrs()` 로 «Mac 인터페이스» IPv4 만
 * 보기 때문에 가정용 공유기 NAT 안쪽에선 사실상 LAN IP (192.168.x.x) 의 변경만 감지한다.
 * 정작 onion introduction point 가 stale 해지는 원인은 그 위쪽 — ISP DHCP 갱신으로 인한
 * 공유기 WAN IP 변경이다. echo 폴링이 그 갭을 메운다.
 *
 * 호출자 (server.ts) 는 onChange 안에서 `kickTorReconnect()` 를 부르면 된다. SIGHUP 으로
 * introduction point 재선정이 강제되어 Tor 자체 timeout (1~5분) 을 5~10s 로 압축한다.
 *
 * 주기 = 5분: 가정 인터넷 WAN IP 변경 빈도가 시간/일 단위라 충분. 더 짧게 잡으면 echo
 * 서비스에 무용한 트래픽 + abuse 패턴으로 보일 위험.
 *
 * 에러 처리: echo 전부 실패 (네트워크 다운) 면 onChange 호출하지 않고 다음 주기까지 대기.
 * "IP를 모르겠다" 를 "IP가 바뀌었다" 로 오인하면 false alarm 으로 SIGHUP 폭주.
 *
 * @returns stop 함수. shutdown 핸들러에서 호출.
 */
export function startWanIPv4Watcher(
  onChange: (prev: string | null, next: string) => void,
  intervalMs: number = 5 * 60 * 1000,
): () => void {
  let lastKnown: string | null = cache?.ipv4 ?? null;
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    // 캐시 무시하고 fresh fetch — 안 그러면 캐시 TTL 안에서 변경 못 잡음.
    invalidateExternalIPv4Cache();
    const ip = await getExternalIPv4();
    if (stopped) return;
    if (!ip) return;
    if (lastKnown && ip !== lastKnown) {
      console.log(`[wan-watch] WAN IPv4 변경 감지: ${lastKnown} → ${ip}`);
      try {
        onChange(lastKnown, ip);
      } catch (e) {
        console.warn("[wan-watch] onChange threw:", (e as Error).message);
      }
    }
    lastKnown = ip;
  };

  const handle = setInterval(tick, intervalMs);
  // 초기 1회 즉시 — startup 후 lastKnown 을 한 번 박아둠. 첫 호출에선 비교 대상이 없어
  // onChange 가 안 불리고 lastKnown 만 채워진다 (의도).
  void tick();
  // process.exit 막지 않게 — daemon shutdown 시 setInterval 이 timer queue 점유하면 곤란.
  if (typeof (handle as { unref?: () => void }).unref === "function") {
    (handle as { unref: () => void }).unref();
  }

  return () => {
    stopped = true;
    clearInterval(handle);
  };
}
