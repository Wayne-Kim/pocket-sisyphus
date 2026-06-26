package com.pocketsisyphus.android

import android.app.Application
import android.util.Log
import com.pocketsisyphus.android.data.Ps
import com.pocketsisyphus.android.data.ThemePrefs
import org.bouncycastle.jce.provider.BouncyCastleProvider
import java.security.Security

/**
 * Application entry point.
 *
 * Android ships a stripped-down BouncyCastle as the "BC" provider, which lacks the
 * algorithms sshj needs (ed25519, modern KEX/ciphers). We swap in the full
 * `bcprov-jdk18on` provider at the top of the provider list, once, before any SSH work.
 */
class PsApp : Application() {
    override fun onCreate() {
        super.onCreate()
        try {
            // Replace Android's stripped "BC" with the full bcprov, but register it at the
            // LOWEST priority (addProvider appends) — NOT position 1. sshj looks up "BC" by
            // name, so priority doesn't matter for it; meanwhile keeping the platform
            // (Conscrypt) provider as the default means `new SecureRandom()` stays the
            // non-blocking /dev/urandom source. Inserting BC at position 1 made it the default
            // SecureRandom, whose DRBG seeding blocks indefinitely on the emulator's low entropy.
            Security.removeProvider("BC")
            Security.addProvider(BouncyCastleProvider())
        } catch (t: Throwable) {
            Log.w("PsApp", "BouncyCastle provider swap failed", t)
        }
        // Load the saved light/dark/system choice before the first composition so the app opens
        // in the chosen theme (no flash of the default).
        ThemePrefs.load(this)
        Ps.init(this)
    }
}
