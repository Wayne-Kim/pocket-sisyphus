[English](SECURITY.md) · **한국어**

# 보안 정책 (Security Policy)

Pocket Sisyphus 는 «안전하게 제어» 를 전면에 내세우는 제품이다. 그 약속을 진지하게 지키기 위해,
외부 연구자가 결함을 **책임 있게** 알릴 수 있는 통로와 우리의 응답 약속을 여기 공개한다.

전체 위협 모델·신뢰 경계·수용된 잔여 위험은 [`docs/THREAT_MODEL.md`](THREAT_MODEL.ko.md),
방어 구현은 [`docs/ARCHITECTURE.md`](ARCHITECTURE.ko.md) (§4 보안 모델 · §8 알려진 리스크), 개인-데이터
경로의 능력 캡(lethal trifecta 차단)은 [`docs/CAPABILITY_CAPS.md`](CAPABILITY_CAPS.ko.md) 참고.

---

## 지원 버전 (Supported versions)

iOS 앱과 Mac 앱은 한 «세트» 로 동작하며 marketing version(`MAJOR.MINOR.PATCH`)을 **항상 동일하게**
유지한다([README — Versioning policy](README.ko.md#versioning-policy)). 보안 수정은 **최신 릴리즈로 전진
배포(roll-forward)** 한다 — 옛 버전으로의 백포트는 하지 않는다.

| 버전 | 보안 수정 대상 |
|---|---|
| **최신 릴리즈** (iOS TestFlight / Mac 최신 notarized DMG) | ✅ 지원 |
| 직전 minor (호환 핸드셰이크상 동작) | ⚠️ 다음 릴리즈로 전진 수정 — 별도 백포트 없음 |
| 호환성이 깨진 옛 MAJOR | ❌ 미지원 (재페어링·업데이트 필요) |

- iOS 는 **TestFlight**, Mac 은 **Developer ID + notarized DMG + Sparkle 인앱 업데이트** 로 배포한다.
  Mac 사용자는 Sparkle 이 최대 1시간 내 새 버전을 감지하거나 메뉴바 「업데이트 확인…」 으로 즉시 받는다.
- 「marketing version + build number」 쌍으로 영향 빌드를 특정한다(런타임 표시 위치는 README 참고).
- 정적 랜딩 사이트(`web/`)는 비밀·백엔드가 없어 «버전 지원» 대상이 아니다(항상 최신 배포).

---

## 취약점 신고 (Reporting a vulnerability)

> ⚠️ **공개 GitHub 이슈/PR, Discord, 기타 공개 채널에 취약점 세부(특히 미공개 0-day)를 올리지 마세요.**
> 아래 비공개 경로를 사용해 주세요.

### 1차 채널 — GitHub 비공개 보안 권고 (권장)

공개 배포 저장소 [`Wayne-Kim/pocket-sisyphus`](https://github.com/Wayne-Kim/pocket-sisyphus) 의
**Security → Report a vulnerability** (Private Vulnerability Reporting) 로 신고해 주세요:

→ <https://github.com/Wayne-Kim/pocket-sisyphus/security/advisories/new>

이 경로는 비공개 advisory 스레드를 만들어 패치·CVE 발급·공개 시점을 메인테이너와 함께 조율하기에
가장 적합합니다(coordinated disclosure).

### 2차 채널 — 이메일

GitHub 계정 사용이 어렵다면: **wayne@soomgo.com** (제목에 `[security]` 접두).
민감 정보는 별도 협의 후 암호화 채널로 주고받습니다(전용 PGP 키는 현재 미공개 — 요청 시 협의).

### 신고에 담아주시면 좋은 것

- 영향받는 컴포넌트(iOS 앱 / Mac 앱·daemon / sshd / tor / 캡처 헬퍼)와 버전(`vX.Y.Z (build)`).
- 재현 절차 / PoC, 영향(어떤 자산 — [THREAT_MODEL §2](THREAT_MODEL.ko.md) 참고)과 전제 조건.
- 가능하면 제안하는 완화.

---

## 응답 약속 (Response SLA)

메인테이너 1인이 운영하는 OSS 프로젝트라는 점을 감안한 «목표» 시간입니다(영업일 기준, best-effort):

| 단계 | 목표 |
|---|---|
| **수신 확인 (acknowledgement)** | **3 영업일** 이내 |
| **분류 + 1차 평가 (triage / severity)** | **7 영업일** 이내 |
| **수정 계획·일정 공유** | triage 후 진행 상황을 advisory 스레드로 갱신 |
| **공개 (coordinated disclosure)** | 수정 배포 후, 또는 최초 신고로부터 **최대 90일** 중 빠른 시점 — 신고자와 조율 |

심각도가 높고 현재 악용 정황이 있는 경우 위 일정을 단축해 우선 처리합니다.

---

## 범위 (Scope)

**In-scope** — 보고 환영:
- **iOS 앱** (`ios/`) 과 **Mac 앱 + daemon** (`mac/`): 전송 평면(직접 SSH / Tor onion / bridge),
  sshd 화이트리스트, host key 검증, 페어링/회전, daemon API/WS 인가, PTY runner, 화면 캡처·원격 제어,
  비밀 보관(Keychain) 등 — [THREAT_MODEL](THREAT_MODEL.ko.md) 의 자산·경계 전반.

**Out-of-scope** — 보고 대상 아님:
- **수용된 잔여 위험** — 사용자 자신의 에이전트 실행 파괴성, 터미널 ANSI 렌더 표면, single-hop onion 의
  서버 익명성 포기 등. 의도된 설계이며 [THREAT_MODEL §6](THREAT_MODEL.ko.md) 에 명시돼 있습니다.
- **정적 랜딩 사이트**(`web/`)의 콘텐츠/가용성 — 비밀·백엔드가 없습니다. (호스팅 플랫폼 자체 이슈는
  해당 플랫폼에 신고.)
- 코드 에이전트 CLI / 제공자(Anthropic·Google·OpenAI) API 측 이슈 — 해당 벤더에 신고해 주세요.
- 사회공학, 물리적 기기 접근, 이미 침해된 사용자 기기를 전제한 공격(신뢰 가정 — THREAT_MODEL §4).

---

## 세이프 하버 (Safe harbor)

선의의 보안 연구를 환영하고 지지합니다. 다음을 준수하는 한, 본 정책에 따른 연구 활동에 대해 법적 조치를
취하지 않으며 «선의(good faith)» 로 간주합니다:

- **본인 소유/제어 기기와 본인 페어링** 으로만 테스트할 것 (제3자 데이터·기기 접근 금지).
- 서비스 중단·데이터 파괴·프라이버시 침해를 피하고, 필요한 최소 범위로만 확인할 것.
- 발견 내용을 위 비공개 채널로 알리고, 합의된 공개 시점까지 비밀을 유지할 것.

확신이 안 서면 먼저 물어봐 주세요 — 함께 안전하게 검증할 방법을 찾겠습니다.
