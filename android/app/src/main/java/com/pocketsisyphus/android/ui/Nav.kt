package com.pocketsisyphus.android.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.filled.Build
import androidx.compose.material.icons.filled.Home
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.pocketsisyphus.android.BuildConfig
import com.pocketsisyphus.android.DevBootstrap
import com.pocketsisyphus.android.R
import com.pocketsisyphus.android.data.Ps
import com.pocketsisyphus.android.data.model.CronJob
import com.pocketsisyphus.android.data.model.WorkflowSummary
import com.pocketsisyphus.android.ui.automation.AutomationScreen
import com.pocketsisyphus.android.ui.backlog.BacklogScreen
import com.pocketsisyphus.android.ui.bridge.BridgeScreen
import com.pocketsisyphus.android.ui.commits.CommitsScreen
import com.pocketsisyphus.android.ui.cron.CronEditorScreen
import com.pocketsisyphus.android.ui.diagnostics.DiagnosticsScreen
import com.pocketsisyphus.android.ui.lock.LockScreen
import com.pocketsisyphus.android.ui.mirror.ScreenMirrorScreen
import com.pocketsisyphus.android.ui.pairing.PairingScreen
import com.pocketsisyphus.android.ui.paywall.PaywallScreen
import com.pocketsisyphus.android.ui.session.SessionDetailScreen
import com.pocketsisyphus.android.ui.sessions.SessionListScreen
import com.pocketsisyphus.android.ui.settings.SettingsScreen
import com.pocketsisyphus.android.ui.theme.PsColor
import com.pocketsisyphus.android.ui.workflow.WorkflowEditorScreen
import com.pocketsisyphus.android.ui.workflow.WorkflowRunScreen

private sealed interface Screen {
    data object Pairing : Screen
    data object Diagnostics : Screen
    data object Bridges : Screen
    data object Main : Screen
    data class Detail(val sessionId: String, val title: String) : Screen
    data class Commits(val sessionId: String, val title: String, val branch: String?) : Screen
    data class Branches(val sessionId: String, val title: String) : Screen
    data class CronEditor(val job: CronJob?) : Screen
    data class WorkflowEditor(val workflow: WorkflowSummary?) : Screen
    data class WorkflowRun(val workflowId: String?, val runId: String?, val title: String) : Screen
    data object Paywall : Screen
    data object Settings : Screen
    // Optional return target so mirroring opened from a session chat returns to that chat, not Main.
    data class ScreenMirror(val returnSessionId: String? = null, val returnTitle: String? = null) : Screen
}

private enum class MainTab { SESSIONS, BACKLOG, AUTOMATION }

/**
 * Paired, or running under the dev direct-daemon bypass — which needs no stored pairing yet should
 * land straight on the main UI (skip onboarding), exactly like the iOS simulator dev pairing.
 */
private val devOrPaired: Boolean
    get() = Ps.pairStore.isPaired || (BuildConfig.DEBUG && DevBootstrap.directActive)

@Composable
fun AppRoot() {
    // App-entry lock: while locked (cold launch / background-past-grace on a paired device) the
    // main UI stays hidden behind the biometric gate. Never gates onboarding (unpaired → unlocked).
    val locked by Ps.appLock.locked.collectAsStateWithLifecycle()
    if (locked) {
        LockScreen()
        return
    }

    var screen by remember {
        mutableStateOf<Screen>(if (devOrPaired) Screen.Main else Screen.Pairing)
    }

    // Start the global agent-wait listener once paired; consume notification-tap deep links.
    val pendingDeepLink by Ps.waitNotifier.pendingDeepLink.collectAsStateWithLifecycle()
    LaunchedEffect(Unit) {
        if (devOrPaired) Ps.waitNotifier.start()
    }
    LaunchedEffect(pendingDeepLink) {
        val sid = pendingDeepLink ?: return@LaunchedEffect
        if (devOrPaired) {
            screen = Screen.Detail(sid, sid.take(6))
        }
        Ps.waitNotifier.consumeDeepLink()
    }

    when (val s = screen) {
        Screen.Pairing -> PairingScreen(onPaired = {
            Ps.waitNotifier.start()
            screen = Screen.Diagnostics
        })

        // The brief's go/no-go proof screen, shown right after pairing.
        Screen.Diagnostics -> DiagnosticsScreen(
            onContinue = { screen = Screen.Main },
            onOpenBridges = { screen = Screen.Bridges },
        )

        // Tor bridge bypass — reached from the diagnostic «Tor blocked» card.
        Screen.Bridges -> {
            BackHandler { screen = Screen.Diagnostics }
            BridgeScreen(onBack = { screen = Screen.Diagnostics })
        }

        Screen.Main -> MainScaffold(
            onOpenSession = { id, title -> screen = Screen.Detail(id, title) },
            onNewCron = { screen = Screen.CronEditor(null) },
            onEditCron = { screen = Screen.CronEditor(it) },
            onNewWorkflow = { screen = Screen.WorkflowEditor(null) },
            onEditWorkflow = { screen = Screen.WorkflowEditor(it) },
            onRunWorkflow = { screen = Screen.WorkflowRun(it.id, null, it.displayTitle) },
            onOpenPaywall = { screen = Screen.Paywall },
            onOpenSettings = { screen = Screen.Settings },
            onOpenMirror = { screen = Screen.ScreenMirror() },
        )

        is Screen.ScreenMirror -> {
            val back: () -> Unit = {
                screen = s.returnSessionId?.let { Screen.Detail(it, s.returnTitle ?: it.take(6)) }
                    ?: Screen.Main
            }
            BackHandler { back() }
            ScreenMirrorScreen(onBack = back)
        }

        Screen.Settings -> {
            BackHandler { screen = Screen.Main }
            SettingsScreen(
                onBack = { screen = Screen.Main },
                onUnpair = {
                    Ps.connection.disconnect()
                    Ps.waitNotifier.stop()
                    Ps.pairStore.clear()
                    Ps.appLock.onUnpaired()
                    screen = Screen.Pairing
                },
            )
        }

        is Screen.Detail -> {
            BackHandler { screen = Screen.Main }
            val version by Ps.capabilities.version.collectAsStateWithLifecycle()
            SessionDetailScreen(
                sessionId = s.sessionId,
                initialTitle = s.title,
                onBack = { screen = Screen.Main },
                onOpenCommits = { branch -> screen = Screen.Commits(s.sessionId, s.title, branch) },
                onOpenBranches = { screen = Screen.Branches(s.sessionId, s.title) },
                onOpenMirror = { screen = Screen.ScreenMirror(s.sessionId, s.title) },
                canMirror = version?.supportsScreenCapture == true,
            )
        }

        is Screen.Commits -> {
            CommitsScreen(
                sessionId = s.sessionId,
                branch = s.branch,
                onBack = { screen = Screen.Detail(s.sessionId, s.title) },
            )
        }

        is Screen.Branches -> {
            BackHandler { screen = Screen.Detail(s.sessionId, s.title) }
            com.pocketsisyphus.android.ui.branch.BranchScreen(
                sessionId = s.sessionId,
                onBack = { screen = Screen.Detail(s.sessionId, s.title) },
            )
        }

        is Screen.CronEditor -> {
            BackHandler { screen = Screen.Main }
            CronEditorScreen(
                existing = s.job,
                terminalSupported = Ps.capabilities.current?.supportsCronTerminal == true,
                onDone = { screen = Screen.Main },
            )
        }

        is Screen.WorkflowEditor -> {
            BackHandler { screen = Screen.Main }
            WorkflowEditorScreen(
                existing = s.workflow,
                onSaved = { screen = Screen.Main },
                onBack = { screen = Screen.Main },
            )
        }

        is Screen.WorkflowRun -> {
            BackHandler { screen = Screen.Main }
            WorkflowRunScreen(
                workflowId = s.workflowId,
                runId = s.runId,
                title = s.title,
                onOpenSession = { id -> screen = Screen.Detail(id, id.take(6)) },
                onBack = { screen = Screen.Main },
            )
        }

        Screen.Paywall -> {
            BackHandler { screen = Screen.Main }
            PaywallScreen(onClose = { screen = Screen.Main })
        }
    }
}

@Composable
private fun MainScaffold(
    onOpenSession: (String, String) -> Unit,
    onNewCron: () -> Unit,
    onEditCron: (CronJob) -> Unit,
    onNewWorkflow: () -> Unit,
    onEditWorkflow: (WorkflowSummary) -> Unit,
    onRunWorkflow: (WorkflowSummary) -> Unit,
    onOpenPaywall: () -> Unit,
    onOpenSettings: () -> Unit,
    onOpenMirror: () -> Unit,
) {
    var tab by remember { mutableStateOf(MainTab.SESSIONS) }
    val version by Ps.capabilities.version.collectAsStateWithLifecycle()
    val entitlement by Ps.entitlement.state.collectAsStateWithLifecycle()

    LaunchedEffect(Unit) {
        Ps.capabilities.refresh()
        Ps.entitlement.start()
    }

    // iOS MainTabView is the source of truth for tab order, visibility, default, and gating:
    //  • Order: Backlog (1) · Sessions (2) · Automation (3).
    //  • Backlog shows only when the daemon advertises po_loop_v1; Automation only when
    //    workflow_v1 || cron_v1 — otherwise the tab is hidden entirely (not an «update Mac» stub).
    //  • Default selected tab is Sessions (always present).
    //  • Backlog & Automation are Pro: tapping them while locked opens the paywall instead of
    //    switching (free now via Entitlement.iapEnabled=false → always unlocked).
    val showBacklog = version?.supportsBacklog == true
    val showAutomation = version?.supportsAutomation == true
    // A selected-but-now-hidden tab (capability dropped on reconnect) falls back to Sessions.
    val effectiveTab = when {
        tab == MainTab.BACKLOG && !showBacklog -> MainTab.SESSIONS
        tab == MainTab.AUTOMATION && !showAutomation -> MainTab.SESSIONS
        else -> tab
    }
    val proColors = @Composable {
        NavigationBarItemDefaults.colors(
            selectedIconColor = PsColor.pro,
            selectedTextColor = PsColor.pro,
            unselectedIconColor = PsColor.pro.copy(alpha = 0.7f),
            unselectedTextColor = PsColor.pro.copy(alpha = 0.7f),
            indicatorColor = PsColor.pro.copy(alpha = 0.18f),
        )
    }

    Scaffold(
        bottomBar = {
            NavigationBar {
                // 1 — Backlog (Pro/orange). Only the tab button is orange; content keeps accent.
                if (showBacklog) {
                    NavigationBarItem(
                        selected = effectiveTab == MainTab.BACKLOG,
                        onClick = {
                            if (entitlement.isProUnlocked) tab = MainTab.BACKLOG else onOpenPaywall()
                        },
                        icon = { Icon(Icons.AutoMirrored.Filled.List, contentDescription = null) },
                        label = { Text(stringResource(R.string.tab_backlog)) },
                        colors = proColors(),
                    )
                }
                // 2 — Sessions (free, always present).
                NavigationBarItem(
                    selected = effectiveTab == MainTab.SESSIONS,
                    onClick = { tab = MainTab.SESSIONS },
                    icon = { Icon(Icons.Filled.Home, contentDescription = null) },
                    label = { Text(stringResource(R.string.tab_sessions)) },
                )
                // 3 — Automation (Pro/orange).
                if (showAutomation) {
                    NavigationBarItem(
                        selected = effectiveTab == MainTab.AUTOMATION,
                        onClick = {
                            if (entitlement.isProUnlocked) tab = MainTab.AUTOMATION else onOpenPaywall()
                        },
                        icon = { Icon(Icons.Filled.Build, contentDescription = null) },
                        label = { Text(stringResource(R.string.tab_automation)) },
                        colors = proColors(),
                    )
                }
            }
        },
    ) { inner ->
        when (effectiveTab) {
            MainTab.BACKLOG ->
                BacklogScreen(
                    version = version,
                    isProUnlocked = entitlement.isProUnlocked,
                    onOpenPaywall = onOpenPaywall,
                    onOpenSession = { id -> onOpenSession(id, id.take(6)) },
                    onOpenSettings = onOpenSettings,
                    modifier = Modifier.fillMaxSize().padding(inner),
                )
            MainTab.SESSIONS ->
                SessionListScreen(
                    onOpen = { session -> onOpenSession(session.id, session.displayTitle) },
                    onOpenSettings = onOpenSettings,
                    onOpenMirror = onOpenMirror,
                    canMirror = version?.supportsScreenCapture == true,
                    modifier = Modifier.fillMaxSize().padding(inner),
                )
            MainTab.AUTOMATION ->
                AutomationScreen(
                    version = version,
                    isProUnlocked = entitlement.isProUnlocked,
                    onOpenPaywall = onOpenPaywall,
                    onNewCron = onNewCron,
                    onEditCron = onEditCron,
                    onNewWorkflow = onNewWorkflow,
                    onEditWorkflow = onEditWorkflow,
                    onRunWorkflow = onRunWorkflow,
                    onOpenSession = { id -> onOpenSession(id, id.take(6)) },
                    modifier = Modifier.fillMaxSize().padding(inner),
                )
        }
    }
}
