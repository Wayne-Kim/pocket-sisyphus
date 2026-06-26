package com.pocketsisyphus.android.voice

import com.pocketsisyphus.android.data.Ps
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import org.vosk.Model
import org.vosk.Recognizer
import org.vosk.android.RecognitionListener
import org.vosk.android.SpeechService
import java.io.File
import java.util.Locale
import java.util.zip.ZipInputStream

/**
 * On-device speech-to-text — the Android counterpart of the iPhone's WhisperKit dictation. Runs Vosk
 * 100% on-device; only the model «weights» download once (public weights, not user audio), then it's
 * fully offline. Push-to-talk: hold the mic → record → release → the clip is transcribed and the text
 * is inserted into the field (never auto-sent).
 *
 * Shared singleton: model load (incl. download) is expensive and one instance is enough — once
 * [State.READY] it stays ready across screens (mirrors iOS `WhisperSpeechRecognizer.shared`).
 */
object VoiceRecognizer {

    enum class State { IDLE, PREPARING, READY, FAILED }

    data class UiState(
        val state: State = State.IDLE,
        /** Weight download progress 0..1 (only meaningful while PREPARING + downloading). */
        val downloadProgress: Float = 0f,
        /** Download finished, model is loading (indeterminate). */
        val loading: Boolean = false,
        val recording: Boolean = false,
        val transcribing: Boolean = false,
        val error: String? = null,
    )

    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state.asStateFlow()

    private var model: Model? = null
    private var speech: SpeechService? = null
    private var resultCb: ((String) -> Unit)? = null

    private const val BASE = "https://alphacephei.com/vosk/models/"
    private val http = OkHttpClient()

    /** A downloadable small (offline) model for the app's current language; en-US is the fallback. */
    private data class Spec(val name: String, val approxMB: Int)

    private fun spec(): Spec = when (currentLang()) {
        "ko" -> Spec("vosk-model-small-ko-0.22", 82)
        "ja" -> Spec("vosk-model-small-ja-0.22", 48)
        "zh" -> Spec("vosk-model-small-cn-0.22", 42)
        "ru" -> Spec("vosk-model-small-ru-0.22", 45)
        "fr" -> Spec("vosk-model-small-fr-0.22", 41)
        "es" -> Spec("vosk-model-small-es-0.42", 39)
        "hi" -> Spec("vosk-model-small-hi-0.22", 42)
        "pt" -> Spec("vosk-model-small-pt-0.3", 31)
        else -> Spec("vosk-model-small-en-us-0.15", 40) // en + anything without a small model
    }

    /** Base language code the app is currently displaying (region tag dropped). */
    private fun currentLang(): String {
        val tag = Locale.getDefault().language.ifEmpty { "en" }
        return tag.lowercase()
    }

    /** Approx download size (MB) for the current model — shown before the first download. */
    fun approxDownloadMB(): Int = spec().approxMB

    private fun modelDir(name: String): File = File(File(Ps.appContext.filesDir, "vosk"), name)

    /**
     * Download (once) + load the model. No-op if already ready / in progress. Called on the first
     * mic press; subsequent app launches reuse the cached weights (no re-download).
     */
    suspend fun prepare() {
        val st = _state.value.state
        if (st == State.PREPARING || st == State.READY) return
        _state.update { it.copy(state = State.PREPARING, downloadProgress = 0f, loading = false, error = null) }
        try {
            withContext(Dispatchers.IO) {
                val spec = spec()
                val dir = modelDir(spec.name)
                if (!isModelPresent(dir)) {
                    downloadAndUnzip(spec.name)
                }
                _state.update { it.copy(loading = true, downloadProgress = 1f) }
                model = Model(dir.absolutePath)
            }
            _state.update { it.copy(state = State.READY, loading = false) }
        } catch (e: Throwable) {
            _state.update { it.copy(state = State.FAILED, loading = false, error = e.message) }
        }
    }

    private fun isModelPresent(dir: File): Boolean =
        dir.isDirectory && (File(dir, "am").exists() || File(dir, "conf").exists())

    private fun downloadAndUnzip(name: String) {
        val voskDir = File(Ps.appContext.filesDir, "vosk").apply { mkdirs() }
        val req = Request.Builder().url("$BASE$name.zip").build()
        http.newCall(req).execute().use { resp ->
            if (!resp.isSuccessful) throw IllegalStateException("download failed: ${resp.code}")
            val body = resp.body ?: throw IllegalStateException("empty body")
            val total = body.contentLength().takeIf { it > 0 } ?: -1L
            var read = 0L
            ZipInputStream(body.byteStream()).use { zip ->
                var entry = zip.nextEntry
                val buf = ByteArray(64 * 1024)
                while (entry != null) {
                    val out = File(voskDir, entry.name)
                    if (entry.isDirectory) {
                        out.mkdirs()
                    } else {
                        out.parentFile?.mkdirs()
                        out.outputStream().use { os ->
                            var n = zip.read(buf)
                            while (n >= 0) {
                                os.write(buf, 0, n)
                                read += n
                                if (total > 0) {
                                    _state.update { it.copy(downloadProgress = (read.toFloat() / total).coerceIn(0f, 0.99f)) }
                                }
                                n = zip.read(buf)
                            }
                        }
                    }
                    zip.closeEntry()
                    entry = zip.nextEntry
                }
            }
        }
    }

    /**
     * Begin push-to-talk recording. Requires [State.READY] + an already-granted RECORD_AUDIO
     * permission (the button checks both). The recognized text is delivered once via [onResult] when
     * [stopRecording] is called.
     */
    fun startRecording(onResult: (String) -> Unit) {
        val m = model
        if (_state.value.state != State.READY || m == null || _state.value.recording) return
        resultCb = onResult
        try {
            val rec = Recognizer(m, SAMPLE_RATE)
            val svc = SpeechService(rec, SAMPLE_RATE)
            speech = svc
            _state.update { it.copy(recording = true, error = null) }
            svc.startListening(listener)
        } catch (e: Throwable) {
            _state.update { it.copy(recording = false, error = e.message) }
            speech?.shutdown()
            speech = null
        }
    }

    /** Stop recording; the final transcript arrives via the listener and is handed to [onResult]. */
    fun stopRecording() {
        if (!_state.value.recording) return
        _state.update { it.copy(transcribing = true) }
        speech?.stop() // → onFinalResult
    }

    private val listener = object : RecognitionListener {
        override fun onPartialResult(hypothesis: String?) {}
        override fun onResult(hypothesis: String?) {}
        override fun onFinalResult(hypothesis: String?) {
            val text = parseText(hypothesis)
            _state.update { it.copy(recording = false, transcribing = false) }
            speech?.shutdown()
            speech = null
            if (text.isNotBlank()) resultCb?.invoke(text)
            resultCb = null
        }

        override fun onError(e: Exception?) {
            _state.update { it.copy(recording = false, transcribing = false, error = e?.message) }
            speech?.shutdown()
            speech = null
        }

        override fun onTimeout() {
            _state.update { it.copy(recording = false, transcribing = false) }
            speech?.shutdown()
            speech = null
        }
    }

    private fun parseText(hypothesis: String?): String {
        if (hypothesis.isNullOrBlank()) return ""
        return runCatching { JSONObject(hypothesis).optString("text", "").trim() }.getOrDefault("")
    }

    private const val SAMPLE_RATE = 16000.0f
}
