package com.pocketsisyphus.android.data

import android.os.Build
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
 * [LockAuthenticator] backed by androidx [BiometricPrompt] for the app-entry lock.
 *
 * Unlike [BiometricAuthenticator] (which must use BIOMETRIC_STRONG to unlock the Keystore attest
 * key), the entry lock only gates the UI, so it also accepts the device credential
 * (PIN/pattern/password). That is the «recover with your device passcode» path the spec asks for:
 * if biometrics are missing or locked out, the user can still get in with the phone passcode.
 */
class BiometricLockAuthenticator(private val activity: FragmentActivity) : LockAuthenticator {

    /** Biometric on R+; on older releases the strong class can't combine with credential, so weak. */
    private val authenticators: Int =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            BiometricManager.Authenticators.BIOMETRIC_STRONG or
                BiometricManager.Authenticators.DEVICE_CREDENTIAL
        } else {
            BiometricManager.Authenticators.BIOMETRIC_WEAK or
                BiometricManager.Authenticators.DEVICE_CREDENTIAL
        }

    override suspend fun authenticate(): UnlockResult = withContext(Dispatchers.Main) {
        when (BiometricManager.from(activity).canAuthenticate(authenticators)) {
            BiometricManager.BIOMETRIC_SUCCESS -> Unit
            // No biometric AND no device PIN/pattern/password is set up: nothing can confirm the
            // owner, so block with clear guidance rather than silently letting anyone in.
            BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED,
            BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE,
            BiometricManager.BIOMETRIC_ERROR_HW_UNAVAILABLE,
            BiometricManager.BIOMETRIC_ERROR_SECURITY_UPDATE_REQUIRED,
            BiometricManager.BIOMETRIC_ERROR_UNSUPPORTED,
            -> return@withContext UnlockResult.Unavailable
            else -> return@withContext UnlockResult.Unavailable
        }

        suspendCancellableCoroutine<UnlockResult> { cont ->
            val executor = ContextCompat.getMainExecutor(activity)
            val prompt = BiometricPrompt(
                activity,
                executor,
                object : BiometricPrompt.AuthenticationCallback() {
                    override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                        if (cont.isActive) cont.resume(UnlockResult.Success)
                    }

                    override fun onAuthenticationError(code: Int, msg: CharSequence) {
                        if (cont.isActive) cont.resume(classify(code, msg))
                    }

                    override fun onAuthenticationFailed() {
                        // A single non-match; the dialog stays open for another try — do nothing.
                    }
                },
            )
            val info = BiometricPrompt.PromptInfo.Builder()
                .setTitle(activity.getString(R.string.lock_prompt_title))
                .setSubtitle(activity.getString(R.string.lock_prompt_subtitle))
                // A negative button is mutually exclusive with allowing the device credential.
                .setAllowedAuthenticators(authenticators)
                .build()
            prompt.authenticate(info)
            cont.invokeOnCancellation { runCatching { prompt.cancelAuthentication() } }
        }
    }

    private fun classify(code: Int, msg: CharSequence): UnlockResult = when (code) {
        BiometricPrompt.ERROR_USER_CANCELED,
        BiometricPrompt.ERROR_NEGATIVE_BUTTON,
        BiometricPrompt.ERROR_CANCELED,
        -> UnlockResult.Canceled

        BiometricPrompt.ERROR_LOCKOUT,
        BiometricPrompt.ERROR_LOCKOUT_PERMANENT,
        -> UnlockResult.Lockout

        BiometricPrompt.ERROR_NO_BIOMETRICS,
        BiometricPrompt.ERROR_HW_NOT_PRESENT,
        BiometricPrompt.ERROR_HW_UNAVAILABLE,
        BiometricPrompt.ERROR_NO_DEVICE_CREDENTIAL,
        -> UnlockResult.Unavailable

        else -> UnlockResult.Error(msg.toString().ifBlank { null })
    }
}
