package com.pocketsisyphus.android.data

import android.Manifest
import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.pocketsisyphus.android.MainActivity
import com.pocketsisyphus.android.R
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * Single source of truth for «the agent entered an approval/input wait» → live-event-driven
 * local notification. Mirrors the iOS `AgentWaitNotifier`.
 *
 * # Why live events (not background polling)
 * No APNs/FCM, no BG polling. While the app process is alive (foreground + a short background
 * window), a global, session-agnostic WebSocket consumes the daemon's `session_event`
 * (`waiting`/`resolved`) broadcast and posts/cancels a per-session notification immediately.
 * Zero external infrastructure — only the existing SSH/Tor data plane + a local notification.
 *
 * # Responsibilities
 *  - NotificationChannel + per-session actionable notification (approve = Enter / stop = ESC).
 *  - away-gating: stay silent if the user is currently looking at that session's chat foreground.
 *  - Notification actions handled via [AgentWaitActionReceiver] → [ApiClient.ptyControl].
 *  - Notification tap → [pendingDeepLink] → AppRoot navigates to the session detail.
 */
class AgentWaitNotifier(
    private val appContext: Context,
    private val conn: ConnectionManager,
    private val attest: Attestation,
    private val api: ApiClient,
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var listenJob: Job? = null

    /** away-gating state (mirrors the foreground chat). */
    @Volatile private var activeSessionId: String? = null
    @Volatile private var appForeground: Boolean = true

    /** Session id to deep-link into after a notification tap. AppRoot observes + consumes it. */
    private val _pendingDeepLink = MutableStateFlow<String?>(null)
    val pendingDeepLink: StateFlow<String?> = _pendingDeepLink.asStateFlow()

    init {
        createChannel()
    }

    // ── lifecycle ──────────────────────────────────────────────────────────────

    /** Start (idempotent) the global listener. Safe to call repeatedly (e.g. after pairing). */
    fun start() {
        if (listenJob?.isActive == true) return
        listenJob = scope.launch {
            val ws = WsClient(conn, attest)
            ws.open(sessionId = null, since = { 0L }).collect { ev ->
                if (ev is WsEvent.SessionEvent) handleSessionEvent(ev)
            }
        }
    }

    /** Stop the global listener (e.g. on unpair). Notifications already posted stay until cleared. */
    fun stop() {
        listenJob?.cancel()
        listenJob = null
    }

    /** ChatView enter/leave sets this — away-gating + clear the notification for a session being viewed. */
    fun setActiveSession(sessionId: String?) {
        activeSessionId = sessionId
        if (sessionId != null) clear(sessionId) // user opened it → no notification needed
    }

    /** App foreground/background — mirrors the Activity resume/pause lifecycle. */
    fun setAppForeground(foreground: Boolean) {
        appForeground = foreground
        if (foreground) listenJob ?: start()
    }

    /** Consume the pending deep link once AppRoot has navigated. */
    fun consumeDeepLink() {
        _pendingDeepLink.value = null
    }

    /** Notification tap entry point (called from [MainActivity.onNewIntent]/onCreate). */
    fun requestDeepLink(sessionId: String) {
        _pendingDeepLink.value = sessionId
        clear(sessionId)
    }

    // ── incoming events ──────────────────────────────────────────────────────────

    private fun handleSessionEvent(ev: WsEvent.SessionEvent) {
        when (ev.kind) {
            "waiting" -> handleWaitingEntry(ev)
            "resolved" -> clear(ev.sessionId)
            else -> {}
        }
    }

    private fun handleWaitingEntry(ev: WsEvent.SessionEvent) {
        // away-gating — silent if the user is looking at this session's chat in the foreground.
        if (appForeground && activeSessionId == ev.sessionId) return
        postWaiting(ev.sessionId, ev.repoName, ev.title, ev.agentName, ev.preview)
    }

    // ── action handling (called by AgentWaitActionReceiver) ────────────────────────

    /** approve = Enter (confirm the highlighted permission prompt choice). */
    fun onApprove(sessionId: String) = performControl(sessionId, ACTION_APPROVE)

    /** stop = ESC (interrupt the in-progress/waiting turn — does not kill the PTY). */
    fun onStop(sessionId: String) = performControl(sessionId, ACTION_INTERRUPT)

    private fun performControl(sessionId: String, action: String) {
        // ApiClient.execute already retries once on a 401 attest_required (daemon restart / token
        // rotation) and once on a transport IO failure — so a single call covers re-auth + reconnect.
        scope.launch {
            try {
                api.ptyControl(sessionId, action)
                clearNotificationOnly(sessionId)
            } catch (e: Throwable) {
                Log.w(TAG, "control $action failed sid=$sessionId: ${e.message}")
                postFailed(sessionId)
            }
        }
    }

    // ── notification building ──────────────────────────────────────────────────────

    private fun postWaiting(
        sessionId: String,
        repoName: String?,
        title: String?,
        agentName: String?,
        preview: String?,
    ) {
        if (!canNotify()) return
        val res = appContext.resources
        // repoName / session title / preview are agent/user data → not translation targets.
        val contentTitle = repoName?.takeIf { it.isNotBlank() && it != "—" }
            ?: res.getString(R.string.notif_wait_title)
        val subtitle = title?.trim()?.takeIf { it.isNotEmpty() }
            ?: agentName?.trim()?.takeIf { it.isNotEmpty() }
        val body = preview?.trim()?.takeIf { it.isNotEmpty() }
            ?: res.getString(R.string.notif_wait_body)

        val builder = baseBuilder(sessionId)
            .setContentTitle(contentTitle)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .addAction(
                R.drawable.ic_stat_agent_wait,
                res.getString(R.string.notif_wait_approve),
                actionIntent(sessionId, AgentWaitActionReceiver.ACTION_APPROVE),
            )
            .addAction(
                R.drawable.ic_stat_agent_wait,
                res.getString(R.string.notif_wait_stop),
                actionIntent(sessionId, AgentWaitActionReceiver.ACTION_STOP),
            )
        if (subtitle != null) builder.setSubText(subtitle)
        notify(sessionId, builder.build())
    }

    /** Re-post a failed-action notification so the user can retry or open the session. */
    private fun postFailed(sessionId: String) {
        if (!canNotify()) return
        val res = appContext.resources
        val builder = baseBuilder(sessionId)
            .setContentTitle(res.getString(R.string.notif_wait_failed_title))
            .setContentText(res.getString(R.string.notif_wait_failed_body))
            .addAction(
                R.drawable.ic_stat_agent_wait,
                res.getString(R.string.notif_wait_approve),
                actionIntent(sessionId, AgentWaitActionReceiver.ACTION_APPROVE),
            )
            .addAction(
                R.drawable.ic_stat_agent_wait,
                res.getString(R.string.notif_wait_stop),
                actionIntent(sessionId, AgentWaitActionReceiver.ACTION_STOP),
            )
        notify(sessionId, builder.build())
    }

    private fun baseBuilder(sessionId: String): NotificationCompat.Builder =
        NotificationCompat.Builder(appContext, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_agent_wait)
            // Waiting/in-progress is a neutral state — no status hue borrowed for decoration.
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(tapIntent(sessionId))

    private fun tapIntent(sessionId: String): PendingIntent {
        val intent = Intent(appContext, MainActivity::class.java).apply {
            action = Intent.ACTION_VIEW
            putExtra(EXTRA_OPEN_SESSION, sessionId)
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        return PendingIntent.getActivity(
            appContext,
            ("tap_$sessionId").hashCode(),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    private fun actionIntent(sessionId: String, action: String): PendingIntent {
        val intent = Intent(appContext, AgentWaitActionReceiver::class.java).apply {
            this.action = action
            putExtra(EXTRA_OPEN_SESSION, sessionId)
        }
        return PendingIntent.getBroadcast(
            appContext,
            ("$action$sessionId").hashCode(),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    /** Cancel a session's notification + state (resolved / opened / away-gated). */
    fun clear(sessionId: String) = clearNotificationOnly(sessionId)

    private fun clearNotificationOnly(sessionId: String) {
        NotificationManagerCompat.from(appContext).cancel(sessionId, NOTIF_ID)
    }

    @SuppressLint("MissingPermission") // canNotify() verifies POST_NOTIFICATIONS before notifying
    private fun notify(sessionId: String, n: Notification) {
        if (!canNotify()) return
        // Per-session tag keeps concurrent waits from overwriting each other.
        NotificationManagerCompat.from(appContext).notify(sessionId, NOTIF_ID, n)
    }

    private fun canNotify(): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            val granted = ContextCompat.checkSelfPermission(
                appContext, Manifest.permission.POST_NOTIFICATIONS,
            ) == PackageManager.PERMISSION_GRANTED
            if (!granted) return false
        }
        return NotificationManagerCompat.from(appContext).areNotificationsEnabled()
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val mgr = appContext.getSystemService(NotificationManager::class.java) ?: return
        if (mgr.getNotificationChannel(CHANNEL_ID) != null) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            appContext.getString(R.string.notif_channel_wait),
            NotificationManager.IMPORTANCE_HIGH,
        ).apply {
            description = appContext.getString(R.string.notif_channel_wait_desc)
            setShowBadge(true)
        }
        mgr.createNotificationChannel(channel)
    }

    companion object {
        private const val TAG = "AgentWaitNotifier"
        const val CHANNEL_ID = "agent_wait"
        const val NOTIF_ID = 4201
        const val EXTRA_OPEN_SESSION = "openSessionId"
        private const val ACTION_APPROVE = "approve"
        private const val ACTION_INTERRUPT = "interrupt"
    }
}
