import SwiftUI

/// MCP 「도구」 — 에이전트가 붙을 사용자 본인 Calendar/Gmail 등 MCP 서버를 추가·연결·상태확인 한다.
///
/// 설정의 「도구」 진입점(mcp_tools_v1 지원 daemon 일 때만)에서 push 된다. 경계: 토큰은 daemon
/// 쪽 0600 에만 살고 폰엔 평문 미전송 — 이 화면은 «발견·연결·상태» 만 한다. MCP 전송·OAuth 동의
/// 흐름 자체는 에이전트 CLI 네이티브 MCP 가 수행한다(daemon 은 등록·custody·헬스만).
///
/// 색 = 의미(브리프 디자인 수용 기준): 「고급 도구」 묶음이라 그룹 «강조» 에 pro(주황)를 쓴다(경고
/// 아님). 연결 실패/만료는 danger(빨강), «연결 필요» 안내는 warning(노랑) — pro↔warning 혼동 금지.
/// 추가/연결 같은 기본 컨트롤은 색 지정 없이 AccentColor(보라). 앱 전역 .tint() 안 건다.
struct McpServersView: View {
    let auth: AuthStore
    let conn: ConnectionManager
    let inflight: InFlightTracker

    @EnvironmentObject var lifecycle: AppLifecycle

    @State private var servers: [McpServer] = []
    @State private var catalog: [McpCatalogEntry] = []
    @State private var loading = false
    @State private var loadError: String?
    @State private var showAddSheet = false
    @State private var busyId: String?
    @State private var actionError: ActionError?

    private struct ActionError: Identifiable {
        let id = UUID()
        let message: String
    }

    var body: some View {
        List {
            if servers.isEmpty && !loading {
                emptyState
            } else {
                Section {
                    ForEach(servers) { server in
                        McpServerRow(
                            server: server,
                            displayName: catalogLabel(server),
                            iconName: catalogIcon(server),
                            busy: busyId == server.id,
                            onConnect: { Task { await connect(server) } },
                            onRevoke: { Task { await revoke(server) } },
                        )
                        .swipeActions(edge: .trailing) {
                            Button(role: .destructive) {
                                Task { await remove(server) }
                            } label: {
                                Label("삭제", systemImage: "trash")
                            }
                        }
                    }
                } header: {
                    advancedHeader
                } footer: {
                    Text("연결된 도구는 에이전트 세션·워크플로우에서 메일·일정을 읽고 쓸 수 있어요. 토큰은 Mac 에만 안전하게 보관되고 휴대폰엔 저장되지 않아요.")
                }
            }
        }
        .navigationTitle("도구")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    showAddSheet = true
                } label: {
                    Image(systemName: "plus")
                }
                .disabled(catalog.isEmpty)
                .accessibilityLabel(Text("도구 추가"))
            }
        }
        .overlay {
            if loading && servers.isEmpty { ProgressView() }
        }
        .refreshable { await reload() }
        .task { await reload() }
        .onChange(of: lifecycle.reawakeToken) { _ in Task { await reload() } }
        .sheet(isPresented: $showAddSheet) {
            McpAddServerSheet(auth: auth, conn: conn, inflight: inflight, catalog: catalog) {
                Task { await reload() }
            }
            .presentationDetents([.large])
        }
        .alert(
            "오류",
            isPresented: Binding(get: { actionError != nil }, set: { if !$0 { actionError = nil } }),
            presenting: actionError,
        ) { _ in
            Button("확인", role: .cancel) {}
        } message: { e in
            Text(e.message)
        }
    }

    // MARK: - Subviews

    /// 「고급 도구」 묶음 강조 — pro(주황). 경고가 아니라 «고급» 카테고리 식별이다.
    private var advancedHeader: some View {
        HStack(spacing: Theme.Spacing.s) {
            Image(systemName: "sparkles")
                .foregroundStyle(Theme.pro)
            Text("연결된 도구")
        }
    }

    private var emptyState: some View {
        ContentUnavailableView {
            Label("연결된 도구가 없어요", systemImage: "wrench.and.screwdriver")
        } description: {
            Text("우상단 + 로 캘린더·Gmail 같은 도구를 추가하면, 에이전트가 내 일정·메일을 읽고 도와줄 수 있어요.")
        } actions: {
            if let loadError {
                Text(loadError)
                    .font(.caption)
                    .foregroundStyle(Theme.danger)
            }
        }
    }

    // MARK: - Catalog helpers

    private func catalogEntry(_ server: McpServer) -> McpCatalogEntry? {
        catalog.first { $0.id == server.catalogId }
    }
    private func catalogLabel(_ server: McpServer) -> String {
        McpProviderCopy.label(for: server.catalogId) ?? catalogEntry(server)?.label ?? server.label
    }
    private func catalogIcon(_ server: McpServer) -> String {
        catalogEntry(server)?.icon ?? "wrench.and.screwdriver"
    }

    // MARK: - Actions

    @MainActor
    private func reload() async {
        loading = true
        defer { loading = false }
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        do {
            async let s = api.listMcpServers()
            async let c = api.mcpCatalog()
            servers = try await s
            catalog = try await c
            loadError = nil
        } catch {
            loadError = (error as? LocalizedError)?.errorDescription ?? "\(error)"
        }
    }

    @MainActor
    private func connect(_ server: McpServer) async {
        busyId = server.id
        defer { busyId = nil }
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        do {
            _ = try await api.triggerMcpOauth(server.id)
            await reload()
        } catch {
            actionError = ActionError(message: (error as? LocalizedError)?.errorDescription ?? "\(error)")
        }
    }

    @MainActor
    private func revoke(_ server: McpServer) async {
        busyId = server.id
        defer { busyId = nil }
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        do {
            _ = try await api.revokeMcpServer(server.id)
            await reload()
        } catch {
            actionError = ActionError(message: (error as? LocalizedError)?.errorDescription ?? "\(error)")
        }
    }

    @MainActor
    private func remove(_ server: McpServer) async {
        busyId = server.id
        defer { busyId = nil }
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        do {
            try await api.deleteMcpServer(server.id)
            await reload()
        } catch {
            actionError = ActionError(message: (error as? LocalizedError)?.errorDescription ?? "\(error)")
        }
    }
}

/// 서버 한 행 — 라벨 + 상태 배지 + 연결/해제 액션. 색은 status enum 으로 분기(success/danger/warning).
private struct McpServerRow: View {
    let server: McpServer
    let displayName: String
    let iconName: String
    let busy: Bool
    let onConnect: () -> Void
    let onRevoke: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.m) {
            HStack(spacing: Theme.Spacing.l) {
                Image(systemName: iconName)
                    .font(.system(size: Theme.IconSize.m * 0.5))
                    .foregroundStyle(Theme.pro)
                    .frame(width: Theme.IconSize.m, height: Theme.IconSize.m)
                    .background(Theme.pro.opacity(Theme.Opacity.fill))
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.sm))
                    .accessibilityHidden(true)

                VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
                    Text(verbatim: displayName)
                        .font(.headline)
                    statusBadge
                }
                Spacer()
                if busy { ProgressView() }
            }

            if server.writeEnabled {
                Label("쓰기 허용", systemImage: "pencil")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            actionButton
        }
        .padding(.vertical, Theme.Spacing.xs)
    }

    private var statusBadge: some View {
        HStack(spacing: Theme.Spacing.xs) {
            Circle()
                .fill(statusColor)
                .frame(width: Theme.Spacing.m, height: Theme.Spacing.m)
            Text(statusText)
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(statusText))
    }

    @ViewBuilder
    private var actionButton: some View {
        switch server.statusValue {
        case .connected:
            Button(role: .destructive) {
                onRevoke()
            } label: {
                Text("연결 해제")
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .disabled(busy)
            .accessibilityLabel(Text("\(displayName) 연결 해제"))
        case .unconfigured, .expired, .error:
            Button {
                onConnect()
            } label: {
                Text(server.statusValue == .expired ? "다시 연결" : "연결하기")
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.small)
            .disabled(busy)
            .accessibilityLabel(Text("\(displayName) 연결하기"))
        }
    }

    private var statusColor: Color {
        switch server.statusValue {
        case .connected: return Theme.success
        case .expired, .error: return Theme.danger
        case .unconfigured: return Theme.warning
        }
    }

    private var statusText: String {
        switch server.statusValue {
        case .connected: return String(localized: "연결됨")
        case .expired: return String(localized: "토큰 만료 — 다시 연결 필요")
        case .error: return String(localized: "연결 오류")
        case .unconfigured: return String(localized: "연결 필요")
        }
    }
}

/// 카탈로그 제공자 id → 지역화 라벨. daemon 카탈로그의 ko 폴백 라벨 대신 iOS 가 자체 지역화한다
/// (자동 추출이 닿게 String(localized:) 경유). custom 등 미지 id 는 nil → 호출처가 폴백.
enum McpProviderCopy {
    static func label(for catalogId: String) -> String? {
        switch catalogId {
        case "google_calendar": return String(localized: "캘린더")
        case "gmail": return String(localized: "Gmail")
        case "custom": return String(localized: "사용자 지정")
        default: return nil
        }
    }
}
