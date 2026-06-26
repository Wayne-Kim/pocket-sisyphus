package com.pocketsisyphus.android.ui.commits

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.pocketsisyphus.android.data.Ps
import com.pocketsisyphus.android.data.model.GitCommit
import com.pocketsisyphus.android.data.model.GitCommitDetail
import com.pocketsisyphus.android.data.model.GitDiff
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * Drives the commit-history flow: a paginated commit log plus on-demand commit
 * detail and per-file commit-scoped diff loads. Read-only — no git writes
 * (commit/rollback are out of scope). Consumes the same daemon contract as iOS.
 */
class CommitsViewModel : ViewModel() {

    data class UiState(
        val commits: List<GitCommit> = emptyList(),
        val loading: Boolean = true,
        val loadingMore: Boolean = false,
        val didFail: Boolean = false,
        /** Last page came back short ⇒ nothing more to fetch. */
        val reachedEnd: Boolean = false,
    )

    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state.asStateFlow()

    private var sessionId: String = ""
    private var ref: String? = null
    private var started = false

    private val pageSize = 50

    fun start(id: String, branchRef: String?) {
        if (started) return
        started = true
        sessionId = id
        ref = branchRef
        initialLoad()
    }

    fun initialLoad() {
        _state.update { it.copy(loading = true, didFail = false) }
        viewModelScope.launch {
            val resp = runCatching { Ps.api.gitCommits(sessionId, ref, pageSize, 0) }.getOrNull()
            if (resp != null) {
                _state.update {
                    it.copy(
                        commits = resp.commits,
                        loading = false,
                        didFail = false,
                        reachedEnd = resp.commits.size < pageSize,
                    )
                }
            } else {
                _state.update { it.copy(loading = false, didFail = true) }
            }
        }
    }

    fun loadMore() {
        val s = _state.value
        if (s.loadingMore || s.reachedEnd || s.loading) return
        _state.update { it.copy(loadingMore = true) }
        viewModelScope.launch {
            val resp = runCatching { Ps.api.gitCommits(sessionId, ref, pageSize, s.commits.size) }.getOrNull()
            if (resp == null) {
                // Transient failure — leave the «load more» button so a retap retries.
                _state.update { it.copy(loadingMore = false) }
                return@launch
            }
            // Dedupe by sha so a commit landing between pages can't collide keys.
            val known = s.commits.mapTo(HashSet()) { it.sha }
            val merged = s.commits + resp.commits.filter { it.sha !in known }
            _state.update {
                it.copy(
                    commits = merged,
                    loadingMore = false,
                    reachedEnd = resp.commits.size < pageSize,
                )
            }
        }
    }

    suspend fun loadDetail(sha: String): GitCommitDetail? =
        runCatching { Ps.api.gitCommitDetail(sessionId, sha) }.getOrNull()

    suspend fun loadDiff(sha: String, path: String): GitDiff? =
        runCatching { Ps.api.gitCommitDiff(sessionId, sha, path) }.getOrNull()
}
