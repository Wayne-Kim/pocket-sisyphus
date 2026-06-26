package com.pocketsisyphus.android

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.util.Base64
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.fragment.app.FragmentActivity
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import com.pocketsisyphus.android.data.AgentWaitNotifier
import com.pocketsisyphus.android.data.BiometricAuthenticator
import com.pocketsisyphus.android.data.BiometricLockAuthenticator
import com.pocketsisyphus.android.data.LocalePrefs
import com.pocketsisyphus.android.data.Ps
import com.pocketsisyphus.android.data.ThemePrefs
import androidx.compose.ui.Modifier
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.pocketsisyphus.android.ui.AppRoot
import com.pocketsisyphus.android.ui.theme.PocketSisyphusTheme

class MainActivity : FragmentActivity() {
    private val notifPermissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { /* in-app still works if denied */ }

    override fun attachBaseContext(newBase: Context) {
        super.attachBaseContext(LocalePrefs.wrap(newBase))
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        // Provide a biometric prompt host so the attest-key signature can be unlocked
        // (Face/fingerprint). Cleared in onDestroy to avoid leaking the activity.
        Ps.attest.authenticator = BiometricAuthenticator(this)
        // Host for the app-entry lock screen's unlock prompt (biometric or device credential).
        Ps.appLock.authenticator = BiometricLockAuthenticator(this)
        if (BuildConfig.DEBUG) {
            intent?.getStringExtra("devHost")?.let { DevBootstrap.host = it }
            // Direct-daemon dev pairing (the iOS-simulator equivalent): token + localAdminSecret
            // + port from the Mac's config.json — no QR/SSH/Tor. See DevBootstrap.
            intent?.getStringExtra("devDaemonToken")?.let { DevBootstrap.daemonToken = it.ifEmpty { null } }
            intent?.getStringExtra("devLocalSecret")?.let { DevBootstrap.localSecret = it.ifEmpty { null } }
            (intent?.getStringExtra("devDaemonPort")?.toIntOrNull()
                ?: intent?.getIntExtra("devDaemonPort", 0)?.takeIf { it > 0 })
                ?.let { DevBootstrap.daemonPort = it }
            // Full-payload dev pairing: a real QR JSON run through the normal pairing flow.
            intent?.getStringExtra("devPairingB64")?.let { b64 ->
                runCatching { DevBootstrap.payloadJson = String(Base64.decode(b64, Base64.DEFAULT)) }
            }
            // Force the app-entry lock on for visual verification (no paired daemon needed).
            if (intent?.getBooleanExtra("devForceLock", false) == true) Ps.appLock.devForceLock()
        }
        handleDeepLinkIntent(intent)
        maybeRequestNotificationPermission()
        setContent { App() }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleDeepLinkIntent(intent)
    }

    override fun onResume() {
        super.onResume()
        Ps.waitNotifier.setAppForeground(true)
    }

    override fun onPause() {
        super.onPause()
        Ps.waitNotifier.setAppForeground(false)
    }

    override fun onStart() {
        super.onStart()
        // Re-lock when returning to the foreground past the grace window (drives the lock screen).
        Ps.appLock.onEnterForeground()
    }

    override fun onStop() {
        super.onStop()
        Ps.appLock.onEnterBackground()
    }

    /** Notification tap → deep-link into the session detail (AppRoot consumes the pending id). */
    private fun handleDeepLinkIntent(intent: Intent?) {
        intent?.getStringExtra(AgentWaitNotifier.EXTRA_OPEN_SESSION)?.let { sid ->
            Ps.waitNotifier.requestDeepLink(sid)
        }
    }

    /** Android 13+ POST_NOTIFICATIONS runtime request — denial only disables notifications. */
    private fun maybeRequestNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        val granted = checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
        if (!granted) notifPermissionLauncher.launch(android.Manifest.permission.POST_NOTIFICATIONS)
    }

    override fun onDestroy() {
        if (Ps.attest.authenticator is BiometricAuthenticator) {
            Ps.attest.authenticator = null
        }
        if (Ps.appLock.authenticator is BiometricLockAuthenticator) {
            Ps.appLock.authenticator = null
        }
        super.onDestroy()
    }
}

@Composable
private fun App() {
    val mode by ThemePrefs.mode.collectAsStateWithLifecycle()
    val dark = when (mode) {
        ThemePrefs.Mode.SYSTEM -> isSystemInDarkTheme()
        ThemePrefs.Mode.LIGHT -> false
        ThemePrefs.Mode.DARK -> true
    }
    PocketSisyphusTheme(dark = dark) {
        Surface(modifier = Modifier.fillMaxSize()) {
            AppRoot()
        }
    }
}
