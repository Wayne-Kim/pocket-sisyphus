import SwiftUI
import UIKit

/// 세션 repo 안의 파일·디렉토리 탐색 시트.
///
/// 진입점: ChatView statusBar 의 «folder» 아이콘. 시작 path 는 빈 문자열(repo root).
///
/// 두 단계 화면 (NavigationStack):
///   1. DirectoryView — 현재 디렉토리 listing. 폴더 탭 → 자식 디렉토리 push. 파일 탭 → FileViewerView push.
///   2. FileViewerView — 응답의 encoding/contentType 에 따라 Text / Image / 미지원 분기.
///
/// 의존성은 클로저로 끊는다 (DiffSheet 패턴). ChatViewModel 직접 import 안 하므로 단위 시도 가벼움.
struct FileBrowserSheet: View {
    let rootTitle: String
    let loadDirectory: (String) async -> DirectoryListing?
    let loadFile: (String) async -> FileContent?
    let loadGitBlob: (String, String) async -> FileContent?
    /// 전송 대기 «파일 참조» 목록 — 행 스와이프 «첨언» / 뷰어 라인 선택이 여기에 쌓인다.
    /// ChatView 가 소유하고, 시트를 닫은 뒤 statusBar 칩 → FileReferenceSheet 로 첨언/전송.
    @Binding var fileRefs: [FileReferenceDraft]

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            DirectoryView(
                path: "",
                rootTitle: rootTitle,
                loadDirectory: loadDirectory,
                loadFile: loadFile,
                loadGitBlob: loadGitBlob,
                fileRefs: $fileRefs,
            )
            .toolbar {
                // 첨언이 쌓여 있으면 개수 표시 — 탭하면 닫고 ChatView 의 칩 → 편집 시트로.
                ToolbarItem(placement: .topBarLeading) {
                    if !fileRefs.isEmpty {
                        Button { dismiss() } label: {
                            Label { Text(verbatim: "\(fileRefs.count)") } icon: {
                                Image(systemName: "text.badge.plus")
                            }
                            .foregroundStyle(Theme.pro)  // 파일참조 도구 그룹 — 주황(채팅 칩과 통일)
                        }
                        .accessibilityLabel("파일 참조")
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("닫기") { dismiss() }
                }
            }
        }
    }
}

/// 한 디렉토리의 listing — entries 정렬은 daemon 이 한 결과를 그대로 보여준다.
private struct DirectoryView: View {
    let path: String
    let rootTitle: String
    let loadDirectory: (String) async -> DirectoryListing?
    let loadFile: (String) async -> FileContent?
    let loadGitBlob: (String, String) async -> FileContent?
    @Binding var fileRefs: [FileReferenceDraft]

    @State private var listing: DirectoryListing?
    @State private var isLoading = false
    @State private var didFail = false

    var body: some View {
        Group {
            if isLoading && listing == nil {
                ProgressView().controlSize(.large)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let l = listing {
                if l.entries.isEmpty {
                    EmptyStateView(
                        title: "빈 폴더",
                        systemImage: "folder",
                        message: "이 경로에는 파일이 없다.",
                    )
                } else {
                    List(l.entries) { entry in
                        if entry.isDirectory {
                            NavigationLink {
                                DirectoryView(
                                    path: joinPath(path, entry.name),
                                    rootTitle: rootTitle,
                                    loadDirectory: loadDirectory,
                                    loadFile: loadFile,
                                    loadGitBlob: loadGitBlob,
                                    fileRefs: $fileRefs,
                                )
                            } label: {
                                EntryRow(entry: entry)
                            }
                        } else {
                            NavigationLink {
                                FileViewerView(
                                    path: joinPath(path, entry.name),
                                    loadFile: loadFile,
                                    loadGitBlob: loadGitBlob,
                                    fileRefs: $fileRefs,
                                )
                            } label: {
                                EntryRow(entry: entry)
                            }
                            // 행 스와이프 → 파일 «전체» 를 참조 목록에 첨언 대상으로 추가.
                            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                                Button {
                                    addWholeFile(joinPath(path, entry.name))
                                } label: {
                                    Label("첨언", systemImage: "text.badge.plus")
                                }
                                .tint(Theme.pro)
                            }
                        }
                    }
                    .listStyle(.plain)
                    .refreshable { await reload() }
                }
            } else if didFail {
                EmptyStateView(
                    title: "불러오기 실패",
                    systemImage: "exclamationmark.triangle",
                    message: "연결이 회복되면 다시 시도된다.",
                )
            } else {
                Color.clear
            }
        }
        .navigationTitle(path.isEmpty ? rootTitle : pathLastComponent(path))
        .navigationBarTitleDisplayMode(.inline)
        .task { await reload() }
    }

    private func reload() async {
        isLoading = true
        didFail = false
        listing = await loadDirectory(path)
        if listing == nil { didFail = true }
        isLoading = false
    }

    /// 파일 전체 참조를 목록에 추가 (이미 같은 «파일 전체» 참조가 있으면 무시).
    private func addWholeFile(_ filePath: String) {
        guard !fileRefs.contains(where: { $0.path == filePath && $0.lineRange == nil }) else { return }
        fileRefs.append(FileReferenceDraft(path: filePath, lineRange: nil))
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }
}

/// 한 entry 의 행 — 아이콘 + 이름 + (디렉토리/파일별 메타).
private struct EntryRow: View {
    let entry: DirectoryEntry

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: entry.isDirectory ? "folder.fill" : iconForFile(entry.name))
                .foregroundStyle(entry.isDirectory ? Color.accentColor : Color.secondary)
                .frame(width: 22, height: 22)
            VStack(alignment: .leading, spacing: 2) {
                Text(entry.name)
                    .font(.callout.monospaced())
                    .lineLimit(1)
                    .truncationMode(.middle)
                if !entry.isDirectory {
                    Text(formatSize(entry.size))
                        .font(.caption2.monospaced())
                        .foregroundStyle(.secondary)
                }
            }
            Spacer()
        }
        .padding(.vertical, 2)
    }
}

/// 한 파일 viewer — load 결과를 한 번만 fetch, encoding/contentType 에 따라 분기.
private struct FileViewerView: View {
    let path: String
    let loadFile: (String) async -> FileContent?
    let loadGitBlob: (String, String) async -> FileContent?
    @Binding var fileRefs: [FileReferenceDraft]

    @State private var content: FileContent?
    @State private var isLoading = false
    @State private var didFail = false

    var body: some View {
        Group {
            if isLoading && content == nil {
                ProgressView().controlSize(.large)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let c = content {
                // 통합 viewer — text / raster image / svg / unsupported 분기를 내부적으로 처리.
                // 텍스트면 라인 탭 선택 → 범위 참조 추가 콜백을 넘긴다.
                FileViewer(content: c, onAddLineRange: { range in addLineRange(range) })
            } else if didFail {
                EmptyStateView(
                    title: "불러오기 실패",
                    systemImage: "exclamationmark.triangle",
                    message: "파일이 너무 크거나 (5MB 초과) 권한이 없을 수 있다.",
                )
            } else {
                Color.clear
            }
        }
        .navigationTitle(pathLastComponent(path))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            // 파일 «전체» 를 참조에 추가 — 라인 범위가 아니라 파일 단위 첨언.
            ToolbarItem(placement: .primaryAction) {
                Button { addWholeFile() } label: {
                    Label("파일 전체 첨언", systemImage: "text.badge.plus")
                }
            }
        }
        .task {
            isLoading = true
            didFail = false
            content = await loadFile(path)
            if content == nil { didFail = true }
            isLoading = false
        }
    }

    private func addWholeFile() {
        guard !fileRefs.contains(where: { $0.path == path && $0.lineRange == nil }) else { return }
        fileRefs.append(FileReferenceDraft(path: path, lineRange: nil))
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }

    private func addLineRange(_ range: ClosedRange<Int>) {
        guard !fileRefs.contains(where: { $0.path == path && $0.lineRange == range }) else { return }
        fileRefs.append(FileReferenceDraft(path: path, lineRange: range))
    }
}

/// repo-relative path 의 마지막 segment. 루트면 "".
private func pathLastComponent(_ path: String) -> String {
    if path.isEmpty { return "" }
    if let i = path.lastIndex(of: "/") {
        return String(path[path.index(after: i)...])
    }
    return path
}

/// repo-relative 디렉토리 + 자식 이름 → 새 repo-relative path.
private func joinPath(_ parent: String, _ child: String) -> String {
    if parent.isEmpty { return child }
    return "\(parent)/\(child)"
}

/// 파일 이름의 확장자 기반 SF Symbol 추정 — 정확성보단 시각적 힌트.
private func iconForFile(_ name: String) -> String {
    let lower = name.lowercased()
    let ext = lower.split(separator: ".").last.map(String.init) ?? ""
    switch ext {
    case "png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "bmp", "tiff", "tif", "svg":
        return "photo"
    case "swift", "ts", "tsx", "js", "jsx", "py", "rb", "go", "rs", "java", "kt", "c", "cpp", "h", "hpp", "m", "mm":
        return "chevron.left.forwardslash.chevron.right"
    case "md", "markdown", "txt":
        return "doc.text"
    case "json", "yaml", "yml", "toml", "xml":
        return "doc.badge.gearshape"
    case "sh", "bash", "zsh", "fish":
        return "terminal"
    case "lock":
        return "lock.doc"
    case "pdf":
        return "doc.richtext"
    default:
        return "doc"
    }
}

/// "1.2 KB" / "345 B" / "4.5 MB" — 0 이거나 음수면 빈 문자열.
private func formatSize(_ bytes: Int64) -> String {
    if bytes <= 0 { return "0 B" }
    let units = ["B", "KB", "MB", "GB"]
    var value = Double(bytes)
    var unit = 0
    while value >= 1024 && unit < units.count - 1 {
        value /= 1024
        unit += 1
    }
    if unit == 0 {
        return "\(Int(value)) \(units[unit])"
    }
    return String(format: "%.1f %@", value, units[unit])
}

// 빈 상태는 공용 `EmptyStateView`(DesignSystem/StateViews.swift) 로 통합됐다 — 이 파일의
// 호출부(디렉터리 빈 폴더·불러오기 실패 등)는 그대로 그 공용 컴포넌트를 쓴다.
