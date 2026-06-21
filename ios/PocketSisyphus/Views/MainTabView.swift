import SwiftUI
import UIKit  // 워크플로우 «탭 버튼» 아이콘만 주황으로 고정(alwaysOriginal)하기 위해

/// 앱 메인 화면 — 페어·연결·구독이 모두 통과한 뒤 AppRoot 가 띄우는 탭 컨테이너.
///
/// 이전엔 SessionsView 하나가 메인이었고 워크플로우는 그 툴바 버튼으로 push 됐다. 워크플로우가
/// 노드 실행마다 세션을 만들어 세션 목록과 성격이 섞이던 걸 분리: 이제 「세션」 / 「자동화」
/// 두 탭으로 나눈다. 각 탭은 자기 NavigationStack 을 갖는다.
///
/// - 세션 탭: SessionsView (세션 목록 + 새 세션 + 설정/도움말). repo daemon capability 를
///   reload 때 채워 `capabilities` 바인딩으로 끌어올린다 — 그 값으로 자동화 탭 노출/세그먼트
///   구성을 판단해 /api/version 을 한 번만 치도록 공유한다.
/// - 자동화 탭: workflow_v1 또는 cron_v1 중 하나라도 지원하면 보인다(둘 다 미지원 = 탭 숨김,
///   soft-gate). 안에서 「워크플로우 | 예약」 세그먼트로 두 도메인을 묶고, 지원하는 세그먼트만
///   노출한다. 노드/예약 실행 세션을 열면 세션 탭으로 전환하면서 deepLink 로 그 채팅방을 띄운다.
struct MainTabView: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var conn: ConnectionManager
    @EnvironmentObject var inflight: InFlightTracker
    @EnvironmentObject var deepLink: DeepLinkRouter
    /// 프로(주황) 기능 게이트 — 워크플로우 탭은 프로 전용. 미보유 시 탭 전환 대신 페이월.
    @EnvironmentObject var purchase: PurchaseStore

    /// 선택된 탭. 워크플로우에서 세션을 열 때 .sessions 로 전환한다.
    @State private var selectedTab: Tab = .sessions
    /// daemon capability — Sessions.reload 가 채운다. 워크플로우 탭 노출 게이트로 읽는다.
    @State private var capabilities: [String] = []
    /// 프로 게이트 페이월 — non-nil 이면 `.proPaywall` 가 PaywallView 를 띄운다(어떤 프로 기능이
    /// trigger 했는지 태깅). 워크플로우 탭은 프로 전용이라 미보유 사용자가 탭하면 여기에 실린다.
    @State private var paywallFeature: ProFeature?
    /// 미러링 딥링크(pocketsisyphus://mirror)가 띄우는 메인 모니터 미러링 — 어느 탭에 있어도
    /// 뜨도록 탭 컨테이너가 직접 cover 를 소유한다(세션 탭 안의 cover 는 비활성 탭이면 안 뜬다).
    @State private var showMirror = false

    enum Tab: Hashable { case backlog, sessions, workflows }

    /// 탭 선택 바인딩 — 백로그/워크플로우 탭은 프로 전용이라, 미보유 사용자가 그 탭을 누르면
    /// 전환하지 않고 페이월을 띄운다(둘 다 capability 게이트로 노출이 먼저 갈리고, 결제 게이트를 더함).
    private var tabSelection: Binding<Tab> {
        Binding(
            get: { selectedTab },
            set: { newValue in
                if newValue == .workflows, !purchase.isUnlocked(.workflow) {
                    paywallFeature = .workflow
                } else if newValue == .backlog, !purchase.isUnlocked(.poLoop) {
                    paywallFeature = .poLoop
                } else {
                    selectedTab = newValue
                }
            }
        )
    }

    var body: some View {
        TabView(selection: tabSelection) {
            // 백로그(PO 루프) — «1번 탭». 에이전트가 수집한 기회 브리프를 사람이 결재만 하는
            // 화면이라 «무엇을 할지» 가 앱의 첫 인상이 되도록 맨 앞에 둔다. po_loop_v1 daemon
            // 일 때만 노출(soft), 프로(주황) 기능.
            if capabilities.contains("po_loop_v1") {
                BacklogTab(capabilities: capabilities) { sid in
                    deepLink.pendingSessionId = sid
                    selectedTab = .sessions
                }
                .tabItem {
                    Label {
                        Text("백로그")
                    } icon: {
                        Self.backlogTabIcon
                    }
                }
                .tag(Tab.backlog)
            }

            SessionsView(capabilities: $capabilities)
                .tabItem { Label("세션", systemImage: "bubble.left.and.bubble.right") }
                .tag(Tab.sessions)

            // 자동화 탭 — 워크플로우(workflow_v1)와 예약(cron_v1)을 «워크플로우 | 예약» 세그먼트로
            // 묶는 pro(주황) 도메인 홈. 예약은 이전엔 세션 탭(무료) 툴바의 주황 버튼이었으나, 같은
            // pro 도메인끼리 묶어 통일성을 회복했다. 둘 중 하나라도 지원하면 탭을 노출(soft-gate);
            // 안에서 지원하는 세그먼트만 보인다(미지원 세그먼트는 숨김).
            if capabilities.contains("workflow_v1") || capabilities.contains("cron_v1") {
                AutomationTab(capabilities: capabilities) { sid in
                    // 노드/예약 실행 결과 세션 열기 — 세션 탭으로 전환 후 deepLink 로 그 방을 띄운다.
                    deepLink.pendingSessionId = sid
                    selectedTab = .sessions
                }
                // 자동화는 프로(멤버십/영구이용권) 기능 → «탭 버튼» 만 주황으로 표시한다.
                // .tint 는 탭 콘텐츠(툴바 버튼·세그먼트 등)까지 물들이고 정작 탭 버튼은 안 바뀌므로
                // 쓰지 않고, 아이콘을 alwaysOriginal 주황으로 구워 탭 버튼만 주황으로 둔다. 탭 안
                // 버튼·세그먼트는 기본 틴트(accent)를 그대로 — 세션 탭과 동일.
                .tabItem {
                    Label {
                        Text("자동화")
                    } icon: {
                        Self.automationTabIcon
                    }
                }
                .tag(Tab.workflows)
            }

            // 커뮤니티는 더 이상 영속 탭이 아니다 — in-app 포럼은 임계 질량을 못 만들고
            // 개발자는 이미 GitHub/Discord 에 산다. 커뮤니티 진입은 설정 안의 외부 링크
            // (GitHub Discussions, SFSafariViewController)로 옮겼다(SettingsSheet 참고).
        }
        .proPaywall(item: $paywallFeature)
        // 지금 «선택된 탭» 을 environment 로 흘려, 각 탭의 «탭 바 숨김»(채팅·워크플로우 캔버스
        // 등 `.toolbar(.hidden, for: .tabBar)`)이 «자기 탭이 활성일 때만» 적용되게 한다. 딥링크로
        // 다른 탭으로 프로그래매틱 전환할 때, 떠나는 탭 스택에 남은 숨김 뷰가 TabView 전체의 탭 바를
        // 계속 가려 «탭 바 없는 화면에 갇히는» SwiftUI cross-tab 누출 버그를 막는다(웜 진입 시 재현).
        .environment(\.activeMainTab, selectedTab)
        // 백로그 딥링크 (pocketsisyphus://backlog) — «새 브리프 도착» 알림의 착지점.
        // tabSelection setter 를 그대로 거쳐 프로 게이트가 동일하게 적용된다.
        // 콜드 런치 레이스: capabilities 는 SessionsView 의 reload 가 뒤늦게 채우므로,
        // pendingBacklog 변화와 capabilities 도착 «양쪽» 에서 시도한다 (먼저 온 쪽은 no-op).
        .onChange(of: deepLink.pendingBacklog) { _ in consumeBacklogDeepLinkIfReady() }
        .onChange(of: capabilities) { _ in
            consumeBacklogDeepLinkIfReady()
            consumeMirrorDeepLinkIfReady()
            consumeWorkflowDeepLinkIfReady()
        }
        // 미러링 딥링크 (pocketsisyphus://mirror) — 백로그와 같은 콜드 런치 레이스 처리.
        .onChange(of: deepLink.pendingMirror) { _ in consumeMirrorDeepLinkIfReady() }
        // 워크플로우 run 딥링크 (pocketsisyphus://workflow/<runId>) — PO «머지 승인 대기»
        // (po_gate) 알림의 착지점. 여기서는 탭 전환만 (프로 게이트는 tabSelection setter 가
        // 그대로 적용) — runId → 캔버스 push 는 WorkflowListView 가 소비한다.
        .onChange(of: deepLink.pendingWorkflowRunId) { _ in consumeWorkflowDeepLinkIfReady() }
        // 세션 탭의 툴바 버튼과 같은 화면 — 진입 경로만 다르다(알림/검증 루프의 착지점).
        .fullScreenCover(isPresented: $showMirror) {
            MonitorMirrorView(
                sessionId: MonitorMirrorView.desktopSessionId,
                api: ApiClient(auth: auth, conn: conn, tracker: inflight),
                conn: conn,
                canControl: capabilities.contains("remote_control_v1"),
                supportsH264: capabilities.contains("screen_h264_v1"),
            )
        }
    }

    private func consumeBacklogDeepLinkIfReady() {
        guard deepLink.pendingBacklog, capabilities.contains(DeepLinkConsumeGate.backlogCapability) else { return }
        tabSelection.wrappedValue = .backlog
        deepLink.pendingBacklog = false
    }

    /// 미러링 딥링크 소비 — 세션 탭 툴바 버튼과 같은 게이트(capability + 프로)를 통과해야 연다.
    private func consumeMirrorDeepLinkIfReady() {
        guard deepLink.pendingMirror, capabilities.contains(DeepLinkConsumeGate.mirrorCapability) else { return }
        deepLink.pendingMirror = false
        purchase.gate(.monitorMirror, $paywallFeature) { showMirror = true }
    }

    /// 워크플로우 run 딥링크 — 탭 전환만 (백로그 딥링크와 같은 콜드 런치 레이스 처리).
    /// pendingWorkflowRunId 는 비우지 않는다 — WorkflowListView 가 runId 를 해석해
    /// 캔버스를 push 한 뒤 비운다 (탭 전환과 push 의 주체가 다르다).
    private func consumeWorkflowDeepLinkIfReady() {
        guard deepLink.pendingWorkflowRunId != nil, capabilities.contains(DeepLinkConsumeGate.workflowCapability) else { return }
        tabSelection.wrappedValue = .workflows
    }

    /// 자동화 탭 아이콘 — «주황 = 프로» 약속색으로 항상 고정한다(선택/비선택 무관). 텍스트
    /// 라벨 색은 시스템 기본을 따른다. SF Symbol 을 alwaysOriginal 로 칠해 시스템 틴트를 우회.
    private static let automationTabIcon: Image = proTabIcon("point.3.connected.trianglepath.dotted")
    /// 백로그(PO 루프) 탭 아이콘 — 동일한 «주황 = 프로» 고정.
    private static let backlogTabIcon: Image = proTabIcon("list.clipboard")

    private static func proTabIcon(_ name: String) -> Image {
        if let ui = UIImage(systemName: name)?
            .withTintColor(UIColor(Theme.pro), renderingMode: .alwaysOriginal) {
            return Image(uiImage: ui)
        }
        return Image(systemName: name)
    }
}

/// 백로그 탭 — BacklogView 를 자기 NavigationStack 으로 감싼다. 승인/수집 세션 열기는
/// 상위(MainTabView)가 세션 탭 전환 + 딥링크로 처리한다 (워크플로우 탭과 동일 패턴).
private struct BacklogTab: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var conn: ConnectionManager
    @EnvironmentObject var inflight: InFlightTracker
    let capabilities: [String]
    let onOpenSession: (String) -> Void

    var body: some View {
        // NavigationStack 은 BacklogView 가 직접 소유한다 — 브리프 딥링크의 프로그래매틱
        // push(NavigationPath)가 뷰 내부 상태와 묶여 있어서.
        BacklogView(capabilities: capabilities, onOpenSession: onOpenSession)
            // 백로그 탭 «제목 텍스트» 도 주황(pro)으로.
            .background(ProTabTitleStyler().frame(width: 0, height: 0))
    }
}

/// 자동화 탭 — AutomationHomeView(워크플로우 | 예약 세그먼트)를 자기 NavigationStack 으로 감싼다.
/// 노드/예약 세션 열기 콜백은 상위(MainTabView)로 위임.
private struct AutomationTab: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var conn: ConnectionManager
    @EnvironmentObject var inflight: InFlightTracker
    let capabilities: [String]
    let onOpenSession: (String) -> Void

    var body: some View {
        NavigationStack {
            AutomationHomeView(
                auth: auth,
                conn: conn,
                inflight: inflight,
                capabilities: capabilities,
                onOpenSession: onOpenSession
            )
        }
        // 자동화 탭 «제목 텍스트» 도 주황(pro)으로. (아이콘은 이미 alwaysOriginal 주황.)
        .background(ProTabTitleStyler().frame(width: 0, height: 0))
    }
}

/// 자동화 홈 — 「워크플로우 | 예약」 세그먼트로 두 pro(주황) 도메인을 한 탭에 묶는다.
///
/// 예약(CronListView)은 이전엔 세션 탭(무료) 툴바의 주황 pro 버튼이었다. 무료 화면에 주황이
/// 떠 통일성이 깨지던 걸, 워크플로우와 같은 자동화 도메인으로 끌어와 세그먼트로 합쳤다(탭은
/// 늘리지 않아 3~5탭 원칙 유지). 워크플로우/예약 각각의 화면(WorkflowListView·CronListView)은
/// «그대로» 재사용하고, 이 홈은 세그먼트 전환 + 공통 좌상단 설정/도움말 진입점만 얹는다.
///
/// 세그먼트 노출은 capability 로 soft-gate: workflow_v1·cron_v1 둘 다 있으면 세그먼트 picker 를
/// 보이고, 하나만 있으면 그 화면만(picker 없이) 띄운다. 미지원 세그먼트는 «숨김»(비활성 안내 대신
/// 군더더기 없이 제거) — 탭 자체가 둘 중 하나라도 있을 때만 떠서 빈 탭이 되는 경우는 없다.
///
/// 색 정책: 세그먼트 콘텐츠에 `.tint(Theme.pro)` 를 «걸지 않는다» — 주황은 탭 «버튼» 만(아이콘
/// alwaysOriginal). 세그먼트·툴바 버튼은 기본 틴트(accent=보라)를 그대로 둔다(콘텐츠까지 주황
/// 으로 번지던 사고 이력 방지).
struct AutomationHomeView: View {
    let auth: AuthStore
    let conn: ConnectionManager
    let inflight: InFlightTracker
    let capabilities: [String]
    let onOpenSession: (String) -> Void

    /// 설정 — 두 세그먼트 공통의 좌상단 진입점. 세션 탭과 동일한 SettingsSheet 를 재사용한다
    /// (예약·워크플로우 화면이 각자 들고 있지 않게 홈으로 끌어올림). 도움말 상시 「?」 버튼은
    /// 제거하고, 도움말 허브는 설정 안 «도움말» 섹션으로 일원화했다(세션 탭과 동일 IA).
    @State private var showSettings = false

    enum Segment: Hashable { case workflow, cron }
    @State private var segment: Segment = .workflow

    private var hasWorkflow: Bool { capabilities.contains("workflow_v1") }
    private var hasCron: Bool { capabilities.contains("cron_v1") }
    /// 둘 다 지원할 때만 세그먼트 picker 를 보인다(하나뿐이면 전환할 게 없음).
    private var showPicker: Bool { hasWorkflow && hasCron }

    /// 실제로 그릴 세그먼트 — 지원하지 않는 쪽이 선택돼 있으면 지원하는 쪽으로 강제한다
    /// (capability 가 비동기로 도착/변동해도 빈 화면이 안 뜨게).
    private var effectiveSegment: Segment {
        if !hasWorkflow { return .cron }
        if !hasCron { return .workflow }
        return segment
    }

    var body: some View {
        content
            .toolbar {
                // 설정 기어 — 모든 메인 탭(세션·자동화·백로그)의 «같은 자리»(좌상단)·같은 아이콘
                // (gearshape)으로 일관 배치. 라벨(텍스트+아이콘)이라 좁은 기기의 «…» 오버플로에서도
                // 제대로 그려진다(세션 탭과 동일 폼). 도움말은 설정 안 «도움말» 섹션으로 일원화.
                ToolbarItem(placement: .topBarLeading) {
                    Button { showSettings = true } label: {
                        Label("설정", systemImage: "gearshape")
                    }
                }
                // 세그먼트는 네비게이션 바 가운데(principal)에 둔다 — 자식 화면의 inline 타이틀을
                // 대신해 «지금 보는 도메인» 을 겸한다. .tint(pro) 금지: 기본 accent(보라)를 따른다.
                if showPicker {
                    ToolbarItem(placement: .principal) {
                        Picker("자동화 구분", selection: $segment) {
                            Text("워크플로우").tag(Segment.workflow)
                            Text("예약").tag(Segment.cron)
                        }
                        .pickerStyle(.segmented)
                    }
                }
            }
            .sheet(isPresented: $showSettings) { SettingsSheet() }
    }

    @ViewBuilder
    private var content: some View {
        switch effectiveSegment {
        case .workflow:
            WorkflowListView(
                auth: auth,
                conn: conn,
                inflight: inflight,
                capabilities: capabilities,
                onOpenSession: onOpenSession
            )
        case .cron:
            CronListView(
                auth: auth,
                conn: conn,
                inflight: inflight,
                onOpenSession: onOpenSession
            )
        }
    }
}

/// 프로(주황) 탭의 «제목 텍스트» 를 Theme.pro 로 고정한다.
///
/// SwiftUI TabView 는 «탭별» 타이틀 색을 지원하지 않는다(전역 `.tint` 만 가능) — 그래서 세션 탭은
/// 전역 액센트(보라)를 따르되 프로 탭만 주황으로 두려면 UITabBarItem 의 per-item appearance 를
/// 직접 세팅해야 한다. 이 representable 을 그 탭 «콘텐츠 안» 에 두면 enclosing
/// `tabBarController` 가 곧 TabView 를 떠받치는 UITabBarController 라, 자기가 속한 탭 아이템 제목을
/// normal/selected 모두 주황으로 박는다. item appearance 는 전역 tint 를 덮어쓰므로 다른 탭
/// (per-item appearance 없음)은 그대로 보라를 따른다.
///
/// 자기 탭 인덱스는 representable 의 UIViewController 부모 체인을 거슬러 올라가
/// `tabBarController.viewControllers` 안에서 찾는다 — 첫째/마지막 같은 고정 위치에 기대지 않아
/// 탭 순서·개수가 바뀌어도(예: 백로그 탭이 capability 에 따라 끼었다 빠져도) 안전하다.
private struct ProTabTitleStyler: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> UIViewController { UIViewController() }
    func updateUIViewController(_ uiVC: UIViewController, context: Context) {
        // 레이아웃이 끝나 tabBarController 가 연결된 뒤 적용.
        DispatchQueue.main.async {
            guard let tabBarController = uiVC.tabBarController else { return }
            let tabBar = tabBarController.tabBar
            // uiVC 가 속한 탭의 인덱스를 부모 체인에서 찾는다 (SwiftUI 호스팅 계층 깊이 무관).
            var node: UIViewController? = uiVC
            var tabIndex: Int?
            while let n = node {
                if let idx = tabBarController.viewControllers?.firstIndex(of: n) {
                    tabIndex = idx
                    break
                }
                node = n.parent
            }
            guard let index = tabIndex, let items = tabBar.items, index < items.count else { return }
            let item = items[index]
            let appearance = tabBar.standardAppearance.copy()
            let orange = UIColor(Theme.pro)
            for layout in [appearance.stackedLayoutAppearance,
                           appearance.inlineLayoutAppearance,
                           appearance.compactInlineLayoutAppearance] {
                layout.normal.titleTextAttributes = [.foregroundColor: orange]
                layout.selected.titleTextAttributes = [.foregroundColor: orange]
            }
            item.standardAppearance = appearance
            item.scrollEdgeAppearance = appearance
        }
    }
}

/// 지금 선택된 메인 탭 — `.toolbar(.hidden, for: .tabBar)` 를 쓰는 자식 화면(채팅·워크플로우
/// 캔버스 등)이 «자기 탭이 활성일 때만» 탭 바를 숨기도록 읽는 environment 값.
///
/// 배경(버그): SwiftUI 에서 한 탭 스택에 박힌 `.toolbar(.hidden, for: .tabBar)` 는 TabView
/// «전체» 탭 바를 가린다. 그 숨김 뷰가 떠 있는 채로 딥링크가 다른 탭으로 프로그래매틱 전환하면,
/// 떠나는 탭 스택의 숨김이 그대로 남아 도착 탭에서도 탭 바가 사라진 채 갇힌다(웜 진입 + 「탭 바
/// 자체가 없음」 증상). 각 숨김 지점이 이 값으로 «내 탭이 지금 선택됐는가» 를 보고 조건부로 숨기면
/// 전환 즉시 도착 탭의 탭 바가 살아난다 — 그러면서 떠난 탭의 네비게이션(열려 있던 채팅 등)은 보존된다.
///
/// nil = MainTabView 밖(프리뷰 등)이라 «기존대로 숨김» 안전 기본값.
private struct ActiveMainTabKey: EnvironmentKey {
    static let defaultValue: MainTabView.Tab? = nil
}

extension EnvironmentValues {
    var activeMainTab: MainTabView.Tab? {
        get { self[ActiveMainTabKey.self] }
        set { self[ActiveMainTabKey.self] = newValue }
    }
}
