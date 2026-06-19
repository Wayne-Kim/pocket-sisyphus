import Foundation
import Network
import Tor

/// 메인 앱 프로세스 내에서 직접 Tor.framework 를 운용하는 매니저.
///
/// ## 듀얼 채널 모델에서의 역할
/// - 평소: SSH 직접 연결 (IPv6/IPv4 외부 inbound 가 닿는 환경) 으로 동작 → Tor 안 띄움.
/// - Endpoint 갱신 필요 시: lazy 시작 → `/endpoint` 조회 한 번 → 즉시 stop.
/// - SSH fallback 채널 (CGNAT, UPnP 막힌 라우터): Tor onion 위 SSH 로 동작 → 유지.
///
/// ## 익스텐션을 뺀 이유
/// 1) ASC 5.4 트리거 (NEPacketTunnelProvider) 제거.
/// 2) "백그라운드 런타임 일체 금지" 원칙 — 포그라운드 진입 시 처음부터 다시 연결.
///    익스텐션이 살아 있어 회로 재사용 같은 보존 메커니즘이 필요 없음.
///
/// ## process-singleton 제약
/// iCepa `TORThread` 는 프로세스당 1회 시작 가정. 두 번째 시작이 hang 또는 fail 하는 회귀를
/// 막으려면 stop 이 반드시 깨끗해야 한다. §8 시퀀스 5단계 + 3겹 안전망 (1차 시간내 stop /
/// 2차 다음 start 직전 cleanup / 3차 강제 종료 시 fresh process) 으로 방어.
///
/// ## 시그니처
/// 옛 TunnelManager 와 동일한 표면 — state / isReady / currentSocksPort / resetCircuits /
/// installClientAuth / removeClientAuth / markUnrecoverable / recoverFromFailure /
/// startIfNeeded / stop. ConnectionManager 가 happy eyeballs orchestrator 로 그 위에 얹힘.
@MainActor
final class TorManager: ObservableObject {

    enum State: Equatable {
        case idle
        case starting(progress: Int)
        case running(socksPort: UInt16)
        case failed(message: String)
    }

    @Published private(set) var state: State = .idle {
        didSet {
            if state != oldValue {
                NSLog("[Tor] state %@ → %@",
                      String(describing: oldValue),
                      String(describing: state))
            }
        }
    }

    /// 평문 Tor 부트스트랩이 정체돼 «Tor 자체가 차단된 것 같다» 고 판단됐는가.
    /// 진단 카드(브리프 1 의 `torLikelyBlocked` 진입점) 와 «Tor bridge 설정하기» 유도에 쓴다.
    /// 다음 start 시도 진입에서 false 로, bridge/평문 어느 쪽이든 .running 도달 시 false 로 리셋.
    @Published private(set) var torLikelyBlocked: Bool = false

    /// 지금 떠 있는 Tor 가 bridge 경유인가 (UI 라벨 + fallback 무한루프 가드).
    private(set) var usingBridges: Bool = false

    /// obfs4 PT 가 듣는 로컬 SOCKS 포트 — bridge 모드 config 작성 시 참조 (nil = PT 미사용).
    private var ptObfs4Port: Int?

    // MARK: - 포트

    private let socksPort: UInt16 = 39050
    private let controlPort: UInt16 = 39051

    /// 평문 부트스트랩이 이 시간 안에 100% 에 못 닿으면 «차단» 으로 보고 fallback/실패 처리.
    /// bridge 가 설정돼 있으면 fail-fast(짧게)해서 빨리 bridge 로 넘어간다.
    private static let plainStallTimeout: TimeInterval = 60
    private static let fastStallTimeout: TimeInterval = 30
    /// bridge 경유는 handshake 가 더 느려 넉넉히 준다.
    private static let bridgeStallTimeout: TimeInterval = 75

    /// bridge 설정/상태 단일 인스턴스 — 설정 UI 와 공유.
    private var bridges: TorBridgeStore { TorBridgeStore.shared }

    // MARK: - 내부 상태

    private var torThread: TorThread?
    private var controller: TorController?
    private var dataDir: URL?
    private var clientAuthDir: URL?
    private var logFile: URL?
    private var bootstrapProgress: Int = 0

    /// 동시 startIfNeeded 호출 디듀프 — VPNConsentView 의 시작 탭 + mainContent.task 가
    /// 거의 동시에 호출될 수 있어 둘 다 같은 in-flight task 를 await.
    private var inflightStartTask: Task<Void, Never>?

    // MARK: - Public API

    func startIfNeeded() async {
        if let inflight = inflightStartTask {
            await inflight.value
            return
        }
        let task = Task<Void, Never> { [weak self] in
            await self?.startImpl()
        }
        inflightStartTask = task
        await task.value
        inflightStartTask = nil
    }

    /// 사용자/포그라운드 복귀 시 호출. 메모리 정리 + 다음 lazy start 대비.
    func stop() {
        Task { await stopImpl() }
    }

    /// 명시적 async stop — 백그라운드 진입 시퀀스에서 await 필요.
    func stopAsync() async {
        await stopImpl()
    }

    var isReady: Bool {
        if case .running = state { return true }
        return false
    }

    var currentSocksPort: UInt16? {
        if case .running(let p) = state { return p }
        return nil
    }

    func resetCircuits(force: Bool = false) async {
        guard let c = controller, c.isConnected else { return }
        NSLog("[Tor] resetCircuits(force=%d)", force ? 1 : 0)
        await closeAllCircuits(via: c)
        _ = await withCheckedContinuation { (cont: CheckedContinuation<Bool, Never>) in
            c.resetConnection { ok in cont.resume(returning: ok) }
        }
    }

    func markUnrecoverable(reason: String) {
        NSLog("[Tor] markUnrecoverable: %@", reason)
        state = .failed(
            message: String(localized: "Tor 회복 불가 — \(reason)\n잠시 뒤 다시 시도해 주세요.")
        )
    }

    func recoverFromFailure() async {
        NSLog("[Tor] recoverFromFailure")
        // 강제로 깨끗하게 리셋한 뒤 재시작.
        await stopImpl()
        state = .starting(progress: 0)
        await startIfNeeded()
    }

    /// 페어링 시 v3 client-auth priv 를 디스크에 박고 Tor 에 RELOAD.
    func installClientAuth(for cfg: PairConfig) async {
        let onionBase = cfg.onion.hasSuffix(".onion")
            ? String(cfg.onion.dropLast(".onion".count))
            : cfg.onion
        await writeClientAuthFile(onionBase: onionBase, privBase32: cfg.onionAuth)
        guard let c = controller, c.isConnected else { return }
        _ = await withCheckedContinuation { (cont: CheckedContinuation<Bool, Never>) in
            c.resetConnection { ok in cont.resume(returning: ok) }
        }
    }

    func removeClientAuth(for cfg: PairConfig) async {
        let onionBase = cfg.onion.hasSuffix(".onion")
            ? String(cfg.onion.dropLast(".onion".count))
            : cfg.onion
        guard let dir = clientAuthDir else { return }
        let file = dir.appendingPathComponent("\(onionBase).auth_private")
        try? FileManager.default.removeItem(at: file)
    }

    // MARK: - start 구현

    private func startImpl() async {
        NSLog("[Tor] startImpl entry state=%@", String(describing: state))
        if case .running = state { return }

        // 2차 안전망 — 이전 인스턴스의 stale state cleanup. start 직전 항상.
        await stopImpl(silent: true)

        torLikelyBlocked = false
        state = .starting(progress: 0)

        // 항상 «평문 우선» — bridge 가 설정돼 있어도 먼저 평문으로 띄운다 (회귀 0). 평문 부트스트랩이
        // 정체되면 awaitBootstrapOutcome 가 bridge 경유로 자동 재시도한다.
        await startTor(useBridges: false)
    }

    /// 실제 TorThread 기동 한 사이클 — config 작성 → start → control 연결 → 부트스트랩 결과 판정.
    /// `useBridges` 면 bridge line + (obfs4 시) ClientTransportPlugin 을 주입한 config 로 띄운다.
    private func startTor(useBridges: Bool) async {
        usingBridges = useBridges

        guard let cfg = buildConfiguration(useBridges: useBridges) else {
            state = .failed(message: String(localized: "Tor 데이터 디렉토리 준비 실패"))
            return
        }

        let t = TorThread(configuration: cfg)
        self.torThread = t
        t.start()
        NSLog("[Tor] TorThread.start — dataDir=%@ bridges=%d",
              self.dataDir?.path ?? "<nil>", useBridges ? 1 : 0)

        // controller 가 control port 에 붙을 때까지 폴링. 0.5s × 24 = 최대 12s.
        // (Tor 가 차단돼도 control port 는 로컬이라 뜬다 — 차단 신호는 «부트스트랩 정체» 다.)
        guard await connectController(maxIterations: 24) else {
            state = .failed(message: String(localized: "Tor control port 응답 없음"))
            return
        }

        await awaitBootstrapOutcome(useBridges: useBridges)
    }

    /// 부트스트랩이 100%(.running)에 닿는지 시간 내에 지켜보고, 정체되면 «차단» 으로 판정한다.
    ///  - 평문에서 정체 + bridge 사용 가능 → bridge 경유 자동 재시도.
    ///  - 평문에서 정체 + bridge 없음 → torLikelyBlocked + .failed (UI 가 «bridge 설정» 유도).
    ///  - bridge 에서도 정체 → bridge 실패 보고 + .failed (무한루프 방지).
    private func awaitBootstrapOutcome(useBridges: Bool) async {
        let timeout = useBridges
            ? Self.bridgeStallTimeout
            : (canFallbackToBridges ? Self.fastStallTimeout : Self.plainStallTimeout)

        if await waitForRunning(timeout: timeout) {
            torLikelyBlocked = false
            if useBridges { bridges.setStatus(.connected) }
            return
        }

        // 부트스트랩 정체 — Tor 트래픽 자체가 막힌 정황.
        torLikelyBlocked = true

        if !useBridges {
            if canFallbackToBridges {
                NSLog("[Tor] 평문 부트스트랩 정체 — bridge 경유 자동 재시도")
                await restartWithBridges()
            } else {
                state = .failed(message: String(localized: "Tor 연결이 막혀 있어요. 학교·회사·일부 국가 네트워크는 Tor 를 차단할 수 있어요 — Tor bridge 를 설정하면 우회할 수 있습니다."))
            }
        } else {
            bridges.setStatus(.failed(String(localized: "설정한 bridge 로도 연결하지 못했어요")))
            state = .failed(message: String(localized: "bridge 로도 Tor 에 연결하지 못했어요. bridge 라인이 만료됐거나 막혔을 수 있어요 — 새 bridge 를 받아 다시 시도해 주세요."))
        }
    }

    /// 평문 Tor 를 내리고 bridge(필요 시 obfs4 PT 동반) 로 다시 띄운다.
    private func restartWithBridges() async {
        bridges.setStatus(.connecting)
        // 평문 TorThread + (혹시 떠 있던) PT 를 깨끗이 내린다.
        await stopImpl(silent: true)

        // obfs4 라인이 있고 PT(IPtProxy)가 링크돼 있으면 in-process obfs4 를 띄워 포트 확보.
        if bridges.usesObfs4, PluggableTransport.shared.isAvailable {
            ptObfs4Port = PluggableTransport.shared.startObfs4(stateDir: ptStateDirURL())
            if ptObfs4Port == nil {
                NSLog("[Tor] obfs4 PT 시작 실패 — vanilla bridge 라인만 시도")
            }
        }

        state = .starting(progress: 0)
        await startTor(useBridges: true)
    }

    /// bridge 로 fallback 할 수 있는 상태인가 — 사용자가 켜뒀고, 실제로 시도 가능한 라인이 있는가.
    /// (vanilla 는 항상, obfs4 는 PT 가 링크된 빌드에서만 «시도 가능».)
    private var canFallbackToBridges: Bool {
        guard bridges.enabled else { return false }
        return !bridges.usableBridgeLines(
            ptObfs4Available: PluggableTransport.shared.isAvailable
        ).isEmpty
    }

    /// 부트스트랩 .running 도달을 시간 내에 폴링. .failed 로 빠지면 즉시 false.
    private func waitForRunning(timeout: TimeInterval) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if case .running = state { return true }
            if case .failed = state { return false }
            try? await Task.sleep(nanoseconds: 500_000_000)  // 500ms
        }
        if case .running = state { return true }
        return false
    }

    /// obfs4 PT 상태 디렉토리 — Documents 하위. (Tor dataDir 와 분리.)
    private func ptStateDirURL() -> URL {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first!
        return docs.appendingPathComponent("pt_state", isDirectory: true)
    }

    // MARK: - stop 구현 (§7.B 5단계 시퀀스)

    /// `silent=true` 면 로그 노이즈를 줄여 cleanup 용 호출과 명시 stop 을 구분.
    private func stopImpl(silent: Bool = false) async {
        if !silent {
            NSLog("[Tor] stop 시퀀스 진입 — currentState=%@", String(describing: state))
        }

        // ① SIGNAL HALT — graceful 종료 명령. controller 가 살아있을 때만 의미.
        if let c = controller, c.isConnected {
            await sendSignalHalt(via: c)
        }

        // ② controller disconnect + nil.
        controller?.disconnect()
        controller = nil

        // ③ TorThread cancel + nil. iCepa 는 cancel 외 명시적 termination API 가 없어
        //    스레드가 자체 cleanup 하고 빠지길 기다린다.
        torThread?.cancel()
        torThread = nil

        // ③' obfs4 PT(IPtProxy) 도 같이 내린다. 직접 채널 채택으로 Tor 가 멈출 때 PT 가 남아
        //    리소스를 잡고 있지 않게 — «직접 채널 살아있으면 bridge 안 띄움» 정책의 일부.
        PluggableTransport.shared.stop()
        ptObfs4Port = nil
        usingBridges = false

        // ④ 락 파일 제거. 비정상 종료된 이전 인스턴스의 잔재.
        if let dir = dataDir {
            let lock = dir.appendingPathComponent("lock")
            try? FileManager.default.removeItem(at: lock)
        }

        // ⑤ 포트 해제 대기 — TIME_WAIT 해소 최대 ~2-3s. 그 안에 안 풀려도 진행 (다음 start 가
        //    동적 포트 fallback 시도하거나, 사실상 SO_REUSEADDR 로 흡수됨).
        await waitForPortRelease(socksPort, timeout: 3.0)
        await waitForPortRelease(controlPort, timeout: 1.0)

        bootstrapProgress = 0
        if case .failed = state {
            // 실패 상태 보존 — recoverFromFailure 가 명시적으로 .starting 으로 되돌릴 때까지.
        } else {
            state = .idle
        }
        if !silent {
            NSLog("[Tor] stop 시퀀스 완료")
        }
    }

    private func sendSignalHalt(via c: TorController) async {
        // iCepa TorController 는 sendCommand 같은 generic API 가 없고 signal 도 직접 메서드.
        // 가장 가까운 것은 resetConnection (SIGNAL RELOAD) — HALT 는 raw 채널로 전송이 필요해
        // 1차 구현에선 SIGNAL DUMP 같은 부가 신호 없이 disconnect 만으로 정리.
        // (HALT 전송이 회귀에 필요하면 raw socket 으로 NS 토큰 보내는 path 추가.)
        _ = c
    }

    /// 시스템 sandbox 가 raw socket 권한을 안 줘서 port probe 는 TCP connect 시도로 대체.
    /// 연결 거부 = listener 없음 = 해제됨.
    private func waitForPortRelease(_ port: UInt16, timeout: TimeInterval) async {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if await !isPortInUse(port) {
                return
            }
            try? await Task.sleep(nanoseconds: 100_000_000)  // 100ms
        }
        NSLog("[Tor] waitForPortRelease %d timeout (%.1fs)", port, timeout)
    }

    private func isPortInUse(_ port: UInt16) async -> Bool {
        await withCheckedContinuation { (cont: CheckedContinuation<Bool, Never>) in
            let conn = NWConnection(
                host: "127.0.0.1",
                port: NWEndpoint.Port(rawValue: port)!,
                using: .tcp
            )
            var done = false
            conn.stateUpdateHandler = { state in
                guard !done else { return }
                switch state {
                case .ready:
                    done = true
                    conn.cancel()
                    cont.resume(returning: true)  // 연결 성공 = listener 있음
                case .failed:
                    done = true
                    conn.cancel()
                    cont.resume(returning: false) // 연결 실패 = listener 없음
                default:
                    break
                }
            }
            conn.start(queue: DispatchQueue.global())
            DispatchQueue.global().asyncAfter(deadline: .now() + 0.3) {
                guard !done else { return }
                done = true
                conn.cancel()
                cont.resume(returning: false)
            }
        }
    }

    // MARK: - configuration

    private func buildConfiguration(useBridges: Bool = false) -> TorConfiguration? {
        // App Group 의존성 제거 — 메인 앱 Documents 안에 Tor 데이터.
        guard let docs = FileManager.default.urls(
            for: .documentDirectory,
            in: .userDomainMask
        ).first else { return nil }

        let dataDir = docs.appendingPathComponent("tor", isDirectory: true)
        let clientAuthDir = docs.appendingPathComponent("tor_client_auth", isDirectory: true)
        try? FileManager.default.createDirectory(at: dataDir, withIntermediateDirectories: true)
        try? FileManager.default.createDirectory(
            at: clientAuthDir,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        try? FileManager.default.setAttributes(
            [.posixPermissions: 0o700],
            ofItemAtPath: clientAuthDir.path
        )
        ensureCachesExcludedFromBackup(at: dataDir)

        // 1차 안전망 — stale lock 제거. start 직전 stopImpl 의 ④ 와 중복 안전망.
        let lock = dataDir.appendingPathComponent("lock")
        try? FileManager.default.removeItem(at: lock)

        let logFile = dataDir.appendingPathComponent("tor.log")
        try? "".write(to: logFile, atomically: false, encoding: .utf8)

        self.dataDir = dataDir
        self.clientAuthDir = clientAuthDir
        self.logFile = logFile

        let cfg = TorConfiguration()
        cfg.cookieAuthentication = true
        cfg.dataDirectory = dataDir
        cfg.clientOnly = true
        cfg.avoidDiskWrites = false
        cfg.ignoreMissingTorrc = true
        cfg.options = [
            "SocksPort": "127.0.0.1:\(socksPort)",
            "ControlPort": "127.0.0.1:\(controlPort)",
            "Log": "notice file \(logFile.path)",
            "ClientOnionAuthDir": clientAuthDir.path,
            "LongLivedPorts": "22,80",
            "MaxCircuitDirtiness": "3600",
            "LearnCircuitBuildTimeout": "0",
            "CircuitBuildTimeout": "30",
            "ConfluxEnabled": "1",
            "ConfluxClientUX": "throughput",
        ]

        // bridge 모드 — 반복 가능한 지시문(`Bridge`, `ClientTransportPlugin`)은 [String:String]
        // options 딕셔너리로 표현 못 하므로 raw argv(arguments)로 주입한다. useBridges=false 면
        // 아무것도 안 붙어 기존 동작과 byte-for-byte 동일 (회귀 0).
        if useBridges {
            // 갓 만든 config 라 기존 arguments 가 없다 — 새로 구성해 통째로 설정.
            var args: [String] = ["--UseBridges", "1"]
            if let port = ptObfs4Port {
                args += ["--ClientTransportPlugin", "obfs4 socks5 127.0.0.1:\(port)"]
            }
            let lines = bridges.usableBridgeLines(ptObfs4Available: ptObfs4Port != nil)
            for line in lines { args += ["--Bridge", line] }
            // `arguments` 는 (options 와 달리) Swift 로 NSMutableArray 로 들어와 [String] 직접
            // 대입이 안 된다 — 명시적으로 감싼다.
            cfg.arguments = NSMutableArray(array: args)
            NSLog("[Tor] bridge config — %d 라인, obfs4 PT=%@",
                  lines.count, ptObfs4Port.map { String($0) } ?? "none")
        }

        return cfg
    }

    private func ensureCachesExcludedFromBackup(at url: URL) {
        var resourceURL = url
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? resourceURL.setResourceValues(values)
    }

    // MARK: - controller + bootstrap

    private func connectController(maxIterations: Int) async -> Bool {
        for iter in 0..<maxIterations {
            try? await Task.sleep(nanoseconds: 500_000_000) // 500ms
            guard let dataDir else { return false }
            let cookieFile = dataDir.appendingPathComponent("control_auth_cookie")
            guard let cookie = try? Data(contentsOf: cookieFile) else { continue }
            let c = TorController(socketHost: "127.0.0.1", port: controlPort)
            guard c.isConnected else {
                if iter % 10 == 0 {
                    NSLog("[Tor] control port not ready (iter %d)", iter)
                }
                continue
            }
            let ok = await authenticate(c, cookie: cookie)
            if ok {
                self.controller = c
                subscribeProgress(c)
                NSLog("[Tor] controller authenticated after %d iterations", iter)
                return true
            }
            c.disconnect()
        }
        return false
    }

    private func authenticate(_ c: TorController, cookie: Data) async -> Bool {
        await withCheckedContinuation { (cont: CheckedContinuation<Bool, Never>) in
            c.authenticate(with: cookie) { success, _ in
                cont.resume(returning: success)
            }
        }
    }

    private func subscribeProgress(_ c: TorController) {
        _ = c.addObserver(forStatusEvents: { [weak self] type, _, action, arguments in
            guard let self else { return false }
            if type == "STATUS_CLIENT" && action == "BOOTSTRAP" {
                if let progStr = arguments?["PROGRESS"], let p = Int(progStr) {
                    Task { @MainActor in
                        self.bootstrapProgress = p
                        if p < 100 {
                            self.state = .starting(progress: p)
                        } else {
                            self.state = .running(socksPort: self.socksPort)
                        }
                    }
                    return true
                }
            }
            return false
        })
        _ = c.addObserver(forCircuitEstablished: { [weak self] established in
            guard let self, established else { return }
            Task { @MainActor in
                self.bootstrapProgress = 100
                self.state = .running(socksPort: self.socksPort)
            }
        })
    }

    // MARK: - circuits

    private func closeAllCircuits(via c: TorController) async {
        let circuits = await withCheckedContinuation { (cont: CheckedContinuation<[TorCircuit], Never>) in
            c.getCircuits { cs in cont.resume(returning: cs) }
        }
        guard !circuits.isEmpty else { return }
        _ = await withCheckedContinuation { (cont: CheckedContinuation<Bool, Never>) in
            c.close(circuits) { ok in cont.resume(returning: ok) }
        }
    }

    // MARK: - client auth file

    /// v3 client-auth priv 를 ClientOnionAuthDir 에 작성. base32 priv 그대로.
    /// 메인 앱이 직접 디스크에 쓴다 — 익스텐션 IPC 경로 사라짐.
    private func writeClientAuthFile(onionBase: String, privBase32: String) async {
        guard let dir = clientAuthDir else { return }
        let line = "\(onionBase):descriptor:x25519:\(privBase32)\n"
        let file = dir.appendingPathComponent("\(onionBase).auth_private")
        do {
            try line.write(to: file, atomically: true, encoding: .utf8)
            try FileManager.default.setAttributes(
                [.posixPermissions: 0o600],
                ofItemAtPath: file.path
            )
            NSLog("[Tor] wrote client auth: %@", file.lastPathComponent)
        } catch {
            NSLog("[Tor] writeAuthPrivateFile failed: %@", String(describing: error))
        }
    }
}
