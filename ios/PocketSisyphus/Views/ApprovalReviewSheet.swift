import SwiftUI

/// 승인 리뷰 시트 — 대기 중인 에이전트 승인 요청을 한 번에 검토/응답한다(행 + 모델 포함).
/// 원래 SessionsView.swift 안에 있던 것을 동작 그대로(접근 수준만 정리) 옮긴 것 — 행동보존 추출.

// MARK: - 승인 검토 시트 (대기 요청별 diff/요약 미리보기 + 선택적 묶음 승인)

/// 동시에 대기 중인 «승인 요청» 들을 한 시트에 모아, 각 세션이 «무엇을 바꾸려는가»(보류 prompt
/// 요약 + diff 요약 + 레포)와 함께 나열하고 개별 토글 후 «선택 승인»/«전체 승인»/개별 «거절» 을
/// 처리한다. 그룹 헤더 «모두 승인»·대기 배너 「검토」·대기 필터 헤더가 이 시트를 띄운다.
///
/// 색 = 의미 토큰 (DesignTokens 정책): 승인/추가=success(초록)·거절/실패=danger(빨강)·선택
/// 체크=accent(보라). diff 추가/삭제도 같은 success/danger. 본문은 `.primary`/`.secondary` 자동
/// 적응 — 하드코딩·전역 tint 없음. 간격/코너/불투명도는 Theme 토큰(4pt 그리드)을 쓴다.
struct ApprovalReviewSheet: View {
    let sessions: [SessionSummary]
    let auth: AuthStore
    let conn: ConnectionManager
    let inflight: InFlightTracker
    /// 승인/거절을 한 건이라도 처리한 뒤 부모가 활성 목록을 다시 받도록 알린다.
    var onFinished: () -> Void

    @Environment(\.dismiss) private var dismiss
    @StateObject private var model: ApprovalReviewModel

    init(
        sessions: [SessionSummary],
        auth: AuthStore,
        conn: ConnectionManager,
        inflight: InFlightTracker,
        onFinished: @escaping () -> Void,
    ) {
        self.sessions = sessions
        self.auth = auth
        self.conn = conn
        self.inflight = inflight
        self.onFinished = onFinished
        _model = StateObject(wrappedValue: ApprovalReviewModel(
            sessions: sessions, auth: auth, conn: conn, inflight: inflight,
        ))
    }

    var body: some View {
        NavigationStack {
            Group {
                if model.items.isEmpty {
                    emptyState
                } else {
                    list
                }
            }
            .navigationTitle("승인 검토")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    // 「닫기」 는 해제 동작 — 강조색이 아니라 중립(primary)으로 둔다(색 정책).
                    Button("닫기") { dismiss() }
                        .tint(Color.primary)
                }
            }
            .safeAreaInset(edge: .bottom) { footer }
        }
        .task { await model.loadDiffs() }
        // 처리(승인/거절)가 끝나 더 볼 게 없으면 자동으로 닫고 부모를 갱신한다.
        .onChange(of: model.didFinishAll) { finished in
            if finished {
                onFinished()
                dismiss()
            }
        }
    }

    // MARK: 빈 상태 — 진입 사이 대기 요청이 모두 사라진 경우 (placeholder 아이콘 토큰 사용).
    private var emptyState: some View {
        VStack(spacing: Theme.Spacing.xxl) {
            Image(systemName: "checkmark.circle")
                .font(.system(size: Theme.IconSize.l))
                .foregroundStyle(Theme.success)
            Text("지금 승인을 기다리는 요청이 없어요.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, Theme.Spacing.xxxl)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var list: some View {
        List {
            Section {
                ForEach(model.items) { item in
                    ApprovalReviewRow(
                        item: item,
                        onToggleSelect: { model.toggleSelect(item.id) },
                        onReject: { Task { await model.reject(item.id) } },
                    )
                }
            } footer: {
                Text("각 요청이 무엇을 바꾸려는지 확인하고, 골라서 승인하거나 모두 한 번에 승인하세요.")
                    .font(.caption)
            }
        }
        .listStyle(.insetGrouped)
    }

    // MARK: 하단 액션 바 — 처리할 게 남아 있으면 전체/선택 승인, 다 끝나면 완료.
    @ViewBuilder
    private var footer: some View {
        if !model.items.isEmpty {
            VStack(spacing: Theme.Spacing.m) {
                if model.hasActionable {
                    HStack(spacing: Theme.Spacing.xl) {
                        // 「전체 승인」 — 남은 모든 요청을 승인. 보조(테두리) 버튼.
                        Button {
                            Task { await model.approve(selectedOnly: false) }
                        } label: {
                            Text("전체 승인")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.bordered)
                        .tint(Theme.success)
                        .disabled(model.busy)
                        .accessibilityLabel(Text("대기 중인 요청 전체 승인"))

                        // 「선택 승인 (N)」 — 토글한 요청만 승인. 1차(채움) 버튼. 0건이면 비활성.
                        Button {
                            Task { await model.approve(selectedOnly: true) }
                        } label: {
                            Text("선택 승인 \(model.selectedActionableCount)")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(Theme.success)
                        .disabled(model.busy || model.selectedActionableCount == 0)
                        .accessibilityLabel(Text("선택한 요청 \(model.selectedActionableCount)건 승인"))
                    }
                    if model.busy {
                        ProgressView()
                    }
                } else {
                    Button {
                        onFinished()
                        dismiss()
                    } label: {
                        Text("완료")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(Theme.accent)
                }
            }
            .padding(.horizontal, Theme.Spacing.xxl)
            .padding(.vertical, Theme.Spacing.xl)
            .background(.bar)
        }
    }
}

/// 승인 검토 시트의 한 행 — 선택 체크(accent) + 제목 + 레포 + 보류 요약 + diff 요약 + 상태/거절.
struct ApprovalReviewRow: View {
    let item: ApprovalReviewModel.Item
    var onToggleSelect: () -> Void
    var onReject: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: Theme.Spacing.xl) {
            // 선택 체크 — 「무엇을 골라 승인하는가」. 처리 가능(대기/실패)일 때만 토글, 끝난 행은 비활성.
            // 선택 표식은 accent(보라) = 선택의 약속색.
            Button(action: onToggleSelect) {
                Image(systemName: item.selected ? "checkmark.circle.fill" : "circle")
                    .font(.title3)
                    .foregroundStyle(item.selected ? Theme.accent : Color.secondary)
            }
            .buttonStyle(.plain)
            .disabled(!item.actionable)
            .accessibilityLabel(item.selected ? Text("선택됨") : Text("선택 안 됨"))
            .accessibilityHint(Text("\(item.title) 승인 요청 선택 전환"))

            VStack(alignment: .leading, spacing: Theme.Spacing.s) {
                Text(item.title)
                    .font(.headline)
                    .lineLimit(1)
                    .truncationMode(.tail)

                Text(item.repoName)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)

                // 보류 요약 — 「지금 무엇을 묻고 멈췄는가」(실행하려는 명령/질문). 에이전트 출력이라
                // 번역 대상이 아니다 → verbatim. 없으면 줄을 그리지 않는다.
                if let preview = item.preview {
                    Text(verbatim: preview)
                        .font(.subheadline)
                        .foregroundStyle(.primary)
                        .lineLimit(3)
                        .padding(Theme.Spacing.m)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(
                            RoundedRectangle(cornerRadius: Theme.Radius.s)
                                .fill(Color.secondary.opacity(Theme.Opacity.hairline)),
                        )
                }

                diffSummary

                statusFooter
            }
        }
        .padding(.vertical, Theme.Spacing.xs)
    }

    // MARK: diff 요약 — 변경 파일 수 + 추가(success)/삭제(danger). 로딩/없음 상태 구분.
    @ViewBuilder
    private var diffSummary: some View {
        if !item.diffLoaded {
            // 로딩 중 — 그 세션의 변경 요약을 받는 중(보이는 만큼만 lazy fetch).
            HStack(spacing: Theme.Spacing.s) {
                ProgressView().controlSize(.mini)
                Text("변경 요약 불러오는 중…")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        } else if let diff = item.diff, diff.files > 0 {
            HStack(spacing: Theme.Spacing.l) {
                Label {
                    Text(verbatim: "\(diff.files)")
                } icon: {
                    Image(systemName: "doc.text")
                }
                .font(.caption)
                .foregroundStyle(.secondary)

                if diff.additions > 0 {
                    Text(verbatim: "+\(diff.additions)")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(Theme.success)
                }
                if diff.deletions > 0 {
                    Text(verbatim: "-\(diff.deletions)")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(Theme.danger)
                }
            }
            .labelStyle(.titleAndIcon)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text("변경 파일 \(diff.files)개, 추가 \(diff.additions)줄, 삭제 \(diff.deletions)줄"))
        } else {
            Text("변경 요약 없음")
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
    }

    // MARK: 상태/거절 — 대기 행은 「거절」(danger), 처리 후엔 결과 배지.
    @ViewBuilder
    private var statusFooter: some View {
        switch item.status {
        case .pending, .failed:
            HStack(spacing: Theme.Spacing.l) {
                if item.status == .failed {
                    Label("실패", systemImage: "exclamationmark.circle.fill")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Theme.danger)
                        .labelStyle(.titleAndIcon)
                }
                Spacer(minLength: 0)
                Button(role: .destructive, action: onReject) {
                    Label("거절", systemImage: "xmark")
                        .font(.caption.weight(.semibold))
                        .labelStyle(.titleAndIcon)
                }
                .buttonStyle(.bordered)
                .tint(Theme.danger)
                .accessibilityLabel(Text("이 요청 거절"))
            }
        case .approving:
            statusLabel(spinner: true, text: "승인 중", color: .secondary)
        case .rejecting:
            statusLabel(spinner: true, text: "거절 중", color: .secondary)
        case .approved:
            statusLabel(icon: "checkmark.circle.fill", text: "승인됨", color: Theme.success)
        case .rejected:
            statusLabel(icon: "xmark.circle.fill", text: "거절됨", color: Theme.danger)
        }
    }

    private func statusLabel(
        spinner: Bool = false,
        icon: String = "",
        text: LocalizedStringKey,
        color: Color,
    ) -> some View {
        HStack(spacing: Theme.Spacing.s) {
            if spinner {
                ProgressView().controlSize(.mini)
            } else {
                Image(systemName: icon)
            }
            Text(text)
        }
        .font(.caption.weight(.semibold))
        .foregroundStyle(color)
    }
}

/// 승인 검토 시트의 상태 머신 — 각 대기 세션을 항목으로 들고, diff 요약을 lazy 로 채우며,
/// per-session pty 제어(승인=Enter / 거절=ESC)를 직렬 전송한다. 한 건 실패해도 나머지는 계속
/// (부분 성공 허용). 모든 항목이 처리되면 didFinishAll 로 시트 자동 종료를 신호한다.
@MainActor
final class ApprovalReviewModel: ObservableObject {
    /// 한 요청의 처리 상태 — 대기·승인중·승인됨·거절중·거절됨·실패.
    enum RowStatus: Equatable { case pending, approving, approved, rejecting, rejected, failed }

    /// diff 요약 — 변경 파일 수 + 추가/삭제 라인 합.
    struct DiffSummary: Equatable {
        let files: Int
        let additions: Int
        let deletions: Int
    }

    struct Item: Identifiable {
        let session: SessionSummary
        var selected: Bool
        var status: RowStatus
        /// diff 요약을 받았는지 — false 면 행이 로딩 표시.
        var diffLoaded: Bool
        /// 받은 diff 요약 — 없거나(받기 실패/비-repo) 변경 0건이면 nil.
        var diff: DiffSummary?

        var id: String { session.id }
        var title: String { session.title ?? String(localized: "제목 없음") }
        var repoName: String { RepoGroupHeader.displayName(session.repo_path) }
        var preview: String? { session.pendingPromptPreview }
        /// 처리 가능 — 아직 대기 중이거나 실패해 재시도할 수 있는 행.
        var actionable: Bool { status == .pending || status == .failed }
    }

    @Published var items: [Item]
    /// 전체/선택 승인 진행 중 — 버튼 비활성·스피너 게이트.
    @Published var busy = false
    /// 모든 항목이 처리돼(처리 가능한 행이 0) 시트를 닫아도 되는지.
    @Published var didFinishAll = false

    private let auth: AuthStore
    private let conn: ConnectionManager
    private let inflight: InFlightTracker

    init(sessions: [SessionSummary], auth: AuthStore, conn: ConnectionManager, inflight: InFlightTracker) {
        self.auth = auth
        self.conn = conn
        self.inflight = inflight
        // 기본 전체 선택 — 「골라서 빼는」 흐름이 일반적인 일괄 승인보다 안전하고 빠르다.
        self.items = sessions.map {
            Item(session: $0, selected: true, status: .pending, diffLoaded: false, diff: nil)
        }
    }

    /// 처리 가능(대기/실패)한 항목이 남아 있는지 — 하단 바가 승인 버튼/완료를 가른다.
    var hasActionable: Bool { items.contains { $0.actionable } }
    /// 선택된 처리 가능 항목 수 — 「선택 승인 (N)」 배지/활성 게이트.
    var selectedActionableCount: Int { items.filter { $0.actionable && $0.selected }.count }

    /// 각 세션의 변경 요약을 직렬로 받아 채운다(목록 fetch엔 없어 lazy). label nil — in-flight
    /// 배너에 잡히지 않게 조용히. 실패/비-repo 는 diff nil 로 흡수(행은 「변경 요약 없음」).
    func loadDiffs() async {
        let api = ApiClient(auth: auth, conn: conn, tracker: nil)
        for idx in items.indices {
            let sid = items[idx].session.id
            let status = try? await api.gitStatus(sessionId: sid, label: nil)
            let summary = status.map { s in
                DiffSummary(
                    files: s.total,
                    additions: s.files.reduce(0) { $0 + $1.additions },
                    deletions: s.files.reduce(0) { $0 + $1.deletions },
                )
            }
            if let i = items.firstIndex(where: { $0.id == sid }) {
                items[i].diffLoaded = true
                items[i].diff = summary
            }
        }
    }

    func toggleSelect(_ id: String) {
        guard let i = items.firstIndex(where: { $0.id == id }) else { return }
        guard items[i].actionable else { return }
        items[i].selected.toggle()
    }

    /// 승인 — selectedOnly 면 토글한 처리 가능 항목만, 아니면 처리 가능 항목 전부에 Enter 를
    /// 직렬 전송한다. 각 행을 승인중→승인됨/실패로 전이. 끝나면 완료 여부를 재평가.
    func approve(selectedOnly: Bool) async {
        let targets = items.filter { $0.actionable && (selectedOnly ? $0.selected : true) }.map { $0.id }
        guard !targets.isEmpty else { return }
        busy = true
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        for sid in targets {
            setStatus(sid, .approving)
            let ok = await send(api, sid, .approve)
            setStatus(sid, ok ? .approved : .failed)
        }
        busy = false
        evaluateFinish()
    }

    /// 거절 — 한 행에 ESC(진행 turn 중단)를 보낸다. 거절중→거절됨/실패.
    func reject(_ id: String) async {
        guard items.contains(where: { $0.id == id && $0.actionable }) else { return }
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        setStatus(id, .rejecting)
        let ok = await send(api, id, .interrupt)
        setStatus(id, ok ? .rejected : .failed)
        evaluateFinish()
    }

    private func send(_ api: ApiClient, _ sid: String, _ action: PtyControlAction) async -> Bool {
        do {
            try await api.ptyControl(sessionId: sid, action: action)
            return true
        } catch {
            return false
        }
    }

    private func setStatus(_ id: String, _ status: RowStatus) {
        guard let i = items.firstIndex(where: { $0.id == id }) else { return }
        items[i].status = status
    }

    private func evaluateFinish() {
        if !hasActionable { didFinishAll = true }
    }
}
