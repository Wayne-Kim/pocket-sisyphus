package com.pocketsisyphus.android.ui.diagnostics

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Warning
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.pocketsisyphus.android.R
import com.pocketsisyphus.android.data.ConnectionManager.Stage
import com.pocketsisyphus.android.data.ConnectionManager.StageStatus
import com.pocketsisyphus.android.ui.theme.PsColor

/**
 * The brief's single diagnostic screen: a go/no-go proof that the secure channel stands.
 * Color is meaning only — success = green, failure/reject = red, in-progress/pending = neutral
 * (no status hue borrowed for decoration). Body text uses theme-adaptive colors.
 */
@Composable
fun DiagnosticsScreen(
    onContinue: () -> Unit,
    onOpenBridges: () -> Unit,
    vm: DiagnosticsViewModel = viewModel(),
) {
    val state by vm.state.collectAsStateWithLifecycle()

    LaunchedEffect(Unit) { vm.run() }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Spacer(Modifier.height(16.dp))
        Text(stringResource(R.string.diag_title), style = MaterialTheme.typography.headlineSmall)
        Text(
            stringResource(R.string.diag_subtitle),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(4.dp))

        StageRow(R.string.stage_pairing, state.transport[Stage.PAIRING])
        StageRow(R.string.stage_direct, state.transport[Stage.DIRECT])
        StageRow(R.string.stage_tor, state.transport[Stage.TOR])
        StageRow(R.string.stage_endpoint, state.transport[Stage.ENDPOINT])
        StageRow(R.string.stage_ssh, state.transport[Stage.SSH])
        StageRow(R.string.stage_health, state.transport[Stage.HEALTH])
        StageRow(R.string.stage_attest, state.attest)
        StageRow(R.string.stage_api, state.api)

        state.channel?.let {
            Text(
                stringResource(R.string.diag_connected, it),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                fontFamily = FontFamily.Monospace,
            )
        }

        if (state.done) {
            val ok = state.overallOk
            Text(
                stringResource(if (ok) R.string.diag_overall_ok else R.string.diag_overall_fail),
                style = MaterialTheme.typography.titleMedium,
                color = if (ok) PsColor.success else PsColor.danger,
            )
        }
        state.error?.let {
            Text(it, color = PsColor.danger, style = MaterialTheme.typography.bodyMedium)
        }

        // «Tor blocked» card — plaintext Tor stalled. Entry point to the bridge bypass.
        if (state.likelyBlocked) {
            TorBlockedCard(onOpenBridges = onOpenBridges)
        }

        Spacer(Modifier.height(8.dp))

        if (state.done && state.overallOk) {
            Button(onClick = onContinue, modifier = Modifier.fillMaxWidth()) {
                Text(stringResource(R.string.diag_continue))
            }
        }

        val retryDesc = stringResource(R.string.a11y_retry)
        OutlinedButton(
            onClick = { vm.run() },
            enabled = !state.running,
            modifier = Modifier
                .fillMaxWidth()
                .clearAndSetSemantics { contentDescription = retryDesc },
        ) {
            if (state.running) {
                CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
                Spacer(Modifier.height(0.dp))
                Text("  " + stringResource(R.string.status_running))
            } else {
                Text(stringResource(if (state.done) R.string.diag_retry else R.string.diag_run))
            }
        }
    }
}

@Composable
private fun StageRow(labelRes: Int, status: StageStatus?) {
    val s = status ?: StageStatus.PENDING
    val label = stringResource(labelRes)
    val statusLabel = stringResource(statusStringRes(s))
    val rowDesc = stringResource(R.string.a11y_stage_status, label, statusLabel)

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(10.dp))
            .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f))
            .padding(horizontal = 12.dp, vertical = 10.dp)
            .clearAndSetSemantics { contentDescription = rowDesc },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        StatusIndicator(s)
        Text(
            label,
            style = MaterialTheme.typography.bodyLarge,
            color = MaterialTheme.colorScheme.onSurface,
            modifier = Modifier.weight(1f),
        )
        Text(
            statusLabel,
            style = MaterialTheme.typography.bodySmall,
            color = statusColor(s),
        )
    }
}

@Composable
private fun StatusIndicator(status: StageStatus) {
    Box(modifier = Modifier.size(14.dp), contentAlignment = Alignment.Center) {
        if (status == StageStatus.RUNNING) {
            CircularProgressIndicator(
                modifier = Modifier.size(14.dp),
                strokeWidth = 2.dp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        } else {
            Box(
                modifier = Modifier
                    .size(12.dp)
                    .clip(CircleShape)
                    .background(statusColor(status)),
            )
        }
    }
}

private fun statusStringRes(s: StageStatus): Int = when (s) {
    StageStatus.PENDING -> R.string.status_pending
    StageStatus.RUNNING -> R.string.status_running
    StageStatus.SUCCESS -> R.string.status_success
    StageStatus.FAILED -> R.string.status_failed
    StageStatus.SKIPPED -> R.string.status_skipped
}

private fun statusColor(s: StageStatus): Color = when (s) {
    StageStatus.SUCCESS -> PsColor.success
    StageStatus.FAILED -> PsColor.danger
    StageStatus.PENDING, StageStatus.RUNNING, StageStatus.SKIPPED -> PsColor.onBgMuted
}

/**
 * Shown when plaintext Tor looks DPI-blocked. A genuine caution (warning = yellow tint), with an
 * accent button into the bridge bypass — common on school / office / some-country networks.
 */
@Composable
private fun TorBlockedCard(onOpenBridges: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(PsColor.warning.copy(alpha = 0.12f))
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Icon(Icons.Filled.Warning, contentDescription = null, tint = PsColor.warning, modifier = Modifier.size(18.dp))
            Text(
                stringResource(R.string.diag_tor_blocked_title),
                style = MaterialTheme.typography.titleSmall,
                color = MaterialTheme.colorScheme.onSurface,
            )
        }
        Text(
            stringResource(R.string.diag_tor_blocked_body),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Button(onClick = onOpenBridges, modifier = Modifier.fillMaxWidth()) {
            Text(stringResource(R.string.diag_tor_blocked_setup))
        }
    }
}
