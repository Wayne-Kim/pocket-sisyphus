import Foundation
import Network
import Citadel
import NIO
import NIOCore
import NIOSSH
import Crypto

/// Citadel (swift-nio-ssh wrapper) 기반 SSH client + local TCP forwarding listener.
///
/// ## 듀얼 채널 모델에서의 역할
/// ConnectionManager 가 endpoint 배열을 happy eyeballs 로 시도할 때 candidate 마다 SSHClient
/// 한 인스턴스를 만들어 connect 시도. 첫 성공이 채택되고 나머지는 disconnect.
///
/// ## SSH local port forwarding 구현
/// Citadel `createDirectTCPIPChannel` 로 direct-tcpip channel open. Citadel 이 자동으로
/// `DataToBufferCodec` 을 채널 pipeline 에 추가 — channel 의 inbound 는 ByteBuffer.
/// 우리 `NWConnectionBridge` 가 NWConnection ↔ ByteBuffer 양방향 매핑.
///
/// ## host key 검증 (`TOFUHostKeyValidator`)
/// 모든 채널을 NIOSSH 표준 fingerprint API 위의 custom validator 로 검증한다. 우선순위:
///   1. pinned key (`cfg.sshHostKey` 완전 공개키) 정확 일치,
///   2. 신뢰 fingerprint (`expectedHostKeyFingerprint` — pairing QR/onion `/endpoint` 로 전달) 대조,
///   3. anchor 가 전혀 없을 때만 순수 TOFU (`KnownHostStore` 장부).
/// onion 채널은 Tor 가 이미 onion 주소(=공개키 hash)로 신원을 보장하지만 같은 sshd host key 를
/// 직접/onion 이 공유하므로 검증이 무해하게 통과한다. 직접 채널(IPv4/IPv6)은 그 cryptographic
/// 보호가 없어 적대적 LAN/Wi-Fi 에서 daemon 가장(MITM)의 여지였는데, 이 검증이 닫는다.
/// 불일치는 `SSHError.hostKeyMismatch` 로 거부 — 서버 위장 신호.
/// connect / timeout Task 사이에서 «시간 초과로 취소됐는지» 를 공유하는 1비트 박스.
/// 두 Task 와 SSHClient 가 모두 MainActor isolation 이라 직렬 접근 — 경합 없음.
@MainActor private final class ConnectTimeoutFlag {
    var didTimeout = false
}

@MainActor
final class SSHClient {

    enum SSHError: LocalizedError {
        case connectFailed(String)
        case authFailed
        case forwardListenerFailed(String)
        case channelOpenFailed(String)
        case alreadyConnected
        case notConnected
        case timeout(TimeInterval)
        /// host key 가 신뢰된 fingerprint/장부와 불일치 — 서버 위장(MITM) 의심. 연결 거부.
        case hostKeyMismatch

        var errorDescription: String? {
            switch self {
            case .connectFailed(let m): return String(localized: "SSH 연결 실패: \(m)")
            case .authFailed:            return String(localized: "SSH 인증 실패 (키 불일치)")
            case .hostKeyMismatch:
                return String(localized: "SSH host key 불일치 — 신뢰할 수 없는 서버 (중간자 공격 가능성)")
            case .forwardListenerFailed(let m):
                return String(localized: "SSH local listener 시작 실패: \(m)")
            case .channelOpenFailed(let m):
                return String(localized: "SSH channel open 실패: \(m)")
            case .alreadyConnected:      return String(localized: "이미 SSH 세션이 떠 있습니다")
            case .notConnected:          return String(localized: "SSH 세션이 없습니다")
            case .timeout(let s):
                let secs = Int(s)
                return String(localized: "SSH 연결 시간 초과 (\(secs)초)")
            }
        }
    }

    /// Connect 입력. host/port 는 endpoint candidate (직접 또는 Tor onion).
    struct ConnectOptions {
        let host: String
        let port: UInt16
        let user: String
        let clientPrivPemBase64: String       // PairConfig.sshClientPriv
        /// "SHA256:..." — pairing QR/onion `/endpoint` 로 전달된 신뢰 fingerprint. host key
        /// 검증의 1차 anchor (TOFUHostKeyValidator §2). 표시/진단에도 쓰인다.
        let expectedHostKeyFingerprint: String
        /// sshd host 공개키 한 줄 ("ssh-ed25519 AAAA..."). 있으면 정확 일치 핀(가장 강한 anchor).
        /// nil(구버전 페어링)이면 fingerprint anchor → 그것도 없으면 순수 TOFU 로 강등.
        let expectedHostKeyOpenSSH: String?
        /// TOFU 장부 키 — 이 Mac 의 onion 주소. 직접 endpoint IP 는 회전해도 host key 는 영구라
        /// onion 으로 묶어 IP 변경에 무관한 신뢰 레코드를 재사용한다.
        let tofuIdentity: String
        /// 검증 통과/불일치 fingerprint 를 영속하는 TOFU 장부 (onion→"SHA256:...").
        let knownHosts: KnownHostStore
        let daemonHost: String                // 보통 "127.0.0.1"
        let daemonPort: UInt16                // daemon HTTP/WS local listening port
        /// Tor SOCKS5 proxy port — endpoint.type == tor_onion 일 때만 non-nil.
        /// 1차 구현은 직접 채널 우선 — SOCKS5 over swift-nio bridge 는 향후.
        let socksProxyPort: UInt16?
        /// 이 candidate 한 번의 connect 시도에 허용하는 최대 시간(초). 직접 채널(IPv4/IPv6)은
        /// 빠르므로 짧게(10s), Tor onion 은 introduce+rendezvous 핸드셰이크가 느려 길게(30s).
        /// ConnectionManager 가 endpoint 타입에 따라 지정한다. 초과하면 in-flight 연결을
        /// 취소하고 SSHError.timeout 을 던져 happy eyeballs 가 다음 candidate 로 넘어가게 한다.
        let connectTimeout: TimeInterval
    }

    private(set) var client: Citadel.SSHClient?
    private var localListener: NWListener?
    private(set) var localPort: UInt16?
    /// 데몬 포워딩 외 «추가» local forward (예: 라이브 미리보기 리버스 프록시 포트).
    /// 같은 SSH 세션 위에 direct-tcpip 채널을 멀티플렉싱한다. disconnect 시 함께 정리.
    private var extraListeners: [NWListener] = []
    private var activeChannels: [Channel] = []

    func connect(_ opts: ConnectOptions) async throws -> UInt16 {
        guard client == nil else { throw SSHError.alreadyConnected }

        // PKCS8 ed25519 PEM base64 → 32B raw seed → Curve25519.Signing.PrivateKey.
        guard let pemData = Data(base64Encoded: opts.clientPrivPemBase64),
              let pem = String(data: pemData, encoding: .utf8) else {
            throw SSHError.authFailed
        }
        let privKey = try ed25519PrivateKeyFromPEM(pem)
        let authMethod = SSHAuthenticationMethod.ed25519(username: opts.user, privateKey: privKey)

        // host key 검증 — NIOSSH 표준 fingerprint API 위의 TOFU + 핀(우선순위는 validator 주석).
        // 완전 공개키가 있으면 정확 일치 핀, 없으면 신뢰 fingerprint 대조, 그것도 없으면 순수 TOFU.
        // 불일치(MITM 의심)면 verdict 에 기록되고 promise fail → connect 가 던진다.
        let pinnedKey: NIOSSHPublicKey? = {
            guard let line = opts.expectedHostKeyOpenSSH, !line.isEmpty else { return nil }
            return try? NIOSSHPublicKey(openSSHPublicKey: line)
        }()
        let verdict = TOFUHostKeyValidator.Verdict()
        let validator = SSHHostKeyValidator.custom(TOFUHostKeyValidator(
            identity: opts.tofuIdentity,
            pinnedKey: pinnedKey,
            expectedFingerprint: opts.expectedHostKeyFingerprint,
            knownHosts: opts.knownHosts,
            verdict: verdict
        ))

        do {
            client = try await connectWithTimeout(opts, authMethod: authMethod, validator: validator)
        } catch let err as SSHError {
            throw err
        } catch {
            // connect 실패가 host key 불일치 때문이면 (검증 스레드가 promise 를 fail) 일반 연결
            // 실패와 구분해 던진다 — UI 가 «서버 위장» 을 별도로 안내할 수 있게.
            if verdict.mismatch != nil { throw SSHError.hostKeyMismatch }
            throw SSHError.connectFailed("\(opts.host):\(opts.port) — \(error.localizedDescription)")
        }

        let lp = try startLocalListener(daemonHost: opts.daemonHost, daemonPort: opts.daemonPort)
        self.localPort = lp
        return lp
    }

    /// Citadel 연결을 `opts.connectTimeout` 안에 끝나도록 강제한다.
    ///
    /// **실제 timeout 은 Citadel(NIO) 의 socket-level `connectTimeout` 이 건다** — 아래
    /// `connectTask.cancel()` 은 Swift Task 취소인데 Citadel 의 `EventLoopFuture.get()`
    /// 브리지는 Task 취소를 «관측하지 않아» 그것만으론 in-flight TCP 연결을 못 끊는다.
    /// (그래서 `connectTimeout:` 인자를 반드시 넘긴다 — 안 넘기면 Citadel 기본값 30초가
    /// 적용돼, rotate 된 IPv6 같은 stale endpoint 에 30초씩 묶이던 «무한 로딩» 회귀.)
    /// 그 위에 Task race 를 한 겹 더 둬서, 취소가 통하는 경로(상위 happy-eyeballs 가
    /// sibling 을 cancel) 에선 `SSHError.timeout` 으로 더 빠르게 확정한다. 직접 채널은
    /// 10초, Tor onion 은 introduce+rendezvous 가 느려 30초.
    ///
    /// connect / timeout 두 Task 모두 `@MainActor` 로 띄워 SSHClient 와 같은 isolation 에
    /// 둔다 — 결과(Citadel.SSHClient, non-Sendable) 가 actor 경계를 넘지 않아 Sendable
    /// 경고 없이 깔끔하다.
    private func connectWithTimeout(
        _ opts: ConnectOptions,
        authMethod: SSHAuthenticationMethod,
        validator: SSHHostKeyValidator
    ) async throws -> Citadel.SSHClient {
        let connectTask = Task { @MainActor in
            try await Citadel.SSHClient.connect(
                host: opts.host,
                port: Int(opts.port),
                authenticationMethod: authMethod,
                hostKeyValidator: validator,
                reconnect: .never,
                connectTimeout: .seconds(Int64(opts.connectTimeout))
            )
        }
        let flag = ConnectTimeoutFlag()
        let timeoutTask = Task { @MainActor in
            try await Task.sleep(nanoseconds: UInt64(opts.connectTimeout * 1_000_000_000))
            flag.didTimeout = true
            connectTask.cancel()
        }
        defer { timeoutTask.cancel() }

        do {
            return try await connectTask.value
        } catch {
            if flag.didTimeout { throw SSHError.timeout(opts.connectTimeout) }
            throw error
        }
    }

    func disconnect() {
        localListener?.cancel()
        localListener = nil
        localPort = nil
        for l in extraListeners { l.cancel() }
        extraListeners.removeAll()
        for ch in activeChannels {
            ch.close(promise: nil)
        }
        activeChannels.removeAll()
        let c = client
        client = nil
        Task {
            try? await c?.close()
        }
    }

    var isConnected: Bool { client != nil }

    // MARK: - Local TCP listener → SSH direct-tcpip

    private func startLocalListener(daemonHost: String, daemonPort: UInt16) throws -> UInt16 {
        let (listener, port) = try makeForwardListener(targetHost: daemonHost, targetPort: daemonPort)
        self.localListener = listener
        return port
    }

    /// 같은 SSH 세션 위에 «추가» local forward 한 개를 더 연다 — 다른 Mac 포트(예: 라이브
    /// 미리보기 리버스 프록시 127.0.0.1:7779)로 direct-tcpip 를 멀티플렉싱. 반환된 로컬 포트의
    /// 127.0.0.1 트래픽이 그 Mac 포트로 포워딩된다. 데몬 PermitOpen 화이트리스트에 그 Mac
    /// 포트가 들어 있어야 sshd 가 채널을 연다(아니면 채널 open 실패). disconnect 시 함께 정리.
    func openForward(toHost: String, toPort: UInt16) throws -> UInt16 {
        guard client != nil else { throw SSHError.notConnected }
        let (listener, port) = try makeForwardListener(targetHost: toHost, targetPort: toPort)
        extraListeners.append(listener)
        return port
    }

    /// 로컬 NWListener 한 개를 띄워 incoming TCP 마다 `targetHost:targetPort` 로 direct-tcpip
    /// 채널을 연다. 데몬 포워딩과 추가 포워딩이 공유. bind 될 때까지 짧게 폴링해 로컬 포트 반환.
    private func makeForwardListener(targetHost: String, targetPort: UInt16) throws -> (NWListener, UInt16) {
        let params = NWParameters.tcp
        params.acceptLocalOnly = true
        let listener: NWListener
        do {
            listener = try NWListener(using: params, on: .any)
        } catch {
            throw SSHError.forwardListenerFailed(error.localizedDescription)
        }

        listener.newConnectionHandler = { [weak self] inbound in
            // listener callback 은 non-MainActor 라 self.client 직접 접근 불가 — Task 안에서 hop.
            Task { @MainActor [weak self] in
                guard let self = self, let client = self.client else {
                    inbound.cancel()
                    return
                }
                await self.handleInbound(
                    inbound, via: client, targetHost: targetHost, targetPort: targetPort
                )
            }
        }
        listener.start(queue: DispatchQueue.global(qos: .userInitiated))

        for _ in 0..<50 {
            if case .ready = listener.state, let p = listener.port?.rawValue {
                return (listener, p)
            }
            Thread.sleep(forTimeInterval: 0.02)
        }
        if let p = listener.port?.rawValue { return (listener, p) }
        throw SSHError.forwardListenerFailed("listener never bound")
    }

    /// inbound TCP 한 connection 마다 direct-tcpip channel 한 개 — 양방향 byte copy.
    private func handleInbound(
        _ inbound: NWConnection,
        via client: Citadel.SSHClient,
        targetHost: String,
        targetPort: UInt16
    ) async {
        do {
            let originator = try SocketAddress(ipAddress: "127.0.0.1", port: 0)
            let channel: Channel = try await client.createDirectTCPIPChannel(
                using: SSHChannelType.DirectTCPIP(
                    targetHost: targetHost,
                    targetPort: Int(targetPort),
                    originatorAddress: originator
                )
            ) { proxyChannel in
                // Citadel 이 이미 DataToBufferCodec 을 추가했음 — inbound/outbound 는 ByteBuffer.
                proxyChannel.pipeline.addHandler(
                    NWConnectionBridge(inbound: inbound)
                )
            }
            activeChannels.append(channel)
            channel.closeFuture.whenComplete { [weak self] _ in
                Task { @MainActor in
                    self?.activeChannels.removeAll(where: { $0 === channel })
                    inbound.cancel()
                }
            }
        } catch {
            NSLog("[SSH] direct-tcpip 실패: %@", error.localizedDescription)
            inbound.cancel()
        }
    }

    // MARK: - ed25519 PEM 파싱

    /// PKCS8 ed25519 PEM ("-----BEGIN PRIVATE KEY-----\n<base64>\n-----END...") 의 raw 32B seed
    /// 추출 → `Curve25519.Signing.PrivateKey` 생성.
    /// PKCS8 ed25519 DER 의 마지막 32바이트 = raw seed.
    private func ed25519PrivateKeyFromPEM(_ pem: String) throws -> Curve25519.Signing.PrivateKey {
        let stripped = pem
            .replacingOccurrences(of: "-----BEGIN PRIVATE KEY-----", with: "")
            .replacingOccurrences(of: "-----END PRIVATE KEY-----", with: "")
            .replacingOccurrences(of: "\n", with: "")
            .replacingOccurrences(of: "\r", with: "")
            .trimmingCharacters(in: .whitespaces)
        guard let der = Data(base64Encoded: stripped), der.count >= 32 else {
            throw SSHError.authFailed
        }
        let seed = der.suffix(32)
        return try Curve25519.Signing.PrivateKey(rawRepresentation: seed)
    }
}

// MARK: - NWConnection ↔ NIO Channel bridge

/// NIO Channel 의 inbound ByteBuffer → NWConnection.send. NWConnection 의 receive 도 같이
/// 시작해 channel 로 writeAndFlush. Citadel 이 자동 추가한 `DataToBufferCodec` 가 ByteBuffer
/// 양쪽으로 wrap/unwrap 처리.
final class NWConnectionBridge: ChannelInboundHandler, @unchecked Sendable {
    typealias InboundIn = ByteBuffer
    typealias OutboundOut = ByteBuffer

    private let inbound: NWConnection
    private var didStartReceive = false
    /// ByteBufferAllocator 는 thread-safe (Sendable). channel pipeline 의 allocator 와 동일
    /// 동작 — channel.allocator 접근이 eventLoop.assertInEventLoop() 를 trigger 해서 NWConnection
    /// callback (random queue) 안에서 접근 시 crash. 자체 인스턴스로 우회.
    private let allocator = ByteBufferAllocator()

    init(inbound: NWConnection) {
        self.inbound = inbound
    }

    func channelActive(context: ChannelHandlerContext) {
        // inbound NWConnection 시작 + receive loop 개시.
        let ctx = context
        inbound.stateUpdateHandler = { [weak self] state in
            guard let self = self else { return }
            switch state {
            case .ready:
                if !self.didStartReceive {
                    self.didStartReceive = true
                    self.startReceiveLoop(context: ctx)
                }
            case .failed, .cancelled:
                ctx.eventLoop.execute {
                    ctx.close(promise: nil)
                }
            default:
                break
            }
        }
        inbound.start(queue: DispatchQueue.global(qos: .userInitiated))
        context.fireChannelActive()
    }

    private func startReceiveLoop(context: ChannelHandlerContext) {
        let ctx = context
        inbound.receive(minimumIncompleteLength: 1, maximumLength: 32 * 1024) {
            [weak self] data, _, isComplete, error in
            guard let self = self else { return }
            if let data = data, !data.isEmpty {
                // allocator 는 self 의 stored property — channel.allocator 접근 회피 (EventLoop 외부).
                var buf = self.allocator.buffer(capacity: data.count)
                buf.writeBytes(data)
                ctx.eventLoop.execute {
                    ctx.writeAndFlush(self.wrapOutboundOut(buf), promise: nil)
                }
            }
            if isComplete || error != nil {
                ctx.eventLoop.execute {
                    ctx.close(promise: nil)
                }
                return
            }
            self.startReceiveLoop(context: ctx)
        }
    }

    func channelRead(context: ChannelHandlerContext, data: NIOAny) {
        var buf = unwrapInboundIn(data)
        guard let bytes = buf.readBytes(length: buf.readableBytes) else { return }
        let payload = Data(bytes)
        inbound.send(content: payload, completion: .contentProcessed { _ in })
    }

    func channelInactive(context: ChannelHandlerContext) {
        inbound.cancel()
        context.fireChannelInactive()
    }

    func errorCaught(context: ChannelHandlerContext, error: Error) {
        NSLog("[SSH] channel error: %@", String(describing: error))
        context.close(promise: nil)
    }
}
