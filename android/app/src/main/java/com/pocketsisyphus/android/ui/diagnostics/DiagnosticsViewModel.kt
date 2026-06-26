package com.pocketsisyphus.android.ui.diagnostics

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.pocketsisyphus.android.data.ConnectionManager.Stage
import com.pocketsisyphus.android.data.ConnectionManager.StageStatus
import com.pocketsisyphus.android.data.Ps
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * Drives the walking-skeleton proof and surfaces every stage for the diagnostic screen:
 * the transport stages owned by [com.pocketsisyphus.android.data.ConnectionManager] (pairing →
 * direct/Tor → endpoint → SSH → health) plus the attestation + first-authed-API stages here.
 */
class DiagnosticsViewModel : ViewModel() {

    data class UiState(
        val running: Boolean = false,
        val transport: Map<Stage, StageStatus> = Stage.entries.associateWith { StageStatus.PENDING },
        val attest: StageStatus = StageStatus.PENDING,
        val api: StageStatus = StageStatus.PENDING,
        val channel: String? = null,
        val detail: String? = null,
        val error: String? = null,
        val done: Boolean = false,
        /** Plaintext Tor bootstrap stalled → Tor looks blocked; surfaces the «set up a bridge» card. */
        val likelyBlocked: Boolean = false,
    ) {
        val overallOk: Boolean get() = api == StageStatus.SUCCESS
    }

    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state.asStateFlow()

    init {
        // Mirror the live transport stages from the connection manager.
        viewModelScope.launch {
            Ps.connection.skeleton.collect { sk ->
                _state.update { it.copy(transport = sk.statuses, channel = sk.channel, detail = sk.detail) }
            }
        }
        // Surface «Tor likely blocked» so the screen can offer the bridge bypass.
        viewModelScope.launch {
            Ps.tor.likelyBlocked.collect { b -> _state.update { it.copy(likelyBlocked = b) } }
        }
    }

    fun run() {
        if (_state.value.running) return
        _state.update {
            it.copy(
                running = true,
                attest = StageStatus.PENDING,
                api = StageStatus.PENDING,
                error = null,
                done = false,
            )
        }
        viewModelScope.launch {
            try {
                // 1–6. Full skeleton: Tor bootstrap + /endpoint + happy-eyeballs SSH + health.
                Ps.connection.ensureConnected(forceReconnect = true, fullProof = true)

                // 7. Device attestation (enroll + challenge-response → attest token).
                _state.update { it.copy(attest = StageStatus.RUNNING) }
                Ps.attest.ensureToken(force = true)
                _state.update { it.copy(attest = StageStatus.SUCCESS) }

                // 8. First authed API calls — both must return 200.
                _state.update { it.copy(api = StageStatus.RUNNING) }
                Ps.api.version()
                Ps.api.listSessions()
                _state.update { it.copy(api = StageStatus.SUCCESS, done = true, running = false) }
            } catch (e: Throwable) {
                _state.update {
                    val attest = if (it.attest == StageStatus.RUNNING) StageStatus.FAILED else it.attest
                    val api = if (it.api == StageStatus.RUNNING) StageStatus.FAILED else it.api
                    it.copy(
                        attest = attest,
                        api = api,
                        error = e.message ?: "Connection failed",
                        running = false,
                        done = true,
                    )
                }
            }
        }
    }
}
