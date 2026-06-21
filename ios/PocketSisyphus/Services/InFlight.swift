import Foundation
import SwiftUI

/// Tor 경유 요청은 매 호출에 2-3 초가 들기 때문에, 사용자가 능동적으로 트리거한 작업이 진행 중인지
/// 한눈에 확인할 수 있어야 한다. 폴링은 사용자가 의식적으로 한 행위가 아니라서 추적하지 않는다 —
/// `ApiClient` 가 호출 site 마다 `label` 을 제공할 때만 여기로 들어온다.
@MainActor
final class InFlightTracker: ObservableObject {
    struct Op: Identifiable, Equatable {
        let id = UUID()
        let label: String
        let startedAt: Date
    }

    @Published private(set) var ops: [Op] = []

    var count: Int { ops.count }
    var isActive: Bool { !ops.isEmpty }

    /// 새 작업을 시작했음을 등록하고 식별자를 돌려준다. 끝낼 때 `end(_:)` 에 전달.
    @discardableResult
    func begin(_ label: String) -> UUID {
        let op = Op(label: label, startedAt: Date())
        ops.append(op)
        return op.id
    }

    func end(_ id: UUID) {
        ops.removeAll { $0.id == id }
    }
}
