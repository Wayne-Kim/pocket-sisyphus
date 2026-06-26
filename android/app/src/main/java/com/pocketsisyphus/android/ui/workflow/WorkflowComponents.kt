package com.pocketsisyphus.android.ui.workflow

import androidx.compose.ui.graphics.Color
import com.pocketsisyphus.android.ui.theme.PsColor

/** Node-kind colors — synced with iOS/Mac Theme.Node: start=green, task=pink, end=blue. */
fun nodeKindColor(type: String): Color = when (type) {
    "start" -> PsColor.nodeStart
    "end" -> PsColor.nodeEnd
    else -> PsColor.nodeTask // task / general / test
}

/** Node-run status color — distinct from node-kind category (status signals). */
fun nodeStatusColor(status: String): Color = when (status) {
    "done" -> PsColor.success
    "failed" -> PsColor.danger
    "running" -> PsColor.info
    "awaiting_approval", "needs_attention" -> PsColor.warning
    "skipped" -> PsColor.onBgMuted
    else -> PsColor.onBgMuted // pending
}

/** Edge color — normal neutral, fail branch danger. */
fun edgeColor(condition: String?): Color =
    if (condition == "fail") PsColor.danger else PsColor.onBgMuted.copy(alpha = 0.6f)

/** synthetic/empty result is a «needs attention» signal, not a clean done. */
fun isHollowResult(resultKind: String?): Boolean =
    resultKind == "synthetic" || resultKind == "empty"
