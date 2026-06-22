import SwiftUI

/// 「반복 실행」(repeat_run_v1) — 워크플로우 캔버스 없이, 폰에서 30초에 거는 «랄프 루프».
///
/// «하나의 목표를 통과할 때까지 매번 새 컨텍스트로 다시 실행» 을 (repo·에이전트·목표 스펙·완료
/// 검사·최대 횟수)만 골라 건다. daemon 이 자기교정 루프를 합성해 엔진으로 돌리고(workflow/repeat.ts),
/// 매 회 새 세션(=새 컨텍스트)으로 같은 스펙을 다시 실행한다. 점검이 통과(완료)거나 최대 횟수에
/// 닿으면(실패) 멈춘다.
///
/// 색 정책(이 레포 약속): 이 기능은 「자동화」 탭(프로·주황) 안에 살지만, «탭 버튼» 만 주황이다 —
/// 시트/콘텐츠 내부 버튼(시작·취소)은 기본 틴트(accent=보라)를 그대로 쓴다(.tint(pro) 금지).
/// 완료는 success(초록), «반복 중지» 같은 파괴적 동작은 danger(빨강). 리터럴 .orange/.yellow/.blue
/// 금지 — 의미 토큰만 쓴다. 본문은 .primary/.secondary(테마 적응), 간격/코너는 4pt 그리드 토큰.

// MARK: - 시작 시트

/// 「반복 실행」 시작 폼 — repo·에이전트·목표 스펙·완료 검사·최대 횟수 + 격리/승인 옵션.
/// 시작하면 부모에게 runId 를 넘기고 닫힌다(부모가 진행 상태 화면으로 push).
struct RepeatRunSheet: View {
    let auth: AuthStore
    let conn: ConnectionManager
    let inflight: InFlightTracker
    /// 시작 성공 → runId 를 부모에 넘긴다(부모가 진행 화면으로 push + 목록 reload).
    let onStarted: (_ runId: String) -> Void

    @Environment(\.dismiss) private var dismiss

    @State private var repoPath = ""
    @State private var goal = ""
    @State private var check = ""
    @State private var maxIterations = 5
    @State private var isolated = true
    @State private var skipPermissions = true

    @State private var agents: [AgentInfo] = [AgentInfo.claudeCodeFallback]
    @State private var selectedAgentId = AgentInfo.claudeCodeFallback.id

    @State private var starting = false
    @State private var startError: String?

    private func trimmed(_ s: String) -> String { s.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var hasRepo: Bool { !trimmed(repoPath).isEmpty }
    private var hasGoal: Bool { !trimmed(goal).isEmpty }
    private var hasCheck: Bool { !trimmed(check).isEmpty }
    private var canStart: Bool { hasRepo && hasGoal && hasCheck && !starting }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    RepoPathField(auth: auth, conn: conn, inflight: inflight, repoPath: $repoPath)
                } header: {
                    Text("repo 경로")
                } footer: {
                    Text("최근 프로젝트·폴더 칩을 탭해 경로를 빠르게 채울 수 있어요. 반복은 이 repo 에서 돌아요.")
                }

                Section {
                    VoiceInputField("예: 결제 모듈 테스트를 모두 통과시켜줘", text: $goal, lineLimit: 2...6)
                } header: {
                    Text("목표 스펙")
                } footer: {
                    Text("매 회 새 컨텍스트로 다시 먹일 지시예요. 무엇을 끝까지 해내야 하는지 적어요.")
                }

                Section {
                    VoiceInputField("예: 모든 테스트가 통과하면 완료", text: $check, lineLimit: 2...5)
                } header: {
                    Text("완료 검사")
                } footer: {
                    Text("이 검사가 통과하면 반복을 멈춰요. 통과/실패를 분명히 판정할 수 있게 적어요.")
                }

                agentSection

                Section {
                    Stepper(value: $maxIterations, in: 1...10) {
                        HStack {
                            Text("최대 횟수")
                            Spacer()
                            Text(verbatim: "\(maxIterations)")
                                .foregroundStyle(.secondary)
                        }
                    }
                    .accessibilityLabel(Text("최대 반복 횟수"))
                    .accessibilityValue(Text(verbatim: "\(maxIterations)"))
                } footer: {
                    Text("완료 검사가 끝내 통과하지 못하면 이 횟수에서 멈춰요(상한 10).")
                }

                Section {
                    Toggle(isOn: $isolated) {
                        Text("격리 worktree 에서 실행")
                    }
                    .accessibilityLabel(Text("격리 worktree 에서 실행"))
                    Toggle(isOn: $skipPermissions) {
                        Text("민감한 작업 자동 승인")
                    }
                    .accessibilityLabel(Text("민감한 작업 자동 승인"))
                } header: {
                    Text("무인 실행")
                } footer: {
                    Text("자리를 비운 사이 돌아가요. 격리는 다른 작업과 파일이 섞이지 않게 막고, 자동 승인을 끄면 승인 프롬프트에서 멈출 수 있어요.")
                }

                if let startError {
                    Section {
                        Text(startError)
                            .font(.callout)
                            .foregroundStyle(Theme.danger)
                    }
                }
            }
            .navigationTitle("반복 실행")
            .navigationBarTitleDisplayMode(.inline)
            .voiceDictationChrome()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("취소") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if starting {
                        ProgressView()
                    } else {
                        // 시작 버튼은 기본 틴트(accent=보라) — 시트 콘텐츠에 pro(주황) 금지.
                        Button("시작") { Task { await start() } }
                            .disabled(!canStart)
                    }
                }
            }
            .task { await loadAgents() }
        }
    }

    /// 실행/점검 에이전트 픽커 — 무인(PTY bypass)으로 도므로 cron 과 같은 cron_eligible_v1 후보만.
    private var agentSection: some View {
        Section {
            Picker(selection: $selectedAgentId) {
                ForEach(agents) { a in
                    HStack(spacing: Theme.Spacing.m) {
                        Image(systemName: AgentKind.from(id: a.id).systemImage)
                        Text(a.displayName)
                        if !a.isInstalled {
                            Text("설정 필요").font(.caption2).foregroundStyle(Theme.warning)
                        }
                    }
                    .tag(a.id)
                }
            } label: {
                Text("에이전트")
            }
            .pickerStyle(.inline)
            .labelsHidden()
            .accessibilityLabel(Text("실행 에이전트"))
        } header: {
            Text("에이전트")
        } footer: {
            Text("이 에이전트가 매 회 목표를 다시 실행하고 완료 검사를 판정해요.")
        }
    }

    private func loadAgents() async {
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        if let list = try? await api.listAgents(label: nil), !list.isEmpty {
            let eligible = list.filter { $0.capabilities.contains("cron_eligible_v1") }
            let shown = eligible.isEmpty ? list : eligible
            agents = shown
            if !shown.contains(where: { $0.id == selectedAgentId }) {
                selectedAgentId = shown.first!.id
            }
        }
    }

    private func start() async {
        guard canStart else { return }
        starting = true
        startError = nil
        defer { starting = false }
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        let req = StartRepeatRunRequest(
            repoPath: trimmed(repoPath),
            agent: selectedAgentId,
            goal: trimmed(goal),
            check: trimmed(check),
            maxIterations: maxIterations,
            isolated: isolated,
            skipPermissions: skipPermissions,
        )
        do {
            let resp = try await api.startRepeatRun(req)
            dismiss()
            onStarted(resp.runId)
        } catch {
            startError = String(localized: "반복 실행을 시작하지 못했어요: \(error.localizedDescription)")
        }
    }
}

// MARK: - 진행 상태 화면

/// 「반복 실행」 진행 상태 — 시작/로딩·진행(반복 N/상한)·완료(검사 통과)·실패(상한 도달)를 보여준다.
/// 진행 중이면 2초마다 폴링하고, 진행 중일 때만 «반복 중지»(danger) 를 노출한다.
struct RepeatRunStatusView: View {
    let auth: AuthStore
    let conn: ConnectionManager
    let inflight: InFlightTracker
    let runId: String

    @State private var run: RepeatRun?
    @State private var loading = true
    @State private var loadError: String?
    @State private var cancelling = false
    @State private var pollTask: Task<Void, Never>?

    var body: some View {
        Group {
            if loading && run == nil {
                LoadingStateView(message: "반복 실행을 불러오는 중…")
            } else if let run {
                content(run)
            } else if let loadError {
                ErrorStateView(
                    title: "반복 실행을 불러올 수 없어요",
                    message: loadError,
                    tint: Theme.warning,
                ) { Task { await load() } }
            }
        }
        .navigationTitle("반복 실행")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load(); startPolling() }
        .onDisappear { pollTask?.cancel() }
    }

    @ViewBuilder
    private func content(_ run: RepeatRun) -> some View {
        ScrollView {
            VStack(spacing: Theme.Spacing.xxl) {
                statusHeader(run)

                VStack(alignment: .leading, spacing: Theme.Spacing.l) {
                    if let goal = run.goal, !goal.isEmpty {
                        labeled("목표 스펙", goal)
                    }
                    if let check = run.check, !check.isEmpty {
                        labeled("완료 검사", check)
                    }
                    if let repo = run.repo_path, !repo.isEmpty {
                        labeled("repo", repo)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(Theme.Spacing.xl)
                .background(
                    RoundedRectangle(cornerRadius: Theme.Radius.l)
                        .fill(Color.secondary.opacity(Theme.Opacity.hairline)),
                )

                if run.isRunning {
                    Button(role: .destructive) {
                        Task { await cancel() }
                    } label: {
                        if cancelling {
                            ProgressView()
                        } else {
                            Label("반복 중지", systemImage: "stop.circle")
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(Theme.danger)
                    .disabled(cancelling)
                    .accessibilityLabel(Text("반복 중지"))
                }
            }
            .padding(Theme.Spacing.xl)
        }
    }

    /// 상태 헤더 — 상태별 아이콘(의미색) + «반복 N/상한» + 한 줄 설명. 본문은 .primary/.secondary.
    @ViewBuilder
    private func statusHeader(_ run: RepeatRun) -> some View {
        VStack(spacing: Theme.Spacing.l) {
            ZStack {
                if run.isRunning {
                    ProgressView()
                        .controlSize(.large)
                } else {
                    Image(systemName: statusIcon(run))
                        .font(.system(size: Theme.IconSize.xl))
                        .foregroundStyle(statusTint(run))
                        .accessibilityHidden(true)
                }
            }
            .frame(height: Theme.IconSize.xl)

            Text(statusTitle(run))
                .font(.headline)
                .foregroundStyle(.primary)
                .multilineTextAlignment(.center)

            // 반복 회차 / 상한 — 진행·완료·실패 모두에서 «어디까지 돌았나» 를 보여준다.
            Text("반복 \(run.iteration)/\(run.max_iterations)")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .accessibilityLabel(Text("반복 \(run.iteration) / 최대 \(run.max_iterations)"))

            Text(statusDetail(run))
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, Theme.Spacing.xl)
    }

    private func labeled(_ title: LocalizedStringKey, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            Text(value)
                .font(.callout)
                .foregroundStyle(.primary)
                .textSelection(.enabled)
        }
    }

    private func statusIcon(_ run: RepeatRun) -> String {
        if run.isCompleted { return "checkmark.circle.fill" }
        if run.isFailed { return "exclamationmark.triangle.fill" }
        if run.status == "cancelled" { return "stop.circle.fill" }
        return "arrow.triangle.2.circlepath"
    }

    private func statusTint(_ run: RepeatRun) -> Color {
        if run.isCompleted { return Theme.success }
        if run.isFailed { return Theme.danger }
        return .secondary
    }

    private func statusTitle(_ run: RepeatRun) -> LocalizedStringKey {
        if run.isRunning { return "반복하는 중" }
        if run.isCompleted { return "완료 — 검사 통과" }
        if run.isFailed {
            return run.limit_reached ? "멈춤 — 최대 횟수 도달" : "멈춤 — 실패"
        }
        if run.status == "cancelled" { return "중지됨" }
        return "반복 실행"
    }

    private func statusDetail(_ run: RepeatRun) -> LocalizedStringKey {
        if run.isRunning { return "매 회 새 컨텍스트로 같은 스펙을 다시 실행하고 있어요." }
        if run.isCompleted { return "완료 검사를 통과해 반복을 멈췄어요." }
        if run.isFailed {
            return run.limit_reached
                ? "최대 횟수까지 돌았지만 완료 검사를 통과하지 못했어요."
                : "반복 중 오류로 멈췄어요."
        }
        if run.status == "cancelled" { return "사용자가 반복을 중지했어요." }
        return ""
    }

    private func load() async {
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        do {
            run = try await api.repeatRunState(runId: runId)
            loadError = nil
        } catch {
            if run == nil { loadError = error.localizedDescription }
        }
        loading = false
    }

    /// 진행 중이면 2초마다 폴링 — 완료/실패/중지로 끝나면 멈춘다.
    private func startPolling() {
        pollTask?.cancel()
        pollTask = Task {
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 2_000_000_000)
                if Task.isCancelled { break }
                await load()
                if let run, !run.isRunning { break }
            }
        }
    }

    private func cancel() async {
        cancelling = true
        defer { cancelling = false }
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        try? await api.cancelRepeatRun(runId: runId)
        await load()
    }
}

// MARK: - 목록 행 (자동화 탭 섹션)

/// 「반복 실행」 목록 행 — 자동화 탭의 워크플로우 목록 상단 섹션에 진행/완료/실패를 압축해 보여준다.
struct RepeatRunRow: View {
    let run: RepeatRun

    var body: some View {
        HStack(spacing: Theme.Spacing.l) {
            if run.isRunning {
                ProgressView()
                    .frame(width: 22)
            } else {
                Image(systemName: icon)
                    .foregroundStyle(tint)
                    .frame(width: 22)
                    .accessibilityHidden(true)
            }
            VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
                Text(run.goal ?? String(localized: "반복 실행"))
                    .font(.subheadline)
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
        }
        .padding(.vertical, Theme.Spacing.xxs)
        .accessibilityElement(children: .combine)
    }

    private var icon: String {
        if run.isCompleted { return "checkmark.circle.fill" }
        if run.isFailed { return "exclamationmark.triangle.fill" }
        if run.status == "cancelled" { return "stop.circle.fill" }
        return "arrow.triangle.2.circlepath"
    }

    private var tint: Color {
        if run.isCompleted { return Theme.success }
        if run.isFailed { return Theme.danger }
        return .secondary
    }

    private var subtitle: String {
        let counter = String(localized: "반복 \(run.iteration)/\(run.max_iterations)")
        let state: String
        if run.isRunning { state = String(localized: "반복하는 중") }
        else if run.isCompleted { state = String(localized: "완료") }
        else if run.isFailed { state = String(localized: "실패") }
        else if run.status == "cancelled" { state = String(localized: "중지됨") }
        else { state = "" }
        return state.isEmpty ? counter : "\(state) · \(counter)"
    }
}

/// 진행 화면 push 용 식별자 래퍼 (String 은 Identifiable 이 아니라).
struct RepeatRunRef: Identifiable, Hashable {
    let runId: String
    var id: String { runId }
}
