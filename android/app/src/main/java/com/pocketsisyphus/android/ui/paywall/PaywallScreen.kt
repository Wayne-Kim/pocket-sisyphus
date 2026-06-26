package com.pocketsisyphus.android.ui.paywall

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.pocketsisyphus.android.R
import com.pocketsisyphus.android.billing.EntitlementStore
import com.pocketsisyphus.android.billing.ProProduct
import com.pocketsisyphus.android.billing.ProductKind
import com.pocketsisyphus.android.data.Ps
import com.pocketsisyphus.android.ui.theme.PsColor

/** Find the hosting Activity from a Compose Context (needed to launch the billing flow). */
private fun Context.findActivity(): Activity? {
    var ctx = this
    while (ctx is ContextWrapper) {
        if (ctx is Activity) return ctx
        ctx = ctx.baseContext
    }
    return null
}

/**
 * Pro paywall (3-tier) shown when a Pro entry point is tapped without entitlement. Mirrors the iOS
 * PaywallView copy & policy: subscription CTAs use accent (purple); orange is reserved for marking
 * «Pro features», never as a CTA color. Free-tier note keeps the pressure low.
 */
@Composable
fun PaywallScreen(onClose: () -> Unit) {
    val store = Ps.entitlement
    val state by store.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val activity = context.findActivity()

    LaunchedEffect(Unit) { store.start() }
    // Close automatically once entitlement flips to unlocked (purchase / restore succeeded).
    LaunchedEffect(state.isEntitled) { if (state.isEntitled) onClose() }

    Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        Column(modifier = Modifier.fillMaxSize()) {
            Row(
                modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                IconButton(onClick = onClose) {
                    Icon(Icons.Filled.Close, contentDescription = stringResource(R.string.close))
                }
            }
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 24.dp, vertical = 8.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(24.dp),
            ) {
                Header(eligibleForTrial = state.isEligibleForIntroOffer)
                FreeTierNote()

                if (state.products.isEmpty()) {
                    LoadingCard(loading = state.isLoadingProducts, onRetry = { store.start() })
                } else {
                    ProductCards(state) { kind -> activity?.let { store.purchase(it, kind) } }
                }

                state.lastError?.let {
                    Text(
                        it,
                        color = PsColor.danger,
                        style = MaterialTheme.typography.bodySmall,
                        textAlign = TextAlign.Center,
                    )
                }

                RestoreButton(restoring = state.isRestoring) { store.restore() }
                Disclosure(eligibleForTrial = state.isEligibleForIntroOffer)
            }
        }
    }
}

@Composable
private fun Header(eligibleForTrial: Boolean) {
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(12.dp),
        modifier = Modifier.padding(top = 16.dp),
    ) {
        Text(
            stringResource(R.string.paywall_title),
            style = MaterialTheme.typography.titleLarge,
            fontWeight = FontWeight.SemiBold,
            textAlign = TextAlign.Center,
        )
        Text(
            stringResource(
                if (eligibleForTrial) R.string.paywall_subhead_trial else R.string.paywall_subhead_plain,
            ),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )
    }
}

@Composable
private fun FreeTierNote() {
    Surface(
        shape = RoundedCornerShape(12.dp),
        color = MaterialTheme.colorScheme.surfaceVariant,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Text(
            stringResource(R.string.paywall_free_note),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp),
        )
    }
}

@Composable
private fun ProductCards(state: EntitlementStore.State, onBuy: (ProductKind) -> Unit) {
    Column(
        modifier = Modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        state.products[ProductKind.YEARLY]?.let {
            SubscriptionCard(
                title = stringResource(R.string.paywall_yearly),
                product = it,
                recommended = true,
                eligibleForTrial = state.isEligibleForIntroOffer,
                enabled = !state.isPurchasing,
                onBuy = onBuy,
            )
        }
        state.products[ProductKind.MONTHLY]?.let {
            SubscriptionCard(
                title = stringResource(R.string.paywall_monthly),
                product = it,
                recommended = false,
                eligibleForTrial = state.isEligibleForIntroOffer,
                enabled = !state.isPurchasing,
                onBuy = onBuy,
            )
        }
        state.products[ProductKind.LIFETIME]?.let {
            LifetimeCard(product = it, enabled = !state.isPurchasing, onBuy = onBuy)
        }
    }
}

@Composable
private fun SubscriptionCard(
    title: String,
    product: ProProduct,
    recommended: Boolean,
    eligibleForTrial: Boolean,
    enabled: Boolean,
    onBuy: (ProductKind) -> Unit,
) {
    val line = subscriptionLine(product, eligibleForTrial)
    val content: @Composable () -> Unit = {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(4.dp),
            modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp),
        ) {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(title, style = MaterialTheme.typography.titleMedium)
                if (recommended) {
                    Surface(shape = RoundedCornerShape(50), color = Color.White.copy(alpha = 0.25f)) {
                        Text(
                            stringResource(R.string.paywall_recommended),
                            style = MaterialTheme.typography.labelSmall,
                            modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp),
                        )
                    }
                }
            }
            Text(line, style = MaterialTheme.typography.bodyMedium)
        }
    }
    if (recommended) {
        Button(
            onClick = { onBuy(product.kind) },
            enabled = enabled,
            colors = ButtonDefaults.buttonColors(containerColor = PsColor.accent, contentColor = Color.White),
            modifier = Modifier.fillMaxWidth(),
        ) { content() }
    } else {
        OutlinedButton(
            onClick = { onBuy(product.kind) },
            enabled = enabled,
            colors = ButtonDefaults.outlinedButtonColors(contentColor = PsColor.accent),
            modifier = Modifier.fillMaxWidth(),
        ) { content() }
    }
}

@Composable
private fun LifetimeCard(product: ProProduct, enabled: Boolean, onBuy: (ProductKind) -> Unit) {
    OutlinedButton(
        onClick = { onBuy(product.kind) },
        enabled = enabled,
        colors = ButtonDefaults.outlinedButtonColors(contentColor = PsColor.accent),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(2.dp),
            modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp),
        ) {
            Text(stringResource(R.string.paywall_lifetime), style = MaterialTheme.typography.titleMedium)
            Text(product.formattedPrice, style = MaterialTheme.typography.bodyMedium)
            Text(
                stringResource(R.string.paywall_lifetime_note),
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun subscriptionLine(product: ProProduct, eligibleForTrial: Boolean): String {
    val price = product.formattedPrice
    val per = when (product.period) {
        "P1M" -> stringResource(R.string.paywall_per_month)
        "P1Y" -> stringResource(R.string.paywall_per_year)
        else -> ""
    }
    return if (eligibleForTrial && product.hasFreeTrial) {
        stringResource(R.string.paywall_trial_then, price, per)
    } else {
        stringResource(R.string.paywall_price_per, price, per)
    }
}

@Composable
private fun LoadingCard(loading: Boolean, onRetry: () -> Unit) {
    Surface(
        shape = RoundedCornerShape(16.dp),
        color = MaterialTheme.colorScheme.surfaceVariant,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(10.dp),
            modifier = Modifier.fillMaxWidth().padding(24.dp),
        ) {
            if (loading) CircularProgressIndicator(modifier = Modifier.size(28.dp))
            Text(
                stringResource(if (loading) R.string.paywall_loading else R.string.paywall_unavailable),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            if (!loading) {
                OutlinedButton(onClick = onRetry) { Text(stringResource(R.string.retry)) }
            }
        }
    }
}

@Composable
private fun RestoreButton(restoring: Boolean, onRestore: () -> Unit) {
    OutlinedButton(
        onClick = onRestore,
        enabled = !restoring,
        colors = ButtonDefaults.outlinedButtonColors(contentColor = PsColor.accent),
        modifier = Modifier.fillMaxWidth(),
    ) {
        if (restoring) {
            CircularProgressIndicator(modifier = Modifier.size(18.dp), color = PsColor.accent)
        } else {
            Icon(Icons.Filled.Refresh, contentDescription = null)
        }
        Text(
            stringResource(if (restoring) R.string.paywall_restoring else R.string.paywall_restore),
            modifier = Modifier.padding(start = 8.dp),
        )
    }
}

@Composable
private fun Disclosure(eligibleForTrial: Boolean) {
    Text(
        stringResource(
            if (eligibleForTrial) R.string.paywall_disclosure_trial else R.string.paywall_disclosure_plain,
        ),
        style = MaterialTheme.typography.labelSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        textAlign = TextAlign.Center,
    )
}
