[English](CONTRIBUTING.md) · **한국어**

# Pocket Sisyphus 기여 가이드

기여에 관심 가져 주셔서 감사합니다. 이 문서는 기여자가 **«무엇을 빌드하고, 내 PR 이 머지되려면
어떤 검사를 통과해야 하나?»** 를 한곳에서 알 수 있게 하는 단일 진입점입니다 — 컨벤션 자체는
[`CLAUDE.ko.md`](CLAUDE.ko.md) 와 README·소스 곳곳의 SSOT 주석 블록에 있고, 이 문서는 그것을
다시 쓰지 않고 «요약 + 링크» 만 합니다.

## 시작 전에 — 라이선스 & CLA (필수)

**소스가 공개돼 있지만 독점 라이선스다 — 오픈소스가 아니다.** 소스가 공개됐다는 것이 상업적
이용을 허가한다는 뜻은 **결코 아니다.** 전문은 [`LICENSE.md`](LICENSE.md)
(README 의 [라이선스 · 기여](README.ko.md#라이선스--기여) 절도 참고).

- ✅ 누구나 소스 열람·클론, 본인 PC 에서 직접 빌드해 **개인적·비상업적** 사용, 본인용 수정,
  그리고 **기여(PR) 목적의 수정** 가능.
- ⛔ 소스/빌드물의 제3자 재배포, 어떤 형태의 상업적 사용·판매는 허용되지 않는다.

**기여하려면 첫 기여가 머지되기 전에 [`CLA.md`](CLA.md) 에 한 번 동의해야 한다.** 동의하면
기여물의 저작재산권을 저작권자에게 양도한다(양도 불능 관할에선 독점 라이선스로 폴백). 동의
방법은 둘 중 하나:

1. **PR 에서 서명** — [`CLA.md`](CLA.md) 맨 아래 *Signatories* 표에 본인의 법적 이름·GitHub
   사용자명·이메일·날짜로 한 줄을 추가한다. 그 PR 을 여는 것이 곧 서명이다.
2. **이메일 동의** — `CLA.md` 에 인용된 수락 문구를 저작권자에게 이메일로 보낸다.

또한 각 기여물이 본인의 독창적 작업이며 제3자의 권리를 침해하지 않음을 보증한다 — 제출 권한이
없는 코드를 끼워 넣지 마라.

## 저장소 구조

이 레포는 **세 개의 프로젝트**를 담고 있다. 각 제약이 다른 이유는
[프로젝트 경계](README.ko.md#프로젝트-경계)를 참고.

| 경로 | 프로젝트 | 무엇인가 |
|---|---|---|
| `ios/` | **iOS 앱** | SwiftUI 클라이언트(SSH 우선 + Tor 폴백). |
| `mac/` | **Mac 앱** | SwiftUI 메뉴바 호스트. 동반 `mac/daemon/` 은 에이전트 CLI 를 spawn 하는 Node + Hono + WS 데몬. |
| `web/` | **웹** | 정적 Next.js 마케팅/랜딩 페이지(GitHub Pages 빌드, 백엔드 없음). |

레포 문서(이 파일·README·`docs/`)는 **영어·한국어 둘 다** 유지한다 —
아래 [문서 — 영어·한국어 쌍](#문서--영어한국어-쌍-필수) 참고.

## 빌드 & 실행

**사전 요건:** Xcode 가 깔린 macOS(앱 빌드용), [XcodeGen](https://github.com/yonaskolb/XcodeGen)
+ CocoaPods(`.xcodeproj`/`.xcworkspace` 는 `project.yml` 에서 생성), Node.js(데몬), `pnpm`(웹).
`scripts/` 의 헬퍼 스크립트가 흔한 플로우를 감싼다. Claude Code 를 쓴다면 같은 플로우가
스킬로도 노출된다(마지막 열).

| 대상 | 빌드 / 실행 | Claude Code 스킬 |
|---|---|---|
| **iOS** (케이블 기기) | `./scripts/dev.sh ios` — Debug 빌드 + 연결된 기기에 설치 | `/dev` |
| **iOS** (Wi‑Fi 기기) | `PS_DEV_DEVICE_UDID=<udid> ./scripts/dev.sh ios` | `/device` |
| **iOS** (시뮬레이터 검증) | `./scripts/verify-ios.sh` — 빌드 → 설치 → 스크린샷 루프 | `/verify-ios` |
| **Mac** | `./scripts/dev.sh mac` — Debug 빌드 + 재실행 | `/dev` · `/dev-mac` |
| **데몬** | `cd mac/daemon && npm ci && npm run build` | — |
| **웹** | `./scripts/dev-web.sh` (`pnpm` + `next dev`) | `/dev-web` |

메모:
- Xcode 프로젝트는 **생성물**이다 — `ios/project.yml`·`mac/project.yml` 을 고친 뒤엔
  `xcodegen generate` 로 재생성한다(dev 스크립트는 `PS_DEV_REGEN=1` 로 돌리면 해 준다).
  iOS 는 `postGenCommand` 로 `pod install` 이 따라 돈다.
- 버전 bump·배포(TestFlight / Developer ID DMG)는 **메인테이너 전용** 절차이며 이 레포에
  없다 — **PR 에서 마케팅 버전을 올리지 마라.** iOS·Mac 앱은 동일한 마케팅 버전 하나를
  공유한다([Versioning policy](README.ko.md#versioning-policy) 참고).

## PR 을 열기 전에 통과해야 할 검사

### CI 게이트 (머지를 막는다)

| 게이트 | 실행 내용 | 설정 |
|---|---|---|
| **gitleaks** | 전체 git 히스토리 비밀 스캔(allowlist 는 `.gitleaks.toml`). | `.github/workflows/gitleaks.yml` |
| **i18n 게이트** | `./scripts/i18n-lint.sh --strict`, `./scripts/test-i18n-lint.sh`, `./scripts/doc-pair-lint.sh`, `./scripts/test-doc-pair-lint.sh` — 모두 차단. | `.github/workflows/i18n.yml` |
| **daemon 테스트** | `mac/daemon` 의 `vitest run`(커버리지 floor 포함) — 1개라도 실패하면 차단. | `.github/workflows/daemon-test.yml` |
| **앱 단위 테스트** | macOS 러너에서 아이폰(`PocketSisyphusTests`)·맥(`PocketSisyphusMacTests`) host-less 단위 테스트를 `xcodebuild test`(코드 서명 없이) 로 실행 — 1개라도 실패하면 차단. | `.github/workflows/app-test.yml` |

### 푸시 전에 로컬에서 돌릴 것

단일 `lint-all` 래퍼는 없다 — 패밀리 스크립트(모두 `scripts/` 에 있음)와 데몬 테스트를
직접 돌린다. 건드린 부분에 해당하는 것을 돌리고, 애매하면 전부 돌려라.

| 명령 | 검사 대상 | CI 게이트? |
|---|---|---|
| `./scripts/i18n-lint.sh --strict` | 로컬라이즈 카탈로그 우회 + 10개 로케일 전반 미완역 커버리지. | ✅ |
| `./scripts/doc-pair-lint.sh` | 영어/한국어 문서쌍·언어 스위처 헤더·슬롯 역전. | ✅ |
| `./scripts/design-lint.sh` | Swift 색-토큰 정책 위반(리터럴 hue, `.white`/`.black`, 전역 `.tint()`). | — |
| `./scripts/agent-surfaces-lint.sh` | 에이전트 픽커 SSOT 와 에이전트 목록을 노출하는 4개 다운스트림 표면. | — |
| `./scripts/po-agent-lint.sh` | PO 세션 spawn 진입점이 `agent:` passthrough 를 싣는지. | — |
| `./scripts/test-*-lint.sh` | 각 lint 스크립트의 self-test — lint 를 수정하면 짝을 돌린다. | i18n·doc-pair self-test ✅ |
| `cd mac/daemon && npm test` | 데몬 `vitest` 스위트. | — |

`design-lint`·`agent-surfaces-lint`·`po-agent-lint` 은 출시 전과 PO 자가검증 노드에서 도는
휴리스틱 검사다. **아직** 공개 CI 엔 없지만, 변경이 해당 표면(UI 색·에이전트 목록·PO spawn
경로)을 건드리면 리뷰 왕복을 줄이게 짝을 로컬에서 돌려라. 각 스크립트는 `--help` 를 받는다.

## 지켜야 할 SSOT 계약 (요약 + 포인터)

[`CLAUDE.ko.md`](CLAUDE.ko.md) 가 기여자 기준 정본이다. PR 을 가장 자주 막는 계약:

- **색 = 의미.** SSOT 는 `ios/PocketSisyphus/DesignSystem/DesignTokens.swift` 의
  `Theme`(색상 정책 주석 블록)다. Mac 은 같은 시맨틱 이름을 미러하고, 웹은
  `lib/tokens.ts`·`app/globals.css` 에서 미러한다. hue 자체가 약속이다:
  **accent = 보라**(브랜드/선택 — `AccentColor` 에셋을 통한 기본 틴트), **success = 초록**,
  **danger = 빨강**, **warning = 노랑**(*진짜 경고 전용*), **info = 파랑**(거의 안 씀),
  **pro = 주황**(프리미엄/고급 — *경고가 아니라 강조*). 노드 종류색: 시작 = 초록 ·
  작업 = 분홍 · 종료 = 파랑. warning(노랑)↔pro(주황)을 절대 혼동하지 말고, 리터럴
  `.orange`/`.yellow`/`.blue` 대신 **의미 토큰**을 쓰며, 앱 전역 `.tint()` 금지, 본문 색에
  `.white`/`.black` 하드코딩 금지. `design-lint.sh` 가 위반을 띄운다.
- **레이아웃 변경은 눈 + 승인이 필요.** 위치/크기/간격을 건드리는 변경
  (`.frame`/`.padding`/`spacing:`/스택/…)은 실제 화면(스크린샷)으로 검증하고 커밋 전 승인을
  받아야 한다 — `CLAUDE.ko.md` 의 «레이아웃 변경» 절 참고.
- **로컬라이즈 — 10개 로케일.** `ar / en / es / fr / hi / ja / ko / pt-BR / ru / zh-Hans`,
  소스 언어 `ko`. 사용자에게 노출되는 모든 문자열은 카탈로그(`Localizable.xcstrings`)를 경유
  **하고** 10개 언어 전부로 번역돼야 한다 — 자동 추출 ≠ 번역 완료. 디버그/로깅 문자열은 대상
  아님. `i18n-lint.sh` 가 강제한다.
- **문서 — 영어·한국어 쌍.** 아래 참고.
- **에이전트 목록의 SSOT 는 픽커.** 코드 에이전트를 추가/제거하면 목록을 노출하는 모든 표면을
  함께 갱신해야 한다. `agent-surfaces-lint.sh` 가 픽커와 대조한다.

## 문서 — 영어·한국어 쌍 (필수)

레포 문서는 **두 언어 모두** 유지하며 영어가 1차다. 문서 `NAME.md` 의 한국어판은 같은
디렉터리의 `NAME.ko.md` 이고, **첫 본문 줄**은 언어 스위처 헤더다:

- 영어 파일: `**English** · [한국어](NAME.ko.md)`
- 한국어 파일: `[English](NAME.md) · **한국어**`

둘은 **같은 커밋에서** 함께 갱신해 드리프트를 막는다. `doc-pair-lint.sh` 가 짝·헤더·영어 1차
슬롯 역전을 게이트한다. (법무 파일 — `LICENSE.md`·`CLA.md` — 은 예외로 분리하지 않는 단일
바이링궐 파일이다.)

## 커밋 & PR 컨벤션

- 작업은 **`main` 에서 브랜치**를 따고, PR 도 `main` 에 연다.
- **커밋 메시지**는 [Conventional Commits](https://www.conventionalcommits.org/)
  (`type(scope): 요약`)를 따른다 — 레포의 기존 스타일이다. 커밋은 하나의 변경에 집중한다.
- **문서 쌍을 같은 커밋에서 동기화**(위)하고, **앱 버전을 올리지 마라**(메인테이너 전용).
- PR 은 하나의 변경으로 한정하고, *무엇을·왜* 를 적으며, UI/레이아웃 변경엔 before/after
  스크린샷을 첨부한다.

### PR 체크리스트

아래를 PR 설명에 복사하고 해당 항목을 체크하세요:

```
- [ ] CLA.md 를 읽고 동의했다(Signatories 표 서명 또는 이메일 수락).
- [ ] 변경이 빌드된다(iOS / Mac / 데몬 / 웹 — 건드린 것).
- [ ] `./scripts/i18n-lint.sh --strict` 통과(새 노출 문자열을 10개 로케일 전부 번역).
- [ ] `./scripts/doc-pair-lint.sh` 통과(새로/수정된 문서에 EN+KO 쌍 + 스위처 헤더, 같은 커밋).
- [ ] 해당하는 휴리스틱 lint 통과: design-lint(UI 색) / agent-surfaces-lint(에이전트 목록) / po-agent-lint(PO spawn).
- [ ] `cd mac/daemon && npm test` 통과(데몬을 건드렸다면).
- [ ] 비밀을 커밋하지 않았다(gitleaks 청정).
- [ ] UI/레이아웃 변경을 실제 화면에서 before/after 스크린샷으로 검증했다.
- [ ] 앱 마케팅 버전을 올리지 않았다(메인테이너 전용).
```

## 질문 & 신고

- **질문·공유·버그 신고:** 공개
  [GitHub Discussions](https://github.com/Wayne-Kim/pocket-sisyphus/discussions).
- **보안 취약점:** [`docs/SECURITY.ko.md`](docs/SECURITY.ko.md) 를 따른다 — 취약점은 공개
  이슈로 열지 **마라**.
