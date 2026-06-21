import XCTest

/// 시뮬레이터 자가 검증 전용 — 첨부 주석 에디터 «블러» 도구 화면 도달 드라이버.
///
/// VerifyDiffHighlightUITest 와 같은 패턴: 검증 판정은 에이전트가 스크린샷을 읽어서 하고,
/// 이 테스트는 화면을 «열어 두는» 역할만 한다.
///   세션(VERIFY-BLUR) 진입 → 사진첩 첨부(드라이버가 simctl addmedia 로 미리 심은 이미지)
///   → 첨부 시트 → 썸네일 탭(주석 에디터) → 블러 도구 → 드래그 2회 → 마커 1 (에디터 촬영)
///   → 완료 → 마커 2 (썸네일 반영 촬영) 동안 대기.
///
/// DevPairing env 주입 전제 — env 가 없으면(=실기기/일반 실행) XCTSkip.
final class VerifyBlurToolUITest: XCTestCase {

    /// 드라이버 스크립트와 합의된 마커 경로 — 시뮬레이터 프로세스는 호스트 /tmp 를 그대로 쓴다.
    private let editorMarkerPath = "/tmp/ps-blur-editor-ready"
    private let sheetMarkerPath = "/tmp/ps-blur-sheet-ready"
    private let undoMarkerPath = "/tmp/ps-blur-undo-ready"

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    /// ko/en 어느 로케일이든 라벨로 요소를 찾는다.
    private func byLabel(_ query: XCUIElementQuery, _ ko: String, _ en: String) -> XCUIElement {
        query.matching(NSPredicate(format: "label CONTAINS %@ OR label CONTAINS[c] %@", ko, en)).firstMatch
    }

    func testOpenBlurEditorForVerification() throws {
        let env = ProcessInfo.processInfo.environment
        guard let token = env["PS_DEV_DAEMON_TOKEN"], !token.isEmpty else {
            throw XCTSkip("PS_DEV_DAEMON_TOKEN 없음 — 시뮬레이터 자가 검증 전용 테스트.")
        }
        try? FileManager.default.removeItem(atPath: editorMarkerPath)
        try? FileManager.default.removeItem(atPath: sheetMarkerPath)
        try? FileManager.default.removeItem(atPath: undoMarkerPath)

        let app = XCUIApplication()
        app.launchEnvironment["PS_DEV_DAEMON_TOKEN"] = token
        app.launchEnvironment["PS_DEV_LOCAL_SECRET"] = env["PS_DEV_LOCAL_SECRET"] ?? ""
        app.launchEnvironment["PS_DEV_PRO"] = "1"  // 이미지 첨부 버튼은 pro 게이트 뒤에 있다.
        app.launch()

        // 1) 세션 목록 → VERIFY-BLUR 진입 (드라이버가 daemon API 로 미리 만들어 둔 세션).
        let cell = app.staticTexts["VERIFY-BLUR"]
        XCTAssertTrue(cell.waitForExistence(timeout: 60), "세션 목록에 VERIFY-BLUR 가 안 보임")
        cell.tap()

        // 2) 이미지 첨부 버튼 → 사진첩 picker (simctl addmedia 로 심은 이미지가 최신).
        let attachButton = byLabel(app.buttons, "이미지 첨부", "Attach images")
        XCTAssertTrue(attachButton.waitForExistence(timeout: 30), "이미지 첨부 버튼이 안 보임")
        attachButton.tap()

        // 3) picker 첫 이미지 선택 → 추가. 사진 셀 라벨은 «사진…»(ko)/«Photo…»(en) 로 시작 —
        //    firstMatch 가 ChatView 의 다른 이미지를 잡지 않게 라벨로 스코프를 좁힌다.
        let photo = app.images.matching(
            NSPredicate(format: "label BEGINSWITH %@ OR label BEGINSWITH[c] %@", "사진", "Photo"),
        ).firstMatch
        XCTAssertTrue(photo.waitForExistence(timeout: 30), "사진첩 picker 에 사진 셀이 안 보임")
        Thread.sleep(forTimeInterval: 1.5) // 시트 애니메이션 안정화
        // PHPicker 원격 뷰 셀은 hittable 판정이 안 잡힐 수 있다 → 좌표 탭으로 우회.
        photo.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        // 확인 버튼은 identifier 'Add' (라벨은 로케일 따라 «완료»/«Add» 등으로 변함).
        let addButton = app.buttons["Add"]
        XCTAssertTrue(addButton.waitForExistence(timeout: 15), "picker 확인(Add) 버튼이 안 보임")
        addButton.tap()

        // 4) 첨부 카운트 칩 → AttachmentSheet.
        let chip = byLabel(app.buttons, "첨부 이미지", "Attached images")
        XCTAssertTrue(chip.waitForExistence(timeout: 30), "첨부 이미지 칩이 안 보임 (picker 로드 실패?)")
        chip.tap()

        // 5) 썸네일(주석 달기) 탭 → 주석 에디터.
        // 썸네일은 Image + .isButton trait — 분류가 환경에 따라 달라 any 타입으로 찾는다.
        let thumb = byLabel(app.descendants(matching: .any), "주석 달기", "Annotate")
        XCTAssertTrue(thumb.waitForExistence(timeout: 15), "썸네일(주석 달기)이 안 보임")
        thumb.tap()

        // 6) 블러 도구 선택.
        let blurTool = byLabel(app.buttons, "블러", "Blur")
        XCTAssertTrue(blurTool.waitForExistence(timeout: 15), "블러 도구 버튼이 안 보임")
        blurTool.tap()

        // 7) 이미지 중앙부를 두 번 드래그 — 가짜 토큰/이메일 줄 위치를 가리는 사각형 2개.
        let window = app.windows.firstMatch
        func dragRect(from: CGVector, to: CGVector) {
            let start = window.coordinate(withNormalizedOffset: from)
            let end = window.coordinate(withNormalizedOffset: to)
            start.press(forDuration: 0.1, thenDragTo: end)
        }
        dragRect(from: CGVector(dx: 0.10, dy: 0.45), to: CGVector(dx: 0.90, dy: 0.51))  // API_TOKEN 줄
        dragRect(from: CGVector(dx: 0.10, dy: 0.515), to: CGVector(dx: 0.60, dy: 0.58)) // email 줄

        // 8) 마커 1 — 에디터(블러 미리보기) 촬영 동안 화면 유지.
        Thread.sleep(forTimeInterval: 1)
        FileManager.default.createFile(atPath: editorMarkerPath, contents: Data("ready".utf8))
        Thread.sleep(forTimeInterval: 8)

        // 9) 완료 → AttachmentSheet 썸네일에 블러 반영 확인용 촬영.
        let done = byLabel(app.buttons, "완료", "Done")
        XCTAssertTrue(done.waitForExistence(timeout: 10), "완료 버튼이 안 보임")
        done.tap()
        Thread.sleep(forTimeInterval: 2)
        FileManager.default.createFile(atPath: sheetMarkerPath, contents: Data("ready".utf8))
        Thread.sleep(forTimeInterval: 8)

        // 10) 재진입 → 되돌리기 1회 — 블러가 주석 데이터로 유지되고 마지막 항목(email 블러)만
        //     풀리는지 확인용. 마커 3 동안 에디터 화면 유지 후 완료.
        XCTAssertTrue(thumb.waitForExistence(timeout: 10), "재진입용 썸네일이 안 보임")
        thumb.tap()
        let undo = byLabel(app.buttons, "되돌리기", "Undo")
        XCTAssertTrue(undo.waitForExistence(timeout: 15), "되돌리기 버튼이 안 보임")
        XCTAssertTrue(undo.isEnabled, "재진입 시 되돌리기가 비활성 — 주석 데이터가 유지되지 않음")
        undo.tap()
        Thread.sleep(forTimeInterval: 1)
        FileManager.default.createFile(atPath: undoMarkerPath, contents: Data("ready".utf8))
        Thread.sleep(forTimeInterval: 8)
        let done2 = byLabel(app.buttons, "완료", "Done")
        XCTAssertTrue(done2.waitForExistence(timeout: 10))
        done2.tap()
        Thread.sleep(forTimeInterval: 10)
    }
}
