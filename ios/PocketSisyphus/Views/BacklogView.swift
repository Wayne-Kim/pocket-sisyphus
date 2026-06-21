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
    @State private var showCreateSheet = false
    /// 통합 «만들기» 시트가 처음 보일 경로 — 진입 버튼에 따라 수집/리서치 중 무엇을 권할지 정한다.
    @State private var createInitialSource: BriefSource = .collect
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
                // 통합 «만들기» — 레포를 고른 뒤 한 폼에서 «어디서 찾을까»(내 레포 안 수집 /
                // 시장 조사 리서치)를 토글로 고른다. 텍스트 라벨 유지 (아이콘만으로는 발견 불가
                // 피드백 — iOS 26 툴바 실측).
                Button {
                    createInitialSource = .collect
                    showCreateSheet = true
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
        .sheet(isPresented: $showCreateSheet) {
            CreateBriefSheet(
                supportsSchedule: capabilities.contains("po_schedule_v1"),
                supportsAsc: capabilities.contains("po_asc_v1"),
                supportsFeedbackRepo: capabilities.contains("po_feedback_repo_v1"),
                supportsDesignBootstrap: capabilities.contains("po_design_bootstrap_v1"),
                supportsCollectLens: capabilities.contains("po_collect_lens_v1"),
                supportsSecurityCollectLens: capabilities.contains("po_collect_lens_v2"),
                supportsAllExpertsCollectLens: capabilities.contains("po_collect_lens_v3"),
                supportsResearchLens: capabilities.contains("po_research_lens_v1"),
                supportsResearchQaLens: capabilities.contains("po_research_lens_v2"),
                supportsResearchSecurityLens: capabilities.contains("po_research_lens_v3"),
                supportsResearchPmLens: capabilities.contains("po_research_lens_v4"),
                supportsResearchMarketingLens: capabilities.contains("po_research_lens_v5"),
                supportsResearchAnalyticsLens: capabilities.contains("po_research_lens_v6"),
                supportsResearchOpsLens: capabilities.contains("po_research_lens_v7"),
                supportsResearchLogicLens: capabilities.contains("po_research_lens_v8"),
                supportsResearchUxLens: capabilities.contains("po_research_lens_v9"),
                supportsResearchReadabilityLens: capabilities.contains("po_research_lens_v10"),
                supportsResearchScope: supportsResearchScope,
                supportsResearchUxScreens: capabilities.contains("po_research_ux_screens_v1"),
                agents: supportsAgentChoice ? agents : [],
                initialSource: createInitialSource,
                onStartCollect: { repoPath, instruction, agent, lens in
                    showCreateSheet = false
                    Task {
                        await startCollect(
                            repoPath: repoPath, instruction: instruction, agent: agent, lens: lens)
                    }
                },
                onStartResearch: { repoPath, topic, agent, lens, scope, screens in
                    showCreateSheet = false
                    Task {
                        await startResearch(
                            repoPath: repoPath, topic: topic, agent: agent, lens: lens, scope: scope,
                            screens: screens)
                    }
                },
            )
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
                    createInitialSource = .collect
                    showCreateSheet = true
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
