package com.pocketsisyphus.android.tor

import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.ServiceConnection
import android.os.IBinder
import android.util.Log
import androidx.localbroadcastmanager.content.LocalBroadcastManager
import com.pocketsisyphus.android.data.BridgeStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.torproject.jni.TorService
import com.pocketsisyphus.android.R
import java.io.File
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * In-process Tor (Guardian Project `tor-android`).
 *
 * Bootstraps a Tor circuit and exposes a local SOCKS5 port the app uses for the Tor data
 * plane: the `/endpoint` lookup over the onion and the `tor_onion` SSH fallback. Mirrors the
 * iOS `TorManager` (which runs iCepa Tor.framework) — same v3 client-auth contract:
 * `<onionBase>.auth_private` = `<onionBase>:descriptor:x25519:<privBase32>`.
 *
 * Bootstrap = bind [TorService] → it starts the bundled tor binary → `STATUS_ON` broadcast →
 * read the SOCKS port. v3 client-auth is provisioned *before* start by writing the auth file
 * + a `ClientOnionAuthDir` torrc line, so descriptor decryption works on the first onion dial.
 *
 * Live circuit verification is deferred to on-device (this layer is compile-checked only).
 *
 * ## Optional bridge bypass
 * On networks that DPI-block plaintext Tor, [ensureBootstrapped] always tries plaintext first and,
 * only if it stalls, automatically retries **through the user's bridges** (when [BridgeStore] is
 * enabled with usable lines) by injecting `UseBridges 1` + `Bridge …` into the torrc. Users who
 * never opt in are wholly unaffected. obfs4 PT isn't bundled in this build, so only vanilla bridges
 * are attempted (see [BridgeStore.obfs4Available]).
 */
class TorManager(context: Context, private val bridges: BridgeStore) {

    private val appContext = context.applicationContext

    sealed interface State {
        data object Idle : State
        data object Bootstrapping : State
        data class Ready(val socksPort: Int) : State
        data class Failed(val message: String) : State
    }

    private val _state = MutableStateFlow<State>(State.Idle)
    val state: StateFlow<State> = _state.asStateFlow()

    /**
     * Whether plaintext Tor bootstrap stalled and Tor itself looks blocked (no working channel).
     * The diagnostic «Tor blocked» card keys off this to surface the «set up a bridge» entry.
     * Reset to false whenever Tor reaches a ready state (plain or bridged).
     */
    private val _likelyBlocked = MutableStateFlow(false)
    val likelyBlocked: StateFlow<Boolean> = _likelyBlocked.asStateFlow()

    @Volatile var socksPort: Int = -1
        private set

    private val mutex = Mutex()
    private var service: TorService? = null
    private var connection: ServiceConnection? = null
    private var bound = false

    val isReady: Boolean get() = socksPort > 0 && service != null

    /**
     * Bootstrap Tor if not already up and provision the onion's v3 client-auth.
     * Returns the local SOCKS5 port. Idempotent + serialized.
     *
     * Tries plaintext Tor first; if that stalls and the user enabled bridges with usable lines,
     * automatically retries through those bridges. Plaintext-first means opted-out users (and the
     * common, unblocked case) are unaffected.
     */
    suspend fun ensureBootstrapped(onionBase: String?, onionAuthPriv: String?): Int =
        mutex.withLock {
            socksPort.takeIf { it > 0 && service != null }?.let { return it }
            _likelyBlocked.value = false
            _state.value = State.Bootstrapping

            if (!onionBase.isNullOrBlank() && !onionAuthPriv.isNullOrBlank()) {
                provisionOnionAuth(onionBase, onionAuthPriv)
            }

            val bridgeLines = if (bridges.enabled.value) {
                bridges.usableBridgeLines(BridgeStore.obfs4Available)
            } else {
                emptyList()
            }
            val canFallback = bridgeLines.isNotEmpty()

            // 1. Plaintext first — always. Fail fast when a bridge fallback is waiting.
            writeBridgeTorrc(null)
            val plainTimeout = if (canFallback) FAST_STALL_MS else PLAIN_STALL_MS
            val plain = runCatching { bindAndAwaitOn(plainTimeout) }.getOrNull()
            if (plain != null) {
                bridges.setStatus(BridgeStore.Status.Idle)
                return finishReady(plain)
            }

            // Plaintext stalled / failed.
            teardownLocked()
            _likelyBlocked.value = true
            if (!canFallback) {
                writeBridgeTorrc(null)
                val msg = appContext.getString(R.string.tor_blocked_no_bridge)
                _state.value = State.Failed(msg)
                throw TorException(msg)
            }

            // 2. Bridge fallback.
            Log.i(TAG, "plaintext bootstrap stalled — retrying via ${bridgeLines.size} bridge(s)")
            bridges.setStatus(BridgeStore.Status.Connecting)
            writeBridgeTorrc(bridgeLines)
            val bridged = runCatching { bindAndAwaitOn(BRIDGE_STALL_MS) }.getOrNull()
            if (bridged == null) {
                teardownLocked()
                writeBridgeTorrc(null)
                bridges.setStatus(BridgeStore.Status.Failed(
                    appContext.getString(R.string.tor_bridge_failed_reason)))
                val msg = appContext.getString(R.string.tor_bridge_failed)
                _state.value = State.Failed(msg)
                throw TorException(msg)
            }
            bridges.setStatus(BridgeStore.Status.Connected)
            return finishReady(bridged)
        }

    /** Extract the SOCKS port from a bootstrapped service and flip to the Ready state. */
    private fun finishReady(svc: TorService): Int {
        val port = svc.socksPort.takeIf { it > 0 }
            ?: querySocksPort(svc)
            ?: run {
                teardownLocked()
                throw TorException("Tor started but no SOCKS port was reported")
            }
        service = svc
        socksPort = port
        _likelyBlocked.value = false
        _state.value = State.Ready(port)
        Log.i(TAG, "Tor bootstrapped; SOCKS 127.0.0.1:$port")
        return port
    }

    fun shutdown() {
        teardownLocked()
        _state.value = State.Idle
    }

    private fun teardownLocked() {
        connection?.let { runCatching { appContext.unbindService(it) } }
        // No startService was issued, so unbinding the BIND_AUTO_CREATE binding stops the service.
        connection = null
        service = null
        bound = false
        socksPort = -1
    }

    // ── bootstrap plumbing ──────────────────────────────────────────────────

    private suspend fun bindAndAwaitOn(timeoutMs: Long): TorService = withContext(Dispatchers.Main) {
        withTimeout(timeoutMs) {
            suspendCancellableCoroutine { cont ->
                val lbm = LocalBroadcastManager.getInstance(appContext)
                var boundService: TorService? = null
                var resumed = false

                val receiver = object : BroadcastReceiver() {
                    override fun onReceive(ctx: Context, intent: Intent) {
                        val status = intent.getStringExtra(TorService.EXTRA_STATUS)
                        Log.d(TAG, "Tor status=$status")
                        if (status == TorService.STATUS_ON && !resumed) {
                            val svc = boundService
                            if (svc != null) {
                                resumed = true
                                runCatching { lbm.unregisterReceiver(this) }
                                cont.resume(svc)
                            }
                        }
                    }
                }
                lbm.registerReceiver(receiver, IntentFilter(TorService.ACTION_STATUS))

                val conn = object : ServiceConnection {
                    override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
                        val svc = (binder as? TorService.LocalBinder)?.service
                        boundService = svc
                        // Already on (a previous bind left tor running)?
                        if (svc != null && svc.socksPort > 0 && !resumed) {
                            resumed = true
                            runCatching { lbm.unregisterReceiver(receiver) }
                            cont.resume(svc)
                        }
                    }

                    override fun onServiceDisconnected(name: ComponentName?) {
                        service = null
                    }
                }
                connection = conn
                bound = appContext.bindService(
                    Intent(appContext, TorService::class.java),
                    conn,
                    Context.BIND_AUTO_CREATE,
                )
                if (!bound) {
                    runCatching { lbm.unregisterReceiver(receiver) }
                    cont.resumeWithException(TorException("Could not bind TorService"))
                }
                cont.invokeOnCancellation { runCatching { lbm.unregisterReceiver(receiver) } }
            }
        }
    }

    /** Fallback: ask tor's control connection for the SOCKS listener if the field is unset. */
    private fun querySocksPort(svc: TorService): Int? = runCatching {
        // `net/listeners/socks` → "127.0.0.1:NNNNN" (possibly quoted, possibly multiple).
        svc.getInfo("net/listeners/socks")
            ?.substringAfterLast(':')
            ?.trim('"', ' ', '\n')
            ?.toIntOrNull()
    }.getOrNull()

    // ── v3 onion client-auth ─────────────────────────────────────────────────

    private fun provisionOnionAuth(onionBase: String, privBase32: String) {
        val dir = File(appContext.filesDir, ONION_AUTH_DIR).apply { mkdirs() }
        runCatching { dir.setReadable(false, false); dir.setReadable(true, true) }
        val base = onionBase.removeSuffix(".onion")
        val file = File(dir, "$base.auth_private")
        file.writeText("$base:descriptor:x25519:$privBase32\n")
        runCatching { file.setReadable(false, false); file.setReadable(true, true) }

        // Tell tor where to read client-auth from. TorService only writes a fresh torrc when
        // none exists, so appending the directive once is safe + idempotent.
        val torrc = TorService.getTorrc(appContext)
        val existing = runCatching { torrc.readText() }.getOrDefault("")
        if (!existing.contains("ClientOnionAuthDir")) {
            torrc.appendText("\nClientOnionAuthDir ${dir.absolutePath}\n")
        }
    }

    // ── bridge torrc injection ───────────────────────────────────────────────

    /**
     * Rewrite the managed `UseBridges`/`Bridge` block in the torrc.
     *
     * tor reads its torrc at process start, so the block must be in place before the next bind. We
     * keep it between markers and replace it wholesale each time — preserving everything else in the
     * file (e.g. the `ClientOnionAuthDir` line). Passing a null/empty list clears the block, which is
     * how plaintext-first attempts guarantee no stale `UseBridges` lingers.
     */
    private fun writeBridgeTorrc(lines: List<String>?) {
        val torrc = TorService.getTorrc(appContext)
        val existing = runCatching { torrc.readText() }.getOrDefault("")
        val cleaned = stripBridgeBlock(existing)
        val block = if (lines.isNullOrEmpty()) "" else buildString {
            append("\n").append(BRIDGE_BEGIN).append("\n")
            append("UseBridges 1\n")
            for (line in lines) append("Bridge ").append(line).append("\n")
            append(BRIDGE_END).append("\n")
        }
        runCatching { torrc.writeText(cleaned.trimEnd('\n') + block) }
            .onFailure { Log.w(TAG, "could not write bridge torrc: ${it.message}") }
    }

    /** Remove a previously written managed bridge block (markers inclusive). */
    private fun stripBridgeBlock(text: String): String {
        val begin = text.indexOf(BRIDGE_BEGIN)
        if (begin < 0) return text
        val endMarker = text.indexOf(BRIDGE_END, begin)
        val end = if (endMarker < 0) text.length else endMarker + BRIDGE_END.length
        return (text.substring(0, begin).trimEnd('\n') + "\n" + text.substring(end))
            .let { it.ifBlank { "" } }
    }

    companion object {
        private const val TAG = "TorManager"
        private const val ONION_AUTH_DIR = "onion_auth"

        /** Plaintext stall budget when no bridge fallback is configured. */
        private const val PLAIN_STALL_MS = 90_000L
        /** Shorter plaintext budget when a bridge fallback is ready — fail fast, switch sooner. */
        private const val FAST_STALL_MS = 35_000L
        /** Bridge handshakes are slower; give them more room. */
        private const val BRIDGE_STALL_MS = 90_000L

        private const val BRIDGE_BEGIN = "# >>> ps-bridges (managed)"
        private const val BRIDGE_END = "# <<< ps-bridges"
    }
}

class TorException(message: String, cause: Throwable? = null) : Exception(message, cause)
