import SwiftUI

/// 「루프 감독」 — 랄프 운영의 idiom «루프 위에 앉아라, 안에 들어가지 마라» 를 폰에서 구현하는
/// 반복-실행 진행 전용 화면. 워크플로우 캔버스가 노드 그래프를 그린다면, 이 화면은 «위에서»
/// 반복 한 건을 한눈에 본다:
///   • 반복 카운터 (현재 N / 상한) — 진행이라 기본 accent(보라). 의미색 아님.
///   • 마지막 검사 통과/실패 + 사유 한 줄 — 통과=success(초록) · 실패=danger(빨강).
///   • 이번 실행이 만든 변경(커밋) 요약.
///   • 한 번 탭으로 멈추는 정지 버튼 — 파괴적이라 danger(빨강) + 확인.
///
/// 데이터는 daemon 변경 없이 «기존» API 두 곳을 엮는다(WorkflowRunIsolationView 와 동형):
///   • run 상태: GET /api/workflows/runs/:id (WorkflowRunStateResponse) — 반복/검사/상태.
///   • 변경 요약: 이 run 의 노드 세션별 GET …/git/commits 를 sha 로 합쳐 dedupe.
///
/// 색 약속(이 레포 SSOT): 검사 통과=success · 실패=danger · 반복 카운터=accent · 정지=danger.
/// 콘텐츠 버튼(정지·새로고침)에 `.tint(pro)` 를 걸지 않는다(워크플로우는 «탭 버튼» 만 주황).
/// 본문 색은 `.primary`/`.secondary` 자동 적응. 빈/오류는 IconSize placeholder 아이콘.
struct WorkflowLoopMonitorView: View {
    let auth: AuthStore
    let conn: ConnectionManager
    let inflight: InFlightTracker
    /// 감독할 run. nil 이면 «진행 중인 실행 없음» 빈 상태.
    let runId: String?
    let workflowTitle: String

    @Environment(\.dismiss) private var dismiss
    @State private var load: LoopMonitorLoad = .loading
    @State private var commits: [GitCommit] = []
    @State private var stopping = false
    @State private var confirmStop = false
    /// 폴링 task 를 다시 시작하는 토큰 — 「다시 시도」/「새로고침」 이 올린다.
    @State private var reloadToken = 0

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("루프 감독")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("닫기") { dismiss() }
                    }
                }
                .task(id: pollKey) { await poll() }
                .confirmationDialog(
                    "실행을 멈출까요?",
                    isPresented: $confirmStop,
                    titleVisibility: .visible
                ) {
                    Button("멈춤", role: .destructive) { Task { await stop() } }
                    Button("취소", role: .cancel) {}
                } message: {
                    Text("진행 중인 반복이 즉시 중단돼요. 되돌릴 수 없어요.")
                }
        }
        .presentationDetents([.medium, .large])
    }

    /// `.task(id:)` 키 — run·재시도 토큰이 바뀌면 다시 읽는다.
    private var pollKey: String { "\(runId ?? "")|\(reloadToken)" }

    // MARK: - 콘텐츠 (상태별 분기)

    @ViewBuilder
    private var content: some View {
        switch load {
        case .loading:
            ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .empty:
            LoopPlaceholder(
                systemImage: "circle.dashed",
                title: "진행 중인 실행이 없어요",
                message: "워크플로우를 실행하면 여기서 반복 진행을 위에서 감독할 수 있어요."
            )
        case .error:
            VStack(spacing: Theme.Spacing.xxl) {
                LoopPlaceholder(
                    systemImage: "exclamationmark.triangle.fill",
                    title: "실행을 불러오지 못했어요",
                    message: nil
                )
                Button("다시 시도") { reloadToken += 1 }
                    .buttonStyle(.bordered)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .loaded(let st):
            loaded(st)
        }
    }

    @ViewBuilder
    private func loaded(_ st: WorkflowRunStateResponse) -> some View {
        let model = LoopModel(state: st)
        ScrollView {
            VStack(spacing: Theme.Spacing.xxl) {
                statusRow(model)
                iterationCard(model)
                lastCheckCard(model)
                changeSummary
            }
            .padding(.horizontal, Theme.Spacing.xxl)
            .padding(.vertical, Theme.Spacing.xxl)
        }
        .safeAreaInset(edge: .bottom) { actionBar(model) }
    }

    // MARK: - 상태 줄

    @ViewBuilder
    private func statusRow(_ model: LoopModel) -> some View {
        HStack(spacing: Theme.Spacing.m) {
            if model.isRunning {
                ProgressView().controlSize(.small)
            }
            model.statusText
                .font(.headline)
            Spacer()
            // 워크플로우 제목은 사용자 데이터 → verbatim. 본문색 .primary 자동 적응.
            Text(verbatim: workflowTitle)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - 반복 카운터 (진행 = accent 보라, 의미색 아님)

    @ViewBuilder
    private func iterationCard(_ model: LoopModel) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.s) {
            Text("반복")
                .font(.subheadline.weight(.medium))
                .foregroundStyle(.secondary)
            HStack(alignment: .firstTextBaseline, spacing: Theme.Spacing.s) {
                // 큰 숫자는 시맨틱 폰트가 못 커버 → 고정 stat 폰트(monospaced). 진행이라 accent.
                Text(verbatim: "\(model.iteration)")
                    .font(.system(size: Theme.FontSize.stat, weight: .semibold).monospacedDigit())
                    .foregroundStyle(Theme.accent)
                if let cap = model.iterationCap {
                    // "/ N" — 순수 숫자/기호라 번역 대상 아님(verbatim). 상한도 monospaced 로 정렬.
                    Text(verbatim: "/ \(cap)")
                        .font(.title2.weight(.medium).monospacedDigit())
                        .foregroundStyle(.secondary)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(Theme.Spacing.xxl)
        .background(
            RoundedRectangle(cornerRadius: Theme.Radius.l)
                .fill(Theme.accent.opacity(Theme.Opacity.fill))
        )
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("반복 카운터"))
        .accessibilityValue(model.iterationAccessibility)
    }

    // MARK: - 마지막 검사 (통과=success / 실패=danger / 없음=중립)

    @ViewBuilder
    private func lastCheckCard(_ model: LoopModel) -> some View {
        HStack(spacing: Theme.Spacing.l) {
            Image(systemName: model.check.icon)
                .font(.title2)
                .foregroundStyle(model.check.color)
                .frame(width: 28)
            VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
                model.check.label
                    .font(.callout.weight(.semibold))
                    .foregroundStyle(model.check.color)
                if let reason = model.check.reason {
                    // 검사 사유는 daemon verdict 산출물 → verbatim. 본문색 자동 적응.
                    Text(verbatim: reason)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(Theme.Spacing.xxl)
        .background(
            RoundedRectangle(cornerRadius: Theme.Radius.l)
                .fill(model.check.color.opacity(Theme.Opacity.fill))
        )
        .accessibilityElement(children: .combine)
        .accessibilityLabel(model.check.accessibility)
    }

    // MARK: - 변경 요약 (이 run 의 커밋)

    @ViewBuilder
    private var changeSummary: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.m) {
            HStack {
                Text("변경 요약")
                    .font(.subheadline.weight(.semibold))
                Spacer()
                if !commits.isEmpty {
                    Text("변경 \(commits.count)개")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            if commits.isEmpty {
                Text("아직 변경 없음")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(commits.prefix(6)) { commit in
                    HStack(alignment: .firstTextBaseline, spacing: Theme.Spacing.m) {
                        // 추가(+)=success 의미색 점. 변경이 «생겼다» 는 신호.
                        Image(systemName: "circle.fill")
                            .font(.system(size: 6))
                            .foregroundStyle(Theme.success)
                        // 커밋 제목·sha 는 git 식별자/산출물 → verbatim.
                        Text(verbatim: commit.subject)
                            .font(.caption)
                            .lineLimit(1)
                            .truncationMode(.tail)
                        Spacer(minLength: Theme.Spacing.m)
                        Text(verbatim: commit.shortSha)
                            .font(.caption2.monospaced())
                            .foregroundStyle(.tertiary)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(Theme.Spacing.xxl)
        .background(
            RoundedRectangle(cornerRadius: Theme.Radius.l)
                .fill(Theme.neutralFill.opacity(Theme.Opacity.fill))
        )
    }

    // MARK: - 액션 바 (정지 = danger · 새로고침 = accent)

    @ViewBuilder
    private func actionBar(_ model: LoopModel) -> some View {
        HStack(spacing: Theme.Spacing.l) {
            if model.isRunning {
                Button(role: .destructive) {
                    confirmStop = true
                } label: {
                    Label("멈춤", systemImage: "stop.circle.fill")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .tint(Theme.danger)
                .disabled(stopping)
                .accessibilityLabel(Text("실행 멈춤"))
            }
            Button {
                reloadToken += 1
            } label: {
                Label("새로고침", systemImage: "arrow.clockwise")
                    .frame(maxWidth: model.isRunning ? nil : .infinity)
            }
            .buttonStyle(.bordered)
            .accessibilityLabel(Text("새로고침"))
        }
        .padding(.horizontal, Theme.Spacing.xxl)
        .padding(.vertical, Theme.Spacing.l)
        .background(.ultraThinMaterial)
    }

    // MARK: - 폴링 / 액션

    @MainActor
    private func poll() async {
        guard let rid = runId, !rid.isEmpty else { load = .empty; return }
        if !load.hasData { load = .loading }
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        var firstCommits = true
        while !Task.isCancelled {
            do {
                let st = try await api.workflowRunState(runId: rid)
                load = .loaded(st)
                // 변경 요약은 매 폴마다 새로 받지 않고 처음 + 종료 직후에만 (커밋은 자주 안 바뀜).
                let sessionIds = st.nodeRuns.compactMap(\.session_id)
                if firstCommits || st.run.status != "running" {
                    await loadCommits(api: api, sessionIds: sessionIds)
                    firstCommits = false
                }
                if st.run.status != "running" { break }
            } catch {
                if !load.hasData { load = .error }
                break
            }
            try? await Task.sleep(nanoseconds: 1_500_000_000)
        }
    }

    /// 이 run 의 노드 세션별 커밋을 sha 로 합쳐 dedupe — 폭주 방지로 세션 6개까지.
    @MainActor
    private func loadCommits(api: ApiClient, sessionIds: [String]) async {
        var seen = Set<String>()
        var merged: [GitCommit] = []
        for sid in sessionIds.prefix(6) {
            guard let resp = try? await api.gitCommits(sessionId: sid, limit: 20) else { continue }
            for c in resp.commits where !seen.contains(c.sha) {
                seen.insert(c.sha)
                merged.append(c)
            }
        }
        merged.sort { $0.date > $1.date }
        commits = merged
    }

    @MainActor
    private func stop() async {
        guard let rid = runId else { return }
        stopping = true
        defer { stopping = false }
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        try? await api.cancelWorkflowRun(runId: rid)
        // 취소 직후 한 번 상태를 새로 받아 «정지됨» 으로 갱신.
        if let st = try? await api.workflowRunState(runId: rid) {
            load = .loaded(st)
        }
    }
}

// MARK: - 로딩 상태

enum LoopMonitorLoad {
    case loading
    case empty
    case error
    case loaded(WorkflowRunStateResponse)

    var hasData: Bool {
        if case .loaded = self { return true }
        return false
    }
}

// MARK: - 파생 모델 (run 상태 → 화면 의미)

/// run 상태를 «루프 감독» 의미로 환원한 읽기전용 뷰모델. 색·라벨은 이 레포 약속을 따른다.
private struct LoopModel {
    let state: WorkflowRunStateResponse

    var isRunning: Bool { state.run.status == "running" }

    /// 현재 반복(되돌아간 횟수). 0 = 첫 시도.
    var iteration: Int { state.nodeRuns.compactMap(\.iteration).max() ?? 0 }

    /// 재시도 상한 — GET /runs/:id 의 run 객체에만 실린다. 없으면 nil(상한 표시 생략).
    var iterationCap: Int? { state.run.max_iterations }

    /// run 상태 라벨 — 진행/다음 반복 준비/완료/실패/정지됨. 캔버스 라벨(workflowStatusText)과
    /// 의미를 맞추되, cancelled 는 «정지됨»(사용자가 멈춤)으로, 반복 사이 idle 은 «다음 반복 준비 중» 으로.
    var statusText: Text {
        switch state.run.status {
        case "running":
            // 진행 중인 노드가 하나도 없고 이미 한 번 이상 되돌아갔으면 «반복 사이»(일시정지).
            let anyActive = state.nodeRuns.contains { $0.status == "running" }
            if !anyActive && iteration > 0 { return Text("다음 반복 준비 중") }
            return Text("실행 중")
        case "done": return Text("완료")
        case "failed": return Text("실패")
        case "cancelled": return Text("정지됨")
        default: return Text("대기 중")
        }
    }

    var iterationAccessibility: Text {
        if let cap = iterationCap {
            return Text("반복 \(iteration), 상한 \(cap)회")
        }
        return Text("반복 \(iteration)")
    }

    /// 마지막 검사 — verdict 가 명시된 가장 최근 노드. 통과/실패/없음 + 사유.
    var check: CheckResult {
        let verdictNodes = state.nodeRuns
            .filter { $0.verdict == "pass" || $0.verdict == "fail" }
            .sorted { ($0.ended_at ?? $0.created_at) > ($1.ended_at ?? $1.created_at) }
        guard let node = verdictNodes.first else { return .none }
        if node.verdict == "pass" {
            return .pass
        }
        return .fail(reason: failReason(node))
    }

    /// 검사 실패 사유 — 노드의 loopback_reason 우선, 없으면 다른 노드의 사유, 그래도 없으면 nil.
    private func failReason(_ node: WorkflowNodeRun) -> String? {
        if let r = node.loopback_reason?.trimmingCharacters(in: .whitespacesAndNewlines), !r.isEmpty {
            return r
        }
        for n in state.nodeRuns {
            if let r = n.loopback_reason?.trimmingCharacters(in: .whitespacesAndNewlines), !r.isEmpty {
                return r
            }
        }
        return nil
    }

    enum CheckResult {
        case none
        case pass
        case fail(reason: String?)

        var color: Color {
            switch self {
            case .none: return .secondary
            case .pass: return Theme.success
            case .fail: return Theme.danger
            }
        }

        var icon: String {
            switch self {
            case .none: return "questionmark.circle"
            case .pass: return "checkmark.circle.fill"
            case .fail: return "xmark.octagon.fill"
            }
        }

        var label: Text {
            switch self {
            case .none: return Text("아직 검사 없음")
            case .pass: return Text("검사 통과")
            case .fail: return Text("검사 실패")
            }
        }

        var reason: String? {
            if case .fail(let r) = self { return r }
            return nil
        }

        var accessibility: Text {
            switch self {
            case .none: return Text("검사 결과") + Text(verbatim: ": ") + Text("아직 검사 없음")
            case .pass: return Text("검사 결과") + Text(verbatim: ": ") + Text("검사 통과")
            case .fail(let r):
                let base = Text("검사 결과") + Text(verbatim: ": ") + Text("검사 실패")
                if let r { return base + Text(verbatim: ". " + r) }
                return base
            }
        }
    }
}

// MARK: - 빈/오류 placeholder

/// 빈·오류 상태 placeholder — IconSize 토큰 아이콘 + 제목 + (선택)설명. 본문색 자동 적응.
private struct LoopPlaceholder: View {
    let systemImage: String
    let title: LocalizedStringKey
    let message: LocalizedStringKey?

    var body: some View {
        VStack(spacing: Theme.Spacing.l) {
            Image(systemName: systemImage)
                .font(.system(size: Theme.IconSize.l))
                .foregroundStyle(.secondary)
            Text(title)
                .font(.headline)
                .multilineTextAlignment(.center)
            if let message {
                Text(message)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, Theme.Spacing.xxxl)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(.vertical, Theme.Spacing.xxxl)
    }
}
