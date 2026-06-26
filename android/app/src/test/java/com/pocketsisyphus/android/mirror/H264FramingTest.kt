package com.pocketsisyphus.android.mirror

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Pure-JVM coverage for the H.264 mirror wire framing (the decoder's trickiest byte logic). */
class H264FramingTest {

    private val startCode = byteArrayOf(0, 0, 0, 1)

    @Test
    fun parseParamSets_extractsSpsAndPps() {
        val sps = byteArrayOf(0x67, 0x42, 0x00, 0x1f)
        val pps = byteArrayOf(0x68, 0xCE.toByte(), 0x3c)
        // body: [type=1][2B spsLen][sps][2B ppsLen][pps]
        val body = byteArrayOf(1) +
            be16(sps.size) + sps +
            be16(pps.size) + pps
        val parsed = H264Framing.parseParamSets(body, 1)!!
        assertArrayEquals(sps, parsed.sps)
        assertArrayEquals(pps, parsed.pps)
    }

    @Test
    fun parseParamSets_rejectsTruncated() {
        // Declares 8-byte SPS but only 2 bytes follow.
        val body = byteArrayOf(1) + be16(8) + byteArrayOf(0x67, 0x42)
        assertNull(H264Framing.parseParamSets(body, 1))
    }

    @Test
    fun annexB_prefixesStartCode() {
        val nal = byteArrayOf(0x65, 0x11, 0x22)
        assertArrayEquals(startCode + nal, H264Framing.annexB(nal))
    }

    @Test
    fun avccToAnnexB_convertsMultipleNals() {
        val nal1 = byteArrayOf(0x65, 0x01, 0x02, 0x03)
        val nal2 = byteArrayOf(0x41, 0x0a, 0x0b)
        // body: [type=2][keyframe=1][4B len][nal1][4B len][nal2]
        val body = byteArrayOf(2, 1) +
            be32(nal1.size) + nal1 +
            be32(nal2.size) + nal2
        val out = H264Framing.avccToAnnexB(body, 2)!!
        assertArrayEquals(startCode + nal1 + startCode + nal2, out)
    }

    @Test
    fun avccToAnnexB_rejectsLengthPastBuffer() {
        // Declares a 99-byte NAL with only 3 bytes present.
        val body = byteArrayOf(2, 1) + be32(99) + byteArrayOf(0x65, 0x01, 0x02)
        assertNull(H264Framing.avccToAnnexB(body, 2))
    }

    @Test
    fun avccToAnnexB_emptyReturnsNull() {
        assertNull(H264Framing.avccToAnnexB(byteArrayOf(2, 1), 2))
    }

    @Test
    fun roundTrip_paramSetsThenAnnexB() {
        val sps = byteArrayOf(0x67, 0x64)
        val annexed = H264Framing.annexB(sps)
        assertEquals(sps.size + 4, annexed.size)
        assertArrayEquals(startCode, annexed.copyOfRange(0, 4))
    }

    private fun be16(v: Int) = byteArrayOf((v ushr 8).toByte(), v.toByte())
    private fun be32(v: Int) =
        byteArrayOf((v ushr 24).toByte(), (v ushr 16).toByte(), (v ushr 8).toByte(), v.toByte())
}
