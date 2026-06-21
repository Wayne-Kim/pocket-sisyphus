import ActivityKit
import SwiftUI
import WidgetKit

/// 「에이전트 함대」 Live Activity 의 WidgetKit 구성 — 잠금화면 배너 + 다이내믹 아일랜드.
///
/// 순수 SwiftUI 표현(FleetLockScreenView/FleetStat/FleetUrgentLine 등)은
/// `FleetLiveActivityViews.swift` 에 분리돼 있다(테스트가 ImageRenderer 로 스냅샷 검증 가능하도록).
/// 여기서는 ActivityKit 구성과 다이내믹 아일랜드 region 배치만 담당한다.
struct FleetLiveActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: FleetActivityAttributes.self) { context in
            // 잠금화면 / 배너 표현.
            FleetLockScreenView(state: context.state)
                .widgetURL(context.state.urgentDeepLink)
                .activitySystemActionForegroundColor(Theme.accent)
        } dynamicIsland: { context in
            dynamicIsland(context.state)
        }
    }

    private func dynamicIsland(_ state: FleetActivityAttributes.ContentState) -> DynamicIsland {
        DynamicIsland {
            // 확장 — 대기/실행/완료 + 시급한 한 줄.
            DynamicIslandExpandedRegion(.leading) {
                FleetStat(kind: .waiting, count: state.waiting)
            }
            DynamicIslandExpandedRegion(.trailing) {
                FleetStat(kind: .running, count: state.running)
            }
            DynamicIslandExpandedRegion(.center) {
                FleetStat(kind: .done(errors: state.errors), count: state.done)
            }
            DynamicIslandExpandedRegion(.bottom) {
                if let url = state.urgentDeepLink {
                    Link(destination: url) { FleetUrgentLine(state: state) }
                } else {
                    FleetUrgentLine(state: state)
                }
            }
        } compactLeading: {
            // 가장 시급한 지표 — 대기 있으면 대기(accent), 없으면 실행(success).
            if state.waiting > 0 {
                FleetCompactBadge(kind: .waiting, count: state.waiting)
            } else {
                FleetCompactBadge(kind: .running, count: state.running)
            }
        } compactTrailing: {
            // 보조 지표 — 대기가 있을 땐 실행 수를, 아니면 완료 수를 보여 둘을 한눈에.
            if state.waiting > 0 {
                FleetCompactBadge(kind: .running, count: state.running)
            } else {
                FleetCompactBadge(kind: .done(errors: state.errors), count: state.done)
            }
        } minimal: {
            if state.waiting > 0 {
                FleetCompactBadge(kind: .waiting, count: state.waiting)
            } else {
                FleetCompactBadge(kind: .running, count: state.running)
            }
        }
        .widgetURL(state.urgentDeepLink)
        .keylineTint(Theme.accent)
    }
}
