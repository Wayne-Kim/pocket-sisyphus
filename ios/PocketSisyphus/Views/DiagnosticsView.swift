import SwiftUI

/// 「문제 신고 · 진단」 화면 — daemon 의 로컬 진단 번들(서브시스템 스냅샷 + 최근 crash 마커 +
/// 마스킹된 unified.log tail)을 받아 요약을 보여 주고, 사용자가 «직접» 공유/내보내기 한다.
///
/// 자동 전송은 «없다» — LAN 전용·무텔레메트리 원칙(daemon egress.ts·THREAT_MODEL §5.11). 비밀
/// (webhook URL·토큰·키)은 daemon 이 마스킹해 보낸다. iOS 는 그걸 그대로 옮길 뿐이다.
///
/// 색 정책(이 레포 약속): 파괴/위험이 아니므로 danger(빨강)를 쓰지 않는다. 「공유/내보내기」 는
/// 기본 accent(보라) 컨트롤(ShareLink — 별도 tint 없이 AccentColor 가 잡는다). warning(노랑)은
/// 「민감정보 포함 가능」 같은 «진짜 주의 고지» 에만, pro(주황)는 쓰지 않는다. 전역 .tint() 금지,
/// 본문은 .primary/.secondary, 하드코딩 색 없음 — 라이트/다크 모두 대비가 맞는 적응색만 쓴다.
struct DiagnosticsView: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var conn: ConnectionManager
    @EnvironmentObject var inflight: InFlightTracker
    @Environment(\.dismiss) private var dismiss

    /// 화면 상태 — 생성중(로딩)/완료(빈 포함)/오류. 「빈」 은 완료 후 bundle.isEmpty 로 분기.
    private enum Phase: Equatable {
        case loading
        case loaded(DiagnosticsBundle)
        case failed(String)
    }
    @State private var phase: Phase = .loading
    /// 공유/내보내기 대상 임시 파일. 번들이 로드되면 채워진다(없으면 텍스트 직접 공유로 폴백).
    @State private var exportURL: URL?

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("문제 신고 · 진단")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        // 닫기 같은 «해제» 버튼은 강조색(보라) 아니라 primary(중립) — 시트 관례.
                        Button("닫기") { dismiss() }
                            .tint(Color.primary)
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        if case .loaded = phase {
                            shareLink {
                                Image(systemName: "square.and.arrow.up")
                            }
                            .accessibilityLabel(Text("진단 번들 공유"))
                        }
                    }
                }
        }
        .task { await load() }
    }

    @ViewBuilder
    private var content: some View {
        switch phase {
        case .loading:
            loadingView
        case .loaded(let bundle):
            loadedView(bundle)
        case .failed(let message):
            errorView(message)
        }
    }

    // MARK: - 상태별 뷰

    private var loadingView: some View {
        VStack(spacing: Theme.Spacing.xxl) {
            ProgressView()
            Text("진단 번들을 만들고 있어요…")
                .font(.callout)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func errorView(_ message: String) -> some View {
        VStack(spacing: Theme.Spacing.xl) {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: Theme.IconSize.xl))
                .foregroundStyle(.secondary)
            Text("진단 번들을 만들지 못했어요")
                .font(.headline)
            // 오류 사유 — daemon/전송 계층이 준 사람 읽는 메시지. 데이터라 .secondary.
            Text(verbatim: message)
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Button("다시 시도") {
                Task { await load() }
            }
            .buttonStyle(.borderedProminent)
        }
        .padding(Theme.Spacing.xxxxl)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func loadedView(_ bundle: DiagnosticsBundle) -> some View {
        List {
            Section {
                privacyNotice
            }

            if bundle.isEmpty {
                Section { emptyState }
            }

            summarySection(bundle.subsystem, bundle.config)
            crashSection(bundle.crashes)
            logSection(bundle)

            Section {
                shareLink {
                    Label("공유 · 내보내기", systemImage: "square.and.arrow.up")
                }
                .accessibilityLabel(Text("진단 번들 공유 및 내보내기"))
            } footer: {
                Text("자동으로 전송되는 정보는 없어요. 공유 대상은 직접 고릅니다.")
            }
        }
    }

    // MARK: - 구성 조각

    /// 「민감정보 포함 가능」 주의 고지 — 진짜 주의라 warning(노랑) 아이콘. 본문은 .secondary.
    private var privacyNotice: some View {
        HStack(alignment: .top, spacing: Theme.Spacing.l) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(Theme.warning)
            VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                Text("민감정보가 포함될 수 있어요")
                    .font(.subheadline.weight(.semibold))
                Text("이 번들에는 파일 경로·디버그 로그가 들어갈 수 있어요. 토큰·키·웹훅 주소 같은 비밀값은 자동으로 가려지지만, 공유 전 한 번 확인하세요.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }

    /// 「로그 없음(빈)」 상태 — 빈 상태 placeholder 아이콘(IconSize 토큰).
    private var emptyState: some View {
        VStack(spacing: Theme.Spacing.l) {
            Image(systemName: "doc.text.magnifyingglass")
                .font(.system(size: Theme.IconSize.l))
                .foregroundStyle(.secondary)
            Text("아직 진단할 로그가 없어요")
                .font(.headline)
            Text("크래시나 로그가 모이면 여기에서 묶어 공유할 수 있어요.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, Theme.Spacing.l)
    }

    private func summarySection(
        _ s: DiagnosticsBundle.Subsystem,
        _ c: DiagnosticsBundle.ConfigSummary
    ) -> some View {
        Section {
            // 라벨만 로컬라이즈, 값(버전·id·수치)은 데이터라 verbatim.
            LabeledContent("Mac 앱 버전") { Text(verbatim: "v\(s.daemonVersion)") }
            LabeledContent("인스턴스") { Text(verbatim: s.instanceId) }
            LabeledContent("연결된 클라이언트") { Text(verbatim: "\(s.connectedClients)") }
            // 양갈래 한글은 ternary 안에서 String 으로 추론돼 카탈로그를 우회하므로(CLAUDE.md
            // 안티패턴), 각 분기를 별도 Text 로 쪼개 LocalizedStringKey 추출 경로를 타게 한다.
            LabeledContent("Tor") {
                (s.torActive ? Text("활성") : Text("비활성")).foregroundStyle(.secondary)
            }
            LabeledContent("LAN 전용 모드") {
                (c.lanOnly ? Text("켜짐") : Text("꺼짐")).foregroundStyle(.secondary)
            }
        } header: {
            Text("요약")
        }
    }

    @ViewBuilder
    private func crashSection(_ crashes: [DiagnosticsBundle.CrashReport]) -> some View {
        Section {
            if crashes.isEmpty {
                Text("기록된 크래시가 없어요")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(crashes) { crash in
                    crashRow(crash)
                }
            }
        } header: {
            // 개수는 데이터라 verbatim 으로 덧붙인다(라벨만 번역).
            HStack(spacing: Theme.Spacing.xs) {
                Text("최근 크래시")
                Text(verbatim: "(\(crashes.count))")
            }
        }
    }

    private func crashRow(_ crash: DiagnosticsBundle.CrashReport) -> some View {
        DisclosureGroup {
            // 스택은 디버그 로그 «원문» — 번역 대상 아님. 모노스페이스 고정 폰트.
            Text(verbatim: crash.error.stack)
                .font(.system(size: Theme.FontSize.code, design: .monospaced))
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
        } label: {
            VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
                Text(verbatim: crash.kind)
                    .font(.subheadline.weight(.semibold))
                Text(verbatim: "\(crash.at) · instance \(crash.context.instanceId)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder
    private func logSection(_ bundle: DiagnosticsBundle) -> some View {
        Section {
            if bundle.unifiedLogTail.isEmpty {
                Text("로그가 없어요")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            } else {
                DisclosureGroup {
                    // 로그 본문 — 디버그 원문이라 번역 대상 아님. 미리보기는 끝부분 일부만(성능).
                    Text(verbatim: logPreview(bundle.unifiedLogTail))
                        .font(.system(size: Theme.FontSize.code, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                } label: {
                    Text("로그 보기")
                }
            }
        } header: {
            HStack(spacing: Theme.Spacing.xs) {
                Text("기록")
                Text(verbatim: "(unified.log)")
            }
        } footer: {
            if bundle.unifiedLogTruncated {
                Text("마지막 일부만 표시돼요. 전체는 내보내기에 포함됩니다.")
            }
        }
    }

    // MARK: - 공유

    /// ShareLink — 파일 URL 이 있으면 파일을(내보내기/저장에 유리), 없으면 텍스트를 공유한다.
    /// 별도 .tint 없이 기본 accent(보라)를 따른다(색 정책). label 은 호출부가 준다.
    @ViewBuilder
    private func shareLink<Label: View>(@ViewBuilder label: () -> Label) -> some View {
        if let url = exportURL {
            ShareLink(item: url, label: label)
        } else if case .loaded(let bundle) = phase {
            ShareLink(item: bundle.exportText(), label: label)
        }
    }

    // MARK: - 로직

    /// 미리보기로 보여줄 로그 끝부분 — 거대한 tail 을 List 안에 통째로 그리지 않도록 캡.
    /// 전체 로그는 내보내기(exportText)에 포함되므로 미리보기는 끝 ~6000자만.
    private func logPreview(_ full: String) -> String {
        let cap = 6000
        guard full.count > cap else { return full }
        return "…" + String(full.suffix(cap))
    }

    @MainActor
    private func load() async {
        phase = .loading
        exportURL = nil
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        do {
            let bundle = try await api.getDiagnostics()
            exportURL = writeExportFile(bundle)
            phase = .loaded(bundle)
        } catch {
            let message = (error as? LocalizedError)?.errorDescription
                ?? error.localizedDescription
            phase = .failed(message)
        }
    }

    /// 진단 텍스트를 임시 파일로 써서 ShareLink(파일) 대상으로 쓴다. 실패하면 nil — 호출부가
    /// 텍스트 직접 공유로 폴백한다(공유 자체가 막히지 않게).
    private func writeExportFile(_ bundle: DiagnosticsBundle) -> URL? {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("pocket-sisyphus-diagnostics.txt")
        do {
            try bundle.exportText().data(using: .utf8)?.write(to: url, options: .atomic)
            return url
        } catch {
            return nil
        }
    }
}
