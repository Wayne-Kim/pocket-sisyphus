import SwiftUI

/// 브랜치 목록·전환·생성 + git worktree 관리 시트.
///
/// 상태바의 브랜치 칩이 토글한다. 두 영역:
///   1. 브랜치 — 로컬(현재 ✔ 표시) + 원격. 탭하면 전환(checkout), 「+」 로 새 브랜치.
///   2. worktree — 브랜치별 별도 작업 폴더 목록 + 새 worktree 만들기 + 각 worktree 에서
///      세션 열기 / 삭제.
///
/// 의존성은 DiffSheet 와 동일하게 클로저로 받는다 — BranchSheet 는 ChatViewModel 을 직접
/// import 하지 않는다. mutating 클로저는 throw 로 실패를 알리고, 그 메시지(보통 git stderr
/// 또는 localize 된 안내문)를 이 시트가 자기 화면 alert 으로 띄운다 (ChatView 는 lastError 를
/// 화면에 노출하지 않으므로).
struct BranchSheet: View {
    let currentBranch: String?
    let loadBranches: () async -> GitBranchesResponse?
    let loadWorktrees: () async -> GitWorktreesResponse?
    /// (name, track) — track=true 면 원격추적 브랜치를 받아 로컬로 전환.
    let checkout: (String, Bool) async throws -> Void
    /// (name, from, checkout)
    let createBranch: (String, String?, Bool) async throws -> Void
    /// (name, force) — 로컬 브랜치 삭제. force=true 면 병합 안 된 브랜치도 강제 삭제.
    let deleteBranch: (String, Bool) async throws -> Void
    /// (branch, newBranch) → 생성된 worktree
    let addWorktree: (String, Bool) async throws -> GitWorktree
    /// (path, force)
    let removeWorktree: (String, Bool) async throws -> Void
    /// 이 레포의 머지 큐(목록 + 상태 요약). 시트 진입/새로고침 시 호출. 실패/비-repo 는 nil.
    let loadMergeQueue: () async -> MergeQueueResponse?
    /// (source, target) → 머지 요청 enqueue. 직접 머지하지 않고 daemon 직렬 큐에 적재. 실패는 throw.
    let enqueueMerge: (String, String) async throws -> MergeRequest
    /// (source, target) → 읽기 전용 머지 미리보기(관계·충돌 사전 탐지, repo 무변경). 실패/구 daemon 은 nil.
    let loadMergePreview: (String, String) async -> MergePreview?
    /// (id) → 충돌/실패 머지 재시도.
    let retryMerge: (String) async throws -> Void
    /// (id) → 머지 요청 취소(queued) / 이력 삭제(종결).
    let cancelMerge: (String) async throws -> Void
    /// (worktree path, title) → 그 경로로 만든 새 세션. title 은 보통 worktree 의 브랜치 이름
    /// — 새 세션이 「제목 없음」 대신 어느 worktree 인지 바로 보이게 한다.
    let makeSession: (String, String?) async throws -> SessionSummary
    /// 새 세션을 열어달라는 신호 — 호출부(ChatView)가 시트를 닫고 모달로 새 채팅을 띄운다.
    let onOpenSession: (SessionSummary) -> Void
    /// (ref, limit, skip) → 커밋 로그 한 페이지. ref=nil 이면 현재 HEAD. CommitsView 가 호출.
    let loadCommits: (String?, Int, Int) async -> GitCommitsResponse?
    /// (limit, skip) → 체크포인트만 추린 한 페이지(최신순). CheckpointsView 가 호출.
    let loadCheckpoints: (Int, Int) async -> GitCommitsResponse?
    /// (sha) → 한 커밋의 메타 + 변경 파일. CommitDetailView 가 호출.
    let loadCommitDetail: (String) async -> GitCommitDetail?
    /// (sha, path) → 그 커밋이 그 파일에 가한 변경만의 diff. CommitFileDiffView 가 호출.
    let loadCommitDiff: (String, String) async -> GitFileDiffResponse?
    /// (sha, mode) → 그 체크포인트로 되돌리기. mode="revert"(비파괴)/"reset"(파괴). CommitsView 가 호출.
    let rollback: (String, String) async throws -> GitRollbackResult
    /// 에이전트 실행 중인지 — true 면 CommitsView 가 «되돌리기» 를 잠근다.
    let isAgentBusy: Bool
    /// 지금 작업트리를 스냅샷 커밋(`checkpoint(ps): …`)으로 남긴다 — «나비효과» 공포의 안전망.
    /// 비파괴(커밋만 추가)라 에이전트 실행 중에도 허용. 입력바 위 도구줄에서 이 시트 상단으로 이동.
    let createCheckpoint: () async throws -> Void

    @Environment(\.dismiss) private var dismiss
    /// 커밋 화면 push 용 경로 — 브랜치 컨텍스트 메뉴에서 프로그래밍 방식으로 append 한다.
    @State private var navPath = NavigationPath()

    @State private var branches: GitBranchesResponse?
    @State private var worktrees: [GitWorktree] = []
    // 머지 큐 — 이 레포의 요청 목록 + 상태 요약(대기/처리 중/충돌). 시트 진입/새로고침/enqueue 후 갱신.
    @State private var mergeRequests: [MergeRequest] = []
    @State private var mergeCounts: MergeQueueCounts?
    @State private var loading = true
    /// mutating 동작(전환/생성/삭제/세션) 진행 중 — 오버레이 스피너 + 입력 잠금.
    @State private var busy = false
    @State private var errorMessage: String?

    // 새 브랜치 / 새 worktree 입력.
    @State private var showNewBranch = false
    @State private var newBranchName = ""
    @State private var showNewWorktree = false
    @State private var newWorktreeBranch = ""

    // 전환 / 강제삭제 확인 — 단일 confirmationDialog 로 묶는다(다중 presentation 충돌 회피).
    @State private var confirm: ConfirmAction?

    // 체크포인트 결과(성공 안내/실패 사유) — 트리거 버튼에 붙인 alert 으로 띄운다.
    @State private var checkpointNotice: String?

    // 머지 미리보기 시트 — 컨텍스트 메뉴 「main 에 머지 요청」이 띄운다. enqueue 전에 충돌/관계를
    // 미리 보여 주고, 그 안의 「합치기」가 doEnqueueMerge 로 적재한다(충돌이어도 막지 않음).
    @State private var pendingMerge: PendingMerge?

    private struct PendingMerge: Identifiable {
        let source: String
        let target: String
        var id: String { "\(source)→\(target)" }
    }

    private struct PendingCheckout {
        let branch: GitBranch
        let track: Bool
    }

    private enum ConfirmAction: Identifiable {
        case checkout(PendingCheckout)
        case forceDelete(GitWorktree)
        case forceDeleteBranch(GitBranch)

        var id: String {
            switch self {
            case .checkout(let p): return "co:\(p.branch.name)"
            case .forceDelete(let w): return "del:\(w.path)"
            case .forceDeleteBranch(let b): return "delbr:\(b.name)"
            }
        }
    }

    var body: some View {
        NavigationStack(path: $navPath) {
            content
                .navigationTitle("브랜치 · worktree")
                .navigationBarTitleDisplayMode(.inline)
                // 커밋 화면 3단계는 BranchSheet 의 NavigationStack 이 value-based 로 받아 만든다.
                // (CommitsView 의 commit 행 / CommitDetailView 의 파일 행은 NavigationLink(value:)
                //  로 이 스택의 path 에 그대로 append 된다.)
                .navigationDestination(for: CommitsTarget.self) { target in
                    CommitsView(
                        target: target,
                        loadCommits: loadCommits,
                        rollback: rollback,
                        isAgentBusy: isAgentBusy,
                    )
                }
                .navigationDestination(for: CheckpointsTarget.self) { _ in
                    CheckpointsView(
                        loadCheckpoints: loadCheckpoints,
                        rollback: rollback,
                        createCheckpoint: createCheckpoint,
                        isAgentBusy: isAgentBusy,
                    )
                }
                .navigationDestination(for: GitCommit.self) { commit in
                    CommitDetailView(commit: commit, loadDetail: loadCommitDetail)
                }
                .navigationDestination(for: CommitFileTarget.self) { target in
                    CommitFileDiffView(target: target, loadDiff: loadCommitDiff)
                }
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("닫기") { dismiss() }
                    }
                    // 체크포인트 — 지금 작업트리를 통째로 스냅샷 커밋으로 남긴다. git 컨텍스트라
                    // 이 시트로 옮겼다. 프로/고급 약속색(주황). 한 탭이면 스냅샷 → 결과 alert.
                    ToolbarItem(placement: .topBarLeading) {
                        Button {
                            Task { await doCreateCheckpoint() }
                        } label: {
                            Label("체크포인트 만들기", systemImage: "flag.fill")
                                .foregroundStyle(Theme.pro)
                        }
                        .disabled(busy || loading)
                        // 결과 alert 도 트리거 버튼에 붙여 presentation 충돌 회피.
                        .alert(
                            "알림",
                            isPresented: Binding(get: { checkpointNotice != nil }, set: { if !$0 { checkpointNotice = nil } }),
                        ) {
                            Button("확인", role: .cancel) { checkpointNotice = nil }
                        } message: {
                            Text(verbatim: checkpointNotice ?? "")
                        }
                    }
                    ToolbarItem(placement: .topBarLeading) {
                        Button {
                            newBranchName = ""
                            showNewBranch = true
                        } label: {
                            Label("새 브랜치", systemImage: "plus")
                        }
                        .disabled(busy || loading)
                        // 새 브랜치 alert 은 트리거 버튼에 붙인다 — 한 view 에 여러 .alert 를
                        // 쌓을 때의 presentation 충돌을 피한다.
                        .alert("새 브랜치", isPresented: $showNewBranch) {
                            TextField("브랜치 이름 (영문·숫자)", text: $newBranchName)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                            // 유효한 이름(영문·숫자+._/-)일 때만 활성화 — 한글 등은 git 이 거절한다.
                            Button("생성") { Task { await doCreateBranch(checkout: false) } }
                                .disabled(!isValidGitName(newBranchName))
                            Button("생성 후 전환") { Task { await doCreateBranch(checkout: true) } }
                                .disabled(!isValidGitName(newBranchName))
                            Button("취소", role: .cancel) {}
                        } message: {
                            Text("현재 브랜치를 기준으로 새 브랜치를 만들어요. 이름은 영문·숫자와 - _ . / 만 쓸 수 있어요.")
                        }
                    }
                }
                .task { await reload(initial: true) }
        }
        // 전환 / 강제삭제 확인 — 단일 dialog.
        .confirmationDialog(
            "계속할까요?",
            isPresented: Binding(get: { confirm != nil }, set: { if !$0 { confirm = nil } }),
            titleVisibility: .visible,
            presenting: confirm,
        ) { action in
            switch action {
            case .checkout(let p):
                Button("전환") { Task { await doCheckout(p) } }
                Button("취소", role: .cancel) {}
            case .forceDelete(let w):
                Button("강제 삭제", role: .destructive) {
                    Task { await deleteWorktree(w, force: true) }
                }
                Button("취소", role: .cancel) {}
            case .forceDeleteBranch(let b):
                Button("강제 삭제", role: .destructive) {
                    Task { await deleteBranchAction(b, force: true) }
                }
                Button("취소", role: .cancel) {}
            }
        } message: { action in
            switch action {
            case .checkout(let p):
                if p.track {
                    Text("원격 브랜치를 받아 같은 이름의 로컬 브랜치로 전환해요.")
                } else {
                    Text("작업 중인 파일은 그대로 두고 브랜치만 바꿔요.")
                }
            case .forceDelete:
                Text("커밋되지 않은 변경사항이 사라질 수 있어요.")
            case .forceDeleteBranch(let b):
                Text("브랜치 «\(b.name)» 에 병합되지 않은 커밋이 있어요. 강제로 삭제하면 그 커밋들이 사라질 수 있어요.")
            }
        }
        .alert(
            "문제가 생겼어요",
            isPresented: Binding(get: { errorMessage != nil }, set: { if !$0 { errorMessage = nil } }),
        ) {
            Button("확인", role: .cancel) { errorMessage = nil }
        } message: {
            Text(verbatim: errorMessage ?? "")
        }
        // 머지 미리보기 — enqueue 전에 충돌/관계를 보여 준다. 「합치기」는 충돌이어도 막지 않는다.
        .sheet(item: $pendingMerge) { pending in
            MergePreviewSheet(
                source: pending.source,
                target: pending.target,
                loadPreview: loadMergePreview,
                onMerge: {
                    Task { await doEnqueueMerge(source: pending.source, target: pending.target) }
                },
            )
        }
    }

    // MARK: - 본문

    @ViewBuilder private var content: some View {
        if loading {
            ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if (branches?.local.isEmpty ?? true) && worktrees.isEmpty {
            BranchEmptyState(
                title: "Git 저장소가 아니에요",
                systemImage: "arrow.triangle.branch",
                message: "이 폴더에서 브랜치 정보를 가져올 수 없어요.",
            )
        } else {
            List {
                historySection
                branchSection
                if let remote = branches?.remote, !remote.isEmpty {
                    remoteSection(remote)
                }
                worktreeSection
                mergeQueueSection
            }
            .listStyle(.insetGrouped)
            .disabled(busy)
            .refreshable { await reload(initial: false) }
            .overlay {
                if busy {
                    ProgressView()
                        .controlSize(.large)
                        .padding(24)
                        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14))
                }
            }
        }
    }

    /// 커밋 기록 진입점 — 현재 HEAD 의 커밋 로그를 본다. 개별 브랜치 로그는 행 컨텍스트 메뉴에서.
    private var historySection: some View {
        Section {
            // 안전망 진입점 — checkpoint(ps): 커밋만 추린 타임라인에서 직전 안전 지점으로 한 번에 되돌린다.
            NavigationLink(value: CheckpointsTarget()) {
                Label("체크포인트", systemImage: "flag.fill")
            }
            NavigationLink(value: CommitsTarget(ref: nil, title: currentBranch ?? "HEAD")) {
                Label("커밋 목록", systemImage: "clock.arrow.circlepath")
            }
        } header: {
            Text("기록")
        }
    }

    private var branchSection: some View {
        Section("브랜치") {
            ForEach(branches?.local ?? []) { b in
                Button {
                    if !b.current { confirm = .checkout(.init(branch: b, track: false)) }
                } label: {
                    BranchRow(branch: b, isRemote: false)
                }
                .buttonStyle(.plain)
                .disabled(busy || b.current)
                .contextMenu {
                    Button {
                        navPath.append(CommitsTarget(ref: b.name, title: b.name))
                    } label: {
                        Label("커밋 보기", systemImage: "clock.arrow.circlepath")
                    }
                    Button {
                        Task { await createWorktreeAndOpen(branch: b.name, newBranch: false) }
                    } label: {
                        Label("이 브랜치로 worktree 열기", systemImage: "plus.rectangle.on.folder")
                    }
                    // 머지 요청 — 바로 적재하지 않고 먼저 «읽기 전용» 미리보기 시트를 띄운다.
                    // 충돌/관계를 본 뒤 그 안의 「합치기」가 daemon 직렬 큐에 적재한다(동시 머지
                    // 충돌로 멈추는 사고 방지). main 자기 자신은 대상이 아니므로 숨긴다.
                    if b.name != "main" {
                        Button {
                            pendingMerge = PendingMerge(source: b.name, target: "main")
                        } label: {
                            Label("main 에 머지 요청", systemImage: "arrow.triangle.merge")
                        }
                    }
                    // 현재 브랜치는 삭제 불가(git 이 거절) — 옵션 자체를 숨긴다.
                    if !b.current {
                        Button(role: .destructive) {
                            Task { await deleteBranchAction(b, force: false) }
                        } label: {
                            Label("브랜치 삭제", systemImage: "trash")
                        }
                    }
                }
                .swipeActions(edge: .trailing) {
                    if !b.current {
                        Button(role: .destructive) {
                            Task { await deleteBranchAction(b, force: false) }
                        } label: {
                            Label("삭제", systemImage: "trash")
                        }
                    }
                }
            }
        }
    }

    private func remoteSection(_ remote: [GitBranch]) -> some View {
        Section("원격") {
            ForEach(remote) { b in
                Button {
                    confirm = .checkout(.init(branch: b, track: true))
                } label: {
                    BranchRow(branch: b, isRemote: true)
                }
                .buttonStyle(.plain)
                .disabled(busy)
                .contextMenu {
                    Button {
                        navPath.append(CommitsTarget(ref: b.name, title: b.name))
                    } label: {
                        Label("커밋 보기", systemImage: "clock.arrow.circlepath")
                    }
                }
            }
        }
    }

    private var worktreeSection: some View {
        Section {
            ForEach(worktrees) { w in
                Button {
                    Task { await openSession(in: w) }
                } label: {
                    WorktreeRow(worktree: w)
                }
                .buttonStyle(.plain)
                .disabled(busy || w.isCurrent)
                .swipeActions(edge: .trailing) {
                    if !w.isMain && !w.isCurrent {
                        Button(role: .destructive) {
                            Task { await deleteWorktree(w, force: false) }
                        } label: {
                            Label("삭제", systemImage: "trash")
                        }
                    }
                }
            }
            Button {
                newWorktreeBranch = ""
                showNewWorktree = true
            } label: {
                Label("새 worktree 만들기", systemImage: "plus.rectangle.on.folder")
            }
            .disabled(busy)
            // 새 worktree alert 도 트리거 버튼에 붙여 presentation 충돌 회피.
            .alert("새 worktree", isPresented: $showNewWorktree) {
                TextField("브랜치 이름 (영문·숫자)", text: $newWorktreeBranch)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                // 한글·공백 등은 git 이 브랜치명으로 못 받는다 — 유효한 이름일 때만 버튼 활성화해
                // 제출 후 에러 대신 즉시 안내(아래 message)로 영문 입력을 유도한다.
                Button("만들고 세션 열기") {
                    Task { await createWorktreeAndOpen(branch: newWorktreeBranch, newBranch: true) }
                }
                .disabled(!isValidGitName(newWorktreeBranch))
                Button("취소", role: .cancel) {}
            } message: {
                Text("새 브랜치의 worktree(별도 작업 폴더)를 만들고 그 안에서 새 세션을 열어요. 이름은 영문·숫자와 - _ . / 만 쓸 수 있어요. 지금 세션은 그대로 둡니다.")
            }
        } header: {
            Text("worktree")
        } footer: {
            Text("worktree 는 브랜치별 별도 작업 폴더예요. 다른 브랜치를 지금 세션과 동시에 작업할 수 있어요.")
        }
    }

    /// 머지 큐 — 작업 브랜치를 main 에 합치는 요청을 daemon 이 직렬로 처리한 상태. 상태색은
    /// 의미 토큰을 따른다: 충돌·실패=danger(빨강), 병합됨=success(초록), 대기·처리 중=중립(.secondary).
    private var mergeQueueSection: some View {
        Section {
            // 상태 요약 — 대기 N · 처리 중 N · 충돌 N (활성 항목이 있을 때만).
            if let c = mergeCounts, c.queued + c.processing + c.conflict > 0 {
                HStack(spacing: 14) {
                    mergeCountChip("대기", c.queued, .secondary)
                    mergeCountChip("처리 중", c.processing, .secondary)
                    mergeCountChip("충돌", c.conflict, Theme.danger)
                }
                .padding(.vertical, 2)
            }
            if mergeRequests.isEmpty {
                Text("아직 머지 요청이 없어요")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(mergeRequests.prefix(12)) { req in
                    MergeRequestRow(request: req)
                        .swipeActions(edge: .trailing) {
                            if req.status == "conflict" || req.status == "failed" {
                                Button {
                                    Task { await doRetryMerge(req) }
                                } label: {
                                    Label("재시도", systemImage: "arrow.clockwise")
                                }
                                .tint(Theme.accent)
                            }
                            if req.status == "queued" {
                                Button(role: .destructive) {
                                    Task { await doCancelMerge(req) }
                                } label: {
                                    Label("취소", systemImage: "xmark")
                                }
                            }
                        }
                }
            }
        } header: {
            Text("머지 큐")
        } footer: {
            Text("브랜치를 main 에 합치는 요청을 데몬이 한 번에 하나씩 처리해요. 충돌하면 그 항목만 멈추고 직접 해결이 필요해요 — 나머지는 계속 처리돼요.")
        }
    }

    /// 큐 요약 칩 — 라벨 + 개수. 라벨은 의미색, 개수는 verbatim(숫자는 번역 대상 아님).
    private func mergeCountChip(_ label: LocalizedStringKey, _ count: Int, _ tint: Color) -> some View {
        HStack(spacing: 4) {
            Text(label)
            Text(verbatim: "\(count)").fontWeight(.semibold)
        }
        .font(.caption)
        .foregroundStyle(tint)
    }

    // MARK: - 동작

    /// 브랜치/worktree 이름이 daemon 의 `isValidRef` 규칙을 통과하는지 — 제출 «전» 에 같은 규칙으로
    /// 막아 «생성 실패» alert 대신 비활성 버튼 + 형식 안내로 즉시 피드백한다. git 브랜치명은 영숫자와
    /// `.` `_` `/` `-` 만 허용하고(서버가 인자 주입 방지로 강제), 한글·공백 등은 거절된다 → 영문 입력 유도.
    /// 선행 `-`(git 플래그로 오인) 과 `..`(ref 문법 충돌) 도 막는다.
    private func isValidGitName(_ raw: String) -> Bool {
        let name = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, name.count <= 255 else { return false }
        guard !name.hasPrefix("-"), !name.contains("..") else { return false }
        return name.range(of: "^[A-Za-z0-9._/-]+$", options: .regularExpression) != nil
    }

    /// 체크포인트 스냅샷 커밋을 만든다. 성공/실패 모두 checkpointNotice alert 으로 안내한다.
    /// 비파괴(커밋만 추가)라 에이전트 실행 중에도 허용 — busy 스피너만 잠깐 돈다.
    private func doCreateCheckpoint() async {
        busy = true
        defer { busy = false }
        do {
            try await createCheckpoint()
            checkpointNotice = String(localized: "체크포인트를 만들었어요. 문제가 생기면 커밋 목록에서 이 시점으로 되돌릴 수 있어요.")
        } catch {
            checkpointNotice = error.localizedDescription
        }
    }

    private func reload(initial: Bool) async {
        if initial { loading = true }
        let b = await loadBranches()
        let w = await loadWorktrees()
        branches = b
        worktrees = w?.worktrees ?? []
        await loadMerge()
        loading = false
    }

    /// 머지 큐만 다시 읽는다 — enqueue/재시도/취소 직후 목록을 즉시 갱신.
    private func loadMerge() async {
        let m = await loadMergeQueue()
        mergeRequests = m?.requests ?? []
        mergeCounts = m?.counts
    }

    private func doCheckout(_ p: PendingCheckout) async {
        confirm = nil
        busy = true
        defer { busy = false }
        do {
            try await checkout(p.branch.name, p.track)
            // 전환 성공 — 칩이 바뀐 걸 사용자가 바로 보도록 시트를 닫고 채팅으로 돌아간다.
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func doCreateBranch(checkout: Bool) async {
        let name = newBranchName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return }
        busy = true
        defer { busy = false }
        do {
            try await createBranch(name, nil, checkout)
            if checkout {
                dismiss()
            } else {
                await reload(initial: false)
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// worktree 생성 후 곧바로 그 안에서 새 세션을 연다 — «쉽게 사용» 의 핵심 흐름.
    private func createWorktreeAndOpen(branch: String, newBranch: Bool) async {
        let name = branch.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return }
        busy = true
        defer { busy = false }
        do {
            let wt = try await addWorktree(name, newBranch)
            // 방금 입력한 브랜치 이름을 새 세션 제목으로 — 「제목 없음」 대신 어느 worktree 인지 보이게.
            let session = try await makeSession(wt.path, name)
            onOpenSession(session)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func openSession(in worktree: GitWorktree) async {
        busy = true
        defer { busy = false }
        do {
            // 기존 worktree 도 그 브랜치 이름을 제목으로 — detached(branch=nil)면 nil → 기존 fallback.
            let session = try await makeSession(worktree.path, worktree.branch)
            onOpenSession(session)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func deleteWorktree(_ w: GitWorktree, force: Bool) async {
        confirm = nil
        busy = true
        defer { busy = false }
        do {
            try await removeWorktree(w.path, force)
            await reload(initial: false)
        } catch {
            if !force {
                // dirty/locked 등 1차 실패 — 강제 삭제 확인을 띄운다.
                confirm = .forceDelete(w)
            } else {
                errorMessage = error.localizedDescription
            }
        }
    }

    /// 로컬 브랜치 삭제. 1차는 안전 삭제(`git branch -d`) — 병합 안 된 브랜치라 실패하면
    /// 강제 삭제(`-D`) 확인을 띄운다(worktree 삭제와 같은 흐름).
    private func deleteBranchAction(_ b: GitBranch, force: Bool) async {
        confirm = nil
        busy = true
        defer { busy = false }
        do {
            try await deleteBranch(b.name, force)
            await reload(initial: false)
        } catch let error as GitOperationError where !force && error.code == "branch_delete_failed" {
            // 병합 안 됨 등 1차 실패 — 강제 삭제 확인. (현재 브랜치 등 다른 사유는 그대로 노출.)
            confirm = .forceDeleteBranch(b)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    // MARK: - 머지 큐 동작

    /// 머지 요청 enqueue — 직접 머지하지 않고 daemon 직렬 큐에 적재. 성공 피드백은 큐 섹션에
    /// 「대기 중」 항목이 바로 나타나는 것. 실패만 alert.
    private func doEnqueueMerge(source: String, target: String) async {
        busy = true
        defer { busy = false }
        do {
            _ = try await enqueueMerge(source, target)
            await loadMerge()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func doRetryMerge(_ r: MergeRequest) async {
        busy = true
        defer { busy = false }
        do {
            try await retryMerge(r.id)
            await loadMerge()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func doCancelMerge(_ r: MergeRequest) async {
        busy = true
        defer { busy = false }
        do {
            try await cancelMerge(r.id)
            await loadMerge()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

// MARK: - 행

/// 브랜치 한 줄 — 현재 ✔ / 이름 / 마지막 커밋 제목.
private struct BranchRow: View {
    let branch: GitBranch
    let isRemote: Bool

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: leadingIcon)
                .foregroundStyle(branch.current ? Theme.success : .secondary)
                .frame(width: 20)
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: branch.name)
                    .font(.callout.weight(branch.current ? .semibold : .regular))
                    .lineLimit(1)
                    .truncationMode(.middle)
                if !branch.subject.isEmpty {
                    Text(verbatim: branch.subject)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
            }
            Spacer(minLength: 8)
            if branch.current {
                Badge(text: "현재", tint: Theme.success)
            } else if !isRemote {
                Image(systemName: "chevron.right")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        }
        .contentShape(Rectangle())
        .padding(.vertical, 2)
    }

    private var leadingIcon: String {
        if branch.current { return "checkmark.circle.fill" }
        return isRemote ? "cloud" : "circle"
    }
}

/// worktree 한 줄 — 폴더명 / 브랜치 / 메인·현재 뱃지.
private struct WorktreeRow: View {
    let worktree: GitWorktree

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "folder")
                .foregroundStyle(Theme.pro)  // git/worktree 도구 그룹 — 주황(채팅 브랜치 칩과 통일)
                .frame(width: 20)
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: lastComponent)
                    .font(.callout)
                    .lineLimit(1)
                    .truncationMode(.middle)
                HStack(spacing: 4) {
                    Image(systemName: "arrow.triangle.branch")
                        .font(.caption2)
                    Text(verbatim: worktree.branch ?? "detached")
                        .font(.caption2)
                }
                .foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            if worktree.isMain {
                Badge(text: "메인", tint: .secondary)
            } else if worktree.isCurrent {
                Badge(text: "현재", tint: Theme.success)
            } else {
                Image(systemName: "arrow.up.forward.app")
                    .font(.caption)
                    .foregroundStyle(Theme.accent)
            }
        }
        .contentShape(Rectangle())
        .padding(.vertical, 2)
        .accessibilityHint(worktree.isCurrent ? Text("") : Text("탭하면 이 worktree 에서 새 세션을 열어요"))
    }

    private var lastComponent: String {
        (worktree.path as NSString).lastPathComponent
    }
}

/// 머지 큐 한 줄 — source → target / 충돌 파일·실패 사유 / 상태 뱃지.
private struct MergeRequestRow: View {
    let request: MergeRequest

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: mergeStatusIcon(request.status))
                .foregroundStyle(mergeStatusColor(request.status))
                .frame(width: 20)
            VStack(alignment: .leading, spacing: 2) {
                // 브랜치명은 git 식별자라 번역 대상 아님 → verbatim.
                Text(verbatim: "\(request.sourceBranch) → \(request.targetBranch)")
                    .font(.callout)
                    .lineLimit(1)
                    .truncationMode(.middle)
                if let detail = subtitle {
                    Text(verbatim: detail)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }
            Spacer(minLength: 8)
            Badge(text: mergeStatusLabel(request.status), tint: mergeStatusColor(request.status))
        }
        .contentShape(Rectangle())
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }

    /// 부제 — 충돌이면 충돌 파일(앞 3개), 실패면 사유. 둘 다 git 산출물이라 verbatim.
    private var subtitle: String? {
        if request.status == "conflict", !request.conflictFiles.isEmpty {
            return request.conflictFiles.prefix(3).joined(separator: ", ")
        }
        if request.status == "failed", let e = request.error, !e.isEmpty {
            return e
        }
        return nil
    }
}

/// 머지 상태 → 표시 라벨. (의미색은 mergeStatusColor 가 정한다.)
/// `WorkflowRunIsolationView`(워크플로우 run 격리·머지 배지)도 이 라벨을 재사용한다 — 한 곳에서
/// 라벨/색 약속을 정해 BranchSheet 와 run 캔버스가 같은 의미·같은 문자열을 쓰게 한다(드리프트 방지).
func mergeStatusLabel(_ status: String) -> LocalizedStringKey {
    switch status {
    case "queued": return "대기 중"
    case "processing": return "처리 중"
    case "merged": return "병합됨"
    case "conflict": return "충돌"
    case "failed": return "실패"
    case "cancelled": return "취소됨"
    default: return "—"
    }
}

/// 머지 상태 → 의미색. 충돌·실패=danger(빨강), 병합됨=success(초록), 대기·처리·취소=중립(.secondary).
/// warning(노랑)/pro(주황)는 상태색으로 쓰지 않는다(색 정책). `WorkflowRunIsolationView` 도 재사용.
func mergeStatusColor(_ status: String) -> Color {
    switch status {
    case "merged": return Theme.success
    case "conflict", "failed": return Theme.danger
    default: return .secondary
    }
}

private func mergeStatusIcon(_ status: String) -> String {
    switch status {
    case "queued": return "clock"
    case "processing": return "arrow.triangle.2.circlepath"
    case "merged": return "checkmark.circle.fill"
    case "conflict": return "exclamationmark.triangle.fill"
    case "failed": return "xmark.octagon.fill"
    case "cancelled": return "slash.circle"
    default: return "circle"
    }
}

/// 머지 미리보기 신호 — 관계·충돌을 의미색·아이콘·라벨로 매핑. 색은 «의미» 로:
/// 충돌=danger(빨강), 깨끗/빠른-전진=success(초록), 이미 최신/공통 이력 없음=info(파랑) 또는
/// 중립. warning(노랑)·pro(주황)는 여기 의미상 안 맞으니 쓰지 않는다(색 정책).
struct MergePreviewSignal {
    let icon: String
    let label: LocalizedStringKey
    let tint: Color
    let isConflict: Bool
}

func mergePreviewSignal(_ p: MergePreview) -> MergePreviewSignal {
    if p.conflict {
        return MergePreviewSignal(
            icon: "exclamationmark.triangle.fill", label: "충돌 예상", tint: Theme.danger, isConflict: true)
    }
    switch p.relation {
    case "up_to_date":
        return MergePreviewSignal(
            icon: "checkmark.circle", label: "이미 최신", tint: Theme.info, isConflict: false)
    case "fast_forward":
        return MergePreviewSignal(
            icon: "arrow.right.circle.fill", label: "빠른-전진 가능", tint: Theme.success, isConflict: false)
    case "diverged":
        return MergePreviewSignal(
            icon: "checkmark.circle.fill", label: "깨끗하게 합쳐짐", tint: Theme.success, isConflict: false)
    case "unrelated":
        return MergePreviewSignal(
            icon: "questionmark.circle", label: "공통 이력 없음", tint: Theme.info, isConflict: false)
    default:
        return MergePreviewSignal(
            icon: "questionmark.circle", label: "알 수 없음", tint: .secondary, isConflict: false)
    }
}

/// 머지 enqueue 전 «읽기 전용» 미리보기 시트. source→target 관계·충돌을 미리 보여 주고,
/// 「합치기」가 큐에 적재한다 — 충돌이어도 막지 않는다(정보 제공만, 사용자가 강행 가능).
/// preview 조회 실패는 «알 수 없음» 으로 두고 enqueue 는 정상 허용한다(graceful).
private struct MergePreviewSheet: View {
    let source: String
    let target: String
    let loadPreview: (String, String) async -> MergePreview?
    let onMerge: () -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var phase: Phase = .loading

    private enum Phase: Equatable {
        case loading
        case loaded(MergePreview)
        case unknown
    }

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: Theme.Spacing.xl) {
                // 브랜치 경로 — git 식별자라 번역 대상 아님 → verbatim.
                Text(verbatim: "\(source) → \(target)")
                    .font(.headline)
                    .lineLimit(1)
                    .truncationMode(.middle)

                signalView

                Spacer()

                Button {
                    onMerge()
                    dismiss()
                } label: {
                    Text("합치기")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(Theme.Spacing.xxl)
            .navigationTitle("머지 미리보기")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("취소") { dismiss() }
                }
            }
            .task { await load() }
        }
        .presentationDetents([.medium])
    }

    @ViewBuilder private var signalView: some View {
        switch phase {
        case .loading:
            HStack(spacing: Theme.Spacing.l) {
                ProgressView()
                Text("미리 확인하는 중…")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("미리 확인하는 중")
        case .unknown:
            // 조회 실패 — «알 수 없음». enqueue 는 그대로 허용된다.
            Label {
                Text("미리 확인할 수 없어요")
            } icon: {
                Image(systemName: "questionmark.circle")
            }
            .font(.headline)
            .foregroundStyle(.secondary)
            .accessibilityElement(children: .combine)
            .accessibilityLabel("미리 확인할 수 없어요")
        case .loaded(let p):
            loadedView(p)
        }
    }

    @ViewBuilder private func loadedView(_ p: MergePreview) -> some View {
        let signal = mergePreviewSignal(p)
        VStack(alignment: .leading, spacing: Theme.Spacing.m) {
            Label {
                Text(signal.label)
            } icon: {
                Image(systemName: signal.icon)
            }
            .font(.headline)
            .foregroundStyle(signal.tint)
            .accessibilityElement(children: .combine)
            .accessibilityLabel(signal.label)

            if signal.isConflict {
                if !p.conflictFiles.isEmpty {
                    VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                        // 충돌 파일 — git 산출물이라 번역 대상 아님 → verbatim.
                        ForEach(p.conflictFiles.prefix(5), id: \.self) { file in
                            Text(verbatim: file)
                                .font(.caption.monospaced())
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }
                        if p.conflictFiles.count > 5 {
                            Text("외 \(p.conflictFiles.count - 5)개")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
                Text("충돌이 있어도 그대로 적재할 수 있어요. 큐가 처리할 때 보류돼요.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func load() async {
        if let preview = await loadPreview(source, target) {
            phase = .loaded(preview)
        } else {
            phase = .unknown
        }
    }
}

/// 작은 상태 뱃지.
private struct Badge: View {
    let text: LocalizedStringKey
    let tint: Color

    var body: some View {
        Text(text)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(tint)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(tint.opacity(0.16), in: Capsule())
    }
}

/// iOS 17 ContentUnavailableView 호환 대체 — 16.4 타깃 유지 위해 직접 그림.
private struct BranchEmptyState: View {
    let title: LocalizedStringKey
    let systemImage: String
    let message: LocalizedStringKey

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: systemImage)
                .font(.system(size: Theme.IconSize.l))
                .foregroundStyle(.secondary)
            Text(title)
                .font(.headline)
            Text(message)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 24)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
