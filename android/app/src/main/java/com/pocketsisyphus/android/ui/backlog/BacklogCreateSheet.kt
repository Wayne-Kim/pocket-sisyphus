package com.pocketsisyphus.android.ui.backlog

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.pocketsisyphus.android.R
import com.pocketsisyphus.android.data.model.PoLens
import com.pocketsisyphus.android.data.model.VersionInfo
import androidx.compose.ui.res.stringResource

private enum class Source { COLLECT, RESEARCH }

/**
 * The «만들기» (create) flow — the headline AI-persona feature. Pick a repo, choose where to look
 * for opportunities (내 레포 안 collect / 시장 조사 research), and pick the **expert lens (persona)**
 * the agent investigates through. The lens picker only offers lenses the daemon advertises (sending
 * an unknown lens would silently fall back to "default"). Submitting starts a watch session.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BacklogCreateSheet(
    version: VersionInfo,
    recentRepos: List<String>,
    starting: Boolean,
    onDismiss: () -> Unit,
    onStartCollect: (repoPath: String, instruction: String?, lens: String?, agent: String?) -> Unit,
    onStartResearch: (repoPath: String, topic: String, lens: String?, scope: String?, screens: Boolean?, agent: String?) -> Unit,
    onOpenSchedule: ((repoPath: String) -> Unit)? = null,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    var repoPath by remember { mutableStateOf(recentRepos.firstOrNull() ?: "") }
    var source by remember { mutableStateOf(Source.COLLECT) }
    var collectLens by remember { mutableStateOf(PoLens.DEFAULT) }
    var researchLens by remember { mutableStateOf(PoLens.DEFAULT) }
    var instruction by remember { mutableStateOf("") }
    var topic by remember { mutableStateOf("") }
    var scope by remember { mutableStateOf("web_repo") }
    var includeScreens by remember { mutableStateOf(true) }
    var agent by remember { mutableStateOf(com.pocketsisyphus.android.data.model.AgentKind.CLAUDE_CODE.id) }

    // Code agents the PO flow can run on (po_agent_v1) — mirrors iOS's cron-eligible set.
    val poAgents = remember {
        listOf(
            com.pocketsisyphus.android.data.model.AgentKind.CLAUDE_CODE,
            com.pocketsisyphus.android.data.model.AgentKind.CODEX,
            com.pocketsisyphus.android.data.model.AgentKind.COPILOT,
        )
    }

    val collectLenses = remember(version) {
        PoLens.collectLenses(
            security = version.supportsCollectSecurityLens,
            allExperts = version.supportsCollectAllExpertsLens,
        )
    }
    val researchLenses = remember(version) {
        PoLens.researchLenses(
            qa = version.supportsResearchQaLens,
            security = version.supportsResearchSecurityLens,
            pm = version.supportsResearchPmLens,
            marketing = version.supportsResearchMarketingLens,
            analytics = version.supportsResearchAnalyticsLens,
            ops = version.supportsResearchOpsLens,
            logic = version.supportsResearchLogicLens,
            ux = version.supportsResearchUxLens,
            readability = version.supportsResearchReadabilityLens,
        )
    }

    val showCollectLens = version.supportsCollectLens && collectLenses.size > 1
    val showResearchLens = version.supportsResearchLens && researchLenses.size > 1

    val canSubmit = repoPath.isNotBlank() &&
        (source == Source.COLLECT || topic.isNotBlank()) && !starting

    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheetState) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 20.dp)
                .padding(bottom = 32.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Text(stringResource(R.string.backlog_create_title), style = MaterialTheme.typography.titleLarge)

            // ── Repository ─────────────────────────────────────────────────────
            Text(stringResource(R.string.backlog_create_repo), style = MaterialTheme.typography.labelLarge)
            if (recentRepos.isNotEmpty()) {
                Row(
                    modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    recentRepos.forEach { path ->
                        FilterChip(
                            selected = repoPath == path,
                            onClick = { repoPath = path },
                            label = { Text(path.trimEnd('/').substringAfterLast('/')) },
                        )
                    }
                }
            }
            OutlinedTextField(
                value = repoPath,
                onValueChange = { repoPath = it },
                label = { Text(stringResource(R.string.backlog_create_repo_path)) },
                singleLine = true,
                textStyle = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
                modifier = Modifier.fillMaxWidth(),
            )

            // ── Where to look ──────────────────────────────────────────────────
            Text(stringResource(R.string.backlog_create_source), style = MaterialTheme.typography.labelLarge)
            SingleChoiceSegmentedButtonRow(modifier = Modifier.fillMaxWidth()) {
                SegmentedButton(
                    selected = source == Source.COLLECT,
                    onClick = { source = Source.COLLECT },
                    shape = SegmentedButtonDefaults.itemShape(0, 2),
                ) { Text(stringResource(R.string.backlog_source_collect)) }
                SegmentedButton(
                    selected = source == Source.RESEARCH,
                    onClick = { source = Source.RESEARCH },
                    shape = SegmentedButtonDefaults.itemShape(1, 2),
                ) { Text(stringResource(R.string.backlog_source_research)) }
            }
            Text(
                stringResource(
                    if (source == Source.COLLECT) R.string.backlog_source_collect_hint
                    else R.string.backlog_source_research_hint,
                ),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            // ── Expert lens (persona) ──────────────────────────────────────────
            val lenses = if (source == Source.COLLECT) collectLenses else researchLenses
            val showLens = if (source == Source.COLLECT) showCollectLens else showResearchLens
            if (showLens) {
                Text(stringResource(R.string.backlog_lens), style = MaterialTheme.typography.labelLarge)
                Row(
                    modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    lenses.forEach { id ->
                        val selected = if (source == Source.COLLECT) collectLens == id else researchLens == id
                        FilterChip(
                            selected = selected,
                            onClick = {
                                if (source == Source.COLLECT) collectLens = id else researchLens = id
                            },
                            label = { Text(stringResource(lensNameRes(id))) },
                        )
                    }
                }
                Text(
                    stringResource(R.string.backlog_lens_hint),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            // ── Collect: optional one-time instruction ─────────────────────────
            if (source == Source.COLLECT) {
                OutlinedTextField(
                    value = instruction,
                    onValueChange = { instruction = it },
                    label = { Text(stringResource(R.string.backlog_collect_instruction)) },
                    placeholder = { Text(stringResource(R.string.backlog_collect_instruction_hint)) },
                    minLines = 2,
                    modifier = Modifier.fillMaxWidth(),
                )
                // Daily unattended collection (po_schedule_v1) — opens the per-repo schedule screen.
                if (onOpenSchedule != null) {
                    androidx.compose.material3.TextButton(
                        onClick = { if (repoPath.isNotBlank()) onOpenSchedule(repoPath.trim()) },
                        enabled = repoPath.isNotBlank(),
                    ) { Text(stringResource(R.string.backlog_schedule_open)) }
                }
            } else {
                // ── Research: required topic + scope + UX screens ──────────────
                OutlinedTextField(
                    value = topic,
                    onValueChange = { topic = it },
                    label = { Text(stringResource(R.string.backlog_research_topic)) },
                    placeholder = { Text(stringResource(R.string.backlog_research_topic_hint)) },
                    minLines = 2,
                    modifier = Modifier.fillMaxWidth(),
                )
                if (version.supportsResearchScope) {
                    Text(stringResource(R.string.backlog_research_scope), style = MaterialTheme.typography.labelLarge)
                    SingleChoiceSegmentedButtonRow(modifier = Modifier.fillMaxWidth()) {
                        SegmentedButton(
                            selected = scope == "web_repo",
                            onClick = { scope = "web_repo" },
                            shape = SegmentedButtonDefaults.itemShape(0, 2),
                        ) { Text(stringResource(R.string.backlog_scope_web_repo)) }
                        SegmentedButton(
                            selected = scope == "repo_only",
                            onClick = { scope = "repo_only" },
                            shape = SegmentedButtonDefaults.itemShape(1, 2),
                        ) { Text(stringResource(R.string.backlog_scope_repo_only)) }
                    }
                }
                if (version.supportsResearchUxScreens && researchLens == "ux") {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(stringResource(R.string.backlog_include_screens), modifier = Modifier.weight(1f))
                        Switch(checked = includeScreens, onCheckedChange = { includeScreens = it })
                    }
                }
            }

            // Agent picker (po_agent_v1) — which code agent runs the collect/research.
            if (version.supportsPoAgent) {
                Text(stringResource(R.string.backlog_agent), style = MaterialTheme.typography.labelLarge)
                Row(
                    modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    poAgents.forEach { a ->
                        FilterChip(
                            selected = agent == a.id,
                            onClick = { agent = a.id },
                            label = { Text(a.label) },
                        )
                    }
                }
            }

            Button(
                onClick = {
                    val repo = repoPath.trim()
                    val chosenAgent = agent.takeIf { version.supportsPoAgent }
                    if (source == Source.COLLECT) {
                        val lens = collectLens.takeIf { showCollectLens && it != PoLens.DEFAULT }
                        onStartCollect(repo, instruction.trim().ifBlank { null }, lens, chosenAgent)
                    } else {
                        val lens = researchLens.takeIf { showResearchLens && it != PoLens.DEFAULT }
                        val chosenScope = if (version.supportsResearchScope && scope == "repo_only") "repo_only" else null
                        val chosenScreens =
                            if (version.supportsResearchUxScreens && researchLens == "ux" && includeScreens) true else null
                        onStartResearch(repo, topic.trim(), lens, chosenScope, chosenScreens, chosenAgent)
                    }
                },
                enabled = canSubmit,
                modifier = Modifier.fillMaxWidth(),
            ) {
                if (starting) {
                    CircularProgressIndicator(
                        modifier = Modifier.padding(end = 8.dp),
                        strokeWidth = 2.dp,
                        color = MaterialTheme.colorScheme.onPrimary,
                    )
                }
                Text(
                    stringResource(
                        if (source == Source.COLLECT) R.string.backlog_start_collect
                        else R.string.backlog_start_research,
                    ),
                )
            }
        }
    }
}
