package com.pocketsisyphus.android.data.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/** Shared JSON codec — tolerant of daemon fields we don't model + version drift. */
val PsJson: Json = Json {
    ignoreUnknownKeys = true
    isLenient = true
    encodeDefaults = true
    explicitNulls = false
    coerceInputValues = true
}

// ─────────────────────────────────────────────────────────────────────────────
// Pairing payload (mac/daemon/src/tor/pairing.ts, v=3). Scanned from QR or pasted.
// ─────────────────────────────────────────────────────────────────────────────

@Serializable
data class PairPayload(
    val v: Int = 0,
    val onion: String = "",
    @SerialName("onion_auth") val onionAuth: String = "",
    @SerialName("endpoint_token") val endpointToken: String = "",
    @SerialName("daemon_token") val daemonToken: String = "",
    @SerialName("ssh_host_key_fingerprint") val sshHostKeyFingerprint: String = "",
    @SerialName("ssh_host_key") val sshHostKey: String? = null,
    @SerialName("ssh_client_priv") val sshClientPriv: String = "",
    @SerialName("ssh_user") val sshUser: String = "",
    @SerialName("lan_host") val lanHost: String? = null,
    @SerialName("ssh_port") val sshPort: Int? = null,
    @SerialName("daemon_port") val daemonPort: Int? = null,
    val name: String? = null,
) {
    /** v=3 is the SSH-first + Tor-fallback dual-channel format this client speaks. */
    val isSupportedVersion: Boolean get() = v >= MIN_PAIR_VERSION

    val isUsable: Boolean
        get() = daemonToken.isNotEmpty() && sshClientPriv.isNotEmpty() && sshUser.isNotEmpty()

    /** `<base>` of a `<base>.onion` address, for the Tor v3 client-auth file name. */
    val onionBase: String?
        get() = onion.removeSuffix(".onion").ifBlank { null }

    companion object {
        const val MIN_PAIR_VERSION = 3
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// /endpoint (mac/daemon/src/routes/endpoint.ts) — fetched over the Tor onion to
// discover the reachable SSH candidates (direct IPv6/IPv4 + tor_onion fallback).
// ─────────────────────────────────────────────────────────────────────────────

enum class EndpointKind(val wire: String) {
    DIRECT_LAN("direct_lan"),
    DIRECT_IPV6("direct_ipv6"),
    DIRECT_IPV4("direct_ipv4"),
    TOR_ONION("tor_onion"),
    UNKNOWN("");

    companion object {
        fun from(wire: String): EndpointKind = entries.firstOrNull { it.wire == wire } ?: UNKNOWN
    }
}

@Serializable
data class EndpointEntry(
    val type: String = "",
    val host: String = "",
    val port: Int = 0,
    val priority: Int = 99,
) {
    val kind: EndpointKind get() = EndpointKind.from(type)
    val isTor: Boolean get() = kind == EndpointKind.TOR_ONION
}

@Serializable
data class EndpointResponse(
    val v: Int = 1,
    val endpoints: List<EndpointEntry> = emptyList(),
    @SerialName("ssh_host_key_fingerprint") val sshHostKeyFingerprint: String = "",
    @SerialName("ssh_user") val sshUser: String = "",
    @SerialName("daemon_local_port") val daemonLocalPort: Int = 7777,
    @SerialName("issued_at") val issuedAt: String? = null,
    @SerialName("ttl_sec") val ttlSec: Int = 300,
)

// ─────────────────────────────────────────────────────────────────────────────
// Sessions
// ─────────────────────────────────────────────────────────────────────────────

@Serializable
data class SessionsResponse(val sessions: List<SessionRow> = emptyList())

@Serializable
data class SourceBrief(
    val id: String = "",
    val title: String? = null,
    val kind: String = "",
)

@Serializable
data class SessionRow(
    val id: String,
    val title: String? = null,
    @SerialName("repo_path") val repoPath: String = "",
    @SerialName("created_at") val createdAt: Long = 0,
    @SerialName("ended_at") val endedAt: Long? = null,
    val status: String = "active",
    @SerialName("parent_sdk_session_id") val parentSdkSessionId: String? = null,
    @SerialName("skip_permissions") val skipPermissions: Int? = null,
    val mode: String? = null,
    val agent: String? = null,
    @SerialName("notify_muted") val notifyMuted: Int? = null,
    val archived: Int? = null,
    @SerialName("workflow_run_id") val workflowRunId: String? = null,
    @SerialName("waiting_since") val waitingSince: Long? = null,
    @SerialName("last_activity") val lastActivity: Long? = null,
    @SerialName("idle_ms") val idleMs: Long? = null,
    @SerialName("waiting_reminder_idx") val waitingReminderIdx: Int? = null,
    @SerialName("notify_next_stop") val notifyNextStop: Boolean? = null,
    @SerialName("pending_prompt_preview") val pendingPromptPreview: String? = null,
    @SerialName("source_brief") val sourceBrief: SourceBrief? = null,
) {
    val isAwaitingUser: Boolean get() = waitingSince != null
    val isArchived: Boolean get() = (archived ?: 0) == 1
    val isWorkflowSession: Boolean get() = workflowRunId != null

    val runState: RunState
        get() = when {
            endedAt != null || status == "completed" || status == "error" -> RunState.DONE
            isAwaitingUser -> RunState.WAITING
            else -> RunState.RUNNING
        }

    /** Display name: title, else the repo folder name, else a short id. */
    val displayTitle: String
        get() = title?.takeIf { it.isNotBlank() }
            ?: repoPath.trimEnd('/').substringAfterLast('/').ifEmpty { "session ${id.take(6)}" }

    /** Worktree branch slug parsed from a `…/<repo>.worktrees/<slug>` path, if any. */
    val worktreeBranchSlug: String?
        get() {
            val comps = repoPath.split('/').filter { it.isNotEmpty() }
            val wi = comps.indexOfLast { it.endsWith(".worktrees") }
            return if (wi >= 0 && wi + 1 < comps.size) comps[wi + 1] else null
        }
}

enum class RunState { WAITING, RUNNING, DONE }

/** Code-agent kinds the daemon supports (agent registry). */
enum class AgentKind(val id: String, val label: String) {
    CLAUDE_CODE("claude_code", "Claude Code"),
    CODEX("codex", "Codex"),
    COPILOT("copilot", "Copilot"),
    AGY("agy", "Gemini"),
    SHELL("shell", "Shell"),
    LOCAL_LLM("local_llm", "Local LLM"),
    OPENCODE("opencode", "OpenCode");

    companion object {
        fun from(id: String?): AgentKind? = entries.firstOrNull { it.id == id }
        fun label(id: String?): String = from(id)?.label ?: (id ?: "agent")
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Messages + polling
// ─────────────────────────────────────────────────────────────────────────────

@Serializable
data class MessageRow(
    val id: String,
    val role: String = "",
    val type: String = "",
    val payload: String = "",
    @SerialName("created_at") val createdAt: Long = 0,
)

@Serializable
data class PtyChunkPayload(@SerialName("bytes_b64") val bytesB64: String = "")

@Serializable
data class PtyUserInputPayload(val text: String = "")

@Serializable
data class PollResponse(
    val session: SessionRow,
    val messages: List<MessageRow> = emptyList(),
    val nextCreatedAt: Long = 0,
    val hasMoreBefore: Boolean = false,
    val oldestCreatedAt: Long? = null,
    val oldestId: String? = null,
)

@Serializable
data class CreateSessionRequest(
    val repoPath: String,
    val title: String? = null,
    val agent: String? = null,
    val skipPermissions: Boolean? = null,
)

@Serializable
data class CreateSessionResponse(
    val sessionId: String = "",
    val repoPath: String = "",
    val title: String? = null,
    val agent: String? = null,
)

@Serializable
data class SendMessageRequest(
    val text: String,
    val bypassPermissions: Boolean? = null,
)

@Serializable
data class ApiError(val error: String = "", val message: String? = null, val limit: Int? = null)

// ─────────────────────────────────────────────────────────────────────────────
// PTY snapshot
// ─────────────────────────────────────────────────────────────────────────────

@Serializable
data class PtySnapshot(
    val snapshot: String = "",
    val cols: Int = 80,
    val rows: Int = 24,
    val throughCreatedAt: Long = 0,
    val truncated: Boolean = false,
)

// ─────────────────────────────────────────────────────────────────────────────
// Git
// ─────────────────────────────────────────────────────────────────────────────

@Serializable
data class GitBranch(val branch: String? = null)

/** One branch from GET /git/branches (local or remote). Mirrors iOS GitBranch list item. */
@Serializable
data class GitBranchItem(
    val name: String = "",
    val sha: String = "",
    val upstream: String? = null,
    val subject: String = "",
    val current: Boolean = false,
)

@Serializable
data class GitBranchesResponse(
    val current: String? = null,
    val local: List<GitBranchItem> = emptyList(),
    val remote: List<GitBranchItem> = emptyList(),
)

/** One worktree from GET /git/worktrees. Mirrors iOS GitWorktree. */
@Serializable
data class GitWorktree(
    val path: String = "",
    val branch: String? = null,
    val head: String? = null,
    val isMain: Boolean = false,
    val isCurrent: Boolean = false,
    val locked: Boolean = false,
    val prunable: Boolean = false,
)

@Serializable
data class GitWorktreesResponse(val worktrees: List<GitWorktree> = emptyList())

@Serializable
data class GitStatusResponse(
    val files: List<GitFile> = emptyList(),
    val total: Int = 0,
)

@Serializable
data class GitFile(
    val path: String = "",
    val status: String = "",
    val additions: Int = 0,
    val deletions: Int = 0,
    val binary: Boolean = false,
    val origPath: String? = null,
) {
    /** Single dominant porcelain status char for badge coloring. */
    val primaryStatus: Char
        get() {
            if (status == "??") return '?'
            for (ch in status) {
                if (ch == ' ') continue
                if (ch == 'D' || ch == 'R' || ch == 'A' || ch == 'M') return ch
            }
            return '?'
        }
}

@Serializable
data class GitDiff(
    val path: String = "",
    val diff: String? = null,
    val binary: Boolean = false,
    val truncated: Boolean = false,
    val untracked: Boolean = false,
)

/**
 * One commit — an entry of daemon `GET /git/commits`. Mirrors iOS `GitCommit`.
 * `date` is a strict ISO-8601 author date (e.g. "2026-06-02T10:02:28+09:00").
 */
@Serializable
data class GitCommit(
    val sha: String = "",
    val shortSha: String = "",
    val author: String = "",
    val date: String = "",
    val subject: String = "",
)

@Serializable
data class GitCommitsResponse(
    val commits: List<GitCommit> = emptyList(),
    /** This page's count (NOT a grand total). `== limit` ⇒ assume there's more. */
    val total: Int = 0,
)

/** One commit's detail — meta + changed-file list (reuses the [GitFile] shape). */
@Serializable
data class GitCommitDetail(
    val sha: String = "",
    val shortSha: String = "",
    val author: String = "",
    val date: String = "",
    val subject: String = "",
    /** Commit message body (after the subject line). Empty when absent. */
    val body: String = "",
    val files: List<GitFile> = emptyList(),
)
// ─────────────────────────────────────────────────────────────────────────────
// File browser — same daemon contract as iOS (mac/daemon/src/routes/sessions.fs.ts).
//   GET /:id/fs/list  → DirectoryListing
//   GET /:id/fs/file  → FileContent (utf8 text / base64 image / base64 binary)
//   GET /:id/git/blob → FileContent (a file's bytes at a git ref)
// ─────────────────────────────────────────────────────────────────────────────

/** One row of a directory listing — a child folder or file. */
@Serializable
data class DirectoryEntry(
    val name: String = "",
    val isDirectory: Boolean = false,
    /** File size in bytes (0 for directories). */
    val size: Long = 0,
    /** mtime in epoch ms. */
    val modifiedAt: Long = 0,
)

/** One directory's listing — folders first, then files, name-sorted by the daemon. */
@Serializable
data class DirectoryListing(
    /** repo-relative path; "" at the root. */
    val path: String = "",
    /** parent path (repo-relative); null at the root, "" when one level up is the root. */
    val parent: String? = null,
    val entries: List<DirectoryEntry> = emptyList(),
)

/**
 * One file's body. `encoding == "utf8"` → [content] is text; `"base64"` → decode it.
 * Callers branch on [isText] / [isImage]; anything else is "unsupported".
 */
@Serializable
data class FileContent(
    val path: String = "",
    /** Filled for git/blob responses ("HEAD" …); null for fs/file. */
    val ref: String? = null,
    /** Original byte size. When [truncated], [content] is shorter than this. */
    val size: Long = 0,
    /** "utf8" | "base64". */
    val encoding: String = "utf8",
    /** MIME — "text/plain" / "image/png" / "application/octet-stream" … */
    val contentType: String = "",
    val content: String = "",
    val truncated: Boolean = false,
) {
    val isText: Boolean get() = encoding == "utf8"
    val isImage: Boolean get() = contentType.startsWith("image/")
}
