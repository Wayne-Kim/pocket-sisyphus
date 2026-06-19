import XCTest

/// 시뮬레이터 자가 검증 전용 — 설정 시트의 «음성 입력»(음성 인식 정확도) 섹션 도달 드라이버.
///
/// VerifyBlurToolUITest 와 같은 패턴: 판정은 에이전트가 스크린샷을 읽어서 하고, 이 테스트는
/// 화면을 «열어 두는» 역할만 한다. SessionsView 좌상단 «설정» 버튼 → 설정 시트 → 음성 입력
/// 섹션이 보이도록 스크롤한 뒤 마커 파일을 남기고 잠시 화면을 유지한다(드라이버가 simctl 로 촬영).
///
/// 영어 로케일을 강제(launchArguments)해 한글 잔존 여부까지 한 번에 본다.
/// DevPairing env 주입 전제 — env 가 없으면(=실기기/일반 실행) XCTSkip.
final class VerifyVoiceSettingsUITest: XCTestCase {

    private let readyMarkerPath = "/tmp/ps-voice-settings-ready"

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    private func byLabel(_ query: XCUIElementQuery, _ ko: String, _ en: String) -> XCUIElement {
        query.matching(NSPredicate(format: "label CONTAINS %@ OR label CONTAINS[c] %@", ko, en)).firstMatch
    }

    func testOpenVoiceSettingsForVerification() throws {
        let env = ProcessInfo.processInfo.environment
        guard let token = env["PS_DEV_DAEMON_TOKEN"], !token.isEmpty else {
            throw XCTSkip("PS_DEV_DAEMON_TOKEN 없음 — 시뮬레이터 자가 검증 전용 테스트.")
        }
        try? FileManager.default.removeItem(atPath: readyMarkerPath)

        let app = XCUIApplication()
        app.launchEnvironment["PS_DEV_DAEMON_TOKEN"] = token
        app.launchEnvironment["PS_DEV_LOCAL_SECRET"] = env["PS_DEV_LOCAL_SECRET"] ?? ""
        // 영어 로케일 강제 — 음성 입력 섹션의 모든 문자열이 번역됐는지(한글 잔존 X) 확인.
        app.launchArguments += ["-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
        app.launch()

        // 1) SessionsView 좌상단 «설정»(gearshape) 버튼 → 설정 시트.
        let settings = byLabel(app.buttons, "설정", "Settings")
        XCTAssertTrue(settings.waitForExistence(timeout: 60), "설정 버튼이 안 보임 (페어링 주입 실패?)")
        settings.tap()

        // 2) 음성 인식 정확도 피커가 보일 때까지 — 섹션이 화면 위쪽이라 보통 즉시 보인다.
        let voicePicker = byLabel(app.descendants(matching: .any), "음성 인식 정확도", "Speech accuracy")
        XCTAssertTrue(voicePicker.waitForExistence(timeout: 15), "«음성 인식 정확도» 항목이 안 보임")
        // 안 보이면 살짝 스크롤(연결/Mac 섹션보다 위라 대개 불필요하지만 안전하게).
        if !voicePicker.isHittable {
            app.swipeUp()
        }

        // 3) 마커 — 음성 입력 섹션이 보이는 상태로 촬영 동안 화면 유지.
        Thread.sleep(forTimeInterval: 1)
        FileManager.default.createFile(atPath: readyMarkerPath, contents: Data("ready".utf8))
        Thread.sleep(forTimeInterval: 18)
    }
}
