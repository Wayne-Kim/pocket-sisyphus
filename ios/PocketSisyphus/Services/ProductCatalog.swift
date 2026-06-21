import Foundation

/// 앱이 파는 IAP 3종의 단일 정의 (SSOT). product id 문자열·구독 여부·구독 그룹을 한곳에서.
///
/// 순수 값 — `StoreKit` import 없음. 그래서 `EntitlementDecision` 처럼 host-less XCTest 번들에
/// 직접 컴파일해 «id 리터럴이 .storekit / App Store Connect 와 어긋나지 않는지» 를 핀으로 박는다
/// (id 오타는 빌드는 통과하지만 페이월이 «상품 로드 실패» 로 죽는 silent 사고라 테스트가 막아준다).
///
/// rawValue 가 곧 product id 라 `from(id:)` 는 공짜 `init?(rawValue:)`, `allIDs` 도 자명 —
/// id 와 case 가 따로 노는 평행 switch 가 없어 drift 가 안 생긴다.
enum ProductKind: String, CaseIterable, Equatable {
    /// 월 자동갱신 구독 (₩5,000). 7일 무료 도입혜택 대상.
    case monthly = "pe.wayne.pocketsisyphus.sub.monthly"
    /// 년 자동갱신 구독 (₩50,000). 7일 무료 도입혜택 대상.
    case yearly = "pe.wayne.pocketsisyphus.sub.yearly"
    /// 평생 이용권 (₩250,000). 비소모성 — 도입혜택(무료체험) 불가.
    case lifetime = "pe.wayne.pocketsisyphus.lifetime"

    /// StoreKit product identifier.
    var id: String { rawValue }

    /// 자동갱신 구독인가? (lifetime 만 false — 비소모성)
    var isSubscription: Bool {
        switch self {
        case .monthly, .yearly: return true
        case .lifetime: return false
        }
    }

    /// product id → kind. StoreKit Transaction / Product 에서 받은 id 를 다시 kind 로.
    static func from(id: String) -> ProductKind? { ProductKind(rawValue: id) }

    /// `Product.products(for:)` 에 넘길 전체 id 집합.
    static var allIDs: [String] { allCases.map(\.id) }

    /// monthly + yearly 가 함께 사는 구독 그룹 reference name. .storekit / ASC 와 문자열 일치 필요.
    /// 도입혜택(7일 무료) 적격성은 «그룹 단위» 라 둘이 같은 그룹에 있어야 한 번만 체험을 준다.
    static let subscriptionGroupID = "pocketsisyphus.pro"
}
