package com.pocketsisyphus.android.ui.cron

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.pocketsisyphus.android.R
import com.pocketsisyphus.android.data.model.AgentKind
import com.pocketsisyphus.android.data.model.CronJob
import com.pocketsisyphus.android.data.model.CronJobUpsertRequest
import com.pocketsisyphus.android.ui.theme.PsColor

private val CRON_AGENTS = listOf(
    AgentKind.CLAUDE_CODE, AgentKind.CODEX, AgentKind.COPILOT, AgentKind.AGY,
)

/**
 * Create / edit a scheduled task. Supports both an agent prompt and (when the daemon advertises
 * `cron_terminal_v1`) a terminal script. Terminal-script validation is left to the daemon contract:
 * the daemon rejects a non-absolute / missing / non-file path, and the error surfaces here on save.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CronEditorScreen(
    existing: CronJob?,
    terminalSupported: Boolean,
    onDone: () -> Unit,
    vm: CronEditorViewModel = viewModel(),
) {
    val state by vm.state.collectAsStateWithLifecycle()

    var title by remember { mutableStateOf(existing?.title ?: "") }
    var isTerminal by remember { mutableStateOf(existing?.isTerminal == true && terminalSupported) }
    var agent by remember { mutableStateOf(existing?.agent?.takeIf { it.isNotBlank() } ?: AgentKind.CLAUDE_CODE.id) }
    var repoPath by remember { mutableStateOf(existing?.repoPath ?: "") }
    var command by remember { mutableStateOf(existing?.command ?: "") }
    var shell by remember { mutableStateOf(existing?.shell ?: "zsh") }
    var schedule by remember { mutableStateOf(existing?.schedule ?: "0 9 * * 1-5") }
    var skipPermissions by remember { mutableStateOf(existing?.skipsPermissions ?: true) }
    var continueConversation by remember { mutableStateOf(existing?.continuesConversation ?: false) }
    var notify by remember { mutableStateOf(existing?.notifyEnabled ?: true) }
    var allowOverlap by remember { mutableStateOf(existing?.overlapPolicy == "allow") }
    var catchUp by remember { mutableStateOf((existing?.catchUp ?: 0) == 1) }

    LaunchedEffect(schedule) { vm.previewSchedule(schedule, existing?.timezone) }
    LaunchedEffect(state.saved) { if (state.saved) onDone() }

    val canSave = repoPath.isNotBlank() && command.isNotBlank() && schedule.isNotBlank() && !state.saving

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Text(stringResource(if (existing == null) R.string.cron_new else R.string.cron_edit))
                },
                navigationIcon = {
                    IconButton(onClick = onDone) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.back))
                    }
                },
                actions = {
                    TextButton(
                        enabled = canSave,
                        onClick = {
                            vm.save(
                                existing?.id,
                                CronJobUpsertRequest(
                                    title = title.trim().ifEmpty { null },
                                    kind = if (isTerminal) "terminal" else "agent",
                                    agent = if (isTerminal) null else agent,
                                    repoPath = repoPath.trim(),
                                    command = command.trim(),
                                    shell = if (isTerminal) shell else null,
                                    schedule = schedule.trim(),
                                    skipPermissions = skipPermissions,
                                    sessionMode = if (continueConversation) "continue" else "fresh",
                                    overlapPolicy = if (allowOverlap) "allow" else "skip",
                                    catchUp = catchUp,
                                    notify = notify,
                                    enabled = existing?.isEnabled ?: true,
                                ),
                            )
                        },
                    ) {
                        if (state.saving) {
                            CircularProgressIndicator(modifier = Modifier.padding(end = 4.dp))
                        }
                        Text(stringResource(R.string.save))
                    }
                },
            )
        },
    ) { inner ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(inner)
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            OutlinedTextField(
                value = title,
                onValueChange = { title = it },
                label = { Text(stringResource(R.string.cron_field_title)) },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )

            if (terminalSupported) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    FilterChip(
                        selected = !isTerminal,
                        onClick = { isTerminal = false },
                        label = { Text(stringResource(R.string.cron_kind_agent)) },
                    )
                    FilterChip(
                        selected = isTerminal,
                        onClick = { isTerminal = true },
                        label = { Text(stringResource(R.string.cron_kind_terminal)) },
                    )
                }
            }

            if (!isTerminal) {
                AgentDropdown(agent) { agent = it }
            }

            OutlinedTextField(
                value = repoPath,
                onValueChange = { repoPath = it },
                label = { Text(stringResource(R.string.cron_field_repo)) },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )

            OutlinedTextField(
                value = command,
                onValueChange = { command = it },
                label = {
                    Text(stringResource(if (isTerminal) R.string.cron_field_script else R.string.cron_field_command))
                },
                supportingText = {
                    if (isTerminal) Text(stringResource(R.string.cron_script_hint))
                },
                singleLine = isTerminal,
                minLines = if (isTerminal) 1 else 3,
                modifier = Modifier.fillMaxWidth(),
            )

            if (isTerminal) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    listOf("zsh", "bash", "sh").forEach { sh ->
                        FilterChip(
                            selected = shell == sh,
                            onClick = { shell = sh },
                            label = { Text(sh) },
                        )
                    }
                }
            }

            OutlinedTextField(
                value = schedule,
                onValueChange = { schedule = it },
                label = { Text(stringResource(R.string.cron_field_schedule)) },
                singleLine = true,
                textStyle = MaterialTheme.typography.bodyLarge.copy(fontFamily = FontFamily.Monospace),
                modifier = Modifier.fillMaxWidth(),
            )
            SchedulePresets { schedule = it }
            SchedulePreviewRow(state)

            HorizontalOption(stringResource(R.string.cron_opt_skip_permissions), skipPermissions) { skipPermissions = it }
            HorizontalOption(stringResource(R.string.cron_opt_continue), continueConversation) { continueConversation = it }
            HorizontalOption(stringResource(R.string.cron_opt_notify), notify) { notify = it }
            HorizontalOption(stringResource(R.string.cron_opt_overlap), allowOverlap) { allowOverlap = it }
            HorizontalOption(stringResource(R.string.cron_opt_catchup), catchUp) { catchUp = it }

            state.error?.let {
                Text(it, color = PsColor.danger, style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}

@Composable
private fun AgentDropdown(selected: String, onSelect: (String) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    Box(modifier = Modifier.fillMaxWidth()) {
        OutlinedTextField(
            value = AgentKind.label(selected),
            onValueChange = {},
            readOnly = true,
            label = { Text(stringResource(R.string.cron_field_agent)) },
            modifier = Modifier.fillMaxWidth(),
        )
        // Transparent overlay to capture taps over the read-only field.
        Box(
            modifier = Modifier
                .matchParentSize()
                .clickable { expanded = true },
        )
        androidx.compose.material3.DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            CRON_AGENTS.forEach { kind ->
                DropdownMenuItem(
                    text = { Text(kind.label) },
                    onClick = { onSelect(kind.id); expanded = false },
                )
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SchedulePresets(onPick: (String) -> Unit) {
    val presets = listOf(
        stringResource(R.string.cron_preset_hourly) to "0 * * * *",
        stringResource(R.string.cron_preset_daily) to "0 9 * * *",
        stringResource(R.string.cron_preset_weekdays) to "0 9 * * 1-5",
        stringResource(R.string.cron_preset_weekly) to "0 9 * * 1",
    )
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        presets.forEach { (label, expr) ->
            FilterChip(selected = false, onClick = { onPick(expr) }, label = { Text(label) })
        }
    }
}

@Composable
private fun SchedulePreviewRow(state: CronEditorViewModel.UiState) {
    val preview = state.preview ?: return
    if (!preview.valid) {
        Text(
            preview.error ?: stringResource(R.string.cron_schedule_invalid),
            color = PsColor.warning,
            style = MaterialTheme.typography.bodySmall,
        )
    } else if (preview.nextRuns.isNotEmpty()) {
        Text(
            stringResource(R.string.cron_next_runs, preview.nextRuns.size),
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            style = MaterialTheme.typography.bodySmall,
        )
    }
}

@Composable
private fun HorizontalOption(label: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = androidx.compose.ui.Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(label, style = MaterialTheme.typography.bodyLarge)
        Switch(checked = checked, onCheckedChange = onChange)
    }
}
