import SwiftUI

/// 세션 목록 화면의 요약/그룹 «헤더» 프리미티브. 함대 상태 요약 카드(StatPill)·상태/레포/보관
/// 그룹 헤더를 한곳에 모은다. 원래 SessionsView.swift 안에 private 으로 있던 것을 동작 그대로
/// (접근 수준만 private→internal) 옮긴 것 — 행동보존 추출. 색·문자열·레이아웃 변경 없음.

/// 함대 상태 요약 헤더 — 화면 상단에 «대기 N · 실행 중 N · 완료 N» 을 글랜서블 카드(StatPill)로
/// 띄워 여러 세션의 상태 분포를 한눈에 답한다(병렬 운용의 «새눈» 가시성). 각 카드는 탭하면 그
/// 상태로 필터를 좁히고(같은 상태 재탭 → 전체 복원) 상태 세그먼트(`statusFilter`)와 양방향 바인딩.
///
/// 색 정책: 의미 토큰만 쓴다 — 대기=accent(브랜드/주요 인터랙티브 = «주의 필요·행동 유도», 경고
/// 아님)·실행중=success·완료=중립(.secondary). 완료 중 «오류로 끝남» 은 danger 배지로 따로 집어
/// 막힌 에이전트를 강조한다. pro(주황) 차용·warning↔pro 혼동·장식용 status 색 빌림 금지.
struct SessionSummaryHeader: View {
    let waiting: Int
    let running: Int
    let done: Int
    /// 완료 중 오류 종료 수 — 완료 카드의 danger 서브 배지(막힌 에이전트 주의 신호).
    let errors: Int
    @Binding var filter: SessionsView.StatusFilter

    var body: some View {
        HStack(spacing: Theme.Spacing.m) {
            StatPill(
                icon: "hourglass",
                count: waiting,
                label: "대기",
                color: Theme.accent,
                isSelected: filter == .waiting,
                accessibility: Text("입력 대기 세션 \(waiting)건. 탭하면 대기 세션만 봅니다."),
                action: { toggle(.waiting) },
            )
            StatPill(
                icon: "circle.fill",
                count: running,
                label: "실행 중",
                color: Theme.success,
                isSelected: filter == .running,
                accessibility: Text("실행 중 세션 \(running)건. 탭하면 실행 중 세션만 봅니다."),
                action: { toggle(.running) },
            )
            StatPill(
                icon: "checkmark.circle.fill",
                count: done,
                label: "완료",
                color: .secondary,
                isSelected: filter == .done,
                errorBadge: errors,
                accessibility: doneAccessibility,
                action: { toggle(.done) },
            )
        }
        .accessibilityElement(children: .contain)
    }

    /// 완료 카드 음성 안내 — 오류가 있으면 오류 건수까지 한 문장에 포함(서브 배지는 a11y 숨김이라
    /// 여기서 흡수). 둘 다 LocalizedStringKey 보간이라 카탈로그 자동 추출 경로를 탄다.
    private var doneAccessibility: Text {
        if errors > 0 {
            return Text("완료 세션 \(done)건, 오류 \(errors)건. 탭하면 완료 세션만 봅니다.")
        }
        return Text("완료 세션 \(done)건. 탭하면 완료 세션만 봅니다.")
    }

    /// 카드 탭 → 그 상태로 필터, 같은 상태 재탭이면 전체 복원(토글). 세그먼트와 같은 $statusFilter.
    private func toggle(_ s: SessionsView.StatusFilter) {
        filter = (filter == s) ? .all : s
    }
}

/// 요약 헤더의 상태 카드 한 장 — 큰 숫자(상태색·고대비) + 아이콘 + 라벨(.secondary)로 텍스트
/// 의존을 줄인 글랜서블 표시. 선택 상태면 채움/테두리 불투명도를 한 단계 올려(badge/border) 현재
/// 세그먼트를 시각적으로 잇는다. 본문 색은 자동 적응(.secondary)·상태색만 쓰고 .white/.black
/// 하드코딩·전역 .tint 는 없다(에러 배지의 onAccent 흰색은 «danger 배경 위» 전용으로만).
struct StatPill: View {
    let icon: String
    let count: Int
    let label: LocalizedStringKey
    let color: Color
    var isSelected: Bool = false
    /// >0 이면 우상단에 danger «오류 N» 서브 배지. 완료 카드 전용(막힌 에이전트 강조).
    var errorBadge: Int = 0
    let accessibility: Text
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: Theme.Spacing.xs) {
                HStack(spacing: Theme.Spacing.xs) {
                    Image(systemName: icon)
                        .font(.caption2.weight(.semibold))
                    Text(verbatim: "\(count)")
                        .font(.title3.weight(.bold))
                        .monospacedDigit()
                }
                .foregroundStyle(color)
                Text(label)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, Theme.Spacing.m)
            .padding(.horizontal, Theme.Spacing.s)
            .background(
                RoundedRectangle(cornerRadius: Theme.Radius.m, style: .continuous)
                    .fill(color.opacity(isSelected ? Theme.Opacity.badge : Theme.Opacity.fill)),
            )
            .overlay(
                RoundedRectangle(cornerRadius: Theme.Radius.m, style: .continuous)
                    .strokeBorder(color.opacity(isSelected ? Theme.Opacity.border : 0), lineWidth: 1),
            )
            .overlay(alignment: .topTrailing) {
                if errorBadge > 0 {
                    HStack(spacing: Theme.Spacing.xxs) {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .font(.caption2.weight(.bold))
                            .imageScale(.small)
                        Text(verbatim: "\(errorBadge)")
                            .font(.caption2.weight(.bold))
                    }
                    .foregroundStyle(Theme.onAccent)
                    .padding(.horizontal, Theme.Spacing.s)
                    .padding(.vertical, Theme.Spacing.xxs)
                    .background(Capsule().fill(Theme.danger))
                    .padding(Theme.Spacing.xs)
                    .accessibilityHidden(true)  // 음성 안내는 완료 카드 라벨이 흡수.
                }
            }
            .contentShape(RoundedRectangle(cornerRadius: Theme.Radius.m, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibility)
        .accessibilityAddTraits(isSelected ? [.isButton, .isSelected] : .isButton)
    }
}

/// 상태 그룹 헤더 — 「대기 2」 처럼 상태명 + 개수. 개수는 숫자라 번역 불필요(상태명만 키).
/// 색은 상태 약속색을 따른다: 대기=warning, 실행중=success, 완료=중립.
///
/// 모든 그룹에 일괄 액션 버튼을 단다 — 대기=«모두 승인»·실행중=«모두 중지»·완료=«완료 정리».
/// 여러 세션이 동시에 멈추거나 도는 함대 운용에서 카드를 하나씩 열거나 밀지 않고 그룹 단위로
/// 처리하는 병목 해소(생산/실행 끝은 승인·중지, 수명 종료 끝은 정리).
struct SessionGroupHeader: View {
    let state: SessionRunState
    let count: Int
    /// 대기→«모두 승인» (accent). nil 이면 버튼 숨김(대상 0건 / pty 일괄 capability 미지원).
    var onApproveAll: (() -> Void)? = nil
    /// 실행중→«모두 중지» (danger, 진행 중 작업 끊음). nil 이면 숨김.
    var onStopAll: (() -> Void)? = nil
    /// 완료→«모두 보관» (accent, 비파괴·즉시). session_archive_v1 일 때만. nil 이면 메뉴 대신 단일 삭제.
    var onArchiveAll: (() -> Void)? = nil
    /// 완료→«모두 삭제» (danger, 파괴적). 호출부가 확인 다이얼로그를 띄운다. nil 이면 숨김.
    var onDeleteAll: (() -> Void)? = nil

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: icon)
                .font(.caption2)
                .foregroundStyle(color)
            Text(label)
            Spacer()
            trailingControl
            Text(verbatim: "\(count)")
                .foregroundStyle(.secondary)
        }
    }

    /// 그룹별 일괄 컨트롤 — 대기=모두 승인(accent), 실행중=모두 중지(danger), 완료=정리 메뉴
    /// (보관/삭제). 헤더 자동 대문자화를 끄고(.textCase(nil)) 상태 약속색으로 강조한다.
    @ViewBuilder
    private var trailingControl: some View {
        switch state {
        case .waiting:
            if let onApproveAll {
                Button(action: onApproveAll) { Text("모두 승인") }
                    .font(.caption.weight(.semibold))
                    .textCase(nil)
                    .buttonStyle(.borderless)
                    .tint(Theme.accent)
            }
        case .running:
            if let onStopAll {
                Button(action: onStopAll) { Text("모두 중지") }
                    .font(.caption.weight(.semibold))
                    .textCase(nil)
                    .buttonStyle(.borderless)
                    .tint(Theme.danger)
            }
        case .done:
            // 완료 그룹은 «보관»(비파괴, 권장)과 «삭제»(파괴적)를 메뉴로 묶는다 — 한 화면에서
            // 시야 정리(보관) 또는 영구 제거(삭제)를 고른다. session_archive_v1 없으면(onArchiveAll
            // nil) 옛 동작대로 «완료 정리»(삭제) 단일 버튼으로 떨어진다.
            if onArchiveAll != nil {
                Menu {
                    if let onArchiveAll {
                        Button(action: onArchiveAll) {
                            Label("모두 보관", systemImage: "archivebox")
                        }
                    }
                    if let onDeleteAll {
                        Button(role: .destructive, action: onDeleteAll) {
                            Label("모두 삭제", systemImage: "trash")
                        }
                    }
                } label: {
                    Text("정리")
                }
                .font(.caption.weight(.semibold))
                .textCase(nil)
                .tint(Theme.accent)
            } else if let onDeleteAll {
                Button(action: onDeleteAll) { Text("완료 정리") }
                    .font(.caption.weight(.semibold))
                    .textCase(nil)
                    .buttonStyle(.borderless)
                    .tint(Theme.danger)
            }
        }
    }

    private var label: LocalizedStringKey {
        switch state {
        case .waiting: return "대기"
        case .running: return "실행 중"
        case .done: return "완료"
        }
    }
    private var icon: String {
        switch state {
        case .waiting: return "hourglass"
        case .running: return "play.circle.fill"
        case .done: return "checkmark.circle.fill"
        }
    }
    private var color: Color {
        switch state {
        case .waiting: return Theme.warning
        case .running: return Theme.success
        case .done: return .secondary
        }
    }
}

/// 레포별 그룹 헤더 — 「<폴더명> N」. 레포 경로는 «구조» 신호라 상태색(success/warning/danger)을
/// 빌리지 않고 중립(.secondary) 폴더 아이콘으로 둔다 (BranchBadge 와 같은 중립 약속). 폴더명은
/// 파일시스템 식별자라 번역 대상이 아니다(verbatim).
struct RepoGroupHeader: View {
    let repoPath: String
    let count: Int

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "folder")
                .font(.caption2)
                .foregroundStyle(.secondary)
            Text(verbatim: Self.displayName(repoPath))
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer()
            Text(verbatim: "\(count)")
                .foregroundStyle(.secondary)
        }
        .textCase(nil)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("레포 \(Self.displayName(repoPath)), 세션 \(count)건"))
    }

    /// 표시용 폴더명 — repo_path 의 마지막 경로 요소. 비면 전체 경로로 폴백.
    static func displayName(_ path: String) -> String {
        let comps = path.split(separator: "/").map(String.init)
        return comps.last ?? path
    }
}

/// 보관함 그룹 헤더 — 「보관됨 N」 + 일괄 «복구»(accent, 비파괴)/«삭제»(danger, 파괴적) 메뉴.
/// 색은 중립(보관은 상태가 아니라 «치워둔 것»). 삭제만 호출부가 확인 다이얼로그를 띄운다.
struct ArchivedGroupHeader: View {
    let count: Int
    var onRestoreAll: () -> Void
    var onDeleteAll: () -> Void

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "archivebox")
                .font(.caption2)
                .foregroundStyle(.secondary)
            Text("보관됨")
            Spacer()
            Menu {
                Button(action: onRestoreAll) {
                    Label("모두 복구", systemImage: "tray.and.arrow.up")
                }
                Button(role: .destructive, action: onDeleteAll) {
                    Label("모두 삭제", systemImage: "trash")
                }
            } label: {
                Text("정리")
            }
            .font(.caption.weight(.semibold))
            .textCase(nil)
            .tint(Theme.accent)
            Text(verbatim: "\(count)")
                .foregroundStyle(.secondary)
        }
    }
}
