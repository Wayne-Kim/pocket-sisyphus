import Foundation

/// 페이월의 가격/오퍼 보조 문구를 조립하는 순수 함수 모음. `StoreKit` 비의존 — 이미 해석된
/// `displayPrice`(예: "₩5,000") 와 청구 주기만 받아 문자열을 만든다. host-less XCTest 로
/// 핀을 박는다.
///
/// **가격은 절대 하드코딩하지 않는다.** App Store 가 로케일/세금/통화별로 만든
/// `Product.displayPrice` 를 그대로 흘려보내고, 여기서는 «기간 단위» 와 «무료체험 여부» 만
/// 덧붙인다. 사용자가 본 가격과 결제 다이얼로그 가격이 다르면 신뢰가 즉시 깨지기 때문.
enum PaywallCopy {
    /// 구독 청구 주기. 뷰가 `Product.subscription?.subscriptionPeriod.unit` 를 이 값으로 매핑해 넘긴다
    /// (PaywallCopy 를 StoreKit-free 로 유지하기 위해 매핑은 뷰 책임).
    enum Period: Equatable { case month, year }

    /// 기간당 가격 한 줄. 예) ("₩5,000", .month) → "₩5,000/월"
    static func priceLine(displayPrice: String, period: Period) -> String {
        switch period {
        case .month: return String(localized: "\(displayPrice)/월")
        case .year: return String(localized: "\(displayPrice)/년")
        }
    }

    /// 구독 카드 보조 문구. 7일 무료 도입혜택 적격이면 «7일 무료 체험 후 …» 를 앞에 붙인다.
    /// 예) ("₩5,000", .month, true)  → "7일 무료 체험 후 ₩5,000/월"
    ///     ("₩50,000", .year, false) → "₩50,000/년"
    static func subscriptionLine(displayPrice: String, period: Period, hasFreeTrial: Bool) -> String {
        let per = priceLine(displayPrice: displayPrice, period: period)
        return hasFreeTrial
            ? String(localized: "7일 무료 체험 후 \(per)")
            : per
    }
}
