import Testing
import SwiftUI

// WorkflowEdgeRouter.swift 는 host-less library test 패턴으로 이 번들에 직접 컴파일된다
// (project.yml 의 PocketSisyphusTests.sources 참고). SwiftUI Path 만 의존하는 순수 기하라
// Tor/SSH 같은 무거운 의존을 끌어오지 않는다.
//
// 목적: 세 캔버스가 공유하는 엣지 라우터(곡선 베지어 + 중간 노드 자동 우회)의 «동작 계약» 을
// 회귀 차단으로 박는다 — 끝점 보정·포트 출발 방향·장애물 우회·출발/도착 노드 제외.
// (SwiftUI Path 는 좌표를 Float 로 저장하므로, Path 에서 꺼낸 점 비교엔 Float 여유 tolerance 를 쓴다.)

@Suite("WorkflowEdgeRouter — 곡선 + 중간 노드 자동 우회")
struct WorkflowEdgeRouterTests {

    private let nodeH: CGFloat = 70           // 3캔버스 실사용 노드 높이
    private let inset: CGFloat = 70 / 2 + 4   // 끝점 당김 거리(39)
    private let tol: CGFloat = 0.05           // Path Float 저장 round-trip 여유

    /// Path 의 .curve(to:control1:control2:) 요소를 추출.
    private func curve(of path: Path) -> (c1: CGPoint, c2: CGPoint, end: CGPoint)? {
        var r: (CGPoint, CGPoint, CGPoint)?
        path.forEach { el in
            if case .curve(let to, let control1, let control2) = el { r = (control1, control2, to) }
        }
        return r.map { (c1: $0.0, c2: $0.1, end: $0.2) }
    }

    /// Path 의 시작점(.move).
    private func start(of path: Path) -> CGPoint? {
        var s: CGPoint?
        path.forEach { el in if case .move(let p) = el, s == nil { s = p } }
        return s
    }

    @Test("장애물 없음 — 끝점은 도착 중심에서 nodeH/2+4 만큼 당겨지고, 곡선이 from→end 로 그려진다")
    func noObstacleEndpointInset() {
        let from = CGPoint(x: 100, y: 100)
        let to = CGPoint(x: 100, y: 400)
        let routed = routeWorkflowEdge(from: from, to: to, condition: nil, nodeRects: [], nodeH: nodeH)
        // 수직 아래 → end = (100, 400 - 39) = (100, 361).
        #expect(abs(routed.end.x - 100) < 1e-9)
        #expect(abs(routed.end.y - 361) < 1e-9)
        // 곡선 본체: from 에서 시작, end 에서 끝.
        if let s = start(of: routed.path) {
            #expect(abs(s.x - from.x) < tol && abs(s.y - from.y) < tol)
        } else { Issue.record("Path 시작점(.move)이 없음") }
        if let cv = curve(of: routed.path) {
            #expect(abs(cv.end.x - routed.end.x) < tol && abs(cv.end.y - routed.end.y) < tol)
        } else { Issue.record("곡선(.curve) 요소가 없음") }
        // mid 는 곡선 위 중앙점.
        #expect(routed.arrowAngle.isFinite)
    }

    @Test("성공 포트는 하단(세로)에서, 실패 포트는 우측(가로)에서 출발")
    func portExitDirection() {
        let from = CGPoint(x: 100, y: 100)
        let to = CGPoint(x: 400, y: 400)
        let dx = to.x - from.x, dy = to.y - from.y
        let len = (dx * dx + dy * dy).squareRoot()
        let h = min(max(len * 0.4, 16), 120)
        // 성공(nil): c1 = (from.x, from.y + h) — 아래로.
        if let cv = curve(of: routeWorkflowEdge(from: from, to: to, condition: nil, nodeRects: [], nodeH: nodeH).path) {
            #expect(abs(cv.c1.x - from.x) < tol)
            #expect(abs(cv.c1.y - (from.y + h)) < tol)
        } else { Issue.record("곡선 없음(성공)") }
        // 실패: c1 = (from.x + h, from.y) — 오른쪽으로.
        if let cv = curve(of: routeWorkflowEdge(from: from, to: to, condition: "fail", nodeRects: [], nodeH: nodeH).path) {
            #expect(abs(cv.c1.x - (from.x + h)) < tol)
            #expect(abs(cv.c1.y - from.y) < tol)
        } else { Issue.record("곡선 없음(실패)") }
    }

    @Test("중간 노드를 가로지르면 우회 — 결과 곡선이 장애물 사각형을 통과하지 않는다")
    func detoursAroundObstacle() {
        let from = CGPoint(x: 100, y: 100)
        let to = CGPoint(x: 100, y: 460)
        // 직선 경로(x≈100) 위에 정확히 놓인 중간 노드. from/to 는 품지 않음.
        let blocker = CGRect(x: 40, y: 230, width: 120, height: 60)   // x[40,160], y[230,290]
        let routed = routeWorkflowEdge(from: from, to: to, condition: nil, nodeRects: [blocker], nodeH: nodeH)
        guard let cv = curve(of: routed.path) else { Issue.record("곡선 없음"); return }
        // 우회 성공이면 곡선 샘플이 장애물 사각형 내부에 하나도 없어야 한다.
        var insideCount = 0
        let steps = 200
        for i in 0...steps {
            let t = CGFloat(i) / CGFloat(steps)
            let pt = cubicBezierPoint(from, cv.c1, cv.c2, routed.end, t)
            if blocker.contains(pt) { insideCount += 1 }
        }
        #expect(insideCount == 0, "곡선이 장애물을 \(insideCount)개 점에서 통과 — 우회 실패")
        // 곡선이 실제로 휘었는지 — 기본(우회 전) 세로 제어점과 달라졌다는 증거.
        let defaultH = min(max((460 - 100 - inset) * 0.4, 16), 120)
        let movedX = abs(cv.c1.x - from.x) > 1
        let movedY = abs(cv.c1.y - (from.y + defaultH)) > 1
        #expect(movedX || movedY, "제어점이 기본과 동일 — 우회가 적용되지 않음")
    }

    @Test("출발·도착 노드는 우회 대상에서 제외 — 두 노드만 있으면 휘지 않는다")
    func endpointsNotTreatedAsObstacles() {
        let from = CGPoint(x: 100, y: 135)   // 출발 노드 하단 포트
        let to = CGPoint(x: 100, y: 400)     // 도착 노드 중심
        let fromNode = CGRect(x: 16, y: 65, width: 168, height: 70)   // from(100,135) 포함
        let toNode = CGRect(x: 16, y: 365, width: 168, height: 70)    // to(100,400) 포함
        let plain = routeWorkflowEdge(from: from, to: to, condition: nil, nodeRects: [], nodeH: nodeH)
        let withNodes = routeWorkflowEdge(from: from, to: to, condition: nil, nodeRects: [fromNode, toNode], nodeH: nodeH)
        guard let a = curve(of: plain.path), let b = curve(of: withNodes.path) else { Issue.record("곡선 없음"); return }
        // 출발/도착 노드는 obstacle 에서 빠지므로 제어점이 기본과 동일.
        #expect(abs(a.c1.x - b.c1.x) < tol && abs(a.c1.y - b.c1.y) < tol)
        #expect(abs(a.c2.x - b.c2.x) < tol && abs(a.c2.y - b.c2.y) < tol)
        #expect(abs(a.end.x - b.end.x) < tol && abs(a.end.y - b.end.y) < tol)
    }
}
