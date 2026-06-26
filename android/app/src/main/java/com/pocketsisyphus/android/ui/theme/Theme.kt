package com.pocketsisyphus.android.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color

private val DarkColors = darkColorScheme(
    primary = PsColor.accent,
    onPrimary = Color.White,
    secondary = PsColor.accentSoft,
    background = PsColor.bg,
    onBackground = PsColor.onBg,
    surface = PsColor.surface,
    onSurface = PsColor.onBg,
    surfaceVariant = PsColor.surfaceHigh,
    onSurfaceVariant = PsColor.onBgMuted,
    outline = PsColor.outline,
    error = PsColor.danger,
)

// Light scheme — brand accent over Material's light neutrals. Surfaces/text are spelled out (not
// left to Material defaults) so the light theme reads as deliberate, not "uncolored", and keeps the
// same accent contract as dark.
private val LightColors = lightColorScheme(
    primary = PsColor.accent,
    onPrimary = Color.White,
    secondary = PsColor.accentSoft,
    background = PsColor.bgLight,
    onBackground = PsColor.onBgLight,
    surface = PsColor.surfaceLight,
    onSurface = PsColor.onBgLight,
    surfaceVariant = PsColor.surfaceHighLight,
    onSurfaceVariant = PsColor.onBgMutedLight,
    outline = PsColor.outlineLight,
    error = PsColor.danger,
)

/**
 * Resolved light/dark state for the current theme, provided by [PocketSisyphusTheme]. Components
 * that draw their own palette outside Material (e.g. the terminal) read this instead of recomputing
 * `isSystemInDarkTheme()` + the theme override.
 */
val LocalPsDarkTheme = staticCompositionLocalOf { true }

@Composable
fun PocketSisyphusTheme(
    dark: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    CompositionLocalProvider(LocalPsDarkTheme provides dark) {
        MaterialTheme(
            colorScheme = if (dark) DarkColors else LightColors,
            typography = Typography(),
            content = content,
        )
    }
}
