package com.pocketsisyphus.android.ui.bridge

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.pocketsisyphus.android.R
import com.pocketsisyphus.android.data.BridgeStore
import com.pocketsisyphus.android.ui.settings.SettingsScaffold
import com.pocketsisyphus.android.ui.settings.SettingsSection
import com.pocketsisyphus.android.ui.theme.PsColor

/**
 * «Tor bridge» bypass screen — reached from the settings root and from the diagnostic «Tor blocked»
 * card. An optional bypass for DPI-blocked networks: paste bridge lines, turn it on, and a stalled
 * plaintext bootstrap auto-retries through them. Opted-out users are unaffected.
 *
 * Design: status color is meaning only (success = green, failure = red, in-progress/idle = neutral);
 * the obfs4-unsupported note is a genuine caution (warning = yellow). The toggle + buttons keep the
 * default accent. Every interactive element carries a localized accessibility label.
 */
@Composable
fun BridgeScreen(
    onBack: () -> Unit,
    vm: BridgeViewModel = viewModel(),
) {
    val state by vm.state.collectAsStateWithLifecycle()

    SettingsScaffold(title = stringResource(R.string.bridge_title), onBack = onBack) { inner ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(inner)
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(20.dp),
        ) {
            // Enable toggle — off means no fallback ever happens.
            SettingsSection(stringResource(R.string.bridge_section_enable)) {
                val toggleDesc = stringResource(R.string.bridge_enable)
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 14.dp, vertical = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(stringResource(R.string.bridge_enable), style = MaterialTheme.typography.bodyLarge)
                        Text(
                            stringResource(R.string.bridge_enable_desc),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    Switch(
                        checked = state.enabled,
                        onCheckedChange = { vm.setEnabled(it) },
                        modifier = Modifier.clearAndSetSemantics { contentDescription = toggleDesc },
                    )
                }
            }

            // Runtime status of the bridge-through connection.
            SettingsSection(stringResource(R.string.bridge_section_status)) {
                Column(modifier = Modifier.padding(horizontal = 14.dp, vertical = 12.dp)) {
                    StatusRow(state.status, state.likelyBlocked)
                }
            }

            // Bridge line input + validation.
            SettingsSection(stringResource(R.string.bridge_section_lines)) {
                Column(
                    modifier = Modifier.padding(horizontal = 14.dp, vertical = 12.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    val linesDesc = stringResource(R.string.bridge_lines_label)
                    OutlinedTextField(
                        value = state.draft,
                        onValueChange = { vm.setDraft(it) },
                        modifier = Modifier
                            .fillMaxWidth()
                            .heightIn(min = 120.dp)
                            .semantics { contentDescription = linesDesc },
                        textStyle = TextStyle(fontFamily = FontFamily.Monospace, fontSize = 13.sp),
                        keyboardOptions = KeyboardOptions(
                            capitalization = KeyboardCapitalization.None,
                            autoCorrect = false,
                        ),
                        placeholder = {
                            Text(
                                "obfs4 192.0.2.1:443 FINGERPRINT cert=… iat-mode=0",
                                style = TextStyle(fontFamily = FontFamily.Monospace, fontSize = 12.sp),
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        },
                    )

                    ValidationRow(state.validCount, state.invalidCount, state.unsupportedTransports)

                    Text(
                        stringResource(R.string.bridge_lines_help),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )

                    if (state.hasObfs4 && !BridgeStore.obfs4Available) {
                        ObfsUnsupportedNote()
                    }

                    Button(
                        onClick = { vm.saveAndReconnect() },
                        enabled = !state.reconnecting && state.canReconnect,
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        if (state.reconnecting) {
                            CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
                            Text("  " + stringResource(R.string.bridge_reconnecting))
                        } else {
                            Icon(Icons.Filled.Refresh, contentDescription = null, modifier = Modifier.size(18.dp))
                            Text("  " + stringResource(R.string.bridge_save_reconnect))
                        }
                    }
                    Text(
                        stringResource(R.string.bridge_reconnect_footer),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }

            Spacer(Modifier.size(8.dp))
        }
    }
}

@Composable
private fun StatusRow(status: BridgeStore.Status, likelyBlocked: Boolean) {
    val (icon, tint, text) = when (status) {
        is BridgeStore.Status.Idle ->
            if (likelyBlocked) {
                Triple(Icons.Filled.Warning, PsColor.warning, stringResource(R.string.bridge_status_blocked))
            } else {
                Triple(Icons.Filled.Info, MaterialTheme.colorScheme.onSurfaceVariant, stringResource(R.string.bridge_status_idle))
            }
        is BridgeStore.Status.Connecting ->
            Triple(null, MaterialTheme.colorScheme.onSurfaceVariant, stringResource(R.string.bridge_status_connecting))
        is BridgeStore.Status.Connected ->
            Triple(Icons.Filled.Check, PsColor.success, stringResource(R.string.bridge_status_connected))
        is BridgeStore.Status.Failed ->
            Triple(Icons.Filled.Close, PsColor.danger, stringResource(R.string.bridge_status_failed))
    }
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        if (icon == null) {
            CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp, color = tint)
        } else {
            Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(18.dp))
        }
        Column {
            Text(text, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurface)
            (status as? BridgeStore.Status.Failed)?.let {
                Text(it.reason, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

@Composable
private fun ValidationRow(valid: Int, invalid: Int, unsupported: List<String>) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
            if (valid > 0) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    Icon(Icons.Filled.Check, contentDescription = null, tint = PsColor.success, modifier = Modifier.size(16.dp))
                    Text(
                        pluralStringResource(R.plurals.bridge_valid_count, valid, valid),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurface,
                    )
                }
            }
            if (invalid > 0) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    Icon(Icons.Filled.Close, contentDescription = null, tint = PsColor.danger, modifier = Modifier.size(16.dp))
                    Text(
                        pluralStringResource(R.plurals.bridge_invalid_count, invalid, invalid),
                        style = MaterialTheme.typography.bodySmall,
                        color = PsColor.danger,
                    )
                }
            }
        }
        if (unsupported.isNotEmpty()) {
            Text(
                stringResource(R.string.bridge_unsupported_transports, unsupported.joinToString(", ")),
                style = MaterialTheme.typography.bodySmall,
                color = PsColor.warning,
            )
        }
    }
}

@Composable
private fun ObfsUnsupportedNote() {
    Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Icon(Icons.Filled.Warning, contentDescription = null, tint = PsColor.warning, modifier = Modifier.size(18.dp))
        Text(
            stringResource(R.string.bridge_obfs4_unsupported),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}
