package com.pocketsisyphus.android.mirror

/**
 * Pure byte-level parsing for the daemon's typed H.264 mirror frames. Kept free of Android framework
 * types so it can be unit-tested on the JVM (the trickiest part of the decoder is the AVCC↔Annex-B
 * conversion and the parameter-set framing).
 *
 * Wire format (capture-helper `writeTyped` → daemon `broadcastBinaryToSession`):
 *   - parameter sets body: `[2B spsLen][sps][2B ppsLen][pps]` (big-endian lengths, raw NAL bytes)
 *   - access unit body:    `[AVCC]` where AVCC = `[4B len][NAL]` repeated
 */
object H264Framing {

    /** SPS + PPS as raw NAL byte arrays. */
    data class ParamSets(val sps: ByteArray, val pps: ByteArray)

    /** Parse a type-1 parameter-set body starting at [off]. Returns null on a malformed/short body. */
    fun parseParamSets(d: ByteArray, off: Int): ParamSets? {
        var i = off
        fun u16(): Int? {
            if (i + 2 > d.size) return null
            val v = (d[i].toInt() and 0xFF shl 8) or (d[i + 1].toInt() and 0xFF)
            i += 2
            return v
        }
        val sl = u16() ?: return null
        if (sl <= 0 || i + sl > d.size) return null
        val sps = d.copyOfRange(i, i + sl); i += sl
        val pl = u16() ?: return null
        if (pl <= 0 || i + pl > d.size) return null
        val pps = d.copyOfRange(i, i + pl); i += pl
        return ParamSets(sps, pps)
    }

    /** Prefix a raw NAL with a 4-byte Annex-B start code (`00 00 00 01`). */
    fun annexB(nal: ByteArray): ByteArray {
        val out = ByteArray(nal.size + 4)
        out[3] = 1
        System.arraycopy(nal, 0, out, 4, nal.size)
        return out
    }

    /**
     * Convert an AVCC byte stream (`[4B len][NAL]`*) starting at [off] into an Annex-B stream
     * (`00 00 00 01` start codes). Returns null if a declared length runs past the buffer.
     */
    fun avccToAnnexB(d: ByteArray, off: Int): ByteArray? {
        var i = off
        var outLen = 0
        while (i + 4 <= d.size) {
            val len = nalLen(d, i)
            i += 4
            if (len <= 0 || i + len > d.size) return null
            outLen += 4 + len
            i += len
        }
        if (outLen == 0) return null
        val out = ByteArray(outLen)
        var src = off
        var dst = 0
        while (src + 4 <= d.size) {
            val len = nalLen(d, src)
            src += 4
            out[dst + 3] = 1
            dst += 4
            System.arraycopy(d, src, out, dst, len)
            dst += len
            src += len
        }
        return out
    }

    private fun nalLen(d: ByteArray, i: Int): Int =
        (d[i].toInt() and 0xFF shl 24) or (d[i + 1].toInt() and 0xFF shl 16) or
            (d[i + 2].toInt() and 0xFF shl 8) or (d[i + 3].toInt() and 0xFF)
}
