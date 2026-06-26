package com.pocketsisyphus.android.data

import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import com.pocketsisyphus.android.R
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlin.coroutines.resume

/**
 * Gates use of the device-attestation key behind the user's biometric (Face/fingerprint),
 * mirroring the iPhone Face ID / LAContext "lost-phone protection": a stolen, unlocked phone
 * still can't mint attest tokens without the owner's biometric.
 */
interface AttestAuthenticator {
    /** Prompt for biometric; true if the user authenticated. Throws on hard error. */
    suspend fun authenticate(): Boolean
}

/** [AttestAuthenticator] backed by androidx [BiometricPrompt]; needs a [FragmentActivity] host. */
class BiometricAuthenticator(private val activity: FragmentActivity) : AttestAuthenticator {

    override suspend fun authenticate(): Boolean = withContext(Dispatchers.Main) {
        suspendCancellableCoroutine { cont ->
            val executor = ContextCompat.getMainExecutor(activity)
            val prompt = BiometricPrompt(
                activity,
                executor,
                object : BiometricPrompt.AuthenticationCallback() {
                    override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                        if (cont.isActive) cont.resume(true)
                    }

                    override fun onAuthenticationError(code: Int, msg: CharSequence) {
                        // User cancel / lockout etc. — treat as "not authenticated", let the caller decide.
                        if (cont.isActive) cont.resume(false)
                    }

                    override fun onAuthenticationFailed() {
                        // A single non-match; BiometricPrompt keeps the dialog open — do nothing.
                    }
                },
            )
            val info = BiometricPrompt.PromptInfo.Builder()
                .setTitle(activity.getString(R.string.biometric_title))
                .setSubtitle(activity.getString(R.string.biometric_subtitle))
                .setNegativeButtonText(activity.getString(R.string.biometric_cancel))
                .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
                .build()
            prompt.authenticate(info)
            cont.invokeOnCancellation { runCatching { prompt.cancelAuthentication() } }
        }
    }
}
