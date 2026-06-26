package com.pocketsisyphus.android.ui.mirror

import android.graphics.SurfaceTexture
import android.view.Surface
import android.view.TextureView
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.pocketsisyphus.android.R
import com.pocketsisyphus.android.ui.mirror.ScreenMirrorViewModel.Status
import com.pocketsisyphus.android.ui.theme.PsColor

/**
 * Live Mac screen mirroring. Renders the decoded H.264 stream to a [TextureView] (JPEG fallback to
 * an [Image]), with pinch-zoom / pan, a status pill (semantic colors), pause/resume, and clear
 * overlays for connecting / stalled / permission / disconnected states.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ScreenMirrorScreen(
    onBack: () -> Unit,
    vm: ScreenMirrorViewModel = viewModel(),
) {
    val state by vm.state.collectAsStateWithLifecycle()

    LaunchedEffect(Unit) { vm.start() }

    // Foreground/background gating — stop the stream when the phone leaves the screen.
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner) {
        val obs = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_RESUME -> vm.onForeground()
                Lifecycle.Event.ON_PAUSE -> vm.onBackground()
                else -> {}
            }
        }
        lifecycleOwner.lifecycle.addObserver(obs)
        onDispose { lifecycleOwner.lifecycle.removeObserver(obs) }
    }

    val pauseLabel = stringResource(R.string.mirror_pause)
    val resumeLabel = stringResource(R.string.mirror_resume)

    var scrollMode by remember { mutableStateOf(true) }
    var showKeyboard by remember { mutableStateOf(false) }

    Scaffold(
        topBar = {
            TopAppBar(
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.back))
                    }
                },
                title = { Text(stringResource(R.string.mirror_title)) },
                actions = {
                    // Remote control toggle (forward taps/scroll/keys to the Mac). Accent when on.
                    TextButton(onClick = { vm.setControl(!state.controlEnabled) }) {
                        Text(
                            stringResource(R.string.mirror_control),
                            color = if (state.controlEnabled) PsColor.accent else MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    val paused = state.status == Status.PAUSED
                    IconButton(
                        onClick = { vm.togglePause() },
                        modifier = Modifier.semantics {
                            contentDescription = if (paused) resumeLabel else pauseLabel
                        },
                    ) {
                        if (paused) {
                            Icon(Icons.Filled.PlayArrow, contentDescription = null)
                        } else {
                            PauseGlyph()
                        }
                    }
                },
            )
        },
    ) { inner ->
        Column(Modifier.fillMaxSize().padding(inner)) {
            StatusBar(state.status)
            if (state.controlEnabled) {
                ControlBar(
                    scrollMode = scrollMode,
                    onScrollMode = { scrollMode = it },
                    showKeyboard = showKeyboard,
                    onToggleKeyboard = { showKeyboard = !showKeyboard },
                )
            }
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .weight(1f)
                    .background(Color.Black),
                contentAlignment = Alignment.Center,
            ) {
                MirrorViewport(state, vm, scrollMode)
                Overlay(state)
            }
            if (state.controlEnabled && showKeyboard) {
                KeyboardPanel(vm)
            }
        }
    }
}

/** Control-mode bar: scroll/drag mode + keyboard toggle + the gesture hint. */
@Composable
private fun ControlBar(
    scrollMode: Boolean,
    onScrollMode: (Boolean) -> Unit,
    showKeyboard: Boolean,
    onToggleKeyboard: () -> Unit,
) {
    Column(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            FilterChip(
                selected = scrollMode,
                onClick = { onScrollMode(true) },
                label = { Text(stringResource(R.string.mirror_mode_scroll)) },
            )
            FilterChip(
                selected = !scrollMode,
                onClick = { onScrollMode(false) },
                label = { Text(stringResource(R.string.mirror_mode_drag)) },
            )
            FilterChip(
                selected = showKeyboard,
                onClick = { onToggleKeyboard() },
                label = { Text(stringResource(R.string.mirror_keyboard)) },
            )
        }
        Text(
            stringResource(R.string.mirror_control_hint),
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

/** On-screen keyboard for control mode: text send + special keys + common ⌘ hotkeys. */
@Composable
private fun KeyboardPanel(vm: ScreenMirrorViewModel) {
    var text by remember { mutableStateOf("") }
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.surface)
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(
                value = text,
                onValueChange = { text = it },
                singleLine = true,
                modifier = Modifier.weight(1f),
            )
            Button(onClick = { vm.typeText(text); text = "" }, enabled = text.isNotEmpty()) {
                Text(stringResource(R.string.mirror_send))
            }
        }
        Row(modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            KeyChip("esc") { vm.pressKey("escape") }
            KeyChip("tab") { vm.pressKey("tab") }
            KeyChip("⏎") { vm.pressKey("return") }
            KeyChip("⌫") { vm.pressKey("delete") }
            KeyChip("←") { vm.pressKey("left") }
            KeyChip("↑") { vm.pressKey("up") }
            KeyChip("↓") { vm.pressKey("down") }
            KeyChip("→") { vm.pressKey("right") }
        }
        Row(modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            KeyChip("⌘C") { vm.hotkey("c", listOf("command")) }
            KeyChip("⌘V") { vm.hotkey("v", listOf("command")) }
            KeyChip("⌘X") { vm.hotkey("x", listOf("command")) }
            KeyChip("⌘Z") { vm.hotkey("z", listOf("command")) }
            KeyChip("⌘A") { vm.hotkey("a", listOf("command")) }
            KeyChip("⌘⇧Z") { vm.hotkey("z", listOf("command", "shift")) }
        }
    }
}

@Composable
private fun KeyChip(label: String, onClick: () -> Unit) {
    AssistChip(onClick = onClick, label = { Text(label) })
}

/** Forward control gestures (tap=click, long-press=right, double-tap=double, drag=scroll/mouse-drag). */
private fun Modifier.controlGestures(vm: ScreenMirrorViewModel, scrollMode: Boolean): Modifier = this
    .pointerInput(scrollMode) {
        detectTapGestures(
            onTap = { p -> vm.click((p.x / size.width).toDouble(), (p.y / size.height).toDouble()) },
            onDoubleTap = { p -> vm.click((p.x / size.width).toDouble(), (p.y / size.height).toDouble(), clicks = 2) },
            onLongPress = { p -> vm.click((p.x / size.width).toDouble(), (p.y / size.height).toDouble(), button = "right") },
        )
    }
    .pointerInput(scrollMode) {
        if (scrollMode) {
            // Trackpad-style: dragging scrolls content the way the finger moves.
            detectDragGestures { change, drag ->
                change.consume()
                vm.scroll(-drag.x.toDouble() / 2.0, -drag.y.toDouble() / 2.0)
            }
        } else {
            var pos = Offset.Zero
            detectDragGestures(
                onDragStart = { p ->
                    pos = p
                    vm.down((p.x / size.width).toDouble(), (p.y / size.height).toDouble())
                },
                onDragEnd = { vm.up((pos.x / size.width).toDouble(), (pos.y / size.height).toDouble()) },
                onDragCancel = { vm.up((pos.x / size.width).toDouble(), (pos.y / size.height).toDouble()) },
            ) { change, drag ->
                change.consume()
                pos += drag
                vm.drag((pos.x / size.width).toDouble(), (pos.y / size.height).toDouble())
            }
        }
    }

/** A flat horizontal status pill — color carries the meaning (success/danger/neutral/warning). */
@Composable
private fun StatusBar(status: Status) {
    val color = statusColor(status)
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(color.copy(alpha = 0.12f))
            .padding(horizontal = 16.dp, vertical = 8.dp)
            .semantics { contentDescription = "status" },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Box(Modifier.size(10.dp).background(color, CircleShape))
        Text(
            stringResource(statusLabel(status)),
            style = MaterialTheme.typography.labelLarge,
            color = MaterialTheme.colorScheme.onSurface,
        )
    }
}

/** The zoom/pan-able video surface (TextureView for H.264, Image for the JPEG fallback). */
@Composable
private fun MirrorViewport(state: ScreenMirrorViewModel.UiState, vm: ScreenMirrorViewModel, scrollMode: Boolean) {
    var scale by remember { mutableFloatStateOf(1f) }
    var offsetX by remember { mutableFloatStateOf(0f) }
    var offsetY by remember { mutableFloatStateOf(0f) }

    val visible = state.status == Status.LIVE || state.status == Status.STALLED
    val controlOn = state.controlEnabled

    // Reset zoom whenever the stream isn't shown, or when entering control mode (1:1 mapping).
    LaunchedEffect(visible, controlOn) {
        if (!visible || controlOn) { scale = 1f; offsetX = 0f; offsetY = 0f }
    }

    val videoA11y = stringResource(R.string.mirror_video_a11y)

    // Outer pinch-zoom/pan only when NOT controlling (control forwards gestures to the Mac instead).
    val gesture = if (controlOn) Modifier else Modifier.pointerInput(Unit) {
        detectTransformGestures { _, pan, zoom, _ ->
            val newScale = (scale * zoom).coerceIn(1f, 5f)
            val maxX = (size.width * (newScale - 1f)) / 2f
            val maxY = (size.height * (newScale - 1f)) / 2f
            scale = newScale
            offsetX = (offsetX + pan.x).coerceIn(-maxX, maxX)
            offsetY = (offsetY + pan.y).coerceIn(-maxY, maxY)
        }
    }
    val transform = Modifier.graphicsLayer {
        scaleX = scale
        scaleY = scale
        translationX = offsetX
        translationY = offsetY
    }
    // On the video element: forward control gestures (mapped to 0..1) when controlling.
    val videoControl = if (controlOn) Modifier.controlGestures(vm, scrollMode) else transform

    val jpeg = state.jpegFrame

    Box(
        modifier = Modifier.fillMaxSize().then(gesture),
        contentAlignment = Alignment.Center,
    ) {
        if (state.usingJpeg && jpeg != null) {
            Image(
                bitmap = jpeg.asImageBitmap(),
                contentDescription = videoA11y,
                modifier = Modifier
                    .fillMaxWidth()
                    .aspectRatio(state.videoAspect)
                    .then(videoControl),
                contentScale = ContentScale.Fit,
            )
        } else if (!state.usingJpeg) {
            AndroidView(
                factory = { ctx ->
                    TextureView(ctx).apply {
                        surfaceTextureListener = object : TextureView.SurfaceTextureListener {
                            override fun onSurfaceTextureAvailable(st: SurfaceTexture, w: Int, h: Int) {
                                vm.setSurface(Surface(st))
                            }

                            override fun onSurfaceTextureSizeChanged(st: SurfaceTexture, w: Int, h: Int) {}

                            override fun onSurfaceTextureDestroyed(st: SurfaceTexture): Boolean {
                                vm.setSurface(null)
                                return true
                            }

                            override fun onSurfaceTextureUpdated(st: SurfaceTexture) {}
                        }
                    }
                },
                modifier = Modifier
                    .fillMaxWidth()
                    .aspectRatio(state.videoAspect)
                    .semantics { contentDescription = videoA11y }
                    .then(videoControl),
            )
        }
    }
}

/** Centered placeholder for non-live states — icon + localized guidance. */
@Composable
private fun Overlay(state: ScreenMirrorViewModel.UiState) {
    val status = state.status
    if (status == Status.LIVE) return
    // Stalled keeps the last frame visible underneath — show only the status pill, not a scrim.
    if (status == Status.STALLED && state.videoWidth > 0) return

    val body: Int = when (status) {
        Status.CONNECTING -> R.string.mirror_connecting_body
        Status.STALLED -> R.string.mirror_stalled_body
        Status.PAUSED -> R.string.mirror_paused_body
        Status.PERMISSION_NEEDED -> R.string.mirror_permission_body
        Status.DISCONNECTED ->
            if (state.fatal) R.string.mirror_disconnected_fatal_body else R.string.mirror_disconnected_body
        Status.LIVE -> return
    }

    Column(
        modifier = Modifier.fillMaxWidth().padding(32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        when (status) {
            Status.CONNECTING ->
                CircularProgressIndicator(color = PsColor.accent, modifier = Modifier.size(44.dp))
            Status.STALLED ->
                Icon(Icons.Filled.Warning, null, tint = PsColor.warning, modifier = Modifier.size(44.dp))
            Status.PAUSED ->
                Icon(Icons.Filled.PlayArrow, null, tint = PsColor.onBgMuted, modifier = Modifier.size(44.dp))
            Status.PERMISSION_NEEDED ->
                Icon(Icons.Filled.Lock, null, tint = PsColor.warning, modifier = Modifier.size(44.dp))
            Status.DISCONNECTED ->
                Icon(Icons.Filled.Refresh, null, tint = PsColor.danger, modifier = Modifier.size(44.dp))
            Status.LIVE -> {}
        }
        Text(
            stringResource(statusLabel(status)),
            style = MaterialTheme.typography.titleMedium,
            color = Color.White,
        )
        Text(
            stringResource(body),
            style = MaterialTheme.typography.bodyMedium,
            color = Color.White.copy(alpha = 0.7f),
        )
    }
}

/** Two-bar pause glyph — material-icons-core has no Pause glyph. */
@Composable
private fun PauseGlyph() {
    val c = MaterialTheme.colorScheme.onSurface
    Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        Box(Modifier.size(width = 5.dp, height = 18.dp).background(c, RoundedCornerShape(2.dp)))
        Box(Modifier.size(width = 5.dp, height = 18.dp).background(c, RoundedCornerShape(2.dp)))
    }
}

private fun statusColor(status: Status): Color = when (status) {
    Status.LIVE -> PsColor.success
    Status.CONNECTING -> PsColor.onBgMuted
    Status.STALLED -> PsColor.warning
    Status.PAUSED -> PsColor.onBgMuted
    Status.PERMISSION_NEEDED -> PsColor.warning
    Status.DISCONNECTED -> PsColor.danger
}

private fun statusLabel(status: Status): Int = when (status) {
    Status.LIVE -> R.string.mirror_status_live
    Status.CONNECTING -> R.string.mirror_status_connecting
    Status.STALLED -> R.string.mirror_status_stalled
    Status.PAUSED -> R.string.mirror_status_paused
    Status.PERMISSION_NEEDED -> R.string.mirror_status_permission
    Status.DISCONNECTED -> R.string.mirror_status_disconnected
}
