import SwiftUI

/// 네이티브 화면 캡처 + 원격 제어 (모니터 미러링 본문).
///
/// 전용 WSClient 로 세션에 subscribe → capture_start → daemon 이 헬퍼(capture-helper)를 띄워
/// screen_frame(JPEG)을 push → 최신 프레임을 렌더. remote_control_v1 이 되면 제어를 «항상 활성»
/// 으로 켜고 탭=클릭, 드래그=이동/스크롤, 키 버튼/텍스트가 input_event 로 헬퍼의 CGEvent 주입으로
/// 간다. 컨트롤 바는 채팅방과 같은 배치 — 가상 키는 모두 «우측», 드래그 타입은 «좌측».
/// 우상단 더보기(⋯) 메뉴에 버튼 크기 조절(채팅방과 동일 @AppStorage 공유) + 모니터 선택을 둔다.
///
/// 좌표는 캡처 프레임 기준 0..1 정규화로 보낸다 — 헬퍼가 디스플레이 포인트로 환산(Retina 흡수).
struct RemoteScreenView: View {
    let sessionId: String
    let api: ApiClient
    let conn: ConnectionManager
    /// 원격 제어(remote_control_v1) 지원 — 제어 바/제스처 노출 게이트. 지원하면 항상 활성.
    let canControl: Bool
    /// H.264 화면 릴레이(screen_h264_v1) 지원 — 코덱 협상 게이트(없으면 jpeg 폴백).
    let supportsH264: Bool
    /// 창 단위 캡처 대상(screen_window_target_v1) 지원 — 더보기 «캡처 대상» 피커 노출 게이트.
    /// 옛 daemon 은 false → 피커 숨김(항상 전체 화면, 옛 동작 그대로).
    var supportsWindowTarget: Bool = false
    /// «캡처/녹화 → 채팅 첨부» 수신자 — nil 이면 (세션 목록 진입 / screen_shot_v1 미지원)
    /// 캡처·녹화 버튼을 숨긴다. 데이터원은 daemon 의 원샷 스크린샷 (GET /api/screen/shot) —
    /// H.264 라이브 스트림은 GPU 레이어 직행이라 iOS 쪽에서 정지 프레임을 못 뽑는다.
    var onCaptured: (([AttachmentDraft]) -> Void)? = nil
    /// «단발 캡처 → 마크업 → 화면 피드백 첨부» 수신자 — 캡처한 프레임 위에 동그라미를 쳐
    /// PreviewFeedbackSheet(.screen) 가 합성한 FileReferenceDraft 를 올린다. 웹 프리뷰의 onFeedback
    /// 과 같은 플럼빙(fileRefs). onCaptured 와 같은 게이트로 함께 주입돼 nil 이면 캡처 버튼도 숨김.
    var onFeedback: ((FileReferenceDraft) -> Void)? = nil

    /// iPhone-only — verticalSizeClass==.compact 가 곧 가로. 회전 시 reactively 갱신된다.
    @Environment(\.verticalSizeClass) private var vSizeClass
    /// 상단 헤더 + 하단 컨트롤 컨테이너를 숨겨 미러를 크게 본다(FAB 로 토글).
    /// 미러링은 채팅과 달리 FAB 를 «항상» 노출하고(설정 게이트 없음), 가로 진입 시 기본 몰입.
    @State private var chromeHidden = false
    /// 사용자가 이번 세션에 크롬을 수동 토글했는가 — 그 뒤엔 회전 자동(몰입) 규칙을 덮어쓰지 않는다.
    @State private var chromeManuallyToggled = false

    @State private var ws: WSClient?
    /// JPEG 폴백 프레임(옛 daemon). h264 일 땐 nil — 렌더는 renderer 가 디스플레이 레이어에 직접.
    @State private var frame: UIImage?
    /// H.264 렌더러 — screenVideo(바이너리)를 AVSampleBufferDisplayLayer 에 직접 enqueue(GPU 디코드).
    @State private var renderer = MirrorRenderer()
    /// h264 가 첫 프레임을 레이어에 올렸는지 — 대기 오버레이를 내리는 게이트(h264 는 frame 이 nil).
    @State private var hasVideo = false
    @State private var running = false
    @State private var statusReason: String?
    /// 원격 제어(손쉬운 사용) 권한이 Mac 에서 미부여라 «보기는 되나 조작이 막힌» 상태. nil 이면 정상.
    /// 화면 기록(보기) 권한과 분리 — 화면은 보이는데 입력 주입만 거부될 때 하단 캡슐로 안내한다.
    @State private var controlBlocked = false
    /// 프레임 도착 통계 — 의도적으로 @State «값» 이 아니라 참조 박스. 프레임마다 @State 를 바꾸면
    /// SwiftUI 가 매 프레임 body 를 재평가해(30fps = 초당 30회) 제스처와 겹칠 때 버벅인다.
    /// monitor() 가 1초마다 tick 을 읽어 fpsEstimate 칩만 갱신한다.
    /// lastInboundAt: 마지막 인바운드 프레임(jpeg/h264) 도착 시각 — Close 시 «인바운드가 잠잠해질
    /// 때까지» 기다렸다 채널을 닫기 위한 신호. 닫는 중 들어오는 프레임이 SSH 자식 채널 teardown 과
    /// 레이스해 nio-ssh 가 하드 트랩(크래시)하던 것을 막는다(멀티모니터·잠금화면 등 고레이트 상황).
    private final class FrameStats {
        var tick = 0
        var lastInboundAt = Date.distantPast
    }
    @State private var frameStats = FrameStats()
    @State private var keyboardText = ""
    /// 가상 커서 재중앙 토큰 — 명시적 리셋·디스플레이 전환 시 증가시켜 캔버스 커서를 중앙으로.
    @State private var recenterToken = 0
    /// 트랙패드 감도(가속 기본 gain). 더보기 메뉴에서 조절, 영속.
    @AppStorage("mirror.trackpad.sensitivity") private var trackpadSensitivity = 1.0
    private static let sensitivityMin = 0.6
    private static let sensitivityMax = 2.0
    /// 화질 프리셋 — auto(연결종류 티어) / smooth(고fps·저해상도) / sharp(고해상도·저fps). 영속.
    @AppStorage("mirror.quality") private var quality = MirrorQuality.auto.rawValue
    /// Mac 시스템 오디오 듣기(h264 한정) — capture_start 의 audio 플래그 + 로컬 재생 게이트. 영속.
    @AppStorage("mirror.audio") private var audioEnabled = true
    /// 확대 영역만 전송(하이브리드 D ROI crop) — 켜면 줌 정착 시 보이는 영역만 native 해상도로
    /// 받는다(저속 회선에서 fps·선명도 이득). 끄면 항상 전체 화면을 받고 줌은 로컬 디지털 줌만 —
    /// crop 재협상(스트림 재구성)을 기다릴 일이 없어 빠른 회선에서 팬/축소 반응이 즉각적이다.
    /// OFF 면 ROI 에 얹힌 부가기능(즐겨찾기 점프·마지막 줌 위치 복원)도 함께 쉰다. 영속.
    @AppStorage("mirror.roi.transfer.enabled") private var roiTransferEnabled = true
    /// 첫 진입 제스처 온보딩(1회). 영속 플래그.
    @AppStorage("mirror.onboarding.v1.shown") private var onboardingShown = false
    /// 제스처 가이드 시트 — 온보딩(자동 1회) + 더보기 메뉴에서 재호출(상시).
    @State private var showGestureGuide = false
    /// 캡처 대상(창 목록) 선택 시트 — 더보기 메뉴의 한 줄 진입 항목에서 연다. 창 수십 개가
    /// 실시간으로 churn 해도 안정적인 List 라 스크롤이 유지된다(긴 Menu 의 스크롤 리셋 회피).
    @State private var showCaptureTargetSheet = false
    /// 디스플레이 선택 시트 — 같은 패턴(한 줄 진입 → 전용 List 시트).
    @State private var showDisplaySheet = false
    /// 첫 프레임 타임아웃 — 진입 후 일정 시간 화면이 안 오면 «문제 해결» 카드 노출.
    @State private var showTrouble = false
    /// 스트림 stall 감지 → 재연결 중 배너.
    @State private var reconnecting = false
    /// 실시간 fps 추정(프레임 카운트/초) — 상태 칩 표시용. monitor() 가 1초 주기로만 갱신.
    @State private var fpsEstimate = 0
    /// 마지막 capture_start 재전송 시각 — watchdog 재시도 throttle.
    @State private var lastRetryAt = Date.distantPast
    /// 현재 연결 시도 시작 시각 — 첫 프레임 타임아웃 기준. 진입·재시도 시 리셋.
    @State private var connectAttemptAt = Date.distantPast
    /// 가로 회전 안내(세로에서 작게 보일 때 1회).
    @AppStorage("mirror.rotateHint.v1.shown") private var rotateHintShown = false
    @State private var rotateHintVisible = false
    /// 보안 입력 — 켜면 입력창이 SecureField(별표 마스킹)로 바뀐다. 미러링 중 주변 시선으로부터
    /// 비밀번호 등을 가리는 용도. 토글이라 입력 후 다시 끄면 평문으로 돌아온다.
    @State private var secureInput = false
    @State private var lastMoveSent = Date.distantPast
    /// 스크롤 누적 — throttle 로 못 보낸 증분을 «버리지 않고» 모아 합계를 보낸다(증분 손실 방지).
    @State private var scrollAccumX: CGFloat = 0
    @State private var scrollAccumY: CGFloat = 0
    @State private var lastScrollSent = Date.distantPast
    /// 스크롤 감도 — 손가락 이동(point) 대비 스크롤 픽셀 배율(.pixel 단위).
    private static let scrollFactor = 1.0
    @FocusState private var keyboardFocused: Bool
    /// 멀티모니터 — daemon 이 보고한 디스플레이 목록 + 현재 선택(index). 더보기 메뉴에서 고른다.
    @State private var displays: [ScreenDisplay] = []
    @State private var selectedDisplay = 0
    /// 캡처 대상(창 스코프) — daemon 이 보고한 창 목록 + 현재 선택(CGWindowID, 0=전체 화면).
    /// 창을 고르면 그 창만 인코딩·송출(같은 비트레이트에 더 선명 + 다른 앱 비노출). 헬퍼가
    /// capture_target 으로 실제 적용 상태를 보고하므로 선택 상태가 서버와 동기화된다.
    @State private var windows: [ScreenWindow] = []
    @State private var selectedWindowId = 0
    /// «창이 닫혀 전체 화면으로 돌아왔어요» 캡슐 — 헬퍼의 window_closed 폴백 보고 시 4초.
    @State private var windowClosedHintVisible = false
    @State private var windowClosedHintToken = 0
    /// 줌/팬 — 줌>1 이면 리셋 버튼 노출, resetToken 증가로 1x 복귀.
    @State private var isZoomed = false
    @State private var resetToken = 0
    /// 끌기 잠금 «무장» — 컨트롤 바 토글. 켜면 1손가락 드래그가 tap-and-a-half 타이밍 없이 바로
    /// «누른 채 끌기» 로 시작(텍스트 선택·창 이동). 활성 시 토글·커서 링이 accent 로 바뀐다.
    @State private var dragLockArmed = false
    /// 스크롤 모드 «무장» — 컨트롤 바 토글. 켜면 1손가락 드래그가 커서 이동 대신 스크롤 휠이 된다
    /// (2손가락 스크롤이 어려운 사용자용). 끌기 잠금과 «상호 배타» — 한쪽을 켜면 다른 쪽은 꺼진다.
    @State private var scrollModeArmed = false
    /// 2손가락 드래그의 «현재 의미» — 캔버스가 갱신(none/스크롤/패닝), 화면 HUD 로 노출.
    @State private var twoFingerHint: ZoomableScreenView.TwoFingerHint = .none
    /// 하이브리드 D — 현재 서버 ROI(전체화면 기준 0..1, 전체면 {0,0,1,1}). 줌 정착 시 가시영역을
    /// 합성해 갱신하고, native ROI 프레임이 도착하면(onFormatChange) 로컬 줌을 1x 로 리셋해 샤픈.
    @State private var currentROI = CGRect(x: 0, y: 0, width: 1, height: 1)
    @State private var pendingROIHandoff = false
    /// 줌 즐겨찾기 2슬롯 — 현재 디스플레이용으로 로드된 ROI(없으면 nil). «모니터별» 로 따로 기억.
    @State private var favSlots: [CGRect?] = [nil, nil]
    /// 마지막 줌 위치 자동 복원 — 진입 후 첫 프레임에서 1회만(jpeg 폴백은 프레임마다 호출되므로 가드).
    @State private var lastROIRestored = false
    /// «마지막 줌 위치로 복원했어요» 안내 캡슐 — 탭하면 전체 보기. 복원 직후 잠깐만.
    @State private var restoreHintVisible = false
    /// 복원 안내 자동 해제 타이머 식별 — 연속 복원(디스플레이 전환) 시 이전 타이머가 새 캡슐을 닫지 않게.
    @State private var restoreHintToken = 0
    /// 즐겨찾기 «길게 눌러 저장/덮어쓰기» 안내 툴팁 — 최초 1회만(영속 플래그).
    @AppStorage("mirror.fav.hint.v1.shown") private var favHintShown = false
    @State private var favHintVisible = false
    /// 커스텀 단축키 4슬롯(전역 영속). 탭=실행, 길게/빈 슬롯 탭=편집 시트.
    @State private var shortcuts: [MirrorShortcut?] = Array(repeating: nil, count: 8)
    @State private var editingShortcut: EditingShortcut?

    /// 편집 중인 단축키 슬롯 — .sheet(item:) 용 Identifiable.
    private struct EditingShortcut: Identifiable { let slot: Int; var id: Int { slot } }
    /// 포맷(해상도) 변경 시 증가 — ZoomableScreenView 가 새 videoSize 로 전체화면 외곽선을 다시 그림.
    @State private var formatToken = 0
    // 캡처(정지 1장) 진행 중 — 버튼 스피너 + 중복 탭 가드.
    @State private var isShooting = false
    /// 단발 캡처한 프레임 → «화면 피드백» 시트로 넘긴다(웹 프리뷰의 feedbackImage 와 같은 패턴).
    @State private var feedbackImage: UIImage?
    @State private var showScreenFeedback = false
    /// 시트가 «완전히» 닫힌 뒤(onDismiss) onFeedback 으로 올린다 — 모달 전환 충돌 회피.
    @State private var pendingFeedback: FileReferenceDraft?
    /// 캡처 실패/지연(Tor 폴백 등) 안내 토스트 — 시트 진입 전 캡슐로 알린다. 토큰으로 연속 토스트
    /// 의 이전 타이머가 새 토스트를 일찍 닫지 않게 한다.
    @State private var captureToast: String?
    @State private var captureToastToken = 0
    // 녹화(주기 스크린샷 폴링) 진행 중 + 누적 샷. 정지 시 균등 샘플해 첨부로 넘긴다.
    @State private var isRecording = false
    @State private var recordTask: Task<Void, Never>? = nil
    @State private var recordedShots: [(data: Data, t: TimeInterval)] = []
    private static let fullROI = CGRect(x: 0, y: 0, width: 1, height: 1)
    /// 가상 키 높이 — 채팅방 키보드와 «같은» @AppStorage 를 공유(더보기 메뉴에서 조절).
    @AppStorage("chat.toolbar.buttonHeight") private var toolbarButtonHeight: Double = 28
    private static let toolbarButtonHeightMin: Double = 24
    private static let toolbarButtonHeightMax: Double = 44

    /// 현재 가로 모드인가 — iPhone-only 라 verticalSizeClass==.compact 가 곧 가로.
    private var isLandscape: Bool { vSizeClass == .compact }
    /// 미러링은 FAB 를 «항상» 노출한다 — 작은 화면을 크게 보는 핵심 기능이라 발견 가능해야.
    private var showChromeButton: Bool { true }
    /// 지금 크롬(헤더+컨트롤)을 숨기는 중인가.
    private var hideChrome: Bool { chromeHidden }

    var body: some View {
        VStack(spacing: 0) {
            // FAB 는 미러 영역(screenArea) 좌하단에 — 컨트롤 바가 보일 땐 그 위, 숨기면 화면 바닥.
            screenArea
                .overlay(alignment: .bottomLeading) { chromeToggleFAB }
                // 녹화 중 표시 — 크롬(헤더)을 숨겨도 보이도록 미러 영역에 직접. 탭 = 녹화 종료.
                .overlay(alignment: .topLeading) { if isRecording { recordingIndicator } }
            if canControl && !hideChrome {
                controlBar
            }
        }
        .task { await begin() }
        // 입력 전송 필드 마이크(받아쓰기) 공통 크롬 — 녹음 HUD·준비 배너·오류.
        .voiceDictationChrome()
        // 가로로 «바로» 진입한 경우 onChange 가 안 걸리므로 첫 노출 시 몰입 상태를 맞춘다.
        .onAppear { if !chromeManuallyToggled { chromeHidden = isLandscape } }
        .onDisappear {
            // 녹화 중 화면 이탈 — 그때까지 모은 샷으로 마무리(첨부 전달)하고 루프를 끊는다.
            finishRecording()
            end()
        }
        .toolbar {
            // 캡처/녹화 — 버그 재현 전달용. 채팅방 진입 + screen_shot_v1 일 때만 (onCaptured 게이트).
            if onCaptured != nil {
                ToolbarItemGroup(placement: .topBarTrailing) {
                    captureButton
                    recordButton
                }
            }
            ToolbarItem(placement: .topBarTrailing) { moreMenu }
        }
        // 가로 모드에서 크롬 숨김 시 상단 헤더(네비게이션 바)도 같이 숨긴다 — FAB 로 되돌림.
        .toolbar(hideChrome ? .hidden : .visible, for: .navigationBar)
        // 가로 진입 시 기본 몰입(크롬 자동 숨김), 세로면 크롬 표시. 단, 사용자가 이번 세션에
        // FAB 로 수동 토글했으면 그 의도를 존중해 회전 자동 규칙을 적용하지 않는다.
        .onChange(of: isLandscape) { _, landscape in
            guard !chromeManuallyToggled else { return }
            withAnimation(.easeInOut(duration: 0.2)) { chromeHidden = landscape }
        }
        // 단축키 생성/편집 바텀시트.
        .sheet(item: $editingShortcut) { target in
            ShortcutEditorSheet(
                initial: shortcuts[target.slot],
                onSave: { sc in
                    shortcuts[target.slot] = sc
                    saveShortcut(target.slot)
                },
                onDelete: shortcuts[target.slot] != nil ? {
                    shortcuts[target.slot] = nil
                    saveShortcut(target.slot)
                } : nil,
            )
        }
        // 제스처 가이드 — 첫 진입 1회(온보딩) + 더보기 메뉴에서 상시 재호출.
        .sheet(isPresented: $showGestureGuide, onDismiss: { onboardingShown = true }) {
            MirrorGestureGuide()
        }
        // 캡처 대상 — 더보기 메뉴에서 분리한 전용 시트. 안정적인 List 라 창 목록 churn 과
        // 무관하게 스크롤이 유지된다. 열릴 때 목록 갱신을 요청한다.
        .sheet(isPresented: $showCaptureTargetSheet) {
            CaptureTargetSheet(
                windows: windows,
                selectedWindowId: selectedWindowId,
                onSelect: { selectWindow($0) },
                onRefresh: { Task { await ws?.sendListWindows() } }
            )
        }
        // 디스플레이 선택 — 같은 분리 패턴의 전용 시트.
        .sheet(isPresented: $showDisplaySheet) {
            DisplayPickerSheet(
                displays: displays,
                selectedDisplay: selectedDisplay,
                onSelect: { selectDisplay($0) }
            )
        }
        // 화면 피드백 — 캡처한 프레임 위에 마크업+코멘트. 웹 프리뷰와 같은 PreviewFeedbackSheet 를
        // .screen 모드로 재사용한다. 완성본은 onDismiss 에서 onFeedback 으로 올린다(채팅 fileRefs).
        .sheet(isPresented: $showScreenFeedback, onDismiss: {
            if let draft = pendingFeedback {
                pendingFeedback = nil
                onFeedback?(draft)
            }
        }) {
            if let img = feedbackImage {
                PreviewFeedbackSheet(
                    snapshot: img,
                    sessionId: sessionId,
                    api: api,
                    target: .screen,
                    onComplete: { draft in pendingFeedback = draft },
                )
            }
        }
        .onChange(of: audioEnabled) { _, on in
            // 소리 토글 — 로컬 게이트 즉시 적용 + 서버 재협상(audio 플래그로 소스 on/off).
            renderer.audioEnabled = on
            guard hasVideo || frame != nil else { return }
            Task { await sendCaptureStartNow() }
        }
        // 화질 프리셋이 바뀌면 스트리밍 중에도 즉시 재협상.
        .onChange(of: quality) { _, _ in
            guard hasVideo || frame != nil else { return }
            Task { await sendCaptureStartNow() }
        }
        // 확대 영역 전송을 끄는 순간 — 잡혀 있던 서버 crop 을 즉시 해제해 전체 화면 스트림으로 복귀.
        .onChange(of: roiTransferEnabled) { _, on in
            if !on, currentROI != Self.fullROI { resetZoomAndROI() }
        }
    }

    // MARK: - 캡처/녹화 → 채팅 첨부 (버그 재현 전달)

    /// 녹화 폴링 간격 — Tor RTT(200~800ms)에서도 과밀하지 않게. 직접 SSH 면 거의 정확히 지켜진다.
    private static let recordIntervalMs: UInt64 = 700
    /// 녹화 자동 종료 상한 (~28초) — 폰을 두고 잊어도 무한 폴링하지 않는다.
    private static let recordMaxShots = 40
    /// 첨부로 넘길 최대 장수 — 처음/끝 포함 균등 샘플. 단계 흐름이 보이는 최소 장수로
    /// 토큰/대역폭을 아낀다 (이미지 1장 ≈ 1~1.5k 토큰).
    private static let recordKeepMax = 8

    /// 정지 1장 캡처 — daemon 원샷 스크린샷을 받아 «화면 피드백» 마크업 시트로 넘긴다. 웹 프리뷰·
    /// 산출물과 동일한 «본 것 위에 동그라미 쳐서 보내기» 루프. 캡처가 늦거나(Tor 폴백) 실패하면
    /// 시트 진입 전에 토스트로 알린다. (녹화는 기존대로 다프레임 묶음을 곧장 첨부 — 마크업 없음.)
    private var captureButton: some View {
        Button {
            guard !isShooting else { return }
            isShooting = true
            Task {
                defer { isShooting = false }
                let data: Data
                do {
                    data = try await api.screenShot(display: selectedDisplay + 1, window: selectedWindowId)
                } catch {
                    showCaptureToast(String(localized: "화면 캡처에 실패했어요. 잠시 후 다시 시도해 주세요."))
                    return
                }
                // 원샷은 디스플레이/창의 «물리 픽셀» PNG/JPEG — UIImage(data:) 는 scale=1·size=픽셀로
                // 들고 온다. @2x/@3x·창 스코프 무관하게 aspect-fit 합성이 캡처 프레임과 그대로 정합한다.
                guard let img = UIImage(data: data) else {
                    showCaptureToast(String(localized: "캡처한 화면을 열 수 없어요."))
                    return
                }
                feedbackImage = img
                showScreenFeedback = true
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
            }
        } label: {
            if isShooting {
                ProgressView()
            } else {
                Image(systemName: "camera")
            }
        }
        .disabled(isRecording)
        .accessibilityLabel("화면 캡처")
    }

    /// 캡처 실패/지연 안내 토스트 — 3초 후 자동 해제(restoreHint 와 같은 토큰 패턴).
    @MainActor
    private func showCaptureToast(_ message: String) {
        captureToastToken += 1
        let token = captureToastToken
        withAnimation { captureToast = message }
        UINotificationFeedbackGenerator().notificationOccurred(.warning)
        Task {
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            guard token == captureToastToken else { return }
            withAnimation { captureToast = nil }
        }
    }

    /// 녹화 토글 — 시작/정지. 정지 시 균등 샘플한 단계 이미지들이 첨부로 넘어간다.
    private var recordButton: some View {
        Button {
            if isRecording { finishRecording() } else { startRecording() }
        } label: {
            Image(systemName: isRecording ? "stop.circle.fill" : "record.circle")
                // 빨강 = 녹화 중 표준 관례 (danger 의미 아님 — 카메라 UI 보편 신호).
                .foregroundStyle(isRecording ? Color.red : Color.accentColor)
        }
        .accessibilityLabel(isRecording ? Text("화면 녹화 중지") : Text("화면 녹화 시작"))
    }

    /// 녹화 중 인디케이터 — 빨간 점 + 샷 수. 크롬 숨김 상태에서도 보이고, 탭하면 종료.
    private var recordingIndicator: some View {
        Button { finishRecording() } label: {
            HStack(spacing: 6) {
                Circle().fill(Color.red).frame(width: 8, height: 8)
                Text(verbatim: "REC \(recordedShots.count)")
                    .font(.caption.weight(.semibold).monospacedDigit())
                    .foregroundStyle(Theme.onAccent)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(.ultraThinMaterial, in: Capsule())
        }
        .padding(Theme.Spacing.l)
        .accessibilityLabel("화면 녹화 중지")
    }

    /// 녹화 시작 — 원샷 스크린샷을 주기 폴링해 (Data, 경과초) 로 누적. 요청 소요시간을 빼고
    /// 잔여만 대기해 느린 회선에서도 «끝나는 대로 다음 샷» 으로 자연 적응한다.
    private func startRecording() {
        guard recordTask == nil else { return }
        isRecording = true
        recordedShots = []
        let started = Date()
        // @MainActor — recordedShots(@State) append/read 를 메인에서만 하게 해 data race 를
        // 없앤다. api.screenShot 의 await 동안엔 메인이 풀려 UI(REC 카운터)도 갱신된다.
        recordTask = Task { @MainActor in
            while !Task.isCancelled && isRecording && recordedShots.count < Self.recordMaxShots {
                let reqAt = Date()
                if let data = try? await api.screenShot(display: selectedDisplay + 1, window: selectedWindowId) {
                    recordedShots.append((data: data, t: Date().timeIntervalSince(started)))
                }
                let elapsedMs = UInt64(max(0, Date().timeIntervalSince(reqAt)) * 1000)
                if elapsedMs < Self.recordIntervalMs {
                    try? await Task.sleep(nanoseconds: (Self.recordIntervalMs - elapsedMs) * 1_000_000)
                }
            }
            // 상한 도달 자동 종료 (사용자가 멈춘 경우는 이미 finishRecording 이 처리).
            if isRecording { finishRecording() }
        }
    }

    /// 녹화 종료 — 모은 샷을 처음/끝 포함 균등 샘플해 «단계 i/N (t초)» 설명을 단 첨부 묶음으로
    /// 전달한다. 에이전트가 파일명 순서 + 설명으로 시간 흐름(재현 단계)을 읽을 수 있다.
    private func finishRecording() {
        recordTask?.cancel()
        recordTask = nil
        guard isRecording else { return }
        isRecording = false
        let shots = recordedShots
        recordedShots = []
        guard !shots.isEmpty else { return }
        let keep = Self.sampleEvenly(shots, max: Self.recordKeepMax)
        // 변환(풀해상도 JPEG 디코드 → 다운스케일 → 재압축)은 메모리 피크가 큰 작업이라
        // 메인이 아닌 백그라운드에서 «한 장씩» autoreleasepool 로 즉시 해제하며 처리한다.
        // 메인에서 8장을 연달아 디코드하면 오토릴리즈 비트맵이 런루프 끝까지 안 풀려
        // (5K~6K 캡처 × 8) jetsam 으로 앱이 죽었다 — 실측 크래시.
        let total = keep.count
        Task.detached(priority: .userInitiated) {
            var drafts: [AttachmentDraft] = []
            for (i, shot) in keep.enumerated() {
                let made: AttachmentDraft? = autoreleasepool {
                    guard var draft = AttachmentDraft.make(fromOriginal: shot.data) else { return nil }
                    let step = i + 1
                    let secs = String(format: "%.1f", shot.t)
                    // 파일명에 순서를 박아 (rec-step01…) 프롬프트의 경로 나열만으로도 순서가 보이게.
                    draft.suggestedName = String(format: "rec-step%02d.jpg", step)
                    draft.instruction = String(localized: "화면 녹화 단계 \(step)/\(total) — \(secs)초 시점")
                    return draft
                }
                if let made { drafts.append(made) }
            }
            guard !drafts.isEmpty else { return }
            await MainActor.run {
                onCaptured?(drafts)
                UINotificationFeedbackGenerator().notificationOccurred(.success)
            }
        }
    }

    /// 처음/끝을 포함한 균등 샘플 — n ≤ k 면 그대로.
    private static func sampleEvenly<T>(_ items: [T], max k: Int) -> [T] {
        guard items.count > k, k >= 2 else { return items }
        return (0..<k).map { items[$0 * (items.count - 1) / (k - 1)] }
    }

    /// 크롬(헤더+컨트롤) 숨김/표시 토글 FAB — 현재 방향의 «컨트롤 숨김 버튼» 설정이 켜졌을 때만 노출.
    @ViewBuilder
    private var chromeToggleFAB: some View {
        if showChromeButton {
            Button {
                chromeManuallyToggled = true
                withAnimation(.easeInOut(duration: 0.2)) { chromeHidden.toggle() }
            } label: {
                Image(systemName: chromeHidden ? "eye" : "eye.slash")
                    .font(.headline)
                    .foregroundStyle(Theme.onAccent)
                    .padding(14)
                    .background(.ultraThinMaterial, in: Circle())
            }
            .padding(Theme.Spacing.l)
            .accessibilityLabel(chromeHidden ? Text("컨트롤 표시") : Text("컨트롤 숨기기"))
        }
    }

    // MARK: - 화면

    private var screenArea: some View {
        ZStack(alignment: .topTrailing) {
            Color.black
            // 디스플레이 레이어를 «항상» 붙여둔다 — renderer.attach 가 첫 프레임 전에 일어나야
            // enqueue 할 대상(AVSampleBufferDisplayLayer)이 생긴다. 뷰를 hasVideo 뒤로 게이팅하면
            // 레이어가 없어 프레임이 영영 안 들어가고 «대기» 에서 못 벗어난다(닭-달걀).
            ZoomableScreenView(
                renderer: renderer,
                jpegImage: frame,
                controlEnabled: canControl,
                roi: currentROI,
                formatToken: formatToken,
                isZoomed: $isZoomed,
                resetToken: resetToken,
                recenterToken: recenterToken,
                sensitivity: trackpadSensitivity,
                dragLockArmed: dragLockArmed,
                scrollModeArmed: scrollModeArmed,
                twoFingerHint: $twoFingerHint,
                onClick: { x, y, clicks in
                    Task { await send(["cmd": "click", "x": Double(x), "y": Double(y), "button": "left", "clicks": clicks]) }
                },
                onRightClick: { x, y in
                    Task { await send(["cmd": "click", "x": Double(x), "y": Double(y), "button": "right", "clicks": 1]) }
                },
                onMove: { x, y in
                    throttleSend(["cmd": "move", "x": Double(x), "y": Double(y)])
                },
                onScrollDelta: { dx, dy in
                    accumulateScroll(dx, dy)
                },
                onScrollEnd: {
                    flushScroll()
                },
                onDragBegin: { x, y in
                    Task { await send(["cmd": "down", "x": Double(x), "y": Double(y), "button": "left"]) }
                },
                onDragMove: { x, y in
                    throttleSend(["cmd": "drag", "x": Double(x), "y": Double(y)])
                },
                onDragEnd: { x, y in
                    Task { await send(["cmd": "up", "x": Double(x), "y": Double(y), "button": "left"]) }
                },
                onROIRequest: { visible in
                    requestROI(visible: visible)
                },
            )
            // 우상단: [즐겨찾기1][즐겨찾기2][줌 리셋]. 즐겨찾기는 화면이 떠 있으면 항상,
            // 리셋은 줌/ROI 일 때만. 즐겨찾기 = 현재 줌 영역(ROI)을 «모니터별» 로 기억/복원.
            if frame != nil || hasVideo {
                VStack(alignment: .trailing, spacing: Theme.Spacing.s) {
                    HStack(spacing: Theme.Spacing.s) {
                        // 즐겨찾기는 서버 ROI 점프라 확대 영역 전송이 켜져 있고 전체 화면 스코프일 때만.
                        if roiTransferEnabled && selectedWindowId == 0 {
                            favoriteButton(slot: 0)
                            favoriteButton(slot: 1)
                        }
                        if isZoomed || currentROI != Self.fullROI {
                            Button {
                                resetZoomAndROI()
                            } label: {
                                favIcon("arrow.down.right.and.arrow.up.left")
                            }
                            .accessibilityLabel(Text("줌 리셋"))
                        }
                    }
                    if favHintVisible {
                        Text("길게 눌러 현재 줌 영역 저장(덮어쓰기)")
                            .font(.caption2)
                            .foregroundStyle(Theme.onAccent)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 6)
                            .background(.ultraThinMaterial, in: Capsule())
                            .onTapGesture { dismissFavHint() }
                            .transition(.opacity)
                    }
                }
                .padding(Theme.Spacing.l)
            }
        }
        .overlay {
            // 화면 기록 권한 미부여는 daemon 이 «확정» 으로 보고 — 권위적이라 프레임 유무와 무관하게
            // 안내를 띄운다(권한 없이도 바탕화면 일부가 잡혀 들어오는 프레임으로 안내가 가려지지 않게).
            if statusReason == "screen_permission" {
                troubleOverlay
            } else if frame == nil && !hasVideo {
                // 첫 프레임 전 — spawn 실패는 권위적 사유라 즉시, 그 외엔 ~10s 타임아웃(showTrouble) 후 안내.
                if showTrouble || statusReason == "spawn_failed" {
                    troubleOverlay
                } else {
                    waitingOverlay
                }
            }
        }
        // 보기는 되지만 조작만 막힘(손쉬운 사용 미부여) — 화면 위에 분리된 하단 캡슐로 안내(info 색).
        .overlay(alignment: .bottom) {
            if controlBlocked && (hasVideo || frame != nil) && statusReason != "screen_permission" && !hideChrome {
                controlBlockedHint
            }
        }
        // 스트림이 멎어 재연결 중 — 화면은 마지막 프레임을 유지하고 상단에 배너.
        .overlay(alignment: .top) {
            if reconnecting && (hasVideo || frame != nil) && !hideChrome {
                reconnectBanner
            }
        }
        // 캡처 실패/지연 안내 토스트 — 시트 진입 전 캡처가 늦거나 실패했을 때(Tor 폴백 등).
        .overlay(alignment: .top) {
            if let captureToast {
                captureToastBanner(captureToast)
            }
        }
        // 실시간 상태 칩(연결종류·fps) — 좌상단. 크롬 숨김 시엔 함께 숨긴다.
        .overlay(alignment: .topLeading) {
            if (hasVideo || frame != nil) && !hideChrome {
                statusChip.padding(Theme.Spacing.l)
            }
        }
        // 하단 안내 캡슐 — 창 닫힘 폴백(이벤트성) > 복원 안내(진입 직후) > 회전 안내(1회성).
        .overlay(alignment: .bottom) {
            if windowClosedHintVisible {
                windowClosedHint
            } else if restoreHintVisible {
                restoreHint
            } else if rotateHintVisible {
                rotateHint
            }
        }
        // 2손가락 드래그 의미 HUD — 제스처 중에만 중앙에 떠 «스크롤 vs 화면 이동» 을 드러낸다.
        .overlay {
            if twoFingerHint != .none {
                twoFingerHintHUD
            }
        }
        .animation(.easeInOut(duration: 0.12), value: twoFingerHint)
    }

    /// 2손가락 드래그가 지금 무엇을 하는지 알리는 HUD — 전체 보기=스크롤, 확대 중=화면 이동(뷰포트
    /// 패닝). 「현재 isMagnified 모드만으로 조용히 갈리던」 의미를 제스처 중에만 노출한다. 확대 영역
    /// 전송 ON/OFF 와 무관하게 의미는 동일(로컬 디지털 줌도 같은 표시). 터치는 통과(allowsHitTesting=false).
    @ViewBuilder
    private var twoFingerHintHUD: some View {
        let scroll = twoFingerHint == .scroll
        HStack(spacing: Theme.Spacing.s) {
            Image(systemName: scroll ? "arrow.up.and.down" : "arrow.up.and.down.and.arrow.left.and.right")
            (scroll ? Text("스크롤") : Text("화면 이동"))
                .font(.caption.weight(.semibold))
        }
        .foregroundStyle(Theme.onAccent)
        .padding(.horizontal, Theme.Spacing.l)
        .padding(.vertical, Theme.Spacing.m)
        .background(.ultraThinMaterial, in: Capsule())
        .accessibilityElement(children: .combine)
        .accessibilityLabel(scroll ? Text("스크롤 모드") : Text("화면 이동 모드"))
        .transition(.opacity)
        .allowsHitTesting(false)
    }

    /// 실시간 상태 칩 — 연결종류(직결/Tor) + fps. 한눈에 «왜 느린지» 를 알 수 있게.
    private var statusChip: some View {
        let tor = conn.currentEndpointType == .torOnion
        return HStack(spacing: Theme.Spacing.xs) {
            Image(systemName: tor ? "lock.shield" : "bolt.horizontal.fill")
                .font(.caption2)
                .foregroundStyle(tor ? Theme.pro : Theme.success)
            Text(tor ? "Tor" : String(localized: "직결"))
                .font(.caption2.weight(.semibold))
                .foregroundStyle(Theme.onAccent)
            if fpsEstimate > 0 {
                Text(verbatim: "· \(fpsEstimate)fps")
                    .font(.caption2)
                    .foregroundStyle(Theme.onAccent.opacity(0.7))
            }
        }
        .padding(.horizontal, Theme.Spacing.m)
        .padding(.vertical, Theme.Spacing.xs)
        .background(.ultraThinMaterial, in: Capsule())
        .accessibilityElement(children: .combine)
    }

    /// 재연결 배너 — 마지막 프레임 위에 떠 사용자에게 «끊긴 게 아니라 복구 중» 임을 알린다.
    private var reconnectBanner: some View {
        HStack(spacing: Theme.Spacing.s) {
            ProgressView().controlSize(.small).tint(Theme.onAccent)
            Text("재연결 중…")
                .font(.caption.weight(.semibold))
                .foregroundStyle(Theme.onAccent)
        }
        .padding(.horizontal, Theme.Spacing.l)
        .padding(.vertical, Theme.Spacing.s)
        .background(.ultraThinMaterial, in: Capsule())
        .padding(.top, Theme.Spacing.m)
        .transition(.move(edge: .top).combined(with: .opacity))
    }

    /// 캡처 실패/지연 안내 토스트 — danger 색 아이콘. 마지막 프레임 위에 떠 시트 진입이 «왜 안
    /// 떴는지» 를 알린다. 크롬 숨김 상태에서도 보이도록 화면 영역에 직접 띄운다.
    private func captureToastBanner(_ message: String) -> some View {
        HStack(spacing: Theme.Spacing.s) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(Theme.danger)
            Text(message)
                .font(.caption.weight(.semibold))
                .foregroundStyle(Theme.onAccent)
                .multilineTextAlignment(.leading)
        }
        .padding(.horizontal, Theme.Spacing.l)
        .padding(.vertical, Theme.Spacing.s)
        .background(.ultraThinMaterial, in: Capsule())
        .padding(.top, Theme.Spacing.xxl)
        .padding(.horizontal, Theme.Spacing.l)
        .transition(.move(edge: .top).combined(with: .opacity))
    }

    /// 가로 회전 안내 캡슐 — 탭하면 닫힘, 4초 후 자동.
    private var rotateHint: some View {
        HStack(spacing: Theme.Spacing.s) {
            Image(systemName: "rotate.right")
            Text("가로로 돌리면 크게 볼 수 있어요")
        }
        .font(.caption.weight(.semibold))
        .foregroundStyle(Theme.onAccent)
        .padding(.horizontal, Theme.Spacing.l)
        .padding(.vertical, Theme.Spacing.m)
        .background(.ultraThinMaterial, in: Capsule())
        .padding(.bottom, Theme.Spacing.xxl)
        .onTapGesture { dismissRotateHint() }
        .transition(.opacity)
    }

    /// 창 닫힘 폴백 안내 캡슐 — 선택했던 창이 닫혀 헬퍼가 전체 화면으로 돌아온 걸 알린다.
    /// 탭하면 닫힘, 4초 후 자동 해제 (restoreHint 와 같은 패턴).
    private var windowClosedHint: some View {
        HStack(spacing: Theme.Spacing.s) {
            Image(systemName: "macwindow")
            Text("창이 닫혀 전체 화면으로 돌아왔어요")
        }
        .font(.caption.weight(.semibold))
        .foregroundStyle(Theme.onAccent)
        .padding(.horizontal, Theme.Spacing.l)
        .padding(.vertical, Theme.Spacing.m)
        .background(.ultraThinMaterial, in: Capsule())
        .padding(.bottom, Theme.Spacing.xxl)
        .onTapGesture { withAnimation { windowClosedHintVisible = false } }
        .transition(.opacity)
    }

    /// 마지막 줌 위치 복원 안내 캡슐 — 탭하면 즉시 전체 보기(리셋), 4초 후 자동 해제.
    /// 자동 복원이 «왜 확대돼 있지?» 가 되지 않게 알리고, 원치 않으면 원탭으로 벗어나게 한다.
    private var restoreHint: some View {
        HStack(spacing: Theme.Spacing.s) {
            Image(systemName: "arrow.uturn.backward")
            Text("마지막 줌 위치로 복원했어요 — 탭하면 전체 보기")
        }
        .font(.caption.weight(.semibold))
        .foregroundStyle(Theme.onAccent)
        .padding(.horizontal, Theme.Spacing.l)
        .padding(.vertical, Theme.Spacing.m)
        .background(.ultraThinMaterial, in: Capsule())
        .padding(.bottom, Theme.Spacing.xxl)
        .onTapGesture {
            withAnimation { restoreHintVisible = false }
            resetZoomAndROI()
        }
        .transition(.opacity)
    }

    private var waitingOverlay: some View {
        // 순수 «대기» 상태만 — 잠금/권한/spawn 실패 같은 «사유 있는» 상태는 권위적 오버레이(troubleOverlay)
        // 또는 별도 캡슐이 가져간다. 여기선 노란 경고색을 쓰지 않는다(정책: warning=노랑은 진짜 경고 전용).
        VStack(spacing: Theme.Spacing.l) {
            ProgressView().tint(Theme.onAccent)
            (running ? Text("화면 수신 대기 중…") : Text("화면 캡처 시작 중…"))
                .font(.callout)
                .foregroundStyle(Theme.onAccent.opacity(0.8))
        }
    }

    /// 첫 프레임이 오래(~10s) 안 오거나 화면 기록 권한이 미부여(권위적)일 때 — 행동 가능한 «문제 해결»
    /// 카드. 무한 스피너/검은 화면 대신 «왜 안 되는지 + 어디서 켜는지» + 재시도. 아이콘은 의미 토큰(info)
    /// — 단순 정보 안내라 노란 경고색을 쓰지 않는다(정책: warning=노랑은 진짜 경고 전용).
    private var troubleOverlay: some View {
        VStack(spacing: Theme.Spacing.l) {
            Image(systemName: statusReason == "screen_permission" ? "rectangle.dashed.badge.record" : "display.trianglebadge.exclamationmark")
                .font(.system(size: Theme.IconSize.xl))
                .foregroundStyle(Theme.info)
            (statusReason == "screen_permission" ? Text("Mac 에서 화면 기록 권한이 필요해요") : Text("화면이 보이지 않나요?"))
                .font(.headline)
                .foregroundStyle(Theme.onAccent)
                .multilineTextAlignment(.center)
            Text(troubleReasonText)
                .font(.callout)
                .foregroundStyle(Theme.onAccent.opacity(0.8))
                .multilineTextAlignment(.center)
                .padding(.horizontal, Theme.Spacing.xl)
            Button {
                retryCapture()
            } label: {
                Label("권한을 켰어요 · 다시 시도", systemImage: "arrow.clockwise")
                    .font(.callout.weight(.semibold))
                    .padding(.horizontal, Theme.Spacing.xl)
                    .padding(.vertical, Theme.Spacing.m)
                    .background(.ultraThinMaterial, in: Capsule())
                    .foregroundStyle(Theme.onAccent)
            }
        }
        .padding(Theme.Spacing.xxl)
    }

    /// 문제 해결 카드의 사유 텍스트 — 화면 기록 권한 미부여/spawn 실패/기타로 분기한 단계 안내.
    private var troubleReasonText: LocalizedStringKey {
        if statusReason == "spawn_failed" {
            return "캡처 헬퍼를 시작할 수 없어요. Mac 앱을 최신으로 업데이트한 뒤 다시 시도하세요."
        }
        if statusReason == "screen_permission" {
            return "Mac 의 시스템 설정 ▸ 개인정보 보호 및 보안 ▸ 화면 기록에서 Pocket Sisyphus 를 켠 뒤, 안내가 사라지지 않으면 Mac 앱을 재시작하세요."
        }
        return "Mac 에서 화면 기록 권한이 필요할 수 있어요. Mac 의 시스템 설정 ▸ 개인정보 보호 및 보안 ▸ 화면 기록에서 Pocket Sisyphus 를 켠 뒤 다시 시도하세요."
    }

    /// 보기는 되지만 조작만 막힘(손쉬운 사용 미부여) — 하단 캡슐(info 색). 화면 기록(보기) 안내와
    /// 분리: 화면은 보이는데 클릭/키 입력만 무시될 때, «왜 조작이 안 되는지 + 어디서 켜는지» 를 알린다.
    private var controlBlockedHint: some View {
        HStack(spacing: Theme.Spacing.s) {
            Image(systemName: "hand.tap")
                .foregroundStyle(Theme.info)
            Text("보기는 되지만, 조작하려면 Mac 의 손쉬운 사용 권한을 켜야 해요")
                .foregroundStyle(Theme.onAccent)
        }
        .font(.caption.weight(.semibold))
        .multilineTextAlignment(.center)
        .padding(.horizontal, Theme.Spacing.l)
        .padding(.vertical, Theme.Spacing.m)
        .background(.ultraThinMaterial, in: Capsule())
        .padding(.bottom, Theme.Spacing.xxl)
        .padding(.horizontal, Theme.Spacing.l)
        .transition(.opacity)
    }

    // MARK: - 더보기 메뉴 (우상단)

    /// 즉시 토글(화질·Mac 소리·감도·버튼 크기·제스처 도움말)만 메뉴에 남기고, 캡처 대상·디스플레이는
    /// 현재 선택값을 보여주는 한 줄 진입 항목으로 두어 탭하면 전용 List 시트를 연다(긴 메뉴 회피).
    private var moreMenu: some View {
        MirrorMoreMenu(
            quality: quality,
            roiTransferEnabled: roiTransferEnabled,
            audioEnabled: audioEnabled,
            supportsH264: supportsH264,
            canControl: canControl,
            trackpadSensitivity: trackpadSensitivity,
            toolbarButtonHeight: toolbarButtonHeight,
            supportsWindowTarget: supportsWindowTarget,
            windows: windows,
            selectedWindowId: selectedWindowId,
            displays: displays,
            selectedDisplay: selectedDisplay,
            setQuality: { quality = $0 },
            setROITransfer: { roiTransferEnabled = $0 },
            setAudio: { audioEnabled = $0 },
            adjustSensitivity: { adjustSensitivity(by: $0) },
            adjustToolbarButtonHeight: { adjustToolbarButtonHeight(by: $0) },
            showGestureGuide: { showGestureGuide = true },
            openCaptureTarget: { showCaptureTargetSheet = true },
            openDisplayPicker: { showDisplaySheet = true }
        )
        .equatable()
    }

    /// 더보기 메뉴 본체 — 메뉴 «내용» 을 결정하는 값만으로 동등성을 판단하는 Equatable 뷰.
    ///
    /// 왜 분리했나: SwiftUI 는 메뉴가 «열려 있는 동안» 에도 소유 뷰의 body 가 재평가되면 메뉴
    /// 콘텐츠를 UIKit 에 다시 적용하는데, 그때 메뉴 리스트의 스크롤이 맨 위로 리셋된다.
    /// RemoteScreenView 는 fps 칩(1초 주기)·jpeg 폴백 프레임 등 @State 가 수시로 바뀌어,
    /// «캡처 대상» 처럼 긴 목록을 스크롤해 아래 항목을 고르기가 불가능했다. 메뉴와 무관한 부모
    /// 갱신은 == 가 걸러내 열린 메뉴를 건드리지 않는다.
    private struct MirrorMoreMenu: View, Equatable {
        let quality: String
        let roiTransferEnabled: Bool
        let audioEnabled: Bool
        let supportsH264: Bool
        let canControl: Bool
        let trackpadSensitivity: Double
        let toolbarButtonHeight: Double
        let supportsWindowTarget: Bool
        let windows: [ScreenWindow]
        let selectedWindowId: Int
        let displays: [ScreenDisplay]
        let selectedDisplay: Int
        let setQuality: (String) -> Void
        let setROITransfer: (Bool) -> Void
        let setAudio: (Bool) -> Void
        let adjustSensitivity: (Double) -> Void
        let adjustToolbarButtonHeight: (Double) -> Void
        let showGestureGuide: () -> Void
        let openCaptureTarget: () -> Void
        let openDisplayPicker: () -> Void

        /// 액션 클로저는 매 부모 body 마다 새로 만들어지므로 비교에서 제외 — 표시 값만 본다.
        ///
        /// windows 는 «제목 무관» 키(id+app)로만 비교한다. 브라우저 탭·터미널 출력으로 title 이
        /// 수시로 바뀌면 동등성 가드가 매번 깨져 열린 메뉴가 통째로 재구성되고 스크롤이 맨 위로
        /// 리셋됐다. title 은 displayName 표시용으로만 유지 — 폴링/실시간 갱신을 그대로 두면서도
        /// 제목 churn 으로 인한 메뉴 재구성을 없앤다.
        static func == (lhs: Self, rhs: Self) -> Bool {
            lhs.quality == rhs.quality
                && lhs.roiTransferEnabled == rhs.roiTransferEnabled
                && lhs.audioEnabled == rhs.audioEnabled
                && lhs.supportsH264 == rhs.supportsH264
                && lhs.canControl == rhs.canControl
                && lhs.trackpadSensitivity == rhs.trackpadSensitivity
                && lhs.toolbarButtonHeight == rhs.toolbarButtonHeight
                && lhs.supportsWindowTarget == rhs.supportsWindowTarget
                && lhs.windows.map(\.id) == rhs.windows.map(\.id)
                && lhs.windows.map(\.app) == rhs.windows.map(\.app)
                && lhs.selectedWindowId == rhs.selectedWindowId
                && lhs.displays == rhs.displays
                && lhs.selectedDisplay == rhs.selectedDisplay
        }

        /// 감도 라벨 — «1.0×» 형태(고정 포맷, 번역 불필요).
        private var sensitivityLabel: String { String(format: "%.1f×", trackpadSensitivity) }

        /// 캡처 대상 진입 항목의 현재 선택값 — 전체 화면 또는 선택한 창 이름.
        private var captureTargetValue: String {
            guard selectedWindowId != 0,
                  let w = windows.first(where: { $0.id == selectedWindowId })
            else { return String(localized: "전체 화면") }
            return w.displayName
        }

        /// 디스플레이 진입 항목의 현재 선택값 — «1 · 1920×1080» 형태(고정 포맷).
        private var displayValue: String {
            guard let d = displays.first(where: { $0.index == selectedDisplay }) else { return "" }
            return "\(d.index + 1)  ·  \(d.width)×\(d.height)"
        }

        var body: some View {
            Menu {
                // ── 화질 — 자동/부드럽게/선명하게. 보기 전용에서도 의미 있어 맨 위.
                Section {
                    Picker("화질", selection: Binding(get: { quality }, set: setQuality)) {
                        ForEach(MirrorQuality.allCases) { q in
                            Label(q.title, systemImage: q.icon).tag(q.rawValue)
                        }
                    }
                    .pickerStyle(.menu)
                    // 확대 영역만 전송(ROI crop) — 저속 회선용 최적화. 빠른 회선에선 끄면 crop
                    // 재협상 대기 없이 팬/축소가 즉각 반응한다(줌은 로컬 디지털 줌).
                    Toggle(isOn: Binding(get: { roiTransferEnabled }, set: setROITransfer)) {
                        Label("확대 영역만 전송", systemImage: "crop")
                    }
                } header: {
                    Text("화질")
                }
                // ── Mac 소리 — 시스템 오디오를 폰으로(h264 한정, 토글 즉시 재협상). 보기 전용에서도 의미.
                if supportsH264 {
                    Toggle(isOn: Binding(get: { audioEnabled }, set: setAudio)) {
                        Label("Mac 소리 듣기", systemImage: "speaker.wave.2")
                    }
                }
                if canControl {
                    // ── 트랙패드 감도.
                    Section {
                        ControlGroup {
                            Button {} label: { Text(verbatim: sensitivityLabel) }
                                .disabled(true)
                            Button { adjustSensitivity(-0.2) } label: {
                                Label("감도 낮게", systemImage: "minus")
                            }
                            .disabled(trackpadSensitivity <= RemoteScreenView.sensitivityMin + 0.001)
                            .menuActionDismissBehavior(.disabled)
                            Button { adjustSensitivity(+0.2) } label: {
                                Label("감도 높게", systemImage: "plus")
                            }
                            .disabled(trackpadSensitivity >= RemoteScreenView.sensitivityMax - 0.001)
                            .menuActionDismissBehavior(.disabled)
                        }
                    } header: {
                        Text("트랙패드 감도")
                    }
                    // ── 가상 키 버튼 크기.
                    Section {
                        ControlGroup {
                            Button {} label: { Text(verbatim: "\(Int(toolbarButtonHeight))pt") }
                                .disabled(true)
                            Button { adjustToolbarButtonHeight(-2) } label: {
                                Label("버튼 작게", systemImage: "minus")
                            }
                            .disabled(toolbarButtonHeight <= RemoteScreenView.toolbarButtonHeightMin)
                            .menuActionDismissBehavior(.disabled)
                            Button { adjustToolbarButtonHeight(+2) } label: {
                                Label("버튼 크게", systemImage: "plus")
                            }
                            .disabled(toolbarButtonHeight >= RemoteScreenView.toolbarButtonHeightMax)
                            .menuActionDismissBehavior(.disabled)
                        }
                    }
                }
                // ── 캡처 대상 / 디스플레이 — 한 줄 진입 항목(현재 선택값 표시). 탭하면 안정적인
                // List 시트가 열린다(창 수십 개를 긴 메뉴에 펼치지 않아 발견율·스크롤 부담 개선).
                Section {
                    if supportsWindowTarget {
                        Button {
                            openCaptureTarget()
                        } label: {
                            Label("캡처 대상: \(captureTargetValue)", systemImage: "macwindow")
                        }
                    }
                    if displays.count > 1 {
                        Button {
                            openDisplayPicker()
                        } label: {
                            Label("디스플레이: \(displayValue)", systemImage: "display.2")
                        }
                    }
                }
                if canControl {
                    Section {
                        Button {
                            showGestureGuide()
                        } label: {
                            Label("제스처 도움말", systemImage: "hand.tap")
                        }
                    }
                }
            } label: {
                Image(systemName: "ellipsis.circle")
            }
            .accessibilityLabel(Text("더보기"))
        }
    }

    private func adjustSensitivity(by delta: Double) {
        trackpadSensitivity = max(Self.sensitivityMin, min(Self.sensitivityMax, trackpadSensitivity + delta))
    }

    private func adjustToolbarButtonHeight(by delta: Double) {
        toolbarButtonHeight = max(Self.toolbarButtonHeightMin, min(Self.toolbarButtonHeightMax, toolbarButtonHeight + delta))
    }

    // MARK: - 제어 바

    /// 하단 컨트롤 바 — 채팅방 키보드와 같은 배치. 좌측: 커스텀 단축키 8개(4×2), 우측: 가상 키
    /// 격자 두 줄. 그 아래 자유 타이핑 입력창. 화질·감도·모니터·버튼 크기는 더보기 메뉴로.
    ///   [SC1][SC2][SC3][SC4]  [ESC][⌫][↑][/][Space][⌨]
    ///   [SC5][SC6][SC7][SC8]  [Tab][←][↓][→][↩][전송]
    private var controlBar: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.s) {
            Divider()

            // 입력 전송 필드 — 화면 바로 아래(위쪽). 컨트롤 버튼·키는 그 아래.
            // 우측 보안 토글로 SecureField(별표 마스킹) 전환 — 미러링 중 주변 시선 차단(비밀번호 등).
            HStack(spacing: 6) {
                Group {
                    if secureInput {
                        SecureField("입력 후 전송", text: $keyboardText)
                    } else {
                        // 비보안 모드만 받아쓰기 마이크 — 비밀번호(SecureField)는 음성 입력 부적합.
                        VoiceInputField("입력 후 전송", text: $keyboardText)
                    }
                }
                .textFieldStyle(.roundedBorder)
                .focused($keyboardFocused)
                .autocorrectionDisabled()
                .onSubmit { sendKeyboardText() }
                // 보안(암호화) 토글은 마이크 바로 오른쪽 — 입력창 관련 토글끼리(마이크·보안) 묶고,
                // 트랙패드 모드 토글(끌기 잠금·스크롤)은 그 뒤로 분리한다.
                secureToggleButton
                dragLockToggleButton
                scrollModeToggleButton
            }

            HStack(alignment: .top, spacing: 6) {
                // 왼쪽: 커스텀 단축키 8개(4×2) — 탭=실행, 빈 슬롯 탭/길게=편집 시트(즐겨찾기처럼).
                // (옛 포인터/스크롤/드래그 모드 버튼은 통합 트랙패드로 대체돼 제거 — 모드 전환 없음.)
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 6) {
                        ForEach(0..<4, id: \.self) { slot in
                            shortcutButton(slot: slot)
                        }
                    }
                    HStack(spacing: 6) {
                        ForEach(4..<8, id: \.self) { slot in
                            shortcutButton(slot: slot)
                        }
                    }
                }
                Spacer()
                // 오른쪽: 가상 키 격자 (채팅방과 동일하게 모두 우측).
                VStack(alignment: .trailing, spacing: 6) {
                    HStack(spacing: 6) {
                        cmdKey("escape", "escape", "ESC")
                        cmdKey("delete.left", "delete", "삭제")
                        cmdKey("arrow.up", "up", "위")
                        charKey("/", "/")
                        cmdKey("space", "space", "Space")
                        keyboardToggleButton
                    }
                    HStack(spacing: 6) {
                        cmdKey("arrow.right.to.line", "tab", "Tab")
                        cmdKey("arrow.left", "left", "왼쪽")
                        cmdKey("arrow.down", "down", "아래")
                        cmdKey("arrow.right", "right", "오른쪽")
                        cmdKey("return", "return", "Enter")
                        sendButton
                    }
                }
            }
        }
        .environment(\.chatKeyHeight, CGFloat(toolbarButtonHeight))
        .padding(.horizontal, Theme.Spacing.l)
        .padding(.bottom, Theme.Spacing.s)
        .background(.bar)
    }

    /// 키보드 토글 — 자유 타이핑 입력창에 포커스를 줘 소프트 키보드를 올린다(채팅방과 동일 역할).
    private var keyboardToggleButton: some View {
        ChatKeyButton(
            tint: keyboardFocused ? Theme.accent : .primary,
            accessibilityLabel: keyboardFocused ? "키보드 닫기" : "키보드 열기",
            action: { keyboardFocused.toggle() },
        ) { Image(systemName: "keyboard") }
    }

    /// 끌기 잠금 토글 — 켜면 1손가락 드래그가 tap-and-a-half 타이밍 없이 바로 «누른 채 끌기» 로
    /// 시작한다(텍스트 선택·창 이동의 모터 접근성 — 정밀 타이밍 곡예 불필요). 활성 시 accent 로
    /// 표시되고 캔버스 커서 링도 accent 로 바뀐다. 손가락을 들면 매번 up(버튼 끼임 없음), 무장은 유지.
    private var dragLockToggleButton: some View {
        ChatKeyButton(
            tint: dragLockArmed ? Theme.accent : .secondary,
            accessibilityLabel: dragLockArmed ? "끌기 잠금 끄기" : "끌기 잠금 켜기",
            action: {
                dragLockArmed.toggle()
                if dragLockArmed { scrollModeArmed = false } // 상호 배타 — 1손가락 드래그 의미는 하나만.
            },
        ) { Image(systemName: dragLockArmed ? "hand.draw.fill" : "hand.draw") }
    }

    /// 스크롤 모드 토글 — 켜면 1손가락 드래그가 커서 이동 대신 «스크롤 휠» 이 된다(2손가락 스크롤이
    /// 어려운 사용자용 모터 접근성). 탭=클릭은 그대로라 «탭으로 누르고, 한 손가락으로 스크롤» 이 된다.
    /// 활성 시 accent 로 표시되고, 끌기 잠금과 상호 배타라 켜면 끌기 잠금은 해제된다.
    private var scrollModeToggleButton: some View {
        ChatKeyButton(
            tint: scrollModeArmed ? Theme.accent : .secondary,
            accessibilityLabel: scrollModeArmed ? "스크롤 모드 끄기" : "스크롤 모드 켜기",
            action: {
                scrollModeArmed.toggle()
                if scrollModeArmed { dragLockArmed = false } // 상호 배타 — 1손가락 드래그 의미는 하나만.
            },
        ) { Image(systemName: scrollModeArmed ? "arrow.up.and.down.circle.fill" : "arrow.up.and.down.circle") }
    }

    /// 보안 입력 토글 — 켜면 입력창이 SecureField(별표 마스킹)가 돼 주변 시선으로부터 가린다.
    /// 활성 시 accent 로 표시. 전환 시 필드 identity 가 바뀌어 포커스가 빠질 수 있어, 키보드가
    /// 올라와 있었으면 다음 런루프에 포커스를 다시 요청해 소프트 키보드를 유지한다.
    private var secureToggleButton: some View {
        ChatKeyButton(
            tint: secureInput ? Theme.accent : .secondary,
            accessibilityLabel: secureInput ? "비밀번호 가리기 끄기" : "비밀번호 가리기",
            action: {
                let wasFocused = keyboardFocused
                secureInput.toggle()
                if wasFocused { DispatchQueue.main.async { keyboardFocused = true } }
            },
        ) { Image(systemName: secureInput ? "eye.slash" : "eye") }
    }

    /// 전송 — 입력창의 텍스트를 Unicode 로 주입. 보낼 게 없으면 흐리게 비활성.
    private var sendButton: some View {
        ChatKeyButton(
            tint: keyboardText.isEmpty ? .secondary : Theme.accent,
            isEnabled: !keyboardText.isEmpty,
            accessibilityLabel: "전송",
            action: { sendKeyboardText() },
        ) { Image(systemName: "paperplane.fill") }
    }

    /// 캡처 대상 창 선택 — 0 이면 전체 화면 복귀. 헬퍼가 ROI 를 리셋하고 새 필터로 재구성하므로
    /// 로컬 줌/ROI 도 맞춰 리셋한다. 실제 적용 상태는 헬퍼의 capture_target 보고로 재동기화.
    private func selectWindow(_ windowId: Int) {
        guard windowId != selectedWindowId else { return }
        selectedWindowId = windowId
        frame = nil  // 이전 대상 잔상 제거 — 새 프레임이 올 때까지 대기 화면.
        currentROI = Self.fullROI
        pendingROIHandoff = false
        resetToken += 1
        recenterToken += 1
        Task { await ws?.sendSetWindow(windowId) }
    }

    /// «창이 닫혀 전체 화면으로 돌아왔어요» 캡슐 — 4초 후 자동 해제(restoreHint 와 같은 토큰 패턴).
    @MainActor
    private func showWindowClosedHint() {
        windowClosedHintToken += 1
        let token = windowClosedHintToken
        withAnimation { windowClosedHintVisible = true }
        Task {
            try? await Task.sleep(nanoseconds: 4_000_000_000)
            guard token == windowClosedHintToken else { return }
            withAnimation { windowClosedHintVisible = false }
        }
    }

    private func selectDisplay(_ index: Int) {
        guard index != selectedDisplay else { return }
        selectedDisplay = index
        selectedWindowId = 0  // 디스플레이 «명시» 선택 = 전체 화면 모드 — 헬퍼도 창 타겟을 푼다.
        frame = nil  // 이전 디스플레이 잔상 제거 — 새 프레임이 올 때까지 대기 화면.
        // 디스플레이 전환 시 헬퍼가 ROI 를 전체로 리셋하므로 로컬도 맞추고, 새 모니터의 즐겨찾기 로드.
        currentROI = Self.fullROI
        pendingROIHandoff = false
        recenterToken += 1  // 새 모니터 — 커서 재중앙.
        loadFavorites()
        Task {
            await ws?.sendSetDisplay(index)
            // 새 모니터의 «마지막 줌 위치» 복원 — 헬퍼는 stdin 명령을 순차 처리하므로
            // display 적용(ROI 전체 리셋) 뒤에 이 ROI 가 먹는다.
            if roiTransferEnabled, let roi = loadLastROI(), roi != Self.fullROI {
                currentROI = roi
                pendingROIHandoff = true
                await ws?.sendSetROI(x: Double(roi.minX), y: Double(roi.minY), w: Double(roi.width), h: Double(roi.height))
                showRestoreHint()
            }
        }
    }

    /// 특수키/화살표 한 칸 — 아이콘만 있는 균일 정사각 ChatKeyButton. cmd 키를 헬퍼로 전송.
    private func cmdKey(_ icon: String, _ key: String, _ a11y: LocalizedStringKey) -> some View {
        ChatKeyButton(accessibilityLabel: a11y, action: {
            Task { await send(["cmd": "key", "key": key]) }
        }) {
            Image(systemName: icon)
        }
    }

    /// 글리프 키(예: «/») — 특수 키코드가 없는 문자를 text 주입으로 보낸다. 글리프를 그대로 표시.
    private func charKey(_ ch: String, _ a11y: LocalizedStringKey) -> some View {
        ChatKeyButton(accessibilityLabel: a11y, action: {
            Task { await send(["cmd": "text", "text": ch]) }
        }) {
            Text(verbatim: ch)
        }
    }

    private func sendKeyboardText() {
        let t = keyboardText
        keyboardText = ""
        guard !t.isEmpty else { return }
        Task { await send(["cmd": "text", "text": t]) }
    }

    // MARK: - 입력 throttle

    /// move 는 절대좌표라 너무 잦으면 버려도 무방 — ~33ms throttle(드롭).
    private func throttleSend(_ event: [String: Any]) {
        let now = Date()
        guard now.timeIntervalSince(lastMoveSent) > 0.033 else { return }
        lastMoveSent = now
        Task { await send(event) }
    }

    /// 스크롤은 «증분» 이라 드롭하면 거리가 사라진다 → 증분을 누적해 ~33ms 마다 «합계» 를 보낸다.
    /// (옛 버전은 throttle 로 그냥 버려 손가락 이동의 ~1/10 만 스크롤되던 버그.)
    @MainActor
    private func accumulateScroll(_ dx: CGFloat, _ dy: CGFloat) {
        scrollAccumX += dx
        scrollAccumY += dy
        if Date().timeIntervalSince(lastScrollSent) > 0.033 { flushScroll() }
    }

    /// 누적 스크롤 합계를 한 번에 전송하고 누적 리셋(드래그 종료 시에도 호출해 잔여 손실 방지).
    @MainActor
    private func flushScroll() {
        guard scrollAccumX != 0 || scrollAccumY != 0 else { return }
        lastScrollSent = Date()
        let sx = Double(scrollAccumX) * Self.scrollFactor
        let sy = Double(scrollAccumY) * Self.scrollFactor
        scrollAccumX = 0
        scrollAccumY = 0
        Task { await send(["cmd": "scroll", "dx": sx, "dy": sy]) }
    }

    // MARK: - 줌 ROI (하이브리드 D)

    /// 줌 정착 가시영역(현재 ROI 기준 0..1)을 전체화면 절대 ROI 로 «합성» 해 서버에 요청. 중첩 줌도
    /// 누적된다. native ROI 프레임이 도착하면(onFormatChange) 로컬 줌을 1x 로 리셋해 흐릿한 디지털
    /// 확대가 선명한 native 크롭으로 매끄럽게 바뀐다(즉시 로컬 줌 + 정착 후 서버 보정 = 하이브리드).
    @MainActor
    private func requestROI(visible: CGRect) {
        // 확대 영역 전송 OFF — 서버 crop 없이 로컬 디지털 줌만 쓴다(전체 화면 스트림 유지).
        // 창 스코프도 마찬가지 — 창 자체가 관심영역이라 ROI 를 보내지 않는다(로컬 줌만).
        guard roiTransferEnabled, selectedWindowId == 0 else { return }
        let cur = currentROI
        // 가시영역(현재 ROI 기준, 축소 시 [0,1] 밖 가능)을 절대 좌표로 합성 후 [0,1] 클램프.
        var nx = cur.minX + visible.minX * cur.width
        var ny = cur.minY + visible.minY * cur.height
        var nw = visible.width * cur.width
        var nh = visible.height * cur.height
        nx = max(0, min(1, nx)); ny = max(0, min(1, ny))
        nw = max(0.05, min(1 - nx, nw)); nh = max(0.05, min(1 - ny, nh))
        // 거의 전체로 넓어지면 ROI 해제(전체 프레임 복귀).
        if nw >= 0.96, nh >= 0.96 {
            guard currentROI != Self.fullROI else { return }
            currentROI = Self.fullROI
            pendingROIHandoff = true
            saveLastROI(nil) // 전체로 돌아왔으면 다음 진입도 전체부터.
            Task { await ws?.sendClearROI() }
            return
        }
        // 변화가 미미하면(이미 거의 그 영역) 재인코딩 생략.
        guard abs(nx - cur.minX) > 0.02 || abs(ny - cur.minY) > 0.02 || abs(nw - cur.width) > 0.02 else { return }
        currentROI = CGRect(x: nx, y: ny, width: nw, height: nh)
        pendingROIHandoff = true
        saveLastROI(currentROI) // 다음 진입 때 이 위치로 복원.
        Task { await ws?.sendSetROI(x: Double(nx), y: Double(ny), w: Double(nw), h: Double(nh)) }
    }

    /// 리셋 버튼 — 로컬 줌 1x + ROI 해제(전체 화면 복귀) + 커서 재중앙.
    @MainActor
    private func resetZoomAndROI() {
        resetToken += 1
        recenterToken += 1
        guard currentROI != Self.fullROI else { return }
        currentROI = Self.fullROI
        pendingROIHandoff = false
        saveLastROI(nil) // 명시적 리셋 = «전체로 보겠다» — 다음 진입에 복원하지 않는다.
        Task { await ws?.sendClearROI() }
    }

    // MARK: - 줌 즐겨찾기 (모니터별)

    /// 우상단 즐겨찾기 버튼 — 탭=저장된 ROI 적용(없으면 현재 저장), 길게=현재 ROI 저장/덮어쓰기.
    @ViewBuilder
    private func favoriteButton(slot: Int) -> some View {
        let saved = favSlots[slot] != nil
        Button {
            if saved { applyFavorite(slot) } else { saveFavorite(slot) }
        } label: {
            favIcon(saved ? "\(slot + 1).circle.fill" : "\(slot + 1).circle")
        }
        .accessibilityLabel(saved ? Text("즐겨찾기 적용") : Text("즐겨찾기 저장"))
        .simultaneousGesture(LongPressGesture().onEnded { _ in saveFavorite(slot) })
    }

    /// 우상단 원형 버튼 공통 스타일(즐겨찾기·리셋 동일).
    private func favIcon(_ systemName: String) -> some View {
        Image(systemName: systemName)
            .font(.callout.weight(.semibold))
            .foregroundStyle(Theme.onAccent)
            .padding(10)
            .background(.ultraThinMaterial, in: Circle())
    }

    /// 저장된 줌 영역으로 점프 — currentROI 설정 + 서버 ROI 요청(도착 시 로컬 줌 1x 리셋).
    @MainActor
    private func applyFavorite(_ slot: Int) {
        guard let roi = favSlots[slot], roi != Self.fullROI else { return }
        currentROI = roi
        pendingROIHandoff = true
        saveLastROI(roi) // 즐겨찾기로 점프한 위치도 «마지막 위치» 다.
        Task { await ws?.sendSetROI(x: Double(roi.minX), y: Double(roi.minY), w: Double(roi.width), h: Double(roi.height)) }
    }

    /// 현재 줌 영역을 슬롯에 저장(모니터별). 전체(줌 안 함)는 저장 의미 없어 무시.
    @MainActor
    private func saveFavorite(_ slot: Int) {
        guard currentROI != Self.fullROI else { return }
        favSlots[slot] = currentROI
        UserDefaults.standard.set(Self.roiString(currentROI), forKey: favKey(slot))
    }

    /// 현재 선택된 디스플레이의 즐겨찾기 2슬롯을 로드 — 디스플레이 전환/목록 수신 시 재호출.
    private func loadFavorites() {
        favSlots = (0..<2).map { slot in
            UserDefaults.standard.string(forKey: favKey(slot)).flatMap(Self.roiFromString)
        }
    }

    /// «모니터별» 영속 키 — 디스플레이 인덱스 기준(세션 내 모니터 1:1, 듀얼 모니터 각각).
    private func favKey(_ slot: Int) -> String { "mirror.roi.fav.\(selectedDisplay).\(slot)" }

    private static func roiString(_ r: CGRect) -> String {
        "\(r.minX),\(r.minY),\(r.width),\(r.height)"
    }
    /// 앞 4개 성분만 ROI 로 읽는다 — «마지막 줌 위치» 는 5번째에 저장시각을 덧붙인다(LRU 정리용).
    private static func roiFromString(_ s: String) -> CGRect? {
        let p = s.split(separator: ",").compactMap { Double($0) }
        guard p.count >= 4 else { return nil }
        return CGRect(x: p[0], y: p[1], width: p[2], height: p[3])
    }

    // MARK: - 마지막 줌 위치 (세션 × 모니터별)

    /// «세션 × 모니터별» 마지막 ROI 를 단일 dict 키에 모아 저장 — 세션이 삭제돼도 고아 키가
    /// UserDefaults 에 무한히 쌓이지 않게 저장시각 기준 LRU 로 상한을 지킨다.
    /// 메인(세션 목록) 진입은 sessionId 가 `__desktop__` 이라 세션들과 자연히 분리된다.
    private static let lastROIStoreKey = "mirror.roi.last.v1"
    private static let lastROIMax = 64

    private var lastROIKey: String { "\(sessionId)|\(selectedDisplay)" }

    /// 현재 세션×디스플레이의 마지막 줌 위치를 저장(roi=nil 이면 삭제 — 전체 화면으로 끝낸 의도).
    private func saveLastROI(_ roi: CGRect?) {
        var store = (UserDefaults.standard.dictionary(forKey: Self.lastROIStoreKey) as? [String: String]) ?? [:]
        if let roi {
            store[lastROIKey] = Self.roiString(roi) + ",\(Date().timeIntervalSince1970)"
        } else {
            store.removeValue(forKey: lastROIKey)
        }
        if store.count > Self.lastROIMax {
            let stamp: (String) -> Double = { Double($0.split(separator: ",").last ?? "0") ?? 0 }
            let oldest = store.sorted { stamp($0.value) < stamp($1.value) }.prefix(store.count - Self.lastROIMax)
            for (k, _) in oldest { store.removeValue(forKey: k) }
        }
        UserDefaults.standard.set(store, forKey: Self.lastROIStoreKey)
    }

    private func loadLastROI() -> CGRect? {
        let store = UserDefaults.standard.dictionary(forKey: Self.lastROIStoreKey) as? [String: String]
        return store?[lastROIKey].flatMap(Self.roiFromString)
    }

    /// 진입 후 첫 프레임에서 마지막 줌 위치를 1회 자동 복원 — 즐겨찾기 적용과 같은 경로
    /// (currentROI + 서버 ROI 요청, 도착 시 로컬 줌 1x 핸드오프). jpeg 폴백은 프레임마다
    /// onFirstContent 가 호출되므로 lastROIRestored 로 1회를 보장한다.
    @MainActor
    private func restoreLastROIIfNeeded() {
        guard !lastROIRestored else { return }
        lastROIRestored = true
        guard roiTransferEnabled, selectedWindowId == 0, currentROI == Self.fullROI,
              let roi = loadLastROI(), roi != Self.fullROI else { return }
        currentROI = roi
        pendingROIHandoff = true
        Task { await ws?.sendSetROI(x: Double(roi.minX), y: Double(roi.minY), w: Double(roi.width), h: Double(roi.height)) }
        showRestoreHint()
    }

    /// 복원 안내 캡슐 표시 — 4초 후 자동 해제. 토큰으로 연속 복원(디스플레이 전환) 시
    /// 이전 타이머가 새 캡슐을 일찍 닫지 않게 한다.
    @MainActor
    private func showRestoreHint() {
        restoreHintToken += 1
        let token = restoreHintToken
        withAnimation { restoreHintVisible = true }
        Task {
            try? await Task.sleep(nanoseconds: 4_000_000_000)
            guard token == restoreHintToken else { return }
            withAnimation { restoreHintVisible = false }
        }
    }

    /// 최초 1회 «길게 눌러 저장/덮어쓰기» 툴팁 — 첫 프레임 도착 시 띄우고 5초 후 자동 해제.
    @MainActor
    private func maybeShowFavHint() {
        guard roiTransferEnabled, selectedWindowId == 0, !favHintShown, !favHintVisible else { return }
        withAnimation { favHintVisible = true }
        Task {
            try? await Task.sleep(nanoseconds: 5_000_000_000)
            dismissFavHint()
        }
    }

    @MainActor
    private func dismissFavHint() {
        guard favHintVisible else { return }
        withAnimation { favHintVisible = false }
        favHintShown = true
    }

    // MARK: - 커스텀 단축키

    /// 단축키 버튼 — 등록돼 있으면 아이콘(탭=실행, 길게=편집), 비어있으면 + (탭=만들기 시트).
    @ViewBuilder
    private func shortcutButton(slot: Int) -> some View {
        let sc = shortcuts[slot]
        ChatKeyButton(
            tint: sc != nil ? Theme.accent : .secondary,
            accessibilityLabel: sc.map { LocalizedStringKey($0.combo) } ?? "단축키 추가",
            action: {
                if let sc {
                    Task { await send(["cmd": "hotkey", "key": sc.key, "mods": sc.mods]) }
                } else {
                    editingShortcut = EditingShortcut(slot: slot)
                }
            },
        ) { Image(systemName: sc?.icon ?? "plus") }
            .simultaneousGesture(LongPressGesture().onEnded { _ in
                editingShortcut = EditingShortcut(slot: slot)
            })
    }

    private func shortcutKey(_ slot: Int) -> String { "mirror.shortcut.\(slot)" }

    private func loadShortcuts() {
        shortcuts = (0..<8).map { slot in
            guard let data = UserDefaults.standard.data(forKey: shortcutKey(slot)) else { return nil }
            return try? JSONDecoder().decode(MirrorShortcut.self, from: data)
        }
    }

    private func saveShortcut(_ slot: Int) {
        if let sc = shortcuts[slot], let data = try? JSONEncoder().encode(sc) {
            UserDefaults.standard.set(data, forKey: shortcutKey(slot))
        } else {
            UserDefaults.standard.removeObject(forKey: shortcutKey(slot))
        }
    }

    // MARK: - WS 수명주기

    @MainActor
    private func begin() async {
        guard ws == nil else { return }
        // 진입마다 키프레임 대기 상태로 리셋. 첫 프레임이 레이어에 올라가면 대기 오버레이 내림.
        hasVideo = false
        controlBlocked = false // 새 헬퍼가 곧 control_status 로 다시 보고.
        currentROI = Self.fullROI
        pendingROIHandoff = false
        windows = []
        selectedWindowId = 0 // 헬퍼는 전체 화면으로 시작 — 실제 대상은 capture_target 보고로 동기화.
        lastROIRestored = false // 첫 프레임에서 마지막 줌 위치 1회 복원.
        loadFavorites() // 현재 디스플레이의 줌 즐겨찾기 로드.
        loadShortcuts() // 커스텀 단축키 8슬롯 로드.
        renderer.reset()
        renderer.audioEnabled = audioEnabled
        renderer.onFirstFrame = {
            hasVideo = true
            onFirstContent()
        }
        renderer.onFormatChange = {
            // native ROI 프레임 도착 → 로컬 줌 1x 로 리셋(흐릿한 줌 → 선명 ROI 매끄러운 전환).
            if pendingROIHandoff {
                resetToken += 1
                pendingROIHandoff = false
            }
            formatToken += 1 // 새 videoSize 로 전체화면 외곽선 다시 그리기.
        }
        let client = WSClient(auth: api.auth, conn: conn, sessionId: sessionId) { evt in
            switch evt {
            case .screenFrame(let jpeg, _):
                // jpeg 폴백 경로(옛 daemon 또는 비디오 미지원) — UIImageView 로 표시.
                frameStats.lastInboundAt = Date()
                frameStats.tick += 1
                if let img = UIImage(data: jpeg) {
                    frame = img
                    onFirstContent()
                }
            case .screenVideo(let payload):
                // h264 경로 — renderer 가 디스플레이 레이어에 직접 enqueue(GPU 디코드+렌더).
                // @State 갱신 없음(참조 박스 기록만) — 프레임당 SwiftUI body 재평가를 막는다.
                frameStats.lastInboundAt = Date()
                frameStats.tick += 1
                renderer.handle(payload)
            case .captureStatus(let r, let reason):
                running = r
                statusReason = reason
            case .controlStatus(let enabled, let reason):
                // 보기는 되는데 조작만 막힘(손쉬운 사용 미부여) — enabled=false + 권한 사유일 때만 안내.
                withAnimation { controlBlocked = !enabled && reason == "accessibility_permission" }
            case .captureDisplays(let d):
                // 같은 값 재할당 방지 — 열린 더보기 메뉴가 불필요하게 재구성(스크롤 리셋)되지 않게.
                if d != displays { displays = d }
            case .captureWindows(let w):
                if w != windows { windows = w }
            case .captureTarget(let wid, let reason):
                // 헬퍼가 보고한 «실제» 캡처 대상으로 동기화 — 창 닫힘 폴백·재진입 모두 이 경로.
                if wid != selectedWindowId {
                    selectedWindowId = wid
                    if wid == 0 {
                        currentROI = Self.fullROI
                        pendingROIHandoff = false
                        resetToken += 1
                        recenterToken += 1
                    }
                }
                if reason == "window_closed" { showWindowClosedHint() }
            default:
                break
            }
        }
        ws = client
        client.start()
        connectAttemptAt = Date()
        // 제어는 미러링 화면에 있는 동안 «항상 활성» — 따로 켜는 버튼 없이 바로 조작 가능.
        if canControl { await client.sendControlEnabled(true) }
        // 소켓이 붙고 subscribe 가 끝날 시간을 살짝 준 뒤 capture_start. 재시도 루프가 붙이므로
        // 첫 전송이 빠르면 무시될 수 있어 짧게 polling 하며 보낸다.
        for _ in 0..<20 {
            try? await Task.sleep(nanoseconds: 250_000_000)
            // 뷰가 dismiss 되면 .task 가 취소된다 — 여기서 빠져나가지 않으면 취소된 sleep 이 즉시
            // 반환되며 루프가 capture_start 를 연타로 재전송해 end() 의 정리와 충돌한다.
            if Task.isCancelled { return }
            await sendCaptureStartNow()
            if running { break }
        }
        // 첫 프레임 타임아웃 + 재연결 watchdog + fps 추정 — 뷰가 살아 있는 동안 계속 감시.
        await monitor()
    }

    /// 첫 콘텐츠(jpeg/h264) 도착 시 1회씩 — 즐겨찾기 힌트 + 온보딩 + 회전 안내.
    @MainActor
    private func onFirstContent() {
        restoreLastROIIfNeeded()
        maybeShowFavHint()
        maybeShowOnboarding()
        maybeShowRotateHint()
    }

    /// 코덱/화질 협상 파라미터 — supportsH264 + 연결종류(Tor) + 화질 프리셋(Part E)을 합쳐 산출.
    /// 직결은 빠른 링크라 더 선명·부드럽게, Tor 는 대역폭/RTT 제약으로 보수적. maxDim 은 nio-ssh
    /// 채널 안정성과 직결돼 과하지 않게 둔다. h264 미지원이면 jpeg 폴백.
    private func captureParams() -> (codec: String, fps: Int, bitrate: Int, maxDim: Int) {
        let codec = supportsH264 ? "h264" : "jpeg"
        let tor = conn.currentEndpointType == .torOnion
        let t = (MirrorQuality(rawValue: quality) ?? .auto).tier(tor: tor)
        return (codec, t.fps, t.bitrate, t.maxDim)
    }

    /// 현재 파라미터로 capture_start 전송(+제어 재보장). begin 루프·화질 변경·재시도·watchdog 공용.
    @MainActor
    private func sendCaptureStartNow() async {
        guard let ws else { return }
        let p = captureParams()
        if p.codec == "h264" {
            await ws.sendCaptureStart(
                codec: "h264", fps: p.fps, bitrate: p.bitrate, maxDim: p.maxDim, audio: audioEnabled)
        } else {
            await ws.sendCaptureStart(codec: "jpeg")
        }
        // 재연결 등으로 제어 게이트가 풀렸을 수 있어 활성 상태를 다시 보장.
        if canControl { await ws.sendControlEnabled(true) }
        // 헬퍼가 respawn 됐으면 창 타겟이 풀려 있다 — 선택이 살아있으면 재적용(같으면 헬퍼가 무시).
        if selectedWindowId != 0 { await ws.sendSetWindow(selectedWindowId) }
    }

    /// 「다시 시도」 버튼 — 타임아웃 카드를 닫고 타이머를 리셋한 뒤 캡처를 재요청.
    private func retryCapture() {
        withAnimation { showTrouble = false }
        connectAttemptAt = Date()
        Task { await sendCaptureStartNow() }
    }

    /// 감시 루프 — 1초마다: fps 추정 갱신 / 첫 프레임 타임아웃(문제 카드) / 스트림 stall 재연결.
    /// 뷰 dismiss 로 .task 가 취소되면 빠져나간다.
    @MainActor
    private func monitor() async {
        while !Task.isCancelled {
            try? await Task.sleep(nanoseconds: 1_000_000_000)
            if Task.isCancelled { return }
            let tick = frameStats.tick
            frameStats.tick = 0
            if fpsEstimate != tick { fpsEstimate = tick }
            let haveContent = hasVideo || frame != nil
            if !haveContent {
                // 첫 프레임이 ~10초 넘게 안 오면 행동 가능한 문제 해결 카드.
                if Date().timeIntervalSince(connectAttemptAt) > 10, !showTrouble {
                    withAnimation { showTrouble = true }
                }
            } else {
                if showTrouble { withAnimation { showTrouble = false } }
                // 스트림 stall(>5초 인바운드 없음) → 재연결 배너 + capture_start 재전송(3초 throttle).
                let stale = Date().timeIntervalSince(frameStats.lastInboundAt)
                if stale > 5 {
                    if !reconnecting { withAnimation { reconnecting = true } }
                    if Date().timeIntervalSince(lastRetryAt) > 3 {
                        lastRetryAt = Date()
                        await sendCaptureStartNow()
                    }
                } else if reconnecting {
                    withAnimation { reconnecting = false }
                }
            }
        }
    }

    @MainActor
    private func maybeShowOnboarding() {
        guard canControl, !onboardingShown, !showGestureGuide else { return }
        showGestureGuide = true
    }

    @MainActor
    private func maybeShowRotateHint() {
        // 온보딩이 떠 있으면(첫 실행) 양보 — 회전 안내는 다음 세션에. 가로면 불필요.
        guard !rotateHintShown, !rotateHintVisible, !showGestureGuide, !isLandscape else { return }
        withAnimation { rotateHintVisible = true }
        Task {
            try? await Task.sleep(nanoseconds: 4_000_000_000)
            dismissRotateHint()
        }
    }

    @MainActor
    private func dismissRotateHint() {
        guard rotateHintVisible else { return }
        withAnimation { rotateHintVisible = false }
        rotateHintShown = true
    }

    /// 정리(graceful teardown). 채널을 «바로» 끊지 않는다 — capture_stop 을 보낸 뒤 데몬이 그걸
    /// 처리하고 in-flight h264 프레임이 SSH 채널에서 빠질 때까지(인바운드가 잠잠해질 때까지) 짧게
    /// 기다렸다 WS 를 멈춘다. 닫는 도중 들어오는 프레임이 nio-ssh 자식 채널 teardown 과 레이스해
    /// 하드 트랩(앱 즉사)하던 문제를 막는다 — 멀티모니터·잠금화면처럼 레이트가 높을수록 잘 터졌다.
    /// 뷰는 이미 dismiss 됐으므로 이 대기는 UI 지연이 아니다(백그라운드 Task).
    private func end() {
        let client = ws
        ws = nil
        Task { @MainActor in
            await client?.sendControlEnabled(false)
            await client?.sendCaptureStop()
            await waitForInboundQuiet(maxWait: 0.8, quiet: 0.25)
            client?.stop()
        }
    }

    /// 인바운드 프레임이 `quiet` 초 동안 한 번도 안 오면 «잠잠» 으로 보고 반환(최대 `maxWait` 까지).
    /// onEvent 가 프레임마다 `lastInboundAt` 을 갱신하므로, capture_stop 이 실제로 먹혀 스트림이
    /// 멎은 시점을 데이터로 감지한다(고정 sleep 보다 정확 — Tor 저fps·직결 고fps 모두 대응).
    @MainActor
    private func waitForInboundQuiet(maxWait: TimeInterval, quiet: TimeInterval) async {
        let deadline = Date().addingTimeInterval(maxWait)
        while Date() < deadline {
            if Date().timeIntervalSince(frameStats.lastInboundAt) >= quiet { return }
            try? await Task.sleep(nanoseconds: 50_000_000) // 50ms
        }
    }

    private func send(_ event: [String: Any]) async {
        await ws?.sendInputEvent(event)
    }

}

/// 화질 프리셋 — 자동(연결종류 티어) / 부드럽게(고fps·저해상도) / 선명하게(고해상도·저fps).
/// daemon 의 slow-start·적응형 조절은 이 값을 ceiling 으로 그대로 적용된다.
enum MirrorQuality: String, CaseIterable, Identifiable {
    case auto, smooth, sharp
    var id: String { rawValue }
    var title: LocalizedStringKey {
        switch self {
        case .auto:   return "자동"
        case .smooth: return "부드럽게"
        case .sharp:  return "선명하게"
        }
    }
    var icon: String {
        switch self {
        case .auto:   return "wand.and.stars"
        case .smooth: return "hare"
        case .sharp:  return "sparkles"
        }
    }
    /// (maxDim, fps, bitrate) — 연결종류(Tor)별 보수/공격 티어.
    /// 직결은 모든 프리셋이 60fps 천장 — fps 가 아니라 해상도·비트레이트로 차등한다
    /// (체감 «버벅임» 은 fps 부족이 지배해서, 직결에서 fps 를 깎는 프리셋은 두지 않는다).
    /// 60fps 는 프레임당 비트가 절반이라 비트레이트를 30fps 대비 ~1.5배로 같이 올린다.
    /// 실제 레이트는 daemon 적응 루프가 채널 상태에 맞춰 정한다(이 값은 천장).
    /// Tor 는 대역폭/RTT 제약으로 보수적 유지.
    func tier(tor: Bool) -> (maxDim: Int, fps: Int, bitrate: Int) {
        switch self {
        case .auto:   return tor ? (1280, 10, 2_000_000) : (1440, 60, 9_000_000)
        case .smooth: return tor ? (1024, 15, 1_800_000) : (1280, 60, 7_000_000)
        case .sharp:  return tor ? (1440, 8, 3_000_000)  : (1920, 60, 12_000_000)
        }
    }
}

/// 제스처 치트시트 — 첫 진입 온보딩 + 더보기 메뉴에서 상시 재호출. 통합 트랙패드 제스처를
/// 아이콘 + 한 줄 설명 행으로 안내한다.
struct MirrorGestureGuide: View {
    @Environment(\.dismiss) private var dismiss

    private struct Row: Identifiable {
        let id = UUID()
        let icon: String
        let title: LocalizedStringKey
        let detail: LocalizedStringKey
    }

    private let rows: [Row] = [
        Row(icon: "hand.point.up.left", title: "한 손가락 드래그", detail: "커서 이동 — 천천히 움직이면 정밀, 빠르게 밀면 멀리"),
        Row(icon: "hand.tap", title: "한 번 탭", detail: "클릭 (빠르게 두·세 번 = 더블·트리플 클릭)"),
        Row(icon: "hand.point.up.braille", title: "두 손가락 탭", detail: "오른쪽 클릭"),
        Row(icon: "hand.draw.fill", title: "끌기 잠금 버튼", detail: "켜면 한 손가락 드래그가 바로 «누른 채 끌기» — 텍스트 선택·창 이동, 커서 링이 보라로 바뀌어요"),
        Row(icon: "arrow.up.and.down.circle.fill", title: "스크롤 모드 버튼", detail: "켜면 한 손가락 드래그로 스크롤해요 — 두 손가락 스크롤이 어려울 때"),
        Row(icon: "arrow.up.left.and.arrow.down.right", title: "두 손가락 오므리기·펴기", detail: "확대·축소 (정착하면 선명하게 다시 받아옴)"),
    ]

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(rows) { row in
                        HStack(spacing: Theme.Spacing.l) {
                            Image(systemName: row.icon)
                                .font(.title3)
                                .foregroundStyle(Theme.accent)
                                .frame(width: 34)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(row.title).font(.callout.weight(.semibold))
                                Text(row.detail).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        .padding(.vertical, 2)
                    }
                } header: {
                    Text("트랙패드처럼 사용하세요")
                } footer: {
                    Text("손가락으로 직접 화면을 만지는 게 아니라, 트랙패드처럼 커서를 움직여요.")
                }
            }
            .navigationTitle("제스처 도움말")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("시작하기") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }
}

/// 캡처 대상 선택 시트 — 더보기 메뉴에서 분리. 전체 화면 + 화면에 보이는 창을 «앱별» 로
/// 그룹핑(헤더=앱명)하고 상단 검색으로 좁힌다. 데스크톱엔 보통 20~30개 창이 떠 평면 나열은
/// 원하는 창을 찾기 어렵고 같은 앱의 여러 창이 흩어진다 — 그룹 + 검색으로 탐색 비용을 줄인다.
/// 앱이 창 1개면 헤더를 생략하고 행에 «앱 — 제목» 을 함께 보여 어떤 앱인지 알 수 있게 한다.
/// 창을 고르면 그 창만 송출(같은 비트레이트로 더 선명 + 다른 앱·알림 비노출, 프라이버시).
/// 창 수십 개가 실시간으로 churn 해도 안정적인 List 라 스크롤이 유지된다(긴 Menu 의 스크롤 리셋 회피).
struct CaptureTargetSheet: View {
    let windows: [ScreenWindow]
    let selectedWindowId: Int
    let onSelect: (Int) -> Void
    let onRefresh: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""

    private var trimmedQuery: String { query.trimmingCharacters(in: .whitespaces) }

    /// 앱별 그룹 — 검색어(앱명·창 제목)로 거른 뒤 앱명(로캘) 순, 그룹 내 제목 순.
    private var groups: [(app: String, windows: [ScreenWindow])] {
        let q = trimmedQuery.lowercased()
        let matched = q.isEmpty ? windows : windows.filter {
            $0.app.lowercased().contains(q) || $0.title.lowercased().contains(q)
        }
        return Dictionary(grouping: matched, by: \.app)
            .map { (app: $0.key,
                    windows: $0.value.sorted {
                        $0.titleLabel.localizedCaseInsensitiveCompare($1.titleLabel) == .orderedAscending
                    }) }
            .sorted { $0.app.localizedCaseInsensitiveCompare($1.app) == .orderedAscending }
    }

    var body: some View {
        NavigationStack {
            List {
                // 전체 화면 — 검색 중이 아닐 때만 맨 위 고정 옵션(필터 대상 아님).
                if trimmedQuery.isEmpty {
                    Section {
                        SelectableRow(
                            title: Text("전체 화면"),
                            selected: selectedWindowId == 0
                        ) { onSelect(0); dismiss() }
                    } footer: {
                        Text("창을 고르면 그 창만 보내요 — 더 선명하고, 다른 앱·알림은 보이지 않아요.")
                    }
                }
                ForEach(groups, id: \.app) { group in
                    if group.windows.count > 1 {
                        Section {
                            ForEach(group.windows) { w in
                                SelectableRow(
                                    title: Text(verbatim: w.titleLabel),
                                    selected: w.id == selectedWindowId
                                ) { onSelect(w.id); dismiss() }
                            }
                        } header: {
                            Text(verbatim: group.app)
                        }
                    } else if let w = group.windows.first {
                        // 앱이 창 1개 — 그룹 헤더 생략, 행에 «앱 — 제목» 으로 앱을 함께 노출.
                        Section {
                            SelectableRow(
                                title: Text(verbatim: w.displayName),
                                selected: w.id == selectedWindowId
                            ) { onSelect(w.id); dismiss() }
                        }
                    }
                }
            }
            .searchable(text: $query,
                        placement: .navigationBarDrawer(displayMode: .always),
                        prompt: Text("앱·창 제목 검색"))
            .navigationTitle("캡처 대상")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("닫기") { dismiss() }.tint(.primary)
                }
            }
            .overlay {
                if groups.isEmpty, !trimmedQuery.isEmpty {
                    ContentUnavailableView.search(text: trimmedQuery)
                }
            }
        }
        .presentationDetents([.medium, .large])
        .onAppear { onRefresh() }
    }
}

/// 디스플레이 선택 시트 — 멀티모니터에서 어느 화면을 볼지. 캡처 대상과 같은 분리 패턴.
struct DisplayPickerSheet: View {
    let displays: [ScreenDisplay]
    let selectedDisplay: Int
    let onSelect: (Int) -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(displays) { d in
                        SelectableRow(
                            title: Text("디스플레이 \(d.index + 1)"),
                            subtitle: Text(verbatim: "\(d.width)×\(d.height)"),
                            badge: d.main ? Text("주 디스플레이") : nil,
                            selected: d.index == selectedDisplay
                        ) { onSelect(d.index); dismiss() }
                    }
                }
            }
            .navigationTitle("디스플레이 선택")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("닫기") { dismiss() }.tint(.primary)
                }
            }
        }
        .presentationDetents([.medium, .large])
    }
}

/// 시트 공용 선택 행 — 본문 텍스트는 중립(primary), 선택 체크만 accent(보라). 토큰 정책 준수.
private struct SelectableRow: View {
    let title: Text
    var subtitle: Text? = nil
    var badge: Text? = nil
    let selected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: Theme.Spacing.m) {
                VStack(alignment: .leading, spacing: 2) {
                    title.font(.body)
                    if let subtitle {
                        subtitle.font(.caption).foregroundStyle(.secondary)
                    }
                }
                if let badge {
                    badge
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(.quaternary, in: Capsule())
                }
                Spacer(minLength: Theme.Spacing.m)
                if selected {
                    Image(systemName: "checkmark")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(Theme.accent)
                        .accessibilityHidden(true)  // 장식 — 선택 상태는 .isSelected 트레잇으로 전달.
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}
