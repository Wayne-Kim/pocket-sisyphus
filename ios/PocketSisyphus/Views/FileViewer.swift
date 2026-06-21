import SwiftUI
import WebKit

/// 한 파일 본문 viewer — 단일 진입점.
///
/// `FileContent` 의 `contentType` / `encoding` 을 보고 내부적으로 분기:
///   - `image/svg+xml`            → SVGContentView (WKWebView 기반, 핀치 줌)
///   - `image/*` (그 외 비트맵)    → RasterImageView (UIImage + 줌 캔버스)
///   - `text/*` (encoding=utf8)    → TextContentView (줄번호 + syntax highlight)
///   - 그 외                       → 미리 보기 미지원 안내
///
/// 옛 `ImageFileViewer` + `TextFileViewer` 의 통합본. 외부 호출자 (`FileBrowserSheet`)
/// 는 분기 없이 `FileViewer(content:)` 한 줄로 끝.
struct FileViewer: View {
    let content: FileContent
    /// 라인 범위 첨언 콜백 — nil 이면 라인 선택 UI 비활성(순수 뷰어). 텍스트 파일에서만 의미.
    /// FileBrowserSheet 가 «선택한 범위를 파일 참조로 추가» 동작을 주입한다.
    var onAddLineRange: ((ClosedRange<Int>) -> Void)? = nil

    var body: some View {
        Group {
            switch kind {
            case .svg(let data):
                SVGContentView(svgData: data, zoomable: true)
                    .background(Color(.systemGroupedBackground))
            case .raster(let image):
                RasterImageView(image: image)
                    .background(Color(.systemGroupedBackground))
            case .text:
                TextContentView(content: content, onAddLineRange: onAddLineRange)
            case .undecodableSVG:
                EmptyStateView(
                    title: "SVG 디코드 실패",
                    systemImage: "photo.badge.exclamationmark",
                    message: "응답 본문이 base64 / utf8 둘 다로 풀리지 않는다.",
                )
            case .undecodableImage:
                EmptyStateView(
                    title: "이미지 디코드 실패",
                    systemImage: "photo.badge.exclamationmark",
                    message: "응답이 손상됐거나 지원하지 않는 포맷이다.",
                )
            case .unsupported:
                EmptyStateView(
                    title: "미리 보기 미지원",
                    systemImage: "eye.slash",
                    message: "이 파일 형식은 모바일 뷰어가 다루지 않는다.",
                )
            }
        }
    }

    /// 본문 분기 결정. base64 / utf8 디코드 결과까지 한 enum 으로 묶어 body 가 평탄해진다.
    private enum Kind {
        case svg(Data)
        case raster(UIImage)
        case text
        case undecodableSVG
        case undecodableImage
        case unsupported
    }

    private var kind: Kind {
        // 1) SVG — contentType 이 명시적이라 우선 판단. base64 와 utf8 둘 다 받아준다
        //    (daemon 은 현재 base64 로만 보내지만 옛/새 응답 호환).
        if content.contentType == "image/svg+xml" {
            if let data = svgData(from: content) {
                return .svg(data)
            }
            return .undecodableSVG
        }
        // 2) 그 외 이미지 — UIImage 가 처리. base64 만 가능.
        if content.isImage {
            if let img = rasterImage(from: content) {
                return .raster(img)
            }
            return .undecodableImage
        }
        // 3) 텍스트 — encoding=utf8 로 표시.
        if content.isText {
            return .text
        }
        return .unsupported
    }

    private func svgData(from c: FileContent) -> Data? {
        switch c.encoding {
        case "base64":
            return Data(base64Encoded: c.content)
        case "utf8":
            return c.content.data(using: .utf8)
        default:
            return nil
        }
    }

    private func rasterImage(from c: FileContent) -> UIImage? {
        guard c.encoding == "base64",
              let data = Data(base64Encoded: c.content)
        else { return nil }
        return UIImage(data: data)
    }
}

// MARK: - SVG (WKWebView 기반)

/// WebKit 위에 SVG 를 띄우는 SwiftUI 래퍼.
///
/// 왜 WKWebView 인가:
///   - UIImage 는 SVG 미지원. 별도 라이브러리 (SVGKit 등) 없이 가능한 유일한 native 경로.
///   - SMIL animation / CSS filter / gradients / fonts 등 SVG 의 모든 기능을 그대로 렌더.
///   - 핀치 줌이 web view 의 viewport 메타 + scrollView native 로 자동.
///
/// 보안:
///   - JS 비활성 — SVG 안의 `<script>` 가 실행되지 않음.
///   - `loadHTMLString(_, baseURL: nil)` 으로 about:blank 오리진. 외부 리소스
///     (`<image href="https://..">`, `<use xlink:href="...">` 의 원격 참조 등) 는
///     네트워크 접근 시도해도 같은 오리진 정책에서 차단.
///   - WKNavigationDelegate 가 `loadHTMLString` 이외의 모든 navigation 을 cancel.
///
/// DiffSheet 의 compact pane 에서도 같은 view 를 쓸 수 있도록 `zoomable` 로 동작 분기.
struct SVGContentView: UIViewRepresentable {
    let svgData: Data
    /// true 면 사용자가 pinch / double-tap 으로 줌 + 팬. false 면 frame 에 맞춰서 그대로 표시.
    /// DiffSheet 의 위·아래 pane 처럼 다른 컨테이너가 줌을 책임지는 경우 false.
    let zoomable: Bool

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        // JS 비활성 — defaultWebpagePreferences 가 2026 시점 표준 경로.
        config.defaultWebpagePreferences.allowsContentJavaScript = false

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator
        webView.backgroundColor = .clear
        webView.isOpaque = false
        webView.scrollView.backgroundColor = .clear
        // bouncing 비활성 — content 가 작아도 사용자가 위로 당겨서 안 흔들리도록.
        webView.scrollView.bounces = zoomable
        if !zoomable {
            // viewport meta 가 zoom 을 막아도, scrollView 자체 zoom 도 lock.
            webView.scrollView.minimumZoomScale = 1
            webView.scrollView.maximumZoomScale = 1
            webView.scrollView.isScrollEnabled = false
        }
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        guard let svgString = String(data: svgData, encoding: .utf8) else {
            // utf8 디코드 안 되면 빈 HTML — FileViewer 가 사전에 거른다.
            webView.loadHTMLString("<html><body></body></html>", baseURL: nil)
            return
        }

        // SVG 자체에는 viewport / 배경이 없을 수 있으니 HTML wrapper 로 감싼다.
        // user-scalable + min/max scale 은 viewport meta 표준. zoomable=false 면
        // user-scalable=no 로 막는다.
        let zoomMeta = zoomable
            ? "width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=6, user-scalable=yes"
            : "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no"

        let html = """
        <!DOCTYPE html>
        <html>
        <head>
        <meta charset="utf-8">
        <meta name="viewport" content="\(zoomMeta)">
        <style>
          html, body { margin: 0; padding: 0; height: 100%; background: transparent; }
          body { display: flex; align-items: center; justify-content: center; box-sizing: border-box; padding: 8px; }
          svg { max-width: 100%; max-height: 100%; height: auto; width: auto; }
          img { max-width: 100%; max-height: 100%; }
        </style>
        </head>
        <body>\(svgString)</body>
        </html>
        """
        webView.loadHTMLString(html, baseURL: nil)
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator: NSObject, WKNavigationDelegate {
        /// 첫 loadHTMLString 만 허용, 그 외 navigation 은 모두 차단.
        /// SVG 안의 `<a href="...">` 클릭 / `<image href="https://...">` 자동 로드 등을 다 막는다.
        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            // loadHTMLString 의 첫 진입은 about:blank 로 떨어진다. 그 외 navigation
            // (URL link 클릭, form submit, redirect 등) 은 전부 거절.
            if navigationAction.navigationType == .other,
               navigationAction.request.url?.scheme == "about" || navigationAction.request.url == nil
            {
                decisionHandler(.allow)
                return
            }
            decisionHandler(.cancel)
        }
    }
}

// MARK: - Raster (UIImage + zoom/pan)

/// 핀치 줌 + 더블탭 1×↔2× + 줌 상태에서 드래그 팬.
///
/// PNG/JPEG/GIF/HEIC/WebP 등 UIImage 가 처리할 수 있는 모든 비트맵. 옛 `ImageZoomCanvas`.
private struct RasterImageView: View {
    let image: UIImage

    @State private var scale: CGFloat = 1.0
    @State private var lastScale: CGFloat = 1.0
    @State private var offset: CGSize = .zero
    @State private var lastOffset: CGSize = .zero

    private let minScale: CGFloat = 1.0
    private let maxScale: CGFloat = 6.0

    var body: some View {
        GeometryReader { geo in
            Image(uiImage: image)
                .resizable()
                .scaledToFit()
                .frame(width: geo.size.width, height: geo.size.height)
                .scaleEffect(scale)
                .offset(offset)
                .gesture(
                    MagnificationGesture()
                        .onChanged { value in
                            scale = clampScale(lastScale * value)
                        }
                        .onEnded { _ in
                            lastScale = scale
                            if scale <= minScale + 0.001 {
                                offset = .zero
                                lastOffset = .zero
                            }
                        },
                )
                .gesture(
                    DragGesture()
                        .onChanged { value in
                            guard scale > minScale + 0.001 else { return }
                            offset = CGSize(
                                width: lastOffset.width + value.translation.width,
                                height: lastOffset.height + value.translation.height,
                            )
                        }
                        .onEnded { _ in
                            lastOffset = offset
                        },
                )
                .onTapGesture(count: 2) {
                    withAnimation(.easeInOut(duration: 0.2)) {
                        if scale > minScale + 0.001 {
                            scale = minScale
                            lastScale = minScale
                            offset = .zero
                            lastOffset = .zero
                        } else {
                            scale = 2.0
                            lastScale = 2.0
                        }
                    }
                }
        }
    }

    private func clampScale(_ x: CGFloat) -> CGFloat {
        min(max(x, minScale), maxScale)
    }
}

// MARK: - Text (monospaced + syntax highlight)

/// 텍스트 본문 — monospace, 줄 번호, 가로/세로 스크롤, syntax highlight.
/// 옛 `TextFileViewer` 의 본체. 외부 API 는 `FileViewer` 가 받아주므로 private.
private struct TextContentView: View {
    let content: FileContent
    /// 라인 범위 첨언 콜백 — nil 이면 라인 탭 선택 UI 비활성.
    var onAddLineRange: ((ClosedRange<Int>) -> Void)? = nil

    private var lines: [String] {
        var arr = content.content.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        if arr.last == "" { arr.removeLast() }
        return arr
    }

    @State private var maxLineWidth: CGFloat = 0
    // 라인 범위 선택 — 첫 탭=anchor, 둘째 탭=끝. 선택된 단일 라인을 다시 탭하면 해제.
    @State private var selAnchor: Int? = nil
    @State private var selEnd: Int? = nil

    // In-session 찾기 (파일에서 찾기) — 우상단 돋보기가 토글. ChatView 의 findBar 와 동일 패턴.
    // 라인 선택과 «동시에» 켜지지 않게(찾기 열면 선택 해제 + 라인 탭 비활성, 바도 레이어 분리).
    @State private var showFind = false
    @State private var findQuery = ""
    /// 전체 매치 목록(0-기반 라인 + 라인 내 범위). 큰 파일에서 백그라운드로 계산.
    @State private var matches: [FindMatch] = []
    /// 라인별 매치 범위 캐시 — 렌더마다 matches 를 훑지 않도록 갱신 시 한 번만 만든다.
    @State private var rangesByLine: [Int: [Range<String.Index>]] = [:]
    /// 현재 매치 인덱스(0-기반). 표시는 findIndex+1 / matches.count (예: 3/12).
    @State private var findIndex = 0
    @FocusState private var isFindFocused: Bool
    /// 검색어 타이핑 디바운스 + 백그라운드 카운트 태스크.
    @State private var findRecountTask: Task<Void, Never>?

    /// 현재 선택된 1-기반 라인 범위 (없으면 nil).
    private var selectedRange: ClosedRange<Int>? {
        guard let a = selAnchor, let e = selEnd else { return nil }
        return min(a, e)...max(a, e)
    }

    /// 현재 활성 매치(인덱스가 유효할 때).
    private var currentMatch: FindMatch? {
        guard findIndex >= 0, findIndex < matches.count else { return nil }
        return matches[findIndex]
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView([.vertical]) {
                VStack(alignment: .leading, spacing: 0) {
                    if content.truncated {
                        TextBanner(
                            text: "파일이 1MB 를 넘어 일부만 표시한다.",
                            systemImage: "scissors",
                            tint: Theme.warning,
                        )
                    }
                    ScrollView(.horizontal, showsIndicators: false) {
                        VStack(alignment: .leading, spacing: 0) {
                            ForEach(Array(lines.enumerated()), id: \.offset) { idx, raw in
                                let cur = currentMatch
                                TextLineRow(
                                    lineNumber: idx + 1,
                                    text: raw,
                                    gutterWidth: gutterWidth(for: lines.count),
                                    minWidth: maxLineWidth,
                                    isSelected: selectedRange?.contains(idx + 1) ?? false,
                                    matchRanges: rangesByLine[idx] ?? [],
                                    currentMatchRange: cur?.line == idx ? cur?.range : nil,
                                    // 찾기 중엔 라인 탭 선택 비활성 — 두 모드가 충돌하지 않게.
                                    onTap: (onAddLineRange == nil || showFind) ? nil : { tapLine(idx + 1) },
                                )
                                .id(idx)
                            }
                        }
                        .padding(.horizontal, 8)
                        .padding(.vertical, 6)
                    }
                    .onPreferenceChange(TextLineWidthPref.self) { width in
                        if width > maxLineWidth { maxLineWidth = width }
                    }
                }
            }
            .background(Color(.systemGroupedBackground))
            // 찾기 바 — 열려 있을 때만 상단에 얇게. ChatView findBar 와 동일 위치·동작.
            .safeAreaInset(edge: .top) {
                if showFind { findBar }
            }
            // 선택이 있으면 하단에 «L{a}–L{b} 첨언 추가» 바를 띄운다(찾기 중엔 숨김 — 레이어 분리).
            .safeAreaInset(edge: .bottom) {
                if !showFind, let range = selectedRange, let add = onAddLineRange {
                    lineSelectionBar(range: range, add: add)
                }
            }
            // 우상단 돋보기 — 찾기 토글(찾기 바가 떠 있을 땐 닫기 버튼이 대신하므로 숨김).
            .overlay(alignment: .topTrailing) {
                if !showFind {
                    Button { openFind() } label: {
                        Image(systemName: "magnifyingglass")
                            .font(.footnote.weight(.semibold))
                            .padding(9)
                            .background(.ultraThinMaterial, in: Circle())
                    }
                    .accessibilityLabel(Text("파일에서 찾기"))
                    .padding(.top, 8)
                    .padding(.trailing, 12)
                }
            }
            .onChange(of: findQuery) { _ in scheduleRecount() }
            // 매치 갱신/인덱스 이동 시 현재 매치를 화면 안으로 스크롤.
            .onChange(of: matches) { _ in scrollToCurrent(proxy) }
            .onChange(of: findIndex) { _ in scrollToCurrent(proxy) }
            // 파일이 갱신/리로드되면(본문 변경) 매치 재계산.
            .onChange(of: content.content) { _ in if showFind { scheduleRecount() } }
            // 찾기 바 마이크(받아쓰기) 공통 크롬 — 녹음 HUD·준비 배너·오류.
            .voiceDictationChrome()
        }
    }

    /// 찾기 바 — [돋보기][검색어][3/12 또는 결과 없음][▲ 이전][▼ 다음][✕ 닫기].
    private var findBar: some View {
        HStack(spacing: 10) {
            Image(systemName: "magnifyingglass")
                .font(.footnote)
                .foregroundStyle(.secondary)
            VoiceInputField("파일에서 찾기", text: $findQuery, focus: $isFindFocused)
                .textFieldStyle(.plain)
                .submitLabel(.search)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
                .onSubmit { goToNextMatch() }
            // 매치 수 / 현재 위치 — 검색어가 있을 때만. 0 건이면 «결과 없음».
            if !findQuery.isEmpty {
                if matches.isEmpty {
                    Text("결과 없음")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                } else {
                    Text(verbatim: "\(findIndex + 1)/\(matches.count)")
                        .font(.footnote.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
            }
            Button {
                goToPreviousMatch()
            } label: {
                Image(systemName: "chevron.up")
            }
            .disabled(matches.isEmpty)
            .accessibilityLabel(Text("이전 일치"))
            Button {
                goToNextMatch()
            } label: {
                Image(systemName: "chevron.down")
            }
            .disabled(matches.isEmpty)
            .accessibilityLabel(Text("다음 일치"))
            // 닫기 — 해제 버튼이라 강조색 아닌 중립 primary (색 정책).
            Button {
                closeFind()
            } label: {
                Image(systemName: "xmark")
                    .foregroundStyle(Color.primary)
            }
            .accessibilityLabel(Text("찾기 닫기"))
        }
        .font(.body)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.bar)
    }

    /// 찾기 열기 — 라인 선택을 해제하고(충돌 방지) 검색 필드에 키보드를 준다.
    private func openFind() {
        selAnchor = nil
        selEnd = nil
        showFind = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
            isFindFocused = true
        }
    }

    /// 찾기 닫기 — 상태 초기화 + 하이라이트 해제 + 디바운스 태스크 취소.
    private func closeFind() {
        findRecountTask?.cancel()
        findRecountTask = nil
        showFind = false
        isFindFocused = false
        findQuery = ""
        matches = []
        rangesByLine = [:]
        findIndex = 0
    }

    /// 검색어/본문이 바뀌면 250ms 디바운스 후 백그라운드에서 매치를 다시 센다(렌더 안 끊기게).
    /// 빈 검색어면 즉시 하이라이트 해제.
    private func scheduleRecount() {
        findRecountTask?.cancel()
        let query = findQuery
        guard !query.isEmpty else {
            matches = []
            rangesByLine = [:]
            findIndex = 0
            return
        }
        let snapshot = lines
        findRecountTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: 250_000_000)
            if Task.isCancelled { return }
            let computed = await Task.detached(priority: .userInitiated) {
                computeFindMatches(query: query, lines: snapshot)
            }.value
            if Task.isCancelled { return }
            // 계산 중 검색어가 또 바뀌었으면 폐기(이 결과는 stale).
            guard query == findQuery else { return }
            matches = computed
            rangesByLine = Dictionary(grouping: computed, by: { $0.line }).mapValues { $0.map(\.range) }
            findIndex = 0
        }
    }

    /// 다음 매치로 — 인덱스를 순환 증가(스크롤은 onChange 가 처리).
    private func goToNextMatch() {
        guard !matches.isEmpty else { return }
        findIndex = (findIndex + 1) % matches.count
    }

    /// 이전 매치로 — 인덱스를 순환 감소.
    private func goToPreviousMatch() {
        guard !matches.isEmpty else { return }
        findIndex = (findIndex - 1 + matches.count) % matches.count
    }

    private func scrollToCurrent(_ proxy: ScrollViewProxy) {
        guard let m = currentMatch else { return }
        withAnimation(.easeInOut(duration: 0.2)) {
            proxy.scrollTo(m.line, anchor: .center)
        }
    }

    /// 라인 탭 처리 — anchor 미설정이면 시작점, 이미 단일 선택된 같은 라인 재탭이면 해제,
    /// 그 외에는 anchor 에서 탭한 라인까지로 범위 확장.
    private func tapLine(_ n: Int) {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        if selAnchor == nil {
            selAnchor = n
            selEnd = n
        } else if selAnchor == n && selEnd == n {
            selAnchor = nil
            selEnd = nil
        } else {
            selEnd = n
        }
    }

    private func lineSelectionBar(range: ClosedRange<Int>, add: @escaping (ClosedRange<Int>) -> Void) -> some View {
        HStack(spacing: 10) {
            Text(verbatim: range.lowerBound == range.upperBound
                ? "L\(range.lowerBound)"
                : "L\(range.lowerBound)–L\(range.upperBound)")
                .font(.callout.monospaced().weight(.semibold))
                .foregroundStyle(Theme.pro)  // 첨언/파일참조 도구 그룹 — 주황(채팅 도구 칩과 통일)
            Spacer()
            Button("선택 해제") {
                selAnchor = nil
                selEnd = nil
            }
            .buttonStyle(.bordered)
            Button("첨언 추가") {
                add(range)
                selAnchor = nil
                selEnd = nil
            }
            .buttonStyle(.borderedProminent)
            .tint(Theme.pro)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .background(.ultraThinMaterial)
    }

    private func gutterWidth(for count: Int) -> CGFloat {
        let digits = max(1, String(max(1, count)).count)
        return CGFloat(digits) * 9.0 + 16.0
    }
}

private struct TextLineRow: View {
    let lineNumber: Int
    let text: String
    let gutterWidth: CGFloat
    let minWidth: CGFloat
    var isSelected: Bool = false
    /// 이 라인 안에서 찾기 매치가 걸린 범위들(line 기준 String.Index). 배경 하이라이트.
    var matchRanges: [Range<String.Index>] = []
    /// 현재 활성 매치 범위(이 라인에 있으면). 더 진한 배경으로 강조.
    var currentMatchRange: Range<String.Index>? = nil
    /// nil 이면 탭 비활성(순수 뷰어). 값이 있으면 라인 탭 = 범위 선택 토글.
    var onTap: (() -> Void)? = nil

    private var highlightedText: AttributedString {
        var attr = SyntaxHighlighter.highlight(text)
        if !matchRanges.isEmpty {
            SyntaxHighlighter.applyMatchHighlights(
                on: &attr, line: text, ranges: matchRanges, current: currentMatchRange,
            )
        }
        return attr
    }

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            Text("\(lineNumber)")
                .font(.system(size: Theme.FontSize.codeGutter, weight: .regular, design: .monospaced))
                .foregroundStyle(isSelected ? Theme.pro : Color.secondary.opacity(0.55))
                .frame(width: gutterWidth, alignment: .trailing)
                .padding(.trailing, 8)
            Text(highlightedText)
                .font(.system(size: Theme.FontSize.code, weight: .regular, design: .monospaced))
                .lineLimit(1)
                .fixedSize(horizontal: true, vertical: false)
                .background(
                    GeometryReader { geo in
                        Color.clear.preference(key: TextLineWidthPref.self, value: geo.size.width)
                    },
                )
                .frame(minWidth: max(0, minWidth - gutterWidth - 8), alignment: .leading)
        }
        // 선택 하이라이트는 가로 스크롤 폭 전체로 깔리도록 음수 패딩 없이 행 배경에.
        .background(isSelected ? Theme.pro.opacity(0.18) : Color.clear)
        .contentShape(Rectangle())
        .onTapGesture { onTap?() }
    }
}

/// 라인 폭 측정. DiffSheet 의 `LineWidthPref` 와 의도는 같지만 모듈 충돌 회피 위해
/// 다른 이름 + private. 같은 PreferenceKey 라도 둘 다 fileprivate 이라 충돌 없음.
private struct TextLineWidthPref: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

private struct TextBanner: View {
    let text: String
    let systemImage: String
    let tint: Color

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: systemImage)
                .font(.caption)
                .foregroundStyle(tint)
            Text(text)
                .font(.caption)
                .foregroundStyle(.secondary)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(tint.opacity(0.08))
    }
}

// MARK: - Syntax highlight

/// 한 줄 텍스트 → 색 입힌 AttributedString.
///
/// 정규식 기반 «범용 토큰화». 언어별 룰셋을 안 두는 대신 대부분의 코드/설정에 공통인 패턴만 색칠:
///   - 줄 주석: `//...`
///   - 문자열 리터럴: 한 줄짜리 `"..."` / `'...'` / `` `...` ``
///   - 숫자: 정수/소수/16진
///   - 키워드: Swift/TS/JS/Py/Rust/Go 합집합
///
/// 한계 — 의도적으로 가벼움:
///   - multi-line string 은 첫 줄만 hi
///   - language-aware 가 아님 — keyword false-positive 가 변수 이름에 살짝 색이 들어갈 수 있음
enum SyntaxHighlighter {
    // 구문 강조 색은 Theme.Syntax 로 중앙화 — 다크 배경에 맞춘 채도 값이 한곳에 모인다.
    private static let commentColor = Color.secondary
    private static let stringColor = Theme.Syntax.string
    private static let numberColor = Theme.Syntax.number
    private static let keywordColor = Theme.Syntax.keyword

    static func highlight(_ line: String) -> AttributedString {
        var attr = AttributedString(line)

        if let r = commentRange(in: line) {
            applyColor(commentColor, on: &attr, line: line, range: r)
            let prefix = line.prefix(line.distance(from: line.startIndex, to: r.lowerBound))
            applyOtherTokens(prefix: String(prefix), in: &attr, line: line)
            return attr
        }

        applyOtherTokens(prefix: line, in: &attr, line: line)
        return attr
    }

    private static func commentRange(in line: String) -> Range<String.Index>? {
        var bestIdx: String.Index?
        if let r = line.range(of: "//") {
            if !isInsideString(line: line, at: r.lowerBound) {
                bestIdx = r.lowerBound
            }
        }
        guard let i = bestIdx else { return nil }
        return i..<line.endIndex
    }

    private static func isInsideString(line: String, at index: String.Index) -> Bool {
        var count = 0
        var i = line.startIndex
        while i < index {
            let ch = line[i]
            if ch == "\\" {
                let next = line.index(after: i)
                if next < index {
                    i = line.index(after: next)
                    continue
                }
            }
            if ch == "\"" { count += 1 }
            i = line.index(after: i)
        }
        return count % 2 == 1
    }

    private static func applyOtherTokens(prefix: String, in attr: inout AttributedString, line: String) {
        let stringPattern = #"(\"(?:\\.|[^\"\\])*\")|('(?:\\.|[^'\\])*')|(`(?:\\.|[^`\\])*`)"#
        let stringMatches = matches(in: prefix, pattern: stringPattern)
        for r in stringMatches {
            applyColor(stringColor, on: &attr, line: line, range: r)
        }

        let numberPattern = #"\b(0x[0-9A-Fa-f]+|\d+(?:\.\d+)?)\b"#
        for r in matches(in: prefix, pattern: numberPattern) {
            if stringMatches.contains(where: { $0.contains(r.lowerBound) }) { continue }
            applyColor(numberColor, on: &attr, line: line, range: r)
        }

        let kwPattern = #"\b(?:func|class|struct|enum|protocol|extension|let|var|const|if|else|elif|guard|switch|case|default|for|while|do|repeat|return|throw|throws|try|catch|finally|defer|async|await|public|private|internal|fileprivate|open|static|final|import|export|from|as|in|of|new|self|this|super|nil|null|None|true|false|True|False|def|lambda|pass|raise|fn|impl|match|mod|pub|use|where|with|yield|break|continue|interface|type|typeof|instanceof|void|never)\b"#
        for r in matches(in: prefix, pattern: kwPattern) {
            if stringMatches.contains(where: { $0.contains(r.lowerBound) }) { continue }
            applyColor(keywordColor, on: &attr, line: line, range: r)
        }
    }

    private static func matches(in text: String, pattern: String) -> [Range<String.Index>] {
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return [] }
        let ns = text as NSString
        let results = regex.matches(in: text, range: NSRange(location: 0, length: ns.length))
        return results.compactMap { match in
            Range(match.range, in: text)
        }
    }

    private static func applyColor(
        _ color: Color,
        on attr: inout AttributedString,
        line: String,
        range: Range<String.Index>,
    ) {
        guard let lower = AttributedString.Index(range.lowerBound, within: attr),
              let upper = AttributedString.Index(range.upperBound, within: attr)
        else { return }
        attr[lower..<upper].foregroundColor = color
    }

    /// 찾기 매치 배경 하이라이트 — 일반 매치는 옅은 accent, 현재 매치는 진한 accent.
    /// `line` 으로 만든 AttributedString 에 `ranges`(line 기준 String.Index)를 입힌다.
    /// 찾기 하이라이트는 «선택» 의미라 색 정책상 accent(보라). 라인 선택(주황)과 색으로 구분된다.
    static func applyMatchHighlights(
        on attr: inout AttributedString,
        line: String,
        ranges: [Range<String.Index>],
        current: Range<String.Index>?,
    ) {
        for r in ranges {
            let isCurrent = r == current
            applyBackground(
                Theme.accent.opacity(isCurrent ? 0.6 : 0.28),
                on: &attr, line: line, range: r,
            )
        }
    }

    private static func applyBackground(
        _ color: Color,
        on attr: inout AttributedString,
        line: String,
        range: Range<String.Index>,
    ) {
        guard let lower = AttributedString.Index(range.lowerBound, within: attr),
              let upper = AttributedString.Index(range.upperBound, within: attr)
        else { return }
        attr[lower..<upper].backgroundColor = color
    }
}

// MARK: - 찾기 매치

/// 한 매치 — 0-기반 라인 인덱스 + 그 라인 문자열 안의 범위.
/// Sendable — 백그라운드 detached 태스크에서 계산해 메인으로 넘기기 위함.
private struct FindMatch: Equatable, Sendable {
    let line: Int
    let range: Range<String.Index>
}

/// 라인 배열에서 query 의 비중첩·대소문자무시 매치를 모두 찾는다.
/// Swift 의 `.caseInsensitive` 비교는 유니코드(한글 등)를 정상 처리(ChatView 카운트와 동일 기준).
/// 큰 파일에서도 본문 렌더를 끊지 않도록 호출부가 디바운스 + 백그라운드 태스크에서 돌린다.
private func computeFindMatches(query: String, lines: [String]) -> [FindMatch] {
    guard !query.isEmpty else { return [] }
    var result: [FindMatch] = []
    for (i, line) in lines.enumerated() {
        var from = line.startIndex
        while let r = line.range(of: query, options: .caseInsensitive, range: from ..< line.endIndex) {
            result.append(FindMatch(line: i, range: r))
            // 비중첩 — 매치 끝부터 다시 탐색. 빈 매치(이론상 없음)면 한 칸 전진해 무한루프 방지.
            from = r.upperBound > r.lowerBound ? r.upperBound : line.index(after: r.lowerBound)
            if from >= line.endIndex { break }
        }
    }
    return result
}

// «미리 보기 미지원»/디코드 실패 안내는 공용 `EmptyStateView`(DesignSystem/StateViews.swift) 로
// 통합됐다 — 위 case 들이 종류별 아이콘만 바꿔 그 공용 컴포넌트를 쓴다.
