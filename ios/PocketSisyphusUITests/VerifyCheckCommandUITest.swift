import XCTest

/// 시뮬레이터 자가 검증 전용 — 워크플로우 «노드 인스펙터» 의 「검사 명령」 섹션 도달 드라이버.
///
/// VerifySecurityPanelUITest 와 같은 패턴: 판정은 에이전트가 스크린샷을 읽어서 하고, 이 테스트는
/// 화면을 «열어 두는» 역할만 한다. setUp 에서 daemon 공개 API 로 task 노드 1개(검사 명령 비움)를
/// 가진 워크플로우를 미리 만들고 → 자동화 탭 → 그 워크플로우 행 → 캔버스 편집기 → task 노드 카드
/// 탭 → NodeInspectorSheet 를 띄운 뒤 「검사 명령」 섹션이 보이도록 스크롤하고 마커를 남긴다.
///
/// 영어 로케일을 강제해 「검사 명령」 헤더·「검사 미설정」 경고가 번역돼 뜨는지(한글 잔존 X) 본다.
/// DevPairing env 주입 전제 — env 가 없으면 XCTSkip.
final class VerifyCheckCommandUITest: XCTestCase {

    private let readyMarkerPath = "/tmp/ps-check-inspector-ready"
    private let wfTitle = "CHECK-VERIFY"
    private let nodeTitle = "검사데모"

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

    private func byLabel(_ query: XCUIElementQuery, _ ko: String, _ en: String) -> XCUIElement {
        query.matching(NSPredicate(format: "label CONTAINS %@ OR label CONTAINS[c] %@", ko, en)).firstMatch
    }

    /// daemon 에 워크플로우 1개(task 노드 + 빈 검사 명령)를 동기 POST 로 시드한다.
    private func seedWorkflow(token: String, secret: String, port: String) throws {
        try? FileManager.default.createDirectory(atPath: "/tmp/ps-verify-repo", withIntermediateDirectories: true)
        let url = URL(string: "http://127.0.0.1:\(port)/api/workflows")!
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue(secret, forHTTPHeaderField: "X-PS-Local")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body: [String: Any] = [
            "title": wfTitle,
            "repoPath": "/tmp/ps-verify-repo",
            "nodes": [
                ["id": "start", "type": "start", "title": "시작", "x": 60, "y": 40],
                ["id": "work", "type": "task", "title": nodeTitle, "prompt": "데모용 작업",
                 "agent": "shell", "skip_permissions": true, "x": 60, "y": 180],
                ["id": "end", "type": "end", "title": "종료", "x": 60, "y": 320],
            ],
            "edges": [
                ["id": "e1", "from": "start", "to": "work"],
                ["id": "e2", "from": "work", "to": "end"],
            ],
            "enabled": false,
        ]
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let sem = DispatchSemaphore(value: 0)
        var statusCode = 0
        var errOut: Error?
        URLSession.shared.dataTask(with: req) { _, resp, err in
            statusCode = (resp as? HTTPURLResponse)?.statusCode ?? 0
            errOut = err
            sem.signal()
        }.resume()
        _ = sem.wait(timeout: .now() + 15)
        if let errOut { throw XCTSkip("워크플로우 시드 실패(네트워크): \(errOut.localizedDescription)") }
        XCTAssertTrue((200..<300).contains(statusCode), "워크플로우 시드 실패 status=\(statusCode)")
    }

    func testOpenCheckCommandInspector() throws {
        let env = ProcessInfo.processInfo.environment
        guard let token = env["PS_DEV_DAEMON_TOKEN"], !token.isEmpty else {
            throw XCTSkip("PS_DEV_DAEMON_TOKEN 없음 — 시뮬레이터 자가 검증 전용 테스트.")
        }
        let secret = env["PS_DEV_LOCAL_SECRET"] ?? ""
        let port = env["PS_DEV_DAEMON_PORT"] ?? "7777"
        try? FileManager.default.removeItem(atPath: readyMarkerPath)

        try seedWorkflow(token: token, secret: secret, port: port)

        let app = XCUIApplication()
        app.launchEnvironment["PS_DEV_DAEMON_TOKEN"] = token
        app.launchEnvironment["PS_DEV_LOCAL_SECRET"] = secret
        app.launchEnvironment["PS_DEV_DAEMON_PORT"] = port
        app.launchEnvironment["PS_DEV_PRO"] = "1"
        // 영어 로케일 강제 — 「Check command」 헤더·「No check set」 경고가 번역됐는지 확인.
        app.launchArguments += ["-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
        app.launch()

        // 1) 자동화 탭(Automation) — pro 전용. PS_DEV_PRO=1 로 진입 가능.
        let autoTab = byLabel(app.buttons, "자동화", "Automation")
        XCTAssertTrue(autoTab.waitForExistence(timeout: 60), "자동화 탭이 안 보임 (페어링/Pro/capability?)")
        autoTab.tap()

        // 2) 워크플로우 목록에서 시드한 행 탭 → 캔버스 편집기 push.
        let row = byLabel(app.descendants(matching: .any), wfTitle, wfTitle)
        var tries = 0
        while !row.exists && tries < 6 { app.swipeUp(); tries += 1 }
        XCTAssertTrue(row.waitForExistence(timeout: 15), "워크플로우 행(\(wfTitle))이 안 보임")
        row.tap()

        // 3) 캔버스의 task 노드 카드 탭 → NodeInspectorSheet.
        let nodeCard = byLabel(app.descendants(matching: .any), nodeTitle, nodeTitle)
        XCTAssertTrue(nodeCard.waitForExistence(timeout: 15), "노드 카드(\(nodeTitle))가 안 보임")
        nodeCard.tap()

        // 4) 인스펙터의 「검사 명령」 섹션이 보일 때까지 스크롤.
        let checkHeader = byLabel(app.descendants(matching: .any), "검사 명령", "Check command")
        var t2 = 0
        while !checkHeader.exists && t2 < 8 { app.swipeUp(); t2 += 1 }
        XCTAssertTrue(checkHeader.waitForExistence(timeout: 10), "「검사 명령」 섹션이 안 보임")

        // 5) 마커 — 인스펙터가 보이는 상태로 촬영 동안 화면 유지.
        Thread.sleep(forTimeInterval: 1)
        FileManager.default.createFile(atPath: readyMarkerPath, contents: Data("ready".utf8))
        Thread.sleep(forTimeInterval: 40)
    }
}
