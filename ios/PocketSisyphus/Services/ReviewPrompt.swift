import SwiftUI
import StoreKit  // SwiftUI + StoreKit 둘 다 있어야 _StoreKit_SwiftUI overlay 의 RequestReviewAction 이 보인다.

/// App Store 리뷰 요청 게이트.
///
/// 정책 — «좋은 경험을 한 충성 사용자에게만, 그 직후에» 묻는다:
/// - gate (누구에게): 세션(채팅방)을 직접 2개 이상 만들었다 **AND** 앱을 서로 다른 날
///   2일 연속 켰다. 단순 «열었다 닫기» 가 streak 만 채우는 걸 막으려 «세션 생성» 을 함께 요구.
/// - trigger (언제): 세션 생성 성공 «직후» (성취의 순간). 콜드 런치/에러 직후가 아님.
/// - 1회 보장: 마지막으로 요청한 앱 버전을 저장 → 같은 버전에선 다시 안 묻는다. iOS 자체도
///   1년 3회 + 동일 버전 1회로 스로틀하므로 이중 안전망. (버전이 올라가면 다시 «무장» 된다 —
///   충성 사용자에게 메이저 업데이트 후 1회 재요청은 바람직. 진짜 «평생 1회» 로 묶고 싶다면
///   `lastRequestedVersion` 비교 대신 별도 bool 플래그로 바꾸면 된다.)
///
/// **Keychain 을 쓰지 않는 이유**: 리뷰 요청 진척도는 비밀이 아니고, 앱을 지웠다 다시 깔아
/// 또 충성 사용자가 되면 한 번 더 물어도 무방하다(재설치 시 초기화가 오히려 바람직). 이 앱은
/// 이미 Keychain 기반 추적을 의식적으로 걷어냈다(PocketSisyphusApp 의 «앱 자체 Keychain 체험
/// 제거» 참고). 그래서 가벼운 UserDefaults 로 충분.
@MainActor
enum ReviewPrompt {
    private enum Key {
        static let sessionsCreated = "review.sessionsCreated"
        /// 마지막으로 앱이 active 였던 «날» (현지 달력 startOfDay 의 timeIntervalSinceReferenceDate).
        static let lastActiveDay = "review.lastActiveDay"
        static let consecutiveDays = "review.consecutiveDays"
        /// 마지막으로 리뷰를 요청한 marketing 버전. 같으면 재요청 안 함.
        static let lastRequestedVersion = "review.lastRequestedVersion"
    }

    /// gate 임계값.
    private static let requiredSessions = 2
    private static let requiredConsecutiveDays = 2

    private static var defaults: UserDefaults { .standard }

    private static var appVersion: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?"
    }

    // MARK: - 신호 기록

    /// 앱이 foreground(`.active`) 로 진입할 때마다 호출. 현지 달력 기준 «서로 다른 날» 의
    /// 연속 카운트를 갱신한다. 같은 날 여러 번 active 가 와도 한 번만 센다.
    static func recordActive(now: Date = Date()) {
        let cal = Calendar.current
        let today = cal.startOfDay(for: now)

        guard let lastTs = defaults.object(forKey: Key.lastActiveDay) as? Double else {
            // 첫 기록.
            defaults.set(1, forKey: Key.consecutiveDays)
            defaults.set(today.timeIntervalSinceReferenceDate, forKey: Key.lastActiveDay)
            return
        }

        let lastDay = cal.startOfDay(for: Date(timeIntervalSinceReferenceDate: lastTs))
        let delta = cal.dateComponents([.day], from: lastDay, to: today).day ?? 0
        switch delta {
        case 0:
            // 같은 날 재진입 — streak 변화 없음.
            return
        case 1:
            // 어제 → 오늘: 연속 +1.
            let n = max(defaults.integer(forKey: Key.consecutiveDays), 1)
            defaults.set(n + 1, forKey: Key.consecutiveDays)
        default:
            // 하루 이상 비었거나(시계 뒤로 감기 등 음수 포함) → streak 리셋.
            defaults.set(1, forKey: Key.consecutiveDays)
        }
        defaults.set(today.timeIntervalSinceReferenceDate, forKey: Key.lastActiveDay)
    }

    /// 사용자가 «새 세션» 을 직접 만들어 성공했을 때 호출.
    static func recordSessionCreated() {
        defaults.set(defaults.integer(forKey: Key.sessionsCreated) + 1, forKey: Key.sessionsCreated)
    }

    // MARK: - 요청

    /// gate 충족 시 1회 리뷰 요청. 세션 생성 성공 «직후» 호출용.
    /// 실제 노출 여부/타이밍은 iOS 가 최종 결정한다(요청일 뿐 강제 아님).
    static func maybeRequestAfterSessionCreated(_ requestReview: RequestReviewAction) {
        guard defaults.string(forKey: Key.lastRequestedVersion) != appVersion else { return }
        guard defaults.integer(forKey: Key.sessionsCreated) >= requiredSessions else { return }
        guard defaults.integer(forKey: Key.consecutiveDays) >= requiredConsecutiveDays else { return }

        // 먼저 마킹 — 요청 도중 재진입이 중복 호출해도 한 번만 나가게.
        defaults.set(appVersion, forKey: Key.lastRequestedVersion)
        NSLog("[Review] gate 충족 — requestReview 발사 (sessions=%d, streak=%d, ver=%@)",
              defaults.integer(forKey: Key.sessionsCreated),
              defaults.integer(forKey: Key.consecutiveDays),
              appVersion)
        requestReview()
    }
}
