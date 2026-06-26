package com.pocketsisyphus.android.ui.sessions

import com.pocketsisyphus.android.data.model.SessionRow
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure-JVM coverage for [ApprovalInbox] — the approval-inbox state machine (selection, serial
 * approve/reject, reconcile against the live waiting set, and finish signalling).
 *
 * Uses an Unconfined scope plus a synchronous (non-suspending) sender so each `launch` runs to
 * completion inline, keeping the assertions deterministic without coroutines-test.
 */
class ApprovalInboxTest {

    private val scope = CoroutineScope(Dispatchers.Unconfined)

    private fun row(id: String) = SessionRow(id = id, title = id, repoPath = "/repo/$id", waitingSince = 1)

    private fun inbox(
        ids: List<String>,
        finished: () -> Unit = {},
        send: suspend (String, String) -> Boolean = { _, _ -> true },
    ) = ApprovalInbox(initial = ids.map { row(it) }, scope = scope, onFinished = finished, send = send)

    @Test
    fun startsWithEverythingSelectedAndActionable() {
        val box = inbox(listOf("a", "b"))
        val s = box.state.value
        assertEquals(2, s.items.size)
        assertEquals(2, s.selectedActionableCount)
        assertTrue(s.hasActionable)
        assertFalse(s.finished)
    }

    @Test
    fun approveAllMarksEveryRowApprovedAndFinishes() {
        var finished = false
        val sent = mutableListOf<Pair<String, String>>()
        val box = inbox(listOf("a", "b"), finished = { finished = true }) { id, action ->
            sent += id to action; true
        }
        box.approve(selectedOnly = false)
        val s = box.state.value
        assertTrue(s.items.all { it.status == ApprovalInbox.RowStatus.APPROVED })
        assertEquals(listOf("a" to "approve", "b" to "approve"), sent)
        assertTrue(s.finished)
        assertTrue(finished)
    }

    @Test
    fun approveSelectedOnlyTouchesSelectedRows() {
        val box = inbox(listOf("a", "b", "c"))
        box.toggleSelect("b") // deselect b
        box.approve(selectedOnly = true)
        val s = box.state.value
        assertEquals(ApprovalInbox.RowStatus.APPROVED, s.items.first { it.id == "a" }.status)
        assertEquals(ApprovalInbox.RowStatus.PENDING, s.items.first { it.id == "b" }.status)
        assertEquals(ApprovalInbox.RowStatus.APPROVED, s.items.first { it.id == "c" }.status)
        // b still actionable/pending → not finished.
        assertFalse(s.finished)
    }

    @Test
    fun rejectSendsInterruptAndMarksRejected() {
        val sent = mutableListOf<Pair<String, String>>()
        val box = inbox(listOf("a")) { id, action -> sent += id to action; true }
        box.reject("a")
        assertEquals(listOf("a" to "interrupt"), sent)
        assertEquals(ApprovalInbox.RowStatus.REJECTED, box.state.value.items.first().status)
        assertTrue(box.state.value.finished)
    }

    @Test
    fun failedSendLeavesRowActionableForRetry() {
        var attempts = 0
        val box = inbox(listOf("a")) { _, _ -> attempts++; attempts > 1 } // fail first, succeed second
        box.approveOne("a")
        assertEquals(ApprovalInbox.RowStatus.FAILED, box.state.value.items.first().status)
        assertTrue(box.state.value.items.first().actionable)
        // Retry succeeds.
        box.approveOne("a")
        assertEquals(ApprovalInbox.RowStatus.APPROVED, box.state.value.items.first().status)
    }

    @Test
    fun reconcileDropsActionableRowsThatLeftWaitingSet() {
        val box = inbox(listOf("a", "b"))
        box.reconcile(setOf("a")) // b approved elsewhere
        val s = box.state.value
        assertEquals(listOf("a"), s.items.map { it.id })
        assertTrue(s.externallyResolved)
    }

    @Test
    fun reconcileKeepsAlreadyProcessedRows() {
        val box = inbox(listOf("a", "b"))
        box.approveOne("a") // a now APPROVED (no longer waiting)
        box.reconcile(setOf("b")) // a not in live set, but it's terminal → kept; b still waiting
        val s = box.state.value
        assertEquals(setOf("a", "b"), s.items.map { it.id }.toSet())
        assertFalse(s.externallyResolved)
    }

    @Test
    fun reconcileToEmptyShowsEmptyStateWithoutFinishing() {
        var finished = false
        val box = inbox(listOf("a"), finished = { finished = true })
        box.reconcile(emptySet())
        // All actionable rows handled elsewhere → empty state + notice, but no auto-finish/dismiss.
        assertTrue(box.state.value.items.isEmpty())
        assertTrue(box.state.value.externallyResolved)
        assertFalse(box.state.value.finished)
        assertFalse(finished)
    }

    @Test
    fun toggleSelectIgnoresNonActionableRows() {
        val box = inbox(listOf("a")) { _, _ -> true }
        box.approveOne("a") // terminal
        box.toggleSelect("a") // no-op
        assertTrue(box.state.value.items.first().selected) // unchanged
    }
}
