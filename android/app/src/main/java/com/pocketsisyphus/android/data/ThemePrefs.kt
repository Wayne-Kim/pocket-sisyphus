package com.pocketsisyphus.android.data

import android.content.Context
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * App theme override — system / light / dark, mirroring the iOS `ThemeMode` (`@AppStorage
 * "ui.themeMode"`). The app used to follow only the device dark setting, leaving no in-app way to
 * pick a theme; this persists the user's choice and exposes it as a reactive [mode] so the whole
 * UI re-themes instantly (no `Activity.recreate()` — unlike the language override, the color scheme
 * is recomposable in place).
 *
 * `SYSTEM` follows the device light/dark setting. The choice is not a secret, so plain
 * SharedPreferences is fine. Load once in [com.pocketsisyphus.android.PsApp] before first compose.
 */
object ThemePrefs {
    enum class Mode { SYSTEM, LIGHT, DARK }

    private const val FILE = "ps_theme_prefs"
    private const val KEY_MODE = "app_theme_mode"

    private val _mode = MutableStateFlow(Mode.SYSTEM)

    /** The selected theme mode (reactive). Defaults to [Mode.SYSTEM] until [load] runs. */
    val mode: StateFlow<Mode> = _mode.asStateFlow()

    /** Read the persisted mode into [mode]. Call once at app start. */
    fun load(context: Context) {
        val raw = prefs(context).getString(KEY_MODE, null)
        _mode.value = raw?.let { runCatching { Mode.valueOf(it) }.getOrNull() } ?: Mode.SYSTEM
    }

    /** Persist and broadcast a new theme mode. */
    fun setMode(context: Context, mode: Mode) {
        _mode.value = mode
        prefs(context).edit().putString(KEY_MODE, mode.name).apply()
    }

    private fun prefs(context: Context) =
        context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)
}
