import SwiftUI

/// 사용자가 고른 앱 테마. 시스템 따라가기 / 라이트 / 다크 3택.
///
/// 앱은 원래 `PocketSisyphusApp` 의 `.preferredColorScheme(.dark)` 로 다크에 고정돼 있었다.
/// 이제 이 enum 의 선택값(@AppStorage 단일 키 `storageKey`)을 그 자리에 흘려보내 사용자가
/// 테마를 고른다 — `.system` 이면 nil 을 넘겨 기기 설정(다크/라이트)을 그대로 따라간다.
///
/// 색은 대부분 시스템 의미색(`.primary` / `.secondary`, `systemBackground` 등) · `Theme` 토큰
/// (`Color.purple` 등 라이트/다크 자동 적응) · opacity 틴트라 라이트에서도 올바른 명도가 나온다.
/// (예외: 터미널 PTY 는 코드 가독성 관례상 다크 고정 — `ChatView.PtyTerminalView`.)
enum ThemeMode: String, CaseIterable, Identifiable {
    case system
    case light
    case dark

    var id: String { rawValue }

    /// @AppStorage 키. 기본값은 `.system` — 기기 설정을 따른다.
    static let storageKey = "ui.themeMode"

    /// SwiftUI `.preferredColorScheme` 인자. `.system` 은 nil → 기기 설정에 위임.
    var colorScheme: ColorScheme? {
        switch self {
        case .system: return nil
        case .light: return .light
        case .dark: return .dark
        }
    }

    /// 피커에 표시할 라벨 (카탈로그 자동 localize 대상 — LocalizedStringKey).
    var label: LocalizedStringKey {
        switch self {
        case .system: return "시스템 따라가기"
        case .light: return "라이트"
        case .dark: return "다크"
        }
    }
}
