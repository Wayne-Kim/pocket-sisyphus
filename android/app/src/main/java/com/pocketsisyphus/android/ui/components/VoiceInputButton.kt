package com.pocketsisyphus.android.ui.components

import android.Manifest
import android.content.pm.PackageManager
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.pocketsisyphus.android.R
import com.pocketsisyphus.android.ui.theme.PsColor
import com.pocketsisyphus.android.voice.VoiceRecognizer
import kotlinx.coroutines.launch

/**
 * Push-to-talk voice dictation button — on-device STT (Vosk), iOS-parity. Hold to record, release to
 * transcribe; the recognized text is handed to [onText] (the caller inserts it, never auto-sends).
 * First press downloads + loads the model (progress shown); later presses record immediately.
 */
@Composable
fun VoiceInputButton(onText: (String) -> Unit, modifier: Modifier = Modifier) {
    val vs by VoiceRecognizer.state.collectAsStateWithLifecycle()
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()

    var hasPerm by remember {
        mutableStateOf(
            ContextCompat.checkSelfPermission(ctx, Manifest.permission.RECORD_AUDIO) ==
                PackageManager.PERMISSION_GRANTED,
        )
    }
    val permLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        hasPerm = granted
        if (!granted) Toast.makeText(ctx, R.string.voice_perm_needed, Toast.LENGTH_SHORT).show()
    }

    // Surface model download / recognition errors once.
    LaunchedEffect(vs.error) {
        vs.error?.let { Toast.makeText(ctx, it, Toast.LENGTH_SHORT).show() }
    }

    val a11y = stringResource(R.string.voice_dictate)
    Box(
        modifier = modifier
            .size(40.dp)
            .semantics { contentDescription = a11y }
            .pointerInput(vs.state, hasPerm) {
                detectTapGestures(
                    onPress = {
                        when {
                            vs.state == VoiceRecognizer.State.READY && hasPerm -> {
                                VoiceRecognizer.startRecording(onText)
                                tryAwaitRelease()
                                VoiceRecognizer.stopRecording()
                            }
                            vs.state == VoiceRecognizer.State.READY && !hasPerm ->
                                permLauncher.launch(Manifest.permission.RECORD_AUDIO)
                            vs.state == VoiceRecognizer.State.IDLE || vs.state == VoiceRecognizer.State.FAILED -> {
                                Toast.makeText(ctx, R.string.voice_preparing, Toast.LENGTH_SHORT).show()
                                scope.launch { VoiceRecognizer.prepare() }
                            }
                            else -> {}
                        }
                    },
                )
            },
        contentAlignment = Alignment.Center,
    ) {
        when {
            vs.state == VoiceRecognizer.State.PREPARING && !vs.loading && vs.downloadProgress > 0f ->
                CircularProgressIndicator(progress = { vs.downloadProgress }, modifier = Modifier.size(22.dp), strokeWidth = 2.dp)
            vs.state == VoiceRecognizer.State.PREPARING ->
                CircularProgressIndicator(modifier = Modifier.size(22.dp), strokeWidth = 2.dp)
            vs.transcribing ->
                CircularProgressIndicator(modifier = Modifier.size(22.dp), strokeWidth = 2.dp, color = PsColor.accent)
            else ->
                MicGlyph(if (vs.recording) PsColor.accent else MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

/** A clean drawn microphone (material-icons-core has no Mic glyph). Tintable, scales with the box. */
@Composable
private fun MicGlyph(color: Color) {
    Canvas(modifier = Modifier.size(22.dp)) {
        val w = size.width
        val h = size.height
        val bodyW = w * 0.34f
        val bodyH = h * 0.5f
        val left = (w - bodyW) / 2f
        val top = h * 0.1f
        // Mic body — filled rounded capsule.
        drawRoundRect(
            color = color,
            topLeft = Offset(left, top),
            size = androidx.compose.ui.geometry.Size(bodyW, bodyH),
            cornerRadius = androidx.compose.ui.geometry.CornerRadius(bodyW / 2f, bodyW / 2f),
        )
        val stroke = Stroke(width = h * 0.07f)
        // Holder arc under the body.
        val arcPad = w * 0.2f
        drawArc(
            color = color,
            startAngle = 20f,
            sweepAngle = 140f,
            useCenter = false,
            topLeft = Offset(arcPad, h * 0.32f),
            size = androidx.compose.ui.geometry.Size(w - 2 * arcPad, h * 0.42f),
            style = stroke,
        )
        // Stem + base.
        drawLine(color, Offset(w / 2f, h * 0.74f), Offset(w / 2f, h * 0.9f), strokeWidth = h * 0.07f)
        drawLine(color, Offset(w * 0.36f, h * 0.9f), Offset(w * 0.64f, h * 0.9f), strokeWidth = h * 0.07f)
    }
}
