import Foundation

/// 듀얼 채널 모델의 happy eyeballs orchestrator.
///
/// ## 흐름
///   1) endpoint 캐시가 있으면 그 배열로 병렬 SSH 시도 (Tor 안 띄움).
///   2) 캐시 미스 or 모든 candidate 실패 → Tor in-process 시작 → /endpoint 갱신 → 다시 시도.
///   3) 첫 성공 채택, 나머지 candidate cancel, 채택된 channel 의 local forward port 노출.
///
/// ## priority + staggered 시도 (RFC 8305 happy eyeballs)
///   - priority 오름차순으로 200ms 간격을 두고 connect 시도 시작.
///   - 첫 success 가 다른 시도 모두 cancel.
///   - direct_ipv6 (priority 1) → direct_ipv4 (priority 2) → tor_onion (priority 99) 순서가 자연스럽게 빠른 환경 우선.
///
/// ## Tor 사용 정책
///   - 직접 채널 (IPv6/IPv4) 채택 시 Tor stop → 다음 endpoint 갱신 필요 전까지 idle.
///   - Tor onion 채택 시 Tor 유지 (fallback 채널 위에서 SSH 가 동작 중).
@MainActor
final class ConnectionManager: ObservableObject {

    /// 연결 실패의 «원인 분류». 막힘 뷰(ErrorView)가 이 값으로 진단 한 줄 + 복구 액션 +
    /// 가이드 카테고리를 고른다. UI 문구/색은 ConnectionFailureCard 의 확장에 있고, 여기선
    /// 클라이언트가 어느 단계에서 막혔는지(가진 단계 정보만으로) 분류만 한다 — daemon 측
    /// 진단 프로토콜은 쓰지 않는다.
    enum FailureReason: Equatable {
        /// 저장된 페어링 자체가 없음 (auth.config == nil).
        case pairingMissing
        /// 직접/onion SSH 후보를 다 시도했지만 데몬까지 채널이 닿지 않음.
        case sshUnreachable
        /// Tor 부트스트랩 자체가 실패 (직접 채널은 시도조차 못 했거나 캐시 미스).
        case torBootFailed
        /// 직접 SSH 도 죽고 Tor 부팅/onion 조회까지 막힘 — 네트워크가 Tor 를 차단하는 정황.
        /// (ARCHITECTURE.md:359 의 CGNAT + ISP/방화벽 차단 케이스 = 완전한 막다른 길.)
        case torLikelyBlocked
        /// Tor 는 떴지만 onion 위 `/endpoint` 조회가 실패 (데몬 미응답 등).
        case endpointLookupFailed
        /// dev·release 두 빌드가 Mac 에서 동시에 실행 중이라 공유 daemon-runtime 포트가
        /// split-brain 된 정황. onion 위 `/endpoint` 는 응답했고(= Mac 의 endpoint-only 리스너는
        /// 살아 있음) host key 도 일치했는데, 그 daemon 이 advertise 한 SSH/데몬 채널로는 어떤
        /// 후보도 닿지 못한 케이스 — 한쪽 빌드만 켜면 해소된다. (Mac MenuContent 의
        /// listeningPort != runtimeFilePort 검출과 같은 현상을 폰 표면에서 분류한 것.)
        case sharedPortConflict
        /// LAN 전용(사설망 직결) 모드인데 같은 LAN 에서 Mac 을 못 찾았거나 LAN 직결이 전부 실패.
        /// 정책상 공인/onion 으로 폴백하지 «않고» 명시적으로 차단(fail-closed)한 상태 — 오프-LAN
        /// 이거나 적대적 LAN host key 불일치 등. 외부로 패킷이 새지 않았음을 보장한다.
        case offLanBlocked
        /// 분류 불가 (개발 페어링 경로 등).
        case unknown
    }

    enum State: Equatable {
        case idle
        case connecting
        case running(localPort: UInt16, endpointType: EndpointEntry.EndpointType)
        case failed(reason: FailureReason, message: String)
    }

    @Published private(set) var state: State = .idle

    /// 활성 WS 연결의 application-level ping → pong 왕복 시간 EMA (ms).
    /// WSClient 가 30s 주기로 ping 을 보내고 pong 수신 시점에서 `recordRTT` 호출한다.
    /// nil 이면 아직 측정 안 됨 (콜드 부팅 직후 또는 WS 미연결).
    ///
    /// 사용처: ChatView 의 더보기 메뉴 「연결 상태」 row (`connectionStatusMenuLabel`).
    /// EMA alpha = 0.4 — 최근 측정에 좀 더 비중. 회로 변경/혼잡 변화에 빠르게 반응.
    @Published private(set) var lastRTTms: Int?

    private let auth: AuthStore
    private let tor: TorManager
    private let cache: EndpointCache
    /// 직접 채널 host key TOFU 장부. connectOne 이 SSHClient 검증에 넘긴다.
    private let knownHosts: KnownHostStore
    private var activeClient: SSHClient?
    /// 이번 연결 시도 중 직접 채널에서 host key 불일치(MITM 의심 = host key 변경)를 본 적이 있는가.
    /// connectImpl 진입 시 reset, connectOne 의 거부에서 set, 전부 실패 시 메시지 분기에 쓰인다.
    ///
    /// @Published 인 이유: onion 으로 안전하게 fallback 해 `.running(torOnion)` 으로 채택되면
    /// 연결 자체는 성공이라 사용자가 «직접 채널에서 host key 가 바뀌었다» 는 신호를 놓친다.
    /// 「보안 상태」 패널이 이 플래그를 읽어 fallback 으로 연결됐어도 강조 경고를 띄운다 (읽기 전용 표면화).
    @Published private(set) var sawHostKeyMismatch = false
    /// 동시 connect() 호출 디듀프. ApiClient.send 의 회복 경로 + AppRoot 의 .task + Pair 가
    /// 거의 동시에 connect() 부르면 둘 다 state .connecting 으로 만들고 race. 단일 in-flight.
    private var inflightConnectTask: Task<Void, Never>?
    /// 라이브 프리뷰 forward 캐시 — 프록시 포트 → 로컬 forward 포트. 같은 SSH 세션 동안만 유효.
    /// (재)연결 시 activeClient 가 바뀌면 옛 forward 가 죽으므로 connectImpl/disconnect 에서 비운다.
    private var previewForwards: [UInt16: UInt16] = [:]

    init(auth: AuthStore, tor: TorManager, cache: EndpointCache, knownHosts: KnownHostStore) {
        self.auth = auth
        self.tor = tor
        self.cache = cache
        self.knownHosts = knownHosts
    }

    /// 포그라운드 진입 / 페어링 직후 호출. 캐시 우선 시도 → 실패 시 Tor 경유 endpoint 갱신.
    ///
    /// **멱등성**: 이미 `.running` 이면 즉시 return — currentLocalPort 가 살아있는데 또
    /// 시도하면 잠시 `.connecting` 으로 떨어져 다른 ApiClient 호출이 `torNotRunning` 으로
    /// 깨지는 race. SSH 가 실제로 죽었으면 ApiClient.send 의 transport 실패가 `reconnect()`
    /// 를 호출하도록.
    func connect() async {
        if let inflight = inflightConnectTask {
            await inflight.value
            return
        }
        if case .running = state { return }
        let task = Task<Void, Never> { [weak self] in
            await self?.connectImpl(force: false)
        }
        inflightConnectTask = task
        await task.value
        inflightConnectTask = nil
    }

    /// 강제 재연결 — SSH 채널이 죽은 것이 검증됐을 때 사용. 옛 active client 정리 후 새로 시도.
    /// `.running` 이어도 다시 connect — 회복 경로의 명시적 트리거.
    func reconnect() async {
        if let inflight = inflightConnectTask {
            await inflight.value
            return
        }
        let task = Task<Void, Never> { [weak self] in
            await self?.connectImpl(force: true)
        }
        inflightConnectTask = task
        await task.value
        inflightConnectTask = nil
    }

    private func connectImpl(force: Bool) async {
        // (재)연결 — 옛 SSH 세션 위의 프리뷰 forward 는 죽으므로 캐시를 비운다.
        previewForwards.removeAll()
        sawHostKeyMismatch = false
        // 시뮬레이터 개발 페어링(DevPairing) — SSH/Tor 없이 호스트 Mac 의 daemon 포트로 직행.
        // 시뮬레이터의 127.0.0.1 은 Mac loopback 그 자체라 local forward 가 필요 없다.
        if let devPort = DevPairing.daemonPort {
            state = .running(localPort: devPort, endpointType: .directIPv4)
            return
        }
        guard let cfg = auth.config else {
            state = .failed(reason: .pairingMissing, message: String(localized: "페어링 정보 없음"))
            return
        }

        // ── LAN 전용(사설망 직결) 모드 ──────────────────────────────────────────────
        // 켜져 있으면 «같은 LAN 의 사설/링크로컬·mDNS 주소로만» 직접 SSH 하고, Tor 부트스트랩·
        // 공인 IPv4/IPv6·onion 폴백을 통째로 건너뛴다. 채택 실패해도 외부로 폴백하지 않고
        // fail-closed(.offLanBlocked) — 오프-LAN 이면 명시적 차단이라 패킷이 사설망을 벗어나지
        // 않음을 보장한다. host key 검증(TOFU)은 그대로라 적대적 LAN 의 MITM 도 거부된다.
        if LanOnlyPolicy.isEnabled() {
            await connectLanOnly(cfg: cfg, force: force)
            return
        }

        // 직접 채널(IPv4/IPv6) SSH 후보를 실제로 시도했고 전부 실패했는가 — 그 «이후» 에 Tor 까지
        // 막히면 단순 부팅 실패가 아니라 «네트워크가 Tor 를 차단» 하는 막다른 길로 승격한다.
        var triedDirectSSH = false
        // force 일 때만 옛 client 정리 + state 를 .connecting 으로 강제. 비-force 면 .running 보존.
        if force {
            activeClient?.disconnect()
            activeClient = nil
            state = .connecting
        } else if case .running = state {
            return
        } else {
            state = .connecting
        }

        // 1차: 캐시된 endpoint 로 happy eyeballs.
        if let cached = cache.cached {
            if let result = await tryConnectAll(cfg: cfg, endpoints: cached.endpoints) {
                activeClient = result.client
                state = .running(localPort: result.localPort, endpointType: result.endpointType)
                if result.endpointType != .torOnion {
                    await tor.stopAsync()
                }
                return
            }
            // 캐시에 직접 채널 후보가 있었는데 다 실패 → 직접 SSH 시도가 무산된 것으로 기록.
            triedDirectSSH = cached.endpoints.contains { $0.type != .torOnion }
        }

        // 2차: 캐시 미스 또는 전부 실패 → Tor 띄워 endpoint 갱신 후 다시.
        await tor.startIfNeeded()
        guard tor.isReady else {
            // Tor 가 차단돼 막힌 경우 startIfNeeded 가 (bridge fallback 까지 시도한 뒤) .failed 에
            // 차단 안내 메시지를 담는다 — 그 메시지를 그대로 surface 해서 ErrorView 가 «Tor bridge
            // 설정» 진단 카드를 띄우게 한다(tor.torLikelyBlocked). 그 외엔 일반 부팅 실패 문구.
            // 직접 SSH 가 이미 죽었거나(triedDirectSSH) TorManager 가 평문 부트스트랩 정체를
            // 차단으로 판정(torLikelyBlocked)했으면 «완전한 막다른 길» = torLikelyBlocked 로 승격.
            // 그 외(콜드 캐시 미스에서 단순히 Tor 부팅만 실패)는 일반 torBootFailed.
            let blocked = triedDirectSSH || tor.torLikelyBlocked
            let reason: FailureReason = blocked ? .torLikelyBlocked : .torBootFailed
            if case .failed(let m) = tor.state {
                state = .failed(reason: reason, message: m)
            } else {
                state = .failed(reason: reason, message: String(localized: "Tor 부팅 실패"))
            }
            return
        }
        guard let fresh = await fetchEndpoint(cfg: cfg) else {
            // Tor 는 떴지만 onion 위 endpoint 조회 실패. 직접 SSH 까지 이미 죽었다면 데몬으로 가는
            // 모든 길이 막힌 것 → torLikelyBlocked. 아니면 단순 endpoint 조회 실패.
            let reason: FailureReason = triedDirectSSH ? .torLikelyBlocked : .endpointLookupFailed
            state = .failed(reason: reason, message: String(localized: "endpoint 조회 실패"))
            return
        }
        cache.save(fresh)
        if let result = await tryConnectAll(cfg: cfg, endpoints: fresh.endpoints) {
            activeClient = result.client
            state = .running(localPort: result.localPort, endpointType: result.endpointType)
            if result.endpointType != .torOnion {
                await tor.stopAsync()
            }
            return
        }
        // 직접 채널이 host key 불일치로 거부됐고(MITM 의심) 안전한 onion fallback 마저 못 붙은
        // 경우엔 일반 실패와 구분해 «서버 위장» 을 명시한다. (불일치라도 onion 이 붙었으면 위
        // 분기에서 이미 .running 으로 채택돼 여기 안 온다 — 사용자는 안전 경로로 투명하게 연결.)
        if sawHostKeyMismatch {
            state = .failed(reason: .sshUnreachable, message: String(localized: "보안 검증 실패 — 서버 host key 가 일치하지 않아 직접 연결을 거부했습니다 (서버 위장 가능성)"))
        } else {
            // 여기까지 왔다는 건 onion 위 `/endpoint` 가 방금 응답했다는 뜻 = Mac 의 endpoint-only
            // 리스너(별도 포트)는 살아 있는데, 그 daemon 이 advertise 한 SSH/데몬 채널로는 어떤
            // 후보도 닿지 못했다. dev·release 두 빌드가 공유 daemon-runtime 포트를 다투는 split-brain
            // 의 전형적 증상 — 한쪽만 켜면 해소된다. (Mac MenuContent 의 listeningPort != runtimeFilePort
            // 와 같은 현상.) 단순 «연결 실패» 대신 원인을 짚어 준다.
            state = .failed(reason: .sharedPortConflict, message: String(localized: "endpoint 는 응답했으나 모든 SSH/데몬 채널 연결 실패 — 다른 빌드와 포트 충돌 가능"))
        }
    }

    /// LAN 전용(사설망 직결) 연결 — Tor·공인·onion 을 통째로 건너뛰고 같은 LAN 의 사설/링크로컬·
    /// mDNS 주소로만 SSH 한다. 채택 실패해도 외부로 폴백하지 않고 fail-closed(.offLanBlocked).
    ///
    /// 후보 = 페어링 QR 의 mDNS `<host>.local`(IP 변경 추종) ∪ 캐시된 daemon 광고 `direct_lan`.
    /// host key 검증(TOFU/핀)은 직접 채널과 동일하게 적용돼 적대적 LAN 의 MITM 을 거부한다.
    private func connectLanOnly(cfg: PairConfig, force: Bool) async {
        if force {
            activeClient?.disconnect()
            activeClient = nil
        } else if case .running(_, let t) = state, t == .directLan {
            // 이미 LAN 채널로 붙어 있으면 멱등 — 다시 시도하지 않는다.
            return
        }
        state = .connecting
        // LAN 전용 모드에선 Tor 를 «절대» 쓰지 않는다 — 떠 있으면 정리해 외부로 새지 않게.
        await tor.stopAsync()

        let cachedEndpoints = cache.cached?.endpoints ?? []
        let candidates = LanOnlyPolicy.lanCandidates(
            lanHost: cfg.lanHost,
            sshPort: cfg.sshPort,
            cached: cachedEndpoints
        )
        guard !candidates.isEmpty else {
            // 오프-LAN 이거나 LAN 주소를 모름 → 명시적 차단. 공인/onion 으로 폴백 금지.
            state = .failed(
                reason: .offLanBlocked,
                message: String(localized: "LAN 전용 모드 — 같은 Wi‑Fi 의 Mac 을 찾지 못해 연결을 차단했어요. 외부 네트워크에선 연결되지 않습니다."))
            return
        }

        // connectOne 이 읽는 sshUser/daemonLocalPort/host key fingerprint 를 합성해 캐시에 둔다.
        // (실제 daemon 포트가 캐시에 있으면 우선, 없으면 페어링 QR 값, 그것도 없으면 기본 7777.)
        let daemonPort = cache.cached?.daemonLocalPort ?? cfg.daemonPort ?? 7777
        let fingerprint = cache.cached?.sshHostKeyFingerprint ?? cfg.sshHostKeyFingerprint
        let user = cache.cached?.sshUser ?? cfg.sshUser
        cache.save(EndpointConfig(
            v: 1,
            endpoints: candidates,
            sshHostKeyFingerprint: fingerprint,
            sshUser: user,
            daemonLocalPort: daemonPort,
            issuedAt: Date(),
            ipFetchedAt: nil,
            ttlSec: 300
        ))

        if let result = await tryConnectAll(cfg: cfg, endpoints: candidates) {
            activeClient = result.client
            state = .running(localPort: result.localPort, endpointType: result.endpointType)
            return
        }

        // 후보가 있었지만 전부 실패 — fail-closed. host key 불일치면 «적대적 LAN 가장» 을 명시.
        if sawHostKeyMismatch {
            state = .failed(
                reason: .offLanBlocked,
                message: String(localized: "LAN 전용 모드 — 서버 host key 가 일치하지 않아 직접 연결을 거부했어요 (적대적 LAN 가장 가능성)."))
        } else {
            state = .failed(
                reason: .offLanBlocked,
                message: String(localized: "LAN 전용 모드 — 같은 LAN 에서 Mac 에 연결하지 못했어요. 외부 경로로 폴백하지 않습니다."))
        }
    }

    /// 백그라운드 진입 시 호출. SSH 끊고 Tor 도 같이 정리.
    func disconnect() async {
        activeClient?.disconnect()
        activeClient = nil
        previewForwards.removeAll()
        await tor.stopAsync()
        state = .idle
    }

    /// 라이브 프리뷰 — 채택된 SSH 세션 위에 프리뷰 프록시 포트로 local forward 를 하나 더 열고
    /// 그 로컬 포트를 돌려준다. WKWebView 는 `http://127.0.0.1:<반환값>/__psproxy__/…` 로 연다.
    ///
    /// - 시뮬레이터 개발 페어링: SSH 가 없고 127.0.0.1 == 호스트 Mac loopback 이라, 프록시
    ///   포트가 그대로 도달한다 → proxyPort 를 그대로 반환.
    /// - 실기기: activeClient(채택된 SSH 채널) 위에 `openForward` 로 direct-tcpip 멀티플렉싱.
    ///   같은 proxyPort 면 캐시 재사용(중복 listener 방지). SSH 미연결이면 nil.
    func openPreviewForward(toProxyPort proxyPort: UInt16) -> UInt16? {
        if DevPairing.daemonPort != nil { return proxyPort }
        if let cached = previewForwards[proxyPort] { return cached }
        guard let client = activeClient else { return nil }
        guard let local = try? client.openForward(toHost: "127.0.0.1", toPort: proxyPort) else { return nil }
        previewForwards[proxyPort] = local
        return local
    }

    /// 현재 채택된 채널의 local forward port — ApiClient/WSClient base URL.
    var currentLocalPort: UInt16? {
        if case .running(let p, _) = state { return p }
        return nil
    }

    /// 현재 채택된 endpoint 의 유형 (UI 라벨용).
    var currentEndpointType: EndpointEntry.EndpointType? {
        if case .running(_, let t) = state { return t }
        return nil
    }

    /// WSClient 가 application-level pong 수신 시점에 호출 — 측정한 RTT 를 EMA 에 반영.
    /// EMA alpha = 0.4 (최근 비중). 첫 측정은 그 값을 그대로 채택.
    func recordRTT(_ ms: Int) {
        let clamped = max(0, min(ms, 5000))
        if let prev = lastRTTms {
            // EMA: next = alpha * sample + (1 - alpha) * prev
            let next = Int(Double(clamped) * 0.4 + Double(prev) * 0.6)
            lastRTTms = next
        } else {
            lastRTTms = clamped
        }
    }

    // MARK: - happy eyeballs

    /// 직접 채널(IPv4/IPv6) SSH 연결 한 번에 허용하는 최대 시간 — 빠른 경로라 짧게.
    private static let directConnectTimeout: TimeInterval = 10
    /// Tor onion 위 SSH 연결 한 번에 허용하는 최대 시간 — introduce+rendezvous 핸드셰이크가
    /// 느려 길게. (`/endpoint` fetch 도 동일하게 30s — `fetchEndpoint` 참고.)
    private static let torConnectTimeout: TimeInterval = 30

    fileprivate struct ConnectResult {
        let localPort: UInt16
        let endpointType: EndpointEntry.EndpointType
        let client: SSHClient
        let host: String
        let port: UInt16
    }

    /// 여러 endpoint candidate 를 RFC 8305 happy eyeballs 로 «병렬» 시도해 첫 성공을 채택.
    ///
    /// priority 오름차순으로 200ms 간격을 두고 connect 를 «출발»시키되, 한 candidate 가
    /// 막혀도 나머지가 동시에 진행한다. 첫 성공이 나머지를 cancel 하고 즉시 반환 — stale
    /// 한 direct endpoint(예: rotate 된 IPv6 temp 주소) 하나가 timeout 까지 채널 전체를
    /// 묶던 «무한 로딩» 회귀를 없앤다. 진 candidate 의 in-flight 연결은 백그라운드에서
    /// 끝난 뒤 스스로 disconnect 한다 (Citadel `connectTimeout` 이 그 시간을 bound).
    ///
    /// 순차 시도였다면 stale ipv6(10s) → ipv4(10s) → … 로 직렬 누적되지만, 병렬이라
    /// 전체 대기 ≈ 가장 빨리 성공하는 candidate 의 시간이다.
    private func tryConnectAll(
        cfg: PairConfig,
        endpoints: [EndpointEntry]
    ) async -> ConnectResult? {
        // Tor onion candidate 는 Tor 가 ready 일 때만 의미. 직접 채널은 Tor 무관.
        // 정렬/필터 규칙은 HappyEyeballsPolicy(순수, 단위 테스트로 고정)에 위임한다.
        let sorted = HappyEyeballsPolicy.order(endpoints, torReady: tor.isReady)
        guard cache.cached != nil, !sorted.isEmpty else { return nil }

        let coord = HappyEyeballsCoordinator()
        return await withCheckedContinuation { (cont: CheckedContinuation<ConnectResult?, Never>) in
            coord.begin(total: sorted.count, continuation: cont)
            for (idx, ep) in sorted.enumerated() {
                let task = Task { @MainActor in
                    // staggered start — 우선순위 높은 candidate 가 200ms 먼저 출발.
                    if idx > 0 {
                        try? await Task.sleep(nanoseconds: UInt64(idx) * 200_000_000)
                    }
                    // 그 사이 다른 candidate 가 이미 이겼으면 연결 시도조차 안 한다.
                    if Task.isCancelled { return }
                    if let result = await self.connectOne(ep: ep, cfg: cfg) {
                        coord.succeed(result)
                    } else {
                        coord.fail()
                    }
                }
                coord.track(task)
            }
        }
    }

    /// 단일 endpoint 한 번 connect 시도. 성공 시 ConnectResult, 실패 시 nil(+로그).
    private func connectOne(ep: EndpointEntry, cfg: PairConfig) async -> ConnectResult? {
        guard let cached = cache.cached else { return nil }
        let client = SSHClient()
        do {
            let opts = SSHClient.ConnectOptions(
                host: ep.host,
                port: ep.port,
                user: cached.sshUser,
                clientPrivPemBase64: cfg.sshClientPriv,
                expectedHostKeyFingerprint: cached.sshHostKeyFingerprint,
                expectedHostKeyOpenSSH: cfg.sshHostKey,
                tofuIdentity: cfg.onion,
                knownHosts: knownHosts,
                daemonHost: "127.0.0.1",
                daemonPort: cached.daemonLocalPort,
                socksProxyPort: ep.type == .torOnion ? tor.currentSocksPort : nil,
                connectTimeout: ep.type == .torOnion ? Self.torConnectTimeout : Self.directConnectTimeout
            )
            let localPort = try await client.connect(opts)
            // SSH 세션·로컬 리스너가 떴다고 끝이 아니다 — directTCPIP 포워딩이 실제로 데몬에
            // 닿는지는 별개다. 캐시된 daemonLocalPort 가 stale(데몬이 포트 충돌로 폴백했다가
            // 다른 포트로 옮김)하면 sshd PermitOpen 화이트리스트에 안 맞아 채널 open 이 거부되고
            // 모든 API/WS 가 죽는다 — 그런데 connect() 는 채널을 inbound 마다 lazy 로만 열어
            // 이 사실을 모른 채 «연결됨» 으로 보고했다(= 화면은 붙었는데 아무것도 안 됨). 비인증
            // GET /health 를 forward 로 1회 쏴, 응답(2xx)이 와야만 채택한다. 거부면 inbound 소켓이
            // 즉시 끊겨 transport 에러로 빨리 실패 → 상위 connectImpl 이 fresh /endpoint 재조회로
            // 올바른 포트를 받아 자동 복구한다(캐시만 믿고 stale 포트에 영원히 묶이던 회귀 차단).
            let probeTimeout: TimeInterval =
                ep.type == .torOnion ? Self.torConnectTimeout : Self.directConnectTimeout
            guard await probeForwardHealth(localPort: localPort, timeout: probeTimeout) else {
                NSLog("[ConnMgr] %@ %@:%d 연결됐으나 forward 헬스 프로브 실패 — 후보 폐기(stale 데몬 포트 의심)",
                      ep.type.rawValue, ep.host, ep.port)
                client.disconnect()
                return nil
            }
            return ConnectResult(
                localPort: localPort,
                endpointType: ep.type,
                client: client,
                host: ep.host,
                port: ep.port
            )
        } catch {
            if case SSHClient.SSHError.hostKeyMismatch = error {
                // 직접 채널 host key 불일치 — MITM 의심. 전부 실패 시 메시지 분기에 반영.
                sawHostKeyMismatch = true
            }
            NSLog("[ConnMgr] %@ %@:%d failed — %@",
                  ep.type.rawValue, ep.host, ep.port, error.localizedDescription)
            client.disconnect()
            return nil
        }
    }

    /// 연결 직후 «포워딩이 실제로 데몬에 닿는지» 1회 검증한다 — 비인증 `GET /health`.
    /// 로컬 forward 포트(127.0.0.1)로 직접 쏜다: SOCKS/프록시 불필요(SSH 채널 자체가 전송 계층)라
    /// 직접·onion 채널 공통이다. directTCPIP 가 sshd PermitOpen 에서 거부되면 SSHClient 가 inbound
    /// 소켓을 즉시 cancel 해 transport 에러로 빨리 false 가 된다. `/health` 는 인증 미들웨어 앞단의
    /// 비인증 라우트라 attest 토큰·클라이언트 버전 헤더 없이도 200 → forward 정상 판정에 적합하다.
    private func probeForwardHealth(localPort: UInt16, timeout: TimeInterval) async -> Bool {
        guard let url = URL(string: "http://127.0.0.1:\(localPort)/health") else { return false }
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = timeout
        config.timeoutIntervalForResource = timeout
        config.waitsForConnectivity = false
        let session = URLSession(configuration: config)
        defer { session.invalidateAndCancel() }
        do {
            let (_, resp) = try await session.data(from: url)
            return ((resp as? HTTPURLResponse)?.statusCode).map { (200..<300).contains($0) } ?? false
        } catch {
            NSLog("[ConnMgr] forward 헬스 프로브 실패 (localPort=%d): %@",
                  Int(localPort), error.localizedDescription)
            return false
        }
    }

    // MARK: - /endpoint fetch (over Tor)

    /// Tor 위에서 daemon `http://<onion>/endpoint` 호출.
    private func fetchEndpoint(cfg: PairConfig) async -> EndpointConfig? {
        guard let socksPort = tor.currentSocksPort else { return nil }
        guard let url = URL(string: "http://\(cfg.onion)/endpoint") else { return nil }

        let config = URLSessionConfiguration.default
        config.connectionProxyDictionary = [
            kCFProxyTypeKey as String: kCFProxyTypeSOCKS,
            kCFStreamPropertySOCKSProxyHost as String: "127.0.0.1",
            kCFStreamPropertySOCKSProxyPort as String: Int(socksPort),
            kCFStreamPropertySOCKSVersion as String: kCFStreamSocketSOCKSVersion5,
        ]
        config.timeoutIntervalForRequest = 30
        let session = URLSession(configuration: config)
        defer { session.invalidateAndCancel() }

        var req = URLRequest(url: url)
        req.setValue("Bearer \(cfg.endpointToken)", forHTTPHeaderField: "Authorization")

        do {
            let (data, resp) = try await session.data(for: req)
            guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                NSLog("[ConnMgr] /endpoint non-2xx response")
                return nil
            }
            let decoder = JSONDecoder()
            decoder.dateDecodingStrategy = .iso8601
            return try decoder.decode(EndpointConfig.self, from: data)
        } catch {
            NSLog("[ConnMgr] /endpoint fetch failed: %@", error.localizedDescription)
            return nil
        }
    }
}

/// happy eyeballs 병렬 시도의 «첫 성공 채택 / 나머지 cancel» 조율자.
///
/// ConnectionManager 와 같은 MainActor isolation 이라 내부 상태 접근은 직렬 — 경합 없음.
/// (SSHClient 의 `ConnectTimeoutFlag` 와 동일한 1-isolation 박스 패턴.) continuation 은
/// `succeed`/`fail` 중 정확히 한 번만 resume 된다.
@MainActor
private final class HappyEyeballsCoordinator {
    private var resumed = false
    private var remaining = 0
    private var siblings: [Task<Void, Never>] = []
    private var continuation: CheckedContinuation<ConnectionManager.ConnectResult?, Never>?

    func begin(
        total: Int,
        continuation: CheckedContinuation<ConnectionManager.ConnectResult?, Never>
    ) {
        self.remaining = total
        self.continuation = continuation
    }

    func track(_ task: Task<Void, Never>) { siblings.append(task) }

    /// 한 candidate 성공. 첫 성공이면 나머지 cancel + resume, 이미 승자가 있으면 drop.
    func succeed(_ result: ConnectionManager.ConnectResult) {
        guard !resumed else {
            // 늦은 2번째 성공 — 채택 안 하고 정리한다.
            result.client.disconnect()
            return
        }
        resumed = true
        for t in siblings { t.cancel() }
        NSLog("[ConnMgr] adopted endpoint type=%@ host=%@:%d localPort=%d",
              result.endpointType.rawValue, result.host, result.port, result.localPort)
        continuation?.resume(returning: result)
        continuation = nil
    }

    /// 한 candidate 실패. 전부 실패했고 승자가 없으면 nil 로 resume.
    func fail() {
        remaining -= 1
        if remaining <= 0 && !resumed {
            resumed = true
            continuation?.resume(returning: nil)
            continuation = nil
        }
    }
}
