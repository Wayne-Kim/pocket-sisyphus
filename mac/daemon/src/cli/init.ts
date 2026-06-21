import os from "node:os";
import qrcode from "qrcode-terminal";
import { generateToken, hashToken } from "../auth.js";
import {
  ensureConfigDir,
  readConfig,
  writeConfig,
  CONFIG_FILE,
} from "../config.js";

function detectLanIp(): string {
  const ifaces = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (!addrs) continue;
    for (const a of addrs) {
      if (
        a.family === "IPv4" &&
        !a.internal &&
        (name === "en0" || name === "en1")
      ) {
        return a.address;
      }
    }
  }
  for (const addrs of Object.values(ifaces)) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) return a.address;
    }
  }
  return "127.0.0.1";
}

/** Mac의 mDNS hostname (예: solowayui-Macmini-4.local). IP가 바뀌어도 따라감. */
function detectLocalHostname(): string {
  const h = os.hostname();
  return h.endsWith(".local") ? h : `${h}.local`;
}

async function main(): Promise<void> {
  const existing = readConfig();
  const force = process.argv.includes("--force");
  if (existing && !force) {
    console.log("ℹ️  Daemon already initialized.");
    console.log(`   Config: ${CONFIG_FILE}`);
    console.log("   Re-init: pocket-sisyphus init --force");
    return;
  }

  const token = generateToken();
  const port = 7777;
  const lanIp = detectLanIp();
  const hostname = detectLocalHostname();

  ensureConfigDir();
  // v2: bindHost 미저장 → daemon은 127.0.0.1만 사용. 외부는 Tor가 담당.
  // token: 평문도 저장 (0600 파일) — daemon 부팅 시 페어링 QR을 그대로 출력하기 위해.
  writeConfig({
    port,
    token,
    tokenHash: hashToken(token),
    createdAt: Date.now(),
  });

  // 페어링 URL 우선순위: mDNS .local hostname → LAN IP 폴백 (mDNS 안 되는 환경)
  const primaryUrl = `http://${hostname}:${port}`;
  const fallbackUrl = `http://${lanIp}:${port}`;
  const pairing = { url: primaryUrl, token, fallback: fallbackUrl };
  const qrPayload = JSON.stringify(pairing);

  console.log("");
  console.log("✔ Daemon token generated");
  console.log(`✔ Config written to ${CONFIG_FILE}`);
  console.log(`✔ Daemon will bind to 0.0.0.0:${port} (모든 LAN/WG 인터페이스)`);
  console.log("");
  console.log("📱 폰에서 같은 Wi-Fi 접속할 URL (mDNS — IP 바뀌어도 OK):");
  console.log(`  PRIMARY:  ${primaryUrl}`);
  console.log(`  FALLBACK: ${fallbackUrl}`);
  console.log("");
  console.log("📱 QR 스캔:");
  console.log("");
  qrcode.generate(qrPayload, { small: true });
  console.log("");
  console.log("수동 페어링 정보:");
  console.log(`  URL:   ${primaryUrl}`);
  console.log(`  Token: ${token}`);
  console.log("");
  console.log("⚠️  This token is shown ONCE. Save it now.");
  console.log("");
  console.log("Next: npm run dev   (or: pocket-sisyphus start)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
