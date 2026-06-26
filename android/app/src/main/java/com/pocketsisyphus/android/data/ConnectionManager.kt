package com.pocketsisyphus.android.data

import android.util.Log
import com.pocketsisyphus.android.BuildConfig
import com.pocketsisyphus.android.DevBootstrap
import com.pocketsisyphus.android.data.model.EndpointEntry
import com.pocketsisyphus.android.data.model.EndpointKind
import com.pocketsisyphus.android.tor.TorManager
import com.pocketsisyphus.android.transport.Forward
import com.pocketsisyphus.android.transport.HostKeyMismatchException
import com.pocketsisyphus.android.transport.SshTransport
import com.pocketsisyphus.android.transport.TorSocketFactory
import com.pocketsisyphus.android.transport.Transport
import com.pocketsisyphus.android.transport.TransportException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.TimeUnit

/**
 * Owns the live transport to the daemon and the loopback [Forward] the HTTP/WS layers use.
 *
 * Connection follows the walking-skeleton contract:
 *  1. **direct first** — if the QR carries a LAN host (`lan_host` / dev override), dial it over
 *     plain SSH (host key pinned to the QR fingerprint). Fast path, no Tor.
 *  2. **Tor + /endpoint** — otherwise (or in full-proof mode, or when direct fails) bootstrap Tor,
 *     fetch `/endpoint` over the onion, then try the candidates in happy-eyeballs order
 *     (`direct_ipv6` -> `direct_ipv4` -> `tor_onion`). Direct candidates use plain SSH; `tor_onion`
 *     routes SSH through the Tor SOCKS5 proxy. First success wins; `tor_onion` is the last fallback.
 *
 * [skeleton] exposes per-stage status for the diagnostic screen. One connection at a time;
 * [ensureConnected] is idempotent and serialized.
 */
class ConnectionManager(
    private val pairStore: PairStore,
    private val tor: TorManager,
    private val endpointResolver: EndpointResolver = EndpointResolver(),
) {

    sealed interface State {
        data object Idle : State
        data object Connecting : State
        data class Connected(val forward: Forward) : State
        data class Failed(val message: String) : State
    }

    /** Walking-skeleton stages, surfaced to the diagnostic screen. */
    enum class Stage { PAIRING, DIRECT, TOR, ENDPOINT, SSH, HEALTH }
    enum class StageStatus { PENDING, RUNNING, SUCCESS, FAILED, SKIPPED }

    data class SkeletonState(
        val statuses: Map<Stage, StageStatus> = Stage.entries.associateWith { StageStatus.PENDING },
        val channel: String? = null,
        val detail: String? = null,
    )

    private val _state = MutableStateFlow<State>(State.Idle)
    val state: StateFlow<State> = _state.asStateFlow()

    private val _skeleton = MutableStateFlow(SkeletonState())
    val skeleton: StateFlow<SkeletonState> = _skeleton.asStateFlow()

    /** Shared client for short HTTP calls (no proxy — talks straight to the SSH-forwarded loopback). */
    val http: OkHttpClient = OkHttpClient.Builder()
        .proxy(java.net.Proxy.NO_PROXY)
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(35, TimeUnit.SECONDS)
        .writeTimeout(20, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()

    private val mutex = Mutex()
    private var transport: Transport? = null

    @Volatile var forward: Forward? = null
        private set

    @Volatile var pairing: Pairing? = null
        private set

    val token: String
        get() = (if (BuildConfig.DEBUG && DevBootstrap.directActive) DevBootstrap.daemonToken else null)
            ?: pairing?.payload?.daemonToken.orEmpty()

    val isConnected: Boolean
        get() = forward != null && transport?.isAlive == true

    private fun setStage(stage: Stage, status: StageStatus, detail: String? = null) {
        _skeleton.value = _skeleton.value.let {
            it.copy(statuses = it.statuses + (stage to status), detail = detail ?: it.detail)
        }
    }

    private fun resetSkeleton() {
        _skeleton.value = SkeletonState()
    }

    /**
     * Connect if not already up (or if the channel died). Returns the active forward.
     *
     * @param fullProof exercise the entire skeleton (Tor bootstrap + `/endpoint` + happy-eyeballs)
     *   even when a LAN host would connect directly — used by the diagnostic screen.
     */
    suspend fun ensureConnected(
        forceReconnect: Boolean = false,
        fullProof: Boolean = false,
    ): Forward = mutex.withLock {
        // Dev direct-daemon pairing (mirrors iOS DevPairing) — no SSH, no Tor. Idempotent.
        if (BuildConfig.DEBUG && DevBootstrap.directActive) return connectDevDirect(forceReconnect)

        val current = forward
        if (!forceReconnect && current != null && transport?.isAlive == true) return current

        _state.value = State.Connecting
        resetSkeleton()
        teardownLocked()

        val p = pairStore.load() ?: run {
            setStage(Stage.PAIRING, StageStatus.FAILED, "Not paired")
            _state.value = State.Failed("Not paired")
            throw TransportException("Not paired")
        }
        pairing = p
        setStage(Stage.PAIRING, StageStatus.SUCCESS, p.payload.name)

        try {
            val (t, fwd, channel) = connectViaSkeleton(p, fullProof)
            probeHealth(fwd, p.payload.daemonToken)
            setStage(Stage.HEALTH, StageStatus.SUCCESS)
            transport = t
            forward = fwd
            _skeleton.value = _skeleton.value.copy(channel = channel)
            _state.value = State.Connected(fwd)
            fwd
        } catch (e: Throwable) {
            teardownLocked()
            val msg = e.message ?: "Connection failed"
            _state.value = State.Failed(msg)
            Log.w(TAG, "connect failed: $msg")
            throw when (e) {
                is TransportException, is HostKeyMismatchException -> e
                else -> TransportException(msg, e)
            }
        }
    }

    /**
     * Dev-only direct-daemon path (the Android twin of iOS DevPairing) — no SSH, no Tor.
     *
     * From the emulator the host Mac's loopback daemon is reachable at `10.0.2.2:<port>`
     * ([DevBootstrap.host]); the attest gate is bypassed downstream with X-PS-Local (HTTP) /
     * `?local=` (WS) using the localAdminSecret. The [forward] is reused once built; a health
     * probe confirms the daemon is actually up so a wrong port / dead daemon fails loudly.
     */
    private suspend fun connectDevDirect(forceReconnect: Boolean): Forward {
        val existing = forward
        if (!forceReconnect && existing != null) return existing

        _state.value = State.Connecting
        resetSkeleton()
        teardownLocked()

        val fwd = Forward(localHost = DevBootstrap.host, localPort = DevBootstrap.daemonPort)
        setStage(Stage.PAIRING, StageStatus.SUCCESS, "Dev direct")
        setStage(Stage.DIRECT, StageStatus.SUCCESS, "${DevBootstrap.host}:${DevBootstrap.daemonPort}")
        setStage(Stage.TOR, StageStatus.SKIPPED)
        setStage(Stage.ENDPOINT, StageStatus.SKIPPED)
        setStage(Stage.SSH, StageStatus.SKIPPED)
        pairing = null
        transport = null
        return try {
            probeHealth(fwd, token)
            setStage(Stage.HEALTH, StageStatus.SUCCESS)
            forward = fwd
            _skeleton.value = _skeleton.value.copy(channel = "dev_direct")
            _state.value = State.Connected(fwd)
            fwd
        } catch (e: Throwable) {
            teardownLocked()
            val msg = e.message ?: "Dev daemon unreachable"
            _state.value = State.Failed(msg)
            Log.w(TAG, "dev-direct connect failed: $msg")
            throw if (e is TransportException) e else TransportException(msg, e)
        }
    }

    /** Run the candidate ladder; returns the winning transport + forward + channel label. */
    private suspend fun connectViaSkeleton(
        p: Pairing,
        fullProof: Boolean,
    ): Triple<Transport, Forward, String> {
        // 1. Direct LAN fast path (no Tor) — unless full-proof mode forces the whole ladder.
        if (!fullProof && p.canDialLan) {
            setStage(Stage.DIRECT, StageStatus.RUNNING)
            runCatching { dialDirect(p, p.sshHost!!, p.sshPort, p.payload.sshHostKeyFingerprint) }
                .onSuccess { res ->
                    setStage(Stage.DIRECT, StageStatus.SUCCESS)
                    setStage(Stage.TOR, StageStatus.SKIPPED)
                    setStage(Stage.ENDPOINT, StageStatus.SKIPPED)
                    setStage(Stage.SSH, StageStatus.SUCCESS)
                    return Triple(res.first, res.second, "direct_lan")
                }
                .onFailure {
                    Log.i(TAG, "direct LAN failed, falling back to Tor: ${it.message}")
                    setStage(Stage.DIRECT, StageStatus.FAILED, it.message)
                    if (it is HostKeyMismatchException) throw it
                }
        }

        if (p.payload.onion.isBlank()) {
            throw TransportException("No reachable channel — no LAN host and no onion in the pairing.")
        }

        // 2. Tor bootstrap.
        setStage(Stage.TOR, StageStatus.RUNNING)
        val socksPort = try {
            tor.ensureBootstrapped(p.payload.onionBase, p.payload.onionAuth)
        } catch (e: Throwable) {
            setStage(Stage.TOR, StageStatus.FAILED, e.message)
            throw TransportException(e.message ?: "Tor bootstrap failed", e)
        }
        setStage(Stage.TOR, StageStatus.SUCCESS, "SOCKS 127.0.0.1:$socksPort")

        // 3. /endpoint over the onion.
        setStage(Stage.ENDPOINT, StageStatus.RUNNING)
        val endpoint = try {
            endpointResolver.fetch(p.payload.onion, p.payload.endpointToken, socksPort)
        } catch (e: Throwable) {
            setStage(Stage.ENDPOINT, StageStatus.FAILED, e.message)
            throw TransportException(e.message ?: "/endpoint failed", e)
        }
        val fingerprint = endpoint.sshHostKeyFingerprint.ifBlank { p.payload.sshHostKeyFingerprint }
        setStage(Stage.ENDPOINT, StageStatus.SUCCESS, "${endpoint.endpoints.size} candidates")

        // 4. Happy-eyeballs ladder. Optionally keep the LAN host as a prio-0 direct candidate.
        val candidates = buildList {
            if (fullProof && p.canDialLan) {
                add(EndpointEntry("direct_lan", p.sshHost!!, p.sshPort, 0))
            }
            addAll(endpoint.endpoints)
        }
        val ordered = HappyEyeballs.order(candidates, torReady = tor.isReady)
        setStage(Stage.SSH, StageStatus.RUNNING)

        var lastError: Throwable? = null
        for (cand in ordered) {
            try {
                val res = if (cand.kind == EndpointKind.TOR_ONION) {
                    dialTor(p, cand, fingerprint, socksPort)
                } else {
                    dialDirect(p, cand.host, cand.port, fingerprint)
                }
                setStage(Stage.SSH, StageStatus.SUCCESS, cand.type)
                return Triple(res.first, res.second, cand.type)
            } catch (e: HostKeyMismatchException) {
                // A pinned-key mismatch is fail-closed — never silently try the next candidate.
                setStage(Stage.SSH, StageStatus.FAILED, e.message)
                throw e
            } catch (e: Throwable) {
                Log.i(TAG, "candidate ${cand.type} ${cand.host} failed: ${e.message}")
                lastError = e
            }
        }
        setStage(Stage.SSH, StageStatus.FAILED, lastError?.message)
        throw TransportException(lastError?.message ?: "All endpoints failed", lastError)
    }

    private suspend fun dialDirect(
        p: Pairing,
        host: String,
        port: Int,
        fingerprint: String,
    ): Pair<Transport, Forward> {
        val t = SshTransport(p, host, port, fingerprint)
        return t to t.connect()
    }

    private suspend fun dialTor(
        p: Pairing,
        cand: EndpointEntry,
        fingerprint: String,
        socksPort: Int,
    ): Pair<Transport, Forward> {
        val factory = TorSocketFactory(cand.host, cand.port, socksPort)
        val t = SshTransport(p, cand.host, cand.port, fingerprint, factory)
        return t to t.connect()
    }

    fun disconnect() {
        forward = null
        transport?.close()
        transport = null
        _state.value = State.Idle
    }

    private fun teardownLocked() {
        forward = null
        transport?.close()
        transport = null
    }

    /** Confirm the forward actually reaches the daemon (guards a stale/wrong daemon port). */
    private suspend fun probeHealth(fwd: Forward, token: String) = withContext(Dispatchers.IO) {
        setStage(Stage.HEALTH, StageStatus.RUNNING)
        val req = Request.Builder()
            .url("${fwd.httpBase}/health")
            .header("Authorization", "Bearer $token")
            .get()
            .build()
        http.newCall(req).execute().use { resp ->
            if (!resp.isSuccessful) {
                setStage(Stage.HEALTH, StageStatus.FAILED, "code ${resp.code}")
                throw TransportException("Daemon health probe failed (${resp.code})")
            }
        }
    }

    companion object {
        private const val TAG = "ConnectionManager"
    }
}
