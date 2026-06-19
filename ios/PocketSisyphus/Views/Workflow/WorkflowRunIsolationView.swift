import SwiftUI

/// 워크플로우 run 의 «격리(worktree) + 머지» 관측 배지.
///
/// per-run worktree 가 도입되면 한 run 은 격리 브랜치에서 돌다가 main 에 다시 머지된다. 이 뷰는
/// 그 run 이 «어느 격리 브랜치» 에서 돌고 «머지가 큐에 올랐는지/됐는지/충돌인지» 를 캔버스 하단
/// 상태바에 한 줄 칩으로 보여 주고, 탭하면 자세히 시트를 연다. (충돌 «해결» · worktree 수동 관리는
/// 비-목표 — 그건 세션 BranchSheet 가 다룬다. 여기는 «읽기전용 관측» 만.)
///
/// 데이터는 «기존» API 두 곳을 엮어 구성한다(daemon 변경 없음):
///   • run 행: `runState.nodeRuns[].session_id` — 이 run 이 만든 세션들.
///   • `/api/merge-queue?repoPath=…`: 그 레포의 머지 요청들(sourceBranch=격리 브랜치, status).
/// 둘을 `sessionId` 로 교차해, 이 run 의 세션이 올린 머지 요청만 추린다. per-run worktree+enqueue
/// 가 아직 안 깔렸으면 매칭이 없어 «격리 없음(머지 미요청)» 빈 상태가 뜬다 — 깔리면 자동으로 채워진다.
///
/// 색 약속(이 레포 SSOT): 격리(worktree) 강조 = pro 주황(브랜치 아이콘/칩에만), 충돌 = danger 빨강,
/// 병합됨 = success 초록, 대기/처리 = 중립(.secondary). warning(노랑)/pro(주황) 혼동 금지.
struct WorkflowRunIsolationView: View {
    let auth: AuthStore
    let conn: ConnectionManager
    let inflight: InFlightTracker
    /// 머지 큐 조회 대상 레포. 워크플로우 정의(repo_path) 또는 노드 repo_path 에서 받는다.
    let repoPath: String?
    /// 이 run 의 노드 세션 id 들 — 머지 요청을 이 run 에 귀속시키는 키.
    let sessionIds: [String]
    /// run.status — running 이면 머지 enqueue 가 늦게 올라올 수 있어 폴링을 유지한다.
    let runStatus: String

    @EnvironmentObject private var purchase: PurchaseStore
    @State private var load: RunIsolationLoad = .loading
    @State private var showSheet = false
    /// 시트의 «다시 시도» 가 폴링 task 를 재시작하도록 loadKey 에 섞는 토큰.
    @State private var reloadToken = 0

    /// 격리 브랜치 = pro 기능(worktree). 미보유면 «비활성» 으로 안내(폴링하지 않음).
    private var isPro: Bool { purchase.isUnlocked(.worktree) }

    /// `.task(id:)` 키 — 프로 여부·run 상태·세션 집합·레포·재시도 토큰이 바뀌면 다시 읽는다.
    private var loadKey: String {
        "\(isPro)|\(runStatus)|\(sessionIds.sorted().joined(separator: ","))|\(repoPath ?? "")|\(reloadToken)"
    }

    var body: some View {
        Button {
            showSheet = true
        } label: {
            chipLabel
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("격리 머지 상태"))
        .accessibilityValue(accessibilityValue)
        .accessibilityHint(Text("자세히 보기"))
        .accessibilityAddTraits(.isButton)
        .task(id: loadKey) { await poll() }
        .sheet(isPresented: $showSheet) {
            WorkflowRunMergeSheet(load: load, onRetry: { reloadToken += 1 })
        }
    }

    // MARK: - 칩 (상태바 한 줄)

    @ViewBuilder
    private var chipLabel: some View {
        HStack(spacing: Theme.Spacing.s) {
            chipLeading
            chipText
                .font(.caption)
                .lineLimit(1)
                .truncationMode(.middle)
            switch load {
            case .inactive:
                ProTag()
            case .loaded(let list):
                if let primary = primaryEntry(list) {
                    MergeStatusBadge(status: primary.status)
                    if list.count > 1 {
                        Text(verbatim: "+\(list.count - 1)")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(.secondary)
                    }
                }
            default:
                EmptyView()
            }
            Image(systemName: "chevron.right")
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
        .padding(.horizontal, Theme.Spacing.l)
        .padding(.vertical, Theme.Spacing.s)
        .background(Capsule().fill(Theme.neutralFill.opacity(Theme.Opacity.fill)))
    }

    @ViewBuilder
    private var chipLeading: some View {
        switch load {
        case .loading:
            ProgressView().controlSize(.small)
        case .inactive:
            // 격리(worktree) = pro 강조 — 아이콘만 주황(칩 전역 .tint 아님).
            Image(systemName: "arrow.triangle.branch").font(.caption).foregroundStyle(Theme.pro)
        case .error:
            Image(systemName: "exclamationmark.triangle.fill").font(.caption).foregroundStyle(.secondary)
        case .empty:
            Image(systemName: "arrow.triangle.branch").font(.caption).foregroundStyle(.secondary)
        case .loaded:
            // 격리 브랜치 존재 — pro 주황 강조(아이콘/칩에만).
            Image(systemName: "arrow.triangle.branch").font(.caption).foregroundStyle(Theme.pro)
        }
    }

    @ViewBuilder
    private var chipText: some View {
        switch load {
        case .loading:
            Text("격리 확인 중…").foregroundStyle(.secondary)
        case .inactive:
            Text("격리").foregroundStyle(.secondary)
        case .error:
            Text("격리 상태를 불러오지 못했어요").foregroundStyle(.secondary)
        case .empty:
            Text("격리 없음").foregroundStyle(.secondary)
        case .loaded(let list):
            if let primary = primaryEntry(list) {
                // 브랜치명은 git 식별자라 번역 대상 아님 → verbatim. 본문색은 .primary 자동 적응.
                Text(verbatim: primary.sourceBranch)
            } else {
                Text("격리 없음").foregroundStyle(.secondary)
            }
        }
    }

    /// VoiceOver 가 읽을 상태 값 — 표시 텍스트와 의미가 같게.
    private var accessibilityValue: Text {
        switch load {
        case .loading: return Text("격리 확인 중…")
        case .inactive: return Text("격리") + Text(verbatim: " · ") + Text("프로")
        case .error: return Text("격리 상태를 불러오지 못했어요")
        case .empty: return Text("격리 없음")
        case .loaded(let list):
            if let primary = primaryEntry(list) {
                return Text(verbatim: primary.sourceBranch + " · ") + Text(mergeStatusLabel(primary.status))
            }
            return Text("격리 없음")
        }
    }

    // MARK: - 로딩 / 폴링

    /// 머지 큐를 읽어 이 run 의 세션이 올린 요청만 추린다. 큐에 활성(대기/처리) 항목이 있거나 run 이
    /// 아직 running 이면(머지가 늦게 enqueue 될 수 있어) 잠깐씩 다시 읽는다 — 종결(병합/충돌/실패)이면 멈춘다.
    @MainActor
    private func poll() async {
        guard isPro else { load = .inactive; return }
        guard let repoPath, !repoPath.isEmpty else { load = .empty; return }
        let ids = Set(sessionIds)
        // 세션이 아직 없으면 매칭할 게 없다 — 빈 상태. (세션이 생기면 loadKey 가 바뀌어 다시 읽는다.)
        guard !ids.isEmpty else { load = .empty; return }
        if !load.hasData { load = .loading }
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        var iter = 0
        while !Task.isCancelled {
            do {
                let resp = try await api.mergeQueue(repoPath: repoPath)
                let mine = resp.requests
                    .filter { req in req.sessionId.map { ids.contains($0) } ?? false }
                    .sorted { $0.updatedAt > $1.updatedAt }
                load = mine.isEmpty ? .empty : .loaded(mine)
                let active = mine.contains { $0.status == "queued" || $0.status == "processing" }
                if !active && runStatus != "running" { break }
            } catch {
                if !load.hasData { load = .error }
                break
            }
            iter += 1
            if iter >= 60 { break }   // 폭주 방지 캡(~150s) — running 채로 머지 없이 오래 걸려도 멈춘다.
            try? await Task.sleep(nanoseconds: 2_500_000_000)
        }
    }

    /// 칩 요약에 쓸 «가장 눈에 띄어야 할» 한 건 — 충돌 > 실패 > 처리 > 대기 > 병합 > 취소 순.
    private func primaryEntry(_ list: [MergeRequest]) -> MergeRequest? {
        let rank: [String: Int] = [
            "conflict": 0, "failed": 1, "processing": 2, "queued": 3, "merged": 4, "cancelled": 5,
        ]
        return list.min { (rank[$0.status] ?? 9) < (rank[$1.status] ?? 9) }
    }
}

/// 격리·머지 로딩 상태. loaded 는 이 run 에 귀속된 머지 요청 목록(보통 1건).
enum RunIsolationLoad: Equatable {
    case loading
    case inactive          // 프로 미보유 — 격리(worktree) 비활성
    case empty             // 머지 미요청(매칭 없음)
    case error
    case loaded([MergeRequest])

    var hasData: Bool {
        if case .loaded = self { return true }
        return false
    }
}

// MARK: - 자세히 시트

/// run 격리·머지 자세히 — 상태별 안내 + 격리 브랜치 머지 목록. 읽기전용(관측 전용, 동작 없음).
struct WorkflowRunMergeSheet: View {
    let load: RunIsolationLoad
    let onRetry: () -> Void

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("실행 격리")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("닫기") { dismiss() }
                    }
                }
        }
        .presentationDetents([.medium, .large])
    }

    @ViewBuilder
    private var content: some View {
        switch load {
        case .loading:
            ProgressView()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .inactive:
            // 격리(worktree) = pro 기능 — placeholder 아이콘은 pro 주황 강조.
            IsolationPlaceholder(
                systemImage: "arrow.triangle.branch",
                tint: Theme.pro,
                title: "격리 실행은 프로 기능이에요",
                message: "워크플로우 실행을 격리 브랜치에서 돌리고 main 에 다시 머지하려면 프로가 필요해요."
            )
        case .empty:
            IsolationPlaceholder(
                systemImage: "arrow.triangle.branch",
                tint: .secondary,
                title: "격리 머지 요청이 없어요",
                message: "이 실행은 아직 격리 브랜치를 main 에 머지 요청하지 않았어요."
            )
        case .error:
            VStack(spacing: Theme.Spacing.xxl) {
                IsolationPlaceholder(
                    systemImage: "exclamationmark.triangle.fill",
                    tint: .secondary,
                    title: "격리 상태를 불러오지 못했어요",
                    message: nil
                )
                Button("다시 시도") { onRetry() }
                    .buttonStyle(.bordered)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .loaded(let list):
            List {
                Section {
                    ForEach(list) { RunMergeRow(request: $0) }
                } header: {
                    Text("격리 브랜치")
                } footer: {
                    Text("이 실행의 격리 브랜치를 main 에 합치는 요청이에요. 충돌하면 그 항목만 멈춰요.")
                }
            }
            .listStyle(.insetGrouped)
        }
    }
}

/// 격리 브랜치 머지 한 줄 — 격리 브랜치명(pro 주황 아이콘) → 대상, 상태 배지, 충돌/실패 사유.
private struct RunMergeRow: View {
    let request: MergeRequest

    var body: some View {
        HStack(spacing: Theme.Spacing.l) {
            // 격리(worktree) 강조 = pro 주황 — 아이콘에만(행 전역 tint 아님).
            Image(systemName: "arrow.triangle.branch")
                .foregroundStyle(Theme.pro)
                .frame(width: 20)
            VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
                // 브랜치명은 git 식별자 → verbatim. 본문색 .primary 자동 적응.
                Text(verbatim: request.sourceBranch)
                    .font(.callout.weight(.medium))
                    .lineLimit(1)
                    .truncationMode(.middle)
                HStack(spacing: Theme.Spacing.xs) {
                    Image(systemName: "arrow.right").font(.caption2)
                    Text(verbatim: request.targetBranch).font(.caption2)
                }
                .foregroundStyle(.secondary)
                if let detail = subtitle {
                    Text(verbatim: detail)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                        .truncationMode(.middle)
                }
            }
            Spacer(minLength: Theme.Spacing.m)
            MergeStatusBadge(status: request.status)
        }
        .padding(.vertical, Theme.Spacing.xxs)
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

// MARK: - 작은 컴포넌트

/// 머지 상태 배지 — 라벨/의미색은 BranchSheet 의 `mergeStatusLabel`/`mergeStatusColor` 와 공유.
struct MergeStatusBadge: View {
    let status: String

    var body: some View {
        Text(mergeStatusLabel(status))
            .font(.caption2.weight(.semibold))
            .foregroundStyle(mergeStatusColor(status))
            .padding(.horizontal, Theme.Spacing.m)
            .padding(.vertical, Theme.Spacing.xxs)
            .background(mergeStatusColor(status).opacity(Theme.Opacity.badge), in: Capsule())
            .accessibilityLabel(Text(mergeStatusLabel(status)))
    }
}

/// «프로» 태그 — pro 주황(강조). 격리가 프로 기능임을 칩에서 한눈에.
private struct ProTag: View {
    var body: some View {
        Text("프로")
            .font(.caption2.weight(.semibold))
            .foregroundStyle(Theme.pro)
            .padding(.horizontal, Theme.Spacing.m)
            .padding(.vertical, Theme.Spacing.xxs)
            .background(Theme.pro.opacity(Theme.Opacity.badge), in: Capsule())
    }
}

/// 빈/오류/비활성 placeholder — IconSize 토큰의 아이콘 + 제목 + (선택)설명. 본문색 자동 적응.
private struct IsolationPlaceholder: View {
    let systemImage: String
    let tint: Color
    let title: LocalizedStringKey
    let message: LocalizedStringKey?

    var body: some View {
        VStack(spacing: Theme.Spacing.l) {
            Image(systemName: systemImage)
                .font(.system(size: Theme.IconSize.l))
                .foregroundStyle(tint)
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
