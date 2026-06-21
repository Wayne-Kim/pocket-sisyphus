import SwiftUI
import UIKit

/// 앱 전역 디자인 토큰 — 색·간격·코너·불투명도를 한곳에서 관리해 화면 간 통일성을 보장한다.
///
/// ## 설계 원칙
/// 1. **호출부는 의미(semantic)만 안다.** `Theme.accent`, `Theme.success` 처럼 «무슨 역할인지»
///    로 부르고, «무슨 색인지(.purple/.green)» 는 이 파일만 안다. 그래서 브랜드색을 바꿔도
///    호출부를 한 줄도 안 건드린다.
/// 2. **현재 값은 기존 코드와 1:1 별칭.** 토큰 도입 시점에 화면이 1px도 바뀌지 않도록,
///    아래 색들은 마이그레이션 전 코드가 쓰던 SwiftUI 표준색을 그대로 가리킨다. «핑크 톤을
///    더 핑크답게» 같은 실제 색 조정은 이 파일에서 값만 바꾸면 앱 전체에 전파된다.
/// 3. **다크/라이트 둘 다 지원.** 앱 테마는 `PocketSisyphusApp` 이 `themeMode`(시스템·라이트·
///    다크)로 정하고 기본은 «시스템 따라가기» 다 — 라이트 모드로도 켜진다. 그러니 색은 «두 테마
///    모두에서 대비가 맞는지» 로 고른다. **본문 텍스트/아이콘은 `Color.primary`/`.secondary`/
///    `.tertiary`(시스템 적응색 — 다크=흰색·라이트=검정으로 «자동» 전환)를 쓰고, `.white`/`.black`
///    을 하드코딩하지 않는다** (하드코딩하면 반대 테마에서 안 보인다). 아래 토큰의 SwiftUI 표준색
///    (.purple/.green/…)도 라이트/다크 변형을 자동으로 갖는다. `onAccent`(흰색)는 «색 배경 위»
///    전용이라 두 테마 모두 흰색이 맞다 — 본문 색으로 쓰지 말 것.
enum Theme {

    // ========================================================================
    // MARK: 색상 정책 (반드시 읽고 지킬 것 — 색을 새로 칠하기 전에)
    // ========================================================================
    // 이 앱의 색은 «의미» 로 쓴다. hue 자체가 약속이라, 아무 데나 hue 를 바르면 같은 색이
    // 엉뚱한 의미로 번진다(과거 warning 을 장식용 주황으로 남용 → 색 정책 바꿀 때 사방이
    // 노랑/주황으로 잘못 물든 사고가 있었다). 새 색을 칠할 땐 «의도» 에 맞는 토큰을 고른다:
    //
    //   • accent (보라)  : 브랜드/선택/주요 인터랙티브. 기본 틴트.
    //   • success(초록)  : 성공·활성·추가.
    //   • danger (빨강)  : 위험·에러·삭제·파괴적 동작.
    //   • warning(노랑)  : «진짜 경고/주의» 전용. (버전 mismatch·파일 경고·cron 오류·설정 필요)
    //                      ⚠️ 장식·강조·그룹핑에 쓰지 말 것 — 경고가 아닌 곳이 노래진다.
    //   • info   (파랑)  : 정보·보조 강조.
    //   • pro    (주황)  : «주황 = 프로/프리미엄/고급» 약속색. 경고가 아니라 «강조» 다.
    //
    // 핵심 규칙 ①: warning(노랑)과 pro(주황)는 «절대» 혼동하지 않는다. hue 가 다르고 의미가 다르다.
    // 주황은 오직 pro 로만, 노랑은 오직 warning 으로만. (둘 다 같은 색이면 안 된다 — 그래서 분리.)
    //
    // 핵심 규칙 ②: 시스템 «기본 액센트» 는 `AccentColor` 에셋 = 보라(#9A5ABF) 다. 이게 곧
    // iOS·Mac 양쪽에서 «통일된» accent 토큰이다 (두 앱 Assets.xcassets 의 AccentColor.colorset 을
    // 같은 값으로 둔다). 그래서 색을 «안 정한» 기본 컨트롤(버튼·토글·피커·선택 체크·탭 선택·링크·
    // List 의 accent 아이콘 등)은 «자동으로» 보라가 된다 — 옛날엔 AccentColor 에셋이 없어 시스템
    // 기본 «파랑» 이 떴다. 이 앱에서 파랑은 거의 안 쓴다(info/노드 end 정도만).
    //
    // 하지 말 것: 앱 «전역» SwiftUI `.tint()` 로 깔기 → 원래 `.primary`(다크=흰·라이트=검 자동)
    // 이던 본문/아이콘까지 보라로 물든다(사고 이력 있음). 기본 컨트롤 색은 AccentColor 에셋이
    // 알아서 잡으니 따로 전역 tint 가 필요 없다. «해제/취소/닫기» 텍스트 버튼과 «피커 선택값» 텍스트는
    // 강조색이 아니라 `Color.primary`(중립)로 둔다(per-element `.tint(Color.primary)`). 본문 색은
    // 절대 .white/.black 하드코딩하지 않는다(라이트/다크 자동 적응이 깨진다).
    //
    // 노드 종류색(시작/작업/종료)은 의미 상태색과 별개다 → `Theme.Node` 참고.
    // ========================================================================

    // MARK: - 주력색 (배경 · 보라 액센트 · 적응형 콘텐츠)

    /// 브랜드 액센트(보라 #9A5ABF). 선택 상태·강조 아이콘·주요 버튼 틴트·배너 그라데이션의 «단일» 기준색.
    /// **값은 `Assets.xcassets/AccentColor`(#9A5ABF)와 «동일» 해야 한다** — 명시적으로 쓰는
    /// 이 토큰과, 색 안 정한 기본 컨트롤이 쓰는 시스템 기본 액센트가 같은 보라로 보이게. Mac 앱은
    /// 별도 Theme 가 없지만 같은 AccentColor 에셋(=같은 #9A5ABF) + `Color.accentColor` 로 통일한다.
    static let accent = Color(red: 0.604, green: 0.353, blue: 0.749)  // #9A5ABF

    /// 액센트색 위에 얹는 콘텐츠(텍스트·아이콘·스피너). 다크/액센트 배경 모두에서 흰색 고정.
    static let onAccent = Color.white

    // MARK: - 의미 상태색
    // 기능적 의미가 서로 달라(추가 vs 삭제 vs 주의) 하나로 통합하지 않는다. 위 «색상 정책» 의
    // 약속을 그대로 따른다 — 장식 목적으로 status 색을 빌려 쓰지 않는다.

    /// 성공·활성·추가(+). diff 추가 라인, 활성 세션 배지, 완료 표시.
    static let success = Color.green
    /// 위험·에러·삭제(−)·파괴적 동작. diff 삭제 라인, 에러 배지, 삭제 버튼.
    static let danger = Color.red
    /// ⚠️ «진짜 경고/주의» 전용 (노랑). 버전 mismatch 배너·파일 경고·cron 오류·«설정 필요» 안내 등.
    /// 장식·강조·그룹핑에는 쓰지 말 것 — 그러면 경고가 아닌 UI 가 노래진다. 강조는 `pro` 를 쓴다.
    static let warning = Color.yellow
    /// 정보·보조 강조. diff hunk 헤더, 편집 액션 틴트.
    static let info = Color.blue

    // MARK: - 프로/강조색 (주황)
    /// «주황 = 프로/프리미엄/고급» 약속색. 멤버십·영구이용권 전용 기능(워크플로우·예약 작업)과,
    /// 시각적으로 «고급/특별» 로 묶는 요소(터미널·로컬 LLM 도구, 채팅 도구 칩, 세션 알림 음소거)에
    /// 쓴다. warning(노랑·경고)과 «의미가 다르다» — 경고가 아니라 강조다. 둘을 혼동 금지.
    /// (워크플로우 «탭 버튼» 만 주황. 그 탭 안의 일반 버튼들은 기본 틴트 accent 를 그대로 쓴다.)
    static let pro = Color.orange

    // MARK: - 노드 종류색 (워크플로우 노드 — 캔버스 카드 + 추가 메뉴 공통)
    /// 워크플로우 노드의 종류별 색. 의미 상태색(success/info 등)과 «우연히» 겹쳐도 구분해서 둔다 —
    /// 노드색을 바꿔도 상태색이 안 흔들리게. iOS `editorTypeColor` / Mac `wfTypeColor` 가 이 약속을
    /// 따라야 한다(두 곳을 항상 같이 맞춘다).
    enum Node {
        static let start = Color.green   // 시작
        static let task  = Color.pink    // 작업
        static let end   = Color.blue    // 종료
    }

    // MARK: - 워크플로우 엣지 스타일 (캔버스 연결선 — 색·두께·화살촉·점선)
    /// 워크플로우 캔버스에서 노드를 잇는 엣지(연결선)의 시각 스타일을 한곳에 모은다. 색은 의미
    /// 상태색을 «그대로 재사용» 한다 — 실패 분기=`danger`(빨강)·일반(성공/다음)=중립 회색·선택
    /// 강조=`accent`(보라). 색을 새로 발명하거나 status 색을 장식으로 빌리지 않는다. 두께·화살촉·
    /// 점선만 여기서 정의해, 신규 선 형식을 세 캔버스(iOS 읽기전용 `WorkflowCanvasView`·편집
    /// `WorkflowEditorView`, Mac `WorkflowWindow`)에 흩지 않고 한곳에서 도입한다. Mac 은 별도
    /// Theme 가 없어 `WfEdge`(WorkflowWindow.swift)가 같은 값·약속을 미러한다(파랑을 accent 로
    /// 쓰지 않음). 값은 도입 시점 실사용 값과 1:1 — 토큰화로 화면이 1px 도 바뀌지 않는다(원칙 2).
    enum Edge {
        /// 일반(성공/다음) 엣지 — 중립 회색(본문 secondary 를 옅게, 라이트/다크 자동 적응).
        static let normal = Color.secondary.opacity(0.6)
        /// 실패 분기 엣지 — 의미색 danger.
        static let fail = Theme.danger
        /// 선택된 엣지 강조 — 브랜드 accent.
        static let selected = Theme.accent

        /// 편집 캔버스 일반 엣지 두께.
        static let width: CGFloat = 1.8
        /// 읽기전용 캔버스 일반 엣지 두께(기존 값 1:1 보존 — 편집보다 한 단계 가늘다).
        static let widthReadonly: CGFloat = 1.6
        /// 선택된 엣지 강조 두께.
        static let widthSelected: CGFloat = 3.4
        /// 진행 중 연결 드래그 점선 두께.
        static let widthDrag: CGFloat = 2
        /// 화살촉 길이(일반).
        static let arrow: CGFloat = 9
        /// 화살촉 길이(선택 강조).
        static let arrowSelected: CGFloat = 12
        /// 진행 중 연결 드래그 점선 대시 패턴.
        static let dragDash: [CGFloat] = [6, 4]
    }

    // MARK: - 중립
    /// 칩/태그의 옅은 회색 채움 배경, 보조 버튼 배경.
    static let neutralFill = Color(.systemGray2)

    // MARK: - 구문 강조 (FileViewer 코드 미리보기 전용)
    /// 소스 코드 토큰 색. 다크 배경에 맞춘 채도로 미세 조정된 값이라 의미 상태색과 분리해 둔다.
    enum Syntax {
        static let string = Color(red: 0.72, green: 0.40, blue: 0.20)
        static let number = Color(red: 0.55, green: 0.30, blue: 0.70)
        static let keyword = Color(red: 0.20, green: 0.40, blue: 0.85)

        /// diff 뷰어 syntax highlighting 팔레트 — Runestone 테마(DiffSyntaxHighlighter)가 소비.
        ///
        /// 의미 상태색(success/danger/warning/pro)과는 별개의 «구문 토큰» 카테고리다 — 여기 색을
        /// 상태/장식 용도로 빌려 쓰지 말 것. 값은 Xcode 기본 테마(라이트/다크) 근사치이고,
        /// UIColor dynamic provider 라 라이트/다크 모두에서 자동 적응한다. diff 의 추가/삭제 라인
        /// 배경 tint (success/danger opacity 0.18) 위에 얹혀도 대비가 살아 있는 채도로 고른 값.
        enum Diff {
            static let keyword = adaptive(light: 0x9B2393, dark: 0xFC5FA3)
            static let string = adaptive(light: 0xC41A16, dark: 0xFC6A5D)
            static let number = adaptive(light: 0x1C00CF, dark: 0xD0BF69)
            static let comment = adaptive(light: 0x5D6C79, dark: 0x6C7986)
            static let type = adaptive(light: 0x0B4F79, dark: 0x5DD8FF)
            static let function = adaptive(light: 0x326D74, dark: 0x67B7A4)
            static let property = adaptive(light: 0x3E8087, dark: 0x78C2B3)
            static let builtin = adaptive(light: 0x804FB8, dark: 0xA167E6)

            private static func adaptive(light: UInt32, dark: UInt32) -> UIColor {
                UIColor { trait in
                    let hex = trait.userInterfaceStyle == .dark ? dark : light
                    return UIColor(
                        red: CGFloat((hex >> 16) & 0xFF) / 255,
                        green: CGFloat((hex >> 8) & 0xFF) / 255,
                        blue: CGFloat(hex & 0xFF) / 255,
                        alpha: 1,
                    )
                }
            }
        }
    }

    // MARK: - 간격 (4pt 그리드 기준, 관측된 실사용 값을 «빠짐없이 덮는 상위집합»)
    // 불변식(원칙 2): 토큰 값은 «도입 시점 실사용 리터럴» 과 1:1 이라, 리터럴을 토큰으로 바꿔도
    // 화면이 1px 도 안 바뀐다. 그러려면 토큰셋이 실사용 온그리드 값을 «빠짐없이» 덮어야 한다 —
    // 못 덮으면 토큰화가 (a) 가장 가까운 토큰으로 «반올림» 돼 픽셀이 옮겨가거나 (b) 영영 토큰화
    // 안 돼 드리프트로 남는다. 그래서 «기존 값은 절대 재지정하지 않고»(그 토큰을 쓰는 모든 화면이
    // 어긋난다), 실사용에서 발견된 «온그리드 고빈도 무토큰» 값만 «추가» 해 상위집합으로 키운다.
    // `scripts/design-lint.sh` 의 S/R 패밀리가 이 토큰값과 «정확히 일치» 하는 리터럴을 토큰화
    // 후보로, 온그리드인데 (여기) 무토큰인 값은 «토큰 추가 검토» 로, 오프그리드는 «비-그리드» 로
    // 표면화한다 — 즉 이 enum 이 그 린트의 SSOT 다.
    enum Spacing {
        static let xxs: CGFloat = 2
        static let xs: CGFloat = 4
        static let s: CGFloat = 6
        static let m: CGFloat = 8
        static let l: CGFloat = 10
        static let xl: CGFloat = 12
        static let xxl: CGFloat = 16
        static let xxxl: CGFloat = 24
        /// 보정 추가(2026-06): `.padding(…, 32)` 실사용 온그리드 고빈도값(32pt · 9건/7파일 —
        /// boot·paywall·빈 상태 등 «화면 가장자리» 큰 여백)인데 xxxl(24) 위로 토큰이 없어 매번
        /// 리터럴로 새던 값. 기존 값 재지정 없이 상위집합으로만 추가(원칙 2 — 화면 1px 불변).
        static let xxxxl: CGFloat = 32
    }

    // MARK: - 코너 반경 (관측된 실사용 값을 빠짐없이 덮는 상위집합 — Spacing 과 같은 불변식)
    enum Radius {
        static let xs: CGFloat = 4
        static let s: CGFloat = 6
        /// 보정 추가(2026-06): `cornerRadius: 8` 은 실사용 코너 리터럴 «최다»(8pt · 7건/6파일 —
        /// 카드·칩·썸네일 컨테이너)인데 s(6)→m(10) 사이를 건너뛰어 무토큰이었다. s 와 m 사이라
        /// «sm». 기존 값 재지정 없이 상위집합으로만 추가(원칙 2 — 화면 1px 불변).
        static let sm: CGFloat = 8
        static let m: CGFloat = 10
        static let l: CGFloat = 12
        static let xl: CGFloat = 16
    }

    // MARK: - 틴트 채움 불투명도
    // base 색을 옅게 깐 배경을 만들 때의 표준 단계. `Theme.accent.opacity(Theme.Opacity.badge)`.
    enum Opacity {
        /// 거의 안 보이는 구분용 채움 (코드 블록 배경 등).
        static let hairline: Double = 0.06
        /// 옅은 채움 (강조 배너 배경).
        static let fill: Double = 0.12
        /// 배지/칩 채움.
        static let badge: Double = 0.18
        /// 점선/실선 테두리.
        static let border: Double = 0.30
    }

    // MARK: - 고정 폰트 크기
    // 일반 텍스트는 시맨틱 폰트(.caption/.headline/...)를 그대로 쓴다 — Dynamic Type 을 공짜로
    // 얻으므로 토큰으로 감싸지 않는다. 여기엔 시맨틱 폰트가 못 커버하는 «고정 pt 가 필요한»
    // 자리만 모은다. 값은 도입 시점 실사용 값과 1:1 (원칙 2 — 화면이 1px 도 안 바뀐다).

    /// 아이콘 크기 — `Image(systemName:)` 에 `.font(.system(size: Theme.IconSize.l))` 로 적용.
    enum IconSize {
        /// 팝오버/칩 안 빈 상태 아이콘 (좁은 컨테이너용 한 단계 작은 크기).
        static let m: CGFloat = 36
        /// 시트/리스트 빈 상태 placeholder 아이콘.
        static let l: CGFloat = 44
        /// 전면(full-screen) 오류·경고 안내 아이콘.
        static let xl: CGFloat = 48
        /// 화면 헤더 hero 아이콘 (페이월, 비호환 안내).
        static let xxl: CGFloat = 56
        /// 부트 화면 브랜드 아이콘.
        static let xxxl: CGFloat = 64
    }

    /// 텍스트 고정 크기 — 모노스페이스 코드 뷰어, 대형 강조 숫자처럼 시맨틱 폰트로 못 정하는 자리.
    enum FontSize {
        /// 코드 뷰어 줄번호 거터 (모노스페이스, 본문보다 한 단계 작게).
        static let codeGutter: CGFloat = 11
        /// 코드 뷰어 본문 (모노스페이스).
        static let code: CGFloat = 12
        /// 대형 강조 숫자 — 가격 표시 등.
        static let stat: CGFloat = 36
    }
}
