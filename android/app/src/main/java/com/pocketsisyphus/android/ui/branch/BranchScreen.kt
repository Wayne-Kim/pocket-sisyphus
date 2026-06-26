package com.pocketsisyphus.android.ui.branch

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.pocketsisyphus.android.R
import com.pocketsisyphus.android.data.ApiException
import com.pocketsisyphus.android.data.Ps
import com.pocketsisyphus.android.data.model.GitBranchItem
import com.pocketsisyphus.android.data.model.GitBranchesResponse
import com.pocketsisyphus.android.data.model.GitWorktree
import com.pocketsisyphus.android.ui.theme.PsColor
import androidx.compose.ui.res.stringResource
import kotlinx.coroutines.launch

/**
 * Branch & worktree management — iOS BranchSheet parity. List local/remote branches (switch, delete),
 * create branches, and manage worktrees (list, add, remove). Reuses the existing daemon git endpoints.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BranchScreen(sessionId: String, onBack: () -> Unit) {
    val scope = rememberCoroutineScope()
    var branches by remember { mutableStateOf<GitBranchesResponse?>(null) }
    var worktrees by remember { mutableStateOf<List<GitWorktree>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    var showNew by remember { mutableStateOf(false) }
    var deleteName by remember { mutableStateOf<String?>(null) }
    var forceName by remember { mutableStateOf<String?>(null) }
    var removeWt by remember { mutableStateOf<GitWorktree?>(null) }
    var showAddWt by remember { mutableStateOf(false) }

    suspend fun reload() {
        try {
            branches = Ps.api.gitBranches(sessionId)
            worktrees = Ps.api.gitWorktrees(sessionId).worktrees
            error = null
        } catch (e: Throwable) {
            error = e.message
        }
        loading = false
    }
    LaunchedEffect(sessionId) { reload() }

    fun act(block: suspend () -> Unit) {
        scope.launch {
            busy = true
            try { block(); reload() } catch (e: Throwable) { error = e.message } finally { busy = false }
        }
    }

    fun doDelete(name: String, force: Boolean) {
        scope.launch {
            busy = true
            try {
                Ps.api.gitDeleteBranch(sessionId, name, force)
                reload()
            } catch (e: ApiException) {
                if (e.code == 409 && !force) forceName = name else error = e.errorBody
            } catch (e: Throwable) {
                error = e.message
            } finally {
                busy = false
            }
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.branch_title)) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.back))
                    }
                },
                actions = {
                    if (busy) CircularProgressIndicator(modifier = Modifier.size(20.dp).padding(end = 8.dp))
                    IconButton(onClick = { showNew = true }) {
                        Icon(Icons.Filled.Add, contentDescription = stringResource(R.string.branch_new))
                    }
                },
            )
        },
    ) { inner ->
        if (loading) {
            Box(Modifier.fillMaxSize().padding(inner), contentAlignment = Alignment.Center) {
                CircularProgressIndicator()
            }
            return@Scaffold
        }
        LazyColumn(modifier = Modifier.fillMaxSize().padding(inner)) {
            error?.let { item { Text(it, color = PsColor.danger, modifier = Modifier.padding(16.dp)) } }

            item { SectionHeader(stringResource(R.string.branch_local)) }
            items(branches?.local ?: emptyList()) { b ->
                BranchRow(
                    branch = b,
                    onSwitch = if (b.current) null else { { act { Ps.api.gitCheckout(sessionId, b.name) } } },
                    onDelete = if (b.current) null else { { deleteName = b.name } },
                )
            }

            val remote = branches?.remote ?: emptyList()
            if (remote.isNotEmpty()) {
                item { SectionHeader(stringResource(R.string.branch_remote)) }
                items(remote) { b ->
                    BranchRow(
                        branch = b,
                        onSwitch = { act { Ps.api.gitCheckout(sessionId, b.name, track = true) } },
                        onDelete = null,
                    )
                }
            }

            item {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(start = 16.dp, end = 8.dp, top = 16.dp, bottom = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    Text(
                        stringResource(R.string.branch_worktrees),
                        style = MaterialTheme.typography.labelLarge,
                        color = MaterialTheme.colorScheme.primary,
                    )
                    TextButton(onClick = { showAddWt = true }) { Text(stringResource(R.string.branch_worktree_add)) }
                }
            }
            items(worktrees) { wt ->
                WorktreeRow(wt, onRemove = if (wt.isMain || wt.isCurrent) null else { { removeWt = wt } })
            }
        }
    }

    if (showNew) {
        NameDialog(
            title = stringResource(R.string.branch_new),
            confirm = stringResource(R.string.branch_create),
            withSwitch = true,
            switchLabel = stringResource(R.string.branch_create_switch),
            onDismiss = { showNew = false },
            onConfirm = { name, sw -> showNew = false; act { Ps.api.gitCreateBranch(sessionId, name, checkout = sw) } },
        )
    }
    if (showAddWt) {
        NameDialog(
            title = stringResource(R.string.branch_worktree_add),
            confirm = stringResource(R.string.branch_create),
            withSwitch = true,
            switchLabel = stringResource(R.string.branch_new),
            onDismiss = { showAddWt = false },
            onConfirm = { name, newBranch -> showAddWt = false; act { Ps.api.gitAddWorktree(sessionId, name, newBranch = newBranch) } },
        )
    }
    deleteName?.let { name ->
        ConfirmDialog(
            message = stringResource(R.string.branch_delete_q, name),
            confirm = stringResource(R.string.delete),
            onConfirm = { deleteName = null; doDelete(name, force = false) },
            onDismiss = { deleteName = null },
        )
    }
    forceName?.let { name ->
        ConfirmDialog(
            message = stringResource(R.string.branch_delete_force),
            confirm = stringResource(R.string.delete),
            onConfirm = { forceName = null; doDelete(name, force = true) },
            onDismiss = { forceName = null },
        )
    }
    removeWt?.let { wt ->
        ConfirmDialog(
            message = stringResource(R.string.branch_worktree_remove_q),
            confirm = stringResource(R.string.delete),
            onConfirm = { removeWt = null; act { Ps.api.gitRemoveWorktree(sessionId, wt.path) } },
            onDismiss = { removeWt = null },
        )
    }
}

@Composable
private fun SectionHeader(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.labelLarge,
        color = MaterialTheme.colorScheme.primary,
        modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 16.dp, bottom = 4.dp),
    )
}

@Composable
private fun BranchRow(branch: GitBranchItem, onSwitch: (() -> Unit)?, onDelete: (() -> Unit)?) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .then(if (onSwitch != null) Modifier.clickable(onClick = onSwitch) else Modifier)
            .padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        if (branch.current) {
            Icon(Icons.Filled.Check, contentDescription = stringResource(R.string.branch_current), tint = PsColor.success, modifier = Modifier.size(18.dp))
        } else {
            Box(Modifier.size(18.dp))
        }
        Column(Modifier.weight(1f)) {
            Text(
                branch.name,
                style = MaterialTheme.typography.bodyLarge.copy(fontFamily = FontFamily.Monospace),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (branch.subject.isNotBlank()) {
                Text(
                    branch.subject,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        if (onDelete != null) {
            IconButton(onClick = onDelete) {
                Icon(Icons.Filled.Delete, contentDescription = stringResource(R.string.delete), tint = PsColor.danger)
            }
        }
    }
    HorizontalDivider()
}

@Composable
private fun WorktreeRow(wt: GitWorktree, onRemove: (() -> Unit)?) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(
                    wt.branch ?: wt.path.trimEnd('/').substringAfterLast('/'),
                    style = MaterialTheme.typography.bodyLarge,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                if (wt.isMain) Badge(stringResource(R.string.branch_main))
                if (wt.isCurrent) Badge(stringResource(R.string.branch_current))
            }
            Text(
                wt.path,
                style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        if (onRemove != null) {
            IconButton(onClick = onRemove) {
                Icon(Icons.Filled.Delete, contentDescription = stringResource(R.string.delete), tint = PsColor.danger)
            }
        }
    }
    HorizontalDivider()
}

@Composable
private fun Badge(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.labelSmall,
        color = PsColor.info,
    )
}

@Composable
private fun NameDialog(
    title: String,
    confirm: String,
    withSwitch: Boolean,
    switchLabel: String,
    onDismiss: () -> Unit,
    onConfirm: (String, Boolean) -> Unit,
) {
    var name by remember { mutableStateOf("") }
    var checked by remember { mutableStateOf(false) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it },
                    placeholder = { Text(stringResource(R.string.branch_name_hint)) },
                    singleLine = true,
                    textStyle = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
                )
                if (withSwitch) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Checkbox(checked = checked, onCheckedChange = { checked = it })
                        Text(switchLabel)
                    }
                }
            }
        },
        confirmButton = {
            TextButton(enabled = name.isNotBlank(), onClick = { onConfirm(name.trim(), checked) }) { Text(confirm) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.cancel)) } },
    )
}

@Composable
private fun ConfirmDialog(message: String, confirm: String, onConfirm: () -> Unit, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        text = { Text(message) },
        confirmButton = {
            TextButton(onClick = onConfirm) { Text(confirm, color = PsColor.danger) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.cancel)) } },
    )
}
