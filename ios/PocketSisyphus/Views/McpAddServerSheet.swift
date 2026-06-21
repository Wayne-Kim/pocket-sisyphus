import SwiftUI

/// MCP 서버 추가 시트 — 제공자(캘린더/Gmail/사용자지정) + 에이전트 + 프로젝트 + 서버 URL +
/// 쓰기 opt-in 을 받아 `POST /api/mcp` 한다. 등록 직후 native(.mcp.json) 에 기록되고, 사용자가
/// 목록에서 「연결」 을 눌러 OAuth 동의(에이전트 CLI 위임)를 진행한다.
///
/// 최소권한 기본값: 쓰기 토글은 OFF — 기본은 읽기 전용 scope 만 부여된다. 켜야 create/update/
/// delete 권한이 opt-in 된다(브리프: 쓰기는 명시 opt-in).
struct McpAddServerSheet: View {
    let auth: AuthStore
    let conn: ConnectionManager
    let inflight: InFlightTracker
    let catalog: [McpCatalogEntry]
    let onSaved: () -> Void

    @Environment(\.dismiss) private var dismiss

    @State private var selectedCatalogId = ""
    @State private var agents: [AgentInfo] = [AgentInfo.claudeCodeFallback]
    @State private var selectedAgentId = AgentInfo.claudeCodeFallback.id
    @State private var repoPath = ""
    @State private var url = ""
    @State private var writeEnabled = false
    @State private var saving = false
    @State private var saveError: String?

    private var selectedEntry: McpCatalogEntry? {
        catalog.first { $0.id == selectedCatalogId }
    }
    private var isCustom: Bool { selectedCatalogId == "custom" }
    private var canSave: Bool {
        !selectedCatalogId.isEmpty && !repoPath.trimmingCharacters(in: .whitespaces).isEmpty
            && !url.trimmingCharacters(in: .whitespaces).isEmpty && !saving
    }

    var body: some View {
        NavigationStack {
            Form {
                providerSection
                agentSection
                Section {
                    RepoPathField(auth: auth, conn: conn, inflight: inflight, repoPath: $repoPath)
                } header: {
                    Text("프로젝트")
                } footer: {
                    Text("에이전트가 이 폴더에서 도구를 쓸 수 있게 등록돼요.")
                }
                urlSection
                writeSection
                if let saveError {
                    Section {
                        Text(saveError).foregroundStyle(Theme.danger)
                    }
                }
            }
            .navigationTitle("도구 추가")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    // 「취소」 는 해제(중립) — 강조색이 아니라 기본 primary.
                    Button("취소") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("추가") { Task { await save() } }
                        .disabled(!canSave)
                }
            }
            .task { await loadAgents() }
            .onAppear { selectDefaultProvider() }
        }
    }

    // MARK: - Sections

    private var providerSection: some View {
        Section {
            Picker(selection: $selectedCatalogId) {
                ForEach(catalog) { entry in
                    Label {
                        Text(verbatim: McpProviderCopy.label(for: entry.id) ?? entry.label)
                    } icon: {
                        Image(systemName: entry.icon)
                    }
                    .tag(entry.id)
                }
            } label: {
                Text("도구")
            }
            .onChange(of: selectedCatalogId) { _, _ in applyProviderDefaults() }
        } header: {
            // 「고급 도구」 묶음 강조 — pro(주황). 경고(노랑) 아님.
            HStack(spacing: Theme.Spacing.s) {
                Image(systemName: "sparkles").foregroundStyle(Theme.pro)
                Text("도구 종류")
            }
        }
    }

    private var agentSection: some View {
        Section {
            Picker(selection: $selectedAgentId) {
                ForEach(agents) { a in
                    Label {
                        Text(verbatim: a.displayName)
                    } icon: {
                        Image(systemName: AgentKind.from(id: a.id).systemImage)
                    }
                    .tag(a.id)
                }
            } label: {
                Text("에이전트")
            }
        } footer: {
            Text("이 에이전트의 세션에서 도구를 쓸 수 있게 등록돼요.")
        }
    }

    private var urlSection: some View {
        Section {
            TextField("https://example.com/mcp", text: $url)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(.URL)
        } header: {
            Text("서버 주소")
        } footer: {
            Text(isCustom
                ? "연결할 MCP 서버의 주소를 입력해 주세요."
                : "내 MCP 서버 주소예요. 기본값을 그대로 두거나 직접 운영하는 주소로 바꿀 수 있어요.")
        }
    }

    private var writeSection: some View {
        Section {
            Toggle(isOn: $writeEnabled) {
                Label("쓰기 허용", systemImage: "pencil")
            }
            .disabled(isCustom)
        } footer: {
            Text("기본은 읽기 전용이에요. 켜면 일정·메일을 만들거나 수정·삭제하는 권한까지 요청해요.")
        }
    }

    // MARK: - Logic

    private func selectDefaultProvider() {
        guard selectedCatalogId.isEmpty else { return }
        // custom 이 아닌 첫 제공자를 기본 선택.
        if let first = catalog.first(where: { $0.id != "custom" }) ?? catalog.first {
            selectedCatalogId = first.id
            applyProviderDefaults()
        }
    }

    private func applyProviderDefaults() {
        guard let entry = selectedEntry else { return }
        if !entry.defaultUrl.isEmpty { url = entry.defaultUrl }
        if entry.id == "custom" { writeEnabled = false }
    }

    @MainActor
    private func loadAgents() async {
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        if let list = try? await api.listAgents(label: nil), !list.isEmpty {
            agents = list
            if !list.contains(where: { $0.id == selectedAgentId }) {
                selectedAgentId = list.first!.id
            }
        }
    }

    @MainActor
    private func save() async {
        saving = true
        defer { saving = false }
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        do {
            _ = try await api.addMcpServer(
                catalogId: selectedCatalogId,
                agent: selectedAgentId,
                repoPath: repoPath.trimmingCharacters(in: .whitespaces),
                url: url.trimmingCharacters(in: .whitespaces),
                writeEnabled: writeEnabled,
            )
            onSaved()
            dismiss()
        } catch {
            saveError = (error as? LocalizedError)?.errorDescription ?? "\(error)"
        }
    }
}
