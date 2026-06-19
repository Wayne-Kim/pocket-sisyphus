import Foundation
import SwiftUI

/// daemon ↔ iOS 호환성 verdict 의 process-wide 보관소.
///
/// AppRoot 가 Tor .running 으로 진입 + auth.config != nil 이면 `refresh()` 를 한 번
/// 호출한다. verdict 이 .hardXxx 면 AppRoot 가 IncompatibleView 로 분기,
/// .softMissingCapabilities 면 SessionsView 위에 한 줄 배너를 띄운다.
///
/// 재호출 정책: 부팅 1회로 충분. daemon 은 런타임 자체 업데이트가 없고 iOS 도 마찬가지.
/// 사용자가 IncompatibleView 의 "다시 확인" 버튼을 누른 경우만 명시적으로 재호출한다.
@MainActor
final class VersionCompatStore: ObservableObject {
    /// 현재 verdict. nil = 아직 한 번도 fetch 시도 안 함 (또는 reset). 이 동안엔 AppRoot 가
    /// 호환성 검증을 "건너뛰고" 정상 흐름을 보여준다 — verdict 도착 전 0.5~2s 동안 사용자가
    /// 빈 차단 화면을 보지 않도록 하기 위함.
    @Published private(set) var verdict: CompatibilityVerdict?

    /// 마지막 시도가 네트워크/디코딩 에러로 실패한 경우의 메시지. nil 이면 에러 없거나 verdict
    /// 으로 정상 도착. Hard incompat 과 구분되는 상태 — 사용자 안내 다르게 한다 ("다시 시도").
    @Published private(set) var lastErrorMessage: String?

    /// 재호출 중복 방지.
    private var inflightTask: Task<Void, Never>?

    init() {
        // ApiClient 가 어떤 호출에서든 426 Upgrade Required 를 받으면 NotificationCenter 로
        // 알린다. 부팅 시 /api/version 핸드셰이크가 어떤 이유로든 누락되거나 (이를테면 페어링
        // 직후 첫 시도가 transient 실패) 옛 daemon 응답 후 새 daemon 으로 hot-swap 된 케이스
        // 에서도 — 실제 API 호출 시점에 daemon 이 426 으로 명시 거부하면 즉시 verdict 가
        // hardClientTooOld 로 전환되어 AppRoot 가 IncompatibleView 로 라우트한다.
        //
        // 클로저는 @MainActor 격리되지 않으므로 self 접근은 Task { @MainActor } 로 래핑.
        // store 는 App 수명 = 옵저버 수명. 명시 removeObserver 없이도 누수 없음.
        NotificationCenter.default.addObserver(
            forName: .clientTooOldDetected,
            object: nil,
            queue: .main,
        ) { [weak self] note in
            let min = note.userInfo?["minRequired"] as? String ?? ""
            let client = note.userInfo?["clientVersion"] as? String ?? VersionCompat.currentAppVersion
            Task { @MainActor [weak self] in
                guard let self else { return }
                // 이미 같은 verdict 면 idempotent — @Published 알림이 또 가도 무해하지만
                // 명시 가드로 불필요한 view 재계산을 줄인다.
                if case .hardClientTooOld = self.verdict { return }
                self.verdict = .hardClientTooOld(clientVersion: client, minRequired: min)
            }
        }
    }

    /// daemon `/api/version` 호출 후 verdict 갱신. 이미 진행 중이면 같은 결과 await.
    func refresh(api: ApiClient) async {
        if let inflightTask {
            await inflightTask.value
            return
        }
        // [weak self] 로 들고 가면 `self?.…` 가 Void? 를 돌려 Task<()?, Never> 가 돼서 우리
        // 프로퍼티 타입(Task<Void, Never>) 과 어긋난다. 이 store 는 App 수명만큼 살아있는
        // @StateObject 라 strong capture 로 충분하다 (cycle 안 만듦 — Task 가 끝나면 alloc 해제).
        let task = Task {
            await self.performRefresh(api: api)
        }
        inflightTask = task
        await task.value
        inflightTask = nil
    }

    private func performRefresh(api: ApiClient) async {
        do {
            let info = try await api.getServerVersion()
            let client = VersionCompat.currentAppVersion
            let v = CompatibilityVerdict.evaluate(server: info, clientVersion: client)
            self.verdict = v
            self.lastErrorMessage = nil
        } catch ApiError.httpStatus(let code, _) where code == 404 {
            // `/api/version` 자체를 모르는 옛 daemon. Hard 로 취급 — Mac 앱 업데이트 안내.
            self.verdict = .hardDaemonUnknown
            self.lastErrorMessage = nil
        } catch {
            // 진짜 네트워크 에러 / 디코딩 에러. Hard 로 차단하지는 않음 — 사용자가 같은 Mac
            // 버전을 계속 쓰는데 일시적 Tor 끊김으로 우리가 verdict 못 받은 케이스에서
            // 차단 화면이 뜨면 비합리적. 에러 메시지만 들고 있고, verdict 는 nil 유지 →
            // AppRoot 는 정상 흐름. 사용자가 어떤 기능을 실제로 trigger 했을 때 그쪽
            // 자체 에러 흐름이 표면화된다.
            if ApiError.isCancellation(error) {
                // 화면 전환 등으로 인한 task cancel — 조용히 무시.
                return
            }
            self.lastErrorMessage = error.localizedDescription
        }
    }

    /// 사용자가 IncompatibleView 의 "다시 확인" 버튼을 누른 경우. inflight 가 있으면
    /// 같은 task 결과를 받아간다.
    func userRequestedRecheck(api: ApiClient) async {
        await refresh(api: api)
    }

    /// 페어 해제/재페어 등 baseline 이 바뀐 경우 호출.
    func reset() {
        verdict = nil
        lastErrorMessage = nil
        inflightTask?.cancel()
        inflightTask = nil
    }
}
