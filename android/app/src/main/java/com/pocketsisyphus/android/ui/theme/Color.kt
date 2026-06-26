package com.pocketsisyphus.android.ui.theme

import androidx.compose.runtime.Immutable
import androidx.compose.ui.graphics.Color

/**
 * Semantic color contract — mirrors the iOS/Mac `Theme` (see repo CLAUDE.md «Color token policy»).
 * Color is meaning: write the semantic token, never a raw hue.
 *
 *  - accent  = purple : brand / selection / primary interactive (the default tint).
 *  - success = green  / danger = red / info = blue : status signals.
 *  - warning = yellow : genuine cautions only.
 *  - pro     = orange : membership / «advanced» grouping (emphasis, not warning).
 *  - Node kinds: start = green, task = pink, end = blue.
 */
@Immutable
object PsColor {
    val accent = Color(0xFF7C5CFF)
    val accentSoft = Color(0xFFB9A6FF)
    val success = Color(0xFF34C759)
    val danger = Color(0xFFFF453A)
    val warning = Color(0xFFFFD60A)
    val info = Color(0xFF0A84FF)
    val pro = Color(0xFFFF9F0A)

    val nodeStart = success
    val nodeTask = Color(0xFFFF6FB5)
    val nodeEnd = info

    // Dark surface ramp (terminal-first app → dark is the natural ground).
    val bg = Color(0xFF0E0B16)
    val surface = Color(0xFF161222)
    val surfaceHigh = Color(0xFF1F1A2E)
    val outline = Color(0xFF2E2842)
    val onBg = Color(0xFFEDE9F5)
    val onBgMuted = Color(0xFF9C95B5)

    // Light surface ramp (the same neutrals tuned for a white ground; accent contract unchanged).
    val bgLight = Color(0xFFFBFAFE)
    val surfaceLight = Color(0xFFFFFFFF)
    val surfaceHighLight = Color(0xFFEDEAF5)
    val outlineLight = Color(0xFFCBC6D8)
    val onBgLight = Color(0xFF1A1726)
    val onBgMutedLight = Color(0xFF615C70)

    // Terminal ANSI base palette (xterm defaults, dark scheme).
    val termBg = Color(0xFF0B0910)
    val termFg = Color(0xFFD7D3E0)
    val termCursor = Color(0xFFD7D3E0)

    // Terminal — light scheme. CLI output assumes a dark ground, so a perfect match is
    // impossible; readability wins (mirrors iOS `lightAnsiPalette` in ChatView). White bg with a
    // near-black fg/cursor; the 16-color ramp is toned down so light hues stay legible on white.
    val termBgLight = Color(0xFFFFFFFF)
    val termFgLight = Color(0xFF292929)
    val termCursorLight = Color(0xFF404040)
}
