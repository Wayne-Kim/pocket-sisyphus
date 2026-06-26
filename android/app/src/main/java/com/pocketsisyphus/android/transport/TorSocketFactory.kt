package com.pocketsisyphus.android.transport

import android.util.Log
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.Socket
import javax.net.SocketFactory

/**
 * A [SocketFactory] that returns sockets already connected through a local Tor SOCKS5 proxy to
 * a fixed (onion) destination.
 *
 * Why pre-connected: sshj's `SocketClient.connect(host, port)` calls `createSocket()` (no-arg)
 * and, if that socket is *already connected*, skips its own `socket.connect(...)` — which would
 * otherwise locally resolve the `.onion` hostname (impossible) before reaching the proxy. By
 * connecting here to an **unresolved** address, the hostname is handed to the SOCKS5 proxy for
 * remote resolution (ATYP=domainname), the standard Tor-over-Java pattern.
 */
class TorSocketFactory(
    private val onionHost: String,
    private val onionPort: Int,
    private val socksPort: Int,
    private val connectTimeoutMs: Int = 30_000,
    private val socksHost: String = "127.0.0.1",
) : SocketFactory() {

    private fun proxied(): Socket {
        val proxy = Proxy(Proxy.Type.SOCKS, InetSocketAddress(socksHost, socksPort))
        val socket = Socket(proxy)
        Log.d(TAG, "dialing $onionHost:$onionPort via SOCKS5 127.0.0.1:$socksPort")
        // createUnresolved → SOCKS5 performs remote DNS resolution of the onion.
        socket.connect(InetSocketAddress.createUnresolved(onionHost, onionPort), connectTimeoutMs)
        return socket
    }

    override fun createSocket(): Socket = proxied()
    override fun createSocket(host: String?, port: Int): Socket = proxied()
    override fun createSocket(host: String?, port: Int, localHost: java.net.InetAddress?, localPort: Int): Socket = proxied()
    override fun createSocket(host: java.net.InetAddress?, port: Int): Socket = proxied()
    override fun createSocket(address: java.net.InetAddress?, port: Int, localAddress: java.net.InetAddress?, localPort: Int): Socket = proxied()

    companion object {
        private const val TAG = "TorSocketFactory"
    }
}
