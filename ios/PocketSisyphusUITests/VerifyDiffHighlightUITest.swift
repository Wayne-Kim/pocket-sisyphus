import XCTest

/// 시뮬레이터 자가 검증 전용 — diff 뷰어 syntax highlighting 화면 도달 드라이버.
///
/// `/verify-ios` 루프의 한계(딥링크로 DiffSheet 까지 못 들어감)를 메우는 «조작» 단계다.
/// 검증 판정은 에이전트가 스크린샷을 읽어서 한다 — 이 테스트는 화면을 «열어 두는» 역할:
///   세션(VERIFY-DIFF) 진입 → 변경점 버튼 → 파일 row 탭 → 마커 파일을 쓰고 잠시 대기.
/// 드라이버 쪽(에이전트)이 마커를 폴링해 그 사이 `simctl io screenshot` 으로 찍는다.
///
/// 실기기 e2e(PocketSisyphusE2ETests)와 달리 DevPairing env 주입을 전제로 하며,
/// env 가 없으면(=실기기/일반 실행) XCTSkip 으로 빠진다.
final class VerifyDiffHighlightUITest: XCTestCase {

    /// 드라이버 스크립트와 합의된 마커 경로 — 시뮬레이터 프로세스는 호스트 /tmp 를 그대로 쓴다.
    private let readyMarkerPath = "/tmp/ps-diff-ready"

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    func testOpenDiffSheetForVerification() throws {
        let env = ProcessInfo.processInfo.environment
        guard let token = env["PS_DEV_DAEMON_TOKEN"], !token.isEmpty else {
            throw XCTSkip("PS_DEV_DAEMON_TOKEN 없음 — 시뮬레이터 자가 검증 전용 테스트.")
        }
        try? FileManager.default.removeItem(atPath: readyMarkerPath)

        // 직전 simctl openurl 이 남긴 «열겠습니까?» 류 시스템 알럿이 있으면 치운다.
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        for label in ["취소", "Cancel", "열기", "Open"] {
            let button = springboard.buttons[label]
            if button.exists && button.isHittable { button.tap(); break }
        }

        let app = XCUIApplication()
        app.launchEnvironment["PS_DEV_DAEMON_TOKEN"] = token
        app.launchEnvironment["PS_DEV_LOCAL_SECRET"] = env["PS_DEV_LOCAL_SECRET"] ?? ""
        app.launchEnvironment["PS_DEV_PRO"] = "1"  // diff 버튼은 pro 게이트 뒤에 있다.
        app.launch()

        // 1) 세션 목록 → VERIFY-DIFF 진입 (드라이버가 daemon API 로 미리 만들어 둔 세션).
        let cell = app.staticTexts["VERIFY-DIFF"]
        XCTAssertTrue(cell.waitForExistence(timeout: 60), "세션 목록에 VERIFY-DIFF 가 안 보임")
        cell.tap()

        // 2) 상태바의 «커밋되지 않은 변경» 버튼 (ko/en 라벨 모두 허용).
        let predicate = NSPredicate(format: "label CONTAINS %@ OR label CONTAINS[c] %@", "커밋되지 않은 변경", "uncommitted")
        let diffButton = app.buttons.matching(predicate).firstMatch
        XCTAssertTrue(diffButton.waitForExistence(timeout: 30), "변경점(diff) 버튼이 안 보임")
        diffButton.tap()

        // 3) DiffSheet 파일 목록 → Sample.swift 상세.
        let fileRow = app.staticTexts["Sample.swift"]
        XCTAssertTrue(fileRow.waitForExistence(timeout: 15), "DiffSheet 에 Sample.swift row 가 안 보임")
        fileRow.tap()

        // 4) diff 본문 도달 — 변경 라인의 토큰 일부가 그려질 때까지.
        let diffLine = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "retryCount")).firstMatch
        XCTAssertTrue(diffLine.waitForExistence(timeout: 15), "diff 본문(retryCount 라인)이 안 보임")

        // 5) 비동기 하이라이트 반영 여유 → 마커 → 드라이버 촬영 동안 화면 유지.
        Thread.sleep(forTimeInterval: 3)
        FileManager.default.createFile(atPath: readyMarkerPath, contents: Data("ready".utf8))
        Thread.sleep(forTimeInterval: 25)
    }
}
