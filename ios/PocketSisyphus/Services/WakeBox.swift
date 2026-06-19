import Foundation

/// 단일 슬롯 wake/sleep 헬퍼. WS push 가 timeout fallback 보다 먼저 들어오면 sleep 을 즉시 깨운다.
///
/// 이전엔 짧은 주기 폴링 (1.5–5s) 으로 Tor 위에 매 cycle 라운드트립을 태웠는데, 이제는
/// 30s+ 라는 긴 fallback 으로 자고 있다가 서버 변동 (WS push) 으로 즉시 깨어나는 패턴.
/// 결과: idle 트래픽 거의 0, 변동 latency 도 폴링 주기 → 단방향 push 로 단축.
///
/// ## Lost wakeup 방지
/// refresh() 가 도는 동안 wake() 가 와도 continuation 슬롯이 비어 있어서 wake 가 그냥
/// 버려지는 race 가 있다. `pending` 플래그로 보상 — wake() 가 빈 슬롯에 들어오면 플래그를
/// 세팅하고, 다음 arm() 호출이 cont 를 등록하기 전에 즉시 resume 하고 플래그를 끈다.
/// 결과: refresh() 도는 중 들어온 N개의 wake 가 다음 cycle 한 번으로 코알레스.
///
/// ChatViewModel, SessionsView 가 동일 패턴으로 쓴다. 분량이 적어 각자 inline 하지 않고 이 클래스만 공유.
@MainActor
final class WakeBox {
    private var cont: CheckedContinuation<Void, Never>?
    /// wake() 가 와있는데 sleeper 가 아직 없을 때 set. 다음 arm() 이 이걸 보고 즉시 통과.
    private var pending: Bool = false

    /// sleep 슬롯에 continuation 등록. 이미 pending 이면 즉시 통과 (lost-wakeup 보상).
    /// 이미 cont 가 차 있으면 옛 것을 깨우고 새로 셋팅 — sleeper 두 개가 동시에 같은 box 를
    /// 쓰는 시나리오는 우리 호출자에 없지만 안전망.
    func arm(_ cont: CheckedContinuation<Void, Never>) {
        if pending {
            pending = false
            cont.resume()
            return
        }
        if let old = self.cont {
            old.resume()
        }
        self.cont = cont
    }

    /// 잠든 sleeper 가 있다면 깨운다. 없으면 pending 플래그를 세팅해서 다음 arm 이 즉시
    /// 통과하게 한다. 여러 번 호출해도 안전 (pending 은 boolean, 중복 의미 없음).
    func wake() {
        if let c = cont {
            cont = nil
            c.resume()
        } else {
            pending = true
        }
    }
}

/// max `seconds` 동안 자거나, `box.wake()` 호출로 깨어난다 (둘 중 먼저).
/// Task 가 cancel 되면 cancellation handler 가 box 를 깨워 즉시 빠져나온다.
@MainActor
func sleepUntilWakeOrTimeout(seconds: Double, box: WakeBox) async {
    let timeoutTask = Task { [weak box] in
        try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
        await MainActor.run { box?.wake() }
    }
    await withTaskCancellationHandler {
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            if Task.isCancelled {
                cont.resume()
                return
            }
            box.arm(cont)
        }
    } onCancel: {
        Task { @MainActor [weak box] in
            box?.wake()
        }
    }
    timeoutTask.cancel()
}
