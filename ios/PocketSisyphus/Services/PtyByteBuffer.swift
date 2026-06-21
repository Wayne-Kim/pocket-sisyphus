import Foundation

/// PTY raw bytes 누적 buffer + hook 동기화.
///
/// # 분리한 이유
///
/// 옛 코드는 `ChatViewModel` 안에서 `ptyBytesBuffer: Data` + `onPtyBytes: ((Data)->Void)?`
/// 두 프로퍼티가 didSet 으로 얽혀 있었다. `onPtyBytes` 의 didSet 이 항상 *전체 buffer*
/// 를 새 hook 에 replay 해서, 같은 ChatViewModel 안에서 hook 이 두 번 set 되면 같은
/// SwiftTerm view 가 reuse 되는 경우 이중 feed 가 발생해 UI 가 겹쳐 보였다 (2026-05-23
/// 회귀). 이 동작을 분리된 struct 로 떼서 `delivered offset` 기반 incremental replay
/// 로 단단히 만들고, 단위 테스트로 회귀 차단.
///
/// # 계약
///
/// - `append(_:hook:)`: 새 bytes 를 누적. hook 이 등록돼 있으면 그 bytes 만 전달
///   (지연 없이) + delivered offset 전진.
/// - `registerHook(_:)`: 새 hook 등록. buffer 의 «아직 안 흘린 부분» 만 전달.
///   첫 등록이면 전체 replay. 동일 인스턴스에 두 번째 등록되어도 prefix 는 재발송 X.
/// - `unregisterHook()`: hook 제거 + delivered offset 리셋 — 다음 hook 등록이 처음부터.
/// - `reset()`: «터미널 강제 재시작» 에서 호출. 전체 상태 초기화.
///
/// # Thread safety
///
/// `MainActor` 컨텍스트에서만 사용 — `ChatViewModel.@MainActor` 가 호출 진입점.
/// 별도 lock 없음.
@MainActor
struct PtyByteBuffer {
    private var buffer: Data = Data()
    private var deliveredOffset: Int = 0
    private var hook: ((Data) -> Void)?

    /// 사용자가 친 텍스트를 서버 echo 도착 전에 SwiftTerm 에 미리 그린 결과의 bytes.
    /// 곧 도착할 서버 echo bytes 의 prefix 와 매칭되면 그만큼 hook 재호출을 skip 한다
    /// (이중 표시 방지). 매칭 실패 시 전체 prediction 폐기 + 서버 bytes 그대로 흘림 —
    /// 화면에 일시적 글리치가 보이지만 결과적으로는 서버 상태와 일치하게 수렴.
    ///
    /// 비-PTY 모드 / 옵션 off 인 경우 항상 빈 상태로 유지 → 기존 동작과 동치.
    private var pendingPrediction: Data = Data()

    /// 현재 누적된 총 바이트 수.
    var count: Int { buffer.count }

    /// 마지막으로 hook 에 흘려보낸 offset.
    var delivered: Int { deliveredOffset }

    /// hook 이 등록된 상태인지.
    var isHookRegistered: Bool { hook != nil }

    /// 진단/테스트용 — 아직 서버 echo 로 확인되지 않은 prediction byte 수.
    var pendingPredictionCount: Int { pendingPrediction.count }

    /// 새 chunk 가 도착했다 — buffer 에 누적 + hook 호출.
    /// hook 이 nil 이면 buffer 에만 쌓여 다음 registerHook 의 replay 에서 전달된다.
    ///
    /// pendingPrediction 이 비어 있지 않으면 들어온 bytes 의 prefix 가 prediction 과
    /// 매칭되는지 확인. 매칭되는 만큼은 화면에 이미 떠 있으므로 hook 재호출 skip, 매칭
    /// 실패 지점에서 남은 prediction 은 폐기 + 분기 이후 server bytes 만 hook 으로 흘림.
    mutating func append(_ data: Data) {
        if pendingPrediction.isEmpty {
            buffer.append(data)
            if let hook {
                hook(data)
                deliveredOffset = buffer.count
            }
            return
        }

        let matched = matchPrefix(predicted: pendingPrediction, incoming: data)
        if matched > 0 {
            // 매칭된 만큼 prediction 큐에서 소비. 화면엔 이미 그려져 있고, predict() 가
            // buffer 에도 박아 둔 상태라 별도 mutation 불필요.
            pendingPrediction.removeFirst(matched)
        }
        if matched < data.count {
            // 분기점 — 남은 prediction 이 있다면 폐기 (서버가 다른 시퀀스를 echo 함).
            // 화면에 그렸던 «남은 예측» 부분은 retract 못 함 (cursor 역행 미구현). 대신
            // 서버 bytes 를 그대로 흘려 결과적 일관성을 보장.
            pendingPrediction = Data()
            let remainder = data.subdata(in: matched..<data.count)
            buffer.append(remainder)
            if let hook {
                hook(remainder)
                deliveredOffset = buffer.count
            }
        }
    }

    /// 사용자 입력을 서버 echo 도착 전에 SwiftTerm 에 즉시 그린다. 옵션 ON 일 때만 호출.
    /// 호출자는 일반 PTY echo 가 곧 따라온다고 가정 — 따라오는 bytes 와 매칭되면 자동 dedup.
    mutating func predict(_ data: Data) {
        guard !data.isEmpty else { return }
        // buffer 에도 박는다 — 새 hook 이 나중에 register 되면 «아직 안 흘린 부분» 으로
        // 동일하게 보이게. delivered offset 도 같이 전진해 중복 replay 차단.
        buffer.append(data)
        pendingPrediction.append(data)
        if let hook {
            hook(data)
            deliveredOffset = buffer.count
        }
    }

    /// `predicted` 의 leading bytes 가 `incoming` 의 leading bytes 와 어디까지 같은지.
    /// 0 = 첫 바이트부터 다름.
    private func matchPrefix(predicted: Data, incoming: Data) -> Int {
        let maxLen = Swift.min(predicted.count, incoming.count)
        if maxLen == 0 { return 0 }
        return predicted.withUnsafeBytes { (pRaw: UnsafeRawBufferPointer) -> Int in
            incoming.withUnsafeBytes { (iRaw: UnsafeRawBufferPointer) -> Int in
                let pBase = pRaw.bindMemory(to: UInt8.self).baseAddress!
                let iBase = iRaw.bindMemory(to: UInt8.self).baseAddress!
                var i = 0
                while i < maxLen {
                    if pBase[i] != iBase[i] { return i }
                    i += 1
                }
                return maxLen
            }
        }
    }

    /// hook 을 등록. buffer 안의 «아직 안 흘린 부분» 만 새 hook 으로 전달.
    /// 같은 인스턴스에 두 번째 호출되어도 이미 흘려보낸 부분은 재발송 X.
    mutating func registerHook(_ newHook: @escaping (Data) -> Void) {
        hook = newHook
        if deliveredOffset < buffer.count {
            let suffix = buffer.subdata(in: deliveredOffset..<buffer.count)
            deliveredOffset = buffer.count
            newHook(suffix)
        }
    }

    /// hook 제거. delivered offset 도 0 으로 리셋 — 다음 hook 등록 시 전체 replay 가능.
    mutating func unregisterHook() {
        hook = nil
        deliveredOffset = 0
    }

    /// «터미널 강제 재시작» — buffer + offset 모두 초기. hook 자체는 유지 (등록 상태 보존).
    /// prediction queue 도 같이 비운다 — 재시작 직후 도착하는 새 splash 청크가 옛 예측과
    /// 우연히 매칭돼 잘못 dedup 되는 사고 차단.
    mutating func reset() {
        buffer = Data()
        deliveredOffset = 0
        pendingPrediction = Data()
    }
}
