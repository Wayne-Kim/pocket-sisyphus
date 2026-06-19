import SwiftUI
import StoreKit

/// 보유/활성 entitlement 가 없는 사용자에게 보여주는 결제 안내 (3-tier).
///
/// 진입 경로: AppRoot 가 `EntitlementDecision.decide(isEntitled:) == .paywall` 일 때 정상 경로
/// (SessionsView) 대신 이 뷰를 풀스크린으로 띄운다. SessionsView 에 접근할 수 없게 — 결제/복원만
/// 남는다. 결제·복원으로 entitled 가 되면 AppRoot 가 자동으로 SessionsView 로 다시 분기한다.
///
/// 상품: 월 구독 / 년 구독(추천) / 평생 이용권. «구독으로 7일 무료 체험 → 마음에 들면 평생 구매»
/// 동선이라 구독을 위에, 평생을 아래에 둔다. 평생은 비소모성이라 무료체험 배지가 없다.
///
/// UI 책임:
///  - 가격은 ASC localized (`product.displayPrice`) 그대로. 임의 «₩5,000» 하드코딩 금지 —
///    통화/세금 차이로 사용자가 본 가격과 결제 다이얼로그 가격이 다르면 신뢰가 깨진다.
///    문구 조립은 `PaywallCopy` (순수·테스트됨) 가 담당.
///  - 무료체험 적격(`isEligibleForIntroOffer`) 일 때만 구독 카드에 «7일 무료 체험 후 …» 노출.
///  - 자동갱신 구독 고지 + 이용약관·개인정보처리방침 링크 (App Store 심사 필수).
///  - 색: 모든 구매 CTA 는 `Theme.accent`(보라). pro(주황)는 CTA 색이 아니라 «프로 기능» 마킹색.
struct PaywallView: View {
    @EnvironmentObject var purchase: PurchaseStore
    /// sheet 으로 띄워진 경우 결제/복원 성공 직후 닫는다. 풀스크린 라우트(=미보유)에선 entitled 가
    /// true 가 되면 AppRoot 가 SessionsView 로 다시 분기하므로 dismiss 를 호출해도 무해 (no-op).
    @Environment(\.dismiss) private var dismiss

    /// 어떤 상품의 결제가 진행 중인지 — 해당 카드에만 스피너를 띄우기 위한 로컬 추적.
    @State private var pendingKind: ProductKind?

    var body: some View {
        ScrollView {
            VStack(spacing: 24) {
                header

                freeTierNote

                if purchase.products.isEmpty {
                    loadingCard
                } else {
                    productCards
                }

                if let err = purchase.lastError {
                    Text(err)
                        .font(.footnote)
                        .foregroundStyle(Theme.danger)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 24)
                }

                restoreButton
                disclosure
            }
            .padding(.horizontal, 24)
            .padding(.vertical, 32)
            .frame(maxWidth: .infinity)
        }
        .background(Color(.systemBackground))
    }

    // MARK: - Header

    private var header: some View {
        VStack(spacing: 12) {
            // 앱 로고(=AppIcon 원본 1024 재활용). 뜬금없는 SF Symbol 대신 브랜드 정체성을 보여준다.
            // iOS 아이콘처럼 보이도록 continuous 라운드로 마스킹.
            Image("AppLogo")
                .resizable()
                .scaledToFit()
                .frame(width: Theme.IconSize.xxxl, height: Theme.IconSize.xxxl)
                .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.xl, style: .continuous))

            Text("Pocket Sisyphus 프로")
                .font(.title2.weight(.semibold))
                .multilineTextAlignment(.center)

            subhead
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 8)
        }
        .padding(.top, 24)
    }

    /// 무료체험 적격이면 «7일 무료» 톤, 이미 체험을 썼으면 일반 구독 톤.
    /// (각 분기가 Text 리터럴이라 카탈로그 자동 추출 경로를 탄다 — String 으로 합치지 않는다.)
    private var subhead: Text {
        purchase.isEligibleForIntroOffer
            ? Text("7일 무료로 시작하고 마음에 들면 계속 — 언제든 해지할 수 있어요.")
            : Text("구독으로 모든 기능을 계속 사용하세요. 언제든 해지할 수 있어요.")
    }

    /// 구매가 «강제» 가 아님을 명확히 — 기본 앱은 무료고 프로 기능만 잠긴다. 결제 압박을 낮추고,
    /// (페어링 전 진입 시) App Store 심사관에게도 앱 성격을 분명히 알린다.
    private var freeTierNote: some View {
        Text("구매하지 않아도 기본 기능은 무료로 사용할 수 있어요. 프로 기능만 구독 또는 평생 이용권으로 잠금 해제됩니다.")
            .font(.footnote)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity)
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(Color(.secondarySystemBackground))
            )
    }

    // MARK: - Product cards

    @ViewBuilder
    private var productCards: some View {
        VStack(spacing: 12) {
            // 연간 — 추천(최선의 가치). 보라 prominent.
            if let product = purchase.products[.yearly], let period = Self.period(for: product) {
                subscriptionButton(kind: .yearly, product: product, period: period,
                                   title: "연간", recommended: true)
            }
            // 월간 — 보조.
            if let product = purchase.products[.monthly], let period = Self.period(for: product) {
                subscriptionButton(kind: .monthly, product: product, period: period,
                                   title: "월간", recommended: false)
            }
            // 평생 — 비구독(체험 없음). «오래 쓸 계획이면» 유도.
            if let product = purchase.products[.lifetime] {
                lifetimeButton(product: product)
            }
        }
    }

    private func subscriptionButton(kind: ProductKind, product: Product, period: PaywallCopy.Period,
                                    title: LocalizedStringKey, recommended: Bool) -> some View {
        // 이미 localize 된 최종 문자열 (PaywallCopy 가 String(localized:) 로 조립) → verbatim 으로 표시.
        let line = PaywallCopy.subscriptionLine(
            displayPrice: product.displayPrice,
            period: period,
            hasFreeTrial: purchase.isEligibleForIntroOffer
        )
        return Button {
            Task {
                pendingKind = kind
                let ok = await purchase.purchase(kind)
                pendingKind = nil
                if ok { dismiss() }
            }
        } label: {
            VStack(spacing: 4) {
                HStack(spacing: 6) {
                    Text(title).font(.headline)
                    if recommended {
                        Text("추천")
                            .font(.caption2.weight(.bold))
                            .padding(.horizontal, 8)
                            .padding(.vertical, 2)
                            .background(Theme.onAccent.opacity(0.25))
                            .clipShape(Capsule())
                    }
                    if pendingKind == kind {
                        ProgressView().tint(recommended ? Theme.onAccent : Theme.accent)
                    }
                }
                Text(verbatim: line)
                    .font(.subheadline)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 14)
        }
        .buttonStyleProminent(recommended)
        .tint(Theme.accent)
        .disabled(purchase.isPurchasing)
    }

    private func lifetimeButton(product: Product) -> some View {
        Button {
            Task {
                pendingKind = .lifetime
                let ok = await purchase.purchase(.lifetime)
                pendingKind = nil
                if ok { dismiss() }
            }
        } label: {
            VStack(spacing: 4) {
                HStack(spacing: 6) {
                    Text("평생 이용권").font(.headline)
                    if pendingKind == .lifetime {
                        ProgressView().tint(Theme.accent)
                    }
                }
                Text(verbatim: product.displayPrice)
                    .font(.subheadline)
                Text("한 번 구매로 평생 — 오래 쓸 계획이라면")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 12)
        }
        .buttonStyle(.bordered)
        .tint(Theme.accent)
        .disabled(purchase.isPurchasing)
    }

    // MARK: - Loading / Restore / Disclosure

    private var loadingCard: some View {
        VStack(spacing: 10) {
            ProgressView()
            (purchase.isLoadingProducts ? Text("상품 정보 불러오는 중…") : Text("상품 정보를 확인할 수 없습니다."))
                .font(.footnote)
                .foregroundStyle(.secondary)
            if !purchase.isLoadingProducts {
                Button("다시 시도") {
                    Task { await purchase.loadProducts() }
                }
                .font(.footnote)
            }
        }
        .frame(maxWidth: .infinity, minHeight: 100)
        .padding()
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(Color(.secondarySystemBackground))
        )
    }

    private var restoreButton: some View {
        Button {
            Task {
                await purchase.restore()
                if purchase.isEntitled { dismiss() }
            }
        } label: {
            HStack {
                if purchase.isRestoring {
                    ProgressView()
                } else {
                    Image(systemName: "arrow.clockwise")
                }
                purchase.isRestoring ? Text("복원 중…") : Text("이전 구매 복원")
            }
            .font(.callout)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 10)
        }
        .buttonStyle(.bordered)
        .tint(Theme.accent)
        .disabled(purchase.isRestoring)
    }

    private var disclosure: some View {
        VStack(spacing: 8) {
            disclosureText
                .font(.caption2)
                .foregroundStyle(.tertiary)
                .multilineTextAlignment(.center)
            HStack(spacing: 12) {
                Link("이용약관", destination: LegalLinks.terms)
                Text(verbatim: "·").foregroundStyle(.tertiary)
                Link("개인정보처리방침", destination: LegalLinks.privacy)
            }
            .font(.caption2)
        }
        .padding(.top, 4)
        .padding(.horizontal, 8)
    }

    /// 자동갱신 고지 — 적격 시 무료체험을 명시한다. (Text 분기로 카탈로그 자동 추출.)
    private var disclosureText: Text {
        purchase.isEligibleForIntroOffer
            ? Text("월간·연간 구독은 7일 무료 체험 후 자동으로 갱신됩니다. 기간이 끝나기 24시간 전까지 해지하지 않으면 표시된 가격으로 자동 결제되며, App Store 계정 설정에서 언제든 해지할 수 있어요. 평생 이용권은 한 번만 결제하는 비구독 상품입니다.")
            : Text("월간·연간 구독은 기간이 끝나기 24시간 전까지 해지하지 않으면 표시된 가격으로 자동 갱신·결제되며, App Store 계정 설정에서 언제든 해지할 수 있어요. 평생 이용권은 한 번만 결제하는 비구독 상품입니다.")
    }

    // MARK: - Helpers

    /// StoreKit 구독 기간 단위 → PaywallCopy.Period. (PaywallCopy 를 StoreKit-free 로 유지하려고
    /// 매핑은 뷰가 담당.) 월/년 외 단위는 nil — 우리 상품은 P1M / P1Y 만 쓴다.
    private static func period(for product: Product) -> PaywallCopy.Period? {
        guard let unit = product.subscription?.subscriptionPeriod.unit else { return nil }
        switch unit {
        case .month: return .month
        case .year: return .year
        default: return nil
        }
    }
}

/// 자동갱신 구독 고지에 필요한 법적 링크. App Store 심사는 페이월에서 이용약관(EULA)과
/// 개인정보처리방침으로의 «작동하는» 링크를 요구한다.
///
/// - terms: Apple 표준 EULA. 자체 EULA 가 없으면 이 표준 링크가 허용된다.
/// - privacy: Notion 에 게시한 개인정보처리방침.
private enum LegalLinks {
    static let terms = URL(string: "https://www.apple.com/legal/internet-services/itunes/dev/stdeula/")!
    static let privacy = URL(string: "https://wonderful-legume-a15.notion.site/Pocket-Sisyphus-Privacy-Policy-36955f6e358a80c4b985cda45e8969ff")!
}

private extension View {
    /// 추천 카드는 prominent(채움), 그 외는 일반 bordered. ViewBuilder 분기로 buttonStyle 을 고른다
    /// (buttonStyle 은 타입이 달라 삼항으로 못 묶는다).
    @ViewBuilder
    func buttonStyleProminent(_ prominent: Bool) -> some View {
        if prominent {
            self.buttonStyle(.borderedProminent)
        } else {
            self.buttonStyle(.bordered)
        }
    }
}
