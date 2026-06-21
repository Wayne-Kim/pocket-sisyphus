import SwiftUI

/// 예약 작업 목록. 「자동화」 탭(AutomationHomeView) 의 «예약» 세그먼트로 보인다(cron_v1 지원
/// daemon 일 때만). 생성/편집/지금실행/켜기끄기/삭제 전부 여기서. 실행 결과 세션은 onOpenSession
/// 으로 채팅 화면에 딥링크. 설정/도움말 진입점은 홈(AutomationHomeView)이 공통 제공한다.
struct CronListView: View {
    let auth: AuthStore
    let conn: ConnectionManager
    let inflight: InFlightTracker
    /// 세션 id 로 채팅 화면 열기 (SessionsView 가 예약 화면을 닫고 deepLink 라우팅으로 연결).
    let onOpenSession: (String) -> Void

    @EnvironmentObject var lifecycle: AppLifecycle

    @State private var jobs: [CronJob] = []
    @State private var loading = false
    @State private var loadError: String?
    @State private var sheet: CronSheet?
    @State private var runResult: RunResultAlert?
    @State private var busyJobId: String?

    private enum CronSheet: Identifiable {
        case new
        case edit(CronJob)
        var id: String {
            switch self {
            case .new: return "new"
            case .edit(let j): return j.id
            }
        }
    }

    private struct RunResultAlert: Identifiable {
        let id = UUID()
        let title: String
        let message: String
        let sessionId: String?
    }

    var body: some View {
        List {
            if jobs.isEmpty && !loading {
                ContentUnavailableView {
                    Label("예약 작업이 없어요", systemImage: "calendar.badge.clock")
                } description: {
                    Text("우상단 + 로 예약을 만들면, Mac 이 정해진 시각에 에이전트를 실행해요.")
                }
            } else {
                ForEach(jobs) { job in
                    CronRow(
                        job: job,
                        busy: busyJobId == job.id,
                        onToggle: { Task { await toggleEnabled(job) } },
                        onRun: { Task { await runNow(job) } }
                    )
                    .contentShape(Rectangle())
                    .onTapGesture { sheet = .edit(job) }
                    .swipeActions(edge: .trailing) {
                        Button(role: .destructive) {
                            Task { await delete(job) }
                        } label: {
                            Label("삭제", systemImage: "trash")
                        }
                    }
                }
            }
        }
        .navigationTitle("예약 작업")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    sheet = .new
                } label: {
                    Image(systemName: "plus")
                }
                .accessibilityLabel(Text("새 예약 만들기"))
            }
        }
        .overlay {
            if loading && jobs.isEmpty { ProgressView() }
        }
        .refreshable { await reload() }
        .task { await reload() }
        .onChange(of: lifecycle.reawakeToken) { _ in Task { await reload() } }
        .sheet(item: $sheet) { which in
            switch which {
            case .new:
                CronEditorSheet(auth: auth, conn: conn, inflight: inflight, existing: nil) {
                    Task { await reload() }
                }
                .presentationDetents([.large])
            case .edit(let job):
                CronEditorSheet(auth: auth, conn: conn, inflight: inflight, existing: job) {
                    Task { await reload() }
                }
                .presentationDetents([.large])
            }
        }
        .alert(
            runResult?.title ?? "",
            isPresented: Binding(get: { runResult != nil }, set: { if !$0 { runResult = nil } }),
            presenting: runResult
        ) { r in
            if let sid = r.sessionId {
                Button("세션 열기") { onOpenSession(sid) }
            }
            Button("확인", role: .cancel) {}
        } message: { r in
            Text(r.message)
        }
    }

    // MARK: - Actions

    @MainActor
    private func reload() async {
        loading = true
        defer { loading = false }
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        do {
            jobs = try await api.listCronJobs()
            loadError = nil
        } catch {
            loadError = (error as? LocalizedError)?.errorDescription ?? "\(error)"
        }
    }

    @MainActor
    private func toggleEnabled(_ job: CronJob) async {
        busyJobId = job.id
        defer { busyJobId = nil }
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        if let updated = try? await api.setCronJobEnabled(job.id, !job.isEnabled) {
            if let idx = jobs.firstIndex(where: { $0.id == job.id }) {
                jobs[idx] = updated
            }
        }
    }

    @MainActor
    private func runNow(_ job: CronJob) async {
        busyJobId = job.id
        defer { busyJobId = nil }
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        do {
            let result = try await api.runCronJob(job.id)
            switch result.status {
            case "running":
                runResult = RunResultAlert(
                    title: String(localized: "실행을 시작했어요"),
                    message: String(localized: "세션을 만들어 에이전트를 실행 중이에요. 끝나면 알림이 와요."),
                    sessionId: result.sessionId
                )
            case "skipped":
                runResult = RunResultAlert(
                    title: String(localized: "지금은 건너뛰었어요"),
                    message: skippedMessage(reason: result.skipReason),
                    sessionId: nil
                )
            default:
                runResult = RunResultAlert(
                    title: String(localized: "실행하지 못했어요"),
                    message: String(localized: "잠시 후 다시 시도해 주세요."),
                    sessionId: result.sessionId
                )
            }
            await reload()
        } catch {
            runResult = RunResultAlert(
                title: String(localized: "실행하지 못했어요"),
                message: (error as? LocalizedError)?.errorDescription ?? "\(error)",
                sessionId: nil
            )
        }
    }

    /// skip 사유 코드(daemon SkipReasonCode) → 화면 안내문.
    /// - "overlap": 직전 실행이 아직 진행 중 — 그 사실만 보여준다.
    /// - 그 외 코드: 향후 추가될 제약 — 제약에 걸렸음을 알린다 (구체 사유 매핑은 코드 추가 시).
    /// - nil: 사유를 안 주는 구버전 daemon — 기존 합쳐진 안내로 폴백.
    private func skippedMessage(reason: String?) -> String {
        switch reason {
        case "overlap":
            return String(localized: "직전 실행이 아직 진행 중이에요. 끝난 뒤 다시 실행해 주세요.")
        case .some:
            return String(localized: "제약 조건에 걸려 건너뛰었어요.")
        case .none:
            return String(localized: "직전 실행이 아직 진행 중이거나 제약에 걸렸어요.")
        }
    }

    @MainActor
    private func delete(_ job: CronJob) async {
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        if (try? await api.deleteCronJob(job.id)) != nil {
            jobs.removeAll { $0.id == job.id }
        }
    }
}

/// 목록 한 행 — 이름 / 다음 실행 / 마지막 상태 + 켜기끄기 토글 + 지금 실행 버튼.
private struct CronRow: View {
    let job: CronJob
    let busy: Bool
    let onToggle: () -> Void
    let onRun: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Image(systemName: AgentKind.from(id: job.agent).systemImage)
                    .foregroundStyle(.secondary)
                Text(displayTitle)
                    .font(.headline)
                    .lineLimit(1)
                Spacer()
                Toggle("", isOn: Binding(get: { job.isEnabled }, set: { _ in onToggle() }))
                    .labelsHidden()
                    .accessibilityLabel(Text("\(displayTitle) 예약 작업 사용"))
            }

            Text(job.schedule)
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)

            HStack(spacing: 10) {
                if job.isEnabled, let next = job.nextRunDate {
                    Label(next.formatted(date: .abbreviated, time: .shortened), systemImage: "clock")
                        .font(.caption2).foregroundStyle(.secondary)
                } else if !job.isEnabled {
                    Label("꺼짐", systemImage: "pause.circle")
                        .font(.caption2).foregroundStyle(.secondary)
                }
                lastStatusBadge
                Spacer()
                Button {
                    onRun()
                } label: {
                    if busy {
                        ProgressView()
                    } else {
                        Label("지금 실행", systemImage: "play.fill")
                            .font(.caption2)
                    }
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .disabled(busy)
            }
        }
        .padding(.vertical, 2)
    }

    private var displayTitle: String {
        if let t = job.title, !t.isEmpty { return t }
        return String(job.command.prefix(40))
    }

    @ViewBuilder
    private var lastStatusBadge: some View {
        switch job.last_status {
        case "ok":
            Label("성공", systemImage: "checkmark.circle.fill")
                .font(.caption2).foregroundStyle(.green)
        case "error":
            Label("실패", systemImage: "xmark.circle.fill")
                .font(.caption2).foregroundStyle(.red)
        case "timeout":
            Label("시간 초과", systemImage: "exclamationmark.triangle.fill")
                .font(.caption2).foregroundStyle(Theme.warning)
        case "skipped":
            Label("건너뜀", systemImage: "forward.fill")
                .font(.caption2).foregroundStyle(.secondary)
        case "running":
            Label("실행 중", systemImage: "circle.dotted")
                .font(.caption2).foregroundStyle(Theme.info)
        default:
            EmptyView()
        }
    }
}
