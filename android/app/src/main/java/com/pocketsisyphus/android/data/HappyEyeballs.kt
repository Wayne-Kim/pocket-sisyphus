package com.pocketsisyphus.android.data

import com.pocketsisyphus.android.data.model.EndpointEntry
import com.pocketsisyphus.android.data.model.EndpointKind

/**
 * Happy-eyeballs (RFC 8305) candidate ordering — the pure policy, mirroring iOS
 * `HappyEyeballsPolicy.swift`. Decides *which* candidates to try and in *what* order; the
 * connection attempts themselves live in [ConnectionManager].
 *
 * Rules:
 *  - ascending `priority` (smaller first): direct_lan(0) → direct_ipv6(1) → direct_ipv4(2)
 *    → tor_onion(99). Direct channels race first; tor_onion is always the last fallback.
 *  - tor_onion candidates only matter once Tor is bootstrapped — dropped when `torReady=false`.
 *  - stable for equal priority (input order preserved) — deterministic.
 */
object HappyEyeballs {
    fun order(endpoints: List<EndpointEntry>, torReady: Boolean): List<EndpointEntry> =
        endpoints
            .withIndex()
            .sortedWith(compareBy({ it.value.priority }, { it.index }))
            .map { it.value }
            .filter { !(it.kind == EndpointKind.TOR_ONION && !torReady) }
}
