// LAN 전용(사설망 직결) 모드용 사설/링크로컬 주소 발견.
//
// LAN 전용 모드는 폰이 같은 Wi-Fi/LAN 일 때만 사설/링크로컬 주소로 직접 SSH 하고,
// Tor 발견·공인 IPv4/IPv6·onion 폴백을 «거부» 한다. 그러려면 daemon 이 자기 사설/링크로컬
// 주소를 `direct_lan` endpoint 로 광고해야 한다.
//
// 공인 주소(external-ip.ts)와 정반대 — 여기선 «사설» 만 고른다:
//  - IPv4 RFC1918: 10/8, 172.16/12, 192.168/16  +  169.254/16 (link-local)
//  - IPv6 link-local fe80::/10  +  unique-local fc00::/7 (fc/fd)
//
// mDNS hostname(`<host>.local`) 도 함께 광고한다 — DHCP 로 사설 IP 가 바뀌어도 따라가는
// 안정적 핸들. macOS mDNSResponder 가 같은 LAN 에서 자동 응답하므로 별도 광고 인프라 불필요.

import os from "node:os";

export type LanHost = {
  /** direct_lan endpoint 의 host (사설 IPv4 / link-local IPv6 / `<host>.local`). */
  host: string;
  /** 정렬 안정성용 — mDNS hostname 최우선(0), IPv4 사설(1), IPv6 link/unique-local(2). */
  rank: number;
};

/** RFC1918 사설 IPv4 인가 (10/8, 172.16/12, 192.168/16). */
function isPrivateIPv4(ip: string): boolean {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

/** 169.254/16 IPv4 link-local (APIPA) 인가. */
function isLinkLocalIPv4(ip: string): boolean {
  return ip.startsWith("169.254.");
}

/**
 * getifaddrs(os.networkInterfaces) 에서 사설/링크로컬 주소만 골라 direct_lan 후보로 반환.
 *
 * mDNS hostname 을 맨 앞(rank 0)에 둔다 — 사설 IP 가 DHCP 로 바뀌어도 같은 핸들로 도달.
 * 공인 글로벌 주소(external-ip.ts 가 다루는 영역)는 «절대» 포함하지 않는다.
 */
export function getLanHosts(): LanHost[] {
  const hosts: LanHost[] = [];

  // 1) mDNS `<host>.local` — 가장 안정적인 핸들 (IP 변경 추종).
  const mdns = getMdnsHostname();
  if (mdns) hosts.push({ host: mdns, rank: 0 });

  // 2) getifaddrs 사설/링크로컬 주소.
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const addr of ifaces[name] ?? []) {
      if (addr.internal) continue; // loopback 제외
      if (addr.family === "IPv4") {
        if (isPrivateIPv4(addr.address)) {
          hosts.push({ host: addr.address, rank: 1 });
        } else if (isLinkLocalIPv4(addr.address)) {
          hosts.push({ host: addr.address, rank: 2 });
        }
        continue;
      }
      if (addr.family === "IPv6") {
        const ip = addr.address.toLowerCase();
        // link-local (fe80::/10) 또는 unique-local (fc00::/7) 만. 글로벌 unicast 제외.
        const isLinkLocal = ip.startsWith("fe80:");
        const isUniqueLocal = ip.startsWith("fc") || ip.startsWith("fd");
        if (!isLinkLocal && !isUniqueLocal) continue;
        // link-local IPv6 는 scope id(zone) 없이는 다이얼 불가 — iOS 가 못 쓰므로 제외.
        // unique-local 만 광고한다.
        if (isLinkLocal) continue;
        hosts.push({ host: ip, rank: 2 });
      }
    }
  }

  return dedupe(hosts);
}

/** mDNS `<host>.local` hostname. 이미 `.local` 이면 그대로, 아니면 붙인다. */
export function getMdnsHostname(): string | null {
  const raw = os.hostname();
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  return trimmed.endsWith(".local") ? trimmed : `${trimmed}.local`;
}

function dedupe(hosts: LanHost[]): LanHost[] {
  const seen = new Set<string>();
  const out: LanHost[] = [];
  for (const h of hosts) {
    if (seen.has(h.host)) continue;
    seen.add(h.host);
    out.push(h);
  }
  return out;
}
