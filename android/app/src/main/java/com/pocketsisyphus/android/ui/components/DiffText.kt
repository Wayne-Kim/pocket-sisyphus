package com.pocketsisyphus.android.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.pocketsisyphus.android.ui.theme.PsColor

/**
 * Colored unified-diff renderer — shared by the working-tree diff sheet and the
 * commit-scoped file diff screen. Add/remove lines follow the repo's semantic
 * tokens (add = success / remove = danger); hunk = info, meta = muted. No literal
 * hues — colors adapt across dark/light because they are semantic tokens.
 *
 * The caller owns vertical scrolling. All lines share one horizontal scroll and
 * are widened to the longest line so the per-line background tint ends uniformly.
 */
private enum class DiffLineKind { ADD, REMOVE, HUNK, META, CONTEXT }

private fun classify(line: String): DiffLineKind {
    val first = line.firstOrNull() ?: return DiffLineKind.CONTEXT
    return when (first) {
        '+' -> if (line.startsWith("+++")) DiffLineKind.META else DiffLineKind.ADD
        '-' -> if (line.startsWith("---")) DiffLineKind.META else DiffLineKind.REMOVE
        '@' -> if (line.startsWith("@@")) DiffLineKind.HUNK else DiffLineKind.CONTEXT
        'd', 'i' ->
            if (line.startsWith("diff ") || line.startsWith("index ")) DiffLineKind.META
            else DiffLineKind.CONTEXT
        else -> DiffLineKind.CONTEXT
    }
}

private fun foregroundFor(kind: DiffLineKind): Color = when (kind) {
    DiffLineKind.ADD -> PsColor.success
    DiffLineKind.REMOVE -> PsColor.danger
    DiffLineKind.HUNK -> PsColor.info
    DiffLineKind.META -> PsColor.onBgMuted
    DiffLineKind.CONTEXT -> PsColor.onBg
}

private fun backgroundFor(kind: DiffLineKind): Color = when (kind) {
    DiffLineKind.ADD -> PsColor.success.copy(alpha = 0.18f)
    DiffLineKind.REMOVE -> PsColor.danger.copy(alpha = 0.18f)
    DiffLineKind.HUNK -> PsColor.info.copy(alpha = 0.16f)
    DiffLineKind.META -> PsColor.onBgMuted.copy(alpha = 0.10f)
    DiffLineKind.CONTEXT -> Color.Transparent
}

@Composable
fun DiffText(diff: String, modifier: Modifier = Modifier) {
    val lines = remember(diff) { diff.split("\n") }
    Column(modifier.horizontalScroll(rememberScrollState())) {
        // IntrinsicSize.Max sizes the column to the widest line; each row then
        // fillMaxWidth()s to it so add/remove tints align on the right edge.
        Column(Modifier.width(IntrinsicSize.Max)) {
            lines.forEach { line ->
                val kind = classify(line)
                Text(
                    text = if (line.isEmpty()) " " else line,
                    color = foregroundFor(kind),
                    style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                    maxLines = 1,
                    softWrap = false,
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(backgroundFor(kind))
                        .padding(horizontal = 6.dp, vertical = 1.dp),
                )
            }
        }
    }
}
