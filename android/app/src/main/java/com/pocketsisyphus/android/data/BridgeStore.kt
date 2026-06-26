package com.pocketsisyphus.android.data

import android.content.Context
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * One parsed «bridge line».
 *
 * Follows torrc `Bridge` directive syntax — byte-identical to the iOS `TorBridgeLine` contract so a
 * user can paste the *same* line on either phone:
 *   - vanilla:   `IP:PORT [FINGERPRINT]`                        (a «hidden» relay, no transport)
 *   - PT(obfs4): `obfs4 IP:PORT FINGERPRINT cert=… iat-mode=0`  (pluggable transport)
 * A pasted line may carry a leading torrc keyword `Bridge ` — we strip it.
 */
data class TorBridgeLine(
    /** `Bridge ` keyword stripped, whitespace collapsed — the form fed straight to `--Bridge`. */
    val normalized: String,
    /** Transport name, or null for vanilla (no transport). */
    val transport: String?,
    /** `host:port` (`[ipv6]:port`). */
    val address: String,
    /** 40-hex relay fingerprint, when present. */
    val fingerprint: String?,
) {
    val transportLower: String? get() = transport?.lowercase()
    val isPluggable: Boolean get() = transport != null
}

/** Parses multi-line bridge text. Blank lines / `#` comments are ignored. */
object TorBridgeParser {
    data class Result(val valid: List<TorBridgeLine>, val invalid: List<String>)

    fun parse(text: String): Result {
        val valid = mutableListOf<TorBridgeLine>()
        val invalid = mutableListOf<String>()
        val seen = mutableSetOf<String>()

        for (rawLine in text.split('\n', '\r')) {
            var line = rawLine.trim()
            if (line.isEmpty() || line.startsWith("#")) continue
            // Strip a leading torrc-style «Bridge » keyword (case-insensitive).
            if (line.lowercase().startsWith("bridge ")) {
                line = line.substring("bridge ".length).trim()
            }
            val tokens = line.split(Regex("[ \t]+")).filter { it.isNotEmpty() }
            if (tokens.isEmpty()) continue

            var transport: String? = null
            var rest = tokens
            // If the first token isn't an address (host:port) it's the transport name.
            if (!isAddress(tokens[0])) {
                transport = tokens[0]
                rest = tokens.drop(1)
            }
            val first = rest.firstOrNull()
            if (first == null || !isAddress(first)) {
                invalid.add(rawLine.trim())
                continue
            }
            val address = first
            val fingerprint = if (rest.size >= 2 && isFingerprint(rest[1])) rest[1] else null

            val normalized = (listOfNotNull(transport) + rest).joinToString(" ")
            if (!seen.add(normalized)) continue   // drop duplicate lines
            valid.add(TorBridgeLine(normalized, transport, address, fingerprint))
        }
        return Result(valid, invalid)
    }

    /** `host:port` / `[ipv6]:port` — the part after the last «:» must be a 1–65535 port. */
    fun isAddress(t: String): Boolean {
        val colon = t.lastIndexOf(':')
        if (colon <= 0 || colon == t.length - 1) return false
        val port = t.substring(colon + 1).toIntOrNull() ?: return false
        if (port !in 1..65535) return false
        return t.substring(0, colon).isNotEmpty()
    }

    /** 40-hex SHA1 relay fingerprint (optional token). */
    fun isFingerprint(t: String): Boolean =
        t.length == 40 && t.all { it.isDigit() || it in 'a'..'f' || it in 'A'..'F' }
}

/**
 * «Tor bridge» user setting + runtime status holder.
 *
 * An **optional** bypass that keeps the onion fallback alive on networks where plaintext Tor is
 * DPI-blocked (schools, offices, some countries). Users who never enable it are wholly unaffected —
 * plaintext Tor is always tried first, bridges only on a stall ([TorManager]). Mirrors the iOS
 * `TorBridgeStore`, including the bridge-line format so the same line works on both phones.
 *
 * obfs4 (and other pluggable transports) need a separate PT binary that this build does *not* ship
 * (`tor-android` carries only `libtor.so`) — so [obfs4Available] is false and only vanilla bridges
 * are attempted, exactly like iOS when `PluggableTransport` is unavailable. The UI warns when obfs4
 * lines are present.
 */
class BridgeStore(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    /** bridge-through connection runtime status — [TorManager] updates it, the UI shows it. */
    sealed interface Status {
        data object Idle : Status          // not attempted (plaintext Tor only, or unused)
        data object Connecting : Status    // bootstrapping through a bridge
        data object Connected : Status     // Tor came up through a bridge
        data class Failed(val reason: String) : Status  // bridges failed too (reason)
    }

    private val _enabled = MutableStateFlow(prefs.getBoolean(KEY_ENABLED, false))
    /** Whether the user turned bridges on. Off ⇒ no fallback ever happens. */
    val enabled: StateFlow<Boolean> = _enabled.asStateFlow()

    private val _linesText = MutableStateFlow(prefs.getString(KEY_LINES, "").orEmpty())
    /** Pasted raw multi-line bridge text (kept verbatim for easy editing). */
    val linesText: StateFlow<String> = _linesText.asStateFlow()

    private val _status = MutableStateFlow<Status>(Status.Idle)
    /** Runtime status — display-only, not persisted. */
    val status: StateFlow<Status> = _status.asStateFlow()

    fun setEnabled(value: Boolean) {
        _enabled.value = value
        prefs.edit().putBoolean(KEY_ENABLED, value).apply()
    }

    fun setLinesText(value: String) {
        _linesText.value = value
        prefs.edit().putString(KEY_LINES, value).apply()
    }

    fun setStatus(value: Status) { _status.value = value }

    // ── parse-derived values ────────────────────────────────────────────────

    val parsed: TorBridgeParser.Result get() = TorBridgeParser.parse(_linesText.value)
    val usesObfs4: Boolean get() = parsed.valid.any { it.transportLower == "obfs4" }

    /**
     * Bridge lines actually attemptable as tor `--Bridge` arguments. Vanilla always; obfs4 only when
     * the PT is available (never, in this build). Other transports are excluded.
     */
    fun usableBridgeLines(ptObfs4Available: Boolean): List<String> =
        parsed.valid.mapNotNull { line ->
            when (line.transportLower) {
                null -> line.normalized                                    // vanilla
                "obfs4" -> if (ptObfs4Available) line.normalized else null // needs PT
                else -> null                                               // unsupported transport
            }
        }

    companion object {
        private const val FILE = "ps_bridge_prefs"
        private const val KEY_ENABLED = "tor.bridge.enabled.v1"
        private const val KEY_LINES = "tor.bridge.lines.v1"

        /**
         * Whether this build can run the obfs4 pluggable transport.
         *
         * `info.guardianproject:tor-android` ships only `libtor.so` — no obfs4proxy binary — so obfs4
         * bridges cannot be dialed (same situation as iOS without `IPtProxy`). Vanilla bridges still
         * work. Bundling obfs4 is an explicit non-goal of this brief.
         */
        const val obfs4Available: Boolean = false
    }
}
