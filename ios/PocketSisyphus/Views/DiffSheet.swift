import SwiftUI

/// 커밋되지 않은 변경 파일 viewer.
///
/// 상단의 「변경 N」 칩이 토글한다. 두 단계 화면:
///   1. 파일 리스트 (상태 뱃지 + 경로 + +/- 카운트)
///   2. 한 파일 선택 시 push 되는 unified diff 상세 — 줄 prefix 로 색칠.
///
/// 의존성은 클로저로 받는다 — ChatViewModel 을 직접 import 하지 않아 단위 시도/프리뷰가
/// 가벼워진다. files 는 ChatView 가 ChatVM 의 폴링 응답을 그대로 넘긴다.
struct DiffSheet: View {
    let files: [GitStatusFile]
    let loadDiff: (String) async -> GitFileDiffResponse?
    /// binary 파일이 이미지일 때 worktree 본문을 가져온다 (변경 후).
    let loadFile: (String) async -> FileContent?
    /// binary 파일이 이미지일 때 HEAD 본문을 가져온다 (변경 전). 신규 파일이면 nil.
    let loadGitBlob: (String, String) async -> FileContent?
    let onRefresh: () async -> Void
    /// «리뷰 요약 요청» — 에이전트 세션에 구조화 리뷰 프롬프트를 보낸다 (ChatView 가 전송 담당).
    /// 폰에서 수백 줄 raw diff 를 직접 읽는 대신, 에이전트가 읽고 사람은 요약·위험만 확인하는
    /// 검증 경로. 탭 시 시트는 닫혀 터미널의 리뷰 응답이 바로 보인다.
    let onRequestReview: () -> Void

    @Environment(\.dismiss) private var dismiss

    /// 리뷰 우선순위 정렬 — 사람이 위에서부터 읽다 마는 걸 전제로, 놓치면 위험한 것부터:
    /// 삭제(D)가 맨 위, 그 다음 변경량(+/- 합) 큰 순. binary(0/0)는 자연히 아래로 가라앉는다.
    private var sortedFiles: [GitStatusFile] {
        files.sorted { a, b in
            let aDel = a.primaryStatus == "D", bDel = b.primaryStatus == "D"
            if aDel != bDel { return aDel }
            return (a.additions + a.deletions) > (b.additions + b.deletions)
        }
    }

    var body: some View {
        NavigationStack {
            Group {
                if files.isEmpty {
                    EmptyStateView(
                        title: "변경 사항 없음",
                        systemImage: "checkmark.circle",
                        message: "커밋되지 않은 파일이 없다.",
                    )
                } else {
                    List(sortedFiles) { file in
                        NavigationLink {
                            DiffDetailView(
                                file: file,
                                loadDiff: loadDiff,
                                loadFile: loadFile,
                                loadGitBlob: loadGitBlob,
                            )
                        } label: {
                            DiffFileRow(file: file)
                        }
                    }
                    .listStyle(.plain)
                    .refreshable { await onRefresh() }
                }
            }
            .navigationTitle("변경 사항")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if !files.isEmpty {
                    ToolbarItem(placement: .topBarLeading) {
                        Button {
                            onRequestReview()
                            dismiss()
                        } label: {
                            Label("리뷰 요약", systemImage: "text.magnifyingglass")
                        }
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("닫기") { dismiss() }
                }
            }
            // 시트 열릴 때 한 번 더 fetch — ChatVM 의 5s 사이클 사이에 사용자가 외부 편집을
            // 했을 수 있고, "내가 칩을 눌렀다 = 지금 최신 상태가 보고 싶다" 는 강한 신호.
            .task { await onRefresh() }
        }
    }
}

/// 한 파일의 unified diff 본문. 진입 시 lazy load.
///
/// binary 가 이미지면 ImageDiffView 로 분기 — HEAD 의 이미지와 worktree 의 이미지를 위/아래로 비교.
/// binary 가 이미지가 아니면 기존처럼 «미리 보기 미지원» 안내.
private struct DiffDetailView: View {
    let file: GitStatusFile
    let loadDiff: (String) async -> GitFileDiffResponse?
    let loadFile: (String) async -> FileContent?
    let loadGitBlob: (String, String) async -> FileContent?

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
                    if isImagePath(file.path) {
                        ImageDiffView(
                            path: file.path,
                            isUntracked: resp.untracked || file.primaryStatus == "?",
                            isDeleted: file.primaryStatus == "D",
                            loadFile: loadFile,
                            loadGitBlob: loadGitBlob,
                        )
                    } else {
                        EmptyStateView(
                            title: "바이너리 파일",
                            systemImage: "doc.zipper",
                            message: "미리 보기를 지원하지 않는다.",
                        )
                    }
                } else if resp.diff.isEmpty {
                    EmptyStateView(
                        title: "변경 내용 없음",
                        systemImage: "doc",
                        message: "표시할 diff 본문이 비어 있다.",
                    )
                } else {
                    DiffBody(diff: resp.diff, truncated: resp.truncated, untracked: resp.untracked, path: file.path)
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
        .navigationTitle(file.path)
        .navigationBarTitleDisplayMode(.inline)
        .task {
            // 같은 file 로 재진입 시에도 한 번 새로 가져온다 — 사용자가 직전에 코드 편집을 했을 수 있음.
            isLoading = true
            didFail = false
            response = await loadDiff(file.path)
            if response == nil { didFail = true }
            isLoading = false
        }
    }
}

/// path 확장자가 모바일 이미지 viewer 가 다룰 수 있는 포맷인지.
/// daemon 의 fs/file / git/blob 응답이 image/* contentType 을 붙이는 확장자와 동일 목록.
/// SVG 는 WKWebView 로 렌더 (`FileViewer.SVGContentView`).
private func isImagePath(_ path: String) -> Bool {
    let ext = path.lowercased().split(separator: ".").last.map(String.init) ?? ""
    return ["png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "bmp", "tiff", "tif", "svg"].contains(ext)
}

/// 이미지 변경 전/후 비교 viewer.
///   - 신규(untracked) 파일: 이전 슬롯에 «새 파일» 안내, 이후 슬롯에 worktree 이미지.
///   - 삭제: 이전 슬롯에 HEAD 이미지, 이후 슬롯에 «삭제됨» 안내.
///   - 그 외(수정): 둘 다 표시.
///
/// 두 이미지를 위/아래로 배치 — 모바일 좁은 폭에서 좌우는 너무 작아서.
private struct ImageDiffView: View {
    let path: String
    let isUntracked: Bool
    let isDeleted: Bool
    let loadFile: (String) async -> FileContent?
    let loadGitBlob: (String, String) async -> FileContent?

    @State private var before: FileContent?  // HEAD
    @State private var after: FileContent?   // worktree
    @State private var isLoading = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                ImagePane(
                    title: "변경 전 (HEAD)",
                    tint: Theme.danger,
                    content: before,
                    placeholder: isUntracked ? "이 파일은 새로 추가됐다 — 이전 버전 없음." : nil,
                    isLoading: isLoading && before == nil && !isUntracked,
                )
                ImagePane(
                    title: "변경 후 (Worktree)",
                    tint: Theme.success,
                    content: after,
                    placeholder: isDeleted ? "이 파일은 삭제됐다 — 현재 본문 없음." : nil,
                    isLoading: isLoading && after == nil && !isDeleted,
                )
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 12)
        }
        .background(Color(.systemGroupedBackground))
        .task {
            isLoading = true
            // 두 본문을 병렬로 받음 — Tor RTT 가 두 번 직렬로 도는 걸 피한다.
            async let blob = loadGitBlob(path, "HEAD")
            async let file = loadFile(path)
            let (b, f) = await (blob, file)
            before = b
            after = f
            isLoading = false
        }
    }
}

/// 한 슬롯 — 라벨 + 이미지 또는 placeholder.
private struct ImagePane: View {
    let title: String
    let tint: Color
    let content: FileContent?
    let placeholder: String?
    let isLoading: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Circle().fill(tint).frame(width: 6, height: 6)
                Text(title)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
            ZStack {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(Color(.secondarySystemGroupedBackground))
                if let placeholder {
                    Text(placeholder)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .padding(24)
                } else if isLoading {
                    ProgressView().controlSize(.regular)
                        .padding(24)
                } else if let svg = decodedSVG(from: content) {
                    // SVG — WKWebView 로 렌더. compact pane 이라 zoom 비활성 (위·아래 두 pane
                    // 비교가 목적이라 안에서 zoom 하면 비교 흐름이 깨진다). 사용자는 file browser
                    // 에서 풀스크린으로 열면 핀치 줌 가능.
                    SVGContentView(svgData: svg, zoomable: false)
                        .padding(8)
                } else if let img = decodedRasterImage(from: content) {
                    Image(uiImage: img)
                        .resizable()
                        .scaledToFit()
                        .padding(8)
                } else if content != nil {
                    Text("이미지 디코드 실패")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .padding(24)
                } else {
                    Text("불러오는 중…")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .padding(24)
                }
            }
            .frame(maxWidth: .infinity)
            .frame(minHeight: 160)
        }
    }

    /// SVG 본문이면 raw bytes 를 돌려준다. daemon 은 base64 로 보내지만 utf8 fallback 도 흡수.
    private func decodedSVG(from content: FileContent?) -> Data? {
        guard let content, content.contentType == "image/svg+xml" else { return nil }
        switch content.encoding {
        case "base64": return Data(base64Encoded: content.content)
        case "utf8":   return content.content.data(using: .utf8)
        default:       return nil
        }
    }

    /// 비트맵 (PNG/JPEG/GIF/HEIC/WebP 등). SVG 는 decodedSVG 가 먼저 잡아낸다.
    private func decodedRasterImage(from content: FileContent?) -> UIImage? {
        guard let content,
              content.contentType != "image/svg+xml",
              content.encoding == "base64",
              let data = Data(base64Encoded: content.content)
        else { return nil }
        return UIImage(data: data)
    }
}
