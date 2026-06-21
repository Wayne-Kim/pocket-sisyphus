import XCTest

// ProductCatalog.swift 는 host-less library test 패턴으로 이 번들에 직접 컴파일된다
// (project.yml 의 PocketSisyphusTests.sources 참고).

/// `ProductKind` id 매핑 핀.
///
/// product id 오타는 «빌드는 통과하지만 페이월이 상품 로드 실패로 죽는» silent 사고다 —
/// 이 리터럴들이 .storekit / App Store Connect 에 등록한 id 와 글자 하나라도 어긋나면
/// 여기서 먼저 깨지게 박는다. (id 를 의도적으로 바꿀 땐 이 테스트도 같이 고친다 = 의식적 변경.)
final class ProductCatalogTests: XCTestCase {

    func test_productIDs_areExactLiterals() {
        XCTAssertEqual(ProductKind.monthly.id, "pe.wayne.pocketsisyphus.sub.monthly")
        XCTAssertEqual(ProductKind.yearly.id, "pe.wayne.pocketsisyphus.sub.yearly")
        XCTAssertEqual(ProductKind.lifetime.id, "pe.wayne.pocketsisyphus.lifetime")
    }

    func test_allIDs_coversAllThreeProducts() {
        XCTAssertEqual(ProductKind.allIDs.count, 3)
        XCTAssertEqual(Set(ProductKind.allIDs), [
            "pe.wayne.pocketsisyphus.sub.monthly",
            "pe.wayne.pocketsisyphus.sub.yearly",
            "pe.wayne.pocketsisyphus.lifetime",
        ])
    }

    func test_fromID_roundTrips() {
        for kind in ProductKind.allCases {
            XCTAssertEqual(ProductKind.from(id: kind.id), kind)
        }
    }

    func test_fromID_unknownIsNil() {
        XCTAssertNil(ProductKind.from(id: "pe.wayne.pocketsisyphus.unlock"))  // 폐기된 옛 id
        XCTAssertNil(ProductKind.from(id: ""))
        XCTAssertNil(ProductKind.from(id: "garbage"))
    }

    func test_isSubscription_onlyLifetimeIsFalse() {
        XCTAssertTrue(ProductKind.monthly.isSubscription)
        XCTAssertTrue(ProductKind.yearly.isSubscription)
        XCTAssertFalse(ProductKind.lifetime.isSubscription)
    }
}
