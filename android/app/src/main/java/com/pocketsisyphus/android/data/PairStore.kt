package com.pocketsisyphus.android.data

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.pocketsisyphus.android.data.model.PairPayload
import com.pocketsisyphus.android.data.model.PsJson
import java.io.File

/**
 * A paired daemon plus the LAN/direct host we actually dial.
 *
 * The QR payload's `onion` is only reachable over Tor (deferred). For LAN/SSH-direct we
 * dial [sshHost] — the user-supplied override (e.g. `10.0.2.2` from the emulator) or the
 * mDNS `lan_host`. SSH forwards to the daemon at remote `127.0.0.1:<daemonPort>`.
 */
data class Pairing(
    val payload: PairPayload,
    val hostOverride: String?,
) {
    val sshHost: String? get() = hostOverride?.takeIf { it.isNotBlank() } ?: payload.lanHost
    val sshPort: Int get() = payload.sshPort ?: DEFAULT_SSH_PORT
    val daemonPort: Int get() = payload.daemonPort ?: DEFAULT_DAEMON_PORT
    val canDialLan: Boolean get() = payload.isUsable && !sshHost.isNullOrBlank()

    companion object {
        const val DEFAULT_SSH_PORT = 22022
        const val DEFAULT_DAEMON_PORT = 7777
    }
}

/** Encrypted persistence for the pairing secret bundle (SSH key, tokens, onion auth). */
class PairStore(context: Context) {

    private val appContext = context.applicationContext

    private val prefs: SharedPreferences by lazy {
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        EncryptedSharedPreferences.create(
            context,
            FILE,
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

    fun save(payload: PairPayload, hostOverride: String?) {
        prefs.edit()
            .putString(KEY_PAYLOAD, PsJson.encodeToString(PairPayload.serializer(), payload))
            .putString(KEY_HOST_OVERRIDE, hostOverride?.trim().orEmpty())
            .apply()
    }

    fun load(): Pairing? {
        val raw = prefs.getString(KEY_PAYLOAD, null) ?: return null
        val payload = runCatching { PsJson.decodeFromString(PairPayload.serializer(), raw) }
            .getOrNull() ?: return null
        val host = prefs.getString(KEY_HOST_OVERRIDE, null)?.takeIf { it.isNotBlank() }
        return Pairing(payload, host)
    }

    fun clear() {
        prefs.edit().clear().apply()
        // BL-08: onion client-auth x25519 키는 Tor 가 디스크 경로(ClientOnionAuthDir)를 요구해
        // EncryptedSharedPreferences 밖 «평문 파일»(filesDir/onion_auth/)로만 존재한다(TorManager
        // ONION_AUTH_DIR). 페어링 해제 때 prefs 만 비우면 이 키가 잔존(루팅/포렌식 회수 가능)하므로
        // 디렉터리째 삭제해 해제 후 잔존 비밀을 없앤다.
        runCatching { File(appContext.filesDir, "onion_auth").deleteRecursively() }
    }

    val isPaired: Boolean get() = prefs.contains(KEY_PAYLOAD)

    companion object {
        private const val FILE = "ps_secure_prefs"
        private const val KEY_PAYLOAD = "pair_payload_json"
        private const val KEY_HOST_OVERRIDE = "host_override"
    }
}
