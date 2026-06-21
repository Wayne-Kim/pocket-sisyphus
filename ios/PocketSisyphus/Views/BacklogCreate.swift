import SwiftUI

/// 백로그 «만들기» 통합 — 레포를 먼저 고르고, 한 폼에서 «어디서 찾을까»(내 레포 안 수집 /
/// 시장 조사 리서치)를 토글로 고른다. 기존 «레포 신호 수집»/«리서치 요청» 두 진입(각자 레포
/// 픽커 + 폼)을 하나로 합친 것 — 두 경로가 같은 «브리프» 를 만드는데도 따로 갈라져 있어
/// 수집이 잘 안 쓰이던 문제를 «분기 제거 + 토글» 로 직관화한다. Step 1 레포 픽커는 두 옛
/// 시트가 글자 그대로 같았어서 그대로 재사용한다.
// MARK: - 만들기 (수집/리서치 통합)

/// 기회를 «어디서» 찾을지 — 내 레포 안 신호 수집 / 레포 밖 시장 조사 리서치.
enum BriefSource: Hashable {
    case collect
    case research
}

/// 통합 폼 맨 위의 «어디서 찾을까» 토글 — 수집 폼·리서치 폼이 첫 섹션으로 공유한다.
/// 세그먼트로 두 경로를 한눈에 비교·전환하게 하고, 고른 쪽에 맞춰 설명(footer)을 바꾼다.
/// 기본 컨트롤 — 색 안 정함 → AccentColor(보라) 자동. 콘텐츠에 .tint() 안 건다.
struct BriefSourcePicker: View {
    @Binding var source: BriefSource

    var body: some View {
        Section {
            Picker(selection: $source) {
                Text("내 레포 안").tag(BriefSource.collect)
                Text("시장 조사").tag(BriefSource.research)
            } label: {
                Text("어디서 기회를 찾을까요?")
            }
            .pickerStyle(.segmented)
            .accessibilityLabel(Text("어디서 기회를 찾을까요?"))
        } header: {
            Text("어디서 기회를 찾을까요?")
        } footer: {
            if source == .collect {
                Text("내 레포의 이슈·TODO·문서·변경을 훑어 기회를 찾아요")
            } else {
                Text("레포 밖 시장·주제를 조사해 브리프로 정리해요")
            }
        }
    }
}

/// 통합 «만들기» 1단계 — 어느 레포에서 기회를 찾을지 고른다. 레포를 고르면 2단계(통합 폼)로
/// push 된다. 옛 «수집할 레포»/«리서치 요청» 레포 픽커가 글자 그대로 같았어서 하나로 합쳤다.
struct CreateBriefSheet: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var conn: ConnectionManager
    @EnvironmentObject var inflight: InFlightTracker
    @Environment(\.dismiss) private var dismiss

    // 수집 capability
    let supportsSchedule: Bool
    let supportsAsc: Bool
    let supportsFeedbackRepo: Bool
    let supportsDesignBootstrap: Bool
    let supportsCollectLens: Bool
    let supportsSecurityCollectLens: Bool
    let supportsAllExpertsCollectLens: Bool
    // 리서치 capability
    let supportsResearchLens: Bool
    let supportsResearchQaLens: Bool
    let supportsResearchSecurityLens: Bool
    let supportsResearchPmLens: Bool
    let supportsResearchMarketingLens: Bool
    let supportsResearchAnalyticsLens: Bool
    let supportsResearchOpsLens: Bool
    let supportsResearchLogicLens: Bool
    let supportsResearchUxLens: Bool
    let supportsResearchReadabilityLens: Bool
    let supportsResearchScope: Bool
    let supportsResearchUxScreens: Bool

    let agents: [AgentInfo]
    /// 처음 보일 경로 — 진입 버튼이 수집/리서치 중 무엇을 권하는지에 따라 정한다 (기본 수집).
    let initialSource: BriefSource
    /// 수집 시작 — (repoPath, instruction?, agent?, lens?).
    let onStartCollect: (String, String?, String?, String?) -> Void
    /// 리서치 시작 — (repoPath, topic, agent?, lens?, scope?, screens?).
    let onStartResearch: (String, String, String?, String?, String?, Bool?) -> Void

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
            .navigationTitle("어느 레포에서?")
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(for: String.self) { repoPath in
                CreateBriefForm(
                    repoPath: repoPath, initialSource: initialSource,
                    supportsSchedule: supportsSchedule, supportsAsc: supportsAsc,
                    supportsFeedbackRepo: supportsFeedbackRepo,
                    supportsDesignBootstrap: supportsDesignBootstrap,
                    supportsCollectLens: supportsCollectLens,
                    supportsSecurityCollectLens: supportsSecurityCollectLens,
                    supportsAllExpertsCollectLens: supportsAllExpertsCollectLens,
                    supportsResearchLens: supportsResearchLens,
                    supportsResearchQaLens: supportsResearchQaLens,
                    supportsResearchSecurityLens: supportsResearchSecurityLens,
                    supportsResearchPmLens: supportsResearchPmLens,
                    supportsResearchMarketingLens: supportsResearchMarketingLens,
                    supportsResearchAnalyticsLens: supportsResearchAnalyticsLens,
                    supportsResearchOpsLens: supportsResearchOpsLens,
                    supportsResearchLogicLens: supportsResearchLogicLens,
                    supportsResearchUxLens: supportsResearchUxLens,
                    supportsResearchReadabilityLens: supportsResearchReadabilityLens,
                    supportsResearchScope: supportsResearchScope,
                    supportsResearchUxScreens: supportsResearchUxScreens,
                    agents: agents, onStartCollect: onStartCollect,
                    onStartResearch: onStartResearch)
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

/// 통합 «만들기» 2단계 — 맨 위 «어디서 찾을까» 토글로 수집/리서치 폼을 바꿔 보여준다.
/// source 를 소유하고, 고른 값에 따라 기존 빠른 수집 폼(CollectProfileForm) /
/// 리서치 주제 폼(ResearchTopicForm)을 그대로 렌더한다 — 두 폼은 각자 첫 섹션으로
/// 같은 BriefSourcePicker 를 그려 토글을 노출한다 (중첩 List 없이 통째 교체).
struct CreateBriefForm: View {
    let repoPath: String
    let initialSource: BriefSource

    // 수집 capability
    let supportsSchedule: Bool
    let supportsAsc: Bool
    let supportsFeedbackRepo: Bool
    let supportsDesignBootstrap: Bool
    let supportsCollectLens: Bool
    let supportsSecurityCollectLens: Bool
    let supportsAllExpertsCollectLens: Bool
    // 리서치 capability
    let supportsResearchLens: Bool
    let supportsResearchQaLens: Bool
    let supportsResearchSecurityLens: Bool
    let supportsResearchPmLens: Bool
    let supportsResearchMarketingLens: Bool
    let supportsResearchAnalyticsLens: Bool
    let supportsResearchOpsLens: Bool
    let supportsResearchLogicLens: Bool
    let supportsResearchUxLens: Bool
    let supportsResearchReadabilityLens: Bool
    let supportsResearchScope: Bool
    let supportsResearchUxScreens: Bool

    let agents: [AgentInfo]
    let onStartCollect: (String, String?, String?, String?) -> Void
    let onStartResearch: (String, String, String?, String?, String?, Bool?) -> Void

    @State private var source: BriefSource

    init(
        repoPath: String, initialSource: BriefSource,
        supportsSchedule: Bool, supportsAsc: Bool, supportsFeedbackRepo: Bool,
        supportsDesignBootstrap: Bool, supportsCollectLens: Bool,
        supportsSecurityCollectLens: Bool, supportsAllExpertsCollectLens: Bool,
        supportsResearchLens: Bool, supportsResearchQaLens: Bool,
        supportsResearchSecurityLens: Bool, supportsResearchPmLens: Bool,
        supportsResearchMarketingLens: Bool, supportsResearchAnalyticsLens: Bool,
        supportsResearchOpsLens: Bool, supportsResearchLogicLens: Bool,
        supportsResearchUxLens: Bool, supportsResearchReadabilityLens: Bool,
        supportsResearchScope: Bool, supportsResearchUxScreens: Bool,
        agents: [AgentInfo],
        onStartCollect: @escaping (String, String?, String?, String?) -> Void,
        onStartResearch: @escaping (String, String, String?, String?, String?, Bool?) -> Void
    ) {
        self.repoPath = repoPath
        self.initialSource = initialSource
        self.supportsSchedule = supportsSchedule
        self.supportsAsc = supportsAsc
        self.supportsFeedbackRepo = supportsFeedbackRepo
        self.supportsDesignBootstrap = supportsDesignBootstrap
        self.supportsCollectLens = supportsCollectLens
        self.supportsSecurityCollectLens = supportsSecurityCollectLens
        self.supportsAllExpertsCollectLens = supportsAllExpertsCollectLens
        self.supportsResearchLens = supportsResearchLens
        self.supportsResearchQaLens = supportsResearchQaLens
        self.supportsResearchSecurityLens = supportsResearchSecurityLens
        self.supportsResearchPmLens = supportsResearchPmLens
        self.supportsResearchMarketingLens = supportsResearchMarketingLens
        self.supportsResearchAnalyticsLens = supportsResearchAnalyticsLens
        self.supportsResearchOpsLens = supportsResearchOpsLens
        self.supportsResearchLogicLens = supportsResearchLogicLens
        self.supportsResearchUxLens = supportsResearchUxLens
        self.supportsResearchReadabilityLens = supportsResearchReadabilityLens
        self.supportsResearchScope = supportsResearchScope
        self.supportsResearchUxScreens = supportsResearchUxScreens
        self.agents = agents
        self.onStartCollect = onStartCollect
        self.onStartResearch = onStartResearch
        _source = State(initialValue: initialSource)
    }

    var body: some View {
        switch source {
        case .collect:
            CollectProfileForm(
                repoPath: repoPath,
                supportsSchedule: supportsSchedule, supportsAsc: supportsAsc,
                supportsFeedbackRepo: supportsFeedbackRepo,
                supportsDesignBootstrap: supportsDesignBootstrap,
                supportsCollectLens: supportsCollectLens,
                supportsSecurityCollectLens: supportsSecurityCollectLens,
                supportsAllExpertsCollectLens: supportsAllExpertsCollectLens,
                agents: agents, onStart: onStartCollect, source: $source)
        case .research:
            ResearchTopicForm(
                repoPath: repoPath, agents: agents,
                supportsLens: supportsResearchLens,
                supportsQaLens: supportsResearchQaLens,
                supportsSecurityLens: supportsResearchSecurityLens,
                supportsPmLens: supportsResearchPmLens,
                supportsMarketingLens: supportsResearchMarketingLens,
                supportsAnalyticsLens: supportsResearchAnalyticsLens,
                supportsOpsLens: supportsResearchOpsLens,
                supportsLogicLens: supportsResearchLogicLens,
                supportsUxLens: supportsResearchUxLens,
                supportsReadabilityLens: supportsResearchReadabilityLens,
                supportsScope: supportsResearchScope,
                supportsUxScreens: supportsResearchUxScreens,
                onStart: onStartResearch, source: $source)
        }
    }
}
