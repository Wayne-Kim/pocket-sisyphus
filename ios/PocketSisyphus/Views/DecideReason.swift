import SwiftUI

/// 보류/기각 사유 태그(po_decide_reason_v1) — enum·픽커·칩.
/// 원래 BacklogView.swift 안에 private 으로 있던 것을 동작 그대로(접근 수준만 private→internal) 옮긴 것 — 행동보존 추출. 색·문자열·레이아웃 그대로.
// MARK: - 보류/기각 사유 태그 (po_decide_reason_v1)

/// 결재 사유 태그 — daemon 의 허용 enum 키와 1:1. 결재가 «왜» 됐는지의 원천 데이터(후속 사유
/// 집계의 선행). 단건·일괄, reject·hold 가 같은 태그를 공유하고, 미선택을 허용(권장)해 강제
/// 마찰이 없다. rawValue 가 그대로 daemon body 의 reason 으로 간다.
enum DecideReason: String, CaseIterable, Identifiable {
    case priorityLow = "priority_low"
    case scopeTooBig = "scope_too_big"
    case alreadyExists = "already_exists"
    case weakEvidence = "weak_evidence"
    case wrongDirection = "wrong_direction"

    var id: String { rawValue }

    var label: Text {
        switch self {
        case .priorityLow: return Text("우선순위 낮음")
        case .scopeTooBig: return Text("범위 과대")
        case .alreadyExists: return Text("이미 있음")
        case .weakEvidence: return Text("근거 약함")
        case .wrongDirection: return Text("방향 안 맞음")
        }
    }

    /// 접근성 — 무엇을 고르는 칩인지 분명히. 각 라벨을 localize 된 «사유» 문맥으로 감싼다.
    var accessibilityLabel: Text {
        switch self {
        case .priorityLow: return Text("사유 태그: 우선순위 낮음")
        case .scopeTooBig: return Text("사유 태그: 범위 과대")
        case .alreadyExists: return Text("사유 태그: 이미 있음")
        case .weakEvidence: return Text("사유 태그: 근거 약함")
        case .wrongDirection: return Text("사유 태그: 방향 안 맞음")
        }
    }
}

/// 결재 사유 태그 줄 — «항상 제시»(빈 상태 없음), 1탭으로 단일 선택/해제. 미선택(nil)은 daemon 에
/// NULL 로 가 강제 마찰이 없다. 색 정책: 칩은 «선택 입력» 이라 선택 시 accent(보라), 미선택은
/// 중립 — status 색(빨강/노랑)을 장식으로 빌리지 않는다(기각 «동작» 버튼만 danger).
struct DecideReasonPicker: View {
    @Binding var selected: DecideReason?

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.s) {
            Text("사유 (선택)")
                .font(.caption2)
                .foregroundStyle(.secondary)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: Theme.Spacing.s) {
                    ForEach(DecideReason.allCases) { reason in
                        DecideReasonChip(reason: reason, selected: selected == reason) {
                            selected = (selected == reason) ? nil : reason
                        }
                    }
                }
                .padding(.vertical, Theme.Spacing.xxs)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// 사유 태그 칩 1개 — 선택 시 accent 채움, 미선택은 중립(TriageChip 과 동일 패턴).
struct DecideReasonChip: View {
    let reason: DecideReason
    let selected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            reason.label
                .font(.caption.weight(.medium))
                .padding(.horizontal, Theme.Spacing.xl)
                .padding(.vertical, Theme.Spacing.s)
                .background(
                    Capsule().fill(
                        selected
                            ? Theme.accent
                            : Theme.neutralFill.opacity(Theme.Opacity.fill)),
                )
                .foregroundStyle(selected ? Theme.onAccent : Color.primary)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(reason.accessibilityLabel)
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
    }
}
