package com.pocketsisyphus.android.ui.sessions

import com.pocketsisyphus.android.data.Ps
import com.pocketsisyphus.android.data.model.SessionRow
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * Approval-inbox state machine — mirrors the iOS `ApprovalReviewModel`.
 *
 * Collects the sessions currently waiting for approval into one surface and lets the user
 * approve (Enter) or reject (ESC) each one without opening its terminal — individually or as a
 * selected batch. Sends are serial; a single failure leaves the rest untouched (partial success),
 * and a failed row stays actionable so the user can retry.
 *
 * Framework-free on purpose (no Android types, injectable [send] + [scope]) so the transition,
 * selection, reconcile, and finish logic are unit-testable without the network or a ViewModel.
 */
class ApprovalInbox(
    initial: List<SessionRow>,
    private val scope: CoroutineScope,
    private val onFinished: () -> Unit = {},
    private val send: suspend (sessionId: String, action: String) -> Boolean = { id, action ->
        runCatching { Ps.api.ptyControl(id, action) }.isSuccess
    },
) {
    /** Per-request processing state — pending · approving · approved · rejecting · rejected · failed. */
    enum class RowStatus { PENDING, APPROVING, APPROVED, REJECTING, REJECTED, FAILED }

    data class Item(
        val session: SessionRow,
        // Default-select everything — «deselect to skip» is faster and safer than opt-in batch approve.
        val selected: Boolean = true,
        val status: RowStatus = RowStatus.PENDING,
    ) {
        val id: String get() = session.id

        /** Actionable — still waiting, or failed and retryable. */
        val actionable: Boolean get() = status == RowStatus.PENDING || status == RowStatus.FAILED
    }

    data class UiState(
        val items: List<Item> = emptyList(),
        // A serial approve/reject is in flight — gates buttons + spinner.
        val busy: Boolean = false,
        // One or more actionable rows vanished from the live waiting set (handled on another device).
        val externallyResolved: Boolean = false,
        // No actionable rows remain — the host can dismiss and refresh.
        val finished: Boolean = false,
    ) {
        val hasActionable: Boolean get() = items.any { it.actionable }
        val selectedActionableCount: Int get() = items.count { it.actionable && it.selected }
    }

    private val _state = MutableStateFlow(UiState(items = initial.map { Item(it) }))
    val state: StateFlow<UiState> = _state.asStateFlow()

    /**
     * Reconcile against the live set of still-waiting session ids. Any actionable row whose session
     * is no longer waiting (already approved/rejected elsewhere) is silently dropped with a notice.
     * Rows already approved/rejected locally are kept so their result badge stays visible.
     */
    fun reconcile(liveWaitingIds: Set<String>) {
        _state.update { st ->
            val removedActionable = st.items.any { it.actionable && it.id !in liveWaitingIds }
            val kept = st.items.filter { !it.actionable || it.id in liveWaitingIds }
            if (!removedActionable && kept.size == st.items.size) return@update st
            st.copy(
                items = kept,
                externallyResolved = st.externallyResolved || removedActionable,
            ).withFinishFlag()
        }
    }

    fun toggleSelect(id: String) {
        _state.update { st ->
            val i = st.items.indexOfFirst { it.id == id }
            if (i < 0 || !st.items[i].actionable) return@update st
            st.copy(items = st.items.mapIndexed { idx, it -> if (idx == i) it.copy(selected = !it.selected) else it })
        }
    }

    /**
     * Approve — send Enter to every actionable row (or only the selected ones). Each row transitions
     * approving → approved/failed serially; the rest continue even if one fails.
     */
    fun approve(selectedOnly: Boolean) {
        val targets = _state.value.items
            .filter { it.actionable && (!selectedOnly || it.selected) }
            .map { it.id }
        if (targets.isEmpty()) return
        scope.launch {
            setBusy(true)
            for (id in targets) {
                setStatus(id, RowStatus.APPROVING)
                val ok = send(id, ACTION_APPROVE)
                setStatus(id, if (ok) RowStatus.APPROVED else RowStatus.FAILED)
            }
            setBusy(false)
            evaluateFinish()
        }
    }

    /** Approve a single row — send Enter to just this request. approving → approved/failed. */
    fun approveOne(id: String) {
        if (_state.value.items.none { it.id == id && it.actionable }) return
        scope.launch {
            setStatus(id, RowStatus.APPROVING)
            val ok = send(id, ACTION_APPROVE)
            setStatus(id, if (ok) RowStatus.APPROVED else RowStatus.FAILED)
            evaluateFinish()
        }
    }

    /** Reject one row — send ESC (interrupt the waiting turn). rejecting → rejected/failed. */
    fun reject(id: String) {
        if (_state.value.items.none { it.id == id && it.actionable }) return
        scope.launch {
            setStatus(id, RowStatus.REJECTING)
            val ok = send(id, ACTION_INTERRUPT)
            setStatus(id, if (ok) RowStatus.REJECTED else RowStatus.FAILED)
            evaluateFinish()
        }
    }

    private fun setBusy(busy: Boolean) = _state.update { it.copy(busy = busy) }

    private fun setStatus(id: String, status: RowStatus) {
        _state.update { st ->
            st.copy(items = st.items.map { if (it.id == id) it.copy(status = status) else it })
        }
    }

    private fun evaluateFinish() = _state.update { it.withFinishFlag() }

    private fun UiState.withFinishFlag(): UiState {
        val finished = items.isNotEmpty() && !hasActionable
        if (finished && !this.finished) onFinished()
        return copy(finished = finished)
    }

    companion object {
        const val ACTION_APPROVE = "approve"   // Enter — confirm the highlighted permission choice.
        const val ACTION_INTERRUPT = "interrupt" // ESC — interrupt the waiting/in-progress turn.
    }
}
