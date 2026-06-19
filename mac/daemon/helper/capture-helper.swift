// capture-helper — Pocket Sisyphus 네이티브 화면 캡처 + 원격 입력 주입 헬퍼.
//
// daemon(Node)이 tor/sshd 처럼 자식 프로세스로 spawn 한다. 캡처는 두 코덱을 지원한다:
//   - jpeg (기본/폴백): CGDisplayCreateImage → 다운스케일 → 프레임마다 JPEG. 옛 iOS 호환.
//   - h264 (고fps): ScreenCaptureKit(SCStream) → VideoToolbox H.264 인코딩(델타 프레임).
//     정지 화면이 거의 0바이트라 같은 대역폭에 훨씬 높은 fps. iOS 가 screen_h264_v1 지원 시 daemon
//     이 config 로 codec="h264" 를 지정한다.
// 입력 주입(CGEvent)은 코덱과 무관하게 stdin 명령으로 동작.
//
// ## stdio 프로토콜 (daemon ↔ 헬퍼)
//   - stdout: 길이-prefix 바이너리 프레임. [4바이트 BE 길이][payload] 반복.
//       jpeg: payload = JPEG 바이트.
//       h264: payload = [1바이트 타입][...]. 타입 1=파라미터셋([2B spsLen][sps][2B ppsLen][pps]),
//             타입 2=액세스유닛([1B keyframe][AVCC NAL: 4바이트 길이-prefix]),
//             타입 3=오디오 설정([4B BE sampleRate][1B channels][2B BE cookieLen][magic cookie]),
//             타입 4=AAC 패킷(raw AAC-LC 1개). 오디오는 h264+audio 활성 시에만.
//   - stdin : 줄 단위(\n) JSON 명령 (config / move / click / ... / text / key / targets).
//       {"cmd":"config","fps":12,"quality":0.6,"maxDim":1280,"display":0,"codec":"h264","bitrate":4000000,"audio":true}
//       window 키(CGWindowID, 0=해제)로 «창 단위» 캡처 — SCContentFilter(desktopIndependentWindow:).
//       display 키가 오면 창 타겟은 자동 해제(전체 화면 복귀). {"cmd":"targets"} 는 창 목록 재보고 요청.
//   - stderr: 사람용 로그 + `__PS_DISPLAYS__ <json>` (디스플레이 목록)
//       + `__PS_WINDOWS__ <json>` (화면에 보이는 창 목록 — 캡처 대상 피커용)
//       + `__PS_TARGET__ {"window":N[,"reason":"window_closed"]}` (현재 캡처 대상 변경/폴백 보고).
//
// ## 권한 (TCC) — 화면 기록(Screen Recording) + 손쉬운 사용(Accessibility). 메인 앱 책임 프로세스 기준.

import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
import ScreenCaptureKit
import VideoToolbox
import CoreMedia
import AVFoundation     // AVAudioConverter — 시스템 오디오 AAC 인코딩
import IOKit            // kIOReturnSuccess
import IOKit.pwr_mgt    // IOPMAssertion* — 미러링 동안 디스플레이 켜두기 + 깨우기
import ApplicationServices // AXIsProcessTrusted — 손쉬운 사용(원격 제어) TCC 라이브 조회

// MARK: - 디스플레이

struct DisplayInfo {
    let index: Int
    let id: CGDirectDisplayID
    let main: Bool
    let width: Int
    let height: Int
}

func activeDisplays() -> [DisplayInfo] {
    var count: UInt32 = 0
    CGGetActiveDisplayList(0, nil, &count)
    guard count > 0 else { return [] }
    var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
    CGGetActiveDisplayList(count, &ids, &count)
    let main = CGMainDisplayID()
    let sorted = ids.sorted { a, b in
        if (a == main) != (b == main) { return a == main }
        return a < b
    }
    return sorted.enumerated().map { i, id in
        let b = CGDisplayBounds(id)
        return DisplayInfo(index: i, id: id, main: id == main, width: Int(b.width), height: Int(b.height))
    }
}

// MARK: - 창 (캡처 대상)

/// 화면에 보이는 «일반» 창 한 개 — 캡처 대상 피커 항목. id 는 CGWindowID (선택 키).
struct WindowInfo {
    let id: UInt32
    let app: String
    let title: String
    let width: Int
    let height: Int
}

/// 화면에 보이는 창 목록 — CGWindowList (동기, SCK XPC 불필요). layer 0(일반 창)만,
/// 너무 작은 것(팝오버/툴팁)과 자기 자신은 제외. 앞쪽(z-order 상위)부터 최대 24개.
/// 창 «제목» 은 화면 기록 TCC 가 있어야 보인다 — 헬퍼는 캡처 권한 전제라 대부분 채워진다.
func onScreenWindows() -> [WindowInfo] {
    guard let list = CGWindowListCopyWindowInfo(
        [.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]
    else { return [] }
    let myPid = Int(getpid())
    var out: [WindowInfo] = []
    for w in list {
        guard out.count < 24 else { break }
        guard (w[kCGWindowLayer as String] as? Int) == 0,
              let num = (w[kCGWindowNumber as String] as? NSNumber)?.uint32Value,
              let pid = (w[kCGWindowOwnerPID as String] as? NSNumber)?.intValue, pid != myPid,
              let app = w[kCGWindowOwnerName as String] as? String, !app.isEmpty,
              let bDict = w[kCGWindowBounds as String] as? [String: Any],
              let b = CGRect(dictionaryRepresentation: bDict as CFDictionary),
              b.width >= 160, b.height >= 120,
              ((w[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1) > 0.05
        else { continue }
        let title = (w[kCGWindowName as String] as? String) ?? ""
        out.append(WindowInfo(id: num, app: app, title: title, width: Int(b.width), height: Int(b.height)))
    }
    return out
}

/// 창의 현재 글로벌 bounds(points, 주 디스플레이 좌상단 원점 — CGDisplayBounds/CGEvent 와 동일
/// 좌표계). 창이 닫혔으면 nil — 감시 스레드의 «닫힘 → 전체 화면 폴백» 신호.
func windowBounds(_ id: UInt32) -> CGRect? {
    guard let list = CGWindowListCopyWindowInfo([.optionIncludingWindow], CGWindowID(id)) as? [[String: Any]],
          let info = list.first,
          let bDict = info[kCGWindowBounds as String] as? [String: Any],
          let b = CGRect(dictionaryRepresentation: bDict as CFDictionary),
          b.width > 1, b.height > 1
    else { return nil }
    return b
}

/// 창이 걸친 디스플레이의 point→pixel 배율 (Retina 흡수) — 창 중심이 속한 디스플레이 기준.
func displayScale(forWindowAt bounds: CGRect) -> Double {
    let center = CGPoint(x: bounds.midX, y: bounds.midY)
    var id = CGMainDisplayID()
    for d in activeDisplays() where CGDisplayBounds(d.id).contains(center) { id = d.id; break }
    let b = CGDisplayBounds(id)
    guard b.width > 0 else { return 2 }
    return Double(CGDisplayPixelsWide(id)) / Double(b.width)
}

/// 창 목록을 stderr 태그로 보고 — sidecar 가 파싱해 capture_windows 로 iOS 에 전달.
func emitWindowList() {
    let arr: [[String: Any]] = onScreenWindows().map {
        ["id": $0.id, "app": $0.app, "title": $0.title, "width": $0.width, "height": $0.height]
    }
    guard let data = try? JSONSerialization.data(withJSONObject: arr),
          let json = String(data: data, encoding: .utf8) else { return }
    FileHandle.standardError.write(Data(("__PS_WINDOWS__ " + json + "\n").utf8))
}

/// 현재 캡처 대상 변경/폴백 보고 — sidecar 가 capture_target 으로 전달해 iOS 선택 상태를 동기화.
/// reason="window_closed" 면 iOS 가 «창이 닫혀 전체 화면으로 돌아왔어요» 캡슐을 띄운다.
func reportTarget(window: UInt32, reason: String? = nil) {
    let r = reason.map { ",\"reason\":\"\($0)\"" } ?? ""
    FileHandle.standardError.write(Data(("__PS_TARGET__ {\"window\":\(window)\(r)}\n").utf8))
}

// MARK: - 설정 / 상태

final class Config {
    var fps: Double = 2.0
    var quality: Double = 0.6
    /// 캡처 프레임 긴 변 최대 픽셀. 0=원본. SSH 채널 대역폭(=안정성) 때문에 작게 유지.
    var maxDim: Int = 1280
    /// "jpeg" | "h264".
    var codec: String = "jpeg"
    /// h264 평균 비트레이트(bps).
    var bitrate: Int = 4_000_000
    /// 시스템 오디오 캡처(h264 전용) — SCStream capturesAudio + AAC 송출.
    var audio: Bool = false
    private let displays: [DisplayInfo]
    private var displayIdx: Int = 0
    /// 창 단위 캡처 대상(CGWindowID) — 0 이면 디스플레이 전체. 설정되면 SCK 필터가
    /// desktopIndependentWindow 로 바뀌고 ROI 는 쉰다(창 자체가 이미 «관심영역»).
    private var windowID: UInt32 = 0
    /// 캡처 관심영역(ROI) — 디스플레이 기준 정규화 사각형(0..1). 전체면 {0,0,1,1}. 줌 시 iOS 가
    /// 보는 영역만 native 해상도로 받기 위해(하이브리드 D) sourceRect + 입력 좌표 매핑에 쓴다.
    private var roi = CGRect(x: 0, y: 0, width: 1, height: 1)
    let lock = NSLock()

    init() { self.displays = activeDisplays() }

    var displayID: CGDirectDisplayID {
        lock.lock(); defer { lock.unlock() }
        guard !displays.isEmpty else { return CGMainDisplayID() }
        return displays[min(displayIdx, displays.count - 1)].id
    }

    var displaysJSON: String {
        let items = displays.map {
            "{\"index\":\($0.index),\"main\":\($0.main ? "true" : "false"),\"width\":\($0.width),\"height\":\($0.height)}"
        }
        return "[" + items.joined(separator: ",") + "]"
    }

    func set(fps: Double?, quality: Double?, maxDim: Int?, display: Int?, codec: String?, bitrate: Int?, audio: Bool? = nil, window: Int? = nil) {
        lock.lock(); defer { lock.unlock() }
        if let f = fps { self.fps = max(0.2, min(60.0, f)) }
        if let q = quality { self.quality = max(0.2, min(0.95, q)) }
        if let m = maxDim { self.maxDim = m <= 0 ? 0 : max(320, min(4096, m)) }
        // 디스플레이 «명시» 선택 = 전체 화면 모드 — 창 타겟 자동 해제. (적응 루프의 fps/bitrate
        // 만 담긴 config 는 display 키가 없어 창 타겟을 건드리지 않는다.)
        if let d = display, d >= 0, d < displays.count { self.displayIdx = d; self.windowID = 0 }
        if let c = codec, c == "jpeg" || c == "h264" { self.codec = c }
        if let b = bitrate { self.bitrate = max(200_000, min(50_000_000, b)) }
        if let a = audio { self.audio = a }
        if let w = window { self.windowID = w > 0 ? UInt32(w) : 0 }
    }

    var snapshot: (fps: Double, quality: Double, maxDim: Int, displayID: CGDirectDisplayID) {
        lock.lock(); defer { lock.unlock() }
        let id = displays.isEmpty ? CGMainDisplayID() : displays[min(displayIdx, displays.count - 1)].id
        return (fps, quality, maxDim, id)
    }
    var codecSnapshot: String { lock.lock(); defer { lock.unlock() }; return codec }
    var windowSnapshot: UInt32 { lock.lock(); defer { lock.unlock() }; return windowID }
    var bitrateSnapshot: Int { lock.lock(); defer { lock.unlock() }; return bitrate }
    var audioSnapshot: Bool { lock.lock(); defer { lock.unlock() }; return audio }
    var roiSnapshot: CGRect { lock.lock(); defer { lock.unlock() }; return roi }

    /// ROI 설정 — nil 이면 전체로 리셋. 정규화 좌표를 [0,1] + 최소 크기(0.05)로 클램프.
    func setROI(_ r: CGRect?) {
        lock.lock(); defer { lock.unlock() }
        guard let r else { roi = CGRect(x: 0, y: 0, width: 1, height: 1); return }
        let w = min(1, max(0.05, r.width))
        let h = min(1, max(0.05, r.height))
        let x = min(1 - w, max(0, r.minX))
        let y = min(1 - h, max(0, r.minY))
        roi = CGRect(x: x, y: y, width: w, height: h)
    }

    /// h264 출력 픽셀 크기 — ROI 픽셀 크기의 긴 변을 maxDim 으로(0이면 네이티브). 짝수(인코더 요구).
    /// ROI 가 작을수록 같은 maxDim 예산이 좁은 영역에 집중 → 네이티브에 가까운 디테일.
    /// 창 모드면 «창의 현재 크기» 가 소스 — 같은 maxDim 예산이 창에만 집중돼 전체 화면보다 선명하다.
    func h264Size(for id: CGDirectDisplayID) -> (Int, Int) {
        let win = windowSnapshot
        if win != 0, let b = windowBounds(win) {
            let scale = displayScale(forWindowAt: b)
            var w = Double(b.width) * scale
            var h = Double(b.height) * scale
            let md = maxDim
            if md > 0, max(w, h) > Double(md) {
                let s = Double(md) / max(w, h)
                w *= s
                h *= s
            }
            return (max(64, Int(w.rounded()) & ~1), max(64, Int(h.rounded()) & ~1))
        }
        let pxW = CGDisplayPixelsWide(id), pxH = CGDisplayPixelsHigh(id)
        guard pxW > 0, pxH > 0 else { return (1280, 720) }
        let r = roiSnapshot
        let roiW = Double(pxW) * Double(r.width)
        let roiH = Double(pxH) * Double(r.height)
        let md = maxDim
        var w = roiW, h = roiH
        if md > 0, max(roiW, roiH) > Double(md) {
            let scale = Double(md) / max(roiW, roiH)
            w = roiW * scale
            h = roiH * scale
        }
        return (Int(w.rounded()) & ~1, Int(h.rounded()) & ~1)
    }
}

let config = Config()
let stdoutHandle = FileHandle.standardOutput

func logErr(_ s: String) {
    FileHandle.standardError.write(Data(("[capture-helper] " + s + "\n").utf8))
}

// MARK: - 프레임 출력 (길이-prefix)

let writeLock = NSLock()
func writeFrame(_ data: Data) {
    writeLock.lock(); defer { writeLock.unlock() }
    var len = UInt32(data.count).bigEndian
    let header = withUnsafeBytes(of: &len) { Data($0) }
    do {
        try stdoutHandle.write(contentsOf: header)
        try stdoutHandle.write(contentsOf: data)
    } catch {
        exit(0)  // stdout 닫힘 = daemon 이 정리 중.
    }
}

/// h264 타입드 메시지 — [4B len][1B type][payload]. type 1=파라미터셋, 2=액세스유닛.
func writeTyped(_ type: UInt8, _ payload: Data) {
    var msg = Data([type])
    msg.append(payload)
    writeFrame(msg)
}

// MARK: - JPEG 인코딩 (폴백)

func jpegData(_ image: CGImage, quality: Double) -> Data? {
    let out = NSMutableData()
    let type = UTType.jpeg.identifier as CFString
    guard let dest = CGImageDestinationCreateWithData(out, type, 1, nil) else { return nil }
    let opts: [CFString: Any] = [kCGImageDestinationLossyCompressionQuality: quality]
    CGImageDestinationAddImage(dest, image, opts as CFDictionary)
    guard CGImageDestinationFinalize(dest) else { return nil }
    return out as Data
}

func downscaled(_ image: CGImage, maxDim: Int) -> CGImage {
    guard maxDim > 0 else { return image }
    let w = image.width, h = image.height
    guard max(w, h) > maxDim else { return image }
    let scale = Double(maxDim) / Double(max(w, h))
    let nw = max(1, Int((Double(w) * scale).rounded())), nh = max(1, Int((Double(h) * scale).rounded()))
    let cs = CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB()
    guard let ctx = CGContext(data: nil, width: nw, height: nh, bitsPerComponent: 8, bytesPerRow: 0,
                              space: cs, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    else { return image }
    ctx.interpolationQuality = .medium
    ctx.draw(image, in: CGRect(x: 0, y: 0, width: nw, height: nh))
    return ctx.makeImage() ?? image
}

func captureLoopJPEG() {
    while true {
        let (fps, quality, maxDim, displayID) = config.snapshot
        let intervalNs = UInt64(1_000_000_000.0 / fps)
        if let image = CGDisplayCreateImage(displayID) {
            if let data = jpegData(downscaled(image, maxDim: maxDim), quality: quality) {
                writeFrame(data)
            }
        }
        if intervalNs > 0 {
            var ts = timespec(tv_sec: Int(intervalNs / 1_000_000_000), tv_nsec: Int(intervalNs % 1_000_000_000))
            nanosleep(&ts, nil)
        }
    }
}

// MARK: - H.264 인코더 (VideoToolbox)

/// VTCompressionSession 콜백 — refcon 으로 H264Encoder 를 되찾아 인코딩 결과를 stdout 으로.
let h264OutputCallback: VTCompressionOutputCallback = { refcon, _, status, _, sampleBuffer in
    guard status == noErr, let sampleBuffer, let refcon else { return }
    Unmanaged<H264Encoder>.fromOpaque(refcon).takeUnretainedValue().emit(sampleBuffer)
}

final class H264Encoder {
    private var session: VTCompressionSession?

    func setup(width: Int, height: Int, fps: Int, bitrate: Int) -> Bool {
        var s: VTCompressionSession?
        let st = VTCompressionSessionCreate(
            allocator: kCFAllocatorDefault,
            width: Int32(width), height: Int32(height),
            codecType: kCMVideoCodecType_H264,
            encoderSpecification: nil, imageBufferAttributes: nil, compressedDataAllocator: nil,
            outputCallback: h264OutputCallback,
            refcon: Unmanaged.passUnretained(self).toOpaque(),
            compressionSessionOut: &s)
        guard st == noErr, let session = s else { logErr("VTCompressionSessionCreate 실패 \(st)"); return false }
        self.session = session
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AllowFrameReordering, value: kCFBooleanFalse)
        // High 프로파일 — 같은 비트레이트에서 Main 대비 압축 효율↑ = 화면 텍스트가 더 선명.
        // realtime + B-frame 없음은 유지(저지연). 디코더는 High 도 하드웨어 지원.
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_ProfileLevel, value: kVTProfileLevel_H264_High_AutoLevel)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AverageBitRate, value: NSNumber(value: bitrate))
        // 키프레임은 비트 스파이크 → SSH 버퍼 혼잡 → daemon backoff 의 트리거가 된다. 라이브
        // 스트림이라 시킹이 필요 없으니 주기를 길게(8초) — 손실 복구는 iOS 재구독 시 새 키프레임으로.
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_MaxKeyFrameInterval, value: NSNumber(value: max(1, fps) * 8))
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration, value: NSNumber(value: 8.0))
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_ExpectedFrameRate, value: NSNumber(value: fps))
        // 버스트 상한 — 평균은 AverageBitRate 가 잡지만 키프레임/장면전환 순간 버스트가 SSH 채널을
        // 막는다. 1초 창에서 평균의 1.5배로 제한해 송출을 평탄화(부드러움 = 균일한 프레임 간격).
        setDataRateLimit(session, bitrate: bitrate)
        // 화면 캡처는 «제때 나오는 프레임» 이 화질보다 우선 — 30fps 에서 인코드 지연이 프레임을
        // 밀리게 하지 않도록 속도 우선(미지원 인코더면 no-op 에러, 무해).
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_PrioritizeEncodingSpeedOverQuality, value: kCFBooleanTrue)
        VTCompressionSessionPrepareToEncodeFrames(session)
        return true
    }

    /// 1초 창 기준 버스트 상한(평균 ×1.5) — setup 과 라이브 bitrate 변경이 같이 쓴다.
    private func setDataRateLimit(_ session: VTCompressionSession, bitrate: Int) {
        let bytesPerSec = NSNumber(value: Double(bitrate) * 1.5 / 8.0)
        let limits = [bytesPerSec, NSNumber(value: 1.0)] as CFArray
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_DataRateLimits, value: limits)
    }

    func encode(_ pixelBuffer: CVPixelBuffer, pts: CMTime) {
        guard let session else { return }
        VTCompressionSessionEncodeFrame(session, imageBuffer: pixelBuffer, presentationTimeStamp: pts,
                                        duration: .invalid, frameProperties: nil, sourceFrameRefcon: nil, infoFlagsOut: nil)
    }

    /// 동적 적응 — 평균 비트레이트만 라이브 변경(재시작/키프레임 없이 다음 프레임부터 적용).
    /// 버스트 상한(DataRateLimits)도 새 평균에 맞춰 같이 갱신한다.
    func setBitrate(_ bitrate: Int) {
        guard let session else { return }
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AverageBitRate, value: NSNumber(value: bitrate))
        setDataRateLimit(session, bitrate: bitrate)
    }

    /// 세션 종료 — 콜백 큐의 in-flight 프레임을 «동기» 로 비우고(CompleteFrames) Invalidate 한 뒤
    /// 세션 참조를 비운다. Invalidate 가 반환된 뒤엔 outputCallback 이 다시 불리지 않음이 보장되므로,
    /// 그 다음에 H264Encoder 를 해제하면 콜백이 «해제된 self(passUnretained)» 를 retain 하던
    /// use-after-free 가 사라진다. 반드시 `encoder = nil` 직전에, 인코더가 아직 살아있을 때 호출한다.
    /// (인코딩 큐와 동일 스레드에서 호출 — emit 은 writeLock 만 잡고 그 큐에 재진입 안 해 deadlock 없음.)
    func invalidate() {
        guard let session else { return }
        self.session = nil
        VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: .invalid)
        VTCompressionSessionInvalidate(session)
    }

    fileprivate func emit(_ sb: CMSampleBuffer) {
        var keyframe = true
        if let atts = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[CFString: Any]],
           let first = atts.first, let notSync = first[kCMSampleAttachmentKey_NotSync] as? Bool {
            keyframe = !notSync
        }
        if keyframe { emitParamSets(sb) }
        guard let block = CMSampleBufferGetDataBuffer(sb) else { return }
        var len = 0
        var ptr: UnsafeMutablePointer<Int8>?
        guard CMBlockBufferGetDataPointer(block, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &len, dataPointerOut: &ptr) == noErr,
              let ptr, len > 0 else { return }
        var payload = Data([keyframe ? 1 : 0])
        payload.append(Data(bytes: ptr, count: len))
        writeTyped(2, payload)
    }

    private func emitParamSets(_ sb: CMSampleBuffer) {
        guard let fmt = CMSampleBufferGetFormatDescription(sb) else { return }
        func paramSet(_ i: Int) -> Data? {
            var p: UnsafePointer<UInt8>?
            var sz = 0, cnt = 0
            guard CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
                fmt, parameterSetIndex: i, parameterSetPointerOut: &p, parameterSetSizeOut: &sz,
                parameterSetCountOut: &cnt, nalUnitHeaderLengthOut: nil) == noErr, let p else { return nil }
            return Data(bytes: p, count: sz)
        }
        guard let sps = paramSet(0), let pps = paramSet(1) else { return }
        var payload = Data()
        var spsLen = UInt16(sps.count).bigEndian
        payload.append(Data(bytes: &spsLen, count: 2)); payload.append(sps)
        var ppsLen = UInt16(pps.count).bigEndian
        payload.append(Data(bytes: &ppsLen, count: 2)); payload.append(pps)
        writeTyped(1, payload)
    }
}

// MARK: - 시스템 오디오 AAC 인코더 (h264 + audio)

/// SCStream 오디오 샘플(48kHz float32 PCM)을 AAC-LC 로 압축해 타입 3(설정)/4(패킷)로 송출.
/// 설정(타입 3)은 2초마다 재송출 — 스트림 도중 합류/재구독한 iOS 디코더도 초기화되게
/// (비디오의 키프레임 파라미터셋 재송출과 같은 이유). 수십 바이트라 비용 무시 가능.
final class AACEncoder {
    private var converter: AVAudioConverter?
    private var inASBD = AudioStreamBasicDescription()
    private var lastConfigEmit = Date.distantPast

    func encode(_ sb: CMSampleBuffer) {
        let frames = CMSampleBufferGetNumSamples(sb)
        guard frames > 0,
              let fmtDesc = CMSampleBufferGetFormatDescription(sb),
              let asbdPtr = CMAudioFormatDescriptionGetStreamBasicDescription(fmtDesc) else { return }
        if converter == nil || memcmp(&inASBD, asbdPtr, MemoryLayout<AudioStreamBasicDescription>.size) != 0 {
            guard rebuild(asbdPtr.pointee) else { return }
        }
        guard let conv = converter,
              let pcm = AVAudioPCMBuffer(pcmFormat: conv.inputFormat, frameCapacity: AVAudioFrameCount(frames)) else { return }
        pcm.frameLength = AVAudioFrameCount(frames)
        guard CMSampleBufferCopyPCMDataIntoAudioBufferList(
            sb, at: 0, frameCount: Int32(frames), into: pcm.mutableAudioBufferList) == noErr else { return }

        // 1024 프레임/패킷 — 입력 프레임 수 기준 여유 있게. 남는 입력은 컨버터가 내부 버퍼링.
        let out = AVAudioCompressedBuffer(
            format: conv.outputFormat,
            packetCapacity: AVAudioPacketCount(frames / 1024 + 2),
            maximumPacketSize: conv.maximumOutputPacketSize)
        var fed = false
        var convErr: NSError?
        let status = conv.convert(to: out, error: &convErr) { _, outStatus in
            if fed { outStatus.pointee = .noDataNow; return nil }
            fed = true
            outStatus.pointee = .haveData
            return pcm
        }
        guard status != .error else {
            logErr("AAC convert 실패: \(convErr?.localizedDescription ?? "?")"); return
        }
        emit(out)
    }

    private func rebuild(_ src: AudioStreamBasicDescription) -> Bool {
        var srcCopy = src
        guard let inFmt = AVAudioFormat(streamDescription: &srcCopy) else {
            logErr("오디오 입력 포맷 생성 실패"); return false
        }
        var outDesc = AudioStreamBasicDescription(
            mSampleRate: src.mSampleRate > 0 ? src.mSampleRate : 48000,
            mFormatID: kAudioFormatMPEG4AAC,
            mFormatFlags: 0, mBytesPerPacket: 0, mFramesPerPacket: 1024,
            mBytesPerFrame: 0,
            mChannelsPerFrame: min(2, max(1, src.mChannelsPerFrame)),
            mBitsPerChannel: 0, mReserved: 0)
        guard let outFmt = AVAudioFormat(streamDescription: &outDesc),
              let conv = AVAudioConverter(from: inFmt, to: outFmt) else {
            logErr("AAC 컨버터 생성 실패"); return false
        }
        conv.bitRate = 128_000
        converter = conv
        inASBD = src
        lastConfigEmit = .distantPast  // 새 포맷 — 설정 즉시 재송출.
        return true
    }

    /// 타입 3 — [4B BE sampleRate][1B channels][2B BE cookieLen][magic cookie]. 2초마다.
    private func maybeEmitConfig() {
        guard Date().timeIntervalSince(lastConfigEmit) >= 2, let conv = converter else { return }
        let sr = UInt32(conv.outputFormat.sampleRate)
        let ch = UInt8(conv.outputFormat.channelCount)
        let cookie = conv.magicCookie ?? Data()
        var payload = Data()
        var srBE = sr.bigEndian
        payload.append(Data(bytes: &srBE, count: 4))
        payload.append(ch)
        var ckLen = UInt16(cookie.count).bigEndian
        payload.append(Data(bytes: &ckLen, count: 2))
        payload.append(cookie)
        writeTyped(3, payload)
        lastConfigEmit = Date()
    }

    private func emit(_ buf: AVAudioCompressedBuffer) {
        let count = Int(buf.packetCount)
        guard count > 0, let descs = buf.packetDescriptions else { return }
        maybeEmitConfig()
        for i in 0..<count {
            let d = descs[i]
            guard d.mDataByteSize > 0 else { continue }
            let pkt = Data(bytes: buf.data.advanced(by: Int(d.mStartOffset)), count: Int(d.mDataByteSize))
            writeTyped(4, pkt)
        }
    }
}

/// 현재 ROI → SCStreamConfiguration.sourceRect(디스플레이 기준 points). 전체면 .zero(=전체 기본).
func roiSourceRect(for displayID: CGDirectDisplayID) -> CGRect {
    let r = config.roiSnapshot
    if r == CGRect(x: 0, y: 0, width: 1, height: 1) { return .zero }
    let b = CGDisplayBounds(displayID)
    return CGRect(x: r.minX * b.width, y: r.minY * b.height, width: r.width * b.width, height: r.height * b.height)
}

// MARK: - ScreenCaptureKit 캡처 엔진 (h264)

final class CaptureEngine: NSObject, SCStreamDelegate, SCStreamOutput {
    private var stream: SCStream?
    private var encoder: H264Encoder?
    /// 시스템 오디오 AAC 인코더 — config.audio 활성 시에만 생성. 영상과 같은 stdout 으로 송출.
    private var audioEncoder: AACEncoder?
    private let queue = DispatchQueue(label: "pe.wayne.capture.scstream")
    private let audioQueue = DispatchQueue(label: "pe.wayne.capture.audio")
    /// 현재 캡처 픽셀 크기 — applyRate 의 updateConfiguration 이 같은 해상도로 재구성하는 데 필요.
    private var curW = 0
    private var curH = 0
    /// 현재 스트림의 오디오 활성 여부 — config.audio 변경 감지(다르면 reconfigure 필요).
    private(set) var audioActive = false

    func start() {
        let (fps, _, _, displayID) = config.snapshot
        let bitrate = config.bitrateSnapshot
        let wantAudio = config.audioSnapshot
        SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: false) { [weak self] content, error in
            guard let self else { return }
            guard let content, error == nil else {
                logErr("SCShareableContent 실패: \(error?.localizedDescription ?? "?")"); return
            }
            // 창 타겟 — SCWindow 를 못 찾으면(이미 닫힘 등) 전체 화면으로 폴백하고 iOS 에 보고.
            var winID = config.windowSnapshot
            var scWindow: SCWindow?
            if winID != 0 {
                scWindow = content.windows.first(where: { $0.windowID == winID })
                if scWindow == nil {
                    config.set(fps: nil, quality: nil, maxDim: nil, display: nil, codec: nil, bitrate: nil, window: 0)
                    reportTarget(window: 0, reason: "window_closed")
                    winID = 0
                }
            }
            let filter: SCContentFilter
            if let scWindow {
                // 창 단위 캡처 — 이동/리사이즈는 SCK 가 따라간다(해상도 변화는 감시 스레드가 재구성).
                filter = SCContentFilter(desktopIndependentWindow: scWindow)
            } else {
                guard let scDisplay = content.displays.first(where: { $0.displayID == displayID }) ?? content.displays.first else {
                    logErr("SCDisplay 없음"); return
                }
                filter = SCContentFilter(display: scDisplay, excludingWindows: [])
            }
            // 출력 크기는 «유효 타겟 확정 후» 계산 — 창 모드면 창 크기, 아니면 디스플레이×ROI.
            let (w, h) = config.h264Size(for: displayID)
            self.curW = w; self.curH = h
            let enc = H264Encoder()
            guard enc.setup(width: w, height: h, fps: max(1, Int(fps)), bitrate: bitrate) else { return }
            self.encoder = enc

            let cfg = SCStreamConfiguration()
            cfg.width = w
            cfg.height = h
            // ROI 크롭(전체면 .zero) — 창 모드에선 ROI 가 항상 전체(창 진입 시 리셋)라 .zero.
            cfg.sourceRect = winID != 0 ? .zero : roiSourceRect(for: displayID)
            cfg.minimumFrameInterval = CMTime(value: 1, timescale: Int32(max(1, Int(fps))))
            cfg.pixelFormat = kCVPixelFormatType_32BGRA
            cfg.queueDepth = 8 // 30fps 에서 인코드 지연 동안 캡처가 굶지 않게 (SCK 권장 3-8 의 상한)
            cfg.showsCursor = true
            if wantAudio {
                // 시스템 오디오 — 헬퍼 자신은 소리를 안 내지만 관례상 제외. 48kHz 스테레오.
                cfg.capturesAudio = true
                cfg.sampleRate = 48000
                cfg.channelCount = 2
                cfg.excludesCurrentProcessAudio = true
            }

            let s = SCStream(filter: filter, configuration: cfg, delegate: self)
            do {
                try s.addStreamOutput(self, type: .screen, sampleHandlerQueue: self.queue)
                if wantAudio {
                    try s.addStreamOutput(self, type: .audio, sampleHandlerQueue: self.audioQueue)
                }
            } catch {
                logErr("addStreamOutput 실패: \(error.localizedDescription)"); return
            }
            self.audioEncoder = wantAudio ? AACEncoder() : nil
            self.audioActive = wantAudio
            s.startCapture { err in
                if let err { logErr("startCapture 실패: \(err.localizedDescription)") }
                else { logErr("h264 capture started \(w)x\(h) fps=\(Int(fps)) br=\(bitrate) audio=\(wantAudio)") }
            }
            self.stream = s
        }
    }

    /// 디스플레이 전환(멀티모니터) — SCStream 은 시작 시 디스플레이/해상도로 고정이라, 현재
    /// 스트림을 내리고 새 config(displayID/h264Size)로 다시 빌드한다. 새 인코더가 새 SPS/PPS +
    /// 키프레임을 내보내므로 iOS 디코더가 새 해상도로 재동기화한다. 전환 동안 ~100ms 공백은 수용.
    func reconfigure() {
        queue.async { [weak self] in
            guard let self else { return }
            let old = self.stream
            self.stream = nil
            // 인코더는 «해제 전» 에 세션을 동기 invalidate 해 콜백 큐를 비운다 — 안 그러면 VT 콜백이
            // 해제된 인코더를 retain 해 use-after-free(크래시). 그 뒤 nil 로 늦은 샘플도 안전 드롭.
            self.encoder?.invalidate()
            self.encoder = nil
            self.audioEncoder = nil // AVAudioConverter 는 콜백 세션이 없어 그냥 해제해도 안전.
            if let old {
                old.stopCapture { [weak self] _ in self?.start() }
            } else {
                self.start()
            }
        }
    }

    /// 동적 적응(daemon backpressure 제어) — fps/bitrate 만 «라이브» 로 바꾼다. 재시작/키프레임
    /// 없이 매끄럽게: bitrate 는 VTSession 속성, fps 는 SCStream updateConfiguration(같은 해상도).
    /// 해상도는 안 건드린다(바꾸려면 reconfigure 로 재시작). H.264 레퍼런스 체인이 안 깨진다.
    func applyRate(fps: Int, bitrate: Int) {
        queue.async { [weak self] in
            guard let self else { return }
            self.encoder?.setBitrate(bitrate)
            guard let s = self.stream, self.curW > 0, self.curH > 0 else { return }
            let cfg = SCStreamConfiguration()
            cfg.width = self.curW
            cfg.height = self.curH
            cfg.sourceRect = roiSourceRect(for: config.snapshot.displayID) // ROI 유지(레이트만 변경)
            cfg.minimumFrameInterval = CMTime(value: 1, timescale: Int32(max(1, fps)))
            cfg.pixelFormat = kCVPixelFormatType_32BGRA
            cfg.queueDepth = 8 // 30fps 에서 인코드 지연 동안 캡처가 굶지 않게 (SCK 권장 3-8 의 상한)
            cfg.showsCursor = true
            s.updateConfiguration(cfg) { err in
                if let err { logErr("updateConfiguration 실패: \(err.localizedDescription)") }
            }
        }
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard CMSampleBufferIsValid(sampleBuffer) else { return }
        switch type {
        case .screen:
            guard let pb = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
            encoder?.encode(pb, pts: CMSampleBufferGetPresentationTimeStamp(sampleBuffer))
        case .audio:
            audioEncoder?.encode(sampleBuffer)
        default:
            break
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        logErr("SCStream 중단: \(error.localizedDescription)")
        // 잠금 상태면 SCK 가 프라이버시상 스트림을 멈춘 것 — 프로세스를 죽이지 않는다.
        // stream/encoder 만 비워두면, 해제 시 lockMonitor 가 reconfigure 로 새 스트림을 띄워
        // (stream==nil 분기로 곧장 start) 복구한다. 잠금이 아니면 진짜 에러 → exit(sidecar 가 감지).
        if isScreenLocked() {
            logErr("잠금 중 스트림 중단 — 해제 대기(프로세스 유지)")
            queue.async { [weak self] in
                self?.stream = nil; self?.encoder?.invalidate(); self?.encoder = nil; self?.audioEncoder = nil
            }
            return
        }
        exit(0)
    }
}

// MARK: - 입력 주입 (CGEvent)

func toPoint(_ nx: Double, _ ny: Double) -> CGPoint {
    // 창 모드 — iOS 좌표는 «창» 기준 0..1. 창의 현재 글로벌 bounds 로 매핑(이동 중에도 라이브
    // 조회라 제자리). 창이 막 닫힌 찰나면 디스플레이 경로로 폴백(감시 스레드가 곧 정리).
    let win = config.windowSnapshot
    if win != 0, let wb = windowBounds(win) {
        let x = wb.origin.x + max(0, min(1, nx)) * wb.width
        let y = wb.origin.y + max(0, min(1, ny)) * wb.height
        return CGPoint(x: x, y: y)
    }
    let b = CGDisplayBounds(config.displayID)
    // ROI 합성 — iOS 좌표는 «보는 영역(ROI)» 기준 0..1 이므로 ROI 로 디스플레이 전체 좌표에 매핑.
    // 전체면 roi={0,0,1,1} 이라 항등. ROI 줌 중에도 클릭이 제자리에 떨어진다.
    let r = config.roiSnapshot
    let cx = max(0, min(1, nx)) * Double(r.width) + Double(r.minX)
    let cy = max(0, min(1, ny)) * Double(r.height) + Double(r.minY)
    let x = b.origin.x + cx * b.width
    let y = b.origin.y + cy * b.height
    return CGPoint(x: x, y: y)
}

func cgButton(_ s: String?) -> (CGMouseButton, CGEventType, CGEventType) {
    switch s {
    case "right": return (.right, .rightMouseDown, .rightMouseUp)
    default:      return (.left,  .leftMouseDown,  .leftMouseUp)
    }
}

func postMouse(_ type: CGEventType, _ p: CGPoint, _ button: CGMouseButton, clickCount: Int = 1) {
    guard let e = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: p, mouseButton: button) else { return }
    if clickCount > 1 { e.setIntegerValueField(.mouseEventClickState, value: Int64(clickCount)) }
    e.post(tap: .cghidEventTap)
}

func injectMove(_ nx: Double, _ ny: Double) { postMouse(.mouseMoved, toPoint(nx, ny), .left) }

/// 드래그 모드 — 버튼을 누른 채 이동(leftMouseDragged). down→drag*→up 시퀀스로 텍스트 선택 등.
func injectDrag(_ nx: Double, _ ny: Double) { postMouse(.leftMouseDragged, toPoint(nx, ny), .left) }

/// 한 번의 클릭을 «clickState»(=clicks) 로 보낸다. iOS 가 빠른 연속 탭을 1→2→3 으로 올려 보내면
/// macOS 가 그 시퀀스를 더블/트리플 클릭으로 인식한다(지연 없이). 단발 탭은 clicks=1=단일 클릭.
func injectClick(_ nx: Double, _ ny: Double, button: String?, clicks: Int) {
    let p = toPoint(nx, ny)
    let (btn, downType, upType) = cgButton(button)
    let state = max(1, min(3, clicks))
    postMouse(downType, p, btn, clickCount: state)
    postMouse(upType, p, btn, clickCount: state)
}

func injectButton(down: Bool, _ nx: Double, _ ny: Double, button: String?) {
    let p = toPoint(nx, ny)
    let (btn, downType, upType) = cgButton(button)
    postMouse(down ? downType : upType, p, btn)
}

func injectScroll(dx: Double, dy: Double) {
    guard let e = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2,
                          wheel1: Int32(dy), wheel2: Int32(dx), wheel3: 0) else { return }
    e.post(tap: .cghidEventTap)
}

func injectText(_ text: String) {
    let utf16 = Array(text.utf16)
    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) else { return }
    utf16.withUnsafeBufferPointer { ptr in
        down.keyboardSetUnicodeString(stringLength: ptr.count, unicodeString: ptr.baseAddress)
        up.keyboardSetUnicodeString(stringLength: ptr.count, unicodeString: ptr.baseAddress)
    }
    down.post(tap: .cghidEventTap)
    up.post(tap: .cghidEventTap)
}

let SPECIAL_KEYCODES: [String: CGKeyCode] = [
    "return": 36, "enter": 36, "delete": 51, "backspace": 51, "forwarddelete": 117,
    "escape": 53, "esc": 53, "tab": 48, "space": 49,
    "left": 123, "right": 124, "down": 125, "up": 126,
    "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
]

func injectKey(_ name: String) {
    guard let code = SPECIAL_KEYCODES[name.lowercased()] else { return }
    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false) else { return }
    down.post(tap: .cghidEventTap)
    up.post(tap: .cghidEventTap)
}

/// ANSI US 문자/숫자 키코드 — 단축키(예: ⌘C)용. 수정자는 hotkey 의 mods 로 따로 적용.
let CHAR_KEYCODES: [String: CGKeyCode] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
    "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19,
    "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28,
    "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "l": 37, "j": 38,
    "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46, ".": 47, "`": 50,
]

/// 단축키 주입 — 키(문자/특수) + 수정자(command/shift/option/control) 플래그를 얹어 keyDown/Up.
/// 예: key="c", mods=["command"] → ⌘C(복사). iOS 커스텀 단축키 버튼이 보낸다.
func injectHotkey(_ key: String, mods: [String]) {
    let k = key.lowercased()
    guard let code = SPECIAL_KEYCODES[k] ?? CHAR_KEYCODES[k] else { return }
    var flags: CGEventFlags = []
    if mods.contains("command") { flags.insert(.maskCommand) }
    if mods.contains("shift") { flags.insert(.maskShift) }
    if mods.contains("option") { flags.insert(.maskAlternate) }
    if mods.contains("control") { flags.insert(.maskControl) }
    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false) else { return }
    down.flags = flags
    up.flags = flags
    down.post(tap: .cghidEventTap)
    up.post(tap: .cghidEventTap)
}

// MARK: - 명령 파싱

/// 첫 config 수신 시 캡처 시작 게이트를 푼다 — codec 을 알고 나서 캡처 모드를 고르기 위함.
let startGate = DispatchSemaphore(value: 0)
let startGateLock = NSLock()
var didSignalStart = false
func signalStartOnce() {
    startGateLock.lock(); defer { startGateLock.unlock() }
    if !didSignalStart { didSignalStart = true; startGate.signal() }
}

/// h264 캡처 엔진 핸들 — main 에서 생성, stdin 스레드의 handleCommand 에서 디스플레이 전환 시
/// 읽으므로 락으로 보호. jpeg 경로에선 nil 로 남는다.
let engineLock = NSLock()
var captureEngine: CaptureEngine?
func setCaptureEngine(_ e: CaptureEngine?) { engineLock.lock(); captureEngine = e; engineLock.unlock() }
func currentCaptureEngine() -> CaptureEngine? { engineLock.lock(); defer { engineLock.unlock() }; return captureEngine }

// MARK: - 화면 잠금 감지
//
// Mac 이 «잠긴» 상태(로그인된 채 화면 잠금)면 ScreenCaptureKit / CGDisplayCreateImage 가 검은·빈
// 프레임만 내거나 콘텐츠 쿼리가 막혀, iOS 미러가 «화면 수신 대기 중…» 에 무한정 갇힌다. 그래서
// 잠금 상태를 1s 폴링으로 추적해 daemon(→iOS)에 보고하고, 해제 순간 h264 스트림을 재구성해 곧장
// 복구한다. (jpeg 경로는 CGDisplayCreateImage 가 해제 후 자동으로 다시 이미지를 내므로 보고만 한다.)
//
// 폴링인 이유: jpeg 경로는 captureLoopJPEG 가 메인 스레드를 점유해 RunLoop 가 없어
// DistributedNotificationCenter(com.apple.screenIsLocked) 옵저버가 안 불린다 → 두 코덱에서 똑같이
// 도는 폴링이 단순·확실.
//
// 한계: «로그인 안 된» 로그인 윈도우(부팅 직후 등)는 SCK 가 아예 미지원이라 이 Aqua 세션 헬퍼로는
// 불가능 — loginwindow 컨텍스트 권한 헬퍼 + persistent-content-capture entitlement 필요(로드맵 문서 참고).

/// 현재 세션이 잠겼는지 — CGSessionCopyCurrentDictionary 의 CGSSessionScreenIsLocked 키.
func isScreenLocked() -> Bool {
    guard let info = CGSessionCopyCurrentDictionary() as? [String: Any] else { return false }
    if let b = info["CGSSessionScreenIsLocked"] as? Bool { return b }
    if let n = info["CGSSessionScreenIsLocked"] as? Int { return n != 0 }
    return false
}

/// 잠금 상태를 daemon stderr 태그로 보고 — sidecar 가 파싱해 capture_status(reason) 로 iOS 에 전달.
func reportLockState(_ locked: Bool) {
    FileHandle.standardError.write(Data(("__PS_CAPTURE_STATUS__ {\"locked\":\(locked ? "true" : "false")}\n").utf8))
}

/// 잠금 상태 변화 폴링 스레드 — 시작 시 1회 + 변할 때마다 보고. 해제 순간 h264 스트림 재구성으로 복구.
let lockMonitorThread = Thread {
    var last: Bool?
    while true {
        let now = isScreenLocked()
        if now != last {
            reportLockState(now)
            // 해제 순간 — 멈췄던/검은 h264 스트림을 새로 띄워 즉시 복구(새 SPS/PPS + 키프레임).
            if last == true, !now, let engine = currentCaptureEngine() {
                engine.reconfigure()
            }
            last = now
        }
        Thread.sleep(forTimeInterval: 1.0)
    }
}

// MARK: - 창 타겟 감시
//
// SCStream(desktopIndependentWindow)은 창 이동/리사이즈를 «내용» 으로는 따라가지만 출력 해상도는
// 시작 시 고정이다 → 리사이즈 후엔 스케일된(흐릿한) 프레임. 그래서 1s 폴링으로:
//   - 창이 닫히면(목록에서 사라짐) 전체 화면으로 폴백 + iOS 에 보고(캡슐 안내).
//   - 창 «크기» 가 변하면, 드래그가 끝나 두 틱 연속 같은 크기로 «안정» 된 시점에 스트림을
//     재구성해 해상도를 창에 다시 맞춘다(리사이즈 드래그 중 연쇄 재시작 방지).
// lockMonitor 처럼 폴링인 이유도 같다 — jpeg 경로 메인 스레드 점유로 RunLoop 옵저버가 불가.
let windowMonitorThread = Thread {
    var lastSize: CGSize?
    var resizeDirty = false
    while true {
        Thread.sleep(forTimeInterval: 1.0)
        let id = config.windowSnapshot
        guard id != 0 else { lastSize = nil; resizeDirty = false; continue }
        guard let b = windowBounds(id) else {
            // 창이 닫힘 — 전체 화면 폴백 + 보고. 다음 틱부터는 디스플레이 모드라 이 분기 안 탄다.
            logErr("창 \(id) 닫힘 — 전체 화면 폴백")
            config.set(fps: nil, quality: nil, maxDim: nil, display: nil, codec: nil, bitrate: nil, window: 0)
            config.setROI(nil)
            reportTarget(window: 0, reason: "window_closed")
            currentCaptureEngine()?.reconfigure()
            lastSize = nil
            resizeDirty = false
            continue
        }
        if let prev = lastSize, prev != b.size {
            resizeDirty = true // 크기 변화 감지 — 안정될 때까지 대기.
        } else if resizeDirty, lastSize == b.size {
            // 두 틱 연속 같은 크기 = 리사이즈 종료 — 새 창 크기로 해상도 재협상.
            resizeDirty = false
            logErr("창 \(id) 리사이즈 정착 \(Int(b.width))×\(Int(b.height)) — 스트림 재구성")
            currentCaptureEngine()?.reconfigure()
        }
        lastSize = b.size
    }
}

func handleCommand(_ line: String) {
    guard let data = line.data(using: .utf8),
          let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
          let cmd = obj["cmd"] as? String else { return }
    func d(_ k: String) -> Double { (obj[k] as? Double) ?? (obj[k] as? NSNumber)?.doubleValue ?? 0 }
    func i(_ k: String) -> Int { (obj[k] as? Int) ?? Int((obj[k] as? NSNumber)?.intValue ?? 0) }
    switch cmd {
    case "config":
        let prevDisplay = config.displayID
        let prevWindow = config.windowSnapshot
        let prevFps = config.snapshot.fps
        let prevBitrate = config.bitrateSnapshot
        config.set(
            fps: obj["fps"] as? Double,
            quality: obj["quality"] as? Double,
            maxDim: (obj["maxDim"] as? Int) ?? (obj["maxDim"] as? NSNumber)?.intValue,
            display: (obj["display"] as? Int) ?? (obj["display"] as? NSNumber)?.intValue,
            codec: obj["codec"] as? String,
            bitrate: (obj["bitrate"] as? Int) ?? (obj["bitrate"] as? NSNumber)?.intValue,
            audio: obj["audio"] as? Bool,
            window: (obj["window"] as? Int) ?? (obj["window"] as? NSNumber)?.intValue,
        )
        signalStartOnce()
        let newFps = config.snapshot.fps
        let newBitrate = config.bitrateSnapshot
        // 첫 config 땐 엔진이 아직 없어(nil) 정상 — 엔진이 새 값으로 시작.
        if config.windowSnapshot != prevWindow, let engine = currentCaptureEngine() {
            // 창 타겟 전환(설정/해제, display 키에 의한 해제 포함) — ROI 는 전체로 리셋(창 자체가
            // 관심영역) 후 새 필터로 스트림 재구성. 적용 결과를 보고해 iOS 선택 상태를 동기화.
            config.setROI(nil)
            reportTarget(window: config.windowSnapshot)
            engine.reconfigure()
        } else if config.displayID != prevDisplay, let engine = currentCaptureEngine() {
            // 디스플레이 전환 — ROI 는 디스플레이별이라 전체로 리셋 후 스트림 재구성(새 모니터 전체부터).
            config.setROI(nil)
            engine.reconfigure()
        } else if let engine = currentCaptureEngine(), engine.audioActive != config.audioSnapshot {
            // 오디오 on/off 토글 — SCStream 출력 구성이 바뀌므로 스트림 재구성(짧은 공백 수용).
            engine.reconfigure()
        } else if newFps != prevFps || newBitrate != prevBitrate, let engine = currentCaptureEngine() {
            // 동적 적응(daemon backpressure) — fps/bitrate 만 라이브 변경, 재시작 없이.
            engine.applyRate(fps: Int(newFps), bitrate: newBitrate)
        }
    case "targets":
        // 캡처 대상(창) 목록 재보고 요청 — iOS 더보기 메뉴가 열릴 때 최신 목록으로 갱신.
        emitWindowList()
    case "roi":
        // 줌 관심영역 변경(하이브리드 D) — 정규화 rect. w<=0 이면 전체로 리셋.
        // 창 모드에선 무시 — 창 자체가 관심영역이고 iOS 도 창 스코프에선 ROI 를 안 보낸다(방어).
        guard config.windowSnapshot == 0 else { return }
        let rw = d("w")
        let prevROI = config.roiSnapshot
        if rw <= 0 {
            config.setROI(nil)
        } else {
            config.setROI(CGRect(x: d("x"), y: d("y"), width: rw, height: d("h")))
        }
        let curROI = config.roiSnapshot
        if let engine = currentCaptureEngine() {
            // 같은 «크기»면(=팬: 위치만 이동) 해상도 불변 → sourceRect 만 라이브 갱신(재시작/키프레임
            // 없이 매끄럽게). 크기가 바뀌면(=줌) 해상도가 달라지므로 스트림 재구성(새 키프레임).
            if abs(curROI.width - prevROI.width) < 0.005, abs(curROI.height - prevROI.height) < 0.005 {
                let s = config.snapshot
                engine.applyRate(fps: Int(s.fps), bitrate: config.bitrateSnapshot)
            } else {
                engine.reconfigure()
            }
        }
    case "move":
        injectMove(d("x"), d("y"))
    case "drag":
        injectDrag(d("x"), d("y"))
    case "click":
        injectClick(d("x"), d("y"), button: obj["button"] as? String, clicks: i("clicks"))
    case "down":
        injectButton(down: true, d("x"), d("y"), button: obj["button"] as? String)
    case "up":
        injectButton(down: false, d("x"), d("y"), button: obj["button"] as? String)
    case "scroll":
        injectScroll(dx: d("dx"), dy: d("dy"))
    case "text":
        if let t = obj["text"] as? String { injectText(t) }
    case "key":
        if let k = obj["key"] as? String { injectKey(k) }
    case "hotkey":
        if let k = obj["key"] as? String { injectHotkey(k, mods: obj["mods"] as? [String] ?? []) }
    default:
        break
    }
}

// MARK: - 디스플레이 절전 방지 / 깨우기 (미러링 전용)
//
// 미러링은 디스플레이가 «켜져» 있어야 ScreenCaptureKit / CGDisplayCreateImage 가 실제 픽셀을 낸다
// (꺼지면 검은/빈 프레임). 그런데 Mac 앱의 keep-awake 어서션은 PreventUserIdle*System*Sleep 이라
// «시스템» 만 깨우고 디스플레이는 일부러 꺼지게 둔다(터미널/SSH 엔 그게 맞음 — PowerManager 참고).
// 그래서 미러 세션(=이 헬퍼 프로세스) 동안에는 여기서 별도로 두 가지를 건다:
//   1. DeclareUserActivity(kIOPMUserActiveLocal) — 이미 꺼진 화면을 «지금» 켠다. Prevent 어서션만
//      으론 이미 꺼진 화면을 못 켜므로(Apple 헤더 명시) 시작 시 1회. = 가상 클릭의 정식 버전.
//   2. PreventUserIdleDisplaySleep 어서션 보유 — 도중 디스플레이가 다시 idle-sleep 으로 안 꺼지게
//      (= caffeinate -d). 디스플레이 어서션은 시스템 idle 잠도 함께 막는다.
// 어서션은 이 프로세스가 죽으면(capture_stop → daemon 이 kill, 또는 stdin EOF → exit) OS 가 자동
// 해제 → 어서션 수명이 미러 세션과 정확히 일치. 권한 불필요(데스크톱 Mac mini 포함 모든 기종 동작).

/// `pmset -g assertions` 에만 보이는 내부 식별자 — 사용자 화면 노출 아님(비번역).
private var displaySleepAssertionID: IOPMAssertionID = 0

/// 꺼진 디스플레이를 즉시 켜고(사용자 활동 선언), 미러 세션 동안 다시 안 꺼지게 어서션을 건다. 멱등.
func keepDisplayAwakeForMirroring() {
    // 1. 이미 꺼졌으면 지금 켠다 — DeclareUserActivity 가 정식 «화면 깨우기» API.
    //    반환 어서션은 idle 타이머만큼 유지되다 자동 만료/프로세스 종료 시 해제 → 별도 보관 불필요.
    var wakeID: IOPMAssertionID = 0
    let wake = IOPMAssertionDeclareUserActivity(
        "Pocket Sisyphus — mirror wake" as CFString,
        kIOPMUserActiveLocal,
        &wakeID)
    if wake != kIOReturnSuccess { logErr("display wake 실패 \(wake)") }

    // 2. 세션 동안 디스플레이 idle-sleep 방지(= caffeinate -d). 이미 들고 있으면 noop.
    guard displaySleepAssertionID == 0 else { return }
    var id: IOPMAssertionID = 0
    let r = IOPMAssertionCreateWithName(
        kIOPMAssertionTypePreventUserIdleDisplaySleep as CFString,
        IOPMAssertionLevel(kIOPMAssertionLevelOn),
        "Pocket Sisyphus — mirror display awake" as CFString,
        &id)
    if r == kIOReturnSuccess {
        displaySleepAssertionID = id
        logErr("display-sleep 방지 어서션 on")
    } else {
        logErr("display-sleep 어서션 실패 \(r)")
    }
}

// MARK: - 진입점

let stdinThread = Thread {
    while let line = readLine(strippingNewline: true) {
        handleCommand(line)
    }
    exit(0)  // stdin EOF = daemon 종료.
}
stdinThread.stackSize = 1 << 20
stdinThread.start()

// 화면 잠금 감지 — 시작 시 현재 상태 + 변화 보고, 해제 시 h264 복구.
lockMonitorThread.stackSize = 1 << 20
lockMonitorThread.start()

// 창 타겟 감시 — 닫힘 폴백 + 리사이즈 해상도 추적 (창 모드일 때만 실동작).
windowMonitorThread.stackSize = 1 << 20
windowMonitorThread.start()

// 미러 세션 시작 = 헬퍼 spawn. 디스플레이가 절전으로 꺼져 있었다면 지금 켜고, 도중 다시 안 꺼지게
// 어서션을 건다. config 를 기다리기 전에 호출해 화면을 최대한 빨리 깨운다.
keepDisplayAwakeForMirroring()

logErr("started (display=\(config.displayID))")
FileHandle.standardError.write(Data(("__PS_DISPLAYS__ " + config.displaysJSON + "\n").utf8))
// 캡처 대상(창) 목록 — 시작 시 1회 보고(이후 갱신은 iOS 의 targets 요청으로).
emitWindowList()
// 화면 기록 권한의 «실제» 상태 — 헬퍼는 매번 새 프로세스라 라이브 TCC 를 읽는다(책임 프로세스=
// Mac 앱). 앱의 CGPreflight 는 시작 시점 캐시라 부정확하므로, 권한 테스트는 이 마커를 신뢰한다.
FileHandle.standardError.write(Data(("__PS_SCREENPERM__ " + (CGPreflightScreenCaptureAccess() ? "1" : "0") + "\n").utf8))
// 손쉬운 사용(원격 제어) 권한의 «실제» 상태 — CGEvent 주입이 통하려면 책임 프로세스(=Mac 앱)가
// 손쉬운 사용에 신뢰돼야 한다. 화면 기록과 같은 원리로 라이브 조회. daemon 이 이 마커를 캐시해
// 제어가 켜졌는데 미부여면 iOS 에 «보기는 되나 조작은 막힘» 을 분리해 안내한다.
FileHandle.standardError.write(Data(("__PS_AXPERM__ " + (AXIsProcessTrusted() ? "1" : "0") + "\n").utf8))

// codec 결정을 위해 daemon 의 첫 config 를 잠깐 기다린다(없으면 jpeg 폴백).
_ = startGate.wait(timeout: .now() + 2.0)

if config.codecSnapshot == "h264" {
    let engine = CaptureEngine()
    setCaptureEngine(engine)   // handleCommand 의 디스플레이 전환이 찾을 수 있게 등록.
    engine.start()
    RunLoop.main.run()   // SCStream/VideoToolbox 콜백 서비스 — 프로세스 유지.
} else {
    captureLoopJPEG()
}
