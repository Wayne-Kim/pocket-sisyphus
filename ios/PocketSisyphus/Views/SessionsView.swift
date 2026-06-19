import SwiftUI
import StoreKit  // @Environment(\.requestReview) — _StoreKit_SwiftUI overlay 는 두 import 가 다 있을 때 보인다.

struct SessionsView: View {
    /// 세션 생성 성공 «직후» 충성 사용자에게 1회 리뷰 요청(ReviewPrompt 가 gate 판정).
    @Environment(\.requestReview) private var requestReview
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var tor: TorManager
    @EnvironmentObject var conn: ConnectionManager
    @EnvironmentObject var inflight: InFlightTracker
    @EnvironmentObject var lifecycle: AppLifecycle
    /// 프로(주황) 기능 게이트 — 예약 작업·모니터 미러링은 프로 전용. 미보유 시 페이월 시트.
    @EnvironmentObject var purchase: PurchaseStore
    /// 디스크 캐시 + 단일 source of truth. SessionsView 는 자체 `@State sessions` 를 들지
    /// 않고 cache 의 `@Published sessions` 만 본다 — 앱 콜드 진입 시 첫 페인트가 즉시 그려지고,
    /// prewarm 이 미리 받아 둔 fresh data 가 푸시될 때 자동 갱신.
    @EnvironmentObject var sessionCache: SessionListCache
    /// 딥링크(pocketsisyphus://session/<id>) 진입 broker. pendingSessionId 가 세팅되면
    /// 목록에서 매칭되는 세션을 찾아 openSession 으로 그 채팅방을 연다(교체).
    @EnvironmentObject var deepLink: DeepLinkRouter
    /// 지금 선택된 메인 탭 — 채팅방의 탭 바 숨김을 «세션 탭이 활성일 때만» 걸기 위함(아래
    /// navigationDestination 참고). 딥링크로 다른 탭 전환 시 탭 바가 사라진 채 갇히는 누출 방지.
    @Environment(\.activeMainTab) private var activeMainTab

    /// 딥링크 매칭 실패 시 단 한 번만 reload 를 시도하기 위한 가드 — 그 session id 로 이미
    /// reload 했는지 기억한다. 없는 세션(삭제/다른 Mac)으로 무한 reload 도는 것 방지.
    @State private var deepLinkReloadedFor: String?

    @State private var loading = false
    @State private var error: String?
    @State private var showNew = false
    // 이름 변경 alert — 어떤 세션을 편집 중인지 + 입력 중인 새 이름.
    @State private var renameTarget: SessionSummary?
    @State private var renameDraft: String = ""
    // 설정 시트 — 좌상단 「설정」 버튼이 여는 통합 설정 화면. 이전엔 드롭다운 Menu 였는데
    // 항목이 늘어 SettingsSheet (그룹 List) 로 통합. «설정 가능한 것» (언어 / 가로 모드 /
    // Mac 업데이트 / 페어링 해제 / 버전) 만 담는다. 도움말은 안내 문서라 설정 밖 별도 버튼.
    @State private var showSettings = false
    // 구독/구매(IAP) 진입 — 좌상단 도움말 옆 왕관 버튼이 여는 PaywallView. 프로 기능 «탭 시»
    // 게이트(paywallFeature)와 달리, 보유 여부와 무관하게 «상품 보기/구매» 로 직접 가는 버튼이다.
    @State private var showPurchase = false
    // Mac 데스크톱 라이브 보기 풀스크린 — 세션 무관(우상단 「display」 버튼).
    @State private var showDesktop = false
    // 페어된 Mac daemon 의 capability 집합 — 자동화 탭(workflow_v1·cron_v1)·모니터 미러링
    // (screen_capture_v1) soft-gate 용. reload 사이클이 /api/version 에서 같이 들고 온다.
    // MainTabView 가 자동화 탭 노출·세그먼트 구성을 같은 값으로 판단하도록 @Binding 으로 끌어올려
    // 공유한다(중복 fetch 방지).
    @Binding var capabilities: [String]
    /// 현재 열려 있는 채팅방의 세션 — nil 이면 세션 목록. NavigationPath 대신 «단일 optional +
    /// navigationDestination(item:)» 로 채팅방을 구동한다: (1) 딥링크로 값이 다른 세션이 들어오면
    /// item 의 identity 변경을 NavigationStack 이 감지해 기존 방을 pop 후 새 세션을 push(교체)
    /// 한다 — 같은 깊이 path 값 교체([A]→[B])가 무시돼 «기존 방이 그대로 유지» 되던 딥링크 재인입
    /// 버그를 푼다. (2) 채팅방은 언제나 최대 하나만 떠 있어 여러 방이 스택으로 쌓이지 않는다.
    @State private var openSession: SessionSummary?
    /// 프로 전용 기능(예약·미러링)을 미보유 사용자가 누르면 띄우는 페이월. non-nil = 어떤
    /// ProFeature 가 trigger 했는지. `.proPaywall(item:)` 가 PaywallView 시트로 띄운다.
    @State private var paywallFeature: ProFeature?

    /// SessionsView 본문에서 자주 읽히는 캐시 sessions 의 단축 alias. `@Published` 의존성은
    /// SwiftUI 가 sessionCache 접근으로 추적하므로 computed property 라도 정상 갱신된다.
    private var sessions: [SessionSummary] { sessionCache.sessions }

    /// 활성 «로컬 추론» 세션이 이미 있는지 — 새 세션 시트의 「최대 1개」 제약에 쓴다. local_llm
    /// (Qwen Code) 과 opencode 는 같은 llama-server 를 공유해 군을 통틀어 동시 하나만 허용한다
    /// (daemon 이 진실의 원천, 여기선 사용자가 시도 전에 막아 친절한 안내).
    private var localLlmActive: Bool {
        sessions.contains {
            ($0.agent == "local_llm" || $0.agent == "opencode") && $0.status == "active"
        }
    }

    /// 세션 목록 필터 — 내 세션(수동 생성) vs 워크플로우가 만든 세션. 둘을 «구분해서» 볼 수 있게
    /// 세그먼트로 전환한다. 기본은 내 세션(섞여 보이지 않게).
    @State private var sessionFilter: SessionFilter = .manual
    enum SessionFilter: Hashable { case manual, workflow }

    /// 상태 세그먼트 — 이 화면을 «평면 목록» 에서 «오케스트레이션 뷰» 로 바꾸는 축. 병렬
    /// 세션 팀을 실행중/대기/완료로 갈라 «지금 어디부터 봐야 하나» 를 한눈에 답한다. 기본은
    /// 전체(그룹 헤더로 각 상태 개수 + 대기→실행중→완료 순으로 묶어 보여 준다).
    @State private var statusFilter: StatusFilter = .all
    enum StatusFilter: Hashable { case all, running, waiting, done }

    /// 그룹핑 축 — «상태별»(대기/실행중/완료, 기존 기본) vs «레포별»(repo_path). 세션이 여러
    /// 레포에 흩어져 쌓이면 «이 레포의 작업» 을 한 묶음으로 보는 게 빠르다. 상태 세그먼트(필터)와
    /// 직교: 레포별이어도 statusFilter 로 좁힌 «보이는» 세션을 레포로 다시 묶는다. 「보기」 메뉴에서 전환.
    @State private var grouping: SessionGrouping = .status
    enum SessionGrouping: Hashable { case status, repo }

    /// «보관함» 모드 — true 면 화면이 보관된 세션 목록으로 바뀐다 (활성 목록과 분리). 활성 목록
    /// (sessionCache)은 미보관만 들고, 보관분은 이 모드에서 lazy 로 따로 받는다(listArchivedSessions)
    /// — 보관 세션이 100 캡을 잠식해 활성 목록을 가리지 않게 하는 핵심 분리. session_archive_v1
    /// capability 없는 옛 daemon 에선 진입점(「보기」 메뉴 토글) 자체를 숨긴다.
    @State private var showingArchived = false
    /// 보관함 세션 — showingArchived 진입 시 받아 채운다. 활성 목록과 별도 상태(캐시 미사용 — 보관함은
    /// 자주 안 열고, 열 때마다 최신을 받는 게 단순·정확).
    @State private var archivedSessions: [SessionSummary] = []
    /// 보관함 로딩 중 — skeleton 표시 게이트. 활성 목록 loading 과 분리.
    @State private var archivedLoading = false
    /// 보관함을 한 번이라도 받아왔는지 — 「불러오는 중」(첫 진입 전)과 「보관 0건」(받았으나 빔)을 가른다.
    @State private var archivedLoaded = false

    /// 그룹 헤더 일괄 액션의 확인 대기 상태 — «모두 중지»/«정리» 를 누르면 세팅돼
    /// confirmationDialog 가 «N건» 안내와 함께 뜬다 (실수 탭 방지 + 대상 개수 명시). nil 이면 닫힘.
    /// (대기→«모두 승인» 은 단순 확인 대신 컨텍스트 미리보기 시트(showApprovalReview)로 대체됐다.)
    @State private var pendingBulkAction: BulkAction?
    /// 그룹 일괄 액션 한 건 — 종류(중지/정리) + 대상 세션들. 실행중→stop(ESC), 완료→delete(파괴적).
    /// id 는 종류+개수로 충분 (다이얼로그 1개만 동시 존재).
    struct BulkAction: Identifiable {
        enum Kind { case stop, delete }
        let kind: Kind
        let targets: [SessionSummary]
        var id: String {
            let k: String
            switch kind {
            case .stop: k = "stop"
            case .delete: k = "delete"
            }
            return "\(k)-\(targets.count)"
        }
    }

    /// 대기 중인 승인 요청을 «무엇을 바꾸려는가»(보류 prompt 요약 + diff 요약 + 레포)와 함께 한
    /// 시트에 나열하고, 개별 토글 후 «선택 승인»/«전체 승인»/개별 «거절» 을 처리한다 (블라인드
    /// 결재 완화). 그룹 헤더 «모두 승인»·대기 배너·대기 필터 헤더가 이 시트를 띄운다. pty 일괄
    /// 제어(bulk_session_actions_v1) capability 가 있을 때만 진입점을 노출한다.
    @State private var showApprovalReview = false

    /// 한 «대기» 세션 행의 트레일링 «검토» 빠른 동작이 띄우는 승인 검토 시트의 대상 — 그룹/배너의
    /// «전체» 검토(showApprovalReview)와 달리 그 세션 «하나» 만 시트에 담아 바로 그 요청을 본다.
    /// non-nil = 그 세션을 검토 중. pty 일괄(bulk_session_actions_v1) capability 있을 때만 진입점 노출.
    @State private var rowReviewSession: SessionSummary?

    /// daemon 이 일괄 제어(POST /pty/control)를 지원하는지 — 그룹 헤더 일괄 버튼 노출 게이트.
    /// 없으면(옛 daemon) 버튼을 숨겨 거짓 UI 를 막는다 (라우트 404 회피). reload 가 채우는 capabilities.
    private var bulkActionsSupported: Bool { capabilities.contains("bulk_session_actions_v1") }

    /// daemon 이 세션 «보관» 을 지원하는지 — 스와이프 보관·그룹 일괄 보관·「보관함」 진입점 게이트.
    /// 없으면(옛 daemon = archived 컬럼/`/bulk` 라우트 없음) 보관 관련 UI 를 통째로 숨겨 거짓 UI 를
    /// 막는다. reload 가 채우는 capabilities (session_archive_v1).
    private var archiveSupported: Bool { capabilities.contains("session_archive_v1") }

    /// 각 카드의 «변경 파일 수» lazy 캐시 — 목록 응답엔 없어 카드가 보일 때 그 세션만 받는다.
    /// 보이는 만큼만 + 1회 캐시라 Tor 비용이 목록 크기에 비례하지 않는다(모바일 친화).
    @StateObject private var changeCounts = SessionChangeCounts()

    /// 세션 목록 상단 검색어 — 제목 + repo_path 부분일치(대소문자 무시)로 «며칠 전 그 레포의
    /// 그 작업» 세션을 스크롤 없이 즉시 좁힌다. 클라이언트측 필터(서버 검색 API 없음)라 세션이
    /// 무한히 쌓여도 동작한다. 워크플로우/수동 필터와 AND 결합. @State 라 목록이 비동기로
    /// 갱신돼도(reload) 검색어는 그대로 유지된다.
    @State private var searchText = ""

    /// 검색 바 포커스 — 음성 받아쓰기 삽입 후 입력란에 포커스를 돌려주려고 VoiceInputField 에
    /// 넘긴다(`.searchable` 대신 커스텀 바로 바꾼 이유 = 돋보기 옆에 받아쓰기 마이크를 붙이기 위함).
    @FocusState private var isSearchFocused: Bool

    /// 워크플로우가 만든 세션이 하나라도 있을 때만 필터 세그먼트를 노출 (워크플로우 안 쓰는
    /// 사용자에겐 군더더기 안 보이게).
    private var hasWorkflowSessions: Bool { sessions.contains { $0.isWorkflowSession } }

    /// 검색어를 다듬은 형태(앞뒤 공백 제거 + 소문자) — 빈 문자열이면 «검색 안 함». 빈 결과
    /// 안내를 「검색 0건」 과 「세션 없음」 으로 가르는 데도 쓴다. NewSessionSheet 의 recents
    /// 필터(`filter.trimmingCharacters(in:).lowercased()`)와 같은 정규화로 매칭을 일관시킨다.
    private var normalizedSearch: String {
        searchText.trimmingCharacters(in: .whitespaces).lowercased()
    }

    /// 검색어로 세션을 좁힌다 — 제목 + repo_path 부분일치(대소문자 무시). 빈 검색어면 그대로
    /// 반환(전체 복원). recents 필터와 같은 `lowercased().contains` 매칭이라 한/일 등 CJK
    /// 부분일치도 동일하게 동작한다(대소문자 없는 문자는 lowercased 가 그대로 둠). repo_path 는
    /// 표시에선 truncation 되지만 매칭은 전체 경로를 본다.
    private func matchesSearch(_ s: SessionSummary) -> Bool {
        let q = normalizedSearch
        guard !q.isEmpty else { return true }
        if let title = s.title, title.lowercased().contains(q) { return true }
        return s.repo_path.lowercased().contains(q)
    }

    /// 워크플로우/검색 필터까지만 적용한 목록 — 상태 그룹핑·세그먼트의 «원본». 딥링크 매칭/
    /// 로컬LLM 체크는 전체 `sessions` 를 그대로 본다.
    private var filteredSessions: [SessionSummary] {
        var filtered: [SessionSummary]
        if !hasWorkflowSessions {
            // 워크플로우 세션이 없으면 필터와 무관하게 전부(=내 세션)만 있으니 단순 반환.
            filtered = sessions
        } else {
            switch sessionFilter {
            case .manual: filtered = sessions.filter { !$0.isWorkflowSession }
            case .workflow: filtered = sessions.filter { $0.isWorkflowSession }
            }
        }
        // 상단 검색어로 한 번 더 좁힌다 — 워크플로우/수동 필터와 AND 결합. 빈 검색어면 전체 복원.
        return filtered.filter(matchesSearch)
    }

    /// 한 상태의 세션 — 서버 순서(최신순) 유지. runState 가 기존 신호(waiting_since·ended_at·
    /// status)에서 파생하므로 상태 판정을 여기서 중복 구현하지 않는다.
    private func sessions(in state: SessionRunState) -> [SessionSummary] {
        filteredSessions.filter { $0.runState == state }
    }

    /// 그룹/정렬 순서 — 대기(triage 1순위) → 실행중 → 완료. 빈 그룹은 렌더 시 건너뛴다.
    private static let groupOrder: [SessionRunState] = [.waiting, .running, .done]

    /// 현재 상태 세그먼트로 «실제로 보이는» 세션 (빈 상태 판정·갱신 대상 id 수집용).
    private var statusVisibleSessions: [SessionSummary] {
        switch statusFilter {
        case .all: return Self.groupOrder.flatMap { sessions(in: $0) }
        case .running: return sessions(in: .running)
        case .waiting: return sessions(in: .waiting)
        case .done: return sessions(in: .done)
        }
    }

    /// 빈 상태 안내 — 첫 로딩 skeleton / 검색 0건 / 상태 필터 0건 / 워크플로우 안내 / 세션 없음.
    @ViewBuilder
    private var emptyStateRows: some View {
        if loading && sessions.isEmpty {
            // 첫 로딩 — Tor 위 첫 호출이 5~15s 걸릴 수 있어 빈 화면 + 가운데 spinner 만 보이면
            // "앱이 멈췄나" 인상. skeleton row 로 콘텐츠가 도착할 자리를 미리 보여 준다.
            ForEach(0..<5, id: \.self) { _ in SessionRowSkeleton() }
        } else if !normalizedSearch.isEmpty {
            // 검색 결과 0건 — «세션 없음» 과 구분되는 안내. 검색어를 비우면 전체 복원.
            Text("일치하는 세션 없음")
                .foregroundStyle(.secondary)
                .padding(.vertical, 12)
        } else if statusFilter != .all && !sessions.isEmpty {
            // 상태 세그먼트로 좁혀 0건 — 다른 상태엔 세션이 있다는 신호. 「세션 없음」 과 구분.
            Text("이 상태의 세션이 없어요.")
                .foregroundStyle(.secondary)
                .padding(.vertical, 12)
        } else if sessionFilter == .workflow && hasWorkflowSessions {
            Text("워크플로우가 만든 세션이 여기 보여요.")
                .foregroundStyle(.secondary)
                .padding(.vertical, 12)
        } else {
            // 연결은 됐는데 세션이 0건 — 첫 사용자가 «무엇을 하는 화면인지 + 다음 행동» 을 설명
            // 없이도 바로 알도록, 빈 상태가 «자기소개 + CTA» 를 한다(상시 도움말 「?」 버튼을 없앤
            // 자리를 대신). 막히는 첫 사용자를 위한 도움 허브 링크는 마찰점 힌트로 아래에 작게 남긴다.
            // 검색/필터로 좁혀 0건인 위 분기엔 달지 않는다 — 그쪽은 다른 곳에 세션이 있는 정상 상태.
            VStack(spacing: 14) {
                Image(systemName: "bubble.left.and.bubble.right")
                    .font(.system(size: Theme.IconSize.l))
                    .foregroundStyle(Theme.accent)
                Text("아직 세션이 없어요")
                    .font(.title3.weight(.semibold))
                Text("세션은 Mac 의 코드 에이전트와 나누는 대화예요. 새 세션을 만들어 레포를 고르면 모바일에서 바로 명령을 보낼 수 있어요.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 24)
                Button {
                    showNew = true
                } label: {
                    Label("새 세션 만들기", systemImage: "plus")
                }
                .buttonStyle(.borderedProminent)
                // prominent 가 (iOS 26 시뮬레이터에서) AccentColor 에셋을 안 타고 파랗게 뜰 때가
                // 있어 명시 — BacklogView·PaywallView 와 같은 관례(파랑 금지, 색 정책).
                .tint(Theme.accent)
                StuckHelpLink(label: "처음이라 막혔나요? 도움받기")
                    .padding(.top, 2)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 32)
            .listRowSeparator(.hidden)
        }
    }

    /// 세션 목록 상단 검색 바 — 예전 `.searchable`(시스템 nav 드로어 바)을 커스텀 HStack 으로
    /// 바꿔 돋보기 옆에 받아쓰기 «마이크» 를 붙였다. FileViewer/ChatView 의 찾기 바와 같은 모양
    /// (돋보기 + VoiceInputField + 지우기 X). $searchText 를 그대로 묶어 음성 받아쓴 텍스트가
    /// 즉시 필터(matchesSearch)에 반영된다 — 별도 디바운스가 없는 클라이언트측 즉시 필터라 부분
    /// 결과 충돌도 없다. 화면 컨테이너(List)에 `.voiceDictationChrome()` 을 붙여 HUD/배너를 띄운다.
    private var searchBarRow: some View {
        Section {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                VoiceInputField("이름·레포로 검색", text: $searchText, focus: $isSearchFocused)
                    .textFieldStyle(.plain)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .submitLabel(.search)
                if !searchText.isEmpty {
                    Button {
                        searchText = ""
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("검색어 지우기")
                }
            }
            .listRowInsets(EdgeInsets(top: 6, leading: 12, bottom: 6, trailing: 12))
        }
    }

    /// 세션 한 행의 공통 가로 레이아웃 — 본문(전체 폭 «열기» 버튼 + 진입 chevron) + 트레일링
    /// «빠른 동작» 을 한 줄로 나눈다. 두 탭 타깃은 «중첩 핫존» 을 피해 HStack 안 별개 Button 으로
    /// 둔다(대기 배너와 같은 패턴) — 행 어디를 눌러도 채팅방이 열리되, 트레일링 빠른 동작 pill 만
    /// 그 동작을 한다. 빠른 동작이 없으면(EmptyView) 본문이 폭을 그대로 다 차지해 옛 레이아웃과 같다.
    /// 채팅방은 openSession(단일 optional) 으로 연다 — 탭·딥링크·예약결과가 모두 이 한 바인딩을
    /// 거쳐 «항상 하나» 의 방만 띄운다(스택 누적 방지). 활성/보관함 두 행이 같은 모양을 공유한다.
    @ViewBuilder
    private func sessionRowLayout<Quick: View>(
        _ s: SessionSummary,
        @ViewBuilder quickAction: () -> Quick,
    ) -> some View {
        HStack(spacing: Theme.Spacing.m) {
            Button {
                openSession = s
            } label: {
                HStack(spacing: Theme.Spacing.m) {
                    SessionRow(session: s, changeCounts: changeCounts)
                    // 진입 chevron — 행 전체가 «열기» 임을 명시한다. 트레일링에 별개 빠른 동작 pill 이
                    // 생겨 행이 두 영역으로 나뉘므로, «어디가 열기인지» 가 더 또렷하도록 .tertiary →
                    // .secondary 로 한 단계 강조한다(장식이라 a11y 는 숨김 — 행 라벨은 SessionRow 텍스트).
                    Image(systemName: "chevron.right")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .accessibilityHidden(true)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            // 트레일링 빠른 동작 — «열기» 와 겹치지 않는 별개 Button. 상태/capability 에 따라 EmptyView.
            quickAction()
        }
    }

    /// «대기/실행중/완료» 별 트레일링 빠른 동작 — 행 안에서 «보이는» 별개 Button 으로 노출한다.
    /// 색은 의미 토큰만: 검토(대기 → 승인 흐름·비파괴)·보관(완료 → 비파괴)은 accent(보라),
    /// 중지(실행중 → 진행 작업 끊음·파괴적)는 danger(빨강). warning(노랑)·pro(주황) 강조 금지.
    /// capability 미지원이면 버튼을 숨겨(EmptyView) 거짓 UI 를 막는다 — 그룹 헤더 일괄 버튼과
    /// 같은 게이트(검토·중지=bulk_session_actions_v1, 보관=session_archive_v1)를 재사용한다.
    @ViewBuilder
    private func sessionQuickAction(_ s: SessionSummary) -> some View {
        switch s.runState {
        case .waiting:
            // 검토 — 그 세션 하나만 승인 검토 시트로. «블라인드 승인» 대신 무엇을 바꾸려는지 보고 승인.
            if bulkActionsSupported {
                SessionQuickActionButton(
                    title: "검토",
                    systemImage: "checklist",
                    tint: Theme.accent,
                    accessibilityLabel: Text("대기 중인 승인 요청 검토"),
                ) { rowReviewSession = s }
            }
        case .running:
            // 중지 — 진행 turn 을 끊는다(파괴적이라 danger). /pty/control 라우트라 bulk capability 게이트.
            if bulkActionsSupported {
                SessionQuickActionButton(
                    title: "중지",
                    systemImage: "stop.fill",
                    tint: Theme.danger,
                    accessibilityLabel: Text("실행 중인 세션 중지"),
                ) { Task { await stop(s) } }
            }
        case .done:
            // 보관 — 완료 세션을 시야에서 치운다(비파괴·복구 가능이라 accent). 스와이프 보관과 같은 동작.
            if archiveSupported {
                SessionQuickActionButton(
                    title: "보관",
                    systemImage: "archivebox",
                    tint: Theme.accent,
                    accessibilityLabel: Text("이 세션 보관"),
                ) { Task { await archive(s) } }
            }
        }
    }

    /// 세션 한 행 — 본문 + 진입 chevron + 트레일링 빠른 동작 + 스와이프(삭제/이름 변경/보관).
    /// 그룹/평면 두 렌더 경로가 같은 모양을 쓰도록 메서드로 묶는다.
    @ViewBuilder
    private func sessionRowButton(_ s: SessionSummary) -> some View {
        sessionRowLayout(s) {
            sessionQuickAction(s)
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button(role: .destructive) {
                Task { await delete(s) }
            } label: {
                Label("삭제", systemImage: "trash")
            }
            Button {
                renameDraft = s.title ?? ""
                renameTarget = s
            } label: {
                Label("이름 변경", systemImage: "pencil")
            }
            .tint(Theme.info)
        }
        // 왼쪽 스와이프 = «보관» — 완료/오래된 세션을 한 동작으로 시야에서 치운다(기본 목록에서
        // 사라지고 «보관함» 에서 복구 가능). 비파괴(reversible)라 danger 가 아니라 accent.
        // session_archive_v1 없는 옛 daemon 에선 숨김(스와이프 액션 자체를 안 단다).
        .swipeActions(edge: .leading, allowsFullSwipe: true) {
            if archiveSupported {
                Button {
                    Task { await archive(s) }
                } label: {
                    Label("보관", systemImage: "archivebox")
                }
                .tint(Theme.accent)
            }
        }
    }

    // MARK: - 보관 / 그룹 / 대기 강조 (session_archive_v1)

    /// 입력 대기 세션 수 — 현재 필터(검색·워크플로우)로 좁힌 «보이는» 집합 기준. 상단 강조 배너가
    /// 0 이면 숨고, >0 이면 «먼저 처리할 것» 을 accent(보라, 경고 아님)로 표면화한다.
    private var waitingCount: Int { sessions(in: .waiting).count }

    /// 실행 중 / 완료 세션 수 — 상단 글랜서블 요약 헤더(SessionSummaryHeader)의 카운트. 대기와 같은
    /// «보이는» 집합(검색·워크플로우 필터 적용) 기준이라 헤더 숫자와 세그먼트로 좁힌 목록이 일치한다.
    private var runningCount: Int { sessions(in: .running).count }
    private var doneCount: Int { sessions(in: .done).count }
    /// 완료 중 «오류로 끝난» 세션 수 — 함대에서 «막힌» 에이전트를 danger 배지로 따로 집어주는 주의 신호.
    /// 완료(.done)는 정상 완료 + 오류 종료를 함께 묶으므로, 그중 status=="error" 만 추려 강조한다.
    private var errorCount: Int { sessions(in: .done).filter { $0.status == "error" }.count }
    /// 요약 헤더 노출 게이트 — 보이는(필터 적용) 세션 합. 0 이면(첫 로딩·검색 0건·세션 없음) 헤더를 숨긴다.
    private var summaryTotal: Int { waitingCount + runningCount + doneCount }

    /// «입력 대기 N건» 상단 강조 배너 — WIP 인지(triage 1순위). danger/warning 이 아니라 accent
    /// (브랜드·주요 인터랙티브)로 «지금 먼저 처리할 것» 을 가리킨다 (경고가 아니라 행동 유도).
    /// 왼쪽 라벨을 탭하면 상태 필터를 «대기» 로 좁히고, 오른쪽 «검토» 는 승인 검토 시트(각 요청의
    /// diff·요약을 보고 골라/묶어 승인)를 띄운다 — pty 일괄 capability 가 있을 때만. 두 탭 타깃은
    /// 중첩 버튼을 피해 HStack 안 별개 Button 으로 둔다. 대기 0건이거나 이미 대기 필터면 숨김.
    @ViewBuilder
    private var waitingBannerRow: some View {
        if waitingCount > 0 && statusFilter != .waiting {
            Section {
                HStack(spacing: Theme.Spacing.m) {
                    Button {
                        statusFilter = .waiting
                    } label: {
                        HStack(spacing: Theme.Spacing.m) {
                            Image(systemName: "hourglass")
                                .font(.footnote.weight(.semibold))
                            Text("입력 대기 \(waitingCount)건 — 먼저 처리하세요")
                                .font(.subheadline.weight(.semibold))
                            Spacer(minLength: Theme.Spacing.m)
                        }
                        .padding(.vertical, Theme.Spacing.xxs)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(Theme.accent)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(Text("입력 대기 세션 \(waitingCount)건. 탭하면 대기 세션만 봅니다."))
                    .accessibilityAddTraits(.isButton)
                    // 「검토」 — 승인 검토 시트로 직행. pty 일괄 제어 capability 없는 옛 daemon 에선
                    // 시트의 승인/거절 라우트가 404 라 버튼을 숨긴다(거짓 UI 방지).
                    if bulkActionsSupported {
                        Button {
                            showApprovalReview = true
                        } label: {
                            Label("검토", systemImage: "checklist")
                                .font(.subheadline.weight(.semibold))
                                .labelStyle(.titleAndIcon)
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(Theme.accent)
                        .accessibilityLabel(Text("대기 중인 승인 요청 검토"))
                    }
                }
                .listRowBackground(Theme.accent.opacity(Theme.Opacity.fill))
            }
        }
    }

    /// 함대 상태 요약 헤더 행 — 화면 상단에 «대기 N · 실행 중 N · 완료 N» 글랜서블 카드를 띄워
    /// 여러 세션의 상태 분포를 한눈에 답한다(병렬 운용의 «새눈» 가시성). 각 카드는 탭하면 그 상태로
    /// 필터를 좁히고(같은 상태 재탭 → 전체 복원) 상태 세그먼트(statusFilter)와 양방향으로 묶인다.
    /// summaryTotal==0(첫 로딩·검색 0건·세션 없음)이면 숨겨 빈/로딩 상태와 충돌하지 않는다.
    @ViewBuilder
    private var summaryHeaderRow: some View {
        if summaryTotal > 0 {
            Section {
                SessionSummaryHeader(
                    waiting: waitingCount,
                    running: runningCount,
                    done: doneCount,
                    errors: errorCount,
                    filter: $statusFilter,
                )
                .listRowInsets(EdgeInsets(top: 6, leading: 12, bottom: 6, trailing: 12))
                .listRowSeparator(.hidden)
            }
        }
    }

    /// 레포별 그룹 한 묶음 — repo_path(절대경로, id) + 그 안의 세션들. ForEach 가 키패스 id 를
    /// 쓰려면 (튜플 불가) Identifiable struct 가 필요.
    private struct RepoGroup: Identifiable {
        let repo: String
        let items: [SessionSummary]
        var id: String { repo }
    }

    /// 레포(repo_path)별 그룹 — 보이는 세션을 절대경로로 묶고, 폴더명(마지막 경로 요소) 기준
    /// 사전순 정렬해 화면마다 순서가 안정적이게 한다. worktree 세션은 자기 경로로 자연히 분리된다.
    private func repoGroups(_ list: [SessionSummary]) -> [RepoGroup] {
        let grouped = Dictionary(grouping: list, by: { $0.repo_path })
        return grouped
            .map { RepoGroup(repo: $0.key, items: $0.value) }
            .sorted {
                let a = RepoGroupHeader.displayName($0.repo)
                let b = RepoGroupHeader.displayName($1.repo)
                if a == b { return $0.repo < $1.repo }
                return a.localizedCaseInsensitiveCompare(b) == .orderedAscending
            }
    }

    /// 상태 그룹 헤더(대기/실행중/완료) — 일괄 액션 closure 를 상태별로 주입. 완료 그룹은
    /// «모두 보관»(accent, 비파괴, 즉시) + «모두 삭제»(danger, 확인 다이얼로그)를 메뉴로 묶는다.
    private func statusSectionHeader(_ state: SessionRunState) -> SessionGroupHeader {
        let group = sessions(in: state)
        return SessionGroupHeader(
            state: state,
            count: group.count,
            // 대기→모두 승인 / 실행중→모두 중지 — pty 일괄 capability 필요. 「모두 승인」 은 단순
            // 확인 대신 컨텍스트 미리보기 시트(각 요청의 diff·요약을 보고 골라/묶어 승인)를 띄운다.
            onApproveAll: (state == .waiting && bulkActionsSupported && !group.isEmpty)
                ? { showApprovalReview = true } : nil,
            onStopAll: (state == .running && bulkActionsSupported && !group.isEmpty)
                ? { pendingBulkAction = BulkAction(kind: .stop, targets: group) } : nil,
            // 완료→모두 보관(비파괴·즉시) — session_archive_v1 필요.
            onArchiveAll: (state == .done && archiveSupported && !group.isEmpty)
                ? { Task { await archiveAll(group) } } : nil,
            // 완료→모두 삭제(파괴적) — 확인 다이얼로그. per-session API 라 capability 무관(옛 daemon 도).
            onDeleteAll: (state == .done && !group.isEmpty)
                ? { pendingBulkAction = BulkAction(kind: .delete, targets: group) } : nil,
        )
    }

    /// 활성(미보관) 목록 본문 — 검색 바 + 대기 강조 배너 + 필터 세그먼트 + 그룹(상태별/레포별).
    @ViewBuilder
    private var activeListContent: some View {
        if !sessions.isEmpty {
            searchBarRow
        }
        // 함대 상태 요약 — 검색바 아래, 대기 배너 위. summaryTotal>0 일 때만(빈/로딩엔 안 뜸).
        summaryHeaderRow
        // WIP 인지 — 「입력 대기 N건」 강조. 빈/첫로딩엔 안 뜬다(waitingCount=0).
        waitingBannerRow
        // 워크플로우 세션이 있을 때만 — 내 세션 / 워크플로우 세션을 구분해서 보는 세그먼트.
        if hasWorkflowSessions {
            Section {
                Picker("세션 종류", selection: $sessionFilter) {
                    Text("내 세션").tag(SessionFilter.manual)
                    Text("워크플로우").tag(SessionFilter.workflow)
                }
                .pickerStyle(.segmented)
                .listRowInsets(EdgeInsets(top: 6, leading: 12, bottom: 6, trailing: 12))
            }
        }
        // 상태 세그먼트 — 세션이 하나라도 있을 때만. 오케스트레이션 뷰의 핵심 축.
        if !sessions.isEmpty {
            Section {
                Picker("상태", selection: $statusFilter) {
                    Text("전체").tag(StatusFilter.all)
                    Text("실행 중").tag(StatusFilter.running)
                    Text("대기").tag(StatusFilter.waiting)
                    Text("완료").tag(StatusFilter.done)
                }
                .pickerStyle(.segmented)
                .listRowInsets(EdgeInsets(top: 6, leading: 12, bottom: 6, trailing: 12))
            }
        }
        if statusVisibleSessions.isEmpty {
            Section { emptyStateRows }
        } else if grouping == .repo {
            // 레포별 그룹 — 보이는 세션을 repo_path 로 묶는다. 헤더는 폴더명 + 개수(구조 신호라 중립색).
            ForEach(repoGroups(statusVisibleSessions)) { group in
                Section {
                    ForEach(group.items) { s in sessionRowButton(s) }
                } header: {
                    RepoGroupHeader(repoPath: group.repo, count: group.items.count)
                }
            }
        } else if statusFilter == .all {
            // 상태별 그룹 — 대기→실행중→완료, 빈 그룹은 건너뛴다. 헤더에 일괄 액션.
            ForEach(Self.groupOrder.filter { !sessions(in: $0).isEmpty }, id: \.self) { state in
                Section {
                    ForEach(sessions(in: state)) { s in sessionRowButton(s) }
                } header: {
                    statusSectionHeader(state)
                }
            }
        } else {
            // 특정 상태만 — 평면 목록 (세그먼트가 이미 어떤 상태인지 알려 준다). 대기 필터에선
            // 그룹 헤더가 없어 일괄 승인 진입점이 사라지므로, 여기 헤더에 「검토하고 승인」 을 단다.
            Section {
                ForEach(statusVisibleSessions) { s in sessionRowButton(s) }
            } header: {
                if statusFilter == .waiting && bulkActionsSupported && !statusVisibleSessions.isEmpty {
                    Button {
                        showApprovalReview = true
                    } label: {
                        Label("검토하고 승인", systemImage: "checklist")
                            .font(.footnote.weight(.semibold))
                            .labelStyle(.titleAndIcon)
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(Theme.accent)
                    .textCase(nil)
                    .accessibilityLabel(Text("대기 중인 승인 요청 검토"))
                }
            }
        }
    }

    /// 보관함 목록 본문 — 보관된 세션(별도 fetch). 로딩 skeleton / 빈 상태 / 목록(스와이프 복구·삭제,
    /// 그룹 헤더 일괄 복구·삭제)을 그린다. 활성 목록과 분리된 «보관됨» 섹션.
    @ViewBuilder
    private var archivedListContent: some View {
        if archivedSessions.isEmpty {
            if archivedLoading || !archivedLoaded {
                // 로딩 중 / 첫 진입(로드 시작 전) — skeleton 으로 «곧 도착» 신호 (빈 안내 깜빡임 방지).
                Section { ForEach(0..<4, id: \.self) { _ in SessionRowSkeleton() } }
            } else {
                // 받았으나 0건 — 보관된 세션 없음 (로딩/세션없음과 구분되는 안내).
                Section {
                    // 활성 목록의 다른 빈 상태(「일치하는 세션 없음」·「이 상태의 세션이 없어요.」)와
                    // 같은 leading 정렬. maxWidth:.infinity(가운데 정렬)를 두면 짧은 문구가 화면
                    // 중앙으로 밀려 좌측에 큰 빈 여백 + 구분선이 어긋나 「빈 셀」 처럼 보였다.
                    Text("보관된 세션이 없어요.")
                        .foregroundStyle(.secondary)
                        .padding(.vertical, 12)
                }
            }
        } else {
            Section {
                ForEach(archivedSessions) { s in archivedRowButton(s) }
            } header: {
                ArchivedGroupHeader(
                    count: archivedSessions.count,
                    onRestoreAll: { Task { await restoreAll(archivedSessions) } },
                    onDeleteAll: { pendingBulkAction = BulkAction(kind: .delete, targets: archivedSessions) },
                )
            }
        }
    }

    /// 보관함의 한 행 — 활성 행과 «같은» 공통 레이아웃을 쓰되 스와이프 액션만 다르다(보관 대신
    /// 복구). 보관함은 «치워둔» 목록이라 트레일링 빠른 동작은 두지 않는다(복구/삭제는 스와이프).
    @ViewBuilder
    private func archivedRowButton(_ s: SessionSummary) -> some View {
        sessionRowLayout(s) { EmptyView() }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button(role: .destructive) {
                Task { await deleteArchived(s) }
            } label: {
                Label("삭제", systemImage: "trash")
            }
        }
        // 왼쪽 스와이프 = «복구» — 보관 해제해 기본 목록으로 되돌린다(비파괴, accent).
        .swipeActions(edge: .leading, allowsFullSwipe: true) {
            Button {
                Task { await unarchive(s) }
            } label: {
                Label("복구", systemImage: "tray.and.arrow.up")
            }
            .tint(Theme.accent)
        }
    }

    /// capabilities 는 MainTabView 소유 — 세션 reload 가 채우고, 탭 컨테이너가 워크플로우 탭
    /// 노출 판단에 같이 읽는다. (private @State 가 많아 memberwise init 이 private 이라 명시 init.)
    init(capabilities: Binding<[String]>) {
        self._capabilities = capabilities
    }

    var body: some View {
        NavigationStack {
            List {
                // «보관함» 모드면 보관된 세션 목록, 아니면 활성(미보관) 목록. 두 본문을 분리해
                // 보관 세션이 활성 목록을 가리지 않게 한다(별도 fetch·별도 상태).
                if showingArchived {
                    archivedListContent
                } else {
                    activeListContent
                }
            }
            .listStyle(.plain)
            // 세션 목록 상단 검색은 위 searchBarRow(커스텀 바)가 담당 — 돋보기 옆 마이크(받아쓰기)를
            // 붙이려고 시스템 `.searchable` 대신 직접 그린다. 받아쓰기 HUD/배너/오류는 화면 단위 공통
            // 크롬으로 띄운다(`.voiceDictationChrome()`).
            .voiceDictationChrome()
            .refreshable {
                // 보관함 모드면 보관 목록을, 아니면 활성 목록을 새로 받는다.
                if showingArchived {
                    await loadArchived()
                } else {
                    await reload()
                    // 명시적 갱신 — 지금 보이는 세션들의 변경 파일 수도 다시 받는다(전체 fan-out
                    // 아님, 보이는 id 만). 카드는 한 번 받으면 캐시라, 이 gesture 가 유일한 새로고침.
                    changeCounts.refresh(ids: statusVisibleSessions.map { $0.id })
                }
            }
            .inFlightBanner()
            .navigationTitle(navTitle)
            // 채팅방 — openSession 이 세팅되면 push, 시스템 back 으로 돌아오면 nil 로 풀린다.
            // 알림/딥링크로 «다른» 세션 값이 들어오면 navigationDestination(item:) 이 identity
            // 변경을 감지해 기존 방을 pop 후 새 방을 push(교체)한다 — 목록 깜빡임 없이 전환.
            // .id(s.id) 로 세션마다 view identity 를 고정 → 교체 시 ChatView 의 @StateObject vm
            // 이 새 세션으로 확실히 재생성된다(옛 세션의 WebSocket/폴링이 새 방에 남지 않게).
            .navigationDestination(item: $openSession) { s in
                ChatView(
                    session: s,
                    auth: auth,
                    conn: conn,
                    inflight: inflight,
                )
                .id(s.id)
                // 채팅방에서는 탭 바를 숨긴다 — 입력창이 탭 바 위에 얹혀 자리를 뺏지 않게.
                // 단 «세션 탭이 활성일 때만» 숨긴다(activeMainTab). 딥링크로 백로그/자동화 탭으로
                // 전환하면 이 채팅 뷰가 세션 스택에 남아 TabView 전체 탭 바를 계속 가리는 SwiftUI
                // 누출이 생긴다(웜 진입 시 「탭 바 없는 백로그」 에 갇힘) — 비활성 탭이 되면 .visible 로
                // 풀어 도착 탭의 탭 바를 살린다. 채팅 네비게이션은 그대로라 세션 탭 복귀 시 다시 채팅이 뜬다.
                // (activeMainTab == nil = MainTabView 밖/프리뷰 → 기존대로 숨김.)
                .toolbar((activeMainTab ?? .sessions) == .sessions ? .hidden : .visible, for: .tabBar)
            }
            // 툴바는 iOS 의 «자동 오버플로» 에 맡긴다 — 공간이 있으면 버튼을 그대로 보여 주고,
            // 좁은 기기(iPhone 13 mini 등)에선 «안 들어가는 만큼만» 시스템이 «…» 메뉴로 접는다
            // (= «최대한 버튼, 부족분만 …» 네이티브 동작). 핵심은 각 버튼을 아이콘-only 가 아니라
            // Label(텍스트+아이콘)로 두는 것: 바에선 아이콘만 보이지만, 접혀 «…» 메뉴 행으로 갈 때
            // «텍스트» 가 있어야 제대로 그려지고 눌린다. (옛 «…» 가 먹통이던 원인 = Image-only 라
            // 오버플로 행에 제목이 없어 빈 행이 됐던 것 — SwiftUI 제약이 아니라 라벨 누락이었다.)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    // 설정 기어 — 모든 메인 탭(세션·자동화·백로그)의 «같은 자리»(좌상단)에 둔다.
                    // 도움말 상시 「?」 버튼은 제거하고 도움말 허브를 설정 안 «도움말» 섹션으로 일원화했다.
                    Button { showSettings = true } label: {
                        Label("설정", systemImage: "gearshape")
                    }
                }
                // 「보기」 — 그룹핑 축(상태별/레포별) 전환 + 「보관함」 진입/이탈을 한 메뉴에 모은다
                // (활성 목록을 짧게 유지하는 두 손잡이). 그룹핑은 daemon 무관(항상), 보관함 토글은
                // session_archive_v1 게이트. 정리할 세션이 없고 보관도 미지원이면 메뉴 자체를 숨긴다.
                // (도움말 상시 버튼은 release/v2.18.0 에서 제거돼 설정 안 «도움말» 로 일원화 — 미병합.)
                if archiveSupported || !sessions.isEmpty {
                    ToolbarItem(placement: .topBarLeading) {
                        Menu {
                            if !showingArchived && !sessions.isEmpty {
                                Picker("그룹", selection: $grouping) {
                                    Label("상태별", systemImage: "square.grid.2x2").tag(SessionGrouping.status)
                                    Label("레포별", systemImage: "folder").tag(SessionGrouping.repo)
                                }
                            }
                            if archiveSupported {
                                if !showingArchived && !sessions.isEmpty { Divider() }
                                Button {
                                    showingArchived.toggle()
                                } label: {
                                    if showingArchived {
                                        Label("활성 세션 보기", systemImage: "tray.full")
                                    } else {
                                        Label("보관함 보기", systemImage: "archivebox")
                                    }
                                }
                            }
                        } label: {
                            Label("보기", systemImage: "line.3.horizontal.decrease.circle")
                        }
                        .accessibilityLabel("보기 옵션")
                    }
                }
                // 프로(주황) 묶음을 우상단에 모은다 — 공간 있으면 개별 버튼, 좁으면 시스템이 «…» 로 접음.
                // screen_capture_v1 지원 daemon 일 때만 노출.
                if capabilities.contains("screen_capture_v1") {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button {
                            purchase.gate(.monitorMirror, $paywallFeature) { showDesktop = true }
                        } label: {
                            Label("모니터 미러링", systemImage: "display")
                        }
                        .tint(Theme.pro)
                    }
                }
                // 예약 작업 진입점은 세션 탭에서 제거됐다 — 예약은 워크플로우와 같은 pro(주황)
                // 도메인이라 세션 탭(무료) 툴바에 주황 버튼이 떠 통일성이 깨졌다. 이제 「자동화」
                // 탭(워크플로우 | 예약 세그먼트, MainTabView→AutomationHomeView)이 cron_v1 게이팅·
                // 예약 화면을 전담한다.
                // 프로 구독·구매(IAP) — 상품 구매 화면(PaywallView)으로 직접. 이미 보유(구독/평생)
                // 했거나 무료 단계(iapEnabled=false)면 살 게 없으니 버튼 자체를 숨긴다. isProUnlocked
                // 은 @Published(isEntitled) 기반이라 구매 완료 시 toolbar 가 즉시 갱신돼 버튼이 사라진다.
                if !purchase.isProUnlocked {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button { showPurchase = true } label: {
                            Label("프로 구독·구매", systemImage: "crown")
                        }
                        .tint(Theme.pro)
                    }
                }
                // 새 세션 — 1차 액션. 워크플로우는 별도 탭(MainTabView)으로 분리됐다.
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showNew = true } label: {
                        Label("새 세션 만들기", systemImage: "plus")
                    }
                }
            }
            // 모니터 미러링 — 합성 세션 id 로 세션과 분리. 풀스크린.
            .fullScreenCover(isPresented: $showDesktop) {
                MonitorMirrorView(
                    sessionId: MonitorMirrorView.desktopSessionId,
                    api: ApiClient(auth: auth, conn: conn, tracker: inflight),
                    conn: conn,
                    canControl: capabilities.contains("remote_control_v1"),
                    supportsH264: capabilities.contains("screen_h264_v1"),
                    supportsWindowTarget: capabilities.contains("screen_window_target_v1"),
                )
            }
            .overlay {
                // skeleton 이 첫 로딩 자리를 차지하므로 overlay 는 refresh 케이스에만.
                // (pull-to-refresh 가 자동 회복까지 처리하므로 별도 사용자 버튼은 없다.)
                if loading && !sessions.isEmpty { ProgressView() }
            }
            // «연결 실패» alert 은 제거됨 — 폴링/리로드가 자동으로 회복하므로 사용자가
            // 알아도 할 수 있는 일이 없다. error 상태는 디버그/추적용으로 남기되 UI 노출은 X.
            // 다음 reload 가 성공하면 error 가 nil 로 돌아간다.
            .task {
                // 현재 페어링 onion 으로 캐시를 입양 — 다른 Mac 으로 re-pair 한 경우엔 옛 캐시
                // 가 자동 무효화돼 빈 상태로 시작. SessionsView 가 .task 안에서 한 번만
                // 호출하면 같은 페어링 내에서는 멱등 (cache 가 currentOnion 비교로 early return).
                sessionCache.adopt(onion: auth.config?.onion)
                // 변경 파일 수 캐시에 API 의존성 주입 — @StateObject init 시점엔 환경객체가 없어
                // 여기서 한 번 묶는다(멱등). 이후 각 카드가 보일 때 그 세션 변경 수를 lazy 로 받는다.
                changeCounts.bind(auth: auth, conn: conn)
                await reload()
                // 콜드 런치 딥링크 — onOpenURL 이 SessionsView 등장 전에 pendingSessionId 를
                // 박았을 수 있어 onChange 가 안 와도 여기서 한 번 매칭을 시도한다.
                navigateToPendingDeepLink()
            }
            // 딥링크 진입 — pendingSessionId 가 세팅되거나(앱 실행 중 탭) 세션 목록이
            // 갱신될 때(콜드 런치 후 첫 reload) 매칭되는 세션으로 navigate 한다.
            .onChange(of: deepLink.pendingSessionId) { _ in
                navigateToPendingDeepLink()
            }
            .onChange(of: sessions) { _ in
                navigateToPendingDeepLink()
            }
            // ChatView 에서 이름을 바꾸고 돌아왔을 때 리스트가 옛 이름을 보이지 않도록 갱신.
            // 초기 로드는 .task 가 처리하므로 여기서는 이미 sessions 가 차 있을 때만 다시 가져온다.
            .onAppear {
                if !sessions.isEmpty {
                    Task { await reload() }
                }
            }
            // 백그라운드 60s+ 후 foreground 복귀 — 세션 목록을 새로 가져온다.
            // 옛 통째 AppRoot 재구성 대신 view-level targeted refresh.
            .onChange(of: lifecycle.reawakeToken) { _ in
                NSLog("[SessionsView] reawake — reload")
                Task { await reload() }
            }
            // 「보관함」 진입/이탈 — 진입 시 보관 목록을 lazy 로 받아오고, 이탈 시 활성 목록을 다시
            // 받아 보관함에서 복구한 세션이 곧장 활성 목록에 반영되게 한다.
            .onChange(of: showingArchived) { _ in
                if showingArchived {
                    Task { await loadArchived() }
                } else {
                    Task { await reload() }
                }
            }
            // 리스트 스와이프에서 이름 변경을 눌렀을 때 뜨는 시트. 예전엔 `.alert` 였지만, alert 는
            // TextField/Button 만 담을 수 있어 받아쓰기 마이크(누르고 말하기 제스처)를 붙일 수 없다 →
            // 작은 시트로 바꿔 VoiceInputField + 공통 크롬을 쓴다.
            .sheet(item: $renameTarget) { target in
                RenameSessionSheet(target: target, draft: $renameDraft) { t, draft in
                    Task { await rename(t, to: draft) }
                }
            }
            .sheet(isPresented: $showNew) {
                NewSessionSheet(auth: auth, conn: conn, inflight: inflight, localLlmActive: localLlmActive) { repo, title, resumeFrom, skipPermissions, agentId in
                    await create(
                        repoPath: repo,
                        title: title,
                        resumeFrom: resumeFrom,
                        skipPermissions: skipPermissions,
                        agentId: agentId,
                    )
                }
                .presentationDetents([.large])
            }
            // 통합 설정 시트 — 좌상단 「설정」 버튼이 띄운다. «설정 가능한 것» (언어 / 가로 모드 /
            // Mac 앱 업데이트 / 페어링 해제 / 버전) 만 담는다.
            .sheet(isPresented: $showSettings) {
                SettingsSheet()
            }
            // 구독/구매(IAP) — 좌상단 왕관 버튼에서 직접 여는 상품 구매 화면.
            .sheet(isPresented: $showPurchase) {
                PaywallView()
            }
            // 승인 검토 시트 — 동시에 대기 중인 승인 요청을 각 세션의 «무엇을 바꾸려는가»(보류
            // 요약 + diff 요약 + 레포)와 함께 나열하고, 골라/묶어 승인하거나 개별 거절한다.
            // 끝나면 onFinished 로 활성 목록을 다시 받아 상태(대기→실행중 등)를 반영한다.
            .sheet(isPresented: $showApprovalReview) {
                ApprovalReviewSheet(
                    sessions: sessions(in: .waiting),
                    auth: auth,
                    conn: conn,
                    inflight: inflight,
                ) {
                    Task { await reload() }
                }
                .presentationDetents([.large])
            }
            // 단일 세션 검토 — «대기» 행의 트레일링 «검토» 빠른 동작이 그 세션 하나만 담아 띄운다.
            // 전체 검토(showApprovalReview)와 같은 시트를 sessions:[하나] 로 스코프해 재사용한다.
            .sheet(item: $rowReviewSession) { target in
                ApprovalReviewSheet(
                    sessions: [target],
                    auth: auth,
                    conn: conn,
                    inflight: inflight,
                ) {
                    Task { await reload() }
                }
                .presentationDetents([.large])
            }
            // 프로 전용 기능(예약·미러링)을 미보유 사용자가 눌렀을 때의 업셀 페이월.
            .proPaywall(item: $paywallFeature)
            // 그룹 헤더 «모두 승인»/«모두 중지» 확인 — 한 번에 N건을 건드리는 액션이라 실수 탭
            // 방지 + 대상 개수를 명시한다. «모두 중지» 는 진행 중 작업을 끊으므로 destructive(빨강).
            .confirmationDialog(
                bulkDialogTitle,
                isPresented: Binding(
                    get: { pendingBulkAction != nil },
                    set: { if !$0 { pendingBulkAction = nil } },
                ),
                titleVisibility: .visible,
                presenting: pendingBulkAction,
            ) { action in
                switch action.kind {
                case .stop:
                    Button("\(action.targets.count)건 모두 중지", role: .destructive) {
                        Task { await runBulk(action) }
                    }
                case .delete:
                    // 보관함에서의 삭제와 완료 그룹 정리는 대상 설명이 다르다(둘 다 파괴적·확인 필수).
                    if showingArchived {
                        Button("보관 세션 \(action.targets.count)건 삭제", role: .destructive) {
                            Task { await runBulk(action) }
                        }
                    } else {
                        Button("완료 세션 \(action.targets.count)건 삭제", role: .destructive) {
                            Task { await runBulk(action) }
                        }
                    }
                }
                Button("취소", role: .cancel) {}
            } message: { action in
                switch action.kind {
                case .stop:
                    Text("실행 중인 세션의 진행 중 작업을 중단합니다.")
                case .delete:
                    if showingArchived {
                        Text("보관 세션 \(action.targets.count)건을 삭제할까요? 되돌릴 수 없습니다.")
                    } else {
                        // 완료된 세션만 대상 — 실행중·대기 세션은 절대 포함되지 않는다(활성 팀 보호).
                        Text("완료 세션 \(action.targets.count)건을 삭제할까요? 되돌릴 수 없습니다.")
                    }
                }
            }
        }
    }

    /// confirmationDialog 제목 — 현재 대기 중인 일괄 액션 종류에 맞춘 한 줄. presenting 클로저
    /// 밖(제목)이라 pendingBulkAction 을 직접 본다 (닫힘 상태에선 빈 키 — 다이얼로그가 안 뜸).
    private var bulkDialogTitle: LocalizedStringKey {
        switch pendingBulkAction?.kind {
        case .stop: return "실행 중 세션 모두 중지"
        case .delete:
            if showingArchived { return "보관 세션 삭제" }
            return "완료 세션 정리"
        case nil: return ""
        }
    }

    /// 네비게이션 타이틀 — 보관함 모드면 「보관함」, 아니면 「세션」. 둘 다 LocalizedStringKey 리터럴이라
    /// 카탈로그 자동 추출 경로를 탄다 (ternary 가 아니라 if/return 으로 String 추론 위험 차단).
    private var navTitle: LocalizedStringKey {
        if showingArchived { return "보관함" }
        return "세션"
    }

    /// 일괄 액션 실행 — 그룹 안 세션마다 같은 제어 키를 보낸다 (중지=ESC). 한 건 실패해도 나머지는
    /// 계속 (부분 성공 허용 — 개별 실패는 다음 reload 로 상태에 드러난다). 순차 전송: 실행중 그룹은
    /// 보통 소수라 직렬이어도 충분하고, 단일 Tor 회로를 동시 요청으로 몰아치지 않는다. 끝나면
    /// reload 로 상태를 갱신한다. (대기→승인은 컨텍스트 미리보기 시트가 per-session 으로 직접 처리.)
    @MainActor
    private func runBulk(_ action: BulkAction) async {
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        switch action.kind {
        case .stop:
            for s in action.targets {
                try? await api.ptyControl(sessionId: s.id, action: .interrupt)
            }
        case .delete:
            // 완료 그룹 정리 / 보관함 삭제 — 세션마다 per-session delete 를 직렬 전송. 한 건이 이미
            // 사라졌거나 API 가 실패해도 나머지는 계속(부분 성공 허용). per-session API 라 옛 daemon
            // 에서도 동작. 실패 건수만 모아 끝나고 간단히 알린다.
            var failed = 0
            for s in action.targets {
                do {
                    try await api.deleteSession(s.id)
                    ChatDraftStore.clear(s.id)
                } catch {
                    failed += 1
                }
            }
            if failed > 0 {
                self.error = String(localized: "세션 \(failed)건을 삭제하지 못했어요.")
            }
        }
        // 끝나면 상태 갱신 — 보관함 모드면 보관 목록을, 아니면 활성 목록을 다시 받는다.
        if showingArchived {
            await loadArchived()
        } else {
            await reload()
        }
    }

    /// 단건 «중지» — 실행 중 세션의 진행 turn 을 중단한다(ESC = interrupt). 진행 중 작업을 끊으므로
    /// 파괴적(danger 색)이지만, 다시 메시지를 보내면 이어갈 수 있어 «삭제» 처럼 되돌릴 수 없는
    /// 동작은 아니다 — 그래서 확인 다이얼로그 없이 한 동작으로 처리한다(행의 빠른 동작). 끝나면
    /// reload 로 상태(실행중→대기/완료)를 반영한다. 그룹 헤더 «모두 중지» 와 같은 /pty/control 라우트라
    /// bulk_session_actions_v1 capability 게이트(호출부)를 공유한다.
    @MainActor
    private func stop(_ session: SessionSummary) async {
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        do {
            try await api.ptyControl(sessionId: session.id, action: .interrupt)
        } catch {
            self.error = (error as? LocalizedError)?.errorDescription ?? "\(error)"
        }
        await reload()
    }

    /// 단건 «보관» — 활성 목록에서 낙관적으로 제거 후 PATCH. 실패 시 스냅샷으로 복구. 보관은
    /// 비파괴(보관함에서 복구 가능)라 확인 다이얼로그 없이 한 동작으로 처리한다(스와이프).
    @MainActor
    private func archive(_ session: SessionSummary) async {
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        let snapshot = sessions
        sessionCache.mutate { $0.removeAll { $0.id == session.id } }
        do {
            try await api.setSessionArchived(session.id, archived: true)
        } catch {
            sessionCache.save(snapshot)
            self.error = (error as? LocalizedError)?.errorDescription ?? "\(error)"
        }
    }

    /// 단건 «복구» — 보관함 목록에서 낙관적으로 제거 후 PATCH(archived=false). 활성 목록 재반영은
    /// 보관함을 닫을 때 reload 가 가져온다. 실패 시 스냅샷으로 복구.
    @MainActor
    private func unarchive(_ session: SessionSummary) async {
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        let snapshot = archivedSessions
        archivedSessions.removeAll { $0.id == session.id }
        do {
            try await api.setSessionArchived(session.id, archived: false)
        } catch {
            archivedSessions = snapshot
            self.error = (error as? LocalizedError)?.errorDescription ?? "\(error)"
        }
    }

    /// 보관함의 단건 삭제 — 보관함 목록에서 낙관적으로 제거 후 per-session delete. 실패 시 복구.
    @MainActor
    private func deleteArchived(_ session: SessionSummary) async {
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        let snapshot = archivedSessions
        archivedSessions.removeAll { $0.id == session.id }
        do {
            try await api.deleteSession(session.id)
            ChatDraftStore.clear(session.id)
        } catch {
            archivedSessions = snapshot
            self.error = (error as? LocalizedError)?.errorDescription ?? "\(error)"
        }
    }

    /// 완료 그룹 «모두 보관» — 한 번의 bulk 요청으로 전부 보관. 활성 목록에서 낙관적으로 제거하고,
    /// 실패하면 스냅샷으로 복구. 비파괴라 확인 다이얼로그 없이 즉시 (브리프: 한 동작으로 보관).
    @MainActor
    private func archiveAll(_ targets: [SessionSummary]) async {
        guard !targets.isEmpty else { return }
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        let ids = Set(targets.map { $0.id })
        let snapshot = sessions
        sessionCache.mutate { $0.removeAll { ids.contains($0.id) } }
        do {
            _ = try await api.bulkSessions(action: .archive, ids: Array(ids))
        } catch {
            sessionCache.save(snapshot)
            self.error = String(localized: "세션을 보관하지 못했어요.")
        }
    }

    /// 보관함 «모두 복구» — 한 번의 bulk 요청으로 전부 복구. 보관함 목록에서 낙관적으로 비운다.
    @MainActor
    private func restoreAll(_ targets: [SessionSummary]) async {
        guard !targets.isEmpty else { return }
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        let ids = Set(targets.map { $0.id })
        let snapshot = archivedSessions
        archivedSessions.removeAll { ids.contains($0.id) }
        do {
            _ = try await api.bulkSessions(action: .unarchive, ids: Array(ids))
        } catch {
            archivedSessions = snapshot
            self.error = String(localized: "세션을 복구하지 못했어요.")
        }
    }

    /// 보관함 목록 로드 — showingArchived 진입 시 호출. listArchivedSessions(?archived=1)로 보관분만
    /// 받는다. 활성 reload 와 별도 loading 게이트라 서로 깜빡임을 안 만든다.
    @MainActor
    private func loadArchived() async {
        guard !archivedLoading else { return }
        archivedLoading = true
        defer { archivedLoading = false }
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        do {
            archivedSessions = try await api.listArchivedSessions()
            archivedLoaded = true
        } catch {
            self.error = (error as? LocalizedError)?.errorDescription ?? "\(error)"
        }
    }

    /// 대기 중인 딥링크 세션으로 navigate. 목록에 매칭되는 세션이 있으면 openSession 에 박아
    /// 그 세션 채팅방으로 «교체» 한다 — 이미 다른 세션 방이 떠 있어도(Discord 딥링크 재인입)
    /// navigationDestination(item:) 이 identity 변경을 감지해 기존 방을 pop 후 새 방을 push 한다.
    /// 채팅방은 언제나 하나만 떠 있어 스택이 쌓이지 않는다.
    /// 목록에 없으면 그 id 로 «아직 reload 안 했을 때만» 한 번 reload 를 시도한다 — reload 가
    /// sessions 를 갱신하면 onChange 가 이 함수를 다시 부른다. 없는 세션(삭제/다른 Mac)으로
    /// 무한 reload 도는 것은 deepLinkReloadedFor 가드가 막는다.
    @MainActor
    private func navigateToPendingDeepLink() {
        guard let sid = deepLink.pendingSessionId else { return }
        if let match = sessions.first(where: { $0.id == sid }) {
            openSession = match
            deepLink.consume()
            deepLinkReloadedFor = nil
            return
        }
        // 목록에 없음 — 이 id 로 아직 reload 안 했으면 한 번만 시도.
        if deepLinkReloadedFor != sid && !loading {
            deepLinkReloadedFor = sid
            Task { await reload() }
        }
    }

    @MainActor
    private func reload() async {
        guard !loading else { return }
        loading = true
        defer { loading = false }
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        // 세션 목록은 메인 콘텐츠. /api/version 은 자동화 탭(workflow_v1·cron_v1)·미러링 게이팅에
        // 쓸 capability 만 들고 온다 (버전 표시는 설정 시트가 자체 fetch). 둘을 병렬로 — Tor
        // 회로 한 cycle 에 같이 흐르게. 목록 실패는 error 로 추적(UI 노출 X), version 실패는 무시.
        async let listing: [SessionSummary] = api.listSessions()
        async let serverInfo: ServerVersionInfo = api.getServerVersion(label: nil)
        do {
            sessionCache.save(try await listing)
        } catch {
            self.error = (error as? LocalizedError)?.errorDescription ?? "\(error)"
        }
        if let info = try? await serverInfo {
            capabilities = info.capabilities
        }
    }

    /// 세션 생성. 성공이면 nil 반환(시트가 스스로 닫음), 실패면 사용자에게 보여줄 에러 메시지
    /// 반환 — 시트가 alert 로 띄우고 열린 채로 둔다. 옛 동작은 실패해도 시트를 무조건 닫아
    /// 「버튼은 눌리는데 세션이 안 생기고 안내도 없는」 문제가 있었다 (로컬 LLM 동시 1개 초과 등).
    @MainActor
    private func create(
        repoPath: String,
        title: String?,
        resumeFrom: String?,
        skipPermissions: Bool,
        agentId: String,
    ) async -> String? {
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        do {
            _ = try await api.createSession(
                repoPath: repoPath,
                title: title,
                resumeFrom: resumeFrom,
                // daemon 의 runUserMessagePty 가 bypassPermissions || skip_permissions===1 로
                // OR 처리 — true 면 PTY 가 bypass 모드로 spawn 되어 도구 prompt 가 안 뜨고,
                // false 면 매 도구 호출마다 REPL 텍스트 prompt 가 뜬다 (응답 멈춤).
                skipPermissions: skipPermissions,
                mode: "pty",
                agent: agentId,
            )
            await reload()
            // 성취의 순간 — 세션을 직접 만들어 성공. gate(세션 2개+2일 연속) 충족 시 1회 리뷰 요청.
            ReviewPrompt.recordSessionCreated()
            // 시트가 닫힌 뒤 calm 한 시점에 발사 — 시트 dismiss 애니메이션과 겹치지 않게 살짝 지연.
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(1.2))
                ReviewPrompt.maybeRequestAfterSessionCreated(requestReview)
            }
            return nil
        } catch {
            return (error as? LocalizedError)?.errorDescription ?? "\(error)"
        }
    }

    /// 세션 이름 변경 — 서버에 PATCH 후 로컬 리스트에서도 해당 행만 갱신해서 즉시 반영한다.
    /// 낙관적 업데이트는 하지 않는다 (실패 시 옛 이름이 그대로 보이므로 사용자 혼란이 없음).
    @MainActor
    private func rename(_ session: SessionSummary, to newTitle: String) async {
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        do {
            let updated = try await api.updateSession(
                session.id,
                title: newTitle.trimmingCharacters(in: .whitespacesAndNewlines)
            )
            sessionCache.mutate { list in
                if let idx = list.firstIndex(where: { $0.id == session.id }) {
                    list[idx] = updated
                }
            }
        } catch {
            self.error = (error as? LocalizedError)?.errorDescription ?? "\(error)"
        }
    }

    @MainActor
    private func delete(_ session: SessionSummary) async {
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        // 낙관적 제거 — 실패 시 reload 로 복구
        let snapshot = sessions
        sessionCache.mutate { $0.removeAll { $0.id == session.id } }
        do {
            try await api.deleteSession(session.id)
            // 삭제된 세션의 작성 중 문장(draft)도 제거 — 고아 키가 UserDefaults 에 안 쌓이게.
            ChatDraftStore.clear(session.id)
        } catch {
            sessionCache.save(snapshot)
            self.error = (error as? LocalizedError)?.errorDescription ?? "\(error)"
        }
    }
}

/// 함대 상태 요약 헤더 — 화면 상단에 «대기 N · 실행 중 N · 완료 N» 을 글랜서블 카드(StatPill)로
/// 띄워 여러 세션의 상태 분포를 한눈에 답한다(병렬 운용의 «새눈» 가시성). 각 카드는 탭하면 그
/// 상태로 필터를 좁히고(같은 상태 재탭 → 전체 복원) 상태 세그먼트(`statusFilter`)와 양방향 바인딩.
///
/// 색 정책: 의미 토큰만 쓴다 — 대기=accent(브랜드/주요 인터랙티브 = «주의 필요·행동 유도», 경고
/// 아님)·실행중=success·완료=중립(.secondary). 완료 중 «오류로 끝남» 은 danger 배지로 따로 집어
/// 막힌 에이전트를 강조한다. pro(주황) 차용·warning↔pro 혼동·장식용 status 색 빌림 금지.
private struct SessionSummaryHeader: View {
    let waiting: Int
    let running: Int
    let done: Int
    /// 완료 중 오류 종료 수 — 완료 카드의 danger 서브 배지(막힌 에이전트 주의 신호).
    let errors: Int
    @Binding var filter: SessionsView.StatusFilter

    var body: some View {
        HStack(spacing: Theme.Spacing.m) {
            StatPill(
                icon: "hourglass",
                count: waiting,
                label: "대기",
                color: Theme.accent,
                isSelected: filter == .waiting,
                accessibility: Text("입력 대기 세션 \(waiting)건. 탭하면 대기 세션만 봅니다."),
                action: { toggle(.waiting) },
            )
            StatPill(
                icon: "circle.fill",
                count: running,
                label: "실행 중",
                color: Theme.success,
                isSelected: filter == .running,
                accessibility: Text("실행 중 세션 \(running)건. 탭하면 실행 중 세션만 봅니다."),
                action: { toggle(.running) },
            )
            StatPill(
                icon: "checkmark.circle.fill",
                count: done,
                label: "완료",
                color: .secondary,
                isSelected: filter == .done,
                errorBadge: errors,
                accessibility: doneAccessibility,
                action: { toggle(.done) },
            )
        }
        .accessibilityElement(children: .contain)
    }

    /// 완료 카드 음성 안내 — 오류가 있으면 오류 건수까지 한 문장에 포함(서브 배지는 a11y 숨김이라
    /// 여기서 흡수). 둘 다 LocalizedStringKey 보간이라 카탈로그 자동 추출 경로를 탄다.
    private var doneAccessibility: Text {
        if errors > 0 {
            return Text("완료 세션 \(done)건, 오류 \(errors)건. 탭하면 완료 세션만 봅니다.")
        }
        return Text("완료 세션 \(done)건. 탭하면 완료 세션만 봅니다.")
    }

    /// 카드 탭 → 그 상태로 필터, 같은 상태 재탭이면 전체 복원(토글). 세그먼트와 같은 $statusFilter.
    private func toggle(_ s: SessionsView.StatusFilter) {
        filter = (filter == s) ? .all : s
    }
}

/// 요약 헤더의 상태 카드 한 장 — 큰 숫자(상태색·고대비) + 아이콘 + 라벨(.secondary)로 텍스트
/// 의존을 줄인 글랜서블 표시. 선택 상태면 채움/테두리 불투명도를 한 단계 올려(badge/border) 현재
/// 세그먼트를 시각적으로 잇는다. 본문 색은 자동 적응(.secondary)·상태색만 쓰고 .white/.black
/// 하드코딩·전역 .tint 는 없다(에러 배지의 onAccent 흰색은 «danger 배경 위» 전용으로만).
private struct StatPill: View {
    let icon: String
    let count: Int
    let label: LocalizedStringKey
    let color: Color
    var isSelected: Bool = false
    /// >0 이면 우상단에 danger «오류 N» 서브 배지. 완료 카드 전용(막힌 에이전트 강조).
    var errorBadge: Int = 0
    let accessibility: Text
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: Theme.Spacing.xs) {
                HStack(spacing: Theme.Spacing.xs) {
                    Image(systemName: icon)
                        .font(.caption2.weight(.semibold))
                    Text(verbatim: "\(count)")
                        .font(.title3.weight(.bold))
                        .monospacedDigit()
                }
                .foregroundStyle(color)
                Text(label)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, Theme.Spacing.m)
            .padding(.horizontal, Theme.Spacing.s)
            .background(
                RoundedRectangle(cornerRadius: Theme.Radius.m, style: .continuous)
                    .fill(color.opacity(isSelected ? Theme.Opacity.badge : Theme.Opacity.fill)),
            )
            .overlay(
                RoundedRectangle(cornerRadius: Theme.Radius.m, style: .continuous)
                    .strokeBorder(color.opacity(isSelected ? Theme.Opacity.border : 0), lineWidth: 1),
            )
            .overlay(alignment: .topTrailing) {
                if errorBadge > 0 {
                    HStack(spacing: Theme.Spacing.xxs) {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .font(.caption2.weight(.bold))
                            .imageScale(.small)
                        Text(verbatim: "\(errorBadge)")
                            .font(.caption2.weight(.bold))
                    }
                    .foregroundStyle(Theme.onAccent)
                    .padding(.horizontal, Theme.Spacing.s)
                    .padding(.vertical, Theme.Spacing.xxs)
                    .background(Capsule().fill(Theme.danger))
                    .padding(Theme.Spacing.xs)
                    .accessibilityHidden(true)  // 음성 안내는 완료 카드 라벨이 흡수.
                }
            }
            .contentShape(RoundedRectangle(cornerRadius: Theme.Radius.m, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibility)
        .accessibilityAddTraits(isSelected ? [.isButton, .isSelected] : .isButton)
    }
}

/// 세션 행의 트레일링 «빠른 동작» pill — 행 본문 «열기» 와 분리된 별개 탭 타깃(중첩 핫존 금지).
/// 아이콘+짧은 텍스트를 의미 색(tint)으로 옅게 채운 캡슐로, «보이는» 동작임을 분명히 한다
/// (배너 「검토」 버튼과 같은 titleAndIcon 언어). 색은 호출부가 의미 토큰으로만 넘긴다 —
/// accent(검토·보관=비파괴) / danger(중지=파괴적). warning(노랑)·pro(주황)·리터럴 색 금지.
///
/// 터치 타깃: 밀집 행이라 HIG 44pt 를 엄격히 채우는 대신 «시각 크기 자체» 로 누를 면적을 확보한다
/// (불투명 frame 으로 죽은 공간을 만들지 않음 — ChatKeyButton 44pt 회귀 준수). 보이는 캡슐 = 탭
/// 영역(contentShape(Capsule)). 색·배경만 그리므로 레이아웃 점유는 캡슐 자신뿐이다.
private struct SessionQuickActionButton: View {
    let title: LocalizedStringKey
    let systemImage: String
    let tint: Color
    let accessibilityLabel: Text
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Label(title, systemImage: systemImage)
                .font(.subheadline.weight(.semibold))
                .labelStyle(.titleAndIcon)
                .lineLimit(1)
                .fixedSize()
                .padding(.horizontal, Theme.Spacing.l)
                .padding(.vertical, Theme.Spacing.m)
                .foregroundStyle(tint)
                .background(
                    Capsule().fill(tint.opacity(Theme.Opacity.fill)),
                )
                .overlay(
                    Capsule().strokeBorder(tint.opacity(Theme.Opacity.border), lineWidth: 1),
                )
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityAddTraits(.isButton)
    }
}

private struct SessionRow: View {
    let session: SessionSummary
    /// 변경 파일 수 lazy 캐시 — 카드가 보일 때 그 세션만 받아 채운다(@ObservedObject 라
    /// 값이 도착하면 이 행만 다시 그려진다).
    @ObservedObject var changeCounts: SessionChangeCounts
    /// 출처 브리프 배지 탭 → `backlog/<id>` 딥링크. 백로그 탭 전환 + 브리프 상세 push 를
    /// 기존 딥링크 인프라(MainTabView·BacklogView 소비)에 위임 — ChatView 칩과 같은 경로.
    @EnvironmentObject var deepLink: DeepLinkRouter
    /// 「조용함 N분」 칩을 띄우기 시작하는 idle 임계(초) — ChatView 와 같은 약속. 도구 연쇄
    /// 노이즈를 피해 분 단위로 넉넉히 잡는다.
    private static let quietSurfaceThresholdSec = 60

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            // 출처 브리프 배지 — 이 세션을 낳은 백로그 브리프發일 때만(source_brief != nil) 자체
            // 줄로 노출. 일반 세션엔 미표시(행 높이 회귀 0). 탭하면 backlog/<id> 딥링크로 점프해
            // «다시 접속» 의 출발점인 목록에서 바로 출처를 가린다. 자체 줄이라 제목이 길어도
            // 브랜치/repo 줄과 자리 경쟁 없이 tail 로 깔끔히 잘린다(레이아웃 점프 없음).
            // 출처(백로그 브리프)를 제목보다 위에 둬, 「이 세션이 어디서 왔나」 를 먼저 읽게 한다.
            if let sb = session.source_brief {
                SourceBriefBadge(brief: sb) {
                    deepLink.pendingBacklogBriefId = sb.id
                    deepLink.pendingBacklog = true
                }
            }
            // 타이틀은 한 줄을 통째로 써서 말줄임을 최소화한다 — 모델·상태 배지는 자리
            // 경쟁을 피해 아래 요약 줄(시각·변경수 옆)로 내렸다.
            Text(session.title ?? String(localized: "제목 없음"))
                .font(.headline)
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)
            // worktree 브랜치 배지 + 레포 경로 — 「이 세션이 어느 격리 브랜치(작업 폴더)에서
            // 도는지」 를 묶어 보여 주는 모바일 오케스트레이션 신호. 일반 세션엔 배지 없음.
            HStack(spacing: Theme.Spacing.s) {
                if let slug = session.worktreeBranchSlug {
                    BranchBadge(slug: slug)
                }
                Text(session.repo_path)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            // 카드 요약 — 마지막 turn 시각(상대시간) + 변경 파일 수(있을 때만). 대기 여부는
            // 위 상태 배지가 이미 답한다.
            HStack(spacing: Theme.Spacing.l) {
                Label {
                    Text(Self.relative(session.lastActivityAt))
                } icon: {
                    Image(systemName: "clock")
                }
                .lineLimit(1)
                .layoutPriority(-1)  // 좁아지면 상태 배지보다 먼저 양보(잘리거나 줄어든다).
                if let n = changeCounts.count(for: session.id), n > 0 {
                    Label {
                        Text("변경 \(n)")
                    } icon: {
                        Image(systemName: "doc.text")
                    }
                }
                // 「조용함 N분」 — 실행중인데 임계 이상 조용한(=12초 휴리스틱이 «대기» 로 못 잡은)
                // 세션을 함대 목록에서 표면화한다. 도구 연쇄로 출력이 흐르면 idle 이 0 으로 리셋돼
                // 헛경보가 안 난다. 대기로 잡힌 세션은 위 상태 배지가 이미 답하므로 실행중에만.
                if session.runState == .running,
                   let secs = session.quietSeconds, secs >= Self.quietSurfaceThresholdSec {
                    Label {
                        Text("조용함 \(secs / 60)분")
                    } icon: {
                        Image(systemName: "moon.zzz")
                    }
                }
                // 모델·상태 배지 — 타이틀 줄에서 내려와 요약 줄 오른쪽 끝에 붙는다. 배지는
                // 자체 font/색을 갖고 있어 이 줄의 .caption2/.tertiary 에 물들지 않는다.
                Spacer(minLength: Theme.Spacing.m)
                AgentBadge(agentId: session.agent)
                // 실행중/대기/완료 — 같은 카드 모양 안에서 «일하는 중» / «나를 기다리는 중» /
                // «끝남» 을 한눈에 가른다. 대기는 warning(노랑) = «사용자 액션 필요» 약속색.
                // 트레일링 빠른 동작 pill 로 행 폭이 줄어든 좁은 기기에서도 «상태» 만은 반드시 보이게
                // layoutPriority(1)+fixedSize 로 먼저 자리를 잡는다 — 왼쪽 시각/변경 라벨이 대신 줄거나
                // 잘리고(아래 lineLimit), 에이전트 배지가 양보한다(브리프: 상태 배지 우선 보장).
                RunStateBadge(state: session.runState, status: session.status)
                    .fixedSize()
                    .layoutPriority(1)
                // 알림 액션(승인/중지) 처리 상태 — 알림에서 누른 결과를 목록에서도 비춘다.
                // 처리중/완료/실패만 그린다(대기는 RunStateBadge 가 이미 표시). 색은 의미 토큰:
                // 처리중=accent, 완료=success(초록), 실패=danger(빨강).
                AgentWaitActionBadge(sessionId: session.id)
            }
            .font(.caption2)
            .foregroundStyle(.tertiary)
            .labelStyle(.titleAndIcon)
        }
        .padding(.vertical, Theme.Spacing.xs)
        .onAppear {
            // 변경 파일 수는 활성 세션(실행중/대기)만 받는다 — «지금 관리 중» 인 팀의 변경만
            // 본다. 완료 세션까지 받으면 「완료」 탭 스크롤 시 git status 호출이 불필요하게 분다.
            if session.runState != .done {
                changeCounts.loadIfNeeded(session.id)
            }
        }
    }

    /// 마지막 turn 시각 → 시스템 로케일 상대시간("3분 전"). RelativeDateTimeFormatter 가 자동
    /// 번역하므로 카탈로그 문자열이 필요 없다. formatter 는 비싸서 1회 생성 후 재사용.
    private static let relFormatter: RelativeDateTimeFormatter = {
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .abbreviated
        return f
    }()
    private static func relative(_ ms: Int64) -> String {
        relFormatter.localizedString(
            for: Date(timeIntervalSince1970: TimeInterval(ms) / 1000),
            relativeTo: Date(),
        )
    }
}

/// 첫 로딩 동안 보여 줄 빈 자리 row. `.redacted(.placeholder)` 만으로는 SwiftUI 기본
/// shimmer 가 없어서 명시적 회색 박스 3 줄로 SessionRow 모양을 흉내낸다 — 사용자에게
/// "여기에 콘텐츠가 곧 들어옴" 시각적 신호.
private struct SessionRowSkeleton: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                placeholder(width: 160, height: 14)
                Spacer()
                placeholder(width: 40, height: 12)
            }
            placeholder(width: 220, height: 11)
            placeholder(width: 100, height: 10)
        }
        .padding(.vertical, 4)
        .accessibilityHidden(true)  // VoiceOver 가 자리 표시자를 읽지 않게.
    }

    private func placeholder(width: CGFloat, height: CGFloat) -> some View {
        RoundedRectangle(cornerRadius: 4)
            .fill(Color.secondary.opacity(0.15))
            .frame(width: width, height: height)
    }
}

/// «에이전트가 입력을 기다리는 중» 배지 — 상태 배지와 같은 capsule 모양, warning 색.
/// 노랑은 색상 정책상 «진짜 주의/액션 필요» 전용 — 막힌 에이전트가 정확히 그 경우다.
/// RunStateBadge(대기) 가 이 배지를 그대로 재사용한다.
private struct WaitingBadge: View {
    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: "hourglass")
                .font(.caption2.weight(.semibold))
                .imageScale(.small)
            Text("입력 대기")
                .font(.caption2)
        }
        .padding(.horizontal, Theme.Spacing.m).padding(.vertical, Theme.Spacing.xxs)
        .background(Theme.warning.opacity(0.2))
        .foregroundStyle(Theme.warning)
        .clipShape(Capsule())
    }
}

/// 세션의 오케스트레이션 상태 배지 — 실행중(success)/대기(warning)/완료(중립)·오류(danger).
/// 대기는 기존 `WaitingBadge`(「입력 대기」)를 그대로 재사용해 신호를 일관되게 유지한다.
/// 색은 의미 토큰만 쓴다: 완료는 «끝남» 이지 «강조» 가 아니라 중립 회색(상태색 안 빌림).
private struct RunStateBadge: View {
    let state: SessionRunState
    let status: String

    var body: some View {
        switch state {
        case .waiting:
            WaitingBadge()
        case .running:
            badge(icon: "circle.fill", text: "실행 중", color: Theme.success)
        case .done:
            // 완료 그룹 안에서도 «정상 완료» 와 «오류 종료» 는 다른 신호 — danger(빨강)로 가른다.
            if status == "error" {
                badge(icon: "exclamationmark.triangle.fill", text: "오류", color: Theme.danger)
            } else {
                badge(icon: "checkmark.circle.fill", text: "완료", color: .secondary)
            }
        }
    }

    private func badge(icon: String, text: LocalizedStringKey, color: Color) -> some View {
        HStack(spacing: 3) {
            Image(systemName: icon)
                .font(.caption2.weight(.semibold))
                .imageScale(.small)
            Text(text)
                .font(.caption2)
        }
        .padding(.horizontal, Theme.Spacing.m).padding(.vertical, Theme.Spacing.xxs)
        .background(color.opacity(0.2))
        .foregroundStyle(color)
        .clipShape(Capsule())
    }
}

/// 알림 액션(승인/중지) 처리 상태 배지 — `AgentWaitNotifier.actionStates` 를 관찰해 알림에서
/// 누른 결과를 세션 목록에서도 비춘다. «대기» 상태는 RunStateBadge 가 이미 표현하므로 여기선
/// 처리중/완료/실패만 그린다. 색은 의미 토큰: 처리중=accent(브랜드), 완료=success(초록),
/// 실패=danger(빨강). 배지 자체 font/색을 가져 카드 줄의 .tertiary 에 물들지 않는다.
private struct AgentWaitActionBadge: View {
    let sessionId: String
    @ObservedObject private var notifier = AgentWaitNotifier.shared

    var body: some View {
        switch notifier.actionStates[sessionId] {
        case .processing:
            badge(icon: "hourglass", text: "처리 중", color: Theme.accent)
        case .done:
            badge(icon: "checkmark.circle.fill", text: "처리 완료", color: Theme.success)
        case .failed:
            badge(icon: "exclamationmark.triangle.fill", text: "처리 실패", color: Theme.danger)
        case .waiting, .none:
            // 대기는 RunStateBadge 가 표시, 상태 없으면 아무것도 안 그린다.
            EmptyView()
        }
    }

    private func badge(icon: String, text: LocalizedStringKey, color: Color) -> some View {
        HStack(spacing: 3) {
            Image(systemName: icon)
                .font(.caption2.weight(.semibold))
                .imageScale(.small)
            Text(text)
                .font(.caption2)
        }
        .padding(.horizontal, Theme.Spacing.m).padding(.vertical, Theme.Spacing.xxs)
        .background(color.opacity(Theme.Opacity.badge))
        .foregroundStyle(color)
        .clipShape(Capsule())
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityText)
    }

    private var accessibilityText: Text {
        switch notifier.actionStates[sessionId] {
        case .processing: return Text("알림 액션 처리 중")
        case .done: return Text("알림 액션 처리 완료")
        case .failed: return Text("알림 액션 처리 실패 — 세션을 열어 직접 처리하세요")
        case .waiting, .none: return Text("")
        }
    }
}

/// worktree 브랜치 배지 — 세션이 어느 격리 브랜치(작업 폴더)에서 도는지. 브랜치는 «구조»
/// 신호라 상태색(success/warning/danger)을 빌리지 않고 중립 회색 칩으로 둔다. slug 는
/// daemon 의 `<repo>.worktrees/<slug>` 폴더명(=식별자)이라 번역 대상이 아니다(verbatim).
private struct BranchBadge: View {
    let slug: String
    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: "arrow.triangle.branch")
                .font(.caption2.weight(.semibold))
                .imageScale(.small)
            Text(verbatim: slug)
                .font(.caption2.weight(.medium))
                .lineLimit(1)
                .truncationMode(.middle)
        }
        .padding(.horizontal, Theme.Spacing.s).padding(.vertical, Theme.Spacing.xxs)
        .background(Theme.neutralFill.opacity(Theme.Opacity.fill))
        .foregroundStyle(.secondary)
        .clipShape(Capsule())
        .accessibilityLabel(Text("브랜치 \(slug)"))
    }
}

/// 출처 브리프 배지 — 세션을 낳은 백로그 브리프發일 때만 세션 행에 노출. 종류(구현/정리/
/// 재종합/수집) 라벨 + 제목(있으면, verbatim·tail 말줄임)을 보여 주고, 탭하면 backlog/<id>
/// 딥링크로 브리프 상세에 1탭 도달한다 (ChatView 출처 칩과 같은 인프라·약속).
///
/// 색 정책: 브리프 출처는 «브랜드/주요 인터랙티브» 신호라 accent(보라, 의미 토큰) 단색만 쓴다 —
/// status 색(success/danger/warning/info)·pro(주황)·리터럴(.blue/.orange/.yellow) 차용 금지.
/// 채움 .badge / 테두리 .border 불투명도 토큰, radius s(6)·spacing s(6) 4pt 그리드로 행의 다른
/// 배지(브랜치/에이전트/상태)와 시각 리듬을 맞춘다. 타이포는 시맨틱 폰트(.caption2)로 Dynamic
/// Type 자동 적응 — 고정 pt 금지. 제목은 에이전트/사용자 입력이라 번역 대상 아님(verbatim).
private struct SourceBriefBadge: View {
    let brief: SourceBriefRef
    /// 탭 → backlog/<id> 딥링크 위임. 행 전체 탭(세션 열기)과 분리된 자체 탭 타깃.
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: Theme.Spacing.xs) {
                Image(systemName: "list.clipboard")
                    .font(.caption2.weight(.semibold))
                Text(brief.briefKind.label)
                    .font(.caption2.weight(.semibold))
                    .fixedSize()
                if let title = brief.title?.trimmingCharacters(in: .whitespacesAndNewlines),
                   !title.isEmpty {
                    Text(verbatim: "·")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    Text(verbatim: title)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
            }
            .foregroundStyle(Theme.accent)
            .padding(.horizontal, Theme.Spacing.s)
            .padding(.vertical, Theme.Spacing.xxs)
            .background(
                RoundedRectangle(cornerRadius: Theme.Radius.s, style: .continuous)
                    .fill(Theme.accent.opacity(Theme.Opacity.badge))
            )
            .overlay(
                RoundedRectangle(cornerRadius: Theme.Radius.s, style: .continuous)
                    .strokeBorder(Theme.accent.opacity(Theme.Opacity.border), lineWidth: 1)
            )
            .contentShape(RoundedRectangle(cornerRadius: Theme.Radius.s, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Text("출처 브리프 상세 열기"))
        .accessibilityHint(Text(accessibilityValue))
    }

    /// 보조 음성 안내 — 종류+제목을 한 문장으로(제목은 verbatim 보간).
    private var accessibilityValue: String {
        let title = brief.title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if title.isEmpty {
            return String(localized: "출처 브리프") + " · " + brief.briefKind.label
        }
        return String(localized: "출처 브리프") + " · " + brief.briefKind.label + " · " + title
    }
}

/// 상태 그룹 헤더 — 「대기 2」 처럼 상태명 + 개수. 개수는 숫자라 번역 불필요(상태명만 키).
/// 색은 상태 약속색을 따른다: 대기=warning, 실행중=success, 완료=중립.
///
/// 모든 그룹에 일괄 액션 버튼을 단다 — 대기=«모두 승인»·실행중=«모두 중지»·완료=«완료 정리».
/// 여러 세션이 동시에 멈추거나 도는 함대 운용에서 카드를 하나씩 열거나 밀지 않고 그룹 단위로
/// 처리하는 병목 해소(생산/실행 끝은 승인·중지, 수명 종료 끝은 정리).
private struct SessionGroupHeader: View {
    let state: SessionRunState
    let count: Int
    /// 대기→«모두 승인» (accent). nil 이면 버튼 숨김(대상 0건 / pty 일괄 capability 미지원).
    var onApproveAll: (() -> Void)? = nil
    /// 실행중→«모두 중지» (danger, 진행 중 작업 끊음). nil 이면 숨김.
    var onStopAll: (() -> Void)? = nil
    /// 완료→«모두 보관» (accent, 비파괴·즉시). session_archive_v1 일 때만. nil 이면 메뉴 대신 단일 삭제.
    var onArchiveAll: (() -> Void)? = nil
    /// 완료→«모두 삭제» (danger, 파괴적). 호출부가 확인 다이얼로그를 띄운다. nil 이면 숨김.
    var onDeleteAll: (() -> Void)? = nil

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: icon)
                .font(.caption2)
                .foregroundStyle(color)
            Text(label)
            Spacer()
            trailingControl
            Text(verbatim: "\(count)")
                .foregroundStyle(.secondary)
        }
    }

    /// 그룹별 일괄 컨트롤 — 대기=모두 승인(accent), 실행중=모두 중지(danger), 완료=정리 메뉴
    /// (보관/삭제). 헤더 자동 대문자화를 끄고(.textCase(nil)) 상태 약속색으로 강조한다.
    @ViewBuilder
    private var trailingControl: some View {
        switch state {
        case .waiting:
            if let onApproveAll {
                Button(action: onApproveAll) { Text("모두 승인") }
                    .font(.caption.weight(.semibold))
                    .textCase(nil)
                    .buttonStyle(.borderless)
                    .tint(Theme.accent)
            }
        case .running:
            if let onStopAll {
                Button(action: onStopAll) { Text("모두 중지") }
                    .font(.caption.weight(.semibold))
                    .textCase(nil)
                    .buttonStyle(.borderless)
                    .tint(Theme.danger)
            }
        case .done:
            // 완료 그룹은 «보관»(비파괴, 권장)과 «삭제»(파괴적)를 메뉴로 묶는다 — 한 화면에서
            // 시야 정리(보관) 또는 영구 제거(삭제)를 고른다. session_archive_v1 없으면(onArchiveAll
            // nil) 옛 동작대로 «완료 정리»(삭제) 단일 버튼으로 떨어진다.
            if onArchiveAll != nil {
                Menu {
                    if let onArchiveAll {
                        Button(action: onArchiveAll) {
                            Label("모두 보관", systemImage: "archivebox")
                        }
                    }
                    if let onDeleteAll {
                        Button(role: .destructive, action: onDeleteAll) {
                            Label("모두 삭제", systemImage: "trash")
                        }
                    }
                } label: {
                    Text("정리")
                }
                .font(.caption.weight(.semibold))
                .textCase(nil)
                .tint(Theme.accent)
            } else if let onDeleteAll {
                Button(action: onDeleteAll) { Text("완료 정리") }
                    .font(.caption.weight(.semibold))
                    .textCase(nil)
                    .buttonStyle(.borderless)
                    .tint(Theme.danger)
            }
        }
    }

    private var label: LocalizedStringKey {
        switch state {
        case .waiting: return "대기"
        case .running: return "실행 중"
        case .done: return "완료"
        }
    }
    private var icon: String {
        switch state {
        case .waiting: return "hourglass"
        case .running: return "play.circle.fill"
        case .done: return "checkmark.circle.fill"
        }
    }
    private var color: Color {
        switch state {
        case .waiting: return Theme.warning
        case .running: return Theme.success
        case .done: return .secondary
        }
    }
}

/// 레포별 그룹 헤더 — 「<폴더명> N」. 레포 경로는 «구조» 신호라 상태색(success/warning/danger)을
/// 빌리지 않고 중립(.secondary) 폴더 아이콘으로 둔다 (BranchBadge 와 같은 중립 약속). 폴더명은
/// 파일시스템 식별자라 번역 대상이 아니다(verbatim).
private struct RepoGroupHeader: View {
    let repoPath: String
    let count: Int

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "folder")
                .font(.caption2)
                .foregroundStyle(.secondary)
            Text(verbatim: Self.displayName(repoPath))
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer()
            Text(verbatim: "\(count)")
                .foregroundStyle(.secondary)
        }
        .textCase(nil)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("레포 \(Self.displayName(repoPath)), 세션 \(count)건"))
    }

    /// 표시용 폴더명 — repo_path 의 마지막 경로 요소. 비면 전체 경로로 폴백.
    static func displayName(_ path: String) -> String {
        let comps = path.split(separator: "/").map(String.init)
        return comps.last ?? path
    }
}

/// 보관함 그룹 헤더 — 「보관됨 N」 + 일괄 «복구»(accent, 비파괴)/«삭제»(danger, 파괴적) 메뉴.
/// 색은 중립(보관은 상태가 아니라 «치워둔 것»). 삭제만 호출부가 확인 다이얼로그를 띄운다.
private struct ArchivedGroupHeader: View {
    let count: Int
    var onRestoreAll: () -> Void
    var onDeleteAll: () -> Void

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "archivebox")
                .font(.caption2)
                .foregroundStyle(.secondary)
            Text("보관됨")
            Spacer()
            Menu {
                Button(action: onRestoreAll) {
                    Label("모두 복구", systemImage: "tray.and.arrow.up")
                }
                Button(role: .destructive, action: onDeleteAll) {
                    Label("모두 삭제", systemImage: "trash")
                }
            } label: {
                Text("정리")
            }
            .font(.caption.weight(.semibold))
            .textCase(nil)
            .tint(Theme.accent)
            Text(verbatim: "\(count)")
                .foregroundStyle(.secondary)
        }
    }
}

/// 세션 행에 작은 칩으로 «이 세션이 어떤 CLI 도구로 spawn 됐는지» 를 표시.
///
/// agent 식별 / displayName / SF Symbol 매핑은 `AgentKind` (Models/AgentKind.swift) 에
/// 분리돼 host-less 단위 테스트로 검증된다. 이 view 는 거기 더해 «어떤 색을 입힐지»
/// 만 결정 — 색 매핑은 시각 결정이라 의도적으로 view 안에 둔다 (테스트 대상 아님).
private struct AgentBadge: View {
    let agentId: String?

    private var kind: AgentKind { .from(id: agentId) }

    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: kind.systemImage)
                .font(.caption2)
            Text(verbatim: kind.displayName)
                .font(.caption2.weight(.medium))
                .lineLimit(1)
        }
        .padding(.horizontal, Theme.Spacing.s).padding(.vertical, Theme.Spacing.xxs)
        .background(color.opacity(0.18))
        .foregroundStyle(color)
        .clipShape(Capsule())
        .accessibilityLabel(Text(verbatim: kind.displayName))
    }

    /// kind → 표시 색. 시각 결정이라 view layer 책임. 주황은 «프로» 약속색(Theme.pro)이라
    /// 어떤 에이전트 뱃지에도 쓰지 않는다 — Claude Code 는 청록(teal)으로 구분.
    private var color: Color {
        switch kind {
        case .claudeCode: return .teal
        case .shell: return .gray
        case .codex: return .green
        case .antigravity: return .blue  // design-lint: allow — 에이전트 종류 구분 팔레트(teal/green/purple/indigo/pink… Node 색처럼 카테고리색), info 의미 아님
        case .localLlm: return .purple
        case .openCode: return .indigo
        case .copilot: return .pink
        case .unknown: return .gray
        }
    }
}

/// 세션 이름 변경 시트 — 예전 인플레이스 `.alert` 를 대체한다. alert 는 TextField/Button 만
/// 담을 수 있어 받아쓰기 마이크(누르고 말하기)를 못 붙이므로, 작은 시트에 새 세션 제목과 동일한
/// `VoiceInputField` + 화면 단위 공통 크롬(`.voiceDictationChrome()`)을 둔다. 빈칸이면 제목 없는
/// 세션이 되는 안내·동작은 alert 시절 그대로.
private struct RenameSessionSheet: View {
    let target: SessionSummary
    @Binding var draft: String
    /// 저장 콜백 — 호출부가 `Task { await rename(target, to: draft) }` 를 수행한다.
    let onSave: (SessionSummary, String) -> Void
    @Environment(\.dismiss) private var dismiss
    @FocusState private var focused: Bool

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VoiceInputField("제목", text: $draft, focus: $focused)
                        .textInputAutocapitalization(.sentences)
                } footer: {
                    Text("비워두면 제목 없는 세션이 됩니다.")
                        .font(.caption2)
                }
            }
            .navigationTitle("세션 이름 변경")
            .navigationBarTitleDisplayMode(.inline)
            .voiceDictationChrome()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    // 해제 버튼 — 강조색이 아니라 중립(primary).
                    Button("취소") { dismiss() }
                        .tint(Color.primary)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("저장") {
                        onSave(target, draft)
                        dismiss()
                    }
                }
            }
            // 시트가 뜨면 곧바로 입력란에 포커스 — alert 처럼 바로 타이핑/받아쓰기 시작.
            .onAppear { focused = true }
        }
        .presentationDetents([.height(220)])
    }
}

private struct NewSessionSheet: View {
    let auth: AuthStore
    let conn: ConnectionManager
    let inflight: InFlightTracker
    /// 활성 로컬 LLM 세션이 이미 있는지. true 면 로컬 LLM 을 고른 새 세션 생성을 막는다
    /// (메모리 보호 — 동시 1개). daemon 도 409 로 거절하지만 여기서 먼저 친절히 안내.
    let localLlmActive: Bool
    /// (repoPath, title, resumeFrom, skipPermissions, agentId). 호출자가 받아 daemon 에
    /// 그대로 전달. agentId 는 picker 에서 사용자가 고른 코드 에이전트 (기본 claude_code).
    /// 반환: 실패 시 사용자에게 보여줄 에러 메시지, 성공이면 nil — 시트가 이걸로 alert/닫기를
    /// 분기한다 (로컬 LLM 동시 1개 초과 등 daemon 거절을 화면에 명확히 안내하기 위함).
    let onCreate: (String, String?, String?, Bool, String) async -> String?

    @EnvironmentObject var hiddenItems: HiddenItemsStore
    /// 프로(주황) 전용 — Terminal·로컬 LLM 에이전트, worktree 생성 게이트. 미보유 시 차단 + 페이월.
    @EnvironmentObject var purchase: PurchaseStore
    /// 프로 게이트 페이월 — non-nil 이면 `.proPaywall(item:)` 가 PaywallView 시트를 띄운다.
    @State private var paywallFeature: ProFeature?
    @State private var showHiddenSheet = false
    /// 파일 탐색기(DirectoryPickerSheet)로 작업 폴더를 고르는 시트.
    @State private var showDirPicker = false

    @State private var repoPath = ""
    @State private var title = ""
    // 이 세션에서 사용할 코드 에이전트 CLI. daemon 의 GET /api/agents 응답으로 동적
    // 노출. multi_agent_v1 미지원 옛 daemon 은 404 → claudeCodeFallback 1개로 흡수.
    @State private var agents: [AgentInfo] = [AgentInfo.claudeCodeFallback]
    @State private var selectedAgentId: String = AgentInfo.claudeCodeFallback.id
    /// 로컬 LLM 세부 상태(바이너리·선택/추천 모델·다운로드 진행·하드웨어). nil = 아직 미조회/실패.
    /// 단일 boolean 환원 대신 이 세부를 읽어 「무엇이 준비됐고 무엇이 빠졌는지」 를 표면화한다.
    @State private var llmStatus: LocalLlmStatus?
    /// 모델 카탈로그(+downloaded 플래그) — 폰에서 받을 모델 선택지.
    @State private var llmModels: [LocalLlmCatalogModel] = []
    @State private var llmRecommendedId: String?
    @State private var llmSelectedId: String?
    /// 상태/카탈로그 조회 실패 사유(섹션에 재시도 버튼과 함께 표시).
    @State private var llmLoadError: String?
    /// 다운로드/선택 액션 실패 사유 — 디스크 부족·실패 등을 섹션 안에 인라인으로 명확히 표시.
    @State private var llmError: String?
    /// 선택(select) in-flight 모델 — 그 행에 스피너를 띄운다.
    @State private var llmBusyModelId: String?
    /// 다운로드 진행 폴링 태스크 — 활성 다운로드 동안 ~1.5s 로 status 를 당겨 진행률을 갱신한다.
    @State private var llmPollTask: Task<Void, Never>?
    @Environment(\.scenePhase) private var scenePhase
    /// 미설치 CLI 의 «Mac 에 설치» 진행 스냅샷 (daemon 폴링 결과). nil 이면 아직 시작 안 함.
    @State private var installProgress: AgentInstallProgress?
    /// 진행 중인 설치 폴링 task — 어댑터 전환/시트 종료 시 취소.
    @State private var installTask: Task<Void, Never>?

    // MARK: - OpenCode 「내 로컬 서버 사용」 외부 엔드포인트 (opencode_external_v1)
    //
    // opencode 선택 + daemon 이 capability 지원 시에만 노출. 사용자가 이미 자기 Mac 에서 돌리는
    // OpenAI 호환 로컬 서버(Ollama/LM Studio/vLLM 등)를 baseURL+모델로 지정하면 daemon 이 번들
    // llama-server 를 건너뛰고 그대로 백엔드로 쓴다. 저장 전 /v1/models 헬스체크로 «막다른 길»
    // (연결했더니 서버가 없거나 모델명이 틀림)을 사전 차단한다.
    /// daemon 에서 마지막으로 읽어온 저장 설정 — draft 와 비교해 «변경됨(저장 필요)» 을 판단한다.
    @State private var opencodeLoaded: OpencodeExternalConfig?
    /// 편집용 draft — 토글/baseURL/모델 입력이 직접 바인딩된다.
    @State private var opencodeEnabledDraft = false
    @State private var opencodeBaseUrlDraft = ""
    @State private var opencodeModelDraft = ""
    /// 마지막 헬스체크 결과 — 도달성/모델 존재를 success/warning 으로 표면화. nil = 미확인.
    @State private var opencodeProbe: OpencodeExternalProbe?
    /// verify/save in-flight — 버튼 스피너 + 중복 클릭 방지.
    @State private var opencodeBusy = false
    /// 조회/저장/확인 실패 사유 — 섹션 안에 인라인으로 표시.
    @State private var opencodeError: String?
    // 도구 자동 승인 토글 — 기본 ON. 끄면 daemon 이 매 도구 호출마다 사용자에게 묻는다 (응답 멈춤).
    @State private var skipPermissions: Bool = true
    @State private var creating = false
    /// 생성 실패 사유 — non-nil 이면 alert 로 보여 준다 (로컬 LLM 동시 1개 초과 등).
    @State private var createError: String?
    @State private var recents: [RecentProject] = []
    @State private var loadingRecents = false
    @State private var loadError: String?
    @State private var manualMode = false
    @State private var filter = ""
    /// 파일시스템 디렉터리 자동완성 — 현재 경로 prefix 의 하위 디렉터리들 (daemon `/api/fs/list-dir`).
    /// recents 추측만으로는 한 번도 작업 안 한 폴더가 추천에 안 떠 전체를 타이핑해야 했다.
    /// fsDirsPrefix 는 fsDirs 가 어느 prefix 에 대한 결과인지 — race/stale 가드.
    @State private var fsDirs: [String] = []
    @State private var fsDirsPrefix: String = ""
    // 이어가기 — 데스크탑 Claude Code 세션 선택
    @State private var resumeCandidates: [DesktopSession] = []
    @State private var loadingResume = false
    @State private var resumeError: String?
    @State private var selectedResumeId: String? = nil
    // 레포 경로 / 이어받기 목록 펼치기 — 5개 초과면 첫 5개만 노출 + 더 보기 버튼.
    @State private var recentsExpanded = false
    @State private var resumeExpanded = false
    // worktree — 선택한 레포가 git 저장소이면, 채팅방에 들어가지 않고 여기서 바로 새 브랜치
    // worktree 를 만들어 그 안에서 세션을 시작할 수 있다. repoIsGit==true 일 때만 섹션 노출.
    @State private var repoIsGit = false
    @State private var repoBranch: String? = nil
    @State private var worktreeMode = false
    @State private var worktreeBranch = ""
    @Environment(\.dismiss) private var dismiss

    /// 숨김 처리된 경로를 먼저 제외한 «보이는» 레포 목록. 필터/더 보기 계산은 모두 이걸 기준.
    private var visibleRecentsBase: [RecentProject] {
        recents.filter { !hiddenItems.isRecentHidden($0.path) }
    }

    private var filteredRecents: [RecentProject] {
        let q = filter.trimmingCharacters(in: .whitespaces).lowercased()
        let base = visibleRecentsBase
        if q.isEmpty { return base }
        return base.filter { $0.path.lowercased().contains(q) }
    }

    /// 화면에 실제로 그릴 레포 목록. 필터가 비어 있고 6개 이상이면 5개로 자르고
    /// 나머지는 "더 보기" 버튼으로 노출. 필터가 켜져 있으면 결과를 전부 보여 준다
    /// (사용자가 명시적으로 좁힌 결과니까 또 자르면 혼란만 가중).
    private var visibleRecents: [RecentProject] {
        if filter.isEmpty && filteredRecents.count > 5 && !recentsExpanded {
            return Array(filteredRecents.prefix(5))
        }
        return filteredRecents
    }

    /// 숨김 항목을 제외한 이어받기 후보. 더 보기 / 자동 선택 처리도 이걸 기준으로 한다.
    private var resumeCandidatesVisible: [DesktopSession] {
        resumeCandidates.filter { !hiddenItems.isResumeHidden($0.sessionId) }
    }

    /// 이어 받기 후보도 같은 패턴. 별도 필터는 없으므로 단순 prefix.
    private var visibleResumeCandidates: [DesktopSession] {
        let base = resumeCandidatesVisible
        if base.count > 5 && !resumeExpanded {
            return Array(base.prefix(5))
        }
        return base
    }

    /// 단순 셸(zsh) 어댑터인지. shell 에는 "도구 자동 승인" / "데스크탑 이어받기" 가
    /// 의미 없어 두 섹션을 숨긴다. 새 단순-셸 어댑터가 늘면 이 분기를 daemon 의
    /// capability flag (예: `hide_bypass_permissions`, `hide_resume`) 로 일반화.
    private var agentIsPlainShell: Bool {
        selectedAgentId == "shell"
    }

    /// 로컬 LLM 어댑터(daemon `local_llm`, Qwen Code) 선택 여부. 준비 게이팅은 로컬 추론 군
    /// (local_llm+opencode)으로 일반화됐고, 이 플래그는 qwen 을 «요구하는» 분기(런타임 설치에
    /// qwen 행 노출, generic CLI 게이트에서 제외)에만 남는다 — opencode 는 qwen 불필요.
    private var agentIsLocalLlm: Bool {
        selectedAgentId == "local_llm"
    }

    /// 로컬 추론 백엔드를 공유하는 군(local_llm·opencode) 선택 여부 — 동시 1개 제약 + 준비
    /// 상태 카드/게이트(localLlmSection·localLlmReady·localLlmNeedsSetup)에 쓴다.
    private var agentIsLocalInference: Bool {
        selectedAgentId == "local_llm" || selectedAgentId == "opencode"
    }

    /// OpenCode 어댑터 선택 여부 — local_llm 과 같은 llama-server 백엔드+GGUF 를 공유하되 qwen 은
    /// 불필요(OpenCode 가 자체 CLI). 준비 판정에서 qwen 을 빼는 분기 + 「내 로컬 서버 사용」 외부
    /// 엔드포인트 섹션 게이팅에 쓴다.
    private var agentIsOpenCode: Bool {
        selectedAgentId == "opencode"
    }

    /// OpenCode CLI 가 Mac 에 설치돼 있는지 — 준비 카드의 「OpenCode CLI」 체크 행에 쓴다(설치
    /// 게이팅·설치 버튼은 generic CLI 경로 selectedAgentNeedsCliInstall/cliInstallFooter 가 전담).
    /// 옛 daemon 은 installed 를 안 보내 isInstalled==true → 「준비됨」 으로 본다(회귀 방지).
    private var opencodeCliInstalled: Bool {
        agents.first(where: { $0.id == "opencode" })?.isInstalled ?? true
    }

    /// daemon 이 OpenCode 외부 엔드포인트 모드를 지원하는지(opencode 어댑터의 `opencode_external_v1`
    /// capability). 옛 daemon 은 이 플래그가 없어 false → 섹션을 숨기고 라우트도 없으니 막다른 길 0.
    private var opencodeSupportsExternal: Bool {
        agents.first(where: { $0.id == "opencode" })?.capabilities.contains("opencode_external_v1") ?? false
    }

    /// draft 가 저장된 설정과 달라 «저장» 이 필요한 상태. 미조회면 false(저장 버튼 비활성).
    private var opencodeDirty: Bool {
        guard let loaded = opencodeLoaded else { return false }
        return loaded.enabled != opencodeEnabledDraft
            || loaded.baseUrl != opencodeBaseUrlDraft
            || loaded.modelId != opencodeModelDraft.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// «저장된» 외부 엔드포인트 모드가 켜져 있는지 — daemon 이 번들 llama-server 의 ensureServer 를
    /// 건너뛰고 사용자 서버를 백엔드로 쓰므로, 이때 opencode 는 번들 런타임/모델 준비 게이트를
    /// 받지 않는다. draft 가 아니라 저장값을 본다(실제 spawn 이 쓰는 진실과 일치).
    private var opencodeExternalActive: Bool {
        agentIsOpenCode && (opencodeLoaded?.enabled ?? false)
    }

    /// daemon 이 런타임 구성요소(llama-server/qwen)를 폰에서 한 탭으로 Mac 에 설치하는 라우트를
    /// 지원하는지(local_llm 어댑터의 `install_runtime_v1` capability). 옛 daemon 은 이 플래그가
    /// 없어 false → 폰은 기존 「Mac 에서 설치」 verbatim 안내로 폴백(회귀 없음).
    private var localLlmSupportsRuntimeInstall: Bool {
        agents.first(where: { $0.id == "local_llm" })?.capabilities.contains("install_runtime_v1") ?? false
    }

    /// 로컬 추론 에이전트를 골랐지만 이미 활성 로컬 추론 세션(local_llm/opencode)이 있어 생성이
    /// 막힌 상태. 「만들기」 버튼을 비활성화하고 도구 섹션에 안내를 띄운다.
    private var localLlmBlocked: Bool {
        agentIsLocalInference && localLlmActive
    }

    /// 로컬 추론(local_llm·opencode)을 골랐고 추론 서버 런타임이 빠진 상태 — 폰을 떠나지 않고
    /// 「로컬 LLM 모델」 카드에서 Mac 에 설치할 수 있다. local_llm 은 llama-server + qwen 둘 다,
    /// opencode 는 qwen 불필요라 llama-server 만 본다. status 미조회/실패 시엔 잘못된 경고를
    /// 띄우지 않도록 false(기존 「조회 전 안내 안 함」 동작 유지).
    private var localLlmNeedsSetup: Bool {
        guard agentIsLocalInference, !opencodeExternalActive, let st = llmStatus else { return false }
        return agentIsOpenCode ? !st.binaries.llamaServer : !st.binariesReady
    }

    /// 추론 서버·모델이 준비돼 로컬 추론 세션을 만들 수 있는 상태. 비-로컬추론 에이전트는 항상
    /// true(이 게이트와 무관). opencode 는 qwen 불필요(llama-server + 모델만), local_llm 은 qwen
    /// 까지 필요(binariesReady). opencode CLI 설치는 generic CLI 게이트(selectedAgentNeedsCliInstall)
    /// 가 따로 막는다. status 미조회/실패면 false(준비 확인 전 생성 차단 — 막다른 길 대신 섹션이
    /// 무엇이 빠졌는지 보여 준다).
    private var localLlmReady: Bool {
        guard agentIsLocalInference else { return true }
        // 외부 엔드포인트 모드면 번들 런타임/모델과 무관 — 사용자 서버가 백엔드라 항상 준비됨.
        if opencodeExternalActive { return true }
        guard let st = llmStatus else { return false }
        let binariesOK = agentIsOpenCode ? st.binaries.llamaServer : st.binariesReady
        return binariesOK && st.modelPresent
    }

    /// 로컬 추론을 골랐지만 아직 추론 서버/모델이 준비되지 않아 「만들기」 를 막아야 하는 상태.
    private var localLlmCreateBlocked: Bool {
        agentIsLocalInference && !localLlmReady
    }

    /// 추론 서버는 있는데 선택 모델만 아직 안 받은 상태 — 런타임 설치 안내가 아니라 모델 다운로드만
    /// 유도하는 푸터를 띄우는 데 쓴다. status 미조회/실패면 false.
    private var localLlmModelMissing: Bool {
        guard agentIsLocalInference, !opencodeExternalActive, let st = llmStatus else { return false }
        let binariesOK = agentIsOpenCode ? st.binaries.llamaServer : st.binariesReady
        return binariesOK && !st.modelPresent
    }

    /// 선택된 agent (local_llm 제외) 의 CLI 가 Mac 에 설치돼 있지 않은 상태. 옛 daemon 은
    /// installed 를 안 보내 isInstalled==true → 게이팅 안 함 (기존 동작). local_llm 은 위
    /// localLlmNeedsSetup(qwen+llama-server) 가 전담하므로 여기서 제외한다. 이 게이팅이
    /// 미설치 CLI 로 세션을 만들어 첫 메시지에서 빈 화면(silent failure)을 밟는 걸 막는다.
    private var selectedAgentNeedsCliInstall: Bool {
        guard !agentIsLocalLlm else { return false }
        guard let a = agents.first(where: { $0.id == selectedAgentId }) else { return false }
        return !a.isInstalled
    }

    /// 선택된 에이전트가 프로 전용이면 그 ProFeature(shell→.terminal / local_llm→.localLLM), 아니면 nil.
    private var selectedAgentProFeature: ProFeature? {
        ProFeature.forAgent(selectedAgentId)
    }

    /// Terminal(shell)·Local LLM(local_llm) 은 프로 전용 — 미보유 사용자는 이 에이전트로 세션을
    /// 만들 수 없다(만들기 비활성 + 푸터 안내). 무료 단계(iapEnabled=false)엔 isUnlocked=true 라 통과.
    private var proAgentBlocked: Bool {
        guard let f = selectedAgentProFeature else { return false }
        return !purchase.isUnlocked(f)
    }

    /// worktree 생성은 프로 전용 — 미보유 사용자가 토글을 켜려 하면 페이월로 보낸다(채팅
    /// BranchSheet 의 worktree 게이트와 통일). 토글 자체를 막으므로 worktreeMode 가 «프로 없이»
    /// true 가 되는 경로가 없다 — 단, createTapped 에서도 방어적으로 한 번 더 막는다.
    private var worktreeProBlocked: Bool {
        !purchase.isUnlocked(.worktree)
    }

    /// 선택된 미설치 agent 의 설치 명령/URL (daemon 동봉, 코드성 문자열). 없으면 nil.
    private var selectedAgentInstallHint: String? {
        agents.first(where: { $0.id == selectedAgentId })?.installHint
    }

    /// 선택된 미설치 agent 의 installHint 가 «실행 가능한 명령» 인지 (URL 이 아님). true 면
    /// 「Mac 에 설치」 버튼으로 자동 설치, false (agy 의 URL) 면 링크 안내로 폴백.
    private var selectedAgentInstallHintIsCommand: Bool {
        agents.first(where: { $0.id == selectedAgentId })?.installHintIsCommand ?? false
    }

    /// 도구 옵션 표시 색 — Terminal(shell)·Local LLM(local_llm)·OpenCode(opencode) 같은 «고급
    /// 도구» 는 주황(Theme.pro)으로 구분한다 (앱의 «주황=프로/고급» 약속색). 일반 코드 에이전트는 기본색.
    private func agentOptionColor(_ id: String) -> Color {
        (id == "shell" || id == "local_llm" || id == "opencode") ? Theme.pro : .primary
    }

    /// 옵션 행에 「설정 필요」 마커를 붙일지 — local_llm 은 런타임(qwen+llama-server)·선택 모델,
    /// opencode 는 llama-server·선택 모델·OpenCode CLI(qwen 불필요), 그 외 agent 는 CLI 바이너리
    /// 미설치(daemon installed=false) 기준. 로컬 추론은 status 가 로드된 뒤에만 판단해(미조회 중
    /// false-positive 깜빡임 방지) 마커를 붙인다.
    private func agentNeedsSetupMarker(_ a: AgentInfo) -> Bool {
        if a.id == "local_llm" {
            return llmStatus.map { !($0.binariesReady && $0.modelPresent) } ?? false
        } else if a.id == "opencode" {
            let runtimeMissing = llmStatus.map { !($0.binaries.llamaServer && $0.modelPresent) } ?? false
            return runtimeMissing || !a.isInstalled
        } else {
            return !a.isInstalled
        }
    }

    /// 도구 선택 inline picker 의 한 옵션 행. shell/local_llm/opencode 는 주황, 준비 안 된
    /// 어댑터는 「설정 필요」 마커를 붙인다.
    @ViewBuilder
    private func agentOptionRow(_ a: AgentInfo) -> some View {
        let needsSetup = agentNeedsSetupMarker(a)
        HStack(spacing: 8) {
            Image(systemName: AgentKind.from(id: a.id).systemImage)
                .foregroundStyle(agentOptionColor(a.id))
            Text(a.displayName)
                .foregroundStyle(agentOptionColor(a.id))
            if needsSetup {
                Text("설정 필요")
                    .font(.caption2)
                    .foregroundStyle(Theme.warning)
            }
            // 프로 전용 에이전트(Terminal·로컬 LLM) — 미보유면 «프로» 마커로 결제 필요를 표시.
            if let f = ProFeature.forAgent(a.id), !purchase.isUnlocked(f) {
                Text("프로")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(Theme.pro)
            }
        }
    }

    /// 도구 섹션 푸터 — 우선순위: Mac 런타임 미설치 안내 > 동시 1개 제약 > 일반 설명.
    @ViewBuilder
    private var toolFooter: some View {
        if proAgentBlocked {
            VStack(alignment: .leading, spacing: 4) {
                Text("Terminal·로컬 LLM 은 프로 전용이에요. 프로 구독 또는 평생 이용권으로 잠금을 해제하세요.")
                Button("프로 보기") { paywallFeature = selectedAgentProFeature }
                    .font(.caption2.weight(.semibold))
            }
            .font(.caption2)
            .foregroundStyle(Theme.pro)
        } else if localLlmNeedsSetup {
            if localLlmSupportsRuntimeInstall {
                // 막다른 길 제거 — 아래 「로컬 LLM 모델」 카드에서 폰으로 바로 설치 가능.
                if agentIsOpenCode {
                    // opencode 는 qwen 불필요 — 추론 서버만 런타임 설치. OpenCode CLI 는 아래
                    // generic CLI 설치(cliInstallFooter)가 전담한다.
                    Text("로컬 추론을 실행하려면 추론 서버(llama.cpp)가 필요해요. 아래 「로컬 LLM 모델」 에서 폰으로 바로 설치할 수 있어요.")
                        .font(.caption2)
                        .foregroundStyle(Theme.warning)
                } else {
                    Text("로컬 LLM 을 실행하려면 추론 서버(llama.cpp)와 에이전트 CLI(Qwen Code)가 필요해요. 아래 「로컬 LLM 모델」 에서 폰으로 바로 설치할 수 있어요.")
                        .font(.caption2)
                        .foregroundStyle(Theme.warning)
                }
            } else {
                if agentIsOpenCode {
                    Text("로컬 추론을 실행하려면 Mac 앱에서 추가 설정이 필요해요. Mac 앱 → 설정 → 로컬 LLM 탭에서 추론 서버(llama.cpp)를 설치하세요.")
                        .font(.caption2)
                        .foregroundStyle(Theme.warning)
                } else {
                    Text("로컬 LLM 을 실행하려면 Mac 앱에서 추가 설정이 필요해요. Mac 앱 → 설정 → 로컬 LLM 탭에서 추론 서버(llama.cpp)와 에이전트 CLI(Qwen Code)를 설치하세요.")
                        .font(.caption2)
                        .foregroundStyle(Theme.warning)
                }
            }
        } else if selectedAgentNeedsCliInstall {
            cliInstallFooter
        } else if localLlmModelMissing {
            // 추론 서버·CLI 는 있고 모델만 없음 — 막다른 길 대신 아래 카드에서 모델만 받게 유도.
            Text("선택한 모델이 아직 다운로드되지 않았어요. 아래 「로컬 LLM 모델」 에서 모델을 받아 주세요.")
                .font(.caption2)
                .foregroundStyle(Theme.warning)
        } else if localLlmBlocked {
            Text("로컬 추론 세션은 메모리를 많이 차지해 한 번에 하나만 만들 수 있어요. 기존 로컬 추론 세션을 먼저 종료하세요.")
                .font(.caption2)
                .foregroundStyle(Theme.warning)
        } else {
            Text("이 세션에서 사용할 CLI 도구입니다. daemon 에 등록된 어댑터가 모두 노출됩니다.")
                .font(.caption2)
        }
    }

    // MARK: - 로컬 추론 준비 상태 + 모델 관리 섹션
    //
    // 로컬 추론(local_llm·opencode) 선택 시 노출. 단일 boolean 환원 대신 daemon `/api/local-llm/status`
    // 세부(바이너리·선택 모델·다운로드 진행)를 상태 카드로 표면화하고, 카탈로그를 받아 폰에서
    // 다운로드 시작/취소·모델 선택을 직접 처리한다. 두 어댑터는 같은 llama-server 백엔드+GGUF 를
    // 공유한다 — opencode 는 qwen 불필요라 그 행을 OpenCode CLI 로 바꾸고 런타임 설치에서 qwen 을
    // 건너뛴다. 「Mac 에서 설치」 안내는 추론 서버 바이너리가 빠진 경우만 유지(Mac 권한 영역).
    // 색: 상태=success/warning, 다운로드 진행은 기본 accent(주황 pro·노랑 warning 오용 금지).

    @ViewBuilder
    private var localLlmSection: some View {
        // 외부 엔드포인트 모드(opencode)면 번들 런타임 준비/설치 카드는 무의미 — 숨긴다.
        if agentIsLocalInference && !opencodeExternalActive {
            Section {
                if let st = llmStatus {
                    llmStatusCard(st)
                    // 런타임 설치가 필요한 추론 서버 바이너리 — opencode 는 llama-server 만, local_llm
                    // 은 llama-server+qwen. (opencode CLI 는 generic CLI 설치가 전담.)
                    let runtimeMissing = agentIsOpenCode ? !st.binaries.llamaServer : !st.binariesReady
                    if runtimeMissing {
                        if localLlmSupportsRuntimeInstall {
                            // 막다른 길 제거 — 폰을 떠나지 않고 빠진 구성요소만 Mac 에 바로 설치.
                            llmRuntimeInstall(st)
                        } else if agentIsOpenCode {
                            // 옛 daemon — 설치 라우트 없음. opencode 는 추론 서버만 안내(qwen 불필요).
                            Text("추론 서버(llama.cpp)는 Mac 에서 설치해야 해요. Mac 앱 → 설정 → 로컬 LLM 탭에서 설치하세요.")
                                .font(.caption2)
                                .foregroundStyle(Theme.warning)
                                .fixedSize(horizontal: false, vertical: true)
                        } else {
                            // 옛 daemon — 설치 라우트 없음. 기존 안내로 폴백(회귀 없음).
                            Text("추론 서버(llama.cpp)와 에이전트 CLI(Qwen Code)는 Mac 에서 설치해야 해요. Mac 앱 → 설정 → 로컬 LLM 탭에서 설치하세요.")
                                .font(.caption2)
                                .foregroundStyle(Theme.warning)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    ForEach(llmModels) { m in
                        llmModelRow(m, status: st)
                    }
                } else if let llmLoadError {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("로컬 LLM 상태를 불러오지 못했어요.")
                            .font(.caption)
                        Text(llmLoadError)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                        Button("다시 시도") { Task { await loadLocalLlm() } }
                            .font(.caption)
                    }
                } else {
                    HStack(spacing: 8) {
                        ProgressView()
                        Text("로컬 LLM 상태 확인 중…")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                if let llmError {
                    Text(llmError)
                        .font(.caption2)
                        .foregroundStyle(Theme.danger)
                        .fixedSize(horizontal: false, vertical: true)
                }
            } header: {
                Text("로컬 LLM 모델")
            } footer: {
                if agentIsOpenCode {
                    Text("폰에서 모델을 받아 두면 Mac 앞으로 가지 않고 바로 로컬 추론 세션을 시작할 수 있어요. OpenCode 는 같은 모델을 공유해요. 추론 서버·OpenCode CLI 설치는 Mac 에서만 가능해요.")
                        .font(.caption2)
                } else {
                    Text("폰에서 모델을 받아 두면 Mac 앞으로 가지 않고 바로 로컬 LLM 세션을 시작할 수 있어요. 추론 서버·에이전트 CLI 설치는 Mac 에서만 가능해요.")
                        .font(.caption2)
                }
            }
        }
    }

    // MARK: - OpenCode 「내 로컬 서버 사용」 외부 엔드포인트 섹션
    //
    // opencode 선택 + daemon capability(opencode_external_v1) 일 때만 노출. 켜면 사용자가 이미
    // 돌리는 OpenAI 호환 로컬 서버(Ollama 등)를 그대로 백엔드로 쓴다 — 번들 모델 중복 다운로드
    // 없이 «내 모델 그대로». 저장 전 /v1/models 헬스체크로 도달성·모델 존재를 검증해 막다른 길을
    // 사전 차단한다. 색: 「고급 도구」 약속색 주황(Theme.pro) 헤더, 확인 결과 success/warning.

    @ViewBuilder
    private var opencodeSection: some View {
        if agentIsOpenCode && opencodeSupportsExternal {
            Section {
                Toggle(isOn: $opencodeEnabledDraft) {
                    Label("내 로컬 서버 사용", systemImage: "server.rack")
                        .foregroundStyle(Theme.pro)
                }
                .tint(Theme.pro)
                .onChange(of: opencodeEnabledDraft) { _ in opencodeProbe = nil }

                if opencodeEnabledDraft {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("서버 주소")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                        // baseURL·모델 id 는 코드성 식별자라 번역/자동대문자/자동수정 대상 아님.
                        TextField("http://localhost:11434/v1", text: $opencodeBaseUrlDraft)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .keyboardType(.URL)
                            .font(.callout.monospaced())
                            .onChange(of: opencodeBaseUrlDraft) { _ in opencodeProbe = nil }
                    }
                    VStack(alignment: .leading, spacing: 4) {
                        Text("모델 이름")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                        TextField("qwen2.5-coder", text: $opencodeModelDraft)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .font(.callout.monospaced())
                            .onChange(of: opencodeModelDraft) { _ in opencodeProbe = nil }
                    }

                    // 확인(/v1/models 헬스체크) + 저장. 확인은 입력값으로 바로, 저장은 변경 있을 때만.
                    HStack(spacing: 12) {
                        Button {
                            Task { await verifyOpencode() }
                        } label: {
                            if opencodeBusy {
                                ProgressView()
                            } else {
                                Label("연결 확인", systemImage: "antenna.radiowaves.left.and.right")
                                    .font(.caption.weight(.semibold))
                            }
                        }
                        .disabled(opencodeBusy || opencodeBaseUrlDraft.trimmingCharacters(in: .whitespaces).isEmpty)
                        Spacer()
                        Button("저장") { Task { await saveOpencode() } }
                            .font(.caption.weight(.semibold))
                            .disabled(opencodeBusy || !opencodeDirty)
                    }

                    if let probe = opencodeProbe {
                        opencodeProbeResult(probe)
                    }
                } else if opencodeDirty {
                    // 끄기만 한 상태도 저장이 필요 — 명시 버튼으로.
                    HStack {
                        Spacer()
                        Button("저장") { Task { await saveOpencode() } }
                            .font(.caption.weight(.semibold))
                            .disabled(opencodeBusy)
                    }
                }

                if let opencodeError {
                    Text(opencodeError)
                        .font(.caption2)
                        .foregroundStyle(Theme.danger)
                        .fixedSize(horizontal: false, vertical: true)
                }
            } header: {
                Text("로컬 서버")
            } footer: {
                if opencodeEnabledDraft {
                    Text("이미 Mac 에서 돌리고 있는 OpenAI 호환 로컬 서버(Ollama·LM Studio·vLLM 등)를 그대로 씁니다. 번들 모델을 새로 받지 않고 내가 고른 모델로 OpenCode 를 실행해요. 저장 전 「연결 확인」 으로 서버가 떠 있고 모델 이름이 맞는지 점검하세요.")
                        .font(.caption2)
                } else {
                    Text("켜면 번들 추론 서버 대신 내가 직접 돌리는 OpenAI 호환 로컬 서버를 OpenCode 백엔드로 씁니다. 꺼져 있으면 번들 llama.cpp 를 사용해요.")
                        .font(.caption2)
                }
            }
        }
    }

    /// 헬스체크 결과 표시 — 정상이면 success(초록), 도달 불가/모델 없음 등은 warning(노랑, 진짜
    /// 「설정 필요」 경고라 warning 이 맞다 — 주황 pro 와 혼동 금지). 서버가 보고한 모델 목록도
    /// 곁들여 사용자가 올바른 이름을 고를 수 있게 한다.
    @ViewBuilder
    private func opencodeProbeResult(_ probe: OpencodeExternalProbe) -> some View {
        let ok = probe.error == nil
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Image(systemName: ok ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                    .foregroundStyle(ok ? Theme.success : Theme.warning)
                Text(opencodeProbeMessage(probe))
                    .font(.caption)
                    .foregroundStyle(ok ? Theme.success : Theme.warning)
                    .fixedSize(horizontal: false, vertical: true)
            }
            // 서버가 모델을 보고했고 설정 모델이 그 안에 없을 때 — 어떤 이름을 써야 하는지 노출.
            if !probe.models.isEmpty && !probe.modelPresent {
                Text("사용 가능한 모델: \(probe.models.prefix(8).joined(separator: ", "))")
                    .font(.caption2.monospaced())
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    /// 헬스체크 결과를 사람이 읽는 한 줄로. error 코드별 안내(막다른 길의 «왜» 를 설명).
    private func opencodeProbeMessage(_ probe: OpencodeExternalProbe) -> LocalizedStringKey {
        switch probe.error {
        case nil: return "연결됨 · 모델 확인됨"
        case "unreachable": return "서버에 연결할 수 없어요. 주소가 맞고 서버가 켜져 있는지 확인하세요."
        case "http_error": return "서버가 오류를 돌려줬어요. 주소(특히 /v1 경로)를 확인하세요."
        case "bad_response": return "응답을 이해할 수 없어요. OpenAI 호환 서버가 맞는지 확인하세요."
        case "no_models": return "서버는 떠 있지만 제공하는 모델이 없어요. 서버에서 모델을 먼저 로드하세요."
        case "model_not_found": return "서버에 그 모델이 없어요. 아래 목록에서 정확한 이름을 골라 입력하세요."
        default: return "연결을 확인하지 못했어요."
        }
    }

    /// 준비 상태 카드 — 하드웨어 + 「추론 서버 / 에이전트 CLI / 선택 모델」 체크리스트.
    @ViewBuilder
    private func llmStatusCard(_ st: LocalLlmStatus) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            // "Apple M4 Pro · 64 GB" — 칩/용량은 번역 대상 아님.
            let ram = Int((Double(st.hardware.totalRamBytes) / 1_073_741_824).rounded())
            let chip = st.hardware.chipBrand ?? "Mac"
            HStack(spacing: 8) {
                Image(systemName: "memorychip")
                    .foregroundStyle(.secondary)
                Text(verbatim: "\(chip) · \(ram) GB")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
                Spacer()
            }
            llmCheckRow(ok: st.binaries.llamaServer, label: "추론 서버 (llama.cpp)")
            // opencode 는 qwen 불필요 — 그 행을 OpenCode CLI 행으로 대체(설치는 generic CLI 경로).
            // local_llm 은 기존대로 Qwen Code 행.
            if agentIsOpenCode {
                llmCheckRow(ok: opencodeCliInstalled, label: "OpenCode CLI")
            } else {
                llmCheckRow(ok: st.binaries.qwen, label: "에이전트 CLI (Qwen Code)")
            }
            llmCheckRow(ok: st.modelPresent, label: "선택 모델 다운로드")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// 체크리스트 한 줄 — 준비됨(초록 success) / 필요(노랑 warning). 「필요」 는 진짜 미설치
    /// 경고라 warning(노랑)이 맞다(주황 pro 와 혼동 금지).
    @ViewBuilder
    private func llmCheckRow(ok: Bool, label: LocalizedStringKey) -> some View {
        HStack(spacing: 8) {
            Image(systemName: ok ? "checkmark.circle.fill" : "exclamationmark.circle.fill")
                .foregroundStyle(ok ? Theme.success : Theme.warning)
            Text(label)
                .font(.caption)
            Spacer()
            (ok ? Text("준비됨") : Text("필요"))
                .font(.caption2.weight(.semibold))
                .foregroundStyle(ok ? Theme.success : Theme.warning)
        }
    }

    /// 런타임 구성요소(추론 서버/CLI) 설치 — 빠진 것만 「Mac 에 설치」 버튼을 보이고, 누르면
    /// daemon 이 설치하는 동안 진행/로그/완료/실패를 그 자리에 표시한다(8ffc54d2 CLI 설치와 동일
    /// UX). 색: 안내=secondary, 버튼=기본 accent(주황 pro 오용 금지).
    @ViewBuilder
    private func llmRuntimeInstall(_ st: LocalLlmStatus) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if agentIsOpenCode {
                // opencode 는 추론 서버만 런타임 설치(qwen 불필요). OpenCode CLI 는 아래 generic
                // CLI 설치(cliInstallFooter)가 전담.
                Text("추론 서버를 폰을 떠나지 않고 Mac 에 바로 설치할 수 있어요.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                Text("추론 서버·에이전트 CLI 를 폰을 떠나지 않고 Mac 에 바로 설치할 수 있어요.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if !st.binaries.llamaServer {
                llmComponentInstallRow(component: "llama-server", label: "추론 서버 (llama.cpp)")
            }
            // qwen 은 local_llm 전용 — opencode 는 건너뛴다(자체 OpenCode CLI 사용).
            if !agentIsOpenCode && !st.binaries.qwen {
                llmComponentInstallRow(component: "qwen", label: "에이전트 CLI (Qwen Code)")
            }
        }
        .font(.caption2)
    }

    /// 구성요소 한 줄 — 설치 전엔 라벨 + 「Mac 에 설치」, 설치 중/후엔 진행 상태(스피너·로그·완료/실패).
    /// 진행 스냅샷의 adapterId(`local_llm/<component>`)가 이 행과 일치할 때만 진행 UI 를 그린다 —
    /// 한 번에 한 구성요소만 설치되므로 다른 행 버튼은 그 동안 비활성.
    @ViewBuilder
    private func llmComponentInstallRow(component: String, label: LocalizedStringKey) -> some View {
        let targetId = "local_llm/\(component)"
        let active = installProgress.map { $0.adapterId == targetId } ?? false
        VStack(alignment: .leading, spacing: 6) {
            if active, let p = installProgress, p.isInstalling || p.isError || p.isDone {
                HStack(spacing: 6) {
                    Text(label).font(.caption.weight(.medium))
                    Spacer()
                }
                installProgressView(p)
                // brew 미설치 Mac — 막다른 길로 되돌아가지 않게 명확히 안내.
                if p.isError && component == "llama-server" {
                    brewMissingFallback
                }
            } else {
                HStack(spacing: 8) {
                    Text(label).font(.caption)
                    Spacer()
                    Button {
                        startComponentInstall(component)
                    } label: {
                        Label("Mac 에 설치", systemImage: "arrow.down.circle")
                            .font(.caption2.weight(.semibold))
                    }
                    // 한 번에 하나만 — 다른 구성요소 설치 중엔 비활성(daemon 도 409 busy).
                    .disabled(installProgress?.isInstalling ?? false)
                }
            }
        }
    }

    /// llama.cpp 설치 실패 시 Homebrew 부재 폴백 안내 — brew.sh 링크로 막힘을 푼다.
    private var brewMissingFallback: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Homebrew 가 없으면 llama.cpp 를 설치할 수 없어요. brew.sh 에서 Homebrew 를 설치한 뒤 다시 시도하세요.")
                .font(.caption2)
                .foregroundStyle(Theme.warning)
                .fixedSize(horizontal: false, vertical: true)
            Link(destination: URL(string: "https://brew.sh")!) {
                Label("brew.sh 열기", systemImage: "safari")
                    .font(.caption2.weight(.semibold))
            }
        }
    }

    /// 카탈로그 모델 한 행 — 뱃지(추천/선택됨/받음) + 용량 + 권장 RAM, 그리고 다운로드 진행 또는
    /// 다운로드/선택 액션.
    @ViewBuilder
    private func llmModelRow(_ m: LocalLlmCatalogModel, status st: LocalLlmStatus) -> some View {
        let recRam = Int((Double(m.recommendedRamBytes) / 1_073_741_824).rounded())
        let tight = st.hardware.totalRamBytes < m.recommendedRamBytes
        let downloadingThis = st.download.modelId == m.id && st.download.active
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Text(verbatim: m.displayName)
                    .font(.subheadline.weight(.semibold))
                if m.id == llmRecommendedId { llmBadge("추천", Theme.success) }
                if m.id == llmSelectedId { llmBadge("선택됨", Theme.accent) }
                if m.downloaded { llmBadge("받음", .secondary) }
                Spacer()
                Text(verbatim: llmSizeGB(m.fileSizeBytes))
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            Text(verbatim: m.description)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 6) {
                Text(verbatim: "≥ \(recRam) GB RAM · ~\(Int(m.estDecodeTokSec)) tok/s")
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(tight ? Theme.warning : .secondary)
                if tight {
                    Text("이 Mac 메모리엔 빠듯할 수 있어요")
                        .font(.caption2)
                        .foregroundStyle(Theme.warning)
                }
                Spacer()
                // 도구호출 적합성 — 의미 토큰 준수: «분석 전용»은 진짜 경고라 warning(노랑),
                // 도구호출 가능은 정상값이라 중립(secondary). pro(주황)·success(초록) 빌려쓰지 않음.
                if m.isToolCallCapable {
                    Label("도구호출", systemImage: "wrench.and.screwdriver")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                } else {
                    Label("분석 전용", systemImage: "exclamationmark.triangle.fill")
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(Theme.warning)
                }
            }
            if downloadingThis {
                llmDownloadProgress(st.download)
            } else {
                llmModelActions(m, status: st)
            }
        }
        .padding(.vertical, 4)
    }

    private func llmBadge(_ text: LocalizedStringKey, _ color: Color) -> some View {
        Text(text)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(color.opacity(0.18))
            .foregroundStyle(color)
            .clipShape(Capsule())
    }

    /// 진행률 + 취소. 진행 막대는 기본 틴트(accent) — status 색을 진행 표시에 빌려쓰지 않는다.
    @ViewBuilder
    private func llmDownloadProgress(_ d: LocalLlmDownloadProgress) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            if d.state == "verifying" {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("검증 중…").font(.caption2)
                }
            } else {
                ProgressView(value: min(1, max(0, d.percent / 100)))
                Text(verbatim: llmProgressText(d))
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            Button(role: .destructive) {
                Task { await cancelLlmDownload() }
            } label: {
                Label("취소", systemImage: "xmark.circle")
            }
            .font(.caption2)
            .controlSize(.small)
        }
    }

    @ViewBuilder
    private func llmModelActions(_ m: LocalLlmCatalogModel, status st: LocalLlmStatus) -> some View {
        HStack(spacing: 12) {
            if m.downloaded {
                if m.id != llmSelectedId {
                    Button {
                        Task { await selectLlmModel(m.id) }
                    } label: {
                        Label("선택", systemImage: "checkmark.circle")
                    }
                    .font(.caption)
                    // 분석 전용(도구호출 불가) 모델은 에이전트 백엔드로 못 쓴다 — 선택 비활성.
                    .disabled(llmBusyModelId != nil || !m.isToolCallCapable)
                }
            } else {
                Button {
                    Task { await startLlmDownload(m.id) }
                } label: {
                    Label("다운로드", systemImage: "arrow.down.circle")
                }
                .font(.caption)
                .disabled(st.download.active || llmBusyModelId != nil)
            }
            Spacer()
            if llmBusyModelId == m.id {
                ProgressView().controlSize(.small)
            }
        }
    }

    // MARK: 로컬 LLM 표시 헬퍼 (번역 대상 아님 — 숫자/단위)

    private func llmSizeGB(_ bytes: Int64) -> String {
        String(format: "%.1f GB", Double(bytes) / 1_000_000_000)
    }

    private func llmProgressText(_ d: LocalLlmDownloadProgress) -> String {
        let pct = Int(d.percent.rounded())
        if d.bytesPerSec > 0 {
            let mbps = String(format: "%.0f", d.bytesPerSec / 1_000_000)
            return "\(pct)% · \(mbps) MB/s"
        }
        return "\(pct)%"
    }

    /// 미설치 CLI 푸터 — installHint 가 명령이면 「Mac 에 설치」 버튼(폰을 안 떠나고 설치),
    /// URL(agy)이면 기존 안내 + 링크. 설치가 시작되면 진행/로그/완료/실패를 그 자리에 표시한다.
    @ViewBuilder
    private var cliInstallFooter: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let p = installProgress, p.isInstalling || p.isError || p.isDone {
                // 진행/완료/실패 — 진행이 시작된 뒤엔 상태 UI 가 안내문을 대체.
                installProgressView(p)
            } else if selectedAgentInstallHintIsCommand {
                // 자동 설치 가능 — Mac 책상으로 돌아가지 않고 폰에서 바로 설치.
                Text("이 코드 에이전트 CLI 가 Mac 에 아직 설치돼 있지 않아요. 폰을 떠나지 않고 Mac 에서 바로 설치할 수 있어요.")
                    .foregroundStyle(Theme.warning)
                Button {
                    startInstall()
                } label: {
                    Label("Mac 에 설치", systemImage: "arrow.down.circle")
                        .font(.caption2.weight(.semibold))
                }
                if let hint = selectedAgentInstallHint {
                    Text(verbatim: hint)
                        .font(.caption2.monospaced())
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }
            } else {
                // URL hint (agy) 또는 hint 없음 — 자동 설치 불가, 기존 안내 + 링크.
                Text("이 코드 에이전트 CLI 가 Mac 에 설치돼 있지 않아요. Mac 앱이 실행 중인 데스크탑에서 설치한 뒤 다시 시도하세요.")
                    .foregroundStyle(Theme.warning)
                if let hint = selectedAgentInstallHint {
                    if let url = URL(string: hint) {
                        Link(destination: url) {
                            Label("설치 가이드 열기", systemImage: "safari")
                                .font(.caption2.weight(.semibold))
                        }
                    } else {
                        Text(verbatim: hint)
                            .font(.caption2.monospaced())
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                    }
                }
            }
        }
        .font(.caption2)
    }

    /// 설치 진행 표시 — 스피너+상태, 누적 로그(말미), 실패 시 원문 명령 복사 폴백 + 재시도.
    @ViewBuilder
    private func installProgressView(_ p: AgentInstallProgress) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                if p.isInstalling {
                    ProgressView()
                    Text("Mac 에 설치하는 중…")
                        .foregroundStyle(.secondary)
                } else if p.isDone {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(Theme.success)
                    Text("설치 완료")
                        .foregroundStyle(Theme.success)
                } else {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(Theme.danger)
                    Text("설치 실패")
                        .foregroundStyle(Theme.danger)
                }
            }
            .font(.caption2)
            // 누적 stdout/stderr — 모노스페이스, 스크롤. 로그는 코드성이라 verbatim.
            if !p.log.isEmpty {
                ScrollView {
                    Text(verbatim: p.log)
                        .font(.system(.caption2, design: .monospaced))
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                }
                .frame(maxHeight: 120)
            }
            if p.isError {
                // 막다른 길이 아니라 폴백 — 원문 명령을 Mac 터미널에서 직접 실행하도록 안내.
                Text("자동 설치에 실패했어요. 아래 명령을 Mac 터미널에서 직접 실행한 뒤 다시 시도하세요.")
                    .font(.caption2)
                    .foregroundStyle(Theme.danger)
                // brew 자체가 없어 실패한 경우만 (daemon homebrew_missing) — 정확한 Homebrew 설치
                // 안내로 분기. 빌드 오류 등 다른 실패엔 띄우지 않아 오해를 막는다.
                if p.isHomebrewMissing {
                    Text("Homebrew 가 없으면 llama.cpp 를 설치할 수 없어요. Mac 에서 brew.sh 의 Homebrew 를 설치한 뒤 다시 시도하세요.")
                        .font(.caption2)
                        .foregroundStyle(Theme.danger)
                }
                // npm/node 자체가 없어 실패한 경우 (daemon node_missing) — 정확한 Node.js 설치 안내로
                // 분기. npm 설치 명령은 Node.js 가 깔려 있어야 동작하는데 그 전제가 안내에 빠져 있었다.
                if p.isNodeMissing {
                    Text("Node.js(npm) 가 없으면 이 CLI 를 설치할 수 없어요. Mac 에서 nodejs.org 의 Node.js 를 설치한 뒤 다시 시도하세요.")
                        .font(.caption2)
                        .foregroundStyle(Theme.danger)
                }
                if let cmd = p.command ?? selectedAgentInstallHint {
                    Text(verbatim: cmd)
                        .font(.caption2.monospaced())
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }
                Button {
                    retryInstall(for: p)
                } label: {
                    Label("다시 설치", systemImage: "arrow.clockwise")
                        .font(.caption2.weight(.semibold))
                }
            }
        }
    }

    var body: some View {
        NavigationStack {
            Form {
                // 제목을 최상단으로. 시트가 열리는 순간 사용자가 가장 먼저 입력하는 필드 →
                // 레포/이어받기 목록을 한참 스크롤할 필요 없음. 빈칸이면 "제목 없음" 으로 저장.
                Section {
                    VoiceInputField("이 세션의 이름 (선택)", text: $title)
                } header: {
                    Text("제목")
                } footer: {
                    Text("비워두면 제목 없는 세션이 됩니다.")
                        .font(.caption2)
                }

                Section {
                    // inline 스타일 — 각 옵션을 행으로 그려야 텍스트 색(주황)이 안정적으로
                    // 적용된다 (.menu 는 시스템 UIMenu 라 항목 색을 무시함).
                    Picker(selection: $selectedAgentId) {
                        ForEach(agents) { a in
                            agentOptionRow(a).tag(a.id)
                        }
                    } label: {
                        Text("CLI 도구")
                    }
                    .pickerStyle(.inline)
                    .labelsHidden()
                    .accessibilityLabel(Text("CLI 도구"))
                    // 선택 체크 표시는 환경 tint 색을 따른다 → accent(보라)로 명시.
                    // 행 텍스트색(agentOptionColor: 주황/기본)은 foregroundStyle 로 따로 칠해져 영향 없음.
                    .tint(Theme.accent)
                } header: {
                    Text("도구")
                } footer: {
                    toolFooter
                }

                // 로컬 LLM 선택 시 — 준비 상태(바이너리·선택 모델) 표면화 + 카탈로그 다운로드/선택.
                // 막다른 길(한 줄 안내) 대신 폰에서 해결 가능한 것은 폰에서 처리하게 한다.
                localLlmSection

                // OpenCode 선택 시 — 「내 로컬 서버 사용」 외부 엔드포인트 설정(Ollama 등).
                opencodeSection

                if !agentIsPlainShell {
                    Section {
                        Toggle(isOn: $skipPermissions) {
                            // 프로 전용 기능이 아니므로 일반색(.primary)으로 — 주황은 «프로» 약속색이라
                            // 여기 쓰지 않는다. 켜짐/꺼짐 안내는 아래 footer 가 명확히 설명한다.
                            Label("도구 자동 승인", systemImage: "lock.open.fill")
                                .foregroundStyle(.primary)
                        }
                    } header: {
                        Text("권한")
                    } footer: {
                        if skipPermissions {
                            Text("켜져 있어요. bash / Write / Edit 같은 파일·셸 도구가 매번 묻지 않고 곧바로 실행됩니다. 신뢰하는 레포에서만 사용하세요.")
                                .font(.caption2)
                        } else {
                            Text("꺼져 있어요. 도구를 쓸 때마다 에이전트가 텍스트로 승인을 요청해, 응답이 잠시 멈출 수 있습니다.")
                                .font(.caption2)
                        }
                    }
                }

                Section {
                    // 파일 탐색기로 폴더 선택 — 텍스트로 전체 경로를 타이핑하지 않아도 된다.
                    Button {
                        showDirPicker = true
                    } label: {
                        Label("폴더 탐색해서 선택", systemImage: "folder")
                    }
                    if !repoPath.isEmpty {
                        Text(verbatim: repoPath)
                            .font(.caption2.monospaced())
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.head)
                    }
                    if manualMode {
                        TextField("/Users/…/repo 경로 직접 입력", text: $repoPath)
                            .autocorrectionDisabled()
                            .textInputAutocapitalization(.never)
                        // 경로 자동완성 도우미 — 현재 입력 prefix 기준으로 recents 에서
                        // 다음에 올 수 있는 디렉터리 segment 들을 칩으로 노출. 칩을 탭하면
                        // 현재 입력 끝에 이어붙고, 더 깊은 경로가 있으면 "/" 까지 자동 추가해
                        // 다음 단계 추천이 즉시 보이게 한다. TextField 는 그대로라서
                        // 신규 경로 입력은 막지 않는다.
                        if !pathSuggestions.isEmpty || !repoPath.isEmpty {
                            ScrollView(.horizontal, showsIndicators: false) {
                                HStack(spacing: 6) {
                                    if !repoPath.isEmpty {
                                        Button {
                                            popPathSegment()
                                        } label: {
                                            Label("한 단계 위로", systemImage: "arrow.uturn.left")
                                                .font(.caption2)
                                        }
                                        .buttonStyle(.bordered)
                                        .controlSize(.mini)
                                    }
                                    ForEach(pathSuggestions, id: \.self) { seg in
                                        Button {
                                            appendPathSegment(seg)
                                        } label: {
                                            Text(seg)
                                                .font(.caption2.monospaced())
                                        }
                                        .buttonStyle(.bordered)
                                        .controlSize(.mini)
                                    }
                                }
                                .padding(.vertical, 2)
                            }
                        }
                        Button("최근 사용 프로젝트에서 고르기") {
                            manualMode = false
                            repoPath = ""
                        }
                        .font(.caption)
                    } else {
                        if loadingRecents {
                            HStack {
                                ProgressView()
                                Text("Mac에서 최근 프로젝트 불러오는 중…")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        } else if let loadError {
                            VStack(alignment: .leading, spacing: 6) {
                                Text("최근 목록을 못 가져왔습니다.")
                                    .font(.caption)
                                Text(loadError)
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(2)
                                Button("다시 시도") { Task { await loadRecents() } }
                                    .font(.caption)
                            }
                        } else if recents.isEmpty {
                            Text("최근 사용 기록이 없습니다. 아래 ‘직접 입력’으로 경로를 적어 주세요.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        } else {
                            if recents.count > 6 {
                                TextField("필터", text: $filter)
                                    .autocorrectionDisabled()
                                    .textInputAutocapitalization(.never)
                            }
                            ForEach(visibleRecents) { p in
                                Button {
                                    repoPath = p.path
                                } label: {
                                    RecentRow(
                                        project: p,
                                        selected: p.path == repoPath,
                                        onHide: {
                                            // 현재 선택이 숨김 대상이면 입력 비움.
                                            if repoPath == p.path { repoPath = "" }
                                            hiddenItems.hideRecent(p.path)
                                        }
                                    )
                                }
                                .buttonStyle(.plain)
                            }
                            // 5개 초과 + 필터 없는 상태에서만 펼치기. 필터가 켜져 있으면
                            // visibleRecents 가 이미 전체 결과를 반환하므로 이 버튼은 숨김.
                            if filter.isEmpty && filteredRecents.count > 5 {
                                Button {
                                    withAnimation { recentsExpanded.toggle() }
                                } label: {
                                    HStack(spacing: 6) {
                                        Image(systemName: recentsExpanded ? "chevron.up" : "chevron.down")
                                        Text(recentsExpanded
                                             ? "접기"
                                             : "더 보기 (\(filteredRecents.count - 5)개)")
                                    }
                                    .font(.caption)
                                    .foregroundStyle(.tint)
                                }
                                .buttonStyle(.plain)
                            }
                        }
                        Button {
                            manualMode = true
                            repoPath = ""
                        } label: {
                            Label("경로 직접 입력", systemImage: "keyboard")
                                .font(.caption)
                        }
                        // 흰색 라벨 + 약간 회색 배경. borderedProminent 는 틴트색 위에
                        // 자동으로 대비되는 (여기선 흰) 전경색을 깔아 준다.
                        .buttonStyle(.borderedProminent)
                        .tint(Theme.neutralFill)
                        .controlSize(.small)
                    }
                } header: {
                    HStack(spacing: 6) {
                        Text("레포 경로")
                        if !hiddenItems.hiddenRecentPaths.isEmpty || !hiddenItems.hiddenResumes.isEmpty {
                            Spacer()
                            Button {
                                showHiddenSheet = true
                            } label: {
                                Text("숨김 \(hiddenItems.hiddenRecentPaths.count + hiddenItems.hiddenResumes.count)개")
                                    .font(.caption2)
                            }
                            .buttonStyle(.borderless)
                            .accessibilityLabel(Text("숨김 항목 관리"))
                        }
                    }
                } footer: {
                    Text("Mac에서 최근에 코드 에이전트로 작업한 프로젝트들입니다. 골라서 바로 이어 작업할 수 있어요. 자주 안 쓰는 항목은 행 오른쪽 \(Image(systemName: "eye.slash")) 로 숨길 수 있어요.")
                        .font(.caption2)
                }

                // 선택한 레포가 git 저장소일 때만 — 채팅방을 거치지 않고 새 worktree 를 바로 만든다.
                if repoIsGit {
                    worktreeSection
                }

                // 경로가 비어 있어도 "이어 받기" 섹션 자체는 항상 표시한다.
                // 빈 상태에서는 "경로를 먼저 고르세요" 안내를 보여 줘서
                // 사용자가 어디서 이어받기 후보를 보게 되는지 한눈에 알 수 있게 한다.
                // shell 어댑터는 이어받기 개념 자체가 없어 섹션을 숨긴다.
                // worktree 모드면 새 브랜치+새 폴더라 데스크탑 이어받기와 결합 불가 — 섹션을 숨긴다.
                if !agentIsPlainShell && !worktreeMode {
                    resumeSection
                }
            }
            .navigationTitle("새 세션")
            .navigationBarTitleDisplayMode(.inline)
            .voiceDictationChrome()
            // (scoped .tint 제거됨 — AccentColor 에셋이 전역 액센트라 기본 컨트롤이 자동 보라. 취소
            // 버튼은 위에서 per-element `.tint(Color.primary)` 로 중립. agent 뱃지색은 명시 색 유지.)
            // iOS 16.4 deployment target 이라 1-arg 시그니처를 유지한다.
            // (2-arg 시그니처는 iOS 17+ 전용 — deprecation warning 은 무시.)
            .onChange(of: repoPath) { newPath in
                // 경로가 바뀌면 이어 받기 후보를 새로 불러온다.
                // trim 으로 사용자가 실수로 끝 공백/개행을 붙인 경우도 자동 보정한다.
                let trimmed = newPath.trimmingCharacters(in: .whitespacesAndNewlines)
                selectedResumeId = nil
                resumeCandidates = []
                resumeError = nil
                // 새 경로로 바꾸면 이어받기 펼치기 상태도 초기화 — 옛 경로에서 펼쳐 둔
                // 게 새 경로에 끌려와 깜빡이는 듯 보이는 걸 막는다.
                resumeExpanded = false
                // 레포가 바뀌면 worktree 상태도 초기화하고 git 여부를 다시 조회한다.
                // (옛 레포의 «git 임» 판정이 새 레포로 끌려와 잘못된 섹션이 뜨는 걸 막는다.)
                repoIsGit = false
                repoBranch = nil
                worktreeMode = false
                worktreeBranch = ""
                if !trimmed.isEmpty {
                    Task { await loadResumeCandidates(for: trimmed) }
                    Task { await loadGitInfo(for: trimmed) }
                }
                // 경로 prefix(마지막 "/"까지)의 실제 하위 폴더를 daemon 에서 조회해 자동완성
                // 후보(②)를 채운다. prefix 가 직전 조회와 같으면 loadFsDirs 내부에서 재조회를
                // 건너뛰어, 한 segment 안에서 타이핑할 때 키마다 네트워크 호출이 터지지 않게 한다.
                let fsPrefix = splitPathPrefix().prefix
                Task { await loadFsDirs(forPrefix: fsPrefix) }
            }
            .onChange(of: selectedAgentId) { _ in
                // CLI 도구가 바뀌면 이어받기 후보 source 자체가 달라진다 (claude 의 jsonl
                // vs agy 의 history.jsonl). 현 repoPath 로 새 라우트를 다시 조회.
                // shell 로 바꾸면 후보 자체가 무의미 — 빈 상태로 reset 만 하고 fetch 안 함.
                let trimmed = repoPath.trimmingCharacters(in: .whitespacesAndNewlines)
                selectedResumeId = nil
                resumeCandidates = []
                resumeError = nil
                resumeExpanded = false
                // 어댑터가 바뀌면 이전 어댑터의 설치 진행 표시를 끈다 (A 의 「설치 완료」 가 B 에
                // 잘못 보이지 않게). 진행 중이던 폴링 task 도 취소.
                installTask?.cancel()
                installTask = nil
                installProgress = nil
                if !trimmed.isEmpty && !agentIsPlainShell {
                    Task { await loadResumeCandidates(for: trimmed) }
                }
                // opencode 로 바꾸면 「내 로컬 서버 사용」 저장 설정을 채운다(아직 미조회면).
                if agentIsOpenCode && opencodeLoaded == nil {
                    Task { await loadOpencode() }
                }
            }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    // 취소 같은 «해제» 버튼은 강조색이 아니라 primary(중립) — 설정 닫기와 동일 규칙.
                    // 확정 액션(만들기)만 강조색을 쓴다.
                    Button("취소") { dismiss() }
                        .tint(Color.primary)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("만들기") {
                        Task { await createTapped() }
                    }
                    .disabled(creating || repoPath.trimmingCharacters(in: .whitespaces).isEmpty || localLlmBlocked || localLlmCreateBlocked || selectedAgentNeedsCliInstall || proAgentBlocked || (worktreeMode && !isValidGitName(worktreeBranch)))
                }
            }
            .task {
                await loadRecents()
                await loadAgents()
                await loadLocalLlm()
                await loadOpencode()
                await recoverInstallStateIfNeeded()
            }
            // 폴링 태스크 정리 — 시트가 닫히면 진행 폴링을 멈춘다(로컬 LLM 다운로드 + CLI 설치).
            // 설치/다운로드 자체는 daemon 이 계속 진행하며, 다시 열면 status 폴링이 복구한다.
            .onDisappear {
                llmPollTask?.cancel()
                llmPollTask = nil
                installTask?.cancel()
                installTask = nil
            }
            // 포그라운드 재진입 시 로컬 LLM 상태를 다시 당겨 진행을 복구한다(서버가 진행을 들고
            // 있어, 백그라운드에서 끊겼다 돌아와도 다운로드 진행/완료가 그대로 이어진다).
            .onChange(of: scenePhase) { phase in
                if phase == .active && agentIsLocalInference {
                    Task { await loadLocalLlm() }
                }
            }
            .sheet(isPresented: $showHiddenSheet) {
                HiddenItemsSheet()
                    .environmentObject(hiddenItems)
            }
            // 폴더 탐색기로 작업 폴더 선택 — 고르면 경로를 채우고 직접 입력 모드로 둬 미세조정 가능.
            .sheet(isPresented: $showDirPicker) {
                DirectoryPickerSheet(title: "작업 폴더 선택") { path in
                    let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
                    return try? await api.listDirBase(path)
                } onPick: { picked in
                    repoPath = picked
                    manualMode = true
                }
            }
            // 프로 전용(Terminal·로컬 LLM·worktree)을 미보유 사용자가 시도했을 때의 업셀 페이월.
            .proPaywall(item: $paywallFeature)
            // 생성 실패 안내 — daemon 거절(로컬 LLM 동시 1개 초과 등)이나 통신 실패를 명확히.
            // 옛 동작은 실패해도 조용히 시트만 닫혀 「세션이 안 생기는데 안내가 없는」 문제였다.
            .alert(
                "세션을 만들지 못했어요",
                isPresented: Binding(
                    get: { createError != nil },
                    set: { if !$0 { createError = nil } }
                )
            ) {
                Button("확인", role: .cancel) {}
            } message: {
                Text(createError ?? "")
            }
        }
    }

    // MARK: - Path autocomplete helper

    /// 현재 repoPath 끝의 "/" 위치를 기준으로 (prefix, currentToken) 으로 쪼갠다.
    /// 예) "/Users/soloway/Pro" → prefix="/Users/soloway/", token="Pro"
    /// 예) "/Users/soloway/"   → prefix="/Users/soloway/", token=""
    /// 예) "myrepo"            → prefix="",                 token="myrepo"
    private func splitPathPrefix() -> (prefix: String, token: String) {
        let s = repoPath
        if let lastSlash = s.lastIndex(of: "/") {
            let prefix = String(s[...lastSlash])  // 마지막 "/" 까지 포함
            let token = String(s[s.index(after: lastSlash)...])
            return (prefix, token)
        }
        return ("", s)
    }

    /// recents 의 경로들에서 현재 prefix 다음에 올 수 있는 디렉터리 segment 후보를 모은다.
    /// token (마지막 "/" 이후 이미 입력된 부분) 으로 prefix 매칭 필터까지 한다.
    private var pathSuggestions: [String] {
        let (prefix, token) = splitPathPrefix()
        let tokenLower = token.lowercased()
        var next: Set<String> = []
        // ① recents 파생 — 과거 작업한 경로의 다음 segment.
        for p in recents.map(\.path) {
            guard p.hasPrefix(prefix) else { continue }
            let rest = p.dropFirst(prefix.count)
            if rest.isEmpty { continue }
            let seg: String
            if let slash = rest.firstIndex(of: "/") {
                seg = String(rest[..<slash])
            } else {
                seg = String(rest)
            }
            if seg.isEmpty { continue }
            // token 으로 시작하는 segment 만 — 이미 입력 중인 부분과 충돌하지 않게.
            if !tokenLower.isEmpty && !seg.lowercased().hasPrefix(tokenLower) { continue }
            next.insert(seg)
        }
        // ② 파일시스템 디렉터리 — 현재 prefix 의 실제 하위 폴더 (daemon 조회 결과). fsDirsPrefix
        //    가 지금 prefix 와 일치할 때만 (조회 중 prefix 가 바뀐 stale 결과는 무시).
        if prefix == fsDirsPrefix {
            for seg in fsDirs {
                if !tokenLower.isEmpty && !seg.lowercased().hasPrefix(tokenLower) { continue }
                next.insert(seg)
            }
        }
        return next.sorted()
    }

    /// 칩 탭 — 현재 token 을 seg 전체로 교체. seg 너머 더 깊은 경로가 있으면 "/" 까지 자동
    /// 추가해서 다음 단계 추천이 곧바로 채워지게 한다.
    private func appendPathSegment(_ seg: String) {
        let (prefix, _) = splitPathPrefix()
        let newPath = prefix + seg
        // 디렉터리면 "/" 까지 자동 추가해 다음 단계 추천이 곧장 뜨게 한다. recents 에 더 깊은
        // 경로가 있거나, fs 조회 결과(fsDirs, 모두 디렉터리)에 이 seg 가 있으면 디렉터리로 본다.
        let isDir = recents.contains { $0.path.hasPrefix(newPath + "/") }
            || (prefix == fsDirsPrefix && fsDirs.contains(seg))
        repoPath = isDir ? (newPath + "/") : newPath
    }

    /// "한 단계 위로" — 끝의 "/" 와 그 직전 segment 를 한 번에 제거.
    /// 예) "/Users/soloway/Projects/" → "/Users/soloway/"
    /// 예) "/Users/soloway/Pro"       → "/Users/soloway/"
    private func popPathSegment() {
        var p = repoPath
        if p.hasSuffix("/") { p.removeLast() }
        if let lastSlash = p.lastIndex(of: "/") {
            p = String(p[...lastSlash])
        } else {
            p = ""
        }
        repoPath = p
    }

    @MainActor
    private func loadRecents() async {
        loadingRecents = true
        loadError = nil
        defer { loadingRecents = false }
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        do {
            recents = try await api.recentProjects()
            // 시트가 처음 열려서 아직 경로가 비어 있다면, 가장 최근에 작업한
            // 프로젝트를 자동 선택해서 "이어 받기" 후보 로딩을 즉시 트리거한다.
            // 사용자가 + 누르자마자 후보가 보이도록 하기 위함이고,
            // 원치 않으면 다른 항목을 탭하거나 "경로 직접 입력"으로 바꾸면 된다.
            // 숨김 처리된 경로는 건너뛰고, 모두 숨김이면 그대로 비워 둔다.
            if repoPath.isEmpty,
               let first = recents.first(where: { !hiddenItems.isRecentHidden($0.path) }) {
                repoPath = first.path
            }
        } catch {
            loadError = (error as? LocalizedError)?.errorDescription ?? "\(error)"
        }
    }

    /// daemon `GET /api/agents` 를 호출해 동적 picker 를 채운다. multi_agent_v1 미지원
    /// 옛 daemon (404) / 통신 실패는 모두 fallback [claude_code] 1개로 흡수해 사용자
    /// 인지 0. (옛 daemon 은 어차피 claude_code 만 spawn 했으므로 행동 변화 없음.)
    @MainActor
    private func loadAgents() async {
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        do {
            let list = try await api.listAgents(label: nil)
            if !list.isEmpty {
                agents = list
                // 선택된 id 가 목록에 없으면 첫 항목으로 reset (예: 옛 default 가 제거된 경우).
                if !list.contains(where: { $0.id == selectedAgentId }) {
                    selectedAgentId = list.first!.id
                }
            }
        } catch {
            // 옛 daemon — fallback 그대로. 사용자에겐 에러 안 띄움 (어차피 claude_code 만
            // 보여주는 게 옛 동작과 동일).
        }
    }

    /// 로컬 추론 백엔드(local_llm·opencode 공유)를 제공하는 어댑터가 목록에 있을 때만 세부 상태 +
    /// 카탈로그를 조회한다. 다운로드가 진행 중이면 폴링을 시작해 진행률을 갱신한다. 조회 실패는
    /// llmLoadError 로 섹션에 표시(재시도 버튼). 상태/카탈로그 라우트는 두 어댑터가 공유한다.
    @MainActor
    private func loadLocalLlm() async {
        guard agents.contains(where: { $0.id == "local_llm" || $0.id == "opencode" }) else { return }
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        llmLoadError = nil
        do {
            async let statusTask = api.localLlmStatus(label: nil)
            async let catalogTask = api.localLlmModels(label: nil)
            let status = try await statusTask
            let catalog = try await catalogTask
            llmStatus = status
            llmModels = catalog.catalog
            llmRecommendedId = catalog.recommendedModelId
            llmSelectedId = catalog.selectedModelId
            startLlmPollIfNeeded()
        } catch {
            if !ApiError.isCancellation(error) {
                llmLoadError = (error as? LocalizedError)?.errorDescription ?? "\(error)"
            }
        }
    }

    /// opencode 가 목록에 있고 외부 엔드포인트 모드를 지원할 때만 저장 설정을 조회해 draft 를 채운다.
    /// 옛 daemon(라우트 404)·실패는 조용히 흡수(섹션 자체가 capability 로 숨겨져 도달 드묾).
    @MainActor
    private func loadOpencode() async {
        guard opencodeSupportsExternal else { return }
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        do {
            let cfg = try await api.opencodeExternal(label: nil)
            opencodeLoaded = cfg
            opencodeEnabledDraft = cfg.enabled
            opencodeBaseUrlDraft = cfg.baseUrl
            opencodeModelDraft = cfg.modelId
            opencodeProbe = nil
            opencodeError = nil
        } catch {
            if !ApiError.isCancellation(error) {
                opencodeError = (error as? LocalizedError)?.errorDescription ?? "\(error)"
            }
        }
    }

    /// 입력값(baseURL+모델)으로 /v1/models 헬스체크 — 저장과 무관하게 «막다른 길» 을 미리 잡는다.
    @MainActor
    private func verifyOpencode() async {
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        opencodeBusy = true
        opencodeError = nil
        defer { opencodeBusy = false }
        do {
            opencodeProbe = try await api.verifyOpencodeExternal(
                baseUrl: opencodeBaseUrlDraft.trimmingCharacters(in: .whitespacesAndNewlines),
                modelId: opencodeModelDraft.trimmingCharacters(in: .whitespacesAndNewlines),
            )
        } catch {
            if !ApiError.isCancellation(error) {
                opencodeError = (error as? LocalizedError)?.errorDescription ?? "\(error)"
            }
        }
    }

    /// draft 를 daemon 에 저장(PUT). 켤 때는 daemon 이 baseURL/모델을 엄격 검증 — 400 은 ApiError
    /// 가 사유로 변환해 표시한다. 저장 성공 시 응답(정규화된 최종 설정)으로 loaded/draft 를 갱신.
    @MainActor
    private func saveOpencode() async {
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        opencodeBusy = true
        opencodeError = nil
        defer { opencodeBusy = false }
        let draft = OpencodeExternalConfig(
            enabled: opencodeEnabledDraft,
            baseUrl: opencodeBaseUrlDraft.trimmingCharacters(in: .whitespacesAndNewlines),
            modelId: opencodeModelDraft.trimmingCharacters(in: .whitespacesAndNewlines),
        )
        do {
            let saved = try await api.setOpencodeExternal(draft)
            opencodeLoaded = saved
            opencodeEnabledDraft = saved.enabled
            opencodeBaseUrlDraft = saved.baseUrl
            opencodeModelDraft = saved.modelId
        } catch {
            if !ApiError.isCancellation(error) {
                opencodeError = (error as? LocalizedError)?.errorDescription ?? "\(error)"
            }
        }
    }

    /// 카탈로그(downloaded 플래그)와 상태를 다시 당긴다 — 다운로드/취소/선택 직후 표시 동기화.
    @MainActor
    private func refreshLocalLlm() async {
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        if let catalog = try? await api.localLlmModels(label: nil) {
            llmModels = catalog.catalog
            llmRecommendedId = catalog.recommendedModelId
            llmSelectedId = catalog.selectedModelId
        }
        if let st = try? await api.localLlmStatus(label: nil) { llmStatus = st }
    }

    /// 다운로드가 활성이면 ~1.5s 폴링으로 진행률을 갱신하고, 끝나면 카탈로그를 새로고침한 뒤
    /// 멈춘다. 이미 폴링 중이면 중복 시작하지 않는다(Mac 모델 탭과 같은 idiom).
    private func startLlmPollIfNeeded() {
        guard (llmStatus?.download.active ?? false), llmPollTask == nil else { return }
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        llmPollTask = Task { @MainActor in
            defer { llmPollTask = nil }
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 1_500_000_000)
                if Task.isCancelled { return }
                guard let st = try? await api.localLlmStatus(label: nil) else { continue }
                llmStatus = st
                if !st.download.active {
                    await refreshLocalLlm()
                    return
                }
            }
        }
    }

    /// 폰에서 모델 다운로드 시작. 디스크 부족·이미 받는 중·실패는 llmError 로 섹션에 명확히 표시.
    @MainActor
    private func startLlmDownload(_ id: String) async {
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        llmError = nil
        do {
            try await api.downloadLocalLlmModel(id)
            // 즉시 진행 상태를 한 번 당겨 카드가 곧장 progress 로 전환되게.
            if let st = try? await api.localLlmStatus(label: nil) { llmStatus = st }
            startLlmPollIfNeeded()
        } catch {
            if !ApiError.isCancellation(error) {
                llmError = (error as? LocalizedError)?.errorDescription ?? "\(error)"
            }
        }
    }

    @MainActor
    private func cancelLlmDownload() async {
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        llmError = nil
        try? await api.cancelLocalLlmDownload()
        await refreshLocalLlm()
    }

    /// 선택 모델 저장. 성공하면 「선택됨」 뱃지가 옮겨 붙고, modelPresent 가 갱신돼 게이트가 풀린다.
    @MainActor
    private func selectLlmModel(_ id: String) async {
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        llmError = nil
        llmBusyModelId = id
        defer { llmBusyModelId = nil }
        do {
            try await api.selectLocalLlmModel(id)
            await refreshLocalLlm()
        } catch {
            if !ApiError.isCancellation(error) {
                llmError = (error as? LocalizedError)?.errorDescription ?? "\(error)"
            }
        }
    }

    /// 시트 재진입 시, 현재 선택한 어댑터의 설치가 daemon 에서 아직 진행 중이면 그 진행을
    /// 복구해 폴링을 잇는다 (시트를 닫았다 다시 열어도 「설치 계속 진행 중」 이 보이게).
    /// 선택을 강제로 바꾸지 않아 onChange 리셋과 경합하지 않는다 — 진행 중 어댑터가 현재
    /// 선택과 다르면 사용자가 그 어댑터를 고를 때 다시 복구된다.
    @MainActor
    private func recoverInstallStateIfNeeded() async {
        guard installProgress == nil else { return }
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        guard let p = try? await api.agentInstallStatus(), p.isInstalling else { return }
        // 추론 서버 런타임 설치는 adapterId 가 "local_llm/<component>"(어댑터 무관 공유) — 로컬
        // 추론(local_llm·opencode) 선택 시 복구. opencode 도 같은 llama-server 설치를 재사용한다.
        if let aid = p.adapterId, aid.hasPrefix("local_llm/") {
            guard agentIsLocalInference else { return }
            installProgress = p
            installTask?.cancel()
            installTask = Task { await runComponentInstall(String(aid.dropFirst("local_llm/".count))) }
            return
        }
        guard p.adapterId == selectedAgentId else { return }
        installProgress = p
        installTask?.cancel()
        installTask = Task { await runInstall() }
    }

    /// 「다시 설치」 — 진행 스냅샷이 어느 경로(CLI vs local_llm 구성요소)인지 보고 올바른 설치를
    /// 다시 건다. adapterId 가 `local_llm/<component>` 면 구성요소 설치, 아니면 어댑터 설치.
    private func retryInstall(for p: AgentInstallProgress) {
        if let aid = p.adapterId, aid.hasPrefix("local_llm/") {
            startComponentInstall(String(aid.dropFirst("local_llm/".count)))
        } else {
            startInstall()
        }
    }

    /// 「Mac 에 설치」 / 「다시 설치」 탭 — 진행 중 task 를 취소하고 새 설치 폴링 루프 시작.
    private func startInstall() {
        installTask?.cancel()
        installTask = Task { await runInstall() }
    }

    /// local_llm 런타임 구성요소(llama-server/qwen) 설치 시작 — CLI 설치와 같은 폴링 루프 재사용.
    private func startComponentInstall(_ component: String) {
        installTask?.cancel()
        installTask = Task { await runComponentInstall(component) }
    }

    /// 구성요소 설치를 daemon 에 시작시키고 완료까지 폴링한다. 성공하면 로컬 LLM 상태를 재조회해
    /// binariesReady 를 갱신 → 게이트(localLlmCreateBlocked) 해제 → 「만들기」 활성. 시트를 안 떠난다.
    ///
    /// 엣지: llama.cpp 빌드는 분 단위로 길 수 있어 종료(done/error)까지 무기한 폴링한다(타임아웃
    /// 없음). Tor 단절로 폴링이 일시 실패해도 루프를 끊지 않고 다음 tick 에 재시도해 「설치
    /// 계속 진행 중」 표시를 유지한다. 폴링 중 사용자가 어댑터를 바꾸면 stale 로 보고 중단.
    @MainActor
    private func runComponentInstall(_ component: String) async {
        let targetId = "local_llm/\(component)"
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        do {
            installProgress = try await api.installLocalLlmComponent(component)
        } catch ApiError.httpStatus(409, _) {
            // 이미 진행 중 (다른 기기/이전 시도) — 합류해서 status 폴링만 한다.
        } catch {
            // 시작 자체 실패 — 막다른 길 대신 실패 상태로 폴백 표시.
            installProgress = AgentInstallProgress(
                adapterId: targetId,
                state: "error",
                command: nil,
                log: (error as? LocalizedError)?.errorDescription ?? "\(error)",
                exitCode: nil,
                error: "spawn_failed",
                installed: false,
                startedAt: nil,
            )
            return
        }
        while !Task.isCancelled {
            try? await Task.sleep(nanoseconds: 1_000_000_000)
            if Task.isCancelled { break }
            // 폴링 중 사용자가 로컬 추론(local_llm·opencode)을 떠났으면 stale — 적용하지 않는다.
            if !agentIsLocalInference { break }
            do {
                let p = try await api.agentInstallStatus()
                // 다른 대상이 설치 중으로 바뀐 스냅샷이면 이 행과 무관 — 무시.
                guard p.adapterId == targetId else { continue }
                installProgress = p
                if !p.isInstalling {
                    // 성공이면 status 재조회로 binariesReady 갱신 → 게이트 해제.
                    if p.isDone { await loadLocalLlm() }
                    break
                }
            } catch {
                // 일시 실패 (Tor 단절 등) — 루프 유지, 다음 tick 에 재시도.
            }
        }
    }

    /// daemon 에 설치를 시작시키고 완료까지 진행을 폴링한다. 성공하면 도구 목록을 재탐지해
    /// 「설정 필요」 게이팅(selectedAgentNeedsCliInstall)을 푼다 → 같은 자리에서 세션 생성 가능.
    ///
    /// 엣지: Tor 회로 전환 등으로 폴링이 일시 실패해도 루프를 끊지 않고 다음 tick 에 재시도
    /// (send() 내부가 강제 재연결) — 「설치 계속 진행 중」 표시가 유지된다. 다른 어댑터가 이미
    /// 설치 중이면 daemon 이 409 busy 지만, 같은 어댑터면 합류하므로 그대로 폴링한다.
    @MainActor
    private func runInstall() async {
        let agentId = selectedAgentId
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        do {
            installProgress = try await api.installAgent(adapterId: agentId)
        } catch ApiError.httpStatus(409, _) {
            // 이미 진행 중 (다른 기기/이전 시도) — 합류해서 status 폴링만 한다.
        } catch {
            // 시작 자체 실패 (전송/검증 등) — 막다른 길 대신 실패 상태로 폴백 표시.
            installProgress = AgentInstallProgress(
                adapterId: agentId,
                state: "error",
                command: selectedAgentInstallHint,
                log: (error as? LocalizedError)?.errorDescription ?? "\(error)",
                exitCode: nil,
                error: "spawn_failed",
                installed: false,
                startedAt: nil,
            )
            return
        }
        // 종료(done/error)까지 1s 간격 폴링.
        while !Task.isCancelled {
            try? await Task.sleep(nanoseconds: 1_000_000_000)
            if Task.isCancelled { break }
            do {
                let p = try await api.agentInstallStatus()
                // 폴링 중 사용자가 어댑터를 바꿨으면 stale — 적용하지 않는다.
                if selectedAgentId != agentId { break }
                installProgress = p
                if !p.isInstalling {
                    // 성공이면 installed=true 로 갱신된 목록을 다시 받아 게이팅 해제.
                    if p.isDone { await loadAgents() }
                    break
                }
            } catch {
                // 일시 실패 (Tor 단절 등) — 루프 유지, 다음 tick 에 재시도.
            }
        }
    }

    @MainActor
    private func loadResumeCandidates(for path: String) async {
        loadingResume = true
        resumeError = nil
        defer { loadingResume = false }
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        do {
            resumeCandidates = try await api.desktopSessions(agentId: selectedAgentId, repoPath: path)
        } catch {
            resumeError = (error as? LocalizedError)?.errorDescription ?? "\(error)"
        }
    }

    /// 경로 자동완성용 — `<prefix>` 디렉터리 바로 아래 하위 폴더 목록을 daemon
    /// `GET /api/fs/list-dir` 에서 받아 fsDirs 에 채운다. fsDirsPrefix 로 「어느 prefix 의
    /// 결과인지」를 함께 기록해, 읽는 쪽(pathSuggestions ②)이 stale 결과를 무시할 수 있게 한다.
    ///
    /// - 같은 prefix 의 결과를 이미 들고 있으면 재조회 생략 (키 입력마다 호출되는 걸 막는다).
    /// - 절대경로(또는 ~) prefix 만 조회 — 상대/빈 prefix 는 daemon 이 어차피 빈 목록이라 호출 생략.
    /// - 옛 daemon(이 라우트 없는 빌드)의 404·통신 실패는 빈 목록으로 흡수 → 사용자 인지 0,
    ///   recents 기반 추천(①)만 뜨던 옛 동작으로 자연히 degrade.
    @MainActor
    private func loadFsDirs(forPrefix prefix: String) async {
        if prefix == fsDirsPrefix { return }  // 이미 같은 prefix 의 결과 보유 — 재조회 불필요.
        // 절대경로(또는 ~)가 아니면 daemon 호출 없이 비운다 (불필요한 네트워크 절약).
        guard prefix.hasPrefix("/") || prefix.hasPrefix("~") else {
            fsDirs = []
            fsDirsPrefix = prefix
            return
        }
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        let dirs = (try? await api.listDir(prefix, label: nil)) ?? []
        // 응답이 오는 사이 사용자가 다른 prefix 로 이동했으면 stale — 적용하지 않는다.
        // (현 prefix 는 자기 onChange 가 다시 조회한다.)
        guard splitPathPrefix().prefix == prefix else { return }
        fsDirs = dirs
        fsDirsPrefix = prefix
    }

    // MARK: - Resume section

    private var resumeSection: some View {
        Section {
            if repoPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                // 경로 미선택 안내 — 섹션 자체는 항상 보이게 둬서
                // "어디서 이어받기 후보를 보게 되는지" 사용자가 한눈에 알 수 있게 한다.
                Text("위에서 레포 경로를 고르면, 데스크탑에서 진행 중이던 코드 에이전트 세션을 여기서 이어 받을 수 있어요.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            } else if loadingResume {
                HStack {
                    ProgressView()
                    Text("이어 받을 수 있는 데스크탑 세션 찾는 중…")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            } else if let resumeError {
                Text(resumeError)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            } else {
                // 항상 "새 세션 시작" 옵션을 맨 위에.
                Button {
                    selectedResumeId = nil
                } label: {
                    HStack(alignment: .top, spacing: 10) {
                        Image(systemName: selectedResumeId == nil
                              ? "largecircle.fill.circle"
                              : "circle")
                            .foregroundStyle(selectedResumeId == nil ? Theme.accent : .secondary)
                            .frame(width: 18)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("새 세션 시작")
                                .font(.body.weight(.medium))
                            Text("빈 컨텍스트에서 시작합니다.")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)

                if resumeCandidatesVisible.isEmpty {
                    if resumeCandidates.isEmpty {
                        Text("이 경로에서 진행 중이던 데스크탑 코드 에이전트 세션이 없습니다.")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    } else {
                        // 후보가 있긴 한데 전부 사용자가 숨김 처리한 경우 — 안내 + 진입점.
                        VStack(alignment: .leading, spacing: 4) {
                            Text("표시할 이어받기 후보가 없어요.")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                            Text("\(resumeCandidates.count)개 모두 숨김 처리되어 있습니다.")
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                        }
                    }
                } else {
                    ForEach(visibleResumeCandidates) { s in
                        Button {
                            selectedResumeId = s.sessionId
                        } label: {
                            ResumeRow(
                                session: s,
                                selected: selectedResumeId == s.sessionId,
                                onHide: {
                                    // 현재 선택이 숨김 대상이면 해제.
                                    if selectedResumeId == s.sessionId {
                                        selectedResumeId = nil
                                    }
                                    hiddenItems.hideResume(HiddenResumeMeta(
                                        sessionId: s.sessionId,
                                        repoPath: s.repoPath,
                                        preview: s.preview,
                                        lastActiveAt: s.lastActiveAt,
                                        gitBranch: s.gitBranch
                                    ))
                                }
                            )
                        }
                        .buttonStyle(.plain)
                    }
                    if resumeCandidatesVisible.count > 5 {
                        Button {
                            withAnimation { resumeExpanded.toggle() }
                        } label: {
                            HStack(spacing: 6) {
                                Image(systemName: resumeExpanded ? "chevron.up" : "chevron.down")
                                Text(resumeExpanded
                                     ? "접기"
                                     : "더 보기 (\(resumeCandidatesVisible.count - 5)개)")
                            }
                            .font(.caption)
                            .foregroundStyle(.tint)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        } header: {
            HStack(spacing: 6) {
                Text("이어 받기")
                InfoButton(categoryId: "resume", font: .caption)
            }
        } footer: {
            Text("데스크탑에서 코드 에이전트로 작업 중이던 세션을 골라 모바일에서 이어 받을 수 있어요. 이전 대화 컨텍스트가 모두 유지됩니다.")
                .font(.caption2)
        }
    }

    /// 선택한 레포가 git 저장소일 때만 노출 — 새 브랜치 worktree 를 여기서 바로 만든다.
    /// 토글을 켜면 브랜치명 입력칸이 펼쳐지고, 「만들기」 가 worktree 생성 → 그 안에서 세션 시작
    /// 흐름으로 분기한다 (채팅방 BranchSheet 를 거치지 않아도 되게 한다).
    private var worktreeSection: some View {
        Section {
            // 프로 게이트 — worktree 생성은 프로 전용(채팅 BranchSheet 와 통일). 미보유 사용자가
            // 켜려 하면 토글을 켜지 않고 페이월을 띄운다. 커스텀 Binding 으로 set 을 가로채므로
            // worktreeMode 가 «프로 없이» true 가 되는 경로 자체가 없다(이번 버그의 근본 차단).
            Toggle(isOn: Binding(
                get: { worktreeMode },
                set: { want in
                    if want, worktreeProBlocked { paywallFeature = .worktree; return }
                    worktreeMode = want
                }
            )) {
                Label {
                    HStack(spacing: 6) {
                        Text("새 worktree 만들기")
                        // 미보유면 «프로» 마커 — 에이전트 행/다른 프로 진입점과 통일.
                        if worktreeProBlocked {
                            Text("프로")
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(Theme.pro)
                        }
                    }
                } icon: {
                    // git/worktree 도구 그룹 — 아이콘만 주황(채팅 BranchSheet 의 WorktreeRow 와 통일).
                    // 토글/텍스트 본체엔 주황을 칠하지 않는다(주황=프로/고급 약속색, 색 정책 준수).
                    Image(systemName: "plus.rectangle.on.folder")
                        .foregroundStyle(Theme.pro)
                }
            }
            if worktreeMode {
                TextField("브랜치 이름 (영문·숫자)", text: $worktreeBranch)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            }
        } header: {
            Text("worktree")
        } footer: {
            if worktreeMode {
                // 한글·공백 등은 git 이 브랜치명으로 못 받는다 — 유효한 이름일 때만 「만들기」 활성.
                if let base = repoBranch {
                    Text("새 브랜치의 worktree(별도 작업 폴더)를 «\(base)» 기준으로 만들고 그 안에서 세션을 시작해요. 이름은 영문·숫자와 - _ . / 만 쓸 수 있어요.")
                        .font(.caption2)
                } else {
                    Text("새 브랜치의 worktree(별도 작업 폴더)를 만들고 그 안에서 세션을 시작해요. 이름은 영문·숫자와 - _ . / 만 쓸 수 있어요.")
                        .font(.caption2)
                }
            } else {
                Text("worktree 는 브랜치별 별도 작업 폴더예요. 채팅방에 들어가지 않고 새 브랜치를 여기서 바로 시작할 수 있어요.")
                    .font(.caption2)
            }
        }
    }

    /// 레포가 git 작업트리인지 조회해 worktree 섹션 노출 여부를 정한다. 실패/옛 daemon(이 라우트
    /// 없음)은 조용히 비-git 으로 — 섹션만 숨길 뿐 다른 흐름은 막지 않는다(이어받기 후보 로딩과 동일 톤).
    @MainActor
    private func loadGitInfo(for path: String) async {
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        let info = try? await api.repoGitInfo(repoPath: path)
        // 조회 도중 사용자가 다른 레포로 바꿨으면 stale 결과 — 현 상태를 건드리지 않는다.
        guard path == repoPath.trimmingCharacters(in: .whitespacesAndNewlines) else { return }
        if let info, info.isRepo {
            repoIsGit = true
            repoBranch = info.branch
        } else {
            repoIsGit = false
            repoBranch = nil
        }
    }

    /// 브랜치명이 daemon 의 isValidRef 규칙(영숫자 + ._/-, 선행 `-`·`..` 금지)을 통과하는지.
    /// 제출 «전» 같은 규칙으로 막아 «생성 실패» 대신 비활성 버튼으로 즉시 피드백한다 (BranchSheet 와 동일).
    private func isValidGitName(_ raw: String) -> Bool {
        let name = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, name.count <= 255 else { return false }
        guard !name.hasPrefix("-"), !name.contains("..") else { return false }
        return name.range(of: "^[A-Za-z0-9._/-]+$", options: .regularExpression) != nil
    }

    /// 「만들기」 탭 — worktree 모드면 onCreate «전» 에 새 worktree 를 만들고 그 경로로 세션을 시작한다.
    /// 일반 모드면 선택한 레포 경로 그대로. 실패는 시트를 닫지 않고 createError alert 으로 안내한다.
    @MainActor
    private func createTapped() async {
        creating = true
        defer { creating = false }
        var sessionRepoPath = repoPath
        var sessionTitle: String? = title.isEmpty ? nil : title
        var resume = selectedResumeId
        if worktreeMode {
            // 방어선 — 토글에서 이미 막지만, worktreeMode 가 프로 없이 true 인 경로가 생기더라도
            // 여기서 한 번 더 차단(게이트 단일화: 프로 판정은 항상 purchase.isUnlocked(.worktree)).
            if worktreeProBlocked {
                paywallFeature = .worktree
                return
            }
            let branch = worktreeBranch.trimmingCharacters(in: .whitespacesAndNewlines)
            let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
            do {
                let wt = try await api.createWorktreeForRepo(repoPath: repoPath, branch: branch, newBranch: true)
                sessionRepoPath = wt.path
                // 제목을 비웠으면 브랜치명을 제목으로 — 「제목 없음」 대신 어느 worktree 인지 보이게
                // (채팅방 BranchSheet 흐름과 동일). 새 브랜치+새 폴더라 이어받기는 결합하지 않는다.
                if sessionTitle == nil { sessionTitle = branch }
                resume = nil
            } catch {
                createError = (error as? LocalizedError)?.errorDescription ?? "\(error)"
                return
            }
        }
        let err = await onCreate(sessionRepoPath, sessionTitle, resume, skipPermissions, selectedAgentId)
        // 실패면 시트를 닫지 않고 alert 로 사유를 명확히 보여 준다. 성공일 때만 닫는다.
        if let err {
            createError = err
        } else {
            dismiss()
        }
    }
}

private struct ResumeRow: View {
    let session: DesktopSession
    let selected: Bool
    /// 행 오른쪽 끝의 숨김 버튼이 눌렸을 때. nil 이면 버튼 자체가 보이지 않는다 (HiddenItemsSheet
    /// 에서 재사용하지 않으므로 사실상 nil 케이스는 없지만, 미래의 read-only 재사용 대비).
    var onHide: (() -> Void)? = nil

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: selected ? "largecircle.fill.circle" : "circle")
                .foregroundStyle(selected ? Theme.accent : .secondary)
                .frame(width: 18)
            VStack(alignment: .leading, spacing: 3) {
                // preview 는 agent 마다 채워질 수도(claude jsonl) / nil 일 수도(agy 의 .pb).
                // nil 이면 어떤 세션인지만 식별되게 sessionId prefix 로 fallback.
                Text(session.preview ?? "(미리보기 없음 · \(session.sessionId.prefix(8)))")
                    .font(.callout)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
                HStack(spacing: 6) {
                    if let branch = session.gitBranch, !branch.isEmpty {
                        Label(branch, systemImage: "arrow.triangle.branch")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                    if let turns = session.turnCount {
                        Text("\(turns)턴")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                        Text("·")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                    Text(timeAgo(session.lastActiveAt))
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }
            Spacer()
            if let onHide {
                // outer Button(.plain) 안의 inner Button — `.borderless` 로 명시해야
                // SwiftUI 가 hit area 를 분리하고 행 선택 동작과 충돌하지 않는다.
                Button(action: onHide) {
                    Image(systemName: "eye.slash")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .frame(width: 32, height: 32)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.borderless)
                .accessibilityLabel(Text("이 이어받기 후보 숨기기"))
            }
        }
        .contentShape(Rectangle())
    }

    private func timeAgo(_ ts: Int64) -> String {
        let date = Date(timeIntervalSince1970: TimeInterval(ts) / 1000)
        let delta = Date().timeIntervalSince(date)
        if delta < 60 { return String(localized: "방금") }
        let min = Int(delta / 60)
        if delta < 3_600 { return String(localized: "\(min)분 전") }
        let hr = Int(delta / 3_600)
        if delta < 86_400 { return String(localized: "\(hr)시간 전") }
        let day = Int(delta / 86_400)
        if delta < 86_400 * 7 { return String(localized: "\(day)일 전") }
        let f = DateFormatter()
        f.dateStyle = .short
        // 시스템 로케일 사용 — 명시적 ko_KR 고정은 다국어 정책과 충돌.
        return f.string(from: date)
    }
}

private struct RecentRow: View {
    let project: RecentProject
    let selected: Bool
    /// 행 오른쪽 끝의 숨김 버튼이 눌렸을 때. nil 이면 버튼이 보이지 않음.
    var onHide: (() -> Void)? = nil

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: selected ? "checkmark.circle.fill" : "folder")
                .foregroundStyle(selected ? Theme.accent : Color.secondary)
                .frame(width: 18)
            VStack(alignment: .leading, spacing: 2) {
                Text(displayName)
                    .font(.body.weight(.medium))
                    .lineLimit(1)
                Text(project.path)
                    .font(.caption2.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Text("\(project.sessionCount)개 세션 · \(timeAgo(project.lastUsedAt))")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            Spacer()
            if let onHide {
                Button(action: onHide) {
                    Image(systemName: "eye.slash")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .frame(width: 32, height: 32)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.borderless)
                .accessibilityLabel(Text("이 레포 숨기기"))
            }
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
    }

    private var displayName: String {
        (project.path as NSString).lastPathComponent
    }

    private func timeAgo(_ ts: Int64) -> String {
        let date = Date(timeIntervalSince1970: TimeInterval(ts) / 1000)
        let delta = Date().timeIntervalSince(date)
        if delta < 60 { return String(localized: "방금") }
        let min = Int(delta / 60)
        if delta < 3_600 { return String(localized: "\(min)분 전") }
        let hr = Int(delta / 3_600)
        if delta < 86_400 { return String(localized: "\(hr)시간 전") }
        let day = Int(delta / 86_400)
        if delta < 86_400 * 7 { return String(localized: "\(day)일 전") }
        let f = DateFormatter()
        f.dateStyle = .short
        // 시스템 로케일 사용 — 명시적 ko_KR 고정은 다국어 정책과 충돌.
        return f.string(from: date)
    }
}

/// 새 세션 시트에서 사용자가 숨김 처리한 레포 / 이어받기 후보를 보여주고
/// 한 번에 「숨김 해제」 할 수 있게 해주는 별도 시트.
private struct HiddenItemsSheet: View {
    @EnvironmentObject var hiddenItems: HiddenItemsStore
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    if hiddenItems.hiddenRecentPaths.isEmpty {
                        Text("숨긴 레포가 없어요.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(sortedRecents, id: \.self) { path in
                            HStack(alignment: .top, spacing: 10) {
                                Image(systemName: "folder")
                                    .foregroundStyle(.secondary)
                                    .frame(width: 18)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text((path as NSString).lastPathComponent)
                                        .font(.body.weight(.medium))
                                        .lineLimit(1)
                                    Text(path)
                                        .font(.caption2.monospaced())
                                        .foregroundStyle(.secondary)
                                        .lineLimit(1)
                                        .truncationMode(.middle)
                                }
                                Spacer()
                                Button {
                                    hiddenItems.unhideRecent(path)
                                } label: {
                                    Label("해제", systemImage: "eye")
                                        .font(.caption)
                                }
                                .buttonStyle(.borderless)
                            }
                            .padding(.vertical, 2)
                        }
                    }
                } header: {
                    Text("숨긴 레포")
                } footer: {
                    Text("숨김을 해제하면 다음에 새 세션 시트를 열 때 다시 목록에 표시돼요.")
                        .font(.caption2)
                }

                Section {
                    if hiddenItems.hiddenResumes.isEmpty {
                        Text("숨긴 이어받기 후보가 없어요.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(sortedResumes) { meta in
                            HStack(alignment: .top, spacing: 10) {
                                Image(systemName: "arrow.triangle.2.circlepath")
                                    .foregroundStyle(.secondary)
                                    .frame(width: 18)
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(meta.preview ?? "(미리보기 없음 · \(meta.sessionId.prefix(8)))")
                                        .font(.callout)
                                        .lineLimit(2)
                                        .multilineTextAlignment(.leading)
                                    HStack(spacing: 6) {
                                        if let branch = meta.gitBranch, !branch.isEmpty {
                                            Label(branch, systemImage: "arrow.triangle.branch")
                                                .font(.caption2)
                                                .foregroundStyle(.tertiary)
                                        }
                                        Text(meta.repoPath)
                                            .font(.caption2.monospaced())
                                            .foregroundStyle(.tertiary)
                                            .lineLimit(1)
                                            .truncationMode(.middle)
                                    }
                                }
                                Spacer()
                                Button {
                                    hiddenItems.unhideResume(meta.sessionId)
                                } label: {
                                    Label("해제", systemImage: "eye")
                                        .font(.caption)
                                }
                                .buttonStyle(.borderless)
                            }
                            .padding(.vertical, 2)
                        }
                    }
                } header: {
                    Text("숨긴 이어받기")
                } footer: {
                    Text("숨길 당시의 미리보기 / 레포 경로 / 브랜치 정보를 기반으로 보여줍니다. 데스크탑에서 해당 세션이 사라졌어도 이 목록에서는 해제할 수 있어요.")
                        .font(.caption2)
                }
            }
            .navigationTitle("숨김 관리")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("닫기") { dismiss() }
                }
            }
        }
    }

    private var sortedRecents: [String] {
        hiddenItems.hiddenRecentPaths.sorted()
    }

    private var sortedResumes: [HiddenResumeMeta] {
        hiddenItems.hiddenResumes.sorted { $0.lastActiveAt > $1.lastActiveAt }
    }
}

// MARK: - 승인 검토 시트 (대기 요청별 diff/요약 미리보기 + 선택적 묶음 승인)

/// 동시에 대기 중인 «승인 요청» 들을 한 시트에 모아, 각 세션이 «무엇을 바꾸려는가»(보류 prompt
/// 요약 + diff 요약 + 레포)와 함께 나열하고 개별 토글 후 «선택 승인»/«전체 승인»/개별 «거절» 을
/// 처리한다. 그룹 헤더 «모두 승인»·대기 배너 「검토」·대기 필터 헤더가 이 시트를 띄운다.
///
/// 색 = 의미 토큰 (DesignTokens 정책): 승인/추가=success(초록)·거절/실패=danger(빨강)·선택
/// 체크=accent(보라). diff 추가/삭제도 같은 success/danger. 본문은 `.primary`/`.secondary` 자동
/// 적응 — 하드코딩·전역 tint 없음. 간격/코너/불투명도는 Theme 토큰(4pt 그리드)을 쓴다.
struct ApprovalReviewSheet: View {
    let sessions: [SessionSummary]
    let auth: AuthStore
    let conn: ConnectionManager
    let inflight: InFlightTracker
    /// 승인/거절을 한 건이라도 처리한 뒤 부모가 활성 목록을 다시 받도록 알린다.
    var onFinished: () -> Void

    @Environment(\.dismiss) private var dismiss
    @StateObject private var model: ApprovalReviewModel

    init(
        sessions: [SessionSummary],
        auth: AuthStore,
        conn: ConnectionManager,
        inflight: InFlightTracker,
        onFinished: @escaping () -> Void,
    ) {
        self.sessions = sessions
        self.auth = auth
        self.conn = conn
        self.inflight = inflight
        self.onFinished = onFinished
        _model = StateObject(wrappedValue: ApprovalReviewModel(
            sessions: sessions, auth: auth, conn: conn, inflight: inflight,
        ))
    }

    var body: some View {
        NavigationStack {
            Group {
                if model.items.isEmpty {
                    emptyState
                } else {
                    list
                }
            }
            .navigationTitle("승인 검토")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    // 「닫기」 는 해제 동작 — 강조색이 아니라 중립(primary)으로 둔다(색 정책).
                    Button("닫기") { dismiss() }
                        .tint(Color.primary)
                }
            }
            .safeAreaInset(edge: .bottom) { footer }
        }
        .task { await model.loadDiffs() }
        // 처리(승인/거절)가 끝나 더 볼 게 없으면 자동으로 닫고 부모를 갱신한다.
        .onChange(of: model.didFinishAll) { finished in
            if finished {
                onFinished()
                dismiss()
            }
        }
    }

    // MARK: 빈 상태 — 진입 사이 대기 요청이 모두 사라진 경우 (placeholder 아이콘 토큰 사용).
    private var emptyState: some View {
        VStack(spacing: Theme.Spacing.xxl) {
            Image(systemName: "checkmark.circle")
                .font(.system(size: Theme.IconSize.l))
                .foregroundStyle(Theme.success)
            Text("지금 승인을 기다리는 요청이 없어요.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, Theme.Spacing.xxxl)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var list: some View {
        List {
            Section {
                ForEach(model.items) { item in
                    ApprovalReviewRow(
                        item: item,
                        onToggleSelect: { model.toggleSelect(item.id) },
                        onReject: { Task { await model.reject(item.id) } },
                    )
                }
            } footer: {
                Text("각 요청이 무엇을 바꾸려는지 확인하고, 골라서 승인하거나 모두 한 번에 승인하세요.")
                    .font(.caption)
            }
        }
        .listStyle(.insetGrouped)
    }

    // MARK: 하단 액션 바 — 처리할 게 남아 있으면 전체/선택 승인, 다 끝나면 완료.
    @ViewBuilder
    private var footer: some View {
        if !model.items.isEmpty {
            VStack(spacing: Theme.Spacing.m) {
                if model.hasActionable {
                    HStack(spacing: Theme.Spacing.xl) {
                        // 「전체 승인」 — 남은 모든 요청을 승인. 보조(테두리) 버튼.
                        Button {
                            Task { await model.approve(selectedOnly: false) }
                        } label: {
                            Text("전체 승인")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.bordered)
                        .tint(Theme.success)
                        .disabled(model.busy)
                        .accessibilityLabel(Text("대기 중인 요청 전체 승인"))

                        // 「선택 승인 (N)」 — 토글한 요청만 승인. 1차(채움) 버튼. 0건이면 비활성.
                        Button {
                            Task { await model.approve(selectedOnly: true) }
                        } label: {
                            Text("선택 승인 \(model.selectedActionableCount)")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(Theme.success)
                        .disabled(model.busy || model.selectedActionableCount == 0)
                        .accessibilityLabel(Text("선택한 요청 \(model.selectedActionableCount)건 승인"))
                    }
                    if model.busy {
                        ProgressView()
                    }
                } else {
                    Button {
                        onFinished()
                        dismiss()
                    } label: {
                        Text("완료")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(Theme.accent)
                }
            }
            .padding(.horizontal, Theme.Spacing.xxl)
            .padding(.vertical, Theme.Spacing.xl)
            .background(.bar)
        }
    }
}

/// 승인 검토 시트의 한 행 — 선택 체크(accent) + 제목 + 레포 + 보류 요약 + diff 요약 + 상태/거절.
private struct ApprovalReviewRow: View {
    let item: ApprovalReviewModel.Item
    var onToggleSelect: () -> Void
    var onReject: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: Theme.Spacing.xl) {
            // 선택 체크 — 「무엇을 골라 승인하는가」. 처리 가능(대기/실패)일 때만 토글, 끝난 행은 비활성.
            // 선택 표식은 accent(보라) = 선택의 약속색.
            Button(action: onToggleSelect) {
                Image(systemName: item.selected ? "checkmark.circle.fill" : "circle")
                    .font(.title3)
                    .foregroundStyle(item.selected ? Theme.accent : Color.secondary)
            }
            .buttonStyle(.plain)
            .disabled(!item.actionable)
            .accessibilityLabel(item.selected ? Text("선택됨") : Text("선택 안 됨"))
            .accessibilityHint(Text("\(item.title) 승인 요청 선택 전환"))

            VStack(alignment: .leading, spacing: Theme.Spacing.s) {
                Text(item.title)
                    .font(.headline)
                    .lineLimit(1)
                    .truncationMode(.tail)

                Text(item.repoName)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)

                // 보류 요약 — 「지금 무엇을 묻고 멈췄는가」(실행하려는 명령/질문). 에이전트 출력이라
                // 번역 대상이 아니다 → verbatim. 없으면 줄을 그리지 않는다.
                if let preview = item.preview {
                    Text(verbatim: preview)
                        .font(.subheadline)
                        .foregroundStyle(.primary)
                        .lineLimit(3)
                        .padding(Theme.Spacing.m)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(
                            RoundedRectangle(cornerRadius: Theme.Radius.s)
                                .fill(Color.secondary.opacity(Theme.Opacity.hairline)),
                        )
                }

                diffSummary

                statusFooter
            }
        }
        .padding(.vertical, Theme.Spacing.xs)
    }

    // MARK: diff 요약 — 변경 파일 수 + 추가(success)/삭제(danger). 로딩/없음 상태 구분.
    @ViewBuilder
    private var diffSummary: some View {
        if !item.diffLoaded {
            // 로딩 중 — 그 세션의 변경 요약을 받는 중(보이는 만큼만 lazy fetch).
            HStack(spacing: Theme.Spacing.s) {
                ProgressView().controlSize(.mini)
                Text("변경 요약 불러오는 중…")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        } else if let diff = item.diff, diff.files > 0 {
            HStack(spacing: Theme.Spacing.l) {
                Label {
                    Text(verbatim: "\(diff.files)")
                } icon: {
                    Image(systemName: "doc.text")
                }
                .font(.caption)
                .foregroundStyle(.secondary)

                if diff.additions > 0 {
                    Text(verbatim: "+\(diff.additions)")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(Theme.success)
                }
                if diff.deletions > 0 {
                    Text(verbatim: "-\(diff.deletions)")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(Theme.danger)
                }
            }
            .labelStyle(.titleAndIcon)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text("변경 파일 \(diff.files)개, 추가 \(diff.additions)줄, 삭제 \(diff.deletions)줄"))
        } else {
            Text("변경 요약 없음")
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
    }

    // MARK: 상태/거절 — 대기 행은 「거절」(danger), 처리 후엔 결과 배지.
    @ViewBuilder
    private var statusFooter: some View {
        switch item.status {
        case .pending, .failed:
            HStack(spacing: Theme.Spacing.l) {
                if item.status == .failed {
                    Label("실패", systemImage: "exclamationmark.circle.fill")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Theme.danger)
                        .labelStyle(.titleAndIcon)
                }
                Spacer(minLength: 0)
                Button(role: .destructive, action: onReject) {
                    Label("거절", systemImage: "xmark")
                        .font(.caption.weight(.semibold))
                        .labelStyle(.titleAndIcon)
                }
                .buttonStyle(.bordered)
                .tint(Theme.danger)
                .accessibilityLabel(Text("이 요청 거절"))
            }
        case .approving:
            statusLabel(spinner: true, text: "승인 중", color: .secondary)
        case .rejecting:
            statusLabel(spinner: true, text: "거절 중", color: .secondary)
        case .approved:
            statusLabel(icon: "checkmark.circle.fill", text: "승인됨", color: Theme.success)
        case .rejected:
            statusLabel(icon: "xmark.circle.fill", text: "거절됨", color: Theme.danger)
        }
    }

    private func statusLabel(
        spinner: Bool = false,
        icon: String = "",
        text: LocalizedStringKey,
        color: Color,
    ) -> some View {
        HStack(spacing: Theme.Spacing.s) {
            if spinner {
                ProgressView().controlSize(.mini)
            } else {
                Image(systemName: icon)
            }
            Text(text)
        }
        .font(.caption.weight(.semibold))
        .foregroundStyle(color)
    }
}

/// 승인 검토 시트의 상태 머신 — 각 대기 세션을 항목으로 들고, diff 요약을 lazy 로 채우며,
/// per-session pty 제어(승인=Enter / 거절=ESC)를 직렬 전송한다. 한 건 실패해도 나머지는 계속
/// (부분 성공 허용). 모든 항목이 처리되면 didFinishAll 로 시트 자동 종료를 신호한다.
@MainActor
final class ApprovalReviewModel: ObservableObject {
    /// 한 요청의 처리 상태 — 대기·승인중·승인됨·거절중·거절됨·실패.
    enum RowStatus: Equatable { case pending, approving, approved, rejecting, rejected, failed }

    /// diff 요약 — 변경 파일 수 + 추가/삭제 라인 합.
    struct DiffSummary: Equatable {
        let files: Int
        let additions: Int
        let deletions: Int
    }

    struct Item: Identifiable {
        let session: SessionSummary
        var selected: Bool
        var status: RowStatus
        /// diff 요약을 받았는지 — false 면 행이 로딩 표시.
        var diffLoaded: Bool
        /// 받은 diff 요약 — 없거나(받기 실패/비-repo) 변경 0건이면 nil.
        var diff: DiffSummary?

        var id: String { session.id }
        var title: String { session.title ?? String(localized: "제목 없음") }
        var repoName: String { RepoGroupHeader.displayName(session.repo_path) }
        var preview: String? { session.pendingPromptPreview }
        /// 처리 가능 — 아직 대기 중이거나 실패해 재시도할 수 있는 행.
        var actionable: Bool { status == .pending || status == .failed }
    }

    @Published var items: [Item]
    /// 전체/선택 승인 진행 중 — 버튼 비활성·스피너 게이트.
    @Published var busy = false
    /// 모든 항목이 처리돼(처리 가능한 행이 0) 시트를 닫아도 되는지.
    @Published var didFinishAll = false

    private let auth: AuthStore
    private let conn: ConnectionManager
    private let inflight: InFlightTracker

    init(sessions: [SessionSummary], auth: AuthStore, conn: ConnectionManager, inflight: InFlightTracker) {
        self.auth = auth
        self.conn = conn
        self.inflight = inflight
        // 기본 전체 선택 — 「골라서 빼는」 흐름이 일반적인 일괄 승인보다 안전하고 빠르다.
        self.items = sessions.map {
            Item(session: $0, selected: true, status: .pending, diffLoaded: false, diff: nil)
        }
    }

    /// 처리 가능(대기/실패)한 항목이 남아 있는지 — 하단 바가 승인 버튼/완료를 가른다.
    var hasActionable: Bool { items.contains { $0.actionable } }
    /// 선택된 처리 가능 항목 수 — 「선택 승인 (N)」 배지/활성 게이트.
    var selectedActionableCount: Int { items.filter { $0.actionable && $0.selected }.count }

    /// 각 세션의 변경 요약을 직렬로 받아 채운다(목록 fetch엔 없어 lazy). label nil — in-flight
    /// 배너에 잡히지 않게 조용히. 실패/비-repo 는 diff nil 로 흡수(행은 「변경 요약 없음」).
    func loadDiffs() async {
        let api = ApiClient(auth: auth, conn: conn, tracker: nil)
        for idx in items.indices {
            let sid = items[idx].session.id
            let status = try? await api.gitStatus(sessionId: sid, label: nil)
            let summary = status.map { s in
                DiffSummary(
                    files: s.total,
                    additions: s.files.reduce(0) { $0 + $1.additions },
                    deletions: s.files.reduce(0) { $0 + $1.deletions },
                )
            }
            if let i = items.firstIndex(where: { $0.id == sid }) {
                items[i].diffLoaded = true
                items[i].diff = summary
            }
        }
    }

    func toggleSelect(_ id: String) {
        guard let i = items.firstIndex(where: { $0.id == id }) else { return }
        guard items[i].actionable else { return }
        items[i].selected.toggle()
    }

    /// 승인 — selectedOnly 면 토글한 처리 가능 항목만, 아니면 처리 가능 항목 전부에 Enter 를
    /// 직렬 전송한다. 각 행을 승인중→승인됨/실패로 전이. 끝나면 완료 여부를 재평가.
    func approve(selectedOnly: Bool) async {
        let targets = items.filter { $0.actionable && (selectedOnly ? $0.selected : true) }.map { $0.id }
        guard !targets.isEmpty else { return }
        busy = true
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        for sid in targets {
            setStatus(sid, .approving)
            let ok = await send(api, sid, .approve)
            setStatus(sid, ok ? .approved : .failed)
        }
        busy = false
        evaluateFinish()
    }

    /// 거절 — 한 행에 ESC(진행 turn 중단)를 보낸다. 거절중→거절됨/실패.
    func reject(_ id: String) async {
        guard items.contains(where: { $0.id == id && $0.actionable }) else { return }
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        setStatus(id, .rejecting)
        let ok = await send(api, id, .interrupt)
        setStatus(id, ok ? .rejected : .failed)
        evaluateFinish()
    }

    private func send(_ api: ApiClient, _ sid: String, _ action: PtyControlAction) async -> Bool {
        do {
            try await api.ptyControl(sessionId: sid, action: action)
            return true
        } catch {
            return false
        }
    }

    private func setStatus(_ id: String, _ status: RowStatus) {
        guard let i = items.firstIndex(where: { $0.id == id }) else { return }
        items[i].status = status
    }

    private func evaluateFinish() {
        if !hasActionable { didFinishAll = true }
    }
}
