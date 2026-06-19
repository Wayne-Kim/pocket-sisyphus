import SwiftUI

/// 한 워크플로우의 «실행 기록» — daemon 이 내려준 최근 run 목록(최대 20)을 시작시각 내림차순으로
/// 보여 준다. 함대를 무인(cron·github)으로 굴리는 운영자가 «어젯밤 예약 트리거로 돈 run 이
/// 어떻게 끝났는지» 를 폰에서 확인하려는 용도.
///
/// daemon `GET /api/workflows/:id` 는 listRunsForWorkflow(id, 20) 를 이미 내려보낸다 — 캔버스는
/// 그중 «가장 최근 1건» 만 자동 표시하는데, 이 시트가 나머지까지 모두 노출한다(데이터는 있는데
/// 폰에서 안 보이던 막다른 길을 푼다). 행을 탭하면 그 runId 로 읽기전용 캔버스(WorkflowRunLoaderView
/// → WorkflowCanvasView, workflowRunState(runId:) 폴링)에 진입한다 — running 은 계속 폴링,
/// 종료된 run 은 정적 표시.
struct WorkflowRunHistorySheet: View {
    let auth: AuthStore
    let conn: ConnectionManager
    let inflight: InFlightTracker
    let workflowId: String
    let workflowTitle: String
    /// 행 탭 → 그 run 의 캔버스로 진입. 상위(캔버스)가 시트를 닫고 navigationDestination 으로 push 한다.
    let onSelectRun: (String) -> Void

    @Environment(\.dismiss) private var dismiss
    /// daemon 정렬을 그대로 신뢰(started_at DESC) — 클라이언트 재정렬 없이 표시한다.
    @State private var runs: [WorkflowRunInfo] = []
    @State private var loading = false
    @State private var loadError: String?

    var body: some View {
        NavigationStack {
            Group {
                if runs.isEmpty && !loading {
                    // 한 번도 안 돈 워크플로우 — 자동 최신 run 선택도 no-op 인 상태.
                    ContentUnavailableView {
                        Label("아직 실행 기록이 없어요", systemImage: "clock.arrow.circlepath")
                    } description: {
                        Text("이 워크플로우를 실행하거나, 예약·GitHub 트리거로 자동 실행되면 여기에 기록이 쌓여요.")
                    }
                } else {
                    List {
                        Section {
                            ForEach(runs) { run in
                                Button {
                                    onSelectRun(run.id)
                                } label: {
                                    WorkflowRunRowView(run: run)
                                }
                                .buttonStyle(.plain)
                            }
                        } footer: {
                            // daemon 이 21건째부터 잘라 주므로 «최근 20건만» 임을 명시한다(silent truncation 금지).
                            if runs.count >= 20 {
                                Text("최근 20건만 표시해요.")
                            }
                        }
                    }
                    .listStyle(.plain)
                }
            }
            .navigationTitle("실행 기록")
            .navigationBarTitleDisplayMode(.inline)
            .overlay { if loading && runs.isEmpty { ProgressView() } }
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
            // 캔버스의 loadLatestRun 과 동일 엔드포인트 — runs(최대 20, started_at DESC)를 그대로 쓴다.
            runs = try await api.workflowDetail(id: workflowId).runs
        } catch {
            loadError = error.localizedDescription
        }
    }
}

/// 실행 기록 한 행 — 상태 칩 + 트리거 종류 + 시작 상대시각 + 소요(진행 중이면 «진행 중»).
private struct WorkflowRunRowView: View {
    let run: WorkflowRunInfo

    var body: some View {
        HStack(spacing: Theme.Spacing.m) {
            statusChip
            VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
                Label {
                    workflowTriggerText(run.trigger_kind)
                } icon: {
                    Image(systemName: workflowTriggerIcon(run.trigger_kind))
                }
                .labelStyle(.titleAndIcon)
                .font(.subheadline.weight(.medium))
                Text(verbatim: Self.relative(run.started_at))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
            durationText
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
            Image(systemName: "chevron.right")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.tertiary)
        }
        .contentShape(Rectangle())
        .padding(.vertical, Theme.Spacing.xxs)
    }

    /// 상태 칩 — 캔버스와 같은 색 약속(workflowStatusColor) + 라벨(workflowStatusText) 재사용.
    private var statusChip: some View {
        let color = workflowStatusColor(run.status)
        return workflowStatusText(run.status)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(color)
            .padding(.horizontal, Theme.Spacing.s)
            .padding(.vertical, 3)
            .background(color.opacity(Theme.Opacity.fill), in: Capsule())
            .overlay(Capsule().stroke(color.opacity(Theme.Opacity.border), lineWidth: 1))
            .fixedSize()
    }

    /// 소요 = ended − started. 진행 중(ended 없음)이면 «진행 중».
    private var durationText: Text {
        guard let ended = run.ended_at else { return Text("진행 중") }
        let secs = max(0, Double(ended - run.started_at) / 1000)
        return Text(verbatim: Self.duration(secs))
    }

    // MARK: - 포맷터 (시스템 로케일 자동 번역 — 별도 카탈로그 문자열 불필요)

    /// 시작 시각 → 상대시간("3분 전"). RelativeDateTimeFormatter 가 로케일별로 번역한다.
    private static let relFormatter: RelativeDateTimeFormatter = {
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .abbreviated
        return f
    }()

    private static func relative(_ ms: Int64) -> String {
        relFormatter.localizedString(
            for: Date(timeIntervalSince1970: TimeInterval(ms) / 1000),
            relativeTo: Date()
        )
    }

    /// 소요(초) → 로케일 기간 문자열 ("2분 5초"). DateComponentsFormatter 가 단위를 번역한다.
    private static func duration(_ seconds: Double) -> String {
        let f = DateComponentsFormatter()
        f.unitsStyle = .abbreviated
        f.maximumUnitCount = 2
        f.allowedUnits = seconds >= 60 ? [.day, .hour, .minute] : [.second]
        return f.string(from: seconds) ?? "\(Int(seconds))s"
    }
}

// MARK: - 트리거 라벨/아이콘 (file-scope)

/// 트리거 종류 라벨 — manual=수동 / cron=예약 / github=GitHub(브랜드, 비번역). 각 분기가 Text literal
/// 이라 카탈로그 자동 추출 경로를 탄다(GitHub 만 verbatim).
private func workflowTriggerText(_ kind: String?) -> Text {
    switch kind {
    case "cron": return Text("예약")
    case "github": return Text(verbatim: "GitHub")
    default: return Text("수동")   // manual (및 미지정)
    }
}

private func workflowTriggerIcon(_ kind: String?) -> String {
    switch kind {
    case "cron": return "clock"
    case "github": return "arrow.triangle.branch"
    default: return "hand.tap"   // manual
    }
}
