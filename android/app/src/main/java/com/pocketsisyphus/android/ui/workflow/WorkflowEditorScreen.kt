package com.pocketsisyphus.android.ui.workflow

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.requiredSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Build
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SuggestionChip
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.pocketsisyphus.android.R
import com.pocketsisyphus.android.data.Ps
import com.pocketsisyphus.android.data.model.AgentInfo
import com.pocketsisyphus.android.data.model.DesignWorkflowRequest
import com.pocketsisyphus.android.data.model.WorkflowEdgeDef
import com.pocketsisyphus.android.data.model.WorkflowNodeDef
import com.pocketsisyphus.android.data.model.WorkflowSummary
import com.pocketsisyphus.android.data.model.WorkflowTemplate
import com.pocketsisyphus.android.data.model.WorkflowTriggerDef
import com.pocketsisyphus.android.data.model.appOutputLocaleTag
import com.pocketsisyphus.android.ui.components.RepoPathField
import com.pocketsisyphus.android.ui.theme.PsColor
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private const val NODE_W = 156f
private const val NODE_H = 66f

/**
 * Canvas editor — drag start/task/end nodes, wire them with arrows, edit a node in a bottom sheet.
 * Node-kind colors follow the cross-platform contract (start=green, task=pink, end=blue). The
 * «connect» mode taps a source then a target to add a directed edge (cycle-checked). Inner buttons
 * keep the default accent tint — only the Automation *tab* button is orange (Pro), per the policy.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun WorkflowEditorScreen(
    existing: WorkflowSummary?,
    onSaved: (String) -> Unit,
    onBack: () -> Unit,
    vm: WorkflowEditorViewModel = viewModel(),
) {
    val state by vm.state.collectAsStateWithLifecycle()
    val density = LocalDensity.current

    var connectMode by remember { mutableStateOf(false) }
    var connectFrom by remember { mutableStateOf<String?>(null) }
    var edgeKind by remember { mutableStateOf<String?>(null) } // null = success/next, "fail" = failure branch
    var selectedNode by remember { mutableStateOf<String?>(null) }
    var addMenu by remember { mutableStateOf(false) }
    var connectNotice by remember { mutableStateOf<String?>(null) }
    var edgeToDelete by remember { mutableStateOf<WorkflowEdgeDef?>(null) }
    // Agents from the daemon (claude_code / agy / codex / copilot / local_llm / opencode / shell …),
    // exactly like iOS — so a new adapter shows up without an app update. Empty ⇒ static fallback.
    var agents by remember { mutableStateOf<List<AgentInfo>>(emptyList()) }
    // Starter helpers for a NEW workflow: pick a template or describe it in one line (AI draft) so the
    // user doesn't hand-build every node. Mirrors iOS WorkflowCreatorSheet.
    var templates by remember { mutableStateOf<List<WorkflowTemplate>>(emptyList()) }
    var aiDesc by remember { mutableStateOf("") }
    var designing by remember { mutableStateOf(false) }
    var designError by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    // Canvas viewport transform (pinch-zoom + pan + fit-to-content) — iOS parity.
    var canvasScale by remember { mutableFloatStateOf(1f) } // zoom (+/- buttons); pan is via scroll

    val cycleMsg = stringResource(R.string.wf_cycle_blocked)
    val needRepoMsg = stringResource(R.string.wf_starter_need_repo)
    val roleName = stringResource(R.string.wf_tpl_role_pipeline)
    val loopName = stringResource(R.string.wf_tpl_self_correcting)
    // Template node titles are daemon-provided ko fallbacks; localize by stable node id (iOS catalog).
    val tplNodeTitles = mapOf(
        "start" to stringResource(R.string.wf_node_start),
        "end" to stringResource(R.string.wf_node_end),
        "plan" to stringResource(R.string.wf_tnode_plan),
        "design" to stringResource(R.string.wf_tnode_design),
        "dev" to stringResource(R.string.wf_tnode_dev),
        "qa" to stringResource(R.string.wf_tnode_qa),
        "ops" to stringResource(R.string.wf_tnode_ops),
        "make" to stringResource(R.string.wf_tnode_make),
        "check" to stringResource(R.string.wf_tnode_check),
    )

    LaunchedEffect(Unit) { agents = runCatching { Ps.api.agents() }.getOrDefault(emptyList()) }
    LaunchedEffect(existing?.id) {
        templates = if (existing == null) {
            runCatching { Ps.api.workflowTemplates() }.getOrDefault(emptyList())
        } else {
            emptyList()
        }
    }
    LaunchedEffect(existing?.id) { vm.load(existing) }
    LaunchedEffect(state.savedId) { state.savedId?.let(onSaved) }
    LaunchedEffect(connectNotice) {
        if (connectNotice != null) {
            delay(2_500)
            connectNotice = null
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(if (existing == null) R.string.wf_new else R.string.wf_edit)) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.back))
                    }
                },
                actions = {
                    IconButton(onClick = { vm.undo() }, enabled = state.canUndo) {
                        Text("↶", style = MaterialTheme.typography.titleLarge)
                    }
                    IconButton(onClick = { vm.redo() }, enabled = state.canRedo) {
                        Text("↷", style = MaterialTheme.typography.titleLarge)
                    }
                    TextButton(enabled = !state.saving && state.repoPath.isNotBlank(), onClick = { vm.save() }) {
                        if (state.saving) CircularProgressIndicator(modifier = Modifier.size(18.dp).padding(end = 4.dp))
                        Text(stringResource(R.string.save))
                    }
                },
            )
        },
    ) { inner ->
        Column(modifier = Modifier.fillMaxSize().padding(inner)) {
            Column(
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                OutlinedTextField(
                    value = state.title,
                    onValueChange = vm::setTitle,
                    label = { Text(stringResource(R.string.wf_field_title)) },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                RepoPathField(
                    value = state.repoPath,
                    onValueChange = vm::setRepoPath,
                    modifier = Modifier.fillMaxWidth(),
                )

                // Starter section — only when creating a new workflow (don't clutter editing).
                if (existing == null) {
                    if (templates.isNotEmpty()) {
                        Text(stringResource(R.string.wf_starter_template), style = MaterialTheme.typography.labelLarge)
                        Row(
                            modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            templates.forEach { t ->
                                val name = when (t.id) {
                                    "role_pipeline" -> roleName
                                    "self_correcting_loop" -> loopName
                                    else -> t.id
                                }
                                AssistChip(
                                    onClick = {
                                        vm.seedGraph(
                                            t.nodes.map { n -> n.copy(title = tplNodeTitles[n.id] ?: n.title) },
                                            t.edges,
                                        )
                                    },
                                    label = { Text(name) },
                                )
                            }
                        }
                    }
                    Text(stringResource(R.string.wf_starter_ai), style = MaterialTheme.typography.labelLarge)
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        OutlinedTextField(
                            value = aiDesc,
                            onValueChange = { aiDesc = it },
                            placeholder = { Text(stringResource(R.string.wf_starter_ai_hint)) },
                            singleLine = true,
                            enabled = !designing,
                            modifier = Modifier.weight(1f),
                        )
                        Button(
                            enabled = !designing && aiDesc.isNotBlank(),
                            onClick = {
                                if (state.repoPath.isBlank()) {
                                    designError = needRepoMsg
                                } else {
                                    designError = null
                                    designing = true
                                    val desc = aiDesc.trim()
                                    val repo = state.repoPath.trim()
                                    scope.launch {
                                        try {
                                            val start = Ps.api.designWorkflow(
                                                DesignWorkflowRequest(
                                                    description = desc,
                                                    repoPath = repo,
                                                    agent = "claude_code",
                                                    locale = appOutputLocaleTag(),
                                                ),
                                            )
                                            while (true) {
                                                delay(1_500)
                                                val st = Ps.api.workflowDesignState(start.designId)
                                                if (st.status == "ready") {
                                                    vm.seedGraph(st.nodes ?: emptyList(), st.edges ?: emptyList())
                                                    break
                                                }
                                                if (st.status == "failed") {
                                                    designError = st.error ?: "design failed"
                                                    break
                                                }
                                            }
                                        } catch (e: Throwable) {
                                            designError = e.message ?: "design failed"
                                        } finally {
                                            designing = false
                                        }
                                    }
                                }
                            },
                        ) {
                            if (designing) {
                                CircularProgressIndicator(
                                    modifier = Modifier.size(18.dp),
                                    strokeWidth = 2.dp,
                                    color = MaterialTheme.colorScheme.onPrimary,
                                )
                            } else {
                                Text(stringResource(R.string.wf_starter_generate))
                            }
                        }
                    }
                    if (designing) {
                        Text(
                            stringResource(R.string.wf_starter_generating),
                            style = MaterialTheme.typography.bodySmall,
                            color = PsColor.info,
                        )
                    }
                    designError?.let { Text(it, color = PsColor.danger, style = MaterialTheme.typography.bodySmall) }
                }

                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Box {
                        AssistChip(
                            onClick = { addMenu = true },
                            label = { Text(stringResource(R.string.wf_add_node)) },
                            leadingIcon = { Icon(Icons.Filled.Add, contentDescription = null) },
                        )
                        DropdownMenu(expanded = addMenu, onDismissRequest = { addMenu = false }) {
                            DropdownMenuItem(
                                text = { Text(stringResource(R.string.wf_node_start)) },
                                onClick = { vm.addNode("start"); addMenu = false },
                            )
                            DropdownMenuItem(
                                text = { Text(stringResource(R.string.wf_node_task)) },
                                onClick = { vm.addNode("task"); addMenu = false },
                            )
                            DropdownMenuItem(
                                text = { Text(stringResource(R.string.wf_node_end)) },
                                onClick = { vm.addNode("end"); addMenu = false },
                            )
                        }
                    }
                    FilterChip(
                        selected = connectMode,
                        onClick = { connectMode = !connectMode; connectFrom = null; connectNotice = null },
                        label = { Text(stringResource(R.string.wf_connect)) },
                    )
                }
                if (connectMode) {
                    // Choose the branch kind: success/next (bottom port) or failure (right port, red).
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        FilterChip(
                            selected = edgeKind == null,
                            onClick = { edgeKind = null },
                            label = { Text(stringResource(R.string.wf_edge_next)) },
                        )
                        FilterChip(
                            selected = edgeKind == "fail",
                            onClick = { edgeKind = "fail" },
                            label = { Text(stringResource(R.string.wf_edge_fail)) },
                        )
                    }
                    Text(
                        stringResource(
                            if (connectFrom == null) R.string.wf_connect_pick_source else R.string.wf_connect_pick_target,
                        ),
                        style = MaterialTheme.typography.bodySmall,
                        color = PsColor.info,
                    )
                }
                connectNotice?.let { Text(it, color = PsColor.warning, style = MaterialTheme.typography.bodySmall) }
                state.error?.let { Text(it, color = PsColor.danger, style = MaterialTheme.typography.bodySmall) }
            }

            // Scrollable canvas — content is sized to the FULL graph (so every node lays out and is
            // reachable by scrolling), zoomed by the +/- buttons. A scroll container gives the content
            // unbounded constraints, so nodes positioned past the viewport still draw (the old
            // fit-to-viewport design clamped the world height → only ~3 nodes ever rendered).
            val worldW = ((state.nodes.maxOfOrNull { (it.x ?: 0.0) + NODE_W } ?: 360.0) + 80.0)
                .coerceAtLeast(360.0).toFloat()
            val worldH = ((state.nodes.maxOfOrNull { (it.y ?: 0.0) + NODE_H } ?: 640.0) + 80.0)
                .coerceAtLeast(640.0).toFloat()
            val vScroll = rememberScrollState()
            val hScroll = rememberScrollState()
            Box(modifier = Modifier.fillMaxWidth().weight(1f)) {
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .clipToBounds()
                        .background(MaterialTheme.colorScheme.surface)
                        .verticalScroll(vScroll)
                        .horizontalScroll(hScroll),
                ) {
                    // Outer reserves the SCALED footprint so scrolling reaches all zoomed content; inner
                    // is the 1× world that the graphicsLayer scales around its top-left.
                    Box(modifier = Modifier.size((worldW * canvasScale).dp, (worldH * canvasScale).dp)) {
                        Box(
                            modifier = Modifier
                                // requiredSize, not size: the scaled-footprint parent is SMALLER than the
                                // world at zoom < 1, and .size would clamp to it → nodes past it wouldn't
                                // lay out. requiredSize forces the full world; graphicsLayer scales it down.
                                .requiredSize(width = worldW.dp, height = worldH.dp)
                                .graphicsLayer {
                                    scaleX = canvasScale
                                    scaleY = canvasScale
                                    transformOrigin = TransformOrigin(0f, 0f)
                                },
                        ) {
                            EdgeCanvas(state.nodes, state.edges)
                            if (!connectMode) {
                                val byId = state.nodes.associateBy { it.id }
                                state.edges.forEach { e ->
                                    val from = byId[e.from] ?: return@forEach
                                    val to = byId[e.to] ?: return@forEach
                                    val cur = edgeCurve(from, to, state.nodes, e.condition)
                                    EdgeDeleteHandle(cur.midX() - 13.0, cur.midY() - 13.0) { edgeToDelete = e }
                                }
                            }
                            state.nodes.forEach { node ->
                                EditorNodeCard(
                                    node = node,
                                    selected = selectedNode == node.id || connectFrom == node.id,
                                    agentLabel = node.agent?.let { a -> agents.firstOrNull { it.id == a }?.displayName ?: a },
                                    onDragStart = { if (!connectMode) vm.snapshot() },
                                    onDrag = { dx, dy ->
                                        // graphicsLayer delivers pointer deltas in the scaled content's
                                        // local space, so pass them through (no extra /scale correction).
                                        if (!connectMode) {
                                            vm.moveNodeBy(
                                                node.id,
                                                with(density) { dx.toDp().value.toDouble() },
                                                with(density) { dy.toDp().value.toDouble() },
                                            )
                                        }
                                    },
                                    onTap = {
                                        if (connectMode) {
                                            val from = connectFrom
                                            if (from == null) {
                                                connectFrom = node.id
                                            } else {
                                                when (vm.connect(from, node.id, edgeKind)) {
                                                    WorkflowEditorViewModel.ConnectResult.ADDED -> {
                                                        connectFrom = null
                                                        connectMode = false
                                                    }
                                                    WorkflowEditorViewModel.ConnectResult.CYCLE -> {
                                                        connectNotice = cycleMsg
                                                        connectFrom = null
                                                    }
                                                    else -> connectFrom = null
                                                }
                                            }
                                        } else {
                                            selectedNode = node.id
                                        }
                                    },
                                )
                            }
                        }
                    }
                }

                // Zoom controls — float over the canvas (outside the scroll).
                Column(
                    modifier = Modifier.align(Alignment.BottomEnd).padding(12.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    AssistChip(onClick = { canvasScale = (canvasScale + 0.2f).coerceAtMost(2.5f) }, label = { Text("+") })
                    AssistChip(onClick = { canvasScale = (canvasScale - 0.2f).coerceAtLeast(0.4f) }, label = { Text("−") })
                    AssistChip(onClick = { canvasScale = 1f }, label = { Text(stringResource(R.string.wf_fit)) })
                }
            }
        }
    }

    selectedNode?.let { id ->
        val node = state.nodes.firstOrNull { it.id == id }
        if (node != null) {
            NodeInspectorSheet(
                node = node,
                agents = agents,
                onDismiss = { selectedNode = null },
                onSave = { vm.updateNode(it) },
                onDelete = {
                    vm.removeNode(id)
                    selectedNode = null
                },
            )
        }
    }

    edgeToDelete?.let { e ->
        AlertDialog(
            onDismissRequest = { edgeToDelete = null },
            title = { Text(stringResource(R.string.wf_edge_edit_title)) },
            confirmButton = {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    TextButton(onClick = { vm.insertNodeOnEdge(e); edgeToDelete = null }) {
                        Text(stringResource(R.string.wf_edge_insert))
                    }
                    TextButton(onClick = { vm.removeEdge(e.id); edgeToDelete = null }) {
                        Text(stringResource(R.string.delete), color = PsColor.danger)
                    }
                }
            },
            dismissButton = {
                TextButton(onClick = { edgeToDelete = null }) { Text(stringResource(R.string.cancel)) }
            },
        )
    }
}

/**
 * Faithful port of iOS `routeWorkflowEdge` (Views/Workflow/WorkflowEdgeRouter.swift) — the single
 * source of truth for edge geometry, so Android edges match iOS exactly. Output port → target
 * center, as a cubic Bézier; the endpoint is pulled to the target boundary on the side FACING the
 * source, and the curve deflects perpendicular only when it would cross an intermediate node.
 *
 *  - condition "fail" → leaves the source's RIGHT port (horizontal out); else → BOTTOM port (vertical).
 *  - end = target.center − dir·(NODE_H/2 + 4): a forward edge lands on the target's top; a fail
 *    loopback (source below the target) lands on the target's BOTTOM — exactly like iOS.
 *
 * dp throughout, so the canvas (px) and the delete handle (dp) agree on the curve midpoint.
 */
private data class EdgeCurveDp(
    val sx: Double, val sy: Double,
    val c1x: Double, val c1y: Double,
    val c2x: Double, val c2y: Double,
    val ex: Double, val ey: Double,
) {
    fun midX(): Double = cubic(sx, c1x, c2x, ex, 0.5)
    fun midY(): Double = cubic(sy, c1y, c2y, ey, 0.5)
}

/** A point on a cubic Bézier (one axis). */
private fun cubic(p0: Double, c1: Double, c2: Double, p3: Double, t: Double): Double {
    val mt = 1 - t
    return mt * mt * mt * p0 + 3 * mt * mt * t * c1 + 3 * mt * t * t * c2 + t * t * t * p3
}

private fun edgeCurve(
    from: WorkflowNodeDef,
    to: WorkflowNodeDef,
    nodes: List<WorkflowNodeDef>,
    condition: String?,
): EdgeCurveDp {
    val halfW = NODE_W.toDouble() / 2
    val nh = NODE_H.toDouble()
    val fail = condition == "fail"
    // Output port: fail = source right-center; else = source bottom-center.
    val sx = (from.x ?: 0.0) + if (fail) NODE_W.toDouble() else halfW
    val sy = (from.y ?: 0.0) + if (fail) nh / 2 else nh
    // Target center, and the unit vector from the port toward it.
    val tcx = (to.x ?: 0.0) + halfW
    val tcy = (to.y ?: 0.0) + nh / 2
    val dx = tcx - sx
    val dy = tcy - sy
    val len = kotlin.math.hypot(dx, dy).coerceAtLeast(1.0)
    val ux = dx / len
    val uy = dy / len
    // Arrowhead vertex — pulled from the target center toward the source by NODE_H/2 + 4, so it lands
    // on the target boundary on the side facing the source (forward ⇒ top, fail loopback ⇒ bottom).
    val ex = tcx - ux * (nh / 2 + 4)
    val ey = tcy - uy * (nh / 2 + 4)
    val outX = if (fail) 1.0 else 0.0 // fail leaves horizontally (right), else vertically (down)
    val outY = if (fail) 0.0 else 1.0
    val h = (len * 0.4).coerceIn(16.0, 120.0)
    val c1x = sx + outX * h
    val c1y = sy + outY * h
    val c2x = ex - ux * h
    val c2y = ey - uy * h

    // Perpendicular deflection ONLY when the straight-ish curve would cross an intermediate node.
    val margin = 8.0
    val obstacles = nodes.filter { it.id != from.id && it.id != to.id }
    fun hits(ax: Double, ay: Double, bx: Double, by: Double): Boolean {
        if (obstacles.isEmpty()) return false
        val steps = (len / 24).toInt().coerceIn(24, 96)
        for (i in 0..steps) {
            val t = i.toDouble() / steps
            val px = cubic(sx, ax, bx, ex, t)
            val py = cubic(sy, ay, by, ey, t)
            for (n in obstacles) {
                val nx0 = (n.x ?: 0.0) - margin
                val ny0 = (n.y ?: 0.0) - margin
                val nx1 = (n.x ?: 0.0) + NODE_W + margin
                val ny1 = (n.y ?: 0.0) + NODE_H + margin
                if (px in nx0..nx1 && py in ny0..ny1) return true
            }
        }
        return false
    }

    var fc1x = c1x
    var fc1y = c1y
    var fc2x = c2x
    var fc2y = c2y
    if (hits(c1x, c1y, c2x, c2y)) {
        val perpX = -uy
        val perpY = ux
        var sideSum = 0.0
        for (n in obstacles) {
            val mx = (n.x ?: 0.0) + halfW
            val my = (n.y ?: 0.0) + nh / 2
            sideSum += dx * (my - sy) - dy * (mx - sx)
        }
        val firstSide = if (sideSum >= 0) -1.0 else 1.0
        outer@ for (side in listOf(firstSide, -firstSide)) {
            var s = 40.0
            while (s <= 280.0) {
                val ox = perpX * side * s
                val oy = perpY * side * s
                if (!hits(c1x + ox, c1y + oy, c2x + ox, c2y + oy)) {
                    fc1x = c1x + ox; fc1y = c1y + oy; fc2x = c2x + ox; fc2y = c2y + oy
                    break@outer
                }
                s += 40.0
            }
        }
    }
    return EdgeCurveDp(sx, sy, fc1x, fc1y, fc2x, fc2y, ex, ey)
}

@Composable
private fun EdgeCanvas(nodes: List<WorkflowNodeDef>, edges: List<WorkflowEdgeDef>) {
    androidx.compose.foundation.Canvas(modifier = Modifier.fillMaxSize()) {
        val byId = nodes.associateBy { it.id }
        edges.forEach { e ->
            val from = byId[e.from] ?: return@forEach
            val to = byId[e.to] ?: return@forEach
            val cur = edgeCurve(from, to, nodes, e.condition)
            val start = Offset(cur.sx.dp.toPx(), cur.sy.dp.toPx())
            val c1 = Offset(cur.c1x.dp.toPx(), cur.c1y.dp.toPx())
            val c2 = Offset(cur.c2x.dp.toPx(), cur.c2y.dp.toPx())
            val end = Offset(cur.ex.dp.toPx(), cur.ey.dp.toPx())
            val color = edgeColor(e.condition)
            val path = Path().apply {
                moveTo(start.x, start.y)
                cubicTo(c1.x, c1.y, c2.x, c2.y, end.x, end.y)
            }
            drawPath(path, color = color, style = Stroke(width = 4f))
            // Arrowhead — angle from the curve's end tangent (B'(1) ∝ end - c2).
            val angle = kotlin.math.atan2((end.y - c2.y).toDouble(), (end.x - c2.x).toDouble())
            val len = 18f
            for (a in listOf(angle - 0.4, angle + 0.4)) {
                drawLine(
                    color = color,
                    start = end,
                    end = Offset(
                        end.x - (len * kotlin.math.cos(a)).toFloat(),
                        end.y - (len * kotlin.math.sin(a)).toFloat(),
                    ),
                    strokeWidth = 4f,
                )
            }
        }
    }
}

/** Tiny circular handle at an edge midpoint — tap to delete that edge (confirmed by the caller). */
@Composable
private fun EdgeDeleteHandle(xDp: Double, yDp: Double, onClick: () -> Unit) {
    Box(
        modifier = Modifier
            .absoluteOffset(xDp, yDp)
            .size(26.dp)
            .background(MaterialTheme.colorScheme.surface, CircleShape)
            .border(1.5.dp, PsColor.danger, CircleShape)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            Icons.Filled.Close,
            contentDescription = stringResource(R.string.wf_edge_delete_title),
            tint = PsColor.danger,
            modifier = Modifier.size(16.dp),
        )
    }
}

@Composable
private fun EditorNodeCard(
    node: WorkflowNodeDef,
    selected: Boolean,
    agentLabel: String?,
    onDragStart: () -> Unit,
    onDrag: (Float, Float) -> Unit,
    onTap: () -> Unit,
) {
    // `pointerInput(node.id)` doesn't relaunch while the id is stable, so the gesture coroutine holds
    // whatever lambda it captured first. rememberUpdatedState keeps the LATEST callbacks visible to
    // it — without this, dragging snaps back and connect-mode taps fall through to the inspector.
    val latestOnDragStart by rememberUpdatedState(onDragStart)
    val latestOnDrag by rememberUpdatedState(onDrag)
    val latestOnTap by rememberUpdatedState(onTap)
    val color = nodeKindColor(node.type)
    val icon = when {
        node.isStart -> Icons.Filled.PlayArrow
        node.isEnd -> Icons.Filled.CheckCircle
        else -> Icons.Filled.Build
    }
    Box(
        modifier = Modifier
            .absoluteOffset(node.x ?: 0.0, node.y ?: 0.0)
            .size(width = NODE_W.dp, height = NODE_H.dp)
            .background(color.copy(alpha = 0.14f), RoundedCornerShape(12.dp))
            .border(
                width = if (selected) 2.dp else 1.5.dp,
                color = if (selected) PsColor.accent else color,
                shape = RoundedCornerShape(12.dp),
            )
            .pointerInput(node.id) { detectTapGestures(onTap = { latestOnTap() }) }
            .pointerInput(node.id) {
                detectDragGestures(
                    onDragStart = { latestOnDragStart() },
                ) { change, drag ->
                    change.consume()
                    latestOnDrag(drag.x, drag.y)
                }
            }
            .padding(horizontal = 11.dp, vertical = 8.dp),
        contentAlignment = Alignment.CenterStart,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(9.dp)) {
            Icon(icon, contentDescription = null, tint = color, modifier = Modifier.size(20.dp))
            Column {
                Text(
                    node.title?.takeIf { it.isNotBlank() } ?: defaultNodeTitle(node.type),
                    style = MaterialTheme.typography.titleSmall,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                val subtitle = if (node.isWork) (agentLabel ?: "claude_code") else nodeTypeLabel(node.type)
                Text(
                    subtitle,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

private fun Modifier.absoluteOffset(xDp: Double, yDp: Double): Modifier =
    this.then(Modifier.padding(start = xDp.dp, top = yDp.dp))

@Composable
private fun nodeTypeLabel(type: String): String = stringResource(
    when (type) {
        "start" -> R.string.wf_node_start
        "end" -> R.string.wf_node_end
        else -> R.string.wf_node_task
    },
)

@Composable
private fun defaultNodeTitle(type: String): String = nodeTypeLabel(type)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun NodeInspectorSheet(
    node: WorkflowNodeDef,
    agents: List<AgentInfo>,
    onDismiss: () -> Unit,
    onSave: (WorkflowNodeDef) -> Unit,
    onDelete: () -> Unit,
) {
    var title by remember { mutableStateOf(node.title ?: "") }
    var agent by remember { mutableStateOf(node.agent ?: "claude_code") }
    var prompt by remember { mutableStateOf(node.prompt ?: "") }
    var resultSpec by remember { mutableStateOf(node.resultSpec ?: "") }
    var checkCommand by remember { mutableStateOf(node.checkCommand ?: "") }
    var skipPermissions by remember { mutableStateOf(node.skipPermissions ?: true) }
    var requiresApproval by remember { mutableStateOf(node.requiresApproval ?: false) }
    // Start-node cron schedule (null = manual only). iOS parity: schedule the whole workflow.
    var cronSchedule by remember { mutableStateOf(node.triggers?.firstOrNull { it.kind == "cron" }?.schedule) }
    val tz = remember { java.util.TimeZone.getDefault().id }

    val isShell = agent == "shell"
    // Dynamic list from the daemon; static fallback for old daemons / offline.
    val agentOptions: List<Pair<String, String>> = if (agents.isNotEmpty()) {
        agents.map { it.id to it.displayName }
    } else {
        listOf(
            "claude_code" to "Claude Code",
            "codex" to "Codex",
            "copilot" to "Copilot",
            "shell" to "Terminal",
        )
    }

    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(
            modifier = Modifier.fillMaxWidth().padding(16.dp).verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(nodeTypeLabel(node.type), style = MaterialTheme.typography.titleMedium, color = nodeKindColor(node.type))
            OutlinedTextField(
                value = title,
                onValueChange = { title = it },
                label = { Text(stringResource(R.string.wf_node_title_label)) },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            if (node.isWork) {
                Text(stringResource(R.string.wf_node_agent), style = MaterialTheme.typography.labelLarge)
                Row(
                    modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    agentOptions.forEach { (id, label) ->
                        FilterChip(
                            selected = agent == id,
                            onClick = { agent = id },
                            label = { Text(label) },
                        )
                    }
                }
                OutlinedTextField(
                    value = prompt,
                    onValueChange = { prompt = it },
                    label = {
                        Text(stringResource(if (isShell) R.string.wf_node_shell else R.string.wf_node_prompt))
                    },
                    minLines = 3,
                    textStyle = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
                    modifier = Modifier.fillMaxWidth(),
                )
                if (!isShell) {
                    OutlinedTextField(
                        value = resultSpec,
                        onValueChange = { resultSpec = it },
                        label = { Text(stringResource(R.string.wf_node_result_spec)) },
                        supportingText = { Text(stringResource(R.string.wf_node_result_spec_hint)) },
                        minLines = 2,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
                OutlinedTextField(
                    value = checkCommand,
                    onValueChange = { checkCommand = it },
                    label = { Text(stringResource(R.string.wf_node_check)) },
                    supportingText = {
                        Text(
                            stringResource(
                                if (checkCommand.isBlank()) R.string.wf_node_check_warning else R.string.wf_node_check_hint,
                            ),
                            color = if (checkCommand.isBlank()) PsColor.warning else MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    },
                    singleLine = true,
                    textStyle = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
                    modifier = Modifier.fillMaxWidth(),
                )
                ToggleRow(
                    label = stringResource(R.string.wf_node_skip_permissions),
                    checked = skipPermissions,
                    onCheckedChange = { skipPermissions = it },
                )
                ToggleRow(
                    label = stringResource(R.string.wf_node_requires_approval),
                    checked = requiresApproval,
                    onCheckedChange = { requiresApproval = it },
                )
            }
            if (node.isStart) {
                Text(stringResource(R.string.wf_schedule), style = MaterialTheme.typography.labelLarge)
                val sched = cronSchedule
                if (sched == null) {
                    OutlinedButton(onClick = { cronSchedule = "0 9 * * *" }) {
                        Text(stringResource(R.string.wf_schedule_add))
                    }
                } else {
                    Row(
                        modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        SuggestionChip(onClick = { cronSchedule = "0 9 * * *" }, label = { Text(stringResource(R.string.wf_sched_daily)) })
                        SuggestionChip(onClick = { cronSchedule = "0 * * * *" }, label = { Text(stringResource(R.string.wf_sched_hourly)) })
                        SuggestionChip(onClick = { cronSchedule = "0 9 * * 1-5" }, label = { Text(stringResource(R.string.wf_sched_weekdays)) })
                        SuggestionChip(onClick = { cronSchedule = "0 9 * * 1" }, label = { Text(stringResource(R.string.wf_sched_weekly)) })
                    }
                    OutlinedTextField(
                        value = sched,
                        onValueChange = { cronSchedule = it },
                        label = { Text("cron") },
                        singleLine = true,
                        textStyle = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
                        modifier = Modifier.fillMaxWidth(),
                    )
                    // Live next-run preview from the daemon.
                    var nextRun by remember { mutableStateOf<String?>(null) }
                    var schedInvalid by remember { mutableStateOf(false) }
                    LaunchedEffect(sched, tz) {
                        if (sched.isBlank()) {
                            nextRun = null; schedInvalid = false
                        } else {
                            val p = runCatching { Ps.api.previewSchedule(sched, tz) }.getOrNull()
                            if (p?.valid == true && p.nextRuns.isNotEmpty()) {
                                val fmt = java.text.SimpleDateFormat("MMM d · HH:mm", java.util.Locale.getDefault())
                                nextRun = fmt.format(java.util.Date(p.nextRuns.first())); schedInvalid = false
                            } else {
                                nextRun = null; schedInvalid = true
                            }
                        }
                    }
                    if (schedInvalid) {
                        Text(stringResource(R.string.wf_schedule_invalid), color = PsColor.warning, style = MaterialTheme.typography.bodySmall)
                    } else {
                        nextRun?.let {
                            Text(
                                stringResource(R.string.wf_schedule_next, it),
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                style = MaterialTheme.typography.bodySmall,
                            )
                        }
                    }
                    TextButton(onClick = { cronSchedule = null }) {
                        Text(stringResource(R.string.delete), color = PsColor.danger)
                    }
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(
                    onClick = {
                        val cronTriggers = cronSchedule?.trim()?.takeIf { it.isNotEmpty() }
                            ?.let { listOf(WorkflowTriggerDef(kind = "cron", schedule = it, timezone = tz)) }
                        onSave(
                            node.copy(
                                title = title.trim().ifEmpty { null },
                                agent = if (node.isWork) agent else node.agent,
                                prompt = prompt.trim().ifEmpty { null },
                                resultSpec = if (node.isWork && !isShell) resultSpec.trim().ifEmpty { null } else null,
                                checkCommand = checkCommand.trim().ifEmpty { null },
                                skipPermissions = if (node.isWork) skipPermissions else node.skipPermissions,
                                requiresApproval = if (node.isWork) requiresApproval else node.requiresApproval,
                                triggers = if (node.isStart) cronTriggers else node.triggers,
                            ),
                        )
                        onDismiss()
                    },
                    modifier = Modifier.weight(1f),
                ) { Text(stringResource(R.string.save)) }
                if (!node.isStart && !node.isEnd) {
                    TextButton(onClick = onDelete) {
                        Text(stringResource(R.string.delete), color = PsColor.danger)
                    }
                }
            }
        }
    }
}

@Composable
private fun ToggleRow(label: String, checked: Boolean, onCheckedChange: (Boolean) -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(label, modifier = Modifier.weight(1f))
        Switch(checked = checked, onCheckedChange = onCheckedChange)
    }
}
