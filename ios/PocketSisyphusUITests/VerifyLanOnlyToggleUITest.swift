import XCTest

/// 시뮬레이터 자가 검증 전용 — 설정 시트의 «같은 Wi‑Fi 전용(LAN 전용 모드)» 토글 섹션 도달 드라이버.
///
/// VerifySecurityPanelUITest 와 같은 패턴: 판정은 에이전트가 스크린샷을 읽어서 하고, 이 테스트는
/// 화면을 «열어 두는» 역할만 한다. SessionsView 좌상단 «설정» 버튼 → 설정 시트에서 「LAN 전용 모드」
/// 토글이 보일 때까지 스크롤해 화면에 띄운 뒤 마커 파일을 남기고 잠시 유지한다(드라이버가 simctl 로 촬영).
///
/// 영어 로케일을 강제(launchArguments)해 한글 잔존 여부까지 한 번에 본다.
/// DevPairing env 주입 전제 — env 가 없으면(=실기기/일반 실행) XCTSkip.
final class VerifyLanOnlyToggleUITest: XCTestCase {

    private let readyMarkerPath = "/tmp/ps-lanonly-toggle-ready"

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    private func byLabel(_ query: XCUIElementQuery, _ ko: String, _ en: String) -> XCUIElement {
        query.matching(NSPredicate(format: "label CONTAINS %@ OR label CONTAINS[c] %@", ko, en)).firstMatch
    }

    func testOpenLanOnlyToggleForVerification() throws {
        let env = ProcessInfo.processInfo.environment
        guard let token = env["PS_DEV_DAEMON_TOKEN"], !token.isEmpty else {
            throw XCTSkip("PS_DEV_DAEMON_TOKEN 없음 — 시뮬레이터 자가 검증 전용 테스트.")
        }
        try? FileManager.default.removeItem(atPath: readyMarkerPath)

        let app = XCUIApplication()
        app.launchEnvironment["PS_DEV_DAEMON_TOKEN"] = token
        app.launchEnvironment["PS_DEV_LOCAL_SECRET"] = env["PS_DEV_LOCAL_SECRET"] ?? ""
        app.launchArguments += ["-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
        app.launch()

        // 1) SessionsView 좌상단 «설정»(gearshape) 버튼 → 설정 시트.
        let settings = byLabel(app.buttons, "설정", "Settings")
        XCTAssertTrue(settings.waitForExistence(timeout: 60), "설정 버튼이 안 보임 (페어링 주입 실패?)")
        settings.tap()

        // 2) «LAN 전용 모드» 토글이 보일 때까지 스크롤 — lazy List 라 화면 밖이면 접근성 트리에 없음.
        let lanToggle = byLabel(app.descendants(matching: .any), "LAN 전용 모드", "LAN-only")
        var tries = 0
        while !lanToggle.exists && tries < 8 {
            app.swipeUp()
            tries += 1
        }
        XCTAssertTrue(lanToggle.waitForExistence(timeout: 5), "«LAN 전용 모드» 토글이 안 보임")

        // 3) 마커 — 토글 섹션이 보이는 상태로 촬영 동안 화면 유지.
        Thread.sleep(forTimeInterval: 1)
        FileManager.default.createFile(atPath: readyMarkerPath, contents: Data("ready".utf8))
        Thread.sleep(forTimeInterval: 18)
    }
}
