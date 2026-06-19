// 운영자(=Mac 앱) 전용 admin 엔드포인트. 페어링 회전 등.
//
// daemon 은 127.0.0.1 만 바인딩되어 있고 외부는 Tor hidden service 뒤이므로 운영자 API
// 라고 해서 별도 인증 채널을 더 두지 않는다 — bearer 만으로 충분. (Tor 노출에서 옛 token
// 으로도 회전 시도가 가능하다는 우려가 있지만, 회전이 일어나면 옛 token 자체가 즉시 무효
// 처리되므로 한 번 성공한 뒤엔 그 token 으로 또 회전 못 한다. 결과는 사용자가 새 QR 만
// 다시 발급하면 그만.)

import path from "node:path";
import os from "node:os";
import { Hono } from "hono";
import {
  bearerAuth,
  generateToken,
  hashToken,
  invalidateAuthCache,
} from "../auth.js";
import {
  CONFIG_DIR,
  readConfig,
  writeConfig,
  listAttestDevices,
  allowedDeviceSlots,
  MAX_DEVICE_SLOTS,
} from "../config.js";
import { rotatePairingKeys, kickTorReconnect } from "../tor/sidecar.js";
import { buildPairingPayload, writePairingQRPng } from "../tor/pairing.js";
import { disconnectAllClients } from "../ws/hub.js";
import {
  ensureHostKey,
  rotateClientKeypair,
  setAuthorizedClientExclusive,
  loadOrCreateClientKeypair,
  computeSshFingerprint,
} from "../ssh/keys.js";
import { SSH_PORT } from "../ssh/server.js";
import {
  fingerprintForPublicKey,
  deviceIdFor,
  getDeviceSeen,
} from "../attest.js";
import { clearUpdateStatus, setUpdateStatus } from "../updateStatus.js";
import { getAgent, hasAgent } from "../agent/registry.js";
import {
  startAgentInstall,
  startInstall,
  getLocalLlmInstallTarget,
  getAgentInstallProgress,
  installHintIsCommand,
} from "../agent/install.js";

export const admin = new Hono();

admin.use("*", bearerAuth);

/**
 * 페어링 값 (token + onion + client-auth) 전부 회전.
 *
 * 흐름:
 *  1) 새 bearer token 생성, config.json 갱신 — 옛 token 즉시 invalid.
 *  2) 살아 있는 WS 클라이언트 모두 끊기 — 옛 token 으로 인증된 소켓이 message 받는 사고 방지.
 *  3) Tor 정지 → onion 키 / client-auth 키 / HS descriptor 캐시 삭제 → 재시작 → 새 onion + 새 priv 자동 생성.
 *  4) pair-qr.png 새 payload 로 재발급.
 *
 * 응답엔 새 token 을 평문으로 넣지 않는다 — 호출자(Mac 앱)는 곧장 새 QR PNG 를 열어 사용자가
 * 폰으로 스캔하도록 한다. plain bearer 가 응답에 흘러 다니지 않게 유지.
 */
admin.post("/rotate-pairing", async (c) => {
  const cfg = readConfig();
  if (!cfg) {
    return c.json({ error: "daemon not initialized" }, 500);
  }

  // 1) 새 토큰 발급 + Secure Enclave 기기 인증 등록 초기화.
  //    회전 = «옛 페어링 전부 무효». 등록된 폰 공개키도 지워야 새 폰이 재페어링 시 다시
  //    등록할 수 있다 (= 기기 교체/SE 키 분실 시 복구 경로). undefined 는 writeConfig 의
  //    JSON.stringify 단계에서 키째 빠진다.
  const newToken = generateToken();
  writeConfig({
    ...cfg,
    token: newToken,
    tokenHash: hashToken(newToken),
    attestPublicKey: undefined,
    attestRegisteredAt: undefined,
    // 등록된 모든 기기 무효화. 추가 기기 슬롯 허용도 기본(false)으로 되돌린다 — 회전은 «처음부터
    // 다시» 이므로, 새 기기를 다시 받을 때 추가 기기 슬롯은 사용자가 다시 명시적으로 켜야 한다.
    attestDevices: undefined,
    extraDeviceSlotAllowed: undefined,
  });
  // bearerAuth / verifyWsToken 가 cfg 를 메모리 캐시하므로 새 token 인식되도록 무효화.
  // 호출 안 하면 회전 후 옛 token 으로도 한동안 인증 통과 + 새 token 은 거절되는 부정합.
  invalidateAuthCache();

  // 2) 살아 있는 WS 끊기 — 옛 token 으로 인증된 소켓을 즉시 차단
  disconnectAllClients();

  // 3) Tor 키 + client-auth 회전
  let handle;
  try {
    handle = await rotatePairingKeys();
  } catch (e) {
    return c.json(
      { error: "tor rotation failed", detail: (e as Error).message },
      500,
    );
  }

  // 4) SSH 페어링용 새 ed25519 client keypair 발급. priv 는 QR 에 박고 pub 은
  //    authorized_keys 에 한 줄 추가. host key 는 영구 — fingerprint 가 동일.
  //
  //    회전의 정의 = "옛 페어링 전부 무효". 옛 client pub 라인이 남아 있으면 옛 QR 보유자가
  //    SSH 인증을 그대로 통과하므로 (token rotate 와 무관하게 sshd 레이어에서 통과 → 터널
  //    수립) revoke 가 미완성. 새 라인 박기 전에 통째로 비워 옛 키 전부 무효화.
  // 회전 = 옛 페어링 전부 무효 + 새 client keypair 발급. 영속 키 파일을 새 키로 교체하고
  // authorized_keys 를 그 한 키로만 설정 → 옛 키(부팅 누적분 포함) 전부 즉시 거부.
  const hostKey = ensureHostKey();
  const sshKeys = rotateClientKeypair();
  setAuthorizedClientExclusive(sshKeys.publicKeyLine, "paired");

  // 5) sshd user — 회전 시점에 우리가 알 수 없으니 macOS 현재 user 그대로.
  //    ssh/server.ts 의 startSsh 가 부팅 시 같은 값으로 sshd_config 작성.
  //    daemon 은 ES module 이라 require() 안 됨 — 상단 import 사용.
  const sshUser = os.userInfo().username;

  // 6) 새 페어링 QR 파일
  const payload = buildPairingPayload({
    onion: handle.onionAddress,
    daemonToken: newToken,
    endpointToken: newToken,
    clientAuthPriv: handle.clientAuthPriv,
    sshHostKeyFingerprint: hostKey.fingerprint,
    sshHostKeyLine: hostKey.publicKeyLine,
    sshClientPrivBase64: sshKeys.privBase64,
    sshUser,
    sshPort: cfg.sshPort ?? SSH_PORT,
    daemonPort: cfg.port,
  });
  try {
    await writePairingQRPng(payload, path.join(CONFIG_DIR, "pair-qr.png"));
  } catch (e) {
    // QR 갱신 실패해도 회전 자체는 끝남 — 사용자가 daemon 재시작하면 server.ts 시작 시
    // QR 출력 단계가 다시 그려준다. 그래도 알려는 줌.
    console.warn("[admin] QR 갱신 실패:", (e as Error).message);
  }

  return c.json({
    ok: true,
    onion: handle.onionAddress,
  });
});

/**
 * Mac 앱의 NWPathMonitor 가 primary IPv4 변경을 감지하면 호출. daemon 은 Tor 에 SIGHUP
 * 을 보내 introduction point 재선정 + descriptor 재publish 를 강제한다. dynamic IP
 * 환경에서 Tor 자체 timeout (1~5분) 대신 5~10s 안에 폰 접근 가능 상태로 복구하는 게 목표.
 *
 * 응답의 `result` 는 디버깅용 — Mac 앱은 noop 처리해도 됨.
 *
 * 인증: 같은 bearer 사용. Mac 앱은 어차피 config.json 에서 토큰을 읽으므로 추가 비밀
 * 자료 없이 호출 가능. 127.0.0.1 바인딩 + bearer 이중 게이트라 Tor 노출 표면엔 영향 X.
 */
admin.post("/network-changed", async (c) => {
  const result = kickTorReconnect();
  return c.json({ ok: true, result });
});

/**
 * 페어링/인증된 기기 목록 + 슬롯 상태. Mac 앱 「기기」 탭이 표시·관리용으로 호출.
 *
 * 다중 기기(최대 `MAX_DEVICE_SLOTS`대) 모델. `extraSlotAllowed` 가 false 면 등록 가능한
 * 기기는 1대(기본), true 면 `MAX_DEVICE_SLOTS`대까지.
 *
 *  - enrolled: 1대 이상 등록됐는지 (false = soft 모드, 옛 폰 앱 / 미등록)
 *  - extraSlotAllowed: 추가 기기 슬롯이 켜져 있는지
 *  - maxSlots: 절대 상한 (MAX_DEVICE_SLOTS)
 *  - sshClientKeyFingerprint: 페어링 SSH client 키 지문 (모든 기기가 공유 — QR 의 키)
 *  - devices[]: 등록된 기기별 { registeredAt, lastSeen, attestKeyFingerprint }
 */
admin.get("/device-info", (c) => {
  const cfg = readConfig();
  if (!cfg) return c.json({ error: "daemon not initialized" }, 500);
  const sshFp = computeSshFingerprint(loadOrCreateClientKeypair().publicKeyLine);
  const devices = listAttestDevices(cfg).map((d) => ({
    registeredAt: d.registeredAt || null,
    lastSeen: getDeviceSeen(deviceIdFor(d.publicKey)),
    attestKeyFingerprint: fingerprintForPublicKey(d.publicKey),
  }));
  return c.json({
    enrolled: devices.length > 0,
    extraSlotAllowed: Boolean(cfg.extraDeviceSlotAllowed),
    maxSlots: MAX_DEVICE_SLOTS,
    sshClientKeyFingerprint: sshFp,
    devices,
  });
});

/**
 * «추가 기기 슬롯» 허용 토글. Mac 앱 「기기」 탭의 스위치가 호출.
 *
 * body: { allowed: boolean }
 *
 * 불변식 유지: 끄려는데(allowed=false) 이미 1대를 넘게 등록돼 있으면 409
 * `remove_extra_device_first` — 먼저 기기를 1대로 줄여야 한다 (등록 수 ≤ 끈 뒤 허용 슬롯=1).
 * 켜는 건 언제나 가능.
 */
admin.post("/device-slot", async (c) => {
  const cfg = readConfig();
  if (!cfg) return c.json({ error: "daemon not initialized" }, 500);
  let body: { allowed?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  if (typeof body.allowed !== "boolean") {
    return c.json({ error: "missing_fields" }, 400);
  }
  const allowed = body.allowed;
  // 끄면 허용 슬롯이 1로 줄어든다 — 1대를 넘게 등록돼 있으면 초과분을 먼저 해제해야 한다.
  if (!allowed && listAttestDevices(cfg).length > 1) {
    return c.json({ error: "remove_extra_device_first" }, 409);
  }
  writeConfig({ ...cfg, extraDeviceSlotAllowed: allowed ? true : undefined });
  invalidateAuthCache();
  return c.json({ ok: true, extraSlotAllowed: allowed });
});

/**
 * 등록된 기기 1대를 지문으로 골라 해제(attest 키 제거). Mac 앱 「기기」 탭의 기기별
 * «해제» 버튼이 호출. 해당 기기의 attest 토큰이 즉시 무효화돼 그 폰은 `/api/*` 에서
 * 401 attest_required 를 받는다 (SSH/bearer 는 QR 공유라 그대로지만 attest 게이트에서 막힘).
 *
 * body: { fingerprint: "SHA256:..." }
 *
 * 마지막 1대를 해제하면 soft 모드로 돌아간다 (enrolled=false). 전체 초기화 + 새 QR 은
 * rotate-pairing 을 쓴다 — 여기선 토큰/onion 은 건드리지 않는다.
 */
admin.post("/revoke-device", async (c) => {
  const cfg = readConfig();
  if (!cfg) return c.json({ error: "daemon not initialized" }, 500);
  let body: { fingerprint?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const fingerprint = typeof body.fingerprint === "string" ? body.fingerprint : "";
  if (!fingerprint) {
    return c.json({ error: "missing_fields" }, 400);
  }
  const devices = listAttestDevices(cfg);
  const next = devices.filter((d) => fingerprintForPublicKey(d.publicKey) !== fingerprint);
  if (next.length === devices.length) {
    return c.json({ error: "device_not_found" }, 404);
  }
  writeConfig({
    ...cfg,
    attestDevices: next.length > 0 ? next : undefined,
    attestPublicKey: undefined,
    attestRegisteredAt: undefined,
  });
  invalidateAuthCache();
  return c.json({ ok: true, remaining: next.length });
});

/**
 * iOS 앱이 "Mac 앱 업데이트" 메뉴를 눌렀을 때 도달하는 endpoint.
 *
 * 부모 (Mac 앱) 에 `SIGUSR1` 을 보내면 `UpdaterBridge.installSignalHandler` 가 가로채
 * Sparkle 업데이트 확인을 트리거 → EdDSA 검증된 DMG 다운로드 → .app 자동 교체 → relaunch.
 *
 * 흐름 전체:
 *   iOS [Settings → "Mac 앱 업데이트"]
 *     → POST /api/admin/trigger-update (SSH 채널 위)
 *     → process.kill(parentPid, "SIGUSR1")
 *     → Mac 앱 main queue 가 깨어남
 *     → SPUUpdater.checkForUpdates()
 *     → Sparkle 가 알아서 마무리 + relaunch
 *
 * 권한 다이얼로그:
 *   - Gatekeeper / TCC 추가 동의 없음 (같은 Team ID).
 *   - `~/Applications/` 설치면 admin 비밀번호도 없음. `/Applications/` + non-admin
 *     사용자에 한해서 macOS 가 1회 비밀번호 요구 — 정책상 불가피.
 *
 * relaunch 후 iOS 는 SSH 채널 단절 → ConnectionManager.reconnect 자동. 사용자
 * 시각으로 "재연결 중…" 5~15s 후 새 daemon (= 새 marketing version) 으로 복귀.
 *
 * 부모 PID 가 없으면 (= standalone 실행 / dev 모드) 503 으로 명시 거절. 사용자가
 * 가로 모드 자동 dismiss 같은 silent 실패 대신 "daemon 이 Mac 앱 자식이 아님" 을
 * 명확히 알 수 있게.
 */
admin.post("/trigger-update", async (c) => {
  const raw = process.env.POCKET_CLAUDE_PARENT_PID;
  if (!raw) {
    return c.json({ error: "parent_unavailable" }, 503);
  }
  const parentPid = parseInt(raw, 10);
  if (!Number.isFinite(parentPid) || parentPid <= 1) {
    return c.json({ error: "parent_invalid" }, 503);
  }
  try {
    process.kill(parentPid, "SIGUSR1");
  } catch (e) {
    return c.json(
      { error: "signal_failed", detail: (e as Error).message },
      500,
    );
  }
  // 직전 시도의 잔존 결과를 지운다 — 이후 Mac 앱이 보고하는 lastUpdate 는 반드시 이번
  // 트리거 결과라, iOS 가 시계 차이 없이 «최신/실패» 를 판정할 수 있다.
  clearUpdateStatus();
  return c.json({ ok: true });
});

/**
 * Mac 앱이 «사일런트(무클릭) 업데이트» 경로의 결과를 보고하는 endpoint.
 *
 * 프로세스가 살아남는 두 경우만 온다:
 *   - "no_update" : 새 버전 없음 → iOS 가 「이미 최신」 표시
 *   - "error"     : 업데이트 중 에러 → iOS 가 「업데이트 실패: …」 표시
 *
 * 설치 성공은 relaunch 로 Mac 앱(+ 자식 daemon) 이 재시작되므로 보고가 오지 않는다 —
 * 재부팅된 daemon 의 DAEMON_VERSION ↑ 자체가 iOS 측 「완료」 신호다.
 *
 * 127.0.0.1 바인딩 + bearer(admin.use) 이중 게이트라 Tor 노출 표면엔 영향 없음.
 * 보고 주체는 같은 머신의 Mac 앱 (LocalDaemonClient).
 */
admin.post("/update-status", async (c) => {
  let body: { state?: unknown; message?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const state = body.state;
  if (state !== "no_update" && state !== "error") {
    return c.json({ error: "invalid_state" }, 400);
  }
  setUpdateStatus({
    state,
    message: typeof body.message === "string" ? body.message : undefined,
    at: Date.now(),
  });
  return c.json({ ok: true });
});

/**
 * 폰에서 고른 코드 에이전트 CLI / local_llm 런타임 구성요소가 Mac 에 없을 때, daemon 이
 * 우리 소스의 상수 명령을 실행해 설치한다 — 폰을 떠나지 않고 막힘을 푼다.
 *
 * body:
 *   - { adapterId: string }                → 코드 에이전트 CLI (claude_code/codex/…)
 *   - { component: "llama-server" | "qwen" } → local_llm 런타임 구성요소
 *
 * 보안: 클라이언트는 **어댑터 id / component 키만** 보내고, 실행되는 명령은 오직 registry 의
 * adapter.installHint 또는 LOCAL_LLM_INSTALL_TARGETS 의 **상수** 다 (id → 상수 매핑,
 * install.ts 참고). 임의 셸 명령은 절대 실행하지 않는다. installHint 가 URL (agy 의
 * https://…) 이거나 없으면 «실행 가능한 명령» 이 아니므로 400 `not_installable` — 폰이 기존
 * 링크 안내로 폴백. 알 수 없는 component 키는 400 `unknown_component`.
 *
 * 진행은 fire-and-forget — 이 라우트는 시작 스냅샷만 반환하고, 폰은
 * `GET /api/admin/install-agent/status` 를 폴링해 로그/종료코드를 본다. 성공하면
 * 재탐지로 `GET /api/agents` / `GET /api/local-llm/status` 의 설치 플래그가 갱신돼
 * 폰의 「설정 필요」 가 풀린다.
 *
 * 동시 중복: 같은 대상이면 진행 중 job 에 합류(멱등), 다른 대상이 설치 중이면 409 `busy`.
 */
admin.post("/install-agent", async (c) => {
  let body: { adapterId?: unknown; component?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  // component 경로 — local_llm 런타임 구성요소 (llama-server / qwen). adapterId 불필요.
  const component = typeof body.component === "string" ? body.component : "";
  if (component) {
    const target = getLocalLlmInstallTarget(component);
    if (!target) {
      return c.json({ error: "unknown_component" }, 400);
    }
    try {
      const state = startInstall(target);
      return c.json({ ok: true, ...state });
    } catch (e) {
      const msg = (e as Error).message;
      if (msg === "busy") return c.json({ error: "busy" }, 409);
      return c.json({ error: "install_failed", detail: msg }, 500);
    }
  }
  const adapterId = typeof body.adapterId === "string" ? body.adapterId : "";
  if (!adapterId || !hasAgent(adapterId)) {
    return c.json({ error: "unknown_agent" }, 400);
  }
  const adapter = getAgent(adapterId);
  if (!installHintIsCommand(adapter.installHint)) {
    // URL hint (agy) / hint 없음 — 자동 설치 대상 아님. 폰이 링크 안내로 폴백.
    return c.json(
      { error: "not_installable", installHint: adapter.installHint ?? null },
      400,
    );
  }
  try {
    const state = startAgentInstall(adapter);
    return c.json({ ok: true, ...state });
  } catch (e) {
    const msg = (e as Error).message;
    if (msg === "busy") return c.json({ error: "busy" }, 409);
    if (msg === "not_installable") {
      return c.json({ error: "not_installable" }, 400);
    }
    return c.json({ error: "install_failed", detail: msg }, 500);
  }
});

/**
 * 설치 진행 폴링. 폰이 1s 간격으로 호출해 로그/상태/종료코드를 본다. Tor 회로 전환으로
 * 일시 단절돼도 재연결 후 다시 폴링하면 현재 상태를 그대로 복구한다 (서버는 in-memory
 * 단일 job 상태를 들고 있으므로).
 */
admin.get("/install-agent/status", (c) => {
  return c.json(getAgentInstallProgress());
});
