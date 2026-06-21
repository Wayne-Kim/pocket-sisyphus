import SwiftUI
import AppKit

/// Mac 측 가이드 시스템 — 메뉴의 "도움말" 항목이 열어주는 별도 NSWindow.
///
/// 메뉴바 popover 안에 inline 으로 넣기엔 콘텐츠 분량이 많아서 (7 카테고리 × 단락 다수)
/// 별도 창으로 띄운다. NavigationSplitView 로 sidebar(카테고리) + detail(article).
@MainActor
final class GuideWindowController: ObservableObject {
    private var window: NSWindow?
    /// show(categoryId:) 딥링크 요청 — 루트 뷰가 onChange 로 받아 사이드바 선택을 옮긴다.
    /// (메뉴의 «권한 안내…» 처럼 특정 글로 바로 열고 싶은 진입점용.)
    @Published var requestedCategoryId: String?

    func show(categoryId: String? = nil) {
        if let categoryId {
            requestedCategoryId = categoryId
        }
        if let w = window {
            w.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }
        let content = MacGuideRootView(controller: self)
        let host = NSHostingController(rootView: content)
        let w = NSWindow(contentViewController: host)
        w.title = String(localized: "도움말")
        w.styleMask = [.titled, .closable, .miniaturizable, .resizable]
        w.setContentSize(NSSize(width: 760, height: 560))
        w.center()
        w.isReleasedWhenClosed = false
        window = w
        w.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func close() {
        window?.close()
    }
}

/// 가이드 창의 루트 — sidebar 카테고리 + detail Article.
private struct MacGuideRootView: View {
    @ObservedObject var controller: GuideWindowController
    @State private var selectedId: String?

    init(controller: GuideWindowController) {
        self.controller = controller
        // 창 «생성» 시점의 딥링크 — 이미 떠 있는 창의 딥링크는 아래 onChange 가 처리.
        _selectedId = State(initialValue: controller.requestedCategoryId ?? GuideContent.all.first?.id)
    }

    var body: some View {
        NavigationSplitView {
            List(GuideContent.all, selection: $selectedId) { cat in
                NavigationLink(value: cat.id) {
                    Label {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(LocalizedStringKey(cat.titleKey))
                                .font(.headline)
                            Text(LocalizedStringKey(cat.leadKey))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                        }
                    } icon: {
                        Image(systemName: cat.icon)
                            .foregroundStyle(Color.accentColor)
                    }
                    .padding(.vertical, 2)
                }
            }
            .navigationTitle("도움말")
            .navigationSplitViewColumnWidth(min: 220, ideal: 260, max: 320)
        } detail: {
            if let id = selectedId, let cat = GuideContent.find(id) {
                MacGuideArticleView(category: cat)
            } else {
                VStack(spacing: 12) {
                    Image(systemName: "questionmark.circle")
                        .font(.system(size: 48))
                        .foregroundStyle(.secondary)
                    Text("도움말")
                        .font(.title2)
                    Text("왼쪽에서 항목을 골라주세요")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .frame(minWidth: 700, minHeight: 480)
        // 창이 이미 떠 있는 상태에서 show(categoryId:) 가 다시 불린 경우 — 선택만 옮긴다.
        .onChange(of: controller.requestedCategoryId) { newValue in
            guard let id = newValue else { return }
            selectedId = id
            controller.requestedCategoryId = nil
        }
    }
}

/// 카테고리 한 글의 Mac 본문 렌더링.
private struct MacGuideArticleView: View {
    let category: GuideCategory

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                // 제목 + 아이콘 + lead.
                HStack(alignment: .top, spacing: 12) {
                    Image(systemName: category.icon)
                        .font(.system(size: 28))
                        .foregroundStyle(Color.accentColor)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(LocalizedStringKey(category.titleKey))
                            .font(.title)
                        Text(LocalizedStringKey(category.leadKey))
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(.bottom, 4)

                ForEach(category.sections.indices, id: \.self) { i in
                    sectionView(category.sections[i])
                }

                Spacer(minLength: 16)
            }
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    @ViewBuilder
    private func sectionView(_ section: GuideSection) -> some View {
        switch section {
        case .paragraph(let text):
            Text(LocalizedStringKey(text))
                .font(.body)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)

        case .bullets(let items):
            VStack(alignment: .leading, spacing: 6) {
                ForEach(items.indices, id: \.self) { idx in
                    HStack(alignment: .top, spacing: 8) {
                        Text("•")
                            .font(.body.weight(.bold))
                            .foregroundStyle(Color.accentColor)
                        Text(LocalizedStringKey(items[idx]))
                            .font(.body)
                            .fixedSize(horizontal: false, vertical: true)
                            .textSelection(.enabled)
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
                    .textSelection(.enabled)
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(tint.color.opacity(0.10))
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .stroke(tint.color.opacity(0.25), lineWidth: 1),
            )

        case .code(let code):
            Text(verbatim: code)
                .font(.system(.body, design: .monospaced))
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.secondary.opacity(0.10))
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                .textSelection(.enabled)
        }
    }
}
