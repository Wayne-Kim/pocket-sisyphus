package com.pocketsisyphus.android.data

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.Log
import androidx.biometric.BiometricManager
import com.pocketsisyphus.android.BuildConfig
import com.pocketsisyphus.android.DevBootstrap
import com.pocketsisyphus.android.data.model.PsJson
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.math.BigInteger
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec

class AttestException(message: String) : Exception(message)

/**
 * Device attestation, mirroring the daemon's P256 challenge-response (mac/daemon/src/attest.ts).
 * Once any device is enrolled on the daemon, every api request and WS must carry a valid
 * attest token, so this is required for the daily flow to work at all.
 *
 * Protocol (plain secp256r1 / ECDSA-SHA256, DER signatures — the same the iOS Secure Enclave uses):
 *   1. register  — POST api/attest/register {publicKey: b64 X9.63, signature: b64 DER over the pubkey bytes}
 *   2. challenge — GET  api/attest/challenge -> {nonce}
 *   3. verify    — POST api/attest/verify {nonce, signature: b64 DER over nonce UTF-8} -> {token, exp}
 * The token goes in the X-PS-Attest header (HTTP) / the attest query param (WS). The attest
 * routes are exempt from the gate and need only the daemon bearer token.
 *
 * The signing key lives in the Android Keystore (StrongBox-backed where available, else TEE) and
 * is gated behind biometrics: [authenticator] unlocks it before signing, the lost-phone
 * protection equivalent to iOS Face ID.
 */
class Attestation(
    private val conn: ConnectionManager,
    private val appContext: Context,
) {

    /** Set by the UI (an Activity) so signing can prompt for biometrics. */
    @Volatile var authenticator: AttestAuthenticator? = null

    private val jsonMedia = "application/json; charset=utf-8".toMediaType()
    private val mutex = Mutex()

    /** Whether a strong biometric is enrolled — decides if the key is auth-gated at creation. */
    private val biometricAvailable: Boolean by lazy {
        BiometricManager.from(appContext)
            .canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG) ==
            BiometricManager.BIOMETRIC_SUCCESS
    }

    private val keyInfo: KeyMaterial by lazy { loadOrCreateKey() }
    private val keyPair: KeyPair get() = keyInfo.pair

    @Volatile private var token: String? = null
    @Volatile private var exp: Long = 0

    val publicKeyB64: String by lazy { Base64.encodeToString(x963(keyPair.public as ECPublicKey), Base64.NO_WRAP) }

    /**
     * This device's attest-key fingerprint ("SHA256:<base64-no-padding>"), matching the daemon's
     * `fingerprintForPublicKey` and iOS `DeviceAttestor.publicKeyFingerprint()`. Used by the
     * settings «Devices» list to tag «this device». Returns null if the key is unavailable.
     */
    fun publicKeyFingerprint(): String? = runCatching {
        val raw = Base64.decode(publicKeyB64, Base64.NO_WRAP)
        val hash = java.security.MessageDigest.getInstance("SHA-256").digest(raw)
        "SHA256:" + Base64.encodeToString(hash, Base64.NO_WRAP or Base64.NO_PADDING)
    }.getOrNull()

    /** A currently-valid token (with skew), or null. */
    fun currentToken(): String? =
        token?.takeIf { System.currentTimeMillis() < exp - SKEW_MS }

    /** Ensure a valid attest token, enrolling this device first if needed. */
    suspend fun ensureToken(force: Boolean = false): String = mutex.withLock {
        // Dev direct-daemon pairing bypasses the attest gate with X-PS-Local / ?local=, so there
        // is no device to enroll and no token to mint (mirrors iOS DevPairing disabling the gate).
        if (BuildConfig.DEBUG && DevBootstrap.directActive) return ""
        if (!force) currentToken()?.let { return it }
        // One biometric unlock covers the enroll + verify signatures within the key's auth window.
        if (keyInfo.authGated) {
            authenticator?.authenticate()
                ?: Log.w(TAG, "attest key is biometric-gated but no UI host is set; signing may fail")
        }
        withContext(Dispatchers.IO) {
            enroll()
            val nonce = challenge()
            val (tok, e) = verify(nonce)
            token = tok
            exp = e
            tok
        }
    }

    // ── steps ───────────────────────────────────────────────────────────────

    private fun enroll() {
        val sig = signDer(Base64.decode(publicKeyB64, Base64.NO_WRAP))
        val body = """{"publicKey":${q(publicKeyB64)},"signature":${q(b64(sig))}}"""
        val (code, text) = post("/api/attest/register", body)
        if (code == 200) return
        if (code == 409) {
            // Idempotent registration of an already-registered key returns 200, so a 409 here
            // means there is genuinely no free slot for this new device.
            throw AttestException(
                "No device slot available on the Mac. Enable an extra device slot in Pocket " +
                    "Sisyphus settings, or unpair another device, then try again.",
            )
        }
        throw AttestException("Attestation register failed ($code): $text")
    }

    private fun challenge(): String {
        val (code, text) = get("/api/attest/challenge")
        if (code != 200) throw AttestException("Attestation challenge failed ($code)")
        return (PsJson.parseToJsonElement(text) as JsonObject)["nonce"]
            ?.jsonPrimitive?.contentOrNull
            ?: throw AttestException("Attestation challenge: no nonce")
    }

    private fun verify(nonce: String): Pair<String, Long> {
        val sig = signDer(nonce.toByteArray(Charsets.UTF_8))
        val body = """{"nonce":${q(nonce)},"signature":${q(b64(sig))}}"""
        val (code, text) = post("/api/attest/verify", body)
        if (code != 200) throw AttestException("Attestation verify failed ($code): $text")
        val obj = PsJson.parseToJsonElement(text) as JsonObject
        val tok = obj["token"]?.jsonPrimitive?.contentOrNull
            ?: throw AttestException("Attestation verify: no token")
        val e = obj["exp"]?.jsonPrimitive?.longOrNull ?: (System.currentTimeMillis() + 60_000)
        return tok to e
    }

    // ── crypto ────────────────────────────────────────────────────────────────

    private fun loadOrCreateKey(): KeyMaterial {
        val ks = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        (ks.getEntry(ALIAS, null) as? KeyStore.PrivateKeyEntry)?.let {
            return KeyMaterial(KeyPair(it.certificate.publicKey, it.privateKey), gatedFromExisting())
        }
        val gated = biometricAvailable
        // Prefer hardware StrongBox; fall back to TEE if the device lacks it.
        return runCatching { generateKey(gated, strongBox = true) }
            .getOrElse {
                Log.i(TAG, "StrongBox unavailable; using TEE-backed key (${it.message})")
                generateKey(gated, strongBox = false)
            }
    }

    private fun generateKey(gated: Boolean, strongBox: Boolean): KeyMaterial {
        val kpg = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, ANDROID_KEYSTORE)
        val spec = KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN)
            .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
            .setDigests(KeyProperties.DIGEST_SHA256)
            .apply {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && strongBox) {
                    setIsStrongBoxBacked(true)
                }
                if (gated) {
                    setUserAuthenticationRequired(true)
                    // Time-bound window so a single biometric covers the enroll + verify signs.
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                        setUserAuthenticationParameters(
                            AUTH_VALIDITY_SEC,
                            KeyProperties.AUTH_BIOMETRIC_STRONG,
                        )
                    } else {
                        @Suppress("DEPRECATION")
                        setUserAuthenticationValidityDurationSeconds(AUTH_VALIDITY_SEC)
                    }
                }
            }
            .build()
        kpg.initialize(spec)
        Log.i(TAG, "generated attest key (gated=$gated strongBox=$strongBox)")
        return KeyMaterial(kpg.generateKeyPair(), gated)
    }

    /** Existing keys created before this build may be ungated; assume gated iff biometrics exist. */
    private fun gatedFromExisting(): Boolean = biometricAvailable

    private data class KeyMaterial(val pair: KeyPair, val authGated: Boolean)

    private fun signDer(data: ByteArray): ByteArray =
        Signature.getInstance("SHA256withECDSA").run {
            initSign(keyPair.private)
            update(data)
            sign()
        }

    /** Uncompressed X9.63 encoding: 0x04 || X(32) || Y(32). */
    private fun x963(pub: ECPublicKey): ByteArray {
        val x = fixed32(pub.w.affineX)
        val y = fixed32(pub.w.affineY)
        return ByteArray(65).also {
            it[0] = 0x04
            System.arraycopy(x, 0, it, 1, 32)
            System.arraycopy(y, 0, it, 33, 32)
        }
    }

    private fun fixed32(v: BigInteger): ByteArray {
        val raw = v.toByteArray() // big-endian, possibly with a leading 0x00 sign byte or shorter
        val out = ByteArray(32)
        when {
            raw.size == 32 -> System.arraycopy(raw, 0, out, 0, 32)
            raw.size > 32 -> System.arraycopy(raw, raw.size - 32, out, 0, 32)
            else -> System.arraycopy(raw, 0, out, 32 - raw.size, raw.size)
        }
        return out
    }

    // ── http (bearer only; attest routes are gate-exempt) ──────────────────────

    private fun get(path: String): Pair<Int, String> = exec(authed(path).get().build())

    private fun post(path: String, json: String): Pair<Int, String> =
        exec(authed(path).post(json.toRequestBody(jsonMedia)).build())

    private fun authed(path: String): Request.Builder {
        val fwd = conn.forward ?: throw AttestException("Not connected")
        return Request.Builder()
            .url("${fwd.httpBase}$path")
            .header("Authorization", "Bearer ${conn.token}")
            .header("X-Client-Version", BuildConfig.VERSION_NAME)
    }

    private fun exec(req: Request): Pair<Int, String> =
        conn.http.newCall(req).execute().use { it.code to (it.body?.string().orEmpty()) }

    private fun b64(b: ByteArray) = Base64.encodeToString(b, Base64.NO_WRAP)
    private fun q(s: String) = "\"${s.replace("\\", "\\\\").replace("\"", "\\\"")}\""

    companion object {
        private const val TAG = "Attestation"
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val ALIAS = "ps_attest_p256"
        private const val SKEW_MS = 60_000L
        private const val AUTH_VALIDITY_SEC = 30
    }
}
