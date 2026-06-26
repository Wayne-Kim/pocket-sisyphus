package com.pocketsisyphus.android.ui.pairing

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.pocketsisyphus.android.data.Ps
import com.pocketsisyphus.android.data.model.PairPayload
import com.pocketsisyphus.android.data.model.PsJson
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

class PairingViewModel : ViewModel() {

    enum class Phase { Idle, Connecting, Connected }

    /** Typed parse outcomes so the screen can render a localized message. */
    enum class PairError { NotPayload, Outdated, Unusable, Connect }

    data class UiState(
        val pasteText: String = "",
        val hostOverride: String = "",
        val parsed: PairPayload? = null,
        val phase: Phase = Phase.Idle,
        val error: PairError? = null,
        val connectError: String? = null,
    ) {
        val canConnect: Boolean
            get() = (parsed?.isUsable == true) && (parsed.isSupportedVersion) &&
                (hostOverride.isNotBlank() || !parsed.lanHost.isNullOrBlank() ||
                    parsed.onion.isNotBlank()) &&
                phase != Phase.Connecting
    }

    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state.asStateFlow()

    fun onPasteChange(text: String) {
        _state.update { it.copy(pasteText = text, error = null, connectError = null) }
        parse(text)
    }

    fun onHostChange(host: String) {
        _state.update { it.copy(hostOverride = host, error = null) }
    }

    /** From the QR scanner: ingest the raw payload and prefill the host from `lan_host`. */
    fun onScanned(raw: String) {
        _state.update { it.copy(pasteText = raw, error = null, connectError = null) }
        val p = parse(raw)
        if (p != null && _state.value.hostOverride.isBlank()) {
            _state.update { it.copy(hostOverride = p.lanHost.orEmpty()) }
        }
    }

    private fun parse(text: String): PairPayload? {
        val trimmed = text.trim()
        if (trimmed.isEmpty()) {
            _state.update { it.copy(parsed = null, error = null) }
            return null
        }
        val p = runCatching { PsJson.decodeFromString(PairPayload.serializer(), trimmed) }.getOrNull()
        _state.update {
            when {
                p == null -> it.copy(parsed = null, error = PairError.NotPayload)
                // Reject pre-v3 QR: the older formats lack the SSH keypair the daemon's sshd
                // requires, so the channel can't stand. Tell the user to update the Mac app + re-pair.
                !p.isSupportedVersion -> it.copy(parsed = p, error = PairError.Outdated)
                !p.isUsable -> it.copy(parsed = p, error = PairError.Unusable)
                else -> it.copy(
                    parsed = p,
                    error = null,
                    hostOverride = if (it.hostOverride.isBlank()) p.lanHost.orEmpty() else it.hostOverride,
                )
            }
        }
        return p
    }

    fun connect(onConnected: () -> Unit) {
        val s = _state.value
        val payload = s.parsed ?: return
        if (!payload.isSupportedVersion || !payload.isUsable) return
        viewModelScope.launch {
            _state.update { it.copy(phase = Phase.Connecting, error = null, connectError = null) }
            Ps.pairStore.save(payload, s.hostOverride.takeIf { it.isNotBlank() })
            try {
                Ps.connection.ensureConnected(forceReconnect = true)
                // Enroll this device + obtain an attest token now, so a "no device slot" problem
                // is surfaced here rather than as a confusing empty session list.
                Ps.attest.ensureToken(force = true)
                _state.update { it.copy(phase = Phase.Connected) }
                onConnected()
            } catch (e: Throwable) {
                _state.update {
                    it.copy(phase = Phase.Idle, connectError = e.message ?: "Connection failed")
                }
            }
        }
    }
}
