import SwiftUI

/// 멀티 에이전트 워크플로우 목록. 「자동화」 탭(AutomationHomeView) 의 «워크플로우» 세그먼트로
/// 보인다. 생성/삭제/실행은 여기서. 캔버스(WorkflowCanvasView)로 진입해 실행 상태를 본다.
/// 설정/도움말 진입점은 홈(AutomationHomeView)이 두 세그먼트 공통으로 제공한다.
/// CronListView 와 같은 @State + inline async 패턴 (Phase 0 — 별도 ViewModel 없이).
struct WorkflowListView: View {
    let auth: AuthStore
    let conn: ConnectionManager
    let inflight: InFlightTracker
    /// 페어된 daemon 의 capability 집합 — workflow_design_v1 이 있으면 생성 시트에 «AI 초안» 노출.
    let capabilities: [String]
    /// 노드 세션을 채팅 화면으로 열기 (SessionsView 가 워크플로우 화면을 닫고 deepLink 라우팅).
    let onOpenSession: (String) -> Void

    private var supportsDesign: Bool { capabilities.contains("workflow_design_v1") }
    private var supportsTemplates: Bool { capabilities.contains("workflow_templates_v1") }

    @EnvironmentObject var lifecycle: AppLifecycle
    /// `pocketsisyphus://workflow/<runId>` 딥링크 (po_gate «머지 승인 대기» 알림) 소비 —
    /// runId 를 workflow 로 해석해 캔버스로 push 한다.
    @EnvironmentObject var deepLink: DeepLinkRouter
    /// 지금 선택된 메인 탭 — 캔버스 푸시의 탭 바 숨김을 «자동화 탭이 활성일 때만» 걸기 위함.
    /// 딥링크로 다른 탭 전환 시 캔버스의 숨김이 남아 탭 바가 사라진 채 갇히는 누출 방지.
    @Environment(\.activeMainTab) private var activeMainTab

    /// 캔버스(WorkflowEditor/RunLoader) 푸시의 탭 바 숨김 — 자동화 탭이 «선택돼 있을 때만». 다른
    /// 탭으로 전환되면 .visible 로 풀어 도착 탭의 탭 바를 살린다(편집 중 캔버스 네비는 보존).
    private var canvasTabBarVisibility: Visibility {
        (activeMainTab ?? .workflows) == .workflows ? .hidden : .visible
    }

    @State private var workflows: [WorkflowSummary] = []
    /// 딥링크가 해석된 착지점 — 비-nil 이면 그 run 의 캔버스를 push.
    @State private var runLanding: WorkflowRunRef?
    @State private var loading = false
    @State private var loadError: String?
    @State private var showCreate = false
    /// 비-nil 이면 그 워크플로우의 편집기(캔버스)로 push — 새로 만든 직후 진입에 쓴다.
    @State private var editTarget: WorkflowSummary?
    /// 비-nil 이면 그 워크플로우가 만든 세션 목록 시트를 띄운다.
    @State private var sessionsTarget: WorkflowSummary?
    /// 백그라운드로 도는 AI 초안 설계들 — 목록 상단 카드로 진행/완료/실패를 보여준다.
    @State private var pendingDesigns: [PendingDesign] = []

    var body: some View {
        List {
            // AI 초안 설계는 백그라운드라 진행/완료를 목록 카드로 보여준다 — 사용자는 그동안
            // 앱을 자유롭게 쓰고, 「준비됨」 카드를 탭하면 그 초안으로 캔버스 편집기에 진입한다.
            if !pendingDesigns.isEmpty {
                Section {
                    ForEach(pendingDesigns) { d in
                        DesignProgressCard(
                            design: d,
                            onOpenSession: onOpenSession,
                            onReview: { reviewDesign(d) }
                        )
                        .swipeActions(edge: .trailing) {
                            Button(role: .destructive) {
                                pendingDesigns.removeAll { $0.id == d.id }
                            } label: {
                                Label("닫기", systemImage: "xmark")
                            }
                        }
                    }
                } header: {
                    Text("AI 초안")
                }
            }
            if workflows.isEmpty && !loading && pendingDesigns.isEmpty {
                ContentUnavailableView {
                    Label("워크플로우가 없어요", systemImage: "point.3.connected.trianglepath.dotted")
                } description: {
                    Text("우상단 + 로 워크플로우를 만들면, 캔버스에서 노드를 그리고 선으로 이어요.")
                }
            } else {
                ForEach(workflows) { wf in
                    NavigationLink {
                        // 탭 → 캔버스 편집기 (노드 추가/드래그/연결). 실행은 편집기의 「실행」 버튼.
                        WorkflowEditorView(
                            auth: auth,
                            conn: conn,
                            inflight: inflight,
                            workflow: wf,
                            onOpenSession: onOpenSession
                        ) { _ in Task { await reload() } }
                        // 캔버스 편집 중엔 탭 바를 숨겨 작업 영역을 넓게 쓴다.
                        .toolbar(canvasTabBarVisibility, for: .tabBar)
                    } label: {
                        WorkflowRow(workflow: wf)
                    }
                    .swipeActions(edge: .trailing) {
                        Button(role: .destructive) {
                            Task { await delete(wf) }
                        } label: {
                            Label("삭제", systemImage: "trash")
                        }
                    }
                    .swipeActions(edge: .leading) {
                        Button {
                            sessionsTarget = wf
                        } label: {
                            Label("세션", systemImage: "bubble.left.and.bubble.right")
                        }
                        .tint(Theme.info)
                    }
                    .contextMenu {
                        Button {
                            sessionsTarget = wf
                        } label: {
                            Label("이 워크플로우의 세션", systemImage: "bubble.left.and.bubble.right")
                        }
                    }
                }
            }
        }
        .navigationTitle("워크플로우")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            // 좌상단 설정/도움말은 자동화 홈(AutomationHomeView)이 두 세그먼트 공통으로 제공한다
            // — 여기선 «새 워크플로우» 액션만. (이전엔 워크플로우 탭이 직접 들고 있었다.)
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    showCreate = true
                } label: {
                    Image(systemName: "plus")
                }
                .accessibilityLabel(Text("새 워크플로우 만들기"))
            }
        }
        .overlay {
            if loading && workflows.isEmpty { ProgressView() }
        }
        .refreshable { await reload() }
        .task { await reload() }
        .task { await consumeRunDeepLink() }
        .onChange(of: lifecycle.reawakeToken) { _ in Task { await reload() } }
        .onChange(of: deepLink.pendingWorkflowRunId) { _ in Task { await consumeRunDeepLink() } }
        // 딥링크 착지 — runId 가 해석되면 그 run 의 캔버스로 push.
        .navigationDestination(item: $runLanding) { ref in
            WorkflowRunLoaderView(
                workflowId: ref.workflowId,
                runId: ref.runId,
                onOpenSession: onOpenSession
            )
            .toolbar(canvasTabBarVisibility, for: .tabBar)
        }
        // 새로 만든 워크플로우 → 곧장 캔버스 편집기로 진입.
        .navigationDestination(item: $editTarget) { wf in
            WorkflowEditorView(
                auth: auth,
                conn: conn,
                inflight: inflight,
                workflow: wf,
                onOpenSession: onOpenSession
            ) { _ in Task { await reload() } }
            .toolbar(canvasTabBarVisibility, for: .tabBar)
        }
        .sheet(isPresented: $showCreate) {
            WorkflowCreatorSheet(
                auth: auth,
                conn: conn,
                inflight: inflight,
                supportsDesign: supportsDesign,
                supportsTemplates: supportsTemplates,
                onCreateBlank: { title, repo in
                    Task { await createAndEdit(title: title, repoPath: repo, nodes: nil, edges: nil) }
                },
                onStartDesign: { title, repo, desc, agent in
                    startDesign(title: title, repoPath: repo, description: desc, agentId: agent)
                },
                onCreateTemplate: { template, title, repo in
                    // 노드 제목을 클라에서 지역화(노출 문자열은 카탈로그 경유) 후 시드 — 곧장 캔버스로 진입해
                    // 편집 가능한 상태로 만든다(빈 캔버스/AI 초안과 같은 createAndEdit 경로).
                    Task {
                        await createAndEdit(
                            title: title,
                            repoPath: repo,
                            nodes: WorkflowTemplateCatalog.localizedNodes(template),
                            edges: template.edges
                        )
                    }
                }
            )
            .presentationDetents([.large])
        }
        // 이 워크플로우가 만든 세션 보기/삭제. 세션 열기는 onOpenSession(세션 탭 전환+딥링크) 재사용.
        .sheet(item: $sessionsTarget) { wf in
            WorkflowSessionsSheet(
                auth: auth,
                conn: conn,
                inflight: inflight,
                workflowId: wf.id,
                workflowTitle: wf.title ?? String(localized: "(제목 없음)")
            ) { sid in
                sessionsTarget = nil
                onOpenSession(sid)
            }
        }
        .alert(
            "불러오기 실패",
            isPresented: Binding(get: { loadError != nil }, set: { if !$0 { loadError = nil } }),
            presenting: loadError
        ) { _ in
            Button("확인", role: .cancel) {}
        } message: { msg in
            Text(msg)
        }
    }

    /// 워크플로우를 만들고(POST) 곧장 편집기로 진입한다. draft(nodes/edges)가 있으면 AI 초안을
    /// 시드하고, 없으면(nil) 시작·종료만 있는 빈 그래프를 시드해 캔버스에서 손으로 그린다.
    /// AI 초안도 «곧장 실행하지 않는다» — 캔버스 편집기에 띄워 사용자가 검토·수정한 뒤 «실행»
    /// 버튼을 눌러야 돌아간다 (Zapier «draft not live»). daemon 이 POST 시 한 번 더 validateDef.
    @MainActor
    private func createAndEdit(
        title: String,
        repoPath: String,
        nodes draftNodes: [WorkflowNodeDef]?,
        edges draftEdges: [WorkflowEdgeDef]?,
    ) async {
        // 기본 이름 다국어 — 카탈로그에 시작/종료 번역 있음(인라인 한글이 영어 로케일에 새어
        // 나가지 않게). type 이 의미 키라 title 은 표시용 라벨일 뿐 → 로케일별 기본값 OK.
        let seedNodes = [
            WorkflowNodeDef(id: "start", type: "start", title: String(localized: "시작"), x: 60, y: 60),
            WorkflowNodeDef(id: "end", type: "end", title: String(localized: "종료"), x: 60, y: 320),
        ]
        let seedEdges = [WorkflowEdgeDef(id: "e0", from: "start", to: "end")]
        // 초안이 비어 있지 않으면 그걸, 아니면 빈 시드를 쓴다.
        let nodes = (draftNodes?.isEmpty == false) ? draftNodes! : seedNodes
        let edges = (draftNodes?.isEmpty == false) ? (draftEdges ?? []) : seedEdges
        let req = CreateWorkflowRequest(
            title: title.isEmpty ? nil : title,
            repoPath: repoPath,
            nodes: nodes,
            edges: edges,
            enabled: true
        )
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        do {
            let wf = try await api.createWorkflow(req)
            await reload()
            editTarget = wf
        } catch {
            loadError = error.localizedDescription
        }
    }

    /// `pocketsisyphus://workflow/<runId>` 소비 — runId → workflow_id 해석 후 캔버스 push.
    /// 해석 실패(run 삭제/일시 오류)는 같은 링크가 무한 재시도되지 않게 비우고 끝낸다 —
    /// 사용자는 알림을 다시 탭하면 된다.
    @MainActor
    private func consumeRunDeepLink() async {
        guard let rid = deepLink.pendingWorkflowRunId else { return }
        deepLink.pendingWorkflowRunId = nil
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        guard let st = try? await api.workflowRunState(runId: rid),
              let wfId = st.run.workflow_id else {
            loadError = String(localized: "워크플로우 실행을 찾을 수 없어요")
            return
        }
        runLanding = WorkflowRunRef(workflowId: wfId, runId: rid)
    }

    @MainActor
    private func reload() async {
        loading = true
        defer { loading = false }
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        do {
            workflows = try await api.listWorkflows()
        } catch {
            loadError = error.localizedDescription
        }
    }

    @MainActor
    private func delete(_ wf: WorkflowSummary) async {
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        do {
            try await api.deleteWorkflow(id: wf.id)
            workflows.removeAll { $0.id == wf.id }
        } catch {
            loadError = error.localizedDescription
        }
    }

    // MARK: - AI 초안 (백그라운드 설계)

    /// 시트가 넘긴 입력으로 설계를 «시작» 한다 — 카드를 즉시 띄우고 폴링은 백그라운드 Task 가 돈다.
    @MainActor
    private func startDesign(title: String, repoPath: String, description: String, agentId: String) {
        let card = PendingDesign(title: title, repoPath: repoPath, description: description)
        pendingDesigns.append(card)
        let cardId = card.id
        Task { await runDesign(cardId: cardId, title: title, repoPath: repoPath, description: description, agentId: agentId) }
    }

    /// 설계 POST → ready/failed 까지 폴링. 매 단계 카드 상태를 갱신한다. 사용자가 카드를 닫았으면
    /// (목록에서 사라졌으면) 폴링을 멈춘다 (daemon 잡은 TTL 로 알아서 청소된다).
    @MainActor
    private func runDesign(cardId: String, title: String, repoPath: String, description: String, agentId: String) async {
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        do {
            let start = try await api.designWorkflow(
                DesignWorkflowRequest(description: description, repoPath: repoPath, agent: agentId)
            )
            updateDesign(cardId) { $0.sessionId = start.sessionId; $0.status = .designing }
            let maxAttempts = 200 // ≈ 5분 (1.5초 간격)
            for _ in 0..<maxAttempts {
                try await Task.sleep(nanoseconds: 1_500_000_000)
                // 카드가 사라졌으면(사용자가 닫음) 폴링 중단.
                guard pendingDesigns.contains(where: { $0.id == cardId }) else { return }
                let st = try await api.workflowDesignState(designId: start.designId)
                switch st.status {
                case "ready":
                    updateDesign(cardId) { $0.status = .ready(nodes: st.nodes ?? [], edges: st.edges ?? []) }
                    return
                case "failed":
                    updateDesign(cardId) { $0.status = .failed(st.error ?? String(localized: "AI 초안 설계에 실패했어요")) }
                    return
                default:
                    continue // "designing" — 계속 폴링
                }
            }
            updateDesign(cardId) {
                $0.status = .failed(String(localized: "AI 초안 설계가 시간 내에 끝나지 않았어요. 다시 시도하세요."))
            }
        } catch {
            updateDesign(cardId) { $0.status = .failed(error.localizedDescription) }
        }
    }

    /// 「준비됨」 카드 탭 — 그 초안(nodes/edges)으로 워크플로우를 만들고 캔버스로 진입한다.
    @MainActor
    private func reviewDesign(_ d: PendingDesign) {
        guard case let .ready(nodes, edges) = d.status else { return }
        pendingDesigns.removeAll { $0.id == d.id }
        Task { await createAndEdit(title: d.title, repoPath: d.repoPath, nodes: nodes, edges: edges) }
    }

    private func updateDesign(_ id: String, _ mutate: (inout PendingDesign) -> Void) {
        guard let idx = pendingDesigns.firstIndex(where: { $0.id == id }) else { return }
        mutate(&pendingDesigns[idx])
    }
}

/// 백그라운드로 도는 AI 초안 설계 한 건 — 목록 카드로 진행/완료/실패를 보여준다.
private struct PendingDesign: Identifiable {
    /// 카드 식별자. designId 가 POST 응답 전엔 없으므로 클라이언트가 발급한다.
    let id = UUID().uuidString
    let title: String
    let repoPath: String
    /// 사용자가 적은 «한 문장» — 카드에 무엇을 그리는 중인지 표기 (런타임 사용자 입력 → 비번역).
    let description: String
    /// 설계 세션 id — 진행 중 「세션 보기」로 관전. POST 응답 전엔 nil.
    var sessionId: String?
    var status: Status = .starting

    enum Status {
        case starting               // POST 진행 중 (designId 아직 없음)
        case designing              // 설계 에이전트 작업 중
        case ready(nodes: [WorkflowNodeDef], edges: [WorkflowEdgeDef])
        case failed(String)
    }
}

/// 딥링크가 해석된 run 착지점 — navigationDestination(item:) 의 payload.
private struct WorkflowRunRef: Identifiable, Hashable {
    let workflowId: String
    let runId: String
    var id: String { runId }
}

/// 목록의 한 행 — 제목 + 노드 수 + repo 꼬리.
private struct WorkflowRow: View {
    let workflow: WorkflowSummary

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            Text(workflow.title ?? String(localized: "(제목 없음)"))
                .font(.headline)
            HStack(spacing: Theme.Spacing.m) {
                Label("\(workflow.workNodeCount)", systemImage: "cpu")
                    .labelStyle(.titleAndIcon)
                if let repo = workflow.repo_path {
                    Text(repoTail(repo))
                        .lineLimit(1)
                        .truncationMode(.head)
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, Theme.Spacing.xxs)
    }

    private func repoTail(_ path: String) -> String {
        let comps = path.split(separator: "/")
        return comps.suffix(2).joined(separator: "/")
    }
}

/// AI 초안 설계 진행/완료/실패를 보여주는 목록 카드. 진행 중엔 탭하면 설계 세션을 관전하고,
/// 준비되면 탭하면 그 초안으로 캔버스 편집기에 진입한다 (검토 후 저장/실행).
private struct DesignProgressCard: View {
    let design: PendingDesign
    let onOpenSession: (String) -> Void
    let onReview: () -> Void

    var body: some View {
        switch design.status {
        case .starting, .designing:
            Button {
                if let sid = design.sessionId { onOpenSession(sid) }
            } label: {
                row(title: Text("AI 가 초안을 그리는 중…"), subtitle: design.description, showChevron: design.sessionId != nil) {
                    ProgressView()
                }
            }
            .disabled(design.sessionId == nil)
        case .ready:
            Button(action: onReview) {
                row(title: Text("초안 준비됨 — 검토하기"), subtitle: design.description, showChevron: true) {
                    Image(systemName: "checkmark.circle.fill").foregroundStyle(Theme.success)
                }
            }
        case .failed(let msg):
            // 제목만 번역. 사유(msg)는 daemon/오류 런타임 문자열 → 비번역. 카드는 스와이프로 닫는다.
            row(title: Text("초안 설계 실패"), subtitle: msg, showChevron: false) {
                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Theme.warning)
            }
        }
    }

    /// 공통 행 — 선두 아이콘/스피너 + 제목 + 부제(런타임 문자열) + 옵션 chevron.
    private func row(
        title: Text,
        subtitle: String,
        showChevron: Bool,
        @ViewBuilder leading: () -> some View
    ) -> some View {
        HStack(spacing: Theme.Spacing.m) {
            leading()
            VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
                title.font(.subheadline.weight(.medium))
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            Spacer(minLength: 0)
            if showChevron {
                Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
            }
        }
        .padding(.vertical, Theme.Spacing.xxs)
        .contentShape(Rectangle())
    }
}
