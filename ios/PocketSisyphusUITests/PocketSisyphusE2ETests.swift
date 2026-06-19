import XCTest

/// 실기기 (iPhone 13 mini, 케이블 연결) 풀스택 e2e — XCUITest.
///
/// ── 전제 ────────────────────────────────────────────────────────────────────
///  • 카메라 QR 페어링은 *자동화 대상 아님* (사용자 영역, 이미 동작). 기기는 한 번
///    페어링해 두면 PairConfig 가 Keychain 에 영속 → 앱 콜드런치 시 ConnectionManager
///    가 실제 Tor+SSH 로 daemon 에 다시 붙는다. 이 테스트는 그 «이미 페어링된» 상태를
///    전제로, 페어링 *이후* 의 사용자 흐름만 검증한다.
///  • daemon 은 프로덕션 그대로 (e2e 코드 주입 0). 러너(scripts/run-ios-e2e.sh)가
///    실행 중인 실제 daemon 을 재사용하고, 앱이 쓰는 바로 그 공개 API (POST /api/sessions)
///    로 'E2E-ROUNDTRIP' shell 세션 1개를 미리 만들어 둔다.
///
/// ── 검증 (전적으로 iOS 화면에서) ──────────────────────────────────────────────
///  1. 콜드런치 → SessionsView 의 e2e 세션이 보일 때까지   = 실제 Tor+SSH 연결 +
///     daemon /api/sessions 응답이 iOS 에 반영됐다는 증거.
///  2. 세션 진입 → 셸 명령 전송 → daemon 의 *실제* PTY 출력이 iOS 터미널 화면에 반영.
///     입력 텍스트엔 없는 산술 결과 토큰을 화면에서 찾아, daemon 셸이 실제로 실행해
///     그 출력을 iOS 가 렌더했음을 못박는다.
final class PocketSisyphusE2ETests: XCTestCase {

    /// 러너가 미리 만들어 두는 세션 제목 (scripts/run-ios-e2e.sh 와 반드시 일치).
    private let sessionTitle = "E2E-ROUNDTRIP"

    /// 셸이 계산해 *출력* 으로만 내는 토큰. 입력 텍스트("271828 + 314159")엔 등장하지
    /// 않으므로, 화면에서 발견되면 = daemon 셸이 실행 후 그 결과를 iOS 에 흘려보냈다는 뜻.
    private let inputCommand = "expr 271828 + 314159\n"
    private let expectedOutput = "585987"

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    func testFullRoundTrip() throws {
        let app = XCUIApplication()
        app.launch()

        // ── 1) 콜드런치 → 실제 연결 → e2e 세션이 목록에 보일 때까지 ──────────────────
        //    Tor 부트스트랩 + onion 회로 + SSH 채택은 첫 연결에서 수십 초까지 걸리므로
        //    넉넉히 기다린다.
        let sessionCell = app.staticTexts[sessionTitle]
        let pairScreen = app.staticTexts["Pocket Sisyphus 페어링"]

        if !sessionCell.waitForExistence(timeout: 180) {
            if pairScreen.exists {
                XCTFail("""
                기기가 페어링돼 있지 않다 — Mac 의 페어링 QR 을 iPhone 으로 한 번 스캔한 뒤 \
                다시 실행하라. (카메라 페어링은 자동화 대상이 아니다.)
                """)
            } else {
                XCTFail("""
                180s 안에 SessionsView 에서 '\(sessionTitle)' 세션이 보이지 않았다. \
                daemon 연결(Tor/SSH) 실패 또는 러너가 세션을 못 만들었을 수 있다 — \
                러너 로그를 확인하라.
                """)
            }
            return
        }

        // ── 2) 세션 진입 → ChatView (PTY 터미널) ────────────────────────────────────
        sessionCell.tap()

        let terminal = app.descendants(matching: .any)["ps.e2e.terminal"]
        XCTAssertTrue(
            terminal.waitForExistence(timeout: 30),
            "터미널 뷰(ps.e2e.terminal)가 보이지 않음 — ChatView 진입 실패 가능."
        )

        // ── 3) 셸 명령 입력 ─────────────────────────────────────────────────────────
        //    키보드 언어에 따라 입력 경로가 둘이다:
        //      • 한글/CJK 키보드 → inputBar(TextField) 가 보이고 줄 단위 송신.
        //      • 영문(ASCII) 키보드 → inputBar 숨김, SwiftTerm 직통. 키보드 토글로 포커스.
        //    둘 다 명령 끝의 '\n' 이 송신을 트리거한다.
        let inputField = app.textFields.firstMatch
        if inputField.waitForExistence(timeout: 4) && inputField.isHittable {
            inputField.tap()
            inputField.typeText(inputCommand)
        } else {
            let openKeyboard = app.buttons["키보드 열기"]
            if openKeyboard.waitForExistence(timeout: 4) {
                openKeyboard.tap()
            }
            _ = app.keyboards.element.waitForExistence(timeout: 8)
            app.typeText(inputCommand)
        }

        // ── 4) daemon 셸 출력이 iOS 터미널 화면에 반영될 때까지 polling ───────────────
        let deadline = Date().addingTimeInterval(30)
        var found = false
        while Date() < deadline {
            if let value = terminal.value as? String, value.contains(expectedOutput) {
                found = true
                break
            }
            usleep(500_000)
        }

        XCTAssertTrue(
            found,
            """
            daemon 셸 출력 '\(expectedOutput)' 이 iOS 터미널 화면에 끝내 나타나지 않았다 — \
            명령 전송 → daemon PTY 실행 → 출력의 iOS 렌더 라운드트립이 닫히지 않았다.
            """
        )
    }
}
