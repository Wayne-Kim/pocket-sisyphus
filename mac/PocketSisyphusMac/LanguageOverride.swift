import Foundation
import AppKit

/// Mac 측 앱 언어 override — UserDefaults `AppleLanguages` 키에 단일 BCP-47 코드를
/// 박고 앱을 self-relaunch 시킨다.
///
/// iOS 와 동일한 메커니즘이지만 Mac 에서는 `exit(0)` 후 사용자가 직접 다시 띄울 필요
/// 없이, NSWorkspace 로 자기 자신을 `open` 한 뒤 종료하면 자동 relaunch 가 된다.
@MainActor
enum LanguageOverride {
    /// 사용자가 명시적으로 박은 단일 override 가 있으면 그 코드, 아니면 nil.
    /// (iOS 동일 정책: 다중 priority list 면 시스템 기본으로 간주)
    static var current: String? {
        guard let arr = UserDefaults.standard.array(forKey: "AppleLanguages") as? [String],
              arr.count == 1 else {
            return nil
        }
        return arr.first
    }

    /// nil = 시스템 언어로 되돌리기 (AppleLanguages 키 자체 제거).
    /// non-nil = 그 단일 코드를 priority list 로 박는다. 다음 부팅에 적용됨.
    static func set(_ code: String?) {
        if let code {
            UserDefaults.standard.set([code], forKey: "AppleLanguages")
        } else {
            UserDefaults.standard.removeObject(forKey: "AppleLanguages")
        }
        UserDefaults.standard.synchronize()
    }

    /// 우리 자신을 새 프로세스로 띄운 뒤 현재 프로세스 종료. 결과적으로 메뉴바 앱이
    /// 자동으로 다시 떠서 새 언어로 부팅된다.
    ///
    /// daemon 자식 프로세스는 DaemonManager.terminateSynchronously 가 willTerminate
    /// 옵저버에서 처리하므로 별도 처리 불필요.
    static func relaunchSelf() {
        let bundleURL = Bundle.main.bundleURL
        let task = Process()
        task.launchPath = "/usr/bin/open"
        task.arguments = ["-n", bundleURL.path]
        do {
            try task.run()
        } catch {
            NSLog("[LanguageOverride] relaunch open 실패: \(error)")
        }
        // 살짝 텀을 주고 종료 — open 프로세스가 fork 를 끝낼 시간.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
            NSApp.terminate(nil)
        }
    }

    /// 메뉴 표시용 (코드, 자기 모국어 표기) 쌍. iOS LanguagePickerSheet 와 동일 순서.
    static let languages: [(code: String, name: String)] = [
        ("ko",      "한국어"),
        ("en",      "English"),
        ("zh-Hans", "简体中文"),
        ("ja",      "日本語"),
        ("es",      "Español"),
        ("fr",      "Français"),
        ("hi",      "हिन्दी"),
        ("ar",      "العربية"),
        ("pt-BR",   "Português (Brasil)"),
        ("ru",      "Русский"),
    ]
}
