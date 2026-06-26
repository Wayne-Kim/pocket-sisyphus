package com.pocketsisyphus.android.ui.settings

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.pocketsisyphus.android.data.ApiException
import com.pocketsisyphus.android.data.Ps
import com.pocketsisyphus.android.data.model.AddMcpRequest
import com.pocketsisyphus.android.data.model.DeviceInfoResponse
import com.pocketsisyphus.android.data.model.McpCatalogEntry
import com.pocketsisyphus.android.data.model.McpServer
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Backs the settings «Devices» and «Tools» sub-screens — consumes the same daemon admin/MCP
 * routes the iPhone does. Action results carry a small symbolic key the UI localizes; raw daemon
 * error bodies are passed through only as fallback detail.
 */
class SettingsViewModel : ViewModel() {

    private val api get() = Ps.api

    // ── Devices ──────────────────────────────────────────────────────────────

    data class DevicesUi(
        val loading: Boolean = true,
        val info: DeviceInfoResponse? = null,
        val error: Boolean = false,
        val myFingerprint: String? = null,
        val busy: Boolean = false,
        /** Symbolic result key the UI localizes (e.g. "revoked", "already_revoked"). */
        val resultKey: String? = null,
        /** Set once this very device revoked itself — the screen then unpairs. */
        val selfRevoked: Boolean = false,
    )

    private val _devices = MutableStateFlow(DevicesUi())
    val devices: StateFlow<DevicesUi> = _devices.asStateFlow()

    fun loadDevices() {
        _devices.value = _devices.value.copy(loading = true, error = false)
        viewModelScope.launch {
            val fp = withContext(Dispatchers.IO) { runCatching { Ps.attest.publicKeyFingerprint() }.getOrNull() }
            try {
                val info = api.deviceInfo()
                _devices.value = _devices.value.copy(loading = false, info = info, error = false, myFingerprint = fp)
            } catch (e: Throwable) {
                _devices.value = _devices.value.copy(loading = false, error = true, myFingerprint = fp)
            }
        }
    }

    fun isCurrentDevice(d: DeviceInfoResponse.Device): Boolean {
        val mine = _devices.value.myFingerprint ?: return false
        val fp = d.attestKeyFingerprint ?: return false
        return mine == fp
    }

    /** Optimistic extra-slot toggle; reverts + reports on the daemon's 409. */
    fun setExtraSlot(allowed: Boolean) {
        val info = _devices.value.info ?: return
        _devices.value = _devices.value.copy(
            info = info.copy(extraSlotAllowed = allowed), busy = true, resultKey = null,
        )
        viewModelScope.launch {
            try {
                api.setExtraDeviceSlot(allowed)
                loadDevices()
                _devices.value = _devices.value.copy(busy = false)
            } catch (e: ApiException) {
                val key = if (e.code == 409 && e.errorBody.contains("remove_extra_device_first"))
                    "slot_remove_first" else "slot_failed"
                _devices.value = _devices.value.copy(info = info.copy(extraSlotAllowed = !allowed), busy = false, resultKey = key)
            } catch (e: Throwable) {
                _devices.value = _devices.value.copy(info = info.copy(extraSlotAllowed = !allowed), busy = false, resultKey = "slot_failed")
            }
        }
    }

    fun revokeDevice(d: DeviceInfoResponse.Device) {
        val fp = d.attestKeyFingerprint ?: return
        val current = isCurrentDevice(d)
        _devices.value = _devices.value.copy(busy = true, resultKey = null)
        viewModelScope.launch {
            try {
                api.revokeDevice(fp)
                if (current) {
                    _devices.value = _devices.value.copy(busy = false, selfRevoked = true)
                    return@launch
                }
                loadDevices()
                _devices.value = _devices.value.copy(busy = false, resultKey = "revoked")
            } catch (e: ApiException) {
                if (e.code == 404 && e.errorBody.contains("device_not_found")) {
                    loadDevices()
                    _devices.value = _devices.value.copy(busy = false, resultKey = "already_revoked")
                } else {
                    _devices.value = _devices.value.copy(busy = false, resultKey = "revoke_failed")
                }
            } catch (e: Throwable) {
                _devices.value = _devices.value.copy(busy = false, resultKey = "revoke_failed")
            }
        }
    }

    fun clearDevicesResult() {
        _devices.value = _devices.value.copy(resultKey = null)
    }

    // ── Tools (MCP) ────────────────────────────────────────────────────────────

    data class ToolsUi(
        val loading: Boolean = true,
        val servers: List<McpServer> = emptyList(),
        val catalog: List<McpCatalogEntry> = emptyList(),
        val loadError: Boolean = false,
        val busyId: String? = null,
        /** Raw action-error detail (already-best-effort daemon message); null = none. */
        val actionError: String? = null,
        val saving: Boolean = false,
        val saveError: String? = null,
    )

    private val _tools = MutableStateFlow(ToolsUi())
    val tools: StateFlow<ToolsUi> = _tools.asStateFlow()

    fun loadTools() {
        _tools.value = _tools.value.copy(loading = true, loadError = false)
        viewModelScope.launch {
            try {
                val servers = api.listMcpServers().servers
                val catalog = api.mcpCatalog().catalog
                _tools.value = _tools.value.copy(loading = false, servers = servers, catalog = catalog, loadError = false)
            } catch (e: Throwable) {
                _tools.value = _tools.value.copy(loading = false, loadError = true)
            }
        }
    }

    fun connectTool(server: McpServer) = toolAction(server.id) { api.triggerMcpOauth(server.id) }
    fun revokeTool(server: McpServer) = toolAction(server.id) { api.revokeMcpServer(server.id) }
    fun deleteTool(server: McpServer) = toolAction(server.id) { api.deleteMcpServer(server.id) }

    private fun toolAction(id: String, block: suspend () -> Unit) {
        _tools.value = _tools.value.copy(busyId = id, actionError = null)
        viewModelScope.launch {
            try {
                block()
                val servers = api.listMcpServers().servers
                _tools.value = _tools.value.copy(busyId = null, servers = servers)
            } catch (e: Throwable) {
                _tools.value = _tools.value.copy(busyId = null, actionError = errorDetail(e))
            }
        }
    }

    fun clearToolActionError() {
        _tools.value = _tools.value.copy(actionError = null)
    }

    fun clearSaveError() {
        _tools.value = _tools.value.copy(saveError = null)
    }

    /** Add a tool server; invokes [onSaved] on success. */
    fun addTool(req: AddMcpRequest, onSaved: () -> Unit) {
        _tools.value = _tools.value.copy(saving = true, saveError = null)
        viewModelScope.launch {
            try {
                api.addMcpServer(req)
                val servers = api.listMcpServers().servers
                _tools.value = _tools.value.copy(saving = false, servers = servers)
                onSaved()
            } catch (e: Throwable) {
                _tools.value = _tools.value.copy(saving = false, saveError = errorDetail(e))
            }
        }
    }

    private fun errorDetail(e: Throwable): String = when (e) {
        is ApiException -> e.errorBody.ifBlank { "HTTP ${e.code}" }
        else -> e.message ?: e.toString()
    }
}
