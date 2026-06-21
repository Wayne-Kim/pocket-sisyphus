import SwiftUI

/// 한 워크플로우가 (모든 실행에서) 만든 세션 목록 — 보고 / 열고 / 삭제.
///
/// 워크플로우 노드는 실행마다 세션을 만든다. 그 세션들은 «세션 탭» 에서는 숨기고(일반 세션과
/// 섞이지 않게) 여기서 따로 본다. 행을 탭하면 채팅으로 열고(세션 탭으로 전환+딥링크), 스와이프로
/// 삭제한다. daemon `GET /api/workflows/:id/sessions` + `DELETE /api/sessions/:id`.
struct WorkflowSessionsSheet: View {
    let auth: AuthStore
    let conn: ConnectionManager
    let inflight: InFlightTracker
    let workflowId: String
    let workflowTitle: String
    /// 세션을 채팅으로 열기 — 상위가 세션 탭으로 전환하고 딥링크한다.
    let onOpenSession: (String) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var sessions: [WorkflowSessionRow] = []
    @State private var loading = false
    @State private var loadError: String?

    var body: some View {
        NavigationStack {
            Group {
                if sessions.isEmpty && !loading {
                    ContentUnavailableView {
                        Label("세션이 없어요", systemImage: "bubble.left.and.bubble.right")
                    } description: {
                        Text("이 워크플로우를 실행하면 각 작업 노드가 세션을 만들어요. 그 세션이 여기 모여요.")
                    }
                } else {
                    List {
                        ForEach(sessions) { s in
                            Button {
                                onOpenSession(s.id)
                            } label: {
                                WorkflowSessionRowView(session: s)
                            }
                            .buttonStyle(.plain)
                            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                                Button(role: .destructive) {
                                    Task { await delete(s) }
                                } label: {
                                    Label("삭제", systemImage: "trash")
                                }
                            }
                        }
                    }
                    .listStyle(.plain)
                }
            }
            .navigationTitle(workflowTitle)
            .navigationBarTitleDisplayMode(.inline)
            .overlay { if loading && sessions.isEmpty { ProgressView() } }
            .refreshable { await reload() }
            .task { await reload() }
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("닫기") { dismiss() }
                }
            }
            .alert(
                "불러오기 실패",
                isPresented: Binding(get: { loadError != nil }, set: { if !$0 { loadError = nil } }),
                presenting: loadError
            ) { _ in
                Button("확인", role: .cancel) {}
            } message: { msg in Text(msg) }
        }
    }

    @MainActor
    private func reload() async {
        loading = true
        defer { loading = false }
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        do {
            sessions = try await api.workflowSessions(id: workflowId)
        } catch {
            loadError = error.localizedDescription
        }
    }

    @MainActor
    private func delete(_ s: WorkflowSessionRow) async {
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        do {
            try await api.deleteSession(s.id)
            sessions.removeAll { $0.id == s.id }
        } catch {
            loadError = error.localizedDescription
        }
    }
}

/// 워크플로우 세션 한 행 — 노드 제목 + 상태 + repo 꼬리.
private struct WorkflowSessionRowView: View {
    let session: WorkflowSessionRow

    var body: some View {
        HStack(spacing: Theme.Spacing.m) {
            Image(systemName: AgentKind.from(id: session.agent).systemImage)
                .foregroundStyle(.secondary)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
                Text(session.node_title ?? session.title ?? session.id)
                    .font(.callout.weight(.medium))
                    .lineLimit(1)
                HStack(spacing: Theme.Spacing.s) {
                    if let st = session.node_status {
                        Text(verbatim: st)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    if let repo = session.repo_path {
                        Text(repoTail(repo))
                            .font(.caption2.monospaced())
                            .foregroundStyle(.tertiary)
                            .lineLimit(1)
                            .truncationMode(.head)
                    }
                }
            }
            Spacer(minLength: 0)
            Image(systemName: "chevron.right")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.tertiary)
        }
        .contentShape(Rectangle())
        .padding(.vertical, Theme.Spacing.xxs)
    }

    private func repoTail(_ path: String) -> String {
        path.split(separator: "/").suffix(2).joined(separator: "/")
    }
}
