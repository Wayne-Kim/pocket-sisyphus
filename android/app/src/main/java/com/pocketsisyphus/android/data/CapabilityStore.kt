package com.pocketsisyphus.android.data

import com.pocketsisyphus.android.data.model.VersionInfo
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Caches the daemon's advertised capabilities (GET /api/version), fetched once per connection.
 * Pro/automation entry points read this to decide whether to show, hide, or branch to
 * «update the Mac app» (capability missing on an older daemon).
 */
class CapabilityStore(private val api: ApiClient) {

    private val _version = MutableStateFlow<VersionInfo?>(null)
    val version: StateFlow<VersionInfo?> = _version.asStateFlow()

    /** Best-effort refresh — failures leave the last known value (or null) untouched. */
    suspend fun refresh() {
        try {
            _version.value = api.version()
        } catch (_: Throwable) {
            // Transient — keep whatever we had; callers treat null as «unknown, hide Pro».
        }
    }

    val current: VersionInfo? get() = _version.value
}
