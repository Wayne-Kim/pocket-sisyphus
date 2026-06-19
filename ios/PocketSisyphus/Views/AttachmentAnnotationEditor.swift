import SwiftUI
import UIKit
import CoreImage

/// 첨부 이미지 펜 주석 한 획 — 점들을 «이미지 픽셀 좌표계» 로 저장해, 화면 표시 배율과
/// 무관하게 베이스 이미지에 그대로 합성할 수 있다.
struct AnnotationStroke: Equatable {
    var points: [CGPoint]
    var colorIndex: Int
}

/// 주석 한 항목 — 펜 획 또는 블러(픽셀화) 영역. 둘 다 이미지 픽셀 좌표계.
/// 합성/미리보기 모두 블러를 먼저 베이스에 적용하고 그 «위에» 획을 그린다 — 가린 영역
/// 위에도 펜 표시가 보이도록. 하나의 리스트로 들고 있어 종류 구분 없이 마지막 항목부터
/// 되돌리기가 된다.
enum AnnotationItem: Equatable {
    case stroke(AnnotationStroke)
    case blur(CGRect)
}

/// 첨부 이미지 위에 펜으로 주석을 달거나 민감 영역을 블러로 가리는 에디터.
/// AttachmentDraft «단위» 로 동작해 사진첩 첨부·미러링 캡처·화면 녹화 샘플 프레임(rec-stepNN)이
/// 전부 같은 진입점(썸네일 탭)을 공유한다.
///
/// 블러는 미러링 캡처에 담기는 토큰·이메일 같은 민감정보가 Claude(외부 API)로 나가기 전에
/// 가리는 용도다 — CIPixellate 로 블록 평균색만 남겨 원문을 복원할 수 없고, 미리보기와 합성이
/// 같은 픽셀화 사본을 잘라 쓰므로 «화면에 보이는 대로» 저장된다.
///
/// 완료 시 베이스 이미지에 주석(블러+획)을 합성해 draft 의 image/data 를 갱신하고, 주석 원본도
/// draft 에 남겨 다시 열면 이어서 편집/되돌리기 할 수 있다. instruction(예: «화면 녹화 단계 3/8 —
/// 4.2초 시점»)은 건드리지 않으므로 녹화 프레임의 시점 설명이 그대로 보존된다.
struct AttachmentAnnotationEditor: View {
    let draft: AttachmentDraft
    /// 합성 결과가 반영된 draft 를 돌려준다 — 호출부(AttachmentSheet)가 배열에서 교체.
    let onSave: (AttachmentDraft) -> Void

    @Environment(\.dismiss) private var dismiss

    private enum Tool {
        case pen, blur
    }

    @State private var items: [AnnotationItem]
    @State private var current: AnnotationStroke?
    @State private var currentBlur: CGRect?
    @State private var tool: Tool = .pen
    @State private var colorIndex = 0
    /// 베이스 전체를 픽셀화한 사본 — 블러 도구를 처음 쓸 때 한 번 만들어 미리보기/합성에 공유.
    @State private var pixellated: UIImage?

    /// 블러 한 변의 최소 크기 (이미지 픽셀) — 이보다 작은 드래그는 실수로 보고 버린다.
    private static let minBlurSide: CGFloat = 8

    /// 펜 팔레트 — Theme 의 의미 토큰이 아니라 사용자가 고르는 «잉크 색»(드로잉 콘텐츠).
    /// 문제 위치 표시가 주 용도라 기본은 빨강.
    private static let palette: [(name: LocalizedStringKey, ui: UIColor)] = [
        ("빨강", .systemRed),
        ("파랑", .systemBlue),
        ("초록", .systemGreen),
        ("흰색", .white),
    ]

    init(draft: AttachmentDraft, onSave: @escaping (AttachmentDraft) -> Void) {
        self.draft = draft
        self.onSave = onSave
        _items = State(initialValue: draft.annotations)
    }

    /// 주석 합성 «전» 베이스 — 라이브 드로잉은 항상 이 위에 그린다.
    private var baseImage: UIImage { draft.baseImage ?? draft.image }

    var body: some View {
        NavigationStack {
            GeometryReader { geo in
                let fit = Self.fitRect(image: baseImage.size, in: geo.size)
                ZStack {
                    Image(uiImage: baseImage)
                        .resizable()
                        .frame(width: fit.width, height: fit.height)
                        .position(x: fit.midX, y: fit.midY)
                    Canvas { ctx, _ in
                        let scale = fit.width / baseImage.size.width
                        drawBlurs(in: &ctx, fit: fit, scale: scale)
                        for case .stroke(let s) in items {
                            draw(s, in: &ctx, fit: fit, scale: scale)
                        }
                        if let c = current {
                            draw(c, in: &ctx, fit: fit, scale: scale)
                        }
                    }
                    .allowsHitTesting(false)
                }
                .frame(width: geo.size.width, height: geo.size.height)
                .contentShape(Rectangle())
                .gesture(drawGesture(fit: fit))
                .overlay {
                    if items.isEmpty && current == nil && currentBlur == nil {
                        Group {
                            if tool == .pen {
                                Text("드래그해서 문제 위치를 표시하세요")
                            } else {
                                Text("드래그해서 가릴 영역을 지정하세요")
                            }
                        }
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .background(.thinMaterial, in: Capsule())
                        .allowsHitTesting(false)
                    }
                }
            }
            .background(Color(.systemBackground))
            .navigationTitle("주석")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("취소") { dismiss() }
                        .tint(Color.primary)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("완료") { save() }
                }
            }
            .safeAreaInset(edge: .bottom) { toolbar }
            .onAppear {
                // 기존 블러 주석을 들고 재진입한 경우 — 미리보기가 반투명 fallback 으로
                // 원문을 비치게 두지 않도록 픽셀화 사본을 바로 준비한다.
                if items.contains(where: { if case .blur = $0 { true } else { false } }) {
                    ensurePixellated()
                }
            }
        }
    }

    // MARK: - 하단 도구막대 (도구 · 펜 색 · 되돌리기 · 모두 지우기)

    private var toolbar: some View {
        HStack(spacing: 14) {
            toolButton(.pen, icon: "scribble", label: "펜")
            toolButton(.blur, icon: "checkerboard.rectangle", label: "블러")
            Divider().frame(height: 24)
            if tool == .pen {
                ForEach(Self.palette.indices, id: \.self) { i in
                    Button {
                        colorIndex = i
                    } label: {
                        Circle()
                            .fill(Color(Self.palette[i].ui))
                            .frame(width: 26, height: 26)
                            .overlay {
                                // 흰색 잉크도 보이도록 얇은 중립 테두리.
                                Circle().strokeBorder(Color.secondary.opacity(0.4), lineWidth: 1)
                            }
                            .overlay {
                                if colorIndex == i {
                                    Circle().strokeBorder(Theme.accent, lineWidth: 3).padding(-5)
                                }
                            }
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(Text(Self.palette[i].name))
                    .accessibilityAddTraits(colorIndex == i ? .isSelected : [])
                }
            } else {
                Text("가린 부분은 복원할 수 없어요")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            Spacer()
            Button {
                if !items.isEmpty { items.removeLast() }
            } label: {
                Image(systemName: "arrow.uturn.backward")
            }
            .disabled(items.isEmpty)
            .accessibilityLabel("되돌리기")
            Button(role: .destructive) {
                items.removeAll()
            } label: {
                Image(systemName: "trash")
            }
            .disabled(items.isEmpty)
            .accessibilityLabel("모두 지우기")
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 12)
        .background(.bar)
    }

    private func toolButton(_ t: Tool, icon: String, label: LocalizedStringKey) -> some View {
        Button {
            tool = t
            if t == .blur { ensurePixellated() }
        } label: {
            Image(systemName: icon)
                .frame(width: 36, height: 30)
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

    // MARK: - 드로잉

    private func drawGesture(fit: CGRect) -> some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { value in
                switch tool {
                case .pen:
                    guard let p = imagePoint(value.location, fit: fit) else { return }
                    if current == nil {
                        current = AnnotationStroke(points: [p], colorIndex: colorIndex)
                    } else {
                        current?.points.append(p)
                    }
                case .blur:
                    guard let a = imagePoint(value.startLocation, fit: fit),
                          let b = imagePoint(value.location, fit: fit) else { return }
                    currentBlur = CGRect(
                        x: min(a.x, b.x),
                        y: min(a.y, b.y),
                        width: abs(a.x - b.x),
                        height: abs(a.y - b.y),
                    )
                }
            }
            .onEnded { _ in
                switch tool {
                case .pen:
                    if let s = current { items.append(.stroke(s)) }
                    current = nil
                case .blur:
                    if let r = currentBlur, r.width >= Self.minBlurSide, r.height >= Self.minBlurSide {
                        items.append(.blur(r))
                    }
                    currentBlur = nil
                }
            }
    }

    /// 뷰 좌표 → 이미지 픽셀 좌표. 이미지 영역 밖이면 가장자리로 클램프 (획이 끊기지 않게).
    private func imagePoint(_ p: CGPoint, fit: CGRect) -> CGPoint? {
        guard fit.width > 0, fit.height > 0 else { return nil }
        let scale = baseImage.size.width / fit.width
        let x = min(max(p.x - fit.minX, 0), fit.width) * scale
        let y = min(max(p.y - fit.minY, 0), fit.height) * scale
        return CGPoint(x: x, y: y)
    }

    /// 이미지 픽셀 rect → 뷰 좌표 rect.
    private func viewRect(_ r: CGRect, fit: CGRect, scale: CGFloat) -> CGRect {
        CGRect(
            x: fit.minX + r.minX * scale,
            y: fit.minY + r.minY * scale,
            width: r.width * scale,
            height: r.height * scale,
        )
    }

    /// 블러 영역 미리보기 — 합성에 쓸 픽셀화 사본을 같은 rect 로 클립해 그린다 (보이는 대로 저장).
    /// 사본이 아직 없으면(드물게 첫 프레임) 반투명 검정으로 영역만 표시.
    private func drawBlurs(in ctx: inout GraphicsContext, fit: CGRect, scale: CGFloat) {
        var path = Path()
        for case .blur(let r) in items { path.addRect(viewRect(r, fit: fit, scale: scale)) }
        if let r = currentBlur { path.addRect(viewRect(r, fit: fit, scale: scale)) }
        guard !path.isEmpty else { return }
        if let pix = pixellated {
            ctx.drawLayer { layer in
                layer.clip(to: path)
                layer.draw(Image(uiImage: pix), in: fit)
            }
        } else {
            ctx.fill(path, with: .color(.black.opacity(0.55)))
        }
        if let r = currentBlur {
            // 드래그 중인 영역 윤곽 — 어디까지 가려지는지 보이게.
            ctx.stroke(
                Path(viewRect(r, fit: fit, scale: scale)),
                with: .color(Theme.accent),
                style: StrokeStyle(lineWidth: 1.5, dash: [5, 3]),
            )
        }
    }

    private func draw(_ stroke: AnnotationStroke, in ctx: inout GraphicsContext, fit: CGRect, scale: CGFloat) {
        let color = Color(Self.palette[stroke.colorIndex % Self.palette.count].ui)
        let width = Self.penWidth(for: baseImage.size) * scale
        let pts = stroke.points.map { CGPoint(x: fit.minX + $0.x * scale, y: fit.minY + $0.y * scale) }
        guard let first = pts.first else { return }
        if pts.count < 2 {
            // 탭 한 번 = 점 찍기.
            let dot = CGRect(x: first.x - width / 2, y: first.y - width / 2, width: width, height: width)
            ctx.fill(Path(ellipseIn: dot), with: .color(color))
            return
        }
        var path = Path()
        path.move(to: first)
        for p in pts.dropFirst() { path.addLine(to: p) }
        ctx.stroke(path, with: .color(color), style: StrokeStyle(lineWidth: width, lineCap: .round, lineJoin: .round))
    }

    /// 펜 굵기 (이미지 픽셀 단위) — 이미지 크기에 비례해 어떤 해상도에서도 비슷한 시각 비중.
    private static func penWidth(for size: CGSize) -> CGFloat {
        max(max(size.width, size.height) / 160, 4)
    }

    /// scaledToFit 과 동일한 배치 계산 — 드로잉 좌표 변환에 같은 rect 를 쓰기 위해 직접 계산.
    private static func fitRect(image: CGSize, in container: CGSize) -> CGRect {
        guard image.width > 0, image.height > 0, container.width > 0, container.height > 0 else {
            return .zero
        }
        let scale = min(container.width / image.width, container.height / image.height)
        let size = CGSize(width: image.width * scale, height: image.height * scale)
        return CGRect(
            x: (container.width - size.width) / 2,
            y: (container.height - size.height) / 2,
            width: size.width,
            height: size.height,
        )
    }

    // MARK: - 픽셀화 (블러)

    private func ensurePixellated() {
        guard pixellated == nil else { return }
        pixellated = Self.pixellate(baseImage)
    }

    /// 블록 크기 (이미지 픽셀) — 1568px 장변 기준 ≈33px. 블록 하나가 평균색 하나로만 남아
    /// 토큰·이메일 같은 텍스트를 복원할 수 없다.
    private static func pixelBlockSize(for size: CGSize) -> CGFloat {
        max(max(size.width, size.height) / 48, 16)
    }

    /// 베이스 전체를 CIPixellate 로 픽셀화한 사본. 미리보기와 합성이 이 사본을 같은 rect 로
    /// 잘라 쓰므로 결과가 항상 일치한다.
    private static func pixellate(_ base: UIImage) -> UIImage {
        guard let cg = base.cgImage else { return base }
        let input = CIImage(cgImage: cg)
        let output = input
            .clampedToExtent() // 가장자리 블록이 extent 밖을 샘플해 비치는 것 방지.
            .applyingFilter("CIPixellate", parameters: [
                kCIInputScaleKey: pixelBlockSize(for: base.size),
                kCIInputCenterKey: CIVector(x: 0, y: 0),
            ])
            .cropped(to: input.extent)
        let context = CIContext()
        guard let rendered = context.createCGImage(output, from: input.extent) else { return base }
        return UIImage(cgImage: rendered)
    }

    // MARK: - 저장 (베이스 + 주석 합성 → draft 갱신)

    private func save() {
        var updated = draft
        if items.isEmpty {
            // 주석을 전부 지웠으면 원본으로 복원.
            if let bi = draft.baseImage, let bd = draft.baseData {
                updated.image = bi
                updated.data = bd
            }
            updated.baseImage = nil
            updated.baseData = nil
            updated.annotations = []
        } else {
            let base = baseImage
            ensurePixellated()
            let rendered = Self.render(base: base, pixellated: pixellated, items: items)
            guard let jpeg = rendered.jpegData(compressionQuality: 0.8) else {
                dismiss()
                return
            }
            updated.baseImage = base
            updated.baseData = draft.baseData ?? draft.data
            updated.image = rendered
            updated.data = jpeg
            updated.annotations = items
        }
        onSave(updated)
        dismiss()
    }

    private static func render(base: UIImage, pixellated: UIImage?, items: [AnnotationItem]) -> UIImage {
        let fmt = UIGraphicsImageRendererFormat.default()
        fmt.scale = 1 // base.size 가 이미 픽셀 크기 (AttachmentDraft.make 와 동일 규약).
        fmt.opaque = false
        let width = penWidth(for: base.size)
        let bounds = CGRect(origin: .zero, size: base.size)
        return UIGraphicsImageRenderer(size: base.size, format: fmt).image { ctx in
            base.draw(in: bounds)
            // 1) 블러 — 픽셀화 사본을 영역만 잘라 원본 해상도에 굽는다. 획보다 먼저(아래에).
            let blurRects = items.compactMap { item -> CGRect? in
                if case .blur(let r) = item { return r } else { return nil }
            }
            if !blurRects.isEmpty {
                let pix = pixellated ?? pixellate(base)
                for r in blurRects {
                    let clipped = r.integral.intersection(bounds)
                    guard !clipped.isEmpty, let crop = pix.cgImage?.cropping(to: clipped) else { continue }
                    UIImage(cgImage: crop).draw(in: clipped)
                }
            }
            // 2) 펜 획.
            let cg = ctx.cgContext
            cg.setLineCap(.round)
            cg.setLineJoin(.round)
            cg.setLineWidth(width)
            for case .stroke(let stroke) in items {
                let color = palette[stroke.colorIndex % palette.count].ui
                guard let first = stroke.points.first else { continue }
                if stroke.points.count < 2 {
                    cg.setFillColor(color.cgColor)
                    let dot = CGRect(x: first.x - width / 2, y: first.y - width / 2, width: width, height: width)
                    cg.fillEllipse(in: dot)
                    continue
                }
                cg.setStrokeColor(color.cgColor)
                cg.beginPath()
                cg.move(to: first)
                for p in stroke.points.dropFirst() { cg.addLine(to: p) }
                cg.strokePath()
            }
        }
    }
}
