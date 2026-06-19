import SwiftUI
import UIKit

/// 줌/팬 가능한 미러링 캔버스 (UIScrollView 기반) + **통합 트랙패드** 제어.
///
/// 콘텐츠는 두 가지 — **H.264** 는 `MirrorVideoView`(AVSampleBufferDisplayLayer 백킹, GPU 렌더)에
/// renderer 가 직접 enqueue 하고, **JPEG 폴백**(옛 daemon)은 그 위 UIImageView 로 그린다. 둘은
/// 한 줌 컨테이너 안에 겹쳐 있고 활성 코덱만 보인다 — 줌/팬 로직은 하나로 공유.
///
/// ## 통합 트랙패드 모델 (모드 전환 없음 — 맥 트랙패드와 동일 멘탈모델)
/// 헬퍼는 «절대좌표» 만 받으므로(capture-helper `toPoint`), iOS 가 **가상 커서**(현재 ROI 기준
/// 0..1)를 들고 1손가락 드래그 델타를 가속해 누적·클램프한 뒤 절대 `move` 를 보낸다. 어디를
/// 클릭할지 보이도록 화면에 커서 링(인디케이터)을 그린다 — 네트워크 지연으로 늦는 Mac 실제 커서 보완.
///
/// - **1손가락 드래그**: 커서 상대 이동(가속). 느리면 1:1 정밀, 빠르면 멀리.
/// - **1손가락 탭**: 커서 위치 클릭. 빠른 연속 탭 → 더블/트리플.
/// - **탭 직후 눌러 드래그(tap-and-a-half)**: 드래그락(버튼 누른 채 이동 — 텍스트 선택·창 이동).
/// - **2손가락 탭**: 우클릭.
/// - **2손가락 드래그 — 전체 보기**: 스크롤 휠. **확대(줌/ROI) 중**: 확대 뷰포트 패닝(→ROI 갱신).
/// - **핀치**: 확대/축소(하이브리드 D — 정착 시 가시영역을 native 해상도 ROI 로 받는다).
///
/// 좌표는 줌 transform 과 aspect-fit 레터박스를 모두 흡수해 콘텐츠 기준 0..1 로 정규화한다.
struct ZoomableScreenView: UIViewRepresentable {
    /// H.264 렌더러 — 디스플레이 레이어에 직접 enqueue. 컨트롤 좌표 정규화에 videoSize 사용.
    let renderer: MirrorRenderer
    /// JPEG 폴백 프레임(h264 일 땐 nil) — nil 이 아니면 UIImageView 로 표시하고 video 레이어는 가린다.
    let jpegImage: UIImage?
    let controlEnabled: Bool
    /// 현재 서버 ROI(전체화면 기준 0..1). 전체면 {0,0,1,1}. 전체화면 외곽선 + 축소 허용 판단에 쓴다.
    let roi: CGRect
    /// 포맷(해상도) 변경 토큰 — 새 videoSize 로 외곽선·커서를 다시 그리고 커서를 새 ROI 에 재정합.
    let formatToken: Int
    /// 줌>1 여부 — SwiftUI 측 리셋 버튼 노출용(코디네이터가 갱신).
    @Binding var isZoomed: Bool
    /// 증가시키면 1x 로 리셋(리셋 버튼이 토글).
    let resetToken: Int
    /// 증가시키면 가상 커서를 화면 중앙(0.5,0.5)으로 재중앙 — 명시적 리셋·디스플레이 전환 시.
    let recenterToken: Int
    /// 트랙패드 감도(가속 기본 gain). 1.0 = 1:1, 클수록 빠름.
    let sensitivity: Double
    /// 끌기 잠금 «무장» — 컨트롤 바 토글. true 면 1손가락 드래그가 tap-and-a-half 타이밍 없이
    /// 즉시 «버튼 누른 채 끌기» 로 시작한다(텍스트 선택·창 이동의 모터 접근성). 무장/홀드 중엔
    /// 커서 링이 accent 로 바뀌어 상태가 드러난다.
    let dragLockArmed: Bool
    /// 스크롤 모드 «무장» — 컨트롤 바 토글. true 면 1손가락 드래그가 커서 이동/드래그락 대신
    /// «스크롤 휠» 이 된다(2손가락 스크롤이 어려운 사용자용 모터 접근성 — 한 손가락으로 스크롤).
    /// 탭=클릭은 그대로라 «탭으로 누르고, 한 손가락으로 스크롤» 의 읽기 모드가 된다. 끌기 잠금과
    /// «상호 배타» — 둘 다 1손가락 드래그의 «의미» 를 바꾸므로 상위 토글이 한 번에 하나만 켠다.
    let scrollModeArmed: Bool
    /// 2손가락 드래그의 «현재 의미» — 화면 HUD 로 노출(none/스크롤/패닝). 줌은 외곽선이 담당하므로
    /// 여기선 다루지 않는다. 코디네이터가 제스처 시작/종료에만 갱신(프레임당 body 재평가 방지).
    @Binding var twoFingerHint: TwoFingerHint
    /// 단일/더블/트리플 클릭 — clickState(1~3)를 함께. 빠른 연속 탭이 2,3 으로 올라간다.
    let onClick: (CGFloat, CGFloat, Int) -> Void
    /// 우클릭 — 두 손가락 탭.
    let onRightClick: (CGFloat, CGFloat) -> Void
    let onMove: (CGFloat, CGFloat) -> Void
    let onScrollDelta: (CGFloat, CGFloat) -> Void
    /// 스크롤 드래그 종료 — 누적된 스크롤 잔여를 즉시 보내도록(throttle 에 막힌 마지막 구간).
    let onScrollEnd: () -> Void
    /// 드래그락 — 버튼 누름(시작)/이동(드래그)/뗌(종료). 커서 위치로 전송.
    let onDragBegin: (CGFloat, CGFloat) -> Void
    let onDragMove: (CGFloat, CGFloat) -> Void
    let onDragEnd: (CGFloat, CGFloat) -> Void
    /// 줌이 정착(제스처 종료 후 잠시)하고 임계 배율을 넘으면 — 현재 콘텐츠 기준 가시영역(0..1)을
    /// 콜백. 하이브리드 D: 상위가 서버에 ROI 를 요청해 그 영역을 native 해상도로 받는다.
    let onROIRequest: (CGRect) -> Void

    static let fullRect = CGRect(x: 0, y: 0, width: 1, height: 1)
    /// ROI 활성(전체가 아님) — 1x 미만 축소 허용 + 팬/외곽선 노출 게이트.
    var roiActive: Bool { roi != Self.fullRect }

    /// 2손가락 드래그가 지금 무엇을 하는지 — 전체 보기=스크롤, 확대 중=뷰포트 패닝(화면 이동).
    /// 「현재 isMagnified 모드만으로 조용히 갈리던」 의미를 화면 HUD 로 드러내기 위한 상태.
    /// 확대 영역 전송(ROI crop) ON/OFF 와 무관 — «의미» 는 동일하다(로컬 디지털 줌도 같은 표시).
    enum TwoFingerHint: Equatable { case none, scroll, pan }

    func makeUIView(context: Context) -> UIScrollView {
        let sv = UIScrollView()
        sv.delegate = context.coordinator
        sv.minimumZoomScale = 1
        sv.maximumZoomScale = 5
        sv.bouncesZoom = true
        sv.showsVerticalScrollIndicator = false
        sv.showsHorizontalScrollIndicator = false
        sv.backgroundColor = .black
        sv.contentInsetAdjustmentBehavior = .never
        // 스크롤뷰 내장 팬은 «확대 중에만» 2손가락(로컬 패닝→정착 시 ROI 갱신). 전체 보기에선
        // 3손가락으로 올려 사실상 비활성화하고, 2손가락 드래그는 아래 scrollPan(스크롤 휠)로 보낸다.
        // (updateUIView 가 isMagnified 에 따라 minimumNumberOfTouches 를 2↔3 으로 토글.)
        sv.panGestureRecognizer.minimumNumberOfTouches = 3

        // 줌 대상 컨테이너 = H.264 비디오 뷰(백킹 레이어가 AVSampleBufferDisplayLayer).
        let video = MirrorVideoView()
        video.backgroundColor = .black
        video.isUserInteractionEnabled = true
        renderer.attach(video.displayLayer)
        sv.addSubview(video)

        // JPEG 폴백 — 비디오 뷰 위에 겹치는 이미지뷰(터치는 통과시켜 제스처가 비디오 뷰로).
        let iv = UIImageView()
        iv.contentMode = .scaleAspectFit
        iv.backgroundColor = .clear
        iv.isUserInteractionEnabled = false
        iv.isHidden = true
        video.addSubview(iv)

        // 전체화면 외곽선 — 콘텐츠(비디오) 레이어 위 sublayer 라 줌/팬과 함께 변환된다. ROI 로 확대
        // 시엔 이 박스가 뷰포트보다 커서 화면 밖(안 보임), 축소하면 들어와 «전체 범위» 를 안내.
        // 핀치 줌 «진행 중» 에만 표시 — 평상시엔 콘텐츠를 가리지 않게 숨긴다.
        let outline = CAShapeLayer()
        outline.fillColor = UIColor.clear.cgColor
        outline.strokeColor = UIColor.white.withAlphaComponent(0.7).cgColor
        outline.lineWidth = 2
        outline.lineDashPattern = [8, 5]
        outline.isHidden = true
        video.layer.addSublayer(outline)

        // 가상 커서 인디케이터 — 콘텐츠 레이어 위 sublayer(줌/팬 변환 자동 상속). 흰 링 + 그림자
        // 로 밝은/어두운 배경 모두에서 보이게. 위치는 updateCursorLayer 가 정규화 좌표로 환산.
        let cursor = Self.makeCursorLayer()
        video.layer.addSublayer(cursor)

        context.coordinator.scrollView = sv
        context.coordinator.videoView = video
        context.coordinator.imageView = iv
        context.coordinator.boundsOutline = outline
        context.coordinator.cursorLayer = cursor

        let tap = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.onTap(_:)))
        video.addGestureRecognizer(tap)

        // 1손가락 드래그 = 커서 상대 이동(또는 드래그락).
        let drag = UIPanGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.onDrag(_:)))
        drag.minimumNumberOfTouches = 1
        drag.maximumNumberOfTouches = 1
        drag.delegate = context.coordinator
        video.addGestureRecognizer(drag)

        // 우클릭 — 두 손가락 «탭»(움직임 없는 빠른 1회). 핀치/스크롤(움직임 있음)과 구분된다.
        let rightTap = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.onRightTap(_:)))
        rightTap.numberOfTouchesRequired = 2
        rightTap.numberOfTapsRequired = 1
        rightTap.delegate = context.coordinator
        video.addGestureRecognizer(rightTap)

        // 2손가락 드래그 = 스크롤 휠 — «전체 보기» 에서만(확대 중엔 ShouldBegin 이 막고 내장 팬이 패닝).
        let scrollPan = UIPanGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.onScrollPan(_:)))
        scrollPan.minimumNumberOfTouches = 2
        scrollPan.maximumNumberOfTouches = 2
        scrollPan.delegate = context.coordinator
        video.addGestureRecognizer(scrollPan)
        context.coordinator.scrollPanRecognizer = scrollPan

        return sv
    }

    func updateUIView(_ sv: UIScrollView, context: Context) {
        let c = context.coordinator
        c.parent = self
        // ROI 활성 중엔 1x 미만 핀치-아웃 허용(축소=ROI 넓히기, 0.3 까지 한 번에 멀리). 전체면 1x 하한.
        let minZoom: CGFloat = roiActive ? 0.3 : 1
        if sv.minimumZoomScale != minZoom { sv.minimumZoomScale = minZoom }
        // 2손가락 드래그 분기: 확대 중이면 내장 팬(패닝), 전체 보기면 scrollPan(스크롤).
        let desiredTouches = c.isMagnified ? 2 : 3
        if sv.panGestureRecognizer.minimumNumberOfTouches != desiredTouches {
            sv.panGestureRecognizer.minimumNumberOfTouches = desiredTouches
        }
        // JPEG 폴백 표시 — 이미지가 있으면 보이고(비디오 레이어 가림), 없으면 숨김(h264).
        if let iv = c.imageView {
            if iv.image !== jpegImage { iv.image = jpegImage }
            iv.isHidden = (jpegImage == nil)
        }
        // 콘텐츠 뷰를 scrollview bounds 로(zoom=1 기준). 줌 중엔 건드리지 않는다.
        if let v = c.videoView, sv.bounds.size != .zero,
           sv.zoomScale == 1, v.frame.size != sv.bounds.size {
            v.frame = CGRect(origin: .zero, size: sv.bounds.size)
            c.imageView?.frame = v.bounds
            sv.contentSize = sv.bounds.size
        }
        if c.lastResetToken != resetToken {
            c.lastResetToken = resetToken
            // 즉시 전환(애니메이션 없음) — 핸드오프 때 «줌 줄어들며 잘림» 이 어색해 그 자리에서
            // 바로 선명해지게. 리셋 버튼도 스냅.
            sv.setZoomScale(1, animated: false)
        }
        // 포맷(ROI 핸드오프 등) 변경 → 커서를 새 ROI 에 재정합(정규화 값 유지, 위치만 재계산 + move 1회).
        if c.lastFormatToken != formatToken {
            c.lastFormatToken = formatToken
            c.reanchorCursor()
        }
        // 명시적 리셋·디스플레이 전환 → 커서 재중앙.
        if c.lastRecenterToken != recenterToken {
            c.lastRecenterToken = recenterToken
            c.recenterCursor()
        }
        c.updateBoundsOutline()
        c.updateCursorLayer()
        c.updateCursorAppearance() // dragLockArmed 토글 시 무장/중립 링 재칠.
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    /// 가상 커서 인디케이터 레이어 — 흰 링(중앙 빈) + 그림자. 위치는 position 으로 옮긴다.
    private static func makeCursorLayer() -> CAShapeLayer {
        let size: CGFloat = 26
        let layer = CAShapeLayer()
        layer.bounds = CGRect(x: 0, y: 0, width: size, height: size)
        let inset: CGFloat = 3
        layer.path = UIBezierPath(ovalIn: CGRect(x: inset, y: inset, width: size - inset * 2, height: size - inset * 2)).cgPath
        layer.fillColor = UIColor.white.withAlphaComponent(0.18).cgColor
        layer.strokeColor = UIColor.white.cgColor
        layer.lineWidth = 2
        layer.shadowColor = UIColor.black.cgColor
        layer.shadowOpacity = 0.55
        layer.shadowRadius = 2.5
        layer.shadowOffset = .zero
        layer.isHidden = true
        return layer
    }

    final class Coordinator: NSObject, UIScrollViewDelegate, UIGestureRecognizerDelegate {
        var parent: ZoomableScreenView
        weak var scrollView: UIScrollView?
        weak var videoView: MirrorVideoView?
        weak var imageView: UIImageView?
        weak var boundsOutline: CAShapeLayer?
        weak var cursorLayer: CAShapeLayer?
        weak var scrollPanRecognizer: UIPanGestureRecognizer?
        var lastResetToken: Int
        var lastFormatToken = 0
        var lastRecenterToken = 0
        /// 가상 커서 — 현재 ROI 기준 정규화 좌표(0..1). 1손가락 드래그가 누적, 탭/우클릭/드래그락의 좌표원.
        private var cursor = CGPoint(x: 0.5, y: 0.5)
        /// 1손가락 드래그 누적 translation(이전 값) — 증분 계산용.
        private var panLast: CGPoint = .zero
        /// 2손가락 스크롤 누적 translation(이전 값).
        private var scrollLast: CGPoint = .zero
        /// 더블/트리플 클릭 판정 — 직전 탭 시각/클릭수(커서 고정이라 위치는 무관).
        private var lastTapTime: Date = .distantPast
        private var lastClickState = 1
        /// tap-and-a-half 드래그락 — 탭 직후 누름이 드래그로 이어지면 버튼 홀드.
        private var lastTapEndTime: Date = .distantPast
        private var inDragLock = false

        // MARK: 전체 보기 2손가락 우세판정 (핀치 vs 스크롤)
        /// 한 입력을 둘로 나누지 않는다 — 방향 우세 + 히스테리시스로 «하나» 로 확정한다.
        private enum TwoFingerLock { case undecided, scroll, zoom }
        private var twoFingerLock: TwoFingerLock = .undecided
        /// 스크롤로 확정되면 부수적 줌을 억제하려고 핀치를 비활성화하기 직전의 배율(복원용).
        private var pinchStartScale: CGFloat = 1
        /// 핀치(줌) 종료 시각 — 직후 잔여 2손가락 이동이 스크롤로 새지 않게 grace 에 쓴다.
        private var zoomEndedAt: Date = .distantPast
        /// SwiftUI 로 마지막에 올린 2손가락 의미 — 바뀔 때만 바인딩에 써 body 재평가를 아낀다.
        private var lastHint: TwoFingerHint = .none
        /// 커서 링에 마지막으로 적용한 외형(0=중립·1=무장·2=홀드) — 변할 때만 다시 칠한다.
        private var lastCursorAppearance = -1

        /// 팬/줌 커밋 임계 + 히스테리시스 데드존. 둘 다 넘으면 «자기 임계 대비 더 많이 넘은» 쪽이 이긴다.
        /// 임계 미만(작은 떨림)은 어느 쪽도 확정하지 않아 스크롤도 줌도 튀지 않는다.
        private static let panCommitThreshold: CGFloat = 16     // pt — 이만큼 끌어야 스크롤로 확정
        private static let zoomCommitThreshold: CGFloat = 0.12  // 12% 배율 변화라야 줌으로 확정
        /// 핀치 종료 직후 이 시간 동안은 스크롤 확정에 더 큰 팬을 요구(잔여 이동 누수 방지).
        private static let twoFingerGrace: TimeInterval = 0.35

        init(_ p: ZoomableScreenView) {
            parent = p
            lastResetToken = p.resetToken
            lastFormatToken = p.formatToken
            lastRecenterToken = p.recenterToken
        }

        func viewForZooming(in sv: UIScrollView) -> UIView? { videoView }

        /// 확대 상태 — 줌>1 이거나 ROI 활성(native 크롭 후 줌=1 이어도 «확대됨»). 2손가락 의미 분기에 쓴다.
        var isMagnified: Bool {
            let z = scrollView?.zoomScale ?? 1
            return z > 1.01 || parent.roiActive
        }

        func scrollViewDidZoom(_ sv: UIScrollView) {
            // 줌된 콘텐츠를 화면 중앙에 — 작을 땐 inset 으로 «양쪽» 다 가운데, 클 땐 0. inset 을 한쪽
            // (top/left)만 주면 콘텐츠가 모서리로 쏠리고 반대쪽으론 경계 없이 밀려나 «원점을 잃는»
            // 단초가 된다 — 두 축 모두 대칭으로 줘야 항상 정중앙에 고정된다.
            guard let v = videoView else { return }
            let ox = max(0, (sv.bounds.width - v.frame.width) / 2)
            let oy = max(0, (sv.bounds.height - v.frame.height) / 2)
            sv.contentInset = UIEdgeInsets(top: oy, left: ox, bottom: oy, right: ox)
            let zoomed = sv.zoomScale > 1.01
            if parent.isZoomed != zoomed { parent.isZoomed = zoomed }
            updateBoundsOutline()
            updateCursorLayer()
        }

        // MARK: 줌 정착 → ROI 요청 (하이브리드 D)

        /// 줌/팬 제스처 종료 → 디바운스 후 정착 판정. 임계 배율 이상이면 가시영역을 ROI 로 요청.
        private static let roiZoomThreshold: CGFloat = 1.5
        private static let roiZoomOutThreshold: CGFloat = 0.8
        private static let settleDelay: TimeInterval = 0.45
        private var settleWork: DispatchWorkItem?

        /// 핀치 줌 진행 중 — 외곽선은 이 동안에만 표시.
        private var isZooming = false

        func scrollViewWillBeginZooming(_ sv: UIScrollView, with view: UIView?) {
            isZooming = true
            if lastHint == .pan { pushHint(.none) } // 줌이 시작되면 패닝 HUD 양보 — 외곽선이 담당.
            updateBoundsOutline()
        }

        func scrollViewDidEndZooming(_ sv: UIScrollView, with view: UIView?, atScale scale: CGFloat) {
            isZooming = false
            zoomEndedAt = Date() // 직후 잔여 2손가락 이동의 스크롤 누수 방지(grace).
            updateBoundsOutline()
            scheduleSettle()
        }
        /// 확대 중 2손가락 드래그 = 뷰포트 패닝(내장 팬). 그 «의미» 를 HUD 로 노출한다.
        /// (전체 보기에선 내장 팬이 3손가락이라 여긴 안 걸리고, 2손가락 스크롤은 onScrollPan 이 표시.)
        func scrollViewWillBeginDragging(_ sv: UIScrollView) {
            if isMagnified { pushHint(.pan) }
        }
        func scrollViewDidEndDragging(_ sv: UIScrollView, willDecelerate decelerate: Bool) {
            if lastHint == .pan { pushHint(.none) }
            if !decelerate { scheduleSettle() }
        }
        func scrollViewDidEndDecelerating(_ sv: UIScrollView) { scheduleSettle() }

        private func scheduleSettle() {
            settleWork?.cancel()
            let work = DispatchWorkItem { [weak self] in self?.settle() }
            settleWork = work
            DispatchQueue.main.asyncAfter(deadline: .now() + Self.settleDelay, execute: work)
        }

        private func settle() {
            guard let sv = scrollView else { return }
            let z = sv.zoomScale
            if z >= Self.roiZoomThreshold {
                // 확대 정착 — 더 좁은 ROI 요청(가시영역 < 콘텐츠).
                if let r = visibleContentRect() { parent.onROIRequest(r) }
            } else if z <= Self.roiZoomOutThreshold {
                // 축소 정착 — 더 넓은 ROI 요청(가시영역 > 콘텐츠, 거의 전체면 상위가 해제).
                if let r = visibleContentRect() { parent.onROIRequest(r) }
            } else if z < 0.999 {
                // 축소 데드존(0.8~1.0) — ROI 변경 없이 1x 로 스냅백(레터박스 잔상 방지).
                sv.setZoomScale(1, animated: true)
            }
        }

        /// 현재 가시영역을 콘텐츠(비디오/이미지) 기준 rect 로. 줌 transform + aspect-fit 흡수.
        /// 축소(z<1) 시엔 [0,1] 을 벗어날 수 있다(콘텐츠보다 넓게 봄) — 상위가 합성/클램프한다.
        private func visibleContentRect() -> CGRect? {
            guard let sv = scrollView, let v = videoView, let cs = contentSize else { return nil }
            // 스크롤뷰 가시 bounds → videoView(zoom=1) 좌표 = 줌/오프셋 흡수된 가시영역.
            let vis = sv.convert(sv.bounds, to: v)
            let b = v.bounds.size
            guard b.width > 0, b.height > 0, cs.width > 0, cs.height > 0 else { return nil }
            let scale = min(b.width / cs.width, b.height / cs.height)
            let dw = cs.width * scale, dh = cs.height * scale
            guard dw > 0, dh > 0 else { return nil }
            let ox = (b.width - dw) / 2, oy = (b.height - dh) / 2
            let nx = (vis.minX - ox) / dw, ny = (vis.minY - oy) / dh
            let nw = vis.width / dw, nh = vis.height / dh
            return CGRect(x: nx, y: ny, width: nw, height: nh)
        }

        /// 활성 콘텐츠의 픽셀 크기 — JPEG 면 이미지 크기, H.264 면 renderer.videoSize.
        private var contentSize: CGSize? {
            if let img = parent.jpegImage { return img.size }
            let v = parent.renderer.videoSize
            return (v.width > 0 && v.height > 0) ? v : nil
        }

        /// 레터박스된 콘텐츠 표시 크기(videoView zoom=1 좌표). 커서/스크롤 정규화의 분모.
        private func displayedContentSize() -> (dw: CGFloat, dh: CGFloat, ox: CGFloat, oy: CGFloat)? {
            guard let v = videoView, let cs = contentSize else { return nil }
            let b = v.bounds.size
            guard b.width > 0, b.height > 0, cs.width > 0, cs.height > 0 else { return nil }
            let scale = min(b.width / cs.width, b.height / cs.height)
            let dw = cs.width * scale, dh = cs.height * scale
            return (dw, dh, (b.width - dw) / 2, (b.height - dh) / 2)
        }

        private static func clamp01(_ v: CGFloat) -> CGFloat { max(0, min(1, v)) }

        // MARK: - 가상 커서

        /// 커서 인디케이터를 현재 정규화 좌표 위치로 갱신(콘텐츠 레이어 좌표). 콘텐츠/제어 없으면 숨김.
        func updateCursorLayer() {
            guard let layer = cursorLayer else { return }
            guard parent.controlEnabled, let geo = displayedContentSize() else {
                if !layer.isHidden { layer.isHidden = true }
                return
            }
            let px = geo.ox + cursor.x * geo.dw
            let py = geo.oy + cursor.y * geo.dh
            // 콘텐츠 레이어 sublayer 라 줌 변환을 상속한다 — 역배율로 화면상 크기를 일정하게.
            // (crop 전송 OFF 의 상시 로컬 줌, ROI 핸드오프 전 임시 줌, ROI 축소(z<1) 모두.)
            let z = scrollView?.zoomScale ?? 1
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            layer.position = CGPoint(x: px, y: py)
            if z > 0 { layer.transform = CATransform3DMakeScale(1 / z, 1 / z, 1) }
            layer.isHidden = false
            CATransaction.commit()
        }

        /// ROI 핸드오프 후 — 정규화 값은 그대로 두고(화면상 대략 같은 자리) 위치 재계산 + move 1회로
        /// 헬퍼 커서를 새 ROI 기준 같은 정규화 좌표에 정합(옛 절대 위치 잔상 제거).
        func reanchorCursor() {
            updateCursorLayer()
            if parent.controlEnabled { parent.onMove(cursor.x, cursor.y) }
        }

        /// 명시적 리셋·디스플레이 전환 — 커서를 중앙으로.
        func recenterCursor() {
            cursor = CGPoint(x: 0.5, y: 0.5)
            updateCursorLayer()
        }

        // MARK: - 제스처

        @objc func onTap(_ g: UITapGestureRecognizer) {
            guard parent.controlEnabled else { return }
            // 빠른 연속 탭이면 clickState 증가(1→2→3) → macOS 가 더블/트리플 클릭으로 인식.
            // 커서가 고정이라 위치 비교는 불필요 — 시간만으로 판정(트랙패드 더블탭과 동일).
            let now = Date()
            if now.timeIntervalSince(lastTapTime) < 0.4 {
                lastClickState = min(3, lastClickState + 1)
            } else {
                lastClickState = 1
            }
            lastTapTime = now
            lastTapEndTime = now // 드래그락 윈도우 시작.
            parent.onClick(cursor.x, cursor.y, lastClickState)
        }

        @objc func onRightTap(_ g: UITapGestureRecognizer) {
            guard parent.controlEnabled else { return }
            parent.onRightClick(cursor.x, cursor.y)
        }

        /// 1손가락 드래그 — 커서 상대 이동(가속) 또는 드래그락(탭 직후 누름→드래그).
        @objc func onDrag(_ g: UIPanGestureRecognizer) {
            guard parent.controlEnabled, let v = videoView else { return }
            // 스크롤 모드 — 1손가락 드래그를 스크롤 휠로(2손가락 스크롤과 동일 경로·감각). 커서 이동·
            // 드래그락 대신 이 경로로 빠지고, 탭(클릭)은 그대로라 «탭=클릭, 끌기=스크롤» 의 읽기 모드가 된다.
            if parent.scrollModeArmed {
                handleScrollDrag(g, in: v)
                return
            }
            switch g.state {
            case .began:
                panLast = .zero
                // 「끌기 잠금」 무장(타이밍 불필요한 명시 경로)이거나, tap-and-a-half(직전 탭 종료 후
                // 0.35s 내 누름)면 버튼을 누른 채 시작 — 둘 다 같은 드래그락으로 합류한다.
                if parent.dragLockArmed || Date().timeIntervalSince(lastTapEndTime) < 0.35 {
                    inDragLock = true
                    parent.onDragBegin(cursor.x, cursor.y)
                    updateCursorAppearance() // 홀드 링(accent 채움)으로 전환.
                    announceDrag(active: true)
                } else {
                    inDragLock = false
                }
            case .changed:
                let t = g.translation(in: v)
                let dx = t.x - panLast.x
                let dy = t.y - panLast.y
                panLast = t
                guard let geo = displayedContentSize(), geo.dw > 0, geo.dh > 0 else { break }
                // 가속 — 느린 이동은 1:1(정밀), 빠른 플릭은 멀리. 맥 트랙패드 곡선의 단순화.
                let speed = hypot(dx, dy)
                let gain = parent.sensitivity * (1.0 + 0.035 * min(speed, 45))
                cursor.x = Self.clamp01(cursor.x + (dx * gain) / geo.dw)
                cursor.y = Self.clamp01(cursor.y + (dy * gain) / geo.dh)
                updateCursorLayer()
                if inDragLock {
                    parent.onDragMove(cursor.x, cursor.y)
                } else {
                    parent.onMove(cursor.x, cursor.y)
                }
            default:
                if inDragLock {
                    // 항상 up 전송(버튼 끼임 방지) — 커서 마지막 위치로. 무장이 켜져 있어도 손가락을
                    // 들면 매번 up — 끼임 없는 «누르고-끌고-떼기» 한 번이 되고, 무장은 다음 드래그를 위해 유지.
                    parent.onDragEnd(cursor.x, cursor.y)
                    inDragLock = false
                    updateCursorAppearance() // 무장(켜짐) 또는 중립 링으로 복귀.
                    announceDrag(active: false)
                }
                panLast = .zero
            }
        }

        /// 스크롤 모드의 1손가락 드래그 — 증분 translation 을 스크롤 휠 델타로 보낸다. 2손가락
        /// 스크롤과 «같은» onScrollDelta/onScrollEnd 경로라 방향·감도·누적이 그대로 동일하다.
        /// 제스처 동안 «스크롤» HUD 를 띄워(2손가락 스크롤과 같은 표시) 동작을 확인시킨다.
        private func handleScrollDrag(_ g: UIPanGestureRecognizer, in v: UIView) {
            switch g.state {
            case .began:
                panLast = .zero
                pushHint(.scroll)
            case .changed:
                let t = g.translation(in: v)
                parent.onScrollDelta(t.x - panLast.x, t.y - panLast.y)
                panLast = t
            default:
                parent.onScrollEnd()
                panLast = .zero
                pushHint(.none)
            }
        }

        /// 끌기 활성/해제를 VoiceOver 로 안내(미실행이면 no-op). 토글 라벨과 함께 모터 접근성 보완 —
        /// 정밀 타이밍 없이도 «지금 끌고 있다» 를 음성으로 확인할 수 있게.
        private func announceDrag(active: Bool) {
            let msg = active ? String(localized: "끌기 시작") : String(localized: "끌기 끝")
            UIAccessibility.post(notification: .announcement, argument: msg)
        }

        /// 2손가락 드래그(전체 보기) — 스크롤 휠. 핀치와 «한 입력» 을 공유하므로 무조건 버리지 않고
        /// (옛 hard-drop 제거), 방향 우세 + 히스테리시스로 스크롤/줌 하나로 «확정» 한다. 확정 전엔
        /// 어느 쪽도 안 보내(데드존) 작은 떨림에 둘 다 안 튄다.
        @objc func onScrollPan(_ g: UIPanGestureRecognizer) {
            guard parent.controlEnabled, let v = videoView, let sv = scrollView else { return }
            switch g.state {
            case .began:
                scrollLast = .zero
                twoFingerLock = .undecided
                pinchStartScale = sv.zoomScale
            case .changed:
                let t = g.translation(in: v)
                switch twoFingerLock {
                case .undecided:
                    decideTwoFinger(t, sv)
                case .scroll:
                    parent.onScrollDelta(t.x - scrollLast.x, t.y - scrollLast.y)
                    scrollLast = t
                case .zoom:
                    break // 줌으로 확정 — 스크롤 억제(핀치가 줌을 담당). 외곽선이 인디케이터.
                }
            default:
                if twoFingerLock == .scroll { parent.onScrollEnd() }
                // 스크롤 확정 때 막았던 핀치를 복원(이외엔 이미 켜져 있어 무해).
                sv.pinchGestureRecognizer?.isEnabled = true
                twoFingerLock = .undecided
                scrollLast = .zero
                pushHint(.none)
            }
        }

        /// 전체 보기 2손가락 제스처의 핀치↔스크롤 우세판정. 팬 이동량과 핀치 배율 변화를 각자 임계로
        /// 정규화해, «자기 임계 대비 더 많이 넘은» 쪽이 이긴다(둘 다 임계 미만이면 미확정=데드존).
        ///  - 줌 우세: 스크롤을 억제(핀치가 그대로 줌). → 작은 핀치 떨림에 스크롤이 안 먹힌다.
        ///  - 스크롤 우세: 부수적 줌을 억제(핀치 비활성 + 시작 배율 복원) → 작은 2손가락 이동에 줌이 안 튄다.
        private func decideTwoFinger(_ t: CGPoint, _ sv: UIScrollView) {
            let panDist = hypot(t.x, t.y)
            let zoomDev = abs((sv.pinchGestureRecognizer?.scale ?? 1) - 1)
            // 핀치 종료 직후 grace — 잔여 이동이 스크롤로 새지 않게 더 큰 팬을 요구.
            let panNeeded = Date().timeIntervalSince(zoomEndedAt) < Self.twoFingerGrace
                ? Self.panCommitThreshold * 2.5 : Self.panCommitThreshold
            let panOver = panDist / panNeeded
            let zoomOver = zoomDev / Self.zoomCommitThreshold
            if zoomOver >= 1, zoomOver >= panOver {
                twoFingerLock = .zoom
            } else if panOver >= 1 {
                twoFingerLock = .scroll
                if let pinch = sv.pinchGestureRecognizer, pinch.isEnabled { pinch.isEnabled = false }
                if abs(sv.zoomScale - pinchStartScale) > 0.001 { sv.setZoomScale(pinchStartScale, animated: false) }
                scrollLast = t // 데드존 이동은 버린다(스크롤 점프 방지).
                pushHint(.scroll)
            }
        }

        /// 2손가락 의미 인디케이터를 SwiftUI 로 — «값이 바뀔 때만» 써서 제스처 중 불필요한 body 재평가를 막는다.
        private func pushHint(_ h: TwoFingerHint) {
            guard lastHint != h else { return }
            lastHint = h
            parent.twoFingerHint = h
        }

        /// 커서 링 외형 — 무장/홀드 시 Theme.accent 로 채워 «끌기» 상태를 드러낸다(리터럴 색 없이 토큰).
        /// 0=중립(흰 링)·1=무장(accent 링)·2=홀드(accent 채움 + onAccent 링). 변할 때만 다시 칠한다.
        func updateCursorAppearance() {
            guard let layer = cursorLayer else { return }
            let state = inDragLock ? 2 : (parent.dragLockArmed ? 1 : 0)
            guard state != lastCursorAppearance else { return }
            lastCursorAppearance = state
            let accent = UIColor(Theme.accent)
            let onAccent = UIColor(Theme.onAccent)
            let badge = CGFloat(Theme.Opacity.badge)
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            switch state {
            case 2: // 홀드(드래그 중) — accent 채움 + onAccent(흰) 링: 「붙잡았다」.
                layer.fillColor = accent.cgColor
                layer.strokeColor = onAccent.cgColor
            case 1: // 무장(켜짐, 대기) — accent 링 + 옅은 accent 채움: 「준비됨」.
                layer.fillColor = accent.withAlphaComponent(badge).cgColor
                layer.strokeColor = accent.cgColor
            default: // 중립 — 흰 링(밝/어두운 배경 모두 보이게 그림자 동반).
                layer.fillColor = onAccent.withAlphaComponent(badge).cgColor
                layer.strokeColor = onAccent.cgColor
            }
            CATransaction.commit()
        }

        /// 전체화면 외곽선 갱신 — 현재 ROI(+videoSize 레터박스) 기준 «전체 화면» 사각형을 콘텐츠
        /// 좌표로 그린다. ROI 로 확대하면 박스가 뷰포트보다 커서 화면 밖, 축소하면 들어와 전체 범위
        /// 를 보여준다. 전체(ROI=full)면 숨김. sublayer 라 줌/팬 변환은 자동.
        /// «핀치 줌 진행 중» 에만 표시 — 줌이 끝난 평상시엔 콘텐츠를 가리지 않게 숨긴다.
        func updateBoundsOutline() {
            guard let v = videoView, let outline = boundsOutline else { return }
            let roi = parent.roi
            let cs = parent.renderer.videoSize
            let b = v.bounds.size
            guard parent.roiActive, isZooming, b.width > 0, b.height > 0, cs.width > 0, cs.height > 0,
                  roi.width > 0, roi.height > 0 else {
                outline.isHidden = true
                return
            }
            // 레터박스된 콘텐츠 rect(videoView 좌표) — ROI 가 여기에 그려진다.
            let scale = min(b.width / cs.width, b.height / cs.height)
            let dw = cs.width * scale, dh = cs.height * scale
            let ox = (b.width - dw) / 2, oy = (b.height - dh) / 2
            // 전체 화면 = ROI 를 1/ROI 로 확대한 것(콘텐츠 단위).
            let fullRect = CGRect(
                x: ox - (roi.minX / roi.width) * dw,
                y: oy - (roi.minY / roi.height) * dh,
                width: dw / roi.width,
                height: dh / roi.height,
            )
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            outline.frame = v.bounds
            outline.path = UIBezierPath(rect: fullRect).cgPath
            outline.isHidden = false
            CATransaction.commit()
        }

        /// 1손가락 제어 드래그가 스크롤뷰 자체 제스처와 동시 인식되게(서로 막지 않게).
        func gestureRecognizer(
            _ g: UIGestureRecognizer,
            shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer,
        ) -> Bool {
            true
        }

        /// scrollPan(2손가락 스크롤)은 «전체 보기 + 제어 가능» 일 때만 시작 — 확대 중엔 내장 팬이 패닝.
        func gestureRecognizerShouldBegin(_ g: UIGestureRecognizer) -> Bool {
            if g === scrollPanRecognizer { return parent.controlEnabled && !isMagnified }
            return true
        }
    }
}
