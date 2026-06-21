import Foundation

/// 함대(여러 세션)의 상태를 Live Activity 에 넣을 «스냅샷» 으로 환원하는 **순수** 로직.
///
/// UI·ActivityKit·네트워크 의존이 전혀 없어, host-less 유닛 테스트(PocketSisyphusTests)가 이
/// 파일만 따로 컴파일해 카운트·시급 세션 선정·빈 상태 계약을 회귀 차단한다. `SessionSummary`
/// 자체는 ApiClient.swift 의 무거운 의존성과 묶여 있어 테스트 번들에 못 들이므로, 스냅샷이
/// 필요로 하는 «최소» 형태만 `FleetSessionLike` 프로토콜로 분리하고 SessionSummary 가 앱
/// 타겟에서 conform 한다(FleetLiveActivityController.swift).

/// 오케스트레이션 상태 — `SessionRunState` 의 순수 거울(테스트 번들이 ApiClient 를 못 들이므로
/// 별도 정의하고 SessionSummary.runState 를 여기로 매핑한다).
enum FleetRunState { case waiting, running, done }

/// 스냅샷 derivation 이 보는 세션의 «최소» 표면. SessionSummary 가 extension 으로 conform.
protocol FleetSessionLike {
    var fleetId: String { get }
    /// repo 폴더명 (verbatim). 없으면 nil.
    var fleetRepoName: String? { get }
    /// 세션 제목 (verbatim). 빈/공백이면 nil.
    var fleetTitle: String? { get }
    var fleetRunState: FleetRunState { get }
    /// 대기 시작 시각(epoch ms) — 대기 세션 중 «가장 오래 기다린 것» 정렬용. 대기 아님은 nil.
    var fleetWaitingSince: Int64? { get }
    /// 완료 중 «오류로 끝난» 세션인지.
    var fleetIsError: Bool { get }
}

/// 가장 시급한 세션 한 줄의 식별 메타 (코드/대화 본문 없음).
struct FleetUrgent: Equatable {
    let sessionId: String
    let repoName: String?
    let title: String?
    /// 대기(입력 필요) 세션인지 — 표시 색(accent vs success) 분기.
    let isWaiting: Bool
}

/// 함대 한 장의 스냅샷 — Live Activity ContentState 의 source.
struct FleetSnapshot: Equatable {
    var waiting: Int
    var running: Int
    var done: Int
    var errors: Int
    var urgent: FleetUrgent?

    /// 활성(대기+실행) — 0 이면 Live Activity 를 띄우지 않는다(빈 상태).
    var activeCount: Int { waiting + running }

    static let empty = FleetSnapshot(waiting: 0, running: 0, done: 0, errors: 0, urgent: nil)
}

enum FleetActivityModel {
    /// 세션 목록 → 스냅샷.
    ///
    /// 시급 세션 우선순위(브리프: «가장 시급한 세션 한 줄»):
    ///  1) 대기 세션 중 «가장 오래 기다린 것»(`fleetWaitingSince` 최솟값; 시각 미상 nil 은 뒤로).
    ///  2) 대기 0건이면 `urgent = nil` — 실행만 있는 함대는 위젯이 «N개 실행 중» 일반 요약 줄을 그린다.
    static func snapshot<S: FleetSessionLike>(from sessions: [S]) -> FleetSnapshot {
        var waiting = 0, running = 0, done = 0, errors = 0
        for s in sessions {
            switch s.fleetRunState {
            case .waiting: waiting += 1
            case .running: running += 1
            case .done:
                done += 1
                if s.fleetIsError { errors += 1 }
            }
        }
        return FleetSnapshot(
            waiting: waiting, running: running, done: done, errors: errors,
            urgent: mostUrgent(from: sessions),
        )
    }

    /// 대기 세션 중 가장 오래 기다린 하나. 대기 0건이면 nil.
    private static func mostUrgent<S: FleetSessionLike>(from sessions: [S]) -> FleetUrgent? {
        let waiters = sessions.filter { $0.fleetRunState == .waiting }
        // min(by:) — 「a 가 b 보다 앞서야(작아야) 하는가」. 가장 작은 waiting_since 가 가장 오래 기다린 것.
        // 시각 미상(nil)은 «가장 큼(뒤)» 으로 취급해 시각이 있는 세션이 먼저 뽑히게 한다.
        let pick = waiters.min { a, b in
            switch (a.fleetWaitingSince, b.fleetWaitingSince) {
            case let (x?, y?): return x < y
            case (nil, _?): return false
            case (_?, nil): return true
            case (nil, nil): return false
            }
        }
        guard let p = pick else { return nil }
        return FleetUrgent(
            sessionId: p.fleetId, repoName: p.fleetRepoName, title: p.fleetTitle, isWaiting: true,
        )
    }
}
