import XCTest

/// 시뮬레이터 자가 검증 전용 — 설정 시트의 «보안 상태» 패널(SecurityStatusView) 도달 드라이버.
///
/// VerifyVoiceSettingsUITest 와 같은 패턴: 판정은 에이전트가 스크린샷을 읽어서 하고, 이 테스트는
/// 화면을 «열어 두는» 역할만 한다. SessionsView 좌상단 «설정» 버튼 → 설정 시트의 «연결 · 보안»
/// 섹션 → 「보안 상태」 NavigationLink 를 탭해 SecurityStatusView 를 띄운 뒤 마커 파일을 남기고
/// 잠시 화면을 유지한다(드라이버가 simctl 로 촬영).
///
/// 영어 로케일을 강제(launchArguments)해 한글 잔존 여부까지 한 번에 본다.
/// DevPairing env 주입 전제 — env 가 없으면(=실기기/일반 실행) XCTSkip.
final class VerifySecurityPanelUITest: XCTestCase {

    private let readyMarkerPath = "/tmp/ps-security-panel-ready"

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    private func byLabel(_ query: XCUIElementQuery, _ ko: String, _ en: String) -> XCUIElement {
        query.matching(NSPredicate(format: "label CONTAINS %@ OR label CONTAINS[c] %@", ko, en)).firstMatch
    }

    func testOpenSecurityPanelForVerification() throws {
        let env = ProcessInfo.processInfo.environment
        guard let token = env["PS_DEV_DAEMON_TOKEN"], !token.isEmpty else {
            throw XCTSkip("PS_DEV_DAEMON_TOKEN 없음 — 시뮬레이터 자가 검증 전용 테스트.")
        }
        try? FileManager.default.removeItem(atPath: readyMarkerPath)

        let app = XCUIApplication()
        app.launchEnvironment["PS_DEV_DAEMON_TOKEN"] = token
        app.launchEnvironment["PS_DEV_LOCAL_SECRET"] = env["PS_DEV_LOCAL_SECRET"] ?? ""
        // 영어 로케일 강제 — 보안 상태 패널의 모든 문자열이 번역됐는지(한글 잔존 X) 확인.
        app.launchArguments += ["-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
        app.launch()

        // 1) SessionsView 좌상단 «설정»(gearshape) 버튼 → 설정 시트.
        let settings = byLabel(app.buttons, "설정", "Settings")
        XCTAssertTrue(settings.waitForExistence(timeout: 60), "설정 버튼이 안 보임 (페어링 주입 실패?)")
        settings.tap()

        // 2) «보안 상태» NavigationLink 탭 → SecurityStatusView push.
        //    설정 List 하단 «연결 · 보안» 섹션은 화면 밖이라 lazy List 가 아직 접근성 트리에
        //    안 올린다 — 보일 때까지 스크롤해 내려간다.
        let securityLink = byLabel(app.descendants(matching: .any), "보안 상태", "Security status")
        var tries = 0
        while !securityLink.exists && tries < 8 {
            app.swipeUp()
            tries += 1
        }
        XCTAssertTrue(securityLink.waitForExistence(timeout: 5), "«보안 상태» 항목이 안 보임")
        securityLink.tap()

        // 3) 패널이 떴는지 — 첫 섹션 헤더(«기기 인증»/Device authentication)로 확인.
        let header = byLabel(app.descendants(matching: .any), "기기 인증", "Device authentication")
        XCTAssertTrue(header.waitForExistence(timeout: 15), "보안 상태 패널이 안 보임")

        // 4) 하단(호스트 키 지문·등록 기기)까지 보이게 스크롤 — 환경변수 PS_SCROLL 가 있으면.
        if ProcessInfo.processInfo.environment["PS_SCROLL"] != nil {
            app.swipeUp(); app.swipeUp()
        }

        // 5) 마커 — 패널이 보이는 상태로 촬영 동안 화면 유지.
        Thread.sleep(forTimeInterval: 1)
        FileManager.default.createFile(atPath: readyMarkerPath, contents: Data("ready".utf8))
        Thread.sleep(forTimeInterval: 18)
    }
}
