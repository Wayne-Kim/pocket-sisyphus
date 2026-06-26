package com.pocketsisyphus.android.terminal

import androidx.compose.ui.graphics.Color
import com.pocketsisyphus.android.ui.theme.PsColor

/**
 * Color-token model for terminal cells. A token is an Int:
 *   - [DEFAULT_FG] / [DEFAULT_BG]   : the theme's default fg/bg (negative sentinels)
 *   - 0..255                        : an xterm-256 palette index
 *   - has [TRUECOLOR_FLAG] set      : 24-bit RGB in the low bits
 *
 * The emulator emits these tokens; resolving a token to an actual [Color] depends on the app
 * theme (light/dark) and so lives on [TermPalette], not here.
 */
object TermColor {
    const val DEFAULT_FG = -1
    const val DEFAULT_BG = -2
    const val TRUECOLOR_FLAG = 0x1000000

    fun truecolor(r: Int, g: Int, b: Int): Int =
        TRUECOLOR_FLAG or ((r and 0xFF) shl 16) or ((g and 0xFF) shl 8) or (b and 0xFF)
}

/**
 * A resolved terminal palette for one app theme. The terminal used to be locked to dark; it now
 * follows the app's light/dark theme so a light app doesn't leave a black box on screen — mirrors
 * the iOS `applyTerminalTheme` (dark/light ANSI palettes in ChatView).
 *
 * Only the default fg/bg/cursor and the 16 system colors differ between themes; the xterm-256 cube
 * and gray ramp are computed identically for both (matching iOS, which only re-installs the 16).
 */
class TermPalette(
    val defaultFg: Color,
    val defaultBg: Color,
    val cursor: Color,
    system16: Array<Color>,
) {
    // Standard xterm-256 palette: 16 system + 6×6×6 cube + 24 grays.
    private val palette: Array<Color> = Array(256) { i ->
        when {
            i < 16 -> system16[i]
            i < 232 -> {
                val n = i - 16
                rgb(cubeLevel(n / 36), cubeLevel((n % 36) / 6), cubeLevel(n % 6))
            }
            else -> {
                val v = 8 + (i - 232) * 10
                rgb(v, v, v)
            }
        }
    }

    fun resolve(token: Int, isFg: Boolean): Color = when {
        token == TermColor.DEFAULT_FG -> defaultFg
        token == TermColor.DEFAULT_BG -> defaultBg
        token and TermColor.TRUECOLOR_FLAG != 0 ->
            Color(0xFF000000L or (token and 0xFFFFFF).toLong())
        token in 0..255 -> palette[token]
        else -> if (isFg) defaultFg else defaultBg
    }

    companion object {
        private fun rgb(r: Int, g: Int, b: Int): Color =
            Color(0xFF000000L or (r.toLong() shl 16) or (g.toLong() shl 8) or b.toLong())

        private fun cubeLevel(c: Int): Int = if (c == 0) 0 else 55 + c * 40

        // Dark system-16 (Snazzy-leaning, tuned for dark backgrounds).
        private val darkSystem16 = arrayOf(
            Color(0xFF1B1B1B), // 0 black (lifted off pure black for readability)
            Color(0xFFFF5C57), // 1 red
            Color(0xFF5AF78E), // 2 green
            Color(0xFFF3F99D), // 3 yellow
            Color(0xFF57C7FF), // 4 blue
            Color(0xFFFF6AC1), // 5 magenta
            Color(0xFF9AEDFE), // 6 cyan
            Color(0xFFD7D3E0), // 7 white
            Color(0xFF686868), // 8 bright black
            Color(0xFFFF6E67), // 9 bright red
            Color(0xFF5AF78E), // 10 bright green
            Color(0xFFF3F99D), // 11 bright yellow
            Color(0xFF57C7FF), // 12 bright blue
            Color(0xFFFF6AC1), // 13 bright magenta
            Color(0xFF9AEDFE), // 14 bright cyan
            Color(0xFFFFFFFF), // 15 bright white
        )

        // Light system-16 — readability-corrected for a white background (values mirror the iOS
        // `lightAnsiPalette`): «white» (idx 7·15) is darkened so white-on-white doesn't vanish, and
        // bright hues are toned down for contrast.
        private val lightSystem16 = arrayOf(
            Color(0xFF000000), // 0 black
            Color(0xFFAA0000), // 1 red
            Color(0xFF008200), // 2 green
            Color(0xFF966E00), // 3 yellow
            Color(0xFF0000BE), // 4 blue
            Color(0xFFA000A0), // 5 magenta
            Color(0xFF008296), // 6 cyan
            Color(0xFF505050), // 7 white
            Color(0xFF787878), // 8 bright black
            Color(0xFFC80000), // 9 bright red
            Color(0xFF009600), // 10 bright green
            Color(0xFFAA7800), // 11 bright yellow
            Color(0xFF0000D2), // 12 bright blue
            Color(0xFFBE00BE), // 13 bright magenta
            Color(0xFF0096AA), // 14 bright cyan
            Color(0xFF1E1E1E), // 15 bright white
        )

        val Dark = TermPalette(
            defaultFg = PsColor.termFg,
            defaultBg = PsColor.termBg,
            cursor = PsColor.termCursor,
            system16 = darkSystem16,
        )

        val Light = TermPalette(
            defaultFg = PsColor.termFgLight,
            defaultBg = PsColor.termBgLight,
            cursor = PsColor.termCursorLight,
            system16 = lightSystem16,
        )

        fun forDark(dark: Boolean): TermPalette = if (dark) Dark else Light
    }
}
