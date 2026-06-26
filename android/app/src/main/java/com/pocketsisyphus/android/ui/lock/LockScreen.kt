package com.pocketsisyphus.android.ui.lock

import android.content.Intent
import android.provider.Settings
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.pocketsisyphus.android.R
import com.pocketsisyphus.android.data.Ps
import com.pocketsisyphus.android.data.UnlockResult
import com.pocketsisyphus.android.ui.theme.PsColor
import kotlinx.coroutines.launch

/** Screen state of the app-entry lock. */
private sealed interface LockPhase {
    data object Authenticating : LockPhase
    data class Failed(val failure: LockFailure) : LockPhase
}

/** Classified unlock failure → drives the status copy, icon tint and recovery actions. */
private enum class LockFailure { CANCELED, LOCKOUT, UNAVAILABLE, ERROR }

/**
 * The gate shown in place of the main UI while [com.pocketsisyphus.android.data.AppLock] is locked.
 *
 * It auto-raises the biometric / device-credential prompt on appear; on success `markUnlocked`
 * flips `locked`, which the caller observes to reveal the main UI (no explicit callback needed).
 * Failures stay on this screen with a retry, plus situational recovery guidance (passcode hint on
 * lockout, security-settings shortcut when no screen lock is set up).
 *
 * Color policy: the status icon uses neutral `.onSurfaceVariant` while authenticating and on a plain
 * cancel; danger (red) only signals genuine error / blocking states. The retry button keeps the
 * default accent tint. Body text uses auto-adapting `onSurface*` tokens — no hardcoded black/white.
 */
@Composable
fun LockScreen() {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var phase by remember { mutableStateOf<LockPhase>(LockPhase.Authenticating) }
    var running by remember { mutableStateOf(false) }

    suspend fun authenticate() {
        if (running) return
        running = true
        try {
            val auth = Ps.appLock.authenticator
            if (auth == null) {
                phase = LockPhase.Failed(LockFailure.ERROR)
                return
            }
            phase = LockPhase.Authenticating
            when (auth.authenticate()) {
                UnlockResult.Success -> Ps.appLock.markUnlocked()
                UnlockResult.Canceled -> phase = LockPhase.Failed(LockFailure.CANCELED)
                UnlockResult.Lockout -> phase = LockPhase.Failed(LockFailure.LOCKOUT)
                UnlockResult.Unavailable -> phase = LockPhase.Failed(LockFailure.UNAVAILABLE)
                is UnlockResult.Error -> phase = LockPhase.Failed(LockFailure.ERROR)
            }
        } finally {
            running = false
        }
    }

    // Fires once per mount; a re-lock (background → grace) remounts the screen and re-prompts.
    LaunchedEffect(Unit) { authenticate() }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(horizontal = 24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        StatusIcon(phase)

        Spacer(Modifier.height(16.dp))

        Text(
            text = stringResource(R.string.lock_app_name),
            style = MaterialTheme.typography.titleLarge,
        )

        Spacer(Modifier.height(8.dp))

        Text(
            text = statusText(phase),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )

        Spacer(Modifier.height(24.dp))

        when (val p = phase) {
            LockPhase.Authenticating -> ProgressRow()
            is LockPhase.Failed -> FailureActions(
                failure = p.failure,
                onRetry = { scope.launch { authenticate() } },
                onOpenSettings = {
                    runCatching {
                        context.startActivity(
                            Intent(Settings.ACTION_SECURITY_SETTINGS)
                                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                        )
                    }
                },
            )
        }
    }
}

@Composable
private fun StatusIcon(phase: LockPhase) {
    val isError = phase is LockPhase.Failed &&
        (phase.failure == LockFailure.ERROR || phase.failure == LockFailure.UNAVAILABLE)
    val icon: ImageVector =
        if (phase is LockPhase.Authenticating) Icons.Outlined.Lock else Icons.Filled.Lock
    Icon(
        imageVector = icon,
        contentDescription = stringResource(iconContentDescription(phase)),
        tint = if (isError) PsColor.danger else MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.size(48.dp),
    )
}

@Composable
private fun ProgressRow() {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier.clearAndSetSemantics { },
    ) {
        CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
        Spacer(Modifier.width(8.dp))
        Text(
            text = stringResource(R.string.lock_unlocking),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun FailureActions(
    failure: LockFailure,
    onRetry: () -> Unit,
    onOpenSettings: () -> Unit,
) {
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(12.dp),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Button(onClick = onRetry, modifier = Modifier.fillMaxWidth()) {
            Text(stringResource(R.string.lock_retry))
        }

        if (failure == LockFailure.UNAVAILABLE) {
            OutlinedButton(onClick = onOpenSettings, modifier = Modifier.fillMaxWidth()) {
                Text(stringResource(R.string.lock_open_settings))
            }
        }

        if (failure == LockFailure.LOCKOUT) {
            Text(
                text = stringResource(R.string.lock_lockout_hint),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
            )
        }
    }
}

@Composable
private fun statusText(phase: LockPhase) = stringResource(
    when (phase) {
        LockPhase.Authenticating -> R.string.lock_authenticating
        is LockPhase.Failed -> when (phase.failure) {
            LockFailure.CANCELED -> R.string.lock_failed_canceled
            LockFailure.LOCKOUT -> R.string.lock_failed_lockout
            LockFailure.UNAVAILABLE -> R.string.lock_failed_unavailable
            LockFailure.ERROR -> R.string.lock_failed_error
        }
    },
)

private fun iconContentDescription(phase: LockPhase): Int = when (phase) {
    LockPhase.Authenticating -> R.string.lock_cd_authenticating
    is LockPhase.Failed -> when (phase.failure) {
        LockFailure.CANCELED -> R.string.lock_cd_locked
        LockFailure.LOCKOUT -> R.string.lock_cd_lockout
        LockFailure.UNAVAILABLE -> R.string.lock_cd_unavailable
        LockFailure.ERROR -> R.string.lock_cd_error
    }
}
