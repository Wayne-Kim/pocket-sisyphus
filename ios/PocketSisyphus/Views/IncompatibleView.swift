import SwiftUI

/// daemon ↔ iOS 버전이 Hard incompat 일 때 SessionsView/PairView 대신 보여주는 차단 화면.
///
/// 어느 쪽을 업데이트해야 하는지를 메시지로 분기한다. AppRoot 가 verdict 이 `.hardXxx`
/// 일 때만 이 화면으로 라우트하므로 verdict 은 항상 Hard 케이스다.
struct IncompatibleView: View {
    let verdict: CompatibilityVerdict
    let onRecheck: () -> Void

    var body: some View {
        VStack(spacing: 20) {
            Spacer()

            Image(systemName: iconName)
                .font(.system(size: Theme.IconSize.xxl))
                .foregroundStyle(Theme.warning)

            VStack(spacing: 10) {
                Text(title)
                    .font(.title3.weight(.semibold))
                    .multilineTextAlignment(.center)
                Text(message)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 28)
            }

            // 사용자가 막 업데이트를 끝낸 직후를 위한 "다시 확인" 버튼. Tor 회로는 그대로 두고
            // /api/version 만 다시 호출한다.
            Button {
                onRecheck()
            } label: {
                Label("다시 확인", systemImage: "arrow.clockwise")
                    .frame(maxWidth: 280)
                    .padding(.vertical, 12)
            }
            .buttonStyle(.borderedProminent)
            .tint(Theme.accent)
            .controlSize(.large)
            .padding(.top, 8)

            // 사용자가 자기 버전을 알고 싶을 때를 위한 자세한 버전 정보. 디버깅 + 업데이트 후
            // 어떤 버전부터 되는지 확인할 때 필요.
            VStack(spacing: 4) {
                Text(versionLines)
                    .font(.caption2.monospaced())
                    .foregroundStyle(.tertiary)
                    .multilineTextAlignment(.center)
            }
            .padding(.top, 12)

            Spacer()
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - 메시지 분기

    private var iconName: String {
        switch verdict {
        case .hardDaemonTooOld, .hardDaemonUnknown:
            return "desktopcomputer.trianglebadge.exclamationmark"
        case .hardClientTooOld:
            return "iphone.gen3.badge.exclamationmark"
        default:
            return "exclamationmark.triangle"
        }
    }

    private var title: String {
        switch verdict {
        case .hardDaemonTooOld, .hardDaemonUnknown:
            return String(localized: "Mac 앱 업데이트가 필요해요")
        case .hardClientTooOld:
            return String(localized: "iPhone 앱 업데이트가 필요해요")
        default:
            return String(localized: "버전이 호환되지 않아요")
        }
    }

    private var message: String {
        switch verdict {
        case .hardDaemonTooOld(_, let minRequired):
            return String(localized:
                "이 iPhone 앱은 Mac Pocket Sisyphus \(minRequired) 이상이 필요합니다. Mac 에서 새 버전을 받아 설치해 주세요."
            )
        case .hardDaemonUnknown:
            return String(localized:
                "Mac Pocket Sisyphus 가 너무 옛 버전입니다. 최신 DMG 로 업데이트하면 자동으로 호환됩니다."
            )
        case .hardClientTooOld(_, let minRequired):
            return String(localized:
                "이 iPhone 앱이 Mac Pocket Sisyphus 의 최소 지원 버전(\(minRequired))보다 낮습니다. App Store / TestFlight 에서 업데이트해 주세요."
            )
        default:
            return ""
        }
    }

    private var versionLines: String {
        let app = VersionCompat.currentAppVersion
        switch verdict {
        case .hardDaemonTooOld(let daemonVersion, let minRequired):
            return "iPhone 앱: \(app)\nMac 데몬: \(daemonVersion)  (필요: ≥ \(minRequired))"
        case .hardDaemonUnknown:
            return "iPhone 앱: \(app)\nMac 데몬: 알 수 없음 (구버전)"
        case .hardClientTooOld(let clientVersion, let minRequired):
            return "iPhone 앱: \(clientVersion)  (필요: ≥ \(minRequired))"
        default:
            return "iPhone 앱: \(app)"
        }
    }
}

// MARK: - Soft 배너 (부팅 시 SessionsView 위에 한 줄)

/// daemon 에 일부 capability 가 없을 때 SessionsView 상단에 한 줄로 띄우는 배너.
/// safeAreaInset 으로 NavigationStack 안쪽 toolbar 와 안 겹치게 들어간다.
struct SoftIncompatibilityBanner: View {
    let missing: [String]
    let daemonVersion: String

    /// 마지막으로 dismiss 된 daemon 버전. 같은 버전 daemon 인 동안엔 다시 뜨지 않는다 —
    /// 사용자 의도 존중. daemon 이 다른 버전으로 갈아끼워지면 이 값과 어긋나면서 다시 뜸 —
    /// 새 daemon 의 capability 차이는 새 정보이므로 한 번은 보여줄 가치가 있다.
    ///
    /// 키 한 개에 "마지막으로 dismiss 한 daemon 버전" 문자열을 박는다. 이전에 본 적 없는
    /// 버전이거나 빈 문자열이면 표시.
    @AppStorage("softBannerDismissedForDaemonVersion") private var dismissedForVersion: String = ""

    var body: some View {
        if dismissedForVersion == daemonVersion { EmptyView() } else {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "arrow.up.circle")
                    .foregroundStyle(Theme.warning)
                    .font(.callout)
                    .padding(.top, 1)
                VStack(alignment: .leading, spacing: 2) {
                    Text("일부 기능이 비활성화돼 있어요")
                        .font(.footnote.weight(.semibold))
                    Text(detailLine)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                Spacer(minLength: 0)
                Button {
                    dismissedForVersion = daemonVersion
                } label: {
                    Image(systemName: "xmark")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(.secondary)
                        .padding(6)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text("닫기"))
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(Theme.warning.opacity(Theme.Opacity.fill))
            .overlay(
                Rectangle()
                    .frame(height: 0.5)
                    .foregroundStyle(.tertiary),
                alignment: .bottom,
            )
        }
    }

    private var detailLine: String {
        // 사용자한테는 개수만 보여준다. capability 식별자 자체는 사용자 친화적이지 않다.
        // 디버깅이 필요하면 IncompatibleView 의 version 정보를 참고.
        let count = missing.count
        return String(localized:
            "Mac 데몬 \(daemonVersion) 에 누락된 기능 \(count)개. Mac 앱을 업데이트하면 활성화됩니다."
        )
    }
}
