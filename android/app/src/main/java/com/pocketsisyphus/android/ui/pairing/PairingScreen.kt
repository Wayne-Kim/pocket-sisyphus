package com.pocketsisyphus.android.ui.pairing

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.pocketsisyphus.android.R
import com.pocketsisyphus.android.ui.components.SecureFlag
import com.pocketsisyphus.android.ui.theme.PsColor

@Composable
fun PairingScreen(
    onPaired: () -> Unit,
    vm: PairingViewModel = viewModel(),
) {
    // BL-07: 페어링 화면은 원시 페어링 페이로드(붙여넣기)·QR 을 다룬다 → 스크린샷/스위처 캡처 차단.
    SecureFlag()
    val state by vm.state.collectAsStateWithLifecycle()
    val context = LocalContext.current

    // Debug-only: auto-apply a pairing payload injected via launch intent (see DevBootstrap),
    // so a live daemon can be paired on the emulator without manual entry.
    androidx.compose.runtime.LaunchedEffect(Unit) {
        if (com.pocketsisyphus.android.BuildConfig.DEBUG) {
            com.pocketsisyphus.android.DevBootstrap.payloadJson?.let { json ->
                com.pocketsisyphus.android.DevBootstrap.payloadJson = null
                vm.onScanned(json)
                vm.onHostChange(com.pocketsisyphus.android.DevBootstrap.host)
                vm.connect(onPaired)
            }
        }
    }

    var scanning by remember { mutableStateOf(false) }
    var hasCamera by remember {
        mutableStateOf(
            ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) ==
                PackageManager.PERMISSION_GRANTED,
        )
    }
    val cameraPermission = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        hasCamera = granted
        scanning = granted
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Spacer(Modifier.height(24.dp))
        Text(stringResource(R.string.pairing_title), style = MaterialTheme.typography.headlineSmall)
        Text(
            stringResource(R.string.pairing_subtitle),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            FilterChip(
                selected = scanning,
                onClick = {
                    if (hasCamera) scanning = true
                    else cameraPermission.launch(Manifest.permission.CAMERA)
                },
                label = { Text(stringResource(R.string.pairing_scan_qr)) },
            )
            FilterChip(
                selected = !scanning,
                onClick = { scanning = false },
                label = { Text(stringResource(R.string.pairing_paste)) },
            )
        }

        if (scanning && hasCamera) {
            QrScanner(
                onResult = { raw ->
                    vm.onScanned(raw)
                    scanning = false
                },
                modifier = Modifier
                    .fillMaxWidth()
                    .aspectRatio(1f)
                    .clip(RoundedCornerShape(16.dp)),
            )
            Text(
                stringResource(R.string.pairing_camera_hint),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        } else {
            OutlinedTextField(
                value = state.pasteText,
                onValueChange = vm::onPasteChange,
                label = { Text(stringResource(R.string.pairing_payload_label)) },
                modifier = Modifier
                    .fillMaxWidth()
                    .height(150.dp),
                textStyle = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
            )
        }

        state.parsed?.let { p ->
            Text(
                "Mac: ${p.name ?: p.sshUser}" +
                    (p.lanHost?.let { "  ·  $it" } ?: ""),
                style = MaterialTheme.typography.bodyMedium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }

        OutlinedTextField(
            value = state.hostOverride,
            onValueChange = vm::onHostChange,
            label = { Text(stringResource(R.string.pairing_lan_label)) },
            supportingText = { Text(stringResource(R.string.pairing_lan_hint)) },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )

        state.error?.let { err ->
            val msg = when (err) {
                PairingViewModel.PairError.NotPayload -> stringResource(R.string.pair_err_not_payload)
                PairingViewModel.PairError.Outdated -> stringResource(R.string.pair_err_outdated)
                PairingViewModel.PairError.Unusable -> stringResource(R.string.pair_err_unusable)
                PairingViewModel.PairError.Connect -> stringResource(R.string.pair_err_connect)
            }
            Text(msg, color = PsColor.danger, style = MaterialTheme.typography.bodyMedium)
        }
        state.connectError?.let {
            Text(it, color = PsColor.danger, style = MaterialTheme.typography.bodyMedium)
        }

        Button(
            onClick = { vm.connect(onPaired) },
            enabled = state.canConnect,
            modifier = Modifier.fillMaxWidth(),
        ) {
            if (state.phase == PairingViewModel.Phase.Connecting) {
                CircularProgressIndicator(
                    modifier = Modifier.height(18.dp),
                    strokeWidth = 2.dp,
                    color = MaterialTheme.colorScheme.onPrimary,
                )
                Spacer(Modifier.height(0.dp))
                Text("  " + stringResource(R.string.pairing_connecting))
            } else {
                Text(stringResource(R.string.pairing_connect))
            }
        }

    }
}
