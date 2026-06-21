import XCTest

// PtyByteBuffer.swift 는 host-less library test 패턴으로 이 테스트 번들에 직접 컴파일
// 된다 (project.yml 의 PocketSisyphusTests.sources 참고). `@testable import` 불필요.

/// `PtyByteBuffer` 단위 테스트.
///
/// 회귀 차단 대상: 2026-05-23 의 «UI 가 여러 겹으로 보이는» 버그. 옛 ChatViewModel 은
/// `onPtyBytes` didSet 가 항상 *전체 buffer* 를 replay 해서, 같은 ViewModel 안에서
/// hook 이 두 번 set 되는 케이스 (PtyTerminalView 가 재생성되며 새 Coordinator 가 bind)
/// 에 동일 prefix 가 SwiftTerm 에 두 번 feed 되어 화면이 겹쳐 보였다.
///
/// 이 테스트들이 `delivered offset` 기반 incremental replay 의 모든 분기를 통제 가능한
/// 입력으로 검증해, 향후 refactor 가 같은 함정에 빠지지 않게 한다.
@MainActor
final class PtyByteBufferTests: XCTestCase {
    func testAppendWithoutHook_BufferAccumulatesOnly() {
        var buf = PtyByteBuffer()
        buf.append(Data([0x41, 0x42]))      // "AB"
        buf.append(Data([0x43]))            // "C"

        XCTAssertEqual(buf.count, 3)
        XCTAssertEqual(buf.delivered, 0, "hook 없으니 delivered 진행 X")
        XCTAssertFalse(buf.isHookRegistered)
    }

    func testAppendWithHook_HookGetsOnlyNewBytes_DeliveredAdvances() {
        var buf = PtyByteBuffer()
        var received: [Data] = []
        buf.registerHook { received.append($0) }

        buf.append(Data([0x41, 0x42]))
        buf.append(Data([0x43]))

        XCTAssertEqual(received, [Data([0x41, 0x42]), Data([0x43])])
        XCTAssertEqual(buf.delivered, 3)
    }

    func testRegisterHookOnEmptyBuffer_NoReplay() {
        var buf = PtyByteBuffer()
        var received: [Data] = []
        buf.registerHook { received.append($0) }

        XCTAssertEqual(received, [], "buffer 비어있으니 hook 등록만으로 호출 X")
        XCTAssertEqual(buf.delivered, 0)
    }

    func testRegisterHookAfterAppend_ReplaysAllAccumulated() {
        var buf = PtyByteBuffer()
        buf.append(Data([0x41, 0x42, 0x43]))    // hook 없이 누적

        var received: [Data] = []
        buf.registerHook { received.append($0) }

        XCTAssertEqual(received, [Data([0x41, 0x42, 0x43])], "등록 시점에 누적분 전체 replay")
        XCTAssertEqual(buf.delivered, 3)
    }

    /// 핵심 회귀 가드: 같은 buffer 에 hook 이 두 번 등록될 때.
    func testReregisterHook_OnlySendsBytesArrivedSinceFirstHook() {
        var buf = PtyByteBuffer()

        // 첫 hook
        var firstReceived: [Data] = []
        buf.registerHook { firstReceived.append($0) }
        buf.append(Data([0x41, 0x42]))      // "AB" → first hook 으로
        buf.append(Data([0x43]))            // "C"  → first hook 으로

        XCTAssertEqual(firstReceived, [Data([0x41, 0x42]), Data([0x43])])
        XCTAssertEqual(buf.delivered, 3)

        // 두 번째 hook (예: PtyTerminalView 재생성으로 새 Coordinator 가 bind)
        var secondReceived: [Data] = []
        buf.registerHook { secondReceived.append($0) }

        // 두 번째 등록 직후엔 새로 흘릴 게 없다 — 이미 다 delivered.
        XCTAssertEqual(secondReceived, [], "회귀 차단: 이미 first hook 으로 다 보낸 prefix 는 재발송 X")

        // 그 다음 새 chunk 가 들어오면 두 번째 hook 만 호출.
        buf.append(Data([0x44]))
        XCTAssertEqual(secondReceived, [Data([0x44])])
        XCTAssertEqual(firstReceived, [Data([0x41, 0x42]), Data([0x43])], "first hook 은 unregister 됐으니 추가 호출 X")
    }

    /// 새 hook 등록 *직전* 에 hook 없는 상태로 들어온 chunk 는 새 hook 에 흘려진다.
    func testGapBetweenHooks_BufferedChunksReplayedToNewHook() {
        var buf = PtyByteBuffer()

        // 첫 hook + chunk
        var firstReceived: [Data] = []
        buf.registerHook { firstReceived.append($0) }
        buf.append(Data([0x41]))

        // hook 제거 (예: ChatView 이탈로 Coordinator deinit)
        buf.unregisterHook()

        // hook 없는 동안 새 chunk 도착
        buf.append(Data([0x42]))
        buf.append(Data([0x43]))

        // 새 hook 등록 — gap 동안 누적된 chunk 가 replay
        // unregisterHook 가 delivered=0 으로 리셋했기 때문에 *전체* buffer 가 replay.
        // (옛 hook 의 view 는 이미 사라졌으므로 처음부터 다시 그려야 함.)
        var secondReceived: [Data] = []
        buf.registerHook { secondReceived.append($0) }

        XCTAssertEqual(secondReceived, [Data([0x41, 0x42, 0x43])])
        XCTAssertEqual(buf.delivered, 3)
    }

    func testReset_ClearsBufferAndDelivered() {
        var buf = PtyByteBuffer()
        var received: [Data] = []
        buf.registerHook { received.append($0) }
        buf.append(Data([0x41, 0x42, 0x43]))

        buf.reset()

        XCTAssertEqual(buf.count, 0)
        XCTAssertEqual(buf.delivered, 0)
        // hook 자체는 유지 — 다음 append 가 새 hook 호출.
        buf.append(Data([0x44]))
        XCTAssertEqual(received.last, Data([0x44]))
    }

    /// 시뮬레이트: WS 와 polling 양쪽이 같은 chunk 를 시도해도 ChatViewModel 의
    /// seenMessageIds 가드를 통과한 후 PtyByteBuffer 까지 도달한 chunk 는 «새 chunk» 임
    /// — buffer 는 무조건 누적. 이중 입력 차단은 *상위 레이어 (seenMessageIds) 의 책임*
    /// 임을 명시. PtyByteBuffer 는 같은 bytes 를 두 번 append 하면 두 번 흘린다.
    func testAppendSameBytesTwice_StreamsBoth_DedupIsCallerResponsibility() {
        var buf = PtyByteBuffer()
        var received: [Data] = []
        buf.registerHook { received.append($0) }

        let chunk = Data([0x41, 0x42])
        buf.append(chunk)
        buf.append(chunk)

        XCTAssertEqual(received, [chunk, chunk])
        XCTAssertEqual(buf.count, 4)
    }

    // MARK: - Predictive local echo

    func testPredict_FeedsBytesImmediately_RecordsInQueue() {
        var buf = PtyByteBuffer()
        var received: [Data] = []
        buf.registerHook { received.append($0) }

        buf.predict(Data([0x41, 0x42]))  // "AB"

        XCTAssertEqual(received, [Data([0x41, 0x42])])
        XCTAssertEqual(buf.pendingPredictionCount, 2)
        XCTAssertEqual(buf.delivered, 2)
    }

    /// 서버 echo 가 prediction 과 정확히 일치 → hook 재호출 없이 prediction 소비.
    func testPredict_MatchingServerEcho_NoDuplicateFeed() {
        var buf = PtyByteBuffer()
        var received: [Data] = []
        buf.registerHook { received.append($0) }

        buf.predict(Data([0x41, 0x42]))  // 화면 "AB"
        received.removeAll()
        buf.append(Data([0x41, 0x42]))   // 서버 echo "AB"

        XCTAssertEqual(received, [], "이미 그렸으니 hook 재호출 X")
        XCTAssertEqual(buf.pendingPredictionCount, 0)
    }

    /// 서버 bytes 가 prediction 보다 더 길게 옴 → prefix 는 소비, 나머지만 feed.
    func testPredict_ServerEchoLongerThanPrediction_OnlyRemainderFed() {
        var buf = PtyByteBuffer()
        var received: [Data] = []
        buf.registerHook { received.append($0) }

        buf.predict(Data([0x41]))                  // 화면 "A"
        received.removeAll()
        buf.append(Data([0x41, 0x42, 0x43]))       // 서버 "ABC"

        XCTAssertEqual(received, [Data([0x42, 0x43])], "예측된 'A' 는 skip, 'BC' 만 추가")
        XCTAssertEqual(buf.pendingPredictionCount, 0)
    }

    /// 서버 bytes 가 prediction 보다 짧음 — partial 매칭 후 다음 append 에서 나머지 매칭.
    func testPredict_ServerEchoArrivesInChunks_ConsumesAcrossCalls() {
        var buf = PtyByteBuffer()
        var received: [Data] = []
        buf.registerHook { received.append($0) }

        buf.predict(Data([0x48, 0x69]))            // 화면 "Hi"
        received.removeAll()
        buf.append(Data([0x48]))                   // 서버 첫 청크 "H"
        XCTAssertEqual(received, [])
        XCTAssertEqual(buf.pendingPredictionCount, 1, "'i' 만 남음")

        buf.append(Data([0x69, 0x0a]))             // 서버 두 번째 청크 "i\n"
        XCTAssertEqual(received, [Data([0x0a])], "'i' 는 매칭, '\\n' 만 추가")
        XCTAssertEqual(buf.pendingPredictionCount, 0)
    }

    /// 분기점 — 서버 echo 가 prediction 과 도중에 달라지면 남은 prediction 폐기 + 서버
    /// bytes 의 분기 이후 suffix 만 feed.
    func testPredict_MismatchDiscardsRemainingPrediction() {
        var buf = PtyByteBuffer()
        var received: [Data] = []
        buf.registerHook { received.append($0) }

        buf.predict(Data([0x41, 0x42, 0x43]))   // 화면 "ABC"
        received.removeAll()
        buf.append(Data([0x41, 0x58, 0x59]))    // 서버 "AXY" — index 1 에서 분기

        XCTAssertEqual(received, [Data([0x58, 0x59])], "'A' 는 매칭, 'XY' 는 새로 feed")
        XCTAssertEqual(buf.pendingPredictionCount, 0, "남은 'BC' 예측 폐기")
    }

    /// 분기 후에도 buffer 는 정상 동작 — 후속 prediction / append 가 멱등.
    func testPredict_AfterMismatch_ResumesNormalAppend() {
        var buf = PtyByteBuffer()
        var received: [Data] = []
        buf.registerHook { received.append($0) }

        buf.predict(Data([0x41, 0x42]))
        buf.append(Data([0x58]))                // 즉시 mismatch — 'A' 와 다름
        received.removeAll()
        buf.append(Data([0x59, 0x5a]))          // 후속 정상 append

        XCTAssertEqual(received, [Data([0x59, 0x5a])])
        XCTAssertEqual(buf.pendingPredictionCount, 0)
    }

    func testReset_ClearsPendingPrediction() {
        var buf = PtyByteBuffer()
        buf.registerHook { _ in }
        buf.predict(Data([0x41, 0x42]))
        XCTAssertEqual(buf.pendingPredictionCount, 2)

        buf.reset()
        XCTAssertEqual(buf.pendingPredictionCount, 0,
            "reset 후 다음 append 가 옛 예측과 우연 매칭 dedup 되지 않아야")
    }
}
