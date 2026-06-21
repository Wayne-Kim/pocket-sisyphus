import SwiftUI
import SwiftTerm
import PhotosUI
import UIKit  // 터미널 라이트/다크 색(UIColor) 명시 지정

/// PTY 터미널 폭 모드 — 우상단 더보기 메뉴의 «터미널 폭» 토글이 고른다. «에이전트별로» 기억한다
/// (claude 세션에서 와이드로 두면 다음 claude 세션도 와이드 등). 영속 키는 에이전트 raw id 별로
/// 갈라진다 — `defaultMode(for:)` 참고.
///
/// - `wide`   : 폰트 비례 «고정 와이드» (11pt 기준 883pt, ≈135 cols) + 가로 스크롤 — 와이드 정렬
///              출력(ps·테이블·diff·박스아트)을 정렬 안 깨지게 가로로 훑는다. 모든 에이전트의 기본값.
/// - `manual` : 사용자가 cols 를 «직접 지정» (기본 ≈135) + 가로 스크롤 — 원하는 폭으로 고정한다.
///              지정 cols 는 `ChatView.ptyManualCols` 로 에이전트별로 기억한다.
///
/// 두 모드 다 «고정 폭 + 가로 스크롤» 이다. 화면(스마트폰) 폭에 맞춰 cols 를 «자동 산출» 하던 옛
/// `auto`(fit) 모드는 측정 cell 폭과 SwiftTerm 실측 cell 폭의 오차로 정렬이 늘 틀어져 제거했다
/// (사용자 보고, 2026-06). 폭을 화면에 맞추고 싶으면 수동에서 cols 를 직접 줄이면 된다.
///
/// rawValue 는 옛 `fit`/`wide` 를 그대로 둔다 — 이미 영속된 사용자 선택을 migration 없이 잇기 위함.
/// 옛 `auto`(fit) 선택자는 자동으로 `wide` 로, 옛 `manual`(wide) 선택자는 그대로 `manual` 로 잇는다.
///
/// 어느 모드든 SwiftTerm frame 폭이 바뀌면 sizeChanged delegate → sendPtyResize 로 daemon PTY
/// cols/rows 가 자동 동기화된다.
enum PtyWidthMode: String, CaseIterable {
    case wide = "fit"      // 옛 auto(fit) 자리 — 화면 폭 맞춤은 오차로 제거, 고정 와이드로 복원.
    case manual = "wide"   // 옛 wide 자리 — 컬럼 직접 지정. (그대로 유지.)

    /// 에이전트별 기본 폭 모드 — 사용자가 한 번도 고른 적 없는 에이전트에 적용된다(이후엔 기억된 값).
    /// 화면 폭 자동 맞춤(옛 auto)은 오차로 제거 — 모든 에이전트가 고정 와이드 기본.
    static func defaultMode(for agent: AgentKind) -> PtyWidthMode {
        .wide
    }
}

struct ChatView: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var tor: TorManager
    @EnvironmentObject var conn: ConnectionManager
    @EnvironmentObject var lifecycle: AppLifecycle
    /// 프로(주황) 기능 게이트 — 채팅 도구 칩·알림 음소거·미러링은 프로 전용. 미보유 시 페이월.
    @EnvironmentObject var purchase: PurchaseStore
    /// 출처 브리프 칩 탭 → `backlog/<id>` 딥링크. 백로그 탭으로 전환 + 브리프 상세 push 를
    /// 기존 딥링크 인프라(MainTabView·BacklogView 소비)에 위임한다.
    @EnvironmentObject var deepLink: DeepLinkRouter
    /// 세션 목록 캐시 — «세션 삭제» 가 낙관적으로 이 목록에서 현재 세션을 제거해, 채팅방을 나가면
    /// 세션 목록에도 항목이 남지 않게 한다(SessionsView 의 스와이프 삭제와 같은 경로).
    @EnvironmentObject var sessionCache: SessionListCache

    let session: SessionSummary
    /// 이 ChatView 가 모달(다른 채팅 위 .fullScreenCover)로 떠 있을 때의 닫기 핸들러.
    /// 루트 네비게이션으로 진입한 ChatView 는 nil — 시스템 back 버튼을 쓴다.
    /// non-nil 이면 좌상단에 «닫기» 버튼이 생긴다 (worktree 에서 연 세션 등).
    let onClose: (() -> Void)?
    /// worktree 에서 연 새 세션의 ChatView 를 모달로 구성할 때 재사용 — ApiClient tracker.
    private let inflight: InFlightTracker
    @StateObject private var vm: ChatViewModel
    /// 온디바이스 음성 입력(STT) — 입력바의 푸시-투-토크 마이크가 쓴다. WhisperKit(CoreML)로
    /// 인식은 100% 기기 안에서, 모델 가중치만 첫 사용 시 1회 다운로드해 캐시한다. 로케일은 앱 언어.
    /// 앱 전역 «공유» 인스턴스 — 방마다 새로 만들면 들어올 때마다 모델 준비가 다시 돌므로,
    /// 한 번 준비된 모델을 모든 채팅방이 재사용한다(@ObservedObject 로 관찰만, 소유는 싱글턴).
    @ObservedObject private var speech = WhisperSpeechRecognizer.shared
    /// 음성 모델이 «방금» 준비됐음을 잠깐 알리는 토스트 플래그 — modelState 가 .ready 로 바뀔 때
    /// 켜지고 몇 초 뒤 자동으로 꺼진다.
    @State private var showSpeechReadyToast = false
    @State private var input: String = ""
    // 입력창 포커스 — 화면 진입 시 자동 포커스는 하지 않는다 (사용자가 의도적으로 탭할 때만 키보드).
    @FocusState private var isInputFocused: Bool
    /// 현재 활성 키보드가 ASCII (영문/숫자) 인지 여부. 영문 키보드 시 SwiftTerm 이 직접
    /// keystroke 받아 PTY 로 byte 즉시 송신 (claude `/` 슬래시 명령 등 실시간 인터랙션).
    /// 한글/CJK IME 활성 시 SwiftUI TextField 가 markedText cycle 처리 + 줄 단위 송신.
    /// `UITextInputMode.currentInputModeDidChangeNotification` 으로 사용자가 키보드 언어
    /// 토글할 때 자동 갱신. PTY 세션에서만 의미 — SDK 세션은 항상 inputBar 사용.
    @State private var isAsciiKeyboard: Bool = true
    // 키보드 가시 상태는 NotificationCenter 로 추적해서, 닫기 버튼을 키보드가 열려 있을 때만 노출한다.
    @State private var isKeyboardVisible: Bool = false
    /// 이 세션 에이전트(`session.agent`)가 광고하는 capability 집합 — daemon `/api/agents` 에서
    /// 진입 시 1회 채운다. «휠 스크롤 버튼» 노출(needsWheelScroll)이 이 값을 읽는다. 비어 있음
    /// (조회 전/옛 daemon)이면 모든 게이트가 false → 기존 동작(비-copilot)과 동일하게 떨어진다.
    @State private var agentCapabilities: [String] = []
    // 터미널 강제 재시작 — 멈춘 REPL 을 죽이고 새 PTY 로 다시 시작. 사용자 실수 방지용 확인.
    @State private var showRestartConfirm: Bool = false
    @State private var isRestarting: Bool = false
    // 세션 삭제 — 채팅방을 나가고 세션을 영구 삭제. 파괴적이라 확인 다이얼로그를 거친다.
    @State private var showDeleteConfirm: Bool = false
    @State private var isDeleting: Bool = false
    // 세션 알림 음소거 토글 — PATCH 가 끝날 때까지 bell 버튼을 잠가 연타/경합을 막는다 (Tor RTT 수 초).
    @State private var isTogglingNotify: Bool = false
    // 「다음 정지 시 알림」 토글 — 호출이 끝날 때까지 버튼을 잠가 연타/경합을 막는다.
    @State private var isTogglingNextStop: Bool = false
    // 옛 floating 가상 키패드 (showVirtualKeypad + virtualKeypad overlay) 는 제거됨.
    // 화살표/Space/Enter 가 statusBar 두 번째 줄에 흡수되어 항상 노출 (사용자 wireframe, 2026-05).
    // 변경 파일 칩 탭 → Diff 시트.
    @State private var showDiffSheet: Bool = false
    // 브랜치 칩 탭 → 브랜치/worktree 시트.
    @State private var showBranchSheet: Bool = false
    // worktree 에서 «세션 열기» 를 누르면 BranchSheet 가 세션을 만들어 여기 담고 시트를 닫는다.
    // 시트가 «완전히» 닫힌 뒤(onDismiss) pendingNewSession 으로 옮겨 fullScreenCover 를 띄운다 —
    // 시트 dismiss 와 cover present 가 같은 런루프에 겹쳐 한쪽이 누락되는 race 를 피한다.
    @State private var worktreeSessionToOpen: SessionSummary?
    @State private var pendingNewSession: SessionSummary?
    // statusBar 폴더 아이콘 → 세션 repo 안 임의 경로의 파일 브라우저/뷰어.
    @State private var showFileBrowser: Bool = false
    // 우상단 모니터 미러링 버튼 → 미러링 풀스크린 (screen_capture_v1 일 때만 노출).
    @State private var showPreview: Bool = false
    // 도구 그룹의 프리뷰 버튼 → 라이브 프리뷰(폰에서 dev 서버 렌더, preview_proxy_v1).
    @State private var showLivePreview: Bool = false
    /// 프로 전용 기능(도구 칩·음소거 등)을 미보유 사용자가 누르면 띄우는 페이월. non-nil =
    /// 어떤 ProFeature 가 trigger 했는지. `.proPaywall(item:)` 가 PaywallView 시트로 띄운다.
    @State private var paywallFeature: ProFeature?
    // 이미지 첨부 — 사진 선택 → draft 누적(첨부 버튼 노출) → 시트에서 이미지별 요구사항 입력 →
    // 업로드 + 경로↔요구사항 매핑 프롬프트 전송.
    @State private var showPhotoPicker: Bool = false
    @State private var pickerItems: [PhotosPickerItem] = []
    @State private var attachments: [AttachmentDraft] = []
    @State private var attachmentDir: String = "attachments"
    @State private var showAttachmentSheet: Bool = false
    @State private var isUploadingAttachments: Bool = false
    // 파일 참조 첨언 — 파일 탐색기에서 파일 전체/라인 범위를 모아(fileRefs) 각각 요구사항을
    // 달고(FileReferenceSheet) 경로↔요구사항 매핑 프롬프트로 전송. 업로드 없음 (repo 내 파일).
    @State private var fileRefs: [FileReferenceDraft] = []
    @State private var showFileRefSheet: Bool = false
    @State private var isSendingFileRefs: Bool = false
    // 프롬프트 보관함 — 스니펫 + 최근 보낸 프롬프트를 골라 입력창에 채우는 시트.
    @State private var showPromptLibrary: Bool = false
    // 미러링에서 캡처/녹화로 첨부가 추가됐는가 — 미러링 커버가 «완전히» 닫힌 뒤(onDismiss)
    // 첨부 시트를 열어 요구사항을 바로 달 수 있게 한다 (커버↔시트 모달 전환 충돌 회피).
    @State private var pendingMirrorCaptures: Bool = false
    // 현재 첨부 묶음이 미러링 캡처/녹화에서 왔는가 — 첨부 시트의 «전체 요청» 입력란 노출 게이트.
    // (사진첩 첨부는 이미지별 요구사항으로 충분하지만, 녹화 단계 이미지는 «참고 자료» 라
    // 이 자료로 무엇을 시킬지 적는 자리가 따로 필요하다.) 전송/비움 시 해제.
    @State private var mirrorCaptureMode: Bool = false
    // 미러링 캡처 첨부의 «전체 요청» 본문 — 프롬프트 맨 앞에 실린다.
    @State private var attachmentOverallInstruction: String = ""

    /// 첨부/참조 시트·이름 변경 alert 등 모달이 떠 있는지. true 면 키보드는 그 모달의
    /// TextField 소유 — 이때 ChatView 의 언어-변경 focus swap 이 채팅 입력 필드를 가로채면
    /// 안 된다(시트 위에서 입력 필드로 포커스가 튀는 버그 방지).
    private var isModalPresented: Bool {
        showAttachmentSheet || showFileRefSheet || showFileBrowser
            || showDiffSheet || showBranchSheet
            || showRestartConfirm || showPhotoPicker
            || showPromptLibrary || showFind
    }
    // PTY 터미널 폰트 크기 (pt) — 우상단 메뉴의 «작게/크게» 버튼으로 사용자가 조정.
    // ScrollView frame 폭은 이 값에 비례해 확장된다.
    // 디바이스/세션을 가로질러 영속화 (UserDefaults).
    @AppStorage("chat.pty.fontSize") private var ptyFontSize: Double = ChatView.ptyFontSizeDefault
    private static let ptyFontSizeDefault: Double = 11
    private static let ptyFontSizeMin: Double = 9
    private static let ptyFontSizeMax: Double = 22
    // 11pt 기준 frame 폭 883pt — 비례 상수. SwiftTerm 의 sizeChanged delegate 가 이 폭에서
    // 컴퓨트한 cols 를 daemon PTY 에 resize 요청한다 (대략 135 cols @ 11pt 모노스페이스).
    // 옛 800pt(=~120 cols) 는 claude REPL 의 코드 블록 / 명령 출력에서 불필요한 줄바꿈이
    // 자주 발생해 확장. 한때 1200pt(=~180 cols) 까지 갔지만 모바일 가로 스크롤 거리가 너무
    // 길어 사용성 손해 — 850(~130) 으로 안정화 (2026-05) 후 Mac 미러 가독성 위해 +5col → 883.
    private static let ptyFrameWidthPerPt: Double = 883.0 / 11.0
    // 위 frame 폭이 산출하는 «기준 cols» — 11pt 기준 883pt 가 대략 135 cols 였다(옛 와이드 폭).
    // 수동(직접 지정) 모드는 이 비율을 cols 당 폭으로 환산해 사용자가 고른 cols 로 frame 폭을 만든다.
    private static let ptyManualColsBaseline: Int = 135
    private static let ptyColWidthPerPt: Double = ptyFrameWidthPerPt / Double(ptyManualColsBaseline)
    // 수동 모드의 «직접 지정 cols» — 우상단 메뉴의 컬럼 스테퍼로 조정. 폭 모드와 같이 에이전트별로
    // 기억하므로 AppStorage 키를 세션 에이전트 raw id 로 갈린다("chat.pty.cols.<agent>"). 기본값은
    // 옛 와이드(135 cols) 와 동일 — 옛 wide 사용자가 그대로 같은 폭을 유지한다.
    @AppStorage private var ptyManualCols: Int
    private static let ptyManualColsKeyPrefix = "chat.pty.cols."
    private static let ptyManualColsMin: Int = 40
    private static let ptyManualColsMax: Int = 220
    private static let ptyManualColsStep: Int = 1
    // PTY 폭 모드 (와이드/수동) — 우상단 «터미널 폭» 토글이 고른다. «에이전트별로» 기억하므로
    // AppStorage 키는 세션의 에이전트 raw id 로 갈린다("chat.pty.widthMode.<agent>"). 키와 에이전트별
    // 기본값(모두 와이드)은 init 에서 주입한다.
    // AppStorage 는 rawValue(String) 로 저장 — Picker selection 이 바로 바인딩한다.
    @AppStorage private var ptyWidthModeRaw: String
    /// 이 세션의 에이전트별 폭 모드 영속 키 prefix — 에이전트 raw id 를 붙여 완성한다.
    private static let ptyWidthModeKeyPrefix = "chat.pty.widthMode."
    private var ptyWidthMode: PtyWidthMode { PtyWidthMode(rawValue: ptyWidthModeRaw) ?? .wide }
    /// 지금 «수동(직접 지정)» 으로 그릴지 — 수동이면 지정 cols 폭, 와이드면 폰트 비례 고정 폭. 둘 다 가로 스크롤.
    private var ptyManualWidth: Bool { ptyWidthMode == .manual }
    /// 터미널 frame 폭(pt). 수동: 지정 cols × 폰트 비례 cell 폭. 와이드: 폰트 비례 고정 폭(11pt 883pt, ≈135 cols).
    /// 두 모드 다 고정 폭 → 가로 스크롤로 훑는다 (화면 폭 자동 맞춤은 cell 폭 오차로 정렬이 틀어져 제거됨).
    private var ptyFrameWidth: CGFloat {
        if ptyManualWidth {
            return ceil(CGFloat(ptyManualCols) * CGFloat(ptyFontSize) * CGFloat(ChatView.ptyColWidthPerPt))
        }
        return ceil(CGFloat(ptyFontSize) * CGFloat(ChatView.ptyFrameWidthPerPt))
    }
    // statusBar 툴바 «키» 버튼의 공통 높이 (pt) — 우상단 메뉴의 «버튼 작게/크게» 로 조정.
    // 모든 ChatKeyButton 이 이 높이를 공유 (Environment 로 전파) 하고, 폰트·아이콘·패딩·모서리는
    // 이 높이에 비례해 함께 커진다. 세로(높이)는 균일, 가로는 텍스트 포함 버튼만 가변.
    @AppStorage("chat.toolbar.buttonHeight") private var toolbarButtonHeight: Double = ChatView.toolbarButtonHeightDefault
    private static let toolbarButtonHeightDefault: Double = 28
    private static let toolbarButtonHeightMin: Double = 24
    private static let toolbarButtonHeightMax: Double = 44
    // 「조용함」 힌트를 띄우기 시작하는 idle 임계(초). 12초 idle 휴리스틱이 «대기» 로 못 잡은
    // 채 오래 조용한 활성 세션을 표면화한다. 도구 연쇄로 출력이 흐르면 idle 이 0 으로 리셋돼
    // 헛경보가 안 나도록 분 단위로 넉넉히 잡는다 (대기로 잡힌 세션은 대기 배너가 따로 답한다).
    private static let quietSurfaceThresholdSec = 60
    // 크롬 숨김 FAB — 헤더(네비바)+입력바+상태바를 토글로 숨겨 터미널을 크게 본다. 현재 방향의
    // 토글이 꺼져 있으면 FAB 가 사라지고 숨겼던 크롬도 즉시 복구된다. 미러링(RemoteScreenView)과
    // 같은 @AppStorage 키를 공유 — 한 곳에서 켜면 양쪽에 다 적용. 가로·세로 따로 켤 수 있다.
    @AppStorage(ChromeHideFAB.landscapeKey) private var showChromeFABLandscape = ChromeHideFAB.defaultShown
    @AppStorage(ChromeHideFAB.portraitKey) private var showChromeFABPortrait = ChromeHideFAB.defaultShown
    // iPhone-only — verticalSizeClass==.compact 가 곧 가로. 회전 시 reactively 갱신된다.
    @Environment(\.verticalSizeClass) private var vSizeClass
    /// «세션 삭제» 후 채팅방을 닫고 세션 목록으로 돌아가기 위한 dismiss. 모달(onClose)로 떠 있으면
    /// onClose 를 우선 호출한다.
    @Environment(\.dismiss) private var dismiss
    @State private var chromeHidden = false

    // In-session 검색 (대화에서 찾기) — 우상단 돋보기 버튼이 토글. 현재 세션 transcript(SwiftTerm
    // 버퍼, 스크롤백 포함) 안에서 텍스트를 찾아 현재 매치를 하이라이트하고 매치 간 이동한다.
    // 검색은 100% 클라이언트(폰) 측 — 이미 로드된 버퍼 대상이라 새 daemon API 불필요.
    @State private var showFind = false
    @State private var findQuery = ""
    /// 전체 매치 수 (M). 0 이면 «결과 없음».
    @State private var findCount = 0
    /// 현재 매치 인덱스 (0-base). 표시는 findIndex+1 / findCount (예: 3/12).
    /// findNext 는 선택 다음 매치로, findPrevious 는 이전으로 순환 이동하므로 모듈러 증감으로
    /// SwiftTerm 검색 커서와 동기 유지된다 (M 이 정확한 한).
    @State private var findIndex = 0
    @FocusState private var isFindFocused: Bool
    /// 검색어 타이핑 디바운스 + 스트리밍 재계산을 합치는 태스크.
    @State private var findRecountTask: Task<Void, Never>?

    init(
        session: SessionSummary,
        auth: AuthStore,
        conn: ConnectionManager,
        inflight: InFlightTracker,
        onClose: (() -> Void)? = nil,
    ) {
        self.session = session
        self.onClose = onClose
        self.inflight = inflight
        // 폭 모드는 에이전트별로 기억한다 — 키를 세션 에이전트 raw id 로 갈라 AppStorage 를
        // 주입하고, 한 번도 고른 적 없으면 기본값(모두 와이드)을 wrappedValue 로 쓴다.
        let agentKind = AgentKind.from(id: session.agent)
        _ptyWidthModeRaw = AppStorage(
            wrappedValue: PtyWidthMode.defaultMode(for: agentKind).rawValue,
            ChatView.ptyWidthModeKeyPrefix + agentKind.rawId,
        )
        // 수동 모드의 직접 지정 cols 도 에이전트별로 기억 — 한 번도 고른 적 없으면 기준(135) cols.
        _ptyManualCols = AppStorage(
            wrappedValue: ChatView.ptyManualColsBaseline,
            ChatView.ptyManualColsKeyPrefix + agentKind.rawId,
        )
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        _vm = StateObject(wrappedValue: ChatViewModel(
            api: api,
            conn: conn,
            sessionId: session.id,
        ))
    }

    var body: some View {
        VStack(spacing: 0) {
            // 대화에서 찾기 — 돋보기 버튼으로 토글되는 찾기 바. 터미널 위(네비바 아래)에 얇게
            // 얹어 하단 입력/상태바와 충돌하지 않게 한다 (Safari 의 페이지 내 찾기와 같은 위치).
            if showFind {
                findBar
            }
            // 출처 브리프 칩 — 이 세션을 낳은 브리프(있을 때만)를 nav 바 «바로 아래» 고정 줄로
            // 보여 준다. 스크롤백 최상단까지 거슬러 가지 않아도 출처를 한눈에 보고, 탭하면 브리프
            // 상세로 점프(딥링크). 크롬 숨김 시엔 네비바와 함께 숨긴다.
            if !hideChrome {
                sourceBriefChip
            }
            // «연결 문제» 인라인 배너는 제거됨 — 사용자가 알아도 할 수 있는 액션이 없고
            // (재연결 버튼도 이전에 제거) 폴링이 자동으로 회복한다. vm.lastError 는 ViewModel
            // 내부 추적용으로 남지만 UI 에는 노출되지 않는다.
            //
            // SwiftTerm 으로 Mac 의 claude REPL 화면을 1:1 mirror (color/cursor/wizard 다).
            // 입력은 가상 입력창으로 한 줄씩 — Tor RTT 글자별 지연 회피 + 모바일 채팅 패턴.
            // 가로 ScrollView 로 wrap — daemon PTY 폭 (cols=120) 만큼 폭을 확보해서
            // claude REPL 의 box-drawing / 응답 텍스트가 모바일 좁은 폭에서 줄바꿈으로
            // 깨지지 않게 한다. 사용자는 가로 스크롤로 전체 화면을 본다.
            //
            // 옛 GeometryReader { ScrollView { PtyTerminalView.frame(height: geo.height) } }
            // 형태는 keyboard / firstUseHint 변동마다 closure 가 재평가되면서 SwiftUI
            // 의 view identity 가 흔들렸다. makeUIView 가 여러 번 호출 → 새 SwiftTerm
            // UIView 가 만들어지고, 동시에 ChatViewModel 의 ptyBytesBuffer 가 onPtyBytes
            // didSet 으로 매번 replay 됨 → 같은 raw bytes 가 여러 view 에 누적되어
            // UI 가 여러 겹으로 겹쳐 보이는 회귀 (2026-05-23). identity 안정성 우선해
            // maxHeight:.infinity 만 두고 firstUseHint 는 overlay 로 띄운다 — 사용자
            // 가 한 번이라도 보낸 적 있으면 overlay 가 사라져 터미널 면적이 그대로 유지됨.
            ScrollView(.horizontal, showsIndicators: false) {
                PtyTerminalView(vm: vm, fontSize: ptyFontSize)
                    // 와이드/수동 둘 다 «고정 폭»(와이드=폰트 비례 ≈135 cols, 수동=지정 cols) → 가로
                    // 스크롤로 훑는다. SwiftTerm 이 이 폭에서 cols 를 재계산해 sizeChanged →
                    // sendPtyResize 로 daemon PTY 와 동기화한다. (화면 폭 자동 맞춤은 cell 폭 오차로
                    // 정렬이 틀어져 제거 — 폭을 줄이려면 수동에서 cols 를 직접 낮춘다.)
                    .frame(width: ptyFrameWidth)
                    // 명시적 identity — keyboard open/close, hint overlay 변동, scenePhase
                    // 갱신 등으로 부모 view 가 재계산돼도 PtyTerminalView 의 SwiftUI
                    // identity 가 session.id 로 고정되어 makeUIView 가 세션당 정확히
                    // 1회만 호출된다. 옛 상태 (id 없음) 에선 같은 ChatView 안에서도
                    // bind 가 여러 번 일어나 onPtyBytes didSet 의 buffer replay 가
                    // 반복돼 UI 가 겹치는 회귀가 있었다 (2026-05-23).
                    .id(session.id)
            }
            .frame(maxHeight: .infinity)
            // 「로딩 중 빈-상태 금지」 — 콜드 진입에서 첫 청크가 도착하기 전(특히 Tor 위 느린 첫
            // 호출)까지 검은 빈 터미널만 보이면 «멈췄나/빈 세션인가» 인상을 준다. 내용이 한 번이라도
            // 도착하면(vm.hasTerminalContent) 사라지는 1회성 로딩 안내를 얹는다. 터치는 통과시켜
            // (allowsHitTesting=false) 로딩 중에도 터미널 제스처를 막지 않는다.
            .overlay {
                if !vm.hasTerminalContent {
                    LoadingStateView(message: "대화를 불러오는 중…")
                        .allowsHitTesting(false)
                }
            }
            // 와이드·수동 둘 다 고정 폭이라 가로 스크롤은 항상 켠다 (화면보다 넓으면 훑어서 본다).
            // 크롬 숨김 FAB — 설정에서 켜면 노출(세로/가로 무관). 헤더·입력바·상태바를 토글로
            // 숨겨 터미널을 크게 본다. 미러링 화면(RemoteScreenView)의 FAB 와 같은 모양·역할.
            .overlay(alignment: .bottomLeading) { chromeToggleFAB }
            // 옛 firstUseHint overlay («명령어를 입력해 보세요...») 는 PTY 모드 진짜 터미널
            // UX 로 전환되면서 불필요해져 제거 (2026-05). 사용자가 statusBar 토글 또는
            // 터미널 영역 탭으로 키보드 활성 — 안내 없이도 직관적.
            // 옛 floating 가상 키패드 overlay 도 제거됨 — statusBar 두 번째 줄로 흡수.
            // 크롬 숨김 토글이 ON 이면 하단 컨트롤(구분선·입력바·상태바)을 통째로 숨긴다 — FAB 로 복구.
            if !hideChrome {
                Divider()
                // 입력 전송 실패/연결 끊김 표면화 — fire-and-forget 키 입력이 silent drop 됐을 때.
                inputDeliveryBanner
                // 재연결이 «비복구» 사유(페어링 만료 등)로 중단됐을 때의 안내 — 「설정 필요」 계열
                // 이라 warning 톤(danger 아님). 사용자가 재페어링/업데이트로 직접 해소해야 한다.
                connectionNonRecoverableBanner
                // «에이전트가 나를 기다리는 중» 배너 — 딥링크/목록에서 들어왔을 때 스크롤백을
                // 뒤지지 않아도 «지금 내 차례» 임을 즉시 알 수 있게. ChatVM 이 WS turn_complete
                // (즉시) + 폴링 waiting_since (fallback) 로 켜고, 출력 재개/전송/exit 로 끈다.
                if vm.agentAwaitingUser {
                    agentWaitingBanner
                } else {
                    // 대기로 «안» 잡힌 활성 세션이 오래 조용하면 「조용함 N분」 으로 표면화 —
                    // 휴리스틱 false-negative 를 사람이 알아채는 신호. (조건 미달이면 아무것도 안 그림.)
                    quietHintBanner
                }
                // 음성 모델 다운로드 진행률 / 준비 완료 안내 배너.
                speechStatusBanner
                // 입력 필드를 툴바(statusBar) «위» 에 둔다 — 메시지가 길어져 inputBar 가 위로 자라도
                // 키패드/탐색기/전송 버튼은 키보드 바로 위(맨 아래)에 고정돼 손이 멀어지지 않는다 (사용자 요청).
                // SDK 모드: 항상 inputBar. PTY 모드: 영문 키보드면 SwiftTerm 직통(숨김), 비영문이거나
                // 작성 중 텍스트가 있으면 노출 (한글·영문 혼합 작성 후 한 번에 전송).
                if showInputBar {
                    inputBar
                }
                statusBar
            }
        }
        // 녹음 중 큰 플로팅 HUD — 작은 마이크 버튼은 엄지에 가려 안 보이므로, 화면 «위쪽»(엄지에서
        // 먼 곳)에 «녹음 중» 을 크게 띄워 누르고 있음을 확실히 알린다. 손가락 제스처는 마이크
        // 버튼이 받아야 하므로 HUD 는 hit-testing 을 끈다(터치 통과).
        .overlay(alignment: .top) { recordingHUD }
        .animation(.easeInOut(duration: 0.2), value: speech.isRecording)
        .animation(.easeInOut(duration: 0.2), value: vm.ptyInputDelivery)
        .animation(.easeInOut(duration: 0.2), value: vm.connectionNonRecoverable)
        .inFlightBanner()
        // 키보드 언어 변경 감지 — 사용자가 globe 키로 영문↔한글 토글 시 fire.
        // 활성 first responder 의 textInputMode 검사 → isAsciiKeyboard 갱신 → UI 자동 swap.
        .onReceive(NotificationCenter.default.publisher(for: UITextInputMode.currentInputModeDidChangeNotification)) { _ in
            updateKeyboardLanguage()
        }
        .onChange(of: isAsciiKeyboard) { newValue in
            // PTY 세션에서만 focus swap. SDK 세션은 항상 inputBar.
            guard session.isPty else { return }
            // 첨부/참조 시트·이름변경 alert 등 모달이 떠 있으면, 그 안의 TextField 입력모드
            // 변경이 currentInputModeDidChangeNotification 으로 이 핸들러를 트리거한다.
            // 그때 채팅 입력 필드로 focus 를 끌어오면 시트 위에서 포커스가 튀므로 무시한다.
            guard !isModalPresented else { return }
            // 작성 중인 텍스트가 있으면 (한+영 혼합 입력 중) 언어를 바꿔도 모드를 그대로 둔다.
            // inputBar 포커스/내용을 유지해 한 메시지에 두 언어를 섞어 한 번에 보낼 수 있게 (사용자 요청).
            guard input.isEmpty else { return }
            if newValue {
                // ASCII 모드 — SwiftTerm first responder, inputBar focus 떼기.
                isInputFocused = false
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
                    vm.requestTerminalFocusHook?()
                }
            } else {
                // 비-ASCII (한글 등) — SwiftTerm resign, inputBar focus.
                vm.resignTerminalFocusHook?()
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
                    isInputFocused = true
                }
            }
        }
        // 서버에서 최신 세션 메타를 받았으면 그걸 우선 보여주고, 아직 못 받은 초기에는 init 값으로 fallback.
        .navigationTitle(vm.currentSession?.title ?? session.title ?? String(localized: "세션"))
        .navigationBarTitleDisplayMode(.inline)
        // 크롬 숨김 토글이 ON 이면 상단 헤더(네비게이션 바)도 같이 숨긴다 — FAB 로 되돌림.
        .toolbar(hideChrome ? .hidden : .visible, for: .navigationBar)
        .toolbar {
            // worktree 등에서 모달로 띄운 ChatView 는 시스템 back 이 없으므로 좌상단 «닫기» 를 단다.
            if let onClose {
                ToolbarItem(placement: .topBarLeading) {
                    Button("닫기") { onClose() }
                }
            }
            // 이전엔 우상단에 «Tor 회로 재빌드» (arrow.clockwise) 버튼이 있었는데
            // 폴링이 알아서 회복하므로 사용자가 누를 일이 없다 — 제거.
            // 라이브 프리뷰 — 폰에서 Mac dev 서버를 본다. 별도 프로 기능(.preview)으로 게이트.
            // 입력바 위 도구줄이 비좁아 상단으로 올렸다. 프로/고급이라 주황(Theme.pro). (세션 알림
            // 음소거 토글은 아래 ⋯ 더보기 메뉴로 이동.)
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    purchase.gate(.preview, $paywallFeature) { showLivePreview = true }
                } label: {
                    Image(systemName: "safari")
                        .foregroundStyle(Theme.pro)
                }
                .accessibilityLabel(Text("라이브 프리뷰"))
            }
            // 모니터 미러링 — Mac 데스크톱 라이브 보기/제어. 프로/고급 기능이라 주황(Theme.pro)
            // — «주황=프로» 약속색. 아이콘은 세션 목록의 미러링 버튼과 «display» 로 통일(일관성).
            // daemon 이 화면 캡처(screen_capture_v1)를 지원할 때만 노출.
            if vm.supportsScreenCapture {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        gatePro { showPreview = true }
                    } label: {
                        Image(systemName: "display")
                            .foregroundStyle(Theme.pro)
                    }
                    .accessibilityLabel(Text("모니터 미러링"))
                }
            }
            // (대화에서 찾기 돋보기 버튼은 상단이 비좁아 아래 ⋯ 더보기 메뉴로 이동.)
            // 세션 단위 액션 모음 — 찾기 / 알림 음소거 / 글자·버튼 크기 / 터미널 강제 재시작.
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    // 메뉴는 항목의 «속성» 기준 Section 3개로 나눈다: 정보(읽기 전용 진단) /
                    // 제어(크기 스테퍼) / 액션(이름 변경·재시작). Section 경계가 separator 를
                    // 그려주므로 명시적 Divider 가 필요 없고, 조건부 row 로 Section 이 비면
                    // separator 도 같이 사라져 빈 구분선이 안 남는다.

                    // ── 정보 — 토큰 잔량. 누를 일이 없어 전부 disabled. (연결 상태(IPv6/속도)는
                    // 세션 무관 진단이라 설정 화면으로 이동.)
                    Section {
                        // 토큰 잔량 — 세션 agent 의 구독 rate limit 윈도우 (5시간/주간) 사용률
                        // + 리셋 시각. shell(터미널) 은 토큰을 안 쓰므로 클라이언트가 즉시 숨기고,
                        // agy 처럼 조회 미지원인 agent 는 daemon supported:false 응답 후 사라진다.
                        if showAgentUsage {
                            Group {
                                if let usage = vm.agentUsage {
                                    if usage.supported {
                                        if usage.windows.isEmpty {
                                            Button {} label: {
                                                Label("잔량 조회 불가", systemImage: "gauge")
                                            }
                                            .disabled(true)
                                        } else {
                                            // 제목(윈도우 라벨) + 부제(잔량·리셋) 2단 구성.
                                            // Menu row 안에서는 .font() 가 무시되므로, 시스템이
                                            // 작은 보조 폰트로 그려주는 subtitle 자리(둘째 Text)
                                            // 에 긴 정보를 넣어 본문 크기 두 줄 wrap 을 피한다.
                                            ForEach(usage.windows, id: \.id) { w in
                                                Button {} label: {
                                                    Text(usageWindowLabel(w))
                                                    Text(usageRowSubtitle(w))
                                                    Image(systemName: "gauge")
                                                }
                                                .disabled(true)
                                            }
                                        }
                                    }
                                    // supported == false → 아무 row 도 그리지 않음 (요구사항: 불필요 UI 숨김)
                                } else {
                                    Button {} label: {
                                        Label("잔량 조회 중…", systemImage: "gauge")
                                    }
                                    .disabled(true)
                                }
                            }
                            // 메뉴가 열릴 때 재조회 — daemon 이 60s 캐시하므로 부담 없다. 메뉴가
                            // 열린 채 응답이 도착하면 SwiftUI 가 row 를 갱신한다.
                            .onAppear { vm.loadAgentUsage() }
                        }
                    }

                    // ── 제어 — 글자 크기 / 툴바 버튼 크기.
                    // "내가 보낸 메시지" 항목은 입력바 위 기능 버튼과 중복돼 제거 (2026-05).
                    // 각각 ControlGroup 으로 묶어 가로 한 줄로 노출: [현재값] [작게] [크게].
                    // .menuActionDismissBehavior(.disabled) 로 메뉴를 닫지 않고 스테퍼처럼
                    // 연속 조작. 현재값 칸은 disabled 라벨 (verbatim, 비-번역).
                    Section {
                        ControlGroup {
                            Button {} label: {
                                Text(verbatim: "\(Int(ptyFontSize))pt")
                            }
                            .disabled(true)
                            Button {
                                adjustPtyFontSize(by: -1)
                            } label: {
                                Label("글자 작게", systemImage: "textformat.size.smaller")
                            }
                            .disabled(ptyFontSize <= ChatView.ptyFontSizeMin)
                            .menuActionDismissBehavior(.disabled)
                            Button {
                                adjustPtyFontSize(by: +1)
                            } label: {
                                Label("글자 크게", systemImage: "textformat.size.larger")
                            }
                            .disabled(ptyFontSize >= ChatView.ptyFontSizeMax)
                            .menuActionDismissBehavior(.disabled)
                        }

                        ControlGroup {
                            Button {} label: {
                                Text(verbatim: "\(Int(toolbarButtonHeight))pt")
                            }
                            .disabled(true)
                            Button {
                                adjustToolbarButtonHeight(by: -2)
                            } label: {
                                Label("버튼 작게", systemImage: "minus")
                            }
                            .disabled(toolbarButtonHeight <= ChatView.toolbarButtonHeightMin)
                            .menuActionDismissBehavior(.disabled)
                            Button {
                                adjustToolbarButtonHeight(by: +2)
                            } label: {
                                Label("버튼 크게", systemImage: "plus")
                            }
                            .disabled(toolbarButtonHeight >= ChatView.toolbarButtonHeightMax)
                            .menuActionDismissBehavior(.disabled)
                        }
                    }

                    // ── 터미널 폭 — 와이드(고정 폭) / 수동(컬럼 직접 지정).
                    // 둘 다 고정 폭 + 가로 스크롤로 ps·테이블·diff·박스아트 같은 와이드 정렬 출력을
                    // 정렬 안 깨지게 훑는다. 와이드는 폰트 비례 고정 폭(≈135 cols), 수동은 사용자가
                    // 컬럼 수를 직접 정한다. 모드·컬럼 수 모두 에이전트별로 기억된다. (화면 폭 자동
                    // 맞춤은 측정 cell 폭 오차로 정렬이 틀어져 제거됨, 2026-06.)
                    // inline Picker 라 현재 선택에 accent(보라) 체크가 자동으로 붙는다 — 별도
                    // tint 불필요(앱의 «기본 컨트롤=accent» 약속). header/footer 로 라벨·도움말.
                    Section {
                        Picker(selection: $ptyWidthModeRaw) {
                            Label("와이드 (가로 스크롤)", systemImage: "arrow.left.and.right")
                                .tag(PtyWidthMode.wide.rawValue)
                            Label("수동 (컬럼 직접 지정)", systemImage: "slider.horizontal.3")
                                .tag(PtyWidthMode.manual.rawValue)
                        } label: {
                            Label("터미널 폭", systemImage: "arrow.left.and.right.square")
                        }
                        .pickerStyle(.inline)

                        // 수동 모드일 때만 컬럼 수 스테퍼를 노출 — [현재값 cols] [좁게] [넓게].
                        // 글자/버튼 크기 스테퍼와 같은 ControlGroup 패턴(메뉴 안 닫고 연속 조작).
                        if ptyManualWidth {
                            ControlGroup {
                                Button {} label: {
                                    Text(verbatim: "\(ptyManualCols)\u{00A0}cols")
                                }
                                .disabled(true)
                                Button {
                                    adjustPtyCols(by: -ChatView.ptyManualColsStep)
                                } label: {
                                    Label("컬럼 줄이기", systemImage: "minus")
                                }
                                .disabled(ptyManualCols <= ChatView.ptyManualColsMin)
                                .menuActionDismissBehavior(.disabled)
                                Button {
                                    adjustPtyCols(by: +ChatView.ptyManualColsStep)
                                } label: {
                                    Label("컬럼 늘리기", systemImage: "plus")
                                }
                                .disabled(ptyManualCols >= ChatView.ptyManualColsMax)
                                .menuActionDismissBehavior(.disabled)
                            }
                        }
                    } header: {
                        Text("터미널 폭")
                    } footer: {
                        // ternary 안에 string literal 둘을 넣으면 String init 으로 빠져 localize 가
                        // 안 닿는다(CLAUDE.md). Text 둘로 분리해 각각 LocalizedStringKey 경로를 탄다.
                        if ptyManualWidth {
                            Text("컬럼 수를 직접 정합니다. 화면보다 넓으면 가로로 스크롤해서 봅니다.")
                        } else {
                            Text("고정 와이드로 둡니다. 화면보다 넓으면 가로로 스크롤해서 봅니다.")
                        }
                    }

                    // ── 액션 — 세션을 바꾸는 동작들. (이름 변경은 세션 목록에서 하므로 여기선 제외.)
                    Section {
                        // 대화에서 찾기 — 현재 세션 transcript 안에서 텍스트 검색. 긴 에이전트 출력
                        // (빌드 로그·diff·파일 내용)에서 파일 경로/에러를 폰으로 바로 찾는다. 상단
                        // 돋보기 버튼에서 여기로 이동(상단 정리). 탭하면 메뉴가 닫히고 찾기 바가 뜬다.
                        Button {
                            toggleFind()
                        } label: {
                            Label("대화에서 찾기", systemImage: "magnifyingglass")
                        }

                        // 세션 단위 알림(Discord) 음소거 토글 — 여러 세션을 동시에 굴릴 때 시끄러운
                        // 세션만 골라 끈다. 프로 기능(앱의 «주황=프로» 약속색이지만 Menu row 는 커스텀
                        // 색을 못 입혀 라벨 텍스트로만 구분). 상단 단독 벨 버튼에서 여기로 이동.
                        Button {
                            gatePro { toggleNotifyMuted() }
                        } label: {
                            Label(
                                notifyToggleTitle,
                                systemImage: notifyMuted ? "bell.slash.fill" : "bell.fill",
                            )
                        }
                        .disabled(isTogglingNotify)

                        // 「다음 정지 시 알림」 — 12초 idle 휴리스틱이 놓치는 «조용히 멈춘» 세션을
                        // 사람이 메우는 1회성 안전장치. 켜면 그 세션의 다음 정지를 더 민감하게
                        // 잡아 꼭 알림한다. 활성 세션에서만 의미 있어 종료/dead 면 비활성.
                        if sessionIsActive {
                            Button {
                                toggleNotifyNextStop()
                            } label: {
                                Label(
                                    nextStopToggleTitle,
                                    systemImage: vm.notifyNextStopArmed
                                        ? "bell.badge.slash" : "bell.badge",
                                )
                            }
                            .disabled(isTogglingNextStop)
                        }

                        Button(role: .destructive) {
                            showRestartConfirm = true
                        } label: {
                            Label("터미널 강제 재시작", systemImage: "arrow.clockwise.circle")
                        }
                        .disabled(isRestarting)

                        // 세션 삭제 — 세션 목록의 스와이프 삭제와 같은 동작을 채팅방 안에서도 제공.
                        // 누르면 확인 후 세션을 영구 삭제하고 채팅방을 나가 목록에서도 사라진다.
                        Button(role: .destructive) {
                            showDeleteConfirm = true
                        } label: {
                            Label("세션 삭제", systemImage: "trash")
                        }
                        .disabled(isDeleting)
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .accessibilityLabel("세션 메뉴")
            }
            // 키보드 닫기 버튼은 키보드 위 툴바가 아니라 statusBar 우측(가상 키패드 토글 옆)에 둔다.
        }
        .confirmationDialog(
            "터미널을 강제로 재시작할까요?",
            isPresented: $showRestartConfirm,
            titleVisibility: .visible,
        ) {
            Button("강제 재시작", role: .destructive) {
                Task {
                    isRestarting = true
                    await vm.restartPty()
                    isRestarting = false
                }
            }
            Button("취소", role: .cancel) {}
        } message: {
            Text("현재 REPL 프로세스를 즉시 종료하고 새 터미널을 띄웁니다. 지금까지의 대화 기록과 터미널 화면도 함께 초기화되며 되돌릴 수 없어요.")
        }
        .confirmationDialog(
            "이 세션을 삭제할까요?",
            isPresented: $showDeleteConfirm,
            titleVisibility: .visible,
        ) {
            Button("세션 삭제", role: .destructive) {
                Task { await deleteSession() }
            }
            Button("취소", role: .cancel) {}
        } message: {
            Text("이 세션과 대화 기록이 영구히 삭제되고 세션 목록에서도 사라집니다. 되돌릴 수 없어요.")
        }
        // 커밋되지 않은 변경점 보기 시트 — 상태바의 «변경 N» 칩이 토글.
        // ChatVM 폴링이 status 를 자동 갱신하므로 시트는 가벼운 viewer 역할만 한다.
        // 의존성은 클로저로 끊어 DiffSheet 자체는 ChatViewModel 을 모르게 둔다.
        .sheet(isPresented: $showDiffSheet) {
            DiffSheet(
                files: vm.gitStatus?.files ?? [],
                loadDiff: { path in await vm.loadFileDiff(path: path) },
                loadFile: { path in await vm.loadFile(path: path) },
                loadGitBlob: { path, ref in await vm.loadGitBlob(path: path, ref: ref) },
                onRefresh: { await vm.refreshGitStatus() },
                onRequestReview: { requestDiffReview() },
            )
        }
        // 프롬프트 보관함 — 스니펫/최근 프롬프트를 골라 ① 입력창에 채우거나(다듬어 보낼 수 있게)
        // ② 바로 전송. 채우기는 작성 중이던 내용을 덮지 않고 뒤에 잇는다. currentDraft 로 지금
        // 입력 중인 초안을 넘겨, 시트에서 곧장 스니펫으로 저장할 수 있게 한다.
        .sheet(isPresented: $showPromptLibrary) {
            PromptLibrarySheet(
                currentDraft: input,
                onPick: { picked in
                    input = input.isEmpty ? picked : input + " " + picked
                    isInputFocused = true
                },
                onSend: { picked in
                    deliver(picked, restoreOnFailure: false)
                },
            )
        }
        // 라이브 프리뷰 — 폰에서 Mac dev 서버(localhost:3000 류)를 WKWebView 로 렌더.
        .sheet(isPresented: $showLivePreview) {
            PreviewView(
                sessionId: session.id,
                api: ApiClient(auth: auth, conn: conn, tracker: inflight),
                conn: conn,
                // daemon 프록시가 다중 포트/절대 URL 리라이트(preview_v2)를 지원하면 «보조 포트» UI 노출.
                supportsMultiPort: vm.supportsMultiPortPreview,
                // 화면 피드백 — 캡처+마크업+코멘트를 «전송 대기 파일 참조»로 올려 다음 메시지에 첨부.
                onFeedback: { draft in fileRefs.append(draft) },
                // 외부 공유 카피 — 최신 세션 메타(제목)를 우선 반영. 프리뷰 스크린샷과 함께 내보낸다.
                shareCopy: sessionShareCopy(for: vm.currentSession ?? session),
            )
        }
        // 프로 전용 기능(도구 칩·음소거 등)을 미보유 사용자가 눌렀을 때의 업셀 페이월.
        .proPaywall(item: $paywallFeature)
        // 브랜치/worktree 시트 — 상태바 브랜치 칩이 토글. DiffSheet 와 같은 클로저 주입 패턴
        // 으로 BranchSheet 는 ChatViewModel 을 직접 모른다.
        // onDismiss: worktree «세션 열기» 로 만든 세션이 있으면 시트가 완전히 닫힌 뒤
        //   fullScreenCover 로 띄운다 (시트↔커버 modal transition 충돌 회피).
        .sheet(isPresented: $showBranchSheet, onDismiss: {
            if let s = worktreeSessionToOpen {
                worktreeSessionToOpen = nil
                pendingNewSession = s
            }
        }) {
            BranchSheet(
                currentBranch: vm.branchName,
                loadBranches: { await vm.loadBranches() },
                loadWorktrees: { await vm.loadWorktrees() },
                checkout: { name, track in try await vm.checkoutBranch(name: name, track: track) },
                createBranch: { name, from, co in
                    try await vm.createBranch(name: name, from: from, checkout: co)
                },
                deleteBranch: { name, force in try await vm.deleteBranch(name: name, force: force) },
                addWorktree: { branch, isNew in
                    try await vm.addWorktree(branch: branch, newBranch: isNew)
                },
                removeWorktree: { path, force in try await vm.removeWorktree(path: path, force: force) },
                loadMergeQueue: { await vm.loadMergeQueue() },
                enqueueMerge: { source, target in try await vm.enqueueMerge(source: source, target: target) },
                loadMergePreview: { source, target in await vm.previewMerge(source: source, target: target) },
                retryMerge: { id in try await vm.retryMerge(id: id) },
                cancelMerge: { id in try await vm.cancelMerge(id: id) },
                makeSession: { path, title in try await vm.makeSessionInWorktree(path: path, title: title) },
                onOpenSession: { newSession in
                    worktreeSessionToOpen = newSession
                    showBranchSheet = false
                },
                loadCommits: { ref, limit, skip in
                    await vm.loadCommits(ref: ref, limit: limit, skip: skip)
                },
                loadCheckpoints: { limit, skip in
                    await vm.loadCheckpoints(limit: limit, skip: skip)
                },
                loadCommitDetail: { sha in await vm.loadCommitDetail(sha: sha) },
                loadCommitDiff: { sha, path in await vm.loadCommitDiff(sha: sha, path: path) },
                rollback: { sha, mode in try await vm.rollback(sha: sha, mode: mode) },
                isAgentBusy: vm.isAgentBusy,
                createCheckpoint: { _ = try await vm.createCheckpoint() },
            )
        }
        // 음성 입력(STT) 권한 거부·모델 다운로드/인식 실패 안내.
        .alert(
            "음성 입력",
            isPresented: Binding(get: { speech.lastError != nil }, set: { if !$0 { speech.lastError = nil } }),
        ) {
            Button("확인", role: .cancel) { speech.lastError = nil }
        } message: {
            Text(verbatim: speech.lastError ?? "")
        }
        // 음성 모델이 준비되면 «사용 가능» 토스트를 잠깐 띄웠다 자동으로 거둔다.
        .onChange(of: speech.modelState) { newState in
            guard newState == .ready else { return }
            withAnimation { showSpeechReadyToast = true }
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
                withAnimation { showSpeechReadyToast = false }
            }
        }
        // worktree 에서 연 새 세션 — 원래 채팅 위에 모달로 띄운다. 닫으면 원래 세션 복귀.
        // 새 ChatView 는 onClose 로 자기 자신을 닫는다 (좌상단 «닫기»).
        .fullScreenCover(item: $pendingNewSession) { newSession in
            NavigationStack {
                ChatView(
                    session: newSession,
                    auth: auth,
                    conn: conn,
                    inflight: inflight,
                    onClose: { pendingNewSession = nil },
                )
                .environmentObject(auth)
                .environmentObject(tor)
                .environmentObject(conn)
                .environmentObject(lifecycle)
            }
        }
        // 파일 브라우저 — statusBar 폴더 아이콘이 토글. 시작 path = repo root.
        // 화면 제목으로는 repo_path 의 마지막 segment 를 보여줘서 사용자가 어디 안인지 식별.
        .sheet(isPresented: $showFileBrowser) {
            FileBrowserSheet(
                rootTitle: repoRootTitle,
                loadDirectory: { path in await vm.loadDirectory(path: path) },
                loadFile: { path in await vm.loadFile(path: path) },
                loadGitBlob: { path, ref in await vm.loadGitBlob(path: path, ref: ref) },
                fileRefs: $fileRefs,
            )
        }
        // 파일 참조 첨언 편집/전송 시트 — statusBar 의 참조 카운트 칩이 토글.
        .sheet(isPresented: $showFileRefSheet) {
            FileReferenceSheet(
                refs: $fileRefs,
                isSending: isSendingFileRefs,
                onSend: { sendFileReferences() },
            )
        }
        // 모니터 미러링 — Mac 데스크톱 라이브 보기. 바텀시트가 아니라 풀스크린(화면을 더 넓게).
        // 닫기는 좌상단 버튼. 미러링 안에서 캡처/녹화한 화면(버그 재현)은 첨부로 누적되고,
        // 커버가 닫히면 첨부 시트가 열려 이미지별 요구사항을 달아 바로 전송할 수 있다.
        .fullScreenCover(isPresented: $showPreview, onDismiss: {
            if pendingMirrorCaptures {
                pendingMirrorCaptures = false
                showAttachmentSheet = true
            }
        }) {
            MonitorMirrorView(
                sessionId: session.id,
                api: ApiClient(auth: auth, conn: conn, tracker: inflight),
                conn: conn,
                canControl: vm.supportsRemoteControl,
                supportsH264: vm.supportsScreenH264,
                supportsWindowTarget: vm.supportsWindowTarget,
                onCaptured: vm.supportsScreenShot ? { drafts in
                    attachments.append(contentsOf: drafts)
                    pendingMirrorCaptures = true
                    mirrorCaptureMode = true
                } : nil,
                // 화면 피드백(단발 캡처 위 마크업) — 웹 프리뷰와 같은 fileRefs 플럼빙. 완성되면
                // 미러 커버를 닫아 채팅으로 복귀하면 대기 «화면 피드백» 칩이 보인다.
                onFeedback: vm.supportsScreenShot ? { draft in
                    fileRefs.append(draft)
                    showPreview = false
                } : nil,
            )
        }
        // 이미지 첨부: 사진첩(다중, 이미지) → pickerItems → 다운스케일 draft 누적.
        .photosPicker(
            isPresented: $showPhotoPicker,
            selection: $pickerItems,
            maxSelectionCount: 10,
            matching: .images,
        )
        .onChange(of: pickerItems) { items in
            guard !items.isEmpty else { return }
            Task { await loadPickedImages(items) }
        }
        // 첨부 카운트 버튼 탭 → 이미지별 요구사항 입력 + 저장 경로 + 전송 시트.
        // 미러링 캡처/녹화로 모인 첨부는 «전체 요청» 입력란을 추가로 노출 — 단계 이미지들은
        // 참고 자료일 뿐이라, 이 자료로 무엇을 시킬지(버그 수정 등)를 적는 자리가 필요하다.
        .sheet(isPresented: $showAttachmentSheet) {
            AttachmentSheet(
                attachments: $attachments,
                dir: $attachmentDir,
                isUploading: isUploadingAttachments,
                showOverallInstruction: mirrorCaptureMode,
                overallInstruction: $attachmentOverallInstruction,
                onSend: { sendAttachments() },
            )
        }
        // 폴링·git status·WebSocket 의 가동/정리는 .task(id:) 로 뷰 수명에 «구조적으로» 묶는다.
        // 이전엔 onAppear→start() / onDisappear→stop() 였는데, SwiftUI 가 빠른 push/pop 에서
        // onDisappear 를 누락/경합시키면 stop() 이 안 불려 VM+WS+폴링 루프가 좀비로 누적 →
        // 채팅방 진입/이탈을 반복하면 크래시했다. .task 는 뷰가 사라질 때 반드시 cancel 되므로
        // runUntilCancelled 의 stop() 이 보장된다 (정리 누락 원천 차단).
        .task(id: session.id) {
            await vm.runUntilCancelled()
        }
        // 휠 스크롤 버튼 노출 판정 — 이 세션 에이전트의 capability 를 daemon 에서 1회 읽는다.
        // (wheel_scroll_v1 = 본문을 마우스 휠로만 굴리는 alt-screen TUI. 하드코딩 isCopilot 대신
        //  capability 게이트라, 같은 류의 새 에이전트가 들어와도 iOS 수정 없이 버튼이 붙는다.)
        // 별도 .task 로 분리 — 채팅 수명에 묶여 세션 전환 시 재조회되고 떠날 때 취소된다.
        .task(id: session.id) {
            await loadAgentCapabilities()
        }
        .onAppear {
            // 작성 중이던 문장 복원 — 세션을 나갔다 돌아와 view 가 재생성돼 @State input 이
            // 리셋돼도 이어서 쓸 수 있게. 이미 입력 중인 텍스트가 있으면 (fullScreenCover
            // 닫힘 등으로 onAppear 가 재발화한 경우) 덮어쓰지 않는다.
            if input.isEmpty {
                input = ChatDraftStore.load(session.id)
            }
            // 토큰 잔량 선조회 — 더보기 메뉴를 처음 열 때 «조회 중…» 대신 바로 값이 보이게.
            // Menu content 의 onAppear 가 iOS 버전에 따라 안 올 수 있어 여기가 1차 트리거.
            if showAgentUsage {
                vm.loadAgentUsage()
            }
            // 음성 모델 선로드 — «이미 받아둔» 경우에만 미리 로드해 마이크를 누르면 바로 녹음되게
            // 한다(다운로드는 안 함). 뷰 수명에 묶지 않으려 분리된 Task — 잠깐 화면을 벗어나도 로드는
            // 끝까지 진행된다. 싱글턴이라 한 번 .ready 면 이후 진입에선 즉시 no-op.
            Task { await speech.preloadIfDownloaded() }
            // 이 세션을 «보는 중» 으로 표시 — 대기 알림 away-gating + 이미 떠 있던 이 세션 알림 정리.
            AgentWaitNotifier.shared.setActiveSession(session.id)
        }
        .onDisappear {
            // 빠른 정리 (idempotent) — 보장 경로는 위 .task 취소다. onDisappear 가 정상적으로
            // 오면 여기서 즉시 끊고, 누락돼도 .task 취소가 반드시 정리한다.
            vm.stop()
            // 더는 이 세션을 보지 않음 — 이후 대기 진입은 다시 알림 대상이 된다.
            AgentWaitNotifier.shared.setActiveSession(nil)
        }
        // 작성 중 문장을 세션별로 영속화 — 변경마다 즉시 저장 (UserDefaults 는 메모리 캐시
        // + 비동기 flush 라 keystroke 단위 쓰기도 부담 없고, 앱이 갑자기 종료돼도 유실 없음).
        // 전송 시 sendTapped 가 input 을 "" 로 비우면 이 핸들러가 키를 제거해
        // «보내는 순간 비움» 이 별도 코드 없이 성립한다.
        .onChange(of: input) { newValue in
            ChatDraftStore.save(session.id, draft: newValue)
        }
        // 검색어 입력 — 250ms 디바운스 후 매치 수 재계산 + 첫 매치로 점프. 빈 검색어면 하이라이트 해제.
        .onChange(of: findQuery) { _ in
            findRecountTask?.cancel()
            findRecountTask = Task { @MainActor in
                try? await Task.sleep(nanoseconds: 250_000_000)
                guard !Task.isCancelled else { return }
                refreshSearch()
            }
        }
        // 검색 중 새 출력 스트리밍 도착 → 매치 수가 어긋나지 않게 재계산(인덱스는 클램프). VM 이
        // 검색 중일 때만 0.4s 스로틀로 버전을 올리므로, 평상시엔 이 onChange 가 발화하지 않는다.
        .onChange(of: vm.terminalContentVersion) { _ in
            guard showFind, !findQuery.isEmpty else { return }
            let c = vm.countMatchesHook?(findQuery) ?? 0
            findCount = c
            if c == 0 {
                findIndex = 0
            } else if findIndex >= c {
                findIndex = c - 1
            }
        }
        // 백그라운드 60s+ 후 foreground 복귀 — 폴링/ WS 즉시 강제 회복.
        // ChatView 자체는 그대로라 입력 텍스트/스크롤 위치/NavigationStack 깊이 보존.
        .onChange(of: lifecycle.reawakeToken) { _ in
            vm.reawake()
        }
        // 앱 foreground/background 전환을 daemon 에 전달 — background 면 away-gating 이
        // 다시 켜져 Discord 알림이 나간다 (소켓은 살아 있어도 화면을 안 보는 상태).
        .onChange(of: lifecycle.isActive) { active in
            vm.setForeground(active)
        }
        // 키보드가 열렸는지를 추적해서, 닫기 버튼 표시 여부를 결정한다.
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in
            isKeyboardVisible = true
            // 키보드가 «어떤 언어로» 떴는지 재검사. currentInputModeDidChangeNotification 은
            // 사용자가 globe 키로 언어를 «전환» 할 때만 fire 하므로, 키보드가 처음부터 비영문
            // (한글/CJK) 으로 열린 경우엔 mode 변경 이벤트가 없어 isAsciiKeyboard 가 stale(true)
            // 로 남았고, 그 결과 `!isAsciiKeyboard` 가드에 막혀 inputBar 가 숨겨진 채였다 (버그).
            // 노출 직후 실제 first responder 의 textInputMode 로 동기화 → 한글이면 onChange 가
            // inputBar 로 swap. main hop 으로 한 박자 미뤄 FR 의 textInputMode 가 확정된 뒤 읽는다.
            DispatchQueue.main.async {
                updateKeyboardLanguage()
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in
            isKeyboardVisible = false
        }
    }

    // firstUseHint («명령어를 입력해 보세요...») 옛 안내문은 PTY 모드 진짜 터미널 UX
    // 로 전환 후 의미가 없어져 제거됨 (2026-05).

    /// 입력바 바로 위에 붙는 toolbar — 좌측 컨테이너 + Spacer + 우측 컨테이너 (flex-between).
    /// 좌측: 레포 컨텍스트 (브랜치 / 파일 / diff). 우측: 키보드 관련 버튼 모두 한 그룹.
    ///
    ///   ┌── 좌측 그룹 ──┐                              ┌──────── 우측 그룹 (키보드) ────────┐
    ///   │ [브랜치]      │                              │ [이전 메시지] [↑] [⌨ 토글]          │
    ///   │ [폴더][diff]  │                              │ [Space][←][↓][→][Enter]            │
    ///   └──────────────┘                              └────────────────────────────────────┘
    ///
    /// SDK 모드 세션은 우측 그룹의 PTY 키 슬롯이 사라지고 [이전 메시지][⌨] 만 남는다.
    /// «에이전트가 입력을 기다리는 중» 얇은 배너 — 입력바 바로 위. warning(노랑) =
    /// «사용자 액션 필요» 약속색 (세션 목록의 WaitingBadge 와 같은 신호 계열).
    /// 출처 브리프 칩 — 이 세션을 낳은 브리프가 있을 때만 nav 바 아래 고정 줄로 노출. 제목+종류
    /// (구현/정리/재종합/수집)를 보여주고, 탭하면 `backlog/<id>` 딥링크로 브리프 상세에 1탭 도달한다.
    /// 색 정책: 기본 컨트롤이라 별도 색을 칠하지 않고 AccentColor(보라)만 쓴다 — status 색(노랑/주황)을
    /// 장식으로 빌려쓰지 않는다. 텍스트는 Color.primary/.secondary 로 다크·라이트 자동 적응.
    /// 상태: 출처 없음/로딩(미수신)=미표시(도착 시 표시). 삭제된 브리프는 탭이 no-op(목록에 없으면 push 안 됨).
    @ViewBuilder
    private var sourceBriefChip: some View {
        // 서버에서 갱신된 세션 메타(vm.currentSession)를 우선 — 로딩 중엔 nil 이라 미표시, 도착하면 표시.
        if let sb = (vm.currentSession?.source_brief ?? session.source_brief) {
            Button {
                // 백로그 탭 전환 + 브리프 상세 push 를 기존 딥링크 소비 경로에 위임.
                deepLink.pendingBacklogBriefId = sb.id
                deepLink.pendingBacklog = true
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "list.clipboard")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(Theme.accent)
                    Text(sb.briefKind.label)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Theme.accent)
                        .fixedSize()
                    if let title = sb.title?.trimmingCharacters(in: .whitespacesAndNewlines),
                       !title.isEmpty {
                        Text(verbatim: "·")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        // 제목은 에이전트/사용자 입력이라 번역 대상 아님 → verbatim. 길면 tail 로 자르고,
                        // 전문은 탭해서 브리프 상세로 본다 (잘리는 nav 타이틀 의존을 대체).
                        Text(verbatim: title)
                            .font(.caption)
                            .foregroundStyle(.primary)
                            .lineLimit(1)
                            .truncationMode(.tail)
                    }
                    Spacer(minLength: 4)
                    Image(systemName: "chevron.right")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.secondary)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Theme.accent.opacity(Theme.Opacity.fill))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityElement(children: .combine)
            .accessibilityLabel(Text("출처 브리프 상세 열기"))
            .accessibilityHint(Text(sourceBriefAccessibilityValue(sb)))
        }
    }

    /// 출처 칩의 보조 음성 안내 — 종류+제목을 한 문장으로 읽어 준다 (제목은 verbatim 보간).
    private func sourceBriefAccessibilityValue(_ sb: SourceBriefRef) -> String {
        let title = sb.title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if title.isEmpty {
            return String(localized: "출처 브리프") + " · " + sb.briefKind.label
        }
        return String(localized: "출처 브리프") + " · " + sb.briefKind.label + " · " + title
    }

    /// PTY 입력 전송 실패/연결 끊김 표면화 배너 — fire-and-forget 키 입력(터미널/REPL 타이핑)이
    /// WS 끊김으로 silent drop 됐을 때 «입력이 안 갔음» 을 즉시 알리고 재시도를 유도한다.
    /// 색은 의미 토큰: 끊김/실패=danger(빨강), 재연결/복구 안내=secondary(중립). warning(노랑)·
    /// pro(주황) 을 끌어다 쓰지 않는다. 빠른 끊김↔복구에서 깜빡이지 않게 ChatVM 이 최소 표시시간
    /// 히스테리시스로 상태를 눌러 준다.
    @ViewBuilder
    private var inputDeliveryBanner: some View {
        switch vm.ptyInputDelivery {
        case .ok:
            EmptyView()
        case .failed:
            HStack(spacing: 6) {
                Image(systemName: "wifi.slash")
                    .font(.caption2.weight(.semibold))
                VStack(alignment: .leading, spacing: 1) {
                    Text("연결이 끊겨 입력이 전송되지 않았어요")
                        .font(.caption)
                    Text("다시 연결되면 한 번 더 입력해 주세요")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
            }
            .foregroundStyle(Theme.danger)
            .padding(.horizontal, 12)
            .padding(.vertical, 5)
            .background(Theme.danger.opacity(Theme.Opacity.fill))
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text("연결이 끊겨 입력이 전송되지 않았어요. 다시 연결되면 한 번 더 입력해 주세요."))
            .transition(.opacity)
        case .reconnecting:
            HStack(spacing: 6) {
                Image(systemName: "arrow.triangle.2.circlepath")
                    .font(.caption2.weight(.semibold))
                Text("다시 연결됐어요 — 입력을 다시 시도해 주세요")
                    .font(.caption)
                Spacer(minLength: 0)
            }
            .foregroundStyle(.secondary)
            .padding(.horizontal, 12)
            .padding(.vertical, 5)
            .background(Color.secondary.opacity(0.10))
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text("다시 연결됐어요. 입력을 다시 시도해 주세요."))
            .transition(.opacity)
        }
    }

    /// 재연결 «비복구» 안내 — 자동 재연결 루프가 멈춘 상태(페어링 만료/인증 폐기 등).
    /// 색은 의미 토큰: 「설정 필요」 = warning(노랑). 일시적 끊김(danger)·복구중(secondary)과
    /// 구분된다. 사용자가 재페어링/업데이트로 해소해야 하는 «진짜 주의» 상태.
    @ViewBuilder
    private var connectionNonRecoverableBanner: some View {
        if let message = vm.connectionNonRecoverable {
            HStack(spacing: 6) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.caption2.weight(.semibold))
                Text(message)
                    .font(.caption)
                Spacer(minLength: 0)
            }
            .foregroundStyle(Theme.warning)
            .padding(.horizontal, 12)
            .padding(.vertical, 5)
            .background(Theme.warning.opacity(Theme.Opacity.fill))
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text(message))
            .transition(.opacity)
        }
    }

    private var agentWaitingBanner: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Image(systemName: "hourglass")
                    .font(.caption2.weight(.semibold))
                Text("에이전트가 입력을 기다리고 있어요")
                    .font(.caption)
                Spacer(minLength: 0)
            }
            // 「왜 대기로 떴는지」 근거 — 몇 초/분 조용한지 + 응답 대기 알림이 몇 번 나갔는지.
            // 헛알림을 받았을 때 사용자가 무시할지 판단하는 신호 (12초 idle 추정의 투명화).
            attentionReasonRow
                .font(.caption2)
                .opacity(0.85)
        }
        .foregroundStyle(Theme.warning)
        .padding(.horizontal, 12)
        .padding(.vertical, 5)
        .background(Theme.warning.opacity(0.12))
    }

    /// 대기 근거 한 줄 — 「조용함 N분 · 알림 X회 보냄」. 활성 PTY 신호(quietSeconds)가 없으면 빈 줄.
    @ViewBuilder
    private var attentionReasonRow: some View {
        let s = vm.currentSession ?? session
        if let secs = s.quietSeconds {
            HStack(spacing: 4) {
                quietText(secs)
                if let idx = s.waiting_reminder_idx, idx > 0 {
                    Text(verbatim: "·")
                    Text("알림 \(idx)회 보냄")
                }
                Spacer(minLength: 0)
            }
        }
    }

    /// 「조용함」 힌트 배너 — 대기로 «안» 잡힌 활성 세션이 임계 이상 조용할 때만. 경고가 아니라
    /// 정보라 warning(노랑)이 아닌 중립 회색으로 둔다 (색 정책: 노랑은 진짜 주의 전용).
    @ViewBuilder
    private var quietHintBanner: some View {
        let s = vm.currentSession ?? session
        if sessionIsActive, let secs = s.quietSeconds, secs >= Self.quietSurfaceThresholdSec {
            HStack(spacing: 6) {
                Image(systemName: "moon.zzz")
                    .font(.caption2.weight(.semibold))
                quietText(secs)
                    .font(.caption)
                Spacer(minLength: 0)
            }
            .foregroundStyle(.secondary)
            .padding(.horizontal, 12)
            .padding(.vertical, 5)
            .background(Color.secondary.opacity(0.08))
        }
    }

    /// idle 경과(초) → 사람이 읽을 「조용함 N초 / N분」. 60초 미만은 초, 그 이상은 분 단위.
    /// 각 분기가 별도 카탈로그 키(「조용함 %lld초」/「조용함 %lld분」)로 추출돼 10개 언어 번역됨.
    private func quietText(_ seconds: Int) -> Text {
        if seconds < 60 {
            return Text("조용함 \(seconds)초")
        }
        return Text("조용함 \(seconds / 60)분")
    }

    /// 음성(Whisper) 모델 상태 배너 — 입력바 위에 얇게. 다운로드 중엔 진행률(%) + 막대, 다운로드
    /// 후 로드 중엔 인디터미닛, 준비되면 잠깐 «사용 가능» 토스트. accent(보라)로 «진행/완료» 를
    /// 알린다(경고가 아니므로 노랑 금지). 평상시(idle/ready·토스트 종료)엔 아무것도 그리지 않는다.
    @ViewBuilder
    private var speechStatusBanner: some View {
        if speech.modelState == .preparing {
            HStack(spacing: 8) {
                if speech.isLoadingModel {
                    ProgressView().controlSize(.mini)
                    Text("음성 모델 불러오는 중…")
                        .font(.caption)
                } else {
                    let pct = "\(Int((speech.downloadProgress * 100).rounded()))%"
                    Image(systemName: "arrow.down.circle")
                        .font(.caption2.weight(.semibold))
                    Text("음성 모델 다운로드 중 \(pct)")
                        .font(.caption)
                        .monospacedDigit()
                    ProgressView(value: speech.downloadProgress)
                        .frame(maxWidth: 120)
                }
                Spacer(minLength: 0)
            }
            .foregroundStyle(Theme.accent)
            .tint(Theme.accent)
            .padding(.horizontal, 12)
            .padding(.vertical, 5)
            .background(Theme.accent.opacity(0.10))
        } else if showSpeechReadyToast {
            HStack(spacing: 6) {
                Image(systemName: "checkmark.circle.fill")
                    .font(.caption2.weight(.semibold))
                Text("음성 입력을 사용할 수 있어요")
                    .font(.caption)
                Spacer(minLength: 0)
            }
            .foregroundStyle(Theme.accent)
            .padding(.horizontal, 12)
            .padding(.vertical, 5)
            .background(Theme.accent.opacity(0.10))
            .transition(.opacity)
        }
    }

    /// 녹음 중 큰 플로팅 HUD — 화면 위쪽에 떠서 «녹음 중 / 손을 떼면 입력돼요» 를 크게 보여준다.
    /// 작은 마이크 버튼이 엄지에 가려도 이 HUD 로 «지금 듣는 중» 을 분명히 인지하게 한다. 펄스는
    /// SF Symbol 의 내장 효과(symbolEffect .pulse)로 — 매번 다시 떠도 안정적으로 반복된다.
    @ViewBuilder
    private var recordingHUD: some View {
        if speech.isRecording {
            HStack(spacing: 12) {
                Image(systemName: "mic.fill")
                    .font(.title2.weight(.bold))
                    .foregroundStyle(Theme.onAccent)
                    .symbolEffect(.pulse, options: .repeating)
                    .frame(width: 44, height: 44)
                    .background(Theme.accent, in: Circle())
                VStack(alignment: .leading, spacing: 2) {
                    Text("녹음 중")
                        .font(.headline)
                    Text("손을 떼면 입력돼요")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.horizontal, 18)
            .padding(.vertical, 12)
            .background(.ultraThinMaterial, in: Capsule())
            .overlay(Capsule().stroke(Theme.accent.opacity(0.5), lineWidth: 1))
            .shadow(color: .black.opacity(0.18), radius: 10, y: 3)
            .padding(.top, 12)
            .transition(.move(edge: .top).combined(with: .opacity))
            // 손가락 제스처는 아래의 마이크 버튼이 받아야 한다 — HUD 는 터치를 통과시킨다.
            .allowsHitTesting(false)
        }
    }

    /// 대화에서 찾기 바 — [돋보기][검색어 TextField][3/12 또는 결과 없음][▲ 이전][▼ 다음][✕ 닫기].
    /// 터미널 위에 얇게 얹는다. 검색 실행/이동은 SwiftTerm 내장 검색을 통해 현재 매치를 선택
    /// (하이라이트)하고 해당 줄로 스크롤한다. 매치 수는 클라이언트가 버퍼를 스캔해 센다.
    private var findBar: some View {
        HStack(spacing: 10) {
            Image(systemName: "magnifyingglass")
                .font(.footnote)
                .foregroundStyle(.secondary)
            VoiceInputField("대화에서 찾기", text: $findQuery, focus: $isFindFocused)
                .textFieldStyle(.plain)
                .submitLabel(.search)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
                .onSubmit { goToNextMatch() }
            // 매치 수 / 현재 위치 — 검색어가 있을 때만. 0 건이면 «결과 없음».
            if !findQuery.isEmpty {
                if findCount > 0 {
                    Text(verbatim: "\(findIndex + 1)/\(findCount)")
                        .font(.footnote.monospacedDigit())
                        .foregroundStyle(.secondary)
                } else {
                    Text("결과 없음")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            Button {
                goToPreviousMatch()
            } label: {
                Image(systemName: "chevron.up")
            }
            .disabled(findCount == 0)
            .accessibilityLabel(Text("이전 일치"))
            Button {
                goToNextMatch()
            } label: {
                Image(systemName: "chevron.down")
            }
            .disabled(findCount == 0)
            .accessibilityLabel(Text("다음 일치"))
            // 닫기 — 해제 버튼이라 강조색 아닌 중립 primary (색 정책).
            Button {
                closeFind()
            } label: {
                Image(systemName: "xmark")
                    .foregroundStyle(Color.primary)
            }
            .accessibilityLabel(Text("찾기 닫기"))
        }
        .font(.body)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.bar)
    }

    /// 돋보기 버튼 — 찾기 바를 열고/닫는다. 열 때 다른 포커스(입력바·터미널)를 떼고 검색 필드에
    /// 키보드를 준다.
    private func toggleFind() {
        if showFind {
            closeFind()
        } else {
            showFind = true
            vm.isSearchActive = true
            isInputFocused = false
            vm.resignTerminalFocusHook?()
            // 검색 필드가 키보드를 가져가도록 한 박자 미뤄 포커스.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
                isFindFocused = true
            }
        }
    }

    /// 찾기 닫기 — 하이라이트 해제 + 상태 초기화 + 스트리밍 재계산 트리거 끄기.
    private func closeFind() {
        findRecountTask?.cancel()
        findRecountTask = nil
        vm.clearSearchHook?()
        vm.isSearchActive = false
        showFind = false
        isFindFocused = false
        findQuery = ""
        findCount = 0
        findIndex = 0
    }

    /// 검색어가 바뀌었을 때 — 매치 수를 다시 세고 첫 매치로 점프(하이라이트+스크롤). 빈/0건이면 해제.
    private func refreshSearch() {
        let term = findQuery
        guard !term.isEmpty else {
            vm.clearSearchHook?()
            findCount = 0
            findIndex = 0
            return
        }
        let c = vm.countMatchesHook?(term) ?? 0
        findCount = c
        findIndex = 0
        guard c > 0 else {
            vm.clearSearchHook?()
            return
        }
        // 검색 상태를 초기화하면 다음 findNext 가 맨 위(row 0)부터 첫 매치를 선택한다 → 인덱스 0 과 정합.
        vm.clearSearchHook?()
        vm.findNextHook?(term)
        vm.scrollToMatchHook?(term, 0)
    }

    /// 다음 매치로 — SwiftTerm 검색 커서를 한 칸 전진(선택)시키고 인덱스를 순환 증가 후 그 매치로 스크롤.
    private func goToNextMatch() {
        guard findCount > 0 else { return }
        vm.findNextHook?(findQuery)
        findIndex = (findIndex + 1) % findCount
        vm.scrollToMatchHook?(findQuery, findIndex)
    }

    /// 이전 매치로 — SwiftTerm 검색 커서를 한 칸 후진(선택)시키고 인덱스를 순환 감소 후 그 매치로 스크롤.
    private func goToPreviousMatch() {
        guard findCount > 0 else { return }
        vm.findPreviousHook?(findQuery)
        findIndex = (findIndex - 1 + findCount) % findCount
        vm.scrollToMatchHook?(findQuery, findIndex)
    }

    private var statusBar: some View {
        HStack(alignment: .top, spacing: 8) {
            statusBarLeftGroup
            Spacer(minLength: 0)
            statusBarRightGroup
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        // 모든 ChatKeyButton 이 공유할 높이를 주입 — 우상단 메뉴의 «버튼 작게/크게» 로 조정한 값.
        .environment(\.chatKeyHeight, CGFloat(toolbarButtonHeight))
        .animation(.easeInOut(duration: 0.18), value: isKeyboardVisible)
        .animation(.easeInOut(duration: 0.18), value: toolbarButtonHeight)
    }

    /// 커밋되지 않은 변경 파일 수 — gitStatus 미수신 초기/비-repo 면 0.
    private var changeCount: Int { vm.gitStatus?.total ?? 0 }
    /// 변경 카운트의 문자열 표현 — 칩 텍스트 + a11y 보간(%@ 키)용.
    private var changeCountText: String { "\(changeCount)" }

    /// 좌측 그룹 — 레포 컨텍스트. 두 줄: 브랜치 / 파일+diff.
    private var statusBarLeftGroup: some View {
        VStack(alignment: .leading, spacing: 4) {
            // 줄 1: 브랜치 — git repo 면 브랜치명, git init 안 된 폴더면 «Git 없음» 안내.
            // 아직 한 번도 브랜치를 못 받은 로딩 초기 (gitBranchLoaded == false) 엔 깜빡임을
            // 피하려 아무것도 안 띄운다.
            // 브랜치 칩은 탭하면 브랜치/worktree 시트가 열린다 (목록·전환·새 브랜치·worktree).
            // «Git 없음» 칩은 관리할 게 없어 비-인터랙티브로 둔다.
            if let branch = vm.branchName, !branch.isEmpty {
                // 브랜치 칩도 아래 도구 그룹과 같은 주황(Theme.pro)으로 통일 — git 컨텍스트 묶음.
                ChatKeyButton(
                    tint: Theme.pro,
                    text: branch,
                    accessibilityLabel: "브랜치 \(branch) — 브랜치·worktree 관리",
                    action: { gatePro { showBranchSheet = true } },
                ) {
                    Image(systemName: "arrow.triangle.branch")
                }
            } else if vm.gitBranchLoaded {
                ChatKeyButton(
                    tint: .secondary,
                    text: String(localized: "Git 없음"),
                    accessibilityLabel: "Git 저장소가 아니에요. git init 이 필요해요.",
                ) {
                    Image(systemName: "exclamationmark.triangle")
                }
            }
            // 줄 2: 파일 탐색기 + 변경점 뷰어. 둘 다 ChatKeyButton 으로 다른 키들과 같은 28pt
            // 높이·배경·모서리. 파일 탐색·변경점(diff)·이미지 첨부 3개 도구 버튼은 모두
            // 주황(Theme.pro)으로 통일한다 — 시각적으로 «고급 도구» 그룹으로 묶어 식별. 변경점 버튼은
            // 항상 노출하고, 0 이어도 탭하면 «변경 없음» 시트가 열린다. 변경 유무는 카운트 숫자로
            // 표시한다 (색 신호 대신).
            HStack(spacing: 6) {
                ChatKeyButton(tint: Theme.pro, accessibilityLabel: "파일 탐색", action: { gatePro { showFileBrowser = true } }) {
                    Image(systemName: "folder")
                }
                ChatKeyButton(
                    tint: Theme.pro,
                    // 변경이 없으면 «0» 을 빼고 아이콘만 — 0 배지는 노이즈라 숨긴다.
                    text: changeCount > 0 ? changeCountText : nil,
                    accessibilityLabel: "커밋되지 않은 변경 \(changeCountText)개",
                    action: { gatePro { showDiffSheet = true } },
                ) {
                    Image(systemName: "pencil.line")
                }
                // 체크포인트(브랜치·worktree 시트로 이동) · 라이브 프리뷰(상단 툴바로 이동) 는
                // 입력바 위 도구줄이 비좁아 여기서 뺐다.
                // 이미지 첨부 — 사진첩 열기. 선택하면 오른쪽에 첨부 카운트 버튼이 생긴다.
                ChatKeyButton(tint: Theme.pro, accessibilityLabel: "이미지 첨부", action: { gatePro { showPhotoPicker = true } }) {
                    Image(systemName: "photo")
                }
                // 프롬프트 보관함 버튼은 입력 인체공학상 키패드 쪽이 더 손이 가까워, 우측 그룹
                // 줄 2(Space 왼쪽)로 이동 (사용자 요청).
                // 첨부된 이미지가 있으면 카운트 칩 — 탭하면 뷰어/편집 시트.
                if !attachments.isEmpty {
                    ChatKeyButton(
                        tint: Theme.accent,
                        text: "\(attachments.count)",
                        accessibilityLabel: "첨부 이미지",
                        action: { showAttachmentSheet = true },
                    ) {
                        Image(systemName: "paperclip")
                    }
                }
                // 파일 참조(파일 전체/라인 범위)가 쌓여 있으면 카운트 칩 — 탭하면 첨언 편집/전송.
                if !fileRefs.isEmpty {
                    ChatKeyButton(
                        tint: Theme.pro,
                        text: "\(fileRefs.count)",
                        accessibilityLabel: "파일 참조",
                        action: { gatePro { showFileRefSheet = true } },
                    ) {
                        Image(systemName: "text.badge.plus")
                    }
                }
            }
        }
    }

    /// 우측 그룹 — 키보드 입력 관련 모든 버튼이 한 컨테이너 안에.
    ///
    ///   [ESC] [Tab] [⌫] [↑] [/] [⌨ 토글]
    ///   [Space] [←] [↓] [→] [Enter] [전송]
    ///
    /// VStack(.trailing) 우측 정렬 + 동일 높이 키 + 6pt gap. PTY 면 두 줄 모두 6 키라 정확히
    /// 격자로 맞물린다: [ESC]/[Space], [Tab]/[←], [⌫]/[↓], [↑]/[→], [/]/[Enter], [⌨ 토글]/[전송] 가 같은 X column.
    /// 전송 버튼은 멀티라인 inputBar 안쪽이 아니라 키패드 클러스터 우측으로 빼고 (인라인 위치가
    /// 거슬린다는 사용자 피드백), 키보드 토글을 그 위에 둔다. 전송은 일관성을 위해 «항상» 노출 —
    /// 보낼 게 없으면 canSend 로 흐리게 비활성.
    /// 지우기(⌫)는 채팅방에서 호출이 잦아 화살표 클러스터 좌상단에 상시 노출 (사용자 요청 2026-05).
    /// Space/Enter/⌫ 는 한글 모드 / 멀티라인 inputBar 사용 중에도 REPL 을 raw byte
    /// (0x20 / 0x0d / 0x7f) 로 제어할 수 있게 둔다.
    private var statusBarRightGroup: some View {
        VStack(alignment: .trailing, spacing: 4) {
            // 줄 1: [ESC] [Tab] [⌫] [↑] [/] (PTY) + [🎤 음성] [⌨ 토글].
            // 마이크는 SDK 세션에도 필요하므로 PTY 블록 «밖» 에 둔다(항상 노출). ESC 가 맨 앞,
            // 그 오른쪽이 Tab (사용자 요청 — Space 와 위치 맞바꿈).
            HStack(spacing: 6) {
                if session.isPty {
                    if needsWheelScroll { scrollKeyButton(.scrollUp, icon: "chevron.up", a11y: "위로 스크롤") }
                    escKeyButton
                    tabKeyButton
                    deleteKeyButton
                    keypadCompactButton(.up, icon: "arrow.up", a11y: "위")
                    slashKeyButton
                }
                micKeyButton
                keyboardToggleButton
            }
            // 줄 2: [↓ 스크롤(copilot)][프롬프트][Space][←][↓][→][Enter] (PTY) + [전송]. 스크롤
            // 아래 버튼은 줄1 의 스크롤 위 버튼과 세로로 맞추려 맨 앞에 둔다. 프롬프트 보관함은 입력
            // 인체공학상 키패드 옆이 손이 가까워 Space 왼쪽에 둔다(항상 노출 — SDK 세션에도). 전송은
            // 일관성을 위해 항상 노출하고, 보낼 게 없으면 canSend 로 비활성(흐림) 처리한다.
            HStack(spacing: 6) {
                if session.isPty && needsWheelScroll { scrollKeyButton(.scrollDown, icon: "chevron.down", a11y: "아래로 스크롤") }
                promptLibraryButton
                if session.isPty {
                    spaceKeyButton
                    keypadCompactButton(.left, icon: "arrow.left", a11y: "왼쪽")
                    keypadCompactButton(.down, icon: "arrow.down", a11y: "아래")
                    keypadCompactButton(.right, icon: "arrow.right", a11y: "오른쪽")
                    enterKeyButton
                }
                sendKeyButton
            }
        }
    }

    /// 푸시-투-토크 마이크 버튼 — 누르고 있는 동안 온디바이스(Whisper) STT 로 녹음, 떼면 인식
    /// 텍스트를 입력 필드에 «삽입» 한다(자동 전송 금지 — 검토 후 전송). 모델이 아직 준비 안 됐으면
    /// 첫 누름이 다운로드/로드를 시작하고(스피너 표시), 준비된 뒤의 누름부터 녹음한다. 떼고 변환하는
    /// 동안에도 스피너. Whisper 는 모든 지원 언어를 다루므로 로케일로 숨기지 않는다.
    private var micKeyButton: some View {
        // 추출된 재사용 컴포넌트. 받아쓰기→입력 삽입 로직(공백 이어붙임·삽입 후 포커스)은
        // DictationMicButton 안으로 옮겨, 예약 작업 명령·PO 수집 지시 등 다른 입력란과 공유한다.
        // ChatView 의 녹음 HUD·준비 배너·오류 alert 는 아래 본문에 «그대로» 둬(레이아웃 회귀 방지),
        // voiceDictationChrome() 대신 ChatView 고유 배치를 유지한다.
        DictationMicButton(text: $input, focus: $isInputFocused)
    }

    /// `/` 슬래시 명령어 빠른 입력 — claude / antigravity / codex CLI 의 공통 slash 명령
    /// 시작 트리거. 한글 키보드 모드라도 byte 직통 송신 + SwiftTerm focus 자동 swap 으로
    /// 그 다음 영문 입력이 바로 PTY 로 흐른다 (slash menu 인터랙션).
    private var slashKeyButton: some View {
        ChatKeyButton(accessibilityLabel: "슬래시 명령", action: {
            vm.sendKeystroke(Data([0x2f]))  // '/' (0x2f)
            // 슬래시 직후엔 명령 검색어를 타이핑해야 하므로 키보드를 «자동으로» 띄운다.
            // PTY 는 SwiftTerm first responder(영문 직통) 경로로 열어, 이어지는 입력이 바로
            // PTY 로 흘러 slash menu 가 필터링되게 한다 (TextField 배치 입력이 아니라 라이브).
            // 키보드가 닫혀 있든 한글 모드든 무관하게 열고, ASCII 로 강제 전환한다.
            if session.isPty {
                vm.requestTerminalFocusHook?()
            } else {
                isInputFocused = true
            }
        }) {
            Text(verbatim: "/")
        }
    }

    /// 프롬프트 보관함 — 스니펫(자주 쓰는 지시) + 최근 보낸 프롬프트를 1탭으로 입력창에 채우거나
    /// 바로 전송. 모바일 키보드로 긴 지시를 다시 치는 비용이 모호한 프롬프트(→ 빗나간 턴)를 만드는
    /// 약한고리 보강. 입력 인체공학은 핵심 UX 라 pro 게이트 없음 — 기본 accent.
    private var promptLibraryButton: some View {
        ChatKeyButton(
            tint: Theme.accent,
            accessibilityLabel: "프롬프트 보관함",
            action: { showPromptLibrary = true },
        ) {
            Image(systemName: "text.book.closed")
        }
    }

    /// Space (0x20) 가상 키 — REPL 의 다항 선택 wizard 제어용. `/` 슬래시 버튼과 같은 raw byte
    /// 직통 (WS pty_input). 한글 IME / 멀티라인 inputBar 포커스 상태에서도 한 byte 를 PTY 로
    /// 그대로 흘려보낸다 (focus 와 무관하게 송신).
    private var spaceKeyButton: some View {
        ChatKeyButton(repeats: true, accessibilityLabel: "스페이스", action: {
            vm.sendKeystroke(Data([0x20]))  // Space (0x20)
        }) {
            Image(systemName: "space")
        }
    }

    /// Enter (\r, 0x0d) 가상 키 — REPL 의 선택 확정 / 줄 제출. raw byte 직통 (WS pty_input).
    /// 멀티라인 inputBar 에선 return 이 줄바꿈이 되므로, PTY 에 «엔터» 를 직접 보내려면 이 키.
    private var enterKeyButton: some View {
        ChatKeyButton(repeats: true, accessibilityLabel: "엔터", action: {
            vm.sendKeystroke(Data([0x0d]))  // Enter (\r, 0x0d)
        }) {
            Image(systemName: "return")
        }
    }

    /// 키보드 토글 — 떠있으면 닫기, 안 떠있으면 SwiftTerm 에 first responder 활성 요청.
    private var keyboardToggleButton: some View {
        ChatKeyButton(
            accessibilityLabel: isKeyboardVisible ? "키보드 닫기" : "키보드 열기",
            action: {
                if isKeyboardVisible {
                    dismissKeyboard()
                } else if session.isPty && isAsciiKeyboard {
                    // PTY 세션 + ASCII 키보드 — SwiftTerm 직통.
                    vm.requestTerminalFocusHook?()
                } else {
                    // SDK 세션 또는 PTY+한글 — inputBar TextField focus.
                    isInputFocused = true
                }
            },
        ) {
            Image(systemName: isKeyboardVisible ? "keyboard.chevron.compact.down" : "keyboard")
        }
    }

    /// ESC (\x1b, 0x1b) 가상 키 — REPL / vim / fzf 등에서 모드 탈출·취소. raw byte 직통
    /// (WS pty_input). 지우기(⌫) 좌측에 상시 노출 (사용자 요청 2026-06).
    private var escKeyButton: some View {
        ChatKeyButton(repeats: true, accessibilityLabel: "ESC", action: {
            vm.sendKeystroke(Data([0x1b]))
        }) {
            Image(systemName: "escape")
        }
    }

    /// Tab (\t, 0x09) 가상 키 — REPL 자동완성 / 필드 이동. raw byte 직통 (WS pty_input).
    /// 왼쪽 화살표(←) 좌측에 상시 노출 (사용자 요청 2026-06).
    private var tabKeyButton: some View {
        ChatKeyButton(repeats: true, accessibilityLabel: "Tab", action: {
            vm.sendKeystroke(Data([0x09]))
        }) {
            Image(systemName: "arrow.right.to.line")
        }
    }

    /// ⌫ delete 키 — SwiftTerm 의 IME 자동 backspace 차단 후 사용자 명시 delete 의 직접
    /// path. vm.sendKeystroke(Data([0x7f])) 으로 PTY 에 \x7f 송신.
    private var deleteKeyButton: some View {
        ChatKeyButton(repeats: true, accessibilityLabel: "삭제", action: {
            vm.sendKeystroke(Data([0x7f]))
        }) {
            Image(systemName: "delete.left")
        }
    }

    /// statusBar 의 화살표 키 — PtyKey 를 ANSI CSI 로 daemon 에 보낸다. 키보드가 열려 있고
    /// 비영문 (한글 등) 상태면 SwiftTerm focus 로 swap (keyboardType=.asciiCapable 강제로
    /// iOS 가 영문 키보드로 전환) — 화살표 입력 직후 영문 직통 모드로 진입, globe 키 불필요.
    /// 모양/색은 ChatKeyButton 공통.
    private func keypadCompactButton(_ key: PtyKey, icon: String, a11y: LocalizedStringKey) -> some View {
        ChatKeyButton(repeats: true, accessibilityLabel: a11y, action: {
            if isKeyboardVisible && !isAsciiKeyboard && session.isPty {
                vm.requestTerminalFocusHook?()
            }
            Task { await vm.sendPtyKey(key) }
        }) {
            Image(systemName: icon)
        }
    }

    /// 이 세션 에이전트가 «본문을 마우스 휠로만 스크롤하는» alt-screen TUI 인가 — daemon 이
    /// 광고하는 `wheel_scroll_v1` capability 로 판정한다(하드코딩 isCopilot 대체). copilot 처럼
    /// 화살표/터치로 본문이 안 굴러가는 TUI 에 daemon 이 이 capability 를 달면, iOS 코드 수정 없이
    /// 새 에이전트도 자동으로 «스크롤 위/아래» 버튼을 얻는다. capability 미도착(조회 전)·옛 daemon
    /// 은 false → 버튼 숨김(기존 비-copilot 동작과 동일).
    ///
    /// (원인 분리) 마우스 모드는 «한글 입력 불가» 의 원인이 «아니다» — 휠 보고는 단방향 좌표
    /// 보고라 IME 입력과 무관하다. «스크롤이 안 돼서» 마우스를 끄는 잘못된 수정 금지(휠만 깨진다).
    /// 근거는 daemon copilot 어댑터(부팅 mode-set 실측 감사)·pty-runner 주석 참고.
    private var needsWheelScroll: Bool { agentCapabilities.contains("wheel_scroll_v1") }

    /// 이 세션 에이전트(`session.agent`)의 capability 집합을 daemon `/api/agents` 에서 1회 읽어
    /// `agentCapabilities` 에 채운다. 실패/옛 daemon(404)은 조용히 빈 채로 둬 모든 게이트가
    /// false 로 떨어진다(기존 동작 유지). picker 의 loadAgents 와 같은 라우트를 재사용 — 응답이
    /// 가벼워(에이전트 ≤ 수 개) 채팅 진입당 1회 조회 비용은 무시할 수준. label:nil 이라 in-flight
    /// 배너에 노출되지 않는다.
    private func loadAgentCapabilities() async {
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        guard let list = try? await api.listAgents(label: nil) else { return }
        let agentId = AgentKind.from(id: session.agent).rawId
        agentCapabilities = list.first(where: { $0.id == agentId })?.capabilities ?? []
    }

    /// 휠 스크롤 가상 키 — `wheel_scroll_v1` alt-screen TUI(copilot 등) 본문을 위/아래로 굴린다.
    /// daemon 이 SGR 휠 이벤트로 변환(`/pty/key` scroll_up|scroll_down). 화살표 키패드(커서 이동)와
    /// 구분되도록 chevron 아이콘을 쓰고, 길게 눌러 연속 스크롤되도록 repeats.
    private func scrollKeyButton(_ key: PtyKey, icon: String, a11y: LocalizedStringKey) -> some View {
        ChatKeyButton(repeats: true, accessibilityLabel: a11y, action: {
            Task { await vm.sendPtyKey(key) }
        }) {
            Image(systemName: icon)
        }
    }

    /// 메시지 입력바 — 멀티라인 (axis: .vertical, 1~6줄 가변). SDK 세션은 항상, PTY 세션은
    /// 비영문 키보드 / 작성 중 텍스트가 있을 때 노출된다 (showInputBar). 멀티라인이라 return 은
    /// 줄바꿈 — 전송은 statusBar 우측의 [↑ 전송] 키패드 버튼으로 (인라인 전송 버튼은 제거).
    private var inputBar: some View {
        TextField("에이전트에게 명령…", text: $input, axis: .vertical)
            .textFieldStyle(.roundedBorder)
            .focused($isInputFocused)
            .lineLimit(1...6)
            .onSubmit { sendTapped() }
            .padding(8)
    }

    /// inputBar 노출 조건 — SDK 는 항상, PTY 는 비영문 키보드이거나 작성 중 텍스트가 있을 때.
    /// 전송 버튼 노출도 이 값에 묶는다 (입력 필드가 없으면 보낼 게 없으므로).
    private var showInputBar: Bool {
        !session.isPty || !isAsciiKeyboard || !input.isEmpty
    }

    /// 현재 가로 모드인가 — iPhone-only 라 verticalSizeClass==.compact 가 곧 가로.
    private var isLandscape: Bool { vSizeClass == .compact }
    /// 방향별 자동 숨김이 하나라도 켜져 있나 — FAB 노출 + 자동 적용 게이트.
    /// FAB 노출 조건 — 현재 방향의 «컨트롤 숨김 버튼» 설정이 켜져 있을 때만.
    private var showChromeButton: Bool { isLandscape ? showChromeFABLandscape : showChromeFABPortrait }

    /// 지금 크롬(헤더+입력바+상태바)을 숨기는 중인가 — FAB 가 노출돼 있고 사용자가 토글했을 때만.
    /// 현재 방향에서 FAB 가 꺼져 있으면 즉시 false 가 돼 숨겼던 크롬이 복구된다(버튼 없이 갇히지 않게).
    private var hideChrome: Bool { showChromeButton && chromeHidden }

    /// 크롬(헤더+입력바+상태바) 숨김/표시 토글 FAB — 현재 방향의 «컨트롤 숨김 버튼» 설정이 켜졌을 때만 노출.
    /// 미러링 화면(RemoteScreenView)의 FAB 와 같은 모양·역할: 본문을 크게 보려 컨트롤을 잠시 숨긴다.
    @ViewBuilder
    private var chromeToggleFAB: some View {
        if showChromeButton {
            Button {
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

    /// 전송 버튼 — 키패드 클러스터 우측 (Enter 오른쪽 / 키보드 토글 아래). 멀티라인 inputBar 의
    /// 내용을 sendTapped 로 전송. 다른 키와 같은 박스 모양이되 1차 액션이라 accent 색으로 강조,
    /// 보낼 게 없으면 비활성(흐림). 햅틱은 sendTapped 가 자체적으로 줘서 여기선 끈다.
    private var sendKeyButton: some View {
        ChatKeyButton(
            tint: Theme.accent,
            isEnabled: canSend,
            haptic: false,
            accessibilityLabel: "보내기",
            action: { sendTapped() },
        ) {
            Image(systemName: "paperplane.fill")
        }
    }

    /// 전송 가능 여부 — 공백/개행만 있는 입력은 막고, 전송 진행 중에도 막는다.
    private var canSend: Bool {
        !input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !vm.isSending
    }

    private func dismissKeyboard() {
        isInputFocused = false
        vm.resignTerminalFocusHook?()
        UIApplication.shared.sendAction(
            #selector(UIResponder.resignFirstResponder),
            to: nil,
            from: nil,
            for: nil,
        )
    }

    /// 세션 삭제 — SessionsView 의 스와이프 삭제와 같은 경로다. 세션 목록 캐시에서 먼저 낙관적으로
    /// 제거(채팅방을 나가면 목록에 항목이 남지 않게)하고 채팅방을 닫은 뒤 daemon 에 삭제를 요청한다.
    /// 작성 중 draft 도 함께 정리한다. 실패하면 캐시를 복구해 목록에 다시 나타나게 한다.
    @MainActor
    private func deleteSession() async {
        isDeleting = true
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        let snapshot = sessionCache.sessions
        sessionCache.mutate { $0.removeAll { $0.id == session.id } }
        // 채팅방을 먼저 닫는다 — 모달(onClose)로 떠 있으면 onClose, 아니면 네비게이션 pop.
        if let onClose {
            onClose()
        } else {
            dismiss()
        }
        do {
            try await api.deleteSession(session.id)
            ChatDraftStore.clear(session.id)
        } catch {
            // 실패 시 목록 복구 — 사용자는 다시 세션 목록에서 세션을 볼 수 있다.
            sessionCache.save(snapshot)
        }
        isDeleting = false
    }

    /// 현재 활성 키보드의 primaryLanguage 검사 + `isAsciiKeyboard` 갱신.
    /// 활성 first responder 의 `textInputMode?.primaryLanguage` 가 가장 정확. fallback 으로
    /// 시스템 활성 keyboard 목록의 첫 element.
    private func updateKeyboardLanguage() {
        // 모달(첨부/참조 시트·이름변경 alert 등)이 떠 있으면 현재 first responder 는 그 모달의
        // TextField 다. 그 언어로 채팅 화면의 isAsciiKeyboard 를 오염시키면 focus swap /
        // inputBar 노출이 시트 위에서 잘못 작동하므로, 모달 중에는 갱신하지 않는다.
        guard !isModalPresented else { return }
        let lang = activeInputLanguage()
        let isAscii = lang.isEmpty || lang.hasPrefix("en") || lang == "emoji"
        if isAscii != isAsciiKeyboard {
            isAsciiKeyboard = isAscii
        }
    }

    private func activeInputLanguage() -> String {
        if let resp = UIResponder.ks_currentFirstResponder,
           let mode = resp.textInputMode,
           let lang = mode.primaryLanguage
        {
            return lang
        }
        if let lang = UITextInputMode.activeInputModes.first?.primaryLanguage {
            return lang
        }
        return ""
    }

    /// 이 세션의 알림 음소거 상태 — 서버 최신값(currentSession) 우선, 초기엔 init 값 fallback.
    private var notifyMuted: Bool {
        vm.currentSession?.notifyMuted ?? session.notifyMuted
    }

    /// 더보기 메뉴의 음소거 토글 라벨. ternary 를 String 으로 추론해 localize 가 빠지지 않게
    /// LocalizedStringKey 로 명시(둘 다 카탈로그 기존 키).
    private var notifyToggleTitle: LocalizedStringKey {
        notifyMuted ? "이 세션 알림 켜기" : "이 세션 알림 끄기"
    }

    /// 토큰 잔량 row 노출 여부 — shell(터미널) 은 토큰을 안 쓰므로 클라이언트가 즉시 숨긴다.
    /// 그 외 agent 는 daemon 의 supported 판정 (agy 미지원 → 응답 후 숨김) 에 따른다.
    private var showAgentUsage: Bool {
        (vm.currentSession?.agent ?? session.agent ?? "claude_code") != "shell"
    }

    /// 잔량 row 부제 — 예: "남음 53% · 6/4 16:00 리셋". 제목(윈도우 라벨)과 분리해 메뉴
    /// subtitle 자리(시스템이 작은 보조 폰트로 렌더)에 넣는다. 잔량(남음)으로 보여준다
    /// (사용자 멘탈 모델: «얼마나 더 쓸 수 있나»). % 리터럴은 포맷 키 충돌을 피해 %@ 로 보간.
    private func usageRowSubtitle(_ w: AgentUsageWindow) -> String {
        let remain = max(0, min(100, 100 - Int(w.usedPercent.rounded())))
        let pct = "\(remain)%"
        if let ms = w.resetsAt {
            let date = Date(timeIntervalSince1970: TimeInterval(ms) / 1000)
            let t = Self.usageResetText(date)
            return String(localized: "남음 \(pct) · \(t) 리셋")
        }
        return String(localized: "남음 \(pct)")
    }

    /// 윈도우 라벨 — windowMinutes 기반 (300 → 5시간, 10080 → 주간). 모델별 주간 윈도우는
    /// id 로 구분 (Opus/Sonnet 은 고유명사라 비번역).
    private func usageWindowLabel(_ w: AgentUsageWindow) -> String {
        if w.id == "seven_day_opus" { return String(localized: "주간(Opus)") }
        if w.id == "seven_day_sonnet" { return String(localized: "주간(Sonnet)") }
        guard let m = w.windowMinutes else { return w.id }
        if m >= 7 * 24 * 60 { return String(localized: "주간") }
        if m >= 24 * 60 {
            let days = m / (24 * 60)
            return String(localized: "\(days)일")
        }
        let hours = max(1, m / 60)
        return String(localized: "\(hours)시간")
    }

    /// 리셋 시각 표시 — 오늘이면 시간만 (예: 16:00), 아니면 날짜+시간 (예: 6/4 16:00).
    /// 포맷은 로케일 자동.
    private static func usageResetText(_ date: Date) -> String {
        if Calendar.current.isDateInToday(date) {
            return date.formatted(date: .omitted, time: .shortened)
        }
        return date.formatted(.dateTime.month(.defaultDigits).day().hour().minute())
    }

    /// 세션 알림 토글 — rename 과 동일하게 낙관적 업데이트 없이 서버 응답으로만 아이콘 갱신.
    /// 실패하면 아이콘이 안 바뀌는 것 자체가 피드백 (재시도 가능). PATCH 진행 중엔 버튼 잠금.
    /// 프로(주황) 기능 게이트 — 보유 또는 무료 단계면 실행, 아니면 페이월 시트를 띄운다.
    /// 채팅의 «고급 도구»(브랜치/worktree·파일 탐색·diff·이미지·세션 알림 음소거 등)는 모두
    /// 이 한 곳을 거친다 → 중앙 게이트(purchase.gate)로 위임해 판정/페이월을 단일화.
    private func gatePro(_ run: () -> Void) {
        purchase.gate(.chatTools, $paywallFeature, run)
    }


    private func toggleNotifyMuted() {
        guard !isTogglingNotify else { return }
        isTogglingNotify = true
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        let target = !notifyMuted
        Task {
            _ = await vm.setNotifyMuted(target)
            isTogglingNotify = false
        }
    }

    /// 세션이 «활성» (실행중/대기) 인지 — 종료/오류(done) 면 idle 표시·다음 정지 알림 토글을
    /// 비활성한다 (수용 기준 엣지케이스: dead 세션엔 둘 다 무의미). 서버 최신값 우선, 초기엔 init.
    private var sessionIsActive: Bool {
        (vm.currentSession ?? session).runState != .done
    }

    /// 「다음 정지 시 알림」 메뉴 토글 라벨 — 무장 여부로 분기. ternary 가 String 으로 추론돼
    /// localize 가 빠지지 않게 LocalizedStringKey 로 명시.
    private var nextStopToggleTitle: LocalizedStringKey {
        vm.notifyNextStopArmed ? "다음 정지 알림 해제" : "다음에 멈추면 알림"
    }

    private func toggleNotifyNextStop() {
        guard !isTogglingNextStop else { return }
        isTogglingNextStop = true
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        let target = !vm.notifyNextStopArmed
        Task {
            _ = await vm.setNotifyNextStop(target)
            isTogglingNextStop = false
        }
    }

    // 옛 floating virtualKeypad / keypadButton / keypadSpacer 함수는 제거됨.
    // 모든 키패드 키는 statusBar 두 줄에 흡수되어 keypadCompactButton 으로 통합 (2026-05).

    /// 파일 브라우저 시트의 navigationTitle — 세션 repo_path 의 마지막 segment.
    /// view 의 .sheet(...) 안에 inline 으로 넣었더니 Swift 컴파일러가 «expression too complex»
    /// 로 거절 — 표현식을 변수로 빼서 한 단계 단순화.
    private var repoRootTitle: String {
        let path = vm.currentSession?.repo_path ?? session.repo_path
        if let last = path.split(separator: "/").last { return String(last) }
        return "Repo"
    }

    /// PTY 폰트 크기를 delta(pt) 만큼 조정하고 가벼운 햅틱을 준다. 범위 밖이면 no-op.
    private func adjustPtyFontSize(by delta: Double) {
        let next = (ptyFontSize + delta).rounded()
        let clamped = min(max(next, ChatView.ptyFontSizeMin), ChatView.ptyFontSizeMax)
        guard clamped != ptyFontSize else { return }
        ptyFontSize = clamped
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }

    /// 수동 모드의 직접 지정 cols 를 delta 만큼 조정 — frame 폭이 비례해 바뀌고 SwiftTerm 이
    /// sizeChanged → sendPtyResize 로 daemon PTY 를 따라가게 한다. 범위 밖은 clamp.
    private func adjustPtyCols(by delta: Int) {
        let next = ptyManualCols + delta
        let clamped = min(max(next, ChatView.ptyManualColsMin), ChatView.ptyManualColsMax)
        guard clamped != ptyManualCols else { return }
        ptyManualCols = clamped
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }

    /// 툴바 키 버튼 높이를 delta(pt) 만큼 조정 — 모든 ChatKeyButton 이 비례해 커진다. 범위 밖 no-op.
    private func adjustToolbarButtonHeight(by delta: Double) {
        let next = (toolbarButtonHeight + delta).rounded()
        let clamped = min(max(next, ChatView.toolbarButtonHeightMin), ChatView.toolbarButtonHeightMax)
        guard clamped != toolbarButtonHeight else { return }
        toolbarButtonHeight = clamped
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }

    /// 사진첩에서 고른 항목들을 다운스케일/압축해 draft 로 누적. 다음 선택을 위해 pickerItems 비움
    /// (append 패턴). 시트는 사용자가 첨부 카운트 버튼을 눌러야 열린다 (자동 X — 요청 흐름대로).
    private func loadPickedImages(_ items: [PhotosPickerItem]) async {
        var drafts: [AttachmentDraft] = []
        for item in items {
            guard let data = try? await item.loadTransferable(type: Data.self) else { continue }
            // autoreleasepool — 큰 원본 이미지 10장을 루프로 변환할 때 디코드 중간물이
            // 런루프 끝까지 누적되지 않게 매 장 즉시 해제 (녹화 경로와 동일한 메모리 가드).
            if let draft = autoreleasepool(invoking: { AttachmentDraft.make(fromOriginal: data) }) {
                drafts.append(draft)
            }
        }
        await MainActor.run {
            attachments.append(contentsOf: drafts)
            pickerItems = []
        }
    }

    /// 첨부 이미지 업로드 → 저장 경로↔요구사항 매핑 프롬프트 합성 → 기존 메시지 경로로 전송.
    /// 성공하면 첨부를 비우고 시트를 닫는다. 실패하면 첨부를 남겨 재시도 가능.
    private func sendAttachments() {
        let drafts = attachments
        guard !drafts.isEmpty, !isUploadingAttachments else { return }
        let dirInput = attachmentDir.trimmingCharacters(in: .whitespaces)
        isUploadingAttachments = true
        Task {
            do {
                let saved = try await vm.uploadAttachments(
                    dir: dirInput.isEmpty ? nil : dirInput,
                    images: drafts.map { (filename: $0.suggestedName, data: $0.data) },
                )
                let prompt = composeAttachmentPrompt(saved: saved, drafts: drafts)
                if session.isPty {
                    await sendPtyText(prompt)
                } else {
                    _ = await vm.send(prompt)
                }
                // 시트를 «먼저» 닫는다. 같은 트랜잭션에서 attachments 를 비우면 아직 떠 있는
                // 시트의 ForEach($attachments) 바인딩이 사라진 인덱스를 참조해 Index out of
                // range 로 크래시 → dismiss 가 반영된 뒤(애니메이션 후) 비운다.
                await MainActor.run {
                    showAttachmentSheet = false
                    isUploadingAttachments = false
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                }
                try? await Task.sleep(nanoseconds: 350_000_000)
                await MainActor.run {
                    attachments = []
                    pickerItems = []
                    mirrorCaptureMode = false
                    attachmentOverallInstruction = ""
                }
            } catch {
                await MainActor.run { isUploadingAttachments = false }
                NSLog("[attach] upload/send failed: \(error.localizedDescription)")
            }
        }
    }

    /// 저장된 이미지 경로(repo-relative)와 이미지별 요구사항을 한 줄 프롬프트로 합성.
    /// PTY/SDK 모두 안전하도록 단일 라인 — 요구사항 내 개행은 공백으로 치환.
    /// saved 순서는 서버가 업로드 순서를 보존하므로 drafts 와 1:1 대응.
    /// «전체 요청» (미러링 캡처/녹화 모드) 이 있으면 그것을 프롬프트 맨 앞에 — 단계 이미지들은
    /// 참고 자료이고 무엇을 할지는 전체 요청이 말한다.
    private func composeAttachmentPrompt(saved: [SavedAttachment], drafts: [AttachmentDraft]) -> String {
        let parts = saved.enumerated().map { (i, s) -> String in
            let raw = i < drafts.count ? drafts[i].instruction : ""
            let instr = raw.replacingOccurrences(of: "\n", with: " ")
                .trimmingCharacters(in: .whitespaces)
            return instr.isEmpty ? s.rel : "\(s.rel): \(instr)"
        }
        let overall = attachmentOverallInstruction
            .replacingOccurrences(of: "\n", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if mirrorCaptureMode && !overall.isEmpty {
            let refHeader = String(localized: "참고 자료 — 시간순 화면 이미지:")
            return overall + " " + refHeader + " " + parts.joined(separator: " | ")
        }
        let header = String(localized: "첨부한 이미지를 참고해서 작업해줘:")
        return header + " " + parts.joined(separator: " | ")
    }

    /// DiffSheet «리뷰 요약» — 커밋되지 않은 변경 전체를 에이전트가 리뷰어 관점으로 요약하게
    /// 하는 구조화 프롬프트를 세션에 보낸다. 폰의 좁은 화면에서 raw diff 를 통독하는 대신
    /// «에이전트가 읽고 사람은 의도/위험/검증 포인트만 확인» 하도록 검증 행위를 바꾸는 기능.
    /// PTY/SDK 분기는 첨부/파일참조 전송과 동일한 검증된 레시피.
    private func requestDiffReview() {
        let prompt = String(localized: "지금 커밋되지 않은 변경 사항 전체(git diff)를 리뷰어 입장에서 검토해줘. ① 변경 의도 한 문단 요약 ② 위험한 변경부터 파일별 핵심 변경점 ③ 잠재 버그·회귀 가능성 ④ 머지 전에 사람이 직접 확인해야 할 검증 포인트. 코드 인용은 꼭 필요한 만큼만 짧게.")
        Task {
            if session.isPty {
                await sendPtyText(prompt)
            } else {
                _ = await vm.send(prompt)
            }
        }
    }

    /// 파일 참조(경로/라인 범위)↔요구사항 매핑 프롬프트를 합성해 전송. 업로드가 없어 즉시 전송.
    /// 성공하면 시트를 닫고(크래시 회피: dismiss 후 비움) 참조를 비운다. 실패해도 남겨 재시도 가능.
    private func sendFileReferences() {
        let refs = fileRefs
        guard !refs.isEmpty, !isSendingFileRefs else { return }
        let prompt = composeFileRefPrompt(refs)
        isSendingFileRefs = true
        Task {
            if session.isPty {
                await sendPtyText(prompt)
            } else {
                _ = await vm.send(prompt)
            }
            // 시트를 먼저 닫는다 — ForEach($fileRefs) 바인딩이 떠 있는 채로 비우면 크래시.
            await MainActor.run {
                showFileRefSheet = false
                isSendingFileRefs = false
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
            }
            try? await Task.sleep(nanoseconds: 350_000_000)
            await MainActor.run { fileRefs = [] }
        }
    }

    /// 파일 참조들을 한 줄 프롬프트로 합성. 라벨(path 또는 path:L10-L40)↔요구사항을 « | » 로 잇는다.
    /// PTY/SDK 모두 안전하도록 단일 라인 — 요구사항 내 개행은 공백으로 치환.
    private func composeFileRefPrompt(_ refs: [FileReferenceDraft]) -> String {
        let header = String(localized: "다음 파일/범위를 참고해서 작업해줘:")
        let parts = refs.map { ref -> String in
            let instr = ref.instruction
                .replacingOccurrences(of: "\n", with: " ")
                .trimmingCharacters(in: .whitespaces)
            // 화면 미러 «화면 피드백» — 코드 파일도 웹 프리뷰도 아닌 Mac 실화면 캡처본.
            // 스크린샷 경로 + 코멘트만 합성한다 (웹이 아니라 URL·DOM 요소 없음). 저장 실패
            // 폴백이면 path 가 비어 스크린샷 항목을 뺀다 — 프리뷰와 동일한 graceful 폴백.
            if ref.isScreenFeedback {
                let comment = instr.isEmpty ? String(localized: "(코멘트 없음)") : instr
                // 마크업이 가리킨 영역의 정규화 좌표 — 있으면 끝에 « [가리킨 위치: …] » 로 덧붙인다.
                // 좌표(x=…,y=…) 는 비번역 기술 토큰이라 그대로 끼워 넣는다(라벨만 localize). 웹 프리뷰의
                // «가리킨 요소(DOM)» 에 대응하는 네이티브 위치 — 픽셀 스크린샷만으론 모호하던 «어디» 를 메운다.
                var regionPart = ""
                if let region = ref.screenRegion, !region.isEmpty {
                    regionPart = " [" + String(localized: "가리킨 위치: \(region)") + "]"
                }
                if ref.path.isEmpty {
                    return String(localized: "화면 피드백: \(comment)") + regionPart
                }
                let shot = ref.path
                return String(localized: "화면 피드백: \(comment) (스크린샷: \(shot))") + regionPart
            }
            // 프리뷰 «화면 피드백» — 코드 파일이 아니라 폰 프리뷰 캡처본. 스크린샷 경로 + 코멘트 +
            // 진입 URL 을 따로 합성한다 (저장 실패 폴백이면 path 가 비어 스크린샷 항목을 뺀다).
            if let previewURL = ref.previewURL {
                let comment = instr.isEmpty ? String(localized: "(코멘트 없음)") : instr
                // 마크업이 가리킨 요소 식별자 — 있으면 끝에 « [가리킨 요소: …] » 로 덧붙인다.
                // selector/rect 는 비번역 기술 토큰이라 그대로 끼워 넣는다(라벨만 localize).
                var elementPart = ""
                if let el = ref.previewElement, !el.isEmpty {
                    elementPart = " [" + String(localized: "가리킨 요소: \(el)") + "]"
                }
                if ref.path.isEmpty {
                    return String(localized: "프리뷰 피드백: \(comment) (URL: \(previewURL))") + elementPart
                }
                let shot = ref.path
                return String(localized: "프리뷰 피드백: \(comment) (스크린샷: \(shot), URL: \(previewURL))") + elementPart
            }
            return instr.isEmpty ? ref.label : "\(ref.label): \(instr)"
        }
        return header + " " + parts.joined(separator: " | ")
    }

    private func sendTapped() {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !vm.isSending else { return }
        let text = input
        input = ""
        // 송신 후에도 키보드를 유지 — 연속 입력이 자연스럽다. SwiftUI 의 onSubmit/return 키나
        // input 비우기 시점에 first responder 가 떨어지는 동작을 우회한다.
        isInputFocused = true
        deliver(text, restoreOnFailure: true)
    }

    /// 텍스트를 실제로 전송한다. PTY 면 본문 push 후 \r 단독, SDK 면 vm.send. 최근 이력 적재 + 햅틱.
    /// sendTapped(입력창) 과 프롬프트 보관함 «바로 전송» 이 공유한다.
    /// - Parameter restoreOnFailure: SDK 전송 실패 시 입력창이 비어 있으면 본문을 되돌린다
    ///   (입력창 경로만 true; 보관함 바로 전송은 입력창을 안 거치므로 false).
    private func deliver(_ text: String, restoreOnFailure: Bool) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !vm.isSending else { return }
        // 최근 프롬프트 이력에 적재 — 프롬프트 보관함의 «최근» 섹션 데이터원.
        PromptLibraryStore.recordRecent(trimmed)
        // 가벼운 햅틱으로 입력이 인지됐음을 알린다.
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        // 글로벌 "도구 자동 승인" 토글은 제거됨 — 세션 생성 시 켠 skipPermissions
        // (DB sessions.skip_permissions=1) 가 daemon 측에서 매 turn 자동 적용.
        Task {
            if session.isPty {
                await sendPtyText(text)
            } else {
                let ok = await vm.send(text)
                if !ok, restoreOnFailure {
                    await MainActor.run {
                        if input.isEmpty { input = text }
                    }
                }
            }
        }
    }

    /// PTY 세션에 «완성 텍스트» 를 제출하는 공통 경로 — 입력창 전송(deliver)·첨부·파일참조·diff
    /// 리뷰가 모두 공유한다. 본문을 PTY 로 push 한 뒤 \r 을 «따로» 보낸다: 본문+\r 을 한 write 로
    /// 합치면 REPL 이 paste 로 간주해 끝의 \r 을 제출로 안 쳐서 실행이 안 되기 때문 → 본문 먼저,
    /// 짧은 딜레이 후 \r 단독. (한글 IME 의 markedText cycle 은 SwiftUI TextField 가 처리해 .text
    /// 엔 완성 음절만 들어온다.)
    ///
    /// Copilot(Ink)만 예외 — 완성 텍스트를 raw UTF-8 키스트로크로 흘리면 멀티바이트 파서가 키
    /// 폭주로 오인/누락해 한글이 깨지거나(�) 빈 제출이 된다(소스 로케일 ko 제품에서 사실상 사용
    /// 불가였음). 그래서 본문을 bracketed paste(ESC[200~ … ESC[201~)로 감싼 «단일 Buffer» 로 한
    /// 번에 보낸다 — 단일 pty_input → 단일 PTY write 라 한 음절이 청크 경계에서 쪼개지지 않고,
    /// Copilot 이 paste 로 받아 입력 박스에 그대로 적재한다. \r 은 괄호 «밖», paste 종료 후 따로
    /// 보내 제출시킨다(본문에 줄바꿈이 있어도 괄호 안에선 literal 이라 의도치 않은 조기 제출 없음).
    /// Copilot 1.0.63 은 부팅 시 ?2004h 를 켜 bracketed paste 를 수용한다(daemon copilot 어댑터의
    /// 실측 감사 — pty 부팅 mode-set 시퀀스). 다른 에이전트(Claude/Codex/Gemini/Terminal)는 기존
    /// raw 경로 그대로 — 본문을 bracketed paste 로 감쌌더니 제출이 안 먹던 이력(daemon
    /// pty-runner.runUserMessagePty 주석)이 있어 copilot 한정으로 둔다.
    private func sendPtyText(_ text: String) async {
        if AgentKind.from(id: session.agent) == .copilot {
            // ESC[200~ + UTF-8 본문 + ESC[201~ 를 한 Data 로 합쳐 한 번의 sendKeystroke 로 보낸다.
            var payload = Data([0x1b, 0x5b, 0x32, 0x30, 0x30, 0x7e]) // ESC [ 2 0 0 ~
            payload.append(Data(text.utf8))
            payload.append(Data([0x1b, 0x5b, 0x32, 0x30, 0x31, 0x7e])) // ESC [ 2 0 1 ~
            vm.sendKeystroke(payload)
        } else {
            vm.sendKeystroke(Data(text.utf8))
        }
        try? await Task.sleep(nanoseconds: 50_000_000)
        vm.sendKeystroke(Data([0x0d]))
    }

}


// MARK: - ChatDraftStore

/// 채팅 입력창의 «작성 중» 문장을 세션별로 UserDefaults 에 영속화한다.
/// 문장을 쓰다 세션을 나갔다 돌아오면 ChatView 의 @State input 이 리셋되는데, onAppear 가
/// 여기서 복원한다. 빈 문자열 저장은 키 제거와 동일 — 전송 직후 input 이 비워지면서
/// draft 도 자동으로 사라진다. 세션 삭제 시엔 SessionsView 가 clear 를 호출해
/// 고아 키가 UserDefaults 에 쌓이지 않게 한다.
enum ChatDraftStore {
    private static func key(_ sessionId: String) -> String { "chat.draft.\(sessionId)" }

    static func load(_ sessionId: String) -> String {
        UserDefaults.standard.string(forKey: key(sessionId)) ?? ""
    }

    static func save(_ sessionId: String, draft: String) {
        if draft.isEmpty {
            UserDefaults.standard.removeObject(forKey: key(sessionId))
        } else {
            UserDefaults.standard.set(draft, forKey: key(sessionId))
        }
    }

    static func clear(_ sessionId: String) {
        UserDefaults.standard.removeObject(forKey: key(sessionId))
    }
}


// MARK: - ChatKeyButton

/// 채팅방 statusBar 키 버튼의 공통 높이를 전파하는 Environment 키. ChatView 가 statusBar 에
/// AppStorage 값을 주입하고, 그 안의 모든 ChatKeyButton 이 이 값으로 자기 크기를 계산한다.
private struct ChatKeyHeightKey: EnvironmentKey {
    static let defaultValue: CGFloat = 28
}

extension EnvironmentValues {
    var chatKeyHeight: CGFloat {
        get { self[ChatKeyHeightKey.self] }
        set { self[ChatKeyHeightKey.self] = newValue }
    }
}

/// 채팅방 입력 영역의 «키» 버튼을 위한 일관된 그릇 — 라운드 박스 + 옅은 배경 + 햅틱.
/// SF Symbol 이나 짧은 텍스트 글리프를 `content` 로 받아, 어디서 쓰든 같은 모양·색·모서리·탭
/// 피드백을 보장한다.
///
/// 왜 SVG 가 아니라 SF Symbol 인가: SF Symbol 은 그 자체로 벡터(확대해도 안 깨짐) + 다이내믹
/// 컬러 + Dynamic Type + 굵기 매칭을 공짜로 주고, 이 코드베이스 전반이 이미 SF Symbol 을
/// 쓴다. 커스텀 SVG 는 에셋 import·렌더러·색 대응을 직접 떠안아야 해 일관성·유지보수에서 손해다.
/// 이 «그릇» 컴포넌트가 이미지를 담는 역할을 하고, 아이콘은 SF Symbol 로 통일한다.
///
/// 크기: 높이는 Environment(chatKeyHeight) 한 값으로 «모든» 버튼이 균일. 폰트·아이콘·패딩·
/// 모서리·간격은 그 높이에 비례해 함께 커진다 (28pt 기준 비율로 산출). 가로는 — 아이콘만이면
/// 높이와 같은 정사각, 텍스트를 곁들이면 내용 폭에 맞춰 가변.
///
/// - tint: 전경색 (기본 .primary, 전송 1차 액션은 accent, 변경 카운트는 warning 등).
/// - isEnabled: false 면 secondary 로 흐리게 + 탭 비활성.
/// - text: 아이콘 옆 텍스트 (브랜치명 / 변경 카운트 등). verbatim 으로 그린다 — 번역이 필요한
///   문자열은 호출부에서 String(localized:) 로 미리 지역화해 넘긴다.
/// - action: nil 이면 탭/햅틱 없는 «정보 칩» 으로 렌더 (브랜치명 등). 값이 있으면 버튼.
/// (RemoteScreenView 라이브 화면 컨트롤 바에서도 재사용 — 키 UI 일관성. 그래서 internal.)
struct ChatKeyButton<Content: View>: View {
    @Environment(\.chatKeyHeight) private var height
    // SwiftTerm 도 `Color` 를 export 해서 타입 표기 위치에선 모호 — SwiftUI.Color 로 한정.
    var tint: SwiftUI.Color = .primary
    var text: String? = nil
    var isEnabled: Bool = true
    var haptic: Bool = true
    /// true 면 «키보드 오토리피트» — 누르고 있는 동안 초기 지연 후 action 을 반복 호출한다(화살표·
    /// 삭제·Space·Enter 등 «가상 키» 버튼용). 시트를 여는 버튼 등 1회성 액션은 기본 false.
    var repeats: Bool = false
    var accessibilityLabel: LocalizedStringKey
    var action: (() -> Void)? = nil
    @ViewBuilder var content: () -> Content

    /// repeats=true 일 때 누름 동안 반복 호출을 돌리는 태스크(뗌·사라짐에 취소).
    @State private var repeatTask: Task<Void, Never>?
    /// repeats=true 버튼을 지금 누르고 있는가 — 중복 시작 방지 + 눌림 스케일 피드백.
    @State private var holding = false

    private var styledLabel: some View {
        HStack(spacing: height * 0.14) {
            content()
            if let text {
                Text(text)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
        }
        // 28pt 기준 비율: 폰트 16 / 모서리 6 / 가로패딩 8 / 간격 4 → 0.57 / 0.21 / 0.29 / 0.14.
        .font(.system(size: height * 0.57, weight: .semibold))
        .foregroundStyle(isEnabled ? tint : Color.secondary)
        .padding(.horizontal, text == nil ? 0 : height * 0.29)
        .frame(width: text == nil ? height : nil, height: height)
        .background(Color.secondary.opacity(0.16))
        .clipShape(RoundedRectangle(cornerRadius: height * 0.21, style: .continuous))
    }

    var body: some View {
        if let action {
            if repeats {
                // 키보드처럼 «꾹 누르면 반복» — 손가락이 닿는 순간 1회 + 초기 지연 후 빠르게 반복,
                // 떼면 멈춘다. 탭(Button)이 아니라 누름/뗌을 직접 감지해야 해 DragGesture 를 쓴다.
                styledLabel
                    .scaleEffect(holding ? 0.9 : 1)
                    .animation(.easeOut(duration: 0.1), value: holding)
                    .contentShape(Rectangle())
                    .gesture(
                        DragGesture(minimumDistance: 0)
                            .onChanged { _ in
                                guard isEnabled, !holding else { return }
                                holding = true
                                if haptic { UIImpactFeedbackGenerator(style: .light).impactOccurred() }
                                action()  // 즉시 1회
                                repeatTask = Task { @MainActor in
                                    // 오토리피트: 초기 지연(0.4s) 후 ~0.07s 간격 반복.
                                    try? await Task.sleep(nanoseconds: 400_000_000)
                                    while !Task.isCancelled {
                                        action()
                                        try? await Task.sleep(nanoseconds: 70_000_000)
                                    }
                                }
                            }
                            .onEnded { _ in
                                holding = false
                                repeatTask?.cancel()
                                repeatTask = nil
                            },
                    )
                    .onDisappear {
                        repeatTask?.cancel()
                        repeatTask = nil
                        holding = false
                    }
                    .disabled(!isEnabled)
                    .accessibilityLabel(Text(accessibilityLabel))
                    .accessibilityAddTraits(.isButton)
            } else {
                Button {
                    if haptic { UIImpactFeedbackGenerator(style: .light).impactOccurred() }
                    action()
                } label: {
                    styledLabel
                }
                .buttonStyle(.plain)
                .disabled(!isEnabled)
                .accessibilityLabel(Text(accessibilityLabel))
            }
        } else {
            // 비-인터랙티브 정보 칩 — 같은 모양이지만 탭 불가.
            styledLabel
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(Text(accessibilityLabel))
        }
    }
}


// MARK: - MicPushToTalkButton

/// 푸시-투-토크 마이크 버튼 — ChatKeyButton 과 같은 박스 모양·높이(chatKeyHeight)를 따르되,
/// «누르고 있는 동안» 녹음하려면 탭(Button)이 아니라 누름/뗌을 직접 감지해야 해 별도 뷰로 둔다.
/// DragGesture(minimumDistance: 0) 로 손가락이 닿는 순간(onChanged 첫 호출)을 누름 시작,
/// 떼는 순간(onEnded)을 뗌으로 본다.
///
/// 표시: 모델 다운로드/로드 중이거나 변환 중(isBusy)이면 스피너로 «대기» 를 보이고 누름을
/// 무시한다. 녹음 중(isRecording)이면 «확실히» 알아보게 — 박스를 accent(보라)로 꽉 채우고
/// 흰 mic.fill 로 반전 + 밖으로 퍼지는 펄스 링 + 살짝 커진 스케일로 «지금 듣는 중» 을 강조한다.
struct MicPushToTalkButton: View {
    @Environment(\.chatKeyHeight) private var height
    let isRecording: Bool
    /// 모델 준비/변환 중 — 스피너 표시 + 누름 무시.
    let isBusy: Bool
    /// true = 누름 시작(녹음 시작), false = 뗌(녹음 종료).
    let onPressChange: (Bool) -> Void

    @State private var pressed = false
    /// 녹음 중 밖으로 퍼지는 펄스 링 애니메이션 구동 플래그.
    @State private var pulse = false

    var body: some View {
        box
            // 녹음 중엔 살짝 «커지고», 누르기 시작(녹음 전 찰나)엔 살짝 «눌린다».
            .scaleEffect(isRecording ? 1.12 : (pressed ? 0.9 : 1))
            .animation(.easeOut(duration: 0.15), value: pressed)
            .animation(.easeOut(duration: 0.15), value: isRecording)
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { _ in
                        guard !pressed, !isBusy else { return }
                        pressed = true
                        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                        onPressChange(true)
                    }
                    .onEnded { _ in
                        guard pressed else { return }
                        pressed = false
                        onPressChange(false)
                    },
            )
            .onChange(of: isRecording) { rec in
                if rec {
                    // 녹음 시작을 햅틱으로도 한 번 더 알린다 + 펄스 시작.
                    UINotificationFeedbackGenerator().notificationOccurred(.success)
                    pulse = false
                    withAnimation(.easeOut(duration: 0.9).repeatForever(autoreverses: false)) {
                        pulse = true
                    }
                } else {
                    pulse = false
                }
            }
            .accessibilityLabel(isBusy ? Text("음성 모델 준비 중") : Text("음성 입력 (누르고 말하기)"))
            .accessibilityValue(isRecording ? Text("녹음 중") : Text(""))
            .accessibilityAddTraits(.isButton)
    }

    private var corner: CGFloat { height * 0.21 }

    @ViewBuilder
    private var box: some View {
        ZStack {
            // 녹음 중에만: 박스 밖으로 퍼졌다 사라지는 펄스 링 (레이아웃에 영향 X — overflow).
            if isRecording {
                RoundedRectangle(cornerRadius: corner, style: .continuous)
                    .stroke(Theme.accent, lineWidth: 2)
                    .frame(width: height, height: height)
                    .scaleEffect(pulse ? 1.6 : 1)
                    .opacity(pulse ? 0 : 0.7)
            }
            Group {
                if isBusy {
                    ProgressView()
                        .controlSize(.small)
                } else {
                    Image(systemName: isRecording ? "mic.fill" : "mic")
                        .font(.system(size: height * 0.57, weight: .semibold))
                        // 녹음 중엔 꽉 찬 보라 위 «흰» 아이콘으로 반전 — 평소(중립 primary)와 확연히 구분.
                        .foregroundStyle(isRecording ? Theme.onAccent : Color.primary)
                }
            }
            .frame(width: height, height: height)
            .background(isRecording ? Theme.accent : Color.secondary.opacity(0.16))
            .clipShape(RoundedRectangle(cornerRadius: corner, style: .continuous))
        }
    }
}


// MARK: - PtyTerminalView

// MARK: - 터미널 라이트/다크 테마

/// 8비트 RGB → SwiftTerm.Color (16비트 컴포넌트). v*257 로 0→0, 255→65535 매핑.
private func termColor8(_ r: UInt16, _ g: UInt16, _ b: UInt16) -> SwiftTerm.Color {
    SwiftTerm.Color(red: r * 257, green: g * 257, blue: b * 257)
}

/// 다크 기본 16색 — SwiftTerm 내장 `defaultInstalledColors` 와 «동일 값» (그 static 은 internal 이라
/// 직접 못 써서 값을 복제). 라이트 팔레트로 바꿨다가 다크로 돌아올 때 원복용 — 다크 외형 불변.
private let darkAnsiPalette: [SwiftTerm.Color] = [
    termColor8(0, 0, 0), termColor8(153, 0, 1), termColor8(0, 166, 3), termColor8(153, 153, 0),
    termColor8(3, 0, 178), termColor8(178, 0, 178), termColor8(0, 165, 178), termColor8(191, 191, 191),
    termColor8(138, 137, 138), termColor8(229, 0, 1), termColor8(0, 216, 0), termColor8(229, 229, 0),
    termColor8(7, 0, 254), termColor8(229, 0, 229), termColor8(0, 229, 229), termColor8(229, 229, 229),
]

/// 라이트 팔레트 — 흰 배경 가독성용 보정. CLI 출력은 «다크 배경» 가정이라 완벽 매칭은 불가하니
/// 가독성을 우선한다: «흰색»(idx 7·15)을 어둡게 해 흰 글자가 흰 배경에 사라지는 것 방지, 노랑/밝은
/// 색도 대비를 위해 톤다운. (값은 보수적 보정 — 더 다듬고 싶으면 이 배열만 조정.)
private let lightAnsiPalette: [SwiftTerm.Color] = [
    termColor8(0, 0, 0), termColor8(170, 0, 0), termColor8(0, 130, 0), termColor8(150, 110, 0),
    termColor8(0, 0, 190), termColor8(160, 0, 160), termColor8(0, 130, 150), termColor8(80, 80, 80),
    termColor8(120, 120, 120), termColor8(200, 0, 0), termColor8(0, 150, 0), termColor8(170, 120, 0),
    termColor8(0, 0, 210), termColor8(190, 0, 190), termColor8(0, 150, 170), termColor8(30, 30, 30),
]

/// 터미널 배경/전경/커서/팔레트를 앱 라이트·다크 테마에 맞춘다. (이전엔 .black/.white 로 «항상
/// 다크» 고정이라 라이트 테마에서도 터미널만 까맣게 남았다 — Mac 터미널을 따르는 게 아니라 iOS
/// 측 하드코딩이었다.)
private func applyTerminalTheme(_ terminal: SwiftTerm.TerminalView, scheme: ColorScheme) {
    if scheme == .dark {
        terminal.nativeBackgroundColor = .black
        terminal.nativeForegroundColor = .white
        terminal.caretColor = .white
        terminal.installColors(darkAnsiPalette)
    } else {
        terminal.nativeBackgroundColor = .white
        terminal.nativeForegroundColor = UIColor(white: 0.16, alpha: 1)
        terminal.caretColor = UIColor(white: 0.25, alpha: 1)
        terminal.installColors(lightAnsiPalette)
    }
}

/// SwiftTerm 의 UIKit `TerminalView` 를 SwiftUI 로 노출한다. claude REPL 의 raw PTY bytes
/// (color, cursor, spinner, multi-select wizard 등 일체) 를 그대로 보여 주고, 사용자 키 입력은
/// daemon 으로 흘려보낸다.
///
/// 옛 PtyViewportRenderer 휴리스틱 (`╭` 박스/`❯` 컷 등) 은 폐기. 가상 터미널 라이브러리가
/// xterm 호환으로 모든 ANSI escape 를 정확히 처리하므로 화면 일치성이 100%.
struct PtyTerminalView: UIViewRepresentable {
    @ObservedObject var vm: ChatViewModel
    /// 모노스페이스 폰트 크기 (pt). 사용자가 ChatView 의 메뉴에서 조정한다.
    /// 변경 시 updateUIView 가 SwiftTerm view.font 를 교체하고, SwiftTerm 내부 layout 이 재계산되어
    /// sizeChanged delegate 가 호출 → daemon PTY 크기도 자동으로 따라간다.
    var fontSize: CGFloat
    /// 앱 라이트/다크 테마 — 터미널 배경/전경/팔레트를 여기에 맞춘다(.preferredColorScheme 반영값).
    @Environment(\.colorScheme) private var colorScheme

    func makeUIView(context: Context) -> SwiftTerm.TerminalView {
        PtyLog.shared.notice("[PTY-LAYOUT/MAKE] PtyTerminalView.makeUIView called")
        let terminal = InteractiveTerminalView()
        // 스크롤백을 크게 — SwiftTerm 기본값은 500 줄이라 긴 세션(빌드 로그·diff·파일 출력)에서
        // 금방 가득 찬다. 차고 나면 새 출력 한 줄마다 맨 윗줄이 evict 되며 버퍼 전체가 위로 한 줄씩
        // shift 된다. flushFeed 가 «위로 스크롤해 보던» 위치를 절대 contentOffset 으로 복원해도,
        // evict 로 같은 내용이 위로 밀려 있으니 뷰포트가 한 줄씩 아래로 떠내려가 결국 바닥에 닿는다
        // (= 보고 싶던 위치를 잃는 버그). CircularList 는 maxLength 만큼 «포인터 배열» 만 선점하고
        // 실제 BufferLine 은 줄이 실제로 생길 때만 만들므로(나머지는 nil), 값이 커도 메모리는 실제
        // 출력량에 비례한다 — evict 를 현실 세션에서 사실상 없애 스크롤 위치를 안정적으로 유지한다.
        terminal.changeScrollback(50000)
        terminal.terminalDelegate = context.coordinator
        applyTerminalTheme(terminal, scheme: colorScheme)
        context.coordinator.appliedScheme = colorScheme
        terminal.font = .monospacedSystemFont(ofSize: fontSize, weight: .regular)
        terminal.inputAccessoryView = nil
        context.coordinator.bind(terminal: terminal, vm: vm)
        #if DEBUG
        // e2e (XCUITest) 전용 seam — SwiftTerm 은 커스텀 드로잉이라 XCUITest 가 글리프를
        // 못 읽는다. DEBUG 빌드에 한해 터미널을 단일 접근성 요소로 노출하고, 화면에 렌더된
        // 버퍼 텍스트를 accessibilityValue 로 돌려준다 (override 는 InteractiveTerminalView).
        // 릴리스(TestFlight/App Store) 바이너리엔 컴파일되지 않는다.
        terminal.accessibilityIdentifier = "ps.e2e.terminal"
        terminal.isAccessibilityElement = true
        #endif
        return terminal
    }

    func updateUIView(_ terminal: SwiftTerm.TerminalView, context: Context) {
        if terminal.font.pointSize != fontSize {
            terminal.font = .monospacedSystemFont(ofSize: fontSize, weight: .regular)
        }
        // 사용자가 설정에서 라이트/다크를 바꾸면 스킴이 바뀐 «그때만» 터미널 색을 다시 칠한다.
        if context.coordinator.appliedScheme != colorScheme {
            applyTerminalTheme(terminal, scheme: colorScheme)
            context.coordinator.appliedScheme = colorScheme
        }
        #if DEBUG
        PtyLog.shared.notice("[PTY-LAYOUT/UPDATE] bounds=\(terminal.bounds.width, privacy: .public)x\(terminal.bounds.height, privacy: .public)")
        #endif
    }

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    /// SwiftUI 가 이 representable 을 화면에서 영구 제거할 때(채팅방 pop 등) 호출한다.
    ///
    /// **반드시 필요** — SwiftTerm 의 TerminalView 는 `CADisplayLink(target: self)` 로 자기
    /// 자신을 강하게 retain 하는데 `deinit` 이 없다. 호스트가 `updateUiClosed()` 로 그 display
    /// link 를 invalidate 해 주지 않으면 터미널 뷰가 영영 해제되지 않고, 누수된 뷰의
    /// CADisplayLink 가 매 프레임 step()→updateDisplay() 를 계속 돌린다. 채팅방을 빠르게
    /// 들락거리면 누수된 터미널이 쌓여 메인 스레드(60fps × N개)·메모리를 잠식 → 워치독/메모리
    /// 크래시. 여기서 명시적으로 끊어 누수를 차단한다.
    static func dismantleUIView(_ terminal: SwiftTerm.TerminalView, coordinator: Coordinator) {
        terminal.updateUiClosed()
        MainActor.assumeIsolated { coordinator.teardown() }
    }

    @MainActor
    final class Coordinator: NSObject, SwiftTerm.TerminalViewDelegate {
        private weak var view: SwiftTerm.TerminalView?
        private weak var vm: ChatViewModel?

        /// feed batching — 매 chunk 마다 SwiftTerm.feed 호출하면 redraw 가 잦아 화면이
        /// "밀려 보이는" 깜빡거림 발생. 16ms 동안 도착한 bytes 를 모아 한 번에 feed.
        private var feedBuffer: [UInt8] = []
        private var feedFlushTask: Task<Void, Never>?

        /// 마지막으로 터미널에 적용한 라이트/다크 — updateUIView 가 매번 installColors 를 부르지
        /// 않도록(redraw 낭비) 스킴이 «바뀐 경우에만» 다시 칠한다.
        var appliedScheme: ColorScheme?

        func bind(terminal: SwiftTerm.TerminalView, vm: ChatViewModel) {
            self.view = terminal
            self.vm = vm
            PtyLog.shared.notice("[PTY-4/COORD] bind terminal bounds=\(terminal.bounds.width, privacy: .public)x\(terminal.bounds.height, privacy: .public)")

            vm.onPtyBytes = { [weak self] data in
                self?.enqueueFeed(data)
            }

            // 영문 모드 — SwiftTerm first responder 활성 요청 path. 토글 버튼이 호출.
            vm.requestTerminalFocusHook = { [weak self] in
                Task { @MainActor in
                    guard let v = self?.view as? InteractiveTerminalView else { return }
                    v.allowFirstResponder = true
                    _ = v.becomeFirstResponder()
                }
            }
            vm.resignTerminalFocusHook = { [weak self] in
                Task { @MainActor in self?.view?.resignFirstResponder() }
            }

            // In-session 검색 — SwiftTerm 의 내장 검색으로 현재 매치를 선택(하이라이트)한다.
            // 기본 옵션은 대소문자 무시(SearchOptions caseSensitive=false).
            // scrollToResult 는 «false» — SwiftTerm 의 scroll-to-match 는 macOS 의 yDisp
            // 스크롤백 모델이라 iOS 의 UIScrollView contentOffset 을 매치로 옮기지 못한다(오히려
            // updateScroller 가 bottom 으로 튕긴다). 그래서 드래그(선택)만 되고 스크롤이 안 됐다.
            // 실제 스크롤은 scrollToMatchHook 가 contentOffset 으로 직접 처리한다.
            vm.findNextHook = { [weak self] term in
                self?.view?.findNext(term, scrollToResult: false)
            }
            vm.findPreviousHook = { [weak self] term in
                self?.view?.findPrevious(term, scrollToResult: false)
            }
            vm.clearSearchHook = { [weak self] in
                self?.view?.clearSearch()
            }
            vm.countMatchesHook = { [weak self] term in
                self?.countMatches(term: term) ?? 0
            }
            vm.scrollToMatchHook = { [weak self] term, index in
                self?.scrollToMatch(term: term, index: index)
            }
        }

        /// 현재 터미널 버퍼(스크롤백 포함)에서 term 의 비중첩·대소문자무시 매치 수를 센다.
        /// SwiftTerm 의 SearchService.findAll 은 internal 이라 못 써서, 공개 API getBufferAsData 로
        /// 버퍼 전체 텍스트를 받아 줄 단위로 센다. SwiftTerm 검색 엔진과 동일하게 줄 경계에서
        /// 끊으므로(랩 경계를 가로지르는 드문 매치는 표시 수에서 1 어긋날 수 있으나, 내비게이션은
        /// 내장 검색이 모든 실제 매치를 순회하므로 영향 없음). Swift 의 .caseInsensitive 비교는
        /// 유니코드(한글 등)를 정상 처리한다.
        @MainActor
        private func countMatches(term: String) -> Int {
            guard let view = view, !term.isEmpty else { return 0 }
            let data = view.getTerminal().getBufferAsData()
            guard let text = String(data: data, encoding: .utf8) else { return 0 }
            var count = 0
            for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
                var from = line.startIndex
                while let r = line.range(of: term, options: .caseInsensitive, range: from ..< line.endIndex) {
                    count += 1
                    from = r.upperBound  // 비중첩 — 매치 끝부터 다시 탐색
                }
            }
            return count
        }

        /// term 의 index(0-base, 버퍼 위→아래 순)번째 매치가 보이도록 터미널(UIScrollView)을
        /// contentOffset 으로 직접 스크롤한다. getBufferAsData 는 버퍼 줄당 정확히 한 텍스트
        /// 줄(+\n)을 내므로 split 인덱스 == 버퍼 row → row 픽셀 위치 = row * cellHeight.
        /// 매치 row 를 뷰포트 중앙쯤에 오도록 두고 유효 스크롤 범위로 clamp. countMatches 와
        /// 같은 스캔을 쓰므로 표시 인덱스(findIndex)와 정합한다.
        @MainActor
        private func scrollToMatch(term: String, index: Int) {
            guard let view = view, !term.isEmpty, index >= 0 else { return }
            let data = view.getTerminal().getBufferAsData()
            guard let text = String(data: data, encoding: .utf8) else { return }
            let lines = text.split(separator: "\n", omittingEmptySubsequences: false)
            var seen = 0
            var matchRow: Int?
            var matchCol = 0
            outer: for (row, line) in lines.enumerated() {
                var from = line.startIndex
                while let r = line.range(of: term, options: .caseInsensitive, range: from ..< line.endIndex) {
                    if seen == index {
                        matchRow = row
                        matchCol = line.distance(from: line.startIndex, to: r.lowerBound)
                        break outer
                    }
                    seen += 1
                    from = r.upperBound
                }
            }
            guard let row = matchRow else { return }
            // getBufferAsData 는 모든 줄 뒤에 \n 을 붙이므로 split(omittingEmptySubsequences:false)
            // 마지막 원소는 트레일링 \n 에서 온 빈 문자열 → 버퍼 줄 수 = lines.count - 1.
            // (contentSize.height = 버퍼 줄 수 * cellHeight, updateScroller 와 일치.)
            let bufferLineCount = max(1, lines.count - 1)
            let contentH = view.contentSize.height
            let viewportH = view.bounds.height
            guard contentH > 0, viewportH > 0 else { return }
            let cellHeight = contentH / CGFloat(bufferLineCount)
            var targetY = CGFloat(row) * cellHeight - (viewportH - cellHeight) / 2
            let maxOffsetY = max(0, contentH - viewportH)
            targetY = min(max(0, targetY), maxOffsetY)
            view.setContentOffset(CGPoint(x: view.contentOffset.x, y: targetY), animated: true)

            // 가로 스크롤 — 터미널은 cols(120)를 전부 담는 «고정 너비» UIView 라서 가로 이동은
            // 자기 contentOffset.x 가 아니라 바깥 SwiftUI ScrollView(.horizontal) 의 백킹
            // UIScrollView 가 한다(터미널 frame 폭 == 콘텐츠 폭이라 내부 x 스크롤 여지가 없음).
            // superview 체인에서 그 스크롤뷰를 찾아, 매치 column 이 화면 밖일 때만 중앙쯤으로 옮긴다.
            let cols = view.getTerminal().getDims().cols
            guard cols > 0, view.frame.width > 0, let hScroll = enclosingScrollView(of: view) else { return }
            let cellWidth = view.frame.width / CGFloat(cols)
            let viewportW = hScroll.bounds.width
            guard viewportW > 0 else { return }
            let colX = CGFloat(matchCol) * cellWidth
            let curX = hScroll.contentOffset.x
            // 이미 보이는 범위 안이면 가로 위치를 흔들지 않는다(불필요한 점프 방지).
            guard colX < curX || colX + cellWidth > curX + viewportW else { return }
            var targetX = colX - (viewportW - cellWidth) / 2
            let maxOffsetX = max(0, hScroll.contentSize.width - viewportW)
            targetX = min(max(0, targetX), maxOffsetX)
            hScroll.setContentOffset(CGPoint(x: targetX, y: hScroll.contentOffset.y), animated: true)
        }

        /// `view` 를 감싸는 가장 가까운 «바깥» UIScrollView (view 자신 제외).
        /// 터미널을 wrap 한 SwiftUI ScrollView(.horizontal) 의 백킹 뷰로, 가로 스크롤이 여기서 난다.
        private func enclosingScrollView(of view: UIView) -> UIScrollView? {
            var node = view.superview
            while let cur = node {
                if let scroll = cur as? UIScrollView { return scroll }
                node = cur.superview
            }
            return nil
        }

        private func enqueueFeed(_ data: Data) {
            feedBuffer.append(contentsOf: data)
            #if DEBUG
            PtyLog.shared.notice("[PTY-5/COORD] enqueueFeed +\(data.count, privacy: .public) buf=\(self.feedBuffer.count, privacy: .public)")
            #endif
            feedFlushTask?.cancel()
            feedFlushTask = Task { [weak self] in
                try? await Task.sleep(nanoseconds: 16_000_000)
                guard !Task.isCancelled else { return }
                await MainActor.run { self?.flushFeed() }
            }
        }

        @MainActor
        private func flushFeed() {
            guard !feedBuffer.isEmpty, let view = view else {
                #if DEBUG
                PtyLog.shared.notice("[PTY-6/COORD] flushFeed SKIPPED buf_empty=\(self.feedBuffer.isEmpty ? "YES" : "NO", privacy: .public) view_nil=\(self.view == nil ? "YES" : "NO", privacy: .public)")
                #endif
                return
            }
            let chunk = feedBuffer
            feedBuffer.removeAll(keepingCapacity: true)

            // SwiftTerm.feed 는 새 데이터가 들어오면 contentOffset 을 자동으로 bottom 으로
            // 점프시키는 "follow output" 동작을 한다 (iOSTerminalView.swift 의 updateScroller).
            // 사용자가 위로 스크롤해 과거 내용을 보고 있는 중이면 이 점프가 흐름을 끊는다.
            // feed 직전에 사용자가 bottom 근처에 있었는지 기록하고, 아니었다면 feed 후 옛
            // contentOffset 으로 되돌려 위치를 유지한다.
            let oldOffset = view.contentOffset
            let threshold: CGFloat = view.bounds.height > 0
                ? max(32, view.bounds.height * 0.05)
                : 32
            let wasAtBottom =
                (oldOffset.y + view.bounds.height) >= (view.contentSize.height - threshold)

            #if DEBUG
            PtyLog.shared.notice("[PTY-6/COORD] feed \(chunk.count, privacy: .public) bytes → bounds=\(view.bounds.width, privacy: .public)x\(view.bounds.height, privacy: .public) offset=\(oldOffset.y, privacy: .public) contentSz=\(view.contentSize.width, privacy: .public)x\(view.contentSize.height, privacy: .public) wasAtBottom=\(wasAtBottom ? "YES" : "NO", privacy: .public)")
            #endif

            view.feed(byteArray: chunk[...])

            #if DEBUG
            PtyLog.shared.notice("[PTY-7/COORD] post-feed bounds=\(view.bounds.width, privacy: .public)x\(view.bounds.height, privacy: .public) contentSz=\(view.contentSize.width, privacy: .public)x\(view.contentSize.height, privacy: .public)")
            #endif

            if !wasAtBottom {
                // 사용자가 위로 스크롤해 과거 출력을 보던 중이면 위치를 유지한다. 단, 이번 feed 가
                // 화면 클리어(\e[2J) / 대체 화면 버퍼 전환(\e[?1049h) / 적은 줄로의 전체 리렌더
                // 처럼 contentSize 를 «줄이면», feed 전 oldOffset 은 새 콘텐츠 범위를 벗어난다.
                // 그대로 복원하면 스크롤이 빈 영역을 가리켜 출력이 «밀려/안 보이게» 되고, 다음
                // layout 변경(키보드 토글 → processSizeChange → updateScroller) 전까지 안 풀린다.
                // feed 후의 유효 범위 [0, contentSize.height - bounds.height] 로 clamp 해 차단한다.
                let maxOffsetY = max(0, view.contentSize.height - view.bounds.height)
                let clampedY = min(max(0, oldOffset.y), maxOffsetY)
                view.setContentOffset(CGPoint(x: oldOffset.x, y: clampedY), animated: false)
            }

            // 찾기 바가 열려 있으면(검색 중) 새 출력으로 매치 수가 달라질 수 있으니 ChatView 에
            // 재계산 신호를 보낸다. VM 이 검색 중일 때만 0.4s 스로틀로 버전을 올린다 — 평상시 no-op.
            vm?.noteTerminalContentChanged()
        }

        // MARK: TerminalViewDelegate

        func send(source: SwiftTerm.TerminalView, data: ArraySlice<UInt8>) {
            // 영문 키보드 시 매 keystroke 가 commitTextInput → 1:1 byte 직통 송신.
            // 한글 키보드 활성 상태로 SwiftTerm focus 가 잠시 유지되면 IME 의 「\x7f cycle」
            // multi-byte byte 가 흐를 수 있음 — ASCII (high-bit clear) 만 통과시켜 그
            // cycle 차단. 한글 입력은 inputBar TextField 의 줄 단위 송신 path 가 처리.
            let bytes = Data(data)
            guard !bytes.isEmpty, let vm = vm else { return }
            guard bytes.allSatisfy({ $0 < 0x80 }) else {
                #if DEBUG
                NSLog("[SwiftTerm.send] non-ASCII drop bytes=\(bytes.count) first=0x\(String(format: "%02x", bytes[0]))")
                #endif
                return
            }
            // SwiftTerm 이 에이전트의 capability/theme 질의(DA / kitty / OSC color)에 자동
            // 생성한 «응답» 바이트를 제거한다. 폰↔데몬 高지연 왕복 탓에 이 응답은 에이전트의
            // 질의 탐지 타임아웃을 넘겨 도착 → 일반 입력으로 취급되어 입력창에 박힌다
            // ([?0u[?65;...c11;rgb:0000/0000/0000 버그, qwen 등). 사람이 키보드로 칠 수 없는
            // 시퀀스라 드롭이 안전하고, 잃는 건 (어차피 高지연으로 실패하던) 터미널 자동
            // 협상뿐 — 에이전트는 기본값으로 정상 동작한다.
            let filtered = Coordinator.stripTerminalQueryResponses([UInt8](bytes))
            guard !filtered.isEmpty else {
                #if DEBUG
                NSLog("[SwiftTerm.send] terminal query-response drop bytes=\(bytes.count)")
                #endif
                return
            }
            vm.sendKeystroke(Data(filtered))
        }

        /// SwiftTerm 이 터미널 질의에 자동 회신하는 «응답» 시퀀스를 입력 스트림에서 걷어낸다.
        ///
        /// 드롭 대상 (사람이 칠 수 없고, stale 하게 도착해 입력창을 오염시키는 것만):
        ///  - Kitty keyboard 현재 플래그 응답  CSI ? flags u
        ///  - DA1/DA2/DA3 device attributes 응답  CSI [?>=] ... c
        ///  - OSC 10/11/12 색상 응답  OSC 1[012] ; ... (BEL | ST)
        ///
        /// 보존: 화살표(CSI A-D), 커서 위치 응답(CSI ... R), 상태(CSI 0 n), kitty «키» 인코딩
        /// (CSI <code> u — '?' 접두 없음), SGR(CSI ... m), bracketed paste(CSI ... ~) 등.
        static func stripTerminalQueryResponses(_ input: [UInt8]) -> [UInt8] {
            guard input.contains(0x1b) else { return input } // ESC 없으면 응답도 없음
            var out: [UInt8] = []
            out.reserveCapacity(input.count)
            var i = 0
            let n = input.count
            while i < n {
                let b = input[i]
                if b != 0x1b { out.append(b); i += 1; continue }
                if i + 1 < n, input[i + 1] == 0x5b { // ESC [  → CSI
                    var j = i + 2
                    let paramStart = j
                    while j < n, input[j] >= 0x30, input[j] <= 0x3f { j += 1 } // 파라미터 0-9 ; < = > ?
                    while j < n, input[j] >= 0x20, input[j] <= 0x2f { j += 1 } // intermediate
                    guard j < n else { out.append(contentsOf: input[i ..< n]); break } // 미완 — 보존
                    let finalByte = input[j]
                    let firstParam: UInt8 = paramStart < j ? input[paramStart] : 0
                    let firstIsQ = firstParam == 0x3f                       // '?'
                    let hasPrivate = firstIsQ || firstParam == 0x3e || firstParam == 0x3d // ? > =
                    let isDAResponse = finalByte == 0x63 && hasPrivate      // CSI [?>=] ... c
                    let isKittyFlags = finalByte == 0x75 && firstIsQ        // CSI ? ... u
                    if isDAResponse || isKittyFlags { i = j + 1; continue } // 전체 CSI 드롭
                    out.append(contentsOf: input[i ... j])                  // 그 외 CSI 보존
                    i = j + 1
                    continue
                } else if i + 1 < n, input[i + 1] == 0x5d { // ESC ]  → OSC
                    var j = i + 2
                    var afterEnd = -1
                    while j < n { // 종결자 BEL(0x07) 또는 ST(ESC \) 까지
                        if input[j] == 0x07 { afterEnd = j + 1; break }
                        if input[j] == 0x1b, j + 1 < n, input[j + 1] == 0x5c { afterEnd = j + 2; break }
                        j += 1
                    }
                    guard afterEnd >= 0 else { out.append(contentsOf: input[i ..< n]); break } // 미완 — 보존
                    let b0: UInt8 = i + 2 < n ? input[i + 2] : 0
                    let b1: UInt8 = i + 3 < n ? input[i + 3] : 0
                    let b2: UInt8 = i + 4 < n ? input[i + 4] : 0
                    let isColor = b0 == 0x31 && (b1 == 0x30 || b1 == 0x31 || b1 == 0x32) && b2 == 0x3b // "1[012];"
                    if isColor { i = afterEnd; continue }                   // 색상 응답 드롭
                    out.append(contentsOf: input[i ..< afterEnd])           // 그 외 OSC 보존
                    i = afterEnd
                    continue
                } else { // ESC O ... / 단독 ESC 등 — 보존
                    out.append(b); i += 1; continue
                }
            }
            return out
        }

        func sizeChanged(source: SwiftTerm.TerminalView, newCols: Int, newRows: Int) {
            // claude REPL 의 가상 터미널을 모바일 폭에 맞춰 같은 cols/rows 로 동기화.
            Task { [weak vm] in
                await vm?.sendPtyResize(cols: newCols, rows: newRows)
            }
        }

        func setTerminalTitle(source: SwiftTerm.TerminalView, title: String) {}
        func hostCurrentDirectoryUpdate(source: SwiftTerm.TerminalView, directory: String?) {}
        func scrolled(source: SwiftTerm.TerminalView, position: Double) {}
        func requestOpenLink(source: SwiftTerm.TerminalView, link: String, params: [String: String]) {}
        func bell(source: SwiftTerm.TerminalView) {}
        func clipboardCopy(source: SwiftTerm.TerminalView, content: Data) {
            UIPasteboard.general.string = String(data: content, encoding: .utf8)
        }
        func clipboardRead(source: SwiftTerm.TerminalView) -> Data? { nil }
        func iTermContent(source: SwiftTerm.TerminalView, content: ArraySlice<UInt8>) {}
        func rangeChanged(source: SwiftTerm.TerminalView, startY: Int, endY: Int) {}

        /// PtyTerminalView.dismantleUIView 에서 호출 — 보류 중 feed flush 취소 + vm 의 hook
        /// 해제 + 약참조 정리. SwiftTerm 의 CADisplayLink 자체는 dismantleUIView 가
        /// terminal.updateUiClosed() 로 끊는다 (그게 진짜 누수 차단점). 여기선 죽어 가는
        /// 터미널에 더 이상 byte 를 흘리지 않도록 hook 을 떼고 잔여 Task 를 정리한다.
        func teardown() {
            feedFlushTask?.cancel()
            feedFlushTask = nil
            vm?.onPtyBytes = nil
            vm?.requestTerminalFocusHook = nil
            vm?.resignTerminalFocusHook = nil
            vm?.findNextHook = nil
            vm?.findPreviousHook = nil
            vm?.clearSearchHook = nil
            vm?.countMatchesHook = nil
            vm?.scrollToMatchHook = nil
            vm = nil
            view = nil
        }
    }
}

final class InteractiveTerminalView: SwiftTerm.TerminalView {
    // 사용자 tap 으로 자동 first responder 되는 동작 차단 — 키보드 토글 버튼이 명시
    // 활성해야만 first responder 가 된다 (일관성). 토글 버튼이 호출 직전에
    // `allowFirstResponder = true` 설정 + `becomeFirstResponder()` 호출.
    var allowFirstResponder: Bool = false

    override var canBecomeFirstResponder: Bool { allowFirstResponder }

    override func becomeFirstResponder() -> Bool {
        guard allowFirstResponder else { return false }
        return super.becomeFirstResponder()
    }

    override func resignFirstResponder() -> Bool {
        let ok = super.resignFirstResponder()
        // resign 후 자동 활성 막기 — 토글 버튼 다시 누를 때까지 차단.
        allowFirstResponder = false
        return ok
    }

    #if DEBUG
    // e2e (XCUITest) 전용 — 화면에 렌더된 터미널 버퍼(보이는 행들)를 문자열로 반환.
    // XCUITest 는 이 view 의 `value` 로 이 텍스트를 읽어 daemon 의 실제 PTY 출력이
    // iOS 화면에 반영됐는지 assert 한다. SwiftTerm 의 공개 API (getTerminal / getLine /
    // translateToString) 만 사용 — 내부 상태에 손대지 않는다. DEBUG 한정.
    override var accessibilityValue: String? {
        get { e2eVisibleTerminalText() }
        set { /* no-op — 버퍼에서 파생되는 read-only 값 */ }
    }

    private func e2eVisibleTerminalText() -> String {
        let t = getTerminal()
        var lines: [String] = []
        for row in 0..<t.rows {
            if let line = t.getLine(row: row) {
                lines.append(line.translateToString(trimRight: true))
            }
        }
        return lines.joined(separator: "\n")
    }
    #endif
}


extension UIResponder {
    /// 현재 활성 first responder. iOS 에는 직접 API 가 없어 sendAction trick 으로 찾는다.
    /// 호출 즉시 sentinel 에 자기 자신을 박는 selector 를 sendAction(_:to:nil) 으로 broadcast —
    /// to nil 이면 responder chain 의 first responder 한 명만 수신.
    static var ks_currentFirstResponder: UIResponder? {
        _ks_first = nil
        UIApplication.shared.sendAction(#selector(UIResponder._ks_findFirst(_:)), to: nil, from: nil, for: nil)
        return _ks_first
    }

    private static weak var _ks_first: UIResponder?

    @objc func _ks_findFirst(_ sender: Any?) {
        UIResponder._ks_first = self
    }
}


// MARK: - PromptLibrary (스니펫 + 최근 프롬프트)

/// 프롬프트 보관함 영속화 — UserDefaults (ChatDraftStore 와 같은 패턴, 기기 로컬).
///
/// 모바일 키보드로 긴 지시를 매번 다시 치는 비용이 «짧고 모호한 프롬프트 → 빗나간 턴 →
/// 개입 횟수 증가» 로 돌아오는 약한고리를 줄인다:
///  - snippets: 사용자가 직접 저장하는 «자주 쓰는 지시». 순서 = 추가 역순(최신 위).
///  - recents: 전송 버튼으로 보낸 프롬프트 자동 적재 (전 세션 공용, 최대 20, 중복은 맨 앞으로).
///    첨부/파일참조/리뷰 요약 같은 «합성» 프롬프트는 적재하지 않는다 — 본문이 길고 재사용
///    가치가 낮아 노이즈.
enum PromptLibraryStore {
    private static let snippetsKey = "prompt.library.snippets"
    private static let recentsKey = "prompt.library.recents"
    private static let recentsCap = 20

    static func loadSnippets() -> [String] {
        UserDefaults.standard.stringArray(forKey: snippetsKey) ?? []
    }

    static func addSnippet(_ text: String) {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        var list = loadSnippets()
        list.removeAll { $0 == t }  // 중복 추가 = 맨 앞으로 끌어올리기
        list.insert(t, at: 0)
        UserDefaults.standard.set(list, forKey: snippetsKey)
    }

    static func removeSnippet(_ text: String) {
        var list = loadSnippets()
        list.removeAll { $0 == text }
        UserDefaults.standard.set(list, forKey: snippetsKey)
    }

    /// 순서 변경(드래그) 결과를 그대로 영속화 — addSnippet 과 달리 맨 앞으로 끌어올리지 않는다.
    static func setSnippets(_ list: [String]) {
        UserDefaults.standard.set(list, forKey: snippetsKey)
    }

    /// 스니펫을 «제자리»에서 수정한다(편집). 빈 값이면 삭제. 수정 결과가 다른 항목과 같아지면
    /// 첫 항목만 남기고 중복 제거. addSnippet 과 달리 위치를 유지한다.
    static func updateSnippet(old: String, new: String) {
        let n = new.trimmingCharacters(in: .whitespacesAndNewlines)
        var list = loadSnippets()
        guard let idx = list.firstIndex(of: old) else {
            if !n.isEmpty { addSnippet(n) }
            return
        }
        if n.isEmpty {
            list.remove(at: idx)
        } else {
            list[idx] = n
            var seen = Set<String>()
            list = list.filter { seen.insert($0).inserted }  // 첫 등장만 유지(중복 제거)
        }
        UserDefaults.standard.set(list, forKey: snippetsKey)
    }

    static func loadRecents() -> [String] {
        UserDefaults.standard.stringArray(forKey: recentsKey) ?? []
    }

    static func clearRecents() {
        UserDefaults.standard.removeObject(forKey: recentsKey)
    }

    static func recordRecent(_ text: String) {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        var list = loadRecents()
        list.removeAll { $0 == t }
        list.insert(t, at: 0)
        if list.count > recentsCap { list.removeLast(list.count - recentsCap) }
        UserDefaults.standard.set(list, forKey: recentsKey)
    }
}

/// 프롬프트 보관함 시트 — 스니펫/최근 프롬프트를 탭해 입력창에 «채우»거나, 스와이프로 «바로 전송».
/// 검색으로 즉시 필터, 스니펫은 편집·순서변경(드래그)·삭제, 지금 입력 중인 초안을 곧장 스니펫으로
/// 저장, 최근은 길게 눌러 스니펫 승격 + 전체 비우기.
struct PromptLibrarySheet: View {
    /// 지금 입력창에 작성 중인 초안 — 비어 있지 않으면 «스니펫으로 저장» 단축을 띄운다.
    let currentDraft: String
    /// 선택 시 호출 — ChatView 가 입력창에 채우고 포커스를 준다. 시트는 스스로 닫는다.
    let onPick: (String) -> Void
    /// «바로 전송» — 입력창을 거치지 않고 그대로 보낸다. 시트는 스스로 닫는다.
    let onSend: (String) -> Void

    @Environment(\.dismiss) private var dismiss
    @Environment(\.editMode) private var editMode
    @State private var snippets = PromptLibraryStore.loadSnippets()
    @State private var recents = PromptLibraryStore.loadRecents()
    @State private var newSnippet = ""
    @State private var query = ""
    /// 편집 중인 스니펫(원본) — non-nil 이면 편집 시트를 띄운다.
    @State private var editTarget: EditTarget?
    @State private var confirmClearRecents = false

    private struct EditTarget: Identifiable {
        let id = UUID()
        let original: String
    }

    private var filteredSnippets: [String] {
        query.isEmpty ? snippets : snippets.filter { $0.localizedCaseInsensitiveContains(query) }
    }

    private var filteredRecents: [String] {
        query.isEmpty ? recents : recents.filter { $0.localizedCaseInsensitiveContains(query) }
    }

    var body: some View {
        NavigationStack {
            List {
                snippetSection
                recentSection
            }
            .searchable(text: $query, prompt: Text("프롬프트 검색"))
            .navigationTitle("프롬프트 보관함")
            .navigationBarTitleDisplayMode(.inline)
            .voiceDictationChrome()
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    // 스니펫이 둘 이상일 때만 — 순서변경/일괄 삭제 진입. (검색 중엔 순서가 부분집합
                    // 이라 의미 없어 EditButton 을 숨긴다.)
                    if snippets.count > 1 && query.isEmpty {
                        EditButton()
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("닫기") { dismiss() }
                }
            }
            .sheet(item: $editTarget) { target in
                editSheet(for: target.original)
            }
            .confirmationDialog(
                "최근 기록을 비울까요?",
                isPresented: $confirmClearRecents,
                titleVisibility: .visible,
            ) {
                Button("최근 비우기", role: .destructive) {
                    PromptLibraryStore.clearRecents()
                    recents = []
                }
                Button("취소", role: .cancel) {}
            }
        }
    }

    // MARK: - 섹션

    @ViewBuilder private var snippetSection: some View {
        Section("내 스니펫") {
            // 새 스니펫 직접 추가.
            HStack(spacing: 8) {
                VoiceInputField("자주 쓰는 지시를 저장해 두세요", text: $newSnippet, lineLimit: 1...3)
                Button {
                    PromptLibraryStore.addSnippet(newSnippet)
                    newSnippet = ""
                    snippets = PromptLibraryStore.loadSnippets()
                } label: {
                    Image(systemName: "plus.circle.fill")
                }
                .disabled(newSnippet.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .accessibilityLabel("스니펫 추가")
            }
            // 지금 입력창에 쓰던 초안을 한 번에 스니펫으로 — 다시 타이핑할 필요 없이 저장.
            if !currentDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
               !snippets.contains(currentDraft)
            {
                Button {
                    PromptLibraryStore.addSnippet(currentDraft)
                    snippets = PromptLibraryStore.loadSnippets()
                } label: {
                    Label("지금 입력한 내용을 스니펫으로 저장", systemImage: "square.and.arrow.down")
                }
            }
            if snippets.isEmpty {
                Text("저장된 스니펫이 없어요. 위 칸에 적어 추가해요.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else if filteredSnippets.isEmpty {
                Text("검색 결과가 없어요.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            ForEach(filteredSnippets, id: \.self) { s in
                promptRow(s, saveAsSnippet: false)
            }
            .onDelete { offsets in
                for s in offsets.map({ filteredSnippets[$0] }) { PromptLibraryStore.removeSnippet(s) }
                snippets = PromptLibraryStore.loadSnippets()
            }
            // 순서 변경은 검색하지 않을 때만(부분집합 재정렬 모호 방지) — filteredSnippets == snippets.
            .onMove(perform: query.isEmpty ? moveSnippet : nil)
        }
    }

    @ViewBuilder private var recentSection: some View {
        Section {
            if recents.isEmpty {
                Text("전송한 프롬프트가 여기 쌓여요.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else if filteredRecents.isEmpty {
                Text("검색 결과가 없어요.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            ForEach(filteredRecents, id: \.self) { r in
                promptRow(r, saveAsSnippet: true)
            }
        } header: {
            HStack {
                Text("최근 보낸 프롬프트")
                Spacer()
                if !recents.isEmpty {
                    Button("비우기") { confirmClearRecents = true }
                        .font(.caption)
                        .textCase(nil)
                }
            }
        }
    }

    /// 스니펫/최근 공통 행 — 탭: 채우기, 좌 스와이프: 바로 전송. 길게: 편집/저장/전송 메뉴.
    /// saveAsSnippet=true(최근)면 메뉴에 «스니펫으로 저장», false(스니펫)면 «편집» 을 둔다.
    @ViewBuilder private func promptRow(_ text: String, saveAsSnippet: Bool) -> some View {
        Button {
            onPick(text)
            dismiss()
        } label: {
            Text(verbatim: text)
                .lineLimit(3)
                .foregroundStyle(Color.primary)
        }
        .swipeActions(edge: .leading, allowsFullSwipe: true) {
            Button {
                onSend(text)
                dismiss()
            } label: {
                Label("전송", systemImage: "paperplane.fill")
            }
            .tint(Theme.accent)
        }
        .contextMenu {
            Button {
                onSend(text)
                dismiss()
            } label: {
                Label("바로 전송", systemImage: "paperplane")
            }
            if saveAsSnippet {
                Button {
                    PromptLibraryStore.addSnippet(text)
                    snippets = PromptLibraryStore.loadSnippets()
                } label: {
                    Label("스니펫으로 저장", systemImage: "bookmark")
                }
            } else {
                Button {
                    editTarget = EditTarget(original: text)
                } label: {
                    Label("편집", systemImage: "pencil")
                }
                Button(role: .destructive) {
                    PromptLibraryStore.removeSnippet(text)
                    snippets = PromptLibraryStore.loadSnippets()
                } label: {
                    Label("삭제", systemImage: "trash")
                }
            }
        }
    }

    // MARK: - 편집 시트

    private func editSheet(for original: String) -> some View {
        NavigationStack {
            // 별도 @State 대신 로컬 바인딩을 쓰면 시트 재생성 시 초기화 — 편집 텍스트는 자식 뷰가 보유.
            SnippetEditor(initial: original) { newText in
                PromptLibraryStore.updateSnippet(old: original, new: newText)
                snippets = PromptLibraryStore.loadSnippets()
                editTarget = nil
            } onCancel: {
                editTarget = nil
            }
        }
    }

    private func moveSnippet(_ offsets: IndexSet, _ destination: Int) {
        snippets.move(fromOffsets: offsets, toOffset: destination)
        PromptLibraryStore.setSnippets(snippets)
    }
}

/// 스니펫 편집기 — 멀티라인 텍스트를 수정해 저장/취소. 편집 텍스트를 자체 보유해
/// (부모 시트의 재생성과 무관) 입력 도중 리셋되지 않는다.
private struct SnippetEditor: View {
    let initial: String
    let onSave: (String) -> Void
    let onCancel: () -> Void

    @State private var text: String

    init(initial: String, onSave: @escaping (String) -> Void, onCancel: @escaping () -> Void) {
        self.initial = initial
        self.onSave = onSave
        self.onCancel = onCancel
        _text = State(initialValue: initial)
    }

    var body: some View {
        Form {
            Section("스니펫") {
                VoiceInputField("스니펫", text: $text, lineLimit: 3...10)
            }
        }
        .navigationTitle("스니펫 편집")
        .navigationBarTitleDisplayMode(.inline)
        .voiceDictationChrome()
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("취소") { onCancel() }
            }
            ToolbarItem(placement: .confirmationAction) {
                Button("저장") { onSave(text) }
                    .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
    }
}
