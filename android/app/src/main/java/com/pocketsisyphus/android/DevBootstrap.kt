package com.pocketsisyphus.android

/**
 * Debug-only dev pairing injection — the Android twin of iOS `DevPairing.swift`.
 *
 * QR scanning is awkward on an emulator (no real camera), so two independent bypass modes are
 * populated from [MainActivity] launch-intent extras behind `BuildConfig.DEBUG` (no effect in
 * release builds):
 *
 * 1. **Direct daemon** (preferred — the iOS-simulator equivalent). Skip QR/SSH/Tor entirely and
 *    talk straight to the host Mac's daemon over the emulator's loopback alias. Needs only the
 *    three values from the Mac's `config.json`:
 *
 *        adb shell am start -n com.pocketsisyphus.android/.MainActivity \
 *            --es devDaemonToken "<config.json token>" \
 *            --es devLocalSecret "<config.json localAdminSecret>" \
 *            --ei devDaemonPort 7777 \
 *            --es devHost 10.0.2.2
 *
 *    The connection layer dials `http://<host>:<port>` directly and bypasses the daemon attest
 *    gate with the X-PS-Local header (HTTP) / `?local=` query (WS) — the same path the Mac app
 *    uses (daemon `attest.ts` `isLocalAdmin`). `/scripts/dev-android.sh` fills these in for you.
 *
 * 2. **Full payload** — inject a real QR pairing JSON and run the normal SSH/Tor pairing flow:
 *
 *        adb shell am start ... --es devPairingB64 "<base64 of the pairing JSON>" --es devHost 10.0.2.2
 */
object DevBootstrap {
    /** From the emulator the host Mac's loopback is reachable as `10.0.2.2`. Shared by both modes. */
    @Volatile var host: String = "10.0.2.2"

    // ── direct-daemon mode (no QR / SSH / Tor) ─────────────────────────────────
    /** Plaintext daemon bearer (`config.json` `token`). Presence flips [directActive] on. */
    @Volatile var daemonToken: String? = null
    /** `config.json` `localAdminSecret` — the X-PS-Local / `?local=` attest-gate bypass secret. */
    @Volatile var localSecret: String? = null
    /** Daemon HTTP port (`config.json` `port`). */
    @Volatile var daemonPort: Int = 7777

    /** Direct-daemon dev pairing active — short-circuit SSH/Tor and dial the host loopback. */
    val directActive: Boolean get() = !daemonToken.isNullOrEmpty()

    // ── full-payload mode (real SSH/Tor flow) ──────────────────────────────────
    @Volatile var payloadJson: String? = null
}
