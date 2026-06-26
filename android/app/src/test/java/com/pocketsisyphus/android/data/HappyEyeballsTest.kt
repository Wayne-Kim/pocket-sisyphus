package com.pocketsisyphus.android.data

import com.pocketsisyphus.android.data.model.EndpointEntry
import com.pocketsisyphus.android.data.model.EndpointKind
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Mirrors iOS `HappyEyeballsPolicyTests`: priority order + tor-gating + stable tie-break. */
class HappyEyeballsTest {

    private fun e(type: String, priority: Int, host: String = "h") =
        EndpointEntry(type = type, host = host, port = 22, priority = priority)

    @Test
    fun ordersByPriorityAscending_torLast() {
        val input = listOf(
            e("tor_onion", 99),
            e("direct_ipv4", 2),
            e("direct_ipv6", 1),
            e("direct_lan", 0),
        )
        val out = HappyEyeballs.order(input, torReady = true)
        assertEquals(
            listOf(
                EndpointKind.DIRECT_LAN,
                EndpointKind.DIRECT_IPV6,
                EndpointKind.DIRECT_IPV4,
                EndpointKind.TOR_ONION,
            ),
            out.map { it.kind },
        )
    }

    @Test
    fun dropsTorWhenNotReady() {
        val input = listOf(e("direct_ipv6", 1), e("tor_onion", 99))
        val out = HappyEyeballs.order(input, torReady = false)
        assertEquals(1, out.size)
        assertFalse(out.any { it.isTor })
    }

    @Test
    fun keepsTorWhenReady() {
        val input = listOf(e("tor_onion", 99))
        assertTrue(HappyEyeballs.order(input, torReady = true).any { it.isTor })
    }

    @Test
    fun stableForEqualPriority() {
        val input = listOf(
            e("direct_lan", 0, host = "a"),
            e("direct_lan", 0, host = "b"),
            e("direct_lan", 0, host = "c"),
        )
        val out = HappyEyeballs.order(input, torReady = true)
        assertEquals(listOf("a", "b", "c"), out.map { it.host })
    }
}
