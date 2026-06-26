package com.pocketsisyphus.android.ui.mirror

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Base64
import android.view.Surface
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.pocketsisyphus.android.data.Ps
import com.pocketsisyphus.android.data.WsClient
import com.pocketsisyphus.android.data.WsEvent
import com.pocketsisyphus.android.mirror.H264Decoder
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * Drives the Android side of Mac screen mirroring. Subscribes to the daemon's desktop screen stream
 * (`screen_capture_v1`/`screen_h264_v1`), decodes H.264 to a [Surface] (JPEG fallback), and exposes a
 * single [UiState] the screen renders: connection/stream status, video aspect, last error.
 *
 * Capture is session-independent (the Mac screen, not a session) so we use a fixed routing key —
 * the daemon treats `sessionId` purely as a fan-out key and never validates it.
 */
class ScreenMirrorViewModel : ViewModel() {

    enum class Status {
        /** Socket up / capture requested, no first frame yet. */
        CONNECTING,

        /** Frames flowing. */
        LIVE,

        /** Was live but no frame for a while (low bandwidth / backgrounded Mac). */
        STALLED,

        /** User paused mirroring. */
        PAUSED,

        /** Mac screen-recording permission not granted — needs action on the Mac. */
        PERMISSION_NEEDED,

        /** Socket lost / fatal pairing error. */
        DISCONNECTED,
    }

    data class UiState(
        val status: Status = Status.CONNECTING,
        val videoWidth: Int = 0,
        val videoHeight: Int = 0,
        /** True while serving the JPEG fallback path (no hardware H.264). */
        val usingJpeg: Boolean = false,
        /** Latest JPEG fallback frame, if any. */
        val jpegFrame: Bitmap? = null,
        /** Fatal pairing loss — re-pair needed. */
        val fatal: Boolean = false,
        /** Remote control mode (forward taps/scroll/keys to the Mac). */
        val controlEnabled: Boolean = false,
    ) {
        val videoAspect: Float
            get() = if (videoWidth > 0 && videoHeight > 0) videoWidth.toFloat() / videoHeight else 16f / 9f
    }

    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state.asStateFlow()

    private val decoder = H264Decoder(
        onVideoSize = { w, h -> _state.update { it.copy(videoWidth = w, videoHeight = h) } },
        onFirstFrame = {
            lastFrameAt = System.currentTimeMillis()
            markLive()
        },
        onError = { onDecodeError() },
    )

    private var ws: WsClient? = null
    private val jobs = mutableListOf<Job>()
    private var started = false

    /** User intent — when true we keep the stream stopped even on (re)connect/foreground. */
    @Volatile private var paused = false

    /** App in foreground — backgrounding stops the stream to save battery/bandwidth. */
    @Volatile private var foreground = true

    /** Once H.264 decode fails we stay on JPEG to avoid a configure/fail loop. */
    @Volatile private var h264Failed = false

    @Volatile private var lastFrameAt = 0L

    fun start() {
        if (started) return
        started = true
        jobs += viewModelScope.launch { wsLoop() }
        jobs += viewModelScope.launch { stallLoop() }
    }

    override fun onCleared() {
        ws?.sendCaptureStop(DESKTOP_SESSION_ID)
        jobs.forEach { it.cancel() }
        jobs.clear()
        decoder.release()
        _state.value.jpegFrame?.recycle()
        started = false
    }

    /** The mirror surface from the TextureView (or null when it's torn down). */
    fun setSurface(surface: Surface?) = decoder.setSurface(surface)

    fun togglePause() {
        if (paused) resume() else pause()
    }

    private fun pause() {
        paused = true
        ws?.sendCaptureStop(DESKTOP_SESSION_ID)
        _state.update { it.copy(status = Status.PAUSED) }
    }

    private fun resume() {
        paused = false
        h264Failed = false
        decoder.reset()
        _state.update { it.copy(status = Status.CONNECTING) }
        requestCapture()
    }

    /** Lifecycle hooks from the screen. */
    fun onForeground() {
        foreground = true
        ws?.sendVisibility(true)
        if (!paused) {
            decoder.reset()
            _state.update { if (it.status != Status.PAUSED) it.copy(status = Status.CONNECTING) else it }
            requestCapture()
        }
    }

    fun onBackground() {
        foreground = false
        ws?.sendVisibility(false)
        ws?.sendCaptureStop(DESKTOP_SESSION_ID)
    }

    // ── Remote control (remote_control_v1) ─────────────────────────────────────────
    // 0..1 normalized coordinates; the daemon maps to Mac global points. Mirrors the iPhone.

    fun setControl(on: Boolean) {
        _state.update { it.copy(controlEnabled = on) }
        ws?.sendControlSet(DESKTOP_SESSION_ID, on)
    }

    private fun nx(v: Double) = v.coerceIn(0.0, 1.0)

    fun click(x: Double, y: Double, button: String = "left", clicks: Int = 1) {
        ws?.screenClick(DESKTOP_SESSION_ID, nx(x), nx(y), button, clicks)
    }

    fun down(x: Double, y: Double) = ws?.screenDown(DESKTOP_SESSION_ID, nx(x), nx(y), "left")
    fun drag(x: Double, y: Double) = ws?.screenDrag(DESKTOP_SESSION_ID, nx(x), nx(y))
    fun up(x: Double, y: Double) = ws?.screenUp(DESKTOP_SESSION_ID, nx(x), nx(y), "left")
    fun scroll(dx: Double, dy: Double) = ws?.screenScroll(DESKTOP_SESSION_ID, dx, dy)
    fun typeText(text: String) { if (text.isNotEmpty()) ws?.screenText(DESKTOP_SESSION_ID, text) }
    fun pressKey(key: String) = ws?.screenKey(DESKTOP_SESSION_ID, key)
    fun hotkey(key: String, mods: List<String>) = ws?.screenHotkey(DESKTOP_SESSION_ID, key, mods)

    // ── WebSocket ────────────────────────────────────────────────────────────────

    private suspend fun wsLoop() {
        val client = WsClient(Ps.connection, Ps.attest)
        ws = client
        client.open(DESKTOP_SESSION_ID, since = { 0L }, onBinary = ::onVideoBytes).collect { ev ->
            when (ev) {
                is WsEvent.Connected -> {
                    client.sendVisibility(foreground)
                    if (_state.value.controlEnabled) client.sendControlSet(DESKTOP_SESSION_ID, true)
                    if (!paused && foreground) {
                        decoder.reset()
                        requestCapture()
                    }
                }
                is WsEvent.ScreenStatus -> handleStatus(ev.running, ev.reason)
                is WsEvent.ScreenJpeg -> handleJpeg(ev.bytesB64)
                is WsEvent.Disconnected -> _state.update {
                    it.copy(status = Status.DISCONNECTED, fatal = ev.fatal)
                }
                else -> {} // PTY events not relevant to mirroring
            }
        }
    }

    private fun requestCapture() {
        val client = ws ?: return
        val tor = Ps.connection.skeleton.value.channel == "tor_onion"
        if (h264Failed) {
            client.sendCaptureStart(DESKTOP_SESSION_ID, codec = "jpeg", audio = false)
            _state.update { it.copy(usingJpeg = true) }
            return
        }
        // Quality ceilings — the daemon's adaptive loop tunes the real rate to the channel.
        val (maxDim, fps, bitrate) =
            if (tor) Triple(1280, 12, 2_000_000) else Triple(1440, 30, 7_000_000)
        client.sendCaptureStart(DESKTOP_SESSION_ID, codec = "h264", fps = fps, bitrate = bitrate, maxDim = maxDim, audio = false)
    }

    private fun handleStatus(running: Boolean, reason: String?) {
        if (!running) {
            when (reason) {
                "screen_permission" -> _state.update { it.copy(status = Status.PERMISSION_NEEDED) }
                // lock screen / transient — surface as a stall, recover when frames resume.
                else -> _state.update {
                    if (it.status == Status.LIVE || it.status == Status.CONNECTING) it.copy(status = Status.STALLED) else it
                }
            }
        } else {
            _state.update {
                if (it.status == Status.PERMISSION_NEEDED || it.status == Status.DISCONNECTED) it.copy(status = Status.CONNECTING) else it
            }
        }
    }

    private fun onVideoBytes(bytes: ByteArray) {
        if (paused) return
        lastFrameAt = System.currentTimeMillis()
        decoder.handle(bytes)
    }

    private fun handleJpeg(b64: String) {
        if (paused) return
        val bytes = runCatching { Base64.decode(b64, Base64.DEFAULT) }.getOrNull() ?: return
        val bmp = runCatching { BitmapFactory.decodeByteArray(bytes, 0, bytes.size) }.getOrNull() ?: return
        lastFrameAt = System.currentTimeMillis()
        val prev = _state.value.jpegFrame
        _state.update {
            it.copy(
                status = Status.LIVE,
                usingJpeg = true,
                jpegFrame = bmp,
                videoWidth = bmp.width,
                videoHeight = bmp.height,
            )
        }
        if (prev != null && prev != bmp) prev.recycle()
    }

    private fun onDecodeError() {
        if (h264Failed) return
        h264Failed = true
        // Drop to the JPEG fallback codec — universally decodable, lower frame rate.
        ws?.let {
            it.sendCaptureStop(DESKTOP_SESSION_ID)
            viewModelScope.launch {
                delay(150)
                if (!paused && foreground) requestCapture()
            }
        }
    }

    private fun markLive() {
        _state.update {
            if (it.status == Status.CONNECTING || it.status == Status.STALLED) it.copy(status = Status.LIVE) else it
        }
    }

    // ── stall detection ────────────────────────────────────────────────────────

    private suspend fun stallLoop() {
        while (viewModelScope.isActive) {
            delay(1_000)
            val s = _state.value
            if (s.status == Status.LIVE && System.currentTimeMillis() - lastFrameAt > STALL_MS) {
                _state.update { it.copy(status = Status.STALLED) }
            } else if (s.status == Status.STALLED && System.currentTimeMillis() - lastFrameAt <= STALL_MS) {
                _state.update { it.copy(status = Status.LIVE) }
            }
        }
    }

    companion object {
        /** Fixed routing key — desktop capture is session-independent (iOS parity: "__desktop__"). */
        const val DESKTOP_SESSION_ID = "__desktop__"
        private const val STALL_MS = 2_500L
    }
}
