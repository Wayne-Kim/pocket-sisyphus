// 페어링 QR payload 빌더 + PNG 파일 출력.
//
// 시작 시 / 페어링 회전 시 둘 다 같은 포맷의 QR 을 만들어야 하기 때문에 별도 모듈로 추출.
//
// 버전 진화:
//  - v=2: onion + bearer token + Tor v3 client-auth priv. 단일 Tor data plane 모델.
//  - v=3: SSH-first + Tor fallback 듀얼 채널 모델. SSH host key fingerprint + SSH client
//         keypair priv 추가. iOS 가 SSH 로 daemon 에 직접 connect.

import os from "node:os";
import fs from "node:fs";
import QRCode from "qrcode";
import { getMdnsHostname } from "../nat/lan-addr.js";

export type PairingPayloadInput = {
  onion: string;
  /** daemon `/api/*` Bearer (SSH 채널 안에서 daemon HTTP 인증). */
  daemonToken: string;
  /** daemon endpoint-only HTTP `/endpoint` 의 Bearer (Tor onion 노출 — 분리된 토큰). */
  endpointToken: string;
  /** Tor v3 client-auth priv (x25519 base32). onion descriptor 복호화. */
  clientAuthPriv: string;
  /** sshd host key SHA256 fingerprint ("SHA256:..."). 표시/진단용. */
  sshHostKeyFingerprint: string;
  /** sshd host 공개키 한 줄 ("ssh-ed25519 AAAA... comment"). iOS 가 .trustedKeys 로 pin. */
  sshHostKeyLine: string;
  /** 페어링용 ed25519 client keypair priv (PKCS8 PEM, base64 encoded). iOS 가 SSH 인증에 사용. */
  sshClientPrivBase64: string;
  /** sshd 가 받아들이는 SSH user name. */
  sshUser: string;
  /** 직접 SSH 포트(기본 22022). LAN 전용 모드가 `<lan_host>:<ssh_port>` 로 다이얼. */
  sshPort: number;
  /** daemon HTTP 메인 listener 포트(기본 7777). SSH local forward 의 목적지. */
  daemonPort: number;
  /** QR 안의 사람-친화적 라벨. 비워두면 hostname 에서 .local 떼고 사용. */
  name?: string;
};

/**
 * v=3 페어링 QR payload (JSON 직렬화).
 *
 * iOS 가 받아 처리:
 *  1. onion + clientAuthPriv 로 Tor 회로 빌드 → /endpoint 받아옴
 *  2. /endpoint 의 endpoint 배열을 happy eyeballs 로 병렬 SSH 시도
 *  3. sshHostKeyFingerprint 로 host key pin, sshClientPrivBase64 로 client auth
 *  4. SSH local forward 위에서 daemon HTTP/WS 호출 시 daemonToken 으로 Bearer
 *
 * 구버전 iOS 앱(v=1, v=2) 은 SSH key 필드 부재로 sshd 인증 불가 → daemon 거부 → 재페어링 안내.
 */
export function buildPairingPayload(input: PairingPayloadInput): string {
  const name = input.name ?? os.hostname().replace(/\.local$/, "");
  return JSON.stringify({
    v: 3,
    onion: input.onion,
    onion_auth: input.clientAuthPriv,
    endpoint_token: input.endpointToken,
    daemon_token: input.daemonToken,
    ssh_host_key_fingerprint: input.sshHostKeyFingerprint,
    ssh_host_key: input.sshHostKeyLine,
    ssh_client_priv: input.sshClientPrivBase64,
    ssh_user: input.sshUser,
    // LAN 전용(사설망 직결) 모드용 — Tor 없이도 같은 LAN 의 Mac 에 직행할 수 있게 mDNS
    // hostname(`<host>.local`, IP 변경 추종) + SSH/daemon 포트를 QR 에 담는다. 폰이
    // `/endpoint`(Tor 경유) 를 못 받는 콜드 상태에서도 LAN 전용 모드가 부트스트랩 가능.
    lan_host: getMdnsHostname(),
    ssh_port: input.sshPort,
    daemon_port: input.daemonPort,
    name,
  });
}

/**
 * QR PNG 를 파일로 쓴다. 기존 파일은 덮어쓴다. 너비 600px, margin 2, M-level 오류 정정.
 *
 * 호출자가 경로를 정한다 — 시작 시엔 `${CONFIG_DIR}/pair-qr.png`, 회전 시도 같은 경로.
 * Mac 앱의 QRWindowController 가 파일 mtime 변화로 자동 reload 한다.
 */
export async function writePairingQRPng(
  payload: string,
  pngPath: string,
): Promise<void> {
  await QRCode.toFile(pngPath, payload, {
    errorCorrectionLevel: "M",
    margin: 2,
    width: 600,
  });
  // QR PNG 는 전체 비밀 번들(SSH client priv + onion-auth priv + bearer token)을 담는다.
  // QRCode.toFile 기본 권한은 0644(world-readable)이므로, config.json/authorized_keys 와
  // 같은 0600 으로 좁혀 같은 머신의 다른 사용자/프로세스가 못 읽게 한다.
  try {
    fs.chmodSync(pngPath, 0o600);
  } catch {
    // chmod 실패는 치명적이지 않다 — QR 생성 자체는 끝났으므로 무시하고 진행.
  }
}
