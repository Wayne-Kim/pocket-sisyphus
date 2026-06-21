import SwiftUI
import WidgetKit

/// PocketSisyphus 위젯 확장의 엔트리. 현재는 「에이전트 함대」 Live Activity 하나만 담는다
/// (홈/잠금화면 위젯이나 Watch 글랜스는 이 번들에 추가하는 방식으로 확장 가능 — 브리프의
/// Watch 는 «선택» 이라 이번 범위에서 제외).
@main
struct PocketSisyphusWidgetBundle: WidgetBundle {
    var body: some Widget {
        FleetLiveActivityWidget()
    }
}
