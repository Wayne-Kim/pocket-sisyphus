package com.pocketsisyphus.android.ui.cron

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.pocketsisyphus.android.data.Ps
import com.pocketsisyphus.android.data.model.CronJob
import com.pocketsisyphus.android.data.model.CronJobUpsertRequest
import com.pocketsisyphus.android.data.model.CronRun
import com.pocketsisyphus.android.data.model.CronRunStartResult
import com.pocketsisyphus.android.data.model.SchedulePreview
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** List + run/delete state for the scheduled-tasks surface. */
class CronViewModel : ViewModel() {

    data class UiState(
        val loading: Boolean = true,
        val jobs: List<CronJob> = emptyList(),
        val error: String? = null,
        val runResult: CronRunStartResult? = null,
        val busyId: String? = null,
    )

    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state.asStateFlow()

    init {
        refresh()
    }

    fun refresh() = viewModelScope.launch {
        try {
            val resp = Ps.api.listCron()
            _state.update { it.copy(loading = false, jobs = resp.jobs, error = null) }
        } catch (e: Throwable) {
            _state.update { it.copy(loading = false, error = e.message ?: "Failed to load") }
        }
    }

    fun runNow(id: String) = viewModelScope.launch {
        _state.update { it.copy(busyId = id, error = null) }
        try {
            val result = Ps.api.runCron(id)
            _state.update { it.copy(busyId = null, runResult = result) }
            refresh()
        } catch (e: Throwable) {
            _state.update { it.copy(busyId = null, error = e.message ?: "Run failed") }
        }
    }

    fun toggleEnabled(job: CronJob) = viewModelScope.launch {
        try {
            Ps.api.updateCron(job.id, CronJobUpsertRequest(enabled = !job.isEnabled))
            refresh()
        } catch (e: Throwable) {
            _state.update { it.copy(error = e.message ?: "Update failed") }
        }
    }

    fun delete(id: String) = viewModelScope.launch {
        try {
            Ps.api.deleteCron(id)
            refresh()
        } catch (e: Throwable) {
            _state.update { it.copy(error = e.message ?: "Delete failed") }
        }
    }

    fun clearRunResult() = _state.update { it.copy(runResult = null) }
    fun clearError() = _state.update { it.copy(error = null) }
}

/** Editor (create/edit) state, including debounced schedule preview against the daemon. */
class CronEditorViewModel : ViewModel() {

    data class UiState(
        val saving: Boolean = false,
        val error: String? = null,
        val preview: SchedulePreview? = null,
        val saved: Boolean = false,
    )

    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state.asStateFlow()

    private var previewJob: Job? = null

    /** Debounced (400ms) cron-expression validation/preview. */
    fun previewSchedule(schedule: String, timezone: String?) {
        previewJob?.cancel()
        if (schedule.isBlank()) {
            _state.update { it.copy(preview = null) }
            return
        }
        previewJob = viewModelScope.launch {
            delay(400)
            try {
                val p = Ps.api.previewSchedule(schedule.trim(), timezone)
                _state.update { it.copy(preview = p) }
            } catch (_: Throwable) {
                // Preview is advisory; ignore transient failures.
            }
        }
    }

    fun save(existingId: String?, req: CronJobUpsertRequest) = viewModelScope.launch {
        _state.update { it.copy(saving = true, error = null) }
        try {
            if (existingId == null) Ps.api.createCron(req) else Ps.api.updateCron(existingId, req)
            _state.update { it.copy(saving = false, saved = true) }
        } catch (e: Throwable) {
            _state.update { it.copy(saving = false, error = e.message ?: "Save failed") }
        }
    }
}

fun cronStatusKey(status: String?): Int? = when (status) {
    "ok" -> com.pocketsisyphus.android.R.string.cron_status_ok
    "error" -> com.pocketsisyphus.android.R.string.cron_status_error
    "timeout" -> com.pocketsisyphus.android.R.string.cron_status_timeout
    "skipped" -> com.pocketsisyphus.android.R.string.cron_status_skipped
    "running" -> com.pocketsisyphus.android.R.string.cron_status_running
    else -> null
}

/** Latest-run summary line for a run row. */
fun CronRun.isFailureLike(): Boolean = status == "error" || status == "timeout"
