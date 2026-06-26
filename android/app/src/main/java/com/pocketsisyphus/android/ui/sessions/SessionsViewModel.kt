package com.pocketsisyphus.android.ui.sessions

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.pocketsisyphus.android.R
import com.pocketsisyphus.android.data.Ps
import com.pocketsisyphus.android.data.model.CreateSessionRequest
import com.pocketsisyphus.android.data.model.RunState
import com.pocketsisyphus.android.data.model.SessionRow
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

class SessionsViewModel : ViewModel() {

    enum class Filter(val labelRes: Int) {
        ALL(R.string.session_filter_all),
        RUNNING(R.string.session_filter_running),
        WAITING(R.string.session_filter_waiting),
        DONE(R.string.session_filter_done),
    }

    data class UiState(
        val loading: Boolean = true,
        val sessions: List<SessionRow> = emptyList(),
        val error: String? = null,
        val filter: Filter = Filter.ALL,
        val query: String = "",
        val creating: Boolean = false,
    ) {
        val visible: List<SessionRow>
            get() {
                val q = query.trim().lowercase()
                return sessions
                    .asSequence()
                    .filter { !it.isWorkflowSession } // workflow sessions live in their own surface.
                    .filter { it.isArchived.not() }
                    .filter {
                        when (filter) {
                            Filter.ALL -> true
                            Filter.RUNNING -> it.runState == RunState.RUNNING
                            Filter.WAITING -> it.runState == RunState.WAITING
                            Filter.DONE -> it.runState == RunState.DONE
                        }
                    }
                    .filter {
                        q.isEmpty() ||
                            (it.title?.lowercase()?.contains(q) == true) ||
                            it.repoPath.lowercase().contains(q)
                    }
                    .sortedWith(
                        compareBy<SessionRow> { it.runState.ordinal } // WAITING(0) < RUNNING(1) < DONE(2)
                            .thenByDescending { it.lastActivity ?: it.createdAt },
                    )
                    .toList()
            }

        val waitingCount: Int get() = sessions.count { it.runState == RunState.WAITING && !it.isWorkflowSession }
    }

    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state.asStateFlow()

    init {
        viewModelScope.launch {
            while (isActive) {
                refreshOnce()
                delay(POLL_INTERVAL_MS)
            }
        }
    }

    fun setFilter(f: Filter) = _state.update { it.copy(filter = f) }
    fun setQuery(q: String) = _state.update { it.copy(query = q) }

    fun refresh() = viewModelScope.launch { refreshOnce() }

    private suspend fun refreshOnce() {
        try {
            val resp = Ps.api.listSessions()
            _state.update { it.copy(loading = false, sessions = resp.sessions, error = null) }
        } catch (e: Throwable) {
            _state.update { it.copy(loading = false, error = e.message ?: "Failed to load sessions") }
        }
    }

    fun createSession(repoPath: String, title: String?, agent: String, onCreated: (String, String) -> Unit) {
        viewModelScope.launch {
            _state.update { it.copy(creating = true, error = null) }
            try {
                val resp = Ps.api.createSession(
                    CreateSessionRequest(
                        repoPath = repoPath.trim(),
                        title = title?.trim()?.ifEmpty { null },
                        agent = agent,
                    ),
                )
                _state.update { it.copy(creating = false) }
                refreshOnce()
                val display = title?.trim()?.ifEmpty { null }
                    ?: repoPath.trim().trimEnd('/').substringAfterLast('/')
                onCreated(resp.sessionId, display)
            } catch (e: Throwable) {
                _state.update { it.copy(creating = false, error = e.message ?: "Failed to create session") }
            }
        }
    }

    companion object {
        private const val POLL_INTERVAL_MS = 5_000L
    }
}
