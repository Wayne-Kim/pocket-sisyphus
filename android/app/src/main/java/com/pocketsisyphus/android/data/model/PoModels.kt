package com.pocketsisyphus.android.data.model

import kotlinx.serialization.Serializable
import java.util.Locale

// ─────────────────────────────────────────────────────────────────────────────
// PO loop (Backlog) — mirrors mac/daemon `routes/po.ts` + iOS PoBrief/PoResearch.
//
// NOTE: unlike the session/cron routes (snake_case), the PO routes return camelCase
// keys (matching iOS Codable defaults), so these data classes use camelCase property
// names directly — no @SerialName needed.
// ─────────────────────────────────────────────────────────────────────────────

/** One evidence line backing an opportunity brief. daemon `po/prompt.ts` evidence 1:1. */
@Serializable
data class PoEvidence(
    /** "github_issue" | "repo_todo" | "code_comment" | "git_log" | "doc" | "asc_review" | … */
    val kind: String = "",
    /** A checkable reference — issue #/URL, file:line, sha. */
    val ref: String = "",
    /** One line on what this evidence says. */
    val summary: String = "",
)

/**
 * One opportunity brief. daemon `routes/po.ts` toApi() 1:1.
 * status: proposed → approved(→running) | held | rejected; running → shipped → verified|missed.
 * Fields the daemon may omit on older versions decode to null/empty (tolerant codec).
 */
@Serializable
data class PoBrief(
    val id: String,
    val repoPath: String = "",
    val title: String = "",
    val problem: String = "",
    val evidence: List<PoEvidence> = emptyList(),
    val impact: Int = 0,   // 1~5
    val effort: Int = 0,   // 1~5
    val score: Double = 0.0, // impact/effort — backlog sort key
    val scope: String = "",
    val spec: String = "",
    val status: String = "proposed",
    val createdAt: Long = 0,
    val updatedAt: Long = 0,
    val decidedAt: Long? = null,
    val decideReason: String? = null,
    val decideNote: String? = null,
    val collectSessionId: String? = null,
    val execSessionId: String? = null,
    val revisingSessionId: String? = null,
    val researchId: String? = null,
    val verifyNote: String? = null,
    val cleanupSessionId: String? = null,
    val execWorkflowId: String? = null,
    val execRunId: String? = null,
    val execNote: String? = null,
    val execAgentId: String? = null,
    val cleanupAgentId: String? = null,
    /** The expert lens this brief was written through (po_brief_lens_v1). "default"/null → hidden. */
    val lens: String? = null,
) {
    /**
     * The first meaningful line of [problem], stripped of markdown markers — the list "glance" line
     * so a brief isn't judged by title/score alone. Empty (older briefs) → null (caller hides it).
     */
    val glanceLine: String?
        get() {
            for (raw in problem.split('\n')) {
                var line = raw.trim()
                if (line.isEmpty()) continue
                line = line.replace(
                    Regex("""^\s*(#{1,6}\s+|[-*+]\s+(\[[ xX]\]\s*)?|>\s+|\d+[.)]\s+)"""), "",
                )
                line = line.replace("**", "").replace("`", "").trim()
                if (line.isNotEmpty()) return line
            }
            return null
        }

    val repoName: String get() = repoPath.trimEnd('/').substringAfterLast('/')

    /** Decision bucket the list groups by. */
    val isProposed: Boolean get() = status == "proposed"
    val isActive: Boolean get() = status == "running" || status == "approved"
    val isShipped: Boolean get() = status == "shipped"
    val isSettled: Boolean get() = status in SETTLED_STATUSES

    companion object {
        val SETTLED_STATUSES = setOf("held", "rejected", "verified", "missed")
    }
}

@Serializable
data class PoBriefsResponse(val briefs: List<PoBrief> = emptyList())

/** POST /api/po/collect request — instruction/agent/lens omitted when null (older-daemon safe). */
@Serializable
data class PoCollectRequest(
    val repoPath: String,
    val instruction: String? = null,
    val agent: String? = null,
    val lens: String? = null,
    val locale: String? = null,
)

@Serializable
data class PoCollectResponse(val sessionId: String = "")

/** POST /api/po/research request. */
@Serializable
data class PoResearchRequest(
    val repoPath: String,
    val topic: String,
    val agent: String? = null,
    val lens: String? = null,
    val scope: String? = null,
    val screens: Boolean? = null,
    val locale: String? = null,
)

@Serializable
data class PoResearchStartResponse(val researchId: String = "", val sessionId: String = "")

/** One research request. `report` is only filled by the detail fetch. */
@Serializable
data class PoResearch(
    val id: String,
    val repoPath: String = "",
    val topic: String = "",
    /** "running" | "done" | "failed". */
    val status: String = "running",
    val sessionId: String? = null,
    val briefCount: Int = 0,
    val createdAt: Long = 0,
    val updatedAt: Long = 0,
    val report: String? = null,
    val lens: String? = null,
) {
    val repoName: String get() = repoPath.trimEnd('/').substringAfterLast('/')
}

@Serializable
data class PoResearchListResponse(val research: List<PoResearch> = emptyList())

@Serializable
data class PoResearchDetailResponse(val research: PoResearch)

/** POST /api/po/briefs/:id/decide request — fields omitted when null. */
@Serializable
data class PoDecideRequest(
    /** "approve" | "hold" | "reject". */
    val action: String,
    /** approve-only (po_worktree_v1): run the implementation in a fresh worktree. */
    val useWorktree: Boolean? = null,
    /** approve-only code agent (po_agent_v1). */
    val agent: String? = null,
    /** approve-only (po_workflow_v1): "workflow" runs a self-verifying workflow with a merge gate. */
    val mode: String? = null,
    val reason: String? = null,
    val note: String? = null,
    val locale: String? = null,
)

/** POST /api/po/briefs/:id/cleanup request (po_cleanup_v1) — spawn a code-traces cleanup session. */
@Serializable
data class PoCleanupRequest(val agent: String? = null, val locale: String? = null)

@Serializable
data class PoCleanupResponse(val sessionId: String? = null)

@Serializable
data class PoDecideResponse(val brief: PoBrief? = null, val execSessionId: String? = null)

/** POST /api/po/briefs/:id/revise — re-synthesize a brief from a revise instruction (po revise). */
@Serializable
data class PoReviseRequest(val comment: String, val locale: String? = null)

@Serializable
data class PoReviseResponse(val sessionId: String = "")

/**
 * Hold/reject reason tags (po_decide_reason_v1) — daemon enum keys, shared by reject + hold,
 * optional single-select. The rawValue goes straight into the decide body's `reason`. Labels are
 * localized via [com.pocketsisyphus.android.ui.backlog.reasonLabelRes]. Mirrors iOS DecideReason.
 */
enum class DecideReason(val key: String) {
    PRIORITY_LOW("priority_low"),
    SCOPE_TOO_BIG("scope_too_big"),
    ALREADY_EXISTS("already_exists"),
    WEAK_EVIDENCE("weak_evidence"),
    WRONG_DIRECTION("wrong_direction"),
}

/** POST /api/po/briefs/bulk/decide — triage bulk hold/reject (po_bulk_decide_v1). approve is per-brief. */
@Serializable
data class PoBulkDecideRequest(
    val ids: List<String>,
    /** "hold" | "reject" only. */
    val action: String,
    val reason: String? = null,
    val note: String? = null,
)

@Serializable
data class PoBulkSkip(val id: String = "", val reason: String? = null)

@Serializable
data class PoBulkDecideResponse(
    val updated: List<PoBrief> = emptyList(),
    val skipped: List<PoBulkSkip> = emptyList(),
)

// ── Stats (po_stats_v1) ──────────────────────────────────────────────────────
// The daemon also returns optional breakdown maps (byEffort/byEvidence/byLens, …) which the tolerant
// codec drops — this models the headline scorecard only.

@Serializable
data class PoRepoStats(
    val repoPath: String = "",
    val proposed: Int = 0,
    val approved: Int = 0,
    val rejected: Int = 0,
    val shipped: Int = 0,
    val verified: Int = 0,
    val missed: Int = 0,
    val approvalRate: Double? = null,
    val medianDecisionSeconds: Double? = null,
) {
    val repoName: String get() = repoPath.trimEnd('/').substringAfterLast('/')
    val verifyHitRate: Double? get() = (verified + missed).takeIf { it > 0 }?.let { verified.toDouble() / it }
}

@Serializable
data class PoStats(
    val proposed: Int = 0,
    val approved: Int = 0,
    val rejected: Int = 0,
    val shipped: Int = 0,
    val verified: Int = 0,
    val missed: Int = 0,
    val approvalRate: Double? = null,
    val medianDecisionSeconds: Double? = null,
    val repos: List<PoRepoStats> = emptyList(),
) {
    val decidedCount: Int get() = approved + rejected
    val verifyHitRate: Double? get() = (verified + missed).takeIf { it > 0 }?.let { verified.toDouble() / it }
}

// ── Per-repo investigation profile + daily schedule (po_schedule_v1) ───────────

@Serializable
data class PoProfile(
    val directive: String = "",
    /** 5-field cron for daily auto-collection; null = off. */
    val schedule: String? = null,
    val ascAppId: String? = null,
    val githubFeedbackRepo: String? = null,
    /** Fixed expert lens for scheduled collection. */
    val lens: String? = null,
)

/** PUT /api/po/profile — clearing everything deletes the profile. */
@Serializable
data class PoProfileUpsertRequest(
    val repoPath: String,
    val directive: String,
    val schedule: String? = null,
    val ascAppId: String? = null,
    val githubFeedbackRepo: String? = null,
    val lens: String? = null,
)

// ─────────────────────────────────────────────────────────────────────────────
// Expert-lens («persona») catalog — id order fixed, gated one step per daemon
// capability. Sending a lens an older daemon doesn't know silently falls back to
// "default" (a «false UI»), so callers only surface lenses the daemon advertises.
// Mirrors iOS poCollectLenses / poResearchLenses + daemon lens.ts PO_LENSES.
// ─────────────────────────────────────────────────────────────────────────────

object PoLens {
    const val DEFAULT = "default"

    /**
     * Collect picker lenses: v1 → default/design/bug, v2 adds security, v3 → the full 11 research
     * experts (readability is research-only). [allExperts] (po_collect_lens_v3) wins over [security].
     */
    fun collectLenses(security: Boolean, allExperts: Boolean): List<String> {
        if (allExperts) {
            return researchLenses(
                qa = true, security = true, pm = true, marketing = true, analytics = true,
                ops = true, logic = true, ux = true, readability = false,
            )
        }
        val out = mutableListOf(DEFAULT, "design", "bug")
        if (security) out.add("security")
        return out
    }

    /** Research picker lenses, one step per capability (v1…v10). default(전방위) is the baseline. */
    fun researchLenses(
        qa: Boolean, security: Boolean, pm: Boolean, marketing: Boolean, analytics: Boolean,
        ops: Boolean, logic: Boolean, ux: Boolean, readability: Boolean,
    ): List<String> {
        val out = mutableListOf(DEFAULT, "design", "bug")
        if (qa) out.add("qa")
        if (security) out.add("security")
        if (pm) out.add("pm")
        if (marketing) out.add("marketing")
        if (analytics) out.add("analytics")
        if (ops) out.add("ops")
        if (logic) out.add("logic")
        if (ux) out.add("ux")
        if (readability) out.add("readability")
        return out
    }
}

/**
 * App output locale tag sent to the daemon so generated briefs/reports come back in the app's
 * language. `LocalePrefs.wrap` calls `Locale.setDefault`, so `Locale.getDefault()` already reflects
 * the user's chosen app language. Maps to the daemon's known set (`zh-Hans`/`pt-BR` need the region).
 */
fun appOutputLocaleTag(): String {
    val l = Locale.getDefault()
    return when (l.language) {
        "zh" -> "zh-Hans"
        "pt" -> "pt-BR"
        else -> l.language.ifBlank { "en" }
    }
}
