# 위협 모델 — Pocket Sisyphus

> 이 문서는 «무엇을 지키는가 / 무엇을 신뢰하는가 / 무엇을 막고 무엇은 못 막는가» 를 명시한다.
> 구현 세부는 [ARCHITECTURE.md](ARCHITECTURE.md) (특히 §4 보안 모델 · §8 알려진 리스크) 가 SSOT 이고,
> 취약점 신고 절차는 [SECURITY.md](SECURITY.md) 다. 이 문서는 그 둘을 «위협 모델»
> 관점으로 묶는다.
>
> 개인-데이터 경로(향후 메일·캘린더 등)에 적용할 **능력 캡 가드레일** 명세는
> [CAPABILITY_CAPS.md](CAPABILITY_CAPS.md) 가 정본이다 — 본 문서 §5.8(공격면)·§6(잔여 위험)과 1:1 로 묶인다.

Pocket Sisyphus 의 약속은 **«맥에서 돌아가는 코드 에이전트 CLI 를 폰의 LTE/5G 에서 안전하게 제어»** 다.
"안전하게" 가 정확히 무엇을 의미하는지 — 어떤 공격자에 대해, 어떤 가정 위에서 — 를 아래에 적는다.

---

## 1. 적용 범위 (Scope)

[README 의 프로젝트 경계](../README.md#프로젝트-경계) 와 동일하게, 이 저장소엔 세 프로젝트가 있고 위협 모델의
무게중심이 다르다.

| 프로젝트 | 위협 모델 대상 | 비고 |
|---|---|---|
| **iOS 앱** (`ios/`) | ✅ **핵심** | 폰 ↔ 내 Mac 의 사적 데이터 plane. 비밀 보관(Keychain). |
| **Mac 앱 + daemon** (`mac/`) | ✅ **핵심** | sshd · tor · daemon · PTY runner · 화면 캡처 헬퍼. 신뢰 경계의 중심. |
| **웹** (`web/`) | ⚠️ **주변** | 정적 소개 페이지(랜딩). 비밀 없음·백엔드 없음·DB 없음. 데이터 plane 과 무관. |

**비-목표 (이 위협 모델이 다루지 않는 것):**
- 코드 에이전트 CLI(`claude`/`agy`/`codex`) 와 각 제공자(Anthropic/Google/OpenAI) API 트래픽의 보안 —
  Pocket Sisyphus 는 그 트래픽을 중계하지 않는다(§3.6).
- 사용자의 macOS·iOS·하드웨어·OS Keychain·Secure Enclave 자체의 무결성(신뢰 가정, §4).
- 정적 랜딩 사이트의 가용성/콘텐츠 변조 — 비밀이 없어 데이터 plane 위협이 아니다(고전적 웹 호스팅 위협만 해당).

**확장 중인 표면 (개인-데이터 plane):** 향후 기능(메일·캘린더 등 개인-데이터를 에이전트에 주입하는
경로)은 «공격자가 본문을 통제할 수 있는 외부 콘텐츠» 를 데이터 plane 으로 끌어들여 **간접 프롬프트
인젝션 → lethal trifecta** 공격면을 연다(§5.8). 그 경로에 강제할 능력 캡은 [CAPABILITY_CAPS.md](CAPABILITY_CAPS.md)
가 정본이며, 이 위협 모델은 §5.8·§6 에서 그 공격면·잔여 위험을 기록한다.

---

## 2. 자산 (Assets) — 무엇을 지키는가

| 자산 | 어디 | 노출 시 영향 |
|---|---|---|
| **A1. 데이터 plane 트래픽** | 폰 ↔ Mac (PTY raw ANSI 스트림, `/api/*`, WS 이벤트) | 세션 내용·키스트로크·결과물 도청/변조 |
| **A2. 에이전트 실행 권한** | Mac daemon → `node-pty` → CLI | 사용자 home 의 임의 repo + `~/.claude/projects` 전체에 대한 read/write/exec |
| **A3. 페어링 비밀 묶음** | 페어링 QR(v=3) + 양쪽 보관소 | 전체 탈취 시 daemon 가장 또는 무단 접속 |
| ├ onion v3 키 (Ed25519) | Mac HiddenServiceDir | onion 주소 = 신원. 유출 시 서버 사칭 가능성 |
| ├ onion client-auth 키 (x25519) | Mac + 폰 Keychain | 디스크립터 복호화 능력 — onion 주소만으론 회로 못 엶 |
| ├ daemon Bearer 토큰 | Mac daemon + 폰 Keychain | `/api/*` 인가 |
| ├ SSH client priv (ed25519) | 폰 Keychain (페어링당 발급) | sshd 접속 자격 |
| └ SSH host key (ed25519) | Mac (영구) | fingerprint 핀 대상 — daemon 신원 |
| **A4. 화면 캡처 / 원격 제어 능력** | Mac 캡처 헬퍼(`CGEvent` 주입) | «보기» = 화면 유출, «조작» = Mac 데스크톱 무단 제어 (가장 강력) |
| **A5. ASC .p8 EC 비밀키** (opt-in) | Mac `config.json`(0600) 상주 — `asc.privateKeyPem`/`keyId`/`issuerId` | 장수 자격증명. 유출 시 키 role 범위의 App Store Connect API 접근(리뷰·크래시 등). 페어링 회전 밖 → ASC 콘솔에서 사용자 수동 폐기까지 유효 |

---

## 3. 신뢰 경계 (Trust boundaries) — 데이터가 경계를 건너는 지점

```
[ 사용자 손가락 ]                          ← 신뢰
  │ QR 스캔(대역 외, 화면 직접) — 페어링 1회
  ▼
┌── 경계 B1: 폰 앱 프로세스 ──────────────┐  ← 신뢰 (사용자 기기 + Keychain)
│  PocketSisyphus.app                      │
│  비밀: A3 (Keychain, 하드웨어 보호 가능)  │
└──────────────┬──────────────────────────┘
               │ outbound TCP
  ┌────────────▼─────────────────────────┐
  │ 경계 B2: 전송 평면 (적대적)            │  ← 불신 (공개 인터넷/LAN/Tor relay)
  │  · 직접 SSH (IPv6/IPv4 UPnP)          │     공격자가 관찰/변조/위조 시도 가능
  │  · Tor onion (3홉, 또는 obfs4 bridge) │
  └────────────┬─────────────────────────┘
               │ inbound
┌──────────────▼──────────────────────────┐  ← 신뢰 (사용자 Mac)
│ 경계 B3: Mac sshd (22022, 화이트리스트)  │
│  direct-tcpip → 127.0.0.1:7777 만 허용   │
├──────────────┬──────────────────────────┤
│ 경계 B4: daemon loopback (127.0.0.1)     │  ← 신뢰
│  Hono /api/* (+Bearer) · WS · /endpoint  │
├──────────────┬──────────────────────────┤
│ 경계 B5: PTY ↔ 코드 에이전트 CLI         │  ← «반신뢰»: CLI 가 처리하는 repo 콘텐츠는
│  node-pty spawn(claude/agy/codex/…)      │     적대적일 수 있음 (prompt injection, §5)
└──────────────┬──────────────────────────┘
               ▼
        사용자 파일시스템 / shell (A2 — 사용자 권한 전체)
```

- **B1·B3·B4·B5 안쪽은 신뢰** — 사용자 자신의 두 기기와 그 OS·Keychain 을 신뢰한다(§4 가정).
- **B2(전송 평면)는 전적으로 불신** — 모든 방어의 무게가 여기 실린다(§4 보안 모델). 적대적 LAN,
  ISP/통신사, Tor relay, 중간자(MITM) 가 트래픽을 보고·바꾸고·서버를 사칭하려 한다고 가정한다.
- **B5(에이전트 경계)는 «반신뢰»** — 채널은 안전해도, CLI 가 *읽는 repo 콘텐츠* 는 공격자가 심을 수
  있다(악성 repo의 prompt injection). 사용자가 자기 권한으로 에이전트를 돌린다는 본질상, 이 경계의
  잔여 위험은 «수용» 한다(§6).
- **웹(랜딩)은 이 그래프에 없다** — 비밀을 다루지 않고 데이터 plane 에 닿지 않는 별개 경계다.

---

## 4. 가정 (Assumptions) — 이게 깨지면 보장도 깨진다

1. **사용자가 자기 Mac·폰을 신뢰한다.** 이미 침해된 기기(루팅/탈옥/멀웨어 상주)는 범위 밖.
2. **페어링 QR 은 대역 외 안전 채널로 전달된다** — Mac 화면을 폰 카메라로 «직접» 스캔하는 1회 행위.
   QR 캡처본을 공유·전송하지 않는다고 가정(어기면 §5 «QR 유출» 위협이 현실화).
3. **OS 보안 프리미티브가 무결하다** — iOS Keychain(가능 시 Secure Enclave 하드웨어 보호), macOS
   Keychain, 코드사이닝/Gatekeeper/notarization, TCC 권한 게이트.
4. **번들 OSS 의존성이 정직하다** — Tor, OpenSSH portable, Citadel(swift-nio-ssh), Node, IPtProxy.
   공급망 변조는 별도 위협(이 모델은 우리가 그 «알려진 양품» 을 빌드에 박는다고 가정).
5. **코드 에이전트 CLI 와 그 제공자는 사용자가 선택해 신뢰한다.** Pocket Sisyphus 는 CLI 를 spawn 만
   하고 모델 트래픽을 중계하지 않는다(§3.6) — CLI/제공자 신뢰는 사용자 몫.
6. **암호 프리미티브는 깨지지 않는다** — Ed25519, x25519, ECDHE, SSH/Tor v3 프로토콜.

---

## 5. 공격자 모델 + 완화 (Adversaries → Mitigations)

각 행은 «공격자가 무엇을 노리고(자산), 무엇을 하며, 우리가 무엇으로 막는가» 다. 구현은
[ARCHITECTURE.md §4](ARCHITECTURE.md#4-보안-모델) 표를 정본으로 한다.

### 5.1 적대적 LAN / 중간자 (MITM) — *전송 평면 B2*
- **노림:** A1(트래픽 도청·변조), daemon 사칭으로 A3·A2 탈취.
- **수법:** 같은 Wi-Fi/LAN 에서 ARP/DNS 스푸핑, 가짜 daemon 응답, SSH/Tor 핸드셰이크 가로채기.
- **완화:**
  - **암호학적 신원 이중 보장** — onion v3 주소 = Ed25519 공개키 hash(주소 자체가 신원),
    그리고 SSH **host key fingerprint 핀**.
  - **직접 채널 host key 검증**(`SSHHostKeyTOFU.swift` `TOFUHostKeyValidator`, ARCHITECTURE §8.4):
    ① 완전 공개키(`cfg.sshHostKey`) 정확 일치 핀 → ② pairing/`/endpoint` 신뢰 fingerprint 대조 →
    ③ anchor 없을 때만 `KnownHostStore` 순수 TOFU. 불일치는 `SSHError.hostKeyMismatch` 로 **거부** →
    적대적 LAN 의 daemon 가장 차단. 직접 채널이 거부돼도 **onion fallback** 으로 안전 경로 투명 전환.
  - **forward secrecy** — SSH(ECDHE) 또는 onion v3(3홉 암호화)로 사후 키 유출에도 과거 트래픽 보호.

### 5.2 QR 유출 — *페어링 비밀 A3*
- **노림:** A3 묶음 전체(onion 키·client-auth·Bearer·SSH client priv) 한 번에.
- **수법:** 페어링 QR 스크린샷이 클라우드 동기화/메신저/어깨너머로 새어 제3자 손에.
- **완화:**
  - **대역 외 1회 전달 가정**(§4-2) + **즉시 회전 경로** — Mac 메뉴바 「페어링 값 바꾸기」 →
    `POST /api/admin/rotate-pairing`(ARCHITECTURE §4 revoke): 새 Bearer + onion 키 회전(새 .onion 주소)
    + SSH client keypair 재발급 + `authorized_keys` 갱신 + WS 강제 종료. **옛 QR 은 즉시 전면 무효.**
  - **client-auth 분리** — onion 주소만 든 QR 조각으로는 회로를 못 연다(아래 5.4).
  - 폰 분실도 같은 회전으로 대응(전 자산 일괄 무효화).

### 5.3 악성 repo prompt injection — *에이전트 경계 B5 / 자산 A2*
- **노림:** A2(사용자 권한 파일/exec) — 에이전트를 속여 `rm`/exfiltration/force-push 유도.
- **수법:** repo 의 README/이슈/소스 주석에 «무시하고 X 를 실행하라» 류 지시를 심어 CLI 가 읽게 함.
- **완화(부분):**
  - **워크플로우 노드별 승인 게이트**(`requires_approval`) + `.posiworkflow/` 결과 격리
    (ARCHITECTURE §8.5). 무인 노드의 파괴성은 사용자 결정 대기(`awaiting_approval`)로 가둔다.
  - **본질적 한계** — 사용자가 자기 권한으로 에이전트를 돌리는 게 제품의 목적이라, injection 의
    완전 차단은 불가. 이 경계의 잔여 위험은 명시적으로 **수용**한다(§6-1).

### 5.4 `.onion` 주소 누출 — *전송 평면 B2*
- **노림:** onion 주소를 알아내 서버에 도달.
- **수법:** 디스크립터 수집, 로그/공유 실수로 주소 노출.
- **완화:** **v3 client-auth (x25519)** — priv 없는 사람은 HS 디스크립터 자체를 복호화 못 해 회로를
  못 빌드한다(ARCHITECTURE §2.3). 주소 노출 ≠ 접속 가능. server-side single-hop 은 «서버 위치 익명성»
  을 포기하는 대신 지연을 줄인 의도된 trade-off(클라이언트 익명성·인증은 유지).

### 5.5 SSH 무차별 대입 / 측면 이동 — *경계 B3*
- **노림:** A2(shell/exec) 또는 22022 로 임의 포트 터널.
- **수법:** password 추측, exec/shell/sftp 시도, `direct-tcpip` 로 임의 내부 포트 접근.
- **완화: sshd 엄격 화이트리스트**(ARCHITECTURE §2.2):
  `PasswordAuthentication no` · `PubkeyAuthentication yes`(ed25519) · `PermitOpen 127.0.0.1:7777`
  (+ preview 고정 프록시 포트 1줄, §13.1) · `ForceCommand /bin/false`(shell/exec 거부) ·
  `PermitTTY no` · `AllowAgentForwarding no` · `X11Forwarding no` · Subsystem 미등록(sftp 차단).
  → 무차별 대입할 password 면이 없고, 성공해도 `direct-tcpip` 한 목적지 외엔 아무것도 못 한다.

### 5.6 토큰 유출 (Bearer / client key) — *자산 A3*
- **노림:** A1·A2 무단 접근.
- **수법:** Bearer 또는 SSH client priv 단건 탈취.
- **완화:** **기기별·페어링당 발급 + revoke**. Bearer 는 기기마다 따로, SSH client key 는 페어링당 새로
  (`pocket-device:<id>` 코멘트로 식별·revoke). 단건 유출도 rotate-pairing 으로 전면 회전(5.2).

### 5.7 외부 inbound 차단 / Tor DPI 차단 — *가용성*
- **노림:** 서비스 거부(연결 자체 차단).
- **수법:** CGNAT/방화벽이 inbound 차단, DPI 가 평문 Tor 트래픽 차단.
- **완화:** **Tor onion fallback** 자동 전환(직접 SSH 불가 시), 그리고 평문 Tor 가 정체되면
  **obfs4 bridge** 경유 재시도(`tor_bridge_v1`, ARCHITECTURE §8.1). 미설정 사용자 회귀 없음(평문 우선).

### 5.8 간접 프롬프트 인젝션 → lethal trifecta — *에이전트 경계 B5 / 자산 A2*
- **노림:** A2(사용자 권한 파일/exec/네트워크) — «사적 데이터» 를 «외부 통신» 으로 빼내는 제로클릭 유출
  (EchoLeak·ShadowLeak 류).
- **수법:** 공격자가 본문을 통제하는 **개인-데이터 입력**(메일 본문/헤더/첨부, 캘린더 초대 제목·메모)에
  «무시하고 X 를 외부로 보내라» 류 지시를 심는다. 향후 개인-데이터 기능이 그 콘텐츠를 에이전트 컨텍스트에
  넣으면 ①사적 데이터 ②신뢰 못 할 외부 콘텐츠 ③외부 통신 능력 의 **세 다리가 한 세션에 모여** trifecta 가
  완성되고, `skip_permissions`·cron·워크플로우의 **무인 자율 실행**이면 사람 클릭 없이 유출된다.
- **완화: 세 다리 중 ③(외부 통신)을 캡으로 끊는다** ([CAPABILITY_CAPS.md](CAPABILITY_CAPS.md) 정본):
  - **오염(taint) 전파 + EGRESS 차단** — 개인/외부 콘텐츠가 들어간 세션은 `external_content_tainted` 로
    표시(continue/다음 노드/worktree 로 전파, 해제 없음)하고, 메일 send·임의 HTTP POST·`git push`·outbound
    MCP 등 **외부 전송 능력을 기본 차단**. 사람 있는 대화 경로는 목적지+payload 를 보이는 per-action 확인
    게이트로만 통과(블랭킷 허용 없음).
  - **무인 trifecta 금지(불변식)** — cron·워크플로우 무인 노드·`skip_permissions`·PO 무인 구현에서는
    오염 컨텍스트와 EGRESS 가 **동시에 활성일 수 없다**(설정 단계 정적 거부 + 런타임 핸들 회수). 개인-데이터
    자율 작업은 EGRESS 없는 **격리 세션**(전용 worktree·자격증명 미주입)에서 돌리고 결과는 로컬 파일로만.
  - **read-only 우선** — 개인-데이터 커넥터는 기본 read-only 스코프, 소스 되쓰기(메일 send·캘린더 수정)는
    per-action 확인 필수이며 무인 경로에선 금지.
  - **도메인 allowlist + MCP 최소권한** — outbound 기본 deny + allowlist, 오염/무인 세션엔 EGRESS·되쓰기
    성격 MCP 도구 미연결.
  - **알림 정합** — 기존 EGRESS 성격 통지(Discord 등)는 오염 세션 «결과/본문» 을 payload 에 싣지 않고
    메타 신호만 보낸다(ARCHITECTURE §12.6 에 추가 제약).
- **본질적 한계(잔여):** §5.3 과 같이 인젝션의 «읽힘» 자체는 못 막는다 — 방어는 ③ 통신 다리를 끊어 «유출
  완성» 을 막는 데까지다. 잔여 위험은 §6-7 로 수용한다.

### 5.9 위조 딥링크 (커스텀 스킴) — *외부 진입 / 화면 네비게이션*
- **노림:** 위조한 `pocketsisyphus://…` 링크를 사용자가 탭하게 만들어 앱 화면 네비게이션을 «유도» —
  특정 세션/백로그/워크플로우/미러 화면으로 끌고 간다. A2·A3(비밀)을 직접 노리는 게 아니라, 무게이트
  페어에서의 «잠금 부재 + 임의 화면 전환» 을 노린다.
- **수법:** **커스텀 스킴은 OS 소유권 검증이 없다** — Universal Links 와 달리 누구나 같은 scheme 의 URL 을
  만들 수 있고(위조), 같은 기기에 다른 앱이 같은 scheme 을 등록하면 가로챌 수도 있다. 공격자는 메신저·웹·
  QR 등에 `pocketsisyphus://mirror` 같은 링크를 심어 사용자가 탭하도록 유인한다.
- **가정:** **커스텀 스킴(`pocketsisyphus://`)으로 들어오는 URL 은 위조·가로채기 가능하다고 본다** — 진입
  자체를 신뢰하지 않는다(Universal Links 대비 OS 소유권 보장 없음, §4 가정의 연장).
- **완화:**
  - **핸들러는 «행동» 을 실행하지 않는다** — `DeepLinkRouter.handle` 은 URL 을 파싱해 `pendingSessionId`/
    `pendingBacklog`/`pendingMirror`/`pendingWorkflowRunId` 같은 **«열람 요청» 플래그만** 세운다.
    삭제·실행·전송·결제 같은 부수효과 동작은 딥링크로 일어나지 않는다.
  - **소비는 LockView·capability·Pro 게이트 뒤에서만** — 플래그는 `SessionsView`/`MainTabView`/`BacklogView`
    가 받아 네비게이션하는데, 이는 모두 AppRoot 가 (등록 페어면) `LockView`(Secure Enclave 생체 잠금)를 통과한
    뒤에야 마운트되는 화면이다. 미러는 `screen_capture_v1` **capability + 프로 게이트**, 백로그/워크플로우는
    `.poLoop`/`.workflow` **프로 게이트**를 그대로 거친다 — 딥링크가 게이트를 우회하지 못한다.
  - **스킴에 시크릿 미탑재** — URL 은 세션/브리프/런 «식별자» 만 담고 Bearer·키·자격증명을 싣지 않는다
    (A3 는 §5.6 처럼 Keychain·페어링당 발급으로만 다룬다). 링크 유출·위조가 비밀 유출로 이어지지 않는다.
- **본질적 한계(잔여):** 무게이트 페어(`needsAuthGate=false`)에선 `LockView` 가 없어 위조 딥링크가 «화면
  전환» 자체는 일으킬 수 있다. 잔여 위험은 §6-8 로 수용한다.

### 5.10 ASC .p8 키 유출 + ASC outbound 채널 — *자산 A5 / 「외부 서버 0」 예외*
- **노림:** A5(ASC .p8 EC 비밀키) — daemon 침해/`config.json` 유출로 키를 탈취해 소유자의 App Store
  Connect API 에 키 role 범위만큼 접근.
- **수법:** daemon 프로세스 침해 또는 0600 파일(`config.json`) 직접 탈취로 `asc.privateKeyPem`·`keyId`·
  `issuerId` 를 빼낸다. 이 키로 ES256 JWT 를 자가 서명하면(15분 만료지만 키가 있으면 무한 재발급)
  `api.appstoreconnect.apple.com` 에 키 role 권한대로 호출할 수 있다.
- **새 outbound 경계(수용된 예외):** daemon 은 PO 수집의 «스토어 리뷰»·«크래시» 신호를 위해
  `api.appstoreconnect.apple.com` 으로 **직접 outbound 호출**한다(`asc.ts` ES256 JWT 서명 + `crash.ts`
  Analytics Reports 다운로드 — 두 경로 모두 같은 ASC 키·같은 채널). 이는 README 핵심 원칙 «외부 서버
  의존 0» 에 대한 **명시적·수용된 예외**다. 근거: ① 호출 대상이 **Apple 자사 API** 일 뿐 메인테이너
  인프라·제3자 서버가 아니다(우리가 트래픽을 보지 않는다) — §1 비-목표의 «제공자 API 트래픽» 과 같은
  성격, ② **소유자 opt-in**(아래) 이며 기본 비활성, ③ 가져오는 것은 **읽기 신호 집계**(리뷰·크래시)뿐.
- **완화:**
  - **0600 권한** — 키는 `config.json`(소유자만 read/write)에만 산다. 파일 경로가 아니라 PEM 본문을 박제.
  - **opt-in + 소유자 전용** — Mac 앱 설정 「App Store」 탭이 `/api/po/asc-key`(로컬 운영자 전용 경로)로만
    저장한다. **폰(QR/페어링)에는 절대 들어가지 않는다** — A3 페어링 묶음과 완전 분리된 별개 자산.
  - **읽기 신호 한정** — 채널은 리뷰·크래시 «집계 읽기» 에만 쓰인다(되쓰기·배포·메타데이터 변경 없음).
  - **키 미설정 시 채널 부재** — `asc` 미설정이면 outbound ASC 호출 자체가 일어나지 않는다(기능이 꺼져
    있으면 경계가 존재하지 않음). 회귀 없음.
  - **role 최소화 권고** — ASC 콘솔에서 가능한 한 좁은 키 role(예: 읽기 전용 Analytics)을 발급할 것.
    ⚠️ App Manager 같은 **넓은 role 로 발급하면 유출 시 영향이 그 role 전체로 커진다** — 좁은 role 권장.
- **§5.6 와의 관계(핵심 잔여 위험):** Bearer·SSH client key(A3)는 **기기별·페어링당 발급 + rotate-pairing
  전면 회전**으로 단건 유출을 무력화한다(§5.6, §5.2). **ASC .p8 키는 그 회전 모델 밖**이다 — 우리가 발급·
  폐기하는 자격증명이 아니라 Apple 이 발급한 장수 키라, 페어링을 아무리 돌려도 무효화되지 않는다. 따라서
  **회전·폐기 책임은 사용자에게 있다**: 유출 의심 시 **ASC 콘솔에서 해당 API 키를 직접 revoke** 하고 새
  키를 발급해 재설정해야 한다. 이 잔여 위험은 §6-9 로 수용한다.

### 5.11 비-LAN outbound 유출 (egress confinement / LAN 전용 모드) — *전송 평면 B2 / 「외부 서버 0」 보강*
- **노림:** 사용자가 폰↔Mac 채널을 «LAN 직결» 로 바꿔 «패킷이 회사 밖으로 안 나간다» 고 믿는데, daemon 이
  그와 «별개로» 조용히 공개 인터넷으로 나가는 부수 outbound 들 — 공인 IP echo(ipify 등)·UPnP/NAT-PMP·
  App Store Connect·Discord webhook — 으로 메타데이터/트래픽을 흘린다.
- **수법:** 데이터 plane 을 LAN 직결로 바꿔도 daemon 은 ① WAN IP 파악용 echo(`api.ipify.org` 등), ②
  공인 inbound 노출용 UPnP/NAT-PMP 라우터 매핑, ③ PO 수집의 ASC 신호(`api.appstoreconnect.apple.com`),
  ④ 알림 Discord webhook 을 그대로 발사한다. 이 호출들의 존재·타이밍·목적지가 사내망 밖으로 새면 «외부
  완전 차단» 보증이 절반만 참이 된다(연결 사실·IP·앱 식별자 등 메타데이터 누출).
- **새 신뢰 경계/통제(수용된 통제):** **«LAN 전용 모드»**(`config.lanOnly === true`, 기본 OFF). 켜지면
  daemon 의 «비-LAN» outbound 를 **기본 deny** 로 게이트한다. 폰↔Mac 사적 데이터 plane(LAN 직결·sshd·
  endpoint, 127.0.0.1 바인딩)은 게이트 대상이 «아니다» — 통제 대상은 «공개 인터넷/Tor relay 로 나가는»
  부수 outbound 다. 발견(discovery) 채널도 이 모드에선 **Tor onion 노출에서 LAN 발견으로 전환**한다(공인
  매핑 불필요).
- **완화:**
  - **단일 게이트(누락 방지)** — 모든 비-LAN outbound 경로가 **한 helper**(`mac/daemon/src/egress.ts`
   의 `guardNonLanEgress()`)를 거친다. 새 outbound 를 추가하는 사람이 한 줄만 잊지 않으면 «한 경로만 깜빡»
   유출이 구조적으로 막힌다. 적용 지점: `nat/external-ip.ts`(echo)·`nat/port-mapping.ts`(UPnP/PMP)·
   `po/asc.ts`·`po/crash.ts`·`po/asc-check.ts`(ASC)·`notify/discord.ts`(webhook).
  - **경로별 기본 deny 동작** — echo 는 **호출 skip**(캐시 있으면 마지막 IP, 없으면 `none`), UPnP/NAT-PMP
   는 **매핑 시도 중단**(공인 노출 불필요), ASC 는 **outbound 차단 + 「모드와 충돌」 throw**(수집은 죽지
   않고 해당 신호 섹션만 생략, ASC 가용성 프로브는 «불확실» 처리로 거짓 「키 만료」 경고 억제), Discord 는
   **알림 전송 차단**(repo·세션 제목 등 메타데이터 미유출).
  - **모드 OFF 회귀 0** — 게이트는 모드 OFF 시 부작용 0(로그조차 없음)으로 «그냥 통과» 한다. 기본값이 OFF
   이라 기존 사용자 동작은 한 비트도 바뀌지 않는다.
  - **계약 테스트** — `mac/daemon/src/egress.test.ts` 가 모드 ON 에서 echo/UPnP/ASC/Discord 의 실제
   `fetch` 호출이 **0** 임을, 모드 OFF 에선 echo 가 정상 fetch 경로를 탐을 단언한다.
- **잔여 위험:** ① **OS 레벨 트래픽은 못 막는다** — DNS 해석·ARP·NTP·OS 업데이트 점검 등 daemon 이 아닌
  운영체제/다른 프로세스가 내는 패킷은 이 게이트의 통제 밖이다(진짜 «egress 0» 은 OS/네트워크 방화벽 층의
  책임). ② **모드 OFF 시 종전 노출** — 기본값이 OFF 이므로 명시적으로 켜지 않은 사용자는 §5.10 등 종전
  outbound 노출을 그대로 가진다(이 통제는 opt-in). ③ 모드 토글은 `config.json`(0600) 신뢰에 기댄다 —
  daemon/파일 침해로 `lanOnly` 가 꺼지면 게이트가 해제된다(§5.6·§5.10 의 config 신뢰 가정과 동일). 이
  잔여 위험은 §6-10 으로 수용한다.

---

## 6. 수용된 잔여 위험 (Accepted residual risk)

명시적으로 «막지 않기로» 한 것 — 제품 목적상 본질적이거나, 비용/복잡도 대비 가치가 낮은 위협.

1. **사용자 자신의 에이전트 실행이 파괴적일 수 있음.** 사용자가 자기 권한으로 코드 에이전트를 돌리는
   게 제품의 본질 — 에이전트가 `rm`·force-push 등 파괴적 동작을 (특히 `skip_permissions` 무인 노드에서)
   할 수 있다. 방어는 «완전 차단» 이 아니라 **노드별 승인 게이트 + 결과 격리**(§5.3, ARCHITECTURE §8.5)
   까지다. 사용자가 신뢰하는 repo 만 다루고 무인 자동화를 신중히 켤 책임은 사용자에게 있다.
2. **터미널 렌더 표면.** PTY 출력은 raw ANSI 로 흐르고 SwiftTerm 이 렌더한다 — 적대적 repo 가 escape
   시퀀스로 화면을 교란할 여지가 있다. 입력 경로엔 high-bit byte drop 등 방어가 있으나(§5.3 입력),
   *출력 렌더* 의 모든 ANSI 악용을 막지는 않는다. 인터랙티브 prompt 감지도 휴리스틱(ARCHITECTURE §8.3).
3. **Citadel 단일 메인테이너.** swift-nio-ssh(NIO) 기반은 검증됐으나 Citadel 자체 버그 가능성은
   우리가 직접 fix 로 대응(ARCHITECTURE §8.2).
4. **Tor bridge 한계.** bridge 경유 지연 증가로 라이브 프리뷰/미러가 거칠어질 수 있고, 내장 기본 bridge
   세트는 메인테이너가 회전·갱신해야 한다(ARCHITECTURE §8.1). BridgeDB 자동 분배·HTTPS 종단·Mac 측
   bridge 는 비-목표.
5. **원격 제어 = 가장 강력한 능력.** 입력 주입(조작)은 세션별 「제어 허용」 을 명시적으로 켠 경우에만
   전달(블랭킷 금지) + 손쉬운 사용 TCC 별도 필요(ARCHITECTURE §13.3). 그래도 켠 동안엔 폰이 Mac
   데스크톱을 조작할 수 있다는 점은 설계상 수용. 캡처는 시청자 없으면 자동 종료(프라이버시/배터리).
6. **서버 위치 익명성 포기.** single-hop onion 은 의도적으로 서버 익명성을 버리고 지연을 줄였다(§5.4).
   클라이언트 익명성·client-auth 인증은 유지.
7. **간접 프롬프트 인젝션의 «읽힘» 은 못 막는다.** 개인-데이터 경로(메일·캘린더)가 공격자 통제 콘텐츠를
   에이전트에 넣는 것 자체는 기능의 입력이라 차단 불가(§5.8). 방어는 lethal trifecta 의 ③ 외부 통신 다리를
   **능력 캡으로 끊어**([CAPABILITY_CAPS.md](CAPABILITY_CAPS.md)) «유출 완성» 을 막는 데까지다 — 오염 세션
   EGRESS 차단/게이트, 무인 trifecta 금지, read-only 우선, allowlist, MCP 최소권한. 사용자가 신뢰하는
   소스만 연결하고 무인 자동화에 개인-데이터 + 외부 통신을 함께 켜지 않을 책임은 사용자에게 남는다.
8. **무게이트 페어에서 위조 딥링크의 화면 네비게이션은 못 막는다.** 커스텀 스킴은 OS 소유권 검증이 없어
   위조·가로채기 가능하다(§5.9). 핸들러가 행동을 실행하지 않고 LockView·capability·프로 게이트 뒤에서만
   소비되며 스킴에 시크릿을 싣지 않으므로 비밀 유출·부수효과는 없지만, **`needsAuthGate=false` 인 페어
   (soft·옛 daemon·시뮬레이터)에선 `LockView` 가 없어** 위조 딥링크가 미러/백로그 등으로
   **화면 전환을 유발**할 수 있다. **영향은 낮다** — 미러는 `screen_capture_v1` capability + 프로 게이트 +
   별도 사용자 확인·권한이 추가로 필요하고, 백로그/워크플로우도 프로 게이트를 거쳐 «파괴적 동작» 이 아니라
   «읽기 화면 전환» 에 그친다. 등록 페어(`needsAuthGate=true`)는 LockView 가 선행해 이 표면이 닫힌다.
9. **ASC .p8 키는 페어링 회전 밖 — 회전 책임이 사용자에게 있다.** 스토어 리뷰·크래시 신호용 ASC API 키는
   소유자가 opt-in 으로 `config.json`(0600)에 넣는 **Apple 발급 장수 자격증명**이라, Bearer·SSH 처럼
   rotate-pairing 으로 무력화되지 않는다(§5.10, §5.6 대비). daemon 침해/`config.json` 유출 시 키 role
   범위의 ASC 읽기 접근이 새며, 무효화하려면 **사용자가 ASC 콘솔에서 직접 키를 revoke·재발급**해야 한다.
   이는 README 「외부 서버 0」 원칙의 (수용된) 예외이기도 하다 — 대상이 Apple 자사 API·opt-in·소유자 전용·
   읽기 신호 한정이라 수용한다. 좁은 키 role 발급과 유출 시 수동 폐기 책임은 사용자에게 남는다.
10. **LAN 전용 모드는 opt-in + OS 레벨 트래픽 밖이다.** egress confinement(§5.11)는 daemon 의 «비-LAN»
    부수 outbound(echo·UPnP/NAT-PMP·ASC·Discord)를 단일 게이트로 기본 deny 하지만, **기본값이 OFF**
    이고 DNS·ARP·NTP 같은 **OS 레벨 트래픽은 통제 밖**이다. 「패킷이 회사 밖으로 한 비트도 안 나간다」 의
    완전 보증은 OS/네트워크 방화벽 층의 책임이고, 이 통제는 «daemon 이 자발적으로 내는 부수 outbound 차단»
    까지다. 모드 토글이 `config.json` 신뢰에 기대는 점(침해 시 해제 가능)도 수용한다.

---

## 7. 취약점을 발견했다면

책임 있는 신고(coordinated disclosure) 경로는 [SECURITY.md](SECURITY.md) 를 따른다 — GitHub
비공개 보안 권고(private advisory)를 1차 채널로 쓴다. 공개 이슈/PR/Discord 에 0-day 세부를 올리지 말 것.
