package com.pocketsisyphus.android.ui.workflow

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.pocketsisyphus.android.data.Ps
import com.pocketsisyphus.android.data.model.CreateWorkflowRequest
import com.pocketsisyphus.android.data.model.WorkflowEdgeDef
import com.pocketsisyphus.android.data.model.WorkflowNodeDef
import com.pocketsisyphus.android.data.model.WorkflowRunStateResponse
import com.pocketsisyphus.android.data.model.WorkflowSummary
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/** Workflow list state. */
class WorkflowListViewModel : ViewModel() {

    data class UiState(
        val loading: Boolean = true,
        val workflows: List<WorkflowSummary> = emptyList(),
        val error: String? = null,
    )

    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state.asStateFlow()

    init {
        refresh()
    }

    fun refresh() = viewModelScope.launch {
        try {
            val resp = Ps.api.listWorkflows()
            _state.update { it.copy(loading = false, workflows = resp.workflows, error = null) }
        } catch (e: Throwable) {
            _state.update { it.copy(loading = false, error = e.message ?: "Failed to load") }
        }
    }

    fun delete(id: String) = viewModelScope.launch {
        try {
            Ps.api.deleteWorkflow(id)
            refresh()
        } catch (e: Throwable) {
            _state.update { it.copy(error = e.message ?: "Delete failed") }
        }
    }
}

/** Editor state — the in-memory graph being built/edited and the save action. */
class WorkflowEditorViewModel : ViewModel() {

    data class UiState(
        val title: String = "",
        val repoPath: String = "",
        val nodes: List<WorkflowNodeDef> = emptyList(),
        val edges: List<WorkflowEdgeDef> = emptyList(),
        val saving: Boolean = false,
        val error: String? = null,
        val savedId: String? = null,
        val canUndo: Boolean = false,
        val canRedo: Boolean = false,
    )

    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state.asStateFlow()

    private var existingId: String? = null

    // Undo/redo of the graph (nodes+edges), iOS parity. snapshot() is called just before each
    // mutation; a drag snapshots once at gesture start (see the editor) so a whole drag is one step.
    private val undoStack = ArrayDeque<Pair<List<WorkflowNodeDef>, List<WorkflowEdgeDef>>>()
    private val redoStack = ArrayDeque<Pair<List<WorkflowNodeDef>, List<WorkflowEdgeDef>>>()
    private val maxHistory = 50

    fun snapshot() {
        val s = _state.value
        undoStack.addLast(s.nodes to s.edges)
        while (undoStack.size > maxHistory) undoStack.removeFirst()
        redoStack.clear()
        _state.update { it.copy(canUndo = true, canRedo = false) }
    }

    fun undo() {
        val prev = undoStack.removeLastOrNull() ?: return
        _state.update { s ->
            redoStack.addLast(s.nodes to s.edges)
            s.copy(nodes = prev.first, edges = prev.second, canUndo = undoStack.isNotEmpty(), canRedo = true)
        }
    }

    fun redo() {
        val next = redoStack.removeLastOrNull() ?: return
        _state.update { s ->
            undoStack.addLast(s.nodes to s.edges)
            s.copy(nodes = next.first, edges = next.second, canRedo = redoStack.isNotEmpty(), canUndo = true)
        }
    }

    /** Seed from an existing workflow, or a minimal start→end skeleton for a new one. */
    fun load(existing: WorkflowSummary?) {
        undoStack.clear()
        redoStack.clear()
        if (existing != null) {
            existingId = existing.id
            _state.value = UiState(
                title = existing.title ?: "",
                repoPath = existing.repoPath ?: "",
                nodes = existing.nodes,
                edges = existing.edges,
            )
        } else {
            existingId = null
            val start = WorkflowNodeDef(id = newId("n"), type = "start", title = null, x = 60.0, y = 80.0)
            val end = WorkflowNodeDef(id = newId("n"), type = "end", title = null, x = 60.0, y = 360.0)
            _state.value = UiState(nodes = listOf(start, end))
        }
    }

    fun setTitle(v: String) = _state.update { it.copy(title = v) }
    fun setRepoPath(v: String) = _state.update { it.copy(repoPath = v) }

    /** Replace the whole graph (template seed / AI draft). Undoable, and keeps a title if already set. */
    fun seedGraph(nodes: List<WorkflowNodeDef>, edges: List<WorkflowEdgeDef>) {
        snapshot()
        _state.update { it.copy(nodes = nodes, edges = edges) }
    }

    fun moveNode(id: String, x: Double, y: Double) = _state.update { s ->
        s.copy(nodes = s.nodes.map { if (it.id == id) it.copy(x = x, y = y) else it })
    }

    /**
     * Move a node by a delta (dp), reading the live position from current state. Drag callbacks
     * captured inside a node's `pointerInput(node.id)` go stale (the block isn't relaunched while the
     * key is unchanged), so accumulating onto a captured `node.x` snaps the node back every frame.
     * Reading from `_state` here makes accumulation correct regardless of capture staleness.
     */
    fun moveNodeBy(id: String, dx: Double, dy: Double) = _state.update { s ->
        s.copy(
            nodes = s.nodes.map {
                if (it.id == id) {
                    it.copy(
                        x = ((it.x ?: 0.0) + dx).coerceAtLeast(0.0),
                        y = ((it.y ?: 0.0) + dy).coerceAtLeast(0.0),
                    )
                } else {
                    it
                }
            },
        )
    }

    fun addNode(type: String) {
        snapshot()
        _state.update { s ->
            // Cascade new nodes so successive «add» taps don't stack on the same spot (was 200,200).
            val n = s.nodes.size
            val node = WorkflowNodeDef(
                id = newId("n"),
                type = type,
                title = null,
                agent = if (type == "task") "claude_code" else null,
                skipPermissions = if (type == "task") true else null,
                x = 150.0 + (n % 6) * 26.0,
                y = 150.0 + (n % 6) * 26.0,
            )
            s.copy(nodes = s.nodes + node)
        }
    }

    fun updateNode(node: WorkflowNodeDef) {
        snapshot()
        _state.update { s -> s.copy(nodes = s.nodes.map { if (it.id == node.id) node else it }) }
    }

    fun removeNode(id: String) {
        snapshot()
        _state.update { s ->
            s.copy(
                nodes = s.nodes.filterNot { it.id == id },
                edges = s.edges.filterNot { it.from == id || it.to == id },
            )
        }
    }

    /** Outcome of a connect attempt, so the editor can surface the right transient notice. */
    enum class ConnectResult { ADDED, DUPLICATE, CYCLE, INVALID }

    /**
     * Connect from→to with an optional [condition] ("fail" = the failure branch, else success/next).
     * Success edges must form a DAG: if `to` can already reach `from` over non-fail edges, adding a
     * success from→to would close a loop, so it's rejected (mirrors iOS). **Fail edges are allowed to
     * loop** (bounded at runtime), so they skip the cycle check. Self-loops and exact duplicates are
     * rejected. Returns the outcome so the UI can explain why nothing happened.
     */
    fun connect(from: String, to: String, condition: String? = null): ConnectResult {
        if (from == to) return ConnectResult.INVALID
        val s = _state.value
        if (s.edges.any { it.from == from && it.to == to && it.condition == condition }) {
            return ConnectResult.DUPLICATE
        }
        if (condition != "fail" && reachesForward(s.edges, source = to, target = from)) {
            return ConnectResult.CYCLE
        }
        snapshot()
        _state.update {
            it.copy(edges = it.edges + WorkflowEdgeDef(id = newId("e"), from = from, to = to, condition = condition))
        }
        return ConnectResult.ADDED
    }

    /** DFS forward reachability over non-fail edges (fail branches are allowed to loop at runtime). */
    private fun reachesForward(edges: List<WorkflowEdgeDef>, source: String, target: String): Boolean {
        if (source == target) return true
        val seen = HashSet<String>()
        val stack = ArrayDeque<String>().apply { addLast(source) }
        while (stack.isNotEmpty()) {
            val cur = stack.removeLast()
            if (!seen.add(cur)) continue
            if (cur == target) return true
            edges.filter { it.condition != "fail" && it.from == cur }.forEach { stack.addLast(it.to) }
        }
        return false
    }

    fun removeEdge(id: String) {
        snapshot()
        _state.update { s -> s.copy(edges = s.edges.filterNot { it.id == id }) }
    }

    /**
     * Insert a new task node in the middle of [edge] (iOS «사이에 노드 추가»): drop the edge, add a
     * task at its midpoint, and re-wire from→new (keeps the original condition) and new→to (success).
     */
    fun insertNodeOnEdge(edge: WorkflowEdgeDef) {
        snapshot()
        _state.update { s ->
            val from = s.nodes.firstOrNull { it.id == edge.from }
            val to = s.nodes.firstOrNull { it.id == edge.to }
            val midX = ((from?.x ?: 0.0) + (to?.x ?: 0.0)) / 2
            val midY = ((from?.y ?: 0.0) + (to?.y ?: 0.0)) / 2
            val node = WorkflowNodeDef(
                id = newId("n"),
                type = "task",
                agent = "claude_code",
                skipPermissions = true,
                x = midX,
                y = midY,
            )
            s.copy(
                nodes = s.nodes + node,
                edges = s.edges.filterNot { it.id == edge.id } +
                    WorkflowEdgeDef(id = newId("e"), from = edge.from, to = node.id, condition = edge.condition) +
                    WorkflowEdgeDef(id = newId("e"), from = node.id, to = edge.to, condition = null),
            )
        }
    }

    fun save() = viewModelScope.launch {
        val s = _state.value
        if (s.repoPath.isBlank()) {
            _state.update { it.copy(error = "repo required") }
            return@launch
        }
        _state.update { it.copy(saving = true, error = null) }
        val req = CreateWorkflowRequest(
            title = s.title.trim().ifEmpty { null },
            repoPath = s.repoPath.trim(),
            nodes = s.nodes,
            edges = s.edges,
            enabled = true,
        )
        try {
            val resp = if (existingId == null) Ps.api.createWorkflow(req)
            else Ps.api.updateWorkflow(existingId!!, req)
            _state.update { it.copy(saving = false, savedId = resp.workflow.id) }
        } catch (e: Throwable) {
            _state.update { it.copy(saving = false, error = e.message ?: "Save failed") }
        }
    }

    companion object {
        /** Match iOS exactly: "n_<8hex>" / "e_<8hex>" (ids are opaque to the daemon; this keeps parity). */
        fun newId(prefix: String): String = "${prefix}_" + java.util.UUID.randomUUID().toString().take(8)
    }
}

/** Run viewer — triggers a run and polls live node state. */
class WorkflowRunViewModel : ViewModel() {

    data class UiState(
        val loading: Boolean = true,
        val runState: WorkflowRunStateResponse? = null,
        val error: String? = null,
    )

    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state.asStateFlow()

    private var pollJob: Job? = null

    /** Start a fresh run of [workflowId] then poll it; or poll an existing [runId]. */
    fun start(workflowId: String?, runId: String?) {
        pollJob?.cancel()
        pollJob = viewModelScope.launch {
            val id = runId ?: try {
                Ps.api.runWorkflow(workflowId!!).runId
            } catch (e: Throwable) {
                _state.update { it.copy(loading = false, error = e.message ?: "Run failed") }
                return@launch
            }
            while (isActive) {
                try {
                    val rs = Ps.api.workflowRunState(id)
                    _state.update { it.copy(loading = false, runState = rs, error = null) }
                    val s = rs.run.status
                    if (s == "done" || s == "failed" || s == "cancelled") {
                        // One final settle poll, then stop hammering.
                        delay(2_000)
                    }
                } catch (e: Throwable) {
                    _state.update { it.copy(loading = false, error = e.message ?: "Poll failed") }
                }
                delay(1_500)
            }
        }
    }

    fun cancel(runId: String) = viewModelScope.launch {
        try {
            Ps.api.cancelWorkflowRun(runId)
        } catch (_: Throwable) {
        }
    }

    fun nodeAction(runId: String, nodeRunId: String, action: String) = viewModelScope.launch {
        try {
            Ps.api.nodeAction(runId, nodeRunId, action)
        } catch (e: Throwable) {
            _state.update { it.copy(error = e.message ?: "Action failed") }
        }
    }

    override fun onCleared() {
        pollJob?.cancel()
    }
}
