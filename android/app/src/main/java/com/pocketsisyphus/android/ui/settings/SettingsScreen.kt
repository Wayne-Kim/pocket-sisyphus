package com.pocketsisyphus.android.ui.settings

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Build
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Phone
import androidx.compose.material.icons.filled.Share
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.pocketsisyphus.android.BuildConfig
import com.pocketsisyphus.android.R
import com.pocketsisyphus.android.data.ConnectionManager
import com.pocketsisyphus.android.data.LocalePrefs
import com.pocketsisyphus.android.data.Ps
import com.pocketsisyphus.android.data.ThemePrefs
import com.pocketsisyphus.android.ui.theme.PsColor

private enum class SettingsSub { ROOT, DEVICES, TOOLS, BRIDGE }

/**
 * Android settings — mirrors the in-scope iPhone settings sheet sections: app language, current
 * connection security status, paired devices, external tool servers, and unpair. Color is meaning:
 * danger (red) for destructive actions, warning (yellow) for «setup needed», pro (orange) for the
 * «advanced» Tools group. Body text uses theme-adaptive colors; no raw hues.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    onBack: () -> Unit,
    onUnpair: () -> Unit,
    vm: SettingsViewModel = viewModel(),
) {
    var sub by remember { mutableStateOf(SettingsSub.ROOT) }

    BackHandler { if (sub == SettingsSub.ROOT) onBack() else sub = SettingsSub.ROOT }

    when (sub) {
        SettingsSub.DEVICES -> DevicesScreen(vm = vm, onBack = { sub = SettingsSub.ROOT }, onUnpair = onUnpair)
        SettingsSub.TOOLS -> ToolsScreen(vm = vm, onBack = { sub = SettingsSub.ROOT })
        SettingsSub.BRIDGE -> com.pocketsisyphus.android.ui.bridge.BridgeScreen(onBack = { sub = SettingsSub.ROOT })
        SettingsSub.ROOT -> SettingsRoot(
            onBack = onBack,
            onUnpair = onUnpair,
            onOpenDevices = { sub = SettingsSub.DEVICES },
            onOpenTools = { sub = SettingsSub.TOOLS },
            onOpenBridges = { sub = SettingsSub.BRIDGE },
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SettingsRoot(
    onBack: () -> Unit,
    onUnpair: () -> Unit,
    onOpenDevices: () -> Unit,
    onOpenTools: () -> Unit,
    onOpenBridges: () -> Unit,
) {
    val version by Ps.capabilities.version.collectAsStateWithLifecycle()
    val connState by Ps.connection.state.collectAsStateWithLifecycle()
    val skeleton by Ps.connection.skeleton.collectAsStateWithLifecycle()

    val context = LocalContext.current
    val openFailed = stringResource(R.string.settings_help_open_failed)
    val shareSubject = stringResource(R.string.settings_share_subject)
    val shareText = stringResource(R.string.settings_share_text)
    val shareChooser = stringResource(R.string.settings_share)

    var showTheme by remember { mutableStateOf(false) }
    var showLanguage by remember { mutableStateOf(false) }
    var showUnpairConfirm by remember { mutableStateOf(false) }

    SettingsScaffold(title = stringResource(R.string.settings_title), onBack = onBack) { inner ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(inner)
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(20.dp),
        ) {
            // General — theme & language.
            SettingsSection(stringResource(R.string.settings_general)) {
                NavRow(
                    icon = ThemeContrastIcon,
                    title = stringResource(R.string.settings_theme),
                    value = currentThemeName(),
                    onClick = { showTheme = true },
                )
                NavRow(
                    icon = Icons.Filled.Info,
                    title = stringResource(R.string.settings_language),
                    value = currentLanguageName(),
                    onClick = { showLanguage = true },
                )
            }

            // Connection security status.
            ConnectionSection(connState, skeleton)

            // Tor bridge bypass — optional, for DPI-blocked networks.
            SettingsSection(stringResource(R.string.bridge_section_title)) {
                NavRow(
                    icon = Icons.Filled.Lock,
                    title = stringResource(R.string.bridge_title),
                    onClick = onOpenBridges,
                )
            }

            // Devices.
            SettingsSection(stringResource(R.string.settings_devices)) {
                NavRow(
                    icon = Icons.Filled.Phone,
                    title = stringResource(R.string.settings_devices_manage),
                    onClick = onOpenDevices,
                )
            }

            // Tools (advanced = pro). Gated by capability, like the iPhone entry point.
            if (version?.supportsMcpTools == true) {
                SettingsSection(stringResource(R.string.settings_tools), accent = PsColor.pro) {
                    NavRow(
                        icon = Icons.Filled.Build,
                        iconTint = PsColor.pro,
                        title = stringResource(R.string.settings_tools_manage),
                        onClick = onOpenTools,
                    )
                }
            }

            // Help & Share — community help routes to the public GitHub Discussions hub in an
            // external browser; share hands the project link to the system share sheet. Default
            // tint (accent), not pro/warning — this is a guidance entry point, like the iPhone
            // «도움받기·공유하기».
            SettingsSection(stringResource(R.string.settings_help)) {
                NavRow(
                    icon = Icons.AutoMirrored.Filled.Send,
                    title = stringResource(R.string.settings_help_get),
                    contentDescription = stringResource(R.string.a11y_settings_help_get),
                    onClick = {
                        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(SupportLinks.DISCUSSIONS))
                            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                        try {
                            context.startActivity(intent)
                        } catch (e: ActivityNotFoundException) {
                            Toast.makeText(context, openFailed, Toast.LENGTH_LONG).show()
                        }
                    },
                )
                NavRow(
                    icon = Icons.Filled.Share,
                    title = stringResource(R.string.settings_share),
                    contentDescription = stringResource(R.string.a11y_settings_share),
                    onClick = {
                        val send = Intent(Intent.ACTION_SEND).apply {
                            type = "text/plain"
                            putExtra(Intent.EXTRA_SUBJECT, shareSubject)
                            putExtra(Intent.EXTRA_TEXT, "$shareText\n${SupportLinks.PROJECT_HOME}")
                        }
                        try {
                            context.startActivity(
                                Intent.createChooser(send, shareChooser)
                                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                            )
                        } catch (e: ActivityNotFoundException) {
                            Toast.makeText(context, openFailed, Toast.LENGTH_LONG).show()
                        }
                    },
                )
            }

            // Unpair — destructive (danger).
            SettingsSection(stringResource(R.string.settings_account)) {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable { showUnpairConfirm = true }
                        .padding(horizontal = 14.dp, vertical = 14.dp),
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    Text(stringResource(R.string.settings_unpair), color = PsColor.danger, style = MaterialTheme.typography.bodyLarge)
                    Text(
                        stringResource(R.string.settings_unpair_desc),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }

            // App version — shown at the bottom so it's easy to attach when reporting a bug
            // (mirrors the iPhone «vX.Y.Z (build)» convention).
            Text(
                stringResource(R.string.settings_version, BuildConfig.VERSION_NAME, BuildConfig.VERSION_CODE),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = 8.dp),
            )

            Spacer(Modifier.height(16.dp))
        }
    }

    if (showTheme) {
        ThemeSheet(onDismiss = { showTheme = false })
    }

    if (showLanguage) {
        LanguageSheet(onDismiss = { showLanguage = false })
    }

    if (showUnpairConfirm) {
        AlertDialog(
            onDismissRequest = { showUnpairConfirm = false },
            title = { Text(stringResource(R.string.settings_unpair_confirm_title)) },
            text = { Text(stringResource(R.string.settings_unpair_confirm_msg)) },
            confirmButton = {
                TextButton(onClick = { showUnpairConfirm = false; onUnpair() }) {
                    Text(stringResource(R.string.settings_unpair), color = PsColor.danger)
                }
            },
            dismissButton = {
                TextButton(onClick = { showUnpairConfirm = false }) { Text(stringResource(R.string.cancel)) }
            },
        )
    }
}

@Composable
private fun ConnectionSection(state: ConnectionManager.State, skeleton: ConnectionManager.SkeletonState) {
    val connected = state is ConnectionManager.State.Connected
    val connecting = state is ConnectionManager.State.Connecting
    val statusText = when {
        connected -> stringResource(R.string.settings_conn_connected)
        connecting -> stringResource(R.string.settings_conn_connecting)
        state is ConnectionManager.State.Failed -> stringResource(R.string.settings_conn_failed)
        else -> stringResource(R.string.settings_conn_offline)
    }
    val statusColor = when {
        connected -> PsColor.success
        connecting -> MaterialTheme.colorScheme.onSurfaceVariant
        else -> PsColor.danger
    }

    SettingsSection(stringResource(R.string.settings_connection)) {
        Column(modifier = Modifier.padding(horizontal = 14.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            InfoLine(stringResource(R.string.settings_conn_status), statusText, valueColor = statusColor)
            InfoLine(stringResource(R.string.settings_conn_path), channelLabel(skeleton.channel))
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Icon(
                    Icons.Filled.Lock,
                    contentDescription = null,
                    tint = if (connected) PsColor.success else PsColor.warning,
                    modifier = Modifier.size(16.dp),
                )
                Text(
                    if (connected) stringResource(R.string.settings_conn_secure)
                    else stringResource(R.string.settings_conn_secure_offline),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.weight(1f),
                )
            }
        }
    }
}

@Composable
private fun InfoLine(label: String, value: String, valueColor: Color = Color.Unspecified) {
    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(label, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(
            value,
            style = MaterialTheme.typography.bodyMedium,
            color = if (valueColor == Color.Unspecified) MaterialTheme.colorScheme.onSurface else valueColor,
        )
    }
}

@Composable
private fun channelLabel(channel: String?): String = when (channel) {
    "direct_lan" -> stringResource(R.string.settings_channel_lan)
    "direct_ipv6" -> stringResource(R.string.settings_channel_ipv6)
    "direct_ipv4" -> stringResource(R.string.settings_channel_ipv4)
    "tor_onion" -> stringResource(R.string.settings_channel_tor)
    else -> stringResource(R.string.settings_channel_unknown)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ThemeSheet(onDismiss: () -> Unit) {
    val context = LocalContext.current
    val current by ThemePrefs.mode.collectAsStateWithLifecycle()

    fun apply(mode: ThemePrefs.Mode) {
        ThemePrefs.setMode(context, mode)
        onDismiss()
    }

    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp).padding(bottom = 24.dp),
        ) {
            Text(
                stringResource(R.string.settings_theme_pick),
                style = MaterialTheme.typography.titleMedium,
                modifier = Modifier.padding(horizontal = 12.dp, vertical = 12.dp),
            )
            ThemePrefs.Mode.entries.forEach { mode ->
                LanguageRow(
                    label = stringResource(themeModeLabel(mode)),
                    selected = current == mode,
                    onClick = { apply(mode) },
                )
            }
        }
    }
}

/** String resource for a theme mode's display label. */
private fun themeModeLabel(mode: ThemePrefs.Mode): Int = when (mode) {
    ThemePrefs.Mode.SYSTEM -> R.string.settings_theme_system
    ThemePrefs.Mode.LIGHT -> R.string.settings_theme_light
    ThemePrefs.Mode.DARK -> R.string.settings_theme_dark
}

@Composable
private fun currentThemeName(): String =
    stringResource(themeModeLabel(ThemePrefs.mode.collectAsStateWithLifecycle().value))

/**
 * A contrast glyph (circle with the left half filled) for the «Theme» row — mirrors the iOS
 * `circle.lefthalf.filled`. Built inline because the app only bundles `material-icons-core`, which
 * has no brightness/theme icon. `Icon` tints the whole vector, so the filled half + stroked outline
 * render in one color and read as a half-toned circle.
 */
private val ThemeContrastIcon: ImageVector = ImageVector.Builder(
    name = "ThemeContrast",
    defaultWidth = 24.dp,
    defaultHeight = 24.dp,
    viewportWidth = 24f,
    viewportHeight = 24f,
).apply {
    // Circle outline (two clockwise semicircle arcs).
    path(stroke = SolidColor(Color.Black), strokeLineWidth = 1.8f) {
        moveTo(12f, 3f)
        arcTo(9f, 9f, 0f, false, true, 12f, 21f)
        arcTo(9f, 9f, 0f, false, true, 12f, 3f)
    }
    // Left half filled (counterclockwise arc back up, then straight close).
    path(fill = SolidColor(Color.Black)) {
        moveTo(12f, 3f)
        arcTo(9f, 9f, 0f, false, false, 12f, 21f)
        close()
    }
}.build()

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun LanguageSheet(onDismiss: () -> Unit) {
    val context = LocalContext.current
    val current = remember { LocalePrefs.currentTag(context) }

    fun apply(tag: String?) {
        LocalePrefs.setTag(context, tag)
        onDismiss()
        (context as? Activity)?.recreate()
    }

    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp).padding(bottom = 24.dp),
        ) {
            Text(
                stringResource(R.string.settings_language_pick),
                style = MaterialTheme.typography.titleMedium,
                modifier = Modifier.padding(horizontal = 12.dp, vertical = 12.dp),
            )
            LanguageRow(
                label = stringResource(R.string.settings_language_system),
                selected = current == null,
                onClick = { apply(null) },
            )
            LocalePrefs.languages.forEach { (tag, name) ->
                LanguageRow(label = name, selected = current == tag, onClick = { apply(tag) })
            }
        }
    }
}

@Composable
private fun LanguageRow(label: String, selected: Boolean, onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
        if (selected) {
            Icon(Icons.Filled.Check, contentDescription = null, tint = PsColor.accent)
        }
    }
}

@Composable
private fun currentLanguageName(): String {
    val context = LocalContext.current
    val tag = LocalePrefs.currentTag(context) ?: return stringResource(R.string.settings_language_system)
    return LocalePrefs.languages.firstOrNull { it.first == tag }?.second ?: tag
}

// ── shared building blocks (also used by Devices/Tools screens) ─────────────────────

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun SettingsScaffold(
    title: String,
    onBack: () -> Unit,
    actions: @Composable () -> Unit = {},
    content: @Composable (androidx.compose.foundation.layout.PaddingValues) -> Unit,
) {
    val backDesc = stringResource(R.string.back)
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(title) },
                navigationIcon = {
                    IconButton(onClick = onBack, modifier = Modifier.clearAndSetSemantics { contentDescription = backDesc }) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = null)
                    }
                },
                actions = { actions() },
            )
        },
        content = content,
    )
}

@Composable
internal fun SettingsSection(
    title: String,
    accent: Color = Color.Unspecified,
    content: @Composable () -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(
            title,
            style = MaterialTheme.typography.labelLarge,
            color = if (accent == Color.Unspecified) MaterialTheme.colorScheme.onSurfaceVariant else accent,
            modifier = Modifier.padding(start = 4.dp),
        )
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(12.dp))
                .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f)),
        ) {
            content()
        }
    }
}

@Composable
internal fun NavRow(
    icon: ImageVector,
    title: String,
    value: String? = null,
    iconTint: Color = Color.Unspecified,
    contentDescription: String? = null,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .then(
                if (contentDescription != null) {
                    Modifier.semantics { this.contentDescription = contentDescription }
                } else {
                    Modifier
                },
            )
            .padding(horizontal = 14.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Icon(
            icon,
            contentDescription = null,
            tint = if (iconTint == Color.Unspecified) MaterialTheme.colorScheme.onSurfaceVariant else iconTint,
            modifier = Modifier.size(22.dp),
        )
        Text(title, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
        value?.let {
            Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Icon(
            Icons.AutoMirrored.Filled.KeyboardArrowRight,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

// Reuse a monospace fingerprint style across settings sub-screens.
internal val FingerprintFont = FontFamily.Monospace
