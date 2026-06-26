package com.pocketsisyphus.android.ui.session

import android.graphics.BitmapFactory
import android.util.Base64
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Image
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Info
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.pocketsisyphus.android.R
import com.pocketsisyphus.android.data.Ps
import com.pocketsisyphus.android.data.model.DirectoryEntry
import com.pocketsisyphus.android.data.model.DirectoryListing
import com.pocketsisyphus.android.data.model.FileContent

/**
 * Full-screen repo file browser — mirrors the iPhone FileBrowserSheet.
 *
 * Entry point: the "browse files" icon in [SessionDetailScreen]'s top bar; the start path is the
 * repo root (""). Two modes inside one screen:
 *   1. directory listing — tap a folder to descend (a path stack), tap a file to open the viewer.
 *   2. file viewer — branches on the daemon's encoding/contentType: text / image / unsupported.
 *
 * "Add to chat reference" (the + action) hands the repo-relative path up via [onAddReference];
 * [SessionDetailScreen] stacks it as a chip and folds the path into the next message.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FileBrowserSheet(
    sessionId: String,
    onAddReference: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    // Path stack: the root ("") plus each descended folder. The last element is the current dir.
    var pathStack by remember { mutableStateOf(listOf("")) }
    var viewingFile by remember { mutableStateOf<String?>(null) }
    val currentPath = pathStack.last()

    fun goBack() {
        when {
            viewingFile != null -> viewingFile = null
            pathStack.size > 1 -> pathStack = pathStack.dropLast(1)
            else -> onDismiss()
        }
    }

    BackHandler { goBack() }

    val title = when {
        viewingFile != null -> lastComponent(viewingFile!!)
        currentPath.isEmpty() -> stringResource(R.string.fb_title_root)
        else -> lastComponent(currentPath)
    }

    Scaffold(
        topBar = {
            TopAppBar(
                navigationIcon = {
                    IconButton(onClick = { goBack() }) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.back))
                    }
                },
                title = {
                    Text(
                        title.ifEmpty { stringResource(R.string.fb_title_root) },
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        fontFamily = if (viewingFile != null || currentPath.isNotEmpty()) FontFamily.Monospace else FontFamily.Default,
                    )
                },
                actions = {
                    // While viewing a file, expose the whole-file "add reference" action here.
                    viewingFile?.let { path ->
                        IconButton(onClick = { onAddReference(path) }) {
                            Icon(
                                Icons.Filled.Add,
                                contentDescription = stringResource(R.string.fb_add_reference),
                                tint = MaterialTheme.colorScheme.primary,
                            )
                        }
                    }
                },
            )
        },
    ) { inner ->
        Box(Modifier.fillMaxSize().padding(inner)) {
            val file = viewingFile
            if (file != null) {
                FileViewer(sessionId = sessionId, path = file)
            } else {
                DirectoryList(
                    sessionId = sessionId,
                    path = currentPath,
                    onOpenDir = { pathStack = pathStack + it },
                    onOpenFile = { viewingFile = it },
                    onAddReference = onAddReference,
                )
            }
        }
    }
}

@Composable
private fun DirectoryList(
    sessionId: String,
    path: String,
    onOpenDir: (String) -> Unit,
    onOpenFile: (String) -> Unit,
    onAddReference: (String) -> Unit,
) {
    var listing by remember(path) { mutableStateOf<DirectoryListing?>(null) }
    var loading by remember(path) { mutableStateOf(true) }
    var failed by remember(path) { mutableStateOf(false) }

    LaunchedEffect(path) {
        loading = true
        failed = false
        val r = runCatching { Ps.api.listDirectory(sessionId, path) }.getOrNull()
        listing = r
        failed = r == null
        loading = false
    }

    val l = listing
    when {
        loading && l == null -> CenterProgress()
        l != null && l.entries.isEmpty() -> StatePlaceholder(
            title = stringResource(R.string.fb_empty_title),
            body = stringResource(R.string.fb_empty_body),
        )
        l != null -> LazyColumn(Modifier.fillMaxSize()) {
            items(l.entries, key = { it.name }) { entry ->
                EntryRow(
                    entry = entry,
                    onClick = {
                        val child = joinPath(path, entry.name)
                        if (entry.isDirectory) onOpenDir(child) else onOpenFile(child)
                    },
                    onAddReference = { onAddReference(joinPath(path, entry.name)) },
                )
            }
        }
        else -> StatePlaceholder(
            title = stringResource(R.string.fb_dir_failed_title),
            body = stringResource(R.string.fb_dir_failed_body),
        )
    }
}

@Composable
private fun EntryRow(
    entry: DirectoryEntry,
    onClick: () -> Unit,
    onAddReference: () -> Unit,
) {
    val openLabel = if (entry.isDirectory) {
        stringResource(R.string.fb_open_folder_a11y, entry.name)
    } else {
        stringResource(R.string.fb_open_file_a11y, entry.name)
    }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClickLabel = openLabel, onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(
                entry.name,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
            )
            if (!entry.isDirectory) {
                Text(
                    formatSize(entry.size),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        if (entry.isDirectory) {
            Icon(
                Icons.AutoMirrored.Filled.KeyboardArrowRight,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        } else {
            IconButton(onClick = onAddReference) {
                Icon(
                    Icons.Filled.Add,
                    contentDescription = stringResource(R.string.fb_add_reference),
                    tint = MaterialTheme.colorScheme.primary,
                )
            }
        }
    }
}

@Composable
private fun FileViewer(sessionId: String, path: String) {
    var content by remember(path) { mutableStateOf<FileContent?>(null) }
    var loading by remember(path) { mutableStateOf(true) }
    var failed by remember(path) { mutableStateOf(false) }

    LaunchedEffect(path) {
        loading = true
        failed = false
        val r = runCatching { Ps.api.readFile(sessionId, path) }.getOrNull()
        content = r
        failed = r == null
        loading = false
    }

    val c = content
    when {
        loading && c == null -> CenterProgress()
        c != null && c.isText -> Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
            if (c.truncated) {
                Text(
                    stringResource(R.string.fb_truncated),
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
                )
            }
            Text(
                c.content,
                style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
            )
        }
        c != null && c.isImage -> ImageView(c)
        c != null -> StatePlaceholder(
            title = stringResource(R.string.fb_unsupported_title),
            body = stringResource(R.string.fb_unsupported_body),
        )
        else -> StatePlaceholder(
            title = stringResource(R.string.fb_file_failed_title),
            body = stringResource(R.string.fb_file_failed_body),
        )
    }
}

@Composable
private fun ImageView(content: FileContent) {
    // Decode the base64 body to a bitmap. Vector formats (svg) don't decode here → unsupported.
    val bitmap = remember(content.path) {
        runCatching {
            val bytes = Base64.decode(content.content, Base64.DEFAULT)
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap()
        }.getOrNull()
    }
    if (bitmap != null) {
        Box(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
            contentAlignment = Alignment.TopCenter,
        ) {
            Image(bitmap = bitmap, contentDescription = lastComponent(content.path), modifier = Modifier.fillMaxWidth())
        }
    } else {
        StatePlaceholder(
            title = stringResource(R.string.fb_unsupported_title),
            body = stringResource(R.string.fb_unsupported_body),
        )
    }
}

@Composable
private fun CenterProgress() {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        CircularProgressIndicator()
    }
}

@Composable
private fun StatePlaceholder(title: String, body: String) {
    Column(
        Modifier.fillMaxSize().padding(32.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Icon(
            Icons.Filled.Info,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.size(44.dp),
        )
        Spacer(Modifier.size(12.dp))
        Text(title, style = MaterialTheme.typography.titleMedium)
        Spacer(Modifier.size(4.dp))
        Text(
            body,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

/** repo-relative dir + child name → new repo-relative path. */
private fun joinPath(parent: String, child: String): String =
    if (parent.isEmpty()) child else "$parent/$child"

/** Last path segment; "" stays "". */
private fun lastComponent(path: String): String =
    if (path.contains('/')) path.substringAfterLast('/') else path

/** "1.2 KB" / "345 B" / "4.5 MB". */
private fun formatSize(bytes: Long): String {
    if (bytes <= 0) return "0 B"
    val units = listOf("B", "KB", "MB", "GB")
    var value = bytes.toDouble()
    var unit = 0
    while (value >= 1024 && unit < units.size - 1) {
        value /= 1024
        unit++
    }
    return if (unit == 0) "${value.toInt()} ${units[unit]}" else String.format("%.1f %s", value, units[unit])
}
