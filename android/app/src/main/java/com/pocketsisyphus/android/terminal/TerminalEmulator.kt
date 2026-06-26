package com.pocketsisyphus.android.terminal

/** One rendered line: parallel arrays of codepoint + color tokens + style flags, width [cols]. */
class TermLine(
    val codes: IntArray,
    val fg: IntArray,
    val bg: IntArray,
    val flags: IntArray,
)

/** An immutable view of the terminal for rendering (scrollback + screen). */
class TermFrame(
    val lines: List<TermLine>,
    val cols: Int,
    val cursorLine: Int,
    val cursorCol: Int,
    val cursorVisible: Boolean,
)

/**
 * A pragmatic VT100/xterm terminal emulator: enough of the control language to faithfully
 * render the daemon's PTY snapshot (an @xterm/addon-serialize ANSI dump) and the live
 * `pty_output` deltas the agent CLIs (Claude Code, codex, …) emit — SGR colors/attrs, cursor
 * addressing, erase, scroll regions, insert/delete, and the alternate screen.
 *
 * Not a general terminal: mouse/DCS/most OSC are parsed-and-ignored, double-width is treated
 * as single-width. Fed UTF-8 bytes incrementally (partial multibyte sequences are buffered).
 */
class TerminalEmulator(cols: Int, rows: Int) {

    var cols = cols.coerceIn(2, 400); private set
    var rows = rows.coerceIn(1, 200); private set

    private class Cell(
        var code: Int = SP,
        var fg: Int = TermColor.DEFAULT_FG,
        var bg: Int = TermColor.DEFAULT_BG,
        var flags: Int = 0,
    )

    private var screen = newGrid(this.cols, this.rows)
    private var altScreen: Array<Array<Cell>>? = null
    private val scrollback = ArrayDeque<TermLine>()
    private val maxScrollback = 1200

    private var cx = 0
    private var cy = 0
    private var savedCx = 0
    private var savedCy = 0
    private var top = 0
    private var bottom = this.rows - 1
    private var wrapPending = false
    private var autowrap = true
    private var cursorVisible = true

    // current SGR
    private var curFg = TermColor.DEFAULT_FG
    private var curBg = TermColor.DEFAULT_BG
    private var curFlags = 0
    private var savedFg = TermColor.DEFAULT_FG
    private var savedBg = TermColor.DEFAULT_BG
    private var savedFlags = 0

    // parser
    private enum class State { GROUND, ESC, CSI, OSC, CHARSET }
    private var state = State.GROUND
    private val csiParams = StringBuilder()
    private var csiPrivate = false

    // incremental UTF-8 decode
    private var u8need = 0
    private var u8cp = 0

    @Volatile private var dirty = true

    // ── public API ────────────────────────────────────────────────────────────

    fun feed(bytes: ByteArray, len: Int = bytes.size) {
        var i = 0
        while (i < len) {
            val b = bytes[i].toInt() and 0xFF
            i++
            val cp = decodeUtf8(b) ?: continue
            process(cp)
        }
        dirty = true
    }

    fun feed(text: String) = feed(text.toByteArray(Charsets.UTF_8))

    fun clear() {
        scrollback.clear()
        screen = newGrid(cols, rows)
        altScreen = null
        cx = 0; cy = 0; top = 0; bottom = rows - 1
        wrapPending = false
        curFg = TermColor.DEFAULT_FG; curBg = TermColor.DEFAULT_BG; curFlags = 0
        state = State.GROUND
        u8need = 0
        dirty = true
    }

    fun resize(newCols: Int, newRows: Int) {
        val nc = newCols.coerceIn(2, 400)
        val nr = newRows.coerceIn(1, 200)
        if (nc == cols && nr == rows) return
        val old = screen
        val ng = newGrid(nc, nr)
        for (r in 0 until minOf(rows, nr)) {
            for (c in 0 until minOf(cols, nc)) ng[r][c] = old[r][c]
        }
        screen = ng
        altScreen = null
        cols = nc; rows = nr
        top = 0; bottom = nr - 1
        cx = cx.coerceIn(0, nc - 1); cy = cy.coerceIn(0, nr - 1)
        wrapPending = false
        dirty = true
    }

    /** Snapshot the renderable content (scrollback + screen) as immutable lines. */
    fun frame(maxLines: Int = 800): TermFrame {
        dirty = false
        val sbList = scrollback.toList()
        val sbCount = sbList.size
        val total = sbCount + rows
        val from = maxOf(0, total - maxLines)
        val out = ArrayList<TermLine>(minOf(total, maxLines))
        for (idx in from until total) {
            if (idx < sbCount) out.add(sbList[idx]) else out.add(rowToLine(screen[idx - sbCount]))
        }
        val cursorLineAbs = sbCount + cy
        return TermFrame(
            lines = out,
            cols = cols,
            cursorLine = cursorLineAbs - from,
            cursorCol = cx.coerceIn(0, cols - 1),
            cursorVisible = cursorVisible,
        )
    }

    fun isDirty(): Boolean = dirty

    // ── UTF-8 ───────────────────────────────────────────────────────────────────

    private fun decodeUtf8(b: Int): Int? {
        if (u8need > 0) {
            if (b and 0xC0 == 0x80) {
                u8cp = (u8cp shl 6) or (b and 0x3F)
                u8need--
                return if (u8need == 0) u8cp else null
            } else {
                u8need = 0 // malformed; fall through to treat b as fresh
            }
        }
        return when {
            b < 0x80 -> b
            b and 0xE0 == 0xC0 -> { u8cp = b and 0x1F; u8need = 1; null }
            b and 0xF0 == 0xE0 -> { u8cp = b and 0x0F; u8need = 2; null }
            b and 0xF8 == 0xF0 -> { u8cp = b and 0x07; u8need = 3; null }
            else -> 0xFFFD // invalid lead byte → replacement
        }
    }

    // ── state machine ─────────────────────────────────────────────────────────

    private fun process(cp: Int) {
        when (state) {
            State.GROUND -> ground(cp)
            State.ESC -> esc(cp)
            State.CSI -> csi(cp)
            State.OSC -> osc(cp)
            State.CHARSET -> state = State.GROUND // consume the charset designator byte
        }
    }

    private fun ground(cp: Int) {
        when (cp) {
            0x1B -> state = State.ESC
            0x07 -> {} // BEL
            0x08 -> { cx = (cx - 1).coerceAtLeast(0); wrapPending = false } // BS
            0x09 -> tab()
            0x0A, 0x0B, 0x0C -> { lineFeed(); wrapPending = false } // LF/VT/FF
            0x0D -> { cx = 0; wrapPending = false } // CR
            0x0E, 0x0F -> {} // SO/SI charset shift — ignore
            else -> if (cp >= 0x20) putChar(cp)
        }
    }

    private fun esc(cp: Int) {
        when (cp.toChar()) {
            '[' -> { csiParams.setLength(0); csiPrivate = false; state = State.CSI }
            ']' -> state = State.OSC
            '(', ')', '*', '+', '-', '.', '/' -> state = State.CHARSET // designator byte consumed next
            '7' -> { saveCursor(); state = State.GROUND }
            '8' -> { restoreCursor(); state = State.GROUND }
            'D' -> { lineFeed(); state = State.GROUND } // IND
            'M' -> { reverseIndex(); state = State.GROUND } // RI
            'E' -> { cx = 0; lineFeed(); state = State.GROUND } // NEL
            'c' -> { clear(); state = State.GROUND } // RIS
            else -> state = State.GROUND // =, >, etc.
        }
    }

    private fun csi(cp: Int) {
        val ch = cp.toChar()
        when {
            ch == '?' || ch == '<' || ch == '=' || ch == '>' -> csiPrivate = csiPrivate || ch == '?'
            ch in '0'..'9' || ch == ';' || ch == ':' -> csiParams.append(ch)
            cp in 0x20..0x2F -> {} // intermediate bytes — ignore
            cp in 0x40..0x7E -> { dispatchCsi(ch); state = State.GROUND }
            else -> state = State.GROUND
        }
    }

    private fun osc(cp: Int) {
        // Terminated by BEL or ESC \ (ST). We ignore the payload (titles, hyperlinks…).
        if (cp == 0x07) { state = State.GROUND }
        else if (cp == 0x1B) { /* possible ST start */ state = State.GROUND } // simplistic: end on ESC
    }

    private fun params(): IntArray {
        if (csiParams.isEmpty()) return IntArray(0)
        return csiParams.split(';').map { it.substringBefore(':').toIntOrNull() ?: 0 }.toIntArray()
    }

    private fun p(idx: Int, default: Int, ps: IntArray): Int =
        ps.getOrNull(idx)?.takeIf { it != 0 } ?: default

    private fun dispatchCsi(ch: Char) {
        val ps = params()
        when (ch) {
            'A' -> { cy = (cy - p(0, 1, ps)).coerceAtLeast(top); wrapPending = false }
            'B', 'e' -> { cy = (cy + p(0, 1, ps)).coerceAtMost(bottom); wrapPending = false }
            'C', 'a' -> { cx = (cx + p(0, 1, ps)).coerceAtMost(cols - 1); wrapPending = false }
            'D' -> { cx = (cx - p(0, 1, ps)).coerceAtLeast(0); wrapPending = false }
            'E' -> { cy = (cy + p(0, 1, ps)).coerceAtMost(bottom); cx = 0; wrapPending = false }
            'F' -> { cy = (cy - p(0, 1, ps)).coerceAtLeast(top); cx = 0; wrapPending = false }
            'G', '`' -> { cx = (p(0, 1, ps) - 1).coerceIn(0, cols - 1); wrapPending = false }
            'd' -> { cy = (p(0, 1, ps) - 1).coerceIn(0, rows - 1); wrapPending = false }
            'H', 'f' -> {
                cy = (p(0, 1, ps) - 1).coerceIn(0, rows - 1)
                cx = (p(1, 1, ps) - 1).coerceIn(0, cols - 1)
                wrapPending = false
            }
            'J' -> eraseDisplay(ps.getOrElse(0) { 0 })
            'K' -> eraseLine(ps.getOrElse(0) { 0 })
            'm' -> sgr(ps)
            'r' -> { // DECSTBM scroll region
                top = (p(0, 1, ps) - 1).coerceIn(0, rows - 1)
                bottom = (p(1, rows, ps) - 1).coerceIn(top, rows - 1)
                cx = 0; cy = top; wrapPending = false
            }
            'L' -> insertLines(p(0, 1, ps))
            'M' -> deleteLines(p(0, 1, ps))
            'P' -> deleteChars(p(0, 1, ps))
            '@' -> insertChars(p(0, 1, ps))
            'X' -> eraseChars(p(0, 1, ps))
            'S' -> scrollUp(p(0, 1, ps))
            'T' -> scrollDown(p(0, 1, ps))
            's' -> saveCursor()
            'u' -> restoreCursor()
            'h' -> setMode(ps, true)
            'l' -> setMode(ps, false)
            else -> {}
        }
    }

    private fun setMode(ps: IntArray, on: Boolean) {
        if (!csiPrivate) return
        for (m in ps) when (m) {
            7 -> autowrap = on
            25 -> cursorVisible = on
            47, 1047 -> useAltScreen(on)
            1049 -> { if (on) saveCursor(); useAltScreen(on); if (!on) restoreCursor() }
            else -> {}
        }
    }

    // ── SGR ─────────────────────────────────────────────────────────────────────

    private fun sgr(ps: IntArray) {
        if (ps.isEmpty()) { resetSgr(); return }
        var i = 0
        while (i < ps.size) {
            when (val c = ps[i]) {
                0 -> resetSgr()
                1 -> curFlags = curFlags or BOLD
                2 -> curFlags = curFlags or DIM
                3 -> curFlags = curFlags or ITALIC
                4 -> curFlags = curFlags or UNDERLINE
                7 -> curFlags = curFlags or INVERSE
                22 -> curFlags = curFlags and (BOLD or DIM).inv()
                23 -> curFlags = curFlags and ITALIC.inv()
                24 -> curFlags = curFlags and UNDERLINE.inv()
                27 -> curFlags = curFlags and INVERSE.inv()
                in 30..37 -> curFg = c - 30
                in 40..47 -> curBg = c - 40
                in 90..97 -> curFg = c - 90 + 8
                in 100..107 -> curBg = c - 100 + 8
                39 -> curFg = TermColor.DEFAULT_FG
                49 -> curBg = TermColor.DEFAULT_BG
                38 -> i = extColor(ps, i, fg = true)
                48 -> i = extColor(ps, i, fg = false)
                else -> {}
            }
            i++
        }
    }

    private fun extColor(ps: IntArray, i: Int, fg: Boolean): Int {
        // 38;5;n  or  38;2;r;g;b
        return when (ps.getOrNull(i + 1)) {
            5 -> {
                val idx = ps.getOrNull(i + 2)?.coerceIn(0, 255) ?: 0
                if (fg) curFg = idx else curBg = idx
                i + 2
            }
            2 -> {
                val r = ps.getOrNull(i + 2) ?: 0
                val g = ps.getOrNull(i + 3) ?: 0
                val b = ps.getOrNull(i + 4) ?: 0
                val tc = TermColor.truecolor(r, g, b)
                if (fg) curFg = tc else curBg = tc
                i + 4
            }
            else -> i
        }
    }

    private fun resetSgr() {
        curFg = TermColor.DEFAULT_FG; curBg = TermColor.DEFAULT_BG; curFlags = 0
    }

    // ── grid ops ─────────────────────────────────────────────────────────────────

    private fun putChar(cp: Int) {
        if (wrapPending && autowrap) {
            cx = 0
            lineFeed()
            wrapPending = false
        }
        val cell = screen[cy][cx]
        cell.code = cp
        cell.fg = curFg
        cell.bg = curBg
        cell.flags = curFlags
        if (cx >= cols - 1) wrapPending = true else cx++
    }

    private fun tab() {
        cx = ((cx / 8) + 1) * 8
        if (cx > cols - 1) cx = cols - 1
        wrapPending = false
    }

    private fun lineFeed() {
        if (cy == bottom) scrollUp(1) else cy = (cy + 1).coerceAtMost(rows - 1)
    }

    private fun reverseIndex() {
        if (cy == top) scrollDown(1) else cy = (cy - 1).coerceAtLeast(0)
    }

    private fun scrollUp(n: Int) {
        repeat(n.coerceAtMost(rows)) {
            // Only the full-screen scroll region feeds scrollback (matches xterm).
            if (top == 0) pushScrollback(screen[top])
            for (r in top until bottom) screen[r] = screen[r + 1]
            screen[bottom] = blankRow()
        }
    }

    private fun scrollDown(n: Int) {
        repeat(n.coerceAtMost(rows)) {
            for (r in bottom downTo top + 1) screen[r] = screen[r - 1]
            screen[top] = blankRow()
        }
    }

    private fun insertLines(n: Int) {
        if (cy < top || cy > bottom) return
        repeat(n.coerceAtMost(bottom - cy + 1)) {
            for (r in bottom downTo cy + 1) screen[r] = screen[r - 1]
            screen[cy] = blankRow()
        }
    }

    private fun deleteLines(n: Int) {
        if (cy < top || cy > bottom) return
        repeat(n.coerceAtMost(bottom - cy + 1)) {
            for (r in cy until bottom) screen[r] = screen[r + 1]
            screen[bottom] = blankRow()
        }
    }

    private fun insertChars(n: Int) {
        val row = screen[cy]
        val count = n.coerceAtMost(cols - cx)
        for (c in cols - 1 downTo cx + count) row[c] = row[c - count]
        for (c in cx until cx + count) row[c] = blankCell()
    }

    private fun deleteChars(n: Int) {
        val row = screen[cy]
        val count = n.coerceAtMost(cols - cx)
        for (c in cx until cols - count) row[c] = row[c + count]
        for (c in cols - count until cols) row[c] = blankCell()
    }

    private fun eraseChars(n: Int) {
        val row = screen[cy]
        for (c in cx until minOf(cx + n, cols)) blank(row[c])
    }

    private fun eraseDisplay(mode: Int) {
        when (mode) {
            0 -> { for (c in cx until cols) blank(screen[cy][c]); for (r in cy + 1 until rows) blankRowInPlace(r) }
            1 -> { for (r in 0 until cy) blankRowInPlace(r); for (c in 0..cx.coerceAtMost(cols - 1)) blank(screen[cy][c]) }
            2 -> for (r in 0 until rows) blankRowInPlace(r)
            3 -> { scrollback.clear(); for (r in 0 until rows) blankRowInPlace(r) }
        }
        wrapPending = false
    }

    private fun eraseLine(mode: Int) {
        val row = screen[cy]
        when (mode) {
            0 -> for (c in cx until cols) blank(row[c])
            1 -> for (c in 0..cx.coerceAtMost(cols - 1)) blank(row[c])
            2 -> for (c in 0 until cols) blank(row[c])
        }
        wrapPending = false
    }

    private fun saveCursor() { savedCx = cx; savedCy = cy; savedFg = curFg; savedBg = curBg; savedFlags = curFlags }
    private fun restoreCursor() {
        cx = savedCx.coerceIn(0, cols - 1); cy = savedCy.coerceIn(0, rows - 1)
        curFg = savedFg; curBg = savedBg; curFlags = savedFlags; wrapPending = false
    }

    private fun useAltScreen(on: Boolean) {
        if (on) {
            if (altScreen == null) {
                altScreen = screen
                screen = newGrid(cols, rows)
                cx = 0; cy = 0; wrapPending = false
            }
        } else {
            altScreen?.let { screen = it; altScreen = null }
        }
    }

    // ── helpers ──────────────────────────────────────────────────────────────────

    private fun pushScrollback(row: Array<Cell>) {
        scrollback.addLast(rowToLine(row))
        while (scrollback.size > maxScrollback) scrollback.removeFirst()
    }

    private fun rowToLine(row: Array<Cell>): TermLine {
        val n = row.size
        val codes = IntArray(n); val fg = IntArray(n); val bg = IntArray(n); val fl = IntArray(n)
        for (c in 0 until n) {
            codes[c] = row[c].code; fg[c] = row[c].fg; bg[c] = row[c].bg; fl[c] = row[c].flags
        }
        return TermLine(codes, fg, bg, fl)
    }

    private fun blankCell() = Cell(SP, TermColor.DEFAULT_FG, curBg, 0)
    private fun blank(cell: Cell) { cell.code = SP; cell.fg = TermColor.DEFAULT_FG; cell.bg = curBg; cell.flags = 0 }
    private fun blankRow() = Array(cols) { blankCell() }
    private fun blankRowInPlace(r: Int) { val row = screen[r]; for (c in 0 until cols) blank(row[c]) }

    private fun newGrid(c: Int, r: Int) = Array(r) { Array(c) { Cell() } }

    companion object {
        private const val SP = 32
        const val BOLD = 1
        const val DIM = 2
        const val UNDERLINE = 4
        const val INVERSE = 8
        const val ITALIC = 16
    }
}
