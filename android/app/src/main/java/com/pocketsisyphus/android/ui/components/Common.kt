package com.pocketsisyphus.android.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import com.pocketsisyphus.android.data.model.RunState
import com.pocketsisyphus.android.ui.theme.PsColor

fun runStateColor(state: RunState): Color = when (state) {
    RunState.WAITING -> PsColor.warning
    RunState.RUNNING -> PsColor.success
    RunState.DONE -> PsColor.onBgMuted
}

fun runStateLabel(state: RunState): String = when (state) {
    RunState.WAITING -> "Waiting for input"
    RunState.RUNNING -> "Running"
    RunState.DONE -> "Done"
}

@Composable
fun StatusDot(state: RunState, modifier: Modifier = Modifier) {
    Box(
        modifier = modifier
            .clip(CircleShape)
            .background(runStateColor(state))
    )
}

@Composable
fun Pill(text: String, color: Color, modifier: Modifier = Modifier) {
    Box(
        modifier = modifier
            .clip(RoundedCornerShape(6.dp))
            .background(color.copy(alpha = 0.18f))
            .padding(horizontal = 8.dp, vertical = 2.dp),
    ) {
        Text(text, color = color, style = MaterialTheme.typography.labelSmall)
    }
}

/** Human "quiet for" label from a last-activity epoch-ms, or null when there's no active PTY. */
fun relativeQuiet(lastActivity: Long?, now: Long): String? {
    val t = lastActivity ?: return null
    val secs = ((now - t) / 1000).coerceAtLeast(0)
    return when {
        secs < 5 -> "just now"
        secs < 60 -> "${secs}s ago"
        secs < 3600 -> "${secs / 60}m ago"
        secs < 86400 -> "${secs / 3600}h ago"
        else -> "${secs / 86400}d ago"
    }
}
