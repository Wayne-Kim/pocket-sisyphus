package com.pocketsisyphus.android.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Mirrors the iOS `TorBridgeParser` contract so the *same* bridge line works on both phones:
 * vanilla `IP:PORT [FP]` and PT `obfs4 IP:PORT FP …`, with `Bridge ` keyword stripping,
 * comment/blank skipping, de-duplication, and address/fingerprint validation.
 */
class TorBridgeParserTest {

    @Test fun parsesVanillaLine() {
        val r = TorBridgeParser.parse("192.0.2.1:443")
        assertEquals(1, r.valid.size)
        val line = r.valid[0]
        assertNull(line.transport)
        assertEquals("192.0.2.1:443", line.address)
        assertEquals("192.0.2.1:443", line.normalized)
        assertFalse(line.isPluggable)
    }

    @Test fun parsesObfs4WithFingerprint() {
        val fp = "ABCDEF0123456789ABCDEF0123456789ABCDEF01"
        val r = TorBridgeParser.parse("obfs4 192.0.2.1:443 $fp cert=xyz iat-mode=0")
        assertEquals(1, r.valid.size)
        val line = r.valid[0]
        assertEquals("obfs4", line.transport)
        assertEquals("192.0.2.1:443", line.address)
        assertEquals(fp, line.fingerprint)
        assertTrue(line.isPluggable)
    }

    @Test fun stripsBridgeKeywordCaseInsensitively() {
        val r = TorBridgeParser.parse("Bridge obfs4 192.0.2.1:9001 ABCDEF0123456789ABCDEF0123456789ABCDEF01")
        assertEquals(1, r.valid.size)
        assertTrue(r.valid[0].normalized.startsWith("obfs4 "))
    }

    @Test fun skipsCommentsAndBlankLines() {
        val r = TorBridgeParser.parse("\n# a comment\n   \n192.0.2.1:443\n")
        assertEquals(1, r.valid.size)
        assertEquals(0, r.invalid.size)
    }

    @Test fun deduplicatesIdenticalLines() {
        val r = TorBridgeParser.parse("192.0.2.1:443\n192.0.2.1:443")
        assertEquals(1, r.valid.size)
    }

    @Test fun flagsInvalidLines() {
        val r = TorBridgeParser.parse("not a bridge\n192.0.2.1:99999\n192.0.2.1:443")
        assertEquals(1, r.valid.size)
        assertEquals(2, r.invalid.size)
    }

    @Test fun mixedValidAndInvalid() {
        val fp = "ABCDEF0123456789ABCDEF0123456789ABCDEF01"
        val r = TorBridgeParser.parse("obfs4 192.0.2.1:443 $fp\njunk\n198.51.100.2:9001")
        assertEquals(2, r.valid.size)
        assertEquals(1, r.invalid.size)
    }

    @Test fun usableLinesExcludeObfs4WhenPtUnavailable() {
        // Mirrors the BridgeStore filtering: vanilla always usable, obfs4 only with a PT.
        val parsed = TorBridgeParser.parse("192.0.2.1:443\nobfs4 198.51.100.2:9001 ABCDEF0123456789ABCDEF0123456789ABCDEF01")
        val usableNoPt = parsed.valid.mapNotNull { line ->
            when (line.transportLower) {
                null -> line.normalized
                "obfs4" -> null
                else -> null
            }
        }
        assertEquals(listOf("192.0.2.1:443"), usableNoPt)
    }

    @Test fun ipv6AddressRecognized() {
        val r = TorBridgeParser.parse("[2001:db8::1]:443")
        assertEquals(1, r.valid.size)
        assertEquals("[2001:db8::1]:443", r.valid[0].address)
    }
}
