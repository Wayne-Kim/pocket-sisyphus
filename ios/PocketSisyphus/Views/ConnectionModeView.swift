import SwiftUI

/// 연결 «방식» 최초 선택 화면 — 페어 완료 후 «Tor 부트스트랩이 시작되기 전» 에 한 번 띄운다.
///
/// 사용자의 요구: 「앱을 켜면 무조건 Tor 를 거치기 전에, 같은 Wi‑Fi 전용으로 쓸지 물어봐 달라」.
/// AppRoot 가 `ConnectionModePolicy.isChosen()` 이 false 인 동안엔 Tor 를 시작하지 않고 이 화면을
/// 띄운다. 둘 중 하나를 고르면 `LanOnlyPolicy` 토글에 반영되고 `modeChosen` 이 true 가 되어,
/// AppRoot 의 `.task(id:)` 가 재실행되며 (LAN 전용이면 Tor 를 건너뛴 채) 연결을 시작한다.
///
/// 색 정책: 보라(accent)는 강조/선택. 두 선택지를 «동등하게» 카드로 제시하되 아이콘만 accent.
/// 파랑/주황/노랑은 쓰지 않는다(상태색 차용 금지).
struct ConnectionModeView: View {
    @AppStorage(ConnectionModePolicy.chosenKey) private var modeChosen: Bool = false
    @AppStorage(LanOnlyPolicy.defaultsKey) private var lanOnly: Bool = false

    private func choose(lanOnly enabled: Bool) {
        // 순서 주의: lanOnly 를 먼저 확정한 뒤 modeChosen 을 켠다. modeChosen 변화가 AppRoot 의
        // .task(id:) 재실행 트리거라, 그 시점엔 lanOnly 가 이미 최종값이어야 올바른 채널로 붙는다.
        lanOnly = enabled
        modeChosen = true
    }

    var body: some View {
        VStack(spacing: Theme.Spacing.xxxl) {
            Spacer()

            Image("AppLogo")
                .resizable()
                .scaledToFit()
                .frame(width: Theme.IconSize.xxl, height: Theme.IconSize.xxl)
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.xl, style: .continuous))

            VStack(spacing: Theme.Spacing.m) {
                Text("연결 방식을 선택하세요")
                    .font(.title2.weight(.semibold))
                    .multilineTextAlignment(.center)
                Text("폰에서 Mac 에 어떻게 연결할지 골라 주세요. 나중에 설정에서 바꿀 수 있어요.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 32)
            }

            VStack(spacing: Theme.Spacing.xl) {
                optionCard(
                    icon: "globe",
                    title: Text("어디서나 연결"),
                    desc: Text("Tor 를 통해 어느 네트워크에서나 연결해요. 조금 느릴 수 있어요."),
                    action: { choose(lanOnly: false) }
                )
                optionCard(
                    icon: "house.lock",
                    title: Text("같은 Wi‑Fi 전용"),
                    desc: Text("폰과 Mac 이 같은 Wi‑Fi 에 있을 때만 사설 주소로 직접 연결해요. 더 빠르지만 외부 네트워크에선 연결이 차단돼요."),
                    action: { choose(lanOnly: true) }
                )
            }
            .padding(.horizontal, 24)

            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func optionCard(icon: String, title: Text, desc: Text, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: Theme.Spacing.xl) {
                Image(systemName: icon)
                    .font(.title2)
                    .foregroundStyle(Theme.accent)
                    .frame(width: 32)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
                    title
                        .font(.headline)
                        .foregroundStyle(.primary)
                    desc
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.leading)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.tertiary)
                    .accessibilityHidden(true)
            }
            .padding(Theme.Spacing.xxl)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: Theme.Radius.l, style: .continuous)
                    .fill(Color(.secondarySystemBackground))
            )
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
    }
}
