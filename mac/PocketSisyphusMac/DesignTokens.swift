import SwiftUI

/// Mac 앱 의미-색(semantic color) 레이어 — iOS `DesignSystem/DesignTokens.swift` 의 `Theme`
/// 색상 정책(SSOT)을 «그대로» 미러한다. Mac 은 그동안 별도 Theme 없이 raw hue(`Color.orange`/
/// `.yellow`)를 직접 써서, 정적 린트가 «의미» 를 판별 못 해 warning↔pro 혼동이 출시 후 디자이너
/// 리뷰에서만 비결정적으로 잡혔다. 호출부가 hue 가 아닌 «의미» 를 적게 해, `scripts/design-lint.sh`
/// 가 raw 리터럴을 다시 후보로 잡을 수 있게 한다.
///
/// ## 값은 iOS SSOT 와 «정확히» 일치 = 픽셀 불변
/// iOS `Theme` 가 쓰는 SwiftUI 표준색(`Color.green`/`.red`/`.yellow`/`.blue`/`.orange`)은
/// Apple 플랫폼에서 시스템 팔레트(`systemGreen`/…)와 «동일한» 다이내믹 색이다(라이트/다크 자동
/// 적응). 그래서 아래는 그 표준색을 그대로 가리킨다 — iOS 와 1:1, 그리고 Mac 이 지금 쓰는 raw
/// 리터럴(`Color.orange` 등)과도 1:1 이라, 리터럴을 이 토큰으로 바꿔도 화면이 1px 도 안 바뀐다.
/// (괄호 안 hex 는 라이트 모드 기준 systemXxx 값 — 다이내믹이라 다크에선 다른 변형으로 자동 전환.)
///
/// ## 색상 정책 (반드시 읽고 지킬 것 — 색을 새로 칠하기 전에)
/// 이 앱의 색은 «의미» 로 쓴다. hue 자체가 약속이라, 아무 데나 hue 를 바르면 같은 색이 엉뚱한
/// 의미로 번진다(과거 warning 을 장식용 주황으로 남용 → 색 정책 바꿀 때 사방이 노랑/주황으로
/// 잘못 물든 사고가 있었다). 새 색을 칠할 땐 «의도» 에 맞는 토큰을 고른다:
///
///   • accent (보라)  : 브랜드/선택/주요 인터랙티브. 기본 틴트. → `Color.accentColor`(AccentColor 에셋).
///   • success(초록)  : 성공·활성·추가(+).
///   • danger (빨강)  : 위험·에러·삭제·파괴적 동작.
///   • warning(노랑)  : «진짜 경고/주의» 전용. (버전 mismatch·파일 경고·cron 오류·설정 필요)
///                      ⚠️ 장식·강조·그룹핑에 쓰지 말 것 — 경고가 아닌 곳이 노래진다.
///   • info   (파랑)  : 정보·보조 강조. 이 앱에서 파랑은 거의 안 쓴다(info·노드 end 정도).
///   • pro    (주황)  : «주황 = 프로/프리미엄/고급» 약속색. 경고가 아니라 «강조» 다.
///
/// 핵심 규칙 ①: warning(노랑)과 pro(주황)는 «절대» 혼동하지 않는다. hue·의미가 다르다. 주황은
/// 오직 pro 로만, 노랑은 오직 warning 으로만. (한 색이 두 의미를 겸하면 안 된다 — 그래서 분리.)
///
/// 핵심 규칙 ②: 시스템 «기본 액센트» 는 `AccentColor` 에셋 = 보라(#9A5ABF) 다 — iOS·Mac 양쪽
/// 같은 값. 그래서 색을 «안 정한» 기본 컨트롤(버튼·토글·피커·선택 체크·탭 선택·링크)은 «자동으로»
/// 보라가 된다. Mac 에서 파랑을 accent 로 쓰지 말고 `Color.accentColor`(= `Theme.accent`)를 쓴다.
///
/// 하지 말 것: 앱 «전역» `.tint()` 로 깔기(본문/아이콘까지 보라로 물든 사고 이력). 본문 텍스트/
/// 아이콘은 `Color.primary`/`.secondary`/`.tertiary`(자동 적응)를 쓰고 `.white`/`.black` 을
/// 하드코딩하지 않는다. `onAccent`(흰색)는 «색 배경 위» 텍스트 전용.
enum Theme {

    // MARK: - 주력색 (보라 액센트 · 액센트 위 콘텐츠)

    /// 브랜드 액센트(보라 #9A5ABF). iOS `Theme.accent` 미러 — 두 앱 모두 같은 AccentColor 에셋
    /// (#9A5ABF)을 가리키게 `Color.accentColor` 경유. 색 안 정한 기본 컨트롤이 쓰는 시스템 기본
    /// 액센트와 같은 보라로 보인다.
    static let accent = Color.accentColor

    /// 액센트색 위에 얹는 콘텐츠(텍스트·아이콘·스피너). 색 배경 위 전용 — 두 테마 모두 흰색 고정.
    static let onAccent = Color.white

    // MARK: - 의미 상태색
    // 기능적 의미가 서로 달라(추가 vs 삭제 vs 주의) 하나로 통합하지 않는다. 위 «색상 정책» 의
    // 약속을 그대로 따른다 — 장식 목적으로 status 색을 빌려 쓰지 않는다.

    /// 성공·활성·추가(+). iOS `Theme.success` 미러. (#34C759 systemGreen, 라이트)
    static let success = Color.green
    /// 위험·에러·삭제(−)·파괴적 동작. iOS `Theme.danger` 미러. (#FF3B30 systemRed, 라이트)
    static let danger = Color.red
    /// ⚠️ «진짜 경고/주의» 전용(노랑). 버전 mismatch·파일 경고·cron 오류·«설정 필요» 등. 장식·
    /// 강조·그룹핑엔 쓰지 말 것 — 그러면 경고가 아닌 UI 가 노래진다. 강조는 `pro` 를 쓴다.
    /// iOS `Theme.warning` 미러. (#FFCC00 systemYellow, 라이트)
    static let warning = Color.yellow
    /// 정보·보조 강조. iOS `Theme.info` 미러. (#0A84FF systemBlue, 다크 변형)
    static let info = Color.blue

    // MARK: - 프로/강조색 (주황)
    /// «주황 = 프로/프리미엄/고급» 약속색. 멤버십 전용 기능(워크플로우·예약 작업)과 «고급» 묶음
    /// (터미널·로컬 LLM 도구, 채팅 도구 칩)에 쓴다. warning(노랑·경고)과 «의미가 다르다» — 경고가
    /// 아니라 강조다. 둘을 혼동 금지. iOS `Theme.pro` 미러. (#FF9500 systemOrange, 라이트)
    static let pro = Color.orange
}
