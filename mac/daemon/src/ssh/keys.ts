// 임베디드 sshd 의 host key + client authorized_keys 관리.
//
// 파일 배치 (`~/Library/Application Support/PocketSisyphus/ssh/`):
//  - host_ed25519_key            sshd host private key (0600). 영구. 페어링 fingerprint 의 기반.
//  - host_ed25519_key.pub        sshd host public key (0644).
//  - authorized_keys             클라이언트 pub key 목록 (0600). 페어링마다 한 줄 추가.
//
// 페어링 한 번 = 새 ed25519 client keypair 한 쌍 생성:
//  - priv 를 QR 페이로드 (v=3) 에 박아 폰으로 전달
//  - pub 를 `authorized_keys` 에 한 줄 추가 (라인 끝에 deviceId comment 박아 revoke 시 식별)
//
// Revoke: `authorized_keys` 에서 해당 라인 제거. SSH 측면 immediate (다음 연결 거부),
// 이미 열린 SSH 세션은 안 끊김 — daemon 측 Bearer revoke 가 보조 차단선.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CONFIG_DIR, ensureConfigDir } from "../config.js";

export const SSH_DIR = path.join(CONFIG_DIR, "ssh");
export const HOST_KEY_FILE = path.join(SSH_DIR, "host_ed25519_key");
export const HOST_KEY_PUB_FILE = path.join(SSH_DIR, "host_ed25519_key.pub");
export const AUTHORIZED_KEYS_FILE = path.join(SSH_DIR, "authorized_keys");
// 영속 «현재 페어링» client keypair. 매 부팅마다 새 키를 만들어 authorized_keys 에 쌓던
// 버그를 막기 위해, 페어링 키는 단 한 쌍만 디스크에 보관하고 부팅 간 재사용한다.
// 회전(rotateClientKeypair)만이 이 파일을 새 키로 교체한다.
export const CLIENT_KEY_FILE = path.join(SSH_DIR, "client_ed25519_key");
export const CLIENT_KEY_PUB_FILE = path.join(SSH_DIR, "client_ed25519_key.pub");

export type HostKeyInfo = {
  /** OpenSSH SHA256 fingerprint, "SHA256:..." prefix 포함. Tor onion 의 fingerprint 와 별개. */
  fingerprint: string;
  /** OpenSSH 공개키 한 줄 (`ssh-ed25519 AAAAC3... pocket-sisyphus`). */
  publicKeyLine: string;
};

export type ClientKeypair = {
  /** ed25519 priv key, OpenSSH PEM format. QR 페이로드에 박을 base64 encoded string. */
  privBase64: string;
  /** OpenSSH 공개키 한 줄 (`ssh-ed25519 AAAA...`). `authorized_keys` 에 그대로 append. */
  publicKeyLine: string;
};

function ensureSshDir(): void {
  ensureConfigDir();
  if (!fs.existsSync(SSH_DIR)) {
    fs.mkdirSync(SSH_DIR, { recursive: true, mode: 0o700 });
  }
  fs.chmodSync(SSH_DIR, 0o700);
}

/**
 * Host keypair 가 없으면 생성, 있으면 그대로 fingerprint 만 계산해 반환.
 * 영구 — 한 번 생성된 host key 는 재페어링 사이클과 무관. 페어링 QR 에 박힌 fingerprint
 * 와 항상 일치해야 한다.
 */
export function ensureHostKey(): HostKeyInfo {
  ensureSshDir();
  if (!fs.existsSync(HOST_KEY_FILE)) {
    generateHostKey();
  }
  const pubLine = fs.readFileSync(HOST_KEY_PUB_FILE, "utf8").trim();
  return {
    fingerprint: computeSshFingerprint(pubLine),
    publicKeyLine: pubLine,
  };
}

function generateHostKey(): void {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const privPem = privateKey.export({ format: "pem", type: "pkcs8" }) as string;
  const pubLine = ed25519PubKeyToSshLine(publicKey, "pocket-sisyphus-host");
  // sshd 가 사용하는 host key 는 OpenSSH 의 own format ("-----BEGIN OPENSSH PRIVATE KEY-----")
  // 이 필요한데, Node crypto 는 표준 PKCS8 PEM 만 출력한다.
  // OpenSSH portable 의 sshd 는 PKCS8 PEM 도 받아들인다 (recent versions). 검증 후 안 되면
  // `ssh-keygen -p -f <file> -N "" -m PEM` 으로 한 번 통과시키는 build step 추가.
  // 1차 구현에서는 PKCS8 그대로 시도하고 sshd 가 거부하면 ssh-keygen 변환 step 도입.
  fs.writeFileSync(HOST_KEY_FILE, privPem, { mode: 0o600 });
  fs.writeFileSync(HOST_KEY_PUB_FILE, `${pubLine}\n`, { mode: 0o644 });
  console.log("[ssh] generated new host ed25519 key");
}

/**
 * ed25519 public KeyObject → OpenSSH "ssh-ed25519 AAAA... comment" 한 줄 포맷.
 *
 * Node crypto 가 ed25519 public 을 OpenSSH 한 줄 포맷으로 직접 export 하는 API 가 없어
 * 직접 wire format 을 만든다. SSH 표준 (RFC 4253 §6.6):
 *   string "ssh-ed25519" + string <32B raw pub key>
 *   (각 string 은 4-byte big-endian length prefix + bytes)
 * 전체를 base64 encode.
 */
function ed25519PubKeyToSshLine(
  publicKey: crypto.KeyObject,
  comment: string,
): string {
  // SPKI DER 에서 마지막 32 bytes 가 raw ed25519 public key (RFC 8410).
  const der = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  if (der.length < 32) {
    throw new Error(`unexpected ed25519 SPKI DER length: ${der.length}`);
  }
  const rawPub = der.subarray(der.length - 32);
  const algName = Buffer.from("ssh-ed25519", "utf8");
  const blob = Buffer.concat([
    lengthPrefix(algName),
    lengthPrefix(rawPub),
  ]);
  const b64 = blob.toString("base64");
  return `ssh-ed25519 ${b64} ${comment}`;
}

function lengthPrefix(buf: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(buf.length, 0);
  return Buffer.concat([len, buf]);
}

/**
 * OpenSSH `ssh-keygen -lf <pub>` 와 동등한 SHA256 fingerprint 계산.
 * 입력: "ssh-ed25519 AAAAC3... comment" 한 줄.
 * 출력: "SHA256:<base64-no-padding>"
 */
export function computeSshFingerprint(publicKeyLine: string): string {
  const parts = publicKeyLine.trim().split(/\s+/);
  if (parts.length < 2) {
    throw new Error(`invalid SSH public key line: ${publicKeyLine.slice(0, 60)}`);
  }
  const keyBlob = Buffer.from(parts[1], "base64");
  const hash = crypto.createHash("sha256").update(keyBlob).digest("base64");
  // OpenSSH 는 base64 끝의 = padding 을 떼서 표시.
  return `SHA256:${hash.replace(/=+$/, "")}`;
}

// ─── Client keys ───────────────────────────────────────────────────────────

/**
 * 새 client keypair 발급 — 페어링 한 번에 한 쌍.
 *
 * 반환된 `privBase64` 는 QR 페이로드 v=3 의 `ssh_client_priv` 필드에 그대로 박힘.
 * `publicKeyLine` 은 `addAuthorizedClient` 로 `authorized_keys` 에 한 줄 추가.
 *
 * priv 형식: OpenSSH PEM (PKCS8). 폰에서 NMSSH/libssh2 가 받아들이는 형식.
 *   "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
 * base64 encode 해서 QR 페이로드 한 줄 안에 들어가도록 한다.
 */
export function generateClientKeypair(): ClientKeypair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const pubLine = ed25519PubKeyToSshLine(publicKey, "pocket-sisyphus-client");
  const privPem = privateKey.export({ format: "pem", type: "pkcs8" }) as string;
  const privBase64 = Buffer.from(privPem, "utf8").toString("base64");
  return {
    privBase64,
    publicKeyLine: pubLine,
  };
}

/**
 * 영속 «현재 페어링» client keypair 를 로드한다. 없으면 1회 생성 후 디스크에 영속화.
 *
 * 부팅마다 호출 — 기존 키가 있으면 그대로 재사용하므로 폰에 이미 박힌 QR 이 계속 유효하고,
 * authorized_keys 에 새 라인이 쌓이지 않는다 (옛 버그: 부팅마다 generateClientKeypair +
 * append → 45개 유령 키 누적 → revoke 무력화).
 */
export function loadOrCreateClientKeypair(): ClientKeypair {
  ensureSshDir();
  if (fs.existsSync(CLIENT_KEY_FILE) && fs.existsSync(CLIENT_KEY_PUB_FILE)) {
    const privPem = fs.readFileSync(CLIENT_KEY_FILE, "utf8");
    const pubLine = fs.readFileSync(CLIENT_KEY_PUB_FILE, "utf8").trim();
    return {
      privBase64: Buffer.from(privPem, "utf8").toString("base64"),
      publicKeyLine: pubLine,
    };
  }
  return persistClientKeypair(generateClientKeypair());
}

/**
 * client keypair 를 새로 발급해 디스크에 교체 기록 — 페어링 «회전» 전용.
 * 호출 후 `setAuthorizedClientExclusive` 로 authorized_keys 도 이 한 키로만 설정해야
 * 옛 키 전부 무효화된다.
 */
export function rotateClientKeypair(): ClientKeypair {
  ensureSshDir();
  return persistClientKeypair(generateClientKeypair());
}

function persistClientKeypair(kp: ClientKeypair): ClientKeypair {
  const privPem = Buffer.from(kp.privBase64, "base64").toString("utf8");
  fs.writeFileSync(CLIENT_KEY_FILE, privPem, { mode: 0o600 });
  fs.writeFileSync(CLIENT_KEY_PUB_FILE, `${kp.publicKeyLine}\n`, { mode: 0o644 });
  return kp;
}

/**
 * `authorized_keys` 를 «정확히 이 한 개» 키로 설정한다 (옛 키 전부 제거).
 * 부팅·회전 모두 이걸 써서 인증 가능한 client key 가 항상 1개로 수렴하도록 한다.
 */
export function setAuthorizedClientExclusive(publicKeyLine: string, deviceId: string): void {
  ensureSshDir();
  writeAuthorizedKeys([`${publicKeyLine.trim()} pocket-device:${deviceId}`]);
}

/**
 * `authorized_keys` 에 한 줄 추가. `deviceId` 를 comment 로 박아 revoke 시 식별.
 *
 * 멱등성: 같은 `deviceId` 로 두 번 호출하면 이전 라인 제거 후 새 라인 추가 — 페어링 회전 케이스.
 */
export function addAuthorizedClient(publicKeyLine: string, deviceId: string): void {
  ensureSshDir();
  const lines = readAuthorizedKeys();
  const filtered = lines.filter((line) => !lineMatchesDevice(line, deviceId));
  filtered.push(`${publicKeyLine.trim()} pocket-device:${deviceId}`);
  writeAuthorizedKeys(filtered);
}

/**
 * `authorized_keys` 를 통째로 비운다. 페어링 회전 시점에 호출 — 옛 client priv 가
 * 폰/QR 어디 흘러갔든 SSH 인증 자체가 즉시 거부되도록.
 *
 * 호출자(`admin.ts:rotate-pairing`)는 곧장 `addAuthorizedClient` 로 새 한 줄을 박는다.
 * 그 사이엔 인증 가능한 key 가 0 개라 외부에서 sshd 에 connect 가 들어와도 거부됨.
 */
export function clearAuthorizedKeys(): void {
  ensureSshDir();
  writeAuthorizedKeys([]);
}

/**
 * `authorized_keys` 에서 특정 deviceId 의 라인 제거. revoke 시점에 호출.
 * 라인이 없어도 throw 안 함 (멱등).
 */
export function removeAuthorizedClient(deviceId: string): void {
  if (!fs.existsSync(AUTHORIZED_KEYS_FILE)) return;
  const lines = readAuthorizedKeys();
  const filtered = lines.filter((line) => !lineMatchesDevice(line, deviceId));
  if (filtered.length !== lines.length) {
    writeAuthorizedKeys(filtered);
  }
}

function lineMatchesDevice(line: string, deviceId: string): boolean {
  return line.includes(`pocket-device:${deviceId}`);
}

function readAuthorizedKeys(): string[] {
  if (!fs.existsSync(AUTHORIZED_KEYS_FILE)) return [];
  return fs
    .readFileSync(AUTHORIZED_KEYS_FILE, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
}

function writeAuthorizedKeys(lines: string[]): void {
  ensureSshDir();
  const body = lines.length > 0 ? lines.join("\n") + "\n" : "";
  fs.writeFileSync(AUTHORIZED_KEYS_FILE, body, { mode: 0o600 });
}
