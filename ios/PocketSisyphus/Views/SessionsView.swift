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
                        // 채움(accent/보라) 위 라벨은 흰색으로 고정 — tint 색이 글자·아이콘에
                        // 새어 파랗게 읽히지 않도록(흰 글자가 일관됨).
                        .foregroundStyle(.white)
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
