package com.pocketsisyphus.android.ui.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
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
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.pocketsisyphus.android.R
import com.pocketsisyphus.android.data.model.DeviceInfoResponse
import com.pocketsisyphus.android.ui.theme.PsColor
import java.text.DateFormat
import java.util.Date

/**
 * Settings → Devices. Lists devices attested to this Mac and lets the phone revoke one or toggle
 * the extra-device slot — the same daemon admin routes the iPhone uses. Revoking «this device»
 * unpairs the phone (returns to the QR screen via [onUnpair]). Revoke/disconnect are destructive
 * (danger color).
 */
@Composable
fun DevicesScreen(
    vm: SettingsViewModel,
    onBack: () -> Unit,
    onUnpair: () -> Unit,
) {
    val ui by vm.devices.collectAsStateWithLifecycle()
    var revokeTarget by remember { mutableStateOf<DeviceInfoResponse.Device?>(null) }

    LaunchedEffect(Unit) { vm.loadDevices() }
    LaunchedEffect(ui.selfRevoked) { if (ui.selfRevoked) onUnpair() }

    SettingsScaffold(title = stringResource(R.string.devices_title), onBack = onBack) { inner ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(inner)
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            when {
                ui.loading && ui.info == null ->
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
                        Text(stringResource(R.string.devices_loading), color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                ui.error ->
                    Text(stringResource(R.string.devices_load_failed), color = PsColor.danger)
                ui.info != null -> {
                    val info = ui.info!!
                    if (info.enrolled) {
                        info.devices.forEachIndexed { idx, device ->
                            DeviceCard(
                                index = idx,
                                device = device,
                                sshFingerprint = info.sshClientKeyFingerprint,
                                isCurrent = vm.isCurrentDevice(device),
                                busy = ui.busy,
                                onRevoke = { revokeTarget = device },
                            )
                        }
                        ExtraSlotCard(info = info, busy = ui.busy, onToggle = { vm.setExtraSlot(it) })
                    } else {
                        NotEnrolledCard()
                    }
                }
            }

            ui.resultKey?.let { Text(resultText(it), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            Spacer(Modifier.height(8.dp))
        }
    }

    revokeTarget?.let { device ->
        val current = vm.isCurrentDevice(device)
        AlertDialog(
            onDismissRequest = { revokeTarget = null },
            title = { Text(stringResource(R.string.devices_revoke_title)) },
            text = {
                Text(
                    if (current) stringResource(R.string.devices_revoke_self_msg)
                    else stringResource(R.string.devices_revoke_other_msg),
                )
            },
            confirmButton = {
                TextButton(onClick = { vm.revokeDevice(device); revokeTarget = null }) {
                    Text(
                        if (current) stringResource(R.string.devices_revoke_self) else stringResource(R.string.devices_revoke),
                        color = PsColor.danger,
                    )
                }
            },
            dismissButton = {
                TextButton(onClick = { revokeTarget = null }) { Text(stringResource(R.string.cancel)) }
            },
        )
    }
}

@Composable
private fun DeviceCard(
    index: Int,
    device: DeviceInfoResponse.Device,
    sshFingerprint: String?,
    isCurrent: Boolean,
    busy: Boolean,
    onRevoke: () -> Unit,
) {
    Card {
        Column(modifier = Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Icon(Icons.Filled.CheckCircle, contentDescription = null, tint = PsColor.success, modifier = Modifier.size(18.dp))
                Text(stringResource(R.string.devices_device_n, index + 1), style = MaterialTheme.typography.titleSmall)
                if (isCurrent) Badge(stringResource(R.string.devices_this_device), PsColor.accent)
                Spacer(Modifier.weight(1f))
                Badge(stringResource(R.string.devices_authenticated), PsColor.success)
            }
            InfoRow(stringResource(R.string.devices_registered), formatDate(device.registeredAt))
            InfoRow(
                stringResource(R.string.devices_last_seen),
                device.lastSeen?.let { formatDate(it) } ?: stringResource(R.string.devices_last_seen_never),
            )
            device.attestKeyFingerprint?.let { FingerprintRow(stringResource(R.string.devices_key_fp), it) }
            sshFingerprint?.let { FingerprintRow(stringResource(R.string.devices_ssh_fp), it) }

            OutlinedButton(
                onClick = onRevoke,
                enabled = !busy && device.attestKeyFingerprint != null,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(
                    if (isCurrent) stringResource(R.string.devices_revoke_self) else stringResource(R.string.devices_revoke),
                    color = PsColor.danger,
                )
            }
        }
    }
}

@Composable
private fun ExtraSlotCard(info: DeviceInfoResponse, busy: Boolean, onToggle: (Boolean) -> Unit) {
    Card {
        Column(modifier = Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                val label = stringResource(R.string.devices_extra_slot)
                Text(label, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
                Switch(
                    checked = info.extraSlotAllowed,
                    onCheckedChange = { onToggle(it) },
                    enabled = !busy,
                    modifier = Modifier.semantics { contentDescription = label },
                )
            }
            Text(
                stringResource(R.string.devices_extra_slot_footer, info.maxSlots, info.devices.size),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun NotEnrolledCard() {
    Card {
        Column(modifier = Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(stringResource(R.string.devices_not_enrolled_title), style = MaterialTheme.typography.titleSmall, color = PsColor.warning)
            Text(
                stringResource(R.string.devices_not_enrolled_body),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun Card(content: @Composable () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.4f)),
    ) { content() }
}

@Composable
private fun Badge(text: String, color: Color) {
    Text(
        text,
        style = MaterialTheme.typography.labelSmall,
        color = color,
        modifier = Modifier
            .clip(RoundedCornerShape(6.dp))
            .background(color.copy(alpha = 0.18f))
            .padding(horizontal = 6.dp, vertical = 2.dp),
    )
}

@Composable
private fun InfoRow(label: String, value: String) {
    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(label, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(value, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurface)
    }
}

@Composable
private fun FingerprintRow(label: String, value: String) {
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(label, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(
            value,
            style = MaterialTheme.typography.bodySmall.copy(fontFamily = FingerprintFont),
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun resultText(key: String): String = when (key) {
    "revoked" -> stringResource(R.string.devices_result_revoked)
    "already_revoked" -> stringResource(R.string.devices_result_already)
    "revoke_failed" -> stringResource(R.string.devices_result_revoke_failed)
    "slot_remove_first" -> stringResource(R.string.devices_result_slot_remove_first)
    else -> stringResource(R.string.devices_result_slot_failed)
}

private fun formatDate(ms: Long?): String {
    if (ms == null || ms == 0L) return "—"
    return DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT).format(Date(ms))
}
