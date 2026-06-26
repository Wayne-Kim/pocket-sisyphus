package com.pocketsisyphus.android.ui.sessions

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.pocketsisyphus.android.R
import com.pocketsisyphus.android.data.model.AgentKind
import com.pocketsisyphus.android.data.model.SessionRow
import com.pocketsisyphus.android.ui.components.Pill
import com.pocketsisyphus.android.ui.theme.PsColor

/**
 * Approval-inbox bottom sheet — mirrors the iOS `ApprovalReviewSheet`.
 *
 * Lists every session currently waiting for approval with its name, repo, and pending preview, and
 * lets the user approve or reject each without opening its terminal — individually or via the
 * «Approve selected» / «Approve all» batch actions. Empty / processing / failed states are handled
 * here. Colors are semantic tokens only: approve = success (green), reject = danger (red), selection
 * check = accent (purple); body text uses the auto-adapting color scheme (no hardcoded white/black).
 *
 * [liveWaiting] is the host's live waiting list — when it changes, rows that left the waiting set
 * (already handled on another device) are reconciled away with a notice.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ApprovalInboxSheet(
    initialWaiting: List<SessionRow>,
    liveWaiting: List<SessionRow>,
    onDismiss: () -> Unit,
    onFinished: () -> Unit,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val scope = rememberCoroutineScope()
    // Snapshot at open; the live list only drives reconcile (silent drop of externally-handled rows).
    val inbox = remember {
        ApprovalInbox(initial = initialWaiting, scope = scope, onFinished = onFinished)
    }
    val state by inbox.state.collectAsState()

    LaunchedEffect(liveWaiting) {
        inbox.reconcile(liveWaiting.map { it.id }.toSet())
    }
    LaunchedEffect(state.finished) {
        if (state.finished) onDismiss()
    }

    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheetState) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 20.dp)
                .padding(bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    stringResource(R.string.approvals_title),
                    style = MaterialTheme.typography.titleLarge,
                    modifier = Modifier.weight(1f),
                )
                IconButton(onClick = onDismiss) {
                    Icon(Icons.Filled.Close, contentDescription = stringResource(R.string.close))
                }
            }

            if (state.externallyResolved) {
                Text(
                    stringResource(R.string.approvals_externally_resolved),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            if (state.items.isEmpty()) {
                EmptyState()
            } else {
                Text(
                    stringResource(R.string.approvals_footer),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                LazyColumn(
                    modifier = Modifier.fillMaxWidth().heightIn(max = 420.dp),
                ) {
                    items(state.items, key = { it.id }) { item ->
                        ApprovalRow(
                            item = item,
                            onToggleSelect = { inbox.toggleSelect(item.id) },
                            onApprove = { inbox.approveOne(item.id) },
                            onReject = { inbox.reject(item.id) },
                        )
                        HorizontalDivider(color = PsColor.outline.copy(alpha = 0.4f))
                    }
                }
                Footer(state = state, inbox = inbox, onDismiss = onDismiss)
            }
        }
    }
}

@Composable
private fun EmptyState() {
    Column(
        modifier = Modifier.fillMaxWidth().padding(vertical = 32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Icon(
            Icons.Filled.CheckCircle,
            contentDescription = null,
            tint = PsColor.success,
            modifier = Modifier.size(44.dp),
        )
        Text(
            stringResource(R.string.approvals_empty),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun ApprovalRow(
    item: ApprovalInbox.Item,
    onToggleSelect: () -> Unit,
    onApprove: () -> Unit,
    onReject: () -> Unit,
) {
    val selectDesc = if (item.selected) {
        stringResource(R.string.approvals_a11y_selected)
    } else {
        stringResource(R.string.approvals_a11y_unselected)
    }
    Row(
        modifier = Modifier.fillMaxWidth().padding(vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        // Selection check — accent (purple) = the «what am I picking to approve» token.
        IconButton(
            onClick = onToggleSelect,
            enabled = item.actionable,
            modifier = Modifier.size(28.dp).semantics { contentDescription = selectDesc },
        ) {
            Icon(
                if (item.selected) Icons.Filled.CheckCircle else Icons.Outlined.CheckCircle,
                contentDescription = null,
                tint = if (item.selected && item.actionable) {
                    PsColor.accent
                } else {
                    MaterialTheme.colorScheme.onSurfaceVariant
                },
            )
        }

        Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(
                item.session.displayTitle,
                style = MaterialTheme.typography.titleMedium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                item.session.repoPath,
                style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Pill(AgentKind.label(item.session.agent), PsColor.accent)

            // Pending preview — what the agent is asking before it paused. Agent output, not a
            // translatable string, so it's shown verbatim. Omitted when blank.
            item.session.pendingPromptPreview?.trim()?.takeIf { it.isNotEmpty() }?.let { preview ->
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(6.dp))
                        .background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.06f))
                        .padding(horizontal = 8.dp, vertical = 6.dp),
                ) {
                    Text(
                        preview,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurface,
                        maxLines = 3,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }

            RowStatusFooter(item = item, onApprove = onApprove, onReject = onReject)
        }
    }
}

@Composable
private fun RowStatusFooter(
    item: ApprovalInbox.Item,
    onApprove: () -> Unit,
    onReject: () -> Unit,
) {
    when (item.status) {
        ApprovalInbox.RowStatus.PENDING, ApprovalInbox.RowStatus.FAILED -> {
            val rejectDesc = stringResource(R.string.approvals_a11y_reject_row, item.session.displayTitle)
            val approveDesc = stringResource(R.string.approvals_a11y_approve_row, item.session.displayTitle)
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (item.status == ApprovalInbox.RowStatus.FAILED) {
                    Text(
                        stringResource(R.string.approvals_status_failed),
                        style = MaterialTheme.typography.labelMedium,
                        color = PsColor.danger,
                        modifier = Modifier.weight(1f),
                    )
                } else {
                    Box(Modifier.weight(1f))
                }
                // Reject = danger (red); approve = success (green).
                OutlinedButton(
                    onClick = onReject,
                    colors = ButtonDefaults.outlinedButtonColors(contentColor = PsColor.danger),
                    modifier = Modifier.semantics { contentDescription = rejectDesc },
                ) { Text(stringResource(R.string.approvals_reject)) }
                Button(
                    onClick = onApprove,
                    colors = ButtonDefaults.buttonColors(containerColor = PsColor.success),
                    modifier = Modifier.semantics { contentDescription = approveDesc },
                ) { Text(stringResource(R.string.approvals_approve)) }
            }
        }
        ApprovalInbox.RowStatus.APPROVING ->
            StatusLine(
                spinner = true,
                text = stringResource(R.string.approvals_status_approving),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        ApprovalInbox.RowStatus.REJECTING ->
            StatusLine(
                spinner = true,
                text = stringResource(R.string.approvals_status_rejecting),
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        ApprovalInbox.RowStatus.APPROVED ->
            StatusLine(
                icon = Icons.Filled.CheckCircle,
                text = stringResource(R.string.approvals_status_approved),
                color = PsColor.success,
            )
        ApprovalInbox.RowStatus.REJECTED ->
            StatusLine(
                icon = Icons.Filled.Close,
                text = stringResource(R.string.approvals_status_rejected),
                color = PsColor.danger,
            )
    }
}

@Composable
private fun StatusLine(
    spinner: Boolean = false,
    icon: ImageVector? = null,
    text: String,
    color: Color,
) {
    Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
        if (spinner) {
            CircularProgressIndicator(modifier = Modifier.size(14.dp), strokeWidth = 2.dp, color = color)
        } else if (icon != null) {
            Icon(icon, contentDescription = null, tint = color, modifier = Modifier.size(16.dp))
        }
        Text(text, style = MaterialTheme.typography.labelMedium, color = color)
    }
}

@Composable
private fun Footer(
    state: ApprovalInbox.UiState,
    inbox: ApprovalInbox,
    onDismiss: () -> Unit,
) {
    if (state.hasActionable) {
        val approveAllDesc = stringResource(R.string.approvals_a11y_approve_all)
        val approveSelectedDesc = stringResource(R.string.approvals_a11y_approve_selected)
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                OutlinedButton(
                    onClick = { inbox.approve(selectedOnly = false) },
                    enabled = !state.busy,
                    colors = ButtonDefaults.outlinedButtonColors(contentColor = PsColor.success),
                    modifier = Modifier.weight(1f).semantics { contentDescription = approveAllDesc },
                ) { Text(stringResource(R.string.approvals_approve_all)) }

                Button(
                    onClick = { inbox.approve(selectedOnly = true) },
                    enabled = !state.busy && state.selectedActionableCount > 0,
                    colors = ButtonDefaults.buttonColors(containerColor = PsColor.success),
                    modifier = Modifier.weight(1f).semantics { contentDescription = approveSelectedDesc },
                ) {
                    Text(stringResource(R.string.approvals_approve_selected, state.selectedActionableCount))
                }
            }
            if (state.busy) {
                CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
            }
        }
    } else {
        Button(
            onClick = onDismiss,
            modifier = Modifier.fillMaxWidth(),
            colors = ButtonDefaults.buttonColors(containerColor = PsColor.accent),
        ) { Text(stringResource(R.string.approvals_done)) }
    }
}
