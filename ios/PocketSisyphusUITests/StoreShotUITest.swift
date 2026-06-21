import XCTest

/// 스토어 스크린샷 드라이버 — 한 테스트로 여러 화면을 «열어 두기» 만 한다.
///
/// Verify*UITest 와 같은 패턴: 판정/촬영은 외부 드라이버(simctl screenshot)가 하고, 이
/// 테스트는 PS_SHOT 환경변수가 가리키는 화면으로 네비게이트한 뒤 마커 파일을 남기고 잠시
/// 화면을 유지한다. 영어 로케일 강제 (스토어 origin 은 영어 UI).
///
/// DevPairing env(PS_DEV_DAEMON_TOKEN) 주입 전제 — 없으면 XCTSkip.
///
/// 사용: TEST_RUNNER_PS_DEV_DAEMON_TOKEN / _LOCAL_SECRET / PS_SHOT 를 xcodebuild 에 넘기고
///       build-for-testing → test-without-building (PS_SHOT 만 바꿔 반복).
final class StoreShotUITest: XCTestCase {

    private let readyMarkerPath = "/tmp/ps-storeshot-ready"

    override func setUp() {
        super.setUp()
        continueAfterFailure = true
    }

    private func byLabel(_ q: XCUIElementQuery, _ ko: String, _ en: String) -> XCUIElement {
        q.matching(NSPredicate(format: "label CONTAINS %@ OR label CONTAINS[c] %@", ko, en)).firstMatch
    }

    /// 라벨로 못 찾으면 정규화 좌표 탭으로 폴백.
    private func tap(_ app: XCUIApplication, label ko: String, _ en: String,
                     fallback: CGVector, timeout: TimeInterval = 8) {
        let el = byLabel(app.buttons, ko, en)
        if el.waitForExistence(timeout: timeout), el.isHittable {
            el.tap()
        } else {
            app.coordinate(withNormalizedOffset: fallback).tap()
        }
    }

    func testStoreShot() throws {
        let env = ProcessInfo.processInfo.environment
        guard let token = env["PS_DEV_DAEMON_TOKEN"], !token.isEmpty else {
            throw XCTSkip("PS_DEV_DAEMON_TOKEN 없음 — 스토어 샷 드라이버는 시뮬레이터 전용.")
        }
        let shot = env["PS_SHOT"] ?? "picker"
        try? FileManager.default.removeItem(atPath: readyMarkerPath)

        let app = XCUIApplication()
        app.launchEnvironment["PS_DEV_DAEMON_TOKEN"] = token
        app.launchEnvironment["PS_DEV_LOCAL_SECRET"] = env["PS_DEV_LOCAL_SECRET"] ?? ""
        app.launchEnvironment["PS_DEV_DAEMON_PORT"] = env["PS_DEV_DAEMON_PORT"] ?? "7777"
        app.launchEnvironment["PS_DEV_PRO"] = "1"
        // 특정 세션으로 콜드 런치 (라이브 프리뷰 등 세션 내부 화면용).
        if let dl = env["PS_DEV_DEEPLINK"], !dl.isEmpty {
            app.launchEnvironment["PS_DEV_DEEPLINK"] = dl
        }
        app.launchArguments += ["-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
        app.launch()

        // 딥링크(세션 콜드런치) 면 채팅 화면이라 «설정» 버튼이 없다 → 라이브 프리뷰 버튼을 기다린다.
        // 아니면 세션 목록의 «설정» 버튼으로 연결 완료를 확인.
        if (env["PS_DEV_DEEPLINK"] ?? "").isEmpty {
            let settingsBtn = byLabel(app.buttons, "설정", "Settings")
            XCTAssertTrue(settingsBtn.waitForExistence(timeout: 60), "세션 목록 미도달 — 페어링 실패?")
        } else {
            let lp = byLabel(app.buttons, "라이브 프리뷰", "Live preview")
            _ = lp.waitForExistence(timeout: 60)
        }
        Thread.sleep(forTimeInterval: 1.5)

        switch shot {
        case "picker":
            // 새 세션 시트 — 에이전트/CLI 피커 (모든 에이전트를 한 화면에).
            tap(app, label: "새 세션 만들기", "Create new session", fallback: CGVector(dx: 0.93, dy: 0.088))

        case "automation":
            // 자동화 탭 (워크플로우 | 예약).
            tap(app, label: "자동화", "Automation", fallback: CGVector(dx: 0.78, dy: 0.965))

        case "automation_canvas":
            tap(app, label: "자동화", "Automation", fallback: CGVector(dx: 0.78, dy: 0.965))
            Thread.sleep(forTimeInterval: 1.5)
            // 첫 워크플로우 행 → 노드 캔버스.
            let wf = app.cells.firstMatch
            if wf.waitForExistence(timeout: 6), wf.isHittable { wf.tap() }
            else { app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.19)).tap() }

        case "cron_new":
            // 자동화 탭 → 예약 세그먼트 → «+»(새 예약) → CronEditorSheet (명령 필드 = VoiceInputField).
            tap(app, label: "자동화", "Automation", fallback: CGVector(dx: 0.78, dy: 0.965))
            Thread.sleep(forTimeInterval: 1.2)
            let seg = byLabel(app.buttons, "예약", "Schedule")
            if seg.waitForExistence(timeout: 5), seg.isHittable { seg.tap() }
            else { app.coordinate(withNormalizedOffset: CGVector(dx: 0.72, dy: 0.15)).tap() }
            Thread.sleep(forTimeInterval: 1.0)
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.92, dy: 0.088)).tap()  // 우상단 +

        case "automation_cron":
            tap(app, label: "자동화", "Automation", fallback: CGVector(dx: 0.78, dy: 0.965))
            Thread.sleep(forTimeInterval: 1.2)
            // 세그먼트 «예약/Schedule» 로 전환.
            let seg = byLabel(app.buttons, "예약", "Schedule")
            if seg.waitForExistence(timeout: 5), seg.isHittable { seg.tap() }
            else { app.coordinate(withNormalizedOffset: CGVector(dx: 0.72, dy: 0.15)).tap() }

        case "settings":
            tap(app, label: "설정", "Settings", fallback: CGVector(dx: 0.05, dy: 0.088))
            Thread.sleep(forTimeInterval: 1.2)
            app.swipeUp()   // 음성 입력 / 로컬 LLM 섹션이 보이도록 살짝 스크롤.

        case "livepreview":
            // PS_DEV_DEEPLINK 로 이미 해당 세션 채팅에 콜드 런치된 상태.
            // 채팅 툴바 «라이브 프리뷰»(safari) → PreviewView 의 등록 포트 5173 탭 → 웹뷰 렌더.
            Thread.sleep(forTimeInterval: 2.5)
            tap(app, label: "라이브 프리뷰", "Live preview", fallback: CGVector(dx: 0.62, dy: 0.066), timeout: 20)
            Thread.sleep(forTimeInterval: 3.0)
            // 등록 포트 행(«실행 중/Running» 배지) 탭 → 웹뷰 렌더. 숫자 라벨은 천단위 콤마(5,173)라
            // 배지 텍스트로 매칭. 못 찾으면 등록 포트 행 좌표 폴백.
            let portBtn = byLabel(app.buttons, "실행 중", "Running")
            if portBtn.waitForExistence(timeout: 8), portBtn.isHittable { portBtn.tap() }
            else { app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.233)).tap() }
            Thread.sleep(forTimeInterval: 4.0)   // WKWebView 로드 대기.

        case "find":
            app.cells.firstMatch.tap()
            Thread.sleep(forTimeInterval: 2.0)
            // 우상단 «⋯ 더보기» → «대화에서 찾기».
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.066)).tap()
            Thread.sleep(forTimeInterval: 0.8)
            let find = byLabel(app.buttons, "대화에서 찾기", "Find in conversation")
            if find.waitForExistence(timeout: 4), find.isHittable { find.tap() }

        case "chat":
            // 첫 세션 행 → 채팅(PTY 터미널) 화면.
            let cell = app.cells.firstMatch
            if cell.waitForExistence(timeout: 8), cell.isHittable { cell.tap() }
            else { app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.42)).tap() }
            Thread.sleep(forTimeInterval: 3.0)

        case "chat_wide":
            // PS_DEV_DEEPLINK 로 이미 그 세션 채팅에 콜드 런치된 상태(PTY REPL prewarm).
            // «컨트롤 숨기기»(Hide controls) FAB 로 헤더+입력바를 접어 키보드를 내리고 클린
            // 풀-터미널 뷰로 만든다 — REPL 스플래시가 키보드에 안 가리게.
            Thread.sleep(forTimeInterval: 2.0)
            let hideBtn = byLabel(app.buttons, "컨트롤 숨기기", "Hide controls")
            if hideBtn.waitForExistence(timeout: 8), hideBtn.isHittable { hideBtn.tap() }
            Thread.sleep(forTimeInterval: 2.0)

        case "files":
            // PS_DEV_DEEPLINK 로 세션 채팅 진입 후 — 입력 도구줄의 «파일 탐색»(Browse files)
            // → FileBrowserSheet (repo 파일 트리).
            Thread.sleep(forTimeInterval: 2.0)
            let fb = byLabel(app.buttons, "파일 탐색", "Browse files")
            if fb.waitForExistence(timeout: 10), fb.isHittable { fb.tap() }
            Thread.sleep(forTimeInterval: 2.5)

        case "git":
            // PS_DEV_DEEPLINK 로 세션 채팅 진입 후 — «변경점 뷰어»(N uncommitted change(s))
            // → DiffSheet (커밋 안 된 변경 파일별 diff). 라벨은 카운트가 들어가므로 부분 매칭.
            Thread.sleep(forTimeInterval: 2.0)
            let diff = byLabel(app.buttons, "커밋되지 않은 변경", "uncommitted change")
            if diff.waitForExistence(timeout: 10), diff.isHittable { diff.tap() }
            Thread.sleep(forTimeInterval: 2.5)

        case "backlog":
            // 하단 «백로그» 탭 → PO 백로그 (스코어카드 · 리서치 · 의사결정 대기).
            tap(app, label: "백로그", "Backlog", fallback: CGVector(dx: 0.22, dy: 0.965))
            Thread.sleep(forTimeInterval: 2.0)

        case "security":
            // 설정 → 스크롤 → «보안 상태»(Security status) NavigationLink → SecurityStatusView.
            // 주의: 섹션 헤더 «연결 · 보안»(Connection · Security)이 "Security" 를 포함하므로
            //       반드시 정확히 "Security status" 로 매칭한다(헤더 오탭 방지). 링크는 화면
            //       아래쪽이라 보일 때까지 여러 번 스크롤.
            tap(app, label: "설정", "Settings", fallback: CGVector(dx: 0.05, dy: 0.088))
            Thread.sleep(forTimeInterval: 1.5)
            var tappedSecurity = false
            for _ in 0..<6 {
                let el = byLabel(app.buttons, "보안 상태", "Security status")
                if el.exists, el.isHittable { el.tap(); tappedSecurity = true; break }
                app.swipeUp()
                Thread.sleep(forTimeInterval: 0.6)
            }
            if !tappedSecurity {
                let el = byLabel(app.staticTexts, "보안 상태", "Security status")
                if el.exists, el.isHittable { el.tap() }
            }
            Thread.sleep(forTimeInterval: 2.0)

        default:
            break
        }

        Thread.sleep(forTimeInterval: 2.0)
        FileManager.default.createFile(atPath: readyMarkerPath, contents: Data(shot.utf8))
        // 외부 드라이버가 촬영할 시간 — 마커 본 뒤 simctl screenshot.
        Thread.sleep(forTimeInterval: 22)
    }
}
