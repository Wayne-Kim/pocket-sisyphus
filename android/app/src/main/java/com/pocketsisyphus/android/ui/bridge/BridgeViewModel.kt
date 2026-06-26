package com.pocketsisyphus.android.ui.bridge

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.pocketsisyphus.android.data.BridgeStore
import com.pocketsisyphus.android.data.Ps
import com.pocketsisyphus.android.data.TorBridgeParser
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * Backs the «Tor bridge» bypass screen. The persisted toggle + lines live in [BridgeStore]; this VM
 * owns the editable draft, live validation, and the «save & reconnect» action. obfs4 lines are parsed
 * but flagged unsupported in this build (no PT binary) — mirrors the iOS contract.
 */
class BridgeViewModel(
    private val bridges: BridgeStore = Ps.bridges,
) : ViewModel() {

    data class UiState(
        val enabled: Boolean = false,
        val draft: String = "",
        val saved: String = "",
        val status: BridgeStore.Status = BridgeStore.Status.Idle,
        val likelyBlocked: Boolean = false,
        val reconnecting: Boolean = false,
    ) {
        private val parsed: TorBridgeParser.Result get() = TorBridgeParser.parse(draft)
        val validCount: Int get() = parsed.valid.size
        val invalidCount: Int get() = parsed.invalid.size
        /** Transports we can't dial in this build (everything but vanilla — obfs4 included). */
        val unsupportedTransports: List<String>
            get() = parsed.valid.mapNotNull { it.transportLower }
                .filter { it != "obfs4" || !BridgeStore.obfs4Available }
                .distinct()
        val hasObfs4: Boolean get() = parsed.valid.any { it.transportLower == "obfs4" }
        val dirty: Boolean get() = draft != saved
        /** Reconnect is meaningful only with bridges on and at least one attemptable line. */
        val canReconnect: Boolean
            get() = enabled && parsed.valid.any { line ->
                line.transportLower == null ||
                    (line.transportLower == "obfs4" && BridgeStore.obfs4Available)
            }
    }

    private val _state = MutableStateFlow(
        UiState(
            enabled = bridges.enabled.value,
            draft = bridges.linesText.value,
            saved = bridges.linesText.value,
            status = bridges.status.value,
        )
    )
    val state: StateFlow<UiState> = _state.asStateFlow()

    init {
        viewModelScope.launch { bridges.status.collect { s -> _state.update { it.copy(status = s) } } }
        viewModelScope.launch {
            Ps.tor.likelyBlocked.collect { b -> _state.update { it.copy(likelyBlocked = b) } }
        }
    }

    fun setEnabled(value: Boolean) {
        bridges.setEnabled(value)
        _state.update { it.copy(enabled = value) }
    }

    fun setDraft(value: String) {
        _state.update { it.copy(draft = value) }
    }

    fun save() {
        val text = _state.value.draft
        bridges.setLinesText(text)
        _state.update { it.copy(saved = text) }
    }

    /** Persist the draft (if changed) and retry the whole connection — plaintext first, then bridges. */
    fun saveAndReconnect() {
        if (_state.value.reconnecting) return
        save()
        _state.update { it.copy(reconnecting = true) }
        viewModelScope.launch {
            try {
                Ps.connection.ensureConnected(forceReconnect = true, fullProof = true)
            } catch (_: Throwable) {
                // Failure surfaces through the bridge status / connection state flows.
            } finally {
                _state.update { it.copy(reconnecting = false) }
            }
        }
    }
}
