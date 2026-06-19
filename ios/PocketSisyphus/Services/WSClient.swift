import Foundation

/// daemon `/ws` 와의 push 채널.
///
/// ## 왜 WS 인가
/// 폴링(1.5s) → Tor 라운드트립 × N. 한 turn 동안 토큰이 100개 흐르면 100번 정도의
/// "다음 폴링 cycle 대기" 가 누적된다. WS 는 한 번 회로 위에 stream 을 열어두고
/// 서버가 push 만 하므로 latency ≈ Tor 1-way ≈ ~수백 ms.
///
/// ## 역할 분담
/// - **WS**: 새 이벤트 발생을 즉시 알린다 (push 신호). 페이로드 자체는 신뢰하지 않는다.
/// - **HTTP poll**: 신호를 받으면 한 번에 권위있는 상태를 fetch (`pollSession`).
///
/// 페이로드를 직접 신뢰하지 않는 이유: WS 가 끊겼다 다시 붙는 동안 누락된 이벤트가
/// 있을 수 있고, 그걸 보상하려면 결국 어딘가에서 catch-up fetch 가 필요하다. push 를
/// "신호" 로만 쓰고 상태는 항상 HTTP 로 동기화하면 reconnect 로직이 단순해진다.
///
/// ## Tor 위에서의 동작
/// URLSessionWebSocketTask 는 같은 URLSessionConfiguration 의 connectionProxyDictionary
/// 를 따른다. ApiClient 가 쓰는 SOCKS5 설정과 동일하게 묶으면 같은 회로 위에 stream
/// 으로 multiplex 된다.
/// daemon 이 보고하는 활성 디스플레이 한 개(멀티모니터 선택). index 가 daemon 으로 보낼 선택 키.
struct ScreenDisplay: Identifiable, Hashable {
    let index: Int
    let main: Bool
    let width: Int
    let height: Int
    var id: Int { index }
}

/// daemon(헬퍼)이 보고하는 화면에 보이는 창 한 개 — «캡처 대상» 피커 항목
/// (screen_window_target_v1). id 는 CGWindowID — capture_set_window 로 보낼 선택 키.
struct ScreenWindow: Identifiable, Hashable {
    let id: Int
    let app: String
    let title: String
    let width: Int
    let height: Int

    /// 피커 표시명 — 앱 이름 + (있으면) 창 제목. 제목이 길면 잘라 메뉴 폭을 지킨다.
    var displayName: String {
        let t = title.trimmingCharacters(in: .whitespaces)
        guard !t.isEmpty, t != app else { return app }
        let short = t.count > 28 ? String(t.prefix(28)) + "…" : t
        return "\(app) — \(short)"
    }

    /// 앱별 그룹(헤더=앱명) 안에서 보여줄 창 제목 — 비었거나 앱명과 같으면 앱명으로 폴백.
    var titleLabel: String {
        let t = title.trimmingCharacters(in: .whitespaces)
        return t.isEmpty ? app : t
    }
}

@MainActor
final class WSClient {
    /// 서버 hub 에서 broadcast 하는 이벤트 type. runner.ts / pty-runner.ts 의 session-scoped
    /// 이벤트만 처리한다. 페이로드는 신호로만 쓰지만, pty_output 만 raw bytes + id 를 본문에서 꺼낸다.
    enum Event {
        // session-scoped (runner.ts)
        case userMessage
        case stream
        case turnComplete
        case error(message: String)

        // PTY 모드 (pty-runner.ts)
        /// PTY 한 청크 — raw bytes 그대로. SwiftTerm.TerminalView 에 feed 하여
        /// claude REPL 화면을 정확히 재현한다.
        /// `id` 는 daemon 의 messages 테이블 row id 와 동일 — polling 으로 같은 row 가
        /// 다시 도착해도 ChatViewModel.seenMessageIds 가 dedup 한다.
        case ptyOutput(id: String, bytes: Data)
        /// PTY 프로세스 종료.
        case ptyExit(exitCode: Int?, signal: Int?)

        // 네이티브 화면 캡처 (capture/sidecar.ts)
        /// 화면 캡처 프레임 한 장 — JPEG bytes. RemoteScreenView 가 렌더 (jpeg 코덱/폴백).
        case screenFrame(jpeg: Data, ts: Int64)
        /// H.264 비디오 데이터 — 바이너리 프레임 `[1B type][...]` (type 1=SPS/PPS, 2=AVCC AU).
        /// RemoteScreenView 의 MirrorRenderer 가 AVSampleBufferDisplayLayer 로 직접 렌더(고fps 경로).
        case screenVideo(payload: Data)
        /// 캡처 상태 — running + 실패 사유(권한/spawn 등).
        case captureStatus(running: Bool, reason: String?)
        /// 활성 디스플레이 목록 — 멀티모니터일 때 폰에서 고를 수 있게 daemon 이 보고.
        case captureDisplays(displays: [ScreenDisplay])
        /// 화면에 보이는 창 목록 — «캡처 대상» 피커 데이터(screen_window_target_v1).
        case captureWindows(windows: [ScreenWindow])
        /// 현재 캡처 대상 — windowId(0=전체 화면) + 폴백 사유(window_closed 등). 헬퍼가 창 타겟
        /// 적용/폴백 시 보고 → iOS 선택 상태 동기화 + 닫힘 캡슐 안내.
        case captureTarget(windowId: Int, reason: String?)
        /// 원격 제어(손쉬운 사용) 권한 상태 — enabled=false + reason 이면 «보기는 되나 조작 막힘».
        /// 캡처(보기)와 분리: 화면은 보이는데 입력 주입만 거부될 때 별도 캡슐로 안내한다.
        case controlStatus(enabled: Bool, reason: String?)

        /// 글로벌(세션 무관) 수명주기 이벤트 — daemon 의 `broadcastAll({type:"session_event"})`.
        /// 어느 세션이든 «입력/승인 대기 진입»(kind=waiting) / «대기 해제»(kind=resolved) 를
        /// 모든 클라이언트에게 알린다. AgentWaitNotifier(글로벌 WSClient)가 이걸로 actionable
        /// 로컬 알림을 띄우고 정리한다. 세션 스코프 클라이언트(ChatViewModel)는 무시한다.
        case sessionEvent(kind: String, sessionId: String, repoName: String?, title: String?, agentName: String?, preview: String?)

        case unknown(type: String)
    }

    typealias EventHandler = @MainActor (Event) -> Void

    private let auth: AuthStore
    private let conn: ConnectionManager
    /// nil 이면 subscribe 메시지를 보내지 않고 broadcastAll 만 받는다 (global 채널).
    /// session-scoped 인 경우 해당 sessionId 로 attachToSession 등록.
    private let sessionId: String?
    private let onEvent: EventHandler
    /// WS 연결/끊김 전이를 알리는 선택적 콜백. ChatViewModel 이 «입력 전송 실패» 배너를
    /// 재연결 성공 시 자동 해제하는 데 쓴다(나머지 소비자는 nil — 동작 영향 없음).
    /// connected=true 는 subscribe 까지 성공해 송신 가능한 상태, false 는 끊김/재연결 진입.
    private let onConnectionChange: (@MainActor (Bool) -> Void)?
    /// onConnectionChange 중복 발화 방지 — 같은 값 연속 통보를 누른다.
    private var lastReportedConnected: Bool?

    private var task: URLSessionWebSocketTask?
    /// reconnect 루프 동작 중인지. stop() 으로만 false 가 된다.
    private var running: Bool = false
    /// 백오프 — 첫 실패는 즉시, 이후 지수 증가, 최대 30s.
    private var reconnectAttempt: Int = 0
    /// 현재 연결에 대한 ping 루프 task. 연결마다 새로 spawn, 끊기면 cancel.
    private var pingTask: Task<Void, Never>?
    /// application-level ping 의 send 시각 (ms epoch) — pong 수신 시 RTT 계산용.
    /// 키 = ping 시 박은 t 값, 값 = 동일 (key 만 있어도 되지만 명시성 위해).
    /// stale 항목은 다음 ping 사이클에서 덮어쓰기 — 굳이 GC 안 함.
    private var pendingPings: [Int64: Int64] = [:]
    /// 백오프 sleep 을 외부에서 즉시 깨우기 위한 wake 슬롯.
    /// kick() 이 wake() 를 호출해서 다음 reconnect 시도가 백오프 대기 없이 일어난다.
    /// foreground 복귀 직후 서버측 idle timeout 으로 끊긴 WS 회복용.
    private let wakeBox = WakeBox()

    /// 앱이 foreground 에서 이 세션을 «보는 중» 인지. scenePhase 미러링 (ChatView →
    /// ChatViewModel.setForeground → 여기). daemon 에 `visibility` 메시지로 전달돼
    /// away-gating 을 제어한다 — background 면 false → daemon 이 Discord 알림을 다시
    /// 내보낸다 (소켓은 OPEN 이어도 사용자가 화면을 안 보는 상태). 연결/재연결 직후
    /// subscribe 다음에 현재 값을 한 번 송신해 daemon 상태를 동기화한다.
    private var foreground: Bool = true

    /// process-wide URLSession 캐시. 듀얼 채널 모델에선 SSH local forward port 가 base 라
    /// SOCKS proxy 불필요. ConnectionManager 가 채택한 채널의 local port 가 바뀌면 재생성.
    private static var sharedSession: URLSession?
    private static var sharedSessionPort: UInt16?

    private static func makeOrReuseSession(localPort: UInt16) -> URLSession {
        if let s = sharedSession, sharedSessionPort == localPort {
            return s
        }
        sharedSession?.invalidateAndCancel()
        let config = URLSessionConfiguration.default
        // SSH local forward 직행 — SOCKS proxy 제거.
        config.timeoutIntervalForRequest = 30
        config.timeoutIntervalForResource = 0
        let s = URLSession(configuration: config)
        sharedSession = s
        sharedSessionPort = localPort
        return s
    }

    /// subscribe 메시지에 실어 보낼 «마지막으로 본 created_at» 을 동적으로 알려주는 provider.
    /// daemon 이 그 값 이후의 pty_chunk 를 즉시 backfill 한다 (ws_catchup_v1 capability).
    /// nil 이거나 0 반환이면 catch-up skip — 초기 진입 시점 (아직 본 게 없을 때) 의 동작.
    private let sinceProvider: (() -> Int64?)?

    init(
        auth: AuthStore,
        conn: ConnectionManager,
        sessionId: String?,
        sinceProvider: (() -> Int64?)? = nil,
        onConnectionChange: (@MainActor (Bool) -> Void)? = nil,
        onEvent: @escaping EventHandler,
    ) {
        self.auth = auth
        self.conn = conn
        self.sessionId = sessionId
        self.sinceProvider = sinceProvider
        self.onConnectionChange = onConnectionChange
        self.onEvent = onEvent
    }

    /// 연결 상태 전이를 한 번만 통보 — 같은 값 연속 호출은 무시(깜빡임 유발 방지).
    private func reportConnection(_ connected: Bool) {
        guard lastReportedConnected != connected else { return }
        lastReportedConnected = connected
        onConnectionChange?(connected)
    }

    func start() {
        if running { return }
        running = true
        Task { [weak self] in
            await self?.runLoop()
        }
    }

    func stop() {
        running = false
        pingTask?.cancel()
        pingTask = nil
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        reportConnection(false)
        // 백오프 sleep 에 잠들어 있다면 깨워 runLoop 가 빠져나가게 한다.
        wakeBox.wake()
        // sharedSession 은 의도적으로 invalidate 하지 않음 — 다른 WSClient 인스턴스나
        // 같은 인스턴스의 재시작이 같은 connection pool 을 그대로 쓰게 한다.
    }

    /// 외부에서 백오프를 건너뛰고 즉시 reconnect 를 시도하게 한다.
    /// foreground 복귀 직후 — 서버측 idle timeout 으로 WS 가 끊겼을 가능성이 높지만
    /// 클라이언트는 아직 receive() 에서 에러를 못 받았거나 backoff sleep 안일 수 있어
    /// 다음 폴링 cycle 까지 사용자 기다리지 않게 강제로 깨운다.
    func kick() {
        NSLog("[WSClient] kick — 백오프 건너뛰고 즉시 reconnect")
        reconnectAttempt = 0
        // 현재 task 가 살아있으면 강제 cancel — receive() 가 즉시 에러로 풀리고
        // runLoop 가 backoffAndCleanup → wake 경로로 흘러간다.
        task?.cancel(with: .goingAway, reason: nil)
        // 이미 backoff sleep 중이면 즉시 탈출.
        wakeBox.wake()
    }

    /// connect → subscribe → receive 루프. 끊기면 백오프 후 재시도.
    private func runLoop() async {
        while running {
            // ConnectionManager 가 채택한 채널이 ready 인지 확인.
            guard let cfg = auth.config,
                  let localPort = conn.currentLocalPort else {
                try? await Task.sleep(nanoseconds: 500_000_000)
                continue
            }
            // SSH local forward 위 daemon WS — base URL 은 항상 127.0.0.1.
            guard var comps = URLComponents(string: "ws://127.0.0.1:\(localPort)/ws") else {
                try? await Task.sleep(nanoseconds: 500_000_000)
                continue
            }
            // 토큰 query 로 인증 (server.ts 의 verifyWsToken 가 ?token= 검사).
            // WS 는 헤더를 못 붙이므로 Secure Enclave 기기 인증 토큰도 query(?attest=)로 싣는다.
            // 캐시된 유효 토큰이 있을 때만 — 없으면(미등록/옛 daemon) daemon soft 모드가 통과.
            // 등록된 daemon 인데 토큰이 아직 없으면 daemon 이 401 로 거절 → 백오프 재연결하는
            // 동안 HTTP 호출이 토큰을 데워 두고, 다음 reconnect 가 그 토큰으로 붙는다.
            var items = [URLQueryItem(name: "token", value: cfg.daemonToken)]
            if let attestToken = AttestSession.shared.currentToken() {
                items.append(URLQueryItem(name: "attest", value: attestToken))
            }
            // 시뮬레이터 개발 페어링 — HTTP 의 X-PS-Local 헤더와 짝인 WS 용 ?local= 게이트
            // (server.ts 의 verifyWsAttest 가 검사). 같은 Mac loopback 으로만 전송된다.
            if let localSecret = DevPairing.localAdminSecret {
                items.append(URLQueryItem(name: "local", value: localSecret))
            }
            comps.queryItems = items
            guard let url = comps.url else {
                try? await Task.sleep(nanoseconds: 500_000_000)
                continue
            }

            let s = Self.makeOrReuseSession(localPort: localPort)
            let t = s.webSocketTask(with: url)
            self.task = t
            t.resume()

            // session-scoped 면 subscribe 메시지 보냄. global 채널이면 생략 — broadcastAll 만 받음.
            if let sid = sessionId {
                let subscribed = await subscribe(t, sessionId: sid)
                if !subscribed {
                    NSLog("[WSClient] subscribe 실패 — 백오프 후 재시도")
                    await backoffAndCleanup()
                    continue
                }
                // subscribe 직후 현재 visibility 를 동기화. 재연결이 백그라운드 중에
                // 일어났다면 daemon 의 기본값(active=true)을 곧바로 교정해야 away-gating 이
                // 정확해진다.
                await sendVisibility(t, foreground: foreground)
            }

            NSLog("[WSClient] connected session=\(sessionId ?? "<global>")")
            reconnectAttempt = 0  // 성공 — 백오프 리셋
            reportConnection(true)

            // 30s 주기 ping — Tor 회로의 idle 끊김 + iOS suspend 직후의 좀비 socket 을
            // 빨리 탐지하기 위함. ping 실패는 receive 루프가 곧 receive 에러로 잡으므로
            // 여기서 별도 reconnect 트리거는 불필요.
            startPingLoop(t)

            // receive 루프. 끊기면 break.
            await receiveLoop(t)

            // 정상/비정상 종료 — 정리하고 (running 이면) 재시도.
            pingTask?.cancel()
            pingTask = nil
            await backoffAndCleanup()
        }
    }

    private func startPingLoop(_ t: URLSessionWebSocketTask) {
        pingTask?.cancel()
        pingTask = Task { [weak self, weak t] in
            // 첫 ping 은 짧게 (3s) — 연결 직후 RTT 측정값을 빨리 띄워준다.
            // 이후는 15s 주기 — 회로 변화에 적당히 반응 + WS keepalive 도 겸함.
            var firstDone = false
            while let t, !Task.isCancelled {
                let delayNs: UInt64 = firstDone ? 15_000_000_000 : 3_000_000_000
                try? await Task.sleep(nanoseconds: delayNs)
                if Task.isCancelled { break }
                firstDone = true
                // (1) frame-level ping — 좀비 socket 탐지용 keepalive.
                t.sendPing { err in
                    if let err {
                        NSLog("[WSClient] ping failed: \(err.localizedDescription)")
                    }
                }
                // (2) application-level ping — pong 수신 시점에서 RTT 계산.
                //     데몬 server.ts 의 ws.on("message") 가 {type:"ping", t} → {type:"pong", t} echo.
                await self?.sendAppPing(t)
            }
        }
    }

    /// application-level ping 송신. send 시각 (ms epoch) 을 t 필드에 박고 pendingPings 에 기록.
    /// pong 수신 시 `handlePong` 이 같은 t 로 RTT 계산.
    private func sendAppPing(_ t: URLSessionWebSocketTask) async {
        let now = nowMs()
        pendingPings[now] = now
        let msg: [String: Any] = ["type": "ping", "t": now]
        guard let data = try? JSONSerialization.data(withJSONObject: msg),
              let text = String(data: data, encoding: .utf8) else { return }
        do {
            try await t.send(.string(text))
        } catch {
            // 실패는 receive 루프가 곧 끊김으로 잡으므로 여기선 무시.
        }
    }

    /// 실시간 keystroke 입력 — PtyTerminalView.Coordinator.send 가 SwiftTerm delegate
    /// 의 raw byte 를 받아 호출. base64 인코딩 후 `{type: "pty_input", sessionId, bytes_b64}`
    /// 로 WS 송신.
    ///
    /// fire-and-forget 이었으나, 송신 실패/끊김을 호출부(ChatViewModel)가 «입력이 안 갔음»
    /// 배너로 표면화할 수 있도록 성공 여부를 반환한다. true = WS 로 송신 성공, false = task nil
    /// (끊김) / sessionId nil (prewarm) / 인코딩 실패 / send throw. task nil 체크로 race 안전.
    ///
    /// `agent` 는 KS-TRACE 진단(`PS_KS_TRACE=1`)에만 쓰인다 — 송신측 로그에 에이전트 id 를
    /// 실어 daemon `writePtyRaw` 의 recv 라인과 짝지을 수 있게 한다(전송 동작엔 영향 없음).
    @discardableResult
    func sendPtyInput(_ data: Data, agent: String? = nil) async -> Bool {
        guard let t = task else {
            KSTrace.log("send", session: sessionId, agent: agent, bytes: data, note: "SKIP task=nil")
            return false
        }
        guard let sid = sessionId else {
            KSTrace.log("send", session: nil, agent: agent, bytes: data, note: "SKIP sessionId=nil")
            return false
        }
        KSTrace.log("send", session: sid, agent: agent, bytes: data)
        let b64 = data.base64EncodedString()
        let msg: [String: Any] = [
            "type": "pty_input",
            "sessionId": sid,
            "bytes_b64": b64,
        ]
        guard let json = try? JSONSerialization.data(withJSONObject: msg),
              let text = String(data: json, encoding: .utf8) else {
            KSTrace.log("send", session: sid, agent: agent, bytes: data, note: "SKIP JSON-encode-failed")
            return false
        }
        do {
            try await t.send(.string(text))
            return true
        } catch {
            KSTrace.log("send", session: sid, agent: agent, bytes: data, note: "WS.send FAILED: \(error.localizedDescription)")
            // send 실패 = 소켓이 죽었을 가능성 — 끊김으로 통보해 receive 루프 reconnect 전에도
            // 배너가 뜨게 한다. runLoop 가 곧 backoffAndCleanup 로 같은 false 를 통보해도
            // reportConnection 이 중복을 누른다.
            reportConnection(false)
            return false
        }
    }

    // MARK: - 네이티브 화면 캡처 / 원격 제어 (screen_capture_v1 / remote_control_v1)

    /// 캡처 시작 요청 — daemon 이 헬퍼를 띄우고 프레임을 push 한다. codec 으로 jpeg|h264 협상,
    /// h264 일 땐 채널별 fps/bitrate 티어 + audio(시스템 오디오 AAC 송출 여부)를 함께 보낸다
    /// (Tor=낮게, 직결=높게). 옛 daemon 은 codec/fps/bitrate/audio 를 무시 → jpeg screen_frame
    /// 폴백(둘 다 RemoteScreenView 가 처리).
    func sendCaptureStart(codec: String = "h264", fps: Int? = nil, bitrate: Int? = nil, maxDim: Int? = nil, audio: Bool? = nil) async {
        var msg: [String: Any] = ["type": "capture_start", "codec": codec]
        if let fps { msg["fps"] = fps }
        if let bitrate { msg["bitrate"] = bitrate }
        if let maxDim { msg["maxDim"] = maxDim }
        if let audio { msg["audio"] = audio }
        await sendControl(msg)
    }
    /// 캡처 중단 요청.
    func sendCaptureStop() async { await sendControl(["type": "capture_stop"]) }
    /// 캡처/입력 대상 디스플레이 선택(멀티모니터). index 는 capture_displays 가 준 항목의 index.
    func sendSetDisplay(_ index: Int) async {
        await sendControl(["type": "capture_set_display", "index": index])
    }
    /// 캡처 대상 창 선택(screen_window_target_v1) — windowId 는 capture_windows 항목의 id.
    /// 0 이면 해제(전체 화면 복귀). 헬퍼가 적용 후 capture_target 으로 결과를 보고한다.
    func sendSetWindow(_ windowId: Int) async {
        await sendControl(["type": "capture_set_window", "windowId": windowId])
    }
    /// 창 목록 재보고 요청 — 더보기 메뉴를 열 때 최신 목록으로 갱신(capture_windows 로 응답).
    func sendListWindows() async {
        await sendControl(["type": "capture_list_windows"])
    }
    /// 줌 관심영역(하이브리드 D) — 보는 영역(전체화면 기준 0..1 rect)을 native 해상도로 받게 요청.
    func sendSetROI(x: Double, y: Double, w: Double, h: Double) async {
        await sendControl(["type": "capture_roi", "x": x, "y": y, "w": w, "h": h])
    }
    /// ROI 해제 — 전체 화면으로 복귀.
    func sendClearROI() async {
        await sendControl(["type": "capture_roi", "w": 0])
    }
    /// 원격 제어 보안 게이트 토글 — true 일 때만 daemon 이 input_event 를 헬퍼로 전달.
    func sendControlEnabled(_ enabled: Bool) async {
        await sendControl(["type": "control_set", "enabled": enabled])
    }
    /// 입력 이벤트 — event 는 헬퍼 stdin 명령(cmd + 인자). 좌표는 캡처 프레임 기준 0..1 정규화.
    func sendInputEvent(_ event: [String: Any]) async {
        await sendControl(["type": "input_event", "event": event])
    }

    /// 캡처/제어 제어 메시지 공통 송신 — sessionId 를 붙여 fire-and-forget.
    private func sendControl(_ base: [String: Any]) async {
        guard let t = task, let sid = sessionId else { return }
        var msg = base
        msg["sessionId"] = sid
        guard let data = try? JSONSerialization.data(withJSONObject: msg),
              let text = String(data: data, encoding: .utf8) else { return }
        do {
            try await t.send(.string(text))
        } catch {
            // 실패는 receive 루프가 곧 끊김으로 잡는다.
        }
    }

    /// 앱 visibility 변경 — ChatView 의 scenePhase onChange 가 호출. foreground ↔ background
    /// 를 daemon 에 알려 away-gating 을 제어한다. 값이 바뀔 때만 송신하고, 소켓이 아직
    /// 안 붙었으면 다음 subscribe 직후 runLoop 가 현재 값을 보내므로 여기선 skip 해도 안전.
    func setForeground(_ value: Bool) {
        guard foreground != value else { return }
        foreground = value
        guard let t = task else { return }
        Task { await sendVisibility(t, foreground: value) }
    }

    /// `{type:"visibility", state:"foreground"|"background"}` 송신. fire-and-forget —
    /// 실패해도 receive 루프가 곧 끊김으로 잡거나 다음 재연결이 동기화한다. 옛 daemon 은
    /// 이 type 을 모르는 채 무시하므로 무해 (active 기본 true 로 옛 동작 유지).
    private func sendVisibility(_ t: URLSessionWebSocketTask, foreground: Bool) async {
        let msg: [String: Any] = [
            "type": "visibility",
            "state": foreground ? "foreground" : "background",
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: msg),
              let text = String(data: data, encoding: .utf8) else { return }
        do {
            try await t.send(.string(text))
        } catch {
            // 실패는 receive 루프가 곧 끊김으로 잡으므로 여기선 무시.
        }
    }

    private func nowMs() -> Int64 {
        Int64(Date().timeIntervalSince1970 * 1000)
    }

    /// pong 수신 — pendingPings 에서 매칭되는 t 를 찾아 RTT 계산.
    /// 매칭 안 되면 (이미 stale 로 다음 ping 사이클에서 덮인 경우) 그냥 무시.
    private func handlePong(echoed t: Int64) {
        let now = nowMs()
        if pendingPings.removeValue(forKey: t) != nil {
            let rtt = Int(now - t)
            // 음수/광폭 클램핑은 ConnectionManager.recordRTT 가 한다.
            conn.recordRTT(rtt)
        }
        // pendingPings 가 너무 커지지 않게 — keystroke 입력으로 ping 못 보낸 경우 등.
        // 100 초과면 오래된 절반을 버린다 (간단한 GC).
        if pendingPings.count > 100 {
            let sorted = pendingPings.keys.sorted()
            for k in sorted.prefix(pendingPings.count - 50) {
                pendingPings.removeValue(forKey: k)
            }
        }
    }

    private func subscribe(_ t: URLSessionWebSocketTask, sessionId: String) async -> Bool {
        var msg: [String: Any] = ["type": "subscribe", "sessionId": sessionId]
        // catch-up: 마지막으로 본 created_at 을 보내면 daemon (ws_catchup_v1 지원) 이
        // 그 이후의 pty_chunk 를 즉시 unicast 로 backfill 한다. 옛 daemon 은 모르는 field
        // 라 무시 → 동작은 그대로 (polling fallback 으로 복구).
        if let since = sinceProvider?(), since > 0 {
            msg["since"] = since
        }
        guard let data = try? JSONSerialization.data(withJSONObject: msg) else {
            return false
        }
        guard let text = String(data: data, encoding: .utf8) else { return false }
        do {
            try await t.send(.string(text))
            return true
        } catch {
            NSLog("[WSClient] send subscribe error: \(error)")
            return false
        }
    }

    private func receiveLoop(_ t: URLSessionWebSocketTask) async {
        while running {
            do {
                let msg = try await t.receive()
                // 바이너리 메시지 = H.264 비디오(파라미터셋/AU). JSON 이벤트는 .string 으로만 온다.
                if case .data(let d) = msg {
                    onEvent(.screenVideo(payload: d))
                    continue
                }
                guard let evt = decode(msg) else { continue }
                onEvent(evt)
            } catch {
                NSLog("[WSClient] receive 종료: \(error.localizedDescription)")
                return
            }
        }
    }

    /// 서버 페이로드는 type 만 본다 — runner.ts 의 broadcastToSession 모양과 1:1.
    private func decode(_ msg: URLSessionWebSocketTask.Message) -> Event? {
        let str: String
        switch msg {
        case .string(let s): str = s
        case .data(let d): str = String(data: d, encoding: .utf8) ?? ""
        @unknown default: return nil
        }
        guard let data = str.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = obj["type"] as? String else {
            return nil
        }
        switch type {
        // session-scoped (runner.ts broadcastToSession)
        case "user_message":      return .userMessage
        case "stream":            return .stream
        case "turn_complete":     return .turnComplete
        case "error":             return .error(message: (obj["message"] as? String) ?? "")
        // PTY 모드 (pty-runner.ts)
        case "pty_output":
            // daemon 페이로드: { type, sessionId, id, bytes_b64 } — base64 디코드.
            // id 는 messages.id 와 동일 — ChatViewModel 이 polling dedup 용으로 사용.
            let b64 = obj["bytes_b64"] as? String ?? ""
            guard let id = obj["id"] as? String,
                  let bytes = Data(base64Encoded: b64) else { return nil }
            #if DEBUG
            PtyLog.shared.notice("[PTY-1/WS] pty_output id=\(id, privacy: .public) bytes=\(bytes.count, privacy: .public)")
            #endif
            return .ptyOutput(id: id, bytes: bytes)
        case "pty_exit":
            let code = obj["exitCode"] as? Int
            let signal = obj["signal"] as? Int
            return .ptyExit(exitCode: code, signal: signal)
        case "screen_frame":
            let b64 = obj["bytes_b64"] as? String ?? ""
            guard let jpeg = Data(base64Encoded: b64) else { return nil }
            let ts = (obj["timestamp"] as? Int64) ?? (obj["timestamp"] as? Int).map(Int64.init) ?? 0
            return .screenFrame(jpeg: jpeg, ts: ts)
        case "capture_status":
            return .captureStatus(running: obj["running"] as? Bool ?? false,
                                  reason: obj["reason"] as? String)
        case "capture_displays":
            let arr = obj["displays"] as? [[String: Any]] ?? []
            let displays = arr.compactMap { d -> ScreenDisplay? in
                guard let idx = d["index"] as? Int else { return nil }
                return ScreenDisplay(
                    index: idx,
                    main: (d["main"] as? Bool) ?? false,
                    width: (d["width"] as? Int) ?? 0,
                    height: (d["height"] as? Int) ?? 0,
                )
            }
            return .captureDisplays(displays: displays)
        case "capture_windows":
            let arr = obj["windows"] as? [[String: Any]] ?? []
            let windows = arr.compactMap { w -> ScreenWindow? in
                guard let id = (w["id"] as? Int) ?? (w["id"] as? NSNumber)?.intValue, id > 0 else { return nil }
                return ScreenWindow(
                    id: id,
                    app: (w["app"] as? String) ?? "",
                    title: (w["title"] as? String) ?? "",
                    width: (w["width"] as? Int) ?? 0,
                    height: (w["height"] as? Int) ?? 0,
                )
            }
            return .captureWindows(windows: windows)
        case "capture_target":
            let wid = (obj["window"] as? Int) ?? (obj["window"] as? NSNumber)?.intValue ?? 0
            return .captureTarget(windowId: wid, reason: obj["reason"] as? String)
        case "control_status":
            return .controlStatus(enabled: obj["enabled"] as? Bool ?? false,
                                  reason: obj["reason"] as? String)
        case "session_event":
            // 글로벌 broadcast — daemon pty-runner 의 broadcastWaitingEntry/Resolved.
            // kind: "waiting"(컨텍스트 포함) | "resolved" | "turn_complete"(레거시).
            guard let kind = obj["kind"] as? String,
                  let sid = obj["sessionId"] as? String else { return nil }
            return .sessionEvent(
                kind: kind,
                sessionId: sid,
                repoName: obj["repoName"] as? String,
                title: obj["title"] as? String,
                agentName: obj["agentName"] as? String,
                preview: obj["preview"] as? String,
            )
        // application-level pong — t 와 비교해서 RTT 계산, ConnectionManager 에 publish.
        // Event 로 surface 안 함 (외부 핸들러가 처리할 일 없음, side-effect 만).
        case "pong":
            if let echoed = obj["t"] as? Int64 ?? (obj["t"] as? Int).map(Int64.init) {
                handlePong(echoed: echoed)
            }
            return nil
        // 핸드셰이크
        case "hello", "subscribed":
            return nil
        default:
            return .unknown(type: type)
        }
    }

    private func backoffAndCleanup() async {
        pingTask?.cancel()
        pingTask = nil
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        // 끊김 진입을 소비자에게 통보 — 입력 전송이 더는 안 닿는 상태.
        reportConnection(false)
        // sharedSession 은 의도적으로 유지 — reconnect 가 같은 connection pool 재사용.
        guard running else { return }

        // 1, 2, 4, 8, 16, 30 (cap) 초.
        let delays: [Double] = [1, 2, 4, 8, 16, 30]
        let i = min(reconnectAttempt, delays.count - 1)
        reconnectAttempt += 1
        let secs = delays[i]
        NSLog("[WSClient] reconnect in \(Int(secs))s (attempt \(reconnectAttempt))")
        // wake 가능한 sleep — kick() 이나 stop() 에서 즉시 깨울 수 있다.
        await sleepUntilWakeOrTimeout(seconds: secs, box: wakeBox)
    }
}
