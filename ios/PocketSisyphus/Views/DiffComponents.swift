import SwiftUI

/// DiffSheet / CommitsView 가 공유하는 git diff 표시 프리미티브.
///
/// 원래 DiffSheet.swift 안에 private 으로 있던 것들을 커밋 diff 뷰어가 재사용할 수 있게
/// internal 로 끌어올렸다 (동작은 그대로 — 접근 수준만 변경). 변경 파일 한 줄, 상태 뱃지,
/// unified diff 본문 렌더가 두 화면에서 동일하게 보이도록 한 곳에 모은다.

/// 리스트 한 row — 상태 뱃지 + 경로 + +/- 카운트. (커밋되지 않은 변경 + 커밋 변경 둘 다 사용.)
struct DiffFileRow: View {
    let file: GitStatusFile

    var body: some View {
        HStack(spacing: 10) {
            DiffStatusBadge(status: file.primaryStatus)
            VStack(alignment: .leading, spacing: 2) {
                Text(file.path)
                    .font(.callout.monospaced())
                    .lineLimit(2)
                    .truncationMode(.middle)
                if file.binary {
                    Text("Binary").font(.caption2).foregroundStyle(.secondary)
                } else if file.additions == 0 && file.deletions == 0 {
                    // numstat 이 0/0 으로 흡수한 경우 (untracked 등) — 라벨 생략.
                    EmptyView()
                } else {
                    HStack(spacing: 6) {
                        if file.additions > 0 {
                            Text("+\(file.additions)").foregroundStyle(Theme.success)
                        }
                        if file.deletions > 0 {
                            Text("−\(file.deletions)").foregroundStyle(Theme.danger)
                        }
                    }
                    .font(.caption2.monospaced())
                }
            }
            Spacer()
        }
        .padding(.vertical, 2)
    }
}

/// 좌측 상태 뱃지 — primaryStatus 한 글자 + 색.
struct DiffStatusBadge: View {
    let status: Character

    private var label: String { String(status) }
    private var color: Color {
        switch status {
        // 상태 배지는 형제 A/D/R 처럼 git 카테고리를 의미 토큰에 대응시킨다(앱 «경고» 가 아니라
        // 「수정됨」 의 VCS 관례색 = 노랑). 리터럴 대신 토큰을 거쳐 hue 의 SSOT 를 유지한다.
        case "M": return Theme.warning
        case "A": return Theme.success
        case "D": return Theme.danger
        case "R": return Theme.info
        case "?": return .gray
        default:  return .secondary
        }
    }

    var body: some View {
        Text(label)
            .font(.caption.monospaced().weight(.bold))
            .foregroundStyle(Theme.onAccent)
            .frame(width: 22, height: 22)
            .background(color)
            .clipShape(RoundedRectangle(cornerRadius: 4, style: .continuous))
    }
}

/// unified diff 텍스트 본문 — 줄 prefix 로 색칠한 monospaced 뷰.
/// 가로로 긴 줄은 가로 스크롤 (인디케이터 숨김). 세로는 바깥 ScrollView([.vertical]) 가 처리.
///
/// 너비 정책 — 옛 구현은 DiffLine 에 `.frame(maxWidth: .infinity)` 를 박았는데
/// 수평 ScrollView 안에서 그 modifier 가 부모(디바이스) 폭을 강제 제안받아 각 줄이
/// 자동 wrap 되어 «좁은 컬럼에 텍스트가 줄줄» 보이는 회귀 (사용자 보고 2026-05).
/// 지금은: 각 줄 `.lineLimit(1) + .fixedSize(horizontal:)` 로 wrap 없이 자기 본문 폭만
/// 차지하고, `LineWidthPref` 가 가장 긴 줄의 폭을 측정해 모든 줄의 배경을 그 폭까지
/// 깔도록 minWidth 를 통일한다 — 색칠된 우측 끝이 들쑥날쑥하지 않게.
///
/// LazyVStack 회귀 (2026-05) — 본문을 LazyVStack 으로 감쌌더니, 진입 시 viewport 에
/// 보이는 짧은 meta 줄들만 layout 되어 LazyVStack 폭 = 메타 줄 max 로 잡혔다.
/// 수평 ScrollView 의 contentSize 가 그 짧은 폭으로 박혀서, 아래로 세로 스크롤 해 긴
/// 코드 줄이 나타나도 수평 스크롤 범위는 안 늘어나는 증상. 본문은 daemon 쪽에서 200KB
/// 로 truncate 돼 들어오므로 그냥 VStack 으로 모든 줄을 한 번에 layout 시킨다.
struct DiffBody: View {
    let diff: String
    let truncated: Bool
    let untracked: Bool
    /// 하이라이트 언어 결정용 파일 경로. nil(또는 미지원 확장자)이면 기존 prefix 색칠만.
    var path: String? = nil

    @State private var maxLineWidth: CGFloat = 0
    /// 라인 인덱스 → syntax highlight 된 본문. 계산 전/미지원 언어면 nil — 평문 렌더.
    /// DiffSyntaxHighlighter 가 백그라운드에서 채우고, 끝나면 한 번에 색이 입혀진다.
    @State private var highlighted: [AttributedString?]?
    /// 0-based 현재 hunk 순번 — 화면 맨 위에 와 있는 @@ 헝크. 수동 스크롤·점프 둘 다 갱신.
    @State private var currentHunk = 0
    /// 본문 전체 높이 (viewport 보다 커야 «스크롤이 실제로 필요» → 점프 컨트롤 노출).
    @State private var contentHeight: CGFloat = 0
    /// iPhone-only — verticalSizeClass 변화 = 가로/세로 회전. 회전 시 현재 hunk 앵커를 다시 잡는다.
    @Environment(\.verticalSizeClass) private var vSizeClass

    /// ScrollView 좌표공간 이름 — hunk 헤더의 viewport 상대 위치를 재는 기준.
    private static let scrollSpace = "diffHunkScroll"

    var body: some View {
        let lines = diff.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        // @@ 로 시작하는 줄 = hunk 헤더. 점프 앵커 + 진행 표시(현재/전체)의 기준.
        // 빈 diff·바이너리는 애초에 DiffBody 로 오지 않으므로 여기선 항상 실제 본문이다.
        let hunkLineIndices = lines.indices.filter { lines[$0].hasPrefix("@@") }
        // 본문 끝을 알리는 sentinel 의 prefence 키 — 줄 인덱스와 겹치지 않게 lines.count 사용.
        let bottomKey = lines.count
        GeometryReader { outer in
            let viewport = outer.size.height
            // 헝크 ≥2 + 본문이 viewport 보다 길 때만 (= 손가락 스크롤이 실제로 필요할 때) 점프 컨트롤.
            // 헝크 1개거나 한 화면에 다 들어오는 짧은 변경이면 군더더기라 숨긴다.
            let showNavigator = hunkLineIndices.count >= 2 && contentHeight > viewport + 8
            ScrollViewReader { proxy in
                ScrollView([.vertical]) {
                    VStack(alignment: .leading, spacing: 0) {
                        if untracked {
                            DiffBanner(
                                text: "Untracked — 파일 전체를 추가된 것으로 표시한다.",
                                systemImage: "plus.circle",
                                tint: Theme.success,
                            )
                        }
                        if truncated {
                            DiffBanner(
                                text: "변경 내용이 200KB 를 넘어 일부만 표시한다.",
                                systemImage: "scissors",
                                tint: Theme.warning,
                            )
                        }
                        // 가로 스크롤은 본문 한 번만 감싼다 — 줄별로 ScrollView 를 두면 동기화가 안 된다.
                        // VStack (LazyVStack 아님) — Lazy 면 viewport 에 보이는 짧은 메타 줄들의 max 로
                        // 수평 ScrollView contentSize 가 박혀서 아래 긴 코드 줄까지 스크롤이 안 늘어남.
                        // 200KB cap (daemon) 안에 들어오니까 한 번에 layout 시켜도 부담 없음.
                        ScrollView(.horizontal, showsIndicators: false) {
                            VStack(alignment: .leading, spacing: 0) {
                                ForEach(Array(lines.enumerated()), id: \.offset) { index, raw in
                                    DiffLine(
                                        text: raw,
                                        highlighted: highlightedLine(at: index, lineCount: lines.count),
                                        minWidth: maxLineWidth,
                                    )
                                    // 점프 타깃 — proxy.scrollTo(index) 로 이 줄을 맨 위에 올린다.
                                    .id(index)
                                    // hunk 헤더 줄만 viewport 상대 Y 를 보고 — 「지금 맨 위 hunk」 계산용.
                                    .background(hunkOffsetReporter(lineIndex: index, isHunk: raw.hasPrefix("@@")))
                                }
                            }
                            .padding(.horizontal, 8)
                            .padding(.vertical, 6)
                        }
                        .onPreferenceChange(LineWidthPref.self) { width in
                            // PreferenceKey 가 보낸 max(라인 폭) 가 자기보다 크면 갱신. 같으면 무시 (재진입 안정).
                            if width > maxLineWidth { maxLineWidth = width }
                        }
                        // 본문 끝 sentinel — 이게 viewport 안에 들어오면 «맨 아래까지 스크롤» 로 보고
                        // 마지막 hunk 가 화면 꼭대기까지 못 올라가도 현재값을 마지막으로 맞춘다.
                        Color.clear
                            .frame(height: 1)
                            .background(
                                GeometryReader { geo in
                                    Color.clear.preference(
                                        key: HunkOffsetPref.self,
                                        value: [bottomKey: geo.frame(in: .named(Self.scrollSpace)).minY],
                                    )
                                }
                            )
                    }
                    // 본문 전체 높이 측정 — viewport 와 비교해 점프 컨트롤 노출 여부 결정.
                    .background(
                        GeometryReader { geo in
                            Color.clear.preference(key: ContentHeightPref.self, value: geo.size.height)
                        }
                    )
                }
                .coordinateSpace(name: Self.scrollSpace)
                .background(Color(.systemGroupedBackground))
                .task(id: diff) {
                    guard let path else { return }
                    let diff = diff
                    // tree-sitter 파싱은 동기 — 메인 스레드 밖에서 돌리고 끝나면 한 번에 반영.
                    // 미지원 확장자면 nil 이 돌아와 평문 렌더 그대로 (추가 비용 없음).
                    highlighted = await Task.detached(priority: .userInitiated) {
                        DiffSyntaxHighlighter.highlight(diff: diff, path: path)
                    }.value
                }
                .onChange(of: diff) { _ in currentHunk = 0 }
                .onPreferenceChange(ContentHeightPref.self) { contentHeight = $0 }
                .onPreferenceChange(HunkOffsetPref.self) { offsets in
                    // hunk 헤더들의 viewport 상대 위치로 「지금 맨 위 hunk」 를 정한다 (수동 스크롤·점프 공통).
                    guard hunkLineIndices.count >= 2 else { return }
                    var cur = 0
                    for (order, lineIdx) in hunkLineIndices.enumerated() {
                        // 헤더가 꼭대기(=4pt 안쪽) 까지 올라온 hunk 들 중 마지막 = 현재 들어가 있는 hunk.
                        if let y = offsets[lineIdx], y <= 4 { cur = order }
                    }
                    // 맨 아래까지 내려가 본문 끝이 보이면 마지막 hunk 가 현재 (짧은 마지막 hunk 보정).
                    if let bottom = offsets[bottomKey], bottom <= viewport + 4 {
                        cur = hunkLineIndices.count - 1
                    }
                    if cur != currentHunk { currentHunk = cur }
                }
                // 회전 시 layout 이 다시 잡힌 뒤 현재 hunk 를 다시 맨 위로 — 앵커 유지.
                .onChange(of: vSizeClass) { _ in
                    guard hunkLineIndices.indices.contains(currentHunk) else { return }
                    DispatchQueue.main.async {
                        proxy.scrollTo(hunkLineIndices[currentHunk], anchor: .topLeading)
                    }
                }
                .overlay(alignment: .bottomTrailing) {
                    if showNavigator {
                        DiffHunkNavigator(
                            current: currentHunk,
                            total: hunkLineIndices.count,
                            onPrev: { scrollToHunk(currentHunk - 1, indices: hunkLineIndices, proxy: proxy) },
                            onNext: { scrollToHunk(currentHunk + 1, indices: hunkLineIndices, proxy: proxy) },
                        )
                    }
                }
            }
        }
    }

    /// diff 텍스트와 하이라이트 결과의 줄 수가 일치할 때만 매핑 — 어긋나면 (이론상
    /// diff 갱신 직후 찰나) 평문으로 안전하게 둔다.
    private func highlightedLine(at index: Int, lineCount: Int) -> AttributedString? {
        guard let highlighted, highlighted.count == lineCount else { return nil }
        return highlighted[index]
    }

    /// hunk 헤더 줄만 자기 viewport 상대 minY 를 preference 로 흘려보낸다 (나머지 줄은 비용 0).
    @ViewBuilder
    private func hunkOffsetReporter(lineIndex: Int, isHunk: Bool) -> some View {
        if isHunk {
            GeometryReader { geo in
                Color.clear.preference(
                    key: HunkOffsetPref.self,
                    value: [lineIndex: geo.frame(in: .named(Self.scrollSpace)).minY],
                )
            }
        }
    }

    /// 점프 — order 번째 hunk 헤더 줄을 화면 맨 위로. 양끝은 clamp (버튼 disabled 와 이중 안전장치).
    private func scrollToHunk(_ order: Int, indices: [Int], proxy: ScrollViewProxy) {
        guard !indices.isEmpty else { return }
        let clamped = max(0, min(indices.count - 1, order))
        withAnimation(.easeInOut(duration: 0.2)) {
            proxy.scrollTo(indices[clamped], anchor: .topLeading)
        }
    }
}

/// 모든 DiffLine 의 실측 폭 중 최대값을 모아 DiffBody 로 올린다.
/// 안정점: minWidth = max(이전 max, 현재 자기 텍스트 폭) — 자기를 키우는 입력은 없고
/// max 가 한 번 정해지면 모든 라인이 그 폭으로 통일된다.
struct LineWidthPref: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

/// hunk 헤더 줄(+ 본문 끝 sentinel)의 viewport 상대 Y 모음 (lineIndex → minY).
/// DiffBody 가 이걸로 «지금 맨 위 hunk» 와 «맨 아래 도달» 을 판단한다.
struct HunkOffsetPref: PreferenceKey {
    static var defaultValue: [Int: CGFloat] = [:]
    static func reduce(value: inout [Int: CGFloat], nextValue: () -> [Int: CGFloat]) {
        value.merge(nextValue()) { _, new in new }
    }
}

/// 본문 VStack 전체 높이 — viewport 와 비교해 점프 컨트롤 노출 여부를 가린다.
struct ContentHeightPref: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

/// diff 본문 위에 떠 있는 hunk 점프 컨트롤 — 이전/다음 hunk + 「현재/전체」 진행 표시.
///
/// 색 정책 — 점프는 기본 인터랙티브라 기본 틴트(accent=보라)만 쓴다. diff 추가/삭제 토큰
/// (초록/빨강) 은 본문 색이므로 여기 끌어오지 않는다(신규 강조색 금지). 진행 숫자는 중립 primary.
struct DiffHunkNavigator: View {
    let current: Int   // 0-based
    let total: Int
    let onPrev: () -> Void
    let onNext: () -> Void

    var body: some View {
        HStack(spacing: 18) {
            Button(action: onPrev) {
                Image(systemName: "chevron.up")
            }
            .disabled(current <= 0)
            .accessibilityLabel(Text("이전 헝크"))

            // 「2/7」 — 순수 숫자라 번역 대상 아님(verbatim). 읽어주기용 라벨만 localize.
            Text(verbatim: "\(current + 1)/\(total)")
                .font(.footnote.monospacedDigit().weight(.semibold))
                .foregroundStyle(.primary)
                .accessibilityLabel(Text("헝크 \(current + 1) / \(total)"))

            Button(action: onNext) {
                Image(systemName: "chevron.down")
            }
            .disabled(current >= total - 1)
            .accessibilityLabel(Text("다음 헝크"))
        }
        .font(.body.weight(.semibold))
        .padding(.horizontal, 16)
        .padding(.vertical, 9)
        .background(.regularMaterial, in: Capsule())
        .overlay(Capsule().strokeBorder(Color.primary.opacity(0.08)))
        .shadow(color: .black.opacity(0.15), radius: 6, y: 2)
        .padding(.trailing, 16)
        .padding(.bottom, 16)
    }
}

/// iOS 17 의 ContentUnavailableView 호환 대체 — 16.4 타깃 유지 위해 직접 그림.
struct DiffEmptyState: View {
    let title: LocalizedStringKey
    let systemImage: String
    let message: LocalizedStringKey

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: systemImage)
                .font(.system(size: Theme.IconSize.l))
                .foregroundStyle(.secondary)
            Text(title)
                .font(.headline)
            Text(message)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 24)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

struct DiffBanner: View {
    let text: String
    let systemImage: String
    let tint: Color

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: systemImage)
            Text(text)
        }
        .font(.caption)
        .foregroundStyle(tint)
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(tint.opacity(0.12))
    }
}

/// 한 줄. prefix 한 글자(+/-/@/space) 로 색상 분기.
///
/// `minWidth` — DiffBody 가 측정한 가장 긴 줄의 폭. 자기보다 짧은 줄도 이 폭까지
/// frame 을 늘려 배경 색이 동일한 우측 끝까지 깔리게 한다. 첫 렌더에는 0 이라 자기
/// 폭만큼만 깔리고, PreferenceKey 가 measure 끝나면 한 번 더 그려져 통일된다.
struct DiffLine: View {
    let text: String
    /// syntax highlight 된 본문 (prefix 글자 포함, 전경색만 실림). nil 이면 평문 + kind 색.
    var highlighted: AttributedString?
    let minWidth: CGFloat

    private enum Kind { case add, remove, hunk, meta, context }

    private var kind: Kind {
        guard let first = text.first else { return .context }
        switch first {
        case "+":
            // `+++ ` 헤더는 meta. 단일 `+` 만 add.
            return text.hasPrefix("+++") ? .meta : .add
        case "-":
            return text.hasPrefix("---") ? .meta : .remove
        case "@":
            return text.hasPrefix("@@") ? .hunk : .context
        case "d", "i":
            // `diff --git` / `index ` 같은 git diff 헤더.
            if text.hasPrefix("diff ") || text.hasPrefix("index ") { return .meta }
            return .context
        default:
            return .context
        }
    }

    private var background: Color {
        switch kind {
        case .add:    return Theme.success.opacity(Theme.Opacity.badge)
        case .remove: return Theme.danger.opacity(Theme.Opacity.badge)
        case .hunk:   return Theme.info.opacity(0.16)
        case .meta:   return Color.secondary.opacity(0.10)
        case .context: return .clear
        }
    }

    private var foreground: Color {
        switch kind {
        case .add:     return Theme.success
        case .remove:  return Theme.danger
        case .hunk:    return Theme.info
        case .meta:    return .secondary
        case .context: return .primary
        }
    }

    var body: some View {
        // 하이라이트 모드 — 본문은 토큰색(명시 안 된 run 은 .primary), 변경 종류는
        // prefix(+/-) 색 + 배경 tint 가 말한다. 평문 모드는 기존대로 줄 전체를 kind 색으로.
        Group {
            if let highlighted {
                Text(highlighted)
            } else {
                Text(text.isEmpty ? " " : text)
                    .foregroundStyle(foreground)
            }
        }
            // .caption 은 너무 작아서 한 줄 안에 더 보지 못해도 어차피 가로 스크롤이 있으니
            // 가독성을 우선 — .footnote (~13pt) + monospaced.
            .font(.system(.footnote, design: .monospaced))
            // wrap 금지 — 한 줄은 한 줄로. 가로로 넘치면 부모 ScrollView (.horizontal) 가 처리.
            // fixedSize(horizontal:) 가 빠지면 부모가 폭을 제안하는 순간 Text 가 줄바꿈해서
            // «좁은 컬럼» 회귀가 다시 난다.
            .lineLimit(1)
            .fixedSize(horizontal: true, vertical: false)
            .padding(.horizontal, 6)
            .padding(.vertical, 0.5)
            // 가장 긴 줄의 폭까지 늘려 배경의 우측 끝을 통일한다 (DiffBody 의 PreferenceKey 가 측정).
            .frame(minWidth: minWidth, alignment: .leading)
            .background(background)
            // 실측 폭을 DiffBody 로 전달. background 안의 GeometryReader 는 부모(이 row) 의 frame 을 잰다.
            .background(
                GeometryReader { geo in
                    Color.clear.preference(key: LineWidthPref.self, value: geo.size.width)
                }
            )
    }
}
