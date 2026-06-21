import SwiftUI

/// 세션 목록의 «행» 컴포넌트 — 세션 행·스켈레톤·빠른 동작 버튼, 그리고 데스크탑 재개/최근
/// 프로젝트 행. 원래 SessionsView.swift 안에 private 으로 있던 것을 동작 그대로(접근 수준만
/// private→internal) 옮긴 것 — 행동보존 추출. 상태·접근성 라벨·색 그대로.

/// 세션 행의 트레일링 «빠른 동작» pill — 행 본문 «열기» 와 분리된 별개 탭 타깃(중첩 핫존 금지).
/// 아이콘+짧은 텍스트를 의미 색(tint)으로 옅게 채운 캡슐로, «보이는» 동작임을 분명히 한다
/// (배너 「검토」 버튼과 같은 titleAndIcon 언어). 색은 호출부가 의미 토큰으로만 넘긴다 —
/// accent(검토·보관=비파괴) / danger(중지=파괴적). warning(노랑)·pro(주황)·리터럴 색 금지.
///
/// 터치 타깃: 밀집 행이라 HIG 44pt 를 엄격히 채우는 대신 «시각 크기 자체» 로 누를 면적을 확보한다
/// (불투명 frame 으로 죽은 공간을 만들지 않음 — ChatKeyButton 44pt 회귀 준수). 보이는 캡슐 = 탭
/// 영역(contentShape(Capsule)). 색·배경만 그리므로 레이아웃 점유는 캡슐 자신뿐이다.
struct SessionQuickActionButton: View {
    let title: LocalizedStringKey
    let systemImage: String
    let tint: Color
    let accessibilityLabel: Text
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Label(title, systemImage: systemImage)
                .font(.subheadline.weight(.semibold))
                .labelStyle(.titleAndIcon)
                .lineLimit(1)
                .fixedSize()
                .padding(.horizontal, Theme.Spacing.l)
                .padding(.vertical, Theme.Spacing.m)
                .foregroundStyle(tint)
                .background(
                    Capsule().fill(tint.opacity(Theme.Opacity.fill)),
                )
                .overlay(
                    Capsule().strokeBorder(tint.opacity(Theme.Opacity.border), lineWidth: 1),
                )
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityAddTraits(.isButton)
    }
}

struct SessionRow: View {
    let session: SessionSummary
    /// 변경 파일 수 lazy 캐시 — 카드가 보일 때 그 세션만 받아 채운다(@ObservedObject 라
    /// 값이 도착하면 이 행만 다시 그려진다).
    @ObservedObject var changeCounts: SessionChangeCounts
    /// 출처 브리프 배지 탭 → `backlog/<id>` 딥링크. 백로그 탭 전환 + 브리프 상세 push 를
    /// 기존 딥링크 인프라(MainTabView·BacklogView 소비)에 위임 — ChatView 칩과 같은 경로.
    @EnvironmentObject var deepLink: DeepLinkRouter
    /// 「조용함 N분」 칩을 띄우기 시작하는 idle 임계(초) — ChatView 와 같은 약속. 도구 연쇄
    /// 노이즈를 피해 분 단위로 넉넉히 잡는다.
    private static let quietSurfaceThresholdSec = 60

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            // 출처 브리프 배지 — 이 세션을 낳은 백로그 브리프發일 때만(source_brief != nil) 자체
            // 줄로 노출. 일반 세션엔 미표시(행 높이 회귀 0). 탭하면 backlog/<id> 딥링크로 점프해
            // «다시 접속» 의 출발점인 목록에서 바로 출처를 가린다. 자체 줄이라 제목이 길어도
            // 브랜치/repo 줄과 자리 경쟁 없이 tail 로 깔끔히 잘린다(레이아웃 점프 없음).
            // 출처(백로그 브리프)를 제목보다 위에 둬, 「이 세션이 어디서 왔나」 를 먼저 읽게 한다.
            if let sb = session.source_brief {
                SourceBriefBadge(brief: sb) {
                    deepLink.pendingBacklogBriefId = sb.id
                    deepLink.pendingBacklog = true
                }
            }
            // 타이틀은 한 줄을 통째로 써서 말줄임을 최소화한다 — 모델·상태 배지는 자리
            // 경쟁을 피해 아래 요약 줄(시각·변경수 옆)로 내렸다.
            Text(session.title ?? String(localized: "제목 없음"))
                .font(.headline)
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)
            // worktree 브랜치 배지 + 레포 경로 — 「이 세션이 어느 격리 브랜치(작업 폴더)에서
            // 도는지」 를 묶어 보여 주는 모바일 오케스트레이션 신호. 일반 세션엔 배지 없음.
            HStack(spacing: Theme.Spacing.s) {
                if let slug = session.worktreeBranchSlug {
                    BranchBadge(slug: slug)
                }
                Text(session.repo_path)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            // 카드 요약 — 마지막 turn 시각(상대시간) + 변경 파일 수(있을 때만). 대기 여부는
            // 위 상태 배지가 이미 답한다.
            HStack(spacing: Theme.Spacing.l) {
                Label {
                    Text(Self.relative(session.lastActivityAt))
                } icon: {
                    Image(systemName: "clock")
                }
                .lineLimit(1)
                .layoutPriority(-1)  // 좁아지면 상태 배지보다 먼저 양보(잘리거나 줄어든다).
                if let n = changeCounts.count(for: session.id), n > 0 {
                    Label {
                        Text("변경 \(n)")
                    } icon: {
                        Image(systemName: "doc.text")
                    }
                }
                // 「조용함 N분」 — 실행중인데 임계 이상 조용한(=12초 휴리스틱이 «대기» 로 못 잡은)
                // 세션을 함대 목록에서 표면화한다. 도구 연쇄로 출력이 흐르면 idle 이 0 으로 리셋돼
                // 헛경보가 안 난다. 대기로 잡힌 세션은 위 상태 배지가 이미 답하므로 실행중에만.
                if session.runState == .running,
                   let secs = session.quietSeconds, secs >= Self.quietSurfaceThresholdSec {
                    Label {
                        Text("조용함 \(secs / 60)분")
                    } icon: {
                        Image(systemName: "moon.zzz")
                    }
                }
                // 모델·상태 배지 — 타이틀 줄에서 내려와 요약 줄 오른쪽 끝에 붙는다. 배지는
                // 자체 font/색을 갖고 있어 이 줄의 .caption2/.tertiary 에 물들지 않는다.
                Spacer(minLength: Theme.Spacing.m)
                AgentBadge(agentId: session.agent)
                // 실행중/대기/완료 — 같은 카드 모양 안에서 «일하는 중» / «나를 기다리는 중» /
                // «끝남» 을 한눈에 가른다. 대기는 warning(노랑) = «사용자 액션 필요» 약속색.
                // 트레일링 빠른 동작 pill 로 행 폭이 줄어든 좁은 기기에서도 «상태» 만은 반드시 보이게
                // layoutPriority(1)+fixedSize 로 먼저 자리를 잡는다 — 왼쪽 시각/변경 라벨이 대신 줄거나
                // 잘리고(아래 lineLimit), 에이전트 배지가 양보한다(브리프: 상태 배지 우선 보장).
                RunStateBadge(state: session.runState, status: session.status)
                    .fixedSize()
                    .layoutPriority(1)
                // 알림 액션(승인/중지) 처리 상태 — 알림에서 누른 결과를 목록에서도 비춘다.
                // 처리중/완료/실패만 그린다(대기는 RunStateBadge 가 이미 표시). 색은 의미 토큰:
                // 처리중=accent, 완료=success(초록), 실패=danger(빨강).
                AgentWaitActionBadge(sessionId: session.id)
            }
            .font(.caption2)
            .foregroundStyle(.tertiary)
            .labelStyle(.titleAndIcon)
        }
        .padding(.vertical, Theme.Spacing.xs)
        .onAppear {
            // 변경 파일 수는 활성 세션(실행중/대기)만 받는다 — «지금 관리 중» 인 팀의 변경만
            // 본다. 완료 세션까지 받으면 「완료」 탭 스크롤 시 git status 호출이 불필요하게 분다.
            if session.runState != .done {
                changeCounts.loadIfNeeded(session.id)
            }
        }
    }

    /// 마지막 turn 시각 → 시스템 로케일 상대시간("3분 전"). RelativeDateTimeFormatter 가 자동
    /// 번역하므로 카탈로그 문자열이 필요 없다. formatter 는 비싸서 1회 생성 후 재사용.
    private static let relFormatter: RelativeDateTimeFormatter = {
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .abbreviated
        return f
    }()
    private static func relative(_ ms: Int64) -> String {
        relFormatter.localizedString(
            for: Date(timeIntervalSince1970: TimeInterval(ms) / 1000),
            relativeTo: Date(),
        )
    }
}

/// 첫 로딩 동안 보여 줄 빈 자리 row. `.redacted(.placeholder)` 만으로는 SwiftUI 기본
/// shimmer 가 없어서 명시적 회색 박스 3 줄로 SessionRow 모양을 흉내낸다 — 사용자에게
/// "여기에 콘텐츠가 곧 들어옴" 시각적 신호.
struct SessionRowSkeleton: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                placeholder(width: 160, height: 14)
                Spacer()
                placeholder(width: 40, height: 12)
            }
            placeholder(width: 220, height: 11)
            placeholder(width: 100, height: 10)
        }
        .padding(.vertical, 4)
        .accessibilityHidden(true)  // VoiceOver 가 자리 표시자를 읽지 않게.
    }

    private func placeholder(width: CGFloat, height: CGFloat) -> some View {
        RoundedRectangle(cornerRadius: 4)
            .fill(Color.secondary.opacity(0.15))
            .frame(width: width, height: height)
    }
}

struct ResumeRow: View {
    let session: DesktopSession
    let selected: Bool
    /// 행 오른쪽 끝의 숨김 버튼이 눌렸을 때. nil 이면 버튼 자체가 보이지 않는다 (HiddenItemsSheet
    /// 에서 재사용하지 않으므로 사실상 nil 케이스는 없지만, 미래의 read-only 재사용 대비).
    var onHide: (() -> Void)? = nil

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: selected ? "largecircle.fill.circle" : "circle")
                .foregroundStyle(selected ? Theme.accent : .secondary)
                .frame(width: 18)
            VStack(alignment: .leading, spacing: 3) {
                // preview 는 agent 마다 채워질 수도(claude jsonl) / nil 일 수도(agy 의 .pb).
                // nil 이면 어떤 세션인지만 식별되게 sessionId prefix 로 fallback.
                Text(session.preview ?? "(미리보기 없음 · \(session.sessionId.prefix(8)))")
                    .font(.callout)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
                HStack(spacing: 6) {
                    if let branch = session.gitBranch, !branch.isEmpty {
                        Label(branch, systemImage: "arrow.triangle.branch")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                    if let turns = session.turnCount {
                        Text("\(turns)턴")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                        Text("·")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                    Text(timeAgo(session.lastActiveAt))
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }
            Spacer()
            if let onHide {
                // outer Button(.plain) 안의 inner Button — `.borderless` 로 명시해야
                // SwiftUI 가 hit area 를 분리하고 행 선택 동작과 충돌하지 않는다.
                Button(action: onHide) {
                    Image(systemName: "eye.slash")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .frame(width: 32, height: 32)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.borderless)
                .accessibilityLabel(Text("이 이어받기 후보 숨기기"))
            }
        }
        .contentShape(Rectangle())
    }

    private func timeAgo(_ ts: Int64) -> String {
        let date = Date(timeIntervalSince1970: TimeInterval(ts) / 1000)
        let delta = Date().timeIntervalSince(date)
        if delta < 60 { return String(localized: "방금") }
        let min = Int(delta / 60)
        if delta < 3_600 { return String(localized: "\(min)분 전") }
        let hr = Int(delta / 3_600)
        if delta < 86_400 { return String(localized: "\(hr)시간 전") }
        let day = Int(delta / 86_400)
        if delta < 86_400 * 7 { return String(localized: "\(day)일 전") }
        let f = DateFormatter()
        f.dateStyle = .short
        // 시스템 로케일 사용 — 명시적 ko_KR 고정은 다국어 정책과 충돌.
        return f.string(from: date)
    }
}

struct RecentRow: View {
    let project: RecentProject
    let selected: Bool
    /// 행 오른쪽 끝의 숨김 버튼이 눌렸을 때. nil 이면 버튼이 보이지 않음.
    var onHide: (() -> Void)? = nil

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: selected ? "checkmark.circle.fill" : "folder")
                .foregroundStyle(selected ? Theme.accent : Color.secondary)
                .frame(width: 18)
            VStack(alignment: .leading, spacing: 2) {
                Text(displayName)
                    .font(.body.weight(.medium))
                    .lineLimit(1)
                Text(project.path)
                    .font(.caption2.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Text("\(project.sessionCount)개 세션 · \(timeAgo(project.lastUsedAt))")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            Spacer()
            if let onHide {
                Button(action: onHide) {
                    Image(systemName: "eye.slash")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .frame(width: 32, height: 32)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.borderless)
                .accessibilityLabel(Text("이 레포 숨기기"))
            }
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
    }

    private var displayName: String {
        (project.path as NSString).lastPathComponent
    }

    private func timeAgo(_ ts: Int64) -> String {
        let date = Date(timeIntervalSince1970: TimeInterval(ts) / 1000)
        let delta = Date().timeIntervalSince(date)
        if delta < 60 { return String(localized: "방금") }
        let min = Int(delta / 60)
        if delta < 3_600 { return String(localized: "\(min)분 전") }
        let hr = Int(delta / 3_600)
        if delta < 86_400 { return String(localized: "\(hr)시간 전") }
        let day = Int(delta / 86_400)
        if delta < 86_400 * 7 { return String(localized: "\(day)일 전") }
        let f = DateFormatter()
        f.dateStyle = .short
        // 시스템 로케일 사용 — 명시적 ko_KR 고정은 다국어 정책과 충돌.
        return f.string(from: date)
    }
}
