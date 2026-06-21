import SwiftUI

/// PO 흐름(수집/리서치/승인) 공용 에이전트 픽커 섹션.
/// 원래 BacklogView.swift 안에 private 으로 있던 것을 동작 그대로(접근 수준만 private→internal) 옮긴 것 — 행동보존 추출. 색·문자열·레이아웃 그대로.
// MARK: - 에이전트 픽커

/// PO 흐름(수집/리서치/승인) 공용 에이전트 픽커 — 예약 작업(CronEditorSheet)의 agentSection 과
/// 같은 모양. agents 가 비어 있으면(po_agent_v1 미지원 daemon / 후보 1개) 호출부가 아예 안 그린다.
struct PoAgentSection<Footer: View>: View {
    let agents: [AgentInfo]
    @Binding var selection: String
    @ViewBuilder let footer: () -> Footer

    var body: some View {
        Section {
            Picker(selection: $selection) {
                ForEach(agents) { a in
                    HStack(spacing: 8) {
                        Image(systemName: AgentKind.from(id: a.id).systemImage)
                        Text(a.displayName)
                        if !a.isInstalled {
                            Text("설정 필요").font(.caption2).foregroundStyle(Theme.warning)
                        }
                    }
                    .tag(a.id)
                }
            } label: {
                Text("CLI 도구")
            }
            .pickerStyle(.inline)
            .labelsHidden()
            .accessibilityLabel(Text("CLI 도구"))
        } header: {
            Text("에이전트")
        } footer: {
            footer()
        }
    }
}

extension PoAgentSection where Footer == EmptyView {
    init(agents: [AgentInfo], selection: Binding<String>) {
        self.init(agents: agents, selection: selection) { EmptyView() }
    }
}
