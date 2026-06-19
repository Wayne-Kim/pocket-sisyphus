import SwiftUI

/// 백로그 «결재 대기» 트리아지 — 200건이 평평하게 쌓여도 «무엇부터 결정할지» 가 한눈에 보이게
/// 점수 티어로 그룹핑하고, scope·repo·impact 로 좁히고, 다중 선택 후 한 번에 보류/기각한다
/// (저점수 다수를 빠르게 비우는 «트리아지 우선» 흐름). 점수=impact÷effort 는 기존 정렬 키 그대로.
///
/// 메인 백로그 리스트의 단건 결재(상세 진입)·딥링크는 그대로 두고, 이 시트는 «일괄 처리» surface
/// 로 추가된다. 데이터는 부모(BacklogView)가 이미 로드한 proposed 스냅샷을 받아 자체 필터/티어/
/// 선택 상태로 다룬다 — 일괄 결재가 끝나면 처리분을 로컬에서 빼고, 닫을 때 부모가 재로드한다.
///
/// 색 정책: 선택/주요 = accent(보라), 기각 = danger(빨강), 그 외(티어 배지·점수·보류) = 중립.
/// score 티어 배지에 warning(노랑)·pro(주황)를 쓰지 않는다 — 티어는 상태/프로 신호가 아니다.
struct BacklogTriageView: View {
    /// 일괄 결재 실행 — (ids, "hold"|"reject", reason) → 실제 처리된 브리프. po_bulk_decide_v1 분기/
    /// 단건 폴백은 부모가 처리한다. 부분 성공 가능(없는·이미 처리된 id 는 반환에서 빠진다).
    /// reason 은 보류/기각 사유 태그(po_decide_reason_v1) — 선택분 전체에 적용(미선택은 nil).
    let bulkDecide: (_ ids: [String], _ action: String, _ reason: String?) async throws -> [PoBrief]
    /// 시트가 닫힐 때 — 부모가 목록을 재로드해 처리분을 «처리됨» 으로 반영한다.
    let onClose: () -> Void

    @Environment(\.dismiss) private var dismiss

    /// 결재 대기 작업 집합 — 일괄 결재된 항목은 여기서 제거한다(시트 내 즉시 반영). 부모 스냅샷 복사본.
    @State private var working: [PoBrief]
    @State private var repoFilter: String?
    /// 최소 영향 필터 — nil=전체, n=영향 n 이상만.
    @State private var minImpact: Int?
    @State private var query = ""
    /// false=티어별(그룹핑), true=«오늘 결정할 N건»(상위 점수만).
    @State private var focusMode = false
    /// 접힌 티어 — 헤더만 남기고 행을 숨긴다(화면당 인지 부하 감소).
    @State private var collapsed: Set<ScoreTier> = []
    @State private var selection: Set<String> = []
    @State private var deciding = false
    @State private var error: String?
    @State private var confirmReject = false
    /// 일괄 보류/기각 사유 태그 (po_decide_reason_v1) — 선택분 전체에 적용(미선택 허용).
    @State private var decideReason: DecideReason?

    /// «오늘 결정할 N건» 의 상한 — 한 화면에 들어오는 «지금 결정할 만큼» 만 노출.
    private let focusCap = 7

    init(
        briefs: [PoBrief],
        bulkDecide: @escaping (_ ids: [String], _ action: String, _ reason: String?) async throws -> [PoBrief],
        onClose: @escaping () -> Void,
    ) {
        self.bulkDecide = bulkDecide
        self.onClose = onClose
        _working = State(initialValue: briefs)
    }

    var body: some View {
        NavigationStack {
            Group {
                if working.isEmpty {
                    emptyState
                } else {
                    listContent
                }
            }
            .navigationTitle("트리아지")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    // 닫기는 해제 동작 — 강조색이 아니라 중립(primary), 색 정책.
                    Button("닫기") {
                        dismiss()
                        onClose()
                    }
                    .tint(.primary)
                }
            }
            .searchable(text: $query, prompt: Text("제목·스코프 검색"))
            .safeAreaInset(edge: .bottom) {
                if !selection.isEmpty {
                    bulkBar
                }
            }
            // 일괄 기각은 파괴적 — 확인 다이얼로그로 한 번 더. 보류는 비파괴라 바로 실행.
            .confirmationDialog(
                Text("선택한 \(selection.count)건을 기각해요. 처리됨으로 옮겨가요."),
                isPresented: $confirmReject,
                titleVisibility: .visible,
            ) {
                Button("기각", role: .destructive) {
                    Task { await apply("reject") }
                }
            }
        }
    }

    // MARK: - 리스트

    private var listContent: some View {
        List {
            controlsSection
            if let error {
                Section {
                    Text(LocalizedStringKey(error))
                        .font(.caption)
                        .foregroundStyle(Theme.danger)
                }
            }
            if filtered.isEmpty {
                noResultsSection
            } else if focusMode {
                focusSection
            } else {
                tierSections
            }
        }
    }

    private var controlsSection: some View {
        Section {
            // 티어별 ↔ «오늘 결정할 N건» — 같은 결재 대기를 두 방식으로 본다.
            Picker("보기", selection: $focusMode) {
                Text("티어별").tag(false)
                Text("오늘 결정할 \(focusCount)건").tag(true)
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .accessibilityLabel(Text("보기"))

            // 영향 필터 칩 — 저영향을 걷어내고 «영향 큰 것부터» 보는 결재 흐름.
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: Theme.Spacing.m) {
                    TriageChip(title: Text("전체"), selected: minImpact == nil) {
                        minImpact = nil
                    }
                    ForEach([3, 4, 5], id: \.self) { n in
                        TriageChip(title: Text("영향 \(n)+"), selected: minImpact == n) {
                            minImpact = (minImpact == n) ? nil : n
                        }
                    }
                }
                .padding(.vertical, Theme.Spacing.xxs)
            }
            .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 0))

            // 멀티-프로젝트 백로그 — 전체/<레포> 토글. 레포가 둘 이상일 때만.
            if repoPaths.count > 1 {
                Picker(selection: $repoFilter) {
                    Text("전체").tag(String?.none)
                    ForEach(repoPaths, id: \.self) { path in
                        Text(verbatim: (path as NSString).lastPathComponent)
                            .tag(String?.some(path))
                    }
                } label: {
                    Label("프로젝트", systemImage: "folder")
                }
                .pickerStyle(.menu)
                // 피커 선택값 텍스트는 중립, List 행 아이콘은 accent — 색 정책(파랑 금지).
                .tint(Color.primary)
                .listItemTint(Theme.accent)
            }
        } footer: {
            Text("점수 = 영향 ÷ 노력. 높을수록 먼저 봐요.")
        }
    }

    private var noResultsSection: some View {
        Section {
            VStack(spacing: Theme.Spacing.l) {
                Text("필터에 맞는 결재 대기가 없어요")
                    .foregroundStyle(.secondary)
                Button("필터 초기화") { resetFilters() }
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, Theme.Spacing.xl)
        }
    }

    private var focusSection: some View {
        Section {
            ForEach(focusList) { brief in
                row(brief)
            }
        } header: {
            Text("오늘 결정할 \(focusList.count)건")
                .textCase(nil)
        }
    }

    @ViewBuilder
    private var tierSections: some View {
        ForEach(ScoreTier.allCases, id: \.self) { tier in
            let items = tierItems(tier)
            if !items.isEmpty {
                Section {
                    if !collapsed.contains(tier) {
                        ForEach(items) { brief in
                            row(brief)
                        }
                    }
                } header: {
                    tierHeader(tier, items: items)
                }
            }
        }
    }

    private func tierHeader(_ tier: ScoreTier, items: [PoBrief]) -> some View {
        let isCollapsed = collapsed.contains(tier)
        let tierIds = Set(items.map(\.id))
        let allSelected = !tierIds.isEmpty && tierIds.isSubset(of: selection)
        return HStack(spacing: Theme.Spacing.m) {
            Button {
                toggleCollapse(tier)
            } label: {
                HStack(spacing: Theme.Spacing.s) {
                    Image(systemName: isCollapsed ? "chevron.right" : "chevron.down")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(.secondary)
                    // 티어 배지 — 중립 텍스트(노랑/주황 금지). 옆에 건수.
                    tier.label
                        .foregroundStyle(.primary)
                    Text(verbatim: "\(items.count)")
                        .foregroundStyle(.secondary)
                }
            }
            .buttonStyle(.plain)
            .textCase(nil)
            .accessibilityElement(children: .combine)
            Spacer()
            // 티어 단위 전체 선택/해제 — 저점수 티어를 한 번에 골라 일괄 기각하는 핵심 통로.
            Button {
                toggleTier(items: items)
            } label: {
                allSelected ? Text("선택 해제") : Text("전체 선택")
            }
            .font(.caption)
            .textCase(nil)
        }
    }

    private func row(_ brief: PoBrief) -> some View {
        TriageBriefRow(
            brief: brief,
            selected: selection.contains(brief.id),
            showRepo: repoFilter == nil && repoPaths.count > 1,
            toggle: { toggleSelection(brief.id) },
        )
    }

    // MARK: - 하단 일괄 액션 바

    private var bulkBar: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.m) {
            // 일괄 보류/기각 사유 태그 (po_decide_reason_v1) — 선택한 묶음 전체에 같은 사유 적용.
            DecideReasonPicker(selected: $decideReason)
            HStack(spacing: Theme.Spacing.xl) {
                Text("\(selection.count)건 선택")
                    .font(.subheadline.weight(.semibold))
                Button("선택 해제") { selection.removeAll() }
                    .font(.caption)
                    .tint(.primary)
                Spacer(minLength: Theme.Spacing.m)
                if deciding {
                    ProgressView().controlSize(.small)
                }
                // 보류 — 비파괴(나중에 다시 결정 가능). 중립 틴트.
                Button {
                    Task { await apply("hold") }
                } label: {
                    Text("보류")
                }
                .buttonStyle(.bordered)
                .tint(.primary)
                // 기각 — 파괴적. danger(빨강) + confirmationDialog.
                Button(role: .destructive) {
                    confirmReject = true
                } label: {
                    Text("기각")
                }
                .buttonStyle(.bordered)
                .tint(Theme.danger)
            }
        }
        .disabled(deciding)
        .padding(.horizontal)
        .padding(.vertical, Theme.Spacing.l)
        .background(.bar)
    }

    // MARK: - 빈 상태

    private var emptyState: some View {
        VStack(spacing: Theme.Spacing.xl) {
            Image(systemName: "checkmark.circle")
                .font(.system(size: Theme.IconSize.l))
                .foregroundStyle(Theme.success)
            Text("결재 대기를 모두 처리했어요")
                .font(.title3.weight(.semibold))
            Text("보류·기각한 항목은 처리됨으로 옮겨가요.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, Theme.Spacing.xxxl)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - 파생값

    /// 작업 집합이 걸친 레포들 — 전체/<레포> 토글 후보(디렉토리명순).
    private var repoPaths: [String] {
        Set(working.map(\.repoPath))
            .sorted {
                ($0 as NSString).lastPathComponent
                    .localizedCaseInsensitiveCompare(($1 as NSString).lastPathComponent)
                    == .orderedAscending
            }
    }

    /// repo·impact·검색어로 좁힌 결재 대기.
    private var filtered: [PoBrief] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return working.filter { brief in
            (repoFilter == nil || brief.repoPath == repoFilter)
                && (minImpact.map { brief.impact >= $0 } ?? true)
                && (q.isEmpty || matches(brief, q))
        }
    }

    private func matches(_ brief: PoBrief, _ q: String) -> Bool {
        brief.title.lowercased().contains(q)
            || brief.scope.lowercased().contains(q)
            || brief.problem.lowercased().contains(q)
    }

    private func tierItems(_ tier: ScoreTier) -> [PoBrief] {
        filtered.filter { ScoreTier.of($0.score) == tier }
            .sorted { $0.score > $1.score }
    }

    /// «오늘 결정할 N건» — 점수 상위 최대 focusCap 건.
    private var focusCount: Int {
        min(focusCap, filtered.count)
    }

    private var focusList: [PoBrief] {
        Array(filtered.sorted { $0.score > $1.score }.prefix(focusCount))
    }

    // MARK: - 동작

    private func toggleSelection(_ id: String) {
        if selection.contains(id) {
            selection.remove(id)
        } else {
            selection.insert(id)
        }
    }

    private func toggleCollapse(_ tier: ScoreTier) {
        if collapsed.contains(tier) {
            collapsed.remove(tier)
        } else {
            collapsed.insert(tier)
        }
    }

    private func toggleTier(items: [PoBrief]) {
        let ids = items.map(\.id)
        if ids.allSatisfy({ selection.contains($0) }) {
            ids.forEach { selection.remove($0) }
        } else {
            ids.forEach { selection.insert($0) }
        }
    }

    private func resetFilters() {
        minImpact = nil
        query = ""
        repoFilter = nil
    }

    /// 일괄 결재 실행 — 성공분을 작업 집합/선택에서 제거. 실패(다임 연결 등)는 에러 배너.
    private func apply(_ action: String) async {
        let ids = Array(selection)
        guard !ids.isEmpty, !deciding else { return }
        deciding = true
        defer { deciding = false }
        do {
            let decided = try await bulkDecide(ids, action, decideReason?.rawValue)
            let decidedIds = Set(decided.map(\.id))
            working.removeAll { decidedIds.contains($0.id) }
            // 처리 안 된 선택(드물게 그새 바뀐 항목)이 남으면 혼동되므로 선택을 통째로 비운다.
            selection.removeAll()
            error = nil
        } catch {
            self.error = (error as? LocalizedError)?.errorDescription ?? "\(error)"
        }
    }
}

// MARK: - 점수 티어

/// score(=impact÷effort, 0.2~5.0) 를 «먼저 볼 가치» 로 3등분. 색이 아니라 그룹으로 우선순위를
/// 드러낸다 — 티어 배지에 status/pro 색을 빌려 쓰지 않는다(색 정책).
private enum ScoreTier: CaseIterable, Hashable {
    case high, mid, low

    var label: Text {
        switch self {
        case .high: return Text("높음")
        case .mid: return Text("중간")
        case .low: return Text("낮음")
        }
    }

    /// 높음 ≥2.0 (영향이 노력의 2배+) · 중간 1.0~2.0 · 낮음 <1.0.
    static func of(_ score: Double) -> ScoreTier {
        if score >= 2.0 { return .high }
        if score >= 1.0 { return .mid }
        return .low
    }
}

// MARK: - 칩

/// 필터 칩 — 선택 시 accent(보라) 채움, 아니면 중립. title 은 호출부 Text 라 LocalizedStringKey
/// 자동 추출 경로를 그대로 탄다.
private struct TriageChip: View {
    let title: Text
    let selected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            title
                .font(.caption.weight(.medium))
                .padding(.horizontal, Theme.Spacing.xl)
                .padding(.vertical, Theme.Spacing.s)
                .background(
                    Capsule().fill(
                        selected
                            ? Theme.accent
                            : Theme.neutralFill.opacity(Theme.Opacity.fill)),
                )
                .foregroundStyle(selected ? Theme.onAccent : Color.primary)
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
    }
}

// MARK: - 선택 가능한 브리프 행

/// 트리아지 한 행 — 선택 체크 + 제목 + 영향/점수. 탭하면 선택 토글(상세는 메인 리스트에서).
private struct TriageBriefRow: View {
    let brief: PoBrief
    let selected: Bool
    let showRepo: Bool
    let toggle: () -> Void

    var body: some View {
        Button(action: toggle) {
            HStack(alignment: .top, spacing: Theme.Spacing.xl) {
                Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                    .font(.title3)
                    .foregroundStyle(selected ? Theme.accent : Color.secondary)
                    .accessibilityLabel(selected ? Text("선택됨") : Text("선택 안 됨"))
                VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                    Text(brief.title)
                        .font(.callout.weight(.semibold))
                        .lineLimit(2)
                    HStack(spacing: Theme.Spacing.m) {
                        Label("영향 \(brief.impact)", systemImage: "arrow.up.right")
                        scoreBadge
                        Spacer(minLength: 0)
                        if showRepo {
                            Text(verbatim: repoName)
                        }
                    }
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                }
            }
            .padding(.vertical, Theme.Spacing.xxs)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
    }

    private var repoName: String {
        (brief.repoPath as NSString).lastPathComponent
    }

    private var scoreText: String {
        String(format: "%.1f", brief.score)
    }

    /// 점수 배지 — 중립 채움(노랑/주황 금지). 정렬 기준임을 드러내는 정보 표시.
    private var scoreBadge: some View {
        Text(verbatim: scoreText)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, Theme.Spacing.s)
            .padding(.vertical, Theme.Spacing.xxs)
            .background(Capsule().fill(Theme.neutralFill.opacity(Theme.Opacity.fill)))
            .foregroundStyle(.primary)
            .accessibilityLabel(Text("점수 \(scoreText)"))
    }
}
