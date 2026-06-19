import Foundation

/// 앱 커스텀 URL scheme + 딥링크 상수. daemon 의 Discord 알림이 박는
/// `pocketsisyphus://session/<id>` 와 문자열이 1:1 로 일치해야 한다 — 양쪽이 이 리터럴
/// 하나에 합의한다. (daemon: `notify/discord.ts` 의 APP_DEEP_LINK_SCHEME / iOS: 여기 +
/// Info.plist 의 CFBundleURLSchemes.)
enum DeepLink {
    static let scheme = "pocketsisyphus"
    /// `pocketsisyphus://session/<id>` 의 host 부분.
    static let sessionHost = "session"

    /// 세션 딥링크 URL 생성 (테스트/공유용).
    static func session(_ id: String) -> URL? {
        URL(string: "\(scheme)://\(sessionHost)/\(id)")
    }

    /// `pocketsisyphus://session/<id>` → sessionId 추출. scheme/host 가 안 맞으면 nil.
    /// session id 는 UUID (슬래시 없음) 라 첫 path 컴포넌트만 꺼내면 충분하다.
    static func sessionId(from url: URL) -> String? {
        guard url.scheme?.lowercased() == scheme else { return nil }
        guard url.host?.lowercased() == sessionHost else { return nil }
        // pathComponents 는 "/abc" 에서 ["/", "abc"] — 맨 앞 "/" 를 건너뛴 첫 토큰.
        guard let id = url.pathComponents.first(where: { $0 != "/" }),
              !id.isEmpty else { return nil }
        return id
    }
}

/// 외부 진입(딥링크 / 알림 탭)으로 특정 세션을 열라는 요청을 보관하는 broker.
///
/// `PocketSisyphusApp` 의 `.onOpenURL` 이 `pocketsisyphus://session/<id>` 를 파싱해
/// `pendingSessionId` 에 박으면, `SessionsView` 가 세션 목록이 준비되는 대로 매칭되는
/// `SessionSummary` 를 찾아 NavigationStack 에 push 한 뒤 `consume()` 으로 비운다.
///
/// 콜드 런치(앱이 꺼져 있다 딥링크로 켜짐)에서도 페어 → 연결 → 목록 로드가 끝나는
/// 시점까지 요청이 유지된다 — SessionsView 가 처음 sessions 를 받는 순간 push 된다.
@MainActor
final class DeepLinkRouter: ObservableObject {
    /// 열어야 할 세션 id. nil 이면 대기 중인 딥링크 없음.
    @Published var pendingSessionId: String?
    /// 백로그 탭으로 전환 요청 (`pocketsisyphus://backlog`) — «새 브리프 도착» 알림의 착지점.
    /// MainTabView 가 onChange 로 소비한다 (프로/capability 게이트는 거기서 그대로 적용).
    @Published var pendingBacklog = false
    /// 특정 브리프 상세로 직행 (`pocketsisyphus://backlog/<briefId>`). BacklogView 가
    /// 목록 로드 후 매칭되는 브리프를 push 하고 비운다.
    @Published var pendingBacklogBriefId: String?
    /// 메인 모니터 미러링 열기 요청 (`pocketsisyphus://mirror`) — SessionsView 가 capability
    /// (screen_capture_v1) + 프로 게이트를 그대로 적용해 풀스크린 미러링을 띄우고 비운다.
    @Published var pendingMirror = false
    /// 워크플로우 run 캔버스로 직행 (`pocketsisyphus://workflow/<runId>`) — PO 워크플로우 승인
    /// 경로의 «머지 승인 대기»(po_gate) 알림 착지점. MainTabView 가 워크플로우 탭으로 전환하고
    /// WorkflowListView 가 runId → workflow 를 해석해 캔버스를 push 한 뒤 비운다.
    @Published var pendingWorkflowRunId: String?

    /// `.onOpenURL` 핸들러. 우리 scheme 의 세션/백로그/워크플로우/미러링 링크만 받아들이고 나머지는 무시한다.
    func handle(_ url: URL) {
        if url.scheme?.lowercased() == DeepLink.scheme,
           url.host?.lowercased() == "mirror" {
            NSLog("[DeepLink] 모니터 미러링 딥링크 수신")
            pendingMirror = true
            return
        }
        if url.scheme?.lowercased() == DeepLink.scheme,
           url.host?.lowercased() == "workflow" {
            guard let runId = url.pathComponents.first(where: { $0 != "/" }), !runId.isEmpty else {
                NSLog("[DeepLink] 워크플로우 딥링크에 runId 없음 — 무시")
                return
            }
            NSLog("[DeepLink] 워크플로우 run 딥링크 수신 run=%@", runId)
            pendingWorkflowRunId = runId
            return
        }
        if url.scheme?.lowercased() == DeepLink.scheme,
           url.host?.lowercased() == "backlog" {
            let briefId = url.pathComponents.first(where: { $0 != "/" })
            NSLog("[DeepLink] 백로그 딥링크 수신 brief=%@", briefId ?? "-")
            pendingBacklogBriefId = briefId
            pendingBacklog = true
            return
        }
        guard let sid = DeepLink.sessionId(from: url) else {
            NSLog("[DeepLink] 무시 — 해석 불가 URL: %@", url.absoluteString)
            return
        }
        NSLog("[DeepLink] 세션 딥링크 수신 sessionId=%@", sid)
        pendingSessionId = sid
    }

    /// 네비게이션이 처리됐을 때 호출 — 같은 링크로 다시 push 되지 않게 비운다.
    func consume() {
        pendingSessionId = nil
    }
}
