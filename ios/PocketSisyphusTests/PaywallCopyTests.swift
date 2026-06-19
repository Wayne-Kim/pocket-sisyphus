import XCTest

// PaywallCopy.swift 는 host-less library test 패턴으로 이 번들에 직접 컴파일된다
// (project.yml 의 PocketSisyphusTests.sources 참고). 테스트 번들엔 Localizable.xcstrings 가
// 없어 String(localized:) 가 ko 원문(개발 언어)을 그대로 반환하므로 결과가 결정적이다.

/// 페이월 가격/오퍼 문구 조립 핀. «가격은 절대 하드코딩하지 않고 displayPrice 를 그대로
/// 흘려보낸다» + «무료체험 적격일 때만 체험 문구를 붙인다» 계약을 박는다.
final class PaywallCopyTests: XCTestCase {

    func test_priceLine_month_includesPriceAndPeriod() {
        let s = PaywallCopy.priceLine(displayPrice: "₩5,000", period: .month)
        XCTAssertTrue(s.contains("₩5,000"), "displayPrice 를 그대로 포함해야: \(s)")
        XCTAssertTrue(s.contains("월"), "월 주기 표시가 있어야: \(s)")
    }

    func test_priceLine_year_includesPriceAndPeriod() {
        let s = PaywallCopy.priceLine(displayPrice: "₩50,000", period: .year)
        XCTAssertTrue(s.contains("₩50,000"), "displayPrice 를 그대로 포함해야: \(s)")
        XCTAssertTrue(s.contains("년"), "년 주기 표시가 있어야: \(s)")
    }

    func test_subscriptionLine_withTrial_prependsFreeTrial() {
        let s = PaywallCopy.subscriptionLine(displayPrice: "₩5,000", period: .month, hasFreeTrial: true)
        XCTAssertTrue(s.contains("무료 체험"), "적격이면 무료체험 문구가 있어야: \(s)")
        XCTAssertTrue(s.contains("₩5,000"), "가격도 함께 표시: \(s)")
    }

    func test_subscriptionLine_withoutTrial_isJustPriceLine() {
        let withTrial = false
        let s = PaywallCopy.subscriptionLine(displayPrice: "₩50,000", period: .year, hasFreeTrial: withTrial)
        XCTAssertFalse(s.contains("무료"), "미적격이면 무료체험 문구가 없어야: \(s)")
        XCTAssertEqual(s, PaywallCopy.priceLine(displayPrice: "₩50,000", period: .year),
                       "미적격 구독 문구는 기간당 가격 그 자체여야")
    }

    /// displayPrice 는 그대로 통과 — 통화/세금 차이를 임의로 가공하지 않는다는 회귀 가드.
    func test_priceLine_doesNotMutateDisplayPrice() {
        let exotic = "US$1.99"
        let s = PaywallCopy.priceLine(displayPrice: exotic, period: .month)
        XCTAssertTrue(s.contains(exotic), "displayPrice 를 변형 없이 포함해야: \(s)")
    }
}
