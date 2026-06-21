import SwiftUI

/// workflowId(+runId) 만 들고 캔버스로 착지하는 로더 — 정의(WorkflowSummary)를 fetch 한 뒤
/// WorkflowCanvasView 를 그린다. 두 진입점이 공유한다:
///   - PO 브리프 상세의 «구현 워크플로우» (execWorkflowId/execRunId — po_workflow_v1)
///   - `pocketsisyphus://workflow/<runId>` 딥링크 (po_gate «머지 승인 대기» 알림 착지)
struct WorkflowRunLoaderView: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var conn: ConnectionManager
    @EnvironmentObject var inflight: InFlightTracker

    let workflowId: String
    /// 착지할 run — nil 이면 캔버스가 최근 run 을 자동 로드.
    let runId: String?
    let onOpenSession: (String) -> Void

    @State private var workflow: WorkflowSummary?
    @State private var error: String?

    var body: some View {
        Group {
            if let workflow {
                WorkflowCanvasView(
                    auth: auth,
                    conn: conn,
                    inflight: inflight,
                    workflow: workflow,
                    initialRunId: runId,
                    onOpenSession: onOpenSession
                )
            } else if let error {
                ContentUnavailableView {
                    Label("워크플로우를 불러올 수 없어요", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(verbatim: error)
                }
            } else {
                ProgressView()
                    .task { await load() }
            }
        }
        .navigationBarTitleDisplayMode(.inline)
    }

    @MainActor
    private func load() async {
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        do {
            workflow = try await api.workflowDetail(id: workflowId).workflow
        } catch {
            self.error = (error as? LocalizedError)?.errorDescription ?? "\(error)"
        }
    }
}
