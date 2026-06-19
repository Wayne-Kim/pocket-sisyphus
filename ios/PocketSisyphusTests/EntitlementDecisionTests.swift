import XCTest

// EntitlementDecision.swift 는 host-less library test 패턴으로 이 번들에 직접 컴파일된다
// (project.yml 의 PocketSisyphusTests.sources 참고).

/// `EntitlementDecision.proUnlocked` 게이트 가드.
///
/// 프리미엄 모델: 전체화면 강제 페이월은 폐기됐고, 주황(프로) 기능을 탭할 때 이 판정으로 막는다.
/// 회귀 차단:
///  - 무료 출시 단계(iapEnabled=false)에 실수로 프로 기능이 잠기는 케이스 (전부 무료여야).
///  - 유료 단계(iapEnabled=true)에 미보유인데 프로 기능이 열리는 케이스 (=결제 우회).
final class EntitlementDecisionTests: XCTestCase {

    /// iapEnabled=false 면 보유 여부와 무관하게 항상 unlocked(전부 무료).
    func test_iapDisabled_alwaysUnlocked() {
        for entitled in [true, false] {
            XCTAssertTrue(
                EntitlementDecision.proUnlocked(isEntitled: entitled, iapEnabled: false),
                "iapEnabled=false 면 entitled=\(entitled) 라도 프로 기능 무료여야"
            )
        }
    }

    /// iapEnabled=true 면 보유(구독·무료체험·평생) 사용자만 unlocked.
    func test_iapEnabled_entitled_unlocked() {
        XCTAssertTrue(EntitlementDecision.proUnlocked(isEntitled: true, iapEnabled: true))
    }

    func test_iapEnabled_notEntitled_locked() {
        XCTAssertFalse(
            EntitlementDecision.proUnlocked(isEntitled: false, iapEnabled: true),
            "유료 단계 미보유는 프로 기능 잠겨야 (탭 시 페이월)"
        )
    }

    /// 구매(미보유→보유) 시 잠금이 풀리는 전이 가드.
    func test_purchaseUnlocks() {
        XCTAssertFalse(EntitlementDecision.proUnlocked(isEntitled: false, iapEnabled: true))
        XCTAssertTrue(EntitlementDecision.proUnlocked(isEntitled: true, iapEnabled: true))
    }
}
