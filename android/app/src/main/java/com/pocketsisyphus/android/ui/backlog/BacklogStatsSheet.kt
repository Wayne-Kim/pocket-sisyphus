package com.pocketsisyphus.android.ui.backlog

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.pocketsisyphus.android.R
import com.pocketsisyphus.android.data.model.PoStats
import com.pocketsisyphus.android.ui.theme.PsColor

private fun pct(v: Double?): String = v?.let { "${(it * 100).toInt()}%" } ?: "—"

/**
 * «성적표» scorecard card at the top of the backlog — always shown (iOS shows it even before there's
 * enough data). With <5 decisions it shows a «not enough data yet» subtitle; otherwise the headline
 * approval / verify-hit rates. Tapping opens the per-repo breakdown sheet.
 */
@Composable
fun StatsSummaryRow(stats: PoStats, onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                stringResource(R.string.backlog_stats_title),
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold,
            )
            Text(
                if (stats.decidedCount >= 5) {
                    stringResource(R.string.backlog_stats_summary_line, pct(stats.approvalRate), pct(stats.verifyHitRate))
                } else {
                    stringResource(R.string.backlog_stats_insufficient)
                },
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Icon(
            Icons.AutoMirrored.Filled.KeyboardArrowRight,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun Metric(label: String, value: String, color: androidx.compose.ui.graphics.Color) {
    Column {
        Text(value, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, color = color)
        Text(label, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/** Per-repo scorecard breakdown sheet. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BacklogStatsSheet(stats: PoStats, onDismiss: () -> Unit) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheetState) {
        Column(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(bottom = 32.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(stringResource(R.string.backlog_stats_title), style = MaterialTheme.typography.titleLarge)
            Row(horizontalArrangement = Arrangement.spacedBy(24.dp)) {
                Metric(stringResource(R.string.backlog_stats_approval), pct(stats.approvalRate), PsColor.success)
                Metric(stringResource(R.string.backlog_stats_verify), pct(stats.verifyHitRate), PsColor.info)
                Metric(stringResource(R.string.backlog_stats_shipped_n), stats.shipped.toString(), MaterialTheme.colorScheme.onSurface)
            }
            if (stats.repos.size > 1) {
                HorizontalDivider(color = PsColor.outline.copy(alpha = 0.4f))
                stats.repos.forEach { r ->
                    Row(
                        modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        Text(
                            r.repoName,
                            style = MaterialTheme.typography.bodyMedium,
                            fontWeight = FontWeight.Medium,
                            modifier = Modifier.weight(1f),
                        )
                        Text(
                            stringResource(R.string.backlog_stats_repo_line, pct(r.approvalRate), r.shipped),
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
        }
    }
}
