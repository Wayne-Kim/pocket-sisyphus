package com.pocketsisyphus.android.ui.backlog

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
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
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.pocketsisyphus.android.R
import com.pocketsisyphus.android.data.Ps
import com.pocketsisyphus.android.data.model.AgentKind
import com.pocketsisyphus.android.data.model.DecideReason
import com.pocketsisyphus.android.data.model.PoBrief
import com.pocketsisyphus.android.data.model.PoEvidence
import com.pocketsisyphus.android.data.model.PoResearch
import com.pocketsisyphus.android.data.model.VersionInfo
import com.pocketsisyphus.android.ui.components.MarkdownText
import com.pocketsisyphus.android.ui.theme.PsColor

/**
 * One brief, in full — mirrors iOS BriefDetailView. Title «브리프», a `수정 지시` (revise) action
 * top-right. Problem / scope / spec / evidence. For a still-proposed brief: optional decide-reason
 * tags + a `기각 · 보류 · 승인` button row (approve spawns the implementation session and deep-links
 * into it). A subtle `삭제` lives at the bottom (cleanup of finished briefs).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BriefDetailScreen(
    brief: PoBrief,
    version: VersionInfo?,
    onApprove: (useWorktree: Boolean?, mode: String?, agent: String?) -> Unit,
    onHold: (reason: String?) -> Unit,
    onReject: (reason: String?, cleanup: Boolean, agent: String?) -> Unit,
    onRevise: (comment: String) -> Unit,
    onCleanup: () -> Unit,
    onDelete: () -> Unit,
    onOpenSession: (String) -> Unit,
    onBack: () -> Unit,
) {
    var confirmDelete by remember { mutableStateOf(false) }
    var reviseOpen by remember { mutableStateOf(false) }
    var reviseText by remember { mutableStateOf("") }
    var reason by remember { mutableStateOf<DecideReason?>(null) }
    var implAgent by remember { mutableStateOf(AgentKind.CLAUDE_CODE.id) }
    var showApprove by remember { mutableStateOf(false) }
    var showReject by remember { mutableStateOf(false) }
    val supportsAgent = version?.supportsPoAgent == true
    val supportsWorktree = version?.supportsPoWorktree == true
    val supportsWorkflow = version?.supportsPoWorkflow == true
    val supportsCleanup = version?.supportsPoCleanup == true
    val agentArg = { implAgent.takeIf { supportsAgent } }

    Scaffold(
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.backlog_brief_title), maxLines = 1) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.back))
                    }
                },
                actions = {
                    TextButton(onClick = { reviseOpen = true }) {
                        Text(stringResource(R.string.backlog_revise))
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
                .padding(horizontal = 16.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(brief.title, style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f))
                BriefStatusBadge(brief)
            }
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                Meta(stringResource(R.string.backlog_meta_impact, brief.impact))
                Meta(stringResource(R.string.backlog_meta_effort, brief.effort))
                brief.lens?.takeIf { it != "default" && it.isNotEmpty() }?.let { LensChip(it) }
            }

            Field(stringResource(R.string.backlog_detail_problem), brief.problem)
            Field(stringResource(R.string.backlog_detail_scope), brief.scope)
            Field(stringResource(R.string.backlog_detail_spec), brief.spec)

            if (brief.evidence.isNotEmpty()) {
                Text(
                    stringResource(R.string.backlog_detail_evidence, brief.evidence.size),
                    style = MaterialTheme.typography.labelLarge,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                brief.evidence.forEach { EvidenceRow(it) }
            }

            // Which agent actually ran (po_agent_echo) — implementation / cleanup.
            if (brief.execAgentId != null || brief.cleanupAgentId != null) {
                FieldLabel(stringResource(R.string.backlog_agent))
                brief.execAgentId?.let { AgentRanRow(stringResource(R.string.backlog_detail_agent_impl), it) }
                brief.cleanupAgentId?.let { AgentRanRow(stringResource(R.string.backlog_detail_agent_cleanup), it) }
            }

            // Decision reason (rejected / held) — the tag + free note I left when deciding.
            if ((brief.status == "rejected" || brief.status == "held") && !brief.decideReason.isNullOrEmpty()) {
                FieldLabel(stringResource(R.string.backlog_detail_decide_reason))
                DecideReason.entries.firstOrNull { it.key == brief.decideReason }?.let {
                    Text(stringResource(reasonLabelRes(it)), style = MaterialTheme.typography.bodyMedium)
                }
                brief.decideNote?.takeIf { it.isNotBlank() }?.let {
                    Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }

            // Post-ship verification (verified / missed) — the hypothesis-check verdict note.
            if ((brief.status == "verified" || brief.status == "missed") && !brief.verifyNote.isNullOrBlank()) {
                FieldLabel(stringResource(R.string.backlog_detail_verify))
                Text(brief.verifyNote!!, style = MaterialTheme.typography.bodyMedium)
            }

            // Code-traces cleanup (rejected, po_cleanup_v1) — open an existing cleanup session or start one.
            if (supportsCleanup && brief.status == "rejected") {
                FieldLabel(stringResource(R.string.backlog_cleanup_section))
                brief.cleanupSessionId?.takeIf { it.isNotBlank() }?.let { sid ->
                    OutlinedButton(onClick = { onOpenSession(sid) }, modifier = Modifier.fillMaxWidth()) {
                        Text(stringResource(R.string.backlog_cleanup_open))
                    }
                }
                OutlinedButton(onClick = onCleanup, modifier = Modifier.fillMaxWidth()) {
                    Text(stringResource(R.string.backlog_cleanup_start))
                }
            }

            brief.execSessionId?.takeIf { it.isNotBlank() }?.let { sid ->
                OutlinedButton(onClick = { onOpenSession(sid) }, modifier = Modifier.fillMaxWidth()) {
                    Text(stringResource(R.string.backlog_open_session))
                }
            }

            if (brief.isProposed) {
                // Implementation agent (po_agent_v1) — which code agent runs the approved work.
                if (supportsAgent) {
                    Text(
                        stringResource(R.string.backlog_agent),
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Row(
                        modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        listOf(AgentKind.CLAUDE_CODE, AgentKind.CODEX, AgentKind.COPILOT).forEach { a ->
                            FilterChip(
                                selected = implAgent == a.id,
                                onClick = { implAgent = a.id },
                                label = { Text(a.label) },
                            )
                        }
                    }
                }
                // Optional reason tags — shared by reject/hold, single-select toggle (po_decide_reason).
                Text(
                    stringResource(R.string.backlog_reason_label),
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Row(
                    modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    DecideReason.entries.forEach { r ->
                        FilterChip(
                            selected = reason == r,
                            onClick = { reason = if (reason == r) null else r },
                            label = { Text(stringResource(reasonLabelRes(r))) },
                        )
                    }
                }
                // 기각 · 보류 · 승인 — iOS order. Approve is the filled accent action.
                // Approve opens a worktree/workflow option dialog; reject offers a cleanup option.
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    OutlinedButton(
                        onClick = {
                            if (supportsCleanup) showReject = true
                            else onReject(reason?.key, false, null)
                        },
                        modifier = Modifier.weight(1f),
                        colors = ButtonDefaults.outlinedButtonColors(contentColor = PsColor.danger),
                    ) { Text(stringResource(R.string.backlog_decide_reject)) }
                    OutlinedButton(
                        onClick = { onHold(reason?.key) },
                        modifier = Modifier.weight(1f),
                    ) { Text(stringResource(R.string.backlog_decide_hold)) }
                    Button(
                        onClick = {
                            if (supportsWorktree || supportsWorkflow) showApprove = true
                            else onApprove(null, null, agentArg())
                        },
                        modifier = Modifier.weight(1f),
                        colors = ButtonDefaults.buttonColors(containerColor = PsColor.accent),
                    ) { Text(stringResource(R.string.backlog_decide_approve_short)) }
                }
            }

            Spacer(Modifier.height(4.dp))
            TextButton(onClick = { confirmDelete = true }) {
                Text(stringResource(R.string.delete), color = PsColor.danger)
            }
        }
    }

    if (reviseOpen) {
        AlertDialog(
            onDismissRequest = { reviseOpen = false },
            title = { Text(stringResource(R.string.backlog_revise)) },
            text = {
                OutlinedTextField(
                    value = reviseText,
                    onValueChange = { reviseText = it },
                    placeholder = { Text(stringResource(R.string.backlog_revise_hint)) },
                    minLines = 2,
                    modifier = Modifier.fillMaxWidth(),
                )
            },
            confirmButton = {
                TextButton(
                    onClick = { reviseOpen = false; onRevise(reviseText) },
                    enabled = reviseText.isNotBlank(),
                ) { Text(stringResource(R.string.backlog_revise_submit)) }
            },
            dismissButton = {
                TextButton(onClick = { reviseOpen = false }) { Text(stringResource(R.string.cancel)) }
            },
        )
    }

    // Approve options — worktree / current repo / workflow (po_worktree_v1 / po_workflow_v1).
    if (showApprove) {
        AlertDialog(
            onDismissRequest = { showApprove = false },
            title = { Text(stringResource(R.string.backlog_decide_approve_short)) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (supportsWorktree) {
                        Button(
                            onClick = { showApprove = false; onApprove(true, null, agentArg()) },
                            modifier = Modifier.fillMaxWidth(),
                            colors = ButtonDefaults.buttonColors(containerColor = PsColor.accent),
                        ) { Text(stringResource(R.string.backlog_approve_worktree)) }
                        OutlinedButton(
                            onClick = { showApprove = false; onApprove(false, null, agentArg()) },
                            modifier = Modifier.fillMaxWidth(),
                        ) { Text(stringResource(R.string.backlog_approve_current)) }
                    } else {
                        Button(
                            onClick = { showApprove = false; onApprove(null, null, agentArg()) },
                            modifier = Modifier.fillMaxWidth(),
                            colors = ButtonDefaults.buttonColors(containerColor = PsColor.accent),
                        ) { Text(stringResource(R.string.backlog_approve_plain)) }
                    }
                    if (supportsWorkflow) {
                        OutlinedButton(
                            onClick = { showApprove = false; onApprove(null, "workflow", agentArg()) },
                            modifier = Modifier.fillMaxWidth(),
                        ) { Text(stringResource(R.string.backlog_approve_workflow)) }
                    }
                }
            },
            confirmButton = {
                TextButton(onClick = { showApprove = false }) { Text(stringResource(R.string.cancel)) }
            },
        )
    }

    // Reject options — reject only, or reject + clean up code traces (po_cleanup_v1).
    if (showReject) {
        AlertDialog(
            onDismissRequest = { showReject = false },
            title = { Text(stringResource(R.string.backlog_decide_reject)) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(
                        onClick = { showReject = false; onReject(reason?.key, true, agentArg()) },
                        modifier = Modifier.fillMaxWidth(),
                        colors = ButtonDefaults.outlinedButtonColors(contentColor = PsColor.danger),
                    ) { Text(stringResource(R.string.backlog_reject_cleanup)) }
                    OutlinedButton(
                        onClick = { showReject = false; onReject(reason?.key, false, null) },
                        modifier = Modifier.fillMaxWidth(),
                        colors = ButtonDefaults.outlinedButtonColors(contentColor = PsColor.danger),
                    ) { Text(stringResource(R.string.backlog_reject_only)) }
                }
            },
            confirmButton = {
                TextButton(onClick = { showReject = false }) { Text(stringResource(R.string.cancel)) }
            },
        )
    }

    if (confirmDelete) {
        AlertDialog(
            onDismissRequest = { confirmDelete = false },
            title = { Text(stringResource(R.string.backlog_delete_title)) },
            text = { Text(stringResource(R.string.backlog_delete_message)) },
            confirmButton = {
                TextButton(onClick = { confirmDelete = false; onDelete() }) {
                    Text(stringResource(R.string.delete), color = PsColor.danger)
                }
            },
            dismissButton = {
                TextButton(onClick = { confirmDelete = false }) { Text(stringResource(R.string.cancel)) }
            },
        )
    }
}

@Composable
private fun Field(label: String, value: String) {
    if (value.isBlank()) return
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(label, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
        // Agent-generated markdown is user data (not translated) — rendered with formatting.
        MarkdownText(value)
    }
}

@Composable
private fun EvidenceRow(e: PoEvidence) {
    Column(
        modifier = Modifier.fillMaxWidth().padding(vertical = 2.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        if (e.summary.isNotBlank()) Text(e.summary, style = MaterialTheme.typography.bodySmall)
        if (e.ref.isNotBlank()) {
            Text(
                e.ref,
                style = MaterialTheme.typography.labelSmall.copy(fontFamily = FontFamily.Monospace),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun Meta(text: String) {
    Text(text, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

@Composable
private fun FieldLabel(text: String) {
    Text(text, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

/** «구현 / 정리» row showing which agent actually ran (po_agent_echo). */
@Composable
private fun AgentRanRow(label: String, agentId: String) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(label, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
        Text(
            AgentKind.label(agentId),
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

/** Research report — fetches the report markdown by id (the list response omits the body). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ResearchReportScreen(research: PoResearch, onBack: () -> Unit) {
    var loaded by remember { mutableStateOf(research.report) }
    var error by remember { mutableStateOf<String?>(null) }

    androidx.compose.runtime.LaunchedEffect(research.id) {
        if (loaded.isNullOrBlank()) {
            try {
                loaded = Ps.api.getPoResearch(research.id).research.report
            } catch (e: Throwable) {
                error = e.message
            }
        }
    }

    Scaffold(
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.backlog_research_report), maxLines = 1) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.back))
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
                .padding(horizontal = 16.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(research.topic, style = MaterialTheme.typography.titleMedium)
            research.lens?.takeIf { it != "default" }?.let { LensChip(it) }
            val body = loaded
            when {
                body != null -> MarkdownText(body)
                error != null -> Text(error!!, color = PsColor.danger, style = MaterialTheme.typography.bodySmall)
                else -> Box(Modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator()
                }
            }
        }
    }
}
