import SwiftUI

/// 세션 행에 붙는 «뱃지» 프리미티브 — 대기/실행 상태·에이전트 대기 행동·브랜치·소스 브리프·
/// 에이전트 종류. 원래 SessionsView.swift 안에 private 으로 있던 것을 동작 그대로(접근 수준만
/// private→internal) 옮긴 것 — 행동보존 추출. 색 의미 토큰·문자열·레이아웃 그대로.

/// «에이전트가 입력을 기다리는 중» 배지 — 상태 배지와 같은 capsule 모양, warning 색.
/// 노랑은 색상 정책상 «진짜 주의/액션 필요» 전용 — 막힌 에이전트가 정확히 그 경우다.
/// RunStateBadge(대기) 가 이 배지를 그대로 재사용한다.
struct WaitingBadge: View {
    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: "hourglass")
                .font(.caption2.weight(.semibold))
                .imageScale(.small)
            Text("입력 대기")
                .font(.caption2)
        }
        .padding(.horizontal, Theme.Spacing.m).padding(.vertical, Theme.Spacing.xxs)
        .background(Theme.warning.opacity(0.2))
        .foregroundStyle(Theme.warning)
        .clipShape(Capsule())
    }
}

/// 세션의 오케스트레이션 상태 배지 — 실행중(success)/대기(warning)/완료(중립)·오류(danger).
/// 대기는 기존 `WaitingBadge`(「입력 대기」)를 그대로 재사용해 신호를 일관되게 유지한다.
/// 색은 의미 토큰만 쓴다: 완료는 «끝남» 이지 «강조» 가 아니라 중립 회색(상태색 안 빌림).
struct RunStateBadge: View {
    let state: SessionRunState
    let status: String

    var body: some View {
        switch state {
        case .waiting:
            WaitingBadge()
        case .running:
            badge(icon: "circle.fill", text: "실행 중", color: Theme.success)
        case .done:
            // 완료 그룹 안에서도 «정상 완료» 와 «오류 종료» 는 다른 신호 — danger(빨강)로 가른다.
            if status == "error" {
                badge(icon: "exclamationmark.triangle.fill", text: "오류", color: Theme.danger)
            } else {
                badge(icon: "checkmark.circle.fill", text: "완료", color: .secondary)
            }
        }
    }

    private func badge(icon: String, text: LocalizedStringKey, color: Color) -> some View {
        HStack(spacing: 3) {
            Image(systemName: icon)
                .font(.caption2.weight(.semibold))
                .imageScale(.small)
            Text(text)
                .font(.caption2)
        }
        .padding(.horizontal, Theme.Spacing.m).padding(.vertical, Theme.Spacing.xxs)
        .background(color.opacity(0.2))
        .foregroundStyle(color)
        .clipShape(Capsule())
    }
}

/// 알림 액션(승인/중지) 처리 상태 배지 — `AgentWaitNotifier.actionStates` 를 관찰해 알림에서
/// 누른 결과를 세션 목록에서도 비춘다. «대기» 상태는 RunStateBadge 가 이미 표현하므로 여기선
/// 처리중/완료/실패만 그린다. 색은 의미 토큰: 처리중=accent(브랜드), 완료=success(초록),
/// 실패=danger(빨강). 배지 자체 font/색을 가져 카드 줄의 .tertiary 에 물들지 않는다.
struct AgentWaitActionBadge: View {
    let sessionId: String
    @ObservedObject private var notifier = AgentWaitNotifier.shared

    var body: some View {
        switch notifier.actionStates[sessionId] {
        case .processing:
            badge(icon: "hourglass", text: "처리 중", color: Theme.accent)
        case .done:
            badge(icon: "checkmark.circle.fill", text: "처리 완료", color: Theme.success)
        case .failed:
            badge(icon: "exclamationmark.triangle.fill", text: "처리 실패", color: Theme.danger)
        case .waiting, .none:
            // 대기는 RunStateBadge 가 표시, 상태 없으면 아무것도 안 그린다.
            EmptyView()
        }
    }

    private func badge(icon: String, text: LocalizedStringKey, color: Color) -> some View {
        HStack(spacing: 3) {
            Image(systemName: icon)
                .font(.caption2.weight(.semibold))
                .imageScale(.small)
            Text(text)
                .font(.caption2)
        }
        .padding(.horizontal, Theme.Spacing.m).padding(.vertical, Theme.Spacing.xxs)
        .background(color.opacity(Theme.Opacity.badge))
        .foregroundStyle(color)
        .clipShape(Capsule())
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityText)
    }

    private var accessibilityText: Text {
        switch notifier.actionStates[sessionId] {
        case .processing: return Text("알림 액션 처리 중")
        case .done: return Text("알림 액션 처리 완료")
        case .failed: return Text("알림 액션 처리 실패 — 세션을 열어 직접 처리하세요")
        case .waiting, .none: return Text("")
        }
    }
}

/// worktree 브랜치 배지 — 세션이 어느 격리 브랜치(작업 폴더)에서 도는지. 브랜치는 «구조»
/// 신호라 상태색(success/warning/danger)을 빌리지 않고 중립 회색 칩으로 둔다. slug 는
/// daemon 의 `<repo>.worktrees/<slug>` 폴더명(=식별자)이라 번역 대상이 아니다(verbatim).
struct BranchBadge: View {
    let slug: String
    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: "arrow.triangle.branch")
                .font(.caption2.weight(.semibold))
                .imageScale(.small)
            Text(verbatim: slug)
                .font(.caption2.weight(.medium))
                .lineLimit(1)
                .truncationMode(.middle)
        }
        .padding(.horizontal, Theme.Spacing.s).padding(.vertical, Theme.Spacing.xxs)
        .background(Theme.neutralFill.opacity(Theme.Opacity.fill))
        .foregroundStyle(.secondary)
        .clipShape(Capsule())
        .accessibilityLabel(Text("브랜치 \(slug)"))
    }
}

/// 출처 브리프 배지 — 세션을 낳은 백로그 브리프發일 때만 세션 행에 노출. 종류(구현/정리/
/// 재종합/수집) 라벨 + 제목(있으면, verbatim·tail 말줄임)을 보여 주고, 탭하면 backlog/<id>
/// 딥링크로 브리프 상세에 1탭 도달한다 (ChatView 출처 칩과 같은 인프라·약속).
///
/// 색 정책: 브리프 출처는 «브랜드/주요 인터랙티브» 신호라 accent(보라, 의미 토큰) 단색만 쓴다 —
/// status 색(success/danger/warning/info)·pro(주황)·리터럴(.blue/.orange/.yellow) 차용 금지.
/// 채움 .badge / 테두리 .border 불투명도 토큰, radius s(6)·spacing s(6) 4pt 그리드로 행의 다른
/// 배지(브랜치/에이전트/상태)와 시각 리듬을 맞춘다. 타이포는 시맨틱 폰트(.caption2)로 Dynamic
/// Type 자동 적응 — 고정 pt 금지. 제목은 에이전트/사용자 입력이라 번역 대상 아님(verbatim).
struct SourceBriefBadge: View {
    let brief: SourceBriefRef
    /// 탭 → backlog/<id> 딥링크 위임. 행 전체 탭(세션 열기)과 분리된 자체 탭 타깃.
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: Theme.Spacing.xs) {
                Image(systemName: "list.clipboard")
                    .font(.caption2.weight(.semibold))
                Text(brief.briefKind.label)
                    .font(.caption2.weight(.semibold))
                    .fixedSize()
                if let title = brief.title?.trimmingCharacters(in: .whitespacesAndNewlines),
                   !title.isEmpty {
                    Text(verbatim: "·")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    Text(verbatim: title)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
            }
            .foregroundStyle(Theme.accent)
            .padding(.horizontal, Theme.Spacing.s)
            .padding(.vertical, Theme.Spacing.xxs)
            .background(
                RoundedRectangle(cornerRadius: Theme.Radius.s, style: .continuous)
                    .fill(Theme.accent.opacity(Theme.Opacity.badge))
            )
            .overlay(
                RoundedRectangle(cornerRadius: Theme.Radius.s, style: .continuous)
                    .strokeBorder(Theme.accent.opacity(Theme.Opacity.border), lineWidth: 1)
            )
            .contentShape(RoundedRectangle(cornerRadius: Theme.Radius.s, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(Text("출처 브리프 상세 열기"))
        .accessibilityHint(Text(accessibilityValue))
    }

    /// 보조 음성 안내 — 종류+제목을 한 문장으로(제목은 verbatim 보간).
    private var accessibilityValue: String {
        let title = brief.title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if title.isEmpty {
            return String(localized: "출처 브리프") + " · " + brief.briefKind.label
        }
        return String(localized: "출처 브리프") + " · " + brief.briefKind.label + " · " + title
    }
}

/// 세션 행에 작은 칩으로 «이 세션이 어떤 CLI 도구로 spawn 됐는지» 를 표시.
///
/// agent 식별 / displayName / SF Symbol 매핑은 `AgentKind` (Models/AgentKind.swift) 에
/// 분리돼 host-less 단위 테스트로 검증된다. 이 view 는 거기 더해 «어떤 색을 입힐지»
/// 만 결정 — 색 매핑은 시각 결정이라 의도적으로 view 안에 둔다 (테스트 대상 아님).
struct AgentBadge: View {
    let agentId: String?

    private var kind: AgentKind { .from(id: agentId) }

    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: kind.systemImage)
                .font(.caption2)
            Text(verbatim: kind.displayName)
                .font(.caption2.weight(.medium))
                .lineLimit(1)
        }
        .padding(.horizontal, Theme.Spacing.s).padding(.vertical, Theme.Spacing.xxs)
        .background(color.opacity(0.18))
        .foregroundStyle(color)
        .clipShape(Capsule())
        .accessibilityLabel(Text(verbatim: kind.displayName))
    }

    /// kind → 표시 색. 시각 결정이라 view layer 책임. 주황은 «프로» 약속색(Theme.pro)이라
    /// 어떤 에이전트 뱃지에도 쓰지 않는다 — Claude Code 는 청록(teal)으로 구분.
    private var color: Color {
        switch kind {
        case .claudeCode: return .teal
        case .shell: return .gray
        case .codex: return .green
        case .antigravity: return .blue  // design-lint: allow — 에이전트 종류 구분 팔레트(teal/green/purple/indigo/pink… Node 색처럼 카테고리색), info 의미 아님
        case .localLlm: return .purple
        case .openCode: return .indigo
        case .copilot: return .pink
        case .unknown: return .gray
        }
    }
}
