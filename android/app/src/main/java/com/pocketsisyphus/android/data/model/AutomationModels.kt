package com.pocketsisyphus.android.data.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

// ─────────────────────────────────────────────────────────────────────────────
// Daemon version + capabilities (GET /api/version, mac/daemon/src/routes/version.ts).
// Clients hide Pro/automation entry points unless the matching capability is advertised,
// and branch to «update Mac app» when the daemon is too old to expose it.
// ─────────────────────────────────────────────────────────────────────────────

@Serializable
data class VersionInfo(
    val daemonVersion: String = "",
    val minSupportedClientVersion: String = "",
    val capabilities: List<String> = emptyList(),
) {
    fun has(cap: String): Boolean = capabilities.contains(cap)

    val supportsCron: Boolean get() = has(Caps.CRON)
    val supportsCronTerminal: Boolean get() = has(Caps.CRON_TERMINAL)
    val supportsCronEligible: Boolean get() = has(Caps.CRON_ELIGIBLE)
    val supportsWorkflows: Boolean get() = has(Caps.WORKFLOW)

    /** External tool (MCP) servers — gates the settings «Tools» section. */
    val supportsMcpTools: Boolean get() = has(Caps.MCP_TOOLS)

    /** Native screen capture (mirroring) — gates the screen-mirror entry point. */
    val supportsScreenCapture: Boolean get() = has(Caps.SCREEN_CAPTURE)

    /** H.264 mirroring codec — when absent, mirroring falls back to JPEG `screen_frame`. */
    val supportsScreenH264: Boolean get() = has(Caps.SCREEN_H264)

    /** Either automation domain present → the Automation surface is shown at all. */
    val supportsAutomation: Boolean get() = supportsCron || supportsWorkflows

    // ── PO loop / Backlog ──────────────────────────────────────────────────────
    /** Backlog (PO loop) at all — gates the whole Backlog surface. */
    val supportsBacklog: Boolean get() = has(Caps.PO_LOOP)

    /** PO flow can run on a chosen code agent (else the daemon defaults to claude_code). */
    val supportsPoAgent: Boolean get() = has(Caps.PO_AGENT)

    /** Triage bulk hold/reject of proposed briefs. */
    val supportsPoBulkDecide: Boolean get() = has(Caps.PO_BULK_DECIDE)

    /** Approve can run the implementation in a fresh git worktree (avoids cross-session conflicts). */
    val supportsPoWorktree: Boolean get() = has(Caps.PO_WORKTREE)

    /** Approve can run as a self-verifying workflow with a human merge gate. */
    val supportsPoWorkflow: Boolean get() = has(Caps.PO_WORKFLOW)

    /** Rejected briefs can spawn a «clean up the code traces» session. */
    val supportsPoCleanup: Boolean get() = has(Caps.PO_CLEANUP)

    /** Cumulative scorecard (approval rate, verify hit-rate). */
    val supportsPoStats: Boolean get() = has(Caps.PO_STATS)

    /** Daily unattended collection on a schedule. */
    val supportsPoSchedule: Boolean get() = has(Caps.PO_SCHEDULE)

    // Collect «expert lens» steps. Each unlocks one more lens; sending an unknown lens to an
    // older daemon silently falls back to "default", so we only offer advertised ones.
    val supportsCollectLens: Boolean get() = has(Caps.PO_COLLECT_LENS_V1)
    val supportsCollectSecurityLens: Boolean get() = has(Caps.PO_COLLECT_LENS_V2)
    val supportsCollectAllExpertsLens: Boolean get() = has(Caps.PO_COLLECT_LENS_V3)

    // Research «expert lens» steps (v1…v10) + scope + UX-screens toggle.
    val supportsResearchLens: Boolean get() = has(Caps.PO_RESEARCH_LENS_V1)
    val supportsResearchQaLens: Boolean get() = has(Caps.PO_RESEARCH_LENS_V2)
    val supportsResearchSecurityLens: Boolean get() = has(Caps.PO_RESEARCH_LENS_V3)
    val supportsResearchPmLens: Boolean get() = has(Caps.PO_RESEARCH_LENS_V4)
    val supportsResearchMarketingLens: Boolean get() = has(Caps.PO_RESEARCH_LENS_V5)
    val supportsResearchAnalyticsLens: Boolean get() = has(Caps.PO_RESEARCH_LENS_V6)
    val supportsResearchOpsLens: Boolean get() = has(Caps.PO_RESEARCH_LENS_V7)
    val supportsResearchLogicLens: Boolean get() = has(Caps.PO_RESEARCH_LENS_V8)
    val supportsResearchUxLens: Boolean get() = has(Caps.PO_RESEARCH_LENS_V9)
    val supportsResearchReadabilityLens: Boolean get() = has(Caps.PO_RESEARCH_LENS_V10)
    val supportsResearchScope: Boolean get() = has(Caps.PO_RESEARCH_SCOPE)
    val supportsResearchUxScreens: Boolean get() = has(Caps.PO_RESEARCH_UX_SCREENS)
}

/** Daemon capability string constants — keep in sync with `DAEMON_CAPABILITIES`. */
object Caps {
    const val CRON = "cron_v1"
    const val CRON_TERMINAL = "cron_terminal_v1"
    const val CRON_ELIGIBLE = "cron_eligible_v1"
    const val WORKFLOW = "workflow_v1"
    const val WORKFLOW_DESIGN = "workflow_design_v1"
    const val WORKFLOW_TEMPLATES = "workflow_templates_v1"
    const val MCP_TOOLS = "mcp_tools_v1"
    const val SCREEN_CAPTURE = "screen_capture_v1"
    const val SCREEN_H264 = "screen_h264_v1"

    // PO loop / Backlog.
    const val PO_LOOP = "po_loop_v1"
    const val PO_AGENT = "po_agent_v1"
    const val PO_BULK_DECIDE = "po_bulk_decide_v1"
    const val PO_STATS = "po_stats_v1"
    const val PO_SCHEDULE = "po_schedule_v1"
    const val PO_WORKTREE = "po_worktree_v1"
    const val PO_WORKFLOW = "po_workflow_v1"
    const val PO_CLEANUP = "po_cleanup_v1"
    const val PO_COLLECT_LENS_V1 = "po_collect_lens_v1"
    const val PO_COLLECT_LENS_V2 = "po_collect_lens_v2"
    const val PO_COLLECT_LENS_V3 = "po_collect_lens_v3"
    const val PO_RESEARCH_LENS_V1 = "po_research_lens_v1"
    const val PO_RESEARCH_LENS_V2 = "po_research_lens_v2"
    const val PO_RESEARCH_LENS_V3 = "po_research_lens_v3"
    const val PO_RESEARCH_LENS_V4 = "po_research_lens_v4"
    const val PO_RESEARCH_LENS_V5 = "po_research_lens_v5"
    const val PO_RESEARCH_LENS_V6 = "po_research_lens_v6"
    const val PO_RESEARCH_LENS_V7 = "po_research_lens_v7"
    const val PO_RESEARCH_LENS_V8 = "po_research_lens_v8"
    const val PO_RESEARCH_LENS_V9 = "po_research_lens_v9"
    const val PO_RESEARCH_LENS_V10 = "po_research_lens_v10"
    const val PO_RESEARCH_SCOPE = "po_research_scope_v1"
    const val PO_RESEARCH_UX_SCREENS = "po_research_ux_screens_v1"
}

// ─────────────────────────────────────────────────────────────────────────────
// Cron — scheduled tasks. Mirrors mac/daemon/src/cron/store.ts row + iOS CronJob.swift.
// ─────────────────────────────────────────────────────────────────────────────

@Serializable
data class CronJob(
    val id: String,
    val title: String? = null,
    /** "agent" (agent prompt) | "terminal" (shell script file). Old daemons omit → "agent". */
    val kind: String? = null,
    val agent: String = "",
    @SerialName("repo_path") val repoPath: String = "",
    /** kind="agent": prompt. kind="terminal": absolute path to a shell script file. */
    val command: String = "",
    /** kind="terminal" interpreter ("zsh"|"bash"|"sh"); null = user default shell. */
    val shell: String? = null,
    /** 5-field cron expression ("0 9 * * 1-5"). */
    val schedule: String = "",
    val timezone: String? = null,
    @SerialName("skip_permissions") val skipPermissions: Int = 0,
    @SerialName("session_mode") val sessionMode: String = "fresh",
    @SerialName("overlap_policy") val overlapPolicy: String = "skip",
    @SerialName("catch_up") val catchUp: Int = 0,
    val notify: Int = 1,
    val enabled: Int = 1,
    @SerialName("created_at") val createdAt: Long = 0,
    @SerialName("updated_at") val updatedAt: Long? = null,
    @SerialName("last_run_at") val lastRunAt: Long? = null,
    @SerialName("last_status") val lastStatus: String? = null,
    @SerialName("last_session_id") val lastSessionId: String? = null,
    @SerialName("next_run_at") val nextRunAt: Long? = null,
    @SerialName("run_count") val runCount: Int = 0,
) {
    val isEnabled: Boolean get() = enabled == 1
    val skipsPermissions: Boolean get() = skipPermissions == 1
    val notifyEnabled: Boolean get() = notify == 1
    val continuesConversation: Boolean get() = sessionMode == "continue"
    val kindValue: String get() = kind ?: "agent"
    val isTerminal: Boolean get() = kindValue == "terminal"

    val displayTitle: String
        get() = title?.takeIf { it.isNotBlank() }
            ?: repoPath.trimEnd('/').substringAfterLast('/').ifEmpty { "job ${id.take(6)}" }
}

@Serializable
data class CronRun(
    val id: String,
    @SerialName("cron_job_id") val cronJobId: String = "",
    @SerialName("session_id") val sessionId: String? = null,
    /** "schedule" | "manual". */
    val trigger: String = "manual",
    @SerialName("started_at") val startedAt: Long = 0,
    @SerialName("ended_at") val endedAt: Long? = null,
    /** "running" | "ok" | "error" | "timeout" | "skipped". */
    val status: String = "running",
    val error: String? = null,
)

/** POST / PATCH body — null fields are omitted by the codec so the daemon leaves them untouched. */
@Serializable
data class CronJobUpsertRequest(
    val title: String? = null,
    /** "agent" | "terminal". */
    val kind: String? = null,
    val agent: String? = null,
    val repoPath: String? = null,
    val command: String? = null,
    val shell: String? = null,
    val schedule: String? = null,
    val timezone: String? = null,
    val skipPermissions: Boolean? = null,
    val sessionMode: String? = null,
    val overlapPolicy: String? = null,
    val catchUp: Boolean? = null,
    val notify: Boolean? = null,
    val enabled: Boolean? = null,
)

@Serializable
data class CronJobsResponse(val jobs: List<CronJob> = emptyList())

@Serializable
data class CronJobResponse(val job: CronJob)

@Serializable
data class CronJobDetailResponse(val job: CronJob, val runs: List<CronRun> = emptyList())

/** POST /api/cron/preview — next-run timestamps (ms) or validation error. */
@Serializable
data class SchedulePreview(
    val valid: Boolean = false,
    val error: String? = null,
    val nextRuns: List<Long> = emptyList(),
)

/** POST /api/cron/:id/run — immediate run result. status: running|skipped|error. */
@Serializable
data class CronRunStartResult(
    val status: String = "",
    val sessionId: String? = null,
    val runId: String? = null,
    val skipReason: String? = null,
)

// ─────────────────────────────────────────────────────────────────────────────
// Workflows — mirrors mac/daemon/src/workflow/types.ts + iOS Workflow.swift.
// snake_case node/edge keys match the daemon wire format.
// ─────────────────────────────────────────────────────────────────────────────

@Serializable
data class WorkflowTriggerDef(
    val kind: String = "manual",
    val schedule: String? = null,
    val timezone: String? = null,
    @SerialName("repo_path") val repoPath: String? = null,
    val branch: String? = null,
    @SerialName("poll_seconds") val pollSeconds: Int? = null,
)

/** One graph node. type: start | task | end (legacy general/test treated as task). */
@Serializable
data class WorkflowNodeDef(
    val id: String,
    val type: String,
    val title: String? = null,
    val agent: String? = null,
    @SerialName("repo_path") val repoPath: String? = null,
    val prompt: String? = null,
    @SerialName("result_spec") val resultSpec: String? = null,
    @SerialName("check_command") val checkCommand: String? = null,
    @SerialName("skip_permissions") val skipPermissions: Boolean? = null,
    @SerialName("requires_approval") val requiresApproval: Boolean? = null,
    val triggers: List<WorkflowTriggerDef>? = null,
    val x: Double? = null,
    val y: Double? = null,
) {
    val isStart: Boolean get() = type == "start"
    val isEnd: Boolean get() = type == "end"
    val isWork: Boolean get() = type == "task" || type == "general" || type == "test"
}

/** One directed edge from→to. condition "fail" routes the failure branch. */
@Serializable
data class WorkflowEdgeDef(
    val id: String,
    val from: String,
    val to: String,
    val condition: String? = null,
)

@Serializable
data class WorkflowSummary(
    val id: String,
    val title: String? = null,
    @SerialName("repo_path") val repoPath: String? = null,
    val nodes: List<WorkflowNodeDef> = emptyList(),
    val edges: List<WorkflowEdgeDef> = emptyList(),
    val enabled: Boolean = true,
    @SerialName("created_at") val createdAt: Long = 0,
    @SerialName("updated_at") val updatedAt: Long? = null,
) {
    val workNodeCount: Int get() = nodes.count { it.isWork }

    val displayTitle: String
        get() = title?.takeIf { it.isNotBlank() }
            ?: repoPath?.trimEnd('/')?.substringAfterLast('/')?.ifEmpty { null }
            ?: "workflow ${id.take(6)}"
}

/**
 * A starter template (workflow_templates_v1) — a node/edge preset the daemon returns so the user can
 * seed a whole graph instead of hand-building it. Display strings (template name / node titles) are
 * localized client-side by stable id (see the editor's template catalog); the ko titles here are a
 * fallback. Mirrors iOS WorkflowTemplate.
 */
@Serializable
data class WorkflowTemplate(
    val id: String,
    val nodes: List<WorkflowNodeDef> = emptyList(),
    val edges: List<WorkflowEdgeDef> = emptyList(),
)

@Serializable
data class WorkflowTemplatesResponse(val templates: List<WorkflowTemplate> = emptyList())

/** AI-draft request (workflow_design_v1) — «describe it in one line» → daemon designs the graph. */
@Serializable
data class DesignWorkflowRequest(
    val description: String,
    val repoPath: String,
    val agent: String? = null,
    val locale: String? = null,
)

@Serializable
data class WorkflowDesignStartResponse(val designId: String = "", val sessionId: String = "")

/** Poll state for an AI draft. status: designing | ready | failed. ready ⇒ nodes/edges filled. */
@Serializable
data class WorkflowDesignStateResponse(
    val status: String = "designing",
    val nodes: List<WorkflowNodeDef>? = null,
    val edges: List<WorkflowEdgeDef>? = null,
    val error: String? = null,
    val sessionId: String? = null,
)

@Serializable
data class WorkflowsResponse(val workflows: List<WorkflowSummary> = emptyList())

@Serializable
data class WorkflowCreateResponse(val workflow: WorkflowSummary)

@Serializable
data class WorkflowRunInfo(
    val id: String,
    @SerialName("workflow_id") val workflowId: String? = null,
    /** running | done | failed | cancelled. */
    val status: String = "running",
    @SerialName("trigger_kind") val triggerKind: String? = null,
    @SerialName("started_at") val startedAt: Long = 0,
    @SerialName("ended_at") val endedAt: Long? = null,
    @SerialName("max_iterations") val maxIterations: Int? = null,
    /** failed | empty | synthetic — «attention» (done-but-hollow / hard fail). */
    @SerialName("attention_kind") val attentionKind: String? = null,
    @SerialName("attention_ack") val attentionAck: Int? = null,
)

@Serializable
data class WorkflowDetailResponse(
    val workflow: WorkflowSummary,
    val runs: List<WorkflowRunInfo> = emptyList(),
)

@Serializable
data class WorkflowRunStartResponse(val runId: String)

/** Live node execution. Graph edges come from def edges; status maps by defNodeId. */
@Serializable
data class WorkflowNodeRun(
    val id: String,
    @SerialName("def_node_id") val defNodeId: String? = null,
    @SerialName("node_type") val nodeType: String = "task",
    @SerialName("parent_node_run_id") val parentNodeRunId: String? = null,
    @SerialName("session_id") val sessionId: String? = null,
    val title: String? = null,
    val agent: String? = null,
    @SerialName("task_folder") val taskFolder: String? = null,
    /** pending|awaiting_approval|running|done|failed|needs_attention|skipped. */
    val status: String = "pending",
    val verdict: String? = null,
    val iteration: Int? = null,
    @SerialName("loopback_reason") val loopbackReason: String? = null,
    @SerialName("limit_reached") val limitReached: Int? = null,
    /** agent | synthetic | empty — synthetic/empty render with a warning badge. */
    @SerialName("result_kind") val resultKind: String? = null,
    val x: Double? = null,
    val y: Double? = null,
    @SerialName("created_at") val createdAt: Long = 0,
    @SerialName("ended_at") val endedAt: Long? = null,
)

/** GET /api/workflows/runs/:id — canvas poll state. */
@Serializable
data class WorkflowRunStateResponse(
    val run: WorkflowRunInfo,
    val nodes: List<WorkflowNodeDef> = emptyList(),
    val edges: List<WorkflowEdgeDef> = emptyList(),
    val nodeRuns: List<WorkflowNodeRun> = emptyList(),
)

@Serializable
data class CreateWorkflowRequest(
    val title: String? = null,
    val repoPath: String,
    val nodes: List<WorkflowNodeDef>,
    val edges: List<WorkflowEdgeDef>,
    val enabled: Boolean? = null,
)

// ── Repo path picker (recent projects + absolute filesystem browse) ────────────────────
// Same daemon contract as the iPhone RepoPathField / DirectoryPickerSheet. Used before a session
// exists (workflow / new-session / cron) to pick an absolute work folder on the Mac.

/** One row of GET /api/recent-projects — a previously-used absolute repo path. */
@Serializable
data class RecentProject(
    val path: String = "",
    val lastUsedAt: Long = 0,
    val sessionCount: Int = 0,
)

@Serializable
data class RecentProjectsResponse(val projects: List<RecentProject> = emptyList())

/**
 * One row of GET /api/agents — a registered code-agent CLI the daemon can spawn. Mirrors iOS
 * AgentInfo (daemon agent/types.ts). Fetching this dynamically (instead of hardcoding a list) is what
 * surfaces Antigravity (agy), Local · Qwen Code (local_llm), Local · OpenCode (opencode), etc. without
 * an app update — exactly like iOS.
 */
@Serializable
data class AgentInfo(
    val id: String = "",
    val displayName: String = "",
    val capabilities: List<String> = emptyList(),
    /** Whether the CLI is installed on the Mac. Old daemons omit it ⇒ treat as installed. */
    val installed: Boolean? = null,
    /** Install command / URL the daemon includes when not installed (code string, not translated). */
    val installHint: String? = null,
) {
    val isInstalled: Boolean get() = installed ?: true
}

@Serializable
data class AgentsResponse(val agents: List<AgentInfo> = emptyList())

/**
 * GET /api/fs/list-dir?path=<prefix> — resolved absolute [base] + immediate child directory names
 * (and [files] when `files=1`). Empty path resolves to the home dir on the daemon.
 */
@Serializable
data class ListDirResponse(
    val base: String = "",
    val dirs: List<String> = emptyList(),
    val files: List<String>? = null,
    val exists: Boolean? = null,
)
