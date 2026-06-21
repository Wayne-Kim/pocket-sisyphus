import SwiftUI

/// repo(작업 폴더) 경로 입력 — 최근 프로젝트 + 파일시스템 하위 폴더(daemon /api/fs/list-dir)를
/// 칩으로 추천하는 자족 컴포넌트. 손으로 다 타이핑하지 않고 칩을 탭해 한 단계씩 내려간다.
///
/// 공용: 새 세션 / 예약 작업(CronEditorSheet) / 워크플로우 생성 등 «repo 경로를 받는» 모든 곳에서
/// 재사용한다. (이전엔 CronEditorSheet 안의 private 구현이었다 — 워크플로우 생성에서도 쓰려고
/// 파일로 분리.) Form 의 Section 안에 그대로 넣어 쓰면 된다 (TextField + 칩 ScrollView 두 줄).
struct RepoPathField: View {
    let auth: AuthStore
    let conn: ConnectionManager
    let inflight: InFlightTracker
    @Binding var repoPath: String

    @State private var recents: [RecentProject] = []
    @State private var fsDirs: [String] = []
    @State private var fsDirsPrefix = ""
    @State private var showDirPicker = false

    var body: some View {
        Group {
            // .sheet 를 Group 에 붙이면 if !pathSuggestions.isEmpty 조건이 바뀔 때
            // (loadRecents 완료 → recents 채워짐) Group 구조가 변해 SwiftUI 가 sheet 앵커를
            // 재평가하며 showDirPicker 를 false 로 리셋 → 시트가 즉시 닫히는 타이밍 버그.
            // 조건부 콘텐츠가 없는 TextField 에 sheet 를 고정해 앵커를 안정적으로 유지한다.
            TextField("/Users/you/projects/repo", text: $repoPath)
                .font(.body.monospaced())
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .onAppear { Task { await loadRecents() } }
                .onChange(of: repoPath) { _ in
                    Task { await loadFsDirs(forPrefix: splitPathPrefix().prefix) }
                }
                .sheet(isPresented: $showDirPicker) {
                    DirectoryPickerSheet(title: "작업 폴더 선택") { path in
                        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
                        return try? await api.listDirBase(path)
                    } onPick: { picked in
                        repoPath = picked
                    }
                }

            Button {
                showDirPicker = true
            } label: {
                Label("폴더 탐색해서 선택", systemImage: "folder")
                    .font(.callout)
            }

            if !pathSuggestions.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        Button {
                            popPathSegment()
                        } label: {
                            Image(systemName: "arrow.up.left")
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                        .accessibilityLabel(Text("상위 경로"))

                        ForEach(pathSuggestions, id: \.self) { seg in
                            Button {
                                appendPathSegment(seg)
                            } label: {
                                Text(seg).lineLimit(1)
                            }
                            .buttonStyle(.bordered)
                            .controlSize(.small)
                        }
                    }
                }
            }
        }
    }

    // MARK: 자동완성 로직 (NewSessionSheet 와 동일)

    private func splitPathPrefix() -> (prefix: String, token: String) {
        let s = repoPath
        if let lastSlash = s.lastIndex(of: "/") {
            return (String(s[...lastSlash]), String(s[s.index(after: lastSlash)...]))
        }
        return ("", s)
    }

    private var pathSuggestions: [String] {
        let (prefix, token) = splitPathPrefix()
        let tokenLower = token.lowercased()
        var next: Set<String> = []
        for p in recents.map(\.path) {
            guard p.hasPrefix(prefix) else { continue }
            let rest = p.dropFirst(prefix.count)
            if rest.isEmpty { continue }
            let seg = rest.firstIndex(of: "/").map { String(rest[..<$0]) } ?? String(rest)
            if seg.isEmpty { continue }
            if !tokenLower.isEmpty && !seg.lowercased().hasPrefix(tokenLower) { continue }
            next.insert(seg)
        }
        if prefix == fsDirsPrefix {
            for seg in fsDirs {
                if !tokenLower.isEmpty && !seg.lowercased().hasPrefix(tokenLower) { continue }
                next.insert(seg)
            }
        }
        return next.sorted()
    }

    private func appendPathSegment(_ seg: String) {
        let (prefix, _) = splitPathPrefix()
        let newPath = prefix + seg
        let isDir = recents.contains { $0.path.hasPrefix(newPath + "/") }
            || (prefix == fsDirsPrefix && fsDirs.contains(seg))
        repoPath = isDir ? (newPath + "/") : newPath
    }

    private func popPathSegment() {
        var p = repoPath
        if p.hasSuffix("/") { p.removeLast() }
        if let lastSlash = p.lastIndex(of: "/") {
            p = String(p[...lastSlash])
        } else {
            p = ""
        }
        repoPath = p
    }

    @MainActor
    private func loadRecents() async {
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        recents = (try? await api.recentProjects(label: nil)) ?? []
    }

    @MainActor
    private func loadFsDirs(forPrefix prefix: String) async {
        if prefix == fsDirsPrefix { return }
        guard prefix.hasPrefix("/") || prefix.hasPrefix("~") else {
            fsDirs = []
            fsDirsPrefix = prefix
            return
        }
        let api = ApiClient(auth: auth, conn: conn, tracker: inflight)
        let dirs = (try? await api.listDir(prefix, label: nil)) ?? []
        guard splitPathPrefix().prefix == prefix else { return }
        fsDirs = dirs
        fsDirsPrefix = prefix
    }
}
