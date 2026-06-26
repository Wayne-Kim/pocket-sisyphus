package com.pocketsisyphus.android.data

import android.os.SystemClock
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * App-entry lock — the Android equivalent of the iPhone «lost-phone protection».
 *
 * On Android the attest key is only biometric-gated at *signing* time; nothing stops a thief from
 * opening an already-running app and seeing the paired Mac sessions/terminal. This gate puts a
 * [com.pocketsisyphus.android.ui.lock.LockScreen] in front of the main UI on a cold launch (and
 * after the app has been in the background past a grace window), requiring a biometric / device
 * credential before the sessions become visible.
 *
 * State rules (the single source of truth for «is the UI gated right now»):
 *  - Onboarding (not paired) is *never* gated — a fresh install must be able to pair.
 *  - A cold launch while paired starts locked.
 *  - Returning to the foreground after ≥ [GRACE_MS] in the background re-locks (only when paired);
 *    a quick app-switch under the grace window does not, so the gate isn't naggy.
 *  - The locked flag lives process-wide, so a configuration change (rotation) or an authentication
 *    interrupted mid-prompt keeps the app locked rather than slipping through.
 *
 * The lock state is intentionally not persisted: process death + cold relaunch re-derives it from
 * the pairing status, which is exactly «cold launch while paired → locked».
 *
 * [isPaired] and [now] are injected so the grace logic is unit-testable off-device.
 */
class AppLock(
    private val isPaired: () -> Boolean,
    private val now: () -> Long = SystemClock::elapsedRealtime,
) {

    /** Set by the hosting Activity so the lock screen can raise a biometric / credential prompt. */
    @Volatile
    var authenticator: LockAuthenticator? = null

    private val _locked = MutableStateFlow(isPaired())

    /** Whether the main UI must stay hidden behind the lock screen. */
    val locked: StateFlow<Boolean> = _locked.asStateFlow()

    /** Monotonic timestamp of when the app last entered the background while unlocked. */
    private var backgroundedAt: Long? = null

    /** Authentication succeeded — reveal the main UI for this foreground session. */
    fun markUnlocked() {
        backgroundedAt = null
        _locked.value = false
    }

    /** DEBUG-only: force the lock screen on (for visual verification without a paired daemon). */
    fun devForceLock() {
        _locked.value = true
    }

    /** The device was unpaired — drop back to onboarding, which is never gated. */
    fun onUnpaired() {
        backgroundedAt = null
        _locked.value = false
    }

    /** Activity `onStop` — remember when we left so the foreground check can apply the grace window. */
    fun onEnterBackground() {
        // Only meaningful while unlocked; if we're already locked there's nothing to re-lock.
        if (!_locked.value) backgroundedAt = now()
    }

    /** Activity `onStart` — re-lock if paired and the background gap exceeded the grace window. */
    fun onEnterForeground() {
        if (!isPaired()) {
            // Unpaired in the background (or never paired): onboarding is never gated.
            backgroundedAt = null
            _locked.value = false
            return
        }
        val since = backgroundedAt ?: return
        backgroundedAt = null
        if (now() - since >= GRACE_MS) _locked.value = true
    }

    companion object {
        /**
         * How long the app may sit in the background before a return re-locks it. Long enough that a
         * quick app-switch (copy a token, glance at a notification) isn't annoying, short enough that
         * a misplaced phone re-locks promptly.
         */
        const val GRACE_MS = 60_000L
    }
}

/** Outcome of an app-unlock attempt, classified so the lock screen can pick matching recovery copy. */
sealed interface UnlockResult {
    /** Biometric / device credential confirmed. */
    data object Success : UnlockResult

    /** User or system dismissed the prompt (cancel, app-switch, back). Offer a retry. */
    data object Canceled : UnlockResult

    /** Biometrics locked out after repeated failures — recover via the device passcode. */
    data object Lockout : UnlockResult

    /** No biometric and no device credential is enrolled — the user must set up a screen lock. */
    data object Unavailable : UnlockResult

    /** Anything else; carries an already-localized system message when one is available. */
    data class Error(val message: String?) : UnlockResult
}

/** Raises the unlock prompt. Backed by [BiometricLockAuthenticator]; needs a `FragmentActivity` host. */
interface LockAuthenticator {
    suspend fun authenticate(): UnlockResult
}
