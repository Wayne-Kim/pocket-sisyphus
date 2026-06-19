import SwiftUI

/// BranchSheet 에서 진입하는 커밋 기록 화면들 (3단계 push).
///   1. CommitsView       — 커밋 로그 리스트(페이지네이션). 행 탭 → CommitDetailView.
///   2. CommitDetailView  — 한 커밋 메타 + 변경 파일 목록(DiffFileRow 재사용). 파일 탭 → CommitFileDiffView.
///   3. CommitFileDiffView — 그 커밋이 그 파일에 가한 변경만 unified diff (DiffBody 재사용).
///
/// 의존성은 DiffSheet / BranchSheet 와 동일하게 클로저로 받는다 — ChatViewModel 을 직접 모른다.
/// 화면 전환 payload(`CommitsTarget` / `GitCommit` / `CommitFileTarget`)는 BranchSheet 의
/// NavigationStack 이 value-based `navigationDestination` 으로 받아 이 뷰들을 만든다.

/// 커밋 로그를 어느 기준으로 볼지 — value-based push payload.
struct CommitsTarget: Hashable {
    /// nil 이면 현재 HEAD. 아니면 브랜치명("main", "origin/foo") 또는 커밋 ref.
    let ref: String?
    /// 화면 제목용(브랜치명 그대로 — 번역 대상 아님).
    let title: String
}

/// 한 커밋 안의 한 파일 — CommitDetailView → CommitFileDiffView push payload.
struct CommitFileTarget: Hashable {
    let sha: String
    let file: GitStatusFile
}

// MARK: - 1단계: 커밋 로그

struct CommitsView: View {
    let target: CommitsTarget
    let loadCommits: (_ ref: String?, _ limit: Int, _ skip: Int) async -> GitCommitsResponse?
    /// (sha, mode) → 체크포인트로 되돌리기. mode="revert"(비파괴)/"reset"(파괴).
    let rollback: (_ sha: String, _ mode: String) async throws -> GitRollbackResult
    /// 에이전트 실행 중인지 — true 면 «되돌리기» 를 잠그고 안내만 띄운다.
    let isAgentBusy: Bool

    @State private var commits: [GitCommit] = []
    @State private var loading = true
    @State private var loadingMore = false
    @State private var didFail = false
    /// 마지막 페이지가 limit 미만으로 와서 더 받을 게 없음.
    @State private var reachedEnd = false

    // 되돌리기 — 1단계(안전/파괴 선택) · 2단계(파괴 재확인) · 진행/결과.
    /// 1단계 dialog 대상(«이 시점으로 되돌리기» 를 탭한 체크포인트).
    @State private var rollbackTarget: GitCommit?
    /// 2단계 dialog 대상(파괴적 reset 재확인). 비파괴 revert 는 1단계에서 바로 실행.
    @State private var resetConfirmTarget: GitCommit?
    @State private var rollbackBusy = false
    @State private var rollbackError: String?
    /// 성공/잠금 등 안내 — alert «알림».
    @State private var notice: String?

    private let pageSize = 50

    var body: some View {
        Group {
            if loading && commits.isEmpty {
                ProgressView().controlSize(.large)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if commits.isEmpty {
                if didFail {
                    DiffEmptyState(
                        title: "불러오기 실패",
                        systemImage: "exclamationmark.triangle",
                        message: "연결이 회복되면 다시 시도된다.",
                    )
                } else {
                    DiffEmptyState(
                        title: "커밋이 없어요",
                        systemImage: "clock",
                        message: "이 브랜치에는 아직 커밋이 없어요.",
                    )
                }
            } else {
                List {
                    ForEach(commits) { commit in
                        NavigationLink(value: commit) {
                            CommitRow(commit: commit)
                        }
                        // 체크포인트 항목에만 «이 시점으로 되돌리기» 를 노출 — swipe + 길게눌러 메뉴.
                        .swipeActions(edge: .leading) {
                            if commit.isCheckpoint {
                                Button {
                                    requestRollback(commit)
                                } label: {
                                    Label("되돌리기", systemImage: "arrow.uturn.backward")
                                }
                                .tint(Theme.pro)
                            }
                        }
                        .contextMenu {
                            if commit.isCheckpoint {
                                Button {
                                    requestRollback(commit)
                                } label: {
                                    Label("이 시점으로 되돌리기", systemImage: "arrow.uturn.backward")
                                }
                            }
                        }
                    }
                    if !reachedEnd {
                        Button { Task { await loadMore() } } label: {
                            HStack {
                                Spacer()
                                if loadingMore {
                                    ProgressView()
                                } else {
                                    Text("더 보기")
                                }
                                Spacer()
                            }
                        }
                        .disabled(loadingMore)
                    }
                }
                .listStyle(.plain)
            }
        }
        .navigationTitle(target.title)
        .navigationBarTitleDisplayMode(.inline)
        .task { if commits.isEmpty { await initialLoad() } }
        // 되돌리기 진행 중 — 전체 스피너 + 입력 잠금(목록이 바뀌는 동안 중복 탭 방지).
        .overlay {
            if rollbackBusy {
                ProgressView()
                    .controlSize(.large)
                    .padding(24)
                    .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14))
            }
        }
        .disabled(rollbackBusy)
        // 1단계 — 안전(비파괴) vs 파괴 선택. 비파괴는 여기서 바로 실행, 파괴는 2단계로.
        .confirmationDialog(
            "이 시점으로 되돌릴까요?",
            isPresented: Binding(get: { rollbackTarget != nil }, set: { if !$0 { rollbackTarget = nil } }),
            titleVisibility: .visible,
            presenting: rollbackTarget,
        ) { commit in
            Button("안전하게 되돌리기") { performRollback(commit, mode: "revert") }
            Button("기록까지 되돌리기…", role: .destructive) {
                rollbackTarget = nil
                resetConfirmTarget = commit
            }
            Button("취소", role: .cancel) {}
        } message: { _ in
            Text("«안전하게» 는 기록을 지우지 않고 되돌려요(권장). 어느 쪽이든 지금 상태는 자동 체크포인트로 먼저 저장돼요.")
        }
        // 2단계 — 파괴적 reset 재확인.
        .confirmationDialog(
            "기록을 지우고 되돌릴까요?",
            isPresented: Binding(get: { resetConfirmTarget != nil }, set: { if !$0 { resetConfirmTarget = nil } }),
            titleVisibility: .visible,
            presenting: resetConfirmTarget,
        ) { commit in
            Button("이후 커밋을 지우고 되돌리기", role: .destructive) {
                performRollback(commit, mode: "reset")
            }
            Button("취소", role: .cancel) {}
        } message: { _ in
            Text("이 시점 이후의 커밋이 사라져요. 그래도 되돌리기 전 자동 체크포인트로 복구할 수 있어요.")
        }
        .alert(
            "되돌리지 못했어요",
            isPresented: Binding(get: { rollbackError != nil }, set: { if !$0 { rollbackError = nil } }),
        ) {
            Button("확인", role: .cancel) { rollbackError = nil }
        } message: {
            Text(verbatim: rollbackError ?? "")
        }
        .alert(
            "알림",
            isPresented: Binding(get: { notice != nil }, set: { if !$0 { notice = nil } }),
        ) {
            Button("확인", role: .cancel) { notice = nil }
        } message: {
            Text(verbatim: notice ?? "")
        }
    }

    /// «되돌리기» 트리거 — 에이전트 실행 중이면 잠그고 안내만, 아니면 1단계 dialog 를 띄운다.
    private func requestRollback(_ commit: GitCommit) {
        if isAgentBusy {
            notice = String(localized: "에이전트가 실행 중이에요. 끝난 뒤에 되돌릴 수 있어요.")
            return
        }
        rollbackTarget = commit
    }

    /// 되돌리기 실행 — 성공하면 목록을 새로 받아 새 체크포인트/되돌림 커밋을 보여주고 안내한다.
    private func performRollback(_ commit: GitCommit, mode: String) {
        rollbackTarget = nil
        resetConfirmTarget = nil
        guard !rollbackBusy else { return }
        rollbackBusy = true
        Task {
            defer { rollbackBusy = false }
            do {
                _ = try await rollback(commit.sha, mode)
                await initialLoad()
                notice = String(localized: "이 시점으로 되돌렸어요. 되돌리기 전 상태는 자동 체크포인트로 저장해 두었어요.")
            } catch {
                rollbackError = error.localizedDescription
            }
        }
    }

    private func initialLoad() async {
        loading = true
        didFail = false
        let resp = await loadCommits(target.ref, pageSize, 0)
        if let resp {
            commits = resp.commits
            reachedEnd = resp.commits.count < pageSize
        } else {
            didFail = true
        }
        loading = false
    }

    private func loadMore() async {
        guard !loadingMore, !reachedEnd else { return }
        loadingMore = true
        defer { loadingMore = false }
        let resp = await loadCommits(target.ref, pageSize, commits.count)
        guard let resp else {
            // 일시 실패 — 버튼은 그대로 둔다(다시 누르면 재시도).
            return
        }
        // sha 기준 중복 제거 — skip 페이지 사이에 새 커밋이 끼어들어도 키 충돌이 없게.
        let known = Set(commits.map(\.sha))
        commits.append(contentsOf: resp.commits.filter { !known.contains($0.sha) })
        if resp.commits.count < pageSize { reachedEnd = true }
    }
}

/// 커밋 로그 한 줄 — 제목 + (작성자 · 짧은 sha · 상대시간).
private struct CommitRow: View {
    let commit: GitCommit

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(verbatim: commit.subject)
                .font(.callout)
                .lineLimit(2)
            HStack(spacing: 6) {
                Text(verbatim: commit.shortSha)
                    .font(.caption2.monospaced())
                    .foregroundStyle(Theme.accent)
                if !commit.author.isEmpty {
                    Text(verbatim: "·")
                    Text(verbatim: commit.author).lineLimit(1)
                }
                let rel = CommitDate.relative(commit.date)
                if !rel.isEmpty {
                    Text(verbatim: "·")
                    Text(verbatim: rel)
                }
            }
            .font(.caption2)
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, 2)
    }
}

// MARK: - 2단계: 커밋 상세 (메타 + 변경 파일)

struct CommitDetailView: View {
    let commit: GitCommit
    let loadDetail: (_ sha: String) async -> GitCommitDetail?

    @State private var detail: GitCommitDetail?
    @State private var isLoading = false

    var body: some View {
        Group {
            if isLoading && detail == nil {
                ProgressView().controlSize(.large)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let detail {
                List {
                    Section {
                        CommitHeader(detail: detail)
                    }
                    if detail.files.isEmpty {
                        Section {
                            Text("변경 내용 없음").foregroundStyle(.secondary)
                        }
                    } else {
                        Section("변경 파일") {
                            ForEach(detail.files) { file in
                                NavigationLink(value: CommitFileTarget(sha: detail.sha, file: file)) {
                                    DiffFileRow(file: file)
                                }
                            }
                        }
                    }
                }
                .listStyle(.insetGrouped)
            } else {
                DiffEmptyState(
                    title: "불러오기 실패",
                    systemImage: "exclamationmark.triangle",
                    message: "연결이 회복되면 다시 시도된다.",
                )
            }
        }
        .navigationTitle(commit.shortSha)
        .navigationBarTitleDisplayMode(.inline)
        .task {
            isLoading = true
            detail = await loadDetail(commit.sha)
            isLoading = false
        }
    }
}

/// 커밋 상세 헤더 — 제목 / 본문 / 작성자·시간 / 짧은 sha.
private struct CommitHeader: View {
    let detail: GitCommitDetail

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(verbatim: detail.subject)
                .font(.headline)
            if !detail.body.isEmpty {
                Text(verbatim: detail.body)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
            HStack(spacing: 14) {
                if !detail.author.isEmpty {
                    Label { Text(verbatim: detail.author) } icon: { Image(systemName: "person") }
                }
                let rel = CommitDate.relative(detail.date)
                if !rel.isEmpty {
                    Label { Text(verbatim: rel) } icon: { Image(systemName: "clock") }
                }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            Text(verbatim: detail.shortSha)
                .font(.caption.monospaced())
                .foregroundStyle(.tertiary)
        }
        .padding(.vertical, 4)
    }
}

// MARK: - 3단계: 한 커밋 안 한 파일의 diff

struct CommitFileDiffView: View {
    let target: CommitFileTarget
    let loadDiff: (_ sha: String, _ path: String) async -> GitFileDiffResponse?

    @State private var response: GitFileDiffResponse?
    @State private var isLoading = false
    @State private var didFail = false

    var body: some View {
        Group {
            if isLoading && response == nil {
                ProgressView().controlSize(.large)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let resp = response {
                if resp.binary {
                    DiffEmptyState(
                        title: "바이너리 파일",
                        systemImage: "doc.zipper",
                        message: "미리 보기를 지원하지 않는다.",
                    )
                } else if resp.diff.isEmpty {
                    DiffEmptyState(
                        title: "변경 내용 없음",
                        systemImage: "doc",
                        message: "표시할 diff 본문이 비어 있다.",
                    )
                } else {
                    DiffBody(diff: resp.diff, truncated: resp.truncated, untracked: false, path: target.file.path)
                }
            } else if didFail {
                DiffEmptyState(
                    title: "불러오기 실패",
                    systemImage: "exclamationmark.triangle",
                    message: "연결이 회복되면 다시 시도된다.",
                )
            } else {
                Color.clear
            }
        }
        .navigationTitle(target.file.path)
        .navigationBarTitleDisplayMode(.inline)
        .task {
            isLoading = true
            didFail = false
            response = await loadDiff(target.sha, target.file.path)
            if response == nil { didFail = true }
            isLoading = false
        }
    }
}

// MARK: - 날짜 포맷

/// ISO-8601 author date 를 시스템 로케일의 상대시간("3일 전")으로. 파싱 실패면 원문 그대로.
/// formatter 는 비싸서 한 번만 만들어 재사용한다.
private enum CommitDate {
    private static let parser: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    private static let relativeFormatter: RelativeDateTimeFormatter = {
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .abbreviated
        return f
    }()

    static func relative(_ iso: String) -> String {
        guard let date = parser.date(from: iso) else { return iso }
        return relativeFormatter.localizedString(for: date, relativeTo: Date())
    }

    /// 분 단위 버킷 키 — 같은 분에 연속으로 쌓인 자동 체크포인트를 묶는 데만 쓴다(표시용 아님).
    /// 파싱 실패면 원문을 그대로 키로 — 못 묶고 각각 단독으로 남는다(안전 쪽).
    static func minuteBucket(_ iso: String) -> String {
        guard let date = parser.date(from: iso) else { return iso }
        return String(Int(date.timeIntervalSince1970 / 60))
    }
}

// MARK: - 체크포인트 타임라인

/// BranchSheet 「기록」 에서 진입하는 «체크포인트» 화면 push payload(value-based).
/// 단일 목적지라 필드가 없다 — BranchSheet 의 navigationDestination 이 이 타입으로 화면을 만든다.
struct CheckpointsTarget: Hashable {}

/// 한 화면에서 직전 안전 지점으로 되돌리는 «안전망» 타임라인.
///
/// 전체 커밋 로그를 스크롤해 `checkpoint(ps):` 줄을 눈으로 찾는 마찰을 없앤다 — daemon 이 식별
/// prefix 커밋만 grep 해 돌려주고(`loadCheckpoints`), 이 뷰는 최신순으로 시각/노트/자동·수동을
/// 보여주며 각 항목에서 한 번에 되돌린다.
///   - 기본 동작은 «안전하게 되돌리기»(비파괴 revert). daemon 이 되돌리기 «전» 현재 상태를
///     자동 체크포인트로 먼저 남기므로(미커밋 변경 포함), 그 사실을 다이얼로그에 명시한다.
///   - 파괴적 reset 은 기본 숨김. 「고급」 토글을 켜야 길게 눌러(컨텍스트 메뉴) 쓸 수 있고,
///     노랑(warning) 경고 문구를 함께 띄운다.
///   - 의존성은 CommitsView 와 같은 클로저 주입 — ChatViewModel 을 직접 모른다.
struct CheckpointsView: View {
    /// (limit, skip) → 체크포인트만 추린 한 페이지(최신순). 실패/비-repo 는 nil.
    let loadCheckpoints: (_ limit: Int, _ skip: Int) async -> GitCommitsResponse?
    /// (sha, mode) → 되돌리기. mode="revert"(비파괴)/"reset"(파괴).
    let rollback: (_ sha: String, _ mode: String) async throws -> GitRollbackResult
    /// 빈 상태에서 첫 체크포인트를 만든다(비파괴).
    let createCheckpoint: () async throws -> Void
    /// 에이전트 실행 중이면 되돌리기를 잠그고 안내 토스트만 띄운다.
    let isAgentBusy: Bool

    @State private var checkpoints: [GitCommit] = []
    @State private var loading = true
    @State private var loadingMore = false
    @State private var didFail = false
    @State private var reachedEnd = false

    /// 파괴적 reset 노출 게이트 — 기본 꺼짐.
    @State private var showAdvanced = false

    @State private var revertTarget: GitCommit?
    @State private var resetTarget: GitCommit?
    @State private var busy = false
    @State private var toast: Toast?

    private let pageSize = 50

    var body: some View {
        Group {
            if loading && checkpoints.isEmpty {
                ProgressView().controlSize(.large)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if checkpoints.isEmpty {
                if didFail {
                    DiffEmptyState(
                        title: "불러오기 실패",
                        systemImage: "exclamationmark.triangle",
                        message: "연결이 회복되면 다시 시도된다.",
                    )
                } else {
                    emptyState
                }
            } else {
                timeline
            }
        }
        .navigationTitle("체크포인트")
        .navigationBarTitleDisplayMode(.inline)
        .task { if checkpoints.isEmpty { await reload() } }
        .overlay {
            if busy {
                ProgressView()
                    .controlSize(.large)
                    .padding(24)
                    .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14))
            }
        }
        .overlay(alignment: .bottom) { toastBanner }
        .disabled(busy)
        // 되돌리기 확인 — danger(빨강) 버튼. 비파괴라 «안전하게» 임을 메시지에 명시.
        .confirmationDialog(
            "이 시점으로 되돌릴까요?",
            isPresented: Binding(get: { revertTarget != nil }, set: { if !$0 { revertTarget = nil } }),
            titleVisibility: .visible,
            presenting: revertTarget,
        ) { commit in
            Button("이 시점으로 되돌리기", role: .destructive) { performRollback(commit, mode: "revert") }
            Button("취소", role: .cancel) {}
        } message: { _ in
            Text("지금 작업 중인 변경은 되돌리기 전에 자동 체크포인트로 먼저 저장돼요. 기록은 지우지 않고 안전하게 되돌려요.")
        }
        // 파괴적 reset 재확인 — 고급 토글을 켜고 길게 눌러야 여기까지 온다.
        .confirmationDialog(
            "기록까지 지우고 되돌릴까요?",
            isPresented: Binding(get: { resetTarget != nil }, set: { if !$0 { resetTarget = nil } }),
            titleVisibility: .visible,
            presenting: resetTarget,
        ) { commit in
            Button("이후 커밋을 지우고 되돌리기", role: .destructive) { performRollback(commit, mode: "reset") }
            Button("취소", role: .cancel) {}
        } message: { _ in
            Text("이 시점 이후의 커밋이 사라져요. 그래도 되돌리기 전 자동 체크포인트로 복구할 수 있어요.")
        }
    }

    // MARK: 타임라인 본문

    private var timeline: some View {
        List {
            Section {
                Label("되돌리면 지금 작업 중인 변경은 자동 체크포인트로 먼저 저장돼요.", systemImage: "info.circle")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                Toggle(isOn: $showAdvanced) {
                    Label("고급: 기록까지 지우는 되돌리기", systemImage: "exclamationmark.triangle")
                }
            } footer: {
                // 고급이 켜졌을 때만 — warning(노랑) 경고. 길게 눌러야 쓸 수 있음을 안내.
                if showAdvanced {
                    Label(
                        "각 항목을 길게 누르면 «기록까지 지우고 되돌리기» 를 쓸 수 있어요. 이후 커밋이 사라지고, 되돌리기 전 자동 체크포인트로만 복구할 수 있어요.",
                        systemImage: "exclamationmark.triangle.fill",
                    )
                    .font(.footnote)
                    .foregroundStyle(Theme.warning)
                }
            }

            Section {
                ForEach(timelineRows) { row in
                    switch row {
                    case .single(let commit):
                        CheckpointRow(
                            commit: commit,
                            showAdvanced: showAdvanced,
                            onRevert: { requestRevert(commit) },
                            onReset: { requestReset(commit) },
                        )
                        .swipeActions(edge: .leading) {
                            Button { requestRevert(commit) } label: {
                                Label("되돌리기", systemImage: "arrow.uturn.backward")
                            }
                            .tint(Theme.accent)
                        }
                    case .cluster(_, let items):
                        // 같은 분에 연속으로 쌓인 자동 체크포인트 — 묶어 보이되 펼치면 개별 되돌리기.
                        DisclosureGroup {
                            ForEach(items) { commit in
                                CheckpointRow(
                                    commit: commit,
                                    showAdvanced: showAdvanced,
                                    onRevert: { requestRevert(commit) },
                                    onReset: { requestReset(commit) },
                                    indented: true,
                                )
                            }
                        } label: {
                            ClusterLabel(items: items)
                        }
                    }
                }
                if !reachedEnd {
                    Button { Task { await loadMore() } } label: {
                        HStack {
                            Spacer()
                            if loadingMore { ProgressView() } else { Text("더 보기") }
                            Spacer()
                        }
                    }
                    .disabled(loadingMore)
                }
            }
        }
        .listStyle(.insetGrouped)
    }

    private var emptyState: some View {
        VStack(spacing: 14) {
            Image(systemName: "flag.slash")
                .font(.system(size: Theme.IconSize.l))
                .foregroundStyle(.secondary)
            Text("아직 체크포인트가 없어요")
                .font(.headline)
            Text("지금 작업 상태를 체크포인트로 남겨두면, 에이전트가 일을 망쳐도 한 번에 이 시점으로 되돌릴 수 있어요.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 24)
            Button {
                Task { await doCreateCheckpoint() }
            } label: {
                Label("체크포인트 만들기", systemImage: "flag.fill")
            }
            .buttonStyle(.borderedProminent)
            .tint(Theme.pro)
            .disabled(busy)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    @ViewBuilder private var toastBanner: some View {
        if let toast {
            HStack(spacing: 8) {
                Image(systemName: toast.isError ? "exclamationmark.triangle.fill" : "checkmark.circle.fill")
                Text(verbatim: toast.message)
                    .font(.subheadline)
            }
            .foregroundStyle(Theme.onAccent)
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .background(toast.isError ? Theme.danger : Theme.success, in: Capsule())
            .padding(.bottom, 24)
            .padding(.horizontal, 16)
            .shadow(radius: 8, y: 2)
            .transition(.move(edge: .bottom).combined(with: .opacity))
        }
    }

    // MARK: 그룹핑

    /// 타임라인 한 행 — 단독 체크포인트 또는 같은-분 자동 체크포인트 묶음.
    private enum TimelineRow: Identifiable {
        case single(GitCommit)
        case cluster(id: String, items: [GitCommit])

        var id: String {
            switch self {
            case .single(let c): return c.sha
            case .cluster(let id, _): return id
            }
        }
    }

    /// 최신순 체크포인트를 행으로 접는다 — 같은 분에 «연속» 으로 쌓인 자동 체크포인트(되돌리기 전
    /// 자동 저장 등)만 묶음으로, 그 외(수동·서로 다른 분)는 단독으로.
    private var timelineRows: [TimelineRow] {
        var rows: [TimelineRow] = []
        var run: [GitCommit] = []
        var runBucket: String?

        func flush() {
            guard !run.isEmpty else { return }
            if run.count >= 2 {
                rows.append(.cluster(id: "cluster-\(run[0].sha)", items: run))
            } else {
                rows.append(.single(run[0]))
            }
            run = []
            runBucket = nil
        }

        for commit in checkpoints {
            let info = CheckpointInfo(subject: commit.subject)
            let bucket = CommitDate.minuteBucket(commit.date)
            if info.isAuto, runBucket == bucket {
                run.append(commit)
            } else if info.isAuto {
                flush()
                run = [commit]
                runBucket = bucket
            } else {
                flush()
                rows.append(.single(commit))
            }
        }
        flush()
        return rows
    }

    // MARK: 동작

    private func requestRevert(_ commit: GitCommit) {
        if isAgentBusy {
            showToast(.init(message: String(localized: "에이전트가 실행 중이에요. 끝난 뒤에 되돌릴 수 있어요."), isError: true))
            return
        }
        revertTarget = commit
    }

    private func requestReset(_ commit: GitCommit) {
        if isAgentBusy {
            showToast(.init(message: String(localized: "에이전트가 실행 중이에요. 끝난 뒤에 되돌릴 수 있어요."), isError: true))
            return
        }
        resetTarget = commit
    }

    /// 되돌리기 실행 — 성공하면 목록을 새로 받아 새로 생긴 «되돌리기 전» 자동 체크포인트가 맨 위에
    /// 보이게 하고, 성공/실패를 토스트로 알린다.
    private func performRollback(_ commit: GitCommit, mode: String) {
        revertTarget = nil
        resetTarget = nil
        guard !busy else { return }
        busy = true
        Task {
            defer { busy = false }
            do {
                _ = try await rollback(commit.sha, mode)
                await reload()
                showToast(.init(message: String(localized: "이 시점으로 되돌렸어요. 되돌리기 전 상태는 자동 체크포인트로 저장해 두었어요."), isError: false))
            } catch {
                showToast(.init(message: error.localizedDescription, isError: true))
            }
        }
    }

    private func doCreateCheckpoint() async {
        busy = true
        defer { busy = false }
        do {
            try await createCheckpoint()
            await reload()
            showToast(.init(message: String(localized: "체크포인트를 만들었어요."), isError: false))
        } catch {
            showToast(.init(message: error.localizedDescription, isError: true))
        }
    }

    private func reload() async {
        loading = true
        didFail = false
        let resp = await loadCheckpoints(pageSize, 0)
        if let resp {
            checkpoints = resp.commits
            reachedEnd = resp.commits.count < pageSize
        } else {
            didFail = true
        }
        loading = false
    }

    private func loadMore() async {
        guard !loadingMore, !reachedEnd else { return }
        loadingMore = true
        defer { loadingMore = false }
        let resp = await loadCheckpoints(pageSize, checkpoints.count)
        guard let resp else { return }
        let known = Set(checkpoints.map(\.sha))
        checkpoints.append(contentsOf: resp.commits.filter { !known.contains($0.sha) })
        if resp.commits.count < pageSize { reachedEnd = true }
    }

    private func showToast(_ t: Toast) {
        withAnimation { toast = t }
        Task {
            try? await Task.sleep(for: .seconds(2.6))
            if toast?.id == t.id { withAnimation { toast = nil } }
        }
    }

    struct Toast: Identifiable, Equatable {
        let id = UUID()
        let message: String
        let isError: Bool
    }
}

/// 체크포인트 한 줄의 의미 분류 — 자동/수동 구분 + 표시할 노트.
/// daemon 이 만든 커밋 제목(고정 한국어 마커)으로 판별한다(`CHECKPOINT_PREFIX` 와 한 쌍).
private struct CheckpointInfo {
    enum Kind { case manual, autoBeforeRollback, revertResult }
    let kind: Kind
    /// 사용자가 직접 단 노트 — 없으면 nil(라벨로 대체). ISO 타임스탬프뿐인 자동 제목은 노트로 안 친다.
    let customNote: String?

    var isAuto: Bool { kind != .manual }

    init(subject: String) {
        let prefix = "checkpoint(ps):"
        var rest = subject
        if rest.hasPrefix(prefix) { rest.removeFirst(prefix.count) }
        rest = rest.trimmingCharacters(in: .whitespaces)

        if rest.contains("되돌리기 전 자동 저장") {
            kind = .autoBeforeRollback
            customNote = nil
        } else if rest.hasSuffix("시점으로 되돌림") {
            kind = .revertResult
            customNote = nil
        } else {
            kind = .manual
            // 노트 없이 만든 체크포인트는 제목이 ISO 타임스탬프 — 노트로 표시하지 않는다.
            let isISO = rest.range(of: "^\\d{4}-\\d{2}-\\d{2}T", options: .regularExpression) != nil
            customNote = (isISO || rest.isEmpty) ? nil : rest
        }
    }
}

/// 체크포인트 한 줄 — 아이콘 + 제목/노트 + (짧은 sha · 상대시간 · 자동/수동) + 되돌리기 버튼.
private struct CheckpointRow: View {
    let commit: GitCommit
    let showAdvanced: Bool
    let onRevert: () -> Void
    let onReset: () -> Void
    var indented = false

    var body: some View {
        let info = CheckpointInfo(subject: commit.subject)
        HStack(spacing: 10) {
            Image(systemName: info.isAuto ? "clock.arrow.circlepath" : "flag.fill")
                .foregroundStyle(info.isAuto ? Color.secondary : Theme.pro)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 3) {
                title(info)
                    .font(.callout)
                    .lineLimit(2)
                HStack(spacing: 6) {
                    Text(verbatim: commit.shortSha)
                        .font(.caption2.monospaced())
                        .foregroundStyle(Theme.accent)
                    let rel = CommitDate.relative(commit.date)
                    if !rel.isEmpty {
                        Text(verbatim: "·")
                        Text(verbatim: rel)
                    }
                    Text(verbatim: "·")
                    info.isAuto ? Text("자동") : Text("수동")
                }
                .font(.caption2)
                .foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            Button(action: onRevert) {
                Image(systemName: "arrow.uturn.backward")
            }
            .buttonStyle(.borderless)
            .tint(Theme.accent)
            .accessibilityLabel("이 시점으로 되돌리기")
        }
        .padding(.leading, indented ? 8 : 0)
        .padding(.vertical, 2)
        .contentShape(Rectangle())
        .contextMenu {
            Button { onRevert() } label: {
                Label("이 시점으로 되돌리기", systemImage: "arrow.uturn.backward")
            }
            if showAdvanced {
                Button(role: .destructive) { onReset() } label: {
                    Label("기록까지 지우고 되돌리기", systemImage: "trash")
                }
            }
        }
    }

    @ViewBuilder private func title(_ info: CheckpointInfo) -> some View {
        switch info.kind {
        case .manual:
            if let note = info.customNote {
                Text(verbatim: note)
            } else {
                Text("체크포인트")
            }
        case .autoBeforeRollback:
            Text("되돌리기 전 자동 저장")
        case .revertResult:
            Text("되돌린 지점")
        }
    }
}

/// 같은-분 자동 체크포인트 묶음의 DisclosureGroup 헤더 — «자동 저장 N개» + 상대시간.
private struct ClusterLabel: View {
    let items: [GitCommit]

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "clock.arrow.circlepath")
                .foregroundStyle(.secondary)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 3) {
                Text("자동 저장 \(items.count)개")
                    .font(.callout)
                let rel = CommitDate.relative(items.first?.date ?? "")
                if !rel.isEmpty {
                    Text(verbatim: rel)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(.vertical, 2)
    }
}
