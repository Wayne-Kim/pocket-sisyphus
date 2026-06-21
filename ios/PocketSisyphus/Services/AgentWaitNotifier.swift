import Foundation
import UserNotifications

/// 「에이전트가 입력/승인 대기에 진입함」 을 «라이브 이벤트 구동» 로컬 알림으로 띄우는 단일 진실.
///
/// # 왜 라이브 이벤트인가 (백그라운드 폴링 아님)
///
/// 이 앱은 과거 BGAppRefreshTask 폴링 + 로컬 푸시를 한 번 도입했다 제거했다 (project.yml 의
/// UIBackgroundModes 주석 참고) — iOS 의 background fetch 지연(15분~수시간)이 «지금 결재할
/// 게 생겼다» 는 신호를 너무 늦게 줘 오히려 혼란스러웠기 때문이다. 그래서 여기선 BGTask 를
/// 다시 들이지 않는다. 대신 daemon 이 «대기 진입» 을 기존 WS 데이터 plane 으로 broadcast 하면
/// (pty-runner.broadcastWaitingEntry), 앱이 살아 있는 동안(포그라운드 + 짧은 백그라운드 윈도)
/// 그 라이브 이벤트를 받아 즉시 `UNUserNotificationCenter.add` 로 알림을 띄운다. 외부 인프라 0
/// — 메인테이너 릴레이/서버 없이 기존 SSH/Tor + 로컬 알림만 쓴다 (APNs 미사용).
///
/// # 책임
/// - UNNotificationCategory(actionable) 등록 + 권한 요청 + 델리게이트.
/// - 글로벌 WSClient(sessionId nil) 를 띄워 `session_event`(waiting/resolved) 를 소비.
/// - away-gating: 지금 «그 세션 채팅을 포그라운드로 보는 중» 이면 알림 무음.
/// - 알림 액션 «승인»(Enter)/«중지»(ESC) 를 기존 `ApiClient.ptyControl` 로 즉시 처리.
/// - 알림 탭 → `DeepLinkRouter` 로 해당 세션 딥링크.
/// - 처리 상태(대기/처리중/처리완료/실패) 를 `@Published` 로 노출 — 인앱 표시(SessionsView).
///
/// AppDelegate 가 launch 직후 델리게이트를 걸 수 있도록 싱글톤. 의존성(auth/conn/deepLink)은
/// 연결이 준비된 뒤 `configure(...)` 로 주입한다. 주입 전에 들어온 액션은 큐에 담았다 드레인한다.
@MainActor
final class AgentWaitNotifier: NSObject, ObservableObject {
    static let shared = AgentWaitNotifier()

    /// 한 세션의 알림 액션 처리 상태 — 인앱(SessionsView 대기 카드)이 «처리중/완료/실패» 를 비춘다.
    enum ActionState: Equatable { case waiting, processing, done, failed }

    /// sessionId → 최신 액션 상태. 대기 진입 시 `.waiting`, 액션 누르면 `.processing` →
    /// 성공 `.done` / 실패 `.failed`. 대기 해제(resolved)나 세션 진입 시 제거.
    @Published private(set) var actionStates: [String: ActionState] = [:]

    // MARK: - 주입 의존성
    private var auth: AuthStore?
    private var conn: ConnectionManager?
    private weak var deepLink: DeepLinkRouter?
    /// 함대 상태(세션 목록)의 앱 전역 단일 source of truth. 글로벌 WS 의 «대기 진입/해소»
    /// 이벤트가 올 때 이 캐시를 다시 채워(scheduleFleetRefresh) Live Activity 가 «앱 생존 동안»
    /// running→waiting 전이를 즉시 반영하게 한다. (Live Activity 자체는 FleetLiveActivityController
    /// 가 이 캐시를 구독해 갱신 — 이 notifier 는 «데이터 신선도» 만 책임진다.)
    private var sessionCache: SessionListCache?
    /// 세션 이벤트 연쇄를 짧게 coalesce 하는 fleet 목록 재요청 태스크.
    private var fleetRefreshTask: Task<Void, Never>?

    // MARK: - away-gating 상태
    /// 지금 채팅으로 열려 있는 세션 (ChatView 가 onAppear/onDisappear 로 세팅). nil = 목록/딴 화면.
    private var activeSessionId: String?
    /// 앱이 포그라운드에서 «보는 중» 인지 (AppLifecycle.isActive 미러).
    private var appActive: Bool = true

    // MARK: - 권한/델리게이트 1회성
    private var authorizationRequested = false
    private var categoriesRegistered = false

    /// 의존성 주입 전(콜드 런치 from 알림 액션)에 들어온 액션 — 준비되면 드레인.
    private var pendingActions: [(sessionId: String, kind: PendingActionKind)] = []
    private enum PendingActionKind { case approve, stop, open }

    // MARK: - 글로벌 WS 리스너
    private var globalWS: WSClient?

    // MARK: - 식별자 (daemon 과 합의 불필요 — iOS 내부 상수)
    private static let categoryId = "AGENT_WAIT"
    private static let approveActionId = "AGENT_WAIT_APPROVE"
    private static let stopActionId = "AGENT_WAIT_STOP"
    /// 세션당 알림 하나 — 같은 세션의 새 대기 진입은 기존 알림을 «교체» 한다.
    private static func requestId(_ sessionId: String) -> String { "agentwait-\(sessionId)" }

    private override init() {
        super.init()
        registerCategoriesIfNeeded()
    }

    // MARK: - 설정 / 주입

    /// 연결이 준비된 뒤 AppRoot 가 호출. 의존성 주입 + 델리게이트 + 권한 + 글로벌 WS 가동.
    /// 멱등 — 재호출 시 의존성만 갱신하고 WS 는 이미 떠 있으면 그대로 둔다.
    func configure(auth: AuthStore, conn: ConnectionManager, deepLink: DeepLinkRouter, sessionCache: SessionListCache) {
        self.auth = auth
        self.conn = conn
        self.deepLink = deepLink
        self.sessionCache = sessionCache
        UNUserNotificationCenter.current().delegate = self
        registerCategoriesIfNeeded()
        requestAuthorizationIfNeeded()
        startGlobalListener(auth: auth, conn: conn)
        drainPendingActions()
    }

    /// 페어링 해제 등으로 의존성이 사라질 때 — 글로벌 WS 정리 + 상태 비움.
    func teardown() {
        globalWS?.stop()
        globalWS = nil
        fleetRefreshTask?.cancel()
        fleetRefreshTask = nil
        sessionCache = nil
        actionStates.removeAll()
    }

    /// ChatView 진입/이탈이 세팅 — away-gating + 이미 보고 있는 세션 알림 즉시 정리.
    func setActiveSession(_ sessionId: String?) {
        activeSessionId = sessionId
        if let sid = sessionId {
            // 사용자가 그 방을 직접 열었으니 더는 알림이 필요 없다.
            clear(sessionId: sid)
        }
    }

    /// 앱 포그라운드/백그라운드 — AppLifecycle.isActive 미러. 포그라운드 복귀 시 WS kick.
    func setAppActive(_ active: Bool) {
        appActive = active
        if active { globalWS?.kick() }
    }

    // MARK: - 들어오는 대기 이벤트

    /// 글로벌 WS 의 `session_event` 를 받아 분기. waiting → 알림, resolved → 정리.
    private func handleSessionEvent(
        kind: String, sessionId: String,
        repoName: String?, title: String?, agentName: String?, preview: String?,
    ) {
        // 함대 상태가 바뀌었을 가능성이 있는 모든 이벤트(대기 진입·해소·턴 완료)에서 세션 목록을
        // 다시 채워, 잠금화면 Live Activity 가 running→waiting/해소를 «앱 생존 동안» 즉시 반영하게 한다.
        scheduleFleetRefresh()

        switch kind {
        case "waiting":
            handleWaitingEntry(
                sessionId: sessionId, repoName: repoName,
                title: title, agentName: agentName, preview: preview,
            )
        case "resolved", "turn_complete":
            // resolved = 사용자가 응답/출력 재개/PTY 종료. turn_complete(레거시 글로벌)도 같이 정리.
            // (turn_complete 는 «대기 진입» 도 의미하지만 컨텍스트가 없어 알림은 waiting 만 띄운다.)
            if kind == "resolved" { clear(sessionId: sessionId) }
        default:
            break
        }
    }

    /// 대기 진입 — away-gating 통과하면 actionable 로컬 알림을 즉시 띄운다.
    func handleWaitingEntry(
        sessionId: String, repoName: String?,
        title: String?, agentName: String?, preview: String?,
    ) {
        // away-gating — 지금 그 세션을 포그라운드로 보고 있으면 무음 (이미 화면에서 봄).
        if appActive && activeSessionId == sessionId { return }

        requestAuthorizationIfNeeded()
        actionStates[sessionId] = .waiting

        let content = UNMutableNotificationContent()
        // repoName/세션 제목/미리보기는 «에이전트·사용자 데이터» 라 번역 대상이 아니다 (verbatim).
        content.title = (repoName?.isEmpty == false ? repoName! : String(localized: "에이전트"))
        // 부제: 세션 제목 > 에이전트 이름 (식별 보강).
        if let t = title?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty {
            content.subtitle = t
        } else if let a = agentName?.trimmingCharacters(in: .whitespacesAndNewlines), !a.isEmpty {
            content.subtitle = a
        }
        // 본문: 대기 사유 미리보기(verbatim) 가 있으면 그걸, 없으면 localize 된 기본 안내.
        let trimmedPreview = preview?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let p = trimmedPreview, !p.isEmpty {
            content.body = p
        } else {
            content.body = String(localized: "에이전트가 승인이나 입력을 기다리고 있어요.")
        }
        content.categoryIdentifier = Self.categoryId
        content.userInfo = ["sessionId": sessionId]
        content.sound = .default
        // 주의를 끌되 Focus 를 함부로 뚫지 않게 — time-sensitive 엔타이틀먼트 없이 active 레벨.
        content.interruptionLevel = .active
        // 대기 «건수» 가 한눈에 보이게 — 미해소 대기 세션 수를 배지로.
        content.badge = NSNumber(value: actionStates.values.filter { $0 == .waiting }.count)

        let request = UNNotificationRequest(
            identifier: Self.requestId(sessionId),
            content: content,
            trigger: nil,  // 즉시 — 라이브 이벤트 구동 (백그라운드 폴링/스케줄 아님).
        )
        UNUserNotificationCenter.current().add(request) { error in
            if let error {
                NSLog("[AgentWaitNotifier] add 실패 sid=%@: %@", sessionId, error.localizedDescription)
            }
        }
    }

    /// 한 세션의 대기 알림 정리 — 전달됨/대기 중 모두 제거 + 상태 비움 + 배지 갱신.
    /// (away-gating·세션 진입·resolved 가 호출. 인앱 상태도 함께 비운다.)
    func clear(sessionId: String) {
        dismissNotification(sessionId: sessionId)
        if actionStates[sessionId] != nil {
            actionStates[sessionId] = nil
        }
        refreshBadge()
    }

    /// OS 알림(배너/잠금화면)만 제거 — 인앱 actionStates 는 건드리지 않는다. 액션 «성공» 직후
    /// 알림은 치우되 «처리 완료» 배지는 잠깐 보여 주기 위한 분리 (clear 는 둘 다 비운다).
    private func dismissNotification(sessionId: String) {
        let id = Self.requestId(sessionId)
        let center = UNUserNotificationCenter.current()
        center.removeDeliveredNotifications(withIdentifiers: [id])
        center.removePendingNotificationRequests(withIdentifiers: [id])
        refreshBadge()
    }

    /// 터미널 상태(.done/.failed)를 일정 시간 뒤 자동으로 비운다 — «처리 완료» 배지가 영구
    /// 잔류하지 않게. 그 사이 daemon 의 resolved 가 와서 먼저 clear 하면 이 fallback 은 no-op.
    private func scheduleActionStateClear(sessionId: String, expecting state: ActionState, after seconds: Double) {
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            guard let self else { return }
            if self.actionStates[sessionId] == state {
                self.actionStates[sessionId] = nil
            }
        }
    }

    // MARK: - 액션 처리 (승인/중지)

    /// 승인 = Enter — 권한 prompt 의 기본 선택지 확정. 기존 bulk control 채널 재사용.
    private func approve(sessionId: String) { performControl(sessionId: sessionId, action: .approve) }
    /// 중지/거절 = ESC — 진행/대기 turn 중단 (파괴적). PTY 는 죽이지 않는다.
    private func stop(sessionId: String) { performControl(sessionId: sessionId, action: .interrupt) }

    private func performControl(sessionId: String, action: PtyControlAction) {
        guard let api = makeApi() else {
            // 콜드 런치 등 의존성 미준비 — 큐에 담아 configure 후 드레인.
            pendingActions.append((sessionId, action == .approve ? .approve : .stop))
            return
        }
        actionStates[sessionId] = .processing
        Task { [weak self] in
            do {
                try await api.ptyControl(sessionId: sessionId, action: action)
                self?.actionStates[sessionId] = .done
                // 알림은 즉시 치우되 «처리 완료» 배지는 잠깐 남긴다 — daemon 의 resolved 가
                // 곧 와서 clear 하거나, 안 오면 fallback 이 비운다 (영구 잔류 방지).
                self?.dismissNotification(sessionId: sessionId)
                self?.scheduleActionStateClear(sessionId: sessionId, expecting: .done, after: 4)
            } catch {
                // 빈/오류 처리 — 실패는 인앱에 .failed 로 남겨 사용자가 세션을 직접 열게 유도.
                NSLog("[AgentWaitNotifier] %@ 실패 sid=%@: %@",
                      action.rawValue, sessionId, error.localizedDescription)
                self?.actionStates[sessionId] = .failed
            }
        }
    }

    /// 알림 탭(또는 의존성 미준비 중지/승인 후) — 해당 세션으로 딥링크.
    private func openSession(_ sessionId: String) {
        guard let deepLink else {
            pendingActions.append((sessionId, .open))
            return
        }
        deepLink.pendingSessionId = sessionId
        clear(sessionId: sessionId)
    }

    // MARK: - 내부 헬퍼

    private func makeApi() -> ApiClient? {
        guard let auth, let conn else { return nil }
        return ApiClient(auth: auth, conn: conn)
    }

    /// 함대 목록을 조용히(label nil — in-flight 배너 미표시) 다시 받아 `SessionListCache` 를 갱신한다.
    /// 여러 세션 이벤트가 연달아 오면 400ms 로 coalesce 해 한 번만 받는다. 실패는 무시 — 다음
    /// 이벤트/폴링이 곧 메운다. (Live Activity 갱신은 캐시를 구독하는 FleetLiveActivityController 가 처리.)
    private func scheduleFleetRefresh() {
        guard let auth, let conn, let sessionCache else { return }
        fleetRefreshTask?.cancel()
        fleetRefreshTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 400_000_000)
            if Task.isCancelled { return }
            let api = ApiClient(auth: auth, conn: conn)
            guard let list = try? await api.listSessions(label: nil) else { return }
            if Task.isCancelled { return }
            sessionCache.save(list)
            _ = self
        }
    }

    private func drainPendingActions() {
        guard !pendingActions.isEmpty else { return }
        let queued = pendingActions
        pendingActions.removeAll()
        for item in queued {
            switch item.kind {
            case .approve: approve(sessionId: item.sessionId)
            case .stop: stop(sessionId: item.sessionId)
            case .open: openSession(item.sessionId)
            }
        }
    }

    private func refreshBadge() {
        let count = actionStates.values.filter { $0 == .waiting }.count
        UNUserNotificationCenter.current().setBadgeCount(count) { _ in }
    }

    private func registerCategoriesIfNeeded() {
        if categoriesRegistered { return }
        categoriesRegistered = true
        // 승인 = 기본 액션. 중지 = .destructive → 시스템이 «빨강(danger)» 으로 렌더 (의미 토큰 준수:
        // 거절/중지=danger). 두 액션 모두 .authenticationRequired — 잠금 화면에선 기기 인증 후에만
        // 실행돼 «민감 동작 생체인증 인라인» 을 시스템 차원에서 충족한다.
        // 타이틀 자체가 localize 돼 VoiceOver 의 접근성 레이블로 읽힌다 (10개 언어 카탈로그).
        let approveAction = UNNotificationAction(
            identifier: Self.approveActionId,
            title: String(localized: "승인"),
            options: [.authenticationRequired],
        )
        let stopAction = UNNotificationAction(
            identifier: Self.stopActionId,
            title: String(localized: "중지"),
            options: [.authenticationRequired, .destructive],
        )
        let category = UNNotificationCategory(
            identifier: Self.categoryId,
            actions: [approveAction, stopAction],
            intentIdentifiers: [],
            options: [],
        )
        UNUserNotificationCenter.current().setNotificationCategories([category])
    }

    private func requestAuthorizationIfNeeded() {
        if authorizationRequested { return }
        authorizationRequested = true
        UNUserNotificationCenter.current().requestAuthorization(
            options: [.alert, .sound, .badge],
        ) { granted, error in
            if let error {
                NSLog("[AgentWaitNotifier] 권한 요청 오류: %@", error.localizedDescription)
            } else {
                NSLog("[AgentWaitNotifier] 알림 권한 granted=%d", granted ? 1 : 0)
            }
        }
    }

    private func startGlobalListener(auth: AuthStore, conn: ConnectionManager) {
        if globalWS != nil { return }
        let ws = WSClient(auth: auth, conn: conn, sessionId: nil) { [weak self] event in
            guard let self else { return }
            if case let .sessionEvent(kind, sid, repoName, title, agentName, preview) = event {
                self.handleSessionEvent(
                    kind: kind, sessionId: sid,
                    repoName: repoName, title: title, agentName: agentName, preview: preview,
                )
            }
        }
        globalWS = ws
        ws.start()
    }
}

// MARK: - UNUserNotificationCenterDelegate

extension AgentWaitNotifier: UNUserNotificationCenterDelegate {
    /// 포그라운드에서 알림이 도착했을 때의 표시 방식. 지금 그 세션을 보고 있으면 숨긴다
    /// (away-gating 의 포그라운드 분기), 아니면 배너+사운드+목록으로 보여 준다.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void,
    ) {
        let sid = notification.request.content.userInfo["sessionId"] as? String
        Task { @MainActor in
            if let sid, self.appActive, self.activeSessionId == sid {
                completionHandler([])
            } else {
                completionHandler([.banner, .sound, .list, .badge])
            }
        }
    }

    /// 알림 액션/탭 응답. 승인/중지는 즉시 처리, 본문 탭은 세션 딥링크.
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void,
    ) {
        let actionId = response.actionIdentifier
        let sid = response.notification.request.content.userInfo["sessionId"] as? String
        Task { @MainActor in
            if let sid {
                switch actionId {
                case Self.approveActionId:
                    self.approve(sessionId: sid)
                case Self.stopActionId:
                    self.stop(sessionId: sid)
                default:
                    // UNNotificationDefaultActionIdentifier (본문 탭) — 세션으로 진입.
                    self.openSession(sid)
                }
            }
            completionHandler()
        }
    }
}
