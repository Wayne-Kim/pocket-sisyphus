package com.pocketsisyphus.android.ui.backlog

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.pocketsisyphus.android.R

/**
 * Lens id → display string resource. Shared by the picker, brief cards, and research rows so a lens
 * uses the same name everywhere (mirrors iOS `poResearchLensName`). Unknown / "default" → 전방위.
 */
fun lensNameRes(lens: String): Int = when (lens) {
    "design" -> R.string.lens_design
    "bug" -> R.string.lens_bug
    "qa" -> R.string.lens_qa
    "security" -> R.string.lens_security
    "pm" -> R.string.lens_pm
    "marketing" -> R.string.lens_marketing
    "analytics" -> R.string.lens_analytics
    "ops" -> R.string.lens_ops
    "logic" -> R.string.lens_logic
    "ux" -> R.string.lens_ux
    "readability" -> R.string.lens_readability
    else -> R.string.lens_default
}

/** Decide-reason tag → display string resource (po_decide_reason_v1). Mirrors iOS DecideReason. */
fun reasonLabelRes(reason: com.pocketsisyphus.android.data.model.DecideReason): Int = when (reason) {
    com.pocketsisyphus.android.data.model.DecideReason.PRIORITY_LOW -> R.string.reason_priority_low
    com.pocketsisyphus.android.data.model.DecideReason.SCOPE_TOO_BIG -> R.string.reason_scope_too_big
    com.pocketsisyphus.android.data.model.DecideReason.ALREADY_EXISTS -> R.string.reason_already_exists
    com.pocketsisyphus.android.data.model.DecideReason.WEAK_EVIDENCE -> R.string.reason_weak_evidence
    com.pocketsisyphus.android.data.model.DecideReason.WRONG_DIRECTION -> R.string.reason_wrong_direction
}

/**
 * "Written through this expert lens" chip — a classification label, so it stays neutral (no pro/
 * status color borrowing, per the color policy). Callers hide it for "default"/null.
 */
@Composable
fun LensChip(lens: String, modifier: Modifier = Modifier) {
    Text(
        stringResource(lensNameRes(lens)),
        style = MaterialTheme.typography.labelSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = modifier
            .clip(RoundedCornerShape(6.dp))
            .background(MaterialTheme.colorScheme.surfaceVariant)
            .padding(horizontal = 6.dp, vertical = 2.dp),
    )
}
