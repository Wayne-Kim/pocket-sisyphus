package com.pocketsisyphus.android.ui.backlog

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.pocketsisyphus.android.data.Ps
import com.pocketsisyphus.android.data.model.PoBrief
import com.pocketsisyphus.android.data.model.PoCollectRequest
import com.pocketsisyphus.android.data.model.PoDecideRequest
import com.pocketsisyphus.android.data.model.PoBulkDecideRequest
import com.pocketsisyphus.android.data.model.PoResearch
import com.pocketsisyphus.android.data.model.PoResearchRequest
import com.pocketsisyphus.android.data.model.PoStats
import com.pocketsisyphus.android.data.model.appOutputLocaleTag
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * Backlog (PO loop) state — loads briefs + research, starts collect/research with a chosen expert
 * lens, and decides (approve/hold/reject) briefs. The list is grouped by decision status in the UI.
 */
class BacklogViewModel : ViewModel() {

    data class UiState(
        val loading: Boolean = true,
        val briefs: List<PoBrief> = emptyList(),
        val research: List<PoResearch> = emptyList(),
        val error: String? = null,
        /** Distinct repo paths from existing sessions — the create flow's "recent projects". */
        val recentRepos: List<String> = emptyList(),
        /** Collect/research submit in flight. */
        val starting: Boolean = false,
        /** A collect/research just started → banner offering to open the watch session. */
        val startedSessionId: String? = null,
        val startedMessageRes: Int? = null,
        /** Brief id whose decision is in flight (row shows a spinner). */
        val decideBusyId: String? = null,
        /** Cumulative scorecard (po_stats_v1); null when unsupported / not loaded. */
        val stats: PoStats? = null,
        /** Triage bulk decision in flight. */
        val triageBusy: Boolean = false,
    ) {
        val proposed: List<PoBrief>
            get() = briefs.filter { it.isProposed }.sortedWith(
                compareByDescending<PoBrief> { it.impact }.thenByDescending { it.score }
                    .thenByDescending { it.createdAt },
            )
        val active: List<PoBrief> get() = briefs.filter { it.isActive }.sortedByDescending { it.updatedAt }
        val shipped: List<PoBrief> get() = briefs.filter { it.isShipped }.sortedByDescending { it.updatedAt }
        val settled: List<PoBrief> get() = briefs.filter { it.isSettled }.sortedByDescending { it.updatedAt }
        val isEmpty: Boolean get() = briefs.isEmpty() && research.isEmpty()
    }

    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state.asStateFlow()

    init {
        refresh()
    }

    fun refresh() = viewModelScope.launch {
        try {
            val briefsD = async { Ps.api.listPoBriefs().briefs }
            val researchD = async { runCatching { Ps.api.listPoResearch().research }.getOrDefault(emptyList()) }
            val reposD = async { runCatching { recentReposFromSessions() }.getOrDefault(emptyList()) }
            val statsD = async { runCatching { Ps.api.getPoStats() }.getOrNull() }
            _state.update {
                it.copy(
                    loading = false,
                    briefs = briefsD.await(),
                    research = researchD.await(),
                    recentRepos = reposD.await(),
                    stats = statsD.await(),
                    error = null,
                )
            }
        } catch (e: Throwable) {
            _state.update { it.copy(loading = false, error = e.message ?: "Failed to load") }
        }
    }

    private suspend fun recentReposFromSessions(): List<String> =
        Ps.api.listSessions().sessions
            .map { it.repoPath }
            .filter { it.isNotBlank() }
            .distinct()
            .take(12)

    /** Start "내 레포 안" signal collection through [lens] ("default"/null = all-around). */
    fun startCollect(repoPath: String, instruction: String?, lens: String?, agent: String? = null) = viewModelScope.launch {
        _state.update { it.copy(starting = true, error = null) }
        try {
            val resp = Ps.api.startPoCollection(
                PoCollectRequest(
                    repoPath = repoPath.trim(),
                    instruction = instruction?.trim()?.ifBlank { null },
                    agent = agent,
                    lens = lens?.takeIf { it != "default" },
                    locale = appOutputLocaleTag(),
                ),
            )
            _state.update {
                it.copy(
                    starting = false,
                    startedSessionId = resp.sessionId.ifBlank { null },
                    startedMessageRes = com.pocketsisyphus.android.R.string.backlog_collect_started,
                )
            }
            refresh()
        } catch (e: Throwable) {
            _state.update { it.copy(starting = false, error = e.message ?: "Failed to start") }
        }
    }

    /** Start "시장 조사" research through [lens]; scope/screens omitted when not chosen. */
    fun startResearch(
        repoPath: String,
        topic: String,
        lens: String?,
        scope: String?,
        screens: Boolean?,
        agent: String? = null,
    ) = viewModelScope.launch {
        _state.update { it.copy(starting = true, error = null) }
        try {
            val resp = Ps.api.startPoResearch(
                PoResearchRequest(
                    repoPath = repoPath.trim(),
                    topic = topic.trim(),
                    agent = agent,
                    lens = lens?.takeIf { it != "default" },
                    scope = scope,
                    screens = screens,
                    locale = appOutputLocaleTag(),
                ),
            )
            _state.update {
                it.copy(
                    starting = false,
                    startedSessionId = resp.sessionId.ifBlank { null },
                    startedMessageRes = com.pocketsisyphus.android.R.string.backlog_research_started,
                )
            }
            refresh()
        } catch (e: Throwable) {
            _state.update { it.copy(starting = false, error = e.message ?: "Failed to start") }
        }
    }

    /**
     * Decide a brief. `approve` spawns an implementation session — [onApproved] gets its id so the
     * caller can deep-link into the session tab.
     */
    fun decide(
        briefId: String,
        action: String,
        reason: String? = null,
        useWorktree: Boolean? = null,
        mode: String? = null,
        agent: String? = null,
        onApproved: (String) -> Unit = {},
    ) = viewModelScope.launch {
        _state.update { it.copy(decideBusyId = briefId, error = null) }
        try {
            val resp = Ps.api.decidePoBrief(
                briefId,
                PoDecideRequest(
                    action = action,
                    useWorktree = useWorktree,
                    agent = agent,
                    mode = mode,
                    reason = reason,
                    locale = appOutputLocaleTag(),
                ),
            )
            _state.update { it.copy(decideBusyId = null) }
            resp.execSessionId?.takeIf { it.isNotBlank() }?.let(onApproved)
            refresh()
        } catch (e: Throwable) {
            _state.update { it.copy(decideBusyId = null, error = e.message ?: "Failed") }
        }
    }

    /** Triage — bulk hold/reject the selected proposed briefs in one call. */
    fun bulkDecide(ids: List<String>, action: String, onDone: () -> Unit = {}) = viewModelScope.launch {
        if (ids.isEmpty()) return@launch
        _state.update { it.copy(triageBusy = true, error = null) }
        try {
            Ps.api.bulkDecidePoBriefs(PoBulkDecideRequest(ids = ids, action = action))
            _state.update { it.copy(triageBusy = false) }
            onDone()
            refresh()
        } catch (e: Throwable) {
            _state.update { it.copy(triageBusy = false, error = e.message ?: "Failed") }
        }
    }

    /** Reject a brief and immediately spawn a «clean up code traces» session (po_cleanup_v1). */
    fun rejectAndCleanup(briefId: String, reason: String?, agent: String?) = viewModelScope.launch {
        _state.update { it.copy(decideBusyId = briefId, error = null) }
        try {
            Ps.api.decidePoBrief(
                briefId,
                PoDecideRequest(action = "reject", reason = reason, locale = appOutputLocaleTag()),
            )
            Ps.api.cleanupPoBrief(briefId, agent)
            _state.update { it.copy(decideBusyId = null) }
            refresh()
        } catch (e: Throwable) {
            _state.update { it.copy(decideBusyId = null, error = e.message ?: "Failed") }
        }
    }

    /** Spawn a standalone «clean up code traces» session for an already-rejected brief. */
    fun cleanup(briefId: String, agent: String?, onSession: (String) -> Unit = {}) = viewModelScope.launch {
        try {
            val resp = Ps.api.cleanupPoBrief(briefId, agent)
            resp.sessionId?.takeIf { it.isNotBlank() }?.let(onSession)
            refresh()
        } catch (e: Throwable) {
            _state.update { it.copy(error = e.message ?: "Failed") }
        }
    }

    /** Re-synthesize a brief from a revise instruction (po revise) — sets revisingSessionId. */
    fun revise(briefId: String, comment: String, onDone: () -> Unit = {}) = viewModelScope.launch {
        try {
            Ps.api.revisePoBrief(briefId, comment.trim())
            onDone()
            refresh()
        } catch (e: Throwable) {
            _state.update { it.copy(error = e.message ?: "Failed") }
        }
    }

    fun deleteBrief(briefId: String) = viewModelScope.launch {
        try {
            Ps.api.deletePoBrief(briefId)
            refresh()
        } catch (e: Throwable) {
            _state.update { it.copy(error = e.message ?: "Failed to delete") }
        }
    }

    fun briefById(id: String): PoBrief? = _state.value.briefs.firstOrNull { it.id == id }

    fun clearStarted() = _state.update { it.copy(startedSessionId = null, startedMessageRes = null) }
    fun clearError() = _state.update { it.copy(error = null) }
}
