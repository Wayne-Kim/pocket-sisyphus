package com.pocketsisyphus.android.transport

import android.util.Base64
import android.util.Log
import com.pocketsisyphus.android.data.Pairing
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import net.i2p.crypto.eddsa.EdDSAPrivateKey
import net.i2p.crypto.eddsa.EdDSAPublicKey
import net.i2p.crypto.eddsa.spec.EdDSANamedCurveTable
import net.i2p.crypto.eddsa.spec.EdDSAPrivateKeySpec
import net.i2p.crypto.eddsa.spec.EdDSAPublicKeySpec
import net.schmizz.sshj.DefaultConfig
import net.schmizz.sshj.SSHClient
import net.schmizz.sshj.common.KeyType
import net.schmizz.sshj.connection.channel.direct.LocalPortForwarder
import net.schmizz.keepalive.KeepAliveProvider
import net.schmizz.sshj.connection.channel.direct.Parameters
import net.schmizz.sshj.transport.verification.FingerprintVerifier
import net.schmizz.sshj.userauth.keyprovider.KeyProvider
import org.bouncycastle.asn1.ASN1OctetString
import org.bouncycastle.asn1.pkcs.PrivateKeyInfo
import java.net.InetAddress
import java.net.ServerSocket
import java.security.PrivateKey
import java.security.PublicKey
import javax.net.SocketFactory

/**
 * SSH transport reaching one candidate endpoint: open an SSH connection to [host]:[port],
 * authenticate with the paired ed25519 client key, then forward a local loopback port to the
 * daemon's `127.0.0.1:<daemonPort>` (the only destination sshd's `PermitOpen` allows).
 *
 * The host key is pinned against [hostKeyFingerprint] (`SHA256:…` from the QR / `/endpoint`);
 * a mismatch fails closed with [HostKeyMismatchException].
 *
 * For the `tor_onion` candidate, [socketFactory] is a [TorSocketFactory] that routes the SSH
 * socket through the local Tor SOCKS5 proxy; for direct candidates it is null (plain TCP).
 *
 * ed25519 detail: sshj's `KeyType.ED25519` is wired to the i2p `net.i2p.crypto.eddsa`
 * key classes, so we parse the PKCS8 seed and rebuild i2p key objects — this is the
 * combination sshj's signer + KeyType recognize on Android.
 */
class SshTransport(
    private val pairing: Pairing,
    private val host: String,
    private val port: Int,
    private val hostKeyFingerprint: String,
    private val socketFactory: SocketFactory? = null,
) : Transport {

    private var client: SSHClient? = null
    private var serverSocket: ServerSocket? = null
    private var forwardThread: Thread? = null
    @Volatile private var localPort: Int = -1

    override val isAlive: Boolean
        get() = client?.isConnected == true && client?.isAuthenticated == true

    override suspend fun connect(): Forward = withContext(Dispatchers.IO) {
        if (host.isBlank()) throw TransportException("No reachable host for this candidate.")
        if (hostKeyFingerprint.isBlank()) throw TransportException("Missing SSH host key fingerprint.")

        val config = DefaultConfig().apply {
            keepAliveProvider = KeepAliveProvider.KEEP_ALIVE
        }
        val ssh = SSHClient(config)
        ssh.connectTimeout = CONNECT_TIMEOUT_MS
        ssh.timeout = SOCKET_TIMEOUT_MS
        socketFactory?.let { ssh.socketFactory = it }

        ssh.addHostKeyVerifier(FingerprintVerifier.getInstance(hostKeyFingerprint))

        try {
            Log.i(TAG, "connecting to $host:$port ${if (socketFactory != null) "(via Tor SOCKS)" else ""}…")
            ssh.connect(host, port)
            Log.i(TAG, "transport up (KEX + host key OK); authenticating ${pairing.payload.sshUser} …")
            ssh.connection.keepAlive.keepAliveInterval = KEEPALIVE_SEC
            ssh.authPublickey(pairing.payload.sshUser, ed25519KeyProvider(pairing.payload.sshClientPriv))
            Log.i(TAG, "authenticated; opening local forward …")

            val ss = ServerSocket(0, BACKLOG, InetAddress.getByName(LOOPBACK))
            localPort = ss.localPort
            serverSocket = ss

            val params = Parameters(LOOPBACK, localPort, LOOPBACK, pairing.daemonPort)
            val forwarder = ssh.newLocalPortForwarder(params, ss)
            // listen() blocks accepting forwarded connections — run it off-thread.
            forwardThread = Thread({
                try {
                    forwarder.listen()
                } catch (t: Throwable) {
                    Log.d(TAG, "port forwarder ended: ${t.message}")
                }
            }, "ps-ssh-forward").apply { isDaemon = true; start() }

            client = ssh
            Log.i(TAG, "SSH forward up: 127.0.0.1:$localPort -> $host:$port -> daemon:${pairing.daemonPort}")
            Forward(localPort = localPort)
        } catch (e: TransportException) {
            runCatching { ssh.disconnect() }
            throw e
        } catch (e: Throwable) {
            runCatching { ssh.disconnect() }
            if (isHostKeyFailure(e)) {
                throw HostKeyMismatchException(
                    "Host key for $host did not match the pinned fingerprint.", e,
                )
            }
            throw TransportException(e.message ?: "SSH connection failed", e)
        }
    }

    override fun close() {
        runCatching { serverSocket?.close() }
        runCatching { client?.disconnect() }
        forwardThread?.interrupt()
        serverSocket = null
        client = null
        forwardThread = null
        localPort = -1
    }

    // ── ed25519 key loading ──────────────────────────────────────────────────

    private fun ed25519KeyProvider(clientPrivField: String): KeyProvider {
        val seed = ed25519SeedFromPkcs8(clientPrivField)
        val curve = EdDSANamedCurveTable.getByName(EdDSANamedCurveTable.ED_25519)
        val privSpec = EdDSAPrivateKeySpec(seed, curve)
        val priv: PrivateKey = EdDSAPrivateKey(privSpec)
        val pub: PublicKey = EdDSAPublicKey(EdDSAPublicKeySpec(privSpec.a, curve))
        return object : KeyProvider {
            override fun getPrivate(): PrivateKey = priv
            override fun getPublic(): PublicKey = pub
            override fun getType(): KeyType = KeyType.ED25519
        }
    }

    /** The pairing field is base64 of a PKCS8 PEM; extract the 32-byte ed25519 seed. */
    private fun ed25519SeedFromPkcs8(field: String): ByteArray {
        val decoded = Base64.decode(field.trim(), Base64.DEFAULT)
        val der: ByteArray = run {
            val text = runCatching { String(decoded, Charsets.US_ASCII) }.getOrNull()
            if (text != null && text.contains("BEGIN") && text.contains("PRIVATE KEY")) {
                val body = text
                    .substringAfter("-----BEGIN", "")
                    .substringAfter("-----", "")
                    .substringBefore("-----END")
                    .replace("\\s".toRegex(), "")
                Base64.decode(body, Base64.DEFAULT)
            } else {
                decoded // already DER
            }
        }
        val pki = PrivateKeyInfo.getInstance(der)
        // RFC 8410: the Ed25519 private key is an OCTET STRING wrapping the 32-byte seed.
        val seed = ASN1OctetString.getInstance(pki.parsePrivateKey()).octets
        require(seed.size == 32) { "unexpected ed25519 seed length ${seed.size}" }
        return seed
    }

    companion object {
        private const val TAG = "SshTransport"
        private const val LOOPBACK = "127.0.0.1"
        private const val BACKLOG = 64
        private const val CONNECT_TIMEOUT_MS = 12_000
        private const val SOCKET_TIMEOUT_MS = 0 // 0 = no read timeout (long-lived forward).
        private const val KEEPALIVE_SEC = 20

        /** sshj surfaces a pinned-fingerprint rejection as a host-key verification failure. */
        private fun isHostKeyFailure(e: Throwable): Boolean {
            var t: Throwable? = e
            while (t != null) {
                val m = t.message?.lowercase().orEmpty()
                if ("host key" in m || "fingerprint" in m || "could not verify" in m) return true
                t = t.cause
            }
            return false
        }
    }
}

class TransportException(message: String, cause: Throwable? = null) : Exception(message, cause)

/** The SSH host key did not match the pinned fingerprint — fail closed (possible MITM). */
class HostKeyMismatchException(message: String, cause: Throwable? = null) :
    Exception(message, cause)
