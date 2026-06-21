import Testing

// FleetActivityModel.swift 는 host-less library test 패턴으로 이 번들에 직접 컴파일된다
// (project.yml 의 PocketSisyphusTests.sources). 「에이전트 함대」 Live Activity 의 스냅샷
// derivation — 카운트·시급 세션 선정·빈 상태 — 의 동작 계약을 회귀 차단한다.

/// 테스트용 최소 세션 — `FleetSessionLike` 만 만족하면 SessionSummary 없이 검증 가능.
private struct MockSession: FleetSessionLike {
    var fleetId: String
    var fleetRepoName: String?
    var fleetTitle: String?
    var fleetRunState: FleetRunState
    var fleetWaitingSince: Int64?
    var fleetIsError: Bool

    init(
        _ id: String, _ state: FleetRunState,
        repo: String? = nil, title: String? = nil, waitingSince: Int64? = nil, error: Bool = false,
    ) {
        self.fleetId = id
        self.fleetRunState = state
        self.fleetRepoName = repo
        self.fleetTitle = title
        self.fleetWaitingSince = waitingSince
        self.fleetIsError = error
    }
}

@Suite("FleetActivityModel.snapshot")
struct FleetActivitySnapshotTests {

    @Test("빈 목록 → 빈 스냅샷, 활성 0건")
    func emptyList() {
        let snap = FleetActivityModel.snapshot(from: [MockSession]())
        #expect(snap == FleetSnapshot.empty)
        #expect(snap.activeCount == 0)
        #expect(snap.urgent == nil)
    }

    @Test("상태별 카운트 + 오류 서브 카운트")
    func counts() {
        let snap = FleetActivityModel.snapshot(from: [
            MockSession("a", .waiting, waitingSince: 100),
            MockSession("b", .waiting, waitingSince: 200),
            MockSession("c", .running),
            MockSession("d", .done),
            MockSession("e", .done, error: true),
            MockSession("f", .done, error: true),
        ])
        #expect(snap.waiting == 2)
        #expect(snap.running == 1)
        #expect(snap.done == 3)
        #expect(snap.errors == 2)
        #expect(snap.activeCount == 3)  // 대기+실행
    }

    @Test("시급 세션 = 가장 오래 기다린 대기 세션(waiting_since 최소)")
    func mostUrgentIsOldestWaiter() {
        let snap = FleetActivityModel.snapshot(from: [
            MockSession("recent", .waiting, repo: "repoR", title: "T", waitingSince: 5_000),
            MockSession("oldest", .waiting, repo: "repoO", title: "U", waitingSince: 1_000),
            MockSession("mid", .waiting, waitingSince: 3_000),
            MockSession("run", .running),
        ])
        #expect(snap.urgent?.sessionId == "oldest")
        #expect(snap.urgent?.repoName == "repoO")
        #expect(snap.urgent?.title == "U")
        #expect(snap.urgent?.isWaiting == true)
    }

    @Test("waiting_since nil 은 뒤로 — 시각이 있는 대기 세션이 먼저 뽑힌다")
    func nilWaitingSinceOrderedLast() {
        let snap = FleetActivityModel.snapshot(from: [
            MockSession("noTime", .waiting, waitingSince: nil),
            MockSession("hasTime", .waiting, waitingSince: 9_999),
        ])
        #expect(snap.urgent?.sessionId == "hasTime")
    }

    @Test("모든 대기가 시각 미상이어도 하나는 뽑는다(대기는 항상 시급 후보)")
    func allNilWaitingStillPicksOne() {
        let snap = FleetActivityModel.snapshot(from: [
            MockSession("x", .waiting, waitingSince: nil),
            MockSession("y", .waiting, waitingSince: nil),
        ])
        #expect(snap.urgent != nil)
        #expect(snap.urgent?.isWaiting == true)
    }

    @Test("대기 0건이면 urgent = nil (실행만 있는 함대 — 위젯이 일반 요약 줄)")
    func runningOnlyHasNoUrgent() {
        let snap = FleetActivityModel.snapshot(from: [
            MockSession("r1", .running),
            MockSession("r2", .running),
            MockSession("d1", .done),
        ])
        #expect(snap.urgent == nil)
        #expect(snap.running == 2)
        #expect(snap.activeCount == 2)
    }

    @Test("완료만 있으면 활성 0건 → Live Activity 미표시 신호")
    func doneOnlyIsInactive() {
        let snap = FleetActivityModel.snapshot(from: [
            MockSession("d1", .done),
            MockSession("d2", .done, error: true),
        ])
        #expect(snap.activeCount == 0)
        #expect(snap.errors == 1)
        #expect(snap.urgent == nil)
    }
}
