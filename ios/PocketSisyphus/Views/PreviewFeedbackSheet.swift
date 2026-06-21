import SwiftUI
import UIKit

/// 폰에서 «본 것 위에 표시해서 보내기» 시트 — 캡처된 프레임 위에 마크업(펜·동그라미·화살표)을
/// 더하고 한 줄 코멘트를 단 뒤, 합성 이미지를 세션 repo 의 임시 폴더(`.ps-preview-feedback` /
/// `.ps-screen-feedback`)에 채널 너머(기존 attachments fs 라우트)로 저장한다. 저장 결과(경로) +
/// 코멘트를 `FileReferenceDraft` 로 만들어 onComplete 로 올리면, ChatView 의 기존 «전송 대기 파일
/// 참조»(fileRefs) 플럼빙이 그대로 다음 메시지에 첨부한다 — 새 전송 파이프 없음.
///
/// 두 진입(웹 프리뷰 / 화면 미러)이 캡처·그리기·aspect-fit·다운스케일 로직을 «공유» 하고 draft
/// 합성만 `target` 으로 분기한다 — 결과 평면의 마지막 세그먼트(화면 미러)까지 같은 마크업→지시
/// 멘탈모델로 닫는다:
///   - `.preview` : 진입 URL + DOM 요소 식별(elementFromPoint) → previewURL non-nil draft.
///   - `.screen`  : Mac 실화면 캡처. 웹이 아니라 URL·DOM 식별 없음 → isScreenFeedback draft.
///     DOM 이 없으니 «가리킨 요소» 대신, 마크업 영역의 정규화 좌표(0..1)를 screenRegion 으로 실어
///     에이전트가 «어디» 를 텍스트로도 받게 한다.
///
/// 마크업은 캡처 픽셀 크기와 무관한 «정규화(0..1) 좌표» 로 저장한다 — 레티나 다중 디스플레이의
/// 초대형 캡처를 화면에선 작게 보여줘도(aspect-fit), 합성/좌표 환산이 다운스케일 배율에 흔들리지
/// 않는다. 진행 중 마크업은 모두 로컬 @State 라, 시트가 닫히거나(미러 끊김 등) 취소되면 합성 없이
/// 그대로 폐기된다 — 크래시 없이 복귀.
///
/// 코드 파일에서 라인을 첨언해 보내듯, 화면(픽셀)도 «가리켜 보내기» 가 되도록 한 일관된 멘탈모델.
struct PreviewFeedbackSheet: View {
    /// 캡처된 프레임 스냅샷 — 웹 프리뷰는 WKWebView.takeSnapshot, 화면 미러는 원샷 스크린샷
    /// (UIImage(data:)) 결과. 어느 쪽이든 픽셀 크기 그대로 들고 와 aspect-fit 으로 깔린다.
    let snapshot: UIImage
    let sessionId: String
    let api: ApiClient
    /// 합성 대상(웹 프리뷰 / 화면 미러) — 저장 폴더 + draft 합성 분기.
    let target: Target
    /// 완성된 피드백 참조를 ChatView 의 fileRefs 로 올리는 콜백. 호출 후 시트는 스스로 닫힌다.
    let onComplete: (FileReferenceDraft) -> Void

    /// 피드백 합성 대상 — §13 결과 평면의 세그먼트(웹/화면) 중 어디서 왔는가.
    enum Target {
        /// 웹 프리뷰 — 진입 URL/포트 + 마크업이 가리킨 DOM 요소 식별(elementFromPoint).
        /// resolveElement: 살아있는 WKWebView 로 한 줄 설명을 채워준다(nil 이면 미해석).
        case preview(url: String, resolveElement: ((CGPoint) async -> String?)?)
        /// 화면 미러 — Mac 실화면 캡처. 웹이 아니라 DOM 요소 식별 불가, URL 도 없다.
        case screen
    }

    /// 마크업 도구 — 펜(자유 그리기)·동그라미(드래그 ellipse)·화살표(드래그 line+촉).
    private enum MarkupTool { case pen, circle, arrow }

    /// 마크업 한 항목 — 모든 좌표는 캡처 프레임 기준 정규화(0..1, 좌상단 원점). 표시(aspect-fit)나
    /// 합성(다운스케일) 어느 surface 에 그려도 같은 비율로 환산되므로 해상도 의존이 없다.
    private enum MarkupItem {
        case pen([CGPoint])           // 자유 획 — 정규화 점들
        case circle(CGRect)           // 정규화 bounding rect (ellipse)
        case arrow(CGPoint, CGPoint)  // 시작 → 끝(촉) 정규화 점

        /// 실수로 찍힌 미세 입력 버리기 — onEnded 에서 채택 여부 판단.
        var isMeaningful: Bool {
            switch self {
            case .pen(let p): return !p.isEmpty
            case .circle(let r): return r.width > 0.012 && r.height > 0.012
            case .arrow(let a, let b): return hypot(a.x - b.x, a.y - b.y) > 0.02
            }
        }

        /// 정규화 좌표계의 bounding box — screenRegion / DOM center 계산용.
        var normalizedBounds: CGRect {
            switch self {
            case .pen(let pts):
                guard let f = pts.first else { return .zero }
                var minX = f.x, minY = f.y, maxX = f.x, maxY = f.y
                for p in pts {
                    minX = min(minX, p.x); minY = min(minY, p.y)
                    maxX = max(maxX, p.x); maxY = max(maxY, p.y)
                }
                return CGRect(x: minX, y: minY, width: maxX - minX, height: maxY - minY)
            case .circle(let r):
                return r
            case .arrow(let a, let b):
                return CGRect(x: min(a.x, b.x), y: min(a.y, b.y),
                              width: abs(a.x - b.x), height: abs(a.y - b.y))
            }
        }
    }

    @Environment(\.dismiss) private var dismiss
    @State private var comment: String = ""
    /// 기본 도구 = 동그라미 — «이 버튼이 어긋났어» 라고 위치를 가리키는 주 동작.
    @State private var tool: MarkupTool = .circle
    /// 채택된 마크업 항목 + 드래그 중인 미채택 항목(onEnded 에서 합류).
    @State private var items: [MarkupItem] = []
    @State private var current: MarkupItem?
    @State private var isSending = false
    @State private var sendError: String?
    /// 저장 실패 시 «코멘트만 보내기» 폴백 alert.
    @State private var showFallback = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 12) {
                Text("화면 위에 손가락으로 표시하고, 무엇을 고칠지 한 줄로 적어 보내세요.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal)

                GeometryReader { geo in
                    let fit = Self.aspectFitRect(imageSize: snapshot.size,
                                                 in: CGRect(origin: .zero, size: geo.size))
                    ZStack {
                        Image(uiImage: snapshot)
                            .resizable()
                            .frame(width: fit.width, height: fit.height)
                            .position(x: fit.midX, y: fit.midY)
                        Canvas { ctx, _ in
                            let w = Self.lineWidth(for: fit.size)
                            for item in items { Self.draw(item, in: &ctx, surface: fit, width: w) }
                            if let c = current { Self.draw(c, in: &ctx, surface: fit, width: w) }
                        }
                        .allowsHitTesting(false)
                    }
                    .frame(width: geo.size.width, height: geo.size.height)
                    .contentShape(Rectangle())
                    .gesture(drawGesture(fit: fit))
                }
                .background(Color(.secondarySystemBackground))
                .clipShape(RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(.separator))
                .padding(.horizontal)

                toolRow
                    .padding(.horizontal)

                VoiceInputField("이 화면에서 무엇을 고칠까요?", text: $comment, lineLimit: 1...3)
                    .textFieldStyle(.roundedBorder)
                    .padding(.horizontal)

                if let sendError {
                    Text(sendError)
                        .font(.footnote)
                        .foregroundStyle(Theme.danger)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal)
                }
                Spacer(minLength: 0)
            }
            .padding(.vertical)
            .navigationTitle("화면 피드백")
            .navigationBarTitleDisplayMode(.inline)
            .voiceDictationChrome()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("취소") { dismiss() }
                        .tint(Color.primary)   // 해제 버튼은 중립색 (색 정책).
                        .disabled(isSending)
                }
                ToolbarItem(placement: .confirmationAction) {
                    if isSending {
                        ProgressView()
                    } else {
                        Button("보내기") { send() }   // 주요 액션 — 기본 accent(보라).
                    }
                }
            }
            .alert("스크린샷을 저장하지 못했어요", isPresented: $showFallback) {
                Button("코멘트만 보내기") { sendCommentOnly() }
                Button("취소", role: .cancel) {}
            } message: {
                switch target {
                case .preview: Text("이미지 없이 코멘트와 프리뷰 주소만 첨부할 수 있어요.")
                case .screen: Text("이미지 없이 코멘트만 첨부할 수 있어요.")
                }
            }
        }
    }

    // MARK: - 도구 막대 (펜 · 동그라미 · 화살표 · 되돌리기 · 모두 지우기)

    private var toolRow: some View {
        HStack(spacing: 16) {
            toolButton(.pen, icon: "scribble.variable", label: "펜")
            toolButton(.circle, icon: "circle", label: "동그라미")
            toolButton(.arrow, icon: "arrow.up.right", label: "화살표")
            Spacer()
            Button {
                if !items.isEmpty { items.removeLast() }
            } label: {
                Image(systemName: "arrow.uturn.backward")
            }
            .buttonStyle(.bordered)
            .tint(Color.primary)               // 되돌리기는 중립(해제성) — 색 정책.
            .disabled(items.isEmpty)
            .accessibilityLabel("되돌리기")
            Button(role: .destructive) {
                items.removeAll()
                current = nil
            } label: {
                Image(systemName: "trash")
            }
            .buttonStyle(.bordered)
            .disabled(items.isEmpty)
            .accessibilityLabel("모두 지우기")
        }
    }

    private func toolButton(_ t: MarkupTool, icon: String, label: LocalizedStringKey) -> some View {
        Button {
            tool = t
        } label: {
            Image(systemName: icon)
                .frame(width: 40, height: 32)
                .background(
                    tool == t ? Theme.accent.opacity(0.18) : Color.clear,
                    in: RoundedRectangle(cornerRadius: 7, style: .continuous),
                )
                .foregroundStyle(tool == t ? Theme.accent : Color.primary)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(label))
        .accessibilityAddTraits(tool == t ? .isSelected : [])
    }

    // MARK: - 그리기 제스처

    private func drawGesture(fit: CGRect) -> some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { value in
                let s = Self.normalize(value.startLocation, in: fit)
                let e = Self.normalize(value.location, in: fit)
                switch tool {
                case .pen:
                    if case .pen(var pts)? = current {
                        pts.append(e)
                        current = .pen(pts)
                    } else {
                        current = .pen([s, e])
                    }
                case .circle:
                    current = .circle(CGRect(x: min(s.x, e.x), y: min(s.y, e.y),
                                             width: abs(s.x - e.x), height: abs(s.y - e.y)))
                case .arrow:
                    current = .arrow(s, e)
                }
            }
            .onEnded { _ in
                if let c = current, c.isMeaningful { items.append(c) }
                current = nil
            }
    }

    // MARK: - 전송

    private func send() {
        isSending = true
        sendError = nil
        guard let composite = renderComposite(), let png = composite.pngData() else {
            isSending = false
            sendError = String(localized: "이미지를 만들 수 없어요")
            return
        }
        // <timestamp>.png — 약속된 임시 폴더에 저장. 동일 초 충돌은 daemon 이 -n 접미로 회피.
        let ts = Int(Date().timeIntervalSince1970)
        let filename = "\(ts).png"
        // 마크업 중심점 → 포인트 좌표. 웹 프리뷰만 그 자리 DOM 요소를 함께 해석한다(화면 미러는
        // 웹이 아니라 elementFromPoint 대상이 없음 — markupCenterInWebPoints 자체를 건너뛴다).
        let markupPoint = markupCenterInWebPoints()
        Task {
            // 가리킨 요소 식별 — 살아있는 WKWebView 의 elementFromPoint 결과. 실패해도 전송은 진행.
            var elementDesc: String? = nil
            if case let .preview(_, resolve?) = target, let p = markupPoint {
                elementDesc = await resolve(p)
            }
            do {
                let saved = try await api.uploadAttachments(
                    sessionId,
                    dir: feedbackDir,
                    images: [(filename: filename, data: png)],
                    label: String(localized: "피드백 저장 중…"),
                )
                guard let first = saved.first else {
                    throw NSError(domain: "PreviewFeedback", code: 0)
                }
                let draft = makeDraft(path: first.rel, element: elementDesc)
                await MainActor.run {
                    onComplete(draft)
                    dismiss()
                }
            } catch {
                // repo read-only/권한 없음 등 → 코멘트만 보내는 폴백 제안.
                await MainActor.run {
                    isSending = false
                    sendError = error.localizedDescription
                    showFallback = true
                }
            }
        }
    }

    /// 이미지 없이 코멘트만(+ 프리뷰면 URL, 화면이면 좌표) 첨부하는 폴백 (path 빈 문자열).
    private func sendCommentOnly() {
        onComplete(makeDraft(path: "", element: nil))
        dismiss()
    }

    /// 저장 폴더 — 웹/화면 임시 피드백 폴더를 분리해 산출물 디렉터리와 섞이지 않게.
    private var feedbackDir: String {
        switch target {
        case .preview: return ".ps-preview-feedback"
        case .screen: return ".ps-screen-feedback"
        }
    }

    /// draft 합성 — target 으로만 분기. 웹은 previewURL/previewElement(DOM)를 싣고, 화면은
    /// isScreenFeedback + screenRegion(정규화 좌표)을 싣는다(URL·DOM 없음). path 빈 문자열은 저장 실패 폴백.
    private func makeDraft(path: String, element: String?) -> FileReferenceDraft {
        switch target {
        case let .preview(url, _):
            return FileReferenceDraft(
                path: path,
                lineRange: nil,
                instruction: trimmedComment,
                previewURL: url,
                previewElement: element,
            )
        case .screen:
            return FileReferenceDraft(
                path: path,
                lineRange: nil,
                instruction: trimmedComment,
                isScreenFeedback: true,
                screenRegion: screenRegionString(),
            )
        }
    }

    private var trimmedComment: String {
        comment.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // MARK: - 좌표 환산 (마크업 영역 → 포인트 / 정규화 요약)

    /// 마크업 영역의 중심점을 «웹뷰 포인트 좌표»(스냅샷 = 가시 영역과 1:1)로 환산한다.
    /// 그림이 없으면 nil → 요소 해석 생략. 정규화 bbox 중심에 스냅샷 포인트 크기를 곱한다.
    private func markupCenterInWebPoints() -> CGPoint? {
        guard let b = markupBoundsNormalized() else { return nil }
        return CGPoint(x: b.midX * snapshot.size.width, y: b.midY * snapshot.size.height)
    }

    /// 화면 미러용 «가리킨 위치» 요약 — 정규화(0..1, 좌상단 원점) 중심 + 크기. 비번역 기술 토큰이라
    /// composeFileRefPrompt 가 라벨만 붙여 그대로 싣는다. 마크업이 없으면 nil → 위치 항목 생략.
    private func screenRegionString() -> String? {
        guard let b = markupBoundsNormalized() else { return nil }
        return String(format: "x=%.2f, y=%.2f, w=%.2f, h=%.2f", b.midX, b.midY, b.width, b.height)
    }

    /// 채택된 모든 마크업 항목의 정규화 bbox 합집합. 항목이 없으면 nil.
    private func markupBoundsNormalized() -> CGRect? {
        var rect: CGRect?
        for item in items {
            let b = item.normalizedBounds
            rect = rect.map { $0.union(b) } ?? b
        }
        return rect
    }

    // MARK: - 이미지 합성 (스냅샷 + 마크업 → 다운스케일 PNG)

    /// 스냅샷 위에 마크업을 얹어 한 장으로 렌더한다. 정규화 좌표라 surface 크기가 곧 «캡» 크기여도
    /// 비율 그대로 그려진다. 마크업이 없으면 스냅샷만 다운스케일 — «그대로 첨부»(raw) 경로.
    /// 레티나 초대형 캡처는 장변 maxPixel 로 캡해 채널 전송 비용을 억제한다.
    @MainActor
    private func renderComposite(maxPixel: CGFloat = 1600) -> UIImage? {
        let pxW = snapshot.size.width * snapshot.scale
        let pxH = snapshot.size.height * snapshot.scale
        guard pxW > 1, pxH > 1 else { return snapshot }
        let longest = max(pxW, pxH)
        let factor = longest > maxPixel ? maxPixel / longest : 1
        let surface = CGSize(width: pxW * factor, height: pxH * factor)
        let drawItems = items
        let content = ZStack {
            Image(uiImage: snapshot)
                .resizable()
                .frame(width: surface.width, height: surface.height)
            Canvas { ctx, size in
                let rect = CGRect(origin: .zero, size: size)
                let w = Self.lineWidth(for: size)
                for item in drawItems { Self.draw(item, in: &ctx, surface: rect, width: w) }
            }
            .frame(width: surface.width, height: surface.height)
        }
        .frame(width: surface.width, height: surface.height)
        let renderer = ImageRenderer(content: content)
        renderer.scale = 1     // surface 가 이미 픽셀 크기.
        renderer.isOpaque = true
        return renderer.uiImage ?? snapshot
    }

    // MARK: - 좌표/그리기 헬퍼 (static — 라이브 Canvas · 합성 Canvas 공유)

    /// 뷰(또는 합성 surface) 좌표 → 정규화(0..1). fit 바깥은 가장자리로 클램프(획이 끊기지 않게).
    private static func normalize(_ p: CGPoint, in fit: CGRect) -> CGPoint {
        guard fit.width > 0, fit.height > 0 else { return .zero }
        let x = min(max((p.x - fit.minX) / fit.width, 0), 1)
        let y = min(max((p.y - fit.minY) / fit.height, 0), 1)
        return CGPoint(x: x, y: y)
    }

    /// 마크업 선 굵기 — surface 장변에 비례해 어떤 해상도/표시 크기에서도 비슷한 시각 비중.
    private static func lineWidth(for size: CGSize) -> CGFloat {
        max(max(size.width, size.height) / 180, 3)
    }

    /// 한 마크업 항목을 GraphicsContext 에 그린다 — 정규화 좌표를 surface 로 펼친다. 캡처 위에서
    /// 다크/라이트 어느 배경이든 충분히 대비되도록, accent(보라) 잉크 «아래에» 흰 외곽선(halo)을
    /// 한 번 더 깐다. 색은 의미 토큰(Theme.accent)만 쓰고 임의 리터럴은 안 쓴다 — 색 정책 준수.
    /// (흰 halo 는 의미색이 아니라 임의 배경 사진 위 가독성을 위한 외곽선.)
    private static func draw(_ item: MarkupItem, in ctx: inout GraphicsContext, surface: CGRect, width w: CGFloat) {
        let halo = StrokeStyle(lineWidth: w * 1.9, lineCap: .round, lineJoin: .round)
        let ink = StrokeStyle(lineWidth: w, lineCap: .round, lineJoin: .round)
        let haloColor = Color.white.opacity(0.9)
        let inkColor = Theme.accent

        func denorm(_ n: CGPoint) -> CGPoint {
            CGPoint(x: surface.minX + n.x * surface.width, y: surface.minY + n.y * surface.height)
        }
        func strokeBoth(_ path: Path) {
            ctx.stroke(path, with: .color(haloColor), style: halo)
            ctx.stroke(path, with: .color(inkColor), style: ink)
        }

        switch item {
        case .pen(let ns):
            let pts = ns.map(denorm)
            guard let first = pts.first else { return }
            if pts.count == 1 {
                // 탭 한 번 = 점 찍기 — halo 원 위에 ink 원.
                let r = w * 0.8
                let outer = CGRect(x: first.x - r, y: first.y - r, width: 2 * r, height: 2 * r)
                let inner = outer.insetBy(dx: w * 0.35, dy: w * 0.35)
                ctx.fill(Path(ellipseIn: outer), with: .color(haloColor))
                ctx.fill(Path(ellipseIn: inner), with: .color(inkColor))
                return
            }
            var path = Path()
            path.move(to: first)
            for p in pts.dropFirst() { path.addLine(to: p) }
            strokeBoth(path)

        case .circle(let nr):
            let r = CGRect(
                x: surface.minX + nr.minX * surface.width,
                y: surface.minY + nr.minY * surface.height,
                width: nr.width * surface.width,
                height: nr.height * surface.height,
            )
            strokeBoth(Path(ellipseIn: r))

        case .arrow(let na, let nb):
            let a = denorm(na), b = denorm(nb)
            let dist = hypot(b.x - a.x, b.y - a.y)
            let headLen = max(w * 3.5, dist * 0.22)
            let ang = atan2(b.y - a.y, b.x - a.x)
            let spread: CGFloat = 0.5   // ≈29°
            let h1 = CGPoint(x: b.x - headLen * cos(ang - spread), y: b.y - headLen * sin(ang - spread))
            let h2 = CGPoint(x: b.x - headLen * cos(ang + spread), y: b.y - headLen * sin(ang + spread))
            var path = Path()
            path.move(to: a); path.addLine(to: b)        // 몸통
            path.move(to: h1); path.addLine(to: b); path.addLine(to: h2)  // 촉
            strokeBoth(path)
        }
    }

    private static func aspectFitRect(imageSize: CGSize, in bounds: CGRect) -> CGRect {
        guard imageSize.width > 0, imageSize.height > 0 else { return bounds }
        let scale = min(bounds.width / imageSize.width, bounds.height / imageSize.height)
        let w = imageSize.width * scale
        let h = imageSize.height * scale
        return CGRect(x: bounds.midX - w / 2, y: bounds.midY - h / 2, width: w, height: h)
    }
}
