package com.pocketsisyphus.android.ui.session

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.AssistChipDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.InputChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.TextField
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.pocketsisyphus.android.R
import com.pocketsisyphus.android.data.Ps
import com.pocketsisyphus.android.terminal.TerminalView
import com.pocketsisyphus.android.ui.components.DiffText
import com.pocketsisyphus.android.ui.components.SecureFlag
import com.pocketsisyphus.android.ui.theme.PsColor
import kotlinx.coroutines.launch

/**
 * Session chat — mirrors the iPhone ChatView layout: the right of the top bar holds the mirroring
 * button + a «more» menu (terminal font / restart / delete); the bottom groups the keyboard-sim keys
 * (Esc/Tab/arrows/Enter/…) plus the git · file-browser · diff · image-attach tools. Color is meaning:
 * the advanced «chat tool chips» (git/files/diff/image) and mirroring use `pro` (orange), matching iOS.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SessionDetailScreen(
    sessionId: String,
    initialTitle: String,
    onBack: () -> Unit,
    onOpenCommits: (branch: String?) -> Unit,
    onOpenBranches: () -> Unit = {},
    onOpenMirror: () -> Unit = {},
    canMirror: Boolean = false,
    vm: SessionDetailViewModel = viewModel(key = sessionId),
) {
    // BL-07: 세션 상세는 원격 셸 출력·채팅(민감 원격 콘텐츠) → 스크린샷/스위처 캡처 차단.
    SecureFlag()
    LaunchedEffect(sessionId) { vm.start(sessionId, initialTitle) }
    DisposableEffect(sessionId) {
        // away-gating: viewing this chat foreground silences/clears its wait notification.
        Ps.waitNotifier.setActiveSession(sessionId)
        onDispose {
            Ps.waitNotifier.setActiveSession(null)
            vm.stop()
        }
    }

    val state by vm.state.collectAsStateWithLifecycle()
    val frame by vm.frame.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    var input by remember { mutableStateOf("") }
    var showDiff by remember { mutableStateOf(false) }
    var showBrowser by remember { mutableStateOf(false) }
    var menuOpen by remember { mutableStateOf(false) }
    var showRestartConfirm by remember { mutableStateOf(false) }
    var showDeleteConfirm by remember { mutableStateOf(false) }
    var showRename by remember { mutableStateOf(false) }
    // Terminal monospace size (pt). Survives rotation; the «more» menu steppers drive it.
    var fontSize by rememberSaveable { mutableStateOf(11) }
    // Repo-relative paths the user pulled in from the file browser — sent to the agent with the
    // next message. Held here (not in the VM) so the chips clear cleanly on send.
    var fileRefs by remember { mutableStateOf<List<String>>(emptyList()) }
    // Pending image attachments — downscaled JPEGs awaiting upload, shown as removable thumbnails.
    var pendingImages by remember { mutableStateOf<List<PendingImage>>(emptyList()) }
    val refHeader = stringResource(R.string.fb_ref_header)
    val imageHeader = stringResource(R.string.attach_image_header)
    val uploadFailed = stringResource(R.string.attach_upload_failed)
    val pickFailed = stringResource(R.string.attach_pick_failed)

    // Image attach — system photo picker (multi-select, images only; needs no storage permission).
    // Picked URIs are decoded + downscaled off the main thread into pending thumbnails, which upload
    // with the next message. If none decode, surface a retryable error.
    val imagePicker = rememberLauncherForActivityResult(
        ActivityResultContracts.PickMultipleVisualMedia(),
    ) { uris ->
        if (uris.isEmpty()) return@rememberLauncherForActivityResult
        scope.launch {
            val prepared = uris.mapNotNull { ImageAttachment.prepare(context.contentResolver, it) }
            if (prepared.isEmpty()) vm.setBanner(pickFailed)
            else pendingImages = pendingImages + prepared
        }
    }

    // Compose the outgoing message: prepend the file-reference path list and/or the uploaded image
    // path list so the agent reads them, then the typed text. Images upload first; on failure the
    // attachments are kept and a retryable error banner is shown.
    fun submit() {
        if (state.sending || state.uploading) return
        val refs = fileRefs
        val imgs = pendingImages
        val body = input.trim()
        if (refs.isEmpty() && imgs.isEmpty()) {
            if (body.isNotEmpty()) {
                vm.sendMessage(body)
                input = ""
            }
            return
        }
        scope.launch {
            val imagePaths = try {
                vm.uploadImages(imgs)
            } catch (e: Throwable) {
                vm.setBanner(e.message?.takeIf { it.isNotBlank() }?.let { "$uploadFailed ($it)" } ?: uploadFailed)
                return@launch
            }
            val sections = buildList {
                if (refs.isNotEmpty()) add("$refHeader ${refs.joinToString(" | ")}")
                if (imagePaths.isNotEmpty()) add("$imageHeader ${imagePaths.joinToString(" | ")}")
            }
            val header = sections.joinToString("\n")
            val composed = if (body.isEmpty()) header else "$header\n\n$body"
            vm.sendMessage(composed)
            input = ""
            fileRefs = emptyList()
            pendingImages = emptyList()
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.back))
                    }
                },
                title = {
                    Column {
                        Text(state.title, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        val sub = buildString {
                            state.branch?.let { append("⎇ $it") }
                            if (state.changedCount > 0) {
                                if (isNotEmpty()) append("  ·  ")
                                append("${state.changedCount} changed")
                            }
                            if (!state.connected) {
                                if (isNotEmpty()) append("  ·  ")
                                append("connecting…")
                            }
                        }
                        if (sub.isNotEmpty()) {
                            Text(
                                sub,
                                style = MaterialTheme.typography.labelSmall,
                                color = if (state.connected) MaterialTheme.colorScheme.onSurfaceVariant else PsColor.warning,
                            )
                        }
                    }
                },
                actions = {
                    if (canMirror) {
                        IconButton(onClick = onOpenMirror) {
                            Icon(MonitorIcon, contentDescription = stringResource(R.string.mirror_title), tint = PsColor.pro)
                        }
                    }
                    Box {
                        IconButton(onClick = { menuOpen = true }) {
                            Icon(MoreVertIcon, contentDescription = stringResource(R.string.chat_menu))
                        }
                        DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                            // Font-size stepper — a non-dismissing row so repeated taps keep the menu open.
                            Row(
                                modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(8.dp),
                            ) {
                                Text(stringResource(R.string.chat_font_size), style = MaterialTheme.typography.bodyMedium)
                                TextButton(
                                    onClick = { fontSize = (fontSize - 1).coerceAtLeast(9) },
                                    enabled = fontSize > 9,
                                ) { Text("A−") }
                                Text("${fontSize}pt", style = MaterialTheme.typography.bodyMedium)
                                TextButton(
                                    onClick = { fontSize = (fontSize + 1).coerceAtMost(22) },
                                    enabled = fontSize < 22,
                                ) { Text("A+") }
                            }
                            HorizontalDivider()
                            DropdownMenuItem(
                                text = { Text(stringResource(R.string.session_rename)) },
                                onClick = { menuOpen = false; showRename = true },
                            )
                            DropdownMenuItem(
                                text = { Text(stringResource(R.string.branch_open)) },
                                onClick = { menuOpen = false; onOpenBranches() },
                            )
                            DropdownMenuItem(
                                text = { Text(stringResource(R.string.chat_restart_terminal)) },
                                onClick = { menuOpen = false; showRestartConfirm = true },
                            )
                            DropdownMenuItem(
                                text = { Text(stringResource(R.string.chat_delete_session), color = PsColor.danger) },
                                onClick = { menuOpen = false; showDeleteConfirm = true },
                            )
                        }
                    }
                },
            )
        },
    ) { inner ->
        Column(modifier = Modifier.fillMaxSize().padding(inner).imePadding()) {
            state.banner?.let {
                Text(
                    it,
                    color = PsColor.danger,
                    style = MaterialTheme.typography.labelMedium,
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
                )
            }
            if (state.awaitingUser) {
                Text(
                    stringResource(R.string.chat_awaiting_input),
                    color = PsColor.warning,
                    style = MaterialTheme.typography.labelMedium,
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
                )
            }

            val f = frame
            if (f != null) {
                TerminalView(frame = f, fontSize = fontSize, modifier = Modifier.fillMaxWidth().weight(1f))
            } else {
                Box(Modifier.fillMaxWidth().weight(1f), contentAlignment = Alignment.Center) {
                    Text(stringResource(R.string.chat_terminal_loading), color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }

            HorizontalDivider()

            // Pending image attachments — removable thumbnails that upload with the next message.
            if (pendingImages.isNotEmpty()) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .horizontalScroll(rememberScrollState())
                        .padding(horizontal = 8.dp, vertical = 2.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    pendingImages.forEach { img ->
                        Box {
                            Image(
                                bitmap = img.preview,
                                contentDescription = stringResource(R.string.attach_image_a11y),
                                contentScale = ContentScale.Crop,
                                modifier = Modifier
                                    .size(56.dp)
                                    .clip(RoundedCornerShape(8.dp)),
                            )
                            IconButton(
                                onClick = { pendingImages = pendingImages - img },
                                enabled = !state.uploading,
                                modifier = Modifier
                                    .align(Alignment.TopEnd)
                                    .size(20.dp),
                            ) {
                                Icon(
                                    Icons.Filled.Close,
                                    contentDescription = stringResource(R.string.attach_remove_a11y),
                                    tint = PsColor.danger,
                                    modifier = Modifier.size(14.dp),
                                )
                            }
                        }
                    }
                }
            }

            // Pending references — chips (file-browser picks + uploaded images) folded into the next message.
            if (fileRefs.isNotEmpty()) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .horizontalScroll(rememberScrollState())
                        .padding(horizontal = 8.dp, vertical = 2.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    fileRefs.forEach { path ->
                        val name = path.substringAfterLast('/')
                        InputChip(
                            selected = false,
                            onClick = { fileRefs = fileRefs - path },
                            label = { Text(name, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                            trailingIcon = {
                                Icon(
                                    Icons.Filled.Close,
                                    contentDescription = stringResource(R.string.fb_remove_reference_a11y, name),
                                    modifier = Modifier.size(16.dp),
                                )
                            },
                        )
                    }
                }
            }

            // Tool row — git · file browser · diff · image attach (advanced = pro/orange, like iOS).
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .horizontalScroll(rememberScrollState())
                    .padding(horizontal = 4.dp),
                horizontalArrangement = Arrangement.spacedBy(2.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                IconButton(onClick = { onOpenCommits(state.branch) }) {
                    Icon(Icons.AutoMirrored.Filled.List, contentDescription = stringResource(R.string.commits_open_a11y), tint = PsColor.pro)
                }
                IconButton(onClick = { showBrowser = true }) {
                    Icon(Icons.Filled.Search, contentDescription = stringResource(R.string.fb_browse), tint = PsColor.pro)
                }
                IconButton(onClick = {
                    imagePicker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
                }) {
                    Icon(PhotoIcon, contentDescription = stringResource(R.string.chat_attach_image))
                }
                if (state.changedCount > 0) {
                    AssistChip(
                        onClick = { showDiff = true },
                        label = { Text("Diff ${state.changedCount}") },
                        colors = AssistChipDefaults.assistChipColors(labelColor = PsColor.pro),
                    )
                }
            }

            // Keyboard-sim row — raw keystrokes the soft keyboard can't drive (terminal navigation).
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .horizontalScroll(rememberScrollState())
                    .padding(horizontal = 8.dp, vertical = 2.dp),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                SimKey("Esc") { vm.sendBytes(byteArrayOf(0x1b)) }
                SimKey("Tab") { vm.sendBytes(byteArrayOf(0x09)) }
                SimKey("⌫") { vm.sendBytes(byteArrayOf(0x7f)) }
                SimKey("←") { vm.key("left") }
                SimKey("↑") { vm.key("up") }
                SimKey("↓") { vm.key("down") }
                SimKey("→") { vm.key("right") }
                SimKey("/") { vm.sendBytes(byteArrayOf(0x2f)) }
                SimKey("Space") { vm.sendBytes(byteArrayOf(0x20)) }
                SimKey("Enter") { vm.sendBytes(byteArrayOf(0x0d)) }
            }

            // Message input.
            Row(
                modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                TextField(
                    value = input,
                    onValueChange = { input = it },
                    placeholder = { Text(stringResource(R.string.chat_input_placeholder)) },
                    modifier = Modifier.weight(1f),
                    maxLines = 4,
                )
                // On-device voice dictation (push-to-talk) — inserts the transcript, never auto-sends.
                com.pocketsisyphus.android.ui.components.VoiceInputButton(
                    onText = { spoken ->
                        input = if (input.isBlank()) spoken else "${input.trimEnd()} $spoken"
                    },
                )
                if (state.uploading) {
                    CircularProgressIndicator(modifier = Modifier.size(24.dp))
                } else {
                    IconButton(
                        onClick = { submit() },
                        enabled = (input.isNotBlank() || fileRefs.isNotEmpty() || pendingImages.isNotEmpty()) &&
                            !state.sending && !state.uploading,
                    ) {
                        Icon(Icons.AutoMirrored.Filled.Send, contentDescription = stringResource(R.string.chat_send))
                    }
                }
            }
        }
    }

    if (showDiff) {
        DiffSheet(sessionId = sessionId, files = state.changedFiles, onDismiss = { showDiff = false })
    }

    if (showBrowser) {
        FileBrowserSheet(
            sessionId = sessionId,
            onAddReference = { path -> if (path !in fileRefs) fileRefs = fileRefs + path },
            onDismiss = { showBrowser = false },
        )
    }

    if (showRename) {
        var name by remember(showRename) { mutableStateOf(state.title) }
        AlertDialog(
            onDismissRequest = { showRename = false },
            title = { Text(stringResource(R.string.session_rename)) },
            text = {
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it },
                    placeholder = { Text(stringResource(R.string.session_rename_hint)) },
                    singleLine = true,
                )
            },
            confirmButton = {
                TextButton(onClick = { showRename = false; vm.rename(name) }) {
                    Text(stringResource(R.string.save))
                }
            },
            dismissButton = {
                TextButton(onClick = { showRename = false }) { Text(stringResource(R.string.cancel)) }
            },
        )
    }

    if (showRestartConfirm) {
        AlertDialog(
            onDismissRequest = { showRestartConfirm = false },
            title = { Text(stringResource(R.string.chat_restart_confirm_title)) },
            text = { Text(stringResource(R.string.chat_restart_confirm_msg)) },
            confirmButton = {
                TextButton(onClick = { showRestartConfirm = false; vm.restartTerminal() }) {
                    Text(stringResource(R.string.chat_restart_terminal))
                }
            },
            dismissButton = {
                TextButton(onClick = { showRestartConfirm = false }) { Text(stringResource(R.string.cancel)) }
            },
        )
    }

    if (showDeleteConfirm) {
        AlertDialog(
            onDismissRequest = { showDeleteConfirm = false },
            title = { Text(stringResource(R.string.chat_delete_confirm_title)) },
            text = { Text(stringResource(R.string.chat_delete_confirm_msg)) },
            confirmButton = {
                TextButton(onClick = { showDeleteConfirm = false; vm.deleteSession(onDone = onBack) }) {
                    Text(stringResource(R.string.chat_delete_session), color = PsColor.danger)
                }
            },
            dismissButton = {
                TextButton(onClick = { showDeleteConfirm = false }) { Text(stringResource(R.string.cancel)) }
            },
        )
    }
}

/** A compact virtual key for the keyboard-sim row. The visible glyph is its accessibility label. */
@Composable
private fun SimKey(label: String, onClick: () -> Unit) {
    Surface(
        onClick = onClick,
        shape = MaterialTheme.shapes.small,
        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline),
        modifier = Modifier.heightIn(min = 36.dp).widthIn(min = 40.dp),
    ) {
        Box(contentAlignment = Alignment.Center, modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp)) {
            Text(label, style = MaterialTheme.typography.labelLarge)
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun DiffSheet(
    sessionId: String,
    files: List<com.pocketsisyphus.android.data.model.GitFile>,
    onDismiss: () -> Unit,
) {
    var selected by remember { mutableStateOf<String?>(null) }
    var diffText by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp).padding(bottom = 24.dp)) {
            Text(stringResource(R.string.chat_diff_title), style = MaterialTheme.typography.titleLarge)
            if (selected == null) {
                Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState())) {
                    files.forEach { file ->
                        Row(
                            Modifier.fillMaxWidth()
                                .clickable {
                                    selected = file.path
                                    diffText = null
                                    scope.launch {
                                        diffText = runCatching {
                                            Ps.api.gitDiff(sessionId, file.path).diff ?: ""
                                        }.getOrElse { "diff unavailable: ${it.message}" }
                                    }
                                }
                                .padding(vertical = 10.dp),
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(
                                file.primaryStatus.toString(),
                                color = statusColor(file.primaryStatus),
                                style = MaterialTheme.typography.labelMedium,
                                modifier = Modifier.size(16.dp),
                            )
                            Text(file.path, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis,
                                style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace))
                            if (file.additions > 0) Text("+${file.additions}", color = PsColor.success, style = MaterialTheme.typography.labelSmall)
                            if (file.deletions > 0) Text("−${file.deletions}", color = PsColor.danger, style = MaterialTheme.typography.labelSmall)
                        }
                    }
                }
            } else {
                OutlinedButton(onClick = { selected = null; diffText = null }, modifier = Modifier.padding(vertical = 8.dp)) {
                    Text(stringResource(R.string.chat_diff_back))
                }
                Text(selected!!, style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace))
                Box(Modifier.fillMaxWidth().verticalScroll(rememberScrollState())) {
                    val text = diffText
                    if (text == null) {
                        Text(
                            stringResource(R.string.chat_terminal_loading),
                            style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                            modifier = Modifier.padding(vertical = 8.dp),
                        )
                    } else {
                        DiffText(text, modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp))
                    }
                }
            }
        }
    }
}

private fun statusColor(c: Char) = when (c) {
    'A' -> PsColor.success
    'D' -> PsColor.danger
    'M' -> PsColor.warning
    'R' -> PsColor.info
    else -> PsColor.accentSoft
}

// ── Inline glyphs (the app bundles only material-icons-core, which has no monitor/photo/more icons) ──

/** Monitor glyph for the mirroring button (screen rectangle + stand). */
private val MonitorIcon: ImageVector = ImageVector.Builder(
    name = "Monitor", defaultWidth = 24.dp, defaultHeight = 24.dp, viewportWidth = 24f, viewportHeight = 24f,
).apply {
    path(stroke = SolidColor(Color.Black), strokeLineWidth = 1.8f) {
        moveTo(3f, 5f); lineTo(21f, 5f); lineTo(21f, 16f); lineTo(3f, 16f); close()
        moveTo(12f, 16f); lineTo(12f, 19.5f)
        moveTo(8f, 20f); lineTo(16f, 20f)
    }
}.build()

/** Photo glyph for image attach (frame + sun + mountain). */
private val PhotoIcon: ImageVector = ImageVector.Builder(
    name = "Photo", defaultWidth = 24.dp, defaultHeight = 24.dp, viewportWidth = 24f, viewportHeight = 24f,
).apply {
    path(stroke = SolidColor(Color.Black), strokeLineWidth = 1.8f) {
        moveTo(3f, 5f); lineTo(21f, 5f); lineTo(21f, 19f); lineTo(3f, 19f); close()
        moveTo(3f, 16f); lineTo(9f, 11f); lineTo(13f, 14f); lineTo(17f, 9.5f); lineTo(21f, 13.5f)
    }
    path(fill = SolidColor(Color.Black)) {
        moveTo(8f, 7.4f)
        arcTo(1.6f, 1.6f, 0f, false, true, 8f, 10.6f)
        arcTo(1.6f, 1.6f, 0f, false, true, 8f, 7.4f)
    }
}.build()

/** Vertical three-dot «more» glyph. */
private val MoreVertIcon: ImageVector = ImageVector.Builder(
    name = "MoreVert", defaultWidth = 24.dp, defaultHeight = 24.dp, viewportWidth = 24f, viewportHeight = 24f,
).apply {
    path(fill = SolidColor(Color.Black)) {
        moveTo(12f, 3.4f); arcTo(1.6f, 1.6f, 0f, false, true, 12f, 6.6f); arcTo(1.6f, 1.6f, 0f, false, true, 12f, 3.4f)
        moveTo(12f, 10.4f); arcTo(1.6f, 1.6f, 0f, false, true, 12f, 13.6f); arcTo(1.6f, 1.6f, 0f, false, true, 12f, 10.4f)
        moveTo(12f, 17.4f); arcTo(1.6f, 1.6f, 0f, false, true, 12f, 20.6f); arcTo(1.6f, 1.6f, 0f, false, true, 12f, 17.4f)
    }
}.build()
