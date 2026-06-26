package com.pocketsisyphus.android.transport

/** A loopback endpoint the app talks plain HTTP/WS to. */
data class Forward(val localHost: String = "127.0.0.1", val localPort: Int) {
    val httpBase: String get() = "http://$localHost:$localPort"
    val wsBase: String get() = "ws://$localHost:$localPort"
}

/**
 * The reachability layer between the phone and the daemon. The daemon never exposes plain
 * HTTP — it is always behind a transport (SSH local-forward today; Tor-over-SSH later).
 * Implementations are responsible for tearing everything down in [close].
 */
interface Transport {
    /** Establish reachability; returns the loopback [Forward] to issue HTTP/WS against. */
    suspend fun connect(): Forward

    /** Whether the underlying channel is still alive. */
    val isAlive: Boolean

    fun close()
}
