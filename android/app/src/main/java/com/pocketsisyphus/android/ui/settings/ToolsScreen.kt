package com.pocketsisyphus.android.ui.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Build
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.pocketsisyphus.android.R
import com.pocketsisyphus.android.data.model.AddMcpRequest
import com.pocketsisyphus.android.data.model.AgentKind
import com.pocketsisyphus.android.data.model.McpCatalogEntry
import com.pocketsisyphus.android.data.model.McpServer
import com.pocketsisyphus.android.data.model.McpStatus
import com.pocketsisyphus.android.data.model.statusValue
import com.pocketsisyphus.android.ui.theme.PsColor

/**
 * Settings → Tools. Add/connect/revoke/delete the external (MCP) tool servers the agent uses —
 * the same daemon `/api/mcp` contract the iPhone consumes. This is the «advanced» group: emphasis
 * is pro (orange), not warning. Tokens stay on the Mac; the phone sees status only. Connection
 * failures are danger (red); «connection needed» is warning (yellow) — pro ≠ warning.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ToolsScreen(
    vm: SettingsViewModel,
    onBack: () -> Unit,
) {
    val ui by vm.tools.collectAsStateWithLifecycle()
    var showAdd by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) { vm.loadTools() }

    val addDesc = stringResource(R.string.tools_add)
    SettingsScaffold(
        title = stringResource(R.string.tools_title),
        onBack = onBack,
        actions = {
            IconButton(
                onClick = { showAdd = true },
                enabled = ui.catalog.isNotEmpty(),
                modifier = Modifier.clearAndSetSemantics { contentDescription = addDesc },
            ) {
                Icon(Icons.Filled.Add, contentDescription = null)
            }
        },
    ) { inner ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(inner)
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            when {
                ui.loading && ui.servers.isEmpty() ->
                    Box(Modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator()
                    }
                ui.servers.isEmpty() -> EmptyTools(loadError = ui.loadError)
                else -> {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        Icon(Icons.Filled.Build, contentDescription = null, tint = PsColor.pro, modifier = Modifier.size(18.dp))
                        Text(stringResource(R.string.tools_advanced), style = MaterialTheme.typography.labelLarge, color = PsColor.pro)
                    }
                    ui.servers.forEach { server ->
                        ToolRow(
                            server = server,
                            busy = ui.busyId == server.id,
                            onConnect = { vm.connectTool(server) },
                            onRevoke = { vm.revokeTool(server) },
                            onDelete = { vm.deleteTool(server) },
                        )
                    }
                    Text(
                        stringResource(R.string.tools_footer),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }

            ui.actionError?.let {
                Text(stringResource(R.string.tools_action_failed, it), color = PsColor.danger, style = MaterialTheme.typography.bodySmall)
            }
            Spacer(Modifier.height(8.dp))
        }
    }

    if (showAdd) {
        AddToolSheet(
            catalog = ui.catalog,
            saving = ui.saving,
            saveError = ui.saveError,
            onClearError = { vm.clearSaveError() },
            onDismiss = { showAdd = false },
            onAdd = { req -> vm.addTool(req) { showAdd = false } },
        )
    }
}

@Composable
private fun EmptyTools(loadError: Boolean) {
    Column(
        modifier = Modifier.fillMaxWidth().padding(top = 40.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Icon(Icons.Filled.Build, contentDescription = null, tint = PsColor.pro, modifier = Modifier.size(48.dp))
        Text(stringResource(R.string.tools_empty_title), style = MaterialTheme.typography.titleMedium)
        Text(
            stringResource(R.string.tools_empty_body),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        if (loadError) {
            Text(stringResource(R.string.tools_load_failed), style = MaterialTheme.typography.bodySmall, color = PsColor.danger)
        }
    }
}

@Composable
private fun ToolRow(
    server: McpServer,
    busy: Boolean,
    onConnect: () -> Unit,
    onRevoke: () -> Unit,
    onDelete: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f))
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Box(
                modifier = Modifier
                    .size(36.dp)
                    .clip(RoundedCornerShape(8.dp))
                    .background(PsColor.pro.copy(alpha = 0.12f)),
                contentAlignment = Alignment.Center,
            ) {
                Icon(Icons.Filled.Build, contentDescription = null, tint = PsColor.pro, modifier = Modifier.size(18.dp))
            }
            Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(providerLabel(server), style = MaterialTheme.typography.titleSmall)
                StatusBadge(server.statusValue())
            }
            if (busy) CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
        }

        if (server.writeEnabled) {
            Text(stringResource(R.string.tools_write_enabled), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }

        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            when (server.statusValue()) {
                McpStatus.CONNECTED ->
                    OutlinedButton(onClick = onRevoke, enabled = !busy) {
                        Text(stringResource(R.string.tools_disconnect), color = PsColor.danger)
                    }
                else ->
                    Button(onClick = onConnect, enabled = !busy) {
                        Text(
                            if (server.statusValue() == McpStatus.EXPIRED) stringResource(R.string.tools_reconnect)
                            else stringResource(R.string.tools_connect),
                        )
                    }
            }
            OutlinedButton(onClick = onDelete, enabled = !busy) {
                Text(stringResource(R.string.tools_delete), color = PsColor.danger)
            }
        }
    }
}

@Composable
private fun StatusBadge(status: McpStatus) {
    val color = when (status) {
        McpStatus.CONNECTED -> PsColor.success
        McpStatus.EXPIRED, McpStatus.ERROR, McpStatus.UNREACHABLE -> PsColor.danger
        McpStatus.UNCONFIGURED -> PsColor.warning
    }
    val text = when (status) {
        McpStatus.CONNECTED -> stringResource(R.string.tools_status_connected)
        McpStatus.EXPIRED -> stringResource(R.string.tools_status_expired)
        McpStatus.ERROR -> stringResource(R.string.tools_status_error)
        McpStatus.UNREACHABLE -> stringResource(R.string.tools_status_unreachable)
        McpStatus.UNCONFIGURED -> stringResource(R.string.tools_status_unconfigured)
    }
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        Box(modifier = Modifier.size(8.dp).clip(CircleShape).background(color))
        Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AddToolSheet(
    catalog: List<McpCatalogEntry>,
    saving: Boolean,
    saveError: String?,
    onClearError: () -> Unit,
    onDismiss: () -> Unit,
    onAdd: (AddMcpRequest) -> Unit,
) {
    val agents = listOf(AgentKind.CLAUDE_CODE, AgentKind.CODEX, AgentKind.COPILOT, AgentKind.AGY)
    var catalogId by remember { mutableStateOf(catalog.firstOrNull { it.id != "custom" }?.id ?: catalog.firstOrNull()?.id ?: "") }
    var agent by remember { mutableStateOf(agents.first().id) }
    var repoPath by remember { mutableStateOf("") }
    var url by remember {
        mutableStateOf(catalog.firstOrNull { it.id == catalogId }?.defaultUrl.orEmpty())
    }
    var writeEnabled by remember { mutableStateOf(false) }

    val isCustom = catalogId == "custom"
    val canSave = catalogId.isNotEmpty() && repoPath.isNotBlank() && url.isNotBlank() && !saving

    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp)
                .padding(bottom = 32.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Icon(Icons.Filled.Build, contentDescription = null, tint = PsColor.pro, modifier = Modifier.size(20.dp))
                Text(stringResource(R.string.tool_add_title), style = MaterialTheme.typography.titleLarge)
            }

            // Provider (advanced = pro).
            Text(stringResource(R.string.tool_add_kind), style = MaterialTheme.typography.labelLarge, color = PsColor.pro)
            Row(modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                catalog.forEach { entry ->
                    FilterChip(
                        selected = catalogId == entry.id,
                        onClick = {
                            catalogId = entry.id
                            entry.defaultUrl.takeIf { it.isNotBlank() }?.let { url = it }
                            if (entry.id == "custom") writeEnabled = false
                        },
                        label = { Text(catalogEntryLabel(entry)) },
                    )
                }
            }

            Text(stringResource(R.string.tool_add_agent), style = MaterialTheme.typography.labelLarge)
            Row(modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                agents.forEach { a ->
                    FilterChip(selected = agent == a.id, onClick = { agent = a.id }, label = { Text(a.label) })
                }
            }

            OutlinedTextField(
                value = repoPath,
                onValueChange = { repoPath = it },
                label = { Text(stringResource(R.string.tool_add_project_label)) },
                supportingText = { Text(stringResource(R.string.tool_add_project_footer)) },
                singleLine = true,
                textStyle = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
                modifier = Modifier.fillMaxWidth(),
            )

            OutlinedTextField(
                value = url,
                onValueChange = { url = it },
                label = { Text(stringResource(R.string.tool_add_url)) },
                supportingText = {
                    Text(if (isCustom) stringResource(R.string.tool_add_url_hint_custom) else stringResource(R.string.tool_add_url_hint_default))
                },
                singleLine = true,
                textStyle = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
                modifier = Modifier.fillMaxWidth(),
            )

            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                val writeLabel = stringResource(R.string.tool_add_write)
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(writeLabel, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
                    Switch(
                        checked = writeEnabled,
                        onCheckedChange = { writeEnabled = it },
                        enabled = !isCustom,
                        modifier = Modifier.semantics { contentDescription = writeLabel },
                    )
                }
                Text(stringResource(R.string.tool_add_write_footer), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }

            saveError?.let {
                Text(stringResource(R.string.tool_add_failed, it), color = PsColor.danger, style = MaterialTheme.typography.bodySmall)
            }

            Button(
                onClick = {
                    onClearError()
                    onAdd(AddMcpRequest(catalogId, agent, repoPath.trim(), url.trim(), writeEnabled))
                },
                enabled = canSave,
                modifier = Modifier.fillMaxWidth(),
            ) {
                if (saving) {
                    CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.onPrimary)
                } else {
                    Text(stringResource(R.string.tool_add_save))
                }
            }
        }
    }
}

@Composable
private fun providerLabel(server: McpServer): String = when (server.catalogId) {
    "google_calendar" -> stringResource(R.string.tools_provider_calendar)
    "gmail" -> stringResource(R.string.tools_provider_gmail)
    "custom" -> stringResource(R.string.tools_provider_custom)
    else -> server.label.ifBlank { server.catalogId }
}

@Composable
private fun catalogEntryLabel(entry: McpCatalogEntry): String = when (entry.id) {
    "google_calendar" -> stringResource(R.string.tools_provider_calendar)
    "gmail" -> stringResource(R.string.tools_provider_gmail)
    "custom" -> stringResource(R.string.tools_provider_custom)
    else -> entry.label.ifBlank { entry.id }
}
