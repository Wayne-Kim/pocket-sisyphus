import SwiftUI

/// 절대경로 파일 탐색기 — 폴더를 눌러 들어가며 «이 폴더 선택» 으로 디렉터리를 고른다.
///
/// 채팅방의 `FileBrowserSheet` 가 세션 repo «내부»(상대경로 + 파일 열람)를 탐색하는 것과 달리,
/// 이건 세션을 만들기 «전» 에 Mac 파일시스템(절대경로)에서 작업 폴더를 고르는 용도다. 그래서
/// daemon `/api/fs/list-dir` (절대경로 → 하위 디렉터리)로 트리를 따라 내려간다. 빈 경로는
/// daemon 이 홈으로 해소한다. 새 세션 / 예약 / 워크플로우 생성에서 재사용한다.
///
/// 의존성은 클로저로 끊는다(FileBrowserSheet 패턴) — loadDir 만 주입하면 단위 시도 가벼움.
struct DirectoryPickerSheet: View {
    let title: LocalizedStringKey
    /// 절대경로(빈 문자열=홈) → (해소된 base 절대경로, 하위 디렉터리 이름들). nil 이면 실패.
    let loadDir: (String) async -> (base: String, dirs: [String])?
    /// 선택된 절대경로를 돌려준다. 시트는 스스로 닫는다.
    let onPick: (String) -> Void

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            DirLevel(path: "", loadDir: loadDir) { picked in
                onPick(picked)
                dismiss()
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("취소") { dismiss() }
                }
            }
        }
    }
}

/// 한 디렉터리 레벨 — 하위 폴더 목록 + «이 폴더 선택». 폴더 탭 → 자식 레벨 push(뒤로가기=상위).
private struct DirLevel: View {
    let path: String   // 절대경로 ("" = 홈, daemon 이 해소)
    let loadDir: (String) async -> (base: String, dirs: [String])?
    let onPick: (String) -> Void

    @State private var base: String = ""
    @State private var dirs: [String] = []
    @State private var loading = false
    @State private var failed = false

    var body: some View {
        Group {
            if loading && base.isEmpty {
                ProgressView().controlSize(.large)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if failed {
                VStack(spacing: 10) {
                    Image(systemName: "exclamationmark.triangle").font(.largeTitle).foregroundStyle(.secondary)
                    Text("폴더를 불러오지 못했어요").font(.headline)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                List {
                    if dirs.isEmpty {
                        Text("하위 폴더가 없어요").foregroundStyle(.secondary)
                    }
                    ForEach(dirs, id: \.self) { name in
                        NavigationLink {
                            DirLevel(path: childPath(name), loadDir: loadDir, onPick: onPick)
                        } label: {
                            Label(name, systemImage: "folder.fill")
                                .lineLimit(1)
                                .truncationMode(.middle)
                        }
                    }
                }
                .listStyle(.plain)
            }
        }
        .navigationTitle(base.isEmpty ? "" : lastComponent(base))
        .navigationBarTitleDisplayMode(.inline)
        .safeAreaInset(edge: .bottom) {
            VStack(spacing: Theme.Spacing.s) {
                Text(verbatim: base.isEmpty ? "…" : base)
                    .font(.caption2.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.head)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Button {
                    if !base.isEmpty { onPick(base) }
                } label: {
                    Label("이 폴더 선택", systemImage: "checkmark.circle.fill")
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 6)
                }
                .buttonStyle(.borderedProminent)
                .disabled(base.isEmpty)
            }
            .padding(.horizontal, Theme.Spacing.xxl)
            .padding(.vertical, Theme.Spacing.m)
            .background(.regularMaterial)
        }
        .task { await reload() }
    }

    private func reload() async {
        loading = true
        failed = false
        if let r = await loadDir(path) {
            base = r.base
            dirs = r.dirs
        } else {
            failed = true
        }
        loading = false
    }

    /// 자식 절대경로 — 해소된 base 기준 (path 가 "~"/"" 라도 base 는 절대경로라 안전).
    private func childPath(_ name: String) -> String {
        base.isEmpty ? name : (base.hasSuffix("/") ? base + name : base + "/" + name)
    }

    private func lastComponent(_ p: String) -> String {
        let trimmed = p.hasSuffix("/") ? String(p.dropLast()) : p
        if let i = trimmed.lastIndex(of: "/") { return String(trimmed[trimmed.index(after: i)...]) }
        return trimmed
    }
}
