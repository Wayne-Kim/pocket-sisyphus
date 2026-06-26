package com.pocketsisyphus.android.data

import com.pocketsisyphus.android.data.model.AddMcpRequest
import com.pocketsisyphus.android.data.model.AgentInfo
import com.pocketsisyphus.android.data.model.AgentsResponse
import com.pocketsisyphus.android.data.model.AttachmentImage
import com.pocketsisyphus.android.data.model.AttachmentUploadRequest
import com.pocketsisyphus.android.data.model.AttachmentUploadResponse
import com.pocketsisyphus.android.data.model.CreateSessionRequest
import com.pocketsisyphus.android.data.model.CreateSessionResponse
import com.pocketsisyphus.android.data.model.CreateWorkflowRequest
import com.pocketsisyphus.android.data.model.DesignWorkflowRequest
import com.pocketsisyphus.android.data.model.WorkflowDesignStartResponse
import com.pocketsisyphus.android.data.model.WorkflowDesignStateResponse
import com.pocketsisyphus.android.data.model.WorkflowTemplate
import com.pocketsisyphus.android.data.model.WorkflowTemplatesResponse
import com.pocketsisyphus.android.data.model.CronJobDetailResponse
import com.pocketsisyphus.android.data.model.CronJobResponse
import com.pocketsisyphus.android.data.model.CronJobUpsertRequest
import com.pocketsisyphus.android.data.model.CronJobsResponse
import com.pocketsisyphus.android.data.model.CronRunStartResult
import com.pocketsisyphus.android.data.model.DeviceInfoResponse
import com.pocketsisyphus.android.data.model.DirectoryListing
import com.pocketsisyphus.android.data.model.FileContent
import com.pocketsisyphus.android.data.model.GitBranch
import com.pocketsisyphus.android.data.model.GitBranchesResponse
import com.pocketsisyphus.android.data.model.GitWorktreesResponse
import com.pocketsisyphus.android.data.model.GitCommitDetail
import com.pocketsisyphus.android.data.model.GitCommitsResponse
import com.pocketsisyphus.android.data.model.GitDiff
import com.pocketsisyphus.android.data.model.GitStatusResponse
import com.pocketsisyphus.android.data.model.ListDirResponse
import com.pocketsisyphus.android.data.model.McpCatalogResponse
import com.pocketsisyphus.android.data.model.McpServer
import com.pocketsisyphus.android.data.model.McpServerResponse
import com.pocketsisyphus.android.data.model.McpServersResponse
import com.pocketsisyphus.android.data.model.PoBriefsResponse
import com.pocketsisyphus.android.data.model.PoBulkDecideRequest
import com.pocketsisyphus.android.data.model.PoBulkDecideResponse
import com.pocketsisyphus.android.data.model.PoCleanupRequest
import com.pocketsisyphus.android.data.model.PoCleanupResponse
import com.pocketsisyphus.android.data.model.PoCollectRequest
import com.pocketsisyphus.android.data.model.PoCollectResponse
import com.pocketsisyphus.android.data.model.PoDecideRequest
import com.pocketsisyphus.android.data.model.PoDecideResponse
import com.pocketsisyphus.android.data.model.PoProfile
import com.pocketsisyphus.android.data.model.PoProfileUpsertRequest
import com.pocketsisyphus.android.data.model.PoResearchDetailResponse
import com.pocketsisyphus.android.data.model.PoReviseRequest
import com.pocketsisyphus.android.data.model.PoReviseResponse
import com.pocketsisyphus.android.data.model.PoStats
import com.pocketsisyphus.android.data.model.PoResearchListResponse
import com.pocketsisyphus.android.data.model.PoResearchRequest
import com.pocketsisyphus.android.data.model.PoResearchStartResponse
import com.pocketsisyphus.android.data.model.PollResponse
import com.pocketsisyphus.android.data.model.PsJson
import com.pocketsisyphus.android.data.model.PtySnapshot
import com.pocketsisyphus.android.data.model.RecentProject
import com.pocketsisyphus.android.data.model.RecentProjectsResponse
import com.pocketsisyphus.android.data.model.SchedulePreview
import com.pocketsisyphus.android.data.model.SendMessageRequest
import com.pocketsisyphus.android.data.model.SessionsResponse
import com.pocketsisyphus.android.data.model.VersionInfo
import com.pocketsisyphus.android.data.model.WorkflowCreateResponse
import com.pocketsisyphus.android.data.model.WorkflowDetailResponse
import com.pocketsisyphus.android.data.model.WorkflowRunStartResponse
import com.pocketsisyphus.android.data.model.WorkflowRunStateResponse
import com.pocketsisyphus.android.data.model.WorkflowsResponse
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.SerializationStrategy
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.net.URLEncoder

class ApiException(val code: Int, val errorBody: String) :
    IOException("HTTP $code: $errorBody")

/** Typed HTTP client for the daemon API, bound to the active SSH forward + bearer + attest token. */
class ApiClient(private val conn: ConnectionManager, private val attest: Attestation) {

    private val jsonMedia = "application/json; charset=utf-8".toMediaType()

    // ── Sessions ──────────────────────────────────────────────────────────────

    suspend fun listSessions(archived: String? = null): SessionsResponse =
        getJson(SessionsResponse.serializer(), "/api/sessions") {
            archived?.let { addQueryParameter("archived", it) }
        }

    suspend fun createSession(req: CreateSessionRequest): CreateSessionResponse {
        val out = postBody("/api/sessions", CreateSessionRequest.serializer(), req)
        return PsJson.decodeFromString(CreateSessionResponse.serializer(), out)
    }

    suspend fun poll(id: String, afterCreatedAt: Long?, limit: Int?): PollResponse =
        getJson(PollResponse.serializer(), "/api/sessions/${enc(id)}/poll") {
            afterCreatedAt?.let { addQueryParameter("afterCreatedAt", it.toString()) }
            limit?.let { addQueryParameter("limit", it.toString()) }
        }

    suspend fun sendMessage(id: String, text: String, bypassPermissions: Boolean? = null) {
        postBody(
            "/api/sessions/${enc(id)}/messages",
            SendMessageRequest.serializer(),
            SendMessageRequest(text = text, bypassPermissions = bypassPermissions),
        )
    }

    /** Permanently delete a session + its history (same DELETE route as the iPhone). */
    suspend fun deleteSession(id: String) {
        sendRaw("DELETE", "/api/sessions/${enc(id)}", null)
    }

    /** Rename a session (session_rename_v1). Empty title ⇒ the daemon stores NULL ("untitled"). */
    suspend fun renameSession(id: String, title: String) {
        sendRaw("PATCH", "/api/sessions/${enc(id)}", buildJsonObject { put("title", title) }.toString())
    }

    /** Upload base64 images into the session repo; returns the stored repo-relative paths. */
    suspend fun uploadAttachments(id: String, dir: String?, images: List<AttachmentImage>): AttachmentUploadResponse {
        val out = postBody(
            "/api/sessions/${enc(id)}/attachments",
            AttachmentUploadRequest.serializer(),
            AttachmentUploadRequest(dir = dir, images = images),
        )
        return PsJson.decodeFromString(AttachmentUploadResponse.serializer(), out)
    }

    // ── PTY ───────────────────────────────────────────────────────────────────

    suspend fun snapshot(id: String): PtySnapshot =
        getJson(PtySnapshot.serializer(), "/api/sessions/${enc(id)}/pty/snapshot")

    suspend fun resize(id: String, cols: Int, rows: Int) {
        postRaw("/api/sessions/${enc(id)}/pty/resize", """{"cols":$cols,"rows":$rows}""")
    }

    suspend fun ptyControl(id: String, action: String) {
        postRaw("/api/sessions/${enc(id)}/pty/control", """{"action":"$action"}""")
    }

    suspend fun ptyKey(id: String, key: String) {
        postRaw("/api/sessions/${enc(id)}/pty/key", """{"key":"$key"}""")
    }

    /** Kill the current REPL process and start a fresh terminal (same route as the iPhone). */
    suspend fun restartPty(id: String) {
        postRaw("/api/sessions/${enc(id)}/pty/restart", "{}")
    }

    // ── Git ─────────────────────────────────────────────────────────────────────

    suspend fun gitBranch(id: String): GitBranch =
        getJson(GitBranch.serializer(), "/api/sessions/${enc(id)}/git/branch")

    suspend fun gitStatus(id: String): GitStatusResponse =
        getJson(GitStatusResponse.serializer(), "/api/sessions/${enc(id)}/git/status")

    // ── Branch / worktree management (same daemon contract as the iPhone BranchSheet) ──────

    /** Local + remote branches (with current flag, upstream, last-commit subject). */
    suspend fun gitBranches(id: String): GitBranchesResponse =
        getJson(GitBranchesResponse.serializer(), "/api/sessions/${enc(id)}/git/branches")

    /** Switch to [name]; `track=true` creates a local tracking branch from a remote. */
    suspend fun gitCheckout(id: String, name: String, track: Boolean = false) {
        postRaw("/api/sessions/${enc(id)}/git/checkout", buildJsonObject {
            put("name", name); put("track", track)
        }.toString())
    }

    /** Create a branch (optionally from [from]); `checkout=true` switches to it. */
    suspend fun gitCreateBranch(id: String, name: String, from: String? = null, checkout: Boolean = false) {
        postRaw("/api/sessions/${enc(id)}/git/branch", buildJsonObject {
            put("name", name); from?.let { put("from", it) }; put("checkout", checkout)
        }.toString())
    }

    /** Delete a local branch. 409 if unmerged → retry with [force]. Daemon blocks the current branch. */
    suspend fun gitDeleteBranch(id: String, name: String, force: Boolean = false) {
        val q = "?name=${enc(name)}" + if (force) "&force=1" else ""
        sendRaw("DELETE", "/api/sessions/${enc(id)}/git/branch$q", null)
    }

    /** Worktrees of this repo (path + branch + main/current flags). */
    suspend fun gitWorktrees(id: String): GitWorktreesResponse =
        getJson(GitWorktreesResponse.serializer(), "/api/sessions/${enc(id)}/git/worktrees")

    /** Add a worktree for [branch] (`newBranch=true` creates it); daemon picks the path. */
    suspend fun gitAddWorktree(id: String, branch: String, newBranch: Boolean, from: String? = null) {
        postRaw("/api/sessions/${enc(id)}/git/worktrees", buildJsonObject {
            put("branch", branch); put("newBranch", newBranch); from?.let { put("from", it) }
        }.toString())
    }

    /** Remove a worktree by path. Main / current worktrees are blocked by the daemon. */
    suspend fun gitRemoveWorktree(id: String, path: String, force: Boolean = false) {
        val q = "?path=${enc(path)}" + if (force) "&force=1" else ""
        sendRaw("DELETE", "/api/sessions/${enc(id)}/git/worktrees$q", null)
    }

    suspend fun gitDiff(id: String, path: String): GitDiff =
        getJson(GitDiff.serializer(), "/api/sessions/${enc(id)}/git/diff") {
            addQueryParameter("path", path)
        }

    /** Commit log, one page. `ref` null ⇒ HEAD. `skip` drives «load more» pagination. */
    suspend fun gitCommits(id: String, ref: String? = null, limit: Int = 50, skip: Int = 0): GitCommitsResponse =
        getJson(GitCommitsResponse.serializer(), "/api/sessions/${enc(id)}/git/commits") {
            addQueryParameter("limit", limit.toString())
            addQueryParameter("skip", skip.toString())
            ref?.takeIf { it.isNotEmpty() }?.let { addQueryParameter("ref", it) }
        }

    /** One commit's meta + changed-file list. */
    suspend fun gitCommitDetail(id: String, sha: String): GitCommitDetail =
        getJson(GitCommitDetail.serializer(), "/api/sessions/${enc(id)}/git/commit/${enc(sha)}")

    /** Unified diff of just what this commit did to one file (commit-scoped; same shape as gitDiff). */
    suspend fun gitCommitDiff(id: String, sha: String, path: String): GitDiff =
        getJson(GitDiff.serializer(), "/api/sessions/${enc(id)}/git/commit/${enc(sha)}/diff") {
            addQueryParameter("path", path)
        }

    // ── File browser ──────────────────────────────────────────────────────────
    // Same daemon contract as the iPhone FileBrowserSheet — the client only forwards
    // the repo-relative path; the daemon rejects `..` / absolute / symlink escapes.

    /** List the repo root ("") or a child directory. */
    suspend fun listDirectory(id: String, path: String = ""): DirectoryListing =
        getJson(DirectoryListing.serializer(), "/api/sessions/${enc(id)}/fs/list") {
            addQueryParameter("path", path)
        }

    /** Read one file's body — utf8 text, or base64 for images/binaries. */
    suspend fun readFile(id: String, path: String): FileContent =
        getJson(FileContent.serializer(), "/api/sessions/${enc(id)}/fs/file") {
            addQueryParameter("path", path)
        }

    /** Read a file's bytes at a git ref (default HEAD) — the "before" side of a change. */
    suspend fun readGitBlob(id: String, path: String, ref: String = "HEAD"): FileContent =
        getJson(FileContent.serializer(), "/api/sessions/${enc(id)}/git/blob") {
            addQueryParameter("path", path)
            addQueryParameter("ref", ref)
        }

    // ── Repo path picker (no session yet) ────────────────────────────────────────
    // Same daemon contract as the iPhone RepoPathField — pick an absolute work folder before a
    // session exists. Old daemons (404 on these routes) → callers absorb the throw as «empty».

    /** Recently-used absolute repo paths, most-recent first. */
    suspend fun recentProjects(): List<RecentProject> =
        getJson(RecentProjectsResponse.serializer(), "/api/recent-projects").projects

    /** Registered code-agent CLIs the daemon can spawn (claude_code, agy, codex, local_llm, …). */
    suspend fun agents(): List<AgentInfo> =
        getJson(AgentsResponse.serializer(), "/api/agents").agents

    /** Resolved absolute base + immediate child directories of [path] (empty ⇒ home). */
    suspend fun listDirBase(path: String): ListDirResponse =
        getJson(ListDirResponse.serializer(), "/api/fs/list-dir") {
            addQueryParameter("path", path)
        }

    // ── plumbing ──────────────────────────────────────────────────────────────

    // ── Version / capabilities ──────────────────────────────────────────────────

    suspend fun version(): VersionInfo =
        getJson(VersionInfo.serializer(), "/api/version")

    // ── Cron (scheduled tasks) ──────────────────────────────────────────────────

    suspend fun listCron(): CronJobsResponse =
        getJson(CronJobsResponse.serializer(), "/api/cron")

    suspend fun cronDetail(id: String): CronJobDetailResponse =
        getJson(CronJobDetailResponse.serializer(), "/api/cron/${enc(id)}")

    suspend fun createCron(req: CronJobUpsertRequest): CronJobResponse {
        val out = postBody("/api/cron", CronJobUpsertRequest.serializer(), req)
        return PsJson.decodeFromString(CronJobResponse.serializer(), out)
    }

    suspend fun updateCron(id: String, req: CronJobUpsertRequest): CronJobResponse {
        val out = sendBody("PATCH", "/api/cron/${enc(id)}", CronJobUpsertRequest.serializer(), req)
        return PsJson.decodeFromString(CronJobResponse.serializer(), out)
    }

    suspend fun deleteCron(id: String) {
        sendRaw("DELETE", "/api/cron/${enc(id)}", null)
    }

    suspend fun runCron(id: String): CronRunStartResult {
        val out = postRawReturning("/api/cron/${enc(id)}/run", "{}")
        return PsJson.decodeFromString(CronRunStartResult.serializer(), out)
    }

    suspend fun previewSchedule(schedule: String, timezone: String?): SchedulePreview {
        val body = buildJsonObject {
            put("schedule", schedule)
            timezone?.let { put("timezone", it) }
        }.toString()
        val out = postRawReturning("/api/cron/preview", body)
        return PsJson.decodeFromString(SchedulePreview.serializer(), out)
    }

    // ── Workflows ────────────────────────────────────────────────────────────────

    suspend fun listWorkflows(): WorkflowsResponse =
        getJson(WorkflowsResponse.serializer(), "/api/workflows")

    /** Starter templates (node/edge presets) to seed a new workflow. */
    suspend fun workflowTemplates(): List<WorkflowTemplate> =
        getJson(WorkflowTemplatesResponse.serializer(), "/api/workflows/templates").templates

    /** Start an AI draft from a one-line description; poll [workflowDesignState] for the result. */
    suspend fun designWorkflow(req: DesignWorkflowRequest): WorkflowDesignStartResponse {
        val out = postBody("/api/workflows/design", DesignWorkflowRequest.serializer(), req)
        return PsJson.decodeFromString(WorkflowDesignStartResponse.serializer(), out)
    }

    suspend fun workflowDesignState(designId: String): WorkflowDesignStateResponse =
        getJson(WorkflowDesignStateResponse.serializer(), "/api/workflows/design/${enc(designId)}")

    suspend fun workflowDetail(id: String): WorkflowDetailResponse =
        getJson(WorkflowDetailResponse.serializer(), "/api/workflows/${enc(id)}")

    suspend fun createWorkflow(req: CreateWorkflowRequest): WorkflowCreateResponse {
        val out = postBody("/api/workflows", CreateWorkflowRequest.serializer(), req)
        return PsJson.decodeFromString(WorkflowCreateResponse.serializer(), out)
    }

    suspend fun updateWorkflow(id: String, req: CreateWorkflowRequest): WorkflowCreateResponse {
        val out = sendBody("PUT", "/api/workflows/${enc(id)}", CreateWorkflowRequest.serializer(), req)
        return PsJson.decodeFromString(WorkflowCreateResponse.serializer(), out)
    }

    suspend fun deleteWorkflow(id: String) {
        sendRaw("DELETE", "/api/workflows/${enc(id)}", null)
    }

    suspend fun runWorkflow(id: String): WorkflowRunStartResponse {
        val out = postRawReturning("/api/workflows/${enc(id)}/run", "{}")
        return PsJson.decodeFromString(WorkflowRunStartResponse.serializer(), out)
    }

    suspend fun workflowRunState(runId: String): WorkflowRunStateResponse =
        getJson(WorkflowRunStateResponse.serializer(), "/api/workflows/runs/${enc(runId)}")

    suspend fun cancelWorkflowRun(runId: String) {
        postRaw("/api/workflows/runs/${enc(runId)}/cancel", "{}")
    }

    suspend fun ackWorkflowAttention(runId: String) {
        postRaw("/api/workflows/runs/${enc(runId)}/ack-attention", "{}")
    }

    /** action ∈ approve | reject | complete | retry */
    suspend fun nodeAction(runId: String, nodeRunId: String, action: String) {
        postRaw("/api/workflows/runs/${enc(runId)}/nodes/${enc(nodeRunId)}/${enc(action)}", "{}")
    }

    // ── PO loop / Backlog (capability po_loop_v1) ─────────────────────────────────────────
    // The daemon's PO routes return camelCase JSON (see PoModels.kt). The backlog surface is
    // hidden unless po_loop_v1 is advertised, so these are only reached on a supporting daemon.

    /** GET /api/po/briefs — every opportunity brief, all repos. */
    suspend fun listPoBriefs(): PoBriefsResponse =
        getJson(PoBriefsResponse.serializer(), "/api/po/briefs")

    /** POST /api/po/collect — start a signal-collection session (briefs ingest in the background). */
    suspend fun startPoCollection(req: PoCollectRequest): PoCollectResponse {
        val out = postBody("/api/po/collect", PoCollectRequest.serializer(), req)
        return PsJson.decodeFromString(PoCollectResponse.serializer(), out)
    }

    /** POST /api/po/research — start a topic research (web+repo or repo-only → report + briefs). */
    suspend fun startPoResearch(req: PoResearchRequest): PoResearchStartResponse {
        val out = postBody("/api/po/research", PoResearchRequest.serializer(), req)
        return PsJson.decodeFromString(PoResearchStartResponse.serializer(), out)
    }

    /** GET /api/po/research — research list (report body omitted). */
    suspend fun listPoResearch(): PoResearchListResponse =
        getJson(PoResearchListResponse.serializer(), "/api/po/research")

    /** GET /api/po/research/:id — research detail incl. the report markdown. */
    suspend fun getPoResearch(id: String): PoResearchDetailResponse =
        getJson(PoResearchDetailResponse.serializer(), "/api/po/research/${enc(id)}")

    /**
     * POST /api/po/briefs/:id/decide — approve | hold | reject. `approve` spawns the implementation
     * session and returns its id (the caller deep-links into the session tab).
     */
    suspend fun decidePoBrief(id: String, req: PoDecideRequest): PoDecideResponse {
        val out = postBody("/api/po/briefs/${enc(id)}/decide", PoDecideRequest.serializer(), req)
        return PsJson.decodeFromString(PoDecideResponse.serializer(), out)
    }

    /** POST /api/po/briefs/bulk/decide — triage bulk hold/reject (po_bulk_decide_v1). */
    suspend fun bulkDecidePoBriefs(req: PoBulkDecideRequest): PoBulkDecideResponse {
        val out = postBody("/api/po/briefs/bulk/decide", PoBulkDecideRequest.serializer(), req)
        return PsJson.decodeFromString(PoBulkDecideResponse.serializer(), out)
    }

    /** GET /api/po/stats — cumulative scorecard (po_stats_v1). repoPath null ⇒ all + per-repo. */
    suspend fun getPoStats(repoPath: String? = null): PoStats =
        getJson(PoStats.serializer(), "/api/po/stats") {
            repoPath?.let { addQueryParameter("repoPath", it) }
        }

    /** GET /api/po/profile — per-repo investigation directive + daily schedule (po_schedule_v1). */
    suspend fun getPoProfile(repoPath: String): PoProfile =
        getJson(PoProfile.serializer(), "/api/po/profile") {
            addQueryParameter("repoPath", repoPath)
        }

    /** PUT /api/po/profile — save directive + schedule + lens (clearing all deletes it). */
    suspend fun setPoProfile(req: PoProfileUpsertRequest) {
        sendBody("PUT", "/api/po/profile", PoProfileUpsertRequest.serializer(), req)
    }

    /** POST /api/po/briefs/:id/cleanup — spawn a «clean up code traces» session for a rejected brief. */
    suspend fun cleanupPoBrief(id: String, agent: String? = null): PoCleanupResponse {
        val out = postBody(
            "/api/po/briefs/${enc(id)}/cleanup",
            PoCleanupRequest.serializer(),
            PoCleanupRequest(agent = agent, locale = com.pocketsisyphus.android.data.model.appOutputLocaleTag()),
        )
        return PsJson.decodeFromString(PoCleanupResponse.serializer(), out)
    }

    /** POST /api/po/briefs/:id/revise — re-synthesize a brief from a revise instruction. */
    suspend fun revisePoBrief(id: String, comment: String): PoReviseResponse {
        val out = postBody(
            "/api/po/briefs/${enc(id)}/revise",
            PoReviseRequest.serializer(),
            PoReviseRequest(comment = comment, locale = com.pocketsisyphus.android.data.model.appOutputLocaleTag()),
        )
        return PsJson.decodeFromString(PoReviseResponse.serializer(), out)
    }

    /** DELETE /api/po/briefs/:id — clean up a finished brief. */
    suspend fun deletePoBrief(id: String) {
        sendRaw("DELETE", "/api/po/briefs/${enc(id)}", null)
    }

    /** DELETE /api/po/research/:id — clean up a finished research. */
    suspend fun deletePoResearch(id: String) {
        sendRaw("DELETE", "/api/po/research/${enc(id)}", null)
    }

    // ── Devices (mac/daemon admin routes — same contract as the iPhone DevicesView) ──────

    /** Registered devices + extra-slot state. */
    suspend fun deviceInfo(): DeviceInfoResponse =
        getJson(DeviceInfoResponse.serializer(), "/api/admin/device-info")

    /** Toggle the extra-device slot. 409 `remove_extra_device_first` if >1 device is enrolled. */
    suspend fun setExtraDeviceSlot(allowed: Boolean) {
        postRaw("/api/admin/device-slot", """{"allowed":$allowed}""")
    }

    /** Revoke one device by fingerprint. 404 `device_not_found` if already gone. */
    suspend fun revokeDevice(fingerprint: String) {
        val body = buildJsonObject { put("fingerprint", fingerprint) }.toString()
        postRaw("/api/admin/revoke-device", body)
    }

    // ── MCP «tools» servers (capability mcp_tools_v1) ────────────────────────────────────

    suspend fun mcpCatalog(): McpCatalogResponse =
        getJson(McpCatalogResponse.serializer(), "/api/mcp/catalog")

    suspend fun listMcpServers(): McpServersResponse =
        getJson(McpServersResponse.serializer(), "/api/mcp")

    suspend fun addMcpServer(req: AddMcpRequest): McpServer {
        val out = postBody("/api/mcp", AddMcpRequest.serializer(), req)
        return PsJson.decodeFromString(McpServerResponse.serializer(), out).server
            ?: throw ApiException(500, "missing server in response")
    }

    suspend fun triggerMcpOauth(id: String) {
        postRaw("/api/mcp/${enc(id)}/oauth", "{}")
    }

    suspend fun revokeMcpServer(id: String) {
        postRaw("/api/mcp/${enc(id)}/revoke", "{}")
    }

    suspend fun deleteMcpServer(id: String) {
        sendRaw("DELETE", "/api/mcp/${enc(id)}", null)
    }

    // ── plumbing ──────────────────────────────────────────────────────────────

    private suspend fun <T> getJson(
        deserializer: DeserializationStrategy<T>,
        path: String,
        query: (HttpUrl.Builder.() -> Unit)? = null,
    ): T {
        val body = execute { fwd ->
            val url = "${fwd.httpBase}$path".toHttpUrl().newBuilder().apply { query?.invoke(this) }.build()
            authed(fwd).url(url).get().build()
        }
        return PsJson.decodeFromString(deserializer, body)
    }

    private suspend fun <T> postBody(
        path: String,
        bodySerializer: SerializationStrategy<T>,
        bodyValue: T,
    ): String {
        val json = PsJson.encodeToString(bodySerializer, bodyValue)
        return execute { fwd ->
            authed(fwd).url("${fwd.httpBase}$path").post(json.toRequestBody(jsonMedia)).build()
        }
    }

    private suspend fun postRaw(path: String, json: String) {
        execute { fwd ->
            authed(fwd).url("${fwd.httpBase}$path").post(json.toRequestBody(jsonMedia)).build()
        }
    }

    private suspend fun postRawReturning(path: String, json: String): String =
        execute { fwd ->
            authed(fwd).url("${fwd.httpBase}$path").post(json.toRequestBody(jsonMedia)).build()
        }

    /** PATCH/PUT/DELETE with a typed body. */
    private suspend fun <T> sendBody(
        method: String,
        path: String,
        bodySerializer: SerializationStrategy<T>,
        bodyValue: T,
    ): String {
        val json = PsJson.encodeToString(bodySerializer, bodyValue)
        return execute { fwd ->
            authed(fwd).url("${fwd.httpBase}$path").method(method, json.toRequestBody(jsonMedia)).build()
        }
    }

    /** PATCH/PUT/DELETE with an optional raw body. */
    private suspend fun sendRaw(method: String, path: String, json: String?): String =
        execute { fwd ->
            val body = json?.toRequestBody(jsonMedia)
            authed(fwd).url("${fwd.httpBase}$path").method(method, body).build()
        }

    private fun authed(fwd: com.pocketsisyphus.android.transport.Forward): Request.Builder =
        Request.Builder()
            .header("Authorization", "Bearer ${conn.token}")
            .header("X-Client-Version", com.pocketsisyphus.android.BuildConfig.VERSION_NAME)
            .apply {
                if (com.pocketsisyphus.android.BuildConfig.DEBUG &&
                    com.pocketsisyphus.android.DevBootstrap.directActive
                ) {
                    // Dev direct-daemon — bypass the attest gate with the local-admin secret, the
                    // same path the Mac app uses (daemon attest.ts isLocalAdmin). No attest token.
                    com.pocketsisyphus.android.DevBootstrap.localSecret
                        ?.let { header("X-PS-Local", it) }
                } else {
                    attest.currentToken()?.let { header("X-PS-Attest", it) }
                }
            }

    /**
     * Execute with one transparent reconnect on transport-level IO failure, and one attest-token
     * refresh + retry on a 401 `attest_required` (token expired / daemon restarted).
     */
    private suspend fun execute(build: (com.pocketsisyphus.android.transport.Forward) -> Request): String =
        withContext(Dispatchers.IO) {
            var ioAttempt = 0
            var attestAttempt = 0
            while (true) {
                val fwd = conn.ensureConnected(forceReconnect = ioAttempt > 0)
                attest.ensureToken() // enroll + token (no-op once cached); surfaces slot errors
                val req = build(fwd)
                try {
                    val (code, text) = conn.http.newCall(req).execute()
                        .use { it.code to it.body?.string().orEmpty() }
                    if (code in 200..299) return@withContext text
                    if (code == 401 && text.contains("attest_required") && attestAttempt++ == 0) {
                        attest.ensureToken(force = true)
                        continue
                    }
                    throw ApiException(code, text)
                } catch (e: ApiException) {
                    throw e
                } catch (e: IOException) {
                    if (ioAttempt++ == 0) continue
                    throw e
                }
            }
            @Suppress("UNREACHABLE_CODE") error("unreachable")
        }

    private fun enc(s: String): String = URLEncoder.encode(s, "UTF-8")
}
