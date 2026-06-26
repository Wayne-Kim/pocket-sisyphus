package com.pocketsisyphus.android.data

import android.util.Log
import com.pocketsisyphus.android.data.model.PsJson
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import java.net.Proxy
import java.util.concurrent.TimeUnit

/** Daemon → client WebSocket events the UI cares about. */
sealed interface WsEvent {
    data object Connected : WsEvent
    data object Subscribed : WsEvent
    data class PtyOutput(val id: String, val bytesB64: String) : WsEvent
    data class PtyExit(val exitCode: Int?, val signal: String?) : WsEvent
    data object TurnComplete : WsEvent
    data class Disconnected(val reason: String, val fatal: Boolean) : WsEvent

    /**
     * Global (session-agnostic) lifecycle event — daemon's `broadcastAll({type:"session_event"})`.
     * `kind` = "waiting" (agent entered approval/input wait, with context) | "resolved"
     * (wait cleared). Delivered to every connected socket regardless of subscription, so the
     * global listener ([open] with a null sessionId) receives it without subscribing.
     */
    data class SessionEvent(
        val kind: String,
        val sessionId: String,
        val repoName: String?,
        val title: String?,
        val agentName: String?,
        val preview: String?,
    ) : WsEvent

    // ── Screen mirroring (screen_capture_v1 / screen_h264_v1) ──────────────────
    /** Capture state from the daemon. `running=false` carries a [reason] (e.g. screen_permission). */
    data class ScreenStatus(val running: Boolean, val reason: String?) : WsEvent
    /** JPEG fallback frame (old daemon / codec fallback) — base64-encoded image bytes. */
    data class ScreenJpeg(val bytesB64: String) : WsEvent
}

/**
 * One WebSocket lifecycle per session (created by the detail ViewModel). [open] returns a
 * cold flow that connects, subscribes, streams `pty_output`, runs an app-level ping for
 * zombie detection, and reconnects with backoff — until the collector cancels or the
 * daemon closes with a policy violation (1008 = pairing/auth revoked → fatal, no retry).
 */
class WsClient(private val conn: ConnectionManager, private val attest: Attestation) {

    private val wsHttp = conn.http.newBuilder()
        .proxy(Proxy.NO_PROXY)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .pingInterval(0, TimeUnit.MILLISECONDS) // app-level ping instead.
        .build()

    @Volatile private var liveSocket: WebSocket? = null
    @Volatile private var lastPongAt: Long = 0

    /** Send raw keystroke bytes (already base64) to the PTY. Returns false if not connected. */
    fun sendPtyInput(sessionId: String, bytesB64: String): Boolean {
        val ws = liveSocket ?: return false
        return ws.send("""{"type":"pty_input","sessionId":${jsonStr(sessionId)},"bytes_b64":${jsonStr(bytesB64)}}""")
    }

    fun sendVisibility(foreground: Boolean) {
        liveSocket?.send("""{"type":"visibility","state":"${if (foreground) "foreground" else "background"}"}""")
    }

    // ── Screen mirroring control (screen_capture_v1 / screen_h264_v1) ───────────

    /**
     * Ask the daemon to spawn the capture helper and start pushing frames for [sessionId].
     * `codec="h264"` → typed binary frames (decoded by [com.pocketsisyphus.android.mirror.H264Decoder]);
     * old daemons ignore the extra fields and fall back to base64 `screen_frame` (JPEG).
     */
    fun sendCaptureStart(
        sessionId: String,
        codec: String = "h264",
        fps: Int? = null,
        bitrate: Int? = null,
        maxDim: Int? = null,
        audio: Boolean = false,
    ): Boolean {
        val ws = liveSocket ?: return false
        val sb = StringBuilder("""{"type":"capture_start","sessionId":${jsonStr(sessionId)},"codec":${jsonStr(codec)}""")
        if (fps != null) sb.append(""","fps":$fps""")
        if (bitrate != null) sb.append(""","bitrate":$bitrate""")
        if (maxDim != null) sb.append(""","maxDim":$maxDim""")
        sb.append(""","audio":$audio}""")
        return ws.send(sb.toString())
    }

    /** Stop capture for [sessionId] (tears the helper down once no one is watching). */
    fun sendCaptureStop(sessionId: String): Boolean {
        val ws = liveSocket ?: return false
        return ws.send("""{"type":"capture_stop","sessionId":${jsonStr(sessionId)}}""")
    }

    // ── Remote control (remote_control_v1) — same WS contract as the iPhone ─────────
    // Enable control, then send input_event frames. Coordinates are 0..1 normalized to the captured
    // frame; the daemon maps them to Mac global points (handles ROI / window / Retina).

    /** Turn remote control on/off for [sessionId] (iOS `control_set`). */
    fun sendControlSet(sessionId: String, enabled: Boolean): Boolean {
        val ws = liveSocket ?: return false
        return ws.send("""{"type":"control_set","sessionId":${jsonStr(sessionId)},"enabled":$enabled}""")
    }

    private fun sendInput(sessionId: String, eventJson: String): Boolean {
        val ws = liveSocket ?: return false
        return ws.send("""{"type":"input_event","sessionId":${jsonStr(sessionId)},"event":$eventJson}""")
    }

    fun screenClick(sessionId: String, x: Double, y: Double, button: String, clicks: Int): Boolean =
        sendInput(sessionId, """{"cmd":"click","x":$x,"y":$y,"button":${jsonStr(button)},"clicks":$clicks}""")

    fun screenMove(sessionId: String, x: Double, y: Double): Boolean =
        sendInput(sessionId, """{"cmd":"move","x":$x,"y":$y}""")

    fun screenDown(sessionId: String, x: Double, y: Double, button: String): Boolean =
        sendInput(sessionId, """{"cmd":"down","x":$x,"y":$y,"button":${jsonStr(button)}}""")

    fun screenDrag(sessionId: String, x: Double, y: Double): Boolean =
        sendInput(sessionId, """{"cmd":"drag","x":$x,"y":$y}""")

    fun screenUp(sessionId: String, x: Double, y: Double, button: String): Boolean =
        sendInput(sessionId, """{"cmd":"up","x":$x,"y":$y,"button":${jsonStr(button)}}""")

    fun screenScroll(sessionId: String, dx: Double, dy: Double): Boolean =
        sendInput(sessionId, """{"cmd":"scroll","dx":$dx,"dy":$dy}""")

    fun screenText(sessionId: String, text: String): Boolean =
        sendInput(sessionId, """{"cmd":"text","text":${jsonStr(text)}}""")

    fun screenKey(sessionId: String, key: String): Boolean =
        sendInput(sessionId, """{"cmd":"key","key":${jsonStr(key)}}""")

    fun screenHotkey(sessionId: String, key: String, mods: List<String>): Boolean =
        sendInput(sessionId, """{"cmd":"hotkey","key":${jsonStr(key)},"mods":[${mods.joinToString(",") { jsonStr(it) }}]}""")

    fun open(sessionId: String?, since: () -> Long, onBinary: ((ByteArray) -> Unit)? = null): Flow<WsEvent> = callbackFlow {
        var attempt = 0
        var active = true
        var pingJob: Job? = null

        lateinit var startConnect: () -> Unit

        fun scheduleReconnect(reason: String, fatal: Boolean) {
            pingJob?.cancel()
            liveSocket = null
            trySend(WsEvent.Disconnected(reason, fatal))
            if (fatal || !active) {
                if (fatal) close()
                return
            }
            launch {
                delay(backoffMs(attempt++))
                if (active) startConnect()
            }
        }

        startConnect = {
            launch(Dispatchers.IO) {
                try {
                    val fwd = conn.ensureConnected(forceReconnect = attempt > 0)
                    val token = conn.token
                    val devDirect = com.pocketsisyphus.android.BuildConfig.DEBUG &&
                        com.pocketsisyphus.android.DevBootstrap.directActive
                    // Dev direct-daemon — `?local=` is the WS twin of the HTTP X-PS-Local header
                    // (daemon server.ts verifyWsAttest), so no attest token is needed.
                    val gateParam = if (devDirect) {
                        com.pocketsisyphus.android.DevBootstrap.localSecret
                            ?.let { "&local=$it" }.orEmpty()
                    } else {
                        val attestTok = attest.currentToken()
                            ?: runCatching { attest.ensureToken() }.getOrNull()
                        attestTok?.let { "&attest=$it" }.orEmpty()
                    }
                    // BL-12(설계상 수용): WS 인증 토큰을 쿼리(?token=/&attest=)로 보낸다. 헤더가
                    // 더 깔끔하나 daemon WS upgrade(server.ts)는 브라우저 WS 가 헤더를 못 붙이는
                    // 제약 때문에 «쿼리 토큰» 을 표준 인증 경로로 받는다 — daemon 을 헤더 우선으로
                    // 바꾸면 모든 WS 클라이언트(브라우저 포함)에 영향. 또한 이 연결은 loopback
                    // SSH 포워드 안이라 외부 프록시/부수 로깅 노출 위험이 대부분 무효화된다(최하 Low).
                    val req = Request.Builder()
                        .url("${fwd.wsBase}/ws?token=$token$gateParam")
                        .header("X-Client-Version", com.pocketsisyphus.android.BuildConfig.VERSION_NAME)
                        .build()
                    val listener = object : WebSocketListener() {
                        override fun onOpen(ws: WebSocket, response: Response) {
                            attempt = 0
                            lastPongAt = System.currentTimeMillis()
                            liveSocket = ws
                            // Global listener (sessionId == null) only consumes broadcastAll
                            // `session_event`s — it must NOT subscribe (no session to attach to).
                            if (sessionId != null) {
                                val s = since()
                                val sinceField = if (s > 0) ""","since":$s""" else ""
                                ws.send("""{"type":"subscribe","sessionId":${jsonStr(sessionId)}$sinceField}""")
                            }
                            trySend(WsEvent.Connected)
                            pingJob?.cancel()
                            pingJob = launch {
                                while (isActive) {
                                    delay(PING_INTERVAL_MS)
                                    if (System.currentTimeMillis() - lastPongAt > PONG_DEADLINE_MS) {
                                        Log.d(TAG, "pong timeout — reconnecting")
                                        ws.cancel()
                                        scheduleReconnect("ping timeout", fatal = false)
                                        return@launch
                                    }
                                    ws.send("""{"type":"ping","t":${System.currentTimeMillis()}}""")
                                }
                            }
                        }

                        override fun onMessage(ws: WebSocket, text: String) {
                            parse(text)?.let { trySend(it) }
                        }

                        // Binary frames = H.264 video (typed payloads). Routed straight to the
                        // decoder off the flow so high-rate video never back-pressures events.
                        override fun onMessage(ws: WebSocket, bytes: ByteString) {
                            onBinary?.invoke(bytes.toByteArray())
                        }

                        override fun onFailure(ws: WebSocket, t: Throwable, response: Response?) {
                            scheduleReconnect(t.message ?: "ws failure", fatal = false)
                        }

                        override fun onClosed(ws: WebSocket, code: Int, reason: String) {
                            // 1008 = policy violation → pairing rotated / auth revoked; do not retry.
                            scheduleReconnect("closed $code $reason", fatal = code == 1008)
                        }
                    }
                    wsHttp.newWebSocket(req, listener)
                } catch (e: Throwable) {
                    scheduleReconnect(e.message ?: "ws connect failed", fatal = false)
                }
            }
        }

        startConnect()
        awaitClose {
            active = false
            pingJob?.cancel()
            liveSocket?.close(1000, "bye")
            liveSocket = null
        }
    }

    private fun parse(text: String): WsEvent? {
        val obj = runCatching { PsJson.parseToJsonElement(text) as? JsonObject }.getOrNull() ?: return null
        return when (obj["type"]?.jsonPrimitive?.contentOrNull) {
            "pty_output" -> {
                val id = obj["id"]?.jsonPrimitive?.contentOrNull ?: ""
                val b64 = obj["bytes_b64"]?.jsonPrimitive?.contentOrNull ?: return null
                WsEvent.PtyOutput(id, b64)
            }
            "pty_exit" -> WsEvent.PtyExit(
                obj["exitCode"]?.jsonPrimitive?.longOrNull?.toInt(),
                obj["signal"]?.jsonPrimitive?.contentOrNull,
            )
            "turn_complete" -> WsEvent.TurnComplete
            "session_event" -> {
                // Global broadcast — daemon pty-runner's broadcastWaitingEntry/Resolved.
                val kind = obj["kind"]?.jsonPrimitive?.contentOrNull ?: return null
                val sid = obj["sessionId"]?.jsonPrimitive?.contentOrNull ?: return null
                WsEvent.SessionEvent(
                    kind = kind,
                    sessionId = sid,
                    repoName = obj["repoName"]?.jsonPrimitive?.contentOrNull,
                    title = obj["title"]?.jsonPrimitive?.contentOrNull,
                    agentName = obj["agentName"]?.jsonPrimitive?.contentOrNull,
                    preview = obj["preview"]?.jsonPrimitive?.contentOrNull,
                )
            }
            "subscribed" -> WsEvent.Subscribed
            "capture_status" -> WsEvent.ScreenStatus(
                running = obj["running"]?.jsonPrimitive?.booleanOrNull ?: false,
                reason = obj["reason"]?.jsonPrimitive?.contentOrNull,
            )
            "screen_frame" -> {
                val b64 = obj["bytes_b64"]?.jsonPrimitive?.contentOrNull ?: return null
                WsEvent.ScreenJpeg(b64)
            }
            "pong" -> {
                lastPongAt = System.currentTimeMillis()
                null
            }
            else -> null
        }
    }

    private fun jsonStr(s: String): String =
        buildString {
            append('"')
            for (c in s) when (c) {
                '"' -> append("\\\"")
                '\\' -> append("\\\\")
                '\n' -> append("\\n")
                '\r' -> append("\\r")
                '\t' -> append("\\t")
                else -> if (c < ' ') append("\\u%04x".format(c.code)) else append(c)
            }
            append('"')
        }

    private fun backoffMs(attempt: Int): Long =
        (1000L shl attempt.coerceAtMost(5)).coerceAtMost(30_000L)

    companion object {
        private const val TAG = "WsClient"
        private const val PING_INTERVAL_MS = 15_000L
        private const val PONG_DEADLINE_MS = 35_000L
    }
}
