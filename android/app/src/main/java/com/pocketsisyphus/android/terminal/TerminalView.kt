package com.pocketsisyphus.android.terminal

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.material3.Text
import com.pocketsisyphus.android.ui.theme.LocalPsDarkTheme

/**
 * Renders a [TermFrame] as a monospace grid. The whole grid scrolls as a unit (horizontal +
 * vertical) — natural for an 80–160 column terminal on a phone. Follows the bottom while new
 * output arrives. Colors follow the app's light/dark theme via [LocalPsDarkTheme].
 */
@Composable
fun TerminalView(
    frame: TermFrame,
    modifier: Modifier = Modifier,
    fontSize: Int = 11,
) {
    val vScroll = rememberScrollState()
    val hScroll = rememberScrollState()

    val palette = TermPalette.forDark(LocalPsDarkTheme.current)
    val annotated = remember(frame, palette) { frame.toAnnotatedString(palette) }

    // Follow the tail when the user is already near the bottom.
    LaunchedEffect(annotated, vScroll.maxValue) {
        if (vScroll.value >= vScroll.maxValue - AUTO_FOLLOW_SLACK || vScroll.maxValue == 0) {
            vScroll.scrollTo(vScroll.maxValue)
        }
    }

    Box(
        modifier = modifier
            .background(palette.defaultBg)
            .verticalScroll(vScroll)
            .horizontalScroll(hScroll)
            .padding(horizontal = 8.dp, vertical = 6.dp),
    ) {
        Text(
            text = annotated,
            color = palette.defaultFg,
            fontFamily = FontFamily.Monospace,
            fontSize = fontSize.sp,
            lineHeight = (fontSize * 1.25).sp,
            softWrap = false,
        )
    }
}

private const val AUTO_FOLLOW_SLACK = 80

/** Build a single styled string for the frame, merging runs of identical style per line. */
private fun TermFrame.toAnnotatedString(palette: TermPalette): AnnotatedString = buildAnnotatedString {
    for ((li, line) in lines.withIndex()) {
        if (li > 0) append('\n')
        val n = effectiveLen(line)
        var c = 0
        while (c < n) {
            val isCursor = cursorVisible && li == cursorLine && c == cursorCol
            val style = spanFor(line, c, invert = isCursor, palette = palette)
            var e = c + 1
            while (e < n && !(cursorVisible && li == cursorLine && e == cursorCol) &&
                sameStyle(line, e, c)
            ) e++
            withStyle(style) {
                for (k in c until e) appendCodePoint(line.codes[k])
            }
            c = e
        }
        // draw a cursor that sits past the trimmed content
        if (cursorVisible && li == cursorLine && cursorCol >= n) {
            withStyle(SpanStyle(background = palette.cursor, color = palette.defaultBg)) {
                append(' ')
            }
        }
    }
}

private fun effectiveLen(line: TermLine): Int {
    var last = -1
    for (c in line.codes.indices) {
        val plain = line.codes[c] == 32 &&
            line.bg[c] == TermColor.DEFAULT_BG &&
            line.flags[c] == 0
        if (!plain) last = c
    }
    return last + 1
}

private fun sameStyle(line: TermLine, a: Int, b: Int): Boolean =
    line.fg[a] == line.fg[b] && line.bg[a] == line.bg[b] && line.flags[a] == line.flags[b]

private fun spanFor(line: TermLine, c: Int, invert: Boolean, palette: TermPalette): SpanStyle {
    val flags = line.flags[c]
    val inverse = (flags and TerminalEmulator.INVERSE != 0) xor invert
    var fg = palette.resolve(line.fg[c], isFg = true)
    var bg = palette.resolve(line.bg[c], isFg = false)
    if (inverse) {
        val t = fg; fg = bg; bg = t
    }
    if (flags and TerminalEmulator.DIM != 0 && !inverse) fg = fg.copy(alpha = 0.6f)
    val bgStyle = if (bg == palette.defaultBg) Color.Unspecified else bg
    return SpanStyle(
        color = fg,
        background = bgStyle,
        fontWeight = if (flags and TerminalEmulator.BOLD != 0) FontWeight.Bold else null,
        textDecoration = if (flags and TerminalEmulator.UNDERLINE != 0) TextDecoration.Underline else null,
    )
}

private fun androidx.compose.ui.text.AnnotatedString.Builder.appendCodePoint(cp: Int) {
    if (cp <= 0xFFFF) append(cp.toChar())
    else append(String(Character.toChars(cp)))
}
