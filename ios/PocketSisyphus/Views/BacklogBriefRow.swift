import SwiftUI

/// 백로그 리스트/트리아지 «행» 컴포넌트 — PoBrief 한눈에 요약·에이전트/렌즈 칩·BriefRow.
/// 원래 BacklogView.swift 안에 private 으로 있던 것을 동작 그대로(접근 수준만 private→internal) 옮긴 것 — 행동보존 추출. 색·문자열·레이아웃 그대로.
// MARK: - 브리프 본문 «한눈에» 요약

extension PoBrief {
    /// 리스트·트리아지 행의 «한눈에» 한 줄 — problem 의 첫 «의미 줄» 을 마크다운 기호 없이
    /// 평이하게. 사람이 제목·점수만 보고 보류/기각하지 않게 하는 게 목적(#6 인식 vs 회상).
    /// «브리프 1» 의 평이 요약 필드가 생기면 그걸 우선할 수 있으나, 현재 스키마엔 없어 problem
    /// 첫 줄을 쓴다(생성 측 비-목표 — 산출물 표시만). problem 이 비어 있는(구형) 브리프는 nil 을
    /// 돌려 호출부가 title 만 노출하게 한다(하위호환). 본문 데이터라 번역 대상이 아니다(생성 시
    /// {{lang}} 계약을 따른다) → 호출부는 Text(verbatim:).
    var glanceLine: String? {
        for raw in problem.split(whereSeparator: { $0.isNewline }) {
            var line = raw.trimmingCharacters(in: .whitespaces)
            if line.isEmpty { continue }
            // 머리기호(헤더 #·불릿·인용·번호)·체크박스를 한 번 벗겨 평문만 남긴다.
            line = line.replacingOccurrences(
                of: #"^\s*(#{1,6}\s+|[-*+]\s+(\[[ xX]\]\s*)?|>\s+|\d+[.)]\s+)"#,
                with: "", options: .regularExpression)
            // 인라인 강조·코드 기호는 서식이 아니라 평문으로 — **·백틱 제거.
            line = line.replacingOccurrences(of: "**", with: "")
                .replacingOccurrences(of: "`", with: "")
                .trimmingCharacters(in: .whitespaces)
            if !line.isEmpty { return line }
        }
        return nil
    }
}

// MARK: - 행

/// 백로그 한 행 — 제목 + 영향/노력 + 근거 수 + repo. 폰에서 훑는 단위.
/// showRepo: 전체 모드에서만 레포 배지(마지막 디렉토리명) — 단일 레포 모드에선 중복 정보.
/// 실행/정리 에이전트 칩 (po_agent_echo_v1) — 브리프가 «실제로» 어떤 코드 에이전트로 돌(았)는지
/// 한눈에. daemon 응답의 exec_agent_id/cleanup_agent_id 를 표시해, iOS 가 agent 인자를 빠뜨려
/// daemon 이 조용히 claude_code 로 폴백한 «무음 실패»(3회+ 재발 이력)를 드러낸다.
struct PoAgentChip: View {
    let agentId: String
    /// daemon 후보 목록 — displayName 우선 해석(새 어댑터까지 정확히). 비면 AgentKind 폴백.
    var agents: [AgentInfo] = []

    private var kind: AgentKind { AgentKind.from(id: agentId) }
    /// 후보 목록의 displayName 우선, 없으면 AgentKind 의 브랜드명. (둘 다 번역 대상 아님.)
    private var name: String {
        agents.first(where: { $0.id == agentId })?.displayName ?? kind.displayName
    }

    var body: some View {
        Label {
            Text(verbatim: name)
        } icon: {
            Image(systemName: kind.systemImage)
        }
        .font(.caption2.weight(.medium))
        .foregroundStyle(.secondary)
        .lineLimit(1)
    }
}

/// 브리프를 «쓴 전문가» 칩 (po_brief_lens_v1) — 어느 전문가 관점으로 만들어졌는지 카드에 노출.
/// 표시명은 픽커·리서치 칩과 «같은» poResearchLensName 카탈로그 키를 재사용한다(중복 정의 금지·신규 문자열 0).
/// 색은 중립(.secondary) — 렌즈는 «분류 라벨» 이라 pro(주황)·status 색을 빌려쓰지 않는다(색 정책).
/// "default"(전방위)·nil 은 호출부에서 거른다 (칩 자체를 안 띄움 → 구 daemon·전방위 브리프 회귀 0).
struct PoLensChip: View {
    let lens: String

    var body: some View {
        Label {
            Text(poResearchLensName(lens))
        } icon: {
            Image(systemName: "eyeglasses")
        }
        .font(.caption2.weight(.medium))
        .foregroundStyle(.secondary)
        .lineLimit(1)
    }
}

struct BriefRow: View {
    let brief: PoBrief
    var showRepo = true

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .top, spacing: 8) {
                Text(brief.title)
                    .font(.callout.weight(.semibold))
                    .lineLimit(2)
                Spacer(minLength: 0)
                statusBadge
            }
            // «한눈에» 한 줄 — 제목·점수만 보고 결정하지 않게 problem 첫 줄을 평이하게(중립 .secondary).
            // 산출물 데이터라 번역 대상 아님 → Text(verbatim:). 비면(구형 브리프) 줄 자체를 숨긴다.
            if let glance = brief.glanceLine {
                Text(verbatim: glance)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            HStack(spacing: 8) {
                Label("영향 \(brief.impact)", systemImage: "arrow.up.right")
                Label("노력 \(brief.effort)", systemImage: "hammer")
                Label("근거 \(brief.evidence.count)", systemImage: "link")
                Spacer(minLength: 0)
                // 이 브리프를 «쓴 전문가» (po_brief_lens_v1) — 전방위/구 daemon(nil)은 숨김.
                if let lens = brief.lens, lens != "default", !lens.isEmpty {
                    PoLensChip(lens: lens)
                }
                // 실행 에이전트 (po_agent_echo_v1) — 결재된 브리프엔 «실제로 돌린» 도구가 실린다.
                // 카드는 후보 목록을 안 받으므로 AgentKind 브랜드명만으로 표시.
                if let agentId = brief.execAgentId {
                    PoAgentChip(agentId: agentId)
                }
                if showRepo {
                    Text(verbatim: repoName)
                }
            }
            .font(.caption2)
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, 2)
    }

    private var repoName: String {
        (brief.repoPath as NSString).lastPathComponent
    }

    @ViewBuilder
    private var statusBadge: some View {
        if brief.revisingSessionId != nil {
            // 수정 지시 재종합 진행 중 — 결재보다 먼저 보여야 «지금 못 누르는 이유» 가 읽힌다.
            badge(text: Text("재종합 중"), color: Theme.accent)
        } else {
            decisionBadge
        }
    }

    @ViewBuilder
    private var decisionBadge: some View {
        switch brief.status {
        case "running", "approved":
            badge(text: Text("진행 중"), color: Theme.success)
        case "held":
            badge(text: Text("보류"), color: Color.secondary)
        case "rejected":
            badge(text: Text("기각"), color: Theme.danger)
        case "shipped":
            // 출시됨 — 검증 대기. 상태 신호색 info(파랑).
            badge(text: Text("출시됨"), color: Theme.info)
        case "verified":
            // 가설 적중 — 출시 후 검증 통과.
            badge(text: Text("검증됨"), color: Theme.success)
        case "missed":
            // 가설 빗나감 — 구현됐지만 신호가 해소되지 않음.
            badge(text: Text("빗나감"), color: Theme.danger)
        default:
            // 결재 대기 — score 를 그대로 노출 (영향/노력 비율, 정렬 기준임을 드러낸다).
            badge(text: Text(verbatim: String(format: "%.1f", brief.score)), color: Theme.pro)
        }
    }

    private func badge(text: Text, color: Color) -> some View {
        text
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(Capsule().fill(color.opacity(0.15)))
            .foregroundStyle(color)
    }
}
