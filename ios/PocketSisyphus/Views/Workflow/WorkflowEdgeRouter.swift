import SwiftUI

// MARK: - 공유 엣지 라우터 (워크플로우 캔버스 공통)
//
// 워크플로우 캔버스 «엣지(노드 사이 화살표)» 라우팅 — 출력 포트→도착 노드를 직선으로만 잇지 않고,
// 노드가 자유 배치돼도 중간 카드를 가로지르지 않게 곡선 베지어로 «적합한 선» 을 자동 선택한다.
//
// 세 캔버스(iOS 뷰어 WorkflowCanvasView·iOS 편집기 WorkflowEditorView·Mac 편집기 WorkflowWindow)가
// 이 «한 곳» 의 라우터를 호출한다 — 예전엔 같은 라우팅/끝점/화살촉 계산이 각 파일에 복붙돼 있어
// 「신규 선 형식」을 한 곳만 고치면 캔버스가 어긋났다. 이 파일이 그 단일 소스다.
//
// 책임 분리: 라우터(여기) = «기하» (곡선 본체 + 끝점·접선·중앙점). 색/선두께/실패 라벨 텍스트 같은
// «표현» 은 각 캔버스가 자기 디자인 토큰으로 입힌다(여긴 색을 모른다).
//
// ⚠️ Mac 미러: 같은 로직이 `mac/PocketSisyphusMac/Views/WorkflowEdgeRouter.swift` 에도 있다.
// Mac 은 별도 모듈/타깃이라 한 벌 더 둔다 — 이 레포는 iOS/Mac 노드·엣지 표현을 «항상 같이»
// 맞추는 컨벤션이다. 한쪽을 고치면 다른 쪽도 같이 (두 파일은 헤더 주석 외 동일하게 유지).

/// 라우팅된 엣지 기하 — 곡선 본체 + 화살촉/실패 라벨에 필요한 끝점·접선·중앙점.
struct RoutedWorkflowEdge {
    let path: Path           // 곡선 본체 (stroke 용)
    let end: CGPoint         // 화살촉 꼭짓점 (target 중심에서 nodeH/2 보정으로 당긴 끝점)
    let arrowAngle: CGFloat  // 끝점 접선 방향 (화살촉 회전)
    let mid: CGPoint         // 곡선 중앙점 (실패 라벨 위치)
}

/// 3차 베지어 위의 한 점.
func cubicBezierPoint(_ p0: CGPoint, _ c1: CGPoint, _ c2: CGPoint, _ p3: CGPoint, _ t: CGFloat) -> CGPoint {
    let mt = 1 - t
    let a = mt * mt * mt, b = 3 * mt * mt * t, c = 3 * mt * t * t, d = t * t * t
    return CGPoint(x: a * p0.x + b * c1.x + c * c2.x + d * p3.x,
                   y: a * p0.y + b * c1.y + c * c2.y + d * p3.y)
}

/// 출력 포트(from)에서 도착 노드 중심(to)으로 «직선 대신» 곡선 베지어로 라우팅한다.
/// 경로가 중간 노드 사각형과 교차하면 충돌 노드 중심이 직선의 어느 쪽에 몰렸는지로 휨 방향을 정하고,
/// 세기를 키워 가며 우회 경로를 자동 선택한다. 출발(from 이 닿는)·도착(to 를 품는) 노드는 우회 제외.
/// - condition: "fail" → 우측 포트(가로)에서 출발, 그 외 → 하단 포트(세로)에서 출발.
/// - nodeRects: 모든 노드 사각형(월드 좌표).
func routeWorkflowEdge(from: CGPoint, to: CGPoint, condition: String?,
                       nodeRects: [CGRect], nodeH: CGFloat) -> RoutedWorkflowEdge {
    let dx = to.x - from.x
    let dy = to.y - from.y
    let len = max(1, (dx * dx + dy * dy).squareRoot())
    let ux = dx / len, uy = dy / len
    // 당겨진 끝점 — target 중심에서 접근 방향으로 nodeH/2+4 만큼 당김(기존 보정 유지).
    let end = CGPoint(x: to.x - ux * (nodeH / 2 + 4), y: to.y - uy * (nodeH / 2 + 4))
    // 출력 포트가 나가는 방향 — 실패=우측(가로), 그 외=하단(세로).
    let outX: CGFloat = (condition == "fail") ? 1 : 0
    let outY: CGFloat = (condition == "fail") ? 0 : 1
    // 제어점 핸들 길이 — 거리 비례, 과한 휨 방지로 클램프.
    let h = min(max(len * 0.4, 16), 120)
    let c1 = CGPoint(x: from.x + outX * h, y: from.y + outY * h)
    let c2 = CGPoint(x: end.x - ux * h, y: end.y - uy * h)

    // 우회 대상 = 출발/도착을 제외한 중간 노드 (여유 margin 만큼 부풀림).
    let margin: CGFloat = 8
    let obstacles = nodeRects
        .filter { !$0.insetBy(dx: -1, dy: -1).contains(from) && !$0.contains(to) }
        .map { $0.insetBy(dx: -margin, dy: -margin) }

    func hits(_ a: CGPoint, _ b: CGPoint) -> Bool {
        guard !obstacles.isEmpty else { return false }
        let steps = max(24, min(96, Int(len / 24)))
        for i in 0...steps {
            let t = CGFloat(i) / CGFloat(steps)
            let pt = cubicBezierPoint(from, a, b, end, t)
            for r in obstacles where r.contains(pt) { return true }
        }
        return false
    }

    var finalC1 = c1, finalC2 = c2
    if hits(c1, c2) {
        let perpX = -uy, perpY = ux           // 직선에 수직
        // 충돌 후보 노드 중심들이 직선의 어느 쪽에 몰렸는지 — 반대쪽으로 먼저 휜다.
        var sideSum: CGFloat = 0
        for r in obstacles { sideSum += dx * (r.midY - from.y) - dy * (r.midX - from.x) }
        let firstSide: CGFloat = sideSum >= 0 ? -1 : 1
        search: for side in [firstSide, -firstSide] {
            var s: CGFloat = 40
            while s <= 280 {
                let ox = perpX * side * s, oy = perpY * side * s
                let a = CGPoint(x: c1.x + ox, y: c1.y + oy)
                let b = CGPoint(x: c2.x + ox, y: c2.y + oy)
                if !hits(a, b) { finalC1 = a; finalC2 = b; break search }
                s += 40
            }
        }
        // 다 막히면 기본 곡선 유지 — 직선보다 낫고 회귀 0.
    }

    var path = Path()
    path.move(to: from)
    path.addCurve(to: end, control1: finalC1, control2: finalC2)
    let tanX = end.x - finalC2.x, tanY = end.y - finalC2.y
    let arrowAngle = (abs(tanX) < 0.001 && abs(tanY) < 0.001) ? atan2(uy, ux) : atan2(tanY, tanX)
    let mid = cubicBezierPoint(from, finalC1, finalC2, end, 0.5)
    return RoutedWorkflowEdge(path: path, end: end, arrowAngle: arrowAngle, mid: mid)
}
