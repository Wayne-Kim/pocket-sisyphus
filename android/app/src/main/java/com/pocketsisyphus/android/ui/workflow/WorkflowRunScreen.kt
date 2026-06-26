package com.pocketsisyphus.android.ui.workflow

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.pocketsisyphus.android.R
import com.pocketsisyphus.android.data.model.WorkflowNodeDef
import com.pocketsisyphus.android.data.model.WorkflowNodeRun
import com.pocketsisyphus.android.ui.components.Pill
import com.pocketsisyphus.android.ui.theme.PsColor

private const val NODE_W = 132f
private const val NODE_H = 60f

/**
 * Read-only run canvas — polls live node state, colors each node by status, marks
 * synthetic/empty results with a warning badge (a «needs attention» signal, not a clean done),
 * and exposes per-node approve/reject/complete/retry plus «open session».
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun WorkflowRunScreen(
    workflowId: String?,
    runId: String?,
    title: String,
    onOpenSession: (String) -> Unit,
    onBack: () -> Unit,
    vm: WorkflowRunViewModel = viewModel(),
) {
    val state by vm.state.collectAsStateWithLifecycle()
    var selected by remember { mutableStateOf<WorkflowNodeRun?>(null) }

    LaunchedEffect(workflowId, runId) { vm.start(workflowId, runId) }

    val rs = state.runState
    val activeRunId = rs?.run?.id

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        rs?.run?.let { RunStatusLine(it.status, it.attentionKind) }
                    }
                },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.back))
                    }
                },
                actions = {
                    if (rs?.run?.status == "running" && activeRunId != null) {
                        TextButton(onClick = { vm.cancel(activeRunId) }) {
                            Text(stringResource(R.string.wf_cancel_run), color = PsColor.danger)
                        }
                    }
                },
            )
        },
    ) { inner ->
        Box(modifier = Modifier.fillMaxSize().padding(inner)) {
            when {
                state.loading && rs == null -> Box(Modifier.fillMaxSize(), Alignment.Center) { CircularProgressIndicator() }
                state.error != null && rs == null -> Box(Modifier.fillMaxSize(), Alignment.Center) {
                    Text(state.error!!, color = PsColor.danger)
                }
                rs != null -> Box(
                    modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState())
                        .background(MaterialTheme.colorScheme.surface),
                ) {
                    Box(modifier = Modifier.fillMaxWidth().padding(8.dp).size(width = 360.dp, height = 900.dp)) {
                        EdgeCanvasReadonly(rs.nodes, rs.edges)
                        val runsByDef = rs.nodeRuns.associateBy { it.defNodeId }
                        rs.nodes.forEach { def ->
                            RunNodeCard(def = def, run = runsByDef[def.id]) { selected = runsByDef[def.id] }
                        }
                    }
                }
            }
        }
    }

    selected?.let { run ->
        NodeRunSheet(
            run = run,
            onDismiss = { selected = null },
            onAction = { action -> activeRunId?.let { vm.nodeAction(it, run.id, action) }; selected = null },
            onOpenSession = { run.sessionId?.let(onOpenSession) },
        )
    }
}

@Composable
private fun RunStatusLine(status: String, attentionKind: String?) {
    val (key, color) = when {
        status == "failed" || attentionKind == "failed" -> R.string.wf_run_failed to PsColor.danger
        attentionKind == "empty" || attentionKind == "synthetic" -> R.string.wf_run_attention to PsColor.warning
        status == "done" -> R.string.wf_run_done to PsColor.success
        status == "cancelled" -> R.string.wf_run_cancelled to PsColor.onBgMuted
        else -> R.string.wf_run_running to PsColor.info
    }
    Text(stringResource(key), style = MaterialTheme.typography.labelMedium, color = color)
}

@Composable
private fun EdgeCanvasReadonly(nodes: List<WorkflowNodeDef>, edges: List<com.pocketsisyphus.android.data.model.WorkflowEdgeDef>) {
    androidx.compose.foundation.Canvas(modifier = Modifier.fillMaxSize()) {
        val byId = nodes.associateBy { it.id }
        edges.forEach { e ->
            val from = byId[e.from] ?: return@forEach
            val to = byId[e.to] ?: return@forEach
            val start = Offset((from.x ?: 0.0).dp.toPx() + NODE_W.dp.toPx() / 2, (from.y ?: 0.0).dp.toPx() + NODE_H.dp.toPx())
            val end = Offset((to.x ?: 0.0).dp.toPx() + NODE_W.dp.toPx() / 2, (to.y ?: 0.0).dp.toPx())
            val color = edgeColor(e.condition)
            drawLine(color = color, start = start, end = end, strokeWidth = 4f)
            val angle = kotlin.math.atan2((end.y - start.y).toDouble(), (end.x - start.x).toDouble())
            for (a in listOf(angle - 0.4, angle + 0.4)) {
                drawLine(
                    color = color,
                    start = end,
                    end = Offset(end.x - (18f * kotlin.math.cos(a)).toFloat(), end.y - (18f * kotlin.math.sin(a)).toFloat()),
                    strokeWidth = 4f,
                )
            }
        }
    }
}

@Composable
private fun RunNodeCard(def: WorkflowNodeDef, run: WorkflowNodeRun?, onTap: () -> Unit) {
    val kindColor = nodeKindColor(def.type)
    val statusColor = run?.let { nodeStatusColor(it.status) } ?: PsColor.onBgMuted
    Box(
        modifier = Modifier
            .padding(start = (def.x ?: 0.0).dp, top = (def.y ?: 0.0).dp)
            .size(width = NODE_W.dp, height = NODE_H.dp)
            .background(kindColor.copy(alpha = 0.18f), RoundedCornerShape(10.dp))
            .border(2.dp, statusColor, RoundedCornerShape(10.dp))
            .clickable(onClick = onTap)
            .padding(6.dp),
        contentAlignment = Alignment.Center,
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(def.title ?: nodeTypeLabelRun(def.type), style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
            run?.let {
                if (isHollowResult(it.resultKind)) {
                    Pill(stringResource(R.string.wf_result_attention), PsColor.warning)
                } else {
                    Text(nodeStatusLabel(it.status), style = MaterialTheme.typography.labelSmall, color = statusColor)
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun NodeRunSheet(
    run: WorkflowNodeRun,
    onDismiss: () -> Unit,
    onAction: (String) -> Unit,
    onOpenSession: () -> Unit,
) {
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(
            modifier = Modifier.fillMaxWidth().padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(run.title ?: nodeTypeLabelRun(run.nodeType), style = MaterialTheme.typography.titleMedium)
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Pill(nodeStatusLabel(run.status), nodeStatusColor(run.status))
                if (isHollowResult(run.resultKind)) Pill(stringResource(R.string.wf_result_attention), PsColor.warning)
            }
            run.loopbackReason?.let {
                Text(stringResource(R.string.wf_loopback, it), style = MaterialTheme.typography.bodySmall, color = PsColor.warning)
            }
            when (run.status) {
                "awaiting_approval" -> Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(onClick = { onAction("approve") }, modifier = Modifier.weight(1f)) {
                        Text(stringResource(R.string.wf_approve))
                    }
                    OutlinedButton(onClick = { onAction("reject") }) {
                        Text(stringResource(R.string.wf_reject), color = PsColor.danger)
                    }
                }
                "needs_attention", "failed" -> Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(onClick = { onAction("complete") }, modifier = Modifier.weight(1f)) {
                        Text(stringResource(R.string.wf_complete))
                    }
                    OutlinedButton(onClick = { onAction("retry") }) {
                        Text(stringResource(R.string.wf_retry))
                    }
                }
            }
            if (run.sessionId != null) {
                TextButton(onClick = onOpenSession) { Text(stringResource(R.string.wf_open_session)) }
            }
        }
    }
}

@Composable
private fun nodeTypeLabelRun(type: String): String = stringResource(
    when (type) {
        "start" -> R.string.wf_node_start
        "end" -> R.string.wf_node_end
        else -> R.string.wf_node_task
    },
)

@Composable
private fun nodeStatusLabel(status: String): String = stringResource(
    when (status) {
        "done" -> R.string.wf_status_done
        "failed" -> R.string.wf_status_failed
        "running" -> R.string.wf_status_running
        "awaiting_approval" -> R.string.wf_status_awaiting
        "needs_attention" -> R.string.wf_status_attention
        "skipped" -> R.string.wf_status_skipped
        else -> R.string.wf_status_pending
    },
)
