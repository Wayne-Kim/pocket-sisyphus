package com.pocketsisyphus.android.data

import android.util.Log
import com.pocketsisyphus.android.data.model.EndpointResponse
import com.pocketsisyphus.android.data.model.PsJson
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.net.InetSocketAddress
import java.net.Proxy
import java.util.concurrent.TimeUnit

class EndpointException(message: String, cause: Throwable? = null) : Exception(message, cause)

/**
 * Fetches the daemon's `GET /endpoint` over the Tor onion (its endpoint-only HTTP listener,
 * `mac/daemon/src/routes/endpoint.ts`). The response carries the reachable SSH candidates
 * (`direct_ipv6` / `direct_ipv4` / `tor_onion`) plus the host-key fingerprint and the daemon's
 * local port — the input to happy-eyeballs candidate selection.
 *
 * Transport: OkHttp routed through the local Tor SOCKS5 proxy. OkHttp skips local DNS for a
 * SOCKS proxy and hands the `.onion` host to the proxy for remote resolution.
 */
class EndpointResolver {

    suspend fun fetch(
        onion: String,
        endpointToken: String,
        socksPort: Int,
    ): EndpointResponse = withContext(Dispatchers.IO) {
        val host = onion.removeSuffix("/")
        val client = OkHttpClient.Builder()
            .proxy(Proxy(Proxy.Type.SOCKS, InetSocketAddress("127.0.0.1", socksPort)))
            .connectTimeout(ENDPOINT_TIMEOUT_SEC, TimeUnit.SECONDS)
            .readTimeout(ENDPOINT_TIMEOUT_SEC, TimeUnit.SECONDS)
            .build()
        val req = Request.Builder()
            .url("http://$host/endpoint")
            .header("Authorization", "Bearer $endpointToken")
            .get()
            .build()
        try {
            client.newCall(req).execute().use { resp ->
                val text = resp.body?.string().orEmpty()
                if (!resp.isSuccessful) {
                    throw EndpointException("/endpoint over Tor failed (${resp.code})")
                }
                Log.i(TAG, "/endpoint ok over Tor")
                PsJson.decodeFromString(EndpointResponse.serializer(), text)
            }
        } catch (e: EndpointException) {
            throw e
        } catch (e: Throwable) {
            throw EndpointException(e.message ?: "/endpoint over Tor failed", e)
        }
    }

    companion object {
        private const val TAG = "EndpointResolver"
        private const val ENDPOINT_TIMEOUT_SEC = 45L
    }
}
