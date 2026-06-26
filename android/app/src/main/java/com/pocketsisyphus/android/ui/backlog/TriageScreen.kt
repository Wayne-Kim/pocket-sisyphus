package com.pocketsisyphus.android.ui.backlog

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Checkbox
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.pocketsisyphus.android.R
import com.pocketsisyphus.android.data.model.PoBrief
import com.pocketsisyphus.android.ui.components.Pill
import com.pocketsisyphus.android.ui.theme.PsColor

/**
 * Triage — clear a stack of proposed briefs in one sweep. Multi-select, then bulk **Hold** or
 * **Reject** (approve stays per-brief since it spawns a session). Mirrors iOS `BacklogTriageView`,
 * trimmed to the essential select + bulk-decide loop.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TriageScreen(
    proposed: List<PoBrief>,
    busy: Boolean,
    onBulk: (ids: List<String>, action: String) -> Unit,
    onBack: () -> Unit,
) {
    val selected = remember { mutableStateMapOf<String, Boolean>() }
    val chosen = proposed.filter { selected[it.id] == true }.map { it.id }

    Scaffold(
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.backlog_triage_title)) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.back))
                    }
                },
                actions = {
                    TextButton(
                        onClick = {
                            val all = proposed.all { selected[it.id] == true }
                            proposed.forEach { selected[it.id] = !all }
                        },
                    ) { Text(stringResource(R.string.backlog_triage_select_all)) }
                },
            )
        },
        bottomBar = {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(16.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                OutlinedButton(
                    onClick = { onBulk(chosen, "hold") },
                    enabled = chosen.isNotEmpty() && !busy,
                    modifier = Modifier.weight(1f),
                ) { Text(stringResource(R.string.backlog_triage_hold_n, chosen.size)) }
                OutlinedButton(
                    onClick = { onBulk(chosen, "reject") },
                    enabled = chosen.isNotEmpty() && !busy,
                    modifier = Modifier.weight(1f),
                ) { Text(stringResource(R.string.backlog_triage_reject_n, chosen.size), color = PsColor.danger) }
            }
        },
    ) { inner ->
        LazyColumn(modifier = Modifier.fillMaxSize().padding(inner)) {
            items(proposed, key = { it.id }) { brief ->
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable { selected[brief.id] = !(selected[brief.id] ?: false) }
                        .padding(horizontal = 12.dp, vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Checkbox(
                        checked = selected[brief.id] ?: false,
                        onCheckedChange = { selected[brief.id] = it },
                    )
                    Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                        Text(
                            brief.title,
                            style = MaterialTheme.typography.bodyMedium,
                            fontWeight = FontWeight.Medium,
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                        )
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text(
                                stringResource(R.string.backlog_meta_impact, brief.impact),
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            Text(
                                stringResource(R.string.backlog_meta_effort, brief.effort),
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            brief.lens?.takeIf { it != "default" && it.isNotEmpty() }?.let { LensChip(it) }
                        }
                    }
                    Pill(String.format("%.1f", brief.score), PsColor.pro)
                }
                HorizontalDivider(color = PsColor.outline.copy(alpha = 0.4f))
            }
        }
    }
}
