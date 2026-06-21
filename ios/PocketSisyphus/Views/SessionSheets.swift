import SwiftUI

/// 세션 부가 시트 — 이름 바꾸기·숨긴 항목 관리. 원래 SessionsView.swift 안에 private 으로
/// 있던 것을 동작 그대로(접근 수준만 private→internal) 옮긴 것 — 행동보존 추출.

/// 세션 이름 변경 시트 — 예전 인플레이스 `.alert` 를 대체한다. alert 는 TextField/Button 만
/// 담을 수 있어 받아쓰기 마이크(누르고 말하기)를 못 붙이므로, 작은 시트에 새 세션 제목과 동일한
/// `VoiceInputField` + 화면 단위 공통 크롬(`.voiceDictationChrome()`)을 둔다. 빈칸이면 제목 없는
/// 세션이 되는 안내·동작은 alert 시절 그대로.
struct RenameSessionSheet: View {
    let target: SessionSummary
    @Binding var draft: String
    /// 저장 콜백 — 호출부가 `Task { await rename(target, to: draft) }` 를 수행한다.
    let onSave: (SessionSummary, String) -> Void
    @Environment(\.dismiss) private var dismiss
    @FocusState private var focused: Bool

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VoiceInputField("제목", text: $draft, focus: $focused)
                        .textInputAutocapitalization(.sentences)
                } footer: {
                    Text("비워두면 제목 없는 세션이 됩니다.")
                        .font(.caption2)
                }
            }
            .navigationTitle("세션 이름 변경")
            .navigationBarTitleDisplayMode(.inline)
            .voiceDictationChrome()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    // 해제 버튼 — 강조색이 아니라 중립(primary).
                    Button("취소") { dismiss() }
                        .tint(Color.primary)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("저장") {
                        onSave(target, draft)
                        dismiss()
                    }
                }
            }
            // 시트가 뜨면 곧바로 입력란에 포커스 — alert 처럼 바로 타이핑/받아쓰기 시작.
            .onAppear { focused = true }
        }
        .presentationDetents([.height(220)])
    }
}

/// 새 세션 시트에서 사용자가 숨김 처리한 레포 / 이어받기 후보를 보여주고
/// 한 번에 「숨김 해제」 할 수 있게 해주는 별도 시트.
struct HiddenItemsSheet: View {
    @EnvironmentObject var hiddenItems: HiddenItemsStore
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    if hiddenItems.hiddenRecentPaths.isEmpty {
                        Text("숨긴 레포가 없어요.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(sortedRecents, id: \.self) { path in
                            HStack(alignment: .top, spacing: 10) {
                                Image(systemName: "folder")
                                    .foregroundStyle(.secondary)
                                    .frame(width: 18)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text((path as NSString).lastPathComponent)
                                        .font(.body.weight(.medium))
                                        .lineLimit(1)
                                    Text(path)
                                        .font(.caption2.monospaced())
                                        .foregroundStyle(.secondary)
                                        .lineLimit(1)
                                        .truncationMode(.middle)
                                }
                                Spacer()
                                Button {
                                    hiddenItems.unhideRecent(path)
                                } label: {
                                    Label("해제", systemImage: "eye")
                                        .font(.caption)
                                }
                                .buttonStyle(.borderless)
                            }
                            .padding(.vertical, 2)
                        }
                    }
                } header: {
                    Text("숨긴 레포")
                } footer: {
                    Text("숨김을 해제하면 다음에 새 세션 시트를 열 때 다시 목록에 표시돼요.")
                        .font(.caption2)
                }

                Section {
                    if hiddenItems.hiddenResumes.isEmpty {
                        Text("숨긴 이어받기 후보가 없어요.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(sortedResumes) { meta in
                            HStack(alignment: .top, spacing: 10) {
                                Image(systemName: "arrow.triangle.2.circlepath")
                                    .foregroundStyle(.secondary)
                                    .frame(width: 18)
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(meta.preview ?? "(미리보기 없음 · \(meta.sessionId.prefix(8)))")
                                        .font(.callout)
                                        .lineLimit(2)
                                        .multilineTextAlignment(.leading)
                                    HStack(spacing: 6) {
                                        if let branch = meta.gitBranch, !branch.isEmpty {
                                            Label(branch, systemImage: "arrow.triangle.branch")
                                                .font(.caption2)
                                                .foregroundStyle(.tertiary)
                                        }
                                        Text(meta.repoPath)
                                            .font(.caption2.monospaced())
                                            .foregroundStyle(.tertiary)
                                            .lineLimit(1)
                                            .truncationMode(.middle)
                                    }
                                }
                                Spacer()
                                Button {
                                    hiddenItems.unhideResume(meta.sessionId)
                                } label: {
                                    Label("해제", systemImage: "eye")
                                        .font(.caption)
                                }
                                .buttonStyle(.borderless)
                            }
                            .padding(.vertical, 2)
                        }
                    }
                } header: {
                    Text("숨긴 이어받기")
                } footer: {
                    Text("숨길 당시의 미리보기 / 레포 경로 / 브랜치 정보를 기반으로 보여줍니다. 데스크탑에서 해당 세션이 사라졌어도 이 목록에서는 해제할 수 있어요.")
                        .font(.caption2)
                }
            }
            .navigationTitle("숨김 관리")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("닫기") { dismiss() }
                }
            }
        }
    }

    private var sortedRecents: [String] {
        hiddenItems.hiddenRecentPaths.sorted()
    }

    private var sortedResumes: [HiddenResumeMeta] {
        hiddenItems.hiddenResumes.sorted { $0.lastActiveAt > $1.lastActiveAt }
    }
}
