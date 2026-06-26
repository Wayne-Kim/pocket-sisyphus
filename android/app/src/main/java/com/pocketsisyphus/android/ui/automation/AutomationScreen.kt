package com.pocketsisyphus.android.ui.automation

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.pocketsisyphus.android.R
import com.pocketsisyphus.android.data.model.CronJob
import com.pocketsisyphus.android.data.model.VersionInfo
import com.pocketsisyphus.android.data.model.WorkflowSummary
import com.pocketsisyphus.android.ui.cron.CronListScreen
import com.pocketsisyphus.android.ui.theme.PsColor
import com.pocketsisyphus.android.ui.workflow.WorkflowListScreen

private enum class Segment { WORKFLOWS, CRON }

/**
 * Automation home — the Pro (orange) domain hosting Workflows + Scheduled tasks. Gating order:
 *  1. version unknown → loading.
 *  2. daemon lacks the automation capabilities (old Mac) → «update the Mac app» branch.
 *  3. Pro not unlocked → a locked state that opens the paywall.
 *  4. otherwise the supported segment(s) are shown.
 *
 * Per the color policy, only the *tab* button (in the bottom bar) is orange; the segmented control
 * and inner buttons keep the default accent.
 */
@Composable
fun AutomationScreen(
    version: VersionInfo?,
    isProUnlocked: Boolean,
    onOpenPaywall: () -> Unit,
    onNewCron: () -> Unit,
    onEditCron: (CronJob) -> Unit,
    onNewWorkflow: () -> Unit,
    onEditWorkflow: (WorkflowSummary) -> Unit,
    onRunWorkflow: (WorkflowSummary) -> Unit,
    onOpenSession: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    // 1. Still resolving capabilities.
    if (version == null) {
        CenterColumn(modifier) { CircularProgressIndicator() }
        return
    }
    // 2. Daemon too old to expose either domain.
    if (!version.supportsAutomation) {
        UpdateMacBranch(modifier)
        return
    }
    // 3. Pro gate.
    if (!isProUnlocked) {
        LockedState(modifier, onOpenPaywall)
        return
    }

    val showWorkflows = version.supportsWorkflows
    val showCron = version.supportsCron
    var segment by remember {
        mutableStateOf(if (showWorkflows) Segment.WORKFLOWS else Segment.CRON)
    }
    val effective = when {
        segment == Segment.WORKFLOWS && !showWorkflows -> Segment.CRON
        segment == Segment.CRON && !showCron -> Segment.WORKFLOWS
        else -> segment
    }

    Box(modifier = modifier) {
        Column(modifier = Modifier.fillMaxSize()) {
            if (showWorkflows && showCron) {
                SingleChoiceSegmentedButtonRow(
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
                ) {
                    SegmentedButton(
                        selected = effective == Segment.WORKFLOWS,
                        onClick = { segment = Segment.WORKFLOWS },
                        shape = SegmentedButtonDefaults.itemShape(0, 2),
                    ) { Text(stringResource(R.string.automation_seg_workflows)) }
                    SegmentedButton(
                        selected = effective == Segment.CRON,
                        onClick = { segment = Segment.CRON },
                        shape = SegmentedButtonDefaults.itemShape(1, 2),
                    ) { Text(stringResource(R.string.automation_seg_cron)) }
                }
            }
            when (effective) {
                Segment.WORKFLOWS -> WorkflowListScreen(onEdit = onEditWorkflow, onRun = onRunWorkflow)
                Segment.CRON -> CronListScreen(onEdit = onEditCron, onOpenSession = onOpenSession)
            }
        }

        FloatingActionButton(
            onClick = { if (effective == Segment.WORKFLOWS) onNewWorkflow() else onNewCron() },
            modifier = Modifier.align(Alignment.BottomEnd).padding(16.dp),
        ) {
            Icon(
                Icons.Filled.Add,
                contentDescription = stringResource(
                    if (effective == Segment.WORKFLOWS) R.string.wf_new else R.string.cron_new,
                ),
            )
        }
    }
}

@Composable
private fun UpdateMacBranch(modifier: Modifier = Modifier) {
    CenterColumn(modifier) {
        Icon(Icons.Filled.Lock, contentDescription = null, tint = PsColor.warning, modifier = Modifier.size(44.dp))
        Text(
            stringResource(R.string.automation_update_mac_title),
            style = MaterialTheme.typography.titleMedium,
            textAlign = TextAlign.Center,
        )
        Text(
            stringResource(R.string.automation_update_mac_body),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )
    }
}

@Composable
private fun LockedState(modifier: Modifier = Modifier, onOpenPaywall: () -> Unit) {
    CenterColumn(modifier) {
        Icon(Icons.Filled.Lock, contentDescription = null, tint = PsColor.pro, modifier = Modifier.size(44.dp))
        Text(
            stringResource(R.string.automation_locked_title),
            style = MaterialTheme.typography.titleMedium,
            color = PsColor.pro,
            textAlign = TextAlign.Center,
        )
        Text(
            stringResource(R.string.automation_locked_body),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )
        Button(
            onClick = onOpenPaywall,
            colors = ButtonDefaults.buttonColors(containerColor = PsColor.accent),
        ) { Text(stringResource(R.string.automation_unlock)) }
    }
}

@Composable
private fun CenterColumn(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    Box(modifier = modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(12.dp),
            modifier = Modifier.padding(32.dp),
        ) { content() }
    }
}
