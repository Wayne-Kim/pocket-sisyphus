import ActivityKit
import SwiftUI

/// 「에이전트 함대」 Live Activity 의 «순수 SwiftUI 표현» — WidgetKit/ActivityKit 구성(Widget·
/// ActivityConfiguration·DynamicIsland)과 분리한다. 그래야 host-less 유닛 테스트가 이 뷰들을
/// 직접 `ImageRenderer` 로 PNG 스냅샷 떠서 «레이아웃을 눈으로» 검증할 수 있다(시뮬레이터 잠금화면을
/// 띄우지 않고도). WidgetKit 의존은 `FleetLiveActivityWidget.swift` 에만 둔다.
///
/// 색·간격은 앱 디자인 토큰(`Theme`)을 그대로 따른다(위젯 타겟이 DesignTokens.swift 를 함께
/// 컴파일). 상태색 계약은 보드(SessionSummaryHeader)와 동일: 대기=accent(보라) · 실행=success(초록)
/// · 완료=.secondary(중립) · 오류=danger(빨강). pro(주황)·warning(노랑)은 쓰지 않는다.

// MARK: - 상태 종류 (색·아이콘·라벨의 단일 매핑)

/// 카운트 한 칸의 종류 — 보드(StatPill)와 «동일» 한 아이콘·의미색 계약.
enum FleetStatKind {
    case waiting
    case running
    case done(errors: Int)

    var systemImage: String {
        switch self {
        case .waiting: return "hourglass"
        case .running: return "circle.fill"
        case .done: return "checkmark.circle.fill"
        }
    }

    var color: Color {
        switch self {
        case .waiting: return Theme.accent   // 보라 — 경고 아님(주황/노랑 금지)
        case .running: return Theme.success  // 초록
        case .done: return .secondary        // 중립(자동 적응)
        }
    }

    /// localize 된 라벨 (위젯 카탈로그 — 10개 언어).
    var label: Text {
        switch self {
        case .waiting: return Text("대기")
        case .running: return Text("실행 중")
        case .done: return Text("완료")
        }
    }
}

// MARK: - 잠금화면 표현

struct FleetLockScreenView: View {
    let state: FleetActivityAttributes.ContentState

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.l) {
            HStack(spacing: Theme.Spacing.xl) {
                FleetStat(kind: .waiting, count: state.waiting)
                FleetStat(kind: .running, count: state.running)
                FleetStat(kind: .done(errors: state.errors), count: state.done)
                Spacer(minLength: 0)
            }
            FleetUrgentLine(state: state)
        }
        .padding(Theme.Spacing.xl)
    }
}

// MARK: - 카운트 한 칸 (아이콘 + 숫자 + 라벨)

struct FleetStat: View {
    let kind: FleetStatKind
    let count: Int

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
            HStack(spacing: Theme.Spacing.xs) {
                Image(systemName: kind.systemImage)
                    .font(.caption2.weight(.semibold))
                Text(verbatim: "\(count)")
                    .font(.title3.weight(.bold))
                    .monospacedDigit()
                // 완료 칸의 오류 서브 신호 — danger(빨강) 캡슐. (대기/실행 칸엔 없음.)
                if case let .done(errors) = kind, errors > 0 {
                    Text(verbatim: "\(errors)")
                        .font(.caption2.weight(.bold))
                        .monospacedDigit()
                        .foregroundStyle(Theme.onAccent)
                        .padding(.horizontal, Theme.Spacing.s)
                        .padding(.vertical, Theme.Spacing.xxs)
                        .background(Capsule().fill(Theme.danger))
                        .accessibilityHidden(true)  // 음성은 아래 통합 라벨이 흡수.
                }
            }
            .foregroundStyle(kind.color)
            kind.label
                .font(.caption2)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityLabel)
    }

    /// localize 된 통합 음성 라벨 — 카운트(+오류)를 한 문장으로. 보간(\(count))은 카탈로그
    /// 자동 추출 경로(%lld)를 탄다.
    private var accessibilityLabel: Text {
        switch kind {
        case .waiting: return Text("입력 대기 \(count)건")
        case .running: return Text("실행 중 \(count)건")
        case let .done(errors):
            return errors > 0
                ? Text("완료 \(count)건, 오류 \(errors)건")
                : Text("완료 \(count)건")
        }
    }
}

// MARK: - 다이내믹 아일랜드 compact/minimal 배지 (아이콘 + 숫자)

struct FleetCompactBadge: View {
    let kind: FleetStatKind
    let count: Int

    var body: some View {
        HStack(spacing: Theme.Spacing.xxs) {
            Image(systemName: kind.systemImage)
                .font(.caption2.weight(.semibold))
            Text(verbatim: "\(count)")
                .font(.caption.weight(.semibold))
                .monospacedDigit()
        }
        .foregroundStyle(kind.color)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(compactAccessibilityLabel)
    }

    private var compactAccessibilityLabel: Text {
        switch kind {
        case .waiting: return Text("입력 대기 \(count)건")
        case .running: return Text("실행 중 \(count)건")
        case .done: return Text("완료 \(count)건")
        }
    }
}

// MARK: - 가장 시급한 세션 한 줄

/// 시급 세션 한 줄 — «상태 라벨(localize)» + repo 폴더명·제목(verbatim). 코드/대화 본문은 없다.
/// 시급 세션이 없으면(실행만 있는 함대) «N개 실행 중» 일반 요약 줄을 그린다.
struct FleetUrgentLine: View {
    let state: FleetActivityAttributes.ContentState

    var body: some View {
        if state.urgentSessionId != nil {
            HStack(spacing: Theme.Spacing.s) {
                Image(systemName: state.urgentIsWaiting ? "hourglass" : "circle.fill")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(state.urgentIsWaiting ? Theme.accent : Theme.success)
                statusLabel
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(state.urgentIsWaiting ? Theme.accent : Theme.success)
                if let name = state.urgentRepoName {
                    Text(verbatim: name)  // verbatim — 사용자/에이전트 데이터(번역 대상 아님)
                        .font(.caption)
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                }
                if let title = state.urgentTitle {
                    Text(verbatim: "· \(title)")  // verbatim
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            .accessibilityElement(children: .combine)
        } else {
            Text("에이전트 \(state.running)개 실행 중")  // localize (%lld 보간)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
    }

    /// 대기/실행 상태 라벨 — 삼항 대신 분기해 각각 LocalizedStringKey 추출 경로를 타게 한다.
    private var statusLabel: Text {
        if state.urgentIsWaiting {
            return Text("입력 대기")
        } else {
            return Text("실행 중")
        }
    }
}
