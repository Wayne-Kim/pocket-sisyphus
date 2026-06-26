package com.pocketsisyphus.android.data.model

import kotlinx.serialization.Serializable

// ─────────────────────────────────────────────────────────────────────────────
// Device management — GET /api/admin/device-info (mac/daemon/src/routes/admin.ts).
// Same shape iOS DevicesView consumes; the phone is the control panel for device trust.
// ─────────────────────────────────────────────────────────────────────────────

@Serializable
data class DeviceInfoResponse(
    /** Whether ≥1 device is enrolled. false = soft mode (unregistered / old phone). */
    val enrolled: Boolean = false,
    /** Whether the extra-device slot is on. Default false (one device only). */
    val extraSlotAllowed: Boolean = false,
    /** Absolute cap on connectable devices (always render this — never hardcode). */
    val maxSlots: Int = 1,
    /** Pairing SSH client-key fingerprint shared by every device (the QR's key). */
    val sshClientKeyFingerprint: String? = null,
    val devices: List<Device> = emptyList(),
) {
    @Serializable
    data class Device(
        /** SE public-key registration time (epoch ms). */
        val registeredAt: Long? = null,
        /** Last authenticated access (epoch ms, in-memory since daemon boot). */
        val lastSeen: Long? = null,
        /** SE public-key fingerprint ("SHA256:…"); the revoke key. null = unknown. */
        val attestKeyFingerprint: String? = null,
    )
}

// ─────────────────────────────────────────────────────────────────────────────
// MCP «tools» — external tool servers the agent connects to (mac/daemon/src/routes/mcp.ts).
// Tokens live only on the Mac (0600); this client sees metadata/custody status only.
// ─────────────────────────────────────────────────────────────────────────────

@Serializable
data class McpServer(
    val id: String,
    /** Catalog provider id ("google_calendar" | "gmail" | "custom"). */
    val catalogId: String = "custom",
    /** Fallback label — used for unknown (custom) providers. */
    val label: String = "",
    val agent: String = "",
    val repoPath: String = "",
    /** Remote MCP transport URL (an identifier — not a translation target). */
    val url: String = "",
    val scopes: List<String> = emptyList(),
    /** Whether write scopes are granted (user opt-in). */
    val writeEnabled: Boolean = false,
    /** "unconfigured" | "connected" | "expired" | "error" | "unreachable". */
    val status: String = "unconfigured",
    val createdAt: Long = 0,
    val connectedAt: Long? = null,
    val tokenExpiresAt: Long? = null,
    /** Daemon reachability probe: true=reachable / false=confirmed unreachable / null=unverified. */
    val reachable: Boolean? = null,
    /** Health diagnostic message (unreachable/unverified reason); null = none. */
    val detail: String? = null,
)

/** MCP connection status — the SSOT for status color/label branching. */
enum class McpStatus { UNCONFIGURED, CONNECTED, EXPIRED, ERROR, UNREACHABLE }

fun McpServer.statusValue(): McpStatus = when (status) {
    "connected" -> McpStatus.CONNECTED
    "expired" -> McpStatus.EXPIRED
    "unreachable" -> McpStatus.UNREACHABLE
    "unconfigured" -> McpStatus.UNCONFIGURED
    else -> McpStatus.ERROR
}

@Serializable
data class McpCatalogEntry(
    val id: String,
    /** SF Symbol name from the daemon catalog (an identifier; Android maps its own icon). */
    val icon: String = "wrench.and.screwdriver",
    val label: String = "",
    /** Well-known default server URL; empty means a custom URL is required. */
    val defaultUrl: String = "",
    val readScopes: List<String> = emptyList(),
    val writeScopes: List<String> = emptyList(),
)

@Serializable
data class McpServersResponse(val servers: List<McpServer> = emptyList())

@Serializable
data class McpCatalogResponse(val catalog: List<McpCatalogEntry> = emptyList())

@Serializable
data class McpServerResponse(val server: McpServer? = null)

/** POST /api/mcp request body. */
@Serializable
data class AddMcpRequest(
    val catalogId: String,
    val agent: String,
    val repoPath: String,
    val url: String,
    val writeEnabled: Boolean,
)
