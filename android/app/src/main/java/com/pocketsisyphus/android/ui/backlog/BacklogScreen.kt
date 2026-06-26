package com.pocketsisyphus.android.ui.backlog

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowForward
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.pocketsisyphus.android.R
import com.pocketsisyphus.android.data.model.PoBrief
import com.pocketsisyphus.android.data.model.PoResearch
import com.pocketsisyphus.android.data.model.VersionInfo
import com.pocketsisyphus.android.ui.components.Pill
import com.pocketsisyphus.android.ui.theme.PsColor

/**
 * Backlog (PO loop) home — review AI-generated opportunity «briefs» and approve / hold / reject them.
 * The headline is the create flow: pick a repo, choose collect vs research, and pick the **expert
 * lens (persona)** the agent investigates through. Gating mirrors the Automation tab:
 *  1. version unknown → loading.
 *  2. daemon lacks `po_loop_v1` (old Mac) → «update the Mac app».
 *  3. Pro not unlocked → locked → paywall (free now: Entitlement.iapEnabled=false unlocks it).
 *  4. otherwise the briefs + research list, with a create FAB.
 *
 * Brief detail / research report / create are sub-navigated *within* this tab so the ViewModel stays
 * alive (decisions reflect immediately) and back returns here, not to the Sessions tab.
 */
@Composable
fun BacklogScreen(
    version: VersionInfo?,
    isProUnlocked: Boolean,
    onOpenPaywall: () -> Unit,
    onOpenSession: (String) -> Unit,
    onOpenSettings: () -> Unit,
    modifier: Modifier = Modifier,
    vm: BacklogViewModel = viewModel(),
) {
    if (version == null) {
        Center(modifier) { CircularProgressIndicator() }
        return
    }
    if (!version.supportsBacklog) {
        UpdateMacBranch(modifier)
        return
    }
    if (!isProUnlocked) {
        LockedState(modifier, onOpenPaywall)
        return
    }

    val state by vm.state.collectAsStateWithLifecycle()
    var detail by remember { mutableStateOf<PoBrief?>(null) }
    var report by remember { mutableStateOf<PoResearch?>(null) }
    var showCreate by remember { mutableStateOf(false) }
    var showTriage by remember { mutableStateOf(false) }
    var showStats by remember { mutableStateOf(false) }
    var scheduleRepo by remember { mutableStateOf<String?>(null) }

    // Confine the sub-screens (detail/triage/report/schedule) to the tab content area so their own
    // Scaffold chrome (e.g. triage's Hold/Reject bar) sits above the main bottom-nav, not under it.
    Box(modifier = modifier) {
    when {
        detail != null -> {
            val brief = detail!!
            BackHandler { detail = null }
            BriefDetailScreen(
                brief = brief,
                version = version,
                onApprove = { useWorktree, mode, agent ->
                    detail = null
                    vm.decide(brief.id, "approve", useWorktree = useWorktree, mode = mode, agent = agent) { sid ->
                        onOpenSession(sid)
                    }
                },
                onHold = { reason -> detail = null; vm.decide(brief.id, "hold", reason = reason) },
                onReject = { reason, cleanup, agent ->
                    detail = null
                    if (cleanup) vm.rejectAndCleanup(brief.id, reason, agent)
                    else vm.decide(brief.id, "reject", reason = reason)
                },
                onRevise = { comment -> detail = null; vm.revise(brief.id, comment) },
                onCleanup = { detail = null; vm.cleanup(brief.id, null) { sid -> onOpenSession(sid) } },
                onDelete = { detail = null; vm.deleteBrief(brief.id) },
                onOpenSession = { sid -> detail = null; onOpenSession(sid) },
                onBack = { detail = null },
            )
        }

        report != null -> {
            val r = report!!
            BackHandler { report = null }
            ResearchReportScreen(research = r, onBack = { report = null })
        }

        showTriage -> {
            BackHandler { showTriage = false }
            TriageScreen(
                proposed = state.proposed,
                busy = state.triageBusy,
                onBulk = { ids, action -> vm.bulkDecide(ids, action) { showTriage = false } },
                onBack = { showTriage = false },
            )
        }

        scheduleRepo != null -> {
            val repo = scheduleRepo!!
            BackHandler { scheduleRepo = null }
            CollectScheduleScreen(repoPath = repo, version = version, onBack = { scheduleRepo = null })
        }

        else -> {
            BacklogList(
                state = state,
                modifier = Modifier.fillMaxSize(),
                onCreate = { showCreate = true },
                onOpenSettings = onOpenSettings,
                onOpenBrief = { detail = it },
                onOpenResearch = { report = it },
                onOpenSession = onOpenSession,
                onClearStarted = vm::clearStarted,
                canTriage = version.supportsPoBulkDecide,
                onOpenTriage = { showTriage = true },
                showStatsCard = version.supportsPoStats,
                onOpenStats = { showStats = true },
            )
            if (showCreate) {
                BacklogCreateSheet(
                    version = version,
                    recentRepos = state.recentRepos,
                    starting = state.starting,
                    onDismiss = { showCreate = false },
                    onStartCollect = { repo, instruction, lens, agent ->
                        showCreate = false
                        vm.startCollect(repo, instruction, lens, agent)
                    },
                    onStartResearch = { repo, topic, lens, scope, screens, agent ->
                        showCreate = false
                        vm.startResearch(repo, topic, lens, scope, screens, agent)
                    },
                    onOpenSchedule = if (version.supportsPoSchedule) {
                        { repo -> showCreate = false; scheduleRepo = repo }
                    } else {
                        null
                    },
                )
            }
            if (showStats) {
                state.stats?.let { BacklogStatsSheet(it, onDismiss = { showStats = false }) }
            }
        }
    }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun BacklogList(
    state: BacklogViewModel.UiState,
    modifier: Modifier,
    onCreate: () -> Unit,
    onOpenSettings: () -> Unit,
    onOpenBrief: (PoBrief) -> Unit,
    onOpenResearch: (PoResearch) -> Unit,
    onOpenSession: (String) -> Unit,
    onClearStarted: () -> Unit,
    canTriage: Boolean,
    onOpenTriage: () -> Unit,
    showStatsCard: Boolean,
    onOpenStats: () -> Unit,
) {
    // iOS: NavigationStack with «설정» gear top-left, «백로그» title, «만들기» (Create) top-right.
    Scaffold(
        modifier = modifier,
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        topBar = {
            TopAppBar(
                navigationIcon = {
                    IconButton(onClick = onOpenSettings) {
                        Icon(Icons.Filled.Settings, contentDescription = stringResource(R.string.settings_title))
                    }
                },
                title = { Text(stringResource(R.string.tab_backlog)) },
                actions = {
                    TextButton(onClick = onCreate) { Text(stringResource(R.string.backlog_create)) }
                },
            )
        },
    ) { inner ->
        when {
            state.loading && state.isEmpty ->
                Box(Modifier.fillMaxSize().padding(inner), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator()
                }
            state.error != null && state.isEmpty ->
                Box(Modifier.fillMaxSize().padding(inner), contentAlignment = Alignment.Center) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally) {
                        Text(stringResource(R.string.backlog_load_failed), color = PsColor.danger)
                        Text(
                            state.error,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            textAlign = TextAlign.Center,
                        )
                    }
                }
            else -> LazyColumn(
                contentPadding = PaddingValues(top = 4.dp, bottom = 24.dp),
                modifier = Modifier.fillMaxSize().padding(inner),
            ) {
                state.startedSessionId?.let { sid ->
                    item("started") {
                        StartedBanner(
                            messageRes = state.startedMessageRes ?: R.string.backlog_collect_started,
                            onOpen = { onClearStarted(); onOpenSession(sid) },
                        )
                        HorizontalDivider(color = PsColor.outline.copy(alpha = 0.4f))
                    }
                }

                // 성적표 (scorecard) — always shown when the daemon supports it (iOS shows it even
                // when there's not enough data yet); the row itself renders the «부족해요» placeholder.
                if (showStatsCard) {
                    state.stats?.let { stats ->
                        item("stats") {
                            StatsSummaryRow(stats, onClick = onOpenStats)
                            HorizontalDivider(color = PsColor.outline.copy(alpha = 0.4f))
                        }
                    }
                }

                if (state.isEmpty) {
                    item("empty") { EmptyHint() }
                }

                // Proposed section carries the triage entry point in its header.
                if (state.proposed.isNotEmpty()) {
                    item("h-proposed") {
                        SectionHeaderRow(
                            title = stringResource(R.string.backlog_section_proposed),
                            actionLabel = if (canTriage && state.proposed.size > 1)
                                stringResource(R.string.backlog_triage) else null,
                            onAction = onOpenTriage,
                        )
                    }
                    items(state.proposed, key = { it.id }) { brief ->
                        BriefRowItem(brief, onClick = { onOpenBrief(brief) })
                        HorizontalDivider(color = PsColor.outline.copy(alpha = 0.4f))
                    }
                }
                section(R.string.backlog_section_active, state.active, onOpenBrief)
                section(R.string.backlog_section_shipped, state.shipped, onOpenBrief)
                section(R.string.backlog_section_settled, state.settled, onOpenBrief)

                if (state.research.isNotEmpty()) {
                    item("research-h") { SectionHeader(stringResource(R.string.backlog_section_research)) }
                    items(state.research, key = { "r-${it.id}" }) { r ->
                        ResearchRowItem(r, onClick = { onOpenResearch(r) })
                        HorizontalDivider(color = PsColor.outline.copy(alpha = 0.4f))
                    }
                }
            }
        }
    }
}

private fun androidx.compose.foundation.lazy.LazyListScope.section(
    titleRes: Int,
    briefs: List<PoBrief>,
    onOpenBrief: (PoBrief) -> Unit,
) {
    if (briefs.isEmpty()) return
    item("h-$titleRes") { SectionHeader(stringResource(titleRes)) }
    items(briefs, key = { it.id }) { brief ->
        BriefRowItem(brief, onClick = { onOpenBrief(brief) })
        HorizontalDivider(color = PsColor.outline.copy(alpha = 0.4f))
    }
}

@Composable
private fun SectionHeader(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.labelMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
    )
}

/** Section header with an optional trailing action (e.g. «Triage» on the proposed section). */
@Composable
private fun SectionHeaderRow(title: String, actionLabel: String?, onAction: () -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            title,
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.weight(1f),
        )
        if (actionLabel != null) {
            androidx.compose.material3.TextButton(onClick = onAction) {
                Text(actionLabel, color = PsColor.accent)
            }
        }
    }
}

@Composable
private fun BriefRowItem(brief: PoBrief, onClick: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(
                brief.title,
                style = MaterialTheme.typography.titleSmall,
                modifier = Modifier.weight(1f),
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            BriefStatusBadge(brief)
        }
        brief.glanceLine?.let {
            Text(
                it,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Row(
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            MetaText(stringResource(R.string.backlog_meta_impact, brief.impact))
            MetaText(stringResource(R.string.backlog_meta_effort, brief.effort))
            MetaText(stringResource(R.string.backlog_meta_evidence, brief.evidence.size))
            brief.lens?.takeIf { it != "default" && it.isNotEmpty() }?.let { LensChip(it) }
        }
    }
}

@Composable
private fun MetaText(text: String) {
    Text(text, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

@Composable
fun BriefStatusBadge(brief: PoBrief) {
    if (brief.revisingSessionId != null) {
        Pill(stringResource(R.string.backlog_status_revising), PsColor.accent)
        return
    }
    when (brief.status) {
        "running", "approved" -> Pill(stringResource(R.string.backlog_status_running), PsColor.success)
        "held" -> Pill(stringResource(R.string.backlog_status_held), PsColor.onBgMuted)
        "rejected" -> Pill(stringResource(R.string.backlog_status_rejected), PsColor.danger)
        "shipped" -> Pill(stringResource(R.string.backlog_status_shipped), PsColor.info)
        "verified" -> Pill(stringResource(R.string.backlog_status_verified), PsColor.success)
        "missed" -> Pill(stringResource(R.string.backlog_status_missed), PsColor.danger)
        else -> Pill(String.format("%.1f", brief.score), PsColor.pro)
    }
}

@Composable
private fun ResearchRowItem(research: PoResearch, onClick: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(
                research.topic,
                style = MaterialTheme.typography.titleSmall,
                modifier = Modifier.weight(1f),
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            when (research.status) {
                "running" -> Pill(stringResource(R.string.backlog_research_running), PsColor.pro)
                "failed" -> Pill(stringResource(R.string.backlog_research_failed), PsColor.danger)
                else -> Pill(stringResource(R.string.backlog_research_done), PsColor.success)
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            MetaText(stringResource(R.string.backlog_meta_briefs, research.briefCount))
            research.lens?.takeIf { it != "default" }?.let { LensChip(it) }
        }
    }
}

@Composable
private fun StartedBanner(messageRes: Int, onOpen: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onOpen)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
        Text(stringResource(messageRes), style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
        Icon(Icons.AutoMirrored.Filled.ArrowForward, contentDescription = null, tint = PsColor.accent)
    }
}

@Composable
private fun EmptyHint() {
    Column(
        modifier = Modifier.fillMaxWidth().padding(32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            stringResource(R.string.backlog_empty_title),
            style = MaterialTheme.typography.titleMedium,
            textAlign = TextAlign.Center,
        )
        Text(
            stringResource(R.string.backlog_empty_body),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )
    }
}

@Composable
private fun UpdateMacBranch(modifier: Modifier = Modifier) {
    Center(modifier) {
        Icon(Icons.Filled.Lock, contentDescription = null, tint = PsColor.warning, modifier = Modifier.size(44.dp))
        Text(
            stringResource(R.string.backlog_update_mac_title),
            style = MaterialTheme.typography.titleMedium,
            textAlign = TextAlign.Center,
        )
        Text(
            stringResource(R.string.backlog_update_mac_body),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )
    }
}

@Composable
private fun LockedState(modifier: Modifier = Modifier, onOpenPaywall: () -> Unit) {
    Center(modifier) {
        Icon(Icons.Filled.Lock, contentDescription = null, tint = PsColor.pro, modifier = Modifier.size(44.dp))
        Text(
            stringResource(R.string.backlog_locked_title),
            style = MaterialTheme.typography.titleMedium,
            color = PsColor.pro,
            fontWeight = FontWeight.SemiBold,
            textAlign = TextAlign.Center,
        )
        Text(
            stringResource(R.string.backlog_locked_body),
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
private fun Center(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    Box(modifier = modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(12.dp),
            modifier = Modifier.padding(32.dp),
        ) { content() }
    }
}
