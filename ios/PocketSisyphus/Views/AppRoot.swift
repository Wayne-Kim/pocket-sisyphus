import SwiftUI
import LocalAuthentication  // LAError — LockView 가 생체 실패(취소/lockout/미지원)를 분기
import Security             // errSec* — 일부 SecKey 경로가 OSStatus 로 올라올 때 대비

struct AppRoot: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var tor: TorManager
    @EnvironmentObject var conn: ConnectionManager
    @EnvironmentObject var versionCompat: VersionCompatStore
    @EnvironmentObject var attest: AttestSession
    /// 딥링크 broker — 대기 알림 탭이 세션으로 라우팅하도록 AgentWaitNotifier 에 주입한다.
    @EnvironmentObject var deepLink: DeepLinkRouter

    /// 연결 방식 최초 선택 여부 — Tor 부트스트랩 .task 의 게이트 토큰으로 쓴다. false→true 로
    /// 바뀌는 순간 `.task(id: modeChosen)` 가 재실행되며 보류해 둔 연결(또는 LAN 직결)을 시작한다.
    @AppStorage(ConnectionModePolicy.chosenKey) private var modeChosen: Bool = false

    /// VPNConsentView 는 NEPacketTunnelProvider 와 함께 제거됨. 듀얼 채널 모델에서는
    /// VPN 권한 동의 다이얼로그 자체가 없다 — 사용자가 사전 안내를 볼 일이 없음.
    /// scenePhase 추적(.background → .active 시 선제 회로 갱신) 은 `PocketSisyphusApp` 에.
    //
    // Note: entitlement 미보유 시 PaywallView 를 풀스크린으로 띄운다 (아래 .paywall 분기).
    // 체험은 StoreKit 도입혜택이 소유하므로 «체험 중 배너» 는 없다 — entitled 면 곧장 .allow.

    var body: some View {
#if DEBUG && targetEnvironment(simulator)
        // 시뮬레이터엔 Secure Enclave 가 없어 실제 LockView 가 절대 안 뜬다(needsAuthGate=false).
        // 그래서 상태별 «레이아웃 눈검증» 을 위해 PS_DEV_LOCKVIEW=<상태> 로 launch 하면 그 상태의
        // LockScreen 을 강제로 띄운다(/verify-ios). 실기기/릴리즈에선 컴파일조차 안 됨.
        if let name = DevPairing.lockViewState, let phase = LockPhase.devPreview(name) {
            LockScreen(
                phase: phase,
                bio: DeviceAttestor.biometryDisplayName,
                bioIcon: DeviceAttestor.biometryType == .touchID ? "touchid" : "faceid",
                onRetry: {}
            )
        } else if DevPairing.connModePreview {
            // 연결 방식 선택 화면 레이아웃 눈검증용 강제 프리뷰 (PS_DEV_CONNMODE=1).
            ConnectionModeView()
        } else {
            mainContent
        }
#else
        mainContent
#endif
    }

    @ViewBuilder
    private var mainContent: some View {
        Group {
            if !ConnectionModePolicy.isChosen() && !DevPairing.isActive {
                // 연결 방식 미선택 — 페어 전/후를 가리지 않고 «Tor 부트스트랩 전» 에 모드를 먼저
                // 묻는다. 신규 설치(미페어링)에서도 이 화면이 먼저 떠야, 같은 Wi‑Fi 전용 환경에서
                // Tor 가 막혀도 LAN 직결로 페어링할 수 있다. 아래 launch .task 도 미선택 동안 Tor 를
                // 시작하지 않는다. 고르면 modeChosen 이 true 가 되어 .task(id:) 재실행 + 라우팅 갱신.
                ConnectionModeView()
            } else if auth.config == nil {
                // 페어 안 됨 — 페어링 위해 데몬에 연결해야 한다.
                if LanOnlyPolicy.isEnabled() {
                    // LAN 전용 — Tor 없이 곧장 QR 페어링. QR 의 lan_host/ssh_port 로 같은 Wi‑Fi 직결
                    // 페어링(verifyAndSave → connectLanOnly)이 되므로 onion 부트스트랩을 기다리지 않는다.
                    PairView()
                } else {
                    // 어디서나(Tor) — Tor 상태 따라 라우팅.
                    switch tor.state {
                    case .idle, .starting:
                        BootView()
                    case .running:
                        PairView()
                    case .failed(let message):
                        // 페어 전 Tor 부트스트랩 실패 — conn 의 FailureReason 이 아직 없으므로 tor 신호로
                        // 분류한다(차단 정황이면 torLikelyBlocked, 아니면 일반 부팅 실패).
                        ErrorView(
                            reason: tor.torLikelyBlocked ? .torLikelyBlocked : .torBootFailed,
                            message: message,
                            onRetry: { Task { await tor.recoverFromFailure() } }
                        )
                    }
                }
            } else {
                // 페어 됨 — ConnectionManager 가 master orchestrator. Tor 는 endpoint 갱신 시에만
                // lazy 로 띄움 → 직접 SSH 채택 시 `tor.stopAsync()` 가 tor.state 를 .idle 로 만들 수
                // 있는데, 그게 정상 운영 상태. tor.state 를 라우팅에 쓰면 100% → 0% 회귀 버그 발생.
                // 프리미엄 전환: 전체화면 강제 페이월 제거 — 기본 앱은 무료로 열린다. 프로(주황)
                // 기능은 각 진입점에서 탭 시 PaywallView 시트로 잠근다(MainTabView / 각 화면).
                if attest.pairing {
                    // 페어링 진행 중 — PairView.verifyAndSave 가 연결→기기 등록→첫 토큰을 «직접»
                    // 운전한다. auth.save 가 이 시점에 이미 view 전환을 일으키지만, MainTabView/
                    // LockView 중 어느 것도 띄우지 않는다: MainTabView 를 띄우면 SessionsView 가
                    // 미리 마운트돼 /api 호출 → 401 재인증이 pairingEnroll 의 challenge-response 와
                    // 겹쳐 생체 프롬프트가 두 번 뜬다. 페어링이 끝나면(endPairing) 곧장 다음 분기로.
                    BootView()
                } else if let v = versionCompat.verdict, v.isHardBlock {
                    IncompatibleView(verdict: v) {
                        Task {
                            let api = ApiClient(auth: auth, conn: conn)
                            await versionCompat.userRequestedRecheck(api: api)
                        }
                    }
                } else {
                    // SessionsView 는 ConnectionManager 가 .running 이어야 보임. 페어링 직후
                    // auth.save 가 view transition 을 즉시 trigger 하는데, 그 시점에 conn.connect()
                    // 가 아직 .connecting 이면 SessionsView 의 .task 가 ApiClient 호출 시
                    // torNotRunning 으로 깨진다. conn 도 정상일 때만 SessionsView 노출.
                    switch conn.state {
                    case .running(_, let endpointType):
                        // Secure Enclave 기기 인증이 강제되는데 아직 이번 세션에 잠금이 안 풀렸으면
                        // MainTabView 대신 전용 잠금 화면(LockView)을 띄운다. 옛날엔 MainTabView 가
                        // 먼저 그려지고 SessionsView 의 첫 /api 호출이 뒤늦게 생체 프롬프트를 띄워,
                        // 인증 전 화면이 그대로 보이는 UX 문제가 있었다. 게이트로 그 순서를 바로잡는다.
                        // 미등록(soft·옛 daemon·시뮬레이터)이면 needsAuthGate=false 라 곧장 통과.
                        if attest.needsAuthGate {
                            LockView()
                        } else {
                            MainTabView()
                                .safeAreaInset(edge: .top, spacing: 0) {
                                    VStack(spacing: 0) {
                                        if case .softMissingCapabilities(let missing, let dv) = versionCompat.verdict {
                                            SoftIncompatibilityBanner(missing: missing, daemonVersion: dv)
                                        }
                                        // 직접 SSH 시도 실패해 Tor onion fallback 채택된 경우 — 사용자에게
                                        // 속도 저하 사실을 1줄로 안내. 라우터 UPnP 켜거나 포트포워딩 설정 시
                                        // 직접 SSH 로 자동 전환됨.
                                        if endpointType == .torOnion {
                                            TorFallbackBanner()
                                        }
                                    }
                                }
                        }
                    case .idle, .connecting:
                        BootView()
                            .task {
                                // 페어 됐는데 connection 비활성 — 자발적으로 connect 시도.
                                // 콜드 부팅 직후 + 백그라운드 복귀 + reconnect 회복 케이스 공통.
                                await conn.connect()
                            }
                    case .failed(let reason, let m):
                        ErrorView(
                            reason: reason,
                            message: m,
                            onRetry: { Task { await conn.reconnect() } }
                        )
                    }
                }
            }
        }
        // (옛 in-flight 진행 배너는 제거됨 — 응답이 보통 0.5초 내라 «떴다 사라지며» 깜빡여 거슬렸다.
        // InFlightChip.swift 의 inFlightBanner() 는 호환용 no-op 으로만 남아 있다.)
        .task(id: modeChosen) {
            // 시뮬레이터 개발 페어링 — daemon loopback 직행이라 Tor 가 전혀 필요 없다.
            // 스텁 onion 으로 부트스트랩을 시도하며 시간/로그만 낭비하므로 통째로 건너뛴다.
            if DevPairing.isActive { return }
            // 아직 연결 방식을 안 골랐으면(ConnectionModeView 표시 중) Tor 부트스트랩을 보류한다 —
            // 페어 전/후 공통. 사용자가 고르는 순간 modeChosen 이 바뀌어 이 task 가 재실행된다.
            if !ConnectionModePolicy.isChosen() { return }
            // LAN 전용 — onion 이 전혀 필요 없다. 페어 전엔 QR 의 lan_host 로 직결 페어링, 페어 후엔
            // 사설 주소로 직결하므로, launch 때 Tor 를 띄우면 곧바로 connectLanOnly 의 stopAsync()
            // 로 다시 꺼지는 «헛부팅» 만 생긴다. 그래서 페어 여부와 무관하게 Tor 부트스트랩을 건너뛴다.
            if LanOnlyPolicy.shouldSkipTorBootstrap(enabled: LanOnlyPolicy.isEnabled()) {
                return
            }
            // 이미 페어된 상태라면 Tor 시작 *전* 에 .auth_private 파일을 깔아둔다.
            // 안 그러면 Tor 가 빈 ClientOnionAuthDir 로 부팅 → 첫 .onion 요청이 descriptor
            // decryption 실패로 막힘 → RELOAD 까지 한 박자 늦어지면서 UX 가 거칠어진다.
            // Tor 가 startup 시 dir 을 한 번에 읽도록 미리 써두는 게 깔끔.
            if let cfg = auth.config {
                await tor.installClientAuth(for: cfg)
            }
            await tor.startIfNeeded()
        }
        .onChange(of: tor.state) { newState in
            // Tor 가 .running 으로 진입하는 순간 — onion 회로 사전 가열.
            // 첫 .onion 요청은 introduce + rendezvous handshake 비용으로 5–15s 까지 늘
            // 수 있는데, 사용자가 SessionsView 로 들어와서 그 비용을 직접 체감하지 않게
            // 백그라운드에서 health 한 번 찔러 회로를 미리 만들어 둔다. 후속 요청은
            // 같은 회로 위 stream 으로 multiplex (static URLSession 캐시 덕분).
            //
            // Fire-and-forget — 실패해도 무해. SessionsView 의 reload 가 어차피 다시 친다.
            // 페어링 안 된 상태 (auth.config == nil) 면 base URL 이 없어 가열도 불가.
            if case .running = newState, auth.config != nil {
                Task {
                    let api = ApiClient(auth: auth, conn: conn)
                    _ = try? await api.health()
                }
                // 호환성 핸드셰이크 — 부팅당 1회. verdict 이 이미 있으면 store 내부 중복
                // 가드(`inflightTask`) 가 막아준다. fire-and-forget — 실패해도 사용자는
                // 정상 흐름으로 떨어지고, 각 기능 호출 시 자체 에러 흐름이 보호한다.
                Task {
                    let api = ApiClient(auth: auth, conn: conn)
                    await versionCompat.refresh(api: api)
                }
            }
        }
        // 페어 변경 감지 — 다른 Mac (다른 onion) 으로 재페어 / 페어 해제 시 verdict 가
        // 이전 daemon 기준으로 박혀있으면 잘못된 차단 또는 잘못된 통과로 사용자에게
        // 오해를 줄 수 있다. onion 이 nil 로 가거나 다른 값으로 바뀌면 reset + 즉시 재fetch.
        //
        // PairConfig.onion 은 hostname (e.g., "abc…xyz.onion") 라 두 다른 daemon 은
        // 다른 값을 갖는다. 같은 daemon 의 token rotation 만으로는 onion 이 바뀌지
        // 않으므로 verdict 그대로 유지된다 (그게 맞다 — 같은 바이너리이므로).
        .onChange(of: auth.config?.onion) { newOnion in
            versionCompat.reset()
            if newOnion != nil, case .running = tor.state {
                Task {
                    let api = ApiClient(auth: auth, conn: conn)
                    await versionCompat.refresh(api: api)
                }
            }
            // 대기 알림기 주입/정리 — 페어되면 글로벌 WS 리스너 가동, 해제되면 정리.
            if newOnion != nil {
                AgentWaitNotifier.shared.configure(auth: auth, conn: conn, deepLink: deepLink)
            } else {
                AgentWaitNotifier.shared.teardown()
            }
        }
        .task {
            // 콜드 런치(이미 페어된 상태) — onChange 가 안 와도 한 번 주입해 글로벌 WS 를 띄운다.
            if auth.config != nil {
                AgentWaitNotifier.shared.configure(auth: auth, conn: conn, deepLink: deepLink)
            }
        }
    }
}

/// Secure Enclave 기기 인증 잠금 화면. 페어된 기기를 콜드 런치하면 MainTabView 대신 먼저
/// 나타나, 생체 인증(Face ID / Touch ID)으로 토큰을 확보한 뒤에야 본 화면으로 들어간다.
/// (옛 흐름은 MainTabView 가 먼저 그려지고 첫 /api 호출이 뒤늦게 생체 프롬프트를 띄워, 인증
/// 전 화면이 그대로 보였다 — 그 순서 문제를 게이트로 바로잡는다.)
///
/// 실패를 한 문자열로 뭉치지 않고 «원인» 으로 분기한다(`LockFailure`) — 회복 안내가 상황과
/// 맞아떨어지도록:
///  - 인증 중 / 자동 재시도 중: 브랜드 화면 + 스피너. transport·일시 실패는 짧은 백오프로
///    자동 1~2회 재시도하고(그 사이 «연결을 다시 시도하는 중…»), 상한 후에야 버튼을 노출한다.
///  - 생체 취소(취소·앱전환·백그라운드): «다시 시도» 를 1차 액션으로 강조.
///  - 생체 잠김(lockout): 이때만 «기기 암호로 잠금 해제» 회복 안내를 노출(생체 전용 키라 인앱 암호 없음).
///  - 생체 미지원/미설정: 기기 설정 안내.
///  - 연결 실패: 생체와 «별도 카피» 로 구분, «다시 연결» 버튼.
///  - SE 키 소실·등록 불일치(진짜 막다른 길): danger(빨강) 신호 + RePairButton 으로 재페어링.
struct LockView: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var conn: ConnectionManager
    @EnvironmentObject var attest: AttestSession
    @Environment(\.scenePhase) private var scenePhase

    /// 현재 화면 상태(인증 중·자동 재시도 중·분류된 실패).
    @State private var phase: LockPhase = .authenticating
    /// onAppear 의 자동 인증을 한 번만 발사하기 위한 가드.
    @State private var didStart = false
    /// authenticate() 재진입 가드 — scenePhase 복귀 재발사·재시도 버튼·자동 재시도 백오프가
    /// 겹쳐 두 루프가 동시에 phase 를 건드리는 레이스를 막는다.
    @State private var running = false
    /// transport·일시 실패 자동 재시도 상한(무한 루프 금지 — 상한 후엔 버튼 노출).
    private let maxAutoRetries = 2

    private let bio = DeviceAttestor.biometryDisplayName
    private var bioIcon: String { DeviceAttestor.biometryType == .touchID ? "touchid" : "faceid" }

    var body: some View {
        LockScreen(phase: phase, bio: bio, bioIcon: bioIcon) {
            Task { await authenticate() }
        }
        .task {
            guard !didStart else { return }
            didStart = true
            await authenticate()
        }
        .onChange(of: scenePhase) { newScenePhase in
            // FaceID 프롬프트가 떠 있는 동안 앱이 백그라운드로 가면(알림·앱전환) LA 가 취소되는데,
            // .task 의 didStart 래치는 이미 소진돼 복귀해도 자동 인증이 다시 발사되지 않는다 →
            // 멈춘 LockView. 포그라운드 복귀 시 아직 잠금 미해제면(= needsAuthGate 가 여전히 true,
            // 곧 LockView 표시 중) 자동 인증을 다시 발사한다. 페어링 중·이미 unlocked 는
            // needsAuthGate 가 false 라 자동으로 제외되고, 인증이 이미 진행 중(isAuthenticating)이면
            // 건너뛴다 — AttestSession.ensureToken 의 inflight 디듀프 + 자체 running 가드와 합쳐
            // 정상 1회 해제 흐름에서 생체 프롬프트가 두 번 뜨는 것을 막는다. (closure 파라미터 이름은
            // @State var phase 와 섀도잉을 피해 newScenePhase 로 둔다.)
            guard newScenePhase == .active, attest.needsAuthGate, !attest.isAuthenticating else { return }
            Task { await authenticate() }
        }
    }

    /// 자동 인증 + 실패 분류 + (transport 한정) 짧은 백오프 자동 재시도.
    private func authenticate() async {
        // 재진입 가드 — scenePhase 복귀 / 재시도 버튼 / 백오프 sleep 구간이 겹쳐도 루프 1개만.
        if running { return }
        running = true
        defer { running = false }

        let api = ApiClient(auth: auth, conn: conn)
        var attempt = 0
        while true {
            phase = attempt == 0 ? .authenticating : .retrying
            do {
                _ = try await attest.ensureToken(api: api)
                // 성공(토큰 확보 → unlocked=true) 또는 미등록(soft → enrollment=.notEnrolled) —
                // 어느 쪽이든 attest.needsAuthGate 가 false 가 되어 AppRoot 가 MainTabView 로
                // 전환한다. 여기선 추가 처리가 필요 없다.
                return
            } catch {
                // 화면 이탈/태스크 취소 — 실패 UI 없이 조용히 종료(생체 «취소» 와는 구분한다).
                if ApiError.isCancellation(error) { return }
                let failure = LockFailure(classifying: error)
                // transport·일시 실패만 짧은 백오프로 자동 재시도(상한까지). 취소·lockout·키 소실은
                // 즉시 사용자 액션으로 넘긴다 — 무한 재프롬프트/재요청 루프를 만들지 않는다.
                if failure == .connection, attempt < maxAutoRetries {
                    attempt += 1
                    do { try await Task.sleep(nanoseconds: UInt64(attempt) * 800_000_000) }  // 0.8s → 1.6s
                    catch { return }  // sleep 취소 = 화면 이탈
                    continue
                }
                phase = .failed(failure)
                return
            }
        }
    }
}

/// LockView 의 화면 상태. authenticating/retrying 은 스피너, failed 는 분류별 안내 + 액션.
enum LockPhase: Equatable {
    case authenticating
    case retrying
    case failed(LockFailure)
}

/// LockView 자동 인증 실패의 «원인 분류». authenticate() 가 LAError / ApiError 를 이 카테고리로
/// 접어, 화면이 상황에 맞는 카피·색·액션을 고른다 (연결 vs 생체, 취소 vs lockout vs 키 소실).
enum LockFailure: Equatable {
    /// 연결/전송 실패 — Tor·네트워크. 자동 재시도(백오프) 대상.
    case connection
    /// 사용자/시스템이 생체 프롬프트를 취소(취소·앱전환·백그라운드). «다시 시도» 가 1차 액션.
    case canceled
    /// 생체가 여러 번 막혀 잠김 — 기기 암호로 풀어야 다시 켜진다(이때만 그 안내를 노출).
    case biometryLockout
    /// 생체/암호 미설정·미지원 — 기기 설정에서 켜야 한다.
    case biometryUnavailable
    /// SE 키 소실·등록 불일치 — 재인증으로 못 푸는 dead-end. danger(빨강) 신호 + 재페어링.
    case keyLost
    /// 분류 밖 — 이미 로컬라이즈된 사유 문자열(있으면)을 그대로 노출.
    case unknown(String?)

    init(classifying error: Error) {
        // 연결/전송 — 자동 재시도 대상.
        if let api = error as? ApiError, case .transport = api { self = .connection; return }
        // 등록/키 — 재인증으로 못 푸는 막다른 길.
        if let api = error as? ApiError, case .attestFailed = api { self = .keyLost; return }
        if case DeviceAttestor.AttestorError.noKey = error { self = .keyLost; return }
        // 생체 — LAError 코드로 세분.
        if let code = Self.laErrorCode(from: error) {
            switch code {
            case .userCancel, .appCancel, .systemCancel, .userFallback:
                self = .canceled
            case .biometryLockout:
                self = .biometryLockout
            case .biometryNotAvailable, .biometryNotEnrolled, .passcodeNotSet:
                self = .biometryUnavailable
            default:
                self = .unknown((error as? LocalizedError)?.errorDescription)
            }
            return
        }
        self = .unknown((error as? LocalizedError)?.errorDescription)
    }

    /// SecKeyCreateSignature 가 던진 CFError(우리가 `signFailed` 로 보존) 또는 직접 LAError 에서
    /// LAError 코드를 끌어낸다. LAContext 바인딩 경로는 보통 LAErrorDomain, 일부 OSStatus 로도
    /// 올라오므로 둘 다 매핑한다.
    private static func laErrorCode(from error: Error) -> LAError.Code? {
        func map(_ ns: NSError) -> LAError.Code? {
            if ns.domain == LAError.errorDomain { return LAError.Code(rawValue: ns.code) }
            if ns.domain == NSOSStatusErrorDomain {
                switch ns.code {
                case Int(errSecUserCanceled): return .userCancel
                case Int(errSecAuthFailed):   return .authenticationFailed
                case Int(errSecNotAvailable): return .biometryNotAvailable
                default:                      return nil
                }
            }
            return nil
        }
        if let la = error as? LAError { return la.code }
        if case DeviceAttestor.AttestorError.signFailed(let underlying) = error { return map(underlying) }
        return map(error as NSError)
    }

    // MARK: 표현 (색·카피·액션)

    /// 진짜 막다른 길(키 소실)만 danger(빨강) 신호 아이콘을 띄운다.
    var isDeadEnd: Bool { self == .keyLost }
    var deadEndIcon: String { "key.slash" }

    /// 키 소실은 재인증이 무의미 → 생체/연결 재시도 버튼을 숨기고 RePairButton 으로만 보낸다.
    var allowsRetry: Bool {
        switch self {
        case .keyLost: return false
        default:       return true
        }
    }

    /// 재시도 버튼 라벨 — 연결 문제와 생체 문제를 «별도 카피» 로 구분한다.
    func retryLabel(bio: String) -> LocalizedStringKey {
        switch self {
        case .connection: return "다시 연결"
        default:          return "\(bio)로 다시 시도"
        }
    }

    func retryIcon(bioIcon: String) -> String {
        switch self {
        case .connection: return "arrow.clockwise"
        default:          return bioIcon
        }
    }

    /// 상태 본문 — 이미 로컬라이즈된 `unknown(detail)` 만 verbatim, 나머지는 카탈로그 키.
    func messageText(bio: String) -> Text {
        switch self {
        case .connection:
            return Text("데스크탑에 연결하지 못했어요. 네트워크 상태를 확인하고 다시 시도해 주세요.")
        case .canceled:
            return Text("\(bio) 인증을 취소했어요. 다시 시도해 주세요.")
        case .biometryLockout:
            return Text("\(bio)가 여러 번 막혀 잠시 잠겼어요.")
        case .biometryUnavailable:
            return Text("\(bio)를 사용할 수 없어요. 기기 설정에서 생체 인증이나 암호를 켠 뒤 다시 시도해 주세요.")
        case .keyLost:
            return Text("이 기기의 인증 키가 없습니다 — Mac에서 페어링을 다시 시작하세요")
        case .unknown(let detail):
            if let detail, !detail.isEmpty { return Text(detail) }
            return Text("인증에 실패했어요. 다시 시도해 주세요.")
        }
    }
}

/// LockView 의 «그리기» — 환경 의존 없는 순수 표현 뷰(상태별 카피·색·액션). LockView 가 상태를
/// 운전하고, DEBUG 시뮬레이터 갤러리·#Preview 는 상태를 직접 주입해 레이아웃을 눈검증한다.
/// 색 정책: 주 재시도 버튼만 Theme.accent(보라), 본문·안내는 .secondary/.tertiary, danger(빨강)은
/// 오직 «진짜 막다른 길»(키 소실)의 신호 아이콘에만. warning(노랑)·pro(주황) 차용 없음.
struct LockScreen: View {
    let phase: LockPhase
    let bio: String
    let bioIcon: String
    var onRetry: () -> Void

    var body: some View {
        VStack(spacing: 24) {
            Spacer()
            // 브랜드 화면 — 상태와 무관하게 앱 로고로 통일(=AppIcon 원본 재활용). 실패의 «심각도»
            // 는 아래 본문·danger 신호 아이콘·액션이 신호한다. (PaywallView 헤더와 동일한 트리트먼트.)
            Image("AppLogo")
                .resizable()
                .scaledToFit()
                .frame(width: Theme.IconSize.xxxl, height: Theme.IconSize.xxxl)
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.xl, style: .continuous))
                .accessibilityHidden(true)

            VStack(spacing: 8) {
                Text(verbatim: "Pocket Sisyphus")
                    .font(.title2.weight(.semibold))
                statusArea
            }

            actionArea

            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding()
    }

    /// 상태 본문 — 인증/재시도 중엔 안내문, 실패 시엔 분류별 카피(+키 소실만 danger 신호 아이콘).
    @ViewBuilder
    private var statusArea: some View {
        switch phase {
        case .authenticating, .retrying:
            Text("계속하려면 \(bio) 인증이 필요해요")
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 24)
        case .failed(let failure):
            VStack(spacing: 10) {
                if failure.isDeadEnd {
                    // 진짜 막다른 길(키 소실)만 빨강 신호 — 빈/오류 상태 placeholder 는 IconSize 토큰.
                    Image(systemName: failure.deadEndIcon)
                        .font(.system(size: Theme.IconSize.m))
                        .foregroundStyle(Theme.danger)
                        .accessibilityHidden(true)
                }
                failure.messageText(bio: bio)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 24)
            }
        }
    }

    /// 액션 영역 — 인증/재시도 중엔 스피너(+상태별 문구), 실패 시엔 분류별 버튼/안내.
    @ViewBuilder
    private var actionArea: some View {
        switch phase {
        case .authenticating:
            progressRow("잠금 해제 중…")
        case .retrying:
            progressRow("연결을 다시 시도하는 중…")
        case .failed(let failure):
            failureActions(failure)
        }
    }

    private func progressRow(_ label: LocalizedStringKey) -> some View {
        HStack(spacing: 8) {
            ProgressView().controlSize(.small)
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private func failureActions(_ failure: LockFailure) -> some View {
        VStack(spacing: 12) {
            // 1차 액션 — 주 재시도 버튼은 기존대로 Theme.accent(보라). 취소(b)·연결(d) 모두 여기로
            // 강조되고, 키 소실(막다른 길)에선 재시도가 무의미해 숨긴다.
            if failure.allowsRetry {
                Button(action: onRetry) {
                    Label(failure.retryLabel(bio: bio),
                          systemImage: failure.retryIcon(bioIcon: bioIcon))
                        .frame(maxWidth: 280)
                        .padding(.vertical, 12)
                }
                .buttonStyle(.borderedProminent)
                .tint(Theme.accent)
                .controlSize(.large)
            }

            // (c) 생체 잠김(lockout) 일 때만 — 생체 전용 키라 인앱 암호가 없으니 기기 암호로 푸는 안내.
            if failure == .biometryLockout {
                Text("\(bio)가 여러 번 막히면 iPhone을 기기 암호로 잠금 해제한 뒤 다시 시도해 주세요.")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 32)
            }

            // SE 키 분실(기기 교체/복원)·등록 불일치 등 재인증으로 못 푸는 경우의 탈출구
            // (페어된 상태에서만 스스로 나타난다).
            RePairButton()
                .padding(.top, 4)
        }
    }
}

#if DEBUG && targetEnvironment(simulator)
extension LockPhase {
    /// `PS_DEV_LOCKVIEW=<상태>` → 갤러리용 Phase. 시뮬레이터엔 SE 가 없어 실제 LockView 가 안 떠서,
    /// /verify-ios 가 상태별 레이아웃을 «눈으로» 보려면 이 우회로 강제 렌더한다.
    static func devPreview(_ name: String) -> LockPhase? {
        switch name {
        case "authenticating": return .authenticating
        case "retrying":       return .retrying
        case "connection":     return .failed(.connection)
        case "canceled":       return .failed(.canceled)
        case "lockout":        return .failed(.biometryLockout)
        case "unavailable":    return .failed(.biometryUnavailable)
        case "keylost":        return .failed(.keyLost)
        case "unknown":        return .failed(.unknown(nil))
        default:               return nil
        }
    }
}
#endif

#if DEBUG
#Preview("LockScreen — 상태별") {
    let states: [(String, LockPhase)] = [
        ("authenticating", .authenticating),
        ("retrying", .retrying),
        ("connection", .failed(.connection)),
        ("canceled", .failed(.canceled)),
        ("lockout", .failed(.biometryLockout)),
        ("unavailable", .failed(.biometryUnavailable)),
        ("keyLost", .failed(.keyLost)),
    ]
    return TabView {
        ForEach(states, id: \.0) { item in
            LockScreen(phase: item.1, bio: "Face ID", bioIcon: "faceid", onRetry: {})
                .tabItem { Text(item.0) }
        }
    }
    .tabViewStyle(.page)
    .environmentObject(AuthStore())
    .environmentObject(TorManager())
}
#endif

/// 직접 SSH 시도 실패 시 채택된 Tor onion fallback 채널 안내. SessionsView 위 1줄 banner.
struct TorFallbackBanner: View {
    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "tortoise")
                .foregroundStyle(Theme.warning)
            Text("Tor 회로로 통신 중 — 직접 SSH 가 닿지 않아 fallback 채택 (느림)")
                .font(.caption2)
                .foregroundStyle(.secondary)
                .lineLimit(2)
            Spacer()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(Theme.warning.opacity(Theme.Opacity.fill))
    }
}

/// 연결 실패 막힘 화면 = «연결 실패 카드». `reason`(원인 분류)으로 ① 진단 한 줄 ②
/// 1~2개의 구체 복구 액션(재시도 · 페어링 다시 · 네트워크 전환 안내) ③ reason 에 맞는
/// 가이드로 가는 StuckHelpLink 를 묶어 보여 준다. 「무엇이 왜 막혔고 지금 뭘 하면 되는가」
/// 가 한 화면에 담기도록 — 진단 없이 곧장 이탈하거나 Discussions 에 «안 돼요» 만 남기는
/// 흐름을 막는다.
///
/// 색 정책: 진단 아이콘만 reason 의 심각도색(danger=막다른 길 / warning=주의 / accent=설정 필요)을
/// 쓰고, 본문은 .secondary, 액션 버튼은 기본 accent. 리터럴 색 없음.
struct ErrorView: View {
    @EnvironmentObject var tor: TorManager
    let reason: ConnectionManager.FailureReason
    let message: String
    var onRetry: (() -> Void)? = nil

    var body: some View {
        VStack(spacing: 20) {
            Image(systemName: reason.icon)
                .font(.system(size: Theme.IconSize.xl))
                .foregroundStyle(reason.tint)
                .accessibilityLabel(reason.headline)

            VStack(spacing: 8) {
                Text(reason.headline)
                    .font(.title3.weight(.semibold))
                Text(reason.diagnostic)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 24)
            }

            // Tor 가 막힌 정황(분류 또는 tor 신호)이면 — bridge 설정으로 곧장 가는 진단 카드를
            // 재시도 버튼보다 «위» 에 둔다. 평문 재시도가 의미 없는 차단 상황에서 더 나은 길을 먼저.
            if reason == .torLikelyBlocked || tor.torLikelyBlocked {
                TorBlockedDiagnosticCard()
            }

            // 네트워크 전환 안내 — 우리가 직접 Wi-Fi/셀룰러를 못 바꾸므로 «버튼» 이 아니라 안내문.
            if reason.suggestsNetworkSwitch {
                HStack(spacing: 6) {
                    Image(systemName: "arrow.triangle.2.circlepath")
                        .foregroundStyle(.secondary)
                    Text("Wi-Fi 를 끄고 셀룰러로 바꾸거나 다른 네트워크에서 다시 시도해 보세요.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.horizontal, 24)
            }

            // 1순위 액션: 재시도(회로 재빌드 + 재연결). 일시적 네트워크 끊김 / stale 회로 대부분이
            // 이걸로 살아난다. pairingMissing 처럼 재시도가 무의미한 분류에서는 숨긴다.
            if let onRetry, reason.showsRetry {
                VStack(spacing: 6) {
                    Button {
                        onRetry()
                    } label: {
                        Label("다시 시도", systemImage: "arrow.clockwise")
                            .frame(maxWidth: 280)
                            .padding(.vertical, 12)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(Theme.accent)
                    .controlSize(.large)
                    Text("Tor 회로를 새로 빌드하고 다시 연결합니다.")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }

            // 2순위 액션: 페어링 다시 — 페어링 값이 (Mac 앱 재설치 / 토큰 회전으로) 바뀌어 영구
            // 실패에 빠진 경우의 탈출구. RePairButton 은 페어된 상태(auth.config != nil)에서만
            // 스스로 나타난다 — 페어 전 Tor 부트스트랩 실패에서는 비울 페어링이 없어 숨겨진다.
            RePairButton()
                .padding(.top, 2)

            // reason 에 맞는 in-app 가이드로 가는 문. 분류별 guideCategory 를 넘긴다(없으면
            // GitHub Discussions 로 fallback). 「이 실패는 X 유형이고, 우선 Y 를 해보라」 의 Y.
            StuckHelpLink(label: reason.helpLabel, guideCategory: reason.guideCategory)
                .padding(.top, 4)

            // in-app 가이드로도 안 풀리면 사람에게 묻는 허브(GitHub Discussions). 연결이 끊긴
            // 상태여도 폰 일반 인터넷으로 열려 daemon 과 독립적으로 동작한다. 가이드가 있는
            // 분류에서도 «사람에게 묻기» 문은 항상 남겨둔다.
            if reason.guideCategory != nil {
                StuckHelpLink(label: "막혔나요? 커뮤니티에 물어보기")
                    .padding(.top, 2)
            }

            // 디버그용 — 실패 원인 그대로 노출. 사용자에게는 작은 글씨로.
            Text(message)
                .font(.caption2.monospaced())
                .foregroundStyle(.tertiary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 24)
                .padding(.top, 8)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding()
    }
}

/// 막힘 화면(ErrorView)이 쓰는 reason → UI 매핑. 문구는 모두 LocalizedStringKey 라
/// Localizable.xcstrings 자동 추출 경로를 탄다(10개 언어 카탈로그에서 채움).
extension ConnectionManager.FailureReason {
    /// 진단 아이콘.
    var icon: String {
        switch self {
        case .pairingMissing:      return "qrcode.viewfinder"
        case .sshUnreachable:      return "bolt.horizontal.circle"
        case .torBootFailed:       return "tortoise"
        case .torLikelyBlocked:    return "wifi.exclamationmark"
        case .endpointLookupFailed: return "questionmark.circle"
        case .sharedPortConflict:  return "exclamationmark.triangle"
        case .offLanBlocked:       return "wifi.slash"
        case .unknown:             return "exclamationmark.triangle"
        }
    }

    /// 진단 아이콘 색 — 심각도 신호. danger=막다른 길, warning=주의, accent=설정 필요.
    var tint: Color {
        switch self {
        case .torLikelyBlocked:    return Theme.danger
        // LAN 전용 모드의 차단 = «외부로 연결하지 않겠다» 는 의도된 차단 상태 → danger(빨강).
        case .offLanBlocked:       return Theme.danger
        case .pairingMissing:      return Theme.accent
        case .sshUnreachable, .torBootFailed, .endpointLookupFailed, .sharedPortConflict, .unknown:
            return Theme.warning
        }
    }

    /// 막힘 화면 헤드라인 — «무엇이».
    var headline: LocalizedStringKey {
        switch self {
        case .pairingMissing:       return "페어링이 필요해요"
        case .sshUnreachable:       return "데스크탑에 연결할 수 없어요"
        case .torBootFailed:        return "Tor 연결을 준비하지 못했어요"
        case .torLikelyBlocked:     return "네트워크가 Tor 를 차단하는 것 같아요"
        case .endpointLookupFailed: return "데스크탑 주소를 가져오지 못했어요"
        case .sharedPortConflict:   return "맥에서 다른 빌드가 동시에 실행 중일 수 있어요"
        case .offLanBlocked:        return "LAN 전용 모드 — 외부 연결이 차단됐어요"
        case .unknown:              return "연결할 수 없어요"
        }
    }

    /// 진단 한 줄 — «왜 막혔고 지금 뭘 하면 되는가».
    var diagnostic: LocalizedStringKey {
        switch self {
        case .pairingMissing:
            return "이 기기에 저장된 페어링 정보가 없어요. Mac 앱의 QR 을 스캔해 다시 페어링하세요."
        case .sshUnreachable:
            return "Mac 까지 직접 연결이 닿지 않았어요. Mac 이 켜져 있고 인터넷에 연결돼 있는지, 절전/잠자기로 멈추진 않았는지 확인해 주세요."
        case .torBootFailed:
            return "Tor 네트워크를 시작하지 못했어요. 인터넷 연결을 확인하고 잠시 뒤 다시 시도해 주세요."
        case .torLikelyBlocked:
            return "직접 연결도, Tor 도 닿지 않았어요. 학교·회사·일부 국가 네트워크는 Tor 를 막기도 해요 — 네트워크를 바꾸거나 Tor bridge 를 설정하면 우회할 수 있어요."
        case .endpointLookupFailed:
            return "Tor 는 연결됐지만 Mac 데몬이 응답하지 않았어요. Mac 앱이 실행 중인지 확인하고 다시 시도해 주세요."
        case .sharedPortConflict:
            return "맥에서 다른 빌드(dev·release)가 동시에 실행 중일 수 있어요 — 공유 포트가 충돌하면 폰이 데몬에 닿지 못해요. 맥에서 한쪽 앱만 켜고 다시 시도해 주세요."
        case .offLanBlocked:
            return "LAN 전용 모드가 켜져 있어 같은 Wi‑Fi 의 Mac 으로만 연결해요. 지금은 같은 LAN 에서 Mac 을 찾지 못해, 외부 경로로 폴백하지 않고 연결을 차단했어요. 같은 Wi‑Fi 에 있는지 확인하거나 설정에서 LAN 전용 모드를 끄세요."
        case .unknown:
            return "알 수 없는 이유로 연결에 실패했어요. 잠시 뒤 다시 시도해 주세요."
        }
    }

    /// 재시도(회로 재빌드 + 재연결)가 의미 있는 분류인가. 페어링 누락은 재시도로 안 풀린다.
    var showsRetry: Bool {
        switch self {
        case .pairingMissing: return false
        default:              return true
        }
    }

    /// 네트워크 전환 안내가 도움이 되는 분류인가.
    var suggestsNetworkSwitch: Bool {
        switch self {
        case .sshUnreachable, .torBootFailed, .torLikelyBlocked: return true
        // LAN 전용 차단은 «외부로 옮겨가라» 가 아니라 «같은 LAN 으로 와라» 라 네트워크 전환 안내는 부적절.
        case .pairingMissing, .endpointLookupFailed, .sharedPortConflict, .offLanBlocked, .unknown:   return false
        }
    }

    /// 분류별 in-app 가이드 카테고리. nil 이면 StuckHelpLink 가 GitHub Discussions 로 보낸다.
    var guideCategory: String? {
        switch self {
        case .pairingMissing:       return "start"
        case .sshUnreachable, .torBootFailed, .torLikelyBlocked, .endpointLookupFailed:
            return "tor"
        case .unknown, .sharedPortConflict, .offLanBlocked: return nil
        }
    }

    /// 가이드 문 라벨 — 분류 맥락에 맞춘 안내.
    var helpLabel: LocalizedStringKey {
        switch self {
        case .pairingMissing:       return "페어링 방법 보기"
        case .torLikelyBlocked:     return "Tor 차단 우회 도움말 보기"
        case .sshUnreachable, .torBootFailed, .endpointLookupFailed:
            return "연결 문제 도움말 보기"
        case .unknown, .sharedPortConflict, .offLanBlocked: return "막혔나요? 도움받기"
        }
    }
}

/// 저장된 페어링을 비우고 QR 재스캔(PairView) 흐름으로 돌려보내는 탈출구 버튼.
///
/// Mac 쪽에서 «페어링 값 바꾸기» 로 토큰을 회전했거나 데스크탑 앱을 재설치하면 iPhone 에
/// 저장된 페어링 값이 stale 해져 영구히 연결 실패 / 무한 «연결 중» 에 빠진다 — 그 화면에
/// 갇혀 같은 실패 값만 계속 쓰게 된다. `auth.clear()` 로 그 값을 비우면 AppRoot 가
/// 자동으로 PairView(QR 스캐너) 로 라우팅한다.
///
/// 페어 전(auth.config == nil)에는 비울 페어링이 없으므로 아무것도 그리지 않는다 —
/// 그래서 ErrorView / BootView 어디에 무조건 박아도 페어된 상태에서만 나타난다.
struct RePairButton: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var tor: TorManager
    @State private var showConfirm = false

    var body: some View {
        if auth.config != nil {
            VStack(spacing: 6) {
                Button(role: .destructive) {
                    showConfirm = true
                } label: {
                    Label("페어링 값 바꾸기", systemImage: "qrcode.viewfinder")
                        .frame(maxWidth: 280)
                        .padding(.vertical, 10)
                }
                .buttonStyle(.bordered)
                .controlSize(.large)
                Text("페어링 값이 바뀌었다면 새 QR 로 다시 페어링하세요.")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            .confirmationDialog(
                "페어링을 다시 할까요?",
                isPresented: $showConfirm,
                titleVisibility: .visible
            ) {
                Button("페어링 지우고 다시 스캔", role: .destructive) {
                    auth.clear()
                    // 직접 채널 채택 후 Tor 가 멈춰 있던(.idle) 경우, 페어 해제 직후 AppRoot 는
                    // Tor.state 로 라우팅하는데 idle 이면 PairView(QR 스캐너)가 안 뜬다.
                    // startIfNeeded 는 멱등 — 이미 떠 있으면 no-op.
                    Task { await tor.startIfNeeded() }
                }
                Button("취소", role: .cancel) {}
            } message: {
                Text("저장된 페어링을 지우고 Mac 의 새 QR 을 다시 스캔합니다. 계속 연결되지 않을 때, Mac 에서 앱을 새로 설치했거나 페어링 값이 바뀐 경우 도움이 됩니다.")
            }
        }
    }
}

