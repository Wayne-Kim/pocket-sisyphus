import Testing
import Foundation

/// `LanguageOverride` 의 UserDefaults round-trip + languages 테이블 단위 테스트.
///
/// host-less 테스트 번들이라 `UserDefaults.standard` 는 테스트 번들 전용 plist 라
/// 사용자/앱의 실제 설정을 오염시키지 않는다 — 그래도 매 테스트 끝에 명시적으로 정리해
/// 같은 번들 안의 다른 테스트와도 격리.
///
/// 회귀 차단 대상:
///  - set("ko") → current == "ko" round-trip
///  - set(nil) → current == nil (키 자체 제거)
///  - 다중 priority list 면 current == nil (단일 override 만 사용자 의도로 인정)
///  - languages 테이블: 10개, 코드 모두 distinct, "ko" 가 첫 항목 (iOS picker 와 일치)

@MainActor
@Suite("LanguageOverride.current / set", .serialized)
struct LanguageOverrideRoundTripTests {
    /// 매 테스트 끝에 AppleLanguages 키를 비워 다른 테스트와 격리.
    private func clearLanguages() {
        UserDefaults.standard.removeObject(forKey: "AppleLanguages")
        UserDefaults.standard.synchronize()
    }

    @Test("set('ko') 직후 current 는 'ko'")
    func setKoroundTrip() {
        defer { clearLanguages() }
        LanguageOverride.set("ko")
        #expect(LanguageOverride.current == "ko")
    }

    @Test("set('en') 직후 current 는 'en' — 다른 코드도 동일하게 작동")
    func setEnRoundTrip() {
        defer { clearLanguages() }
        LanguageOverride.set("en")
        #expect(LanguageOverride.current == "en")
    }

    @Test("set(nil) 후엔 직전에 박았던 단일 override 가 더 이상 노출되지 않음")
    func setNilClearsPriorOverride() {
        defer { clearLanguages() }
        LanguageOverride.set("ja")
        #expect(LanguageOverride.current == "ja")
        LanguageOverride.set(nil)
        // macOS 는 AppleLanguages 키를 시스템 기본 priority list 로 자동 채워 raw 가 nil
        // 인지는 검증 불가. 우리 코드 계약은 «단일 override 가 사라진다» — current 가
        // 직전 값을 그대로 들고 있으면 회귀.
        #expect(LanguageOverride.current != "ja")
    }

    @Test("다중 priority list 가 박혀 있으면 current 는 nil (단일 override 만 인정)")
    func multipleEntriesNotConsideredOverride() {
        defer { clearLanguages() }
        UserDefaults.standard.set(["ko", "en"], forKey: "AppleLanguages")
        UserDefaults.standard.synchronize()
        #expect(LanguageOverride.current == nil)
    }
}

@Suite("LanguageOverride.languages 테이블")
struct LanguageOverrideTableTests {
    @Test("정확히 10개 항목 — iOS / Mac 양쪽 동일")
    func tenEntries() {
        #expect(LanguageOverride.languages.count == 10)
    }

    @Test("코드가 모두 distinct")
    func codesAreUnique() {
        let codes = LanguageOverride.languages.map { $0.code }
        #expect(Set(codes).count == codes.count)
    }

    @Test("첫 항목은 ko — iOS LanguagePickerSheet 와 같은 순서")
    func firstIsKorean() {
        #expect(LanguageOverride.languages.first?.code == "ko")
    }

    @Test("10개 언어가 정책 (CLAUDE.md) 의 지원 코드와 모두 일치")
    func codesMatchPolicy() {
        // ar / en / es / fr / hi / ja / ko / pt-BR / ru / zh-Hans
        let codes = Set(LanguageOverride.languages.map { $0.code })
        #expect(
            codes == [
                "ar", "en", "es", "fr", "hi", "ja", "ko", "pt-BR", "ru", "zh-Hans",
            ]
        )
    }
}
