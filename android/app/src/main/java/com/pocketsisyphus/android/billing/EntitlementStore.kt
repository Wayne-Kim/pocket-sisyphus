package com.pocketsisyphus.android.billing

import android.app.Activity
import android.content.Context
import com.android.billingclient.api.AcknowledgePurchaseParams
import com.android.billingclient.api.BillingClient
import com.android.billingclient.api.BillingClient.ProductType
import com.android.billingclient.api.BillingClientStateListener
import com.android.billingclient.api.BillingFlowParams
import com.android.billingclient.api.BillingResult
import com.android.billingclient.api.PendingPurchasesParams
import com.android.billingclient.api.ProductDetails
import com.android.billingclient.api.Purchase
import com.android.billingclient.api.QueryProductDetailsParams
import com.android.billingclient.api.QueryPurchasesParams
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume

/**
 * Master switch — mirrors iOS `EntitlementDecision.iapEnabled`. When false the whole app is free.
 *
 * Android has **no Pro product on Google Play yet**, so this is `false`: every Pro-marked feature
 * (Automation, Backlog, …) is fully usable for free. The gating code stays wired throughout — flip
 * this to `true` the moment the `ps_pro_*` products are live in Play Console and the app instantly
 * becomes Pro-only (subscription / lifetime), with no other change needed. Do NOT flip it on before
 * the products exist, or the paywall would have nothing to sell.
 */
object Entitlement {
    const val iapEnabled = false

    /** iapEnabled == false → always unlocked; otherwise gate on owning/active entitlement. */
    fun proUnlocked(isEntitled: Boolean, iapEnabled: Boolean = Entitlement.iapEnabled): Boolean =
        !iapEnabled || isEntitled
}

/** A loaded Play product, ready to render on the paywall and launch a purchase flow. */
data class ProProduct(
    val kind: ProductKind,
    val formattedPrice: String,
    val period: String?,        // "P1M" / "P1Y" for subscriptions, null for lifetime
    val hasFreeTrial: Boolean,
    val details: ProductDetails,
    val offerToken: String?,    // subscription offer token (null for one-time products)
)

/**
 * Google Play Billing wrapper — loads the 3 Pro products, runs purchase / restore, and derives the
 * Pro entitlement purely from `queryPurchases` (the Play-side truth). Mirrors the iOS `PurchaseStore`
 * intent: never cache entitlement in our own store, so refunds / expiry / device-change restore all
 * resolve correctly by re-reading Play. Subscriptions that expire simply stop being returned.
 */
class EntitlementStore(context: Context) {

    data class State(
        val isEntitled: Boolean = false,
        val ownedKinds: Set<ProductKind> = emptySet(),
        val products: Map<ProductKind, ProProduct> = emptyMap(),
        val isLoadingProducts: Boolean = false,
        val isPurchasing: Boolean = false,
        val isRestoring: Boolean = false,
        val billingUnavailable: Boolean = false,
        val lastError: String? = null,
    ) {
        /** Pro is usable — free release stage (iapEnabled=false) unlocks everything. */
        val isProUnlocked: Boolean get() = Entitlement.proUnlocked(isEntitled)
        val isEligibleForIntroOffer: Boolean
            get() = ownedKinds.none { it.isSubscription } && products.values.any { it.hasFreeTrial }
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    private val client: BillingClient = BillingClient.newBuilder(context.applicationContext)
        .setListener { result, purchases ->
            scope.launch { onPurchasesUpdated(result, purchases) }
        }
        .enablePendingPurchases(
            PendingPurchasesParams.newBuilder().enableOneTimeProducts().build(),
        )
        .build()

    private var connected = false

    fun isUnlocked(feature: ProFeature): Boolean = _state.value.isProUnlocked

    /** Connect (idempotent), then load products + refresh entitlement. */
    fun start() {
        if (!Entitlement.iapEnabled) {
            _state.update { it.copy(isEntitled = true) }
            return
        }
        if (connected) {
            scope.launch { loadProducts(); refreshEntitlement() }
            return
        }
        client.startConnection(object : BillingClientStateListener {
            override fun onBillingSetupFinished(result: BillingResult) {
                connected = result.responseCode == BillingClient.BillingResponseCode.OK
                if (connected) {
                    scope.launch { loadProducts(); refreshEntitlement() }
                } else {
                    _state.update { it.copy(billingUnavailable = true) }
                }
            }

            override fun onBillingServiceDisconnected() {
                connected = false
            }
        })
    }

    suspend fun loadProducts() {
        if (!connected) return
        _state.update { it.copy(isLoadingProducts = true, lastError = null) }
        val out = mutableMapOf<ProductKind, ProProduct>()
        querySubs()?.let { out.putAll(it) }
        queryInApp()?.let { out.putAll(it) }
        _state.update { it.copy(isLoadingProducts = false, products = out) }
    }

    private suspend fun querySubs(): Map<ProductKind, ProProduct>? {
        val params = QueryProductDetailsParams.newBuilder().setProductList(
            ProductKind.subscriptionIds.map {
                QueryProductDetailsParams.Product.newBuilder()
                    .setProductId(it).setProductType(ProductType.SUBS).build()
            },
        ).build()
        val details = queryProductDetails(params) ?: return null
        val map = mutableMapOf<ProductKind, ProProduct>()
        details.forEach { pd ->
            val kind = ProductKind.from(pd.productId) ?: return@forEach
            // Prefer the offer that carries a free trial; otherwise the base plan.
            val offers = pd.subscriptionOfferDetails.orEmpty()
            val offer = offers.firstOrNull { o ->
                o.pricingPhases.pricingPhaseList.any { it.priceAmountMicros == 0L }
            } ?: offers.lastOrNull() ?: return@forEach
            val paidPhase = offer.pricingPhases.pricingPhaseList.lastOrNull() ?: return@forEach
            map[kind] = ProProduct(
                kind = kind,
                formattedPrice = paidPhase.formattedPrice,
                period = paidPhase.billingPeriod,
                hasFreeTrial = offer.pricingPhases.pricingPhaseList.any { it.priceAmountMicros == 0L },
                details = pd,
                offerToken = offer.offerToken,
            )
        }
        return map
    }

    private suspend fun queryInApp(): Map<ProductKind, ProProduct>? {
        val params = QueryProductDetailsParams.newBuilder().setProductList(
            ProductKind.inAppIds.map {
                QueryProductDetailsParams.Product.newBuilder()
                    .setProductId(it).setProductType(ProductType.INAPP).build()
            },
        ).build()
        val details = queryProductDetails(params) ?: return null
        val map = mutableMapOf<ProductKind, ProProduct>()
        details.forEach { pd ->
            val kind = ProductKind.from(pd.productId) ?: return@forEach
            val one = pd.oneTimePurchaseOfferDetails ?: return@forEach
            map[kind] = ProProduct(
                kind = kind,
                formattedPrice = one.formattedPrice,
                period = null,
                hasFreeTrial = false,
                details = pd,
                offerToken = null,
            )
        }
        return map
    }

    /** Launch the Play purchase dialog. Result arrives via the PurchasesUpdatedListener. */
    fun purchase(activity: Activity, kind: ProductKind) {
        val product = _state.value.products[kind] ?: return
        val builder = BillingFlowParams.ProductDetailsParams.newBuilder()
            .setProductDetails(product.details)
        product.offerToken?.let { builder.setOfferToken(it) }
        val flowParams = BillingFlowParams.newBuilder()
            .setProductDetailsParamsList(listOf(builder.build()))
            .build()
        _state.update { it.copy(isPurchasing = true, lastError = null) }
        client.launchBillingFlow(activity, flowParams)
    }

    /** Restore — Play has no separate restore; re-query purchases (covers device change). */
    fun restore() {
        scope.launch {
            _state.update { it.copy(isRestoring = true, lastError = null) }
            refreshEntitlement()
            _state.update { it.copy(isRestoring = false) }
        }
    }

    /** Re-read the Play purchase ledger and recompute entitlement (refund / expiry safe). */
    suspend fun refreshEntitlement() {
        if (!connected) return
        val owned = mutableSetOf<ProductKind>()
        queryPurchases(ProductType.SUBS)?.forEach { collectOwned(it, owned) }
        queryPurchases(ProductType.INAPP)?.forEach { collectOwned(it, owned) }
        _state.update { it.copy(isEntitled = owned.isNotEmpty(), ownedKinds = owned) }
    }

    private suspend fun collectOwned(purchase: Purchase, into: MutableSet<ProductKind>) {
        if (purchase.purchaseState != Purchase.PurchaseState.PURCHASED) return
        acknowledgeIfNeeded(purchase)
        purchase.products.forEach { pid -> ProductKind.from(pid)?.let { into.add(it) } }
    }

    private suspend fun onPurchasesUpdated(result: BillingResult, purchases: List<Purchase>?) {
        when (result.responseCode) {
            BillingClient.BillingResponseCode.OK -> {
                purchases?.forEach { p ->
                    if (p.purchaseState == Purchase.PurchaseState.PURCHASED) acknowledgeIfNeeded(p)
                }
                refreshEntitlement()
                _state.update { it.copy(isPurchasing = false) }
            }
            BillingClient.BillingResponseCode.USER_CANCELED ->
                _state.update { it.copy(isPurchasing = false) }
            else ->
                _state.update {
                    it.copy(isPurchasing = false, lastError = result.debugMessage.ifBlank { null })
                }
        }
    }

    private suspend fun acknowledgeIfNeeded(purchase: Purchase) {
        if (purchase.isAcknowledged) return
        val params = AcknowledgePurchaseParams.newBuilder()
            .setPurchaseToken(purchase.purchaseToken).build()
        suspendCancellableCoroutine<Unit> { cont ->
            client.acknowledgePurchase(params) { cont.resume(Unit) }
        }
    }

    // ── suspend bridges over the callback API ───────────────────────────────────

    private suspend fun queryProductDetails(params: QueryProductDetailsParams): List<ProductDetails>? =
        suspendCancellableCoroutine { cont ->
            client.queryProductDetailsAsync(params) { result, productDetailsList ->
                if (result.responseCode == BillingClient.BillingResponseCode.OK) {
                    cont.resume(productDetailsList)
                } else {
                    cont.resume(null)
                }
            }
        }

    private suspend fun queryPurchases(type: String): List<Purchase>? =
        suspendCancellableCoroutine { cont ->
            client.queryPurchasesAsync(
                QueryPurchasesParams.newBuilder().setProductType(type).build(),
            ) { result, purchases ->
                cont.resume(
                    if (result.responseCode == BillingClient.BillingResponseCode.OK) purchases else null,
                )
            }
        }
}
