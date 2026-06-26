package com.pocketsisyphus.android.ui.cron

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.pocketsisyphus.android.R
import com.pocketsisyphus.android.data.model.AgentKind
import com.pocketsisyphus.android.data.model.CronJob
import com.pocketsisyphus.android.ui.components.Pill
import com.pocketsisyphus.android.ui.theme.PsColor

/**
 * Scheduled-tasks list. Empty / loading / error states are all handled. Each row toggles enabled,
 * runs now, and edits; a long-press-free delete lives behind a confirm dialog. A failed/timeout last
 * status is shown in warning yellow (a «needs attention» signal, consistent with the daemon).
 */
@Composable
fun CronListScreen(
    onEdit: (CronJob) -> Unit,
    onOpenSession: (String) -> Unit,
    vm: CronViewModel = viewModel(),
) {
    val state by vm.state.collectAsStateWithLifecycle()
    var confirmDelete by remember { mutableStateOf<CronJob?>(null) }

    Box(modifier = Modifier.fillMaxSize()) {
        val jobs = state.jobs
        when {
            state.loading && jobs.isEmpty() ->
                Center { CircularProgressIndicator() }
            state.error != null && jobs.isEmpty() ->
                Center {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text(stringResource(R.string.cron_load_failed), color = PsColor.danger)
                        Text(
                            state.error!!,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            jobs.isEmpty() ->
                Center { Text(stringResource(R.string.cron_empty)) }
            else ->
                LazyColumn(
                    contentPadding = PaddingValues(vertical = 8.dp, horizontal = 0.dp),
                    modifier = Modifier.fillMaxSize(),
                ) {
                    items(jobs, key = { it.id }) { job ->
                        CronRowItem(
                            job = job,
                            busy = state.busyId == job.id,
                            onToggle = { vm.toggleEnabled(job) },
                            onRun = { vm.runNow(job.id) },
                            onEdit = { onEdit(job) },
                            onDelete = { confirmDelete = job },
                        )
                        HorizontalDivider(color = PsColor.outline.copy(alpha = 0.4f))
                    }
                }
        }
    }

    confirmDelete?.let { job ->
        AlertDialog(
            onDismissRequest = { confirmDelete = null },
            title = { Text(stringResource(R.string.cron_delete_title)) },
            text = { Text(stringResource(R.string.cron_delete_message, job.displayTitle)) },
            confirmButton = {
                TextButton(onClick = { vm.delete(job.id); confirmDelete = null }) {
                    Text(stringResource(R.string.delete), color = PsColor.danger)
                }
            },
            dismissButton = {
                TextButton(onClick = { confirmDelete = null }) { Text(stringResource(R.string.cancel)) }
            },
        )
    }

    state.runResult?.let { result ->
        val sessionId = result.sessionId
        AlertDialog(
            onDismissRequest = { vm.clearRunResult() },
            title = { Text(stringResource(R.string.cron_run_title)) },
            text = {
                Text(
                    when (result.status) {
                        "running" -> stringResource(R.string.cron_run_started)
                        "skipped" -> stringResource(R.string.cron_run_skipped)
                        else -> stringResource(R.string.cron_run_failed)
                    },
                )
            },
            confirmButton = {
                if (result.status == "running" && sessionId != null) {
                    TextButton(onClick = { vm.clearRunResult(); onOpenSession(sessionId) }) {
                        Text(stringResource(R.string.cron_open_session))
                    }
                } else {
                    TextButton(onClick = { vm.clearRunResult() }) { Text(stringResource(R.string.ok)) }
                }
            },
            dismissButton = {
                if (result.status == "running" && sessionId != null) {
                    TextButton(onClick = { vm.clearRunResult() }) { Text(stringResource(R.string.ok)) }
                }
            },
        )
    }
}

@Composable
private fun CronRowItem(
    job: CronJob,
    busy: Boolean,
    onToggle: () -> Unit,
    onRun: () -> Unit,
    onEdit: () -> Unit,
    onDelete: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onEdit)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(
                job.displayTitle,
                style = MaterialTheme.typography.titleMedium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                job.schedule,
                style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                if (job.isTerminal) {
                    Pill(stringResource(R.string.cron_kind_terminal), PsColor.pro)
                } else {
                    Pill(AgentKind.label(job.agent), PsColor.accent)
                }
                cronStatusKey(job.lastStatus)?.let { key ->
                    val warn = job.lastStatus == "error" || job.lastStatus == "timeout"
                    Pill(stringResource(key), if (warn) PsColor.warning else PsColor.onBgMuted)
                }
            }
        }
        if (busy) {
            CircularProgressIndicator(modifier = Modifier.size(20.dp))
        } else {
            IconButton(onClick = onRun) {
                Icon(
                    Icons.Filled.PlayArrow,
                    contentDescription = stringResource(R.string.cron_run_now),
                    tint = PsColor.success,
                )
            }
        }
        Switch(checked = job.isEnabled, onCheckedChange = { onToggle() })
        TextButton(onClick = onDelete) { Text(stringResource(R.string.delete), color = PsColor.danger) }
    }
}

@Composable
private fun Center(content: @Composable () -> Unit) {
    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { content() }
}
