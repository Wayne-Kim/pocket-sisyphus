package com.pocketsisyphus.android.ui.session

import android.util.Base64
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.pocketsisyphus.android.data.Ps
import com.pocketsisyphus.android.data.WsClient
import com.pocketsisyphus.android.data.WsEvent
import com.pocketsisyphus.android.data.model.GitFile
import com.pocketsisyphus.android.data.model.MessageRow
import com.pocketsisyphus.android.data.model.PsJson
import com.pocketsisyphus.android.data.model.PtyChunkPayload
import com.pocketsisyphus.android.data.model.SessionRow
import com.pocketsisyphus.android.terminal.TermFrame
import com.pocketsisyphus.android.terminal.TerminalEmulator
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

class SessionDetailViewModel : ViewModel() {

    data class UiState(
        val title: String = "",
        val branch: String? = null,
        val changedFiles: List<GitFile> = emptyList(),
        val awaitingUser: Boolean = false,
        val connected: Boolean = false,
        val ended: Boolean = false,
        val banner: String? = null,
        val sending: Boolean = false,
        val uploading: Boolean = false,
    ) {
        val changedCount: Int get() = changedFiles.size
    }

    private val emu = TerminalEmulator(cols = 80, rows = 24)
    private val emuLock = Any()
    private val seen = HashSet<String>()
    private var lastCreatedAt = 0L
    private var awaitingReply = false

    private val _frame = MutableStateFlow<TermFrame?>(null)
    val frame: StateFlow<TermFrame?> = _frame.asStateFlow()

    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state.asStateFlow()

    private var sessionId: String = ""
    private var ws: WsClient? = null
    private var started = false
    private val jobs = mutableListOf<Job>()

    fun start(id: String, initialTitle: String) {
        if (started) return
        started = true
        sessionId = id
        _state.update { it.copy(title = initialTitle) }

        // Cold entry → live stream, then keep redrawing/polling/git in parallel.
        jobs += viewModelScope.launch { coldLoad() }
        jobs += viewModelScope.launch { renderLoop() }
        jobs += viewModelScope.launch { pollLoop() }
        jobs += viewModelScope.launch { gitLoop() }
        jobs += viewModelScope.launch { wsLoop() }
    }

    fun stop() {
        ws?.sendVisibility(false)
        jobs.forEach { it.cancel() }
        jobs.clear()
        started = false
    }

    /** Rename this session (session_rename_v1) — optimistic title update; revert + banner on failure. */
    fun rename(title: String) {
        val t = title.trim()
        val prev = _state.value.title
        _state.update { it.copy(title = t) }
        viewModelScope.launch {
            try {
                Ps.api.renameSession(sessionId, t)
            } catch (e: Throwable) {
                _state.update { it.copy(title = prev, banner = e.message ?: "rename failed") }
            }
        }
    }

    override fun onCleared() {
        stop()
    }

    // ── cold load ────────────────────────────────────────────────────────────

    private suspend fun coldLoad() {
        try {
            val snap = Ps.api.snapshot(sessionId)
            synchronized(emuLock) {
                emu.resize(snap.cols, snap.rows)
                emu.clear()
                emu.feed(snap.snapshot)
            }
            lastCreatedAt = snap.throughCreatedAt
        } catch (_: Throwable) {
            // Old daemon / no snapshot — fall back to a full cold poll below.
        }
        try {
            val resp = Ps.api.poll(sessionId, afterCreatedAt = lastCreatedAt.takeIf { it > 0 }, limit = 400)
            applySession(resp.session)
            applyMessages(resp.messages)
            lastCreatedAt = maxOf(lastCreatedAt, resp.nextCreatedAt)
        } catch (_: Throwable) {
        }
        _frame.value = synchronized(emuLock) { emu.frame() }
    }

    // ── render coalescing (decouples feed rate from recomposition) ─────────────

    private suspend fun renderLoop() {
        while (viewModelScope.isActive) {
            delay(50)
            if (synchronized(emuLock) { emu.isDirty() }) {
                _frame.value = synchronized(emuLock) { emu.frame() }
            }
        }
    }

    // ── WebSocket live stream ──────────────────────────────────────────────────

    private suspend fun wsLoop() {
        val client = WsClient(Ps.connection, Ps.attest)
        ws = client
        client.open(sessionId, since = { lastCreatedAt }).collect { ev ->
            when (ev) {
                is WsEvent.Connected -> {
                    _state.update { it.copy(connected = true, banner = null) }
                    client.sendVisibility(true)
                }
                is WsEvent.PtyOutput -> {
                    if (ev.id.isEmpty() || seen.add(ev.id)) {
                        feedB64(ev.bytesB64)
                        // any output clears the "awaiting" hint until the next turn_complete
                        if (_state.value.awaitingUser) _state.update { it.copy(awaitingUser = false) }
                    }
                }
                is WsEvent.TurnComplete -> {
                    awaitingReply = false
                    _state.update { it.copy(awaitingUser = true) }
                }
                is WsEvent.PtyExit -> _state.update { it.copy(ended = true) }
                is WsEvent.Subscribed -> {}
                is WsEvent.SessionEvent -> {} // session-scoped socket ignores global events
                is WsEvent.Disconnected -> _state.update {
                    it.copy(connected = false, banner = if (ev.fatal) "Disconnected — re-pair needed" else null)
                }
                is WsEvent.ScreenStatus, is WsEvent.ScreenJpeg -> {} // mirroring-only events
            }
        }
    }

    // ── polling fallback (also drives awaiting state from server truth) ────────

    private suspend fun pollLoop() {
        while (viewModelScope.isActive) {
            delay(if (awaitingReply) 2_000 else 12_000)
            try {
                val resp = Ps.api.poll(sessionId, afterCreatedAt = lastCreatedAt, limit = null)
                applySession(resp.session)
                applyMessages(resp.messages)
                lastCreatedAt = maxOf(lastCreatedAt, resp.nextCreatedAt)
            } catch (_: Throwable) {
            }
        }
    }

    private suspend fun gitLoop() {
        while (viewModelScope.isActive) {
            try {
                val branch = Ps.api.gitBranch(sessionId).branch
                val status = Ps.api.gitStatus(sessionId).files
                _state.update { it.copy(branch = branch, changedFiles = status) }
            } catch (_: Throwable) {
            }
            delay(5_000)
        }
    }

    // ── input ──────────────────────────────────────────────────────────────────

    fun sendMessage(text: String) {
        if (text.isBlank()) return
        awaitingReply = true
        _state.update { it.copy(sending = true, awaitingUser = false) }
        viewModelScope.launch {
            try {
                Ps.api.sendMessage(sessionId, text)
                _state.update { it.copy(sending = false, banner = null) }
            } catch (e: Throwable) {
                _state.update { it.copy(sending = false, banner = e.message ?: "Send failed") }
            }
        }
    }

    /**
     * Upload pending images to the session repo and return their saved repo-relative paths.
     * Toggles `uploading` so the input row can disable Send + show progress, and clears any prior
     * banner on success. Throws on failure so the caller can keep the attachments for a retry.
     */
    suspend fun uploadImages(images: List<PendingImage>): List<String> {
        if (images.isEmpty()) return emptyList()
        _state.update { it.copy(uploading = true, banner = null) }
        try {
            val resp = Ps.api.uploadAttachments(sessionId, dir = null, images = images.map { it.toUpload() })
            return resp.saved.map { it.rel }
        } finally {
            _state.update { it.copy(uploading = false) }
        }
    }

    /** Surface an upload/send error in the shared danger banner (retry = send again). */
    fun setBanner(message: String?) {
        _state.update { it.copy(banner = message) }
    }

    fun control(action: String) {
        awaitingReply = true
        viewModelScope.launch { runCatching { Ps.api.ptyControl(sessionId, action) } }
    }

    /** Arrow / scroll keys — daemon-side ANSI translation (whitelist: up/down/left/right/scroll_*). */
    fun key(k: String) {
        viewModelScope.launch { runCatching { Ps.api.ptyKey(sessionId, k) } }
    }

    /**
     * Raw keystroke bytes → the PTY over the live WS (the primary keyboard-simulation path, like the
     * iPhone). Used for literal keys (ESC/Tab/Enter/Space/«/»/Backspace) the 6-key HTTP whitelist
     * can't express. No-op if the socket isn't up yet.
     */
    fun sendBytes(bytes: ByteArray) {
        val b64 = Base64.encodeToString(bytes, Base64.NO_WRAP)
        ws?.sendPtyInput(sessionId, b64)
    }

    /** Kill the REPL and bring up a fresh terminal. */
    fun restartTerminal() {
        viewModelScope.launch { runCatching { Ps.api.restartPty(sessionId) } }
    }

    /** Permanently delete this session, then run [onDone] (navigate away). */
    fun deleteSession(onDone: () -> Unit) {
        viewModelScope.launch {
            runCatching { Ps.api.deleteSession(sessionId) }
            onDone()
        }
    }

    // ── helpers ──────────────────────────────────────────────────────────────────

    private fun applySession(s: SessionRow) {
        _state.update {
            it.copy(
                title = s.title?.takeIf { t -> t.isNotBlank() } ?: it.title,
                awaitingUser = s.isAwaitingUser,
                ended = it.ended || s.endedAt != null || s.status == "completed" || s.status == "error",
            )
        }
        if (s.isAwaitingUser) awaitingReply = false
    }

    private fun applyMessages(messages: List<MessageRow>) {
        for (m in messages) {
            if (!seen.add(m.id)) continue
            when (m.type) {
                "pty_chunk" -> {
                    val b64 = runCatching {
                        PsJson.decodeFromString(PtyChunkPayload.serializer(), m.payload).bytesB64
                    }.getOrNull()
                    if (!b64.isNullOrEmpty()) feedB64(b64)
                }
                "pty_exit" -> _state.update { it.copy(ended = true) }
            }
        }
    }

    private fun feedB64(b64: String) {
        val bytes = runCatching { Base64.decode(b64, Base64.DEFAULT) }.getOrNull() ?: return
        synchronized(emuLock) { emu.feed(bytes) }
    }
}
