import Foundation
import AVFoundation
import CoreMedia
import UIKit

/// H.264 미러링 렌더러 — daemon 바이너리 프레임을 파싱해 **AVSampleBufferDisplayLayer** 에 직접
/// CMSampleBuffer 를 enqueue 한다. 디코드+렌더를 레이어(GPU)가 담당하므로 예전처럼 프레임마다
/// CVPixelBuffer→CGImage→UIImage 로 베끼는 비용이 사라진다(부드러움·지연·배터리 개선, fps 천장 제거).
///
/// ## 와이어 프로토콜 (daemon `broadcastBinaryToSession`, capture-helper `writeTyped`)
///   - `[1B type][...]`
///   - type 1 = 파라미터셋  `[2B spsLen][sps][2B ppsLen][pps]`  (BE 길이)
///   - type 2 = 액세스 유닛 `[1B keyframe][AVCC]`               (AVCC = `[4B len][NAL]` 반복)
///   - type 3 = 오디오 설정 `[4B BE sampleRate][1B channels][2B BE cookieLen][magic cookie]` (2초마다 재송출)
///   - type 4 = AAC 패킷    raw AAC-LC 1개 (설정의 cookie 로 디코드)
///
/// ## 스레딩
/// `handle`/`reset`/`attach` 은 메인 스레드(WSClient onEvent 가 @MainActor)에서만 호출한다.
/// AVSampleBufferDisplayLayer.enqueue 도 메인에서 — UI 레이어라 메인이 안전.
final class MirrorRenderer {
    /// 렌더 대상 — ZoomableScreenView 의 MirrorVideoView 가 attach 로 연결(약참조, 뷰가 소유).
    private weak var displayLayer: AVSampleBufferDisplayLayer?
    /// 비디오 픽셀 크기(파라미터셋에서). 컨트롤 좌표 정규화(aspect-fit 레터박스)용.
    private(set) var videoSize: CGSize = .zero
    /// 첫 프레임이 레이어에 들어간 순간 한 번 — RemoteScreenView 가 대기 오버레이를 내린다.
    var onFirstFrame: (() -> Void)?
    /// 포맷(해상도) 변경 시 — ROI 핸드오프(하이브리드 D)에서 native ROI 프레임이 도착하는 신호.
    /// RemoteScreenView 가 이때 로컬 줌을 1x 로 리셋해 «흐릿한 줌 → 선명한 ROI» 로 매끄럽게 전환.
    var onFormatChange: (() -> Void)?

    /// 시스템 오디오 재생기 — 타입 3/4 를 받아 AAC 디코드 + AVAudioEngine 재생.
    let audio = MirrorAudioPlayer()
    /// 소리 토글(iOS 측 게이트) — 꺼지면 도착하는 오디오를 버리고 재생기를 멈춘다. capture_start
    /// 의 audio 플래그가 소스를 끊지만, 토글 직후 전환 구간에 도착하는 잔여 패킷도 조용히 버린다.
    var audioEnabled = true {
        didSet { if !audioEnabled { audio.stop() } }
    }

    private var formatDesc: CMVideoFormatDescription?
    private var sps = Data()
    private var pps = Data()
    /// 키프레임을 아직 못 받았으면 델타를 버린다(레퍼런스 없이 enqueue 하면 깨진 그림). 헬퍼가
    /// ~4s 마다 키프레임을 보내므로 진입/재연결 후 곧 복구된다.
    private var hasKeyframe = false
    private var firstFrameEmitted = false

    /// 뷰가 만든 디스플레이 레이어를 연결. videoGravity=resizeAspect(=aspect-fit).
    func attach(_ layer: AVSampleBufferDisplayLayer) {
        displayLayer = layer
        layer.videoGravity = .resizeAspect
    }

    /// 진입/재진입 시 초기화 — 레이어를 비우고 키프레임 대기 상태로. 오디오도 멈춘다.
    func reset() {
        formatDesc = nil
        sps = Data()
        pps = Data()
        hasKeyframe = false
        firstFrameEmitted = false
        displayLayer?.flushAndRemoveImage()
        audio.stop()
    }

    func handle(_ payload: Data) {
        let b = [UInt8](payload)
        guard let type = b.first else { return }
        let body = Array(b.dropFirst())
        switch type {
        case 1: handleParamSets(body)
        case 2: handleAccessUnit(body)
        case 3: if audioEnabled { audio.handleConfig(body) }
        case 4: if audioEnabled { audio.handlePacket(body) }
        default: break
        }
    }

    // MARK: - 파라미터셋 → CMFormatDescription

    private func handleParamSets(_ d: [UInt8]) {
        var i = 0
        func u16() -> Int? {
            guard i + 2 <= d.count else { return nil }
            let v = Int(d[i]) << 8 | Int(d[i + 1])
            i += 2
            return v
        }
        guard let sl = u16(), i + sl <= d.count else { return }
        let newSps = Data(d[i..<i + sl]); i += sl
        guard let pl = u16(), i + pl <= d.count else { return }
        let newPps = Data(d[i..<i + pl]); i += pl
        guard !newSps.isEmpty, !newPps.isEmpty else { return }
        if newSps == sps, newPps == pps, formatDesc != nil { return } // 변화 없음
        sps = newSps
        pps = newPps
        rebuildFormat()
    }

    private func rebuildFormat() {
        formatDesc = nil
        var fmt: CMFormatDescription?
        let status = sps.withUnsafeBytes { (spsBuf: UnsafeRawBufferPointer) -> OSStatus in
            pps.withUnsafeBytes { (ppsBuf: UnsafeRawBufferPointer) -> OSStatus in
                guard let spsPtr = spsBuf.bindMemory(to: UInt8.self).baseAddress,
                      let ppsPtr = ppsBuf.bindMemory(to: UInt8.self).baseAddress else {
                    return -1
                }
                let pointers: [UnsafePointer<UInt8>] = [spsPtr, ppsPtr]
                let sizes: [Int] = [sps.count, pps.count]
                return pointers.withUnsafeBufferPointer { pp in
                    sizes.withUnsafeBufferPointer { sp in
                        CMVideoFormatDescriptionCreateFromH264ParameterSets(
                            allocator: kCFAllocatorDefault,
                            parameterSetCount: 2,
                            parameterSetPointers: pp.baseAddress!,
                            parameterSetSizes: sp.baseAddress!,
                            nalUnitHeaderLength: 4,
                            formatDescriptionOut: &fmt,
                        )
                    }
                }
            }
        }
        guard status == noErr, let fmt else {
            NSLog("[H264] format desc 생성 실패 status=\(status)")
            return
        }
        formatDesc = fmt
        let dims = CMVideoFormatDescriptionGetDimensions(fmt)
        videoSize = CGSize(width: Int(dims.width), height: Int(dims.height))
        // 해상도 변경(디스플레이 전환·ROI 등)이면 옛 프레임을 비워 새 포맷으로 깔끔히 전환.
        displayLayer?.flush()
        onFormatChange?()
    }

    // MARK: - 액세스 유닛 → enqueue

    private func handleAccessUnit(_ d: [UInt8]) {
        guard d.count > 1 else { return }
        let keyframe = d[0] == 1
        if keyframe { hasKeyframe = true }
        guard hasKeyframe, let fmt = formatDesc, let layer = displayLayer else { return }
        enqueue(avcc: Data(d[1...]), fmt: fmt, layer: layer)
    }

    private func enqueue(avcc: Data, fmt: CMVideoFormatDescription, layer: AVSampleBufferDisplayLayer) {
        let len = avcc.count
        guard len > 0 else { return }
        // AVCC 바이트를 소유하는 메모리 블록 — CMBlockBuffer 가 해제 시 free.
        let mem = UnsafeMutableRawPointer.allocate(byteCount: len, alignment: 1)
        avcc.copyBytes(to: mem.assumingMemoryBound(to: UInt8.self), count: len)

        var blockBuffer: CMBlockBuffer?
        var status = CMBlockBufferCreateWithMemoryBlock(
            allocator: kCFAllocatorDefault,
            memoryBlock: mem,
            blockLength: len,
            blockAllocator: kCFAllocatorDefault,
            customBlockSource: nil,
            offsetToData: 0,
            dataLength: len,
            flags: 0,
            blockBufferOut: &blockBuffer,
        )
        guard status == kCMBlockBufferNoErr, let blockBuffer else {
            mem.deallocate()
            return
        }

        var sampleBuffer: CMSampleBuffer?
        var sampleSize = len
        status = CMSampleBufferCreateReady(
            allocator: kCFAllocatorDefault,
            dataBuffer: blockBuffer,
            formatDescription: fmt,
            sampleCount: 1,
            sampleTimingEntryCount: 0,
            sampleTimingArray: nil,
            sampleSizeEntryCount: 1,
            sampleSizeArray: &sampleSize,
            sampleBufferOut: &sampleBuffer,
        )
        guard status == noErr, let sampleBuffer else { return }

        // DisplayImmediately — 컨트롤 타임베이스 없이 «도착 즉시» 표시(라이브 미러링). PTS 스케줄
        // 없이 들어오는 대로 그린다.
        if let arr = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: true),
           CFArrayGetCount(arr) > 0 {
            let dict = unsafeBitCast(CFArrayGetValueAtIndex(arr, 0), to: CFMutableDictionary.self)
            CFDictionarySetValue(
                dict,
                Unmanaged.passUnretained(kCMSampleAttachmentKey_DisplayImmediately).toOpaque(),
                Unmanaged.passUnretained(kCFBooleanTrue).toOpaque(),
            )
        }

        if layer.status == .failed { layer.flush() }
        layer.enqueue(sampleBuffer)
        if !firstFrameEmitted {
            firstFrameEmitted = true
            onFirstFrame?()
        }
    }
}

/// AVSampleBufferDisplayLayer 를 백킹 레이어로 갖는 UIView — UIScrollView 가 이 뷰를 줌하면
/// 레이어째 확대/축소된다(예전 UIImageView 와 동일하게 viewForZooming 대상).
final class MirrorVideoView: UIView {
    override class var layerClass: AnyClass { AVSampleBufferDisplayLayer.self }
    var displayLayer: AVSampleBufferDisplayLayer { layer as! AVSampleBufferDisplayLayer }
}

/// Mac 시스템 오디오 재생기 — 타입 3(설정)/4(AAC-LC 패킷)를 AVAudioConverter 로 PCM 디코드해
/// AVAudioPlayerNode 에 연속 스케줄한다(푸시 모델 — 타임스탬프 불필요, 지터에 강함).
///
/// 지연 관리: Mac/iPhone 클럭 드리프트나 네트워크 버스트로 백로그(스케줄됐지만 아직 재생 안 된
/// 프레임)가 자라면 지연이 누적된다 → 백로그가 ~0.4초를 넘으면 새 패킷을 버려 라이브에 붙는다.
/// 언더런(패킷 없음)은 플레이어가 무음으로 지나가고 다음 버퍼부터 자연 재개.
///
/// 호출 스레딩: 전부 메인(WSClient onEvent 가 @MainActor). 패킷은 ~47개/초·수백 바이트라 디코드
/// 비용은 무시 가능. scheduleBuffer 완료 핸들러만 렌더 스레드라 pending 카운트는 락으로 보호.
final class MirrorAudioPlayer {
    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private var converter: AVAudioConverter?
    private var inFormat: AVAudioFormat?
    private var outFormat: AVAudioFormat?
    /// 마지막으로 적용한 설정 payload — 2초마다 재송출되는 동일 설정을 무시(엔진 재구성 방지).
    private var lastConfig = Data()
    private var pendingFrames = 0
    private let pendingLock = NSLock()
    /// 백로그 상한 — 이 이상 쌓이면 새 패킷 드롭(지연 ≤ ~0.4s 유지).
    private var maxPendingFrames = 19200 // 48kHz × 0.4s, 설정 적용 시 샘플레이트로 재계산

    /// 타입 3 — 설정. 같은 내용이면 무시, 다르면(첫 수신/포맷 변경) 디코더+엔진 재구성.
    func handleConfig(_ d: [UInt8]) {
        guard d.count >= 7 else { return }
        let raw = Data(d)
        if raw == lastConfig, converter != nil { return }
        let sr = UInt32(d[0]) << 24 | UInt32(d[1]) << 16 | UInt32(d[2]) << 8 | UInt32(d[3])
        let ch = UInt32(d[4])
        let ckLen = Int(d[5]) << 8 | Int(d[6])
        guard sr >= 8000, sr <= 96000, ch >= 1, ch <= 2, 7 + ckLen <= d.count else { return }
        let cookie = Data(d[7..<7 + ckLen])

        var asbd = AudioStreamBasicDescription(
            mSampleRate: Double(sr), mFormatID: kAudioFormatMPEG4AAC,
            mFormatFlags: 0, mBytesPerPacket: 0, mFramesPerPacket: 1024,
            mBytesPerFrame: 0, mChannelsPerFrame: ch, mBitsPerChannel: 0, mReserved: 0)
        var fmtDesc: CMAudioFormatDescription?
        let status = cookie.withUnsafeBytes { (ck: UnsafeRawBufferPointer) -> OSStatus in
            CMAudioFormatDescriptionCreate(
                allocator: kCFAllocatorDefault, asbd: &asbd,
                layoutSize: 0, layout: nil,
                magicCookieSize: cookie.count, magicCookie: cookie.isEmpty ? nil : ck.baseAddress,
                extensions: nil, formatDescriptionOut: &fmtDesc)
        }
        guard status == noErr, let fmtDesc else {
            NSLog("[MirrorAudio] format desc 생성 실패 status=\(status)")
            return
        }
        let inFmt = AVAudioFormat(cmAudioFormatDescription: fmtDesc)
        guard let outFmt = AVAudioFormat(standardFormatWithSampleRate: Double(sr), channels: ch),
              let conv = AVAudioConverter(from: inFmt, to: outFmt) else {
            NSLog("[MirrorAudio] 컨버터 생성 실패")
            return
        }
        stop() // 이전 엔진/그래프 정리 후 새 포맷으로.
        inFormat = inFmt
        outFormat = outFmt
        converter = conv
        lastConfig = raw
        maxPendingFrames = Int(Double(sr) * 0.4)
        startEngine()
    }

    /// 타입 4 — AAC 패킷 1개. 디코드해 플레이어에 잇대어 스케줄.
    func handlePacket(_ d: [UInt8]) {
        guard !d.isEmpty, let conv = converter, let inFmt = inFormat, let outFmt = outFormat else { return }
        pendingLock.lock()
        let backlog = pendingFrames
        pendingLock.unlock()
        if backlog > maxPendingFrames { return } // 지연 누적 — 라이브에 붙기 위해 드롭.

        let inBuf = AVAudioCompressedBuffer(format: inFmt, packetCapacity: 1, maximumPacketSize: d.count)
        inBuf.packetCount = 1
        inBuf.byteLength = UInt32(d.count)
        d.withUnsafeBytes { src in
            inBuf.data.copyMemory(from: src.baseAddress!, byteCount: d.count)
        }
        inBuf.packetDescriptions?[0] = AudioStreamPacketDescription(
            mStartOffset: 0, mVariableFramesInPacket: 0, mDataByteSize: UInt32(d.count))

        guard let outBuf = AVAudioPCMBuffer(pcmFormat: outFmt, frameCapacity: 4096) else { return }
        var fed = false
        var convErr: NSError?
        let status = conv.convert(to: outBuf, error: &convErr) { _, outStatus in
            if fed { outStatus.pointee = .noDataNow; return nil }
            fed = true
            outStatus.pointee = .haveData
            return inBuf
        }
        guard status != .error, outBuf.frameLength > 0 else { return }

        if !engine.isRunning { startEngine() } // 인터럽션(전화 등) 후 자연 복구.
        guard engine.isRunning else { return }
        let frames = Int(outBuf.frameLength)
        pendingLock.lock()
        pendingFrames += frames
        pendingLock.unlock()
        player.scheduleBuffer(outBuf) { [weak self] in
            guard let self else { return }
            self.pendingLock.lock()
            self.pendingFrames -= frames
            self.pendingLock.unlock()
        }
        if !player.isPlaying { player.play() }
    }

    /// 미러링 종료/소리 끔 — 엔진을 내리고 오디오 세션 비활성(다른 앱 오디오 정상화).
    func stop() {
        if player.engine != nil { player.stop() } // 미연결 노드 stop 은 예외 — 연결된 경우만.
        engine.stop()
        if engine.attachedNodes.contains(player) { engine.detach(player) }
        pendingLock.lock()
        pendingFrames = 0
        pendingLock.unlock()
        converter = nil
        inFormat = nil
        outFormat = nil
        lastConfig = Data()
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func startEngine() {
        guard let outFmt = outFormat else { return }
        // 무음 스위치와 무관하게 재생(미러링 사운드는 의도된 미디어 출력).
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
        try? AVAudioSession.sharedInstance().setActive(true)
        if engine.attachedNodes.contains(player) == false { engine.attach(player) }
        engine.connect(player, to: engine.mainMixerNode, format: outFmt)
        do {
            try engine.start()
            player.play()
        } catch {
            NSLog("[MirrorAudio] engine start 실패: \(error.localizedDescription)")
        }
    }
}
