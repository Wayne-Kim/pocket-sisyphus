import SwiftUI

/// 성적표(po_stats_v1) — 공용 포맷터·요약 행·상세 시트.
/// 원래 BacklogView.swift 안에 private 으로 있던 것을 동작 그대로(접근 수준만 private→internal) 옮긴 것 — 행동보존 추출. 색·문자열·레이아웃 그대로.
// MARK: - 성적표 (po_stats_v1)

/// 성적표 공용 포맷터 — 요약 행과 상세 시트가 같은 표기를 쓴다.
enum PoStatsFormat {
    /// 승인율 → 로케일 % 문자열 ("62%"). NumberFormatter 가 로케일별 기호/자릿수를 처리.
    static func percent(_ rate: Double) -> String {
        let f = NumberFormatter()
        f.numberStyle = .percent
        f.maximumFractionDigits = 0
        return f.string(from: NSNumber(value: rate)) ?? "\(Int((rate * 100).rounded()))%"
    }

    /// 결재 중앙값(초) → 로케일 기간 문자열 ("12분", "2시간 5분"). 시스템 포맷터가 번역을 처리.
    static func duration(_ seconds: Double) -> String? {
        let f = DateComponentsFormatter()
        f.unitsStyle = .abbreviated
        f.maximumUnitCount = 2
        f.allowedUnits = seconds >= 60 ? [.day, .hour, .minute] : [.second]
        return f.string(from: seconds)
    }
}

/// 백로그 상단 요약 1줄 — «승인율 62% · 검증 적중 4/5». 결재 데이터 5건 미만이면 잘못된 %
/// 강조를 피하려 «아직 데이터가 부족해요» 로 대신한다 (수용 기준).
struct PoStatsSummaryRow: View {
    let stats: PoStats

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "chart.bar.xaxis")
                .font(.body)
                .foregroundStyle(Theme.pro)
            VStack(alignment: .leading, spacing: 2) {
                Text("성적표")
                    .font(.callout.weight(.semibold))
                summary
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
            Image(systemName: "chevron.right")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.tertiary)
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
    }

    @ViewBuilder
    private var summary: some View {
        if stats.decidedCount < 5 {
            Text("아직 데이터가 부족해요")
        } else if let rate = stats.approvalRate {
            let pct = PoStatsFormat.percent(rate)
            let settled = stats.verified + stats.missed
            if settled > 0 {
                Text("승인율 \(pct) · 검증 적중 \(stats.verified)/\(settled)")
            } else {
                Text("승인율 \(pct)")
            }
        } else {
            Text("아직 데이터가 부족해요")
        }
    }
}

/// 성적표 상세 시트 — 전체 합산 + 레포별 분해. 적중(verified)=success(초록),
/// 빗나감(missed)=danger(빨강) — 기존 배지 색 약속 재사용.
struct PoStatsSheet: View {
    @Environment(\.dismiss) private var dismiss

    let stats: PoStats
    /// 「검증 사유」 줄을 탭하면 호출 — 그 id 의 브리프가 목록에 있어 내비게이트하면 true,
    /// 없으면(삭제 등) false. false 면 시트가 «찾을 수 없음» 안내를 띄운다.
    var onOpenBrief: (String) -> Bool = { _ in false }

    /// 탭한 브리프를 목록에서 못 찾았을 때의 안내 alert 표시 여부.
    @State private var briefNotFound = false

    /// 잘못된 % 강조 방지 — 결재 5건 미만이면 률 대신 건수만 보여준다.
    private var enoughData: Bool { stats.decidedCount >= 5 }

    var body: some View {
        NavigationStack {
            List {
                if !enoughData {
                    Section {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("아직 데이터가 부족해요")
                                .font(.callout.weight(.semibold))
                            Text("결재(승인·기각)가 5건 쌓이면 승인율을 보여드려요.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        .padding(.vertical, 2)
                    }
                }
                bucketSection(stats.totalBucket, header: Text("전체"))
                // 기각이 «어디에 몰리는지» — 결재가 충분히 쌓였을 때만(enoughData 재사용) 전체(필터된)
                // 집합의 차원 분해를 보여준다. 데이터 부족·분해 없음이면 통째로 숨김 (기존 정책 일치).
                if enoughData {
                    breakdownSection(stats.totalBucket)
                }
                // 레포별 분해 — 1개 레포뿐이면 전체와 동일해 생략 (멀티 프로젝트에서만 의미).
                if stats.repos.count > 1 {
                    ForEach(stats.repos, id: \.repoPath) { repo in
                        bucketSection(
                            repo,
                            header: Text(verbatim: (repo.repoPath as NSString).lastPathComponent),
                        )
                    }
                }
                // 출시 후 빗나감 분해 — verified/missed 가 충분히 쌓였을 때만 (enoughData 재사용).
                // 구 daemon/검증 0이면 nil → 섹션 통째로 숨김 (verifyNotesSection 보다 위에 배치).
                if enoughData {
                    outcomeBreakdownSection(stats.totalBucket)
                }
                byReasonSection
                verifyNotesSection
            }
            .navigationTitle("성적표")
            .navigationBarTitleDisplayMode(.inline)
            .alert("브리프를 찾을 수 없어요", isPresented: $briefNotFound) {
                Button("확인", role: .cancel) {}
            } message: {
                Text("이 브리프는 목록에서 사라졌어요. 삭제됐을 수 있어요.")
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    // 해제 버튼은 강조색이 아니라 중립(primary) — color 정책.
                    Button("닫기") { dismiss() }
                        .tint(.primary)
                }
            }
        }
    }

    /// 기각 사유 — rejected/held 브리프의 decide_reason 집계 (po_decide_reason_v2). 사람이 «직접
    /// 말한» 사유로 집계 — «왜 기각했나» 의 가장 직접적 신호. 구 daemon nil/충분 데이터 미만/전부 0건이면
    /// 섹션 통째 숨김. 많은 순 정렬, 0건 키는 생략. none(decide_reason NULL)은 «사유 미기재» 라벨.
    @ViewBuilder
    private var byReasonSection: some View {
        if enoughData, let byReason = stats.byReason {
            let entries = reasonEntries(byReason)
            if !entries.isEmpty {
                Section {
                    ForEach(entries, id: \.key) { e in
                        LabeledContent {
                            // 기각 사유 건수 — danger(빨강) 강조. 기각률 분해와 같은 색 약속.
                            Text(verbatim: "\(e.count)")
                                .foregroundStyle(Theme.danger)
                                .fontWeight(.semibold)
                        } label: {
                            e.label
                        }
                        .accessibilityElement(children: .combine)
                        .accessibilityLabel(e.label)
                        .accessibilityValue(Text("\(e.count)건"))
                    }
                } header: {
                    Text("기각 사유")
                } footer: {
                    Text("어떤 사유로 제안을 거절했는지 보여줘요.")
                }
            }
        }
    }

    /// byReason 딕셔너리를 건수 많은 순으로 정렬 — 0건 제외, none 은 «사유 미기재» 라벨.
    private struct ReasonEntry {
        let key: String
        let label: Text
        let count: Int
    }

    private func reasonEntries(_ byReason: [String: Int]) -> [ReasonEntry] {
        // 5개 enum 키 + none. 0건은 제외.
        return byReason.compactMap { key, count -> ReasonEntry? in
            guard count > 0 else { return nil }
            let label: Text
            if key == "none" {
                label = Text("사유 미기재")
            } else if let reason = DecideReason(rawValue: key) {
                label = reason.label
            } else {
                // 허용 키 밖 (이상값) — none 으로 집계됐을 텐데 혹시 모를 폴백.
                label = Text(verbatim: key)
            }
            return ReasonEntry(key: key, label: label, count: count)
        }
        .sorted { $0.count > $1.count }
    }

    /// 검증 사유 — 출시 후 verified/missed 판정의 verify_note 를 모아 «왜 빗나갔나» 패턴을
    /// 한눈에 보여준다 (po_verify_notes_v1). 사유 없으면(구 daemon nil / 빈 배열) 섹션 통째 숨김.
    /// verified=success(초록) · missed=danger(빨강) — 성적표 배지와 같은 색 약속 재사용.
    @ViewBuilder
    private var verifyNotesSection: some View {
        if let notes = stats.verifyNotes, !notes.isEmpty {
            Section {
                ForEach(notes) { n in
                    let isMissed = n.status == "missed"
                    // 줄 전체를 탭하면 그 id 의 브리프 상세로 — onOpenBrief 가 false(목록에 없음)
                    // 면 «찾을 수 없음» 안내. 인터랙션만 추가하고 verified/missed 아이콘 색은 보존.
                    Button {
                        if !onOpenBrief(n.id) {
                            briefNotFound = true
                        }
                    } label: {
                        HStack(spacing: 8) {
                            Label {
                                // 모델 산출 본문 — 번역 대상이 아니라 그대로(.primary, 자동 적응).
                                Text(verbatim: n.note)
                                    .font(.callout)
                                    .foregroundStyle(.primary)
                            } icon: {
                                Image(systemName: isMissed ? "xmark.circle.fill" : "checkmark.circle.fill")
                                    .foregroundStyle(isMissed ? Theme.danger : Theme.success)
                                    .accessibilityLabel(isMissed ? Text("빗나감") : Text("검증됨"))
                            }
                            Spacer(minLength: 0)
                            // 탭 가능 affordance — 중립(.tertiary) chevron, 강조색을 빌리지 않는다.
                            Image(systemName: "chevron.right")
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(.tertiary)
                        }
                    }
                    .buttonStyle(.plain)
                    .padding(.vertical, 2)
                    .accessibilityHint(Text("브리프 열기"))
                }
            } header: {
                Text("검증 사유")
            } footer: {
                Text("출시한 기능이 적중·빗나간 판정 사유예요.")
            }
        }
    }

    @ViewBuilder
    private func bucketSection(_ s: PoRepoStats, header: Text) -> some View {
        Section {
            countRow(Text("제안"), s.proposed)
            countRow(Text("승인"), s.approved)
            countRow(Text("기각"), s.rejected)
            countRow(Text("출시"), s.shipped)
            // 출시 후 검증 — 기존 배지 색 약속 (verified=초록 / missed=빨강).
            countRow(Text("검증됨"), s.verified, color: s.verified > 0 ? Theme.success : nil)
            countRow(Text("빗나감"), s.missed, color: s.missed > 0 ? Theme.danger : nil)
            if enoughData, let rate = s.approvalRate {
                LabeledContent {
                    Text(verbatim: PoStatsFormat.percent(rate))
                        .foregroundStyle(.primary)
                } label: {
                    Text("승인율")
                }
            }
            if enoughData, let median = s.medianDecisionSeconds,
               let text = PoStatsFormat.duration(median) {
                LabeledContent {
                    Text(verbatim: text)
                        .foregroundStyle(.primary)
                } label: {
                    Text("결재 중앙값")
                }
            }
        } header: {
            header
        } footer: {
            // 기각만 잔뜩인 초기 — 0% 라도 비난조가 아닌 중립 안내 (엣지케이스).
            if s.approvalRate == 0 && s.rejected > 0 {
                Text("수정 지시로 방향을 알려주면 다음 제안이 좋아져요.")
            }
        }
    }

    private func countRow(_ label: Text, _ count: Int, color: Color? = nil) -> some View {
        LabeledContent {
            Text(verbatim: "\(count)")
                .foregroundStyle(color ?? Color.secondary)
                .fontWeight(color != nil ? .semibold : .regular)
        } label: {
            label
        }
    }

    // MARK: 기각이 몰리는 곳 (po_stats_breakdown_v1)

    /// 노이즈 차단 — 한 차원 칸의 결재가 이 수 미만이면 률을 안 보여준다(1/1=100% 같은 허상 방지).
    private static let minBucketDecided = 3
    /// 출시 후 검증 분해의 최소 검증 건수 게이트 — 결재와 같은 기준 (3건 미만은 노이즈).
    private static let minOutcomeCompleted = 3

    /// 분해 한 줄 — 차원 값 라벨 + 그 칸의 기각 셀. 노력/렌즈 차원이 같은 행 모양을 공유한다.
    private struct BreakdownEntry: Identifiable {
        let id: String
        let label: LocalizedStringKey
        let systemImage: String
        let cell: PoStatsCell
    }

    /// 출시 후 검증 분해 한 줄 — 차원 값 라벨 + 그 칸의 verified/missed 셀.
    private struct OutcomeBreakdownEntry: Identifiable {
        let id: String
        let label: LocalizedStringKey
        let systemImage: String
        let cell: PoOutcomeCell
    }

    /// 노력(effort) 구간별 — 충분히 쌓인 칸만, 기각이 잦은 순으로 위(고effort 편중을 먼저 드러냄).
    private func effortEntries(_ s: PoRepoStats) -> [BreakdownEntry] {
        guard let m = s.byEffort else { return [] }
        let order: [(String, LocalizedStringKey)] = [
            ("high", "노력 높음"), ("mid", "노력 보통"), ("low", "노력 낮음"),
        ]
        return order.compactMap { key, label in
            guard let cell = m[key], cell.decided >= Self.minBucketDecided else { return nil }
            return BreakdownEntry(id: "effort-\(key)", label: label, systemImage: "hammer", cell: cell)
        }
    }

    /// 리서치 «전문가 관점»(lens)별 — 충분히 쌓인 칸만, 기각률 높은 순. 표시명은 리서치와 같은 카탈로그 키.
    private func lensEntries(_ s: PoRepoStats) -> [BreakdownEntry] {
        guard let m = s.byLens else { return [] }
        return m.compactMap { key, cell -> BreakdownEntry? in
            guard cell.decided >= Self.minBucketDecided else { return nil }
            return BreakdownEntry(
                id: "lens-\(key)", label: poResearchLensName(key), systemImage: "eyeglasses",
                cell: cell)
        }
        .sorted { ($0.cell.rejectionRate ?? 0, $0.id) > ($1.cell.rejectionRate ?? 0, $1.id) }
    }

    /// 근거(evidence) 종류별 — 충분히 쌓인 칸만, 기각률 높은 순. 표시명은 근거 종류 키 매핑.
    /// 구 daemon 응답엔 byEvidence 가 nil → 빈 배열(행 자체가 안 뜸, 회귀 없음).
    private func evidenceEntries(_ s: PoRepoStats) -> [BreakdownEntry] {
        guard let m = s.byEvidence else { return [] }
        return m.compactMap { key, cell -> BreakdownEntry? in
            guard cell.decided >= Self.minBucketDecided else { return nil }
            return BreakdownEntry(
                id: "evidence-\(key)", label: poEvidenceKindName(key), systemImage: "link",
                cell: cell)
        }
        .sorted { ($0.cell.rejectionRate ?? 0, $0.id) > ($1.cell.rejectionRate ?? 0, $1.id) }
    }

    @ViewBuilder
    private func breakdownSection(_ s: PoRepoStats) -> some View {
        let entries = effortEntries(s) + lensEntries(s) + evidenceEntries(s)
        if !entries.isEmpty {
            Section {
                ForEach(entries) { breakdownRow($0) }
            } header: {
                Text("기각이 몰리는 곳")
            } footer: {
                // 비난조 아닌 중립 — 기존 footer 톤 일치 (방향 안내).
                Text("어떤 제안이 자주 거절되는지 보여줘요 — 다음 수집의 방향에 참고하세요.")
            }
        }
    }

    private func breakdownRow(_ e: BreakdownEntry) -> some View {
        LabeledContent {
            HStack(spacing: 6) {
                Text(verbatim: "\(e.cell.rejected)/\(e.cell.decided)")
                    .foregroundStyle(.secondary)
                if let rate = e.cell.rejectionRate {
                    // 기각 강조 = danger(빨강). status 색을 «장식» 으로 빌리는 게 아니라 의미 그대로.
                    Text(verbatim: PoStatsFormat.percent(rate))
                        .foregroundStyle(Theme.danger)
                        .fontWeight(.semibold)
                }
            }
        } label: {
            Label { Text(e.label) } icon: { Image(systemName: e.systemImage) }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Text(e.label))
        .accessibilityValue(
            Text("기각률 \(e.cell.rejectionRate.map { PoStatsFormat.percent($0) } ?? "—")"))
    }

    // MARK: 출시 후 빗나감 분해 (po_outcome_breakdown_v1)

    /// 노력(effort) 구간별 출시 후 검증 — 충분히 쌓인 칸만, 빗나감이 잦은 순.
    private func outcomeEffortEntries(_ s: PoRepoStats) -> [OutcomeBreakdownEntry] {
        guard let m = s.outcomeByEffort else { return [] }
        let order: [(String, LocalizedStringKey)] = [
            ("high", "노력 높음"), ("mid", "노력 보통"), ("low", "노력 낮음"),
        ]
        return order.compactMap { key, label in
            guard let cell = m[key], cell.completed >= Self.minOutcomeCompleted else { return nil }
            return OutcomeBreakdownEntry(
                id: "outcome-effort-\(key)", label: label, systemImage: "hammer", cell: cell)
        }
        .sorted { ($0.cell.missedRate ?? 0, $0.id) > ($1.cell.missedRate ?? 0, $1.id) }
    }

    /// 리서치 «전문가 관점»(lens)별 출시 후 검증 — 충분히 쌓인 칸만, 빗나감률 높은 순.
    private func outcomeLensEntries(_ s: PoRepoStats) -> [OutcomeBreakdownEntry] {
        guard let m = s.outcomeByLens else { return [] }
        return m.compactMap { key, cell -> OutcomeBreakdownEntry? in
            guard cell.completed >= Self.minOutcomeCompleted else { return nil }
            return OutcomeBreakdownEntry(
                id: "outcome-lens-\(key)", label: poResearchLensName(key),
                systemImage: "eyeglasses", cell: cell)
        }
        .sorted { ($0.cell.missedRate ?? 0, $0.id) > ($1.cell.missedRate ?? 0, $1.id) }
    }

    /// 근거(evidence) 종류별 출시 후 검증 — 충분히 쌓인 칸만, 빗나감률 높은 순. byEvidence 와 같은
    /// kind 원천. 구 daemon/검증 0이면 outcomeByEvidence 가 nil → 빈 배열(행 안 뜸, 회귀 없음).
    private func outcomeEvidenceEntries(_ s: PoRepoStats) -> [OutcomeBreakdownEntry] {
        guard let m = s.outcomeByEvidence else { return [] }
        return m.compactMap { key, cell -> OutcomeBreakdownEntry? in
            guard cell.completed >= Self.minOutcomeCompleted else { return nil }
            return OutcomeBreakdownEntry(
                id: "outcome-evidence-\(key)", label: poEvidenceKindName(key),
                systemImage: "link", cell: cell)
        }
        .sorted { ($0.cell.missedRate ?? 0, $0.id) > ($1.cell.missedRate ?? 0, $1.id) }
    }

    @ViewBuilder
    private func outcomeBreakdownSection(_ s: PoRepoStats) -> some View {
        let entries = outcomeEffortEntries(s) + outcomeLensEntries(s) + outcomeEvidenceEntries(s)
        if !entries.isEmpty {
            Section {
                ForEach(entries) { outcomeBreakdownRow($0) }
            } header: {
                Text("출시 후 빗나감")
            } footer: {
                // 비난조 아닌 중립 — «어떤 베팅이 더 자주 빗나가는지» 를 보여주는 데이터 (방향 안내).
                Text("어떤 노력·관점·근거의 출시 기능이 더 자주 빗나가는지 보여줘요.")
            }
        }
    }

    private func outcomeBreakdownRow(_ e: OutcomeBreakdownEntry) -> some View {
        LabeledContent {
            HStack(spacing: 6) {
                Text(verbatim: "\(e.cell.missed)/\(e.cell.completed)")
                    .foregroundStyle(.secondary)
                if let rate = e.cell.missedRate {
                    // 빗나감 강조 = danger(빨강) — verifyNotesSection 의 missed 색과 같은 약속.
                    Text(verbatim: PoStatsFormat.percent(rate))
                        .foregroundStyle(Theme.danger)
                        .fontWeight(.semibold)
                }
            }
        } label: {
            Label { Text(e.label) } icon: { Image(systemName: e.systemImage) }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Text(e.label))
        .accessibilityValue(
            Text("빗나감률 \(e.cell.missedRate.map { PoStatsFormat.percent($0) } ?? "—")"))
    }
}
