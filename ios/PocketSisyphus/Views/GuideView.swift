import SwiftUI

/// 메뉴 → "도움말" 진입 시 떠오르는 시트. NavigationStack 기반으로 카테고리 리스트 →
/// Article 으로 push. `initialCategoryId` 가 주어지면 시트가 열리는 동시에 해당 글을
/// 자동으로 push 해서 deeplink 동작 (InfoButton 에서 진입한 경우).
struct GuideView: View {
    let initialCategoryId: String?

    @State private var path: [String] = []
    @Environment(\.dismiss) private var dismiss

    init(initialCategoryId: String? = nil) {
        self.initialCategoryId = initialCategoryId
    }

    var body: some View {
        NavigationStack(path: $path) {
            List(GuideContent.all) { cat in
                NavigationLink(value: cat.id) {
                    HStack(alignment: .center, spacing: 12) {
                        Image(systemName: cat.icon)
                            .font(.title3)
                            .foregroundStyle(Theme.accent)
                            .frame(width: 28)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(LocalizedStringKey(cat.titleKey))
                                .font(.headline)
                            Text(LocalizedStringKey(cat.leadKey))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                        }
                    }
                    .padding(.vertical, 4)
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("도움말")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("닫기") { dismiss() }
                }
            }
            .navigationDestination(for: String.self) { id in
                if let cat = GuideContent.find(id) {
                    GuideArticleView(category: cat)
                }
            }
            .onAppear {
                if let initial = initialCategoryId,
                   GuideContent.find(initial) != nil,
                   path.isEmpty
                {
                    // sheet 가 막 뜬 직후 push — onAppear 안에서 바로 호출해도 SwiftUI 가
                    // 정상 처리한다. 살짝 늦추면 깜빡임이 생겨 즉시.
                    path = [initial]
                }
            }
        }
    }
}

/// 카테고리 한 글의 본문 렌더링.
struct GuideArticleView: View {
    let category: GuideCategory

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                // Lead — 글 진입 시 한 줄 요약을 다시 강조.
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: category.icon)
                        .font(.title2)
                        .foregroundStyle(Theme.accent)
                        .frame(width: 28)
                    Text(LocalizedStringKey(category.leadKey))
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.bottom, 4)

                ForEach(category.sections.indices, id: \.self) { i in
                    sectionView(category.sections[i])
                }

                Spacer(minLength: 12)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 16)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .navigationTitle(LocalizedStringKey(category.titleKey))
        .navigationBarTitleDisplayMode(.inline)
    }

    @ViewBuilder
    private func sectionView(_ section: GuideSection) -> some View {
        switch section {
        case .paragraph(let text):
            Text(LocalizedStringKey(text))
                .font(.body)
                .fixedSize(horizontal: false, vertical: true)

        case .bullets(let items):
            VStack(alignment: .leading, spacing: 6) {
                ForEach(items.indices, id: \.self) { idx in
                    HStack(alignment: .top, spacing: 8) {
                        Text("•")
                            .font(.body.weight(.bold))
                            .foregroundStyle(Theme.accent)
                        Text(LocalizedStringKey(items[idx]))
                            .font(.body)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            .padding(.leading, 4)

        case .callout(let systemImage, let tint, let text):
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: systemImage)
                    .foregroundStyle(tint.color)
                    .font(.body)
                Text(LocalizedStringKey(text))
                    .font(.callout)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(tint.color.opacity(0.10))
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .stroke(tint.color.opacity(0.25), lineWidth: 1)
            )

        case .code(let code):
            Text(verbatim: code)
                .font(.system(.caption, design: .monospaced))
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.secondary.opacity(0.10))
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        }
    }
}

/// 인라인 (?) 헬프 아이콘. 누르면 Guide 시트가 그 카테고리 글로 바로 열린다.
///
/// 사용처 (v1):
///   - PairView 헤더 — id "start"
///   - SessionsView 자동 승인 토글 — id "approval"
///   - SessionsView 이어 받기 섹션 — id "resume"
///   - AppRoot ErrorView — id "tor"
struct InfoButton: View {
    let categoryId: String
    /// 아이콘 크기 조절용 — 기본은 .caption.
    var font: Font = .caption

    @State private var showGuide = false

    var body: some View {
        Button {
            showGuide = true
        } label: {
            Image(systemName: "questionmark.circle")
                .foregroundStyle(.secondary)
                .font(font)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("도움말")
        .sheet(isPresented: $showGuide) {
            GuideView(initialCategoryId: categoryId)
        }
    }
}
