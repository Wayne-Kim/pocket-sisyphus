import Foundation
import SwiftUI

@MainActor
final class ChatViewModel: ObservableObject {
    /// PTY 키 입력(터미널/REPL 타이핑)이 WS 로 «전송됐는지» 의 표면화 상태.
    /// fire-and-forget 송신이 연결 끊김으로 silent drop 되면 사용자가 즉시 알고 재시도하도록
    /// 세션 화면에 일시적·비파괴 배너를 띄우는 데 쓴다.
    /// - ok: 정상(배너 없음).
    /// - failed: 직전 입력이 안 갔고 아직 끊긴 상태(danger).
    /// - reconnecting: 실패 후 다시 연결됨 — 복구 확인 중(info/secondary), 곧 자동 해제.
    enum PtyInputDelivery: Equatable {
        case ok
        case failed
        case reconnecting
    }
    @Published private(set) var ptyInputDelivery: PtyInputDelivery = .ok

    @Published private(set) var items: [ChatItem] = []
    @Published private(set) var isSending: Bool = false
    @Published private(set) var isAwaitingReply: Bool = false
    /// 에이전트가 «사용자 입력» 을 기다리는 중 — 입력바 위 대기 배너 게이트 (isAwaitingReply
    /// 의 반대 방향: 저건 «모델이 답을 만드는 중», 이건 «모델이 나를 기다리는 중»).
    /// 켜기: WS turn_complete push(즉시) + 폴링의 session.waiting_since(fallback/콜드 진입).
    /// 끄기: 출력 재개(ptyOutput/pty_chunk) · 사용자가 전송 · pty_exit. 폴링은 끄지 않는다 —
    /// in-flight 응답의 stale null 이 WS 의 켜짐을 덮는 깜빡임을 막는다 (이벤트가 진실).
    @Published private(set) var agentAwaitingUser: Bool = false
    /// 「다음 정지 시 알림」 수동 구독이 이 세션에 무장돼 있는지 — 더보기 메뉴 토글의 on/off
    /// 표시용. 토글 시 낙관적으로 세팅하고, 폴링의 session.notifyNextStop 로 재동기화한다.
    /// daemon 이 알림을 발사하며 1회성으로 소진하면 다음 폴링에서 false 로 자동 내려간다.
    @Published private(set) var notifyNextStopArmed: Bool = false
    @Published private(set) var lastError: String?
    /// 서버가 알려주는 최신 세션 요약 — 폴링 때마다 갱신해서 title 변경 등을 즉시 반영한다.
    /// nil 인 동안은 호출자가 init 에 넘긴 초기 SessionSummary 를 보여준다.
    @Published private(set) var currentSession: SessionSummary?
    /// 세션의 repo_path 에서 현재 git 브랜치 — ChatView 상태바에 표시.
    /// `nil` = git repo 아님 / git 미설치 / 아직 로드 전 / 일시적 fetch 실패.
    /// branchName 이 nil 이라도 «아직 로드 전» 인지 «성공적으로 받았는데 git 이 아님» 인지
    /// 구분하려면 gitBranchLoaded 를 본다 — UI 가 후자일 때만 «Git 없음» 안내를 띄운다.
    @Published private(set) var branchName: String?
    /// 브랜치 fetch 가 «에러 없이» 한 번이라도 완료됐는지. true + branchName == nil 이면
    /// 「git repo 아님」 이 확정된 상태 (네트워크/미지원 실패는 false 로 남아 안내를 보류).
    @Published private(set) var gitBranchLoaded = false
    /// 세션 repo_path 의 커밋되지 않은 변경 요약 — 상태바 «변경 N» 칩과 Diff 시트 데이터원.
    /// daemon `session_git_status_v1` 미지원 또는 repo 가 아니면 nil (UI 가 슬롯 숨김).
    /// 폴링 cycle 에 합류하며, 같은 값이면 publish 안 함.
    @Published private(set) var gitStatus: GitStatusResponse?
    /// 세션 agent 의 토큰 잔량 — 더보기 메뉴의 잔량 row 데이터원. nil = 아직 조회 전
    /// (메뉴가 «조회 중…» 표시). supported:false 면 메뉴에서 관련 UI 전체 숨김.
    @Published private(set) var agentUsage: AgentUsageResponse?
    /// daemon 이 산출물(artifacts_v1)을 지원하는가 — «결과» 시트의 «산출물» 세그먼트 게이트.
    @Published private(set) var supportsArtifacts = false
    /// daemon 이 네이티브 화면 캡처(screen_capture_v1)를 지원하는가 — «화면» 세그먼트 게이트.
    @Published private(set) var supportsScreenCapture = false
    /// daemon 이 원격 제어(remote_control_v1)를 지원하는가 — «화면» 안 «제어» 토글 게이트.
    @Published private(set) var supportsRemoteControl = false
    /// daemon 이 H.264 화면 릴레이(screen_h264_v1)를 지원하는가 — 미러링 코덱 협상 게이트.
    @Published private(set) var supportsScreenH264 = false
    /// daemon 이 원샷 스크린샷(screen_shot_v1)을 지원하는가 — 미러링 «캡처/녹화 → 첨부» 게이트.
    @Published private(set) var supportsScreenShot = false
    /// daemon 이 창 단위 캡처 대상(screen_window_target_v1)을 지원하는가 — «캡처 대상» 피커 게이트.
    @Published private(set) var supportsWindowTarget = false
    /// daemon 프록시가 프리뷰 v2(절대 URL 리라이트 + 다중 포트)를 지원하는가 — 프리뷰 화면의
    /// «보조 포트 등록» UI 게이트. 없으면(옛 daemon) 기존 단일 포트 UX (회귀 없음).
    @Published private(set) var supportsMultiPortPreview = false
    /// PTY raw bytes 누적 + hook 동기화. 분리된 struct (PtyByteBuffer) 가 incremental
    /// replay 로직과 회귀 차단 단위 테스트를 담당. ChatViewModel 은 얇은 wrapper.
    private var ptyBuffer = PtyByteBuffer()

    /// PTY 모드 — PtyTerminalView 가 등록하는 raw bytes feed hook.
    /// 위임: PtyByteBuffer.registerHook / unregisterHook.
    var onPtyBytes: ((Data) -> Void)? {
        get { nil }  // setter-only 처럼 동작 — 외부에서 읽을 일은 없음.
        set {
            let state = newValue == nil ? "cleared" : "registered"
            PtyLog.shared.notice("[PTY-3/VM] onPtyBytes hook \(state, privacy: .public) — buffer=\(self.ptyBuffer.count, privacy: .public) delivered=\(self.ptyBuffer.delivered, privacy: .public)")
            if let hook = newValue {
                ptyBuffer.registerHook(hook)
            } else {
                ptyBuffer.unregisterHook()
            }
        }
    }

    /// PTY 모드 — ChatView 가 키보드 토글 버튼으로 SwiftTerm 에 first responder 활성을
    /// 요청할 때 호출되는 hook. PtyTerminalView.Coordinator 가 bind 시점에 등록한다.
    /// 옛 흐름 (사용자가 터미널 화면 직접 탭) 도 그대로 작동 — 이 hook 은 statusBar 의
    /// 「⌨ 토글」 버튼으로 키보드 활성하는 보조 path.
    var requestTerminalFocusHook: (() -> Void)?

    /// PTY 모드 키보드 닫기 — Coordinator 가 weak view 통해 직접 resignFirstResponder.
    /// UIApplication.sendAction(resignFirstResponder, to: nil) 가 SwiftTerm 환경에선
    /// 안 먹히는 케이스가 있어 (사용자 보고 2026-05) 명시 호출 path 필요.
    var resignTerminalFocusHook: (() -> Void)?

    // MARK: - In-session 검색 (대화에서 찾기)
    //
    // 긴 에이전트 출력(빌드 로그·diff·파일 내용)에서 폰으로 텍스트를 찾는 클라이언트측 검색.
    // SwiftTerm 의 내장 검색(findNext/findPrevious/clearSearch)으로 현재 매치를 «선택(하이라이트)»
    // 하고 해당 줄로 스크롤한다. Coordinator 가 bind 시점에 등록하고, ChatView 의 찾기 바가 호출.
    // 새 daemon API 불필요 — 이미 폰에 로드된 터미널 버퍼(스크롤백 포함) 대상.

    /// 다음 매치로 이동 — term 을 SwiftTerm 검색에 넘겨 현재 선택 다음 매치를 선택+스크롤.
    var findNextHook: ((String) -> Void)?
    /// 이전 매치로 이동.
    var findPreviousHook: ((String) -> Void)?
    /// 검색 상태/선택 해제 — 빈 검색어·찾기 닫기·검색어 변경 시 호출.
    var clearSearchHook: (() -> Void)?
    /// 현재 버퍼(스크롤백 포함)에서 term 의 매치 «수» — SwiftTerm 의 SearchService.findAll 이
    /// internal 이라 직접 못 써서, 공개 API(getBufferAsData)로 버퍼 텍스트를 받아 클라이언트가
    /// 줄 단위로 센다. 대소문자 무시. Coordinator 가 등록(터미널 뷰가 거기 있으므로).
    var countMatchesHook: ((String) -> Int)?
    /// term 의 index(0-base, 버퍼 위→아래 순)번째 매치가 보이도록 스크롤한다.
    /// SwiftTerm 내장 scrollToResult 는 macOS 의 yDisp 스크롤백 모델이라 iOS 의 UIScrollView
    /// contentOffset 을 안 움직인다(오히려 bottom 으로 튄다) — 그래서 선택(드래그)만 되고
    /// 스크롤이 안 됐다. Coordinator 가 버퍼 텍스트에서 매치 row 를 찾아 contentOffset 으로 직접 이동.
    var scrollToMatchHook: ((String, Int) -> Void)?

    /// 찾기 바가 «열려 있는 동안만» true. 스트리밍 중 매치 수 재계산 트리거(terminalContentVersion)
    /// 를 검색 중에만 켜서, 평상시엔 터미널 갱신이 ChatView 본문을 재평가시키지 않게 한다(오버헤드 0).
    var isSearchActive = false
    /// 검색 중 터미널 내용이 갱신될 때마다 (스로틀해) 증가 — ChatView 가 onChange 로 매치 수 재계산.
    /// PTY 출력은 @Published 가 아니라 onPtyBytes 훅으로 흐르므로, 검색 안 할 땐 이 값이 안 변해
    /// 본문 재평가가 없다.
    @Published private(set) var terminalContentVersion = 0
    private var lastContentBump = Date.distantPast
    /// Coordinator.flushFeed 가 새 출력을 터미널에 그린 뒤 호출 — 검색 중이면 0.4s 스로틀로 버전 증가.
    func noteTerminalContentChanged() {
        guard isSearchActive else { return }
        let now = Date()
        guard now.timeIntervalSince(lastContentBump) > 0.4 else { return }
        lastContentBump = now
        terminalContentVersion &+= 1
    }

    /// PTY 모드 raw chunk 수신 — buffer 에 누적 + hook 등록돼 있으면 즉시 전달.
    func appendPtyBytes(_ data: Data) {
        #if DEBUG
        PtyLog.shared.notice("[PTY-2/VM] appendPtyBytes +\(data.count, privacy: .public) total_buf=\(self.ptyBuffer.count, privacy: .public) hook=\(self.ptyBuffer.isHookRegistered ? "YES" : "NO", privacy: .public)")
        #endif
        ptyBuffer.append(data)
    }

    private let api: ApiClient
    private let conn: ConnectionManager
    private let auth: AuthStore
    private let sessionId: String
    private var pollTask: Task<Void, Never>?
    private var ws: WSClient?
    /// 입력 전송 표면화 상태 머신 (ptyInputDelivery 의 백킹).
    /// - inputDeliveryFailed: 드랍된 입력이 있고 아직 복구 미확인.
    /// - wsConnected: WSClient 의 연결 상태(onConnectionChange 콜백으로 갱신).
    /// - inputBannerShownAt / inputBannerClearTask: 최소 표시시간 히스테리시스 — 빠른
    ///   끊김↔복구 토글에서 배너가 깜빡이지 않게 한다.
    private var inputDeliveryFailed = false
    private var wsConnected = true
    private var inputBannerShownAt: Date?
    private var inputBannerClearTask: Task<Void, Never>?
    /// 한 번 뜬 배너가 적어도 이만큼은 떠 있게 — 즉각 복구에도 깜빡임 방지.
    private static let inputBannerMinDisplaySec: TimeInterval = 1.6
    /// WS push 신호를 받으면 wake() 해서 polling loop 가 즉시 한 번 더 돌게 한다.
    /// 공용 헬퍼 (`WakeBox` + `sleepUntilWakeOrTimeout`) 사용.
    private let wakeBox = WakeBox()
    /// 변경 파일 카운트 (`gitStatus`) 전용 독립 polling. 옛 구현은 messages 가 도착한
    /// poll cycle 안에서만 status 를 갱신해서, 사용자가 외부 에디터(VS Code 등) 에서 파일을
    /// 만지면 daemon messages 흐름이 없어 칩이 영영 stale 했다 (사용자 보고 2026-05). 분리.
    private var gitStatusTask: Task<Void, Never>?
    private let gitStatusWakeBox = WakeBox()
    /// 증분 fetch 용 — 마지막으로 받은 message 의 created_at. 다음 polll 의 afterCreatedAt.
    /// 0 이면 콜드(첫 진입) — 이때만 tail 캡(limit)을 건다.
    private var lastCreatedAt: Int64 = 0
    /// 콜드 진입에서 한 번에 받을 메시지 상한 (session_history_v1 daemon 만 해석, 옛 daemon 무시).
    /// 긴 PTY 세션의 무한 누적 pty_chunk 를 전부 내려받던 ~5s 콜드 로드를 최신 tail 로 제한한다.
    /// 옛 daemon 은 limit 을 무시하고 전체를 반환하므로 회귀 없음(느릴 뿐).
    private static let coldMessageLimit = 600
    /// 콜드 tail 캡으로 잘린 첫 청크의 잔여 SGR 속성(색/볼드)이 새지 않게, 화면 속성만 한 번
    /// 리셋(ESC[0m)했는지. 팔레트/모드/화면은 안 건드려 라이트/다크 테마에 영향 없음.
    private var didSeedColdReset = false
    private var seenMessageIds: Set<String> = []
    /// 낙관적으로 그려둔 user 말풍선의 localId FIFO 큐 — 서버 echo 가 도착하면 가장
    /// 오래된 항목을 server id 로 swap.
    private var pendingSends: [String] = []

    /// items 배열 상한. 한 세션이 1000+ turn 쌓이면 SwiftUI diff/렌더 비용 + Set lookup
    /// 누적 비용. 메모리 자체는 작지만 ForEach diff 가 매 refresh 마다 N 번 돌아 누적된다.
    private let maxItems: Int = 500

    init(api: ApiClient, conn: ConnectionManager, sessionId: String) {
        self.api = api
        self.conn = conn
        self.auth = api.auth
        self.sessionId = sessionId
    }

    // 이전엔 사용자가 명시적으로 호출하는 reconnect() 가 있었지만 — 폴링이 transport 실패시
    // tor.resetCircuits() 와 deepRestart() 까지 단계적으로 자동 시도하므로 사용자가 누를
    // 일이 없었다. 세션 상세의 «새로고침/재연결» 버튼과 함께 제거됨. 회복이 정말 안 되면
    // 사용자는 ConnectionError 화면 또는 앱 재시작으로 처리한다.

    /// 세션 이름(title) 변경. 빈 문자열을 넣으면 서버가 NULL 로 저장해 "제목 없음" 표시로 돌아간다.
    /// 낙관적 업데이트 없이 서버 응답으로만 갱신 — 실패하면 UI 가 옛 이름을 유지하므로 안전하다.
    /// - Returns: 성공 여부. 실패 시 lastError 에 메시지가 들어간다.
    @discardableResult
    func rename(_ title: String?) async -> Bool {
        let trimmed = title?.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            let updated = try await api.updateSession(sessionId, title: trimmed)
            currentSession = updated
            return true
        } catch {
            self.lastError = (error as? LocalizedError)?.errorDescription ?? "\(error)"
            return false
        }
    }

    /// 토큰 잔량 in-flight 가드 — 메뉴를 빠르게 여닫아도 중복 요청 안 나가게.
    private var usageLoadInFlight = false

    /// 세션 agent 의 토큰 잔량 조회 — ChatView 진입 시 + 더보기 메뉴 열 때 호출.
    /// daemon 이 60s 캐시하므로 부담 없이 매번 불러도 된다.
    func loadAgentUsage() {
        guard !usageLoadInFlight else { return }
        usageLoadInFlight = true
        Task {
            defer { usageLoadInFlight = false }
            do {
                agentUsage = try await api.agentUsage(sessionId: sessionId)
            } catch let e as ApiError {
                if case .httpStatus(404, _) = e {
                    // 구 daemon — 라우트 자체가 없음. 미지원으로 고정해 UI 를 숨긴다.
                    agentUsage = AgentUsageResponse(
                        supported: false, windows: [], fetchedAt: nil, error: nil,
                    )
                } else if agentUsage == nil, !ApiError.isCancellation(e) {
                    // 첫 조회 실패 — «조회 불가» 한 줄을 띄울 수 있게 error 상태로.
                    // 이미 받은 데이터가 있으면 stale 값을 유지한다 (다음 열기에 재시도).
                    agentUsage = AgentUsageResponse(
                        supported: true, windows: [], fetchedAt: nil,
                        error: e.errorDescription,
                    )
                }
            } catch {
                // 비-ApiError (취소 등) — 상태 안 바꿈. 다음 메뉴 열기가 재시도.
            }
        }
    }

    /// 세션 단위 알림(Discord) 음소거 토글. 여러 세션을 동시에 굴릴 때 시끄러운 세션만 골라 끈다.
    /// rename 과 같은 패턴 — 낙관적 업데이트 없이 서버 응답으로만 갱신한다. 폴링이 중간에
    /// currentSession 을 옛 값으로 덮어도 PATCH 응답이 마지막에 최종값을 박아 일관성 유지.
    /// - Returns: 성공 여부. 실패 시 lastError 에 메시지가 들어간다.
    @discardableResult
    func setNotifyMuted(_ muted: Bool) async -> Bool {
        do {
            let updated = try await api.setSessionNotifyMuted(sessionId, muted: muted)
            currentSession = updated
            return true
        } catch {
            self.lastError = (error as? LocalizedError)?.errorDescription ?? "\(error)"
            return false
        }
    }

    /// 「다음 정지 시 알림」 1회성 수동 구독 토글. 12초 idle 휴리스틱이 놓치는 «조용히 멈춘»
    /// 세션을 사람이 메우는 안전장치 — 켜면 그 세션의 다음 정지를 더 민감하게 잡아 알림한다.
    /// 낙관적으로 armed 를 세팅하고 서버 적용 결과로 보정 (활성 PTY 없으면 false=적용 불가).
    /// - Returns: 적용 여부. 실패/적용 불가 시 lastError 또는 armed=false 로 피드백.
    @discardableResult
    func setNotifyNextStop(_ enabled: Bool) async -> Bool {
        notifyNextStopArmed = enabled  // 낙관적 — 서버 응답/폴링이 곧 보정.
        do {
            let applied = try await api.setSessionNotifyNextStop(sessionId, enabled: enabled)
            notifyNextStopArmed = enabled && applied
            return applied
        } catch {
            notifyNextStopArmed = false
            self.lastError = (error as? LocalizedError)?.errorDescription ?? "\(error)"
            return false
        }
    }

    /// 터미널(PTY) 강제 재시작 — 멈춘 REPL 을 죽이고 새 PTY 로 깨끗하게 다시 시작.
    ///
    /// 동작:
    ///   - 서버가 같은 호출 안에서 새 PTY 를 즉시 prewarm — 사용자 입력 없이도 곧장 splash 가 흐른다.
    ///   - 로컬은 SwiftTerm 의 화면/스크롤백까지 ANSI 시퀀스로 비워 "지웠던 게 돌아오는" 회귀 방지.
    ///
    /// - Returns: 서버 호출 성공 여부. 실패 시 로컬 상태는 건드리지 않아 사용자가 재시도할 수 있다.
    @discardableResult
    func restartPty() async -> Bool {
        do {
            try await api.restartPty(sessionId: sessionId)
        } catch {
            self.lastError = (error as? LocalizedError)?.errorDescription ?? "\(error)"
            return false
        }
        // 서버가 깨끗해진 뒤 로컬 상태 정리 — 폴링/WS 가 옛 청크를 다시 채우지 못하게 한다.
        items.removeAll()
        seenMessageIds.removeAll()
        pendingSends.removeAll()
        ptyBuffer.reset()
        isAwaitingReply = false
        isSending = false
        lastError = nil
        lastCreatedAt = 0
        didSeedColdReset = false
        // SwiftTerm 화면을 ANSI 시퀀스로 즉시 비운다.
        //   ESC c       — RIS (full terminal reset, 색/모드 포함)
        //   ESC [ 3 J   — scrollback 영역 erase (xterm 확장)
        // ptyBuffer.reset() 직후라 이 6 바이트가 새 시작점. 직후 도착하는 새 PTY splash 청크는
        // 이어 붙어 깨끗한 첫 화면으로 그려진다.
        let clearSeq = Data([0x1B, 0x63, 0x1B, 0x5B, 0x33, 0x4A])
        appendPtyBytes(clearSeq)
        return true
    }

    deinit {
        // 안전망 — 정상 정리는 ChatView 의 .task(id:) 가 취소될 때 부르는 stop() 이 한다.
        // deinit 은 MainActor 격리 밖이라 ws.stop()(MainActor) 은 직접 못 부르지만, Task 들은
        // Sendable 이라 어디서든 cancel 가능하므로 둘 다 끊어 둔다. (옛 코드는 pollTask 만
        // 끊어 gitStatusTask 가 새던 자리.)
        pollTask?.cancel()
        gitStatusTask?.cancel()
        #if DEBUG
        NSLog("[ChatVM] deinit sessionId=\(sessionId)")
        #endif
    }

    func start() {
        pollTask?.cancel()
        pollTask = Task { [weak self] in
            await self?.pollLoop()
        }
        // 미리보기/산출물 capability 1회 조회 — «결과» 진입점 노출 게이트. 실패/구 daemon 은 false 유지.
        Task { [weak self] in
            guard let self else { return }
            if let info = try? await self.api.getServerVersion(label: nil) {
                self.supportsArtifacts = info.supportsArtifacts
                self.supportsScreenCapture = info.supportsScreenCapture
                self.supportsRemoteControl = info.supportsRemoteControl
                self.supportsScreenH264 = info.supportsScreenH264
                self.supportsScreenShot = info.supportsScreenShot
                self.supportsWindowTarget = info.supportsWindowTarget
                self.supportsMultiPortPreview = info.supportsMultiPortPreview
            }
        }
        // 레포 컨텍스트(브랜치 + 변경 파일 수)는 별도 loop — 외부 에디터/터미널의 git init·
        // 편집까지 따라잡으려면 messages 와 독립적으로 5s 주기로 폴링해야 한다. 첫 iteration 이
        // 즉시 한 번 fetch 해 진입 직후 칩이 채워진다.
        gitStatusTask?.cancel()
        gitStatusTask = Task { [weak self] in
            await self?.gitStatusLoop()
        }
        // WS 가동 — push 신호를 받으면 wake() 가 호출돼 polling 이 즉시 한 번 더 돈다.
        // sinceProvider: WS 재연결 시 daemon 에 «마지막 본 created_at» 을 보내 그 이후
        // pty_chunk 를 즉시 unicast backfill 받음 (ws_catchup_v1). 백그라운드 복귀 latency
        // 가 polling 주기 (1~5s) 만큼 잘리던 갭이 한 RTT 로 줄어든다.
        if ws == nil {
            ws = WSClient(
                auth: auth,
                conn: conn,
                sessionId: sessionId,
                sinceProvider: { [weak self] in self?.lastCreatedAt },
                onConnectionChange: { [weak self] connected in
                    self?.handleWSConnectionChange(connected)
                },
            ) { [weak self] event in
                self?.handleWSEvent(event)
            }
        }
        ws?.start()
    }

    func stop() {
        pollTask?.cancel()
        pollTask = nil
        gitStatusTask?.cancel()
        gitStatusTask = nil
        ws?.stop()
        // 입력 표면화 배너 상태도 초기화 — 재진입 시 stale 배너 방지.
        clearInputDelivery()
        wsConnected = true
        // 잠든 sleep 슬롯들을 즉시 깨워 두 loop 가 빠져나오게 한다.
        wakeBox.wake()
        gitStatusWakeBox.wake()
    }

    /// 폴링·git status·WebSocket 의 가동/정리를 뷰 수명에 «구조적으로» 묶는 단일 진입점.
    /// ChatView 가 `.task(id: session.id)` 안에서 이 메서드를 await 한다.
    ///
    /// 왜 이게 필요한가: 이전엔 onAppear→start() / onDisappear→stop() 이었는데, SwiftUI 의
    /// NavigationStack 은 빠른 push/pop 에서 onDisappear 를 누락/경합시키는 게 알려진 동작이라
    /// stop() 이 안 불리는 경우가 생겼다. 그러면 pollLoop/gitStatusLoop (실행 중인 인스턴스
    /// 메서드라 self 를 강하게 retain) + WS 가 좀비로 살아남아 채팅방 진입/이탈을 반복할수록
    /// 누적 → 메인 스레드 포화/메모리 압박으로 앱이 크래시했다.
    ///
    /// `.task(id:)` 는 뷰가 사라지거나 id 가 바뀌면 SwiftUI 가 «반드시» 이 Task 를 cancel 한다
    /// (구조적 동시성 보장). 그 취소 신호로 stop() 을 호출하므로 정리 누락이 원천 차단된다.
    func runUntilCancelled() async {
        start()
        // 취소될 때까지 대기 — 뷰가 사라지면 .task 가 cancel 되고 Task.sleep 이 즉시 throw →
        // 루프를 빠져나가 아래 stop() 이 실행된다. 취소가 아니면 길게 자며 깨어날 일이 없다.
        while !Task.isCancelled {
            try? await Task.sleep(nanoseconds: 60_000_000_000)
        }
        stop()
    }

    /// 백그라운드 60s+ 후 foreground 복귀 시 호출. 폴링 즉시 한 번 더 돌리고 WS 도
    /// 강제 재연결 — 서버측 idle timeout 으로 끊겼을 가능성이 있는 WS 가 다음 폴링
    /// cycle 까지 기다리지 않게.
    func reawake() {
        NSLog("[ChatVM] reawake — wake + WS kick")
        ws?.kick()
        wakeBox.wake()
        // 외부 에디터에서 백그라운드 동안 파일을 만졌을 가능성 — git status 도 즉시.
        gitStatusWakeBox.wake()
    }

    /// 앱 foreground/background 전환을 WS 로 전달 — daemon 의 away-gating 제어용.
    /// background 면 daemon 이 «안 보는 중» 으로 판정해 Discord 알림을 다시 내보낸다.
    /// ChatView 가 `.onChange(of: lifecycle.isActive)` 로 호출.
    func setForeground(_ isForeground: Bool) {
        ws?.setForeground(isForeground)
    }

    /// WS push 이벤트 처리 — payload 자체는 무시하고 "지금 즉시 refresh 해라" 신호로만.
    /// 동일 메시지가 polling 사이클에도 들어오므로 중복 처리는 seenMessageIds 가 막아준다.
    private func handleWSEvent(_ event: WSClient.Event) {
        switch event {
        case .turnComplete:
            // PTY runner 의 12s idle 추정이 «턴 끝 = 사용자 차례» 를 push — 대기 배너 on.
            agentAwaitingUser = true
            wake()
        case .userMessage, .stream:
            wake()
        case .error(let message):
            // 서버측 turn error — 다음 refresh 가 result/error 메시지를 가져올 것.
            // lastError 는 transport 실패에만 박는다 (서버 응답 자체는 정상이라).
            NSLog("[ChatVM] server error event: \(message)")
            wake()
        case .ptyOutput(let id, let bytes):
            // 같은 chunk 가 곧 polling 의 pty_chunk row 로도 들어온다. WS 가 먼저 도착하는
            // 게 일반적이므로 여기서 seenMessageIds 에 id 를 미리 박아 폴링 경로에서 dedup.
            // 이 가드가 없으면 같은 raw bytes 가 SwiftTerm 에 두 번 feed 되어 ANSI cursor up
            // 시퀀스가 어긋나며 라인이 위로 밀려 보인다.
            if seenMessageIds.insert(id).inserted {
                appendPtyBytes(bytes)
            }
            // 출력이 흐른다 = 에이전트가 다시 일하는 중이거나 사용자가 타이핑(echo) 중 —
            // 어느 쪽이든 «기다리는 중» 배너는 내린다.
            agentAwaitingUser = false
            wake()
        case .ptyExit:
            isAwaitingReply = false
            agentAwaitingUser = false
            wake()
        case .screenFrame, .screenVideo, .captureStatus, .captureDisplays, .captureWindows, .captureTarget, .controlStatus:
            // 화면 캡처/제어는 RemoteScreenView 의 전용 WSClient 가 처리 — ChatView 폴링과 무관, 무시.
            break
        case .sessionEvent:
            // 글로벌 대기 알림용 신호 — AgentWaitNotifier(글로벌 WSClient)가 전담한다.
            // 세션 스코프 클라이언트는 자기 세션의 turn_complete 를 이미 별도로 받으므로 무시
            // (다른 세션 이벤트로 불필요하게 polling 을 깨우지 않는다).
            break
        case .unknown:
            // 미래 이벤트 타입 — 일단 깨우기만.
            wake()
        }
    }

    /// 폴링 루프의 sleep 을 즉시 깨운다. 여러 번 호출되어도 안전.
    private func wake() {
        wakeBox.wake()
    }

    private func pollLoop() async {
        // 최초 진입 시 한 번에 가져와 초기 렌더 — Tor 경유라 2~3초 걸리는 동안
        // 화면이 멈춘 건지 통신을 기다리는 중인지 사용자가 알 수 있도록
        // 공통 in-flight 배너에 노출되는 라벨을 붙인다.
        await coldLoad()
        while !Task.isCancelled {
            // Adaptive polling 간격 — WS push 가 들어오면 wakeBox 가 sleep 을 즉시
            // 깨므로 어차피 빠르게 반응한다. 이 timeout 은 WS 가 죽어 있을 때의
            // 최대 stale window:
            //  - isAwaitingReply (모델이 답을 만들고 있는 중) → 2s. 사용자 체감 응답성 우선.
            //  - idle (turn 끝남, 새 입력 대기) → 15s. WS push 가 fallback 으로 충분.
            //    Tor RTT 비용을 줄여 배터리/회로 부담 완화.
            let interval: Double = isAwaitingReply ? 2 : 15
            await sleepUntilWakeOrTimeout(seconds: interval, box: wakeBox)
            if Task.isCancelled { break }
            await refresh()
            // burst 코알레스 — 모델이 토큰 100개 stream 하면 WS push 100건이 거의 연속해서
            // 도착한다. 여기서 200ms quiet window 를 두면 첫 fetch 가 끝난 직후의 후속 push
            // 들이 WakeBox.pending 으로 쌓이고, 다음 arm() 이 한 번에 통과해 하나의 fetch 가
            // 누적된 모든 토큰을 가져온다. Tor RTT (~400–1200ms) 보다 짧으므로 사용자가
            // 느끼는 추가 지연은 무시 가능. 결과: 100건 push → 2~3 fetch (이전엔 ~100 fetch).
            if Task.isCancelled { break }
            try? await Task.sleep(nanoseconds: 200_000_000)
        }
    }

    /// 콜드(첫 진입) 로드. 화면 스냅샷(pty_snapshot_v1)을 우선 시도해 긴 PTY 세션도 O(화면)
    /// 으로 즉시 복원하고, 실패/미지원(옛 daemon 404)이면 P1 tail 캡 콜드 poll 로 폴백한다.
    private func coldLoad() async {
        let label = String(localized: "대화 불러오는 중")
        if await tryColdSnapshot(label: label) {
            // 스냅샷이 watermark 까지 그렸다 → 이후만 증분으로 잇는다(메타 동기화 + 신규 청크).
            // lastCreatedAt 이 0 이 아니라 refresh 는 증분 경로를 탄다(tail 캡 안 함).
            await refresh(label: label)
            return
        }
        await refresh(label: label)
    }

    /// 화면 스냅샷을 받아 SwiftTerm 에 즉시 그린다. 성공하면 lastCreatedAt 을 watermark 로 올려
    /// 이후 증분이 같은 청크를 이중 렌더하지 않게 한다. 옛 daemon(404)/빈 스냅샷이면 false.
    private func tryColdSnapshot(label: String) async -> Bool {
        guard let snap = try? await api.ptySnapshot(sessionId, label: label),
              !snap.snapshot.isEmpty,
              let data = snap.snapshot.data(using: .utf8) else { return false }
        // fresh 터미널 가정으로 직렬화된 바이트라 그대로 feed 하면 화면+scrollback 이 복원된다.
        appendPtyBytes(data)
        didSeedColdReset = true
        // watermark 이후만 증분 — refresh 가 afterCreatedAt 로 쓴다.
        lastCreatedAt = snap.throughCreatedAt
        return true
    }

    /// 매핑된 ChatItem 한 개를 items 에 반영한다.
    ///
    /// PTY 모드는 SwiftTerm 이 화면을 그리므로 items 에는 거의 들어가지 않는다 — pty_chunk 는
    /// raw bytes buffer 로만 흘려보내고 items 에는 추가 X. SDK 모드는 기존대로 .user 말풍선
    /// swap + 일반 append.
    private func applyChatItem(_ item: ChatItem, rowId: String) {
        switch item {
        case .ptyChunk(_, let b64):
            if let data = Data(base64Encoded: b64) {
                appendPtyBytes(data)
            }
            return

        case .user(_, let text):
            // SDK 모드 사용자 echo — 낙관적 풍선 swap.
            if let firstLocalId = pendingSends.first,
               let idx = items.firstIndex(where: { $0.id == firstLocalId }) {
                items[idx] = .user(id: rowId, text: text)
                pendingSends.removeFirst()
            } else {
                items.append(item)
            }
            return

        default:
            items.append(item)
        }
    }

    /// items 가 maxItems 를 초과하면 가장 오래된 것부터 silent 삭제.
    /// 사용자에겐 별도 알림 X — SwiftUI ScrollView 가 보이는 영역만 LazyVStack 으로
    /// 렌더하므로 시각적 변화 거의 없다.
    private func enforceItemsCap() {
        let overflow = items.count - maxItems
        guard overflow > 0 else { return }
        items.removeFirst(overflow)
        NSLog("[ChatVM] items 캡 도달 — 오래된 %d 개 제거 (남은 %d)",
              overflow, items.count)
    }

    /// 세션의 git 브랜치를 한 번 fetch — 실패/없음은 모두 nil 로 흡수.
    /// daemon `session_git_branch_v1` 미지원 (옛 데몬 페어링) 시에도 silently 무시.
    private func refreshGitBranch() async {
        // try? 로 뭉뚱그리지 않고 throw 를 구분한다: 호출이 «성공» 했을 때만 (branch 가
        // name 이든 null 이든) gitBranchLoaded 를 세워, 네트워크/미지원 실패를 «git 아님» 으로
        // 오인해 안내를 띄우는 일을 막는다.
        do {
            let name = try await api.gitBranch(sessionId: sessionId)
            // 같은 값이면 publish 안 함 — SwiftUI 가 불필요한 re-render 하지 않게.
            if branchName != name {
                branchName = name
            }
            if !gitBranchLoaded {
                gitBranchLoaded = true
            }
        } catch {
            // 일시적 실패 / 옛 데몬 미지원 — 로딩 완료로 치지 않고 다음 cycle 에 재시도. 기존 값 유지.
        }
    }

    /// 변경 파일 카운트 전용 polling — 5s 주기로 독립적으로 돌면서 외부 에디터 (VS Code 등)
    /// 편집까지 따라간다.
    ///
    /// 왜 별도 loop 인가:
    ///   - 메시지 polling 의 idle interval 은 15s. AI 응답이 없을 때 그 안에 묻혀 두면
    ///     사용자가 외부에서 코드를 만지고 다시 앱으로 와도 칩이 15s 동안 stale.
    ///   - daemon 이 FS-watch 로 WS push 해 주면 이상적이지만 그건 daemon 측 별도 작업.
    ///     5s polling 이 worst-case 상한 — 사용자 체감 «즉시 반응» 의 경계선.
    ///   - 같은 응답이면 publish 안 하므로 SwiftUI re-render 비용 0.
    ///
    /// wake 시점:
    ///   - reawake() : foreground 복귀.
    ///   - refresh() 에서 messages 도착: AI 가 파일을 만졌을 가능성 → 다음 5s 까지 안 기다림.
    private func gitStatusLoop() async {
        // 즉시 한 번 — 채팅방 진입 후 칩이 5s 늦게 뜨지 않도록.
        await refreshRepoContext()
        while !Task.isCancelled {
            await sleepUntilWakeOrTimeout(seconds: 5, box: gitStatusWakeBox)
            if Task.isCancelled { break }
            await refreshRepoContext()
        }
    }

    /// 상태바의 «레포 컨텍스트» (브랜치 + 변경 파일 수) 를 함께 한 번 fetch.
    /// 브랜치도 여기서 5s 주기로 폴링한다 — 옛 구현은 브랜치를 진입 시 + 새 메시지 도착 시
    /// 에만 갱신해서, 외부 터미널/에디터에서 `git init` (또는 branch checkout) 해도 칩이
    /// 「Git 없음」/옛 브랜치로 고착되던 버그가 있었다. 둘 다 같은 응답이면 publish 안 함.
    private func refreshRepoContext() async {
        await refreshGitBranch()
        await refreshGitStatus()
    }

    /// 세션 repo_path 의 변경 파일 목록을 한 번 fetch — 실패/미지원은 nil 로 흡수해 UI 슬롯을 숨긴다.
    /// 같은 응답이면 publish 안 함 (DiffSheet 가 떠 있을 때 불필요한 list redraw 방지).
    func refreshGitStatus() async {
        let status = try? await api.gitStatus(sessionId: sessionId)
        if gitStatus != status {
            gitStatus = status
        }
    }

    /// 한 파일의 unified diff 본문 — DiffSheet 의 상세 화면이 lazy 로 호출한다.
    /// 실패 시 nil. 사용자가 시트 안에서 안내 메시지로 흡수.
    func loadFileDiff(path: String) async -> GitFileDiffResponse? {
        try? await api.gitDiff(sessionId: sessionId, path: path)
    }

    /// FileBrowserSheet — 디렉토리 listing. 실패/미지원은 nil. 빈 path 는 repo root.
    func loadDirectory(path: String) async -> DirectoryListing? {
        try? await api.listDirectory(sessionId: sessionId, path: path)
    }

    /// FileBrowserSheet — 파일 본문. 텍스트/이미지/바이너리는 응답의 encoding/contentType 으로 분기.
    /// daemon cap (텍스트 1MB / 그 외 5MB) 초과면 too_large 에러로 nil 반환.
    func loadFile(path: String) async -> FileContent? {
        try? await api.readFile(sessionId: sessionId, path: path)
    }

    /// 이미지 diff 의 «변경 전» — HEAD 의 같은 path. 신규 파일 / HEAD 없음 / 권한 부족이면 nil.
    func loadGitBlob(path: String, ref: String = "HEAD") async -> FileContent? {
        try? await api.readGitBlob(sessionId: sessionId, path: path, ref: ref)
    }

    // MARK: - 브랜치 / worktree (BranchSheet)

    /// 로컬 + 원격 브랜치 목록 — 시트 진입/새로고침 시 호출. 실패/미지원/비-repo 는 nil.
    func loadBranches() async -> GitBranchesResponse? {
        try? await api.gitBranches(sessionId: sessionId)
    }

    /// worktree 목록. 실패/미지원/비-repo 는 nil.
    func loadWorktrees() async -> GitWorktreesResponse? {
        try? await api.gitWorktrees(sessionId: sessionId)
    }

    // 아래 mutating 동작들은 lastError(채팅 화면엔 노출 안 됨) 대신 throw 로 실패를 알린다 —
    // BranchSheet 가 GitOperationError 의 localize 된 메시지를 자기 화면에 직접 띄운다.

    /// 브랜치 전환. 성공 시 상태바 칩(브랜치/변경수)을 즉시 갱신. 실패는 throw.
    func checkoutBranch(name: String, track: Bool = false) async throws {
        try await api.checkoutBranch(sessionId: sessionId, name: name, track: track)
        await refreshRepoContext()
    }

    /// 새 브랜치 생성(+옵션 전환). 성공 시 상태바 갱신. 실패는 throw.
    func createBranch(name: String, from: String? = nil, checkout: Bool = false) async throws {
        try await api.createBranch(sessionId: sessionId, name: name, from: from, checkout: checkout)
        await refreshRepoContext()
    }

    /// 브랜치 삭제(로컬). 병합 안 됨 등으로 1차 실패하면 호출부가 force:true 로 재시도한다.
    /// 현재 브랜치는 삭제 대상이 아니므로 상태바 갱신은 불필요. 실패는 throw.
    func deleteBranch(name: String, force: Bool = false) async throws {
        try await api.deleteBranch(sessionId: sessionId, name: name, force: force)
    }

    /// worktree 생성 — daemon 이 산정한 경로의 GitWorktree 를 돌려준다. 실패는 throw.
    func addWorktree(branch: String, newBranch: Bool, from: String? = nil) async throws -> GitWorktree {
        try await api.addWorktree(
            sessionId: sessionId,
            branch: branch,
            newBranch: newBranch,
            from: from,
        )
    }

    /// worktree 삭제. dirty/locked 로 1차 실패하면 호출부가 force:true 로 재시도한다. 실패는 throw.
    func removeWorktree(path: String, force: Bool = false) async throws {
        try await api.removeWorktree(sessionId: sessionId, path: path, force: force)
    }

    /// worktree 경로로 새 세션을 만들고 그 SessionSummary 를 돌려준다 — 현재 세션의
    /// agent/«도구 자동 승인» 설정을 이어받는다. 호출부가 그 세션으로 새 채팅을 띄운다.
    /// title 은 보통 worktree 의 브랜치 이름 — 「제목 없음」 대신 어느 worktree 인지 바로 알아보게.
    func makeSessionInWorktree(path: String, title: String?) async throws -> SessionSummary {
        let agent = currentSession?.agent
        let skip = (currentSession?.skip_permissions ?? 0) == 1
        let newId = try await api.createSession(
            repoPath: path,
            title: title,
            skipPermissions: skip,
            mode: "pty",
            agent: agent,
        )
        return try await api.getSession(newId).session
    }

    // MARK: - 머지 큐 (BranchSheet «머지 큐» 섹션)

    /// 이 세션 레포의 머지 큐(목록 + 상태 요약). 실패/비-repo/구 daemon 은 nil.
    func loadMergeQueue() async -> MergeQueueResponse? {
        guard let repo = currentSession?.repo_path else { return nil }
        return try? await api.mergeQueue(repoPath: repo)
    }

    /// 머지 요청 enqueue — 직접 머지하지 않고 daemon 직렬 큐에 적재. 실패는 throw(BranchSheet 가 표시).
    @discardableResult
    func enqueueMerge(source: String, target: String) async throws -> MergeRequest {
        try await api.enqueueMerge(sessionId: sessionId, sourceBranch: source, targetBranch: target)
    }

    /// 머지 사전 충돌 미리보기 — 읽기 전용(repo 무변경, 저소음). 실패/비-repo/구 daemon 은 nil(graceful).
    /// source==target 이면 의미 없으니 호출을 생략한다.
    func previewMerge(source: String, target: String) async -> MergePreview? {
        guard source != target else { return nil }
        return try? await api.previewMerge(sessionId: sessionId, sourceBranch: source, targetBranch: target)
    }

    /// 충돌/실패 머지 재시도.
    func retryMerge(id: String) async throws {
        _ = try await api.retryMerge(id: id)
    }

    /// 머지 요청 취소/삭제.
    func cancelMerge(id: String) async throws {
        try await api.cancelMerge(id: id)
    }

    // MARK: - 커밋 (CommitsView)

    /// 커밋 로그 한 페이지. ref=nil 이면 현재 HEAD. 실패/비-repo 는 nil.
    func loadCommits(ref: String?, limit: Int, skip: Int) async -> GitCommitsResponse? {
        try? await api.gitCommits(sessionId: sessionId, ref: ref, limit: limit, skip: skip)
    }

    /// 체크포인트 타임라인 한 페이지 — daemon 이 `checkpoint(ps):` 커밋만 추려 돌려준다.
    /// 실패/비-repo 는 nil. CheckpointsView 가 호출.
    func loadCheckpoints(limit: Int, skip: Int) async -> GitCommitsResponse? {
        try? await api.gitCommits(sessionId: sessionId, limit: limit, skip: skip, checkpointsOnly: true)
    }

    /// 한 커밋의 메타 + 변경 파일. 실패는 nil.
    func loadCommitDetail(sha: String) async -> GitCommitDetail? {
        try? await api.gitCommitDetail(sessionId: sessionId, sha: sha)
    }

    /// 한 커밋이 한 파일에 가한 변경만의 diff. 실패는 nil.
    func loadCommitDiff(sha: String, path: String) async -> GitFileDiffResponse? {
        try? await api.gitCommitDiff(sessionId: sessionId, sha: sha, path: path)
    }

    // MARK: - 체크포인트 (git 쓰기)

    /// 에이전트가 «실행 중»(메시지 전송 직후 ~ 모델이 답을 만드는 중)인지. 되돌리기 잠금 게이트.
    /// agentAwaitingUser(모델이 나를 기다림)는 «실행 중» 이 아니므로 잠그지 않는다.
    var isAgentBusy: Bool { isSending || isAwaitingReply }

    /// 체크포인트(작업트리 스냅샷) 커밋을 만든다. 성공 시 변경수 칩이 0 으로 바뀌게 상태바 갱신.
    /// 실패는 throw — 호출부(ChatView)가 안내문을 띄운다.
    @discardableResult
    func createCheckpoint(note: String? = nil) async throws -> GitCheckpointResult {
        let result = try await api.createCheckpoint(sessionId: sessionId, note: note)
        await refreshRepoContext()
        return result
    }

    /// 체크포인트로 되돌린다. mode="revert"(비파괴) / "reset"(파괴). daemon 이 먼저 자동
    /// 체크포인트를 남긴다. 성공 시 상태바 갱신. 실패는 throw.
    @discardableResult
    func rollback(sha: String, mode: String) async throws -> GitRollbackResult {
        let result = try await api.rollbackToCheckpoint(sessionId: sessionId, sha: sha, mode: mode)
        await refreshRepoContext()
        return result
    }

    /// 세션 상세를 한 번 갱신한다.
    /// - Parameter label: nil 이면 폴링용(트래커 노이즈 없음).
    ///   사용자가 명시적으로 트리거한 호출(최초 진입/재연결)은 라벨을 넣어
    ///   공통 in-flight 배너에 통신 진행 상태가 보이게 한다.
    ///
    /// `/poll` 엔드포인트로 messages 증분만 가져온다 (PTY 단일 모드).
    private func refresh(label: String? = nil) async {
        do {
            let isCold = lastCreatedAt == 0
            let after: Int64? = isCold ? nil : lastCreatedAt
            // 콜드 진입만 tail 캡 — 증분(after>0)은 캡하지 않는다(daemon 도 무시). 옛 daemon 은
            // limit 자체를 무시하므로 capability 게이트 없이 항상 보내도 안전(전체 반환으로 폴백).
            let resp = try await api.pollSession(
                sessionId,
                afterCreatedAt: after,
                limit: isCold ? Self.coldMessageLimit : nil,
                label: label,
            )

            // 최신 세션 요약 동기화 — title 등 메타가 바뀌면 UI 가 즉시 따라오게.
            if currentSession != resp.session {
                currentSession = resp.session
            }
            // 「다음 정지 시 알림」 무장 상태를 서버 신호로 재동기화 — daemon 이 알림을 발사하며
            // 1회성으로 소진하면(또는 PTY 종료) notify_next_stop 가 false 로 내려오므로 토글이
            // 자동으로 꺼진 것처럼 보인다. 사용자가 다른 기기에서 끈 경우도 여기서 따라잡는다.
            if notifyNextStopArmed != resp.session.notifyNextStop {
                notifyNextStopArmed = resp.session.notifyNextStop
            }

            // 콜드 tail 캡으로 잘렸으면(hasMoreBefore) 잘린 첫 청크의 잔여 SGR 속성이 새지 않게
            // 화면 속성만 한 번 리셋(ESC[0m) — 팔레트/모드/화면 버퍼는 안 건드려 테마 안전.
            // 첫 pty_chunk 보다 «먼저» buffer 에 들어가야 하므로 메시지 루프 직전에 주입한다.
            if isCold, resp.hasMoreBefore == true, !didSeedColdReset {
                didSeedColdReset = true
                appendPtyBytes(Data([0x1b, 0x5b, 0x30, 0x6d])) // ESC [ 0 m
            }

            // 메시지 증분 적용.
            for row in resp.messages where !seenMessageIds.contains(row.id) {
                seenMessageIds.insert(row.id)
                let mapped = ChatItemMapper.map(row)

                for item in mapped {
                    applyChatItem(item, rowId: row.id)
                }

                // turn_complete (result) 또는 pty_exit 가 도착하면 대기 상태 해제.
                // PTY 는 turn 종료 신호가 따로 없어 — 응답 stream 의 마지막이 모호 — 그래도
                // exit 시점엔 풀어주고, 사용자가 다음 입력을 보낼 때 다시 isAwaitingReply 가 켜진다.
                // PTY 모드 한정 — 첫 chunk 가 도착했으면 모델이 응답 시작했다는 신호로 보고
                // thinking dots 를 내림 (SDK 의 turn_complete 와 비슷한 휴리스틱).
                if mapped.contains(where: {
                    switch $0 {
                    case .turnComplete, .ptyChunk: return true
                    default:                        return false
                    }
                }) {
                    isAwaitingReply = false
                }
                // 폴링으로 들어온 새 출력 청크도 «출력 재개» — WS 가 죽어 있을 때의
                // 대기 배너 끄기 경로 (WS .ptyOutput 처리와 동일한 의미).
                if mapped.contains(where: {
                    if case .ptyChunk = $0 { return true } else { return false }
                }) {
                    agentAwaitingUser = false
                }
            }
            // 다음 poll 의 afterCreatedAt — 서버가 전체 또는 증분에 맞춰 알려준다.
            lastCreatedAt = resp.nextCreatedAt

            // 대기 배너 «켜기» 의 폴링 fallback — WS 가 죽어 있거나 콜드 진입(목록/딥링크)
            // 직후에도 daemon 의 waiting_since 로 켠다. 끄는 쪽은 이벤트만 (선언부 주석).
            // 메시지 루프 «뒤» 에서 — waiting_since 는 daemon 이 이 응답의 메시지 수집 후
            // 계산한 최신 판정이라, 같은 배치의 옛 청크가 끄는 것을 다시 덮는 게 맞다.
            if resp.session.waiting_since != nil {
                agentAwaitingUser = true
            }

            // 새 메시지가 들어온 cycle 이면 레포 컨텍스트(브랜치 + 변경 파일 수) loop 를 즉시
            // 깨워 한 사이클 앞당긴다 — AI 가 파일을 만지거나 git init/checkout 한 직후 칩이
            // 5s lag 으로 갱신되던 것을 줄인다. refresh 자체는 gitStatusLoop 가 단일 수행.
            if !resp.messages.isEmpty {
                gitStatusWakeBox.wake()
            }

            // 성공 시 이전 에러 클리어 (자동 복구).
            if lastError != nil { lastError = nil }

            // items 누적 상한 — 긴 세션의 ForEach diff 비용 누적 방지.
            enforceItemsCap()
        } catch {
            // 뒤로가기 제스처로 화면을 벗어나는 순간 pollTask 가 cancel 되면서 진행 중이던
            // URLSession 요청이 `URLError(.cancelled)` 로 깨지는데, 이걸 그대로 lastError 에
            // 박으면 사라지는 화면에 "전송 실패" 빨간 배너가 잠깐 떠서 사용자가 백마다 경고를
            // 본다고 느낀다. 의도된 cancel 은 조용히 무시한다.
            if ApiError.isCancellation(error) { return }
            self.lastError = (error as? LocalizedError)?.errorDescription ?? "\(error)"
        }
    }

    /// 사용자가 입력한 메시지를 전송한다.
    /// - Returns: 전송에 성공했는지 여부. 실패하면 호출자가 입력창 텍스트를 복원해서 재시도할 수 있게 한다.
    @discardableResult
    func send(_ text: String) async -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !isSending else { return false }
        isSending = true
        isAwaitingReply = true
        // 사용자가 응답했다 — 대기 배너 즉시 내림 (낙관적: 전송 실패 시 다음 폴링이 다시 켠다).
        agentAwaitingUser = false
        defer { isSending = false }

        // 낙관적 UI: 서버 round-trip 을 기다리지 않고 내가 친 말풍선을 즉시 띄워준다.
        // Tor 경유라 echo 가 늦게 와도 "내가 보낸 명령이 사라진 것처럼" 보이지 않게.
        let localId = "local-\(UUID().uuidString)"
        items.append(.user(id: localId, text: trimmed))

        // 베타 «즉시 화면 반영» 옵션은 듀얼 채널 모델 (SSH 직접, ~10-50ms) 도입 후 제거됨.
        // 서버 echo 가 충분히 빠르게 도착해 predictive local echo 의 mismatch 글리치 비용보다
        // 가치가 작다.

        pendingSends.append(localId)

        do {
            try await api.sendMessage(sessionId, text: trimmed)
            pendingSends.removeAll(where: { $0 == localId })
            // 폴링 주기를 기다리지 않고 즉시 새로고침 — 사용자 메시지 echo 가 빨리 보이게.
            await refresh()
            return true
        } catch {
            // 실패 — 낙관적으로 그렸던 말풍선을 회수한다.
            if let idx = items.firstIndex(where: { $0.id == localId }) {
                items.remove(at: idx)
            }
            pendingSends.removeAll(where: { $0 == localId })
            self.lastError = (error as? LocalizedError)?.errorDescription ?? "\(error)"
            isAwaitingReply = false
            return false
        }
    }

    /// 이미지 첨부 업로드 — base64 이미지(들)를 세션 repo 의 `dir`(기본 attachments)에 저장하고
    /// 저장된 repo-relative 경로를 돌려준다. 호출부(ChatView)가 그 경로를 프롬프트에 매핑해 전송.
    /// 메시지 전송 자체는 PTY/SDK 분기가 있는 ChatView 가 따로 한다 (여기선 업로드만).
    func uploadAttachments(
        dir: String?,
        images: [(filename: String, data: Data)],
    ) async throws -> [SavedAttachment] {
        try await api.uploadAttachments(sessionId, dir: dir, images: images)
    }

    /// SwiftTerm.TerminalView delegate `sizeChanged` 가 호출. claude REPL 의 가상 터미널을
    /// 같은 cols/rows 로 맞춰 줄바꿈/리렌더 일치시킴.
    func sendPtyResize(cols: Int, rows: Int) async {
        do {
            try await api.resizePty(sessionId: sessionId, cols: cols, rows: rows)
        } catch {
            NSLog("[ChatVM] pty resize err: \(error.localizedDescription)")
        }
    }

    /// 가상 키보드 한 키 — ChatView 의 «플로팅 키패드» 가 호출. 다항 선택 REPL prompt 를
    /// 화살표 / Enter 로 제어. 실패는 조용히 흡수 — 사용자가 다시 누르면 됨이라 lastError
    /// 배너로 띄울 가치가 없다 (PTY 가 죽어 있는 등 일시적 상태가 대부분).
    func sendPtyKey(_ key: PtyKey) async {
        do {
            try await api.sendPtyKey(sessionId: sessionId, key: key)
        } catch {
            NSLog("[ChatVM] pty key err: \(error.localizedDescription)")
        }
    }

    /// 실시간 keystroke 채널 — PtyTerminalView.Coordinator.send 의 SwiftTerm delegate
    /// 콜백이 호출. WS 가 살아 있어야 의미. 호출 빈도가 매우 높아 (사용자가 빠르게 칠 때
    /// 1초에 5~10회) fire-and-forget detached Task 로 송신.
    nonisolated func sendKeystroke(_ bytes: Data) {
        // capture 한 weak self 를 통해 MainActor 위 ws 접근. WS send 자체는 백그라운드 OK
        // 지만 ws 인스턴스 접근은 MainActor — 그래서 Task 안에서 await.
        // KS-TRACE 진단(PS_KS_TRACE=1)은 송신 byte 를 daemon writePtyRaw 의 recv 와 대조하기
        // 위해 sendPtyInput 안에서 찍는다 — 여기선 drop 케이스만 별도로 남긴다(양끝 대조 시
        // «iOS 가 아예 안 보냈는지» 를 구분). nonisolated 진입점이라 hex 포매팅은 KSTrace 가
        // OFF 면 건너뛴다(성능 영향 0).
        Task { @MainActor [weak self] in
            guard let self else {
                KSTrace.log("send", session: nil, agent: nil, bytes: bytes, note: "DROP self=nil")
                return
            }
            guard let ws = self.ws else {
                KSTrace.log("send", session: self.sessionId, agent: self.currentSession?.agent, bytes: bytes, note: "DROP ws=nil — WS 미생성 / stop 후 호출")
                // WS 인스턴스 자체가 없으면 입력은 확실히 안 갔다 — 끊김으로 표면화.
                self.noteInputSendResult(false)
                return
            }
            let sent = await ws.sendPtyInput(bytes, agent: self.currentSession?.agent)
            self.noteInputSendResult(sent)
        }
    }

    // MARK: - 입력 전송 표면화 (PtyInputDelivery)

    /// WS 연결/끊김 전이 콜백 — WSClient.onConnectionChange 가 호출.
    /// 입력이 드랍된 적이 있을 때만 배너 상태를 움직인다(끊김 자체는 화면 캡처·ping 등 다른
    /// 소비자와 공유하는 정상 이벤트라, 입력 손실이 없으면 배너를 띄우지 않는다).
    private func handleWSConnectionChange(_ connected: Bool) {
        wsConnected = connected
        guard inputDeliveryFailed else { return }
        if connected {
            // 재연결 성공 — 복구 확인. 최소 표시시간 뒤 자동 해제.
            scheduleInputBannerRecovery()
        } else {
            // 다시 끊김 — 복구 예약 취소하고 danger 유지(깜빡임 방지).
            inputBannerClearTask?.cancel()
            inputBannerClearTask = nil
            ptyInputDelivery = .failed
        }
    }

    /// sendPtyInput 결과를 표면화 상태에 반영. ok=true 면 복구 경로, false 면 실패 배너.
    private func noteInputSendResult(_ ok: Bool) {
        if ok {
            wsConnected = true
            if inputDeliveryFailed { scheduleInputBannerRecovery() }
        } else {
            wsConnected = false
            markInputDeliveryFailed()
        }
    }

    /// 입력 드랍 — danger 배너를 띄운다(이미 떠 있으면 표시 시각 유지).
    private func markInputDeliveryFailed() {
        inputBannerClearTask?.cancel()
        inputBannerClearTask = nil
        if !inputDeliveryFailed {
            inputDeliveryFailed = true
            inputBannerShownAt = Date()
        }
        ptyInputDelivery = .failed
    }

    /// 복구 확인(재연결/송신 성공) — info/secondary 로 바꾸고 최소 표시시간을 채운 뒤 해제.
    /// 그 사이 새 실패가 오면 markInputDeliveryFailed 가 이 Task 를 취소한다(히스테리시스).
    private func scheduleInputBannerRecovery() {
        guard inputDeliveryFailed else { return }
        ptyInputDelivery = .reconnecting
        inputBannerClearTask?.cancel()
        let shownFor = inputBannerShownAt.map { Date().timeIntervalSince($0) } ?? Self.inputBannerMinDisplaySec
        let remaining = max(Self.inputBannerMinDisplaySec - shownFor, 0.6)
        inputBannerClearTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(remaining * 1_000_000_000))
            guard let self, !Task.isCancelled else { return }
            self.clearInputDelivery()
        }
    }

    /// 배너 완전 해제 — 정상 상태로 복귀.
    private func clearInputDelivery() {
        inputBannerClearTask?.cancel()
        inputBannerClearTask = nil
        inputDeliveryFailed = false
        inputBannerShownAt = nil
        ptyInputDelivery = .ok
    }

}
