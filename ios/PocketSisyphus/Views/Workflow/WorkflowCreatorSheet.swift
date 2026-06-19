import SwiftUI

/// 새 워크플로우 — 두 갈래로 만든다.
///  ① «한 문장으로 설명» (AI 초안): 만들고 싶은 걸 텍스트로 적으면 daemon 설계 에이전트가
///     start/task/end + fail 간선 DAG «초안» 을 만들어 준다. 곧장 실행하지 않고(Zapier
///     «draft not live») 그 초안을 캔버스 편집기에 띄워 사용자가 검토·수정한 뒤에만 저장/실행한다.
///     모바일 터치로 노드를 손으로 그려 잇는 마찰을 «텍스트 명령» 으로 줄이는 게 목적.
///     (workflow_design_v1 capability 가 있을 때만 노출.)
///  ② 빈 캔버스: 제목/설명 없이 만들면 시작·종료만 있는 빈 그래프로 들어가 손으로 그린다(기존 동작).
///
/// 설계는 «백그라운드» 다 — 이 시트는 입력만 모아 시작 신호를 부모(WorkflowListView)에 넘기고
/// «즉시 닫힌다». 진행/완료(ready)/실패는 부모가 워크플로우 «목록 카드» 로 보여주므로, 사용자는
/// 설계가 도는 동안 앱을 자유롭게 쓸 수 있다 (예전엔 시트를 잠근 채 최대 5분 대기시켰다).
///
/// repo 경로는 공용 `RepoPathField`(최근 프로젝트 + 폴더 자동완성 칩)로 손쉽게 고른다.
struct WorkflowCreatorSheet: View {
    let auth: AuthStore
    let conn: ConnectionManager
    let inflight: InFlightTracker
    /// daemon 이 AI 초안 설계를 지원하는가 (workflow_design_v1). 없으면 설명 입력/에이전트 픽커/AI 초안 버튼을 숨긴다.
    let supportsDesign: Bool
    /// daemon 이 「출발 템플릿」을 지원하는가 (workflow_templates_v1). 없으면 템플릿 섹션을 숨긴다.
    let supportsTemplates: Bool
    /// 빈 캔버스로 만들기 — 시작·종료만 있는 그래프를 시드해 캔버스에서 손으로 그린다(기존 동작).
    let onCreateBlank: (_ title: String, _ repoPath: String) -> Void
    /// AI 초안 설계를 «시작» 한다 — 부모가 POST + 폴링을 백그라운드로 돌리고 목록 카드로 진행을 보여준다.
    let onStartDesign: (_ title: String, _ repoPath: String, _ description: String, _ agentId: String) -> Void
    /// 「출발 템플릿」으로 만들기 — 선택한 프리셋(노드/간선)을 시드해 워크플로우를 만들고 캔버스로 진입한다.
    let onCreateTemplate: (_ template: WorkflowTemplate, _ title: String, _ repoPath: String) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var title = ""
    @State private var repoPath = ""
    @State private var desc = ""

    /// 「출발 템플릿」 — daemon 에서 받은 프리셋 목록(빈=로딩 끝 + 없음). 캔버스에 즉시 시드된다.
    @State private var templates: [WorkflowTemplate] = []
    @State private var templatesLoading = false

    /// 초안을 설계할 에이전트 — cron 과 같이 «무인 실행 적합»(cron_eligible_v1) 한 것만 후보.
    @State private var agents: [AgentInfo] = [AgentInfo.claudeCodeFallback]
    @State private var selectedAgentId = AgentInfo.claudeCodeFallback.id

    private var hasRepo: Bool {
        !repoPath.trimmingCharacters(in: .whitespaces).isEmpty
    }
    private var hasDesc: Bool {
        !desc.trimmingCharacters(in: .whitespaces).isEmpty
    }
    /// AI 초안을 만들 수 있는 상태 — 지원 + repo + 한 문장 설명.
    private var canDesign: Bool { supportsDesign && hasRepo && hasDesc }

    var body: some View {
        NavigationStack {
            Form {
                Section("기본") {
                    VoiceInputField("제목 (선택)", text: $title)
                }
                if supportsDesign {
                    Section {
                        VoiceInputField("예: 매일 PR 을 리뷰하고 요약을 남겨줘", text: $desc, lineLimit: 2...5)
                    } header: {
                        Text("한 문장으로 설명 (AI 초안)")
                    } footer: {
                        Text("만들고 싶은 걸 한 문장으로 적으면 AI 가 워크플로우 «초안» 을 그려줘요. 바로 실행하지 않으니 캔버스에서 검토·수정한 뒤 실행하세요.")
                    }
                    designAgentSection
                }
                Section {
                    RepoPathField(auth: auth, conn: conn, inflight: inflight, repoPath: $repoPath)
                } header: {
                    Text("repo 경로")
                } footer: {
                    Text("최근 프로젝트·폴더 칩을 탭해 경로를 빠르게 채울 수 있어요. 모든 노드가 이 repo 에서 실행돼요.")
                }
                if supportsTemplates {
                    templateSection
                }
            }
            .navigationTitle("새 워크플로우")
            .navigationBarTitleDisplayMode(.inline)
            .voiceDictationChrome()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("취소") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    // 설명이 있고 지원되면 «AI 초안»(백그라운드 시작 후 즉시 닫힘), 아니면 «만들기»(빈 캔버스).
                    if canDesign {
                        Button("AI 초안") {
                            onStartDesign(trimmed(title), trimmed(repoPath), trimmed(desc), selectedAgentId)
                            dismiss()
                        }
                    } else {
                        Button("만들기") {
                            onCreateBlank(trimmed(title), trimmed(repoPath))
                            dismiss()
                        }
                        .disabled(!hasRepo)
                    }
                }
            }
            .task { await loadAgents() }
            .task { await loadTemplates() }
        }
    }

    /// 「출발 템플릿」 섹션 — 역할별 전문 에이전트를 순서대로 잇는 프리셋을 골라 즉시 만든다.
    /// 매번 빈 캔버스에서 손으로 잇는 마찰을 없앤다. repo 가 정해지기 전엔 버튼을 비활성(게이트).
    /// 상태: 로딩(스피너)·없음(안내)·목록(카드). 카드 탭 = 그 프리셋으로 만들고 캔버스로 진입.
    @ViewBuilder
    private var templateSection: some View {
        Section {
            if templatesLoading {
                HStack(spacing: Theme.Spacing.m) {
                    ProgressView()
                    Text("템플릿 불러오는 중…")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            } else if templates.isEmpty {
                Text("사용할 수 있는 템플릿이 없어요.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(templates) { tpl in
                    Button {
                        onCreateTemplate(tpl, trimmed(title), trimmed(repoPath))
                        dismiss()
                    } label: {
                        WorkflowTemplateRow(template: tpl)
                    }
                    .buttonStyle(.plain)
                    .disabled(!hasRepo)
                    .accessibilityLabel(Text("\(WorkflowTemplateCatalog.displayName(tpl.id)) 템플릿으로 워크플로우 만들기"))
                }
            }
        } header: {
            Text("템플릿으로 시작")
        } footer: {
            // repo 가 없으면 «먼저 repo 를 정하라», 있으면 «편집 가능» 안내.
            Text(hasRepo
                ? "역할별 전문 에이전트를 순서대로 잇는 출발 템플릿이에요. 만든 뒤 캔버스에서 편집할 수 있어요."
                : "repo 경로를 먼저 정하면 템플릿으로 바로 만들 수 있어요.")
        }
    }

    /// 초안 설계 에이전트 픽커 — 설계 세션은 무인(PTY bypass)으로 도므로 cron 과 같은
    /// cron_eligible_v1 후보만 보인다 (Terminal·Local LLM 은 daemon 이 표식을 안 달아 제외).
    private var designAgentSection: some View {
        Section {
            Picker(selection: $selectedAgentId) {
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
                Text("설계 에이전트")
            }
            .pickerStyle(.inline)
            .labelsHidden()
            .accessibilityLabel(Text("설계 에이전트"))
        } header: {
            Text("설계 에이전트")
        } footer: {
            Text("이 에이전트가 초안을 설계해요. 노드별 실행 에이전트는 캔버스에서 따로 정할 수 있어요.")
        }
    }

    private func trimmed(_ s: String) -> String { s.trimmingCharacters(in: .whitespaces) }

    /// 「출발 템플릿」 프리셋 로드 — 지원될 때만. 실패/없음은 «없음» 상태로 흡수(빈 캔버스·AI 초안은
    /// 그대로 쓸 수 있으니 시트를 막지 않는다 — soft degradation).
    private func loadTemplates() async {
        guard supportsTemplates else { return }
        templatesLoading = true
        defer { templatesLoading = false }
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        if let list = try? await api.listWorkflowTemplates() {
            templates = list
        }
    }

    private func loadAgents() async {
        guard supportsDesign else { return }
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        if let list = try? await api.listAgents(label: nil), !list.isEmpty {
            // 무인 실행 적합한 에이전트만(cron_eligible_v1). 표식을 단 게 하나도 없으면(옛 daemon)
            // 전체 목록으로 폴백해 픽커가 비지 않게 한다 (무회귀).
            let eligible = list.filter { $0.capabilities.contains("cron_eligible_v1") }
            let shown = eligible.isEmpty ? list : eligible
            agents = shown
            if !shown.contains(where: { $0.id == selectedAgentId }) {
                selectedAgentId = shown.first!.id
            }
        }
    }
}

/// 「출발 템플릿」 카드 한 개 — 지역화된 이름·설명 + 노드 흐름 미리보기(종류색 칩).
/// 노드 종류색은 이 레포 약속 그대로(시작=초록·작업=분홍·종료=파랑) — Theme.Node 단일 정의를 따른다.
/// 역할별로 색을 새로 발명하거나 상태색을 빌리지 않는다. 본문은 .primary/.secondary 로 다크/라이트 적응.
private struct WorkflowTemplateRow: View {
    let template: WorkflowTemplate

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.s) {
            Text(WorkflowTemplateCatalog.displayName(template.id))
                .font(.headline)
                .foregroundStyle(.primary)
            Text(WorkflowTemplateCatalog.summary(template.id))
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            flowPreview
        }
        .padding(.vertical, Theme.Spacing.xxs)
        .contentShape(Rectangle())
    }

    /// 노드 흐름 미리보기 — 제목 칩을 → 로 잇는다. 칩 점색 = 노드 종류색(Theme.Node). 장식 텍스트는 .secondary.
    private var flowPreview: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: Theme.Spacing.xs) {
                ForEach(Array(template.nodes.enumerated()), id: \.element.id) { idx, node in
                    if idx > 0 {
                        Image(systemName: "arrow.right")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                    HStack(spacing: Theme.Spacing.xxs) {
                        Circle()
                            .fill(nodeTypeColor(node.type))
                            .frame(width: 6, height: 6)
                        Text(WorkflowTemplateCatalog.nodeTitle(node.id, fallback: node.title) ?? node.id)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
        .accessibilityHidden(true)
    }

    /// 노드 종류색 — 캔버스 카드(editorTypeColor)와 같은 약속. 시작=초록·작업=분홍·종료=파랑.
    private func nodeTypeColor(_ type: String) -> Color {
        switch type {
        case "start": return Theme.Node.start
        case "end": return Theme.Node.end
        default: return Theme.Node.task
        }
    }
}
