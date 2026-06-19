import SwiftUI
import UIKit  // UIPasteboard — gh 설치/로그인 한 줄 명령 복사 (iCloud 클립보드로 Mac 에 붙여넣기)

/// 백로그(PO 루프) — 1번 탭. 에이전트가 신호(이슈·레포 todo·문서)를 종합해 만든 «기회
/// 브리프» 를 사람이 결재(승인/보류/기각)만 하는 화면.
///
/// 약한 고리 배경: AI 개발 루프에서 코딩은 분 단위인데 «무엇을 만들지» 는 사람이 생각날
/// 때만 공급돼 일~주 단위로 멈춘다. 이 탭은 사람의 역할을 «생산» 에서 «결재» 로 줄인다 —
/// 승인 즉시 daemon 이 구현 세션을 spawn 하고 세션 탭으로 딥링크된다.
struct BacklogView: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var conn: ConnectionManager
    @EnvironmentObject var inflight: InFlightTracker
    @EnvironmentObject var deepLink: DeepLinkRouter

    /// daemon capability 목록 — 수집 시트의 «주기 수집» 섹션 노출 분기 (po_schedule_v1, soft).
    let capabilities: [String]
    /// 승인(구현 세션)/수집 세션 열기 — MainTabView 가 세션 탭 전환 + 딥링크로 처리.
    let onOpenSession: (String) -> Void

    /// 프로그래매틱 push (브리프 딥링크) 용 — NavigationStack(path:) 와 짝.
    @State private var path = NavigationPath()
    @State private var briefs: [PoBrief] = []
    /// 리서치 요청 목록 — running 은 진행 표시, done 은 보고서 진입점.
    @State private var research: [PoResearch] = []
    @State private var loading = false
    @State private var error: String?
    /// 진행 중인 수집 세션 id — «지금 수집» 직후 상단 배너로 노출. 새 브리프가 도착하면 비운다.
    @State private var collectingSessionId: String?
    /// 진행 중인 수집의 대상 레포 — 같은 레포의 shipped 브리프 상세에 «검증 중» 을 띄우기 위함.
    /// 수집 파이프가 그 레포의 shipped 브리프 가설 대조를 함께 수행하므로 «검증 중» 과 같은 신호다.
    @State private var collectingRepoPath: String?
    /// 직전 수집의 GitHub 신호 가용성 점검 (po_gh_check_v1) — gh 미설치/미인증일 때만 set 되어
    /// 안내 톤 배너로 노출. 정상/옛 daemon/비-GitHub 레포는 nil → 아무 UI 도 안 뜬다 (조용함 보장).
    @State private var collectGhNotice: GhCollectCheck?
    /// 직전 수집의 App Store 신호 가용성 점검 (po_asc_check_v1) — ASC 키 미설정/만료·폐기일 때만
    /// set 되어 안내 톤 배너로 노출. 정상/꺼짐/옛 daemon/불확실은 nil → 아무 UI 도 안 뜬다.
    @State private var collectAscNotice: AscCollectCheck?
    /// 직전 수집의 «App Store 신호원 실행 상태» (po_signal_status_v1) — 수집이 «끝난 뒤» fetch 의
    /// 실제 결과(store/crash 가 used(N)/empty/실패). asc-check 의 «수집 직전 프로브»(collectAscNotice)
    /// 와 달리 이건 실행 결과라 used·app id·네트워크까지 구분 → 결과 카드로 노출. 신호 안 켰거나
    /// 옛 daemon/로드 실패는 nil → 카드 안 뜸 (잡음 금지).
    @State private var collectSignals: CollectSignals?
    /// 위 두 안내 배너가 «어느 프로젝트의 수집» 이었는지 — «전체» 필터에선 어떤 레포를 점검했는지
    /// 안 보여 모호하다는 피드백(2026-06). 직전 수집 repoPath 를 기억해 배너에 프로젝트명을 곁들인다.
    /// 배너가 안 떠 있으면 읽히지 않으므로 dismiss 시 따로 비우지 않는다 (다음 수집이 덮어쓴다).
    @State private var collectNoticeRepoPath: String?
    @State private var showCollectSheet = false
    @State private var showResearchSheet = false
    /// 설정 시트 — 좌상단 기어 버튼이 띄운다. 설정 진입을 모든 메인 탭(세션·자동화·백로그)의
    /// «같은 자리»(좌상단)에 일관되게 두려고 백로그 탭에도 추가했다(이전엔 세션·자동화 탭에만 있었다).
    @State private var showSettings = false
    /// 결재 대기 트리아지 시트 — 점수 티어 그룹핑·필터·일괄 보류/기각의 «우선» 결재 흐름.
    @State private var showTriage = false
    /// 누적 성적표 (po_stats_v1) — 승인율·검증 적중·결재 중앙값. 미지원 daemon/로드 실패는
    /// nil → 카드 자체를 숨긴다 (soft).
    @State private var stats: PoStats?
    @State private var showStatsSheet = false
    /// 성적표 «검증 사유» 탭 → 열 브리프 id. 시트가 닫힌 뒤 onDismiss 에서 소비해 push.
    @State private var pendingStatsBriefId: String?
    /// 수집/리서치/구현을 돌릴 수 있는 에이전트 후보 — daemon `/api/agents` 에서 로드하고
    /// 예약 작업과 같은 «무인 실행 적합» (cron_eligible_v1) 만 남긴다. 로드 전/실패는 fallback.
    @State private var agents: [AgentInfo] = [AgentInfo.claudeCodeFallback]
    /// «전체 / <레포>» 전환 — nil 이 전체(기본). 여러 프로젝트의 브리프를 한 리스트로 훑는
    /// 게 기본값이고, 레포 하나에 집중하고 싶을 때만 좁힌다. 세션 간 저장 안 함 (전체가 기본).
    @State private var repoFilter: String?
    /// «구현 다시 시작» 진행 중인 브리프 id (po_exec_restart_v1) — 행을 비활성/로딩 표시하고
    /// 중복 탭을 막는다. 새 세션이 떠 딥링크되면 비운다.
    @State private var restartingBriefId: String?
    /// 승인·재시작에 맡길 에이전트의 «마지막 선택» — 브리프 상세(BriefDetailView)와 같은 @AppStorage
    /// 키를 공유해, 재시작도 매번 같은 도구로 도는 흐름(74dfc2f)을 잇는다. 픽커 미노출이면 의미 없고
    /// daemon 이 브리프에 기록된 에이전트로 폴백한다.
    @AppStorage("po.brief.lastAgentId") private var lastExecAgentId = AgentInfo.claudeCodeFallback.id

    private var api: ApiClient { ApiClient(auth: auth, conn: conn, tracker: inflight) }

    /// daemon 이 PO 흐름의 에이전트 선택(po_agent_v1)을 지원하는가 — 픽커 노출 분기.
    /// 옛 daemon 은 agent 필드를 조용히 버려 항상 claude_code 로 돌므로 픽커를 숨긴다 (soft).
    private var supportsAgentChoice: Bool {
        capabilities.contains("po_agent_v1") && agents.count > 1
    }

    /// daemon 이 «구현 다시 시작»(po_exec_restart_v1)을 지원하는가 — 진행 중 행의 회복 액션 노출 분기.
    /// 옛 daemon 은 이 라우트가 404 라 액션을 보여주면 거짓 UI 가 된다 → 숨긴다 (soft, supportsAgentChoice 패턴).
    private var supportsExecRestart: Bool {
        capabilities.contains("po_exec_restart_v1")
    }

    /// daemon 이 리서치 «조사 범위» 선택(po_research_scope_v1)을 지원하는가 — 범위 피커 노출 분기.
    /// 옛 daemon 은 scope 필드를 조용히 버려 항상 웹+레포로 돌므로 피커를 숨긴다 (soft).
    private var supportsResearchScope: Bool {
        capabilities.contains("po_research_scope_v1")
    }

    /// 브리프·리서치가 걸쳐 있는 레포들 — «전체 / <레포>» 전환 후보 (디렉토리명순).
    private var repoPaths: [String] {
        Set(briefs.map(\.repoPath)).union(research.map(\.repoPath))
            .sorted {
                ($0 as NSString).lastPathComponent
                    .localizedCaseInsensitiveCompare(($1 as NSString).lastPathComponent)
                    == .orderedAscending
            }
    }
    private var filteredBriefs: [PoBrief] {
        guard let repoFilter else { return briefs }
        return briefs.filter { $0.repoPath == repoFilter }
    }
    private var filteredResearch: [PoResearch] {
        guard let repoFilter else { return research }
        return research.filter { $0.repoPath == repoFilter }
    }

    /// 결재 대기 — 백로그의 본문. 전체 모드는 impact 내림차순(여러 프로젝트를 한 줄로 훑는
    /// 결재 순서), 단일 레포 모드는 기존 score(영향/노력) 내림차순.
    private var proposed: [PoBrief] {
        let rows = filteredBriefs.filter { $0.status == "proposed" }
        if repoFilter == nil {
            return rows.sorted {
                ($0.impact, $0.score, $0.createdAt) > ($1.impact, $1.score, $1.createdAt)
            }
        }
        return rows.sorted { ($0.score, $0.createdAt) > ($1.score, $1.createdAt) }
    }
    /// 전 레포 결재 대기 — 트리아지 시트의 입력. 메인 리스트의 repoFilter 와 무관하게 모든
    /// proposed 를 넘기고, 시트가 자체 repo/impact/검색/티어 필터를 건다.
    private var allProposed: [PoBrief] {
        briefs.filter { $0.status == "proposed" }
    }
    private var running: [PoBrief] {
        filteredBriefs.filter { $0.status == "running" || $0.status == "approved" }
            .sorted { $0.updatedAt > $1.updatedAt }
    }
    /// 구현이 끝나 출시됨 — 다음 수집 사이클의 가설 대조(verified/missed)를 기다리는 중.
    private var shipped: [PoBrief] {
        filteredBriefs.filter { $0.status == "shipped" }
            .sorted { $0.updatedAt > $1.updatedAt }
    }
    private var settled: [PoBrief] {
        filteredBriefs.filter { ["held", "rejected", "verified", "missed"].contains($0.status) }
            .sorted { $0.updatedAt > $1.updatedAt }
    }

    var body: some View {
        NavigationStack(path: $path) {
            content
        }
    }

    private var content: some View {
        Group {
            if briefs.isEmpty && research.isEmpty && !loading {
                emptyState
            } else {
                briefList
            }
        }
        .navigationTitle("백로그")
        .toolbar {
            // 설정 기어 — 모든 메인 탭의 «같은 자리»(좌상단)·같은 아이콘(gearshape). 라벨(텍스트+
            // 아이콘)이라 좁은 기기의 «…» 오버플로에서도 제대로 그려진다(세션·자동화 탭과 동일 폼).
            ToolbarItem(placement: .topBarLeading) {
                Button { showSettings = true } label: {
                    Label("설정", systemImage: "gearshape")
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                // 백로그를 만드는 두 경로 — 내부 신호 수집 / 외부 리서치(시장 조사).
                // 텍스트 라벨 유지 (아이콘만으로는 발견 불가 피드백 — iOS 26 툴바 실측).
                Menu {
                    Button {
                        showCollectSheet = true
                    } label: {
                        Label("레포 신호 수집", systemImage: "antenna.radiowaves.left.and.right")
                    }
                    Button {
                        showResearchSheet = true
                    } label: {
                        Label("리서치 요청", systemImage: "magnifyingglass")
                    }
                } label: {
                    Text("만들기")
                }
            }
        }
        // 통합 설정 시트 — 좌상단 기어 버튼이 띄운다(세션·자동화 탭과 동일). 도움말 허브도
        // 이 시트 안 «도움말» 섹션으로 들어간다.
        .sheet(isPresented: $showSettings) {
            SettingsSheet()
        }
        .sheet(isPresented: $showCollectSheet) {
            CollectRepoSheet(
                supportsSchedule: capabilities.contains("po_schedule_v1"),
                supportsAsc: capabilities.contains("po_asc_v1"),
                supportsFeedbackRepo: capabilities.contains("po_feedback_repo_v1"),
                supportsDesignBootstrap: capabilities.contains("po_design_bootstrap_v1"),
                supportsCollectLens: capabilities.contains("po_collect_lens_v1"),
                agents: supportsAgentChoice ? agents : [],
            ) { repoPath, instruction, agent, lens in
                showCollectSheet = false
                Task {
                    await startCollect(
                        repoPath: repoPath, instruction: instruction, agent: agent, lens: lens)
                }
            }
        }
        .sheet(isPresented: $showResearchSheet) {
            ResearchRequestSheet(
                agents: supportsAgentChoice ? agents : [],
                supportsLens: capabilities.contains("po_research_lens_v1"),
                supportsQaLens: capabilities.contains("po_research_lens_v2"),
                supportsSecurityLens: capabilities.contains("po_research_lens_v3"),
                supportsPmLens: capabilities.contains("po_research_lens_v4"),
                supportsMarketingLens: capabilities.contains("po_research_lens_v5"),
                supportsAnalyticsLens: capabilities.contains("po_research_lens_v6"),
                supportsOpsLens: capabilities.contains("po_research_lens_v7"),
                supportsLogicLens: capabilities.contains("po_research_lens_v8"),
                supportsUxLens: capabilities.contains("po_research_lens_v9"),
                supportsScope: supportsResearchScope,
                supportsUxScreens: capabilities.contains("po_research_ux_screens_v1"),
            ) { repoPath, topic, agent, lens, scope, screens in
                showResearchSheet = false
                Task {
                    await startResearch(
                        repoPath: repoPath, topic: topic, agent: agent, lens: lens, scope: scope,
                        screens: screens)
                }
            }
        }
        // 성적표 «검증 사유» 줄을 탭하면 그 브리프 상세로 — 시트를 닫고 백로그에서 push 한다.
        // 시트가 완전히 닫힌 «뒤» 에 path.append 해 시트 dismiss ↔ navigation 경합을 피한다
        // (딥링크 consumeBriefDeepLink 와 같은 path 기반 경로 재사용).
        .sheet(isPresented: $showStatsSheet, onDismiss: {
            guard let id = pendingStatsBriefId else { return }
            pendingStatsBriefId = nil
            if let brief = briefs.first(where: { $0.id == id }) {
                path.append(brief)
            }
        }) {
            if let stats {
                PoStatsSheet(stats: stats) { briefId in
                    // 탭 시점에 현재 로드된 목록에 있는지 확인 — 없으면(삭제됨 등) false 를
                    // 돌려 시트가 «찾을 수 없음» 안내를 띄우게 한다 (크래시 없이 무해).
                    guard briefs.contains(where: { $0.id == briefId }) else { return false }
                    pendingStatsBriefId = briefId
                    showStatsSheet = false
                    return true
                }
            }
        }
        .sheet(isPresented: $showTriage) {
            BacklogTriageView(
                briefs: allProposed,
                bulkDecide: { ids, action, reason in
                    try await bulkDecide(ids: ids, action: action, reason: reason)
                },
                // 닫을 때 재로드 — 일괄 처리분이 «처리됨» 으로 반영되고 성적표도 갱신된다.
                onClose: { Task { await reload() } },
            )
        }
        .task {
            async let agentsTask: Void = loadAgents()
            await reload()
            await agentsTask
        }
        .refreshable { await reload() }
        .onChange(of: deepLink.pendingBacklogBriefId) { _ in consumeBriefDeepLink() }
    }

    /// `pocketsisyphus://backlog/<briefId>` — 목록에 해당 브리프가 있으면 상세로 push.
    /// 목록 로드 «후» 와 딥링크 도착 «후» 양쪽에서 시도한다 (먼저 온 쪽은 no-op).
    private func consumeBriefDeepLink() {
        guard let briefId = deepLink.pendingBacklogBriefId,
              let brief = briefs.first(where: { $0.id == briefId }) else { return }
        deepLink.pendingBacklogBriefId = nil
        path.append(brief)
    }

    private var briefList: some View {
        List {
            // 누적 성적표 헤더 (po_stats_v1) — 요약 1줄, 탭하면 레포별 분해 시트.
            // 에이전트가 얼마나 맞히는지(승인율·검증 적중)를 체감시키는 신뢰 콜드스타트 해법.
            if let stats {
                Section {
                    Button {
                        showStatsSheet = true
                    } label: {
                        PoStatsSummaryRow(stats: stats)
                    }
                    .buttonStyle(.plain)
                }
            }
            // «전체 / <레포>» 전환 — 레포가 둘 이상일 때만 의미가 있다. 전체(기본)는 모든
            // 프로젝트의 브리프를 한 리스트로 — «아침에 한 번 훑고 전부 결재» 가 핵심 가치.
            if repoPaths.count > 1 {
                Section {
                    Picker(selection: $repoFilter) {
                        Text("전체").tag(String?.none)
                        ForEach(repoPaths, id: \.self) { path in
                            Text(verbatim: (path as NSString).lastPathComponent)
                                .tag(String?.some(path))
                        }
                    } label: {
                        Label("프로젝트", systemImage: "folder")
                    }
                    .pickerStyle(.menu)
                    // 피커 선택값 텍스트는 강조색이 아니라 중립(primary) — 색 정책.
                    .tint(Color.primary)
                    // List 행의 Label 아이콘은 tint 가 아니라 listItemTint 를 탄다 — 명시
                    // 없으면 파랗게 뜬다 (색 정책: 파랑 금지, BriefDetailView 관례).
                    .listItemTint(Theme.accent)
                }
            }
            if let sid = collectingSessionId {
                Section {
                    Button {
                        onOpenSession(sid)
                    } label: {
                        HStack(spacing: 8) {
                            ProgressView().controlSize(.small)
                            Text("신호 수집 진행 중 — 세션 보기")
                                .font(.callout)
                        }
                    }
                }
            }
            // 신호 가용성 안내 (po_gh_check_v1 / po_asc_check_v1) — 경고가 아니라 안내 톤.
            // 정상/꺼짐/옛 daemon/불확실은 각 notice 가 nil 이라 해당 행이 안 뜬다 (조용함 보장).
            // gh 와 asc 는 독립 — 둘 다 문제면 두 행이 같은 Section 에 함께 뜬다.
            if collectGhNotice != nil || collectAscNotice != nil {
                Section {
                    if let gh = collectGhNotice {
                        CollectGhNoticeRow(gh: gh, repoName: collectNoticeRepoName) { collectGhNotice = nil }
                    }
                    if let asc = collectAscNotice {
                        CollectAscNoticeRow(asc: asc, repoName: collectNoticeRepoName) { collectAscNotice = nil }
                    }
                }
            }
            // 수집 결과 — 직전 수집에서 App Store 신호가 실제 반영됐는지 (po_signal_status_v1).
            // 신호 안 켰으면 nil 이라 안 뜬다 (잡음 금지).
            if let signals = collectSignals {
                Section {
                    CollectSignalsCard(signals: signals, repoName: collectNoticeRepoName) {
                        collectSignals = nil
                    }
                }
            }
            if let error {
                Section {
                    Text(LocalizedStringKey(error))
                        .font(.caption)
                        .foregroundStyle(Theme.danger)
                }
            }
            if !filteredResearch.isEmpty {
                Section("리서치") {
                    ForEach(filteredResearch.prefix(5)) { item in
                        if item.status == "running" {
                            // 조사 중 — 탭하면 리서치 세션을 관전.
                            Button {
                                if let sid = item.sessionId { onOpenSession(sid) }
                            } label: {
                                ResearchRow(research: item, showRepo: repoFilter == nil)
                            }
                            .buttonStyle(.plain)
                            // 조사 중도 삭제 가능 — 리서치 세션을 임의로 정지하면 running 이
                            // 영원히 남는다(done/failed 전이는 세션 정착 시에만). 진행 중 브리프와
                            // 같은 정책: 항목만 지우고 세션은 건드리지 않는다. full swipe 는 막는다.
                            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                                Button(role: .destructive) {
                                    Task { await removeResearch(item) }
                                } label: {
                                    Label("삭제", systemImage: "trash")
                                }
                            }
                        } else {
                            NavigationLink(value: item) {
                                ResearchRow(research: item, showRepo: repoFilter == nil)
                            }
                            .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                                Button(role: .destructive) {
                                    Task { await removeResearch(item) }
                                } label: {
                                    Label("삭제", systemImage: "trash")
                                }
                            }
                        }
                    }
                }
            }
            if !proposed.isEmpty {
                Section {
                    ForEach(proposed) { brief in
                        NavigationLink(value: brief) {
                            BriefRow(brief: brief, showRepo: repoFilter == nil)
                        }
                    }
                } header: {
                    HStack {
                        Text("결재 대기")
                        Spacer()
                        // 트리아지 — 점수 티어 그룹핑·필터·일괄 보류/기각의 «우선» 결재 흐름. 전 레포
                        // 결재 대기를 대상으로(시트가 자체 repo 필터). 메인 리스트의 단건 결재·딥링크는
                        // 그대로 둔다(추가 surface). 200건이어도 티어 접기/필터로 한눈에.
                        Button {
                            showTriage = true
                        } label: {
                            Label("트리아지", systemImage: "slider.horizontal.3")
                                .font(.caption.weight(.semibold))
                        }
                        .textCase(nil)
                        .accessibilityLabel(Text("트리아지"))
                    }
                }
            }
            if !running.isEmpty {
                Section("진행 중") {
                    ForEach(running) { brief in
                        runningBriefRow(brief)
                    }
                }
            }
            if !shipped.isEmpty {
                // 출시 후 검증 루프 — 다음 수집이 가설을 대조해 verified/missed 로 종결한다.
                // footer 가 «이어서 쓰는 법» 을 안내하고, 기다리기 싫으면 밀어서 삭제할 수 있다.
                Section {
                    ForEach(shipped) { brief in
                        NavigationLink(value: brief) {
                            BriefRow(brief: brief, showRepo: repoFilter == nil)
                        }
                            .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                                Button(role: .destructive) {
                                    Task { await remove(brief) }
                                } label: {
                                    Label("삭제", systemImage: "trash")
                                }
                            }
                    }
                } header: {
                    Text("출시됨 — 검증 대기")
                } footer: {
                    Text("같은 레포에 «레포 신호 수집» 을 다시 돌리면 가설이 대조돼 검증됨/빗나감으로 종결돼요. 기다리지 않으려면 왼쪽으로 밀어 삭제할 수 있어요.")
                }
            }
            if !settled.isEmpty {
                Section("처리됨") {
                    ForEach(settled) { brief in
                        NavigationLink(value: brief) {
                            BriefRow(brief: brief, showRepo: repoFilter == nil)
                        }
                            .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                                Button(role: .destructive) {
                                    Task { await remove(brief) }
                                } label: {
                                    Label("삭제", systemImage: "trash")
                                }
                            }
                    }
                }
            }
        }
        .navigationDestination(for: PoResearch.self) { item in
            ResearchReportView(researchId: item.id)
        }
        .navigationDestination(for: PoBrief.self) { brief in
            BriefDetailView(
                brief: brief,
                supportsWorktree: capabilities.contains("po_worktree_v1"),
                supportsCleanup: capabilities.contains("po_cleanup_v1"),
                supportsWorkflowMode: capabilities.contains("po_workflow_v1"),
                agents: supportsAgentChoice ? agents : [],
                // 이 브리프의 레포에서 수집이 돌고 있으면 그 세션 id — shipped 상세가 «검증 중» 으로 바뀐다.
                verifyingSessionId: (collectingRepoPath == brief.repoPath) ? collectingSessionId : nil,
                onOpenSession: onOpenSession,
                onDecided: { updated, execSessionId in
                    applyUpdate(updated)
                    if let execSessionId {
                        onOpenSession(execSessionId)
                    }
                },
                onRevised: {
                    // 재종합 시작됨 — 목록을 다시 읽어 «재종합 중» 배지를 띄운다.
                    Task { await reload() }
                },
                onVerifyCollect: { started in
                    // «지금 수집해 검증» 시작됨 — 진행 배너로 노출 (수집 완료 시 자동으로 내려감).
                    applyCollectStart(started, repoPath: brief.repoPath)
                },
            )
        }
    }

    private var emptyState: some View {
        // 쌍둥이 빈 상태(ApprovalReviewSheet)와 동일하게 토큰화 — VStack 간격은 Theme.Spacing.xxl(16),
        // placeholder 아이콘은 Theme.IconSize.l(44). 기존 spacing:14 는 4pt 그리드 밖이라 «쌍둥이 정합»
        // 으로 16 정규화(의도된 2px), 아이콘 44 는 IconSize.l 과 동일값이라 픽셀 불변.
        VStack(spacing: Theme.Spacing.xxl) {
            Image(systemName: "list.clipboard")
                .font(.system(size: Theme.IconSize.l))
                .foregroundStyle(Theme.pro)
            Text("아직 제안이 없어요")
                .font(.title3.weight(.semibold))
            Text("«지금 수집» 을 누르면 PO 에이전트가 레포의 신호(이슈·TODO·문서)를 모아 기회 브리프를 제안해요. 당신은 승인만 하면 돼요.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, Theme.Spacing.xxxxl)
            if let sid = collectingSessionId {
                Button {
                    onOpenSession(sid)
                } label: {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text("신호 수집 진행 중 — 세션 보기")
                    }
                }
                .buttonStyle(.bordered)
            } else {
                Button {
                    showCollectSheet = true
                } label: {
                    Label("지금 수집", systemImage: "antenna.radiowaves.left.and.right")
                }
                .buttonStyle(.borderedProminent)
                // 기본 prominent 가 (iOS 26 시뮬레이터에서) AccentColor 에셋을 안 타고 파랗게
                // 떠서 명시 — PaywallView 와 같은 관례. 파랑 금지(색 정책).
                .tint(Theme.accent)
            }
            // 0건 수집은 emptyState 로 떨어진다 — gh/asc 신호에 문제가 있으면 여기서도 안내한다.
            if let gh = collectGhNotice {
                CollectGhNoticeRow(gh: gh, repoName: collectNoticeRepoName) { collectGhNotice = nil }
                    .padding(.horizontal, 24)
            }
            if let asc = collectAscNotice {
                CollectAscNoticeRow(asc: asc, repoName: collectNoticeRepoName) { collectAscNotice = nil }
                    .padding(.horizontal, 24)
            }
            // 0건 수집이어도 켠 신호가 실제 반영됐는지(혹은 빠졌는지)는 여기서 보인다.
            if let signals = collectSignals {
                CollectSignalsCard(signals: signals, repoName: collectNoticeRepoName) {
                    collectSignals = nil
                }
                .padding(.horizontal, 24)
            }
            if let error {
                Text(LocalizedStringKey(error))
                    .font(.caption)
                    .foregroundStyle(Theme.danger)
                    .padding(.horizontal)
            }
            // 백로그 탭을 처음 연 사용자를 위한 in-app 가이드 진입점 (도움말 허브 «백로그(PO 루프)» 글).
            StuckHelpLink(label: "백로그가 처음인가요? 도움받기", guideCategory: "backlog")
                .padding(.top, 4)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func reload() async {
        loading = true
        defer { loading = false }
        do {
            async let briefsTask = api.listPoBriefs()
            async let researchTask = api.listPoResearch()
            async let statsTask: Void = loadStats()
            let fresh = try await briefsTask
            // 리서치 목록은 보조 — 실패해도 브리프는 보여 준다 (구 daemon 404 포함).
            research = (try? await researchTask) ?? []
            // 수집이 끝나 새 브리프가 도착했으면 진행 배너를 내린다.
            if let sid = collectingSessionId, fresh.contains(where: { $0.collectSessionId == sid }) {
                collectingSessionId = nil
                collectingRepoPath = nil
            }
            briefs = fresh
            error = nil
            normalizeRepoFilter()
            consumeBriefDeepLink()
            await statsTask
            // 진행 중 수집의 «신호원 실행 상태» 를 폴링 — 끝났으면(sessionId 일치) 결과 카드를 띄우고
            // 진행 배너를 내린다. 0건 수집(브리프로 완료를 못 잡는 경우)도 이 경로가 잡는다.
            await pollCollectSignals()
        } catch {
            if ApiError.isCancellation(error) { return }
            self.error = (error as? LocalizedError)?.errorDescription ?? "\(error)"
        }
    }

    /// 진행 중인 수집의 신호원 실행 상태(po_signal_status_v1)를 폴링한다. daemon 이 그 수집
    /// (sessionId 일치)을 끝내고 상태를 persist 했으면 결과 카드를 띄우고 진행 배너를 내린다.
    /// 신호가 «켜져» 있을 때만(off/unknown 만이면 침묵) 카드를 노출하고, 같은 ASC 건이라 수집
    /// 직전 프로브 안내(collectAscNotice)는 중복 제거한다. 미지원 daemon/로드 실패는 조용히 무시.
    private func pollCollectSignals() async {
        guard capabilities.contains("po_signal_status_v1") else { return }
        guard let sid = collectingSessionId, let repo = collectNoticeRepoPath else { return }
        guard let result = try? await api.getLastCollectSignals(repoPath: repo) else { return }
        guard result.sessionId == sid, let signals = result.signals else { return }
        collectingSessionId = nil
        collectingRepoPath = nil
        // 신호가 꺼져 있었으면(둘 다 off) 카드 없이 조용히 — 안 켠 사용자에겐 잡음.
        collectSignals = signals.enabled ? signals : nil
        // 실행 결과가 더 정확하므로 수집 직전 프로브 ASC 안내는 거둔다 (한 건 중복 표시 방지).
        if collectSignals != nil { collectAscNotice = nil }
    }

    /// 누적 성적표 로드 — capability 게이트 (po_stats_v1). 실패/미지원은 nil 로 카드 숨김 (soft).
    private func loadStats() async {
        guard capabilities.contains("po_stats_v1") else { return }
        stats = try? await api.getPoStats(label: nil)
    }

    private func startResearch(
        repoPath: String, topic: String, agent: String?, lens: String?, scope: String?,
        screens: Bool?,
    ) async {
        do {
            _ = try await api.startPoResearch(
                repoPath: repoPath, topic: topic, agent: agent, lens: lens, scope: scope,
                screens: screens)
            error = nil
            await reload()   // running 리서치 행이 곧장 보이게
        } catch {
            self.error = (error as? LocalizedError)?.errorDescription ?? "\(error)"
        }
    }

    /// 에이전트 후보 로드 — 예약 작업 픽커와 같은 «무인 실행 적합» (cron_eligible_v1) 필터.
    /// PO 수집/리서치/구현은 프롬프트 1번 + settle 대기의 무인 흐름이라 cron 과 제약이 같다.
    /// 옛 daemon(404)/실패는 fallback 유지 — supportsAgentChoice 가 픽커를 숨긴다.
    private func loadAgents() async {
        guard capabilities.contains("po_agent_v1") else { return }
        if let list = try? await api.listAgents(label: nil), !list.isEmpty {
            let eligible = list.filter { $0.capabilities.contains("cron_eligible_v1") }
            agents = eligible.isEmpty ? list : eligible
        }
    }

    private func removeResearch(_ item: PoResearch) async {
        do {
            try await api.deletePoResearch(id: item.id)
            research.removeAll { $0.id == item.id }
            normalizeRepoFilter()
        } catch {
            self.error = (error as? LocalizedError)?.errorDescription ?? "\(error)"
        }
    }

    /// 선택했던 레포의 항목이 모두 사라지면(삭제/재로드) 전체 모드로 복귀 —
    /// 빈 필터에 갇혀 «아무것도 없어 보이는» 상태를 막는다.
    private func normalizeRepoFilter() {
        if let filter = repoFilter, !repoPaths.contains(filter) {
            repoFilter = nil
        }
    }

    private func startCollect(
        repoPath: String, instruction: String?, agent: String?, lens: String? = nil
    ) async {
        do {
            let started = try await api.startPoCollection(
                repoPath: repoPath, instruction: instruction, agent: agent, lens: lens)
            applyCollectStart(started, repoPath: repoPath)
            error = nil
        } catch {
            self.error = (error as? LocalizedError)?.errorDescription ?? "\(error)"
        }
    }

    /// 안내 배너에 곁들일 «프로젝트명» — repoPath 의 디렉토리명 (picker·BriefRow 와 같은 표기).
    /// 배너가 떠 있을 때만 읽히고, 그 배너는 늘 이 repoPath 의 직전 수집에서 왔다.
    private var collectNoticeRepoName: String? {
        collectNoticeRepoPath.map { ($0 as NSString).lastPathComponent }
    }

    /// 수집 시작 결과 적용 — 진행 배너용 세션 id + (신호에 문제 있을 때만) 안내 배너.
    /// gh/asc 가 정상이거나 옛 daemon/불확실 점검이면 안내를 비워 둔다 (정상 케이스 잡음 금지).
    private func applyCollectStart(_ started: PoCollectStart, repoPath: String) {
        collectingSessionId = started.sessionId
        collectingRepoPath = repoPath
        // 안내 배너가 «어느 프로젝트» 인지 표시할 수 있게 직전 수집 레포를 기억한다.
        collectNoticeRepoPath = repoPath
        collectGhNotice = (started.gh?.needsNotice == true) ? started.gh : nil
        collectAscNotice = (started.asc?.needsNotice == true) ? started.asc : nil
    }

    private func applyUpdate(_ updated: PoBrief) {
        if let idx = briefs.firstIndex(where: { $0.id == updated.id }) {
            briefs[idx] = updated
        }
    }

    /// 「진행 중」 한 행 — 본문 표현식 복잡도를 낮추려 분리(컴파일러 타입 추론 부담 완화).
    /// 세션 모드는 탭으로 구현 세션을 열고, 워크플로우 모드는 상세(캔버스)로 간다. 진행 중 회복
    /// 액션은 leading 스와이프 «구현 다시 시작»(po_exec_restart_v1, 비파괴·accent), trailing 은 «삭제»(파괴).
    @ViewBuilder
    private func runningBriefRow(_ brief: PoBrief) -> some View {
        let isWorkflow = brief.execRunId != nil || brief.execWorkflowId != nil
        let isRestarting = restartingBriefId == brief.id
        Group {
            if isWorkflow {
                // 워크플로우 모드 (po_workflow_v1) — 상세의 «구현 워크플로우» 섹션이 run 진행/캔버스 진입점.
                NavigationLink(value: brief) {
                    BriefRow(brief: brief, showRepo: repoFilter == nil)
                }
            } else {
                // 진행 중 브리프 탭 = 그 구현 세션 열기 (결재는 끝났으니 상세 대신 현장).
                Button {
                    if let sid = brief.execSessionId { onOpenSession(sid) }
                } label: {
                    BriefRow(brief: brief, showRepo: repoFilter == nil)
                }
                .buttonStyle(.plain)
            }
        }
        // 재시작 진행 중 — 행을 흐리게 + 진행 표시로 비활성 신호 (중복 탭은 restart 가 막는다).
        .opacity(isRestarting ? 0.5 : 1)
        .overlay(alignment: .trailing) {
            if isRestarting {
                ProgressView().padding(.trailing, 4)
            }
        }
        .disabled(isRestarting)
        // 구현 다시 시작 (po_exec_restart_v1) — 죽은 구현 세션을 같은 브리프·결재 컨텍스트 보존한 채
        // 새 세션으로 교체(삭제→재승인과 달리 이력 유지). 파괴가 아니라 일반 회복 액션이라 기본
        // 틴트(accent)를 따른다. 워크플로우 모드·미지원 daemon 은 노출 안 함.
        .swipeActions(edge: .leading, allowsFullSwipe: false) {
            if supportsExecRestart && !isWorkflow {
                Button {
                    Task { await restart(brief) }
                } label: {
                    Label("구현 다시 시작", systemImage: "arrow.clockwise")
                }
                .tint(Theme.accent)
                .accessibilityLabel(Text("구현 다시 시작"))
            }
        }
        // 진행 중도 삭제 가능 — 구현 세션을 임의로 정지하면 running 이 영원히 남는다(shipped 전이는
        // 세션 정착 시에만). 백로그 항목만 지우고 세션은 건드리지 않는다. 실수 방지로 full swipe 막는다.
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button(role: .destructive) {
                Task { await remove(brief) }
            } label: {
                Label("삭제", systemImage: "trash")
            }
        }
    }

    /// 트리아지 일괄 결재 — po_bulk_decide_v1 이면 1콜, 아니면(옛 daemon) 단건 decide 를 순차 호출해
    /// 폴백(느리지만 동작). 처리된 브리프를 로컬 briefs 에 반영(proposed → held/rejected 이동)하고
    /// 그 목록을 시트에 돌려준다 — 시트가 처리분을 작업 집합에서 뺀다. reason 은 보류/기각 사유
    /// 태그(po_decide_reason_v1) — 선택분 전체에 같은 사유를 적용한다(미선택은 nil → daemon NULL).
    private func bulkDecide(ids: [String], action: String, reason: String?) async throws -> [PoBrief] {
        let updated: [PoBrief]
        if capabilities.contains("po_bulk_decide_v1") {
            updated = try await api.bulkDecidePoBriefs(ids: ids, action: action, reason: reason).updated
        } else {
            var acc: [PoBrief] = []
            var firstError: Error?
            for id in ids {
                do {
                    // bulkDecide 는 hold/reject «만» 한다(approve 는 단건 전용, §14.5) — 세션 spawn 이
                    // po-agent-lint: allow (action 이 변수라 휴리스틱이 approve 아님을 못 구분 → agent 불필요)
                    acc.append(try await api.decidePoBrief(id: id, action: action, reason: reason).brief)
                } catch {
                    if firstError == nil { firstError = error }
                }
            }
            // 전부 실패면(다임 연결 끊김 등) 첫 에러를 올려 시트가 배너로 보여 준다.
            if acc.isEmpty, let firstError { throw firstError }
            updated = acc
        }
        for brief in updated { applyUpdate(brief) }
        return updated
    }

    private func remove(_ brief: PoBrief) async {
        do {
            try await api.deletePoBrief(id: brief.id)
            briefs.removeAll { $0.id == brief.id }
            normalizeRepoFilter()
        } catch {
            self.error = (error as? LocalizedError)?.errorDescription ?? "\(error)"
        }
    }

    /// 진행 중 브리프의 «구현 다시 시작» (po_exec_restart_v1) — 죽은 구현 세션을 같은 브리프·결재
    /// 컨텍스트 보존한 채 새 세션으로 교체하고 그 세션을 연다(승인 직후 딥링크와 같은 흐름). 에이전트는
    /// 픽커가 노출됐으면 «마지막 선택», 아니면 nil → daemon 이 브리프에 기록된 에이전트를 재사용한다.
    /// 멱등 — 진행 중이면(restartingBriefId) 재진입을 막고, 실패는 기존 error 배너로 보고한다.
    private func restart(_ brief: PoBrief) async {
        guard restartingBriefId == nil else { return }
        restartingBriefId = brief.id
        defer { restartingBriefId = nil }
        let agent = supportsAgentChoice ? lastExecAgentId : nil
        do {
            let result = try await api.restartPoBriefExec(id: brief.id, agent: agent)
            applyUpdate(result.brief)
            error = nil
            onOpenSession(result.execSessionId)
        } catch {
            self.error = (error as? LocalizedError)?.errorDescription ?? "\(error)"
        }
    }
}

// MARK: - 행

/// 백로그 한 행 — 제목 + 영향/노력 + 근거 수 + repo. 폰에서 훑는 단위.
/// showRepo: 전체 모드에서만 레포 배지(마지막 디렉토리명) — 단일 레포 모드에선 중복 정보.
/// 실행/정리 에이전트 칩 (po_agent_echo_v1) — 브리프가 «실제로» 어떤 코드 에이전트로 돌(았)는지
/// 한눈에. daemon 응답의 exec_agent_id/cleanup_agent_id 를 표시해, iOS 가 agent 인자를 빠뜨려
/// daemon 이 조용히 claude_code 로 폴백한 «무음 실패»(3회+ 재발 이력)를 드러낸다.
private struct PoAgentChip: View {
    let agentId: String
    /// daemon 후보 목록 — displayName 우선 해석(새 어댑터까지 정확히). 비면 AgentKind 폴백.
    var agents: [AgentInfo] = []

    private var kind: AgentKind { AgentKind.from(id: agentId) }
    /// 후보 목록의 displayName 우선, 없으면 AgentKind 의 브랜드명. (둘 다 번역 대상 아님.)
    private var name: String {
        agents.first(where: { $0.id == agentId })?.displayName ?? kind.displayName
    }

    var body: some View {
        Label {
            Text(verbatim: name)
        } icon: {
            Image(systemName: kind.systemImage)
        }
        .font(.caption2.weight(.medium))
        .foregroundStyle(.secondary)
        .lineLimit(1)
    }
}

private struct BriefRow: View {
    let brief: PoBrief
    var showRepo = true

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .top, spacing: 8) {
                Text(brief.title)
                    .font(.callout.weight(.semibold))
                    .lineLimit(2)
                Spacer(minLength: 0)
                statusBadge
            }
            HStack(spacing: 8) {
                Label("영향 \(brief.impact)", systemImage: "arrow.up.right")
                Label("노력 \(brief.effort)", systemImage: "hammer")
                Label("근거 \(brief.evidence.count)", systemImage: "link")
                Spacer(minLength: 0)
                // 실행 에이전트 (po_agent_echo_v1) — 결재된 브리프엔 «실제로 돌린» 도구가 실린다.
                // 카드는 후보 목록을 안 받으므로 AgentKind 브랜드명만으로 표시.
                if let agentId = brief.execAgentId {
                    PoAgentChip(agentId: agentId)
                }
                if showRepo {
                    Text(verbatim: repoName)
                }
            }
            .font(.caption2)
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, 2)
    }

    private var repoName: String {
        (brief.repoPath as NSString).lastPathComponent
    }

    @ViewBuilder
    private var statusBadge: some View {
        if brief.revisingSessionId != nil {
            // 수정 지시 재종합 진행 중 — 결재보다 먼저 보여야 «지금 못 누르는 이유» 가 읽힌다.
            badge(text: Text("재종합 중"), color: Theme.accent)
        } else {
            decisionBadge
        }
    }

    @ViewBuilder
    private var decisionBadge: some View {
        switch brief.status {
        case "running", "approved":
            badge(text: Text("진행 중"), color: Theme.success)
        case "held":
            badge(text: Text("보류"), color: Color.secondary)
        case "rejected":
            badge(text: Text("기각"), color: Theme.danger)
        case "shipped":
            // 출시됨 — 검증 대기. 상태 신호색 info(파랑).
            badge(text: Text("출시됨"), color: Theme.info)
        case "verified":
            // 가설 적중 — 출시 후 검증 통과.
            badge(text: Text("검증됨"), color: Theme.success)
        case "missed":
            // 가설 빗나감 — 구현됐지만 신호가 해소되지 않음.
            badge(text: Text("빗나감"), color: Theme.danger)
        default:
            // 결재 대기 — score 를 그대로 노출 (영향/노력 비율, 정렬 기준임을 드러낸다).
            badge(text: Text(verbatim: String(format: "%.1f", brief.score)), color: Theme.pro)
        }
    }

    private func badge(text: Text, color: Color) -> some View {
        text
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(Capsule().fill(color.opacity(0.15)))
            .foregroundStyle(color)
    }
}

// MARK: - 성적표 (po_stats_v1)

/// 성적표 공용 포맷터 — 요약 행과 상세 시트가 같은 표기를 쓴다.
private enum PoStatsFormat {
    /// 승인율 → 로케일 % 문자열 ("62%"). NumberFormatter 가 로케일별 기호/자릿수를 처리.
    static func percent(_ rate: Double) -> String {
        let f = NumberFormatter()
        f.numberStyle = .percent
        f.maximumFractionDigits = 0
        return f.string(from: NSNumber(value: rate)) ?? "\(Int((rate * 100).rounded()))%"
    }

    /// 결재 중앙값(초) → 로케일 기간 문자열 ("12분", "2시간 5분"). 시스템 포맷터가 번역을 처리.
    static func duration(_ seconds: Double) -> String? {
        let f = DateComponentsFormatter()
        f.unitsStyle = .abbreviated
        f.maximumUnitCount = 2
        f.allowedUnits = seconds >= 60 ? [.day, .hour, .minute] : [.second]
        return f.string(from: seconds)
    }
}

/// 백로그 상단 요약 1줄 — «승인율 62% · 검증 적중 4/5». 결재 데이터 5건 미만이면 잘못된 %
/// 강조를 피하려 «아직 데이터가 부족해요» 로 대신한다 (수용 기준).
private struct PoStatsSummaryRow: View {
    let stats: PoStats

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "chart.bar.xaxis")
                .font(.body)
                .foregroundStyle(Theme.pro)
            VStack(alignment: .leading, spacing: 2) {
                Text("성적표")
                    .font(.callout.weight(.semibold))
                summary
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
            Image(systemName: "chevron.right")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.tertiary)
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
    }

    @ViewBuilder
    private var summary: some View {
        if stats.decidedCount < 5 {
            Text("아직 데이터가 부족해요")
        } else if let rate = stats.approvalRate {
            let pct = PoStatsFormat.percent(rate)
            let settled = stats.verified + stats.missed
            if settled > 0 {
                Text("승인율 \(pct) · 검증 적중 \(stats.verified)/\(settled)")
            } else {
                Text("승인율 \(pct)")
            }
        } else {
            Text("아직 데이터가 부족해요")
        }
    }
}

/// 성적표 상세 시트 — 전체 합산 + 레포별 분해. 적중(verified)=success(초록),
/// 빗나감(missed)=danger(빨강) — 기존 배지 색 약속 재사용.
private struct PoStatsSheet: View {
    @Environment(\.dismiss) private var dismiss

    let stats: PoStats
    /// 「검증 사유」 줄을 탭하면 호출 — 그 id 의 브리프가 목록에 있어 내비게이트하면 true,
    /// 없으면(삭제 등) false. false 면 시트가 «찾을 수 없음» 안내를 띄운다.
    var onOpenBrief: (String) -> Bool = { _ in false }

    /// 탭한 브리프를 목록에서 못 찾았을 때의 안내 alert 표시 여부.
    @State private var briefNotFound = false

    /// 잘못된 % 강조 방지 — 결재 5건 미만이면 률 대신 건수만 보여준다.
    private var enoughData: Bool { stats.decidedCount >= 5 }

    var body: some View {
        NavigationStack {
            List {
                if !enoughData {
                    Section {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("아직 데이터가 부족해요")
                                .font(.callout.weight(.semibold))
                            Text("결재(승인·기각)가 5건 쌓이면 승인율을 보여드려요.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        .padding(.vertical, 2)
                    }
                }
                bucketSection(stats.totalBucket, header: Text("전체"))
                // 기각이 «어디에 몰리는지» — 결재가 충분히 쌓였을 때만(enoughData 재사용) 전체(필터된)
                // 집합의 차원 분해를 보여준다. 데이터 부족·분해 없음이면 통째로 숨김 (기존 정책 일치).
                if enoughData {
                    breakdownSection(stats.totalBucket)
                }
                // 레포별 분해 — 1개 레포뿐이면 전체와 동일해 생략 (멀티 프로젝트에서만 의미).
                if stats.repos.count > 1 {
                    ForEach(stats.repos, id: \.repoPath) { repo in
                        bucketSection(
                            repo,
                            header: Text(verbatim: (repo.repoPath as NSString).lastPathComponent),
                        )
                    }
                }
                // 출시 후 빗나감 분해 — verified/missed 가 충분히 쌓였을 때만 (enoughData 재사용).
                // 구 daemon/검증 0이면 nil → 섹션 통째로 숨김 (verifyNotesSection 보다 위에 배치).
                if enoughData {
                    outcomeBreakdownSection(stats.totalBucket)
                }
                byReasonSection
                verifyNotesSection
            }
            .navigationTitle("성적표")
            .navigationBarTitleDisplayMode(.inline)
            .alert("브리프를 찾을 수 없어요", isPresented: $briefNotFound) {
                Button("확인", role: .cancel) {}
            } message: {
                Text("이 브리프는 목록에서 사라졌어요. 삭제됐을 수 있어요.")
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    // 해제 버튼은 강조색이 아니라 중립(primary) — color 정책.
                    Button("닫기") { dismiss() }
                        .tint(.primary)
                }
            }
        }
    }

    /// 기각 사유 — rejected/held 브리프의 decide_reason 집계 (po_decide_reason_v2). 사람이 «직접
    /// 말한» 사유로 집계 — «왜 기각했나» 의 가장 직접적 신호. 구 daemon nil/충분 데이터 미만/전부 0건이면
    /// 섹션 통째 숨김. 많은 순 정렬, 0건 키는 생략. none(decide_reason NULL)은 «사유 미기재» 라벨.
    @ViewBuilder
    private var byReasonSection: some View {
        if enoughData, let byReason = stats.byReason {
            let entries = reasonEntries(byReason)
            if !entries.isEmpty {
                Section {
                    ForEach(entries, id: \.key) { e in
                        LabeledContent {
                            // 기각 사유 건수 — danger(빨강) 강조. 기각률 분해와 같은 색 약속.
                            Text(verbatim: "\(e.count)")
                                .foregroundStyle(Theme.danger)
                                .fontWeight(.semibold)
                        } label: {
                            e.label
                        }
                        .accessibilityElement(children: .combine)
                        .accessibilityLabel(e.label)
                        .accessibilityValue(Text("\(e.count)건"))
                    }
                } header: {
                    Text("기각 사유")
                } footer: {
                    Text("어떤 사유로 제안을 거절했는지 보여줘요.")
                }
            }
        }
    }

    /// byReason 딕셔너리를 건수 많은 순으로 정렬 — 0건 제외, none 은 «사유 미기재» 라벨.
    private struct ReasonEntry {
        let key: String
        let label: Text
        let count: Int
    }

    private func reasonEntries(_ byReason: [String: Int]) -> [ReasonEntry] {
        // 5개 enum 키 + none. 0건은 제외.
        return byReason.compactMap { key, count -> ReasonEntry? in
            guard count > 0 else { return nil }
            let label: Text
            if key == "none" {
                label = Text("사유 미기재")
            } else if let reason = DecideReason(rawValue: key) {
                label = reason.label
            } else {
                // 허용 키 밖 (이상값) — none 으로 집계됐을 텐데 혹시 모를 폴백.
                label = Text(verbatim: key)
            }
            return ReasonEntry(key: key, label: label, count: count)
        }
        .sorted { $0.count > $1.count }
    }

    /// 검증 사유 — 출시 후 verified/missed 판정의 verify_note 를 모아 «왜 빗나갔나» 패턴을
    /// 한눈에 보여준다 (po_verify_notes_v1). 사유 없으면(구 daemon nil / 빈 배열) 섹션 통째 숨김.
    /// verified=success(초록) · missed=danger(빨강) — 성적표 배지와 같은 색 약속 재사용.
    @ViewBuilder
    private var verifyNotesSection: some View {
        if let notes = stats.verifyNotes, !notes.isEmpty {
            Section {
                ForEach(notes) { n in
                    let isMissed = n.status == "missed"
                    // 줄 전체를 탭하면 그 id 의 브리프 상세로 — onOpenBrief 가 false(목록에 없음)
                    // 면 «찾을 수 없음» 안내. 인터랙션만 추가하고 verified/missed 아이콘 색은 보존.
                    Button {
                        if !onOpenBrief(n.id) {
                            briefNotFound = true
                        }
                    } label: {
                        HStack(spacing: 8) {
                            Label {
                                // 모델 산출 본문 — 번역 대상이 아니라 그대로(.primary, 자동 적응).
                                Text(verbatim: n.note)
                                    .font(.callout)
                                    .foregroundStyle(.primary)
                            } icon: {
                                Image(systemName: isMissed ? "xmark.circle.fill" : "checkmark.circle.fill")
                                    .foregroundStyle(isMissed ? Theme.danger : Theme.success)
                                    .accessibilityLabel(isMissed ? Text("빗나감") : Text("검증됨"))
                            }
                            Spacer(minLength: 0)
                            // 탭 가능 affordance — 중립(.tertiary) chevron, 강조색을 빌리지 않는다.
                            Image(systemName: "chevron.right")
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(.tertiary)
                        }
                    }
                    .buttonStyle(.plain)
                    .padding(.vertical, 2)
                    .accessibilityHint(Text("브리프 열기"))
                }
            } header: {
                Text("검증 사유")
            } footer: {
                Text("출시한 기능이 적중·빗나간 판정 사유예요.")
            }
        }
    }

    @ViewBuilder
    private func bucketSection(_ s: PoRepoStats, header: Text) -> some View {
        Section {
            countRow(Text("제안"), s.proposed)
            countRow(Text("승인"), s.approved)
            countRow(Text("기각"), s.rejected)
            countRow(Text("출시"), s.shipped)
            // 출시 후 검증 — 기존 배지 색 약속 (verified=초록 / missed=빨강).
            countRow(Text("검증됨"), s.verified, color: s.verified > 0 ? Theme.success : nil)
            countRow(Text("빗나감"), s.missed, color: s.missed > 0 ? Theme.danger : nil)
            if enoughData, let rate = s.approvalRate {
                LabeledContent {
                    Text(verbatim: PoStatsFormat.percent(rate))
                        .foregroundStyle(.primary)
                } label: {
                    Text("승인율")
                }
            }
            if enoughData, let median = s.medianDecisionSeconds,
               let text = PoStatsFormat.duration(median) {
                LabeledContent {
                    Text(verbatim: text)
                        .foregroundStyle(.primary)
                } label: {
                    Text("결재 중앙값")
                }
            }
        } header: {
            header
        } footer: {
            // 기각만 잔뜩인 초기 — 0% 라도 비난조가 아닌 중립 안내 (엣지케이스).
            if s.approvalRate == 0 && s.rejected > 0 {
                Text("수정 지시로 방향을 알려주면 다음 제안이 좋아져요.")
            }
        }
    }

    private func countRow(_ label: Text, _ count: Int, color: Color? = nil) -> some View {
        LabeledContent {
            Text(verbatim: "\(count)")
                .foregroundStyle(color ?? Color.secondary)
                .fontWeight(color != nil ? .semibold : .regular)
        } label: {
            label
        }
    }

    // MARK: 기각이 몰리는 곳 (po_stats_breakdown_v1)

    /// 노이즈 차단 — 한 차원 칸의 결재가 이 수 미만이면 률을 안 보여준다(1/1=100% 같은 허상 방지).
    private static let minBucketDecided = 3
    /// 출시 후 검증 분해의 최소 검증 건수 게이트 — 결재와 같은 기준 (3건 미만은 노이즈).
    private static let minOutcomeCompleted = 3

    /// 분해 한 줄 — 차원 값 라벨 + 그 칸의 기각 셀. 노력/렌즈 차원이 같은 행 모양을 공유한다.
    private struct BreakdownEntry: Identifiable {
        let id: String
        let label: LocalizedStringKey
        let systemImage: String
        let cell: PoStatsCell
    }

    /// 출시 후 검증 분해 한 줄 — 차원 값 라벨 + 그 칸의 verified/missed 셀.
    private struct OutcomeBreakdownEntry: Identifiable {
        let id: String
        let label: LocalizedStringKey
        let systemImage: String
        let cell: PoOutcomeCell
    }

    /// 노력(effort) 구간별 — 충분히 쌓인 칸만, 기각이 잦은 순으로 위(고effort 편중을 먼저 드러냄).
    private func effortEntries(_ s: PoRepoStats) -> [BreakdownEntry] {
        guard let m = s.byEffort else { return [] }
        let order: [(String, LocalizedStringKey)] = [
            ("high", "노력 높음"), ("mid", "노력 보통"), ("low", "노력 낮음"),
        ]
        return order.compactMap { key, label in
            guard let cell = m[key], cell.decided >= Self.minBucketDecided else { return nil }
            return BreakdownEntry(id: "effort-\(key)", label: label, systemImage: "hammer", cell: cell)
        }
    }

    /// 리서치 «전문가 관점»(lens)별 — 충분히 쌓인 칸만, 기각률 높은 순. 표시명은 리서치와 같은 카탈로그 키.
    private func lensEntries(_ s: PoRepoStats) -> [BreakdownEntry] {
        guard let m = s.byLens else { return [] }
        return m.compactMap { key, cell -> BreakdownEntry? in
            guard cell.decided >= Self.minBucketDecided else { return nil }
            return BreakdownEntry(
                id: "lens-\(key)", label: poResearchLensName(key), systemImage: "eyeglasses",
                cell: cell)
        }
        .sorted { ($0.cell.rejectionRate ?? 0, $0.id) > ($1.cell.rejectionRate ?? 0, $1.id) }
    }

    /// 근거(evidence) 종류별 — 충분히 쌓인 칸만, 기각률 높은 순. 표시명은 근거 종류 키 매핑.
    /// 구 daemon 응답엔 byEvidence 가 nil → 빈 배열(행 자체가 안 뜸, 회귀 없음).
    private func evidenceEntries(_ s: PoRepoStats) -> [BreakdownEntry] {
        guard let m = s.byEvidence else { return [] }
        return m.compactMap { key, cell -> BreakdownEntry? in
            guard cell.decided >= Self.minBucketDecided else { return nil }
            return BreakdownEntry(
                id: "evidence-\(key)", label: poEvidenceKindName(key), systemImage: "link",
                cell: cell)
        }
        .sorted { ($0.cell.rejectionRate ?? 0, $0.id) > ($1.cell.rejectionRate ?? 0, $1.id) }
    }

    @ViewBuilder
    private func breakdownSection(_ s: PoRepoStats) -> some View {
        let entries = effortEntries(s) + lensEntries(s) + evidenceEntries(s)
        if !entries.isEmpty {
            Section {
                ForEach(entries) { breakdownRow($0) }
            } header: {
                Text("기각이 몰리는 곳")
            } footer: {
                // 비난조 아닌 중립 — 기존 footer 톤 일치 (방향 안내).
                Text("어떤 제안이 자주 거절되는지 보여줘요 — 다음 수집의 방향에 참고하세요.")
            }
        }
    }

    private func breakdownRow(_ e: BreakdownEntry) -> some View {
        LabeledContent {
            HStack(spacing: 6) {
                Text(verbatim: "\(e.cell.rejected)/\(e.cell.decided)")
                    .foregroundStyle(.secondary)
                if let rate = e.cell.rejectionRate {
                    // 기각 강조 = danger(빨강). status 색을 «장식» 으로 빌리는 게 아니라 의미 그대로.
                    Text(verbatim: PoStatsFormat.percent(rate))
                        .foregroundStyle(Theme.danger)
                        .fontWeight(.semibold)
                }
            }
        } label: {
            Label { Text(e.label) } icon: { Image(systemName: e.systemImage) }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Text(e.label))
        .accessibilityValue(
            Text("기각률 \(e.cell.rejectionRate.map { PoStatsFormat.percent($0) } ?? "—")"))
    }

    // MARK: 출시 후 빗나감 분해 (po_outcome_breakdown_v1)

    /// 노력(effort) 구간별 출시 후 검증 — 충분히 쌓인 칸만, 빗나감이 잦은 순.
    private func outcomeEffortEntries(_ s: PoRepoStats) -> [OutcomeBreakdownEntry] {
        guard let m = s.outcomeByEffort else { return [] }
        let order: [(String, LocalizedStringKey)] = [
            ("high", "노력 높음"), ("mid", "노력 보통"), ("low", "노력 낮음"),
        ]
        return order.compactMap { key, label in
            guard let cell = m[key], cell.completed >= Self.minOutcomeCompleted else { return nil }
            return OutcomeBreakdownEntry(
                id: "outcome-effort-\(key)", label: label, systemImage: "hammer", cell: cell)
        }
        .sorted { ($0.cell.missedRate ?? 0, $0.id) > ($1.cell.missedRate ?? 0, $1.id) }
    }

    /// 리서치 «전문가 관점»(lens)별 출시 후 검증 — 충분히 쌓인 칸만, 빗나감률 높은 순.
    private func outcomeLensEntries(_ s: PoRepoStats) -> [OutcomeBreakdownEntry] {
        guard let m = s.outcomeByLens else { return [] }
        return m.compactMap { key, cell -> OutcomeBreakdownEntry? in
            guard cell.completed >= Self.minOutcomeCompleted else { return nil }
            return OutcomeBreakdownEntry(
                id: "outcome-lens-\(key)", label: poResearchLensName(key),
                systemImage: "eyeglasses", cell: cell)
        }
        .sorted { ($0.cell.missedRate ?? 0, $0.id) > ($1.cell.missedRate ?? 0, $1.id) }
    }

    /// 근거(evidence) 종류별 출시 후 검증 — 충분히 쌓인 칸만, 빗나감률 높은 순. byEvidence 와 같은
    /// kind 원천. 구 daemon/검증 0이면 outcomeByEvidence 가 nil → 빈 배열(행 안 뜸, 회귀 없음).
    private func outcomeEvidenceEntries(_ s: PoRepoStats) -> [OutcomeBreakdownEntry] {
        guard let m = s.outcomeByEvidence else { return [] }
        return m.compactMap { key, cell -> OutcomeBreakdownEntry? in
            guard cell.completed >= Self.minOutcomeCompleted else { return nil }
            return OutcomeBreakdownEntry(
                id: "outcome-evidence-\(key)", label: poEvidenceKindName(key),
                systemImage: "link", cell: cell)
        }
        .sorted { ($0.cell.missedRate ?? 0, $0.id) > ($1.cell.missedRate ?? 0, $1.id) }
    }

    @ViewBuilder
    private func outcomeBreakdownSection(_ s: PoRepoStats) -> some View {
        let entries = outcomeEffortEntries(s) + outcomeLensEntries(s) + outcomeEvidenceEntries(s)
        if !entries.isEmpty {
            Section {
                ForEach(entries) { outcomeBreakdownRow($0) }
            } header: {
                Text("출시 후 빗나감")
            } footer: {
                // 비난조 아닌 중립 — «어떤 베팅이 더 자주 빗나가는지» 를 보여주는 데이터 (방향 안내).
                Text("어떤 노력·관점·근거의 출시 기능이 더 자주 빗나가는지 보여줘요.")
            }
        }
    }

    private func outcomeBreakdownRow(_ e: OutcomeBreakdownEntry) -> some View {
        LabeledContent {
            HStack(spacing: 6) {
                Text(verbatim: "\(e.cell.missed)/\(e.cell.completed)")
                    .foregroundStyle(.secondary)
                if let rate = e.cell.missedRate {
                    // 빗나감 강조 = danger(빨강) — verifyNotesSection 의 missed 색과 같은 약속.
                    Text(verbatim: PoStatsFormat.percent(rate))
                        .foregroundStyle(Theme.danger)
                        .fontWeight(.semibold)
                }
            }
        } label: {
            Label { Text(e.label) } icon: { Image(systemName: e.systemImage) }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Text(e.label))
        .accessibilityValue(
            Text("빗나감률 \(e.cell.missedRate.map { PoStatsFormat.percent($0) } ?? "—")"))
    }
}

// MARK: - 리서치

/// 수집 «전문가 관점» 렌즈가 노출하는 집합 (po_collect_lens_v1) — 리서치 v1 과 같은 전방위·디자인·
/// 디버깅 3개. 수집은 qa/security 를 노출하지 않는다(별도 브리프) — design 은 디자인 부채 발굴(옛
/// designer 페르소나와 동치), bug 는 디버깅·신뢰성 신호 우선. 표시명은 poResearchLensName 을 그대로
/// 재사용해 리서치와 «같은 명칭·같은 카탈로그 키»(전방위/디자인/디버깅)로 통일한다 (중복 정의 금지).
private let poCollectLenses = ["default", "design", "bug"]

/// 리서치 «전문가 관점» 렌즈가 노출하는 집합 — id 순서 고정. default(전방위)가 기본/baseline.
/// v1(렌즈 픽커 존재)에선 전방위·디자인·디버깅 3개, v2면 «QA», v3면 «보안», v4면 «기획», v5면
/// «마케팅», v6면 «분석», v7면 «운영», v8면 «로직», v9면 «UX»(사용성) 까지 한 단계씩 늘어난다.
/// capability 마다 한 단계씩 게이팅하는 이유: 그 렌즈를 모르는 옛 daemon 에 해당 lens 를 보내면
/// parseLens 가 조용히 전방위로 폴백 → «거짓 UI» 가 된다 (수집 designer·scope 게이팅과 동형). daemon
/// 의 lens.ts PO_LENSES 와 동형. UX 는 design(시각)과 «다른» 렌즈 — design 이 토큰·색·간격이라면 UX
/// 는 플로우 마찰·이해·완수(Nielsen 휴리스틱)다.
private func poResearchLenses(
    qa: Bool, security: Bool, pm: Bool, marketing: Bool, analytics: Bool, ops: Bool, logic: Bool,
    ux: Bool
) -> [String] {
    var lenses = ["default", "design", "bug"]
    if qa { lenses.append("qa") }
    if security { lenses.append("security") }
    if pm { lenses.append("pm") }
    if marketing { lenses.append("marketing") }
    if analytics { lenses.append("analytics") }
    if ops { lenses.append("ops") }
    if logic { lenses.append("logic") }
    if ux { lenses.append("ux") }
    return lenses
}

/// 렌즈 id → 표시 이름 (LocalizedStringKey 라 10개 로케일 자동 번역). 픽커·보고서 칩이 공유한다.
/// "디자인" 은 수집의 «전문가 관점» 픽커와 같은 의미·같은 카탈로그 키를 쓴다 (중복 정의 금지). "bug" id 는
/// 옛 row 호환을 위해 유지하되 표시는 «디버깅» (daemon lens.ts 와 같은 약속).
private func poResearchLensName(_ lens: String) -> LocalizedStringKey {
    switch lens {
    case "design": return "디자인"
    case "bug": return "디버깅"
    case "qa": return "QA"
    case "security": return "보안"
    case "pm": return "기획"
    case "marketing": return "마케팅"
    case "analytics": return "분석"
    case "ops": return "운영"
    case "logic": return "로직"
    case "ux": return "UX"
    default: return "전방위"
    }
}

/// 근거(evidence) 종류 키 → 사용자 친화 표시명. daemon byEvidence 의 kind(github_issue·repo_todo·
/// code_comment·git_log·doc·asc_review 등)를 성적표 분해 행 라벨로 매핑한다. 매핑 밖 키(미래 daemon·
/// 깨진 행)는 원문 그대로 — 비번역 식별자 정책. GitHub·Git·TODO 같은 식별자는 모든 로케일에서 동일 원문.
private func poEvidenceKindName(_ kind: String) -> LocalizedStringKey {
    switch kind {
    case "github_issue": return "GitHub 이슈"
    case "repo_todo": return "코드 TODO"
    case "code_comment": return "코드 주석"
    case "git_log": return "Git 기록"
    case "doc": return "문서"
    case "asc_review": return "스토어 리뷰"
    case "crash": return "크래시"
    case "feedback": return "사용자 피드백"
    case "bug": return "버그 리포트"
    case "code": return "코드"
    case "design_token_drift": return "디자인 토큰 이탈"
    case "design_color_misuse": return "색 오용"
    case "design_a11y": return "디자인 접근성"
    case "design_contrast": return "디자인 대비"
    case "design_pattern": return "디자인 패턴"
    case "design_i18n": return "디자인 다국어"
    default: return LocalizedStringKey(kind)
    }
}

/// 보고서 머리/리서치 행에 «어느 관점으로 조사했는지» 를 드러내는 칩 — 색 정책상 status/pro 색을
/// 빌리지 않고 중립(.secondary)으로 둔다. 전방위(default)/nil(옛 daemon)이면 호출부가 안 그린다.
private struct ResearchLensChip: View {
    let lens: String

    var body: some View {
        Label { Text(poResearchLensName(lens)) } icon: { Image(systemName: "eyeglasses") }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text("전문가 관점"))
            .accessibilityValue(Text(poResearchLensName(lens)))
    }
}

/// 리서치 한 행 — 주제 + 상태(조사 중/완료/실패) + 만든 브리프 수.
/// showRepo: 브리프 행과 같은 규칙 — 전체 모드에서만 레포 배지.
private struct ResearchRow: View {
    let research: PoResearch
    var showRepo = true

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .top, spacing: 8) {
                Text(verbatim: research.topic)
                    .font(.callout.weight(.medium))
                    .lineLimit(2)
                Spacer(minLength: 0)
                statusView
            }
            HStack(spacing: 8) {
                Label("브리프 \(research.briefCount)", systemImage: "list.clipboard")
                // 전방위(기본)/옛 daemon(nil)은 칩 숨김 — 비-baseline 렌즈만 «어느 관점» 을 드러낸다.
                if let lens = research.lens, lens != "default" {
                    ResearchLensChip(lens: lens)
                }
                Spacer(minLength: 0)
                if showRepo {
                    Text(verbatim: (research.repoPath as NSString).lastPathComponent)
                }
            }
            .font(.caption2)
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, 2)
    }

    @ViewBuilder
    private var statusView: some View {
        switch research.status {
        case "running":
            HStack(spacing: 5) {
                ProgressView().controlSize(.mini)
                Text("조사 중").font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
            }
        case "failed":
            Text("실패")
                .font(.caption2.weight(.semibold))
                .padding(.horizontal, 7).padding(.vertical, 2)
                .background(Capsule().fill(Theme.danger.opacity(0.15)))
                .foregroundStyle(Theme.danger)
        default:
            Image(systemName: "doc.text")
                .font(.caption)
                .foregroundStyle(Theme.pro)
        }
    }
}

/// 리서치 보고서 — 조사 주제 + markdown 본문. id 만으로 fetch 하므로 백로그 리서치 섹션과
/// 브리프 상세(researchId 역추적) 양쪽에서 재사용된다.
private struct ResearchReportView: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var conn: ConnectionManager
    @EnvironmentObject var inflight: InFlightTracker

    let researchId: String

    @State private var research: PoResearch?
    @State private var error: String?

    private var api: ApiClient { ApiClient(auth: auth, conn: conn, tracker: inflight) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                if let research {
                    Text(verbatim: research.topic)
                        .font(.headline)
                    // 어느 «전문가 관점» 으로 조사했는지를 보고서 머리에 드러낸다 (전방위/옛 daemon 은 숨김).
                    if let lens = research.lens, lens != "default" {
                        ResearchLensChip(lens: lens)
                            .font(.caption.weight(.medium))
                            .foregroundStyle(.secondary)
                    }
                    // 보고서는 에이전트 산출 markdown — 사용자 데이터라 번역 대상 아님.
                    Text(verbatim: research.report ?? "")
                        .font(.callout)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                } else if let error {
                    Text(LocalizedStringKey(error))
                        .font(.caption)
                        .foregroundStyle(Theme.danger)
                } else {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text("불러오는 중…").font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            .padding()
        }
        .navigationTitle("리서치 보고서")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            do {
                research = try await api.getPoResearch(id: researchId)
            } catch {
                self.error = (error as? LocalizedError)?.errorDescription ?? "\(error)"
            }
        }
    }
}

/// «리서치 요청» — 레포 선택 → 조사 주제 입력. 에이전트가 웹+레포를 조사해 보고서와
/// 브리프를 만든다 (수 분 소요 — 진행은 리서치 섹션/세션에서).
private struct ResearchRequestSheet: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var conn: ConnectionManager
    @EnvironmentObject var inflight: InFlightTracker
    @Environment(\.dismiss) private var dismiss

    /// 에이전트 후보 (po_agent_v1) — 비어 있으면 픽커를 숨기고 daemon 기본으로 돈다.
    let agents: [AgentInfo]
    /// daemon 이 «전문가 관점» 렌즈(po_research_lens_v1)를 지원하는가 — 주제 화면의 픽커 노출 분기.
    let supportsLens: Bool
    /// daemon 이 «QA» 렌즈(po_research_lens_v2)까지 지원하는가 — qa 옵션 노출 분기.
    let supportsQaLens: Bool
    /// daemon 이 «보안» 렌즈(po_research_lens_v3)까지 지원하는가 — security 옵션 노출 분기.
    let supportsSecurityLens: Bool
    /// daemon 이 «기획» 렌즈(po_research_lens_v4)까지 지원하는가 — pm 옵션 노출 분기.
    let supportsPmLens: Bool
    /// daemon 이 «마케팅» 렌즈(po_research_lens_v5)까지 지원하는가 — marketing 옵션 노출 분기.
    let supportsMarketingLens: Bool
    /// daemon 이 «분석» 렌즈(po_research_lens_v6)까지 지원하는가 — analytics 옵션 노출 분기.
    let supportsAnalyticsLens: Bool
    /// daemon 이 «운영» 렌즈(po_research_lens_v7)까지 지원하는가 — ops 옵션 노출 분기.
    let supportsOpsLens: Bool
    /// daemon 이 «로직» 렌즈(po_research_lens_v8)까지 지원하는가 — logic 옵션 노출 분기.
    let supportsLogicLens: Bool
    /// daemon 이 «UX»(사용성) 렌즈(po_research_lens_v9)까지 지원하는가 — ux 옵션 노출 분기.
    let supportsUxLens: Bool
    /// daemon 이 조사 범위 선택(po_research_scope_v1)을 지원하는가 — 범위 피커 노출 분기.
    let supportsScope: Bool
    /// daemon 이 UX 렌즈 «화면 포함»(po_research_ux_screens_v1)을 지원하는가 — ux 렌즈 선택 시 토글 노출 분기.
    let supportsUxScreens: Bool
    /// (repoPath, topic, agent?, lens?, scope?, screens?) — agent/lens/scope/screens 는 미노출/기본 시 nil.
    let onStart: (String, String, String?, String?, String?, Bool?) -> Void

    @State private var recents: [RecentProject] = []
    @State private var customPath = ""

    private var api: ApiClient { ApiClient(auth: auth, conn: conn, tracker: inflight) }

    var body: some View {
        NavigationStack {
            List {
                if !recents.isEmpty {
                    Section("최근 프로젝트") {
                        ForEach(recents) { project in
                            NavigationLink(value: project.path) {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(verbatim: (project.path as NSString).lastPathComponent)
                                        .font(.callout.weight(.medium))
                                    Text(verbatim: project.path)
                                        .font(.caption2)
                                        .foregroundStyle(.secondary)
                                        .lineLimit(1)
                                }
                            }
                        }
                    }
                }
                Section("직접 입력") {
                    TextField("/path/to/repo", text: $customPath)
                        .font(.callout.monospaced())
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                    NavigationLink(value: customPath.trimmingCharacters(in: .whitespacesAndNewlines)) {
                        Text("다음")
                    }
                    .disabled(customPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .navigationTitle("리서치 요청")
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(for: String.self) { repoPath in
                ResearchTopicForm(
                    repoPath: repoPath, agents: agents,
                    supportsLens: supportsLens, supportsQaLens: supportsQaLens,
                    supportsSecurityLens: supportsSecurityLens,
                    supportsPmLens: supportsPmLens,
                    supportsMarketingLens: supportsMarketingLens,
                    supportsAnalyticsLens: supportsAnalyticsLens,
                    supportsOpsLens: supportsOpsLens,
                    supportsLogicLens: supportsLogicLens,
                    supportsUxLens: supportsUxLens,
                    supportsScope: supportsScope,
                    supportsUxScreens: supportsUxScreens, onStart: onStart)
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    // 해제 버튼은 강조색이 아니라 중립(primary) — color 정책.
                    Button("닫기") { dismiss() }
                        .tint(.primary)
                }
            }
            .task {
                recents = (try? await api.recentProjects(label: nil)) ?? []
            }
        }
    }
}

/// 리서치 주제 입력 — 무엇을 조사할지 + 어느 «전문가 관점» 에 맡길지 사용자가 결정하는 자리.
private struct ResearchTopicForm: View {
    let repoPath: String
    let agents: [AgentInfo]
    /// daemon 이 «전문가 관점» 렌즈(po_research_lens_v1)를 지원하는가 — 미지원이면 픽커를 숨기고
    /// 전방위로 동작한다 (수집 «전문가 관점»(designer) 게이팅 패턴 재사용).
    let supportsLens: Bool
    /// daemon 이 «QA» 렌즈(po_research_lens_v2)까지 지원하는가 — 미지원이면 qa 옵션을 빼서 v1
    /// 옛 daemon 에 qa 를 보냈다 전방위로 폴백되는 «거짓 UI» 를 막는다.
    let supportsQaLens: Bool
    /// daemon 이 «보안» 렌즈(po_research_lens_v3)까지 지원하는가 — 미지원이면 security 옵션을 빼서
    /// security 를 모르는 옛 daemon 에 보냈다 전방위로 폴백되는 «거짓 UI» 를 막는다.
    let supportsSecurityLens: Bool
    /// daemon 이 «기획» 렌즈(po_research_lens_v4)까지 지원하는가 — 미지원이면 pm 옵션을 빼서 거짓 UI 방지.
    let supportsPmLens: Bool
    /// daemon 이 «마케팅» 렌즈(po_research_lens_v5)까지 지원하는가 — 미지원이면 marketing 옵션을 빼서 거짓 UI 방지.
    let supportsMarketingLens: Bool
    /// daemon 이 «분석» 렌즈(po_research_lens_v6)까지 지원하는가 — 미지원이면 analytics 옵션을 빼서 거짓 UI 방지.
    let supportsAnalyticsLens: Bool
    /// daemon 이 «운영» 렌즈(po_research_lens_v7)까지 지원하는가 — 미지원이면 ops 옵션을 빼서 거짓 UI 방지.
    let supportsOpsLens: Bool
    /// daemon 이 «로직» 렌즈(po_research_lens_v8)까지 지원하는가 — 미지원이면 logic 옵션을 빼서 거짓 UI 방지.
    let supportsLogicLens: Bool
    /// daemon 이 «UX»(사용성) 렌즈(po_research_lens_v9)까지 지원하는가 — 미지원이면 ux 옵션을 빼서 거짓 UI 방지.
    let supportsUxLens: Bool
    /// daemon 이 조사 범위 선택(po_research_scope_v1)을 지원하는가 — 범위 피커 노출 분기.
    let supportsScope: Bool
    /// daemon 이 UX 렌즈 «화면 포함»(po_research_ux_screens_v1)을 지원하는가 — ux 렌즈 선택 시에만 토글 노출.
    let supportsUxScreens: Bool
    /// (repoPath, topic, agent?, lens?, scope?, screens?) — agent/lens/scope/screens 는 미노출/기본 시 nil.
    let onStart: (String, String, String?, String?, String?, Bool?) -> Void

    @State private var topic = ""
    @State private var agentId = AgentInfo.claudeCodeFallback.id
    /// 전문가 관점 — "default"/"design"/"bug"/"qa"/"security"/"pm"/"marketing"/"analytics"/"ops"/"logic"/"ux". 이번 리서치에만 적용 (에이전트 픽커와 동형).
    @State private var lens = "default"
    /// 조사 범위 (po_research_scope_v1) — "web_repo" 웹+레포(기본) / "repo_only" 레포만(빠름·가벼움).
    /// 색을 새로 칠하지 않는 기본 컨트롤 — AccentColor(보라)가 자동으로 잡는다.
    @State private var scope = "web_repo"
    /// UX 렌즈 «화면 포함» (po_research_ux_screens_v1) — 켜면 렌더된 화면을 캡처해 그 화면으로
    /// 휴리스틱을 판정한다(화면 못 얻으면 코드+웹으로 graceful fallback). ux 렌즈일 때만 노출되며,
    /// 화면이 평가 품질을 올리므로 기본 ON. 색을 새로 칠하지 않는 기본 컨트롤 — AccentColor(보라)가 자동으로 잡는다.
    @State private var includeScreens = true

    /// 이번 화면에 노출할 렌즈 집합 — daemon 의 렌즈 지원 단계에 따라 3~11개. (id 순서 고정.)
    private var lenses: [String] {
        poResearchLenses(
            qa: supportsQaLens, security: supportsSecurityLens,
            pm: supportsPmLens, marketing: supportsMarketingLens,
            analytics: supportsAnalyticsLens, ops: supportsOpsLens,
            logic: supportsLogicLens, ux: supportsUxLens)
    }
    /// 렌즈 픽커는 daemon 지원 + 렌즈 2개 이상일 때만 노출 (1개뿐이면 숨김 — 거짓 UI 방지).
    private var showLensPicker: Bool { supportsLens && lenses.count > 1 }

    var body: some View {
        List {
            Section {
                VoiceInputField(
                    "예: 화이트보드 협업 기능을 넣을까? 경쟁 제품과 수요를 조사해줘",
                    text: $topic,
                    lineLimit: 3...8,
                )
            } header: {
                Text("조사 주제")
            } footer: {
                Text("에이전트가 웹과 레포를 조사해 보고서와 백로그 제안을 만들어요. 수 분 걸려요 — 진행은 리서치 섹션에서 볼 수 있어요.")
            }
            if showLensPicker {
                Section {
                    // 기본 컨트롤 — 색 안 정함 → AccentColor(보라) 자동. 콘텐츠에 .tint() 안 건다.
                    Picker(selection: $lens) {
                        ForEach(lenses, id: \.self) { id in
                            Text(poResearchLensName(id)).tag(id)
                        }
                    } label: {
                        Text("전문가 관점")
                    }
                    .pickerStyle(.inline)
                    .labelsHidden()
                    .accessibilityLabel(Text("전문가 관점"))
                } header: {
                    Text("전문가 관점")
                } footer: {
                    Text("조사를 맡길 전문가 관점을 골라요. 그 렌즈에 맞는 근거(디자인=토큰·접근성·대비, 디버깅=재현·로그·회귀, QA=테스트·수용 기준·커버리지, 보안=인증·키 취급·노출면·위협모델, 기획=요구·우선순위·로드맵·트레이드오프, 마케팅=메시징·포지셔닝·채널, 분석=지표·퍼널·인사이트, 운영=배포·신뢰성·비용, 로직=정합성·불변식·중복·단순화, UX=사용성·플로우 마찰·휴리스틱)를 우선 모아 보고서와 브리프를 만들어요. 이번 리서치에만 적용돼요.")
                }
            }
            // 조사 범위 — 옛 daemon(capability 미지원)에선 숨기고 기존 동작(웹+레포) 유지.
            if supportsScope {
                Section {
                    // 기본 컨트롤 — 색 안 정함 → AccentColor(보라) 자동. 콘텐츠에 .tint() 안 건다.
                    Picker(selection: $scope) {
                        Text("웹+레포").tag("web_repo")
                        Text("레포만").tag("repo_only")
                    } label: {
                        Text("조사 범위")
                    }
                    .pickerStyle(.inline)
                    .labelsHidden()
                    .accessibilityLabel(Text("조사 범위"))
                } header: {
                    Text("조사 범위")
                } footer: {
                    Text("«레포만» 은 웹 검색 없이 이 레포만 빠르게 조사해요 — 싸고 빠르지만 시장·경쟁 근거는 빠져요. 보고서·브리프는 레포 근거로만 작성돼요.")
                }
            }
            // UX 렌즈 «화면 포함» — ux 렌즈 + daemon 지원(po_research_ux_screens_v1)일 때만 노출.
            // 켜면 렌더된 화면을 캡처해 그 화면으로 휴리스틱을 판정한다(화면 못 얻으면 코드+웹 graceful
            // fallback). 토글은 색을 새로 칠하지 않는 «기본 컨트롤» — AccentColor(보라)가 자동으로 잡는다
            // (.tint() 안 건다, status 색 차용 안 한다). 라벨/설명은 카탈로그로 10개 로케일 번역된다.
            if supportsUxScreens && lens == "ux" {
                Section {
                    Toggle(isOn: $includeScreens) {
                        Text("화면 포함")
                    }
                    .accessibilityLabel(Text("화면 포함"))
                } footer: {
                    Text("켜면 시뮬레이터·실기기 화면을 캡처해 그 화면으로 사용성(휴리스틱)을 판정해요 — 코드·텍스트만 볼 때보다 더 많은 문제를 잡아요. 화면을 못 얻으면(UI 없음·캡처 불가) 코드·웹으로 평가하고 그 한계를 보고서에 적어요.")
                }
            }
            if !agents.isEmpty {
                PoAgentSection(agents: agents, selection: $agentId)
            }
            Section {
                Button {
                    let t = topic.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !t.isEmpty else { return }
                    // 전방위(default)/미지원이면 lens=nil 로 보내 옛 동작 유지 (designer 게이팅과 동형).
                    let chosenLens = (showLensPicker && lens != "default") ? lens : nil
                    // scope 는 daemon 이 지원하고 «레포만» 을 골랐을 때만 보낸다 — 기본/미지원은 nil
                    // (필드 생략 → daemon 기본 웹+레포, 옛 daemon 호환).
                    let chosenScope = (supportsScope && scope == "repo_only") ? "repo_only" : nil
                    // screens 는 daemon 지원 + ux 렌즈 + 토글 ON 일 때만 true — 그 외/미지원은 nil
                    // (필드 생략 → daemon 기본 코드+웹, 옛 daemon 호환).
                    let chosenScreens: Bool? =
                        (supportsUxScreens && lens == "ux" && includeScreens) ? true : nil
                    onStart(
                        repoPath, t, agents.isEmpty ? nil : agentId, chosenLens, chosenScope,
                        chosenScreens)
                } label: {
                    Text("리서치 시작").frame(maxWidth: .infinity)
                }
                .disabled(topic.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .navigationTitle(Text(verbatim: (repoPath as NSString).lastPathComponent))
        .navigationBarTitleDisplayMode(.inline)
        .voiceDictationChrome()
    }
}

// MARK: - 에이전트 픽커

/// PO 흐름(수집/리서치/승인) 공용 에이전트 픽커 — 예약 작업(CronEditorSheet)의 agentSection 과
/// 같은 모양. agents 가 비어 있으면(po_agent_v1 미지원 daemon / 후보 1개) 호출부가 아예 안 그린다.
private struct PoAgentSection<Footer: View>: View {
    let agents: [AgentInfo]
    @Binding var selection: String
    @ViewBuilder let footer: () -> Footer

    var body: some View {
        Section {
            Picker(selection: $selection) {
                ForEach(agents) { a in
                    HStack(spacing: 8) {
                        Image(systemName: AgentKind.from(id: a.id).systemImage)
                        Text(a.displayName)
                        if !a.isInstalled {
                            Text("설정 필요").font(.caption2).foregroundStyle(Theme.warning)
                        }
                    }
                    .tag(a.id)
                }
            } label: {
                Text("CLI 도구")
            }
            .pickerStyle(.inline)
            .labelsHidden()
            .accessibilityLabel(Text("CLI 도구"))
        } header: {
            Text("에이전트")
        } footer: {
            footer()
        }
    }
}

extension PoAgentSection where Footer == EmptyView {
    init(agents: [AgentInfo], selection: Binding<String>) {
        self.init(agents: agents, selection: selection) { EmptyView() }
    }
}

// MARK: - 보류/기각 사유 태그 (po_decide_reason_v1)

/// 결재 사유 태그 — daemon 의 허용 enum 키와 1:1. 결재가 «왜» 됐는지의 원천 데이터(후속 사유
/// 집계의 선행). 단건·일괄, reject·hold 가 같은 태그를 공유하고, 미선택을 허용(권장)해 강제
/// 마찰이 없다. rawValue 가 그대로 daemon body 의 reason 으로 간다.
enum DecideReason: String, CaseIterable, Identifiable {
    case priorityLow = "priority_low"
    case scopeTooBig = "scope_too_big"
    case alreadyExists = "already_exists"
    case weakEvidence = "weak_evidence"
    case wrongDirection = "wrong_direction"

    var id: String { rawValue }

    var label: Text {
        switch self {
        case .priorityLow: return Text("우선순위 낮음")
        case .scopeTooBig: return Text("범위 과대")
        case .alreadyExists: return Text("이미 있음")
        case .weakEvidence: return Text("근거 약함")
        case .wrongDirection: return Text("방향 안 맞음")
        }
    }

    /// 접근성 — 무엇을 고르는 칩인지 분명히. 각 라벨을 localize 된 «사유» 문맥으로 감싼다.
    var accessibilityLabel: Text {
        switch self {
        case .priorityLow: return Text("사유 태그: 우선순위 낮음")
        case .scopeTooBig: return Text("사유 태그: 범위 과대")
        case .alreadyExists: return Text("사유 태그: 이미 있음")
        case .weakEvidence: return Text("사유 태그: 근거 약함")
        case .wrongDirection: return Text("사유 태그: 방향 안 맞음")
        }
    }
}

/// 결재 사유 태그 줄 — «항상 제시»(빈 상태 없음), 1탭으로 단일 선택/해제. 미선택(nil)은 daemon 에
/// NULL 로 가 강제 마찰이 없다. 색 정책: 칩은 «선택 입력» 이라 선택 시 accent(보라), 미선택은
/// 중립 — status 색(빨강/노랑)을 장식으로 빌리지 않는다(기각 «동작» 버튼만 danger).
struct DecideReasonPicker: View {
    @Binding var selected: DecideReason?

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.s) {
            Text("사유 (선택)")
                .font(.caption2)
                .foregroundStyle(.secondary)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: Theme.Spacing.s) {
                    ForEach(DecideReason.allCases) { reason in
                        DecideReasonChip(reason: reason, selected: selected == reason) {
                            selected = (selected == reason) ? nil : reason
                        }
                    }
                }
                .padding(.vertical, Theme.Spacing.xxs)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// 사유 태그 칩 1개 — 선택 시 accent 채움, 미선택은 중립(TriageChip 과 동일 패턴).
private struct DecideReasonChip: View {
    let reason: DecideReason
    let selected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            reason.label
                .font(.caption.weight(.medium))
                .padding(.horizontal, Theme.Spacing.xl)
                .padding(.vertical, Theme.Spacing.s)
                .background(
                    Capsule().fill(
                        selected
                            ? Theme.accent
                            : Theme.neutralFill.opacity(Theme.Opacity.fill)),
                )
                .foregroundStyle(selected ? Theme.onAccent : Color.primary)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(reason.accessibilityLabel)
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
    }
}

// MARK: - 상세 + 결재

/// 브리프 상세 — 문제/근거/스코프/스펙 전부 + 하단 결재 버튼. 승인 판단을 30초 안에 할 수
/// 있도록 근거(역추적 가능한 참조)를 본문 위쪽에 둔다.
private struct BriefDetailView: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var conn: ConnectionManager
    @EnvironmentObject var inflight: InFlightTracker
    /// worktree 시작은 프로 전용 — 새 세션 시트·채팅 BranchSheet 의 게이트와 통일.
    @EnvironmentObject var purchase: PurchaseStore
    @Environment(\.dismiss) private var dismiss
    /// 지금 선택된 메인 탭 — 워크플로우 캔버스 푸시의 탭 바 숨김을 «백로그 탭이 활성일 때만» 걸기 위함.
    /// 딥링크로 다른 탭 전환 시 숨김이 남아 탭 바가 사라진 채 갇히는 누출 방지(MainTabView 주석 참고).
    @Environment(\.activeMainTab) private var activeMainTab
    private var canvasTabBarVisibility: Visibility {
        (activeMainTab ?? .backlog) == .backlog ? .hidden : .visible
    }

    let brief: PoBrief
    /// daemon 이 decide body 의 useWorktree 를 지원하는가 (po_worktree_v1, soft).
    let supportsWorktree: Bool
    /// daemon 이 기각 브리프의 «코드 흔적 정리» 를 지원하는가 (po_cleanup_v1, soft).
    let supportsCleanup: Bool
    /// daemon 이 decide body 의 mode="workflow" 를 지원하는가 (po_workflow_v1, soft).
    /// 옛 daemon 은 mode 를 조용히 버려 세션 모드로 돌므로 선택지를 숨긴다 (거짓 UI 방지).
    let supportsWorkflowMode: Bool
    /// 구현 세션 에이전트 후보 (po_agent_v1) — 비어 있으면 픽커를 숨기고 daemon 기본으로 돈다.
    let agents: [AgentInfo]
    /// 이 브리프 레포에서 수집이 진행 중이면 그 세션 id (아니면 nil). non-nil 이면 shipped 상세의
    /// «지금 수집해 검증하기» 버튼이 «검증 중 — 세션 보기» 로 바뀐다 (수집이 가설 대조를 겸하므로).
    let verifyingSessionId: String?
    /// 워크플로우 캔버스의 노드 세션 열기 — 세션 탭 전환 + 딥링크 (목록과 동일 경로).
    let onOpenSession: (String) -> Void
    /// 결재 완료 콜백 — (갱신된 브리프, approve 면 구현 세션 id).
    let onDecided: (PoBrief, String?) -> Void
    /// 수정 지시 시작 콜백 — 목록이 재로드해 «재종합 중» 배지를 띄운다.
    let onRevised: () -> Void
    /// shipped «지금 수집해 검증하기» 콜백 — (수집 시작 결과). 목록이 진행 배너 + gh 안내를 띄운다.
    let onVerifyCollect: (PoCollectStart) -> Void

    @State private var deciding = false
    @State private var confirmApprove = false
    /// 보류/기각 사유 태그 (po_decide_reason_v1) — 단건 결재 시 1탭 선택(미선택 허용). reject·hold
    /// 양쪽에 적용되고, 결재 호출에 rawValue 로 실린다.
    @State private var decideReason: DecideReason?
    /// 기각 다이얼로그 — supportsCleanup 일 때만 («기각만 / 기각하고 코드 흔적 정리» 선택).
    @State private var confirmReject = false
    /// 기각된 브리프 상세의 «정리 시작» 최종 확인.
    @State private var confirmCleanup = false
    @State private var showRevise = false
    @State private var reviseComment = ""
    @State private var error: String?
    /// 승인 시 구현을 맡길 에이전트 — 픽커 미노출(agents 비음)이면 의미 없음.
    /// 마지막 선택을 @AppStorage 로 기억해, 브리프 상세에 다시 들어오면 그 에이전트가 기본 선택된다
    /// (브리프 전역 «마지막 선택» — 매번 같은 도구로 승인하는 흐름을 한 탭 줄여준다). 기억한 id 가
    /// 현재 후보에 없으면(어댑터 제거 등) onAppear 에서 첫 후보로 보정해 «빈 선택» 을 막는다.
    @AppStorage("po.brief.lastAgentId") private var execAgentId = AgentInfo.claudeCodeFallback.id
    /// 브리프의 레포가 git 작업트리인가 — 최종 확인의 «worktree 에서 시작» 선택지 노출 분기.
    /// 조회 전/실패는 false — 기존 단일 버튼으로 폴백.
    @State private var repoIsGit = false
    /// 프로 게이트 페이월 — 미보유 사용자가 worktree 시작을 탭하면 PaywallView 시트.
    @State private var paywallFeature: ProFeature?
    /// 연결된 워크플로우 run 의 현재 상태 (po_workflow_v1) — 상세 진입 시 1회 조회.
    /// 라이브 추적은 캔버스가 한다 (여기는 «어디까지 갔나» 한 줄).
    @State private var workflowRunStatus: String?

    private var api: ApiClient { ApiClient(auth: auth, conn: conn, tracker: inflight) }
    private var decidable: Bool {
        (brief.status == "proposed" || brief.status == "held") && brief.revisingSessionId == nil
    }
    /// 최종 확인에서 worktree/현재 레포를 고를 수 있는가 — daemon capability + git 레포일 때만.
    private var worktreeChoice: Bool { supportsWorktree && repoIsGit }

    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 6) {
                    Text(brief.title)
                        .font(.headline)
                    HStack(spacing: 8) {
                        Label("영향 \(brief.impact)", systemImage: "arrow.up.right")
                        Label("노력 \(brief.effort)", systemImage: "hammer")
                        Spacer(minLength: 0)
                        Text(verbatim: (brief.repoPath as NSString).lastPathComponent)
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }
                .padding(.vertical, 2)
            }
            // 실행/정리 에이전트 (po_agent_echo_v1) — 이 브리프가 «실제로» 어떤 코드 에이전트로
            // 돌(았)는지. daemon 이 agent 누락 시 조용히 claude_code 로 폴백한 무음 실패를 드러낸다.
            if brief.execAgentId != nil || brief.cleanupAgentId != nil {
                Section {
                    if let exec = brief.execAgentId {
                        LabeledContent {
                            PoAgentChip(agentId: exec, agents: agents)
                        } label: {
                            Text("구현")
                        }
                        // 픽커 선택과 실제 실행 에이전트가 다르면 경고 — 보낸 도구가 daemon 에서
                        // 기본값으로 폴백됐다는 신호 (warning=노랑, 진짜 주의 신호라 정책 허용).
                        // 구현이 도는 동안(running/approved)만 의미 있다 — 출시 후 상태엔 잡음.
                        if !agents.isEmpty, exec != execAgentId,
                            brief.status == "running" || brief.status == "approved" {
                            Label {
                                Text("선택한 도구와 다른 에이전트로 구현 중이에요. 승인할 때 에이전트가 전달되지 않아 기본 도구로 폴백됐을 수 있어요.")
                            } icon: {
                                Image(systemName: "exclamationmark.triangle.fill")
                            }
                            .font(.caption)
                            .foregroundStyle(Theme.warning)
                        }
                    }
                    if let cleanup = brief.cleanupAgentId {
                        LabeledContent {
                            PoAgentChip(agentId: cleanup, agents: agents)
                        } label: {
                            Text("정리")
                        }
                    }
                } header: {
                    Text("에이전트")
                }
            }
            Section("문제") {
                Text(verbatim: brief.problem)
                    .font(.callout)
                    .textSelection(.enabled)
            }
            Section("근거") {
                ForEach(Array(brief.evidence.enumerated()), id: \.offset) { _, ev in
                    VStack(alignment: .leading, spacing: 3) {
                        Text(verbatim: ev.summary)
                            .font(.callout)
                        Text(verbatim: "\(ev.kind) · \(ev.ref)")
                            .font(.caption2.monospaced())
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                    }
                    .padding(.vertical, 1)
                }
            }
            // 리서치産 브리프 — 근거의 원문(보고서)을 한 번에 역추적.
            if let researchId = brief.researchId {
                Section {
                    NavigationLink {
                        ResearchReportView(researchId: researchId)
                    } label: {
                        Label("리서치 보고서 보기", systemImage: "doc.text.magnifyingglass")
                    }
                }
            }
            // 결재 사유 — rejected/held 브리프의 decideReason 태그 + decideNote 메모 (po_decide_reason_v2).
            // 내가 결재 때 단 사유를 다시 보여준다. verifyNote 섹션과 같은 Label 패턴 재사용.
            if (brief.status == "rejected" || brief.status == "held"),
               let reasonStr = brief.decideReason, !reasonStr.isEmpty {
                Section("결재 사유") {
                    if let reason = DecideReason(rawValue: reasonStr) {
                        Label {
                            reason.label
                                .font(.callout)
                        } icon: {
                            Image(systemName: "tag.fill")
                                .foregroundStyle(.secondary)
                        }
                    }
                    if let note = brief.decideNote, !note.isEmpty {
                        Text(verbatim: note)
                            .font(.callout)
                            .foregroundStyle(.primary)
                            .textSelection(.enabled)
                    }
                }
            }
            // 출시 후 검증 (§3.5) — 예전엔 여기 List 중간 Section 이었으나 스크롤에 묻혀
            // 쓰기 불편했다. 스크롤 위치와 무관하게 언제든 «지금 수집해 검증하기» 를 누를 수
            // 있도록 하단 플로팅 카드(verifyFloatingBar)로 옮겼다 (.safeAreaInset).
            // 기각 후 «코드 흔적 정리» (po_cleanup_v1) — 기각된 아이디어의 신호원(TODO 주석·
            // 죽은 코드)이 레포에 남으면 다음 수집이 같은 제안을 또 만든다. 그 흔적을 지우는
            // 정리 세션의 진입점 — 기각(rejected) 브리프에서만.
            if supportsCleanup && brief.status == "rejected" {
                Section {
                    if let sid = brief.cleanupSessionId {
                        // 이미 만든 정리 세션 역추적 — onDecided 의 세션 열기 경로를 재사용.
                        Button {
                            dismiss()
                            onDecided(brief, sid)
                        } label: {
                            Label("정리 세션 보기", systemImage: "text.magnifyingglass")
                        }
                        .tint(Theme.accent)
                        .listItemTint(Theme.accent)
                    }
                    Button {
                        confirmCleanup = true
                    } label: {
                        // ternary 의 String 추론 회피 — 분기마다 Label 로 (다국어 정책).
                        if brief.cleanupSessionId == nil {
                            Label("TODO·죽은 코드 정리 시작", systemImage: "paintbrush")
                        } else {
                            Label("다시 정리하기", systemImage: "paintbrush")
                        }
                    }
                    // 기본 틴트가 (iOS 26 시뮬레이터에서) AccentColor 에셋을 안 타고 파랗게
                    // 떠서 명시 — List 행 Label 아이콘은 listItemTint (색 정책: 파랑 금지).
                    .tint(Theme.accent)
                    .listItemTint(Theme.accent)
                    .disabled(deciding)
                } header: {
                    Text("코드 흔적 정리")
                } footer: {
                    Text("기각된 아이디어의 TODO 주석·죽은 코드가 남아 있으면 다음 신호 수집에서 같은 제안이 반복될 수 있어요. 에이전트가 근거를 따라 흔적만 정리해요 — 커밋은 하지 않아 세션에서 검토할 수 있어요.")
                }
            }
            // «워크플로우로 실행» 승인의 진행 상태 (po_workflow_v1) — run 상태 한 줄 +
            // 캔버스 진입점. AI 설계 실패 fallback / 게이트 거부 / run 실패 메모도 여기서.
            if let workflowId = brief.execWorkflowId {
                Section("구현 워크플로우") {
                    if let status = workflowRunStatus {
                        LabeledContent {
                            workflowRunStatusText(status)
                                .foregroundStyle(.primary)
                        } label: {
                            Text("실행 상태")
                        }
                    }
                    if let note = brief.execNote, !note.isEmpty {
                        // daemon 이 남긴 원인 추적 메모 (에이전트/서버 산출 — 번역 대상 아님).
                        Text(verbatim: note)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    NavigationLink {
                        WorkflowRunLoaderView(
                            workflowId: workflowId,
                            runId: brief.execRunId,
                            onOpenSession: onOpenSession
                        )
                        .toolbar(canvasTabBarVisibility, for: .tabBar)
                    } label: {
                        Label("워크플로우 캔버스 열기", systemImage: "point.3.connected.trianglepath.dotted")
                    }
                    // List 행의 Label 아이콘은 listItemTint — 명시 없으면 파랗게 뜬다 (색 정책).
                    .listItemTint(Theme.accent)
                }
            }
            Section("스코프") {
                Text(verbatim: brief.scope)
                    .font(.callout)
                    .textSelection(.enabled)
            }
            Section("스펙") {
                Text(verbatim: brief.spec)
                    .font(.callout)
                    .textSelection(.enabled)
            }
            // 디자인 수용 기준 — spec 자유텍스트에 묻힌 «색 의미·다국어·상태·접근성» 고려를 별도
            // 블록으로 끌어올려, 폰에서 30초 안에 승인하기 «전» 에 디자인 회귀(상태 누락·브랜드
            // 드리프트)를 한눈에 가늠하게 한다. 정밀 점검이 아니라 «스펙이 다뤘는가» 요약 —
            // 못 잡으면 «미명시»(중립)다. 색은 의미 토큰만: 다룸=accent(보라·강조 아이콘),
            // 미명시=secondary(중립). status색(success/danger/warning)을 다룸 표시로 빌려 쓰지
            // 않는다(색 정책: 장식에 status색 차용 금지, 미명시는 경고가 아닌 정보).
            Section {
                ForEach(designCriteria(in: brief.spec)) { c in
                    HStack(spacing: 10) {
                        Image(systemName: c.systemImage)
                            .font(.callout)
                            .foregroundStyle(c.covered ? Theme.accent : Color.secondary)
                            .frame(width: 22)
                        Text(c.label)
                            .font(.callout)
                            .foregroundStyle(.primary)
                        Spacer(minLength: 8)
                        if c.covered {
                            // 다룸 — accent(보라)는 «강조 아이콘» 용도(색 정책 허용). 정적 표시지만
                            // status 신호색이 아니라 브랜드 강조라 의미 혼동이 없다.
                            Label("명시됨", systemImage: "checkmark")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(Theme.accent)
                        } else {
                            // 미명시 — 경고가 아니라 정보. 중립(secondary)으로 둬 노랑(warning) 오용을 피한다.
                            Text("미명시")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .padding(.vertical, 1)
                }
            } header: {
                Text("디자인 수용 기준")
            } footer: {
                Text("스펙이 디자인 제약(색 의미·다국어·상태·접근성)을 다뤘는지 요약했어요. «미명시» 는 스펙에 그 기준이 안 보인다는 정보일 뿐이에요 — UI 가 닿지 않는 브리프엔 원래 디자인 기준이 없어요.")
            }
            // 구현 에이전트 선택 (po_agent_v1) — 결재 가능한 브리프에서만. 하단 «승인» 과 짝.
            if decidable && !agents.isEmpty {
                PoAgentSection(agents: agents, selection: $execAgentId) {
                    Text("승인하면 이 에이전트가 구현을 시작해요.")
                }
            }
            // 검증 수집 에이전트 선택 (po_agent_v1) — 출시된(shipped) 브리프에서만. 하단
            // «지금 수집해 검증하기» 와 짝. 결재용 픽커와 같은 «마지막 선택»(execAgentId) 을
            // 공유해 브리프 전역에서 한 도구로 일관되게 (수집도 collect 파이프라 §14.4 agent 게이트 적용).
            if brief.status == "shipped" && !agents.isEmpty {
                PoAgentSection(agents: agents, selection: $execAgentId) {
                    Text("이 에이전트가 신호를 수집해 가설을 대조해요.")
                }
            }
            // 정리 에이전트 선택 (po_agent_v1) — 기각된 브리프의 «코드 흔적 정리» 와 짝.
            // 정리도 agent 게이트 대상(§14.4)이라 같은 «마지막 선택» 을 따른다.
            if supportsCleanup && brief.status == "rejected" && !agents.isEmpty {
                PoAgentSection(agents: agents, selection: $execAgentId) {
                    Text("이 에이전트가 코드 흔적을 정리해요.")
                }
            }
            if let error {
                Section {
                    Text(LocalizedStringKey(error))
                        .font(.caption)
                        .foregroundStyle(Theme.danger)
                }
            }
        }
        .navigationTitle("브리프")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            // 수정 지시 — 티켓에 코멘트 달듯 한 줄로 브리프를 다듬는다 (승인 전 개입 통로).
            if decidable {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("수정 지시") { showRevise = true }
                }
            }
        }
        // 수정 지시 — 예전엔 .alert 였지만, alert 은 마이크 버튼 같은 커스텀 뷰를 못 담아 sheet 으로
        // 바꿨다(받아쓰기 부착). 보내기/취소·안내문은 그대로, 입력은 멀티라인 + 마이크.
        .sheet(isPresented: $showRevise) {
            ReviseCommentSheet(comment: $reviseComment, isSending: deciding) {
                Task { await revise() }
            }
        }
        .safeAreaInset(edge: .bottom) {
            // 결재 가능(proposed/held)이면 결재 바, 출시 후(shipped/verified/missed)면 검증
            // 플로팅 카드 — 두 상태는 상호 배타적이라 같은 하단 자리를 나눠 쓴다.
            if decidable {
                decisionBar
            } else if ["shipped", "verified", "missed"].contains(brief.status) {
                verifyFloatingBar
            }
        }
        .confirmationDialog(
            // ternary 의 String 추론 회피 — Text 로 갈라 각각 LocalizedStringKey 추출 (다국어 정책).
            worktreeChoice
                ? Text("승인하면 에이전트가 바로 구현을 시작해요. worktree 는 별도 작업 폴더라 동시에 도는 다른 세션과 충돌하지 않아요.")
                : Text("승인하면 에이전트가 바로 구현을 시작해요."),
            isPresented: $confirmApprove,
            titleVisibility: .visible,
        ) {
            if worktreeChoice {
                Button("새 worktree 에서 구현 시작") {
                    // worktree 는 프로 전용 — 게이트 단일화: 판정은 항상 purchase.isUnlocked(.worktree).
                    if !purchase.isUnlocked(.worktree) {
                        paywallFeature = .worktree
                        return
                    }
                    Task { await decide("approve", useWorktree: true) }
                }
                Button("현재 레포에서 구현 시작") {
                    Task { await decide("approve", useWorktree: false) }
                }
            } else {
                Button("승인하고 구현 시작") {
                    Task { await decide("approve") }
                }
            }
            // «워크플로우로 실행» (po_workflow_v1) — 설계 에이전트가 브리프 맞춤
            // 스펙→구현→자가검증→머지 승인 게이트 DAG 를 만들어 실행한다. 워크플로우는
            // 프로 전용이라 탭과 같은 게이트 (비-프로는 세션 모드만).
            if supportsWorkflowMode {
                Button("워크플로우로 구현 (자가검증 + 머지 승인)") {
                    if !purchase.isUnlocked(.workflow) {
                        paywallFeature = .workflow
                        return
                    }
                    Task { await decide("approve", mode: "workflow") }
                }
            }
        }
        // 기각 다이얼로그 (po_cleanup_v1) — 기각만 할지, 흔적 정리 세션까지 돌릴지.
        // 흔적(TODO 주석·죽은 코드)이 남으면 다음 수집에서 같은 제안이 반복되기 때문.
        .confirmationDialog(
            Text("기각하면 이 제안은 종결돼요. 이 아이디어가 남긴 TODO 주석·죽은 코드를 에이전트가 함께 정리하게 할 수 있어요 — 흔적이 남으면 다음 수집에서 같은 제안이 반복될 수 있어요."),
            isPresented: $confirmReject,
            titleVisibility: .visible,
        ) {
            Button("기각하고 코드 흔적 정리", role: .destructive) {
                Task { await rejectAndCleanup() }
            }
            Button("기각만", role: .destructive) {
                Task { await decide("reject", reason: decideReason?.rawValue) }
            }
        }
        // 기각된 브리프 상세의 «정리 시작» 최종 확인 — 무엇이 일어나는지 한 번 더.
        .confirmationDialog(
            Text("에이전트가 이 아이디어와 관련된 TODO 주석·죽은 코드를 찾아 지워요. 변경은 커밋하지 않아요 — 세션에서 검토할 수 있어요."),
            isPresented: $confirmCleanup,
            titleVisibility: .visible,
        ) {
            Button("정리 시작") {
                Task { await cleanup() }
            }
        }
        // 프로 전용(worktree)을 미보유 사용자가 시도했을 때의 업셀 페이월.
        .proPaywall(item: $paywallFeature)
        .task {
            // worktree 선택지 노출 판단 — 결재 가능한 브리프에서만 조회 (실패는 조용히 폴백).
            guard supportsWorktree, decidable else { return }
            repoIsGit = (try? await api.repoGitInfo(repoPath: brief.repoPath))?.isRepo ?? false
        }
        .task {
            // 연결된 워크플로우 run 의 현재 상태 — 실패는 조용히 (행 자체를 숨긴다).
            guard let runId = brief.execRunId else { return }
            workflowRunStatus = try? await api.workflowRunState(runId: runId).run.status
        }
        .onAppear {
            // 기억한 에이전트(@AppStorage)가 현재 후보에 없으면(어댑터 제거·후보 변경) 첫 후보로
            // 보정 — 인라인 Picker 가 어느 태그와도 안 맞아 «빈 선택» 으로 뜨고, 그 stale id 가
            // 승인 요청에 실려 가는 걸 막는다.
            if !agents.isEmpty, !agents.contains(where: { $0.id == execAgentId }) {
                execAgentId = agents.first!.id
            }
        }
    }

    /// 하단 결재 바 — 사유 태그(항상 제시) + 기각(빨강=danger)/보류(중립)/승인(기본 틴트=accent).
    private var decisionBar: some View {
        VStack(spacing: Theme.Spacing.l) {
            // 보류/기각 사유 태그 (po_decide_reason_v1) — 1탭 선택(미선택 허용). approve 엔 무관.
            DecideReasonPicker(selected: $decideReason)
            HStack(spacing: 10) {
                Button(role: .destructive) {
                    // po_cleanup_v1 — 기각 시 «흔적 정리까지» 선택지를 다이얼로그로. 미지원
                    // daemon 은 기존처럼 즉시 기각 (soft).
                    if supportsCleanup {
                        confirmReject = true
                    } else {
                        Task { await decide("reject", reason: decideReason?.rawValue) }
                    }
                } label: {
                    Text("기각").frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)

                if brief.status == "proposed" {
                    Button {
                        Task { await decide("hold", reason: decideReason?.rawValue) }
                    } label: {
                        Text("보류").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .tint(.primary)
                }

                Button {
                    confirmApprove = true
                } label: {
                    Text("승인").frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                // 기본 prominent 의 파랑 회피 — 명시 accent (PaywallView 관례, 색 정책: 파랑 금지).
                .tint(Theme.accent)
            }
        }
        .disabled(deciding)
        .padding(.horizontal)
        .padding(.vertical, 10)
        .background(.bar)
    }

    /// 출시 후 검증 플로팅 카드 — shipped 는 «지금 수집해 검증하기» 실행 버튼, verified/missed
    /// 는 판정 + 근거. List 중간 Section 이던 걸 하단에 띄워 스크롤 위치와 무관하게 언제든
    /// 누를 수 있게 했다.
    private var verifyFloatingBar: some View {
        VStack(alignment: .leading, spacing: 8) {
            switch brief.status {
            case "verified":
                Label("검증됨 — 가설이 해소됐어요", systemImage: "checkmark.seal")
                    .font(.callout)
                    .foregroundStyle(Theme.success)
            case "missed":
                Label("빗나감 — 신호가 해소되지 않았어요", systemImage: "xmark.seal")
                    .font(.callout)
                    .foregroundStyle(Theme.danger)
            default:
                // 이 레포에서 수집이 돌고 있으면 곧 가설을 대조한다 → «검증 중» 으로 알린다 (중복 실행 혼동 방지).
                if verifyingSessionId != nil {
                    Label("검증 중 — 신호를 수집해 가설을 대조하고 있어요", systemImage: "antenna.radiowaves.left.and.right")
                        .font(.callout)
                        .foregroundStyle(Theme.info)
                } else {
                    Label("출시됨 — 다음 신호 수집이 가설을 대조해요", systemImage: "clock")
                        .font(.callout)
                        .foregroundStyle(Theme.info)
                }
            }
            if let note = brief.verifyNote, !note.isEmpty {
                Text(verbatim: note)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
            if brief.status == "shipped" {
                if let sid = verifyingSessionId {
                    // 이미 검증 수집이 도는 중 — 또 누르지 않도록 버튼 대신 «검증 중 · 세션 보기» 진입점.
                    Button {
                        dismiss()
                        onOpenSession(sid)
                    } label: {
                        HStack(spacing: 8) {
                            ProgressView().controlSize(.small)
                            Text("검증 중 · 세션 보기")
                                .frame(maxWidth: .infinity)
                        }
                    }
                    .buttonStyle(.bordered)
                } else {
                    // «이어서 쓰는 법» 의 실행 버튼 — 다음 수집을 기다리지 않고 지금 같은 레포
                    // 수집을 돌려 가설 대조를 시작한다.
                    Button {
                        Task { await startVerifyCollect() }
                    } label: {
                        Label("지금 수집해 검증하기", systemImage: "antenna.radiowaves.left.and.right")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    // 기본 prominent 의 파랑 회피 — 명시 accent (위 info(파랑) 상태 라벨과도 구분, 색 정책: 파랑 금지).
                    .tint(Theme.accent)
                    .disabled(deciding)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16))
        .overlay(
            RoundedRectangle(cornerRadius: 16)
                .strokeBorder(.separator, lineWidth: 0.5)
        )
        .shadow(color: .black.opacity(0.15), radius: 8, y: 2)
        .padding(.horizontal)
        .padding(.bottom, 8)
    }

    private func decide(_ action: String, useWorktree: Bool? = nil, mode: String? = nil, reason: String? = nil) async {
        guard !deciding else { return }
        deciding = true
        defer { deciding = false }
        // 에이전트는 approve 에만 의미 있고, 픽커가 노출됐을 때만 보낸다 (옛 daemon 은 무시).
        let agent = (action == "approve" && !agents.isEmpty) ? execAgentId : nil
        do {
            let result = try await api.decidePoBrief(
                id: brief.id, action: action, useWorktree: useWorktree, agent: agent, mode: mode,
                reason: reason)
            dismiss()
            // 워크플로우 모드의 execSessionId 는 «설계 세션» — 그대로 열어 설계를 관전한다.
            onDecided(result.brief, result.execSessionId)
        } catch {
            self.error = (error as? LocalizedError)?.errorDescription ?? "\(error)"
        }
    }

    /// 기각된 브리프의 «코드 흔적 정리» 세션 spawn — 성공하면 세션 탭으로 (onDecided 경로 재사용).
    private func cleanup() async {
        guard !deciding else { return }
        deciding = true
        defer { deciding = false }
        // 에이전트 픽커가 노출됐다면 정리 세션도 같은 선택을 따른다 (승인·기각정리와 같은 규칙).
        let agent = agents.isEmpty ? nil : execAgentId
        do {
            let result = try await api.cleanupPoBrief(id: brief.id, agent: agent)
            dismiss()
            onDecided(result.brief, result.cleanupSessionId)
        } catch {
            self.error = (error as? LocalizedError)?.errorDescription ?? "\(error)"
        }
    }

    /// «기각하고 코드 흔적 정리» — 기각 결재 후 곧장 정리 세션 spawn. 기각은 됐는데 정리
    /// spawn 이 실패하면 목록만 갱신하고 에러를 남긴다 (정리는 기각 브리프 상세에서 재시도).
    private func rejectAndCleanup() async {
        guard !deciding else { return }
        deciding = true
        defer { deciding = false }
        // 에이전트 픽커가 노출됐다면 정리 세션도 같은 선택을 따른다 (승인과 같은 규칙).
        let agent = agents.isEmpty ? nil : execAgentId
        do {
            let rejected = try await api.decidePoBrief(id: brief.id, action: "reject", reason: decideReason?.rawValue)
            do {
                let result = try await api.cleanupPoBrief(id: brief.id, agent: agent)
                dismiss()
                onDecided(result.brief, result.cleanupSessionId)
            } catch {
                onDecided(rejected.brief, nil)
                self.error = (error as? LocalizedError)?.errorDescription ?? "\(error)"
            }
        } catch {
            self.error = (error as? LocalizedError)?.errorDescription ?? "\(error)"
        }
    }

    private func revise() async {
        let comment = reviseComment.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !comment.isEmpty, !deciding else { return }
        deciding = true
        defer { deciding = false }
        // sheet 은 alert 과 달리 자동으로 닫히지 않으니 명시로 닫는다 — 성공이면 상세까지 dismiss,
        // 실패면 sheet 만 닫아 뒤의 상세에서 오류 Section 이 보이게.
        showRevise = false
        do {
            _ = try await api.revisePoBrief(id: brief.id, comment: comment)
            reviseComment = ""
            dismiss()
            onRevised()
        } catch {
            self.error = (error as? LocalizedError)?.errorDescription ?? "\(error)"
        }
    }

    /// shipped — 검증을 기다리지 않고 지금 같은 레포 수집을 돌린다. 수집 파이프가
    /// shipped 브리프 가설 대조(verified/missed)를 함께 수행한다.
    private func startVerifyCollect() async {
        guard !deciding else { return }
        deciding = true
        defer { deciding = false }
        do {
            // 검증 수집도 에이전트 선택을 따른다 (collect 파이프라 §14.4 의 agent 게이트 적용).
            // 픽커가 노출됐을 때만 보낸다 — 옛 daemon/미지원은 nil 로 두어 claude_code 기본.
            let agent = agents.isEmpty ? nil : execAgentId
            let started = try await api.startPoCollection(
                repoPath: brief.repoPath, instruction: nil, agent: agent)
            dismiss()
            onVerifyCollect(started)
        } catch {
            self.error = (error as? LocalizedError)?.errorDescription ?? "\(error)"
        }
    }
}

// MARK: - 디자인 수용 기준 (브리프 spec 휴리스틱 요약)

/// 브리프 상세의 «디자인 수용 기준» 한 축 — 색 의미·다국어·상태·접근성 중 하나가 spec 에서
/// 다뤄졌는지. covered=스펙 본문이 그 기준을 언급함 / false=미명시(정보일 뿐, 경고 아님).
private struct DesignCriterion: Identifiable {
    /// ForEach 식별자 — 라벨(번역 키)이 아니라 안정적인 영문 축 키.
    let id: String
    /// 화면 표시명 — LocalizedStringKey 라 호출부 string literal 이 카탈로그 자동 추출 경로를 탄다.
    let label: LocalizedStringKey
    let systemImage: String
    let covered: Bool
}

/// spec 자유텍스트(markdown)에서 디자인 4축(색 의미·다국어·상태·접근성)이 «다뤄졌는지» 를
/// 키워드로 가볍게 판정한다. PO 수집/리서치 프롬프트가 spec 수용 기준에 「디자인 제약」 을
/// 반영하도록 지시하지만(prompt.ts), 그 결과는 구조화 필드가 아니라 자유 markdown 이라 휴리스틱
/// 으로 읽는다 — 덕에 spec 구조화 선행(브리프 #1) 없이도 독립 동작한다(브리프 의존성 해소).
/// 정밀 점검이 아니라 «승인 전 한눈 요약» 이 목적이라, 못 잡으면 «미명시»(중립)로 떨어진다.
/// 한국어 키워드는 lowercased 영향이 없고 영문 키워드만 소문자 매칭된다.
private func designCriteria(in spec: String) -> [DesignCriterion] {
    let s = spec.lowercased()
    func mentions(_ needles: [String]) -> Bool { needles.contains { s.contains($0) } }
    return [
        DesignCriterion(
            id: "color", label: "색 의미", systemImage: "paintpalette",
            covered: mentions([
                "색상", "색 의미", "색의 의미", "의미 토큰", "디자인 토큰", "design token",
                "컬러", "color", "팔레트", "palette", "accent", "purple", "보라색", "틴트", "tint",
            ])),
        DesignCriterion(
            id: "i18n", label: "다국어", systemImage: "globe",
            covered: mentions([
                "i18n", "l10n", "로케일", "locale", "번역", "translat", "다국어", "localiz",
                "localis", "xcstrings", "카탈로그", "catalog", "현지화", "지원 언어", "언어 집합",
            ])),
        DesignCriterion(
            id: "state", label: "상태", systemImage: "square.stack",
            covered: mentions([
                "상태", "빈 ", "빈/", "empty", "오류", "에러", "error", "로딩", "loading",
                "비활성", "disabled", "포커스", "focus", "엣지", "edge case", "placeholder",
            ])),
        DesignCriterion(
            id: "a11y", label: "접근성", systemImage: "accessibility",
            covered: mentions([
                "접근성", "accessibility", "a11y", "voiceover", "보이스오버", "스크린 리더",
                "screen reader", "대비", "contrast",
            ])),
    ]
}

/// 브리프 «수정 지시» 입력 시트 — 예전 .alert 을 대체한다(alert 은 마이크 버튼을 못 담는다).
/// 멀티라인 입력 + 받아쓰기 마이크. 보내기/취소·안내문은 기존 alert 과 동일 문자열을 재사용한다.
private struct ReviseCommentSheet: View {
    @Binding var comment: String
    /// 전송 중 — 보내기 버튼 비활성(중복 전송 방지).
    let isSending: Bool
    let onSend: () -> Void
    @Environment(\.dismiss) private var dismiss
    @FocusState private var focused: Bool

    private var canSend: Bool {
        !comment.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !isSending
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VoiceInputField("예: 스코프를 절반으로 줄여줘", text: $comment, lineLimit: 1...4, focus: $focused)
                } footer: {
                    Text("티켓에 코멘트 달듯 한 줄로 — 에이전트가 브리프를 다듬어 갱신해요.")
                }
            }
            .navigationTitle("수정 지시")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("취소") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("보내기") { onSend() }
                        .disabled(!canSend)
                }
            }
            .voiceDictationChrome()
            .onAppear { focused = true }
        }
        .presentationDetents([.medium])
    }
}

/// 워크플로우 run 상태 라벨 — 캔버스(workflowStatusText)와 같은 표기. 각 분기가 Text
/// literal 이라 LocalizedStringKey 자동 추출 경로를 탄다 (다국어 정책).
private func workflowRunStatusText(_ status: String) -> Text {
    switch status {
    case "running": return Text("실행 중")
    case "done": return Text("완료")
    case "failed": return Text("실패")
    case "cancelled": return Text("취소됨")
    default: return Text("대기 중")
    }
}

// MARK: - 수집 레포 선택

/// «지금 수집» 1단계 — 어느 레포의 신호를 모을지 고른다. 레포를 고르면 2단계
/// (조사 방식 프로필 + 이번 지시)로 push 된다.
private struct CollectRepoSheet: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var conn: ConnectionManager
    @EnvironmentObject var inflight: InFlightTracker
    @Environment(\.dismiss) private var dismiss

    /// daemon 이 주기 수집(po_schedule_v1)을 지원하는가 — 2단계 «주기 수집» 섹션 노출 분기.
    let supportsSchedule: Bool
    /// daemon 이 스토어 리뷰 신호(po_asc_v1)를 지원하는가 — 2단계 «스토어 리뷰» 섹션 노출 분기.
    let supportsAsc: Bool
    /// daemon 이 GitHub 피드백 repo(po_feedback_repo_v1)를 지원하는가 — 2단계 «피드백 repo» 입력 노출 분기.
    let supportsFeedbackRepo: Bool
    /// daemon 이 디자인 부트스트랩(po_design_bootstrap_v1)을 지원하는가 — 2단계 «디자인» 섹션 노출 분기.
    let supportsDesignBootstrap: Bool
    /// daemon 이 수집 «전문가 관점» 렌즈(po_collect_lens_v1)를 지원하는가 — «전문가 관점» 픽커 노출 분기.
    /// 미지원(옛 daemon)이면 픽커를 숨기고 전방위 수집으로 동작한다(리서치 렌즈 게이팅과 동형).
    let supportsCollectLens: Bool
    /// 에이전트 후보 (po_agent_v1) — 비어 있으면 픽커를 숨기고 daemon 기본으로 돈다.
    let agents: [AgentInfo]
    /// (repoPath, instruction?, agent?, lens?) — instruction/lens 는 비우면 nil. 프로필 저장은 2단계가 처리.
    let onPick: (String, String?, String?, String?) -> Void

    @State private var recents: [RecentProject] = []
    @State private var customPath = ""

    private var api: ApiClient { ApiClient(auth: auth, conn: conn, tracker: inflight) }

    var body: some View {
        NavigationStack {
            List {
                if !recents.isEmpty {
                    Section("최근 프로젝트") {
                        ForEach(recents) { project in
                            NavigationLink(value: project.path) {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(verbatim: (project.path as NSString).lastPathComponent)
                                        .font(.callout.weight(.medium))
                                    Text(verbatim: project.path)
                                        .font(.caption2)
                                        .foregroundStyle(.secondary)
                                        .lineLimit(1)
                                }
                            }
                        }
                    }
                }
                Section("직접 입력") {
                    TextField("/path/to/repo", text: $customPath)
                        .font(.callout.monospaced())
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                    NavigationLink(value: customPath.trimmingCharacters(in: .whitespacesAndNewlines)) {
                        Text("다음")
                    }
                    .disabled(customPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .navigationTitle("수집할 레포")
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(for: String.self) { repoPath in
                CollectProfileForm(
                    repoPath: repoPath, supportsSchedule: supportsSchedule,
                    supportsAsc: supportsAsc, supportsFeedbackRepo: supportsFeedbackRepo,
                    supportsDesignBootstrap: supportsDesignBootstrap,
                    supportsCollectLens: supportsCollectLens, agents: agents, onStart: onPick)
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    // 해제 버튼은 강조색이 아니라 중립(primary) — color 정책.
                    Button("닫기") { dismiss() }
                        .tint(.primary)
                }
            }
            .task {
                recents = (try? await api.recentProjects(label: nil)) ?? []
            }
        }
    }
}

/// «지금 수집» 2단계 «빠른 수집» 면 — 사용자가 가장 먼저 하려는 «전문가 고르고 → 시키기» 만
/// 노출한다: 전문가 관점(일회성) + 이번 지시(일회성) + 에이전트(일회성) + 수집 시작. 이 레포에
/// 영속되는 조사 설정(조사 방식·주기·스토어 리뷰·피드백 repo·디자인 규칙)은 «이 레포 조사 설정»
/// (CollectRepoSettingsView)으로 내려 디스클로저로 점진 노출한다. 빠른 경로는 daemon capability
/// 가 없어도(옛 daemon) 그대로 동작한다 — 영속 설정 저장은 설정 면이 전담한다.
private struct CollectProfileForm: View {
    let repoPath: String
    let supportsSchedule: Bool
    let supportsAsc: Bool
    let supportsFeedbackRepo: Bool
    let supportsDesignBootstrap: Bool
    let supportsCollectLens: Bool
    let agents: [AgentInfo]
    let onStart: (String, String?, String?, String?) -> Void

    @State private var agentId = AgentInfo.claudeCodeFallback.id
    /// 전문가 관점 (po_collect_lens_v1) — "default" 전방위 / "design" UI 디자인 부채 발굴 / "bug"
    /// 디버깅·신뢰성 신호 우선. 리서치 픽커와 «같은 명칭·같은 카탈로그 키»(전문가 관점)를 써 사용자가
    /// 하나의 전문가 개념으로 인지한다. 이번 수집에만 적용되는 일회성 선택이라 프로필에 저장하지 않는다
    /// (에이전트 픽커와 동형 — 주기 수집의 고정 렌즈는 «이 레포 조사 설정» 에서 따로 정한다).
    @State private var lens = "default"
    @State private var instruction = ""
    @State private var starting = false

    var body: some View {
        List {
            if supportsCollectLens {
                Section {
                    // 기본 컨트롤 — 색 안 정함 → AccentColor(보라) 자동. 콘텐츠에 .tint() 안 건다.
                    Picker(selection: $lens) {
                        ForEach(poCollectLenses, id: \.self) { id in
                            Text(poResearchLensName(id)).tag(id)
                        }
                    } label: {
                        Text("전문가 관점")
                    }
                    .pickerStyle(.inline)
                    .labelsHidden()
                    .accessibilityLabel(Text("전문가 관점"))
                } header: {
                    Text("전문가 관점")
                } footer: {
                    Text("수집을 맡길 전문가 관점을 골라요. «디자인» 은 코드 기능 대신 이 레포 UI 의 디자인 부채(접근성·대비·토큰 드리프트·패턴 불일치)를, «디버깅» 은 크래시·실패 로그·재현 버그·회귀 같은 신뢰성 신호를 우선 모아 증거와 함께 브리프로 올려요. 이번 수집에만 적용돼요.")
                }
            }
            Section {
                // 긴 자연어 지시라 키보드 마찰이 큰 자리 — 받아쓰기(온디바이스 Whisper) 마이크를 붙인다.
                VoiceInputField(
                    "예: 온보딩 개선 아이디어 위주로 / 다크모드 지원을 브리프로 정리해줘",
                    text: $instruction,
                    lineLimit: 2...5,
                )
            } header: {
                Text("이번 지시 (선택)")
            } footer: {
                Text("이번 수집에만 적용돼요. 조사 방식보다 우선해요.")
            }
            if !agents.isEmpty {
                PoAgentSection(agents: agents, selection: $agentId) {
                    // 주기 수집(매일 자동)은 daemon 이 기본 에이전트로 돌므로 범위를 명시한다.
                    Text("이번 수집에만 적용돼요.")
                }
            }
            // 영속 «이 레포 조사 설정» 은 디스클로저로 내려 점진 노출 — 처음엔 접힘. 진입 컨트롤은
            // accent(보라) gear 아이콘. repoPath String 목적지(navigationDestination)와 겹치지 않게
            // 값이 아닌 «클로저형» NavigationLink 로 push 한다.
            Section {
                NavigationLink {
                    CollectRepoSettingsView(
                        repoPath: repoPath, supportsSchedule: supportsSchedule,
                        supportsAsc: supportsAsc, supportsFeedbackRepo: supportsFeedbackRepo,
                        supportsDesignBootstrap: supportsDesignBootstrap,
                        supportsCollectLens: supportsCollectLens)
                } label: {
                    Label {
                        Text("이 레포 조사 설정")
                    } icon: {
                        Image(systemName: "gearshape")
                            .foregroundStyle(Theme.accent)
                    }
                }
                .accessibilityLabel(Text("이 레포 조사 설정 열기"))
            } footer: {
                Text("조사 방식·주기·스토어 리뷰·피드백 repo·디자인 규칙을 정해요. 프로젝트에 저장돼 매 수집에 재사용돼요.")
            }
            Section {
                Button {
                    start()
                } label: {
                    if starting {
                        ProgressView().frame(maxWidth: .infinity)
                    } else {
                        Text("수집 시작").frame(maxWidth: .infinity)
                    }
                }
                .disabled(starting)
            }
        }
        .navigationTitle(Text(verbatim: (repoPath as NSString).lastPathComponent))
        .navigationBarTitleDisplayMode(.inline)
        // 이번 지시 입력란의 마이크 받아쓰기 공통 크롬.
        .voiceDictationChrome()
    }

    private func start() {
        starting = true
        let inst = instruction.trimmingCharacters(in: .whitespacesAndNewlines)
        // 전문가 관점은 daemon 이 지원할 때(supportsCollectLens) «design»/«bug» 선택만 보낸다 —
        // 기본(전방위)/미지원이면 nil 로 필드를 생략해 옛 daemon 동작과 같다 (전방위 수집). route 는
        // 회차 lens 를 항상 explicit 로 다뤄 수동 수집이 픽커가 보여주는 대로 돈다(거짓 UI 방지).
        let chosenLens = (supportsCollectLens && lens != "default") ? lens : nil
        onStart(repoPath, inst.isEmpty ? nil : inst, agents.isEmpty ? nil : agentId, chosenLens)
    }
}

/// «이 레포 조사 설정» — 빠른 수집에서 디스클로저로 내려온 영속 면. 이 레포의 «조사 방식»(프로필),
/// 주기 수집, 스토어 리뷰, GitHub 피드백 repo, 디자인 규칙(디자인 directive 부트스트랩)을 정한다.
/// 모두 프로젝트 자산으로 저장돼 매 수집에 재사용된다 — 1회성 의도(이번 지시·관점·에이전트)와 분리된다.
/// 주기 수집(«매일 아침 수집» 프리셋)도 여기서 켠다 — daemon 이 매일 그 시각에 같은 수집을 자동으로
/// 돈다 (po_schedule_v1 daemon 에서만 노출).
private struct CollectRepoSettingsView: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var conn: ConnectionManager
    @EnvironmentObject var inflight: InFlightTracker

    let repoPath: String
    let supportsSchedule: Bool
    let supportsAsc: Bool
    let supportsFeedbackRepo: Bool
    let supportsDesignBootstrap: Bool
    /// daemon 이 수집 «전문가 관점» 렌즈(po_collect_lens_v1)를 지원하는가 — 주기 수집의 고정 렌즈
    /// 픽커 노출 분기. 미지원이면 픽커를 숨기고 전방위로 동작한다.
    let supportsCollectLens: Bool

    @State private var profile = ""
    @State private var profileLoaded = false
    /// 프로필 로드 실패 — 느린/끊긴 연결에서 «죽은 화면» 대신 오류 + 재시도 경로를 띄운다.
    @State private var loadFailed = false
    @State private var savedProfile = ""
    @State private var savedSchedule: String?
    @State private var scheduleEnabled = false
    /// 주기 수집 «전문가 관점» 렌즈 (po_collect_lens_v1) — 주기 수집(scheduler)이 매일 어느 초점으로
    /// 신호를 모을지 «고정»해 두는 영속 설정. 수동 수집의 일회성 렌즈(빠른 수집 폼)와 분리된다 —
    /// 회차 선택이 이 값보다 우선(instruction↔directive 와 동형). 프로필에 저장돼 매 주기 수집에 재사용.
    @State private var lens = "default"
    @State private var savedLens = "default"
    /// 주기 수집 시각 — 기본 09:00 («매일 아침 수집» 프리셋). 시각만 의미 (날짜 무시).
    @State private var scheduleTime = Calendar.current.date(
        bySettingHour: 9, minute: 0, second: 0, of: Date()) ?? Date()
    /// 스토어 리뷰 신호 — 켜면 수집 시 이 앱의 최근 App Store 리뷰를 함께 읽는다.
    @State private var savedAscAppId: String?
    @State private var ascEnabled = false
    @State private var ascAppId = ""
    /// Mac 에 ASC API 키가 등록돼 있는가 — 미등록이면 footer 로 Mac 설정 안내.
    @State private var ascKeyConfigured = true
    /// GitHub «피드백 repo» (owner/name) — 사용자 피드백이 모이는 공개 repo. 비면 로컬 origin.
    @State private var savedFeedbackRepo: String?
    @State private var feedbackRepo = ""
    // 디자인 부트스트랩 (po_design_bootstrap_v1) — 에이전트가 디자인 SSOT 를 스캔해 directive 초안을
    // 만들고, 사람이 여기서 검토·승인해야 design_directive(강신호)가 된다. designDirective = 승인된
    // 선언, designDraft = 검토 대기 초안(편집 가능), generatingSession = non-nil 이면 «생성 중».
    @State private var designDirective: String?
    @State private var designDraft: String?
    @State private var designDraftEdit = ""
    @State private var designGeneratingSession: String?
    @State private var designBusy = false

    private var api: ApiClient { ApiClient(auth: auth, conn: conn, tracker: inflight) }

    var body: some View {
        List {
            // 수집이 무엇을 하는지 한 줄로 — 첫 사용자가 «조사 방식» 자유서술 앞에서 멘탈 모델을
            // 잡게 한다. 장식 안내라 status/pro 색을 빌리지 않고 중립 secondary.
            Section {
                HStack(alignment: .top, spacing: Theme.Spacing.m) {
                    Image(systemName: "tray.and.arrow.down")
                        .foregroundStyle(.secondary)
                    Text("수집은 이 레포의 코드·이슈·스토어 리뷰를 훑어 백로그 후보를 제안해요. 무엇을 어떻게 살필지 아래에서 정해 두면 매 수집에 재사용돼요.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .accessibilityElement(children: .combine)
            }
            if loadFailed {
                loadFailedSection
            } else if !profileLoaded {
                loadingSection
            } else {
                formSections
            }
        }
        .navigationTitle("이 레포 조사 설정")
        .navigationBarTitleDisplayMode(.inline)
        // 조사 방식 입력란의 마이크 받아쓰기 공통 크롬.
        .voiceDictationChrome()
        .task { await loadProfile() }
        // 초안 «생성 중» 이면 끝날 때까지 폴링 — generatingSession 이 바뀌면(시작/완료) 재실행/취소.
        // 화면을 떠나면 .task(id:) 가 자동 취소한다.
        .task(id: designGeneratingSession) { await pollDesignIfGenerating() }
        // 주기 수집/스토어 리뷰 토글 변경은 즉시 저장 — «수집 시작» 없이도 켜고 닫을 수 있다.
        .onChange(of: scheduleEnabled) { _ in Task { await saveSideSettingsIfChanged() } }
        .onChange(of: scheduleTime) { _ in Task { await saveSideSettingsIfChanged() } }
        .onChange(of: ascEnabled) { _ in Task { await saveSideSettingsIfChanged() } }
        // 주기 수집 렌즈는 인라인 픽커라 선택 즉시 저장한다 (토글과 동형).
        .onChange(of: lens) { _ in Task { await saveSideSettingsIfChanged() } }
        // 앱 ID 는 타이핑 중 저장하지 않고 입력 종료(키보드 내림/시작)에 맡긴다.
        .onSubmit { Task { await saveSideSettingsIfChanged() } }
        // 조사 방식 텍스트 편집은 빠른 수집 start() 가 더는 저장하지 않으므로, 설정 면을 떠날 때 flush.
        .onDisappear { Task { await saveSideSettingsIfChanged() } }
    }

    // MARK: - 폼 본문 / 로딩·실패 상태

    /// 저장된 조사 설정을 로드 — 처음이면 빈 채로 시작. 실패하면(느린/끊긴 연결) loadFailed 로 올려
    /// 오류 + 재시도 경로를 띄운다. 재시도 버튼이 다시 이 함수를 호출한다.
    private func loadProfile() async {
        loadFailed = false
        do {
            let loaded = try await api.getPoProfile(repoPath: repoPath)
            savedProfile = loaded.directive
            savedSchedule = loaded.schedule
            profile = savedProfile
            if let cron = savedSchedule, let time = Self.timeFromCron(cron) {
                scheduleEnabled = true
                scheduleTime = time
            }
            savedAscAppId = loaded.ascAppId
            if let saved = savedAscAppId, !saved.isEmpty {
                ascEnabled = true
                ascAppId = saved
            }
            ascKeyConfigured = loaded.ascKeyConfigured ?? true
            savedFeedbackRepo = loaded.githubFeedbackRepo
            feedbackRepo = savedFeedbackRepo ?? ""
            // 주기 수집 렌즈 — 옛 daemon 응답엔 키가 없어 nil → "default" (전방위).
            savedLens = loaded.lens ?? "default"
            lens = savedLens
            applyDesignState(loaded)
            profileLoaded = true
        } catch {
            loadFailed = true
        }
    }

    /// 프로필 로드 중 — 입력이 비활성인 «이유» 를 드러내는 폼 수준 스켈레톤. 자리 표시자 박스는
    /// VoiceOver 가 읽지 않게 숨기고, progress 행이 로딩 상태를 안내한다.
    @ViewBuilder private var loadingSection: some View {
        Section {
            VStack(alignment: .leading, spacing: Theme.Spacing.l) {
                ForEach([220, 280, 180], id: \.self) { width in
                    RoundedRectangle(cornerRadius: Theme.Radius.xs)
                        .fill(Color.secondary.opacity(0.15))
                        .frame(width: CGFloat(width), height: 13)
                }
            }
            .padding(.vertical, Theme.Spacing.xs)
            .accessibilityHidden(true)
            HStack(spacing: Theme.Spacing.m) {
                ProgressView().controlSize(.small)
                Text("조사 설정을 불러오는 중…")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel(Text("조사 설정을 불러오는 중"))
        } header: {
            Text("조사 방식")
        }
    }

    /// 프로필 로드 실패 — 빈/오류 상태. placeholder 아이콘 + 오류 문구 + 재시도 버튼.
    @ViewBuilder private var loadFailedSection: some View {
        Section {
            VStack(spacing: Theme.Spacing.l) {
                Image(systemName: "wifi.exclamationmark")
                    .font(.system(size: Theme.IconSize.l))
                    .foregroundStyle(.secondary)
                Text("조사 설정을 불러오지 못했어요")
                    .font(.headline)
                Text("Mac 연결을 확인하고 다시 시도하세요.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                Button {
                    Task { await loadProfile() }
                } label: {
                    Label("다시 시도", systemImage: "arrow.clockwise")
                }
                .accessibilityLabel(Text("조사 설정 다시 불러오기"))
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, Theme.Spacing.xxl)
        }
    }

    /// 로드 완료 후의 실제 설정 폼 — 조사 방식·주기 수집·스토어 리뷰·피드백 repo·디자인.
    @ViewBuilder private var formSections: some View {
        Section {
            VoiceInputField(
                "예: 사용자 이슈·크래시 신호 위주로, UI 제안은 제외",
                text: $profile,
                lineLimit: 3...8,
            )
        } header: {
            Text("조사 방식")
        } footer: {
            Text("프로젝트에 저장돼 매 수집에 재사용돼요. 무엇을 어떻게 조사할지 적어두세요.")
        }
        if supportsSchedule {
            Section {
                Toggle("매일 자동 수집", isOn: $scheduleEnabled)
                if scheduleEnabled {
                    DatePicker(
                        "시각",
                        selection: $scheduleTime,
                        displayedComponents: .hourAndMinute,
                    )
                }
            } header: {
                Text("주기 수집")
            } footer: {
                Text("켜 두면 매일 이 시각에 에이전트가 신호를 수집해 새 브리프를 올려요 (Mac 시간대 기준). 결과는 알림으로 와요.")
            }
        }
        if supportsCollectLens {
            Section {
                // 기본 컨트롤 — 색 안 정함 → AccentColor(보라) 자동. 콘텐츠에 .tint() 안 건다.
                Picker(selection: $lens) {
                    ForEach(poCollectLenses, id: \.self) { id in
                        Text(poResearchLensName(id)).tag(id)
                    }
                } label: {
                    Text("전문가 관점")
                }
                .pickerStyle(.inline)
                .labelsHidden()
                .accessibilityLabel(Text("전문가 관점"))
            } header: {
                Text("전문가 관점")
            } footer: {
                Text("주기 수집이 매일 어느 관점으로 신호를 모을지 정해요. «디자인» 은 UI 디자인 부채를, «디버깅» 은 크래시·신뢰성 신호를 우선 모아요. 프로젝트에 저장돼요 — 수동 수집은 시작할 때 따로 고른 관점이 우선해요.")
            }
        }
        if supportsAsc {
            Section {
                Toggle("App Store 리뷰 포함", isOn: $ascEnabled)
                if ascEnabled {
                    TextField("앱 ID 또는 번들 ID", text: $ascAppId)
                        .font(.callout.monospaced())
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                }
            } header: {
                Text("스토어 리뷰")
            } footer: {
                if ascEnabled && !ascKeyConfigured {
                    Text("Mac 설정 → App Store 탭에서 ASC API 키를 먼저 등록하세요. 키가 없으면 리뷰 없이 수집돼요.")
                } else {
                    Text("켜 두면 수집할 때 이 앱의 최근 App Store 리뷰를 함께 읽어 사용자 불만·요청을 브리프 근거로 가져와요.")
                }
            }
        }
        if supportsFeedbackRepo {
            Section {
                TextField("owner/name (예: Wayne-Kim/pocket-sisyphus-mac)", text: $feedbackRepo)
                    .font(.callout.monospaced())
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                if let warn = feedbackRepoFormatWarning {
                    // 형식 오류 inline 검증 — warning(노랑)이 맞는 자리 (진짜 «설정 필요»).
                    Label(warn, systemImage: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(Theme.warning)
                }
            } header: {
                Text("GitHub 피드백 repo")
            } footer: {
                Text("비워 두면 이 레포의 GitHub origin 을 읽어요. 사용자 이슈·Discussions 가 다른 공개 repo 에 모인다면 그 repo 를 owner/name 으로 적으세요 — 다음 수집부터 거기서 피드백을 읽어요. (코드·커밋 신호는 늘 이 레포 기준이에요.)")
            }
        }
        if supportsDesignBootstrap {
            designSection
        }
    }

    // MARK: - 디자인 부트스트랩 (po_design_bootstrap_v1)

    /// 「디자인」 섹션 — design_directive 가 NULL 이면 수집/리서치/워크플로우가 매번 디자인 규칙을
    /// 새로 탐색하는 «약한 신호» 로 떨어진다. 손으로 규칙을 쓰는 건 채택 장벽이라, 에이전트가 레포
    /// 디자인 SSOT 를 읽어 초안을 제안하고 사람이 «승인 한 번» 으로 «선언된 강신호» 를 켠다.
    @ViewBuilder private var designSection: some View {
        Section {
            if designGeneratingSession != nil {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("디자인 규칙을 읽는 중…")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
            } else if designDraft != nil {
                Text("검토 대기 초안")
                    .font(.callout.weight(.semibold))
                // 초안 본문은 에이전트 산출(레포 고유 규칙)이라 번역 대상 아님 — verbatim 편집.
                TextEditor(text: $designDraftEdit)
                    .font(.caption.monospaced())
                    .frame(minHeight: 170)
                    .scrollContentBackground(.hidden)
                    .padding(8)
                    .background(Color.secondary.opacity(0.08))
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                    .disabled(designBusy)
                HStack {
                    Button {
                        Task { await approveDesign() }
                    } label: {
                        Label("승인하고 켜기", systemImage: "checkmark.circle")
                    }
                    .disabled(
                        designBusy
                            || designDraftEdit.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    Spacer()
                    // 버리기는 해제 동작 — 강조색 아닌 중립(primary). 선언(design_directive)은 안 건드림.
                    Button(role: .destructive) {
                        Task { await discardDesignDraft() }
                    } label: {
                        Text("버리기")
                    }
                    .tint(.primary)
                    .disabled(designBusy)
                }
            } else if let declared = designDirective {
                HStack(spacing: 6) {
                    Image(systemName: "checkmark.seal.fill")
                        .foregroundStyle(Theme.success)
                    Text("디자인 규칙이 선언됐어요")
                        .font(.callout.weight(.semibold))
                }
                Text(verbatim: declared)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(6)
                Button {
                    Task { await generateDesignDraft() }
                } label: {
                    if designBusy {
                        ProgressView().controlSize(.small)
                    } else {
                        Label("초안 다시 만들기", systemImage: "arrow.clockwise")
                    }
                }
                .disabled(designBusy)
            } else {
                Button {
                    Task { await generateDesignDraft() }
                } label: {
                    if designBusy {
                        ProgressView().frame(maxWidth: .infinity)
                    } else {
                        Label("디자인 초안 만들기", systemImage: "wand.and.stars")
                            .frame(maxWidth: .infinity)
                    }
                }
                .disabled(designBusy)
            }
        } header: {
            Text("디자인")
        } footer: {
            designFooter
        }
    }

    @ViewBuilder private var designFooter: some View {
        if designGeneratingSession != nil {
            Text("에이전트가 이 레포의 색·간격·금지 패턴·지원 언어를 읽어 초안을 만들고 있어요. 세션 탭에서 과정을 볼 수 있어요.")
        } else if designDraft != nil {
            Text("에이전트가 만든 초안이에요. 검토하고 필요하면 고친 뒤 «승인» 하면, 이후 수집·리서치·워크플로우가 이 규칙을 강한 신호로 따라요. 승인 전엔 적용되지 않아요.")
        } else if designDirective != nil {
            Text("승인된 디자인 규칙을 강한 신호로 쓰고 있어요. 규칙이 바뀌었으면 초안을 다시 만들어 갱신하세요.")
        } else {
            Text("손으로 규칙을 쓰지 않아도 돼요 — 에이전트가 이 레포의 디자인 토큰·i18n 카탈로그·디자인 문서를 읽어 규칙 초안을 제안해요. 승인하면 수집·리서치가 따르는 «강한 신호» 가 켜져요 (승인 전엔 적용 안 됨).")
        }
    }

    /// 로드/폴링 결과를 디자인 상태에 반영 — 새 초안이 오면 편집 버퍼도 초기화.
    private func applyDesignState(_ p: PoProfile) {
        designDirective = p.designDirective
        designGeneratingSession = p.designDirectiveDraftSessionId
        if p.designDirectiveDraft != designDraft {
            designDraft = p.designDirectiveDraft
            designDraftEdit = p.designDirectiveDraft ?? ""
        }
    }

    /// «생성 중» 이면 끝날 때까지 ~2s 폴링 — 초안이 도착하면 화면이 검토 UI 로 전환된다.
    private func pollDesignIfGenerating() async {
        guard designGeneratingSession != nil else { return }
        while !Task.isCancelled, designGeneratingSession != nil {
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            if Task.isCancelled { return }
            guard let loaded = try? await api.getPoProfile(repoPath: repoPath, label: nil) else {
                continue
            }
            applyDesignState(loaded)
        }
    }

    private func generateDesignDraft() async {
        designBusy = true
        defer { designBusy = false }
        // 시작 시 generatingSession 이 채워지면 .task(id:) 가 폴링을 건다.
        if let sid = try? await api.startPoDesignBootstrap(repoPath: repoPath) {
            designDraft = nil
            designGeneratingSession = sid
        }
    }

    private func approveDesign() async {
        let edited = designDraftEdit.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !edited.isEmpty else { return }
        designBusy = true
        defer { designBusy = false }
        if (try? await api.approvePoDesignDirective(repoPath: repoPath, directive: edited)) != nil {
            designDirective = edited
            designDraft = nil
            designDraftEdit = ""
        }
    }

    private func discardDesignDraft() async {
        designBusy = true
        defer { designBusy = false }
        if (try? await api.discardPoDesignDraft(repoPath: repoPath)) != nil {
            designDraft = nil
            designDraftEdit = ""
        }
    }

    /// 현재 토글/입력 → 저장할 ascAppId (꺼짐 또는 빈 입력이면 nil).
    private var ascValue: String? {
        guard ascEnabled else { return nil }
        let trimmed = ascAppId.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    /// 현재 입력 → 저장할 피드백 repo (빈 입력이면 nil = 로컬 origin).
    private var feedbackRepoValue: String? {
        let trimmed = feedbackRepo.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    /// owner/name 형식인가 — 슬래시 정확히 하나, 각 세그먼트는 GitHub 허용 문자만. daemon
    /// parseFeedbackRepo 와 같은 규칙 (저장 전 inline 검증으로 400 왕복을 줄인다).
    private var feedbackRepoFormatValid: Bool {
        guard let v = feedbackRepoValue else { return true }  // 빈 값 = 유효(로컬 origin)
        return v.range(of: "^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$", options: .regularExpression) != nil
    }

    /// 형식 오류 안내 문구 (유효하거나 비었으면 nil → 표시 안 함).
    private var feedbackRepoFormatWarning: LocalizedStringKey? {
        feedbackRepoFormatValid ? nil : "owner/name 형식으로 적어주세요 (예: Wayne-Kim/pocket-sisyphus-mac)"
    }

    /// 현재 토글/시각 → 5필드 cron 식 ("분 시 * * *"). 꺼짐이면 nil.
    private var scheduleCron: String? {
        guard scheduleEnabled else { return nil }
        let c = Calendar.current.dateComponents([.hour, .minute], from: scheduleTime)
        return "\(c.minute ?? 0) \(c.hour ?? 9) * * *"
    }

    /// «매일 HH:mm» 형태("m h * * *")의 cron 식 → 오늘 그 시각 Date. 다른 형태는 nil
    /// (수동으로 더 복잡한 식을 넣었다면 토글 UI 로는 표현 못 함 — 끔으로 보이게 둔다).
    private static func timeFromCron(_ cron: String) -> Date? {
        let parts = cron.split(separator: " ")
        guard parts.count == 5, parts[2] == "*", parts[3] == "*", parts[4] == "*",
              let minute = Int(parts[0]), let hour = Int(parts[1]) else { return nil }
        return Calendar.current.date(bySettingHour: hour, minute: minute, second: 0, of: Date())
    }

    /// 토글/시각/앱 ID/피드백 repo/조사 방식 텍스트가 저장값과 다르면 PUT — 조사 방식 텍스트도
    /// 함께 저장된다(빠른 수집 start() 가 더는 프로필을 저장하지 않으므로 이 면이 전담). 피드백 repo
    /// 형식이 잘못됐으면 저장하지 않는다 (inline 경고만 — 400 왕복 방지).
    private func saveSideSettingsIfChanged() async {
        guard profileLoaded else { return }
        let cron = scheduleCron
        let asc = ascValue
        let fb = feedbackRepoValue
        let trimmed = profile.trimmingCharacters(in: .whitespacesAndNewlines)
        guard cron != savedSchedule || asc != savedAscAppId || fb != savedFeedbackRepo
            || trimmed != savedProfile || lens != savedLens else { return }
        guard feedbackRepoFormatValid else { return }
        if (try? await api.setPoProfile(
            repoPath: repoPath, directive: trimmed, schedule: cron, ascAppId: asc,
            githubFeedbackRepo: fb, lens: lens)) != nil {
            savedSchedule = cron
            savedAscAppId = asc
            savedFeedbackRepo = fb
            savedProfile = trimmed
            savedLens = lens
        }
    }
}

// MARK: - gh 안내 (po_gh_check_v1)

/// 수집 직후 «GitHub 신호 없이 수집됨» 안내 (po_gh_check_v1). welcome.md 가 모든 사용자
/// 피드백을 GitHub Discussions 로 모으므로, gh 가 없으면 «가장 풍부한 사용자 목소리» 가 PO
/// 루프에 안 들어온다 — 사용자가 모른 채 «제안이 영 별로» 라고 오해하지 않게 표면화한다.
/// 경고가 «아니라» 안내 톤 — 중립/secondary 색(warning 노랑 금지), 명령은 코드라 Text(verbatim:).
/// gh 가 정상이면 호출처가 이 뷰를 아예 안 띄운다 (정상 케이스 잡음 금지).
private struct CollectGhNoticeRow: View {
    let gh: GhCollectCheck
    /// 어느 프로젝트의 수집이었는지 — repoPath 의 디렉토리명. «전체» 필터에서 모호함을 없앤다.
    let repoName: String?
    let onDismiss: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 8) {
                // info.circle — 안내 톤. warning 삼각형 아님. 색도 중립 secondary.
                Image(systemName: "info.circle")
                    .foregroundStyle(.secondary)
                VStack(alignment: .leading, spacing: 4) {
                    Text("GitHub 신호 없이 수집됐어요")
                        .font(.callout.weight(.semibold))
                    // 어느 프로젝트의 수집이었는지 — 레포명은 식별자라 verbatim(번역 대상 아님).
                    // folder 아이콘은 프로젝트 picker(Label("프로젝트", "folder"))와 같은 관례.
                    if let repoName {
                        HStack(spacing: 4) {
                            Image(systemName: "folder")
                            Text(verbatim: repoName)
                        }
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    }
                    // ternary 가 아니라 분기된 Text — 각 한국어 리터럴이 카탈로그 추출 경로를 탄다.
                    // 세 갈래: ① 피드백 repo 접근 불가(설치·인증은 정상) ② 미인증 ③ 미설치.
                    Group {
                        if gh.feedbackRepoUnreadable {
                            // 거짓 «설정 필요» 가 아니라 «접근 불가» 안내 — gh 자체는 정상.
                            Text("설정한 GitHub 피드백 repo 를 못 읽었어요. private repo 라면 권한 있는 계정으로 로그인했는지, repo 이름(owner/name)이 맞는지 확인하세요.")
                        } else if gh.installedButUnauthed {
                            Text("이 Mac 의 GitHub CLI(gh)가 로그인돼 있지 않아 이슈·Discussions 를 못 읽었어요. Mac 터미널에서 아래를 실행하면 다음 수집부터 더 좋은 브리프를 받아요.")
                        } else {
                            Text("이 Mac 에 GitHub CLI(gh)가 없어 이슈·Discussions 를 못 읽었어요. Mac 터미널에서 아래를 실행하면 다음 수집부터 더 좋은 브리프를 받아요.")
                        }
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
                Button {
                    onDismiss()
                } label: {
                    Image(systemName: "xmark")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text("안내 닫기"))
            }
            // 명령 — 접근 불가(gh 정상)면 그 repo 를 직접 확인하는 명령, 미설치면 설치 + 로그인,
            // 설치됐는데 미인증이면 로그인만 (엣지 구분 안내). repo 명령은 식별자라 verbatim.
            if gh.feedbackRepoUnreadable {
                if let repo = gh.feedbackRepo {
                    CopyableCommandRow(command: "gh repo view \(repo)")
                }
            } else {
                if !gh.installed {
                    CopyableCommandRow(command: "brew install gh")
                }
                CopyableCommandRow(command: "gh auth login")
            }
        }
        .padding(.vertical, 4)
    }
}

// MARK: - asc 안내 (po_asc_check_v1)

/// 수집 직후 «App Store 신호 없이 수집됨» 안내 (po_asc_check_v1). 리뷰(po_asc_v1)·크래시
/// (po_crash_v1)는 같은 ASC 키를 공유하므로, 키가 «저장 후» 만료·폐기되면 둘 다 0이 되는데
/// executor 가 섹션을 조용히 생략해 사용자가 모른다 — gh 와 똑같이 표면화한다. gh 와 달리 수정은
/// 터미널 명령이 아니라 Mac 앱 설정(App Store 탭)이라 복사 명령 없이 안내 문구만 둔다.
/// 경고가 «아니라» 안내 톤 — 중립/secondary 색(warning 노랑 금지). 정상/꺼짐이면 호출처가 안 띄움.
private struct CollectAscNoticeRow: View {
    let asc: AscCollectCheck
    /// 어느 프로젝트의 수집이었는지 — repoPath 의 디렉토리명. «전체» 필터에서 모호함을 없앤다.
    let repoName: String?
    let onDismiss: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            // info.circle — 안내 톤. warning 삼각형 아님. 색도 중립 secondary.
            Image(systemName: "info.circle")
                .foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 4) {
                Text("App Store 신호 없이 수집됐어요")
                    .font(.callout.weight(.semibold))
                // 어느 프로젝트의 수집이었는지 — 레포명은 식별자라 verbatim(번역 대상 아님).
                // folder 아이콘은 프로젝트 picker(Label("프로젝트", "folder"))와 같은 관례.
                if let repoName {
                    HStack(spacing: 4) {
                        Image(systemName: "folder")
                        Text(verbatim: repoName)
                    }
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                }
                // ternary 가 아니라 분기된 Text — 각 한국어 리터럴이 카탈로그 추출 경로를 탄다.
                // 두 갈래: ① 키 미설정(등록 유도) ② 키 만료·폐기·권한(키 재확인 유도).
                Group {
                    if asc.keyMissing {
                        Text("Mac 에 App Store Connect API 키가 없어 리뷰·크래시 신호를 못 읽었어요. Mac 앱 설정의 App Store 탭에서 키를 등록하면 다음 수집부터 더 좋은 브리프를 받아요.")
                    } else {
                        Text("App Store Connect API 키가 만료·폐기됐거나 권한이 부족해 리뷰·크래시 신호를 못 읽었어요. Mac 앱 설정의 App Store 탭에서 키를 다시 확인하세요.")
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
            Button {
                onDismiss()
            } label: {
                Image(systemName: "xmark")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Text("안내 닫기"))
        }
        .padding(.vertical, 4)
    }
}

// MARK: - 수집 결과 카드 (po_signal_status_v1)

/// 수집 «1회» 가 끝난 뒤, 켠 App Store 신호(스토어 리뷰 + 크래시)가 실제로 반영됐는지(used N)·
/// 정상 빈(empty)·키/네트워크로 빠졌는지(실패)를 신호원별로 보여 준다. asc-check 의 «수집 직전
/// 프로브» 안내(CollectAscNoticeRow)와 달리 이건 실행 결과라 used·app id·네트워크까지 구분한다.
/// 색 정책: «실패/설정 필요» 만 warning(노랑), 정상(used/empty)은 중립 .secondary — status 색을
/// 장식으로 빌려쓰지 않는다. 신호 안 켰으면 호출처가 아예 안 띄운다(잡음 금지).
private struct CollectSignalsCard: View {
    let signals: CollectSignals
    /// 어느 프로젝트의 수집이었는지 — repoPath 의 디렉토리명. «전체» 필터에서 모호함을 없앤다.
    let repoName: String?
    let onDismiss: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            // 실패가 하나라도 있으면 warning 삼각형(노랑), 아니면 중립 체크(.secondary).
            Image(systemName: signals.hasFailure ? "exclamationmark.triangle" : "checkmark.circle")
                .foregroundStyle(signals.hasFailure ? Theme.warning : Color.secondary)
            VStack(alignment: .leading, spacing: 4) {
                Text("수집 결과 · App Store 신호")
                    .font(.callout.weight(.semibold))
                // 레포명은 식별자라 verbatim(번역 대상 아님) — folder 아이콘은 프로젝트 picker 관례.
                if let repoName {
                    HStack(spacing: 4) {
                        Image(systemName: "folder")
                        Text(verbatim: repoName)
                    }
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                }
                // 신호원별 한 줄 — 둘은 독립(한쪽만 실패할 수 있다). off/unknown 은 «안 켬» 이라 생략.
                SignalSourceLine(label: storeLabel, source: signals.store)
                SignalSourceLine(label: crashLabel, source: signals.crash)
            }
            Spacer(minLength: 0)
            Button {
                onDismiss()
            } label: {
                Image(systemName: "xmark")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Text("안내 닫기"))
        }
        .padding(.vertical, 4)
    }

    private var storeLabel: LocalizedStringKey { "스토어 리뷰" }
    private var crashLabel: LocalizedStringKey { "크래시" }
}

/// 한 신호원의 결과 한 줄. used(N)/empty 는 중립(.secondary), 실패 4종은 warning(노랑) 텍스트.
/// off/unknown(안 켬/모름)은 빈 뷰 — 카드에서 행 자체가 안 보인다 (거짓 경고 금지).
private struct SignalSourceLine: View {
    let label: LocalizedStringKey
    let source: SignalSourceState

    var body: some View {
        switch source.state {
        case .off, .unknown:
            EmptyView()
        default:
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text(label)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.secondary)
                detail
                    .font(.caption)
                    .foregroundStyle(source.isFailure ? Theme.warning : Color.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel(accessibilityText)
        }
    }

    /// 상태별 사용자 문구 — ternary 가 아니라 분기된 Text 로 각 한국어 리터럴이 카탈로그 추출 경로를 탄다.
    private var detail: Text {
        switch source.state {
        case .used:
            // 보간 \(count) 자동 추출 (%lld). used 면 count 는 항상 채워진다.
            return Text("\(source.count ?? 0)건 반영됨")
        case .empty:
            return Text("새 데이터 없음")
        case .keyMissing:
            return Text("키 미설정 — Mac 설정에서 등록 필요")
        case .auth:
            return Text("키 만료·권한 오류 — Mac 설정에서 키 확인")
        case .appId:
            return Text("앱 ID 오류 — Mac 설정에서 앱 ID 확인")
        case .network:
            return Text("네트워크 오류 — 다음 수집에서 다시 시도")
        case .off, .unknown:
            return Text(verbatim: "")
        }
    }

    /// VoiceOver 용 — «신호원 + 상태» 를 한 문장으로. 실패는 «설정 필요» 뉘앙스가 detail 에 이미 담긴다.
    private var accessibilityText: Text {
        Text(label) + Text(verbatim: ", ") + detail
    }
}

private struct CopyableCommandRow: View {
    let command: String
    @State private var copied = false

    var body: some View {
        HStack(spacing: 8) {
            Text(verbatim: command)
                .font(.system(.caption2, design: .monospaced))
                .foregroundStyle(.primary)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button {
                copy()
            } label: {
                Image(systemName: copied ? "checkmark" : "doc.on.doc")
                    .font(.caption)
                    .foregroundStyle(copied ? Theme.success : Theme.accent)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(copied ? Text("클립보드에 복사됨") : Text("복사"))
        }
        .padding(8)
        .background(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(Color(.secondarySystemBackground))
        )
    }

    private func copy() {
        UIPasteboard.general.string = command
        withAnimation { copied = true }
        Task {
            try? await Task.sleep(nanoseconds: 1_800_000_000)
            withAnimation { copied = false }
        }
    }
}
