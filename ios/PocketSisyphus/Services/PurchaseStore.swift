import Foundation
import StoreKit
import SwiftUI  // 프로 게이트 헬퍼(gate)·페이월 modifier 의 Binding/View

// SwiftUI 도 `Transaction`(애니메이션) 타입을 들고 와서, 이 파일의 StoreKit `Transaction`
// (updates/currentEntitlements/VerificationResult) 사용이 모두 모호해진다. 이 파일에선 항상
// StoreKit 쪽이 맞으므로 파일 스코프 typealias 로 못박는다.
private typealias Transaction = StoreKit.Transaction

/// StoreKit 2 기반 3종 IAP (월·년 구독 + 평생 비소모성) 구매/복원/entitlement 추적.
/// 상품 정의는 `ProductKind` (Services/ProductCatalog.swift) 가 SSOT.
///
/// 책임:
///  - 부팅 시 한 번 product metadata 로딩 + 현재 entitlement·도입혜택 적격성 동기화.
///  - `Transaction.updates` async 스트림 구독 — 다른 기기 구매/구독 갱신/환불/Family Share
///    같은 외부 이벤트를 백그라운드에서 반영.
///  - `purchase(_:)` / `restore()` 액션은 페이월(`PaywallView`) 가, `refreshOnForeground()` 는
///    앱 foreground 복귀가 호출.
///
/// **entitlement 결정은 무조건 `Transaction.currentEntitlements` 를 기준으로**.
/// 자체 캐시 (UserDefaults) 를 두지 않는 이유: 환불·구독취소·구독만료·Family Share 해제 같은
/// 변경이 발생했을 때 캐시와 StoreKit 상태가 어긋나면 «구매했는데 잠겨있다» 또는 «만료됐는데
/// 풀려있다» 양쪽 다 사용자 불만으로 직결된다. 무료체험 기간 중인 구독도 currentEntitlements
/// 에 포함되므로 «체험 중 == 활성 == 잠금 해제» 가 자동으로 성립한다.
@MainActor
final class PurchaseStore: ObservableObject {
    /// kind → 로드된 Product metadata. 비어 있으면 아직 로드 전이거나 실패.
    @Published private(set) var products: [ProductKind: Product] = [:]
    /// 3개 중 하나라도 보유/활성이면 true. EntitlementDecision 게이트의 단일 입력.
    @Published private(set) var isEntitled: Bool = false
    /// 현재 보유/활성인 상품 종류. 구독 관리 진입점 노출(설정) / 페이월 중복 권유 방지에 쓴다.
    @Published private(set) var ownedKinds: Set<ProductKind> = []
    /// 구독 그룹에서 7일 무료 도입혜택에 적격인가 (Apple 관리, 그룹 단위 — 재설치·기기변경에도 추적).
    @Published private(set) var isEligibleForIntroOffer: Bool = false

    @Published private(set) var isLoadingProducts: Bool = false
    @Published private(set) var isPurchasing: Bool = false
    @Published private(set) var isRestoring: Bool = false
    @Published private(set) var lastError: String?

    /// 현재 활성 구독(월/년)이 하나라도 있는가 — 설정의 «구독 관리» 노출 판단.
    var hasActiveSubscription: Bool {
        ownedKinds.contains { $0.isSubscription }
    }

    /// 프로(주황) 기능을 쓸 수 있는가. 무료 출시 단계(iapEnabled=false)엔 항상 true → 전부 무료.
    /// iapEnabled=true 면 보유/활성(구독·무료체험·평생) 여부.
    ///
    /// 직접 호출보다 `isUnlocked(_:)` / `gate(_:_:_:)` 를 쓰는 게 원칙 — 프로 기능은 어떤
    /// ProFeature 인지 태깅을 거치게 해 게이트 누락(예: worktree 무료 노출 회귀)을 막는다.
    var isProUnlocked: Bool {
        // 시뮬레이터 자가 검증 루프(DevPairing) — StoreKit 구매가 불가능한 시뮬레이터에서
        // 프로 화면(백로그/워크플로우 등)을 검증할 수 있게 PS_DEV_PRO=1 이면 보유로 간주.
        // DEBUG+시뮬레이터 밖에선 DevPairing.isActive 가 false 상수라 죽는 분기.
        if DevPairing.isActive, ProcessInfo.processInfo.environment["PS_DEV_PRO"] == "1" {
            return true
        }
        return EntitlementDecision.proUnlocked(isEntitled: isEntitled)
    }

    // MARK: - 프로 기능 게이트 (단일 진입점)

    /// 이 프로 기능을 쓸 수 있는가. 지금은 전 기능이 같은 판정(isProUnlocked)을 공유하지만,
    /// 기능별로 정책이 갈리면 «여기 한 곳» 에서만 분기한다(호출부는 그대로). 프로 여부를 «표시/
    /// 비활성» 으로 반영하는 자리(에이전트 행 «프로» 마커·만들기 버튼 disable 등)는 이걸 쓴다.
    func isUnlocked(_ feature: ProFeature) -> Bool {
        isProUnlocked
    }

    /// 프로 진입점의 «탭 시» 게이트 — 보유면 `run()`, 아니면 `paywall` 바인딩에 feature 를 실어
    /// 페이월(`.proPaywall(item:)`)을 띄운다. 모든 프로 «액션» 은 이 한 줄을 거친다:
    /// `purchase.gate(.cron, $paywall) { showCron = true }`. (분산된 `if isProUnlocked …` 인라인
    /// 분기 + 뷰마다의 `@State showProPaywall` 보일러플레이트를 대체.)
    func gate(_ feature: ProFeature, _ paywall: Binding<ProFeature?>, _ run: () -> Void) {
        if isUnlocked(feature) {
            run()
        } else {
            paywall.wrappedValue = feature
        }
    }

    private var updatesTask: Task<Void, Never>?

    init() {
        // IAP 가 꺼져 있는 동안 (무료 출시 단계) 에는 StoreKit 에 손대지 않는다.
        // PaywallView 가 어차피 노출되지 않으므로 product metadata, Transaction.updates 스트림,
        // currentEntitlements 동기화 모두 불필요. App Store Connect 에 IAP 가 아직 등록되지
        // 않은 단계에서는 loadProducts() 가 lastError 를 빨갛게 채워두는 부작용도 있어 막는다.
        guard EntitlementDecision.iapEnabled else { return }

        // Transaction.updates 는 앱 부팅 이전에 일어난 일도 포함해 흘러온다 — 그래도 명시적으로
        // 한 번 currentEntitlements 를 읽어 두면 UI 가 «잠금 해제됨» 으로 1프레임이라도 빨리 뜬다.
        updatesTask = Task { [weak self] in
            for await result in Transaction.updates {
                await self?.handle(result)
            }
        }
        Task { await self.refreshEntitlement() }
        Task { await self.loadProducts() }
    }

    deinit {
        updatesTask?.cancel()
    }

    // MARK: - Product metadata

    func loadProducts() async {
        isLoadingProducts = true
        defer { isLoadingProducts = false }
        do {
            let fetched = try await Product.products(for: ProductKind.allIDs)
            var map: [ProductKind: Product] = [:]
            for p in fetched {
                if let kind = ProductKind.from(id: p.id) { map[kind] = p }
            }
            self.products = map
            if map.isEmpty {
                self.lastError = String(localized: "상품 정보를 불러올 수 없습니다. App Store 에 상품이 등록·승인되었는지 확인해 주세요.")
            } else {
                self.lastError = nil
            }
            await refreshIntroEligibility()
        } catch {
            self.lastError = String(localized: "상품 정보 로드 실패: \(error.localizedDescription)")
        }
    }

    /// 7일 무료 도입혜택 적격성 — «구독 그룹 단위» 라 둘 중 아무 구독으로 한 번 물으면 그룹 전체 답.
    private func refreshIntroEligibility() async {
        guard let anySub = products[.monthly]?.subscription ?? products[.yearly]?.subscription else {
            self.isEligibleForIntroOffer = false
            return
        }
        self.isEligibleForIntroOffer = await anySub.isEligibleForIntroOffer
    }

    // MARK: - Purchase / Restore

    /// Apple 구매 시트를 띄우고, 결제·승인이 완료되면 entitlement 를 갱신.
    /// 반환값: 결제 후 실제로 entitled 가 되었을 때만 true. 취소/대기/실패는 false.
    func purchase(_ kind: ProductKind) async -> Bool {
        guard let product = products[kind] else {
            self.lastError = String(localized: "상품이 아직 로드되지 않았습니다. 잠시 후 다시 시도해 주세요.")
            return false
        }
        isPurchasing = true
        defer { isPurchasing = false }
        self.lastError = nil
        do {
            let result = try await product.purchase()
            switch result {
            case .success(let verification):
                let transaction = try Self.checkVerified(verification)
                // finish() 안 부르면 다음 부팅마다 Transaction.updates 로 다시 흘러옴.
                await transaction.finish()
                await refreshEntitlement()
                await refreshIntroEligibility()
                return self.isEntitled
            case .userCancelled:
                return false
            case .pending:
                // Ask to Buy / SCA — 결정이 미뤄짐. updatesTask 가 나중에 잡아 entitlement 를 푼다.
                return false
            @unknown default:
                return false
            }
        } catch {
            self.lastError = String(localized: "구매 실패: \(error.localizedDescription)")
            return false
        }
    }

    /// «이전 구매 복원» 액션. AppStore.sync() 는 비밀번호를 요구하므로 사용자가 명시적으로
    /// 누른 경우에만 호출 — 자동 호출은 피한다 (애플 가이드라인).
    func restore() async {
        isRestoring = true
        defer { isRestoring = false }
        self.lastError = nil
        do {
            try await AppStore.sync()
            await refreshEntitlement()
            await refreshIntroEligibility()
        } catch {
            self.lastError = String(localized: "복원 실패: \(error.localizedDescription)")
        }
    }

    /// foreground 복귀 시 호출 — 백그라운드 동안 구독이 만료되면 `Transaction.updates` 이벤트가
    /// 오지 않으므로(만료는 «빠지는» 변화라 push 가 없다) 다음 콜드런치까지 잠금이 풀린 채 보인다.
    /// scenePhase `.active` 에서 currentEntitlements 를 다시 읽어 만료를 반영한다.
    func refreshOnForeground() async {
        guard EntitlementDecision.iapEnabled else { return }
        await refreshEntitlement()
        await refreshIntroEligibility()
    }

    // MARK: - Internals

    private func refreshEntitlement() async {
        var owned: Set<ProductKind> = []
        for await result in Transaction.currentEntitlements {
            guard case .verified(let transaction) = result else { continue }
            guard let kind = ProductKind.from(id: transaction.productID) else { continue }
            // 환불/취소되어 revoke 된 트랜잭션은 entitlement 아님. 만료된 구독은 애초에
            // currentEntitlements 에 들어오지 않으므로 별도 판정 불필요.
            if transaction.revocationDate == nil {
                owned.insert(kind)
            }
        }
        self.ownedKinds = owned
        self.isEntitled = !owned.isEmpty
    }

    private func handle(_ result: VerificationResult<Transaction>) async {
        guard case .verified(let transaction) = result else { return }
        guard ProductKind.from(id: transaction.productID) != nil else { return }
        await transaction.finish()
        await refreshEntitlement()
        await refreshIntroEligibility()
    }

    private static func checkVerified<T>(_ result: VerificationResult<T>) throws -> T {
        switch result {
        case .verified(let value):
            return value
        case .unverified(_, let error):
            throw error
        }
    }
}

// MARK: - 프로 게이트 페이월 modifier

extension View {
    /// 프로 게이트 페이월 호스트 — `item` 이 set 되면(= 미보유 사용자가 프로 진입점을 탭) `PaywallView`
    /// 시트를 띄운다. 모달 컨텍스트마다 «자기 것» 을 호스팅하므로 NewSessionView 같은 시트 위에서도
    /// 올바르게 겹친다(루트 단일 호스팅은 «시트 위 시트» 가 안 떠 불가). 뷰마다 흩어져 있던
    /// `@State var showProPaywall: Bool` + `.sheet { PaywallView() }` 보일러플레이트를 한 줄로 통일.
    func proPaywall(item: Binding<ProFeature?>) -> some View {
        sheet(item: item) { _ in PaywallView() }
    }
}
