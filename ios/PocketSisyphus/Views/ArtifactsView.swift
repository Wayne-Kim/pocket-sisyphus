import SwiftUI
import QuickLook

// MARK: - daemon /api/sessions/:id/artifacts 응답 (sessions.ts 와 1:1)

/// 발견된 산출물 한 개. daemon 이 repo 를 walk 해 mtime 내림차순으로 반환.
struct ArtifactItem: Decodable, Identifiable, Equatable {
    let path: String       // repo 상대 경로 (다운로드 키)
    let name: String       // 파일명 (확장자 포함 — QuickLook 타입 판별)
    let ext: String
    let kind: String       // image / pdf / video / audio / model / markdown / doc / web
    let size: Int
    let modifiedAt: Double  // epoch ms
    var id: String { path }
}

struct ArtifactsResult: Decodable {
    let artifacts: [ArtifactItem]
    let total: Int
    let truncated: Bool
    /// 현재 스코프 폴더(repo 상대, 빈 문자열 = 루트). 옛 daemon 은 안 보냄 → nil.
    let dir: String?
    /// 현재 폴더 «바로 아래» 자식 폴더 중 산출물을 가진 것 — 드릴다운용. 옛 daemon 은 nil.
    let subdirs: [String]?
}

/// QuickLook 시트에 넘길 Identifiable URL 래퍼.
private struct PreviewURL: Identifiable {
    let id = UUID()
    let url: URL
}

// MARK: - 산출물 본문 (ResultsView 의 «산출물» 세그먼트)

/// 세션이 만든 시각적 산출물을 그리드로 보여주고, 탭하면 raw 를 받아 QuickLook 으로 렌더한다.
/// QuickLook 은 이미지·PDF·동영상·오디오·Office·USDZ(3D) 를 네이티브로 처리한다.
struct ArtifactsBody: View {
    let sessionId: String
    let api: ApiClient

    enum LoadState: Equatable {
        case loading
        case loaded([ArtifactItem])
        case empty
        case failed(String)
    }

    @State private var state: LoadState = .loading
    @State private var preview: PreviewURL?
    /// 다운로드 중인 산출물 path — 카드에 스피너 표시.
    @State private var downloading: String?
    @State private var truncated = false
    /// 현재 보고 있는 폴더(repo 상대, 빈 문자열 = 루트). 세션별로 마지막 선택을 기억.
    @State private var currentDir = ""
    /// 현재 폴더에서 드릴다운 가능한 자식 폴더들.
    @State private var subdirs: [String] = []

    private let columns = [GridItem(.adaptive(minimum: 104), spacing: Theme.Spacing.m)]

    var body: some View {
        VStack(spacing: 0) {
            // 폴더 탐색 바 — 루트가 아니거나 드릴다운할 자식 폴더가 있을 때만.
            if !currentDir.isEmpty || !subdirs.isEmpty {
                folderBar
                Divider()
            }
            content
        }
        .task {
            currentDir = Self.savedDir(sessionId)
            await load()
        }
        .sheet(item: $preview) { p in
            QuickLookPreview(url: p.url)
                .ignoresSafeArea()
        }
    }

    @ViewBuilder
    private var content: some View {
        switch state {
        case .loading:
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        case .empty:
            emptyState
        case .failed(let msg):
            failedState(msg)
        case .loaded(let items):
            ScrollView {
                if truncated {
                    Text("최근 산출물만 표시 중")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, Theme.Spacing.l)
                        .padding(.top, Theme.Spacing.m)
                }
                LazyVGrid(columns: columns, spacing: Theme.Spacing.m) {
                    ForEach(items) { item in
                        Button { open(item) } label: {
                            ArtifactCard(item: item, isDownloading: downloading == item.path)
                        }
                        .buttonStyle(.plain)
                        .disabled(downloading != nil)
                    }
                }
                .padding(Theme.Spacing.l)
            }
            .refreshable { await load() }
        }
    }

    // MARK: - 폴더 탐색 (브레드크럼 + 드릴다운)

    /// 상단 폴더 바 — 브레드크럼(전체 › a › b, 탭하면 상위로)과 자식 폴더 칩(탭하면 하위로).
    private var folderBar: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.s) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 4) {
                    breadcrumbButton(label: Text("전체"), dir: "")
                    ForEach(Array(dirComponents.enumerated()), id: \.offset) { idx, comp in
                        Image(systemName: "chevron.right")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                        breadcrumbButton(
                            label: Text(verbatim: comp),
                            dir: dirComponents[0...idx].joined(separator: "/"),
                        )
                    }
                }
                .padding(.horizontal, Theme.Spacing.l)
            }
            if !subdirs.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: Theme.Spacing.s) {
                        ForEach(subdirs, id: \.self) { sub in
                            Button {
                                navigate(to: currentDir.isEmpty ? sub : "\(currentDir)/\(sub)")
                            } label: {
                                Label {
                                    Text(verbatim: sub)
                                } icon: {
                                    Image(systemName: "folder")
                                }
                                .font(.caption)
                                .lineLimit(1)
                            }
                            .buttonStyle(.bordered)
                        }
                    }
                    .padding(.horizontal, Theme.Spacing.l)
                }
            }
        }
        .padding(.vertical, Theme.Spacing.s)
    }

    private var dirComponents: [String] {
        currentDir.isEmpty ? [] : currentDir.split(separator: "/").map(String.init)
    }

    private func breadcrumbButton(label: Text, dir: String) -> some View {
        Button { navigate(to: dir) } label: {
            label
                .font(.caption.weight(dir == currentDir ? .semibold : .regular))
                .foregroundStyle(dir == currentDir ? Color.primary : Theme.accent)
                .lineLimit(1)
        }
        .buttonStyle(.plain)
        .disabled(dir == currentDir)
    }

    private func navigate(to dir: String) {
        guard dir != currentDir else { return }
        currentDir = dir
        Task { await load() }
    }

    private var emptyState: some View {
        VStack(spacing: Theme.Spacing.l) {
            Image(systemName: "photo.on.rectangle.angled")
                .font(.largeTitle)
                .foregroundStyle(.secondary)
            Text("아직 산출물이 없어요")
                .font(.headline)
            Text("세션이 이미지·PDF·문서 같은 파일을 만들면 여기에 모여요.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding(Theme.Spacing.xl)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func failedState(_ msg: String) -> some View {
        VStack(spacing: Theme.Spacing.l) {
            Image(systemName: "exclamationmark.triangle")
                .font(.largeTitle)
                .foregroundStyle(Theme.warning)
            Text("산출물을 불러올 수 없어요")
                .font(.headline)
            Text(msg)
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Button("다시 시도") { Task { await load() } }
                .buttonStyle(.borderedProminent)
        }
        .padding(Theme.Spacing.xl)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    @MainActor
    private func load() async {
        state = .loading
        do {
            let result = try await api.listArtifacts(sessionId, limit: 100, dir: currentDir)
            truncated = result.truncated
            subdirs = result.subdirs ?? []
            // daemon 이 정규화한 dir 를 신뢰(사라진 폴더는 빈 문자열로 떨어질 수 있음).
            if let d = result.dir { currentDir = d }
            saveDir(currentDir)
            state = result.artifacts.isEmpty ? .empty : .loaded(result.artifacts)
        } catch {
            state = .failed(String(localized: "목록 조회 실패: \(error.localizedDescription)"))
        }
    }

    // MARK: - 세션별 마지막 폴더 기억

    private static func savedDir(_ sessionId: String) -> String {
        UserDefaults.standard.string(forKey: "artifactsDir.\(sessionId)") ?? ""
    }

    private func saveDir(_ dir: String) {
        UserDefaults.standard.set(dir, forKey: "artifactsDir.\(sessionId)")
    }

    private func open(_ item: ArtifactItem) {
        guard downloading == nil else { return }
        downloading = item.path
        Task { @MainActor in
            defer { downloading = nil }
            do {
                let url = try await api.downloadArtifact(sessionId, path: item.path, fileName: item.name)
                preview = PreviewURL(url: url)
            } catch {
                state = .failed(String(localized: "산출물 다운로드 실패: \(error.localizedDescription)"))
            }
        }
    }
}

// MARK: - 산출물 카드

private struct ArtifactCard: View {
    let item: ArtifactItem
    let isDownloading: Bool

    var body: some View {
        VStack(spacing: Theme.Spacing.xs) {
            ZStack {
                RoundedRectangle(cornerRadius: Theme.Radius.m)
                    .fill(Color(.secondarySystemBackground))
                    .frame(height: 88)
                if isDownloading {
                    ProgressView()
                } else {
                    Image(systemName: icon)
                        .font(.system(size: 30))
                        .foregroundStyle(Theme.pro)
                }
            }
            Text(item.name)
                .font(.caption2)
                .lineLimit(1)
                .truncationMode(.middle)
                .frame(maxWidth: .infinity, alignment: .leading)
            Text(sizeLabel)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    /// 종류별 SF Symbol — 썸네일 미리 로드(N 다운로드) 대신 가벼운 아이콘. 실제 렌더는 탭 시 QuickLook.
    private var icon: String {
        switch item.kind {
        case "image": return "photo"
        case "pdf": return "doc.richtext"
        case "video": return "play.rectangle"
        case "audio": return "waveform"
        case "model": return "cube"
        case "markdown": return "doc.text"
        case "doc": return "doc"
        case "web": return "safari"
        default: return "doc"
        }
    }

    private var sizeLabel: String {
        ByteCountFormatter.string(fromByteCount: Int64(item.size), countStyle: .file)
    }
}

// MARK: - QuickLook 래퍼

/// QLPreviewController — 이미지·PDF·Office·USDZ·동영상·오디오를 네이티브 렌더 (확장자로 타입 판별).
private struct QuickLookPreview: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> QLPreviewController {
        let controller = QLPreviewController()
        controller.dataSource = context.coordinator
        return controller
    }

    func updateUIViewController(_ controller: QLPreviewController, context: Context) {
        context.coordinator.url = url
        controller.reloadData()
    }

    func makeCoordinator() -> Coordinator { Coordinator(url: url) }

    final class Coordinator: NSObject, QLPreviewControllerDataSource {
        var url: URL
        init(url: URL) { self.url = url }
        func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }
        func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem {
            url as NSURL
        }
    }
}
