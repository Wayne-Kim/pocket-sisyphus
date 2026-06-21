import ActivityKit
import Combine
import Foundation

/// 「에이전트 함대」 Live Activity 의 수명(시작/갱신/종료)을 쥐는 단일 진실.
///
/// # 데이터 소스 — 앱 전역 단일 source of truth
/// `SessionListCache.$sessions`(앱 레벨 @StateObject, reload·prewarm·rename/delete 가 funnel)
/// 를 구독한다. 그래서 어느 화면이 떠 있든(세션 탭이 아니어도) 함대 상태가 바뀌면 잠금화면
/// Live Activity 가 따라 갱신된다. 여기에 더해, `AgentWaitNotifier` 의 글로벌 WS 가 «대기 진입/
/// 해소» 이벤트를 받으면 그 캐시를 다시 채워(scheduleFleetRefresh) running→waiting 전이가
/// «앱이 살아 있는 동안» 즉시 반영되게 한다.
///
/// # 갱신 경로 (브리프 1 의 «APNs» 가 이 레포엔 없음 — 의도된 «외부 인프라 0» 원칙)
/// 백그라운드(잠금 장시간) 갱신엔 ActivityKit push(APNs) 가 필요한데, 이 앱은 APNs 를 쓰지
/// 않는다(AgentWaitNotifier 주석 참고). 그래서 여기선 `pushType: nil` 로 시작하고 «라이브 WS 가
/// 살아 있는 동안»(포그라운드 + 짧은 백그라운드 윈도)만 `update` 한다. 잠금 장시간 백그라운드
/// 갱신은 향후 APNs 도입 시의 후속 작업으로 둔다.
@MainActor
final class FleetLiveActivityController {
    static let shared = FleetLiveActivityController()

    private var cancellable: AnyCancellable?
    private var activity: Activity<FleetActivityAttributes>?

    private init() {}

    /// `sessionCache.$sessions` 구독 시작 + 이전 실행에서 살아남은 Activity 재접속. 멱등.
    func bind(sessionCache: SessionListCache) {
        guard cancellable == nil else { return }
        // 앱 재시작 직후 이전 세션의 Activity 가 아직 떠 있으면 그걸 채택 — 새로 spawn 해 중복 표시되지 않게.
        activity = Activity<FleetActivityAttributes>.activities.first
        cancellable = sessionCache.$sessions
            .removeDuplicates()  // 같은 목록 재방출(예: 동일 prewarm 결과)엔 no-op.
            .sink { [weak self] list in
                self?.apply(FleetActivityModel.snapshot(from: list))
            }
    }

    /// 페어링 해제 — 구독 해제 + 활성 Activity 종료. (캐시도 곧 비지만, 즉시 정리한다.)
    func teardown() {
        cancellable = nil
        let current = activity
        activity = nil
        Task { await current?.end(nil, dismissalPolicy: .immediate) }
    }

    // MARK: - 내부

    private func apply(_ snap: FleetSnapshot) {
        // 사용자가 Live Activity 를 꺼 둔 경우(설정) 아무것도 안 한다.
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }

        // 빈 상태(활성 0건) — 떠 있던 Activity 가 있으면 종료, 없으면 그대로 둔다(시작 안 함).
        guard snap.activeCount > 0 else {
            guard let current = activity else { return }
            activity = nil
            Task { await current.end(nil, dismissalPolicy: .immediate) }
            return
        }

        let state = contentState(from: snap)
        if let activity {
            Task { await activity.update(ActivityContent(state: state, staleDate: nil)) }
        } else {
            startActivity(with: state)
        }
    }

    private func startActivity(with state: FleetActivityAttributes.ContentState) {
        do {
            activity = try Activity.request(
                attributes: FleetActivityAttributes(),
                content: ActivityContent(state: state, staleDate: nil),
                // APNs 미사용 — 라이브 WS 로컬 갱신만(위 주석). push-to-start/update 토큰 없음.
                pushType: nil,
            )
        } catch {
            NSLog("[FleetLiveActivity] 시작 실패: %@", error.localizedDescription)
        }
    }

    private func contentState(from snap: FleetSnapshot) -> FleetActivityAttributes.ContentState {
        FleetActivityAttributes.ContentState(
            waiting: snap.waiting, running: snap.running, done: snap.done, errors: snap.errors,
            urgentSessionId: snap.urgent?.sessionId,
            urgentRepoName: snap.urgent?.repoName,
            urgentTitle: snap.urgent?.title,
            urgentIsWaiting: snap.urgent?.isWaiting ?? false,
        )
    }
}

// MARK: - SessionSummary → 순수 모델 매핑

/// `FleetActivityModel`(순수, 테스트 가능)이 보는 최소 표면에 SessionSummary 를 끼운다.
/// 매핑은 SessionSummary 가 «이미 daemon 신호에서 파생한» runState/waiting_since 를 그대로 재사용한다.
extension SessionSummary: FleetSessionLike {
    var fleetId: String { id }

    /// repo_path 끝 폴더명 — worktree 세션도 자기 경로의 마지막 요소가 곧 식별명이다.
    var fleetRepoName: String? {
        let name = (repo_path as NSString).lastPathComponent
        return name.isEmpty ? nil : name
    }

    var fleetTitle: String? {
        guard let t = title?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty else { return nil }
        return t
    }

    var fleetRunState: FleetRunState {
        switch runState {
        case .waiting: return .waiting
        case .running: return .running
        case .done: return .done
        }
    }

    var fleetWaitingSince: Int64? { waiting_since }

    /// 완료 카운트의 오류 서브 신호 — SessionsView 의 errorCount(status=="error")와 동일 기준.
    var fleetIsError: Bool { status == "error" }
}
