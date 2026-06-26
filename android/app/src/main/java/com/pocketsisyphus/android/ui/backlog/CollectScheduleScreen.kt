package com.pocketsisyphus.android.ui.backlog

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.pocketsisyphus.android.R
import com.pocketsisyphus.android.data.Ps
import com.pocketsisyphus.android.data.model.PoLens
import com.pocketsisyphus.android.data.model.PoProfileUpsertRequest
import com.pocketsisyphus.android.data.model.VersionInfo
import com.pocketsisyphus.android.ui.theme.PsColor
import kotlinx.coroutines.launch

private enum class Sched(val cron: String?) {
    OFF(null), DAILY("0 9 * * *"), WEEKDAYS("0 9 * * 1-5"), CUSTOM("")
}

/**
 * Per-repo daily auto-collection (po_schedule_v1). The agent collects opportunities unattended on a
 * cron — the user sets a persistent investigation directive, a schedule, and a fixed expert lens.
 * Mirrors the iOS collect-settings screen, with simple presets + a custom-cron escape hatch.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CollectScheduleScreen(
    repoPath: String,
    version: VersionInfo,
    onBack: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    var loading by remember { mutableStateOf(true) }
    var saving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var directive by remember { mutableStateOf("") }
    var sched by remember { mutableStateOf(Sched.OFF) }
    var customCron by remember { mutableStateOf("") }
    var lens by remember { mutableStateOf(PoLens.DEFAULT) }

    val lenses = remember(version) {
        PoLens.collectLenses(
            security = version.supportsCollectSecurityLens,
            allExperts = version.supportsCollectAllExpertsLens,
        )
    }
    val showLens = version.supportsCollectLens && lenses.size > 1

    LaunchedEffect(repoPath) {
        try {
            val p = Ps.api.getPoProfile(repoPath)
            directive = p.directive
            lens = p.lens ?: PoLens.DEFAULT
            sched = when (p.schedule) {
                null, "" -> Sched.OFF
                Sched.DAILY.cron -> Sched.DAILY
                Sched.WEEKDAYS.cron -> Sched.WEEKDAYS
                else -> { customCron = p.schedule; Sched.CUSTOM }
            }
        } catch (e: Throwable) {
            error = e.message
        } finally {
            loading = false
        }
    }

    Scaffold(
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.backlog_schedule_title)) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.back))
                    }
                },
            )
        },
    ) { inner ->
        if (loading) {
            Column(
                modifier = Modifier.fillMaxSize().padding(inner),
                verticalArrangement = Arrangement.Center,
                horizontalAlignment = androidx.compose.ui.Alignment.CenterHorizontally,
            ) { CircularProgressIndicator() }
            return@Scaffold
        }
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(inner)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 16.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Text(repoPath.trimEnd('/').substringAfterLast('/'), style = MaterialTheme.typography.titleMedium)
            Text(
                stringResource(R.string.backlog_schedule_body),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            Text(stringResource(R.string.backlog_schedule_when), style = MaterialTheme.typography.labelLarge)
            SingleChoiceSegmentedButtonRow(modifier = Modifier.fillMaxWidth()) {
                val opts = listOf(
                    Sched.OFF to R.string.backlog_schedule_off,
                    Sched.DAILY to R.string.backlog_schedule_daily,
                    Sched.WEEKDAYS to R.string.backlog_schedule_weekdays,
                    Sched.CUSTOM to R.string.backlog_schedule_custom,
                )
                opts.forEachIndexed { i, (mode, res) ->
                    SegmentedButton(
                        selected = sched == mode,
                        onClick = { sched = mode },
                        shape = SegmentedButtonDefaults.itemShape(i, opts.size),
                    ) { Text(stringResource(res)) }
                }
            }
            if (sched == Sched.CUSTOM) {
                OutlinedTextField(
                    value = customCron,
                    onValueChange = { customCron = it },
                    label = { Text(stringResource(R.string.backlog_schedule_cron)) },
                    placeholder = { Text("0 9 * * *") },
                    singleLine = true,
                    textStyle = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
                    modifier = Modifier.fillMaxWidth(),
                )
            }

            OutlinedTextField(
                value = directive,
                onValueChange = { directive = it },
                label = { Text(stringResource(R.string.backlog_schedule_directive)) },
                placeholder = { Text(stringResource(R.string.backlog_schedule_directive_hint)) },
                minLines = 2,
                modifier = Modifier.fillMaxWidth(),
            )

            if (showLens) {
                Text(stringResource(R.string.backlog_lens), style = MaterialTheme.typography.labelLarge)
                Row(
                    modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    lenses.forEach { id ->
                        FilterChip(
                            selected = lens == id,
                            onClick = { lens = id },
                            label = { Text(stringResource(lensNameRes(id))) },
                        )
                    }
                }
            }

            error?.let { Text(it, color = PsColor.danger, style = MaterialTheme.typography.bodySmall) }

            Button(
                onClick = {
                    saving = true
                    error = null
                    scope.launch {
                        try {
                            val cron = when (sched) {
                                Sched.OFF -> null
                                Sched.CUSTOM -> customCron.trim().ifBlank { null }
                                else -> sched.cron
                            }
                            Ps.api.setPoProfile(
                                PoProfileUpsertRequest(
                                    repoPath = repoPath,
                                    directive = directive.trim(),
                                    schedule = cron,
                                    lens = lens.takeIf { showLens && it != PoLens.DEFAULT },
                                ),
                            )
                            onBack()
                        } catch (e: Throwable) {
                            error = e.message ?: "Failed to save"
                        } finally {
                            saving = false
                        }
                    }
                },
                enabled = !saving,
                modifier = Modifier.fillMaxWidth(),
            ) {
                if (saving) {
                    CircularProgressIndicator(
                        modifier = Modifier.padding(end = 8.dp),
                        strokeWidth = 2.dp,
                        color = MaterialTheme.colorScheme.onPrimary,
                    )
                }
                Text(stringResource(R.string.save))
            }
        }
    }
}
