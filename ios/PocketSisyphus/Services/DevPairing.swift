import Foundation

/// 시뮬레이터 자가 검증 루프(`/verify-ios` 스킬)용 «개발 페어링 주입».
///
/// ## 왜 필요한가
/// 페어링의 유일한 경로는 카메라 QR 스캔인데 시뮬레이터엔 카메라가 없다. 에이전트가
/// 빌드→설치→실행→스크린샷 검증 루프를 사람 개입 없이 돌리려면, 시뮬레이터 앱이 같은 Mac 의
/// daemon(127.0.0.1:7777)에 QR 없이 붙는 경로가 필요하다.
///
/// ## 동작 (DEBUG + 시뮬레이터 빌드에서만 컴파일)
/// `simctl launch` 의 `SIMCTL_CHILD_*` 환경변수 3개로 활성화된다:
///   - `PS_DEV_DAEMON_TOKEN`  — daemon config.json 의 평문 `token` (Bearer).
///   - `PS_DEV_LOCAL_SECRET`  — config.json 의 `localAdminSecret`. 실폰이 attest 등록된
///     daemon 에서도 `/api/*`(X-PS-Local 헤더) + WS(?local= query) 게이트를 통과시킨다.
///   - `PS_DEV_DAEMON_PORT`   — daemon HTTP 포트 (기본 7777).
///
/// 활성 시:
///   1. `seedIfNeeded` 가 스텁 PairConfig 를 Keychain 에 심어 PairView 를 건너뛴다.
///   2. `ConnectionManager` 가 SSH/Tor 없이 곧장 `.running(localPort: 포트)` — 시뮬레이터의
///      127.0.0.1 은 호스트 Mac 의 loopback 이라 daemon HTTP 에 직행 가능.
///   3. `ApiClient` 가 모든 요청에 `X-PS-Local` 을 달고, `WSClient` 가 `?local=` 을 단다.
///   4. `AttestSession.needsAuthGate` 가 false — 시뮬레이터엔 SE 가 없어 LockView 를 깰 수 없다.
///
/// ## 보안 경계
/// `#if DEBUG && targetEnvironment(simulator)` 밖(실기기/릴리즈)에서는 모든 멤버가 비활성
/// 상수로 컴파일된다 — 프로덕션 동작에 영향 0. localAdminSecret 은 같은 Mac 의 loopback
/// 으로만 전송된다 (daemon 은 127.0.0.1 bind).
enum DevPairing {
#if DEBUG && targetEnvironment(simulator)
    /// 스텁 PairConfig 식별용 onion — 진짜 onion 형식이 아님을 이름으로 드러낸다.
    /// SessionListCache 등이 onion 을 캐시 키로 쓰므로 런치 간 «고정» 값이어야 한다.
    static let stubOnion = "dev-simulator-injected.onion"

    private static var env: [String: String] { ProcessInfo.processInfo.environment }

    /// 개발 페어링 주입이 켜져 있는가 — 토큰 env 가 있으면 활성.
    static var isActive: Bool { env["PS_DEV_DAEMON_TOKEN"]?.isEmpty == false }

    /// daemon `/api/*` Bearer (config.json 의 평문 token).
    static var daemonToken: String? { env["PS_DEV_DAEMON_TOKEN"].flatMap { $0.isEmpty ? nil : $0 } }

    /// attest 게이트 우회용 localAdminSecret. 없으면 헤더/쿼리를 안 단다 (daemon 미등록이면 불필요).
    static var localAdminSecret: String? { env["PS_DEV_LOCAL_SECRET"].flatMap { $0.isEmpty ? nil : $0 } }

    /// daemon HTTP 포트 — ConnectionManager 가 SSH local forward 대신 이 포트로 직행.
    static var daemonPort: UInt16? {
        guard isActive else { return nil }
        return env["PS_DEV_DAEMON_PORT"].flatMap { UInt16($0) } ?? 7777
    }

    /// DEBUG+시뮬레이터 전용 — LockView 의 한 상태를 강제로 띄워 «레이아웃 눈검증» 하는 우회.
    /// 시뮬레이터엔 SE 가 없어 needsAuthGate 가 항상 false → 실제 LockView 가 안 떠서, /verify-ios 가
    /// 상태별 화면을 볼 수 없다. `SIMCTL_CHILD_PS_DEV_LOCKVIEW=<상태>` 로 launch 하면 AppRoot 가
    /// 그 상태의 LockScreen 을 대신 렌더한다(상태값은 `LockPhase.devPreview` 참고).
    static var lockViewState: String? { env["PS_DEV_LOCKVIEW"].flatMap { $0.isEmpty ? nil : $0 } }

    /// DEBUG+시뮬레이터 전용 — ConnectionModeView(연결 방식 선택)를 강제로 띄워 «레이아웃 눈검증»
    /// 하는 우회. 실제 프롬프트는 페어 완료 + 비-DevPairing + 미선택일 때만 떠서(시뮬레이터 DevPairing
    /// 경로에선 안 뜸), `SIMCTL_CHILD_PS_DEV_CONNMODE=1` 로 launch 하면 AppRoot 가 그 화면을 대신 렌더한다.
    static var connModePreview: Bool { (env["PS_DEV_CONNMODE"] ?? "").isEmpty == false }

    /// launch 시점에 라우팅할 딥링크 (예: pocketsisyphus://session/<id>).
    /// `simctl openurl` 은 시스템 «열겠습니까?» 확인 다이얼로그를 띄워 무인 검증을 막으므로,
    /// 검증 루프는 딥링크도 env 로 실어 앱 «안에서» DeepLinkRouter 에 직접 넣는다.
    static var launchDeepLink: URL? {
        guard isActive, let raw = env["PS_DEV_DEEPLINK"], !raw.isEmpty else { return nil }
        return URL(string: raw)
    }

    /// 부팅 시 1회 — 스텁 PairConfig 를 Keychain 에 심어 PairView 를 건너뛴다.
    /// 이미 같은 스텁이 있으면 no-op (재설치/재실행 멱등).
    @MainActor
    static func seedIfNeeded(auth: AuthStore) {
        guard isActive, let token = daemonToken else { return }
        guard auth.config?.onion != stubOnion || auth.config?.daemonToken != token else { return }
        NSLog("[DevPairing] 시뮬레이터 개발 페어링 주입 — daemon 127.0.0.1:%d", Int(daemonPort ?? 7777))
        auth.save(PairConfig(
            onion: stubOnion,
            onionAuth: String(repeating: "A", count: 52),
            endpointToken: token,
            daemonToken: token,
            sshHostKeyFingerprint: "SHA256:dev-simulator",
            sshHostKey: nil,
            sshClientPriv: "",
            sshUser: "dev",
            name: "Dev Mac (Simulator)",
            pairedAt: Date(),
            lanHost: nil,
            sshPort: nil,
            daemonPort: nil
        ))
    }
#else
    // 실기기 / 릴리즈 — 전부 비활성 상수. 호출부 분기가 컴파일 타임에 죽는다.
    static let isActive = false
    static let daemonToken: String? = nil
    static let localAdminSecret: String? = nil
    static let daemonPort: UInt16? = nil
    static let lockViewState: String? = nil
    static let connModePreview: Bool = false
    static let launchDeepLink: URL? = nil
    @MainActor
    static func seedIfNeeded(auth: AuthStore) {}
#endif
}
