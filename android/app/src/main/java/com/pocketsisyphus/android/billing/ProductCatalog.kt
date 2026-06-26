package com.pocketsisyphus.android.billing

/**
 * The Pro IAP catalog — single source of truth for Google Play product ids, mirroring the iOS
 * `ProductKind` (Services/ProductCatalog.swift). Monthly + yearly are auto-renewing subscriptions;
 * lifetime is a one-time non-consumable that grants a permanent entitlement (the Android equivalent
 * of the iOS lifetime license).
 */
enum class ProductKind(val productId: String, val isSubscription: Boolean) {
    MONTHLY("ps_pro_monthly", true),
    YEARLY("ps_pro_yearly", true),
    LIFETIME("ps_pro_lifetime", false);

    companion object {
        fun from(productId: String): ProductKind? = entries.firstOrNull { it.productId == productId }
        val subscriptionIds: List<String> get() = entries.filter { it.isSubscription }.map { it.productId }
        val inAppIds: List<String> get() = entries.filter { !it.isSubscription }.map { it.productId }
    }
}

/**
 * Registry of every «Pro (orange)» feature — the single truth of «what is Pro». Entry points require
 * a `ProFeature` so a new Pro surface can't silently ship ungated. Mirrors iOS `ProFeature`.
 * Only the two automation domains are in scope for this Android port.
 */
enum class ProFeature {
    WORKFLOW, // workflow canvas
    CRON,     // scheduled tasks
    BACKLOG,  // PO loop — AI persona-based opportunity briefs (collect / research)
}
