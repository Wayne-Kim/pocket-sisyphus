[English](CLAUDE.md) · **한국어**

# pocket-sisyphus — 프로젝트 컨벤션

## 색상 토큰 정책 (필수)

색은 «의미» 로 쓴다 — hue 자체가 약속이다. 단일 정의는 iOS `ios/PocketSisyphus/DesignSystem/DesignTokens.swift` 의 `Theme` (맨 위 «색상 정책» 주석 블록이 SSOT). Mac 앱(`mac/PocketSisyphusMac`)은 별도 `Theme` 가 없어 리터럴 색을 쓰되 **같은 약속**을 따른다.

- **accent = 보라** : 브랜드/선택/주요 인터랙티브. 기본 틴트. **두 앱의 `AccentColor` 에셋(시스템 purple)이 «통일된» accent 토큰** — 색 안 정한 기본 컨트롤(버튼·토글·피커·선택 체크·탭 선택·링크)은 이 에셋 덕에 자동으로 보라가 된다. iOS는 `Theme.accent`, Mac은 `Color.accentColor` 로 같은 값을 쓴다. **파랑은 거의 안 쓴다**(info·노드 end 정도). 「닫기/취소」 같은 해제 버튼과 「피커 선택값」 텍스트는 강조색이 아니라 **`Color.primary`(중립, 라이트=검정·다크=흰색)** 로 둔다.
- **success = 초록 / danger = 빨강 / info = 파랑** : 상태 신호색.
- **warning = 노랑** : *진짜 경고/주의 전용* (버전 mismatch·파일 경고·cron 오류·«설정 필요»). **장식·강조·그룹핑에 절대 쓰지 말 것.**
- **pro = 주황** : *«주황 = 프로/프리미엄/고급» 약속색.* 멤버십/영구이용권 전용 기능(워크플로우·예약 작업)과 «고급» 으로 묶는 요소(터미널·로컬 LLM 도구, 채팅 도구 칩, 세션 알림 음소거). 경고가 아니라 **강조**.
- **노드 종류색(`Theme.Node`)** : 시작=초록·작업=분홍·종료=파랑. 캔버스 카드 + 추가 메뉴 공통. iOS `editorTypeColor` 와 Mac `wfTypeColor` 를 **항상 같이** 맞춘다.

핵심 규칙 (어겨서 사고난 이력 있음):
1. **warning(노랑)과 pro(주황)를 혼동 금지.** 주황은 오직 pro, 노랑은 오직 warning. 한 색을 두 의미로 겸하지 않는다(장식용으로 status 색 빌려쓰기 금지 — 색 정책을 바꿀 때 엉뚱한 곳이 물든다).
2. **워크플로우는 «탭 버튼» 만 주황** (alwaysOriginal 아이콘). 탭 «안» 의 일반 버튼(설정/도움말/추가/저장 등)은 기본 틴트(accent)를 그대로 — 탭 콘텐츠에 `.tint(pro)` 를 걸지 않는다(콘텐츠까지 주황으로 번진다).
3. 색을 새로 칠하기 전에 DesignTokens 의 정책 주석을 먼저 읽고, 리터럴 `.orange`/`.yellow`/`.blue` 대신 의미 토큰을 쓴다.
4. **«파랑» 이 보이면 거의 다 «accent 누락»** — 기본 컨트롤은 `AccentColor` 에셋(보라)이 잡는다. Mac 에서 리터럴 `Color.blue` 를 accent 로 쓰지 말고 `Color.accentColor` 를 쓴다. **앱 전역 `.tint()` 금지** — 원래 흰색/primary 이던 텍스트까지 보라로 물든 사고 이력 있음. 본문 텍스트/아이콘은 `.primary`(자동 적응), `.white`/`.black` 하드코딩 금지.

## 레이아웃 변경 — 눈으로 검증 + 개발자 승인 (필수)

**SwiftUI 레이아웃에 영향 주는 변경을 했으면, «눈으로 확인하지 않고 커밋하지 않는다».** 코드만 보고 «맞겠지» 하고 넘기면 화면에서야 깨진 걸 발견한다 (아래 사고 이력).

레이아웃 변경 = `.frame` / `.padding` / `spacing:` / `.offset` / `.position` / `HStack`·`VStack`·`ZStack`·`Lazy*`·`Grid` / `Spacer` / `alignment:` / `GeometryReader` / `.fixedSize` / `.layoutPriority` / `.aspectRatio` 등 위치·크기·간격·배치를 건드리는 모든 것. (색·폰트만 바꾸는 «그리기» 변경은 해당 없음.)

절차 (이걸 다 거친 뒤에만 커밋):
1. **빌드·설치·실행 + 스크린샷** — `/verify-ios`(시뮬레이터) 또는 `/device`·`/dev`(실기기) 로 실제 화면을 띄우고 캡처한다.
2. **before/after 첨부 보고** — Claude 가 스크린샷을 «읽어» 바뀐 화면을 눈으로 확인하고, 변경 전/후를 개발자에게 첨부해 보고한다.
3. **개발자 승인** — `AskUserQuestion` 으로 «이대로 OK / 더 고칠 것» 승인을 받은 뒤에만 커밋한다.

핵심 함정 (어겨서 사고난 이력 있음 — `f756c74` → `e455805`):
1. **`.frame(minWidth:/minHeight:)` 는 «탭 영역» 이 아니라 «레이아웃 점유 면적» 을 키운다.** 28pt 짜리 `ChatKeyButton`(채팅 가상키·이미지첨부 버튼)에 a11y 목적으로 `.frame(minWidth: 44, minHeight: 44)` 를 씌웠더니, 작은 시각 박스가 44pt 셀 가운데 떠 버튼마다 좌우 ~16pt 죽은 공간 → 도구·키패드가 전부 벌어졌다. 탭 타깃만 넓히려면 시각 크기 자체를 키우거나, 밀집 키엔 HIG 44pt 예외를 따른다.
2. **공용 컴포넌트는 «쓰는 모든 화면» 에 번진다.** `ChatKeyButton` 은 채팅 + 미러링 컨트롤 바에서 공유 — 한 곳을 고치면 양쪽을 다 확인한다.
3. `.claude/hooks/guard-layout-change.sh` 가 PostToolUse 로 레이아웃 토큰 편집을 감지해 위 절차를 리마인드한다. 순수 로직 변경이면 안 걸린다.

## iOS 다국어 (필수)

iOS 앱은 10개 언어를 지원한다: `ar / en / es / fr / hi / ja / ko / pt-BR / ru / zh-Hans`. 소스 언어는 `ko`, 카탈로그는 `ios/PocketSisyphus/Localizable.xcstrings`. **사용자 화면에 노출되는 한국어 문자열을 새로 추가할 때는 반드시 카탈로그를 거치게 한다.** 안 그러면 영어 로케일에서도 ko 원문이 그대로 보인다.

### 무엇이 «사용자 노출» 인가
- `Text`, `Button`, `Label`, `Picker`, `TextField` placeholder, `Alert` title/message, `confirmationDialog` title, `Section` header/footer, `.navigationTitle`, `.help`, `.accessibilityLabel`, toast/sheet 안 안내문 등 SwiftUI 가 화면에 그리는 모든 문자열.
- `Error.errorDescription`, `LocalizedError`, `ViewModel` 의 `lastError` 같이 화면에 표시될 가능성이 있는 String.
- *디버그/로깅 (`print`, `NSLog`, `os_log`, `Logger().info/debug/error/...`, `[Tag] ...` prefix 패턴) 은 노출 아님 → 한국어 그대로 둬도 무방.*

### 자동 localize 가 «작동하는» 패턴 (이대로 쓰면 카탈로그가 알아서 잡아준다)

```swift
Text("세션을 만들어요")                  // ✅ Text 의 init 이 LocalizedStringKey 를 받음
Button("저장") { ... }                    // ✅
Label("글자 작게", systemImage: "...")    // ✅
.navigationTitle("설정")                  // ✅
.accessibilityLabel("닫기")               // ✅
Text("커밋되지 않은 변경 \(count)개")     // ✅ 보간도 자동 (\(count) → %lld 키로 추출)
```

### 자동 localize 가 «작동하지 않는» 안티패턴 (보이면 즉시 고친다)

```swift
// ❌ String 변수 경유 — Text(_:String) init 으로 가서 localize 안 됨
let title = "설정"
Text(title)
//   ↓ 고치는 법: title 의 타입을 LocalizedStringKey 로
let title: LocalizedStringKey = "설정"
Text(title)

// ❌ ternary 가 String 으로 추론될 수 있음 → 둘 다 카탈로그 미진입
Text(loading ? "불러오는 중…" : "준비됨")
//   ↓ Text 두 개로 분리해 각각 LocalizedStringKey 추출 경로를 타게
loading ? Text("불러오는 중…") : Text("준비됨")
.accessibilityLabel(loading ? Text("로딩 중") : Text("완료"))

// ❌ enum 의 description / errorDescription 에 한국어 raw String
case .authFailed: return "SSH 인증 실패"
//   ↓ String(localized:) 로 카탈로그 키 만들기
case .authFailed: return String(localized: "SSH 인증 실패")

// ❌ ViewModel 프로퍼티에 한국어 raw 할당 (UI 가 그대로 표시)
self.lastError = "구매 실패: \(error.localizedDescription)"
//   ↓ String(localized:) — 보간도 그대로 통과
self.lastError = String(localized: "구매 실패: \(error.localizedDescription)")

// ❌ struct field 가 String + Text(field) 로 노출
struct EmptyStateView: View {
    let title: String
    var body: some View { Text(title) }
}
//   ↓ field 타입을 LocalizedStringKey 로 (호출부의 string literal 은 그대로)
struct EmptyStateView: View {
    let title: LocalizedStringKey
    var body: some View { Text(title) }
}

// ❌ nested string interpolation — 자동 추출기가 키를 잡지 못함
return String(localized: "타입 불일치 \("\(type)")")
//   ↓ 변수로 분리
let typeStr = "\(type)"
return String(localized: "타입 불일치 \(typeStr)")

// ❌ Text(verbatim:) — 의도적 우회. 코드 / 식별자 / onion 주소처럼 «정말로 번역 대상이 아닌» 것만.
```

### 카탈로그에 키 추가 + 10개 언어 번역

Xcode 빌드 시 LocalizedStringKey 자동 추출은 동작하지만, **추출됐다고 곧 번역된 게 아니다** — 모든 언어 `value` 가 비어 있으면 영어 로케일에서도 ko 원문이 fallback 으로 보인다. 새 문자열을 박은 후엔 카탈로그에 진짜로 10개 언어가 다 채워졌는지 확인한다.

대량 추가/보강은 `/tmp/i18n_patch_v2.py` 패턴을 따른다 (작업 이력은 commit `d3ba2a3` 참고): `ENTRIES = [(ko_key, {lang: value, ...}), ...]` 형태로 적고 한 번에 카탈로그에 머지. 비번역 대상 (`Pocket Sisyphus`, `한국어`, `PTY`, `·`, `•`, 단위 등) 은 모든 언어에 동일 원문.

검증: `xcodebuild ... build` 통과 + 시뮬레이터에서 영어 로케일로 켜서 한글 잔존 없는지 확인.

### 체크리스트 — 새 문자열 추가 시

1. SwiftUI 자동 localize 패턴인가? (Text/Button/Label/...) → 그냥 string literal 로 적는다.
2. 자동 localize 가 안 닿는 자리인가? (변수, ternary, struct field, enum return, ViewModel 프로퍼티) → 위 «안티패턴» 표 보고 형태를 바꾼다.
3. ko 원문 외에 9개 언어 번역을 카탈로그에 채웠는가?
4. 디버그/로깅 한국어는 카탈로그 대상 아님 — 그대로 둬도 OK.

## Mac 다국어 (필수)

**Mac 앱도 iOS 와 똑같이 다국어가 «필수»다.** 같은 10개 언어(`ar / en / es / fr / hi / ja / ko / pt-BR / ru / zh-Hans`), 소스 언어 `ko`, 카탈로그는 `mac/PocketSisyphusMac/Localizable.xcstrings` (`project.yml` 의 `knownRegions` 가 SSOT). iOS 의 SwiftUI 자동 localize 패턴·안티패턴·체크리스트가 그대로 적용된다 — Mac 도 SwiftUI 라 `Text("…")`/`Label`/`Button`/`.alert`/`LocalizedStringKey` 필드가 자동 추출 대상이다.

함정 (실제로 새 화면을 추가하며 ko 만 보이던 이력 있음 — QR 창 단일기기 안내·설정 「권한」 탭):
- **자동 추출 ≠ 번역 완료.** 새 Mac 문자열을 박았으면 `mac/PocketSisyphusMac/Localizable.xcstrings` 에 9개 언어 `value` 가 실제로 채워졌는지 반드시 확인한다. 비어 있으면 모든 비-한국어 로케일에서 ko 원문이 그대로 노출된다.
- 새 «화면/탭» 을 통째로 추가했다면 그 화면의 모든 노출 문자열을 카탈로그와 교차 점검(키 존재 + 10개 언어 채움)한다.
- 대량 추가는 iOS 와 같은 `ENTRIES = [(ko_key, {lang: value, …}), …]` 머지 스크립트 패턴을 쓰되 경로만 Mac 카탈로그로. 검증: `xcodebuild -scheme PocketSisyphusMac build` 통과 + 비-ko 로케일로 켜서 한글 잔존 없음 확인.
- 비번역 대상(코드/식별자/onion/단위 등)은 iOS 와 동일하게 모든 언어에 동일 원문 또는 `Text(verbatim:)`.

## 문서 — 영어·한국어 두 버전 유지 (필수)

저장소 문서와 추적되는 Claude 스킬은 **영어·한국어 두 버전**으로 유지한다. (위 «앱 다국어» 섹션과는 별개 — 그건 앱 UI 노출 문자열 얘기고, 여기는 *저장소 문서* 얘기다.) 문서를 새로 만들거나 크게 고치면 두 버전을 다 낸다.

- **영어가 기본.** 문서 `NAME.md` 의 영어판은 `NAME.md`, 한국어판은 같은 디렉토리의 `NAME.ko.md` — 예: `README.md` / `README.ko.md`, `docs/ARCHITECTURE.md` / `docs/ARCHITECTURE.ko.md`, `.claude/skills/<name>/SKILL.md` / `SKILL.ko.md`.
- **언어 스위처 헤더** 를 본문 첫 줄에(스킬은 YAML frontmatter «다음» 첫 줄), 그 뒤 빈 줄:
  - 영어 파일: `**English** · [한국어](NAME.ko.md)`
  - 한국어 파일: `[English](NAME.md) · **한국어**`
- **상호 링크는 그 파일의 언어를 따른다**: 영어 파일 안에서 형제 번역 문서로 가는 링크는 `.md` 경로, `.ko.md` 파일 안에서는 `.ko.md` 경로.
- **두 버전을 같이 갱신.** 한쪽 언어를 바꾸면 **같은 커밋**에서 다른 쪽도 갱신 — 드리프트 금지.
- **스킬은 기능 파일.** Claude Code 가 로드하는 건 `SKILL.md` 뿐이고, 그 YAML `description` 이 호출 트리거(한국어 문구 포함)를 담는다. frontmatter 는 **byte-for-byte** 그대로 두 파일에 복사하고 본문만 번역한다. `SKILL.ko.md` 는 로드되지 않는 참고용 사본.
- **법무 파일은 예외**(`LICENSE.md`, `CLA.md`): *한 파일* 안에 영어 정본 + 한국어 «비공식 요약» 으로 둔다. 쪼개지 않는다(쪼개면 어느 쪽이 정본인지 모호해진다).
- **라이선스 표현**: 이 저장소는 공개지만 **독점 / source-available — 오픈소스 아님**, 공개 ≠ 상업 이용 허가. 문서가 이를 흐리게 쓰면 안 된다.

운영/메인테이너 전용 스킬(`deploy`, `deploy-web`, `submitting`)은 gitignore 라 공개 저장소에 없으므로 두 버전이 필요 없다.

## 빌드 / 배포

배포·릴리스(TestFlight / Developer ID DMG)와 버전 bump 은 **메인테이너 전용 절차**다 — 공개 저장소엔 두지 않는다.
