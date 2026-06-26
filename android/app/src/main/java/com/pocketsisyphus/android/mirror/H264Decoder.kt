package com.pocketsisyphus.android.mirror

import android.media.MediaCodec
import android.media.MediaFormat
import android.util.Log
import android.view.Surface
import java.util.ArrayDeque

/**
 * H.264 mirror renderer — parses the daemon's typed binary frames and decodes them straight to a
 * [Surface] (the mirror [android.view.TextureView]) via an async [MediaCodec]. Decode + scale run on
 * the codec's hardware path, so there is no per-frame bitmap copy.
 *
 * ## Wire protocol (daemon `broadcastBinaryToSession`, capture-helper `writeTyped`)
 *   - `[1B type][...]`
 *   - type 1 = parameter sets `[2B spsLen][sps][2B ppsLen][pps]` (BE lengths, raw NAL bytes)
 *   - type 2 = access unit `[1B keyframe][AVCC]` (AVCC = `[4B len][NAL]` repeated)
 *   - type 3 = audio config / type 4 = AAC packet — ignored (audio is out of scope for the phone).
 *
 * ## Threading
 * [handle]/[setSurface]/[reset]/[release] may be called from the WS receive thread; all state is
 * guarded by [lock]. MediaCodec async callbacks arrive on [callbackHandler]'s thread. Input buffers
 * are matched to pending access units through two small queues so a frame never blocks the WS thread.
 */
class H264Decoder(
    /** Real video pixel size from the decoder (W/H). Used by the UI to letterbox without distortion. */
    private val onVideoSize: (width: Int, height: Int) -> Unit,
    /** First decoded frame reached the surface — UI drops the "connecting" overlay. */
    private val onFirstFrame: () -> Unit,
    /** Unrecoverable decode/codec error — UI falls back to JPEG or shows an error. */
    private val onError: (String) -> Unit,
) {
    private val lock = Any()
    private val callbackThread = android.os.HandlerThread("mirror-h264").apply { start() }
    private val callbackHandler = android.os.Handler(callbackThread.looper)

    private var codec: MediaCodec? = null
    private var surface: Surface? = null
    private var sps: ByteArray? = null
    private var pps: ByteArray? = null
    private var configured = false
    private var hasKeyframe = false
    private var firstFrameEmitted = false
    private var released = false

    /** Input buffer indices the codec has handed us but we have no AU for yet. */
    private val availableInputs = ArrayDeque<Int>()
    /** Access units (already Annex-B) waiting for a free input buffer. Bounded to cap latency/memory. */
    private val pendingAUs = ArrayDeque<ByteArray>()

    fun setSurface(s: Surface?) = synchronized(lock) {
        if (released) return
        surface = s
        if (s == null) {
            teardownCodecLocked()
        } else if (sps != null && pps != null && !configured) {
            configureLocked()
        }
    }

    /** Feed one typed binary frame from the daemon. */
    fun handle(payload: ByteArray) = synchronized(lock) {
        if (released || payload.isEmpty()) return
        when (payload[0].toInt()) {
            1 -> handleParamSets(payload, 1)
            2 -> handleAccessUnit(payload, 1)
            // 3/4 = audio — intentionally ignored.
        }
    }

    /** Re-entry / reconnect — drop the reference chain and wait for the next keyframe. */
    fun reset() = synchronized(lock) {
        hasKeyframe = false
        firstFrameEmitted = false
        pendingAUs.clear()
        availableInputs.clear()
        runCatching { codec?.flush() }
        // After flush in async mode the codec resumes delivering input buffers automatically.
        runCatching { codec?.start() }
    }

    fun release() = synchronized(lock) {
        released = true
        teardownCodecLocked()
        surface = null
        callbackThread.quitSafely()
    }

    // ── parameter sets → configure ──────────────────────────────────────────────

    private fun handleParamSets(d: ByteArray, off: Int) {
        val parsed = H264Framing.parseParamSets(d, off) ?: return
        val newSps = parsed.sps
        val newPps = parsed.pps
        if (configured && newSps.contentEquals(sps) && newPps.contentEquals(pps)) return
        sps = newSps
        pps = newPps
        // Resolution/param change — rebuild the codec so the new SPS takes effect cleanly.
        teardownCodecLocked()
        if (surface != null) configureLocked()
    }

    private fun configureLocked() {
        val s = surface ?: return
        val spsN = sps ?: return
        val ppsN = pps ?: return
        try {
            val fmt = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, 1920, 1080)
            fmt.setByteBuffer("csd-0", java.nio.ByteBuffer.wrap(H264Framing.annexB(spsN)))
            fmt.setByteBuffer("csd-1", java.nio.ByteBuffer.wrap(H264Framing.annexB(ppsN)))
            val c = MediaCodec.createDecoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
            c.setCallback(object : MediaCodec.Callback() {
                override fun onInputBufferAvailable(mc: MediaCodec, index: Int) {
                    synchronized(lock) {
                        val au = pendingAUs.pollFirst()
                        if (au != null) feedLocked(mc, index, au) else availableInputs.addLast(index)
                    }
                }

                override fun onOutputBufferAvailable(mc: MediaCodec, index: Int, info: MediaCodec.BufferInfo) {
                    runCatching { mc.releaseOutputBuffer(index, true) }
                    if (!firstFrameEmitted) {
                        firstFrameEmitted = true
                        onFirstFrame()
                    }
                }

                override fun onOutputFormatChanged(mc: MediaCodec, format: MediaFormat) {
                    val w = cropDim(format, MediaFormat.KEY_WIDTH, "crop-right", "crop-left")
                    val h = cropDim(format, MediaFormat.KEY_HEIGHT, "crop-bottom", "crop-top")
                    if (w > 0 && h > 0) onVideoSize(w, h)
                }

                override fun onError(mc: MediaCodec, e: MediaCodec.CodecException) {
                    Log.w(TAG, "codec error: ${e.message}")
                    onError(e.message ?: "decode error")
                }
            }, callbackHandler)
            c.configure(fmt, s, null, 0)
            c.start()
            codec = c
            configured = true
        } catch (e: Throwable) {
            Log.w(TAG, "configure failed: ${e.message}")
            teardownCodecLocked()
            onError(e.message ?: "codec configure failed")
        }
    }

    // ── access unit → enqueue ───────────────────────────────────────────────────

    private fun handleAccessUnit(d: ByteArray, off: Int) {
        if (d.size <= off + 1) return
        val keyframe = d[off].toInt() == 1
        if (keyframe) hasKeyframe = true
        if (!hasKeyframe || !configured) return // no reference chain / not ready yet
        val au = H264Framing.avccToAnnexB(d, off + 1) ?: return
        val mc = codec ?: return
        val index = availableInputs.pollFirst()
        if (index != null) {
            feedLocked(mc, index, au)
        } else {
            // No free input buffer — queue, dropping the oldest if we back up badly (cap latency).
            if (pendingAUs.size >= MAX_PENDING) pendingAUs.pollFirst()
            pendingAUs.addLast(au)
        }
    }

    private fun feedLocked(mc: MediaCodec, index: Int, au: ByteArray) {
        try {
            val buf = mc.getInputBuffer(index) ?: return
            buf.clear()
            buf.put(au)
            mc.queueInputBuffer(index, 0, au.size, System.nanoTime() / 1000, 0)
        } catch (e: Throwable) {
            Log.w(TAG, "feed failed: ${e.message}")
        }
    }

    private fun teardownCodecLocked() {
        configured = false
        hasKeyframe = false
        availableInputs.clear()
        pendingAUs.clear()
        val c = codec
        codec = null
        if (c != null) {
            runCatching { c.stop() }
            runCatching { c.release() }
        }
    }

    // ── byte helpers ────────────────────────────────────────────────────────────

    private fun cropDim(format: MediaFormat, key: String, hi: String, lo: String): Int {
        if (format.containsKey(hi) && format.containsKey(lo)) {
            return format.getInteger(hi) - format.getInteger(lo) + 1
        }
        return if (format.containsKey(key)) format.getInteger(key) else 0
    }

    companion object {
        private const val TAG = "H264Decoder"
        private const val MAX_PENDING = 90
    }
}
