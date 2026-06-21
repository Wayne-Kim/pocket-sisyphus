import Foundation
import AppKit
import SwiftUI

extension Notification.Name {
    /// iOS 가 캡처/제어를 요구했고 그 TCC 권한이 필요할 수 있다는 신호. userInfo["kind"] =
    /// "screen"|"accessibility". App 이 받아 권한 검사 후 없으면 설정창 권한 탭을 연다.
    static let psPermissionRequest = Notification.Name("PSPermissionRequest")
}

/// daemon 자식 프로세스를 spawn/관리하고 상태를 publish.
///
/// 라이프사이클: Mac 앱 시작 = daemon 시작, Mac 앱 종료 = daemon 종료.
/// - `init()` 에서 자동으로 `start()` 호출. 메뉴 클릭 기다릴 필요 없음.
/// - `NSApplication.willTerminateNotification` 옵저버로 앱 종료 시 동기적으로 daemon
///   SIGTERM → exit 대기 (3s 타임아웃). 동기 대기를 안 하면 Mac 앱 프로세스가 먼저
///   exit 해버려서 child 가 orphan 으로 reparent 되는 race 가 발생한다.
///
/// State 전환:
/// - .stopped → .starting: start() 호출 시
/// - .starting → .running: daemon stdout 의 "hidden service ready" 라인 감지 시.
///   (hostname 파일 존재 ≠ daemon 살아있음 — 파일은 영구 잔재라 신뢰 못 함. 매 부팅마다
///    실제로 그 라인이 찍히는 stdout 이 유일하게 신뢰 가능한 신호.)
/// - any → .failed: daemon process 종료 시 (시작/실행 중 무관하게 비정상 exit 처리)
@MainActor
final class DaemonManager: ObservableObject {
    enum State: Equatable {
        case stopped
        case starting
        case running
        case failed(String)
    }

    @Published private(set) var state: State = .stopped
    @Published private(set) var onionAddress: String?
    @Published private(set) var lastLogLines: [String] = []

    /// 듀얼 채널 모델에서 외부 inbound SSH 가능 여부 — UPnP/PMP 매핑 결과 + 외부 IPv4.
    /// daemon stdout 의 "✔ UPnP/PMP mapped: external <IP>:<port>" 또는
    /// "⚠️  UPnP/PMP mapping failed" 라인 스캔으로 갱신. 메뉴바 UI 가 이걸 보고
    /// 사용자에게 «직접 SSH 가능» / «Tor fallback 만» 안내.
    enum NATStatus: Equatable {
        case unknown
        case mapped(externalIPv4: String, port: UInt16)
        case failed(reason: String)
    }
    @Published private(set) var natStatus: NATStatus = .unknown
    /// sshd 가 listen 시작했는지. "✔ sshd listening on" 로그가 신호.
    @Published private(set) var sshListening: Bool = false

    /// 이 인스턴스가 «실제로» 바인딩한 HTTP 포트 — daemon stdout 의
    /// "✔ daemon listening on http://host:port" 에서 파싱. 공유 daemon-runtime.json 과 달리
    /// 다른 빌드(dev/release)가 그 파일을 덮어써도 영향받지 않는 «우리 daemon» 의 진짜 포트.
    @Published private(set) var listeningPort: Int?

    /// 공유 daemon-runtime.json 이 «현재» 가리키는 포트 = DaemonAPI 호출이 실제로 가는 곳.
    /// listeningPort(우리 daemon) 와 다르면 다른 빌드가 그 파일을 덮어쓴 «포트 충돌» 상태로,
    /// 앱의 로컬 API 호출이 엉뚱한 daemon 으로 샐 수 있다. healthTimer 가 매 프로브마다 갱신.
    @Published private(set) var runtimeFilePort: Int?

    /// daemon HTTP 헬스 — state == .running(tor "hidden service ready") 이어도 HTTP 서버가
    /// 실제로 응답하는지는 별개 신호다. /health 를 주기적으로 찔러 «정말 떴는지» 확인한다.
    /// dev/release 포트 충돌로 우리 daemon 이 못 뜬 경우 .running 인데도 .unreachable 이 잡힌다.
    enum Health: Equatable {
        case unknown        // 아직 확인 전 (시작 중 / 중지)
        case ok(connectedClients: Int)  // /health 200 — 실제로 응답함
        case unreachable    // 포트 응답 없음 — 떴다고 표시돼도 실제론 안 닿음
    }
    @Published private(set) var health: Health = .unknown

    private var process: Process?
    private var outputPipe: Pipe?
    private var errorPipe: Pipe?
    private var onionWatchTimer: Timer?
    /// daemon /health 주기 프로브 타이머 (5s). spawn 시 시작, cleanup 시 정지.
    private var healthTimer: Timer?
    private var logRingBuffer: [String] = []
    private let logBufferSize = 200

    /// 매 spawn 마다 증가. terminationHandler 가 자기 generation 만 처리하도록 만들어
    /// 옛 daemon 의 늦은 exit 콜백이 새 인스턴스 state 를 건드리지 못하게 한다.
    private var instanceGeneration: Int = 0

    /// 비정상 종료 시 자동 재시작 백오프. 연속 실패 횟수 — 성공(.running)·의도적
    /// stop/restart 에서 0 으로 리셋. 지연 = min(30s, 2^attempt) → 1,2,4,8,16,30…
    /// (첫 재시도는 1s 라 일시적 크래시는 거의 즉시 회복, 크래시 루프는 30s 간격으로 수렴.)
    private var restartAttempts: Int = 0
    /// 예약된 자동 재시작 Task. 사용자가 그 사이 손으로 살리거나 stop/quit 하면 취소.
    private var autoRestartTask: Task<Void, Never>?
    private let maxAutoRestartDelay: TimeInterval = 30

    init() {
        // Sandbox=ON 시절(~build 93) 의 데이터 (페어링 토큰 + onion 키 포함) 가
        // 컨테이너 안에 있다면 진짜 ~/Library/Application Support/PocketSisyphus/ 로 한 번 이사.
        // 이 줄이 daemon spawn 보다 먼저 돌아야 daemon 이 빈 경로 보고 auto-init 으로
        // 새 토큰/새 onion 키 생성하는 사고를 막는다.
        DataMigration.runOnce()

        // 앱 종료 = daemon 종료. willTerminate 시점에 동기적으로 child 정리.
        // queue: .main 으로 등록하므로 콜백은 실제로는 main thread = MainActor 위에서
        // 실행되지만, NotificationCenter 의 closure 타입이 nonisolated 라 Swift 가
        // static 으로 모름 → assumeIsolated 로 명시적으로 isolation 단언.
        NotificationCenter.default.addObserver(
            forName: NSApplication.willTerminateNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.terminateSynchronously()
            }
        }
        // Mac 앱 시작 = daemon 시작. 메뉴 클릭 기다리지 않음.
        start()
    }

    deinit {
        // deinit는 non-isolated. 직접 process kill만.
        process?.terminate()
    }

    // MARK: - Lifecycle

    func start() {
        guard state == .stopped || isFailed(state) else { return }
        // 새 start 가 시작되니 예약돼 있던 자동 재시작은 더 필요 없다 (중복 spawn 방지).
        // 자동 재시작 Task 가 스스로 start() 를 부른 경우엔 이미 await 를 지난 뒤라 무해.
        autoRestartTask?.cancel()
        autoRestartTask = nil
        // 직전 generation 의 process 가 어떤 이유로든 아직 살아있다면 race 의 씨앗.
        // 동기 cleanup 으로 7777 이 실제로 free 인지 보장.
        if let prev = process, prev.isRunning {
            UnifiedLog.warn(.daemonmgr, "previous process still alive — sync cleanup", [
                "event.action": "daemon.start.cleanup_previous",
            ])
            NSLog("[DaemonManager] start: 직전 process 잔존 — 동기 cleanup")
            terminateSynchronously()
        }
        // 이전 앱 인스턴스/크래시/디버그 중단으로 남은 orphan daemon 을 spawn 전에 정리.
        // 우리가 추적하던 process 가 아니어도(다른 앱 인스턴스가 띄웠던 daemon) 회수한다 —
        // watchdog 이 PID 재사용으로 늦게 발동하거나 SIGKILL 경로로 죽어 7777/7778 을 계속
        // 잡는 케이스의 최종 안전망. daemon 자신도 부팅 시 reclaimStaleDaemon 으로 같은 걸
        // 하지만, 여기서 미리 비워두면 새 daemon 의 첫 bind 가 곧장 성공한다.
        reclaimOrphanDaemons()
        instanceGeneration += 1
        let myGen = instanceGeneration
        state = .starting
        // 새 인스턴스 — 옛 포트/헬스 신호 초기화. 우리 stdout 의 listening 라인이 다시 채운다.
        listeningPort = nil
        runtimeFilePort = nil
        health = .unknown
        UnifiedLog.info(.daemonmgr, "daemon spawn requested", [
            "event.action": "daemon.start",
            "daemon.generation": myGen,
        ])

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: DaemonPaths.nodeBinary)
        // node가 tsx를 호출하도록: node tsx-bin src/index.ts
        proc.arguments = DaemonPaths.daemonEntry
        proc.currentDirectoryURL = URL(fileURLWithPath: DaemonPaths.daemonProjectDir)

        // 환경: PocketSisyphus가 미리보기 자동 열기 방지 (Mac 앱이 직접 열어주니까)
        var env = ProcessInfo.processInfo.environment
        env["POCKET_CLAUDE_NO_OPEN"] = "1"
        // .app 안의 bin/ 을 PATH 앞에 박아 daemon 자식들이 번들된 node/tor 를 찾도록.
        // daemon TypeScript 코드는 PATH 의존이 거의 없고 (대부분 절대경로 사용), 있다면 이 PATH 로 fallback.
        // Homebrew bin (/opt/homebrew/bin = Apple Silicon, /usr/local/bin = Intel) 을 포함시킨다 —
        // Finder/launchd 가 띄운 GUI 앱은 «축소된» PATH(/usr/bin:/bin)만 받아서, brew 로 깐 `gh` 등이
        // /opt/homebrew/bin 에 멀쩡히 있어도 안 잡혔다. 그 결과 수집의 GitHub 분기가 조용히 0건을 내고
        // (po/gh.ts 의 가용성 점검도 같은 PATH 를 보므로) iOS 에 «gh 없음» 거짓 안내가 떴다.
        env["PATH"] = "\(DaemonPaths.daemonProjectDir)/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
        // 번들된 tor 바이너리 경로 — sidecar.ts 가 이걸 읽어서 spawn.
        env["POCKET_CLAUDE_TOR_BIN"] = DaemonPaths.torBinary
        env["POCKET_CLAUDE_TOR_DATA_DIR"] = DaemonPaths.torDataDir
        // 번들된 OpenSSH portable sshd — ssh/server.ts 가 이걸 읽어서 spawn.
        // 듀얼 채널 모델의 SSH 서버 채널. 없으면 dev fallback (Homebrew openssh) 시도.
        env["POCKET_CLAUDE_SSHD_BIN"] = DaemonPaths.sshdBinary
        // 번들된 화면 캡처/입력 주입 헬퍼 — capture/sidecar.ts 가 이걸 읽어서 spawn.
        // 화면 기록 + 손쉬운 사용 TCC 권한 필요(라이브 화면 보기/원격 제어 기능). 없으면 캡처 미동작.
        env["POCKET_CLAUDE_CAPTURE_BIN"] = DaemonPaths.captureBinary
        // GUI 사용자 위해 daemon 이 config 없으면 자동 init 하도록 신호.
        // CLI 호출자는 이 env 없이 동작 → 종전대로 "init 먼저" 에러 (의도적).
        env["POCKET_CLAUDE_AUTO_INIT"] = "1"
        // Parent PID — daemon 의 lifecycle watchdog 이 이걸로 우리 생존을 감시.
        // 우리가 죽으면 daemon 도 ≤2s 내 self-SIGTERM → orphan 방지.
        env["POCKET_CLAUDE_PARENT_PID"] = "\(ProcessInfo.processInfo.processIdentifier)"

        #if DEBUG
        // ── 격리(검증) 데이터 모드 — «검증 표준 스위치» ───────────────────────────────
        // 에이전트/검증 스크립트가 샘플 데이터를 시드할 때 실(dev) DB 가 오염되지 않도록,
        // daemon 의 단일 db()/applyMigrations 경로(POCKET_CLAUDE_CONFIG_DIR escape hatch)를
        // 그대로 쓰되 CONFIG_DIR 만 dev 전용 디렉터리로 가리키게 한다. 새 DB 추상화는 만들지
        // 않는다 — 스키마 한쪽-드리프트를 원천 차단.
        //
        // 우선순위:
        //   1) 부모 환경에 POCKET_CLAUDE_CONFIG_DIR 이 «명시»돼 있으면 그대로 존중한다.
        //      (env 는 ProcessInfo 에서 통째로 복사돼 이미 들어 있으므로 여기선 손대지 않음.)
        //   2) 아니고 PS_ISOLATED_DATA 가 설정돼 있으면 표준 dev 디렉터리로 주입한다.
        //   3) 둘 다 없으면 아무것도 주입하지 않는다 → 종전대로 실 DB. (기본 동작 회귀 0)
        //
        // 표준 dev 디렉터리는 scripts/{verify-ios,store-shot,run-ios-e2e}.sh 의 기본
        // CONFIG_DIR 과 «반드시 같은» 경로다 (아래 한 줄을 바꾸면 그쪽도 같이 맞출 것).
        let parentEnv = ProcessInfo.processInfo.environment
        if parentEnv["POCKET_CLAUDE_CONFIG_DIR"] == nil, parentEnv["PS_ISOLATED_DATA"] != nil {
            let devDir = (NSHomeDirectory() as NSString)
                .appendingPathComponent("Library/Application Support/PocketSisyphus-dev")
            env["POCKET_CLAUDE_CONFIG_DIR"] = devDir
            NSLog("[DaemonManager] 격리 데이터 모드 ON — POCKET_CLAUDE_CONFIG_DIR=\(devDir)")
        }
        #endif

        proc.environment = env

        let outPipe = Pipe()
        let errPipe = Pipe()
        proc.standardOutput = outPipe
        proc.standardError = errPipe

        #if DEBUG
        // 시스템 로그 (NSLog → os_log) 가 %@ 인자를 <private> 로 redact 해서 Console.app
        // 에서 daemon stdout/stderr 가 안 보인다. Debug 빌드에서만 파일로 미러링 — Release
        // 에는 빠짐.
        // 경로: NSTemporaryDirectory() (보통 /var/folders/.../T/) 안의
        //   pocketsisyphus-daemon-{stdout,stderr}.log
        let dbgOut = NSTemporaryDirectory() + "pocketsisyphus-daemon-stdout.log"
        let dbgErr = NSTemporaryDirectory() + "pocketsisyphus-daemon-stderr.log"
        try? "".write(toFile: dbgOut, atomically: true, encoding: .utf8)
        try? "".write(toFile: dbgErr, atomically: true, encoding: .utf8)
        #endif

        outPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
            #if DEBUG
            if let fh = FileHandle(forWritingAtPath: dbgOut) {
                fh.seekToEndOfFile(); fh.write(data); try? fh.close()
            }
            #endif
            Task { @MainActor in self?.appendLog(text) }
        }
        errPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
            #if DEBUG
            if let fh = FileHandle(forWritingAtPath: dbgErr) {
                fh.seekToEndOfFile(); fh.write(data); try? fh.close()
            }
            #endif
            Task { @MainActor in self?.appendLog(text) }
        }

        proc.terminationHandler = { [weak self] p in
            Task { @MainActor in
                guard let self else { return }
                // 옛 generation 의 늦은 콜백이 새 인스턴스 state 를 건드리지 못하게 가드.
                // (재시작 직후 옛 daemon 이 ~수초 뒤 exit 하면 그 콜백이 새 daemon
                //  state 를 .failed 로 덮어쓰는 race 를 차단.)
                guard self.instanceGeneration == myGen else {
                    UnifiedLog.debug(.daemonmgr, "ignoring exit callback from old generation", [
                        "event.action": "daemon.exit.stale_callback",
                        "daemon.generation": myGen,
                    ])
                    NSLog("[DaemonManager] 옛 generation(\(myGen)) 의 exit 콜백 무시")
                    return
                }
                let code = p.terminationStatus
                let wasIntentional: Bool
                switch self.state {
                case .running, .starting:
                    wasIntentional = false
                default:
                    wasIntentional = true  // .stopped / .failed 면 의도된 종료
                }
                UnifiedLog.info(
                    .daemonmgr,
                    wasIntentional ? "daemon exited (intentional)" : "daemon exited unexpectedly",
                    [
                        "event.action": "daemon.exit",
                        "daemon.generation": myGen,
                        "process.exit_code": Int(code),
                        "daemon.exit.intentional": wasIntentional,
                    ]
                )
                self.cleanupTimers()
                self.process = nil
                // 프로세스가 사라졌으니 포트/헬스 신호도 무효.
                self.listeningPort = nil
                self.runtimeFilePort = nil
                self.health = .unknown
                // .running 뿐 아니라 .starting 도 비정상 exit 로 처리 — 사용자가
                // "시작 중…" 에 갇혀 영원히 기다리는 일 없도록.
                // 비정상 종료면 .failed 로 두되, 백오프 후 자동 재시작을 건다 — 예전엔
                // 상태바 메뉴를 열어야만(.onAppear) 회복됐던 걸 자동·안정 회복으로 바꾼다.
                if !wasIntentional {
                    self.state = .failed(String(localized: "daemon exited code=\(Int(code))"))
                    self.scheduleAutoRestart()
                }
            }
        }

        #if DEBUG
        let dbg = NSTemporaryDirectory() + "pocketsisyphus-spawn.log"
        let attempt = "[DaemonManager] spawn 시도 @ \(Date())\n  node=\(DaemonPaths.nodeBinary)\n  cwd=\(DaemonPaths.daemonProjectDir)\n  entry=\(DaemonPaths.daemonEntry.joined(separator: " "))\n"
        try? attempt.write(toFile: dbg, atomically: true, encoding: .utf8)
        #endif
        NSLog("[DaemonManager] spawn 시도: node=%@ cwd=%@",
              DaemonPaths.nodeBinary, DaemonPaths.daemonProjectDir)
        do {
            try proc.run()
            #if DEBUG
            try? (attempt + "spawn 성공: pid=\(proc.processIdentifier)\n").write(toFile: dbg, atomically: true, encoding: .utf8)
            #endif
            UnifiedLog.info(.daemonmgr, "daemon spawn ok", [
                "event.action": "daemon.spawn.ok",
                "daemon.pid": proc.processIdentifier,
                "daemon.generation": myGen,
            ])
            NSLog("[DaemonManager] spawn 성공: pid=%d", proc.processIdentifier)
            self.process = proc
            self.outputPipe = outPipe
            self.errorPipe = errPipe
            startOnionWatch()
            startHealthProbe()
        } catch {
            #if DEBUG
            try? (attempt + "spawn 실패: \(error.localizedDescription)\nNSError: \(error as NSError)\n").write(toFile: dbg, atomically: true, encoding: .utf8)
            #endif
            UnifiedLog.error(.daemonmgr, "daemon spawn failed", [
                "event.action": "daemon.spawn.fail",
                "daemon.generation": myGen,
                "error.message": error.localizedDescription,
                "error.detail": (error as NSError).description,
            ])
            NSLog("[DaemonManager] spawn 실패: %@ NSError=%@",
                  error.localizedDescription, error as NSError)
            state = .failed(String(localized: "spawn 실패: \(error.localizedDescription)"))
            // 일시적 사유(노드 바이너리 잠깐 부재 등)면 백오프 후 자동 재시도.
            scheduleAutoRestart()
        }
    }

    func stop() {
        // process.terminate() 만 보내고 즉시 return 하면 daemon 이 Tor SIGTERM + 5s
        // safety 동안 살아있어서 7777 보유 → 직후 start() 가 EADDRINUSE.
        // 동기 대기로 실제 exit 보장.
        terminateSynchronously()
        // 의도된 정지 — 백오프 카운터 리셋. 다음 회복(다시 켤 때)은 빠른 재시도부터.
        restartAttempts = 0
        state = .stopped
        onionAddress = nil
        natStatus = .unknown
        sshListening = false
        listeningPort = nil
        runtimeFilePort = nil
        health = .unknown
    }

    /// daemon child 가 실제로 exit 할 때까지 동기 대기. 앱 종료 / 메뉴 stop / restart
    /// 공통 진입점. UI 가 잠시 freeze (~수초) 되지만 그게 race 없는 유일한 방법.
    ///
    /// 타임아웃 6s = daemon 의 Tor SIGTERM + 5s safety + 약간의 여유. 그 안에도 못
    /// 끝내면 SIGKILL fallback (이 경우 Tor 가 orphan 될 수 있지만 sidecar 가 다음
    /// 부팅 시 stale lock 정리).
    func terminateSynchronously() {
        // 예약된 자동 재시작이 있으면 취소 — stop/restart/앱 종료 후 유령 재시작 방지.
        autoRestartTask?.cancel()
        autoRestartTask = nil
        cleanupTimers()
        guard let proc = process else { return }
        NSLog("[DaemonManager] terminateSynchronously: SIGTERM → wait")
        proc.terminate()  // SIGTERM
        let deadline = Date().addingTimeInterval(6.0)
        while proc.isRunning && Date() < deadline {
            Thread.sleep(forTimeInterval: 0.1)
        }
        if proc.isRunning {
            NSLog("[DaemonManager] terminateSynchronously: 6s 안에 안 끝남 → SIGKILL")
            kill(proc.processIdentifier, SIGKILL)
            let killDeadline = Date().addingTimeInterval(1.0)
            while proc.isRunning && Date() < killDeadline {
                Thread.sleep(forTimeInterval: 0.05)
            }
        }
        process = nil
        NSLog("[DaemonManager] terminateSynchronously: done")
    }

    func restart() {
        // stop() 이 동기적으로 실제 exit 까지 대기 → asyncAfter delay 불필요.
        stop()
        start()
    }

    /// 이전 인스턴스가 남긴 orphan daemon(우리 src/index.ts 를 실행 중인 node) 을 spawn 전
    /// 동기 정리. marker = daemon entry 절대경로 → 우리 daemon 만 정확히 식별, 시스템/무관
    /// node 는 안 건드림. 현재 추적 중인 process 도 제외(있다면 terminateSynchronously 가 이미
    /// 처리). orphan node 의 자식(tor/sshd) 은 새 daemon 의 marker 기반 reclaim 이 마저 정리.
    private func reclaimOrphanDaemons() {
        let marker = DaemonPaths.daemonEntryPath
        guard !marker.isEmpty else { return }
        let pgrep = Process()
        pgrep.executableURL = URL(fileURLWithPath: "/usr/bin/pgrep")
        pgrep.arguments = ["-f", marker]
        let outPipe = Pipe()
        pgrep.standardOutput = outPipe
        pgrep.standardError = Pipe()
        do {
            try pgrep.run()
            pgrep.waitUntilExit()
        } catch {
            return // pgrep 부재 등 — 조용히 패스.
        }
        let data = outPipe.fileHandleForReading.readDataToEndOfFile()
        guard let out = String(data: data, encoding: .utf8) else { return }
        let tracked = process?.processIdentifier
        let selfPid = ProcessInfo.processInfo.processIdentifier
        for tok in out.split(whereSeparator: { $0.isWhitespace }) {
            guard let pid = Int32(tok), pid > 1, pid != tracked, pid != selfPid else { continue }
            UnifiedLog.warn(.daemonmgr, "reclaiming orphan daemon before spawn", [
                "event.action": "daemon.reclaim.orphan",
                "daemon.pid": Int(pid),
            ])
            NSLog("[DaemonManager] orphan daemon 정리: SIGKILL pid=%d", pid)
            kill(pid, SIGKILL)
        }
    }

    /// 비정상 종료(또는 spawn 실패) 후 자동 재시작 예약. 지수 백오프로 크래시 루프가
    /// CPU/로그를 태우지 않게 하면서도 일시적 장애는 빠르게(첫 시도 1s) 회복한다.
    /// 예약 후 사용자가 손으로 살리거나 stop/quit 하면 `autoRestartTask` 가 취소된다.
    private func scheduleAutoRestart() {
        autoRestartTask?.cancel()
        let attempt = restartAttempts
        restartAttempts += 1
        let delay = min(maxAutoRestartDelay, pow(2.0, Double(attempt)))
        UnifiedLog.info(.daemonmgr, "auto-restart scheduled", [
            "event.action": "daemon.autorestart.scheduled",
            "daemon.autorestart.attempt": attempt + 1,
            "daemon.autorestart.delay_s": delay,
        ])
        NSLog("[DaemonManager] 자동 재시작 예약: #%d, %.0fs 후", attempt + 1, delay)
        autoRestartTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            guard let self, !Task.isCancelled else { return }
            // 대기 중 사용자가 이미 살렸거나(.starting/.running) 멈췄으면(.stopped) 아무것도 안 함.
            guard self.isFailed(self.state) else { return }
            UnifiedLog.info(.daemonmgr, "auto-restart firing", [
                "event.action": "daemon.autorestart.fire",
                "daemon.autorestart.attempt": attempt + 1,
            ])
            NSLog("[DaemonManager] 자동 재시작 실행: #%d", attempt + 1)
            self.start()
        }
    }

    // MARK: - Onion hostname watch

    /// onion hostname 파일은 onion 주소 표시용으로만 사용 — daemon 인스턴스 간 영구
    /// 보존되는 파일이라 "이 daemon 이 살아있는가" 의 신호로는 못 씀. state 전환은
    /// 오직 daemon stdout 의 "hidden service ready" 라인으로 처리 (appendLog 참조).
    private func startOnionWatch() {
        onionWatchTimer?.invalidate()
        onionWatchTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.readOnionHostname() }
        }
        readOnionHostname()
    }

    private func readOnionHostname() {
        let url = DaemonPaths.onionHostnameFile
        guard let data = try? String(contentsOf: url, encoding: .utf8) else { return }
        let trimmed = data.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasSuffix(".onion") else { return }
        if onionAddress != trimmed { onionAddress = trimmed }
    }

    // MARK: - Logging

    private func appendLog(_ text: String) {
        for line in text.split(whereSeparator: { $0.isNewline }) {
            let s = String(line)
            logRingBuffer.append(s)
            // sidecar.ts 가 Tor bootstrap 끝나면 정확히 이 prefix 로 한 줄 찍음.
            // hostname 파일과 달리 이 라인은 매 부팅마다 새로 찍히므로 신뢰 가능한
            // "이번 daemon 인스턴스가 살아있다" 신호.
            if s.contains("[tor] hidden service ready") {
                if case .starting = state {
                    state = .running
                    // 정상 가동 도달 — 자동 재시작 백오프 리셋. 다음에 죽으면 다시 1s 부터.
                    restartAttempts = 0
                    autoRestartTask?.cancel()
                    autoRestartTask = nil
                    UnifiedLog.info(.daemonmgr, "daemon state → running", [
                        "event.action": "daemon.state.running",
                    ])
                }
            }
            scanDualChannelStatus(line: s)
        }
        if logRingBuffer.count > logBufferSize {
            logRingBuffer.removeFirst(logRingBuffer.count - logBufferSize)
        }
        lastLogLines = Array(logRingBuffer.suffix(50))
    }

    /// daemon stdout 의 듀얼 채널 상태 라인을 스캔해 `natStatus` / `sshListening` 갱신.
    /// 라인 포맷은 daemon 측 (server.ts / ssh/server.ts / nat/port-mapping.ts) 와 짝.
    private func scanDualChannelStatus(line: String) {
        // "✔ daemon listening on http://127.0.0.1:7777" — 이 인스턴스의 진짜 바인딩 포트.
        // 공유 daemon-runtime.json 과 달리 다른 빌드가 못 덮어쓰는, 우리 daemon 의 stdout 신호.
        if let r = line.range(of: "daemon listening on http://") {
            let tail = line[r.upperBound...]  // "127.0.0.1:7777"
            if let colon = tail.lastIndex(of: ":") {
                let digits = tail[tail.index(after: colon)...].prefix { $0.isNumber }
                if let p = Int(digits), p != listeningPort {
                    listeningPort = p
                    UnifiedLog.info(.daemonmgr, "daemon listening port detected", [
                        "event.action": "daemon.listen.port_detected",
                        "daemon.bound_port": p,
                    ])
                    // 포트를 막 알았으니 5s 타이머를 기다리지 말고 즉시 한 번 프로브.
                    Task { @MainActor in await self.probeHealth() }
                }
            }
            return
        }
        if line.contains("✔ sshd listening on") {
            if !sshListening {
                UnifiedLog.info(.daemonmgr, "sshd listening detected", [
                    "event.action": "sshd.listen.detected",
                ])
            }
            sshListening = true
            return
        }
        // "✔ UPnP/PMP mapped: external 203.0.113.5:22022 → local 22022"
        if let range = line.range(of: "✔ UPnP/PMP mapped: external "),
           let endRange = line.range(of: " → local", range: range.upperBound..<line.endIndex)
        {
            let segment = line[range.upperBound..<endRange.lowerBound]  // "203.0.113.5:22022"
            let parts = segment.split(separator: ":")
            if parts.count == 2, let port = UInt16(parts[1]) {
                natStatus = .mapped(externalIPv4: String(parts[0]), port: port)
                UnifiedLog.info(.daemonmgr, "UPnP/PMP mapping detected", [
                    "event.action": "nat.upnp.mapped.detected",
                    "secret.external_ipv4": String(parts[0]),
                    "nat.external_port": Int(port),
                ])
            }
            return
        }
        if line.contains("⚠️  UPnP/PMP mapping failed") {
            // 사유는 괄호 안에 있을 수 있으나 UI 노출은 단순화.
            natStatus = .failed(reason: "UPnP/PMP 자동 매핑 실패")
            UnifiedLog.warn(.daemonmgr, "UPnP/PMP mapping failed detected", [
                "event.action": "nat.upnp.failed.detected",
            ])
            return
        }
        // iOS 가 캡처(화면 기록)/제어(손쉬운 사용)를 요구했다는 신호 — server.ts 가 찍는다.
        // 앱이 받아서 해당 TCC 가 «없을 때만» 설정창을 권한 탭으로 연다(권위 검사는 앱이).
        if line.contains("__PS_PERMISSION_REQUEST__ screen") {
            NotificationCenter.default.post(name: .psPermissionRequest, object: nil, userInfo: ["kind": "screen"])
            return
        }
        if line.contains("__PS_PERMISSION_REQUEST__ accessibility") {
            NotificationCenter.default.post(name: .psPermissionRequest, object: nil, userInfo: ["kind": "accessibility"])
            return
        }
    }

    private func cleanupTimers() {
        onionWatchTimer?.invalidate()
        onionWatchTimer = nil
        healthTimer?.invalidate()
        healthTimer = nil
    }

    // MARK: - Health probe

    /// daemon /health 를 5s 마다 찔러 «실제로 HTTP 응답하는지» 확인. state(.running) 은
    /// tor stdout 라인 기반이라 «HTTP 서버가 정말 떴는가» 와는 별개 — dev/release 포트 충돌로
    /// 우리 daemon 이 바인딩에 실패한 경우 .running 인데도 여기서 .unreachable 로 잡힌다.
    private func startHealthProbe() {
        healthTimer?.invalidate()
        healthTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            Task { @MainActor in await self?.probeHealth() }
        }
    }

    /// 우리 daemon 의 실제 포트(listeningPort)로 /health 를 1회 호출하고 결과를 publish.
    /// 동시에 공유 daemon-runtime.json 의 포트를 읽어 dev/release 충돌 여부(runtimeFilePort)도 갱신.
    @MainActor
    private func probeHealth() async {
        // 공유 런타임 파일이 가리키는 포트 — 우리 포트와 다르면 다른 빌드가 덮어쓴 것(충돌).
        runtimeFilePort = DaemonPaths.boundDaemonPort()
        // 우리 daemon 의 진짜 포트를 아직 모르면(시작 중) 헬스는 unknown 유지.
        guard let port = listeningPort,
              let url = URL(string: "http://127.0.0.1:\(port)/health") else {
            return
        }
        var req = URLRequest(url: url)
        req.timeoutInterval = 3
        req.cachePolicy = .reloadIgnoringLocalCacheData
        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                health = .unreachable
                return
            }
            let clients = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["connectedClients"] as? Int ?? 0
            health = .ok(connectedClients: clients)
        } catch {
            health = .unreachable
        }
    }

    private func isFailed(_ s: State) -> Bool {
        if case .failed = s { return true }
        return false
    }
}
