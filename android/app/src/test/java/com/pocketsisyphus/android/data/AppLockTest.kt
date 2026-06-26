package com.pocketsisyphus.android.data

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AppLockTest {

    /** A controllable monotonic clock for the grace-window math. */
    private class FakeClock(var nowMs: Long = 0L) {
        fun read(): Long = nowMs
        fun advance(ms: Long) { nowMs += ms }
    }

    private fun lock(paired: Boolean, clock: FakeClock) =
        AppLock(isPaired = { paired }, now = clock::read)

    @Test
    fun coldLaunchWhilePaired_startsLocked() {
        assertTrue(lock(paired = true, FakeClock()).locked.value)
    }

    @Test
    fun coldLaunchWhileUnpaired_startsUnlocked() {
        assertFalse(lock(paired = false, FakeClock()).locked.value)
    }

    @Test
    fun markUnlocked_revealsMainUi() {
        val appLock = lock(paired = true, FakeClock())
        appLock.markUnlocked()
        assertFalse(appLock.locked.value)
    }

    @Test
    fun shortBackground_underGrace_staysUnlocked() {
        val clock = FakeClock()
        val appLock = lock(paired = true, clock)
        appLock.markUnlocked()

        appLock.onEnterBackground()
        clock.advance(AppLock.GRACE_MS - 1)
        appLock.onEnterForeground()

        assertFalse("a quick app-switch must not re-lock", appLock.locked.value)
    }

    @Test
    fun longBackground_pastGrace_reLocks() {
        val clock = FakeClock()
        val appLock = lock(paired = true, clock)
        appLock.markUnlocked()

        appLock.onEnterBackground()
        clock.advance(AppLock.GRACE_MS)
        appLock.onEnterForeground()

        assertTrue("past the grace window must re-lock", appLock.locked.value)
    }

    @Test
    fun rotation_doesNotReLock() {
        val clock = FakeClock()
        val appLock = lock(paired = true, clock)
        appLock.markUnlocked()

        // Activity recreation: onStop → onStart with ~no elapsed time.
        appLock.onEnterBackground()
        appLock.onEnterForeground()

        assertFalse(appLock.locked.value)
    }

    @Test
    fun unpairedInBackground_neverGatesOnboarding() {
        val clock = FakeClock()
        var paired = true
        val appLock = AppLock(isPaired = { paired }, now = clock::read)
        appLock.markUnlocked()

        appLock.onEnterBackground()
        clock.advance(AppLock.GRACE_MS * 2)
        paired = false
        appLock.onEnterForeground()

        assertFalse("onboarding is never locked", appLock.locked.value)
    }

    @Test
    fun onUnpaired_dropsLock() {
        val appLock = lock(paired = true, FakeClock())
        appLock.onUnpaired()
        assertFalse(appLock.locked.value)
    }
}
