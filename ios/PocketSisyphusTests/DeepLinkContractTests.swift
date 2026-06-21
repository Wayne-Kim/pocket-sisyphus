import XCTest

// DeepLinkRouter.swift / DeepLinkConsumeGate.swift 는 host-less library test 패턴으로 이 번들에
// 직접 컴파일된다 (project.yml 의 PocketSisyphusTests.sources 참고).

/// 딥링크 우회 위협의 계약(契約) 테스트.
///
/// ## 위협(무엇을·누가)
/// 악성 웹페이지/앱/메시지가 위조 `pocketsisyphus://` 딥링크를 발사해 (1) 잠금(Secure Enclave)
/// 인증을 건너뛰고 화면을 열거나 (2) 프로/capability 게이트를 우회해 고급 기능을 무료로 여는 것.
///
/// ## 완화책(이 테스트가 못박는 불변식)
///  - `DeepLinkRouter.handle` 은 «상태만» 세팅한다 — 어떤 화면도 직접 열지 않는다(네비게이션·present
///    없음). 실제 «소비» 는 `DeepLinkConsumeGate`(잠금 + capability + 프로)를 통과해야 한다.
///  - 이전엔 이 안전이 «뷰 렌더 순서»(AppRoot 가 LockView 뒤에서만 소비 화면을 그림)에서 창발하는
///    암묵적 불변식이었다. 향후 리팩터로 조용히 우회가 열려도 잡히지 않았다 — 그 핀을 박는다.
@MainActor
final class DeepLinkContractTests: XCTestCase {

    // 위조 딥링크 4종.
    private let sessionURL = DeepLink.session("11111111-2222-3333-4444-555555555555")!
    private let mirrorURL = URL(string: "pocketsisyphus://mirror")!
    private let backlogURL = URL(string: "pocketsisyphus://backlog")!
    private let workflowURL = URL(string: "pocketsisyphus://workflow/run-abc")!

    // 모든 capability 보유 + 프로 해제 — «게이트만» 분리해 검증하기 위한 «가장 관대한» 환경.
    private let allCaps: Set<String> = [
        DeepLinkConsumeGate.mirrorCapability,
        DeepLinkConsumeGate.backlogCapability,
        DeepLinkConsumeGate.workflowCapability,
    ]

    // MARK: - (d) handle 은 «우리 scheme/host» 만 받아들이고 상태«만» 세팅한다

    /// 세션 딥링크 → pendingSessionId «만» 세팅(다른 pending 오염 없음).
    func test_handle_session_setsOnlyPendingSession() {
        let r = DeepLinkRouter()
        r.handle(sessionURL)
        XCTAssertEqual(r.pendingSessionId, "11111111-2222-3333-4444-555555555555")
        XCTAssertFalse(r.pendingMirror)
        XCTAssertFalse(r.pendingBacklog)
        XCTAssertNil(r.pendingWorkflowRunId)
        XCTAssertNil(r.pendingBacklogBriefId)
    }

    func test_handle_mirror_setsOnlyPendingMirror() {
        let r = DeepLinkRouter()
        r.handle(mirrorURL)
        XCTAssertTrue(r.pendingMirror)
        XCTAssertNil(r.pendingSessionId)
        XCTAssertFalse(r.pendingBacklog)
        XCTAssertNil(r.pendingWorkflowRunId)
    }

    func test_handle_backlog_setsOnlyPendingBacklog() {
        let r = DeepLinkRouter()
        r.handle(backlogURL)
        XCTAssertTrue(r.pendingBacklog)
        XCTAssertNil(r.pendingBacklogBriefId)  // host 만 있고 briefId 없음
        XCTAssertFalse(r.pendingMirror)
        XCTAssertNil(r.pendingSessionId)
        XCTAssertNil(r.pendingWorkflowRunId)
    }

    func test_handle_backlogBrief_setsBriefId() {
        let r = DeepLinkRouter()
        r.handle(URL(string: "pocketsisyphus://backlog/brief-77")!)
        XCTAssertTrue(r.pendingBacklog)
        XCTAssertEqual(r.pendingBacklogBriefId, "brief-77")
    }

    func test_handle_workflow_setsOnlyPendingWorkflow() {
        let r = DeepLinkRouter()
        r.handle(workflowURL)
        XCTAssertEqual(r.pendingWorkflowRunId, "run-abc")
        XCTAssertFalse(r.pendingMirror)
        XCTAssertFalse(r.pendingBacklog)
        XCTAssertNil(r.pendingSessionId)
    }

    /// 알 수 없는 host → 어떤 pending 도 세팅하지 않음(무시).
    func test_handle_unknownHost_ignored() {
        let r = DeepLinkRouter()
        r.handle(URL(string: "pocketsisyphus://evilhost/payload")!)
        assertNoPending(r)
    }

    /// 워크플로우인데 runId 없음 → pending 세팅 안 함(무시).
    func test_handle_workflowWithoutRunId_ignored() {
        let r = DeepLinkRouter()
        r.handle(URL(string: "pocketsisyphus://workflow")!)
        XCTAssertNil(r.pendingWorkflowRunId)
        assertNoPending(r)
    }

    /// 외부(위조) scheme → 우리 scheme 이 아니므로 전부 무시. 다른 앱/웹이 박을 수 있는 표면.
    func test_handle_foreignScheme_ignored() {
        let r = DeepLinkRouter()
        for s in ["https", "evil", "pocketsisyphusx"] {
            r.handle(URL(string: "\(s)://session/abc")!)
            r.handle(URL(string: "\(s)://mirror")!)
            r.handle(URL(string: "\(s)://workflow/x")!)
            r.handle(URL(string: "\(s)://backlog")!)
        }
        assertNoPending(r)
    }

    /// scheme 대소문자는 허용(우리 것), 그래도 «상태만» 세팅.
    func test_handle_schemeCaseInsensitive() {
        let r = DeepLinkRouter()
        r.handle(URL(string: "POCKETSISYPHUS://MIRROR")!)
        XCTAssertTrue(r.pendingMirror)
    }

    // MARK: - (a) needsAuthGate=true 이면 4종 모두 «소비 불가»

    /// 잠금 게이트가 떠 있는 동안(authGated=true)에는 어떤 딥링크도 소비되지 않는다 —
    /// capability·프로를 «모두» 보유해도 그렇다(잠금이 최상위 전제).
    func test_authGated_blocksAllConsumption_evenFullyEntitled() {
        XCTAssertFalse(DeepLinkConsumeGate.mayConsumeAny(authGated: true))
        XCTAssertFalse(DeepLinkConsumeGate.mayConsumeSession(authGated: true))
        XCTAssertFalse(DeepLinkConsumeGate.mayOpenMirror(authGated: true, capabilities: allCaps, proUnlocked: true))
        XCTAssertFalse(DeepLinkConsumeGate.mayOpenBacklog(authGated: true, capabilities: allCaps, proUnlocked: true))
        XCTAssertFalse(DeepLinkConsumeGate.mayOpenWorkflow(authGated: true, capabilities: allCaps, proUnlocked: true))
    }

    /// 잠금 중에도 router 는 pending 을 «세팅» 한다(콜드 런치 보존을 위해) — 다만 소비만 막힌다.
    /// 즉 «세팅 ≠ 소비»: handle 은 상태만, 게이트가 소비를 통제.
    func test_authGated_routerStillRecordsPending_butGateDenies() {
        let r = DeepLinkRouter()
        r.handle(mirrorURL)
        XCTAssertTrue(r.pendingMirror, "콜드 런치 보존 — 게이트 통과 후 소비하려면 pending 이 남아야")
        XCTAssertFalse(
            DeepLinkConsumeGate.mayOpenMirror(authGated: true, capabilities: allCaps, proUnlocked: true),
            "그러나 잠금 중에는 소비 불가"
        )
    }

    // MARK: - (b) 콜드 런치 — pending 보존되되 게이트 통과 후에만 소비

    /// 게이트 전이: authGated=true 일 땐 거부, false 가 되고 capability+프로가 갖춰진 뒤에만 허용.
    /// 그 사이 router pending 은 (consume 전까지) 그대로 보존된다.
    func test_coldLaunch_pendingPreserved_consumedOnlyAfterGatePasses() {
        let r = DeepLinkRouter()
        r.handle(sessionURL)  // 콜드 런치 시점 주입
        XCTAssertNotNil(r.pendingSessionId)

        // 잠금 중 — 거부.
        XCTAssertFalse(DeepLinkConsumeGate.mayConsumeSession(authGated: true))
        XCTAssertNotNil(r.pendingSessionId, "거부돼도 pending 보존")

        // 잠금 해제 후 — 허용. (세션은 기본 무료 — capability/프로 불요.)
        XCTAssertTrue(DeepLinkConsumeGate.mayConsumeSession(authGated: false))

        // 소비 후에만 비워진다.
        r.consume()
        XCTAssertNil(r.pendingSessionId)
        XCTAssertTrue(DeepLinkConsumeGate.mayConsumeAny(authGated: false))
    }

    // MARK: - (c) capability/Pro 미보유 시 mirror/backlog/workflow 는 «열리지 않음»

    func test_mirror_requiresCapabilityAndPro() {
        // 둘 다 보유 → 열림.
        XCTAssertTrue(DeepLinkConsumeGate.mayOpenMirror(authGated: false, capabilities: allCaps, proUnlocked: true))
        // capability 없음 → 차단.
        XCTAssertFalse(DeepLinkConsumeGate.mayOpenMirror(authGated: false, capabilities: [], proUnlocked: true))
        // 프로 미보유 → 차단.
        XCTAssertFalse(DeepLinkConsumeGate.mayOpenMirror(authGated: false, capabilities: allCaps, proUnlocked: false))
    }

    func test_backlog_requiresCapabilityAndPro() {
        XCTAssertTrue(DeepLinkConsumeGate.mayOpenBacklog(authGated: false, capabilities: allCaps, proUnlocked: true))
        XCTAssertFalse(DeepLinkConsumeGate.mayOpenBacklog(authGated: false, capabilities: [], proUnlocked: true))
        XCTAssertFalse(DeepLinkConsumeGate.mayOpenBacklog(authGated: false, capabilities: allCaps, proUnlocked: false))
    }

    func test_workflow_requiresCapabilityAndPro() {
        XCTAssertTrue(DeepLinkConsumeGate.mayOpenWorkflow(authGated: false, capabilities: allCaps, proUnlocked: true))
        XCTAssertFalse(DeepLinkConsumeGate.mayOpenWorkflow(authGated: false, capabilities: [], proUnlocked: true))
        XCTAssertFalse(DeepLinkConsumeGate.mayOpenWorkflow(authGated: false, capabilities: allCaps, proUnlocked: false))
    }

    /// 한 capability 만 있어도 «다른» 프로 화면은 안 열린다(capability 가 서로 격리됨).
    func test_capabilitiesAreIsolatedPerFeature() {
        let onlyMirror: Set<String> = [DeepLinkConsumeGate.mirrorCapability]
        XCTAssertTrue(DeepLinkConsumeGate.mayOpenMirror(authGated: false, capabilities: onlyMirror, proUnlocked: true))
        XCTAssertFalse(DeepLinkConsumeGate.mayOpenBacklog(authGated: false, capabilities: onlyMirror, proUnlocked: true))
        XCTAssertFalse(DeepLinkConsumeGate.mayOpenWorkflow(authGated: false, capabilities: onlyMirror, proUnlocked: true))
    }

    // MARK: - helpers

    private func assertNoPending(_ r: DeepLinkRouter, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertNil(r.pendingSessionId, file: file, line: line)
        XCTAssertFalse(r.pendingMirror, file: file, line: line)
        XCTAssertFalse(r.pendingBacklog, file: file, line: line)
        XCTAssertNil(r.pendingBacklogBriefId, file: file, line: line)
        XCTAssertNil(r.pendingWorkflowRunId, file: file, line: line)
    }
}
