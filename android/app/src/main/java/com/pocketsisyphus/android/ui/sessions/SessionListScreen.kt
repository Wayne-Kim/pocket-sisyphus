package com.pocketsisyphus.android.ui.sessions

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
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.ui.res.stringResource
import com.pocketsisyphus.android.R
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.pocketsisyphus.android.data.model.AgentKind
import com.pocketsisyphus.android.data.model.RunState
import com.pocketsisyphus.android.data.model.SessionRow
import com.pocketsisyphus.android.ui.components.Pill
import com.pocketsisyphus.android.ui.components.StatusDot
import com.pocketsisyphus.android.ui.components.relativeQuiet
import com.pocketsisyphus.android.ui.components.runStateColor
import com.pocketsisyphus.android.ui.theme.PsColor

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SessionListScreen(
    onOpen: (SessionRow) -> Unit,
    onOpenSettings: () -> Unit,
    modifier: Modifier = Modifier,
    onOpenMirror: () -> Unit = {},
    canMirror: Boolean = false,
    vm: SessionsViewModel = viewModel(),
) {
    val state by vm.state.collectAsStateWithLifecycle()
    var showNew by remember { mutableStateOf(false) }
    var showApprovals by remember { mutableStateOf(false) }
    val now = System.currentTimeMillis()
    val waitingSessions = state.sessions.filter {
        it.runState == RunState.WAITING && !it.isWorkflowSession
    }

    Scaffold(
        modifier = modifier,
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text(stringResource(R.string.tab_sessions))
                        if (state.waitingCount > 0) {
                            val openApprovals = stringResource(R.string.approvals_a11y_open)
                            Text(
                                stringResource(R.string.approvals_awaiting_count, state.waitingCount),
                                style = MaterialTheme.typography.labelSmall,
                                color = PsColor.warning,
                                modifier = Modifier
                                    .clickable { showApprovals = true }
                                    .semantics { contentDescription = openApprovals },
                            )
                        }
                    }
                },
                actions = {
                    IconButton(onClick = { vm.refresh() }) {
                        Icon(Icons.Filled.Refresh, contentDescription = stringResource(R.string.retry))
                    }
                    if (canMirror) {
                        IconButton(onClick = onOpenMirror) {
                            Icon(Icons.Filled.PlayArrow, contentDescription = stringResource(R.string.mirror_title))
                        }
                    }
                    IconButton(onClick = onOpenSettings) {
                        Icon(Icons.Filled.Settings, contentDescription = stringResource(R.string.settings_title))
                    }
                },
            )
        },
        floatingActionButton = {
            FloatingActionButton(onClick = { showNew = true }) {
                Icon(Icons.Filled.Add, contentDescription = stringResource(R.string.sessions_empty_cta))
            }
        },
    ) { inner ->
        Column(modifier = Modifier.fillMaxSize().padding(inner)) {
            OutlinedTextField(
                value = state.query,
                onValueChange = vm::setQuery,
                placeholder = { Text(stringResource(R.string.sessions_search)) },
                singleLine = true,
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
            )
            Row(
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                SessionsViewModel.Filter.entries.forEach { f ->
                    FilterChip(
                        selected = state.filter == f,
                        onClick = { vm.setFilter(f) },
                        label = { Text(stringResource(f.labelRes)) },
                    )
                }
            }

            val visible = state.visible
            when {
                state.loading && visible.isEmpty() ->
                    Center { CircularProgressIndicator() }
                state.error != null && visible.isEmpty() ->
                    Center {
                        Column(horizontalAlignment = Alignment.CenterHorizontally) {
                            Text(stringResource(R.string.sessions_load_failed), color = PsColor.danger)
                            Text(
                                state.error!!,
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                visible.isEmpty() ->
                    // iOS «아직 세션이 없어요» empty state — headline + description + create button.
                    Center {
                        Column(
                            horizontalAlignment = Alignment.CenterHorizontally,
                            verticalArrangement = Arrangement.spacedBy(12.dp),
                            modifier = Modifier.padding(32.dp),
                        ) {
                            Text(
                                stringResource(R.string.sessions_empty_title),
                                style = MaterialTheme.typography.titleMedium,
                                textAlign = TextAlign.Center,
                            )
                            Text(
                                stringResource(R.string.sessions_empty_body),
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                textAlign = TextAlign.Center,
                            )
                            Button(onClick = { showNew = true }) {
                                Text(stringResource(R.string.sessions_empty_cta))
                            }
                        }
                    }
                else ->
                    LazyColumn(
                        contentPadding = PaddingValues(vertical = 8.dp),
                        modifier = Modifier.fillMaxSize(),
                    ) {
                        items(visible, key = { it.id }) { s ->
                            SessionRowItem(s, now) { onOpen(s) }
                            HorizontalDivider(color = PsColor.outline.copy(alpha = 0.4f))
                        }
                    }
            }
        }
    }

    if (showNew) {
        NewSessionSheet(
            creating = state.creating,
            error = state.error,
            onDismiss = { showNew = false },
            onCreate = { repo, title, agent ->
                vm.createSession(repo, title, agent) { id, display ->
                    showNew = false
                    onOpen(SessionRow(id = id, title = display, status = "active", mode = "pty", agent = agent))
                }
            },
        )
    }

    if (showApprovals) {
        ApprovalInboxSheet(
            initialWaiting = waitingSessions,
            liveWaiting = waitingSessions,
            onDismiss = { showApprovals = false },
            onFinished = { vm.refresh() },
        )
    }
}

@Composable
private fun SessionRowItem(s: SessionRow, now: Long, onClick: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            StatusDot(s.runState, Modifier.size(10.dp))
            Text(
                s.displayTitle,
                style = MaterialTheme.typography.titleMedium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            relativeQuiet(s.lastActivity, now)?.let {
                Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        Text(
            s.repoPath,
            style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
            Pill(AgentKind.label(s.agent), PsColor.accent)
            s.worktreeBranchSlug?.let { Pill("⎇ $it", PsColor.success) }
            if (s.runState == RunState.WAITING) Pill("awaiting", PsColor.warning)
        }
        if (s.runState == RunState.WAITING && !s.pendingPromptPreview.isNullOrBlank()) {
            Text(
                s.pendingPromptPreview!!.trim(),
                style = MaterialTheme.typography.bodySmall,
                color = runStateColor(RunState.WAITING),
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
private fun Center(content: @Composable () -> Unit) {
    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { content() }
}
