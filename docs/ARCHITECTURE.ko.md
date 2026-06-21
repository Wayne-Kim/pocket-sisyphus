[English](ARCHITECTURE.md) · **한국어**

# 아키텍처 — 듀얼 채널 전송 + 3개 평면 (전송 / 애플리케이션 / PO)

> 이 문서는 세 층으로 읽는다. **전송·보안 평면**(§1~4, §9~11)이 「폰과 Mac 을 어떻게 안전하게 잇는가」, **애플리케이션 평면**(§12)이 「그 위에서 무엇을 실행하는가」, **결과 평면**(§13)이 「실행 결과를 폰에서 어떻게 보고 조작하는가」, 그리고 **PO 평면**(§14)이 「무엇을 만들지 누가 정하는가」 다.

## 1. 시스템 개요

```
┌──────────────── 사용자 Mac ────────────────┐
│                                             │
│  Pocket Sisyphus.app (메뉴바, Sparkle)       │
│   ├ 설정 창(8탭) · QR 창 · 터미널 미러 창       │
│   └ 권한/전원 관리 + 사일런트 업데이트 브리지     │
│                                             │
│  ┌─ daemon (Node 25 + Hono + WS) ─────────┐ │
│  │ - 127.0.0.1:7777 (API/WS)              │ │
│  │ - 127.0.0.1:7778 (endpoint — onion 전용)│ │
│  │ - PTY runner: claude/agy/codex/shell/   │ │
│  │   local-llm (멀티 에이전트 레지스트리)      │ │
│  │ - SQLite (sessions/messages/cron/        │ │
│  │   workflows/po_*)                       │ │
│  │ - App Attest 검증 게이트                  │ │
│  └─────────────────────────────────────────┘ │
│  ┌─ 자식 프로세스 (daemon spawn) ──────────┐ │
│  │ tor (번들 C tor)  · sshd (OpenSSH portable)│ │
│  │ capture-helper (Swift, 화면 캡처/제어)     │ │
│  │ llama-server (온디맨드 로컬 LLM)           │ │
│  └─────────────────────────────────────────┘ │
│  ┌─ tor sidecar ──────┐ ┌─ embedded sshd ──┐│
│  │ HSPort 80 → 7778    │ │ Listen :22022     ││
│  │ HSPort 22 → 22022   │ │ Pubkey only       ││
│  │ v3 client-auth      │ │ PermitOpen 7777   ││
│  │ single-hop          │ │ +preview proxy    ││
│  └─────────────────────┘ │ ForceCommand false││
│  ┌─ NAT 매핑 (best-effort)┐└──────────────────┘│
│  │ UPnP IGD / NAT-PMP    │                     │
│  │ 외부 IPv4 echo + IPv6  │                     │
│  └────────────────────────┘                    │
└──────────────────────┬──────────────────────────┘
                       │
        ┌──────────────┼──────────────┐
        │ 직접 SSH      │ Tor onion    │
        │ inbound (IPv6 │ (모든 환경    │
        │  /IPv4 UPnP)  │  fallback)   │
        ▼              ▼
┌────────────────────────────────────┐
│ Tor Network (분산 자원봉사 relay)   │
└────────────┬───────────────────────┘
             ▲ outbound
             │
┌────────────┴────────────────────────┐
│             iPhone                   │
│                                      │
│  PocketSisyphus.app (3탭: 백로그/세션/자동화) │
│  ┌─ DeviceAttestor / AttestSession ┐  │
│  │ Secure Enclave P-256 + Face ID  │  │
│  │ 기기 인증 (challenge-response)    │  │
│  └─────────────────────────────────┘  │
│  ┌─ TorManager (in-process) ──────┐   │
│  │ Tor.framework + obfs4 bridge    │   │
│  │ lazy 시작 + §2.4 stop 시퀀스    │   │
│  └─────────────────────────────────┘   │
│  ┌─ EndpointCache (Keychain) ─────┐    │
│  ┌─ SSHClient (Citadel) + host key│    │
│  │  TOFU/strict-pin 검증           │    │
│  └─────────────────────────────────┘    │
│  ┌─ ConnectionManager (happy eyeballs)┐ │
│  └─────────────────────────────────────┘ │
└──────────────────────────────────────┘
```

### 핵심 원칙
- **NEPacketTunnelProvider 익스텐션 제거**. Apple Guideline 5.4 트리거(VPN 앱 분류) 조건 불성립.
- **데이터 plane은 SSH**. 직접 SSH가 닿는 환경에서 latency 10~50ms (Tor data plane 200~800ms 대비 10~50배 빠름).
- **Tor 는 endpoint discovery + SSH fallback 채널**. 메인 앱 프로세스 내 lazy 시작/종료. SSH 직접 채택 시 즉시 stop. DPI 차단 환경에선 obfs4 bridge 로 우회(§2.6).
- **「같은 Wi‑Fi 전용(LAN 전용)」 모드 (opt-in, fail-closed)**. 켜면 폰↔Mac 이 «같은 LAN 일 때만» 사설/링크로컬·mDNS 주소로 직접 SSH 하고, Tor 발견·공인 IP·onion 폴백을 통째로 건너뛰고 거부한다(오프-LAN 이면 명시적 차단 `.offLanBlocked`). 첫 실행에 연결 방식(어디서나(Tor) / 같은 Wi‑Fi 전용)을 고르며, LAN 전용이면 Tor 부트스트랩 자체를 시작하지 않는다(§2.6). daemon 측은 같은 플래그로 비-LAN outbound 를 차단(egress confinement, THREAT_MODEL §5.11).
- **백그라운드 런타임 일체 없음**. APNs/BGAppRefreshTask/BGProcessingTask 영구 미구현. 모든 연결은 포그라운드 진입 시 처음부터 재수립. 실시간 알림은 Discord webhook 으로 위임(§12.6).
- **운영 인프라 0**. Tor 분산 네트워크 + 공개 IP echo (ipify 등) + (선택) Discord/GitHub Pages 같은 «남의 인프라» 만 사용. 메인테이너 서버 0.
- **암호학적 신원 삼중 보장**. ① onion v3 주소 (Ed25519 hash) + ② SSH host key fingerprint (페어링 QR pin + TOFU 장부) + ③ Secure Enclave 기기 인증(App Attest, §2.9).

## 2. 컴포넌트 명세 (전송·보안)

### 2.1 Mac daemon (Node)

| Listener | 포트 | 용도 |
|---|---|---|
| Hono API | `127.0.0.1:7777` | `/api/*` + `/ws` — SSH 채널을 통해서만 접근 |
| Endpoint listener | `127.0.0.1:7778` | `/endpoint` 한 라우트 — Tor onion 으로만 접근 |
| sshd | `0.0.0.0:22022` + `[::]:22022` | OpenSSH portable. direct-tcpip → `127.0.0.1:7777` |
| preview proxy | `127.0.0.1:<고정>` | dev 서버 리버스 프록시 (§13.1). PermitOpen 에 정적 추가 |

- **PTY runner**: 모든 세션은 `node-pty`로 코드 에이전트 CLI 를 spawn. WS가 raw ANSI 청크 + question/exit 이벤트 흘림. `writePtyRaw(sessionId, Buffer)` 는 iOS 의 `pty_input` WS 메시지를 byte 가공 없이 직통 — 한글 multi-byte 손상 없음. 어댑터는 5종(claude_code / agy / codex / shell / local_llm)으로 레지스트리화(§12.1).
- **콜드 진입 페이지네이션 / 화면 스냅샷**(`session_history_v1` / `pty_snapshot_v1`): PTY 출력은 15ms coalesced `pty_chunk` 로 무한 누적돼, 콜드 진입 poll 이 LIMIT 없이 전체를 내려받으면 긴 세션이 Tor 경유 ~5s 로딩됐다. 두 단계로 해소 — ① `GET /:id/poll?limit=N` 콜드 tail 캡 + `GET /:id/messages` 복합 keyset `(created_at,id)` 역방향 히스토리(증분은 `afterCreatedAt` 그대로). ② `GET /:id/pty/snapshot` — 요청 시 최근 tail 을 헤드리스 VT(`@xterm/headless`+`addon-serialize`)로 replay 해 «현재 화면+scrollback» 을 한 덩이로 직렬화 → 비용이 O(청크 바이트 총합) → O(화면). watermark(`throughCreatedAt`) 로 클라이언트가 이후만 증분으로 잇는다(이중 렌더 없음). `pty_chunk` 는 `prunePtyChunks`(onFlush 512회마다, 최신 8000 유지)로 compaction — 모든 reader 윈도우(스냅샷4000/콜드600/catch-up1000)보다 retain 이 커 손실 없음. 옛 daemon 은 limit 무시(전체)·snapshot 404 → iOS 가 tail 캡/폴백으로 회귀 없이 동작. 콜드 WS catch-up 은 `since=0` 이라 skip 되므로 콜드 전체-히스토리 경로는 poll 하나뿐. (`@xterm` 는 CJS — named import 가 tsx 런타임에서 깨져 default import 로 받는다.)
- **`/endpoint` 라우트**(`routes/endpoint.ts`): priority 순 endpoint 배열(`direct_ipv6` p1 / `direct_ipv4` p2 / `tor_onion` p99) + SSH host key fingerprint + ssh_user + daemon_local_port + ttl 300s. iOS 가 happy eyeballs 로 채택.
- **NAT 자동 매핑**: `nat-api` 로 UPnP IGD / NAT-PMP 시도. 외부 IPv4 echo(`ipify`/`ifconfig.me`/`icanhazip` fallback + 5분 캐시). 글로벌 IPv6 가 있으면 매핑 없이 priority 1.
- **App Attest 게이트**: `requireAttestation` 미들웨어가 `/api/*` 보호. WS 도 `?attest=` 쿼리로 검증(§2.9).
- **애플리케이션·결과·PO 평면 모듈**: 멀티 에이전트 / 워크플로우 DAG / 예약(cron) / 로컬 LLM / 라이브 프리뷰 / 화면 캡처·제어 / Discord 알림 / PO 루프 — 전부 같은 daemon 이 호스팅하고 `/api/version` capability 로 soft-gate. 상세는 §12~§14.

### 2.2 Mac 임베디드 sshd

`scripts/embed-daemon-binaries.sh` 가 빌드 시점에 Homebrew OpenSSH portable 바이너리 + 의존 dylib (`libcrypto`, `libssl`) 을 `.app/Contents/Resources/daemon/bin/` 에 박는다. dylibbundler 로 `@executable_path/libs/` 상대 경로 재작성.

**OpenSSH 9.8+ 멀티프로세스 모델**: `sshd` 단독이 아니라 re-exec 헬퍼 `sshd-session` + `sshd-auth` 도 함께 임베드한다(연결마다 권한 분리 프로세스 spawn). 이 둘이 없으면 신버전 sshd 가 부팅하지 못한다.

**sshd_config 화이트리스트** (`mac/daemon/src/ssh/server.ts` 가 동적 생성):
```
HostKey "<영구 ed25519 host key>"
AuthorizedKeysFile "<authorized_keys 동적 관리>"
PasswordAuthentication no
PubkeyAuthentication yes
AllowTcpForwarding local
PermitOpen 127.0.0.1:7777 127.0.0.1:<previewProxyPort>   # direct-tcpip 목적지 화이트리스트
AllowAgentForwarding no
X11Forwarding no
PermitTTY no
ForceCommand /bin/false        # session channel exec/shell 거부
# Subsystem 일체 미등록 (sftp 차단)
```

`direct-tcpip` 만 통과시키고 daemon HTTP/WS 포트(+라이브 프리뷰 고정 프록시 포트)만 노출. dev 포트마다 동적 reload 하지 않고 **고정 프록시 포트 한 줄만 정적 추가**해 엄격 화이트리스트를 유지(§13.1). 페어링 한 번 = 새 ed25519 client keypair 발급, priv는 QR로 폰에 전달, pub은 `authorized_keys` 라인 추가 (`pocket-device:<id>` 코멘트로 revoke 시 식별).

### 2.3 Mac Tor 통합 — 듀얼 HiddenServicePort

```
HiddenServiceNonAnonymousMode 1
HiddenServiceSingleHopMode 1
HiddenServiceDir <hs>
HiddenServicePort 80 127.0.0.1:7778    # endpoint 조회용
HiddenServicePort 22 127.0.0.1:22022   # SSH fallback 채널 — sshd 와 같은 daemon
LongLivedPorts 80,22
MaxCircuitDirtiness 3600               # 회로 1시간 유지
HiddenServiceNumIntroductionPoints 5   # IP 변경 복구 (기본 3)
NumEntryGuards 3
KeepalivePeriod 60
```

같은 onion 주소로 두 가상 포트 노출. v3 client-auth (x25519) 로 디스크립터 복호화 제한 — onion 주소가 누출돼도 폰만 회로 빌드 가능. 회로 안정성 튜닝(introduction point 증설·keepalive)으로 IP 변경/idle 후 재접속 시간을 줄인다.

### 2.4 iOS TorManager (in-process)

**메인 앱 프로세스 내**에서 Tor.framework 직접 운용. NEPacketTunnelProvider 제거됨.

iCepa Tor.framework의 `TORThread`는 프로세스당 1회 시작 가정. 깨끗한 재시작을 위해 stop 시퀀스 빠짐없이:

1. `SIGNAL HALT`
2. `controller.disconnect()` + nil
3. `torThread.cancel()` + nil
4. `<dataDir>/lock` 파일 제거
5. `waitForPortRelease(socksPort)` — TIME_WAIT 해소 대기

**3겹 안전망**: ① 백그라운드 진입 시 stop (`beginBackgroundTask` 30초 안), ② `start()` 직전 stale state cleanup, ③ 강제 종료 시 fresh process 가 자연 해소.

Tor 가 활성인 시점은 **endpoint 조회 + SSH-over-Tor fallback 채택 시만**. 직접 SSH 채택 후엔 `stopAsync()` 호출 → 메모리 절약.

### 2.5 iOS SSHClient (Citadel) + host key 검증

Citadel (swift-nio-ssh wrapper) 기반. NMSSH 의 vendored libcrypto.a 가 Xcode 26 + arm64-sim linker 와 alignment 충돌이라 회피.

- `Citadel.SSHClient.connect(...)` 로 SSH 세션. 인증: ed25519 priv (페어링 QR PKCS8 PEM base64).
- **host key 검증 (구현 완료 — `SSHHostKeyTOFU.swift` `TOFUHostKeyValidator`)**: 모든 SSH 채널을 NIOSSH 표준 fingerprint API 위에서 3단계 우선순위로 검증한다.
  1. **Pinned key** — `cfg.sshHostKey`(공개키 한 줄, QR 의 `ssh_host_key` 필드) 가 있으면 정확 일치 핀(가장 강함).
  2. **신뢰 fingerprint** — 페어링 QR / onion `/endpoint` 가 준 `ssh_host_key_fingerprint` strict 대조.
  3. **순수 TOFU** — anchor 가 전혀 없을 때만 `KnownHostStore`(onion 주소→fingerprint, Keychain 장부) 비교/기록.
  불일치는 `SSHError.hostKeyMismatch` 로 거부해 적대적 LAN/Wi-Fi 의 daemon 가장(MITM)을 차단한다. onion 채널은 Tor 가 이미 신원을 보장하고 같은 host key 를 공유하므로 무해히 통과.
- **Local TCP forwarding**: `NWListener` (`127.0.0.1:<dynamic>`) 띄우고 incoming TCP 마다 `createDirectTCPIPChannel` 호출. `NWConnectionBridge` (ChannelInboundHandler) 가 ByteBuffer 양방향 copy. 라이브 프리뷰는 프록시 포트로 2차 포워딩(`openForward`).

### 2.6 iOS ConnectionManager + Tor bridge

**happy eyeballs**:
```
1. EndpointCache 있으면 endpoint 배열을 priority 순으로 SSH 동시 시도.
   - 직접 IPv6 / IPv4 → 빠른 SSH (10~50ms)
   - Tor onion → SSH-over-Tor (200~800ms)
2. 첫 성공 채택, 나머지 cancel. 직접 채널 채택 시 Tor stop.
3. 모두 실패 → Tor 부팅 → /endpoint 갱신 → 재시도.
```
- `connect()` 멱등(`.running` early return + inflight 디듀프), `reconnect()` transport 실패 회복 경로.

**Tor bridge / pluggable transport (obfs4)** — DPI 가 평문 Tor 를 막는 환경 대비.
- `TorBridgeStore` 가 사용자 입력 bridge line(obfs4/vanilla)을 파싱·영속. iOS 설정 「Tor bridge」(`TorBridgeView`).
- obfs4 PT 는 iOS 가 별도 바이너리 exec 를 막으므로 `IPtProxy`(in-process gomobile lyrebird, `PluggableTransport.swift`)로 돌리고 Tor 에 `ClientTransportPlugin obfs4 socks5 127.0.0.1:<port>` 로 연결.
- **평문 우선·실패 시에만** bridge 경유 재시도 — 미설정 사용자 동작 회귀 없음.

**「같은 Wi‑Fi 전용(LAN 전용)」 모드** (`LanOnlyPolicy` / `ConnectionModePolicy` / `connectLanOnly`) — 사설망 직결·fail-closed.
- **연결 방식 선택**: `ConnectionModePolicy.modeChosen` 이 false 인 동안 `AppRoot` 가 Tor 부트스트랩 «전» 에 `ConnectionModeView` 를 띄워 「어디서나(Tor)」 / 「같은 Wi‑Fi 전용」 중 하나를 고르게 한다(페어 전/후 공통). 미선택 동안 launch `.task` 는 Tor 를 시작하지 않는다. 고르면 `modeChosen` 이 true → `.task(id:)` 재실행으로 연결 시작.
- **LAN 전용 경로**: 켜져 있으면 `ConnectionManager.connectImpl` 이 `connectLanOnly` 로 분기 — `tor.stopAsync()` 후, 페어링 QR 의 `lan_host`(mDNS `<host>.local`) ∪ 캐시된 `direct_lan` 후보«만» 으로 SSH. host key 검증(TOFU/핀)은 직접 채널과 동일하게 적용해 적대적 LAN 의 MITM 을 거부.
- **콜드 부트스트랩**: QR 의 `lan_host`/`ssh_port` 만으로 Tor·`/endpoint` 없이 미페어링 상태에서도 곧장 LAN 페어링이 된다 → Tor 가 막힌 망에서도 페어 가능(미페어링이어도 `AppRoot` 가 `PairView` 직행).
- **fail-closed**: 채택할 LAN 후보가 없거나 전부 실패하면 공인/onion 으로 폴백하지 않고 `.offLanBlocked` 로 명시 차단 — 패킷이 사설망을 벗어나지 않음을 보장. 순수 정책(후보 필터·Tor skip·fail-closed)은 `LanOnlyPolicy` 에 host-less 로 떼어내 `LanOnlyPolicyTests` 가 고정한다.
- daemon 측 짝: 같은 `config.lanOnly` 로 «비-LAN outbound»(공인 IP echo·UPnP·ASC·Discord)를 `egress.ts` 단일 게이트로 차단(egress confinement, THREAT_MODEL §5.11).

### 2.7 iOS ApiClient / WSClient

- base URL: `http://127.0.0.1:<ConnectionManager.currentLocalPort>` (HTTP) / `ws://127.0.0.1:<localPort>/ws`
- Bearer: `cfg.daemonToken`. 추가로 모든 요청에 `X-Client-Version` 헤더(서버 426 강제, §11) + attest 토큰(§2.9).
- transport 실패 1차 → `conn.reconnect()` → 재시도. 2차 실패 → markUnrecoverable.
- **WS 채널**:
  - inbound: `pty_chunk`(PTY raw ANSI), `question`/`exit` 이벤트, `screen_frame`(JPEG)/H.264 바이너리 프레임, 워크플로우/cron/PO 이벤트.
  - outbound: `pty_input`(base64 byte), `pty_resize`, `subscribe`(since= 로 §catchup), 화면 `input_event`/`capture_*`.
  - ping/pong: 30s 주기. pong RTT 를 `ConnectionManager.recordRTT` 에 EMA(α=0.4) 반영 → 「연결 상태」 표시.
  - **catch-up (`ws_catchup_v1`)**: 재연결 시 `subscribe { since }` 로 빠진 `pty_chunk` 를 한 RTT 로 backfill — 폴 사이클을 기다리지 않는다.

### 2.8 페어링 QR (v=3)

```json
{
  "v": 3,
  "onion": "<fp>.onion",
  "onion_auth": "<x25519 priv base32>",
  "endpoint_token": "...",
  "daemon_token": "...",
  "ssh_host_key_fingerprint": "SHA256:...",
  "ssh_host_key": "ssh-ed25519 AAAA... (선택 — 있으면 strict pin)",
  "ssh_client_priv": "<ed25519 PKCS8 PEM, base64>",
  "ssh_user": "<macOS 현재 user>",
  "name": "Wayne's Mac",
  "lan_host": "<mDNS hostname, 예: Waynes-Mac.local> (선택 — LAN 전용 콜드 부트스트랩)",
  "ssh_port": 22022,
  "daemon_port": 7777
}
```

iOS 가 v=3 미만 페이로드 거부 → "Mac 앱 업데이트 후 재페어링" 안내. `ssh_host_key`(공개키 한 줄)는 후행 추가된 선택 필드로, 있으면 §2.5 의 1단계 strict pin 으로 쓰인다(구버전 호환을 위해 optional). `lan_host`/`ssh_port`/`daemon_port` 도 선택 필드로, 「같은 Wi‑Fi 전용」 모드가 Tor·`/endpoint` 없이 QR 한 장으로 LAN 직결 페어링하는 데 쓴다(§2.6).

### 2.9 App Attest — Secure Enclave 기기 인증 (신규)

페어링 토큰만으로는 «토큰을 손에 넣은 누구나» daemon 에 붙을 수 있다. 그 위에 **하드웨어 바운드 기기 인증** 한 겹을 더한다.

- **iOS (`DeviceAttestor` / `AttestSession`)**: Secure Enclave 의 P-256 키쌍 생성(재설치해도 Keychain 에 보존). 페어링 시 공개키(X9.63 uncompressed) + self-signature 를 `/api/attest/register` 로 등록. 이후 `/api/attest/challenge` → nonce 를 SE 키로 서명 → `/api/attest/verify` 로 단기 attest 토큰(HMAC, ~24h) 수령. Face ID/Touch ID 생체 게이트(`LAContext` 재사용으로 등록+검증 한 번의 프롬프트).
- **daemon (`attest.ts` / `routes/attest.ts`)**: nonce 발급(60s TTL·단일 사용) → 등록 공개키로 서명 검증 → HMAC 토큰 발급. `BOOT_HMAC_SECRET` 은 부팅 시 1회 생성 → daemon 재시작 시 모든 attest 토큰 무효화. 공개키는 페어링당 TOFU(`fingerprintForPublicKey` = `SHA256:` 포맷, iOS 와 동일).
- **다중 기기 슬롯**: 기본 1, 사용자 옵션으로 2개까지. `config.ts` 가 레거시 단일 필드를 배열로 정규화.
- **게이트 정책**: 미등록(옛 daemon/옛 폰)은 soft 통과(회귀 0), 로컬 운영자(`X-PS-Local` + `localAdminSecret`)도 통과. 등록된 기기는 attest 토큰 없으면 차단 → iOS 가 `LockView` 로 생체 인증 유도.
- iOS 「보안 상태」(`SecurityStatusView`)·「기기」(`DevicesView`) 화면이 등록 상태·채널·host key 등급·등록 기기 목록을 사람이 읽게 보여준다.

## 3. 트래픽 흐름

### 정상 (직접 SSH 채택)

```
iPhone — 콜드 부팅:
  1) TorManager.startIfNeeded → bootstrap → .running
  2) ConnectionManager.connect — 캐시 endpoint 없음 → /endpoint 조회
  3) Tor 위에서 GET http://<onion>/endpoint
     Response: [direct_ipv6, direct_ipv4, tor_onion] + host key fp + daemon_local_port
  4) Happy eyeballs SSH 시도 — direct_ipv6 채택, host key 3단계 검증 통과
  5) NWListener 127.0.0.1:52073 띄움
  6) Tor stopAsync (직접 채택 → idle)

iPhone 사용 중:
  ApiClient: GET http://127.0.0.1:52073/api/sessions (Bearer + X-Client-Version + attest)
     ↓ NWConnection inbound → NWListener
  Citadel SSHClient.createDirectTCPIPChannel("127.0.0.1", 7777)
     ↓ NWConnectionBridge: ByteBuffer ↔ NWConnection
  SSH transport (TCP outbound, 직접 IPv6/IPv4)
     ↓ Mac sshd (22022) — direct-tcpip channel
  daemon 127.0.0.1:7777 — Hono /api/sessions (Bearer + attest 검증 + 응답)
     ↓ 역경로
```

### Fallback (CGNAT / UPnP 막힌 환경)
direct_ipv6/ipv4 모두 connect timeout → tor_onion 채택. 모든 inbound 가 Tor SOCKS proxy 위 direct-tcpip 로 흐름. Tor 유지. ChatView 상단 banner 로 "Tor 회로로 통신 중(느림)" 안내. DPI 가 평문 Tor 도 막으면 §2.6 obfs4 bridge.

### LAN 전용 (같은 Wi‑Fi 전용 모드)
```
iPhone — 콜드 부팅 (modeChosen=false):
  1) AppRoot 가 Tor 시작 전에 ConnectionModeView 표시 → 「같은 Wi‑Fi 전용」 선택
     → LanOnlyPolicy ON, modeChosen=true (launch .task 재실행 — Tor 부트스트랩 skip)
  2) ConnectionManager.connectLanOnly:
     - tor.stopAsync()
     - 후보 = QR lan_host(<host>.local) ∪ 캐시 direct_lan  (공인/onion 제외)
     - 같은 LAN 이면 사설 주소로 직접 SSH (host key 검증 동일)
  3) 채택 실패/오프-LAN → .offLanBlocked 로 fail-closed (외부 폴백 금지)
```
미페어링 상태에서도 1)에서 「같은 Wi‑Fi 전용」 을 고르면 AppRoot 가 PairView 로 직행, QR 의 lan_host/ssh_port 로 Tor 없이 LAN 페어링한다(§2.6). daemon 은 같은 모드에서 비-LAN outbound 를 차단(§5.11).

### IP 변경 복구
SSH keepalive 실패 → `ApiClient.send` transport 실패 → `reconnect()` 캐시 재시도(옛 IP 실패) → Tor 부팅 → `/endpoint` 새 IP → SSH 재채택. 사용자 시각 1~5초 멈춤 후 자동 복구. Mac `NetworkChangeMonitor` 가 IP 변경 감지 시 daemon 에 SIGHUP.

## 4. 보안 모델

| 위협 | 완화 |
|---|---|
| ISP/통신사 도청 | SSH (forward secrecy, ECDHE) 또는 Tor onion (3홉 암호화) |
| 가짜 daemon 사칭 | `.onion` 주소 = Ed25519 공개키 hash. SSH host key 3단계 검증(pin/fingerprint/TOFU, §2.5) |
| MITM (적대적 LAN/Wi-Fi) | SSH host key 불일치 시 `hostKeyMismatch` 거부. onion v3 cryptographic identity |
| 토큰 유출 (QR/Bearer) | **하드웨어 바운드 기기 인증**(App Attest, §2.9) — 토큰만으론 부족, 등록된 Secure Enclave 키 서명 필요 |
| 폰 분실 | 생체 잠금(`LockView`). Mac 「기기」 창에서 해당 기기 revoke. 메뉴 «페어링 값 바꾸기» 로 일괄 회전 |
| `.onion` 주소 누출 | v3 client-auth (x25519) priv 없는 사람은 디스크립터 복호화 불가 |
| SSH 무차별 대입 | direct-tcpip 만 허용, exec/shell/sftp 거부, password auth off |
| 외부 inbound 차단 (CGNAT) | Tor onion fallback. Tor 자체가 DPI 차단되면 obfs4 bridge(§2.6) |
| 비-LAN outbound 유출 (사내 보안 요구) | **「같은 Wi‑Fi 전용」 모드**(opt-in) — 클라이언트는 사설 주소로만 직결·fail-closed(`connectLanOnly`/`.offLanBlocked`), daemon 은 비-LAN outbound 단일 게이트 차단(`egress.ts`). Tor·공인 IP·onion 미사용(§2.6, THREAT_MODEL §5.11) |
| 변조 DMG (업데이트) | Sparkle EdDSA 서명 검증 — 사일런트 설치도 코어가 위조 거부(§11) |

### 페어링 해제 (revoke)
`routes/admin.ts` 의 `/api/admin/rotate-pairing` 가: ① 새 daemon Bearer 발급, ② 살아있는 WS 끊기, ③ Tor onion 키 + client-auth 키 회전(새 .onion), ④ SSH client keypair 새 발급 + `authorized_keys` 갱신, ⑤ attest 등록 초기화, ⑥ 새 QR PNG 생성. 옛 페어링 즉시 무효. 「기기」 창에서 특정 기기 슬롯만 개별 해제도 가능.

## 5. iOS 앱 설계

### 5.1 스택
- Swift 5.10, SwiftUI, deployment target **iOS 17.0+**. 단일 앱 target, 익스텐션 없음.
- 의존성:
  - `Tor.framework` (CocoaPods, iCepa) — in-process
  - `IPtProxy` (CocoaPods, obfs4pt) — Tor bridge pluggable transport
  - `Citadel` (SwiftPM, swift-nio-ssh) — SSH client (NMSSH 제거)
  - `SwiftTerm` (SwiftPM) — PTY ANSI 렌더
  - `Runestone` + TreeSitter — 코드/diff 하이라이트
  - `WhisperKit` (SwiftPM) — 온디바이스 음성→텍스트(§5.6)
  - `PencilKit` — 캡처 마크업(§13.5)
- 저장: Keychain (페어링 + SE 기기 키 + host key 장부). App Group 없음.

### 5.2 화면 — 3탭 메인
메인은 `MainTabView` 의 **3탭**으로 진화했다(이전 「세션 + 워크플로우」 2탭). 각 탭이 자기 NavigationStack 을 가진다.

1. **백로그 탭** (`BacklogTab` / `BacklogView`) — «1번 탭». PO 루프(§14). `po_loop_v1` + 프로(`.poLoop`) 게이트. 미지원 daemon 이면 숨김.
2. **세션 탭** (`SessionsView`) — 항상 노출(무료). 세션 목록 + 새 세션 시트(동적 에이전트 피커) + 설정/도움말. 워크플로우/cron/PO 가 만든 세션도 여기에 모여 필터로 분리. daemon capability 를 reload 때 끌어와 다른 탭 노출을 결정.
3. **자동화 탭** (`AutomationTab`) — `workflow_v1` 또는 `cron_v1` 중 하나라도 있으면 노출. 안에서 「워크플로우 | 예약」 세그먼트로 묶고 지원 세그먼트만 표시. 프로(`.workflow`) 게이트. 노드/예약 실행 세션을 열면 세션 탭으로 전환하며 deepLink.

앱 진입 흐름(`AppRoot`):
```
연결 방식 미선택(modeChosen=false, 비-DevPairing) → ConnectionModeView  ← Tor 부트스트랩 «전» 게이트
  · 「어디서나(Tor)」 선택 → lanOnly=false → 아래 흐름(Tor)
  · 「같은 Wi‑Fi 전용」 선택 → lanOnly=true → Tor skip, LAN 직결(§2.6/§3)
페어 안 됨 → (LAN 전용이면) PairView 직행 / (어디서나) Tor 상태로 BootView / PairView(QR v=3)
페어 됨   → attest 진행 / 호환성 hard-block 이면 IncompatibleView
          → ConnectionManager.running:
              · attest.needsAuthGate → LockView (생체 인증)
              · 아니면 MainTabView
          → connecting/idle → BootView, failed → ErrorView
```
연결 방식은 launch `.task(id: modeChosen)` 의 게이트라, 고르기 전엔 onion 회로가 전혀 만들어지지 않는다(사용자 요구: «Tor 거치기 전에 묻는다»). 이후엔 설정 「연결·보안」 의 LAN 전용 토글로 자유롭게 전환. **탭 색**: 백로그·자동화 «탭 버튼» 만 pro 주황(alwaysOriginal), 탭 콘텐츠 안 버튼은 기본 accent(보라) — 「색상 토큰 정책」(§12.7) 준수.

### 5.3 Chat 입력 path — 키보드 언어별 분기 (유지)
한글 IME 가 SwiftTerm 의 `UITextInput` 을 거치면 byte cycle 로 화면이 깨진다. 그래서 활성 키보드 언어로 두 path 분기:
- **영문(ASCII)** — `InteractiveTerminalView`(SwiftTerm subclass) first responder, 매 keystroke 즉시 `WSClient.sendPtyInput` 1:1 byte 송신. inputBar 숨김.
- **한글/CJK** — SwiftUI `TextField`(inputBar) first responder, IME markedText 흡수 후 완성 음절 누적 → 「전송」 시 `text + "\r"` 한 번에 송신. SwiftTerm 은 렌더링 전용.

모드 자동 감지(`UITextInputMode.currentInputModeDidChangeNotification` + `primaryLanguage` 검사), first responder 자동 swap, `send` delegate 에 ASCII byte filter, 가상 화살표 누름 시 SwiftTerm 자동 focus.

#### 입력 바이트 추적(KS-TRACE) + 에이전트별 CJK 입력 재현 레시피
입력 경로엔 에이전트별 분기가 없다 — `writePtyRaw(sessionId, Buffer)` 가 모든 어댑터를 동일 취급해 byte 를 가공 없이 PTY 로 흘린다. 그래서 한 어댑터의 CJK/IME 입력 회귀(예: Copilot 추가 시 한글 깨짐)는 «다음 에이전트» 에서도 재발할 수 있다. 이를 양끝 대조로 잡는 진단이 **KS-TRACE** 다.

- **켜기(기본 OFF, 프로덕션 영향 0)** — daemon: `PS_KS_TRACE=1` env 로 데몬 기동. iOS: `PS_KS_TRACE=1` env(Xcode scheme/`simctl launch SIMCTL_CHILD_PS_KS_TRACE`) 또는 `UserDefaults` 키 `PS_KS_TRACE=true`(재빌드 없이).
- **동일 포맷(송신=iOS / 수신=daemon)** — `KSTrace.swift`(iOS) 와 `pty-runner.ts`(daemon)가 1:1:
  ```
  [KS-TRACE] send session=<id> agent=<id> bytes=<n> hex=[xx xx …]   (iOS  sendPtyInput)
  [KS-TRACE] recv session=<id> agent=<id> bytes=<n> hex=[xx xx …]   (daemon writePtyRaw)
  ```
  hex 는 최대 64B(초과분 `+Nmore`). daemon sanitize 가 term-query 응답을 떨궜으면 recv 끝에 `(dropped NB term-response)`. WS 도착 시점(sanitize 전) 은 server 의 `[KS-TRACE] ws-recv` 로 따로 본다.
- **대조** — iOS: `idevicesyslog | grep KS-TRACE`(또는 시뮬레이터 console). daemon: `~/.../logs/unified.log` 에서 `grep KS-TRACE`. 같은 `session`·`bytes`·`hex` 가 `send`→`recv` 로 짝지어지면 정상. byte 가 변형(예: `e5 88 9c` → `c3 a5 c2 88 c2 9c` 이중 인코딩)·유실되면 그 구간이 범인.

**재현 레시피 (어느 에이전트 세션에서든 동일 절차)** — `PS_KS_TRACE` 를 양끝 켜고, 대상 에이전트(claude_code / agy / codex / copilot / opencode / local_llm / shell) 세션에서 한글 IME 키보드로 아래를 차례로 타이핑→전송:
1. **1음절** — `가` → 전송. 입력 박스에 `가` 가 그대로 반영·제출되는지, `send`/`recv` hex 가 UTF-8 3B(`ea b0 80`)로 일치하는지.
2. **다음절** — `안녕하세요` → 전송. 음절이 합쳐진 채(자모 분리·중복 없이) 제출되는지.
3. **이모지** — `안녕👋` → 전송. surrogate/4B UTF-8(`f0 9f 91 8b`)이 손상 없이 흐르는지.
4. **줄바꿈 포함** — 본문 입력 후 Enter(`0d`) → 한 턴 submit. recv 에 `0d` 가 도달하고 turn 이 시작되는지.
각 단계에서 (a) 입력 박스 반영·제출, (b) `send`↔`recv` 바이트 매칭을 둘 다 확인한다. Copilot 수정(브리프 1) 전/후를 같은 레시피로 재현하면 차이가 hex 로 드러난다.

### 5.4 ChatView 상태바·툴바
- **상태바**: git 브랜치 칩(`session_git_branch_v1`) + 변경 N 칩→Diff 시트(`session_git_status_v1`) + 토큰 잔량(`agent_usage_v1`). 가상 화살표/Space/Enter/종료.
- **툴바 버튼**(우상단·도구 그룹):
  - 라이브 프리뷰(`preview_v1`/`v2`, 프로 `.preview`) → `PreviewView` 시트(§13.1).
  - 모니터 미러링(`screen_capture_v1`, 프로 `.monitorMirror`) → `MonitorMirrorView` 풀스크린(§13.3).
  - 「고급 도구」 칩(프로 `.chatTools`, 주황): 브랜치/worktree·파일 탐색·diff·이미지 첨부·세션 알림 음소거 등.
  - 음성 입력 마이크(§5.6).
- **첨부**: 사진첩 이미지(이미지별 요구사항)·파일/라인 참조·미러링 캡처/녹화·화면 피드백(마크업)을 «전송 대기» 로 모아 보낸다(§13.5).
- **옛 «결과» 통합 시트는 폐지** — 웹 미리보기 / 미러 / 산출물을 각각의 진입점으로 분리(미러는 세션 무관 `__desktop__` 합성 id).

### 5.5 음성 입력 (WhisperKit, 신규)
`WhisperSpeechRecognizer`(앱 전역 싱글톤, 모델 1회 로드) + 재사용 컴포넌트(`VoiceDictation.swift`: `DictationMicButton` / `VoiceInputField` / `.voiceDictationChrome()`). 온디바이스 처리 — 음성은 기기 밖으로 안 나가고 모델 가중치만 1회 다운로드·캐시. 한글 포함 전 언어.

### 5.6 백그라운드 정책 (유지)
- 백그라운드 진입 → 모든 연결 종료(SSH + Tor stop). 포그라운드 복귀 → 처음부터 재연결.
- **APNs / BGAppRefreshTask / BGProcessingTask 영구 미구현**. 실시간 알림은 Discord webhook 위임(§12.6).
- `AppLifecycle`: 콜드 런치/60초 미만 짧은 background 는 silent, 60초 이상 long trip 은 `longTripReawake()` 로 각 뷰가 targeted refresh(NavigationStack/입력 보존).

### 5.7 수익화 — 프로(주황) 기능 게이트 + 구독/평생 IAP (전면 개편)
**전체화면 강제 페이월은 폐기**됐다(프리미엄 전환). 기본 앱은 무료, **«주황(Theme.pro) 기능을 탭할 때만»** 보유 여부로 막는다.

- **상품 3종**(`ProductCatalog` SSOT): 월 구독 `…sub.monthly`(₩5,000) · 년 구독 `…sub.yearly`(₩50,000) · 평생 `…lifetime`(₩250,000, 비소모성). 구독은 7일 무료 도입혜택(그룹 `pocketsisyphus.pro` 단위 1회).
- **`ProFeature` 레지스트리**(단일 진실): `workflow / poLoop / cron / monitorMirror / terminal / localLLM / worktree / chatTools / preview`. 프로 기능이면 반드시 이 case 로 태깅하고 `PurchaseStore.gate(_:_:_:)` / `isUnlocked(_:)` 를 거친다 — 진입점이 타입을 요구해 게이트 누락(무료 노출 회귀)을 막는다. 색 정책의 «주황=프로» 와 1:1.
- **`EntitlementDecision.iapEnabled`** 마스터 스위치: false 면 모든 프로 기능 무료 개방 + StoreKit fetch skip(무료 출시 단계). ASC 승인 후 true.
- `EntitlementDecision`/`ProductCatalog` 는 host-less XCTest 로 id·판정을 핀으로 박는다.

## 6. Mac 앱 설계

### 6.1 스택
- Swift 5.10 + SwiftUI, deployment target macOS 13.0+. MenuBarExtra(LSUIElement, Dock 아이콘 없음).
- Sandbox 비활성(`ENABLE_APP_SANDBOX: NO` — §10). Hardened runtime + NodeRuntime entitlements(`cs.allow-jit`/`cs.allow-unsigned-executable-memory`/`cs.disable-library-validation`).

### 6.2 메뉴바 + 창
- **메뉴바 아이콘**(`StatusIcon`): daemon state(stopped/starting/running/failed) 점으로 표시. 사일런트 업데이트 중 파란 다운로드 표시.
- **메뉴 statusBlock**: Onion 주소 / SSH 직접(UPnP 매핑 결과) / SSH onion 채널 상태. UPnP 실패 시 「포트포워딩 가이드」(라우터 페이지 오픈) + 사일런트 업데이트 진행 배너.
- **설정 창**(`SettingsWindow`, 8탭 통합): 로컬 LLM · Discord 알림 · App Store 인증(ASC) · SSH 포트 · 전원 · 권한 · 기기 · 언어.
- **QR 창** — 페어링 v=3 생성/표시/복사 + rotate.
- **터미널 미러 창** — daemon WS `pty_output` 실시간 미러(SwiftTerm) — 폰과 같은 화면.
- **워크플로우 창**(`WorkflowWindow`) — DAG 캔버스 편집/실행(iOS 동등, §12.5).
- Sparkle 인앱 업데이트(§11).

### 6.3 권한·전원 관리 (신규 명시)
- **화면 기록 TCC**(`RemoteControlPermissions`): `CGPreflight/RequestScreenCaptureAccess` + capture-helper 실동작 테스트(`__PS_SCREENPERM__`). capture-helper 의 책임 프로세스가 이 앱이라 앱이 받으면 helper 도 동작(§13.3).
- **손쉬운 사용 TCC**: `AXIsProcessTrusted(WithOptions)` — capture-helper 의 `CGEvent` 입력 주입(원격 제어)용. «보기» 는 자동, «입력 주입» 은 세션별 `control_set` 명시 승인 시만.
- **전체 디스크 접근(FDA, `FullDiskAccess`)**: TCC.db 접근 휴리스틱 + 설정 링크. Sandbox 비활성이라도 daemon 이 Documents/Desktop/iCloud 등 TCC 보호 경로를 만질 때 매번 프롬프트 → FDA 로 일괄 허용.
- **전원(`PowerManager`)**: 잠자기 방지(`IOPMAssertion`, 권한 불필요) + 클램쉘 모드(`pmset disablesleep`, root 필요 → osascript admin). 클램쉘은 켜진 동안 시스템 전체 미잠 → UI 경고.
- daemon stdout 의 `__PS_PERMISSION_REQUEST__ screen|accessibility` 마커 → 권한 탭 자동 열기·강조(15s throttle).

## 7. 구현 단계 (역사 기록)

| Phase | 내용 | 상태 |
|---|---|---|
| P1~P7 | Mac daemon(sshd/Tor 듀얼/`/endpoint`) + iOS in-process Tor + Citadel direct-tcpip + 익스텐션 제거 + Mac UI + ASC 재제출 | ✅ |
| P8 | PTY 실시간 keystroke (WS `pty_input` + 키보드 언어별 분기) | ✅ |
| P9 | 멀티 에이전트(어댑터 레지스트리 + `/api/agents`, `multi_agent_v1`) | ✅ |
| P10 | 예약 작업 (croner 세션 cron + 워크플로우 cron 트리거, `cron_v1`) | ✅ |
| P11 | 워크플로우 (DAG 엔진 + 노드=세션 + result.md + iOS/Mac 캔버스, `workflow_v1`) | ✅ |
| P12 | 로컬 LLM (llama-server 온디맨드 supervisor + Qwen Code, `local_llm_lifecycle_v1`) | ✅ |
| P13 | 결과 평면 (프리뷰/산출물/화면 캡처·제어, §13) | ✅ |
| P14 | SSH host key strict pin + TOFU 장부 (§2.5) | ✅ |
| P15 | App Attest — Secure Enclave 기기 인증 (§2.9) | ✅ |
| P16 | H.264 화면 릴레이 + 시스템 오디오 + 창 스코프 캡처 (§13.3, `screen_h264_v1`/`screen_window_target_v1`) | ✅ |
| P17 | 라이브 프리뷰 v2 — 다중 포트 + 절대 URL 리라이트 (§13.1, `preview_v2`) | ✅ |
| P18 | Discord 알림 + 세션 음소거 (§12.6, `notify_discord_v1`/`session_notify_mute_v1`) | ✅ |
| P19 | 토큰 usage 추적 + 데스크탑 세션 import + git 상태/diff (§12.1, `agent_usage_v1`/`recent_projects_v1`/`session_git_*`) | ✅ |
| P20 | cron terminal — 쉘 스크립트 예약 (§12.5, `cron_terminal_v1`) | ✅ |
| P21 | 사일런트 강제 업데이트 (§11, `silent_update_v1`) | ✅ |
| P22 | Tor bridge / obfs4 (§2.6, `tor_bridge_v1`) | ✅ |
| P23 | 음성 입력 (WhisperKit, §5.5) | ✅ |
| P24 | 수익화 개편 — 프로 기능 게이트 + 구독/평생 (§5.7) | ✅ |
| P25 | bulk session actions — 그룹 일괄 승인/중지 (`bulk_session_actions_v1`) | ✅ |
| P26 | **PO 루프** — 기회 브리프 백로그 (§14, `po_*_v1` 계열) | ✅ |

## 8. 알려진 리스크 / 검증
1. **CGNAT + Tor DPI 차단**: obfs4 bridge(`tor_bridge_v1`)로 평문 실패 시 우회. *남은 한계: bridge 경유는 지연이 커 라이브 프리뷰/미러가 거칠어질 수 있음; 내장 기본 bridge 세트(`TorBridgeStore.builtInObfs4Bridges`)는 회전하므로 메인테이너 갱신 필요; BridgeDB 자동 분배·HTTPS 종단·Mac 측 bridge 는 비-목표.*
2. **Citadel maintainer 1인**: swift-nio-ssh 기반이라 NIO 는 검증됐으나 Citadel 자체 버그는 우리가 직접 fix 가능성.
3. **PTY 모드 한계**: 도구 호출이 ANSI 안에 흐름. 인터랙티브 prompt 감지가 휴리스틱(`agent/pty-*`). 12초 idle 추정이 false-negative(prompt 띄워 놓고도 출력이 12초 안마다 깜빡여 영영 «대기» 로 안 잡힘)로 놓치는 대기는 **사람이 메우는 안전장치**로 보강: daemon 이 세션별 «대기 추정 근거»(마지막 출력 이후 idle·발사된 리마인더 단계)를 폰에 노출(`getPtyAttention`)하고, iOS 가 «조용함 N분» 으로 표면화하며, 사용자가 한 세션을 「다음 정지 시 알림」(`setNotifyNextStop`, `POST /api/sessions/:id/notify-next-stop`)으로 구독하면 그 세션만 4초 임계로 한 번 더 민감하게 잡는다(활성 PTY 한정·1회성, 다음 턴/출력 재개 시 자동 해제).
4. **App Attest 신뢰 모델**: Apple 의 DCAppAttest 가 아니라 «SE 키 자체 TOFU 등록» 방식 — 첫 등록 시점이 신뢰의 닻. 등록 후 키 도난(탈옥 기기 등)은 범위 밖. 다중 기기 슬롯이 늘면 공격면도 늘어 기본 1슬롯.
5. **무인(`skip_permissions`) 워크플로우/PO 노드의 파괴성**: 자동 승인 노드가 `rm`/force-push 등을 사람 확인 없이 실행 가능. 방어 = 노드별 승인 게이트(`requires_approval`) + 워크플로우 결과 폴더 격리 + PO 워크플로우 모드의 강제 사람 게이트(§14.4) + worktree 격리(`po_worktree_v1`).
6. **로컬 LLM 메모리 압박**: 동시 1세션 강제(daemon)로 OOM 방어. 하드웨어 미달 모델 추천 차단(§12.4).

## 9. daemon 의 V8 / 임베드 자식 프로세스

`.app/Contents/Resources/daemon/` 안에 self-contained 트리:
- **Node.js 25.4.0** 공식 darwin-arm64 (버전 고정 — 결정적 빌드).
- **C tor** + 의존 dylib (`libevent`, `libssl`, `libcrypto`, `libscrypt`) + geoip 데이터.
- **OpenSSH portable sshd** + `sshd-session` + `sshd-auth` (9.8+ 멀티프로세스) + dylib.
- **capture-helper** (우리 Swift 코드, 빌드 시 `xcrun swiftc -O` 컴파일 — 화면 캡처/제어).
- llama-server 는 미번들(모델 카탈로그로 온디맨드 — §12.4).
- 핵심 npm 의존: hono · @hono/node-server · better-sqlite3 · croner · node-pty · ws · pino · nat-api.

**자식 프로세스 spawn**: tor · sshd(+세션/auth 헬퍼) · capture-helper · llama-server(온디맨드) · 세션마다 에이전트 CLI(node-pty). V8 JIT(`node`, `claude` CLI) 는 `cs.allow-jit` + `cs.allow-unsigned-executable-memory`. 일반 native(tor/sshd/capture-helper/esbuild)는 hardened runtime 단독 사인. `lifecycle.ts` 가 ppid 모니터링 + self-SIGTERM 으로 orphan(부모 앱 종료 후 남는 daemon/tor/sshd) 방지.

## 10. 배포 모델

iOS = TestFlight(App Store Connect). Mac = Developer ID 사인 + notarized DMG + Sparkle.
MAS 아닌 이유 — daemon 이 사용자 home 임의 repo + `~/.claude/projects` 접근 필요, sandbox 와 본질 충돌.
구체 배포 절차·스크립트·버전 bump 은 메인테이너 전용(이 저장소에 포함되지 않음). 저장소는 공개지만 라이선스는 독점(소스 공개 ≠ 오픈소스이며 상업적 이용을 허가하지 않는다).

## 11. 버전 호환성 핸드셰이크 + 사일런트 업데이트

`mac/daemon/src/version.ts` 가 SSOT. 양쪽이 ① 자기 버전 ② 상대 minVersion ③ capability 집합을 빌드에 박는다.
- iOS 가 부팅 시 `/api/version` 1회 호출 → **Hard**(minVersion 위반): `IncompatibleView` 차단 / **Soft**(capability mismatch): 상단 배너("Mac 앱 업데이트 시 활성화").
- **2차 안전망**: `requireClientVersion` 미들웨어가 모든 `/api/*` 에서 `X-Client-Version` 검사 → min 미만이면 `426 Upgrade Required`. `/api/version` 만 예외(옛 클라가 자기 노후를 학습할 채널).
- capability 명명: 소문자_언더스코어 + `_v숫자`. protocol-broken 변경은 `_v2`로 새 식별자(키 의미 silently 변경 금지).

**사일런트 강제 업데이트 (`silent_update_v1`)**: iOS `/api/admin/trigger-update` → daemon `SIGUSR1` → Mac `UpdaterBridge` 신호 핸들러 → `SilentUpdateUserDriver`(SPUStandardUserDriver 서브클래스) 가 mode 를 `.silent` 로 전환(모든 UI 콜백 no-op, reply 자동 `.install`) → Sparkle 코어가 **EdDSA 검증된** DMG 설치 + relaunch. 진행률은 메뉴 배너 + 메뉴바 파란 점. iOS 는 결과를 `/api/version` 의 `lastUpdate` 로 확인(설치 성공은 daemonVersion ↑ 자체가 신호). 옛 Mac 앱이면 「Mac 화면에서 Sparkle 확인」 폴백.

## 12. 애플리케이션 평면 — 멀티 에이전트 / 워크플로우 / 예약 / 로컬 LLM / 알림

§1~11 이 «전송·보안» 평면이라면 이 절은 그 위 «애플리케이션» 평면이다. 신규 기능은 전부 `/api/version` capability 로 soft-gate — 옛 daemon 에 붙은 폰은 해당 UI 가 «안 보일» 뿐 깨지지 않는다.

### 12.1 에이전트 레지스트리 + 토큰 usage + 데스크탑 세션 import (`multi_agent_v1` / `agent_usage_v1` / `recent_projects_v1`)
- `agent/registry.ts` + `adapters/{claude-code,agy,codex,shell,local-llm}` — 어댑터 5종을 id→adapter 로 등록. 각 어댑터: `displayName / capabilities / resolveBinary / buildSpawnArgs / buildSpawnEnv` (+ 선택 `prepareBackend/releaseBackend` — local_llm 이 llama-server 준비/해제, `desktopWatcher()`, `usage()`).
- `GET /api/agents` → `[{id, displayName, capabilities, installed?, installHint?}]`. iOS·Mac «도구» 피커가 동적으로 그린다 — 새 에이전트 추가에 앱 재빌드 불필요. 미설치 CLI 는 `installed:false` + `installHint`. 옛 daemon 은 claude_code 단일로 흡수(행동 변화 0).
- **토큰 usage (`agent_usage_v1`)**: `GET /api/sessions/:id/usage` — rate-limit 윈도우별 사용률 + 리셋 시각. `agent/usage.ts` 가 60s 캐시로 어댑터 `usage()` 를 감싼다. claude_code 는 Keychain OAuth 로 공식 API(5h/7d 윈도우), codex 는 최신 rollout jsonl 의 `token_count.rate_limits` 스냅샷. shell/agy/local_llm 은 `supported:false`. ChatView 상태바에 잔량 표시.
- **데스크탑 세션 import (`recent_projects_v1`)**: claude_code/codex 어댑터의 `desktopWatcher` 가 `~/.claude/projects/*/<uuid>.jsonl` / `~/.codex/sessions/.../rollout-*.jsonl` 를 FS watch·파싱해 «Mac 에서 직접 돌던 세션» 을 폰에서 이어받게 한다(`--resume`/`resume` subcommand). `GET /api/recent-projects`(최근 cwd) + `GET /api/agents/<id>/desktop-sessions`(이어받기 후보).
- **새 어댑터 추가 체크리스트(필수)**: `displayName/capabilities/resolveBinary/buildSpawnArgs/buildSpawnEnv` 구현·registry 등록 외에, **CJK 입력 재현 레시피(§5.3)를 통과해야 한다** — `writePtyRaw` 는 모든 어댑터를 동일 취급하지만 각 CLI(특히 Ink 기반)의 IME/CJK 입력 처리는 제각각이라 회귀가 어댑터별로 새로 터질 수 있다. `PS_KS_TRACE=1` 로 양끝(KS-TRACE send/recv)을 켜고 한글 1음절/다음절/이모지/줄바꿈을 타이핑→전송해 (a) 입력 박스 반영·제출, (b) 송신 바이트 = PTY write 바이트 매칭을 확인한 뒤에야 어댑터를 «지원» 으로 노출한다.

### 12.2 워크플로우 엔진 (`workflow_v1`)
파일: `workflow/{types,store,engine,task-folder,triggers}.ts`.
- **정의**: `nodes`(start/task/end) + `edges`(조건 없는 «성공·순차» 또는 `condition:"fail"` 경로) + start 노드 `triggers`(manual·cron·github). JSON 으로 `workflows` 테이블 저장(캔버스 x/y 포함). 옛 `general`/`test` 노드 종류는 `task` 로 정규화.
- **실행**(`engine.ts`): 시작 시 정의를 `def_snapshot` 으로 동결 → 위상정렬해 start 부터 pump. **task 노드마다 세션 1개 spawn**(세션 탭/딥링크로 열람). 노드 완료 = idle 감지 또는 result.md 기록 또는 하드 타임아웃.
- **결과 전달**: `.posiworkflow/<wf슬러그>--<wfId8>/<YYYYMMDD-HHMMSS>--<runId8>/<노드슬러그>--<nodeRunId8>/`. run 폴더 `_run.json` 매니페스트로 DB 없이 식별. 각 노드가 `result.md`(+선택 `verdict.json` pass/fail) 에 쓰고 다음 노드가 프롬프트로 이어받음.
- **분기·루프**: 노드 결과 `branches.json` 으로 동적 자식 생성. `MAX_NODES=200` · `MAX_DEPTH=8` · `MAX_ITERATIONS=10` 상한. 「실패」 엣지가 조상으로 돌아가면 루프 — fail 엣지 제외 전진 그래프 도달성으로 순환 판정해 fail 엣지로만 허용.
- **노드 상태**: pending →(requires_approval 면) awaiting_approval → running → done/failed/needs_attention, dead-path 는 skipped. awaiting_approval·needs_attention 은 `pending` map 에 action handler 를 두고 사용자 결정 대기.
- **취소/재시작**: `cancelWorkflowRun`(cancelled 플래그 + 큐 비움 + PTY graceful abort → 남은 노드 skipped). daemon 재시작 시 떠 있던 running 은 failed 로 reconcile(이어가기 없음).
- **DB**: `workflows` / `workflow_runs`(def_snapshot·status·trigger_kind) / `workflow_node_runs`(def_node_id·parent·session_id·status·verdict·iteration·x/y) / `workflow_triggers`.
- **라우트**: `GET/POST /api/workflows`, `GET/PUT/DELETE /:id`, `POST /:id/run`, `GET /runs/:id`(캔버스 폴링), `POST /runs/:id/cancel`, `POST /runs/:id/nodes/:nid/:action`(approve/reject/complete/retry).

### 12.3 예약 작업 (`cron_v1` / `cron_terminal_v1`)
- **세션 기반 cron**: `cron/{scheduler,executor,store,registry}.ts`. `croner` 로 5필드 cron + IANA tz. tick 마다 지정 agent+repo 로 세션 1개 만들어 1회 실행 후 종료. `session_mode`(fresh/continue, continue 면 `last_session_id` SDK 세션 이어받기) · `overlap_policy` · `catch_up` · `skip_permissions`.
- **터미널 cron (`cron_terminal_v1`)**: `kind='terminal'` — 에이전트 대신 «쉘 스크립트 파일» 을 인터프리터(zsh/bash/sh login shell `-l`)로 1회 실행. `cron/terminal.ts` 가 `resolveScriptFile`(~ 확장·절대경로 강제·존재 확인)·`normalizeShell`·`buildScriptSpawnArgs`. 결과 세션은 남기지 않음(로그만). `cron_jobs.kind/shell/script` 컬럼.
- **워크플로우 트리거(cron·github)**: start 노드 `triggers` 를 `workflow_triggers` 로 reconcile. cron 은 croner tick 에서 `startWorkflowRun(wf,'cron')`. github 는 공개 webhook 없어 폴 기반(`git ls-remote`, 폴 하한 60s) — 마지막 SHA 변하면 발화. manual 은 등록 없이 iOS 「실행」 이 `POST /run`.
- iOS 노출: 세션 cron 과 워크플로우 트리거는 **자동화 탭**의 「예약」 세그먼트 + 워크플로우 노드 인스펙터.

### 12.4 로컬 LLM (Qwen Code + llama-server, `local_llm_lifecycle_v1`)
- `local-llm/{supervisor,paths,catalog,download,hardware,status,events,resolve-llama-server}.ts` + `agent/adapters/local-llm`. 단일 llama-server(고정 포트, parallel=1) **온디맨드**: /health adopt / 죽었으면 spawn / 외부 점유면 에러. 우리가 띄운 것만 graceful stop + 비정상 종료 시 지수 백오프(1s→30s) 재시작.
- **하드웨어 추천(`hardware.ts`)**: `detectHardware()`(총 RAM·chip·gpu cores) + `recommendModel()` — 모델별 estRss/RAM 예산으로 「추천」(≤0.70 & ≥recommendedRam) / 「허용」(≥minRam & ≤0.85) 판정. 미달이면 추천 차단.
- **카탈로그/다운로드**: Qwen Code 여러 크기(`{fileName, estRssBytes, recommendedRamBytes, minRamBytes, ctxNative, ...}`). ctx > native 시 YaRN rope scaling. `GET /api/local-llm/{status,models,hardware}` + 다운로드.
- 메모리 압박 → **동시 로컬 LLM 세션 1개**(daemon 강제, 앱이 먼저 차단). 어댑터는 OpenAI 호환(`OPENAI_BASE_URL=…/v1`)으로 Qwen Code CLI 연결.

### 12.5 캔버스 UI (iOS · Mac)
- **iOS**: 자동화 탭 「워크플로우」 세그먼트 = 목록(`WorkflowListView`) → 편집기(`WorkflowEditorView`: 노드 추가·드래그·포트 연결·인스펙터·저장) → 실행 뷰어(`WorkflowCanvasView`: 읽기전용 + 폴링) + `WorkflowRunLoaderView`(딥링크 착지). 편집 캔버스: 진입 시 auto-fit, 빈 영역 길게 눌러 노드 추가, 드래그=팬·핀치=줌.
- **Mac**: `WorkflowWindow` — 좌 사이드바(목록 CRUD) + 우 캔버스(`runState` 로 편집/실행 전환). 사이드바 선택은 `.id(workflow.id)` 로 캔버스 재생성. 두 손가락 스크롤=팬, 한 손 드래그=마퀴 선택.
- 노드 종류색: iOS `editorTypeColor` / Mac `wfTypeColor` 가 같은 약속(시작 초록·작업 분홍·종료 파랑) → §12.7.

### 12.6 Discord 알림 (`notify_discord_v1` / `session_notify_mute_v1`)
백그라운드 런타임 0 원칙(§1)의 답 — 실시간 푸시를 **사용자 본인 Discord webhook** 에 위임한다(외부서버 0: URL 만 알면 Discord 인프라가 전달 대행).
- `notify/{index,discord,preview}.ts`. 보내는 이벤트: `turn_complete` · `still_waiting`(10/30/60분 reminder chain) · `session_exit` · `error` (이상 4종은 **away-gate** — 실시간 시청자 없을 때만) · `cron_complete`/`cron_failed` · `po_briefs`/`po_failed`/`po_gate`(무인이라 away-gate 무시) · `test`.
- `notify/preview.ts` 가 에이전트 출력 tail 에서 의미있는 한~두 줄 추출. 딥링크는 GitHub Pages 정적 브리지(`…/open/#<sessionId>` → `pocketsisyphus://…`, Discord 가 커스텀 scheme 직접 링크를 막아서).
- **세션 음소거(`session_notify_mute_v1`)**: `PATCH /api/sessions/:id { notifyMuted }` + `sessions.notify_muted`. 여러 세션 동시 굴릴 때 시끄러운 세션만 끄는 ChatView bell 토글.
- 설정은 Mac 설정 창 「알림」 탭. `GET/POST /api/notify/config` + `POST /api/notify/test`.

### 12.7 색상/디자인 토큰 정책
의미 기반 색 토큰. SSOT 는 iOS `DesignSystem/DesignTokens.swift` 의 `Theme`(맨 위 「색상 정책」 주석), Mac 은 별도 Theme 없이 같은 약속을 리터럴로 따른다. 핵심: **warning=노랑(진짜 경고 전용)** 과 **pro=주황(프로/프리미엄/고급 강조)** 을 의미가 다른 토큰으로 분리(혼동 금지). 주황은 백로그·자동화 «탭 버튼»·예약·터미널/로컬 LLM 도구·채팅 도구 칩·미러링 진입 등에 쓴다(탭 «안» 일반 버튼은 기본 accent 그대로). 자세한 규칙은 `CLAUDE.md` 「색상 토큰 정책」.

## 13. 결과 평면 — 라이브 미리보기 / 산출물 / 화면 캡처·제어

§12 가 «무엇을 실행하는가» 라면 이 절은 «실행 결과를 폰에서 어떻게 보고 조작하는가» 다. 전부 `/api/version` capability soft-gate. **옛 «결과» 통합 시트(웹/화면/산출물 세그먼트)는 폐지** — 각 기능을 독립 진입점으로 분리했다(§5.4).

### 13.1 라이브 웹 미리보기 (`preview_v1`, 절대 URL·다중 포트는 `preview_v2`)
- **감지**(`preview/{detect,registry}.ts`): 세션 PTY 출력에서 loopback dev URL 파싱(ANSI strip + 원격 URL false-positive 필터).
- **전송**: dev 포트를 폰에 직접 노출하지 않는다. daemon 이 **고정 포트 리버스 프록시**(`preview/proxy.ts`, HTTP+WS 패스스루)로 활성 세션 dev 서버를 root-origin 중계. sshd `PermitOpen` 에 그 **고정 프록시 포트 한 줄만 정적 추가**(§2.2).
- **iOS**(`PreviewView`): `SSHClient.openForward` 로 프록시 포트에 2차 포워딩 → `WKWebView` 가 `http://127.0.0.1:<fwd>/` 로드. **WKWebView 가 실제 DOM 이라 보기=조작**. 라우트 `GET /api/preview/:id`, `.../enable`·`/disable`, `POST /api/preview/ports`.
- **`preview_v2`(`preview/rewrite.ts`)**: 실무 Next.js/Vite 풀스택이 절대 URL 자산·별도 포트 API/HMR 을 쓰는 문제를 푼다.
  - **다중 포트**: `POST /api/preview/ports` 배치 등록 → 쿠키 활성 셋(`<sid>~<주포트>~<p1,p2,...>`). 주포트는 root, 보조는 `/__psport__/<port>/...`. **미등록 포트는 어디서도 통과 안 함**(활성 셋 ∩ 등록부 둘 다 통과해야 forward).
  - **리라이트**: `PreviewRewriteStream`(청크 경계 안전)이 «등록된» loopback 절대 URL 만 프록시 경로로. HTTP(S)는 정적 치환, WS(S)는 정적 치환 불가라 `<head>` 에 WebSocket shim 1회 주입(런타임 host 치환). 압축 응답은 Accept-Encoding 떼 uncompressed 로 받아 리라이트. 외부 도메인·미등록 포트·문자열 결합 HTTP URL 은 비변형(비-목표).

### 13.2 산출물 뷰어 (`artifacts_v1`)
- `GET /api/sessions/:id/artifacts` 가 repo 를 재귀 walk(node_modules/.git/빌드 제외, depth/visited 상한)해 렌더 가능 파일을 종류 분류 + mtime 내림차순. `GET .../fs/raw` 가 raw 바이트 스트리밍(`resolveRepoRelative` 경로 보안 재사용).
- iOS `ArtifactsView` 가 폴더 드릴다운 + raw 를 temp 로 받아 **QuickLook** 렌더(이미지·PDF·Office·USDZ·동영상·오디오). 포그라운드 전용 한계의 답(«자리 비운 동안» 산출물은 파일로 남음).

### 13.3 네이티브 화면 캡처 + 원격 제어 (`screen_capture_v1` / `screen_h264_v1` / `screen_shot_v1` / `screen_window_target_v1` / `remote_control_v1`)
**번들 Swift 헬퍼**(`mac/daemon/helper/capture-helper.swift`)가 tor/sshd 처럼 daemon 자식으로 spawn. daemon `capture/sidecar.ts` 가 데이터 허브.
- **캡처 코덱**: 기본은 두 가지 — **JPEG**(`CGDisplayCreateImage` 주기 캡처, stdout 길이-prefix) 또는 **H.264(`screen_h264_v1`)**: `SCStream`(ScreenCaptureKit) → VideoToolbox H.264 + 시스템 오디오 AAC 를 바이너리 WS 로 릴레이(타입 1 SPS/PPS·2 access unit·3 AAC config·4 AAC packet). 델타 인코딩이라 같은 대역폭에 fps 가 높다(2fps JPEG → 12fps H.264). iOS `H264Decoder`(AVSampleBufferDisplayLayer, GPU 디코드)가 렌더. 미지원 daemon 은 jpeg 폴백(soft).
- **backpressure 적응**: SSH 채널 `bufferedAmount` 를 4Hz(250ms) 폴링해 fps/bitrate 동적 조절.
- **원샷 캡처(`screen_shot_v1`)**: `GET /api/screen/shot?display=N&window=ID` — `screencapture(1)` 원샷 JPEG. 라이브 H.264 가 GPU 직행이라 정지 프레임 추출이 안 되므로, «캡처/녹화 → 채팅 첨부»(버그 재현 전달)는 이 원샷이 데이터원.
- **창 스코프 캡처(`screen_window_target_v1`)**: 헬퍼가 화면 창 목록(`onScreenWindows`, z-order 최대 24개)을 보고하고(`capture_list_windows`→`capture_windows`), iOS 미러링 더보기 «캡처 대상» 피커가 `capture_set_window` 로 고르면 `SCContentFilter(desktopIndependentWindow:)` 로 그 창만 인코딩(대역폭·프라이버시 상류 해법). 창 리사이즈는 1s 폴링이 스트림 재구성, 창이 닫히면 전체 화면 폴백 + `capture_target(reason=window_closed)` → iOS 캡슐 안내.
- **원격 제어(`remote_control_v1`)**: iOS 제스처 → WS `input_event` → 헬퍼 stdin JSON → `CGEvent` 주입(마우스/스크롤/키/한글 Unicode). 좌표는 0..1 정규화 → 헬퍼가 `CGDisplayBounds` 환산(Retina 흡수). **보안 게이트**: 캡처(보기)는 화면 기록 TCC 만, **입력 주입(조작)은 세션별 «제어 허용»(`controlEnabled` Set)을 명시적으로 켠 경우에만**(`setControlEnabled`→`control_set`) — 손쉬운 사용 TCC 별도. axPerm 미부여 시 `control_status(reason=accessibility_permission)` → iOS 「조작 막힘」 캡슐. 단일 활성 캡처 + 시청자 없으면 헬퍼 자동 종료.
- iOS 진입: `MonitorMirrorView`(세션 무관 `__desktop__` 합성 id, 세션 목록·ChatView 양쪽) → `RemoteScreenView`(+`ZoomableScreenView`).

### 13.4 미구현/후속
TCC 권한 attribution(daemon-spawn 헬퍼의 책임 프로세스) 실기기 검증 후속. 다중 창 동시 송출·창 자동 추적 고도화는 비-목표. Tor fallback 환경의 영상 부드러움·실시간 제어 지연은 원천적 한계. 라이브 프리뷰의 런타임 동적 생성 HTTP URL 완전 포착·외부 도메인 프록시·HTTPS 종단은 비-목표.

### 13.5 캡처/프리뷰 → 채팅 첨부 + 마크업 (신규)
캡처한 화면을 그냥 보는 데서 멈추지 않고 «버그 리포트» 로 채팅에 흘린다.
- `PreviewFeedbackSheet` — 단발 캡처(프리뷰 DOM / 화면) + **PencilKit 자유 그리기(마크업)** + 한 줄 코멘트. `.ps-preview-feedback`/`.ps-screen-feedback` temp → `FileReferenceDraft` 로 채팅 «전송 대기» 플럼빙 재사용.
- `AttachmentSheet` / `AttachmentAnnotationEditor` — 첨부 이미지별 펜 획·블러 영역(찍힌 뒤 가리기)·되돌리기 + 이미지별 요구사항 + 미러링 녹화 단계 프레임용 「전체 요청」 입력란. `AttachmentDraft`(annotations/baseImage/baseData)로 주석 편집 복구.

## 14. PO 평면 — product-owner / 기회 브리프 백로그 (`po_*_v1`)

§12~13 이 «어떻게 만들고 결과를 보는가» 라면, 이 절은 «무엇을 만들지 누가 정하는가» 다. 사람의 역할을 «생산» 에서 «결재» 로 줄인다 — 에이전트가 신호를 모아 기회 브리프를 쓰고, 사람은 백로그 탭에서 승인/보류/기각만 한다. iOS **「백로그」 탭(1번 탭)**, daemon `po/{executor,prompt,asc,crash,gh,scheduler,workflow-exec}.ts` + `routes/po.ts`.

### 14.1 루프 (신호 → 브리프 → 결재 → 구현 → 검증)
```
1) 수집(startPoCollection) — 신호 fetch → 에이전트가 종합
2) 인제스트(ingestBriefs) — 근거 필수 검증 → po_briefs(status=proposed)
3) 결재 — iOS 백로그에서 승인/보류(held)/기각(rejected)
4) 구현 — 승인 시 세션/worktree/워크플로우 모드로 spawn (running)
5) 출시(watchExecForShipped) — 구현 첫 turn 정착 시 자동 shipped
6) 검증(ingestVerdicts) — 다음 수집 사이클이 가설 적중 판정(verified/missed)
```
모든 브리프는 **근거(evidence) 배열 필수**(imaginary 제안 금지) — 원문(이슈·파일:라인·리뷰 id) 역추적 가능. impact/effort 1~5 정수, `score = round(impact/effort*100)/100`. 제목 중복(살아있는 proposed/held/running 기준) 방지.

### 14.2 신호 소스
- **GitHub(`po_gh_check_v1`, `po/gh.ts`)**: 수집 직전 `gh --version` + `gh auth status` + GitHub 원격 여부 프로브 → `{gh:{githubRemote,installed,authed}}`. 열린 이슈/Discussions/닫힌 이슈 후속 코멘트. 불확실은 null(거짓 「설정 필요」 금지), 확정 음성만 iOS 안내(brew install gh / gh auth login). 점검 실패는 수집을 막지 않음(GitHub 신호만 0건).
- **레포 내부**: `docs/todo-*.md` 미완료, TODO/FIXME/HACK 주석(grep), README 로드맵, `git log` 최근 방향.
- **App Store 리뷰(`po_asc_v1`, `po/asc.ts`)**: `po_profiles.asc_app_id` 켠 레포만. ASC API(ES256 JWT, p8 키는 Mac config.json 0600 에만 — QR/폰에 안 들어감) → 최신 리뷰 ≤50건. evidence kind `asc_review`.
- **크래시(`po_crash_v1`, `po/crash.ts`)**: 같은 ASC 키 재사용 → Analytics 「App Crashes」 보고서(ONGOING→Daily→gzip CSV/TSV) 7일 집계(버전·디바이스 그룹 상위 25). evidence kind `crash`. 서드파티 SDK 없음.

### 14.3 프로필 + 주기 수집 + 검증 (`po_schedule_v1`)
- `po_profiles`(repo_path PK · directive 조사방식 · schedule 5필드 cron · asc_app_id). `GET/PUT /api/po/profile`.
- **PoScheduler**(`po/scheduler.ts`): schedule 있는 레포를 croner 등록(repo_path 키). overlap=skip 고정(진행 중이면 tick 생략), catch-up 없음(깨자마자 폭주 방지). 콜백마다 최신 프로필 재조회.
- **출시 후 검증**: shipped 브리프를 다음 수집 프롬프트에 「검증」 섹션으로 실어 가설 대조 — 이슈 닫힘·커밋·같은 불만 신호 부재면 `verified`, 여전하면 `missed`, 근거 부족이면 판정 보류(다음 사이클 재시도). `verify_note` 기록.

### 14.4 승인 모드 (`po_worktree_v1` / `po_workflow_v1` / `po_agent_v1`)
`POST /api/po/briefs/:id/decide { action, mode?, useWorktree?, agent? }`:
| 모드 | 실행 | 격리 | 사람 게이트 |
|---|---|---|---|
| **session**(기본) | 일반 구현 세션 1개 + watchExecForShipped | 없음 | 없음 |
| **workflow**(`po_workflow_v1`) | 설계 에이전트가 브리프 맞춤 DAG(스펙→구현→자가검증→게이트) 생성 → `sanitizeDesignedDef`(화이트리스트) + `ensureHumanGate`(사람 승인 게이트 강제 삽입) + validateDef → run. 게이트 도달 시 `po_gate` 알림 + `workflow/<runId>` 딥링크. 실패 시 4노드 템플릿 폴백 | 없음 | **필수(자동 삽입)** |
| **useWorktree**(`po_worktree_v1`) | `po/<id8>` 브랜치 새 worktree 에서 구현(동시 세션 작업트리 충돌 방지) | 있음 | session/workflow 와 결합 |

- **에이전트 선택(`po_agent_v1`)**: collect/research/decide/cleanup body 의 `agent` — 누가 수집/리서치/구현/정리를 돌릴지(생략 시 claude_code, 무인이라 `cron_eligible` 필수). 옛 daemon 은 필드를 버려 항상 claude_code → iOS 가 capability 없으면 픽커를 숨긴다(거짓 UI 방지).

> **⚠️ 회귀 주의 — «에이전트 선택 누락» (3회+ 반복된 버그)**
> 에이전트 세션을 spawn 하는 진입점이 «하나라도» `agent` 를 안 실어 보내면, 사용자가 어떤 도구를 골라도 무시되고 항상 claude_code 로 돈다. 같은 종류의 누락이 여러 번 재발한 이력이 있다(예: shipped 의 «지금 수집해 검증하기» = collect 인데 agent 미전달, rejected 의 «코드 흔적 정리» = cleanup 인데 agent 미전달 → 둘 다 2026-06 수정). 새/기존 진입점을 만질 땐 아래를 **반드시** 점검한다.
>
> **체크리스트 — collect/research/decide/cleanup 을 호출하는 «모든» iOS 진입점**:
> 1. 호출에 `agent:` 인자를 싣는가? (`agents.isEmpty ? nil : execAgentId` 패턴 — 픽커 미노출/옛 daemon 은 nil 로 두어 claude_code 폴백)
> 2. 그 화면에 `PoAgentSection`(또는 동등 픽커)이 «노출» 되는가? `decidable` 같은 한 상태에만 픽커를 달면 다른 상태(shipped/rejected)의 액션은 선택 UI 가 없다 — 액션이 보이는 모든 상태에 픽커가 따라와야 한다.
> 3. 선택값은 `po.brief.lastAgentId`(@AppStorage `execAgentId`) 를 공유해 브리프 전역에서 한 도구로 일관되게(매번 같은 도구로 도는 흐름 한 탭 단축).
> 4. daemon `routes/po.ts` 의 해당 핸들러가 `agent` 를 읽어 세션 spawn 에 넘기는지 확인(iOS 만 고치고 daemon 이 버리면 무음 실패).
>
> 현재 iOS 진입점(`ios/.../Views/BacklogView.swift`): `startCollect`/`startVerifyCollect`(collect) · `startResearch`(research) · `decide("approve")`(decide) · `cleanup`/`rejectAndCleanup`(cleanup) — 전부 위 패턴을 따른다.

### 14.5 리서치 · 수정 · 기각 정리 · 통계
- **리서치**(`POST /api/po/research`): 내부 신호만으론 «완전히 새로운 일» 근거가 없다는 한계의 답 — 에이전트가 웹+레포 조사(모든 주장 출처 URL 필수) → 보고서(`po_research.report` markdown) + 브리프(evidence 에 web/market 최소 1). 0건도 정답(«하지 말 것»). 성공 시 세션 자동 제거(보고서가 영구 산출물).
- **수정 지시**(`POST /briefs/:id/revise`): proposed/held 브리프를 한 줄 코멘트로 재종합(스토리 다듬기).
- **기각 정리(`po_cleanup_v1`, `POST /briefs/:id/cleanup`)**: 기각된 아이디어의 신호원(TODO/FIXME 주석·죽은 코드)을 제거해 다음 수집의 같은 제안 반복을 막는다(중복 체크는 살아있는 제목만 본다). 커밋 없이 작업 트리에만 — 사용자 검토 몫. `po_briefs.cleanup_session_id` 진입점.
- **통계(`po_stats_v1`, `GET /api/po/stats`)**: 레포별/전체 제안 수·승인율·shipped·verified/missed·결재 중앙값 시간. 백로그 상단 성적표 카드 — 에이전트 정확성을 수치로 보여 신뢰 콜드스타트를 데이터로 푼다.

### 14.6 DB + 라우트 + iOS 노출
- **DB**: `po_briefs`(title·problem·evidence·impact·effort·score·scope·spec·status·decided_at·collect/exec/revising/cleanup_session_id·research_id·exec_workflow_id·exec_run_id·verify_note) / `po_profiles` / `po_research`. 상태: proposed → held / rejected / approved → running → shipped → verified / missed.
- **라우트**(`routes/po.ts`): `GET /briefs`·`/stats`, `POST /collect`(async ingest)·`/briefs/:id/decide`·`/cleanup`·`/revise`, `DELETE /briefs/:id`, `GET/POST/DELETE /research(/:id)`, `GET/PUT /profile`, `GET/PUT/DELETE /asc-key` + `/asc-key/verify`.
- **iOS `BacklogView`**: 성적표 카드(`po_stats_v1`) · 프로젝트 필터 · 진행/GitHub 안내 배너(`po_gh_check_v1`) · 리서치 · 결재 대기(proposed, score 정렬) · 진행 중(running, session 탭/workflow 상세) · 출시됨 · 처리됨 섹션. 「만들기」 = 레포 수집 / 리서치 요청. 모든 하위 기능은 capability + 프로(`.poLoop`) soft-gate. 딥링크 `pocketsisyphus://backlog`(새 브리프) · `…/workflow/<runId>`(머지 승인 대기).

### 14.7 브리프 가독성 게이트 (`readability.ts` ↔ `po-brief-readability-lint.sh`)
시각 디자인(`design-lint`)·중복(dedup / `similarity.ts`)엔 자동 게이트가 있는데 «이해 가능성» 엔 없었다 — 그래서 수집 프롬프트를 평이하게 고쳐도 보정 앵커(§14.3 과거 결정 요약)와 모델 드리프트로 제목이 다시 «빽빽» 해진다(파일경로·코드심볼·«—» 다중 절이 제목/problem 으로 샌다). 이 게이트가 그 마지막 그물이다 — 다른 린트와 같은 톤(«후보 표면화»; 최종 판정은 사람):
- **휴리스틱(R1–R4, 결정적)**: R1 제목 80자 초과 · R2 제목에 파일경로(`.ts/.swift/.sh…`) 또는 SCREAMING_SNAKE 심볼 · R3 «—»(em/en-dash)로 잇는 절 3개 이상 · R4 `problem` 첫 줄이 코드 참조/심볼(백틱·`file:line`·SCREAMING_SNAKE·점-멤버)로 시작. URL·이슈번호·약어(Tor·SSH·API…)는 화이트리스트로 거짓양성을 줄인다. UI/비-UI(daemon·네트워크·CLI) 브리프에 동일 적용 — 제목·요약 가독성이지 **디자인 토큰 검사가 아니다**.
- **두 미러**: `mac/daemon/src/persona/readability.ts` 가 런타임 측 — `ingestBriefs` 가 이를 **소프트** 신호로 돌린다(후보를 로깅, 브리프는 버리지 않음; 기존 200자 하드 cap 보존 — 로깅/표면화일 뿐 하드 reject·자동 재작성이 아님). `scripts/po-brief-readability-lint.sh`(bash + Python, 노드/빌드 불필요)는 CI/수동 측 — 산출 브리프 배열 JSON(경로 인자 또는 stdin)을 받아 후보를 띄운다. 양쪽을 테스트로 고정(`readability.test.ts` ↔ `scripts/test-po-brief-readability-lint.sh`)해 규칙 드리프트를 막는다 — iOS↔Mac `Theme` 미러와 같은 규율.
- **80 vs 200 정렬**: 수집 프롬프트가 모든 10개 로케일에서 «80자 이내» 를 선언한다. `readability.TITLE_ADVISORY_MAX = 80` 이 그 코드측 SSOT(게이트가 소프트로 강제하는 권고 한계)다. `executor` 의 `str(title, 200)` 은 하드 DB-안전 백스톱이지 선언이 아니다 — 둘은 목적이 달라 공존하며, `readability.test.ts` 가 둘을 못박아(상수 == 80 **그리고** 모든 로케일 title 스키마가 80 선언) 다시 말없이 어긋나지 않게 한다.
- **CI**: `scripts/test-po-brief-readability-lint.sh` 가 린트 게이트 워크플로우(`.github/workflows/i18n.yml`)에서 i18n-lint · doc-pair-lint 와 나란히 차단 게이트로 돈다(검출 로직을 차단으로 고정 — 린트 자체는 ingest/수동 실행에서 후보를 소프트로 띄운다).
