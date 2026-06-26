package com.pocketsisyphus.android.ui.commits

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
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
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import android.text.format.DateUtils
import com.pocketsisyphus.android.R
import com.pocketsisyphus.android.data.model.GitCommit
import com.pocketsisyphus.android.data.model.GitCommitDetail
import com.pocketsisyphus.android.data.model.GitDiff
import com.pocketsisyphus.android.data.model.GitFile
import com.pocketsisyphus.android.ui.components.DiffText
import com.pocketsisyphus.android.ui.theme.PsColor
import java.time.OffsetDateTime
import java.time.format.DateTimeFormatter

/** Internal drill-down within the commit-history flow (manual back-stack). */
private sealed interface CommitNav {
    data object Log : CommitNav
    data class Detail(val commit: GitCommit) : CommitNav
    data class FileDiff(val sha: String, val file: GitFile) : CommitNav
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CommitsScreen(
    sessionId: String,
    branch: String?,
    onBack: () -> Unit,
    vm: CommitsViewModel = viewModel(key = "commits-$sessionId"),
) {
    LaunchedEffect(sessionId) { vm.start(sessionId, branch) }
    var nav by remember { mutableStateOf<CommitNav>(CommitNav.Log) }

    // System back pops the internal stack first, then leaves the screen.
    BackHandler {
        nav = when (val cur = nav) {
            is CommitNav.FileDiff -> CommitNav.Detail(GitCommit(sha = cur.sha, shortSha = cur.sha.take(7)))
            is CommitNav.Detail -> CommitNav.Log
            CommitNav.Log -> { onBack(); CommitNav.Log }
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                navigationIcon = {
                    IconButton(onClick = {
                        when (val cur = nav) {
                            is CommitNav.FileDiff ->
                                nav = CommitNav.Detail(GitCommit(sha = cur.sha, shortSha = cur.sha.take(7)))
                            is CommitNav.Detail -> nav = CommitNav.Log
                            CommitNav.Log -> onBack()
                        }
                    }) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.back))
                    }
                },
                title = {
                    val titleText = when (val cur = nav) {
                        is CommitNav.FileDiff -> cur.file.path
                        is CommitNav.Detail -> cur.commit.shortSha.ifEmpty { cur.commit.sha.take(7) }
                        CommitNav.Log -> stringResource(R.string.commits_title)
                    }
                    Text(titleText, maxLines = 1, overflow = TextOverflow.Ellipsis)
                },
            )
        },
    ) { inner ->
        Box(Modifier.fillMaxSize().padding(inner)) {
            when (val cur = nav) {
                CommitNav.Log -> CommitLog(
                    vm = vm,
                    onOpen = { nav = CommitNav.Detail(it) },
                )
                is CommitNav.Detail -> CommitDetail(
                    commit = cur.commit,
                    load = vm::loadDetail,
                    onOpenFile = { sha, file -> nav = CommitNav.FileDiff(sha, file) },
                )
                is CommitNav.FileDiff -> CommitFileDiff(
                    sha = cur.sha,
                    file = cur.file,
                    load = vm::loadDiff,
                )
            }
        }
    }
}

// ── Level 1: commit log ────────────────────────────────────────────────────────

@Composable
private fun CommitLog(vm: CommitsViewModel, onOpen: (GitCommit) -> Unit) {
    val state by vm.state.collectAsStateWithLifecycle()

    when {
        state.loading && state.commits.isEmpty() ->
            CenteredSpinner()

        state.commits.isEmpty() && state.didFail ->
            EmptyState(
                title = stringResource(R.string.commits_error_title),
                body = stringResource(R.string.commits_error_body),
                action = stringResource(R.string.retry) to vm::initialLoad,
            )

        state.commits.isEmpty() ->
            EmptyState(
                title = stringResource(R.string.commits_empty_title),
                body = stringResource(R.string.commits_empty_body),
            )

        else -> LazyColumn(Modifier.fillMaxSize()) {
            items(state.commits, key = { it.sha }) { commit ->
                CommitRow(commit, onClick = { onOpen(commit) })
                HorizontalDivider(color = PsColor.outline.copy(alpha = 0.5f))
            }
            if (!state.reachedEnd) {
                item(key = "load-more") {
                    LoadMoreRow(loading = state.loadingMore, onClick = vm::loadMore)
                }
            }
        }
    }
}

@Composable
private fun CommitRow(commit: GitCommit, onClick: () -> Unit) {
    val a11y = stringResource(R.string.commits_row_a11y, commit.subject)
    Column(
        Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .semantics { contentDescription = a11y }
            .padding(horizontal = 16.dp, vertical = 10.dp),
    ) {
        Text(
            commit.subject,
            style = MaterialTheme.typography.bodyMedium,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
        Row(
            Modifier.fillMaxWidth().padding(top = 3.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                commit.shortSha,
                color = PsColor.accent,
                style = MaterialTheme.typography.labelSmall.copy(fontFamily = FontFamily.Monospace),
            )
            if (commit.author.isNotEmpty()) {
                Text("·", color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.labelSmall)
                Text(
                    commit.author,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.labelSmall,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            val rel = relativeDate(commit.date)
            if (rel.isNotEmpty()) {
                Text("·", color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.labelSmall)
                Text(rel, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.labelSmall)
            }
        }
    }
}

@Composable
private fun LoadMoreRow(loading: Boolean, onClick: () -> Unit) {
    Box(
        Modifier.fillMaxWidth().padding(vertical = 12.dp),
        contentAlignment = Alignment.Center,
    ) {
        if (loading) {
            CircularProgressIndicator(modifier = Modifier.size(24.dp))
        } else {
            TextButton(onClick = onClick) { Text(stringResource(R.string.commits_load_more)) }
        }
    }
}

// ── Level 2: commit detail (meta + changed files) ──────────────────────────────

@Composable
private fun CommitDetail(
    commit: GitCommit,
    load: suspend (String) -> GitCommitDetail?,
    onOpenFile: (String, GitFile) -> Unit,
) {
    var detail by remember(commit.sha) { mutableStateOf<GitCommitDetail?>(null) }
    var loading by remember(commit.sha) { mutableStateOf(true) }
    LaunchedEffect(commit.sha) {
        loading = true
        detail = load(commit.sha)
        loading = false
    }

    val d = detail
    when {
        loading && d == null -> CenteredSpinner()
        d == null -> EmptyState(
            title = stringResource(R.string.commits_error_title),
            body = stringResource(R.string.commits_error_body),
        )
        else -> LazyColumn(Modifier.fillMaxSize()) {
            item(key = "header") { CommitHeader(d) }
            item(key = "header-div") { HorizontalDivider(color = PsColor.outline.copy(alpha = 0.5f)) }
            if (d.files.isEmpty()) {
                item(key = "no-changes") {
                    Text(
                        stringResource(R.string.commit_no_changes),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        style = MaterialTheme.typography.bodyMedium,
                        modifier = Modifier.fillMaxWidth().padding(16.dp),
                    )
                }
            } else {
                item(key = "files-header") {
                    Text(
                        stringResource(R.string.commit_files_section),
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                    )
                }
                items(d.files, key = { it.path }) { file ->
                    FileRow(file, onClick = { onOpenFile(d.sha, file) })
                    HorizontalDivider(color = PsColor.outline.copy(alpha = 0.5f))
                }
            }
        }
    }
}

@Composable
private fun CommitHeader(d: GitCommitDetail) {
    Column(Modifier.fillMaxWidth().padding(16.dp)) {
        Text(d.subject, style = MaterialTheme.typography.titleMedium)
        if (d.body.isNotEmpty()) {
            Text(
                d.body,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = 8.dp),
            )
        }
        Row(
            Modifier.fillMaxWidth().padding(top = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            if (d.author.isNotEmpty()) {
                Text(d.author, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            val rel = relativeDate(d.date)
            if (rel.isNotEmpty()) {
                Text(rel, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        Text(
            d.shortSha,
            style = MaterialTheme.typography.labelSmall.copy(fontFamily = FontFamily.Monospace),
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(top = 4.dp),
        )
    }
}

@Composable
private fun FileRow(file: GitFile, onClick: () -> Unit) {
    val a11y = stringResource(R.string.commit_file_a11y, file.path)
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .semantics { contentDescription = a11y }
            .padding(horizontal = 16.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            file.primaryStatus.toString(),
            color = statusColor(file.primaryStatus),
            style = MaterialTheme.typography.labelMedium.copy(fontFamily = FontFamily.Monospace),
            modifier = Modifier.size(16.dp),
        )
        Text(
            file.path,
            modifier = Modifier.weight(1f),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
        )
        if (file.additions > 0) {
            Text("+${file.additions}", color = PsColor.success, style = MaterialTheme.typography.labelSmall)
        }
        if (file.deletions > 0) {
            Text("−${file.deletions}", color = PsColor.danger, style = MaterialTheme.typography.labelSmall)
        }
    }
}

// ── Level 3: per-file commit-scoped diff ───────────────────────────────────────

@Composable
private fun CommitFileDiff(
    sha: String,
    file: GitFile,
    load: suspend (String, String) -> GitDiff?,
) {
    var resp by remember(sha, file.path) { mutableStateOf<GitDiff?>(null) }
    var loading by remember(sha, file.path) { mutableStateOf(true) }
    var failed by remember(sha, file.path) { mutableStateOf(false) }
    LaunchedEffect(sha, file.path) {
        loading = true
        failed = false
        val r = load(sha, file.path)
        resp = r
        failed = r == null
        loading = false
    }

    val r = resp
    when {
        loading && r == null -> CenteredSpinner()
        r == null && failed -> EmptyState(
            title = stringResource(R.string.commits_error_title),
            body = stringResource(R.string.commits_error_body),
        )
        r != null && r.binary -> EmptyState(
            title = stringResource(R.string.diff_binary_title),
            body = stringResource(R.string.diff_binary_body),
        )
        r != null && r.diff.isNullOrEmpty() -> EmptyState(
            title = stringResource(R.string.diff_empty_title),
            body = stringResource(R.string.diff_empty_body),
        )
        r != null -> Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
            if (r.truncated) {
                Text(
                    stringResource(R.string.diff_truncated),
                    color = PsColor.warning,
                    style = MaterialTheme.typography.labelMedium,
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp),
                )
            }
            DiffText(r.diff ?: "", modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp))
        }
    }
}

// ── shared bits ─────────────────────────────────────────────────────────────────

@Composable
private fun CenteredSpinner() {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        CircularProgressIndicator()
    }
}

@Composable
private fun EmptyState(title: String, body: String, action: Pair<String, () -> Unit>? = null) {
    Box(Modifier.fillMaxSize().padding(32.dp), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(title, style = MaterialTheme.typography.titleMedium)
            Text(
                body,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = 6.dp),
            )
            action?.let { (label, onClick) ->
                TextButton(onClick = onClick, modifier = Modifier.padding(top = 8.dp)) { Text(label) }
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

/** ISO-8601 author date → locale-aware relative label. Falls back to the raw string on parse failure. */
private fun relativeDate(iso: String): String {
    if (iso.isEmpty()) return ""
    val epochMs = runCatching {
        OffsetDateTime.parse(iso, DateTimeFormatter.ISO_OFFSET_DATE_TIME).toInstant().toEpochMilli()
    }.getOrNull() ?: return iso
    return DateUtils.getRelativeTimeSpanString(
        epochMs,
        System.currentTimeMillis(),
        DateUtils.MINUTE_IN_MILLIS,
    ).toString()
}
