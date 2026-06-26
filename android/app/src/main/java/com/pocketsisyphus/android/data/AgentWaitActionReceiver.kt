package com.pocketsisyphus.android.data

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Handles the «진행(Enter)» / «중지(ESC)» notification actions and forwards them to
 * [AgentWaitNotifier], which calls the existing PTY control API. Kept tiny: all retry/state
 * logic (and the 401 re-auth / reconnect retry inside [ApiClient]) lives in the notifier.
 */
class AgentWaitActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val sessionId = intent.getStringExtra(AgentWaitNotifier.EXTRA_OPEN_SESSION) ?: return
        Ps.init(context.applicationContext) // no-op if already initialized (process may be cold)
        when (intent.action) {
            ACTION_APPROVE -> Ps.waitNotifier.onApprove(sessionId)
            ACTION_STOP -> Ps.waitNotifier.onStop(sessionId)
        }
    }

    companion object {
        const val ACTION_APPROVE = "com.pocketsisyphus.android.AGENT_WAIT_APPROVE"
        const val ACTION_STOP = "com.pocketsisyphus.android.AGENT_WAIT_STOP"
    }
}
