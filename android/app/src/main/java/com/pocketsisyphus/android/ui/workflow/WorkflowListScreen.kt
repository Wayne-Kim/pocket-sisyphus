package com.pocketsisyphus.android.ui.workflow

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
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
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.pocketsisyphus.android.R
import com.pocketsisyphus.android.data.model.WorkflowSummary
import com.pocketsisyphus.android.ui.components.Pill
import com.pocketsisyphus.android.ui.theme.PsColor

/** Workflow list with empty/loading/error states. Tapping a row opens the editor; play runs it. */
@Composable
fun WorkflowListScreen(
    onEdit: (WorkflowSummary) -> Unit,
    onRun: (WorkflowSummary) -> Unit,
    vm: WorkflowListViewModel = viewModel(),
) {
    val state by vm.state.collectAsStateWithLifecycle()
    var confirmDelete by remember { mutableStateOf<WorkflowSummary?>(null) }

    Box(modifier = Modifier.fillMaxSize()) {
        val items = state.workflows
        when {
            state.loading && items.isEmpty() -> Center { CircularProgressIndicator() }
            state.error != null && items.isEmpty() -> Center {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(stringResource(R.string.wf_load_failed), color = PsColor.danger)
                    Text(
                        state.error!!,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            items.isEmpty() -> Center { Text(stringResource(R.string.wf_empty)) }
            else -> LazyColumn(
                contentPadding = PaddingValues(vertical = 8.dp),
                modifier = Modifier.fillMaxSize(),
            ) {
                items(items, key = { it.id }) { wf ->
                    WorkflowRowItem(
                        wf = wf,
                        onClick = { onEdit(wf) },
                        onRun = { onRun(wf) },
                        onDelete = { confirmDelete = wf },
                    )
                    HorizontalDivider(color = PsColor.outline.copy(alpha = 0.4f))
                }
            }
        }
    }

    confirmDelete?.let { wf ->
        AlertDialog(
            onDismissRequest = { confirmDelete = null },
            title = { Text(stringResource(R.string.wf_delete_title)) },
            text = { Text(stringResource(R.string.wf_delete_message, wf.displayTitle)) },
            confirmButton = {
                TextButton(onClick = { vm.delete(wf.id); confirmDelete = null }) {
                    Text(stringResource(R.string.delete), color = PsColor.danger)
                }
            },
            dismissButton = {
                TextButton(onClick = { confirmDelete = null }) { Text(stringResource(R.string.cancel)) }
            },
        )
    }
}

@Composable
private fun WorkflowRowItem(
    wf: WorkflowSummary,
    onClick: () -> Unit,
    onRun: () -> Unit,
    onDelete: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(
                wf.displayTitle,
                style = MaterialTheme.typography.titleMedium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Pill(stringResource(R.string.wf_node_count, wf.workNodeCount), PsColor.pro)
        }
        IconButton(onClick = onRun) {
            Icon(
                Icons.Filled.PlayArrow,
                contentDescription = stringResource(R.string.wf_run),
                tint = PsColor.success,
            )
        }
        TextButton(onClick = onDelete) { Text(stringResource(R.string.delete), color = PsColor.danger) }
    }
}

@Composable
private fun Center(content: @Composable () -> Unit) {
    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { content() }
}
