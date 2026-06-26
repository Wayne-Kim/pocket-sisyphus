package com.pocketsisyphus.android.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * Lightweight markdown renderer for agent-generated body text (brief problem/scope/spec, research
 * reports) — mirrors iOS `MarkdownText`. Block structure (headings, lists, task boxes, code fences)
 * is laid out directly; inline `**bold**` / `*italic*` / `` `code` `` is parsed into an
 * AnnotatedString. Anything it can't classify falls back to plain text (never crashes, never hides
 * the source). This is for **content**, not translatable UI strings.
 */
@Composable
fun MarkdownText(
    raw: String,
    modifier: Modifier = Modifier,
    baseStyle: TextStyle = MaterialTheme.typography.bodyMedium,
) {
    val blocks = remember(raw) { markdownBlocks(raw) }
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    val codeBg = MaterialTheme.colorScheme.surfaceVariant

    Column(modifier = modifier, verticalArrangement = androidx.compose.foundation.layout.Arrangement.spacedBy(6.dp)) {
        if (blocks.isEmpty()) {
            if (raw.isNotBlank()) Text(raw, style = baseStyle)
            return@Column
        }
        blocks.forEach { block ->
            when (block) {
                is MdBlock.Heading -> Text(
                    inline(block.text, codeBg),
                    style = if (block.level <= 2) MaterialTheme.typography.titleSmall
                    else baseStyle,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier.padding(top = 2.dp),
                )
                is MdBlock.Paragraph -> Text(inline(block.text, codeBg), style = baseStyle)
                is MdBlock.Bullet -> Row(modifier = Modifier.padding(start = (block.indent * 14).dp)) {
                    Text("•  ", style = baseStyle, color = muted)
                    Text(inline(block.text, codeBg), style = baseStyle)
                }
                is MdBlock.Ordered -> Row {
                    Text("${block.marker}  ", style = baseStyle, color = muted)
                    Text(inline(block.text, codeBg), style = baseStyle)
                }
                is MdBlock.Task -> Row {
                    Text(if (block.checked) "☑  " else "☐  ", style = baseStyle, color = muted)
                    Text(inline(block.text, codeBg), style = baseStyle)
                }
                is MdBlock.Code -> Text(
                    block.code,
                    style = baseStyle.copy(fontFamily = FontFamily.Monospace, fontSize = 13.sp),
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(8.dp))
                        .background(codeBg)
                        .horizontalScroll(rememberScrollState())
                        .padding(PaddingValues(horizontal = 12.dp, vertical = 10.dp)),
                )
            }
        }
    }
}

private sealed interface MdBlock {
    data class Heading(val level: Int, val text: String) : MdBlock
    data class Paragraph(val text: String) : MdBlock
    data class Bullet(val indent: Int, val text: String) : MdBlock
    data class Ordered(val marker: String, val text: String) : MdBlock
    data class Task(val checked: Boolean, val text: String) : MdBlock
    data class Code(val code: String) : MdBlock
}

private val ORDERED = Regex("""^(\d+)[.)]\s+(.*)""")
private val HEADING = Regex("""^(#{1,6})\s+(.*)""")

private fun markdownBlocks(raw: String): List<MdBlock> {
    val blocks = mutableListOf<MdBlock>()
    val codeLines = mutableListOf<String>()
    var inCode = false
    for (line in raw.split('\n')) {
        val trimmed = line.trim()
        if (trimmed.startsWith("```")) {
            if (inCode) { blocks.add(MdBlock.Code(codeLines.joinToString("\n"))); codeLines.clear() }
            inCode = !inCode
            continue
        }
        if (inCode) { codeLines.add(line); continue }
        if (trimmed.isEmpty()) continue

        val heading = HEADING.matchEntire(trimmed)
        if (heading != null) {
            blocks.add(MdBlock.Heading(heading.groupValues[1].length, heading.groupValues[2].trim()))
            continue
        }

        val task = parseTask(trimmed)
        if (task != null) { blocks.add(task); continue }

        val bullet = parseBullet(line)
        if (bullet != null) { blocks.add(bullet); continue }

        val ordered = ORDERED.matchEntire(trimmed)
        if (ordered != null) {
            blocks.add(MdBlock.Ordered("${ordered.groupValues[1]}.", ordered.groupValues[2].trim()))
            continue
        }

        blocks.add(MdBlock.Paragraph(trimmed))
    }
    if (inCode && codeLines.isNotEmpty()) blocks.add(MdBlock.Code(codeLines.joinToString("\n")))
    return blocks
}

private fun parseTask(s: String): MdBlock.Task? {
    for (m in listOf("- ", "* ", "+ ")) {
        if (!s.startsWith(m)) continue
        val rest = s.substring(m.length)
        if (rest.startsWith("[ ]")) return MdBlock.Task(false, rest.substring(3).trim())
        if (rest.startsWith("[x]") || rest.startsWith("[X]")) return MdBlock.Task(true, rest.substring(3).trim())
    }
    return null
}

private fun parseBullet(line: String): MdBlock.Bullet? {
    val leading = line.takeWhile { it == ' ' }.length
    val s = line.trim()
    for (m in listOf("- ", "* ", "+ ")) {
        if (s.startsWith(m)) return MdBlock.Bullet(minOf(leading / 2, 3), s.substring(m.length))
    }
    return null
}

/** Inline parse: `**bold**`, `*italic*`/`_italic_`, `` `code` ``. Unmatched markers stay literal. */
private fun inline(text: String, codeBg: androidx.compose.ui.graphics.Color): AnnotatedString =
    buildAnnotatedString {
        var i = 0
        while (i < text.length) {
            val c = text[i]
            when {
                c == '`' -> {
                    val end = text.indexOf('`', i + 1)
                    if (end > i) {
                        withStyle(SpanStyle(fontFamily = FontFamily.Monospace, background = codeBg)) {
                            append(text.substring(i + 1, end))
                        }
                        i = end + 1
                    } else { append(c); i++ }
                }
                c == '*' && i + 1 < text.length && text[i + 1] == '*' -> {
                    val end = text.indexOf("**", i + 2)
                    if (end > i) {
                        withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(text.substring(i + 2, end)) }
                        i = end + 2
                    } else { append(c); i++ }
                }
                (c == '*' || c == '_') -> {
                    val end = text.indexOf(c, i + 1)
                    if (end > i + 1) {
                        withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { append(text.substring(i + 1, end)) }
                        i = end + 1
                    } else { append(c); i++ }
                }
                else -> { append(c); i++ }
            }
        }
    }
