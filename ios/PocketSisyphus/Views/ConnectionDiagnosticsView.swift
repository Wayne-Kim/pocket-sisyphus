import SwiftUI

/// 설정 → 「연결 진단」. daemon 의 서브시스템 상태(Tor·sshd·외부 연결성·에이전트 CLI·디스크·로그·
/// 네트워크)를 «읽기 전용» 으로 모아, 연결이 실패할 때 사용자가 「왜·무엇을 하라」 를 직접 본다.
///
/// 동기: 연결 실패가 원인 없는 일반 에러로만 떨어지던 것을, daemon `/api/diagnostics` 가 내보내는
/// 안정적 코드(diagnostics/codes.ts)를 사람이 읽는 localize 문구·권장 조치로 매핑해 보여준다.
/// 이 화면은 새 메커니즘이 아니라 «표면화» 다 — 아무 것도 바꾸지 않고 상태만 읽는다.
///
/// 색 정책(이 레포 약속): 상태색은 «의미» 로만 — 정상=success(초록)·주의/설정 필요=warning(노랑)·
/// 실패=danger(빨강)·미확인=secondary(중립). 진단은 프리미엄이 아니라 pro(주황)를 쓰지 않고,
/// warning(노랑)↔pro(주황)를 혼동하지 않는다. 본문/아이콘은 .primary/.secondary(자동 적응),
/// 상태색은 «상태 아이콘/배지» 에만. 전역 .tint() 안 건다.
struct ConnectionDiagnosticsView: View {
    @EnvironmentObject var auth: AuthStore
    @EnvironmentObject var conn: ConnectionManager
    @EnvironmentObject var inflight: InFlightTracker

    @State private var response: DiagnosticsResponse?
    @State private var loading = false
    /// 로드 실패 사유 (사람이 읽는). nil 이면 오류 없음.
    @State private var loadError: String?

    /// 시뮬레이터 «레이아웃 눈검증»(PS_DEV_DIAGNOSTICS)에서 seed 된 데이터로 렌더하고 fetch 를
    /// 건너뛰는 플래그. 운영 경로(기본 init)에선 항상 false.
    private let seeded: Bool

    init() { seeded = false }

#if DEBUG
    /// 시뮬레이터 dev 프리뷰 전용 — 대표 샘플 응답으로 즉시 로드 상태를 렌더(daemon 불필요).
    init(devSeed: DiagnosticsResponse) {
        _response = State(initialValue: devSeed)
        seeded = true
    }
#endif

    var body: some View {
        List {
            if let resp = response, !resp.subsystems.isEmpty {
                overallSection(resp)
                // 클라이언트가 직접 관측한 호스트 키 불일치(ssh_hostkey_mismatch) — daemon 스냅샷과
                // 별개의 신호라 최상단에 강조. 정상 자세에선 그려지지 않는다.
                if conn.sawHostKeyMismatch {
                    hostKeyMismatchBanner
                }
                ForEach(resp.subsystems) { sub in
                    subsystemSection(sub)
                }
            } else if loading {
                // 첫 로드 — 아래 overlay 의 ProgressView 가 스피너를 그린다(여기선 빈 리스트).
                EmptyView()
            } else if let loadError {
                errorPlaceholder(loadError)
            } else {
                emptyPlaceholder
            }
        }
        .overlay {
            if loading && response == nil {
                ProgressView("불러오는 중…")
            }
        }
        .navigationTitle("연결 진단")
        .navigationBarTitleDisplayMode(.inline)
        .task { if !seeded { await load() } }
        .refreshable { await load() }
    }

    // MARK: - 요약 (overall)

    private func overallSection(_ resp: DiagnosticsResponse) -> some View {
        let level = resp.overallLevel
        return Section {
            HStack(spacing: Theme.Spacing.m) {
                Image(systemName: level.icon)
                    .font(.title2)
                    .foregroundStyle(level.tint)
                    .frame(width: 28)
                    .accessibilityLabel(Text(verbatim: level.localizedLabel))
                VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
                    Text(verbatim: overallTitle(level))
                        .font(.headline)
                    Text(verbatim: String(localized: "마지막 확인 \(Self.formatTime(resp.generatedAt))"))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
            }
            .padding(.vertical, Theme.Spacing.xxs)
        } footer: {
            Text("Tor·SSH·디스크·에이전트 CLI 등 Mac의 연결 상태를 읽기 전용으로 확인해요. 아래로 당기면 새로고침돼요.")
        }
    }

    private func overallTitle(_ level: DiagnosticLevel) -> String {
        switch level {
        case .ok: return String(localized: "모든 연결이 정상이에요")
        case .warning: return String(localized: "주의가 필요한 항목이 있어요")
        case .error: return String(localized: "연결에 문제가 있어요")
        case .unknown: return String(localized: "일부 상태를 확인하지 못했어요")
        }
    }

    // MARK: - 호스트 키 불일치 배너 (클라이언트 관측)

    private var hostKeyMismatchBanner: some View {
        let code = DiagnosticCode.sshHostkeyMismatch
        return Section {
            HStack(alignment: .top, spacing: Theme.Spacing.m) {
                Image(systemName: DiagnosticLevel.error.icon)
                    .foregroundStyle(Theme.danger)
                    .font(.title3)
                    .frame(width: 28)
                    .accessibilityLabel(Text(verbatim: DiagnosticLevel.error.localizedLabel))
                VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
                    Text(verbatim: code.localizedTitle ?? "")
                        .font(.subheadline.weight(.semibold))
                    if let action = code.localizedAction {
                        Text(verbatim: action)
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            .padding(.vertical, Theme.Spacing.xxs)
        }
    }

    // MARK: - 서브시스템 한 섹션

    private func subsystemSection(_ sub: DiagnosticSubsystem) -> some View {
        Section {
            // 제목 행 — 서브시스템 아이콘 + 이름 + 상태 배지.
            HStack(spacing: Theme.Spacing.m) {
                Image(systemName: sub.symbol)
                    .font(.title3)
                    .foregroundStyle(.secondary)
                    .frame(width: 28)
                    .accessibilityHidden(true)
                Text(verbatim: sub.displayName)
                    .font(.subheadline.weight(.semibold))
                Spacer()
                statusBadge(sub.levelEnum)
            }

            // 정상이 아니면 «왜 + 무엇을 하라».
            if let title = sub.codeEnum.localizedTitle, sub.codeEnum != .ok {
                adviceRow(level: sub.levelEnum, title: title, action: sub.codeEnum.localizedAction)
            }

            // 지표.
            let rows = metricRows(id: sub.id, metrics: sub.metrics)
            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                infoRow(label: row.label, value: row.value)
            }

            // 항목(에이전트 CLI 등).
            if let items = sub.items {
                ForEach(items) { item in
                    itemRow(item)
                }
            }
        }
    }

    // MARK: - 행 빌더

    private func statusBadge(_ level: DiagnosticLevel) -> some View {
        HStack(spacing: Theme.Spacing.xs) {
            Image(systemName: level.icon)
            Text(verbatim: level.localizedLabel)
        }
        .font(.caption.weight(.semibold))
        .foregroundStyle(level.tint)
        .padding(.horizontal, Theme.Spacing.m)
        .padding(.vertical, Theme.Spacing.xs)
        .background(level.tint.opacity(Theme.Opacity.badge))
        .clipShape(Capsule())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: level.localizedLabel))
    }

    private func adviceRow(level: DiagnosticLevel, title: String, action: String?) -> some View {
        HStack(alignment: .top, spacing: Theme.Spacing.m) {
            Image(systemName: level.icon)
                .foregroundStyle(level.tint)
                .frame(width: 28)
                .accessibilityLabel(Text(verbatim: level.localizedLabel))
            VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
                Text(verbatim: title)
                    .font(.subheadline.weight(.semibold))
                if let action {
                    Text(verbatim: action)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(.vertical, Theme.Spacing.xxs)
    }

    private func itemRow(_ item: DiagnosticItem) -> some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
            HStack(spacing: Theme.Spacing.s) {
                Image(systemName: item.levelEnum.icon)
                    .foregroundStyle(item.levelEnum.tint)
                    .accessibilityLabel(Text(verbatim: item.levelEnum.localizedLabel))
                Text(verbatim: item.label)
                    .font(.subheadline)
                Spacer()
                Text(verbatim: item.levelEnum.localizedLabel)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(item.levelEnum.tint)
            }
            if item.codeEnum != .ok, let title = item.codeEnum.localizedTitle {
                Text(verbatim: title)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            // 설치 명령(installHint) — 코드성 문자열, 번역 대상 아님. monospace + 복사 가능.
            if let detail = item.detail, !detail.isEmpty {
                Text(verbatim: detail)
                    .font(.caption2.monospaced())
                    .textSelection(.enabled)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.vertical, Theme.Spacing.xxs)
    }

    private func infoRow(label: String, value: String) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(verbatim: label)
                .font(.callout)
                .foregroundStyle(.secondary)
            Spacer()
            Text(verbatim: value)
                .font(.callout.monospacedDigit())
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.trailing)
        }
    }

    // MARK: - 빈/오류 상태 (IconSize placeholder 아이콘)

    private func errorPlaceholder(_ message: String) -> some View {
        placeholder(
            icon: "stethoscope",
            iconSize: Theme.IconSize.xl,
            tint: Theme.danger,
            title: String(localized: "진단을 불러오지 못했어요"),
            message: String(localized: "Mac 앱이 실행 중인지 확인하고 다시 시도하세요."),
            detail: message,
            showRetry: true)
    }

    private var emptyPlaceholder: some View {
        placeholder(
            icon: "waveform.path.ecg",
            iconSize: Theme.IconSize.l,
            tint: .secondary,
            title: String(localized: "표시할 진단 정보가 없어요"),
            message: String(localized: "아래로 당기면 다시 불러와요."),
            detail: nil,
            showRetry: true)
    }

    private func placeholder(
        icon: String,
        iconSize: CGFloat,
        tint: Color,
        title: String,
        message: String,
        detail: String?,
        showRetry: Bool,
    ) -> some View {
        Section {
            VStack(spacing: Theme.Spacing.l) {
                Image(systemName: icon)
                    .font(.system(size: iconSize))
                    .foregroundStyle(tint)
                    .accessibilityHidden(true)
                Text(verbatim: title)
                    .font(.headline)
                    .multilineTextAlignment(.center)
                Text(verbatim: message)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                if let detail, !detail.isEmpty {
                    Text(verbatim: detail)
                        .font(.caption)
                        .foregroundStyle(Theme.danger)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if showRetry {
                    Button("다시 시도") { Task { await load() } }
                        .buttonStyle(.bordered)
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, Theme.Spacing.xxxl)
            .listRowBackground(Color.clear)
        }
    }

    // MARK: - 지표 포맷

    /// 서브시스템 id 별로 표시할 지표 행 — 라벨(localize)·값(포맷된 문자열)의 배열.
    private func metricRows(id: String, metrics: DiagnosticMetrics?) -> [(label: String, value: String)] {
        guard let m = metrics else { return [] }
        var rows: [(label: String, value: String)] = []
        switch id {
        case "tor":
            if let pct = m.torBootstrapPercent {
                rows.append((String(localized: "부트스트랩"), "\(pct)%"))
            }
            if let published = m.onionPublished {
                rows.append((
                    String(localized: "onion 주소 게시"),
                    published ? String(localized: "게시됨") : String(localized: "미게시")))
            }
        case "sshd":
            if let listening = m.sshListening {
                rows.append((
                    String(localized: "수신 대기"),
                    listening ? String(localized: "수신 중") : String(localized: "중단됨")))
            }
            if let port = m.sshPort {
                rows.append((String(localized: "포트"), "\(port)"))
            }
        case "reachability":
            if let lanOnly = m.lanOnly {
                rows.append((
                    String(localized: "같은 Wi‑Fi 전용"),
                    lanOnly ? String(localized: "켜짐") : String(localized: "꺼짐")))
            }
            if let count = m.lanCandidateCount {
                rows.append((String(localized: "LAN 주소 후보"), "\(count)"))
            }
        case "disk":
            if let free = m.diskFreeBytes {
                rows.append((String(localized: "여유 공간"), Self.formatBytes(free)))
            }
            if let total = m.diskTotalBytes {
                rows.append((String(localized: "전체 공간"), Self.formatBytes(total)))
            }
        case "logs":
            if let bytes = m.unifiedLogBytes {
                rows.append((String(localized: "로그 파일 크기"), Self.formatBytes(bytes)))
            }
            if let count = m.ptyChunkCount {
                rows.append((String(localized: "터미널 출력 기록"), Self.formatCount(count)))
            }
        case "network":
            if let present = m.externalIPv4Present {
                rows.append((
                    String(localized: "공인 IP"),
                    present ? String(localized: "확인됨") : String(localized: "확인 안 됨")))
            }
            rows.append((
                String(localized: "마지막 IP 변경"),
                m.lastIpChangeAt.map(Self.formatTime) ?? String(localized: "기록 없음")))
            rows.append((
                String(localized: "마지막 재연결"),
                m.lastReconnectAt.map(Self.formatTime) ?? String(localized: "기록 없음")))
        default:
            break
        }
        return rows
    }

    // MARK: - 데이터 로드

    @MainActor
    private func load() async {
        loading = true
        defer { loading = false }
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        do {
            response = try await api.getConnectionDiagnostics()
            loadError = nil
        } catch {
            // 화면 이탈/취소는 오류로 띄우지 않는다 (의도된 중단).
            if ApiError.isCancellation(error) { return }
            loadError = (error as? LocalizedError)?.errorDescription ?? "\(error)"
        }
    }

    // MARK: - 포맷 헬퍼

    /// epoch ms → 사용자 로케일 medium 날짜 + short 시각.
    private static func formatTime(_ ms: Int64) -> String {
        let date = Date(timeIntervalSince1970: Double(ms) / 1000.0)
        let f = DateFormatter()
        f.dateStyle = .medium
        f.timeStyle = .short
        return f.string(from: date)
    }

    private static func formatBytes(_ bytes: Int64) -> String {
        ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file)
    }

    private static func formatCount(_ n: Int) -> String {
        let f = NumberFormatter()
        f.numberStyle = .decimal
        return f.string(from: NSNumber(value: n)) ?? "\(n)"
    }
}

#if DEBUG
extension DiagnosticsResponse {
    /// 시뮬레이터 «레이아웃 눈검증»(PS_DEV_DIAGNOSTICS) 용 대표 샘플 — 초록(정상)/노랑(주의)/
    /// 빨강(오류) 상태가 한 화면에 모두 나오게 구성: tor·sshd 정상, 외부 연결성 lan_blocked(오류),
    /// 에이전트 CLI 일부 미설치(주의·installHint), 디스크 부족(주의), 로그·네트워크 정상.
    static var sampleForPreview: DiagnosticsResponse {
        DiagnosticsResponse(
            v: 1,
            generatedAt: 1_750_000_000_000,
            overall: "error",
            subsystems: [
                DiagnosticSubsystem(
                    id: "tor", level: "ok", code: "ok",
                    metrics: DiagnosticMetrics(torProcessAlive: true, torBootstrapPercent: 100, onionPublished: true),
                    items: nil),
                DiagnosticSubsystem(
                    id: "sshd", level: "ok", code: "ok",
                    metrics: DiagnosticMetrics(sshListening: true, sshPort: 22022),
                    items: nil),
                DiagnosticSubsystem(
                    id: "reachability", level: "error", code: "lan_blocked_no_public_fallback",
                    metrics: DiagnosticMetrics(lanOnly: true, lanCandidateCount: 0),
                    items: nil),
                DiagnosticSubsystem(
                    id: "agent_cli", level: "warning", code: "agent_cli_missing",
                    metrics: nil,
                    items: [
                        DiagnosticItem(id: "claude_code", label: "Claude Code", level: "ok", code: "ok", detail: nil),
                        DiagnosticItem(id: "codex", label: "Codex", level: "warning", code: "agent_cli_missing", detail: "npm install -g @openai/codex"),
                    ]),
                DiagnosticSubsystem(
                    id: "disk", level: "warning", code: "disk_low",
                    metrics: DiagnosticMetrics(diskFreeBytes: 3_221_225_472, diskTotalBytes: 494_384_795_648),
                    items: nil),
                DiagnosticSubsystem(
                    id: "logs", level: "ok", code: "ok",
                    metrics: DiagnosticMetrics(unifiedLogBytes: 2_300_000, ptyChunkCount: 1240),
                    items: nil),
                DiagnosticSubsystem(
                    id: "network", level: "ok", code: "ok",
                    metrics: DiagnosticMetrics(externalIPv4Present: true, ipFetchedAt: 1_749_990_000_000, lastIpChangeAt: 1_749_900_000_000, lastReconnectAt: 1_749_950_000_000),
                    items: nil),
            ])
    }
}
#endif
