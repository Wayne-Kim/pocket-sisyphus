import SwiftUI
import UIKit  // UITabBar «선택» 색만 브랜드 보라로 — 콘텐츠 tint 와 분리(전역 .tint 회피)

@main
struct PocketSisyphusApp: App {
    /// AppDelegate 어댑터 — UIKit 의 supportedInterfaceOrientationsFor 콜백을 받기 위해 등록.
    /// SwiftUI 자체로는 회전 화이트리스트를 동적으로 못 다뤄서 (Info.plist 만으로는 정적) 이
    /// 어댑터로 «사용자 토글에 따라 매 회전마다 portrait/all 결정» 흐름을 구현한다.
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    @StateObject private var auth = AuthStore()
    /// 듀얼 채널 모델 — 메인 앱 프로세스 내에서 Tor.framework 직접 운용. NEPacketTunnelProvider
    /// 익스텐션 제거. ConnectionManager 가 happy eyeballs 로 SSH 채널 채택 후 ApiClient/WSClient
    /// 가 그 local forward port 로 통신.
    @StateObject private var tor = TorManager()
    @StateObject private var endpointCache = EndpointCache()
    @StateObject private var inflight = InFlightTracker()
    /// 백그라운드 트립 감지 후 자식 view 에 reawake 신호를 보내는 broker.
    /// 옛 «rebootKey = UUID() → AppRoot.id() 회전» 으로 통째 재구성하던 흐름을
    /// view-level targeted refresh 로 대체 — NavigationStack/입력/스크롤 위치 보존.
    @StateObject private var lifecycle = AppLifecycle()
    /// daemon ↔ iOS 호환성 verdict 보관소. AppRoot 가 Tor .running + 페어된 상태에서
    /// 한 번 fetch 해서 IncompatibleView (Hard) 또는 Soft 배너로 분기.
    @StateObject private var versionCompat = VersionCompatStore()
    /// «새 세션 만들기» 시트에서 사용자가 숨김 처리한 레포/이어받기 후보를 디스크에 보관.
    /// 세션 시트가 띄울 때마다 동일한 store 를 보고 visibleRecents/visibleResumeCandidates
    /// 에서 필터링한다.
    @StateObject private var hiddenItems = HiddenItemsStore()
    /// StoreKit 2 IAP (월·년 구독 + 평생) 상태. 부팅 즉시 Transaction.currentEntitlements 동기화 +
    /// Transaction.updates 백그라운드 구독. PaywallView 가 구매/복원 액션을, foreground 복귀가
    /// refreshOnForeground() 를 호출. 체험은 StoreKit 도입혜택이 소유 (앱 자체 Keychain 체험 제거).
    @StateObject private var purchase = PurchaseStore()
    /// 세션 목록 디스크 캐시 — SessionsView 의 첫 페인트를 즉시화. `.active` prewarm 이
    /// `/api/sessions` 도 병렬로 받아 여기에 저장 → SessionsView 가 곧 도달했을 때 fresh.
    /// AuthStore.config?.onion 변경 시 `adopt(onion:)` 가 캐시 키를 동기화한다.
    @StateObject private var sessionCache = SessionListCache()
    /// 딥링크 (pocketsisyphus://session/<id>) 진입 broker. `.onOpenURL` 이 파싱한
    /// sessionId 를 보관하고, SessionsView 가 목록 준비 후 해당 세션으로 navigate 한다.
    @StateObject private var deepLink = DeepLinkRouter()
    /// Tor bridge(obfs4 등) 사용자 설정 + 런타임 상태. `TorManager` 가 평문 Tor 차단 시 이 설정을
    /// 보고 bridge 경유로 자동 재시도하고, 설정 화면/차단 진단 카드가 같은 인스턴스를 관찰한다.
    @StateObject private var bridges = TorBridgeStore.shared

    /// AuthStore, TorManager, EndpointCache 가 모두 준비된 뒤 생성. happy eyeballs 로 SSH
    /// 채널 채택 책임. ApiClient/WSClient 의 `conn` 의존을 환경 객체로 노출.
    @StateObject private var conn: ConnectionManager

    init() {
        // @StateObject 의 lazy init 으로 다른 StateObject 를 참조 못 하므로
        // ConnectionManager 만 명시적으로 구성. AuthStore / TorManager / EndpointCache 는
        // wrappedValue 가 같은 인스턴스라 안전.
        let authStore = AuthStore()
        let torMgr = TorManager()
        let cache = EndpointCache()
        // 직접 채널 host key TOFU 장부 — ConnectionManager 가 SSH 검증에 넘긴다.
        let knownHosts = KnownHostStore()
        // 시뮬레이터 자가 검증 루프 — SIMCTL_CHILD_PS_DEV_* 환경변수가 있으면 스텁 페어링을
        // Keychain 에 심어 PairView(QR 스캔)를 건너뛴다. 실기기/릴리즈에선 no-op.
        DevPairing.seedIfNeeded(auth: authStore)
        _auth = StateObject(wrappedValue: authStore)
        _tor = StateObject(wrappedValue: torMgr)
        _endpointCache = StateObject(wrappedValue: cache)
        _conn = StateObject(wrappedValue: ConnectionManager(auth: authStore, tor: torMgr, cache: cache, knownHosts: knownHosts))
        Self.configureTabBarSelectionColor()
    }

    /// 탭 바의 «선택» 색만 브랜드 보라(Theme.accent)로 바꾼다. SwiftUI 의 `.tint(...)` 를 TabView 에
    /// 걸면 탭 콘텐츠(세션 목록·툴바 등)까지 물들어 «원래 흰색/primary 였던 것까지 보라» 가 되므로,
    /// 콘텐츠와 분리되는 UIKit appearance 로 «탭 바 자체» 만 칠한다. 미선택 탭은 시스템 회색 그대로,
    /// 본문 텍스트/아이콘은 .primary 로 두어 다크=흰색·라이트=검정으로 자동 적응된다.
    /// (워크플로우 탭은 MainTabView 의 per-item appearance 가 이 위에 주황으로 덮어쓴다.)
    private static func configureTabBarSelectionColor() {
        let appearance = UITabBarAppearance()
        appearance.configureWithDefaultBackground()
        let purple = UIColor(Theme.accent)
        for layout in [appearance.stackedLayoutAppearance,
                       appearance.inlineLayoutAppearance,
                       appearance.compactInlineLayoutAppearance] {
            layout.selected.iconColor = purple
            layout.selected.titleTextAttributes = [.foregroundColor: purple]
        }
        UITabBar.appearance().standardAppearance = appearance
        UITabBar.appearance().scrollEdgeAppearance = appearance
    }

    @Environment(\.scenePhase) private var scenePhase

    /// 사용자가 고른 앱 테마 (시스템 따라가기 / 라이트 / 다크). 설정 시트의 피커가 이 키를
    /// 바꾸고, 아래 `.preferredColorScheme(themeMode.colorScheme)` 가 즉시 반영한다. 기본값
    /// `.system` — 기기 설정(다크/라이트)을 그대로 따른다 (옛 «다크 고정» 동작에서 변경).
    @AppStorage(ThemeMode.storageKey) private var themeMode: ThemeMode = .system

    /// 마지막으로 .background/.inactive 로 떨어졌던 시각. nil 이면 콜드 스타트 직후
    /// (한 번도 떠난 적 없음).
    @State private var lastBackgroundedAt: Date?

    /// 마지막 pre-warm 시각. 컨트롤센터/알림 슬라이드 같은 빠른 .active 진동에서 매번
    /// /api/version 을 쳐대지 않도록 30s rate-limit 의 기준점.
    @State private var lastPrewarmAt: Date?

    var body: some Scene {
        WindowGroup {
            AppRoot()
                .environmentObject(auth)
                .environmentObject(tor)
                .environmentObject(endpointCache)
                .environmentObject(conn)
                .environmentObject(inflight)
                .environmentObject(lifecycle)
                .environmentObject(versionCompat)
                .environmentObject(hiddenItems)
                .environmentObject(purchase)
                .environmentObject(sessionCache)
                .environmentObject(deepLink)
                .environmentObject(bridges)
                // 잠금 게이트(LockView)와 AppRoot 가 토큰/잠금 상태를 반응형으로 관찰하도록
                // 싱글톤을 환경에 노출. ApiClient·WSClient·PairView 는 여전히 `.shared` 로 접근.
                .environmentObject(AttestSession.shared)
                // (전역 .tint 는 일부러 안 건다 — 앱 «전체» 의 기본색을 보라로 바꾸면 원래 흰색/
                // primary 였던 요소까지 물든다. 파랑→보라는 «파랑이던 화면» 에만 scoped 로 건다:
                // 탭 선택(MainTabView), 설정 시트, 새 세션 시트. primary 텍스트/아이콘은 그대로
                // 두어 다크=흰색·라이트=검정으로 자동 적응되게 한다.)
                // 사용자가 고른 테마를 적용 — .system 이면 nil 이라 기기 설정을 따른다.
                .preferredColorScheme(themeMode.colorScheme)
                // 딥링크 진입 — pocketsisyphus://session/<id>. 콜드 런치/백그라운드 복귀
                // 모두 여기로 들어온다. router 에 박아두면 SessionsView 가 목록 준비 후 push.
                .onOpenURL { url in
                    deepLink.handle(url)
                }
                // 시뮬레이터 자가 검증 루프 — 딥링크를 launch env 로 받아 앱 안에서 라우팅.
                // (`simctl openurl` 의 시스템 확인 다이얼로그를 피하는 경로. 실기기/릴리즈 no-op.)
                .task {
                    if let url = DevPairing.launchDeepLink {
                        deepLink.handle(url)
                    }
                }
                // 페어링 변화 추적 — 새 페어/해제/다른 Mac 으로 re-pair 모두 여기서 잡혀
                // 캐시 키가 동기화된다. nil 진입 시엔 디스크 entry 도 같이 청소된다.
                .onChange(of: auth.config?.onion) { newOnion in
                    sessionCache.adopt(onion: newOnion)
                }
        }
        .onChange(of: scenePhase) { newPhase in
            handleScenePhase(newPhase)
        }
    }

    private func handleScenePhase(_ phase: ScenePhase) {
        switch phase {
        case .background, .inactive:
            // 이미 기록된 시각이 있으면 덮어쓰지 않고 가장 이른 시각 유지.
            // .inactive 는 푸시 슬라이드, control center, 알림 배너 등으로도 잠깐 들렀다
            // .background 로 직접 빠질 수 있는데 (.active 를 안 거치고), 그 사이의 가장
            // 이른 시각을 유지해야 away 계산이 정확하다.
            if lastBackgroundedAt == nil {
                lastBackgroundedAt = Date()
            }
            // «진짜 백그라운드» (잠금 / 앱 전환) 일 때만 away 상태로 내려 daemon 의
            // away-gating 을 다시 켠다 → Discord 알림이 나간다. .inactive (알림센터 /
            // 컨트롤센터 peek) 는 사용자가 여전히 화면을 보는 중일 수 있어 건드리지 않는다.
            if phase == .background {
                lifecycle.setActive(false)
                AgentWaitNotifier.shared.setAppActive(false)
            }

        case .active:
            // foreground 복귀 — 다시 «보는 중». ChatView 가 onChange 로 daemon 에 foreground
            // 를 알려 away-gating 이 풀린다 (사용자가 채팅창을 보는 동안 중복 알림 억제).
            lifecycle.setActive(true)
            // 글로벌 대기 알림기에도 포그라운드 알림 — away-gating + WS kick (idle 끊김 회복).
            AgentWaitNotifier.shared.setAppActive(true)

            // 리뷰 요청 gate 의 «서로 다른 날 연속» 카운트 갱신 (같은 날 재진입은 한 번만 셈).
            ReviewPrompt.recordActive()

            // 구독 만료 반영 — 백그라운드 동안 구독이 끝나면 Transaction.updates 이벤트가 오지
            // 않으므로(만료는 «빠지는» 변화라 push 없음) 다음 콜드런치까지 잠금이 풀린 채로 보인다.
            // foreground 마다 currentEntitlements 를 다시 읽어 만료/환불을 게이트에 반영한다.
            // iapEnabled=false 동안엔 store 내부에서 no-op.
            Task { await purchase.refreshOnForeground() }

            // 콜드 스타트면 lastBackgroundedAt 이 nil — longTripReawake 분기는 스킵하지만
            // pre-warm 은 아래에서 시도한다 (cold start 시점에 Tor 가 이미 .running 이면
            // 사용자 첫 액션 전에 HSDir descriptor + INTRO/RENDEZVOUS 회로를 미리 다짐).
            let backgroundedAt = lastBackgroundedAt
            lastBackgroundedAt = nil

            schedulePrewarmIfReady()

            guard let backgroundedAt else { return }
            let away = -backgroundedAt.timeIntervalSinceNow

            // 짧은 트립(<60s) — 알림 슬라이드, 컨트롤센터 peek, 잠금 후 짧은 재진입 등 —
            // 은 longTripReawake 안 부름. PacketTunnel 익스텐션이 Tor 를 살려두므로
            // SOCKS5 연결이 안 끊기고, SessionsView/ChatView 의 폴링 루프(30s WS-wake) 가
            // 자체적으로 stale 감지 + 회복을 처리한다. 옛 1s 임계는 NE 도입 전 "Tor 죽었을
            // 가능성" 을 의식한 값이었는데 이제는 NavigationStack 상태 손실 + 입력 중
            // 텍스트/스크롤 위치 손실 비용이 더 크다.
            if away < 60 {
                return
            }

            NSLog("[App] foreground 복귀 — %.1fs 동안 백그라운드. reawake 신호.", away)

            // 진짜로 오래 떠나 있었던 케이스 — 각 view 가 자기 책임 영역만 갱신하도록
            // reawake 신호. SessionsView 가 세션 목록 reload, ChatViewModel 이 polling
            // 즉시 wake + WS kick. AppRoot 자체는 그대로라 NavigationStack 깊이/입력
            // 텍스트/스크롤 위치가 모두 보존된다.
            lifecycle.longTripReawake()

        @unknown default:
            break
        }
    }

    /// `.active` 진입 시 Tor 회로 + HSDir descriptor 를 사용자 첫 조작 전에 다지는 prewarm.
    ///
    /// 효과: 콜드 회로(HSDir lookup → INTRODUCE → RENDEZVOUS 전체 빌드, 보통 5~10s)
    /// 가 사용자가 화면 보는 동안 백그라운드에서 끝나 첫 API 호출이 즉시 응답.
    /// Tor.framework 의 dataDir 캐시(avoidDiskWrites=false)와 짝.
    ///
    /// 가드:
    /// - 30s rate-limit — 컨트롤센터 슬라이드 / 알림 peek 으로 .active 가 빠르게
    ///   재진동할 때 매번 발사 안 함.
    /// - 페어 안 됐거나 tunnel 이 아직 .running 이 아니면 skip. 콜드 부팅 케이스는
    ///   `startIfNeeded` 가 어차피 Tor 를 띄우고, 사용자 첫 액션이 자연스럽게 첫
    ///   회로 빌드를 트리거하므로 중복 작업 안 함.
    /// - 실패 무시 — 사용자 액션이 곧 재시도. prewarm 은 best-effort.
    private func schedulePrewarmIfReady() {
        if let last = lastPrewarmAt, -last.timeIntervalSinceNow < 30 {
            return
        }
        guard auth.config != nil, conn.currentLocalPort != nil else {
            return
        }
        lastPrewarmAt = Date()
        let api = ApiClient(auth: auth, conn: conn)
        let onion = auth.config?.onion
        Task {
            // version 핸드셰이크 + 세션 목록을 같은 회로로 병렬 발사. version 이 성공해야
            // sessionCache 에 박는다 — IncompatibleView 로 가야 할 케이스에서 옛 daemon 의
            // 응답이 SessionSummary 새 필드와 안 맞는 경우 캐시 오염을 막기 위함.
            async let versionTask: ServerVersionInfo = api.getServerVersion(label: nil)
            async let sessionsTask: [SessionSummary] = api.listSessions(label: nil)
            do {
                _ = try await versionTask
                if let list = try? await sessionsTask, let onion {
                    await MainActor.run {
                        sessionCache.adopt(onion: onion)
                        sessionCache.save(list)
                    }
                }
                NSLog("[App] prewarm OK")
            } catch {
                // versionTask 가 실패해도 sessionsTask 는 발사돼 있다 — 깔끔히 cancel 해서
                // 빈 Tor 회로에 노이즈 줄이고 InFlightTracker 도 잠재적 누수 없게.
                _ = try? await sessionsTask
                NSLog("[App] prewarm failed: %@", error.localizedDescription)
            }
        }
    }
}
